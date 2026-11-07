import { and, eq, isNull, or } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getNovelSettings } from './app-settings.js'
import { parseChapterBlueprint } from './novel/blueprint.js'

export const FORESHADOW_STATUSES = ['planned', 'planted', 'reinforced', 'paid', 'abandoned'] as const
export const FORESHADOW_SOURCES = ['manual', 'blueprint', 'agent'] as const
export type ForeshadowStatus = typeof FORESHADOW_STATUSES[number]
export type ForeshadowSource = typeof FORESHADOW_SOURCES[number]

const TITLE_MAX = 120
const EVIDENCE_MAX = 500
const NOTE_MAX = 1000

const TRANSITIONS: Record<ForeshadowStatus, ForeshadowStatus[]> = {
  planned: ['planted', 'abandoned'],
  planted: ['reinforced', 'paid', 'abandoned'],
  reinforced: ['paid', 'abandoned'],
  paid: ['planted'],
  abandoned: ['planned'],
}

export class NovelForeshadowValidationError extends Error {}
export class NovelForeshadowNotFoundError extends Error {}
export class NovelForeshadowConflictError extends Error {}

interface ForeshadowInput {
  title?: unknown
  setup_chapter?: unknown
  payoff_chapter?: unknown
  status?: unknown
  evidence_quote?: unknown
  note?: unknown
  source?: unknown
}

function novelNumber(novelId: number, column: 'numberOfChapters' | 'chapterBlueprint') {
  const row = db.select({
    numberOfChapters: schema.novels.numberOfChapters,
    chapterBlueprint: schema.novels.chapterBlueprint,
  }).from(schema.novels)
    .where(and(eq(schema.novels.id, novelId), isNull(schema.novels.deletedAt)))
    .get()
  if (!row) throw new NovelForeshadowNotFoundError('小说不存在')
  return row[column]
}

function chapterBound(novelId: number) {
  return Number(novelNumber(novelId, 'numberOfChapters')) || 0
}

function requiredTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title) throw new NovelForeshadowValidationError('title 不能为空')
  if (title.length > TITLE_MAX) throw new NovelForeshadowValidationError(`title 不能超过 ${TITLE_MAX} 字`)
  return title
}

function optionalText(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new NovelForeshadowValidationError(`${label} 必须是字符串`)
  if (value.length > max) throw new NovelForeshadowValidationError(`${label} 不能超过 ${max} 字`)
  return value
}

function parseChapter(value: unknown, label: string, bound: number): number {
  const chapter = Number(value)
  if (!Number.isSafeInteger(chapter) || chapter < 1 || chapter > bound) {
    throw new NovelForeshadowValidationError(`${label} 必须在 1 到 ${bound} 之间`)
  }
  return chapter
}

function parseOptionalChapter(value: unknown, label: string, bound: number): number | null {
  if (value === undefined || value === null || value === '') return null
  return parseChapter(value, label, bound)
}

function parseSource(value: unknown, fallback: ForeshadowSource): ForeshadowSource {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || !(FORESHADOW_SOURCES as readonly string[]).includes(value)) {
    throw new NovelForeshadowValidationError(`source 必须是 ${FORESHADOW_SOURCES.join(' / ')}`)
  }
  return value as ForeshadowSource
}

function assertTransition(from: string, to: ForeshadowStatus) {
  if (from === to) return
  const allowed = TRANSITIONS[from as ForeshadowStatus] || []
  if (!allowed.includes(to)) {
    throw new NovelForeshadowConflictError(`不允许从 ${from} 流转到 ${to}`)
  }
}

function serialize(row: typeof schema.novelForeshadows.$inferSelect) {
  return {
    id: row.id,
    novel_id: row.novelId,
    title: row.title,
    setup_chapter: row.setupChapter,
    payoff_chapter: row.payoffChapter,
    status: row.status,
    evidence_quote: row.evidenceQuote,
    note: row.note,
    source: row.source,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function foreshadowRow(novelId: number, foreshadowId: number) {
  return db.select().from(schema.novelForeshadows)
    .where(and(eq(schema.novelForeshadows.id, foreshadowId), eq(schema.novelForeshadows.novelId, novelId)))
    .get()
}

export function listForeshadows(
  novelId: number,
  options: { statuses?: string[]; chapterNo?: number } = {},
) {
  const conditions = [eq(schema.novelForeshadows.novelId, novelId)]
  if (options.statuses?.length) {
    conditions.push(
      or(...options.statuses.map((status) => eq(schema.novelForeshadows.status, status)))!,
    )
  }
  if (options.chapterNo) {
    conditions.push(
      or(
        eq(schema.novelForeshadows.setupChapter, options.chapterNo),
        eq(schema.novelForeshadows.payoffChapter, options.chapterNo),
      )!,
    )
  }
  return db.select().from(schema.novelForeshadows)
    .where(and(...conditions))
    .orderBy(schema.novelForeshadows.setupChapter, schema.novelForeshadows.id)
    .all()
    .map(serialize)
}

export function createForeshadow(novelId: number, input: ForeshadowInput) {
  const bound = chapterBound(novelId)
  const title = requiredTitle(input.title)
  const setupChapter = parseChapter(input.setup_chapter, 'setup_chapter', bound)
  const payoffChapter = parseOptionalChapter(input.payoff_chapter, 'payoff_chapter', bound)
  if (payoffChapter !== null && payoffChapter < setupChapter) {
    throw new NovelForeshadowValidationError('payoff_chapter 不能早于 setup_chapter')
  }
  const status = input.status === undefined || input.status === null ? 'planned' : input.status
  if (typeof status !== 'string' || !(FORESHADOW_STATUSES as readonly string[]).includes(status)) {
    throw new NovelForeshadowValidationError(`status 必须是 ${FORESHADOW_STATUSES.join(' / ')}`)
  }
  const ts = now()
  const inserted = db.insert(schema.novelForeshadows).values({
    novelId,
    title,
    setupChapter,
    payoffChapter,
    status,
    evidenceQuote: optionalText(input.evidence_quote, EVIDENCE_MAX, 'evidence_quote'),
    note: optionalText(input.note, NOTE_MAX, 'note'),
    source: parseSource(input.source, 'manual'),
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const row = foreshadowRow(novelId, Number(inserted.lastInsertRowid))
  if (!row) throw new NovelForeshadowNotFoundError('伏笔不存在')
  return serialize(row)
}

export function updateForeshadow(novelId: number, foreshadowId: number, input: ForeshadowInput) {
  const current = foreshadowRow(novelId, foreshadowId)
  if (!current) throw new NovelForeshadowNotFoundError('伏笔不存在')
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new NovelForeshadowValidationError('请求体必须是对象')
  }

  const bound = chapterBound(novelId)
  const updates: Partial<typeof schema.novelForeshadows.$inferInsert> = { updatedAt: now() }
  if ('title' in input) updates.title = requiredTitle(input.title)
  const setupChapter = 'setup_chapter' in input
    ? parseChapter(input.setup_chapter, 'setup_chapter', bound)
    : current.setupChapter
  if (setupChapter === null) throw new NovelForeshadowValidationError('setup_chapter 不能为空')
  const payoffChapter = 'payoff_chapter' in input
    ? parseOptionalChapter(input.payoff_chapter, 'payoff_chapter', bound)
    : current.payoffChapter
  if (payoffChapter !== null && payoffChapter < setupChapter) {
    throw new NovelForeshadowValidationError('payoff_chapter 不能早于 setup_chapter')
  }
  if ('setup_chapter' in input) updates.setupChapter = setupChapter
  if ('payoff_chapter' in input) updates.payoffChapter = payoffChapter
  if ('evidence_quote' in input) updates.evidenceQuote = optionalText(input.evidence_quote, EVIDENCE_MAX, 'evidence_quote')
  if ('note' in input) updates.note = optionalText(input.note, NOTE_MAX, 'note')
  if ('source' in input) updates.source = parseSource(input.source, 'manual')
  if ('status' in input) {
    if (typeof input.status !== 'string' || !(FORESHADOW_STATUSES as readonly string[]).includes(input.status)) {
      throw new NovelForeshadowValidationError(`status 必须是 ${FORESHADOW_STATUSES.join(' / ')}`)
    }
    assertTransition(String(current.status || 'planned'), input.status as ForeshadowStatus)
    updates.status = input.status
  }

  db.update(schema.novelForeshadows).set(updates)
    .where(and(eq(schema.novelForeshadows.id, foreshadowId), eq(schema.novelForeshadows.novelId, novelId)))
    .run()
  const row = foreshadowRow(novelId, foreshadowId)
  if (!row) throw new NovelForeshadowNotFoundError('伏笔不存在')
  return serialize(row)
}

export function deleteForeshadow(novelId: number, foreshadowId: number): boolean {
  const current = foreshadowRow(novelId, foreshadowId)
  if (!current) return false
  db.delete(schema.novelForeshadows)
    .where(and(eq(schema.novelForeshadows.id, foreshadowId), eq(schema.novelForeshadows.novelId, novelId)))
    .run()
  return true
}

export function extractForeshadowCandidates(novelId: number) {
  const enabled = getNovelSettings().foreshadow.autoExtract
  if (!enabled) return { enabled: false, items: [] }
  const blueprint = String(novelNumber(novelId, 'chapterBlueprint') || '')
  if (!blueprint) return { enabled: true, items: [] }

  const existing = new Set(listForeshadows(novelId).map((item) => String(item.title || '').trim()))
  const items = parseChapterBlueprint(blueprint)
    .map((chapter) => ({
      title: String(chapter.foreshadowing || '').trim(),
      setup_chapter: chapter.number,
      evidence_quote: chapter.summary || '',
      source: 'blueprint' as const,
    }))
    .filter((item) => item.title && !existing.has(item.title))
    .map((item) => ({
      ...item,
      title: item.title.length > TITLE_MAX ? item.title.slice(0, TITLE_MAX) : item.title,
      evidence_quote: item.evidence_quote.slice(0, EVIDENCE_MAX),
    }))
  return { enabled: true, items }
}
