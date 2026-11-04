import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const detail = read('app/views/drama/detail.vue')
const useApi = read('app/composables/useApi.ts')

test('episode card exposes a delete action', () => {
  assert.match(useApi, /episodeAPI = \{[\s\S]*?del: \(id: number\) => api\.del\(`\/episodes\/\$\{id\}`\)/)
  assert.match(detail, /class="btn btn-icon btn-sm ep-delete"/)
  assert.match(detail, /@click="episodeToDelete = ep"/)
  assert.match(detail, /<ConfirmDialog/)
  assert.match(detail, /t\('detail\.epDelete\.message'/)
  assert.match(detail, /await episodeAPI\.del\(ep\.id\)/)
  // 删除确认走自定义 ConfirmDialog，不使用浏览器原生确认
  assert.doesNotMatch(detail, /window\.confirm\(t\('detail\.epDelete/)
})

test('drama detail exposes the asset library as a tab', () => {
  assert.match(detail, /activeTab === 'assets'/)
  assert.match(detail, /function switchToAssets\(\)/)
  assert.match(detail, /activeTab\.value = 'assets'/)
  assert.match(detail, /t\('detail\.tabs\.assets'\)/)
})

test('episode status is manually marked, not derived from script content', () => {
  // 手动状态：选项 + 下拉标记 + 持久化到 episodes.status
  assert.match(detail, /const epStatusOptions = computed\(\(\) => \(\[/)
  assert.match(detail, /function epStatus\(ep\) \{ return ep\.status \|\| 'draft' \}/)
  assert.match(detail, /function setEpisodeStatus/)
  assert.match(detail, /episodeAPI\.update\(ep\.id, \{ status \}\)/)
  assert.match(detail, /epStatusMenuId/)
  // 自动推算已移除
  assert.doesNotMatch(detail, /hasScript/)
  assert.doesNotMatch(detail, /已完成剧本/)
  assert.doesNotMatch(detail, /待编写/)
})

test('asset library groups character, scene and prop assets with a viewer', () => {
  // 数据源：项目详情的 characters / scenes / props 三张资产表
  assert.match(detail, /for \(const c of d\.characters \|\| \[\]\)/)
  assert.match(detail, /for \(const s of d\.scenes \|\| \[\]\)/)
  assert.match(detail, /for \(const p of d\.props \|\| \[\]\)/)
  // 全部 / 角色 / 场景 / 道具 筛选
  assert.match(detail, /const assetTabs = computed/)
  assert.match(detail, /\{ label: t\('index\.status\.all'\), value: 'all' \}/)
  assert.match(detail, /\{ label: t\('common\.role'\), value: 'character' \}/)
  assert.match(detail, /\{ label: t\('common\.scene'\), value: 'scene' \}/)
  assert.match(detail, /\{ label: t\('common\.prop'\), value: 'prop' \}/)
  assert.match(detail, /const assetGroups = computed/)
  // 网格 + 预览
  assert.match(detail, /class="card character-asset-card"/)
  assert.match(detail, /'asset-card'/)
  assert.match(detail, /openAssetViewer\(m\)/)
  assert.match(detail, /viewer-overlay/)
  // 空态引导
  assert.match(detail, /t\('detail\.assets\.emptyTitle'\)/)
  assert.match(detail, /t\('detail\.assets\.emptyDesc'\)/)
})
