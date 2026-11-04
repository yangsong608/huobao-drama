<template>
  <section class="novel-panel">
    <header class="panel-head">
      <div>
        <h2>{{ t('novels.architecture.title') }}</h2>
        <p>{{ t('novels.architecture.subtitle') }}</p>
      </div>
      <div class="panel-actions">
        <button v-if="running" type="button" class="btn btn-ghost" @click="cancel">
          {{ t('novels.architecture.cancel') }}
        </button>
        <template v-else>
          <button v-if="!allComplete" type="button" class="btn btn-primary" @click="start(false)">
            {{ t('novels.architecture.generateMissing') }}
          </button>
          <button
            type="button"
            class="btn"
            :class="allComplete ? 'btn-primary' : 'btn-ghost'"
            @click="start(true)"
          >
            {{ t('novels.architecture.regenerateAll') }}
          </button>
          <button type="button" class="btn btn-ghost" @click="startAtlas(true)">
            {{ t('novels.architecture.regenerateAtlas') }}
          </button>
        </template>
      </div>
    </header>

    <p v-if="error" class="panel-error">{{ error }}</p>

    <div v-if="running" class="panel-progress">
      <div class="progress-meta">
        <span>{{ stage?.label || t('novels.architecture.running') }}</span>
        <span v-if="stage && stage.total">{{ stage.current }}/{{ stage.total }}</span>
      </div>
      <div class="progress"><i :style="{ width: `${percent}%` }"></i></div>
    </div>

    <pre v-if="liveText" class="panel-live">{{ liveText }}</pre>

    <p class="arch-select-hint">{{ t('novels.architecture.selectHint') }}</p>

    <div class="arch-layout">
      <aside class="card arch-rail">
        <button
          v-for="field in fields"
          :key="field.key"
          type="button"
          class="arch-rail-item"
          :class="{ on: activeField === field.key }"
          @click="selectField(field.key)"
        >
          <span class="arch-rail-name">{{ t(`novels.architecture.fields.${field.key}`) }}</span>
          <span class="arch-rail-state" :class="{ 'has-content': hasContent(field.key) }">
            {{ hasContent(field.key) ? t('novels.architecture.generated') : t('novels.architecture.notGenerated') }}
          </span>
        </button>
      </aside>

      <article class="card arch-detail">
        <header class="arch-detail-head">
          <div>
            <h3>{{ t(`novels.architecture.fields.${activeField}`) }}</h3>
            <p v-if="editing && activeKind === 'text'" class="arch-edit-hint">{{ t('novels.architecture.editHint') }}</p>
          </div>
          <template v-if="activeKind === 'text'">
            <div v-if="editing" class="arch-detail-actions">
              <button type="button" class="btn btn-ghost btn-sm" :disabled="saving" @click="cancelEdit">
                {{ t('novels.architecture.cancelEdit') }}
              </button>
              <button type="button" class="btn btn-primary btn-sm" :disabled="saving" @click="saveEdit">
                {{ saving ? t('novels.architecture.saving') : t('novels.architecture.save') }}
              </button>
            </div>
            <div v-else class="arch-detail-actions">
              <button type="button" class="btn btn-ghost btn-sm" :disabled="running" @click="startEdit">
                {{ t('novels.architecture.edit') }}
              </button>
            </div>
          </template>
        </header>

        <p v-if="saveError" class="panel-error">{{ saveError }}</p>

        <template v-if="activeKind === 'text'">
          <textarea
            v-if="editing"
            ref="editorRef"
            v-model="draft"
            class="textarea arch-editor"
            spellcheck="false"
          ></textarea>
          <div v-else-if="activeContent" class="md-body arch-markdown" v-html="renderedArchitecture"></div>
          <p v-else class="arch-empty">{{ t('novels.architecture.empty') }}</p>
        </template>
        <template v-else>
          <StoryTimeline
            v-if="activeField === 'timeline'"
            :events="novel.timelineEvents || []"
            :chapter-no="0"
            :editable="!running"
            :max-chapter="novel.numberOfChapters"
            @update:events="saveTimeline"
            @select-chapter="() => {}"
          />
          <WorldMap
            v-else
            :map-data="novel.worldMap"
            :events="novel.timelineEvents || []"
            :chapter-no="0"
            :editable="!running"
            :dark="isDark"
            @update:map-data="saveMap"
          />
        </template>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { camelizeKeys, useNovelStore } from '~/stores/novel'
import { useTheme } from '~/composables/useTheme'
import { novelAPI } from '~/composables/useNovelApi'
import { novelErrorText, useNovelJobStream } from '~/composables/useNovelJobStream'
import { renderNovelMarkdown } from '~/utils/novel-markdown'
import StoryTimeline from '~/components/novel/story/StoryTimeline.vue'
import WorldMap from '~/components/novel/story/WorldMap.vue'

const props = defineProps<{ novel: any }>()
const emit = defineEmits<{ (event: 'refresh'): void }>()

const { t } = useI18n()
const { watch: watchJob, stop } = useNovelJobStream()
const store = useNovelStore()
const { resolvedTheme } = useTheme()
const isDark = computed(() => resolvedTheme.value === 'dark')

const fields = [
  { key: 'coreSeed', kind: 'text' },
  { key: 'characterDynamics', kind: 'text' },
  { key: 'characterState', kind: 'text' },
  { key: 'worldBuilding', kind: 'text' },
  { key: 'plotArchitecture', kind: 'text' },
  { key: 'worldMap', kind: 'atlas' },
  { key: 'timeline', kind: 'atlas' },
] as const

type FieldKey = (typeof fields)[number]['key']

const FIELD_SNAKE: Record<string, string> = {
  coreSeed: 'core_seed',
  characterDynamics: 'character_dynamics',
  characterState: 'character_state',
  worldBuilding: 'world_building',
  plotArchitecture: 'plot_architecture',
}

function firstContentField(): FieldKey {
  return fields.find((field) => hasContent(field.key))?.key || fields[0].key
}

const activeField = ref<FieldKey>(firstContentField())
const editing = ref(false)
const draft = ref('')
const saving = ref(false)
const saveError = ref('')
const editorRef = ref<HTMLTextAreaElement | null>(null)

const running = ref(false)
const jobId = ref<number | null>(null)
const stage = ref<{ label: string; current: number; total: number } | null>(null)
const stageKey = ref('')
const liveText = ref('')
const error = ref('')

const percent = computed(() => {
  if (!stage.value || !stage.value.total) return running.value ? 8 : 0
  return Math.max(0, Math.min(100, Math.round((stage.value.current / stage.value.total) * 100)))
})
const activeKind = computed(() => fields.find((field) => field.key === activeField.value)?.kind || 'text')
const missingSteps = computed(() => fields.filter((field) => !hasContent(field.key)))
const allComplete = computed(() => missingSteps.value.length === 0)
const activeContent = computed(() => activeKind.value === 'text' ? String(props.novel[activeField.value] || '') : '')
const renderedArchitecture = computed(() => renderNovelMarkdown(activeContent.value))
const draftDirty = computed(() => draft.value !== activeContent.value)

function hasContent(key: string) {
  if (key === 'worldMap') return Boolean(props.novel.worldMap?.places?.length)
  if (key === 'timeline') return Boolean(props.novel.timelineEvents?.length)
  return Boolean(String(props.novel[key] || '').trim())
}

function confirmDiscard() {
  if (!draftDirty.value) return true
  return window.confirm(String(t('novels.architecture.unsavedConfirm')))
}

function selectField(key: FieldKey) {
  if (key === activeField.value) return
  if (editing.value && !confirmDiscard()) return
  activeField.value = key
  editing.value = false
  saveError.value = ''
}

function startEdit() {
  if (running.value) return
  draft.value = activeContent.value
  editing.value = true
  saveError.value = ''
  nextTick(() => editorRef.value?.focus())
}

function cancelEdit() {
  if (!confirmDiscard()) return
  editing.value = false
  saveError.value = ''
}

async function saveEdit() {
  if (saving.value) return
  if (!draftDirty.value) {
    editing.value = false
    return
  }
  saving.value = true
  saveError.value = ''
  try {
    await novelAPI.update(props.novel.id, { [FIELD_SNAKE[activeField.value]]: draft.value })
    editing.value = false
    emit('refresh')
  } catch (err: any) {
    saveError.value = err?.message || String(t('novels.architecture.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function saveTimeline(events: any[]) {
  try {
    await store.saveStoryAtlas(props.novel.id, {
      timeline_events: events,
      base_updated_at: props.novel.updatedAt,
    })
    saveError.value = ''
  } catch (err: any) {
    saveError.value = err?.message || String(t('novels.architecture.saveFailed'))
  }
  emit('refresh')
}

async function saveMap(worldMap: any) {
  try {
    await store.saveStoryAtlas(props.novel.id, {
      world_map: worldMap,
      base_updated_at: props.novel.updatedAt,
    })
    saveError.value = ''
  } catch (err: any) {
    saveError.value = err?.message || String(t('novels.architecture.saveFailed'))
  }
  emit('refresh')
}

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
      stageKey.value = next.stage
      stage.value = { label: next.label, current: next.current, total: next.total }
      liveText.value = ''
      if (next.stage === 'worldMap' || next.stage === 'timeline') {
        stage.value = { ...stage.value, label: t('novels.architecture.structuredRunning') }
      }
    },
    onDelta(text: string) {
      if (stageKey.value === 'worldMap' || stageKey.value === 'timeline') return
      liveText.value += text
    },
    onDone() {
      running.value = false
      stage.value = null
      stageKey.value = ''
      liveText.value = ''
      emit('refresh')
    },
    onError(failure: any) {
      running.value = false
      stageKey.value = ''
      error.value = novelErrorText(t, failure.code, failure.message)
      emit('refresh')
    },
  }
}

async function start(force: boolean) {
  if (running.value) return
  if (editing.value && !confirmDiscard()) return
  if (force && !window.confirm(String(t('novels.architecture.forceHint')))) return
  editing.value = false
  error.value = ''
  liveText.value = ''
  stageKey.value = ''
  stage.value = null
  running.value = true
  try {
    const data: any = await novelAPI.startArchitecture(props.novel.id, force)
    jobId.value = data.job_id
    await watchJob(data.job_id, handlers())
  } catch (err: any) {
    error.value = err?.message || String(t('novels.errors.protocol'))
  } finally {
    running.value = false
  }
}

async function startAtlas(force: boolean) {
  if (running.value) return
  if (editing.value && !confirmDiscard()) return
  if (force && !window.confirm(String(t('novels.architecture.forceHint')))) return
  editing.value = false
  error.value = ''
  liveText.value = ''
  stageKey.value = ''
  stage.value = null
  running.value = true
  try {
    const data: any = await novelAPI.startStoryAtlas(props.novel.id, force)
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
    // 取消失败也停止本地订阅，避免界面卡在生成中
  }
  stop()
  running.value = false
  stage.value = null
  liveText.value = ''
}

onMounted(async () => {
  try {
    const data: any = await novelAPI.jobs(props.novel.id, 'running')
    const items = Array.isArray(data?.items) ? data.items : []
    const job = items.map((item: any) => camelizeKeys(item))
      .find((item: any) => item.type === 'architecture' || item.type === 'atlas')
    if (!job) return
    running.value = true
    jobId.value = job.id
    await watchJob(job.id, handlers())
  } catch {
    // 恢复进度失败不阻塞面板
  }
})

onBeforeUnmount(stop)
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
  line-height: 1.6;
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
  max-height: 220px;
  overflow: auto;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-active, rgba(255, 255, 255, 0.04));
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.arch-select-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.arch-layout {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.arch-rail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
}
.arch-rail-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--text-1);
  text-align: left;
  cursor: pointer;
  transition: background 0.16s var(--ease-out), color 0.16s var(--ease-out);
}
.arch-rail-item:hover {
  background: var(--bg-active);
  color: var(--text-0);
}
.arch-rail-item.on {
  background: var(--accent-bg);
  color: var(--accent-text);
  font-weight: 600;
}
.arch-rail-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.arch-rail-state {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-3);
}
.arch-rail-state.has-content {
  color: var(--success);
}
.arch-rail-item.on .arch-rail-state {
  color: var(--accent-text);
}
.arch-detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 340px;
  padding: 16px 18px;
}
.arch-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.arch-detail-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
.arch-detail-actions {
  display: flex;
  gap: 8px;
}
.arch-edit-hint {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.arch-editor {
  min-height: 360px;
  padding: 14px 16px;
  font-size: 13px;
  line-height: 1.8;
  resize: vertical;
}
.arch-empty {
  margin: 0;
  padding: 48px 0;
  text-align: center;
  color: var(--text-3);
  font-size: 12.5px;
}
.arch-markdown {
  min-height: 240px;
}
@media (max-width: 860px) {
  .arch-layout {
    grid-template-columns: 1fr;
  }
  .arch-rail {
    flex-direction: row;
    overflow-x: auto;
  }
  .arch-rail-item {
    min-width: 170px;
  }
}
</style>
