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
      </div>
    </header>

    <RemoteChangeNotice :visible="remoteChange" @refresh="applyRemoteChange" @dismiss="keepLocalChanges" />

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
      class="textarea chapter-editor"
      :readonly="running"
      :placeholder="t('novels.writer.placeholder')"
      spellcheck="false"
      @input="onInput"
      @blur="flushSave"
    ></textarea>
    <div v-else class="chapter-reader">
      <p v-if="!chapterParagraphs.length" class="reader-empty">
        {{ t('novels.writer.readEmpty', { n: chapterNo }) }}
      </p>
      <p v-for="(paragraph, index) in chapterParagraphs" :key="index">{{ paragraph }}</p>
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
import { camelizeKeys, useNovelStore } from '~/stores/novel'
import { novelAPI } from '~/composables/useNovelApi'
import { novelErrorText, useNovelJobStream } from '~/composables/useNovelJobStream'
import { useTheme } from '~/composables/useTheme'
import { mapError } from '~/composables/useToast'
import { useSyncedRefresh } from '~/composables/useSyncedRefresh'
import RemoteChangeNotice from '~/components/RemoteChangeNotice.vue'
import ChapterRelationGraph from './compass/ChapterRelationGraph.vue'
import ChapterAtlasCard from './story/ChapterAtlasCard.vue'

const props = defineProps<{ novel: any; initialChapterNo?: number }>()
const emit = defineEmits<{ (event: 'refresh'): void }>()

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
const chapterParagraphs = computed(() =>
  content.value
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean),
)
const percent = computed(() => {
  if (!stage.value || !stage.value.total) return running.value ? 8 : 0
  return Math.max(0, Math.min(100, Math.round((stage.value.current / stage.value.total) * 100)))
})

const { remoteChange, applyRemoteChange, keepLocalChanges } = useSyncedRefresh({
  id: 'novel-writer',
  match: path => new RegExp(`^/api/v1/novels/${props.novel.id}/chapters(/|$)`).test(path),
  refresh: async () => {
    const fresh: any = await store.fetchNovel(props.novel.id)
    const row = (fresh?.chapters || []).find((chapter: any) => chapter.chapterNo === chapterNo.value)
    content.value = row?.content || ''
    savedContent.value = content.value
    baseUpdatedAt.value = row?.updatedAt || null
    conflicted.value = null
    saveState.value = 'idle'
    emit('refresh')
  },
  isDirty: () => dirty.value || Boolean(conflicted.value) || running.value,
  isSaving: () => saving.value || saveState.value === 'saving',
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

function onInput() {
  if (running.value) return
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
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.lock-hint {
  color: var(--novel-accent);
}
.save-state {
  color: var(--text-3);
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
.chapter-editor {
  min-height: 520px;
  padding: 16px 18px;
  font-size: 14px;
  line-height: 1.85;
  resize: vertical;
}
.chapter-editor[readonly] {
  opacity: 0.9;
}
.mode-seg {
  flex-shrink: 0;
}
.chapter-reader {
  min-height: 520px;
  padding: 26px 30px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-1);
  color: var(--text-0);
  font-size: 14px;
  line-height: 1.95;
  overflow-wrap: break-word;
}
.chapter-reader p {
  margin: 0 0 0.9em;
  text-indent: 2em;
}
.chapter-reader p:last-child {
  margin-bottom: 0;
}
.reader-empty {
  padding: 40px 0;
  text-align: center;
  text-indent: 0;
  color: var(--text-3);
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
