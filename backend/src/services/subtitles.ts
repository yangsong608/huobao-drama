/**
 * 字幕生成（V2 · 6.5）
 *
 * - 每条最多 2 行，每行 ≤14 汉字（9:16）或 ≤20（16:9）
 * - 超长按标点二次切分，时间按字数比例分配
 * - 单条最短 0.8s、最长 6s；过短且同说话人的相邻 cue 合并
 * - 输出 SRT（软字幕/外挂）与 ASS（烧录）
 */
import type { TimelineCue } from './timeline.js'

export interface SubtitleCue {
  index: number
  startMs: number
  endMs: number
  text: string
  speaker: string
  kind: 'dialogue' | 'narration' | 'inner'
}

export interface SubtitleOptions {
  /** 每行汉字上限；9:16 建议 14，16:9 建议 20 */
  maxCharsPerLine?: number
  maxLines?: number
  minDurationMs?: number
  maxDurationMs?: number
  mergeGapMs?: number
  /** 旁白加「（旁白）」前缀，默认关闭 */
  markNarration?: boolean
}

const DEFAULTS = {
  maxCharsPerLine: 14,
  maxLines: 2,
  minDurationMs: 800,
  maxDurationMs: 6000,
  mergeGapMs: 250,
  markNarration: false,
}

const SENTENCE_END = /(?<=[。！？!?；;，,、])/

/** 按标点切成 ≤limit 字的片段；单句超长时硬切，避免整条被丢弃 */
export function splitText(text: string, limit: number): string[] {
  const chars = [...text]
  if (chars.length <= limit) return [text]
  const out: string[] = []
  let buffer = ''
  const push = () => {
    const trimmed = buffer.trim()
    if (trimmed) out.push(trimmed)
    buffer = ''
  }
  for (const part of text.split(SENTENCE_END)) {
    if ([...part].length > limit) {
      push()
      for (let i = 0; i < [...part].length; i += limit) {
        out.push([...part].slice(i, i + limit).join('').trim())
      }
      continue
    }
    if ([...buffer].length + [...part].length > limit) push()
    buffer += part
  }
  push()
  return out.filter(Boolean)
}

/** 两行排版：优先在中间标点断开 */
export function wrapLines(text: string, maxCharsPerLine: number): string[] {
  const chars = [...text]
  if (chars.length <= maxCharsPerLine) return [text]
  const mid = Math.ceil(chars.length / 2)
  let best = -1
  for (let i = Math.max(0, mid - 6); i < Math.min(chars.length, mid + 6); i += 1) {
    if ('，。！？；,、'.includes(chars[i])) {
      if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i
    }
  }
  if (best > 0) {
    return [chars.slice(0, best + 1).join('').trim(), chars.slice(best + 1).join('').trim()].filter(Boolean)
  }
  return [chars.slice(0, mid).join(''), chars.slice(mid).join('')].filter(Boolean)
}

function withNarrationMark(text: string, kind: TimelineCue['kind'], enabled: boolean): string {
  if (!enabled) return text
  if (kind === 'narration') return `（旁白）${text}`
  if (kind === 'inner') return `（心声）${text}`
  return text
}

/**
 * 时间轴 cue → 字幕 cue。
 * 超长 cue 切成多条连续 cue，时间按字数比例分配（设计 6.5.1）。
 */
export function buildSubtitleCues(timeline: TimelineCue[], options: SubtitleOptions = {}): SubtitleCue[] {
  const opts = { ...DEFAULTS, ...options }
  const perCueLimit = opts.maxCharsPerLine * opts.maxLines
  const raw: Omit<SubtitleCue, 'index'>[] = []

  for (const cue of timeline) {
    const text = withNarrationMark(cue.text, cue.kind, opts.markNarration)
    const start = cue.subtitleStartMs
    const end = Math.max(start + 300, cue.subtitleEndMs)
    const pieces = splitText(text, perCueLimit)
    if (pieces.length <= 1) {
      raw.push({ startMs: start, endMs: end, text, speaker: cue.speaker, kind: cue.kind })
      continue
    }
    const totalChars = pieces.reduce((n, p) => n + [...p].length, 0)
    let cursor = start
    pieces.forEach((piece, i) => {
      const ratio = [...piece].length / totalChars
      const pieceEnd = i === pieces.length - 1 ? end : Math.round(cursor + (end - start) * ratio)
      raw.push({ startMs: cursor, endMs: Math.max(cursor + 300, pieceEnd), text: piece, speaker: cue.speaker, kind: cue.kind })
      cursor = pieceEnd
    })
  }

  // 合并过短且同说话人的相邻 cue
  const merged: Omit<SubtitleCue, 'index'>[] = []
  for (const cue of raw) {
    const prev = merged[merged.length - 1]
    const tooShort = cue.endMs - cue.startMs < opts.minDurationMs
    if (prev && tooShort && prev.speaker === cue.speaker && prev.kind === cue.kind && cue.startMs - prev.endMs <= opts.mergeGapMs) {
      prev.endMs = Math.max(prev.endMs, cue.endMs)
      prev.text = `${prev.text}${cue.text}`
      continue
    }
    merged.push({ ...cue })
  }

  // 夹到最长 6s，且不与下一条重叠
  return merged.map((cue, i) => {
    const next = merged[i + 1]
    let endMs = Math.min(cue.endMs, cue.startMs + opts.maxDurationMs)
    if (next && endMs > next.startMs - 40) endMs = Math.max(cue.startMs + 400, next.startMs - 40)
    return { index: i + 1, ...cue, endMs }
  })
}

function pad(n: number, size = 2): string {
  return String(Math.floor(n)).padStart(size, '0')
}

export function formatSrtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const milli = total % 1000
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`
}

export function formatAssTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const cs = Math.floor((total % 1000) / 10)
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`
}

export function toSrt(cues: SubtitleCue[], options: SubtitleOptions = {}): string {
  const opts = { ...DEFAULTS, ...options }
  return cues
    .map((cue) => {
      const body = wrapLines(cue.text, opts.maxCharsPerLine).join('\n')
      return `${cue.index}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${body}\n`
    })
    .join('\n')
}

export interface AssStyleOptions {
  width?: number
  height?: number
  fontName?: string
  /** 覆盖按画幅自动计算的字号 */
  fontSize?: number | null
  /** 覆盖按画幅自动计算的底边距 */
  marginV?: number | null
}

/** ASS 样式优先级：设置页显式值 > 按画布比例自动（设计 6.5.2） */
export function toAss(cues: SubtitleCue[], options: SubtitleOptions & AssStyleOptions = {}): string {
  const opts = { ...DEFAULTS, ...options }
  const width = options.width ?? 1080
  const height = options.height ?? 1920
  const portrait = height >= width
  const fontSize = Number.isFinite(options.fontSize) && (options.fontSize as number) > 0
    ? Math.round(options.fontSize as number)
    : portrait ? 54 : 46
  const marginV = Number.isFinite(options.marginV) && (options.marginV as number) >= 0
    ? Math.round(options.marginV as number)
    : portrait ? 260 : 90
  const fontName = options.fontName || 'PingFang SC'

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H00141414,&H64000000,0,0,0,0,100,100,0,0,1,3,1,2,40,40,${marginV},1`,
    `Style: Narration,${fontName},${Math.round(fontSize * 0.92)},&H00FFFFFF,&H000000FF,&H00141414,&H64000000,0,-1,0,0,100,100,0,0,1,3,1,2,40,40,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')

  const events = cues.map((cue) => {
    const style = cue.kind === 'dialogue' ? 'Default' : 'Narration'
    const text = wrapLines(cue.text, opts.maxCharsPerLine).join('\\N').replace(/\{/g, '（').replace(/\}/g, '）')
    return `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},${style},${cue.speaker},0,0,0,,${text}`
  })

  return `${header}\n${events.join('\n')}\n`
}

/** 按项目比例决定每行字数 */
export function maxCharsForAspect(width: number, height: number): number {
  return height >= width ? 14 : 20
}
