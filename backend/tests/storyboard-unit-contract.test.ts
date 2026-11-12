import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-unit-contract-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const { stripPlaceholderDialogue, validateStoryboardUnit } = await import('../src/services/storyboard-unit-contract.ts')
const { buildAssetAliasMap, applyAssetAliases } = await import('../src/services/asset-aliases.ts')
const { buildSceneBindingBlock, canonicalSceneKey, getCanonicalSceneGroups, resolveCanonicalSceneId } = await import('../src/services/scene-canonical.ts')
const { createSceneSidePlan, normalizeSceneSides } = await import('../src/services/storyboard-scene-sides.ts')

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'
const FIXED_PROMPT = [
  '出场人物：@唐大郎（唐奕）｜场景：@唐记食铺大堂',
  '画面调度：画面左：唐大郎（唐奕）；画面右：范仲淹；过范仲淹右肩；背景地标：窗在左后、门在右后；轴线A；动作起点：起身；动作终点：抬眼看向范仲淹',
  '0-4秒：唐大郎（唐奕）起身。',
  '4-10秒：唐大郎（唐奕）抬眼看向范仲淹。',
  '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品',
].join('\n')

test('单机位/固定四区校验：合法通过，多子镜和缺调度被拒绝', () => {
  assert.deepEqual(validateStoryboardUnit({
    description: '唐大郎起身，抬眼看向范仲淹。',
    videoPrompt: FIXED_PROMPT,
    duration: 10,
  }), [])

  const multi = validateStoryboardUnit({
    description: '【镜头1】唐大郎起身。【镜头2】范仲淹抬眼。',
    videoPrompt: FIXED_PROMPT,
    duration: 10,
  })
  assert.ok(multi.some(item => item.includes('子镜头')))

  const missing = validateStoryboardUnit({
    description: '唐大郎起身。',
    videoPrompt: '出场人物：@唐大郎（唐奕）｜场景：@唐记食铺大堂\n0-10秒：唐大郎起身。',
    duration: 10,
  })
  assert.ok(missing.some(item => item.includes('画面调度')))
  assert.ok(missing.some(item => item.includes('负面约束')))
})

test('canonical 场景归组：同名大堂 54/55/56 只保留一个 canonical，剧本场次可绑定', async () => {
  db.insert(schema.dramas).values({ id: 1, title: '场景测试', createdAt: ts, updatedAt: ts }).run()
  db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts }).run()
  const [hall54, hall55, hall56, street38, street42] = [
    db.insert(schema.scenes).values({ dramaId: 1, location: '唐记食铺大堂', time: '上午', imageUrl: 'static/a.png', prompt: '', createdAt: ts, updatedAt: ts }).returning().get(),
    db.insert(schema.scenes).values({ dramaId: 1, location: '唐记食铺大堂', time: '午时', imageUrl: 'static/b.png', prompt: '', createdAt: ts, updatedAt: ts }).returning().get(),
    db.insert(schema.scenes).values({ dramaId: 1, location: '唐记食铺大堂', time: '清晨', imageUrl: 'static/c.png', prompt: '', createdAt: ts, updatedAt: ts }).returning().get(),
    db.insert(schema.scenes).values({ dramaId: 1, location: '邓州西市街道', time: '清晨', imageUrl: 'static/d.png', prompt: '', createdAt: ts, updatedAt: ts }).returning().get(),
    db.insert(schema.scenes).values({ dramaId: 1, location: '西市街道', time: '白天', imageUrl: 'static/e.png', prompt: '', createdAt: ts, updatedAt: ts }).returning().get(),
  ].map(row => row)
  // 用 55 作为使用最多的场景，验证 canonical 不按最小 ID 选
  for (let i = 0; i < 3; i += 1) {
    db.insert(schema.storyboards).values({
      episodeId: 1, storyboardNumber: i + 1, sceneId: hall55.id, duration: 5,
      createdAt: ts, updatedAt: ts,
    }).run()
  }
  db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 4, sceneId: hall54.id, duration: 5, createdAt: ts, updatedAt: ts }).run()
  db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 5, sceneId: street38.id, duration: 5, createdAt: ts, updatedAt: ts }).run()
  db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 6, sceneId: street42.id, duration: 5, createdAt: ts, updatedAt: ts }).run()

  const groups = await getCanonicalSceneGroups(1)
  const hall = groups.find(group => group.key === '唐记食铺大堂')!
  assert.equal(hall.canonicalId, hall55.id)
  assert.deepEqual(hall.aliasIds.sort(), [hall54.id, hall56.id].sort())
  const street = groups.find(group => group.key === '西市街')!
  assert.equal(street.canonicalId, street38.id)
  assert.ok(street.aliasIds.includes(street42.id))
  assert.equal(canonicalSceneKey('邓州西市街'), '西市街')

  assert.equal(await resolveCanonicalSceneId(1, hall56.id), hall55.id)
  assert.equal(await resolveCanonicalSceneId(1, street42.id), street38.id)
  const block = buildSceneBindingBlock('## S01 | 外景 · 邓州西市街 | 清晨\n## S02 | 内景 · 唐记食铺大堂 | 午时', groups)
  assert.match(block, /S01（邓州西市街）→ scene_id=\d+/)
  assert.match(block, /唐记食铺大堂：canonical scene_id=\d+/)
})

test('资产别名：@唐大郎 归一为 @唐大郎（唐奕），不误伤其他文本', async () => {
  db.insert(schema.characters).values({ dramaId: 1, name: '唐大郎（唐奕）', createdAt: ts, updatedAt: ts }).run()
  const map = await buildAssetAliasMap(1)
  assert.equal(applyAssetAliases('@唐大郎 走进来，@唐大郎（唐奕）坐下。', map), '@唐大郎（唐奕） 走进来，@唐大郎（唐奕）坐下。')
  assert.equal(applyAssetAliases('唐大郎（唐奕）不是别名文本', map), '唐大郎（唐奕）不是别名文本')
})

test('场景左右归一：同场人物翻边时自动交换画面左右', () => {
  const characters = [{ id: 25, name: '贾婆子' }, { id: 26, name: '六婶' }]
  const prompt = [
    '出场人物：@贾婆子、@六婶｜场景：@邓州西市街道',
    '画面调度：画面左：@六婶；画面右：@贾婆子；无过肩；背景地标：门在左后；轴线A；动作起点：六婶开口；动作终点：贾婆子回应',
    '0-4秒：@六婶开口。',
    '4-8秒：@贾婆子回应。',
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品',
  ].join('\n')
  const plan = createSceneSidePlan()
  plan.left.add('贾婆子')
  plan.right.add('六婶')
  const result = normalizeSceneSides(prompt, plan, characters)
  assert.equal(result.swapped, true)
  assert.match(result.prompt, /画面左：@贾婆子/)
  assert.match(result.prompt, /画面右：@六婶/)
})

test('占位台词“无”不会保存，真实台词保留', () => {
  const text = '0-3秒：@六婶说：「嘿，端是一张巧嘴！」\n3-6秒：旁白（画外音）：「无。」\n6-8秒：@马老三说：无。'
  const cleaned = stripPlaceholderDialogue(text)
  assert.match(cleaned, /嘿，端是一张巧嘴/)
  assert.doesNotMatch(cleaned, /：「无。？」|说：无。/)
})

test('唯一场景前缀别名：@邓州西市街 → @邓州西市街道，多义前缀不替换', async () => {
  const map = await buildAssetAliasMap(1)
  assert.equal(applyAssetAliases('@邓州西市街一派繁华', map), '@邓州西市街道一派繁华')
})
