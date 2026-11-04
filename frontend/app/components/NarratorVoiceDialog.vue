<template>
  <div v-if="open" class="overlay" @click.self="close">
    <div class="dialog narrator-dialog">
      <div class="dialog-head">
        <div class="dialog-head-copy">
          <div class="dialog-title">{{ t('narrator.title') }}</div>
          <div class="dialog-desc">{{ t('narrator.desc') }}</div>
        </div>
        <button class="btn btn-icon btn-sm btn-ghost ml-auto dialog-close" @click="close">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="dialog-body">
        <div class="narrator-head">
          <span class="narrator-name">{{ voice?.name || t('narrator.empty') }}</span>
          <span v-if="voice" :class="['tag', voice.isActive ? 'tag-accent' : '']">{{ voice.isActive ? t('narrator.active') : t('narrator.inactive') }}</span>
          <span class="narrator-spacer" />
          <button class="btn btn-sm" :disabled="busy" @click="generate(false)">{{ voice ? t('voiceProfile.regenerate') : t('voiceProfile.generate') }}</button>
          <button v-if="voice" class="btn btn-sm" :disabled="busy" @click="generate(true)">{{ t('narrator.force') }}</button>
        </div>

        <p v-if="!voice" class="field-hint">{{ t('narrator.emptyHint') }}</p>

        <template v-else>
          <label class="field">
            <span class="field-label">{{ t('voiceProfile.prompt') }}</span>
            <textarea v-model="promptDraft" class="textarea" rows="3" maxlength="600" :disabled="saving" @blur="savePrompt" />
          </label>
          <details class="narrator-instruct">
            <summary>{{ t('voiceProfile.instruct') }}</summary>
            <p>{{ voice.designInstruct || '—' }}</p>
          </details>
          <div class="narrator-actions">
            <button class="btn btn-sm" :disabled="sampling" @click="sample">{{ sampling ? t('voiceProfile.synthesizing') : t('voiceProfile.sample') }}</button>
            <span v-if="sampleUrl" class="field-hint">{{ t('narrator.sampleReady') }}</span>
          </div>
          <audio v-if="sampleUrl" :key="sampleUrl" class="narrator-audio" :src="sampleUrl" controls preload="none" />
        </template>
      </div>

      <div class="dialog-foot">
        <span class="dialog-foot-copy">{{ t('narrator.foot') }}</span>
        <button class="btn" @click="close">{{ t('common.close') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { voiceProfileAPI, api, type VoiceProfile } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const props = defineProps<{ open: boolean; dramaId: number }>()
const emit = defineEmits<{ close: []; updated: [] }>()
const { t } = useI18n()

const voice = ref<VoiceProfile | null>(null)
const promptDraft = ref('')
const sampleUrl = ref('')
const loading = ref(false)
const generating = ref(false)
const saving = ref(false)
const sampling = ref(false)
const busy = computed(() => loading.value || generating.value || saving.value || sampling.value)

watch(() => props.open, (value) => { if (value) load() })
watch(voice, (value) => { promptDraft.value = value?.voicePrompt || '' }, { immediate: true })

function urlOf(raw: string | null | undefined) {
  if (!raw) return ''
  return /^https?:\/\//i.test(raw) || raw.startsWith('/') ? raw : `/${raw}`
}

async function load() {
  loading.value = true
  try {
    voice.value = await voiceProfileAPI.narrator.get(props.dramaId)
    sampleUrl.value = urlOf(voice.value?.sampleUrl)
  } catch (error) {
    toastError(error)
  } finally {
    loading.value = false
  }
}

async function generate(force: boolean) {
  if (busy.value) return
  generating.value = true
  try {
    voice.value = await voiceProfileAPI.narrator.generate(props.dramaId, force)
    sampleUrl.value = urlOf(voice.value?.sampleUrl)
    toast.success(t('voiceProfile.generated'))
    emit('updated')
  } catch (error) {
    toastError(error)
  } finally {
    generating.value = false
  }
}

async function savePrompt() {
  const current = voice.value
  if (!current) return
  const value = promptDraft.value.trim()
  if (value === (current.voicePrompt || '')) return
  saving.value = true
  try {
    const updated = await api.put<VoiceProfile>(`/voices/${current.id}`, { voice_prompt: value })
    if (updated) voice.value = { ...current, ...updated }
    toast.success(t('voiceProfile.saved'))
  } catch (error) {
    toastError(error)
  } finally {
    saving.value = false
  }
}

async function sample() {
  const current = voice.value
  if (!current || sampling.value) return
  sampling.value = true
  try {
    const result = await api.post<{ sample_url: string; duration_ms: number }>(`/voices/${current.id}/sample`, {})
    sampleUrl.value = urlOf(result?.sample_url)
    toast.success(t('voiceProfile.sampled'))
  } catch (error) {
    toastError(error)
  } finally {
    sampling.value = false
  }
}

function close() { emit('close') }
</script>

<style scoped>
.narrator-dialog { width: min(620px, 94vw); max-height: 88vh; }
.narrator-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.narrator-name { font-size: 13px; font-weight: 600; color: var(--text-1); }
.narrator-spacer { flex: 1; }
.narrator-instruct { font-size: 11px; color: var(--text-3); }
.narrator-instruct summary { cursor: pointer; }
.narrator-instruct p { margin: 4px 0 0; line-height: 1.6; word-break: break-word; }
.narrator-actions { display: flex; align-items: center; gap: 10px; }
.narrator-audio { width: 100%; height: 34px; }
</style>
