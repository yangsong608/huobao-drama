import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('标记入口：工具栏、标尺旗标、列表与空状态', () => {
  const timeline = read('app/components/edit/EditTimeline.vue')
  assert.match(timeline, /showMarkers/)
  assert.match(timeline, /edit\.markers\.button/)
  assert.match(timeline, /edit\.markers\.addAtPlayhead/)
  assert.match(timeline, /edit\.markers\.empty/)
  assert.match(timeline, /edit\.markers\.defaultLabel/)
  assert.match(timeline, /ed-marker-popover/)
  assert.match(timeline, /ed-marker-list/)
  assert.match(timeline, /is-current/)
  assert.match(timeline, /emit\('add-marker'/)
  assert.match(timeline, /emit\('delete-marker'/)
  assert.match(timeline, /emit\('seek', marker\.atMs\)/)
  // 开关关闭只隐藏旗标，不删除计划中的数据
  assert.match(timeline, /v-if="showMarkers"/)
  assert.match(timeline, /v-if="showMarkers && markerPopover"/)
})

test('标记快捷键：M 添加、[ / ] 导航，且受 markers 开关控制', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /key === 'm'/)
  assert.match(workbench, /event\.key === '\[' \|\| event\.key === '\]'/)
  assert.match(workbench, /jumpMarker\(event\.key === '\[' \? -1 : 1\)/)
  assert.match(workbench, /function jumpMarker\(direction\)/)
  assert.match(workbench, /markerAtOrBefore\(plan\.value, currentMs\.value\)/)
  assert.match(workbench, /markerAtOrAfter\(plan\.value, currentMs\.value\)/)
  assert.match(workbench, /nextMarkerId\(value\)/)
  assert.match(workbench, /uxEnabled\('markers'\)/)
  assert.match(workbench, /:show-markers="uxEnabled\('markers'\)"/)
  assert.match(workbench, /closeMarkerPopover/)
  assert.match(workbench, /edit\.markers\.shortcutAdd/)
  assert.match(workbench, /edit\.markers\.shortcutNav/)
})

test('标记操作经过命令层并进入撤销栈', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /runCommand\(\(value\) => addMarker\(value, \{/)
  assert.match(workbench, /runCommand\(\(value\) => deleteMarker\(value, markerId\)/)
  assert.match(workbench, /id: nextMarkerId\(value\)/)
})

test('标记文案：四语言键齐全', () => {
  const keys = [
    'markers.button', 'markers.title', 'markers.close', 'markers.addAtPlayhead',
    'markers.empty', 'markers.defaultLabel', 'markers.delete',
    'markers.shortcutAdd', 'markers.shortcutNav',
  ]
  const resolve = (source, key) => key.split('.').reduce((node, part) => node?.[part], source)
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const edit = JSON.parse(read(`app/locales/${locale}.json`)).edit
    for (const key of keys) {
      assert.equal(typeof resolve(edit, key), 'string', `${locale}: edit.${key}`)
      assert.ok(resolve(edit, key).length > 0, `${locale}: edit.${key}`)
    }
  }
})
