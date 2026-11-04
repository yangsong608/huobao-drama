import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { parseChapterBlueprint } from './novel/blueprint.js'
import {
  DEFAULT_NARRATIVE_PERSON,
  normalizeNarrativePerson,
  readStoryAtlas,
} from './novel/story-atlas.js'
import { importSplitOptions, mappingNeedsUpdate, planContentHashes } from './novel-sync-status.js'

export class NovelValidationError extends Error {}

const DEFAULT_CHAPTERS = 100
const DEFAULT_WORD_NUMBER = 3000

const UPDATE_FIELDS = [
  'title', 'topic', 'genre', 'background', 'writing_style', 'number_of_chapters', 'word_number', 'user_guidance',
  'core_seed', 'character_dynamics', 'world_building', 'plot_architecture', 'character_state',
  'chapter_blueprint', 'global_summary', 'graph_meta', 'architecture_generated', 'blueprint_generated',
  'narrative_person',
] as const

// Drizzle 的 .set() 只认 JS 属性名（camelCase），这里显式映射请求字段
const TEXT_FIELD_MAP = {
  topic: 'topic',
  background: 'background',
  user_guidance: 'userGuidance',
  core_seed: 'coreSeed',
  character_dynamics: 'characterDynamics',
  world_building: 'worldBuilding',
  plot_architecture: 'plotArchitecture',
  character_state: 'characterState',
  chapter_blueprint: 'chapterBlueprint',
  global_summary: 'globalSummary',
  graph_meta: 'graphMeta',
} as const satisfies Record<string, keyof typeof schema.novels.$inferInsert>

export interface NovelWritingStyle {
  key: string
  name: string
  prompt: string
}

export interface CreateNovelInput {
  title?: unknown
  topic?: unknown
  genre?: unknown
  background?: unknown
  writing_style?: unknown
  number_of_chapters?: unknown
  word_number?: unknown
  user_guidance?: unknown
  narrative_person?: unknown
}

type NovelRow = typeof schema.novels.$inferSelect

function maxChapters(): number {
  const n = Number(process.env.NOVEL_MAX_CHAPTERS)
  return Number.isFinite(n) && n > 0 ? n : 500
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
}

export function parseGenre(value: unknown): string[] {
  let list: unknown[] = []
  if (Array.isArray(value)) {
    list = value
  } else if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      list = Array.isArray(parsed) ? parsed : value.split(/[,，、]/)
    } catch {
      list = value.split(/[,，、]/)
    }
  }
  return [...new Set(list
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))]
}

const WRITING_STYLE_PROMPT_MAX = 4000

/** 文风以 {key,name,prompt} 快照存库：预设后续被改写也不影响已创建作品 */
export function parseWritingStyle(value: unknown): NovelWritingStyle | null {
  let raw: unknown = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    try { raw = JSON.parse(trimmed) } catch { return null }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim().slice(0, WRITING_STYLE_PROMPT_MAX) : ''
  if (!prompt) return null
  const key = typeof record.key === 'string' ? record.key.trim().slice(0, 80) : ''
  const name = typeof record.name === 'string' ? record.name.trim().slice(0, 80) : ''
  return {
    key: key || 'custom',
    name: name || key || '自定义',
    prompt,
  }
}

function withParsed<T extends NovelRow>(row: T) {
  return {
    ...row,
    genre: parseGenre(row.genre),
    narrativePerson: normalizeNarrativePerson(row.narrativePerson),
    writingStyle: parseWritingStyle(row.writingStyle),
  }
}

function requireTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new NovelValidationError('title 不能为空')
  return value.trim()
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new NovelValidationError('文本字段必须是字符串')
  const trimmed = value.trim()
  return trimmed || null
}

function parseImportSummary(value: string | null): unknown {
  if (!value) return null
  try { return JSON.parse(value) } catch { return null }
}

export function listNovels(params: { keyword?: string; status?: string; page?: number; pageSize?: number } = {}) {
  const page = Math.max(1, Math.floor(Number(params.page) || 1))
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(params.pageSize) || 20)))
  const keyword = params.keyword?.trim()

  let rows = db.select().from(schema.novels)
    .where(isNull(schema.novels.deletedAt))
    .orderBy(desc(schema.novels.updatedAt))
    .all()
  if (keyword) rows = rows.filter((row) => row.title.includes(keyword))
  if (params.status) rows = rows.filter((row) => row.status === params.status)

  const total = rows.length
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize)
  const ids = new Set(pageRows.map((row) => row.id))

  const writtenCounts = new Map<number, number>()
  if (ids.size) {
    const counts = db.select({
      novelId: schema.novelChapters.novelId,
      written: sql<number>`sum(case when length(trim(coalesce(content, ''))) > 0 then 1 else 0 end)`,
    }).from(schema.novelChapters).groupBy(schema.novelChapters.novelId).all()
    for (const row of counts) writtenCounts.set(row.novelId, Number(row.written) || 0)
  }

  const importedNovelIds = new Set<number>()
  const updatedNovelIds = new Set<number>()
  if (ids.size) {
    const imports = db.select().from(schema.novelImports).all()
      .filter((row) => ids.has(row.novelId))
    for (const row of imports) importedNovelIds.add(row.novelId)

    const importIds = imports.map((row) => row.id)
    const mappings = importIds.length
      ? db.select().from(schema.novelImportEpisodes)
          .where(inArray(schema.novelImportEpisodes.importId, importIds))
          .all()
      : []
    const novelIds = [...new Set(imports.map((row) => row.novelId))]
    const chapters = novelIds.length
      ? db.select({
          novelId: schema.novelChapters.novelId,
          chapterNo: schema.novelChapters.chapterNo,
          title: schema.novelChapters.title,
          content: schema.novelChapters.content,
        }).from(schema.novelChapters)
          .where(inArray(schema.novelChapters.novelId, novelIds))
          .all()
      : []
    const chapterByKey = new Map(chapters.map((chapter) => [`${chapter.novelId}:${chapter.chapterNo}`, chapter]))
    const planHashes = new Map<string, string[]>()
    const importById = new Map(imports.map((row) => [row.id, row]))
    for (const mapping of mappings) {
      const imp = importById.get(mapping.importId)
      if (!imp || imp.status === 'orphaned' || mapping.status === 'orphaned') continue
      const key = `${imp.id}:${mapping.chapterNo}`
      let hashes = planHashes.get(key)
      if (!hashes) {
        const chapter = chapterByKey.get(`${imp.novelId}:${mapping.chapterNo}`)
        hashes = chapter ? planContentHashes(chapter, importSplitOptions(imp)) : []
        planHashes.set(key, hashes)
      }
      if (mappingNeedsUpdate(mapping, hashes)) updatedNovelIds.add(imp.novelId)
    }
  }

  return {
    items: pageRows.map((row) => ({
      id: row.id,
      title: row.title,
      topic: row.topic,
      genre: parseGenre(row.genre),
      numberOfChapters: row.numberOfChapters,
      wordNumber: row.wordNumber,
      status: row.status,
      architectureGenerated: row.architectureGenerated,
      blueprintGenerated: row.blueprintGenerated,
      writtenChapters: writtenCounts.get(row.id) ?? 0,
      hasImport: importedNovelIds.has(row.id),
      hasUpdate: updatedNovelIds.has(row.id),
      updatedAt: row.updatedAt,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  }
}

export function getNovel(id: number) {
  const row = db.select().from(schema.novels)
    .where(and(eq(schema.novels.id, id), isNull(schema.novels.deletedAt)))
    .get()
  if (!row) return null

  const chapters = db.select().from(schema.novelChapters)
    .where(eq(schema.novelChapters.novelId, id))
    .orderBy(schema.novelChapters.chapterNo)
    .all()
  const imports = db.select().from(schema.novelImports)
    .where(eq(schema.novelImports.novelId, id))
    .orderBy(desc(schema.novelImports.updatedAt))
    .all()
    .map((item) => ({ ...item, lastSyncSummary: parseImportSummary(item.lastSyncSummary) }))

  const atlas = readStoryAtlas(row)
  return {
    ...withParsed(row),
    timelineEvents: atlas.timelineEvents,
    worldMap: atlas.worldMap,
    chapters,
    blueprintChapters: parseChapterBlueprint(row.chapterBlueprint),
    imports,
  }
}

export function createNovel(input: CreateNovelInput) {
  const title = requireTitle(input.title)
  const writingStyle = parseWritingStyle(input.writing_style)
  const ts = now()
  const insert = db.insert(schema.novels).values({
    title,
    topic: optionalText(input.topic),
    genre: JSON.stringify(parseGenre(input.genre)),
    background: optionalText(input.background),
    writingStyle: writingStyle ? JSON.stringify(writingStyle) : null,
    numberOfChapters: clampInt(input.number_of_chapters, 1, maxChapters(), DEFAULT_CHAPTERS),
    wordNumber: clampInt(input.word_number, 100, 20000, DEFAULT_WORD_NUMBER),
    userGuidance: optionalText(input.user_guidance),
    narrativePerson: normalizeNarrativePerson(input.narrative_person, DEFAULT_NARRATIVE_PERSON),
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).run()

  const row = db.select().from(schema.novels)
    .where(eq(schema.novels.id, Number(insert.lastInsertRowid)))
    .get()
  if (!row) throw new NovelValidationError('小说创建失败')
  return withParsed(row)
}

export function updateNovel(id: number, patch: Record<string, unknown>) {
  const existing = db.select().from(schema.novels)
    .where(and(eq(schema.novels.id, id), isNull(schema.novels.deletedAt)))
    .get()
  if (!existing) return null

  const updates: Partial<typeof schema.novels.$inferInsert> = {}
  for (const field of UPDATE_FIELDS) {
    if (!(field in patch)) continue
    const value = patch[field]
    switch (field) {
      case 'title':
        updates.title = requireTitle(value)
        break
      case 'genre':
        updates.genre = JSON.stringify(parseGenre(value))
        break
      case 'writing_style': {
        const style = parseWritingStyle(value)
        updates.writingStyle = style ? JSON.stringify(style) : null
        break
      }
      case 'number_of_chapters':
        updates.numberOfChapters = clampInt(value, 1, maxChapters(), existing.numberOfChapters ?? DEFAULT_CHAPTERS)
        break
      case 'word_number':
        updates.wordNumber = clampInt(value, 100, 20000, existing.wordNumber ?? DEFAULT_WORD_NUMBER)
        break
      case 'architecture_generated':
        if (typeof value !== 'boolean') throw new NovelValidationError(`${field} 必须是布尔值`)
        updates.architectureGenerated = value
        break
      case 'blueprint_generated':
        if (typeof value !== 'boolean') throw new NovelValidationError(`${field} 必须是布尔值`)
        updates.blueprintGenerated = value
        break
      case 'narrative_person': {
        if (typeof value !== 'string' || !['first', 'third_limited', 'third_omniscient'].includes(value)) {
          throw new NovelValidationError('narrative_person 必须是 first/third_limited/third_omniscient')
        }
        updates.narrativePerson = value
        break
      }
      default:
        updates[TEXT_FIELD_MAP[field as keyof typeof TEXT_FIELD_MAP]] = optionalText(value)
    }
  }

  if (!Object.keys(updates).length) return withParsed(existing)
  updates.updatedAt = now()
  db.update(schema.novels).set(updates).where(eq(schema.novels.id, id)).run()
  const row = db.select().from(schema.novels).where(eq(schema.novels.id, id)).get()
  return row ? withParsed(row) : null
}

export function deleteNovel(id: number): boolean {
  const existing = db.select().from(schema.novels)
    .where(and(eq(schema.novels.id, id), isNull(schema.novels.deletedAt)))
    .get()
  if (!existing) return false

  const ts = now()
  db.transaction((tx) => {
    tx.update(schema.novels)
      .set({ deletedAt: ts, updatedAt: ts })
      .where(eq(schema.novels.id, id))
      .run()
    tx.update(schema.novelImports)
      .set({ status: 'orphaned', updatedAt: ts })
      .where(eq(schema.novelImports.novelId, id))
      .run()
  })
  return true
}

export function refreshNovelStatus(id: number): string {
  const novel = db.select().from(schema.novels).where(eq(schema.novels.id, id)).get()
  if (!novel) throw new NovelValidationError('小说不存在')

  const written = Number(db.select({ count: sql<number>`count(*)` })
    .from(schema.novelChapters)
    .where(and(
      eq(schema.novelChapters.novelId, id),
      sql`length(trim(coalesce(content, ''))) > 0`,
    ))
    .get()?.count ?? 0)

  const target = novel.numberOfChapters ?? DEFAULT_CHAPTERS
  const status = written === 0 ? 'draft' : written >= target ? 'completed' : 'writing'
  if (status !== novel.status) {
    db.update(schema.novels).set({ status }).where(eq(schema.novels.id, id)).run()
  }
  return status
}
