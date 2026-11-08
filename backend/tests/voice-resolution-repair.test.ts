/**
 * 音色解析自愈与缺音色阻止（2026-11-08 五项反馈之 2/5）：
 * - 行级 voice_id 指向已删除音色时自动清空并回退；
 * - 角色无激活音色时生成阻止并标记，不再静默回落旁白；
 * - 重新设计后新版本自动激活（角色/旁白）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-voice-repair-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { createVoice, resolveVoiceForLine, getVoice, setNarratorVoice, activateVoice } = await import('../src/services/voice-profile.ts')
const { persistRedesign } = await import('../src/services/voice-design.ts')
const { generateTake } = await import('../src/services/line-takes.ts')

const ts = '2026-11-08T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '修复测试', status: 'draft', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values({ id: 1, dramaId: 1, name: '无音色角色', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values({ id: 2, dramaId: 1, name: '有音色角色', createdAt: ts, updatedAt: ts }).run()
const [episode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
}).returning().all()
const [storyboard] = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, description: '测试镜头', createdAt: ts, updatedAt: ts,
}).returning().all()

const narrator = createVoice({
  dramaId: 1, characterId: null, scope: 'narrator', name: '旁白', source: 'design', status: 'ready',
})
setNarratorVoice(1, narrator.id)
const charVoice = createVoice({
  dramaId: 1, characterId: 2, scope: 'character', name: '有音色角色 · 声线', source: 'design', status: 'ready',
})
activateVoice(2, charVoice.id)

function addLine(input: {
  lineNo: number
  text: string
  characterId?: number | null
  voiceId?: number | null
  speakerType?: 'dialogue' | 'narration'
}) {
  const [row] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id,
    lineNo: input.lineNo, sortOrder: input.lineNo, speakerType: input.speakerType || 'dialogue',
    characterId: input.characterId ?? null, voiceId: input.voiceId ?? null,
    speakerName: '测试', text: input.text, speakText: input.text,
    createdAt: ts, updatedAt: ts,
  }).returning().all()
  return row
}

const line = (id: number) => db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()!

test('行级 voice_id 指向已删除音色时，带 lineId 的解析自愈清空并回退旁白', () => {
  const stale = addLine({ lineNo: 1, text: '台词一', characterId: 1, voiceId: 424242 })
  const resolved = resolveVoiceForLine({ voiceId: stale.voiceId, characterId: stale.characterId, dramaId: 1, lineId: stale.id })
  assert.equal(resolved?.id, narrator.id)
  assert.equal(line(stale.id).voiceId, null)
})

test('不带 lineId 的解析保持只读，不清台词行', () => {
  const stale = addLine({ lineNo: 2, text: '台词二', characterId: 1, voiceId: 424242 })
  const resolved = resolveVoiceForLine({ voiceId: stale.voiceId, characterId: stale.characterId, dramaId: 1 })
  assert.equal(resolved?.id, narrator.id)
  assert.equal(line(stale.id).voiceId, 424242)
})

test('绑定角色但无激活音色时，生成被阻止并标记行错误，不再静默用旁白', async () => {
  const blocked = addLine({ lineNo: 3, text: '台词三', characterId: 1 })
  await assert.rejects(
    () => generateTake({ lineId: blocked.id }),
    /激活.*音色|音色.*激活/,
  )
  assert.match(String(line(blocked.id).error || ''), /激活.*音色|音色.*激活/)
})

test('显式指定 voiceId 时允许覆盖，继续走到语音服务配置检查', async () => {
  const overridden = addLine({ lineNo: 4, text: '台词四', characterId: 1 })
  await assert.rejects(
    () => generateTake({ lineId: overridden.id, voiceId: narrator.id }, { config: null }),
    (error: Error & { code?: string }) => error.code === 'no_audio_config',
  )
})

test('有激活音色的角色不受阻止逻辑影响', async () => {
  const ok = addLine({ lineNo: 5, text: '台词五', characterId: 2 })
  await assert.rejects(
    () => generateTake({ lineId: ok.id }, { config: null }),
    (error: Error & { code?: string }) => error.code === 'no_audio_config',
  )
})

test('角色台词残留旁白音色绑定时自愈清空，落到角色激活音色', () => {
  const frozen = addLine({ lineNo: 6, text: '台词六', characterId: 2, voiceId: narrator.id })
  const resolved = resolveVoiceForLine({ voiceId: frozen.voiceId, characterId: frozen.characterId, dramaId: 1, lineId: frozen.id })
  assert.equal(resolved?.id, charVoice.id)
  assert.equal(line(frozen.id).voiceId, null)
})

test('显式锁定的台词保留用户选择的音色，不被自动改写', () => {
  const [locked] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id,
    lineNo: 7, sortOrder: 7, speakerType: 'dialogue', characterId: 2, voiceId: narrator.id,
    voiceLocked: true, speakerName: '测试', text: '台词七', speakText: '台词七',
    createdAt: ts, updatedAt: ts,
  }).returning().all()
  const resolved = resolveVoiceForLine({ voiceId: locked.voiceId, characterId: locked.characterId, dramaId: 1, lineId: locked.id })
  assert.equal(resolved?.id, narrator.id)
  assert.equal(line(locked.id).voiceId, narrator.id)
})

const fakeProfile = {
  character_name: '任意',
  gender: '女',
  age_range: '青年',
  voice_prompt: '沙哑低沉的女声',
  design_instruct: '语速慢，气声重',
  sample_text: '这是一段试音文本。',
  emotion: '克制',
  speed: 1,
  source: 'template' as const,
}

test('重新设计角色音色后新版本自动激活，旧版本取消激活', () => {
  const old = createVoice({
    dramaId: 1, characterId: 2, scope: 'character', name: '有音色角色 · 声线', source: 'design', status: 'ready',
  })
  const created = persistRedesign(getVoice(old.id)!, fakeProfile as never)
  assert.ok(created && created.id !== old.id)
  assert.equal(getVoice(created.id)?.isActive, true)
  assert.equal(getVoice(old.id)?.isActive, false)
  assert.equal(getVoice(old.id)?.status, 'ready')
})

test('重新设计旁白音色后自动绑定为项目旁白', () => {
  const old = createVoice({
    dramaId: 1, characterId: null, scope: 'narrator', name: '旁白', source: 'design', status: 'ready',
  })
  const created = persistRedesign(getVoice(old.id)!, fakeProfile as never)
  assert.ok(created && created.id !== old.id)
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, 1)).get()
  assert.equal(drama?.narratorVoiceId, created.id)
})
