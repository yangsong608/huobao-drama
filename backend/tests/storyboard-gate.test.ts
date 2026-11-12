import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-gate-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const contractAudit = await import('../src/services/storyboard-contract-audit.ts')
const gate = await import('../src/services/storyboard-generation-gate.ts')
const planning = await import('../src/services/scene-planning.ts')
const storyboardRoutes = await import('../src/routes/storyboards.ts')

const api = new Hono()
api.route('/storyboards', storyboardRoutes.default)

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'

function pairShot(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    storyboardNumber: 1,
    sceneId: 10,
    coverageType: 'single',
    axisSide: 'A',
    screenLeft: [] as string[],
    screenRight: [] as string[],
    foregroundShoulder: null as string | null,
    castOnScreen: [] as number[],
    backgroundLandmarks: [] as Array<{ name: string; side: string }>,
    sceneGeographyId: null as number | null,
    contractVersion: 1,
    ...overrides,
  }
}

function seed() {
  const drama = db.insert(schema.dramas).values({ title: '门禁测试', createdAt: ts, updatedAt: ts }).returning().get()
  const episode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const scene = db.insert(schema.scenes).values({
    dramaId: drama.id, location: '小饭馆', time: '日', prompt: '内景', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const shot = db.insert(schema.storyboards).values({
    episodeId: episode.id, storyboardNumber: 1, sceneId: scene.id, title: '门禁镜', duration: 10,
    videoPrompt: '出场人物：@甲｜场景：@小饭馆\n0-10秒：@甲站着。', createdAt: ts, updatedAt: ts,
  }).returning().get()
  return { drama, episode, scene, shot }
}

function saveAuditJob(episodeId: number, dramaId: number, issues: any[]) {
  return db.insert(schema.storyboardAuditJobs).values({
    episodeId,
    dramaId,
    trigger: 'manual',
    status: 'done',
    totalShots: 1,
    totalWindows: 0,
    completedWindows: 0,
    issueCount: issues.length,
    errorCount: issues.filter(issue => issue.severity === 'error').length,
    warningCount: issues.filter(issue => issue.severity === 'warning').length,
    infoCount: 0,
    repairableCount: 0,
    fixedCount: 0,
    manualCount: 0,
    issuesJson: JSON.stringify(issues),
    windowsJson: '[]',
    shotStatusJson: '{}',
    semanticStatus: 'done',
    repairStatus: 'none',
    policyJson: '{}',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
}

test('合同成对检查：屏幕左右翻转、轴线交叉、场景地理不一致、过肩缺失、人物换人', () => {
  const from = pairShot({
    id: 1,
    storyboardNumber: 1,
    coverageType: 'single',
    axisSide: 'A',
    screenLeft: ['唐奕'],
    screenRight: ['范仲淹'],
    castOnScreen: [24],
    sceneGeographyId: 1,
  })
  const to = pairShot({
    id: 2,
    storyboardNumber: 2,
    coverageType: 'ots',
    axisSide: 'B',
    screenLeft: ['范仲淹'],
    screenRight: ['唐奕'],
    foregroundShoulder: null,
    castOnScreen: [39, 40],
    sceneGeographyId: 2,
  })
  const codes = contractAudit.evaluateContractPairIssues(from as any, to as any).map(issue => issue.code)
  assert.ok(codes.includes('screen_direction_flip'))
  assert.ok(codes.includes('axis_cross'))
  assert.ok(codes.includes('scene_geography_mismatch'))
  assert.ok(codes.includes('foreground_shoulder_missing'))

  const mirrored = contractAudit.evaluateContractPairIssues(
    pairShot({ backgroundLandmarks: [{ name: '窗', side: 'left' }] }) as any,
    pairShot({ id: 3, storyboardNumber: 3, backgroundLandmarks: [{ name: '窗', side: 'right' }] }) as any,
  ).map(issue => issue.code)
  assert.ok(mirrored.includes('set_mirror'))

  const castBreak = contractAudit.evaluateContractPairIssues(
    pairShot({ id: 3, storyboardNumber: 3, coverageType: 'single', castOnScreen: [24] }) as any,
    pairShot({ id: 4, storyboardNumber: 4, coverageType: 'two_shot', castOnScreen: [39, 40] }) as any,
  ).map(issue => issue.code)
  assert.ok(castBreak.includes('cast_presence_break'))
})

test('合同成对检查：同侧、同轴线、有前景肩时不误报', () => {
  const from = pairShot({ screenLeft: ['唐奕'], screenRight: ['范仲淹'], axisSide: 'A', sceneGeographyId: 1 })
  const to = pairShot({
    id: 2,
    storyboardNumber: 2,
    coverageType: 'ots',
    screenLeft: ['唐奕'],
    screenRight: ['范仲淹'],
    foregroundShoulder: '范仲淹右肩',
    axisSide: 'A',
    sceneGeographyId: 1,
    castOnScreen: [24],
  })
  const codes = contractAudit.evaluateContractPairIssues(from as any, to as any).map(issue => issue.code)
  assert.ok(!codes.includes('screen_direction_flip'))
  assert.ok(!codes.includes('axis_cross'))
  assert.ok(!codes.includes('scene_geography_mismatch'))
  assert.ok(!codes.includes('foreground_shoulder_missing'))
})

test('生成门禁：最新审计 error 阻断，warning 只提醒；合同缺失与覆盖缺口给警告', async () => {
  const { episode, drama, scene, shot } = seed()
  saveAuditJob(episode.id, drama.id, [
    {
      id: 'ISSUE-1', check: 2, severity: 'error', code: 'screen_direction_flip',
      storyboardId: shot.id, storyboardNumber: 1, message: '屏幕左右翻转', status: 'open',
    },
    {
      id: 'ISSUE-2', check: 1, severity: 'warning', code: 'prompt_blocking_missing',
      storyboardId: shot.id, storyboardNumber: 1, message: '缺画面调度', status: 'open',
    },
  ])
  await planning.saveCoveragePlan(episode.id, scene.id, {
    units: [],
    summary: { gaps: ['missing_establishing', 'missing_reaction'] },
    status: 'derived',
  })
  const blocked = await gate.evaluateStoryboardGenerationGate(episode.id, shot.id)
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.blockers.some(issue => issue.code === 'screen_direction_flip'))
  assert.ok(blocked.warnings.some(issue => issue.code === 'prompt_blocking_missing'))
  assert.ok(blocked.warnings.some(issue => issue.code === 'contract_missing'))
  assert.ok(blocked.warnings.some(issue => issue.code === 'coverage_gap'))

  db.update(schema.storyboardAuditJobs).set({
    issuesJson: JSON.stringify([]),
    errorCount: 0,
    warningCount: 0,
  }).run()
  const allowed = await gate.evaluateStoryboardGenerationGate(episode.id, shot.id)
  assert.equal(allowed.allowed, true)
})

test('生成门禁 API：返回 allowed/blockers/warnings', async () => {
  const { episode, drama, shot } = seed()
  saveAuditJob(episode.id, drama.id, [{
    id: 'ISSUE-1', check: 2, severity: 'error', code: 'axis_cross',
    storyboardId: shot.id, storyboardNumber: 1, message: '轴线交叉', status: 'open',
  }])
  const response = await api.request(`/storyboards/${shot.id}/generation-gate`, { method: 'GET' })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.data.allowed, false)
  assert.ok(body.data.blockers.some((issue: any) => issue.code === 'axis_cross'))
})

test('合同成对问题码已在规则码表登记，可被审计校验接受', async () => {
  const rules = await import('../src/services/storyboard-audit-rules.ts')
  for (const code of ['screen_direction_flip', 'set_mirror', 'axis_cross', 'scene_geography_mismatch', 'cast_presence_break', 'foreground_shoulder_missing', 'coverage_gap']) {
    const problems = rules.validateAuditIssueDraft({
      check: 2,
      source: 'rule',
      severity: 'warning',
      code,
      message: code,
      repairable: false,
      status: 'open',
    })
    assert.deepEqual(problems, [], `${code} 未登记或校验不通过：${problems.join('；')}`)
  }
})
