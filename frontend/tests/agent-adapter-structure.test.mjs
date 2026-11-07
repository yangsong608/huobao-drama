/**
 * A1-8（小说子集）+ A2-6（剪辑/混音/交付）页面适配器
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

test('仅小说两页、分集页与剪辑页注册适配器，每个文件只注册一次', () => {
  const files = walk('app')
    .filter(file => /\.(vue|ts)$/.test(file))
    .filter(file => read(file).includes('useAgentPageAdapter({'))
  assert.deepEqual(files.sort(), [
    'app/pages/novels/index.vue',
    'app/views/drama/edit.vue',
    'app/views/drama/episode.vue',
    'app/views/novel/detail.vue',
  ])
  for (const file of files) {
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

test('剪辑页适配器带工程 ID 并消费 project_id 与 focus_clip_id', () => {
  const source = read('app/views/drama/edit.vue')
  assert.match(source, /id: 'drama-edit'/)
  assert.match(source, /match: \{ name: 'drama-episode-edit', pattern: \/\^\\\/drama\\\/\\d\+\\\/episode\\\/\\d\+\\\/edit\$\//)
  assert.match(source, /kind: 'edit'/)
  assert.match(source, /edit_project_id: editProjectId/)
  assert.match(source, /supportedScopes: \['edit'\]/)
  assert.match(source, /entries: \['floating', 'topbar'\]/)
  assert.match(source, /showHeaderAssistant/)
  assert.match(source, /openAgentDock/)
  assert.match(source, /route\.query\.project_id/)
  assert.match(source, /route\.query\.focus_clip_id/)
  assert.match(source, /clips\.some\(\(clip\) => clip\?\.id === id\)/)
  assert.match(source, /cause\?\.status !== 404/)
  assert.match(source, /toast\.warning\(t\('edit\.projectMissing'\)\)/)
  assert.match(source, /toast\.warning\(t\('edit\.clipMissing'\)\)/)
  assert.doesNotMatch(source, /runSuggestion/)
})

test('分集页适配器覆盖 episode/mix/delivery 三种作用域', () => {
  const source = read('app/views/drama/episode.vue')
  assert.match(source, /id: 'drama-episode'/)
  assert.match(source, /match: \{ name: 'drama-episode', pattern: \/\^\\\/drama\\\/\\d\+\\\/episode\\\/\\d\+\$\//)
  assert.match(source, /supportedScopes: \['episode', 'mix', 'delivery'\]/)
  assert.match(source, /workspace_key: `drama:\$\{dramaId\}`/)
  assert.match(source, /drama_id: dramaId/)
  assert.match(source, /episode_id: episodeId/)
  assert.match(source, /kind: 'delivery'/)
  assert.match(source, /kind: 'mix'/)
  assert.match(source, /kind: 'episode'/)
  assert.doesNotMatch(source, /stage: 'mix'/)
  assert.doesNotMatch(source, /stage: 'delivery'/)
  assert.match(source, /focus: \{ export_id: focusExportId\.value \}/)
  assert.match(source, /focus: \{ track_id: focusTrackId\.value \}/)
  assert.match(source, /deliveryOpen\.value \|\| panel\.value === 'export' \|\| \(panel\.value === 'dubbing' && dubStep\.value === 4\)/)
  assert.match(source, /panel\.value === 'dubbing' && dubStep\.value === 3/)
  assert.match(source, /open === 'edit'/)
  assert.match(source, /project_id: String\(projectId\)/)
  assert.match(source, /focus_track_id/)
  assert.match(source, /focus_export_id/)
  assert.match(source, /delete next\.open/)
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

test('混音/导出舞台只消费定位参数，不注册适配器', () => {
  const mix = read('app/components/MixStage.vue')
  assert.match(mix, /focusTrackId\?: number \| null/)
  assert.match(mix, /activeTrackUid\.value = target\._uid/)
  const exportStage = read('app/components/ExportStage.vue')
  assert.match(exportStage, /focusExportId\?: number \| null/)
  assert.match(exportStage, /:data-export-id="record\.id"/)
  assert.match(exportStage, /is-focused/)
  assert.match(exportStage, /scrollIntoView/)
})

test('作用域为 null 时抽屉隐藏；进入页面且设置就绪即解析线程', () => {
  const dock = read('app/components/agent/AgentDock.vue')
  assert.match(dock, /const scope = computed\(\(\) => activeAdapter\.value\?\.scope\(\) \?\? null\)/)
  assert.match(dock, /const open = computed\(\(\) => dockOpen\.value && visible\.value\)/)
  assert.match(dock, /if \(!isVisible \|\| !settingsReady \|\| !workspaceKey \|\| !scope\.value\) return/)
  assert.match(dock, /await resolve\(scope\.value\)/)
})
