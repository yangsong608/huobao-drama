import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const settings = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')
const component = readFileSync(new URL('../app/components/PipelineChainSettings.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const locales = ['zh', 'en', 'ja', 'ko'].map(lang => [
  lang,
  JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')),
])

test('设置页注册「分镜流水线」页签，旧「分镜检验」页签下线', () => {
  assert.match(settings, /const SETTINGS_TABS = \[[^\]]*'pipeline'/)
  assert.doesNotMatch(settings, /const SETTINGS_TABS = \[[^\]]*'audit'/)
  assert.match(settings, /id="settings-panel-pipeline"/)
  assert.match(settings, /<PipelineChainSettings \/>/)
  assert.match(settings, /id: 'pipeline', label: t\('settings\.tabs\.pipeline'\), icon: ShieldCheck/)
  assert.doesNotMatch(settings, /id: 'audit', label: t\('settings\.tabs\.audit'\)/)
})

test('流水线组件提供模板、步骤开关、参数、规则包与知识绑定', () => {
  assert.match(component, /pipelineChainAPI\.chains\(/)
  assert.match(component, /pipelineChainAPI\.chain\(/)
  assert.match(component, /pipelineChainAPI\.rulePacks\(/)
  assert.match(component, /pipelineChainAPI\.saveOverrides\(/)
  assert.match(component, /templates/)
  assert.match(component, /stepToggles/)
  assert.match(component, /params\[param\.key\]/)
  assert.match(component, /knowledgeRefs/)
  assert.match(component, /step\.required/)
  assert.match(component, /step\.available/)
})

test('导演加入 Agent 配置，旧拆解 Agent 不再出现在活跃列表', () => {
  assert.match(settings, /type: 'storyboard_director', label: t\('settings\.agents\.storyboardDirector'\)/)
  assert.doesNotMatch(settings, /type: 'storyboard_breaker', label: t\('settings\.agents\.storyboardBreaker'\)/)
  assert.match(settings, /CRITICAL_KNOWLEDGE_AGENTS = new Set\(\['storyboard_director'/)
})

test('流水线接口集中在 pipelineChainAPI', () => {
  assert.match(api, /export const pipelineChainAPI = \{/)
  assert.match(api, /createRun: \(payload: \{/)
  assert.match(api, /trace: \(runId: number\) => api\.get\(`\/pipelines\/runs\/\$\{runId\}\/trace`\)/)
  assert.match(api, /saveOverrides: \(key: string, payload: \{/)
})

test('四语言补齐流水线页签与导演文案', () => {
  for (const [lang, bundle] of locales) {
    assert.equal(typeof bundle?.settings?.tabs?.pipeline, 'string', `${lang} 缺少 settings.tabs.pipeline`)
    assert.equal(typeof bundle?.settings?.agents?.storyboardDirector, 'string', `${lang} 缺少 settings.agents.storyboardDirector`)
  }
})
