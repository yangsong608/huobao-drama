import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('设置页“剪辑与导出”卡片只绑定 10 个白名单键', () => {
  const page = read('app/pages/settings.vue')
  const start = page.indexOf('<!-- 剪辑与导出 -->')
  assert.ok(start >= 0, '缺少剪辑与导出卡片')
  const card = page.slice(start, page.indexOf('</section>', start))
  for (const path of [
    'editSettings.export.enabled',
    'editSettings.export.defaultPreset',
    'editSettings.export.subtitleMode',
    'editSettings.export.audioSource',
    'editSettings.export.requireAlignedMix',
    'editSettings.export.maxDurationSec',
    'editSettings.export.concurrency',
    'editSettings.ux.contextMenu',
    'editSettings.ux.markers',
    'editSettings.ux.subtitleStyles',
  ]) {
    assert.match(card, new RegExp(path.replace(/\./g, '\\.')))
  }
  assert.doesNotMatch(card, /filmSources/, '本期设置卡不展示 filmSources')
})

test('设置卡保存走 /settings/edit 并回读', () => {
  const page = read('app/pages/settings.vue')
  assert.match(page, /settingsAPI\.edit\(\)/)
  assert.match(page, /settingsAPI\.saveEdit\(/)
  const save = page.slice(page.indexOf('async function saveEditSettings'))
  assert.match(save, /export: \{ \.\.\.editSettings\.value\.export \}/)
  assert.match(save, /ux: \{ \.\.\.editSettings\.value\.ux \}/)
  assert.doesNotMatch(save, /filmSources/)
  assert.match(save, /editSettings\.value = res\.settings/)

  const api = read('app/composables/useApi.ts')
  assert.match(api, /edit: \(\) => api\.get<\{ settings: EditSettings \}>\('\/settings\/edit'\)/)
  assert.match(
    api,
    /saveEdit: \(patch: Partial<EditSettings>\) => api\.put<\{ settings: EditSettings \}>\('\/settings\/edit', patch\)/,
  )
})

test('顶栏导出按钮常显、按能力禁用并显示原因', () => {
  const topbar = read('app/components/edit/EditTopBar.vue')
  assert.match(topbar, /:disabled="!canExport"/)
  assert.match(topbar, /exportBlockedReason/)
  assert.match(topbar, /class="ed-blocked"/)
  assert.match(topbar, /can_export === true/)
  const center = topbar.slice(
    topbar.indexOf('<div v-if="canEdit" class="ed-top-center">'),
    topbar.indexOf('<div class="ed-top-right">'),
  )
  assert.match(center, /save/)
  assert.doesNotMatch(center, /open-export/, '导出按钮不得被 canEdit 操作区包裹')
  const right = topbar.slice(topbar.indexOf('<div class="ed-top-right">'))
  assert.match(right, /@click="\$emit\('open-export'\)"/)
})

test('导出对话框默认值来自配置，不硬编码字幕模式', () => {
  const dialog = read('app/components/edit/EditExportDialog.vue')
  assert.match(dialog, /settings: \{ type: Object, default: \(\) => \(\{\}\) \}/)
  assert.match(dialog, /defaultPreset \|\| 'auto'/)
  assert.match(dialog, /subtitleMode \|\| 'soft'/)
  assert.doesNotMatch(dialog, /subtitleMode = ref\('burn'\)/)
  assert.match(dialog, /presetSquareHd/)
  assert.match(dialog, /exportAutoResolved/)
})

test('剪辑页读取 edit.* 配置且失败不阻断', () => {
  const page = read('app/views/drama/edit.vue')
  assert.match(page, /settingsAPI\.edit\(\)/)
  assert.match(page, /defaultPreset: 'auto'/)
  assert.match(page, /subtitleMode: 'soft'/)
  assert.match(page, /ux: \{ contextMenu: true, markers: true, subtitleStyles: true \}/)
  const loader = page.slice(page.indexOf('async function loadEditSettings'))
  assert.match(loader, /catch \{[\s\S]*?\}/)
  assert.match(page, /:settings="editSettings"/)
})

test('四语新增设置与预设文案键一致', () => {
  const keys = [
    'settings.general.editTitle',
    'settings.general.editSub',
    'settings.general.editSave',
    'settings.general.editSaved',
    'settings.general.editSaveFailed',
    'settings.general.editExportEnabled',
    'settings.general.editExportEnabledNote',
    'settings.general.editDefaultPreset',
    'settings.general.editDefaultPresetNote',
    'settings.general.editSubtitle',
    'settings.general.editSubtitleNote',
    'settings.general.editAudioSource',
    'settings.general.editAudioSourceNote',
    'settings.general.editMaxDuration',
    'settings.general.editMaxDurationNote',
    'settings.general.editConcurrency',
    'settings.general.editConcurrencyNote',
    'settings.general.editRequireAlignedMix',
    'settings.general.editRequireAlignedMixNote',
    'settings.general.editUxTitle',
    'settings.general.editUxContextMenu',
    'settings.general.editUxContextMenuNote',
    'settings.general.editUxMarkers',
    'settings.general.editUxMarkersNote',
    'settings.general.editUxSubtitleStyles',
    'settings.general.editUxSubtitleStylesNote',
    'settings.general.editHint',
    'edit.presetAuto',
    'edit.presetSquareHd',
    'edit.exportAutoResolved',
    'edit.audioSourceAuto',
    'edit.audioSourceMix',
    'edit.audioSourceClip',
    'edit.audioSourceSilent',
  ]
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const data = JSON.parse(read(`app/locales/${lang}.json`))
    const get = (path) => path.split('.').reduce((value, key) => value?.[key], data)
    for (const key of keys) assert.ok(get(key), `${lang} 缺少 ${key}`)
  }
})
