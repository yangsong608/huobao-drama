/**
 * 队列 worker（V2 · M5-2）
 *
 * 每 2 秒领一条任务，按 queue.maxConcurrent 限流；任务执行期间每 3 秒心跳。
 * 目前接管两类：automation（整集流水线）与 dub（整集配音）。
 * 队列关闭时 worker 空转，不改变 V1 行为。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getQueueConcurrency, isQueueEnabled } from './app-settings.js'
import { claimNextJob, completeJob, failJob, heartbeat, markOrphanedJobs, updateJobProgress } from './job-queue.js'
import { isAutomationRunning, startAutomation } from './automation.js'
import { getDubbingState, startDubbing } from './dubbing.js'
import { logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'
import { emitChange } from './sync-events.js'

const POLL_MS = 3000
const JOB_TIMEOUT_MS = 3 * 60 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null
let active = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function startQueueWorker(): void {
  if (timer) return
  const recovered = markOrphanedJobs()
  if (recovered) console.log(`[queue] 已把 ${recovered} 个中断任务重新排队`)
  timer = setInterval(() => { void tick() }, 2000)
  void tick()
  console.log('[queue] worker started')
}

export function stopQueueWorker(): void {
  if (timer) clearInterval(timer)
  timer = null
}

async function tick(): Promise<void> {
  if (!isQueueEnabled()) return
  const limit = getQueueConcurrency()
  if (active >= limit) return
  const job = claimNextJob(['episode'])
  if (!job) return
  active += 1
  try {
    await runJob(job)
  } finally {
    active -= 1
  }
}

async function runJob(job: typeof schema.pipelineJobs.$inferSelect): Promise<void> {
  const payload = (() => {
    try { return JSON.parse(job.payload || '{}') } catch { return {} }
  })()
  const startedAt = Date.now()
  try {
    if (job.kind === 'automation') {
      if (!job.episodeId) throw new Error('任务缺少 episode_id')
      const ok = await startAutomation(job.episodeId, {
        model: payload.model,
        configId: payload.configId,
        fromQueue: true,
      })
      if (!ok && !isAutomationRunning(job.episodeId)) {
        completeJob(job.id)
        return
      }
      await waitUntil(
        () => !isAutomationRunning(job.episodeId!),
        job.id,
        startedAt,
        () => {
          const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, job.episodeId!)).get()
          return ep?.automationProgress || 0
        },
      )
      const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, job.episodeId)).get()
      if (ep?.automationStatus === 'failed') throw new Error(ep.automationError || '自动化失败')
      completeJob(job.id)
      logTaskSuccess('Queue', 'automation', { jobId: job.id, episodeId: job.episodeId })
      return
    }

    if (job.kind === 'dub') {
      if (!job.episodeId) throw new Error('任务缺少 episode_id')
      startDubbing(job.episodeId, {
        subtitleMode: payload.subtitleMode,
        originalAudio: payload.originalAudio,
        bgmUrl: payload.bgmUrl,
        force: Boolean(payload.force),
      })
      emitChange({ method: 'POST', path: `/api/v1/episodes/${job.episodeId}/dub`, source: 'queue' })
      await waitUntil(
        () => ['done', 'failed', 'stopped', 'idle'].includes(getDubbingState(job.episodeId!).status),
        job.id,
        startedAt,
        () => getDubbingState(job.episodeId!).progress,
      )
      const state = getDubbingState(job.episodeId!)
      if (state.status === 'failed') throw new Error(state.error || '配音失败')
      completeJob(job.id)
      logTaskSuccess('Queue', 'dub', { jobId: job.id, episodeId: job.episodeId })
      return
    }

    throw new Error(`未知任务类型：${job.kind}`)
  } catch (error: any) {
    const message = String(error?.message || error)
    const next = failJob(job.id, message)
    logTaskError('Queue', job.kind, { jobId: job.id, error: message, next })
    if (next === 'queued') {
      // 简单退避：把任务推到队尾之后（靠 id 顺序天然排到后面）
      await sleep(1000)
    }
  }
}

async function waitUntil(done: () => boolean, jobId: number, startedAt: number, progress: () => number): Promise<void> {
  while (!done()) {
    if (Date.now() - startedAt > JOB_TIMEOUT_MS) throw new Error('任务超时（3 小时）')
    heartbeat(jobId)
    updateJobProgress(jobId, progress())
    await sleep(POLL_MS)
  }
  void logTaskProgress
}
