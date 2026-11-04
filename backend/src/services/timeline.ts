/**
 * 绝对时间轴（V2 · 6.4）
 *
 * 设计要点：
 * - 镜头时长由视频模型决定，必须先合片、逐段 ffprobe，再建整集绝对时间轴；
 * - `planned_start_ms` 是**镜头内相对时间**，必须先加 shotStart，不能直接与整集 cursor 比较；
 * - 超长先 atempo（≤1.12），仍超只记录 overflow，不截断（允许跨镜延续）；
 * - 字幕结束时间夹到「下一句开始前 100ms」与「本句音频结束」的较早者。
 */

export const MIN_LEAD_MS = 250
export const LINE_GAP_MS = 180
export const MAX_ATEMPO = 1.12
export const OVERFLOW_TOLERANCE_MS = 1500
export const MIN_LINE_MS = 300
export const SUBTITLE_TAIL_GAP_MS = 100

export interface TimelineClip {
  storyboardId: number
  storyboardNumber?: number
  durationMs: number
}

export type CueKind = 'dialogue' | 'narration' | 'inner'

export interface TimelineLine {
  lineId: number
  storyboardId: number
  lineNo?: number
  text: string
  speaker: string
  kind: CueKind
  /** 镜头内相对毫秒 */
  plannedStartMs?: number | null
  audioDurationMs: number
  audioUrl?: string | null
  /** 已应用的语速（>1 表示音频本就被加速过） */
  speed?: number
}

export interface TimelineCue {
  lineId: number
  shotId: number
  startMs: number
  endMs: number
  subtitleStartMs: number
  subtitleEndMs: number
  text: string
  speaker: string
  kind: CueKind
  /** 实际建议的 atempo（1 表示不变速） */
  speed: number
  overflowMs: number
  overlap: boolean
  trimmed: boolean
  audioDurationMs: number
  audioUrl: string | null
}

export interface TimelineResult {
  cues: TimelineCue[]
  totalDurationMs: number
  maxOverflowMs: number
  overlapCount: number
  atempoCount: number
  trimmedCount: number
  skippedLineIds: number[]
}

export interface BuildTimelineInput {
  clips: TimelineClip[]
  lines: TimelineLine[]
  /** 视频总时长；不传则用 clips 之和 */
  totalDurationMs?: number
}

/**
 * 纯函数：输入逐段真实时长与台词，输出整集绝对时间轴。
 * 不做 IO，便于单测。
 */
export function buildTimeline(input: BuildTimelineInput): TimelineResult {
  const clips = [...(input.clips || [])].sort(
    (a, b) => (a.storyboardNumber ?? a.storyboardId) - (b.storyboardNumber ?? b.storyboardId),
  )
  const clipStart = new Map<number, { startMs: number; endMs: number }>()
  let cursorMs = 0
  for (const clip of clips) {
    const duration = Math.max(0, Math.round(clip.durationMs || 0))
    clipStart.set(clip.storyboardId, { startMs: cursorMs, endMs: cursorMs + duration })
    cursorMs += duration
  }
  const totalDurationMs = Math.max(0, Math.round(input.totalDurationMs ?? cursorMs))

  const order = new Map<number, number>()
  clips.forEach((c, i) => order.set(c.storyboardId, i))

  const lines = [...(input.lines || [])].sort((a, b) => {
    const oa = order.get(a.storyboardId) ?? Number.MAX_SAFE_INTEGER
    const ob = order.get(b.storyboardId) ?? Number.MAX_SAFE_INTEGER
    if (oa !== ob) return oa - ob
    return (a.lineNo ?? a.lineId) - (b.lineNo ?? b.lineId)
  })

  const cues: TimelineCue[] = []
  const skippedLineIds: number[] = []
  let cursor = 0
  let maxOverflowMs = 0
  let overlapCount = 0
  let atempoCount = 0
  let trimmedCount = 0

  for (const line of lines) {
    const shot = clipStart.get(line.storyboardId)
    if (!shot) {
      skippedLineIds.push(line.lineId)
      continue
    }
    if (totalDurationMs > 0 && shot.startMs >= totalDurationMs) {
      skippedLineIds.push(line.lineId)
      continue
    }

    const planned = Number.isFinite(line.plannedStartMs) ? Math.max(0, Number(line.plannedStartMs)) : 0
    const relStart = Math.max(MIN_LEAD_MS, planned, cursor - shot.startMs)
    let start = shot.startMs + relStart
    if (start < shot.startMs) start = shot.startMs

    const overlap = start < cursor && cues.length > 0
    let speed = 1
    let duration = Math.max(MIN_LINE_MS, Math.round(line.audioDurationMs || 0))
    const toleratedEnd = shot.endMs + OVERFLOW_TOLERANCE_MS

    if (start + duration > toleratedEnd && duration > 0) {
      const available = Math.max(MIN_LINE_MS, toleratedEnd - start)
      const needed = duration / available
      if (needed > 1.001) {
        speed = Math.min(MAX_ATEMPO, needed)
        duration = Math.round(duration / speed)
        if (speed > 1.001) atempoCount += 1
      }
    }

    let end = start + duration
    let trimmed = false

    // 只有整集最后一句超出片尾才裁切（设计 L4）
    if (totalDurationMs > 0 && end > totalDurationMs) {
      const isLast = cues.length === lines.length - 1
      if (isLast) {
        end = totalDurationMs
        trimmed = true
        trimmedCount += 1
      }
    }

    const overflowMs = Math.max(0, end - (shot.endMs + OVERFLOW_TOLERANCE_MS))
    if (overflowMs > maxOverflowMs) maxOverflowMs = overflowMs
    if (overlap) overlapCount += 1

    cues.push({
      lineId: line.lineId,
      shotId: line.storyboardId,
      startMs: Math.round(start),
      endMs: Math.round(end),
      subtitleStartMs: Math.round(start),
      subtitleEndMs: Math.round(end),
      text: line.text,
      speaker: line.speaker,
      kind: line.kind,
      speed: Number(speed.toFixed(3)),
      overflowMs: Math.round(overflowMs),
      overlap,
      trimmed,
      audioDurationMs: Math.round(line.audioDurationMs),
      audioUrl: line.audioUrl ?? null,
    })

    cursor = end + LINE_GAP_MS
  }

  // 字幕结束时间：不越过下一句开始前 100ms，也不越过片尾
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]
    const next = cues[i + 1]
    let subtitleEnd = cue.endMs
    if (next && next.startMs - SUBTITLE_TAIL_GAP_MS < subtitleEnd) {
      subtitleEnd = Math.max(cue.subtitleStartMs + 200, next.startMs - SUBTITLE_TAIL_GAP_MS)
    }
    if (totalDurationMs > 0 && subtitleEnd > totalDurationMs) subtitleEnd = totalDurationMs
    cue.subtitleEndMs = Math.round(Math.min(subtitleEnd, cue.endMs))
  }

  return { cues, totalDurationMs, maxOverflowMs, overlapCount, atempoCount, trimmedCount, skippedLineIds }
}

/** 字幕结束时间兜底：极端情况下（下一句紧贴）保证不出现负时长 */
export function normalizeCue(cue: TimelineCue): TimelineCue {
  if (cue.subtitleEndMs <= cue.subtitleStartMs) {
    return { ...cue, subtitleEndMs: cue.subtitleStartMs + Math.max(400, cue.endMs - cue.startMs) }
  }
  return cue
}

/**
 * 合片时长与逐段探测之和不一致时（合片是旧版本、或部分镜头被替换），
 * 按比例缩放每段时长，保证时间轴不越出成片。差 <2% 视为正常抖动，不缩放。
 */
export function scaleClipsToDuration(clips: TimelineClip[], targetDurationMs: number): { clips: TimelineClip[]; scaled: boolean; ratio: number } {
  const sum = clips.reduce((n, c) => n + Math.max(0, c.durationMs), 0)
  if (sum <= 0 || targetDurationMs <= 0) return { clips, scaled: false, ratio: 1 }
  const ratio = targetDurationMs / sum
  if (Math.abs(ratio - 1) < 0.02) return { clips, scaled: false, ratio }
  return {
    clips: clips.map((c) => ({ ...c, durationMs: Math.round(c.durationMs * ratio) })),
    scaled: true,
    ratio,
  }
}
