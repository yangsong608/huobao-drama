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
