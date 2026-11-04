/**
 * 台词行路由（V2 · 13.2）
 *
 * - GET  /episodes/:id/lines
 * - POST /episodes/:id/lines/extract   （重抽，保留人工锁定的行并标 stale）
 * - POST /episodes/:id/lines/synthesize（批量合成）
 * - PUT  /lines/:id、POST /lines/:id/synthesize、DELETE /lines/:id
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, notFound, success, now } from '../utils/response.js'
import { toSpeakText } from '../services/dialogue-lines.js'
import { extractEpisodeLines } from '../services/dialogue-extract.js'
import { synthesizeEpisodeLines, getDubbingState } from '../services/dubbing.js'
import { getVoice, resolveVoiceForLine } from '../services/voice-profile.js'
import { synthesize } from '../services/tts.js'
import { getAbsolutePath } from '../utils/storage.js'

const lines = new Hono()
const episodeLines = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function listEpisodeLines(episodeId: number) {
  const rows = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.episodeId, episodeId))
    .orderBy(asc(schema.storyboardLines.storyboardId), asc(schema.storyboardLines.lineNo))
    .all()
  const characters = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()?.dramaId ?? -1))
    .all()
  const nameById = new Map(characters.map((c) => [c.id, c.name]))
  return rows.map((row) => ({
    ...row,
    character_name: row.characterId ? nameById.get(row.characterId) || null : null,
    audio_url: row.audioUrl,
  }))
}

episodeLines.get('/:id/lines', (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  return success(c, { items: listEpisodeLines(episodeId) })
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
  const rows = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.episodeId, episodeId)).all()
  return success(c, {
    total: rows.length,
    ready: rows.filter((r) => r.status === 'ready').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    stale: rows.filter((r) => r.stale).length,
    needs_review: rows.filter((r) => r.needsReview).length,
    dubbing: getDubbingState(episodeId),
  })
})

lines.put('/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '台词编号无效')
  const row = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()
  if (!row) return notFound(c, '台词不存在')
  const body = await c.req.json().catch(() => ({}))

  const text = body.text !== undefined ? String(body.text) : row.text
  const speakText = body.text !== undefined ? toSpeakText(text) : row.speakText

  let nextVoiceId = row.voiceId
  if (body.voice_id !== undefined) {
    nextVoiceId = body.voice_id ? Number(body.voice_id) : null
    if (nextVoiceId !== null) {
      const voice = getVoice(nextVoiceId)
      if (!voice) return badRequest(c, '音色不存在')
      if (voice.dramaId !== row.dramaId) return badRequest(c, '音色不属于该项目')
    }
  }
  const voiceChanged = nextVoiceId !== row.voiceId
  const textChanged = body.text !== undefined

  const updated = db.update(schema.storyboardLines).set({
    ...(textChanged ? { text, speakText, subtitleText: text } : {}),
    ...(textChanged || voiceChanged ? {
      status: 'pending',
      audioUrl: null,
      audioDurationMs: null,
      audioHash: null,
    } : {}),
    ...(body.speaker_type !== undefined ? { speakerType: String(body.speaker_type) } : {}),
    ...(body.character_id !== undefined ? { characterId: body.character_id ? Number(body.character_id) : null } : {}),
    ...(body.speaker_name !== undefined ? { speakerName: String(body.speaker_name) } : {}),
    ...(body.voice_id !== undefined ? { voiceId: nextVoiceId } : {}),
    ...(body.voice_locked !== undefined ? { voiceLocked: Boolean(body.voice_locked) } : {}),
    ...(body.start_ms !== undefined ? { startMs: body.start_ms === null ? null : Number(body.start_ms) } : {}),
    ...(body.voice_start_ms !== undefined ? {
      voiceStartMs: body.voice_start_ms === null ? null : Math.max(0, Math.round(Number(body.voice_start_ms))),
    } : {}),
    ...(body.voice_duration_ms !== undefined ? {
      voiceDurationMs: body.voice_duration_ms === null ? null : Math.max(0, Math.round(Number(body.voice_duration_ms))),
    } : {}),
    ...(body.emotion !== undefined ? { emotion: body.emotion ? String(body.emotion) : null } : {}),
    ...(body.speed !== undefined ? { speed: Number(body.speed) } : {}),
    ...(body.locked !== undefined ? { locked: Boolean(body.locked) } : {}),
    ...(body.needs_review !== undefined ? { needsReview: Boolean(body.needs_review) } : {}),
    source: 'manual',
    updatedAt: now(),
  }).where(eq(schema.storyboardLines.id, id)).returning().get()

  return success(c, updated)
})

lines.post('/:id/synthesize', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '台词编号无效')
  const row = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()
  if (!row) return notFound(c, '台词不存在')
  const body = await c.req.json().catch(() => ({}))
  const voice = resolveVoiceForLine({ voiceId: body.voice_id ? Number(body.voice_id) : row.voiceId, characterId: row.characterId, dramaId: row.dramaId })
  if (!voice) return badRequest(c, '没有可用音色，请先在角色面板生成或绑定旁白音色')
  try {
    const result = await synthesize({
      text: row.speakText || row.text,
      voice: {
        externalVoiceId: voice.externalVoiceId || undefined,
        designInstruct: voice.designInstruct || undefined,
        refAudioUrl: voice.refAudioUrl || undefined,
        refText: voice.refText || undefined,
      },
      speed: row.speed ?? voice.speed ?? 1,
      emotion: row.emotion ?? voice.emotion ?? undefined,
      meta: { dramaId: row.dramaId, episodeId: row.episodeId, lineId: row.id, characterId: row.characterId ?? undefined },
    })
    const updated = db.update(schema.storyboardLines).set({
      audioUrl: result.url,
      audioDurationMs: result.durationMs,
      audioHash: result.hash,
      voiceId: voice.id,
      status: 'ready',
      error: null,
      updatedAt: now(),
    }).where(eq(schema.storyboardLines.id, id)).returning().get()
    return success(c, { ...updated, duration_ms: result.durationMs, cached: result.cached })
  } catch (error: any) {
    db.update(schema.storyboardLines).set({ status: 'failed', error: String(error?.message || error).slice(0, 500), updatedAt: now() })
      .where(eq(schema.storyboardLines.id, id)).run()
    return badRequest(c, error?.message || '合成失败')
  }
})

lines.delete('/:id', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '台词编号无效')
  const row = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).get()
  if (!row) return notFound(c, '台词不存在')
  if (row.locked) return badRequest(c, '该句已锁定，请先解锁再删除')
  // 只删数据行，音频缓存按内容寻址可被其他句复用，不清理
  db.delete(schema.storyboardLines).where(eq(schema.storyboardLines.id, id)).run()
  return success(c, { deleted: true })
})

export { episodeLines }
export default lines
