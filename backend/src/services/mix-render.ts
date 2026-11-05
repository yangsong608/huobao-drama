/**
 * MixPlan 渲染（V3 · 设计 8.6–8.8）
 *
 * - 试听与导出共用同一份 MixPlan 与同一套滤镜顺序：
 *   片段裁剪 → 增益 → 声像 → 淡入淡出 → 轨道 → 总线 → 侧链 → loudnorm → 限制器；
 * - 对白总线作为 sidechain key 压低原声/BGM 总线；
 * - 相同素材只作为一路输入，滤镜图标签稳定，便于测试与排查。
 */
import fs from 'fs'
import path from 'path'
import { ffmpeg } from '../utils/ffmpeg.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { getAbsolutePath } from '../utils/storage.js'
import { probeDurationMs } from './audio-mix.js'
import type { MixBus, MixBusKey, MixClip, MixPlan, MixTrack } from './mix-plan.js'

const SR = 48000
const AFMT = `aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo`

export class MixRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MixRenderError'
  }
}

export interface MixRenderRange {
  startMs?: number
  endMs?: number
}

export interface MixRenderOptions extends MixRenderRange {
  outputPath: string
  format: 'm4a' | 'wav'
  codec?: 'pcm_s16le' | 'pcm_s24le' | 'aac'
  bitrateKbps?: number
  onlyBus?: MixBusKey
  onProgress?: (percent: number) => void
  signal?: AbortSignal
}

export interface MixFilterGraphOptions {
  onlyBus?: MixBusKey
}

export interface MixFilterGraph {
  inputs: string[]
  graph: string
  outputDurationSec: number
}

export interface MixRenderResult {
  url: string
  outputPath: string
  startMs: number
  endMs: number
  durationMs: number
}

function sec(valueMs: number): string {
  return (valueMs / 1000).toFixed(3)
}

function linear(value: number): string {
  return Number(value.toFixed(3)).toString()
}

function panFilter(value: number): string {
  const pan = Math.max(-1, Math.min(1, value))
  const left = pan > 0 ? 1 - pan : 1
  const right = pan < 0 ? 1 + pan : 1
  return `pan=stereo|c0=c0*${linear(left)}|c1=c1*${linear(right)}`
}

/** MixPlan 里存逻辑路径（static/projects/...），渲染前解析成物理路径 */
function renderInputPath(url: string): string {
  if (/^https?:\/\//i.test(url) || path.isAbsolute(url)) return url
  try {
    return getAbsolutePath(url)
  } catch {
    return url
  }
}

function clipChain(
  clip: MixClip,
  track: MixTrack,
  inputIndex: number,
  rangeStart: number,
  rangeEnd: number,
  label: string,
): string | null {
  if (!clip.usable || clip.muted || !clip.audioUrl) return null
  const start = Math.max(clip.startMs, rangeStart)
  const end = Math.min(clip.endMs, rangeEnd)
  const duration = end - start
  if (duration < 10) return null

  const sourceStart = Math.max(0, clip.sourceStartMs + (start - clip.startMs))
  const delay = Math.round(start - rangeStart)
  const fadeIn = start === clip.startMs ? Math.min(clip.fadeInMs, duration) : 0
  const fadeOut = end === clip.endMs ? Math.min(clip.fadeOutMs, duration) : 0

  let chain = `[${inputIndex}:a]${AFMT}`
  if (clip.loop || track.loop) {
    chain += `,aloop=loop=-1:size=${Math.max(SR, Math.ceil((duration / 1000) * SR))}`
  }
  chain += `,atrim=start=${sec(sourceStart)}:end=${sec(sourceStart + duration)},asetpts=PTS-STARTPTS`
  if (clip.gainDb) chain += `,volume=${clip.gainDb}dB`
  if (clip.pan) chain += `,${panFilter(clip.pan)}`
  if (fadeIn > 0) chain += `,afade=t=in:st=0:d=${sec(fadeIn)}`
  if (fadeOut > 0) chain += `,afade=t=out:st=${sec(duration - fadeOut)}:d=${sec(fadeOut)}`
  chain += `,adelay=${delay}|${delay}[${label}]`
  return chain
}

/**
 * 按 MixPlan 生成 FFmpeg filter_complex。
 * 范围模式把每个片段裁剪到区间内，并保留区间起点的静音占位。
 */
export function buildMixFilterGraph(
  plan: MixPlan,
  range: MixRenderRange = {},
  options: MixFilterGraphOptions = {},
): MixFilterGraph {
  const rangeStart = Math.max(0, Math.round(range.startMs ?? 0))
  const rangeEnd = Math.max(0, Math.round(range.endMs ?? plan.durationMs))
  if (rangeEnd - rangeStart < 50) throw new MixRenderError('试听范围过短')
  const busByKey = new Map<string, MixBus>(plan.buses.map((bus) => [bus.key, bus]))
  const onlyBus = options.onlyBus && options.onlyBus !== 'master' ? options.onlyBus : null
  if (onlyBus) {
    const targetBus = busByKey.get(onlyBus)
    if (!targetBus) throw new MixRenderError(`总线不存在：${onlyBus}`)
    if (targetBus.effectiveMuted) throw new MixRenderError('目标总线已静音')
  } else if (busByKey.get('master')?.muted) {
    throw new MixRenderError('主输出已静音')
  }

  const inputs: string[] = []
  const inputIndex = new Map<string, number>()
  const inputFor = (url: string) => {
    const existing = inputIndex.get(url)
    if (existing !== undefined) return existing
    const index = inputs.length
    inputs.push(url)
    inputIndex.set(url, index)
    return index
  }

  const parts: string[] = []
  let clipSeq = 0
  const labelsByBus = new Map<string, string[]>()
  const needDialogue = onlyBus
    ? onlyBus !== 'dialogue' && Boolean(busByKey.get(onlyBus)?.ducking)
    : true

  plan.tracks.forEach((track, trackSeq) => {
    if (track.effectiveMuted) return
    const bus = busByKey.get(track.busId)
    if (!bus || bus.effectiveMuted) return
    // 单总线导出只保留目标总线与 ducking 所需的对话键，避免生成悬空的轨道标签
    if (onlyBus && track.busId !== onlyBus && !(needDialogue && track.busId === 'dialogue')) return
    const clipLabels: string[] = []
    for (const clip of track.clips) {
      if (!clip.audioUrl) continue
      const label = `c${clipSeq}`
      const chain = clipChain(clip, track, inputFor(renderInputPath(clip.audioUrl)), rangeStart, rangeEnd, label)
      if (!chain) continue
      parts.push(chain)
      clipLabels.push(label)
      clipSeq += 1
    }
    if (!clipLabels.length) return

    const trackLabel = `t${trackSeq}`
    let chain = `${clipLabels.map((label) => `[${label}]`).join('')}amix=inputs=${clipLabels.length}:normalize=0:dropout_transition=0`
    if (track.volume !== 1) chain += `,volume=${linear(track.volume)}`
    if (track.pan) chain += `,${panFilter(track.pan)}`
    chain += `[${trackLabel}]`
    parts.push(chain)
    const list = labelsByBus.get(track.busId) || []
    list.push(trackLabel)
    labelsByBus.set(track.busId, list)
  })

  if (!labelsByBus.size) throw new MixRenderError('没有可渲染的音频片段')

  const busOutputs = new Map<string, string>()
  const rangeDurationSec = (rangeEnd - rangeStart) / 1000
  for (const [key, labels] of labelsByBus) {
    if (onlyBus && key !== onlyBus && !(needDialogue && key === 'dialogue')) continue
    const bus = busByKey.get(key)!
    const raw = `raw_${key}`
    let chain = `${labels.map((label) => `[${label}]`).join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0`
    if (bus.volume !== 1) chain += `,volume=${linear(bus.volume)}`
    // 补静音到全程，避免侧链/末路总线提前结束导致输出被截短
    chain += `,apad=whole_dur=${rangeDurationSec.toFixed(3)}[${raw}]`
    parts.push(chain)
    busOutputs.set(key, raw)
  }

  if (onlyBus && !busOutputs.has(onlyBus)) {
    throw new MixRenderError(`该总线没有可渲染的音频片段：${onlyBus}`)
  }

  const dialogueRaw = busOutputs.get('dialogue')
  const duckingTargets = onlyBus
    ? (onlyBus !== 'dialogue' && busByKey.get(onlyBus)?.ducking && dialogueRaw ? [onlyBus] : [])
    : [...busOutputs.keys()]
      .filter((key) => key !== 'dialogue' && busByKey.get(key)?.ducking)
  let sidechainKey: string | null = null
  if (dialogueRaw && duckingTargets.length) {
    if (onlyBus) {
      // 单总线导出不需要保留对白输出，直接把它当侧链键，避免产生悬空标签
      sidechainKey = dialogueRaw
    } else {
      parts.push(`[${dialogueRaw}]asplit=2[bus_dialogue][sidechain_dialogue]`)
      busOutputs.set('dialogue', 'bus_dialogue')
      sidechainKey = 'sidechain_dialogue'
    }
  }

  for (const key of duckingTargets) {
    if (!sidechainKey) continue
    const raw = busOutputs.get(key)!
    const bus = busByKey.get(key)!
    const label = `bus_${key}`
    parts.push(
      `[${raw}][${sidechainKey}]sidechaincompress=`
      + `threshold=0.03:ratio=${linear(bus.duckRatio)}:attack=${Math.round(bus.duckAttackMs)}:`
      + `release=${Math.round(bus.duckReleaseMs)}[${label}]`,
    )
    busOutputs.set(key, label)
  }

  if (onlyBus) {
    parts.push(`[${busOutputs.get(onlyBus)!}]anull[out]`)
    return {
      inputs,
      graph: parts.join(';'),
      outputDurationSec: (rangeEnd - rangeStart) / 1000,
    }
  }

  const master = busByKey.get('master')
  const masterVolume = master?.volume ?? 1
  const lufs = master?.lufsTarget ?? plan.master.lufs ?? -16
  const truePeak = master?.limiterCeiling ?? plan.master.truePeak ?? -1.5
  const limiterLinear = Number(Math.pow(10, truePeak / 20).toFixed(4))
  const outputs = [...busOutputs.values()].map((label) => `[${label}]`).join('')
  parts.push(
    `${outputs}amix=inputs=${busOutputs.size}:normalize=0:dropout_transition=0`
    + (masterVolume !== 1 ? `,volume=${linear(masterVolume)}` : '')
    + `,loudnorm=I=${lufs}:TP=${truePeak}:LRA=11`
    + `,alimiter=limit=${limiterLinear}:level=false[out]`,
  )

  return {
    inputs,
    graph: parts.join(';'),
    outputDurationSec: (rangeEnd - rangeStart) / 1000,
  }
}

interface MixExecOptions {
  onProgress?: (percent: number) => void
  signal?: AbortSignal
}

function execFfmpeg(
  inputs: string[],
  filter: string,
  outputOptions: string[],
  output: string,
  execOptions: MixExecOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (execOptions.signal?.aborted) {
      reject(new MixRenderError('已取消'))
      return
    }
    const cmd = ffmpeg()
    for (const input of inputs) cmd.input(input)
    cmd.complexFilter(filter)
    cmd.outputOptions(outputOptions)
    cmd.output(output)

    let aborted = false
    const onAbort = () => {
      aborted = true
      try {
        cmd.kill('SIGTERM')
      } catch { /* 进程尚未启动 */ }
    }
    const cleanup = () => execOptions.signal?.removeEventListener('abort', onAbort)
    execOptions.signal?.addEventListener('abort', onAbort, { once: true })

    cmd.on('progress', (progress: { percent?: number }) => {
      const percent = Number(progress?.percent)
      if (Number.isFinite(percent)) {
        execOptions.onProgress?.(Math.max(0, Math.min(100, percent)))
      }
    })
    cmd.on('end', () => {
      cleanup()
      resolve()
    })
    cmd.on('error', (err, _stdout, stderr) => {
      cleanup()
      if (aborted || execOptions.signal?.aborted) {
        reject(new MixRenderError('已取消'))
        return
      }
      reject(new Error(`${err.message}${stderr ? `\n${String(stderr).slice(-1200)}` : ''}`))
    })
    try {
      cmd.run()
    } catch (error) {
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function toLogicalUrl(outputPath: string): string {
  const root = path.dirname(STORAGE_ROOT)
  const relative = path.relative(root, outputPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return outputPath
  return relative.split(path.sep).join('/')
}

/** 只保留最近 N 个同前缀预览，避免反复试听堆积 */
export function keepLatestMixedFiles(dir: string, prefix: string, keep = 6): void {
  if (!fs.existsSync(dir)) return
  const files = fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const file = path.join(dir, name)
      try {
        return { file, mtime: fs.statSync(file).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((item): item is { file: string; mtime: number } => Boolean(item))
    .sort((a, b) => b.mtime - a.mtime)
  for (const item of files.slice(keep)) fs.rmSync(item.file, { force: true })
}

export async function renderMixAudio(plan: MixPlan, options: MixRenderOptions): Promise<MixRenderResult> {
  const { inputs, graph, outputDurationSec } = buildMixFilterGraph(plan, options, { onlyBus: options.onlyBus })
  const codec = options.codec ?? (options.format === 'wav' ? 'pcm_s16le' : 'aac')
  let codecOptions: string[]
  if (codec === 'aac') {
    codecOptions = ['-c:a', 'aac', '-b:a', `${options.bitrateKbps ?? 192}k`]
  } else {
    if (options.format !== 'wav') throw new MixRenderError('m4a 只支持 AAC 编码')
    codecOptions = ['-c:a', codec]
  }
  fs.mkdirSync(path.dirname(options.outputPath), { recursive: true })
  try {
    await execFfmpeg(
      inputs,
      graph,
      [
        '-map', '[out]', '-vn',
        '-ar', String(SR), '-ac', '2',
        ...codecOptions,
        '-t', String(Number(outputDurationSec.toFixed(3))),
      ],
      options.outputPath,
      { onProgress: options.onProgress, signal: options.signal },
    )
  } catch (error) {
    if (error instanceof MixRenderError && error.message === '已取消') {
      fs.rmSync(options.outputPath, { force: true })
    }
    throw error
  }

  if (path.basename(options.outputPath).startsWith('preview-')) {
    keepLatestMixedFiles(path.dirname(options.outputPath), 'preview-')
  }

  const durationMs = Math.round(await probeDurationMs(options.outputPath))
  return {
    url: toLogicalUrl(options.outputPath),
    outputPath: options.outputPath,
    startMs: Math.max(0, Math.round(options.startMs ?? 0)),
    endMs: Math.max(0, Math.round(options.endMs ?? plan.durationMs)),
    durationMs,
  }
}
