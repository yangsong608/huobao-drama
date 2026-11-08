<template>
  <figure class="ed-preview">
    <div ref="frameRef" class="ed-preview-frame" :class="{ 'is-empty': !src }">
      <video
        ref="videoRef"
        :src="src || undefined"
        :poster="poster || undefined"
        :muted="audioMode === 'mix'"
        :style="videoStyle"
        playsinline
        preload="metadata"
        @loadedmetadata="onLoadedMetadata"
        @ended="$emit('ended')"
        @error="$emit('error', $event)"
        @click="$emit('toggle')"
      />
      <!-- 转场近似预览：抓一帧出场画面做快照退场，入场画面在视频元素上做动效 -->
      <img
        v-if="transitionState && snapshotUrl"
        class="ed-transition-snapshot"
        :src="snapshotUrl"
        :style="outgoingStyle"
        alt=""
      />
      <span
        v-if="transitionState && flashOpacity > 0"
        class="ed-transition-flash"
        :style="{ opacity: flashOpacity }"
      ></span>
      <!-- 叠加轨预览合成层：与导出 overlay/ASS 同语义（contain 基准、中心锚点、透明度×淡入淡出） -->
      <div class="ed-overlay-layer">
        <template v-for="layer in overlayLayers" :key="layer.id">
          <video
            v-if="layer.kind === 'video'"
            :ref="(el) => setOverlayVideoRef(el, layer.id)"
            :class="['ed-overlay-media', { 'is-selected': layer.id === selectedOverlayId }]"
            :src="mediaUrl(layer.source.url)"
            :style="layer.css"
            muted
            playsinline
            preload="auto"
            @pointerdown.stop="$emit('select-overlay', layer.id)"
          />
          <img
            v-else-if="layer.kind === 'image'"
            :class="['ed-overlay-media', { 'is-selected': layer.id === selectedOverlayId }]"
            :src="mediaUrl(layer.source.url)"
            :style="layer.css"
            alt=""
            @pointerdown.stop="$emit('select-overlay', layer.id)"
          />
          <div
            v-else
            :class="['ed-overlay-text', { 'is-selected': layer.id === selectedOverlayId }]"
            :style="layer.css"
            @pointerdown.stop="$emit('select-overlay', layer.id)"
          >{{ layer.text.text }}</div>
        </template>
      </div>
      <EditSubtitleOverlay
        :plan="plan"
        :layout="layout"
        :current-ms="currentMs"
        :container-width="frameWidth"
        :container-height="frameHeight"
        :selected-cue-id="selectedCueId"
        :show-safe-area="showSafeArea"
        @select="(id) => emit('select-cue', id)"
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
      <div class="ed-transport-speed" role="radiogroup" :title="t('edit.previewSpeed')">
        <button
          v-for="rate in [0.5, 1, 1.5, 2]"
          :key="rate"
          type="button"
          :class="{ 'is-on': Math.abs(Number(previewSpeed) - rate) < 0.01 }"
          @click="$emit('speed-set', rate)"
        >{{ rate }}×</button>
      </div>
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
      <span v-if="audioBanner" class="ed-audio">{{ audioBanner }}</span>
    </div>
  </figure>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Clapperboard, Pause, Play, SkipBack, SkipForward } from 'lucide-vue-next'
import EditSubtitleOverlay from '~/components/edit/EditSubtitleOverlay.vue'
import { decidePreviewSync } from '~/utils/edit-preview-sync'
import { mediaUrl } from '~/utils/edit-plan'
import {
  findActiveTransition,
  incomingTransitionStyle,
  outgoingTransitionStyle,
  whiteFlashOpacity,
} from '~/utils/edit-preview-transition'
import { formatPrecise } from '~/utils/edit-timecode'

const props = defineProps({
  src: { type: String, default: '' },
  poster: { type: String, default: '' },
  plan: { type: Object, default: () => ({ clips: [] }) },
  layout: { type: Object, default: null },
  activeClipId: { type: String, default: '' },
  clipKey: { type: String, default: '' },
  sourceMs: { type: Number, default: 0 },
  currentMs: { type: Number, default: 0 },
  durationMs: { type: Number, default: 0 },
  fps: { type: Number, default: 30 },
  playing: { type: Boolean, default: false },
  audioMode: { type: String, default: 'none' },
  audioBanner: { type: String, default: '' },
  playbackRate: { type: Number, default: 1 },
  /** 预览倍速（用户可选，与片段变速相乘后生效） */
  previewSpeed: { type: Number, default: 1 },
  /** 当前片段滤镜的 CSS filter 近似（导出端 ffmpeg 为权威） */
  clipFilter: { type: String, default: '' },
  /** 当前片段画面的 CSS transform 近似 */
  clipTransform: { type: String, default: '' },
  /** 片段音量倍率（浏览器上限 1，导出可到 2） */
  volume: { type: Number, default: 1 },
  selectedCueId: { type: String, default: '' },
  selectedOverlayId: { type: String, default: '' },
  showSafeArea: { type: Boolean, default: false },
})
const emit = defineEmits(['toggle', 'seek', 'step', 'ended', 'error', 'select-cue', 'select-overlay', 'speed-set'])
const { t } = useI18n()
const videoRef = ref(null)
const frameRef = ref(null)
const frameWidth = ref(0)
const frameHeight = ref(0)

// 预览框尺寸：字幕覆盖层按容器像素换算字号/锚点，需要随窗口实时测量。
let frameObserver = null
onMounted(() => {
  if (!('ResizeObserver' in window) || !frameRef.value) return
  frameObserver = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect
    if (!rect) return
    frameWidth.value = Math.round(rect.width)
    frameHeight.value = Math.round(rect.height)
  })
  frameObserver.observe(frameRef.value)
})
onBeforeUnmount(() => {
  frameObserver?.disconnect()
  frameObserver = null
})

const activeClip = computed(() => (
  props.plan.clips.find((clip) => clip.id === props.activeClipId) ?? null
))
const activeLabel = computed(() => {
  if (!activeClip.value) return ''
  return activeClip.value.source?.label
    || (activeClip.value.source?.kind === 'episode-video' ? t('edit.sourceEpisodeVideo') : t('edit.clip'))
})

// 转场预览状态：只在重叠窗口内生效，进度 0→1
const transitionState = computed(() => (
  findActiveTransition(props.plan, props.layout, props.currentMs)
))
const incomingStyle = computed(() => (
  transitionState.value
    ? incomingTransitionStyle(transitionState.value.type, transitionState.value.progress)
    : undefined
))

// 片段滤镜/画面调整的 CSS 近似叠加在转场动效之上
const videoStyle = computed(() => {
  const incoming = incomingStyle.value ?? {}
  const style = { ...incoming }
  if (props.clipFilter) style.filter = props.clipFilter
  if (props.clipTransform) style.transform = props.clipTransform
  return Object.keys(style).length ? style : undefined
})

// ---- 叠加轨预览合成层（导出端 overlayInputFilters / buildOverlayAss 为权威） ----
const overlayVideoEls = new Map()
function setOverlayVideoRef(el, overlayId) {
  if (el) overlayVideoEls.set(overlayId, el)
  else overlayVideoEls.delete(overlayId)
}

const overlayLayers = computed(() => {
  const now = Number(props.currentMs) || 0
  const canvasW = Number(props.plan?.project?.width) || 1920
  const canvasH = Number(props.plan?.project?.height) || 1080
  const canvasAspect = canvasW / Math.max(1, canvasH)
  const scaleRef = Number(frameWidth.value) > 0
    ? Number(frameWidth.value) / Math.max(1, canvasW)
    : 0
  return (props.plan?.overlays ?? [])
    .filter((overlay) => {
      if (!(now >= overlay.startMs && now < overlay.endMs)) return false
      if (overlay.kind === 'text') return Boolean(overlay.text?.text?.trim())
      return Boolean(overlay.source?.url)
    })
    .map((overlay) => {
      const windowMs = Math.max(1, overlay.endMs - overlay.startMs)
      const elapsed = now - overlay.startMs
      const remaining = overlay.endMs - now
      let fade = 1
      if (Number(overlay.fadeInMs) > 0 && elapsed < overlay.fadeInMs) {
        fade = Math.min(fade, Math.max(0, elapsed / overlay.fadeInMs))
      }
      if (Number(overlay.fadeOutMs) > 0 && remaining < overlay.fadeOutMs) {
        fade = Math.min(fade, Math.max(0, remaining / overlay.fadeOutMs))
      }
      const opacity = Math.max(0, Math.min(1, Number(overlay.opacity ?? 1))) * fade
      const scale = Math.max(0.1, Math.min(4, Number(overlay.transform?.scale) || 1))
      const x = Math.max(-2, Math.min(2, Number(overlay.transform?.x) || 0))
      const y = Math.max(-2, Math.min(2, Number(overlay.transform?.y) || 0))
      const css = {
        left: `${(0.5 + x) * 100}%`,
        top: `${(0.5 + y) * 100}%`,
        opacity: String(opacity),
      }
      if (overlay.kind === 'text') {
        const style = overlay.text
        const stroke = Number(style.strokeWidth) > 0
          ? `${Number(style.strokeWidth) * scaleRef * 0.5}px ${style.strokeColor}`
          : 'none'
        css.transform = 'translate(-50%, -50%)'
        css.fontFamily = `"${style.fontFamily}", sans-serif`
        css.fontSize = `${(Number(style.fontSize) || 48) * scaleRef}px`
        css.color = style.color
        css.WebkitTextStroke = stroke
        css.textAlign = style.align
        if (style.backgroundColor) css.background = style.backgroundColor
      } else {
        // contain 基准：scale 1 时完整可见（与渲染端 fit = min(W/srcW, H/srcH) 同口径）
        const srcW = Math.max(1, Number(overlay.source?.width) || canvasW)
        const srcH = Math.max(1, Number(overlay.source?.height) || canvasH)
        const srcAspect = srcW / srcH
        const widthPct = 100 * scale * Math.min(1, srcAspect / canvasAspect)
        const heightPct = 100 * scale * Math.min(1, canvasAspect / srcAspect)
        css.transform = 'translate(-50%, -50%)'
        css.width = `${widthPct}%`
        css.height = `${heightPct}%`
      }
      return {
        id: overlay.id,
        kind: overlay.kind,
        source: overlay.source ?? null,
        text: overlay.text ?? null,
        startMs: overlay.startMs,
        opacity,
        css,
      }
    })
})

// 叠加视频的时钟同步：跟随预览时钟（漂移 >120ms 才 seek），播放/暂停与主预览一致
function syncOverlayVideos() {
  const now = Number(props.currentMs) || 0
  overlayVideoEls.forEach((video, overlayId) => {
    if (!props.playing) {
      if (!video.paused) video.pause()
      return
    }
    const overlay = (props.plan?.overlays ?? []).find((item) => item.id === overlayId)
    if (!overlay) return
    const target = Math.max(0, (now - overlay.startMs) / 1000)
    const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : target
    const drift = Math.abs(video.currentTime - Math.min(target, limit))
    if (drift > 0.12) {
      try { video.currentTime = Math.min(target, limit) } catch { /* 元数据未就绪 */ }
    }
    if (video.paused) void video.play().catch(() => {})
  })
}

watch(
  () => [props.currentMs, props.playing, overlayLayers.value.map((layer) => layer.id).join(',')],
  () => syncOverlayVideos(),
)

onBeforeUnmount(() => {
  overlayVideoEls.clear()
})

function applyVolume() {
  const video = videoRef.value
  if (!video) return
  try {
    video.volume = Math.max(0, Math.min(1, Number(props.volume)))
  } catch {
    // 元数据未就绪时个别浏览器会抛错，loadedmetadata 会再次应用
  }
}
watch(() => props.volume, applyVolume)
watch(() => props.src, applyVolume)

// ---- 音频淡入淡出真实预听（导出端 audioFilter/母带遍 afade 为权威） ----
// MediaElementSource → GainNode：element.volume 继续管片段音量，GainNode 管淡入淡出曲线。
// 仅 video 模式生效；mix 模式视频元素本身静音，none 模式没有音频流。
let audioCtx = null
let audioGain = null
function ensureAudioGraph() {
  if (audioCtx || props.audioMode === 'mix' || props.audioMode === 'none') return
  const video = videoRef.value
  if (!video || typeof window === 'undefined' || !window.AudioContext) return
  try {
    const ctx = new AudioContext()
    const source = ctx.createMediaElementSource(video)
    const gain = ctx.createGain()
    source.connect(gain)
    gain.connect(ctx.destination)
    audioCtx = ctx
    audioGain = gain
  } catch {
    // 创建失败：保持 element.volume 原样，放弃增益预听
  }
}

/** 片段音频淡入淡出 × 工程级片头片尾淡的瞬时增益（0–1），与导出 afade 的线性曲线同口径 */
function audioFadeGainAt() {
  const now = Number(props.currentMs) || 0
  let factor = 1
  const entry = (props.layout?.clips ?? []).find(
    (item) => now >= item.timeline_start_ms && now < item.timeline_end_ms,
  )
  if (entry) {
    const clip = (props.plan?.clips ?? []).find((item) => item.id === entry.clip_id)
    // 旧计划缺省独立音频淡入淡出时回退视频淡入淡出（与导出 audioFilter 同口径）
    const fadeInMs = Number(clip?.audioFadeInMs ?? clip?.videoFadeInMs) || 0
    const fadeOutMs = Number(clip?.audioFadeOutMs ?? clip?.videoFadeOutMs) || 0
    const elapsed = now - Number(entry.timeline_start_ms)
    const remaining = Number(entry.timeline_end_ms) - now
    if (fadeInMs > 0 && elapsed < fadeInMs) factor *= Math.max(0, elapsed / fadeInMs)
    if (fadeOutMs > 0 && remaining < fadeOutMs) factor *= Math.max(0, remaining / fadeOutMs)
  }
  const projectFadeInMs = Number(props.plan?.project?.audioFadeInMs) || 0
  const projectFadeOutMs = Number(props.plan?.project?.audioFadeOutMs) || 0
  if (projectFadeInMs > 0 && now < projectFadeInMs) factor *= Math.max(0, now / projectFadeInMs)
  const tailRemaining = Number(props.durationMs) - now
  if (projectFadeOutMs > 0 && tailRemaining < projectFadeOutMs) {
    factor *= Math.max(0, tailRemaining / projectFadeOutMs)
  }
  return Math.max(0, Math.min(1, factor))
}

function updateAudioGain() {
  if (!audioGain || !audioCtx) return
  try {
    audioGain.gain.setTargetAtTime(audioFadeGainAt(), audioCtx.currentTime, 0.04)
  } catch {
    // 上下文已关闭：预览即将卸载，忽略
  }
}

watch(
  () => [props.playing, props.currentMs, props.plan, props.durationMs, props.audioMode],
  () => {
    if (!props.playing) return
    ensureAudioGraph()
    if (audioCtx?.state === 'suspended') void audioCtx.resume().catch(() => {})
    updateAudioGain()
  },
)

onBeforeUnmount(() => {
  try { audioCtx?.close() } catch { /* 已关闭 */ }
  audioCtx = null
  audioGain = null
})
const outgoingStyle = computed(() => (
  transitionState.value
    ? outgoingTransitionStyle(transitionState.value.type, transitionState.value.progress)
    : undefined
))
const flashOpacity = computed(() => (
  transitionState.value
    ? whiteFlashOpacity(transitionState.value.type, transitionState.value.progress)
    : 0
))
const snapshotUrl = ref('')

/** 进入转场窗口时抓取当前（出场）画面；同一窗口只抓一次。 */
function captureTransitionSnapshot() {
  const video = videoRef.value
  if (!video || !video.videoWidth || !video.videoHeight) {
    snapshotUrl.value = ''
    return
  }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (!context) {
      snapshotUrl.value = ''
      return
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    snapshotUrl.value = canvas.toDataURL('image/jpeg', 0.82)
  } catch {
    // 跨域或解码中抓帧失败：退化为无快照的入场动效
    snapshotUrl.value = ''
  }
}

// flush:'sync' 确保在片段 src 切换前抓到的仍是出场画面
watch(
  () => transitionState.value?.key ?? '',
  (key) => {
    if (!key) {
      snapshotUrl.value = ''
      return
    }
    captureTransitionSnapshot()
  },
  { flush: 'sync' },
)

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
  applyVolume()
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

let syncedSrc = props.src

// 只有源地址变化才重载；同源分割/裁剪切换片段时视频元素继续解码，避免一帧黑屏。
watch(
  () => props.src,
  async (value, old) => {
    syncedSrc = value
    if (decidePreviewSync(old, value, 0, 0) !== 'load') return
    await nextTick()
    const video = videoRef.value
    if (!video) return
    try {
      video.load()
    } catch {
      // 无源时 load 会抛错，等待下一次 src
    }
  },
)

// 片段边界：同源且画面位置连续时什么都不做；跳跃到另一段同源素材才定位。
watch(
  () => props.clipKey,
  async () => {
    await nextTick()
    const video = videoRef.value
    if (!video) return
    applyPlaybackRate()
    const action = decidePreviewSync(
      syncedSrc,
      props.src,
      Math.round((Number(video.currentTime) || 0) * 1000),
      props.sourceMs,
    )
    if (action === 'seek') applySourceTime()
    if (props.playing && video.paused) void video.play().catch(() => {})
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

defineExpose({ seek, sync: seek, play, pause, video: videoRef })
</script>

<style scoped>
.ed-preview { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; margin: 0; }
.ed-preview-frame {
  position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); border-radius: 12px; background: #0b0c0e; overflow: hidden;
}
.ed-preview video { position: relative; z-index: 0; width: 100%; height: 100%; max-height: 100%; object-fit: contain; background: #0b0c0e; cursor: pointer; }
.ed-transition-snapshot {
  position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%;
  object-fit: contain; background: #0b0c0e; pointer-events: none;
}
.ed-transition-flash {
  position: absolute; inset: 0; z-index: 2; background: #fff; pointer-events: none;
}
.ed-overlay-layer {
  position: absolute; inset: 0; z-index: 2; overflow: hidden; pointer-events: none;
}
.ed-overlay-media {
  position: absolute; pointer-events: auto; cursor: pointer; object-fit: contain;
}
.ed-overlay-text {
  position: absolute; max-width: 92%; white-space: pre-wrap; line-height: 1.25;
  padding: 2px 6px; border-radius: 4px; pointer-events: auto; cursor: pointer;
}
.ed-overlay-media.is-selected,
.ed-overlay-text.is-selected { outline: 2px solid var(--accent); }
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
.ed-transport-speed { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2); }
.ed-transport-speed button {
  height: 20px; padding: 0 7px; border: 0; border-radius: 999px; background: transparent;
  color: var(--text-2); font-size: 10px; cursor: pointer; white-space: nowrap;
}
.ed-transport-speed button:hover { color: var(--text-0); }
.ed-transport-speed button.is-on { background: var(--accent-bg); color: var(--accent-text); }
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
