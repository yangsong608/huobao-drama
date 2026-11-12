import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-visual-reports-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const preflight = await import('../src/services/storyboard-visual-preflight.ts')
const acceptance = await import('../src/services/storyboard-acceptance.ts')

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'

function seed() {
  const drama = db.insert(schema.dramas).values({ title: '验收测试', createdAt: ts, updatedAt: ts }).returning().get()
  const episode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const sb = db.insert(schema.storyboards).values({
    episodeId: episode.id, storyboardNumber: 1, duration: 5, videoPrompt: '出场人物：无｜场景：未指定',
    videoUrl: 'static/videos/shot-1.mp4', contractVersion: 1, createdAt: ts, updatedAt: ts,
  }).returning().get()
  return { drama, episode, sb }
}

test('视觉预检报告：合同变动后旧报告标记 stale', async () => {
  const { episode, sb } = seed()
  const fingerprint = await preflight.currentPreflightFingerprint(sb.id)
  db.insert(schema.visualPreflightReports).values({
    episodeId: episode.id,
    storyboardId: sb.id,
    contractVersion: 1,
    promptHash: fingerprint,
    verdict: 'warn',
    checksJson: '[]',
    issuesJson: '[]',
    evidenceJson: '[]',
    createdAt: ts,
  }).run()

  const fresh = await preflight.getPreflightState(sb.id)
  assert.equal(fresh.report?.verdict, 'warn')
  assert.equal(fresh.stale, false)

  db.update(schema.storyboards).set({ videoPrompt: '出场人物：无｜场景：未指定\n画面调度：动作起点：起身', updatedAt: ts }).where(eq(schema.storyboards.id, sb.id)).run()
  const stale = await preflight.getPreflightState(sb.id)
  assert.equal(stale.stale, true)
})

test('生成后验收：新鲜 fail 阻断装配，视频更换后旧报告不再阻断', async () => {
  const { episode, sb } = seed()
  fs.mkdirSync(path.join(serviceRoot, 'static', 'videos'), { recursive: true })
  fs.writeFileSync(path.join(serviceRoot, 'static', 'videos', 'shot-1.mp4'), 'fake-video')
  const fingerprint = acceptance.videoFingerprint('static/videos/shot-1.mp4')
  db.insert(schema.acceptanceReports).values({
    episodeId: episode.id,
    storyboardId: sb.id,
    videoUrl: 'static/videos/shot-1.mp4',
    videoFingerprint: fingerprint,
    contractVersion: 1,
    verdict: 'fail',
    checksJson: '[]',
    issuesJson: '[]',
    evidenceJson: '[]',
    createdAt: ts,
  }).run()

  const gate = await acceptance.evaluateEpisodeAcceptanceGate(episode.id)
  assert.equal(gate.allowed, false)
  assert.ok(gate.blockers.some(item => item.code === 'acceptance_failed'))

  fs.writeFileSync(path.join(serviceRoot, 'static', 'videos', 'shot-2.mp4'), 'new-video')
  db.update(schema.storyboards).set({ videoUrl: 'static/videos/shot-2.mp4', updatedAt: ts }).where(eq(schema.storyboards.id, sb.id)).run()
  const staleGate = await acceptance.evaluateEpisodeAcceptanceGate(episode.id)
  assert.equal(staleGate.allowed, true)
  assert.ok(staleGate.warnings.some(item => item.code === 'acceptance_stale'))
})

test('生成后验收：缺报告只警告，不阻断旧数据装配', async () => {
  const { episode } = seed()
  const gate = await acceptance.evaluateEpisodeAcceptanceGate(episode.id)
  assert.equal(gate.allowed, true)
  assert.ok(gate.warnings.some(item => item.code === 'acceptance_missing'))
})

test('生成门禁：新鲜 block 预检阻断，过期预检不阻断', async () => {
  const gateService = await import('../src/services/storyboard-generation-gate.ts')
  const { episode, sb } = seed()
  const fingerprint = await preflight.currentPreflightFingerprint(sb.id)
  db.insert(schema.visualPreflightReports).values({
    episodeId: episode.id,
    storyboardId: sb.id,
    contractVersion: 1,
    promptHash: fingerprint,
    verdict: 'block',
    checksJson: '[]',
    issuesJson: JSON.stringify([{ code: 'preflight_axis', severity: 'error', message: '轴线冲突' }]),
    evidenceJson: '[]',
    createdAt: ts,
  }).run()
  const blocked = await gateService.evaluateStoryboardGenerationGate(episode.id, sb.id)
  assert.equal(blocked.allowed, false)
  assert.ok(blocked.blockers.some(item => item.code === 'preflight_blocked'))

  db.update(schema.storyboards).set({ videoPrompt: '出场人物：无｜场景：未指定\n画面调度：动作起点：起身', updatedAt: ts }).where(eq(schema.storyboards.id, sb.id)).run()
  const stale = await gateService.evaluateStoryboardGenerationGate(episode.id, sb.id)
  assert.equal(stale.allowed, true)
  assert.ok(stale.warnings.some(item => item.code === 'preflight_stale'))
})

test('视觉预检：没有参考图时降级为 warn，不调用模型', async () => {
  const { sb } = seed()
  const report = await preflight.runVisualPreflight(sb.id)
  assert.equal(report.verdict, 'warn')
  assert.ok(report.issues.some(issue => issue.code === 'preflight_no_reference'))
  assert.ok(report.checks.every(check => check.verdict === 'skipped'))
})
