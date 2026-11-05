<template>
  <div v-if="open" class="overlay" @click.self="close">
    <div class="dialog line-editor-dialog">
      <div class="dialog-head">
        <div>
          <div class="dialog-title">{{ t('workbench.addLineTitle') }}</div>
          <div class="line-editor-desc">{{ t('workbench.addLineDesc') }}</div>
        </div>
        <button class="btn btn-icon btn-sm btn-ghost ml-auto" type="button" :aria-label="t('common.close')" @click="close">×</button>
      </div>

      <div class="dialog-body">
        <label class="line-field">
          <span class="line-field-label">{{ t('workbench.text') }}</span>
          <textarea
            v-model="text"
            class="textarea line-textarea"
            rows="4"
            :placeholder="t('workbench.textPlaceholder')"
          />
        </label>

        <div class="line-field-row">
          <label class="line-field">
            <span class="line-field-label">{{ t('workbench.speakerType') }}</span>
            <BaseSelect v-model="speakerType" :options="speakerTypeOptions" :searchable="false" />
          </label>
          <label class="line-field">
            <span class="line-field-label">{{ t('workbench.speaker') }}</span>
            <BaseSelect
              v-if="speakerType === 'dialogue'"
              v-model="characterId"
              :options="characterOptions"
              :placeholder="t('workbench.speakerUnbound')"
            />
            <input
              v-else
              v-model="speakerName"
              class="input"
              :placeholder="speakerType === 'inner' ? t('workbench.inner') : t('workbench.narrator')"
            />
          </label>
        </div>

        <label v-if="speakerType === 'dialogue'" class="line-field">
          <span class="line-field-label">{{ t('workbench.speakerName') }}</span>
          <input v-model="speakerName" class="input" :placeholder="t('workbench.speakerNamePlaceholder')" />
        </label>

        <label class="line-field">
          <span class="line-field-label">{{ t('workbench.direction') }}</span>
          <input v-model="direction" class="input" :placeholder="t('workbench.directionPlaceholder')" />
        </label>

        <div class="line-field">
          <span class="line-field-label">{{ t('workbench.anchor') }}</span>
          <div class="line-anchor-tabs">
            <button
              v-for="item in anchorOptions"
              :key="item.value"
              type="button"
              :class="['line-anchor-tab', { on: anchorType === item.value }]"
              :disabled="item.value === 'shot' && !storyboards.length"
              @click="anchorType = item.value"
            >
              {{ item.label }}
            </button>
          </div>
        </div>

        <template v-if="anchorType === 'shot'">
          <div class="line-field-row">
            <label class="line-field">
              <span class="line-field-label">{{ t('workbench.anchorShot') }}</span>
              <BaseSelect v-model="storyboardId" :options="storyboardOptions" :searchable="false" />
            </label>
            <label class="line-field">
              <span class="line-field-label">{{ t('workbench.insertAfter') }}</span>
              <BaseSelect v-model="afterLineId" :options="afterLineOptions" :placeholder="t('workbench.insertEnd')" />
            </label>
          </div>
          <p v-if="!storyboards.length" class="line-field-hint">{{ t('workbench.anchorNoShot') }}</p>
        </template>
        <label v-else class="line-field">
          <span class="line-field-label">{{ t('workbench.absoluteTime') }}</span>
          <input v-model.number="startSec" class="input" type="number" min="0" step="0.1" />
        </label>

        <p v-if="error" class="line-editor-error">{{ error }}</p>
      </div>

      <div class="dialog-foot">
        <span class="line-editor-foot">{{ t('workbench.addLineFoot') }}</span>
        <button class="btn" type="button" @click="close">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" type="button" :disabled="submitting || loading" @click="submit">
          {{ submitting ? t('common.saving') : t('workbench.addLine') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { episodeAPI, type StoryboardLine } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import BaseSelect from '~/components/BaseSelect.vue'
import type { NewLinePayload } from '~/composables/useDubbingSession'

const props = defineProps<{
  open: boolean
  episodeId: number | null
  lines: StoryboardLine[]
  submitting?: boolean
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: NewLinePayload]
}>()

const { t } = useI18n()

const text = ref('')
const speakerType = ref<'dialogue' | 'narration' | 'inner'>('dialogue')
const characterId = ref('')
const speakerName = ref('')
const direction = ref('')
const anchorType = ref<'shot' | 'absolute'>('shot')
const storyboardId = ref('')
const afterLineId = ref('')
const startSec = ref(0)
const error = ref('')
const loading = ref(false)
const characters = ref<{ id: number; name: string }[]>([])
const storyboards = ref<{ id: number; storyboard_number?: number; storyboardNumber?: number; title?: string | null }[]>([])

const speakerTypeOptions = computed(() => [
  { label: t('workbench.dialogue'), value: 'dialogue' },
  { label: t('workbench.narration'), value: 'narration' },
  { label: t('workbench.inner'), value: 'inner' },
])
const anchorOptions = computed(() => [
  { label: t('workbench.anchorShot'), value: 'shot' as const },
  { label: t('workbench.anchorAbsolute'), value: 'absolute' as const },
])
const characterOptions = computed(() => [
  { label: t('workbench.speakerUnbound'), value: '' },
  ...characters.value.map(item => ({ label: item.name, value: String(item.id) })),
])
const storyboardOptions = computed(() => storyboards.value.map((item) => {
  const number = Number(item.storyboard_number ?? item.storyboardNumber ?? 0)
  return { label: `#${String(number).padStart(2, '0')} ${item.title || ''}`.trim(), value: String(item.id) }
}))
const afterLineOptions = computed(() => {
  const current = Number(storyboardId.value)
  return props.lines
    .filter(line => line.storyboardId === current)
    .map(line => ({
      label: `#${line.lineNo} ${line.speakerName || t('workbench.narrator')} · ${line.text.slice(0, 18)}`,
      value: String(line.id),
    }))
})

watch(() => props.open, (value) => {
  if (value) void init()
})

function reset() {
  text.value = ''
  speakerType.value = 'dialogue'
  characterId.value = ''
  speakerName.value = ''
  direction.value = ''
  anchorType.value = 'shot'
  afterLineId.value = ''
  startSec.value = 0
  error.value = ''
}

async function init() {
  reset()
  if (!props.episodeId) return
  loading.value = true
  try {
    const [chars, shots] = await Promise.all([
      episodeAPI.characters(props.episodeId).catch(() => []),
      episodeAPI.storyboards(props.episodeId).catch(() => []),
    ])
    characters.value = Array.isArray(chars) ? chars : []
    storyboards.value = Array.isArray(shots) ? shots : []
    storyboardId.value = storyboards.value.length ? String(storyboards.value[0].id) : ''
    anchorType.value = storyboards.value.length ? 'shot' : 'absolute'
  } catch (err) {
    toastError(err)
  } finally {
    loading.value = false
  }
}

function close() {
  if (props.submitting) return
  emit('close')
}

function submit() {
  const content = text.value.trim()
  if (!content) {
    error.value = t('workbench.textRequired')
    return
  }
  if (anchorType.value === 'shot' && !storyboardId.value) {
    error.value = t('workbench.anchorRequired')
    return
  }
  if (anchorType.value === 'absolute' && (!Number.isFinite(Number(startSec.value)) || Number(startSec.value) < 0)) {
    error.value = t('workbench.anchorTimeInvalid')
    return
  }
  error.value = ''
  const selectedCharacter = characters.value.find(item => String(item.id) === characterId.value)
  const payload: NewLinePayload = {
    text: content,
    speaker_type: speakerType.value,
    character_id: speakerType.value === 'dialogue' && characterId.value ? Number(characterId.value) : null,
    speaker_name: speakerType.value === 'dialogue'
      ? (speakerName.value.trim() || selectedCharacter?.name || null)
      : (speakerName.value.trim() || null),
    direction: direction.value.trim() || null,
    anchor: anchorType.value === 'shot'
      ? {
          type: 'shot',
          storyboard_id: Number(storyboardId.value),
          after_line_id: afterLineId.value ? Number(afterLineId.value) : null,
        }
      : {
          type: 'absolute',
          start_ms: Math.round(Number(startSec.value) * 1000),
        },
  }
  emit('submit', payload)
}
</script>

<style scoped>
.line-editor-dialog { width: min(620px, 94vw); }
.line-editor-desc { margin-top: 3px; font-size: 11.5px; color: var(--text-3); }
.line-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
.line-field-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.line-field-label { font-size: 11px; font-weight: 600; color: var(--text-2); }
.line-field-hint { margin: -4px 0 10px; font-size: 10.5px; color: var(--text-3); }
.line-textarea { min-height: 88px; resize: vertical; }
.line-anchor-tabs { display: flex; gap: 4px; }
.line-anchor-tab {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-1);
  color: var(--text-3);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.line-anchor-tab.on { color: var(--accent); border-color: var(--accent); background: var(--accent-bg); }
.line-anchor-tab:disabled { opacity: .45; cursor: default; }
.line-editor-error { margin: 0; font-size: 11.5px; color: var(--action-danger); }
.line-editor-foot { flex: 1; min-width: 0; font-size: 11px; color: var(--text-3); }
</style>
