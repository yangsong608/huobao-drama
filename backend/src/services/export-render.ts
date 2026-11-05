/**
 * 导出渲染（设计 9.3/9.4）：视频封装、分轨、响度校正与空间估算。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ffmpeg } from '../utils/ffmpeg.js'
import { buildBurnFilter } from './audio-mix.js'
import { MIX_BUS_KEYS, type MixBusKey, type MixPlan } from './mix-plan.js'
import { renderMixAudio } from './mix-render.js'
import type { ExportKind, ExportPreset, ExportSubtitleMode } from './export-presets.js'

export class ExportCancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'ExportCancelledError'
  }
}

export interface RenderExportVideoInput {
  videoPath: string
  mixPath: string
  durationMs: number
  preset: ExportPreset
  subtitleMode: ExportSubtitleMode
  srtPath?: string | null
  assPath?: string | null
  outputPath: string
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

export interface RenderStemsHooks {
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

interface RunOptions {
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

function runFfmpeg(setup: (cmd: any) => void, options: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ExportCancelledError())
      return
    }
    const cmd = ffmpeg()
    setup(cmd)
    let aborted = false
    const onAbort = () => {
      aborted = true
      try {
        cmd.kill('SIGTERM')
      } catch { /* 进程尚未启动 */ }
    }
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    cmd.on('progress', (progress: { percent?: number }) => {
      const percent = Number(progress?.percent)
      if (Number.isFinite(percent)) options.onProgress?.(Math.max(0, Math.min(100, percent)))
    })
    cmd.on('end', () => {
      cleanup()
      resolve()
    })
    cmd.on('error', (error: Error, _stdout: unknown, stderr: unknown) => {
      cleanup()
      if (aborted || options.signal?.aborted) {
        reject(new ExportCancelledError())
        return
      }
      reject(new Error(`${error.message}${stderr ? `\n${String(stderr).slice(-1200)}` : ''}`))
    })
    try {
      cmd.run()
    } catch (error) {
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export async function renderExportVideo(input: RenderExportVideoInput): Promise<{ durationMs: number }> {
  const { preset } = input
  if (!preset.width || !preset.height) throw new Error('当前预设不支持视频导出')
  if (input.subtitleMode === 'soft' && !input.srtPath) throw new Error('缺少字幕文件')
  if (input.subtitleMode === 'burn' && !input.srtPath && !input.assPath) throw new Error('缺少字幕文件')

  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true })
  const durationSec = Math.max(1, input.durationMs / 1000)
  const scale = `scale=${preset.width}:${preset.height}:force_original_aspect_ratio=decrease,`
    + `pad=${preset.width}:${preset.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
  const burn = input.subtitleMode === 'burn' ? buildBurnFilter(input.srtPath, input.assPath) : null

  await runFfmpeg((cmd) => {
    cmd.input(input.videoPath)
    cmd.input(input.mixPath)
    if (input.subtitleMode === 'soft') cmd.input(input.srtPath!).inputOptions(['-f', 'srt'])
    cmd.videoFilters(burn ? `${scale},${burn}` : scale)
    const outputOptions = [
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'fast',
      '-b:v', `${preset.videoBitrateKbps ?? 10000}k`,
      '-maxrate', `${preset.maxrateKbps ?? 12000}k`,
      '-bufsize', `${preset.bufsizeKbps ?? 24000}k`,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', `${preset.audioBitrateKbps ?? 192}k`,
      '-ar', '48000', '-ac', '2',
      '-t', durationSec.toFixed(3),
      '-movflags', '+faststart',
    ]
    if (input.subtitleMode === 'soft') {
      outputOptions.push('-map', '2:s:0', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=chi')
    }
    cmd.outputOptions(outputOptions)
    cmd.output(input.outputPath)
  }, { signal: input.signal, onProgress: input.onProgress })

  return { durationMs: Math.round(durationSec * 1000) }
}

export function stemBusKeys(plan: MixPlan): MixBusKey[] {
  return MIX_BUS_KEYS.filter((bus) => bus !== 'master' && plan.tracks.some((track) =>
    track.busId === bus
    && !track.effectiveMuted
    && track.clips.some((clip) => clip.usable && !clip.muted && clip.audioUrl),
  ))
}

export async function renderBusStems(
  plan: MixPlan,
  dir: string,
  hooks: RenderStemsHooks = {},
): Promise<{ bus: MixBusKey; file: string }[]> {
  const buses = stemBusKeys(plan)
  if (!buses.length) throw new Error('没有可导出的分轨')
  fs.mkdirSync(dir, { recursive: true })
  const results: { bus: MixBusKey; file: string }[] = []
  for (const [index, bus] of buses.entries()) {
    const file = path.join(dir, `${bus}.wav`)
    await renderMixAudio(plan, {
      outputPath: file,
      format: 'wav',
      codec: 'pcm_s24le',
      onlyBus: bus,
      signal: hooks.signal,
      onProgress: (percent) => {
        hooks.onProgress?.(((index + percent / 100) / buses.length) * 100)
      },
    })
    results.push({ bus, file })
  }
  return results
}

function limiterLinear(truePeak: number): number {
  return Number(Math.pow(10, truePeak / 20).toFixed(4))
}

export async function correctLoudness(file: string, deltaDb: number, truePeak: number): Promise<void> {
  if (!Number.isFinite(deltaDb) || Math.abs(deltaDb) < 0.1) return
  const temp = `${file}.loudness-${Date.now()}.wav`
  try {
    await runFfmpeg((cmd) => {
      cmd.input(file)
      cmd.audioFilters(`volume=${deltaDb.toFixed(2)}dB,alimiter=limit=${limiterLinear(truePeak)}:level=false`)
      cmd.outputOptions(['-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2'])
      cmd.output(temp)
    })
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

export function estimateExportBytes(kind: ExportKind, durationMs: number, preset: ExportPreset): number {
  const seconds = Math.max(1, durationMs / 1000)
  if (kind === 'video') {
    const kbps = (preset.videoBitrateKbps ?? 10000) + (preset.audioBitrateKbps ?? 192)
    return Math.round((seconds * kbps * 1000) / 8 * 1.1)
  }
  const pcm = seconds * 48000 * 3 * 2
  if (kind === 'stems') return Math.round(pcm * 4 * 1.05) + 8192
  return Math.round(pcm * 1.05) + 4096
}
