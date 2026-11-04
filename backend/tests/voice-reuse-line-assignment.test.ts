/**
 * 音色资产化：项目级复用与逐句改派。
 * - 复制音色只新增目标版本，不改源音色；
 * - 台词改派音色后必须作废旧音频，等待按新音色重合成。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-voice-reuse-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { cloneVoice, createVoice, getVoice, activateVoice } = await import('../src/services/voice-profile.ts')
const { default: linesRoute } = await import('../src/routes/lines.ts')

const app = new Hono()
app.route('/api/v1/lines', linesRoute)

const ts = '2026-03-02T00:00:00.000Z'

db.insert(schema.dramas).values({ title: '音色复用测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
const [hero] = db.insert(schema.characters).values({ dramaId: 1, name: '沈砚', role: '书生', createdAt: ts, updatedAt: ts }).returning().all()
const [maid] = db.insert(schema.characters).values({ dramaId: 1, name: '阿蛮', role: '侍女', createdAt: ts, updatedAt: ts }).returning().all()
const [episode] = db.insert(schema.episodes).values({ dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts }).returning().all()
const [storyboard] = db.insert(schema.storyboards).values({ episodeId: episode.id, dramaId: 1, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().all()

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function makeVoice(characterId: number | null, name: string) {
  return createVoice({
    dramaId: 1,
    characterId,
    name,
    source: 'design',
    voicePrompt: `${name} 提示词`,
    designInstruct: 'calm young voice',
    externalVoiceId: `ext-${name}`,
    refAudioUrl: 'static/projects/1/voices/ref.wav',
    sampleUrl: 'static/tts/sample.wav',
    sampleText: '你好，我是测试音色。',
    gender: 'male',
    ageRange: '20-30',
    speed: 1.1,
    emotion: 'calm',
    status: 'ready',
  })
}

test('复制音色到另一角色：完整复制并激活，源音色不变', () => {
  const source = makeVoice(hero.id, '沈砚声线')
  activateVoice(hero.id, source.id)
  const before = getVoice(source.id)!

  const copied = cloneVoice(source.id, { characterId: maid.id })

  assert.equal(copied.dramaId, 1)
  assert.equal(copied.characterId, maid.id)
  assert.equal(copied.scope, 'character')
  assert.equal(copied.voicePrompt, before.voicePrompt)
  assert.equal(copied.designInstruct, before.designInstruct)
  assert.equal(copied.externalVoiceId, before.externalVoiceId)
  assert.equal(copied.refAudioUrl, before.refAudioUrl)
  assert.equal(copied.sampleUrl, before.sampleUrl)
  assert.equal(copied.gender, 'male')
  assert.equal(copied.ageRange, '20-30')
  assert.equal(copied.speed, 1.1)
  assert.equal(copied.emotion, 'calm')
  assert.equal(copied.isActive, true)
  assert.notEqual(copied.id, source.id)

  const sourceAfter = getVoice(source.id)!
  assert.equal(sourceAfter.isActive, true)
  assert.equal(sourceAfter.characterId, hero.id)
  assert.equal(sourceAfter.voicePrompt, before.voicePrompt)
})

test('复制为旁白音色：scope 归一且不绑定角色', () => {
  const source = makeVoice(hero.id, '旁白候选')
  const copied = cloneVoice(source.id, { scope: 'narrator' })
  assert.equal(copied.scope, 'narrator')
  assert.equal(copied.characterId, null)
  assert.equal(copied.isActive, true)
})

test('复制到其他项目角色会被拒绝', () => {
  db.insert(schema.dramas).values({ title: '另一个项目', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
  const [foreign] = db.insert(schema.characters).values({ dramaId: 2, name: '外人', role: '路人', createdAt: ts, updatedAt: ts }).returning().all()
  const source = makeVoice(hero.id, '跨项目源')
  assert.throws(() => cloneVoice(source.id, { characterId: foreign.id }), /不属于同一项目/)
})

test('台词改派音色会作废旧音频并等待重合成', async () => {
  const oldVoice = makeVoice(hero.id, '旧声线')
  const newVoice = makeVoice(hero.id, '新声线')
  const [line] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id,
    dramaId: 1,
    storyboardId: storyboard.id,
    lineNo: 1,
    speakerType: 'dialogue',
    speakerName: '沈砚',
    characterId: hero.id,
    text: '走吧。',
    speakText: '走吧。',
    voiceId: oldVoice.id,
    status: 'ready',
    audioUrl: 'static/tts/old.wav',
    audioDurationMs: 1200,
    audioHash: 'old-hash',
    createdAt: ts,
    updatedAt: ts,
  }).returning().all()

  const response = await app.request(`/api/v1/lines/${line.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ voice_id: newVoice.id }),
  })
  assert.equal(response.status, 200)

  const row = db.select().from(schema.storyboardLines).all().find((item) => item.id === line.id)!
  assert.equal(row.voiceId, newVoice.id)
  assert.equal(row.status, 'pending')
  assert.equal(row.audioUrl, null)
  assert.equal(row.audioDurationMs, null)
  assert.equal(row.audioHash, null)
})
