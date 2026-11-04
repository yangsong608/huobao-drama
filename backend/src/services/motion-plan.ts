/**
 * 图文动画的纯计算部分（V2 · M4-1）
 *
 * 只做时长估算、景别→运动选择、zoompan/xfade 参数拼装，便于单测；
 * 实际 ffmpeg 执行留在 motion-post.ts。
 */

export const MIN_SHOT_MS = 2500
export const MAX_SHOT_MS = 8000
export const TRANSITION_MS = 500
export const CHARS_PER_SECOND = 4.5

export type ShotMotion = 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right'

export function estimateShotDurationMs(text: string | null | undefined, audioDurationMs?: number | null): number {
  const audio = Math.max(0, Math.round(Number(audioDurationMs) || 0))
  const raw = audio > 0
    ? audio + 600
    : Math.round(([...(text || '')].length / CHARS_PER_SECOND) * 1000)
  return Math.min(MAX_SHOT_MS, Math.max(MIN_SHOT_MS, raw || MIN_SHOT_MS))
}

/** 特写/近景拉近；全景/远景拉远或横移；其余按镜号交替推拉 */
export function pickShotMotion(shotType: string | null | undefined, index: number): ShotMotion {
  const value = String(shotType || '').toLowerCase()
  if (/特写|近景|close/.test(value)) return 'zoom_in'
  if (/全景|远景|wide|long/.test(value)) {
    const cycle = index % 3
    if (cycle === 0) return 'zoom_out'
    return cycle === 1 ? 'pan_left' : 'pan_right'
  }
  return index % 2 === 0 ? 'zoom_in' : 'zoom_out'
}

/** 缩放从 1.0 到 1.12 匀速；横移保持 1.12 倍并扫过整幅画面 */
export function buildZoompanFilter(motion: ShotMotion, width: number, height: number, frames: number, fps = 24): string {
  const total = Math.max(1, Math.round(frames))
  const step = (0.12 / total).toFixed(6)
  const center = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
  const scale = `d=${total}:s=${width}x${height}:fps=${fps}`
  if (motion === 'zoom_out') return `zoompan=z='max(1.12-${step}*on,1)':${center}:${scale}`
  if (motion === 'pan_left') return `zoompan=z='1.12':x='(iw-iw/zoom)*(1-on/${total})':y='ih/2-(ih/zoom/2)':${scale}`
  if (motion === 'pan_right') return `zoompan=z='1.12':x='(iw-iw/zoom)*on/${total}':y='ih/2-(ih/zoom/2)':${scale}`
  return `zoompan=z='min(1+${step}*on,1.12)':${center}:${scale}`
}

export interface XfadePlan {
  /** 成片时长（不含转场重叠） */
  totalMs: number
  /** 每段渲染时长：镜头时长 + 0.5s 转场尾巴 */
  renderDurationsMs: number[]
  transitionMs: number
  /** 滤镜图，输出标签 [vout] */
  graph: string
}

export function buildXfadePlan(shotDurationsMs: number[], transitionMs = TRANSITION_MS): XfadePlan {
  const durations = shotDurationsMs.map((d) => Math.max(1, Math.round(d)))
  if (!durations.length) throw new Error('图文动画至少需要一个镜头')
  const totalMs = durations.reduce((sum, d) => sum + d, 0)
  if (durations.length === 1) {
    return { totalMs, renderDurationsMs: [...durations], transitionMs, graph: '[0:v]null[vout]' }
  }
  const transitionSec = (transitionMs / 1000).toFixed(3)
  const renderDurationsMs = durations.map((d) => d + transitionMs)
  let cumulativeMs = 0
  let last = '[0:v]'
  const parts: string[] = []
  for (let i = 1; i < durations.length; i += 1) {
    cumulativeMs += durations[i - 1]
    const output = i === durations.length - 1 ? '[vout]' : `[v${i}]`
    parts.push(
      `${last}[${i}:v]xfade=transition=fade:duration=${transitionSec}:offset=${(cumulativeMs / 1000).toFixed(3)}${output}`,
    )
    last = output
  }
  return { totalMs, renderDurationsMs, transitionMs, graph: parts.join(';') }
}

/** 无配音时 BGM 循环到片长、按给定音量、片尾 2s 淡出 */
export function buildBgmOnlyFilter(volume: number, durationSec: number): string {
  const start = Math.max(0, durationSec - 2).toFixed(3)
  return `volume=${volume},afade=t=out:st=${start}:d=2`
}
