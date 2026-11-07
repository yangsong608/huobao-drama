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

test('导出对话框：阻断项红色列出并禁用开始按钮', () => {
  const dialog = read('app/components/edit/EditExportDialog.vue')
  assert.match(dialog, /blocking\.length/)
  assert.match(dialog, /ed-blocked-list/)
  assert.match(dialog, /blocking\.length > 0/)
  assert.match(dialog, /edit\.exportBlocked\.title/)
  const util = read('app/utils/edit-export-warnings.ts')
  for (const code of ['OVERLAY_UNSUPPORTED', 'FILTER_UNSUPPORTED', 'TRANSFORM_UNSUPPORTED', 'SPEED_UNSUPPORTED', 'TRANSITION_UNSUPPORTED']) {
    assert.match(util, new RegExp(code))
  }
  assert.match(util, /return \{ blocking, warnings \}/)
})

test('导出复用：不轮询、显示复用提示并提供打开/交付入口', () => {
  const dialog = read('app/components/edit/EditExportDialog.vue')
  assert.match(dialog, /result\?\.reused/)
  assert.match(dialog, /emit\('reused'/)
  assert.match(dialog, /reusedOutputUrl/)
  assert.match(dialog, /window\.open\(reusedOutputUrl/)
  assert.match(dialog, /edit\.exportViewDelivery/)
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /@reused="onReused"/)
  assert.match(workbench, /openExportDelivery/)
  assert.match(workbench, /#exports/)
})

test('导出阻断与复用文案：四语言键齐全', () => {
  const keys = [
    'exportBlocked.title', 'exportBlocked.overlay', 'exportBlocked.filter',
    'exportBlocked.transform', 'exportBlocked.speed', 'exportBlocked.transition',
    'exportBlocked.bottom', 'exportReusedTitle', 'exportReusedHint',
    'exportReusedDone', 'exportOpenFilm', 'exportViewDelivery',
  ]
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const edit = JSON.parse(read(`app/locales/${locale}.json`)).edit
    for (const key of keys) {
      const value = key.split('.').reduce((node, part) => node?.[part], edit)
      assert.equal(typeof value, 'string', `${locale}: edit.${key}`)
      assert.ok(value.length > 0, `${locale}: edit.${key}`)
    }
  }
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

test('导出预计时长/大小、进度阶段与完成操作', () => {
  const dialog = read('app/components/edit/EditExportDialog.vue')
  assert.match(dialog, /layout: \{ type: Object/)
  assert.match(dialog, /layoutDurationMs/)
  assert.match(dialog, /estimatedBytes/)
  assert.match(dialog, /PRESET_BITRATES/)
  assert.match(dialog, /edit\.exportEstimateDuration/)
  assert.match(dialog, /edit\.exportEstimateSize/)
  assert.match(dialog, /progressStage/)
  assert.match(dialog, /ed-progress-bar/)
  for (const phase of ['exportPhaseCheck', 'exportPhaseNormalize', 'exportPhaseAssemble', 'exportPhaseAudio', 'exportPhaseSubtitle', 'exportPhaseFinalize']) {
    assert.match(dialog, new RegExp(phase))
  }
  assert.match(dialog, /completed\.value = true/)
  assert.match(dialog, /doneStatus\.value = status/)
  assert.match(dialog, /edit\.exportCopyPath/)
  assert.match(dialog, /copyDonePath/)
  assert.match(dialog, /navigator\.clipboard/)
  const poll = dialog.slice(dialog.indexOf('async function pollStatus'))
  assert.doesNotMatch(poll, /emit\('close'\)/, '完成后保留弹窗展示成片操作')
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /:layout="layout"/)
})

test('导出先保存：草稿脏时先保存再打开对话框，保存失败不打开', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /async function openExportDialog/)
  assert.match(workbench, /if \(dirty\.value\) \{[\s\S]*?await saveNow\(\)[\s\S]*?exportSaveFirstFailed/)
  const topbar = read('app/components/edit/EditTopBar.vue')
  assert.match(topbar, /exportLabel/)
  assert.match(topbar, /edit\.exportSaveFirst/)
  const zh = JSON.parse(read('app/locales/zh.json')).edit
  assert.equal(zh.exportSaveFirst, '先保存')
})

test('导出取消与重试：取消停止轮询并保留重试，重试沿用同一记录', () => {
  const dialog = read('app/components/edit/EditExportDialog.vue')
  assert.match(dialog, /exportAPI\.cancel\(currentExportId\.value\)/)
  assert.match(dialog, /exportAPI\.retry\(currentExportId\.value\)/)
  const poll = dialog.slice(dialog.indexOf('async function pollStatus'))
  const cancelledBranch = poll.indexOf("status.status === 'cancelled'")
  const failedBranch = poll.indexOf("status.status === 'failed'")
  assert.ok(cancelledBranch >= 0 && failedBranch > cancelledBranch, 'cancelled 分支必须先于 failed 判定')
  assert.match(poll.slice(cancelledBranch), /cancelled\.value = true/)
  assert.match(poll.slice(cancelledBranch), /stopPolling\(\)/)
  assert.match(poll.slice(cancelledBranch), /emit\('cancelled', status\)/)
  assert.match(dialog, /retryable = computed\([\s\S]*?failed\.value \|\| cancelled\.value/)
  assert.match(dialog, /startPolling\(currentExportId\.value\)/)
  // 关闭弹窗不取消任务：close 只发事件，不调用 cancel/abort
  const closeBody = dialog.slice(dialog.indexOf('function close()'), dialog.indexOf('function stopPolling()'))
  assert.doesNotMatch(closeBody, /cancel|abort|exportAPI/)
})

test('导出进度恢复：刷新后进行中记录恢复轮询，失败/取消恢复为重试态', () => {
  const dialog = read('app/components/edit/EditExportDialog.vue')
  assert.match(dialog, /resumeExportId/)
  assert.match(dialog, /resumeStatus/)
  assert.match(dialog, /function maybeResume\(/)
  assert.match(dialog, /ACTIVE_STATUSES\.includes\(state\)[\s\S]*?startPolling\(id\)/)
  assert.match(dialog, /state === 'failed'[\s\S]*?failed\.value = true/)
  assert.match(dialog, /state === 'cancelled'[\s\S]*?cancelled\.value = true/)
  assert.match(dialog, /emit\('progress'/)
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /:resume-export-id="resumeExport\?\.id \|\| 0"/)
  assert.match(workbench, /@progress="onRenderProgress"/)
  assert.match(workbench, /@failed="onRenderFailed"/)
  assert.match(workbench, /function openExportDialog/)
  assert.match(workbench, /@open-export="openExportDialog"/)
  assert.match(workbench, /liveExport/)
})

test('顶栏导出进度胶囊：进行中才显示并可打开导出弹窗', () => {
  const topbar = read('app/components/edit/EditTopBar.vue')
  assert.match(topbar, /activeRender/)
  assert.match(topbar, /props\.state\.renders\?\.latest/)
  for (const status of ['pending', 'running', 'rendering']) {
    assert.match(topbar, new RegExp(status))
  }
  assert.match(topbar, /@click="\$emit\('open-export', activeRender\.id\)"/)
  assert.match(topbar, /edit\.exportActiveHint/)
})

test('导出取消/进度文案：四语言键齐全', () => {
  const keys = [
    'exportActive', 'exportActiveHint', 'exportCancel', 'exportCancelling',
    'exportRetry', 'exportCancelled', 'exportCancelFailed',
    'exportSaveFirst', 'exportSaveFirstHint', 'exportSaveFirstFailed',
    'exportPhaseCheck', 'exportPhaseNormalize', 'exportPhaseAssemble',
    'exportPhaseAudio', 'exportPhaseSubtitle', 'exportPhaseFinalize', 'exportPhaseDone',
    'exportDoneTitle', 'exportDoneDuration', 'exportDoneSize', 'exportDoneAt',
    'exportCopyPath', 'exportCopied', 'exportCopyFailed',
    'exportEstimateDuration', 'exportEstimateSize',
  ]
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const edit = JSON.parse(read(`app/locales/${locale}.json`)).edit
    for (const key of keys) {
      assert.equal(typeof edit[key], 'string', `${locale}: edit.${key}`)
      assert.ok(edit[key].length > 0, `${locale}: edit.${key}`)
    }
  }
})

test('导出警告镜像后端编码', () => {
  const src = read('app/utils/edit-export-warnings.ts')
  for (const code of ['TRANSITION_HARD_CUT', 'FILTER_UNSUPPORTED', 'TRANSFORM_UNSUPPORTED', 'OVERLAY_UNSUPPORTED']) {
    assert.match(src, new RegExp(code))
  }
})

test('导出音频来源：选择、拦截与来源提示', () => {
  const dialog = read('app/components/edit/EditExportDialog.vue')
  assert.match(dialog, /audioSource/)
  assert.match(dialog, /mixStatus/)
  assert.match(dialog, /mixAligned/)
  assert.match(dialog, /requireAlignedMix/)
  assert.match(dialog, /explicitMixBlocked/)
  assert.match(dialog, /autoRequiresMix/)
  assert.match(dialog, /startBlocked/)
  assert.match(dialog, /audioSource\.value,/)
  assert.match(dialog, /source_warnings/)
  assert.match(dialog, /applyActualAudio/)
  assert.match(dialog, /status\?\.audio_source/)
  assert.match(dialog, /ed-audio-hint/)
  assert.match(dialog, /ed-source-warnings/)
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /:mix-status="topState\.mix_status"/)
  const api = read('app/composables/useApi.ts')
  assert.match(api, /source_warnings/)
  assert.match(api, /audio_source/)
})

test('导出音频来源文案：四语言键齐全', () => {
  const keys = [
    'exportAudioTitle', 'exportAudioHintAutoMix', 'exportAudioHintAutoStaleClip',
    'exportAudioHintAutoClip', 'exportAudioHintAutoSilent', 'exportAudioHintAutoRequire',
    'exportAudioHintMix', 'exportAudioHintMixBlocked', 'exportAudioHintClip',
    'exportAudioHintSilent', 'exportAudioActual', 'exportSourceWarningsTitle',
  ]
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const edit = JSON.parse(read(`app/locales/${locale}.json`)).edit
    for (const key of keys) {
      assert.equal(typeof edit[key], 'string', `${locale}: edit.${key}`)
      assert.ok(edit[key].length > 0, `${locale}: edit.${key}`)
    }
  }
})

test('图片选择器：上传、列表与插入', () => {
  const picker = read('app/components/edit/EditImagePicker.vue')
  assert.match(picker, /editAPI\.uploadImage/)
  assert.match(picker, /emit\('insert'/)
  assert.match(picker, /type="file"/)
})

test('editAPI 新端点与四语言文案', () => {
  const api = read('app/composables/useApi.ts')
  for (const name of ['extractFrame', 'uploadImage', 'render', 'renderStatus']) {
    assert.match(api, new RegExp(`${name}\\(`))
  }
  const zh = JSON.parse(read('app/locales/zh.json'))
  assert.ok(zh.edit.exportTitle)
  assert.ok(zh.edit.exportWarningTitle)
  assert.ok(zh.edit.subtitleBurn)
  assert.ok(zh.edit.imagePickerTitle)
  assert.ok(zh.edit.frameFreezeInserted)
})
