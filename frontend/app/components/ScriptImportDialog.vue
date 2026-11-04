<template>
  <div v-if="open" class="overlay" @click.self="close">
    <div class="dialog import-dialog">
      <div class="dialog-head">
        <div class="dialog-head-copy">
          <div class="dialog-title">{{ t('scriptImport.title') }}</div>
          <div class="dialog-desc">{{ t('scriptImport.desc') }}</div>
        </div>
        <button class="btn btn-icon btn-sm btn-ghost ml-auto dialog-close" @click="close">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="dialog-body import-body">
        <div class="import-input">
          <label class="field">
            <span class="field-label">{{ t('scriptImport.file') }}</span>
            <div class="import-file-row">
              <button class="btn" :disabled="parsing" @click="fileInput?.click()">{{ t('scriptImport.pickFile') }}</button>
              <span class="field-hint">{{ fileName || t('scriptImport.fileHint') }}</span>
              <input ref="fileInput" class="hidden-file" type="file" accept=".txt,.md,text/plain,text/markdown" @change="pickFile" />
            </div>
          </label>
          <label class="field">
            <span class="field-label">{{ t('scriptImport.text') }}</span>
            <textarea v-model="text" class="textarea import-text" rows="12" maxlength="2000000" :placeholder="t('scriptImport.placeholder')" />
            <span class="field-hint">{{ t('scriptImport.charCount', { n: text.length }) }}</span>
          </label>
          <div class="import-actions">
            <button class="btn btn-primary" :disabled="parsing || !text.trim()" @click="parse">
              {{ parsing ? t('scriptImport.parsing') : t('scriptImport.parse') }}
            </button>
            <span v-if="result" class="field-hint">
              {{ t('scriptImport.summary', { chapters: result.chapter_count, episodes: result.episode_count }) }}
            </span>
          </div>
        </div>

        <div v-if="result" class="import-preview">
          <div class="import-preview-head">
            <span>{{ t('scriptImport.preview') }}</span>
            <span class="tag">{{ result.existing ? t('scriptImport.reused') : t('scriptImport.newImport') }}</span>
          </div>
          <div class="import-plans">
            <div v-for="(plan, index) in result.plans" :key="index" class="import-plan">
              <span class="import-plan-no">EP{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="import-plan-title" :title="plan.title">{{ plan.title }}</span>
              <span class="import-plan-meta mono">{{ plan.char_count }} 字 · {{ plan.chapters.length }} 章</span>
            </div>
          </div>
          <div class="import-options">
            <label class="import-option">
              <input v-model="mode" type="radio" value="append" />
              <span>{{ t('scriptImport.modeAppend') }}</span>
            </label>
            <label class="import-option">
              <input v-model="mode" type="radio" value="replace" />
              <span>{{ t('scriptImport.modeReplace') }}</span>
            </label>
            <label class="import-option">
              <input v-model="autoPipeline" type="checkbox" />
              <span>{{ t('scriptImport.autoPipeline') }}</span>
            </label>
            <label class="import-option">
              <input v-model="autoDub" type="checkbox" :disabled="!autoPipeline" />
              <span>{{ t('scriptImport.autoDub') }}</span>
            </label>
          </div>
          <p v-if="mode === 'replace'" class="import-warn">{{ t('scriptImport.replaceWarn') }}</p>
        </div>
      </div>

      <div class="dialog-foot">
        <span class="dialog-foot-copy">{{ t('scriptImport.foot') }}</span>
        <button class="btn" @click="close">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" :disabled="committing || !result" @click="commit">
          {{ committing ? t('scriptImport.committing') : t('scriptImport.commit') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { scriptImportAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const props = defineProps<{ open: boolean; dramaId: number }>()
const emit = defineEmits<{ close: []; done: [] }>()
const { t } = useI18n()

const fileInput = ref<HTMLInputElement | null>(null)
const text = ref('')
const fileName = ref('')
const parsing = ref(false)
const committing = ref(false)
const result = ref<any>(null)
const mode = ref<'append' | 'replace'>('append')
const autoPipeline = ref(false)
const autoDub = ref(false)

async function pickFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 2 * 1024 * 1024) { toast.error(t('scriptImport.tooLarge')); return }
  try {
    parsing.value = true
    fileName.value = file.name
    const parsed = await scriptImportAPI.parseFile(props.dramaId, file)
    result.value = parsed
    toast.success(t('scriptImport.parsed'))
  } catch (error) {
    toastError(error)
  } finally {
    parsing.value = false
  }
}

async function parse() {
  if (parsing.value) return
  parsing.value = true
  try {
    result.value = await scriptImportAPI.parseText(props.dramaId, text.value, fileName.value || undefined)
    toast.success(t('scriptImport.parsed'))
  } catch (error) {
    toastError(error)
  } finally {
    parsing.value = false
  }
}

async function commit() {
  if (!result.value || committing.value) return
  committing.value = true
  try {
    const res = await scriptImportAPI.commit(props.dramaId, {
      import_id: result.value.import_id,
      mode: mode.value,
      auto_pipeline: autoPipeline.value,
      auto_dub: autoPipeline.value && autoDub.value,
    })
    toast.success(t('scriptImport.committed', { n: res?.episode_ids?.length || 0 }))
    emit('done')
    close()
  } catch (error) {
    toastError(error)
  } finally {
    committing.value = false
  }
}

function close() {
  if (committing.value) return
  emit('close')
}
</script>

<style scoped>
.import-dialog { width: min(980px, 94vw); max-height: 90vh; }
.import-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; overflow: auto; }
.import-input { display: flex; flex-direction: column; gap: 12px; }
.import-file-row { display: flex; align-items: center; gap: 10px; }
.hidden-file { display: none; }
.import-text { min-height: 320px; font-family: var(--font-mono, monospace); font-size: 12px; }
.import-actions { display: flex; align-items: center; gap: 10px; }
.import-preview { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.import-preview-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; font-weight: 600; color: var(--text-1); }
.import-plans { display: flex; flex-direction: column; gap: 6px; max-height: 380px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
.import-plan { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 8px; font-size: 12px; padding: 4px 2px; border-bottom: 1px dashed var(--border); }
.import-plan:last-child { border-bottom: none; }
.import-plan-no { color: var(--text-3); font-size: 11px; }
.import-plan-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-1); }
.import-plan-meta { color: var(--text-3); font-size: 11px; }
.import-options { display: flex; flex-wrap: wrap; gap: 8px 16px; }
.import-option { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-2); }
.import-warn { margin: 0; font-size: 11px; color: var(--action-warning, #c48a1b); }
@media (max-width: 820px) {
  .import-body { grid-template-columns: 1fr; }
}
</style>
