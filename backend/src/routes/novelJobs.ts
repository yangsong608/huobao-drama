/**
 * 小说生成任务路由（V3 · Phase 2）
 *
 * GET  /novel-jobs/:id         任务状态（snake_case）
 * GET  /novel-jobs/:id/stream  SSE：snapshot/stage/delta/done/error
 * POST /novel-jobs/:id/cancel  取消任务（幂等）
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { success, badRequest, notFound } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import {
  getNovelJob,
  cancelNovelJob,
  subscribeNovelJobEvents,
  isNovelJobTerminal,
  parseNovelJobResult,
  serializeNovelJob,
  type NovelJobEvent,
  type NovelJobRow,
} from '../services/novel-job-runner.js'

const app = new Hono()
const HEARTBEAT_MS = 15_000

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function snapshotPayload(row: NovelJobRow) {
  return {
    job_id: row.id,
    novel_id: row.novelId,
    type: row.type,
    chapter_no: row.chapterNo ?? null,
    status: row.status,
    stage: row.stage ?? null,
    progress: row.progress ?? 0,
    total: row.total ?? 0,
    message: row.message ?? null,
    partial: row.partial ?? null,
  }
}

function terminalEvent(row: NovelJobRow): { event: string; data: Record<string, unknown> } {
  if (row.status === 'done') {
    return {
      event: 'done',
      data: {
        job_id: row.id,
        result: toSnakeCase(parseNovelJobResult(row.result) ?? {}),
      },
    }
  }
  if (row.status === 'failed') {
    return {
      event: 'error',
      data: {
        job_id: row.id,
        code: row.errorCode || 'protocol',
        message: row.error || '生成任务失败',
      },
    }
  }
  if (row.status === 'cancelled') {
    return {
      event: 'error',
      data: {
        job_id: row.id,
        code: 'cancelled',
        message: row.message || '已取消',
      },
    }
  }
  return {
    event: 'error',
    data: {
      job_id: row.id,
      code: 'interrupted',
      message: row.message || '任务已中断',
    },
  }
}

function liveEvent(jobId: number, event: NovelJobEvent): { event: string; data: Record<string, unknown> } {
  switch (event.type) {
    case 'stage':
      return {
        event: 'stage',
        data: {
          job_id: jobId,
          stage: event.stage,
          label: event.label,
          current: event.current,
          total: event.total,
        },
      }
    case 'delta':
      return { event: 'delta', data: { job_id: jobId, text: event.text } }
    case 'done':
      return { event: 'done', data: { job_id: jobId, result: toSnakeCase(event.result) } }
    case 'cancelled':
      return {
        event: 'error',
        data: { job_id: jobId, code: 'cancelled', message: event.message },
      }
    case 'error':
      return {
        event: 'error',
        data: { job_id: jobId, code: event.code, message: event.message },
      }
  }
}

app.get('/:id', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '任务编号无效')
  const row = getNovelJob(id)
  if (!row) return notFound(c, '任务不存在')
  return success(c, serializeNovelJob(row))
})

app.post('/:id/cancel', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '任务编号无效')
  const before = getNovelJob(id)
  if (!before) return notFound(c, '任务不存在')
  const cancelled = !isNovelJobTerminal(before.status)
  const row = cancelNovelJob(id)
  if (!row) return notFound(c, '任务不存在')
  return success(c, { cancelled, job: serializeNovelJob(row) })
})

app.get('/:id/stream', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '任务编号无效')
  if (!getNovelJob(id)) return notFound(c, '任务不存在')

  return streamSSE(c, async (stream) => {
    let unsubscribe: (() => void) | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let cleanedUp = false
    let finished = false
    let releaseFinished: (() => void) | undefined
    const finishedPromise = new Promise<void>((resolve) => {
      releaseFinished = resolve
    })
    let chain: Promise<void> = Promise.resolve()
    const pending: NovelJobEvent[] = []
    let snapshotSent = false

    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      unsubscribe?.()
      if (heartbeat) clearInterval(heartbeat)
      c.req.raw.signal.removeEventListener('abort', onAbort)
      releaseFinished?.()
    }
    const onAbort = () => cleanup()

    const write = (event: string, data: Record<string, unknown>) => {
      chain = chain
        .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
        .catch(() => {})
      return chain
    }

    const finish = () => {
      if (finished) return
      finished = true
      cleanup()
    }

    const forward = (event: NovelJobEvent) => {
      const mapped = liveEvent(id, event)
      write(mapped.event, mapped.data)
      if (event.type !== 'stage' && event.type !== 'delta') finish()
    }

    unsubscribe = subscribeNovelJobEvents(id, (event) => {
      if (!snapshotSent) {
        pending.push(event)
        return
      }
      forward(event)
    })
    stream.onAbort(cleanup)
    c.req.raw.signal.addEventListener('abort', onAbort)
    heartbeat = setInterval(() => {
      chain = chain.then(() => stream.write(': ping\n\n').then(() => {})).catch(() => {})
    }, HEARTBEAT_MS)

    const row = getNovelJob(id)
    if (!row) {
      await write('error', { job_id: id, code: 'not_found', message: '任务不存在' })
      finish()
      await finishedPromise
      await chain
      return
    }

    await write('snapshot', snapshotPayload(row))
    snapshotSent = true

    if (isNovelJobTerminal(row.status)) {
      const terminal = terminalEvent(row)
      await write(terminal.event, terminal.data)
      finish()
    } else {
      for (const event of pending.splice(0)) forward(event)
    }

    await finishedPromise
    await chain
  })
})

export default app
