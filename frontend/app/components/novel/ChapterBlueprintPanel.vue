<template>
  <section class="novel-panel">
    <header class="panel-head">
      <div>
        <h2>{{ t('novels.tabs.blueprint') }}</h2>
        <p>{{ t('novels.detail.blueprintTitle') }}</p>
      </div>
      <div class="panel-actions">
        <button v-if="running" type="button" class="btn btn-ghost" @click="cancel">
          {{ t('novels.blueprint.cancel') }}
        </button>
        <button v-else type="button" class="btn btn-primary" @click="start">
          {{ novel.blueprintGenerated ? t('novels.blueprint.continue') : t('novels.blueprint.generate') }}
        </button>
      </div>
    </header>

    <p v-if="error" class="panel-error">{{ error }}</p>

    <div v-if="running" class="panel-progress">
      <div class="progress-meta">
        <span>{{ stage?.label || t('novels.blueprint.running') }}</span>
        <span v-if="stage && stage.total">{{ stage.current }}/{{ stage.total }}</span>
      </div>
      <div class="progress"><i :style="{ width: `${percent}%` }"></i></div>
    </div>

    <pre v-if="liveText" class="panel-live">{{ liveText }}</pre>

    <div class="seg">
      <button type="button" :class="['seg-item', { on: view === 'list' }]" @click="view = 'list'">
        {{ t('novels.blueprint.viewList') }}
      </button>
      <button type="button" :class="['seg-item', { on: view === 'raw' }]" @click="view = 'raw'">
        {{ t('novels.blueprint.viewRaw') }}
      </button>
    </div>

    <template v-if="view === 'list'">
      <input v-model="keyword" type="search" class="input" :placeholder="t('novels.blueprint.searchPlaceholder')" />
      <p v-if="!chapters.length" class="empty">{{ t('novels.blueprint.empty') }}</p>
      <div v-else class="card blueprint-table">
        <div class="blueprint-row head">
          <span>{{ t('novels.blueprint.columns.chapter') }}</span>
          <span>{{ t('novels.blueprint.columns.title') }}</span>
          <span>{{ t('novels.blueprint.columns.suspense') }}</span>
          <span>{{ t('novels.blueprint.columns.twist') }}</span>
          <span>{{ t('novels.blueprint.columns.summary') }}</span>
          <span>{{ t('novels.blueprint.narration') }}</span>
          <span></span>
        </div>
        <div v-for="chapter in pagedChapters" :key="chapter.number" class="blueprint-row">
          <span class="chapter-no">{{ chapter.number }}</span>
          <strong>{{ chapter.title }}</strong>
          <span class="metric">{{ chapter.suspense || '—' }}</span>
          <span class="metric">{{ chapter.twistLevel || '—' }}</span>
          <span class="summary">{{ chapter.summary || '—' }}</span>
          <span class="bp-narration" @click="openNarration(chapter)">
            {{ chapter.narration || t('novels.blueprint.narrationEmpty') }}
          </span>
          <button type="button" class="btn btn-ghost btn-sm" @click="emit('write-chapter', chapter.number)">
            {{ t('novels.blueprint.writeThis') }}
          </button>
        </div>
      </div>
      <footer v-if="filtered.length" class="pager">
        <span class="pager-total">{{ t('novels.blueprint.pagination.total', { n: filtered.length }) }}</span>
        <div class="pager-controls">
          <label class="pager-size">
            <span>{{ t('novels.blueprint.pagination.pageSize') }}</span>
            <select v-model.number="pageSize" class="input pager-select">
              <option :value="20">20</option>
              <option :value="50">50</option>
              <option :value="100">100</option>
              <option :value="0">{{ t('novels.blueprint.pagination.all') }}</option>
            </select>
          </label>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="currentPage <= 1"
            @click="currentPage -= 1"
          >
            {{ t('novels.blueprint.pagination.prev') }}
          </button>
          <span class="pager-page">
            {{ t('novels.blueprint.pagination.page', { current: currentPage, total: totalPages }) }}
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="currentPage >= totalPages"
            @click="currentPage += 1"
          >
            {{ t('novels.blueprint.pagination.next') }}
          </button>
        </div>
      </footer>
      <p v-if="chapters.length && !filtered.length" class="empty">{{ t('novels.empty.filteredTitle') }}</p>
    </template>

    <template v-else>
      <label class="raw-label">
        <span>{{ t('novels.blueprint.rawTitle') }}</span>
        <em>{{ t('novels.blueprint.rawHint') }}</em>
      </label>
      <textarea
        v-model="rawDraft"
        class="textarea raw-editor"
        spellcheck="false"
        @input="onRawInput"
        @blur="flushRaw"
      ></textarea>
      <span class="save-state">
        {{ saveState === 'saving' ? t('novels.blueprint.saving') : saveState === 'saved' ? t('novels.blueprint.saved') : '' }}
      </span>
    </template>

    <div v-if="narrationDialog" class="overlay narration-dialog" @click.self="narrationDialog = null">
      <div class="dialog" style="width: min(520px, calc(100vw - 48px))">
        <div class="dialog-head">
          <h3 class="dialog-title">
            {{ t('novels.blueprint.narrationDialogTitle', { n: narrationDialog.number }) }}
          </h3>
        </div>
        <div class="dialog-body">
          <textarea
            v-model="narrationDraft"
            class="textarea narration-editor"
            rows="5"
            :placeholder="t('novels.blueprint.narrationPlaceholder')"
          ></textarea>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" @click="narrationDialog = null">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn-primary" :disabled="narrationSaving" @click="saveNarration">
            {{ narrationSaving ? t('novels.blueprint.saving') : t('common.save') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { camelizeKeys } from '~/stores/novel'
import { novelAPI } from '~/composables/useNovelApi'
import { novelErrorText, useNovelJobStream } from '~/composables/useNovelJobStream'

const props = defineProps<{ novel: any }>()
const emit = defineEmits<{
  (event: 'refresh'): void
  (event: 'write-chapter', chapterNo: number): void
}>()

const { t } = useI18n()
const { watch: watchJob, stop } = useNovelJobStream()

const view = ref<'list' | 'raw'>('list')
const keyword = ref('')
const rawDraft = ref(props.novel.chapterBlueprint || '')
const saveState = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
const running = ref(false)
const jobId = ref<number | null>(null)
const stage = ref<{ label: string; current: number; total: number } | null>(null)
const liveText = ref('')
const error = ref('')
const narrationDialog = ref<any | null>(null)
const narrationDraft = ref('')
const narrationSaving = ref(false)

let rawDirty = false
let saveTimer: ReturnType<typeof setTimeout> | undefined

const chapters = computed(() => (Array.isArray(props.novel.blueprintChapters) ? props.novel.blueprintChapters : []))
const filtered = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  if (!query) return chapters.value
  return chapters.value.filter((chapter: any) =>
    `${chapter.number} ${chapter.title || ''} ${chapter.summary || ''}`.toLowerCase().includes(query),
  )
})
const pageSize = ref(20)
const currentPage = ref(1)
const totalPages = computed(() =>
  pageSize.value > 0 ? Math.max(1, Math.ceil(filtered.value.length / pageSize.value)) : 1,
)
const pagedChapters = computed(() => {
  if (pageSize.value <= 0) return filtered.value
  const start = (currentPage.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

watch([keyword, pageSize], () => {
  currentPage.value = 1
})
watch(totalPages, (value) => {
  if (currentPage.value > value) currentPage.value = value
})
const percent = computed(() => {
  if (!stage.value || !stage.value.total) return running.value ? 8 : 0
  return Math.max(0, Math.min(100, Math.round((stage.value.current / stage.value.total) * 100)))
})

watch(() => props.novel.chapterBlueprint, (value) => {
  if (!rawDirty) rawDraft.value = value || ''
})

function handlers() {
  return {
    onSnapshot(snapshot: any) {
      jobId.value = snapshot.jobId
      if (snapshot.status === 'running') {
        running.value = true
        stage.value = {
          label: snapshot.message || '',
          current: snapshot.progress || 0,
          total: snapshot.total || 0,
        }
        if (snapshot.partial) liveText.value = snapshot.partial
      }
    },
    onStage(next: any) {
      stage.value = { label: next.label, current: next.current, total: next.total }
      liveText.value = ''
    },
    onDelta(text: string) {
      liveText.value += text
    },
    onDone() {
      running.value = false
      stage.value = null
      liveText.value = ''
      emit('refresh')
    },
    onError(failure: any) {
      running.value = false
      error.value = novelErrorText(t, failure.code, failure.message)
      emit('refresh')
    },
  }
}

async function start() {
  if (running.value) return
  error.value = ''
  liveText.value = ''
  stage.value = null
  running.value = true
  try {
    const data: any = await novelAPI.startBlueprint(props.novel.id)
    jobId.value = data.job_id
    await watchJob(data.job_id, handlers())
  } catch (err: any) {
    error.value = err?.message || String(t('novels.errors.protocol'))
  } finally {
    running.value = false
  }
}

async function cancel() {
  if (!jobId.value) return
  try {
    await novelAPI.cancelJob(jobId.value)
  } catch {
    // 忽略取消失败，继续停止本地订阅
  }
  stop()
  running.value = false
  stage.value = null
  liveText.value = ''
}

function openNarration(row: any) {
  narrationDialog.value = row
  narrationDraft.value = row.narration || ''
}

async function saveNarration() {
  if (!narrationDialog.value || narrationSaving.value) return
  narrationSaving.value = true
  error.value = ''
  try {
    await novelAPI.updateBlueprintNarration(
      props.novel.id,
      narrationDialog.value.number,
      narrationDraft.value.trim(),
    )
    narrationDialog.value = null
    emit('refresh')
  } catch (err: any) {
    error.value = err?.message || String(t('novels.errors.protocol'))
  } finally {
    narrationSaving.value = false
  }
}

function onRawInput() {
  rawDirty = true
  saveState.value = 'saving'
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void saveRaw() }, 800)
}

async function saveRaw() {
  if (!rawDirty) return
  saveState.value = 'saving'
  try {
    await novelAPI.update(props.novel.id, { chapter_blueprint: rawDraft.value })
    rawDirty = false
    saveState.value = 'saved'
    emit('refresh')
  } catch (err: any) {
    saveState.value = 'error'
    error.value = err?.message || String(t('novels.errors.protocol'))
  }
}

function flushRaw() {
  if (saveTimer) clearTimeout(saveTimer)
  void saveRaw()
}

onMounted(async () => {
  try {
    const data: any = await novelAPI.jobs(props.novel.id, 'running')
    const items = Array.isArray(data?.items) ? data.items : []
    const job = items.map((item: any) => camelizeKeys(item)).find((item: any) => item.type === 'blueprint')
    if (!job) return
    running.value = true
    jobId.value = job.id
    await watchJob(job.id, handlers())
  } catch {
    // 恢复进度失败不阻塞面板
  }
})

onBeforeUnmount(() => {
  stop()
  if (saveTimer) clearTimeout(saveTimer)
  if (rawDirty) {
    rawDirty = false
    void novelAPI.update(props.novel.id, { chapter_blueprint: rawDraft.value }).catch(() => {})
  }
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
.panel-head p {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: 12.5px;
}
.panel-actions {
  display: flex;
  gap: 8px;
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
.panel-live {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-active, rgba(255, 255, 255, 0.04));
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.empty {
  margin: 0;
  padding: 24px 0;
  text-align: center;
  color: var(--text-3);
  font-size: 12.5px;
}
.blueprint-table {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.blueprint-row {
  display: grid;
  grid-template-columns: 44px minmax(110px, 1.1fr) 92px 92px minmax(180px, 2fr) minmax(140px, 1.4fr) 92px;
  gap: 10px;
  align-items: center;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
}
.blueprint-row:last-child {
  border-bottom: none;
}
.blueprint-row.head {
  background: var(--bg-active, rgba(255, 255, 255, 0.05));
  color: var(--text-3);
  font-size: 11.5px;
}
.chapter-no {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.metric {
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.summary {
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bp-narration {
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 3px;
}
.bp-narration:hover {
  color: var(--accent-text);
}
.narration-editor {
  min-height: 130px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.7;
  resize: vertical;
}
.raw-label {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12.5px;
  color: var(--text-0);
}
.raw-label em {
  font-style: normal;
  font-size: 11.5px;
  color: var(--text-3);
}
.raw-editor {
  min-height: 420px;
  padding: 14px 16px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.7;
  resize: vertical;
}
.save-state {
  min-height: 16px;
  font-size: 11.5px;
  color: var(--text-3);
}
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 2px 0;
}
.pager-total {
  font-size: 12px;
  color: var(--text-3);
}
.pager-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pager-size {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.pager-select {
  width: 92px;
  height: 30px;
  padding: 0 8px;
}
.pager-page {
  min-width: 92px;
  text-align: center;
  font-size: 12px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
@media (max-width: 860px) {
  .blueprint-row {
    grid-template-columns: 36px 1fr 80px 80px 92px;
  }
  .blueprint-row .summary,
  .blueprint-row .bp-narration {
    display: none;
  }
}
</style>
