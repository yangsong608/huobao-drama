/**
 * Take 路由（设计 7.10）：列表/激活/删除/状态、语境预览、批量任务。
 * 生成本身在 line-takes / take-batch 单测覆盖，这里只验证 HTTP 契约。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-take-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
fsSync.mkdirSync(path.join(root, 'static'), { recursive: true })

const { db, schema } = await import('../src/db/index.ts')
const { createVoice } = await import('../src/services/voice-profile.ts')
const takesRouter = (await import('../src/routes/takes.ts')).default

const app = new Hono()
app.route('/api/v1', takesRouter)

const ts = '2026-11-05T00:00:00.000Z'
db.insert(schema.dramas).values({ title: 'Take 路由测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values({ dramaId: 1, name: '林小雨', role: '女主', createdAt: ts, updatedAt: ts }).run()
const [episode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
}).returning().all()
const [emptyEpisode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 2, title: '空集', createdAt: ts, updatedAt: ts,
}).returning().all()
const [shot] = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, duration: 6, description: '雨夜车内',
  createdAt: ts, updatedAt: ts,
}).returning().all()
const voice = createVoice({
  dramaId: 1, characterId: 1, name: '林小雨 · 声线', source: 'design',
  voicePrompt: '清冷少女音', designInstruct: 'calm young female',
  emotion: '克制', speed: 1.2, language: 'Chinese', seed: 42,
  externalVoiceId: 'ext-1', status: 'ready',
})

const lines = ['你骗了我三年。', '我只是不想让你卷进来。', '小雨，你听我解释。'].map((text, index) => {
  return db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: shot.id,
    lineNo: index + 1, sortOrder: index + 1, speakerType: 'dialogue',
    characterId: 1, voiceId: voice.id, speakerName: '林小雨',
    text, speakText: text, textRevision: 1,
    emotion: '质问', speed: 0.9,
    status: 'pending', createdAt: ts, updatedAt: ts,
  }).returning().get()
})
const [firstLine, middleLine, thirdLine] = lines

function insertTake(input: {
  lineId: number
  takeNo: number
  audioUrl: string
  isActive: boolean
  contextMode?: string
  params?: Record<string, unknown>
}) {
  const [take] = db.insert(schema.lineTakes).values({
    lineId: input.lineId,
    episodeId: episode.id,
    dramaId: 1,
    takeNo: input.takeNo,
    text: middleLine.text,
    speakText: middleLine.text,
    textRevision: 1,
    voiceId: voice.id,
    provider: 'qwen3-tts',
    model: 'Qwen3-TTS',
    paramsJson: JSON.stringify({
      emotion: '质问', speed: 0.9, seed: 7, ignored: ['seed'],
      render_hash: `render-${input.takeNo}`, context_mode: input.contextMode || 'light',
      ...(input.params || {}),
    }),
    contextMode: input.contextMode || 'light',
    contextJson: JSON.stringify({ mode: input.contextMode || 'light', previous: [], next: [], arc: null }),
    status: 'ready',
    audioUrl: input.audioUrl,
    durationMs: 1000 + input.takeNo,
    hash: `hash-${input.takeNo}`,
    isActive: input.isActive,
    createdAt: ts,
  }).returning().all()
  return take
}

const take1 = insertTake({ lineId: middleLine.id, takeNo: 1, audioUrl: 'static/tts/take-1.wav', isActive: false })
const take2 = insertTake({ lineId: middleLine.id, takeNo: 2, audioUrl: 'static/tts/take-2.wav', isActive: true })
db.update(schema.storyboardLines).set({
  audioUrl: take2.audioUrl, audioDurationMs: take2.durationMs, audioHash: take2.hash,
  activeTakeId: take2.id, status: 'ready', updatedAt: ts,
}).where(eq(schema.storyboardLines.id, middleLine.id)).run()

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

async function call(method: string, url: string, body?: unknown) {
  const response = await app.fetch(new Request(`http://localhost${url}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }))
  return { response, body: await response.json() as any }
}

test('Take 列表返回解析后的参数与语境，按 Take 序号倒序', async () => {
  const { response, body } = await call('GET', `/api/v1/lines/${middleLine.id}/takes`)
  assert.equal(response.status, 200)
  assert.equal(body.data.items.length, 2)
  assert.deepEqual(body.data.items.map((item: any) => item.takeNo), [2, 1])
  assert.equal(body.data.items[0].id, take2.id)
  assert.equal(body.data.items[0].isActive, true)
  assert.equal(body.data.items[0].audioUrl, 'static/tts/take-2.wav')
  assert.equal(body.data.items[0].params.emotion, '质问')
  assert.deepEqual(body.data.items[0].params.ignored, ['seed'])
  assert.equal(body.data.items[0].context.mode, 'light')
})

test('状态汇总台词与 Take 数量', async () => {
  const { response, body } = await call('GET', `/api/v1/episodes/${episode.id}/takes/status`)
  assert.equal(response.status, 200)
  assert.equal(body.data.total, 3)
  assert.equal(body.data.ready, 1)
  assert.equal(body.data.pending, 2)
  assert.equal(body.data.takes, 2)
})

test('激活与删除 Take 同步台词音频，删除当前 Take 回退到上一条', async () => {
  const activated = await call('POST', `/api/v1/takes/${take1.id}/activate`)
  assert.equal(activated.response.status, 200)
  assert.equal(activated.body.data.take.id, take1.id)
  assert.equal(activated.body.data.take.isActive, true)
  assert.equal(activated.body.data.line.audioUrl, 'static/tts/take-1.wav')
  assert.equal(activated.body.data.line.activeTakeId, take1.id)

  const removed = await call('DELETE', `/api/v1/takes/${take1.id}`)
  assert.equal(removed.response.status, 200)
  assert.equal(removed.body.data.lineId, middleLine.id)
  assert.equal(removed.body.data.fallbackTakeId, take2.id)

  const line = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, middleLine.id)).get()!
  assert.equal(line.audioUrl, 'static/tts/take-2.wav')
  assert.equal(line.activeTakeId, take2.id)

  const removedLast = await call('DELETE', `/api/v1/takes/${take2.id}`)
  assert.equal(removedLast.response.status, 200)
  assert.equal(removedLast.body.data.fallbackTakeId, null)
  const cleared = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, middleLine.id)).get()!
  assert.equal(cleared.audioUrl, null)
  assert.equal(cleared.activeTakeId, null)
  assert.equal(cleared.status, 'pending')
})

test('语境预览 light 模式返回前后台词且不调用文本模型', async () => {
  const { response, body } = await call('POST', `/api/v1/lines/${middleLine.id}/context/preview`, { mode: 'light' })
  assert.equal(response.status, 200)
  assert.equal(body.data.source, 'light')
  assert.equal(body.data.context.mode, 'light')
  assert.deepEqual(body.data.context.previous.map((item: any) => item.text), [firstLine.text])
  assert.deepEqual(body.data.context.next.map((item: any) => item.text), [thirdLine.text])
  assert.equal(body.data.context.scene.shotSummary, '雨夜车内')
  assert.equal(body.data.params.emotion, '质问')
  assert.equal(body.data.params.speed, 0.9)
  assert.equal(typeof body.data.capability.provider, 'string')
  assert.ok(Array.isArray(body.data.ignored))
})

test('空集批量任务立即完成', async () => {
  const started = await call('POST', `/api/v1/episodes/${emptyEpisode.id}/takes/batch`, { filter: 'all' })
  assert.equal(started.response.status, 200)
  assert.equal(typeof started.body.data.job_id, 'string')

  const job = await call('GET', `/api/v1/episodes/${emptyEpisode.id}/takes/batch/${started.body.data.job_id}`)
  assert.equal(job.response.status, 200)
  assert.equal(job.body.data.status, 'done')
  assert.equal(job.body.data.total, 0)
  assert.ok(job.body.data.finishedAt)
})

test('取消任务：不存在返回 404，已结束返回 400', async () => {
  const missing = await call('POST', `/api/v1/episodes/${emptyEpisode.id}/takes/batch/not-a-job/cancel`)
  assert.equal(missing.response.status, 404)

  const started = await call('POST', `/api/v1/episodes/${emptyEpisode.id}/takes/batch`, { filter: 'all' })
  const finished = await call('POST', `/api/v1/episodes/${emptyEpisode.id}/takes/batch/${started.body.data.job_id}/cancel`)
  assert.equal(finished.response.status, 400)
})
