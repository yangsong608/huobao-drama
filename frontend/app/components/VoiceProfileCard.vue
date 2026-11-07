<template>
  <article :class="['voice-profile-card', `is-${scope}`, { 'is-missing': !selectedVoice, 'is-open': editOpen }]" @click.stop @keydown.stop>
    <header class="vpc-head">
      <div class="vpc-title">
        <span class="vpc-kind">{{ scope === 'narrator' ? t('episode.voice.narratorGroup') : t('episode.voice.characterGroup') }}</span>
        <strong class="vpc-name">{{ displayName }}</strong>
        <span v-if="lineCount" class="vpc-lines">{{ t('workbench.speakerLines', { n: lineCount }) }}</span>
        <span :class="['vpc-chip', selectedVoice ? `is-${selectedVoice.status}` : 'is-empty']">
          {{ selectedVoice ? statusLabel(selectedVoice) : t('episode.voice.missing') }}
        </span>
        <span v-if="scope === 'character'" :class="['vpc-sync', `is-${syncState}`]">{{ syncLabel }}</span>
      </div>
      <div class="vpc-head-actions">
        <select v-model="selectedId" v-if="versions.length > 1" class="vpc-version" :aria-label="t('voiceProfile.version')">
          <option v-for="voice in versions" :key="voice.id" :value="voice.id">{{ voiceOptionLabel(voice) }}</option>
        </select>
        <button v-if="scope === 'character' && episodeId" type="button" class="btn btn-sm is-danger" @click="onDeleteCharacter">
          <UserMinus :size="11" />
          {{ t('workbench.deleteCharacter') }}
        </button>
        <button type="button" class="btn btn-sm" @click="editOpen = !editOpen">
          <Pencil v-if="!editOpen" :size="11" />
          {{ editOpen ? t('voiceProfile.done') : t('voiceProfile.edit') }}
        </button>
      </div>
    </header>

    <div v-if="!selectedVoice" class="vpc-empty">
      <p>{{ scope === 'narrator' ? t('episode.voice.narratorEmpty') : t('episode.voice.empty') }}</p>
      <button class="btn btn-sm is-primary" type="button" :disabled="busy" @click="generateNow">
        <Loader2 v-if="generating" :size="11" class="animate-spin" />
        <Mic v-else :size="11" />
        {{ generating ? t('episode.voice.generatingVoice') : t('episode.voice.generateVoice') }}
      </button>
    </div>

    <template v-else>
      <div class="vpc-summary">
        <div class="vpc-summary-copy">
          <span class="vpc-voice-name">{{ selectedVoice.name }}</span>
          <span class="vpc-summary-hint">{{ t('voiceProfile.footHint') }}</span>
        </div>
        <div class="vpc-summary-actions">
          <button class="btn btn-sm is-primary" type="button" :disabled="busy" @click="generateVoiceNow">
            <Loader2 v-if="generating" :size="11" class="animate-spin" />
            <Mic v-else :size="11" />
            {{ generating ? t('episode.voice.generatingVoice') : t('episode.voice.generateVoice') }}
          </button>
          <button class="btn btn-sm" type="button" :disabled="busy" @click="auditionNow">
            <Play :size="11" />
            {{ t('episode.voice.audition') }}
          </button>
          <button class="btn btn-sm" type="button" :disabled="busy" @click="auditionOpen = !auditionOpen">
            <AudioLines :size="11" />
            {{ t('voiceProfile.auditionPanel') }}
          </button>
          <button class="btn btn-sm" type="button" :disabled="busy" @click="rewriteNow">
            <Sparkles :size="11" />
            {{ t('episode.voice.rewritePrompt') }}
          </button>
        </div>
      </div>

      <audio
        v-if="currentSampleUrl"
        ref="player"
        class="vpc-audio"
        controls
        preload="none"
        :src="mediaUrl(currentSampleUrl)"
        data-voice-profile
      />

      <VoiceAuditionPanel
        v-if="auditionOpen && selectedVoice"
        :voice="selectedVoice"
        :episode-id="episodeId ?? null"
        @updated="emit('updated')"
      />

      <p v-if="selectedVoice.status === 'failed'" class="vpc-error" role="alert">
        {{ selectedVoice.error || t('episode.voice.statusFailed') }}
      </p>
      <p v-else-if="selectedVoice.status === 'pending_model'" class="vpc-warn">{{ t('voiceProfile.pendingModel') }}</p>
      <p v-if="syncState === 'stale'" class="vpc-warn">{{ t('voiceProfile.syncHintStale') }}</p>

      <div v-if="editOpen" class="vpc-editor">
        <VoiceAssetFields :voice="selectedVoice" :draft="draft" :busy="busy" />
        <p v-if="dirty" class="vpc-dirty">{{ t('voiceProfile.dirtyHint') }}</p>

        <div class="vpc-actions">
          <button class="btn btn-sm is-primary" type="button" :disabled="busy" @click="generateVoiceNow">
            <Loader2 v-if="generating" :size="11" class="animate-spin" />
            <Mic v-else :size="11" />
            {{ t('voiceProfile.saveAndGenerate') }}
          </button>
          <button class="btn btn-sm" type="button" :disabled="busy" @click="saveNow">
            {{ t('episode.voice.save') }}
          </button>
          <button v-if="!selectedVoice.isActive" class="btn btn-sm" type="button" :disabled="busy" @click="activateNow">
            <Check :size="11" />
            {{ t('episode.voice.setActive') }}
          </button>
          <template v-if="scope === 'character'">
            <button class="btn btn-sm" type="button" :disabled="busy || syncState === 'synced'" @click="syncNow">
              <Check v-if="syncState === 'synced'" :size="11" />
              <Link2 v-else :size="11" />
              {{ syncState === 'synced' ? t('voiceProfile.syncStateSynced') : t('voiceProfile.syncToVideo') }}
            </button>
            <button class="btn btn-sm" type="button" :disabled="busy" @click="fileInput?.click()">
              <Upload :size="11" />
              {{ t('voiceProfile.clone') }}
            </button>
            <input
              ref="fileInput"
              class="vpc-file"
              type="file"
              accept=".mp3,.wav,.m4a,.aac,audio/mpeg,audio/wav,audio/mp4,audio/aac"
              @change="uploadClone"
            />
            <select v-model="cloneTarget" class="vpc-clone-target">
              <option value="">{{ t('episode.voice.cloneTarget') }}</option>
              <option v-for="other in cloneTargets" :key="`c${other.id}`" :value="`c${other.id}`">{{ other.name }}</option>
              <option value="narrator">{{ t('episode.voice.cloneNarrator') }}</option>
            </select>
            <button class="btn btn-sm" type="button" :disabled="busy || !cloneTarget" @click="cloneNow">
              <Loader2 v-if="busy" :size="11" class="animate-spin" />
              <Copy v-else :size="11" />
              {{ t('episode.voice.clone') }}
            </button>
            <button class="btn btn-sm is-danger" type="button" :disabled="busy" @click="removeNow">
              <Trash2 :size="11" />
              {{ t('episode.voice.delete') }}
            </button>
          </template>
        </div>

        <details class="vpc-advanced">
          <summary>{{ t('voiceProfile.advanced') }}</summary>
          <p class="vpc-foot">{{ t('voiceProfile.capabilityHint') }}</p>
          <p v-if="selectedVoice.designInstruct" class="vpc-instruct">{{ selectedVoice.designInstruct }}</p>
        </details>
      </div>
    </template>

    <div v-if="referenceAudio && character" class="vpc-reference">
      <p class="vpc-reference-label">{{ t('episode.voice.referenceAudioHint') }}</p>
      <CharacterVoice :key="character.id" :character="character" @updated="onReferenceUpdated" />
    </div>
  </article>
</template>

<script setup lang="ts">
import { AudioLines, Check, Copy, Link2, Loader2, Mic, Pencil, Play, Sparkles, Trash2, Upload, UserMinus } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { CharacterVoice as CharacterVoiceAsset, VoiceProfile } from '~/composables/useApi'
import { useVoiceProfiles, type VoiceDraft } from '~/composables/useVoiceProfiles'

const props = defineProps<{
  dramaId: number
  episodeId?: number | null
  scope: 'character' | 'narrator'
  characterId?: number | null
  name?: string
  lineCount?: number
  character?: {
    id: number
    name?: string
    voice_audio_url?: string | null
    voice_audio_name?: string | null
    voiceAudioUrl?: string | null
    voiceAudioName?: string | null
  } | null
  referenceAudio?: boolean
  videoRefUrl?: string | null
  defaultExpanded?: boolean
}>()

const emit = defineEmits<{
  updated: []
  'reference-updated': [id: number, voice: CharacterVoiceAsset]
  'delete-character': []
}>()

const { t } = useI18n()
const store = useVoiceProfiles({
  dramaId: () => props.dramaId,
  episodeId: () => props.episodeId ?? null,
  onChanged: () => emit('updated'),
})

const editOpen = ref(Boolean(props.defaultExpanded))
const auditionOpen = ref(false)
const selectedId = ref(0)
const cloneTarget = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const player = ref<HTMLAudioElement | null>(null)
const generating = ref(false)
const draft = reactive<VoiceDraft>({
  name: '',
  voicePrompt: '',
  designInstruct: '',
  speed: 1,
  emotion: '',
  externalVoiceId: '',
})

const group = computed(() =>
  props.scope === 'character'
    ? store.groups.value.find(item => item.character_id === props.characterId) || null
    : null)
const versions = computed<VoiceProfile[]>(() =>
  props.scope === 'narrator' ? store.narratorVersions.value : (group.value?.voices || []))
const selectedVoice = computed(() =>
  versions.value.find(voice => voice.id === selectedId.value)
  || versions.value.find(voice => voice.isActive)
  || versions.value[0]
  || null)
const displayName = computed(() =>
  props.scope === 'narrator'
    ? (selectedVoice.value?.name || t('workbench.narrator'))
    : (props.name || group.value?.character_name || selectedVoice.value?.name || t('episode.voice.characterGroup')))
const busyKey = computed(() => props.scope === 'narrator' ? 'narrator' : `c${props.characterId ?? ''}`)
const busy = computed(() => store.loading.value || store.isBusy(busyKey.value))
const cloneTargets = computed(() =>
  store.groups.value
    .filter(item => item.character_id !== props.characterId)
    .map(item => ({ id: item.character_id, name: item.character_name })))

function normalizeVoiceUrl(value: string | null | undefined) {
  return String(value || '').replace(/^\/+/, '')
}
const videoRefUrl = computed(() =>
  normalizeVoiceUrl(props.videoRefUrl ?? props.character?.voice_audio_url ?? props.character?.voiceAudioUrl))
const currentSampleUrl = computed(() => normalizeVoiceUrl(selectedVoice.value?.sampleUrl || ''))
// 服务端不记录「同步的是哪一版」，只能靠路径/文件名推断；本会话内同步过的版本直接按 id 记住。
const syncState = computed<'synced' | 'stale' | 'none'>(() => {
  const voice = selectedVoice.value
  if (!voice || props.scope !== 'character') return 'none'
  const last = voice.characterId ? store.lastSynced.value[voice.characterId] : null
  if (last?.voiceId === voice.id && videoRefUrl.value === normalizeVoiceUrl(last.url)) return 'synced'
  if (!videoRefUrl.value) return 'none'
  if (currentSampleUrl.value && videoRefUrl.value === currentSampleUrl.value) return 'synced'
  const basename = videoRefUrl.value.split('/').pop() || ''
  if (basename.startsWith(`voice-${voice.id}-`)) return 'synced'
  return 'stale'
})
const syncLabel = computed(() => {
  if (syncState.value === 'synced') return t('voiceProfile.syncStateSynced')
  if (syncState.value === 'stale') return t('voiceProfile.syncStateStale')
  return t('voiceProfile.syncStateNone')
})
const dirty = computed(() => {
  const voice = selectedVoice.value
  if (!voice) return false
  return draft.name.trim() !== (voice.name || '')
    || draft.voicePrompt.trim() !== (voice.voicePrompt || '').trim()
    || draft.designInstruct.trim() !== (voice.designInstruct || '').trim()
    || Number(draft.speed) !== Number(voice.speed ?? 1)
    || draft.emotion.trim() !== (voice.emotion || '').trim()
    || draft.externalVoiceId.trim() !== (voice.externalVoiceId || '').trim()
})

watch(versions, list => {
  if (!list.length) {
    selectedId.value = 0
    return
  }
  if (!list.some(voice => voice.id === selectedId.value)) {
    selectedId.value = (list.find(voice => voice.isActive) || list[0]).id
  }
}, { immediate: true })

watch(selectedVoice, voice => {
  if (!voice) return
  Object.assign(draft, {
    name: voice.name || '',
    voicePrompt: voice.voicePrompt || '',
    designInstruct: voice.designInstruct || '',
    speed: Number(voice.speed) || 1,
    emotion: voice.emotion || '',
    externalVoiceId: voice.externalVoiceId || '',
  })
}, { immediate: true })

watch(selectedId, () => { auditionOpen.value = false })

function statusLabel(voice: VoiceProfile): string {
  const map: Record<string, string> = {
    draft: t('episode.voice.statusDraft'),
    pending_model: t('episode.voice.statusPendingModel'),
    generating: t('episode.voice.statusGenerating'),
    ready: t('episode.voice.statusReady'),
    failed: t('episode.voice.statusFailed'),
  }
  return map[voice.status] || voice.status
}

function voiceOptionLabel(voice: VoiceProfile): string {
  return `${voice.name || t('voiceProfile.title')}${voice.isActive ? ` · ${t('episode.voice.active')}` : ''}`
}

function mediaUrl(url: string) {
  return url.startsWith('/') || /^https?:\/\//i.test(url) ? url : `/${url}`
}

async function playUrl(url: string) {
  await nextTick()
  const audio = player.value
  if (!audio) return
  const src = mediaUrl(url)
  if (audio.getAttribute('src') !== src) audio.src = src
  await audio.play().catch(() => {})
}

async function generateNow() {
  if (generating.value) return
  if (selectedVoice.value) return generateVoiceNow()
  generating.value = true
  try {
    const voice = props.scope === 'narrator'
      ? await store.generateNarrator(false)
      : props.characterId
        ? await store.generateCharacter(props.characterId, false)
        : null
    if (!voice) return
    const url = await store.audition(voice)
    if (url) await playUrl(url)
  } finally {
    generating.value = false
  }
}

async function generateVoiceNow() {
  const voice = selectedVoice.value
  if (!voice || generating.value) return
  generating.value = true
  try {
    const url = await store.generateFromDraft(voice, { ...draft })
    if (url) await playUrl(url)
  } finally {
    generating.value = false
  }
}

async function rewriteNow() {
  const voice = selectedVoice.value
  if (!voice) return
  await store.redesign(voice, props.episodeId ?? null)
}

async function auditionNow() {
  const voice = selectedVoice.value
  if (!voice) return
  if (currentSampleUrl.value) {
    await playUrl(currentSampleUrl.value)
    return
  }
  const url = await store.audition(voice)
  if (url) await playUrl(url)
}

async function saveNow() {
  const voice = selectedVoice.value
  if (!voice) return
  await store.saveVoice(voice, { ...draft })
}

async function activateNow() {
  const voice = selectedVoice.value
  if (voice) await store.activate(voice)
}

async function syncNow() {
  const voice = selectedVoice.value
  if (!voice || !voice.characterId) return
  const result = await store.syncToVideo(voice)
  if (!result) return
  emit('reference-updated', voice.characterId, {
    voice_audio_url: result.voice_audio_url,
    voice_audio_name: props.name || props.character?.name || voice.name,
  } as CharacterVoiceAsset)
}

async function cloneNow() {
  const voice = selectedVoice.value
  if (!voice || !cloneTarget.value) return
  await store.cloneTo(voice, cloneTarget.value)
  cloneTarget.value = ''
}

async function removeNow() {
  const voice = selectedVoice.value
  if (!voice) return
  if (!window.confirm(t('episode.voice.deleteConfirm', { name: voice.name }))) return
  await store.removeVoice(voice)
  editOpen.value = false
}

function onDeleteCharacter() {
  if (!window.confirm(t('workbench.deleteCharacterConfirm', { name: displayName.value }))) return
  emit('delete-character')
}

async function uploadClone(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !props.characterId) return
  if (!/\.(mp3|wav|m4a|aac)$/i.test(file.name)) { toast.error(t('characterVoice.invalidFormat')); return }
  if (!file.size) { toast.error(t('characterVoice.emptyFile')); return }
  if (file.size > 20 * 1024 * 1024) { toast.error(t('characterVoice.tooLarge')); return }
  if (!window.confirm(t('voiceProfile.cloneConsent'))) return
  await store.uploadClone(props.characterId, file)
}

function onReferenceUpdated(id: number, voice: CharacterVoiceAsset) {
  emit('reference-updated', id, voice)
  emit('updated')
}

onMounted(() => { void store.ensureLoaded() })
watch(() => props.dramaId, () => { void store.ensureLoaded() })
</script>

<style scoped>
.voice-profile-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-1);
}
.voice-profile-card.is-missing { border-color: rgba(196, 138, 27, .38); background: rgba(196, 138, 27, .05); }
.voice-profile-card.is-narrator { background: var(--bg-2); }
.vpc-head, .vpc-title, .vpc-head-actions { display: flex; align-items: center; gap: 7px; min-width: 0; }
.vpc-head { justify-content: space-between; flex-wrap: wrap; }
.vpc-title { flex: 1; flex-wrap: wrap; }
.vpc-kind { font-size: 10px; color: var(--text-3); background: var(--overlay-track, rgba(127,127,127,.12)); border-radius: 4px; padding: 0 5px; }
.vpc-name { font-size: 12.5px; color: var(--text-0); }
.vpc-lines { font-size: 10.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.vpc-chip { border-radius: 999px; padding: 1px 7px; font-size: 10px; font-weight: 500; background: var(--overlay-track, rgba(127,127,127,.12)); color: var(--text-2); }
.vpc-chip.is-ready { color: var(--success, #2e9e5b); background: var(--success-bg, rgba(46, 158, 91, 0.12)); }
.vpc-chip.is-failed { color: var(--action-danger, #d9534f); background: var(--danger-bg, rgba(217, 83, 79, 0.12)); }
.vpc-chip.is-empty { color: var(--text-3); }
.vpc-sync { border-radius: 999px; padding: 1px 7px; font-size: 10px; font-weight: 500; background: var(--overlay-track, rgba(127,127,127,.12)); color: var(--text-3); }
.vpc-sync.is-synced { color: var(--success, #2e9e5b); background: var(--success-bg, rgba(46, 158, 91, 0.12)); }
.vpc-sync.is-stale { color: #c48a1b; background: rgba(196, 138, 27, 0.12); }
.vpc-head-actions { flex-shrink: 0; flex-wrap: wrap; }
.vpc-version { max-width: 160px; font-size: 11px; padding: 2px 4px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-2); color: var(--text-1); }
.vpc-summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vpc-summary-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.vpc-voice-name { font-size: 11.5px; font-weight: 600; color: var(--text-1); }
.vpc-summary-hint { font-size: 10.5px; color: var(--text-3); line-height: 1.5; }
.vpc-summary-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; flex-wrap: wrap; }
.vpc-empty { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; color: var(--text-3); font-size: 12px; }
.vpc-empty p { margin: 0; }
.vpc-editor { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--border); padding-top: 8px; }
.vpc-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vpc-clone-target { max-width: 130px; font-size: 11px; padding: 2px 4px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-2); color: var(--text-1); }
.vpc-file { display: none; }
.vpc-advanced { font-size: 11px; color: var(--text-3); border-top: 1px dashed var(--border); padding-top: 8px; }
.vpc-advanced summary { cursor: pointer; }
.vpc-foot, .vpc-instruct { margin: 6px 0 0; font-size: 10.5px; line-height: 1.6; color: var(--text-3); word-break: break-word; }
.vpc-warn { margin: 0; font-size: 11px; line-height: 1.5; color: #c48a1b; }
.vpc-error { margin: 0; font-size: 11px; line-height: 1.5; color: var(--action-danger); }
.vpc-dirty { margin: 0; font-size: 10.5px; line-height: 1.5; color: #c48a1b; }
.vpc-reference { display: flex; flex-direction: column; gap: 4px; border-top: 1px dashed var(--border); padding-top: 8px; }
.vpc-reference-label { margin: 0; font-size: 10.5px; color: var(--text-3); }
.vpc-reference :deep(.character-voice) { border-top: none; padding-top: 0; margin-top: 0; }
.vpc-audio { width: 100%; height: 32px; min-width: 0; }
</style>
