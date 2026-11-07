/**
 * 小说改编上下文包：故事圣经核心段 + 章节蓝图摘要 + 未回收伏笔 + 批注摘录
 * 只读拼接；预览与导入共用同一函数；超预算按完整句子/整行截断。
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getNovelSettings } from './app-settings.js'
import { SECTION_LABELS, STORY_BIBLE_KEYS, buildStoryBible } from './drama-story-bible.js'
import { parseChapterBlueprint } from './novel/blueprint.js'

export const CONTEXT_PACK_HEADER = '【小说改编上下文】'
export const CONTEXT_PACK_MIN_CHARS = 500
export const CONTEXT_PACK_MAX_CHARS = 20000

const SENTENCE_ENDINGS = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n'])
const CLOSING_MARKS = new Set(['”', '’', '"', "'", '」', '』'])
const ANNOTATION_KIND_LABELS: Record<string, string> = { note: '批注', adapt: '改编', question: '疑问' }
const FORESHADOW_STATUS_LABELS: Record<string, string> = {
  planned: '待埋设',
  planted: '已埋设',
  reinforced: '已强化',
}

export class NovelContextPackNotFoundError extends Error {}

export interface ContextPackOptions {
  chapter_nos?: number[]
  include_annotations?: boolean
  include_unresolved_foreshadows?: boolean
  max_chars?: number
}

export interface ContextPackIncluded {
  chapters: number
  annotations: number
  foreshadows: number
}

export interface ContextPackResult {
  text: string
  chars: number
  truncated: boolean
  included: ContextPackIncluded
  max_chars: number
}

interface PackUnit {
  text: string
  group: number
  chapters?: number
  annotations?: number
  foreshadows?: number
  prose?: boolean
}

function clip(value: unknown, max: number): string {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ')
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

function normalizeChapterNos(value: number[] | undefined): number[] {
  if (!Array.isArray(value) || !value.length) return []
  return [...new Set(value
    .map((item) => Math.floor(Number(item)))
    .filter((item) => Number.isInteger(item) && item > 0))].sort((a, b) => a - b)
}

function normalizeMaxChars(value: number | undefined, fallback: number): number {
  const raw = Number(value)
  const base = Number.isFinite(raw) && raw > 0 ? raw : fallback
  return Math.min(CONTEXT_PACK_MAX_CHARS, Math.max(CONTEXT_PACK_MIN_CHARS, Math.round(base)))
}

/** 在 limit 内回退到最近的完整句末/行末；找不到完整边界时返回空串，不产生半句 */
function wholeSentencePrefix(text: string, limit: number): string {
  if (limit <= 0) return ''
  if (text.length <= limit) return text
  for (let index = Math.min(limit, text.length) - 1; index >= 0; index -= 1) {
    if (!SENTENCE_ENDINGS.has(text[index])) continue
    let end = index + 1
    while (end < text.length && CLOSING_MARKS.has(text[end])) end += 1
    return text.slice(0, end)
  }
  return ''
}

function assemble(units: PackUnit[], maxChars: number): {
  text: string
  truncated: boolean
  included: ContextPackIncluded
} {
  const included: ContextPackIncluded = { chapters: 0, annotations: 0, foreshadows: 0 }
  let text = ''
  let group = -1
  let truncated = false

  for (const unit of units) {
    const separator = text ? (unit.group === group ? '\n' : '\n\n') : ''
    const candidate = `${text}${separator}${unit.text}`
    if (candidate.length <= maxChars) {
      text = candidate
      group = unit.group
      included.chapters += unit.chapters ?? 0
      included.annotations += unit.annotations ?? 0
      included.foreshadows += unit.foreshadows ?? 0
      continue
    }
    truncated = true
    if (unit.prose) {
      const piece = wholeSentencePrefix(unit.text, maxChars - text.length - separator.length)
      if (piece.trim()) text = `${text}${separator}${piece}`
    }
    break
  }

  return { text: text.trimEnd(), truncated, included }
}

export function buildNovelContextPack(novelId: number, options: ContextPackOptions = {}): ContextPackResult {
  const novel = db.select().from(schema.novels)
    .where(and(eq(schema.novels.id, novelId), isNull(schema.novels.deletedAt)))
    .get()
  if (!novel) throw new NovelContextPackNotFoundError('小说不存在')

  const settings = getNovelSettings()
  const maxChars = normalizeMaxChars(options.max_chars, settings.contextPack.maxChars)
  const includeAnnotations = typeof options.include_annotations === 'boolean'
    ? options.include_annotations
    : settings.contextPack.includeAnnotations
  const includeUnresolved = typeof options.include_unresolved_foreshadows === 'boolean'
    ? options.include_unresolved_foreshadows
    : settings.contextPack.includeUnresolved
  const chapterNos = normalizeChapterNos(options.chapter_nos)
  const chapterFilter = chapterNos.length ? new Set(chapterNos) : null

  const units: PackUnit[] = [{ text: `${CONTEXT_PACK_HEADER}\n小说：《${clip(novel.title, 120)}》`, group: 0 }]

  const bible = buildStoryBible(novel)
  let bibleHeading = true
  for (const key of STORY_BIBLE_KEYS) {
    const value = String(bible[key] ?? '').trim()
    if (!value) continue
    const heading = bibleHeading ? '【故事圣经】\n' : ''
    bibleHeading = false
    units.push({ text: `${heading}【${SECTION_LABELS[key]}】\n${value}`, group: 1, prose: true })
  }

  const chapterRows = db.select({
    chapterNo: schema.novelChapters.chapterNo,
    title: schema.novelChapters.title,
    content: schema.novelChapters.content,
  }).from(schema.novelChapters)
    .where(eq(schema.novelChapters.novelId, novelId))
    .orderBy(schema.novelChapters.chapterNo)
    .all()
    .filter((row) => String(row.content || '').trim())
    .filter((row) => !chapterFilter || chapterFilter.has(row.chapterNo))
  if (chapterRows.length) {
    const blueprintByNo = new Map(parseChapterBlueprint(novel.chapterBlueprint).map((item) => [item.number, item]))
    chapterRows.forEach((row, index) => {
      const blueprint = blueprintByNo.get(row.chapterNo)
      const title = clip(row.title || blueprint?.title || `第${row.chapterNo}章`, 80)
      const summary = clip(blueprint?.summary, 200)
      const heading = index === 0 ? '【章节摘要】\n' : ''
      units.push({
        text: `${heading}- 第${row.chapterNo}章《${title}》${summary ? `：${summary}` : ''}`,
        group: 2,
        chapters: 1,
      })
    })
  }

  if (includeUnresolved) {
    const rows = db.select({
      title: schema.novelForeshadows.title,
      setupChapter: schema.novelForeshadows.setupChapter,
      payoffChapter: schema.novelForeshadows.payoffChapter,
      status: schema.novelForeshadows.status,
      evidenceQuote: schema.novelForeshadows.evidenceQuote,
    }).from(schema.novelForeshadows)
      .where(eq(schema.novelForeshadows.novelId, novelId))
      .orderBy(schema.novelForeshadows.setupChapter, schema.novelForeshadows.id)
      .all()
      .filter((row) => row.status !== 'paid' && row.status !== 'abandoned')
    rows.forEach((row, index) => {
      const status = FORESHADOW_STATUS_LABELS[String(row.status)] || String(row.status || '')
      const setup = row.setupChapter ? `｜埋设：第${row.setupChapter}章` : ''
      const payoff = row.payoffChapter ? `｜计划回收：第${row.payoffChapter}章` : ''
      const evidence = row.evidenceQuote ? `｜线索：${clip(row.evidenceQuote, 80)}` : ''
      const heading = index === 0 ? '【未回收伏笔】\n' : ''
      units.push({
        text: `${heading}- 《${clip(row.title, 60)}》｜${status}${setup}${payoff}${evidence}`,
        group: 3,
        foreshadows: 1,
      })
    })
  }

  if (includeAnnotations) {
    // 孤儿批注的引文已不在正文中，纳入会误导改编
    const rows = db.select({
      chapterNo: schema.novelAnnotations.chapterNo,
      quote: schema.novelAnnotations.quote,
      note: schema.novelAnnotations.note,
      kind: schema.novelAnnotations.kind,
      status: schema.novelAnnotations.status,
    }).from(schema.novelAnnotations)
      .where(and(
        eq(schema.novelAnnotations.novelId, novelId),
        inArray(schema.novelAnnotations.status, ['open', 'resolved']),
      ))
      .orderBy(schema.novelAnnotations.chapterNo, schema.novelAnnotations.startOffset)
      .all()
      .filter((row) => !chapterFilter || chapterFilter.has(row.chapterNo))
    rows.forEach((row, index) => {
      const kind = ANNOTATION_KIND_LABELS[String(row.kind)] || '批注'
      const state = row.status === 'resolved' ? '（已处理）' : ''
      const note = row.note ? `：${clip(row.note, 120)}` : ''
      const heading = index === 0 ? '【批注摘录】\n' : ''
      units.push({
        text: `${heading}- 第${row.chapterNo}章「${clip(row.quote, 80)}」${kind}${state}${note}`,
        group: 4,
        annotations: 1,
      })
    })
  }

  if (units.length === 1) {
    return {
      text: '',
      chars: 0,
      truncated: false,
      included: { chapters: 0, annotations: 0, foreshadows: 0 },
      max_chars: maxChars,
    }
  }

  const assembled = assemble(units, maxChars)
  return {
    text: assembled.text,
    chars: assembled.text.length,
    truncated: assembled.truncated,
    included: assembled.included,
    max_chars: maxChars,
  }
}
