<template>
  <section ref="rootRef" class="ed-timeline">
    <header class="ed-timeline-head">
      <b>{{ t('edit.timeline') }}</b>
      <span>{{ t('edit.clipCount', { n: plan.clips.length }) }}</span>
      <span>{{ t('edit.duration') }} {{ formatPrecise(layout.duration_ms) }}</span>
      <div class="ed-timeline-tools">
        <!-- 可见操作入口（spec 6.8：不依赖右键和快捷键），右键菜单只是快捷路径 -->
        <button
          class="ed-tool is-text" type="button" :disabled="readonly"
          @click="openMenuFromButton($event, frameMenuItems())"
        >{{ t('edit.frameOps') }} ▾</button>
        <button
          class="ed-tool is-text" type="button" :disabled="readonly"
          @click="openMenuFromButton($event, insertMenuItems())"
        >{{ t('edit.insertMenu') }} ▾</button>
        <button
          class="ed-tool is-text" type="button" :disabled="readonly"
          @click="openTransitionPicker()"
        >{{ t('edit.transition') }} ▾</button>
        <button
          class="ed-tool is-text" type="button" :disabled="readonly"
          @click="openMenuFromButton($event, overlayMenuItems())"
        >{{ t('edit.overlayMenu') }} ▾</button>
        <button
          class="ed-tool is-text" type="button"
          @click="openMenuFromButton($event, subtitleMenuItems())"
        >{{ t('edit.subtitleMenu') }} ▾</button>
        <button class="ed-tool is-text" type="button" :disabled="!canSplit" @click="splitAtPlayhead">
          {{ t('edit.split') }}
        </button>
        <button class="ed-tool is-text" type="button" :disabled="!selectedClipId || readonly" @click="removeSelected">
          {{ t('edit.delete') }}
        </button>
        <button
          class="ed-tool is-text ed-tool-more" type="button"
          :disabled="!selectedClipId || readonly"
          :title="t('tablet.more')" :aria-label="t('tablet.more')"
          @click="openSelectedClipMenu($event)"
        >{{ t('tablet.more') }}</button>
        <button class="ed-tool is-text" type="button" @click="$emit('fit-view')">
          {{ t('edit.fitView') }}
        </button>
        <span class="ed-tools-sep"></span>
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
        <span class="ed-head">{{ t('edit.overlayTrack') }}</span>
        <span class="ed-head">{{ t('edit.videoTrack') }}</span>
        <span class="ed-head">{{ t('edit.subtitleTrack') }}</span>
        <span class="ed-head">{{ t('edit.audioTrack') }}</span>
      </div>

      <div ref="scrollRef" class="ed-tl-scroll" :class="{ 'is-pinching': pinching }">
        <div class="ed-tl-stage" :style="{ width: `${stageWidth}px` }">
          <div class="ed-tl-ruler" @pointerdown="onRulerDown">
            <span
              v-for="tick in ticks"
              :key="tick.ms"
              class="ed-tick"
              :style="{ left: `${tick.left}px` }"
            >{{ tick.label }}</span>
          </div>

          <div class="ed-tl-track is-overlay">
            <div
              v-for="view in overlayViews"
              :key="view.id"
              class="ed-tl-overlay"
              :class="[`is-${view.kind}`, {
                'is-selected': view.id === selectedOverlayId,
                'is-dragging': drag?.kind === 'overlay-move' && drag?.overlayId === view.id,
              }]"
              :style="overlayStyle(view)"
              :title="view.title"
              @pointerdown.stop="startDrag($event, 'overlay-move', { overlayId: view.id, startMs: view.startMs, endMs: view.endMs })"
              @contextmenu.prevent.stop="openOverlayMenu($event, view)"
            >
              <span class="ed-tl-clip-label">{{ view.label }}</span>
              <span
                v-if="!readonly"
                class="ed-trim is-start"
                @pointerdown.stop="startDrag($event, 'overlay-trim-start', { overlayId: view.id, startMs: view.startMs, endMs: view.endMs, edgeMs: view.startMs })"
              ></span>
              <span
                v-if="!readonly"
                class="ed-trim is-end"
                @pointerdown.stop="startDrag($event, 'overlay-trim-end', { overlayId: view.id, startMs: view.startMs, endMs: view.endMs, edgeMs: view.endMs })"
              ></span>
            </div>
            <p v-if="!overlayViews.length" class="ed-tl-empty">{{ t('edit.overlayEmpty') }}</p>
          </div>

          <div class="ed-tl-track is-video" @pointerdown.self="onTrackDown">
            <div
              v-for="view in clipViews"
              :key="view.clip_id"
              class="ed-tl-clip"
              data-long-press
              :class="{
                'is-selected': view.clip_id === selectedClipId,
                'is-dragging': drag?.kind === 'move' && drag?.clipId === view.clip_id,
              }"
              :style="clipStyle(view)"
              @pointerdown.stop="onClipPointerDown($event, view)"
              @contextmenu.prevent.stop="onClipContextMenu($event, view)"
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
              @contextmenu.prevent.stop="openCueMenu($event, cue)"
            >
              <span>{{ cue.text }}</span>
            </div>
            <p v-if="!cueViews.length && showSubtitles" class="ed-tl-empty">{{ t('edit.subtitleEmpty') }}</p>
          </div>

          <div class="ed-tl-track is-audio">
            <template v-if="audioMode === 'video'">
              <div
                v-for="view in audioClipViews"
                :key="`audio-${view.clip_id}`"
                class="ed-tl-audio-clip"
                :class="{ 'is-muted': view.muted }"
                :style="{ left: `${view.left}px`, width: `${view.width}px` }"
                :title="view.title"
              >
                <EditAudioWave
                  :episode-id="episodeId"
                  :src="view.src"
                  :fingerprint="view.fingerprint"
                  :width="Math.max(4, Math.round(view.width))"
                  :height="18"
                  :muted="view.muted"
                />
                <span v-if="view.flags" class="ed-tl-audio-flags">{{ view.flags }}</span>
              </div>
              <p v-if="!audioClipViews.length" class="ed-tl-empty">{{ t('edit.audioTrackEmpty') }}</p>
            </template>
            <p v-else class="ed-tl-empty">{{ t('edit.audioModeNone') }}</p>
          </div>

          <div
            v-for="transition in transitionViews"
            :key="transition.id"
            class="ed-tl-transition"
            :style="{ left: `${transition.left}px` }"
            :title="`${t('edit.transition')} · ${t(transitionLabelKey(transition))}`"
            @click.stop="emit('open-transition-picker', { fromClipId: transition.from_clip_id, toClipId: transition.to_clip_id })"
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

          <div
            v-for="marker in markerViews"
            :key="marker.id"
            class="ed-tl-marker"
            :style="{ left: `${marker.left}px`, '--marker-color': marker.color || 'var(--warning, #f59e0b)' }"
            :title="marker.title"
            @pointerdown.stop.prevent="emit('seek', marker.atMs)"
            @contextmenu.prevent.stop="openMarkerMenu($event, marker)"
          >
            <span class="ed-tl-marker-flag"></span>
          </div>

          <div
            class="ed-tl-playhead"
            :style="{ left: `${playheadLeft}px` }"
            @pointerdown.stop="startDrag($event, 'playhead')"
          ></div>
          <div
            v-if="snapLine !== null"
            class="ed-tl-snapline"
            :style="{ left: `${pad + snapLine * pxPerMs}px` }"
          ></div>
        </div>
      </div>

      <!-- 右键菜单与工具栏下拉共用同一套菜单（x/y 由打开处决定） -->
      <ContextMenu
        :show="Boolean(menu)"
        :x="menu?.x ?? 0"
        :y="menu?.y ?? 0"
        :items="menu?.items ?? []"
        @update:show="onMenuShowChange"
      />
    </div>
  </section>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { nextTick } from 'vue'
import { Magnet, Scissors, ZoomIn, ZoomOut } from 'lucide-vue-next'
import ContextMenu from '~/components/ContextMenu.vue'
import EditAudioWave from './EditAudioWave.vue'
import { formatClock } from '~/utils/edit-plan'
import { formatPrecise } from '~/utils/edit-timecode'
import { TRANSITION_TYPES } from '~/utils/edit-transition-types'
import { activeClipIndex } from '~/utils/edit-layout'
import { collectSnapPoints, snapTime } from '~/utils/edit-snap'
import { distanceBetween } from '~/utils/touch'
import { useLongPress } from '~/composables/useLongPress'
import { usePinchZoom } from '~/composables/usePinchZoom'
import { EDIT_ZOOM_MIN, EDIT_ZOOM_MAX, anchoredScrollLeft, clampEditZoom } from '~/utils/edit-zoom'
import { TABLET_MAX } from '~/utils/tablet-layout'

const props = defineProps({
  plan: { type: Object, required: true },
  layout: { type: Object, required: true },
  currentMs: { type: Number, default: 0 },
  selectedClipId: { type: String, default: '' },
  selectedCueId: { type: String, default: '' },
  selectedOverlayId: { type: String, default: '' },
  readonly: { type: Boolean, default: false },
  audioMode: { type: String, default: 'none' },
  showSubtitles: { type: Boolean, default: true },
  episodeId: { type: Number, default: 0 },
})
const emit = defineEmits([
  'seek', 'select-clip', 'select-cue', 'move-clip', 'trim-clip',
  'split-clip', 'move-cue', 'remove-transition', 'open-transition-picker',
  'frame-op', 'cue-op', 'toggle-subtitles', 'fit-view', 'open-subtitles', 'remove-clip',
  'duplicate-clip', 'add-marker', 'delete-marker', 'close-gaps',
  'select-overlay', 'move-overlay', 'trim-overlay', 'remove-overlay', 'overlay-insert',
  'clip-volume',
])
const { t } = useI18n()

const scrollRef = ref(null)
const rootRef = ref(null)
const zoom = ref(1)
const snapEnabled = ref(true)
const pad = 24
const drag = ref(null)
const snapLine = ref(null)
const pinching = ref(false)
// 触控在片段上的按下只挂起拖拽：超过 8px 才真正进入拖拽，避免长按/滚动被 preventDefault 吞掉
let pendingClipDrag = null

function clearPendingClipDrag() {
  pendingClipDrag = null
}

// 指针捕获：按 pointerId 记录，双指/多指各自独立，不会被第二指覆盖
const dragCaptures = new Map()

function captureDragPointerOn(el, pointerId) {
  if (!el || typeof el.setPointerCapture !== 'function' || pointerId === undefined) return
  try {
    el.setPointerCapture(pointerId)
    dragCaptures.set(pointerId, { el, pointerId })
  } catch {
    dragCaptures.delete(pointerId)
  }
}

function captureDragPointer(event) {
  captureDragPointerOn(event.currentTarget, event.pointerId)
}

function releaseOneCapture(capture) {
  try {
    if (capture.el.hasPointerCapture?.(capture.pointerId)) {
      capture.el.releasePointerCapture(capture.pointerId)
    }
  } catch {
    // 元素已卸载或指针已失效时忽略
  }
}

// 传 pointerId 只释放该指针；不传则释放全部（失焦、卸载）
function releaseDragPointer(pointerId) {
  if (pointerId !== undefined && pointerId !== null) {
    const capture = dragCaptures.get(pointerId)
    if (!capture) return
    dragCaptures.delete(pointerId)
    releaseOneCapture(capture)
    return
  }
  for (const capture of dragCaptures.values()) releaseOneCapture(capture)
  dragCaptures.clear()
}

// ---- 双指缩放（P7）：窗口 capture 阶段接入，只接管落在时间线内的触控指针 ----
const pinch = usePinchZoom({
  min: EDIT_ZOOM_MIN,
  max: EDIT_ZOOM_MAX,
  getValue: () => zoom.value,
  onChange: (next, focal) => {
    const scroll = scrollRef.value
    if (!scroll) {
      zoom.value = clampEditZoom(next)
      return
    }
    const rect = scroll.getBoundingClientRect()
    const focalX = focal.clientX - rect.left
    // 以实际缩放为基准：适配缩放可低于 EDIT_ZOOM_MIN，钳制后算比率会让锚点漂移；
    // 但双指起点仍按 0.25 计算（P7 裁决），低于 0.25 的适配态首帧会跳到下限
    const current = Number(zoom.value) > 0 ? Number(zoom.value) : EDIT_ZOOM_MIN
    const ratio = next / current
    const targetScroll = anchoredScrollLeft({
      scrollLeft: scroll.scrollLeft,
      focalX,
      padPx: pad,
      ratio,
    })
    // 缩放先落到状态，滚动位置等 DOM 宽度更新后的下一帧再写回，避免被旧宽度截断
    zoom.value = clampEditZoom(next)
    void nextTick(() => {
      if (scrollRef.value) scrollRef.value.scrollLeft = targetScroll
    })
  },
  onStart: () => {
    // 双指开始即让位：清空单指挂起/拖拽与长按，避免与片段拖拽串扰
    clearPendingClipDrag()
    releaseDragPointer()
    drag.value = null
    snapLine.value = null
    cancelClipLongPress()
    pinching.value = true
  },
  onEnd: () => {
    pinching.value = false
  },
})
const pinchActive = pinch.active

function isTimelinePointer(target) {
  const root = rootRef.value
  if (!root || !target || typeof root.contains !== 'function') return false
  return root.contains(target)
}

function onPinchPointerDown(event) {
  if (event.pointerType !== 'touch') return
  // 桌面宽度不变式 ≥1181：触屏笔记本也不接管双指缩放
  if (window.innerWidth > TABLET_MAX) return
  if (!isTimelinePointer(event.target)) return
  pinch.onPointerDown(event)
}

function onPinchPointerMove(event) {
  if (event.pointerType !== 'touch') return
  pinch.onPointerMove(event)
}

function onPinchPointerUp(event) {
  if (event.pointerType !== 'touch') return
  pinch.onPointerUp(event)
}

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

// 音频轨：原声模式下逐片段画真实波形（后端 audio-peaks 缓存共享），并标注音量/淡入淡出
const audioClipViews = computed(() => props.plan.clips
  .filter((clip) => clip.kind === 'video' && clip.source?.hasAudio && clip.source?.url)
  .map((clip) => {
    const item = props.layout.clips.find((entry) => entry.clip_id === clip.id)
    if (!item) return null
    const volume = Math.max(0, Number(clip.volume ?? 1))
    const fadeInMs = Number(clip.audioFadeInMs ?? clip.videoFadeInMs) || 0
    const fadeOutMs = Number(clip.audioFadeOutMs ?? clip.videoFadeOutMs) || 0
    const flags = [
      volume === 0 ? t('edit.audioMuted') : volume !== 1 ? `${Math.round(volume * 100)}%` : '',
      fadeInMs > 0 ? t('edit.audioFadeInShort') : '',
      fadeOutMs > 0 ? t('edit.audioFadeOutShort') : '',
    ].filter(Boolean).join(' · ')
    return {
      clip_id: clip.id,
      left: pad + item.timeline_start_ms * pxPerMs.value,
      width: Math.max(4, (item.timeline_end_ms - item.timeline_start_ms) * pxPerMs.value),
      src: clip.source.url,
      fingerprint: clip.source.fingerprint || '',
      muted: volume === 0,
      flags,
      title: `${clip.source.label || t('edit.clip')} · ${flags || t('edit.audioTitle')}`,
    }
  })
  .filter(Boolean))

// 隐藏字幕轨时只隐藏字幕块本身，轨道槽位保留，避免轨头/轨道错位
const cueViews = computed(() => (
  props.showSubtitles
    ? props.plan.subtitles.map((cue) => ({
      ...cue,
      left: pad + Math.max(0, cue.startMs) * pxPerMs.value,
      width: Math.max(3, (cue.endMs - cue.startMs) * pxPerMs.value),
    }))
    : []
))

const overlayKindLabelKey = {
  video: 'edit.overlayKindVideo',
  image: 'edit.overlayKindImage',
  text: 'edit.overlayKindText',
}

const overlayViews = computed(() => (props.plan.overlays ?? []).map((overlay) => {
  const label = overlay.kind === 'text'
    ? (overlay.text?.text?.trim() || t('edit.overlayKindText'))
    : (overlay.source?.label || t(overlayKindLabelKey[overlay.kind] || 'edit.overlayKindVideo'))
  return {
    ...overlay,
    label,
    title: `${t(overlayKindLabelKey[overlay.kind] || 'edit.overlayKindVideo')} · ${formatPrecise(overlay.startMs)}`,
    left: pad + Math.max(0, overlay.startMs) * pxPerMs.value,
    width: Math.max(6, (overlay.endMs - overlay.startMs) * pxPerMs.value),
  }
}))

const transitionViews = computed(() => props.layout.transitions.map((transition) => {
  const to = props.layout.clips.find((clip) => clip.clip_id === transition.to_clip_id)
  return { ...transition, left: pad + (to?.timeline_start_ms ?? 0) * pxPerMs.value }
}))

const markerViews = computed(() => props.plan.markers.map((marker) => ({
  ...marker,
  left: pad + Math.max(0, marker.atMs) * pxPerMs.value,
  title: marker.label
    ? `${marker.label} ${formatPrecise(marker.atMs)}`
    : formatPrecise(marker.atMs),
})))

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

function overlayStyle(view) {
  const dragKind = drag.value?.kind
  const dragOverlayId = drag.value?.overlayId
  if (dragKind === 'overlay-move' && dragOverlayId === view.id) {
    const delta = drag.value.currentX - drag.value.startX
    return { left: `${view.left + delta}px`, width: `${view.width}px` }
  }
  if (dragKind === 'overlay-trim-start' && dragOverlayId === view.id) {
    const delta = drag.value.currentX - drag.value.startX
    return { left: `${view.left + delta}px`, width: `${Math.max(6, view.width - delta)}px` }
  }
  if (dragKind === 'overlay-trim-end' && dragOverlayId === view.id) {
    const delta = drag.value.currentX - drag.value.startX
    return { left: `${view.left}px`, width: `${Math.max(6, view.width + delta)}px` }
  }
  return { left: `${view.left}px`, width: `${view.width}px` }
}

function setZoom(value) {
  zoom.value = clampEditZoom(value)
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
  if (state.kind === 'overlay-move') {
    return snapTarget(state.startMs + deltaMs, {})
  }
  if (state.kind === 'overlay-trim-start' || state.kind === 'overlay-trim-end') {
    return snapTarget(state.edgeMs + deltaMs, {})
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
    if (payload.overlayId) emit('select-overlay', payload.overlayId)
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
  // 触控拖拽/裁剪时捕获指针，避免手指滑出片段后丢失 pointermove
  captureDragPointer(event)
  if (payload.clipId) emit('select-clip', payload.clipId)
  if (payload.cueId) emit('select-cue', payload.cueId)
  if (payload.overlayId) emit('select-overlay', payload.overlayId)
}

function onPointerMove(event) {
  // 双指缩放期间不参与片段拖拽/裁剪，避免与缩放焦点计算串扰
  if (pinching.value || pinchActive.value) return
  // 触控挂起态：位移超过 8px 才把挂起指针升级为真正的片段拖拽（等于 8px 仍视为抖动）
  if (pendingClipDrag && event.pointerId === pendingClipDrag.pointerId) {
    const pending = pendingClipDrag
    const movedPx = distanceBetween(pending.startX, pending.startY, event.clientX, event.clientY)
    if (event.pointerType !== 'touch' || !(movedPx > 8)) return
    // M7：只读态只允许选中，不升级为挂起拖拽
    if (props.readonly) {
      clearPendingClipDrag()
      return
    }
    pendingClipDrag = null
    drag.value = {
      kind: 'move',
      clipId: pending.view.clip_id,
      startX: pending.startX,
      startY: pending.startY,
      currentX: event.clientX,
    }
    // 手指可能已滑出片段，捕获到起始元素上继续收 pointermove
    captureDragPointerOn(pending.sourceEl, pending.pointerId)
  }
  if (!drag.value) return
  drag.value = { ...drag.value, currentX: event.clientX }
  if (drag.value.kind === 'playhead') {
    seekAt(event.clientX)
    return
  }
  const snapped = dragSnap(drag.value)
  snapLine.value = snapped?.point ? snapped.point.ms : null
}

function onPointerUp(event) {
  if (pinching.value || pinchActive.value) return
  clearPendingClipDrag()
  releaseDragPointer(event?.pointerId)
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
    return
  }
  if (state.kind === 'overlay-move') {
    if (Math.abs(deltaPx) < 2) return
    const snapped = dragSnap(state)
    emit('move-overlay', { overlayId: state.overlayId, startMs: Math.max(0, Math.round(snapped.ms)) })
    return
  }
  if (state.kind === 'overlay-trim-start' || state.kind === 'overlay-trim-end') {
    if (Math.abs(deltaPx) < 2) return
    const snapped = dragSnap(state)
    // 命令层负责最短一帧与主轨范围收敛；这里只提交绝对起止
    emit('trim-overlay', {
      overlayId: state.overlayId,
      startMs: state.kind === 'overlay-trim-start' ? Math.round(snapped.ms) : Math.round(state.startMs),
      endMs: state.kind === 'overlay-trim-end' ? Math.round(snapped.ms) : Math.round(state.endMs),
    })
  }
}

function onPointerCancel(event) {
  pinch.cancel()
  clearPendingClipDrag()
  releaseDragPointer(event?.pointerId)
  cancelClipLongPress()
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

// ---- 右键菜单与工具栏下拉（共用 ContextMenu 与同一套事件，spec 6.8） ----
const menu = ref(null)

function onMenuShowChange(value) {
  if (!value) menu.value = null
}

function openMenuAt(event, items) {
  menu.value = { items, x: event.clientX, y: event.clientY }
}

function openMenuFromButton(event, items) {
  const rect = event.currentTarget.getBoundingClientRect()
  menu.value = { items, x: rect.left, y: rect.bottom + 4 }
}

// 工具栏下拉（无 view）按播放头定位片段；右键（有 view）按被点片段定位
function frameMenuItems(view) {
  const at = view ? Math.round(view.timeline_start_ms) : Math.round(props.currentMs)
  const clipId = view?.clip_id ?? clipIdAt(props.currentMs)
  const clipIndex = props.plan.clips.findIndex((clip) => clip.id === clipId)
  const muted = clipId ? clipVolumeOf(clipId) === 0 : false
  return [
    { key: 'split-clip', label: t('edit.split'), shortcut: 'S', disabled: !canSplit.value, action: () => splitAtPlayhead() },
    { key: 'duplicate-clip', label: t('edit.clipDuplicate'), disabled: !clipId, action: () => emit('duplicate-clip', clipId) },
    { key: 'move-prev', label: t('edit.movePrev'), disabled: clipIndex <= 0, action: () => emit('move-clip', { clipId, targetIndex: clipIndex - 1 }) },
    { key: 'move-next', label: t('edit.moveNext'), disabled: clipIndex < 0 || clipIndex >= props.plan.clips.length - 1, action: () => emit('move-clip', { clipId, targetIndex: clipIndex + 1 }) },
    { separator: true, key: 'sep-audio', label: '' },
    { key: 'mute-toggle', label: muted ? t('edit.audioUnmute') : t('edit.audioMute'), disabled: !clipId, action: () => emit('clip-volume', { clipId, volume: muted ? 1 : 0 }) },
    { separator: true, key: 'sep0', label: '' },
    { key: 'delete-frame', label: t('edit.frameDelete'), shortcut: 'D', action: () => emit('frame-op', { kind: 'delete-frame', clipId, atMs: at }) },
    { key: 'insert-video', label: t('edit.insertVideo'), action: () => emit('frame-op', { kind: 'insert-video', clipId, atMs: at }) },
    { key: 'insert-image', label: t('edit.frameInsertImage'), action: () => emit('frame-op', { kind: 'insert-image', clipId, atMs: at }) },
    { separator: true, key: 'sep', label: '' },
    { key: 'extend-1s', label: t('edit.frameExtend'), action: () => emit('frame-op', { kind: 'extend-1s', clipId, atMs: at }) },
    { separator: true, key: 'sep2', label: '' },
    { key: 'add-marker', label: t('edit.markerAdd'), action: () => emit('add-marker', Math.round(props.currentMs)) },
    { key: 'close-gaps', label: t('edit.closeGaps'), action: () => emit('close-gaps') },
  ]
}

function clipIdAt(ms) {
  const index = activeClipIndex(props.layout, ms)
  return props.layout.clips[index]?.clip_id ?? ''
}

function clipVolumeOf(clipId) {
  const clip = props.plan.clips.find((item) => item.id === clipId)
  return Math.max(0, Number(clip?.volume ?? 1))
}

// 插入素材菜单：视频/图片按播放头落点插入，复制分段基于当前选中片段
function insertMenuItems() {
  const at = Math.round(props.currentMs)
  return [
    { key: 'insert-video', label: t('edit.insertVideo'), action: () => emit('frame-op', { kind: 'insert-video', atMs: at }) },
    { key: 'insert-image', label: t('edit.frameInsertImage'), action: () => emit('frame-op', { kind: 'insert-image', atMs: at }) },
    { separator: true, key: 'sep', label: '' },
    { key: 'duplicate-clip', label: t('edit.clipDuplicate'), disabled: !props.selectedClipId, action: () => emit('duplicate-clip', props.selectedClipId) },
  ]
}

// 画中画菜单：视频/图片复用素材选择器（由 workbench 打开），文字直接在播放头创建
function overlayMenuItems() {
  return [
    { key: 'overlay-video', label: t('edit.overlayInsertVideo'), action: () => emit('overlay-insert', 'video') },
    { key: 'overlay-image', label: t('edit.overlayInsertImage'), action: () => emit('overlay-insert', 'image') },
    { key: 'overlay-text', label: t('edit.overlayInsertText'), action: () => emit('overlay-insert', 'text') },
  ]
}

function openOverlayMenu(event, view) {
  if (props.readonly) return
  emit('select-overlay', view.id)
  openMenuAt(event, [
    { key: 'seek', label: t('edit.overlayGoto'), action: () => emit('seek', Math.round(view.startMs)) },
    { separator: true, key: 'sep', label: '' },
    { key: 'delete', label: t('edit.overlayDelete'), danger: true, action: () => emit('remove-overlay', view.id) },
  ])
}

// 片段菜单项：右键、长按与工具栏「更多」共用同一套动作与禁用条件
function clipMenuItems(view) {
  return frameMenuItems(view)
}

function openClipMenu(event, view) {
  if (props.readonly) return
  emit('select-clip', view.clip_id)
  openMenuAt(event, clipMenuItems(view))
}

// 工具栏「更多」：用按钮矩形定位选中片段的同一菜单
function openSelectedClipMenu(event) {
  if (!props.selectedClipId || props.readonly) return
  const view = clipViews.value.find((item) => item.clip_id === props.selectedClipId)
  if (!view) return
  const rect = event.currentTarget.getBoundingClientRect()
  menu.value = { items: clipMenuItems(view), x: rect.left, y: rect.bottom + 4 }
}

const { onPointerDown: onClipLongPressDown, onContextMenu: onClipLongPressContextMenu, cancel: cancelClipLongPress } = useLongPress({
  onTrigger: (view, event) => {
    if (props.readonly) return
    // 长按替代拖拽：清空拖拽态与挂起态并释放捕获，按原始指针坐标打开同一片段菜单
    clearPendingClipDrag()
    releaseDragPointer()
    drag.value = null
    snapLine.value = null
    emit('select-clip', view.clip_id)
    menu.value = { items: clipMenuItems(view), x: event.clientX, y: event.clientY }
  },
})

function onClipPointerDown(event, view) {
  // 双指手势中的第二指落在片段上：不选中、不建挂起拖拽
  if (pinching.value) return
  onClipLongPressDown(event, view)
  // 触控按下不阻断默认行为、不立即建拖拽：先选中并挂起，位移超过 8px 才在 pointermove 里接管
  if (event.pointerType === 'touch') {
    emit('select-clip', view.clip_id)
    // M7：只读态触控只选中，不建立挂起拖拽
    if (props.readonly) return
    pendingClipDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      view,
      sourceEl: event.currentTarget,
    }
    return
  }
  startDrag(event, 'move', { clipId: view.clip_id })
}

function onClipContextMenu(event, view) {
  onClipLongPressContextMenu(event)
  openClipMenu(event, view)
}

// 转场库：工具栏按选中片段/播放头找交界，时间线转场块按自身两端点定位（emit 给工作台）
function planTransition(fromClipId, toClipId) {
  return props.plan.transitions.find(
    (item) => item.fromClipId === fromClipId && item.toClipId === toClipId,
  ) ?? null
}

function transitionLabelKey(transition) {
  const type = planTransition(transition.from_clip_id, transition.to_clip_id)?.type
  return TRANSITION_TYPES.find((option) => option.value === type)?.labelKey
    ?? 'edit.transitionDissolve'
}

function openTransitionPicker() {
  const from = props.selectedClipId || clipIdAt(props.currentMs)
  const index = props.plan.clips.findIndex((clip) => clip.id === from)
  const to = index >= 0 ? props.plan.clips[index + 1]?.id ?? '' : ''
  emit('open-transition-picker', { fromClipId: from || '', toClipId: to || '' })
}

function subtitleMenuItems() {
  // 切换项文案按当前状态在 subtitleShow / subtitleHide 之间取值（edit.subtitleToggle 通用键由 Task 23 复用）
  return [
    { key: 'new', label: t('edit.subtitleNew'), action: () => emit('open-subtitles') },
    { key: 'toggle', label: props.showSubtitles ? t('edit.subtitleHide') : t('edit.subtitleShow'), action: () => emit('toggle-subtitles') },
    { key: 'list', label: t('edit.subtitleOpenList'), action: () => emit('open-subtitles') },
  ]
}

function openMarkerMenu(event, marker) {
  if (props.readonly) return
  openMenuAt(event, [
    { key: 'seek', label: t('edit.markerGoto'), action: () => emit('seek', marker.atMs) },
    { separator: true, key: 'sep', label: '' },
    { key: 'delete', label: t('edit.markerDelete'), danger: true, action: () => emit('delete-marker', marker.id) },
  ])
}

function openCueMenu(event, cue) {
  if (props.readonly) return
  emit('select-cue', cue.id)
  const next = props.plan.subtitles[props.plan.subtitles.findIndex((item) => item.id === cue.id) + 1]
  openMenuAt(event, [
    { key: 'edit', label: t('edit.cueEdit'), action: () => emit('cue-op', { kind: 'edit', cueId: cue.id }) },
    { key: 'split', label: t('edit.cueSplit'), disabled: cue.endMs - cue.startMs < 200, action: () => emit('cue-op', { kind: 'split', cueId: cue.id }) },
    { key: 'merge-next', label: t('edit.cueMerge'), disabled: !next, reason: next ? undefined : t('edit.cueMergeNone'), action: () => emit('cue-op', { kind: 'merge-next', cueId: cue.id }) },
    { separator: true, key: 'sep', label: '' },
    { key: 'delete', label: t('edit.delete'), danger: true, action: () => emit('cue-op', { kind: 'delete', cueId: cue.id }) },
  ])
}

function removeSelected() {
  if (props.selectedClipId) emit('remove-clip', props.selectedClipId)
}

// 适应画幅：把缩放调到整条成片刚好铺满可视宽度（供 EditWorkbench 通过 ref 调用）
function zoomToFit() {
  const width = scrollRef.value?.clientWidth ?? 0
  if (width <= 0) return
  zoom.value = Math.max(0.02, Math.min(8, (width - pad * 2) / Math.max(1, Number(props.layout.duration_ms) || 1)))
}

defineExpose({ zoomToFit })

onMounted(() => {
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
  // 指针在窗口外松开时收不到 pointerup，窗口失焦同样终止拖拽，避免残留预览
  window.addEventListener('blur', onPointerCancel)
  // 捕获阶段旁路监听触控指针，供双指缩放识别（不阻断时间线原生滚动）
  window.addEventListener('pointerdown', onPinchPointerDown, { capture: true })
  window.addEventListener('pointermove', onPinchPointerMove, { capture: true })
  window.addEventListener('pointerup', onPinchPointerUp, { capture: true })
})
onBeforeUnmount(() => {
  clearPendingClipDrag()
  releaseDragPointer()
  cancelClipLongPress()
  pinch.cancel()
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  window.removeEventListener('blur', onPointerCancel)
  window.removeEventListener('pointerdown', onPinchPointerDown, true)
  window.removeEventListener('pointermove', onPinchPointerMove, true)
  window.removeEventListener('pointerup', onPinchPointerUp, true)
})
</script>

<style scoped>
.ed-timeline {
  flex: 0 0 auto; min-height: 226px; display: flex; flex-direction: column; gap: 6px;
  padding: 8px 10px 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-1);
}
.ed-timeline-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 11px; color: var(--text-3); }
.ed-timeline-head b { color: var(--text-1); font-size: 12px; }
.ed-timeline-tools { margin-left: auto; display: inline-flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 4px; }
.ed-tool {
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2);
  color: var(--text-2); cursor: pointer;
}
.ed-tool.is-text { width: auto; padding: 0 8px; font-size: 11px; white-space: nowrap; }
.ed-tool-more { display: none; }
.ed-tools-sep { width: 1px; height: 16px; margin: 0 3px; background: var(--border); }
.ed-tool:hover { color: var(--text-0); border-color: var(--accent); }
.ed-tool.is-on { color: var(--accent-text); border-color: var(--accent); background: var(--accent-bg); }
.ed-tool:disabled { opacity: .4; cursor: not-allowed; }
.ed-zoom { min-width: 36px; text-align: center; font-size: 10px; color: var(--text-3); }
.ed-timeline-body { flex: 1; min-height: 0; display: flex; gap: 6px; }
.ed-tl-heads { flex: 0 0 46px; display: flex; flex-direction: column; font-size: 9px; color: var(--text-3); }
.ed-head { display: flex; align-items: center; border-bottom: 1px solid transparent; }
.ed-head.is-ruler { height: 24px; }
.ed-head:nth-child(2) { height: 28px; }
.ed-head:nth-child(3) { height: 60px; }
.ed-head:nth-child(4) { height: 34px; }
.ed-head:nth-child(5) { height: 22px; }
.ed-tl-scroll {
  flex: 1; min-width: 0; overflow-x: auto; overflow-y: hidden;
  touch-action: pan-x; overscroll-behavior-x: contain;
}
.ed-tl-stage { position: relative; height: 170px; user-select: none; }
.ed-tl-ruler {
  position: absolute; inset: 0 0 auto; height: 24px; cursor: ew-resize;
  border-bottom: 1px solid var(--border); background: var(--bg-2);
  touch-action: none;
}
.ed-tick {
  position: absolute; top: 5px; transform: translateX(-50%);
  font-size: 9px; color: var(--text-3); white-space: nowrap; pointer-events: none;
}
.ed-tl-track { position: absolute; left: 0; right: 0; border-radius: 6px; background: var(--bg-2); }
.ed-tl-track.is-overlay { top: 24px; height: 28px; background: color-mix(in srgb, var(--bg-2) 82%, transparent); }
.ed-tl-track.is-video { top: 52px; height: 60px; }
.ed-tl-track.is-subtitle { top: 112px; height: 34px; background: color-mix(in srgb, var(--bg-2) 82%, transparent); }
.ed-tl-track.is-audio { top: 146px; height: 22px; }
.ed-tl-overlay {
  position: absolute; top: 3px; bottom: 3px; min-width: 6px; overflow: hidden;
  display: flex; align-items: center; padding: 0 8px; border-radius: 5px;
  border: 1px solid color-mix(in srgb, #a78bfa 55%, transparent);
  background: color-mix(in srgb, #a78bfa 22%, var(--bg-1));
  color: var(--text-0); cursor: grab;
  touch-action: none;
}
.ed-tl-overlay.is-image { border-color: color-mix(in srgb, #38bdf8 55%, transparent); background: color-mix(in srgb, #38bdf8 22%, var(--bg-1)); }
.ed-tl-overlay.is-text { border-color: color-mix(in srgb, #d7a24a 55%, transparent); background: color-mix(in srgb, #d7a24a 22%, var(--bg-1)); }
.ed-tl-overlay:hover { filter: brightness(1.15); }
.ed-tl-overlay.is-selected { box-shadow: 0 0 0 1px #a78bfa; }
.ed-tl-overlay.is-image.is-selected { box-shadow: 0 0 0 1px #38bdf8; }
.ed-tl-overlay.is-text.is-selected { box-shadow: 0 0 0 1px #d7a24a; }
.ed-tl-overlay.is-dragging { opacity: .82; cursor: grabbing; z-index: 4; }
.ed-tl-overlay .ed-trim { background: color-mix(in srgb, #a78bfa 55%, transparent); touch-action: none; }
.ed-tl-overlay.is-image .ed-trim { background: color-mix(in srgb, #38bdf8 55%, transparent); }
.ed-tl-overlay.is-text .ed-trim { background: color-mix(in srgb, #d7a24a 55%, transparent); }
.ed-tl-clip {
  position: absolute; top: 3px; bottom: 3px; min-width: 4px; overflow: hidden;
  display: flex; flex-direction: column; justify-content: space-between;
  padding: 4px 8px; border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
  border-radius: 6px; background: color-mix(in srgb, var(--accent) 16%, var(--bg-1));
  color: var(--text-0); cursor: grab;
  touch-action: none;
}
.ed-tl-clip:hover { border-color: var(--accent); }
.ed-tl-clip.is-selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ed-tl-clip.is-dragging { opacity: .82; cursor: grabbing; z-index: 4; }
.ed-tl-clip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; font-weight: 600; pointer-events: none; }
.ed-tl-clip-time { font-size: 9px; color: var(--text-2); pointer-events: none; }
.ed-trim {
  position: absolute; top: 0; bottom: 0; width: 7px; cursor: ew-resize;
  background: color-mix(in srgb, var(--accent) 55%, transparent);
  touch-action: none;
}
.ed-trim.is-start { left: 0; border-radius: 6px 0 0 6px; }
.ed-trim.is-end { right: 0; border-radius: 0 6px 6px 0; }
.ed-tl-cue {
  position: absolute; top: 3px; bottom: 3px; min-width: 3px; overflow: hidden;
  display: flex; align-items: center; padding: 0 6px; border-radius: 4px;
  border: 1px solid color-mix(in srgb, #d7a24a 55%, transparent);
  background: color-mix(in srgb, #d7a24a 20%, var(--bg-1));
  color: var(--text-0); font-size: 9px; white-space: nowrap; cursor: ew-resize;
  touch-action: none;
}
.ed-tl-cue.is-follow { border-style: dashed; }
.ed-tl-cue.is-selected { box-shadow: 0 0 0 1px #d7a24a; }
.ed-tl-audio-clip {
  position: absolute; top: 1px; height: 20px; overflow: hidden;
  display: flex; align-items: center;
  border-radius: 4px; border: 1px solid color-mix(in srgb, var(--success) 40%, transparent);
  background: color-mix(in srgb, var(--success) 10%, var(--bg-1));
}
.ed-tl-audio-clip.is-muted { border-style: dashed; opacity: .7; }
.ed-tl-audio-flags {
  position: absolute; right: 2px; top: 2px; z-index: 1;
  max-width: calc(100% - 4px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 0 4px; border-radius: 3px; font-size: 8px; line-height: 12px;
  background: color-mix(in srgb, var(--bg-1) 85%, transparent);
  color: var(--text-2); pointer-events: none;
}
.ed-tl-transition {
  position: absolute; top: 73px; transform: translateX(-50%); z-index: 3;
  display: inline-flex; align-items: center; gap: 1px; height: 18px; padding: 0 3px;
  border-radius: 5px; background: var(--bg-0); border: 1px solid var(--border);
  color: var(--text-2); font-size: 10px; cursor: pointer;
}
.ed-tl-transition:hover { border-color: var(--accent); color: var(--text-0); }
.ed-tl-transition button { cursor: pointer; }
.ed-tl-transition button {
  width: 14px; height: 14px; padding: 0; border: 0; border-radius: 3px;
  background: transparent; color: var(--text-3); cursor: pointer; line-height: 1;
}
.ed-tl-transition button:hover { background: var(--bg-hover); color: var(--action-danger); }
.ed-tl-marker {
  position: absolute; top: 22px; transform: translateX(-50%); z-index: 3;
  width: 12px; height: 12px; cursor: pointer;
}
.ed-tl-marker-flag {
  display: block; width: 8px; height: 8px; margin: 2px;
  background: var(--marker-color, #f59e0b);
  transform: rotate(45deg);
  border-radius: 1px;
  box-shadow: 0 0 0 1px var(--bg-0);
}
.ed-tl-marker:hover .ed-tl-marker-flag { transform: rotate(45deg) scale(1.25); }
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

@media (hover: none) and (pointer: coarse) {
  .ed-tool { min-width: 44px; min-height: 44px; }
  .ed-tool-more { display: inline-flex; min-width: 44px; min-height: 44px; align-items: center; justify-content: center; }
  .ed-trim::after {
    content: ''; position: absolute; top: 0; bottom: 0; left: 50%;
    width: 44px; transform: translateX(-50%);
  }
  /* 标尺下沿的 44px 命中区必须盖住下方轨道背景才可点；overlay 片段优先于标尺接收 */
  .ed-tl-ruler { z-index: 1; }
  .ed-tl-ruler::after {
    content: ''; position: absolute; left: 0; right: 0; top: 0; height: 44px;
  }
  .ed-tl-overlay { z-index: 2; }
  /* 字幕块用透明 ::after 上下外扩 5px 命中区，不改变可见尺寸（基础 top/bottom 保持 3px） */
  .ed-tl-cue { overflow: visible; }
  .ed-tl-cue > span { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .ed-tl-cue::after {
    content: ''; position: absolute; left: 0; right: 0; top: -5px; bottom: -5px;
  }
}

@media (max-width: 900px) {
  /* 片段轨道加高到 62px：上下各留 3px 后仍保证 56px 可点高度；下方轨道整体顺延，避免重叠 */
  .ed-tl-track.is-video { height: 62px; }
  .ed-tl-track.is-subtitle { top: 114px; }
  .ed-tl-track.is-audio { top: 148px; }
  .ed-tl-stage { height: 172px; }
  .ed-tl-transition { top: 74px; }
  .ed-head:nth-child(3) { height: 62px; }
}

@media (max-width: 1180px) and (hover: none) and (pointer: coarse) {
  /* 双指缩放期间禁止滚动容器原生手势，避免与 pinch 计算抢滚动 */
  .ed-tl-scroll.is-pinching { touch-action: none; }
  /* 播放头桌面仍不接收指针；触控下开放 44px 命中区便于拖动定位 */
  .ed-tl-playhead { pointer-events: auto; touch-action: none; }
  .ed-tl-playhead::after {
    content: ''; position: absolute; top: 0; bottom: 0; left: -21px; width: 44px;
  }
}
</style>
