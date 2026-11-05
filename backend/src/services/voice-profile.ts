/**
 * 音色档案（V2 · 5）
 *
 * - 音色是项目资产，跨集复用；`character_voices` 为唯一事实来源；
 * - `scope='narrator'` 与角色音色同表，旁白用 `dramas.narrator_voice_id` 指向激活项；
 * - 同一角色最多一条 `is_active=1`，切换在事务内完成；
 * - V1 的 `characters.voice_audio_url` 启动时迁移为 `source='upload'`，避免用户重传。
 */
import fs from 'fs'
import path from 'path'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { getAbsolutePath } from '../utils/storage.js'
import { ffmpeg } from '../utils/ffmpeg.js'

export type VoiceSource = 'design' | 'clone' | 'upload' | 'preset'
export type VoiceStatus = 'draft' | 'pending_model' | 'generating' | 'ready' | 'failed'

export interface VoiceInput {
  dramaId: number
  characterId?: number | null
  scope?: 'character' | 'narrator'
  name: string
  source?: VoiceSource
  provider?: string | null
  model?: string | null
  externalVoiceId?: string | null
  voicePrompt?: string | null
  voicePromptSource?: string | null
  designInstruct?: string | null
  refAudioUrl?: string | null
  refText?: string | null
  xVectorOnly?: boolean
  sampleUrl?: string | null
  sampleText?: string | null
  gender?: string | null
  ageRange?: string | null
  pitch?: string | null
  speed?: number | null
  emotion?: string | null
  language?: string | null
  seed?: number | null
  consentConfirmedAt?: string | null
  status?: VoiceStatus
}

export type VoiceRow = typeof schema.characterVoices.$inferSelect

/** 查询项目下全部未删除音色 */
export function listVoiceRows(dramaId: number): VoiceRow[] {
  return db.select().from(schema.characterVoices)
    .where(and(eq(schema.characterVoices.dramaId, dramaId), isNull(schema.characterVoices.deletedAt)))
    .all()
}

/** 角色音色 + 旁白，按角色分组，供详情页与面板使用 */
export function listVoices(dramaId: number) {
  const rows = listVoiceRows(dramaId)
  const characters = db.select().from(schema.characters)
    .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
    .all()

  const byCharacter = characters.map((character) => {
    const versions = rows.filter((v) => v.characterId === character.id)
    return {
      character_id: character.id,
      character_name: character.name,
      active_voice_id: versions.find((v) => v.isActive)?.id ?? null,
      voices: versions,
    }
  })
  return {
    characters: byCharacter,
    narrator: rows.filter((v) => v.scope === 'narrator'),
  }
}

export function getVoice(id: number): VoiceRow | null {
  const row = db.select().from(schema.characterVoices).where(eq(schema.characterVoices.id, id)).get()
  return row && !row.deletedAt ? row : null
}

export function createVoice(input: VoiceInput): VoiceRow {
  const ts = now()
  const values = {
    dramaId: input.dramaId,
    characterId: input.characterId ?? null,
    scope: input.scope ?? 'character',
    name: input.name,
    source: input.source ?? 'design',
    provider: input.provider ?? null,
    model: input.model ?? null,
    externalVoiceId: input.externalVoiceId ?? null,
    voicePrompt: input.voicePrompt ?? null,
    voicePromptSource: input.voicePromptSource ?? 'llm',
    designInstruct: input.designInstruct ?? null,
    refAudioUrl: input.refAudioUrl ?? null,
    refText: input.refText ?? null,
    xVectorOnly: Boolean(input.xVectorOnly),
    sampleUrl: input.sampleUrl ?? null,
    sampleText: input.sampleText ?? null,
    gender: input.gender ?? null,
    ageRange: input.ageRange ?? null,
    pitch: input.pitch ?? null,
    speed: input.speed ?? 1,
    emotion: input.emotion ?? null,
    language: input.language ?? 'Chinese',
    seed: input.seed ?? null,
    consentConfirmedAt: input.consentConfirmedAt ?? null,
    status: input.status ?? 'draft',
    isActive: false,
    createdAt: ts,
    updatedAt: ts,
  }
  const res = db.insert(schema.characterVoices).values(values).run()
  return getVoice(getInsertId(res))!
}

export function updateVoice(id: number, patch: Partial<VoiceInput> & { status?: VoiceStatus }): VoiceRow | null {
  const existing = getVoice(id)
  if (!existing) return null
  db.update(schema.characterVoices)
    .set({
      ...('name' in patch ? { name: patch.name! } : {}),
      ...('voicePrompt' in patch ? { voicePrompt: patch.voicePrompt ?? null } : {}),
      ...('designInstruct' in patch ? { designInstruct: patch.designInstruct ?? null } : {}),
      ...('refAudioUrl' in patch ? { refAudioUrl: patch.refAudioUrl ?? null } : {}),
      ...('refText' in patch ? { refText: patch.refText ?? null } : {}),
      ...('sampleUrl' in patch ? { sampleUrl: patch.sampleUrl ?? null } : {}),
      ...('sampleText' in patch ? { sampleText: patch.sampleText ?? null } : {}),
      ...('speed' in patch ? { speed: patch.speed ?? 1 } : {}),
      ...('emotion' in patch ? { emotion: patch.emotion ?? null } : {}),
      ...('gender' in patch ? { gender: patch.gender ?? null } : {}),
      ...('ageRange' in patch ? { ageRange: patch.ageRange ?? null } : {}),
      ...('pitch' in patch ? { pitch: patch.pitch ?? null } : {}),
      ...('language' in patch ? { language: patch.language ?? null } : {}),
      ...('voicePromptSource' in patch ? { voicePromptSource: patch.voicePromptSource ?? null } : {}),
      ...('externalVoiceId' in patch ? { externalVoiceId: patch.externalVoiceId ?? null } : {}),
      ...('source' in patch && patch.source ? { source: patch.source } : {}),
      ...('status' in patch && patch.status ? { status: patch.status } : {}),
      ...('error' in patch ? { error: (patch as { error?: string | null }).error ?? null } : {}),
      ...('seed' in patch ? { seed: patch.seed ?? null } : {}),
      updatedAt: now(),
    })
    .where(eq(schema.characterVoices.id, id))
    .run()
  return getVoice(id)
}

/** 激活角色音色：同角色其余版本置 0，并同步 characters 的只读缓存 */
export function activateVoice(characterId: number, voiceId: number): { active_voice_id: number } {
  const voice = getVoice(voiceId)
  if (!voice) throw new Error('音色不存在')
  if (voice.characterId !== characterId) throw new Error('音色不属于该角色')

  db.transaction((tx) => {
    tx.update(schema.characterVoices)
      .set({ isActive: false, updatedAt: now() })
      .where(and(eq(schema.characterVoices.characterId, characterId), eq(schema.characterVoices.dramaId, voice.dramaId)))
      .run()
    tx.update(schema.characterVoices)
      .set({ isActive: true, updatedAt: now() })
      .where(eq(schema.characterVoices.id, voiceId))
      .run()
    tx.update(schema.characters)
      .set({
        voicePrompt: voice.voicePrompt ?? null,
        voiceStatus: voice.status ?? 'ready',
        updatedAt: now(),
      })
      .where(eq(schema.characters.id, characterId))
      .run()
    tx.update(schema.storyboardLines)
      .set({
        voiceId: null,
        audioStale: sql`case when ${schema.storyboardLines.audioUrl} is not null then 1 else 0 end`,
        error: null,
        updatedAt: now(),
      })
      .where(and(
        eq(schema.storyboardLines.characterId, characterId),
        eq(schema.storyboardLines.dramaId, voice.dramaId),
        or(eq(schema.storyboardLines.voiceLocked, false), isNull(schema.storyboardLines.voiceLocked)),
      ))
      .run()
  })
  return { active_voice_id: voiceId }
}

/** 解除激活：characters 缓存清空，已有台词回退到旁白音色（合成时解析） */
export function deactivateVoice(characterId: number): { active_voice_id: null } {
  db.transaction((tx) => {
    tx.update(schema.characterVoices)
      .set({ isActive: false, updatedAt: now() })
      .where(eq(schema.characterVoices.characterId, characterId))
      .run()
    tx.update(schema.characters)
      .set({ voicePrompt: null, voiceStatus: null, updatedAt: now() })
      .where(eq(schema.characters.id, characterId))
      .run()
    tx.update(schema.storyboardLines)
      .set({
        voiceId: null,
        audioStale: sql`case when ${schema.storyboardLines.audioUrl} is not null then 1 else 0 end`,
        error: null,
        updatedAt: now(),
      })
      .where(and(
        eq(schema.storyboardLines.characterId, characterId),
        or(eq(schema.storyboardLines.voiceLocked, false), isNull(schema.storyboardLines.voiceLocked)),
      ))
      .run()
  })
  return { active_voice_id: null }
}

/** 软删音色；若删的是激活项，同时清 characters 缓存 */
export function deleteVoice(id: number): boolean {
  const voice = getVoice(id)
  if (!voice) return false
  db.transaction((tx) => {
    tx.update(schema.characterVoices)
      .set({ deletedAt: now(), isActive: false, updatedAt: now() })
      .where(eq(schema.characterVoices.id, id))
      .run()
    if (voice.isActive && voice.characterId) {
      tx.update(schema.characters)
        .set({ voicePrompt: null, voiceStatus: null, updatedAt: now() })
        .where(eq(schema.characters.id, voice.characterId))
        .run()
    }
    if (voice.scope === 'narrator') {
      tx.update(schema.dramas)
        .set({ narratorVoiceId: null, updatedAt: now() })
        .where(eq(schema.dramas.id, voice.dramaId))
        .run()
    }
  })
  return true
}

/**
 * 项目级复用：复制音色字段到目标角色/旁白，生成独立新版本。
 * 只读源音色，不改变源版本与激活状态；目标默认激活。
 */
export function cloneVoice(
  sourceVoiceId: number,
  target: { characterId?: number | null; scope?: 'character' | 'narrator'; activate?: boolean; name?: string },
): VoiceRow {
  const source = getVoice(sourceVoiceId)
  if (!source) throw new Error('音色不存在')

  const scope: 'character' | 'narrator' = target.scope === 'narrator' ? 'narrator' : 'character'
  let character: typeof schema.characters.$inferSelect | null = null
  if (scope === 'character') {
    const characterId = Number(target.characterId)
    if (!Number.isSafeInteger(characterId) || characterId <= 0) throw new Error('目标角色必填')
    character = db.select().from(schema.characters)
      .where(and(eq(schema.characters.id, characterId), isNull(schema.characters.deletedAt))).get() ?? null
    if (!character) throw new Error('目标角色不存在')
    if (character.dramaId !== source.dramaId) throw new Error('目标角色不属于同一项目')
  }

  const targetName = scope === 'narrator' ? '旁白' : character!.name
  const copied = createVoice({
    dramaId: source.dramaId,
    characterId: scope === 'narrator' ? null : character!.id,
    scope,
    name: (target.name || '').trim() || `${targetName} · 复用 ${source.name}`,
    source: source.source as VoiceSource,
    provider: source.provider,
    model: source.model,
    externalVoiceId: source.externalVoiceId,
    voicePrompt: source.voicePrompt,
    voicePromptSource: source.voicePromptSource,
    designInstruct: source.designInstruct,
    refAudioUrl: source.refAudioUrl,
    refText: source.refText,
    xVectorOnly: source.xVectorOnly ?? undefined,
    sampleUrl: source.sampleUrl,
    sampleText: source.sampleText,
    gender: source.gender,
    ageRange: source.ageRange,
    pitch: source.pitch,
    speed: source.speed,
    emotion: source.emotion,
    language: source.language,
    seed: source.seed,
    consentConfirmedAt: source.consentConfirmedAt,
    status: source.status as VoiceStatus,
  })

  if (target.activate !== false) {
    if (scope === 'narrator') setNarratorVoice(source.dramaId, copied.id)
    else activateVoice(character!.id, copied.id)
  }
  return getVoice(copied.id)!
}

/** 角色最新一条音色（无激活时用于试听兜底） */
export function getLatestVoiceForCharacter(characterId: number): VoiceRow | null {
  const rows = db.select().from(schema.characterVoices)
    .where(and(eq(schema.characterVoices.characterId, characterId), isNull(schema.characterVoices.deletedAt)))
    .all()
    .sort((a, b) => (b.id || 0) - (a.id || 0))
  return rows.find((v) => v.isActive) || rows[0] || null
}

export function getNarratorVoice(dramaId: number): VoiceRow | null {
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  if (drama?.narratorVoiceId) {
    const bound = getVoice(drama.narratorVoiceId)
    if (bound) return bound
  }
  // 兼容：项目还没显式绑定，但有已激活/最新的旁白音色
  const rows = db.select().from(schema.characterVoices)
    .where(and(
      eq(schema.characterVoices.dramaId, dramaId),
      eq(schema.characterVoices.scope, 'narrator'),
      isNull(schema.characterVoices.deletedAt),
    ))
    .all()
    .sort((a, b) => (b.id || 0) - (a.id || 0))
  return rows.find((v) => v.isActive) || rows[0] || null
}

export function setNarratorVoice(dramaId: number, voiceId: number | null): VoiceRow | null {
  if (voiceId === null) {
    db.transaction((tx) => {
      tx.update(schema.dramas).set({ narratorVoiceId: null, updatedAt: now() }).where(eq(schema.dramas.id, dramaId)).run()
      tx.update(schema.storyboardLines)
        .set({
          voiceId: null,
          audioStale: sql`case when ${schema.storyboardLines.audioUrl} is not null then 1 else 0 end`,
          error: null,
          updatedAt: now(),
        })
        .where(and(
          eq(schema.storyboardLines.dramaId, dramaId),
          isNull(schema.storyboardLines.characterId),
          or(eq(schema.storyboardLines.voiceLocked, false), isNull(schema.storyboardLines.voiceLocked)),
        ))
        .run()
    })
    return null
  }
  const voice = getVoice(voiceId)
  if (!voice) throw new Error('音色不存在')
  if (voice.dramaId !== dramaId) throw new Error('音色不属于该项目')
  if (voice.scope !== 'narrator') throw new Error('该音色不是旁白音色')
  db.transaction((tx) => {
    tx.update(schema.characterVoices)
      .set({ isActive: false, updatedAt: now() })
      .where(and(eq(schema.characterVoices.dramaId, dramaId), eq(schema.characterVoices.scope, 'narrator')))
      .run()
    tx.update(schema.characterVoices)
      .set({ isActive: true, updatedAt: now() })
      .where(eq(schema.characterVoices.id, voiceId))
      .run()
    tx.update(schema.dramas)
      .set({ narratorVoiceId: voiceId, updatedAt: now() })
      .where(eq(schema.dramas.id, dramaId))
      .run()
    tx.update(schema.storyboardLines)
      .set({
        voiceId: null,
        audioStale: sql`case when ${schema.storyboardLines.audioUrl} is not null then 1 else 0 end`,
        error: null,
        updatedAt: now(),
      })
      .where(and(
        eq(schema.storyboardLines.dramaId, dramaId),
        isNull(schema.storyboardLines.characterId),
        or(eq(schema.storyboardLines.voiceLocked, false), isNull(schema.storyboardLines.voiceLocked)),
      ))
      .run()
  })
  return getVoice(voiceId)
}

/**
 * 台词 → 音色解析顺序（设计 5.6）：
 * 1. `storyboard_lines.voice_id` 显式绑定且未删除
 * 2. 角色激活音色
 * 3. 项目旁白音色
 */
export function resolveVoiceForLine(line: {
  voiceId?: number | null
  characterId?: number | null
  dramaId: number
}): VoiceRow | null {
  if (line.voiceId) {
    const explicit = getVoice(line.voiceId)
    if (explicit) return explicit
  }
  if (line.characterId) {
    const active = db.select().from(schema.characterVoices)
      .where(and(
        eq(schema.characterVoices.characterId, line.characterId),
        eq(schema.characterVoices.isActive, true),
        isNull(schema.characterVoices.deletedAt),
      ))
      .get()
    if (active) return active
  }
  return getNarratorVoice(line.dramaId)
}

/**
 * 把激活音色同步为视频模型的参考音频（`characters.voice_audio_url`）。
 * 参考音频每段需 ≤15 秒，超出时用 ffmpeg 裁到 14.5 秒。
 */
export async function syncVoiceToVideoReference(characterId: number, voiceId: number): Promise<string> {
  const voice = getVoice(voiceId)
  if (!voice) throw new Error('音色不存在')
  if (voice.characterId !== characterId) throw new Error('音色不属于该角色')
  const source = voice.sampleUrl || voice.refAudioUrl
  if (!source) throw new Error('该音色还没有样音，先生成试听')

  const abs = path.isAbsolute(source) ? source : getAbsolutePath(source)
  if (!fs.existsSync(abs)) throw new Error('音色文件不存在，请重新生成试听')

  const duration = await new Promise<number>((resolve, reject) => {
    ffmpeg.ffprobe(abs, (err, meta) => {
      if (err) return reject(new Error('无法读取音色时长'))
      resolve(Number(meta.format.duration) || 0)
    })
  })
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取音色时长')

  let relative = source.replace(/^\//, '')
  if (duration > 15) {
    const dir = path.join(STORAGE_ROOT, 'voice-references')
    fs.mkdirSync(dir, { recursive: true })
    const filename = `voice-${voiceId}-${Date.now()}.wav`
    const target = path.join(dir, filename)
    await new Promise<void>((resolve, reject) => {
      ffmpeg(abs)
        .noVideo()
        .setStartTime(0)
        .duration(14.5)
        .audioChannels(1)
        .audioFrequency(48000)
        .audioCodec('pcm_s16le')
        .format('wav')
        .on('end', () => resolve())
        .on('error', () => reject(new Error('音色裁剪失败')))
        .save(target)
    })
    relative = `static/voice-references/${filename}`
  }

  db.update(schema.characters)
    .set({ voiceAudioUrl: relative, updatedAt: now() })
    .where(eq(schema.characters.id, characterId))
    .run()
  return relative
}

/**
 * V1 兼容迁移：角色已上传 `voice_audio_url` 但没有任何音色档案时，
 * 建一条 `source='upload'`、`status='ready'`、`is_active=1` 的记录。
 * 幂等：已有任一未删除音色即跳过；失败只记录日志，不影响启动。
 */
export function migrateUploadedVoices(): { migrated: number; failed: number } {
  let migrated = 0
  let failed = 0
  try {
    const characters = db.select().from(schema.characters).where(isNull(schema.characters.deletedAt)).all()
    for (const character of characters) {
      if (!character.voiceAudioUrl) continue
      const existing = db.select().from(schema.characterVoices)
        .where(and(eq(schema.characterVoices.characterId, character.id), isNull(schema.characterVoices.deletedAt)))
        .get()
      if (existing) continue
      try {
        const ts = now()
        db.insert(schema.characterVoices).values({
          dramaId: character.dramaId,
          characterId: character.id,
          scope: 'character',
          name: `${character.name}（历史样本）`,
          source: 'upload',
          refAudioUrl: character.voiceAudioUrl,
          sampleUrl: character.voiceAudioUrl,
          voicePrompt: character.voicePrompt ?? null,
          voicePromptSource: 'template',
          status: 'ready',
          isActive: true,
          speed: 1,
          language: 'Chinese',
          createdAt: ts,
          updatedAt: ts,
        }).run()
        migrated += 1
      } catch (err: any) {
        failed += 1
        console.warn(`[voice-migrate] 角色 ${character.id} 迁移失败：${err?.message || err}`)
      }
    }
  } catch (err: any) {
    console.warn('[voice-migrate] 迁移中断：', err?.message || err)
  }
  if (migrated) console.log(`[voice-migrate] 已迁移 ${migrated} 个历史音色`)
  return { migrated, failed }
}
