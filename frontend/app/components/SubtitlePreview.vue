<template>
  <div class="sub-preview">
    <div :class="['sub-stage', { 'is-empty': !normalizedSrc }]">
      <video
        v-if="normalizedSrc"
        ref="video"
        class="sub-video"
        :src="normalizedSrc"
        :controls="controls"
        :muted="muted"
        preload="metadata"
        playsinline
        webkit-playsinline
        @loadedmetadata="onLoadedMetadata"
        @durationchange="onLoadedMetadata"
        @timeupdate="onTimeUpdate"
        @play="onPlay"
        @playing="onPlaying"
        @pause="onPause"
        @waiting="onWaiting"
        @ended="onEnded"
      />
      <p v-else class="sub-placeholder">{{ t('workbench.previewNoVideo') }}</p>
      <div v-if="currentCue" :class="['sub-caption', `is-${currentCue.kind}`]">
        <span class="sub-caption-text">{{ currentCue.text }}</span>
      </div>
    </div>
    <div v-if="showScrub" class="sub-track">
      <input
        class="sub-range"
        type="range"
        min="0"
        :max="Math.max(1, Math.round(durationMs))"
        step="50"
        :value="Math.round(currentMs)"
        @input="onScrub"
      >
      <span class="sub-time mono">{{ formatTime(currentMs) }} / {{ formatTime(durationMs) }}</span>
    </div>
    <p v-if="!cues.length" class="sub-hint">{{ t('workbench.previewNoCues') }}</p>
    <p v-else-if="!normalizedSrc" class="sub-hint">{{ t('workbench.previewNoVideoHint') }}</p>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { TimelineCue } from '~/composables/useApi'

const props = withDefaults(defineProps<{
  src?: string | null
  cues: TimelineCue[]
  controls?: boolean
  showScrub?: boolean
  muted?: boolean
}>(), {
  controls: true,
  showScrub: true,
  muted: false,
})

const emit = defineEmits<{
  'timeupdate': [ms: number]
  'duration': [ms: number]
  'play': []
  'playing': []
  'pause': []
  'waiting': []
  'ended': []
}>()

const { t } = useI18n()
const video = ref<HTMLVideoElement | null>(null)
const currentMs = ref(0)
const videoDurationMs = ref(0)
const pendingSeekMs = ref<number | null>(null)

const normalizedSrc = computed(() => {
  const src = String(props.src || '').trim()
  if (!src) return ''
  if (/^(https?:|blob:|data:|\/)/i.test(src)) return src
  return `/${src}`
})

const cueEndMs = computed(() =>
  props.cues.reduce((max, cue) => Math.max(max, cue.subtitleEndMs || cue.endMs || 0), 0))
const durationMs = computed(() => videoDurationMs.value || cueEndMs.value)
const videoEl = computed(() => video.value)
const currentCue = computed(() =>
  props.cues.find((cue) => currentMs.value >= cue.subtitleStartMs && currentMs.value <= cue.subtitleEndMs) || null)

function onLoadedMetadata() {
  const el = video.value
  if (!el) return
  videoDurationMs.value = Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration * 1000) : 0
  if (videoDurationMs.value) emit('duration', videoDurationMs.value)
  if (pendingSeekMs.value != null) {
    el.currentTime = pendingSeekMs.value / 1000
    pendingSeekMs.value = null
  }
}

function onTimeUpdate() {
  const el = video.value
  if (!el) return
  currentMs.value = Math.round(el.currentTime * 1000)
  emit('timeupdate', currentMs.value)
}

function onPlay() {
  emit('play')
}

function onPlaying() {
  emit('playing')
}

function onPause() {
  emit('pause')
}

function onWaiting() {
  emit('waiting')
}

function onEnded() {
  emit('ended')
}

function play() {
  const el = video.value
  if (!el) return Promise.resolve()
  return el.play().catch(() => {})
}

function pause() {
  video.value?.pause()
}

function onScrub(event: Event) {
  const ms = Number((event.target as HTMLInputElement).value) || 0
  seekTo(ms)
}

function seekTo(ms: number) {
  const target = Math.max(0, Math.round(ms))
  currentMs.value = target
  const el = video.value
  if (!el) {
    pendingSeekMs.value = target
    return
  }
  el.currentTime = target / 1000
}

function formatTime(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

defineExpose({ play, pause, seekTo, videoEl, currentMs, durationMs })
</script>

<style scoped>
.sub-preview { display: flex; flex-direction: column; gap: 6px; }
.sub-stage {
  position: relative;
  width: 100%;
  max-height: 220px;
  aspect-ratio: 16 / 9;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: #000;
}
.sub-stage.is-empty { background: var(--bg-2, rgba(127, 127, 127, .06)); }
.sub-video { width: 100%; height: 100%; object-fit: contain; background: #000; }
.sub-placeholder {
  position: absolute;
  inset: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
  padding: 12px;
}
.sub-caption {
  position: absolute;
  left: 50%;
  bottom: 8%;
  transform: translateX(-50%);
  max-width: 88%;
  padding: 3px 10px;
  border-radius: 4px;
  background: rgba(0, 0, 0, .58);
  color: #fff;
  font-size: 13px;
  line-height: 1.45;
  text-align: center;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .85);
  pointer-events: none;
}
.sub-caption.is-narration, .sub-caption.is-inner { font-style: italic; }
.sub-caption-text { white-space: pre-wrap; }
.sub-track { display: flex; align-items: center; gap: 10px; }
.sub-range { flex: 1; accent-color: var(--accent); }
.sub-time { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.sub-hint { margin: 0; font-size: 11px; color: var(--text-3); }

/* 平板：字幕抬到原生控件与安全区之上，避免被进度条/Home 指示条遮挡 */
@media (max-width: 1180px) {
  .sub-caption {
    bottom: calc(48px + env(safe-area-inset-bottom, 0px));
    font-size: 14px;
  }
}
</style>
