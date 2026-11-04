/**
 * 成片拼接的纯计算部分：按分镜 transition 生成 xfade/acrossfade/concat 滤镜图。
 * 实际 ffmpeg 执行留在 ffmpeg-merge.ts，便于单测转场时长与 offset。
 */
import { createHash } from 'node:crypto'

export type MergeTransition = 'cut' | 'fade' | 'dissolve' | 'wipe'

export interface MergeClipPlan {
  durationMs: number
  /** 该镜头相对上一镜的转场方式 */
  transition?: string | null
  /** 显式指定该片段相对上一片的转场时长；用于过渡片段两端 */
  transitionMs?: number | null
}

const TRANSITION_STYLES: Record<string, string> = {
  fade: 'fade',
  dissolve: 'dissolve',
  wipe: 'wipeleft',
}

/** 最短转场：低于该值时退化为硬切，避免 xfade 时长为 0 或吞掉整段画面 */
export const MIN_TRANSITION_MS = 120
export const MAX_TRANSITION_MS = 500

export function mergeTransitionStyle(value: unknown): string | null {
  return TRANSITION_STYLES[String(value ?? 'cut').toLowerCase()] || null
}

export function mergeTransitionDurationMs(previousMs: number, currentMs: number): number {
  const raw = Math.round(Math.min(previousMs, currentMs) * 0.2)
  return Math.min(MAX_TRANSITION_MS, Math.max(MIN_TRANSITION_MS, raw))
}

/**
 * 输入按镜头顺序排列；第 i 个剪辑的 transition 表示「从第 i-1 镜进入第 i 镜」。
 * 输出统一分辨率/帧率/音频格式，混合使用 concat（硬切）与 xfade + acrossfade（转场）。
 */
export function buildMergeTransitionGraph(clips: MergeClipPlan[], width: number, height: number) {
  if (!clips.length) throw new Error('至少需要一个镜头')
  const w = Math.max(2, Math.round(width) & ~1)
  const h = Math.max(2, Math.round(height) & ~1)
  const durations = clips.map(clip => Math.max(1, Math.round(Number(clip.durationMs) || 0)))

  const parts: string[] = []
  clips.forEach((_clip, i) => {
    parts.push(
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`,
    )
    parts.push(
      `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`,
    )
  })

  let lastV = 'v0'
  let lastA = 'a0'
  let totalMs = durations[0]
  const usedTransitions: { index: number; kind: string; durationMs: number; offsetMs: number }[] = []

  for (let i = 1; i < clips.length; i += 1) {
    const outV = `v${i}x`
    const outA = `a${i}x`
    const style = mergeTransitionStyle(clips[i].transition)
    const explicitMs = Number(clips[i].transitionMs)
    const hasExplicit = Number.isFinite(explicitMs) && explicitMs > 0
    const rawDurationMs = Math.round(Math.min(durations[i - 1], durations[i]) * 0.2)
    const durationMs = hasExplicit
      ? Math.min(MAX_TRANSITION_MS, Math.max(MIN_TRANSITION_MS, Math.round(explicitMs)))
      : style ? mergeTransitionDurationMs(durations[i - 1], durations[i]) : 0
    const explicitInvalid = hasExplicit
      && (Math.round(explicitMs) < MIN_TRANSITION_MS || Math.round(explicitMs) > Math.min(durations[i - 1], durations[i]) / 2)
    const useCut = !style || explicitInvalid || (!hasExplicit && rawDurationMs < MIN_TRANSITION_MS)

    if (useCut) {
      parts.push(`[${lastV}][v${i}]concat=n=2:v=1:a=0[${outV}]`)
      parts.push(`[${lastA}][a${i}]concat=n=2:v=0:a=1[${outA}]`)
      totalMs += durations[i]
    } else {
      const durationSec = (durationMs / 1000).toFixed(3)
      const offsetMs = totalMs - durationMs
      parts.push(`[${lastV}][v${i}]xfade=transition=${style}:duration=${durationSec}:offset=${(offsetMs / 1000).toFixed(3)}[${outV}]`)
      parts.push(`[${lastA}][a${i}]acrossfade=d=${durationSec}:c1=tri:c2=tri[${outA}]`)
      usedTransitions.push({ index: i, kind: style, durationMs, offsetMs })
      totalMs += durations[i] - durationMs
    }

    lastV = outV
    lastA = outA
  }

  parts.push(`[${lastA}]loudnorm=I=-16.5:TP=-3.0:LRA=11[aout]`)
  parts.push(`[${lastV}]null[vout]`)

  return { graph: parts.join(';'), totalMs, usedTransitions }
}

/** 合片缓存键：镜头顺序/地址/转场时长 + 音频模式；任一变化都必须重新合片。 */
export function computeMergeSourceHash(
  clips: { url: string; transition?: string | null; transitionMs?: number | null }[],
  audioMode: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      audioMode,
      clips: clips.map((clip) => [clip.url, clip.transition || 'cut', clip.transitionMs ?? null]),
    }))
    .digest('hex')
}
