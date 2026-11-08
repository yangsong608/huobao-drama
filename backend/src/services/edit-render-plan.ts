/**
 * 剪辑渲染器（技术设计 §6.10 支持范围表）：
 * - 逐片段渲染为统一参数（WxH@fps + H.264 yuv420p + AAC 48k 立体声）；
 * - 相邻片段间的转场用 xfade + acrossfade 真实合成，其余边界与空档按 concat 拼接；
 * - 叠加轨（画中画/图片/文字）真实导出：concat 后单遍 overlay 滤镜合成视频/图片，
 *   文字叠加走独立 ASS 烧录（任何字幕模式都生效）；叠加视频音频不入混音（预览同口径静音）；
 * - 降级项（不支持的转场→硬切、变速超范围）通过 buildRenderReport 全量列出，
 *   供导出确认弹窗使用；渲染本身按降级后的语义输出；
 * - 字幕三模式：burn（ASS 重编码烧录）/ soft（mov_text 软字幕流）/ none；
 * - 不支持项绝不出现在报告中以外的位置：渲染前先产出完整警告清单。
 */
import { execFile, execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getAbsolutePath } from '../utils/storage.js'
import { resolveFfmpegSuite } from '../utils/ffmpeg.js'
import {
  computeLayout,
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
  type EditAudioEffectPreset,
  type EditClip,
  type EditOverlay,
  type EditPlanV1,
  type EditTransform,
  type EditTransition,
} from './edit-plan.js'
import { buildOverlayAss } from './edit-subtitle-ass.js'

export interface EditRenderWarning { code: string; message: string }

/** 前端转场类型 → ffmpeg xfade 过渡名（xfade 全量 46 种） */
export const XFADE_BY_TYPE: Record<string, string> = {
  dissolve: 'fade',
  white: 'fadewhite',
  black: 'fadeblack',
  'grain-dissolve': 'dissolve',
  'fast-fade': 'fadefast',
  'slow-fade': 'fadeslow',
  'distance-fade': 'distance',
  'gray-fade': 'fadegrays',
  'push-left': 'slideleft',
  'push-right': 'slideright',
  'push-up': 'slideup',
  'push-down': 'slidedown',
  'smooth-left': 'smoothleft',
  'smooth-right': 'smoothright',
  'smooth-up': 'smoothup',
  'smooth-down': 'smoothdown',
  'wipe-left': 'wipeleft',
  'wipe-right': 'wiperight',
  'wipe-up': 'wipeup',
  'wipe-down': 'wipedown',
  'corner-wipe-tl': 'wipetl',
  'corner-wipe-tr': 'wipetr',
  'corner-wipe-bl': 'wipebl',
  'corner-wipe-br': 'wipebr',
  radial: 'radial',
  'vertical-open': 'vertopen',
  'vertical-close': 'vertclose',
  'horizontal-open': 'horzopen',
  'horizontal-close': 'horzclose',
  'circle-open': 'circleopen',
  'circle-close': 'circleclose',
  'circle-crop': 'circlecrop',
  'rect-crop': 'rectcrop',
  'zoom-in': 'zoomin',
  'squeeze-h': 'squeezeh',
  'squeeze-v': 'squeezev',
  'slice-hl': 'hlslice',
  'slice-hr': 'hrslice',
  'slice-vu': 'vuslice',
  'slice-vd': 'vdslice',
  'diagonal-tl': 'diagtl',
  'diagonal-tr': 'diagtr',
  'diagonal-bl': 'diagbl',
  'diagonal-br': 'diagbr',
  blur: 'hblur',
  pixelize: 'pixelize',
}

export function isSupportedTransition(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(XFADE_BY_TYPE, type)
}

/** 导出降级清单：所有不支持项必须出现在报告中（设计 6.10 支持范围表） */
export function buildRenderReport(plan: EditPlanV1): { warnings: EditRenderWarning[] } {
  const warnings: EditRenderWarning[] = []
  const clipIndex = new Map(plan.clips.map((clip, index) => [clip.id, index]))
  const hardCutTransitions = plan.transitions.filter((transition) => {
    const from = clipIndex.get(transition.fromClipId)
    const to = clipIndex.get(transition.toClipId)
    return from === undefined
      || to !== from + 1
      || !isSupportedTransition(transition.type)
      || Number(plan.clips[to].gapBeforeMs) > 0
      || Number(transition.durationMs) < MIN_TRANSITION_MS
      || Number(transition.durationMs) > MAX_TRANSITION_MS
  })
  if (hardCutTransitions.length) {
    warnings.push({ code: 'TRANSITION_HARD_CUT', message: '部分转场不受支持或已失效，将按硬切导出' })
  }
  if (plan.clips.some((clip) => (Number(clip.speed) || 1) < 0.25 || (Number(clip.speed) || 1) > 4)) {
    warnings.push({ code: 'SPEED_CLAMPED', message: '变速超出 0.25–4×，将夹取到支持范围' })
  }
  return { warnings }
}

/** 滤镜预设 → ffmpeg 滤镜链（intensity 0–100 线性缩放，0 = 原画面）；预览端用同语义 CSS 近似 */
export function buildClipFilterChain(preset: string, intensityRaw: unknown): string[] {
  const intensity = Math.max(0, Math.min(100, Math.round(Number(intensityRaw) || 0)))
  if (preset === 'none' || intensity === 0) return []
  const k = intensity / 100
  const num = (value: number) => value.toFixed(3).replace(/\.?0+$/, '') || '0'
  switch (preset) {
    case 'clear':
      return [`eq=brightness=${num(0.02 * k)}:saturation=${num(1 + 0.15 * k)}:contrast=${num(1 + 0.06 * k)}`]
    case 'warm':
      return [
        `eq=saturation=${num(1 + 0.10 * k)}:contrast=${num(1 + 0.05 * k)}`,
        `colorbalance=rm=${num(0.08 * k)}:gm=${num(0.02 * k)}:bm=${num(-0.08 * k)}`,
      ]
    case 'cool':
      return [
        `eq=saturation=${num(1 + 0.08 * k)}:contrast=${num(1 + 0.05 * k)}`,
        `colorbalance=rm=${num(-0.06 * k)}:bm=${num(0.08 * k)}`,
      ]
    case 'cinematic':
      return [
        `eq=contrast=${num(1 + 0.14 * k)}:saturation=${num(1 - 0.08 * k)}`,
        `colorbalance=rs=${num(0.05 * k)}:bs=${num(-0.05 * k)}`,
      ]
    case 'mono':
      return [`eq=saturation=${num(1 - k)}:contrast=${num(1 + 0.08 * k)}`]
    case 'vintage':
      return [
        `eq=saturation=${num(1 - 0.25 * k)}:contrast=${num(1 - 0.05 * k)}:brightness=${num(0.03 * k)}`,
        `colorbalance=rm=${num(0.06 * k)}:bm=${num(-0.05 * k)}`,
      ]
    default:
      return []
  }
}

/** 变换缩放/位移 → ffmpeg 滤镜（先放大/缩小再裁剪/补边定位）；x/y 为画布比例 -1..1 */
function transformChain(plan: EditPlanV1, transform: EditTransform): string[] {
  const { width, height } = plan.project
  const scale = Math.max(0.5, Math.min(2, Number(transform.scale) || 1))
  const x = Math.max(-1, Math.min(1, Number(transform.x) || 0))
  const y = Math.max(-1, Math.min(1, Number(transform.y) || 0))
  if (scale === 1 && x === 0 && y === 0) return []
  const scaledW = Math.max(2, Math.round(width * scale / 2) * 2)
  const scaledH = Math.max(2, Math.round(height * scale / 2) * 2)
  const chain = [`scale=${scaledW}:${scaledH}`]
  if (scale >= 1) {
    const maxX = scaledW - width
    const maxY = scaledH - height
    const cx = Math.round(Math.max(0, Math.min(maxX, (scaledW - width) / 2 + x * width)))
    const cy = Math.round(Math.max(0, Math.min(maxY, (scaledH - height) / 2 + y * height)))
    chain.push(`crop=${width}:${height}:${cx}:${cy}`)
  } else {
    const maxX = width - scaledW
    const maxY = height - scaledH
    const px = Math.round(Math.max(0, Math.min(maxX, (width - scaledW) / 2 + x * width)))
    const py = Math.round(Math.max(0, Math.min(maxY, (height - scaledH) / 2 + y * height)))
    chain.push(`pad=${width}:${height}:${px}:${py}:black`)
  }
  return chain
}

/** 导出预设覆盖：尺寸 + 码率（与 export-presets.ts 的视频预设字段对应） */
export interface EditExportPresetOverride {
  width?: number | null
  height?: number | null
  videoBitrateKbps?: number | null
  maxrateKbps?: number | null
  bufsizeKbps?: number | null
  audioBitrateKbps?: number | null
}

/** 预设尺寸覆盖工程尺寸：烧录字幕的 ASS 需要用同一份覆盖后的计划生成（PlayRes 对齐输出） */
export function resolveExportPlan(plan: EditPlanV1, preset?: EditExportPresetOverride | null): EditPlanV1 {
  const width = Math.round(Number(preset?.width) || 0)
  const height = Math.round(Number(preset?.height) || 0)
  if (!width || !height || (width === plan.project.width && height === plan.project.height)) return plan
  return { ...plan, project: { ...plan.project, width, height } }
}

function videoArgs(preset?: EditExportPresetOverride | null): string[] {
  const bitrate = Math.round(Number(preset?.videoBitrateKbps) || 0)
  if (!bitrate) return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']
  const args = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-b:v', `${bitrate}k`]
  const maxrate = Math.round(Number(preset?.maxrateKbps) || 0)
  const bufsize = Math.round(Number(preset?.bufsizeKbps) || 0)
  if (maxrate) args.push('-maxrate', `${maxrate}k`)
  if (bufsize) args.push('-bufsize', `${bufsize}k`)
  return args
}

function audioArgs(preset?: EditExportPresetOverride | null): string[] {
  const bitrate = Math.round(Number(preset?.audioBitrateKbps) || 192)
  return ['-c:a', 'aac', '-b:a', `${bitrate}k`, '-ar', '48000', '-ac', '2']
}

function run(args: string[]): Promise<void> {
  const bin = resolveFfmpegSuite().ffmpeg.path || 'ffmpeg'
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['-hide_banner', '-loglevel', 'error', ...args],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error) => {
        if (error) reject(new Error(`渲染失败：${error.message}`))
        else resolve()
      },
    )
  })
}

/** 变速夹取到校验范围（0.25–4×）；计划校验已保证，这里只兜底异常输入 */
function clampSpeed(clip: EditClip): number {
  const speed = Number(clip.speed)
  if (!Number.isFinite(speed) || speed <= 0) return 1
  return Math.min(4, Math.max(0.25, speed))
}

/** atempo 单实例只支持 0.5–2×，超范围用链式乘积覆盖 0.25–4× */
function atempoChain(speed: number): string {
  const parts: string[] = []
  let remaining = speed
  while (remaining > 2.0001) {
    parts.push('atempo=2.0')
    remaining /= 2
  }
  while (remaining < 0.4999) {
    parts.push('atempo=0.5')
    remaining /= 0.5
  }
  parts.push(`atempo=${remaining.toFixed(6)}`)
  return parts.join(',')
}

/** 计划里的源地址是存储相对路径；测试与外部导入允许绝对路径 */
function resolveSourceUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) throw new Error(`源素材必须为本地文件：${url}`)
  // /static/... 是站点内部地址而非文件系统路径（如定格帧 / 插入图片片段），先归一化再解析
  if (url.startsWith('/static/')) return getAbsolutePath(url.slice(1))
  if (path.isAbsolute(url)) return url
  return getAbsolutePath(url)
}

function videoFilter(clip: EditClip, plan: EditPlanV1): string[] {
  const { width, height } = plan.project
  const fps = plan.project.fps
  const t = clip.transform
  const speed = clampSpeed(clip)
  const chain: string[] = []
  // 变速先压缩时间戳，后续 fade 的 st/d 均按换算后的输出时长计
  if (speed !== 1 && clip.kind === 'video') chain.push(`setpts=${(1 / speed).toFixed(6)}*PTS`)
  chain.push(`fps=${fps}`)
  if (t.rotation === 90) chain.push('transpose=1')
  if (t.rotation === 270) chain.push('transpose=2')
  if (t.rotation === 180) chain.push('transpose=1,transpose=1')
  if (t.flipH) chain.push('hflip')
  if (t.flipV) chain.push('vflip')
  if (plan.project.defaultFit === 'fill') {
    chain.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`)
    chain.push(`crop=${width}:${height}`)
  } else {
    chain.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`)
    chain.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`)
  }
  chain.push(...transformChain(plan, t))
  chain.push(...buildClipFilterChain(clip.filter.preset, clip.filter.intensity))
  // 淡入淡出按速度换算后的输出时长计算（含等比缩短兜底）
  const outputContentMs = (clip.sourceOutMs - clip.sourceInMs) / speed
  if (clip.videoFadeInMs > 0) {
    chain.push(`fade=t=in:st=0:d=${(Math.min(clip.videoFadeInMs, outputContentMs) / 1000).toFixed(3)}`)
  }
  if (clip.videoFadeOutMs > 0) {
    const fadeOutMs = Math.min(clip.videoFadeOutMs, outputContentMs)
    chain.push(`fade=t=out:st=${((outputContentMs - fadeOutMs) / 1000).toFixed(3)}:d=${(fadeOutMs / 1000).toFixed(3)}`)
  }
  chain.push('format=yuv420p')
  return chain
}

/** 音频特效预设 → ffmpeg 滤镜链（导出真实合成；预览不模拟） */
const AUDIO_EFFECT_FILTERS: Record<EditAudioEffectPreset, string[]> = {
  none: [],
  denoise: ['afftdn=nf=-25'],
  echo: ['aecho=0.8:0.88:60:0.28'],
  reverb: ['aecho=0.75:0.85:50|90|140:0.22|0.16|0.1'],
  telephone: ['highpass=f=300', 'lowpass=f=3400'],
}

function audioFilter(clip: EditClip): string[] {
  const speed = clampSpeed(clip)
  const chain: string[] = []
  if (speed !== 1) chain.push(atempoChain(speed))
  // 音调升降：aresample 固定 48k → asetrate 变调 → aresample 回 48k → atempo 补偿时长。
  // ±12 半音对应因子 0.5–2，恰在 atempo 单实例限制内，时长严格不变。
  const st = Math.max(-12, Math.min(12, Math.round(Number(clip.pitchSemitones) || 0)))
  if (st !== 0) {
    const factor = Math.pow(2, st / 12)
    chain.push(
      'aresample=48000',
      `asetrate=${Math.round(48000 * factor)}`,
      'aresample=48000',
      `atempo=${(1 / factor).toFixed(5)}`,
    )
  }
  const volume = Math.max(0, Math.min(2, Number(clip.volume) || 0))
  if (volume !== 1) chain.push(`volume=${volume.toFixed(2)}`)
  chain.push(...AUDIO_EFFECT_FILTERS[clip.audioEffect?.preset ?? 'none'])
  const outputContentMs = (clip.sourceOutMs - clip.sourceInMs) / speed
  // 独立音频淡入淡出；旧计划缺省时回退视频淡入淡出，与归一化迁移保持一致
  const audioFadeInMs = Number(clip.audioFadeInMs ?? clip.videoFadeInMs) || 0
  const audioFadeOutMs = Number(clip.audioFadeOutMs ?? clip.videoFadeOutMs) || 0
  if (audioFadeInMs > 0) {
    chain.push(`afade=t=in:st=0:d=${(Math.min(audioFadeInMs, outputContentMs) / 1000).toFixed(3)}`)
  }
  if (audioFadeOutMs > 0) {
    const fadeOutMs = Math.min(audioFadeOutMs, outputContentMs)
    chain.push(`afade=t=out:st=${((outputContentMs - fadeOutMs) / 1000).toFixed(3)}:d=${(fadeOutMs / 1000).toFixed(3)}`)
  }
  chain.push('aresample=48000')
  return chain
}

async function renderSegment(
  plan: EditPlanV1,
  clip: EditClip,
  file: string,
  preset: EditExportPresetOverride | null,
): Promise<void> {
  const { fps } = plan.project
  const speed = clampSpeed(clip)
  const sourceSec = ((clip.sourceOutMs - clip.sourceInMs) / 1000).toFixed(3)
  const outputSec = ((clip.sourceOutMs - clip.sourceInMs) / speed / 1000).toFixed(3)
  if (clip.kind === 'image') {
    // 图片片段：循环为视频帧，配 anullsrc 静音轨，时长按变速换算
    await run([
      '-y', '-loop', '1', '-t', outputSec, '-i', resolveSourceUrl(clip.source.url),
      '-f', 'lavfi', '-t', outputSec, '-i', 'anullsrc=r=48000:cl=stereo',
      '-map', '0:v:0', '-map', '1:a:0',
      '-vf', videoFilter(clip, plan).join(','), '-af', 'aresample=48000',
      '-r', String(fps), ...videoArgs(preset), ...audioArgs(preset),
      '-shortest', file,
    ])
    return
  }
  if (!clip.source.hasAudio) {
    // 无声视频：混入 anullsrc，保证拼接后始终存在音频流
    await run([
      '-y', '-ss', (clip.sourceInMs / 1000).toFixed(3), '-t', sourceSec, '-i', resolveSourceUrl(clip.source.url),
      '-f', 'lavfi', '-t', outputSec, '-i', 'anullsrc=r=48000:cl=stereo',
      '-map', '0:v:0', '-map', '1:a:0',
      '-vf', videoFilter(clip, plan).join(','),
      '-r', String(fps), ...videoArgs(preset), ...audioArgs(preset),
      '-shortest', file,
    ])
    return
  }
  await run([
    '-y', '-ss', (clip.sourceInMs / 1000).toFixed(3), '-t', sourceSec, '-i', resolveSourceUrl(clip.source.url),
    '-vf', videoFilter(clip, plan).join(','),
    '-af', audioFilter(clip).join(','),
    '-r', String(fps), ...videoArgs(preset), ...audioArgs(preset),
    file,
  ])
}

async function renderGap(plan: EditPlanV1, gapMs: number, file: string, preset: EditExportPresetOverride | null): Promise<void> {
  const { width, height, fps } = plan.project
  const sec = (gapMs / 1000).toFixed(3)
  await run([
    '-y',
    '-f', 'lavfi', '-t', sec, '-i', `color=c=black:s=${width}x${height}:r=${fps}`,
    '-f', 'lavfi', '-t', sec, '-i', 'anullsrc=r=48000:cl=stereo',
    '-r', String(fps), ...videoArgs(preset), ...audioArgs(preset),
    file,
  ])
}

/**
 * 把一条“转场链”的已渲染片段合成一个文件：
 * xfade 的 offset = 前序输出时长 − 本次转场时长，与布局“后段提前 overlap 开始”的语义一致；
 * acrossfade 用同一时长交叉淡化音频。各段已统一分辨率/帧率/采样率，xfade 输出再次统一编码。
 */
async function renderTransitionChain(
  plan: EditPlanV1,
  chain: { files: string[]; transitions: EditTransition[] },
  file: string,
  preset: EditExportPresetOverride | null,
): Promise<void> {
  const { fps } = plan.project
  // xfade 以视频时间线为准；容器时长含 AAC 尾部填充，不能用于计算 offset
  const durations = await Promise.all(chain.files.map((item) => probeVideoDurationMs(item)))
  const filters: string[] = []
  let videoIn = '[0:v]'
  let audioIn = '[0:a]'
  let outputMs = durations[0]
  const frameMs = Math.round(1000 / Math.max(1, fps))
  for (let index = 1; index < chain.files.length; index += 1) {
    const transition = chain.transitions[index - 1]
    const wanted = Math.round(Number(transition.durationMs) || 0)
    const available = Math.min(outputMs, durations[index]) - frameMs
    const durationMs = Math.min(wanted, available)
    if (!isSupportedTransition(transition.type) || durationMs < MIN_TRANSITION_MS) {
      throw new Error(`转场余量不足，无法渲染：${transition.id}`)
    }
    const durationSec = (durationMs / 1000).toFixed(3)
    const offsetSec = ((outputMs - durationMs) / 1000).toFixed(3)
    const videoOut = `[v${index}]`
    const audioOut = `[a${index}]`
    filters.push(
      `${videoIn}[${index}:v]xfade=transition=${XFADE_BY_TYPE[transition.type]}:duration=${durationSec}:offset=${offsetSec}${videoOut}`,
    )
    filters.push(`${audioIn}[${index}:a]acrossfade=d=${durationSec}:c1=tri:c2=tri${audioOut}`)
    videoIn = videoOut
    audioIn = audioOut
    outputMs = outputMs + durations[index] - durationMs
  }
  await run([
    '-y',
    ...chain.files.flatMap((item) => ['-i', item]),
    '-filter_complex', filters.join(';'),
    '-map', videoIn, '-map', audioIn,
    '-r', String(fps), ...videoArgs(preset), ...audioArgs(preset),
    '-shortest', '-movflags', '+faststart', file,
  ])
}

function concatLine(file: string): string {
  return `file '${file.replace(/'/g, "'\\''")}'`
}

/** 叠加素材滤镜链：fps 统一 → contain 基准缩放（scale 1 时完整可见）→ rgba 透明度 → alpha 淡入淡出 */
function overlayInputFilters(plan: EditPlanV1, overlay: EditOverlay): { filters: string[]; x: number; y: number } {
  const { width, height, fps } = plan.project
  const transform = overlay.transform
  const scale = Math.max(0.1, Math.min(4, Number(transform.scale) || 1))
  const srcW = Math.max(1, Number(overlay.source?.width) || width)
  const srcH = Math.max(1, Number(overlay.source?.height) || height)
  const fit = Math.min(width / srcW, height / srcH)
  const effW = Math.max(2, Math.round((srcW * fit * scale) / 2) * 2)
  const effH = Math.max(2, Math.round((srcH * fit * scale) / 2) * 2)
  // 中心点 = 画布中心 + 画布比例偏移（x/y ∈ -2..2），与前端预览同口径
  const x = Math.max(
    -effW,
    Math.min(width, Math.round(width * (0.5 + Math.max(-2, Math.min(2, Number(transform.x) || 0))) - effW / 2)),
  )
  const y = Math.max(
    -effH,
    Math.min(height, Math.round(height * (0.5 + Math.max(-2, Math.min(2, Number(transform.y) || 0))) - effH / 2)),
  )
  const chain = [`fps=${fps}`, `scale=${effW}:${effH}`, 'format=rgba']
  const opacity = Math.max(0, Math.min(1, Number(overlay.opacity ?? 1)))
  if (opacity < 1) chain.push(`colorchannelmixer=aa=${opacity.toFixed(3)}`)
  const winMs = Math.max(1, overlay.endMs - overlay.startMs)
  if (overlay.fadeInMs > 0) {
    chain.push(`fade=t=in:st=0:d=${(Math.min(overlay.fadeInMs, winMs) / 1000).toFixed(3)}:alpha=1`)
  }
  if (overlay.fadeOutMs > 0) {
    const fadeOutMs = Math.min(overlay.fadeOutMs, winMs)
    chain.push(`fade=t=out:st=${((winMs - fadeOutMs) / 1000).toFixed(3)}:d=${(fadeOutMs / 1000).toFixed(3)}:alpha=1`)
  }
  return { filters: chain, x, y }
}

/** concat 后的叠加合成遍：视频/图片画中画按时间线窗口逐层 overlay（源从 0 播放，源短于窗口定格末帧） */
async function renderOverlayComposite(
  plan: EditPlanV1,
  baseFile: string,
  file: string,
  preset: EditExportPresetOverride | null,
): Promise<void> {
  const overlays = plan.overlays.filter(
    (overlay) => (overlay.kind === 'video' || overlay.kind === 'image') && overlay.source?.url,
  )
  const args: string[] = ['-y', '-i', baseFile]
  const filters: string[] = []
  let base = '[0:v]'
  let outputLabel = ''
  overlays.forEach((overlay, index) => {
    const inputIndex = index + 1
    const winSec = (Math.max(1, overlay.endMs - overlay.startMs) / 1000).toFixed(3)
    if (overlay.kind === 'image') {
      args.push('-loop', '1', '-t', winSec, '-i', resolveSourceUrl(overlay.source!.url))
    } else {
      args.push('-t', winSec, '-i', resolveSourceUrl(overlay.source!.url))
    }
    const { filters: chain, x, y } = overlayInputFilters(plan, overlay)
    const scaled = `[ovs${index}]`
    const out = `[ovl${index}]`
    filters.push(`[${inputIndex}:v]${chain.join(',')}${scaled}`)
    filters.push(
      `${base}${scaled}overlay=x=${x}:y=${y}:eof_action=repeat:enable='between(t,${(overlay.startMs / 1000).toFixed(3)},${(overlay.endMs / 1000).toFixed(3)})'${out}`,
    )
    base = out
    outputLabel = out
  })
  await run([
    ...args,
    '-filter_complex', filters.join(';'),
    '-map', outputLabel, '-map', '0:a?',
    ...videoArgs(preset),
    '-c:a', 'copy', '-movflags', '+faststart', file,
  ])
}

export async function renderEditVideo(input: {
  plan: EditPlanV1
  outputPath: string
  subtitleMode: 'burn' | 'soft' | 'none'
  assPath?: string
  srtPath?: string
  preset?: EditExportPresetOverride | null
  onProgress?: (pct: number) => void
}): Promise<{ durationMs: number; warnings: EditRenderWarning[] }> {
  const preset = input.preset ?? null
  // 预设尺寸覆盖工程尺寸；布局只依赖时间（fps/时长），不受尺寸影响
  const plan = resolveExportPlan(input.plan, preset)
  const warnings = buildRenderReport(plan).warnings
  const layout = computeLayout(plan)
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huobao-edit-render-'))
  try {
    // 1) 逐片段与空档渲染成统一参数的临时文件
    interface RenderedClip { clip: EditClip; gapFile: string | null; file: string }
    const rendered: RenderedClip[] = []
    let prevEndMs = 0
    let index = 0
    for (const layoutClip of layout.clips) {
      const clip = input.plan.clips.find((c) => c.id === layoutClip.clipId)
      if (!clip) continue
      // 布局不含 gap 字段：空档 = 本片段起点 − 上一片段终点（转场重叠为负值，按转场处理）
      const gapMs = layoutClip.timelineStartMs - prevEndMs
      let gapFile: string | null = null
      if (gapMs > 0) {
        gapFile = path.join(workDir, `gap-${index}.mp4`)
        await renderGap(plan, gapMs, gapFile, preset)
      }
      const segFile = path.join(workDir, `seg-${index}.mp4`)
      await renderSegment(plan, clip, segFile, preset)
      rendered.push({ clip, gapFile, file: segFile })
      prevEndMs = layoutClip.timelineEndMs
      index += 1
      input.onProgress?.(Math.round((index / Math.max(1, layout.clips.length)) * 80))
    }
    if (!rendered.length) throw new Error('时间线没有任何可渲染片段')

    // 2) 有可渲染转场的相邻片段组成一条链；空档与硬切把序列断开
    type Sequence =
      | { kind: 'file'; file: string }
      | { kind: 'chain'; files: string[]; transitions: EditTransition[] }
    const sequences: Sequence[] = []
    let chain: Extract<Sequence, { kind: 'chain' }> | null = null
    rendered.forEach((item, position) => {
      const previous = position > 0 ? rendered[position - 1] : null
      const transition = previous
        ? plan.transitions.find(
          (candidate) => candidate.fromClipId === previous.clip.id && candidate.toClipId === item.clip.id,
        )
        : undefined
      const canTransition = Boolean(
        transition
        && !item.gapFile
        && isSupportedTransition(transition.type)
        && Number(transition.durationMs) >= MIN_TRANSITION_MS
        && Number(transition.durationMs) <= MAX_TRANSITION_MS,
      )
      if (canTransition && chain) {
        chain.files.push(item.file)
        chain.transitions.push(transition!)
        return
      }
      if (item.gapFile) sequences.push({ kind: 'file', file: item.gapFile })
      chain = { kind: 'chain', files: [item.file], transitions: [] }
      sequences.push(chain)
    })

    const listLines: string[] = []
    let chainIndex = 0
    for (const sequence of sequences) {
      if (sequence.kind === 'file' || sequence.files.length === 1) {
        listLines.push(concatLine(sequence.kind === 'file' ? sequence.file : sequence.files[0]))
        continue
      }
      const chainFile = path.join(workDir, `chain-${chainIndex}.mp4`)
      chainIndex += 1
      await renderTransitionChain(plan, sequence, chainFile, preset)
      listLines.push(concatLine(chainFile))
    }
    const listFile = path.join(workDir, 'list.txt')
    await fsp.writeFile(listFile, listLines.join('\n'), 'utf8')
    const concatFile = path.join(workDir, 'concat.mp4')
    await run(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', concatFile])
    input.onProgress?.(85)

    // 3) 叠加轨：视频/图片画中画 concat 后一次合成遍；文字叠加走独立 ASS（任何字幕模式都烧录）
    const mediaOverlays = plan.overlays.filter(
      (overlay) => (overlay.kind === 'video' || overlay.kind === 'image') && overlay.source?.url,
    )
    let stageFile = concatFile
    if (mediaOverlays.length) {
      stageFile = path.join(workDir, 'overlaid.mp4')
      await renderOverlayComposite(plan, concatFile, stageFile, preset)
    }
    const overlayAssContent = buildOverlayAss(plan)
    const overlayAssPath = overlayAssContent ? path.join(workDir, 'overlay.ass') : null
    if (overlayAssPath) await fsp.writeFile(overlayAssPath, overlayAssContent, 'utf8')
    input.onProgress?.(90)

    const escapeAssPath = (value: string) => value.replace(/\\/g, '/').replace(/:/g, '\\:')
    const assFilters = [
      overlayAssPath ? `ass=${escapeAssPath(overlayAssPath)}` : '',
      input.subtitleMode === 'burn' && input.assPath ? `ass=${escapeAssPath(input.assPath)}` : '',
    ].filter(Boolean)
    // 工程级片头/片尾音频淡入淡出：启用时先落 premaster，最后一遍视频流拷贝 + 音频重编码加 afade
    const masterFadeInMs = Math.max(0, Math.round(plan.project.audioFadeInMs) || 0)
    const masterFadeOutMs = Math.max(0, Math.round(plan.project.audioFadeOutMs) || 0)
    const wantsMasterFade = masterFadeInMs > 0 || masterFadeOutMs > 0
    const premasterFile = path.join(workDir, 'premaster.mp4')
    const finalTarget = wantsMasterFade ? premasterFile : input.outputPath
    // 字幕阶段：烧录（叠加 ASS 同一遍重编码）重编码；soft 挂 mov_text 流；none 直接拷贝。三分支统一 +faststart
    if (assFilters.length) {
      await run([
        '-y', '-i', stageFile,
        '-vf', assFilters.join(','),
        ...videoArgs(preset),
        '-c:a', 'copy', '-movflags', '+faststart', finalTarget,
      ])
    } else if (input.subtitleMode === 'soft' && input.srtPath) {
      await run([
        '-y', '-i', stageFile, '-i', input.srtPath,
        '-c', 'copy', '-c:s', 'mov_text',
        '-metadata:s:s:0', 'language=chi', '-movflags', '+faststart', finalTarget,
      ])
    } else {
      await run(['-y', '-i', stageFile, '-c', 'copy', '-movflags', '+faststart', finalTarget])
    }
    if (wantsMasterFade) {
      const premasterDurationMs = await probeVideoDurationMs(premasterFile)
      const fadeFilters: string[] = []
      if (masterFadeInMs > 0) {
        fadeFilters.push(`afade=t=in:st=0:d=${(masterFadeInMs / 1000).toFixed(3)}`)
      }
      if (masterFadeOutMs > 0) {
        const fadeOutSec = Math.min(masterFadeOutMs, premasterDurationMs) / 1000
        fadeFilters.push(`afade=t=out:st=${Math.max(0, premasterDurationMs / 1000 - fadeOutSec).toFixed(3)}:d=${fadeOutSec.toFixed(3)}`)
      }
      // 拷贝 premaster 里可能存在的 mov_text 字幕流；音频经 afade 必须重编码
      await run([
        '-y', '-i', premasterFile,
        '-c:v', 'copy', '-c:s', 'copy', '-af', fadeFilters.join(','),
        ...audioArgs(preset), '-movflags', '+faststart', input.outputPath,
      ])
    }
    input.onProgress?.(95)
    // 时长以视频流为准：容器时长含 AAC 尾部填充，短输出会虚高并触发「偏差超过 1 帧」误判
    const durationMs = await probeVideoDurationMs(input.outputPath)
    return { durationMs, warnings }
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true })
  }
}

async function probeVideoDurationMs(file: string): Promise<number> {
  const bin = resolveFfmpegSuite().ffprobe.path || 'ffprobe'
  const out = execFileSync(bin, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=duration', '-of', 'csv=p=0', file,
  ]).toString()
  return Math.round(Number(out.trim()) * 1000)
}
