/**
 * 导出校验（设计 9.6）：流完整性、时长、字幕流与响度告警。
 * 结构性问题进入 errors（不设当前成片），响度偏差只记 warnings。
 */
import { spawn } from 'node:child_process'
import { ffmpeg, resolveFfmpegSuite } from '../utils/ffmpeg.js'
import type { ExportKind } from './export-presets.js'

export interface MediaProbe {
  durationMs: number
  sizeBytes: number
  video: { codec: string; width: number; height: number } | null
  audio: { codec: string; sampleRate: number; channels: number } | null
  subtitleStreams: number
}

export interface LoudnessReport {
  lufs: number
  truePeak: number
  lra: number
}

export interface ExportExpectation {
  kind: ExportKind
  durationMs?: number
  width?: number
  height?: number
  requireSubtitleStream?: boolean
  targetLufs?: number
  maxTruePeak?: number
}

export interface ExportValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  probe: MediaProbe | null
  loudness: LoudnessReport | null
}

export function probeMedia(file: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (error, metadata: any) => {
      if (error) {
        reject(new Error(`无法解析导出文件：${error.message}`))
        return
      }
      const streams: any[] = metadata?.streams || []
      const video = streams.find((stream) => stream.codec_type === 'video')
      const audio = streams.find((stream) => stream.codec_type === 'audio')
      const duration = Number(metadata?.format?.duration)
      const size = Number(metadata?.format?.size)
      resolve({
        durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : 0,
        sizeBytes: Number.isFinite(size) && size > 0 ? size : 0,
        video: video
          ? {
              codec: String(video.codec_name || ''),
              width: Number(video.width) || 0,
              height: Number(video.height) || 0,
            }
          : null,
        audio: audio
          ? {
              codec: String(audio.codec_name || ''),
              sampleRate: Number(audio.sample_rate) || 0,
              channels: Number(audio.channels) || 0,
            }
          : null,
        subtitleStreams: streams.filter((stream) => stream.codec_type === 'subtitle').length,
      })
    })
  })
}

function parseLoudnessNumber(raw: unknown): number {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text.includes('-inf')) return -Infinity
  const value = Number(text)
  return Number.isFinite(value) ? value : 0
}

export interface ValidationOptions {
  signal?: AbortSignal
  /** 分轨逐条测量代价高，导出侧可按需关闭 */
  measureLoudness?: boolean
}

export function measureLoudness(file: string, options: ValidationOptions = {}): Promise<LoudnessReport> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('已取消'))
      return
    }
    const binary = resolveFfmpegSuite().ffmpeg.path || 'ffmpeg'
    const args = [
      '-hide_banner', '-nostats', '-i', file,
      '-af', 'loudnorm=I=-16:TP=-1.5:print_format=json',
      '-f', 'null', '-',
    ]
    let stderr = ''
    let child
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const onAbort = () => {
      try { child.kill('SIGTERM') } catch { /* 进程已退出 */ }
      reject(new Error('已取消'))
    }
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000)
    })
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      cleanup()
      if (code !== 0) {
        reject(new Error(`响度测量失败（ffmpeg ${code}）：${stderr.slice(-300)}`))
        return
      }
      const matches = [...stderr.matchAll(/\{[^{}]*"input_i"[^{}]*\}/g)]
      const block = matches.pop()?.[0]
      if (!block) {
        reject(new Error('未解析到 loudnorm 输出'))
        return
      }
      try {
        const parsed = JSON.parse(block)
        resolve({
          lufs: parseLoudnessNumber(parsed.input_i),
          truePeak: parseLoudnessNumber(parsed.input_tp),
          lra: parseLoudnessNumber(parsed.input_lra),
        })
      } catch {
        reject(new Error('loudnorm 输出不是有效 JSON'))
      }
    })
  })
}

export async function validateExport(
  file: string,
  expected: ExportExpectation,
  options: ValidationOptions = {},
): Promise<ExportValidation> {
  const errors: string[] = []
  const warnings: string[] = []

  let probe: MediaProbe
  try {
    probe = await probeMedia(file)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    return { ok: false, errors, warnings, probe: null, loudness: null }
  }

  if (probe.sizeBytes <= 0) errors.push('导出文件为空')

  if (expected.kind === 'video') {
    if (!probe.video) {
      errors.push('缺少视频流')
    } else {
      if (expected.width && probe.video.width !== expected.width) {
        errors.push(`视频宽度不符：实际 ${probe.video.width}，期望 ${expected.width}`)
      }
      if (expected.height && probe.video.height !== expected.height) {
        errors.push(`视频高度不符：实际 ${probe.video.height}，期望 ${expected.height}`)
      }
    }
  }

  if (!probe.audio) {
    errors.push('缺少音频流')
  } else {
    if (probe.audio.sampleRate !== 48000) {
      errors.push(`音频采样率应为 48000，实际 ${probe.audio.sampleRate}`)
    }
    if (probe.audio.channels !== 2) {
      errors.push(`音频声道数应为 2，实际 ${probe.audio.channels}`)
    }
  }

  if (expected.requireSubtitleStream && probe.subtitleStreams === 0) {
    errors.push('缺少字幕流')
  }

  if (expected.durationMs != null) {
    const diff = Math.abs(probe.durationMs - expected.durationMs)
    if (diff > 100) {
      errors.push(`时长偏差 ${diff}ms 超过 100ms（期望 ${expected.durationMs}ms，实际 ${probe.durationMs}ms）`)
    }
  }

  let loudness: LoudnessReport | null = null
  if (options.measureLoudness !== false) {
    try {
      loudness = await measureLoudness(file, options)
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error))
    }
  }

  if (loudness) {
    if (expected.targetLufs != null && Math.abs(loudness.lufs - expected.targetLufs) > 0.5) {
      warnings.push(`响度 ${loudness.lufs.toFixed(2)} LUFS 偏离目标 ${expected.targetLufs} LUFS 超过 ±0.5 LU`)
    }
    if (expected.maxTruePeak != null && loudness.truePeak > expected.maxTruePeak) {
      warnings.push(`真实峰值 ${loudness.truePeak.toFixed(2)} dBTP 超过 ${expected.maxTruePeak} dBTP`)
    }
  }

  return { ok: errors.length === 0, errors, warnings, probe, loudness }
}
