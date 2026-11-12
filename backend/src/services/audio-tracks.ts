/**
 * 整集附加音轨（V3 · 多轨混音）
 *
 * - `episode_audio_tracks` 描述一条轨（环境声/音效/配乐/语音），
 *   `episode_audio_clips` 描述轨上的时间段片段；
 * - 片段只存逻辑路径，混音前统一解析成本地绝对路径；
 * - solo 语义：任一条轨 solo 时，其余附加轨静音（对话轨不受影响）；
 * - 轨道签名参与混音缓存 hash，改音量/片段即可触发重混。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { asc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { synthesize } from './tts.js'
import { resolveVoiceForLine } from './voice-profile.js'
import type { MixClipInput, MixTrackInput } from './audio-mix.js'

export const AUDIO_TRACK_KINDS = ['ambience', 'sfx', 'bgm', 'voice', 'custom'] as const
export type AudioTrackKind = typeof AUDIO_TRACK_KINDS[number]

/** 新代码以 role 为准；kind 仅兼容旧数据 */
export const AUDIO_TRACK_ROLES = [
  'video', 'original', 'dialogue', 'crowd', 'ambience', 'sfx', 'bgm', 'voice', 'custom', 'subtitle',
] as const
export type AudioTrackRole = typeof AUDIO_TRACK_ROLES[number]

const KIND_LABELS: Record<AudioTrackKind, string> = {
  ambience: '环境声',
  sfx: '音效',
  bgm: '配乐',
  voice: '语音',
  custom: '自定义',
}

export class AudioTrackError extends Error {
  readonly status: 400 | 404
  constructor(message: string, status: 400 | 404 = 400) {
    super(message)
    this.status = status
  }
}

type TrackRow = typeof schema.episodeAudioTracks.$inferSelect
type ClipRow = typeof schema.episodeAudioClips.$inferSelect
export type AudioTrackWithClips = TrackRow & { clips: ClipRow[] }

export interface AudioTrackInput {
  kind?: string
  role?: string
  name?: string
  volume?: number
  pan?: number
  busId?: number | null
  muted?: boolean
  solo?: boolean
  ducking?: boolean
  loop?: boolean
  locked?: boolean
  hidden?: boolean
  color?: string | null
  height?: number
  stemAssetId?: number | null
  duckAttackMs?: number
  duckReleaseMs?: number
  sortOrder?: number
  origin?: string | null
}

export interface AudioClipInput {
  startMs?: number
  endMs?: number
  sourceStartMs?: number
  assetId?: number | null
  gainDb?: number
  pan?: number
  fadeInMs?: number
  fadeOutMs?: number
  fadeCurve?: string
  locked?: boolean
  muted?: boolean
  name?: string | null
  color?: string | null
  sourceUrl?: string | null
  audioUrl?: string | null
  text?: string | null
  voiceId?: number | null
  takeId?: number | null
  followTake?: boolean
  loop?: boolean
  lineId?: number | null
  soundCueId?: number | null
}

export interface VoiceClipInput {
  text?: string
  voiceId?: number | null
  characterId?: number | null
  startMs?: number
  durationMs?: number | null
  trackId?: number | null
  lineId?: number | null
  name?: string | null
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function toMs(value: unknown, fallback = 0): number {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.max(0, n) : fallback
}

function normalizeKind(raw: unknown): AudioTrackKind {
  const kind = String(raw || 'ambience') as AudioTrackKind
  return AUDIO_TRACK_KINDS.includes(kind) ? kind : 'ambience'
}

function normalizeRole(raw: unknown, kind: AudioTrackKind): AudioTrackRole {
  const role = String(raw || '') as AudioTrackRole
  if (AUDIO_TRACK_ROLES.includes(role)) return role
  if (kind === 'voice') return 'voice'
  return kind === 'ambience' || kind === 'sfx' || kind === 'bgm' ? kind : 'custom'
}

function normalizeBusId(raw: unknown, episodeId: number): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) throw new AudioTrackError('总线编号无效')
  const bus = db.select().from(schema.audioBuses).where(eq(schema.audioBuses.id, id)).get()
  if (!bus || bus.episodeId !== episodeId) throw new AudioTrackError('总线不存在', 404)
  return id
}

function normalizeStemAssetId(raw: unknown, episodeId: number): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) throw new AudioTrackError('分离素材编号无效')
  const asset = db.select().from(schema.episodeAudioAssets).where(eq(schema.episodeAudioAssets.id, id)).get()
  if (!asset || asset.episodeId !== episodeId || asset.deletedAt) throw new AudioTrackError('分离素材不存在', 404)
  return id
}

function normalizeFadeCurve(raw: unknown): string {
  return raw === 'equal_power' ? 'equal_power' : 'linear'
}

function normalizeColor(raw: unknown): string | null {
  const value = String(raw || '').trim()
  return value ? value.slice(0, 32) : null
}

function optionalText(raw: unknown, max = 120): string | null {
  const value = String(raw ?? '').trim()
  return value ? value.slice(0, max) : null
}

function getEpisode(episodeId: number) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new AudioTrackError('集不存在', 404)
  return episode
}

function requireTrack(trackId: number, episodeId: number): TrackRow {
  const row = db.select().from(schema.episodeAudioTracks).where(eq(schema.episodeAudioTracks.id, trackId)).get()
  if (!row || row.episodeId !== episodeId) throw new AudioTrackError('音轨不存在', 404)
  return row
}

function requireClip(clipId: number, episodeId: number): ClipRow {
  const row = db.select().from(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.id, clipId)).get()
  if (!row || row.episodeId !== episodeId) throw new AudioTrackError('音频片段不存在', 404)
  return row
}

/** 校验音频来源存在；返回原样路径（static/... 或绝对路径） */
function assertAudioSource(raw: unknown): string {
  const value = String(raw || '').trim()
  if (!value) throw new AudioTrackError('缺少音频来源')
  const abs = path.isAbsolute(value) ? value : getAbsolutePath(value)
  if (!fs.existsSync(abs)) throw new AudioTrackError(`音频文件不存在：${value}`)
  return value
}

function clipsOf(episodeId: number): ClipRow[] {
  return db.select().from(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.episodeId, episodeId))
    .orderBy(asc(schema.episodeAudioClips.startMs), asc(schema.episodeAudioClips.id))
    .all()
}

export function listAudioTracks(episodeId: number): AudioTrackWithClips[] {
  getEpisode(episodeId)
  const tracks = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episodeId))
    .orderBy(asc(schema.episodeAudioTracks.sortOrder), asc(schema.episodeAudioTracks.id))
    .all()
  const clips = clipsOf(episodeId)
  return tracks.map((track) => ({ ...track, clips: clips.filter((clip) => clip.trackId === track.id) }))
}

export function createAudioTrack(episodeId: number, input: AudioTrackInput): AudioTrackWithClips {
  const episode = getEpisode(episodeId)
  const kind = normalizeKind(input.kind)
  const existing = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episodeId))
    .all()
  const maxOrder = existing.reduce((max, track) => Math.max(max, track.sortOrder || 0), 0)
  const name = String(input.name || KIND_LABELS[kind]).trim().slice(0, 80) || KIND_LABELS[kind]
  const row = db.insert(schema.episodeAudioTracks).values({
    episodeId,
    dramaId: episode.dramaId,
    kind,
    role: normalizeRole(input.role, kind),
    name,
    volume: clampNumber(input.volume, 0, 2, 1),
    pan: clampNumber(input.pan, -1, 1, 0),
    busId: normalizeBusId(input.busId, episodeId),
    muted: Boolean(input.muted),
    solo: Boolean(input.solo),
    ducking: input.ducking === undefined ? kind !== 'voice' : Boolean(input.ducking),
    loop: Boolean(input.loop),
    locked: Boolean(input.locked),
    hidden: Boolean(input.hidden),
    color: normalizeColor(input.color),
    height: clampNumber(input.height, 56, 120, 72),
    stemAssetId: normalizeStemAssetId(input.stemAssetId, episodeId),
    duckAttackMs: Math.round(clampNumber(input.duckAttackMs, 0, 2000, 20)),
    duckReleaseMs: Math.round(clampNumber(input.duckReleaseMs, 0, 5000, 250)),
    sortOrder: Number.isFinite(Number(input.sortOrder)) ? Math.round(Number(input.sortOrder)) : maxOrder + 1,
    origin: input.origin === 'soundscape' || input.origin === 'sound-plan' ? input.origin : null,
    createdAt: now(),
    updatedAt: now(),
  }).returning().get()
  return { ...row, clips: [] }
}

export function updateAudioTrack(episodeId: number, trackId: number, input: AudioTrackInput): AudioTrackWithClips {
  const row = requireTrack(trackId, episodeId)
  const patch: Partial<TrackRow> = { updatedAt: now() }
  if (input.kind !== undefined) patch.kind = normalizeKind(input.kind)
  if (input.role !== undefined) {
    patch.role = normalizeRole(input.role, (patch.kind ?? row.kind) as AudioTrackKind)
  } else if (input.kind !== undefined) {
    patch.role = normalizeRole(row.role, patch.kind as AudioTrackKind)
  }
  if (input.name !== undefined) {
    const name = String(input.name).trim().slice(0, 80)
    if (!name) throw new AudioTrackError('音轨名称不能为空')
    patch.name = name
  }
  if (input.volume !== undefined) patch.volume = clampNumber(input.volume, 0, 2, 1)
  if (input.pan !== undefined) patch.pan = clampNumber(input.pan, -1, 1, 0)
  if (input.busId !== undefined) patch.busId = normalizeBusId(input.busId, episodeId)
  if (input.muted !== undefined) patch.muted = Boolean(input.muted)
  if (input.solo !== undefined) patch.solo = Boolean(input.solo)
  if (input.ducking !== undefined) patch.ducking = Boolean(input.ducking)
  if (input.loop !== undefined) patch.loop = Boolean(input.loop)
  if (input.locked !== undefined) patch.locked = Boolean(input.locked)
  if (input.hidden !== undefined) patch.hidden = Boolean(input.hidden)
  if (input.color !== undefined) patch.color = normalizeColor(input.color)
  if (input.height !== undefined) patch.height = Math.round(clampNumber(input.height, 56, 120, 72))
  if (input.stemAssetId !== undefined) patch.stemAssetId = normalizeStemAssetId(input.stemAssetId, episodeId)
  if (input.duckAttackMs !== undefined) patch.duckAttackMs = Math.round(clampNumber(input.duckAttackMs, 0, 2000, 20))
  if (input.duckReleaseMs !== undefined) patch.duckReleaseMs = Math.round(clampNumber(input.duckReleaseMs, 0, 5000, 250))
  if (input.sortOrder !== undefined && Number.isFinite(Number(input.sortOrder))) patch.sortOrder = Math.round(Number(input.sortOrder))
  db.update(schema.episodeAudioTracks).set(patch).where(eq(schema.episodeAudioTracks.id, trackId)).run()
  const updated = db.select().from(schema.episodeAudioTracks).where(eq(schema.episodeAudioTracks.id, trackId)).get()!
  return { ...updated, clips: clipsOf(episodeId).filter((clip) => clip.trackId === trackId) }
}

export function deleteAudioTrack(episodeId: number, trackId: number): boolean {
  requireTrack(trackId, episodeId)
  db.transaction((tx) => {
    tx.delete(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.trackId, trackId)).run()
    tx.delete(schema.episodeAudioTracks).where(eq(schema.episodeAudioTracks.id, trackId)).run()
  })
  return true
}

function validateTimes(startMs: number, endMs: number) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new AudioTrackError('时间段无效')
  if (endMs - startMs < 50) throw new AudioTrackError('片段结束时间必须晚于开始时间（至少 50ms）')
}

export function createAudioClip(episodeId: number, trackId: number, input: AudioClipInput): ClipRow {
  requireTrack(trackId, episodeId)
  const startMs = toMs(input.startMs, 0)
  const endMs = toMs(input.endMs, startMs + 1000)
  validateTimes(startMs, endMs)
  const url = assertAudioSource(input.audioUrl || input.sourceUrl)
  const row = db.insert(schema.episodeAudioClips).values({
    trackId,
    episodeId,
    assetId: input.assetId ? Number(input.assetId) : null,
    startMs,
    endMs,
    sourceStartMs: toMs(input.sourceStartMs, 0),
    gainDb: clampNumber(input.gainDb, -60, 12, 0),
    pan: clampNumber(input.pan, -1, 1, 0),
    fadeInMs: toMs(input.fadeInMs, 0),
    fadeOutMs: toMs(input.fadeOutMs, 0),
    fadeCurve: normalizeFadeCurve(input.fadeCurve),
    locked: Boolean(input.locked),
    muted: Boolean(input.muted),
    name: optionalText(input.name),
    color: normalizeColor(input.color),
    sourceUrl: url,
    audioUrl: url,
    text: input.text ? String(input.text).slice(0, 2000) : null,
    voiceId: input.voiceId ? Number(input.voiceId) : null,
    takeId: input.takeId ? Number(input.takeId) : null,
    followTake: input.followTake === undefined ? true : Boolean(input.followTake),
    loop: Boolean(input.loop),
    lineId: input.lineId ? Number(input.lineId) : null,
    soundCueId: input.soundCueId ? Number(input.soundCueId) : null,
    status: 'ready',
    createdAt: now(),
    updatedAt: now(),
  }).returning().get()
  return row
}

export function updateAudioClip(episodeId: number, clipId: number, input: AudioClipInput): ClipRow {
  const row = requireClip(clipId, episodeId)
  const startMs = input.startMs !== undefined ? toMs(input.startMs, row.startMs) : row.startMs
  const endMs = input.endMs !== undefined ? toMs(input.endMs, row.endMs) : row.endMs
  validateTimes(startMs, endMs)
  const url = input.audioUrl !== undefined || input.sourceUrl !== undefined
    ? assertAudioSource(input.audioUrl || input.sourceUrl)
    : undefined
  const patch: Partial<ClipRow> = {
    startMs,
    endMs,
    updatedAt: now(),
    ...(input.assetId !== undefined ? { assetId: input.assetId ? Number(input.assetId) : null } : {}),
    ...(input.sourceStartMs !== undefined ? { sourceStartMs: toMs(input.sourceStartMs, 0) } : {}),
    ...(input.gainDb !== undefined ? { gainDb: clampNumber(input.gainDb, -60, 12, 0) } : {}),
    ...(input.pan !== undefined ? { pan: clampNumber(input.pan, -1, 1, 0) } : {}),
    ...(input.fadeInMs !== undefined ? { fadeInMs: toMs(input.fadeInMs, 0) } : {}),
    ...(input.fadeOutMs !== undefined ? { fadeOutMs: toMs(input.fadeOutMs, 0) } : {}),
    ...(input.fadeCurve !== undefined ? { fadeCurve: normalizeFadeCurve(input.fadeCurve) } : {}),
    ...(input.locked !== undefined ? { locked: Boolean(input.locked) } : {}),
    ...(input.muted !== undefined ? { muted: Boolean(input.muted) } : {}),
    ...(input.name !== undefined ? { name: optionalText(input.name) } : {}),
    ...(input.color !== undefined ? { color: normalizeColor(input.color) } : {}),
    ...(url ? { sourceUrl: url, audioUrl: url, status: 'ready', error: null } : {}),
    ...(input.text !== undefined ? { text: input.text ? String(input.text).slice(0, 2000) : null } : {}),
    ...(input.voiceId !== undefined ? { voiceId: input.voiceId ? Number(input.voiceId) : null } : {}),
    ...(input.takeId !== undefined ? { takeId: input.takeId ? Number(input.takeId) : null } : {}),
    ...(input.followTake !== undefined ? { followTake: Boolean(input.followTake) } : {}),
    ...(input.loop !== undefined ? { loop: Boolean(input.loop) } : {}),
    ...(input.lineId !== undefined ? { lineId: input.lineId ? Number(input.lineId) : null } : {}),
  }
  db.update(schema.episodeAudioClips).set(patch).where(eq(schema.episodeAudioClips.id, clipId)).run()
  return db.select().from(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.id, clipId)).get()!
}

export function deleteAudioClip(episodeId: number, clipId: number): boolean {
  requireClip(clipId, episodeId)
  db.delete(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.id, clipId)).run()
  return true
}

function ensureVoiceTrack(episodeId: number): TrackRow {
  const existing = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episodeId))
    .orderBy(asc(schema.episodeAudioTracks.id))
    .all()
    .find((track) => track.kind === 'voice')
  if (existing) return existing
  return createAudioTrack(episodeId, { kind: 'voice', name: KIND_LABELS.voice })
}

/** 用 TTS 在指定时间段生成一条语音片段（可复用已有轨道） */
export async function createVoiceClip(episodeId: number, input: VoiceClipInput) {
  const episode = getEpisode(episodeId)
  const text = String(input.text || '').trim()
  if (!text) throw new AudioTrackError('语音文本不能为空')
  if ([...text].length > 2000) throw new AudioTrackError('单条语音不能超过 2000 字')

  const voice = resolveVoiceForLine({
    voiceId: input.voiceId ? Number(input.voiceId) : null,
    characterId: input.characterId ? Number(input.characterId) : null,
    dramaId: episode.dramaId,
  })
  if (!voice) throw new AudioTrackError('没有可用音色，请先在角色面板生成或绑定旁白音色')

  let result
  try {
    result = await synthesize({
      text,
      voice: {
        externalVoiceId: voice.externalVoiceId || undefined,
        voicePrompt: voice.voicePrompt || undefined,
        designInstruct: voice.designInstruct || undefined,
        refAudioUrl: voice.refAudioUrl || undefined,
        refText: voice.refText || undefined,
        xVectorOnly: Boolean(voice.xVectorOnly),
      },
      speed: voice.speed ?? 1,
      emotion: voice.emotion ?? undefined,
      language: voice.language ?? undefined,
      meta: {
        dramaId: episode.dramaId,
        episodeId,
        characterId: input.characterId ? Number(input.characterId) : undefined,
        lineId: input.lineId ? Number(input.lineId) : undefined,
      },
    })
  } catch (error: any) {
    throw new AudioTrackError(String(error?.message || error).slice(0, 500))
  }

  const track = input.trackId ? requireTrack(Number(input.trackId), episodeId) : ensureVoiceTrack(episodeId)
  const startMs = toMs(input.startMs, 0)
  const durationMs = input.durationMs ? Math.max(50, Math.round(Number(input.durationMs))) : result.durationMs
  const clip = db.insert(schema.episodeAudioClips).values({
    trackId: track.id,
    episodeId,
    startMs,
    endMs: startMs + durationMs,
    sourceStartMs: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    sourceUrl: result.url,
    audioUrl: result.url,
    text,
    voiceId: voice.id,
    lineId: input.lineId ? Number(input.lineId) : null,
    status: 'ready',
    createdAt: now(),
    updatedAt: now(),
  }).returning().get()

  const freshTrack = db.select().from(schema.episodeAudioTracks).where(eq(schema.episodeAudioTracks.id, track.id)).get()!
  return {
    track: { ...freshTrack, clips: clipsOf(episodeId).filter((item) => item.trackId === track.id) },
    clip,
    cached: result.cached,
  }
}

export interface CollectedMixTracks {
  tracks: MixTrackInput[]
  signature: string
  count: number
  soloActive: boolean
}

/**
 * 把数据库里的音轨/片段整理成混音输入。
 * solo 只影响附加轨；对话轨、BGM 不受影响，避免误把整集配音静音。
 */
export function collectMixTracks(episodeId: number): CollectedMixTracks {
  const rows = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episodeId))
    .orderBy(asc(schema.episodeAudioTracks.sortOrder), asc(schema.episodeAudioTracks.id))
    .all()
  if (!rows.length) return { tracks: [], signature: '', count: 0, soloActive: false }

  const clips = clipsOf(episodeId)
  const soloActive = rows.some((row) => Boolean(row.solo) && !row.muted)
  const tracks: MixTrackInput[] = []
  const signature: unknown[] = []

  for (const row of rows) {
    const muted = Boolean(row.muted) || (soloActive && !row.solo)
    const trackClips: MixClipInput[] = []
    const clipSignature: unknown[] = []
    for (const clip of clips.filter((item) => item.trackId === row.id)) {
      const source = clip.audioUrl || clip.sourceUrl
      const audioPath = source ? (path.isAbsolute(source) ? source : getAbsolutePath(source)) : ''
      const usable = Boolean(audioPath) && clip.status !== 'failed' && fs.existsSync(audioPath)
      clipSignature.push([clip.id, clip.startMs, clip.endMs, clip.sourceStartMs, clip.fadeInMs, clip.fadeOutMs, source, usable])
      if (!usable) continue
      trackClips.push({
        audioPath,
        startMs: clip.startMs,
        endMs: clip.endMs,
        sourceStartMs: clip.sourceStartMs ?? 0,
        fadeInMs: clip.fadeInMs ?? 0,
        fadeOutMs: clip.fadeOutMs ?? 0,
      })
    }
    signature.push([
      row.id, row.kind, row.volume, muted, Boolean(row.ducking), Boolean(row.loop), clipSignature,
    ])
    if (!trackClips.length) continue
    tracks.push({
      id: row.id,
      kind: row.kind || 'custom',
      name: row.name,
      volume: clampNumber(row.volume, 0, 2, 1),
      muted,
      solo: Boolean(row.solo),
      ducking: row.ducking !== false,
      loop: Boolean(row.loop),
      clips: trackClips,
    })
  }

  const hash = crypto.createHash('sha256').update(JSON.stringify(signature)).digest('hex')
  return { tracks, signature: hash, count: tracks.length, soloActive }
}
