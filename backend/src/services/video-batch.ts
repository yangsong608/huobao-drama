/**
 * 批量视频任务：后端持久化调度。
 * - 一集同时只保留一个 running 批次；并发 1-5，默认 1
 * - 每次 tick 先结算已提交任务，再按空槽补发；不自动重试失败项
 * - 停止只拦后续排队项，已提交任务继续跑完
 * - 重启后接管已有 sys_task，未提交项回队，避免重复计费
 */
import type { Hono } from 'hono'
import { withInternalAppToken } from '../middleware/app-token.js'
import { and, eq, inArray } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { logTaskError, logTaskProgress, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'

export const VIDEO_BATCH_MAX_CONCURRENCY = 5

type BatchItemStatus = 'queued' | 'submitting' | 'processing' | 'completed' | 'failed' | 'stopped'

export interface VideoBatchInputItem {
  storyboard_id: number
  request?: Record<string, unknown>
}

export interface VideoBatchView {
  id: number
  episode_id: number
  drama_id: number | null
  status: string
  concurrency: number
  stop_requested: boolean
  total: number
  completed: number
  failed: number
  stopped: number
  processing: number
  queued: number
  created_at: string
  updated_at: string
  finished_at: string | null
  items: Array<{
    id: number
    storyboard_id: number
    position: number
    status: BatchItemStatus
    task_id: number | null
    error: string | null
    updated_at: string
  }>
}

export interface VideoBatchDispatchItem {
  storyboardId: number
  request: Record<string, unknown>
}

type VideoBatchDispatcher = (
  item: VideoBatchDispatchItem,
  batch: { id: number; episodeId: number; dramaId: number | null },
) => Promise<number>

const TERMINAL: BatchItemStatus[] = ['completed', 'failed', 'stopped']
const ACTIVE: BatchItemStatus[] = ['submitting', 'processing']

let internalApp: Hono | null = null
/** 由 index.ts 注入主应用，批处理通过内部 POST /api/v1/tasks 复用完整校验与任务创建 */
export function setVideoBatchApp(app: Hono) {
  internalApp = app
}

async function internalDispatcher(
  item: VideoBatchDispatchItem,
  _batch: { id: number; episodeId: number; dramaId: number | null },
): Promise<number> {
  if (!internalApp) throw new Error('服务尚未就绪，请稍后重试')
  const res = await internalApp.fetch(new Request(new URL('/api/v1/tasks', 'http://internal').toString(), withInternalAppToken({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 请求体里的同名字段不可覆盖 type/storyboard_id，避免批次串镜
    body: JSON.stringify({ ...item.request, type: 'video', storyboard_id: item.storyboardId }),
  })))
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!res.ok || (json && typeof json.code === 'number' && json.code >= 400)) {
    throw new Error(json?.message || `HTTP ${res.status}`)
  }
  const taskId = Number(json?.data?.id)
  if (!Number.isInteger(taskId) || taskId <= 0) throw new Error('创建生成任务失败：返回缺少任务 ID')
  return taskId
}

let dispatcher: VideoBatchDispatcher = internalDispatcher
/** 测试注入点；生产使用内部 HTTP 派发 */
export function setVideoBatchDispatcher(fn: VideoBatchDispatcher) {
  dispatcher = fn
}

function normalizeConcurrency(raw: unknown): number {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(VIDEO_BATCH_MAX_CONCURRENCY, n)
}

function parseRequest(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function loadItems(batchId: number) {
  return db.select().from(schema.videoBatchItems)
    .where(eq(schema.videoBatchItems.batchId, batchId))
    .orderBy(schema.videoBatchItems.position)
}

function countsOf(items: Array<{ status: string | null }>) {
  const count = (status: string) => items.filter(i => i.status === status).length
  return {
    total: items.length,
    completed: count('completed'),
    failed: count('failed'),
    stopped: count('stopped'),
    processing: count('processing') + count('submitting'),
    queued: count('queued'),
  }
}

export async function startVideoBatch(input: {
  episodeId: number
  dramaId?: number | null
  concurrency?: number
  items: VideoBatchInputItem[]
}): Promise<{ batchId: number; created: boolean; concurrency: number; total: number }> {
  const episodeId = Number(input.episodeId)
  if (!Number.isInteger(episodeId) || episodeId <= 0) throw new Error('剧集 ID 无效')

  const seen = new Set<number>()
  const items = (input.items || []).flatMap(raw => {
    const storyboardId = Number(raw?.storyboard_id)
    if (!Number.isInteger(storyboardId) || storyboardId <= 0 || seen.has(storyboardId)) return []
    seen.add(storyboardId)
    const request = raw?.request && typeof raw.request === 'object' && !Array.isArray(raw.request)
      ? raw.request as Record<string, unknown>
      : {}
    return [{ storyboardId, request }]
  })
  if (!items.length) throw new Error('请选择要生成的分镜')

  const concurrency = normalizeConcurrency(input.concurrency)
  const ts = new Date().toISOString()

  const result = db.transaction((tx) => {
    const existing = tx.select().from(schema.videoBatchJobs)
      .where(and(eq(schema.videoBatchJobs.episodeId, episodeId), eq(schema.videoBatchJobs.status, 'running')))
      .orderBy(schema.videoBatchJobs.id)
      .all()
      .pop()
    if (existing) {
      const total = tx.select().from(schema.videoBatchItems)
        .where(eq(schema.videoBatchItems.batchId, existing.id))
        .all().length
      return { batchId: existing.id, created: false, concurrency: existing.concurrency || 1, total }
    }

    const inserted = tx.insert(schema.videoBatchJobs).values({
      episodeId,
      dramaId: input.dramaId ?? null,
      status: 'running',
      concurrency,
      stopRequested: false,
      createdAt: ts,
      updatedAt: ts,
    }).run()
    const batchId = getInsertId(inserted)
    items.forEach((item, index) => {
      tx.insert(schema.videoBatchItems).values({
        batchId,
        storyboardId: item.storyboardId,
        position: index,
        status: 'queued',
        requestJson: JSON.stringify(item.request),
        createdAt: ts,
        updatedAt: ts,
      }).run()
    })
    return { batchId, created: true, concurrency, total: items.length }
  })

  logTaskSuccess('VideoBatch', 'start', { episodeId, batchId: result.batchId, created: result.created, concurrency: result.concurrency, total: result.total })
  return result
}

export async function getVideoBatch(episodeId: number): Promise<VideoBatchView | null> {
  const jobs = await db.select().from(schema.videoBatchJobs)
    .where(eq(schema.videoBatchJobs.episodeId, episodeId))
    .orderBy(schema.videoBatchJobs.id)
  const latest = jobs[jobs.length - 1]
  if (!latest) return null
  const items = await loadItems(latest.id)
  const counts = countsOf(items)
  return {
    id: latest.id,
    episode_id: latest.episodeId,
    drama_id: latest.dramaId ?? null,
    status: latest.status || 'running',
    concurrency: latest.concurrency || 1,
    stop_requested: !!latest.stopRequested,
    ...counts,
    created_at: latest.createdAt,
    updated_at: latest.updatedAt,
    finished_at: latest.finishedAt ?? null,
    items: items.map(item => ({
      id: item.id,
      storyboard_id: item.storyboardId,
      position: item.position,
      status: (item.status || 'queued') as BatchItemStatus,
      task_id: item.taskId ?? null,
      error: item.error ?? null,
      updated_at: item.updatedAt,
    })),
  }
}

export async function stopVideoBatch(episodeId: number): Promise<{ stopped: boolean; batchId: number | null }> {
  const ts = new Date().toISOString()
  const result = db.transaction((tx) => {
    const existing = tx.select().from(schema.videoBatchJobs)
      .where(and(eq(schema.videoBatchJobs.episodeId, episodeId), eq(schema.videoBatchJobs.status, 'running')))
      .orderBy(schema.videoBatchJobs.id)
      .all()
      .pop()
    if (!existing) return { stopped: false, batchId: null as number | null }
    tx.update(schema.videoBatchItems)
      .set({ status: 'stopped', updatedAt: ts })
      .where(and(eq(schema.videoBatchItems.batchId, existing.id), eq(schema.videoBatchItems.status, 'queued')))
      .run()
    tx.update(schema.videoBatchJobs)
      .set({ status: 'stopped', stopRequested: true, finishedAt: ts, updatedAt: ts })
      .where(eq(schema.videoBatchJobs.id, existing.id))
      .run()
    return { stopped: true, batchId: existing.id }
  })
  if (result.stopped) logTaskWarn('VideoBatch', 'stop', { episodeId, batchId: result.batchId })
  return result
}

/** 把已提交的 sys_task 终态写回批次项；返回最新项状态 */
async function reconcileJob(job: typeof schema.videoBatchJobs.$inferSelect) {
  const ts = new Date().toISOString()
  const items = await loadItems(job.id)
  for (const item of items) {
    if (!ACTIVE.includes((item.status || 'queued') as BatchItemStatus)) continue
    if (item.taskId == null) continue
    const [task] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, item.taskId))
    if (!task) {
      await db.update(schema.videoBatchItems)
        .set({ status: 'failed', error: '生成任务记录不存在', updatedAt: ts })
        .where(eq(schema.videoBatchItems.id, item.id))
    } else if (task.status === 'completed') {
      await db.update(schema.videoBatchItems)
        .set({ status: 'completed', error: null, updatedAt: ts })
        .where(eq(schema.videoBatchItems.id, item.id))
    } else if (task.status === 'failed') {
      await db.update(schema.videoBatchItems)
        .set({ status: 'failed', error: task.errorMsg || '生成失败', updatedAt: ts })
        .where(eq(schema.videoBatchItems.id, item.id))
    }
  }

  let fresh = await loadItems(job.id)
  if (job.stopRequested) {
    await db.update(schema.videoBatchItems)
      .set({ status: 'stopped', updatedAt: ts })
      .where(and(eq(schema.videoBatchItems.batchId, job.id), eq(schema.videoBatchItems.status, 'queued')))
    fresh = await loadItems(job.id)
  }

  const active = fresh.some(i => ACTIVE.includes((i.status || 'queued') as BatchItemStatus))
  const queued = fresh.some(i => (i.status || 'queued') === 'queued')
  if (job.status === 'running' && !active && !queued) {
    await db.update(schema.videoBatchJobs)
      .set({ status: job.stopRequested ? 'stopped' : 'done', finishedAt: ts, updatedAt: ts })
      .where(eq(schema.videoBatchJobs.id, job.id))
    logTaskSuccess('VideoBatch', 'finish', { batchId: job.id, episodeId: job.episodeId })
  }
  return fresh
}

async function dispatchQueued(job: typeof schema.videoBatchJobs.$inferSelect) {
  const items = await loadItems(job.id)
  const activeCount = items.filter(i => ACTIVE.includes((i.status || 'queued') as BatchItemStatus)).length
  const slots = Math.max(0, (job.concurrency || 1) - activeCount)
  if (!slots) return
  const queued = items.filter(i => (i.status || 'queued') === 'queued')
  if (!queued.length) return

  for (const item of queued.slice(0, slots)) {
    const [freshJob] = await db.select().from(schema.videoBatchJobs).where(eq(schema.videoBatchJobs.id, job.id))
    if (!freshJob || freshJob.status !== 'running' || freshJob.stopRequested) return

    const ts = new Date().toISOString()
    const claimed = db.update(schema.videoBatchItems)
      .set({ status: 'submitting', error: null, updatedAt: ts })
      .where(and(eq(schema.videoBatchItems.id, item.id), eq(schema.videoBatchItems.status, 'queued')))
      .run()
    if (!claimed.changes) continue

    logTaskProgress('VideoBatch', 'dispatch', { batchId: job.id, storyboardId: item.storyboardId, position: item.position })
    try {
      const taskId = await dispatcher(
        { storyboardId: item.storyboardId, request: parseRequest(item.requestJson) },
        { id: job.id, episodeId: job.episodeId, dramaId: job.dramaId ?? null },
      )
      db.update(schema.videoBatchItems)
        .set({ status: 'processing', taskId, updatedAt: new Date().toISOString() })
        .where(eq(schema.videoBatchItems.id, item.id))
        .run()
    } catch (err: any) {
      const message = err?.message || '发起生成失败'
      db.update(schema.videoBatchItems)
        .set({ status: 'failed', error: message, updatedAt: new Date().toISOString() })
        .where(eq(schema.videoBatchItems.id, item.id))
        .run()
      logTaskError('VideoBatch', 'dispatch', { batchId: job.id, storyboardId: item.storyboardId, error: message })
    }
  }

  // 最后一项也可能在这一轮里终态，顺手结算批次
  const [latestJob] = await db.select().from(schema.videoBatchJobs).where(eq(schema.videoBatchJobs.id, job.id))
  if (latestJob) await reconcileJob(latestJob)
}

/** 调度一拍：结算进行中的批次，再为 running 批次补发排队项 */
export async function runVideoBatchTick(): Promise<void> {
  const running = await db.select().from(schema.videoBatchJobs)
    .where(eq(schema.videoBatchJobs.status, 'running'))
    .orderBy(schema.videoBatchJobs.id)
  for (const job of running) {
    const [fresh] = await db.select().from(schema.videoBatchJobs).where(eq(schema.videoBatchJobs.id, job.id))
    if (!fresh || fresh.status !== 'running') continue
    await reconcileJob(fresh)
    const [afterReconcile] = await db.select().from(schema.videoBatchJobs).where(eq(schema.videoBatchJobs.id, job.id))
    if (!afterReconcile || afterReconcile.status !== 'running') continue
    await dispatchQueued(afterReconcile)
  }

  // 已停止批次里的在途任务仍需结算（下载、写回在生成服务内完成）
  const stopped = await db.select().from(schema.videoBatchJobs)
    .where(eq(schema.videoBatchJobs.status, 'stopped'))
  for (const job of stopped) {
    const items = await loadItems(job.id)
    if (!items.some(i => ACTIVE.includes((i.status || 'queued') as BatchItemStatus))) continue
    await reconcileJob(job)
  }
}

/** 启动恢复：接管已创建的任务、回队未提交项、结算终态项 */
export async function resumeVideoBatches(): Promise<void> {
  const jobs = await db.select().from(schema.videoBatchJobs)
    .where(inArray(schema.videoBatchJobs.status, ['running', 'stopped']))
  for (const job of jobs) {
    const items = await loadItems(job.id)
    const bound = new Set(items.map(i => i.taskId).filter((id): id is number => id != null))
    for (const item of items) {
      if ((item.status || 'queued') !== 'submitting') continue
      const candidates = await db.select().from(schema.sysTask)
        .where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, item.storyboardId)))
        .orderBy(schema.sysTask.id)
      const adopted = candidates
        .filter(task => !bound.has(task.id) && task.createdAt >= item.updatedAt)
        .pop()
      const ts = new Date().toISOString()
      if (adopted) {
        bound.add(adopted.id)
        await db.update(schema.videoBatchItems)
          .set({ status: 'processing', taskId: adopted.id, error: null, updatedAt: ts })
          .where(eq(schema.videoBatchItems.id, item.id))
        logTaskProgress('VideoBatch', 'resume-adopt', { batchId: job.id, storyboardId: item.storyboardId, taskId: adopted.id })
      } else {
        await db.update(schema.videoBatchItems)
          .set({ status: 'queued', taskId: null, updatedAt: ts })
          .where(eq(schema.videoBatchItems.id, item.id))
        logTaskProgress('VideoBatch', 'resume-requeue', { batchId: job.id, storyboardId: item.storyboardId })
      }
    }
    const [fresh] = await db.select().from(schema.videoBatchJobs).where(eq(schema.videoBatchJobs.id, job.id))
    if (fresh) await reconcileJob(fresh)
  }
}

let workerTimer: ReturnType<typeof setInterval> | null = null

export function startVideoBatchWorker(intervalMs = 3000): void {
  if (workerTimer) return
  const loop = async () => {
    try {
      await runVideoBatchTick()
    } catch (err: any) {
      logTaskError('VideoBatch', 'tick', { error: err?.message || String(err) })
    }
  }
  void loop()
  workerTimer = setInterval(loop, intervalMs)
  workerTimer.unref?.()
}

export function stopVideoBatchWorker(): void {
  if (workerTimer) clearInterval(workerTimer)
  workerTimer = null
}
