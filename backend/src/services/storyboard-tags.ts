/**
 * 分镜卡片标签
 *
 * 标签是卡片元数据，不写进视频提示词。
 * 自动标签由结构字段派生；用户手动标签存 storyboards.tags，展示时合并。
 */
import { COMBAT_RE, COMPETITION_RE } from './storyboard-content.js'

export const STORYBOARD_TAG_KEYS = [
  'transition',
  'character',
  'empty',
  'dialogue',
  'narration',
  'combat',
  'competition',
  'memory',
] as const

export type StoryboardTagKey = typeof STORYBOARD_TAG_KEYS[number]

const TAG_SET = new Set<string>(STORYBOARD_TAG_KEYS)
const MEMORY_RE = /(?:回忆|回溯|多年前|往事|身世|记忆|童年|当年)/
const DIALOGUE_RE = /[「“"][^」”"]+[」”"]/
const NARRATION_RE = /(?:旁白|画外音|解说词?|内心独白|心声)\s*(?:（[^）]*）|\([^)]*\))?\s*[：:]/
const NARRATION_LINE_RE = /(?:旁白|画外音|解说词?|内心独白|心声)\s*(?:（[^）]*）|\([^)]*\))?\s*[：:][^\n]*/g

export function parseStoryboardTags(raw: unknown): StoryboardTagKey[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) list = raw
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) list = parsed
    } catch {}
  }
  const result: StoryboardTagKey[] = []
  for (const value of list) {
    const key = String(value || '').trim() as StoryboardTagKey
    if (!TAG_SET.has(key) || result.includes(key)) continue
    result.push(key)
    if (result.length >= 8) break
  }
  return result
}

export function serializeStoryboardTags(raw: unknown): string | null {
  const tags = parseStoryboardTags(raw)
  return tags.length ? JSON.stringify(tags) : null
}

export interface DeriveStoryboardTagsInput {
  transition?: string | null
  transitionKind?: string | null
  characterCount?: number
  description?: string | null
  videoPrompt?: string | null
  narrationText?: string | null
  narrationType?: string | null
}

export function deriveStoryboardTags(input: DeriveStoryboardTagsInput): StoryboardTagKey[] {
  const text = `${input.description || ''}\n${input.videoPrompt || ''}`
  const tags: StoryboardTagKey[] = []
  const push = (key: StoryboardTagKey) => { if (!tags.includes(key)) tags.push(key) }
  if (input.transitionKind || (input.transition && input.transition !== 'cut')) push('transition')
  if ((input.characterCount || 0) > 0) push('character')
  const hasNarration = Boolean(String(input.narrationText || '').trim())
    || input.narrationType === 'character_intro'
    || input.narrationType === 'third_person'
    || NARRATION_RE.test(text)
  const dialogueText = NARRATION_RE.test(text) ? text.replace(NARRATION_LINE_RE, '') : text
  const hasDialogue = DIALOGUE_RE.test(dialogueText)
  if (hasDialogue) push('dialogue')
  if (hasNarration) push('narration')
  if (!input.characterCount && !hasDialogue && !hasNarration) push('empty')
  if (COMBAT_RE.test(text)) push('combat')
  if (COMPETITION_RE.test(text)) push('competition')
  if (MEMORY_RE.test(text)) push('memory')
  return tags
}
