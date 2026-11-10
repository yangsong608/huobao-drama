import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-audit-policy-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const schema = await import('../src/db/schema.ts')
const settings = await import('../src/services/app-settings.ts')

after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(root, { recursive: true, force: true })
})

test('未设置时返回默认策略：五项检查与语义/自动修复默认开启', () => {
  const policy = settings.getStoryboardAuditPolicy()
  assert.deepEqual(policy, settings.STORYBOARD_AUDIT_POLICY_DEFAULTS)
  assert.equal(policy.checks.shot, true)
  assert.equal(policy.checks.continuity, true)
  assert.equal(policy.checks.silent, true)
  assert.equal(policy.checks.lineDuration, true)
  assert.equal(policy.checks.assets, true)
  assert.equal(policy.semantic.enabled, true)
  assert.equal(policy.autoRepair.enabled, true)
  assert.equal(policy.autoRepair.semanticFix, true)
  assert.equal(policy.autoRepair.autoInsertTransition, true)
})

test('部分更新只覆盖传入字段并钳制非法值', () => {
  const saved = settings.setStoryboardAuditPolicy({
    checks: { silent: false, assets: false },
    thresholds: {
      charsPerSecond: 100,
      lineRequiredMaxSeconds: 2,
      silentCharacterWarnSeconds: 20,
      silentCharacterErrorSeconds: 10,
    },
    semantic: { windowSize: 8, windowStep: 99, maxWindows: 500 },
    autoRepair: { maxActions: 0, maxActionsPerShot: 99, maxInsertedTransitions: 0 },
  })
  assert.equal(saved.checks.silent, false)
  assert.equal(saved.checks.assets, false)
  assert.equal(saved.checks.shot, true)
  assert.equal(saved.thresholds.charsPerSecond, 12)
  assert.equal(saved.thresholds.lineRequiredMaxSeconds, 3)
  assert.equal(saved.thresholds.silentCharacterWarnSeconds, 20)
  assert.equal(saved.thresholds.silentCharacterErrorSeconds, 20)
  assert.equal(saved.semantic.windowSize, 8)
  assert.equal(saved.semantic.windowStep, 8)
  assert.equal(saved.semantic.maxWindows, 60)
  assert.equal(saved.autoRepair.maxActions, 1)
  assert.equal(saved.autoRepair.maxActionsPerShot, 10)
  assert.equal(saved.autoRepair.maxInsertedTransitions, 1)
})

test('策略落库为 app_settings 单键 JSON，可重复读取', () => {
  settings.setStoryboardAuditPolicy({ semantic: { enabled: false }, autoRepair: { enabled: false } })
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, 'storyboard_audit.policy'))
    .get()
  assert.ok(row)
  const parsed = JSON.parse(row.value)
  assert.equal(parsed.semantic.enabled, false)
  assert.equal(parsed.autoRepair.enabled, false)
  const reread = settings.getStoryboardAuditPolicy()
  assert.equal(reread.semantic.enabled, false)
  assert.equal(reread.autoRepair.enabled, false)
  assert.equal(reread.checks.silent, false)
})

test('损坏的 JSON 回退默认策略', () => {
  db.insert(schema.appSettings)
    .values({ key: 'storyboard_audit.policy', value: '{bad json', updatedAt: '2026-01-01' })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: '{bad json', updatedAt: '2026-01-01' },
    })
    .run()
  assert.deepEqual(settings.getStoryboardAuditPolicy(), settings.STORYBOARD_AUDIT_POLICY_DEFAULTS)
})

test('规则层可读取策略开关与阈值，窗口大小可配置', () => {
  const rules = settings.storyboardAuditRuleOptions(settings.STORYBOARD_AUDIT_POLICY_DEFAULTS)
  assert.equal(rules.checks.shot, true)
  assert.equal(rules.thresholds.charsPerSecond, 4)
  assert.equal(rules.windows.size, 16)
  const patched = settings.sanitizeStoryboardAuditPolicy({
    checks: { shot: false },
    thresholds: { charsPerSecond: 6 },
    semantic: { windowSize: 4, windowStep: 3, maxWindows: 2 },
  })
  const options = settings.storyboardAuditRuleOptions(patched)
  assert.equal(options.checks.shot, false)
  assert.equal(options.thresholds.charsPerSecond, 6)
  assert.equal(options.windows.size, 4)
  assert.equal(options.windows.step, 3)
  assert.equal(options.windows.maxWindows, 2)
})

test('设置接口读写检验策略', async () => {
  const { Hono } = await import('hono')
  const settingsRoutes = await import('../src/routes/settings.ts')
  const api = new Hono()
  api.route('/settings', settingsRoutes.default)

  const before = await api.request('/settings/storyboard-audit')
  assert.equal(before.status, 200)
  const beforeBody = await before.json() as any
  assert.equal(beforeBody.data.policy.autoRepair.autoInsertTransition, true)

  const put = await api.request('/settings/storyboard-audit', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      checks: { continuity: false },
      autoRepair: { autoInsertTransition: false, maxInsertedTransitions: 2 },
    }),
  })
  assert.equal(put.status, 200)
  const putBody = await put.json() as any
  assert.equal(putBody.data.policy.checks.continuity, false)
  assert.equal(putBody.data.policy.autoRepair.autoInsertTransition, false)
  assert.equal(putBody.data.policy.autoRepair.maxInsertedTransitions, 2)

  const bad = await api.request('/settings/storyboard-audit', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([]),
  })
  assert.equal(bad.status, 400)
})
