/**
 * A3-3：页面绑定、工具权限、模型与预算设置结构
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

test('页面绑定支持编辑入口、默认预设、快捷问题、作用域与只读工具', () => {
  const source = read('app/pages/settings.vue')
  for (const token of [
    'binding.entries',
    'binding.defaultPreset',
    'binding.quickPromptsText',
    'binding.allowedScopes',
    'binding.allowedTools',
    'binding.scopesLimited',
    'binding.toolsLimited',
    'saveAgentBindings',
    'serializeAgentBindings',
    'canUseDirectorDefaultPreset',
    'duplicateBinding',
    'agentStageOptions',
    'agentScopeOptions',
  ]) {
    assert.ok(source.includes(token), `missing ${token}`)
  }
  assert.match(source, /settingsAPI\.saveAgent\(\{ pages: \{ version: 1, bindings: serializeAgentBindings\(\) \} \}\)/)
})

test('工具与权限为只读矩阵 + 白名单多选，不提供新增工具/类型入口', () => {
  const source = read('app/pages/settings.vue')
  for (const token of [
    'agentScopeMatrix',
    'AGENT_READ_TOOLS',
    'AGENT_PROPOSAL_TYPES',
    'AGENT_SUGGESTION_ACTIONS',
    'saveAgentPolicy',
    'scopeMatrix',
    'readTools',
    'policyTitle',
  ]) {
    assert.ok(source.includes(token), `missing ${token}`)
  }
  assert.doesNotMatch(source, /addAgentTool|addProposalType|addSuggestionAction/)
})

test('模型与预算覆盖默认模型、步数、超时、上下文、消息、工具结果与历史', () => {
  const source = read('app/pages/settings.vue')
  for (const token of [
    'agentModels.model',
    'agentModels.directorModel',
    'agentModels.maxSteps',
    'agentModels.timeoutSec',
    'agentModels.contextMaxChars',
    'agentModels.messageMaxChars',
    'agentModels.toolsMaxResultChars',
    'agentModels.historyMaxMessages',
    'messageOverContext',
    'numericInvalid',
  ]) {
    assert.ok(source.includes(token), `missing ${token}`)
  }
  assert.match(source, /messageMaxChars > contextMaxChars/)
})

test('抽屉按页面绑定取入口、快捷问题与作用域交集', () => {
  const source = read('app/components/agent/AgentDock.vue')
  for (const token of [
    'resolvePageBinding',
    'bindingStageForScope',
    'effectivePageEntries',
    'effectiveQuickPrompts',
    'effectiveSupportedScopes',
    'supportedScopes.value.includes(scope.value!.kind)',
  ]) {
    assert.ok(source.includes(token), `missing ${token}`)
  }
})

test('不新增智能体配置键，保存统一走 /settings/agent', () => {
  const settings = read('../backend/src/services/app-settings.ts')
  const body = settings.match(/export interface AgentSettings \{([\s\S]*?)\n\}/)
  assert.ok(body, 'AgentSettings interface missing')
  const keys = [...body[1].matchAll(/^\s{2}([a-zA-Z]+):/gm)].map(match => match[1])
  assert.deepEqual(keys, [
    'dock', 'pages', 'director', 'stream', 'proposals', 'suggestions', 'scope',
    'maxSteps', 'timeoutSec', 'context', 'message', 'tools', 'history', 'session', 'model',
  ])
  const page = read('app/pages/settings.vue')
  assert.doesNotMatch(page, /settingsAPI\.saveAgent\(\{[^}]*\b(budget|permissions|toolPolicy|pageBindings)\b/)
})
