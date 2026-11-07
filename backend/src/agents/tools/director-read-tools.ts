/**
 * 单集只读工具：episode / director / edit / mix / delivery 作用域共享。
 * 只查询分集上下文、剧本、配音、分镜与导演计划；不建计划、不写业务表、不读取素材 URL 或服务器路径。
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

const EPISODE_SCOPE_KINDS = new Set<AgentScope['kind']>(['episode', 'director', 'edit', 'mix', 'delivery'])

function episodeScope(scope: AgentScope | null): AgentScope | ReturnType<typeof fail> {
  if (!scope || !EPISODE_SCOPE_KINDS.has(scope.kind) || !scope.drama_id || !scope.episode_id) {
    return fail('当前页面不是分集作用域', '请在分集制作区（含导演台、剪辑、混音、交付）使用该工具。', 403)
  }
  return scope
}

function episodeOnlyScope(scope: AgentScope | null): AgentScope | ReturnType<typeof fail> {
  if (!scope || scope.kind !== 'episode' || !scope.drama_id || !scope.episode_id) {
    return fail('当前页面不是分集作用域', '请在分集页的剧本或配音阶段使用该工具。', 403)
  }
  return scope
}

function directorOnlyScope(scope: AgentScope | null): AgentScope | ReturnType<typeof fail> {
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
    const scope = directorOnlyScope(getAssistantScope(context?.requestContext))
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
    const scope = episodeScope(getAssistantScope(context?.requestContext))
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

const readScript = createTool({
  id: 'read_script',
  description: 'Read the current episode script. Prefers the rewritten script_content; when empty falls back to episodes.content and marks it as the original unrewritten text. Returns character count, source and last update. Only available in the episode scope.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const scope = episodeOnlyScope(getAssistantScope(context?.requestContext))
    if (isFail(scope)) return scope
    const dramaId = scope.drama_id!
    const episodeId = scope.episode_id!
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
    if (!episode || episode.deletedAt || episode.dramaId !== dramaId) {
      return fail('分集不存在或已删除', '请返回项目页重新打开分集。', 404)
    }
    const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
    if (!drama || drama.deletedAt) return fail('项目不存在或已删除', '请返回项目列表。', 404)

    const rewritten = String(episode.scriptContent ?? '').trim()
    const original = String(episode.content ?? '').trim()
    const content = rewritten || original
    return limitResult({
      drama_id: dramaId,
      episode_id: episodeId,
      title: safeText(episode.title, 120),
      source: rewritten ? 'script_content' : original ? 'content' : 'empty',
      original: !rewritten,
      note: !rewritten && original ? '原文未改写：剧本尚未生成，当前返回的是原文（episodes.content）。' : null,
      chars: content.length,
      updated_at: episode.updatedAt,
      content,
      truncated: false,
      hint: content
        ? rewritten
          ? '正文只读；需要改写请在剧本页运行 AI 改写。'
          : '当前返回原文未改写；需要正式剧本请在剧本页运行 AI 改写。'
        : '当前集还没有剧本内容；可在剧本页粘贴原文或生成剧本。',
    })
  },
})

const readDubbingStatus = createTool({
  id: 'read_dubbing_status',
  description: 'Read current episode dubbing status: line count, ready takes, missing dialogue, missing narrator lines and voice profiles. Never returns audio file paths. Only available in the episode scope.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const scope = episodeOnlyScope(getAssistantScope(context?.requestContext))
    if (isFail(scope)) return scope
    const dramaId = scope.drama_id!
    const episodeId = scope.episode_id!
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
    if (!episode || episode.deletedAt || episode.dramaId !== dramaId) {
      return fail('分集不存在或已删除', '请返回项目页重新打开分集。', 404)
    }

    const lines = db.select().from(schema.storyboardLines)
      .where(and(eq(schema.storyboardLines.episodeId, episodeId), isNull(schema.storyboardLines.deletedAt)))
      .orderBy(asc(schema.storyboardLines.lineNo), asc(schema.storyboardLines.id))
      .all()
    const takes = db.select().from(schema.lineTakes)
      .where(and(eq(schema.lineTakes.episodeId, episodeId), isNull(schema.lineTakes.deletedAt)))
      .all()
    const takesByLine = new Map<number, typeof takes>()
    for (const take of takes) {
      const list = takesByLine.get(take.lineId) ?? []
      list.push(take)
      takesByLine.set(take.lineId, list)
    }
    const hasTake = (lineId: number) => (takesByLine.get(lineId) ?? [])
      .some((take) => take.status === 'ready' && Boolean(take.audioUrl))
    const isGenerated = (line: typeof lines[number]) => Boolean(line.audioUrl) || hasTake(line.id)
    const generatedLines = lines.filter(isGenerated)
    const missingLines = lines.filter((line) => !isGenerated(line))
    const narratorLines = lines.filter((line) => line.speakerType === 'narrator')
    const narratorGenerated = narratorLines.filter(isGenerated)

    const voices = db.select().from(schema.characterVoices)
      .where(and(eq(schema.characterVoices.dramaId, dramaId), isNull(schema.characterVoices.deletedAt)))
      .all()
    const activeVoices = voices.filter((voice) => voice.isActive)
    const narratorVoice = activeVoices.find((voice) => voice.scope === 'narrator') ?? null

    return limitResult({
      drama_id: dramaId,
      episode_id: episodeId,
      dub_status: episode.dubStatus ?? null,
      lines: lines.length,
      generated: generatedLines.length,
      missing: missingLines.length,
      narrator: {
        total: narratorLines.length,
        generated: narratorGenerated.length,
        missing: narratorLines.length - narratorGenerated.length,
      },
      takes: {
        total: takes.length,
        active: takes.filter((take) => take.isActive).length,
        ready: takes.filter((take) => take.status === 'ready').length,
        failed: takes.filter((take) => take.status === 'failed').length,
      },
      voices: {
        total: voices.length,
        active: activeVoices.length,
        narrator_present: Boolean(narratorVoice),
        items: voices.slice(0, 50).map((voice) => ({
          id: voice.id,
          name: safeText(voice.name, 80),
          scope: voice.scope,
          character_id: voice.characterId ?? null,
          status: voice.status,
          is_active: Boolean(voice.isActive),
        })),
      },
      missing_line_refs: missingLines.slice(0, 50).map((line) => ({
        line_id: line.id,
        line_no: line.lineNo,
        speaker_type: line.speakerType,
        speaker_name: safeText(line.speakerName, 60),
      })),
      hint: lines.length
        ? missingLines.length
          ? '仍有台词未生成音频；可回到配音阶段生成缺失台词。'
          : '全部台词已有音频；如需调整音色请回到配音阶段。'
        : '当前集还没有台词；请先在分镜或配音阶段抽取台词。',
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
    const scope = episodeScope(getAssistantScope(context?.requestContext))
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
      for (const line of db.select().from(schema.storyboardLines)
        .where(and(inArray(schema.storyboardLines.storyboardId, ids), isNull(schema.storyboardLines.deletedAt)))
        .all()) {
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
        image_prompt_length: String(row.imagePrompt ?? '').length,
        video_prompt_length: String(row.videoPrompt ?? '').length,
        description_length: String(row.description ?? '').length,
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
    const scope = episodeScope(getAssistantScope(context?.requestContext))
    if (isFail(scope)) return scope
    const row = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).get()
    if (!row || row.deletedAt || row.episodeId !== scope.episode_id) {
      return fail('分镜不存在或不属于当前分集', '请先用 read_storyboards 获取当前集的分镜编号。', 404)
    }
    const lines = db.select().from(schema.storyboardLines)
      .where(and(eq(schema.storyboardLines.storyboardId, storyboard_id), isNull(schema.storyboardLines.deletedAt)))
      .orderBy(asc(schema.storyboardLines.lineNo))
      .all()
    const characterIds = db.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)).all()
      .map(link => link.characterId)
    const propIds = db.select().from(schema.storyboardProps)
      .where(eq(schema.storyboardProps.storyboardId, storyboard_id)).all()
      .map(link => link.propId)
    const characters = characterIds.length
      ? db.select({ id: schema.characters.id, name: schema.characters.name }).from(schema.characters)
        .where(and(inArray(schema.characters.id, characterIds), isNull(schema.characters.deletedAt))).all()
      : []
    const props = propIds.length
      ? db.select({ id: schema.props.id, name: schema.props.name }).from(schema.props)
        .where(and(inArray(schema.props.id, propIds), isNull(schema.props.deletedAt))).all()
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

export const EPISODE_CONTEXT_READ_TOOLS: Record<string, any> = {
  read_episode_context: readEpisodeContext,
  read_storyboards: readStoryboards,
  read_storyboard_detail: readStoryboardDetail,
}

export const EPISODE_READ_TOOLS: Record<string, any> = {
  ...EPISODE_CONTEXT_READ_TOOLS,
  read_script: readScript,
  read_dubbing_status: readDubbingStatus,
}

export const DIRECTOR_READ_TOOLS: Record<string, any> = {
  ...EPISODE_CONTEXT_READ_TOOLS,
  read_director_plan: readDirectorPlan,
}
