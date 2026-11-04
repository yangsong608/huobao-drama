import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { contentHash, countWords } from '../utils/text-hash.js'
import { refreshNovelStatus } from './novels.js'

export const CHAPTER_STATUSES = ['draft', 'final'] as const
export type ChapterStatus = typeof CHAPTER_STATUSES[number]

export class ChapterValidationError extends Error {}
export class ChapterConflictError extends Error {
  current: typeof schema.novelChapters.$inferSelect | null
  constructor(current: typeof schema.novelChapters.$inferSelect | null) {
    super('章节已被修改，请刷新后重试')
    this.current = current
  }
}

export interface ChapterPatch {
  content?: string
  title?: string | null
  status?: string
  baseUpdatedAt?: string | null
}

function maxContentChars(): number {
  const n = Number(process.env.NOVEL_MAX_CONTENT_CHARS)
  return Number.isFinite(n) && n > 0 ? n : 30000
}

function findNovel(novelId: number) {
  return db.select({ id: schema.novels.id, deletedAt: schema.novels.deletedAt })
    .from(schema.novels)
    .where(eq(schema.novels.id, novelId))
    .get()
}

function findChapter(novelId: number, chapterNo: number) {
  return db.select().from(schema.novelChapters)
    .where(and(eq(schema.novelChapters.novelId, novelId), eq(schema.novelChapters.chapterNo, chapterNo)))
    .get()
}

export function listChapters(novelId: number) {
  return db.select({
    id: schema.novelChapters.id,
    novelId: schema.novelChapters.novelId,
    chapterNo: schema.novelChapters.chapterNo,
    title: schema.novelChapters.title,
    wordCount: schema.novelChapters.wordCount,
    contentHash: schema.novelChapters.contentHash,
    status: schema.novelChapters.status,
    createdAt: schema.novelChapters.createdAt,
    updatedAt: schema.novelChapters.updatedAt,
  }).from(schema.novelChapters)
    .where(eq(schema.novelChapters.novelId, novelId))
    .orderBy(schema.novelChapters.chapterNo)
    .all()
}

export function getChapter(novelId: number, chapterNo: number) {
  return findChapter(novelId, chapterNo) ?? null
}

export function saveChapter(novelId: number, chapterNo: number, patch: ChapterPatch) {
  const novel = findNovel(novelId)
  if (!novel || novel.deletedAt) throw new ChapterValidationError('小说不存在')
  if (!Number.isInteger(chapterNo) || chapterNo < 1) throw new ChapterValidationError('章节号必须是正整数')

  const existing = findChapter(novelId, chapterNo) ?? null
  if (patch.baseUpdatedAt && existing?.updatedAt !== patch.baseUpdatedAt) {
    throw new ChapterConflictError(existing)
  }
  if (patch.status !== undefined && !(CHAPTER_STATUSES as readonly string[]).includes(patch.status)) {
    throw new ChapterValidationError(`status 必须是 ${CHAPTER_STATUSES.join(' / ')}`)
  }
  if (patch.content !== undefined && patch.content.length > maxContentChars()) {
    throw new ChapterValidationError(`章节正文超过 ${maxContentChars()} 字上限`)
  }

  const ts = now()
  let savedId = 0

  db.transaction((tx) => {
    if (!existing) {
      const insert = tx.insert(schema.novelChapters).values({
        novelId,
        chapterNo,
        title: patch.title === undefined ? `第${chapterNo}章` : patch.title,
        content: patch.content ?? '',
        wordCount: patch.content === undefined ? 0 : countWords(patch.content),
        contentHash: patch.content === undefined ? null : contentHash(patch.content),
        status: patch.status ?? 'draft',
        createdAt: ts,
        updatedAt: ts,
      }).run()
      savedId = Number(insert.lastInsertRowid)
    } else {
      const updates: Partial<typeof schema.novelChapters.$inferInsert> = { updatedAt: ts }
      if (patch.title !== undefined) updates.title = patch.title
      if (patch.status !== undefined) updates.status = patch.status
      if (patch.content !== undefined) {
        updates.content = patch.content
        updates.wordCount = countWords(patch.content)
        updates.contentHash = contentHash(patch.content)
      }
      tx.update(schema.novelChapters)
        .set(updates)
        .where(and(eq(schema.novelChapters.novelId, novelId), eq(schema.novelChapters.chapterNo, chapterNo)))
        .run()
      savedId = existing.id
    }

    if (patch.content !== undefined) {
      tx.update(schema.novels)
        .set({ contentUpdatedAt: ts, updatedAt: ts })
        .where(eq(schema.novels.id, novelId))
        .run()
    } else {
      tx.update(schema.novels)
        .set({ updatedAt: ts })
        .where(eq(schema.novels.id, novelId))
        .run()
    }
  })

  const saved = db.select().from(schema.novelChapters)
    .where(eq(schema.novelChapters.id, savedId))
    .get()
  if (!saved) throw new ChapterValidationError('章节保存失败')

  refreshNovelStatus(novelId)
  return saved
}
