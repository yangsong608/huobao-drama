<template>
  <div class="voice-asset-grid">
    <div class="voice-bar">
      <div class="voice-bar-copy">
        <strong>{{ t('episode.voice.title') }}</strong>
        <span class="dim">{{ t('episode.voice.desc') }}</span>
      </div>
      <button class="btn btn-sm btn-primary" type="button" :disabled="batchRunning || loading" @click="generateMissing">
        <Loader2 v-if="batchRunning" :size="11" class="animate-spin" />
        {{ t('episode.voice.generateAll') }}
      </button>
    </div>

    <div v-if="loading" class="voice-loading">
      <Loader2 :size="20" class="animate-spin" />
    </div>
    <div v-else class="voice-cards">
      <article class="voice-card is-narrator" :class="{ 'is-missing': !narratorVoice }">
        <header class="voice-card-head">
          <div class="voice-card-title">
            <span class="voice-kind">{{ t('episode.voice.narratorGroup') }}</span>
            <strong>{{ narratorVoice?.name || t('workbench.narrator') }}</strong>
          </div>
          <span :class="['voice-chip', narratorVoice ? `is-${narratorVoice.status}` : 'is-empty']">
            {{ narratorVoice ? statusLabel(narratorVoice) : t('episode.voice.missing') }}
          </span>
        </header>
        <template v-if="narratorVoice">
          <VoiceAssetFields :voice="narratorVoice" :draft="draftFor(narratorVoice)" :busy="busyIds.includes(`v${narratorVoice.id}`)" />
          <footer class="voice-actions">
            <button class="btn btn-sm" type="button" :disabled="savingId === narratorVoice.id" @click="save(narratorVoice)">
              {{ t('episode.voice.save') }}
            </button>
            <button class="btn btn-sm" type="button" :disabled="sampleBusyId === narratorVoice.id" @click="audition(narratorVoice)">
              <Play v-if="sampleBusyId !== narratorVoice.id" :size="11" />
              <Loader2 v-else :size="11" class="animate-spin" />
              {{ t('episode.voice.audition') }}
            </button>
            <button class="btn btn-sm" type="button" :disabled="busyIds.includes('narrator')" @click="generateNarrator">
              <Loader2 v-if="busyIds.includes('narrator')" :size="11" class="animate-spin" />
              {{ t('episode.voice.regenerate') }}
            </button>
          </footer>
          <p v-if="errors.narrator" class="voice-error">{{ errors.narrator }}</p>
        </template>
        <div v-else class="voice-card-empty">
          <p>{{ t('episode.voice.narratorEmpty') }}</p>
          <button class="btn btn-sm btn-primary" type="button" :disabled="busyIds.includes('narrator')" @click="generateNarrator">
            <Loader2 v-if="busyIds.includes('narrator')" :size="11" class="animate-spin" />
            {{ t('episode.voice.generate') }}
          </button>
        </div>
      </article>

      <article
        v-for="group in groups"
        :key="group.character_id"
        class="voice-card"
        :class="{ 'is-missing': !selectedVoice(group) }"
      >
        <header class="voice-card-head">
          <div class="voice-card-title">
            <span class="voice-kind">{{ t('episode.voice.characterGroup') }}</span>
            <strong>{{ group.character_name }}</strong>
          </div>
          <select
            v-if="group.voices.length"
            class="voice-version"
            :value="selectedIds[group.character_id] || ''"
            @change="selectVersion(group, $event)"
          >
            <option v-for="voice in sortedVoices(group.voices)" :key="voice.id" :value="voice.id">
              {{ voice.name }}{{ voice.isActive ? ` · ${t('episode.voice.active')}` : '' }}
            </option>
          </select>
          <span :class="['voice-chip', selectedVoice(group) ? `is-${selectedVoice(group)!.status}` : 'is-empty']">
            {{ selectedVoice(group) ? statusLabel(selectedVoice(group)!) : t('episode.voice.missing') }}
          </span>
        </header>

        <template v-if="selectedVoice(group)">
          <VoiceAssetFields :voice="selectedVoice(group)!" :draft="draftFor(selectedVoice(group)!)" :busy="busyIds.includes(`c${group.character_id}`)" />
          <footer class="voice-actions">
            <button class="btn btn-sm" type="button" :disabled="savingId === selectedVoice(group)!.id" @click="save(selectedVoice(group)!)">
              {{ t('episode.voice.save') }}
            </button>
            <button class="btn btn-sm" type="button" :disabled="sampleBusyId === selectedVoice(group)!.id" @click="audition(selectedVoice(group)!)">
              <Play v-if="sampleBusyId !== selectedVoice(group)!.id" :size="11" />
              <Loader2 v-else :size="11" class="animate-spin" />
              {{ t('episode.voice.audition') }}
            </button>
            <button class="btn btn-sm" type="button" :disabled="busyIds.includes(`c${group.character_id}`)" @click="generate(group.character_id, true)">
              <Loader2 v-if="busyIds.includes(`c${group.character_id}`)" :size="11" class="animate-spin" />
              {{ t('episode.voice.regenerate') }}
            </button>
            <button
              v-if="!selectedVoice(group)!.isActive"
              class="btn btn-sm"
              type="button"
              :disabled="savingId === selectedVoice(group)!.id"
              @click="activate(group.character_id, selectedVoice(group)!)"
            >
              {{ t('episode.voice.setActive') }}
            </button>
            <span class="voice-action-spacer" />
            <select v-model="cloneTargets[selectedVoice(group)!.id]" class="voice-clone-target">
              <option value="">{{ t('episode.voice.cloneTarget') }}</option>
              <option v-for="other in cloneTargetCharacters(group.character_id)" :key="`c${other.id}`" :value="`c${other.id}`">
                {{ other.name }}
              </option>
              <option value="narrator">{{ t('episode.voice.cloneNarrator') }}</option>
            </select>
            <button
              class="btn btn-sm"
              type="button"
              :disabled="!cloneTargets[selectedVoice(group)!.id] || cloningId === selectedVoice(group)!.id"
              @click="cloneToCharacter(group, selectedVoice(group)!)"
            >
              <Loader2 v-if="cloningId === selectedVoice(group)!.id" :size="11" class="animate-spin" />
              {{ t('episode.voice.clone') }}
            </button>
            <button class="btn btn-sm btn-danger" type="button" :disabled="deletingId === selectedVoice(group)!.id" @click="remove(group, selectedVoice(group)!)">
              <Loader2 v-if="deletingId === selectedVoice(group)!.id" :size="11" class="animate-spin" />
              <template v-else>{{ t('episode.voice.delete') }}</template>
            </button>
          </footer>
          <p v-if="errors[`c${group.character_id}`]" class="voice-error">{{ errors[`c${group.character_id}`] }}</p>
        </template>

        <div v-else class="voice-card-empty">
          <p>{{ t('episode.voice.empty') }}</p>
          <button class="btn btn-sm btn-primary" type="button" :disabled="busyIds.includes(`c${group.character_id}`)" @click="generate(group.character_id, false)">
            <Loader2 v-if="busyIds.includes(`c${group.character_id}`)" :size="11" class="animate-spin" />
            {{ t('episode.voice.generate') }}
          </button>
          <p v-if="errors[`c${group.character_id}`]" class="voice-error">{{ errors[`c${group.character_id}`] }}</p>
        </div>
      </article>
    </div>

    <audio ref="player" preload="none" class="voice-audio" />
  </div>
</template>

<script setup lang="ts">
import { Loader2, Play } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { voiceProfileAPI, type VoiceProfile, type VoiceProfileList } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

interface Draft {
  name: string
  voicePrompt: string
  designInstruct: string
  speed: number
  emotion: string
}

const props = defineProps<{
  dramaId: number
  episodeId?: number | null
}>()

const emit = defineEmits<{ updated: [] }>()

const { t } = useI18n()
const loading = ref(false)
const batchRunning = ref(false)
const groups = ref<VoiceProfileList[]>([])
const narratorVoice = ref<VoiceProfile | null>(null)
const selectedIds = reactive<Record<number, number>>({})
const cloneTargets = reactive<Record<number, string>>({})
const drafts = reactive<Record<number, Draft>>({})
const errors = reactive<Record<string, string>>({})
const busyIds = ref<string[]>([])
const savingId = ref<number | null>(null)
const sampleBusyId = ref<number | null>(null)
const cloningId = ref<number | null>(null)
const deletingId = ref<number | null>(null)
const player = ref<HTMLAudioElement | null>(null)

function sortedVoices(voices: VoiceProfile[]): VoiceProfile[] {
  return [...voices].sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.id - a.id)
}

function selectedVoice(group: VoiceProfileList): VoiceProfile | null {
  const voices = group.voices
  if (!voices.length) return null
  const id = selectedIds[group.character_id]
  return voices.find(v => v.id === id)
    || voices.find(v => v.isActive)
    || sortedVoices(voices)[0]
}

function selectVersion(group: VoiceProfileList, event: Event) {
  selectedIds[group.character_id] = Number((event.target as HTMLSelectElement).value)
}

function draftFor(voice: VoiceProfile): Draft {
  if (!drafts[voice.id]) {
    drafts[voice.id] = {
      name: voice.name || '',
      voicePrompt: voice.voicePrompt || '',
      designInstruct: voice.designInstruct || '',
      speed: Number(voice.speed) || 1,
      emotion: voice.emotion || '',
    }
  }
  return drafts[voice.id]
}

function resetDrafts() {
  const all = [
    ...groups.value.flatMap(group => group.voices),
    ...(narratorVoice.value ? [narratorVoice.value] : []),
  ]
  for (const voice of all) {
    drafts[voice.id] = {
      name: voice.name || '',
      voicePrompt: voice.voicePrompt || '',
      designInstruct: voice.designInstruct || '',
      speed: Number(voice.speed) || 1,
      emotion: voice.emotion || '',
    }
    cloneTargets[voice.id] = ''
  }
}

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

function mediaUrl(url: string) {
  return url.startsWith('/') || /^https?:\/\//i.test(url) ? url : `/${url}`
}

function cloneTargetCharacters(excludeId: number) {
  return groups.value
    .filter(group => group.character_id !== excludeId)
    .map(group => ({ id: group.character_id, name: group.character_name }))
}

async function load() {
  loading.value = true
  try {
    const [list, narrator] = await Promise.all([
      voiceProfileAPI.list(props.dramaId),
      voiceProfileAPI.narrator.get(props.dramaId).catch(() => null),
    ])
    groups.value = Array.isArray(list?.characters) ? list.characters : []
    narratorVoice.value = narrator || null
    for (const group of groups.value) {
      const active = group.voices.find(v => v.isActive)
      if (!selectedIds[group.character_id] || !group.voices.some(v => v.id === selectedIds[group.character_id])) {
        selectedIds[group.character_id] = (active || sortedVoices(group.voices)[0])?.id || 0
      }
    }
    resetDrafts()
  } catch (error) {
    toastError(error)
  } finally {
    loading.value = false
  }
}

async function save(voice: VoiceProfile) {
  const draft = draftFor(voice)
  savingId.value = voice.id
  delete errors[`v${voice.id}`]
  try {
    await voiceProfileAPI.updateById(voice.id, {
      name: draft.name.trim() || voice.name,
      voice_prompt: draft.voicePrompt,
      design_instruct: draft.designInstruct || null,
      speed: Number(draft.speed) || 1,
      emotion: draft.emotion || null,
    })
    await load()
    emit('updated')
    toast.success(t('episode.voice.saved'))
  } catch (error) {
    toastError(error)
  } finally {
    savingId.value = null
  }
}

async function generate(characterId: number, force: boolean) {
  const key = `c${characterId}`
  if (busyIds.value.includes(key)) return
  busyIds.value = [...busyIds.value, key]
  delete errors[key]
  try {
    const result = await voiceProfileAPI.generate(characterId, {
      force,
      episode_id: props.episodeId || undefined,
    })
    if (!result?.voice) throw new Error(t('episode.voice.generateFailed'))
    await load()
    emit('updated')
    toast.success(t('episode.voice.generated'))
  } catch (error: any) {
    errors[key] = String(error?.message || error)
    toastError(error)
  } finally {
    busyIds.value = busyIds.value.filter(id => id !== key)
  }
}

async function generateNarrator() {
  if (busyIds.value.includes('narrator')) return
  busyIds.value = [...busyIds.value, 'narrator']
  delete errors.narrator
  try {
    await voiceProfileAPI.narrator.generate(props.dramaId, Boolean(narratorVoice.value))
    await load()
    emit('updated')
    toast.success(t('episode.voice.generated'))
  } catch (error: any) {
    errors.narrator = String(error?.message || error)
    toastError(error)
  } finally {
    busyIds.value = busyIds.value.filter(id => id !== 'narrator')
  }
}

async function generateMissing() {
  const targets = groups.value.filter(group => !group.voices.some(v => v.isActive))
  if (!targets.length) {
    toast.success(t('episode.voice.allReady'))
    return
  }
  batchRunning.value = true
  let ok = 0
  let failed = 0
  for (const group of targets) {
    const key = `c${group.character_id}`
    busyIds.value = [...busyIds.value, key]
    delete errors[key]
    try {
      const result = await voiceProfileAPI.generate(group.character_id, { episode_id: props.episodeId || undefined })
      if (!result?.voice) throw new Error(t('episode.voice.generateFailed'))
      ok += 1
    } catch (error: any) {
      failed += 1
      errors[key] = String(error?.message || error)
    } finally {
      busyIds.value = busyIds.value.filter(id => id !== key)
    }
  }
  await load()
  emit('updated')
  batchRunning.value = false
  toast.success(t('episode.voice.batchSummary', { ok, failed }))
}

async function audition(voice: VoiceProfile) {
  sampleBusyId.value = voice.id
  try {
    const result = await voiceProfileAPI.sampleById(voice.id)
    if (result?.sample_url && player.value) {
      player.value.src = mediaUrl(result.sample_url)
      await player.value.play().catch(() => {})
      await load()
    }
  } catch (error) {
    toastError(error)
  } finally {
    sampleBusyId.value = null
  }
}

async function activate(characterId: number, voice: VoiceProfile) {
  savingId.value = voice.id
  try {
    await voiceProfileAPI.activateById(voice.id, characterId)
    await load()
    emit('updated')
    toast.success(t('episode.voice.activated', { name: voice.name }))
  } catch (error) {
    toastError(error)
  } finally {
    savingId.value = null
  }
}

async function cloneToCharacter(group: VoiceProfileList, voice: VoiceProfile) {
  const target = cloneTargets[voice.id]
  if (!target) return
  cloningId.value = voice.id
  try {
    const payload = target === 'narrator'
      ? { scope: 'narrator' as const }
      : { scope: 'character' as const, character_id: Number(target.replace('c', '')) }
    await voiceProfileAPI.cloneTo(voice.id, { ...payload, activate: true })
    await load()
    emit('updated')
    toast.success(t('episode.voice.cloned', { name: voice.name }))
  } catch (error) {
    toastError(error)
  } finally {
    cloningId.value = null
  }
}

async function remove(group: VoiceProfileList, voice: VoiceProfile) {
  if (!window.confirm(t('episode.voice.deleteConfirm', { name: voice.name }))) return
  deletingId.value = voice.id
  try {
    await voiceProfileAPI.removeById(voice.id)
    delete selectedIds[group.character_id]
    await load()
    emit('updated')
    toast.success(t('episode.voice.deleted'))
  } catch (error) {
    toastError(error)
  } finally {
    deletingId.value = null
  }
}

onMounted(load)
watch(() => props.dramaId, load)
</script>



<style scoped>
.voice-asset-grid { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.voice-bar { display: flex; align-items: center; gap: 12px; }
.voice-bar-copy { display: flex; flex-direction: column; gap: 2px; }
.voice-bar-copy .dim { font-size: 12px; color: var(--text-3); }
.voice-loading { display: flex; justify-content: center; padding: 40px 0; color: var(--text-3); }
.voice-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
.voice-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-1, #fff);
  min-width: 0;
}
.voice-card.is-missing { border-style: dashed; }
.voice-card.is-narrator { background: var(--bg-2); }
.voice-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.voice-card-title { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.voice-card-title strong { font-size: 13px; color: var(--text-1); }
.voice-kind { font-size: 10px; color: var(--text-3); background: rgba(127,127,127,.12); border-radius: 4px; padding: 0 5px; }
.voice-chip { margin-left: auto; font-size: 10px; padding: 1px 7px; border-radius: 999px; background: rgba(127,127,127,.14); color: var(--text-2); }
.voice-chip.is-ready { color: #2e8b57; background: rgba(46,139,87,.14); }
.voice-chip.is-failed { color: #d9534f; background: rgba(217,83,79,.14); }
.voice-chip.is-draft, .voice-chip.is-pending_model, .voice-chip.is-generating { color: #c48a1b; background: rgba(196,138,27,.14); }
.voice-version { max-width: 160px; font-size: 11px; padding: 2px 4px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-2); color: var(--text-1); }
.voice-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.voice-action-spacer { flex: 1; }
.voice-clone-target { max-width: 120px; font-size: 11px; padding: 2px 4px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-2); color: var(--text-1); }
.voice-card-empty { display: flex; flex-direction: column; gap: 8px; padding: 14px 0; align-items: flex-start; color: var(--text-3); font-size: 12px; }
.voice-error { margin: 0; color: #d9534f; font-size: 11px; word-break: break-word; }
.voice-audio { display: none; }
</style>
