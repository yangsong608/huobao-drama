/**
 * 音色试听 / 自由试音 / 历史 / 改派台词（设计 6.2–6.4）。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-voice-samples-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { createVoice } = await import('../src/services/voice-profile.ts')
const {
  AUDITION_MAX_CHARS,
  SPEECH_MAX_CHARS,
  assignVoiceToLines,
  deleteVoiceSample,
  generateVoiceSample,
  listVoiceSamples,
  resolveAuditionText,
  setVoiceSample,
} = await import('../src/services/voice-samples.ts')

const ts = '2026-11-05T00:00:00.000Z'
const fakeConfig = {
  provider: 'qwen3-tts',
  baseUrl: 'http://127.0.0.1:18190',
  apiKey: 'test',
  model: 'qwen3-tts-voicedesign',
  settings: {},
} as any
let synthCalls: any[] = []
const fakeSynth = (async (params: any) => {
  synthCalls.push(params)
  return { url: 'static/tts/fake.wav', durationMs: 1234, format: 'wav', hash: 'fake-hash', cached: false }
}) as any

db.insert(schema.dramas).values({ title: '试听测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values({ dramaId: 1, name: '林小雨', role: '女主', createdAt: ts, updatedAt: ts }).run()
const [episode] = db.insert(schema.episodes).values({ dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts }).returning().all()
const [storyboard] = db.insert(schema.storyboards).values({ episodeId: episode.id, dramaId: 1, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().all()
db.insert(schema.storyboardLines).values({
  episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id, lineNo: 1,
  speakerType: 'dialogue', characterId: 1, speakerName: '林小雨',
  text: '雨夜里的每一步都像踩在回忆上。', speakText: '雨夜里的每一步都像踩在回忆上。',
  createdAt: ts, updatedAt: ts,
}).run()

function makeVoice(overrides: Record<string, any> = {}) {
  return createVoice({
    dramaId: 1, characterId: 1, name: '林小雨 · 声线', source: 'design',
    voicePrompt: '清冷少女音', designInstruct: 'calm young female', speed: 1.05,
    emotion: '克制', status: 'ready', ...overrides,
  })
}

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('试听文本优先级：sample_text > 本集首句 > 固定句', () => {
  const saved = makeVoice({ sampleText: '保存的试听文本。' })
  assert.deepEqual(resolveAuditionText(saved, episode.id), { text: '保存的试听文本。', source: 'default' })

  const fromLine = makeVoice({ name: '第二声线' })
  assert.deepEqual(resolveAuditionText(fromLine, episode.id), { text: '雨夜里的每一步都像踩在回忆上。', source: 'line' })

  const narrator = createVoice({ dramaId: 1, scope: 'narrator', name: '旁白', source: 'design', status: 'ready' })
  assert.deepEqual(resolveAuditionText(narrator, episode.id), { text: '我是旁白，很高兴见到你。', source: 'default' })
})

test('生成试听写入 voice_samples，自动分配种子并写回音色', async () => {
  synthCalls = []
  const voice = makeVoice({ seed: null })
  const result = await generateVoiceSample({
    voiceId: voice.id, kind: 'audition', text: '我是林小雨。', episodeId: episode.id,
  }, { config: fakeConfig, synthesize: fakeSynth })

  assert.equal(result.text, '我是林小雨。')
  assert.equal(result.textSource, 'custom')
  assert.ok(result.seed > 0)
  assert.equal(result.sample.status, 'ready')
  assert.equal(result.sample.audioUrl, 'static/tts/fake.wav')
  assert.equal(result.sample.durationMs, 1234)
  assert.equal(result.sample.textSource, 'custom')
  assert.equal(result.sample.provider, 'qwen3-tts')
  assert.equal(result.sample.model, 'qwen3-tts-voicedesign')
  assert.equal(JSON.parse(result.sample.paramsJson || '{}').speed, 1.05)
  assert.equal(synthCalls[0].seed, result.seed)

  const persisted = db.select().from(schema.characterVoices).all().find(row => row.id === voice.id)!
  assert.equal(persisted.seed, result.seed)
  assert.equal(persisted.sampleUrl, null)
})

test('显式种子覆盖并写回，setSample 才更新当前样音', async () => {
  synthCalls = []
  const voice = makeVoice({ seed: 11 })
  const result = await generateVoiceSample({
    voiceId: voice.id, kind: 'audition', text: '换一个种子。', seed: 20261105, setSample: true,
  }, { config: fakeConfig, synthesize: fakeSynth })

  assert.equal(result.seed, 20261105)
  assert.equal(synthCalls[0].seed, 20261105)
  const persisted = db.select().from(schema.characterVoices).all().find(row => row.id === voice.id)!
  assert.equal(persisted.seed, 20261105)
  assert.equal(persisted.sampleUrl, 'static/tts/fake.wav')
  assert.equal(persisted.sampleText, '换一个种子。')
})

test('试听保留最近 20 条，历史可设为样例和删除', async () => {
  const voice = makeVoice()
  for (let i = 0; i < 22; i += 1) {
    await generateVoiceSample({ voiceId: voice.id, kind: 'audition', text: `试听 ${i}` }, { config: fakeConfig, synthesize: fakeSynth })
  }
  const rows = listVoiceSamples(voice.id, 50)
  assert.equal(rows.length, 20)
  assert.equal(rows[0].text, '试听 21')

  const target = rows[5]
  const updated = setVoiceSample(voice.id, target.id)
  assert.equal(updated.sampleUrl, target.audioUrl)
  assert.equal(updated.sampleText, target.text)

  assert.equal(deleteVoiceSample(voice.id, target.id), true)
  assert.equal(deleteVoiceSample(voice.id, target.id), false)
  assert.equal(listVoiceSamples(voice.id, 50).some(row => row.id === target.id), false)
})

test('自由试音不截断、不默认设为样例，超过 2000 字被拒绝', async () => {
  const voice = makeVoice()
  const longText = '长'.repeat(SPEECH_MAX_CHARS)
  const result = await generateVoiceSample({
    voiceId: voice.id, kind: 'speech', text: longText,
  }, { config: fakeConfig, synthesize: fakeSynth })
  assert.equal(result.truncated, false)
  assert.equal(result.sample.kind, 'speech')
  assert.equal([...result.sample.text].length, SPEECH_MAX_CHARS)

  await assert.rejects(
    generateVoiceSample({ voiceId: voice.id, kind: 'speech', text: `${longText}超` }, { config: fakeConfig, synthesize: fakeSynth }),
    /2000/,
  )

  const persisted = db.select().from(schema.characterVoices).all().find(row => row.id === voice.id)!
  assert.equal(persisted.sampleUrl, null)
})

test('试听超 300 字只保留前 300 字并标记 truncated', async () => {
  const voice = makeVoice()
  const result = await generateVoiceSample({
    voiceId: voice.id, kind: 'audition', text: '甲'.repeat(AUDITION_MAX_CHARS + 10),
  }, { config: fakeConfig, synthesize: fakeSynth })
  assert.equal(result.truncated, true)
  assert.equal([...result.text].length, AUDITION_MAX_CHARS)
})

test('改派音色到指定台词：保留旧音频、标记 audio_stale、锁定显式选择', () => {
  const voice = makeVoice({ name: '改派声线' })
  const [line] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id, lineNo: 20,
    speakerType: 'dialogue', characterId: 1, speakerName: '林小雨', text: '改派。', speakText: '改派。',
    status: 'ready', audioUrl: 'static/tts/old.wav', audioDurationMs: 800, audioHash: 'old',
    createdAt: ts, updatedAt: ts,
  }).returning().all()
  const [empty] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id, lineNo: 21,
    speakerType: 'dialogue', characterId: 1, speakerName: '林小雨', text: '没录音。', speakText: '没录音。',
    status: 'pending', createdAt: ts, updatedAt: ts,
  }).returning().all()

  const result = assignVoiceToLines(voice.id, episode.id, [line.id, empty.id])
  assert.equal(result.updated, 2)

  const rows = db.select().from(schema.storyboardLines).all()
  const withAudio = rows.find(row => row.id === line.id)!
  const noAudio = rows.find(row => row.id === empty.id)!
  assert.equal(withAudio.voiceId, voice.id)
  assert.equal(withAudio.voiceLocked, true)
  assert.equal(withAudio.audioUrl, 'static/tts/old.wav')
  assert.equal(withAudio.status, 'ready')
  assert.equal(withAudio.audioStale, true)
  assert.equal(noAudio.voiceId, voice.id)
  assert.equal(noAudio.audioStale, false)
})
