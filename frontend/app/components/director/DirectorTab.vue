<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Loader2, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import StudioEmptyState from '~/components/studio/StudioEmptyState.vue'
import DirectorTopBar from '~/components/director/DirectorTopBar.vue'
import DirectorWorkbench from '~/components/director/DirectorWorkbench.vue'
import DirectorApplyDialog from '~/components/director/DirectorApplyDialog.vue'
import { useDirectorPlan } from '~/composables/useDirectorPlan'
import { useAgentSettings } from '~/composables/useAgentSettings'
import { openAgentDock } from '~/composables/useAgentPageAdapter'
import type { DirectorApplyResult, DirectorRevisionSummary } from '~/composables/useApi'

const props = defineProps<{
  episodeId: number
  episodeTitle?: string
  characters?: any[]
  scenes?: any[]
  initialView?: '2d' | '3d'
  focusStoryboardId?: number | null
}>()

const emit = defineEmits<{ 'open-videos': []; 'back-to-drama': [] }>()

const { t } = useI18n()
const { agentSettings, loadAgentSettings } = useAgentSettings()
const directorAgentEnabled = computed(() => agentSettings.value?.director.enabled === true)

const {
  plan,
  shots,
  storyboards,
  version,
  mode,
  canEdit,
  view3dEnabled,
  defaultView,
  previsMaxAssets,
  durationRange,
  loading,
  errorStatus,
  errorMessage,
  warnings,
  dirty,
  saveStatus,
  saveError,
  lastSavedAt,
  conflictKind,
  conflictInfo,
  canApply,
  mismatchedSubshotShots,
  applySettings,
  applying,
  applyConflictPending,
  staleShotIds,
  revisions,
  revisionsLoading,
  revisionsError,
  load,
  save,
  retrySave,
  loadRevisions,
  restoreRevision,
  applyPlan,
  realignBaseline,
  applyShotPatch,
  applyBlockingPatch,
  setSubshots,
  dispose,
} = useDirectorPlan()

const view = ref<'2d' | '3d'>('2d')
const selectedShotId = ref<number | null>(null)
const selectedEntity = ref<{ type: 'character' | 'camera'; characterId?: number } | null>(null)
const revisionsOpen = ref(false)
const saveNote = ref('')
const applyOpen = ref(false)
const applyResult = ref<DirectorApplyResult | null>(null)
const applyError = ref<any>(null)
const stage3dError = ref<{ reason: 'load-failed' | 'webgl-unavailable' | 'context-lost' | 'render-failed'; detail?: string } | null>(null)
const stage3dRetried = ref(false)
const stage3dKey = ref(0)
const realigning = ref(false)
let initialViewApplied = false

const normalizedCharacters = computed(() => (props.characters || []).map((item: any) => ({
  id: Number(item.id),
  name: String(item.name || ''),
  imageUrl: imageUrl(item.image_url || item.imageUrl),
})))

const normalizedScenes = computed(() => (props.scenes || []).map((item: any) => ({
  id: Number(item.id),
  location: String(item.location || ''),
  imageUrl: imageUrl(item.image_url || item.imageUrl),
})))

const workbenchShots = computed(() => {
  const boardMap = new Map<number, any>(storyboards.value.map((item) => [Number(item.id), item]))
  return shots.value.map((shot) => {
    const board = boardMap.get(Number(shot.storyboard_id))
    return {
      ...shot,
      has_video: Boolean(board?.has_video),
      board_duration: Number(board?.duration ?? 0),
    }
  })
})

const applyBlockedReason = computed(() => {
  if (!canEdit.value) return t('director.apply.blockedReadonly')
  if (conflictKind.value) return t('director.apply.blockedConflict')
  if (applyConflictPending.value) return t('director.apply.blockedApplyConflict')
  if (saveStatus.value === 'saving') return t('director.apply.blockedSaving')
  if (version.value <= 0) return t('director.apply.blockedNotSaved')
  if (mismatchedSubshotShots.value.length > 0) {
    return t('director.apply.blockedMismatchShots', { shots: mismatchedSubshotShots.value.join(', ') })
  }
  if (!shots.value.length) return t('director.apply.blockedNoShotsInPlan')
  return ''
})

// 版本冲突未处理前禁止继续编辑，避免把新的修改叠在已过期的基线上。
const effectiveCanEdit = computed(() => canEdit.value && !conflictKind.value)
const canReadRevisions = computed(() => canEdit.value || version.value > 0)

const errorTitle = computed(() => {
  if (errorStatus.value === 403) return t('director.error.closedTitle')
  if (errorStatus.value === 404) return t('director.error.notFoundTitle')
  return t('director.error.failedTitle')
})

const errorDescription = computed(() => {
  if (errorStatus.value === 403) return t('director.error.closedDesc')
  if (errorStatus.value === 404) return t('director.error.notFoundDesc')
  return errorMessage.value || t('director.error.failedDesc')
})

const conflictTitle = computed(() => (
  conflictKind.value === 'shot-count'
    ? t('director.save.shotCountConflictTitle')
    : t('director.save.versionConflictTitle')
))

const conflictDescription = computed(() => {
  if (conflictKind.value === 'shot-count') {
    return t('director.save.shotCountConflictDesc', {
      current: Number(conflictInfo.value?.current_count ?? '-'),
      doc: Number(conflictInfo.value?.doc_count ?? '-'),
    })
  }
  return t('director.save.versionConflictDesc')
})

function imageUrl(raw: unknown): string {
  const value = String(raw || '')
  if (!value) return ''
  if (/^https?:\/\//i.test(value) || value.startsWith('/')) return value
  return `/${value}`
}

function formatTime(value: unknown): string {
  const text = String(value || '')
  if (!text) return '—'
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString()
}

function resetSelection() {
  selectedShotId.value = null
  selectedEntity.value = null
}

function keepSelectionIfPresent() {
  if (selectedShotId.value == null) return
  if (!shots.value.some((shot) => Number(shot.storyboard_id) === selectedShotId.value)) {
    resetSelection()
  }
}

async function loadEpisode(id: number) {
  if (!id) return
  await load(id)
  keepSelectionIfPresent()
  if (!errorStatus.value) {
    applyFocusShot()
    applyInitialView()
  }
}

function applyFocusShot() {
  const id = Number(props.focusStoryboardId)
  if (!Number.isSafeInteger(id) || id <= 0) return
  if (!shots.value.some((shot) => Number(shot.storyboard_id) === id)) return
  selectedEntity.value = null
  selectedShotId.value = id
}

function openDirectorAgent() {
  openAgentDock('director')
}

function selectShot(shotId: number) {
  if (selectedShotId.value !== shotId) selectedEntity.value = null
  selectedShotId.value = shotId
}

function selectEntity(entity: { type: 'character' | 'camera'; characterId?: number } | null) {
  selectedEntity.value = entity
}

function reportSaveResult(ok: boolean) {
  if (ok) {
    toast.success(t('director.save.savedToast'))
    saveNote.value = ''
    if (revisionsOpen.value) void loadRevisions()
  } else if (saveStatus.value === 'conflict') {
    toast.error(t('director.save.conflictToast'))
  } else if (saveStatus.value === 'error') {
    toast.error(t('director.save.failedToast', {
      message: saveError.value || t('director.error.failedDesc'),
    }))
  }
}

async function manualSave() {
  if (!effectiveCanEdit.value) return
  reportSaveResult(await save(true, saveNote.value))
}

async function retryManualSave() {
  if (!effectiveCanEdit.value) return
  reportSaveResult(await retrySave())
}

function openApply() {
  if (!effectiveCanEdit.value || !canApply.value) return
  applyResult.value = null
  applyError.value = null
  applyOpen.value = true
}

function closeApply() {
  if (applying.value) return
  applyOpen.value = false
  applyResult.value = null
  applyError.value = null
}

async function runApply(payload: {
  storyboard_ids: number[]
  fields: ('shot_type' | 'angle' | 'movement' | 'duration')[]
  append_prompt: boolean
  sync_subshots: boolean
}) {
  if (!effectiveCanEdit.value) return
  applyError.value = null
  try {
    const result = await applyPlan(payload)
    applyResult.value = result
    toast.success(t('director.apply.toastSuccess', {
      applied: result.applied.length,
      skipped: result.skipped.length,
    }))
    if (result.stale.length) {
      toast.info(t('director.apply.toastStale', { count: result.stale.length }))
    }
  } catch (error: any) {
    applyError.value = error || { message: '' }
    if (String(error?.code || '') !== 'DIRECTOR_STORYBOARD_CONFLICT') {
      toast.error(t('director.apply.toastFailed', { message: String(error?.message || '') }))
    }
  }
}

async function reloadAfterApplyConflict() {
  applyOpen.value = false
  applyResult.value = null
  applyError.value = null
  await loadEpisode(Number(props.episodeId))
  if (!errorStatus.value) toast.success(t('director.apply.reloaded'))
}

async function realignAfterConflict() {
  if (!effectiveCanEdit.value || realigning.value) return
  if (!window.confirm(t('director.apply.realignConfirm'))) return
  realigning.value = true
  try {
    const ok = await realignBaseline()
    if (ok) {
      applyOpen.value = false
      applyResult.value = null
      applyError.value = null
      toast.success(t('director.apply.realigned'))
    } else {
      toast.error(t('director.apply.realignFailed', {
        message: saveError.value || t('director.error.failedDesc'),
      }))
    }
  } finally {
    realigning.value = false
  }
}

function viewStoryboards() {
  closeApply()
  emit('open-videos')
}

async function reloadFromConflict() {
  await loadEpisode(Number(props.episodeId))
  if (!errorStatus.value) toast.success(t('director.save.reloaded'))
}

function openRevisions() {
  if (!canReadRevisions.value) return
  revisionsOpen.value = true
  void loadRevisions()
}

async function restore(revision: DirectorRevisionSummary) {
  if (!effectiveCanEdit.value) return
  if (!window.confirm(t('director.revisions.restoreConfirm', { version: revision.revision_no }))) return
  try {
    await restoreRevision(revision.id)
    keepSelectionIfPresent()
    toast.success(t('director.revisions.restored', { version: revision.revision_no }))
    await loadRevisions()
  } catch (error: any) {
    toast.error(t('director.revisions.restoreFailed', {
      message: String(error?.message || ''),
    }))
  }
}

function applyInitialView() {
  if (initialViewApplied) return
  initialViewApplied = true
  const requested = props.initialView ?? (view3dEnabled.value ? defaultView.value : '2d')
  if (requested !== '3d') {
    view.value = '2d'
    return
  }
  if (view3dEnabled.value) {
    view.value = '3d'
    return
  }
  view.value = '2d'
  toast.info(t('director.stage.view3dUnavailable'))
}

function changeView(next: '2d' | '3d') {
  if (next === '3d' && !view3dEnabled.value) {
    toast.info(t('director.stage.view3dUnavailable'))
    return
  }
  view.value = next
  if (next === '3d') {
    stage3dError.value = null
    stage3dRetried.value = false
  }
}

function handleStage3dFallback(
  reason: 'load-failed' | 'webgl-unavailable' | 'context-lost' | 'render-failed',
  detail?: string,
) {
  view.value = '2d'
  stage3dError.value = { reason, detail }
}

function retryStage3d() {
  if (!view3dEnabled.value || stage3dRetried.value) return
  stage3dRetried.value = true
  stage3dError.value = null
  stage3dKey.value += 1
  view.value = '3d'
}

function dismissStage3dError() {
  stage3dError.value = null
}

const stage3dErrorText = computed(() => {
  const error = stage3dError.value
  if (!error) return ''
  if (error.reason === 'webgl-unavailable') return t('director.stage3d.webglUnavailable')
  if (error.reason === 'context-lost') return t('director.stage3d.contextLost')
  if (error.reason === 'render-failed') return t('director.stage3d.renderFailed', { message: error.detail || '—' })
  return t('director.stage3d.loadFailed', { message: error.detail || '—' })
})

function beforeUnload(event: BeforeUnloadEvent) {
  if (!canEdit.value || (!dirty.value && saveStatus.value !== 'saving')) return
  event.preventDefault()
  event.returnValue = ''
}

watch(() => props.episodeId, (id) => {
  resetSelection()
  revisionsOpen.value = false
  applyOpen.value = false
  applyResult.value = null
  applyError.value = null
  stage3dError.value = null
  stage3dRetried.value = false
  stage3dKey.value += 1
  initialViewApplied = false
  view.value = '2d'
  void loadEpisode(Number(id))
}, { immediate: true })

watch(() => props.focusStoryboardId, () => {
  applyFocusShot()
})

// 深链或建议在同一页面内切换 view 时也要生效，而不是只认首次挂载。
watch(() => props.initialView, (next) => {
  if (next !== '2d' && next !== '3d') return
  if (next === '3d' && !view3dEnabled.value) {
    view.value = '2d'
    toast.info(t('director.stage.view3dUnavailable'))
    return
  }
  view.value = next
  if (next === '3d') {
    stage3dError.value = null
    stage3dRetried.value = false
  }
})

onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  void loadAgentSettings()
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload)
  dispose()
})
</script>

<template>
  <section class="director-tab">
    <DirectorTopBar
      :title="props.episodeTitle || t('director.tab.label')"
      :mode="mode"
      :can-edit="canEdit"
      :version="version"
      :view="view"
      :view3d-enabled="view3dEnabled"
      :save-status="saveStatus"
      :save-error="saveError"
      :note="saveNote"
      :last-saved-at="lastSavedAt"
      :can-apply="canApply"
      :applying="applying"
      :apply-blocked-reason="applyBlockedReason"
      :director-agent-enabled="directorAgentEnabled"
      @update:view="changeView"
      @update:note="saveNote = $event"
      @save="manualSave"
      @retry="retryManualSave"
      @open-revisions="openRevisions"
      @open-apply="openApply"
      @open-director-agent="openDirectorAgent"
    />

    <div v-if="conflictKind" class="director-conflict" role="alert">
      <AlertTriangle :size="15" />
      <div class="director-conflict-text">
        <b>{{ conflictTitle }}</b>
        <span>{{ conflictDescription }}</span>
      </div>
      <button type="button" class="director-btn is-primary" @click="reloadFromConflict">
        {{ t('director.save.reload') }}
      </button>
    </div>

    <div v-else-if="applyConflictPending && !applyOpen" class="director-conflict" role="alert">
      <AlertTriangle :size="15" />
      <div class="director-conflict-text">
        <b>{{ t('director.apply.conflictTitle') }}</b>
        <span>{{ t('director.apply.conflictBannerDesc') }}</span>
      </div>
      <button type="button" class="director-btn is-primary" :disabled="realigning" @click="realignAfterConflict">
        {{ t('director.apply.realign') }}
      </button>
      <button type="button" class="director-btn" :disabled="realigning" @click="reloadAfterApplyConflict">
        {{ t('director.save.reload') }}
      </button>
    </div>

    <div v-if="stage3dError" class="director-conflict" role="alert">
      <AlertTriangle :size="15" />
      <div class="director-conflict-text">
        <b>{{ t('director.stage3d.fallbackTitle') }}</b>
        <span>{{ stage3dErrorText }}</span>
      </div>
      <button v-if="!stage3dRetried" type="button" class="director-btn" @click="retryStage3d">
        {{ t('director.stage3d.retry') }}
      </button>
      <button type="button" class="director-btn" @click="dismissStage3dError">
        {{ t('director.stage3d.dismiss') }}
      </button>
    </div>

    <div v-if="loading" class="director-state">
      <Loader2 :size="20" class="animate-spin" />
      <span>{{ t('director.loading') }}</span>
    </div>

    <div v-else-if="errorStatus" class="director-state">
      <StudioEmptyState
        :title="errorTitle"
        :description="errorDescription"
        :action-label="errorStatus === 404 ? t('director.error.backToDrama') : (errorStatus === 403 ? undefined : t('director.error.retry'))"
        @action="errorStatus === 404 ? emit('back-to-drama') : loadEpisode(Number(props.episodeId))"
      />
    </div>

    <template v-else-if="plan">
      <div v-if="warnings.length" class="director-warnings">
        <AlertTriangle :size="14" />
        <ul>
          <li v-for="(warning, index) in warnings" :key="index">{{ warning }}</li>
        </ul>
      </div>
      <div v-if="!shots.length" class="director-state">
        <StudioEmptyState
          :title="t('director.empty.noShotsTitle')"
          :description="t('director.empty.noShotsDesc')"
          :action-label="t('director.empty.goVideos')"
          @action="emit('open-videos')"
        />
      </div>
      <DirectorWorkbench
        v-else
        :shots="workbenchShots"
        :scenes="normalizedScenes"
        :characters="normalizedCharacters"
        :selected-shot-id="selectedShotId"
        :selected-entity="selectedEntity"
        :view="view"
        :can-edit="effectiveCanEdit"
        :duration-min="durationRange.min"
        :duration-max="durationRange.max"
        :stale-ids="staleShotIds"
        :previs-max-assets="previsMaxAssets"
        :stage3d-key="stage3dKey"
        @select-shot="selectShot"
        @select-entity="selectEntity"
        @update-shot="applyShotPatch($event.storyboardId, $event.patch)"
        @update-blocking="applyBlockingPatch($event.storyboardId, $event.characterId, $event.patch)"
        @update-subshots="setSubshots($event.storyboardId, $event.subshots)"
        @stage3d-fallback="handleStage3dFallback"
      />
    </template>

    <div v-if="revisionsOpen" class="director-revisions-mask" @click.self="revisionsOpen = false">
      <aside class="director-revisions" role="dialog" :aria-label="t('director.revisions.title')">
        <header class="director-revisions-head">
          <div class="director-revisions-title">
            <b>{{ t('director.revisions.title') }}</b>
            <span v-if="revisions.length" class="director-revisions-count">
              {{ t('director.revisions.count', { count: revisions.length }) }}
            </span>
          </div>
          <button type="button" class="director-icon-btn" :title="t('director.revisions.close')" :aria-label="t('director.revisions.close')" @click="revisionsOpen = false">
            <X :size="13" />
          </button>
        </header>
        <div class="director-revisions-body">
          <div v-if="revisionsLoading" class="director-revisions-state">
            <Loader2 :size="14" class="animate-spin" />
            <span>{{ t('director.loading') }}</span>
          </div>
          <p v-else-if="revisionsError" class="director-revisions-state is-error">
            {{ t('director.revisions.loadFailed', { message: revisionsError }) }}
          </p>
          <p v-else-if="!revisions.length" class="director-revisions-state">
            {{ t('director.revisions.empty') }}
          </p>
          <ul v-else class="director-revision-list">
            <li
              v-for="revision in revisions"
              :key="revision.id"
              :class="['director-revision', { 'is-current': revision.is_current }]"
            >
              <div class="director-revision-head">
                <b>v{{ revision.revision_no }}</b>
                <span v-if="revision.is_current" class="director-revision-badge">{{ t('director.revisions.current') }}</span>
                <time>{{ formatTime(revision.created_at) }}</time>
              </div>
              <p class="director-revision-note">
                <span class="director-revision-note-label">{{ t('director.revisions.note') }}:</span>
                {{ revision.note || t('director.revisions.noNote') }}
              </p>
              <button
                v-if="effectiveCanEdit && !revision.is_current"
                type="button"
                class="director-btn"
                @click="restore(revision)"
              >
                {{ t('director.revisions.restore') }}
              </button>
            </li>
          </ul>
        </div>
      </aside>
    </div>

    <DirectorApplyDialog
      v-if="applyOpen"
      :shots="workbenchShots"
      :apply-settings="applySettings"
      :base-version="version"
      :mismatched-shots="mismatchedSubshotShots"
      :can-apply="canApply"
      :apply-blocked-reason="applyBlockedReason"
      :applying="applying"
      :unsaved-plan="dirty"
      :result="applyResult"
      :error="applyError"
      @close="closeApply"
      @apply="runApply"
      @reload="reloadAfterApplyConflict"
      @realign="realignAfterConflict"
      @view-storyboards="viewStoryboards"
    />
  </section>
</template>

<style scoped>
.director-tab {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--bg-0);
}
.director-state {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-2);
  font-size: var(--text-label);
}
.director-warnings {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-shrink: 0;
  max-height: 76px;
  overflow-y: auto;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--warning-soft, rgba(217, 152, 38, 0.1));
  color: var(--warning, #b7791f);
  font-size: var(--text-meta);
}
.director-warnings svg { flex-shrink: 0; margin-top: 2px; }
.director-warnings ul { margin: 0; padding-left: 14px; line-height: 1.55; }
.director-warnings li + li { margin-top: 1px; }
.director-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: var(--control-sm);
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  color: var(--text-1);
  font-size: var(--text-meta);
  cursor: pointer;
  flex-shrink: 0;
}
.director-btn:hover { border-color: var(--accent); color: var(--text-0); }
.director-btn.is-primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast, #fff);
}
.director-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-xs);
  height: var(--control-xs);
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  color: var(--text-1);
  cursor: pointer;
}
.director-icon-btn:hover { background: var(--bg-hover); color: var(--text-0); }
.director-conflict {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 8px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--warning, #b7791f) 36%, var(--border));
  background: var(--warning-soft, rgba(217, 152, 38, 0.1));
  color: var(--warning, #b7791f);
  font-size: var(--text-meta);
}
.director-conflict svg { flex-shrink: 0; }
.director-conflict-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.director-conflict-text b { font-size: var(--text-label); }
.director-conflict-text span { color: var(--text-1); line-height: 1.45; }
.director-revisions-mask {
  position: absolute;
  inset: 0;
  z-index: 100;
  display: flex;
  justify-content: flex-end;
  background: rgba(0, 0, 0, 0.28);
}
.director-revisions {
  display: flex;
  flex-direction: column;
  width: 340px;
  max-width: 86vw;
  height: 100%;
  border-left: 1px solid var(--border);
  background: var(--panel-bg);
  box-shadow: var(--shadow-lg, -8px 0 24px rgba(0, 0, 0, 0.18));
}
.director-revisions-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.director-revisions-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; font-size: var(--text-label); color: var(--text-0); }
.director-revisions-count { font-size: var(--text-meta); color: var(--text-2); }
.director-revisions-body { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 0 12px; }
.director-revisions-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px 12px;
  color: var(--text-2);
  font-size: var(--text-meta);
  text-align: center;
}
.director-revisions-state.is-error { color: var(--action-danger, #c0392b); }
.director-revision-list { margin: 0; padding: 0; list-style: none; }
.director-revision {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.director-revision.is-current { background: var(--accent-soft, rgba(88, 166, 255, 0.08)); }
.director-revision-head { display: flex; align-items: center; gap: 6px; width: 100%; font-size: var(--text-label); color: var(--text-0); }
.director-revision-head time { margin-left: auto; font-size: var(--text-meta); color: var(--text-2); font-variant-numeric: tabular-nums; }
.director-revision-badge {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--accent-contrast, #fff);
  font-size: 11px;
  line-height: 1.6;
}
.director-revision-note { margin: 0; width: 100%; font-size: var(--text-meta); line-height: 1.5; color: var(--text-2); word-break: break-word; }
.director-revision-note-label { color: var(--text-2); }
.director-tab :is(button, input, select, textarea):focus-visible { outline: none; box-shadow: var(--focus-ring); }
</style>
