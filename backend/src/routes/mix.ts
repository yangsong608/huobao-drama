/**
 * 阶段 4 混音路由（设计 8.12）
 *
 * - 分离任务与素材：/episodes/:id/audio/separate*、/audio/assets*
 * - 混音计划与总线：/episodes/:id/mix、/mix/buses
 * - 版本：/mix/revisions*
 * - 试听与导出：/mix/preview、/mix/render
 *
 * 错误映射：AudioEngineError → 503，业务错误 400/409，不存在 404。
 */
import fs from 'fs'
import path from 'path'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, notFound, serverError, success } from '../utils/response.js'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import {
  MixPlanError,
  compileMixPlan,
  ensureDefaultBuses,
  hashMixPlan,
  saveMixPlan,
  saveMixBuses,
  createMixRevision,
  listMixRevisions,
  restoreMixRevision,
  type MixPlanInputBus,
} from '../services/mix-plan.js'
import { renderMixAudio } from '../services/mix-render.js'
import { projectStorageRelative, projectSubdirPath } from '../services/project-storage.js'
import {
  SeparationError,
  startEpisodeSeparation,
  getSeparationStatus,
  cancelEpisodeSeparation,
  listEpisodeAssets,
  deleteEpisodeAsset,
  autoCreateStemTracks,
} from '../services/audio-separation.js'
import { AudioEngineError, type SeparationEngine } from '../services/audio-engine.js'

const app = new Hono()

const SEPARATION_ENGINES: SeparationEngine[] = ['uvr', 'demucs', 'basic']
const PREVIEW_MIN_MS = 500
const PREVIEW_MAX_MS = 30000

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function findEpisode(episodeId: number) {
  return db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get() ?? null
}

function statusError(c: Context, status: 400 | 404 | 409, message: string) {
  if (status === 404) return notFound(c, message)
  return c.json({ code: status, message }, status)
}

function handleError(c: Context, error: any, fallback: string) {
  if (error instanceof AudioEngineError) {
    return c.json({ code: 503, message: error.message, error_code: error.code }, 503)
  }
  if (error instanceof MixPlanError || error instanceof SeparationError) {
    return statusError(c, error.status, error.message)
  }
  if (error instanceof Error && error.name === 'MixRenderError') {
    return badRequest(c, error.message)
  }
  return serverError(c, error?.message || fallback)
}

function busInput(raw: any): MixPlanInputBus {
  return {
    id: raw?.id,
    key: raw?.key,
    volume: raw?.volume,
    muted: raw?.muted,
    solo: raw?.solo,
    ducking: raw?.ducking,
    duckRatio: raw?.duckRatio !== undefined ? raw.duckRatio : raw?.duck_ratio,
    duckAttackMs: raw?.duckAttackMs !== undefined ? raw.duckAttackMs : raw?.duck_attack_ms,
    duckReleaseMs: raw?.duckReleaseMs !== undefined ? raw.duckReleaseMs : raw?.duck_release_ms,
    lufsTarget: raw?.lufsTarget !== undefined ? raw.lufsTarget : raw?.lufs_target,
    limiterCeiling: raw?.limiterCeiling !== undefined ? raw.limiterCeiling : raw?.limiter_ceiling,
  }
}

function serializeBus(row: ReturnType<typeof ensureDefaultBuses>[number]) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    volume: row.volume ?? 1,
    muted: Boolean(row.muted),
    solo: Boolean(row.solo),
    ducking: Boolean(row.ducking),
    duckRatio: row.duckRatio ?? 6,
    duckAttackMs: row.duckAttackMs ?? 20,
    duckReleaseMs: row.duckReleaseMs ?? 250,
    lufsTarget: row.lufsTarget ?? null,
    limiterCeiling: row.limiterCeiling ?? null,
  }
}

function mixDir(dramaId: number): string {
  return path.join(projectSubdirPath(dramaId, 'audio'), 'mix')
}

function audioLogicalUrl(dramaId: number, file: string): string {
  const root = projectSubdirPath(dramaId, 'audio')
  const relative = path.relative(root, file).split(path.sep).join('/')
  return projectStorageRelative(dramaId, 'audio', relative)
}

function roundRange(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : null
}

app.get('/episodes/:id/mix', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = findEpisode(episodeId)
  if (!episode) return notFound(c, '集不存在')
  try {
    return success(c, await compileMixPlan(episodeId, episode.dramaId))
  } catch (error: any) {
    return handleError(c, error, '读取混音计划失败')
  }
})

app.put('/episodes/:id/mix', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = findEpisode(episodeId)
  if (!episode) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  try {
    const plan = await saveMixPlan(episodeId, episode.dramaId, {
      buses: Array.isArray(body.buses) ? body.buses.map(busInput) : undefined,
      tracks: Array.isArray(body.tracks) ? body.tracks : undefined,
      clips: Array.isArray(body.clips) ? body.clips : undefined,
    })
    return success(c, plan)
  } catch (error: any) {
    return handleError(c, error, '保存混音计划失败')
  }
})

app.get('/episodes/:id/mix/buses', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!findEpisode(episodeId)) return notFound(c, '集不存在')
  try {
    return success(c, { items: ensureDefaultBuses(episodeId).map(serializeBus) })
  } catch (error: any) {
    return handleError(c, error, '读取总线失败')
  }
})

app.put('/episodes/:id/mix/buses', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!findEpisode(episodeId)) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  try {
    const buses = Array.isArray(body) ? body : Array.isArray(body.buses) ? body.buses : null
    if (!buses) return badRequest(c, '缺少总线列表')
    return success(c, { items: saveMixBuses(episodeId, buses.map(busInput)).map(serializeBus) })
  } catch (error: any) {
    return handleError(c, error, '保存总线失败')
  }
})

app.get('/episodes/:id/mix/revisions', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, { items: listMixRevisions(episodeId) })
  } catch (error: any) {
    return handleError(c, error, '读取混音版本失败')
  }
})

app.post('/episodes/:id/mix/revisions', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, await createMixRevision(episodeId, body.note))
  } catch (error: any) {
    return handleError(c, error, '保存混音版本失败')
  }
})

app.post('/episodes/:id/mix/revisions/:revisionId/restore', (c) => {
  const episodeId = parseId(c.req.param('id'))
  const revisionId = parseId(c.req.param('revisionId'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!revisionId) return badRequest(c, '版本编号无效')
  try {
    return success(c, restoreMixRevision(episodeId, revisionId))
  } catch (error: any) {
    return handleError(c, error, '恢复混音版本失败')
  }
})

app.post('/episodes/:id/mix/preview', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = findEpisode(episodeId)
  if (!episode) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  try {
    const plan = await compileMixPlan(episodeId, episode.dramaId)
    if (plan.durationMs <= 0) throw new MixPlanError('本集还没有可用的音频片段，无法试听')
    const start = Math.max(0, Math.min(plan.durationMs - 1, roundRange(body.start_ms ?? body.startMs) ?? 0))
    const rawEnd = roundRange(body.end_ms ?? body.endMs)
    let end = rawEnd == null ? Math.min(plan.durationMs, start + 15000) : rawEnd
    end = Math.max(start, Math.min(plan.durationMs, end))
    if (end - start < PREVIEW_MIN_MS) {
      return badRequest(c, `试听范围太短，至少 ${PREVIEW_MIN_MS}ms`)
    }
    if (end - start > PREVIEW_MAX_MS) end = start + PREVIEW_MAX_MS

    const planHash = hashMixPlan(plan)
    const dir = mixDir(episode.dramaId)
    const outputPath = path.join(dir, `preview-${planHash.slice(0, 12)}-${start}-${end}.wav`)
    const cached = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0
    if (!cached) {
      await renderMixAudio(plan, { outputPath, format: 'wav', startMs: start, endMs: end })
    }
    return success(c, {
      url: audioLogicalUrl(episode.dramaId, outputPath),
      startMs: start,
      endMs: end,
      durationMs: end - start,
      planHash,
      cached,
    })
  } catch (error: any) {
    return handleError(c, error, '生成试听失败')
  }
})

app.post('/episodes/:id/mix/render', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = findEpisode(episodeId)
  if (!episode) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  const format = body.format === undefined ? 'm4a' : String(body.format)
  if (format !== 'wav' && format !== 'm4a') return badRequest(c, '导出格式仅支持 wav 或 m4a')
  try {
    const plan = await compileMixPlan(episodeId, episode.dramaId)
    if (plan.durationMs <= 0) throw new MixPlanError('本集还没有可用的音频片段，无法导出')
    const outputPath = path.join(mixDir(episode.dramaId), `mix-${episodeId}-${Date.now()}.${format}`)
    const result = await renderMixAudio(plan, { outputPath, format })
    return success(c, {
      url: audioLogicalUrl(episode.dramaId, outputPath),
      outputPath: result.outputPath,
      format,
      durationMs: result.durationMs,
      planHash: hashMixPlan(plan),
    })
  } catch (error: any) {
    return handleError(c, error, '混音导出失败')
  }
})

app.post('/episodes/:id/audio/separate', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = findEpisode(episodeId)
  if (!episode) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  const engine = body.engine === undefined ? undefined : String(body.engine)
  if (engine !== undefined && !SEPARATION_ENGINES.includes(engine as SeparationEngine)) {
    return badRequest(c, '分离引擎无效')
  }
  try {
    return success(c, await startEpisodeSeparation(episodeId, episode.dramaId, {
      engine: engine as SeparationEngine | undefined,
      model: body.model ? String(body.model) : undefined,
      diarization: Boolean(body.diarization),
      force: Boolean(body.force),
    }))
  } catch (error: any) {
    return handleError(c, error, '创建分离任务失败')
  }
})

app.get('/episodes/:id/audio/separate/status', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, getSeparationStatus(episodeId))
  } catch (error: any) {
    return handleError(c, error, '读取分离状态失败')
  }
})

app.post('/episodes/:id/audio/separate/cancel', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, { cancelled: cancelEpisodeSeparation(episodeId) })
  } catch (error: any) {
    return handleError(c, error, '取消分离任务失败')
  }
})

app.get('/episodes/:id/audio/assets', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, { items: listEpisodeAssets(episodeId) })
  } catch (error: any) {
    return handleError(c, error, '读取音频素材失败')
  }
})

app.delete('/episodes/:id/audio/assets/:assetId', (c) => {
  const episodeId = parseId(c.req.param('id'))
  const assetId = parseId(c.req.param('assetId'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!assetId) return badRequest(c, '素材编号无效')
  try {
    return success(c, { deleted: deleteEpisodeAsset(episodeId, assetId) })
  } catch (error: any) {
    return handleError(c, error, '删除音频素材失败')
  }
})

app.post('/episodes/:id/audio/assets/:assetId/tracks', (c) => {
  const episodeId = parseId(c.req.param('id'))
  const assetId = parseId(c.req.param('assetId'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!assetId) return badRequest(c, '素材编号无效')
  try {
    const asset = listEpisodeAssets(episodeId).find((item) => item.id === assetId)
    if (!asset) return notFound(c, '音频素材不存在')
    return success(c, autoCreateStemTracks(episodeId, [assetId]))
  } catch (error: any) {
    return handleError(c, error, '自动建轨失败')
  }
})

export default app
