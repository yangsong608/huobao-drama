/**
 * 持久化任务队列（V2 · M5-1）
 *
 * 目标：进程重启后任务不丢、同集不并发、按资源限流。
 * 实现：SQLite pipeline_jobs + 进程内工作循环；claim 用事务保证不重复领取。
 */
import os from 'node:os'
import crypto from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type JobResource = 'episode' | 'video' | 'image' | 'audio' | 'novel'

export const WORKER_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`

export interface EnqueueInput {
  kind: string
  resource: JobResource | string
  dramaId?: number | null
  episodeId?: number | null
  payload?: Record<string, unknown>
  priority?: number
  maxAttempts?: number
  /** 同集同资源已有排队/运行任务时返回已有 id（默认 true） */
  dedupe?: boolean
}

export interface QueueSettings {
  enabled: boolean
  maxConcurrent: number
}

/**
 * 入队；同集 + 同资源 + 同 kind 已存在未完成任务时复用（避免双击建两条）。
 */
export function enqueueJob(input: EnqueueInput): { id: number; reused: boolean } {
  if (input.dedupe !== false) {
    const existing = db.select().from(schema.pipelineJobs)
      .where(and(
        eq(schema.pipelineJobs.kind, input.kind),
        eq(schema.pipelineJobs.resource, input.resource),
        inArray(schema.pipelineJobs.status, ['queued', 'running']),
        input.episodeId ? eq(schema.pipelineJobs.episodeId, input.episodeId) : isNull(schema.pipelineJobs.episodeId),
      ))
      .get()
    if (existing) return { id: existing.id, reused: true }
  }
  const ts = now()
  const res = db.insert(schema.pipelineJobs).values({
    kind: input.kind,
    resource: input.resource,
    dramaId: input.dramaId ?? null,
    episodeId: input.episodeId ?? null,
    status: 'queued',
    priority: input.priority ?? 0,
    payload: JSON.stringify(input.payload || {}),
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 2,
    createdAt: ts,
  }).run()
  return { id: getInsertId(res), reused: false }
}

/** 领取一条任务：按 priority desc, id asc；同资源串行由 worker 的并发配置保证 */
export function claimNextJob(resources: string[]): typeof schema.pipelineJobs.$inferSelect | null {
  if (!resources.length) return null
  let claimed: typeof schema.pipelineJobs.$inferSelect | null = null
  db.transaction((tx) => {
    const candidate = tx.select().from(schema.pipelineJobs)
      .where(and(
        eq(schema.pipelineJobs.status, 'queued'),
        inArray(schema.pipelineJobs.resource, resources),
      ))
      .orderBy(desc(schema.pipelineJobs.priority), asc(schema.pipelineJobs.id))
      .get()
    if (!candidate) return
    const ts = now()
    const updated = tx.update(schema.pipelineJobs)
      .set({ status: 'running', lockedBy: WORKER_ID, heartbeatAt: ts, startedAt: candidate.startedAt || ts, attempts: (candidate.attempts || 0) + 1 })
      .where(and(eq(schema.pipelineJobs.id, candidate.id), eq(schema.pipelineJobs.status, 'queued')))
      .returning()
      .get()
    claimed = updated || null
  })
  return claimed
}

export function heartbeat(jobId: number, note?: string) {
  db.update(schema.pipelineJobs)
    .set({ heartbeatAt: now(), ...(note !== undefined ? { note } : {}) })
    .where(eq(schema.pipelineJobs.id, jobId))
    .run()
}

export function updateJobProgress(jobId: number, progress: number, note?: string) {
  db.update(schema.pipelineJobs)
    .set({ progress: Math.max(0, Math.min(100, Math.round(progress))), heartbeatAt: now(), ...(note !== undefined ? { note } : {}) })
    .where(eq(schema.pipelineJobs.id, jobId))
    .run()
}

export function completeJob(jobId: number) {
  db.update(schema.pipelineJobs)
    .set({ status: 'done', progress: 100, finishedAt: now(), lockedBy: null })
    .where(eq(schema.pipelineJobs.id, jobId))
    .run()
}

/** 失败：未到 maxAttempts 回 queued 重试，否则 failed */
export function failJob(jobId: number, error: string): 'queued' | 'failed' {
  const row = db.select().from(schema.pipelineJobs).where(eq(schema.pipelineJobs.id, jobId)).get()
  if (!row) return 'failed'
  const retry = (row.attempts || 0) < (row.maxAttempts || 1)
  db.update(schema.pipelineJobs)
    .set({
      status: retry ? 'queued' : 'failed',
      error: error.slice(0, 500),
      lockedBy: null,
      heartbeatAt: null,
      finishedAt: retry ? null : now(),
    })
    .where(eq(schema.pipelineJobs.id, jobId))
    .run()
  return retry ? 'queued' : 'failed'
}

export function cancelJob(jobId: number): boolean {
  const row = db.select().from(schema.pipelineJobs).where(eq(schema.pipelineJobs.id, jobId)).get()
  if (!row) return false
  if (row.status === 'running') return false
  db.update(schema.pipelineJobs)
    .set({ status: 'cancelled', finishedAt: now(), lockedBy: null })
    .where(eq(schema.pipelineJobs.id, jobId))
    .run()
  return true
}

/** 进程重启恢复：把心跳超时的 running 重新排队（或标失败） */
export function recoverStaleJobs(staleMs = 120_000): number {
  const cutoff = new Date(Date.now() - staleMs).toISOString()
  const rows = db.select().from(schema.pipelineJobs)
    .where(and(
      eq(schema.pipelineJobs.status, 'running'),
      or(isNull(schema.pipelineJobs.heartbeatAt), eq(schema.pipelineJobs.lockedBy, WORKER_ID)),
    ))
    .all()
  let recovered = 0
  for (const row of rows) {
    const beat = row.heartbeatAt || row.startedAt || row.createdAt
    if (beat && beat > cutoff) continue
    const retry = (row.attempts || 0) < (row.maxAttempts || 1)
    db.update(schema.pipelineJobs)
      .set({
        status: retry ? 'queued' : 'failed',
        error: retry ? null : '服务重启，任务中断次数已达上限',
        lockedBy: null,
        heartbeatAt: null,
        finishedAt: retry ? null : now(),
      })
      .where(eq(schema.pipelineJobs.id, row.id))
      .run()
    recovered += 1
  }
  return recovered
}

/** 启动时调用：所有 running 一律视为中断（本进程还没开始跑） */
export function markOrphanedJobs(): number {
  const rows = db.select().from(schema.pipelineJobs).where(eq(schema.pipelineJobs.status, 'running')).all()
  let n = 0
  for (const row of rows) {
    if (row.lockedBy === WORKER_ID) continue
    const retry = (row.attempts || 0) < (row.maxAttempts || 1)
    db.update(schema.pipelineJobs)
      .set({
        status: retry ? 'queued' : 'failed',
        error: retry ? null : '服务重启，任务中断次数已达上限',
        lockedBy: null,
        heartbeatAt: null,
        finishedAt: retry ? null : now(),
      })
      .where(eq(schema.pipelineJobs.id, row.id))
      .run()
    n += 1
  }
  return n
}

export function listJobs(filter: { status?: string; resource?: string; dramaId?: number; limit?: number } = {}) {
  let rows = db.select().from(schema.pipelineJobs).orderBy(desc(schema.pipelineJobs.id)).all()
  if (filter.status) rows = rows.filter((r) => r.status === filter.status)
  if (filter.resource) rows = rows.filter((r) => r.resource === filter.resource)
  if (filter.dramaId) rows = rows.filter((r) => r.dramaId === filter.dramaId)
  const queued = rows
    .filter((r) => r.status === 'queued')
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.id - b.id)
  const positions = new Map(queued.map((r, index) => [r.id, index + 1]))
  return rows.slice(0, Math.min(200, filter.limit || 50)).map((r) => ({
    ...r,
    position: positions.get(r.id) ?? null,
  }))
}

export function queueStats() {
  const rows = db.select().from(schema.pipelineJobs).all()
  const byStatus: Record<string, number> = {}
  const byResource: Record<string, number> = {}
  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1
    if (row.status === 'queued') byResource[row.resource] = (byResource[row.resource] || 0) + 1
  }
  return { total: rows.length, by_status: byStatus, queued_by_resource: byResource, worker: WORKER_ID }
}

export function getJob(id: number) {
  return db.select().from(schema.pipelineJobs).where(eq(schema.pipelineJobs.id, id)).get() || null
}
