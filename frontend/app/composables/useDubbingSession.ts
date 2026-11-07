import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import {
  aiConfigAPI,
  bgmAPI,
  dubbingAPI,
  episodeAPI,
  settingsAPI,
  type DubState,
  type DubbingDefaults,
  type MergeDecision,
  type MergePlan,
  type StoryboardLine,
  type TimelineCue,
  type VoiceProfile,
} from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { useLineTakes } from '~/composables/useLineTakes'
import { useVoiceProfiles } from '~/composables/useVoiceProfiles'

export interface SynthesizeAllOptions {
  filter?: 'pending' | 'failed' | 'audio_stale' | 'all'
  contextMode?: 'off' | 'light' | 'deep'
  concurrency?: number
  lineIds?: number[] | null
}

export interface NewLinePayload {
  text: string
  speaker_type: 'dialogue' | 'narration' | 'inner'
  character_id?: number | null
  speaker_name?: string | null
  direction?: string | null
  anchor: {
    type: 'shot' | 'absolute'
    storyboard_id?: number | null
    start_ms?: number
    after_line_id?: number | null
  }
}

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
  const episodeVideoAudioMode = ref<'auto' | 'native' | 'ambient' | 'silent'>('auto')
  const originalAudioLocked = computed(() => episodeVideoAudioMode.value === 'silent')
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
  const timelineTotalMs = ref(0)
  const videoUrl = ref('')
  const mergePlan = ref<MergePlan | null>(null)
  const mergePreviewing = ref(false)
  const mergeApplying = ref(false)
  // 音色数据统一来自 useVoiceProfiles：配音步骤、资产弹窗、角色详情共用同一份状态。
  const voiceStore = useVoiceProfiles({
    dramaId: () => options.dramaId(),
    episodeId: () => options.episodeId(),
  })
  const takeStore = useLineTakes({
    episodeId: () => options.episodeId(),
    onChanged: () => options.onUpdated?.(),
  })
  const voiceProfiles = voiceStore.groups
  const narratorVoice = voiceStore.activeNarrator
  const voiceLoading = voiceStore.loading
  const voiceGeneratingAll = voiceStore.batchRunning
  let defaultsAppliedFor: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function maxCueEnd(cues: TimelineCue[]) {
    return cues.reduce((max, cue) => Math.max(max, Number(cue.endMs) || 0), 0)
  }

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

  /** 未分配角色的对白按说话人名分组，供音色分配页「设为角色/绑定现有」 */
  const unassignedSpeakers = computed(() => {
    const map = new Map<string, { name: string; lineCount: number }>()
    for (const line of lines.value) {
      if (line.speakerType !== 'dialogue' || line.characterId) continue
      const name = (line.speakerName || '').trim() || t('workbench.unnamedSpeaker')
      const current = map.get(name)
      if (current) {
        current.lineCount += 1
        continue
      }
      map.set(name, { name, lineCount: 1 })
    }
    return [...map.values()].sort((a, b) => b.lineCount - a.lineCount)
  })
  const unassignedLineCount = computed(() => unassignedSpeakers.value.reduce((sum, speaker) => sum + speaker.lineCount, 0))
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

  /** 批量/逐句改派可选的项目音色（自动 + 角色版本 + 旁白） */
  const allVoiceOptions = computed(() => {
    const options: { label: string; value: string }[] = [{ label: t('workbench.voiceAuto'), value: '' }]
    for (const group of voiceProfiles.value) {
      for (const voice of group.voices) {
        const suffix = voice.isActive ? ` · ${t('workbench.voiceActiveShort')}` : ''
        options.push({ label: `${group.character_name} · ${voice.name}${suffix}`, value: String(voice.id) })
      }
    }
    if (narratorVoice.value) {
      options.push({ label: `${t('workbench.narrator')} · ${narratorVoice.value.name}`, value: String(narratorVoice.value.id) })
    }
    return options
  })

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
    await voiceStore.load(true)
  }

  async function loadTimeline() {
    const episodeId = options.episodeId()
    if (!episodeId) return
    try {
      const timeline = await dubbingAPI.timeline(episodeId)
      timelineCues.value = Array.isArray(timeline?.cues) ? timeline.cues : []
      timelineTotalMs.value = Number(timeline?.totalDurationMs) || maxCueEnd(timelineCues.value)
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
      timelineTotalMs.value = Number(timeline?.totalDurationMs) || maxCueEnd(timelineCues.value)
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

      const rawMode = String(episode?.video_audio_mode || episode?.videoAudioMode || 'auto')
      episodeVideoAudioMode.value = (['auto', 'native', 'ambient', 'silent'].includes(rawMode)
        ? rawMode : 'auto') as typeof episodeVideoAudioMode.value
      if (originalAudioLocked.value) originalAudio.value = 'mute'

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

  async function addLine(payload: NewLinePayload): Promise<boolean> {
    const episodeId = options.episodeId()
    if (!episodeId) return false
    saving.value = true
    try {
      await dubbingAPI.addLine(episodeId, payload)
      await load()
      toast.success(t('workbench.lineAdded'))
      options.onUpdated?.()
      return true
    } catch (error) {
      toastError(error)
      return false
    } finally {
      saving.value = false
    }
  }

  /** 软删除并给出撤销入口；撤销失败不吞掉原错误。 */
  async function removeLine(line: StoryboardLine) {
    const episodeId = options.episodeId()
    if (!episodeId) return
    try {
      await dubbingAPI.deleteLine(line.id)
      await load()
      options.onUpdated?.()
      toast.success(t('workbench.lineDeleted'), {
        action: {
          label: t('workbench.undo'),
          onClick: () => { void restoreDeletedLine(line.id) },
        },
      })
    } catch (error) {
      toastError(error)
    }
  }

  async function restoreDeletedLine(lineId: number) {
    try {
      await dubbingAPI.restoreLine(lineId)
      await load()
      toast.success(t('workbench.lineRestored'))
      options.onUpdated?.()
    } catch (error) {
      toastError(error)
    }
  }

  /** visibleIds 支持筛选视图：把台词移动到当前可见的相邻项前后。 */
  async function moveLine(line: StoryboardLine, direction: -1 | 1, visibleIds?: number[]) {
    const episodeId = options.episodeId()
    if (!episodeId) return
    const visible = visibleIds?.length ? visibleIds : lines.value.map(item => item.id)
    const visibleIndex = visible.indexOf(line.id)
    const neighborId = visibleIndex >= 0 ? visible[visibleIndex + direction] : undefined
    const target = neighborId ? lines.value.find(item => item.id === neighborId) : null
    if (!target) return
    if ((target.storyboardId ?? null) !== (line.storyboardId ?? null)) {
      toast.info(t('workbench.moveAcrossShot'))
      return
    }
    const ordered = lines.value.map(item => item.id)
    const from = ordered.indexOf(line.id)
    if (from < 0) return
    ordered.splice(from, 1)
    const targetIndex = ordered.indexOf(target.id)
    if (targetIndex < 0) return
    ordered.splice(direction === 1 ? targetIndex + 1 : targetIndex, 0, line.id)
    try {
      await dubbingAPI.reorderLines(episodeId, ordered)
      await load()
      options.onUpdated?.()
    } catch (error) {
      toastError(error)
    }
  }

  async function toggleLock(line: StoryboardLine) {
    try {
      await dubbingAPI.updateLine(line.id, { locked: !line.locked })
      await load()
      options.onUpdated?.()
    } catch (error) {
      toastError(error)
    }
  }

  async function previewExtract(): Promise<MergePlan | null> {
    const episodeId = options.episodeId()
    if (!episodeId) return null
    mergePreviewing.value = true
    try {
      const plan = await dubbingAPI.extractPreview(episodeId, { force: true })
      mergePlan.value = plan
      return plan
    } catch (error) {
      toastError(error)
      return null
    } finally {
      mergePreviewing.value = false
    }
  }

  async function applyExtract(decisions: MergeDecision[] = []): Promise<boolean> {
    const episodeId = options.episodeId()
    const plan = mergePlan.value
    if (!episodeId || !plan) return false
    mergeApplying.value = true
    try {
      const result = await dubbingAPI.extractApply(episodeId, plan.extractionId, decisions)
      mergePlan.value = null
      await load()
      toast.success(t('workbench.extractApplyDone', {
        inserted: result.inserted,
        updated: result.updated,
        removed: result.removed,
      }))
      options.onUpdated?.()
      return true
    } catch (error) {
      toastError(error)
      return false
    } finally {
      mergeApplying.value = false
    }
  }

  function clearMergePlan() {
    mergePlan.value = null
  }

  async function synthesizeAll(optionsBatch: SynthesizeAllOptions = {}) {
    const episodeId = options.episodeId()
    if (!episodeId) return
    synthesizing.value = true
    try {
      const job = await takeStore.startBatch({
        filter: optionsBatch.filter ?? 'pending',
        contextMode: optionsBatch.contextMode ?? 'light',
        ...(optionsBatch.concurrency ? { concurrency: optionsBatch.concurrency } : {}),
        ...(optionsBatch.lineIds ? { lineIds: optionsBatch.lineIds } : {}),
      })
      if (!job) return
      serviceError.value = ''
      if (job.failed && job.errors[0]) noteServiceError(new Error(job.errors[0].message))
      await Promise.all([load(), loadTimeline()])
      toast.success(t('workbench.synthDone', { ok: job.ok, failed: job.failed }))
      options.onUpdated?.()
    } finally {
      synthesizing.value = false
    }
  }

  async function synthesizeLine(line: StoryboardLine) {
    const result = await takeStore.generate(line.id, { contextMode: 'light' })
    if (!result) return
    serviceError.value = ''
    await Promise.all([load(), loadTimeline()])
    options.onUpdated?.()
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

  /** 改派单句音色：后端会作废旧音频，需重新合成 */
  async function assignLineVoice(line: StoryboardLine, voiceId: number | null) {
    try {
      await dubbingAPI.updateLine(line.id, { voice_id: voiceId })
      await load()
      options.onUpdated?.()
      toast.success(t('workbench.voiceAssigned'))
    } catch (error) {
      toastError(error)
    }
  }

  /** 批量改派：逐句写入 voice_id，失败的单句不影响其余 */
  async function assignVoiceToLines(lineIds: number[], voiceId: number | null) {
    if (!lineIds.length) return
    let ok = 0
    for (const lineId of lineIds) {
      try {
        await dubbingAPI.updateLine(lineId, { voice_id: voiceId })
        ok += 1
      } catch (error) {
        toastError(error)
      }
    }
    await load()
    options.onUpdated?.()
    toast.success(t('workbench.batchAssigned', { n: ok }))
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

  async function generateMissingVoices() {
    const targets = missingVoiceSpeakers.value.map(speaker => speaker.characterId)
    await voiceStore.generateMissing(targets)
    await load()
  }

  async function bindSpeaker(speakerName: string, characterId?: number | null) {
    const episodeId = options.episodeId()
    if (!episodeId) return null
    try {
      const result = await dubbingAPI.bindSpeaker(episodeId, { speaker_name: speakerName, character_id: characterId || null })
      await Promise.all([load(), voiceStore.load(true)])
      toast.success(t('workbench.speakerBound', { name: speakerName, n: result.bound }))
      return result
    } catch (error) {
      toastError(error)
      return null
    }
  }

  async function resetVoices() {
    const episodeId = options.episodeId()
    if (!episodeId) return
    try {
      const result = await dubbingAPI.resetVoices(episodeId)
      await load()
      toast.success(t('workbench.voicesReset', { n: result.cleared }))
    } catch (error) {
      toastError(error)
    }
  }

  async function detachSpeaker(characterId: number, name: string) {
    const episodeId = options.episodeId()
    if (!episodeId) return null
    try {
      const result = await dubbingAPI.detachSpeaker(episodeId, characterId)
      await Promise.all([load(), voiceStore.load(true)])
      toast.success(t(result.mode === 'deleted' ? 'workbench.speakerDeleted' : 'workbench.speakerUnbound', { name, n: result.cleared_lines }))
      return result
    } catch (error) {
      toastError(error)
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
    episodeVideoAudioMode,
    originalAudioLocked,
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
    timelineTotalMs,
    videoUrl,
    mergePlan,
    mergePreviewing,
    mergeApplying,
    voiceProfiles,
    narratorVoice,
    voiceLoading,
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
    unassignedSpeakers,
    unassignedLineCount,
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
    allVoiceOptions,
    activeVoiceFor,
    load,
    loadVoices,
    loadTimeline,
    noteServiceError,
    applyBgm,
    uploadBgm,
    extract,
    addLine,
    removeLine,
    restoreDeletedLine,
    moveLine,
    toggleLock,
    previewExtract,
    applyExtract,
    clearMergePlan,
    synthesizeAll,
    synthesizeLine,
    takes: takeStore,
    saveLineText,
    assignLineVoice,
    assignVoiceToLines,
    startDub,
    stopDub,
    exportSubtitle,
    generateMissingVoices,
    bindSpeaker,
    resetVoices,
    detachSpeaker,
    dispose,
  }
}
