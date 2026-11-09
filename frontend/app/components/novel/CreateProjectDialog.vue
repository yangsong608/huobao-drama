<template>
  <div v-if="open" class="overlay" @click.self="close">
    <div class="dialog" style="width: min(560px, calc(100vw - 40px))" role="dialog" aria-modal="true" :aria-label="t('novels.createDialog.title')">
      <div class="dialog-head">
        <div>
          <h2 class="dialog-title">
            <Sparkles :size="16" :stroke-width="1.8" />
            {{ t('novels.createDialog.title') }}
          </h2>
          <p class="dialog-sub">{{ t('novels.createDialog.subtitle') }}</p>
        </div>
        <button type="button" class="btn btn-icon btn-sm ml-auto" :aria-label="t('common.close')" @click="close">
          <X :size="16" :stroke-width="1.8" />
        </button>
      </div>

      <form class="dialog-form" @submit.prevent="submit">
      <div class="dialog-body">
        <label class="field">
          <span class="field-label">{{ t('novels.createDialog.titleLabel') }}</span>
          <input
            ref="titleInput"
            v-model.trim="form.title"
            class="input"
            :placeholder="t('novels.createDialog.titlePlaceholder')"
            maxlength="120"
          />
        </label>

        <label class="field">
          <span class="field-label">{{ t('novels.createDialog.topicLabel') }}</span>
          <input
            v-model.trim="form.topic"
            class="input"
            :placeholder="t('novels.createDialog.topicPlaceholder')"
            maxlength="300"
          />
        </label>

        <label class="field">
          <span class="field-label">{{ t('novels.createDialog.backgroundLabel') }}</span>
          <textarea
            v-model.trim="form.background"
            class="textarea"
            :placeholder="t('novels.createDialog.backgroundPlaceholder')"
            rows="3"
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

        <div class="field-row">
          <label class="field">
            <span class="field-label">{{ t('novels.createDialog.chaptersLabel') }}</span>
            <BaseSelect v-model="form.numberOfChapters" :options="chapterOptions" :searchable="false" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('novels.createDialog.wordsLabel') }}</span>
            <BaseSelect v-model="form.wordNumber" :options="wordOptions" :searchable="false" />
          </label>
        </div>

        <label class="field">
          <span class="field-label">{{ t('novels.createDialog.narrativePersonLabel') }}</span>
          <BaseSelect v-model="form.narrativePerson" :options="personOptions" :searchable="false" />
        </label>

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

        <label class="field">
          <span class="field-label">{{ t('novels.createDialog.guidanceLabel') }}</span>
          <textarea
            v-model.trim="form.userGuidance"
            class="textarea"
            :placeholder="t('novels.createDialog.guidancePlaceholder')"
            rows="3"
            maxlength="2000"
          />
        </label>

        <p v-if="errorText" class="form-error">{{ errorText }}</p>

        </div>

        <div class="dialog-foot">
          <button type="button" class="btn" :disabled="store.saving" @click="close">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="store.saving">
            <Loader2 v-if="store.saving" :size="13" class="animate-spin" />
            {{ store.saving ? t('novels.createDialog.submitting') : t('novels.createDialog.submit') }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Sparkles, X } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { useNovelStore } from '~/stores/novel'
import { settingsAPI } from '~/composables/useApi'
import { useOverlayHistory } from '~/composables/useOverlayHistory'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; created: [novel: any] }>()
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
const defaultWritingStyleKey = ref('')
let settingsLoaded = false

const titleInput = ref<HTMLInputElement>()
const errorText = ref('')
const form = reactive({
  title: '',
  topic: '',
  background: '',
  genres: [] as string[],
  genreCustom: '',
  numberOfChapters: 100,
  wordNumber: 3000,
  userGuidance: '',
  narrativePerson: 'first',
  writingStyleKey: '',
  customStylePrompt: '',
})

const chapterOptions = [20, 50, 100, 200, 500].map((n) => ({ label: `${n}`, value: n }))
const wordOptions = [2000, 3000, 4000, 6000].map((n) => ({ label: `${n}`, value: n }))
const personOptions = [
  { label: t('novels.narrativePerson.first'), value: 'first' },
  { label: t('novels.narrativePerson.third_limited'), value: 'third_limited' },
  { label: t('novels.narrativePerson.third_omniscient'), value: 'third_omniscient' },
]
const writingStyleOptions = computed(() => [
  { label: t('novels.createDialog.writingStyleNone'), value: '' },
  ...writingStyles.value.map((style) => ({ label: style.name, value: style.key })),
  { label: t('novels.createDialog.writingStyleCustom'), value: CUSTOM_STYLE_KEY },
])

async function loadNovelDefaults() {
  if (settingsLoaded) return
  try {
    const result = await settingsAPI.novel()
    const settings = result?.settings || {}
    writingStyles.value = Array.isArray(settings.writingStyles) ? settings.writingStyles : []
    defaultWritingStyleKey.value = settings.defaultWritingStyleKey || ''
    settingsLoaded = true
    if (!form.writingStyleKey) form.writingStyleKey = defaultWritingStyleKey.value
  } catch { /* 设置读取失败时只隐藏文风预设 */ }
}

watch(() => props.open, async (open) => {
  if (!open) return
  errorText.value = ''
  void loadNovelDefaults()
  await nextTick()
  titleInput.value?.focus()
})

function close() {
  if (store.saving) return
  emit('update:open', false)
}

// 返回键 / 返回手势先关弹窗，关闭后焦点回到触发按钮
const overlay = useOverlayHistory(() => close())
watch(() => props.open, (open) => {
  if (open) overlay.open()
  else overlay.close()
})

function parseGenre(raw: string): string[] {
  return [...new Set(raw.split(/[,，、]/).map((item) => item.trim()).filter(Boolean))]
}

function toggleGenre(value: string) {
  const index = form.genres.indexOf(value)
  if (index >= 0) form.genres.splice(index, 1)
  else form.genres.push(value)
}

function collectGenres(): string[] {
  return [...new Set([...form.genres, ...parseGenre(form.genreCustom)])]
}

function resolveWritingStyle() {
  if (!form.writingStyleKey) return undefined
  if (form.writingStyleKey === CUSTOM_STYLE_KEY) {
    const prompt = form.customStylePrompt.trim()
    if (!prompt) return undefined
    return { key: 'custom', name: t('novels.createDialog.writingStyleCustomName'), prompt }
  }
  const preset = writingStyles.value.find((style) => style.key === form.writingStyleKey)
  return preset ? { key: preset.key, name: preset.name, prompt: preset.prompt } : undefined
}

function resetForm() {
  form.title = ''
  form.topic = ''
  form.background = ''
  form.genres = []
  form.genreCustom = ''
  form.userGuidance = ''
  form.narrativePerson = 'first'
  form.writingStyleKey = defaultWritingStyleKey.value
  form.customStylePrompt = ''
}

async function submit() {
  errorText.value = ''
  if (!form.title) {
    errorText.value = t('novels.createDialog.titleRequired')
    titleInput.value?.focus()
    return
  }
  try {
    const created = await store.createNovel({
      title: form.title,
      topic: form.topic || undefined,
      background: form.background || undefined,
      genre: collectGenres(),
      writing_style: resolveWritingStyle(),
      number_of_chapters: form.numberOfChapters,
      word_number: form.wordNumber,
      user_guidance: form.userGuidance || undefined,
      narrative_person: form.narrativePerson,
    })
    toast.success(t('novels.createDialog.created', { title: created.title }))
    resetForm()
    emit('created', created)
    emit('update:open', false)
  } catch (error: any) {
    errorText.value = error?.message || t('novels.createDialog.failed')
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

