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
import { asc, eq } from 'drizzle-orm'
import {
  MIX_BUS_KEYS,
  MixPlanError,
  compileMixPlanDetailed,
  ensureDefaultBuses,
  hashMixPlan,
  saveMixPlan,
  saveMixBuses,
  createMixRevision,
  listMixRevisions,
  restoreMixRevision,
  type MixBus,
  type MixBusKey,
  type MixClip,
  type MixPlan,
  type MixTrack,
  type MixPlanInputBus,
} from '../services/mix-plan.js'
import {
  MixSourceError,
  persistMixSource,
  type MixSourceWarning,
} from '../services/mix-source.js'
import { getAbsolutePath } from '../utils/storage.js'
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
import {
  cancelSoundscape,
  getSoundscapeStatus,
  isSoundscapeRunning,
  previewSoundscape,
  startSoundscape,
  type SoundscapeDeps,
} from '../services/soundscape.js'
import { SoundscapeError, parseSoundscapeRequest } from '../services/soundscape-compiler.js'

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

function statusError(c: Context, status: 400 | 404 | 409 | 503, message: string) {
  if (status === 404) return notFound(c, message)
  return c.json({ code: status, message }, status)
}

function handleError(c: Context, error: any, fallback: string) {
  if (error instanceof AudioEngineError) {
    return c.json({ code: 503, message: error.message, error_code: error.code }, 503)
  }
  if (error instanceof MixSourceError) {
    return c.json({ code: error.code, message: error.message }, error.status)
  }
  if (error instanceof MixPlanError || error instanceof SeparationError) {
    return statusError(c, error.status, error.message)
  }
  if (error instanceof SoundscapeError) {
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

function sourceQueryId(c: Context): number | null | undefined {
  const raw = c.req.query('source_film_id')
  if (raw === undefined || raw === '') return undefined
  return parseId(raw) ?? null
}

function planResponse(plan: any, warnings: any[]) {
  return { ...plan, source_film: plan.source ?? null, source_warnings: warnings }
}

const FALLBACK_ROLE_BUS: Record<string, MixBusKey> = {
  dialogue: 'dialogue',
  voice: 'dialogue',
  crowd: 'dialogue',
  original: 'original',
  ambience: 'original',
  sfx: 'sfx',
  bgm: 'bgm',
}

function fallbackClipSource(raw: string | null | undefined): { url: string | null; usable: boolean; reason: string | null } {
  const url = String(raw || '').trim()
  if (!url) return { url: null, usable: false, reason: '缺少音频素材' }
  if (/^https?:\/\//i.test(url)) return { url, usable: true, reason: null }
  try {
    if (!fs.existsSync(getAbsolutePath(url))) return { url, usable: false, reason: '音频文件不存在' }
  } catch {
    return { url, usable: false, reason: '音频路径无效' }
  }
  return { url, usable: true, reason: null }
}

/**
 * 本集没有任何可用成片时的降级编译：保留总线、音轨片段与虚拟对白轨，无原声床。
 * 源成片是混音的主输入，但空集也要能打开混音台并校验试听范围，因此这里在路由层兜底。
 */
async function compilePlanWithoutSource(episodeId: number, dramaId: number): Promise<MixPlan> {
  const buses: MixBus[] = ensureDefaultBuses(episodeId)
    .map((row) => (MIX_BUS_KEYS as readonly string[]).includes(row.key)
      ? {
        id: row.id,
        key: row.key as MixBusKey,
        name: row.name,
        volume: row.volume ?? 1,
        muted: Boolean(row.muted),
        solo: Boolean(row.solo),
        effectiveMuted: false,
        ducking: Boolean(row.ducking),
        duckRatio: row.duckRatio ?? 6,
        duckAttackMs: row.duckAttackMs ?? 20,
        duckReleaseMs: row.duckReleaseMs ?? 250,
        lufsTarget: row.lufsTarget ?? null,
        limiterCeiling: row.limiterCeiling ?? null,
      }
      : null)
    .filter((bus): bus is MixBus => bus !== null)
  const busByKey = new Map<MixBusKey, MixBus>(buses.map((bus) => [bus.key, bus]))

  const trackRows = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episodeId))
    .orderBy(asc(schema.episodeAudioTracks.sortOrder), asc(schema.episodeAudioTracks.id))
    .all()
  const clipRows = db.select().from(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.episodeId, episodeId))
    .orderBy(asc(schema.episodeAudioClips.startMs), asc(schema.episodeAudioClips.id))
    .all()
  const tracks: MixTrack[] = trackRows.map((row) => {
    const role = String(row.role || '').trim() || row.kind || 'custom'
    const explicitBus = row.busId
      ? buses.find((bus) => bus.id === row.busId)?.key
      : undefined
    return {
      id: row.id,
      role,
      name: row.name,
      busId: explicitBus ?? FALLBACK_ROLE_BUS[role] ?? 'sfx',
      virtual: false,
      volume: row.volume ?? 1,
      pan: row.pan ?? 0,
      muted: Boolean(row.muted),
      solo: Boolean(row.solo),
      effectiveMuted: false,
      ducking: Boolean(row.ducking),
      locked: Boolean(row.locked),
      hidden: Boolean(row.hidden),
      loop: Boolean(row.loop),
      color: row.color ?? null,
      height: row.height ?? 72,
      sortOrder: row.sortOrder ?? 0,
      origin: row.origin ?? null,
      stemAssetId: row.stemAssetId ?? null,
      clips: clipRows.filter((clip) => clip.trackId === row.id).map((clip) => {
        const src = fallbackClipSource(clip.audioUrl || clip.sourceUrl)
        return {
          id: clip.id,
          assetId: clip.assetId ?? null,
          takeId: clip.takeId ?? null,
          lineId: clip.lineId ?? null,
          name: clip.name ?? null,
          startMs: clip.startMs,
          endMs: clip.endMs,
          sourceStartMs: clip.sourceStartMs ?? 0,
          gainDb: clip.gainDb ?? 0,
          pan: clip.pan ?? 0,
          fadeInMs: clip.fadeInMs ?? 0,
          fadeOutMs: clip.fadeOutMs ?? 0,
          fadeCurve: clip.fadeCurve || 'linear',
          loop: Boolean(clip.loop),
          muted: Boolean(clip.muted),
          locked: Boolean(clip.locked),
          audioUrl: src.url,
          usable: src.usable,
          reason: src.reason,
        }
      }),
    }
  })

  // 动态加载：dubbing 依赖 export-service，静态引用会形成循环
  const { previewTimeline: readTimeline } = await import('../services/dubbing.js')
  const timeline = await readTimeline(episodeId, dramaId)
  const takes = db.select().from(schema.lineTakes)
    .where(eq(schema.lineTakes.episodeId, episodeId))
    .orderBy(asc(schema.lineTakes.takeNo))
    .all()
  const activeByLine = new Map<number, (typeof takes)[number]>()
  for (const take of takes) {
    if (!take.isActive || take.deletedAt) continue
    activeByLine.set(take.lineId, take)
  }
  const dialogueClips: MixClip[] = []
  for (const cue of timeline.cues) {
    const take = activeByLine.get(cue.lineId)
    const src = fallbackClipSource(take?.audioUrl || cue.audioUrl)
    if (!src.url) continue
    dialogueClips.push({
      id: null,
      assetId: null,
      takeId: take?.id ?? null,
      lineId: cue.lineId,
      name: null,
      startMs: cue.startMs,
      endMs: cue.endMs,
      sourceStartMs: 0,
      gainDb: 0,
      pan: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      fadeCurve: 'linear',
      loop: false,
      muted: false,
      locked: false,
      audioUrl: src.url,
      usable: src.usable,
      reason: src.reason,
    })
  }
  tracks.unshift({
    id: null,
    role: 'voice',
    name: '对白',
    busId: 'dialogue',
    virtual: true,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    effectiveMuted: false,
    ducking: false,
    locked: false,
    hidden: false,
    loop: false,
    color: '#f59e0b',
    height: 72,
    sortOrder: -1,
    origin: null,
    stemAssetId: null,
    clips: dialogueClips,
  })

  const soloActive = tracks.some((track) => track.solo)
    || buses.some((bus) => bus.key !== 'master' && bus.solo)
  const soloedBusKeys = new Set<MixBusKey>()
  for (const track of tracks) {
    const bus = busByKey.get(track.busId)!
    if (!soloActive) {
      track.effectiveMuted = track.muted || bus.muted
      continue
    }
    if (track.solo) {
      track.effectiveMuted = false
      if (bus.key !== 'master') soloedBusKeys.add(bus.key)
      continue
    }
    track.effectiveMuted = bus.solo ? track.muted : true
  }
  for (const bus of buses) {
    bus.effectiveMuted = bus.key === 'master'
      ? bus.muted
      : soloActive ? !(bus.solo || soloedBusKeys.has(bus.key)) : bus.muted
  }

  const clipEnd = tracks.reduce(
    (max, track) => track.clips.reduce((inner, clip) => Math.max(inner, clip.endMs), max),
    0,
  )
  const master = busByKey.get('master')!
  return {
    version: 1,
    episodeId,
    durationMs: Math.max(0, timeline.totalDurationMs, clipEnd),
    sampleRate: 48000,
    buses,
    tracks,
    master: {
      lufs: master.lufsTarget ?? -16,
      truePeak: master.limiterCeiling ?? -1.5,
      limiter: 'alimiter',
    },
  }
}

/** 统一编译入口：源成片缺失（集内无任何可用成片）时降级为无源计划，其余错误原样抛出 */
async function compileEpisodePlan(
  episodeId: number,
  dramaId: number,
  sourceFilmId?: number | null,
): Promise<{ plan: MixPlan; warnings: MixSourceWarning[] }> {
  try {
    return await compileMixPlanDetailed(episodeId, dramaId, { sourceFilmId })
  } catch (error) {
    if (error instanceof MixSourceError && error.status === 400 && error.code === 'MIX_SOURCE_MISSING') {
      return {
        plan: await compilePlanWithoutSource(episodeId, dramaId),
        warnings: [{ code: 'MIX_SOURCE_FALLBACK', message: '本集还没有可用成片，可先添加配音与音效。' }],
      }
    }
    throw error
  }
}

app.get('/episodes/:id/mix', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = findEpisode(episodeId)
  if (!episode) return notFound(c, '集不存在')
  const sourceFilmId = sourceQueryId(c)
  if (sourceFilmId === null) return badRequest(c, '源成片编号无效')
  try {
    const { plan, warnings } = await compileEpisodePlan(episodeId, episode.dramaId, sourceFilmId)
    return success(c, planResponse(plan, warnings))
  } catch (error: any) {
    return handleError(c, error, '读取混音计划失败')
  }
})

app.put('/episodes/:id/mix/source', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = findEpisode(episodeId)
  if (!episode) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  const filmId = parseId(String(body.film_id ?? ''))
  if (!filmId) return badRequest(c, '缺少源成片')
  try {
    await persistMixSource(episodeId, filmId)
    const { plan, warnings } = await compileMixPlanDetailed(episodeId, episode.dramaId)
    return success(c, planResponse(plan, warnings))
  } catch (error: any) {
    return handleError(c, error, '切换源成片失败')
  }
})

app.put('/episodes/:id/mix', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = findEpisode(episodeId)
  if (!episode) return notFound(c, '集不存在')
  if (isSoundscapeRunning(episodeId)) {
    return statusError(c, 409, '声音生成中，暂不能保存混音')
  }
  const body = await c.req.json().catch(() => ({}))
  try {
    let plan: MixPlan
    try {
      plan = await saveMixPlan(episodeId, episode.dramaId, {
        buses: Array.isArray(body.buses) ? body.buses.map(busInput) : undefined,
        tracks: Array.isArray(body.tracks) ? body.tracks : undefined,
        clips: Array.isArray(body.clips) ? body.clips : undefined,
        virtualTracks: Array.isArray(body.virtualTracks) ? body.virtualTracks : undefined,
      })
    } catch (error) {
      // 保存已落库后才会编译返回值；集内无任何可用成片时降级为无源计划
      if (error instanceof MixSourceError && error.status === 400 && error.code === 'MIX_SOURCE_MISSING') {
        plan = await compilePlanWithoutSource(episodeId, episode.dramaId)
      } else {
        throw error
      }
    }
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
    const { plan } = await compileEpisodePlan(episodeId, episode.dramaId)
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
    const { plan } = await compileEpisodePlan(episodeId, episode.dramaId)
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

export function createSoundscapeRoutes(deps: SoundscapeDeps = {}) {
  const routes = new Hono()

  routes.post('/episodes/:id/audio/soundscape/preview', async (c) => {
    const episodeId = parseId(c.req.param('id'))
    if (!episodeId) return badRequest(c, '集编号无效')
    const episode = findEpisode(episodeId)
    if (!episode) return notFound(c, '集不存在')
    const body = await c.req.json().catch(() => ({}))
    try {
      const request = parseSoundscapeRequest(body)
      const result = await previewSoundscape(episodeId, episode.dramaId, request, deps)
      return success(c, {
        mode: result.plan.mode,
        items: result.plan.items,
        warnings: result.plan.warnings,
        counts: result.plan.counts,
        estimatedSeconds: result.plan.estimatedSeconds,
        degraded: result.plan.degraded,
        model: result.model,
        workflowHash: result.workflowHash,
        normalizeLoudness: result.normalizeLoudness,
      })
    } catch (error: any) {
      return handleError(c, error, '预览声音生成失败')
    }
  })

  routes.post('/episodes/:id/audio/soundscape', async (c) => {
    const episodeId = parseId(c.req.param('id'))
    if (!episodeId) return badRequest(c, '集编号无效')
    const episode = findEpisode(episodeId)
    if (!episode) return notFound(c, '集不存在')
    const body = await c.req.json().catch(() => ({}))
    try {
      const request = parseSoundscapeRequest(body)
      const started = await startSoundscape(episodeId, episode.dramaId, request, deps)
      return success(c, started)
    } catch (error: any) {
      return handleError(c, error, '启动声音生成失败')
    }
  })

  routes.get('/episodes/:id/audio/soundscape/status', (c) => {
    const episodeId = parseId(c.req.param('id'))
    if (!episodeId) return badRequest(c, '集编号无效')
    try {
      return success(c, getSoundscapeStatus(episodeId))
    } catch (error: any) {
      return handleError(c, error, '读取声音生成状态失败')
    }
  })

  routes.post('/episodes/:id/audio/soundscape/cancel', (c) => {
    const episodeId = parseId(c.req.param('id'))
    if (!episodeId) return badRequest(c, '集编号无效')
    try {
      if (!cancelSoundscape(episodeId)) {
        return statusError(c, 409, '当前没有运行中的声音生成任务')
      }
      return success(c, { status: 'cancelled' })
    } catch (error: any) {
      return handleError(c, error, '取消声音生成失败')
    }
  })

  return routes
}

app.route('/', createSoundscapeRoutes())

export default app
