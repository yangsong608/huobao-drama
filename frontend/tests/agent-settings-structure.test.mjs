/**
 * A0-3：设置页智能体中心骨架
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

const settings = read('app/pages/settings.vue')
const api = read('app/composables/useApi.ts')

function arrayLiteral(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))
  assert.ok(match, `missing ${name}`)
  return [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1])
}

test('设置页仍为 11 个页签，不新增第 12 个页签', () => {
  const tabs = arrayLiteral(settings, 'SETTINGS_TABS')
  assert.equal(tabs.length, 11)
  assert.ok(tabs.includes('agents'))
  assert.ok(!tabs.includes('agent'))
  const baseBlock = settings.match(/const baseTabs = computed\(\(\) => \[([\s\S]*?)\]\)/)
  assert.ok(baseBlock)
  assert.equal((baseBlock[1].match(/\{ id: '/g) ?? []).length, 11)
})

test('智能体中心固定八个子区', () => {
  assert.deepEqual(arrayLiteral(settings, 'AGENT_CENTER_SECTIONS'), [
    'overview', 'pages', 'production', 'presets', 'tools', 'models', 'sessions', 'diagnostics',
  ])
  assert.match(settings, /class="agent-center"/)
  assert.match(settings, /class="agent-center-nav"/)
  for (const section of ['overview', 'pages', 'production', 'presets', 'tools', 'models', 'sessions', 'diagnostics']) {
    assert.ok(settings.includes(`settings.agentCenter.sections.${section}`) || settings.includes('settings.agentCenter.sections.${id}'), `missing nav for ${section}`)
  }
})

test('生产智能体 5 个且补上 voice_designer，预设 2 个', () => {
  assert.deepEqual(arrayLiteral(settings, 'PRODUCTION_AGENT_TYPES'), [
    'script_rewriter', 'extractor', 'storyboard_breaker', 'prompt_generator', 'voice_designer',
  ])
  assert.deepEqual(arrayLiteral(settings, 'PRESET_AGENT_TYPES'), ['assistant', 'director'])
  assert.match(settings, /type: 'voice_designer'/)
  assert.match(settings, /type: 'assistant'/)
  assert.match(settings, /type: 'director'/)
  // 预设不进入生产分组
  const productionBlock = settings.match(/const productionAgentDefs = computed\(\(\) => \[([\s\S]*?)\]\)/)
  assert.ok(productionBlock)
  assert.doesNotMatch(productionBlock[1], /type: 'assistant'/)
  assert.doesNotMatch(productionBlock[1], /type: 'director'/)
})

test('总览开关覆盖六项并保存到 /settings/agent', () => {
  for (const key of ['dock', 'director', 'stream', 'proposals', 'suggestions', 'autoDetect']) {
    assert.ok(settings.includes(`key: '${key}'`), `missing switch ${key}`)
  }
  assert.match(settings, /settingsAPI\.saveAgent\(\{/)
  assert.match(settings, /applyAgentSettings\(res\.settings\)/)
  assert.match(settings, /agentForcedKeys\.value = forced\.map/)
  assert.match(settings, /agentForcedFlags\.value = forced\.map/)
  assert.match(settings, /:disabled="agentForcedKeys\.includes\(item\.key\)"/)
  assert.match(api, /agent: \(\) => api\.get<\{ settings: AgentSettings \}>\('\/settings\/agent'\)/)
  assert.match(api, /saveAgent: \(patch: Partial<AgentSettings>\) => api\.put<\{ settings: AgentSettings \}>\('\/settings\/agent', patch\)/)
})

test('模型字段只在中文提示词下显示与提交', () => {
  assert.match(settings, /v-if="agentCenterSection === 'production' && editLang === 'zh'"/)
  assert.match(settings, /v-model="agentForm\.model"/)
  assert.match(settings, /if \(editLang\.value === 'zh' && PRODUCTION_AGENT_TYPES\.includes\(type\)\) payload\.model = agentForm\.model/)
  assert.match(settings, /if \(editLang\.value !== 'zh'\) return/)
  assert.doesNotMatch(settings, /payload\.model = .*\n.*payload\.model = /)
})

test('页面绑定、工具、会话、诊断先提供骨架与空态', () => {
  assert.match(settings, /settings\.agentCenter\.pages\.source/)
  assert.match(settings, /settings\.agentCenter\.futureTitle/)
  assert.match(settings, /v-if="agentCenterSection === 'models'"/)
  assert.match(settings, /settings\.agentCenter\.models\.nonZhTitle/)
  assert.match(settings, /t\(`settings\.agentCenter\.\$\{agentCenterSection\.value\}\.title`\)/)
  assert.match(settings, /t\(`settings\.agentCenter\.\$\{agentCenterSection\.value\}\.desc`\)/)
  assert.match(settings, /t\(`settings\.agentCenter\.\$\{agentCenterSection\.value\}\.source`\)/)
})

test('设置页不注册页面适配器、不显示悬浮入口', () => {
  assert.doesNotMatch(settings, /useAgentPageAdapter\(\{/)
  assert.doesNotMatch(settings, /AgentDock/)
})

test('四语文案同键且子区齐全', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map((lang) => JSON.parse(read(`app/locales/${lang}.json`)))
  const sections = ['overview', 'pages', 'production', 'presets', 'tools', 'models', 'sessions', 'diagnostics']
  for (const locale of locales) {
    const center = locale.settings.agentCenter
    assert.ok(center, 'missing settings.agentCenter')
    for (const section of sections) {
      assert.ok(center.sections[section], `missing sections.${section}`)
      assert.ok(center[section]?.title, `missing ${section}.title`)
      assert.ok(center[section]?.desc, `missing ${section}.desc`)
    }
    assert.ok(locale.settings.agents.voiceDesigner)
    assert.ok(locale.settings.agents.presetAssistant)
    assert.ok(locale.settings.agents.presetDirector)
  }
})
