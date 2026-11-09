/**
 * 批量 Take 生成（设计 7.6）：筛选、并发 1–4、失败不中断、可取消、结束汇总。
 *
 * 任务只存内存；前端轮询 getTakeBatch。已完成 Take 持久化在 line_takes，
 * 进程重启后不会丢生成结果。
 */
import crypto from 'crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import type { AudioConfig } from './tts.js'
import {
  generateTake,
  type GenerateTakeInput,
  type GenerateTakeResult,
  type LineRow,
} from './line-takes.js'
import type { ContextMode } from './line-context.js'
import { failAiTaskRun, finishAiTaskRun, patchAiTaskRun, startAiTaskRun } from './ai-task-runs.js'

export type TakeBatchFilter = 'pending' | 'failed' | 'audio_stale' | 'all'

export interface TakeBatchInput {
  lineIds?: number[] | null
  filter?: TakeBatchFilter
  contextMode?: ContextMode
  concurrency?: number
}

export interface TakeBatchJob {
  id: string
  episodeId: number
  status: 'running' | 'done' | 'failed' | 'cancelled'
  total: number
  done: number
  ok: number
  failed: number
  skipped: number
  currentLineId: number | null
  errors: { lineId: number; message: string }[]
  cancelRequested: boolean
  startedAt: string
  finishedAt: string | null
  /** sys_task 运行记录 id；批量 Take 在任务中心可见 */
  runTaskId?: number | null
}

export interface TakeBatchDeps {
  generate?: (input: GenerateTakeInput, deps?: { config?: AudioConfig | null }) => Promise<GenerateTakeResult | { cached: boolean }>
  config?: AudioConfig | null
}

const jobs = new Map<string, TakeBatchJob>()
const KEEP_MS = 60 * 60 * 1000
const MAX_ERRORS = 100

function cleanup() {
  const cutoff = Date.now() - KEEP_MS
  for (const [id, job] of jobs) {
    if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) jobs.delete(id)
  }
}

function clampConcurrency(value: unknown): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return 2
  return Math.max(1, Math.min(4, Math.round(number)))
}

function selectLines(episodeId: number, input: TakeBatchInput): LineRow[] {
  const rows = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .orderBy(
      asc(schema.storyboardLines.storyboardId),
      asc(schema.storyboardLines.sortOrder),
      asc(schema.storyboardLines.lineNo),
      asc(schema.storyboardLines.id),
    )
    .all()

  const lineIds = Array.isArray(input.lineIds)
    ? new Set(input.lineIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))
    : null
  const filter = input.filter || 'pending'

  return rows.filter((row) => {
    if (lineIds && !lineIds.has(row.id)) return false
    if (filter === 'failed') return row.status === 'failed'
    if (filter === 'audio_stale') return Boolean(row.audioStale)
    if (filter === 'all') return true
    return row.status !== 'ready' || !row.audioUrl
  })
}

function finish(job: TakeBatchJob, status: TakeBatchJob['status']) {
  job.currentLineId = null
  job.status = status
  job.finishedAt = now()
  const params = {
    job_id: job.id,
    total: job.total,
    done: job.done,
    ok: job.ok,
    failed: job.failed,
    skipped: job.skipped,
  }
  if (status === 'done') finishAiTaskRun(job.runTaskId, params)
  else if (status === 'cancelled') failAiTaskRun(job.runTaskId, '已停止', params)
  else failAiTaskRun(job.runTaskId, job.errors[0]?.message || '批量生成失败', params)
}

export function getTakeBatch(jobId: string): TakeBatchJob | null {
  cleanup()
  return jobs.get(jobId) ?? null
}

export function cancelTakeBatch(jobId: string): boolean {
  const job = jobs.get(jobId)
  if (!job || job.status !== 'running') return false
  job.cancelRequested = true
  return true
}

export function startTakeBatch(
  episodeId: number,
  input: TakeBatchInput = {},
  deps: TakeBatchDeps = {},
): TakeBatchJob {
  cleanup()
  const job: TakeBatchJob = {
    id: crypto.randomUUID(),
    episodeId,
    status: 'running',
    total: 0,
    done: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    currentLineId: null,
    errors: [],
    cancelRequested: false,
    startedAt: now(),
    finishedAt: null,
  }
  jobs.set(job.id, job)
  job.runTaskId = startAiTaskRun({
    type: 'audio',
    stage: 'take_batch',
    episodeId,
    params: { job_id: job.id, total: 0, done: 0, ok: 0, failed: 0, skipped: 0 },
  })
  void runTakeBatch(job, episodeId, input, deps)
  return job
}

export async function runTakeBatch(
  job: TakeBatchJob,
  episodeId: number,
  input: TakeBatchInput = {},
  deps: TakeBatchDeps = {},
): Promise<void> {
  try {
    const lines = selectLines(episodeId, input)
    job.total = lines.length
    const progress = () => ({
      job_id: job.id,
      total: job.total,
      done: job.done,
      ok: job.ok,
      failed: job.failed,
      skipped: job.skipped,
    })
    patchAiTaskRun(job.runTaskId, { params: progress() })
    if (!lines.length) {
      finish(job, 'done')
      return
    }

    const generate = deps.generate ?? generateTake
    const concurrency = clampConcurrency(input.concurrency)
    const contextMode = input.contextMode === 'off' || input.contextMode === 'deep'
      ? input.contextMode
      : 'light'
    let cursor = 0

    const worker = async () => {
      for (;;) {
        if (job.cancelRequested) return
        const index = cursor
        cursor += 1
        if (index >= lines.length) return
        if (job.cancelRequested) return

        const line = lines[index]
        job.currentLineId = line.id

        const text = (line.speakText || line.text || '').trim()
        if (!text) {
          job.skipped += 1
          job.done += 1
          patchAiTaskRun(job.runTaskId, { params: progress() })
          continue
        }

        try {
          // 批量不缓存：每条台词都真实合成（reuse: false 不走渲染哈希复用）
          const result = await generate({
            lineId: line.id,
            contextMode,
            reuse: false,
          }, { config: deps.config })
          job.ok += 1
        } catch (error: any) {
          job.failed += 1
          if (job.errors.length < MAX_ERRORS) {
            job.errors.push({
              lineId: line.id,
              message: String(error?.message || error).slice(0, 500),
            })
          }
        }
        job.done += 1
        patchAiTaskRun(job.runTaskId, { params: progress() })
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()))
    finish(job, job.cancelRequested && job.done < job.total ? 'cancelled' : 'done')
  } catch (error: any) {
    if (job.errors.length < MAX_ERRORS) {
      job.errors.push({ lineId: 0, message: String(error?.message || error).slice(0, 500) })
    }
    finish(job, 'failed')
  }
}
