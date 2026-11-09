/**
 * 实时多轨监听引擎（WebAudio）
 *
 * 时间线播放不该每次都等 FFmpeg 渲染：这里按当前 MixPlan 现场调度片段，
 * - 轨道：音量 / 声像 / effectiveMuted（已含 solo 派生）
 * - 片段：增益 / 声像 / 淡入淡出 / 循环（与后端渲染器语义对齐）
 * - 总线与主输出：音量 / 静音
 * - 视频为主时钟：宿主在 timeupdate 里调用 sync() 纠偏；无视频时宿主用 positionMs() 推进播放头
 *
 * 渲染终检仍是最终校验：实时监听不做侧链闪避、响度归一与限制器；声像使用
 * WebAudio 等功率声像，与 FFmpeg 的线性逐声道声像在声像位置和响度上存在差异。
 */
import { ref } from 'vue'
import type { MixBus } from '~/composables/useApi'
import type { StageClip, StageTrack } from '~/composables/useMixStage'

export interface MixPlaybackOptions {
  tracks: () => StageTrack[]
  buses: () => MixBus[]
}

interface TrackNodes {
  gain: GainNode
  pan: StereoPannerNode
}

interface ClipNodes {
  source: AudioBufferSourceNode
  gain: GainNode
  pan: StereoPannerNode | null
}

interface ScheduledClip {
  track: StageTrack
  clip: StageClip
  segmentStart: number
  segmentEnd: number
}

const DRIFT_TOLERANCE_MS = 320
const START_DELAY_SEC = 0.04

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0
  return 10 ** (db / 20)
}

/** MixPlan 里存逻辑路径（static/projects/...），播放前解析成同源 URL */
export function resolveMediaUrl(raw: string): string {
  const url = String(raw || '').trim()
  if (!url) return ''
  if (/^(https?:|blob:|data:|\/)/i.test(url)) return url
  return `/${url}`
}

function fadeCurve(base: number, direction: 'in' | 'out', points = 32): Float32Array {
  const values = new Float32Array(points)
  for (let index = 0; index < points; index += 1) {
    const t = index / (points - 1)
    values[index] = base * (direction === 'in' ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2))
  }
  return values
}

export function useMixPlayback(options: MixPlaybackOptions) {
  const playing = ref(false)
  const loading = ref(false)
  const missing = ref<string[]>([])
  /** 上下文被浏览器挂起（未获得用户手势）时为 true，供宿主提示「点击播放启用声音」 */
  const suspended = ref(false)

  let ctx: AudioContext | null = null
  let masterGain: GainNode | null = null
  let busGains = new Map<string, GainNode>()
  let trackNodes = new Map<string, TrackNodes>()
  let clipNodes: ClipNodes[] = []
  let buffers = new Map<string, AudioBuffer>()
  let inflight = new Map<string, Promise<AudioBuffer | null>>()
  let cacheEpoch = 0
  let generation = 0
  let startMs = 0
  let startedAt = 0

  function ensureContext(): AudioContext | null {
    if (ctx) return ctx
    if (typeof window === 'undefined') return null
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
    suspended.value = ctx.state === 'suspended'
    ctx.onstatechange = () => { suspended.value = ctx?.state === 'suspended' }
    return ctx
  }

  function setParam(param: AudioParam, value: number, smooth: boolean) {
    if (!ctx) return
    if (smooth) param.setTargetAtTime(value, ctx.currentTime, 0.015)
    else param.value = value
  }

  function applyMixState(immediate = false) {
    if (!ctx || !masterGain) return
    const buses = options.buses()
    const master = buses.find((bus) => bus.key === 'master')
    setParam(masterGain.gain, master?.effectiveMuted ? 0 : (master?.volume ?? 1), !immediate)
    for (const bus of buses) {
      if (bus.key === 'master') continue
      const node = busGains.get(bus.key)
      if (node) setParam(node.gain, bus.effectiveMuted ? 0 : bus.volume, !immediate)
    }
    for (const track of options.tracks()) {
      const nodes = trackNodes.get(track._uid)
      if (!nodes) continue
      setParam(nodes.gain.gain, track.effectiveMuted ? 0 : clamp(track.volume, 0, 2), !immediate)
      setParam(nodes.pan.pan, clamp(track.pan, -1, 1), !immediate)
    }
  }

  function rebuildGraph(audio: AudioContext) {
    for (const nodes of trackNodes.values()) {
      nodes.gain.disconnect()
      nodes.pan.disconnect()
    }
    trackNodes = new Map()
    for (const gain of busGains.values()) gain.disconnect()
    busGains = new Map()
    masterGain?.disconnect()
    masterGain = audio.createGain()
    masterGain.connect(audio.destination)

    const buses = options.buses()
    for (const bus of buses) {
      if (bus.key === 'master') continue
      const gain = audio.createGain()
      gain.connect(masterGain)
      busGains.set(bus.key, gain)
    }
    for (const track of options.tracks()) {
      const gain = audio.createGain()
      const pan = audio.createStereoPanner()
      gain.connect(pan)
      pan.connect(busGains.get(track.busId) ?? masterGain)
      trackNodes.set(track._uid, { gain, pan })
    }
    applyMixState(true)
  }

  function collectSegments(fromMs: number): ScheduledClip[] {
    const list: ScheduledClip[] = []
    for (const track of options.tracks()) {
      for (const clip of track.clips) {
        if (!clip.usable || !clip.audioUrl || clip.muted) continue
        if (clip.endMs <= fromMs) continue
        const segmentStart = Math.max(clip.startMs, fromMs)
        if (clip.endMs - segmentStart < 10) continue
        list.push({ track, clip, segmentStart, segmentEnd: clip.endMs })
      }
    }
    return list
  }

  function loadBuffer(url: string, failed: Set<string>, epoch: number): Promise<AudioBuffer | null> {
    const cached = buffers.get(url)
    if (cached) return Promise.resolve(cached)
    const pending = inflight.get(url)
    if (pending) return pending
    let task: Promise<AudioBuffer | null>
    task = (async () => {
      try {
        if (!ctx) return null
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.arrayBuffer()
        const buffer = await ctx.decodeAudioData(data)
        if (epoch !== cacheEpoch) return null
        buffers.set(url, buffer)
        return buffer
      } catch {
        if (epoch === cacheEpoch) failed.add(url)
        return null
      } finally {
        if (inflight.get(url) === task) inflight.delete(url)
      }
    })()
    inflight.set(url, task)
    return task
  }

  function scheduleClipGain(
    param: AudioParam,
    base: number,
    when: number,
    duration: number,
    fadeIn: number,
    fadeOut: number,
    curve: string,
  ) {
    const end = when + duration
    const useCurve = curve === 'equal_power' && fadeIn + fadeOut < duration
    if (fadeIn <= 0) {
      param.setValueAtTime(base, when)
    } else if (useCurve) {
      param.setValueCurveAtTime(fadeCurve(base, 'in'), when, fadeIn)
    } else {
      param.setValueAtTime(0, when)
      param.linearRampToValueAtTime(base, when + fadeIn)
    }
    if (fadeOut <= 0) return
    const outStart = end - fadeOut
    if (useCurve) {
      param.setValueCurveAtTime(fadeCurve(base, 'out'), outStart, fadeOut)
      return
    }
    param.setValueAtTime(base, outStart)
    param.linearRampToValueAtTime(0, end)
  }

  function scheduleSegments(audio: AudioContext, segments: ScheduledClip[], bufferMap: Map<string, AudioBuffer>, baseCtxTime: number, fromMs: number) {
    for (const item of segments) {
      const { track, clip, segmentStart, segmentEnd } = item
      const trackNode = trackNodes.get(track._uid)
      if (!trackNode) continue
      const url = resolveMediaUrl(clip.audioUrl || '')
      const buffer = bufferMap.get(url)
      if (!buffer || !buffer.duration) continue

      const loop = Boolean(clip.loop || track.loop)
      let offset = (clip.sourceStartMs + (segmentStart - clip.startMs)) / 1000
      if (loop) offset %= buffer.duration
      else if (offset >= buffer.duration) continue

      const when = baseCtxTime + Math.max(0, (segmentStart - fromMs) / 1000)
      const duration = (segmentEnd - segmentStart) / 1000
      if (duration <= 0) continue

      const fadeInMs = segmentStart === clip.startMs ? Math.min(clip.fadeInMs, duration * 1000) : 0
      const fadeOutMs = Math.min(clip.fadeOutMs, duration * 1000)

      const source = audio.createBufferSource()
      source.buffer = buffer
      if (loop) {
        source.loop = true
        source.loopStart = 0
        source.loopEnd = buffer.duration
      }
      const gain = audio.createGain()
      scheduleClipGain(
        gain.gain,
        dbToGain(clip.gainDb),
        when,
        duration,
        Math.max(0, fadeInMs) / 1000,
        Math.max(0, fadeOutMs) / 1000,
        clip.fadeCurve,
      )
      source.connect(gain)
      let pan: StereoPannerNode | null = null
      if (clip.pan) {
        pan = audio.createStereoPanner()
        pan.pan.value = clamp(clip.pan, -1, 1)
        gain.connect(pan)
        pan.connect(trackNode.gain)
      } else {
        gain.connect(trackNode.gain)
      }

      try {
        source.start(when, offset, duration)
      } catch {
        source.disconnect()
        gain.disconnect()
        pan?.disconnect()
        continue
      }
      clipNodes.push({ source, gain, pan })
      source.onended = () => {
        source.disconnect()
        gain.disconnect()
        pan?.disconnect()
      }
    }
  }

  function stopSources() {
    for (const nodes of clipNodes) {
      try { nodes.source.stop() } catch { /* 尚未开始的源无需停止 */ }
      nodes.source.disconnect()
      nodes.gain.disconnect()
      nodes.pan?.disconnect()
    }
    clipNodes = []
  }

  function positionMs(): number {
    if (!playing.value || !ctx || loading.value) return startMs
    return startMs + Math.max(0, ctx.currentTime - startedAt) * 1000
  }

  async function play(fromMs: number): Promise<boolean> {
    const audio = ensureContext()
    if (!audio) return false
    await audio.resume().catch(() => {})
    suspended.value = audio.state === 'suspended'
    const gen = ++generation
    loading.value = false
    stopSources()
    const from = Math.max(0, Math.round(fromMs))
    startMs = from
    const segments = collectSegments(from)
    if (!segments.length) {
      playing.value = false
      missing.value = []
      return false
    }
    rebuildGraph(audio)
    loading.value = true
    const failed = new Set<string>()
    const epoch = cacheEpoch
    const urls = [...new Set(segments.map((item) => resolveMediaUrl(item.clip.audioUrl || '')))]
    const loaded = await Promise.all(urls.map(async (url) => [url, await loadBuffer(url, failed, epoch)] as const))
    if (gen !== generation) return false
    loading.value = false
    missing.value = [...failed]
    const bufferMap = new Map(loaded.filter((entry): entry is readonly [string, AudioBuffer] => Boolean(entry[1])))
    if (!bufferMap.size) {
      playing.value = false
      return false
    }
    startMs = from
    startedAt = audio.currentTime + START_DELAY_SEC
    scheduleSegments(audio, segments, bufferMap, startedAt, from)
    playing.value = true
    return true
  }

  function pause() {
    const at = positionMs()
    generation += 1
    stopSources()
    playing.value = false
    loading.value = false
    startMs = at
  }

  /** 用户手势内解锁音频上下文（iOS 首次播放必须） */
  function unlock() {
    const audio = ensureContext()
    if (!audio) return
    void audio.resume().catch(() => {}).finally(() => { suspended.value = audio.state === 'suspended' })
  }

  function seek(ms: number) {
    const target = Math.max(0, Math.round(ms))
    if (!playing.value) {
      startMs = target
      return
    }
    void play(target)
  }

  function sync(ms: number) {
    if (!playing.value || loading.value) return
    if (Math.abs(positionMs() - ms) > DRIFT_TOLERANCE_MS) void play(ms)
  }

  function reset() {
    pause()
    cacheEpoch += 1
    buffers.clear()
    inflight.clear()
    missing.value = []
  }

  function dispose() {
    pause()
    suspended.value = false
    masterGain?.disconnect()
    masterGain = null
    for (const gain of busGains.values()) gain.disconnect()
    busGains.clear()
    for (const nodes of trackNodes.values()) {
      nodes.gain.disconnect()
      nodes.pan.disconnect()
    }
    trackNodes.clear()
    buffers.clear()
    inflight.clear()
    const audio = ctx
    ctx = null
    void audio?.close().catch(() => {})
  }

  return {
    playing,
    loading,
    missing,
    suspended,
    play,
    pause,
    seek,
    sync,
    applyMixState,
    positionMs,
    reset,
    unlock,
    dispose,
  }
}
