<template>
  <section class="video-launcher">
    <div class="launcher-head">
      <div class="head-left">
        <h1 class="launcher-title">{{ t('video.title') }}</h1>
        <span class="launcher-sub">{{ t('video.subtitle') }}</span>
      </div>
      <div class="hero-stats">
        <span class="tag">{{ t('video.stats.total', { n: total }) }}</span>
        <span class="tag tag-accent">{{ t('video.stats.ready', { n: readyCount }) }}</span>
        <span class="tag tag-success">{{ t('video.stats.completed', { n: completedCount }) }}</span>
      </div>
      <button type="button" class="btn btn-primary" @click="showCreate = true">
        <Plus :size="15" :stroke-width="2" />
        {{ t('video.create') }}
      </button>
    </div>

    <div class="toolbar">
      <label class="search-box">
        <Search :size="15" :stroke-width="1.8" />
        <input v-model.trim="keyword" class="input" :placeholder="t('video.searchPlaceholder')" />
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
        >{{ item.label }}</button>
      </div>
    </div>

    <div v-if="error" class="error-banner card">
      <span>{{ error }}</span>
      <button type="button" class="btn btn-sm" @click="load">{{ t('common.refresh') }}</button>
    </div>

    <div v-if="loading && !projects.length" class="project-grid">
      <div v-for="i in 6" :key="i" class="card skeleton-card">
        <div class="skeleton-cover"></div>
        <div class="skeleton-body">
          <div class="skeleton-line w-60"></div>
          <div class="skeleton-line w-40"></div>
        </div>
      </div>
    </div>

    <div v-else-if="projects.length" class="project-grid">
      <article
        v-for="project in projects"
        :key="project.id"
        class="card project-card"
        tabindex="0"
        role="button"
        @click="openProject(project)"
        @keydown.enter.prevent="openProject(project)"
      >
        <div class="project-cover">
          <span class="cover-initial">{{ initialOf(project) }}</span>
          <span class="cover-mode">{{ t(`video.mode.${project.mode}`) }}</span>
          <span class="cover-status">
            <i class="status-dot" :class="`is-${project.status}`"></i>
            {{ t(`video.status.${project.status || 'draft'}`) }}
          </span>
          <div class="cover-actions">
            <button type="button" class="btn btn-icon btn-sm" :title="t('video.menu.duplicate')" @click.stop="duplicateProject(project)">
              <Copy :size="13" />
            </button>
            <button type="button" class="btn btn-icon btn-sm" :title="t('video.menu.rename')" @click.stop="startRename(project)">
              <Pencil :size="13" />
            </button>
            <button type="button" class="btn btn-icon btn-sm" :title="t('video.menu.delete')" @click.stop="deleteTarget = project">
              <Trash2 :size="13" />
            </button>
          </div>
        </div>
        <div class="project-body">
          <h3 class="project-name">{{ project.title }}</h3>
          <p class="project-prompt">{{ project.prompt || t('video.card.noPrompt') }}</p>
          <div class="project-meta">
            <span>{{ t('video.card.updated', { time: formatTime(project.updated_at) }) }}</span>
            <span v-if="project.latest_run">{{ statusLabel(project.latest_run.status) }}</span>
          </div>
        </div>
      </article>
    </div>

    <div v-else class="empty-state">
      <div class="empty-icon"><Clapperboard :size="28" :stroke-width="1.4" /></div>
      <p class="empty-title">{{ keyword || status ? t('video.empty.filteredTitle') : t('video.empty.title') }}</p>
      <p class="empty-desc">{{ keyword || status ? t('video.empty.filteredDesc') : t('video.empty.desc') }}</p>
      <button v-if="!keyword && !status" type="button" class="btn btn-primary" @click="showCreate = true">
        <Plus :size="15" :stroke-width="2" />
        {{ t('video.empty.action') }}
      </button>
      <button v-else type="button" class="btn btn-sm" @click="resetFilters">{{ t('video.empty.reset') }}</button>
    </div>

    <VideoCreateDialog v-model:open="showCreate" @created="onCreated" />
    <ConfirmDialog
      :open="Boolean(deleteTarget)"
      :title="t('video.deleteDialog.title')"
      :message="deleteMessage"
      :confirm-text="t('video.deleteDialog.confirm')"
      :loading="saving"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />

    <div v-if="renameTarget" class="overlay" @click.self="renameTarget = null">
      <div class="dialog" style="width:min(420px, calc(100vw - 40px))" role="dialog" aria-modal="true">
        <div class="dialog-head">
          <h2 class="dialog-title">{{ t('video.renameDialog.title') }}</h2>
          <button type="button" class="btn btn-icon btn-sm ml-auto" @click="renameTarget = null"><X :size="15" /></button>
        </div>
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">{{ t('video.createDialog.titleLabel') }}</span>
            <input v-model.trim="renameTitle" class="input" maxlength="120" @keydown.enter.prevent="confirmRename" />
          </label>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" :disabled="saving" @click="renameTarget = null">{{ t('common.cancel') }}</button>
          <button type="button" class="btn btn-primary" :disabled="saving || !renameTitle.trim()" @click="confirmRename">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clapperboard, Copy, Pencil, Plus, Search, Trash2, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { videoAPI } from '~/composables/useApi'
import VideoCreateDialog from '~/components/video/VideoCreateDialog.vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import { toastError } from '~/composables/useToast'

const { t, te } = useI18n()
const projects = ref<any[]>([])
const loading = ref(false)
const error = ref('')
const saving = ref(false)
const keyword = ref('')
const status = ref('')
const showCreate = ref(false)
const deleteTarget = ref<any | null>(null)
const renameTarget = ref<any | null>(null)
const renameTitle = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

const filters = computed(() => [
  { value: '', label: t('video.filter.all') },
  { value: 'draft', label: t('video.status.draft') },
  { value: 'analyzing', label: t('video.status.analyzing') },
  { value: 'ready', label: t('video.status.ready') },
  { value: 'generating', label: t('video.status.generating') },
  { value: 'completed', label: t('video.status.completed') },
  { value: 'failed', label: t('video.status.failed') },
])
const total = computed(() => projects.value.length)
const readyCount = computed(() => projects.value.filter(item => item.status === 'ready').length)
const completedCount = computed(() => projects.value.filter(item => item.status === 'completed').length)
const deleteMessage = computed(() => t('video.deleteDialog.message', { title: deleteTarget.value?.title || '' }))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await videoAPI.list({ keyword: keyword.value || undefined, status: status.value || undefined, page_size: 100 })
    projects.value = Array.isArray(result?.items) ? result.items : []
  } catch (e: any) {
    error.value = e?.message || t('video.empty.loadFailed')
  } finally {
    loading.value = false
  }
}

function scheduleLoad() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(load, 280)
}
watch(keyword, scheduleLoad)
watch(status, load)
onMounted(load)
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

function resetFilters() {
  keyword.value = ''
  status.value = ''
}

function initialOf(project: any) {
  return String(project?.title || '视').trim().slice(0, 1)
}

function statusLabel(value: string | null | undefined) {
  if (!value) return '—'
  const key = `video.runStatus.${value}`
  return te(key) ? t(key) : value
}

function formatTime(raw: string | null | undefined) {
  if (!raw) return '—'
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function openProject(project: any) {
  navigateTo(`/videos/${project.id}`)
}

function onCreated(project: any) {
  showCreate.value = false
  if (project?.id) navigateTo(`/videos/${project.id}`)
}

function startRename(project: any) {
  renameTarget.value = project
  renameTitle.value = project.title
}

async function confirmRename() {
  if (!renameTarget.value || !renameTitle.value.trim()) return
  saving.value = true
  try {
    await videoAPI.update(renameTarget.value.id, { title: renameTitle.value.trim() })
    toast.success(t('common.saved'))
    renameTarget.value = null
    await load()
  } catch (e) {
    toastError(e)
  } finally {
    saving.value = false
  }
}

async function duplicateProject(project: any) {
  try {
    const created = await videoAPI.duplicate(project.id)
    toast.success(t('video.menu.duplicated'))
    await load()
    if (created?.id) navigateTo(`/videos/${created.id}`)
  } catch (e) {
    toastError(e)
  }
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  saving.value = true
  try {
    await videoAPI.del(deleteTarget.value.id)
    toast.success(t('video.deleteDialog.deleted'))
    deleteTarget.value = null
    await load()
  } catch (e) {
    toastError(e)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.video-launcher {
  padding: 20px 28px 48px;
  overflow-y: auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--surface-base);
}
.launcher-head { display: flex; align-items: center; gap: 12px; }
.head-left { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
.launcher-title { font-size: 20px; font-weight: 650; letter-spacing: -.02em; color: var(--text-0); white-space: nowrap; }
.launcher-sub { color: var(--text-3); font-size: 12.5px; }
.hero-stats { display: flex; gap: 6px; margin-left: auto; }
.toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.search-box { display: flex; align-items: center; gap: 7px; padding: 0 10px; height: 34px; min-width: 260px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-0); color: var(--text-3); }
.search-box .input { border: 0; background: transparent; padding: 0; height: 30px; flex: 1; min-width: 0; }
.search-clear { background: none; border: 0; color: var(--text-3); cursor: pointer; }
.chip-row { display: flex; gap: 4px; flex-wrap: wrap; }
.filter-chip { border: 1px solid transparent; background: transparent; color: var(--text-3); font-size: 11.5px; padding: 5px 10px; border-radius: 999px; cursor: pointer; }
.filter-chip:hover { color: var(--text-1); background: var(--bg-hover); }
.filter-chip.on { background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent) 28%, transparent); color: var(--accent-text); }
.project-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.project-card { padding: 0; overflow: hidden; cursor: pointer; text-align: left; }
.project-card:hover { border-color: var(--border-strong); transform: translateY(-2px); }
.project-cover { position: relative; aspect-ratio: 2.2 / 1; display: flex; align-items: flex-end; padding: 12px 14px; background: radial-gradient(120% 120% at 0% 0%, var(--accent-bg) 0%, transparent 62%), var(--bg-1); border-bottom: 1px solid var(--border); }
.cover-initial { font-size: 30px; font-weight: 650; color: var(--accent-text); opacity: .55; }
.cover-mode { position: absolute; left: 10px; top: 10px; padding: 2px 7px; border-radius: 999px; background: var(--bg-0); border: 1px solid var(--border); color: var(--text-2); font-size: 10px; }
.cover-status { position: absolute; right: 10px; top: 10px; display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--bg-0) 82%, transparent); border: 1px solid var(--border); color: var(--text-2); font-size: 10px; }
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); }
.status-dot.is-analyzing, .status-dot.is-generating { background: var(--accent); }
.status-dot.is-ready { background: var(--accent); }
.status-dot.is-completed { background: var(--success); }
.status-dot.is-failed { background: var(--error); }
.cover-actions { position: absolute; right: 8px; bottom: 8px; display: flex; gap: 3px; opacity: 0; transition: opacity .15s; }
.project-card:hover .cover-actions { opacity: 1; }
.project-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
.project-name { margin: 0; font-size: 14px; color: var(--text-0); font-weight: 600; }
.project-prompt { margin: 0; color: var(--text-3); font-size: 11.5px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.project-meta { display: flex; justify-content: space-between; gap: 8px; color: var(--text-3); font-size: 10.5px; margin-top: 4px; }
.skeleton-card { overflow: hidden; }
.skeleton-cover { aspect-ratio: 2.2/1; background: var(--bg-1); }
.skeleton-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.skeleton-line { height: 11px; border-radius: 4px; background: var(--bg-1); }
.skeleton-line.w-60 { width: 60%; } .skeleton-line.w-40 { width: 40%; }
.error-banner { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 14px; color: var(--error); }
.empty-state { flex: 1; min-height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--text-3); text-align: center; }
.empty-icon { width: 58px; height: 58px; border-radius: 18px; display: flex; align-items: center; justify-content: center; background: var(--accent-bg); color: var(--accent-text); }
.empty-title { margin: 4px 0 0; color: var(--text-0); font-size: 14px; font-weight: 600; }
.empty-desc { margin: 0; max-width: 420px; font-size: 12px; line-height: 1.6; }
@media (max-width: 760px) {
  .video-launcher { padding: 14px 16px 36px; }
  .launcher-head { flex-wrap: wrap; }
  .head-left { width: 100%; }
  .hero-stats { margin-left: 0; }
  .launcher-head .btn-primary { margin-left: auto; }
  .project-grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 520px) { .project-grid { grid-template-columns: 1fr; } }
</style>
