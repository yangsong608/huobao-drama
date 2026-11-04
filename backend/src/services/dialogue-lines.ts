/**
 * 台词抽取（V2 · 6.1）
 *
 * 输入：storyboards.video_prompt（含 `0-3秒：...` 时间码段）
 * 输出：逐句台词，含说话人类型、镜头内相对时间、朗读文本与字幕文本。
 *
 * 设计要点：
 * - 真实数据里旁白多为「旁白：...」无引号，必须单独抽；
 * - 引号台词优先，裸旁白只取未被引号覆盖的区间；
 * - 无法判定说话人时标 needs_review，不猜。
 */

export type SpeakerType = 'dialogue' | 'narration' | 'inner'

export interface CastMember {
  id?: number | null
  name: string
}

export interface ParsedLine {
  lineNo: number
  speakerType: SpeakerType
  speakerName: string | null
  characterId: number | null
  /** 清洗后的台词（字幕与朗读共用基线） */
  text: string
  speakText: string
  subtitleText: string
  /** 镜头内相对毫秒 */
  plannedStartMs: number
  plannedEndMs: number
  needsReview: boolean
  source: 'auto'
}

interface Segment {
  startMs: number
  endMs: number
  text: string
}

interface Span {
  start: number
  end: number
  inner: string
}

const NARRATION_WORDS = /旁白|画外音|解说/
const INNER_WORDS = /心声|内心|独白/

/** 切段时间码：0-3秒： / 3–6秒: */
export function splitSegments(videoPrompt: string, fallbackDurationMs = 0): Segment[] {
  const text = videoPrompt || ''
  const re = /^(\d+)\s*[-–—]\s*(\d+)\s*秒\s*[：:]\s*/gm
  const marks: { index: number; startMs: number; endMs: number; textStart: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    marks.push({
      index: m.index,
      startMs: Number(m[1]) * 1000,
      endMs: Number(m[2]) * 1000,
      textStart: m.index + m[0].length,
    })
  }
  if (!marks.length) {
    const trimmed = text.trim()
    if (!trimmed) return []
    const estimated = fallbackDurationMs > 0 ? fallbackDurationMs : Math.max(3000, Math.round(([...trimmed].length / 4) * 1000))
    return [{ startMs: 0, endMs: estimated, text: trimmed }]
  }
  return marks.map((mark, i) => ({
    startMs: mark.startMs,
    endMs: mark.endMs,
    text: text.slice(mark.textStart, i + 1 < marks.length ? marks[i + 1].index : text.length).trim(),
  }))
}

/** 抽取引号内文本，支持「」『』“” 与英文双引号 */
export function findQuotedSpans(text: string): Span[] {
  const patterns = [/「([\s\S]*?)」/g, /『([\s\S]*?)』/g, /“([\s\S]*?)”/g, /"([^"\n]{1,200})"/g]
  const spans: Span[] = []
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const start = m.index
      const end = m.index + m[0].length
      if (spans.some((s) => start < s.end && end > s.start)) continue
      spans.push({ start, end, inner: m[1] })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** 清洗台词：去舞台提示、镜头标记、@ 前缀；破折号转逗号；省略号归一 */
export function cleanLineText(raw: string): string {
  return (raw || '')
    .replace(/【[^】]*】/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[「」『』“”"]/g, '')
    .replace(/@/g, '')
    .replace(/——|—/g, '，')
    .replace(/\.{3,}|。{3,}/g, '…')
    .replace(/…{2,}/g, '…')
    .replace(/\s+/g, ' ')
    .replace(/^[，,、；;]+/, '')
    .trim()
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const CN_UNITS = ['', '十', '百', '千']

function readNumber(n: number): string {
  if (n === 0) return '零'
  if (n < 10) return CN_DIGITS[n]
  if (n < 20) return `十${n % 10 ? CN_DIGITS[n % 10] : ''}`
  const digits = String(n).split('').map(Number)
  let out = ''
  let zero = false
  digits.forEach((d, i) => {
    const unit = CN_UNITS[digits.length - 1 - i]
    if (d === 0) {
      zero = true
      return
    }
    if (zero && out) out += '零'
    zero = false
    out += CN_DIGITS[d] + unit
  })
  return out
}

/** 朗读文本规范化：年份逐位读，其余数字按中文读法；保留标点以保留停顿 */
export function toSpeakText(text: string): string {
  return text
    .replace(/(\d{4})\s*年/g, (_all, y: string) => `${y.split('').map((d) => CN_DIGITS[Number(d)]).join('')}年`)
    .replace(/(\d+)\s*(个|只|条|次|天|年|岁|人|块|里|米|秒|分钟|小时)/g, (_all, num: string, unit: string) => `${readNumber(Number(num))}${unit}`)
    .replace(/\d+/g, (num) => readNumber(Number(num)))
    .replace(/&/g, '和')
    .trim()
}

function pickSpeaker(preText: string, cast: CastMember[]): { type: SpeakerType; name: string | null; id: number | null; unknown: boolean } {
  const tail = preText.slice(-16)
  // 旁白/心声只在近处判定，避免上一句的「旁白」串味
  if (INNER_WORDS.test(tail)) return { type: 'inner', name: '旁白', id: null, unknown: false }
  if (NARRATION_WORDS.test(tail)) return { type: 'narration', name: '旁白', id: null, unknown: false }

  // 名字匹配放宽到整段前缀，长名优先避免「张三」匹配到「张三丰」
  const scope = preText.slice(-80)
  const sorted = [...cast].sort((a, b) => b.name.length - a.name.length)
  for (const member of sorted) {
    if (!member.name) continue
    if (scope.includes(`@${member.name}`)) {
      return { type: 'dialogue', name: member.name, id: member.id ?? null, unknown: false }
    }
  }
  for (const member of sorted) {
    if (!member.name) continue
    const said = new RegExp(`${escapeRegExp(member.name)}\\s*(?:继续)?(?:笑|低声|轻声|冷声|沉声)?\\s*(?:说|道|问|喊|答|嘟囔|自语|吼|叫)`)
    if (said.test(scope)) return { type: 'dialogue', name: member.name, id: member.id ?? null, unknown: false }
  }

  // 段内只提到一个角色时，归给该角色
  const mentioned = sorted.filter((member) => member.name && preText.includes(`@${member.name}`))
  if (mentioned.length === 1) {
    return { type: 'dialogue', name: mentioned[0].name, id: mentioned[0].id ?? null, unknown: false }
  }
  if (cast.length === 1) return { type: 'dialogue', name: cast[0].name, id: cast[0].id ?? null, unknown: false }

  return { type: 'dialogue', name: '未知', id: null, unknown: true }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

interface Draft {
  text: string
  type: SpeakerType
  name: string | null
  characterId: number | null
  needsReview: boolean
}

/** 抽一个镜头内的所有台词草稿（引号优先，裸旁白补位） */
export function extractDrafts(segmentText: string, cast: CastMember[]): Draft[] {
  const drafts: Draft[] = []
  const spans = findQuotedSpans(segmentText)

  for (const span of spans) {
    const cleaned = cleanLineText(span.inner)
    if (!cleaned) continue
    const speaker = pickSpeaker(segmentText.slice(0, span.start), cast)
    drafts.push({
      text: cleaned,
      type: speaker.type,
      name: speaker.name,
      characterId: speaker.id,
      needsReview: speaker.unknown,
    })
  }

  // 裸旁白：把引号区间挖空后再找「旁白：」，避免把台词重复计入
  const masked = segmentText
    .split('')
    .map((ch, i) => (spans.some((s) => i >= s.start && i < s.end) ? '　' : ch))
    .join('')
  const narrationRe = /(旁白|画外音|心声|内心独白)\s*(?:（[^）]*）|\([^)]*\))?\s*[：:]/g
  let m: RegExpExecArray | null
  while ((m = narrationRe.exec(masked))) {
    const from = m.index + m[0].length
    let to = masked.length
    // 截到下一个 @角色 之前（避免把后续画面描述一起吞进来）
    if (cast.length) {
      const rest = masked.slice(from)
      const at = rest.indexOf('@')
      if (at >= 0) to = from + at
    }
    const raw = segmentText.slice(from, to)
    const longNarration = [...cleanLineText(raw)].length > 80
    for (const sentence of splitSentences(raw)) {
      const cleaned = cleanLineText(sentence)
      if (!cleaned) continue
      drafts.push({
        text: cleaned,
        type: INNER_WORDS.test(m[1]) ? 'inner' : 'narration',
        name: '旁白',
        characterId: null,
        needsReview: longNarration,
      })
    }
  }

  return drafts
}

export interface ParseOptions {
  cast?: CastMember[]
  /** 无时间码时的兜底时长 */
  durationMs?: number
}

/** video_prompt → 逐句台词（镜头内相对时间，按字数分摊段时长） */
export function parseVideoPrompt(videoPrompt: string, options: ParseOptions = {}): ParsedLine[] {
  const cast = options.cast ?? []
  const segments = splitSegments(videoPrompt, options.durationMs ?? 0)
  const lines: ParsedLine[] = []
  let lineNo = 1

  for (const segment of segments) {
    const drafts = extractDrafts(segment.text, cast)
    if (!drafts.length) continue
    const totalChars = drafts.reduce((n, d) => n + Math.max(1, [...d.text].length), 0)
    const span = Math.max(300, segment.endMs - segment.startMs)
    let cursor = segment.startMs

    for (const draft of drafts) {
      const weight = Math.max(1, [...draft.text].length) / totalChars
      const dur = Math.max(300, Math.round(span * weight))
      const start = cursor
      const end = Math.min(segment.endMs, start + dur)
      lines.push({
        lineNo: lineNo++,
        speakerType: draft.type,
        speakerName: draft.name,
        characterId: draft.characterId,
        text: draft.text,
        speakText: toSpeakText(draft.text),
        subtitleText: draft.text,
        plannedStartMs: start,
        plannedEndMs: end,
        needsReview: draft.needsReview,
        source: 'auto',
      })
      cursor = end
    }
  }

  return lines
}

/** 抽样统计，供 UI 预览与验收（未知说话人占比、超长句） */
export function summarizeLines(lines: ParsedLine[]) {
  const total = lines.length
  const unknown = lines.filter((l) => l.needsReview && l.speakerName === '未知').length
  return {
    total,
    narration: lines.filter((l) => l.speakerType === 'narration').length,
    inner: lines.filter((l) => l.speakerType === 'inner').length,
    dialogue: lines.filter((l) => l.speakerType === 'dialogue').length,
    unknown,
    unknownRatio: total ? unknown / total : 0,
    needsReview: lines.filter((l) => l.needsReview).length,
  }
}
