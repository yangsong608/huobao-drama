/**
 * 故事圣经：小说架构五件套 → dramas.story_bible（JSON）
 * P3-6 在此基础上补充格式化与提示词注入。
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

export const STORY_BIBLE_KEYS = [
  'coreSeed',
  'characterDynamics',
  'worldBuilding',
  'plotArchitecture',
  'characterState',
  'adaptationNotes',
] as const

export type StoryBibleKey = typeof STORY_BIBLE_KEYS[number]
export type StoryBible = Partial<Record<StoryBibleKey, string>>

export function buildStoryBible(source: Partial<Record<StoryBibleKey, unknown>>): StoryBible {
  const bible: StoryBible = {}
  for (const key of STORY_BIBLE_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) bible[key] = value.trim()
  }
  return bible
}

export function getStoryBible(dramaId: number | null | undefined): StoryBible {
  if (!dramaId) return {}
  try {
    const row = db.select({ storyBible: schema.dramas.storyBible })
      .from(schema.dramas)
      .where(eq(schema.dramas.id, dramaId))
      .get()
    if (!row?.storyBible) return {}
    const parsed = JSON.parse(row.storyBible)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return buildStoryBible(parsed as Record<string, unknown>)
  } catch {
    return {}
  }
}

export const SECTION_LABELS: Record<StoryBibleKey, string> = {
  coreSeed: '核心种子',
  characterDynamics: '人物关系',
  worldBuilding: '世界观设定',
  plotArchitecture: '剧情架构',
  characterState: '人物状态',
  adaptationNotes: '改编备注',
}

export const STORY_BIBLE_HEADER = '【故事圣经】'
const SENTENCE_PATTERN = /[^。！？!?；;…]*[。！？!?；;…]+[”’"']?|[^。！？!?；;…]+$/g

function paragraphsOf(text: string): string[] {
  return text.split(/\n+/).map((line) => line.trim()).filter(Boolean)
}

function sentencesOf(paragraph: string): string[] {
  return (paragraph.match(SENTENCE_PATTERN) || []).map((sentence) => sentence.trim()).filter(Boolean)
}

function renderSection(label: string, paragraphs: string[]): string {
  return `【${label}】\n${paragraphs.join('\n')}`
}

/** 按五件套顺序拼接；超长时以整段/整句为单位截断，不产生半句 */
export function formatStoryBible(bible: StoryBible, limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0 || limit < STORY_BIBLE_HEADER.length) return ''
  const sections = STORY_BIBLE_KEYS
    .map((key) => ({ key, label: SECTION_LABELS[key], paragraphs: paragraphsOf(String(bible[key] ?? '')) }))
    .filter((section) => section.paragraphs.length > 0)
  if (!sections.length) return ''

  const full = [STORY_BIBLE_HEADER, ...sections.map((section) => renderSection(section.label, section.paragraphs))].join('\n\n')
  if (full.length <= limit) return full

  const kept = [STORY_BIBLE_HEADER]
  let consumed = STORY_BIBLE_HEADER.length
  for (const section of sections) {
    const fullBlock = renderSection(section.label, section.paragraphs)
    if (consumed + 2 + fullBlock.length <= limit) {
      kept.push(fullBlock)
      consumed += 2 + fullBlock.length
      continue
    }

    const accepted: string[] = []
    for (const paragraph of section.paragraphs) {
      if (consumed + 2 + renderSection(section.label, [...accepted, paragraph]).length <= limit) {
        accepted.push(paragraph)
        continue
      }
      let wholeSentences = ''
      for (const sentence of sentencesOf(paragraph)) {
        const candidate = `${wholeSentences}${sentence}`
        if (consumed + 2 + renderSection(section.label, [...accepted, candidate]).length <= limit) {
          wholeSentences = candidate
        } else {
          break
        }
      }
      if (wholeSentences) accepted.push(wholeSentences)
      break
    }
    if (accepted.length) kept.push(renderSection(section.label, accepted))
    break
  }
  return kept.join('\n\n')
}

/** 前置故事圣经；同一段已出现在提示词里时不重复拼接 */
export function withStoryBible(prompt: string, dramaId: number | null | undefined, limit: number): string {
  const bible = getStoryBible(dramaId)
  if (!Object.keys(bible).length) return prompt

  const remaining: StoryBible = {}
  for (const key of STORY_BIBLE_KEYS) {
    const value = bible[key]
    if (!value) continue
    const paragraphs = paragraphsOf(value).filter((paragraph) => !prompt.includes(paragraph))
    if (paragraphs.length) remaining[key] = paragraphs.join('\n')
  }

  const formatted = formatStoryBible(remaining, limit)
  if (!formatted) return prompt
  return prompt.trim() ? `${formatted}\n\n${prompt}` : formatted
}
