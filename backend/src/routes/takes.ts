/**
 * Take 路由（设计 7.10）：单句生成、历史列表、激活/删除、语境预览、批量任务与状态。
 *
 * 挂载在 /api/v1 根路径下：
 * - POST   /lines/:id/takes
 * - GET    /lines/:id/takes
 * - POST   /lines/:id/context/preview
 * - POST   /takes/:id/activate
 * - DELETE /takes/:id
 * - POST   /episodes/:id/takes/batch
 * - GET    /episodes/:id/takes/batch/:jobId
 * - POST   /episodes/:id/takes/batch/:jobId/cancel
 * - GET    /episodes/:id/takes/status
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, notFound, success } from '../utils/response.js'
import { getAudioConfig } from '../services/tts.js'
import { capabilitiesFor } from '../services/tts-capabilities.js'
import { analyzeLinePerformance } from '../services/line-performance.js'
import type { ContextMode } from '../services/line-context.js'
import {
  activateTake,
  deleteTake,
  generateTake,
  listLineTakes,
  takeStatus,
  type LineRow,
  type TakeOverrides,
  type TakeRow,
} from '../services/line-takes.js'
import {
  cancelTakeBatch,
  getTakeBatch,
  startTakeBatch,
  type TakeBatchFilter,
} from '../services/take-batch.js'

const takes = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function lineResponse(row: LineRow) {
  return { ...row, audio_url: row.audioUrl }
}

function takeResponse(row: TakeRow) {
  const params = parseJson<Record<string, any>>(row.paramsJson, {})
  return {
    id: row.id,
    lineId: row.lineId,
    takeNo: row.takeNo,
    text: row.text,
    speakText: row.speakText,
    textRevision: row.textRevision,
    voiceId: row.voiceId,
    voiceFingerprint: row.voiceFingerprint,
    provider: row.provider,
    model: row.model,
    configId: row.configId,
    params,
    seed: params.seed ?? null,
    ignored: Array.isArray(params.ignored) ? params.ignored : [],
    contextMode: row.contextMode,
    context: parseJson<Record<string, any> | null>(row.contextJson, null),
    contextHash: row.contextHash,
    audioUrl: row.audioUrl,
    durationMs: row.durationMs,
    hash: row.hash,
    status: row.status,
    error: row.error,
    isActive: Boolean(row.isActive),
    createdAt: row.createdAt,
  }
}

function contextModeOf(body: any): ContextMode {
  const raw = body?.context_mode ?? body?.contextMode
  return raw === 'off' || raw === 'deep' ? raw : 'light'
}

function mapOverrides(body: any): TakeOverrides | undefined {
  const overrides: TakeOverrides = {}
  const raw = body?.overrides
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of ['emotion', 'speed', 'instruct', 'pause_hints', 'pronunciation', 'notes'] as const) {
      if (raw[key] !== undefined) (overrides as any)[key] = raw[key]
    }
    if (raw.seed !== undefined) overrides.seed = raw.seed
    if (raw.note !== undefined) overrides.note = raw.note
    if (raw.language !== undefined) overrides.language = raw.language
  }
  for (const key of ['emotion', 'speed', 'instruct', 'pause_hints', 'pronunciation', 'notes'] as const) {
    if (body?.[key] !== undefined) (overrides as any)[key] = body[key]
  }
  const seed = body?.seed ?? body?.requested_seed
  if (seed !== undefined) overrides.seed = seed
  if (body?.note !== undefined) overrides.note = body.note
  if (body?.language !== undefined) overrides.language = body.language
  return Object.keys(overrides).length ? overrides : undefined
}

function takeError(c: Context, error: any, fallback: string) {
  const message = String(error?.message || fallback)
  if (message === '台词不存在' || message === 'Take 不存在') return notFound(c, message)
  return badRequest(c, message)
}

function loadLine(id: number): LineRow {
  const row = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()
  if (!row) throw new Error('台词不存在')
  return row
}

function loadEpisode(id: number) {
  return db.select().from(schema.episodes).where(eq(schema.episodes.id, id)).get() ?? null
}

takes.get('/lines/:id/takes', (c) => {
  const lineId = parseId(c.req.param('id'))
  if (!lineId) return badRequest(c, '台词编号无效')
  try {
    loadLine(lineId)
  } catch (error: any) {
    return takeError(c, error, '台词不存在')
  }
  return success(c, { items: listLineTakes(lineId).map(takeResponse) })
})

takes.post('/lines/:id/takes', async (c) => {
  const lineId = parseId(c.req.param('id'))
  if (!lineId) return badRequest(c, '台词编号无效')
  const body = await c.req.json().catch(() => ({}))
  const voice = body?.voice_id ?? body?.voiceId
  try {
    const result = await generateTake({
      lineId,
      contextMode: contextModeOf(body),
      overrides: mapOverrides(body),
      voiceId: voice ? Number(voice) : undefined,
      force: Boolean(body?.force),
      reuse: body?.reuse === undefined ? false : Boolean(body.reuse),
      activate: body?.activate === undefined ? true : Boolean(body.activate),
    })
    return success(c, {
      take: takeResponse(result.take),
      line: lineResponse(result.line),
      cached: result.cached,
      context: result.context,
      params: result.params,
      source: result.source,
    })
  } catch (error: any) {
    return takeError(c, error, '生成 Take 失败')
  }
})

takes.post('/lines/:id/context/preview', async (c) => {
  const lineId = parseId(c.req.param('id'))
  if (!lineId) return badRequest(c, '台词编号无效')
  const body = await c.req.json().catch(() => ({}))
  const mode = contextModeOf(body)
  try {
    const analysis = await analyzeLinePerformance(lineId, {
      mode,
      overrides: mapOverrides(body) as any,
    })
    const capability = capabilitiesFor(await getAudioConfig())
    const ignored = new Set(capability.ignored)
    if (analysis.params.emotion && !capability.emotion) ignored.add('emotion')
    if (analysis.params.speed !== null && !capability.speed) ignored.add('speed')
    if (analysis.params.instruct && !capability.designInstruct) ignored.add('instruct')
    return success(c, {
      context: analysis.context,
      params: analysis.params,
      source: analysis.source,
      error: analysis.error,
      capability,
      ignored: [...ignored].sort(),
    })
  } catch (error: any) {
    return takeError(c, error, '语境分析失败')
  }
})

takes.post('/takes/:id/activate', (c) => {
  const takeId = parseId(c.req.param('id'))
  if (!takeId) return badRequest(c, 'Take 编号无效')
  try {
    const take = activateTake(takeId)
    return success(c, {
      take: takeResponse(take),
      line: lineResponse(loadLine(take.lineId)),
    })
  } catch (error: any) {
    return takeError(c, error, '切换 Take 失败')
  }
})

takes.delete('/takes/:id', (c) => {
  const takeId = parseId(c.req.param('id'))
  if (!takeId) return badRequest(c, 'Take 编号无效')
  try {
    return success(c, deleteTake(takeId))
  } catch (error: any) {
    return takeError(c, error, '删除 Take 失败')
  }
})

takes.post('/episodes/:id/takes/batch', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!loadEpisode(episodeId)) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  const rawIds = body?.line_ids ?? body?.lineIds
  const filter = body?.filter as TakeBatchFilter | undefined
  const job = startTakeBatch(episodeId, {
    lineIds: Array.isArray(rawIds) ? rawIds.map(Number) : null,
    filter: filter === 'all' || filter === 'failed' || filter === 'audio_stale' ? filter : 'pending',
    contextMode: contextModeOf(body),
    concurrency: body?.concurrency !== undefined ? Number(body.concurrency) : undefined,
  })
  return success(c, { job_id: job.id })
})

takes.get('/episodes/:id/takes/batch/:jobId', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const job = getTakeBatch(c.req.param('jobId'))
  if (!job || job.episodeId !== episodeId) return notFound(c, '批量任务不存在或已过期')
  return success(c, job)
})

takes.post('/episodes/:id/takes/batch/:jobId/cancel', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const job = getTakeBatch(c.req.param('jobId'))
  if (!job || job.episodeId !== episodeId) return notFound(c, '批量任务不存在或已过期')
  if (!cancelTakeBatch(job.id)) return badRequest(c, '任务已结束，无法取消')
  return success(c, getTakeBatch(job.id))
})

takes.get('/episodes/:id/takes/status', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!loadEpisode(episodeId)) return notFound(c, '集不存在')
  return success(c, takeStatus(episodeId))
})

export default takes
