import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-contract-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const contract = await import('../src/services/storyboard-contract.ts')

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'

const PROMPT = [
  '出场人物：@唐大郎（唐奕）、@范仲淹｜场景：@唐记食铺大堂',
  '画面调度：画面左：唐大郎（唐奕）；画面右：范仲淹；过范仲淹右肩；轴线A；窗在左后，门在右后；动作起点：张了张嘴；动作终点：抬眼看向范仲淹。',
  '0-5秒：@唐大郎（唐奕）张了张嘴，说不出话。',
  '5-10秒：@唐大郎（唐奕）抬眼看向@范仲淹。旁白（画外音）：「唐奕万万没想到」。',
  '负面约束：只出现画内人物；不换脸、不换装、不加人；不生成字幕。',
].join('\n')

test('合同解析：画内/画外人物、屏幕左右、过肩、时间帧、负面约束', () => {
  const parsed = contract.parseContractFromPrompt(PROMPT, [
    { id: 24, name: '唐大郎（唐奕）' },
    { id: 39, name: '范仲淹' },
    { id: 38, name: '孙郎中' },
  ], [24, 39, 38])

  assert.deepEqual(parsed.castOnScreen, [24, 39])
  assert.deepEqual(parsed.castOffScreen, [38])
  assert.deepEqual(parsed.screenLeft, ['唐大郎（唐奕）'])
  assert.deepEqual(parsed.screenRight, ['范仲淹'])
  assert.equal(parsed.foregroundShoulder, '范仲淹')
  assert.equal(parsed.axisSide, 'A')
  assert.deepEqual(parsed.backgroundLandmarks, [
    { name: '窗', side: 'left' },
    { name: '门', side: 'right' },
  ])
  assert.match(parsed.negativeConstraints || '', /只出现画内人物/)
  assert.equal(parsed.actionStart, '张了张嘴')
  assert.equal(parsed.actionEnd, '抬眼看向范仲淹')
  assert.equal(parsed.segments.length, 2)
  assert.equal(parsed.segments[0].start, 0)
  assert.equal(parsed.segments[0].end, 5)
  assert.equal(parsed.contractVersion, 1)
})

test('旧格式没有画面调度/负面约束也能解析画内人物和时间帧', () => {
  const parsed = contract.parseContractFromPrompt(
    '出场人物：@唐大郎（唐奕）｜场景：@唐记食铺大堂\n0-3秒：@唐大郎（唐奕）站着。',
    [{ id: 24, name: '唐大郎（唐奕）' }],
    [24],
  )
  assert.deepEqual(parsed.castOnScreen, [24])
  assert.deepEqual(parsed.screenLeft, [])
  assert.equal(parsed.foregroundShoulder, null)
  assert.equal(parsed.negativeConstraints, null)
  assert.equal(parsed.segments.length, 1)
  assert.equal(parsed.contractVersion, 0)
})

test('合同落库：sync 写入 JSON 字段，get 返回人物名和分段', async () => {
  const drama = db.insert(schema.dramas).values({
    title: '合同测试', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const episode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const [tang, fan, sun] = [
    db.insert(schema.characters).values({ dramaId: drama.id, name: '唐大郎（唐奕）', createdAt: ts, updatedAt: ts }).returning().get(),
    db.insert(schema.characters).values({ dramaId: drama.id, name: '范仲淹', createdAt: ts, updatedAt: ts }).returning().get(),
    db.insert(schema.characters).values({ dramaId: drama.id, name: '孙郎中', createdAt: ts, updatedAt: ts }).returning().get(),
  ]
  const sb = db.insert(schema.storyboards).values({
    episodeId: episode.id, storyboardNumber: 1, duration: 10,
    videoPrompt: PROMPT, createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.storyboardCharacters).values([
    { storyboardId: sb.id, characterId: tang.id },
    { storyboardId: sb.id, characterId: fan.id },
    { storyboardId: sb.id, characterId: sun.id },
  ]).run()

  await contract.syncStoryboardContract(sb.id)
  const [stored] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
  assert.equal(stored.contractVersion, 1)
  assert.deepEqual(JSON.parse(stored.castOnScreen || '[]'), [tang.id, fan.id])
  assert.deepEqual(JSON.parse(stored.castOffScreen || '[]'), [sun.id])
  assert.deepEqual(JSON.parse(stored.screenLeft || '[]'), ['唐大郎（唐奕）'])
  assert.deepEqual(JSON.parse(stored.screenRight || '[]'), ['范仲淹'])
  assert.equal(stored.foregroundShoulder, '范仲淹')
  assert.equal(stored.actionStart, '张了张嘴')
  assert.equal(stored.actionEnd, '抬眼看向范仲淹')
  assert.equal(JSON.parse(stored.segmentPlan || '[]').length, 2)

  const view = await contract.getStoryboardContract(sb.id)
  assert.equal(view?.contract_version, 1)
  assert.deepEqual(view?.cast_on_screen.map(item => item.name), ['唐大郎（唐奕）', '范仲淹'])
  assert.deepEqual(view?.cast_off_screen.map(item => item.name), ['孙郎中'])
  assert.equal(view?.segment_plan.length, 2)
})

test('动作匹配：同场直接切换只写了一端动作端点时告警', async () => {
  const audit = await import('../src/services/storyboard-contract-audit.ts')
  const base = {
    sceneId: 7,
    coverageType: 'single',
    axisSide: 'A',
    screenLeft: [],
    screenRight: [],
    foregroundShoulder: null,
    castOnScreen: [1],
    backgroundLandmarks: [],
    sceneGeographyId: 1,
    contractVersion: 1,
    transition: 'cut',
  }
  const from = { ...base, id: 1, storyboardNumber: 1, actionEnd: '抬眼看向范仲淹', actionStart: null }
  const to = { ...base, id: 2, storyboardNumber: 2, actionStart: null, actionEnd: null }
  const issues = audit.evaluateContractPairIssues(from, to)
  assert.ok(issues.some(issue => issue.code === 'action_match_missing'))

  const matched = audit.evaluateContractPairIssues(from, { ...to, actionStart: '接住范仲淹的目光' })
  assert.ok(!matched.some(issue => issue.code === 'action_match_missing'))
})
