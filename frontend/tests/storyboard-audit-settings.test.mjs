import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const settings = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const locales = ['zh', 'en', 'ja', 'ko'].map(lang => [
  lang,
  JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')),
])

test('设置页注册「分镜检验」页签并懒加载策略', () => {
  assert.match(settings, /const SETTINGS_TABS = \[[^\]]*'audit'/)
  assert.match(settings, /id="settings-panel-audit"/)
  assert.match(settings, /:id="`settings-tab-\$\{nt\.id\}`"/)
  assert.match(settings, /:aria-controls="`settings-panel-\$\{nt\.id\}`"/)
  assert.match(settings, /id: 'audit', label: t\('settings\.tabs\.audit'\)/)
  assert.match(settings, /if \(tab\.value === 'audit'\) loadAuditPolicy\(\)/)
  assert.match(settings, /if \(t === 'audit'\) loadAuditPolicy\(\)/)
})

test('设置页提供五项检查、阈值、语义窗口与自动修复配置', () => {
  const binds = [
    'checks.shot',
    'checks.continuity',
    'checks.silent',
    'checks.lineDuration',
    'checks.assets',
    'thresholds.charsPerSecond',
    'thresholds.lineBreathSeconds',
    'thresholds.lineRequiredMaxSeconds',
    'thresholds.silentCharacterWarnSeconds',
    'thresholds.silentCharacterErrorSeconds',
    'thresholds.emptyShotWarnSeconds',
    'thresholds.promptSegmentMaxChars',
    'semantic.enabled',
    'semantic.windowSize',
    'semantic.windowStep',
    'semantic.maxWindows',
    'autoRepair.enabled',
    'autoRepair.semanticFix',
    'autoRepair.autoInsertTransition',
    'autoRepair.maxInsertedTransitions',
    'autoRepair.maxActions',
    'autoRepair.maxActionsPerShot',
  ]
  for (const path of binds) {
    const escaped = path.replaceAll('.', '\\.')
    assert.match(settings, new RegExp(`v-model(?:\\.number)?="auditPolicy\\.${escaped}"`), `缺少策略绑定 ${path}`)
  }
  assert.match(settings, /settingsAPI\.storyboardAudit\(\)/)
  assert.match(settings, /settingsAPI\.saveStoryboardAudit\(auditPolicy\.value\)/)
  assert.match(settings, /settings\.audit\.saved/)
})

test('检验提示词入口跳转 storyboard_auditor 的 Agent 配置', () => {
  assert.match(settings, /function openAuditorAgent\(\)/)
  assert.match(settings, /selectAgent\('storyboard_auditor'\)/)
  assert.match(settings, /settings\.audit\.promptOpen/)
  assert.match(settings, /settings\.audit\.promptDesc/)
  assert.match(settings, /type: 'storyboard_auditor', label: t\('settings\.agents\.storyboardAuditor'\)/)
})

test('策略接口集中于 settingsAPI 并复用 /settings/storyboard-audit', () => {
  assert.match(api, /storyboardAudit: \(\) => api\.get<\{ policy: StoryboardAuditPolicy \}>\('\/settings\/storyboard-audit'\)/)
  assert.match(api, /saveStoryboardAudit: \(policy: StoryboardAuditPolicy\) => api\.put<\{ policy: StoryboardAuditPolicy \}>\('\/settings\/storyboard-audit', policy\)/)
  assert.match(api, /export interface StoryboardAuditPolicy/)
})

test('四语言补齐分镜检验设置文案', () => {
  for (const [lang, bundle] of locales) {
    const audit = bundle?.settings?.audit
    assert.ok(audit, `${lang} 缺少 settings.audit`)
    for (const key of [
      'title', 'subtitle', 'checks', 'checksHint', 'thresholds', 'thresholdHint',
      'semantic', 'semanticHint', 'autoRepair', 'autoRepairHint', 'enable',
      'promptTitle', 'promptDesc', 'promptOpen', 'save', 'saving', 'saved', 'loadFailed',
    ]) {
      assert.equal(typeof audit?.[key], 'string', `${lang} 缺少 settings.audit.${key}`)
    }
    for (const check of ['shot', 'continuity', 'silent', 'lineDuration', 'assets']) {
      assert.equal(typeof audit?.check?.[check], 'string', `${lang} 缺少 settings.audit.check.${check}`)
    }
    for (const key of [
      'charsPerSecond', 'lineBreathSeconds', 'lineRequiredMaxSeconds',
      'silentCharacterWarnSeconds', 'silentCharacterErrorSeconds',
      'emptyShotWarnSeconds', 'promptSegmentMaxChars',
    ]) {
      assert.equal(typeof audit?.threshold?.[key], 'string', `${lang} 缺少 settings.audit.threshold.${key}`)
    }
    for (const key of ['windowSize', 'windowStep', 'maxWindows']) {
      assert.equal(typeof audit?.semanticLabel?.[key], 'string', `${lang} 缺少 settings.audit.semanticLabel.${key}`)
    }
    for (const key of [
      'semanticFix', 'autoInsertTransition', 'maxInsertedTransitions',
      'maxActions', 'maxActionsPerShot',
    ]) {
      assert.equal(typeof audit?.repairLabel?.[key], 'string', `${lang} 缺少 settings.audit.repairLabel.${key}`)
    }
    assert.equal(typeof bundle?.settings?.tabs?.audit, 'string', `${lang} 缺少 settings.tabs.audit`)
    assert.equal(typeof bundle?.settings?.agents?.storyboardAuditor, 'string', `${lang} 缺少 settings.agents.storyboardAuditor`)
  }
})
