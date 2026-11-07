/**
 * V3 小说 → 短剧导入（P3-2）
 *
 * - previewNovelImport：章节范围、拆集预览、标题预览
 * - commitNovelImport：单事务建短剧/集/映射；request_id 幂等；AI 背景摘要事务外执行
 * - 拆集默认 words（1200 字），不跨章合并，单集仅映射一章
 */
import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { contentHash, countWords } from '../utils/text-hash.js'
import { normalizeBackground } from './drama-background.js'
import { buildStoryBible } from './drama-story-bible.js'
import { buildNovelContextPack, type ContextPackIncluded } from './novel-context-pack.js'
import { parseGenre } from './novels.js'
import { importSplitOptions, mappingNeedsUpdate, normalizeTargetWords, planContentHashes } from './novel-sync-status.js'
import { planEpisodes, type EpisodePlan, type ParsedChapter, type SplitMode } from './script-import.js'
import { callText } from './text-call.js'

export class NovelImportError extends Error {
  status: 400 | 404 | 409
  details?: Record<string, unknown>
  constructor(message: string, status: 400 | 404 | 409 = 400, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.details = details
  }
}

export type BackgroundMode = 'rule' | 'ai' | 'none'
export type NovelSplitMode = Exclude<SplitMode, 'legacy'>

const MAX_TITLE_CHARS = 120
const MAX_DESCRIPTION_CHARS = 1000
const BACKGROUND_WORLD_CHARS = 200
const DEFAULT_ASPECT_RATIO = '16:9'

type NovelRow = typeof schema.novels.$inferSelect
type ChapterRow = typeof schema.novelChapters.$inferSelect

export interface NovelImportInput {
  request_id?: string
  title?: string
  style?: string
  aspect_ratio?: string
  chapter_nos?: number[]
  split_mode?: string
  target_words?: number
  include_draft?: boolean
  background_mode?: string
  include_context_pack?: boolean
  context_pack_max_chars?: number
}

export interface NovelImportEpisodePreview {
  chapter_no: number
  part_no: number
  title: string
  char_count: number
}

export interface NovelImportPreview {
  novel_id: number
  title: string
  split_mode: NovelSplitMode
  target_words: number
  chapter_count: number
  episode_count: number
  chapters: { chapter_no: number; title: string; word_count: number; status: string }[]
  episodes: NovelImportEpisodePreview[]
  existing_imports: number
}

export interface NovelImportContextPackSummary {
  max_chars: number
  chars: number
  truncated: boolean
  included: ContextPackIncluded
}

export interface NovelImportResult {
  import_id: number
  drama_id: number
  episode_count: number
  episode_ids: number[]
  existing: boolean
  warnings: string[]
  context_pack: NovelImportContextPackSummary | null
}

export const CONTEXT_PACK_SKIPPED_WARNING = '上下文包生成失败，已跳过注入'

interface ImportPlan {
  novel: NovelRow
  rows: ChapterRow[]
  plans: EpisodePlan[]
  splitMode: NovelSplitMode
  targetWords: number
}

function requireNovel(novelId: number): NovelRow {
  const row = db.select().from(schema.novels)
    .where(and(eq(schema.novels.id, novelId), isNull(schema.novels.deletedAt)))
    .get()
  if (!row) throw new NovelImportError('小说不存在', 404)
  return row
}

function chapterTitle(row: ChapterRow): string {
  return (row.title || '').trim() || `第${row.chapterNo}章`
}

function truncateChars(text: unknown, max: number): string {
  const value = String(text ?? '').trim()
  if (!value) return ''
  const chars = [...value]
  return chars.length > max ? chars.slice(0, max).join('') : value
}

function normalizeSplitMode(value: unknown): NovelSplitMode {
  return value === 'chapter' ? 'chapter' : 'words'
}

function normalizeBackgroundMode(value: unknown): BackgroundMode {
  return value === 'ai' || value === 'none' ? value : 'rule'
}

function normalizeChapterNos(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length) return []
  return [...new Set(value.map((item) => Math.floor(Number(item))).filter((n) => Number.isInteger(n) && n > 0))]
}

function selectChapters(novelId: number, input: NovelImportInput): ChapterRow[] {
  const includeDraft = input.include_draft !== false
  const chapterNos = normalizeChapterNos(input.chapter_nos)
  let rows = db.select().from(schema.novelChapters)
    .where(eq(schema.novelChapters.novelId, novelId))
    .orderBy(schema.novelChapters.chapterNo)
    .all()
    .filter((row) => (row.content || '').trim())
  if (!includeDraft) rows = rows.filter((row) => row.status === 'final')
  if (chapterNos.length) rows = rows.filter((row) => chapterNos.includes(row.chapterNo))
  return rows
}

function planImport(novelId: number, input: NovelImportInput): ImportPlan {
  const novel = requireNovel(novelId)
  const rows = selectChapters(novelId, input)
  if (!rows.length) throw new NovelImportError('没有可导入的章节')

  const splitMode = normalizeSplitMode(input.split_mode)
  const targetWords = normalizeTargetWords(input.target_words)
  const chapters: ParsedChapter[] = rows.map((row) => {
    const content = row.content || ''
    return { index: row.chapterNo, title: chapterTitle(row), content, charCount: countWords(content) }
  })
  const plans = planEpisodes(chapters, { splitMode, targetWords })
  if (!plans.length) throw new NovelImportError('没有可导入的章节')
  return { novel, rows, plans, splitMode, targetWords }
}

export function previewNovelImport(novelId: number, input: NovelImportInput = {}): NovelImportPreview {
  const { novel, rows, plans, splitMode, targetWords } = planImport(novelId, input)
  const partCounters = new Map<number, number>()
  const episodes = plans.map((plan) => {
    const chapterNo = plan.chapterIndexes[0]
    const partNo = (partCounters.get(chapterNo) || 0) + 1
    partCounters.set(chapterNo, partNo)
    return { chapter_no: chapterNo, part_no: partNo, title: plan.title, char_count: plan.charCount }
  })
  const existing = db.select({ value: count() }).from(schema.novelImports)
    .where(eq(schema.novelImports.novelId, novelId))
    .get()

  return {
    novel_id: novelId,
    title: `《${novel.title}》短剧`,
    split_mode: splitMode,
    target_words: targetWords,
    chapter_count: rows.length,
    episode_count: plans.length,
    chapters: rows.map((row) => ({
      chapter_no: row.chapterNo,
      title: chapterTitle(row),
      word_count: row.wordCount ?? countWords(row.content || ''),
      status: row.status || 'draft',
    })),
    episodes,
    existing_imports: Number(existing?.value ?? 0),
  }
}

function ruleBackground(novel: Pick<NovelRow, 'topic' | 'coreSeed' | 'worldBuilding'>): string {
  return normalizeBackground([
    novel.topic,
    novel.coreSeed,
    truncateChars(novel.worldBuilding, BACKGROUND_WORLD_CHARS),
  ].filter(Boolean).join(' '))
}

/** 背景摘要：rule 规则截取；ai 调文本模型，失败回退 rule；none 留空 */
export async function buildBackground(
  novel: Pick<NovelRow, 'topic' | 'coreSeed' | 'worldBuilding'>,
  mode: BackgroundMode = 'rule',
  options: { fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const rule = ruleBackground(novel)
  if (mode === 'none') return ''
  if (mode !== 'ai') return rule

  const material = [novel.topic, novel.coreSeed, novel.worldBuilding].filter(Boolean).join('\n\n')
  if (!material.trim()) return ''
  try {
    const result = await callText({
      system: '你是短剧项目策划，擅长把小说设定压缩成画面可用的项目背景。',
      prompt: `请把以下小说设定压缩成不超过 400 字的项目背景，保留时代、地域、核心人物关系与主线冲突。只输出背景正文，不要标题或解释。\n\n${material}`,
      maxTokens: 500,
      temperature: 0.3,
      responseFormat: 'text',
      fetchImpl: options.fetchImpl,
    })
    return normalizeBackground(result.text) || rule
  } catch {
    return rule
  }
}

function existingImportResult(existing: typeof schema.novelImports.$inferSelect): NovelImportResult {
  const mappings = db.select().from(schema.novelImportEpisodes)
    .where(eq(schema.novelImportEpisodes.importId, existing.id))
    .all()
  let contextPack: NovelImportContextPackSummary | null = null
  const warnings: string[] = []
  try {
    const summary = JSON.parse(existing.lastSyncSummary || '{}')
    const stored = summary?.context_pack
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      const included = stored.included && typeof stored.included === 'object' ? stored.included : {}
      contextPack = {
        max_chars: Number(stored.max_chars) || 0,
        chars: Number(stored.chars) || 0,
        truncated: stored.truncated === true,
        included: {
          chapters: Number(included.chapters) || 0,
          annotations: Number(included.annotations) || 0,
          foreshadows: Number(included.foreshadows) || 0,
        },
      }
    } else if (stored === 'skipped') {
      warnings.push(CONTEXT_PACK_SKIPPED_WARNING)
    }
  } catch { /* 旧摘要或坏 JSON 视为未启用上下文包 */ }
  return {
    import_id: existing.id,
    drama_id: existing.dramaId,
    episode_count: mappings.length,
    episode_ids: mappings.map((row) => row.episodeId),
    existing: true,
    warnings,
    context_pack: contextPack,
  }
}

export interface NovelImportSummary {
  import_id: number
  drama_id: number
  drama_title: string | null
  drama_missing: boolean
  status: string
  mode: string
  episode_count: number
  last_synced_at: string | null
  source_updated_at: string | null
  created_at: string
  has_update: boolean
}

/** 导入列表：短剧标题、集数、最近同步时间；has_update 只比较已导入章节 */
export function listNovelImports(novelId: number): NovelImportSummary[] {
  const imports = db.select().from(schema.novelImports)
    .where(eq(schema.novelImports.novelId, novelId))
    .orderBy(desc(schema.novelImports.id))
    .all()
  if (!imports.length) return []

  const importIds = imports.map((row) => row.id)
  const mappings = db.select().from(schema.novelImportEpisodes)
    .where(inArray(schema.novelImportEpisodes.importId, importIds))
    .all()
  const dramaIds = [...new Set(imports.map((row) => row.dramaId))]
  const dramas = db.select().from(schema.dramas)
    .where(inArray(schema.dramas.id, dramaIds))
    .all()
  const chapters = db.select().from(schema.novelChapters)
    .where(eq(schema.novelChapters.novelId, novelId))
    .all()

  const dramaById = new Map(dramas.map((row) => [row.id, row]))
  const chaptersByNo = new Map(chapters.map((row) => [row.chapterNo, row]))
  const planHashesByImportChapter = new Map<string, string[]>()
  const planHashesFor = (importRow: ImportRow, chapterNo: number): string[] | undefined => {
    const chapter = chaptersByNo.get(chapterNo)
    if (!chapter) return undefined
    const key = `${importRow.id}:${chapterNo}`
    const cached = planHashesByImportChapter.get(key)
    if (cached) return cached
    const hashes = planContentHashes(chapter, importSplitOptions(importRow))
    planHashesByImportChapter.set(key, hashes)
    return hashes
  }
  const mappingsByImport = new Map<number, (typeof mappings)[number][]>()
  for (const mapping of mappings) {
    const list = mappingsByImport.get(mapping.importId) || []
    list.push(mapping)
    mappingsByImport.set(mapping.importId, list)
  }

  return imports.map((row) => {
    const drama = dramaById.get(row.dramaId)
    const items = mappingsByImport.get(row.id) || []
    const hasUpdate = row.status !== 'orphaned' && items.some((mapping) => {
      if (mapping.status === 'orphaned') return false
      return mappingNeedsUpdate(mapping, planHashesFor(row, mapping.chapterNo))
    })
    return {
      import_id: row.id,
      drama_id: row.dramaId,
      drama_title: drama?.title ?? null,
      drama_missing: !drama,
      status: row.status || 'active',
      mode: row.mode || 'manual',
      episode_count: items.length,
      last_synced_at: row.lastSyncedAt ?? null,
      source_updated_at: row.sourceUpdatedAt ?? null,
      created_at: row.createdAt,
      has_update: hasUpdate,
    }
  })
}

/** 删除导入映射，短剧保留；清空该短剧的 source_novel_id 与 metadata.import_id */
export function deleteNovelImport(novelId: number, importId: number): boolean {
  const existing = db.select().from(schema.novelImports)
    .where(and(eq(schema.novelImports.id, importId), eq(schema.novelImports.novelId, novelId)))
    .get()
  if (!existing) return false

  const ts = now()
  db.transaction((tx) => {
    tx.delete(schema.novelImportEpisodes)
      .where(eq(schema.novelImportEpisodes.importId, importId))
      .run()
    tx.delete(schema.novelImports)
      .where(eq(schema.novelImports.id, importId))
      .run()

    const drama = tx.select().from(schema.dramas)
      .where(eq(schema.dramas.id, existing.dramaId))
      .get()
    if (!drama) return
    let metadata: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(drama.metadata || '{}')
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed
    } catch { /* 保留非法 JSON 为无 metadata */ }
    delete metadata.import_id
    tx.update(schema.dramas)
      .set({
        sourceNovelId: null,
        metadata: Object.keys(metadata).length ? JSON.stringify(metadata) : null,
        updatedAt: ts,
      })
      .where(eq(schema.dramas.id, existing.dramaId))
      .run()
  })
  return true
}

export async function commitNovelImport(novelId: number, input: NovelImportInput = {}): Promise<NovelImportResult> {
  const requestId = typeof input.request_id === 'string' && input.request_id.trim()
    ? input.request_id.trim()
    : null
  if (requestId) {
    const existing = db.select().from(schema.novelImports)
      .where(eq(schema.novelImports.requestId, requestId))
      .get()
    if (existing) {
      if (existing.novelId !== novelId) throw new NovelImportError('request_id 已被其他小说使用')
      return existingImportResult(existing)
    }
  }

  const { novel, rows, plans, splitMode, targetWords } = planImport(novelId, input)
  const background = await buildBackground(novel, normalizeBackgroundMode(input.background_mode))

  const ts = now()
  const title = truncateChars(input.title, MAX_TITLE_CHARS) || `《${novel.title}》短剧`
  const style = typeof input.style === 'string' && input.style.trim() ? input.style.trim() : '3d'
  const aspectRatio = input.aspect_ratio === '9:16' ? '9:16' : DEFAULT_ASPECT_RATIO
  const genres = parseGenre(novel.genre)
  const bible = buildStoryBible(novel)
  let contextPackSummary: NovelImportContextPackSummary | null = null
  let contextPackState: NovelImportContextPackSummary | 'skipped' | 'off' = 'off'
  const warnings: string[] = []
  if (input.include_context_pack === true) {
    try {
      const pack = buildNovelContextPack(novelId, {
        chapter_nos: rows.map((row) => row.chapterNo),
        max_chars: input.context_pack_max_chars,
      })
      if (pack.text) bible.adaptationNotes = pack.text
      contextPackSummary = {
        max_chars: pack.max_chars,
        chars: pack.chars,
        truncated: pack.truncated,
        included: pack.included,
      }
      contextPackState = contextPackSummary
    } catch (error) {
      console.error('[novel-import] 上下文包生成失败', error instanceof Error ? error.message : error)
      warnings.push(CONTEXT_PACK_SKIPPED_WARNING)
      contextPackState = 'skipped'
    }
  }
  const storyBible = Object.keys(bible).length ? JSON.stringify(bible) : ''
  const description = truncateChars([novel.topic, novel.coreSeed].filter(Boolean).join(' '), MAX_DESCRIPTION_CHARS)
  const chapterByNo = new Map(rows.map((row) => [row.chapterNo, row]))

  let dramaId = 0
  let importId = 0
  const episodeIds: number[] = []

  db.transaction((tx) => {
    const dramaInsert = tx.insert(schema.dramas).values({
      title,
      description: description || null,
      genre: genres.length ? genres.join('、') : null,
      style,
      background: background || null,
      aspectRatio,
      totalEpisodes: plans.length,
      status: 'draft',
      tags: JSON.stringify(genres),
      sourceNovelId: novel.id,
      storyBible,
      createdAt: ts,
      updatedAt: ts,
    }).run()
    dramaId = getInsertId(dramaInsert)

    const importInsert = tx.insert(schema.novelImports).values({
      novelId: novel.id,
      dramaId,
      requestId,
      mode: 'manual',
      status: 'active',
      sourceUpdatedAt: novel.contentUpdatedAt || novel.updatedAt,
      lastSyncedAt: ts,
      lastSyncSummary: JSON.stringify({
        split_mode: splitMode,
        target_words: targetWords,
        context_pack: contextPackState,
      }),
      createdAt: ts,
      updatedAt: ts,
    }).run()
    importId = getInsertId(importInsert)

    const partCounters = new Map<number, number>()
    plans.forEach((plan, index) => {
      const chapterNo = plan.chapterIndexes[0]
      const partNo = (partCounters.get(chapterNo) || 0) + 1
      partCounters.set(chapterNo, partNo)
      const chapter = chapterByNo.get(chapterNo)

      const episodeInsert = tx.insert(schema.episodes).values({
        dramaId,
        episodeNumber: index + 1,
        title: truncateChars(plan.title, MAX_TITLE_CHARS) || `第${index + 1}集`,
        content: plan.content,
        resolution: '720p',
        autoPipeline: false,
        autoDub: false,
        status: 'draft',
        sourceChapterNo: chapterNo,
        sourcePartNo: partNo,
        sourceStale: false,
        createdAt: ts,
        updatedAt: ts,
      }).run()
      const episodeId = getInsertId(episodeInsert)
      episodeIds.push(episodeId)

      tx.insert(schema.novelImportEpisodes).values({
        importId,
        chapterNo,
        partNo,
        episodeId,
        contentHash: contentHash(plan.content),
        chapterHash: chapter?.contentHash || contentHash(chapter?.content || ''),
        syncedTitle: plan.title,
        status: 'synced',
        syncedAt: ts,
      }).run()
    })

    const metadata = JSON.stringify({
      source: 'novel',
      novel_id: novel.id,
      novel_title: novel.title,
      import_id: importId,
    })
    tx.update(schema.dramas).set({ metadata }).where(eq(schema.dramas.id, dramaId)).run()
  })

  return {
    import_id: importId,
    drama_id: dramaId,
    episode_count: plans.length,
    episode_ids: episodeIds,
    existing: false,
    warnings,
    context_pack: contextPackSummary,
  }
}

/* ------------------------------------------------------------------ */
/* P3-4 同步差异 / 冲突 / 应用                                         */
/* ------------------------------------------------------------------ */

export type NovelSyncKind = 'new' | 'updated' | 'conflict' | 'missing' | 'unchanged'
export type NovelSyncConflictReason =
  | 'has_script'
  | 'has_storyboards'
  | 'has_video'
  | 'has_subtitle'
  | 'has_dubbing'
  | 'content_edited'
  | 'automation_running'
  | 'dubbing_running'
  | 'episode_deleted'
export type NovelSyncAction = 'create' | 'update' | 'overwrite' | 'skip' | 'recreate' | 'orphan'

export interface NovelSyncItem {
  chapter_no: number
  part_no: number
  title: string
  kind: NovelSyncKind
  action: NovelSyncAction
  char_count?: number
  episode_id?: number
  reasons?: NovelSyncConflictReason[]
}

export interface NovelSyncPreview {
  import_id: number
  drama_id: number
  split_mode: NovelSplitMode
  target_words: number
  source_updated_at: string | null
  last_synced_at: string | null
  counts: { new: number; updated: number; conflict: number; missing: number; unchanged: number }
  items: NovelSyncItem[]
}

export interface NovelSyncItemInput {
  chapter_no: number
  part_no?: number
  action: string
}

export interface NovelSyncApplyInput {
  items?: NovelSyncItemInput[]
  overwrite_conflicts?: boolean
}

export interface NovelSyncResult {
  import_id: number
  drama_id: number
  created: number
  updated: number
  overwritten: number
  recreated: number
  orphaned: number
  skipped: number
  conflicts: number
  created_episode_ids: number[]
}

type MappingRow = typeof schema.novelImportEpisodes.$inferSelect
type EpisodeRow = typeof schema.episodes.$inferSelect
type ImportRow = typeof schema.novelImports.$inferSelect

interface SyncContext {
  importRow: ImportRow
  novel: NovelRow
  drama: typeof schema.dramas.$inferSelect
}

interface SyncDiff {
  context: SyncContext
  splitMode: NovelSplitMode
  targetWords: number
  preview: NovelSyncPreview
  plans: Map<string, EpisodePlan>
  chapterHashes: Map<number, string>
  episodes: Map<number, EpisodeRow>
  queuedEpisodes: Set<number>
  mappingsByKey: Map<string, MappingRow>
}

function syncKey(chapterNo: number, partNo: number): string {
  return `${chapterNo}:${partNo}`
}

function requireSyncContext(novelId: number, importId: number): SyncContext {
  const importRow = db.select().from(schema.novelImports)
    .where(and(eq(schema.novelImports.id, importId), eq(schema.novelImports.novelId, novelId)))
    .get()
  if (!importRow) throw new NovelImportError('导入记录不存在', 404)
  if (importRow.status === 'orphaned') throw new NovelImportError('导入记录已失效，无法同步', 409)
  const novel = requireNovel(novelId)
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, importRow.dramaId)).get()
  if (!drama || drama.deletedAt) throw new NovelImportError('目标短剧已删除，无法同步', 409)
  return { importRow, novel, drama }
}

function mappingTitle(mapping: MappingRow, episode?: EpisodeRow): string {
  return mapping.syncedTitle || episode?.title || `第${mapping.chapterNo}章`
}

function collectConflictReasons(
  mapping: MappingRow,
  episode: EpisodeRow,
  storyboardCount: number,
  queued: boolean,
): NovelSyncConflictReason[] {
  const reasons: NovelSyncConflictReason[] = []
  if ((mapping.contentHash || '') !== contentHash(episode.content || '')) reasons.push('content_edited')
  if ((episode.scriptContent || '').trim()) reasons.push('has_script')
  if (storyboardCount > 0) reasons.push('has_storyboards')
  if (episode.videoUrl) reasons.push('has_video')
  if (episode.subtitleUrl) reasons.push('has_subtitle')
  if (episode.dubStatus === 'running') reasons.push('dubbing_running')
  else if (episode.dubStatus === 'done') reasons.push('has_dubbing')
  if (episode.automationStatus === 'running') reasons.push('automation_running')
  if (queued) reasons.push('automation_running')
  return [...new Set(reasons)]
}

/** Hn/Hs/He 三 hash 对比，返回分类、原因与可应用的计划正文 */
function buildSyncDiff(novelId: number, importId: number): SyncDiff {
  const context = requireSyncContext(novelId, importId)
  const { splitMode, targetWords } = importSplitOptions(context.importRow)

  const chapters = db.select().from(schema.novelChapters)
    .where(eq(schema.novelChapters.novelId, novelId))
    .orderBy(schema.novelChapters.chapterNo)
    .all()
  const chapterByNo = new Map(chapters.map((row) => [row.chapterNo, row]))
  const chapterHashes = new Map<number, string>()
  for (const chapter of chapters) {
    chapterHashes.set(chapter.chapterNo, chapter.contentHash || contentHash(chapter.content || ''))
  }

  const mappings = db.select().from(schema.novelImportEpisodes)
    .where(eq(schema.novelImportEpisodes.importId, importId))
    .all()
    .filter((row) => row.status !== 'orphaned')
  const mappingsByChapter = new Map<number, MappingRow[]>()
  const mappingsByKey = new Map<string, MappingRow>()
  for (const mapping of mappings) {
    const partNo = mapping.partNo || 1
    const list = mappingsByChapter.get(mapping.chapterNo) || []
    list.push(mapping)
    mappingsByChapter.set(mapping.chapterNo, list)
    mappingsByKey.set(syncKey(mapping.chapterNo, partNo), mapping)
  }

  const episodeIds = [...new Set(mappings.map((row) => row.episodeId))]
  const episodes = episodeIds.length
    ? db.select().from(schema.episodes).where(inArray(schema.episodes.id, episodeIds)).all()
    : []
  const episodesById = new Map(episodes.map((row) => [row.id, row]))
  const storyboardRows = episodeIds.length
    ? db.select({ episodeId: schema.storyboards.episodeId }).from(schema.storyboards)
      .where(and(inArray(schema.storyboards.episodeId, episodeIds), isNull(schema.storyboards.deletedAt)))
      .all()
    : []
  const storyboardCounts = new Map<number, number>()
  for (const row of storyboardRows) {
    storyboardCounts.set(row.episodeId, (storyboardCounts.get(row.episodeId) || 0) + 1)
  }
  const queueRows = episodeIds.length
    ? db.select({ episodeId: schema.pipelineJobs.episodeId }).from(schema.pipelineJobs)
      .where(and(
        inArray(schema.pipelineJobs.episodeId, episodeIds),
        inArray(schema.pipelineJobs.status, ['queued', 'running']),
      ))
      .all()
    : []
  const queuedEpisodes = new Set(
    queueRows.map((row) => row.episodeId).filter((id): id is number => typeof id === 'number'),
  )

  const counts = { new: 0, updated: 0, conflict: 0, missing: 0, unchanged: 0 }
  const items: NovelSyncItem[] = []
  const plans = new Map<string, EpisodePlan>()

  const pushMissing = (mapping: MappingRow) => {
    counts.missing += 1
    items.push({
      chapter_no: mapping.chapterNo,
      part_no: mapping.partNo || 1,
      title: mappingTitle(mapping, episodesById.get(mapping.episodeId)),
      kind: 'missing',
      action: 'orphan',
      episode_id: mapping.episodeId,
    })
  }

  for (const chapter of chapters) {
    const chapterMappings = mappingsByChapter.get(chapter.chapterNo) || []
    const content = chapter.content || ''
    const currentHash = chapterHashes.get(chapter.chapterNo) || contentHash('')

    if (!content.trim()) {
      chapterMappings.forEach(pushMissing)
      continue
    }

    const chapterUnchanged = chapterMappings.length > 0
      && chapterMappings.every((mapping) => (mapping.chapterHash || '') === currentHash)
    if (chapterUnchanged) {
      const chapterPlans = planEpisodes(
        [{ index: chapter.chapterNo, title: chapterTitle(chapter), content, charCount: countWords(content) }],
        { splitMode, targetWords },
      )
      chapterPlans.forEach((plan, index) => {
        plans.set(syncKey(chapter.chapterNo, index + 1), plan)
      })
      for (const mapping of chapterMappings) {
        const partNo = mapping.partNo || 1
        const episode = episodesById.get(mapping.episodeId)
        if (!episode || episode.deletedAt) {
          counts.conflict += 1
          items.push({
            chapter_no: mapping.chapterNo,
            part_no: partNo,
            title: mappingTitle(mapping, episode),
            kind: 'conflict',
            action: 'recreate',
            episode_id: mapping.episodeId,
            reasons: ['episode_deleted'],
          })
        } else {
          counts.unchanged += 1
        }
      }
      continue
    }

    const chapterPlans = planEpisodes(
      [{ index: chapter.chapterNo, title: chapterTitle(chapter), content, charCount: countWords(content) }],
      { splitMode, targetWords },
    )
    const mappingByPart = new Map(chapterMappings.map((row) => [row.partNo || 1, row]))

    chapterPlans.forEach((plan, index) => {
      const partNo = index + 1
      const key = syncKey(chapter.chapterNo, partNo)
      plans.set(key, plan)
      const mapping = mappingByPart.get(partNo)
      if (!mapping) {
        counts.new += 1
        items.push({
          chapter_no: chapter.chapterNo,
          part_no: partNo,
          title: plan.title,
          kind: 'new',
          action: 'create',
          char_count: plan.charCount,
        })
        return
      }

      const episode = episodesById.get(mapping.episodeId)
      if (episode && !episode.deletedAt && (mapping.contentHash || '') === contentHash(plan.content)) {
        counts.unchanged += 1
        return
      }
      if (!episode || episode.deletedAt) {
        counts.conflict += 1
        items.push({
          chapter_no: chapter.chapterNo,
          part_no: partNo,
          title: mappingTitle(mapping, episode),
          kind: 'conflict',
          action: 'recreate',
          episode_id: mapping.episodeId,
          reasons: ['episode_deleted'],
          char_count: plan.charCount,
        })
        return
      }

      const reasons = collectConflictReasons(
        mapping,
        episode,
        storyboardCounts.get(episode.id) || 0,
        queuedEpisodes.has(episode.id),
      )
      if (reasons.length) {
        counts.conflict += 1
        items.push({
          chapter_no: chapter.chapterNo,
          part_no: partNo,
          title: plan.title,
          kind: 'conflict',
          action: 'skip',
          episode_id: episode.id,
          reasons,
          char_count: plan.charCount,
        })
      } else {
        counts.updated += 1
        items.push({
          chapter_no: chapter.chapterNo,
          part_no: partNo,
          title: plan.title,
          kind: 'updated',
          action: 'update',
          episode_id: episode.id,
          char_count: plan.charCount,
        })
      }
    })

    for (const mapping of chapterMappings) {
      if ((mapping.partNo || 1) > chapterPlans.length) pushMissing(mapping)
    }
  }

  for (const [chapterNo, list] of mappingsByChapter) {
    if (chapterByNo.has(chapterNo)) continue
    list.forEach(pushMissing)
  }

  items.sort((a, b) => a.chapter_no - b.chapter_no || a.part_no - b.part_no)

  const preview: NovelSyncPreview = {
    import_id: context.importRow.id,
    drama_id: context.importRow.dramaId,
    split_mode: splitMode,
    target_words: targetWords,
    source_updated_at: context.novel.contentUpdatedAt || context.novel.updatedAt,
    last_synced_at: context.importRow.lastSyncedAt ?? null,
    counts,
    items,
  }

  return {
    context,
    splitMode,
    targetWords,
    preview,
    plans,
    chapterHashes,
    episodes: episodesById,
    queuedEpisodes,
    mappingsByKey,
  }
}

export function previewNovelImportSync(novelId: number, importId: number): NovelSyncPreview {
  return buildSyncDiff(novelId, importId).preview
}

const SYNC_KIND_ACTIONS: Record<NovelSyncKind, NovelSyncAction[]> = {
  new: ['create', 'skip'],
  updated: ['update', 'skip'],
  conflict: ['overwrite', 'recreate', 'skip'],
  missing: ['orphan', 'skip'],
  unchanged: ['skip'],
}

const ALL_SYNC_ACTIONS = new Set<string>(['create', 'update', 'overwrite', 'skip', 'recreate', 'orphan'])

function normalizeSyncSelection(
  preview: NovelSyncPreview,
  input: NovelSyncApplyInput,
): Map<string, NovelSyncAction> {
  const itemByKey = new Map(preview.items.map((item) => [syncKey(item.chapter_no, item.part_no), item]))
  const selection = new Map<string, NovelSyncAction>()

  if (input.items === undefined || input.items === null) {
    for (const item of preview.items) {
      if (item.kind === 'conflict') {
        const deleted = item.reasons?.includes('episode_deleted')
        selection.set(
          syncKey(item.chapter_no, item.part_no),
          !deleted && input.overwrite_conflicts ? 'overwrite' : 'skip',
        )
      } else {
        selection.set(syncKey(item.chapter_no, item.part_no), item.action)
      }
    }
    return selection
  }

  if (!Array.isArray(input.items)) throw new NovelImportError('items 必须是数组')
  for (const raw of input.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new NovelImportError('items 条目必须是对象')
    }
    const chapterNo = Math.floor(Number((raw as NovelSyncItemInput).chapter_no))
    const partNo = Math.floor(Number((raw as NovelSyncItemInput).part_no ?? 1))
    const action = String((raw as NovelSyncItemInput).action || '')
    if (!Number.isSafeInteger(chapterNo) || chapterNo <= 0) throw new NovelImportError('chapter_no 必须是正整数')
    if (!Number.isSafeInteger(partNo) || partNo <= 0) throw new NovelImportError('part_no 必须是正整数')
    if (!ALL_SYNC_ACTIONS.has(action)) throw new NovelImportError(`未知同步动作：${action}`)

    const key = syncKey(chapterNo, partNo)
    const item = itemByKey.get(key)
    if (!item) throw new NovelImportError(`第${chapterNo}章第${partNo}部分无需同步`, 400)
    if (selection.has(key)) throw new NovelImportError(`第${chapterNo}章第${partNo}部分重复提交`)

    const allowed = SYNC_KIND_ACTIONS[item.kind]
    if (!allowed.includes(action as NovelSyncAction)) {
      throw new NovelImportError(`动作 ${action} 不适用于 ${item.kind} 条目`)
    }
    if (item.reasons?.includes('episode_deleted') && action !== 'recreate' && action !== 'skip') {
      throw new NovelImportError('目标集已删除，只能选择重新建集或跳过')
    }
    if (action === 'recreate' && !item.reasons?.includes('episode_deleted')) {
      throw new NovelImportError('只有目标集已删除的条目可以重新建集')
    }
    selection.set(key, action as NovelSyncAction)
  }
  return selection
}

function insertSyncEpisode(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  dramaId: number,
  plan: EpisodePlan,
  chapterNo: number,
  partNo: number,
  episodeNumber: number,
  ts: string,
): number {
  const res = tx.insert(schema.episodes).values({
    dramaId,
    episodeNumber,
    title: truncateChars(plan.title, MAX_TITLE_CHARS) || `第${episodeNumber}集`,
    content: plan.content,
    resolution: '720p',
    autoPipeline: false,
    autoDub: false,
    status: 'draft',
    sourceChapterNo: chapterNo,
    sourcePartNo: partNo,
    sourceStale: false,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return getInsertId(res)
}

/** 应用同步：默认覆盖 updated、创建 new、orphaned missing、跳过 conflict */
export function syncNovelImport(
  novelId: number,
  importId: number,
  input: NovelSyncApplyInput = {},
): NovelSyncResult {
  const diff = buildSyncDiff(novelId, importId)
  const selection = normalizeSyncSelection(diff.preview, input)
  const itemByKey = new Map(diff.preview.items.map((item) => [syncKey(item.chapter_no, item.part_no), item]))

  const runningEpisodeIds = [...selection.entries()]
    .filter(([key, action]) => {
      if (action === 'skip' || action === 'create' || action === 'orphan') return false
      return Boolean(itemByKey.get(key)?.episode_id)
    })
    .map(([key]) => itemByKey.get(key)!.episode_id!)
    .filter((episodeId) => {
      const episode = diff.episodes.get(episodeId)
      return episode
        && !episode.deletedAt
        && (episode.automationStatus === 'running' || episode.dubStatus === 'running' || diff.queuedEpisodes.has(episodeId))
    })
  if (runningEpisodeIds.length) {
    throw new NovelImportError('有剧集正在自动化/配音/队列任务中运行，请先停止后同步', 409, {
      episode_ids: [...new Set(runningEpisodeIds)],
    })
  }

  const ts = now()
  const storyBibleChapterHashes = diff.chapterHashes
  let created = 0
  let updated = 0
  let overwritten = 0
  let recreated = 0
  let orphaned = 0
  let skipped = 0
  const createdEpisodeIds: number[] = []
  const applied: { chapter_no: number; part_no: number; action: NovelSyncAction; kind: NovelSyncKind }[] = []

  db.transaction((tx) => {
    const numberRows = tx.select({ episodeNumber: schema.episodes.episodeNumber })
      .from(schema.episodes)
      .where(eq(schema.episodes.dramaId, diff.context.importRow.dramaId))
      .all()
    let nextEpisodeNumber = numberRows.reduce((max, row) => Math.max(max, row.episodeNumber), 0) + 1

    for (const [key, action] of selection) {
      const item = itemByKey.get(key)!
      const mapping = diff.mappingsByKey.get(key)
      const plan = diff.plans.get(key)
      const chapterHash = storyBibleChapterHashes.get(item.chapter_no) || contentHash('')

      if (action === 'skip') {
        skipped += 1
        applied.push({ chapter_no: item.chapter_no, part_no: item.part_no, action, kind: item.kind })
        continue
      }

      if (action === 'create' || action === 'recreate') {
        if (!plan) throw new NovelImportError(`第${item.chapter_no}章第${item.part_no}部分缺少正文`)
        const episodeId = insertSyncEpisode(
          tx,
          diff.context.importRow.dramaId,
          plan,
          item.chapter_no,
          item.part_no,
          nextEpisodeNumber,
          ts,
        )
        nextEpisodeNumber += 1
        createdEpisodeIds.push(episodeId)

        const existingMapping = tx.select().from(schema.novelImportEpisodes)
          .where(and(
            eq(schema.novelImportEpisodes.importId, importId),
            eq(schema.novelImportEpisodes.chapterNo, item.chapter_no),
            eq(schema.novelImportEpisodes.partNo, item.part_no),
          ))
          .get()
        if (existingMapping) {
          tx.update(schema.novelImportEpisodes)
            .set({
              episodeId,
              contentHash: contentHash(plan.content),
              chapterHash,
              syncedTitle: plan.title,
              status: 'synced',
              syncedAt: ts,
            })
            .where(eq(schema.novelImportEpisodes.id, existingMapping.id))
            .run()
        } else {
          tx.insert(schema.novelImportEpisodes).values({
            importId,
            chapterNo: item.chapter_no,
            partNo: item.part_no,
            episodeId,
            contentHash: contentHash(plan.content),
            chapterHash,
            syncedTitle: plan.title,
            status: 'synced',
            syncedAt: ts,
          }).run()
        }
        if (action === 'create') created += 1
        else recreated += 1
        applied.push({ chapter_no: item.chapter_no, part_no: item.part_no, action, kind: item.kind })
        continue
      }

      if (!mapping) throw new NovelImportError(`第${item.chapter_no}章第${item.part_no}部分映射不存在`)

      if (action === 'orphan') {
        tx.update(schema.novelImportEpisodes)
          .set({ status: 'orphaned' })
          .where(eq(schema.novelImportEpisodes.id, mapping.id))
          .run()
        orphaned += 1
        applied.push({ chapter_no: item.chapter_no, part_no: item.part_no, action, kind: item.kind })
        continue
      }

      if (!plan) throw new NovelImportError(`第${item.chapter_no}章第${item.part_no}部分缺少正文`)
      tx.update(schema.episodes)
        .set({
          content: plan.content,
          updatedAt: ts,
          ...(action === 'overwrite' ? { sourceStale: true } : {}),
        })
        .where(eq(schema.episodes.id, mapping.episodeId))
        .run()
      tx.update(schema.novelImportEpisodes)
        .set({
          contentHash: contentHash(plan.content),
          chapterHash,
          syncedTitle: plan.title,
          status: 'synced',
          syncedAt: ts,
        })
        .where(eq(schema.novelImportEpisodes.id, mapping.id))
        .run()
      if (action === 'overwrite') overwritten += 1
      else updated += 1
      applied.push({ chapter_no: item.chapter_no, part_no: item.part_no, action, kind: item.kind })
    }

    if (created + updated + overwritten + recreated + orphaned > 0) {
      const liveEpisodes = tx.select({ value: count() }).from(schema.episodes)
        .where(and(
          eq(schema.episodes.dramaId, diff.context.importRow.dramaId),
          isNull(schema.episodes.deletedAt),
        ))
        .get()
      tx.update(schema.dramas)
        .set({ totalEpisodes: Number(liveEpisodes?.value ?? 0), updatedAt: ts })
        .where(eq(schema.dramas.id, diff.context.importRow.dramaId))
        .run()
      tx.update(schema.novelImports)
        .set({
          lastSyncedAt: ts,
          sourceUpdatedAt: diff.context.novel.contentUpdatedAt || diff.context.novel.updatedAt,
          lastSyncSummary: JSON.stringify({
            split_mode: diff.splitMode,
            target_words: diff.targetWords,
            at: ts,
            created,
            updated,
            overwritten,
            recreated,
            orphaned,
            skipped,
            items: applied.filter((row) => row.action !== 'skip'),
          }),
          updatedAt: ts,
        })
        .where(eq(schema.novelImports.id, importId))
        .run()
    }
  })

  return {
    import_id: importId,
    drama_id: diff.context.importRow.dramaId,
    created,
    updated,
    overwritten,
    recreated,
    orphaned,
    skipped,
    conflicts: diff.preview.counts.conflict,
    created_episode_ids: createdEpisodeIds,
  }
}
