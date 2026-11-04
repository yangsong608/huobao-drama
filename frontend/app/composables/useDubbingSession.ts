import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import {
  aiConfigAPI,
  bgmAPI,
  dubbingAPI,
  episodeAPI,
  settingsAPI,
  voiceProfileAPI,
  type DubState,
  type DubbingDefaults,
  type StoryboardLine,
  type TimelineCue,
  type VoiceProfile,
  type VoiceProfileList,
} from '~/composables/useApi'
import { toastError } from '~/composables/useToast'

/**
 * 配音会话：抽屉快速试听与左侧「配音」阶段共用同一份数据与动作。
 * 完整流程（步骤、布局）由 DubbingStage 负责；抽屉只消费播放/字幕/台词。
 */
export function useDubbingSession(options: {
  episodeId: () => number | null
  dramaId: () => number
  onUpdated?: () => void
}) {
  const { t } = useI18n()

  const lines = ref<StoryboardLine[]>([])
  const state = ref<DubState | null>(null)
  const loading = ref(false)
  const synthesizing = ref(false)
  const saving = ref(false)
  const subtitleMode = ref<'soft' | 'burn' | 'none'>('soft')
  const originalAudio = ref<'duck' | 'keep' | 'mute'>('duck')
  const duckingRatio = ref(6)
  const bgmItems = ref<{ name: string; url: string }[]>([])
  const bgmName = ref('')
  const bgmVolumePct = ref(18)
  const bgmSaving = ref(false)
  const bgmUploading = ref(false)
  const defaults = ref<DubbingDefaults | null>(null)
  const dubbingEnabled = ref(true)
  const audioConfigs = ref<any[]>([])
  const audioConfigsLoaded = ref(false)
  const serviceError = ref('')
  const timelineCues = ref<TimelineCue[]>([])
  const videoUrl = ref('')
  const voiceProfiles = ref<VoiceProfileList[]>([])
  const narratorVoice = ref<VoiceProfile | null>(null)
  const voiceLoading = ref(false)
  const voiceBusyIds = ref<number[]>([])
  const narratorBusy = ref(false)
  const voiceGeneratingAll = ref(false)
  let defaultsAppliedFor: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const busy = computed(() => loading.value || synthesizing.value || saving.value || state.value?.status === 'running')
  const readyCount = computed(() => lines.value.filter(line => line.status === 'ready' && line.audioUrl).length)
  const failedCount = computed(() => lines.value.filter(line => line.status === 'failed').length)
  const pendingCount = computed(() => Math.max(lines.value.length - readyCount.value - failedCount.value, 0))
  const statusLabel = computed(() => {
    const status = state.value?.status
    return status === 'running' ? t('workbench.running')
      : status === 'done' ? t('workbench.done')
        : status === 'failed' ? t('workbench.failed')
          : t('workbench.idle')
  })
  const subtitleOptions = computed(() => [
    { label: t('workbench.soft'), value: 'soft' },
    { label: t('workbench.burn'), value: 'burn' },
    { label: t('workbench.none'), value: 'none' },
  ])
  const originalOptions = computed(() => [
    { label: t('workbench.duck'), value: 'duck' },
    { label: t('workbench.keep'), value: 'keep' },
    { label: t('workbench.mute'), value: 'mute' },
  ])
  const bgmOptions = computed(() => bgmItems.value.map(item => ({ label: item.name, value: item.name })))
  const selectedBgm = computed(() => bgmItems.value.find(item => item.name === bgmName.value) || null)
  const activeAudioCfgs = computed(() => audioConfigs.value.filter((cfg: any) => cfg.is_active))
  const serviceBanner = computed(() => {
    if (serviceError.value) {
      return { kind: 'error', text: t('workbench.serviceUnreachable', { reason: serviceError.value }), action: true }
    }
    if (!dubbingEnabled.value) {
      return { kind: 'warn', text: t('workbench.serviceOff'), action: true }
    }
    if (audioConfigsLoaded.value && !activeAudioCfgs.value.length) {
      return { kind: 'warn', text: t('workbench.noService'), action: true }
    }
    return null
  })

  const activeVoiceFor = (characterId: number | null | undefined) => {
    if (!characterId) return null
    const entry = voiceProfiles.value.find(item => item.character_id === characterId)
    if (!entry?.active_voice_id) return null
    return entry.voices.find(voice => voice.id === entry.active_voice_id) || null
  }

  const dialogueSpeakers = computed(() => {
    const map = new Map<number, { characterId: number; name: string; lineCount: number; voice: VoiceProfile | null }>()
    for (const line of lines.value) {
      if (line.speakerType !== 'dialogue' || !line.characterId) continue
      const current = map.get(line.characterId)
      if (current) {
        current.lineCount += 1
        continue
      }
      map.set(line.characterId, {
        characterId: line.characterId,
        name: line.speakerName || `#${line.characterId}`,
        lineCount: 1,
        voice: activeVoiceFor(line.characterId),
      })
    }
    return [...map.values()].sort((a, b) => b.lineCount - a.lineCount)
  })

  const narratorLineCount = computed(() => lines.value.filter(line => line.speakerType !== 'dialogue').length)
  const narratorReady = computed(() => Boolean(narratorVoice.value?.id))
  const narratorMissingVoice = computed(() => narratorLineCount.value > 0 && !narratorReady.value)
  const missingVoiceSpeakers = computed(() => dialogueSpeakers.value.filter(speaker => !speaker.voice))
  const missingVoiceCharacterIds = computed(() => missingVoiceSpeakers.value.map(speaker => speaker.characterId))
  const longLines = computed(() => lines.value.filter(line => [...line.text].length > 80))
  const emptyLines = computed(() => lines.value.filter(line => !line.text.trim()))
  const voiceFallbackNotice = computed(() => missingVoiceSpeakers.value.length > 0 || narratorMissingVoice.value)
  const voiceReadyCount = computed(() =>
    dialogueSpeakers.value.filter(speaker => speaker.voice).length + (narratorLineCount.value > 0 && narratorReady.value ? 1 : 0))
  const voiceTotalCount = computed(() => dialogueSpeakers.value.length + (narratorLineCount.value > 0 ? 1 : 0))

  function noteServiceError(error: any) {
    const message = String(error?.message || error || '')
    if (!/语音服务|未配置|ECONNREFUSED|Failed to fetch|fetch failed|NetworkError|timeout|超时/i.test(message)) return false
    serviceError.value = message
    return true
  }

  async function loadBgm(episodeRow?: any) {
    try {
      const [list, episode] = await Promise.all([
        bgmAPI.list(),
        episodeRow ? Promise.resolve(episodeRow) : (options.episodeId() ? episodeAPI.get(options.episodeId()!) : Promise.resolve(null)),
      ])
      bgmItems.value = list.items || []
      const current = String(episode?.bgm_url || episode?.bgmUrl || '')
      if (current) {
        const name = decodeURIComponent(current.split('/').pop() || '')
        if (bgmItems.value.some(item => item.name === name)) bgmName.value = name
      } else {
        bgmName.value = ''
      }
    } catch {
      // 曲库或单集读取失败不影响台词操作
    }
  }

  async function applyBgm() {
    const episodeId = options.episodeId()
    if (!episodeId) return
    bgmSaving.value = true
    try {
      await episodeAPI.update(episodeId, { bgm_url: selectedBgm.value?.url || null })
      toast.success(t('workbench.bgmApplied'))
    } catch (error) {
      toastError(error)
    } finally {
      bgmSaving.value = false
    }
  }

  async function uploadBgm(event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    bgmUploading.value = true
    try {
      const uploaded = await bgmAPI.upload(file)
      await loadBgm()
      bgmName.value = uploaded.name
      toast.success(t('workbench.bgmUploaded', { name: uploaded.name }))
    } catch (error) {
      toastError(error)
    } finally {
      bgmUploading.value = false
    }
  }

  async function loadVoices() {
    const dramaId = options.dramaId()
    voiceLoading.value = true
    try {
      const [list, narrator] = await Promise.all([
        voiceProfileAPI.list(dramaId).catch(() => null),
        voiceProfileAPI.narrator.get(dramaId).catch(() => null),
      ])
      voiceProfiles.value = Array.isArray(list?.characters) ? list.characters : []
      narratorVoice.value = narrator || null
    } finally {
      voiceLoading.value = false
    }
  }

  async function loadTimeline() {
    const episodeId = options.episodeId()
    if (!episodeId) return
    try {
      const timeline = await dubbingAPI.timeline(episodeId)
      timelineCues.value = Array.isArray(timeline?.cues) ? timeline.cues : []
    } catch {
      // 时间轴需要已合成台词；失败时保留旧值
    }
  }

  async function load() {
    const episodeId = options.episodeId()
    if (!episodeId) return
    loading.value = true
    try {
      const [list, dubState, timeline, episode, settings, cfgList, dubbingStatus] = await Promise.all([
        dubbingAPI.lines(episodeId),
        dubbingAPI.dubState(episodeId).catch(() => null),
        dubbingAPI.timeline(episodeId).catch(() => null),
        episodeAPI.get(episodeId).catch(() => null),
        settingsAPI.dubbing().catch(() => null),
        aiConfigAPI.list('audio').catch(() => null),
        dubbingAPI.status().catch(() => null),
      ])
      lines.value = list.items || []
      state.value = dubState
      timelineCues.value = Array.isArray(timeline?.cues) ? timeline.cues : []
      videoUrl.value = dubState?.outputUrl || episode?.video_url || episode?.videoUrl || ''
      defaults.value = settings?.defaults || null
      if (cfgList !== null) {
        audioConfigs.value = Array.isArray(cfgList) ? cfgList : (cfgList?.items || [])
        audioConfigsLoaded.value = true
      }
      if (dubbingStatus !== null) dubbingEnabled.value = Boolean(dubbingStatus?.enabled)

      if (defaults.value && defaultsAppliedFor !== episodeId) {
        subtitleMode.value = defaults.value.subtitleMode || 'soft'
        originalAudio.value = defaults.value.originalAudio || 'duck'
        duckingRatio.value = Number(defaults.value.duckingRatio) || 6
        bgmVolumePct.value = Math.round((defaults.value.bgmVolume ?? 0.18) * 100)
        defaultsAppliedFor = episodeId
      }

      await Promise.all([loadBgm(episode), loadVoices()])
      if (dubState?.status === 'running') schedule()
    } catch (error) {
      toastError(error)
    } finally {
      loading.value = false
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      const episodeId = options.episodeId()
      if (!episodeId) return
      try {
        state.value = await dubbingAPI.dubState(episodeId)
        if (state.value?.status === 'running') schedule()
        else {
          await load()
          options.onUpdated?.()
        }
      } catch {
        // 轮询失败忽略，下次再试
      }
    }, 3000)
  }

  async function extract() {
    const episodeId = options.episodeId()
    if (!episodeId) return
    loading.value = true
    try {
      const result: any = await dubbingAPI.extract(episodeId, true)
      await load()
      toast.success(t('workbench.extracted', { n: result?.total ?? lines.value.length }))
    } catch (error) {
      toastError(error)
    } finally {
      loading.value = false
    }
  }

  async function synthesizeAll() {
    const episodeId = options.episodeId()
    if (!episodeId) return
    synthesizing.value = true
    try {
      const result: any = await dubbingAPI.synthesizeAll(episodeId)
      serviceError.value = ''
      await Promise.all([load(), loadTimeline()])
      toast.success(t('workbench.synthDone', { ok: result?.ok ?? 0, failed: result?.failed ?? 0 }))
      options.onUpdated?.()
    } catch (error) {
      if (!noteServiceError(error)) toastError(error)
    } finally {
      synthesizing.value = false
    }
  }

  async function synthesizeLine(line: StoryboardLine) {
    try {
      await dubbingAPI.synthesizeLine(line.id)
      serviceError.value = ''
      await Promise.all([load(), loadTimeline()])
      options.onUpdated?.()
    } catch (error) {
      if (!noteServiceError(error)) toastError(error)
    }
  }

  async function saveLineText(line: StoryboardLine, text: string) {
    saving.value = true
    try {
      await dubbingAPI.updateLine(line.id, { text })
      await load()
      options.onUpdated?.()
    } catch (error) {
      toastError(error)
    } finally {
      saving.value = false
    }
  }

  async function startDub() {
    const episodeId = options.episodeId()
    if (!episodeId) return
    try {
      const result = await dubbingAPI.startDub(episodeId, {
        subtitle_mode: subtitleMode.value,
        original_audio: originalAudio.value,
        bgm_url: selectedBgm.value?.url || null,
        bgm_volume: bgmVolumePct.value / 100,
        ducking_ratio: duckingRatio.value,
      })
      serviceError.value = ''
      state.value = result.state
      schedule()
      options.onUpdated?.()
    } catch (error) {
      if (!noteServiceError(error)) toastError(error)
    }
  }

  async function stopDub() {
    const episodeId = options.episodeId()
    if (!episodeId) return
    try {
      await dubbingAPI.stopDub(episodeId)
      state.value = await dubbingAPI.dubState(episodeId)
      options.onUpdated?.()
    } catch (error) {
      toastError(error)
    }
  }

  async function exportSubtitle(format: 'srt' | 'ass') {
    const episodeId = options.episodeId()
    if (!episodeId) return
    try {
      const result = await dubbingAPI.subtitles(episodeId, format)
      if (result?.url) window.open(`/${result.url}`, '_blank')
    } catch (error) {
      toastError(error)
    }
  }

  async function generateCharacterVoice(characterId: number, force = false) {
    if (voiceBusyIds.value.includes(characterId)) return
    voiceBusyIds.value = [...voiceBusyIds.value, characterId]
    try {
      await voiceProfileAPI.generate(characterId, {
        force,
        episode_id: options.episodeId() || undefined,
      })
      await Promise.all([loadVoices(), load()])
      toast.success(t('workbench.voiceGenerated'))
    } catch (error) {
      if (!noteServiceError(error)) toastError(error)
    } finally {
      voiceBusyIds.value = voiceBusyIds.value.filter(id => id !== characterId)
    }
  }

  async function generateMissingVoices() {
    if (voiceGeneratingAll.value) return
    const targets = missingVoiceSpeakers.value.map(speaker => speaker.characterId)
    if (!targets.length) {
      toast.success(t('workbench.voiceAllReady'))
      return
    }
    voiceGeneratingAll.value = true
    try {
      for (const characterId of targets) {
        if (voiceBusyIds.value.includes(characterId)) continue
        voiceBusyIds.value = [...voiceBusyIds.value, characterId]
        try {
          await voiceProfileAPI.generate(characterId, { episode_id: options.episodeId() || undefined })
        } catch (error) {
          if (!noteServiceError(error)) toastError(error)
        } finally {
          voiceBusyIds.value = voiceBusyIds.value.filter(id => id !== characterId)
        }
      }
      await Promise.all([loadVoices(), load()])
      toast.success(t('workbench.voiceGenerated'))
    } finally {
      voiceGeneratingAll.value = false
    }
  }

  async function generateNarratorVoice(force = false) {
    if (narratorBusy.value) return
    narratorBusy.value = true
    try {
      await voiceProfileAPI.narrator.generate(options.dramaId(), force)
      await Promise.all([loadVoices(), load()])
      toast.success(t('workbench.voiceGenerated'))
    } catch (error) {
      if (!noteServiceError(error)) toastError(error)
    } finally {
      narratorBusy.value = false
    }
  }

  async function auditionCharacter(characterId: number) {
    const voice = activeVoiceFor(characterId)
    if (!voice) {
      toast.error(t('workbench.voiceGenerateFirst'))
      return null
    }
    try {
      const result = await voiceProfileAPI.sample(characterId, { voice_id: voice.id })
      return result.sample_url
    } catch (error) {
      if (!noteServiceError(error)) toastError(error)
      return null
    }
  }

  async function auditionNarrator() {
    try {
      const result = await voiceProfileAPI.narrator.sample(options.dramaId())
      return result.sample_url
    } catch (error) {
      if (!noteServiceError(error)) toastError(error)
      return null
    }
  }

  function dispose() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  onBeforeUnmount(dispose)

  return {
    lines,
    state,
    loading,
    synthesizing,
    saving,
    subtitleMode,
    originalAudio,
    duckingRatio,
    bgmItems,
    bgmName,
    bgmVolumePct,
    bgmSaving,
    bgmUploading,
    defaults,
    dubbingEnabled,
    serviceError,
    timelineCues,
    videoUrl,
    voiceProfiles,
    narratorVoice,
    voiceLoading,
    voiceBusyIds,
    narratorBusy,
    voiceGeneratingAll,
    busy,
    readyCount,
    failedCount,
    pendingCount,
    statusLabel,
    subtitleOptions,
    originalOptions,
    bgmOptions,
    selectedBgm,
    activeAudioCfgs,
    serviceBanner,
    dialogueSpeakers,
    narratorLineCount,
    narratorReady,
    narratorMissingVoice,
    missingVoiceSpeakers,
    missingVoiceCharacterIds,
    longLines,
    emptyLines,
    voiceFallbackNotice,
    voiceReadyCount,
    voiceTotalCount,
    activeVoiceFor,
    load,
    loadVoices,
    loadTimeline,
    noteServiceError,
    applyBgm,
    uploadBgm,
    extract,
    synthesizeAll,
    synthesizeLine,
    saveLineText,
    startDub,
    stopDub,
    exportSubtitle,
    generateCharacterVoice,
    generateMissingVoices,
    generateNarratorVoice,
    auditionCharacter,
    auditionNarrator,
    dispose,
  }
}
