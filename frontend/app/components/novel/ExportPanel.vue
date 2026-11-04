<template>
  <section class="novel-panel">
    <header class="panel-head">
      <div>
        <h2>{{ t('novels.export.title') }}</h2>
        <p class="panel-subtitle">{{ t('novels.export.subtitle') }}</p>
      </div>
    </header>

    <div class="export-summary">
      <div class="card summary-item">
        <span class="summary-value">{{ completedChapters }}<span class="summary-total">/{{ novel.numberOfChapters || 0 }}</span></span>
        <span class="summary-label">{{ t('novels.export.completed') }}</span>
      </div>
      <div class="card summary-item">
        <span class="summary-value">{{ totalWords }}</span>
        <span class="summary-label">{{ t('novels.export.totalWords') }}</span>
      </div>
    </div>

    <p v-if="!completedChapters" class="panel-hint">{{ t('novels.export.empty') }}</p>

    <div class="export-actions">
      <button type="button" class="btn btn-primary" :disabled="!completedChapters" @click="showImport = true">
        {{ imports.length ? t('novels.export.reimport') : t('novels.import.button') }}
      </button>
      <button type="button" class="btn btn-ghost" :disabled="!completedChapters" @click="download('txt')">
        {{ t('novels.export.txt') }}
      </button>
      <button type="button" class="btn btn-ghost" :disabled="!completedChapters" @click="download('md')">
        {{ t('novels.export.md') }}
      </button>
    </div>

    <section v-if="imports.length" class="card import-list">
      <header class="import-list-head">
        <h3>{{ t('novels.export.adaptedTitle') }}</h3>
        <span class="import-list-count">{{ imports.length }}</span>
      </header>
      <div v-for="item in imports" :key="item.import_id" class="import-row">
        <div class="import-main">
          <div class="import-title-line">
            <strong>{{ item.drama_title || t('novels.export.dramaMissing') }}</strong>
            <span v-if="item.has_update" class="import-update">{{ t('novels.export.updateAvailable') }}</span>
            <span v-if="item.status === 'orphaned'" class="import-orphaned">{{ t('novels.export.orphaned') }}</span>
          </div>
          <div class="import-meta">
            <span>{{ t('novels.export.episodeCount', { n: item.episode_count }) }}</span>
            <span>
              {{ item.last_synced_at ? t('novels.export.lastSynced', { time: formatTime(item.last_synced_at) }) : t('novels.sync.neverSynced') }}
            </span>
          </div>
        </div>
        <div class="import-actions">
          <button type="button" class="btn btn-ghost" :disabled="item.drama_missing" @click="navigateTo(`/drama/${item.drama_id}`)">
            {{ t('novels.export.openDrama') }}
          </button>
          <button
            type="button"
            class="btn btn-sm"
            :disabled="item.drama_missing || item.status === 'orphaned'"
            @click="openSync(item)"
          >
            {{ t('novels.export.syncButton') }}
          </button>
        </div>
      </div>
    </section>

    <NovelImportToDramaDialog v-model:open="showImport" :novel="novel" @imported="onImported" />
    <SyncNovelDialog v-model:open="syncOpen" :novel="novel" :import-id="syncTarget" @synced="onSynced" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { novelAPI } from '~/composables/useNovelApi'
import NovelImportToDramaDialog from '~/components/novel/ImportToDramaDialog.vue'
import SyncNovelDialog from '~/components/novel/SyncNovelDialog.vue'

const props = defineProps<{ novel: any }>()
const { t } = useI18n()
const showImport = ref(false)
const imports = ref<any[]>([])
const syncOpen = ref(false)
const syncTarget = ref<number | null>(null)

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

async function loadImports() {
  if (!props.novel?.id) return
  try {
    const data: any = await novelAPI.imports(props.novel.id)
    imports.value = Array.isArray(data?.items) ? data.items : []
  } catch {
    imports.value = []
  }
}

function onImported(payload: { dramaId: number }) {
  navigateTo(`/drama/${payload.dramaId}`)
}

function openSync(item: any) {
  syncTarget.value = item.import_id
  syncOpen.value = true
}

async function onSynced(result: any) {
  toast.success(t('novels.sync.success', result))
  await loadImports()
}

onMounted(loadImports)
watch(() => props.novel?.id, loadImports)

const completedChapters = computed(() => {
  return (props.novel.chapters || []).filter((chapter: any) => (chapter.content || '').trim()).length
})
const totalWords = computed(() => {
  return (props.novel.chapters || []).reduce((sum: number, chapter: any) => sum + (Number(chapter.wordCount) || 0), 0)
})

function filename(format: 'txt' | 'md') {
  const safe = String(props.novel.title || 'novel').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim() || 'novel'
  return `${safe}.${format}`
}

function download(format: 'txt' | 'md') {
  const link = document.createElement('a')
  link.href = novelAPI.exportUrl(props.novel.id, format)
  link.download = filename(format)
  document.body.appendChild(link)
  link.click()
  link.remove()
}
</script>

<style scoped>
.novel-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.panel-head h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
}
.panel-subtitle {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.6;
}
.export-summary {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.summary-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 150px;
  padding: 14px 16px;
}
.summary-value {
  font-size: 22px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.summary-total {
  margin-left: 2px;
  color: var(--text-3);
  font-size: 13px;
  font-weight: 500;
}
.summary-label {
  color: var(--text-2);
  font-size: 12px;
}
.panel-hint {
  margin: 0;
  color: var(--text-3);
  font-size: 12.5px;
}
.export-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.import-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
}
.import-list-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.import-list-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.import-list-count {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-2);
  font-size: 11px;
}
.import-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-hover);
}
.import-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.import-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--text-0);
}
.import-update,
.import-orphaned {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--error);
  background: color-mix(in srgb, var(--error) 12%, transparent);
}
.import-orphaned {
  color: var(--text-3);
  background: var(--bg-base);
}
.import-meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  color: var(--text-3);
  font-size: 11.5px;
}
.import-actions {
  display: flex;
  gap: 8px;
}
</style>
