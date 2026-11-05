/**
 * 整集附加音轨路由（V3 · 多轨混音）
 *
 * - GET    /episodes/:id/audio/tracks
 * - POST   /episodes/:id/audio/tracks
 * - PUT    /episodes/:id/audio/tracks/:trackId
 * - DELETE /episodes/:id/audio/tracks/:trackId
 * - POST   /episodes/:id/audio/tracks/:trackId/clips
 * - PUT    /episodes/:id/audio/clips/:clipId
 * - DELETE /episodes/:id/audio/clips/:clipId
 * - POST   /episodes/:id/audio/voice-clips
 * - POST   /episodes/:id/audio/preview
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, notFound, success } from '../utils/response.js'
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import {
  AudioTrackError,
  collectMixTracks,
  createAudioClip,
  createAudioTrack,
  createVoiceClip,
  deleteAudioClip,
  deleteAudioTrack,
  listAudioTracks,
  updateAudioClip,
  updateAudioTrack,
} from '../services/audio-tracks.js'
import { renderRangePreview } from '../services/dubbing.js'

const app = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function findEpisode(episodeId: number) {
  return db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get() ?? null
}

function handleError(c: Context, error: any, fallback: string) {
  if (error instanceof AudioTrackError) {
    return error.status === 404 ? notFound(c, error.message) : badRequest(c, error.message)
  }
  return badRequest(c, error?.message || fallback)
}

app.get('/episodes/:id/audio/tracks', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = findEpisode(episodeId)
  if (!episode) return notFound(c, '集不存在')
  return success(c, { items: listAudioTracks(episodeId) })
})

app.post('/episodes/:id/audio/tracks', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!findEpisode(episodeId)) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, createAudioTrack(episodeId, {
      kind: body.kind,
      role: body.role,
      name: body.name,
      volume: body.volume,
      pan: body.pan,
      busId: body.bus_id ?? body.busId,
      muted: body.muted,
      solo: body.solo,
      ducking: body.ducking,
      loop: body.loop,
      locked: body.locked,
      hidden: body.hidden,
      color: body.color,
      height: body.height,
      stemAssetId: body.stem_asset_id ?? body.stemAssetId,
      duckAttackMs: body.duck_attack_ms ?? body.duckAttackMs,
      duckReleaseMs: body.duck_release_ms ?? body.duckReleaseMs,
      sortOrder: body.sort_order ?? body.sortOrder,
    }))
  } catch (error: any) {
    return handleError(c, error, '新建音轨失败')
  }
})

app.put('/episodes/:id/audio/tracks/:trackId', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  const trackId = parseId(c.req.param('trackId'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!trackId) return badRequest(c, '音轨编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, updateAudioTrack(episodeId, trackId, {
      kind: body.kind,
      role: body.role,
      name: body.name,
      volume: body.volume,
      pan: body.pan,
      busId: body.bus_id ?? body.busId,
      muted: body.muted,
      solo: body.solo,
      ducking: body.ducking,
      loop: body.loop,
      locked: body.locked,
      hidden: body.hidden,
      color: body.color,
      height: body.height,
      stemAssetId: body.stem_asset_id ?? body.stemAssetId,
      duckAttackMs: body.duck_attack_ms ?? body.duckAttackMs,
      duckReleaseMs: body.duck_release_ms ?? body.duckReleaseMs,
      sortOrder: body.sort_order ?? body.sortOrder,
    }))
  } catch (error: any) {
    return handleError(c, error, '更新音轨失败')
  }
})

app.delete('/episodes/:id/audio/tracks/:trackId', (c) => {
  const episodeId = parseId(c.req.param('id'))
  const trackId = parseId(c.req.param('trackId'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!trackId) return badRequest(c, '音轨编号无效')
  try {
    return success(c, { deleted: deleteAudioTrack(episodeId, trackId) })
  } catch (error: any) {
    return handleError(c, error, '删除音轨失败')
  }
})

app.post('/episodes/:id/audio/tracks/:trackId/clips', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  const trackId = parseId(c.req.param('trackId'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!trackId) return badRequest(c, '音轨编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, createAudioClip(episodeId, trackId, {
      startMs: body.start_ms ?? body.startMs,
      endMs: body.end_ms ?? body.endMs,
      sourceStartMs: body.source_start_ms ?? body.sourceStartMs,
      assetId: body.asset_id ?? body.assetId,
      gainDb: body.gain_db ?? body.gainDb,
      pan: body.pan,
      fadeInMs: body.fade_in_ms ?? body.fadeInMs,
      fadeOutMs: body.fade_out_ms ?? body.fadeOutMs,
      fadeCurve: body.fade_curve ?? body.fadeCurve,
      locked: body.locked,
      muted: body.muted,
      name: body.name,
      color: body.color,
      sourceUrl: body.source_url ?? body.sourceUrl,
      audioUrl: body.audio_url ?? body.audioUrl,
      text: body.text,
      voiceId: body.voice_id ?? body.voiceId,
      takeId: body.take_id ?? body.takeId,
      followTake: body.follow_take ?? body.followTake,
      loop: body.loop,
      lineId: body.line_id ?? body.lineId,
    }))
  } catch (error: any) {
    return handleError(c, error, '新建音频片段失败')
  }
})

app.put('/episodes/:id/audio/clips/:clipId', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  const clipId = parseId(c.req.param('clipId'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!clipId) return badRequest(c, '片段编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, updateAudioClip(episodeId, clipId, {
      startMs: body.start_ms ?? body.startMs,
      endMs: body.end_ms ?? body.endMs,
      sourceStartMs: body.source_start_ms ?? body.sourceStartMs,
      assetId: body.asset_id ?? body.assetId,
      gainDb: body.gain_db ?? body.gainDb,
      pan: body.pan,
      fadeInMs: body.fade_in_ms ?? body.fadeInMs,
      fadeOutMs: body.fade_out_ms ?? body.fadeOutMs,
      fadeCurve: body.fade_curve ?? body.fadeCurve,
      locked: body.locked,
      muted: body.muted,
      name: body.name,
      color: body.color,
      sourceUrl: body.source_url ?? body.sourceUrl,
      audioUrl: body.audio_url ?? body.audioUrl,
      text: body.text,
      voiceId: body.voice_id ?? body.voiceId,
      takeId: body.take_id ?? body.takeId,
      followTake: body.follow_take ?? body.followTake,
      loop: body.loop,
      lineId: body.line_id ?? body.lineId,
    }))
  } catch (error: any) {
    return handleError(c, error, '更新音频片段失败')
  }
})

app.delete('/episodes/:id/audio/clips/:clipId', (c) => {
  const episodeId = parseId(c.req.param('id'))
  const clipId = parseId(c.req.param('clipId'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!clipId) return badRequest(c, '片段编号无效')
  try {
    return success(c, { deleted: deleteAudioClip(episodeId, clipId) })
  } catch (error: any) {
    return handleError(c, error, '删除音频片段失败')
  }
})

app.post('/episodes/:id/audio/voice-clips', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!findEpisode(episodeId)) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, await createVoiceClip(episodeId, {
      text: body.text,
      voiceId: body.voice_id ?? body.voiceId,
      characterId: body.character_id ?? body.characterId,
      startMs: body.start_ms ?? body.startMs,
      durationMs: body.duration_ms ?? body.durationMs,
      trackId: body.track_id ?? body.trackId,
      lineId: body.line_id ?? body.lineId,
    }))
  } catch (error: any) {
    return handleError(c, error, '生成语音片段失败')
  }
})

app.post('/episodes/:id/audio/preview', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  const episode = findEpisode(episodeId)
  if (!episode) return notFound(c, '集不存在')
  const body = await c.req.json().catch(() => ({}))
  try {
    const result = await renderRangePreview(episodeId, episode.dramaId, {
      startMs: body.start_ms ?? body.startMs,
      endMs: body.end_ms ?? body.endMs,
      bgmUrl: body.bgm_url ?? body.bgmUrl ?? null,
      bgmVolume: body.bgm_volume ?? body.bgmVolume,
      originalAudio: ['keep', 'duck', 'mute'].includes(body.original_audio) ? body.original_audio : undefined,
      targetLufs: body.target_lufs ?? body.targetLufs,
      duckingRatio: body.ducking_ratio ?? body.duckingRatio,
    })
    return success(c, result)
  } catch (error: any) {
    return badRequest(c, error?.message || '生成试听失败')
  }
})

/** 调试/自动化：当前音轨汇总签名 */
app.get('/episodes/:id/audio/summary', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  if (!findEpisode(episodeId)) return notFound(c, '集不存在')
  const collected = collectMixTracks(episodeId)
  return success(c, {
    count: collected.count,
    solo_active: collected.soloActive,
    signature: collected.signature,
    tracks: collected.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      name: track.name,
      volume: track.volume,
      muted: Boolean(track.muted),
      clips: track.clips.length,
    })),
  })
})

export default app
