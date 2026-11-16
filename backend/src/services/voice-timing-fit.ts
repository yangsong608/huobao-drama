/** Voice Timing 的纯估算层：不依赖数据库，计划核心与测试都可直接使用。 */
import { DIALOGUE_CHARS_PER_SECOND, DIALOGUE_LINE_PAUSE_SECONDS, speechTextChars } from './dialogue-timing.js'

export interface VoiceTimingSample {
  chars: number
  durationSeconds: number
}

export interface VoiceTimingFit {
  charsPerSecond: number
  pauseSeconds: number
}

export interface VoiceTimingProfile extends VoiceTimingFit {
  speaker: string
  characterId: number | null
  voiceId: number | null
  sampleCount: number
  source: 'line_takes' | 'voice_samples'
}

const MIN_RATE = 3
const MAX_RATE = 12
const MIN_PAUSE = 0
const MAX_PAUSE = 1.5

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function usableSamples(samples: VoiceTimingSample[]): VoiceTimingSample[] {
  return samples.filter(sample => {
    if (!Number.isFinite(sample.chars) || !Number.isFinite(sample.durationSeconds)) return false
    if (sample.chars < 2 || sample.durationSeconds < 0.3 || sample.durationSeconds > 60) return false
    const rate = sample.chars / sample.durationSeconds
    return rate >= MIN_RATE && rate <= MAX_RATE
  })
}

/** 从真实样音/成品音拟合语速与停顿；样本不足或异常时返回 null。 */
export function fitVoiceTiming(samples: VoiceTimingSample[]): VoiceTimingFit | null {
  const usable = usableSamples(samples)
  if (!usable.length) return null

  if (usable.length === 1) {
    const sample = usable[0]
    const charsPerSecond = clamp(sample.chars / sample.durationSeconds, MIN_RATE, MAX_RATE)
    const pauseSeconds = clamp(sample.durationSeconds - sample.chars / charsPerSecond, MIN_PAUSE, MAX_PAUSE)
    return {
      charsPerSecond: Math.round(charsPerSecond * 100) / 100,
      pauseSeconds: Math.round(pauseSeconds * 100) / 100,
    }
  }

  const meanChars = usable.reduce((sum, sample) => sum + sample.chars, 0) / usable.length
  const meanDuration = usable.reduce((sum, sample) => sum + sample.durationSeconds, 0) / usable.length
  let covariance = 0
  let variance = 0
  for (const sample of usable) {
    const dx = sample.chars - meanChars
    covariance += dx * (sample.durationSeconds - meanDuration)
    variance += dx * dx
  }

  const secondsPerChar = variance > 0 ? covariance / variance : 0
  if (Number.isFinite(secondsPerChar) && secondsPerChar > 0) {
    const observedRate = 1 / secondsPerChar
    const pauseSeconds = clamp(meanDuration - secondsPerChar * meanChars, MIN_PAUSE, MAX_PAUSE)
    if (observedRate >= MIN_RATE && observedRate <= MAX_RATE) {
      return {
        charsPerSecond: Math.round(observedRate * 100) / 100,
        pauseSeconds: Math.round(pauseSeconds * 100) / 100,
      }
    }
  }

  const charsPerSecond = clamp(median(usable.map(sample => sample.chars / sample.durationSeconds)), MIN_RATE, MAX_RATE)
  const pauseSeconds = clamp(
    median(usable.map(sample => sample.durationSeconds - sample.chars / charsPerSecond)),
    MIN_PAUSE,
    MAX_PAUSE,
  )
  return {
    charsPerSecond: Math.round(charsPerSecond * 100) / 100,
    pauseSeconds: Math.round(pauseSeconds * 100) / 100,
  }
}

/** 计划期单句估算；没有档案时才回到全局默认语速。 */
export function estimateLineSeconds(
  text: string,
  profile?: Pick<VoiceTimingProfile, 'charsPerSecond' | 'pauseSeconds'> | null,
): number {
  const chars = speechTextChars(text)
  const charsPerSecond = profile?.charsPerSecond && profile.charsPerSecond > 0
    ? profile.charsPerSecond
    : DIALOGUE_CHARS_PER_SECOND
  const pauseSeconds = profile && Number.isFinite(profile.pauseSeconds)
    ? profile.pauseSeconds
    : DIALOGUE_LINE_PAUSE_SECONDS
  return Math.max(0.5, chars / charsPerSecond + pauseSeconds)
}