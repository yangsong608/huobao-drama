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
  const videos = components.join('\n').match(/<video\b/g) || []
  assert.equal(videos.length, 1, '剪辑组件只允许一个 <video>')
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
  assert.match(components[3], /height:\s*140px/)
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
    'useEditPlan', 'useEditMedia', 'EditMediaLibrary', 'EditRevisionsDrawer',
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
    'tailGap', 'timelineEmpty', 'transition', 'undo', 'untitled', 'updatedAt',
    'versionCreate', 'versionCreated', 'versionCurrent', 'versionDefaultNote',
    'versionDirty', 'versionEmpty', 'versionLoadFailed', 'versionNote', 'versionRestore',
    'versionRestored', 'versionTitle', 'videoTrack', 'zoomIn', 'zoomOut',
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
