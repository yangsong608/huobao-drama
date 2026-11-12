/**
 * 台词原文完整性
 *
 * description 是台词的唯一原文：video_prompt 的 3 秒分段可以拆开一句台词，
 * 但所有文字与标点必须逐字保留。比较时只忽略空白和引号内的舞台提示，其余字符严格比对。
 */
import { findQuotedSpans } from './dialogue-lines.js'

export interface SpokenQuote {
  text: string
  raw: string
  at: number
}

export interface DialogueIntegrityReport {
  ok: boolean
  expected: string
  actual: string
  /** 第一个未能逐字对上的原文片段（从缺失处到结尾，调用方负责截断展示） */
  missing: string
  /** 缺失处之前的原文上下文 */
  before: string
}

const NARRATION_PREFIX_RE = /(?:旁白|画外音|心声|内心独白|narration|voice[\s-]?over|inner\s+voice|ナレーション|心の声|내레이션|속마음)\s*(?:[（(][^）)]*[）)])?\s*[：:]?\s*$/i

const SPEECH_VERB_RE = /(?:说|道|问|喊|答|嘟囔|自语|吼|叫|嘀咕|念|叹|哼|嚷|骂|(?<![A-Za-z])(?:says?|said|asks?|asked|shouts?|shouted|whispers?|whispered|replies?|replied|answers?|answered|murmurs?|murmured|mutters?|muttered|yells?|yelled|calls?|called)|言う|言った|話す|話した|叫ぶ|叫んだ|問う|答える|つぶやく|呟く|말한다|말했다|외친다|외쳤다|묻는다|물었다|대답한다|대답했다|중얼거린다|중얼거렸다)\s*(?:[（(][^）)]*[）)])?\s*[：:]?\s*$/i

const SPEAKER_COLON_RE = /@[^\s，。！？；：、,.!?;:]{1,24}\s*(?:[（(][^）)]*[）)])?\s*[：:]\s*$/

/** 招牌、字幕、书面语等非口白引号：不参与台词完整性比对 */
const NON_SPEECH_PREFIX_RE = /(?:写|印|刻|绣|标|题|显示|上书|挂着|贴着)\s*(?:着|道|了|有)?\s*[：:]?\s*$/

function stripStageDirections(text: string): string {
  return text
    .replace(/【[^】]*】/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
}

function normalizeSpokenText(text: string): string {
  return stripStageDirections(text).replace(/[\s\u3000]+/g, '')
}

/**
 * 提取口白引号：只有紧邻旁白标记、说话动词或 @角色名 冒号的引号才算台词。
 * 招牌、字幕、告示等引号默认排除；短拟声词没有说话动词时也排除。
 */
export function extractSpokenQuotes(text: string): SpokenQuote[] {
  const source = text || ''
  const quotes: SpokenQuote[] = []
  for (const span of findQuotedSpans(source)) {
    const before = source.slice(Math.max(0, span.start - 48), span.start).replace(/\s+$/, '')
    if (NON_SPEECH_PREFIX_RE.test(before)) continue
    const narrated = NARRATION_PREFIX_RE.test(before)
    const spoken = SPEECH_VERB_RE.test(before)
    if (!narrated && !spoken && !SPEAKER_COLON_RE.test(before)) continue
    const normalized = normalizeSpokenText(span.inner)
    if (!normalized) continue
    if ([...normalized].length <= 3 && !spoken) continue
    quotes.push({ text: normalized, raw: span.inner, at: span.start })
  }
  return quotes
}

function joinQuotes(quotes: SpokenQuote[]): string {
  return quotes.map((quote) => quote.text).join('')
}

/**
 * 子序列定位：跳过 video_prompt 中多出来的字符，但不允许原文任何字符缺失或换序。
 * 返回第一个未匹配上的原文下标；全部保留时返回 -1。
 */
function firstMissingIndex(expected: string, actual: string): number {
  let i = 0
  let j = 0
  while (i < expected.length) {
    if (j >= actual.length) return i
    if (expected[i] === actual[j]) {
      i += 1
      j += 1
      continue
    }
    const next = actual.indexOf(expected[i], j)
    if (next < 0) return i
    j = next + 1
    i += 1
  }
  return -1
}

export function inspectDialogueIntegrity(
  description: string | null | undefined,
  videoPrompt: string | null | undefined,
): DialogueIntegrityReport | null {
  const expectedQuotes = extractSpokenQuotes(description || '')
  if (!expectedQuotes.length) return null
  const expected = joinQuotes(expectedQuotes)
  const actual = joinQuotes(extractSpokenQuotes(videoPrompt || ''))
  const missingAt = firstMissingIndex(expected, actual)
  if (missingAt < 0) {
    return { ok: true, expected, actual, missing: '', before: '' }
  }
  return {
    ok: false,
    expected,
    actual,
    missing: expected.slice(missingAt),
    before: expected.slice(0, missingAt),
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function formatDialogueIntegrityIssue(report: DialogueIntegrityReport, label: string): string {
  const missing = clip(report.missing, 40)
  const before = clip(report.before.slice(-18), 18)
  return `${label}未完整保留 description 台词/标点：${before ? `在「${before}」之后` : '开头'}缺少「${missing}」`
}
