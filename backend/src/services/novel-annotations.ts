import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getNovelSettings } from './app-settings.js'

export const ANNOTATION_KINDS = ['note', 'adapt', 'question'] as const
export const ANNOTATION_STATUSES = ['open', 'resolved', 'orphaned'] as const
export type AnnotationKind = typeof ANNOTATION_KINDS[number]
export type AnnotationStatus = typeof ANNOTATION_STATUSES[number]

const ANNOTATION_LIMIT = 500
const QUOTE_MAX = 500
const NOTE_MAX = 2000
const CONTEXT_MAX = 40

export class NovelAnnotationValidationError extends Error {}
export class NovelAnnotationNotFoundError extends Error {}

interface AnnotationInput {
  chapter_no?: unknown
  quote?: unknown
  start_offset?: unknown
  end_offset?: unknown
  prefix?: unknown
  suffix?: unknown
  note?: unknown
  kind?: unknown
  status?: unknown
}

interface Relocation {
  start_offset: number
  end_offset: number
  status: AnnotationStatus
  relocated: boolean
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function chapterContent(novelId: number, chapterNo: number): string {
  const row = db.select({ content: schema.novelChapters.content })
    .from(schema.novelChapters)
    .where(and(eq(schema.novelChapters.novelId, novelId), eq(schema.novelChapters.chapterNo, chapterNo)))
    .get()
  return String(row?.content || '')
}

/** 精确切片 → 锚点窗口内最近命中（同距取靠前）→ 孤儿态 */
export function relocateAnnotation(
  content: string,
  annotation: { quote: string; startOffset: number; endOffset: number; status: string },
  anchorWindow: number,
): Relocation {
  const quote = annotation.quote
  const start = annotation.startOffset
  const end = annotation.endOffset
  if (quote && start >= 0 && end > start && end <= content.length && content.slice(start, end) === quote) {
    return { start_offset: start, end_offset: end, status: annotation.status as AnnotationStatus, relocated: false }
  }
  if (quote) {
    const from = Math.max(0, start - anchorWindow)
    const to = Math.min(content.length, end + anchorWindow)
    let best = -1
    let index = content.indexOf(quote, from)
    while (index !== -1 && index + quote.length <= to) {
      if (best === -1 || Math.abs(index - start) < Math.abs(best - start)) best = index
      index = content.indexOf(quote, index + 1)
    }
    if (best !== -1) {
      return {
        start_offset: best,
        end_offset: best + quote.length,
        status: annotation.status === 'orphaned' ? 'open' : annotation.status as AnnotationStatus,
        relocated: true,
      }
    }
  }
  return {
    start_offset: start,
    end_offset: end,
    status: 'orphaned',
    relocated: false,
  }
}

function serialize(row: typeof schema.novelAnnotations.$inferSelect) {
  return {
    id: row.id,
    chapter_no: row.chapterNo,
    quote: row.quote,
    note: row.note,
    kind: row.kind,
    status: row.status,
    start_offset: row.startOffset,
    end_offset: row.endOffset,
    prefix: row.prefix,
    suffix: row.suffix,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function normalizeOffsets(input: AnnotationInput, content: string, current?: typeof schema.novelAnnotations.$inferSelect) {
  const quote = text(input.quote ?? current?.quote, QUOTE_MAX).trim()
  if (!quote) throw new NovelAnnotationValidationError('quote 不能为空')
  const rawStart = input.start_offset ?? current?.startOffset ?? 0
  const rawEnd = input.end_offset ?? current?.endOffset ?? 0
  const start = Number(rawStart)
  const end = Number(rawEnd)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    throw new NovelAnnotationValidationError('start_offset 与 end_offset 必须是升序非负整数')
  }
  if (end > content.length) {
    throw new NovelAnnotationValidationError('start_offset / end_offset 超出章节正文长度')
  }
  if (content.slice(start, end) === quote) return { quote, start, end }
  const found = content.indexOf(quote)
  if (found === -1) throw new NovelAnnotationValidationError('引文未在当前章节正文中找到')
  return { quote, start: found, end: found + quote.length }
}

function annotationRow(novelId: number, annotationId: number) {
  return db.select().from(schema.novelAnnotations)
    .where(and(eq(schema.novelAnnotations.id, annotationId), eq(schema.novelAnnotations.novelId, novelId)))
    .get()
}

export function listAnnotations(
  novelId: number,
  options: { chapterNo?: number; statuses?: string[] } = {},
) {
  const conditions = [eq(schema.novelAnnotations.novelId, novelId)]
  if (options.chapterNo) conditions.push(eq(schema.novelAnnotations.chapterNo, options.chapterNo))
  if (options.statuses?.length) conditions.push(inArray(schema.novelAnnotations.status, options.statuses))
  const rows = db.select().from(schema.novelAnnotations)
    .where(and(...conditions))
    .orderBy(schema.novelAnnotations.chapterNo, schema.novelAnnotations.startOffset)
    .all()

  const anchorWindow = getNovelSettings().annotations.anchorWindow
  const chapterNos = [...new Set(rows.map((row) => row.chapterNo))]
  const contentByNo = new Map<number, string>()
  if (chapterNos.length) {
    const chapterRows = db.select({
      chapterNo: schema.novelChapters.chapterNo,
      content: schema.novelChapters.content,
    }).from(schema.novelChapters)
      .where(and(eq(schema.novelChapters.novelId, novelId), inArray(schema.novelChapters.chapterNo, chapterNos)))
      .all()
    for (const row of chapterRows) contentByNo.set(row.chapterNo, String(row.content || ''))
  }

  const ts = now()
  return rows.map((row) => {
    const relocation = relocateAnnotation(
      contentByNo.get(row.chapterNo) || '',
      { quote: String(row.quote || ''), startOffset: row.startOffset ?? 0, endOffset: row.endOffset ?? 0, status: row.status || 'open' },
      anchorWindow,
    )
    if (
      relocation.start_offset !== row.startOffset
      || relocation.end_offset !== row.endOffset
      || relocation.status !== row.status
    ) {
      db.update(schema.novelAnnotations)
        .set({ startOffset: relocation.start_offset, endOffset: relocation.end_offset, status: relocation.status, updatedAt: ts })
        .where(eq(schema.novelAnnotations.id, row.id))
        .run()
      return serialize({
        ...row,
        startOffset: relocation.start_offset,
        endOffset: relocation.end_offset,
        status: relocation.status,
        updatedAt: ts,
      })
    }
    return serialize(row)
  })
}

export function createAnnotation(novelId: number, input: AnnotationInput) {
  const chapterNo = Number(input.chapter_no)
  if (!Number.isSafeInteger(chapterNo) || chapterNo < 1) {
    throw new NovelAnnotationValidationError('chapter_no 必须是正整数')
  }
  const kind = typeof input.kind === 'string' && (ANNOTATION_KINDS as readonly string[]).includes(input.kind)
    ? input.kind
    : 'note'

  const count = db.select({ count: sql<number>`count(*)` }).from(schema.novelAnnotations)
    .where(and(eq(schema.novelAnnotations.novelId, novelId), eq(schema.novelAnnotations.chapterNo, chapterNo)))
    .get()
  if (Number(count?.count || 0) >= ANNOTATION_LIMIT) {
    throw new NovelAnnotationValidationError(`单章批注不能超过 ${ANNOTATION_LIMIT} 条`)
  }

  const content = chapterContent(novelId, chapterNo)
  const offsets = normalizeOffsets(input, content)
  const ts = now()
  const inserted = db.insert(schema.novelAnnotations).values({
    novelId,
    chapterNo,
    quote: offsets.quote,
    startOffset: offsets.start,
    endOffset: offsets.end,
    prefix: text(input.prefix, CONTEXT_MAX),
    suffix: text(input.suffix, CONTEXT_MAX),
    note: text(input.note, NOTE_MAX),
    kind,
    status: 'open',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const row = annotationRow(novelId, Number(inserted.lastInsertRowid))
  if (!row) throw new NovelAnnotationNotFoundError('批注不存在')
  return serialize(row)
}

export function updateAnnotation(novelId: number, annotationId: number, input: AnnotationInput) {
  const current = annotationRow(novelId, annotationId)
  if (!current) throw new NovelAnnotationNotFoundError('批注不存在')
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new NovelAnnotationValidationError('请求体必须是对象')
  }

  const updates: Partial<typeof schema.novelAnnotations.$inferInsert> = { updatedAt: now() }
  if ('note' in input) updates.note = text(input.note, NOTE_MAX)
  if ('kind' in input) {
    if (typeof input.kind !== 'string' || !(ANNOTATION_KINDS as readonly string[]).includes(input.kind)) {
      throw new NovelAnnotationValidationError(`kind 必须是 ${ANNOTATION_KINDS.join(' / ')}`)
    }
    updates.kind = input.kind
  }
  if ('status' in input) {
    if (typeof input.status !== 'string' || !(ANNOTATION_STATUSES as readonly string[]).includes(input.status)) {
      throw new NovelAnnotationValidationError(`status 必须是 ${ANNOTATION_STATUSES.join(' / ')}`)
    }
    updates.status = input.status
  }

  const rebinding = ['quote', 'start_offset', 'end_offset'].some((key) => key in input)
  if (rebinding) {
    const content = chapterContent(novelId, current.chapterNo)
    const offsets = normalizeOffsets(input, content, current)
    updates.quote = offsets.quote
    updates.startOffset = offsets.start
    updates.endOffset = offsets.end
    updates.prefix = text(input.prefix, CONTEXT_MAX)
    updates.suffix = text(input.suffix, CONTEXT_MAX)
  }

  db.update(schema.novelAnnotations).set(updates)
    .where(and(eq(schema.novelAnnotations.id, annotationId), eq(schema.novelAnnotations.novelId, novelId)))
    .run()
  const row = annotationRow(novelId, annotationId)
  if (!row) throw new NovelAnnotationNotFoundError('批注不存在')
  return serialize(row)
}

export function deleteAnnotation(novelId: number, annotationId: number): boolean {
  const current = annotationRow(novelId, annotationId)
  if (!current) return false
  db.delete(schema.novelAnnotations)
    .where(and(eq(schema.novelAnnotations.id, annotationId), eq(schema.novelAnnotations.novelId, novelId)))
    .run()
  return true
}
