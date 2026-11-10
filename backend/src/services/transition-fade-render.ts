/**
 * 本地转场片段：取上一镜结尾与下一镜开头的 D 秒，用 ffmpeg xfade 拼成一条
 * 纯转场视频。零模型成本、输出静音，供过渡服务在用户选择「转场」时调用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveFfmpegSuite } from '../utils/ffmpeg.js'
import { transitionTextDimensions } from './transition-text-render.js'
import { type FadeStyle, normalizeFadeStyle } from './transition-plan.js'

/** 样式 → xfade 过渡名（内置 ffmpeg-static 均可用） */
const FADE_STYLE_XFADE: Record<FadeStyle, string> = {
  dissolve: 'fade',
  'dip-black': 'fadeblack',
  'dip-white': 'fadewhite',
  'wipe-left': 'wipeleft',
  'slide-left': 'slideleft',
  'circle-open': 'circleopen',
}

export function fadeStyleXfadeName(style: FadeStyle): string {
  return FADE_STYLE_XFADE[normalizeFadeStyle(style)]
}

function runBinary(
  bin: string,
  args: string[],
  timeoutMs: number,
  label: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      reject(new Error(`${label}启动失败：${(err as Error).message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`${label}超时`))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 4096) stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += String(chunk)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`${label}失败：${err.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`${label}失败：${stderr.slice(-800) || `退出码 ${code}`}`))
        return
      }
      resolve(stdout)
    })
  })
}

/** 读取视频时长（秒）；探测失败返回 null，由调用方按固定 0 起点兜底 */
export async function probeVideoDurationSeconds(file: string): Promise<number | null> {
  const bin = resolveFfmpegSuite().ffprobe.path
  if (!bin) return null
  try {
    const output = await runBinary(bin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      file,
    ], 20_000, '转场时长探测')
    const value = Number(output.trim().split(/\r?\n/)[0])
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

export interface FadeRenderArgsInput {
  fromPath: string
  toPath: string
  /** 上一镜可用时长（秒）；为 null 时按整段读取 */
  fromDuration: number | null
  outputPath: string
  width: number
  height: number
  durationMs: number
  style: FadeStyle
  fps?: number
}

/**
 * 两路输入统一缩放/裁切/补帧到相同尺寸与帧率，各取 D 秒后整段做 xfade。
 * 上一镜从结尾前 D 秒读起，下一镜从头读 D 秒；不足 D 秒的镜头用尾帧补足。
 */
export function buildFadeRenderArgs(input: FadeRenderArgsInput): string[] {
  const width = Math.max(2, Math.round(input.width))
  const height = Math.max(2, Math.round(input.height))
  const fps = Math.max(1, Math.round(input.fps ?? 30))
  const seconds = Math.max(0.1, input.durationMs / 1000)
  const duration = seconds.toFixed(3)
  const fromSeek = input.fromDuration && input.fromDuration > seconds
    ? Math.max(0, input.fromDuration - seconds)
    : 0
  const normalize = (index: number) =>
    `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},setsar=1,fps=${fps},` +
    `tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},` +
    `setpts=PTS-STARTPTS[v${index}]`
  const graph = [
    normalize(0),
    normalize(1),
    `[v0][v1]xfade=transition=${fadeStyleXfadeName(input.style)}:duration=${duration}:offset=0[v]`,
  ].join(';')
  const fromInput = fromSeek > 0 ? ['-ss', fromSeek.toFixed(3), '-i', input.fromPath] : ['-i', input.fromPath]
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...fromInput,
    '-t', duration, '-i', input.toPath,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex', graph,
    '-map', '[v]', '-map', '2:a',
    '-t', duration,
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
    '-shortest', '-movflags', '+faststart',
    input.outputPath,
  ]
}

export interface RenderFadeInput {
  fromPath: string
  toPath: string
  outputPath: string
  aspectRatio: string | null | undefined
  resolution: string | null | undefined
  durationMs: number
  style: FadeStyle
  fps?: number
}

/** 渲染转场片段；失败抛出带 stderr 尾部的可读错误 */
export async function renderFadeTransitionVideo(input: RenderFadeInput): Promise<void> {
  const bin = resolveFfmpegSuite().ffmpeg.path
  if (!bin) throw new Error('FFmpeg 不可用，无法渲染转场片段')
  if (!fs.existsSync(input.fromPath) || !fs.existsSync(input.toPath)) {
    throw new Error('转场渲染失败：相邻镜头视频不存在')
  }
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true })
  const { width, height } = transitionTextDimensions(input.aspectRatio, input.resolution)
  const fromDuration = await probeVideoDurationSeconds(input.fromPath)
  const args = buildFadeRenderArgs({
    fromPath: input.fromPath,
    toPath: input.toPath,
    fromDuration,
    outputPath: input.outputPath,
    width,
    height,
    durationMs: input.durationMs,
    style: input.style,
    fps: input.fps ?? 30,
  })
  await runBinary(bin, args, 180_000, '转场渲染')
}
