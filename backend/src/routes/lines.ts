/**
 * 台词行路由（V3 · 配音工作台阶段 1）
 *
 * - GET  /episodes/:id/lines            （默认过滤已删除，支持 include_deleted/filter/search）
 * - POST /episodes/:id/lines            （新增：镜头锚点 / 绝对时间锚点）
 * - POST /episodes/:id/lines/reorder    （批量排序）
 * - POST /episodes/:id/lines/extract/preview / apply（重抽预览与应用）
 * - POST /episodes/:id/lines/extract    （旧版重抽，兼容保留）
 * - POST /episodes/:id/lines/synthesize （批量合成）
 * - PUT  /lines/:id、DELETE /lines/:id、POST /lines/:id/restore、POST /lines/:id/synthesize
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, notFound, success } from '../utils/response.js'
import { extractEpisodeLines } from '../services/dialogue-extract.js'
import { synthesizeEpisodeLines, getDubbingState } from '../services/dubbing.js'
import { generateTake } from '../services/line-takes.js'
import {
  addLine,
  restoreLine,
  reorderLines,
  softDeleteLine,
  updateLine,
  type AddLineInput,
  type UpdateLinePatch,
} from '../services/line-workbench.js'
import {
  applyEpisodeMerge,
  loadMergePlan,
  planEpisodeMerge,
  rememberMergePlan,
  type MergeDecision,
  type MergePlan,
} from '../services/dialogue-merge.js'

const lines = new Hono()
const episodeLines = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function characterName(characterId: number | null | undefined): string | null {
  if (!characterId) return null
  return db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()?.name ?? null
}

function lineResponse(row: typeof schema.storyboardLines.$inferSelect) {
  return {
    ...row,
    character_name: characterName(row.characterId),
    audio_url: row.audioUrl,
  }
}

function listEpisodeLines(episodeId: number, options: {
  includeDeleted?: boolean
  filter?: string
  search?: string
} = {}) {
  const conditions = [eq(schema.storyboardLines.episodeId, episodeId)]
  if (!options.includeDeleted) conditions.push(isNull(schema.storyboardLines.deletedAt))
  const rows = db.select().from(schema.storyboardLines)
    .where(and(...conditions))
    .orderBy(
      asc(schema.storyboardLines.storyboardId),
      asc(schema.storyboardLines.sortOrder),
      asc(schema.storyboardLines.lineNo),
      asc(schema.storyboardLines.id),
    )
    .all()

  const filter = options.filter || ''
  const search = (options.search || '').trim().toLowerCase()
  return rows
    .filter((row) => {
      if (filter === 'dialogue' || filter === 'narration' || filter === 'inner') return row.speakerType === filter
      if (filter === 'stale') return Boolean(row.stale)
      if (filter === 'audio_stale') return Boolean(row.audioStale)
      if (filter === 'failed') return row.status === 'failed'
      if (filter === 'needs_review') return Boolean(row.needsReview)
      if (filter === 'problem') {
        return Boolean(row.stale || row.audioStale || row.needsReview) || row.status === 'failed'
      }
      return true
    })
    .filter((row) => {
      if (!search) return true
      return row.text.toLowerCase().includes(search)
        || (row.speakerName || '').toLowerCase().includes(search)
    })
    .map(lineResponse)
}

function mapAddInput(body: any): AddLineInput {
  const anchor = body?.anchor ?? {}
  return {
    text: body?.text,
    speakerType: body?.speaker_type ?? body?.speakerType,
    characterId: body?.character_id !== undefined ? body.character_id : body?.characterId,
    speakerName: body?.speaker_name !== undefined ? body.speaker_name : body?.speakerName,
    direction: body?.direction,
    locked: body?.locked,
    anchor: {
      type: anchor.type,
      storyboardId: anchor.storyboard_id !== undefined ? anchor.storyboard_id : anchor.storyboardId,
      startMs: anchor.start_ms !== undefined ? anchor.start_ms : anchor.startMs,
      afterLineId: anchor.after_line_id !== undefined ? anchor.after_line_id : anchor.afterLineId,
    },
  }
}

function mapUpdatePatch(body: any): UpdateLinePatch {
  const patch: UpdateLinePatch = {}
  if (body?.text !== undefined) patch.text = String(body.text)
  if (body?.speaker_type !== undefined || body?.speakerType !== undefined) {
    patch.speakerType = String(body.speaker_type ?? body.speakerType)
  }
  if (body?.character_id !== undefined || body?.characterId !== undefined) {
    const value = body.character_id !== undefined ? body.character_id : body.characterId
    patch.characterId = value === null ? null : Number(value)
  }
  if (body?.speaker_name !== undefined || body?.speakerName !== undefined) {
    const value = body.speaker_name !== undefined ? body.speaker_name : body.speakerName
    patch.speakerName = value === null ? null : String(value)
  }
  if (body?.voice_id !== undefined || body?.voiceId !== undefined) {
    const value = body.voice_id !== undefined ? body.voice_id : body.voiceId
    patch.voiceId = value === null ? null : Number(value)
  }
  if (body?.voice_locked !== undefined) patch.voiceLocked = Boolean(body.voice_locked)
  if (body?.direction !== undefined) patch.direction = body.direction === null ? null : String(body.direction)
  if (body?.emotion !== undefined) patch.emotion = body.emotion === null ? null : String(body.emotion)
  if (body?.speed !== undefined) patch.speed = Number(body.speed)
  if (body?.anchor_type !== undefined) patch.anchorType = body.anchor_type === 'absolute' ? 'absolute' : 'shot'
  if (body?.storyboard_id !== undefined || body?.storyboardId !== undefined) {
    const value = body.storyboard_id !== undefined ? body.storyboard_id : body.storyboardId
    patch.storyboardId = value === null ? null : Number(value)
  }
  const startMs = body?.start_ms !== undefined ? body.start_ms
    : body?.voice_start_ms !== undefined ? body.voice_start_ms
      : body?.voiceStartMs
  if (startMs !== undefined) patch.voiceStartMs = startMs === null ? null : Number(startMs)
  if (body?.voice_duration_ms !== undefined || body?.voiceDurationMs !== undefined) {
    const value = body.voice_duration_ms !== undefined ? body.voice_duration_ms : body.voiceDurationMs
    patch.voiceDurationMs = value === null ? null : Number(value)
  }
  if (body?.locked !== undefined) patch.locked = Boolean(body.locked)
  if (body?.needs_review !== undefined) patch.needsReview = Boolean(body.needs_review)
  return patch
}

function lineError(c: Context, error: any, fallback: string) {
  return badRequest(c, error?.message || fallback)
}

episodeLines.get('/:id/lines', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  return success(c, {
    items: listEpisodeLines(episodeId, {
      includeDeleted: c.req.query('include_deleted') === '1',
      filter: c.req.query('filter'),
      search: c.req.query('search'),
    }),
  })
})

episodeLines.post('/:id/lines', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, lineResponse(addLine(episodeId, mapAddInput(body))))
  } catch (error: any) {
    return lineError(c, error, '新增台词失败')
  }
})

episodeLines.post('/:id/lines/reorder', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const body = await c.req.json().catch(() => ({}))
  const raw = body?.ids ?? body?.line_ids ?? body?.lineIds
  if (!Array.isArray(raw)) return badRequest(c, '请提供台词顺序')
  try {
    return success(c, reorderLines(episodeId, raw.map(Number)))
  } catch (error: any) {
    return lineError(c, error, '排序失败')
  }
})

episodeLines.post('/:id/lines/extract/preview', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const body = await c.req.json().catch(() => ({}))
  const rawIds = body?.storyboard_ids ?? body?.storyboardIds
  try {
    const plan = planEpisodeMerge(episodeId, {
      force: Boolean(body?.force),
      storyboardIds: Array.isArray(rawIds) ? rawIds.map(Number) : undefined,
    })
    rememberMergePlan(plan)
    return success(c, plan)
  } catch (error: any) {
    return lineError(c, error, '重抽预览失败')
  }
})

episodeLines.post('/:id/lines/extract/apply', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const body = await c.req.json().catch(() => ({}))
  const supplied = body?.plan
  const plan: MergePlan | null = supplied && Array.isArray(supplied.groups)
    ? supplied as MergePlan
    : body?.extraction_id
      ? loadMergePlan(String(body.extraction_id))
      : null
  if (!plan) return badRequest(c, '预览已过期，请重新预览')
  if (plan.episodeId !== episodeId) return badRequest(c, '重抽计划不属于本集')
  const decisions: MergeDecision[] = Array.isArray(body?.decisions) ? body.decisions : []
  try {
    return success(c, applyEpisodeMerge(episodeId, plan, decisions))
  } catch (error: any) {
    return lineError(c, error, '应用重抽失败')
  }
})

episodeLines.post('/:id/lines/extract', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    const result = extractEpisodeLines(episodeId, { force: Boolean((c.req.query('force') || '') === '1') })
    return success(c, result)
  } catch (error: any) {
    return badRequest(c, error?.message || '台词抽取失败')
  }
})

episodeLines.post('/:id/lines/synthesize', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  try {
    const result = await synthesizeEpisodeLines(episodeId, episode.dramaId, {
      force: Boolean(body.force),
      limit: body.limit ? Number(body.limit) : undefined,
    })
    return success(c, {
      ok: result.ok,
      failed: result.failed,
      skipped: result.skipped,
      failures: result.outcomes.filter((o) => !o.ok).slice(0, 20),
    })
  } catch (error: any) {
    return badRequest(c, error?.message || '批量合成失败')
  }
})

episodeLines.get('/:id/lines/status', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const rows = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .all()
  return success(c, {
    total: rows.length,
    ready: rows.filter((r) => r.status === 'ready').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    stale: rows.filter((r) => r.stale).length,
    audio_stale: rows.filter((r) => r.audioStale).length,
    needs_review: rows.filter((r) => r.needsReview).length,
    dubbing: getDubbingState(episodeId),
  })
})

lines.put('/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '台词编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, lineResponse(updateLine(id, mapUpdatePatch(body))))
  } catch (error: any) {
    return lineError(c, error, '保存台词失败')
  }
})

lines.post('/:id/restore', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '台词编号无效')
  try {
    return success(c, lineResponse(restoreLine(id)))
  } catch (error: any) {
    return lineError(c, error, '恢复台词失败')
  }
})

lines.post('/:id/synthesize', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '台词编号无效')
  const row = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()
  if (!row) return notFound(c, '台词不存在')
  const body = await c.req.json().catch(() => ({}))
  const voice = body?.voice_id ?? body?.voiceId
  try {
    const result = await generateTake({
      lineId: id,
      contextMode: 'light',
      voiceId: voice ? Number(voice) : undefined,
      force: Boolean(body?.force),
      reuse: !body?.force,
      activate: true,
    })
    return success(c, {
      ...lineResponse(result.line),
      duration_ms: result.take.durationMs,
      cached: result.cached,
    })
  } catch (error: any) {
    return badRequest(c, error?.message || '合成失败')
  }
})

lines.delete('/:id', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '台词编号无效')
  try {
    return success(c, softDeleteLine(id))
  } catch (error: any) {
    return lineError(c, error, '删除台词失败')
  }
})

export { episodeLines }
export default lines
