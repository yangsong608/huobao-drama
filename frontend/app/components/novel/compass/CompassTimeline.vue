<template>
  <div v-if="chapters.length" class="compass-timeline">
    <div class="timeline-controls">
      <button
        type="button"
        class="icon-btn"
        :disabled="playing || chapters.length < 2"
        :title="t('novels.compass.timeline.prev')"
        @click="stepBack"
      >
        <SkipBack :size="14" />
      </button>
      <button
        type="button"
        class="icon-btn play"
        :disabled="chapters.length < 2"
        :title="playing ? t('novels.compass.timeline.pause') : t('novels.compass.timeline.play')"
        @click="togglePlay"
      >
        <Pause v-if="playing" :size="15" />
        <Play v-else :size="15" />
      </button>
      <button
        type="button"
        class="icon-btn"
        :disabled="playing || chapters.length < 2"
        :title="t('novels.compass.timeline.next')"
        @click="stepForward"
      >
        <SkipForward :size="14" />
      </button>
    </div>

    <div class="timeline-track">
      <input
        type="range"
        :min="0"
        :max="maxValue"
        step="1"
        :value="modelValue"
        :disabled="playing || maxValue === 0"
        :aria-label="t('novels.compass.timeline.label')"
        @input="onInput"
      />
      <div class="timeline-marks" aria-hidden="true">
        <span
          v-for="chapter in chapters"
          :key="chapter"
          class="mark"
          :class="{ active: chapter === modelValue }"
          :style="{ left: `${maxValue ? (chapter / maxValue) * 100 : 0}%` }"
          :title="chapterLabel(chapter)"
          @click="pick(chapter)"
        ></span>
      </div>
    </div>

    <div class="timeline-meta">
      <span class="chapter-chip">{{ chapterLabel(modelValue) }}</span>
      <span v-if="usingEarlier" class="using-hint">
        {{ t('novels.compass.timeline.usingEarlier', { n: effectiveChapter }) }}
      </span>
      <span class="snapshot-count">{{ t('novels.compass.timeline.snapshots', { n: chapters.length }) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pause, Play, SkipBack, SkipForward } from 'lucide-vue-next'
import { getSnapshotChapters, type GraphSnapshot } from '~/utils/novel-graph'

const props = defineProps<{
  snapshots: Record<string, GraphSnapshot>
  maxChapter?: number
  modelValue: number
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: number): void
}>()

const { t } = useI18n()
const playing = ref(false)
let playTimer: ReturnType<typeof setInterval> | null = null

const chapters = computed(() => getSnapshotChapters(props.snapshots))
const maxValue = computed(() => {
  if (props.maxChapter && props.maxChapter > 0) return props.maxChapter
  return chapters.value.length ? chapters.value[chapters.value.length - 1] : 0
})
const effectiveChapter = computed(() => {
  let best = 0
  for (const chapter of chapters.value) {
    if (chapter <= props.modelValue) best = chapter
    else break
  }
  return best
})
const usingEarlier = computed(() =>
  chapters.value.length > 0
  && props.modelValue > 0
  && !chapters.value.includes(props.modelValue),
)

function chapterLabel(chapter: number): string {
  return chapter === 0
    ? t('novels.compass.timeline.baseline')
    : t('novels.compass.timeline.chapter', { n: chapter })
}

function pick(chapter: number) {
  if (playing.value) return
  emit('update:modelValue', chapter)
}

function onInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) emit('update:modelValue', value)
}

function stepBack() {
  const previous = chapters.value.filter((chapter) => chapter < props.modelValue)
  emit('update:modelValue', previous.length ? previous[previous.length - 1] : chapters.value[0] ?? 0)
}

function stepForward() {
  const next = chapters.value.find((chapter) => chapter > props.modelValue)
  emit('update:modelValue', next ?? chapters.value[chapters.value.length - 1] ?? 0)
}

function stopPlay() {
  playing.value = false
  if (playTimer) {
    clearInterval(playTimer)
    playTimer = null
  }
}

function startPlay() {
  if (chapters.value.length < 2) return
  playing.value = true
  let index = chapters.value.findIndex((chapter) => chapter >= props.modelValue)
  if (index === -1) index = 0
  playTimer = setInterval(() => {
    index += 1
    if (index >= chapters.value.length) {
      stopPlay()
      return
    }
    emit('update:modelValue', chapters.value[index])
  }, 1500)
}

function togglePlay() {
  if (playing.value) stopPlay()
  else startPlay()
}

watch(() => props.snapshots, () => {
  stopPlay()
  if (props.modelValue > maxValue.value) emit('update:modelValue', 0)
}, { deep: true })

onBeforeUnmount(stopPlay)
</script>

<style scoped>
.compass-timeline {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-hover);
}
.timeline-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.icon-btn:hover:not(:disabled) {
  border-color: var(--border);
  color: var(--text-0);
}
.icon-btn.play {
  width: 30px;
  height: 30px;
  border-color: var(--border);
}
.icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.timeline-track {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  min-width: 120px;
}
.timeline-track input[type='range'] {
  width: 100%;
  accent-color: var(--novel-accent);
  cursor: pointer;
}
.timeline-track input[type='range']:disabled {
  cursor: default;
}
.timeline-marks {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 50%;
  height: 0;
  pointer-events: none;
}
.mark {
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--text-3);
  transform: translate(-50%, -50%);
  pointer-events: auto;
  cursor: pointer;
  opacity: 0.8;
}
.mark.active {
  background: var(--novel-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--novel-accent) 22%, transparent);
}
.timeline-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.chapter-chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--novel-accent) 12%, transparent);
  color: var(--novel-accent);
  font-size: 11px;
}
.using-hint {
  color: var(--text-2);
}
.snapshot-count {
  color: var(--text-3);
}
@media (max-width: 760px) {
  .compass-timeline {
    flex-wrap: wrap;
  }
  .timeline-track {
    order: 3;
    width: 100%;
    flex-basis: 100%;
  }
  .timeline-meta {
    margin-left: auto;
  }
}
</style>
