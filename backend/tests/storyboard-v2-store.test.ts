import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-v2-store-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const {
  createV2Plan,
  getLatestV2Plan,
  getV2Plan,
  confirmV2Plan,
} = await import('../src/services/storyboard-v2-store.ts')
const {
  setActiveV2CoveragePreset,
  getActiveV2CoveragePreset,
  setV2ReviewChecklist,
  isStoryboardV2ProductionEnabled,
  setStoryboardV2ProductionEnabled,
} = await import('../src/services/storyboard-v2-config.ts')

const ts = '2026-01-01T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: 'V2 计划测试',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 1,
  title: '第一集',
  scriptContent: '## S01 | 外景 · 广场 | 上午\n\n沈砚：你好。\n\n罗晴：请进。',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

test('V2 计划可生成、读取、确认并版本化', async () => {
  const first = await createV2Plan({ episodeId: episode.id, minDuration: 2, maxDuration: 15 })
  assert.equal(first.version, 1)
  assert.equal(first.status, 'draft')
  assert.equal(first.issues.length, 0)
  assert.ok(first.plan.shots.length > 0)
  assert.equal(getLatestV2Plan(episode.id)?.id, first.id)
  assert.equal(getV2Plan(first.id)?.version, 1)

  const confirmed = confirmV2Plan(first.id)
  assert.equal(confirmed.status, 'confirmed')
  assert.ok(confirmed.confirmed_at)

  const second = await createV2Plan({ episodeId: episode.id, minDuration: 2, maxDuration: 15 })
  assert.equal(second.version, 2)
  assert.equal(second.status, 'draft')
  const latestConfirmed = confirmV2Plan(second.id)
  assert.equal(latestConfirmed.status, 'confirmed')
  assert.equal(getV2Plan(first.id)?.status, 'superseded')
})

test('不存在的剧集不能生成 V2 计划', async () => {
  await assert.rejects(() => createV2Plan({ episodeId: 999999 }), /剧集不存在/)
})

test('V2 计划会使用项目音色样音的真实语速', async () => {
  const character = db.insert(schema.characters).values({
    dramaId: drama.id,
    name: '沈砚',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const voice = db.insert(schema.characterVoices).values({
    dramaId: drama.id,
    characterId: character.id,
    scope: 'character',
    name: '沈砚音色',
    source: 'design',
    status: 'ready',
    isActive: true,
    speed: 1,
    language: 'Chinese',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  db.insert(schema.voiceSamples).values({
    voiceId: voice.id,
    dramaId: drama.id,
    text: '这是一句用于语速校准的干净样音',
    durationMs: 1800,
    status: 'ready',
    createdAt: ts,
  }).run()

  const plan = await createV2Plan({ episodeId: episode.id, minDuration: 2, maxDuration: 15 })
  assert.equal(plan.diagnostics.timingProfileSources['沈砚'], 'voice_samples')
  assert.ok(plan.diagnostics.estimatedDialogueSeconds > 0)
})

test('同一角色的括号别名共享真实语速档案', async () => {
  const aliasDrama = db.insert(schema.dramas).values({
    title: 'V2 角色别名测试',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const aliasEpisode = db.insert(schema.episodes).values({
    dramaId: aliasDrama.id,
    episodeNumber: 1,
    title: '第一集',
    scriptContent: '## S01 | 内景 · 唐记食铺 | 清晨\n\n唐奕：这是一句用来验证角色别名会复用同一份真实语速档案的台词。',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const character = db.insert(schema.characters).values({
    dramaId: aliasDrama.id,
    name: '唐大郎（唐奕）',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const voice = db.insert(schema.characterVoices).values({
    dramaId: aliasDrama.id,
    characterId: character.id,
    scope: 'character',
    name: '唐大郎音色',
    source: 'design',
    status: 'ready',
    isActive: true,
    speed: 1,
    language: 'Chinese',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  db.insert(schema.voiceSamples).values({
    voiceId: voice.id,
    dramaId: aliasDrama.id,
    text: '这是一句用于验证角色别名共享语速的真实样音',
    durationMs: 1800,
    status: 'ready',
    createdAt: ts,
  }).run()

  const plan = await createV2Plan({ episodeId: aliasEpisode.id, minDuration: 2, maxDuration: 15 })
  assert.equal(plan.diagnostics.timingProfileSources['唐奕'], 'voice_samples')
})


test('V2 覆盖预设和验收清单可持久化并进入计划', async () => {
  setActiveV2CoveragePreset('fast')
  assert.equal(getActiveV2CoveragePreset().key, 'fast')
  const checklist = setV2ReviewChecklist(['hook', 'rhythm'])
  assert.deepEqual(checklist.enabled, ['hook', 'rhythm'])

  const plan = await createV2Plan({ episodeId: episode.id, minDuration: 2, maxDuration: 15 })
  assert.equal(plan.plan.config.coveragePresetKey, 'fast')
  assert.deepEqual(plan.review_checklist.enabled, ['hook', 'rhythm'])

  setActiveV2CoveragePreset('balanced')
  setV2ReviewChecklist(['hook', 'reaction', 'rhythm', 'closeup', 'no_info', 'coverage', 'transition', 'dialogue'])
})


test('V2 生产开关默认关闭且可回滚', () => {
  assert.equal(isStoryboardV2ProductionEnabled(), false)
  assert.equal(setStoryboardV2ProductionEnabled(true), true)
  assert.equal(isStoryboardV2ProductionEnabled(), true)
  assert.equal(setStoryboardV2ProductionEnabled(false), false)
  assert.equal(isStoryboardV2ProductionEnabled(), false)
})
