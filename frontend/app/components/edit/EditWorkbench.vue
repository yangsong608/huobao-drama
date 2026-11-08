<template>
  <div class="ed-workbench">
    <EditTopBar
      :state="topState"
      :episode-label="episodeLabel"
      :save-status="saveStatus"
      :dirty="dirty"
      :can-undo="canUndo"
      :can-redo="canRedo"
      :can-edit="canEdit"
      :legacy="Boolean(topState.legacy_project)"
      :rough-cut-busy="roughCutBusy"
      :subtitle-busy="subtitleBusy"
      :show-agent="showAgent"
      @back="$emit('back')"
      @undo="undo"
      @redo="redo"
      @save="saveImmediately"
      @discard="discardDraft"
      @open-revisions="openRevisions"
      @rough-cut="runRoughCut"
      @suggest-subtitles="runSubtitleSuggest"
      @open-export="openExportDialog"
      @go-mix="openMixWorkbench"
      @shortcuts="shortcutsOpen = true"
      @toggle-media="toggleMediaPanel"
      @toggle-subtitles="subtitlesOpen = !subtitlesOpen"
      @open-agent="$emit('open-agent')"
    />

    <div v-if="saveStatus === 'error'" class="ed-banner is-error">
      <span>{{ saveError || t('edit.saveFailed') }}</span>
      <button type="button" @click="saveImmediately">{{ t('edit.saveRetry') }}</button>
    </div>
    <div v-if="recovery && canEdit" class="ed-banner is-warning">
      <span>{{ t('edit.recoveryHint', { time: formatWhen(recovery.savedAt) }) }}</span>
      <button type="button" @click="useRecovery">{{ t('edit.recoveryAccept') }}</button>
      <button class="is-muted" type="button" @click="dismissRecovery">{{ t('edit.recoveryDismiss') }}</button>
    </div>
    <div v-if="timelineMessage" class="ed-banner is-info">
      <span>{{ timelineMessage }}</span>
      <button class="is-muted" type="button" @click="clearMessage">×</button>
    </div>

    <div class="ed-main" :class="{ 'is-empty': !plan.clips.length, 'is-media-open': mediaOpen }">
      <aside class="ed-left">
        <div class="ed-left-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            :class="{ 'is-on': leftTab === 'media' }"
            :aria-selected="leftTab === 'media'"
            @click="leftTab = 'media'"
          >
            {{ t('edit.mediaLibrary') }}
          </button>
          <button
            type="button"
            role="tab"
            :class="{ 'is-on': leftTab === 'films' }"
            :aria-selected="leftTab === 'films'"
            @click="leftTab = 'films'"
          >
            {{ t('edit.filmsPanelTitle') }}
          </button>
        </div>
        <EditMediaLibrary
          v-if="leftTab === 'media'"
          class="ed-left-body"
          :media="media"
          :loading="mediaLoading"
          :error="mediaError"
          :readonly="!canEdit"
          :used-storyboard-ids="usedStoryboardIds"
          :rough-cut-available="topState.rough_cut_available"
          :can-replace="Boolean(selectedClipId)"
          @add-storyboard="addStoryboard"
          @add-all="addAllStoryboards"
          @replace-clip="replaceSelectedClip"
          @rough-cut="runRoughCut"
          @retry="loadMedia"
        />
        <EditSidebar
          v-else
          class="ed-left-body"
          :films="films"
          :loading="filmsLoading"
          :current-film-id="currentFilmId"
          :active-film-id="activeFilmId"
          :can-edit="canEdit"
          @open="switchFilm"
          @refresh="loadFilms"
          @rename="renameFilm"
          @remove="removeFilm"
          @set-current="setCurrentFilm"
          @open-mix="openFilmInMix"
          @open-exports="$emit('back')"
          @new-concat="goNewConcat"
        />
      </aside>

      <section class="ed-stage">
        <EditEmptyState
          v-if="!plan.clips.length"
          :readonly="!canEdit"
          :rough-cut-available="topState.rough_cut_available"
          :busy="actionBusy"
          @rough-cut="runRoughCut"
          @back="$emit('back')"
        />
        <template v-else>
          <EditPreview
            ref="previewRef"
            :src="previewSrc"
            :poster="poster"
            :plan="plan"
            :active-clip-id="previewClipId"
            :clip-key="clipKey"
            :source-ms="sourceMs"
            :current-ms="currentMs"
            :duration-ms="layout.duration_ms"
            :fps="plan.project.fps"
            :playing="playing"
            :audio-mode="audioMode"
            :audio-banner="audioBanner"
            :playback-rate="playbackRate"
            :layout="layout"
            :selected-cue-id="selectedCueId"
            :show-safe-area="showSafeArea"
            @toggle="togglePlayback"
            @seek="seek"
            @step="stepFrame"
            @ended="onClipEnded"
            @error="onPreviewError"
            @select-cue="selectCue"
          />
          <EditTimeline
            ref="timelineRef"
            :plan="plan"
            :layout="layout"
            :current-ms="currentMs"
            :selected-clip-id="selectedClipId"
            :selected-cue-id="selectedCueId"
            :readonly="!canEdit"
            :audio-mode="audioMode === 'mix' ? 'video' : audioMode"
            :show-subtitles="showSubtitles"
            :context-menu="uxEnabled('contextMenu')"
            :show-markers="uxEnabled('markers')"
            @seek="seek"
            @select-clip="selectClip"
            @select-cue="selectCue"
            @move-clip="moveClipTo"
            @trim-clip="trimClip"
            @split-clip="splitAt"
            @clip-op="onClipOp"
            @move-cue="moveCueTo"
            @remove-transition="removeTransitionById"
            @frame-op="onFrameOp"
            @cue-op="onCueOp"
            @toggle-subtitles="showSubtitles = !showSubtitles"
            @fit-view="fitView"
            @open-subtitles="subtitlesOpen = true"
            @remove-clip="removeClipById"
            @duplicate-clip="duplicateClipById"
            @add-marker="addMarkerAt"
            @delete-marker="deleteMarkerById"
            @close-gaps="closeAllGaps"
          />
        </template>
      </section>

      <EditClipInspector
        v-if="plan.clips.length"
        :plan="plan"
        :layout="layout"
        :clip-id="selectedClipId"
        :placement="selectedPlacement"
        :state="inspectorState"
        :current-ms="currentMs"
        :readonly="!canEdit"
        :cue="selectedCue"
        :subtitle-styles-enabled="uxEnabled('subtitleStyles')"
        @trim-start="trimSelectedStart"
        @trim-end="trimSelectedEnd"
        @speed="setSelectedSpeed"
        @gap="setSelectedGap"
        @fades="setSelectedFades"
        @split="splitAt"
        @remove="removeSelected"
        @cue-update="updateSelectedCue"
        @cue-apply-all="applyAllAppearance"
        @cue-set-default="setDefaultAppearance"
        @cue-delete="deleteSelectedCue"
        @cue-split="splitSelectedCue"
        @cue-merge-next="mergeSelectedCueNext"
        @cue-align-start="alignCueStart"
        @cue-align-end="alignCueEnd"
        @cue-follow="toggleCueFollow"
      />
    </div>

    <!-- 字幕覆盖层渲染在 EditPreview 内部（EditSubtitleOverlay），此处只负责状态与安全区开关 -->
    <EditSubtitleList
      :open="subtitlesOpen"
      :cues="plan.subtitles"
      :selected-cue-id="selectedCueId"
      @close="subtitlesOpen = false"
      @select="selectCueFromList"
      @add="addCueAtPlayheadCmd"
    />

    <EditRevisionsDrawer
      :open="revisionsOpen"
      :revisions="revisions"
      :loading="revisionsLoading"
      :draft-dirty="dirty"
      :can-edit="canEdit"
      @close="revisionsOpen = false"
      @refresh="loadRevisions"
      @create="createRevision"
      @restore="restoreSelectedRevision"
    />

    <EditConflictDialog
      :conflict="conflict"
      :loading="conflictBusy"
      @reload="reloadFromConflict"
      @overwrite="overwriteConflict"
      @copy="copyConflict"
    />

    <!-- 帧操作图片选择器：插入图片片段（Task 22 遗留的 insert-image 分支在这里落地） -->
    <EditImagePicker
      :open="imagePickerOpen"
      :episode-id="Number(props.state.episode_id)"
      :project-id="stateProjectId"
      @close="imagePickerOpen = false"
      @insert="insertImage"
    />

    <!-- 剪辑导出确认：只读展示降级清单，导出以保存后的服务端计划为准 -->
    <EditExportDialog
      :open="exportOpen"
      :episode-id="Number(props.state.episode_id)"
      :project-id="stateProjectId"
      :version="version"
      :plan="plan"
      :layout="layout"
      :can-edit="canEdit"
      :settings="props.settings"
      :mix-status="topState.mix_status"
      :resume-export-id="resumeExport?.id || 0"
      :resume-status="resumeExport"
      @close="exportOpen = false"
      @exported="onExported"
      @reused="onReused"
      @cancelled="onRenderCancelled"
      @failed="onRenderFailed"
      @progress="onRenderProgress"
      @delivery="openExportDelivery"
    />

    <div v-if="shortcutsOpen" class="ed-modal-mask" @click.self="shortcutsOpen = false">
      <section class="ed-shortcuts">
        <header>
          <b>{{ t('edit.shortcutsTitle') }}</b>
          <button type="button" @click="shortcutsOpen = false">×</button>
        </header>
        <dl>
          <div><dt>Space</dt><dd>{{ t('edit.shortcutPlay') }}</dd></div>
          <div><dt>← / →</dt><dd>{{ t('edit.shortcutStep') }}</dd></div>
          <div><dt>⌘/Ctrl+Z</dt><dd>{{ t('edit.shortcutUndo') }}</dd></div>
          <div><dt>⌘/Ctrl+S</dt><dd>{{ t('edit.shortcutSave') }}</dd></div>
          <div><dt>S</dt><dd>{{ t('edit.shortcutSplit') }}</dd></div>
          <div><dt>Delete</dt><dd>{{ t('edit.shortcutDelete') }}</dd></div>
          <div><dt>{{ t('edit.clipOps') }}</dt><dd>{{ t('edit.shortcutClipMenu') }}</dd></div>
          <template v-if="uxEnabled('markers')">
            <div><dt>M</dt><dd>{{ t('edit.markers.shortcutAdd') }}</dd></div>
            <div><dt>[ / ]</dt><dd>{{ t('edit.markers.shortcutNav') }}</dd></div>
          </template>
          <div><dt>Home / End</dt><dd>{{ t('edit.shortcutHomeEnd') }}</dd></div>
          <div><dt>Esc</dt><dd>{{ t('edit.shortcutEscape') }}</dd></div>
        </dl>
      </section>
    </div>
  </div>
</template>

<script setup>
import { toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import EditTopBar from '~/components/edit/EditTopBar.vue'
import EditPreview from '~/components/edit/EditPreview.vue'
import EditSidebar from '~/components/edit/EditSidebar.vue'
import EditMediaLibrary from '~/components/edit/EditMediaLibrary.vue'
import EditTimeline from '~/components/edit/EditTimeline.vue'
import EditClipInspector from '~/components/edit/EditClipInspector.vue'
import EditSubtitleList from '~/components/edit/EditSubtitleList.vue'
import EditEmptyState from '~/components/edit/EditEmptyState.vue'
import EditRevisionsDrawer from '~/components/edit/EditRevisionsDrawer.vue'
import EditConflictDialog from '~/components/edit/EditConflictDialog.vue'
import EditImagePicker from '~/components/edit/EditImagePicker.vue'
import EditExportDialog from '~/components/edit/EditExportDialog.vue'
import { editAPI, filmAPI } from '~/composables/useApi'
import { useEditClock } from '~/composables/useEditClock'
import { useEditMedia } from '~/composables/useEditMedia'
import { useEditPlan } from '~/composables/useEditPlan'
import {
  addCueAtPlayhead,
  appendClip,
  applyAppearanceToAll,
  addMarker,
  closeGaps,
  createClipFromSource,
  createCommandId,
  deleteCue,
  deleteMarker,
  markerAtOrAfter,
  markerAtOrBefore,
  nextMarkerId,
  duplicateClip,
  mergeCueWithNext,
  moveClip,
  moveCue,
  removeClip,
  removeTransition,
  replaceClipSource,
  setClipFades,
  setClipGap,
  setClipSpeed,
  setCueAppearance,
  setCueFollow,
  setCueText,
  setCueTime,
  setSubtitleProjectDefaults,
  splitClip,
  splitCueAt,
  trimClipEnd,
  trimClipStart,
} from '~/utils/edit-commands'
import { insertFreezeFrame, insertImageClip, rippleDeleteFrame } from '~/utils/edit-frame-commands'
import { activeClipIndex, sourceTimeAt } from '~/utils/edit-layout'
import { framesToMs, msToFrames } from '~/utils/edit-timecode'
import { mediaUrl } from '~/utils/edit-plan'

const props = defineProps({
  state: { type: Object, required: true },
  episodeLabel: { type: String, default: '' },
  settings: { type: Object, default: () => ({}) },
  focusClipId: { type: String, default: '' },
  showAgent: { type: Boolean, default: false },
})
const emit = defineEmits(['back', 'open-film', 'open-agent'])
const route = useRoute()
const { t } = useI18n()

// 三个 UX 开关只隐藏对应交互，不影响后端与已有数据；配置读取失败按开启处理
const uxSettings = computed(() => props.settings?.ux || {})
function uxEnabled(key) {
  return uxSettings.value[key] !== false
}

// props.state 是页面 ref 解包后的深层代理，useEditPlan 内部 structuredClone 会抛 DataCloneError，
// 因此初始快照走 toRaw；模板仍读 props.state 保持响应性。
const {
  plan,
  layout,
  hashes,
  version,
  dirty,
  canEdit,
  saveStatus,
  saveError,
  conflict,
  recovery,
  issues,
  canUndo,
  canRedo,
  applyCommand,
  applyExternalPlan,
  undo,
  redo,
  saveNow,
  reload,
  discard,
  createVersion,
  restoreRevision,
  resolveConflict,
  acceptRecovery,
  dismissRecovery,
  retrySave,
} = useEditPlan(toRaw(props.state))

// 左侧成片列表：一次性拉取，操作后刷新；currentFilmId 用于禁用删除当前成片。
const films = ref([])
const filmsLoading = ref(false)
const currentFilmId = computed(() => Number(topState.value?.films?.find((f) => f.is_current)?.id)
  || Number(topState.value?.project?.source_merge_id) || 0)
const activeFilmId = computed(() => Number(topState.value?.project?.source_merge_id) || 0)

async function loadFilms() {
  filmsLoading.value = true
  try {
    films.value = (await filmAPI.list(props.state.episode_id)).films ?? []
  } catch {
    films.value = []
  } finally {
    filmsLoading.value = false
  }
}

// 左侧素材库：一次拉取分镜/台词/配音；加入与替换都走命令栈，可撤销。
const {
  media,
  loading: mediaLoading,
  error: mediaError,
  load: loadMedia,
} = useEditMedia(Number(props.state.episode_id))
const usedStoryboardIds = computed(() => plan.value.clips
  .filter((clip) => clip.source?.kind === 'storyboard')
  .map((clip) => Number(clip.source.id))
  .filter((id) => Number.isFinite(id)))

async function switchFilm(film) {
  if (Number(film?.id) === activeFilmId.value) return
  if (dirty.value) {
    await saveNow()
    if (saveStatus.value === 'error' || saveStatus.value === 'conflict') {
      timelineMessage.value = t('edit.saveBeforeSwitch')
      return
    }
  }
  emit('open-film', film.id)
}

async function renameFilm(film, title) {
  try {
    await filmAPI.rename(film.id, title)
    await loadFilms()
  } catch (cause) {
    timelineMessage.value = cause instanceof Error ? cause.message : t('edit.openFailed')
  }
}

async function removeFilm(film) {
  try {
    await filmAPI.remove(film.id)
    await loadFilms()
  } catch (cause) {
    timelineMessage.value = cause instanceof Error ? cause.message : t('edit.openFailed')
  }
}

async function setCurrentFilm(film) {
  try {
    await filmAPI.setCurrent(props.state.episode_id, film.id)
    await loadFilms()
  } catch (cause) {
    timelineMessage.value = cause instanceof Error ? cause.message : t('edit.openFailed')
  }
}

// 成片在混音工作台打开：配音/混音路由与剪辑页同级，直接回剧集页带参数。
function openFilmInMix(film) {
  navigateTo({
    path: route.path.replace(/\/edit$/, ''),
    query: { panel: 'dubbing', step: '3', film: String(film.id) },
  })
}

// 顶栏混音胶囊：回剧集页配音阶段第 3 步（预览与混音），带上当前工程的源成片。
function openMixWorkbench() {
  const filmId = Number(topState.value?.project?.source_merge_id) || 0
  const query = { panel: 'dubbing', step: '3' }
  if (filmId) query.film = String(filmId)
  navigateTo({
    path: `/drama/${route.params.id}/episode/${route.params.episodeNumber}`,
    query,
  })
}

// 回剧集页拼接导出条，新建拼接成片。
function goNewConcat() {
  navigateTo(`${route.path.replace(/\/edit$/, '')}#exports`)
}

function toggleMediaPanel() {
  leftTab.value = leftTab.value === 'media' ? 'films' : 'media'
}

function addStoryboard(item) {
  if (!canEdit.value || !item?.playable || !item.source) return
  const id = createCommandId('clp')
  // item 来自素材库的深层 ref，source 是代理；命令内部会克隆片段，必须先去掉代理。
  const ok = runCommand((value) => appendClip(value, createClipFromSource(id, toRaw(item.source))))
  if (!ok) return
  selection.value = { type: 'clip', id }
  const layoutClip = layout.value.clips.find((clip) => clip.clip_id === id)
  if (layoutClip) seek(layoutClip.timeline_start_ms)
  notify(t('edit.addedToTimeline', { n: item.number }))
}

function addAllStoryboards() {
  if (!canEdit.value) return
  const candidates = (media.value?.storyboards ?? []).filter(
    (item) => item.playable && item.source && !usedStoryboardIds.value.includes(item.id),
  )
  if (!candidates.length) return
  const ids = candidates.map(() => createCommandId('clp'))
  const ok = runCommand((value) => {
    let next = value
    candidates.forEach((item, index) => {
      next = appendClip(next, createClipFromSource(ids[index], toRaw(item.source))).plan
    })
    return { plan: next, issues: [], focusClipId: ids[0] }
  })
  if (!ok) return
  selection.value = { type: 'clip', id: ids[0] }
  const layoutClip = layout.value.clips.find((clip) => clip.clip_id === ids[0])
  if (layoutClip) seek(layoutClip.timeline_start_ms)
  notify(t('edit.addedCountToTimeline', { n: candidates.length }))
}

// 替换选中片段的画面来源：保留片段位置、空档、速度、淡入淡出与字幕跟随，走命令栈可撤销。
function replaceSelectedClip(item) {
  if (!canEdit.value || !item?.playable || !item.source) return
  if (!selectedClipId.value) {
    notify(t('edit.replaceSelectFirst'))
    return
  }
  const targetId = selectedClipId.value
  const ok = runCommand((value) => replaceClipSource(value, targetId, toRaw(item.source)))
  if (!ok) return
  const layoutClip = layout.value.clips.find((clip) => clip.clip_id === targetId)
  if (layoutClip) seek(layoutClip.timeline_start_ms)
  notify(t('edit.replacedClip', { n: item.number }))
}

const previewRef = ref(null)
const timelineRef = ref(null)
const currentMs = ref(0)
const playing = ref(false)
const selection = ref(null)
const mediaOpen = ref(true)
// 左栏两个页签：素材库（分镜/台词/配音）与成片列表；顶栏素材库按钮在两个页签间切换。
const leftTab = ref('media')
const shortcutsOpen = ref(false)
const timelineMessage = ref('')
const roughCutBusy = ref(false)
const subtitleBusy = ref(false)
const revisionsOpen = ref(false)
const revisions = ref([])
const revisionsLoading = ref(false)
const revisionBusy = ref(false)
const conflictBusy = ref(false)
// 帧操作 UI（Task 23）：图片选择器与定格抽帧；导出确认弹窗。
const imagePickerOpen = ref(false)
const pendingInsertAt = ref(null)
const freezeBusy = ref(false)
const exportOpen = ref(false)
// 刷新后恢复轮询的导出记录；liveExport 用于弹窗关闭期间让顶栏继续显示进度胶囊
const resumeExport = ref(null)
const liveExport = ref(null)
const ACTIVE_RENDER_STATUSES = ['pending', 'running', 'rendering']
const stateProjectId = computed(() => Number(props.state.project?.id) || 0)

// 服务端派生字段（台词放置、素材告警、音频、混音状态、初剪可用性）只读：
// 编辑动作后在后台刷新，避免检查器/顶栏长期显示页面加载时的旧值。
const derived = ref({
  line_placements: props.state.line_placements ?? [],
  media_warnings: props.state.media_warnings ?? [],
  audio: props.state.audio,
  mix_status: props.state.mix_status,
  rough_cut_available: Boolean(props.state.rough_cut_available),
  renders: props.state.renders,
})
const topState = computed(() => {
  const merged = { ...props.state, ...derived.value }
  if (!liveExport.value) return merged
  // 弹窗轮询到的进度优先于页面加载时的快照，顶栏胶囊才能持续更新
  return {
    ...merged,
    renders: {
      ...(merged.renders || {}),
      latest: { ...(merged.renders?.latest || {}), ...liveExport.value },
    },
  }
})

let rafId = 0
let lastTick = 0
let messageTimer = 0
let derivedTimer = 0
let derivedSeq = 0

const selectedClipId = computed(() => (
  selection.value?.type === 'clip' ? selection.value.id : ''
))
const selectedCueId = computed(() => (
  selection.value?.type === 'cue' ? selection.value.id : ''
))
const selectedCue = computed(() => (
  plan.value.subtitles.find((cue) => cue.id === selectedCueId.value) ?? null
))
const showSafeArea = ref(false)
const subtitlesOpen = ref(false)
// 字幕轨显示状态：默认显示，工具栏「字幕 ▾ → 显示/隐藏字幕轨」切换（与 EditTimeline 的 prop 默认一致）
const showSubtitles = ref(true)
const actionBusy = computed(() => roughCutBusy.value || subtitleBusy.value)
// 音频模式基于服务端 state.audio（§6.9）：mix=混音成片音轨 / video=源原声参考 / none=静音预览
const audioMode = computed(() => {
  const mode = String(derived.value.audio?.mode || '')
  return mode === 'mix' || mode === 'video' ? mode : 'none'
})
// 回退横幅：混音过期回放原声 / 完全无音轨，其余（含混音对齐）不提示
const audioBanner = computed(() => {
  const audio = derived.value.audio
  if (audio?.mode === 'video' && audio.reference_only) return t('edit.audioBannerStale')
  if (audio?.mode === 'none') return t('edit.audioBannerNone')
  return ''
})

// 播放时钟（§6.9）：mode='mix' 时 WebAudio 音频是主时钟，视频每帧对齐（漂移 >120ms 才 seek）；
// mode='video'/'none' 保持视频即时钟，不走 WebAudio。
const clock = useEditClock({
  audioUrl: () => mediaUrl(derived.value.audio?.url || ''),
  playing: () => playing.value,
})

const activeLayoutClip = computed(() => {
  const index = activeClipIndex(layout.value, currentMs.value)
  const item = layout.value.clips[index]
  if (!item) return null
  return currentMs.value >= item.timeline_start_ms && currentMs.value < item.timeline_end_ms
    ? item
    : null
})
const activeClipId = computed(() => activeLayoutClip.value?.clip_id ?? '')
const activeClip = computed(() => (
  plan.value.clips.find((clip) => clip.id === activeClipId.value) ?? null
))
// 播放头停在成片末尾时保留最后一帧，而不是清空预览；编辑语义仍以 activeClip 为准。
const previewClip = computed(() => {
  if (activeClip.value) return activeClip.value
  const end = Math.max(0, Number(layout.value.duration_ms) || 0)
  if (!plan.value.clips.length || end <= 0 || currentMs.value < end) return null
  return plan.value.clips[plan.value.clips.length - 1] ?? null
})
const previewClipId = computed(() => previewClip.value?.id ?? '')
const sourceMs = computed(() => {
  if (activeClip.value) return sourceTimeAt(plan.value, layout.value, currentMs.value)
  return previewClip.value ? Math.max(0, Number(previewClip.value.sourceOutMs) || 0) : 0
})
const playbackRate = computed(() => Number((activeClip.value ?? previewClip.value)?.speed) || 1)
const previewSrc = computed(() => mediaUrl(previewClip.value?.source?.url || ''))
const poster = computed(() => mediaUrl(previewClip.value?.source?.thumbnailUrl || ''))
const clipKey = computed(() => {
  const clip = previewClip.value
  return clip
    ? `${clip.id}:${clip.source?.url || ''}:${clip.sourceInMs}`
    : ''
})

const selectedPlacement = computed(() => {
  if (!selectedClipId.value) return null
  return (derived.value.line_placements ?? []).find(
    (item) => item.clip_id === selectedClipId.value,
  ) ?? null
})

const inspectorState = computed(() => ({
  ...props.state,
  ...derived.value,
  plan: plan.value,
  layout: layout.value,
  hashes: hashes.value,
}))

function formatWhen(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function notify(message) {
  timelineMessage.value = message
  clearTimeout(messageTimer)
  messageTimer = setTimeout(() => {
    timelineMessage.value = ''
  }, 5000)
}

function onPreviewError() {
  if (!previewSrc.value) return
  notify(t('edit.previewFailed'))
}

function clearMessage() {
  clearTimeout(messageTimer)
  timelineMessage.value = ''
}

async function refreshDerived() {
  if (!props.state.episode_id) return
  const seq = ++derivedSeq
  try {
    // 指定工程刷新派生数据，避免后台刷新把其他工程的台词放置/混音状态混进来。
    const fresh = await editAPI.get(props.state.episode_id, props.state.project?.id || undefined)
    if (seq !== derivedSeq) return
    derived.value = {
      line_placements: fresh.line_placements ?? [],
      media_warnings: fresh.media_warnings ?? [],
      audio: fresh.audio ?? props.state.audio,
      mix_status: fresh.mix_status ?? props.state.mix_status,
      rough_cut_available: Boolean(fresh.rough_cut_available),
      renders: fresh.renders ?? props.state.renders,
    }
  } catch {
    // 后台刷新失败保留旧值，不打断编辑，也不进入保存错误状态。
  }
}

function scheduleDerivedRefresh() {
  clearTimeout(derivedTimer)
  derivedTimer = setTimeout(() => { void refreshDerived() }, 400)
}

function clampCurrentTime() {
  const end = Math.max(0, Number(layout.value.duration_ms) || 0)
  if (currentMs.value > end) currentMs.value = end
}

function seek(ms) {
  const end = Math.max(0, Number(layout.value.duration_ms) || 0)
  const value = Math.max(0, Math.min(end, Math.round(Number(ms) || 0)))
  currentMs.value = value
  if (audioMode.value === 'mix') clock.seek(value)
  const index = activeClipIndex(layout.value, value)
  const item = layout.value.clips[index]
  if (item && value >= item.timeline_start_ms && value < item.timeline_end_ms) {
    previewRef.value?.seek(sourceTimeAt(plan.value, layout.value, value))
  }
}

function playFromCurrent() {
  if (!plan.value.clips.length || playing.value) return
  // 单片段从末尾重播时 src/clipKey 不变，不会触发预览重载，必须显式回到片头。
  if (currentMs.value >= Math.max(0, layout.value.duration_ms - 1)) seek(0)
  playing.value = true
  lastTick = 0
  if (audioMode.value === 'mix') void clock.start(currentMs.value)
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(tick)
}

function tick(now) {
  if (!playing.value) return
  if (!lastTick) lastTick = now
  const delta = Math.min(250, Math.max(0, now - lastTick))
  lastTick = now
  const end = Math.max(0, Number(layout.value.duration_ms) || 0)
  // 混音对齐：WebAudio 音频是主时钟；音源结束（running=false）或未就绪时回退视频即时钟
  const clockIsMaster = audioMode.value === 'mix' && clock.mode.value === 'mix' && clock.running.value
  if (clockIsMaster) {
    currentMs.value = Math.min(end, clock.audioMs())
  } else {
    currentMs.value = Math.min(end, currentMs.value + delta)
  }
  clock.syncVideo(
    previewRef.value?.video ?? null,
    (ms) => sourceTimeAt(plan.value, layout.value, ms),
  )
  if (currentMs.value >= end) {
    pausePlayback()
    return
  }
  rafId = requestAnimationFrame(tick)
}

function pausePlayback() {
  playing.value = false
  cancelAnimationFrame(rafId)
  clock.stop()
  previewRef.value?.pause()
  // 暂停后把视频拉回时钟位置，消除 rAF 与视频播放之间的漂移。
  if (activeClip.value) previewRef.value?.seek(sourceMs.value)
}

function togglePlayback() {
  if (playing.value) pausePlayback()
  else playFromCurrent()
}

function stepFrame(direction) {
  pausePlayback()
  const fps = Number(plan.value.project.fps) || 30
  const frame = msToFrames(currentMs.value, fps) + (Number(direction) >= 0 ? 1 : -1)
  seek(framesToMs(Math.max(0, frame), fps))
}

function onClipEnded() {
  const item = activeLayoutClip.value
  if (playing.value && item && currentMs.value < item.timeline_end_ms) {
    currentMs.value = item.timeline_end_ms
  }
}

function selectClip(clipId) {
  selection.value = clipId ? { type: 'clip', id: clipId } : null
}

function selectCue(cueId) {
  selection.value = cueId ? { type: 'cue', id: cueId } : null
}

// 命令工厂必须由 applyCommand 代入 toRaw 计划：Task 9 的命令内部 structuredClone，
// 直接传 plan.value（深层代理）会抛 DataCloneError。
function runCommand(factory, options = {}) {
  if (!canEdit.value) return false
  let result = null
  const ok = applyCommand((value) => {
    result = factory(value)
    return result
  })
  if (!ok) {
    const issue = result?.issues?.find((item) => item.severity === 'error')
    if (issue) notify(issue.message)
    return false
  }
  if (
    options.selectFocus !== false
    && result.focusClipId
    && selection.value?.type === 'clip'
  ) {
    selection.value = { type: 'clip', id: result.focusClipId }
  }
  clampCurrentTime()
  return true
}

function moveClipTo(payload) {
  const index = plan.value.clips.findIndex((clip) => clip.id === payload.clipId)
  if (index === payload.targetIndex) return
  runCommand((value) => moveClip(value, payload.clipId, payload.targetIndex))
}

function trimClip(payload) {
  const factory = payload.edge === 'start'
    ? (value) => trimClipStart(value, payload.clipId, payload.deltaMs, { ripple: true })
    : (value) => trimClipEnd(value, payload.clipId, payload.deltaMs, { ripple: true })
  runCommand(factory)
}

function moveCueTo(payload) {
  runCommand(
    (value) => moveCue(value, payload.cueId, payload.startMs),
    { selectFocus: false },
  )
}

function splitAt(payload) {
  if (!canEdit.value) return
  const clipId = typeof payload === 'object' && payload ? payload.clipId : selectedClipId.value
  const atMs = typeof payload === 'object' && payload ? payload.atMs : Number(payload)
  if (!clipId || !Number.isFinite(atMs)) return
  const secondId = createCommandId('clp')
  const ok = runCommand((value) => splitClip(value, clipId, atMs, secondId))
  if (ok) selection.value = { type: 'clip', id: secondId }
}

// 片段菜单三项：分割/删除/波纹删除，全部走 runCommand 进入撤销栈
function onClipOp({ kind, clipId, atMs }) {
  if (!canEdit.value || !clipId) return
  if (kind === 'split') {
    if (!Number.isFinite(Number(atMs))) return
    const secondId = createCommandId('clp')
    const ok = runCommand((value) => splitClip(value, clipId, Number(atMs), secondId))
    if (ok) selection.value = { type: 'clip', id: secondId }
    return
  }
  if (kind !== 'delete' && kind !== 'ripple-delete') return
  const index = plan.value.clips.findIndex((clip) => clip.id === clipId)
  const ok = runCommand((value) => removeClip(value, clipId, { ripple: kind === 'ripple-delete' }))
  if (!ok) return
  const clips = plan.value.clips
  selection.value = clips.length
    ? { type: 'clip', id: clips[Math.min(Math.max(0, index), clips.length - 1)]?.id ?? clips[0].id }
    : null
}

function splitAtPlayhead() {
  if (!canEdit.value) return
  const item = activeLayoutClip.value
  const clip = activeClip.value
  if (!item || !clip) return
  const offset = currentMs.value - item.timeline_start_ms
  // 与 splitClip 的最短片段口径一致（3 秒按帧率折算），避免界面放行后命令拒绝
  const minMs = Math.ceil(3000 / Math.max(1, Number(plan.value.project.fps) || 30))
  if (offset < minMs || item.timeline_end_ms - currentMs.value < minMs) return
  splitAt({ clipId: clip.id, atMs: offset })
}

function removeTransitionById(transitionId) {
  runCommand(
    (value) => removeTransition(value, transitionId),
    { selectFocus: false },
  )
}

// ---- 时间线帧操作 / 字幕块右键（EditTimeline frame-op / cue-op 事件，spec 6.8） ----
function fpsOfPlan(p) {
  return Number(p?.project?.fps) || 30
}

function onFrameOp({ kind, clipId, atMs }) {
  if (!canEdit.value) return
  if (kind === 'delete-frame') {
    // 帧级涟漪删除；片段过短时命令返回 FRAME_DELETE_TOO_SHORT，runCommand 会把错误原文提示出来
    runCommand((value) => rippleDeleteFrame(value, atMs, fpsOfPlan(value)), { selectFocus: false })
  } else if (kind === 'duplicate-frame') {
    insertFreezeAt(clipId, atMs)
  } else if (kind === 'extend-1s') {
    extendClipByMs(clipId, 1000)
  } else if (kind === 'insert-image') {
    // 插入图片：先记住插入点，打开图片选择器，选中图片后在 insertImage 里落命令
    pendingInsertAt.value = { clipId, atMs: Math.round(Number(atMs) || 0) }
    imagePickerOpen.value = true
  }
}

/**
 * 定格插入（复制这一帧）：按片段内容内偏移调抽帧接口取 PNG，
 * 再用 insertFreezeFrame 在播放头处插入 1 秒定格片段。
 * 抽帧/命令失败都会把后端错误原文提示出来（不静默失败）。
 */
async function insertFreezeAt(clipId, atMs) {
  if (!canEdit.value || freezeBusy.value) return
  const item = layout.value.clips.find((entry) => entry.clip_id === clipId)
  if (!clipId || !item) {
    notify(t('edit.actionFailed'))
    return
  }
  freezeBusy.value = true
  try {
    // offset_ms 是「片段内容内偏移」（后端 Task 19 定义），必须用时间线绝对时间减片段起点换算
    const body = {
      clip_id: clipId,
      offset_ms: Math.max(0, Math.round(Number(atMs) || 0) - item.timeline_start_ms),
    }
    if (stateProjectId.value > 0) body.project_id = stateProjectId.value
    const frame = await editAPI.extractFrame(props.state.episode_id, body)
    const ok = runCommand((value) => insertFreezeFrame(
      value,
      atMs,
      fpsOfPlan(value),
      {
        url: frame.url,
        width: frame.width,
        height: frame.height,
        fingerprint: frame.fingerprint,
        label: t('edit.freezeFrameName'),
      },
      1000,
    ), { selectFocus: false })
    if (ok) notify(t('edit.frameFreezeInserted'))
  } catch (cause) {
    notify(cause?.message || t('edit.actionFailed'))
  } finally {
    freezeBusy.value = false
  }
}

// 图片选择器选中图片：在记住的插入点落图片片段命令（片段内部会先分割再插入）
function insertImage(img) {
  const at = pendingInsertAt.value || { atMs: Math.round(currentMs.value) }
  imagePickerOpen.value = false
  runCommand((value) => insertImageClip(
    value,
    at.atMs,
    fpsOfPlan(value),
    {
      url: img.url,
      width: img.width,
      height: img.height,
      fingerprint: img.fingerprint,
      label: img.label,
    },
    3000,
  ), { selectFocus: false })
}

// 顶栏“导出”与进度胶囊共用入口：进行中→恢复轮询；失败/取消→进入重试；其余→新建导出
// 设计 §4.2：草稿未保存时先保存再打开，绝不让服务端读取陈旧草稿渲染。
async function openExportDialog(exportId) {
  const latest = topState.value.renders?.latest || null
  const state = latest ? String(latest.status) : ''
  const resumable = ACTIVE_RENDER_STATUSES.includes(state) || state === 'failed' || state === 'cancelled'
  if (latest && resumable && (!exportId || Number(exportId) === Number(latest.id))) {
    resumeExport.value = { ...latest, status: state, progress: Number(latest.progress) || 0 }
    exportOpen.value = true
    return
  }
  resumeExport.value = null
  if (dirty.value) {
    await saveNow()
    if (saveStatus.value === 'error' || saveStatus.value === 'conflict') {
      notify(t('edit.exportSaveFirstFailed'))
      return
    }
  }
  exportOpen.value = true
}

function onRenderProgress(status) {
  if (!status?.id) return
  liveExport.value = {
    id: Number(status.id),
    status: String(status.status || 'pending'),
    progress: Math.round(Number(status.progress) || 0),
  }
  if (resumeExport.value?.id) resumeExport.value = { ...resumeExport.value, ...status }
}

function onRenderCancelled() {
  liveExport.value = null
  resumeExport.value = null
  notify(t('edit.exportCancelled'))
  scheduleDerivedRefresh()
}

// 失败记录保留在 resumeExport，便于重新打开弹窗后直接重试同一记录
function onRenderFailed(status) {
  liveExport.value = null
  resumeExport.value = status?.id ? { ...status } : null
  scheduleDerivedRefresh()
}

// 导出完成：刷新左侧成片列表并提示（成片由后端投影进成片中心）
function onExported() {
  liveExport.value = null
  resumeExport.value = null
  void loadFilms()
  notify(t('edit.exportDone'))
  scheduleDerivedRefresh()
}

// 命中复用的副作用（set_current）已在服务端生效，这里只刷新列表与状态
function onReused() {
  liveExport.value = null
  resumeExport.value = null
  void loadFilms()
  notify(t('edit.exportReusedDone'))
  scheduleDerivedRefresh()
}

function openExportDelivery() {
  exportOpen.value = false
  navigateTo(`${route.path.replace(/\/edit$/, '')}#exports`)
}

function extendClipByMs(clipId, deltaMs) {
  runCommand((value) => trimClipEnd(value, clipId, deltaMs, { ripple: false }))
}

function onCueOp({ kind, cueId }) {
  if (!canEdit.value) return
  if (kind === 'edit') {
    selection.value = { type: 'cue', id: cueId }
  } else if (kind === 'split') {
    runCommand((value) => splitCueAt(value, cueId, Math.round(currentMs.value)), { selectFocus: false })
  } else if (kind === 'merge-next') {
    runCommand((value) => mergeCueWithNext(value, cueId), { selectFocus: false })
  } else if (kind === 'delete') {
    runCommand((value) => deleteCue(value, cueId), { selectFocus: false })
  }
}

function fitView() {
  timelineRef.value?.zoomToFit()
}

function removeClipById(clipId) {
  if (!clipId || !canEdit.value) return
  runCommand((value) => removeClip(value, clipId, { ripple: true }))
}

function duplicateClipById(clipId) {
  if (!clipId || !canEdit.value) return
  const newId = createCommandId('clp')
  const ok = runCommand((value) => duplicateClip(value, clipId, newId))
  if (ok) selection.value = { type: 'clip', id: newId }
}

function addMarkerAt(atMs) {
  if (!canEdit.value || !uxEnabled('markers')) return
  runCommand((value) => addMarker(value, {
    id: nextMarkerId(value),
    atMs: Math.round(Number(atMs) || 0),
    label: t('edit.markers.defaultLabel', { n: (value.markers?.length || 0) + 1 }),
  }), { selectFocus: false })
}

function deleteMarkerById(markerId) {
  if (!markerId || !canEdit.value || !uxEnabled('markers')) return
  runCommand((value) => deleteMarker(value, markerId), { selectFocus: false })
}

// 标记导航只读可用；首尾之外没有目标时保持当前位置
function jumpMarker(direction) {
  if (!uxEnabled('markers')) return
  const marker = Number(direction) < 0
    ? markerAtOrBefore(plan.value, currentMs.value)
    : markerAtOrAfter(plan.value, currentMs.value)
  if (marker) seek(marker.atMs)
}

function closeAllGaps() {
  if (!canEdit.value) return
  runCommand((value) => closeGaps(value), { selectFocus: false })
}

function trimSelectedStart(deltaMs) {
  if (!selectedClipId.value) return
  runCommand((value) => trimClipStart(value, selectedClipId.value, deltaMs, { ripple: true }))
}

function trimSelectedEnd(deltaMs) {
  if (!selectedClipId.value) return
  runCommand((value) => trimClipEnd(value, selectedClipId.value, deltaMs, { ripple: true }))
}

function setSelectedSpeed(speed) {
  if (!selectedClipId.value) return
  runCommand((value) => setClipSpeed(value, selectedClipId.value, speed))
}

function setSelectedGap(gapMs) {
  if (!selectedClipId.value) return
  runCommand((value) => setClipGap(value, selectedClipId.value, gapMs))
}

function setSelectedFades(payload) {
  if (!selectedClipId.value) return
  runCommand(
    (value) => setClipFades(value, selectedClipId.value, payload.inMs, payload.outMs),
  )
}

function removeSelected(payload = { ripple: true }) {
  if (!selectedClipId.value) return
  runCommand(
    (value) => removeClip(value, selectedClipId.value, { ripple: payload.ripple !== false }),
  )
}

function removeSelection() {
  const current = selection.value
  if (!current) return
  if (current.type === 'cue') {
    const ok = runCommand((value) => deleteCue(value, current.id), { selectFocus: false })
    if (ok) selection.value = null
    return
  }
  if (current.type === 'clip') {
    runCommand((value) => removeClip(value, current.id, { ripple: true }))
  }
}

// ---- 字幕命令（检查器 cue 页 / 字幕抽屉） ----
function updateSelectedCue(patch) {
  if (!selectedCueId.value) return
  applyCommand((p) => {
    if (patch.text !== undefined) return setCueText(p, selectedCueId.value, patch.text)
    if (patch.appearance !== undefined) return setCueAppearance(p, selectedCueId.value, patch.appearance)
    return setCueTime(p, selectedCueId.value, patch)
  })
}

function applyAllAppearance(appearance) {
  runCommand((p) => applyAppearanceToAll(p, appearance), { selectFocus: false })
}

function setDefaultAppearance(appearance) {
  runCommand((p) => setSubtitleProjectDefaults(p, { appearance }), { selectFocus: false })
}

function deleteSelectedCue() {
  if (!selectedCueId.value) return
  const ok = runCommand((value) => deleteCue(value, selectedCueId.value), { selectFocus: false })
  if (ok) selection.value = null
}

function splitSelectedCue() {
  if (!selectedCueId.value) return
  runCommand(
    (value) => splitCueAt(value, selectedCueId.value, Math.round(currentMs.value)),
    { selectFocus: false },
  )
}

function mergeSelectedCueNext() {
  if (!selectedCueId.value) return
  runCommand((value) => mergeCueWithNext(value, selectedCueId.value), { selectFocus: false })
}

function alignCueStart() {
  if (!selectedCueId.value) return
  applyCommand((p) => setCueTime(p, selectedCueId.value, {
    startMs: Math.round(currentMs.value),
    endMs: Math.round(p.subtitles.find((cue) => cue.id === selectedCueId.value)?.endMs ?? currentMs.value),
  }))
}

function alignCueEnd() {
  if (!selectedCueId.value) return
  applyCommand((p) => setCueTime(p, selectedCueId.value, {
    startMs: Math.round(p.subtitles.find((cue) => cue.id === selectedCueId.value)?.startMs ?? 0),
    endMs: Math.round(currentMs.value),
  }))
}

function toggleCueFollow(value) {
  if (!selectedCueId.value) return
  runCommand((p) => setCueFollow(p, selectedCueId.value, Boolean(value)), { selectFocus: false })
}

function addCueAtPlayheadCmd() {
  if (!canEdit.value) return
  runCommand((p) => addCueAtPlayhead(p, currentMs.value, p.project), { selectFocus: false })
}

function selectCueFromList(cueId) {
  selectCue(cueId)
  const cue = plan.value.subtitles.find((item) => item.id === cueId)
  seek(cue?.startMs ?? currentMs.value)
}

function handleActionError(cause, fallbackKey) {
  if (cause?.code === 'EDIT_VERSION_CONFLICT') {
    conflict.value = cause.data
    saveStatus.value = 'conflict'
    return
  }
  notify(cause?.message || t(fallbackKey))
}

async function saveImmediately() {
  if (!canEdit.value || conflict.value) return
  if (saveStatus.value === 'error') retrySave()
  await saveNow()
}

async function runRoughCut() {
  if (!canEdit.value || actionBusy.value) return
  if (plan.value.clips.length && !window.confirm(t('edit.roughCutConfirm'))) return
  pausePlayback()
  roughCutBusy.value = true
  try {
    if (plan.value.clips.length) {
      await createVersion(t('edit.roughCutSnapshotNote'))
    } else {
      await saveNow()
    }
    // 冲突未解决时 base_version 已过期，绝不能带着陈旧版本发初剪请求。
    if (conflict.value) return
    const result = await editAPI.roughCut(props.state.episode_id, {
      mode: 'replace',
      plan: toRaw(plan.value),
      create_revision: false,
      base_version: version.value,
    })
    applyExternalPlan(result.plan, result.hashes)
    issues.value = result.issues
    selection.value = null
    currentMs.value = 0
    notify(t('edit.roughCutDone', {
      added: result.applied.added,
      skipped: result.applied.skipped,
    }))
    scheduleDerivedRefresh()
  } catch (cause) {
    handleActionError(cause, 'edit.roughCutFailed')
  } finally {
    roughCutBusy.value = false
  }
}

async function runSubtitleSuggest() {
  if (!canEdit.value || actionBusy.value) return
  subtitleBusy.value = true
  try {
    await saveNow()
    if (conflict.value) return
    const result = await editAPI.suggestSubtitles(props.state.episode_id, {
      mode: 'fill',
      plan: toRaw(plan.value),
    })
    applyExternalPlan(result.plan, result.hashes)
    issues.value = result.issues
    notify(t('edit.subtitleSuggested', {
      added: result.added,
      updated: result.updated,
    }))
    scheduleDerivedRefresh()
  } catch (cause) {
    handleActionError(cause, 'edit.subtitleSuggestFailed')
  } finally {
    subtitleBusy.value = false
  }
}

function openRevisions() {
  revisionsOpen.value = true
}

async function loadRevisions() {
  revisionsLoading.value = true
  try {
    revisions.value = (await editAPI.revisions(props.state.episode_id)).items
  } catch (cause) {
    notify(cause?.message || t('edit.versionLoadFailed'))
  } finally {
    revisionsLoading.value = false
  }
}

async function createRevision(note) {
  if (!canEdit.value || revisionBusy.value) return
  revisionBusy.value = true
  try {
    const revision = await createVersion(note || t('edit.versionDefaultNote'))
    if (revision) notify(t('edit.versionCreated'))
    await loadRevisions()
    scheduleDerivedRefresh()
  } catch (cause) {
    handleActionError(cause, 'edit.createRevisionFailed')
  } finally {
    revisionBusy.value = false
  }
}

async function restoreSelectedRevision(revision) {
  if (!canEdit.value || !revision || revisionBusy.value) return
  if (!window.confirm(t('edit.restoreConfirm'))) return
  revisionBusy.value = true
  try {
    // 冲突时 restoreRevision 只标记冲突并正常返回，不能当成功处理。
    await restoreRevision(revision.id)
    if (conflict.value) return
    pausePlayback()
    currentMs.value = 0
    selection.value = null
    revisionsOpen.value = false
    notify(t('edit.versionRestored'))
    scheduleDerivedRefresh()
  } catch (cause) {
    handleActionError(cause, 'edit.restoreFailed')
  } finally {
    revisionBusy.value = false
  }
}

async function discardDraft() {
  if (!canEdit.value) return
  if (!window.confirm(t('edit.discardConfirm'))) return
  try {
    await discard()
    pausePlayback()
    currentMs.value = 0
    selection.value = null
    notify(t('edit.discarded'))
    scheduleDerivedRefresh()
  } catch (cause) {
    handleActionError(cause, 'edit.discardFailed')
  }
}

async function reloadFromConflict() {
  conflictBusy.value = true
  try {
    await reload()
    pausePlayback()
    currentMs.value = 0
    selection.value = null
    notify(t('edit.conflictReloaded'))
    scheduleDerivedRefresh()
  } catch (cause) {
    notify(cause?.message || t('edit.conflictLoadFailed'))
  } finally {
    conflictBusy.value = false
  }
}

async function overwriteConflict() {
  conflictBusy.value = true
  try {
    await resolveConflict('overwrite')
    notify(t('edit.conflictOverwritten'))
    scheduleDerivedRefresh()
  } catch (cause) {
    notify(cause?.message || t('edit.conflictLoadFailed'))
  } finally {
    conflictBusy.value = false
  }
}

async function copyConflict() {
  try {
    if (!navigator.clipboard?.writeText) throw new Error(t('edit.conflictCopyFailed'))
    await navigator.clipboard.writeText(JSON.stringify(toRaw(plan.value), null, 2))
  } catch (cause) {
    notify(cause?.message || t('edit.conflictCopyFailed'))
    return
  }
  try {
    await resolveConflict('reload')
    pausePlayback()
    currentMs.value = 0
    selection.value = null
    notify(t('edit.conflictCopied'))
    scheduleDerivedRefresh()
  } catch (cause) {
    notify(cause?.message || t('edit.conflictLoadFailed'))
  }
}

function useRecovery() {
  pausePlayback()
  acceptRecovery()
  currentMs.value = 0
}

function isTyping(target) {
  if (!target || typeof target !== 'object') return false
  const tag = String(target.tagName || '').toUpperCase()
  const type = String(target.type || '').toLowerCase()
  if (tag === 'INPUT' && type === 'range') return false
  return target.isContentEditable === true
    || tag === 'INPUT'
    || tag === 'TEXTAREA'
    || tag === 'SELECT'
}

function onKeydown(event) {
  if (conflict.value) return
  if (shortcutsOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      shortcutsOpen.value = false
    }
    return
  }
  if (revisionsOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      revisionsOpen.value = false
    }
    return
  }
  if (isTyping(event.target)) return

  const target = event.target
  const rangeFocused = Boolean(target)
    && String(target.tagName || '').toUpperCase() === 'INPUT'
    && String(target.type || '').toLowerCase() === 'range'

  const meta = event.metaKey || event.ctrlKey
  const key = String(event.key || '').toLowerCase()

  if (meta && key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if (meta && key === 'y') {
    event.preventDefault()
    redo()
    return
  }
  if (meta && key === 's') {
    event.preventDefault()
    void saveImmediately()
    return
  }
  if (meta) return

  if (event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault()
    togglePlayback()
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    if (rangeFocused) return
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' ? -1 : 1
    if (event.shiftKey) seek(currentMs.value + direction * 1000)
    else stepFrame(direction)
    return
  }
  if (event.key === 'Home') {
    if (rangeFocused) return
    event.preventDefault()
    seek(0)
    return
  }
  if (event.key === 'End') {
    if (rangeFocused) return
    event.preventDefault()
    seek(layout.value.duration_ms)
    return
  }
  if (key === 's') {
    event.preventDefault()
    splitAtPlayhead()
    return
  }
  if (key === 'm') {
    if (!uxEnabled('markers')) return
    event.preventDefault()
    addMarkerAt(currentMs.value)
    return
  }
  if (event.key === '[' || event.key === ']') {
    if (!uxEnabled('markers')) return
    event.preventDefault()
    jumpMarker(event.key === '[' ? -1 : 1)
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (rangeFocused) return
    event.preventDefault()
    removeSelection()
    return
  }
  if (event.key === 'Escape') {
    timelineRef.value?.closeMarkerPopover?.()
    selection.value = null
  }
}

watch(plan, (value) => {
  const current = selection.value
  if (!current) return
  if (current.type === 'clip' && !value.clips.some((clip) => clip.id === current.id)) {
    selection.value = null
  }
  if (current.type === 'cue' && !value.subtitles.some((cue) => cue.id === current.id)) {
    selection.value = null
  }
})

// 助手定位：只选当前计划内存在的片段，找不到时保持原选择
watch(() => props.focusClipId, (clipId) => {
  if (!clipId) return
  if (plan.value.clips.some((clip) => clip.id === clipId)) selectClip(clipId)
}, { immediate: true })

watch(conflict, (value) => {
  if (value) pausePlayback()
})

watch(sourceMs, (ms) => {
  if (!playing.value) previewRef.value?.seek(ms)
})

// 音轨切换（audio.url 变化）：useEditClock 已停旧时钟并清缓存，播放中时从当前位置重建
watch(() => derived.value.audio?.url, (url, old) => {
  if (url === old) return
  if (playing.value && audioMode.value === 'mix') void clock.start(currentMs.value)
})

watch(saveStatus, (value) => {
  if (value === 'saved') scheduleDerivedRefresh()
})

onMounted(() => {
  void loadFilms()
  void loadMedia()
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  pausePlayback()
  clearTimeout(messageTimer)
  clearTimeout(derivedTimer)
  void saveNow()
})
</script>

<style scoped>
.ed-workbench {
  flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;
  background: var(--bg-base); color: var(--text-0);
}
.ed-banner {
  flex: 0 0 auto; min-height: 30px; padding: 6px 14px; display: flex; align-items: center;
  gap: 10px; border-bottom: 1px solid var(--border); font-size: 11px;
}
.ed-banner span { flex: 1; min-width: 0; }
.ed-banner button {
  height: 22px; padding: 0 9px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-1); color: var(--text-1); font-size: var(--text-micro); cursor: pointer;
}
.ed-banner button.is-muted { color: var(--text-3); }
.ed-banner.is-error { background: color-mix(in srgb, var(--action-danger) 10%, var(--bg-1)); color: var(--action-danger); }
.ed-banner.is-warning { background: color-mix(in srgb, var(--warning) 10%, var(--bg-1)); color: var(--warning); }
.ed-banner.is-info { background: var(--bg-2); color: var(--text-2); }
.ed-main {
  flex: 1; min-width: 0; min-height: 0; display: grid;
  grid-template-columns: 236px minmax(0, 1fr) 300px;
}
.ed-main.is-empty { grid-template-columns: 236px minmax(0, 1fr); }
.ed-left {
  min-width: 0; min-height: 0; display: flex; flex-direction: column;
  background: var(--bg-1); border-right: 1px solid var(--border); overflow: hidden;
}
.ed-left-tabs {
  flex: 0 0 auto; display: flex; gap: 4px; padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.ed-left-tabs button {
  flex: 1; height: var(--control-xs); border: 1px solid transparent; border-radius: 6px;
  background: transparent; color: var(--text-3); font-size: var(--text-micro); cursor: pointer;
}
.ed-left-tabs button.is-on {
  background: var(--bg-2); border-color: var(--border); color: var(--text-0);
}
.ed-left-body { flex: 1; min-width: 0; min-height: 0; border-right: 0; }
.ed-stage {
  min-width: 0; min-height: 0; display: flex; flex-direction: column;
  gap: 12px; padding: 14px 16px 16px;
}
.ed-modal-mask {
  position: fixed; inset: 0; z-index: 55; display: flex; align-items: center;
  justify-content: center; padding: 24px; background: rgba(0, 0, 0, .5);
}
.ed-shortcuts {
  width: 380px; max-width: 100%; display: flex; flex-direction: column; gap: 10px;
  padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-1);
  box-shadow: 0 18px 50px rgba(0, 0, 0, .35);
}
.ed-shortcuts header { display: flex; align-items: center; justify-content: space-between; }
.ed-shortcuts header b { font-size: 13px; }
.ed-shortcuts header button {
  width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent;
  color: var(--text-2); font-size: 18px; cursor: pointer;
}
.ed-shortcuts dl { display: flex; flex-direction: column; gap: 7px; margin: 0; }
.ed-shortcuts dl div { display: flex; gap: 12px; font-size: 11px; }
.ed-shortcuts dt { flex: 0 0 92px; color: var(--text-3); font-family: ui-monospace, SFMono-Regular, monospace; }
.ed-shortcuts dd { margin: 0; color: var(--text-1); }
@media (max-width: 900px) {
  .ed-main, .ed-main.is-empty { grid-template-columns: minmax(0, 1fr); }
  .ed-left { display: none; }
  .ed-main.is-media-open .ed-left {
    display: flex; position: fixed; left: 0; top: 52px; bottom: 0;
    width: min(300px, 86vw); z-index: 60; box-shadow: 0 0 30px rgba(0, 0, 0, .45);
  }
}
</style>
