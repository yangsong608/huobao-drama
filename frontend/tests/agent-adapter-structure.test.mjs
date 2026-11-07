/**
 * A1-8（小说子集）：/novels 与 /novels/:id 两个适配器
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

test('仅小说列表与详情注册适配器，每个文件只注册一次', () => {
  const files = walk('app')
    .filter(file => /\.(vue|ts)$/.test(file))
    .filter(file => read(file).includes('useAgentPageAdapter({'))
  assert.deepEqual(files.sort(), [
    'app/pages/novels/index.vue',
    'app/views/novel/detail.vue',
  ])
  for (const file of ['app/pages/novels/index.vue', 'app/views/novel/detail.vue']) {
    const source = read(file)
    assert.equal((source.match(/useAgentPageAdapter\(/g) ?? []).length, 1, `${file} 只应注册一次`)
  }
})

test('小说库适配器使用精确路径与只读作用域', () => {
  const source = read('app/pages/novels/index.vue')
  assert.match(source, /id: 'novel-library'/)
  assert.match(source, /match: \{ name: 'novels', path: '\/novels' \}/)
  assert.match(source, /workspace_key: 'novel-library'/)
  assert.match(source, /kind: 'novel-library'/)
  assert.match(source, /supportedScopes: \['novel-library'\]/)
  assert.doesNotMatch(source, /runSuggestion/)
})

test('小说详情适配器按数字 ID 精确匹配，非法 ID 返回 null', () => {
  const source = read('app/views/novel/detail.vue')
  assert.match(source, /id: 'novel-detail'/)
  assert.match(source, /pattern: \/\^\\\/novels\\\/\\d\+\$\//)
  assert.match(source, /Number\.isSafeInteger\(id\)/)
  assert.match(source, /workspace_key: `novel:\$\{id\}`/)
  assert.match(source, /kind: 'novel'/)
  assert.match(source, /novel_id: id/)
  assert.match(source, /supportedScopes: \['novel'\]/)
  assert.doesNotMatch(source, /runSuggestion/)
})

test('子组件不注册适配器，路由匹配不使用前缀吞并', () => {
  const components = walk('app/components').filter(file => /\.vue$/.test(file))
  for (const file of components) {
    assert.doesNotMatch(read(file), /useAgentPageAdapter\(/, `${file} 不应注册适配器`)
  }
  const registry = read('app/composables/useAgentPageAdapter.ts')
  assert.doesNotMatch(registry, /startsWith\(/)
  assert.match(registry, /routePath === match\.path/)
})

test('作用域为 null 时抽屉隐藏；进入页面且设置就绪即解析线程', () => {
  const dock = read('app/components/agent/AgentDock.vue')
  assert.match(dock, /const scope = computed\(\(\) => activeAdapter\.value\?\.scope\(\) \?\? null\)/)
  assert.match(dock, /const open = computed\(\(\) => dockOpen\.value && visible\.value\)/)
  assert.match(dock, /if \(!isVisible \|\| !settingsReady \|\| !workspaceKey \|\| !scope\.value\) return/)
  assert.match(dock, /await resolve\(scope\.value\)/)
})
