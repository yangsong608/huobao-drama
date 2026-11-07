<template>
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
      :key="workbenchKey"
      :state="state"
      :episode-label="episodeLabel"
      :settings="editSettings"
      :focus-clip-id="focusClipId"
      :show-agent="showHeaderAssistant"
      @back="goBack"
      @open-film="openFilm"
      @open-agent="openAgentDock"
    />
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Loader2 } from 'lucide-vue-next'
import { dramaAPI, editAPI, settingsAPI } from '~/composables/useApi'
import { openAgentDock, useAgentPageAdapter } from '~/composables/useAgentPageAdapter'
import { useAgentSettings } from '~/composables/useAgentSettings'
import EditWorkbench from '~/components/edit/EditWorkbench.vue'

definePageMeta({ layout: 'studio' })

const route = useRoute()
const { t } = useI18n()
const dramaId = Number(route.params.id)
const episodeNumber = Number(route.params.episodeNumber)

const loading = ref(true)
const error = ref('')
const state = ref(null)
const episode = ref(null)
// 配置读取失败时保留保守默认（导出开启、预设 auto、字幕 soft、音频 auto、UX 全开）
const editSettings = ref({
  export: {
    enabled: true,
    defaultPreset: 'auto',
    subtitleMode: 'soft',
    audioSource: 'auto',
    requireAlignedMix: false,
    maxDurationSec: 1800,
    concurrency: 1,
  },
  ux: { contextMenu: true, markers: true, subtitleStyles: true },
  filmSources: { enabled: false },
})

async function loadEditSettings() {
  try {
    const res = await settingsAPI.edit()
    if (res?.settings) editSettings.value = res.settings
  } catch {
    /* 保持内置默认，不阻断剪辑台 */
  }
}

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

// ?project_id=<工程 id>：助手/建议打开指定剪辑工程；不存在时回退默认工程
const projectParam = computed(() => {
  const raw = Number(route.query.project_id)
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 0
})

// ?focus_clip_id=<片段 id>：只在当前工程计划内定位，不跨工程同名字符串匹配
const focusClipParam = computed(() => String(route.query.focus_clip_id || '').trim())
const focusClipId = computed(() => {
  const id = focusClipParam.value
  if (!id) return ''
  const clips = state.value?.plan?.clips
  return Array.isArray(clips) && clips.some((clip) => clip?.id === id) ? id : ''
})

const agentScope = computed(() => {
  const episodeId = Number(state.value?.episode_id) || 0
  const editProjectId = Number(state.value?.project?.id) || 0
  if (!episodeId || !editProjectId) return null
  return {
    workspace_key: `drama:${dramaId}`,
    kind: 'edit',
    drama_id: dramaId,
    episode_id: episodeId,
    edit_project_id: editProjectId,
    ...(focusClipId.value ? { focus: { clip_id: focusClipId.value } } : {}),
  }
})

// 顶栏助手入口与悬浮入口共用同一抽屉；总开关关闭时不显示
const { agentSettings, agentSettingsError, dockEnabled, loadAgentSettings } = useAgentSettings()
const showHeaderAssistant = computed(() => (
  dockEnabled.value && (agentSettings.value !== null || Boolean(agentSettingsError.value))
))

useAgentPageAdapter({
  id: 'drama-edit',
  match: { name: 'drama-episode-edit', pattern: /^\/drama\/\d+\/episode\/\d+\/edit$/ },
  scope: () => agentScope.value,
  entries: ['floating', 'topbar'],
  quickPrompts: () => [t('assistant.prompts.edit1'), t('assistant.prompts.edit2')],
  supportedScopes: ['edit'],
})

// 工程切换后整体重挂载工作台，useEditPlan 用新 state 重新初始化，避免旧草稿/历史残留。
const workbenchKey = computed(() => `${state.value?.episode_id ?? 0}:${state.value?.project?.id ?? 0}`)

async function load() {
  loading.value = true
  error.value = ''
  void loadEditSettings()
  try {
    const drama = await dramaAPI.get(dramaId)
    const found = drama.episodes?.find(
      (item) => (item.episode_number || item.episodeNumber) === episodeNumber,
    )
    if (!found) throw new Error(t('edit.episodeNotFound'))
    episode.value = found
    let projectId
    if (projectParam.value) {
      projectId = projectParam.value
    } else if (filmParam.value) {
      const opened = await editAPI.openProject(found.id, filmParam.value)
      projectId = opened?.data?.project?.id ?? opened?.project?.id
    }
    try {
      state.value = await editAPI.get(found.id, projectId)
    } catch (cause) {
      if (!projectParam.value || cause?.status !== 404) throw cause
      toast.warning(t('edit.projectMissing'))
      state.value = await editAPI.get(found.id)
    }
    if (focusClipParam.value && !focusClipId.value) {
      toast.warning(t('edit.clipMissing'))
    }
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

watch([filmParam, projectParam], () => { if (!loading.value) load() })

function goBack() {
  navigateTo(`/drama/${dramaId}/episode/${episodeNumber}`)
}

onMounted(load)
onMounted(() => { void loadAgentSettings() })

defineExpose({ load })
</script>

<style scoped>
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
