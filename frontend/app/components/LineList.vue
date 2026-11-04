<template>
  <div ref="viewport" class="line-list" @scroll="onScroll">
    <div v-if="lines.length" class="line-spacer" :style="{ height: `${totalHeight}px` }">
      <article
        v-for="row in visibleRows"
        :key="row.line.id"
        :class="['line-row', `is-${row.line.status}`, row.line.stale && 'is-stale']"
        :style="{ transform: `translateY(${row.index * ROW_HEIGHT}px)` }"
      >
        <div class="line-head">
          <span class="line-no">#{{ row.line.lineNo }}</span>
          <span v-if="row.line.storyboardNumber" class="line-shot">{{ t('workbench.shot', { n: row.line.storyboardNumber }) }}</span>
          <span class="line-speaker">{{ row.line.speakerName || t('workbench.narrator') }}</span>
          <span v-if="row.line.speakerType !== 'dialogue'" class="line-kind">
            {{ row.line.speakerType === 'inner' ? t('workbench.inner') : t('workbench.narration') }}
          </span>
          <span class="line-dur">{{ row.line.audioDurationMs ? `${(row.line.audioDurationMs / 1000).toFixed(1)}s` : '—' }}</span>
          <span v-if="row.line.overflowMs && row.line.overflowMs > 0" class="line-warn">+{{ (row.line.overflowMs / 1000).toFixed(1) }}s</span>
          <span v-if="row.line.stale" class="line-chip is-stale">{{ t('workbench.stale') }}</span>
          <span v-if="row.line.needsReview" class="line-chip is-review">{{ t('workbench.review') }}</span>
          <span v-if="row.line.status === 'failed'" class="line-chip is-failed">{{ t('workbench.failed') }}</span>
          <span v-if="missingVoice(row.line)" class="line-chip is-warn">{{ t('workbench.issueNoVoice') }}</span>
          <span v-if="longText(row.line)" class="line-chip is-warn">{{ t('workbench.issueLong') }}</span>
          <span v-if="emptyLine(row.line)" class="line-chip is-danger">{{ t('workbench.issueEmpty') }}</span>
        </div>

        <textarea
          v-if="editingId === row.line.id"
          v-model="editingText"
          class="line-edit"
          rows="2"
          :disabled="saving"
          @blur="commit(row.line)"
          @keydown.enter.exact.prevent="commit(row.line)"
          @keydown.esc="editingId = null"
        />
        <p v-else class="line-text" :title="row.line.text" @dblclick="beginEdit(row.line)">{{ row.line.text }}</p>

        <div class="line-actions">
          <button v-if="row.line.audioUrl" class="line-mini" type="button" @click="emit('play', row.line)">{{ t('workbench.play') }}</button>
          <button class="line-mini" type="button" :disabled="busy" @click="emit('synthesize', row.line)">{{ t('workbench.resynthesize') }}</button>
          <button class="line-mini" type="button" @click="emit('locate', row.line)">{{ t('workbench.locate') }}</button>
          <button class="line-mini" type="button" @click="beginEdit(row.line)">{{ t('common.edit') }}</button>
          <span v-if="row.line.error" class="line-error" :title="row.line.error">{{ row.line.error }}</span>
        </div>
      </article>
    </div>
    <p v-else class="line-empty">{{ emptyText }}</p>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { StoryboardLine } from '~/composables/useApi'

const props = withDefaults(defineProps<{
  lines: StoryboardLine[]
  busy?: boolean
  saving?: boolean
  emptyText?: string
  showIssues?: boolean
  missingVoiceCharacterIds?: number[]
  narratorMissingVoice?: boolean
}>(), {
  busy: false,
  saving: false,
  emptyText: '',
  showIssues: false,
  missingVoiceCharacterIds: () => [],
  narratorMissingVoice: false,
})

const emit = defineEmits<{
  play: [line: StoryboardLine]
  synthesize: [line: StoryboardLine]
  locate: [line: StoryboardLine]
  save: [line: StoryboardLine, text: string]
}>()

const { t } = useI18n()
const ROW_HEIGHT = 96
const OVERSCAN = 6

const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(360)
const editingId = ref<number | null>(null)
const editingText = ref('')
let observer: ResizeObserver | null = null

const totalHeight = computed(() => props.lines.length * ROW_HEIGHT)
const startIndex = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN))
const visibleRows = computed(() => {
  const count = Math.ceil(viewportHeight.value / ROW_HEIGHT) + OVERSCAN * 2
  return props.lines
    .slice(startIndex.value, startIndex.value + count)
    .map((line, i) => ({ line, index: startIndex.value + i }))
})

function onScroll(event: Event) {
  scrollTop.value = (event.target as HTMLElement).scrollTop
}

function beginEdit(line: StoryboardLine) {
  editingId.value = line.id
  editingText.value = line.text
}

function commit(line: StoryboardLine) {
  if (editingId.value !== line.id) return
  const text = editingText.value.trim()
  editingId.value = null
  if (!text || text === line.text) return
  emit('save', line, text)
}

function missingVoice(line: StoryboardLine) {
  if (!props.showIssues) return false
  if (line.speakerType !== 'dialogue') return props.narratorMissingVoice
  return Boolean(line.characterId && props.missingVoiceCharacterIds.includes(line.characterId))
}
function longText(line: StoryboardLine) {
  return props.showIssues && [...line.text].length > 80
}
function emptyLine(line: StoryboardLine) {
  return props.showIssues && !line.text.trim()
}

onMounted(() => {
  if (!viewport.value) return
  viewportHeight.value = viewport.value.clientHeight || 360
  observer = new ResizeObserver((entries) => {
    const height = entries[0]?.contentRect?.height
    if (height) viewportHeight.value = height
  })
  observer.observe(viewport.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})
</script>

<style scoped>
.line-list {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
.line-spacer { position: relative; width: 100%; }
.line-row {
  position: absolute;
  inset: 0 0 auto 0;
  height: calc(96px - 6px);
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-1, #fff);
  box-sizing: border-box;
}
.line-row.is-failed { border-color: rgba(217, 83, 79, .4); }
.line-row.is-stale { background: rgba(196, 138, 27, .06); }
.line-head { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--text-3); flex-wrap: nowrap; overflow: hidden; }
.line-no { font-variant-numeric: tabular-nums; }
.line-shot { color: var(--text-3); }
.line-speaker { color: var(--text-2); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.line-kind { font-size: 10px; padding: 0 5px; border-radius: 4px; background: rgba(127, 127, 127, .12); white-space: nowrap; }
.line-dur { margin-left: auto; font-variant-numeric: tabular-nums; }
.line-warn { color: #c48a1b; }
.line-chip { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: rgba(127, 127, 127, .14); color: var(--text-2); white-space: nowrap; }
.line-chip.is-stale, .line-chip.is-review { color: #c48a1b; background: rgba(196, 138, 27, .16); }
.line-chip.is-failed { color: #d9534f; background: rgba(217, 83, 79, .14); }
.line-chip.is-warn { color: #c48a1b; background: rgba(196, 138, 27, .16); }
.line-chip.is-danger { color: #d9534f; background: rgba(217, 83, 79, .14); }
.line-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-1);
  cursor: text;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.line-edit {
  width: 100%;
  height: 44px;
  resize: none;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.5;
  padding: 4px 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-2, transparent);
  color: var(--text-1);
  box-sizing: border-box;
}
.line-actions { display: flex; align-items: center; gap: 10px; min-height: 14px; }
.line-mini { background: none; border: none; padding: 0; font: inherit; font-size: 11px; color: var(--text-3); cursor: pointer; }
.line-mini:hover { color: var(--accent, #2b7bd6); }
.line-mini:disabled { opacity: .45; cursor: default; }
.line-error { margin-left: auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d9534f; font-size: 11px; }
.line-empty { color: var(--text-3); font-size: 12px; text-align: center; padding: 24px 0; }
</style>
