<template>
  <div v-if="open" class="overlay" @click.self="close">
    <div class="dialog" style="width: min(600px, calc(100vw - 40px))" role="dialog" aria-modal="true" :aria-label="t('novels.settingsDialog.title')">
      <div class="dialog-head">
        <div>
          <h2 class="dialog-title">
            <Settings2 :size="16" :stroke-width="1.8" />
            {{ t('novels.settingsDialog.title') }}
          </h2>
          <p class="dialog-sub">{{ t('novels.settingsDialog.subtitle') }}</p>
        </div>
        <button type="button" class="btn btn-icon btn-sm ml-auto" :aria-label="t('common.close')" @click="close">
          <X :size="16" :stroke-width="1.8" />
        </button>
      </div>

      <form class="dialog-form" @submit.prevent="submit">
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">{{ t('novels.settingsDialog.titleLabel') }}</span>
            <input v-model.trim="form.title" class="input" maxlength="120" />
          </label>

          <label class="field">
            <span class="field-label">{{ t('novels.createDialog.topicLabel') }}</span>
            <input v-model.trim="form.topic" class="input" :placeholder="t('novels.createDialog.topicPlaceholder')" maxlength="300" />
          </label>

          <label class="field">
            <span class="field-label">{{ t('novels.createDialog.backgroundLabel') }}</span>
            <textarea
              v-model.trim="form.background"
              class="textarea"
              :placeholder="t('novels.createDialog.backgroundPlaceholder')"
              rows="4"
              maxlength="2000"
            />
          </label>

          <div class="field">
            <span class="field-label">{{ t('novels.createDialog.genreLabel') }}</span>
            <div class="genre-chips">
              <button
                v-for="preset in genrePresets"
                :key="preset.value"
                type="button"
                class="genre-chip"
                :class="{ on: form.genres.includes(preset.value) }"
                @click="toggleGenre(preset.value)"
              >{{ t(preset.labelKey) }}</button>
            </div>
            <input
              v-model.trim="form.genreCustom"
              class="input"
              :placeholder="t('novels.createDialog.genreCustomPlaceholder')"
              maxlength="120"
            />
          </div>

          <div class="field">
            <span class="field-label">{{ t('novels.createDialog.writingStyleLabel') }}</span>
            <BaseSelect v-model="form.writingStyleKey" :options="writingStyleOptions" :searchable="false" />
            <textarea
              v-if="form.writingStyleKey === CUSTOM_STYLE_KEY"
              v-model.trim="form.customStylePrompt"
              class="textarea"
              rows="3"
              maxlength="2000"
              :placeholder="t('novels.createDialog.writingStyleCustomPlaceholder')"
            />
            <span class="field-hint">{{ t('novels.createDialog.writingStyleHint') }}</span>
          </div>

          <p v-if="errorText" class="form-error">{{ errorText }}</p>
        </div>

        <div class="dialog-foot">
          <button type="button" class="btn" :disabled="store.saving" @click="close">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="store.saving">
            <Loader2 v-if="store.saving" :size="13" class="animate-spin" />
            {{ store.saving ? t('novels.settingsDialog.saving') : t('novels.settingsDialog.save') }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Settings2, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { useNovelStore } from '~/stores/novel'
import { settingsAPI } from '~/composables/useApi'

const props = defineProps<{ open: boolean; novel: any }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; saved: [novel: any] }>()
const { t } = useI18n()
const store = useNovelStore()

const CUSTOM_STYLE_KEY = '__custom__'
const genrePresets = [
  { value: '都市', labelKey: 'novels.genres.urban' },
  { value: '悬疑', labelKey: 'novels.genres.suspense' },
  { value: '玄幻', labelKey: 'novels.genres.fantasy' },
  { value: '科幻', labelKey: 'novels.genres.scifi' },
  { value: '古风', labelKey: 'novels.genres.classical' },
  { value: '甜宠', labelKey: 'novels.genres.romance' },
  { value: '逆袭', labelKey: 'novels.genres.comeback' },
]
const writingStyles = ref<Array<{ key: string; name: string; prompt: string }>>([])
const errorText = ref('')
const form = reactive({
  title: '',
  topic: '',
  background: '',
  genres: [] as string[],
  genreCustom: '',
  writingStyleKey: '',
  customStylePrompt: '',
})

const writingStyleOptions = computed(() => [
  { label: t('novels.createDialog.writingStyleNone'), value: '' },
  ...writingStyles.value.map((style) => ({ label: style.name, value: style.key })),
  { label: t('novels.createDialog.writingStyleCustom'), value: CUSTOM_STYLE_KEY },
])

function fillFromNovel() {
  const novel = props.novel || {}
  form.title = novel.title || ''
  form.topic = novel.topic || ''
  form.background = novel.background || ''
  const presetValues = new Set(genrePresets.map((preset) => preset.value))
  const genres: string[] = Array.isArray(novel.genre) ? novel.genre : []
  form.genres = genres.filter((item) => presetValues.has(item))
  form.genreCustom = genres.filter((item) => !presetValues.has(item)).join(', ')
  const style = novel.writingStyle
  if (!style?.prompt) {
    form.writingStyleKey = ''
    form.customStylePrompt = ''
  } else if (writingStyles.value.some((item) => item.key === style.key)) {
    form.writingStyleKey = style.key
    form.customStylePrompt = ''
  } else {
    form.writingStyleKey = CUSTOM_STYLE_KEY
    form.customStylePrompt = style.prompt
  }
}

async function loadWritingStyles() {
  if (writingStyles.value.length) return
  try {
    const result = await settingsAPI.novel()
    const styles = result?.settings?.writingStyles
    writingStyles.value = Array.isArray(styles) ? styles : []
  } catch { /* 设置读取失败时允许自定义文风 */ }
}

watch(() => props.open, async (open) => {
  if (!open) return
  errorText.value = ''
  await loadWritingStyles()
  fillFromNovel()
})

function close() {
  if (store.saving) return
  emit('update:open', false)
}

function parseGenre(raw: string): string[] {
  return [...new Set(raw.split(/[,，、]/).map((item) => item.trim()).filter(Boolean))]
}

function toggleGenre(value: string) {
  const index = form.genres.indexOf(value)
  if (index >= 0) form.genres.splice(index, 1)
  else form.genres.push(value)
}

function resolveWritingStyle() {
  if (!form.writingStyleKey) return null
  if (form.writingStyleKey === CUSTOM_STYLE_KEY) {
    const prompt = form.customStylePrompt.trim()
    return prompt ? { key: 'custom', name: t('novels.createDialog.writingStyleCustomName'), prompt } : null
  }
  const preset = writingStyles.value.find((style) => style.key === form.writingStyleKey)
  return preset ? { key: preset.key, name: preset.name, prompt: preset.prompt } : null
}

async function submit() {
  errorText.value = ''
  if (!form.title) {
    errorText.value = t('novels.createDialog.titleRequired')
    return
  }
  try {
    const updated = await store.updateNovel(props.novel.id, {
      title: form.title,
      topic: form.topic || null,
      background: form.background || null,
      genre: [...new Set([...form.genres, ...parseGenre(form.genreCustom)])],
      writing_style: resolveWritingStyle(),
    })
    toast.success(t('novels.settingsDialog.saved'))
    emit('saved', updated)
    emit('update:open', false)
  } catch (error: any) {
    errorText.value = error?.message || t('novels.settingsDialog.failed')
  }
}
</script>

<style scoped>
.genre-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.genre-chip {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-2);
  color: var(--text-1);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.genre-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.genre-chip.on {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent-text);
}
</style>
