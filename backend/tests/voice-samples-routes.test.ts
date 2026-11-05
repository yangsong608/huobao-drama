/**
 * 试听/自由试音路由与 TTS 能力矩阵。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-voice-samples-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { createVoice } = await import('../src/services/voice-profile.ts')
const { default: voicesRoute } = await import('../src/routes/voices.ts')
const { default: ttsRoute } = await import('../src/routes/tts.ts')
const { capabilitiesFor } = await import('../src/services/tts-capabilities.ts')

const app = new Hono()
app.route('/api/v1/voices', voicesRoute)
app.route('/api/v1/tts', ttsRoute)
const ts = '2026-11-05T00:00:00.000Z'

db.insert(schema.dramas).values({ title: '路由测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values({ dramaId: 1, name: '林小雨', role: '女主', createdAt: ts, updatedAt: ts }).run()
const [episode] = db.insert(schema.episodes).values({ dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts }).returning().all()
const [storyboard] = db.insert(schema.storyboards).values({ episodeId: episode.id, dramaId: 1, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().all()
const voice = createVoice({
  dramaId: 1, characterId: 1, name: '林小雨 · 声线', source: 'design',
  sampleText: '默认试听文本。', status: 'ready', seed: 33,
})

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('GET auditions 返回默认文本、来源、种子与历史', async () => {
  db.insert(schema.voiceSamples).values({
    voiceId: voice.id, dramaId: 1, kind: 'audition', text: '历史一句。', textSource: 'custom',
    seed: 33, provider: 'qwen3-tts', model: 'qwen3-tts-voicedesign', audioUrl: 'static/tts/a.wav',
    durationMs: 1000, hash: 'a', status: 'ready', createdAt: ts,
  }).run()

  const response = await app.request(`/api/v1/voices/${voice.id}/auditions?episode_id=${episode.id}`)
  assert.equal(response.status, 200)
  const json: any = await response.json()
  assert.equal(json.data.text, '默认试听文本。')
  assert.equal(json.data.text_source, 'default')
  assert.equal(json.data.seed, 33)
  assert.equal(json.data.max_chars, 300)
  assert.equal(json.data.items.length, 1)
})

test('POST set-sample 更新当前样音，DELETE 软删历史', async () => {
  const inserted = db.insert(schema.voiceSamples).values({
    voiceId: voice.id, dramaId: 1, kind: 'audition', text: '设为样例。', textSource: 'custom',
    seed: 33, audioUrl: 'static/tts/b.wav', durationMs: 900, hash: 'b', status: 'ready', createdAt: ts,
  }).returning().get()!

  const setResponse = await app.request(`/api/v1/voices/${voice.id}/auditions/${inserted.id}/set-sample`, { method: 'POST' })
  assert.equal(setResponse.status, 200)
  const setJson: any = await setResponse.json()
  assert.equal(setJson.data.sampleUrl, 'static/tts/b.wav')

  const delResponse = await app.request(`/api/v1/voices/${voice.id}/auditions/${inserted.id}`, { method: 'DELETE' })
  assert.equal(delResponse.status, 200)
  const after = (await (await app.request(`/api/v1/voices/${voice.id}/auditions?episode_id=${episode.id}`)).json()) as any
  assert.equal(after.data.items.some((item: any) => item.id === inserted.id), false)
})

test('POST apply-lines 改派台词且保留音频', async () => {
  const [line] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id, lineNo: 1,
    speakerType: 'dialogue', characterId: 1, speakerName: '林小雨', text: '改派。', speakText: '改派。',
    status: 'ready', audioUrl: 'static/tts/old.wav', audioDurationMs: 800, audioHash: 'old',
    createdAt: ts, updatedAt: ts,
  }).returning().all()

  const response = await app.request(`/api/v1/voices/${voice.id}/apply-lines`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episode_id: episode.id, line_ids: [line.id] }),
  })
  assert.equal(response.status, 200)
  const json: any = await response.json()
  assert.equal(json.data.updated, 1)
  const updated = db.select().from(schema.storyboardLines).all().find(row => row.id === line.id)!
  assert.equal(updated.voiceId, voice.id)
  assert.equal(updated.audioUrl, 'static/tts/old.wav')
  assert.equal(updated.audioStale, true)
})

test('能力矩阵按通道声明支持项与文本上限', () => {
  const qwen191 = capabilitiesFor({
    provider: 'qwen3-tts', baseUrl: 'http://127.0.0.1:18190', apiKey: '',
    model: 'qwen3-tts-customvoice', settings: {},
  })
  assert.equal(qwen191.speed, false)
  assert.equal(qwen191.seed, true)
  assert.equal(qwen191.refAudio, false)
  assert.equal(qwen191.maxInputChars, 500)
  assert.ok(qwen191.ignored.includes('speed'))

  const cloud = capabilitiesFor({
    provider: 'volcengine', baseUrl: 'https://example.com', apiKey: '',
    model: 'doubao-tts', settings: {},
  })
  assert.equal(cloud.voicePrompt, false)
  assert.equal(cloud.designInstruct, false)
  assert.equal(cloud.refAudio, false)
  assert.equal(cloud.maxSpeechChars, 2000)

  const none = capabilitiesFor(null)
  assert.equal(none.provider, 'none')
  assert.equal(none.maxAuditionChars, 300)
})

test('GET /tts/capabilities 在未配置时返回 none', async () => {
  const response = await app.request('/api/v1/tts/capabilities')
  assert.equal(response.status, 200)
  const json: any = await response.json()
  assert.equal(json.data.provider, 'none')
})
