import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-job-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { createNovel } = await import('../src/services/novels.ts')
const { saveChapter } = await import('../src/services/novel-chapters.ts')
const { startNovelJob, getNovelJob } = await import('../src/services/novel-job-runner.ts')
const { default: novelJobsRoute } = await import('../src/routes/novelJobs.ts')
const { default: novelsRoute } = await import('../src/routes/novels.ts')

const api = new Hono()
api.route('/novel-jobs', novelJobsRoute)
api.route('/novels', novelsRoute)
const app = new Hono()
app.route('/api/v1', api)

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface SseEvent {
  event: string
  data: Record<string, any>
}

async function readSse(response: Response, until: 'done' | 'error'): Promise<SseEvent[]> {
  assert.ok(response.body, 'SSE response must have a body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: SseEvent[] = []
  let buffer = ''

  try {
    while (true) {
      const chunk = await withTimeout(reader.read(), 5000, `SSE timeout before ${until}`)
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const eventName = block.split('\n').find((line) => line.startsWith('event: '))?.slice(7)
        const dataLines = block.split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
        if (eventName && dataLines.length) {
          let data: Record<string, any> = {}
          try {
            data = JSON.parse(dataLines.join('\n'))
          } catch {
            data = { raw: dataLines.join('\n') }
          }
          events.push({ event: eventName, data })
          if (eventName === until) {
            await reader.cancel().catch(() => {})
            return events
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }

  throw new Error(`SSE finished before ${until}: ${JSON.stringify(events)}`)
}

function insertJob(values: Partial<typeof schema.novelJobs.$inferInsert> & { novelId: number; type: string }) {
  const ts = '2026-01-01T00:00:00.000Z'
  const inserted = db.insert(schema.novelJobs).values({
    status: 'done',
    progress: 0,
    total: 0,
    createdAt: ts,
    startedAt: ts,
    ...values,
  }).run()
  return Number(inserted.lastInsertRowid)
}

test('GET /novel-jobs/:id returns snake_case job status and result', async () => {
  const novel = createNovel({ title: '任务查询', topic: '悬疑', genre: ['悬疑'], number_of_chapters: 2, word_number: 1200 })
  const id = insertJob({
    novelId: novel.id,
    type: 'architecture',
    chapterNo: null,
    status: 'done',
    progress: 5,
    total: 5,
    result: JSON.stringify({ promptVersion: '1.0.0', steps: [] }),
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
  })

  const response = await app.request(`/api/v1/novel-jobs/${id}`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.data.id, id)
  assert.equal(body.data.novel_id, novel.id)
  assert.equal(body.data.status, 'done')
  assert.equal(body.data.progress, 5)
  assert.equal(body.data.finished_at, '2026-01-01T00:01:00.000Z')
  assert.equal(body.data.result.prompt_version, '1.0.0')

  assert.equal((await app.request('/api/v1/novel-jobs/abc')).status, 400)
  assert.equal((await app.request('/api/v1/novel-jobs/999999')).status, 404)
})

test('POST /novel-jobs/:id/cancel cancels once and is idempotent', async () => {
  const novel = createNovel({ title: '任务取消', topic: '悬疑', genre: ['悬疑'], number_of_chapters: 2, word_number: 1200 })
  const id = insertJob({
    novelId: novel.id,
    type: 'architecture',
    status: 'running',
    progress: 1,
    total: 5,
  })

  const first = await app.request(`/api/v1/novel-jobs/${id}/cancel`, { method: 'POST' })
  assert.equal(first.status, 200)
  const firstBody = await first.json()
  assert.equal(firstBody.data.cancelled, true)
  assert.equal(firstBody.data.job.status, 'cancelled')

  const second = await app.request(`/api/v1/novel-jobs/${id}/cancel`, { method: 'POST' })
  const secondBody = await second.json()
  assert.equal(secondBody.data.cancelled, false)
  assert.equal(secondBody.data.job.status, 'cancelled')

  assert.equal((await app.request('/api/v1/novel-jobs/999999/cancel', { method: 'POST' })).status, 404)
})

test('GET /novels/:id/jobs filters by status', async () => {
  const novel = createNovel({ title: '任务列表', topic: '都市', genre: ['都市'], number_of_chapters: 2, word_number: 1200 })
  insertJob({ novelId: novel.id, type: 'architecture', status: 'done' })
  insertJob({ novelId: novel.id, type: 'chapter', chapterNo: 1, status: 'running' })

  const response = await app.request(`/api/v1/novels/${novel.id}/jobs?status=running`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.data.items.length, 1)
  assert.equal(body.data.items[0].type, 'chapter')
  assert.equal(body.data.items[0].chapter_no, 1)

  const all = await app.request(`/api/v1/novels/${novel.id}/jobs`)
  assert.equal((await all.json()).data.items.length, 2)

  assert.equal((await app.request('/api/v1/novels/999999/jobs')).status, 404)
})

test('SSE replays a finished job with snapshot then done', async () => {
  const novel = createNovel({ title: 'SSE 回放', topic: '玄幻', genre: ['玄幻'], number_of_chapters: 2, word_number: 1200 })
  const id = insertJob({
    novelId: novel.id,
    type: 'architecture',
    status: 'done',
    progress: 5,
    total: 5,
    result: JSON.stringify({ promptVersion: '1.0.0', steps: [] }),
    finishedAt: '2026-01-01T00:01:00.000Z',
  })

  const response = await app.request(`/api/v1/novel-jobs/${id}/stream`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/)

  const events = await readSse(response, 'done')
  assert.equal(events[0].event, 'snapshot')
  assert.equal(events[0].data.job_id, id)
  assert.equal(events[0].data.status, 'done')
  assert.equal(events.at(-1)?.event, 'done')
  assert.equal(events.at(-1)?.data.job_id, id)
  assert.equal(events.at(-1)?.data.result.prompt_version, '1.0.0')
})

test('SSE replays a failed job with snapshot then error', async () => {
  const novel = createNovel({ title: 'SSE 失败', topic: '科幻', genre: ['科幻'], number_of_chapters: 2, word_number: 1200 })
  const id = insertJob({
    novelId: novel.id,
    type: 'architecture',
    status: 'failed',
    error: '额度不足',
    errorCode: 'quota',
    finishedAt: '2026-01-01T00:01:00.000Z',
  })

  const response = await app.request(`/api/v1/novel-jobs/${id}/stream`)
  const events = await readSse(response, 'error')
  assert.equal(events[0].event, 'snapshot')
  assert.equal(events[0].data.status, 'failed')
  assert.equal(events.at(-1)?.event, 'error')
  assert.equal(events.at(-1)?.data.code, 'quota')
  assert.equal(events.at(-1)?.data.message, '额度不足')
})

test('SSE forwards live stage and delta events for a running job', async () => {
  const novel = createNovel({ title: 'SSE 直播', topic: '仙侠', genre: ['仙侠'], number_of_chapters: 2, word_number: 1200 })
  const gate = deferred()
  const secondStarted = deferred()
  let calls = 0

  const llm = {
    async complete() {
      calls += 1
      if (calls === 1) return '【coreSeed】'
      secondStarted.resolve()
      await gate.promise
      if (calls === 6) return JSON.stringify({ places: [{ name: '青云山', x: 0.4, y: 0.6 }] })
      if (calls === 7) return JSON.stringify({ events: [{ chapterNo: 1, timeLabel: '第一日', title: '入门' }] })
      return `【第${calls}步】`
    },
  }

  const { job, completion } = startNovelJob({ novelId: novel.id, type: 'architecture', llm })
  await withTimeout(secondStarted.promise, 2000, 'second architecture step did not start')

  const response = await app.request(`/api/v1/novel-jobs/${job.id}/stream`)
  assert.equal(response.status, 200)
  const eventsPromise = readSse(response, 'done')
  await new Promise((resolve) => setTimeout(resolve, 20))
  gate.resolve()

  const events = await withTimeout(eventsPromise, 5000, 'SSE live timeout')
  await withTimeout(completion, 2000, 'job did not complete')

  assert.equal(events[0].event, 'snapshot')
  assert.equal(events[0].data.status, 'running')
  assert.equal(events[0].data.stage, 'characterDynamics')

  const types = events.map((event) => event.event)
  assert.ok(types.includes('stage'), `missing stage event: ${types.join(',')}`)
  assert.ok(types.includes('delta'), `missing delta event: ${types.join(',')}`)
  assert.equal(events.at(-1)?.event, 'done')
  assert.equal(events.at(-1)?.data.result.prompt_version, '1.2.0')
})

test('SSE returns 404 for an unknown job', async () => {
  const response = await app.request('/api/v1/novel-jobs/999999/stream')
  assert.equal(response.status, 404)
})

async function waitTerminal(id: number, ms = 2000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const row = getNovelJob(id)
    if (row && ['done', 'failed', 'cancelled', 'interrupted'].includes(row.status)) return row
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return getNovelJob(id)
}

async function postGenerate(path: string, body?: Record<string, unknown>) {
  return app.request(path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
}

async function cancelAndWait(id: number) {
  await app.request(`/api/v1/novel-jobs/${id}/cancel`, { method: 'POST' })
  await waitTerminal(id)
}

test('generation start routes create jobs for every type', async () => {
  const novel = createNovel({ title: '启动任务', topic: '复仇', genre: ['古装'], number_of_chapters: 2, word_number: 1200 })

  const arch = await postGenerate(`/api/v1/novels/${novel.id}/architecture/generate`)
  assert.equal(arch.status, 200)
  const archId = (await arch.json()).data.job_id
  assert.equal(getNovelJob(archId)?.type, 'architecture')
  assert.equal(getNovelJob(archId)?.status, 'running')
  await cancelAndWait(archId)

  const blueprint = await postGenerate(`/api/v1/novels/${novel.id}/blueprint/generate`)
  assert.equal(blueprint.status, 200)
  const blueprintId = (await blueprint.json()).data.job_id
  assert.equal(getNovelJob(blueprintId)?.type, 'blueprint')
  await cancelAndWait(blueprintId)

  saveChapter(novel.id, 1, { content: '已有正文' })
  assert.equal((await postGenerate(`/api/v1/novels/${novel.id}/chapters/1/generate`)).status, 409)
  const forced = await postGenerate(`/api/v1/novels/${novel.id}/chapters/1/generate`, { force: true })
  assert.equal(forced.status, 200)
  const forcedId = (await forced.json()).data.job_id
  assert.equal(getNovelJob(forcedId)?.type, 'chapter')
  assert.equal(getNovelJob(forcedId)?.chapterNo, 1)
  await cancelAndWait(forcedId)

  const finalize = await postGenerate(`/api/v1/novels/${novel.id}/chapters/1/finalize`, { content: '定稿正文' })
  assert.equal(finalize.status, 200)
  const finalizeId = (await finalize.json()).data.job_id
  assert.equal(getNovelJob(finalizeId)?.type, 'finalize')
  await cancelAndWait(finalizeId)

  const enrich = await postGenerate(`/api/v1/novels/${novel.id}/chapters/1/enrich`, { word_number: 1500 })
  assert.equal(enrich.status, 200)
  const enrichId = (await enrich.json()).data.job_id
  assert.equal(getNovelJob(enrichId)?.type, 'enrich')
  await cancelAndWait(enrichId)
})

test('generation start routes validate novel, chapter number and running conflict', async () => {
  assert.equal((await postGenerate('/api/v1/novels/999999/architecture/generate')).status, 404)

  const novel = createNovel({ title: '启动校验', topic: '都市', genre: ['都市'], number_of_chapters: 2, word_number: 1200 })
  assert.equal((await postGenerate(`/api/v1/novels/${novel.id}/chapters/0/generate`)).status, 400)
  assert.equal((await postGenerate(`/api/v1/novels/${novel.id}/chapters/abc/finalize`)).status, 400)

  insertJob({ novelId: novel.id, type: 'architecture', status: 'running' })
  assert.equal((await postGenerate(`/api/v1/novels/${novel.id}/architecture/generate`)).status, 409)
  assert.equal((await postGenerate(`/api/v1/novels/${novel.id}/chapters/2/generate`)).status, 409)
})
