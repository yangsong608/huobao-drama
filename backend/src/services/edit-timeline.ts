/**
 * 台词放置与字幕建议纯函数（技术架构设计 §6.5、S2 计划 Task 2）：
 * EditPlan 主轨 → 台词时间轴 → 跟随字幕建议，供初剪、混音与字幕导出共用。
 * 本文件不得 import DB / FFmpeg / 路由 / 文件系统 / 时钟，便于测试与后续前端类型共享。
 */
import {
  computeLayout,
  type DialoguePlacement,
  type EditPlanV1,
  type EditSubtitleCue,
} from './edit-plan.js'

export const MIN_LEAD_MS = 250
export const LINE_GAP_MS = 180
export const MIN_LINE_MS = 300
export const SUBTITLE_TAIL_GAP_MS = 100
export const SUBTITLE_MAX_CHARS = 40
export const SUBTITLE_MIN_MS = 800
/** 无配音/时长时的文本估算：每字符 220ms，至少 MIN_LINE_MS。 */
const CHAR_MS = 220
/** 片段过短时收缩句首留白，仍保留至少 500ms 给画面。 */
const LEAD_RESERVE_MS = 500

export interface EditLineRow {
  id: number
  storyboardId: number | null
  lineNo: number
  sortOrder: number | null
  text: string
  subtitleText: string | null
  speakerName: string | null
  speakerType: string
  voiceId: number | null
  voiceStartMs: number | null
  voiceDurationMs: number | null
  audioUrl: string | null
  audioDurationMs: number | null
  activeTakeId: number | null
  anchorType: string | null
}

export interface EditTakeRow {
  id: number
  lineId: number
  audioUrl: string | null
  durationMs: number | null
  hash: string | null
  isActive: boolean
}

export interface EditLinePlacement {
  lineId: number
  clipId: string
  storyboardId: number | null
  startMs: number
  endMs: number
  durationMs: number
  text: string
  subtitleText: string | null
  speakerName: string | null
  voiceTakeId: number | null
  audioUrl: string | null
  audioFingerprint: string | null
  overflowsClip: boolean
  overflowMs: number
  anchorType: 'shot' | 'absolute'
  warnings: string[]
}

export interface UnmappedLine {
  lineId: number
  text: string
  reason: 'no_clip' | 'absolute_unmapped'
}

export interface EditAudioSegment {
  clipId: string
  sourceUrl: string
  sourceInMs: number
  sourceOutMs: number
  speed: number
  timelineStartMs: number
  timelineEndMs: number
  hasAudio: boolean
}

export interface EditTimelineResult {
  durationMs: number
  linePlacements: EditLinePlacement[]
  audioSegments: EditAudioSegment[]
  unmappedLines: UnmappedLine[]
}

export interface MergeSuggestedSubtitlesResult {
  cues: EditSubtitleCue[]
  added: number
  updated: number
}

function estimateDuration(text: string): number {
  return Math.max(MIN_LINE_MS, Array.from(text).length * CHAR_MS)
}

/** 生效配音 Take：指定 activeTakeId > isActive 标记 > 最大 id；都没有则返回 null。 */
function activeTakeOf(line: EditLineRow, takesByLine: Map<number, EditTakeRow[]>): EditTakeRow | null {
  const list = takesByLine.get(line.id) ?? []
  return list.find((take) => take.id === line.activeTakeId)
    ?? list.find((take) => take.isActive)
    ?? [...list].sort((a, b) => b.id - a.id)[0]
    ?? null
}

/** 台词时长：Take > voiceDurationMs > audioDurationMs > 文本估算，且不短于 MIN_LINE_MS。 */
function lineDurationMs(line: EditLineRow, take: EditTakeRow | null): number {
  return Math.max(
    MIN_LINE_MS,
    Math.round(
      take?.durationMs
      ?? line.voiceDurationMs
      ?? line.audioDurationMs
      ?? estimateDuration(line.text),
    ),
  )
}

function placementOf(input: {
  line: EditLineRow
  clipId: string
  storyboardId: number | null
  startMs: number
  endMs: number
  clipEndMs: number | null
  take: EditTakeRow | null
  anchorType: 'shot' | 'absolute'
}): EditLinePlacement {
  const { line, take } = input
  const durationMs = lineDurationMs(line, take)
  const startMs = Math.round(input.startMs)
  const endMs = Math.round(input.endMs)
  const overflowMs = input.clipEndMs === null ? 0 : Math.max(0, endMs - input.clipEndMs)
  return {
    lineId: line.id,
    clipId: input.clipId,
    storyboardId: input.storyboardId,
    startMs,
    endMs,
    durationMs,
    text: line.text,
    subtitleText: line.subtitleText,
    speakerName: line.speakerName,
    voiceTakeId: take?.id ?? null,
    audioUrl: take?.audioUrl ?? line.audioUrl,
    audioFingerprint: take?.hash ?? null,
    overflowsClip: overflowMs > 0,
    overflowMs,
    anchorType: input.anchorType,
    warnings: overflowMs > 0 ? ['LINE_OVERFLOW'] : [],
  }
}

function cueSort(a: EditSubtitleCue, b: EditSubtitleCue): number {
  return a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id)
}

function cloneCue(cue: EditSubtitleCue): EditSubtitleCue {
  return {
    ...cue,
    anchor: cue.anchor ? { ...cue.anchor } : cue.anchor,
    warnings: cue.warnings ? [...cue.warnings] : cue.warnings,
  }
}

/**
 * 把台词放到主轨上：
 * - 分镜源片段按 sortOrder/lineNo 顺序排布，句首 MIN_LEAD_MS，句间 LINE_GAP_MS；
 * - 台词超长不压缩、不截断，允许溢出并标记 overflowsClip；
 * - voiceStartMs 有值的台词按时间轴绝对毫秒映射到覆盖片段；
 * - 找不到镜头的台词进入 unmappedLines，供混音页待确认。
 */
export function buildEditTimeline(
  plan: EditPlanV1,
  lines: EditLineRow[],
  takes: EditTakeRow[],
): EditTimelineResult {
  const layout = computeLayout(plan)
  const planClipById = new Map(plan.clips.map((clip) => [clip.id, clip]))
  const takesByLine = new Map<number, EditTakeRow[]>()
  for (const take of takes) {
    const list = takesByLine.get(take.lineId) ?? []
    list.push(take)
    takesByLine.set(take.lineId, list)
  }

  const linesByStoryboard = new Map<number, EditLineRow[]>()
  for (const line of lines) {
    if (line.storyboardId == null) continue
    const list = linesByStoryboard.get(line.storyboardId) ?? []
    list.push(line)
    linesByStoryboard.set(line.storyboardId, list)
  }
  for (const list of linesByStoryboard.values()) {
    list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.lineNo - b.lineNo || a.id - b.id)
  }

  const placements: EditLinePlacement[] = []
  const unmappedLines: UnmappedLine[] = []
  const placed = new Set<number>()

  for (const layoutClip of layout.clips) {
    const clip = planClipById.get(layoutClip.clipId)
    if (!clip || clip.source.kind !== 'storyboard') continue
    const storyboardId = Number(clip.source.id)
    if (!Number.isFinite(storyboardId)) continue
    const shotLines = linesByStoryboard.get(storyboardId) ?? []
    const clipDuration = layoutClip.timelineEndMs - layoutClip.timelineStartMs
    const lead = Math.max(0, Math.min(MIN_LEAD_MS, Math.max(0, clipDuration - LEAD_RESERVE_MS)))
    let cursor = lead
    for (const line of shotLines) {
      if (placed.has(line.id)) continue
      if (line.voiceStartMs !== null && line.voiceStartMs !== undefined) continue
      const take = activeTakeOf(line, takesByLine)
      const durationMs = lineDurationMs(line, take)
      const startMs = layoutClip.timelineStartMs + cursor
      placements.push(placementOf({
        line,
        clipId: layoutClip.clipId,
        storyboardId,
        startMs,
        endMs: startMs + durationMs,
        clipEndMs: layoutClip.timelineEndMs,
        take,
        anchorType: 'shot',
      }))
      placed.add(line.id)
      cursor += durationMs + LINE_GAP_MS
    }
  }

  const absoluteLines = [...lines].sort(
    (a, b) => (a.voiceStartMs ?? Number.MAX_SAFE_INTEGER) - (b.voiceStartMs ?? Number.MAX_SAFE_INTEGER)
      || a.lineNo - b.lineNo
      || a.id - b.id,
  )
  for (const line of absoluteLines) {
    if (placed.has(line.id)) continue
    const take = activeTakeOf(line, takesByLine)
    const durationMs = lineDurationMs(line, take)

    if (line.voiceStartMs === null || line.voiceStartMs === undefined) {
      if (line.storyboardId != null) {
        unmappedLines.push({ lineId: line.id, text: line.text, reason: 'no_clip' })
        continue
      }
      const first = layout.clips[0]
      if (!first) {
        unmappedLines.push({ lineId: line.id, text: line.text, reason: 'absolute_unmapped' })
        continue
      }
      placements.push(placementOf({
        line,
        clipId: first.clipId,
        storyboardId: null,
        startMs: first.timelineStartMs + MIN_LEAD_MS,
        endMs: first.timelineStartMs + MIN_LEAD_MS + durationMs,
        clipEndMs: first.timelineEndMs,
        take,
        anchorType: 'absolute',
      }))
      placed.add(line.id)
      continue
    }

    const atMs = Math.max(0, Math.round(line.voiceStartMs))
    const covering = layout.clips.find((clip) => atMs >= clip.timelineStartMs && atMs < clip.timelineEndMs)
      ?? layout.clips.find((clip) => clip.timelineStartMs >= atMs)
      ?? layout.clips[layout.clips.length - 1]
    if (!covering) {
      unmappedLines.push({ lineId: line.id, text: line.text, reason: 'absolute_unmapped' })
      continue
    }
    const startMs = Math.max(covering.timelineStartMs, Math.min(atMs, covering.timelineEndMs - MIN_LINE_MS))
    placements.push(placementOf({
      line,
      clipId: covering.clipId,
      storyboardId: line.storyboardId,
      startMs,
      endMs: startMs + durationMs,
      clipEndMs: covering.timelineEndMs,
      take,
      anchorType: 'absolute',
    }))
    placed.add(line.id)
  }

  for (const line of lines) {
    if (!placed.has(line.id) && !unmappedLines.some((item) => item.lineId === line.id)) {
      unmappedLines.push({
        lineId: line.id,
        text: line.text,
        reason: line.storyboardId == null ? 'absolute_unmapped' : 'no_clip',
      })
    }
  }

  placements.sort((a, b) => a.startMs - b.startMs || a.lineId - b.lineId)

  const audioSegments: EditAudioSegment[] = []
  for (const layoutClip of layout.clips) {
    const clip = planClipById.get(layoutClip.clipId)
    if (!clip) continue
    audioSegments.push({
      clipId: clip.id,
      sourceUrl: clip.source.url,
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
      speed: clip.speed,
      timelineStartMs: layoutClip.timelineStartMs,
      timelineEndMs: layoutClip.timelineEndMs,
      hasAudio: clip.source.hasAudio,
    })
  }

  return { durationMs: layout.durationMs, linePlacements: placements, audioSegments, unmappedLines }
}

/**
 * 为台词放置生成跟随字幕建议：start 对齐台词，end 追加 SUBTITLE_TAIL_GAP_MS 且不越过片段；
 * 溢出/过短/过长只告警，不静默改写台词时长。
 */
export function suggestSubtitles(plan: EditPlanV1, placements: EditLinePlacement[]): EditSubtitleCue[] {
  const layout = computeLayout(plan)
  const layoutIndex = new Map(layout.clips.map((clip) => [clip.clipId, clip]))
  const cues: EditSubtitleCue[] = []
  for (const placement of placements) {
    const cueText = String(placement.subtitleText ?? placement.text ?? '').trim()
    if (!cueText) continue
    const clip = layoutIndex.get(placement.clipId)
    if (!clip) continue
    const startMs = Math.max(placement.startMs, clip.timelineStartMs)
    const endMs = Math.min(
      Math.max(placement.endMs + SUBTITLE_TAIL_GAP_MS, startMs + MIN_LINE_MS),
      clip.timelineEndMs,
    )
    if (endMs <= startMs) continue
    const warnings: string[] = []
    if (placement.overflowsClip) warnings.push('SUBTITLE_OVERFLOW')
    if (endMs - startMs < SUBTITLE_MIN_MS) warnings.push('SUBTITLE_SHORT')
    if (Array.from(cueText).length > SUBTITLE_MAX_CHARS) warnings.push('SUBTITLE_LONG')
    cues.push({
      id: `cue_line_${placement.lineId}`,
      text: cueText,
      startMs,
      endMs,
      style: plan.project.defaultSubtitleStyle,
      role: placement.speakerName,
      source: 'line',
      follow: true,
      anchor: { clipId: placement.clipId, offsetMs: startMs - clip.timelineStartMs },
      lineId: placement.lineId,
      warnings,
    })
  }
  return cues.sort(cueSort)
}

/**
 * 合并字幕建议：同 lineId 的手动 cue、用户改过文本的 cue 一律保留；
 * 仅当 cue 仍为 source='line'、文本未变且 follow=true 时刷新时间/锚点/样式/告警。
 */
export function mergeSuggestedSubtitles(
  existing: EditSubtitleCue[],
  suggested: EditSubtitleCue[],
): MergeSuggestedSubtitlesResult {
  let added = 0
  let updated = 0
  const next = existing.map(cloneCue)
  const byLine = new Map<number, EditSubtitleCue>()
  for (const cue of next) {
    if (cue.lineId != null) byLine.set(cue.lineId, cue)
  }
  for (const cue of suggested) {
    const current = cue.lineId == null ? undefined : byLine.get(cue.lineId)
    if (!current) {
      const copy = cloneCue(cue)
      next.push(copy)
      if (copy.lineId != null) byLine.set(copy.lineId, copy)
      added += 1
      continue
    }
    if (current.source === 'line' && current.text === cue.text && current.follow) {
      current.startMs = cue.startMs
      current.endMs = cue.endMs
      current.anchor = cue.anchor ? { ...cue.anchor } : cue.anchor
      current.style = cue.style
      current.warnings = cue.warnings ? [...cue.warnings] : cue.warnings
      updated += 1
    }
  }
  return { cues: next.sort(cueSort), added, updated }
}

/** 台词/配音 Take 子集，交给 dialogueSyncHashOf 判断混音是否过期（顺序随 placements）。 */
export function dialogPlacementsOf(placements: EditLinePlacement[]): DialoguePlacement[] {
  return placements.map((placement) => ({
    lineId: placement.lineId,
    voiceTakeId: placement.voiceTakeId,
    takeUrl: placement.audioUrl,
    takeFingerprint: placement.audioFingerprint,
    durationMs: placement.durationMs,
  }))
}
