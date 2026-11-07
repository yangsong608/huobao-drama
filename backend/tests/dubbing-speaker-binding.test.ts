/**
 * 配音工作台说话人绑定（2026-11-08 五项需求 1/4）：
 * 未分配台词设为角色/绑定现有、清空本集行级音色、角色保守删除守卫。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-speaker-binding-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { episodeLines } = await import('../src/routes/lines.ts')

const app = new Hono()
app.route('/episodes', episodeLines)

const ts = '2026-11-08T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '绑定测试', status: 'draft', createdAt: ts, updatedAt: ts }).run()
const [episode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
}).returning().all()
const [storyboard] = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, description: '街道', createdAt: ts, updatedAt: ts,
}).returning().all()

db.insert(schema.characters).values({ id: 1, dramaId: 1, name: '现有角色', createdAt: ts, updatedAt: ts }).run()

function addLine(input: {
  lineNo: number
  text: string
  speakerName?: string | null
  characterId?: number | null
  voiceId?: number | null
  voiceLocked?: boolean
  audioUrl?: string | null
}) {
  const [row] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id,
    lineNo: input.lineNo, sortOrder: input.lineNo, speakerType: 'dialogue',
    characterId: input.characterId ?? null, voiceId: input.voiceId ?? null,
    voiceLocked: input.voiceLocked ?? false,
    speakerName: input.speakerName ?? null, text: input.text, speakText: input.text,
    audioUrl: input.audioUrl ?? null,
    createdAt: ts, updatedAt: ts,
  }).returning().all()
  return row
}

const lineRow = (id: number) => db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()!

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('设为角色：按说话人名新建角色并绑定本集未分配台词', async () => {
  const a = addLine({ lineNo: 1, text: '让开。', speakerName: '路人甲' })
  const b = addLine({ lineNo: 2, text: '站住。', speakerName: '路人甲' })
  const response = await app.request('/episodes/1/lines/bind-speaker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ speaker_name: '路人甲' }),
  })
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.bound, 2)
  const character = db.select().from(schema.characters)
    .where(and(eq(schema.characters.dramaId, 1), eq(schema.characters.name, '路人甲'), isNull(schema.characters.deletedAt)))
    .get()
  assert.ok(character)
  assert.equal(data.character_id, character!.id)
  assert.equal(lineRow(a.id)!.characterId, character!.id)
  assert.equal(lineRow(b.id)!.characterId, character!.id)
  const cast = db.select().from(schema.episodeCharacters)
    .where(and(eq(schema.episodeCharacters.episodeId, episode.id), eq(schema.episodeCharacters.characterId, character!.id)))
    .get()
  assert.ok(cast)
})

test('绑定现有：未分配台词挂到指定角色，说话人名同步为角色名', async () => {
  const a = addLine({ lineNo: 3, text: '是我。', speakerName: '神秘人' })
  const response = await app.request('/episodes/1/lines/bind-speaker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ speaker_name: '神秘人', character_id: 1 }),
  })
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.character_id, 1)
  assert.equal(data.bound, 1)
  assert.equal(lineRow(a.id)!.characterId, 1)
  assert.equal(lineRow(a.id)!.speakerName, '现有角色')
})

test('清空本集行级音色：非锁定清空并标记音频过期，锁定行保留', async () => {
  const v1 = addLine({ lineNo: 4, text: '普通行', speakerName: '现有角色', characterId: 1, voiceId: 424242, audioUrl: 'static/tts/a.wav' })
  const v2 = addLine({ lineNo: 5, text: '锁定行', speakerName: '现有角色', characterId: 1, voiceId: 424243, voiceLocked: true, audioUrl: 'static/tts/b.wav' })
  const response = await app.request('/episodes/1/lines/reset-voices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.ok(data.cleared >= 1)
  assert.equal(lineRow(v1.id)!.voiceId, null)
  assert.equal(lineRow(v1.id)!.audioStale, true)
  assert.equal(lineRow(v2.id)!.voiceId, 424243)
})

test('保守删除：角色有分镜绑定时只解除本集台词绑定，角色保留', async () => {
  db.insert(schema.storyboardCharacters).values({ storyboardId: storyboard.id, characterId: 1 }).run()
  const bound = addLine({ lineNo: 6, text: '角色台词', speakerName: '现有角色', characterId: 1, voiceId: 424244 })
  const response = await app.request('/episodes/1/lines/detach-speaker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 1 }),
  })
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.mode, 'unbound')
  assert.equal(lineRow(bound.id)!.characterId, null)
  assert.equal(lineRow(bound.id)!.voiceId, null)
  const character = db.select().from(schema.characters).where(eq(schema.characters.id, 1)).get()
  assert.equal(character!.deletedAt, null)
})

test('保守删除：无分镜绑定的角色连同音色一起软删', async () => {
  const { createVoice } = await import('../src/services/voice-profile.ts')
  const [tempChar] = db.insert(schema.characters).values({
    dramaId: 1, name: '临时角色', createdAt: ts, updatedAt: ts,
  }).returning().all()
  const voice = createVoice({ dramaId: 1, characterId: tempChar.id, scope: 'character', name: '临时角色 · 声线', source: 'design', status: 'ready' })
  const bound = addLine({ lineNo: 7, text: '临时台词', speakerName: '临时角色', characterId: tempChar.id, voiceId: voice.id })

  const response = await app.request('/episodes/1/lines/detach-speaker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: tempChar.id }),
  })
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.equal(data.mode, 'deleted')
  assert.ok(db.select().from(schema.characters).where(eq(schema.characters.id, tempChar.id)).get()!.deletedAt)
  assert.ok(db.select().from(schema.characterVoices).where(eq(schema.characterVoices.id, voice.id)).get()!.deletedAt)
  assert.equal(lineRow(bound.id)!.characterId, null)
  assert.equal(lineRow(bound.id)!.voiceId, null)
})

test('detach-speaker 对不存在的角色返回 404', async () => {
  const response = await app.request('/episodes/1/lines/detach-speaker', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ character_id: 999 }),
  })
  assert.equal(response.status, 404)
})
