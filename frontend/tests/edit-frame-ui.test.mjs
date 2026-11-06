import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('时间线右键菜单覆盖帧操作与字幕操作', () => {
  const timeline = read('app/components/edit/EditTimeline.vue')
  assert.match(timeline, /ContextMenu/)
  assert.match(timeline, /delete-frame/)
  assert.match(timeline, /duplicate-frame/)
  assert.match(timeline, /insert-image/)
  assert.match(timeline, /extend-1s/)
  assert.match(timeline, /cue-op/)
  assert.match(timeline, /merge-next/)
})

test('工具栏可见按钮：帧操作、字幕、分割、删除、适应画幅', () => {
  const timeline = read('app/components/edit/EditTimeline.vue')
  for (const key of [
    'edit.frameOps', 'edit.frameDelete', 'edit.frameDuplicate',
    'edit.frameInsertImage', 'edit.frameExtend', 'edit.subtitleMenu',
    'edit.subtitleNew', 'edit.subtitleToggle', 'edit.subtitleOpenList',
    'edit.fitView',
  ]) {
    assert.match(timeline, new RegExp(key.replace('.', '\\.')))
  }
  assert.match(timeline, /\$emit\('fit-view'\)/)
  assert.match(timeline, /showSubtitles/)
})

test('工作台接线帧操作与字幕菜单事件', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /@frame-op/)
  assert.match(workbench, /@cue-op/)
  assert.match(workbench, /@toggle-subtitles/)
  assert.match(workbench, /@fit-view/)
  assert.match(workbench, /rippleDeleteFrame/)
  assert.match(workbench, /insertFreezeFrame/)
})

test('工作台接线图片选择器与定格插入', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /EditImagePicker/)
  assert.match(workbench, /insertImageClip/)
  assert.match(workbench, /insertFreezeFrame/)
  assert.match(workbench, /editAPI\.extractFrame/)
})

test('Task 22 UI 引用的 edit.* 键在四语言 locale 中存在（键位一致）', () => {
  const timeline = read('app/components/edit/EditTimeline.vue')
  const referenced = [...new Set((timeline.match(/edit\.[A-Za-z0-9]+/g) || []).map((k) => k.slice(5)))]
  assert.ok(referenced.length > 0, 'EditTimeline.vue 应至少引用一个 edit.* 键')

  const zh = JSON.parse(read('app/locales/zh.json'))
  const others = [
    ['en', JSON.parse(read('app/locales/en.json'))],
    ['ja', JSON.parse(read('app/locales/ja.json'))],
    ['ko', JSON.parse(read('app/locales/ko.json'))],
  ]

  // Task 22 明确要求的键（报告 16 键 + brief 模板引用的 subtitleToggle/delete）
  const required = [
    'frameOps', 'frameDelete', 'frameDuplicate', 'frameInsertImage', 'frameExtend',
    'subtitleMenu', 'subtitleNew', 'subtitleShow', 'subtitleHide', 'subtitleToggle',
    'subtitleOpenList', 'fitView', 'cueEdit', 'cueSplit', 'cueMerge', 'cueMergeNone', 'delete',
  ]
  for (const key of required) {
    assert.ok(key in zh.edit, `zh.json 缺少 edit.${key}`)
  }

  // EditTimeline.vue 实际引用的每个 edit.* 键在四语言中都存在
  for (const key of referenced) {
    assert.ok(key in zh.edit, `zh.json 缺少 EditTimeline 引用的 edit.${key}`)
    for (const [lang, loc] of others) {
      assert.ok(key in loc.edit, `${lang}.json 缺少 edit.${key}`)
    }
  }
})
