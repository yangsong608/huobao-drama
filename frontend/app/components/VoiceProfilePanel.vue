<template>
  <section class="voice-profile" :aria-label="t('voiceProfile.title')" @click.stop @keydown.stop>
    <div class="vp-head">
      <div class="vp-title">
        <AudioLines :size="14" />
        <span>{{ t('voiceProfile.title') }}</span>
        <span v-if="activeVoice" :class="['vp-chip', `is-${activeVoice.status}`]">{{ statusLabel(activeVoice) }}</span>
        <span v-else class="vp-chip is-empty">{{ t('voiceProfile.empty') }}</span>
      </div>
      <div class="vp-actions">
        <button type="button" class="btn btn-sm" :disabled="busy || generating" @click="generate(!activeVoice)">
          <Loader2 v-if="generating" :size="12" class="animate-spin" />
          <Sparkles v-else :size="12" />
          {{ generating ? t('voiceProfile.generating') : activeVoice ? t('voiceProfile.regenerate') : t('voiceProfile.generate') }}
        </button>
      </div>
    </div>

    <p v-if="!activeVoice && !generating" class="vp-hint">{{ t('voiceProfile.emptyHint') }}</p>

    <template v-if="activeVoice">
      <label class="vp-field">
        <span>{{ t('voiceProfile.prompt') }}</span>
        <textarea
          v-model="promptDraft"
          rows="3"
          maxlength="600"
          :disabled="saving"
          :placeholder="t('voiceProfile.promptPlaceholder')"
          @blur="savePrompt"
        />
      </label>

      <label class="vp-field">
        <span>{{ t('voiceProfile.externalVoiceId') }}</span>
        <input
          v-model="externalIdDraft"
          type="text"
          :disabled="saving"
          :placeholder="t('voiceProfile.externalVoiceIdPlaceholder')"
          @blur="saveExternalId"
          @keydown.enter.prevent="saveExternalId"
        />
        <small class="vp-foot-hint">{{ t('voiceProfile.externalVoiceIdHint') }}</small>
      </label>

      <details class="vp-instruct">
        <summary>{{ t('voiceProfile.instruct') }}</summary>
        <p>{{ activeVoice.designInstruct || '—' }}</p>
      </details>

      <div class="vp-actions vp-actions--wrap">
        <button type="button" class="btn btn-sm" :disabled="busy" @click="playSample">
          <Loader2 v-if="sampling" :size="12" class="animate-spin" />
          <Play v-else :size="12" />
          {{ sampling ? t('voiceProfile.synthesizing') : t('voiceProfile.sample') }}
        </button>
        <button
          v-if="!activeVoice.isActive"
          type="button"
          class="btn btn-sm"
          :disabled="busy"
          @click="activate"
        >
          <Check :size="12" />
          {{ t('voiceProfile.activate') }}
        </button>
        <button type="button" class="btn btn-sm" :disabled="busy" @click="syncToVideo">
          <Link2 :size="12" />
          {{ t('voiceProfile.syncToVideo') }}
        </button>
        <button type="button" class="btn btn-sm" :disabled="busy" @click="fileInput?.click()">
          <Upload :size="12" />
          {{ t('voiceProfile.clone') }}
        </button>
        <input
          ref="fileInput"
          class="vp-file"
          type="file"
          accept=".mp3,.wav,.m4a,.aac,audio/mpeg,audio/wav,audio/mp4,audio/aac"
          :disabled="busy"
          @change="uploadClone"
        />
      </div>

      <audio v-if="sampleUrl" :key="sampleUrl" class="vp-audio" :src="sampleUrl" controls preload="none" />

      <p v-if="activeVoice.status === 'failed'" class="vp-error" role="alert">
        {{ activeVoice.error || t('voiceProfile.failed') }}
      </p>
      <p v-if="activeVoice.status === 'pending_model'" class="vp-warn">{{ t('voiceProfile.pendingModel') }}</p>
    </template>

    <p class="vp-foot">{{ t('voiceProfile.footHint') }}</p>
  </section>
</template>

<script setup lang="ts">
import { AudioLines, Check, Link2, Loader2, Play, Sparkles, Upload } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { voiceProfileAPI, type VoiceProfile } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

const props = defineProps<{
  character: { id: number; name?: string }
  dramaId: number
  episodeId?: number | null
}>()
const emit = defineEmits<{ updated: [id: number, voice: { voice_audio_url: string | null; voice_audio_name: string | null }] }>()
const { t } = useI18n()

const fileInput = ref<HTMLInputElement | null>(null)
const loading = ref(false)
const generating = ref(false)
const saving = ref(false)
const sampling = ref(false)
const voices = ref<VoiceProfile[]>([])
const activeId = ref<number | null>(null)
const promptDraft = ref('')
const externalIdDraft = ref('')

const busy = computed(() => loading.value || generating.value || saving.value || sampling.value)
const activeVoice = computed(() => voices.value.find(v => v.id === activeId.value) || voices.value[0] || null)
const sampleUrl = computed(() => {
  const value = activeVoice.value?.sampleUrl || ''
  return value && !value.startsWith('/') && !/^https?:\/\//i.test(value) ? `/${value}` : value
})

watch(activeVoice, (voice) => {
  promptDraft.value = voice?.voicePrompt || ''
  externalIdDraft.value = voice?.externalVoiceId || ''
}, { immediate: true })

async function saveExternalId() {
  const voice = activeVoice.value
  if (!voice || saving.value) return
  const next = externalIdDraft.value.trim()
  if ((voice.externalVoiceId || '') === next) return
  saving.value = true
  try {
    const updated = await voiceProfileAPI.update(props.character.id, { external_voice_id: next || null })
    const target = voices.value.find(v => v.id === (updated?.id ?? voice.id))
    if (target) target.externalVoiceId = updated?.externalVoiceId ?? (next || null)
    toast.success(t('voiceProfile.externalVoiceIdSaved'))
  } catch (error) {
    toastError(error)
  } finally {
    saving.value = false
  }
}

function statusLabel(voice: VoiceProfile) {
  const map: Record<string, string> = {
    draft: t('voiceProfile.statusDraft'),
    ready: t('voiceProfile.statusReady'),
    failed: t('voiceProfile.statusFailed'),
    pending_model: t('voiceProfile.statusPendingModel'),
    generating: t('voiceProfile.statusGenerating'),
  }
  return map[voice.status] || voice.status
}

async function load() {
  loading.value = true
  try {
    const data = await voiceProfileAPI.character(props.character.id)
    voices.value = data?.voices || []
    activeId.value = data?.active_voice_id || (data?.voices?.[0]?.id ?? null)
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
    const result = await voiceProfileAPI.generate(props.character.id, {
      force,
      episode_id: props.episodeId || undefined,
    })
    if (result?.voice) {
      voices.value = [result.voice, ...voices.value.filter(v => v.id !== result.voice!.id)]
      activeId.value = result.voice.id
    } else {
      await load()
    }
    toast.success(t('voiceProfile.generated'))
  } catch (error) {
    toastError(error)
  } finally {
    generating.value = false
  }
}

async function savePrompt() {
  const voice = activeVoice.value
  if (!voice) return
  const value = promptDraft.value.trim()
  if (value === (voice.voicePrompt || '')) return
  saving.value = true
  try {
    const updated = await voiceProfileAPI.update(props.character.id, { voice_id: voice.id, voice_prompt: value })
    if (updated) {
      voices.value = voices.value.map(v => (v.id === updated.id ? updated : v))
      toast.success(t('voiceProfile.saved'))
    }
  } catch (error) {
    toastError(error)
  } finally {
    saving.value = false
  }
}

async function playSample() {
  const voice = activeVoice.value
  if (!voice || sampling.value) return
  sampling.value = true
  try {
    const result = await voiceProfileAPI.sample(props.character.id, { voice_id: voice.id })
    voices.value = voices.value.map(v => (v.id === voice.id ? { ...v, sampleUrl: result.sample_url, status: 'ready' } : v))
  } catch (error) {
    toastError(error)
  } finally {
    sampling.value = false
  }
}

async function activate() {
  const voice = activeVoice.value
  if (!voice) return
  try {
    await voiceProfileAPI.activate(props.character.id, voice.id)
    voices.value = voices.value.map(v => ({ ...v, isActive: v.id === voice.id }))
    activeId.value = voice.id
    toast.success(t('voiceProfile.activated'))
  } catch (error) {
    toastError(error)
  }
}

async function syncToVideo() {
  const voice = activeVoice.value
  if (!voice) return
  try {
    const result = await voiceProfileAPI.sync(props.character.id, voice.id)
    emit('updated', props.character.id, { voice_audio_url: result.voice_audio_url, voice_audio_name: props.character.name || null })
    toast.success(t('voiceProfile.synced'))
  } catch (error) {
    toastError(error)
  }
}

async function uploadClone(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!/\.(mp3|wav|m4a|aac)$/i.test(file.name)) { toast.error(t('characterVoice.invalidFormat')); return }
  if (file.size > 20 * 1024 * 1024) { toast.error(t('characterVoice.tooLarge')); return }
  const confirmed = window.confirm(t('voiceProfile.cloneConsent'))
  if (!confirmed) return
  loading.value = true
  try {
    const voice = await voiceProfileAPI.clone(props.character.id, file)
    voices.value = [voice, ...voices.value]
    activeId.value = voice.id
    toast.success(t('voiceProfile.cloneDone'))
  } catch (error) {
    toastError(error)
  } finally {
    loading.value = false
  }
}

onMounted(load)
defineExpose({ reload: load })
</script>

<style scoped>
.voice-profile { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 12px; margin-top: 8px; min-width: 0; }
.vp-head, .vp-title, .vp-actions { display: flex; align-items: center; gap: 8px; min-width: 0; }
.vp-head { justify-content: space-between; }
.vp-title { color: var(--text-1); font-size: 12px; font-weight: 600; }
.vp-title svg { color: var(--text-3); flex-shrink: 0; }
.vp-chip { border-radius: 999px; padding: 1px 7px; font-size: 10px; font-weight: 500; background: var(--surface-2, rgba(127,127,127,0.12)); color: var(--text-2); }
.vp-chip.is-ready { color: var(--action-success, #2e9e5b); background: rgba(46, 158, 91, 0.12); }
.vp-chip.is-failed { color: var(--action-danger, #d9534f); background: rgba(217, 83, 79, 0.12); }
.vp-chip.is-empty { color: var(--text-3); }
.vp-actions { flex-shrink: 0; }
.vp-actions--wrap { flex-wrap: wrap; }
.vp-field { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-2); }
.vp-field textarea { width: 100%; resize: vertical; min-height: 58px; padding: 6px 8px; font: inherit; font-size: 12px; line-height: 1.6; color: var(--text-1); background: var(--bg-2, transparent); border: 1px solid var(--border); border-radius: 6px; }
.vp-field textarea:disabled { opacity: 0.6; }
.vp-field input { width: 100%; padding: 6px 8px; font: inherit; font-size: 12px; color: var(--text-1); background: var(--bg-2, transparent); border: 1px solid var(--border); border-radius: 6px; }
.vp-field input:disabled { opacity: 0.6; }
.vp-foot-hint { font-size: 10px; color: var(--text-3); line-height: 1.5; }
.vp-instruct { font-size: 11px; color: var(--text-3); }
.vp-instruct summary { cursor: pointer; }
.vp-instruct p { margin: 4px 0 0; line-height: 1.6; word-break: break-word; }
.vp-audio { width: 100%; height: 34px; }
.vp-file { display: none; }
.vp-hint, .vp-foot, .vp-error, .vp-warn { margin: 0; font-size: 11px; line-height: 1.6; }
.vp-hint { color: var(--text-2); }
.vp-foot { color: var(--text-3); }
.vp-error { color: var(--action-danger); }
.vp-warn { color: var(--action-warning, #c48a1b); }
</style>
