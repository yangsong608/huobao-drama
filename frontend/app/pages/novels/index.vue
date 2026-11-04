<template>
  <section class="page">
    <div class="launcher-head">
      <div class="head-left">
        <h1 class="launcher-title">{{ t('novels.title') }}</h1>
        <span class="launcher-sub">{{ t('novels.subtitle') }}</span>
      </div>
      <div class="hero-stats">
        <span class="tag">{{ t('novels.stats.total', { n: store.pagination.total }) }}</span>
        <span class="tag tag-accent">{{ t('novels.stats.writing', { n: writingCount }) }}</span>
        <span class="tag tag-success">{{ t('novels.stats.completed', { n: completedCount }) }}</span>
      </div>
      <div class="head-actions">
        <button type="button" class="btn btn-primary" @click="showCreate = true">
          <Plus :size="15" :stroke-width="2" />
          {{ t('novels.create') }}
        </button>
      </div>
    </div>

    <div class="toolbar">
      <label class="search-box">
        <Search :size="15" :stroke-width="1.8" />
        <input v-model.trim="keyword" class="input" :placeholder="t('novels.searchPlaceholder')" />
        <button v-if="keyword" type="button" class="search-clear" :aria-label="t('common.close')" @click="keyword = ''">
          <X :size="12" />
        </button>
      </label>
      <div class="chip-row">
        <button
          v-for="item in filters"
          :key="item.value"
          type="button"
          class="filter-chip"
          :class="{ on: status === item.value }"
          @click="status = item.value"
        >
          {{ item.label }}
        </button>
      </div>
    </div>

    <div v-if="store.error" class="error-banner card">
      <span>{{ store.error }}</span>
      <button type="button" class="btn btn-sm" @click="load">{{ t('common.refresh') }}</button>
    </div>

    <div v-if="store.loading && !store.list.length" class="project-grid">
      <div v-for="i in 8" :key="i" class="card skeleton-card">
        <div class="skeleton-cover"></div>
        <div class="skeleton-body">
          <div class="skeleton-line w-60"></div>
          <div class="skeleton-line w-40"></div>
        </div>
      </div>
    </div>

    <div v-else-if="store.list.length" class="project-grid">
      <NovelProjectCard
        v-for="project in store.list"
        :key="project.id"
        :project="project"
        @open="openNovel"
        @delete="askDelete"
      />
    </div>

    <div v-else class="empty-state">
      <div class="empty-icon">
        <BookOpen :size="28" :stroke-width="1.4" />
      </div>
      <p class="empty-title">{{ keyword || status ? t('novels.empty.filteredTitle') : t('novels.empty.title') }}</p>
      <p class="empty-desc">{{ keyword || status ? t('novels.empty.filteredDesc') : t('novels.empty.desc') }}</p>
      <button v-if="!keyword && !status" type="button" class="btn btn-primary" @click="showCreate = true">
        <Plus :size="15" :stroke-width="2" />
        {{ t('novels.empty.action') }}
      </button>
      <button v-else type="button" class="btn btn-sm" @click="resetFilters">{{ t('novels.empty.reset') }}</button>
    </div>

    <NovelCreateProjectDialog v-model:open="showCreate" @created="onCreated" />
    <ConfirmDialog
      :open="Boolean(deleteTarget)"
      :title="t('novels.deleteDialog.title')"
      :message="deleteMessage"
      :confirm-text="t('novels.deleteDialog.confirm')"
      :loading="store.saving"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookOpen, Plus, Search, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { useNovelStore } from '~/stores/novel'
import NovelProjectCard from '~/components/novel/ProjectCard.vue'
import NovelCreateProjectDialog from '~/components/novel/CreateProjectDialog.vue'

definePageMeta({ layout: 'novel' })

const { t } = useI18n()
const store = useNovelStore()

const keyword = ref('')
const status = ref('')
const showCreate = ref(false)
const deleteTarget = ref<any | null>(null)
let searchTimer: ReturnType<typeof setTimeout> | null = null

const filters = computed(() => [
  { value: '', label: t('novels.filter.all') },
  { value: 'draft', label: t('novels.filter.draft') },
  { value: 'writing', label: t('novels.filter.writing') },
  { value: 'completed', label: t('novels.filter.completed') },
])
const writingCount = computed(() => store.list.filter((item) => item.status === 'writing').length)
const completedCount = computed(() => store.list.filter((item) => item.status === 'completed').length)
const deleteMessage = computed(() => t('novels.deleteDialog.message', { title: deleteTarget.value?.title || '' }))

async function load() {
  try {
    await store.fetchList({
      keyword: keyword.value || undefined,
      status: status.value || undefined,
      pageSize: 100,
    })
  } catch { /* 错误已写入 store.error */ }
}

function scheduleLoad() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(load, 280)
}

watch(keyword, scheduleLoad)
watch(status, load)
onMounted(load)
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

function resetFilters() {
  keyword.value = ''
  status.value = ''
}

function openNovel(project: any) {
  navigateTo(`/novels/${project.id}`)
}

function onCreated(novel: any) {
  navigateTo(`/novels/${novel.id}`)
}

function askDelete(project: any) {
  deleteTarget.value = project
}

async function confirmDelete() {
  const target = deleteTarget.value
  if (!target) return
  try {
    await store.deleteNovel(target.id)
    toast.success(t('novels.deleteDialog.deleted'))
    deleteTarget.value = null
  } catch (error: any) {
    toast.error(error?.message || t('novels.deleteDialog.failed'))
  }
}
</script>

<style scoped>
.page {
  padding: 20px 28px 48px;
  overflow-y: auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  animation: fadeUp 0.35s var(--ease-out) both;
  background: var(--surface-base);
}
.launcher-head {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding-bottom: var(--sp-4);
}
.head-left { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.launcher-title {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--text-0);
  white-space: nowrap;
}
.launcher-sub {
  color: var(--text-3);
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hero-stats { display: flex; gap: var(--sp-2); margin-left: auto; }
.head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
.search-box { position: relative; width: 240px; flex: 0 0 auto; }
.search-box svg {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-3);
  pointer-events: none;
}
.search-box .input {
  padding-left: 34px;
  padding-right: 30px;
  border-radius: var(--radius-pill);
  border-color: var(--border);
  background: var(--bg-hover);
}
.search-box .input:focus { background: var(--surface-input); }
.search-clear {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--overlay-track);
  color: var(--text-3);
  cursor: pointer;
}
.search-clear:hover { color: var(--text-0); background: var(--bg-active); }
.chip-row { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 1px; }
.filter-chip {
  appearance: none;
  cursor: pointer;
  padding: 6px 14px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--overlay-track);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: all 0.16s var(--ease-out);
}
.filter-chip:hover { color: var(--text-0); background: var(--bg-active); }
.filter-chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.filter-chip.on { background: var(--inverse-surface); color: var(--on-inverse); }

.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: var(--sp-4);
  padding: 10px 14px;
  border-color: color-mix(in srgb, var(--error) 40%, var(--border));
  color: var(--error);
  font-size: 12.5px;
}
.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}
.skeleton-card { overflow: hidden; }
.skeleton-cover {
  aspect-ratio: 2.1 / 1;
  background: var(--bg-2);
  animation: skeleton-pulse 1.4s ease-in-out infinite alternate;
}
.skeleton-body { padding: 12px 14px 14px; display: grid; gap: 10px; }
.skeleton-line {
  height: 12px;
  border-radius: 99px;
  background: var(--bg-2);
  animation: skeleton-pulse 1.4s ease-in-out infinite alternate;
}
.skeleton-line.w-60 { width: 60%; }
.skeleton-line.w-40 { width: 40%; }
@keyframes skeleton-pulse { to { opacity: 0.55; } }
.empty-state {
  flex: 1;
  min-height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  text-align: center;
}
.empty-icon {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-lg);
  background: var(--bg-2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  margin-bottom: 4px;
}
.empty-title { font-size: 14px; font-weight: 600; color: var(--text-1); }
.empty-desc { font-size: 12px; color: var(--text-3); max-width: 240px; line-height: 1.6; }

@media (max-width: 760px) {
  .page { padding: 16px 16px 40px; }
  .launcher-head { flex-wrap: wrap; }
  .head-actions { width: 100%; }
  .head-actions .btn { width: 100%; }
  .hero-stats { display: none; }
  .toolbar { flex-wrap: wrap; }
  .search-box { width: 100%; flex: 1 1 100%; }
  .project-grid { grid-template-columns: 1fr; }
}
</style>
