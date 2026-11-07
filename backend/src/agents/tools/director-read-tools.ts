/**
 * 导演专员只读工具：导演台作用域专用。
 * 只查询导演计划、分集、素材与分镜；不建计划、不写业务表、不读取素材 URL 或服务器路径。
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { clipText, getAssistantBudget } from '../assistant-context.js'
import { getAssistantScope } from '../context.js'
import type { AgentScope } from '../agent-scope.js'
import {
  DirectorError,
  getDirectorPlanView,
  type DirectorPlanPayload,
  type DirectorShot,
} from '../../services/director-plan.js'

function fail(error: string, hint: string, status?: number) {
  return status ? { error, hint, status } : { error, hint }
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

function directorScope(scope: AgentScope | null): AgentScope | ReturnType<typeof fail> {
  if (!scope || scope.kind !== 'director' || !scope.drama_id || !scope.episode_id) {
    return fail('当前页面不是导演台作用域', '请在单集制作区的导演台页签使用该工具。', 403)
  }
  return scope
}

function isFail(value: unknown): value is { error: string; hint: string; status?: number } {
  return Boolean(value && typeof value === 'object' && 'error' in (value as Record<string, unknown>))
}

function jsonArrayText(value: string | null | undefined): string {
  if (!value) return ''
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(item => safeText(item, 80)).join(' / ') : safeText(value, 200)
  } catch {
    return safeText(value, 200)
  }
}

function shotSummary(shot: DirectorShot) {
  return {
    storyboard_id: shot.storyboard_id,
    shot_number: shot.shot_number,
    scene_id: shot.scene_id,
    duration_sec: shot.duration_sec,
    camera: {
      shot_type: shot.camera.shot_type,
      angle: shot.camera.angle,
      movement: shot.camera.movement,
      lens_mm: shot.camera.lens_mm,
      height_m: shot.camera.height_m,
      position: shot.camera.position,
      look_at: shot.camera.look_at,
    },
    blocking: shot.blocking.map(item => ({
      character_id: item.character_id,
      name: safeText(item.name, 60),
      x: item.x,
      y: item.y,
      z: item.z,
      rotation: item.rotation,
    })),
    subshots: shot.subshots.map(item => ({
      no: item.no,
      description: safeText(item.description, 120),
      duration_sec: item.duration_sec,
      path_index: item.path_index,
    })),
    notes: safeText(shot.notes, 240),
    dirty_fields: shot.dirty_fields,
  }
}

const readDirectorPlan = createTool({
  id: 'read_director_plan',
  description: 'Read the current episode director plan: plan version, shot count, 2D/3D view, camera, blocking and subshots for each storyboard. Read-only; never saves or creates a plan.',
  inputSchema: z.object({
    storyboard_id: z.number().int().positive().optional().describe('Optional storyboard ID to focus; defaults to the focused shot in the current page scope'),
  }),
  execute: async ({ storyboard_id }, context) => {
    const scope = directorScope(getAssistantScope(context?.requestContext))
    if (isFail(scope)) return scope
    let payload: DirectorPlanPayload
    try {
      payload = await getDirectorPlanView(scope.episode_id!)
    } catch (error) {
      if (error instanceof DirectorError) {
        return fail(error.message, '请确认导演台已开启且当前分集存在。', error.status)
      }
      console.error('[agent-director] read plan failed:', error instanceof Error ? error.message : error)
      return fail('读取导演计划失败', '请稍后重试。', 500)
    }
    const focusId = storyboard_id ?? scope.focus?.storyboard_id
    const focused = focusId
      ? payload.plan.shots.find(shot => shot.storyboard_id === focusId) ?? null
      : null
    return limitResult({
      mode: payload.mode,
      can_edit: payload.can_edit,
      view3d_enabled: payload.view3d_enabled,
      version: payload.plan.version,
      doc_version: payload.plan.doc_version,
      based_on: payload.plan.based_on,
      view: payload.plan.view,
      shot_count: payload.plan.shots.length,
      storyboard_count: payload.storyboards.length,
      warnings: payload.warnings.slice(0, 10).map(item => safeText(item, 160)),
      storyboards: payload.storyboards.slice(0, 200),
      shots: payload.plan.shots.slice(0, 100).map(shotSummary),
      focused_shot: focused ? shotSummary(focused) : null,
    })
  },
})

const readEpisodeContext = createTool({
  id: 'read_episode_context',
  description: 'Read the current episode context: drama/episode identity, script length, asset and storyboard counts, line/dubbing completion. Read-only; never creates rows.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const scope = directorScope(getAssistantScope(context?.requestContext))
    if (isFail(scope)) return scope
    const dramaId = scope.drama_id!
    const episodeId = scope.episode_id!
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
    if (!episode || episode.deletedAt) return fail('分集不存在或已删除', '请返回项目页重新打开分集。', 404)
    const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
    if (!drama || drama.deletedAt) return fail('项目不存在或已删除', '请返回项目列表。', 404)

    const characterLinks = db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
    const sceneLinks = db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
    const propLinks = db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId)).all()
    const storyboards = db.select({ id: schema.storyboards.id }).from(schema.storyboards)
      .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt))).all()
    const lines = db.select().from(schema.storyboardLines)
      .where(eq(schema.storyboardLines.episodeId, episodeId)).all()
    const voiced = lines.filter(line => Boolean(line.audioUrl) || Number(line.audioDurationMs ?? 0) > 0).length
    const script = String(episode.scriptContent || episode.content || '')

    return limitResult({
      drama: { id: drama.id, title: safeText(drama.title, 120) },
      episode: {
        id: episode.id,
        episode_number: episode.episodeNumber,
        title: safeText(episode.title, 120),
        status: episode.status,
        duration_sec: Number(episode.duration ?? 0),
        video_mode: episode.videoMode,
        dub_status: episode.dubStatus,
        stage: scope.stage ?? null,
      },
      script_chars: script.length,
      counts: {
        characters: characterLinks.length,
        scenes: sceneLinks.length,
        props: propLinks.length,
        storyboards: storyboards.length,
        lines: lines.length,
      },
      dubbing: {
        lines: lines.length,
        voiced,
        missing: Math.max(0, lines.length - voiced),
      },
    })
  },
})

type AssetType = 'character' | 'scene' | 'prop'

function assetTypeLabel(type: AssetType): string {
  return type === 'character' ? '角色' : type === 'scene' ? '场景' : '道具'
}

function loadAssetRows(scope: AgentScope, type: AssetType, ids: number[]): any[] {
  if (!ids.length) return []
  const table = type === 'character' ? schema.characters : type === 'scene' ? schema.scenes : schema.props
  return db.select().from(table)
    .where(and(inArray(table.id, ids), isNull(table.deletedAt)))
    .all()
}

function assetSummary(type: AssetType, row: Record<string, any>) {
  if (type === 'character') {
    return {
      asset_type: type,
      id: row.id,
      name: safeText(row.name, 80),
      role: safeText(row.role, 80),
      has_final_prompt: Boolean(row.finalPrompt),
      has_image: Boolean(row.imageUrl),
      description: safeText(row.description, 160),
    }
  }
  if (type === 'scene') {
    return {
      asset_type: type,
      id: row.id,
      name: safeText(row.location, 80),
      time: safeText(row.time, 40),
      has_final_prompt: Boolean(row.finalPrompt),
      has_image: Boolean(row.imageUrl),
      description: safeText(row.prompt, 160),
    }
  }
  return {
    asset_type: type,
    id: row.id,
    name: safeText(row.name, 80),
    type: safeText(row.type, 40),
    has_final_prompt: Boolean(row.finalPrompt),
    has_image: Boolean(row.imageUrl),
    description: safeText(row.description, 160),
  }
}

const readAssets = createTool({
  id: 'read_assets',
  description: 'List the characters, scenes and props bound to the current episode. Returns summaries only; use read_asset_detail for full prompts. Read-only.',
  inputSchema: z.object({
    asset_type: z.enum(['character', 'scene', 'prop']).optional().describe('Optional asset type filter'),
    limit: z.number().int().min(1).max(100).optional().describe('Max rows per type; default 50'),
  }),
  execute: async ({ asset_type, limit }, context) => {
    const scope = directorScope(getAssistantScope(context?.requestContext))
    if (isFail(scope)) return scope
    const episodeId = scope.episode_id!
    const max = limit ?? 50
    const types: AssetType[] = asset_type ? [asset_type] : ['character', 'scene', 'prop']
    const result: Record<string, any[]> = {}
    for (const type of types) {
      const links = type === 'character'
        ? db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
          .map(link => link.characterId)
        : type === 'scene'
          ? db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId)).all()
            .map(link => link.sceneId)
          : db.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId)).all()
            .map(link => link.propId)
      const rows = loadAssetRows(scope, type, links).slice(0, max)
      result[type === 'character' ? 'characters' : type === 'scene' ? 'scenes' : 'props'] = rows.map(row => assetSummary(type, row))
    }
    return limitResult({
      episode_id: episodeId,
      total_by_type: Object.fromEntries(types.map((type) => [
        type,
        type === 'character'
          ? db.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId)).all().length
          : type === 'scene'
            ? db.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId)).all().length
            : db.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId)).all().length,
      ])),
      ...result,
    })
  },
})

const readAssetDetail = createTool({
  id: 'read_asset_detail',
  description: 'Read one episode asset detail: prompts and visual description for a character, scene or prop. Read-only and limited to the current drama.',
  inputSchema: z.object({
    asset_type: z.enum(['character', 'scene', 'prop']).describe('Asset table'),
    asset_id: z.number().int().positive().describe('Asset row ID from read_assets'),
  }),
  execute: async ({ asset_type, asset_id }, context) => {
    const scope = directorScope(getAssistantScope(context?.requestContext))
    if (isFail(scope)) return scope
    const rows = loadAssetRows(scope, asset_type as AssetType, [asset_id])
    const row = rows[0]
    if (!row || row.dramaId !== scope.drama_id) {
      return fail(`${assetTypeLabel(asset_type as AssetType)}不存在或不属于当前项目`, '请先用 read_assets 获取当前集可用的素材编号。', 404)
    }
    const storyboardIds = asset_type === 'character'
      ? db.select().from(schema.storyboardCharacters)
        .where(eq(schema.storyboardCharacters.characterId, asset_id)).all()
        .map(link => link.storyboardId)
      : asset_type === 'prop'
        ? db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.propId, asset_id)).all()
          .map(link => link.storyboardId)
        : db.select({ id: schema.storyboards.id }).from(schema.storyboards)
          .where(and(eq(schema.storyboards.sceneId, asset_id), eq(schema.storyboards.episodeId, scope.episode_id!), isNull(schema.storyboards.deletedAt))).all()
          .map(link => link.id)

    const base = {
      asset_type,
      id: row.id,
      name: safeText(asset_type === 'scene' ? row.location : row.name, 100),
      has_image: Boolean(row.imageUrl),
      bound_storyboards: [...new Set(storyboardIds)].slice(0, 100),
    }
    if (asset_type === 'character') {
      return limitResult({
        ...base,
        role: safeText(row.role, 120),
        description: plainText(row.description, 1000),
        appearance: plainText(row.appearance, 1000),
        styling: plainText(row.styling, 1000),
        personality: plainText(row.personality, 800),
        final_prompt: plainText(row.finalPrompt, 2000),
      })
    }
    if (asset_type === 'scene') {
      return limitResult({
        ...base,
        time: safeText(row.time, 60),
        lighting: plainText(row.lighting, 600),
        prompt: plainText(row.prompt, 1200),
        final_prompt: plainText(row.finalPrompt, 2000),
        reference_images: jsonArrayText(row.referenceImages),
      })
    }
    return limitResult({
      ...base,
      type: safeText(row.type, 60),
      description: plainText(row.description, 1000),
      prompt: plainText(row.prompt, 1200),
      final_prompt: plainText(row.finalPrompt, 2000),
    })
  },
})

const readStoryboards = createTool({
  id: 'read_storyboards',
  description: 'List storyboards for the current episode in storyboard order with shot metadata and asset counts. Read-only; never re-splits or edits storyboards.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).optional().describe('Max rows; default 50'),
  }),
  execute: async ({ limit }, context) => {
    const scope = directorScope(getAssistantScope(context?.requestContext))
    if (isFail(scope)) return scope
    const episodeId = scope.episode_id!
    const rows = db.select().from(schema.storyboards)
      .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
      .orderBy(asc(schema.storyboards.storyboardNumber), asc(schema.storyboards.id))
      .all()
    const ids = rows.map(row => row.id)
    const lineCounts = new Map<number, number>()
    const characterCounts = new Map<number, number>()
    const propCounts = new Map<number, number>()
    if (ids.length) {
      for (const line of db.select().from(schema.storyboardLines).where(inArray(schema.storyboardLines.storyboardId, ids)).all()) {
        if (line.storyboardId == null) continue
        lineCounts.set(line.storyboardId, (lineCounts.get(line.storyboardId) ?? 0) + 1)
      }
      for (const link of db.select().from(schema.storyboardCharacters).where(inArray(schema.storyboardCharacters.storyboardId, ids)).all()) {
        characterCounts.set(link.storyboardId, (characterCounts.get(link.storyboardId) ?? 0) + 1)
      }
      for (const link of db.select().from(schema.storyboardProps).where(inArray(schema.storyboardProps.storyboardId, ids)).all()) {
        propCounts.set(link.storyboardId, (propCounts.get(link.storyboardId) ?? 0) + 1)
      }
    }
    return limitResult({
      episode_id: episodeId,
      total: rows.length,
      storyboards: rows.slice(0, limit ?? 50).map(row => ({
        storyboard_id: row.id,
        storyboard_number: row.storyboardNumber,
        title: safeText(row.title, 80),
        location: safeText(row.location, 80),
        time: safeText(row.time, 40),
        shot_type: row.shotType,
        angle: row.angle,
        movement: row.movement,
        duration: Number(row.duration ?? 0),
        transition: row.transition,
        has_video: Boolean(row.videoUrl || row.composedVideoUrl),
        has_image: Boolean(row.composedImage || row.firstFrameImage || row.imagePrompt),
        line_count: lineCounts.get(row.id) ?? 0,
        character_count: characterCounts.get(row.id) ?? 0,
        prop_count: propCounts.get(row.id) ?? 0,
      })),
    })
  },
})

const readStoryboardDetail = createTool({
  id: 'read_storyboard_detail',
  description: 'Read one storyboard full detail for the current episode: shot fields, prompts, bound characters/props and lines. Read-only.',
  inputSchema: z.object({
    storyboard_id: z.number().int().positive().describe('Storyboard ID from read_storyboards'),
  }),
  execute: async ({ storyboard_id }, context) => {
    const scope = directorScope(getAssistantScope(context?.requestContext))
    if (isFail(scope)) return scope
    const row = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).get()
    if (!row || row.deletedAt || row.episodeId !== scope.episode_id) {
      return fail('分镜不存在或不属于当前分集', '请先用 read_storyboards 获取当前集的分镜编号。', 404)
    }
    const lines = db.select().from(schema.storyboardLines)
      .where(eq(schema.storyboardLines.storyboardId, storyboard_id))
      .orderBy(asc(schema.storyboardLines.lineNo))
      .all()
    const characterIds = db.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)).all()
      .map(link => link.characterId)
    const propIds = db.select().from(schema.storyboardProps)
      .where(eq(schema.storyboardProps.storyboardId, storyboard_id)).all()
      .map(link => link.propId)
    const characters = characterIds.length
      ? db.select({ id: schema.characters.id, name: schema.characters.name }).from(schema.characters).where(inArray(schema.characters.id, characterIds)).all()
      : []
    const props = propIds.length
      ? db.select({ id: schema.props.id, name: schema.props.name }).from(schema.props).where(inArray(schema.props.id, propIds)).all()
      : []

    return limitResult({
      storyboard_id: row.id,
      storyboard_number: row.storyboardNumber,
      episode_id: row.episodeId,
      scene_id: row.sceneId,
      title: safeText(row.title, 120),
      location: safeText(row.location, 120),
      time: safeText(row.time, 60),
      shot_type: row.shotType,
      angle: row.angle,
      movement: row.movement,
      duration: Number(row.duration ?? 0),
      transition: row.transition,
      result: plainText(row.result, 800),
      atmosphere: plainText(row.atmosphere, 600),
      description: plainText(row.description, 1200),
      continuity: plainText(row.continuity, 800),
      image_prompt: plainText(row.imagePrompt, 1500),
      video_prompt: plainText(row.videoPrompt, 2000),
      bgm_prompt: plainText(row.bgmPrompt, 800),
      sound_effect: plainText(row.soundEffect, 600),
      status: row.status,
      has_video: Boolean(row.videoUrl || row.composedVideoUrl),
      characters: characters.map(item => ({ id: item.id, name: safeText(item.name, 80) })),
      props: props.map(item => ({ id: item.id, name: safeText(item.name, 80) })),
      lines: lines.slice(0, 100).map(line => ({
        line_id: line.id,
        line_no: line.lineNo,
        speaker_type: line.speakerType,
        speaker_name: safeText(line.speakerName, 60),
        text: plainText(line.text, 800),
        subtitle_text: plainText(line.subtitleText, 800),
        emotion: safeText(line.emotion, 80),
        direction: safeText(line.direction, 200),
        has_audio: Boolean(line.audioUrl),
      })),
    })
  },
})

export const DIRECTOR_READ_TOOLS: Record<string, any> = {
  read_director_plan: readDirectorPlan,
  read_episode_context: readEpisodeContext,
  read_assets: readAssets,
  read_asset_detail: readAssetDetail,
  read_storyboards: readStoryboards,
  read_storyboard_detail: readStoryboardDetail,
}
