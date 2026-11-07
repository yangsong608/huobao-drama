<template>
  <div v-if="open" class="overlay" @click.self="close">
    <div class="dialog" style="width: min(640px, calc(100vw - 40px))" role="dialog" aria-modal="true" :aria-label="t('novels.import.title')">
      <div class="dialog-head">
        <div>
          <h2 class="dialog-title">
            <Clapperboard :size="16" :stroke-width="1.8" />
            {{ t('novels.import.title') }}
          </h2>
          <p class="dialog-sub">{{ t('novels.import.subtitle') }}</p>
        </div>
        <button type="button" class="btn btn-icon btn-sm ml-auto" :aria-label="t('common.close')" @click="close">
          <X :size="16" :stroke-width="1.8" />
        </button>
      </div>

      <form class="dialog-form" @submit.prevent="submit">
      <div class="dialog-body">
        <label class="field">
          <span class="field-label">{{ t('novels.import.targetTitle') }}</span>
          <input ref="titleInput" v-model.trim="form.title" class="input" maxlength="120" />
        </label>

        <div class="field-row">
          <label class="field">
            <span class="field-label">{{ t('novels.import.aspectRatio') }}</span>
            <BaseSelect v-model="form.aspectRatio" :options="aspectOptions" :searchable="false" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('novels.import.style') }}</span>
            <BaseSelect v-model="form.style" :options="styleOptions" :searchable="false" />
          </label>
        </div>

        <section class="import-section">
          <div class="import-section-head">
            <span>{{ t('novels.import.chapters') }}</span>
            <div class="import-section-actions">
              <label class="import-inline-check">
                <input v-model="form.includeDraft" type="checkbox" />
                {{ t('novels.import.includeDraft') }}
              </label>
              <button type="button" class="import-link" @click="selectAll">{{ t('novels.import.selectAll') }}</button>
              <button type="button" class="import-link" @click="selectNone">{{ t('novels.import.selectNone') }}</button>
            </div>
          </div>
          <p v-if="!eligibleChapters.length" class="import-hint">{{ t('novels.import.empty') }}</p>
          <div v-else class="import-chapters">
            <label v-for="chapter in eligibleChapters" :key="chapter.chapterNo" class="import-chapter">
              <input v-model="selectedChapters" type="checkbox" :value="chapter.chapterNo" />
              <span class="import-chapter-no">{{ chapter.chapterNo }}</span>
              <span class="import-chapter-title">{{ chapter.title || t('novels.detail.untitled') }}</span>
              <span class="import-chapter-meta">{{ chapter.wordCount ?? 0 }} {{ t('novels.detail.wordUnit') }}</span>
              <span class="import-chapter-status" :class="{ 'is-final': chapter.status === 'final' }">
                {{ t(`novels.chapterStatus.${chapter.status === 'final' ? 'final' : 'draft'}`) }}
              </span>
            </label>
          </div>
          <p class="import-hint">{{ t('novels.import.selected', { n: selectedChapters.length }) }}</p>
        </section>

        <div class="field-row">
          <label class="field">
            <span class="field-label">{{ t('novels.import.splitMode') }}</span>
            <BaseSelect v-model="form.splitMode" :options="splitOptions" :searchable="false" />
          </label>
          <label v-if="form.splitMode === 'words'" class="field">
            <span class="field-label">{{ t('novels.import.targetWords') }}</span>
            <input v-model.number="form.targetWords" class="input" type="number" min="600" max="5000" step="100" />
          </label>
        </div>

        <p class="import-hint">
          {{ form.splitMode === 'words' ? t('novels.import.targetWordsHint') : t('novels.import.chapterModeHint') }}
        </p>

        <label class="field">
          <span class="field-label">{{ t('novels.import.backgroundMode') }}</span>
          <BaseSelect v-model="form.backgroundMode" :options="backgroundOptions" :searchable="false" />
          <span v-if="form.backgroundMode === 'ai'" class="import-hint">{{ t('novels.import.backgroundAiHint') }}</span>
        </label>

        <section v-if="contextPackEnabled" class="import-section">
          <div class="import-section-head">
            <label class="import-inline-check">
              <input v-model="form.includeContextPack" type="checkbox" />
              {{ t('novels.import.contextPack') }}
            </label>
            <div v-if="form.includeContextPack" class="import-context-actions">
              <label class="import-budget">
                <span>{{ t('novels.import.contextPackBudget') }}</span>
                <input v-model.number="form.contextPackMaxChars" class="input" type="number" min="500" max="20000" step="100" />
              </label>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="contextPackLoading || !selectedChapters.length"
                @click="previewContextPack"
              >
                <Loader2 v-if="contextPackLoading" :size="13" class="animate-spin" />
                {{ contextPackLoading ? t('novels.import.contextPackPreviewing') : t('novels.import.contextPackPreview') }}
              </button>
            </div>
          </div>
          <p class="import-hint">{{ t('novels.import.contextPackHint') }}</p>
          <p v-if="contextPackError" class="form-error">{{ contextPackError }}</p>
        </section>

        <section class="import-section import-actions">
          <label class="import-inline-check">
            <input v-model="form.autoExtract" type="checkbox" />
            {{ t('novels.import.autoExtract') }}
          </label>
          <label class="import-inline-check" :class="{ disabled: !canAutoPipeline }">
            <input v-model="form.autoPipeline" type="checkbox" :disabled="!canAutoPipeline" />
            {{ t('novels.import.autoPipeline') }}
          </label>
          <p v-if="!canAutoPipeline" class="import-hint">{{ t('novels.import.autoPipelineHint') }}</p>
        </section>

        <div class="import-preview">
          <span v-if="loadingPreview" class="import-hint">{{ t('novels.import.previewing') }}</span>
          <span v-else-if="preview">
            {{ t('novels.import.preview', { episodes: preview.episode_count, chapters: selectedChapters.length }) }}
          </span>
          <span v-if="preview?.existing_imports" class="import-hint">
            {{ t('novels.import.existing', { n: preview.existing_imports }) }}
          </span>
        </div>

        <p v-if="errorText" class="form-error">{{ errorText }}</p>

        </div>

        <div class="dialog-foot">
          <button type="button" class="btn" :disabled="submitting" @click="close">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="submitting || !selectedChapters.length">
            <Loader2 v-if="submitting" :size="13" class="animate-spin" />
            {{ submitting ? t('novels.import.submitting') : t('novels.import.submit') }}
          </button>
        </div>
      </form>
    </div>
  </div>

  <div v-if="open && contextPackOpen" class="overlay" @click.self="contextPackOpen = false">
    <div class="dialog" style="width: min(720px, calc(100vw - 40px))" role="dialog" aria-modal="true" :aria-label="t('novels.import.contextPackPreviewTitle')">
      <div class="dialog-head">
        <div>
          <h3 class="dialog-title">{{ t('novels.import.contextPackPreviewTitle') }}</h3>
          <p class="dialog-sub">
            {{ t('novels.import.contextPackPreviewMeta', {
              chars: contextPackPreview?.chars || 0,
              chapters: contextPackPreview?.included?.chapters || 0,
              annotations: contextPackPreview?.included?.annotations || 0,
              foreshadows: contextPackPreview?.included?.foreshadows || 0,
            }) }}
            <span v-if="contextPackPreview?.truncated"> · {{ t('novels.import.contextPackTruncated') }}</span>
          </p>
        </div>
        <button type="button" class="btn btn-icon btn-sm ml-auto" :aria-label="t('common.close')" @click="contextPackOpen = false">
          <X :size="16" :stroke-width="1.8" />
        </button>
      </div>
      <div class="dialog-body">
        <p v-if="contextPackError" class="form-error">{{ contextPackError }}</p>
        <p v-if="!contextPackPreview?.text" class="import-hint">{{ t('novels.import.contextPackEmpty') }}</p>
        <pre v-else class="context-pack-text">{{ contextPackPreview.text }}</pre>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" @click="contextPackOpen = false">{{ t('common.close') }}</button>
        <button type="button" class="btn btn-primary" :disabled="!contextPackPreview?.text" @click="copyContextPack">
          {{ contextPackCopied ? t('novels.import.contextPackCopied') : t('novels.import.contextPackCopy') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clapperboard, Loader2, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { aiConfigAPI, stylePresetAPI } from '~/composables/useApi'
import { novelAPI } from '~/composables/useNovelApi'

const props = defineProps<{ open: boolean; novel: any }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  imported: [payload: { importId: number; dramaId: number; episodeCount: number }]
}>()
const { t } = useI18n()

const titleInput = ref<HTMLInputElement>()
const stylePresets = ref<any[]>([])
const preview = ref<any>(null)
const loadingPreview = ref(false)
const submitting = ref(false)
const errorText = ref('')
const requestId = ref('')
const selectedChapters = ref<number[]>([])
const textReady = ref(false)
const imageReady = ref(false)
const videoReady = ref(false)
const contextPackEnabled = ref(true)
const contextPackOpen = ref(false)
const contextPackLoading = ref(false)
const contextPackCopied = ref(false)
const contextPackError = ref('')
const contextPackPreview = ref<any>(null)
let copyTimer: ReturnType<typeof setTimeout> | null = null
let previewTimer: ReturnType<typeof setTimeout> | null = null
let previewSeq = 0

const form = reactive({
  title: '',
  aspectRatio: '16:9',
  style: '3d',
  splitMode: 'words' as 'words' | 'chapter',
  targetWords: 1200,
  includeDraft: true,
  backgroundMode: 'rule' as 'rule' | 'ai' | 'none',
  autoExtract: false,
  autoPipeline: false,
  includeContextPack: false,
  contextPackMaxChars: 4000,
})

const chapters = computed<any[]>(() => Array.isArray(props.novel?.chapters) ? props.novel.chapters : [])
const eligibleChapters = computed(() => chapters.value.filter((chapter) => {
  if (!String(chapter.content || '').trim()) return false
  return form.includeDraft || chapter.status === 'final'
}))
const canAutoPipeline = computed(() => textReady.value && imageReady.value && videoReady.value)
const aspectOptions = [
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
]
const splitOptions = computed(() => [
  { label: t('novels.import.splitWords'), value: 'words' },
  { label: t('novels.import.splitChapter'), value: 'chapter' },
])
const styleOptions = computed(() => {
  const list = stylePresets.value.map((preset) => ({ label: preset.name || preset.value, value: preset.value }))
  return list.length ? list : [{ label: '3D', value: '3d' }]
})
const backgroundOptions = computed(() => {
  const list = [
    { label: t('novels.import.backgroundRule'), value: 'rule' },
    { label: t('novels.import.backgroundNone'), value: 'none' },
  ]
  if (textReady.value) list.splice(1, 0, { label: t('novels.import.backgroundAi'), value: 'ai' })
  return list
})

function newRequestId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `novel-import-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function selectAll() {
  selectedChapters.value = eligibleChapters.value.map((chapter) => chapter.chapterNo)
}

function selectNone() {
  selectedChapters.value = []
}

function close() {
  if (submitting.value) return
  emit('update:open', false)
}

function schedulePreview() {
  if (!props.open) return
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(loadPreview, 220)
}

async function loadPreview() {
  if (!selectedChapters.value.length) {
    preview.value = null
    loadingPreview.value = false
    return
  }
  const seq = ++previewSeq
  loadingPreview.value = true
  try {
    const data: any = await novelAPI.previewImport(props.novel.id, {
      chapter_nos: [...selectedChapters.value].sort((a, b) => a - b),
      split_mode: form.splitMode,
      target_words: form.targetWords,
      include_draft: form.includeDraft,
    })
    if (seq === previewSeq) preview.value = data
  } catch {
    if (seq === previewSeq) preview.value = null
  } finally {
    if (seq === previewSeq) loadingPreview.value = false
  }
}

async function loadResources() {
  const [presets, configs, settings] = await Promise.all([
    stylePresetAPI.list().catch(() => []),
    aiConfigAPI.list().catch(() => []),
    novelAPI.settings().catch(() => null),
  ])
  stylePresets.value = Array.isArray(presets) ? presets : []
  const active = (type: string) => (configs || []).some(
    (config: any) => config.service_type === type && Boolean(config.is_active),
  )
  textReady.value = active('text')
  imageReady.value = active('image')
  videoReady.value = active('video')
  if (stylePresets.value.length && !stylePresets.value.some((preset) => preset.value === form.style)) {
    form.style = stylePresets.value[0].value
  }
  const contextPack = (settings as any)?.settings?.contextPack
  contextPackEnabled.value = contextPack?.enabled !== false
  form.includeContextPack = contextPackEnabled.value
  const maxChars = Number(contextPack?.maxChars)
  form.contextPackMaxChars = Number.isFinite(maxChars)
    ? Math.min(20000, Math.max(500, Math.round(maxChars)))
    : 4000
}

async function init() {
  form.title = t('novels.import.titleTemplate', { title: props.novel?.title || '' })
  form.aspectRatio = '16:9'
  form.style = '3d'
  form.splitMode = 'words'
  form.targetWords = 1200
  form.includeDraft = true
  form.backgroundMode = 'rule'
  form.autoExtract = false
  form.autoPipeline = false
  form.includeContextPack = false
  form.contextPackMaxChars = 4000
  preview.value = null
  errorText.value = ''
  contextPackOpen.value = false
  contextPackPreview.value = null
  contextPackError.value = ''
  contextPackCopied.value = false
  requestId.value = newRequestId()
  selectedChapters.value = eligibleChapters.value.map((chapter) => chapter.chapterNo)
  await Promise.all([loadResources(), nextTick()])
  titleInput.value?.focus()
  schedulePreview()
}

watch(() => props.open, (open) => {
  if (open) void init()
})
watch(() => form.includeDraft, () => {
  const allowed = new Set(eligibleChapters.value.map((chapter) => chapter.chapterNo))
  selectedChapters.value = selectedChapters.value.filter((chapterNo) => allowed.has(chapterNo))
})
watch(textReady, (ready) => {
  if (!ready && form.backgroundMode === 'ai') form.backgroundMode = 'rule'
})
watch(() => [form.splitMode, form.targetWords, form.includeDraft], schedulePreview)
watch(selectedChapters, schedulePreview, { deep: true })
watch(canAutoPipeline, (ready) => {
  if (!ready) form.autoPipeline = false
})
watch(contextPackEnabled, (enabled) => {
  if (!enabled) {
    form.includeContextPack = false
    contextPackOpen.value = false
    contextPackPreview.value = null
  }
})

onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer)
  if (copyTimer) clearTimeout(copyTimer)
})

async function previewContextPack() {
  if (!selectedChapters.value.length || contextPackLoading.value) return
  contextPackError.value = ''
  contextPackLoading.value = true
  try {
    const data: any = await novelAPI.contextPackPreview(props.novel.id, {
      chapter_nos: [...selectedChapters.value].sort((a, b) => a - b),
      max_chars: form.contextPackMaxChars,
    })
    contextPackPreview.value = data
    contextPackOpen.value = true
  } catch (error: any) {
    contextPackError.value = error?.message || t('novels.import.contextPackFailed')
  } finally {
    contextPackLoading.value = false
  }
}

async function copyContextPack() {
  const text = String(contextPackPreview.value?.text || '')
  if (!text) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(text)
    contextPackCopied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { contextPackCopied.value = false }, 1600)
  } catch {
    contextPackError.value = t('novels.import.contextPackCopyFailed')
  }
}

async function submit() {
  errorText.value = ''
  if (!selectedChapters.value.length) {
    errorText.value = t('novels.import.empty')
    return
  }
  submitting.value = true
  try {
    const result: any = await novelAPI.importToDrama(props.novel.id, {
      request_id: requestId.value,
      title: form.title || undefined,
      aspect_ratio: form.aspectRatio,
      style: form.style || undefined,
      chapter_nos: [...selectedChapters.value].sort((a, b) => a - b),
      split_mode: form.splitMode,
      target_words: form.splitMode === 'words' ? form.targetWords : undefined,
      include_draft: form.includeDraft,
      background_mode: form.backgroundMode,
      auto_extract: form.autoExtract,
      auto_pipeline: canAutoPipeline.value && form.autoPipeline,
      include_context_pack: contextPackEnabled.value && form.includeContextPack,
      context_pack_max_chars: contextPackEnabled.value && form.includeContextPack
        ? form.contextPackMaxChars
        : undefined,
    })
    const pack = result.context_pack
    toast.success(pack
      ? t('novels.import.successWithContextPack', {
        episodes: result.episode_count,
        chars: pack.chars,
        chapters: pack.included?.chapters ?? 0,
        annotations: pack.included?.annotations ?? 0,
        foreshadows: pack.included?.foreshadows ?? 0,
      })
      : t('novels.import.success', { episodes: result.episode_count }))
    if (Array.isArray(result.warnings) && result.warnings.length) {
      toast.warning(result.warnings.join('；'))
    }
    emit('imported', {
      importId: result.import_id,
      dramaId: result.drama_id,
      episodeCount: result.episode_count,
    })
    emit('update:open', false)
  } catch (error: any) {
    errorText.value = error?.message || t('novels.import.failed')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.import-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-hover);
  font-size: 12.5px;
  color: var(--text-2);
}
.import-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.import-section-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.import-inline-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-1);
  cursor: pointer;
}
.import-inline-check.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.import-context-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.import-budget {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-1);
}
.import-budget .input {
  width: 96px;
  padding: 4px 8px;
  font-size: 12px;
}
.context-pack-text {
  margin: 0;
  max-height: 52vh;
  overflow: auto;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-base);
  color: var(--text-1);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.import-link {
  border: none;
  background: transparent;
  color: var(--accent-text);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}
.import-chapters {
  display: flex;
  flex-direction: column;
  max-height: 190px;
  overflow-y: auto;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg-base);
}
.import-chapter {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.import-chapter:last-child {
  border-bottom: none;
}
.import-chapter-no {
  min-width: 24px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.import-chapter-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-0);
}
.import-chapter-meta {
  color: var(--text-3);
  font-size: 11.5px;
}
.import-chapter-status {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-active);
  color: var(--text-3);
  font-size: 11px;
}
.import-chapter-status.is-final {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 14%, transparent);
}
.import-hint {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.5;
}
.import-preview {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-height: 18px;
  padding: 2px 2px 0;
  color: var(--text-2);
  font-size: 12.5px;
}
</style>
