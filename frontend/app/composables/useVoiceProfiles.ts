import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { voiceProfileAPI, type VoiceProfile, type VoiceProfileList } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

/**
 * 音色档案的唯一前端数据源：音色分配、资产弹窗、角色详情共用同一份状态。
 * 模块级 ref 在 SPA 内跨组件共享，避免各入口各拉一份、各改各的。
 */

export interface VoiceDraft {
  name: string
  voicePrompt: string
  designInstruct: string
  speed: number
  emotion: string
  externalVoiceId: string
}

const groups = ref<VoiceProfileList[]>([])
const narratorVersions = ref<VoiceProfile[]>([])
const activeNarrator = ref<VoiceProfile | null>(null)
const voiceLoading = ref(false)
const voiceLoadedDramaId = ref(0)
const voiceBusyKeys = ref<string[]>([])
const voiceBatchRunning = ref(false)
const voiceLastSynced = ref<Record<number, { voiceId: number; url: string }>>({})
let loadPromise: Promise<void> | null = null

export interface UseVoiceProfilesOptions {
  dramaId: () => number
  episodeId?: () => number | null
  onChanged?: () => void
}

function busyKeyFor(voice: VoiceProfile): string {
  return voice.scope === 'narrator' ? 'narrator' : `c${voice.characterId ?? ''}`
}

export function useVoiceProfiles(options: UseVoiceProfilesOptions) {
  const { t } = useI18n()

  function markBusy(key: string) {
    if (!voiceBusyKeys.value.includes(key)) voiceBusyKeys.value = [...voiceBusyKeys.value, key]
  }

  function clearBusy(key: string) {
    voiceBusyKeys.value = voiceBusyKeys.value.filter(item => item !== key)
  }

  function isBusy(key: string) {
    return voiceBusyKeys.value.includes(key)
  }

  function notify() {
    options.onChanged?.()
  }

  function patchVoice(voiceId: number, patch: Partial<VoiceProfile>) {
    for (const group of groups.value) {
      const voice = group.voices.find(item => item.id === voiceId)
      if (voice) Object.assign(voice, patch)
    }
    for (const voice of narratorVersions.value) {
      if (voice.id === voiceId) Object.assign(voice, patch)
    }
    if (activeNarrator.value?.id === voiceId) Object.assign(activeNarrator.value, patch)
  }

  function findVoice(voiceId: number): VoiceProfile | null {
    for (const group of groups.value) {
      const voice = group.voices.find(item => item.id === voiceId)
      if (voice) return voice
    }
    return narratorVersions.value.find(voice => voice.id === voiceId)
      || (activeNarrator.value?.id === voiceId ? activeNarrator.value : null)
  }

  function draftChanged(voice: VoiceProfile, draft: VoiceDraft): boolean {
    return draft.name.trim() !== (voice.name || '')
      || draft.voicePrompt.trim() !== (voice.voicePrompt || '').trim()
      || draft.designInstruct.trim() !== (voice.designInstruct || '').trim()
      || Number(draft.speed) !== Number(voice.speed ?? 1)
      || draft.emotion.trim() !== (voice.emotion || '').trim()
      || draft.externalVoiceId.trim() !== (voice.externalVoiceId || '').trim()
  }

  async function load(force = false): Promise<void> {
    const dramaId = Number(options.dramaId()) || 0
    if (!dramaId) return
    if (loadPromise) return loadPromise
    if (!force && voiceLoadedDramaId.value === dramaId) return
    loadPromise = (async () => {
      voiceLoading.value = true
      try {
        const [list, narrator] = await Promise.all([
          voiceProfileAPI.list(dramaId),
          voiceProfileAPI.narrator.get(dramaId).catch(() => null),
        ])
        const nextGroups = Array.isArray(list?.characters) ? list.characters : []
        const nextNarrator = Array.isArray(list?.narrator) ? list.narrator : []
        groups.value = nextGroups
        narratorVersions.value = nextNarrator
        activeNarrator.value = nextNarrator.find(voice => voice.isActive) || narrator || null
        voiceLoadedDramaId.value = dramaId
      } catch (error) {
        toastError(error)
      } finally {
        voiceLoading.value = false
      }
    })()
    try {
      await loadPromise
    } finally {
      loadPromise = null
    }
  }

  function ensureLoaded(): Promise<void> {
    return load(false)
  }

  async function persistVoice(voice: VoiceProfile, draft: VoiceDraft): Promise<boolean> {
    const key = busyKeyFor(voice)
    if (isBusy(key)) return false
    markBusy(key)
    try {
      const promptChanged = draft.voicePrompt.trim() !== (voice.voicePrompt || '').trim()
      const designTouched = draft.designInstruct.trim() !== (voice.designInstruct || '').trim()
      // 用户改了中文提示词但没单独写指令时，让指令跟随提示词，确保各语音服务都按新描述合成
      const designInstruct = designTouched
        ? (draft.designInstruct.trim() || null)
        : promptChanged
          ? (draft.voicePrompt.trim() || null)
          : (draft.designInstruct.trim() || null)
      await voiceProfileAPI.updateById(voice.id, {
        name: draft.name.trim() || voice.name,
        voice_prompt: draft.voicePrompt,
        design_instruct: designInstruct,
        speed: Number(draft.speed) || 1,
        emotion: draft.emotion || null,
        external_voice_id: draft.externalVoiceId.trim() || null,
      })
      await load(true)
      notify()
      return true
    } catch (error) {
      toastError(error)
      return false
    } finally {
      clearBusy(key)
    }
  }

  async function saveVoice(voice: VoiceProfile, draft: VoiceDraft): Promise<void> {
    if (!(await persistVoice(voice, draft))) return
    toast.success(t('episode.voice.saved'))
  }

  /** 保存当前草稿并立即按新提示词合成试听，返回音频地址 */
  async function generateFromDraft(voice: VoiceProfile, draft: VoiceDraft): Promise<string | null> {
    if (draftChanged(voice, draft)) {
      if (!(await persistVoice(voice, draft))) return null
    }
    const fresh = findVoice(voice.id) || voice
    return audition(fresh)
  }

  async function generateCharacter(characterId: number, force: boolean): Promise<VoiceProfile | null> {
    const key = `c${characterId}`
    if (isBusy(key)) return null
    markBusy(key)
    try {
      const result = await voiceProfileAPI.generate(characterId, {
        force,
        episode_id: options.episodeId?.() || undefined,
      })
      if (!result?.voice) throw new Error(t('episode.voice.generateFailed'))
      await load(true)
      notify()
      toast.success(t('episode.voice.generated'))
      return findVoice(result.voice.id) || result.voice
    } catch (error) {
      toastError(error)
      return null
    } finally {
      clearBusy(key)
    }
  }

  async function generateNarrator(force: boolean): Promise<VoiceProfile | null> {
    const key = 'narrator'
    if (isBusy(key)) return null
    markBusy(key)
    try {
      const created = await voiceProfileAPI.narrator.generate(Number(options.dramaId()), force)
      await load(true)
      notify()
      toast.success(t('episode.voice.generated'))
      return (created?.id ? findVoice(created.id) : null)
        || narratorVersions.value.find(voice => voice.isActive)
        || null
    } catch (error) {
      toastError(error)
      return null
    } finally {
      clearBusy(key)
    }
  }

  async function generateMissing(characterIds: number[]): Promise<void> {
    if (voiceBatchRunning.value) return
    const targets = [...new Set(characterIds.filter(id => Number.isFinite(id) && id > 0))]
    if (!targets.length) {
      toast.success(t('episode.voice.allReady'))
      return
    }
    voiceBatchRunning.value = true
    let ok = 0
    let failed = 0
    try {
      for (const characterId of targets) {
        const key = `c${characterId}`
        if (isBusy(key)) continue
        markBusy(key)
        try {
          const result = await voiceProfileAPI.generate(characterId, {
            episode_id: options.episodeId?.() || undefined,
          })
          if (!result?.voice) throw new Error(t('episode.voice.generateFailed'))
          ok += 1
        } catch {
          failed += 1
        } finally {
          clearBusy(key)
        }
      }
      await load(true)
      notify()
      toast.success(t('episode.voice.batchSummary', { ok, failed }))
    } finally {
      voiceBatchRunning.value = false
    }
  }

  async function audition(voice: VoiceProfile): Promise<string | null> {
    const key = busyKeyFor(voice)
    if (isBusy(key)) return null
    markBusy(key)
    try {
      const result = await voiceProfileAPI.sampleById(voice.id)
      patchVoice(voice.id, { sampleUrl: result.sample_url, status: 'ready' })
      return result.sample_url
    } catch (error) {
      toastError(error)
      return null
    } finally {
      clearBusy(key)
    }
  }

  async function activate(voice: VoiceProfile): Promise<void> {
    const key = busyKeyFor(voice)
    if (isBusy(key)) return
    markBusy(key)
    try {
      if (voice.scope === 'narrator') {
        await voiceProfileAPI.narrator.bind(Number(options.dramaId()), voice.id)
      } else {
        if (!voice.characterId) throw new Error(t('episode.voice.generateFailed'))
        await voiceProfileAPI.activateById(voice.id, voice.characterId)
      }
      await load(true)
      notify()
      toast.success(t('episode.voice.activated', { name: voice.name }))
    } catch (error) {
      toastError(error)
    } finally {
      clearBusy(key)
    }
  }

  async function syncToVideo(voice: VoiceProfile): Promise<{ voice_audio_url: string } | null> {
    if (!voice.characterId) return null
    const key = busyKeyFor(voice)
    if (isBusy(key)) return null
    markBusy(key)
    try {
      const result = await voiceProfileAPI.sync(voice.characterId, voice.id)
      voiceLastSynced.value = {
        ...voiceLastSynced.value,
        [voice.characterId]: { voiceId: voice.id, url: result.voice_audio_url },
      }
      notify()
      toast.success(t('voiceProfile.synced'))
      return result
    } catch (error) {
      toastError(error)
      return null
    } finally {
      clearBusy(key)
    }
  }

  async function cloneTo(voice: VoiceProfile, target: string): Promise<void> {
    if (!target) return
    const key = busyKeyFor(voice)
    if (isBusy(key)) return
    markBusy(key)
    try {
      const payload = target === 'narrator'
        ? { scope: 'narrator' as const }
        : { scope: 'character' as const, character_id: Number(target.replace('c', '')) }
      await voiceProfileAPI.cloneTo(voice.id, { ...payload, activate: true })
      await load(true)
      notify()
      toast.success(t('episode.voice.cloned', { name: voice.name }))
    } catch (error) {
      toastError(error)
    } finally {
      clearBusy(key)
    }
  }

  async function removeVoice(voice: VoiceProfile): Promise<void> {
    const key = busyKeyFor(voice)
    if (isBusy(key)) return
    markBusy(key)
    try {
      await voiceProfileAPI.removeById(voice.id)
      await load(true)
      notify()
      toast.success(t('episode.voice.deleted'))
    } catch (error) {
      toastError(error)
    } finally {
      clearBusy(key)
    }
  }

  async function uploadClone(characterId: number, file: File): Promise<void> {
    const key = `c${characterId}`
    if (isBusy(key)) return
    markBusy(key)
    try {
      await voiceProfileAPI.clone(characterId, file)
      await load(true)
      notify()
      toast.success(t('voiceProfile.cloneDone'))
    } catch (error) {
      toastError(error)
    } finally {
      clearBusy(key)
    }
  }

  return {
    groups,
    narratorVersions,
    activeNarrator,
    loading: voiceLoading,
    busyKeys: voiceBusyKeys,
    batchRunning: voiceBatchRunning,
    lastSynced: voiceLastSynced,
    load,
    ensureLoaded,
    saveVoice,
    generateFromDraft,
    generateCharacter,
    generateNarrator,
    generateMissing,
    audition,
    activate,
    syncToVideo,
    cloneTo,
    removeVoice,
    uploadClone,
    isBusy,
  }
}
