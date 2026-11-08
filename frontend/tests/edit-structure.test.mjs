import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('剪辑页路由、页面与单预览结构', () => {
  const nuxt = read('nuxt.config.ts')
  assert.match(nuxt, /name:\s*'drama-episode-edit'/)
  assert.match(nuxt, /views\/drama\/edit\.vue/)

  const page = read('app/views/drama/edit.vue')
  assert.match(page, /EditWorkbench/)
  assert.match(page, /editAPI\.get/)
  assert.match(page, /definePageMeta\(\{\s*layout:\s*'studio'\s*\}\)/)
  assert.doesNotMatch(page, /MixStage/)

  const names = ['EditWorkbench', 'EditTopBar', 'EditPreview', 'EditTimeline', 'EditClipInspector', 'EditEmptyState']
  const components = names.map((name) => read(`app/components/edit/${name}.vue`))
  // 单预览：主播放器 + 画中画叠加层都在 EditPreview 内，其余剪辑组件不允许出现 <video>
  const nonPreview = [components[0], components[1], components[3], components[4], components[5]].join('\n')
  assert.doesNotMatch(nonPreview, /<video\b/, '预览之外的剪辑组件不允许 <video>（单预览）')
  const previewVideos = components[2].match(/<video\b/g) || []
  assert.equal(previewVideos.length, 2, 'EditPreview 仅主播放器与叠加层各一个 <video>（单预览合成）')
  assert.match(components[2], /defineExpose/)
  assert.doesNotMatch(components[2], /<video[^>]*\bcontrols\b/)
  assert.match(components[2], /defineExpose\(\{\s*seek/)
  assert.match(components[3], /pointerdown/)
  assert.match(components[3], /move-clip/)
  assert.match(components[3], /trim-clip/)
  assert.match(components[3], /split-clip/)
  assert.match(components[3], /move-cue/)
  assert.match(components[3], /emit\('move-clip'/)
  assert.match(components[3], /excludeClipId/)
  assert.match(components[3], /excludeCueId/)
  assert.match(components[3], /height:\s*170px/)
  assert.match(components[3], /props\.readonly && kind !== 'playhead'/)
  assert.match(components[3], /timeline_start_ms/)
  assert.match(components[4], /hashes\.plan_hash/)
})

test('剪辑 API、分集入口与 zh/en/ja/ko 文案', () => {
  const api = read('app/composables/useApi.ts')
  assert.match(api, /export const editAPI/)
  assert.match(api, /\/episodes\/\$\{episodeId\}\/edit/)
  assert.match(api, /edit\/media/)
  assert.match(api, /edit\/draft/)
  assert.match(api, /edit\/revisions/)
  assert.match(api, /edit\/rough-cut/)
  assert.match(api, /edit\/subtitles\/suggest/)
  assert.match(api, /error\.code = json\.code/)

  const episode = read('app/views/drama/episode.vue')
  assert.match(episode, /openEditWorkspace/)
  assert.match(episode, /edit\.entry/)
  assert.match(episode, /Scissors/)

  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    assert.equal(typeof locale.edit?.entry, 'string', `${lang} 缺少 edit.entry`)
    assert.equal(typeof locale.edit?.readonlyHint, 'string', `${lang} 缺少 edit.readonlyHint`)
    assert.equal(typeof locale.edit?.emptyTitle, 'string', `${lang} 缺少 edit.emptyTitle`)
    assert.equal(typeof locale.edit?.mixStale, 'string', `${lang} 缺少 edit.mixStale`)
  }
})

test('S2 素材库、检查器、版本与冲突组件结构', () => {
  const media = read('app/components/edit/EditMediaLibrary.vue')
  assert.match(media, /add-storyboard/)
  assert.match(media, /add-all/)
  assert.match(media, /rough-cut/)
  assert.match(media, /edit\.mediaLibrary/)

  const inspector = read('app/components/edit/EditClipInspector.vue')
  assert.match(inspector, /trim-start/)
  assert.match(inspector, /trim-end/)
  assert.match(inspector, /hashes\.plan_hash/)
  assert.match(inspector, /Math\.ceil\(3000/)
  assert.match(inspector, /linePlacement/)
  assert.match(inspector, /@change="\$emit\('speed'/)
  assert.doesNotMatch(inspector, /@input="\$emit\('speed'/)

  const revisions = read('app/components/edit/EditRevisionsDrawer.vue')
  assert.match(revisions, /revisions/)
  assert.match(revisions, /restore/)
  assert.match(revisions, /edit\.versionTitle/)
  // 初始版本可识别，并提供一键回到最初版本
  assert.match(revisions, /initialRevision/)
  assert.match(revisions, /edit\.versionInitial/)
  assert.match(revisions, /edit\.versionBackToInitial/)
  assert.match(revisions, /edit\.versionDraftHint/)

  const conflict = read('app/components/edit/EditConflictDialog.vue')
  assert.match(conflict, /current_version/)
  assert.match(conflict, /EDIT_VERSION_CONFLICT/)

  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    for (const key of ['mediaLibrary', 'versionTitle', 'conflictTitle', 'deleteClip', 'roughCut']) {
      assert.equal(typeof locale.edit?.[key], 'string', `${lang} 缺少 edit.${key}`)
    }
  }
})

test('S2 工作台集成自动保存、撤销、版本、初剪与快捷键', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  for (const token of [
    'useEditPlan', 'EditSidebar', 'switchFilm', 'EditRevisionsDrawer',
    'EditConflictDialog', 'applyCommand', 'acceptRecovery', 'roughCut',
    'suggestSubtitles', 'onKeydown', 'saveNow',
  ]) {
    assert.match(workbench, new RegExp(token))
  }
  assert.match(workbench, /addEventListener\('keydown'/)
  assert.match(workbench, /recovery/)
  assert.doesNotMatch(workbench, /factory\(plan\.value\)/)
  assert.match(workbench, /Math\.ceil\(3000/)
  assert.match(workbench, /offset < minMs/)
  assert.match(workbench, /refreshDerived/)
  assert.match(workbench, /line_placements: fresh\.line_placements/)
  assert.match(workbench, /@error="onPreviewError"/)
  assert.match(workbench, /revisionsOpen\.value/)
  assert.match(
    workbench,
    /await restoreRevision\(revision\.id\)\s*\n\s*if \(conflict\.value\) return/,
  )
  assert.match(workbench, /duration_ms - 1\)\) seek\(0\)/)

  const top = read('app/components/edit/EditTopBar.vue')
  assert.match(top, /saveStatus/)
  assert.match(top, /undo/)
  assert.match(top, /redo/)
  assert.match(top, /versionTitle/)
  assert.match(top, /suggest-subtitles/)

  const empty = read('app/components/edit/EditEmptyState.vue')
  assert.match(empty, /rough-cut/)
  assert.match(empty, /readonly/)

  const timeline = read('app/components/edit/EditTimeline.vue')
  assert.match(timeline, /maxStart/)
})

test('版本管理：草稿与版本按工程作用域读写，初始版本可一键回退', () => {
  const plan = read('app/composables/useEditPlan.ts')
  assert.match(plan, /initial\.project\?\.id/)
  assert.equal((plan.match(/project_id: projectId/g) || []).length >= 3, true)
  assert.match(plan, /editAPI\.get\(episodeId, projectId \|\| undefined\)/)

  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(
    workbench,
    /editAPI\.revisions\(\s*props\.state\.episode_id,\s*stateProjectId\.value \|\| undefined/,
  )

  const drawer = read('app/components/edit/EditRevisionsDrawer.vue')
  assert.match(drawer, /revision\.is_current && !draftDirty/)
  assert.match(drawer, /versionBackToInitial/)
})

test('S2 四语文案覆盖新增键', () => {
  const keys = [
    'actions', 'addAll', 'addedCountToTimeline', 'addedToTimeline', 'addToTimeline',
    'alreadyAdded', 'audio', 'audioTrack', 'close', 'conflictCopied', 'conflictCopy',
    'conflictCopyFailed', 'conflictCopyHint', 'conflictHint', 'conflictLoadFailed',
    'conflictOverwritten', 'conflictOverwrite', 'conflictReload', 'conflictReloaded',
    'conflictTitle', 'createRevisionFailed', 'deleteClip', 'deleteKeepGap', 'discardConfirm',
    'discarded', 'discardDraft', 'discardFailed', 'emptyEditableHint', 'emptyLibraryHint',
    'fadeIn', 'fadeOut', 'gap', 'importDisabled', 'libraryToggle', 'lineOverflow',
    'linePlacement', 'mediaEmpty', 'mediaLibrary', 'mediaLines', 'mediaLoading',
    'mediaStoryboards', 'mediaTakes', 'mediaUnavailable', 'narration', 'noPreview',
    'noSelection', 'pause', 'play', 'previewFailed', 'readonlyEdit', 'recoveryAccept', 'recoveryDismiss',
    'recoveryHint', 'redo', 'removeTransition', 'restoreConfirm', 'restoreFailed',
    'roughCut', 'roughCutConfirm', 'roughCutDone', 'roughCutFailed', 'roughCutRunning',
    'roughCutSnapshotNote', 'saveConflict', 'saveFailed', 'saveNow', 'savePending',
    'saveRetry', 'saveSaved', 'saveSaving', 'saving', 'searchMedia', 'serverClips',
    'serverVersion', 'shortcutDelete', 'shortcutEscape', 'shortcutHomeEnd', 'shortcutPlay',
    'shortcuts', 'shortcutsTitle', 'shortcutSave', 'shortcutSplit', 'shortcutStep',
    'shortcutUndo', 'snap', 'sourceIn', 'sourceOut', 'speaker', 'split', 'stepBack',
    'stepForward', 'storyboardN', 'subtitleEmpty', 'subtitleHash', 'subtitleSuggest',
    'subtitleSuggestFailed', 'subtitleSuggested', 'subtitleSuggestRunning', 'subtitleTrack',
    'tailGap', 'timelineEmpty', 'transition', 'transitionNone', 'transitionDissolve',
    'transitionWhite', 'transitionPushLeft', 'transitionBlur', 'transitionDuration',
    'transitionGapHint', 'transitionNeedNext', 'transitionPreviewNote', 'undo', 'untitled', 'updatedAt',
    'versionCreate', 'versionCreated', 'versionCurrent', 'versionDefaultNote',
    'versionDirty', 'versionEmpty', 'versionLoadFailed', 'versionNote', 'versionRestore',
    'versionRestored', 'versionTitle', 'versionInitial', 'versionBackToInitial',
    'versionDraftHint', 'videoTrack', 'zoomIn', 'zoomOut',
  ]
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    for (const key of keys) {
      const value = locale.edit?.[key]
      assert.equal(typeof value, 'string', `${lang} 缺少 edit.${key}`)
      assert.ok(value.trim().length > 0, `${lang} edit.${key} 为空`)
    }
  }
})

test('时间线剪辑增强：复制片段、标记与关闭间隙全链路接线', () => {
  const timeline = read('app/components/edit/EditTimeline.vue')
  const workbench = read('app/components/edit/EditWorkbench.vue')
  const commands = read('app/utils/edit-commands.ts')
  const zh = read('app/locales/zh.json')

  assert.match(commands, /export function duplicateClip\(/)
  assert.match(commands, /export function addMarker\(/)
  assert.match(commands, /export function deleteMarker\(/)
  assert.match(commands, /export const DEFAULT_MARKER_COLOR/)

  assert.match(timeline, /duplicate-clip/)
  assert.match(timeline, /add-marker/)
  assert.match(timeline, /delete-marker/)
  assert.match(timeline, /close-gaps/)
  assert.match(timeline, /ed-tl-marker/)
  assert.match(timeline, /openMarkerMenu/)

  assert.match(workbench, /@duplicate-clip="duplicateClipById"/)
  assert.match(workbench, /@add-marker="addMarkerAt"/)
  assert.match(workbench, /@delete-marker="deleteMarkerById"/)
  assert.match(workbench, /@close-gaps="closeAllGaps"/)

  for (const key of ['clipDuplicate', 'markerAdd', 'markerGoto', 'markerDelete', 'closeGaps']) {
    assert.match(zh, new RegExp(`"${key}":`), `zh 缺少 ${key}`)
  }
  for (const locale of ['en', 'ja', 'ko']) {
    const data = read(`app/locales/${locale}.json`)
    for (const key of ['clipDuplicate', 'markerAdd', 'markerGoto', 'markerDelete', 'closeGaps']) {
      assert.match(data, new RegExp(`"${key}":`), `${locale} 缺少 ${key}`)
    }
  }
})

test('转场动效：选择、时长、预览与导出接线', () => {
  const inspector = read('app/components/edit/EditClipInspector.vue')
  const timeline = read('app/components/edit/EditTimeline.vue')
  const workbench = read('app/components/edit/EditWorkbench.vue')
  const commands = read('app/utils/edit-commands.ts')
  const preview = read('app/components/edit/EditPreview.vue')
  const warnings = read('app/utils/edit-export-warnings.ts')

  assert.match(inspector, /TRANSITION_TYPES/)
  assert.match(inspector, /@click="\$emit\('transition-set'/)
  assert.match(inspector, /@click="\$emit\('transition-remove'\)"/)
  assert.match(inspector, /transitionGapHint/)
  assert.match(inspector, /transitionPreviewNote/)

  assert.match(timeline, /emit\('apply-transition'/)
  assert.match(workbench, /@apply-transition="applyTransition"/)
  assert.match(timeline, /transitionMenuItems/)
  assert.match(timeline, /openTransitionMenu/)
  assert.match(timeline, /\{\{ t\('edit\.transition'\) \}\} ▾/)

  assert.match(workbench, /setSelectedTransition/)
  assert.match(workbench, /removeSelectedTransition/)
  assert.match(workbench, /setTransition\(value, payload\.fromClipId, payload\.toClipId/)
  assert.match(commands, /TRANSITION_GAP_BLOCKED/)

  assert.match(preview, /findActiveTransition/)
  assert.match(preview, /ed-transition-snapshot/)
  assert.match(preview, /ed-transition-flash/)

  // 只有失效/不支持的转场才提示硬切，正常转场不再误报
  assert.match(warnings, /isSupportedTransitionType/)
  assert.match(warnings, /hasHardCutTransition/)
})

test('画面闭环：转场 16 种、画面调整、滤镜、片段音量与预览倍速接线', () => {
  const inspector = read('app/components/edit/EditClipInspector.vue')
  const preview = read('app/components/edit/EditPreview.vue')
  const timeline = read('app/components/edit/EditTimeline.vue')
  const workbench = read('app/components/edit/EditWorkbench.vue')
  const commands = read('app/utils/edit-commands.ts')
  const types = read('app/utils/edit-transition-types.ts')

  // 16 种转场类型齐全
  for (const value of ['dissolve', 'white', 'black', 'push-left', 'push-right', 'push-up', 'push-down',
    'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'blur', 'circle-open', 'circle-close', 'radial', 'pixelize']) {
    assert.match(types, new RegExp(`value: '${value}'`))
  }

  // 检查器：画面调整 / 滤镜 / 音频（音量+独立淡入淡出）分区
  assert.match(inspector, /edit\.transformTitle/)
  assert.match(inspector, /edit\.filterTitle/)
  assert.match(inspector, /edit\.audioTitle/)
  assert.match(inspector, /FILTER_PRESETS/)
  assert.match(inspector, /\$emit\('transform-set'/)
  assert.match(inspector, /\$emit\('filter-set'/)
  assert.match(inspector, /\$emit\('volume-set'/)
  assert.match(inspector, /\$emit\('audio-fades'/)
  assert.match(inspector, /\$emit\('project-audio-fades'/)
  assert.match(inspector, /\$emit\('pitch-set'/)
  assert.match(inspector, /\$emit\('effect-set'/)
  assert.match(inspector, /AUDIO_EFFECT_PRESETS/)
  assert.match(inspector, /clipAudioFadeInMs/)
  assert.match(inspector, /clipAudioFadeOutMs/)
  // 音调与特效导出生效，预览不模拟（同滤镜 previewApprox 先例）
  assert.match(inspector, /edit\.audioEffectHint/)
  assert.match(inspector, /max="-12"|min="-12"/)
  // 旧计划缺省音频淡入淡出时回退视频淡入淡出（与导出同口径）
  assert.match(inspector, /audioFadeInMs \?\? clip/)
  assert.match(inspector, /audioFadeOutMs \?\? clip/)
  assert.match(inspector, /max="3000"/, '工程级片头/片尾淡上限 3000ms')

  // 命令与工作台接线
  assert.match(commands, /export function setTransform\(/)
  assert.match(commands, /export function setClipFilter\(/)
  assert.match(commands, /export function setClipVolume\(/)
  assert.match(commands, /export function setClipAudioFades\(/)
  assert.match(commands, /export function setProjectAudioFades\(/)
  assert.match(commands, /export function setClipPitch\(/)
  assert.match(commands, /export function setClipAudioEffect\(/)
  assert.match(workbench, /@transform-set="setSelectedTransform"/)
  assert.match(workbench, /@filter-set="setSelectedFilter"/)
  assert.match(workbench, /@volume-set="setSelectedVolume"/)
  assert.match(workbench, /@audio-fades="setSelectedAudioFades"/)
  assert.match(workbench, /@project-audio-fades="setProjectFades"/)
  assert.match(workbench, /@pitch-set="setSelectedPitch"/)
  assert.match(workbench, /@effect-set="setSelectedAudioEffect"/)
  assert.match(workbench, /cssFilterFor/)
  assert.match(workbench, /cssTransformFor/)

  // 预览：倍速按钮、滤镜/画面 CSS 近似、音量应用、音频淡入淡出增益真实预听
  assert.match(preview, /ed-transport-speed/)
  assert.match(preview, /previewSpeed/)
  assert.match(preview, /speed-set/)
  assert.match(preview, /videoStyle/)
  assert.match(preview, /applyVolume/)
  assert.match(preview, /ensureAudioGraph/)
  assert.match(preview, /audioFadeGainAt/)
  assert.match(preview, /setTargetAtTime/)
  assert.match(preview, /audioFadeInMs \?\? clip/)
  assert.match(preview, /audioFadeOutMs \?\? clip/)

  // 时间线右键前移/后移片段
  assert.match(timeline, /move-prev/)
  assert.match(timeline, /move-next/)
  assert.match(workbench, /@move-clip="moveClipTo"/)

  // 四语文案齐全
  const keys = ['transitionBlack', 'transitionPushRight', 'transitionPushUp', 'transitionPushDown',
    'transitionWipeLeft', 'transitionWipeRight', 'transitionWipeUp', 'transitionWipeDown',
    'transitionCircleOpen', 'transitionCircleClose', 'transitionRadial', 'transitionPixelize',
    'filterTitle', 'filterNone', 'filterClear', 'filterWarm', 'filterCool', 'filterCinematic',
    'filterMono', 'filterVintage', 'filterIntensity', 'transformTitle', 'transformRotate',
    'transformFlipH', 'transformFlipV', 'transformScale', 'transformX', 'transformY', 'transformReset',
    'audioTitle', 'clipVolume', 'mute', 'volumeHint', 'audioFadeIn', 'audioFadeOut',
    'projectFadeIn', 'projectFadeOut', 'projectFadeHint',
    'pitchTitle', 'audioEffect_none', 'audioEffect_denoise', 'audioEffect_echo',
    'audioEffect_reverb', 'audioEffect_telephone', 'audioEffectHint',
    'movePrev', 'moveNext', 'previewSpeed']
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    for (const key of keys) {
      assert.ok(locale.edit?.[key], `${lang} 缺少 edit.${key}`)
    }
  }
})

test('音频可视化：时间线真实波形 + 右键快捷静音 + 按源地址取 peaks', () => {
  const wave = read('app/components/edit/EditAudioWave.vue')
  const timeline = read('app/components/edit/EditTimeline.vue')
  const workbench = read('app/components/edit/EditWorkbench.vue')
  const api = read('app/composables/useApi.ts')

  // 波形组件：editAPI.audioPeaks 拉取 + Promise 缓存 + canvas 绘制 + 层级选择
  assert.match(wave, /editAPI\.audioPeaks/)
  assert.match(wave, /peaksCache/)
  assert.match(wave, /<canvas/)
  assert.match(wave, /fillRect/)
  assert.match(wave, /item\.peaks\.length - target/)
  assert.match(wave, /devicePixelRatio/)

  // 时间线音频轨：逐片段波形块 + 音量/淡标记 + 空态
  assert.match(timeline, /EditAudioWave/)
  assert.match(timeline, /audioClipViews/)
  assert.match(timeline, /ed-tl-audio-clip/)
  assert.match(timeline, /ed-tl-audio-flags/)
  assert.match(timeline, /audioFadeInShort/)
  assert.match(timeline, /audioFadeOutShort/)
  assert.match(timeline, /edit\.audioTrackEmpty/)
  assert.match(timeline, /audioFadeInMs \?\? clip/)
  assert.match(timeline, /episodeId/)

  // 右键快捷静音/取消静音（工具栏下拉共用同一菜单）
  assert.match(timeline, /mute-toggle/)
  assert.match(timeline, /clipVolumeOf/)
  assert.match(timeline, /emit\('clip-volume', \{ clipId, volume: muted \? 1 : 0 \}\)/)
  assert.match(timeline, /edit\.audioMute/)
  assert.match(timeline, /edit\.audioUnmute/)

  // 工作台接线：episode-id 传给时间线，clip-volume 按片段提交命令
  assert.match(workbench, /:episode-id="state\.episode_id"/)
  assert.match(workbench, /@clip-volume="setClipVolumeById"/)
  assert.match(workbench, /setClipVolume\(value, clipId, payload\.volume\)/)

  // API 层：按源地址查询，走后端共享 peaks 缓存
  assert.match(api, /audioPeaks\(episodeId: number, url: string\)/)
  assert.match(api, /\/edit\/audio-peaks\?url=/)

  // 四语文案齐全
  const keys = ['audioMuted', 'audioMute', 'audioUnmute', 'audioTrackEmpty',
    'audioFadeInShort', 'audioFadeOutShort']
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    for (const key of keys) {
      assert.ok(locale.edit?.[key], `${lang} 缺少 edit.${key}`)
    }
  }
})

test('导出预设生效与导出记录导航', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  const sidebar = read('app/components/edit/EditSidebar.vue')
  const episode = read('app/views/drama/episode.vue')
  const renderer = read('../backend/src/services/edit-render-plan.ts')
  const service = read('../backend/src/services/edit-export-service.ts')
  const warnings = read('app/utils/edit-export-warnings.ts')
  const zh = JSON.parse(read('app/locales/zh.json'))

  // 预设覆盖尺寸与码率，导出服务传预设并按覆盖后的计划生成烧录字幕
  assert.match(renderer, /resolveExportPlan/)
  assert.match(renderer, /videoArgs\(preset\)/)
  assert.match(renderer, /audioArgs\(preset\)/)
  assert.match(renderer, /atempoChain/)
  assert.match(service, /EXPORT_PRESETS\[ctx\.preset/)
  assert.match(service, /buildEditAss\(resolveExportPlan\(ctx\.plan, presetDef\)\)/)
  assert.match(service, /preset: presetDef/)

  // 前端降级清单与后端 0.25–4× 变速范围一致
  assert.match(warnings, /< 0\.25 \|\| \(Number\(clip\.speed\) \|\| 1\) > 4/)
  assert.match(zh.edit.exportWarnSpeed, /0\.25–4×/)

  // 命令成功后提示首条 warning（转场裁剪/淡入淡出缩短等不再静默）
  assert.match(workbench, /const warned = result\?\.issues\?\.find\(\(item\) => item\.severity === 'warning'\)/)

  // 侧栏：无重复「预览」项；查看导出记录直达剧集页导出阶段（query 而非失效的 #exports 哈希）
  assert.doesNotMatch(sidebar, /key: 'preview'/)
  assert.match(workbench, /@open-exports="openExports"/)
  assert.match(workbench, /panel: 'export'/)
  assert.match(episode, /q\.panel === 'export'/)

  // 侧栏开关文案与面板一致（成片列表，不再是素材库）
  const en = JSON.parse(read('app/locales/en.json'))
  const ja = JSON.parse(read('app/locales/ja.json'))
  const ko = JSON.parse(read('app/locales/ko.json'))
  assert.equal(zh.edit.libraryToggle, '成片列表')
  assert.equal(en.edit.libraryToggle, 'Films')
  assert.equal(ja.edit.libraryToggle, '完成映像')
  assert.equal(ko.edit.libraryToggle, '완성 영상')
})

test('叠加轨：时间线轨道、检查器、预览合成与工作台接线', () => {
  const timeline = read('app/components/edit/EditTimeline.vue')
  const preview = read('app/components/edit/EditPreview.vue')
  const inspector = read('app/components/edit/EditClipInspector.vue')
  const workbench = read('app/components/edit/EditWorkbench.vue')
  const commands = read('app/utils/edit-overlay-commands.ts')

  // 命令全链路：增删改 + 画面/不透明度/淡入淡出/文字样式
  assert.match(commands, /export function createVideoOverlay\(/)
  assert.match(commands, /export function createImageOverlay\(/)
  assert.match(commands, /export function createTextOverlay\(/)
  assert.match(commands, /export function moveOverlay\(/)
  assert.match(commands, /export function trimOverlay\(/)
  assert.match(commands, /export function setOverlayTransform\(/)
  assert.match(commands, /export function setOverlayOpacity\(/)
  assert.match(commands, /export function setOverlayFades\(/)
  assert.match(commands, /export function setOverlayText\(/)
  assert.match(commands, /export function removeOverlay\(/)

  // 时间线：画中画菜单 + 叠加轨道与拖拽/裁剪/右键
  assert.match(timeline, /edit\.overlayMenu/)
  assert.match(timeline, /overlay-insert/)
  assert.match(timeline, /select-overlay/)
  assert.match(timeline, /move-overlay/)
  assert.match(timeline, /trim-overlay/)
  assert.match(timeline, /remove-overlay/)
  assert.match(timeline, /ed-tl-overlay/)

  // 预览：叠加合成层（视频/图片/文字）与多元素时钟同步
  assert.match(preview, /ed-overlay-layer/)
  assert.match(preview, /setOverlayVideoRef/)
  assert.match(preview, /syncOverlayVideos/)
  assert.match(preview, /selectedOverlayId/)

  // 检查器：overlay 编辑页与事件
  assert.match(inspector, /overlay: \{ type: Object, default: null \}/)
  assert.match(inspector, /'overlay-time'/)
  assert.match(inspector, /'overlay-transform'/)
  assert.match(inspector, /'overlay-text'/)

  // 工作台接线：选择器复用（一套），落点由 pendingOverlayKind 决定
  assert.match(workbench, /@overlay-insert="onOverlayInsert"/)
  assert.match(workbench, /@move-overlay="moveOverlayTo"/)
  assert.match(workbench, /@trim-overlay="trimOverlayTo"/)
  assert.match(workbench, /@remove-overlay="removeOverlayById"/)
  assert.match(workbench, /pendingOverlayKind/)
  assert.match(workbench, /createTextOverlay/)

  // 叠加轨真实导出：降级清单不再有 OVERLAY_UNSUPPORTED
  const warnings = read('app/utils/edit-export-warnings.ts')
  assert.doesNotMatch(warnings, /OVERLAY_UNSUPPORTED/)

  const keys = ['overlayMenu', 'overlayTrack', 'overlayEmpty', 'overlayKindVideo', 'overlayKindImage',
    'overlayKindText', 'overlayInsertVideo', 'overlayInsertImage', 'overlayInsertText', 'overlayGoto',
    'overlayDelete', 'overlayWindow', 'overlayPicture', 'overlayScale', 'overlayTextStyle', 'overlayTextBg',
    'overlayTextPosition', 'overlayOpacity', 'overlayFades', 'overlayFadeHint', 'overlayDefaultText']
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    for (const key of keys) {
      assert.ok(locale.edit?.[key], `${lang} 缺少 edit.${key}`)
    }
  }
})
