import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('导出对话框：降级警告、模式与确认', () => {
  const dialog = read('app/components/edit/EditExportDialog.vue')
  assert.match(dialog, /collectExportWarnings/)
  assert.match(dialog, /subtitleMode/)
  assert.match(dialog, /setCurrent/)
  assert.match(dialog, /editAPI\.render/)
  assert.match(dialog, /renderStatus/)
  assert.match(dialog, /base_version|baseVersion/)
})

test('导出完成但带后端警告：展示提示且不自动关闭', () => {
  const dialog = read('app/components/edit/EditExportDialog.vue')
  const poll = dialog.slice(dialog.indexOf('async function pollStatus'))
  assert.match(
    poll,
    /if \(status\.error\)[\s\S]*?emit\('exported', status\)[\s\S]*?return/,
    'completed 带警告需展示 status.error 且跳过自动关闭',
  )
})

test('导出警告镜像后端编码', () => {
  const src = read('app/utils/edit-export-warnings.ts')
  for (const code of ['TRANSITION_HARD_CUT', 'SPEED_CLAMPED']) {
    assert.match(src, new RegExp(code))
  }
  // 滤镜/画面调整/叠加轨均已真实导出，不再产生降级警告
  assert.doesNotMatch(src, /FILTER_UNSUPPORTED|TRANSFORM_UNSUPPORTED|OVERLAY_UNSUPPORTED/)
})

test('图片与视频选择器：上传、列表与插入', () => {
  const picker = read('app/components/edit/EditImagePicker.vue')
  assert.match(picker, /editAPI\.uploadImage/)
  assert.match(picker, /emit\('insert'/)
  assert.match(picker, /type="file"/)

  const videoPicker = read('app/components/edit/EditVideoPicker.vue')
  assert.match(videoPicker, /editAPI\.uploadVideo/)
  assert.match(videoPicker, /editAPI\.media/)
  assert.match(videoPicker, /emit\('insert'/)
  assert.match(videoPicker, /type="file"/)
})

test('editAPI 新端点与四语言文案', () => {
  const api = read('app/composables/useApi.ts')
  for (const name of ['extractFrame', 'uploadImage', 'uploadVideo', 'render', 'renderStatus']) {
    assert.match(api, new RegExp(`${name}\\(`))
  }
  const zh = JSON.parse(read('app/locales/zh.json'))
  assert.ok(zh.edit.exportTitle)
  assert.ok(zh.edit.exportWarningTitle)
  assert.ok(zh.edit.subtitleBurn)
  assert.ok(zh.edit.imagePickerTitle)
  assert.ok(zh.edit.videoPickerTitle)
})
