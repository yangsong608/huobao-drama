/**
 * 音色档案路由（V2 · 13.1）
 *
 * 两组挂载点：
 * - `/voices`：项目级列表、创建、旁白音色
 * - `/characters`：角色级档案、试听、克隆、激活（与设计 13.1 路径一致）
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { badRequest, created, notFound, now, success } from '../utils/response.js'
import { AUDIO_MAX_BYTES, AudioUploadError, saveAudioUpload } from '../utils/audio-upload.js'
import { getAbsolutePath } from '../utils/storage.js'
import { ffmpeg } from '../utils/ffmpeg.js'
import { synthesize, type VoiceRef } from '../services/tts.js'
import { getAudioConfig } from '../services/tts.js'
import {
  activateVoice,
  cloneVoice,
  createVoice,
  deactivateVoice,
  deleteVoice,
  getLatestVoiceForCharacter,
  getNarratorVoice,
  getVoice,
  listVoiceRows,
  listVoices,
  resolveVoiceForLine,
  setNarratorVoice,
  syncVoiceToVideoReference,
  updateVoice,
} from '../services/voice-profile.js'
import { applyVoiceProfiles, collectSampleLines, generateNarratorProfile, generateVoiceProfiles } from '../services/voice-design.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const voices = new Hono()
const characterVoices = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function toVoiceRef(voice: ReturnType<typeof getVoice>): VoiceRef {
  if (!voice) return {}
  return {
    externalVoiceId: voice.externalVoiceId || undefined,
    voicePrompt: voice.voicePrompt || undefined,
    designInstruct: voice.designInstruct || undefined,
    refAudioUrl: voice.refAudioUrl || undefined,
    refText: voice.refText || undefined,
    xVectorOnly: Boolean(voice.xVectorOnly),
  }
}

function probeAudioDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, meta) => {
      if (err) return reject(new Error('无法读取音频文件'))
      const duration = Number(meta?.format?.duration)
      if (!Number.isFinite(duration) || duration <= 0) return reject(new Error('无法读取音频时长'))
      resolve(duration)
    })
  })
}

/** 合成试听并回写档案；失败把错误落到 status/error，方便前端提示 */
async function synthesizeSample(voiceId: number, options: { text?: string; seed?: number } = {}) {
  const voice = getVoice(voiceId)
  if (!voice) throw new Error('音色不存在')

  const config = await getAudioConfig()
  if (!config) {
    updateVoice(voiceId, { status: 'pending_model' })
    const err = new Error('未配置语音服务，请先在设置中添加并启用 audio 服务')
    ;(err as Error & { code?: string }).code = 'no_audio_config'
    throw err
  }

  const text = (options.text || voice.sampleText || `我是${voice.name}，很高兴见到你。`).slice(0, 120)
  logTaskStart('Voice', 'sample', { voiceId, chars: [...text].length })
  try {
    const result = await synthesize({
      text,
      voice: toVoiceRef(voice),
      speed: voice.speed ?? 1,
      emotion: voice.emotion ?? undefined,
      language: voice.language ?? undefined,
      seed: options.seed ?? voice.seed ?? undefined,
    })
    updateVoice(voiceId, { sampleUrl: result.url, status: 'ready' })
    logTaskSuccess('Voice', 'sample', { voiceId, durationMs: result.durationMs, cached: result.cached })
    return { sample_url: result.url, duration_ms: result.durationMs, cached: result.cached }
  } catch (error: any) {
    updateVoice(voiceId, { status: 'failed', error: error?.message || String(error) } as any)
    logTaskError('Voice', 'sample', { voiceId, error: error?.message || String(error) })
    throw error
  }
}

// ---------------- 项目级 ----------------

voices.get('/', (c) => {
  const dramaId = parseId(c.req.query('drama_id'))
  if (!dramaId) return badRequest(c, 'drama_id 必填')
  return success(c, listVoices(dramaId))
})

voices.get('/narrator', (c) => {
  const dramaId = parseId(c.req.query('drama_id'))
  if (!dramaId) return badRequest(c, 'drama_id 必填')
  return success(c, getNarratorVoice(dramaId))
})

voices.post('/narrator', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dramaId = parseId(String(body.drama_id ?? ''))
  if (!dramaId) return badRequest(c, 'drama_id 必填')
  try {
    const voice = await generateNarratorProfile(dramaId, {
      force: Boolean(body.force),
      model: body.model,
      configId: body.config_id ? Number(body.config_id) : undefined,
    })
    return created(c, voice)
  } catch (error: any) {
    return badRequest(c, error?.message || '生成旁白音色失败')
  }
})

voices.put('/narrator', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dramaId = parseId(String(body.drama_id ?? ''))
  if (!dramaId) return badRequest(c, 'drama_id 必填')
  const voiceId = body.voice_id === null ? null : parseId(String(body.voice_id ?? ''))
  if (body.voice_id !== null && !voiceId) return badRequest(c, 'voice_id 无效')
  try {
    return success(c, setNarratorVoice(dramaId, voiceId))
  } catch (error: any) {
    return badRequest(c, error?.message || '绑定旁白音色失败')
  }
})

voices.post('/narrator/sample', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dramaId = parseId(String(body.drama_id ?? ''))
  if (!dramaId) return badRequest(c, 'drama_id 必填')
  let voice = getNarratorVoice(dramaId)
  if (!voice) {
    try {
      voice = await generateNarratorProfile(dramaId)
    } catch (error: any) {
      return badRequest(c, error?.message || '生成旁白音色失败')
    }
  }
  try {
    return success(c, await synthesizeSample(voice.id, { text: body.text }))
  } catch (error: any) {
    if (error?.code === 'no_audio_config') return c.json({ success: false, error: error.message }, 503)
    return badRequest(c, error?.message || '旁白试听失败')
  }
})

voices.get('/:id', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '音色编号无效')
  const voice = getVoice(id)
  if (!voice) return notFound(c, '音色不存在')
  return success(c, voice)
})

voices.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const dramaId = parseId(String(body.drama_id ?? ''))
  if (!dramaId) return badRequest(c, 'drama_id 必填')
  if (!String(body.name || '').trim()) return badRequest(c, '名称必填')
  const voice = createVoice({
    dramaId,
    characterId: body.character_id ? Number(body.character_id) : null,
    scope: body.scope === 'narrator' ? 'narrator' : 'character',
    name: String(body.name).trim(),
    source: body.source || 'design',
    voicePrompt: body.voice_prompt ?? null,
    designInstruct: body.design_instruct ?? null,
    sampleText: body.sample_text ?? null,
    externalVoiceId: body.external_voice_id ?? null,
    speed: body.speed ? Number(body.speed) : 1,
    emotion: body.emotion ?? null,
    status: 'draft',
  })
  return created(c, voice)
})

voices.put('/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '音色编号无效')
  const body = await c.req.json().catch(() => ({}))
  const updated = updateVoice(id, {
    ...(body.name !== undefined ? { name: String(body.name) } : {}),
    ...(body.voice_prompt !== undefined ? { voicePrompt: body.voice_prompt } : {}),
    ...(body.design_instruct !== undefined ? { designInstruct: body.design_instruct } : {}),
    ...(body.sample_text !== undefined ? { sampleText: body.sample_text } : {}),
    ...(body.speed !== undefined ? { speed: Number(body.speed) } : {}),
    ...(body.emotion !== undefined ? { emotion: body.emotion } : {}),
    ...(body.external_voice_id !== undefined ? { externalVoiceId: body.external_voice_id } : {}),
    ...(body.seed !== undefined ? { seed: body.seed === null ? null : Number(body.seed) } : {}),
  })
  if (!updated) return notFound(c, '音色不存在')
  return success(c, updated)
})

voices.post('/:id/clone', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '音色编号无效')
  const body = await c.req.json().catch(() => ({}))
  const scope = body.scope === 'narrator' ? 'narrator' : 'character'
  const characterId = scope === 'character' ? parseId(String(body.character_id ?? '')) : null
  if (scope === 'character' && !characterId) return badRequest(c, '目标角色必填')
  try {
    const voice = cloneVoice(id, {
      characterId,
      scope,
      activate: body.activate !== false,
      name: body.name ? String(body.name) : undefined,
    })
    return created(c, voice)
  } catch (error: any) {
    return badRequest(c, error?.message || '复制音色失败')
  }
})

voices.post('/:id/activate', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '音色编号无效')
  const voice = getVoice(id)
  if (!voice) return notFound(c, '音色不存在')
  const body = await c.req.json().catch(() => ({}))
  const characterId = parseId(String(body.character_id ?? voice.characterId ?? ''))
  if (!characterId) return badRequest(c, '该音色未绑定角色，请在角色面板激活')
  try {
    return success(c, activateVoice(characterId, id))
  } catch (error: any) {
    return badRequest(c, error?.message || '激活失败')
  }
})

voices.post('/:id/sample', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '音色编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    return success(c, await synthesizeSample(id, { text: body.text, seed: body.seed ? Number(body.seed) : undefined }))
  } catch (error: any) {
    if (error?.code === 'no_audio_config') return c.json({ success: false, error: error.message }, 503)
    return badRequest(c, error?.message || '试听合成失败')
  }
})

voices.delete('/:id', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '音色编号无效')
  if (!deleteVoice(id)) return notFound(c, '音色不存在')
  return success(c, { deleted: true })
})

// ---------------- 角色级 ----------------

characterVoices.get('/:id/voice-profile', (c) => {
  const characterId = parseId(c.req.param('id'))
  if (!characterId) return badRequest(c, '角色编号无效')
  const character = db.select().from(schema.characters)
    .where(and(eq(schema.characters.id, characterId), isNull(schema.characters.deletedAt))).get()
  if (!character) return notFound(c, '角色不存在')
  const versions = listVoiceRows(character.dramaId).filter((v) => v.characterId === characterId)
  return success(c, {
    character_id: characterId,
    character_name: character.name,
    active_voice_id: versions.find((v) => v.isActive)?.id ?? null,
    voices: versions,
  })
})

characterVoices.post('/:id/voice-profile', async (c) => {
  const characterId = parseId(c.req.param('id'))
  if (!characterId) return badRequest(c, '角色编号无效')
  const character = db.select().from(schema.characters)
    .where(and(eq(schema.characters.id, characterId), isNull(schema.characters.deletedAt))).get()
  if (!character) return notFound(c, '角色不存在')
  const body = await c.req.json().catch(() => ({}))
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, character.dramaId)).get()

  const episodeId = body.episode_id ? Number(body.episode_id) : null
  const sampleLine = episodeId ? collectSampleLines(episodeId).get(character.name) : null

  const profiles = await generateVoiceProfiles({
    characters: [{
      id: character.id,
      name: character.name,
      role: character.role,
      description: character.description,
      appearance: character.appearance,
      personality: character.personality,
      sampleLine,
    }],
    dramaId: character.dramaId,
    episodeId: episodeId ?? undefined,
    background: drama?.background,
    genre: drama?.genre,
    model: body.model,
    configId: body.config_id ? Number(body.config_id) : undefined,
  })
  const applied = applyVoiceProfiles(character.dramaId, profiles, { force: Boolean(body.force) })
  const voice = applied.voiceIds.length ? getVoice(applied.voiceIds[0]) : null
  return created(c, { profile: profiles[0], voice })
})

characterVoices.put('/:id/voice-profile', async (c) => {
  const characterId = parseId(c.req.param('id'))
  if (!characterId) return badRequest(c, '角色编号无效')
  const body = await c.req.json().catch(() => ({}))
  const voiceId = body.voice_id ? Number(body.voice_id) : null
  const target = voiceId
    ? getVoice(voiceId)
    : listVoiceRows(Number(body.drama_id || 0)).find((v) => v.characterId === characterId && v.isActive) || null
  const resolved = target || db.select().from(schema.characterVoices)
    .where(and(eq(schema.characterVoices.characterId, characterId), isNull(schema.characterVoices.deletedAt)))
    .all()
    .find((v) => v.isActive)
  if (!resolved) return notFound(c, '该角色还没有音色档案')
  const updated = updateVoice(resolved.id, {
    ...(body.name !== undefined ? { name: String(body.name) } : {}),
    ...(body.voice_prompt !== undefined ? { voicePrompt: body.voice_prompt } : {}),
    ...(body.design_instruct !== undefined ? { designInstruct: body.design_instruct } : {}),
    ...(body.sample_text !== undefined ? { sampleText: body.sample_text } : {}),
    ...(body.speed !== undefined ? { speed: Number(body.speed) } : {}),
    ...(body.emotion !== undefined ? { emotion: body.emotion } : {}),
    ...(body.external_voice_id !== undefined ? { externalVoiceId: body.external_voice_id } : {}),
  })
  return success(c, updated)
})

characterVoices.delete('/:id/voice-profile', (c) => {
  const characterId = parseId(c.req.param('id'))
  if (!characterId) return badRequest(c, '角色编号无效')
  return success(c, deactivateVoice(characterId))
})

characterVoices.post('/:id/voice-profile/activate', async (c) => {
  const characterId = parseId(c.req.param('id'))
  if (!characterId) return badRequest(c, '角色编号无效')
  const body = await c.req.json().catch(() => ({}))
  const voiceId = parseId(String(body.voice_id ?? ''))
  if (!voiceId) return badRequest(c, 'voice_id 必填')
  try {
    return success(c, activateVoice(characterId, voiceId))
  } catch (error: any) {
    return badRequest(c, error?.message || '激活失败')
  }
})

characterVoices.post('/:id/voice-sample', async (c) => {
  const characterId = parseId(c.req.param('id'))
  if (!characterId) return badRequest(c, '角色编号无效')
  const body = await c.req.json().catch(() => ({}))
  let voice = body.voice_id ? getVoice(Number(body.voice_id)) : null
  if (!voice) {
    voice = getLatestVoiceForCharacter(characterId)
  }
  if (!voice) {
    const character = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()
    voice = character ? resolveVoiceForLine({ characterId, dramaId: character.dramaId }) : null
  }
  if (!voice) return notFound(c, '该角色还没有可用的音色')
  try {
    return success(c, await synthesizeSample(voice.id, { text: body.text, seed: body.seed ? Number(body.seed) : undefined }))
  } catch (error: any) {
    if (error?.code === 'no_audio_config') return c.json({ success: false, error: error.message }, 503)
    return badRequest(c, error?.message || '试听合成失败')
  }
})

characterVoices.post('/:id/voice-clone', bodyLimit({
  maxSize: AUDIO_MAX_BYTES + 64 * 1024,
  onError: (c) => badRequest(c, '音频文件大小不能超过 20MB'),
}), async (c) => {
  const characterId = parseId(c.req.param('id'))
  if (!characterId) return badRequest(c, '角色编号无效')
  const character = db.select().from(schema.characters)
    .where(and(eq(schema.characters.id, characterId), isNull(schema.characters.deletedAt))).get()
  if (!character) return notFound(c, '角色不存在')

  try {
    const body = await c.req.parseBody()
    if (!body.consent_confirmed) return badRequest(c, '请先确认已获得该声音的授权')
    const audio = await saveAudioUpload(body.file, { dramaId: character.dramaId })
    const duration = await probeAudioDuration(getAbsolutePath(audio.path))
    if (duration < 3 || duration > 20) {
      return badRequest(c, `参考音频需 3–20 秒，当前 ${duration.toFixed(1)} 秒`)
    }
    const voice = createVoice({
      dramaId: character.dramaId,
      characterId,
      name: `${character.name} · 克隆音色`,
      source: 'clone',
      refAudioUrl: audio.path,
      refText: typeof body.ref_text === 'string' ? body.ref_text : null,
      xVectorOnly: String(body.x_vector_only || '') === 'true',
      sampleUrl: audio.path,
      consentConfirmedAt: now(),
      status: 'draft',
    })
    return created(c, voice)
  } catch (error: any) {
    if (error instanceof AudioUploadError) return badRequest(c, error.message)
    return badRequest(c, error?.message || '克隆失败')
  }
})

characterVoices.post('/:id/voice-sync', async (c) => {
  const characterId = parseId(c.req.param('id'))
  if (!characterId) return badRequest(c, '角色编号无效')
  const body = await c.req.json().catch(() => ({}))
  const voiceId = parseId(String(body.voice_id ?? ''))
  if (!voiceId) return badRequest(c, 'voice_id 必填')
  try {
    const url = await syncVoiceToVideoReference(characterId, voiceId)
    return success(c, { voice_audio_url: url })
  } catch (error: any) {
    return badRequest(c, error?.message || '同步失败')
  }
})

export { characterVoices }
export default voices
