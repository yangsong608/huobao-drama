/**
 * 音色档案：激活唯一性、解除、软删、解析优先级、V1 样本迁移、模板兜底
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-voice-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const {
  activateVoice,
  createVoice,
  deactivateVoice,
  deleteVoice,
  getLatestVoiceForCharacter,
  getNarratorVoice,
  listVoices,
  migrateUploadedVoices,
  resolveVoiceForLine,
  setNarratorVoice,
  updateVoice,
} = await import('../src/services/voice-profile.ts')
const { generateVoiceProfiles } = await import('../src/services/voice-design.ts')

const ts = '2026-01-01T00:00:00.000Z'

db.insert(schema.dramas).values({ title: '音色测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
const dramaId = 1
const [c1] = db.insert(schema.characters).values({ dramaId, name: '沈砚', role: '书生', createdAt: ts, updatedAt: ts }).returning().all()
const [c2] = db.insert(schema.characters).values({ dramaId, name: '阿蛮', role: '侍女', createdAt: ts, updatedAt: ts }).returning().all()

function makeVoice(characterId: number | null, name: string, source: 'design' | 'clone' = 'design') {
  return createVoice({
    dramaId,
    characterId,
    name,
    source,
    voicePrompt: `${name} 的提示词`,
    designInstruct: 'calm voice',
    status: 'ready',
  })
}

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('激活后同角色只有一条 is_active，并同步 characters 缓存', () => {
  const a = makeVoice(c1.id, '声线 A')
  const b = makeVoice(c1.id, '声线 B')
  activateVoice(c1.id, a.id)
  activateVoice(c1.id, b.id)

  const rows = db.select().from(schema.characterVoices).all().filter(v => v.characterId === c1.id)
  assert.equal(rows.filter(v => v.isActive).length, 1)
  assert.equal(rows.find(v => v.isActive)!.id, b.id)

  const character = db.select().from(schema.characters).all().find(c => c.id === c1.id)!
  assert.equal(character.voicePrompt, '声线 B 的提示词')
  assert.equal(character.voiceStatus, 'ready')
})

test('激活不属于该角色的音色会被拒绝', () => {
  const other = makeVoice(c2.id, '阿蛮声线')
  assert.throws(() => activateVoice(c1.id, other.id), /不属于该角色/)
})

test('解除激活清空缓存，解析回退到旁白', () => {
  const narrator = createVoice({ dramaId, scope: 'narrator', name: '旁白', voicePrompt: '旁白词', designInstruct: 'narration', status: 'ready' })
  setNarratorVoice(dramaId, narrator.id)

  const v = makeVoice(c2.id, '阿蛮声线 2')
  activateVoice(c2.id, v.id)
  assert.equal(resolveVoiceForLine({ characterId: c2.id, dramaId })?.id, v.id)

  deactivateVoice(c2.id)
  assert.equal(resolveVoiceForLine({ characterId: c2.id, dramaId })?.id, narrator.id)
  const character = db.select().from(schema.characters).all().find(c => c.id === c2.id)!
  assert.equal(character.voicePrompt, null)
})

test('解析优先级：显式 voice_id > 角色激活 > 项目旁白', () => {
  const narrator = getNarratorVoice(dramaId)!
  const explicit = makeVoice(c2.id, '显式指定')
  const active = makeVoice(c2.id, '激活音色')
  activateVoice(c2.id, active.id)

  assert.equal(resolveVoiceForLine({ voiceId: explicit.id, characterId: c2.id, dramaId })?.id, explicit.id)
  assert.equal(resolveVoiceForLine({ characterId: c2.id, dramaId })?.id, active.id)
  assert.equal(resolveVoiceForLine({ characterId: 999999, dramaId })?.id, narrator.id)
  assert.equal(resolveVoiceForLine({ characterId: 999999, dramaId: 999 }), null)
})

test('软删激活音色：列表消失，缓存清空，旁白绑定同步解除', () => {
  const narrator = getNarratorVoice(dramaId)!
  assert.equal(deleteVoice(narrator.id), true)
  assert.equal(getNarratorVoice(dramaId), null)

  const v = makeVoice(c1.id, '待删除')
  activateVoice(c1.id, v.id)
  deleteVoice(v.id)
  const listed = listVoices(dramaId).characters.find(c => c.character_id === c1.id)!
  assert.equal(listed.voices.some(x => x.id === v.id), false)
  assert.equal(db.select().from(schema.dramas).all().find(d => d.id === dramaId)!.narratorVoiceId, null)
})

test('旁白绑定拒绝角色音色', () => {
  const characterVoice = makeVoice(c1.id, '角色音')
  assert.throws(() => setNarratorVoice(dramaId, characterVoice.id), /不是旁白音色/)
})

test('V1 上传样本迁移为 upload 音色，重复执行不重复插入', () => {
  const [c3] = db.insert(schema.characters).values({
    dramaId, name: '马老三', voiceAudioUrl: 'static/projects/1/uploads/old.wav', voiceAudioName: 'old.wav', createdAt: ts, updatedAt: ts,
  }).returning().all()

  const first = migrateUploadedVoices()
  assert.equal(first.failed, 0)
  const rows = db.select().from(schema.characterVoices).all().filter(v => v.characterId === c3.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].source, 'upload')
  assert.equal(rows[0].status, 'ready')
  assert.equal(rows[0].isActive, true)

  const second = migrateUploadedVoices()
  assert.equal(second.migrated, 0)
  assert.equal(db.select().from(schema.characterVoices).all().filter(v => v.characterId === c3.id).length, 1)
})

test('更新试听地址与状态', () => {
  const voice = getLatestVoiceForCharacter(c1.id)!
  const updated = updateVoice(voice.id, { sampleUrl: 'static/tts/aa/aa.wav', status: 'ready' })
  assert.equal(updated?.sampleUrl, 'static/tts/aa/aa.wav')
  assert.equal(updated?.status, 'ready')
})

test('无文本模型时声音提示词回退模板，不抛错', async () => {
  const profiles = await generateVoiceProfiles({
    characters: [{ name: '沈砚', appearance: '二十岁出头的年轻男子，清瘦', personality: '沉稳' }],
    background: '北宋',
  })
  assert.equal(profiles.length, 1)
  assert.equal(profiles[0].source, 'template')
  assert.ok(profiles[0].voice_prompt.includes('沈砚'))
  assert.ok(profiles[0].design_instruct.length > 10)
})
