<template>
  <section class="ed-timeline">
    <header class="ed-timeline-head">
      <b>{{ t('edit.timeline') }}</b>
      <span>{{ t('edit.clipCount', { n: plan.clips.length }) }}</span>
      <span>{{ t('edit.duration') }} {{ formatPrecise(layout.duration_ms) }}</span>
      <div class="ed-timeline-tools">
        <button class="ed-tool" type="button" :title="t('edit.snap')" :class="{ 'is-on': snapEnabled }" @click="snapEnabled = !snapEnabled">
          <Magnet :size="13" />
        </button>
        <button class="ed-tool" type="button" :title="t('edit.zoomOut')" @click="setZoom(zoom / 1.5)">
          <ZoomOut :size="13" />
        </button>
        <span class="ed-zoom">{{ Math.round(zoom * 100) }}%</span>
        <button class="ed-tool" type="button" :title="t('edit.zoomIn')" @click="setZoom(zoom * 1.5)">
          <ZoomIn :size="13" />
        </button>
        <button class="ed-tool" type="button" :title="t('edit.split')" :disabled="!canSplit" @click="splitAtPlayhead">
          <Scissors :size="13" />
        </button>
      </div>
    </header>

    <div class="ed-timeline-body">
      <div class="ed-tl-heads">
        <span class="ed-head is-ruler"></span>
        <span class="ed-head">{{ t('edit.videoTrack') }}</span>
        <span class="ed-head">{{ t('edit.subtitleTrack') }}</span>
        <span class="ed-head">{{ t('edit.audioTrack') }}</span>
      </div>

      <div ref="scrollRef" class="ed-tl-scroll">
        <div class="ed-tl-stage" :style="{ width: `${stageWidth}px` }">
          <div class="ed-tl-ruler" @pointerdown="onRulerDown">
            <span
              v-for="tick in ticks"
              :key="tick.ms"
              class="ed-tick"
              :style="{ left: `${tick.left}px` }"
            >{{ tick.label }}</span>
          </div>

          <div class="ed-tl-track is-video" @pointerdown.self="onTrackDown">
            <div
              v-for="view in clipViews"
              :key="view.clip_id"
              class="ed-tl-clip"
              :class="{
                'is-selected': view.clip_id === selectedClipId,
                'is-dragging': drag?.kind === 'move' && drag?.clipId === view.clip_id,
              }"
              :style="clipStyle(view)"
              @pointerdown.stop="startDrag($event, 'move', { clipId: view.clip_id })"
            >
              <span class="ed-tl-clip-label">{{ view.label }}</span>
              <span class="ed-tl-clip-time">{{ formatPrecise(view.content_duration_ms) }}</span>
              <span
                v-if="!readonly"
                class="ed-trim is-start"
                @pointerdown.stop="startDrag($event, 'trim-start', { clipId: view.clip_id, edgeMs: view.timeline_start_ms })"
              ></span>
              <span
                v-if="!readonly"
                class="ed-trim is-end"
                @pointerdown.stop="startDrag($event, 'trim-end', { clipId: view.clip_id, edgeMs: view.timeline_end_ms })"
              ></span>
            </div>
            <p v-if="!clipViews.length" class="ed-tl-empty">{{ t('edit.timelineEmpty') }}</p>
          </div>

          <div class="ed-tl-track is-subtitle">
            <div
              v-for="cue in cueViews"
              :key="cue.id"
              class="ed-tl-cue"
              :class="{ 'is-selected': cue.id === selectedCueId, 'is-follow': cue.follow }"
              :style="{ left: `${cue.left}px`, width: `${cue.width}px` }"
              @pointerdown.stop="startDrag($event, 'cue', { cueId: cue.id, startMs: cue.startMs, endMs: cue.endMs })"
            >
              <span>{{ cue.text }}</span>
            </div>
            <p v-if="!cueViews.length" class="ed-tl-empty">{{ t('edit.subtitleEmpty') }}</p>
          </div>

          <div class="ed-tl-track is-audio">
            <div v-if="audioMode === 'video'" class="ed-tl-audio-bar">
              <Link2 :size="11" />
              <span>{{ t('edit.audioModeVideo') }}</span>
            </div>
            <p v-else class="ed-tl-empty">{{ t('edit.audioModeNone') }}</p>
          </div>

          <div
            v-for="transition in transitionViews"
            :key="transition.id"
            class="ed-tl-transition"
            :style="{ left: `${transition.left}px` }"
            :title="t('edit.transition')"
          >
            <span>⇄</span>
            <button
              v-if="!readonly"
              type="button"
              :title="t('edit.removeTransition')"
              @pointerdown.stop
              @click.stop="$emit('remove-transition', transition.id)"
            >×</button>
          </div>

          <div class="ed-tl-playhead" :style="{ left: `${playheadLeft}px` }"></div>
          <div
            v-if="snapLine !== null"
            class="ed-tl-snapline"
            :style="{ left: `${pad + snapLine * pxPerMs}px` }"
          ></div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Link2, Magnet, Scissors, ZoomIn, ZoomOut } from 'lucide-vue-next'
import { formatClock } from '~/utils/edit-plan'
import { formatPrecise } from '~/utils/edit-timecode'
import { activeClipIndex } from '~/utils/edit-layout'
import { collectSnapPoints, snapTime } from '~/utils/edit-snap'

const props = defineProps({
  plan: { type: Object, required: true },
  layout: { type: Object, required: true },
  currentMs: { type: Number, default: 0 },
  selectedClipId: { type: String, default: '' },
  selectedCueId: { type: String, default: '' },
  readonly: { type: Boolean, default: false },
  audioMode: { type: String, default: 'none' },
})
const emit = defineEmits([
  'seek', 'select-clip', 'select-cue', 'move-clip', 'trim-clip',
  'split-clip', 'move-cue', 'remove-transition',
])
const { t } = useI18n()

const scrollRef = ref(null)
const zoom = ref(1)
const snapEnabled = ref(true)
const pad = 24
const drag = ref(null)
const snapLine = ref(null)

const pxPerMs = computed(() => 0.04 * zoom.value)
const duration = computed(() => Math.max(1000, Number(props.layout.duration_ms) || 0))
const stageWidth = computed(() => Math.max(640, duration.value * pxPerMs.value + pad * 2))
const playheadLeft = computed(() => (
  pad + Math.min(duration.value, Math.max(0, Number(props.currentMs) || 0)) * pxPerMs.value
))

const tickStep = computed(() => {
  const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000]
  return steps.find((step) => step * pxPerMs.value >= 70) ?? 60000
})

const ticks = computed(() => {
  const result = []
  for (let ms = 0; ms <= duration.value; ms += tickStep.value) {
    result.push({ ms, left: pad + ms * pxPerMs.value, label: formatClock(ms) })
  }
  return result
})

const clipViews = computed(() => props.layout.clips.map((item) => {
  const clip = props.plan.clips.find((candidate) => candidate.id === item.clip_id)
  const label = clip?.source?.label
    || (clip?.source?.kind === 'episode-video' ? t('edit.sourceEpisodeVideo') : t('edit.clip'))
  return {
    ...item,
    label,
    left: pad + item.timeline_start_ms * pxPerMs.value,
    width: Math.max(4, (item.timeline_end_ms - item.timeline_start_ms) * pxPerMs.value),
  }
}))

const cueViews = computed(() => props.plan.subtitles.map((cue) => ({
  ...cue,
  left: pad + Math.max(0, cue.startMs) * pxPerMs.value,
  width: Math.max(3, (cue.endMs - cue.startMs) * pxPerMs.value),
})))

const transitionViews = computed(() => props.layout.transitions.map((transition) => {
  const to = props.layout.clips.find((clip) => clip.clip_id === transition.to_clip_id)
  return { ...transition, left: pad + (to?.timeline_start_ms ?? 0) * pxPerMs.value }
}))

const activeIndex = computed(() => activeClipIndex(props.layout, props.currentMs))
const activeClip = computed(() => props.plan.clips[activeIndex.value] ?? null)
const activeLayoutClip = computed(() => props.layout.clips[activeIndex.value] ?? null)
// 与 splitClip 的 minimumSourceMs 边界一致（3 秒按帧率折算），避免按钮可用但命令拒绝
const splitMinMs = computed(() => (
  Math.ceil(3000 / Math.max(1, Number(props.plan.project?.fps) || 30))
))
const canSplit = computed(() => Boolean(
  !props.readonly
  && activeClip.value
  && activeLayoutClip.value
  && props.currentMs - activeLayoutClip.value.timeline_start_ms >= splitMinMs.value
  && activeLayoutClip.value.timeline_end_ms - props.currentMs >= splitMinMs.value,
))

function clipStyle(view) {
  if (drag.value?.kind === 'move' && drag.value.clipId === view.clip_id) {
    return { left: `${view.left}px`, width: `${view.width}px`, transform: `translateX(${drag.value.currentX - drag.value.startX}px)` }
  }
  if (drag.value?.kind === 'trim-start' && drag.value.clipId === view.clip_id) {
    const delta = drag.value.currentX - drag.value.startX
    return { left: `${view.left + delta}px`, width: `${Math.max(4, view.width - delta)}px` }
  }
  if (drag.value?.kind === 'trim-end' && drag.value.clipId === view.clip_id) {
    const delta = drag.value.currentX - drag.value.startX
    return { left: `${view.left}px`, width: `${Math.max(4, view.width + delta)}px` }
  }
  return { left: `${view.left}px`, width: `${view.width}px` }
}

function setZoom(value) {
  zoom.value = Math.max(0.25, Math.min(8, Number(value) || 1))
}

function cueClipId(cue) {
  return cue?.clipId || cue?.anchor?.clipId || ''
}

function snapTarget(targetMs, options = {}) {
  if (!snapEnabled.value) return { ms: Math.round(targetMs), point: null }
  const excludeClipId = options.excludeClipId || ''
  const excludeCueId = options.excludeCueId || ''
  const ownClip = excludeClipId
    ? props.layout.clips.find((item) => item.clip_id === excludeClipId) ?? null
    : null
  const ownCues = excludeClipId
    ? props.plan.subtitles.filter((cue) => cueClipId(cue) === excludeClipId)
    : []
  const ownCue = excludeCueId
    ? props.plan.subtitles.find((item) => item.id === excludeCueId) ?? null
    : null
  const matches = (point, kind, ms) => point.kind === kind && point.ms === ms
  const points = collectSnapPoints(props.plan, props.layout, props.currentMs)
    .filter((point) => {
      if (ownClip && (
        matches(point, 'clip-start', ownClip.timeline_start_ms)
        || matches(point, 'clip-end', ownClip.timeline_end_ms)
      )) return false
      if (ownCues.some((cue) => (
        matches(point, 'cue-start', cue.startMs) || matches(point, 'cue-end', cue.endMs)
      ))) return false
      if (ownCue && (
        matches(point, 'cue-start', ownCue.startMs)
        || matches(point, 'cue-end', ownCue.endMs)
      )) return false
      return true
    })
  return snapTime(targetMs, points, 8 / pxPerMs.value)
}

function clipSpeed(clipId) {
  const clip = props.plan.clips.find((item) => item.id === clipId)
  return Number(clip?.speed) || 1
}

// 拖拽在时间线域进行，吸附结果也只按时间线域计算；返回值供移动预览与抬起时共用
function dragSnap(state) {
  const deltaMs = (state.currentX - state.startX) / pxPerMs.value
  if (state.kind === 'trim-start' || state.kind === 'trim-end') {
    return snapTarget(state.edgeMs + deltaMs, { excludeClipId: state.clipId })
  }
  if (state.kind === 'cue') {
    return snapTarget(state.startMs + deltaMs, { excludeCueId: state.cueId })
  }
  return null
}

function seekAt(clientX) {
  const scroll = scrollRef.value
  if (!scroll) return
  const rect = scroll.getBoundingClientRect()
  const x = clientX - rect.left + scroll.scrollLeft
  const ms = Math.max(0, Math.min(duration.value, (x - pad) / pxPerMs.value))
  emit('seek', Math.round(ms))
}

function onRulerDown(event) {
  startDrag(event, 'playhead')
  seekAt(event.clientX)
}

function onTrackDown(event) {
  if (event.target !== event.currentTarget) return
  startDrag(event, 'playhead')
  seekAt(event.clientX)
}

function startDrag(event, kind, payload = {}) {
  if (event.button !== undefined && event.button !== 0) return
  if (props.readonly && kind !== 'playhead') {
    if (payload.clipId) emit('select-clip', payload.clipId)
    if (payload.cueId) emit('select-cue', payload.cueId)
    return
  }
  event.preventDefault()
  snapLine.value = null
  drag.value = {
    kind,
    startX: event.clientX,
    currentX: event.clientX,
    ...payload,
  }
  if (payload.clipId) emit('select-clip', payload.clipId)
  if (payload.cueId) emit('select-cue', payload.cueId)
}

function onPointerMove(event) {
  if (!drag.value) return
  drag.value = { ...drag.value, currentX: event.clientX }
  if (drag.value.kind === 'playhead') {
    seekAt(event.clientX)
    return
  }
  const snapped = dragSnap(drag.value)
  snapLine.value = snapped?.point ? snapped.point.ms : null
}

function onPointerUp() {
  const state = drag.value
  drag.value = null
  snapLine.value = null
  if (!state) return
  const deltaPx = state.currentX - state.startX
  if (state.kind === 'move') {
    if (Math.abs(deltaPx) < 3) return
    const views = clipViews.value
    const currentIndex = views.findIndex((view) => view.clip_id === state.clipId)
    if (currentIndex < 0) return
    const dragged = views[currentIndex]
    const others = views.filter((view) => view.clip_id !== state.clipId)
    const center = dragged.left + dragged.width / 2 + deltaPx
    let targetIndex = others.findIndex((view) => center < view.left + view.width / 2)
    if (targetIndex < 0) targetIndex = others.length
    if (targetIndex === currentIndex) return
    emit('move-clip', { clipId: state.clipId, targetIndex })
    return
  }
  if (state.kind === 'trim-start' || state.kind === 'trim-end') {
    if (Math.abs(deltaPx) < 2) return
    const snapped = dragSnap(state)
    // 拖拽位移是时间线域，trimClipStart/trimClipEnd 接收的是素材域（源）位移，故按 speed 换算
    emit('trim-clip', {
      clipId: state.clipId,
      edge: state.kind === 'trim-start' ? 'start' : 'end',
      deltaMs: Math.round((snapped.ms - state.edgeMs) * clipSpeed(state.clipId)),
    })
    return
  }
  if (state.kind === 'cue') {
    if (Math.abs(deltaPx) < 2) return
    const snapped = dragSnap(state)
    // moveCue 直接接收时间线毫秒，不做 speed 换算；起点不得越过成片末尾
    const cueLength = Math.max(0, Number(state.endMs) - Number(state.startMs))
    const maxStart = Math.max(0, Number(props.layout.duration_ms) - cueLength)
    emit('move-cue', {
      cueId: state.cueId,
      startMs: Math.max(0, Math.min(maxStart, Math.round(snapped.ms))),
    })
  }
}

function onPointerCancel() {
  drag.value = null
  snapLine.value = null
}

function splitAtPlayhead() {
  if (!canSplit.value || !activeClip.value || !activeLayoutClip.value) return
  emit('split-clip', {
    clipId: activeClip.value.id,
    atMs: Math.round(props.currentMs - activeLayoutClip.value.timeline_start_ms),
  })
}

onMounted(() => {
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
  // 指针在窗口外松开时收不到 pointerup，窗口失焦同样终止拖拽，避免残留预览
  window.addEventListener('blur', onPointerCancel)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  window.removeEventListener('blur', onPointerCancel)
})
</script>

<style scoped>
.ed-timeline {
  flex: 0 0 auto; min-height: 196px; display: flex; flex-direction: column; gap: 6px;
  padding: 8px 10px 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-1);
}
.ed-timeline-head { display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--text-3); }
.ed-timeline-head b { color: var(--text-1); font-size: 12px; }
.ed-timeline-tools { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; }
.ed-tool {
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2);
  color: var(--text-2); cursor: pointer;
}
.ed-tool:hover { color: var(--text-0); border-color: var(--accent); }
.ed-tool.is-on { color: var(--accent-text); border-color: var(--accent); background: var(--accent-bg); }
.ed-tool:disabled { opacity: .4; cursor: not-allowed; }
.ed-zoom { min-width: 36px; text-align: center; font-size: 10px; color: var(--text-3); }
.ed-timeline-body { flex: 1; min-height: 0; display: flex; gap: 6px; }
.ed-tl-heads { flex: 0 0 46px; display: flex; flex-direction: column; font-size: 9px; color: var(--text-3); }
.ed-head { display: flex; align-items: center; border-bottom: 1px solid transparent; }
.ed-head.is-ruler { height: 24px; }
.ed-head:nth-child(2) { height: 60px; }
.ed-head:nth-child(3) { height: 34px; }
.ed-head:nth-child(4) { height: 22px; }
.ed-tl-scroll { flex: 1; min-width: 0; overflow-x: auto; overflow-y: hidden; }
.ed-tl-stage { position: relative; height: 140px; user-select: none; }
.ed-tl-ruler {
  position: absolute; inset: 0 0 auto; height: 24px; cursor: ew-resize;
  border-bottom: 1px solid var(--border); background: var(--bg-2);
}
.ed-tick {
  position: absolute; top: 5px; transform: translateX(-50%);
  font-size: 9px; color: var(--text-3); white-space: nowrap; pointer-events: none;
}
.ed-tl-track { position: absolute; left: 0; right: 0; border-radius: 6px; background: var(--bg-2); }
.ed-tl-track.is-video { top: 24px; height: 60px; }
.ed-tl-track.is-subtitle { top: 84px; height: 34px; background: color-mix(in srgb, var(--bg-2) 82%, transparent); }
.ed-tl-track.is-audio { top: 118px; height: 22px; }
.ed-tl-clip {
  position: absolute; top: 3px; bottom: 3px; min-width: 4px; overflow: hidden;
  display: flex; flex-direction: column; justify-content: space-between;
  padding: 4px 8px; border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
  border-radius: 6px; background: color-mix(in srgb, var(--accent) 16%, var(--bg-1));
  color: var(--text-0); cursor: grab;
}
.ed-tl-clip:hover { border-color: var(--accent); }
.ed-tl-clip.is-selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ed-tl-clip.is-dragging { opacity: .82; cursor: grabbing; z-index: 4; }
.ed-tl-clip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; font-weight: 600; pointer-events: none; }
.ed-tl-clip-time { font-size: 9px; color: var(--text-2); pointer-events: none; }
.ed-trim {
  position: absolute; top: 0; bottom: 0; width: 7px; cursor: ew-resize;
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}
.ed-trim.is-start { left: 0; border-radius: 6px 0 0 6px; }
.ed-trim.is-end { right: 0; border-radius: 0 6px 6px 0; }
.ed-tl-cue {
  position: absolute; top: 3px; bottom: 3px; min-width: 3px; overflow: hidden;
  display: flex; align-items: center; padding: 0 6px; border-radius: 4px;
  border: 1px solid color-mix(in srgb, #d7a24a 55%, transparent);
  background: color-mix(in srgb, #d7a24a 20%, var(--bg-1));
  color: var(--text-0); font-size: 9px; white-space: nowrap; cursor: ew-resize;
}
.ed-tl-cue.is-follow { border-style: dashed; }
.ed-tl-cue.is-selected { box-shadow: 0 0 0 1px #d7a24a; }
.ed-tl-audio-bar {
  position: absolute; inset: 3px; display: flex; align-items: center; gap: 5px;
  padding: 0 8px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--success) 40%, transparent);
  background: color-mix(in srgb, var(--success) 13%, var(--bg-1));
  color: var(--text-2); font-size: 9px; overflow: hidden; white-space: nowrap;
}
.ed-tl-transition {
  position: absolute; top: 48px; transform: translateX(-50%); z-index: 3;
  display: inline-flex; align-items: center; gap: 1px; height: 18px; padding: 0 3px;
  border-radius: 5px; background: var(--bg-0); border: 1px solid var(--border);
  color: var(--text-2); font-size: 10px;
}
.ed-tl-transition button {
  width: 14px; height: 14px; padding: 0; border: 0; border-radius: 3px;
  background: transparent; color: var(--text-3); cursor: pointer; line-height: 1;
}
.ed-tl-transition button:hover { background: var(--bg-hover); color: var(--action-danger); }
.ed-tl-playhead {
  position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px;
  background: var(--accent); pointer-events: none; z-index: 5;
}
.ed-tl-playhead::before {
  content: ''; position: absolute; left: -4px; top: 0;
  border: 5px solid transparent; border-top-color: var(--accent);
}
.ed-tl-snapline {
  position: absolute; top: 24px; bottom: 0; width: 1px; background: #d7a24a;
  pointer-events: none; z-index: 4;
}
.ed-tl-empty {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  margin: 0; font-size: 9px; color: var(--text-3); pointer-events: none;
}
</style>
