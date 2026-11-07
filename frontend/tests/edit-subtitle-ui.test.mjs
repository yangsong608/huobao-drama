import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('字幕覆盖层渲染于预览之上且带安全区', () => {
  const overlay = read('app/components/edit/EditSubtitleOverlay.vue')
  assert.match(overlay, /safeArea/)
  assert.match(overlay, /xPct/)
  assert.match(overlay, /pointer-events/)
  const preview = read('app/components/edit/EditPreview.vue')
  assert.match(preview, /EditSubtitleOverlay/)
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /EditSubtitleOverlay/)
})

test('检查器字幕页含样式/位置/批量/操作分区', () => {
  const inspector = read('app/components/edit/EditClipInspector.vue')
  for (const key of ['subtitleText', 'subtitleTime', 'subtitleStyle', 'subtitlePosition', 'subtitleBatch', 'frameBack', 'frameForward', 'alignPlayhead', 'applyAll', 'setDefault', 'mergeNext', 'nineGrid']) {
    assert.match(inspector, new RegExp(key), key)
  }
})

test('字幕样式门禁：关闭时只隐藏样式/位置/批量，文本与时间保留', () => {
  const inspector = read('app/components/edit/EditClipInspector.vue')
  assert.match(inspector, /subtitleStylesEnabled/)
  assert.match(inspector, /v-if="subtitleStylesEnabled"[\s\S]*?edit\.subtitleStyle/)
  assert.match(inspector, /v-if="subtitleStylesEnabled"[\s\S]*?edit\.subtitlePosition/)
  assert.match(inspector, /v-if="subtitleStylesEnabled"[\s\S]*?edit\.subtitleBatch/)
  assert.match(inspector, /v-if="!subtitleStylesEnabled"[\s\S]*?edit\.subtitleStylesDisabled/)
  // 文本、时间、跟随、操作分区不带门禁
  assert.match(inspector, /edit\.subtitleText/)
  assert.match(inspector, /edit\.subtitleTime/)
  assert.match(inspector, /edit\.followClip/)
  assert.match(inspector, /edit\.subtitleActions/)
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /:subtitle-styles-enabled="uxEnabled\('subtitleStyles'\)"/)
})

test('快捷键说明只追加：片段菜单、标记添加与导航', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /edit\.shortcutClipMenu/)
  assert.match(workbench, /edit\.markers\.shortcutAdd/)
  assert.match(workbench, /edit\.markers\.shortcutNav/)
  for (const existing of ['shortcutPlay', 'shortcutStep', 'shortcutUndo', 'shortcutSave', 'shortcutSplit', 'shortcutDelete', 'shortcutHomeEnd', 'shortcutEscape']) {
    assert.match(workbench, new RegExp(existing), `既有快捷键说明 ${existing} 不应丢失`)
  }
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const edit = JSON.parse(read(`app/locales/${lang}.json`)).edit
    for (const key of ['shortcutClipMenu', 'subtitleStylesDisabled']) {
      assert.equal(typeof edit[key], 'string', `${lang}: edit.${key}`)
      assert.ok(edit[key].length > 0, `${lang}: edit.${key}`)
    }
  }
})

test('字幕抽屉可搜索、定位选中', () => {
  const list = read('app/components/edit/EditSubtitleList.vue')
  assert.match(list, /search/)
  assert.match(list, /emit\('select'/)
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /EditSubtitleList/)
})

test('四语言字幕编辑文案', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const data = read(`app/locales/${lang}.json`)
    for (const key of ['subtitleText', 'subtitleStyle', 'subtitlePosition', 'applyAll', 'setDefault', 'previewApprox']) {
      assert.match(data, new RegExp(key), `${lang}:${key}`)
    }
  }
})
