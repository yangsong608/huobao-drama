import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const page = readFileSync(new URL('../app/pages/index.vue', import.meta.url), 'utf8')
const studioCss = readFileSync(new URL('../app/assets/studio.css', import.meta.url), 'utf8')

test('project list opens project detail before choosing an episode', () => {
  assert.match(page, /t\('index\.hero\.title'\)/)
  assert.match(page, /openDrama/)
  assert.match(page, /getDramaPath/)
  assert.match(page, /t\('index\.openProject'\)/)
  assert.match(page, /navigateTo\(getDramaPath\(d\)\)/)
  assert.doesNotMatch(page, /openWorkbench/)
})

test('project status is manually marked, not derived from content', () => {
  // 手动状态：选项 + 下拉标记 + 持久化到 dramas.status
  assert.match(page, /const statusOptions = computed\(\(\) => \(\[/)
  assert.match(page, /value: 'draft'/)
  assert.match(page, /value: 'active'/)
  assert.match(page, /value: 'completed'/)
  assert.match(page, /function currentStatus\(d\) \{ return d\.status \|\| 'draft' \}/)
  assert.match(page, /function setDramaStatus/)
  assert.match(page, /dramaAPI\.update\(d\.id, \{ status \}\)/)
  assert.match(page, /statusMenuId/)
  // 筛选与统计基于手动状态
  assert.match(page, /currentStatus\(d\) === statusFilter\.value/)
  assert.match(page, /currentStatus\(d\) === 'active'/)
  // 自动推算已移除：无进度条、无 episodes.length 状态派生
  assert.doesNotMatch(page, /getProgress/)
  assert.doesNotMatch(page, /d\.episodes\?\.length \? '进行中' : '待开始'/)
})

test('project launcher keeps controls simple', () => {
  assert.match(page, /t\('index\.searchPlaceholder'\)/)
  assert.match(page, /t\('index\.create'\)/)
  assert.doesNotMatch(page, /剧集列表/)
  assert.doesNotMatch(page, /制作队列/)
  assert.doesNotMatch(page, /最近活动/)
})

test('create dialog fixes aspect ratio at project creation', () => {
  assert.match(page, /t\('index\.createDialog\.aspectRatio'\)/)
  assert.match(page, /form\.aspect_ratio/)
  assert.match(page, /aspectRatioOptions/)
  assert.match(page, /aspect_ratio: '16:9'/)
  assert.match(page, /t\('index\.ratio\.landscape'\)/)
  assert.match(page, /t\('index\.ratio\.portrait'\)/)
  assert.match(page, /t\('index\.ratio\.square'\)/)
  assert.match(page, /t\('index\.createDialog\.aspectRatioHint'\)/)
  assert.doesNotMatch(page, /计划集数/)
})

test('global buttons use the brand action palette', () => {
  assert.match(studioCss, /--action-primary:\s*#f97316/)
  assert.match(studioCss, /--action-secondary:\s*#e8eaee/)
  assert.match(studioCss, /--action-danger:\s*#dc2626/)
  assert.match(studioCss, /\.btn-primary\s*\{/)
})
