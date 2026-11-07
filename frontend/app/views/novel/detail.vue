<template>
  <div class="page">
    <div v-if="store.loading && !novel" class="page-loading">{{ t('common.loading') }}</div>

    <div v-else-if="!novel" class="page-empty card">
      <h1>{{ t('novels.detail.notFound') }}</h1>
      <p>{{ store.error }}</p>
      <NuxtLink to="/novels" class="btn">{{ t('novels.detail.back') }}</NuxtLink>
    </div>

    <template v-else>
      <header class="page-head card">
        <button type="button" class="back-btn" :title="t('novels.detail.back')" @click="navigateTo('/novels')">
          <ArrowLeft :size="16" :stroke-width="2" />
        </button>
        <div class="head-info">
          <h1 class="page-title">{{ novel.title }}</h1>
          <span class="tag" :class="novel.status === 'completed' ? 'tag-success' : 'tag-accent'">
            {{ t(`novels.status.${novel.status || 'draft'}`) }}
          </span>
          <div class="page-meta">
            <span class="meta-item">
              <BookOpen :size="13" :stroke-width="1.8" />
              {{ t('novels.detail.chapters', { n: novel.numberOfChapters || 0 }) }}
            </span>
            <span class="meta-item">
              <PenLine :size="13" :stroke-width="1.8" />
              {{ t('novels.detail.wordsPerChapter', { n: novel.wordNumber || 0 }) }}
            </span>
          </div>
          <p v-if="novel.topic" class="page-topic">{{ novel.topic }}</p>
          <div v-if="novel.genre?.length" class="page-tags">
            <span v-for="tag in novel.genre" :key="tag" class="tag">{{ tag }}</span>
          </div>
        </div>
        <div class="head-actions">
          <div
            v-if="activeTab === 'writer' && workbenchLayoutReady"
            class="layout-switch"
            :title="t('settings.novel.workbenchLayout')"
          >
            <button
              type="button"
              :class="['layout-switch-btn', { on: workbenchLayout === 'split' }]"
              :disabled="layoutSwitching"
              @click="switchWorkbenchLayout('split')"
            >{{ t('settings.novel.layoutSplit') }}</button>
            <button
              type="button"
              :class="['layout-switch-btn', { on: workbenchLayout === 'tabs' }]"
              :disabled="layoutSwitching"
              @click="switchWorkbenchLayout('tabs')"
            >{{ t('settings.novel.layoutTabs') }}</button>
          </div>
          <button
            v-if="showHeaderAssistant"
            type="button"
            class="btn btn-ghost btn-sm"
            :title="t('assistant.title')"
            @click="openAgentDock"
          >
            <Sparkles :size="14" :stroke-width="1.8" />
            {{ t('assistant.trigger') }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" @click="settingsOpen = true">
            <Settings2 :size="14" :stroke-width="1.8" />
            {{ t('novels.settingsDialog.open') }}
          </button>
        </div>
      </header>

      <nav class="page-tabs">
        <button
          v-for="tab in tabs"
          :key="tab"
          type="button"
          class="tab-btn"
          :class="{ on: activeTab === tab }"
          @click="setTab(tab)"
        >
          {{ t(`novels.tabs.${tab}`) }}
          <span v-if="tab === 'overview'" class="tab-count">{{ novel.numberOfChapters || 0 }}</span>
        </button>
      </nav>

      <NovelArchitecturePanel
        v-if="activeTab === 'architecture'"
        :novel="novel"
        @refresh="load"
      />
      <NovelChapterBlueprintPanel
        v-else-if="activeTab === 'blueprint'"
        :novel="novel"
        @refresh="load"
        @write-chapter="goWrite"
      />
      <template v-else-if="activeTab === 'writer'">
        <div v-if="!workbenchLayoutReady" class="page-loading">{{ t('common.loading') }}</div>
        <NovelWorkbenchShell v-else-if="workbenchLayout === 'split'" :tree-visible="workbenchTree">
          <NovelChapterWriterPanel
            ref="writerRef"
            :novel="novel"
            :initial-chapter-no="writerChapter || undefined"
            :annotations="chapterAnnotations"
            :foreshadows="workbenchForeshadows"
            :annotations-enabled="annotationsEnabled"
            :foreshadow-enabled="foreshadowEnabled"
            @refresh="refreshAll"
            @chapter-change="onWriterChapterChange"
            @selection="onSelection"
            @annotate="requestAnnotation"
            @active-annotation="activeAnnotationId = $event"
            @open-foreshadows="openForeshadows"
            @chapter-jump="jumpToChapter"
          />
          <template #tree>
            <NovelChapterTree
              :chapters="workbenchChapters"
              :current-chapter="writerChapter || 1"
              :loading="workbenchLoading"
              @select="onWriterChapterChange"
            />
          </template>
          <template #inspector>
            <NovelInspector
              :novel-id="Number(novel.id)"
              :chapter-no="writerChapter || 1"
              :chapter-count="Number(novel.numberOfChapters) || 0"
              :annotations="workbenchAnnotations"
              :foreshadows="workbenchForeshadows"
              :characters="workbenchCharacters"
              :selection="annotationSelection"
              :active-id="activeAnnotationId"
              :active-foreshadow-id="activeForeshadowId"
              :draft-nonce="annotationDraftNonce"
              :annotations-enabled="annotationsEnabled"
              :foreshadow-enabled="foreshadowEnabled"
              :auto-extract="foreshadowAutoExtract"
              :section="inspectorSection"
              @changed="refreshWorkbench"
              @locate="locateAnnotation"
              @active="activeAnnotationId = $event"
              @foreshadow-active="activeForeshadowId = $event"
              @jump="jumpToChapter"
              @edit-architecture="setTab('architecture')"
              @update:section="inspectorSection = $event"
            />
          </template>
        </NovelWorkbenchShell>
        <NovelChapterWriterPanel
          v-else-if="workbenchLayout === 'tabs'"
          :novel="novel"
          :initial-chapter-no="writerChapter || undefined"
          @refresh="load"
        />
      </template>
      <InspirationCompass
        v-else-if="activeTab === 'compass'"
        :novel="novel"
        @refresh="load"
      />
      <NovelExportPanel
        v-else-if="activeTab === 'export'"
        :novel="novel"
      />

      <template v-else>
        <p v-if="overviewError" class="panel-error">{{ overviewError }}</p>

        <div class="overview-meta">
          <span class="tag">{{ t(`novels.narrativePerson.${novel.narrativePerson || 'third_limited'}`) }}</span>
          <button type="button" class="btn btn-ghost btn-sm" @click="editPerson">
            {{ t('novels.narrativePerson.change') }}
          </button>
          <span v-if="novel.writingStyle?.name" class="tag">{{ novel.writingStyle.name }}</span>
          <span class="tag">{{ architectureDone }}/7</span>
        </div>

        <div class="detail-grid">
          <article class="card detail-card">
            <div class="detail-card-head">
              <h2>{{ t('novels.detail.settingTitle') }}</h2>
              <button type="button" class="btn btn-ghost btn-sm" @click="settingsOpen = true">
                {{ t('novels.detail.editSetting') }}
              </button>
            </div>
            <p class="detail-stat">{{ t('novels.detail.backgroundLabel') }}</p>
            <p class="detail-hint detail-preview">{{ novel.background || t('novels.detail.notSet') }}</p>
            <p class="detail-stat">{{ t('novels.detail.writingStyleLabel') }}</p>
            <p class="detail-hint detail-preview">
              {{ novel.writingStyle?.prompt || t('novels.detail.notSet') }}
            </p>
          </article>

          <article class="card detail-card">
            <h2>{{ t('novels.detail.progressTitle') }}</h2>
            <div class="detail-progress">
              <div class="detail-progress-number">{{ writtenChapters }}<span>/{{ novel.numberOfChapters || 0 }}</span></div>
              <div class="progress">
                <i :style="{ width: `${progress}%` }"></i>
              </div>
            </div>
            <p class="detail-hint">{{ t('novels.detail.progressHint') }}</p>
            <div class="detail-actions">
              <button type="button" class="btn btn-primary btn-sm" @click="goWrite(nextChapterNo)">
                {{ t('novels.detail.continueWriting') }}
              </button>
            </div>
          </article>

          <article class="card detail-card">
            <h2>{{ t('novels.detail.architectureTitle') }}</h2>
            <p v-if="!architectureDone" class="detail-hint">{{ t('novels.detail.architectureEmpty') }}</p>
            <template v-else>
              <p class="detail-stat">
                {{ t('novels.detail.architectureProgress', { done: architectureDone, total: 7 }) }}
              </p>
              <p v-if="architecturePreview" class="detail-hint detail-preview">{{ architecturePreview }}</p>
            </template>
            <div class="detail-actions">
              <button type="button" class="btn btn-ghost btn-sm" @click="setTab('architecture')">
                {{ architectureDone ? t('novels.detail.viewArchitecture') : t('novels.detail.generateArchitecture') }}
              </button>
              <button
                v-if="architectureDone"
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="actionLoading === 'architecture'"
                @click="regenerateArchitecture"
              >
                {{ t('novels.detail.regenerateArchitecture') }}
              </button>
            </div>
          </article>

          <article class="card detail-card">
            <h2>{{ t('novels.detail.atlasTitle') }}</h2>
            <p class="detail-stat">{{ atlasDone }}/2</p>
            <p v-if="!atlasComplete" class="detail-hint">{{ t('novels.detail.atlasEmpty') }}</p>
            <div class="detail-actions">
              <button type="button" class="btn btn-ghost btn-sm" @click="setTab('architecture')">
                {{ atlasComplete ? t('novels.detail.viewAtlas') : t('novels.detail.generateAtlas') }}
              </button>
            </div>
          </article>

          <article class="card detail-card detail-blueprint-card">
            <div class="detail-card-head">
              <h2>{{ t('novels.detail.blueprintTitle') }}</h2>
              <span v-if="blueprintCount" class="detail-stat">
                {{ t('novels.detail.blueprintCount', { n: blueprintCount }) }}
              </span>
            </div>
            <p v-if="!blueprintCount" class="detail-hint">{{ t('novels.detail.blueprintEmpty') }}</p>
            <ol v-else class="detail-blueprint">
              <li v-for="chapter in novel.blueprintChapters.slice(0, 6)" :key="chapter.number">
                <strong>{{ chapter.number }}. {{ chapter.title }}</strong>
                <span v-if="chapter.summary">{{ chapter.summary }}</span>
              </li>
            </ol>
            <p v-if="blueprintCount > 6" class="detail-hint">
              {{ t('novels.detail.moreBlueprint', { n: blueprintCount - 6 }) }}
            </p>
            <div class="detail-actions">
              <button type="button" class="btn btn-ghost btn-sm" @click="setTab('blueprint')">
                {{ blueprintCount ? t('novels.detail.viewBlueprint') : t('novels.detail.generateBlueprint') }}
              </button>
              <button
                v-if="blueprintCount && blueprintCount < (novel.numberOfChapters || 0)"
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="actionLoading === 'blueprint'"
                @click="continueBlueprint"
              >
                {{ t('novels.detail.continueBlueprint') }}
              </button>
            </div>
          </article>
        </div>

        <article class="card detail-card detail-chapters">
          <h2>{{ t('novels.detail.chapterListTitle') }}</h2>
          <p v-if="!novel.chapters?.length" class="detail-hint">{{ t('novels.detail.chapterEmpty') }}</p>
          <ul v-else>
            <li v-for="chapter in novel.chapters" :key="chapter.id">
              <span class="detail-chapter-no">{{ chapter.chapterNo }}</span>
              <span class="detail-chapter-title">{{ chapter.title || t('novels.detail.untitled') }}</span>
              <span class="detail-chapter-meta">{{ chapter.wordCount ?? 0 }} {{ t('novels.detail.wordUnit') }}</span>
              <span class="detail-chapter-status" :class="chapter.status === 'final' ? 'is-final' : ''">
                {{ t(`novels.chapterStatus.${chapter.status === 'final' ? 'final' : 'draft'}`) }}
              </span>
            </li>
          </ul>
        </article>
      </template>

      <NovelSettingsDialog v-model:open="settingsOpen" :novel="novel" @saved="load" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, BookOpen, PenLine, Settings2, Sparkles } from 'lucide-vue-next'
import { useNovelStore } from '~/stores/novel'
import { novelAPI } from '~/composables/useNovelApi'
import { openAgentDock, useAgentPageAdapter } from '~/composables/useAgentPageAdapter'
import { useAgentSettings } from '~/composables/useAgentSettings'
import InspirationCompass from '~/components/novel/compass/InspirationCompass.vue'
import NovelWorkbenchShell from '~/components/novel/workspace/NovelWorkbenchShell.vue'
import NovelChapterTree from '~/components/novel/workspace/NovelChapterTree.vue'
import NovelInspector from '~/components/novel/workspace/NovelInspector.vue'
import { useNovelWorkbench } from '~/composables/useNovelWorkbench'
import type { NovelSelection, WorkbenchAnnotation } from '~/composables/useNovelWorkbench'
import { toastError } from '~/composables/useToast'

definePageMeta({ layout: 'novel' })

type NovelTab = 'overview' | 'architecture' | 'blueprint' | 'writer' | 'compass' | 'export'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useNovelStore()
const { agentSettings, agentSettingsError, dockEnabled, loadAgentSettings } = useAgentSettings()
const showHeaderAssistant = computed(() =>
  dockEnabled.value && (agentSettings.value !== null || Boolean(agentSettingsError.value)),
)
const layoutSwitching = ref(false)

useAgentPageAdapter({
  id: 'novel-detail',
  match: { name: 'novel-detail', pattern: /^\/novels\/\d+$/ },
  scope: () => {
    const id = Number(route.params.id)
    if (!Number.isSafeInteger(id) || id <= 0) return null
    return { workspace_key: `novel:${id}`, kind: 'novel', novel_id: id }
  },
  entries: ['floating', 'topbar'],
  quickPrompts: () => [t('assistant.prompts.novel1'), t('assistant.prompts.novel2')],
  supportedScopes: ['novel'],
})

const novel = ref<any | null>(null)
const tabs: NovelTab[] = ['overview', 'architecture', 'blueprint', 'writer', 'compass', 'export']
const activeTab = ref<NovelTab>('overview')
const writerChapter = ref<number | null>(1)
const writerRef = ref<any>(null)
const annotationSelection = ref<NovelSelection | null>(null)
const annotationDraftNonce = ref(0)
const activeAnnotationId = ref<number | null>(null)
const activeForeshadowId = ref<number | null>(null)
const inspectorSection = ref<'annotations' | 'foreshadows' | 'characters'>('annotations')
const {
  loading: workbenchLoading,
  chapters: workbenchChapters,
  annotations: workbenchAnnotations,
  settings: workbenchSettings,
  data: workbenchData,
  layout: workbenchLayout,
  layoutReady: workbenchLayoutReady,
  treeVisible: workbenchTree,
  load: loadWorkbench,
  setLayout: setWorkbenchLayout,
} = useNovelWorkbench(Number(route.params.id))

const chapterAnnotations = computed(() =>
  workbenchAnnotations.value.filter((annotation) => annotation.chapter_no === (writerChapter.value || 1)),
)
const workbenchForeshadows = computed<any[]>(() => workbenchData.value?.foreshadows || [])
const workbenchCharacters = computed<any[]>(() => workbenchData.value?.characters || [])
const annotationsEnabled = computed(() => workbenchSettings.value.annotations_enabled !== false)
const foreshadowEnabled = computed(() => workbenchSettings.value.foreshadow_enabled !== false)
const foreshadowAutoExtract = computed(() => workbenchSettings.value.foreshadow_auto_extract === true)

const ARCHITECTURE_FIELDS = [
  'coreSeed', 'characterDynamics', 'characterState', 'worldBuilding', 'plotArchitecture', 'worldMap', 'timeline',
] as const
const writtenChapters = computed(() => (novel.value?.chapters || []).filter((item: any) => item.content?.trim()).length)
const progress = computed(() => {
  const target = Number(novel.value?.numberOfChapters) || 0
  return target ? Math.max(0, Math.min(100, Math.round((writtenChapters.value / target) * 100))) : 0
})
function fieldHasContent(key: string) {
  if (key === 'worldMap') return Boolean(novel.value?.worldMap?.places?.length)
  if (key === 'timeline') return Boolean(novel.value?.timelineEvents?.length)
  return Boolean(String(novel.value?.[key] || '').trim())
}
const architectureDone = computed(() => ARCHITECTURE_FIELDS.filter(fieldHasContent).length)
const atlasDone = computed(() => ['worldMap', 'timeline'].filter(fieldHasContent).length)
const atlasComplete = computed(() => atlasDone.value === 2)
const architecturePreview = computed(() => {
  const seed = String(novel.value?.coreSeed || '').trim()
  return seed.length > 120 ? `${seed.slice(0, 120)}…` : seed
})
const blueprintCount = computed(() => (novel.value?.blueprintChapters || []).length)
const nextChapterNo = computed(() => {
  const target = Number(novel.value?.numberOfChapters) || 0
  const written = new Set(
    (novel.value?.chapters || [])
      .filter((chapter: any) => chapter.content?.trim())
      .map((chapter: any) => Number(chapter.chapterNo)),
  )
  for (let no = 1; no <= target; no += 1) {
    if (!written.has(no)) return no
  }
  return target || 1
})
const actionLoading = ref<'architecture' | 'blueprint' | ''>('')
const overviewError = ref('')
const settingsOpen = ref(false)

watch(() => route.query.tab, (value) => {
  const tab = String(value || 'overview') as NovelTab
  if (tabs.includes(tab)) activeTab.value = tab
}, { immediate: true })

function setTab(tab: NovelTab) {
  activeTab.value = tab
  router.replace({ query: { ...route.query, tab } })
}

function goWrite(chapterNo: number) {
  writerChapter.value = Number(chapterNo) || 1
  annotationSelection.value = null
  activeAnnotationId.value = null
  activeForeshadowId.value = null
  setTab('writer')
}

function onWriterChapterChange(chapterNo: number) {
  const next = Number(chapterNo)
  if (!Number.isSafeInteger(next) || next < 1) return
  if (next !== writerChapter.value) {
    annotationSelection.value = null
    activeAnnotationId.value = null
    activeForeshadowId.value = null
  }
  writerChapter.value = next
}

function jumpToChapter(chapterNo: number) {
  onWriterChapterChange(chapterNo)
}

function onSelection(selection: NovelSelection | null) {
  annotationSelection.value = selection
}

function requestAnnotation() {
  if (!annotationSelection.value) return
  inspectorSection.value = 'annotations'
  annotationDraftNonce.value += 1
}

function openForeshadows(foreshadowId: number) {
  inspectorSection.value = 'foreshadows'
  activeForeshadowId.value = foreshadowId
}

function locateAnnotation(annotation: WorkbenchAnnotation) {
  inspectorSection.value = 'annotations'
  activeAnnotationId.value = annotation.id
  writerRef.value?.locateRange?.(annotation)
}

function refreshWorkbench() {
  void loadWorkbench()
}

function refreshAll() {
  void load()
  void loadWorkbench()
}

async function switchWorkbenchLayout(next: 'split' | 'tabs') {
  if (layoutSwitching.value || workbenchLayout.value === next) return
  layoutSwitching.value = true
  try {
    await novelAPI.saveSettings({ workbench: { layout: next } })
    setWorkbenchLayout(next)
    if (next === 'split') await loadWorkbench()
  } catch (err: any) {
    toastError(err, { fallback: 'errors.unknown' })
  } finally {
    layoutSwitching.value = false
  }
}

async function regenerateArchitecture() {
  if (!novel.value || actionLoading.value) return
  if (!window.confirm(String(t('novels.detail.regenerateArchitectureHint')))) return
  overviewError.value = ''
  actionLoading.value = 'architecture'
  try {
    await novelAPI.startArchitecture(novel.value.id, true)
    setTab('architecture')
  } catch (err: any) {
    overviewError.value = err?.message || String(t('novels.errors.protocol'))
  } finally {
    actionLoading.value = ''
  }
}

async function continueBlueprint() {
  if (!novel.value || actionLoading.value) return
  overviewError.value = ''
  actionLoading.value = 'blueprint'
  try {
    await novelAPI.startBlueprint(novel.value.id)
    setTab('blueprint')
  } catch (err: any) {
    overviewError.value = err?.message || String(t('novels.errors.protocol'))
  } finally {
    actionLoading.value = ''
  }
}

async function editPerson() {
  if (!novel.value) return
  if (!window.confirm(String(t('novels.narrativePerson.changeHint')))) return
  const next = window.prompt(String(t('novels.narrativePerson.prompt')), novel.value.narrativePerson || 'third_limited')
  if (!next || !['first', 'third_limited', 'third_omniscient'].includes(next)) return
  overviewError.value = ''
  try {
    await store.updateNovel(novel.value.id, { narrative_person: next })
    await load()
  } catch (err: any) {
    overviewError.value = err?.message || String(t('novels.errors.protocol'))
  }
}

async function load() {
  const id = Number(route.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return
  try {
    novel.value = await store.fetchNovel(id)
  } catch { /* store.error 已记录 */ }
}

onMounted(async () => {
  void loadAgentSettings()
  await load()
  void loadWorkbench()
})
</script>

<style scoped>
.page {
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow-y: auto;
  padding: 20px 28px 40px;
  color: var(--text-0);
}
.page-loading {
  padding: 80px 0;
  text-align: center;
  color: var(--text-2);
  font-size: 13px;
}
.page-empty {
  padding: 48px 24px;
  text-align: center;
}
.page-empty h1 {
  margin: 0 0 8px;
  font-size: 17px;
  font-weight: 650;
}
.page-empty p {
  margin: 0 0 16px;
  color: var(--text-2);
  font-size: 13px;
}
.page-empty .btn {
  text-decoration: none;
}
.page-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  border-radius: var(--radius-lg);
  margin-bottom: 14px;
}
.back-btn {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: var(--overlay-track);
  color: var(--text-1);
  cursor: pointer;
  transition: background 0.16s var(--ease-out), color 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out);
}
.back-btn:hover {
  background: var(--bg-active);
  color: var(--text-0);
}
.back-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.head-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex-shrink: 0;
}
.layout-switch {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius-pill);
  background: var(--surface-sunken, var(--bg-sunken, var(--bg-base)));
}
.layout-switch-btn {
  padding: 3px 10px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  font-size: var(--text-meta);
  cursor: pointer;
}
.layout-switch-btn:hover { color: var(--text-0); }
.layout-switch-btn.on {
  background: var(--surface-raised);
  color: var(--text-0);
  box-shadow: var(--shadow-sm, none);
}
.layout-switch-btn:disabled { cursor: progress; opacity: 0.7; }
.page-title {
  margin: 0;
  max-width: 100%;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.page-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.meta-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-2);
}
.page-topic {
  flex-basis: 100%;
  margin: 0;
  font-size: 12px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.page-tags {
  flex-basis: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.page-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 14px;
  overflow-x: auto;
}
.tab-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  padding: 8px 4px 10px;
  margin-right: 20px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-2);
  cursor: pointer;
  transition: color 0.16s var(--ease-out);
}
.tab-btn::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: transparent;
  transition: background 0.16s var(--ease-out);
}
.tab-btn:hover {
  color: var(--text-0);
}
.tab-btn.on {
  color: var(--text-0);
  font-weight: 650;
}
.tab-btn.on::after {
  background: var(--accent);
}
.tab-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  font-size: 11px;
  font-weight: 700;
  font-family: var(--font-mono);
  background: var(--bg-2);
  color: var(--text-2);
}
.tab-btn.on .tab-count {
  background: var(--accent-bg);
  color: var(--accent-text);
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.overview-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.detail-blueprint-card {
  grid-column: 1 / -1;
}
.detail-card {
  padding: 16px 18px;
}
.detail-card h2 {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}
.detail-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}
.detail-card-head h2 {
  margin: 0;
}
.detail-stat {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-2);
}
.detail-preview {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.panel-error {
  margin: 0 0 14px;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--error) 45%, transparent);
  background: var(--error-bg);
  color: var(--error);
  font-size: 12.5px;
}
.detail-progress {
  display: flex;
  align-items: center;
  gap: 16px;
}
.detail-progress-number {
  font-size: 26px;
  font-weight: 650;
  color: var(--accent);
}
.detail-progress-number span {
  font-size: 14px;
  color: var(--text-3);
  font-weight: 500;
}
.detail-progress .progress {
  flex: 1;
}
.detail-hint {
  margin: 10px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-3);
}
.detail-blueprint {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 220px;
  overflow-y: auto;
}
.detail-blueprint li {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-2);
}
.detail-blueprint strong {
  display: block;
  color: var(--text-0);
  font-weight: 500;
}
.detail-chapters ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.detail-chapters li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 2px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.detail-chapters li:last-child {
  border-bottom: none;
}
.detail-chapter-no {
  width: 30px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.detail-chapter-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-chapter-meta {
  font-size: 11.5px;
  color: var(--text-3);
}
.detail-chapter-status {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--overlay-track);
  font-size: 11px;
  color: var(--text-2);
}
.detail-chapter-status.is-final {
  background: var(--success-bg);
  color: var(--success);
}
@media (max-width: 760px) {
  .page { padding: 16px 16px 32px; }
  .page-head { flex-wrap: wrap; }
  .detail-grid { grid-template-columns: 1fr; }
  .page-tabs { width: 100%; }
}
</style>
