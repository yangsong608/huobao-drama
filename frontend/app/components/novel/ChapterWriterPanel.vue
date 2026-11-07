<template>
  <section class="novel-panel">
    <header class="panel-head">
      <div>
        <h2>{{ t('novels.writer.title') }}</h2>
        <p v-if="chapterBlueprint" class="chapter-summary">{{ chapterBlueprint.summary }}</p>
      </div>
      <div class="panel-actions">
        <button v-if="running" type="button" class="btn btn-ghost" @click="cancel">
          {{ t('novels.writer.cancel') }}
        </button>
        <template v-else>
          <button type="button" class="btn btn-ghost" :disabled="saving" @click="save()">
            {{ saveState === 'saving' ? t('novels.writer.saving') : t('novels.writer.save') }}
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            :disabled="saving || !content.trim() || (isFinal && !draftConfirmed)"
            @click="finalize"
          >
            {{ t('novels.writer.finalize') }}
          </button>
          <button type="button" class="btn btn-primary" @click="generate">
            {{ hasSavedContent ? t('novels.writer.regenerate') : t('novels.writer.generate') }}
          </button>
        </template>
        <button
          type="button"
          class="btn btn-ghost"
          :aria-pressed="focusReading ? 'true' : 'false'"
          :title="focusReading ? t('novels.writer.exitFocusReading') : t('novels.writer.focusReading')"
          @click="emit('toggle-focus-reading')"
        >
          <Minimize2 v-if="focusReading" :size="14" :stroke-width="1.8" />
          <Maximize2 v-else :size="14" :stroke-width="1.8" />
          {{ focusReading ? t('novels.writer.exitFocusReading') : t('novels.writer.focusReading') }}
        </button>
      </div>
    </header>

    <div class="writer-meta">
      <label>
        <span>{{ t('novels.writer.chapterSelect') }}</span>
        <select class="input" :value="chapterNo" :disabled="running" @change="onChapterChange">
          <option v-for="no in chapterOptions" :key="no" :value="no">
            {{ t('novels.blueprint.chapter', { n: no }) }}
          </option>
        </select>
      </label>
      <div class="seg mode-seg">
        <button
          type="button"
          :class="['seg-item', { on: mode === 'read' }]"
          :disabled="running"
          @click="switchMode('read')"
        >
          {{ t('novels.writer.modeRead') }}
        </button>
        <button
          type="button"
          :class="['seg-item', { on: mode === 'edit' }]"
          :disabled="running"
          @click="switchMode('edit')"
        >
          {{ t('novels.writer.modeEdit') }}
        </button>
      </div>
      <span v-if="isFinal" class="tag tag-success">{{ t('novels.writer.finalBadge') }}</span>
      <span class="word-count">{{ t('novels.writer.wordCount', { n: wordCount }) }}</span>
      <span v-if="running" class="lock-hint">{{ t('novels.writer.locked') }}</span>
      <span v-else-if="saveState === 'saving'" class="save-state">{{ t('novels.writer.saving') }}</span>
      <span v-else-if="dirty" class="save-state is-dirty">{{ t('novels.writer.unsaved') }}</span>
      <span v-else-if="saveState === 'saved'" class="save-state">{{ t('novels.writer.saved') }}</span>
    </div>

    <div v-if="foreshadowEnabled && relatedForeshadows.length" class="foreshadow-strip">
      <span :class="['foreshadow-strip-label', { warn: unresolvedRelated.length }]">
        {{ unresolvedRelated.length
          ? t('novels.workbench.foreshadow.unresolvedTip', { n: unresolvedRelated.length })
          : t('novels.workbench.foreshadow.relatedTitle') }}
      </span>
      <div class="foreshadow-strip-items">
        <span v-for="item in relatedForeshadows" :key="item.id" class="foreshadow-chip">
          <button type="button" class="foreshadow-chip-title" @click="emit('open-foreshadows', item.id)">
            {{ item.title }}
          </button>
          <button
            v-if="item.setup_chapter"
            type="button"
            class="foreshadow-chip-chapter"
            @click="jumpChapter(item.setup_chapter)"
          >{{ t('novels.workbench.foreshadow.jumpSetup', { n: item.setup_chapter }) }}</button>
          <button
            v-if="item.payoff_chapter"
            type="button"
            class="foreshadow-chip-chapter"
            @click="jumpChapter(item.payoff_chapter)"
          >{{ t('novels.workbench.foreshadow.jumpPayoff', { n: item.payoff_chapter }) }}</button>
        </span>
      </div>
    </div>

    <div v-if="annotationsEnabled && selection" class="annotation-quick">
      <span class="annotation-quick-quote">“{{ selectionPreview }}”</span>
      <button type="button" class="btn btn-ghost btn-sm" @click="requestAnnotation">
        {{ t('novels.workbench.annotations.add') }}
      </button>
    </div>

    <div v-if="annotationsEnabled && annotations.length" class="annotation-markers">
      <span class="annotation-markers-label">{{ t('novels.workbench.annotations.markers') }}</span>
      <button
        v-for="(annotation, index) in annotations"
        :key="annotation.id"
        type="button"
        :class="['annotation-pin', { orphaned: annotation.status === 'orphaned', resolved: annotation.status === 'resolved' }]"
        :title="annotation.quote"
        @click="locateFromMarker(annotation)"
      >
        <span class="annotation-pin-no">{{ index + 1 }}</span>
        <span class="annotation-pin-quote">{{ annotation.quote.slice(0, 12) }}</span>
      </button>
    </div>

    <p v-if="error" class="panel-error">{{ error }}</p>

    <div v-if="running" class="panel-progress">
      <div class="progress-meta">
        <span>
          {{ stage?.label || (jobKind === 'finalize'
            ? t('novels.writer.finalizing')
            : t('novels.writer.generating', { n: chapterNo })) }}
        </span>
        <span v-if="stage && stage.total">{{ stage.current }}/{{ stage.total }}</span>
      </div>
      <div class="progress"><i :style="{ width: `${percent}%` }"></i></div>
    </div>

    <div v-if="timelineWarning" class="timeline-warning">
      <span>{{ timelineWarning }}</span>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="running" @click="finalize">
        {{ t('novels.writer.atlas.refinalize') }}
      </button>
    </div>

    <textarea
      v-if="running || mode === 'edit'"
      ref="editorRef"
      v-model="content"
      :class="['textarea', 'chapter-editor', { flashed: editorFlash }]"
      :readonly="running"
      :placeholder="t('novels.writer.placeholder')"
      spellcheck="false"
      @input="onInput"
      @select="syncEditorSelection"
      @blur="flushSave"
    ></textarea>
    <div
      v-else
      ref="readerRef"
      class="chapter-reader"
      @mouseup="syncReaderSelection"
      @keyup="syncReaderSelection"
    >
      <p v-if="!chapterParagraphs.length" class="reader-empty">
        {{ t('novels.writer.readEmpty', { n: chapterNo }) }}
      </p>
      <p
        v-for="(paragraph, index) in chapterParagraphs"
        :key="index"
        :data-paragraph="index"
        :data-start="paragraph.start"
        :class="{ flashed: flashParagraph === index }"
      >{{ paragraph.text }}</p>
    </div>

    <ChapterAtlasCard
      :chapter-no="chapterNo"
      :narration="chapterBlueprint?.narration || ''"
      :events="novel.timelineEvents || []"
      :map-data="novel.worldMap"
      :max-chapter="novel.numberOfChapters"
      :disabled="running"
      :dark="isDark"
      @save-events="saveChapterEvents"
      @save-narration="saveChapterNarration"
    />

    <section class="chapter-graph-section">
      <div class="chapter-graph-head">
        <div>
          <h3>{{ t('novels.writer.graphTitle') }}</h3>
          <p v-if="graphRunning || graphStage" class="graph-stage">
            {{ graphStage || t('novels.writer.graphGenerating') }}
          </p>
        </div>
        <button
          type="button"
          class="btn btn-ghost"
          :disabled="graphRunning || running"
          @click="generateChapterGraph()"
        >
          {{ graphRunning
            ? t('novels.writer.graphGenerating')
            : chapterGraph
              ? t('novels.writer.regenerateGraph')
              : t('novels.writer.generateGraph') }}
        </button>
      </div>
      <p v-if="graphError" class="panel-error">{{ graphError }}</p>
      <ChapterRelationGraph :graph-data="chapterGraph" :height="340" />
    </section>

    <div v-if="conflicted" class="overlay" role="dialog" aria-modal="true">
      <div class="dialog" style="width: min(460px, calc(100vw - 48px))">
        <div class="dialog-head">
          <h3 class="dialog-title">{{ t('novels.writer.conflictTitle') }}</h3>
        </div>
        <div class="dialog-body conflict-body">
          <p>{{ t('novels.writer.conflictHint') }}</p>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" @click="useLatest">{{ t('novels.writer.useLatest') }}</button>
          <button type="button" class="btn btn-primary" @click="keepMine">{{ t('novels.writer.keepMine') }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Maximize2, Minimize2 } from 'lucide-vue-next'
import { camelizeKeys, useNovelStore } from '~/stores/novel'
import { novelAPI } from '~/composables/useNovelApi'
import { novelErrorText, useNovelJobStream } from '~/composables/useNovelJobStream'
import { useTheme } from '~/composables/useTheme'
import { mapError } from '~/composables/useToast'
import type { NovelSelection } from '~/composables/useNovelWorkbench'
import ChapterRelationGraph from './compass/ChapterRelationGraph.vue'
import ChapterAtlasCard from './story/ChapterAtlasCard.vue'

const props = defineProps<{
  novel: any
  initialChapterNo?: number
  annotations?: any[]
  annotationsEnabled?: boolean
  foreshadows?: any[]
  foreshadowEnabled?: boolean
  focusReading?: boolean
}>()
const emit = defineEmits<{
  (event: 'refresh'): void
  (event: 'toggle-focus-reading'): void
  (event: 'chapter-change', chapterNo: number): void
  (event: 'selection', selection: NovelSelection | null): void
  (event: 'annotate'): void
  (event: 'active-annotation', annotationId: number | null): void
  (event: 'open-foreshadows', foreshadowId: number): void
  (event: 'chapter-jump', chapterNo: number): void
}>()

const AUTOSAVE_MS = 1500

const { t } = useI18n()
const store = useNovelStore()
const { watch: watchJob, stop } = useNovelJobStream()
const { resolvedTheme } = useTheme()
const graphStream = useNovelJobStream()

const isDark = computed(() => resolvedTheme.value === 'dark')
const timelineWarning = ref('')

const graphRunning = ref(false)
const graphStage = ref('')
const graphError = ref('')
const chapterGraph = computed(() => store.chapterGraphs[String(chapterNo.value)] || null)

const chapterOptions = computed(() => {
  const numbers = new Set<number>()
  const total = Number(props.novel.numberOfChapters) || 0
  for (let no = 1; no <= total; no += 1) numbers.add(no)
  for (const chapter of props.novel.blueprintChapters || []) numbers.add(Number(chapter.number))
  if (!numbers.size) numbers.add(1)
  return [...numbers].filter((no) => Number.isFinite(no) && no > 0).sort((a, b) => a - b)
})

const chapterNo = ref<number>(Number(props.initialChapterNo) || 1)
const mode = ref<'read' | 'edit'>('read')
const editorRef = ref<HTMLTextAreaElement | null>(null)
const readerRef = ref<HTMLElement | null>(null)
const selection = ref<NovelSelection | null>(null)
const editorFlash = ref(false)
const flashParagraph = ref(-1)
let flashTimer: ReturnType<typeof setTimeout> | undefined
const content = ref('')
const savedContent = ref('')
const baseUpdatedAt = ref<string | null>(null)
const saving = ref(false)
const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
const running = ref(false)
const jobKind = ref<'chapter' | 'finalize'>('chapter')
const jobId = ref<number | null>(null)
const stage = ref<{ label: string; current: number; total: number } | null>(null)
const error = ref('')
const conflicted = ref<{ currentContent: string; currentUpdatedAt: string | null } | null>(null)
const draftConfirmed = ref(false)

let autosaveTimer: ReturnType<typeof setTimeout> | undefined
let savePromise: Promise<boolean> | null = null
let saveQueued = false

function chapterRow() {
  return (props.novel.chapters || []).find((chapter: any) => chapter.chapterNo === chapterNo.value)
}

const chapterBlueprint = computed(() => {
  return (props.novel.blueprintChapters || []).find((chapter: any) => Number(chapter.number) === chapterNo.value) || null
})
const hasSavedContent = computed(() => Boolean(chapterRow()?.content?.trim()))
const isFinal = computed(() => chapterRow()?.status === 'final')
const dirty = computed(() => content.value !== savedContent.value)
const wordCount = computed(() => content.value.replace(/\s/g, '').length)
const chapterParagraphs = computed(() => {
  const text = content.value
  const items: { text: string; start: number; end: number }[] = []
  const re = /[^\r\n]+/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const raw = match[0]
    const trimmed = raw.trim()
    if (!trimmed) continue
    const leading = raw.length - raw.trimStart().length
    items.push({ text: trimmed, start: match.index + leading, end: match.index + leading + trimmed.length })
  }
  return items
})
const selectionPreview = computed(() => {
  const quote = selection.value?.quote || ''
  return quote.length > 24 ? `${quote.slice(0, 24)}…` : quote
})
const relatedForeshadows = computed(() =>
  (props.foreshadows || [])
    .filter((item: any) =>
      Number(item.setup_chapter) === chapterNo.value || Number(item.payoff_chapter) === chapterNo.value,
    )
    .sort((a: any, b: any) => Number(a.id) - Number(b.id)),
)
const unresolvedRelated = computed(() =>
  relatedForeshadows.value.filter((item: any) => item.status !== 'paid' && item.status !== 'abandoned'),
)
const percent = computed(() => {
  if (!stage.value || !stage.value.total) return running.value ? 8 : 0
  return Math.max(0, Math.min(100, Math.round((stage.value.current / stage.value.total) * 100)))
})

watch(chapterNo, (value) => {
  clearSelection()
  emit('chapter-change', value)
})

watch(() => props.initialChapterNo, (value) => {
  const next = Number(value)
  if (!running.value && Number.isSafeInteger(next) && next > 0 && next !== chapterNo.value) {
    void switchChapter(next)
  }
})

watch(() => props.novel.chapters, () => {
  if (running.value || saving.value || dirty.value || conflicted.value) return
  loadChapter()
})

function loadChapter(resetMode = false) {
  clearSelection()
  const row = chapterRow()
  content.value = row?.content || ''
  savedContent.value = content.value
  baseUpdatedAt.value = row?.updatedAt || null
  draftConfirmed.value = false
  saveState.value = 'idle'
  conflicted.value = null
  graphError.value = ''
  timelineWarning.value = ''
  if (resetMode) mode.value = content.value.trim() ? 'read' : 'edit'
}

async function switchChapter(next: number) {
  if (running.value || conflicted.value) return
  if (dirty.value) {
    await flushSave()
    if (conflicted.value || dirty.value) return
  }
  chapterNo.value = next
  loadChapter(true)
}

async function onChapterChange(event: Event) {
  const target = event.target as HTMLSelectElement
  const next = Number(target.value)
  if (running.value || conflicted.value) {
    target.value = String(chapterNo.value)
    return
  }
  if (dirty.value) {
    await flushSave()
    if (conflicted.value || dirty.value) {
      target.value = String(chapterNo.value)
      return
    }
  }
  chapterNo.value = next
  loadChapter(true)
}

async function switchMode(next: 'read' | 'edit') {
  if (running.value || mode.value === next) return
  clearSelection()
  if (next === 'edit') {
    mode.value = 'edit'
    await nextTick()
    editorRef.value?.focus()
    return
  }
  const saved = await flushSave()
  if (!saved || conflicted.value) return
  mode.value = 'read'
}

function applySelection(start: number, end: number) {
  const text = content.value
  if (
    !props.annotationsEnabled
    || !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end <= start
    || end > text.length
  ) {
    clearSelection()
    return
  }
  const quote = text.slice(start, end)
  if (!quote.trim()) {
    clearSelection()
    return
  }
  selection.value = {
    start,
    end,
    quote,
    prefix: text.slice(Math.max(0, start - 40), start),
    suffix: text.slice(end, Math.min(text.length, end + 40)),
  }
  emit('selection', selection.value)
}

function clearSelection() {
  if (!selection.value) return
  selection.value = null
  emit('selection', null)
}

function syncEditorSelection() {
  const el = editorRef.value
  if (!el || mode.value !== 'edit') return
  if (el.selectionStart === el.selectionEnd) {
    clearSelection()
    return
  }
  applySelection(el.selectionStart, el.selectionEnd)
}

function readerOffset(node: Node | null, offset: number, root: HTMLElement | null): number | null {
  if (!node || !root) return null
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
  const paragraph = element?.closest('[data-paragraph]') as HTMLElement | null
  if (!paragraph || !root.contains(paragraph)) return null
  const start = Number(paragraph.dataset.start)
  if (!Number.isFinite(start)) return null
  if (node.nodeType !== Node.TEXT_NODE) {
    return offset <= 0 ? start : start + (paragraph.textContent || '').length
  }
  let consumed = 0
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current) {
    if (current === node) return start + consumed + offset
    consumed += (current.textContent || '').length
    current = walker.nextNode()
  }
  return null
}

function syncReaderSelection() {
  if (!props.annotationsEnabled || mode.value !== 'read') return
  const windowSelection = window.getSelection()
  if (!windowSelection || windowSelection.rangeCount === 0 || windowSelection.isCollapsed) {
    clearSelection()
    return
  }
  const range = windowSelection.getRangeAt(0)
  const start = readerOffset(range.startContainer, range.startOffset, readerRef.value)
  const end = readerOffset(range.endContainer, range.endOffset, readerRef.value)
  if (start === null || end === null || end <= start) {
    clearSelection()
    return
  }
  applySelection(start, end)
}

function requestAnnotation() {
  if (!selection.value) return
  emit('annotate')
}

function jumpChapter(chapterNoValue: number) {
  const next = Number(chapterNoValue)
  if (!Number.isSafeInteger(next) || next < 1 || next === chapterNo.value) return
  emit('chapter-jump', next)
  void switchChapter(next)
}

function locateFromMarker(annotation: any) {
  locateRange(annotation)
  emit('active-annotation', Number(annotation?.id) || null)
}

function flashEditor() {
  editorFlash.value = true
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    editorFlash.value = false
    flashParagraph.value = -1
    flashTimer = undefined
  }, 1400)
}

function locateRange(annotation: any) {
  const start = Number(annotation?.start_offset ?? annotation?.startOffset)
  const end = Number(annotation?.end_offset ?? annotation?.endOffset)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return

  if (mode.value === 'edit' && editorRef.value) {
    const el = editorRef.value
    el.focus()
    el.setSelectionRange(start, Math.min(end, el.value.length))
    const ratio = el.value.length ? start / el.value.length : 0
    el.scrollTop = Math.max(0, ratio * el.scrollHeight - el.clientHeight / 2)
    applySelection(start, Math.min(end, el.value.length))
    flashEditor()
    return
  }

  const paragraphs = chapterParagraphs.value
  let index = -1
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (start < paragraphs[i].start) break
    index = i
    if (start < paragraphs[i].end) break
  }
  if (index < 0) return
  const target = readerRef.value?.querySelector(`[data-paragraph="${index}"]`) as HTMLElement | null
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  flashParagraph.value = index
  flashEditor()
}

defineExpose({ locateRange })

function onInput() {
  if (running.value) return
  clearSelection()
  if (isFinal.value && !draftConfirmed.value) {
    if (!window.confirm(String(t('novels.writer.draftConfirm')))) {
      content.value = savedContent.value
      return
    }
    draftConfirmed.value = true
  }
  error.value = ''
  scheduleAutosave()
}

function scheduleAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = undefined
    void save({ auto: true })
  }, AUTOSAVE_MS)
}

function save(options: { auto?: boolean; silent?: boolean; force?: boolean } = {}): Promise<boolean> {
  if (running.value) return Promise.resolve(false)
  if (conflicted.value && !options.force) return Promise.resolve(false)
  if (savePromise) {
    saveQueued = true
    return savePromise
  }
  savePromise = performSave(options).finally(() => {
    savePromise = null
    if (saveQueued) {
      saveQueued = false
      if (dirty.value && !conflicted.value && !running.value) scheduleAutosave()
    }
  })
  return savePromise
}

async function performSave(options: { silent?: boolean }): Promise<boolean> {
  if (!dirty.value && !draftConfirmed.value) {
    if (!options.silent) saveState.value = 'idle'
    return true
  }
  const text = content.value
  const patch: Record<string, unknown> = { content: text }
  if (baseUpdatedAt.value) patch.base_updated_at = baseUpdatedAt.value
  if (draftConfirmed.value) patch.status = 'draft'

  saving.value = true
  saveState.value = 'saving'
  error.value = ''
  try {
    const saved: any = await novelAPI.saveChapter(props.novel.id, chapterNo.value, patch)
    baseUpdatedAt.value = saved?.updated_at || saved?.updatedAt || baseUpdatedAt.value
    savedContent.value = text
    draftConfirmed.value = false
    saveState.value = 'saved'
    if (content.value !== text) scheduleAutosave()
    emit('refresh')
    return true
  } catch (err: any) {
    if (err?.status === 409) {
      const current = err?.data?.current || null
      conflicted.value = {
        currentContent: typeof current?.content === 'string' ? current.content : '',
        currentUpdatedAt: typeof current?.updated_at === 'string' ? current.updated_at : null,
      }
      saveState.value = 'error'
      return false
    }
    saveState.value = 'error'
    error.value = err?.message || String(t('novels.errors.protocol'))
    return false
  } finally {
    saving.value = false
  }
}

async function flushSave(): Promise<boolean> {
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = undefined
  }
  if (savePromise) await savePromise
  if (dirty.value && !conflicted.value) return save({ silent: true })
  return !dirty.value && !conflicted.value
}

function keepMine() {
  if (!conflicted.value) return
  baseUpdatedAt.value = conflicted.value.currentUpdatedAt
  conflicted.value = null
  saveState.value = 'idle'
  void save({ force: true, silent: true })
}

function useLatest() {
  if (!conflicted.value) return
  content.value = conflicted.value.currentContent
  savedContent.value = conflicted.value.currentContent
  baseUpdatedAt.value = conflicted.value.currentUpdatedAt
  draftConfirmed.value = false
  conflicted.value = null
  saveState.value = 'idle'
  emit('refresh')
}

function handlers() {
  return {
    onSnapshot(snapshot: any) {
      jobId.value = snapshot.jobId
      if (snapshot.status !== 'running') return
      running.value = true
      if (Number.isSafeInteger(snapshot.chapterNo) && snapshot.chapterNo > 0) {
        chapterNo.value = snapshot.chapterNo
      }
      stage.value = {
        label: snapshot.message || '',
        current: snapshot.progress || 0,
        total: snapshot.total || 0,
      }
      if (typeof snapshot.partial === 'string' && snapshot.partial) {
        content.value = snapshot.partial
        savedContent.value = snapshot.partial
      }
    },
    onStage(next: any) {
      stage.value = { label: next.label, current: next.current, total: next.total }
    },
    onDelta(text: string) {
      content.value += text
      savedContent.value = content.value
    },
    onDone(result: Record<string, any> = {}) {
      const wasFinalize = jobKind.value === 'finalize'
      if (result.timelineUpdated === false) {
        timelineWarning.value = String(result.timelineError || t('novels.writer.atlas.timelineFailed'))
      } else {
        timelineWarning.value = ''
      }
      running.value = false
      stage.value = null
      jobKind.value = 'chapter'
      mode.value = 'read'
      void refreshChapter()
      if (wasFinalize) void generateChapterGraph({ auto: true })
    },
    onError(failure: any) {
      running.value = false
      stage.value = null
      jobKind.value = 'chapter'
      error.value = novelErrorText(t, failure.code, failure.message)
      emit('refresh')
    },
  }
}

async function refreshChapter() {
  try {
    const detail: any = camelizeKeys(await novelAPI.get(props.novel.id))
    const row = (detail.chapters || []).find((chapter: any) => chapter.chapterNo === chapterNo.value)
    if (row) {
      content.value = row.content || ''
      savedContent.value = content.value
      baseUpdatedAt.value = row.updatedAt || null
      draftConfirmed.value = false
    }
  } catch {
    // 刷新失败时保留当前编辑器内容
  }
  emit('refresh')
}

async function generate() {
  if (running.value) return
  if (content.value.trim() && !window.confirm(String(t('novels.writer.overwriteConfirm')))) return
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = undefined
  }
  error.value = ''
  stage.value = null
  jobKind.value = 'chapter'
  running.value = true
  try {
    const data: any = await novelAPI.startChapter(props.novel.id, chapterNo.value, {
      force: hasSavedContent.value,
    })
    jobId.value = data.job_id
    await watchJob(data.job_id, handlers())
  } catch (err: any) {
    error.value = err?.message || String(t('novels.errors.protocol'))
    running.value = false
  }
}

async function finalize() {
  if (running.value || saving.value) return
  if (!content.value.trim()) {
    error.value = String(t('novels.writer.emptyChapter', { n: chapterNo.value }))
    return
  }
  if (!window.confirm(String(t('novels.writer.finalizeConfirm')))) return
  const saved = await flushSave()
  if (!saved || conflicted.value) return

  error.value = ''
  stage.value = null
  jobKind.value = 'finalize'
  running.value = true
  try {
    const data: any = await novelAPI.finalizeChapter(props.novel.id, chapterNo.value)
    jobId.value = data.job_id
    await watchJob(data.job_id, handlers())
  } catch (err: any) {
    error.value = err?.message || String(t('novels.errors.protocol'))
    running.value = false
  }
}

async function generateChapterGraph(options: { auto?: boolean } = {}) {
  if (graphRunning.value || running.value) return
  graphError.value = ''
  if (!options.auto && dirty.value) {
    const saved = await flushSave()
    if (!saved || conflicted.value) return
  }
  if (!content.value.trim()) {
    graphError.value = String(t('novels.writer.emptyChapter', { n: chapterNo.value }))
    return
  }

  graphRunning.value = true
  graphStage.value = ''
  try {
    const data: any = await novelAPI.startGraphChapter(props.novel.id, chapterNo.value)
    const nextJobId = Number(data?.job_id ?? data?.jobId)
    if (!Number.isSafeInteger(nextJobId) || nextJobId <= 0) {
      throw new Error(String(t('novels.errors.protocol')))
    }
    await graphStream.watch(nextJobId, {
      onStage(next: any) {
        graphStage.value = next.label || ''
      },
      onDone() {
        void store.fetchGraph(props.novel.id).catch(() => {})
      },
      onError(failure: any) {
        graphError.value = novelErrorText(t, failure.code, failure.message)
      },
    })
  } catch (err: any) {
    graphError.value = mapError(err, { fallback: 'novels.errors.protocol' })
  } finally {
    graphRunning.value = false
    graphStage.value = ''
  }
}

async function saveChapterEvents(events: any[]) {
  error.value = ''
  try {
    await store.saveStoryAtlas(props.novel.id, {
      timeline_events: events,
      base_updated_at: props.novel.updatedAt,
    })
    emit('refresh')
  } catch (err: any) {
    error.value = err?.message || String(t('novels.errors.protocol'))
  }
}

async function saveChapterNarration(narration: string) {
  error.value = ''
  try {
    await store.updateNarration(props.novel.id, chapterNo.value, narration)
    emit('refresh')
  } catch (err: any) {
    error.value = err?.message || String(t('novels.errors.protocol'))
  }
}

async function cancel() {
  if (!jobId.value) return
  try {
    await novelAPI.cancelJob(jobId.value)
  } catch {
    // 取消失败也停止本地订阅
  }
  stop()
  running.value = false
  stage.value = null
}

onMounted(async () => {
  loadChapter(true)
  void store.fetchGraph(props.novel.id).catch(() => {})
  try {
    const data: any = await novelAPI.jobs(props.novel.id, 'running')
    const items = Array.isArray(data?.items) ? data.items : []
    const job = items
      .map((item: any) => camelizeKeys(item))
      .find((item: any) => item.type === 'chapter' || item.type === 'finalize')
    if (!job) return
    if (Number.isSafeInteger(job.chapterNo) && job.chapterNo > 0) {
      chapterNo.value = job.chapterNo
      loadChapter(true)
    }
    running.value = true
    jobKind.value = job.type === 'finalize' ? 'finalize' : 'chapter'
    jobId.value = job.id
    await watchJob(job.id, handlers())
  } catch {
    // 恢复进度失败不阻塞面板
  }
})

onBeforeUnmount(() => {
  stop()
  graphStream.stop()
  if (autosaveTimer) clearTimeout(autosaveTimer)
  if (flashTimer) clearTimeout(flashTimer)
  if (running.value || conflicted.value || !dirty.value) return
  const patch: Record<string, unknown> = { content: content.value }
  if (baseUpdatedAt.value) patch.base_updated_at = baseUpdatedAt.value
  if (draftConfirmed.value) patch.status = 'draft'
  void novelAPI.saveChapter(props.novel.id, chapterNo.value, patch).catch(() => {})
})
</script>

<style scoped>
.novel-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.panel-head h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
}
.chapter-summary {
  margin: 6px 0 0;
  max-width: 720px;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.6;
}
.panel-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.writer-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-2);
}
.writer-meta label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.word-count {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.lock-hint {
  color: var(--novel-accent);
}
.save-state {
  color: var(--text-2);
}
.save-state.is-dirty {
  color: #e0a43c;
}
.panel-error {
  margin: 0;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--error) 45%, transparent);
  background: var(--error-bg);
  color: var(--error);
  font-size: 12.5px;
}
.panel-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.progress-meta {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-2);
}
.foreshadow-strip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 9px;
  border-radius: 9px;
  background: var(--bg-2);
  border: 1px solid var(--border);
}
.foreshadow-strip-label {
  flex-shrink: 0;
  padding-top: 2px;
  font-size: 11px;
  color: var(--text-2);
}
.foreshadow-strip-label.warn {
  color: #e0a43c;
}
.foreshadow-strip-items {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.foreshadow-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-1);
  font-size: 11px;
}
.foreshadow-chip-title {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: none;
  background: transparent;
  color: var(--text-1);
  font-size: 11px;
  cursor: pointer;
}
.foreshadow-chip-title:hover {
  color: var(--accent);
}
.foreshadow-chip-chapter {
  padding: 0 3px;
  border: none;
  border-left: 1px solid var(--border);
  background: transparent;
  color: var(--accent);
  font-size: 11px;
  cursor: pointer;
}
.annotation-quick {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.annotation-quick-quote {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-1);
}
.annotation-markers {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11.5px;
}
.annotation-markers-label {
  color: var(--text-2);
}
.annotation-pin {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 150px;
  padding: 2px 8px 2px 2px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-1);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}
.annotation-pin:hover {
  border-color: var(--accent);
  color: var(--text-0);
}
.annotation-pin.orphaned {
  border-style: dashed;
  color: #e0a43c;
}
.annotation-pin.resolved {
  opacity: 0.6;
}
.annotation-pin-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 700;
}
.annotation-pin-quote {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chapter-editor {
  min-height: 520px;
  padding: 16px 18px;
  font-size: 14px;
  line-height: 1.85;
  resize: vertical;
  transition: box-shadow 0.2s var(--ease-out);
}
.chapter-editor.flashed {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 45%, transparent);
}
.chapter-editor[readonly] {
  opacity: 0.9;
}
.mode-seg {
  flex-shrink: 0;
}
.chapter-reader {
  width: 100%;
  max-width: var(--reading-measure, 68ch);
  min-height: 520px;
  margin: 0 auto;
  padding: var(--reading-pad, 32px);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-1);
  color: var(--text-0);
  font-family: var(--font-reading);
  font-size: var(--text-reading);
  line-height: var(--leading-reading);
  text-align: left;
  overflow-wrap: break-word;
}
.chapter-reader p {
  margin: 0 0 0.8em;
  text-indent: 2em;
  border-radius: 6px;
  transition: background var(--motion-base, 180ms) var(--ease-out);
}
.chapter-reader p.flashed {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}
.chapter-reader p:last-child {
  margin-bottom: 0;
}
.reader-empty {
  padding: 40px 0;
  text-align: center;
  text-indent: 0;
  color: var(--text-2);
  font-size: 12.5px;
}
.chapter-graph-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 6px;
}
.chapter-graph-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.chapter-graph-head h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}
.graph-stage {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--novel-accent);
}
.timeline-warning {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, #e0a43c 40%, transparent);
  background: color-mix(in srgb, #e0a43c 12%, transparent);
  color: var(--text-1);
  font-size: 12px;
}
.conflict-body p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-2);
}
</style>
