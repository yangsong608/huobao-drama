<template>
  <div class="ed-sub-overlay" :style="{ width: `${containerWidth}px`, height: `${containerHeight}px` }">
    <div
      v-for="cue in activeCues"
      :key="cue.id"
      class="ed-sub-cue"
      :class="{ 'is-selected': cue.id === selectedCueId, 'is-out': cue.outOfBounds }"
      :style="cue.css"
      @pointerdown.stop="$emit('select', cue.id)"
    >{{ cue.text }}</div>
    <div v-if="showSafeArea" class="ed-sub-safeArea" :style="safeStyle"></div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { resolveCueAppearance } from '~/utils/edit-plan'

// 字幕覆盖层：绝对定位在预览画面之上；容器 pointer-events 穿透，
// 仅字幕本身可点击选中，其余点击落到视频上。
const props = defineProps({
  plan: { type: Object, required: true },
  layout: { type: Object, default: null },
  project: { type: Object, default: null },
  currentMs: { type: Number, default: 0 },
  containerWidth: { type: Number, default: 0 },
  containerHeight: { type: Number, default: 0 },
  selectedCueId: { type: String, default: '' },
  safeAreaPct: { type: Number, default: null },
  showSafeArea: { type: Boolean, default: false },
})
defineEmits(['select'])

const safePct = computed(() => {
  if (props.safeAreaPct !== null && Number.isFinite(Number(props.safeAreaPct))) {
    return Math.max(0, Number(props.safeAreaPct))
  }
  return Math.max(0, Number(props.plan?.project?.subtitleSafeAreaPct ?? 8))
})

const safeStyle = computed(() => ({
  left: `${safePct.value}%`,
  top: `${safePct.value}%`,
  right: `${safePct.value}%`,
  bottom: `${safePct.value}%`,
}))

const activeCues = computed(() => {
  const width = Number(props.plan?.project?.width) || 1080
  const height = Number(props.plan?.project?.height) || 1920
  const project = props.project ?? props.plan?.project ?? null
  const scale = Number(props.containerWidth) > 0
    ? Number(props.containerWidth) / Math.max(1, width)
    : 0
  if (!scale) return []
  return (props.plan?.subtitles ?? [])
    .filter((cue) => props.currentMs >= cue.startMs && props.currentMs < cue.endMs)
    .map((cue) => {
      const a = resolveCueAppearance(cue, project)
      const anchorX = ((Number(a.xPct) || 0) / 100) * props.containerWidth
      const anchorY = ((Number(a.yPct) || 0) / 100) * props.containerHeight
      const transform = {
        left: 'translate(0, -50%)',
        center: 'translate(-50%, -50%)',
        right: 'translate(-100%, -50%)',
      }[a.align] ?? 'translate(-50%, -50%)'
      const background = a.backgroundColor
        ? hexWithAlpha(a.backgroundColor, a.backgroundOpacity)
        : 'transparent'
      const out = (Number(a.xPct) || 0) < safePct.value || (Number(a.xPct) || 0) > 100 - safePct.value
        || (Number(a.yPct) || 0) < safePct.value || (Number(a.yPct) || 0) > 100 - safePct.value
      return {
        id: cue.id,
        text: cue.text,
        outOfBounds: out,
        css: {
          left: `${anchorX}px`,
          top: `${anchorY}px`,
          transform,
          fontFamily: `"${a.fontFamily}", sans-serif`,
          fontSize: `${(Number(a.fontSize) || 48) * scale}px`,
          color: a.color,
          WebkitTextStroke: Number(a.strokeWidth) > 0
            ? `${Number(a.strokeWidth) * scale * 0.5}px ${a.strokeColor}`
            : 'none',
          background,
        },
      }
    })
})

function hexWithAlpha(hex, opacity) {
  const value = String(hex || '#000000').replace('#', '').slice(0, 6).padEnd(6, '0')
  const alpha = Math.round(Math.max(0, Math.min(100, Number(opacity) || 0)) * 2.55)
    .toString(16).padStart(2, '0')
  return `#${value}${alpha}`
}
</script>

<style scoped>
.ed-sub-overlay {
  position: absolute; inset: 0; z-index: 3; overflow: hidden;
  pointer-events: none;
}
.ed-sub-cue {
  position: absolute; max-width: 92%; white-space: pre-wrap; text-align: center;
  line-height: 1.25; padding: 2px 6px; border-radius: 4px;
  pointer-events: auto; cursor: pointer;
}
.ed-sub-cue.is-selected { box-shadow: 0 0 0 2px var(--accent); }
.ed-sub-cue.is-out { outline: 2px solid var(--warning); }
.ed-sub-safeArea {
  position: absolute; border: 1px dashed color-mix(in srgb, var(--warning) 70%, transparent);
  pointer-events: none;
}
</style>
