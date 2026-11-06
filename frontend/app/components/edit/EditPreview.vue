<template>
  <figure class="ed-preview">
    <div class="ed-preview-frame" :class="{ 'is-empty': !src }">
      <video
        ref="videoRef"
        :src="src || undefined"
        :poster="poster || undefined"
        playsinline
        preload="metadata"
        @loadedmetadata="onLoadedMetadata"
        @ended="$emit('ended')"
        @error="$emit('error', $event)"
        @click="$emit('toggle')"
      />
      <div v-if="!src" class="ed-preview-empty">
        <Clapperboard :size="26" />
        <span>{{ t('edit.noPreview') }}</span>
      </div>
      <span v-if="activeLabel" class="ed-preview-badge">{{ activeLabel }}</span>
    </div>

    <div class="ed-transport">
      <button
        class="ed-transport-btn"
        type="button"
        :title="playing ? t('edit.pause') : t('edit.play')"
        @click="$emit('toggle')"
      >
        <Pause v-if="playing" :size="15" />
        <Play v-else :size="15" />
      </button>
      <button class="ed-transport-btn" type="button" :title="t('edit.stepBack')" @click="$emit('step', -1)">
        <SkipBack :size="14" />
      </button>
      <button class="ed-transport-btn" type="button" :title="t('edit.stepForward')" @click="$emit('step', 1)">
        <SkipForward :size="14" />
      </button>
      <span class="ed-clock">
        <b>{{ formatPrecise(currentMs) }}</b>
        <i>/</i>
        <span>{{ formatPrecise(durationMs) }}</span>
      </span>
      <input
        class="ed-scrub"
        type="range"
        min="0"
        :max="Math.max(1, durationMs)"
        step="10"
        :value="Math.min(currentMs, Math.max(1, durationMs))"
        @input="onScrub"
      />
      <span class="ed-meta">{{ fps }} fps</span>
      <span v-if="audioMode === 'video'" class="ed-audio">{{ t('edit.audioModeVideo') }}</span>
    </div>
  </figure>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Clapperboard, Pause, Play, SkipBack, SkipForward } from 'lucide-vue-next'
import { formatPrecise } from '~/utils/edit-timecode'

const props = defineProps({
  src: { type: String, default: '' },
  poster: { type: String, default: '' },
  plan: { type: Object, default: () => ({ clips: [] }) },
  activeClipId: { type: String, default: '' },
  clipKey: { type: String, default: '' },
  sourceMs: { type: Number, default: 0 },
  currentMs: { type: Number, default: 0 },
  durationMs: { type: Number, default: 0 },
  fps: { type: Number, default: 30 },
  playing: { type: Boolean, default: false },
  audioMode: { type: String, default: 'none' },
  playbackRate: { type: Number, default: 1 },
})
const emit = defineEmits(['toggle', 'seek', 'step', 'ended', 'error'])
const { t } = useI18n()
const videoRef = ref(null)

const activeClip = computed(() => (
  props.plan.clips.find((clip) => clip.id === props.activeClipId) ?? null
))
const activeLabel = computed(() => {
  if (!activeClip.value) return ''
  return activeClip.value.source?.label
    || (activeClip.value.source?.kind === 'episode-video' ? t('edit.sourceEpisodeVideo') : t('edit.clip'))
})

function applySourceTime() {
  const video = videoRef.value
  if (!video) return
  const seconds = Math.max(0, Number(props.sourceMs) || 0) / 1000
  const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : seconds
  try {
    video.currentTime = Math.min(seconds, limit)
  } catch {
    // 元数据未就绪时由 loadedmetadata 再同步
  }
}

function applyPlaybackRate() {
  const video = videoRef.value
  if (!video) return
  const rate = Math.min(4, Math.max(0.25, Number(props.playbackRate) || 1))
  try {
    video.playbackRate = rate
  } catch {
    // 某些浏览器在元数据就绪前拒绝设置速率，loadedmetadata 会再次应用
  }
}

function onLoadedMetadata() {
  applyPlaybackRate()
  applySourceTime()
  if (props.playing) void videoRef.value?.play().catch(() => {})
}

function seek(ms) {
  const video = videoRef.value
  if (!video) return
  const seconds = Math.max(0, Number(ms) || 0) / 1000
  const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : seconds
  try {
    video.currentTime = Math.min(seconds, limit)
  } catch {
    // 忽略未加载完成的定位，clipKey 变化后会重新同步
  }
}

function play() {
  applyPlaybackRate()
  void videoRef.value?.play().catch(() => {})
}

function pause() {
  videoRef.value?.pause()
}

function onScrub(event) {
  emit('seek', Number(event.target.value) || 0)
}

watch(
  () => [props.clipKey, props.src],
  async () => {
    await nextTick()
    const video = videoRef.value
    if (!video) return
    try {
      video.load()
    } catch {
      // 无源时 load 会抛错，等待下一次 clipKey
    }
  },
)

watch(
  () => props.playbackRate,
  () => applyPlaybackRate(),
)

watch(
  () => props.playing,
  (value) => {
    if (value) play()
    else pause()
  },
)

defineExpose({ seek, sync: seek, play, pause })
</script>

<style scoped>
.ed-preview { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; margin: 0; }
.ed-preview-frame {
  position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); border-radius: 12px; background: #0b0c0e; overflow: hidden;
}
.ed-preview video { width: 100%; height: 100%; max-height: 100%; object-fit: contain; background: #0b0c0e; cursor: pointer; }
.ed-preview-empty {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 8px; color: var(--text-3); font-size: 12px;
}
.ed-preview-badge {
  position: absolute; left: 10px; top: 10px; max-width: 60%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; padding: 3px 8px; border-radius: 999px;
  background: rgba(0, 0, 0, .58); color: #fff; font-size: 10px; pointer-events: none;
}
.ed-transport {
  flex: 0 0 auto; height: 38px; display: flex; align-items: center; gap: 8px;
  padding: 0 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-1);
}
.ed-transport-btn {
  width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--text-1); cursor: pointer;
}
.ed-transport-btn:hover { background: var(--bg-hover); }
.ed-clock { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-2); white-space: nowrap; }
.ed-clock b { color: var(--text-0); font-variant-numeric: tabular-nums; }
.ed-clock i { font-style: normal; color: var(--text-3); }
.ed-scrub { flex: 1; min-width: 80px; accent-color: var(--accent); }
.ed-meta { font-size: 10px; color: var(--text-3); white-space: nowrap; }
.ed-audio { font-size: 10px; color: var(--text-2); white-space: nowrap; }
@media (max-width: 900px) {
  .ed-audio { display: none; }
}
</style>
