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
  const referenced = [...new Set((timeline.match(/t\('edit\.[A-Za-z0-9.]+'/g) || [])
    .map((k) => k.slice(3, -1).replace(/^edit\./, ''))
    .map((key) => key.replace(/\.$/, '')))]

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

  // EditTimeline.vue 实际引用的每个 edit.* 键（支持嵌套）在四语言中都存在
  const resolve = (source, key) => key.split('.').reduce((node, part) => node?.[part], source)
  for (const key of referenced) {
    assert.equal(typeof resolve(zh.edit, key), 'string', `zh.json 缺少 EditTimeline 引用的 edit.${key}`)
    for (const [lang, loc] of others) {
      assert.equal(typeof resolve(loc.edit, key), 'string', `${lang}.json 缺少 edit.${key}`)
    }
  }
})

test('片段菜单：三项片段操作 + 分隔线 + 帧级操作，且走命令层', () => {
  const timeline = read('app/components/edit/EditTimeline.vue')
  assert.match(timeline, /function clipMenuItems/)
  assert.match(timeline, /clipMenu\.splitAtPlayhead/)
  assert.match(timeline, /clipMenu\.delete/)
  assert.match(timeline, /clipMenu\.rippleDelete/)
  assert.match(timeline, /clipMenu\.outsidePlayhead/)
  assert.match(timeline, /emit\('clip-op'/)
  assert.match(timeline, /kind: 'split'/)
  assert.match(timeline, /kind: 'delete'/)
  assert.match(timeline, /kind: 'ripple-delete'/)
  assert.match(timeline, /split\.disabled/)
  // 工具栏入口不依赖右键；右键菜单受 contextMenu 开关控制
  assert.match(timeline, /openMenuFromButton\(\$event, clipMenuItems/)
  assert.match(timeline, /openClipMenu[\s\S]*?props\.contextMenu/)
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /@clip-op="onClipOp"/)
  assert.match(workbench, /function onClipOp/)
  assert.match(workbench, /removeClip\(value, clipId, \{ ripple: kind === 'ripple-delete' \}\)/)
  assert.match(workbench, /splitClip\(value, clipId, Number\(atMs\), secondId\)/)
  assert.match(workbench, /:context-menu="uxEnabled\('contextMenu'\)"/)
})

test('片段菜单文案：四语言键齐全', () => {
  const keys = ['clipOps', 'clipMenu.splitAtPlayhead', 'clipMenu.delete', 'clipMenu.rippleDelete', 'clipMenu.outsidePlayhead']
  const resolve = (source, key) => key.split('.').reduce((node, part) => node?.[part], source)
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const edit = JSON.parse(read(`app/locales/${locale}.json`)).edit
    for (const key of keys) {
      assert.equal(typeof resolve(edit, key), 'string', `${locale}: edit.${key}`)
      assert.ok(resolve(edit, key).length > 0, `${locale}: edit.${key}`)
    }
  }
})
