/**
 * 剪辑预览播放时钟（设计 §6.9）
 *
 * mode='mix'（服务端 state.audio.mode==='mix'，混音成片音轨可用）时音频走 WebAudio：
 * - start(ms)：AudioBufferSourceNode 从 ms 起播，startCtxTime = ctx.currentTime - ms/1000
 * - audioMs()：playing 时按 AudioContext 时间推算播放位置，否则返回 lastSeekMs
 * - syncVideo(videoEl, timelineToSourceMs)：每帧对齐视频，漂移超过 EDIT_DRIFT_MS 才 seek，
 *   避免频繁跳帧（视频画面仍按片段切源播放，音频是主时钟）
 *
 * 与混音工作台 useMixPlayback 的 320ms 容差不同：剪辑页画面按片段切源，
 * 用更紧的 120ms 容差限制跳帧幅度；两者刻意不共享播放器实现。
 * 混音音轨先于时间线结束时 running 变为 false，宿主回退到视频即时钟（视频静音继续，可接受近似）。
 */
import { getCurrentScope, onScopeDispose, ref, toValue, watch } from 'vue'

export const EDIT_DRIFT_MS = 120

export type EditClockMode = 'mix' | 'video' | 'none'

interface EditClockOptions {
  audioUrl: () => string
  playing: () => boolean
}

export function useEditClock(options: EditClockOptions) {
  /** 当前时钟：mix=WebAudio 音频主时钟 / video=视频原生时钟回退 / none=尚未启动 */
  const mode = ref<EditClockMode>('none')
  /** 视频与音频的毫秒级漂移（每帧由 syncVideo 更新） */
  const drift = ref(0)
  /** 音源节点是否仍在出声（音频播完/停止后为 false，宿主据此回退视频时钟） */
  const running = ref(false)

  let audioContext: AudioContext | null = null
  let buffer: AudioBuffer | null = null
  let bufferUrl = ''
  let sourceNode: AudioBufferSourceNode | null = null
  let startCtxTime = 0
  let lastSeekMs = 0
  let loadSeq = 0

  function ensureContext(): AudioContext | null {
    if (audioContext) return audioContext
    if (typeof window === 'undefined') return null
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    audioContext = new Ctor()
    return audioContext
  }

  /** 卸载时释放 WebAudio 资源；close 幂等，之后 start() 会按需重建 */
  function dispose() {
    stopSource()
    if (audioContext) {
      void audioContext.close().catch(() => { /* 已关闭的上下文忽略 */ })
      audioContext = null
    }
    buffer = null
    bufferUrl = ''
    running.value = false
  }

  if (getCurrentScope()) onScopeDispose(dispose)

  /** audioUrl 变化时 fetch + decodeAudioData，按 URL 缓存 AudioBuffer */
  async function loadBuffer(url: string): Promise<AudioBuffer | null> {
    if (buffer && bufferUrl === url) return buffer
    const ctx = ensureContext()
    if (!ctx) return null
    const seq = ++loadSeq
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.arrayBuffer()
      const decoded = await ctx.decodeAudioData(data)
      if (seq !== loadSeq) return null
      buffer = decoded
      bufferUrl = url
      return buffer
    } catch {
      // 解码失败：mode 回退 video，由视频原生时钟继续（静音或源原声）
      return null
    }
  }

  function stopSource() {
    running.value = false
    if (!sourceNode) return
    try { sourceNode.stop() } catch { /* 尚未起播的源无需停止 */ }
    sourceNode.disconnect()
    sourceNode = null
  }

  function audioMs(): number {
    if (running.value && audioContext && sourceNode) {
      return Math.max(0, (audioContext.currentTime - startCtxTime) * 1000)
    }
    return lastSeekMs
  }

  async function start(ms: number): Promise<boolean> {
    const url = String(toValue(options.audioUrl) || '').trim()
    stopSource()
    if (!url) {
      mode.value = 'none'
      return false
    }
    const fromMs = Math.max(0, Math.round(ms))
    lastSeekMs = fromMs
    const loaded = await loadBuffer(url)
    const ctx = ensureContext()
    if (!loaded || !loaded.duration || !ctx) {
      mode.value = 'video'
      return false
    }
    await ctx.resume().catch(() => {})
    // await 期间 audioUrl 可能又变了，防止旧音源串音
    if (String(toValue(options.audioUrl) || '').trim() !== url) return false
    stopSource()
    const offset = Math.min(fromMs / 1000, loaded.duration)
    const node = ctx.createBufferSource()
    node.buffer = loaded
    node.connect(ctx.destination)
    node.onended = () => {
      running.value = false
      if (sourceNode === node) sourceNode = null
    }
    try {
      node.start(0, offset)
    } catch {
      node.disconnect()
      mode.value = 'video'
      return false
    }
    sourceNode = node
    startCtxTime = ctx.currentTime - offset
    running.value = true
    mode.value = 'mix'
    return true
  }

  function stop() {
    // 先按 AudioContext 时间记住暂停点，stop 后 audioMs() 回落到 lastSeekMs
    if (running.value && audioContext && sourceNode) {
      lastSeekMs = Math.max(0, (audioContext.currentTime - startCtxTime) * 1000)
    }
    stopSource()
    drift.value = 0
  }

  function seek(ms: number) {
    const target = Math.max(0, Math.round(ms))
    lastSeekMs = target
    // 播放中重定位：旧源停止，立即从新位置重建；停止态只记录，下次 start 从该处起播
    if (toValue(options.playing) && mode.value === 'mix') void start(target)
  }

  /** 每帧调用：视频漂移超过 EDIT_DRIFT_MS 才 seek 到音频位置对应的源时间 */
  function syncVideo(
    videoEl: HTMLVideoElement | null,
    timelineToSourceMs: (timelineMs: number) => number,
  ) {
    if (!videoEl) return
    if (mode.value !== 'mix' || !running.value) {
      drift.value = 0
      return
    }
    const timelineMs = audioMs()
    const expectedSourceMs = timelineToSourceMs(timelineMs)
    const videoMs = videoEl.currentTime * 1000
    drift.value = videoMs - expectedSourceMs
    if (Math.abs(drift.value) > EDIT_DRIFT_MS) {
      try {
        videoEl.currentTime = Math.max(0, expectedSourceMs) / 1000
      } catch {
        // 元数据未就绪时由 loadedmetadata 再同步
      }
    }
  }

  // audioUrl 变化（混合模式切换）：必须先停旧时钟再重建缓存
  watch(() => toValue(options.audioUrl), () => {
    loadSeq += 1
    stopSource()
    buffer = null
    bufferUrl = ''
    mode.value = 'none'
    drift.value = 0
    lastSeekMs = 0
  })

  return { mode, drift, running, audioMs, start, stop, seek, syncVideo }
}
