<template>
  <canvas
    ref="canvasRef"
    class="ed-audio-wave"
    :style="{ width: `${width}px`, height: `${height}px` }"
    aria-hidden="true"
  ></canvas>
</template>

<script setup>
import { editAPI } from '~/composables/useApi'

const props = defineProps({
  episodeId: { type: Number, default: 0 },
  src: { type: String, default: '' },
  fingerprint: { type: String, default: '' },
  width: { type: Number, default: 100 },
  height: { type: Number, default: 18 },
  muted: { type: Boolean, default: false },
})

// 同一素材（地址+指纹）全工作台共享一份请求；失败不缓存，之后可重试
const peaksCache = new Map()
function loadPeaks(key, episodeId, src) {
  if (peaksCache.has(key)) return peaksCache.get(key)
  const promise = editAPI.audioPeaks(episodeId, src)
    .then((payload) => {
      const levels = Array.isArray(payload?.levels) ? payload.levels : []
      return levels.length ? levels : null
    })
    .catch(() => {
      peaksCache.delete(key)
      return null
    })
  peaksCache.set(key, promise)
  return promise
}

const canvasRef = ref(null)
const levels = ref(null)

const cacheKey = computed(() => `${props.episodeId}|${props.src}|${props.fingerprint}`)

watchEffect(async (onCleanup) => {
  const key = cacheKey.value
  if (!props.episodeId || !props.src) return
  levels.value = null
  let active = true
  onCleanup(() => { active = false })
  const result = await loadPeaks(key, props.episodeId, props.src)
  if (active) levels.value = result
})

// 4 级 spp 里选峰值数最接近可用像素宽的一层：缩放只换层，后端不重复解码
const level = computed(() => {
  const list = levels.value
  if (!list?.length) return null
  const target = Math.max(24, Math.round(props.width))
  let best = list[list.length - 1]
  let bestDiff = Infinity
  for (const item of list) {
    const diff = Math.abs(item.peaks.length - target)
    if (diff < bestDiff) {
      bestDiff = diff
      best = item
    }
  }
  return best
})

function draw() {
  const canvas = canvasRef.value
  const current = level.value
  if (!canvas || !current) return
  const w = Math.max(2, Math.round(props.width))
  const h = Math.max(2, Math.round(props.height))
  const dpr = window.devicePixelRatio || 1
  const pw = Math.round(w * dpr)
  const ph = Math.round(h * dpr)
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw
    canvas.height = ph
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const peaks = current.peaks
  ctx.fillStyle = props.muted ? 'rgba(148, 163, 184, 0.5)' : '#34d399'
  for (let x = 0; x < w; x += 1) {
    const idx = Math.min(peaks.length - 1, Math.floor((x / w) * peaks.length))
    const entry = peaks[idx]
    const min = Math.max(-1, Math.min(1, entry[0]))
    const max = Math.max(-1, Math.min(1, entry[1]))
    const top = ((1 - max) / 2) * h
    const bottom = ((1 - min) / 2) * h
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top))
  }
}

watch(
  [level, () => props.width, () => props.height, () => props.muted],
  () => draw(),
  { flush: 'post' },
)
onMounted(draw)
</script>

<style scoped>
.ed-audio-wave { display: block; }
</style>
