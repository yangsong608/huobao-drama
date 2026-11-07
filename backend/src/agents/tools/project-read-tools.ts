/**
 * 项目级与交付只读工具（A1-4 / A1-5）：
 * 项目列表、项目概览、资产列表/详情、交付状态。
 * 只查询与字段裁剪；不建集、不补资产、不写业务表、不返回服务器路径或素材地址。
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { clipText, getAssistantBudget } from '../assistant-context.js'
import { getAssistantScope } from '../context.js'
import type { AgentScope, AgentScopeKind } from '../agent-scope.js'

type Fail = { error: string; hint: string; status?: number }

function fail(error: string, hint: string, status?: number): Fail {
  return status ? { error, hint, status } : { error, hint }
}

function isFail(value: unknown): value is Fail {
  return Boolean(value && typeof value === 'object' && 'error' in (value as Record<string, unknown>))
}

function limitResult<T extends Record<string, unknown>>(result: T): T | Record<string, unknown> {
  const maxChars = getAssistantBudget().maxResultChars
  const text = JSON.stringify(result)
  if (text.length <= maxChars) return result
  return {
    truncated: true,
    hint: '结果超过单次上限，已截断；请缩小 limit 或改用更精确的编号后重试。',
    preview: text.slice(0, Math.max(0, maxChars - 200)),
  }
}

const PATH_PATTERNS = [
  /[A-Za-z]:\\[^\s'"]+/g,
  /(?:\/[^\s'"]+){2,}/g,
  /\b(?:[\w.-]+\/){2,}[\w.-]+/g,
]

function redactPaths(text: string): string {
  return PATH_PATTERNS.reduce((value, pattern) => value.replace(pattern, '[路径]'), text)
}

function safeText(raw: unknown, limit = 240): string {
  return clipText(redactPaths(String(raw ?? '').replace(/\r?\n+/g, ' ').trim()), limit).text
}

function plainText(raw: unknown, limit = 1200): string {
  return clipText(redactPaths(String(raw ?? '').trim()), limit).text
}

const EPISODE_SCOPE_KINDS = new Set<AgentScopeKind>(['episode', 'director', 'edit', 'mix', 'delivery'])
const DEFAULT_LIMIT = 50

interface ProjectTarget {
  dramaId: number
  episodeId: number | null
}

function projectTarget(scope: AgentScope | null): ProjectTarget | Fail {
  if (!scope || !scope.drama_id) {
    return fail('当前作用域不允许读取项目数据', '请先进入项目详情或分集制作区。', 403)
  }
  if (scope.kind === 'drama') return { dramaId: scope.drama_id, episodeId: null }
  if (EPISODE_SCOPE_KINDS.has(scope.kind)) {
    if (!scope.episode_id) {
      return fail('当前分集作用域缺少分集编号', '请从分集页面重新打开助手。', 403)
    }
    return { dramaId: scope.drama_id, episodeId: scope.episode_id }
  }
  return fail('当前作用域不允许读取项目数据', '请先进入项目详情或分集制作区。', 403)
}

function verifyProjectTarget(target: ProjectTarget): Fail | null {
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, target.dramaId)).get()
  if (!drama || drama.deletedAt) {
    return fail('项目不存在或已删除', '请返回项目列表重新打开项目。', 404)
  }
  if (target.episodeId == null) return null
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, target.episodeId)).get()
  if (!episode || episode.deletedAt || episode.dramaId !== target.dramaId) {
    return fail('分集不存在或不属于当前项目', '请返回项目页重新打开分集。', 404)
  }
  return null
}

interface EpisodeRef {
  id: number
  episodeNumber: number
  title: string
  status: string | null
  currentFilmId: number | null
}

function visibleEpisodes(dramaId: number): EpisodeRef[] {
  return db.select({
    id: schema.episodes.id,
    episodeNumber: schema.episodes.episodeNumber,
    title: schema.episodes.title,
    status: schema.episodes.status,
    currentFilmId: schema.episodes.currentFilmId,
  }).from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, dramaId), isNull(schema.episodes.deletedAt)))
    .orderBy(asc(schema.episodes.episodeNumber), asc(schema.episodes.id))
    .all()
}

function episodeIdSet(episodes: EpisodeRef[]): Set<number> {
  return new Set(episodes.map((episode) => episode.id))
}

function countByEpisode(rows: Array<{ episodeId: number }>): Map<number, number> {
  const counts = new Map<number, number>()
  for (const row of rows) counts.set(row.episodeId, (counts.get(row.episodeId) ?? 0) + 1)
  return counts
}

const readProjectList = createTool({
  id: 'read_project_list',
  description: 'List drama projects on the home page: title, status, aspect ratio, episode count and last update. Only available in the home scope; soft-deleted projects are excluded. Does not return episode or asset detail.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const scope = getAssistantScope(context?.requestContext)
    if (!scope || scope.kind !== 'home') {
      return fail('当前作用域不允许读取项目列表', '请在首页使用该工具。', 403)
    }
    const rows = db.select().from(schema.dramas)
      .where(isNull(schema.dramas.deletedAt))
      .orderBy(desc(schema.dramas.updatedAt), desc(schema.dramas.id))
      .all()
    const episodeCounts = new Map<number, number>()
    for (const row of db.select({ dramaId: schema.episodes.dramaId })
      .from(schema.episodes)
      .where(isNull(schema.episodes.deletedAt))
      .all()) {
      episodeCounts.set(row.dramaId, (episodeCounts.get(row.dramaId) ?? 0) + 1)
    }
    const items = rows.slice(0, DEFAULT_LIMIT).map((row) => ({
      id: row.id,
      title: safeText(row.title, 120),
      status: row.status,
      aspect_ratio: row.aspectRatio,
      episode_count: episodeCounts.get(row.id) ?? 0,
      total_episodes: row.totalEpisodes ?? 0,
      updated_at: row.updatedAt,
    }))
    return limitResult({
      items,
      total: rows.length,
      truncated: rows.length > items.length,
      hint: items.length
        ? '项目列表只含未删除项目；集内详情请在项目页继续提问。'
        : '还没有项目；请先在首页新建项目。',
    })
  },
})

function deriveEpisodeStage(episode: any, storyboardCount: number): string {
  if (episode.automationStatus === 'running' && episode.automationStage) {
    if (episode.automationStage === 'rewrite') return 'script'
    return String(episode.automationStage)
  }
  if (episode.currentFilmId) return 'delivery'
  if (episode.mixRevisionId) return 'mix'
  if (episode.editRevisionId) return 'edit'
  if (storyboardCount > 0) return 'storyboards'
  if (String(episode.scriptContent || episode.content || '').trim()) return 'script'
  return 'empty'
}

const readProjectOverview = createTool({
  id: 'read_project_overview',
  description: 'Read the current drama project overview: aspect ratio, episodes with per-episode stage and counts, plus asset, storyboard, line, film and export totals. Only available in the drama scope. Read-only; never creates episodes or assets.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).optional().describe('Maximum episodes to list; default 50'),
  }),
  execute: async ({ limit }, context) => {
    const scope = getAssistantScope(context?.requestContext)
    if (!scope || scope.kind !== 'drama' || !scope.drama_id) {
      return fail('当前作用域不允许读取项目概览', '请在项目详情页使用该工具。', 403)
    }
    const target: ProjectTarget = { dramaId: scope.drama_id, episodeId: null }
    const invalid = verifyProjectTarget(target)
    if (invalid) return invalid

    const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, target.dramaId)).get()!
    const episodes = db.select().from(schema.episodes)
      .where(and(eq(schema.episodes.dramaId, target.dramaId), isNull(schema.episodes.deletedAt)))
      .orderBy(asc(schema.episodes.episodeNumber), asc(schema.episodes.id))
      .all()
    const ids = episodes.map((episode) => episode.id)
    const scoped = <T extends { episodeId: number }>(table: any, column: any) => ids.length
      ? db.select({ id: table.id, episodeId: column }).from(table)
        .where(and(inArray(column, ids), isNull(table.deletedAt))).all() as T[]
      : []
    const storyboards = scoped<{ id: number; episodeId: number }>(schema.storyboards, schema.storyboards.episodeId)
    const lines = scoped<{ id: number; episodeId: number }>(schema.storyboardLines, schema.storyboardLines.episodeId)
    const exports = ids.length
      ? db.select({ id: schema.episodeExports.id, episodeId: schema.episodeExports.episodeId })
        .from(schema.episodeExports)
        .where(and(inArray(schema.episodeExports.episodeId, ids), isNull(schema.episodeExports.deletedAt)))
        .all()
      : []
    const characters = db.select({ id: schema.characters.id }).from(schema.characters)
      .where(and(eq(schema.characters.dramaId, target.dramaId), isNull(schema.characters.deletedAt))).all()
    const scenes = db.select({ id: schema.scenes.id }).from(schema.scenes)
      .where(and(eq(schema.scenes.dramaId, target.dramaId), isNull(schema.scenes.deletedAt))).all()
    const props = db.select({ id: schema.props.id }).from(schema.props)
      .where(and(eq(schema.props.dramaId, target.dramaId), isNull(schema.props.deletedAt))).all()
    const films = db.select({
      id: schema.videoMerges.id,
      status: schema.videoMerges.status,
      mergedUrl: schema.videoMerges.mergedUrl,
    }).from(schema.videoMerges)
      .where(and(eq(schema.videoMerges.dramaId, target.dramaId), isNull(schema.videoMerges.deletedAt)))
      .all()
    const filmIds = new Set(films.map((film) => film.id))
    const completedFilms = films.filter((film) => film.status === 'completed' && film.mergedUrl).length
    const currentFilms = episodes.filter((episode) => episode.currentFilmId && filmIds.has(episode.currentFilmId)).length

    const storyboardCounts = countByEpisode(storyboards)
    const lineCounts = countByEpisode(lines)
    const max = Math.min(100, Math.max(1, Math.floor(limit ?? 50)))
    const items = episodes.slice(0, max).map((episode) => {
      const storyboardCount = storyboardCounts.get(episode.id) ?? 0
      return {
        episode_id: episode.id,
        episode_number: episode.episodeNumber,
        title: safeText(episode.title, 120),
        status: episode.status,
        stage: deriveEpisodeStage(episode, storyboardCount),
        automation_status: episode.automationStatus ?? null,
        automation_stage: episode.automationStage ?? null,
        script_chars: String(episode.scriptContent || episode.content || '').length,
        storyboard_count: storyboardCount,
        line_count: lineCounts.get(episode.id) ?? 0,
        dub_status: episode.dubStatus ?? null,
        current_film_id: episode.currentFilmId ?? null,
        has_current_film: Boolean(episode.currentFilmId && filmIds.has(episode.currentFilmId)),
        updated_at: episode.updatedAt,
      }
    })
    return limitResult({
      project: {
        id: drama.id,
        title: safeText(drama.title, 120),
        status: drama.status,
        aspect_ratio: drama.aspectRatio,
        total_episodes: drama.totalEpisodes ?? 0,
        updated_at: drama.updatedAt,
      },
      episode_count: episodes.length,
      episodes: items,
      total: episodes.length,
      truncated: episodes.length > items.length,
      counts: {
        characters: characters.length,
        scenes: scenes.length,
        props: props.length,
        storyboards: storyboards.length,
        lines: lines.length,
        films: completedFilms,
        current_films: currentFilms,
        exports: exports.length,
      },
      hint: episodes.length
        ? '概览只含未删除数据；需要集内剧本或分镜请进入该集后提问。'
        : '该项目还没有分集；可先在项目页新建分集。',
    })
  },
})

type AssetType = 'character' | 'scene' | 'prop'
const ASSET_TYPES: AssetType[] = ['character', 'scene', 'prop']

function assetTypeLabel(type: AssetType): string {
  return type === 'character' ? '角色' : type === 'scene' ? '场景' : '道具'
}

function assetTable(type: AssetType) {
  return type === 'character' ? schema.characters : type === 'scene' ? schema.scenes : schema.props
}

function bindingRows(type: AssetType) {
  return type === 'character'
    ? db.select().from(schema.episodeCharacters).all()
    : type === 'scene'
      ? db.select().from(schema.episodeScenes).all()
      : db.select().from(schema.episodeProps).all()
}

function bindingAssetId(type: AssetType, row: any): number {
  return type === 'character' ? row.characterId : type === 'scene' ? row.sceneId : row.propId
}

function bindingEpisodeCounts(type: AssetType, visible: Set<number>): Map<number, Set<number>> {
  const map = new Map<number, Set<number>>()
  for (const row of bindingRows(type)) {
    if (!visible.has(row.episodeId)) continue
    const assetId = bindingAssetId(type, row)
    const episodes = map.get(assetId) ?? new Set<number>()
    episodes.add(row.episodeId)
    map.set(assetId, episodes)
  }
  return map
}

function loadAssetRows(type: AssetType, ids: number[]): any[] {
  if (!ids.length) return []
  const table = assetTable(type)
  return db.select().from(table)
    .where(and(inArray(table.id, ids), isNull(table.deletedAt)))
    .all()
}

function assetSummary(type: AssetType, row: Record<string, any>, boundEpisodes: number, boundCurrent: boolean | null) {
  const base = {
    asset_type: type,
    id: row.id,
    has_final_prompt: Boolean(row.finalPrompt),
    has_image: Boolean(row.imageUrl),
    bound_episode_count: boundEpisodes,
    ...(boundCurrent == null ? {} : { bound_current_episode: boundCurrent }),
  }
  if (type === 'character') {
    return {
      ...base,
      name: safeText(row.name, 80),
      role: safeText(row.role, 80),
      description: safeText(row.description, 160),
    }
  }
  if (type === 'scene') {
    return {
      ...base,
      name: safeText(row.location, 80),
      time: safeText(row.time, 40),
      description: safeText(row.prompt, 160),
    }
  }
  return {
    ...base,
    name: safeText(row.name, 80),
    type: safeText(row.type, 40),
    description: safeText(row.description, 160),
  }
}

const readAssets = createTool({
  id: 'read_assets',
  description: 'List characters, scenes and props. On the project page returns all project assets; on episode pages returns only assets bound to the current episode. Summaries include whether a final prompt exists and how many episodes use the asset. Use read_asset_detail for final prompts. Read-only.',
  inputSchema: z.object({
    asset_type: z.enum(['character', 'scene', 'prop']).optional().describe('Optional asset type filter'),
    limit: z.number().int().min(1).max(100).optional().describe('Max rows per type; default 50'),
  }),
  execute: async ({ asset_type, limit }, context) => {
    const scope = getAssistantScope(context?.requestContext)
    const target = projectTarget(scope)
    if (isFail(target)) return target
    const invalid = verifyProjectTarget(target)
    if (invalid) return invalid

    const episodes = visibleEpisodes(target.dramaId)
    const visible = episodeIdSet(episodes)
    const currentEpisodeId = target.episodeId
    const max = Math.min(100, Math.max(1, Math.floor(limit ?? 50)))
    const types: AssetType[] = asset_type ? [asset_type] : ASSET_TYPES
    const result: Record<string, any[]> = {}
    const totals: Record<string, number> = {}
    let truncated = false

    for (const type of types) {
      const countsByAsset = bindingEpisodeCounts(type, visible)
      let rows: any[]
      if (currentEpisodeId != null) {
        const boundIds = [...countsByAsset.entries()]
          .filter(([, episodeIds]) => episodeIds.has(currentEpisodeId))
          .map(([assetId]) => assetId)
        rows = loadAssetRows(type, boundIds)
      } else {
        const table = assetTable(type)
        rows = db.select().from(table)
          .where(and(eq(table.dramaId, target.dramaId), isNull(table.deletedAt)))
          .all()
      }
      totals[type] = rows.length
      if (rows.length > max) truncated = true
      result[type === 'character' ? 'characters' : type === 'scene' ? 'scenes' : 'props'] = rows
        .slice(0, max)
        .map((row) => assetSummary(
          type,
          row,
          countsByAsset.get(row.id)?.size ?? 0,
          currentEpisodeId == null ? null : Boolean(countsByAsset.get(row.id)?.has(currentEpisodeId)),
        ))
    }

    return limitResult({
      scope: currentEpisodeId == null ? 'drama' : 'episode',
      drama_id: target.dramaId,
      episode_id: currentEpisodeId,
      total_by_type: totals,
      ...result,
      truncated,
      hint: Object.values(totals).some((total) => total > 0)
        ? '列表只含摘要；完整最终提示词请用 read_asset_detail 读取。'
        : currentEpisodeId == null
          ? '该项目还没有资产；可先在项目页提取资产。'
          : '当前集还没有绑定资产；可先在分集资产阶段提取或绑定。',
    })
  },
})

function boundStoryboardIds(type: AssetType, assetId: number, allowedEpisodes: Set<number>): number[] {
  if (!allowedEpisodes.size) return []
  if (type === 'scene') {
    return db.select({ id: schema.storyboards.id }).from(schema.storyboards)
      .where(and(
        eq(schema.storyboards.sceneId, assetId),
        inArray(schema.storyboards.episodeId, [...allowedEpisodes]),
        isNull(schema.storyboards.deletedAt),
      ))
      .all()
      .map((row) => row.id)
  }
  const linked = type === 'character'
    ? db.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.characterId, assetId)).all()
      .map((row) => row.storyboardId)
    : db.select().from(schema.storyboardProps)
      .where(eq(schema.storyboardProps.propId, assetId)).all()
      .map((row) => row.storyboardId)
  if (!linked.length) return []
  return db.select({ id: schema.storyboards.id }).from(schema.storyboards)
    .where(and(
      inArray(schema.storyboards.id, linked),
      inArray(schema.storyboards.episodeId, [...allowedEpisodes]),
      isNull(schema.storyboards.deletedAt),
    ))
    .all()
    .map((row) => row.id)
}

const readAssetDetail = createTool({
  id: 'read_asset_detail',
  description: 'Read one character, scene or prop detail: final prompt, visual fields, bound episodes and bound storyboards. The asset must belong to the current project; episode pages additionally limit bound storyboards to the current episode. Read-only.',
  inputSchema: z.object({
    asset_type: z.enum(['character', 'scene', 'prop']).describe('Asset table'),
    asset_id: z.number().int().positive().describe('Asset row ID from read_assets'),
  }),
  execute: async ({ asset_type, asset_id }, context) => {
    const scope = getAssistantScope(context?.requestContext)
    const target = projectTarget(scope)
    if (isFail(target)) return target
    const invalid = verifyProjectTarget(target)
    if (invalid) return invalid

    const type = asset_type as AssetType
    const table = assetTable(type)
    const row: any = db.select().from(table)
      .where(and(eq(table.id, asset_id), eq(table.dramaId, target.dramaId), isNull(table.deletedAt)))
      .get()
    if (!row) {
      return fail(`${assetTypeLabel(type)}不存在或不属于当前项目`, '请先用 read_assets 获取当前项目可用的素材编号。', 404)
    }

    const episodes = visibleEpisodes(target.dramaId)
    const visible = episodeIdSet(episodes)
    const countsByAsset = bindingEpisodeCounts(type, visible)
    const boundEpisodeIds = countsByAsset.get(asset_id) ?? new Set<number>()
    const boundEpisodes = episodes
      .filter((episode) => boundEpisodeIds.has(episode.id))
      .slice(0, 50)
      .map((episode) => ({ id: episode.id, episode_number: episode.episodeNumber, title: safeText(episode.title, 120) }))
    const allowedEpisodes = target.episodeId == null ? visible : new Set<number>([target.episodeId])
    const boundStoryboards = [...new Set(boundStoryboardIds(type, asset_id, allowedEpisodes))].slice(0, 100)

    const base = {
      asset_type: type,
      id: row.id,
      name: safeText(type === 'scene' ? row.location : row.name, 100),
      has_image: Boolean(row.imageUrl),
      bound_episode_count: boundEpisodeIds.size,
      bound_episodes: boundEpisodes,
      bound_storyboards: boundStoryboards,
    }
    if (type === 'character') {
      return limitResult({
        ...base,
        role: safeText(row.role, 120),
        description: plainText(row.description, 1000),
        appearance: plainText(row.appearance, 1000),
        styling: plainText(row.styling, 1000),
        personality: plainText(row.personality, 800),
        final_prompt: row.finalPrompt ? plainText(row.finalPrompt, 2000) : null,
      })
    }
    if (type === 'scene') {
      return limitResult({
        ...base,
        time: safeText(row.time, 60),
        lighting: plainText(row.lighting, 600),
        prompt: plainText(row.prompt, 1200),
        final_prompt: row.finalPrompt ? plainText(row.finalPrompt, 2000) : null,
        reference_images: jsonArrayText(row.referenceImages),
      })
    }
    return limitResult({
      ...base,
      type: safeText(row.type, 60),
      description: plainText(row.description, 1000),
      prompt: plainText(row.prompt, 1200),
      final_prompt: row.finalPrompt ? plainText(row.finalPrompt, 2000) : null,
    })
  },
})

function jsonArrayText(value: string | null | undefined): string {
  if (!value) return ''
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => safeText(item, 80)).join(' / ') : safeText(value, 200)
  } catch {
    return safeText(value, 200)
  }
}

function filmSummary(row: any) {
  return {
    id: row.id,
    title: safeText(row.title || `成片 ${row.id}`, 120),
    kind: row.kind,
    origin: row.origin,
    status: row.status,
    duration_sec: Number(row.duration ?? 0),
    has_file: Boolean(row.mergedUrl),
    created_at: row.createdAt,
    completed_at: row.completedAt ?? null,
    error: row.status === 'failed' ? safeText(row.errorMsg) : null,
  }
}

function exportSummary(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    preset: row.preset ?? null,
    progress: row.progress ?? 0,
    duration_ms: row.durationMs ?? null,
    is_current: Boolean(row.isCurrent),
    created_at: row.createdAt,
    finished_at: row.finishedAt ?? null,
    error: row.status === 'failed' ? safeText(row.error) : null,
  }
}

const readDeliveryStatus = createTool({
  id: 'read_delivery_status',
  description: 'Read delivery status. In the delivery scope returns the current episode films, exports and failure reasons. In the drama scope aggregates per-episode current film and latest export for the whole project without requiring an episode ID. Soft-deleted records are excluded; no file paths are returned.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe('Max records or episodes; default 10 for episode scope, 50 for drama scope'),
  }),
  execute: async ({ limit }, context) => {
    const scope = getAssistantScope(context?.requestContext)
    if (!scope || !scope.drama_id) {
      return fail('当前作用域不允许读取交付状态', '请在项目详情或分集交付页使用该工具。', 403)
    }
    if (scope.kind !== 'drama' && scope.kind !== 'delivery') {
      return fail('当前作用域不允许读取交付状态', '请在项目详情或分集交付页使用该工具。', 403)
    }
    const target: ProjectTarget = {
      dramaId: scope.drama_id,
      episodeId: scope.kind === 'delivery' ? scope.episode_id ?? null : null,
    }
    if (scope.kind === 'delivery' && !target.episodeId) {
      return fail('当前交付作用域缺少分集编号', '请从分集交付页重新打开助手。', 403)
    }
    const invalid = verifyProjectTarget(target)
    if (invalid) return invalid

    if (scope.kind === 'delivery') {
      const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, target.episodeId!)).get()!
      const max = Math.min(50, Math.max(1, Math.floor(limit ?? 10)))
      const merges = db.select().from(schema.videoMerges)
        .where(and(eq(schema.videoMerges.episodeId, target.episodeId!), isNull(schema.videoMerges.deletedAt)))
        .orderBy(desc(schema.videoMerges.createdAt), desc(schema.videoMerges.id))
        .all()
      const exports = db.select().from(schema.episodeExports)
        .where(and(eq(schema.episodeExports.episodeId, target.episodeId!), isNull(schema.episodeExports.deletedAt)))
        .orderBy(desc(schema.episodeExports.createdAt), desc(schema.episodeExports.id))
        .all()
      const currentFilm = episode.currentFilmId
        ? merges.find((row) => row.id === episode.currentFilmId) ?? null
        : null
      const failedMerges = merges.filter((row) => row.status === 'failed').length
      const failedExports = exports.filter((row) => row.status === 'failed').length
      return limitResult({
        scope: 'delivery',
        drama_id: target.dramaId,
        episode_id: target.episodeId,
        episode: {
          episode_number: episode.episodeNumber,
          title: safeText(episode.title, 120),
          status: episode.status,
        },
        current_film: currentFilm ? filmSummary(currentFilm) : null,
        merges: {
          items: merges.slice(0, max).map(filmSummary),
          total: merges.length,
          failed: failedMerges,
        },
        exports: {
          items: exports.slice(0, max).map(exportSummary),
          total: exports.length,
          failed: failedExports,
        },
        hint: merges.length || exports.length
          ? '交付状态只含台账与失败原因；成片文件请在成片中心查看。'
          : '当前集还没有合片或导出记录；可先在交付流程生成。',
      })
    }

    const episodes = visibleEpisodes(target.dramaId)
    const ids = episodes.map((episode) => episode.id)
    const max = Math.min(50, Math.max(1, Math.floor(limit ?? 50)))
    const merges = ids.length
      ? db.select().from(schema.videoMerges)
        .where(and(inArray(schema.videoMerges.episodeId, ids), isNull(schema.videoMerges.deletedAt)))
        .orderBy(desc(schema.videoMerges.createdAt), desc(schema.videoMerges.id))
        .all()
      : []
    const exports = ids.length
      ? db.select().from(schema.episodeExports)
        .where(and(inArray(schema.episodeExports.episodeId, ids), isNull(schema.episodeExports.deletedAt)))
        .orderBy(desc(schema.episodeExports.createdAt), desc(schema.episodeExports.id))
        .all()
      : []
    const filmById = new Map(merges.map((row) => [row.id, row]))
    const mergesByEpisode = new Map<number, any[]>()
    for (const row of merges) {
      if (row.episodeId == null) continue
      const list = mergesByEpisode.get(row.episodeId) ?? []
      list.push(row)
      mergesByEpisode.set(row.episodeId, list)
    }
    const exportsByEpisode = new Map<number, any[]>()
    for (const row of exports) {
      const list = exportsByEpisode.get(row.episodeId) ?? []
      list.push(row)
      exportsByEpisode.set(row.episodeId, list)
    }
    const items = episodes.slice(0, max).map((episode) => {
      const episodeMerges = mergesByEpisode.get(episode.id) ?? []
      const episodeExports = exportsByEpisode.get(episode.id) ?? []
      const current = episode.currentFilmId ? filmById.get(episode.currentFilmId) ?? null : null
      const latestExport = episodeExports[0] ?? null
      return {
        episode_id: episode.id,
        episode_number: episode.episodeNumber,
        title: safeText(episode.title, 120),
        status: episode.status,
        current_film: current ? filmSummary(current) : null,
        latest_export: latestExport ? exportSummary(latestExport) : null,
        merge_count: episodeMerges.length,
        export_count: episodeExports.length,
        failed_merges: episodeMerges.filter((row) => row.status === 'failed').length,
        failed_exports: episodeExports.filter((row) => row.status === 'failed').length,
      }
    })
    return limitResult({
      scope: 'drama',
      drama_id: target.dramaId,
      episodes: items,
      total: episodes.length,
      truncated: episodes.length > items.length,
      counts: {
        episodes: episodes.length,
        episodes_with_current_film: episodes.filter((episode) => episode.currentFilmId && filmById.has(episode.currentFilmId)).length,
        merges: merges.length,
        exports: exports.length,
        failed_merges: merges.filter((row) => row.status === 'failed').length,
        failed_exports: exports.filter((row) => row.status === 'failed').length,
      },
      hint: episodes.length
        ? '项目交付状态按集聚合；失败原因只保留用户可见文案。'
        : '该项目还没有分集；可先在项目页新建分集。',
    })
  },
})

export const HOME_READ_TOOLS: Record<string, any> = {
  read_project_list: readProjectList,
}

export const ASSET_READ_TOOLS: Record<string, any> = {
  read_assets: readAssets,
  read_asset_detail: readAssetDetail,
}

export const DRAMA_READ_TOOLS: Record<string, any> = {
  read_project_overview: readProjectOverview,
  ...ASSET_READ_TOOLS,
  read_delivery_status: readDeliveryStatus,
}

export const DELIVERY_STATUS_TOOLS: Record<string, any> = {
  read_delivery_status: readDeliveryStatus,
}
