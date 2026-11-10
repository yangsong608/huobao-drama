/**
 * 本地文字过渡视频：ASS 生成 + ffmpeg 渲染，纯本地确定性输出。
 * 不依赖 DB / 文本模型，供过渡服务在用户选择「文字视频」时调用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveFfmpegSuite } from '../utils/ffmpeg.js'
import { formatAssTime } from './subtitles.js'

const DEFAULT_ASPECT = '16:9'
const DEFAULT_RESOLUTION = '720p'
const COLOR_TAG = '0x101014'

interface TierSpec { maxDim: number; height: number }

const RESOLUTION_TIERS: Record<string, TierSpec> = {
  '480p': { maxDim: 854, height: 480 },
  '720p': { maxDim: 1280, height: 720 },
  '1080p': { maxDim: 1920, height: 1080 },
}

function parseAspectRatio(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /^(\d+(?:\.\d+)?)\s*[:：/]\s*(\d+(?:\.\d+)?)$/.exec(value.trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return width / height
}

function ceilTo8(value: number): number {
  return Math.max(8, Math.ceil(value / 8) * 8)
}

/**
 * 按项目比例与清晰度换算输出尺寸：在档位包围盒内等比铺满，
 * 宽高向上取 8 的倍数（libx264 要求偶数，8 对齐避免字幕缩放抖动）。
 */
export function transitionTextDimensions(
  aspectRatio: string | null | undefined,
  resolution: string | null | undefined,
): { width: number; height: number } {
  const aspect = parseAspectRatio(aspectRatio) ?? parseAspectRatio(DEFAULT_ASPECT)!
  const tier = RESOLUTION_TIERS[(resolution || '').trim().toLowerCase()] || RESOLUTION_TIERS[DEFAULT_RESOLUTION]
  const boxWidth = aspect >= 1 ? tier.maxDim : tier.height
  const boxHeight = aspect >= 1 ? tier.height : tier.maxDim
  let width: number
  let height: number
  if (boxWidth / boxHeight > aspect) {
    height = boxHeight
    width = boxHeight * aspect
  } else {
    width = boxWidth
    height = boxWidth / aspect
  }
  return { width: ceilTo8(width), height: ceilTo8(height) }
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '＼')
    .replace(/\{/g, '（')
    .replace(/\}/g, '）')
    .replace(/\r?\n/g, '\\N')
}

function escapeFilterPath(file: string): string {
  return file
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

export interface TransitionTextAssInput {
  width: number
  height: number
  durationMs: number
  title: string
  subtitle?: string | null
}

/** 主标题居中偏上、副标题居中偏下；两条都带 150ms 淡入淡出 */
export function buildTransitionTextAss(input: TransitionTextAssInput): string {
  const width = Math.max(2, Math.round(input.width))
  const height = Math.max(2, Math.round(input.height))
  const duration = Math.max(0, Math.round(input.durationMs))
  const titleSize = Math.max(16, Math.round(height * 0.078))
  const subtitleSize = Math.max(12, Math.round(height * 0.045))
  const end = formatAssTime(duration)
  const subtitle = input.subtitle?.trim() || null
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Title,sans-serif,${titleSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,5,20,20,20,1`,
    `Style: Subtitle,sans-serif,${subtitleSize},&H00D8D8D8,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,20,20,20,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')
  const centerX = Math.round(width / 2)
  const titleY = subtitle ? Math.round(height * 0.45) : Math.round(height * 0.5)
  const events = [
    `Dialogue: 0,0:00:00.00,${end},Title,,0,0,0,,{\\an5\\pos(${centerX},${titleY})\\fad(150,150)}${escapeAssText(input.title.trim())}`,
  ]
  if (subtitle) {
    events.push(
      `Dialogue: 0,0:00:00.00,${end},Subtitle,,0,0,0,,{\\an5\\pos(${centerX},${Math.round(height * 0.57)})\\fad(150,150)}${escapeAssText(subtitle)}`,
    )
  }
  return `${header}\n${events.join('\n')}\n`
}

export interface TransitionTextRenderArgsInput {
  assPath: string
  outputPath: string
  width: number
  height: number
  durationMs: number
  fps: number
  backgroundImagePath?: string | null
}

/** 主/副标题已写入 ASS；视频轨用纯色或场景图循环，音频轨固定静音 AAC */
export function buildTransitionTextRenderArgs(input: TransitionTextRenderArgsInput): string[] {
  const width = Math.max(2, Math.round(input.width))
  const height = Math.max(2, Math.round(input.height))
  const fps = Math.max(1, Math.round(input.fps))
  const seconds = Math.max(0.1, input.durationMs / 1000).toFixed(3)
  const filters: string[] = []
  if (input.backgroundImagePath) {
    filters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`)
  }
  filters.push(`ass='${escapeFilterPath(input.assPath)}'`)
  const videoInput = input.backgroundImagePath
    ? ['-loop', '1', '-i', input.backgroundImagePath]
    : ['-f', 'lavfi', '-i', `color=c=${COLOR_TAG}:s=${width}x${height}:r=${fps}`]
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...videoInput,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-vf', filters.join(','),
    '-t', seconds,
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart',
    input.outputPath,
  ]
}

export interface RenderTransitionTextInput {
  outputPath: string
  width: number
  height: number
  durationMs: number
  title: string
  subtitle?: string | null
  fps?: number
  backgroundImagePath?: string | null
}

/** 写 ASS 并渲染成 mp4；失败抛出带 stderr 尾部的可读错误 */
export async function renderTransitionTextVideo(input: RenderTransitionTextInput): Promise<void> {
  const bin = resolveFfmpegSuite().ffmpeg.path
  if (!bin) throw new Error('FFmpeg 不可用，无法渲染文字过渡视频')
  const outputDir = path.dirname(input.outputPath)
  fs.mkdirSync(outputDir, { recursive: true })
  const assPath = path.join(outputDir, `${path.basename(input.outputPath, path.extname(input.outputPath))}.ass`)
  fs.writeFileSync(assPath, buildTransitionTextAss({
    width: input.width,
    height: input.height,
    durationMs: input.durationMs,
    title: input.title,
    subtitle: input.subtitle ?? null,
  }), 'utf-8')
  const args = buildTransitionTextRenderArgs({
    assPath,
    outputPath: input.outputPath,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs,
    fps: input.fps ?? 30,
    backgroundImagePath: input.backgroundImagePath ?? null,
  })
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (err) {
      reject(new Error(`文字过渡渲染启动失败：${(err as Error).message}`))
      return
    }
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error('文字过渡渲染超时'))
    }, 180_000)
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += String(chunk)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`文字过渡渲染失败：${err.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`文字过渡渲染失败：${stderr.slice(-800) || `退出码 ${code}`}`))
        return
      }
      resolve()
    })
  })
}
