<template>
  <div class="mx-tl">
    <div ref="wrapRef" class="mx-tl-scroll" @scroll="onScroll" @wheel="onWheel">
      <canvas
        ref="canvasRef"
        class="mx-tl-canvas"
        :style="{ width: `${contentWidth}px`, height: `${contentHeight}px`, cursor }"
        :aria-label="t('mix.timelineAria')"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerLeave"
        @dblclick="onDoubleClick"
      />
    </div>
    <div
      v-if="hover"
      class="mx-tip"
      :style="{ left: `${hover.x}px`, top: `${hover.y}px` }"
    >
      <b>{{ hover.title }}</b>
      <span>{{ hover.time }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { mixAPI, type PeaksPayload } from '~/composables/useApi'
import type { StageClip, StageTrack } from '~/composables/useMixStage'
import { useTheme } from '~/composables/useTheme'
import { fitTimelineZoom, TIMELINE_ZOOM_MAX, TIMELINE_ZOOM_MIN } from '~/utils/timeline-zoom'

const props = defineProps<{
  episodeId: number | null
  tracks: StageTrack[]
  durationMs: number
  playheadMs: number
  rangeStartMs: number
  rangeEndMs: number
  zoom: number
  snap: boolean
  snapMs: number
  selected: { trackUid: string; clipUid: string } | null
  activeTrackUid: string | null
  lineTexts?: Record<number, string>
  lineNumbers?: Record<number, number>
  videoUrl?: string | null
  videoDurationMs?: number
  follow?: boolean
}>()

const emit = defineEmits<{
  select: [track: StageTrack, clip: StageClip]
  'select-track': [track: StageTrack | null]
  seek: [ms: number]
  move: [clip: StageClip, startMs: number]
  'trim-start': [clip: StageClip, ms: number]
  'trim-end': [clip: StageClip, ms: number]
  'begin-change': []
  'end-change': []
  locate: [clip: StageClip]
  zoom: [value: number]
  'scroll-top': [value: number]
}>()

const { t } = useI18n()
const { resolvedTheme } = useTheme()

const RULER_H = 30
const VIDEO_LANE_H = 58
const MIN_TRACK_H = 56
const MAX_TRACK_H = 160
const MIN_ZOOM = TIMELINE_ZOOM_MIN
const MAX_ZOOM = TIMELINE_ZOOM_MAX
const EDGE_SCROLL_PX = 44
const TRACK_COLORS: Record<string, string> = {
  dialogue: '#f59e0b',
  voice: '#f59e0b',
  crowd: '#f472b6',
  original: '#94a3b8',
  ambience: '#0ea5e9',
  sfx: '#a78bfa',
  bgm: '#34d399',
  custom: '#38bdf8',
}
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

const hostRef = ref<HTMLDivElement | null>(null)
const wrapRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const viewportWidth = ref(800)
const scrollTop = ref(0)
const cursor = ref('default')
const hover = ref<{ x: number; y: number; title: string; time: string } | null>(null)

const peaksCache = new Map<string, PeaksPayload | null>()
const peaksInflight = new Set<string>()
let pendingAnchor: { timeSec: number; offsetX: number } | null = null
let resizeObserver: ResizeObserver | null = null
let raf = 0
let edgeRaf = 0
let edgeDirection = 0
let lastPointerClient = { x: 0, y: 0 }
let interaction: {
  kind: 'move' | 'trim-start' | 'trim-end' | 'seek'
  clip: StageClip | null
  track: StageTrack | null
  startX: number
  startY: number
  originalStart: number
  originalEnd: number
  originalSource: number
  moved: boolean
} | null = null

const contentWidth = computed(() => Math.max(
  viewportWidth.value,
  Math.ceil((props.durationMs / 1000) * props.zoom) + 160,
  600,
))
const hasVideo = computed(() => Boolean(String(props.videoUrl || '').trim()))
const lanesTop = computed(() => RULER_H + (hasVideo.value ? VIDEO_LANE_H : 0))
const contentHeight = computed(() => lanesTop.value + props.tracks.reduce((sum, track) => sum + trackHeight(track), 0))

function trackHeight(track: StageTrack): number {
  return Math.min(MAX_TRACK_H, Math.max(MIN_TRACK_H, Number(track.height) || 72))
}

function colorOf(track: StageTrack): string {
  return track.color || TRACK_COLORS[track.role] || TRACK_COLORS.custom
}

function hexToRgba(color: string, alpha: number): string {
  const value = String(color || '').trim()
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    const r = parseInt(value.slice(1, 3), 16)
    const g = parseInt(value.slice(3, 5), 16)
    const b = parseInt(value.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const r = parseInt(value[1] + value[1], 16)
    const g = parseInt(value[2] + value[2], 16)
    const b = parseInt(value[3] + value[3], 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return `rgba(56, 189, 248, ${alpha})`
}

function cssVar(name: string, fallback: string): string {
  const host = hostRef.value ?? wrapRef.value
  if (!host) return fallback
  return getComputedStyle(host).getPropertyValue(name).trim() || fallback
}

function toX(ms: number): number {
  return (Math.max(0, ms) / 1000) * props.zoom
}

function toMs(x: number): number {
  return Math.max(0, (x / props.zoom) * 1000)
}

function contentXOf(clientX: number): number {
  const canvas = canvasRef.value
  if (!canvas) return 0
  return Math.max(0, clientX - canvas.getBoundingClientRect().left)
}

function emitSeekAt(clientX: number) {
  emit('seek', Math.min(toMs(contentXOf(clientX)), props.durationMs))
}

function stopEdgeScroll() {
  edgeDirection = 0
  if (edgeRaf) {
    cancelAnimationFrame(edgeRaf)
    edgeRaf = 0
  }
}

function startEdgeScroll(direction: number) {
  edgeDirection = direction
  if (edgeRaf) return
  const step = () => {
    edgeRaf = 0
    const wrap = wrapRef.value
    if (!wrap || !interaction || interaction.kind !== 'seek' || !edgeDirection) {
      edgeDirection = 0
      return
    }
    const max = Math.max(0, wrap.scrollWidth - wrap.clientWidth)
    const next = Math.min(max, Math.max(0, wrap.scrollLeft + edgeDirection * 12))
    if (next === wrap.scrollLeft) {
      edgeDirection = 0
      return
    }
    wrap.scrollLeft = next
    emitSeekAt(lastPointerClient.x)
    edgeRaf = requestAnimationFrame(step)
  }
  edgeRaf = requestAnimationFrame(step)
}

function updateEdgeScroll(clientX: number) {
  const wrap = wrapRef.value
  if (!wrap || !interaction || interaction.kind !== 'seek') {
    stopEdgeScroll()
    return
  }
  const rect = wrap.getBoundingClientRect()
  if (clientX > rect.right - EDGE_SCROLL_PX) startEdgeScroll(1)
  else if (clientX < rect.left + EDGE_SCROLL_PX) startEdgeScroll(-1)
  else stopEdgeScroll()
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatTimePrecise(ms: number): string {
  const total = Math.max(0, ms) / 1000
  const minutes = Math.floor(total / 60)
  const seconds = total - minutes * 60
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
}

function lineLabel(clip: StageClip): string {
  if (clip.lineId && props.lineTexts?.[clip.lineId]) return props.lineTexts[clip.lineId]
  if (clip.name) return clip.name
  if (clip.lineId) return t('mix.lineNumber', { n: props.lineNumbers?.[clip.lineId] ?? clip.lineId })
  if (clip.takeId) return t('mix.takeLabel', { id: clip.takeId })
  const name = String(clip.audioUrl || '').split('/').pop() || ''
  try {
    return decodeURIComponent(name) || t('mix.unnamedClip')
  } catch {
    return name || t('mix.unnamedClip')
  }
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
  const r = Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 8) return ''
  if (ctx.measureText(text).width <= maxWidth) return text
  let value = text
  while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) {
    value = value.slice(0, -1)
  }
  return value.length > 1 ? `${value}…` : ''
}

function peaksFor(clip: StageClip): PeaksPayload | null {
  const key = sourceKey(clip)
  if (!key) return null
  return peaksCache.get(key) ?? null
}

function sourceKey(clip: StageClip): string {
  if (clip.assetId) return `asset:${clip.assetId}`
  if (clip.takeId) return `take:${clip.takeId}`
  return ''
}

function ensurePeaks() {
  const episodeId = props.episodeId
  if (!episodeId) return
  for (const track of props.tracks) {
    for (const clip of track.clips) {
      const key = sourceKey(clip)
      if (!key || peaksCache.has(key) || peaksInflight.has(key)) continue
      peaksInflight.add(key)
      const source = clip.assetId
        ? { assetId: clip.assetId }
        : { takeId: clip.takeId as number }
      void mixAPI.peaks(episodeId, source)
        .then((payload) => {
          peaksCache.set(key, payload)
          scheduleDraw()
        })
        .catch(() => {
          peaksCache.set(key, null)
        })
        .finally(() => {
          peaksInflight.delete(key)
        })
    }
  }
}

function chooseLevel(payload: PeaksPayload) {
  const targetSpp = 8000 / Math.max(1, props.zoom)
  let chosen = payload.levels[0]
  for (const level of payload.levels) {
    chosen = level
    if (level.spp >= targetSpp) break
  }
  return chosen
}

function tickStep(): number {
  for (const step of TICK_STEPS) {
    if (step * props.zoom >= 70) return step
  }
  return TICK_STEPS[TICK_STEPS.length - 1]
}

function drawVideoLane(
  ctx: CanvasRenderingContext2D,
  width: number,
  theme: { accent: string; border: string; text0: string },
) {
  const top = RULER_H
  const videoEndMs = Math.max(1, Number(props.videoDurationMs) || props.durationMs || 1000)
  const stripX = 8
  const stripW = Math.max(24, toX(videoEndMs) - stripX)
  ctx.fillStyle = hexToRgba(theme.accent, 0.055)
  ctx.fillRect(0, top, width, VIDEO_LANE_H)

  ctx.save()
  roundedRect(ctx, stripX, top + 7, stripW, VIDEO_LANE_H - 14, 6)
  ctx.clip()
  ctx.fillStyle = 'rgba(8,12,18,0.42)'
  ctx.fillRect(stripX, top + 7, stripW, VIDEO_LANE_H - 14)
  const cell = 56
  for (let x = stripX; x < stripX + stripW; x += cell) {
    ctx.fillStyle = hexToRgba(theme.accent, 0.16)
    ctx.fillRect(x + 2, top + 12, cell - 6, VIDEO_LANE_H - 24)
    ctx.fillStyle = 'rgba(8,12,18,0.55)'
    ctx.fillRect(x + 5, top + 15, cell - 12, 5)
    ctx.fillRect(x + 5, top + VIDEO_LANE_H - 20, cell - 12, 5)
  }
  ctx.restore()
  ctx.strokeStyle = hexToRgba(theme.accent, 0.40)
  ctx.lineWidth = 1
  roundedRect(ctx, stripX + 0.5, top + 7.5, stripW, VIDEO_LANE_H - 14, 6)
  ctx.stroke()

  ctx.save()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
  const label = `${t('mix.videoLane')} · ${formatTime(videoEndMs)}`
  const labelW = ctx.measureText(label).width
  ctx.fillStyle = 'rgba(8,12,18,0.72)'
  roundedRect(ctx, stripX + 6, top + VIDEO_LANE_H / 2 - 9, labelW + 14, 18, 5)
  ctx.fill()
  ctx.fillStyle = theme.text0
  ctx.fillText(label, stripX + 13, top + VIDEO_LANE_H / 2)
  ctx.restore()

  ctx.strokeStyle = theme.border
  ctx.beginPath()
  ctx.moveTo(0, top + VIDEO_LANE_H + 0.5)
  ctx.lineTo(width, top + VIDEO_LANE_H + 0.5)
  ctx.stroke()
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const width = contentWidth.value
  const height = contentHeight.value
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const bg0 = cssVar('--bg-0', '#0e141d')
  const bg1 = cssVar('--bg-1', '#131a24')
  const border = cssVar('--border', 'rgba(148,163,184,0.14)')
  const text0 = cssVar('--text-0', '#f1f5f9')
  const text2 = cssVar('--text-2', 'rgba(226,232,240,0.65)')
  const text3 = cssVar('--text-3', '#8b94a3')
  const accent = cssVar('--accent', '#ffb076')
  const error = cssVar('--error', '#f87171')

  ctx.fillStyle = bg0
  ctx.fillRect(0, 0, width, height)

  const step = tickStep()
  const durationSec = Math.max(props.durationMs / 1000, 1)
  ctx.lineWidth = 1
  for (let sec = 0; sec <= durationSec + step; sec += step) {
    const x = Math.round(sec * props.zoom) + 0.5
    if (x > width) break
    ctx.strokeStyle = 'rgba(148,163,184,0.07)'
    ctx.beginPath()
    ctx.moveTo(x, RULER_H)
    ctx.lineTo(x, height)
    ctx.stroke()
  }

  if (hasVideo.value) drawVideoLane(ctx, width, { accent, border, text0 })

  let top = lanesTop.value
  for (const [index, track] of props.tracks.entries()) {
    const laneH = trackHeight(track)
    if (index % 2 === 1) {
      ctx.fillStyle = 'rgba(148,163,184,0.035)'
      ctx.fillRect(0, top, width, laneH)
    }
    if (track.virtual) {
      ctx.fillStyle = hexToRgba(colorOf(track), 0.04)
      ctx.fillRect(0, top, width, laneH)
    }
    ctx.strokeStyle = border
    ctx.beginPath()
    ctx.moveTo(0, top + laneH + 0.5)
    ctx.lineTo(width, top + laneH + 0.5)
    ctx.stroke()

    if (track.hidden) {
      ctx.fillStyle = text3
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(t('mix.hiddenLane'), 14, top + laneH / 2)
    } else {
      for (const clip of track.clips) drawClip(ctx, track, clip, top, laneH, {
        bg0, border, text0, text2, text3, accent, error,
      })
    }
    top += laneH
  }

  const rangeStart = Math.max(0, props.rangeStartMs)
  const rangeEnd = Math.max(rangeStart, props.rangeEndMs)
  if (rangeEnd > rangeStart) {
    const x1 = toX(rangeStart)
    const x2 = toX(rangeEnd)
    ctx.fillStyle = hexToRgba(accent, 0.05)
    ctx.fillRect(x1, lanesTop.value, x2 - x1, height - lanesTop.value)
  }

  const rulerTop = scrollTop.value
  ctx.fillStyle = bg1
  ctx.fillRect(0, rulerTop, width, RULER_H)
  ctx.strokeStyle = border
  ctx.beginPath()
  ctx.moveTo(0, rulerTop + RULER_H + 0.5)
  ctx.lineTo(width, rulerTop + RULER_H + 0.5)
  ctx.stroke()
  ctx.font = '10px "SF Mono", ui-monospace, Menlo, monospace'
  ctx.textBaseline = 'middle'
  for (let sec = 0; sec <= durationSec + step; sec += step) {
    const x = Math.round(sec * props.zoom) + 0.5
    if (x > width) break
    ctx.strokeStyle = border
    ctx.beginPath()
    ctx.moveTo(x, rulerTop + RULER_H - 6)
    ctx.lineTo(x, rulerTop + RULER_H)
    ctx.stroke()
    if (step * props.zoom >= 130) {
      const half = x + (step * props.zoom) / 2
      ctx.beginPath()
      ctx.moveTo(half, rulerTop + RULER_H - 3)
      ctx.lineTo(half, rulerTop + RULER_H)
      ctx.stroke()
    }
    ctx.fillStyle = text3
    ctx.fillText(formatTime(sec * 1000), x + 5, rulerTop + RULER_H / 2 + 1)
  }

  const playheadX = toX(props.playheadMs)
  ctx.strokeStyle = accent
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(playheadX, rulerTop)
  ctx.lineTo(playheadX, height)
  ctx.stroke()
  ctx.fillStyle = accent
  ctx.beginPath()
  ctx.moveTo(playheadX - 5, rulerTop)
  ctx.lineTo(playheadX + 5, rulerTop)
  ctx.lineTo(playheadX, rulerTop + 8)
  ctx.closePath()
  ctx.fill()
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  track: StageTrack,
  clip: StageClip,
  laneTop: number,
  laneH: number,
  theme: { bg0: string; border: string; text0: string; text2: string; text3: string; accent: string; error: string },
) {
  const x = toX(clip.startMs)
  const w = Math.max(1, toX(clip.endMs) - x)
  if (x > contentWidth.value + 20 || x + w < -20) return
  const y = laneTop + 5
  const h = Math.max(12, laneH - 10)
  const color = colorOf(track)
  const selected = props.selected?.clipUid === clip._uid
  const muted = clip.muted || track.muted || track.effectiveMuted
  const warning = !clip.usable

  ctx.save()
  roundedRect(ctx, x, y, w, h, 6)
  const gradient = ctx.createLinearGradient(0, y, 0, y + h)
  gradient.addColorStop(0, hexToRgba(color, muted ? 0.10 : 0.32))
  gradient.addColorStop(1, hexToRgba(color, muted ? 0.05 : 0.16))
  ctx.fillStyle = gradient
  ctx.fill()
  ctx.lineWidth = selected ? 2 : 1
  ctx.strokeStyle = warning
    ? theme.error
    : selected
      ? theme.accent
      : hexToRgba(color, muted ? 0.30 : 0.58)
  ctx.stroke()

  if (w > 5 && h > 18 && !warning) {
    const payload = peaksFor(clip)
    if (payload?.levels.length) {
      const level = chooseLevel(payload)
      if (level.peaks.length) {
        ctx.save()
        roundedRect(ctx, x, y, w, h, 6)
        ctx.clip()
        const cy = y + h / 2
        const amp = Math.max(2, h / 2 - 6)
        const sampleRate = payload.sampleRate || 8000
        const sourceStartSec = clip.sourceStartMs / 1000
        ctx.beginPath()
        const stepPx = w > 480 ? 2 : 1
        for (let px = 2; px < w - 2; px += stepPx) {
          const time = sourceStartSec + px / props.zoom
          const peakIndex = Math.floor((time * sampleRate) / level.spp)
          if (peakIndex < 0 || peakIndex >= level.peaks.length) continue
          const [min, max] = level.peaks[peakIndex]
          ctx.moveTo(x + px, cy - max * amp)
          ctx.lineTo(x + px, cy - min * amp)
        }
        ctx.strokeStyle = muted ? 'rgba(148,163,184,0.30)' : hexToRgba(color, 0.78)
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.restore()
      }
    }
  }

  const fadeInW = Math.min(w, (clip.fadeInMs / 1000) * props.zoom)
  const fadeOutW = Math.min(w, (clip.fadeOutMs / 1000) * props.zoom)
  if (fadeInW > 2) {
    ctx.beginPath()
    if (clip.fadeCurve === 'equal_power') {
      ctx.moveTo(x, y + h)
      ctx.quadraticCurveTo(x + fadeInW * 0.45, y + h * 0.5, x + fadeInW, y)
    } else {
      ctx.moveTo(x, y + h)
      ctx.lineTo(x + fadeInW, y)
    }
    ctx.lineTo(x, y)
    ctx.closePath()
    ctx.fillStyle = 'rgba(8,12,18,0.22)'
    ctx.fill()
  }
  if (fadeOutW > 2) {
    const edge = x + w
    ctx.beginPath()
    if (clip.fadeCurve === 'equal_power') {
      ctx.moveTo(edge, y + h)
      ctx.quadraticCurveTo(edge - fadeOutW * 0.45, y + h * 0.5, edge - fadeOutW, y)
    } else {
      ctx.moveTo(edge, y + h)
      ctx.lineTo(edge - fadeOutW, y)
    }
    ctx.lineTo(edge, y)
    ctx.closePath()
    ctx.fillStyle = 'rgba(8,12,18,0.22)'
    ctx.fill()
  }

  ctx.save()
  roundedRect(ctx, x, y, w, h, 6)
  ctx.clip()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
  const baseLabel = lineLabel(clip)
  const label = warning ? `${t('mix.missingAudio')} · ${baseLabel}` : baseLabel
  const labelColor = warning ? theme.error : muted ? theme.text3 : theme.text0
  ctx.fillStyle = labelColor
  const labelText = fitText(ctx, label, w - 16)
  if (labelText) ctx.fillText(labelText, x + 7, y + 6)
  if (h >= 42 && w > 90) {
    ctx.font = '9px "SF Mono", ui-monospace, Menlo, monospace'
    ctx.fillStyle = theme.text2
    ctx.fillText(
      `${formatTimePrecise(clip.startMs)} – ${formatTimePrecise(clip.endMs)}`,
      x + 7,
      y + h - 17,
    )
  }
  if (w > 28 && (clip.muted || clip.locked || clip.loop)) {
    ctx.textAlign = 'right'
    ctx.font = '9px "SF Mono", ui-monospace, Menlo, monospace'
    ctx.fillStyle = clip.muted ? theme.text3 : theme.text2
    const flags = `${clip.muted ? 'M' : ''}${clip.locked ? 'L' : ''}${clip.loop ? '↻' : ''}`
    ctx.fillText(flags, x + w - 5, y + 5)
  }
  ctx.restore()
  ctx.restore()
}

function scheduleDraw() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    draw()
  })
}

function inVideoLane(y: number): boolean {
  return hasVideo.value && y >= RULER_H && y < RULER_H + VIDEO_LANE_H
}

function laneAt(y: number): { track: StageTrack; top: number; height: number } | null {
  let top = lanesTop.value
  for (const track of props.tracks) {
    const height = trackHeight(track)
    if (y >= top && y < top + height) return { track, top, height }
    top += height
  }
  return null
}

function clipAt(x: number, y: number): { track: StageTrack; clip: StageClip; edge: 'start' | 'end' | null } | null {
  const lane = laneAt(y)
  if (!lane || lane.track.hidden) return null
  const clipTop = lane.top + 5
  const clipBottom = lane.top + lane.height - 5
  if (y < clipTop || y > clipBottom) return null
  for (let index = lane.track.clips.length - 1; index >= 0; index -= 1) {
    const clip = lane.track.clips[index]
    const left = toX(clip.startMs)
    const right = toX(clip.endMs)
    if (x < left || x > right) continue
    const width = Math.max(1, right - left)
    const edgeSize = Math.min(7, width / 3)
    const edge = x <= left + edgeSize ? 'start' : x >= right - edgeSize ? 'end' : null
    return { track: lane.track, clip, edge }
  }
  return null
}

function pointOf(event: PointerEvent | MouseEvent): { x: number; y: number } {
  const canvas = canvasRef.value
  if (!canvas) return { x: 0, y: 0 }
  const rect = canvas.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function snapEdge(value: number, exclude: StageClip | null): number {
  const raw = Math.max(0, Math.round(value))
  if (!props.snap) return raw
  const targets: number[] = [0, props.playheadMs, props.rangeStartMs, props.rangeEndMs, props.durationMs]
  for (const track of props.tracks) {
    for (const clip of track.clips) {
      if (clip._uid === exclude?._uid) continue
      targets.push(clip.startMs, clip.endMs)
    }
  }
  let best = raw
  let distance = props.snapMs
  for (const target of targets) {
    const diff = Math.abs(target - raw)
    if (diff <= distance) {
      best = target
      distance = diff
    }
  }
  return Math.max(0, Math.round(best))
}

function snapMove(start: number, duration: number, exclude: StageClip): number {
  const raw = Math.max(0, Math.round(start))
  if (!props.snap) return raw
  const targets: number[] = [0, props.playheadMs, props.rangeStartMs, props.rangeEndMs, props.durationMs]
  for (const track of props.tracks) {
    for (const clip of track.clips) {
      if (clip._uid === exclude._uid) continue
      targets.push(clip.startMs, clip.endMs)
    }
  }
  let best = raw
  let distance = props.snapMs
  for (const target of targets) {
    for (const offset of [0, duration]) {
      const candidate = Math.max(0, target - offset)
      const diff = Math.abs(candidate - raw)
      if (diff <= distance) {
        best = candidate
        distance = diff
      }
    }
  }
  return Math.max(0, Math.round(best))
}

/** 只有虚拟对白轨的片段能改时间；原声床/BGM 等虚拟素材仍只读 */
function isVirtualDialogue(track: StageTrack, clip: StageClip): boolean {
  return Boolean(track.virtual && track.role === 'voice' && clip.lineId != null)
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  const canvas = canvasRef.value
  if (!canvas) return
  const { x, y } = pointOf(event)
  hideHover()

  if (y >= scrollTop.value && y < scrollTop.value + RULER_H) {
    interaction = { kind: 'seek', clip: null, track: null, startX: x, startY: y, originalStart: 0, originalEnd: 0, originalSource: 0, moved: false }
    canvas.setPointerCapture(event.pointerId)
    emit('seek', Math.min(toMs(x), props.durationMs))
    return
  }

  if (inVideoLane(y)) {
    interaction = { kind: 'seek', clip: null, track: null, startX: x, startY: y, originalStart: 0, originalEnd: 0, originalSource: 0, moved: false }
    canvas.setPointerCapture(event.pointerId)
    emit('seek', Math.min(toMs(x), props.durationMs))
    return
  }

  const hit = clipAt(x, y)
  if (hit) {
    emit('select', hit.track, hit.clip)
    const virtualMove = isVirtualDialogue(hit.track, hit.clip)
    const editable = !hit.track.locked && !hit.clip.locked && (!hit.track.virtual || virtualMove)
    if (editable && !hit.track.virtual && hit.edge) {
      interaction = {
        kind: hit.edge === 'start' ? 'trim-start' : 'trim-end',
        clip: hit.clip,
        track: hit.track,
        startX: x,
        startY: y,
        originalStart: hit.clip.startMs,
        originalEnd: hit.clip.endMs,
        originalSource: hit.clip.sourceStartMs,
        moved: false,
      }
      emit('begin-change')
      canvas.setPointerCapture(event.pointerId)
      cursor.value = 'ew-resize'
      return
    }
    if (editable) {
      interaction = {
        kind: 'move',
        clip: hit.clip,
        track: hit.track,
        startX: x,
        startY: y,
        originalStart: hit.clip.startMs,
        originalEnd: hit.clip.endMs,
        originalSource: hit.clip.sourceStartMs,
        moved: false,
      }
      if (!virtualMove) emit('begin-change')
      canvas.setPointerCapture(event.pointerId)
      cursor.value = 'grabbing'
      return
    }
    interaction = null
    return
  }

  const lane = laneAt(y)
  if (lane) {
    emit('select-track', lane.track)
    emit('seek', Math.min(toMs(x), props.durationMs))
    interaction = { kind: 'seek', clip: null, track: lane.track, startX: x, startY: y, originalStart: 0, originalEnd: 0, originalSource: 0, moved: false }
    canvas.setPointerCapture(event.pointerId)
    cursor.value = 'pointer'
  }
}

function onPointerMove(event: PointerEvent) {
  lastPointerClient = { x: event.clientX, y: event.clientY }
  const { x, y } = pointOf(event)
  if (!interaction) {
    updateHover(x, y)
    return
  }
  if (interaction.kind === 'seek') {
    emit('seek', Math.min(toMs(x), props.durationMs))
    if (Math.abs(x - interaction.startX) > 2) interaction.moved = true
    updateEdgeScroll(event.clientX)
    return
  }
  stopEdgeScroll()
  const clip = interaction.clip
  if (!clip) return
  interaction.moved = true
  const deltaMs = ((x - interaction.startX) / props.zoom) * 1000
  if (interaction.kind === 'move') {
    const duration = interaction.originalEnd - interaction.originalStart
    const next = snapMove(interaction.originalStart + deltaMs, duration, clip)
    emit('move', clip, next)
    return
  }
  if (interaction.kind === 'trim-start') {
    const sourceFloor = Math.max(0, interaction.originalStart - interaction.originalSource)
    const raw = Math.max(sourceFloor, Math.min(interaction.originalStart + deltaMs, interaction.originalEnd - 10))
    emit('trim-start', clip, snapEdge(raw, clip))
    return
  }
  const raw = Math.min(
    Math.max(interaction.originalStart + 10, interaction.originalEnd + deltaMs),
    Math.max(interaction.originalEnd, props.durationMs + 5 * 60 * 1000),
  )
  emit('trim-end', clip, snapEdge(raw, clip))
}

function onPointerUp(event: PointerEvent) {
  const canvas = canvasRef.value
  if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  stopEdgeScroll()
  if (interaction && interaction.kind !== 'seek') emit('end-change')
  interaction = null
  cursor.value = 'default'
}

function onPointerLeave() {
  if (!interaction) {
    stopEdgeScroll()
    hideHover()
  }
}

function onDoubleClick(event: MouseEvent) {
  const { x, y } = pointOf(event)
  const hit = clipAt(x, y)
  if (!hit) return
  emit('select', hit.track, hit.clip)
  if (hit.clip.lineId) emit('locate', hit.clip)
}

function updateHover(x: number, y: number) {
  if (y >= scrollTop.value && y < scrollTop.value + RULER_H) {
    cursor.value = 'pointer'
    hideHover()
    return
  }
  if (inVideoLane(y)) {
    cursor.value = 'pointer'
    const host = hostRef.value
    if (host) {
      const rect = host.getBoundingClientRect()
      const left = Math.min(Math.max(eventX(host, x), 70), rect.width - 70)
      hover.value = {
        x: left,
        y: Math.max(38, eventY(host, y) - 8),
        title: t('mix.videoLane'),
        time: formatTimePrecise(toMs(x)),
      }
    }
    return
  }
  const hit = clipAt(x, y)
  if (hit) {
    const virtualMove = isVirtualDialogue(hit.track, hit.clip)
    const editable = !hit.track.locked && !hit.clip.locked && (!hit.track.virtual || virtualMove)
    cursor.value = !editable ? 'pointer' : (!hit.track.virtual && hit.edge) ? 'ew-resize' : 'grab'
    const title = lineLabel(hit.clip)
    const time = `${formatTimePrecise(hit.clip.startMs)} – ${formatTimePrecise(hit.clip.endMs)}`
    const host = hostRef.value
    if (host) {
      const rect = host.getBoundingClientRect()
      const left = Math.min(Math.max(eventX(host, x), 70), rect.width - 70)
      hover.value = { x: left, y: Math.max(38, eventY(host, y) - 8), title, time }
    }
    return
  }
  const lane = laneAt(y)
  cursor.value = lane ? 'pointer' : 'default'
  hideHover()
}

function eventX(host: HTMLElement, x: number): number {
  const canvas = canvasRef.value
  if (!canvas) return x
  const hostRect = host.getBoundingClientRect()
  const canvasRect = canvas.getBoundingClientRect()
  return canvasRect.left - hostRect.left + x
}

function eventY(host: HTMLElement, y: number): number {
  const canvas = canvasRef.value
  if (!canvas) return y
  const hostRect = host.getBoundingClientRect()
  const canvasRect = canvas.getBoundingClientRect()
  return canvasRect.top - hostRect.top + y
}

function hideHover() {
  hover.value = null
}

function onScroll() {
  hideHover()
  scrollTop.value = wrapRef.value?.scrollTop ?? 0
  emit('scroll-top', scrollTop.value)
  scheduleDraw()
}

function onWheel(event: WheelEvent) {
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault()
    const wrap = wrapRef.value
    if (!wrap) return
    const offsetX = event.clientX - wrap.getBoundingClientRect().left
    pendingAnchor = { timeSec: (wrap.scrollLeft + offsetX) / props.zoom, offsetX }
    const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, props.zoom * factor))
    emit('zoom', next)
    return
  }
  if (event.shiftKey) {
    event.preventDefault()
    const wrap = wrapRef.value
    if (wrap) wrap.scrollLeft += event.deltaY || event.deltaX
  }
}

function scrollToMs(ms: number) {
  const wrap = wrapRef.value
  if (!wrap) return
  const x = toX(Math.min(ms, props.durationMs))
  const left = wrap.scrollLeft
  if (x < left + 24 || x > left + wrap.clientWidth - 90) {
    wrap.scrollTo({ left: Math.max(0, x - wrap.clientWidth * 0.3), behavior: 'smooth' })
  }
}

function scrollByY(delta: number) {
  wrapRef.value?.scrollBy({ top: delta })
}

function fitToWidth() {
  const wrap = wrapRef.value
  if (!wrap || props.durationMs <= 0) return
  pendingAnchor = null
  emit('zoom', fitTimelineZoom(wrap.clientWidth, props.durationMs))
  nextTick(() => {
    if (wrapRef.value) wrapRef.value.scrollLeft = 0
    scheduleDraw()
  })
}

watch(
  () => props.playheadMs,
  (ms) => {
    if (!props.follow) return
    const wrap = wrapRef.value
    if (!wrap) return
    const x = toX(ms)
    const left = wrap.scrollLeft
    const width = wrap.clientWidth
    if (x < left + 40 || x > left + width - 90) {
      wrap.scrollLeft = Math.max(0, x - width * 0.25)
    }
  },
)

watch(
  () => [
    props.tracks,
    props.zoom,
    props.playheadMs,
    props.rangeStartMs,
    props.rangeEndMs,
    props.selected,
    props.activeTrackUid,
    props.durationMs,
    props.videoUrl,
    props.videoDurationMs,
  ],
  scheduleDraw,
  { deep: true },
)

watch(
  () => props.tracks.map((track) => track.clips.map((clip) => sourceKey(clip)).join(',')).join('|'),
  () => {
    ensurePeaks()
    scheduleDraw()
  },
  { immediate: true },
)

watch(
  () => props.episodeId,
  () => {
    peaksCache.clear()
    peaksInflight.clear()
    ensurePeaks()
    scheduleDraw()
  },
)

watch(
  () => props.zoom,
  () => {
    const anchor = pendingAnchor
    pendingAnchor = null
    if (!anchor || !wrapRef.value) {
      scheduleDraw()
      return
    }
    nextTick(() => {
      const wrap = wrapRef.value
      if (wrap) wrap.scrollLeft = Math.max(0, anchor.timeSec * props.zoom - anchor.offsetX)
      scheduleDraw()
    })
  },
)

watch(resolvedTheme, scheduleDraw)

onMounted(() => {
  const wrap = wrapRef.value
  if (wrap) {
    viewportWidth.value = wrap.clientWidth
    resizeObserver = new ResizeObserver(() => {
      viewportWidth.value = wrap.clientWidth
      scheduleDraw()
    })
    resizeObserver.observe(wrap)
  }
  ensurePeaks()
  draw()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  stopEdgeScroll()
  if (raf) cancelAnimationFrame(raf)
})

defineExpose({ scrollToMs, scrollByY, fitToWidth })
</script>

<style scoped>
.mx-tl {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}
.mx-tl-scroll {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}
.mx-tl-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.mx-tl-scroll::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border: 2px solid transparent;
  border-radius: 8px;
  background-clip: padding-box;
}
.mx-tl-scroll::-webkit-scrollbar-thumb:hover { background: var(--scrollbar-thumb-hover); background-clip: padding-box; }
.mx-tl-canvas {
  display: block;
  touch-action: none;
  user-select: none;
}
.mx-tip {
  position: absolute;
  z-index: 6;
  display: flex;
  align-items: baseline;
  gap: 6px;
  max-width: 240px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-1);
  box-shadow: var(--shadow-sm);
  color: var(--text-1);
  font-size: 10px;
  pointer-events: none;
  transform: translate(-50%, -100%);
  white-space: nowrap;
}
.mx-tip b {
  overflow: hidden;
  max-width: 132px;
  color: var(--text-0);
  font-weight: 600;
  text-overflow: ellipsis;
}
.mx-tip span {
  color: var(--text-3);
  font-family: "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 9px;
}
</style>
