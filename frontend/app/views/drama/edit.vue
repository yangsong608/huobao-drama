<template>
  <div class="edit-shell">
    <RemoteChangeNotice
      class="edit-sync-notice"
      :visible="remoteChange"
      @refresh="applyRemoteChange"
      @dismiss="keepLocalChanges"
    />
    <div class="edit-page">
      <div v-if="loading" class="edit-state">
        <Loader2 :size="22" class="edit-spin" />
        <p>{{ t('edit.loading') }}</p>
      </div>
      <div v-else-if="error" class="edit-state">
        <h2>{{ t('edit.loadFailed') }}</h2>
        <p>{{ error }}</p>
        <button class="edit-btn is-primary" type="button" @click="load">{{ t('edit.retry') }}</button>
      </div>
      <EditWorkbench
        v-else-if="state"
        ref="workbenchRef"
        :key="workbenchKey"
        :state="state"
        :episode-label="episodeLabel"
        @back="goBack"
        @open-film="openFilm"
      />
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import { dramaAPI, editAPI } from '~/composables/useApi'
import { useSyncedRefresh } from '~/composables/useSyncedRefresh'
import EditWorkbench from '~/components/edit/EditWorkbench.vue'
import RemoteChangeNotice from '~/components/RemoteChangeNotice.vue'

definePageMeta({ layout: 'studio' })

const route = useRoute()
const { t } = useI18n()
const dramaId = Number(route.params.id)
const episodeNumber = Number(route.params.episodeNumber)

const loading = ref(true)
const error = ref('')
const state = ref(null)
const episode = ref(null)

const episodeLabel = computed(() => {
  const n = episode.value?.episode_number ?? episode.value?.episodeNumber ?? episodeNumber
  const title = episode.value?.title || ''
  return title
    ? `${t('episode.topbar.episodeN', { n })} · ${title}`
    : t('episode.topbar.episodeN', { n })
})

// ?film=<成片 id>：进入页面即打开该成片对应的剪辑工程
const filmParam = computed(() => {
  const raw = Number(route.query.film)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 0
})

// 工程切换后整体重挂载工作台，useEditPlan 用新 state 重新初始化，避免旧草稿/历史残留。
const workbenchKey = computed(() => `${state.value?.episode_id ?? 0}:${state.value?.project?.id ?? 0}`)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const drama = await dramaAPI.get(dramaId)
    const found = drama.episodes?.find(
      (item) => (item.episode_number || item.episodeNumber) === episodeNumber,
    )
    if (!found) throw new Error(t('edit.episodeNotFound'))
    episode.value = found
    let projectId
    if (filmParam.value) {
      const opened = await editAPI.openProject(found.id, filmParam.value)
      projectId = opened?.data?.project?.id ?? opened?.project?.id
    }
    state.value = await editAPI.get(found.id, projectId)
  } catch (cause) {
    state.value = null
    error.value = cause instanceof Error ? cause.message : t('edit.loadFailed')
  } finally {
    loading.value = false
  }
}

function openFilm(filmId) {
  navigateTo({ query: { ...route.query, film: String(filmId) } })
}

const workbenchRef = ref(null)

const { remoteChange, applyRemoteChange, keepLocalChanges } = useSyncedRefresh({
  id: 'drama-edit',
  match: path => /^\/api\/v1\/episodes\/[^/]+\/edit(\/|$)/.test(path),
  refresh: () => (workbenchRef.value ? workbenchRef.value.reload() : load()),
  isDirty: () => Boolean(workbenchRef.value?.isDirty()),
  isSaving: () => Boolean(workbenchRef.value?.isSaving()),
})

watch(filmParam, () => { if (!loading.value) load() })

function goBack() {
  navigateTo(`/drama/${dramaId}/episode/${episodeNumber}`)
}

onMounted(load)

defineExpose({ load })
</script>

<style scoped>
.edit-shell { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.edit-sync-notice { margin: 8px 8px 0; }
.edit-page { flex: 1; min-height: 0; display: flex; background: var(--bg-base); }
.edit-state {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; color: var(--text-2); text-align: center; padding: 32px;
}
.edit-state h2 { color: var(--text-0); font-size: 18px; }
.edit-state p { max-width: 560px; line-height: 1.6; }
.edit-btn {
  height: 34px; padding: 0 16px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--bg-1); color: var(--text-0); cursor: pointer;
}
.edit-btn.is-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.edit-spin { animation: edit-spin 1s linear infinite; }
@keyframes edit-spin { to { transform: rotate(360deg); } }
</style>
