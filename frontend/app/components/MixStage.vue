<template>
  <section
    ref="rootRef"
    class="mx-stage"
    tabindex="0"
    @keydown="onKeydown"
    @pointerdown.capture="focusStage"
  >
    <header class="mx-top">
      <div class="mx-top-left">
        <span class="mx-title"><SlidersHorizontal :size="14" /> {{ t('mix.title') }}</span>
        <span v-if="episodeId" class="mx-meta">{{ t('mix.trackCount', { n: tracks.length }) }} · {{ formatTime(totalDuration) }}</span>
        <span :class="['mx-status', { 'is-dirty': dirty, 'is-saving': saving }]">{{ saveState }}</span>
        <span v-if="separationRunning" class="mx-chip is-accent">{{ t('mix.separating') }}</span>
        <span v-else-if="separation?.engine === 'basic'" class="mx-chip is-warning">{{ t('mix.engineBasic') }}</span>
      </div>
      <div class="mx-top-actions">
        <button class="mx-btn" :class="{ 'is-primary': !hasAssets }" type="button" :disabled="!episodeId || separationRunning || loading" @click="requestSeparate(false)">
          <AudioWaveform :size="12" />
          {{ hasAssets ? t('mix.reseparate') : t('mix.separate') }}
        </button>
        <button v-if="separationRunning" class="mx-btn is-plain" type="button" @click="onCancelSeparation">{{ t('mix.separationCancel') }}</button>
        <span class="mx-divider" />
        <button class="mx-icon" type="button" :title="t('mix.undo')" :disabled="!canUndo" @click="undo"><Undo2 :size="13" /></button>
        <button class="mx-icon" type="button" :title="t('mix.redo')" :disabled="!canRedo" @click="redo"><Redo2 :size="13" /></button>
        <button :class="['mx-icon', { on: snap }]" type="button" :title="t('mix.snap')" @click="toggleSnap"><Magnet :size="13" /></button>
        <span class="mx-divider" />
        <button class="mx-icon" type="button" :title="t('mix.zoomOut')" @click="nudgeZoom(-8)"><Minus :size="12" /></button>
        <input
          class="mx-zoom"
          type="range"
          min="8"
          max="240"
          step="4"
          :value="zoom"
          :aria-label="t('mix.zoom')"
          @input="onZoomInput"
        />
        <button class="mx-icon" type="button" :title="t('mix.zoomIn')" @click="nudgeZoom(8)"><Plus :size="12" /></button>
        <span class="mx-zoom-val">{{ Math.round(zoom) }}</span>
        <span class="mx-divider" />
        <button class="mx-icon" type="button" :title="t('mix.addTrack')" :disabled="!episodeId || loading" @click="addAmbienceTrack"><Plus :size="13" /></button>
        <button class="mx-btn is-plain" type="button" :disabled="!episodeId || saving" @click="onSaveRevision">
          <Save :size="12" />
          {{ t('mix.saveRevision') }}
        </button>
        <button class="mx-icon" type="button" :title="t('mix.refresh')" :disabled="loading" @click="requestReload">
          <RefreshCw :size="13" :class="{ 'animate-spin': loading }" />
        </button>
      </div>
    </header>

    <div v-if="separationRunning" class="mx-progress">
      <div class="mx-progress-bar"><span :style="{ width: `${separation?.progress || 0}%` }" /></div>
      <span class="mx-progress-text">{{ separation?.step || t('mix.separationPreparing') }} · {{ separation?.progress || 0 }}%</span>
    </div>

    <p v-if="error" class="mx-error">{{ error }}</p>

    <div class="mx-body">
      <aside class="mx-heads">
        <div class="mx-heads-label">{{ t('mix.trackColumn') }}</div>
        <div class="mx-heads-clip">
          <div class="mx-heads-inner" :style="{ transform: `translateY(-${scrollTop}px)` }">
            <div class="mx-heads-spacer" />
            <MixTrackHead
              v-for="track in tracks"
              :key="track._uid"
              :track="track"
              :active="activeTrackUid === track._uid"
              @select="onSelectTrack"
              @update="onTrackUpdate"
              @remove="requestRemoveTrack"
              @resize="onTrackResize"
              @begin-change="beginChange"
              @end-change="endChange"
            />
          </div>
        </div>
      </aside>

      <div class="mx-canvas">
        <MixTimeline
          ref="timelineRef"
          :episode-id="episodeId"
          :tracks="tracks"
          :duration-ms="totalDuration"
          :playhead-ms="playheadMs"
          :range-start-ms="rangeStartMs"
          :range-end-ms="rangeEndMs"
          :zoom="zoom"
          :snap="snap"
          :snap-ms="100"
          :selected="selection"
          :active-track-uid="activeTrackUid"
          :line-texts="lineTexts"
          :line-numbers="lineNumbers"
          @select="onSelectClip"
          @select-track="onSelectTrack"
          @seek="onSeek"
          @move="onMoveClip"
          @trim-start="onTrimStart"
          @trim-end="onTrimEnd"
          @begin-change="beginChange"
          @end-change="endChange"
          @locate="onLocateClip"
          @zoom="setZoom"
          @scroll-top="scrollTop = $event"
        />
        <div v-if="loading" class="mx-overlay">
          <Loader2 :size="18" class="animate-spin" />
          <span>{{ t('mix.loading') }}</span>
        </div>
        <div v-else-if="!episodeId" class="mx-overlay">
          <span>{{ t('mix.noEpisode') }}</span>
        </div>
        <div v-else-if="showEmpty" class="mx-overlay is-empty">
          <AudioLines :size="26" />
          <b>{{ t('mix.emptyTitle') }}</b>
          <p>{{ t('mix.emptyHint') }}</p>
          <div class="mx-empty-actions">
            <button class="mx-btn is-primary" type="button" :disabled="separationRunning" @click="requestSeparate(false)">
              <AudioWaveform :size="12" />
              {{ t('mix.separate') }}
            </button>
            <button class="mx-btn is-plain" type="button" @click="addAmbienceTrack">{{ t('mix.addTrack') }}</button>
          </div>
        </div>
      </div>

      <MixClipInspector
        :clip="selectedClip"
        :track="inspectorTrack"
        :buses="buses"
        :assets="assets"
        :revisions="revisions"
        :separation="separation"
        :line-text="inspectorLineText"
        :line-number="inspectorLineNumber"
        :master="plan?.master ?? null"
        :saving="saving"
        @update-clip="onUpdateClip"
        @update-track="onTrackUpdate"
        @update-bus="onBusUpdate"
        @remove-clip="removeClip"
        @split-clip="onSplitClip"
        @duplicate-clip="onDuplicateClip"
        @locate-line="emit('locate-line', $event)"
        @regenerate-line="emit('regenerate-line', $event)"
        @add-track="addTrack"
        @remove-track="requestRemoveTrack"
        @insert-asset="insertAsset"
        @remove-asset="requestRemoveAsset"
        @restore-revision="requestRestoreRevision"
        @separate="requestSeparate"
        @cancel-separation="onCancelSeparation"
        @begin-change="beginChange"
        @end-change="endChange"
      />
    </div>

    <footer class="mx-transport">
      <div class="mx-transport-group">
        <span class="mx-transport-label">{{ t('mix.range') }}</span>
        <input class="mx-time-input" type="number" min="0" step="0.1" :value="toSec(rangeStartMs)" :aria-label="t('mix.rangeStart')" @change="setRangeStart" />
        <span class="mx-muted">–</span>
        <input class="mx-time-input" type="number" min="0" step="0.1" :value="toSec(rangeEndMs)" :aria-label="t('mix.rangeEnd')" @change="setRangeEnd" />
        <button class="mx-btn" :class="{ 'is-primary': !preview }" type="button" :disabled="previewing || !episodeId || !hasAnyAudio" @click="generatePreview(true)">
          <Loader2 v-if="previewing" :size="12" class="animate-spin" />
          <AudioLines v-else :size="12" />
          {{ previewing ? t('mix.previewing') : t('mix.preview') }}
        </button>
        <button class="mx-icon" type="button" :title="playing ? t('mix.pause') : t('mix.play')" :disabled="previewing || !episodeId || !hasAnyAudio" @click="togglePlay">
          <Pause v-if="playing" :size="13" />
          <Play v-else :size="13" />
        </button>
        <label class="mx-check">
          <input v-model="loopPreview" type="checkbox" />
          {{ t('mix.loopPreview') }}
        </label>
        <span v-if="preview" class="mx-muted">{{ t('mix.previewReady') }}<template v-if="preview.cached"> · {{ t('mix.previewCached') }}</template></span>
        <span v-else class="mx-muted">{{ t('mix.previewLimit') }}</span>
      </div>

      <div class="mx-transport-group is-master">
        <button class="mx-icon" type="button" :title="t('mix.masterMute')" @click="toggleMasterMute">
          <VolumeX v-if="masterMuted" :size="13" />
          <Volume2 v-else :size="13" />
        </button>
        <input
          class="mx-master-range"
          type="range"
          min="0"
          max="200"
          step="1"
          :value="masterVolumePct"
          :aria-label="t('mix.masterVolume')"
          @pointerdown="beginChange"
          @pointerup="endChange"
          @input="setMasterVolume"
          @change="endChange"
        />
        <span class="mx-muted">{{ masterVolumePct }}%</span>
        <span class="mx-target">{{ t('mix.lufsTarget') }} <b>{{ plan?.master?.lufs ?? '—' }}</b></span>
        <span class="mx-target">{{ t('mix.truePeakTarget') }} <b>{{ plan?.master?.truePeak ?? '—' }}</b></span>
      </div>

      <div class="mx-transport-group is-right">
        <span class="mx-playhead">{{ formatTimePrecise(playheadMs) }} / {{ formatTime(totalDuration) }}</span>
        <span class="mx-muted">{{ t('mix.shortcutHint') }}</span>
      </div>
    </footer>

    <audio
      ref="previewAudio"
      class="mx-hidden-audio"
      :src="previewUrl"
      :loop="loopPreview"
      preload="none"
      @play="playing = true"
      @pause="playing = false"
      @timeupdate="onPreviewTime"
      @ended="onPreviewEnded"
    />

    <ConfirmDialog
      :open="confirmState.open"
      :title="confirmState.title"
      :message="confirmState.message"
      :confirm-text="confirmState.confirmText"
      :loading="confirmState.loading"
      @cancel="closeConfirm"
      @confirm="runConfirm"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import {
  AudioLines,
  AudioWaveform,
  Loader2,
  Magnet,
  Minus,
  Pause,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Undo2,
  Volume2,
  VolumeX,
} from 'lucide-vue-next'
import type {
  EpisodeAudioAsset,
  MixBus,
  MixBusKey,
  MixClip,
  MixRevision,
  MixTrack,
} from '~/composables/useApi'
import { useMixStage, type StageClip, type StageTrack } from '~/composables/useMixStage'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import MixClipInspector from '~/components/MixClipInspector.vue'
import MixTimeline from '~/components/MixTimeline.vue'
import MixTrackHead from '~/components/MixTrackHead.vue'

const props = defineProps<{
  episodeId: number | null
  dramaId: number
  durationMs: number
  lineTexts?: Record<number, string>
  lineNumbers?: Record<number, number>
}>()

const emit = defineEmits<{
  'locate-line': [lineId: number]
  'regenerate-line': [lineId: number]
}>()

const { t } = useI18n()

const stage = useMixStage({
  episodeId: () => props.episodeId,
  dramaId: () => props.dramaId,
})

const {
  plan,
  tracks,
  buses,
  assets,
  revisions,
  separation,
  separationRunning,
  loading,
  saving,
  dirty,
  error,
  preview,
  previewing,
  selectedClip,
  selectedTrack,
  playheadMs,
  zoom,
  snap,
  canUndo,
  canRedo,
  durationMs: planDuration,
  load,
  addTrack: addStageTrack,
  updateTrack,
  updateBus,
  removeTrack,
  createClip,
  updateClip,
  removeClip,
  splitClip,
  duplicateClip,
  moveClip,
  trimClip,
  selectClip,
  clearSelection,
  setPlayhead,
  setZoom,
  undo,
  redo,
  runSeparation,
  cancelSeparation,
  previewRange,
  saveRevision,
  restoreRevision,
  removeAsset,
  dispose,
} = stage

const rootRef = ref<HTMLElement | null>(null)
const timelineRef = ref<{ scrollToMs: (ms: number) => void } | null>(null)
const previewAudio = ref<HTMLAudioElement | null>(null)
const scrollTop = ref(0)
const activeTrackUid = ref<string | null>(null)
const rangeStartMs = ref(0)
const rangeEndMs = ref(0)
const loopPreview = ref(false)
const playing = ref(false)

const totalDuration = computed(() => Math.max(1000, planDuration.value || 0, props.durationMs || 0))
const hasAssets = computed(() => assets.value.length > 0)
const hasAnyAudio = computed(() => tracks.value.some(track => track.clips.length > 0))
const showEmpty = computed(() => !hasAnyAudio.value && !tracks.value.some(track => !track.virtual))
const selection = computed(() => {
  if (!selectedClip.value || !selectedTrack.value) return null
  return { trackUid: selectedTrack.value._uid, clipUid: selectedClip.value._uid }
})
const activeTrack = computed(() => tracks.value.find(track => track._uid === activeTrackUid.value) ?? null)
const inspectorTrack = computed(() => selectedTrack.value ?? activeTrack.value)
const inspectorLineText = computed(() => {
  const lineId = selectedClip.value?.lineId
  return lineId ? props.lineTexts?.[lineId] ?? null : null
})
const inspectorLineNumber = computed(() => {
  const lineId = selectedClip.value?.lineId
  return lineId ? props.lineNumbers?.[lineId] ?? null : null
})
const masterBus = computed(() => buses.value.find(bus => bus.key === 'master') ?? null)
const masterVolumePct = computed(() => Math.round((masterBus.value?.volume ?? 1) * 100))
const masterMuted = computed(() => Boolean(masterBus.value?.muted))
const saveState = computed(() => saving.value ? t('mix.saving') : dirty.value ? t('mix.unsaved') : t('mix.saved'))
const previewUrl = computed(() => {
  const url = preview.value?.url || ''
  if (!url) return ''
  return /^(https?:|blob:|data:|\/)/i.test(url) ? url : `/${url}`
})

const ROLE_META: Record<string, { label: string; bus: MixBusKey }> = {
  dialogue: { label: 'mix.roleDialogue', bus: 'dialogue' },
  crowd: { label: 'mix.roleCrowd', bus: 'dialogue' },
  original: { label: 'mix.roleOriginal', bus: 'original' },
  ambience: { label: 'mix.roleAmbience', bus: 'original' },
  sfx: { label: 'mix.roleSfx', bus: 'sfx' },
  bgm: { label: 'mix.roleBgm', bus: 'bgm' },
  custom: { label: 'mix.roleCustom', bus: 'sfx' },
}
const ASSET_ROLE: Record<string, string> = {
  vocals: 'dialogue',
  instrumental: 'ambience',
  original: 'original',
}

function roleLabel(role: string): string {
  const meta = ROLE_META[role]
  return meta ? t(meta.label) : role
}
function assetLabel(asset: EpisodeAudioAsset): string {
  const raw = String(asset.url || '').split('/').pop() || ''
  if (!raw) return roleLabel(ASSET_ROLE[asset.kind] || 'sfx')
  try { return decodeURIComponent(raw) } catch { return raw }
}
function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}
function formatTimePrecise(ms: number): string {
  const total = Math.max(0, ms) / 1000
  const minutes = Math.floor(total / 60)
  return `${minutes}:${(total - minutes * 60).toFixed(1).padStart(4, '0')}`
}
function toSec(ms: number): number {
  return Math.round(Math.max(0, Number(ms) || 0) / 100) / 10
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

watch(() => props.episodeId, (id, previous) => {
  if (id === previous) return
  pausePreview()
  preview.value = null
  activeTrackUid.value = null
  rangeStartMs.value = 0
  rangeEndMs.value = 0
  if (id) void load()
}, { immediate: true })

watch(tracks, (list) => {
  if (!list.length) {
    activeTrackUid.value = null
    return
  }
  if (!list.some(track => track._uid === activeTrackUid.value)) {
    activeTrackUid.value = (list.find(track => !track.virtual) ?? list[0])._uid
  }
}, { immediate: true })

watch(totalDuration, (total) => {
  if (rangeEndMs.value <= rangeStartMs.value || rangeEndMs.value > total) {
    rangeEndMs.value = total
  }
  if (rangeStartMs.value >= total) rangeStartMs.value = 0
}, { immediate: true })

onBeforeUnmount(() => {
  pausePreview()
  dispose()
})

function onSelectClip(track: StageTrack, clip: StageClip) {
  activeTrackUid.value = track._uid
  selectClip(track, clip)
}
function onSelectTrack(track: StageTrack | null) {
  activeTrackUid.value = track?._uid ?? null
  clearSelection()
}
function onTrackUpdate(track: StageTrack, patch: Record<string, unknown>) {
  updateTrack(track, patch as Partial<Omit<MixTrack, 'clips' | 'id' | 'virtual'>>)
}
function onTrackResize(track: StageTrack, height: number) {
  updateTrack(track, { height })
}
function onUpdateClip(clip: StageClip, patch: Partial<MixClip>) {
  updateClip(clip, patch)
}
function onBusUpdate(bus: MixBus, patch: Record<string, unknown>) {
  updateBus(bus, patch)
}
function beginChange() {
  stage.beginChange()
}
function endChange() {
  stage.endChange()
}
function onMoveClip(clip: StageClip, startMs: number) {
  moveClip(clip, startMs)
}
function onTrimStart(clip: StageClip, ms: number) {
  trimClip(clip, 'start', ms)
}
function onTrimEnd(clip: StageClip, ms: number) {
  trimClip(clip, 'end', ms)
}
function onSeek(ms: number) {
  setPlayhead(ms)
  const audio = previewAudio.value
  const current = preview.value
  if (!audio || !current || audio.paused) return
  if (ms < current.startMs || ms > current.endMs) {
    audio.pause()
    return
  }
  audio.currentTime = (ms - current.startMs) / 1000
}
function onLocateClip(clip: StageClip) {
  if (clip.lineId) emit('locate-line', clip.lineId)
  else toast.info(t('mix.locateMissing'))
}
function onSplitClip(clip: StageClip) {
  if (playheadMs.value <= clip.startMs || playheadMs.value >= clip.endMs) {
    toast.error(t('mix.splitNeedsPlayhead'))
    return
  }
  splitClip(clip, playheadMs.value)
}
function onDuplicateClip(clip: StageClip) {
  const copy = duplicateClip(clip)
  if (copy && selectedTrack.value) selectClip(selectedTrack.value, copy)
}
function splitSelected() {
  if (selectedClip.value) onSplitClip(selectedClip.value)
}
function deleteSelected() {
  if (selectedClip.value) removeClip(selectedClip.value)
}
function toggleSelectedTrackMute() {
  const track = selectedTrack.value ?? activeTrack.value
  if (track && !track.virtual) updateTrack(track, { muted: !track.muted })
}
function toggleSnap() {
  snap.value = !snap.value
}
function nudgeZoom(delta: number) {
  setZoom(zoom.value + delta)
}
function onZoomInput(event: Event) {
  setZoom(Number((event.target as HTMLInputElement).value))
}
function setRangeStart(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  rangeStartMs.value = clamp(Math.round(value * 1000), 0, Math.max(0, rangeEndMs.value - 200))
}
function setRangeEnd(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  rangeEndMs.value = clamp(Math.round(value * 1000), rangeStartMs.value + 200, totalDuration.value)
}
function setMasterVolume(event: Event) {
  const bus = masterBus.value
  const value = Number((event.target as HTMLInputElement).value)
  if (!bus || !Number.isFinite(value)) return
  updateBus(bus, { volume: value / 100 })
}
function toggleMasterMute() {
  const bus = masterBus.value
  if (bus) updateBus(bus, { muted: !bus.muted })
}
function addTrack(role: string) {
  const meta = ROLE_META[role]
  const track = addStageTrack({ role, busId: meta?.bus, name: roleLabel(role) })
  if (track) {
    activeTrackUid.value = track._uid
    clearSelection()
  }
}
function addAmbienceTrack() {
  addTrack('ambience')
}

function insertAsset(asset: EpisodeAudioAsset) {
  if (!asset.url) {
    toast.error(t('mix.assetNoUrl'))
    return
  }
  const preferredRole = ASSET_ROLE[asset.kind] || 'sfx'
  let target = activeTrack.value
  if (!target || target.virtual || target.locked) {
    target = tracks.value.find(track => !track.virtual && !track.locked && track.role === preferredRole)
      ?? tracks.value.find(track => !track.virtual && !track.locked)
      ?? null
  }
  if (!target) {
    target = addStageTrack({ role: preferredRole, busId: ROLE_META[preferredRole]?.bus, name: roleLabel(preferredRole) })
  }
  if (!target) return
  const duration = Math.max(500, Number(asset.durationMs) || 10000)
  const start = playheadMs.value
  const clip = createClip(target, {
    startMs: start,
    endMs: start + duration,
    audioUrl: asset.url,
    assetId: asset.id,
    name: assetLabel(asset),
  })
  if (clip) {
    activeTrackUid.value = target._uid
    selectClip(target, clip)
  }
}

function pausePreview() {
  const audio = previewAudio.value
  if (audio) audio.pause()
  playing.value = false
}
async function generatePreview(autoPlay: boolean) {
  if (!props.episodeId) return
  if (!hasAnyAudio.value) {
    toast.error(t('mix.noAudio'))
    return
  }
  const start = clamp(Math.round(rangeStartMs.value), 0, Math.max(0, totalDuration.value - 200))
  let end = clamp(Math.round(rangeEndMs.value), start + 200, totalDuration.value)
  if (end - start > 30000) {
    end = start + 30000
    toast.info(t('mix.previewLimit'))
  }
  try {
    const result = await previewRange(start, end)
    if (!result) return
    if (!autoPlay) return
    await nextTick()
    const audio = previewAudio.value
    if (!audio) return
    audio.currentTime = 0
    await audio.play().catch(() => {})
  } catch (err: any) {
    toast.error(err?.message || t('mix.previewFailed'))
  }
}
async function togglePlay() {
  const audio = previewAudio.value
  if (!preview.value) {
    await generatePreview(true)
    return
  }
  if (!audio) return
  if (audio.paused) {
    if (audio.ended) audio.currentTime = 0
    await audio.play().catch(() => {})
  } else {
    audio.pause()
  }
}
function onPreviewTime() {
  const audio = previewAudio.value
  const current = preview.value
  if (!audio || !current) return
  playing.value = !audio.paused
  setPlayhead(current.startMs + audio.currentTime * 1000)
}
function onPreviewEnded() {
  playing.value = false
}

async function requestSeparate(force: boolean) {
  if (!props.episodeId) return
  if (force || hasAssets.value) {
    openConfirm({
      title: force ? t('mix.reseparate') : t('mix.separate'),
      message: t('mix.reseparateConfirm'),
      confirmText: force ? t('mix.reseparate') : t('mix.separate'),
      action: () => runSeparate(true),
    })
    return
  }
  await runSeparate(false)
}
async function runSeparate(force: boolean) {
  try {
    const result = await runSeparation({ force })
    if (result?.status === 'done') toast.success(t('mix.separateReused'))
    else toast.success(t('mix.separateStarted'))
  } catch (err: any) {
    toast.error(err?.message || t('mix.separateFailed'))
  }
}
async function onCancelSeparation() {
  try {
    await cancelSeparation()
    toast.success(t('mix.separationCancelled'))
  } catch (err: any) {
    toast.error(err?.message || t('mix.separationCancelFailed'))
  }
}
async function onSaveRevision() {
  try {
    const revision = await saveRevision()
    if (revision) toast.success(t('mix.revisionSaved', { n: revision.revisionNo }))
  } catch (err: any) {
    toast.error(err?.message || t('mix.revisionSaveFailed'))
  }
}

const confirmState = ref({
  open: false,
  title: '',
  message: '',
  confirmText: '',
  loading: false,
  action: null as null | (() => void | Promise<void>),
})
function openConfirm(options: { title: string; message: string; confirmText: string; action: () => void | Promise<void> }) {
  confirmState.value = { open: true, ...options, loading: false }
}
function closeConfirm() {
  if (confirmState.value.loading) return
  confirmState.value.open = false
  confirmState.value.action = null
}
async function runConfirm() {
  const action = confirmState.value.action
  if (!action) return
  confirmState.value.loading = true
  try {
    await action()
    confirmState.value.open = false
    confirmState.value.action = null
  } catch (err: any) {
    toast.error(err?.message || t('mix.actionFailed'))
  } finally {
    confirmState.value.loading = false
  }
}
function requestRemoveTrack(track: StageTrack) {
  openConfirm({
    title: t('mix.trackRemove'),
    message: t('mix.trackRemoveConfirm', { name: track.name }),
    confirmText: t('mix.trackRemove'),
    action: () => { removeTrack(track) },
  })
}
function requestRemoveAsset(asset: EpisodeAudioAsset) {
  openConfirm({
    title: t('mix.assetRemove'),
    message: t('mix.assetRemoveConfirm', { name: assetLabel(asset) }),
    confirmText: t('mix.assetRemove'),
    action: async () => { await removeAsset(asset.id) },
  })
}
function requestRestoreRevision(revision: MixRevision) {
  openConfirm({
    title: t('mix.revisionRestore'),
    message: t('mix.revisionRestoreConfirm', { n: revision.revisionNo }),
    confirmText: t('mix.revisionRestore'),
    action: async () => {
      await restoreRevision(revision.id)
      toast.success(t('mix.revisionRestored', { n: revision.revisionNo }))
    },
  })
}
function requestReload() {
  if (dirty.value) {
    openConfirm({
      title: t('mix.refresh'),
      message: t('mix.refreshConfirm'),
      confirmText: t('mix.refresh'),
      action: async () => { await load() },
    })
    return
  }
  void load()
}

function isFormTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'AUDIO' || el.isContentEditable
}
function focusStage(event: PointerEvent) {
  if (isFormTarget(event.target)) return
  void nextTick(() => rootRef.value?.focus({ preventScroll: true }))
}
function onKeydown(event: KeyboardEvent) {
  if (isFormTarget(event.target)) return
  const meta = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
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
  if (event.code === 'Space') {
    event.preventDefault()
    void togglePlay()
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (selectedClip.value) {
      event.preventDefault()
      deleteSelected()
    }
    return
  }
  if (!meta && key === 's') {
    event.preventDefault()
    splitSelected()
    return
  }
  if (!meta && key === 'm') {
    event.preventDefault()
    toggleSelectedTrackMute()
    return
  }
  if (event.key === 'Escape') clearSelection()
}
</script>

<style scoped>
.mx-stage {
  display: flex;
  flex-direction: column;
  height: clamp(620px, 78vh, 880px);
  min-height: 540px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg-1);
  overflow: hidden;
  outline: none;
  container: mx-stage / inline-size;
}
.mx-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 42px; padding: 5px 10px; border-bottom: 1px solid var(--border); background: var(--bg-1); }
.mx-top-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
.mx-title { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--text-0); }
.mx-title svg { color: var(--accent-text); }
.mx-meta { font-size: 9.5px; color: var(--text-3); }
.mx-status { font-size: 9.5px; color: var(--text-3); }
.mx-status.is-dirty { color: var(--warning); }
.mx-status.is-saving { color: var(--accent-text); }
.mx-top-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-left: auto; }
.mx-chip { padding: 0 6px; border: 1px solid var(--border); border-radius: 999px; font-size: 9px; line-height: 16px; color: var(--text-2); white-space: nowrap; }
.mx-chip.is-accent { border-color: var(--accent-glow); background: var(--accent-bg); color: var(--accent-text); }
.mx-chip.is-warning { border-color: transparent; background: var(--warning-bg); color: var(--warning); }
.mx-btn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-0); color: var(--text-1); font: inherit; font-size: 10px; font-weight: 600; cursor: pointer; white-space: nowrap; }
.mx-btn:hover { border-color: var(--accent); color: var(--accent-text); }
.mx-btn.is-primary { border-color: var(--accent); background: var(--accent); color: var(--action-primary-text); }
.mx-btn.is-primary:hover { background: var(--action-primary-hover); color: #fff; }
.mx-btn:disabled { opacity: .5; cursor: default; }
.mx-icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--text-2); cursor: pointer; }
.mx-icon:hover { background: var(--bg-hover); color: var(--text-0); }
.mx-icon.on { border-color: var(--accent-glow); background: var(--accent-bg); color: var(--accent-text); }
.mx-icon:disabled { opacity: .4; cursor: default; }
.mx-divider { width: 1px; height: 16px; background: var(--border); }
.mx-zoom { width: 84px; height: 12px; accent-color: var(--accent); }
.mx-zoom-val { width: 24px; font-size: 9px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.mx-progress { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-bottom: 1px solid var(--border); background: var(--accent-bg); }
.mx-progress-bar { flex: 1; height: 3px; border-radius: 2px; background: var(--bg-3); overflow: hidden; }
.mx-progress-bar span { display: block; height: 100%; background: var(--accent); transition: width .2s ease; }
.mx-progress-text { font-size: 9px; color: var(--accent-text); white-space: nowrap; }
.mx-error { margin: 0; padding: 5px 10px; border-bottom: 1px solid var(--border); background: var(--action-danger-bg); font-size: 10px; color: var(--action-danger); }
.mx-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 288px minmax(0, 1fr) 316px; }
.mx-heads { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--border); background: var(--bg-1); overflow: hidden; }
.mx-heads-label { flex: none; height: 30px; display: flex; align-items: center; padding: 0 10px; border-bottom: 1px solid var(--border); font-size: 9px; letter-spacing: .04em; text-transform: uppercase; color: var(--text-3); }
.mx-heads-clip { flex: 1; min-height: 0; overflow: hidden; }
.mx-heads-inner { will-change: transform; }
.mx-heads-spacer { height: 0; }
.mx-canvas { position: relative; min-width: 0; min-height: 0; display: flex; }
.mx-overlay { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 24px; background: color-mix(in srgb, var(--bg-1) 86%, transparent); backdrop-filter: blur(2px); color: var(--text-2); font-size: 11px; text-align: center; z-index: 3; }
.mx-overlay.is-empty { gap: 6px; }
.mx-overlay.is-empty svg { color: var(--accent-text); }
.mx-overlay.is-empty b { font-size: 12.5px; color: var(--text-0); }
.mx-overlay.is-empty p { margin: 0; max-width: 380px; font-size: 10.5px; line-height: 1.6; color: var(--text-3); }
.mx-empty-actions { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.mx-transport { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-height: 50px; padding: 6px 10px; border-top: 1px solid var(--border); background: var(--bg-0); }
.mx-transport-group { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-width: 0; }
.mx-transport-group.is-master { padding-left: 12px; border-left: 1px solid var(--border); }
.mx-transport-group.is-right { margin-left: auto; gap: 8px; }
.mx-transport-label { font-size: 9.5px; color: var(--text-3); }
.mx-time-input { width: 58px; height: 23px; padding: 0 5px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-1); font: inherit; font-size: 10px; color: var(--text-0); font-variant-numeric: tabular-nums; }
.mx-time-input:focus { outline: none; border-color: var(--accent); }
.mx-check { display: inline-flex; align-items: center; gap: 3px; font-size: 9.5px; color: var(--text-2); cursor: pointer; }
.mx-check input { accent-color: var(--accent); }
.mx-muted { font-size: 9.5px; color: var(--text-3); }
.mx-master-range { width: 90px; height: 12px; accent-color: var(--accent); }
.mx-target { font-size: 9px; color: var(--text-3); white-space: nowrap; }
.mx-target b { color: var(--text-1); font-variant-numeric: tabular-nums; }
.mx-playhead { font-size: 10px; color: var(--text-1); font-variant-numeric: tabular-nums; }
.mx-hidden-audio { display: none; }
@container mx-stage (max-width: 1180px) {
  .mx-body { grid-template-columns: 232px minmax(0, 1fr) 272px; }
}
@container mx-stage (max-width: 960px) {
  .mx-body { grid-template-columns: 210px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) 230px; }
  .mx-heads { grid-row: 1; }
  .mx-canvas { grid-row: 1; }
  .mx-body :deep(.mx-ins) { grid-column: 1 / -1; grid-row: 2; border-left: none; border-top: 1px solid var(--border); }
  .mx-transport-group.is-master { padding-left: 0; border-left: none; }
}
</style>
