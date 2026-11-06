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
  /** 为空表示绝对锚点台词，必须提供 startOverrideMs */
  storyboardId: number | null
  lineNo?: number
  text: string
  speaker: string
  kind: CueKind
  /** 镜头内相对毫秒 */
  plannedStartMs?: number | null
  /** 整集绝对起点（毫秒）；设置后忽略 plannedStartMs 与顺序游标 */
  startOverrideMs?: number | null
  /** 占位时长（毫秒）；只影响结束时间与字幕，不裁剪音频 */
  durationOverrideMs?: number | null
  audioDurationMs: number
  audioUrl?: string | null
  /** 已应用的语速（>1 表示音频本就被加速过） */
  speed?: number
}

export interface TimelineCue {
  lineId: number
  shotId: number | null
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

export interface TimelineClipPosition {
  storyboardId: number
  startMs: number
  endMs: number
  durationMs: number
}

export interface TimelineResult {
  cues: TimelineCue[]
  clips: TimelineClipPosition[]
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

  const clipPositions: TimelineClipPosition[] = clips.map((clip) => {
    const span = clipStart.get(clip.storyboardId)!
    return {
      storyboardId: clip.storyboardId,
      startMs: span.startMs,
      endMs: span.endMs,
      durationMs: span.endMs - span.startMs,
    }
  })

  const order = new Map<number, number>()
  clips.forEach((c, i) => order.set(c.storyboardId, i))

  const lines = [...(input.lines || [])].sort((a, b) => {
    const oa = a.storyboardId == null ? Number.MAX_SAFE_INTEGER : order.get(a.storyboardId) ?? Number.MAX_SAFE_INTEGER
    const ob = b.storyboardId == null ? Number.MAX_SAFE_INTEGER : order.get(b.storyboardId) ?? Number.MAX_SAFE_INTEGER
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
    const shot = line.storyboardId == null ? undefined : clipStart.get(line.storyboardId)
    const planned = Number.isFinite(line.plannedStartMs) ? Math.max(0, Number(line.plannedStartMs)) : 0
    const overrideStart = Number.isFinite(line.startOverrideMs) ? Math.max(0, Number(line.startOverrideMs)) : null
    // 绝对锚点必须给 startOverrideMs；镜头内台词必须有对应镜头
    if (!shot && (line.storyboardId != null || overrideStart === null)) {
      skippedLineIds.push(line.lineId)
      continue
    }
    if (shot && totalDurationMs > 0 && shot.startMs >= totalDurationMs) {
      skippedLineIds.push(line.lineId)
      continue
    }

    let start: number
    if (overrideStart !== null) {
      start = overrideStart
    } else {
      const relStart = Math.max(MIN_LEAD_MS, planned, cursor - shot!.startMs)
      start = shot!.startMs + relStart
      if (start < shot!.startMs) start = shot!.startMs
    }
    // 只有手动绝对排布越过片尾才丢弃；自动排布保持旧行为（允许贴片尾）
    if (overrideStart !== null && totalDurationMs > 0 && start >= totalDurationMs) {
      skippedLineIds.push(line.lineId)
      continue
    }

    const overlap = start < cursor && cues.length > 0
    let speed = 1
    let duration = Math.max(MIN_LINE_MS, Math.round(line.audioDurationMs || 0))
    const durationOverride = Number.isFinite(line.durationOverrideMs) ? Math.max(0, Number(line.durationOverrideMs)) : null
    const toleratedEnd = (shot ? shot.endMs : totalDurationMs) + OVERFLOW_TOLERANCE_MS

    if (durationOverride && durationOverride > 0) {
      duration = Math.max(MIN_LINE_MS, Math.round(durationOverride))
    } else if (overrideStart === null && shot && start + duration > toleratedEnd && duration > 0) {
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
      const isLast = line === lines[lines.length - 1]
      if (isLast) {
        end = totalDurationMs
        trimmed = true
        trimmedCount += 1
      }
    }

    // 手动绝对排布可跨镜头，溢出按整集片尾计算；自动排布沿用镜头容差
    const overflowLimit = overrideStart !== null && totalDurationMs > 0
      ? totalDurationMs
      : shot ? shot.endMs + OVERFLOW_TOLERANCE_MS : totalDurationMs
    const overflowMs = Math.max(0, end - overflowLimit)
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

    cursor = Math.max(cursor, end + LINE_GAP_MS)
  }

  // 绝对锚点可能早于镜头台词，字幕与重叠判断按实际时间排序
  cues.sort((a, b) => a.startMs - b.startMs || a.lineId - b.lineId)

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

  return {
    cues,
    clips: clipPositions,
    totalDurationMs,
    maxOverflowMs,
    overlapCount,
    atempoCount,
    trimmedCount,
    skippedLineIds,
  }
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
