<template>
  <section
    ref="rootRef"
    :class="['mx-stage', { 'is-generating': soundscapeRunning }]"
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
        <span v-if="soundscapeRunning" class="mx-chip is-accent">{{ t('mix.soundscape.running') }}</span>
      </div>
      <div class="mx-top-actions">
        <template v-if="$slots.actions">
          <slot name="actions" />
          <span class="mx-divider" />
        </template>
        <button class="mx-btn" :class="{ 'is-primary': !hasAssets }" type="button" :disabled="!episodeId || separationRunning || soundscapeRunning || loading" @click="requestSeparate(false)">
          <AudioWaveform :size="12" />
          {{ hasAssets ? t('mix.reseparate') : t('mix.separate') }}
        </button>
        <button v-if="separationRunning" class="mx-btn is-plain" type="button" @click="onCancelSeparation">{{ t('mix.separationCancel') }}</button>
        <button
          class="mx-btn"
          :class="{ 'is-primary': hasAssets && !soundscapeRunning }"
          type="button"
          :disabled="!canGenerateSound || separationRunning || soundscapeRunning || loading"
          :title="canGenerateSound ? t('mix.soundscape.entryHint') : t('mix.soundscape.needMerge')"
          @click="openSoundscape"
        >
          <Sparkles :size="12" />
          {{ t('mix.soundscape.entry') }}
        </button>
        <button v-if="soundscapeRunning" class="mx-btn is-plain" type="button" @click="onCancelSoundscape">{{ t('mix.soundscape.cancel') }}</button>
        <span class="mx-divider" />
        <button class="mx-icon" type="button" :title="t('mix.undo')" :disabled="!canUndo || soundscapeRunning" @click="undo"><Undo2 :size="13" /></button>
        <button class="mx-icon" type="button" :title="t('mix.redo')" :disabled="!canRedo || soundscapeRunning" @click="redo"><Redo2 :size="13" /></button>
        <button :class="['mx-icon', { on: snap }]" type="button" :title="t('mix.snap')" @click="toggleSnap"><Magnet :size="13" /></button>
        <span class="mx-divider" />
        <button class="mx-icon" type="button" :title="t('mix.fit')" @click="fitTimeline"><Maximize2 :size="12" /></button>
        <button class="mx-icon" type="button" :title="t('mix.zoomOut')" @click="nudgeZoom(-8)"><Minus :size="12" /></button>
        <input
          class="mx-zoom"
          type="range"
          min="1"
          max="240"
          step="4"
          :value="zoom"
          :aria-label="t('mix.zoom')"
          @input="onZoomInput"
        />
        <button class="mx-icon" type="button" :title="t('mix.zoomIn')" @click="nudgeZoom(8)"><Plus :size="12" /></button>
        <span class="mx-zoom-val">{{ Math.round(zoom) }}</span>
        <span class="mx-divider" />
        <AppMenu v-if="episodeId" v-model:open="addMenuOpen" :min-width="248">
          <template #trigger>
            <button class="mx-btn" type="button" :title="t('mix.addTrack')" :disabled="loading || soundscapeRunning">
              <Plus :size="12" />
              {{ t('mix.addTrack') }}
            </button>
          </template>
          <div class="mx-add-head">
            <b>{{ t('mix.addTrackMenuTitle') }}</b>
            <span>{{ t('mix.addTrackMenuHint') }}</span>
          </div>
          <AppMenuItem v-for="role in ADD_ROLES" :key="role" @click="addTrack(role)">
            <span class="mx-add-role">
              {{ roleLabel(role) }}
              <small>{{ roleHint(role) }}</small>
            </span>
            <template #trailing>{{ busLabel(ROLE_META[role]?.bus || 'sfx') }}</template>
          </AppMenuItem>
        </AppMenu>
        <button v-else class="mx-btn" type="button" :title="t('mix.addTrack')" disabled>
          <Plus :size="12" />
          {{ t('mix.addTrack') }}
        </button>
        <button class="mx-btn is-plain" type="button" :disabled="!episodeId || saving || soundscapeRunning" @click="onSaveRevision">
          <Save :size="12" />
          {{ t('mix.saveRevision') }}
        </button>
        <button class="mx-icon" type="button" :title="t('mix.refresh')" :disabled="loading || soundscapeRunning" @click="requestReload">
          <RefreshCw :size="13" :class="{ 'animate-spin': loading }" />
        </button>
        <button
          :class="['mx-icon', { on: inspectorOpen }]"
          type="button"
          :title="inspectorOpen ? t('mix.inspectorHide') : t('mix.inspectorShow')"
          @click="toggleInspector"
        >
          <PanelRightClose v-if="inspectorOpen" :size="13" />
          <PanelRightOpen v-else :size="13" />
        </button>
      </div>
    </header>

    <div v-if="separationRunning" class="mx-progress">
      <div class="mx-progress-bar"><span :style="{ width: `${separation?.progress || 0}%` }" /></div>
      <span class="mx-progress-text">{{ separation?.step || t('mix.separationPreparing') }} · {{ separation?.progress || 0 }}%</span>
    </div>
    <div v-if="soundscapeRunning" class="mx-progress">
      <div class="mx-progress-bar"><span :style="{ width: `${soundscapeStatus?.progress || 0}%` }" /></div>
      <span class="mx-progress-text">{{ soundscapeStatus?.step || t('mix.soundscape.preparing') }} · {{ soundscapeStatus?.progress || 0 }}%</span>
    </div>

    <p v-if="error" class="mx-error">{{ error }}</p>

    <div v-if="videoUrl" class="mx-monitor">
      <div class="mx-monitor-stage">
        <SubtitlePreview
          ref="videoPreview"
          :src="videoUrl"
          :cues="cues"
          :controls="false"
          :show-scrub="false"
          :muted="true"
          @timeupdate="onVideoTime"
          @duration="onVideoDuration"
          @play="onVideoPlay"
          @playing="onVideoPlaying"
          @pause="onVideoPause"
          @waiting="onVideoWaiting"
          @ended="onVideoEnded"
        />
      </div>
      <div class="mx-monitor-info">
        <span class="mx-monitor-kicker">{{ t('mix.monitorKicker') }}</span>
        <p class="mx-monitor-cue">{{ currentCueText || t('mix.monitorNoCue') }}</p>
        <span class="mx-monitor-time">{{ formatTimePrecise(playheadMs) }} / {{ formatTime(totalDuration) }}</span>
        <p class="mx-monitor-hint">{{ t('mix.monitorHint') }}</p>
      </div>
    </div>

    <div :class="['mx-body', { 'is-inspector-closed': !inspectorOpen }]">
      <aside class="mx-heads">
        <div class="mx-heads-label">{{ t('mix.trackColumn') }}</div>
        <div class="mx-heads-clip" @wheel="onHeadsWheel">
          <div class="mx-heads-inner" :style="{ transform: `translateY(-${scrollTop}px)` }">
            <div v-if="videoUrl" class="mx-heads-video" :style="{ height: `${VIDEO_LANE_H}px` }">
              <Film :size="12" />
              <span>{{ t('mix.videoLane') }}</span>
              <span class="mx-heads-video-tag">{{ t('mix.videoLaneReadonly') }}</span>
            </div>
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
          :video-url="videoUrl"
          :video-duration-ms="videoDurationMs"
          :follow="playing"
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
            <button class="mx-btn is-primary" type="button" :disabled="separationRunning || soundscapeRunning" @click="requestSeparate(false)">
              <AudioWaveform :size="12" />
              {{ t('mix.separate') }}
            </button>
            <button
              class="mx-btn is-plain"
              type="button"
              :disabled="!canGenerateSound || separationRunning || soundscapeRunning || loading"
              :title="canGenerateSound ? t('mix.soundscape.entryHint') : t('mix.soundscape.needMerge')"
              @click="openSoundscape"
            >
              <Sparkles :size="12" />
              {{ t('mix.soundscape.entry') }}
            </button>
            <AppMenu v-model:open="emptyMenuOpen" :min-width="248">
              <template #trigger>
                <button class="mx-btn is-plain" type="button">{{ t('mix.addTrack') }}</button>
              </template>
              <div class="mx-add-head">
                <b>{{ t('mix.addTrackMenuTitle') }}</b>
                <span>{{ t('mix.addTrackMenuHint') }}</span>
              </div>
              <AppMenuItem v-for="role in ADD_ROLES" :key="role" @click="addTrack(role)">
                <span class="mx-add-role">
                  {{ roleLabel(role) }}
                  <small>{{ roleHint(role) }}</small>
                </span>
                <template #trailing>{{ busLabel(ROLE_META[role]?.bus || 'sfx') }}</template>
              </AppMenuItem>
            </AppMenu>
          </div>
        </div>
      </div>

      <MixClipInspector
        v-show="inspectorOpen"
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
        :dirty="dirty"
        :can-edit="Boolean(episodeId) && !soundscapeRunning"
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
      >
        <template v-if="$slots.settings" #settings>
          <slot name="settings" />
        </template>
      </MixClipInspector>
    </div>

    <footer class="mx-transport">
      <div class="mx-transport-group">
        <span class="mx-transport-label">{{ t('mix.range') }}</span>
        <input class="mx-time-input" type="number" min="0" step="0.1" :value="toSec(rangeStartMs)" :aria-label="t('mix.rangeStart')" @change="setRangeStart" />
        <span class="mx-muted">–</span>
        <input class="mx-time-input" type="number" min="0" step="0.1" :value="toSec(rangeEndMs)" :aria-label="t('mix.rangeEnd')" @change="setRangeEnd" />
        <button class="mx-btn" type="button" :disabled="previewing || !episodeId || !hasAnyAudio || soundscapeRunning" @click="generatePreview()">
          <Loader2 v-if="previewing" :size="12" class="animate-spin" />
          <AudioLines v-else :size="12" />
          {{ previewing ? t('mix.previewing') : t('mix.preview') }}
        </button>
        <button class="mx-icon" type="button" :title="playing ? t('mix.pause') : t('mix.play')" :disabled="previewing || !episodeId || (!hasAnyAudio && !videoUrl)" @click="togglePlay">
          <Loader2 v-if="previewing || playbackLoading" :size="13" class="animate-spin" />
          <Pause v-else-if="playing" :size="13" />
          <Play v-else :size="13" />
        </button>
        <label class="mx-check" :title="t('mix.loopPreviewHint')">
          <input v-model="loopPreview" type="checkbox" :disabled="!preview" />
          {{ t('mix.loopPreview') }}
        </label>
        <span v-if="preview" class="mx-muted">{{ t('mix.previewReady') }}<template v-if="preview.cached"> · {{ t('mix.previewCached') }}</template></span>
        <span v-else class="mx-muted">{{ t('mix.realtimeHint') }}</span>
      </div>

      <div class="mx-transport-group is-master">
        <button class="mx-icon" type="button" :title="t('mix.masterMute')" :disabled="soundscapeRunning" @click="toggleMasterMute">
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
          :disabled="soundscapeRunning"
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
        <label class="mx-goto">
          <span class="mx-muted">{{ t('mix.playheadTime') }}</span>
          <input
            class="mx-time-input"
            type="number"
            min="0"
            step="0.1"
            :value="toSec(playheadMs)"
            :aria-label="t('mix.playheadTime')"
            @change="seekFromInput"
          />
          <span class="mx-muted">/ {{ formatTime(totalDuration) }}</span>
        </label>
        <span class="mx-muted">{{ t('mix.shortcutHint') }}</span>
      </div>
    </footer>

    <audio
      ref="previewAudio"
      class="mx-hidden-audio"
      :src="previewUrl"
      preload="none"
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

    <MixSoundscapeDialog
      :open="soundscapeOpen"
      :episode-id="episodeId"
      :preview="soundscapePlan"
      :previewing="soundscapePreviewing"
      :starting="soundscapeStarting"
      :error="soundscapeError"
      @close="soundscapeOpen = false"
      @preview="onSoundscapePreview"
      @start="onSoundscapeStart"
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
  Film,
  Loader2,
  Magnet,
  Maximize2,
  Minus,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Sparkles,
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
  SoundscapeRequest,
  TimelineCue,
} from '~/composables/useApi'
import { useMixPlayback } from '~/composables/useMixPlayback'
import { useMixStage, type StageClip, type StageTrack } from '~/composables/useMixStage'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import AppMenu from '~/components/AppMenu.vue'
import AppMenuItem from '~/components/AppMenuItem.vue'
import MixClipInspector from '~/components/MixClipInspector.vue'
import MixSoundscapeDialog from '~/components/MixSoundscapeDialog.vue'
import MixTimeline from '~/components/MixTimeline.vue'
import MixTrackHead from '~/components/MixTrackHead.vue'
import SubtitlePreview from '~/components/SubtitlePreview.vue'

const props = defineProps<{
  episodeId: number | null
  dramaId: number
  durationMs: number
  lineTexts?: Record<number, string>
  lineNumbers?: Record<number, number>
  videoUrl?: string | null
  cues?: TimelineCue[]
}>()

const emit = defineEmits<{
  'locate-line': [lineId: number]
  'regenerate-line': [lineId: number]
  'timeline-retimed': [lineId: number]
  'soundscape-busy': [busy: boolean]
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
  soundscapeStatus,
  soundscapeRunning,
  soundscapePlan,
  soundscapeStarting,
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
  refreshPlan,
  retimeLine,
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
  moveVirtualClip,
  trimClip,
  selectClip,
  clearSelection,
  setPlayhead,
  setZoom,
  undo,
  redo,
  runSeparation,
  cancelSeparation,
  previewSoundscape,
  startSoundscape,
  cancelSoundscape,
  previewRange,
  saveRevision,
  restoreRevision,
  removeAsset,
  dispose,
} = stage

const rootRef = ref<HTMLElement | null>(null)
const timelineRef = ref<{
  scrollToMs: (ms: number) => void
  scrollByY: (delta: number) => void
  fitToWidth: () => void
} | null>(null)
const videoPreview = ref<{
  play: () => Promise<void>
  pause: () => void
  seekTo: (ms: number) => void
  videoEl: HTMLVideoElement | null
  currentMs: number
  durationMs: number
} | null>(null)
const previewAudio = ref<HTMLAudioElement | null>(null)
const videoDurationMs = ref(0)
const scrollTop = ref(0)
const activeTrackUid = ref<string | null>(null)
const rangeStartMs = ref(0)
const rangeEndMs = ref(0)
const loopPreview = ref(false)
const playing = ref(false)
const renderedMode = ref(false)
let previewToken = 0
let pendingRetime: { lineId: number; startMs: number } | null = null
const addMenuOpen = ref(false)
const emptyMenuOpen = ref(false)
const inspectorOpen = ref(readInspectorPreference())
const soundscapeOpen = ref(false)
const soundscapePreviewing = ref(false)
const soundscapeError = ref('')

const playback = useMixPlayback({
  tracks: () => tracks.value,
  buses: () => buses.value,
})
const playbackLoading = playback.loading
const playbackMissing = playback.missing
let engineRaf = 0
let engineStarting = false
let rescheduleTimer: ReturnType<typeof setTimeout> | null = null

function readInspectorPreference(): boolean {
  try {
    return localStorage.getItem('huobao:mix:inspector') !== '0'
  } catch {
    return true
  }
}

function toggleInspector() {
  inspectorOpen.value = !inspectorOpen.value
  try {
    localStorage.setItem('huobao:mix:inspector', inspectorOpen.value ? '1' : '0')
  } catch { /* localStorage 不可用时仅本次生效 */ }
}

const cues = computed(() => props.cues ?? [])
const videoUrl = computed(() => String(props.videoUrl || '').trim())
const totalDuration = computed(() => Math.max(1000, planDuration.value || 0, props.durationMs || 0, videoDurationMs.value || 0))
const currentCueText = computed(() => {
  const cue = cues.value.find(item =>
    playheadMs.value >= item.subtitleStartMs && playheadMs.value <= item.subtitleEndMs)
  return cue?.text || ''
})
const hasAssets = computed(() => assets.value.length > 0)
const canGenerateSound = computed(() => Boolean(props.episodeId && props.durationMs > 0))
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

const VIDEO_LANE_H = 58
const ROLE_META: Record<string, { label: string; bus: MixBusKey }> = {  dialogue: { label: 'mix.roleDialogue', bus: 'dialogue' },
  crowd: { label: 'mix.roleCrowd', bus: 'dialogue' },
  original: { label: 'mix.roleOriginal', bus: 'original' },
  ambience: { label: 'mix.roleAmbience', bus: 'original' },
  sfx: { label: 'mix.roleSfx', bus: 'sfx' },
  bgm: { label: 'mix.roleBgm', bus: 'bgm' },
  custom: { label: 'mix.roleCustom', bus: 'sfx' },
}
const ROLE_HINTS: Record<string, string> = {
  dialogue: 'mix.roleDialogueHint',
  crowd: 'mix.roleCrowdHint',
  original: 'mix.roleOriginalHint',
  ambience: 'mix.roleAmbienceHint',
  sfx: 'mix.roleSfxHint',
  bgm: 'mix.roleBgmHint',
  custom: 'mix.roleCustomHint',
}
const ASSET_ROLE: Record<string, string> = {
  vocals: 'dialogue',
  instrumental: 'ambience',
  original: 'original',
}
const ADD_ROLES = ['dialogue', 'crowd', 'ambience', 'sfx', 'bgm', 'custom'] as const
const BUS_LABEL: Record<string, string> = {
  dialogue: 'mix.busDialogue',
  original: 'mix.busOriginal',
  sfx: 'mix.busSfx',
  bgm: 'mix.busBgm',
  master: 'mix.busMaster',
}

function busLabel(key: string): string {
  return BUS_LABEL[key] ? t(BUS_LABEL[key]) : key
}

function roleLabel(role: string): string {
  const meta = ROLE_META[role]
  return meta ? t(meta.label) : role
}
function roleHint(role: string): string {
  const key = ROLE_HINTS[role]
  return key ? t(key) : ''
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
  if (rescheduleTimer) {
    clearTimeout(rescheduleTimer)
    rescheduleTimer = null
  }
  playback.reset()
  videoDurationMs.value = 0
  preview.value = null
  activeTrackUid.value = null
  rangeStartMs.value = 0
  rangeEndMs.value = 0
  if (id) void load()
}, { immediate: true })

watch(videoUrl, () => {
  videoDurationMs.value = 0
  pauseTransport()
})

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

const mixStateSignature = computed(() => [
  ...tracks.value.map(track => `${track._uid}:${track.volume}:${track.pan}:${track.effectiveMuted}:${track.busId}`),
  ...buses.value.map(bus => `${bus.key}:${bus.volume}:${bus.effectiveMuted}`),
].join('|'))
watch(mixStateSignature, () => {
  if (playback.playing.value) playback.applyMixState()
})

const clipSignature = computed(() => tracks.value
  .map(track => `loop:${track.loop ? 1 : 0}:bus:${track.busId}:` + track.clips
    .map(clip => [
      clip._uid, clip.startMs, clip.endMs, clip.sourceStartMs, clip.audioUrl,
      clip.muted, clip.loop, clip.gainDb, clip.pan, clip.fadeInMs, clip.fadeOutMs, clip.fadeCurve,
    ].join(':'))
    .join(','))
  .join(';'))
watch(clipSignature, () => {
  if (!playback.playing.value) return
  if (rescheduleTimer) clearTimeout(rescheduleTimer)
  rescheduleTimer = setTimeout(() => {
    rescheduleTimer = null
    if (playback.playing.value) void playback.play(videoCurrentMs())
  }, 220)
})

let notifiedMissing = ''
watch(playbackMissing, (list) => {
  const key = [...list].sort().join('|')
  if (!key) {
    notifiedMissing = ''
    return
  }
  if (key === notifiedMissing) return
  notifiedMissing = key
  toast.error(t('mix.realtimeMissing', { n: list.length }))
})

watch(soundscapeRunning, (busy) => emit('soundscape-busy', busy), { immediate: true })
watch(() => soundscapeStatus.value?.status, (status, previous) => {
  if (previous !== 'running') return
  if (status === 'completed') toast.success(t('mix.soundscape.done'))
  if (status === 'failed') toast.error(soundscapeStatus.value?.error || t('mix.soundscape.failed'))
})

onBeforeUnmount(() => {
  if (rescheduleTimer) {
    clearTimeout(rescheduleTimer)
    rescheduleTimer = null
  }
  pausePreview()
  playback.dispose()
  dispose()
})
onBeforeUnmount(() => emit('soundscape-busy', false))

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
  if (pendingRetime) {
    const pending = pendingRetime
    pendingRetime = null
    void commitRetime(pending.lineId, pending.startMs)
    return
  }
  stage.endChange()
}
function onMoveClip(clip: StageClip, startMs: number) {
  const track = tracks.value.find(item => item.clips.some(entry => entry._uid === clip._uid))
  if (track?.virtual && track.role === 'voice' && clip.lineId != null) {
    const duration = clip.endMs - clip.startMs
    const maxStart = Math.max(0, totalDuration.value - duration)
    const next = Math.min(Math.max(0, Math.round(startMs)), maxStart)
    if (moveVirtualClip(clip, next)) pendingRetime = { lineId: clip.lineId, startMs: clip.startMs }
    return
  }
  moveClip(clip, startMs)
}
async function commitRetime(lineId: number, startMs: number) {
  try {
    await retimeLine(lineId, startMs)
    emit('timeline-retimed', lineId)
  } catch (err: any) {
    toast.error(err?.message || t('mix.retimeFailed'))
    await refreshPlan().catch(() => {})
  }
}
function onTrimStart(clip: StageClip, ms: number) {
  trimClip(clip, 'start', ms)
}
function onTrimEnd(clip: StageClip, ms: number) {
  trimClip(clip, 'end', ms)
}
function videoCurrentMs(): number {
  const el = videoPreview.value?.videoEl
  return el ? Math.round(el.currentTime * 1000) : playheadMs.value
}
async function startRealtimeFrom(ms: number): Promise<boolean> {
  if (renderedMode.value) return false
  if (playback.playing.value) return true
  if (engineStarting) return false
  engineStarting = true
  try {
    const started = await playback.play(ms)
    if (started) {
      playing.value = true
      startEngineClock()
    }
    return started
  } finally {
    engineStarting = false
  }
}
function onSeek(ms: number) {
  const target = clamp(Math.round(ms), 0, totalDuration.value)
  setPlayhead(target, totalDuration.value)
  videoPreview.value?.seekTo(target)
  const current = preview.value
  if (renderedMode.value && current && target >= current.startMs && target <= current.endMs) {
    syncPreviewAudio(target)
    return
  }
  if (renderedMode.value) {
    renderedMode.value = false
    previewAudio.value?.pause()
  }
  if (playback.playing.value) playback.seek(target)
  else if (playing.value) void startRealtimeFrom(target)
}

function onVideoTime(ms: number) {
  setPlayhead(ms, totalDuration.value)
  if (!renderedMode.value) {
    playback.sync(ms)
    return
  }
  const current = preview.value
  if (current && ms >= current.endMs - 20) {
    finishRenderedRange()
    return
  }
  syncPreviewAudio(ms)
}
function onVideoDuration(ms: number) {
  videoDurationMs.value = ms
}
function onVideoPlay() {
  playing.value = true
  startEngineClock()
  if (renderedMode.value) return
  void startRealtimeFrom(videoCurrentMs())
}
function onVideoPlaying() {
  if (!playing.value) playing.value = true
  startEngineClock()
  if (renderedMode.value) {
    syncPreviewAudio(videoCurrentMs())
    return
  }
  void startRealtimeFrom(videoCurrentMs())
}
function onVideoPause() {
  playing.value = false
  stopEngineClock()
  if (renderedMode.value) previewAudio.value?.pause()
  else playback.pause()
}
function onVideoWaiting() {
  stopEngineClock()
  if (renderedMode.value) previewAudio.value?.pause()
  else playback.pause()
}
function onVideoEnded() {
  if (renderedMode.value && loopPreview.value && preview.value) {
    restartRenderedPreview()
    return
  }
  playing.value = false
  stopEngineClock()
  previewAudio.value?.pause()
  playback.pause()
  renderedMode.value = false
}
function syncPreviewAudio(ms: number) {
  const audio = previewAudio.value
  const current = preview.value
  if (!audio || !current) return
  if (ms < current.startMs || ms > current.endMs) {
    audio.pause()
    return
  }
  const target = clamp((ms - current.startMs) / 1000, 0, Math.max(0, (current.endMs - current.startMs) / 1000))
  if (audio.paused) {
    if (!playing.value) return
    audio.currentTime = target
    void audio.play().catch(() => {})
    return
  }
  if (Math.abs(audio.currentTime - target) > 0.35) audio.currentTime = target
}
function finishRenderedRange() {
  if (loopPreview.value && preview.value) {
    restartRenderedPreview()
    return
  }
  pauseTransport()
}
function restartRenderedPreview() {
  const current = preview.value
  if (!current) {
    pauseTransport()
    return
  }
  previewAudio.value?.pause()
  playback.pause()
  setPlayhead(current.startMs, totalDuration.value)
  videoPreview.value?.seekTo(current.startMs)
  renderedMode.value = true
  if (videoPreview.value) void videoPreview.value.play()
  void playRenderedFrom(current.startMs).then((started) => {
    if (started) return
    renderedMode.value = false
    pauseTransport()
    toast.error(t('mix.previewFailed'))
  })
}
function startEngineClock() {
  stopEngineClock()
  const tick = () => {
    engineRaf = 0
    if (!playing.value) return
    const el = videoPreview.value?.videoEl
    if (el && !el.paused) {
      const ms = videoCurrentMs()
      setPlayhead(ms, totalDuration.value)
      if (renderedMode.value) {
        const current = preview.value
        if (current && ms >= current.endMs - 20) {
          finishRenderedRange()
          return
        }
      }
      engineRaf = requestAnimationFrame(tick)
      return
    }
    if (renderedMode.value) return
    if (playback.playing.value) {
      const ms = playback.positionMs()
      setPlayhead(ms, totalDuration.value)
      if (ms >= totalDuration.value - 20) {
        pauseTransport()
        return
      }
    }
    engineRaf = requestAnimationFrame(tick)
  }
  engineRaf = requestAnimationFrame(tick)
}
function stopEngineClock() {
  if (engineRaf) cancelAnimationFrame(engineRaf)
  engineRaf = 0
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
  if (track) updateTrack(track, { muted: !track.muted })
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
function fitTimeline() {
  timelineRef.value?.fitToWidth()
}
function seekFromInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  const target = clamp(Math.round(value * 1000), 0, totalDuration.value)
  onSeek(target)
  timelineRef.value?.scrollToMs(target)
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
function addTrack(role: string, name?: string) {
  addMenuOpen.value = false
  emptyMenuOpen.value = false
  const meta = ROLE_META[role]
  const track = addStageTrack({
    role,
    busId: meta?.bus,
    name: (name || '').trim() || roleLabel(role),
  })
  if (!track) {
    toast.error(t('mix.trackAddFailed'))
    return
  }
  activeTrackUid.value = track._uid
  clearSelection()
  toast.success(t('mix.trackAdded', { name: track.name }))
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

function pauseTransport() {
  previewToken += 1
  videoPreview.value?.pause()
  const audio = previewAudio.value
  if (audio) audio.pause()
  playback.pause()
  stopEngineClock()
  playing.value = false
  renderedMode.value = false
}
function pausePreview() {
  pauseTransport()
}
async function generatePreview() {
  if (!props.episodeId) return
  const episode = props.episodeId
  if (!hasAnyAudio.value) {
    toast.error(t('mix.noAudio'))
    return
  }
  pauseTransport()
  const token = ++previewToken
  const start = clamp(Math.round(rangeStartMs.value), 0, Math.max(0, totalDuration.value - 200))
  let end = clamp(Math.round(rangeEndMs.value), start + 200, totalDuration.value)
  if (end - start > 30000) {
    end = start + 30000
    toast.info(t('mix.previewLimit'))
  }
  try {
    const result = await previewRange(start, end)
    if (!result || token !== previewToken || props.episodeId !== episode) return
    await nextTick()
    if (token !== previewToken) return
    const from = clamp(Math.round(result.startMs ?? start), 0, totalDuration.value)
    renderedMode.value = true
    setPlayhead(from, totalDuration.value)
    videoPreview.value?.seekTo(from)
    if (videoPreview.value) {
      await videoPreview.value.play()
      if (token !== previewToken) return
    }
    if (!await playRenderedFrom(from)) {
      renderedMode.value = false
      pauseTransport()
      toast.error(t('mix.previewFailed'))
    }
  } catch (err: any) {
    renderedMode.value = false
    toast.error(err?.message || t('mix.previewFailed'))
  }
}
async function playRenderedFrom(ms: number): Promise<boolean> {
  const audio = previewAudio.value
  const current = preview.value
  if (!audio || !current) return false
  if (ms < current.startMs || ms > current.endMs) return false
  playback.pause()
  audio.currentTime = clamp((ms - current.startMs) / 1000, 0, Math.max(0, (current.endMs - current.startMs) / 1000))
  try {
    await audio.play()
  } catch {
    return false
  }
  renderedMode.value = true
  playing.value = true
  if (videoPreview.value?.videoEl) startEngineClock()
  else setPlayhead(ms, totalDuration.value)
  return true
}
async function togglePlay() {
  if (previewing.value) return
  if (playing.value) {
    pauseTransport()
    return
  }
  if (videoPreview.value) {
    const el = videoPreview.value.videoEl
    if (el?.ended) {
      videoPreview.value.seekTo(0)
      setPlayhead(0)
    }
    const current = preview.value
    const keepRendered = renderedMode.value && current
      && playheadMs.value >= current.startMs && playheadMs.value <= current.endMs
    if (!keepRendered) {
      renderedMode.value = false
      previewAudio.value?.pause()
    }
    await videoPreview.value.play()
    if (videoPreview.value?.videoEl?.paused) {
      renderedMode.value = false
      if (hasAnyAudio.value && await startRealtimeFrom(videoCurrentMs())) return
      playing.value = false
      toast.error(t('mix.videoPlayFailed'))
    }
    return
  }
  if (!hasAnyAudio.value) {
    toast.error(t('mix.noAudio'))
    return
  }
  renderedMode.value = false
  if (!await startRealtimeFrom(playheadMs.value)) {
    playing.value = false
    toast.error(t('mix.noAudio'))
  }
}
function onPreviewTime() {
  const audio = previewAudio.value
  const current = preview.value
  if (!audio || !current) return
  if (videoPreview.value?.videoEl) return
  playing.value = !audio.paused
  setPlayhead(current.startMs + audio.currentTime * 1000, totalDuration.value)
}
function onPreviewEnded() {
  if (videoPreview.value?.videoEl) return
  if (loopPreview.value && preview.value) {
    restartRenderedPreview()
    return
  }
  playing.value = false
  renderedMode.value = false
  stopEngineClock()
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
function openSoundscape() {
  if (!canGenerateSound.value) {
    toast.error(t('mix.soundscape.needMerge'))
    return
  }
  soundscapeError.value = ''
  soundscapePlan.value = null
  soundscapeOpen.value = true
}

async function onSoundscapePreview(request: SoundscapeRequest) {
  soundscapePreviewing.value = true
  soundscapeError.value = ''
  try {
    await previewSoundscape(request)
  } catch (err: any) {
    soundscapeError.value = err?.message || t('mix.soundscape.previewFailed')
  } finally {
    soundscapePreviewing.value = false
  }
}

async function onSoundscapeStart(request: SoundscapeRequest) {
  soundscapeError.value = ''
  try {
    await startSoundscape(request)
    soundscapeOpen.value = false
    toast.success(t('mix.soundscape.started'))
  } catch (err: any) {
    soundscapeError.value = err?.message || t('mix.soundscape.startFailed')
  }
}

async function onCancelSoundscape() {
  try {
    const cancelled = await cancelSoundscape()
    // 任务恰好完成时服务端返回 409、并未取消：交给状态 watcher 提示完成/失败
    if (cancelled) {
      toast.success(t('mix.soundscape.cancelDone'))
    }
  } catch (err: any) {
    toast.error(err?.message || t('mix.soundscape.cancelFailed'))
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
  if (soundscapeRunning.value && event.code !== 'Space') return
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
  if (!meta && key === 'b') {
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
function onHeadsWheel(event: WheelEvent) {
  const delta = event.deltaY || 0
  if (!delta) return
  event.preventDefault()
  timelineRef.value?.scrollByY(delta)
}
function seekTo(ms: number) {
  onSeek(ms)
}
function pause() {
  pausePreview()
}
defineExpose({ seekTo, pause, play: togglePlay })
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
.mx-add-head { display: flex; flex-direction: column; gap: 2px; padding: 6px 10px 7px; border-bottom: 1px solid var(--border); }
.mx-add-head b { font-size: 10.5px; color: var(--text-0); }
.mx-add-head span { font-size: 9px; line-height: 1.4; color: var(--text-3); }
.mx-add-role { display: flex; flex-direction: column; gap: 1px; align-items: flex-start; line-height: 1.3; }
.mx-add-role small { font-size: 8.5px; font-weight: 400; color: var(--text-3); }
.mx-zoom { width: 84px; height: 12px; accent-color: var(--accent); }
.mx-zoom-val { width: 24px; font-size: 9px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.mx-progress { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-bottom: 1px solid var(--border); background: var(--accent-bg); }
.mx-progress-bar { flex: 1; height: 3px; border-radius: 2px; background: var(--bg-3); overflow: hidden; }
.mx-progress-bar span { display: block; height: 100%; background: var(--accent); transition: width .2s ease; }
.mx-progress-text { font-size: 9px; color: var(--accent-text); white-space: nowrap; }
.mx-error { margin: 0; padding: 5px 10px; border-bottom: 1px solid var(--border); background: var(--action-danger-bg); font-size: 10px; color: var(--action-danger); }
.mx-monitor { flex: none; display: flex; align-items: stretch; gap: 12px; padding: 8px 10px; border-bottom: 1px solid var(--border); background: var(--bg-0); }
.mx-monitor-stage { flex: none; width: 264px; }
.mx-monitor-stage :deep(.sub-stage) { max-height: 148px; aspect-ratio: 16 / 9; }
.mx-monitor-info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 3px; }
.mx-monitor-kicker { font-size: 9px; letter-spacing: .06em; text-transform: uppercase; color: var(--text-3); }
.mx-monitor-cue { margin: 0; font-size: 12px; font-weight: 600; color: var(--text-0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mx-monitor-time { font-size: 10px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.mx-monitor-hint { margin: 0; font-size: 9.5px; color: var(--text-3); }
.mx-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 288px minmax(0, 1fr) 316px; }
.mx-body.is-inspector-closed { grid-template-columns: 288px minmax(0, 1fr); }
.mx-stage.is-generating .mx-body { pointer-events: none; opacity: .72; }
.mx-heads { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--border); background: var(--bg-1); overflow: hidden; }
.mx-heads-label { flex: none; height: 30px; display: flex; align-items: center; padding: 0 10px; border-bottom: 1px solid var(--border); font-size: 9px; letter-spacing: .04em; text-transform: uppercase; color: var(--text-3); }
.mx-heads-clip { flex: 1; min-height: 0; overflow: hidden; }
.mx-heads-inner { will-change: transform; }
.mx-heads-video { display: flex; align-items: center; gap: 6px; padding: 0 10px; border-bottom: 1px solid var(--border); background: var(--bg-0); color: var(--text-1); font-size: 10.5px; font-weight: 600; box-sizing: border-box; }
.mx-heads-video svg { color: var(--accent-text); }
.mx-heads-video-tag { margin-left: auto; font-size: 8.5px; font-weight: 500; color: var(--text-3); }
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
.mx-goto { display: inline-flex; align-items: center; gap: 4px; }
.mx-hidden-audio { display: none; }
@container mx-stage (max-width: 1180px) {
  .mx-body { grid-template-columns: 232px minmax(0, 1fr) 272px; }
  .mx-body.is-inspector-closed { grid-template-columns: 232px minmax(0, 1fr); }
}
@container mx-stage (max-width: 960px) {
  .mx-body { grid-template-columns: 210px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) 230px; }
  .mx-body.is-inspector-closed { grid-template-rows: minmax(0, 1fr); }
  .mx-heads { grid-row: 1; }
  .mx-canvas { grid-row: 1; }
  .mx-body :deep(.mx-ins) { grid-column: 1 / -1; grid-row: 2; border-left: none; border-top: 1px solid var(--border); }
  .mx-transport-group.is-master { padding-left: 0; border-left: none; }
}
</style>
