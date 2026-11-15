/**
 * 分镜负面约束双向一致：
 * - 无台词镜头必须明确写“不生成任何对话、对白以及旁白”；
 * - 有旁白无对白：降级为“不生成任何对白与对话”；有旁白有对白：移除静音子句。
 *
 * 只改提示词的「负面约束」分区，不改画面、台词或声音设计。
 */
export const NO_DIALOGUE_NEGATIVE_ZH = '不生成任何对话，对白以及旁白'
export const NO_DIALOGUE_NEGATIVE_EN = 'do not generate any dialogue, spoken lines, or off-screen narration'

const NEGATIVE_LINE_RE = /^\s*(?:负面约束|Negative constraints|ネガティブ制約|네거티브 제약)\s*[：:]\s*(.*)$/i
const SOUND_LINE_RE = /^\s*(?:声音|Sound|音频|Audio|音響|사운드)\s*[：:]/i
const QUOTE_RE = /[「“"]([^」”"]+)[」”"]/g
const SPEECH_VERB_RE = /(?:说|道|喊|叫|问|答|骂|念|唱|嘟囔|低语|开口|旁白|画外音)\s*[：:]?\s*[「“"]|(?:says|asks|answers|shouts|whispers|narrator)\s*[:,]?\s*["“]/i
const CJK_RE = /[\u3400-\u9fff]/

function withoutNegativeAndSound(prompt: string): string {
  const text = String(prompt || '')
  const negativeIndex = text.search(/\n\s*(?:负面约束|Negative constraints|ネガティブ制約|네거티브 제약)\s*[：:]/i)
  const beforeNegative = negativeIndex >= 0 ? text.slice(0, negativeIndex) : text
  return beforeNegative
    .split(/\r?\n/)
    .filter(line => !SOUND_LINE_RE.test(line))
    .join('\n')
}

export function promptHasSpokenContent(prompt: string): boolean {
  const body = withoutNegativeAndSound(prompt)
  if (/<d>\s*\[Chinese\]/i.test(body)) return true
  if (SPEECH_VERB_RE.test(body)) return true
  for (const match of body.matchAll(QUOTE_RE)) {
    const text = String(match[1] || '')
    if (text.length > 16 || /[。！？!?，,；;]/.test(text)) return true
  }
  return false
}

function phraseFor(prompt: string): { phrase: string; label: string } {
  return CJK_RE.test(prompt)
    ? { phrase: NO_DIALOGUE_NEGATIVE_ZH, label: '负面约束' }
    : { phrase: NO_DIALOGUE_NEGATIVE_EN, label: 'Negative constraints' }
}

/**
 * 在已有负面约束分区追加无台词约束；幂等。
 * 没有负面约束行时保持原样，由固定四区校验/修补去补完整分区，避免改写旧格式提示词。
 */
export function ensureNoDialogueNegativeConstraint(prompt: string): string {
  const text = String(prompt || '')
  if (!text.trim() || promptHasSpokenContent(text)) return text
  if (/不生成任何对话|do not generate any dialogue/i.test(text)) return text

  const { phrase } = phraseFor(text)
  const lines = text.split(/\r?\n/)
  const index = lines.findIndex(line => NEGATIVE_LINE_RE.test(line))
  if (index < 0) return text
  lines[index] = `${lines[index].replace(/[；;]\s*$/, '')}；${phrase}`
  return lines.join('\n')
}

const NARRATION_QUOTE_RE = /(?:旁白|画外音|解说词?|内心独白|心声|narrator|voice[\s-]?over|off-screen\s+(?:voice|narration))\s*(?:（[^）]*）|\([^)]*\))?\s*[：:]\s*[「“"][^」”"]+[」”"]/gi

/** 正文（去负面约束/声音分区）是否含旁白引号 */
export function promptHasNarration(prompt: string): boolean {
  NARRATION_QUOTE_RE.lastIndex = 0
  return NARRATION_QUOTE_RE.test(withoutNegativeAndSound(prompt))
}

/** 正文是否含角色对白（旁白引号不算对白） */
export function promptHasDialogue(prompt: string): boolean {
  const body = withoutNegativeAndSound(prompt).replace(NARRATION_QUOTE_RE, '')
  return promptHasSpokenContent(body)
}

const SILENT_CLAUSE_ZH = '不生成任何对话，对白以及旁白'
const SILENT_CLAUSE_EN = 'do not generate any dialogue, spoken lines, or off-screen narration'

/**
 * 负面约束双向一致：
 * - 无旁白无对白：追加完整静音子句（原逻辑）；
 * - 有旁白无对白：静音子句降级为「不生成任何对白与对话」，放开旁白；
 * - 有旁白有对白：移除静音子句。
 * 幂等；只改负面约束分区。
 */
export function ensureNegativeConsistency(prompt: string): string {
  const text = String(prompt || '')
  if (!text.trim()) return text
  if (!promptHasNarration(text)) return ensureNoDialogueNegativeConstraint(text)
  const hasZh = text.includes(SILENT_CLAUSE_ZH)
  const hasEn = new RegExp(SILENT_CLAUSE_EN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)
  if (!hasZh && !hasEn) return text
  if (promptHasDialogue(text)) {
    return text
      .replace(new RegExp(`[；;]?\\s*${SILENT_CLAUSE_ZH}。?`, 'g'), '')
      .replace(new RegExp(`[；;]?\\s*${SILENT_CLAUSE_EN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.?`, 'gi'), '')
  }
  return text
    .replace(new RegExp(SILENT_CLAUSE_ZH, 'g'), '不生成任何对白与对话')
    .replace(new RegExp(SILENT_CLAUSE_EN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'do not generate any dialogue or spoken lines')
}
