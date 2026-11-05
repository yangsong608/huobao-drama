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

export type TakeBatchFilter = 'pending' | 'failed' | 'audio_stale' | 'all'

export interface TakeBatchInput {
  lineIds?: number[] | null
  filter?: TakeBatchFilter
  contextMode?: ContextMode
  force?: boolean
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
  cached: number
  currentLineId: number | null
  errors: { lineId: number; message: string }[]
  cancelRequested: boolean
  startedAt: string
  finishedAt: string | null
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
    cached: 0,
    currentLineId: null,
    errors: [],
    cancelRequested: false,
    startedAt: now(),
    finishedAt: null,
  }
  jobs.set(job.id, job)
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
    if (!lines.length) {
      finish(job, 'done')
      return
    }

    const generate = deps.generate ?? generateTake
    const concurrency = clampConcurrency(input.concurrency)
    const force = Boolean(input.force)
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
          continue
        }
        if (!force && line.status === 'ready' && !line.audioStale && line.audioUrl) {
          job.skipped += 1
          job.done += 1
          continue
        }

        try {
          const result = await generate({
            lineId: line.id,
            contextMode,
            force,
            reuse: !force,
          }, { config: deps.config })
          job.ok += 1
          if (result.cached) job.cached += 1
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
