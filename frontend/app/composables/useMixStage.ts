/**
 * 阶段 4 · 混音工作台状态
 *
 * - MixPlan 是唯一数据源：轨道/片段/总线都从它派生，保存后以服务端结果为准；
 * - 拖拽期间用 beginChange/endChange 合并成一步撤销，撤销栈上限 50；
 * - solo 只派生 effectiveMuted，不改写 muted；
 * - 任何编辑 300ms 防抖保存；范围试听与版本先落库，保证与服务端渲染一致。
 */
import {
  mixAPI,
  type EpisodeAudioAsset,
  type MixBus,
  type MixBusKey,
  type MixClip,
  type MixPlan,
  type MixPreviewResult,
  type MixRenderResult,
  type MixRevision,
  type MixTrack,
  type SeparationStatus,
} from '~/composables/useApi'

export interface StageClip extends MixClip {
  _uid: string
}

export interface StageTrack extends Omit<MixTrack, 'clips'> {
  _uid: string
  clips: StageClip[]
}

export interface StagePlan extends Omit<MixPlan, 'tracks'> {
  tracks: StageTrack[]
}

export interface VirtualTrackSnapshot {
  role: string
  volume: number
  pan: number
  muted: boolean
  solo: boolean
  loop: boolean
}

export interface MixSnapshot {
  tracks: StageTrack[]
  buses: MixBus[]
  virtual: VirtualTrackSnapshot[]
}

export interface MixSelection {
  trackUid: string
  clipUid: string
}

export interface UseMixStageOptions {
  episodeId: () => number | null
  dramaId: () => number
  onSaved?: (plan: MixPlan) => void
}

export interface SeparationOptions {
  engine?: 'uvr' | 'demucs' | 'basic'
  model?: string
  diarization?: boolean
  force?: boolean
}

export interface NewMixClipInput {
  startMs: number
  endMs?: number
  audioUrl?: string | null
  assetId?: number | null
  takeId?: number | null
  lineId?: number | null
  sourceStartMs?: number
  name?: string | null
  gainDb?: number
  pan?: number
  fadeInMs?: number
  fadeOutMs?: number
  fadeCurve?: string
  loop?: boolean
  muted?: boolean
  locked?: boolean
}

const HISTORY_LIMIT = 50
const SAVE_DEBOUNCE_MS = 300
const POLL_INTERVAL_MS = 1000
const MIN_CLIP_MS = 10

const ROLE_BUS: Record<string, MixBusKey> = {
  dialogue: 'dialogue',
  voice: 'dialogue',
  crowd: 'dialogue',
  original: 'original',
  ambience: 'original',
  sfx: 'sfx',
  bgm: 'bgm',
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clipEndOf(track: StageTrack): number {
  return track.clips.reduce((max, clip) => Math.max(max, clip.endMs), 0)
}

export function useMixStage(options: UseMixStageOptions) {
  const plan = ref<StagePlan | null>(null)
  const assets = ref<EpisodeAudioAsset[]>([])
  const revisions = ref<MixRevision[]>([])
  const separation = ref<SeparationStatus | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const dirty = ref(false)
  const error = ref('')
  const preview = ref<MixPreviewResult | null>(null)
  const previewing = ref(false)
  const rendering = ref(false)
  const selected = ref<MixSelection | null>(null)
  const playheadMs = ref(0)
  const zoom = ref(64)
  const snap = ref(true)
  const snapMs = ref(100)
  const history = ref<MixSnapshot[]>([])
  const future = ref<MixSnapshot[]>([])

  let uidSeq = 0
  let pendingSnapshot: MixSnapshot | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollToken = 0
  let loadToken = 0
  let loadedEpisode: number | null = null
  let inFlight: Promise<StagePlan> | null = null
  let serverTrackIds = new Set<number>()
  let serverClipIds = new Set<number>()

  const tracks = computed<StageTrack[]>(() => plan.value?.tracks ?? [])
  const buses = computed<MixBus[]>(() => plan.value?.buses ?? [])
  const durationMs = computed(() => Math.max(0, Math.round(plan.value?.durationMs ?? 0)))
  const canUndo = computed(() => history.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)
  const separationRunning = computed(() => separation.value?.status === 'running')

  const selectedTrack = computed<StageTrack | null>(() => {
    const key = selected.value
    if (!key) return null
    return tracks.value.find((track) => track._uid === key.trackUid) ?? null
  })
  const selectedClip = computed<StageClip | null>(() => {
    const key = selected.value
    const track = selectedTrack.value
    if (!key || !track) return null
    return track.clips.find((clip) => clip._uid === key.clipUid) ?? null
  })

  function newUid(prefix: string): string {
    uidSeq += 1
    return `${prefix}${Date.now().toString(36)}${uidSeq.toString(36)}`
  }

  function rememberServerIds(next: MixPlan) {
    serverTrackIds = new Set<number>()
    serverClipIds = new Set<number>()
    for (const track of next.tracks) {
      if (track.virtual) continue
      if (track.id != null) serverTrackIds.add(track.id)
      for (const clip of track.clips) {
        if (clip.id != null) serverClipIds.add(clip.id)
      }
    }
  }

  function recomputeEffective(target: StagePlan) {
    const soloActive = target.tracks.some((track) => track.solo)
      || target.buses.some((bus) => bus.key !== 'master' && bus.solo)
    for (const bus of target.buses) {
      bus.effectiveMuted = bus.key === 'master'
        ? bus.muted
        : bus.muted || (soloActive && !bus.solo)
    }
    for (const track of target.tracks) {
      const bus = target.buses.find((item) => item.key === track.busId)
      const soloed = track.solo || (track.busId !== 'master' && Boolean(bus?.solo))
      track.effectiveMuted = track.muted || Boolean(bus?.muted) || (soloActive && !soloed)
    }
    const clipEnd = target.tracks.reduce((max, track) => Math.max(max, clipEndOf(track)), 0)
    target.durationMs = Math.max(target.durationMs, clipEnd)
  }

  /** 复用旧对象的 _uid，保证保存/刷新后选中与撤销引用不漂移 */
  function decorate(next: MixPlan, previous: StagePlan | null): StagePlan {
    const prevTracks = previous?.tracks ?? []
    const usedTrackUids = new Set<string>()
    const matchTrack = (track: MixTrack): StageTrack | undefined => {
      if (track.id != null) {
        const byId = prevTracks.find((item) => item.id === track.id && !usedTrackUids.has(item._uid))
        if (byId) return byId
      }
      return prevTracks.find((item) => !usedTrackUids.has(item._uid)
        && item.virtual === track.virtual
        && item.role === track.role
        && item.name === track.name)
    }

    const decoratedTracks = next.tracks.map((track) => {
      const previousTrack = matchTrack(track)
      if (previousTrack) usedTrackUids.add(previousTrack._uid)
      const prevClips = previousTrack?.clips ?? []
      const usedClipUids = new Set<string>()
      const matchClip = (clip: MixClip): StageClip | undefined => {
        if (clip.id != null) {
          const byId = prevClips.find((item) => item.id === clip.id && !usedClipUids.has(item._uid))
          if (byId) return byId
        }
        if (clip.takeId != null) {
          const byTake = prevClips.find((item) => item.takeId === clip.takeId && !usedClipUids.has(item._uid))
          if (byTake) return byTake
        }
        if (clip.lineId != null) {
          const byLine = prevClips.find((item) => item.lineId === clip.lineId && !usedClipUids.has(item._uid))
          if (byLine) return byLine
        }
        return prevClips.find((item) => !usedClipUids.has(item._uid)
          && item.audioUrl === clip.audioUrl
          && item.startMs === clip.startMs)
      }
      const clips = track.clips.map((clip) => {
        const previousClip = matchClip(clip)
        if (previousClip) usedClipUids.add(previousClip._uid)
        return { ...clip, _uid: previousClip?._uid || newUid('c') }
      })
      return { ...track, _uid: previousTrack?._uid || newUid('t'), clips }
    })

    return { ...next, tracks: decoratedTracks }
  }

  function applyPlan(next: MixPlan, resetHistory = false) {
    rememberServerIds(next)
    const previous = loadedEpisode === next.episodeId ? plan.value : null
    loadedEpisode = next.episodeId
    plan.value = decorate(next, previous)
    recomputeEffective(plan.value)
    if (resetHistory) {
      history.value = []
      future.value = []
      pendingSnapshot = null
    }
    if (selected.value && (!selectedTrack.value || !selectedClip.value)) selected.value = null
  }

  function snapshot(): MixSnapshot {
    const tracks = plan.value?.tracks ?? []
    return {
      tracks: clone(tracks.filter((track) => !track.virtual)),
      buses: clone(plan.value?.buses ?? []),
      virtual: tracks.filter((track) => track.virtual).map((track) => ({
        role: track.role,
        volume: track.volume,
        pan: track.pan,
        muted: track.muted,
        solo: track.solo,
        loop: track.loop,
      })),
    }
  }

  function pushHistory(snap: MixSnapshot) {
    history.value = [...history.value, snap].slice(-HISTORY_LIMIT)
    future.value = []
  }

  function applySnapshot(snap: MixSnapshot) {
    if (!plan.value) return
    const virtual = plan.value.tracks.filter((track) => track.virtual)
    for (const saved of snap.virtual) {
      const track = virtual.find((item) => item.role === saved.role)
      if (!track) continue
      track.volume = saved.volume
      track.pan = saved.pan
      track.muted = saved.muted
      track.solo = saved.solo
      track.loop = saved.loop
    }
    plan.value = {
      ...plan.value,
      buses: clone(snap.buses),
      tracks: [...virtual, ...clone(snap.tracks)],
    }
    recomputeEffective(plan.value)
    if (selected.value && (!selectedTrack.value || !selectedClip.value)) selected.value = null
  }

  function beginChange() {
    if (!pendingSnapshot && plan.value) pendingSnapshot = snapshot()
  }

  function endChange() {
    if (!pendingSnapshot) return
    const before = pendingSnapshot
    pendingSnapshot = null
    if (JSON.stringify(before) !== JSON.stringify(snapshot())) {
      pushHistory(before)
      scheduleSave()
    }
  }

  function mutate(fn: () => void) {
    if (!plan.value) return
    if (pendingSnapshot) {
      fn()
      recomputeEffective(plan.value)
      return
    }
    const before = snapshot()
    fn()
    recomputeEffective(plan.value)
    if (JSON.stringify(before) !== JSON.stringify(snapshot())) {
      pushHistory(before)
      scheduleSave()
    }
  }

  function scheduleSave() {
    dirty.value = true
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void save().catch(() => {})
    }, SAVE_DEBOUNCE_MS)
  }

  function buildPayload() {
    const current = plan.value
    if (!current) return null
    return {
      buses: current.buses.map((bus) => ({
        id: bus.id,
        key: bus.key,
        volume: bus.volume,
        muted: bus.muted,
        solo: bus.solo,
        ducking: bus.ducking,
        duckRatio: bus.duckRatio,
        duckAttackMs: bus.duckAttackMs,
        duckReleaseMs: bus.duckReleaseMs,
        lufsTarget: bus.lufsTarget,
        limiterCeiling: bus.limiterCeiling,
      })),
      tracks: current.tracks
        .filter((track) => !track.virtual)
        .map((track, index) => ({
          id: track.id != null && serverTrackIds.has(track.id) ? track.id : null,
          role: track.role,
          name: track.name,
          busId: track.busId,
          volume: track.volume,
          pan: track.pan,
          muted: track.muted,
          solo: track.solo,
          ducking: track.ducking,
          locked: track.locked,
          hidden: track.hidden,
          loop: track.loop,
          color: track.color,
          height: track.height,
          sortOrder: track.sortOrder ?? index,
          stemAssetId: track.stemAssetId,
          clips: track.clips.map((clip) => ({
            id: clip.id != null && serverClipIds.has(clip.id) ? clip.id : null,
            assetId: clip.assetId,
            takeId: clip.takeId,
            lineId: clip.lineId,
            name: clip.name,
            startMs: Math.round(clip.startMs),
            endMs: Math.round(clip.endMs),
            sourceStartMs: Math.round(clip.sourceStartMs),
            gainDb: clip.gainDb,
            pan: clip.pan,
            fadeInMs: Math.round(clip.fadeInMs),
            fadeOutMs: Math.round(clip.fadeOutMs),
            fadeCurve: clip.fadeCurve,
            loop: clip.loop,
            muted: clip.muted,
            locked: clip.locked,
            audioUrl: clip.audioUrl,
          })),
        })),
      virtualTracks: current.tracks
        .filter((track) => track.virtual)
        .map((track) => ({
          role: track.role,
          volume: track.volume,
          pan: track.pan,
          muted: track.muted,
          solo: track.solo,
          loop: track.loop,
        })),
    }
  }

  async function save(): Promise<StagePlan | null> {
    const episodeId = options.episodeId()
    if (!episodeId || !plan.value) return null
    if (inFlight) {
      await inFlight.catch(() => {})
      if (!dirty.value) return plan.value
    }
    const payload = buildPayload()
    if (!payload) return null
    dirty.value = false
    saving.value = true
    error.value = ''
    const selectedBefore = selected.value ? { ...selected.value } : null
    const task = (async () => {
      const next = await mixAPI.savePlan(episodeId, payload)
      applyPlan(next)
      if (selectedBefore) {
        selected.value = selectedBefore
        if (!selectedTrack.value || !selectedClip.value) selected.value = null
      }
      options.onSaved?.(next)
      return plan.value!
    })()
    inFlight = task.finally(() => {
      saving.value = false
      inFlight = null
      if (dirty.value) scheduleSave()
    })
    try {
      return await inFlight
    } catch (err: any) {
      dirty.value = true
      error.value = err?.message || '保存混音失败'
      throw err
    }
  }

  async function flushSave(): Promise<StagePlan | null> {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (inFlight) {
      await inFlight.catch(() => {})
    }
    if (dirty.value) return save()
    return plan.value
  }

  async function loadAssets() {
    const episodeId = options.episodeId()
    if (!episodeId) return []
    try {
      const result = await mixAPI.assets(episodeId)
      assets.value = result.items
      return assets.value
    } catch (err: any) {
      error.value = err?.message || '读取音频素材失败'
      return assets.value
    }
  }

  async function load(resetHistory = true) {
    const episodeId = options.episodeId()
    if (!episodeId) return
    const token = ++loadToken
    loading.value = true
    error.value = ''
    try {
      const [next, assetResult, revisionResult, status] = await Promise.all([
        mixAPI.getPlan(episodeId),
        mixAPI.assets(episodeId),
        mixAPI.revisions(episodeId),
        mixAPI.separationStatus(episodeId),
      ])
      if (token !== loadToken) return
      applyPlan(next, resetHistory)
      assets.value = assetResult.items
      revisions.value = revisionResult.items
      separation.value = status
      dirty.value = false
      playheadMs.value = 0
      if (status.status === 'running') startPolling()
    } catch (err: any) {
      if (token !== loadToken) return
      error.value = err?.message || '读取混音计划失败'
    } finally {
      if (token === loadToken) loading.value = false
    }
  }

  function stopPolling() {
    pollToken += 1
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  function startPolling() {
    stopPolling()
    const token = pollToken
    const tick = async () => {
      const episodeId = options.episodeId()
      if (!episodeId || token !== pollToken) return
      try {
        const status = await mixAPI.separationStatus(episodeId)
        if (token !== pollToken) return
        separation.value = status
        if (status.status === 'running') {
          pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
          return
        }
        pollTimer = null
        if (status.status === 'done') {
          await loadAssets()
          await load()
        }
      } catch (err: any) {
        if (token !== pollToken) return
        error.value = err?.message || '读取分离状态失败'
        pollTimer = null
      }
    }
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
  }

  async function runSeparation(config: SeparationOptions = {}) {
    const episodeId = options.episodeId()
    if (!episodeId) throw new Error('未选择剧集')
    error.value = ''
    try {
      const started = await mixAPI.separate(episodeId, {
        engine: config.engine,
        model: config.model,
        diarization: config.diarization,
        force: config.force,
      })
      if (started.status === 'done') {
        await loadAssets()
        await load()
        return started
      }
      separation.value = {
        jobId: started.jobId,
        status: 'running',
        progress: 0,
        step: '准备分离',
        error: null,
        engine: config.engine ?? null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      }
      startPolling()
      return started
    } catch (err: any) {
      error.value = err?.message || '创建分离任务失败'
      throw err
    }
  }

  async function cancelSeparation() {
    const episodeId = options.episodeId()
    if (!episodeId) return false
    const result = await mixAPI.cancelSeparation(episodeId)
    stopPolling()
    separation.value = await mixAPI.separationStatus(episodeId)
    return result.cancelled
  }

  function clearSelection() {
    selected.value = null
  }

  function selectClip(track: StageTrack, clip: StageClip) {
    selected.value = { trackUid: track._uid, clipUid: clip._uid }
  }

  function trackOfClip(clip: StageClip): StageTrack | null {
    return tracks.value.find((track) => track.clips.some((item) => item._uid === clip._uid)) ?? null
  }

  function sortClips(track: StageTrack) {
    track.clips.sort((a, b) => a.startMs - b.startMs || a._uid.localeCompare(b._uid))
  }

  function addTrack(input: Partial<MixTrack> & { role?: string; name?: string; busId?: MixBusKey } = {}): StageTrack | null {
    if (!plan.value) return null
    const role = input.role || 'ambience'
    const maxOrder = plan.value.tracks.reduce((max, track) => Math.max(max, track.sortOrder || 0), 0)
    const track: StageTrack = {
      id: null,
      role,
      name: input.name || role,
      busId: input.busId || ROLE_BUS[role] || 'sfx',
      virtual: false,
      volume: input.volume ?? 1,
      pan: input.pan ?? 0,
      muted: input.muted ?? false,
      solo: input.solo ?? false,
      effectiveMuted: false,
      ducking: input.ducking ?? role !== 'voice',
      locked: input.locked ?? false,
      hidden: input.hidden ?? false,
      loop: input.loop ?? false,
      color: input.color ?? '#38bdf8',
      height: input.height ?? 72,
      sortOrder: input.sortOrder ?? maxOrder + 1,
      stemAssetId: input.stemAssetId ?? null,
      clips: [],
      _uid: newUid('t'),
    }
    mutate(() => plan.value!.tracks.push(track))
    return track
  }

  function updateTrack(track: StageTrack, patch: Partial<Omit<MixTrack, 'clips' | 'id' | 'virtual'>>) {
    mutate(() => Object.assign(track, patch))
  }

  function removeTrack(track: StageTrack) {
    if (track.virtual) return
    if (selected.value?.trackUid === track._uid) selected.value = null
    mutate(() => {
      plan.value!.tracks = plan.value!.tracks.filter((item) => item._uid !== track._uid)
    })
  }

  function updateBus(bus: MixBus, patch: Partial<Omit<MixBus, 'id' | 'key' | 'effectiveMuted'>>) {
    mutate(() => Object.assign(bus, patch))
  }

  function createClip(track: StageTrack, input: NewMixClipInput): StageClip | null {
    if (!plan.value) return null
    const startMs = Math.max(0, Math.round(input.startMs))
    const endMs = Math.max(startMs + MIN_CLIP_MS, Math.round(input.endMs ?? startMs + 1000))
    const audioUrl = input.audioUrl ?? null
    const clip: StageClip = {
      id: null,
      assetId: input.assetId ?? null,
      takeId: input.takeId ?? null,
      lineId: input.lineId ?? null,
      name: input.name ?? null,
      startMs,
      endMs,
      sourceStartMs: Math.max(0, Math.round(input.sourceStartMs ?? 0)),
      gainDb: input.gainDb ?? 0,
      pan: input.pan ?? 0,
      fadeInMs: Math.max(0, Math.round(input.fadeInMs ?? 0)),
      fadeOutMs: Math.max(0, Math.round(input.fadeOutMs ?? 0)),
      fadeCurve: input.fadeCurve || 'linear',
      loop: Boolean(input.loop),
      muted: Boolean(input.muted),
      locked: Boolean(input.locked),
      audioUrl,
      usable: Boolean(audioUrl),
      reason: audioUrl ? null : '缺少音频素材',
      _uid: newUid('c'),
    }
    mutate(() => {
      track.clips.push(clip)
      sortClips(track)
    })
    return clip
  }

  function updateClip(clip: StageClip, patch: Partial<MixClip>) {
    const track = trackOfClip(clip)
    if (track?.locked) return
    if (clip.locked && patch.locked !== false) return
    mutate(() => {
      if (patch.startMs !== undefined || patch.endMs !== undefined) {
        const start = Math.max(0, Math.round(patch.startMs ?? clip.startMs))
        const end = Math.max(start + MIN_CLIP_MS, Math.round(patch.endMs ?? clip.endMs))
        clip.startMs = start
        clip.endMs = end
      }
      if (patch.sourceStartMs !== undefined) clip.sourceStartMs = Math.max(0, Math.round(patch.sourceStartMs))
      if (patch.gainDb !== undefined) clip.gainDb = clamp(Number(patch.gainDb), -60, 12)
      if (patch.pan !== undefined) clip.pan = clamp(Number(patch.pan), -1, 1)
      if (patch.fadeInMs !== undefined) clip.fadeInMs = Math.max(0, Math.round(Number(patch.fadeInMs)))
      if (patch.fadeOutMs !== undefined) clip.fadeOutMs = Math.max(0, Math.round(Number(patch.fadeOutMs)))
      if (patch.fadeCurve !== undefined) clip.fadeCurve = patch.fadeCurve === 'equal_power' ? 'equal_power' : 'linear'
      if (patch.name !== undefined) clip.name = patch.name
      if (patch.loop !== undefined) clip.loop = Boolean(patch.loop)
      if (patch.muted !== undefined) clip.muted = Boolean(patch.muted)
      if (patch.locked !== undefined) clip.locked = Boolean(patch.locked)
      if (patch.audioUrl !== undefined) {
        clip.audioUrl = patch.audioUrl
        clip.usable = Boolean(patch.audioUrl)
        clip.reason = patch.audioUrl ? null : '缺少音频素材'
      }
      sortClips(track!)
    })
  }

  function removeClip(clip: StageClip) {
    const track = trackOfClip(clip)
    if (!track || track.locked || clip.locked) return
    if (selected.value?.clipUid === clip._uid) selected.value = null
    mutate(() => {
      track.clips = track.clips.filter((item) => item._uid !== clip._uid)
    })
  }

  function splitClip(clip: StageClip, atMs: number): StageClip | null {
    const track = trackOfClip(clip)
    if (!track || track.locked || clip.locked) return null
    const at = Math.round(atMs)
    if (at <= clip.startMs + MIN_CLIP_MS || at >= clip.endMs - MIN_CLIP_MS) return null
    const second: StageClip = {
      ...clone(clip),
      id: null,
      startMs: at,
      endMs: clip.endMs,
      sourceStartMs: clip.sourceStartMs + (at - clip.startMs),
      _uid: newUid('c'),
    }
    mutate(() => {
      clip.endMs = at
      track.clips.push(second)
      sortClips(track)
    })
    return second
  }

  function duplicateClip(clip: StageClip): StageClip | null {
    const track = trackOfClip(clip)
    if (!track) return null
    const duration = clip.endMs - clip.startMs
    const copy: StageClip = {
      ...clone(clip),
      id: null,
      startMs: clip.endMs,
      endMs: clip.endMs + duration,
      _uid: newUid('c'),
    }
    mutate(() => {
      track.clips.push(copy)
      sortClips(track)
    })
    return copy
  }

  function moveClip(clip: StageClip, startMs: number) {
    const track = trackOfClip(clip)
    if (!track || track.locked || clip.locked) return
    const duration = clip.endMs - clip.startMs
    const start = Math.max(0, Math.round(startMs))
    mutate(() => {
      clip.startMs = start
      clip.endMs = start + duration
      sortClips(track)
    })
  }

  function trimClip(clip: StageClip, edge: 'start' | 'end', timeMs: number) {
    const track = trackOfClip(clip)
    if (!track || track.locked || clip.locked) return
    mutate(() => {
      if (edge === 'start') {
        const next = clamp(Math.round(timeMs), 0, clip.endMs - MIN_CLIP_MS)
        const delta = next - clip.startMs
        clip.startMs = next
        clip.sourceStartMs = Math.max(0, clip.sourceStartMs + delta)
      } else {
        clip.endMs = Math.max(clip.startMs + MIN_CLIP_MS, Math.round(timeMs))
      }
    })
  }

  function snapTime(valueMs: number, candidates: number[] = []): number {
    const raw = Math.max(0, Math.round(valueMs))
    if (!snap.value) return raw
    const targets = [0, playheadMs.value, ...candidates]
    for (const track of tracks.value) {
      for (const clip of track.clips) targets.push(clip.startMs, clip.endMs)
    }
    let best = raw
    let bestDistance = snapMs.value
    for (const target of targets) {
      const distance = Math.abs(target - raw)
      if (distance <= bestDistance) {
        best = target
        bestDistance = distance
      }
    }
    return Math.max(0, Math.round(best))
  }

  function setPlayhead(ms: number, maxMs = durationMs.value) {
    playheadMs.value = clamp(Math.round(ms), 0, Math.max(maxMs, 0))
  }

  function setZoom(value: number) {
    zoom.value = clamp(Number(value) || 64, 8, 240)
  }

  function undo() {
    if (!plan.value || !history.value.length) return
    const snap = history.value[history.value.length - 1]
    history.value = history.value.slice(0, -1)
    future.value = [clone(snapshot()), ...future.value].slice(0, HISTORY_LIMIT)
    applySnapshot(snap)
    scheduleSave()
  }

  function redo() {
    if (!plan.value || !future.value.length) return
    const snap = future.value[0]
    future.value = future.value.slice(1)
    history.value = [...history.value, clone(snapshot())].slice(-HISTORY_LIMIT)
    applySnapshot(snap)
    scheduleSave()
  }

  async function previewRange(startMs: number, endMs: number): Promise<MixPreviewResult | null> {
    const episodeId = options.episodeId()
    if (!episodeId) throw new Error('未选择剧集')
    await flushSave()
    previewing.value = true
    error.value = ''
    try {
      const result = await mixAPI.preview(episodeId, {
        start_ms: Math.max(0, Math.round(startMs)),
        end_ms: Math.max(0, Math.round(endMs)),
      })
      preview.value = result
      return result
    } catch (err: any) {
      error.value = err?.message || '生成试听失败'
      throw err
    } finally {
      previewing.value = false
    }
  }

  async function saveRevision(note?: string): Promise<MixRevision | null> {
    const episodeId = options.episodeId()
    if (!episodeId) throw new Error('未选择剧集')
    await flushSave()
    const revision = await mixAPI.saveRevision(episodeId, note)
    revisions.value = [revision, ...revisions.filter((item) => item.id !== revision.id)]
    return revision
  }

  async function restoreRevision(revisionId: number) {
    const episodeId = options.episodeId()
    if (!episodeId) throw new Error('未选择剧集')
    const result = await mixAPI.restoreRevision(episodeId, revisionId)
    applyPlan(result.plan, true)
    dirty.value = false
    revisions.value = (await mixAPI.revisions(episodeId)).items
    return result
  }

  async function renderMix(format: 'wav' | 'm4a' = 'm4a'): Promise<MixRenderResult | null> {
    const episodeId = options.episodeId()
    if (!episodeId) throw new Error('未选择剧集')
    await flushSave()
    rendering.value = true
    error.value = ''
    try {
      return await mixAPI.render(episodeId, { format })
    } catch (err: any) {
      error.value = err?.message || '混音导出失败'
      throw err
    } finally {
      rendering.value = false
    }
  }

  async function removeAsset(assetId: number) {
    const episodeId = options.episodeId()
    if (!episodeId) return false
    const result = await mixAPI.removeAsset(episodeId, assetId)
    await loadAssets()
    await load()
    return result.deleted
  }

  function dispose() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    stopPolling()
  }

  return {
    plan,
    tracks,
    buses,
    assets,
    revisions,
    separation,
    separationRunning,
    loading,
    saving,
    dirty,
    error,
    preview,
    previewing,
    rendering,
    selectedClip,
    selectedTrack,
    playheadMs,
    zoom,
    snap,
    snapMs,
    canUndo,
    canRedo,
    durationMs,
    load,
    loadAssets,
    save,
    flushSave,
    beginChange,
    endChange,
    addTrack,
    updateTrack,
    removeTrack,
    updateBus,
    createClip,
    updateClip,
    removeClip,
    splitClip,
    duplicateClip,
    moveClip,
    trimClip,
    snapTime,
    selectClip,
    clearSelection,
    setPlayhead,
    setZoom,
    undo,
    redo,
    runSeparation,
    cancelSeparation,
    previewRange,
    saveRevision,
    restoreRevision,
    renderMix,
    removeAsset,
    dispose,
  }
}
