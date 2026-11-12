/**
 * 成片音轨快速体检：只判断「有没有声音、台词窗口是否整段静音」。
 * 不做语音识别，不评价音色与表演；口型/字幕/道具由抽帧视觉验收负责。
 */
import { spawn } from 'node:child_process'
import { resolveFfmpegSuite } from '../utils/ffmpeg.js'
import { getAbsolutePath } from '../utils/storage.js'

export interface SpeechWindow {
  startMs: number
  endMs: number
  speaker: string
  text: string
}

export interface AudioSilenceWindow {
  startMs: number
  endMs: number
}

export interface VideoAudioAnalysis {
  hasAudio: boolean
  meanVolumeDb: number | null
  maxVolumeDb: number | null
  silenceWindows: AudioSilenceWindow[]
  speechWindows: Array<SpeechWindow & { silentRatio: number }>
  allSpeechSilent: boolean
  error: string | null
}

function runFfmpegStderr(args: string[]): Promise<string> {
  const binary = resolveFfmpegSuite().ffmpeg.path
  if (!binary) return Promise.reject(new Error('FFmpeg 不可用，无法分析音轨'))
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', () => resolve(stderr))
  })
}

function parseDb(raw: string | undefined): number | null {
  const value = Number(String(raw || '').trim())
  return Number.isFinite(value) ? value : null
}

function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

export async function analyzeVideoAudio(
  videoUrl: string,
  speechWindows: SpeechWindow[] = [],
): Promise<VideoAudioAnalysis> {
  const empty: VideoAudioAnalysis = {
    hasAudio: false,
    meanVolumeDb: null,
    maxVolumeDb: null,
    silenceWindows: [],
    speechWindows: [],
    allSpeechSilent: false,
    error: null,
  }
  if (!videoUrl) return { ...empty, error: '没有视频地址' }
  let stderr = ''
  try {
    stderr = await runFfmpegStderr([
      '-hide_banner',
      '-nostats',
      '-i', getAbsolutePath(videoUrl),
      '-map', '0:a:0',
      '-af', 'volumedetect,silencedetect=noise=-35dB:d=0.6',
      '-f', 'null',
      '-',
    ])
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) }
  }
  if (/Stream map '0:a:0' matches no streams|Could not find audio stream|Output file does not contain any stream/i.test(stderr)) {
    return empty
  }
  const meanVolumeDb = parseDb(stderr.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/i)?.[1])
  const maxVolumeDb = parseDb(stderr.match(/max_volume:\s*(-?[\d.]+|-inf)\s*dB/i)?.[1])
  const silenceWindows: AudioSilenceWindow[] = []
  let silenceStart: number | null = null
  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/)
    if (startMatch) {
      silenceStart = Math.max(0, Number(startMatch[1]) * 1000)
      continue
    }
    const endMatch = line.match(/silence_end:\s*(-?[\d.]+)/)
    if (endMatch && silenceStart != null) {
      const end = Math.max(silenceStart, Number(endMatch[1]) * 1000)
      silenceWindows.push({ startMs: silenceStart, endMs: end })
      silenceStart = null
    }
  }
  if (silenceStart != null) {
    const tail = stderr.match(/silence_duration:\s*(-?[\d.]+)/g)?.pop()
    const duration = Number(tail?.match(/(-?[\d.]+)/)?.[1] || 0)
    silenceWindows.push({ startMs: silenceStart, endMs: silenceStart + duration * 1000 })
  }
  const windows = speechWindows
    .filter(window => window.endMs > window.startMs)
    .map(window => {
      const duration = window.endMs - window.startMs
      const silent = silenceWindows.reduce((sum, silence) => (
        sum + overlapMs(window.startMs, window.endMs, silence.startMs, silence.endMs)
      ), 0)
      return { ...window, silentRatio: duration > 0 ? Math.min(1, silent / duration) : 0 }
    })
  const allSpeechSilent = windows.length > 0 && windows.every(window => window.silentRatio >= 0.8)
  return {
    hasAudio: true,
    meanVolumeDb,
    maxVolumeDb,
    silenceWindows,
    speechWindows: windows,
    allSpeechSilent,
    error: null,
  }
}

export function formatAudioAnalysis(audio: VideoAudioAnalysis, hasDialogue: boolean): string {
  if (!audio.hasAudio) {
    if (audio.error) return `音轨分析失败：${audio.error}`
    return hasDialogue ? '成片没有音轨，但有台词' : '成片没有音轨'
  }
  const volume = [
    audio.meanVolumeDb != null ? `平均 ${audio.meanVolumeDb.toFixed(1)} dB` : '',
    audio.maxVolumeDb != null ? `峰值 ${audio.maxVolumeDb.toFixed(1)} dB` : '',
  ].filter(Boolean).join('，')
  if (!hasDialogue) return `有音轨${volume ? `（${volume}）` : ''}；本镜无台词`
  const silent = audio.speechWindows.filter(window => window.silentRatio >= 0.8)
  if (silent.length) {
    return `台词窗口有 ${silent.length}/${audio.speechWindows.length} 段接近静音${volume ? `（${volume}）` : ''}`
  }
  return `台词窗口有声音${volume ? `（${volume}）` : ''}`
}
