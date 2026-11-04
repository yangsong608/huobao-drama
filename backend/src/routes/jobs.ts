/**
 * 任务队列（V2 · 13.4）
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, notFound, success } from '../utils/response.js'
import { cancelJob, getJob, listJobs, queueStats } from '../services/job-queue.js'
import { getQueueConcurrency, isQueueEnabled, setQueueConcurrency, setQueueEnabled } from '../services/app-settings.js'

const app = new Hono()

app.get('/', (c) => {
  const status = c.req.query('status') || undefined
  const resource = c.req.query('resource') || undefined
  const dramaId = c.req.query('drama_id') ? Number(c.req.query('drama_id')) : undefined
  return success(c, { items: listJobs({ status, resource, dramaId }) })
})

app.get('/stats', (c) => {
  const stats = queueStats()
  return success(c, {
    ...stats,
    queued: stats.by_status.queued || 0,
    running: stats.by_status.running || 0,
    done: stats.by_status.done || 0,
    failed: stats.by_status.failed || 0,
    enabled: isQueueEnabled(),
    max_concurrent: getQueueConcurrency(),
  })
})

app.get('/settings', (c) => success(c, { enabled: isQueueEnabled(), max_concurrent: getQueueConcurrency() }))

app.put('/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (body.enabled !== undefined) setQueueEnabled(Boolean(body.enabled))
  if (body.max_concurrent !== undefined) setQueueConcurrency(Number(body.max_concurrent))
  return success(c, { enabled: isQueueEnabled(), max_concurrent: getQueueConcurrency() })
})

app.get('/:id', (c) => {
  const id = Number(c.req.param('id'))
  const job = getJob(id)
  if (!job) return notFound(c, '任务不存在')
  return success(c, job)
})

app.post('/:id/retry', (c) => {
  const id = Number(c.req.param('id'))
  const job = getJob(id)
  if (!job) return notFound(c, '任务不存在')
  if (job.status !== 'failed' && job.status !== 'cancelled') return badRequest(c, '只有失败或已取消的任务可以重试')
  db.update(schema.pipelineJobs)
    .set({ status: 'queued', error: null, finishedAt: null, lockedBy: null, heartbeatAt: null, attempts: 0 })
    .where(eq(schema.pipelineJobs.id, id))
    .run()
  return success(c, { id, status: 'queued' })
})

app.post('/:id/cancel', (c) => {
  const id = Number(c.req.param('id'))
  if (!cancelJob(id)) return badRequest(c, '任务不存在或正在运行（请先在剧集上停止自动化）')
  return success(c, { id, status: 'cancelled' })
})

export default app
