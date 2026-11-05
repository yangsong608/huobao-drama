/**
 * Take 生命周期（设计 7.2 / 7.5）：生成快照、激活切换、删除回退、能力裁剪与复用。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-line-takes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { createVoice } = await import('../src/services/voice-profile.ts')
const {
  activateTake,
  deleteTake,
  generateTake,
  listLineTakes,
} = await import('../src/services/line-takes.ts')

const ts = '2026-11-05T00:00:00.000Z'
db.insert(schema.dramas).values({ title: 'Take 测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values({ dramaId: 1, name: '林小雨', role: '女主', createdAt: ts, updatedAt: ts }).run()
const [episode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
}).returning().all()
const [storyboard] = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, description: '雨夜车内',
  createdAt: ts, updatedAt: ts,
}).returning().all()
const voice = createVoice({
  dramaId: 1, characterId: 1, name: '林小雨 · 声线', source: 'design',
  voicePrompt: '清冷少女音', designInstruct: 'calm young female',
  emotion: '克制', speed: 1.2, language: 'Chinese', seed: 42,
  externalVoiceId: 'ext-1', status: 'ready',
})

function addLine(lineNo: number, text: string) {
  const [row] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id,
    lineNo, sortOrder: lineNo, speakerType: 'dialogue', characterId: 1, voiceId: voice.id,
    speakerName: '林小雨', text, speakText: text, textRevision: 3,
    emotion: '质问', speed: 0.9, direction: '压低声音',
    createdAt: ts, updatedAt: ts,
  }).returning().all()
  return row
}

const line = addLine(1, '你骗了我三年。')
const qwenLine = addLine(2, '我只是不想让你卷进来。')
const cloudLine = addLine(3, '小雨，你听我解释。')
const reuseLine = addLine(4, '雨更大了。')

const calls: any[] = []
let synthCount = 0
const fakeSynth = (async (params: any) => {
  calls.push(params)
  synthCount += 1
  return {
    url: `static/tts/fake-${synthCount}.wav`,
    durationMs: 1200 + synthCount,
    format: 'wav',
    hash: `hash-${synthCount}`,
    cached: false,
  }
}) as any

function config(overrides: Record<string, any> = {}) {
  return {
    id: 7,
    provider: 'qwen3-tts',
    baseUrl: 'http://127.0.0.1:18190',
    apiKey: 'test',
    model: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign',
    settings: {},
    ...overrides,
  } as any
}
const mainConfig = config()
const qwen191Config = config({ model: 'qwen3-tts-voicedesign' })
const cloudConfig = config({ id: 8, provider: 'doubao', model: 'doubao-tts' })

function reloadLine(id: number) {
  return db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()!
}

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('生成 Take 写入快照与指纹，并默认激活', async () => {
  const result = await generateTake({ lineId: line.id }, { config: mainConfig, synthesize: fakeSynth })
  assert.equal(result.take.takeNo, 1)
  assert.equal(result.take.status, 'ready')
  assert.equal(result.take.isActive, true)
  assert.equal(result.take.text, '你骗了我三年。')
  assert.equal(result.take.speakText, '你骗了我三年。')
  assert.equal(result.take.textRevision, 3)
  assert.match(result.take.voiceFingerprint || '', /^[0-9a-f]{64}$/)
  assert.match(result.take.contextHash || '', /^[0-9a-f]{40}$/)
  const params = JSON.parse(result.take.paramsJson || '{}')
  assert.match(params.render_hash, /^[0-9a-f]{64}$/)
  assert.ok(params.ignored.includes('seed'))
  assert.equal(params.emotion, '质问')
  assert.equal(params.speed, 0.9)

  const stored = reloadLine(line.id)
  assert.equal(stored.activeTakeId, result.take.id)
  assert.equal(stored.audioUrl, 'static/tts/fake-1.wav')
  assert.equal(stored.audioDurationMs, 1201)
  assert.equal(stored.audioHash, 'hash-1')
  assert.equal(stored.status, 'ready')

  assert.equal(calls[0].speed, 0.9)
  assert.equal(calls[0].emotion, '质问')
  assert.equal(calls[0].language, 'Chinese')
  assert.equal(calls[0].seed, undefined)
  assert.ok(String(calls[0].voice.voicePrompt).includes('压低声音'))

  const second = await generateTake({
    lineId: line.id,
    overrides: { emotion: '崩溃', speed: 1.1 },
  }, { config: mainConfig, synthesize: fakeSynth })
  assert.equal(second.take.takeNo, 2)
  assert.equal(second.take.isActive, true)
  assert.equal(calls[1].emotion, '崩溃')
  assert.equal(calls[1].speed, 1.1)

  const takes = listLineTakes(line.id)
  assert.equal(takes.length, 2)
  assert.equal(takes.find(item => item.id === result.take.id)?.isActive, false)
  assert.equal(reloadLine(line.id).audioUrl, 'static/tts/fake-2.wav')
})

test('激活切换同步台词音频，删除当前 Take 回退上一条，删完回 pending', async () => {
  const takes = listLineTakes(line.id)
  const first = takes.find(item => item.takeNo === 1)!
  const second = takes.find(item => item.takeNo === 2)!

  const activated = activateTake(first.id)
  assert.equal(activated.isActive, true)
  assert.equal(reloadLine(line.id).audioUrl, 'static/tts/fake-1.wav')
  assert.equal(reloadLine(line.id).activeTakeId, first.id)

  const fallback = deleteTake(first.id)
  assert.equal(fallback.fallbackTakeId, second.id)
  assert.equal(reloadLine(line.id).audioUrl, 'static/tts/fake-2.wav')
  assert.equal(reloadLine(line.id).activeTakeId, second.id)

  const cleared = deleteTake(second.id)
  assert.equal(cleared.fallbackTakeId, null)
  const stored = reloadLine(line.id)
  assert.equal(stored.status, 'pending')
  assert.equal(stored.audioUrl, null)
  assert.equal(stored.audioDurationMs, null)
  assert.equal(stored.audioHash, null)
  assert.equal(stored.activeTakeId, null)
  assert.equal(listLineTakes(line.id).length, 0)
})

test('qwen191 裁剪 speed/emotion，仍发送 seed 与表演指令', async () => {
  const result = await generateTake({ lineId: qwenLine.id }, { config: qwen191Config, synthesize: fakeSynth })
  const sent = calls[calls.length - 1]
  assert.equal(sent.speed, undefined)
  assert.equal(sent.emotion, undefined)
  assert.equal(sent.seed, 42)
  assert.ok(String(sent.voice.voicePrompt).includes('压低声音'))
  const params = JSON.parse(result.take.paramsJson || '{}')
  assert.ok(params.ignored.includes('speed'))
  assert.ok(params.ignored.includes('emotion'))
})

test('云语音裁剪 instruct/seed/参考音频，保留 emotion/speed', async () => {
  const result = await generateTake({
    lineId: cloudLine.id,
    overrides: { seed: 99 },
  }, { config: cloudConfig, synthesize: fakeSynth })
  const sent = calls[calls.length - 1]
  assert.equal(sent.speed, 0.9)
  assert.equal(sent.emotion, '质问')
  assert.equal(sent.seed, undefined)
  assert.equal(sent.voice.voicePrompt, undefined)
  assert.equal(sent.voice.designInstruct, undefined)
  assert.equal(sent.voice.refAudioUrl, undefined)
  const params = JSON.parse(result.take.paramsJson || '{}')
  assert.ok(params.ignored.includes('seed'))
  assert.ok(params.ignored.includes('instruct'))
})

test('reuse=true 命中同 renderHash 的 ready Take，不新建；reuse=false 新建', async () => {
  const input = {
    lineId: reuseLine.id,
    contextMode: 'light' as const,
    overrides: { emotion: '平静', speed: 1 },
  }
  const first = await generateTake(input, { config: mainConfig, synthesize: fakeSynth })
  const countAfterFirst = synthCount

  const reused = await generateTake(
    { ...input, reuse: true },
    { config: mainConfig, synthesize: fakeSynth },
  )
  assert.equal(reused.cached, true)
  assert.equal(reused.take.id, first.take.id)
  assert.equal(synthCount, countAfterFirst)
  assert.equal(listLineTakes(reuseLine.id).length, 1)

  const fresh = await generateTake(
    { ...input, reuse: false },
    { config: mainConfig, synthesize: fakeSynth },
  )
  assert.equal(fresh.cached, false)
  assert.equal(fresh.take.takeNo, 2)
  assert.equal(synthCount, countAfterFirst + 1)
})
