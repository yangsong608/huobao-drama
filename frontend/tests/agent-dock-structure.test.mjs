/**
 * A0-2：页面适配器注册机制与全局唯一空抽屉
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

function walk(directory) {
  const entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true })
  return entries.flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name)
    return entry.isDirectory() ? walk(relative) : [relative]
  })
}

test('全局只挂载一个 AgentDock，页面与布局不内嵌聊天', () => {
  const app = read('app/app.vue')
  assert.equal((app.match(/<AgentDock\b/g) ?? []).length, 1)
  assert.match(app, /import AgentDock from '~\/components\/agent\/AgentDock\.vue'/)

  const shells = [...walk('app/pages'), ...walk('app/layouts'), ...walk('app/views')]
  for (const file of shells) {
    const source = read(file)
    assert.doesNotMatch(source, /<AgentDock\b/, `${file} 不应内嵌 AgentDock`)
    assert.doesNotMatch(source, /agent-dock-trigger/, `${file} 不应自行实现入口`)
  }

  const docks = walk('app/components').filter(file => /AgentDock\.vue$/.test(file))
  assert.deepEqual(docks, ['app/components/agent/AgentDock.vue'])
})

test('适配器接口声明作用域、入口、快捷问题、支持作用域与建议入口', () => {
  const source = read('app/composables/useAgentPageAdapter.ts')
  for (const token of [
    'export interface AgentPageAdapter',
    'match: AgentRouteMatch',
    'scope: () => AgentScope | null',
    'entries: AgentEntryType[]',
    'quickPrompts: () => string[]',
    'supportedScopes: AgentScopeKind[]',
    'runSuggestion?',
    'registerAgentPageAdapter',
    'unregisterAgentPageAdapter',
    'onBeforeUnmount',
  ]) {
    assert.ok(source.includes(token), `missing ${token}`)
  }
})

test('路由匹配只接受路由名或精确路径，不做前缀匹配', () => {
  const source = read('app/composables/useAgentPageAdapter.ts')
  assert.match(source, /routeName === match\.name/)
  assert.match(source, /routePath === match\.path/)
  assert.match(source, /match\.pattern\.test\(routePath\)/)
  assert.doesNotMatch(source, /startsWith\(/)
})

test('抽屉默认 380px，可拖到 360–520px', () => {
  const source = read('app/composables/useAgentPageAdapter.ts')
  assert.match(source, /DOCK_DEFAULT_WIDTH = 380/)
  assert.match(source, /DOCK_MIN_WIDTH = 360/)
  assert.match(source, /DOCK_MAX_WIDTH = 520/)
  const dock = read('app/components/agent/AgentDock.vue')
  assert.match(dock, /agent-dock-resize/)
  assert.match(dock, /setAgentDockWidth/)
  assert.match(dock, /beginResize/)
})

test('可见性由适配器与 agent.dock.enabled 共同决定，设置页不注册适配器', () => {
  const dock = read('app/components/agent/AgentDock.vue')
  assert.match(dock, /dockEnabled\.value && Boolean\(activeAdapter\.value\)/)
  assert.match(dock, /loadAgentSettings/)
  assert.doesNotMatch(read('app/pages/settings.vue'), /useAgentPageAdapter/)

  const settings = read('app/composables/useAgentSettings.ts')
  assert.match(settings, /settingsAPI\.agent\(\)/)
  assert.match(settings, /dock\.enabled !== false/)
})

test('抽屉骨架含标题、预设、作用域条、消息区、输入区与空态', () => {
  const dock = read('app/components/agent/AgentDock.vue')
  for (const token of [
    'agent-dock-title',
    'assistant.preset',
    'agent-scope-bar',
    'agent-messages',
    'agent-empty',
    'agent-dock-foot',
    'agent-input',
    'assistant.history',
  ]) {
    assert.ok(dock.includes(token), `missing ${token}`)
  }
})

test('抽屉组件不直接发起请求，入口状态保留在模块级', () => {
  const dock = read('app/components/agent/AgentDock.vue')
  assert.doesNotMatch(dock, /fetch\(/)
  assert.doesNotMatch(dock, /api\.(get|post|put|del)\(/)
  const registry = read('app/composables/useAgentPageAdapter.ts')
  assert.match(registry, /const dockOpen = ref\(false\)/)
  assert.match(registry, /const dockWidth = ref\(DOCK_DEFAULT_WIDTH\)/)
})

test('未新增智能体页面或路由', () => {
  const pages = walk('app/pages').filter(file => /agent|assistant/i.test(path.basename(file)))
  assert.deepEqual(pages, [])
  const config = read('nuxt.config.ts')
  assert.doesNotMatch(config, /path:\s*['"]\/(agent|assistant)/)
})
