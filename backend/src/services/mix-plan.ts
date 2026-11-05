/**
 * MixPlan 编译（V3 · 设计 8.5）
 *
 * - 试听、混音导出、视频合成共用同一份编译结果；
 * - 对白轨是虚拟轨：由 previewTimeline + 激活 Take 生成，不写库；
 * - Solo 只派生 effectiveMuted，不改写数据库里的 muted；
 * - 缺失素材标 unusable，不中断整体编译。
 */
import crypto from 'crypto'
import fs from 'fs'
import { asc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { hasAudioStream, probeDurationMs } from './audio-mix.js'
import { normalizeVideoAudioMode } from './video-audio.js'
import type { previewTimeline } from './dubbing.js'

export const MIX_BUS_KEYS = ['dialogue', 'original', 'sfx', 'bgm', 'master'] as const
export type MixBusKey = typeof MIX_BUS_KEYS[number]

const BUS_PRESETS: Record<MixBusKey, {
  name: string
  volume: number
  ducking: boolean
  lufsTarget: number | null
  limiterCeiling: number | null
}> = {
  dialogue: { name: '对白', volume: 1, ducking: false, lufsTarget: -16, limiterCeiling: null },
  original: { name: '原声', volume: 0.85, ducking: true, lufsTarget: null, limiterCeiling: null },
  sfx: { name: '音效', volume: 1, ducking: false, lufsTarget: null, limiterCeiling: null },
  bgm: { name: '配乐', volume: 0.18, ducking: true, lufsTarget: null, limiterCeiling: null },
  master: { name: '主输出', volume: 1, ducking: false, lufsTarget: -16, limiterCeiling: -1.5 },
}

const ROLE_BUS: Record<string, MixBusKey> = {
  dialogue: 'dialogue',
  voice: 'dialogue',
  crowd: 'dialogue',
  original: 'original',
  ambience: 'original',
  sfx: 'sfx',
  bgm: 'bgm',
}

const VIRTUAL_ROLES = ['voice', 'original', 'bgm'] as const
type VirtualRole = typeof VIRTUAL_ROLES[number]
interface VirtualTrackOverride {
  volume?: number
  pan?: number
  muted?: boolean
  solo?: boolean
  loop?: boolean
}
type VirtualOverrideMap = Partial<Record<VirtualRole, VirtualTrackOverride>>

export const MIX_ASSET_ROLES = [
  'video', 'original', 'dialogue', 'crowd', 'ambience', 'sfx', 'bgm', 'voice', 'custom', 'subtitle',
] as const

export class MixPlanError extends Error {
  readonly status: 400 | 404
  constructor(message: string, status: 400 | 404 = 400) {
    super(message)
    this.status = status
  }
}

export interface MixBus {
  id: number
  key: MixBusKey
  name: string
  volume: number
  muted: boolean
  solo: boolean
  effectiveMuted: boolean
  ducking: boolean
  duckRatio: number
  duckAttackMs: number
  duckReleaseMs: number
  lufsTarget: number | null
  limiterCeiling: number | null
}

export interface MixClip {
  id: number | null
  assetId: number | null
  takeId: number | null
  lineId: number | null
  name: string | null
  startMs: number
  endMs: number
  sourceStartMs: number
  gainDb: number
  pan: number
  fadeInMs: number
  fadeOutMs: number
  fadeCurve: string
  loop: boolean
  muted: boolean
  locked: boolean
  audioUrl: string | null
  usable: boolean
  reason: string | null
}

export interface MixTrack {
  id: number | null
  role: string
  name: string
  busId: MixBusKey
  virtual: boolean
  volume: number
  pan: number
  muted: boolean
  solo: boolean
  effectiveMuted: boolean
  ducking: boolean
  locked: boolean
  hidden: boolean
  loop: boolean
  color: string | null
  height: number
  sortOrder: number
  stemAssetId: number | null
  clips: MixClip[]
}

export interface MixPlan {
  version: 1
  episodeId: number
  durationMs: number
  sampleRate: number
  buses: MixBus[]
  tracks: MixTrack[]
  master: { lufs: number; truePeak: number; limiter: string }
}

type BusRow = typeof schema.audioBuses.$inferSelect
type TrackRow = typeof schema.episodeAudioTracks.$inferSelect
type ClipRow = typeof schema.episodeAudioClips.$inferSelect
type RevisionRow = typeof schema.mixRevisions.$inferSelect

function requireEpisode(episodeId: number) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new MixPlanError('集不存在', 404)
  return episode
}

function busKeyOf(raw: unknown): MixBusKey | null {
  return MIX_BUS_KEYS.includes(raw as MixBusKey) ? raw as MixBusKey : null
}

/** 缺失则补齐 5 条默认总线；幂等，返回按固定顺序排列的总线 */
export function ensureDefaultBuses(episodeId: number): BusRow[] {
  requireEpisode(episodeId)
  const existing = db.select().from(schema.audioBuses)
    .where(eq(schema.audioBuses.episodeId, episodeId))
    .all()
  const byKey = new Map<MixBusKey, BusRow>()
  for (const row of existing) {
    const key = busKeyOf(row.key)
    if (key) byKey.set(key, row)
  }
  let changed = false
  for (const key of MIX_BUS_KEYS) {
    if (byKey.has(key)) continue
    const preset = BUS_PRESETS[key]
    const created = db.insert(schema.audioBuses).values({
      episodeId,
      key,
      name: preset.name,
      volume: preset.volume,
      muted: false,
      solo: false,
      ducking: preset.ducking,
      duckRatio: 6,
      duckAttackMs: 20,
      duckReleaseMs: 250,
      lufsTarget: preset.lufsTarget,
      limiterCeiling: preset.limiterCeiling,
      createdAt: now(),
      updatedAt: now(),
    }).returning().get()
    byKey.set(key, created)
    changed = true
  }
  void changed
  return MIX_BUS_KEYS.map((key) => byKey.get(key)!)
}

function resolveTrackRole(track: TrackRow): string {
  const role = String(track.role || '').trim()
  if (role) return role
  return track.kind || 'custom'
}

function clipSource(raw: string | null | undefined): { url: string | null; usable: boolean; reason: string | null } {
  const url = String(raw || '').trim()
  if (!url) return { url: null, usable: false, reason: '缺少音频素材' }
  if (/^https?:\/\//i.test(url)) return { url, usable: true, reason: null }
  try {
    const abs = getAbsolutePath(url)
    if (!fs.existsSync(abs)) return { url, usable: false, reason: '音频文件不存在' }
  } catch {
    return { url, usable: false, reason: '音频路径无效' }
  }
  return { url, usable: true, reason: null }
}

function toClip(row: ClipRow): MixClip {
  const source = clipSource(row.audioUrl || row.sourceUrl)
  return {
    id: row.id,
    assetId: row.assetId ?? null,
    takeId: row.takeId ?? null,
    lineId: row.lineId ?? null,
    name: row.name ?? null,
    startMs: row.startMs,
    endMs: row.endMs,
    sourceStartMs: row.sourceStartMs ?? 0,
    gainDb: row.gainDb ?? 0,
    pan: row.pan ?? 0,
    fadeInMs: row.fadeInMs ?? 0,
    fadeOutMs: row.fadeOutMs ?? 0,
    fadeCurve: row.fadeCurve || 'linear',
    loop: Boolean(row.loop),
    muted: Boolean(row.muted),
    locked: Boolean(row.locked),
    audioUrl: source.url,
    usable: source.usable,
    reason: source.reason,
  }
}

function buildVirtualDialogueTrack(episodeId: number, timeline: Awaited<ReturnType<typeof previewTimeline>>): MixTrack {
  const takes = db.select().from(schema.lineTakes)
    .where(eq(schema.lineTakes.episodeId, episodeId))
    .orderBy(asc(schema.lineTakes.takeNo))
    .all()
  const activeByLine = new Map<number, typeof takes[number]>()
  for (const take of takes) {
    if (!take.isActive || take.deletedAt) continue
    activeByLine.set(take.lineId, take)
  }

  const clips: MixClip[] = []
  for (const cue of timeline.cues) {
    const take = activeByLine.get(cue.lineId)
    const rawUrl = take?.audioUrl || cue.audioUrl
    const source = clipSource(rawUrl)
    if (!source.url) continue
    clips.push({
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
      audioUrl: source.url,
      usable: source.usable,
      reason: source.reason,
    })
  }

  return {
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
    stemAssetId: null,
    clips,
  }
}

async function readableDurationMs(url: string, fallbackMs = 0): Promise<number> {
  try {
    const abs = getAbsolutePath(url)
    if (!fs.existsSync(abs)) return 0
    const probed = await probeDurationMs(abs)
    return probed > 0 ? probed : fallbackMs
  } catch {
    return 0
  }
}

/** 最近一次非混音合片作为原声总床来源；文件不可读时返回 null */
async function latestMergeBed(episodeId: number): Promise<{ url: string; durationMs: number } | null> {
  const rows = db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .all()
    .filter((row) => row.status === 'completed' && row.mergedUrl && !row.deletedAt && row.kind !== 'mix')
    .sort((a, b) => (b.id || 0) - (a.id || 0))
  for (const row of rows) {
    const url = row.mergedUrl!
    const durationMs = await readableDurationMs(url, Math.max(0, Math.round((row.duration || 0) * 1000)))
    if (durationMs <= 0) continue
    // 无音轨合片不能当原声床，否则混音会因 [1:a] 匹配不到流而整体失败
    let hasAudio = false
    try {
      hasAudio = await hasAudioStream(getAbsolutePath(url))
    } catch {
      hasAudio = false
    }
    if (hasAudio) return { url, durationMs }
  }
  return null
}

function buildVirtualBedTrack(bed: { url: string; durationMs: number }): MixTrack {
  const source = clipSource(bed.url)
  return {
    id: null,
    role: 'original',
    name: '原声总床',
    busId: 'original',
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
    color: '#38bdf8',
    height: 72,
    sortOrder: -2,
    stemAssetId: null,
    clips: [{
      id: null,
      assetId: null,
      takeId: null,
      lineId: null,
      name: '合片原声',
      startMs: 0,
      endMs: bed.durationMs,
      sourceStartMs: 0,
      gainDb: 0,
      pan: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      fadeCurve: 'linear',
      loop: false,
      muted: false,
      locked: false,
      audioUrl: source.url,
      usable: source.usable,
      reason: source.reason,
    }],
  }
}

async function buildVirtualBgmTrack(
  episode: typeof schema.episodes.$inferSelect,
  drama: typeof schema.dramas.$inferSelect | undefined,
  targetDurationMs: number,
): Promise<MixTrack | null> {
  const raw = String(episode.bgmUrl || drama?.bgmUrl || '').trim()
  if (!raw) return null
  const source = clipSource(raw)
  if (!source.usable || !source.url) return null
  const durationMs = targetDurationMs > 0 ? targetDurationMs : await readableDurationMs(source.url)
  if (durationMs <= 0) return null
  return {
    id: null,
    role: 'bgm',
    name: '配乐',
    busId: 'bgm',
    virtual: true,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    effectiveMuted: false,
    ducking: false,
    locked: false,
    hidden: false,
    loop: true,
    color: '#8b5cf6',
    height: 72,
    sortOrder: -3,
    stemAssetId: null,
    clips: [{
      id: null,
      assetId: null,
      takeId: null,
      lineId: null,
      name: '本集配乐',
      startMs: 0,
      endMs: durationMs,
      sourceStartMs: 0,
      gainDb: 0,
      pan: 0,
      fadeInMs: 0,
      fadeOutMs: Math.min(2000, durationMs),
      fadeCurve: 'linear',
      loop: true,
      muted: false,
      locked: false,
      audioUrl: source.url,
      usable: true,
      reason: null,
    }],
  }
}

/** 从数据库编译当前集的 MixPlan；不落库 */
export async function compileMixPlan(episodeId: number, dramaId: number): Promise<MixPlan> {
  const episode = requireEpisode(episodeId)
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  const busRows = ensureDefaultBuses(episodeId)
  const buses: MixBus[] = busRows.map((row) => ({
    id: row.id,
    key: busKeyOf(row.key)!,
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
  }))
  const busByKey = new Map(buses.map((bus) => [bus.key, bus]))

  const trackRows = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episodeId))
    .orderBy(asc(schema.episodeAudioTracks.sortOrder), asc(schema.episodeAudioTracks.id))
    .all()
  const clipRows = db.select().from(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.episodeId, episodeId))
    .orderBy(asc(schema.episodeAudioClips.startMs), asc(schema.episodeAudioClips.id))
    .all()

  // 动态加载：dubbing 依赖 export-service，静态引用会形成循环
  const { previewTimeline: readTimeline } = await import('./dubbing.js')
  const timeline = await readTimeline(episodeId, dramaId)

  const tracks: MixTrack[] = trackRows.map((row) => {
    const role = resolveTrackRole(row)
    const explicitBus = row.busId
      ? buses.find((bus) => bus.id === row.busId)?.key
      : undefined
    return {
      id: row.id,
      role,
      name: row.name,
      busId: explicitBus ?? ROLE_BUS[role] ?? 'sfx',
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
      stemAssetId: row.stemAssetId ?? null,
      clips: clipRows.filter((clip) => clip.trackId === row.id).map(toClip),
    }
  })

  const dbClipEnd = tracks.reduce(
    (max, track) => track.clips.reduce((inner, clip) => Math.max(inner, clip.endMs), max),
    0,
  )
  const hasOriginalUserTrack = tracks.some((track) => (
    track.role === 'original' || track.role === 'ambience' || track.busId === 'original'
  ))
  const hasBgmUserTrack = tracks.some((track) => track.role === 'bgm' || track.busId === 'bgm')
  // 无声集必须在混音层再次静音原声，避免旧合片把原声带回成片
  const silentEpisode = normalizeVideoAudioMode(episode.videoAudioMode) === 'silent'
  const bed = hasOriginalUserTrack || silentEpisode ? null : await latestMergeBed(episodeId)
  const targetDurationMs = Math.max(0, timeline.totalDurationMs, dbClipEnd, bed?.durationMs || 0)
  const virtualTracks: MixTrack[] = [buildVirtualDialogueTrack(episodeId, timeline)]
  if (bed) virtualTracks.push(buildVirtualBedTrack(bed))
  if (!hasBgmUserTrack) {
    const bgmTrack = await buildVirtualBgmTrack(episode, drama, targetDurationMs)
    if (bgmTrack) virtualTracks.push(bgmTrack)
  }
  applyVirtualOverrides(virtualTracks, readVirtualOverrides(episode.mixVirtualTracks))
  tracks.unshift(...virtualTracks)

  const soloActive = tracks.some((track) => track.solo)
    || buses.some((bus) => bus.key !== 'master' && bus.solo)
  for (const bus of buses) {
    bus.effectiveMuted = bus.key === 'master'
      ? bus.muted
      : bus.muted || (soloActive && !bus.solo)
  }
  for (const track of tracks) {
    const bus = busByKey.get(track.busId)!
    const soloed = track.solo || (track.busId !== 'master' && bus.solo)
    track.effectiveMuted = track.muted || bus.muted || (soloActive && !soloed)
  }

  const clipEnd = tracks.reduce(
    (max, track) => track.clips.reduce((inner, clip) => Math.max(inner, clip.endMs), max),
    0,
  )
  const durationMs = Math.max(0, timeline.totalDurationMs, clipEnd)
  const master = busByKey.get('master')!

  return {
    version: 1,
    episodeId: episode.id,
    durationMs,
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

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) result[key] = canonicalize(source[key])
    return result
  }
  return value
}

export function hashMixPlan(plan: MixPlan): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(plan)))
    .digest('hex')
}

export interface MixRevision extends RevisionRow {
  isCurrent: boolean
}

export interface MixPlanInputClip {
  id?: number | null
  trackId?: number | null
  assetId?: number | null
  takeId?: number | null
  lineId?: number | null
  name?: string | null
  startMs?: number
  endMs?: number
  sourceStartMs?: number
  gainDb?: number
  pan?: number
  fadeInMs?: number
  fadeOutMs?: number
  fadeCurve?: string
  loop?: boolean
  muted?: boolean
  locked?: boolean
  audioUrl?: string | null
  sourceUrl?: string | null
}

export interface MixPlanInputTrack {
  id?: number | null
  role?: string
  name?: string
  busId?: string | null
  volume?: number
  pan?: number
  muted?: boolean
  solo?: boolean
  ducking?: boolean
  locked?: boolean
  hidden?: boolean
  loop?: boolean
  color?: string | null
  height?: number
  sortOrder?: number
  stemAssetId?: number | null
  clips?: MixPlanInputClip[]
}

export interface MixPlanInputBus {
  id?: number
  key?: string
  volume?: number
  muted?: boolean
  solo?: boolean
  ducking?: boolean
  duckRatio?: number
  duckAttackMs?: number
  duckReleaseMs?: number
  lufsTarget?: number | null
  limiterCeiling?: number | null
}

export interface MixPlanSaveInput {
  buses?: MixPlanInputBus[]
  tracks?: MixPlanInputTrack[]
  clips?: MixPlanInputClip[]
  /** 虚拟轨覆盖（按 role 匹配 voice/original/bgm） */
  virtualTracks?: MixPlanInputTrack[]
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function optionalId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function readVirtualOverrides(raw: unknown): VirtualOverrideMap {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const result: VirtualOverrideMap = {}
  for (const role of VIRTUAL_ROLES) {
    const value = (parsed as Record<string, unknown>)[role]
    if (!value || typeof value !== 'object') continue
    const source = value as Record<string, unknown>
    const override: VirtualTrackOverride = {}
    if (source.volume !== undefined) override.volume = clampNumber(source.volume, 0, 2, 1)
    if (source.pan !== undefined) override.pan = clampNumber(source.pan, -1, 1, 0)
    if (source.muted !== undefined) override.muted = Boolean(source.muted)
    if (source.solo !== undefined) override.solo = Boolean(source.solo)
    if (source.loop !== undefined) override.loop = Boolean(source.loop)
    result[role] = override
  }
  return result
}

function applyVirtualOverrides(tracks: MixTrack[], overrides: VirtualOverrideMap) {
  for (const track of tracks) {
    if (!track.virtual) continue
    const override = overrides[track.role as VirtualRole]
    if (!override) continue
    if (override.volume !== undefined) track.volume = override.volume
    if (override.pan !== undefined) track.pan = override.pan
    if (override.muted !== undefined) track.muted = override.muted
    if (override.solo !== undefined) track.solo = override.solo
    if (override.loop !== undefined) track.loop = override.loop
  }
}

function serializeVirtualOverrides(inputs: MixPlanInputTrack[]): string {
  const overrides: VirtualOverrideMap = {}
  for (const input of inputs) {
    if (!input || typeof input !== 'object') continue
    const role = VIRTUAL_ROLES.find((item) => item === input.role)
    if (!role) continue
    const override: VirtualTrackOverride = {}
    if (input.volume !== undefined) override.volume = clampNumber(input.volume, 0, 2, 1)
    if (input.pan !== undefined) override.pan = clampNumber(input.pan, -1, 1, 0)
    if (input.muted !== undefined) override.muted = Boolean(input.muted)
    if (input.solo !== undefined) override.solo = Boolean(input.solo)
    if (input.loop !== undefined) override.loop = Boolean(input.loop)
    overrides[role] = override
  }
  return JSON.stringify(overrides)
}

function virtualOverridesFromPlan(plan: MixPlan): VirtualOverrideMap {
  const overrides: VirtualOverrideMap = {}
  for (const track of plan.tracks) {
    if (!track.virtual) continue
    const role = VIRTUAL_ROLES.find((item) => item === track.role)
    if (!role) continue
    overrides[role] = {
      volume: clampNumber(track.volume, 0, 2, 1),
      pan: clampNumber(track.pan, -1, 1, 0),
      muted: Boolean(track.muted),
      solo: Boolean(track.solo),
      loop: Boolean(track.loop),
    }
  }
  return overrides
}

function trackBusKey(raw: unknown): MixBusKey {
  const key = busKeyOf(raw)
  return key ?? ROLE_BUS[String(raw || '')] ?? 'sfx'
}

function applyBusPatch(episodeId: number, input: MixPlanInputBus) {
  const key = busKeyOf(input.key)
  if (!key) throw new MixPlanError('总线 key 无效')
  const bus = db.select().from(schema.audioBuses)
    .where(eq(schema.audioBuses.episodeId, episodeId))
    .all()
    .find((row) => row.key === key)
  if (!bus) throw new MixPlanError('总线不存在', 404)
  const patch: Partial<BusRow> = { updatedAt: now() }
  if (input.volume !== undefined) patch.volume = clampNumber(input.volume, 0, 4, 1)
  if (input.muted !== undefined) patch.muted = Boolean(input.muted)
  if (input.solo !== undefined) patch.solo = Boolean(input.solo)
  if (input.ducking !== undefined) patch.ducking = Boolean(input.ducking)
  if (input.duckRatio !== undefined) patch.duckRatio = clampNumber(input.duckRatio, 1, 20, 6)
  if (input.duckAttackMs !== undefined) patch.duckAttackMs = Math.round(clampNumber(input.duckAttackMs, 0, 2000, 20))
  if (input.duckReleaseMs !== undefined) patch.duckReleaseMs = Math.round(clampNumber(input.duckReleaseMs, 0, 5000, 250))
  if (input.lufsTarget !== undefined) patch.lufsTarget = input.lufsTarget === null ? null : clampNumber(input.lufsTarget, -40, -5, -16)
  if (input.limiterCeiling !== undefined) patch.limiterCeiling = input.limiterCeiling === null ? null : clampNumber(input.limiterCeiling, -6, 0, -1.5)
  db.update(schema.audioBuses).set(patch).where(eq(schema.audioBuses.id, bus.id)).run()
}

export function saveMixBuses(episodeId: number, buses: MixPlanInputBus[]): BusRow[] {
  requireEpisode(episodeId)
  ensureDefaultBuses(episodeId)
  db.transaction(() => {
    for (const bus of buses) applyBusPatch(episodeId, bus)
  })
  return ensureDefaultBuses(episodeId)
}

/**
 * 保存整份轨道/片段/总线状态（工作台拖拽后的批量落库）。
 * 以提交内容为准：未提交的轨道与片段会被删除；片段 id 可保留以避免选中丢失。
 */
export async function saveMixPlan(
  episodeId: number,
  dramaId: number,
  input: MixPlanSaveInput,
): Promise<MixPlan> {
  requireEpisode(episodeId)
  ensureDefaultBuses(episodeId)
  const trackInputs = (input.tracks || []).filter((track) => track && typeof track === 'object')

  const existingTracks = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, episodeId))
    .all()
  const existingTrackIds = new Set(existingTracks.map((track) => track.id))
  const incomingTrackIds = new Set<number>()
  for (const track of trackInputs) {
    const id = optionalId(track.id)
    if (id == null) continue
    if (!existingTrackIds.has(id)) throw new MixPlanError('音轨不属于本集', 400)
    incomingTrackIds.add(id)
  }

  const existingClips = db.select().from(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.episodeId, episodeId))
    .all()
  const existingClipIds = new Set(existingClips.map((clip) => clip.id))
  const grouped = new Map<number | null, MixPlanInputClip[]>()
  if (input.clips !== undefined) {
    for (const clip of input.clips) {
      const trackId = optionalId(clip.trackId)
      if (clip.trackId !== null && clip.trackId !== undefined && trackId == null) {
        throw new MixPlanError('片段所属音轨无效')
      }
      const list = grouped.get(trackId) || []
      list.push(clip)
      grouped.set(trackId, list)
    }
  } else {
    trackInputs.forEach((track, index) => {
      grouped.set(optionalId(track.id) ?? -(index + 1), track.clips || [])
    })
  }

  for (const clips of grouped.values()) {
    for (const clip of clips) {
      const id = optionalId(clip.id)
      if (id != null && !existingClipIds.has(id)) throw new MixPlanError('片段不属于本集', 400)
      const start = Number(clip.startMs)
      const end = Number(clip.endMs)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start < 10) {
        throw new MixPlanError('片段结束时间必须晚于开始时间（至少 10ms）')
      }
    }
  }

  const keyToBusId = new Map(ensureDefaultBuses(episodeId).map((bus) => [bus.key, bus.id]))
  applyBusInputs(episodeId, input.buses)
  const virtualOverridesJson = input.virtualTracks !== undefined
    ? serializeVirtualOverrides(input.virtualTracks)
    : undefined

  db.transaction((tx) => {
    if (virtualOverridesJson !== undefined) {
      tx.update(schema.episodes).set({ mixVirtualTracks: virtualOverridesJson, updatedAt: now() })
        .where(eq(schema.episodes.id, episodeId))
        .run()
    }
    tx.delete(schema.episodeAudioClips)
      .where(eq(schema.episodeAudioClips.episodeId, episodeId))
      .run()
    for (const track of existingTracks) {
      if (incomingTrackIds.has(track.id)) continue
      tx.delete(schema.episodeAudioTracks)
        .where(eq(schema.episodeAudioTracks.id, track.id))
        .run()
    }

    trackInputs.forEach((track, index) => {
      const id = optionalId(track.id)
      const role = String(track.role || '').trim() || 'custom'
      const values = {
        episodeId,
        dramaId,
        kind: role === 'voice' || role === 'dialogue' ? 'voice' : role,
        role,
        name: String(track.name || '音轨').trim().slice(0, 80) || '音轨',
        volume: clampNumber(track.volume, 0, 2, 1),
        pan: clampNumber(track.pan, -1, 1, 0),
        busId: keyToBusId.get(trackBusKey(track.busId)) ?? null,
        muted: Boolean(track.muted),
        solo: Boolean(track.solo),
        ducking: Boolean(track.ducking),
        loop: Boolean(track.loop),
        locked: Boolean(track.locked),
        hidden: Boolean(track.hidden),
        color: track.color ? String(track.color).slice(0, 32) : null,
        height: Math.round(clampNumber(track.height, 56, 120, 72)),
        stemAssetId: optionalId(track.stemAssetId),
        sortOrder: Number.isFinite(Number(track.sortOrder)) ? Math.round(Number(track.sortOrder)) : index,
        updatedAt: now(),
      }
      let trackId: number
      if (id != null) {
        tx.update(schema.episodeAudioTracks).set(values)
          .where(eq(schema.episodeAudioTracks.id, id))
          .run()
        trackId = id
      } else {
        trackId = tx.insert(schema.episodeAudioTracks).values({
          ...values,
          createdAt: now(),
        }).returning().get().id
      }

      const clips = grouped.get(id ?? -(index + 1)) || []
      for (const clip of clips) {
        const clipId = optionalId(clip.id)
        tx.insert(schema.episodeAudioClips).values({
          ...(clipId != null ? { id: clipId } : {}),
          trackId,
          episodeId,
          assetId: optionalId(clip.assetId),
          startMs: Math.max(0, Math.round(Number(clip.startMs))),
          endMs: Math.max(0, Math.round(Number(clip.endMs))),
          sourceStartMs: Math.max(0, Math.round(Number(clip.sourceStartMs) || 0)),
          gainDb: clampNumber(clip.gainDb, -60, 12, 0),
          pan: clampNumber(clip.pan, -1, 1, 0),
          fadeInMs: Math.max(0, Math.round(Number(clip.fadeInMs) || 0)),
          fadeOutMs: Math.max(0, Math.round(Number(clip.fadeOutMs) || 0)),
          fadeCurve: clip.fadeCurve === 'equal_power' ? 'equal_power' : 'linear',
          locked: Boolean(clip.locked),
          muted: Boolean(clip.muted),
          name: clip.name ? String(clip.name).slice(0, 120) : null,
          sourceUrl: clip.audioUrl || clip.sourceUrl || null,
          audioUrl: clip.audioUrl || clip.sourceUrl || null,
          takeId: optionalId(clip.takeId),
          lineId: optionalId(clip.lineId),
          followTake: true,
          loop: Boolean(clip.loop),
          status: 'ready',
          createdAt: now(),
          updatedAt: now(),
        }).run()
      }
    })
  })

  return compileMixPlan(episodeId, dramaId)
}

function applyBusInputs(episodeId: number, buses: MixPlanInputBus[] | undefined) {
  if (!buses?.length) return
  for (const bus of buses) applyBusPatch(episodeId, bus)
}

function toRevision(row: RevisionRow): MixRevision {
  return { ...row, isCurrent: Boolean(row.isCurrent) }
}

export function listMixRevisions(episodeId: number): MixRevision[] {
  requireEpisode(episodeId)
  return db.select().from(schema.mixRevisions)
    .where(eq(schema.mixRevisions.episodeId, episodeId))
    .all()
    .sort((a, b) => b.revisionNo - a.revisionNo)
    .map(toRevision)
}

export async function createMixRevision(episodeId: number, note?: string): Promise<MixRevision> {
  const episode = requireEpisode(episodeId)
  const plan = await compileMixPlan(episodeId, episode.dramaId)
  const revisions = db.select().from(schema.mixRevisions)
    .where(eq(schema.mixRevisions.episodeId, episodeId))
    .all()
  const revisionNo = revisions.reduce((max, item) => Math.max(max, item.revisionNo || 0), 0) + 1
  const row = db.transaction((tx) => {
    tx.update(schema.mixRevisions).set({ isCurrent: false })
      .where(eq(schema.mixRevisions.episodeId, episodeId))
      .run()
    const inserted = tx.insert(schema.mixRevisions).values({
      episodeId,
      revisionNo,
      planJson: JSON.stringify(plan),
      planHash: hashMixPlan(plan),
      note: note ? String(note).slice(0, 500) : null,
      isCurrent: true,
      createdAt: now(),
    }).returning().get()
    tx.update(schema.episodes).set({ mixRevisionId: inserted.id })
      .where(eq(schema.episodes.id, episodeId))
      .run()
    return inserted
  })
  return toRevision(row)
}

function numberOr<T>(value: T | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 恢复版本：把快照写回轨道/片段/总线，并设为当前版本 */
export function restoreMixRevision(episodeId: number, revisionId: number): { revision: MixRevision; plan: MixPlan } {
  const episode = requireEpisode(episodeId)
  const row = db.select().from(schema.mixRevisions)
    .where(eq(schema.mixRevisions.id, revisionId))
    .get()
  if (!row || row.episodeId !== episodeId) throw new MixPlanError('混音版本不存在', 404)
  const plan = JSON.parse(row.planJson) as MixPlan
  const buses = ensureDefaultBuses(episodeId)
  const busIdByKey = new Map(buses.map((bus) => [bus.key, bus.id]))
  const persistTracks = plan.tracks.filter((track) => !track.virtual)
  const persistedIds = new Set(persistTracks.map((track) => track.id).filter((id): id is number => id != null))
  const virtualOverridesJson = JSON.stringify(virtualOverridesFromPlan(plan))

  const clipValues = (trackId: number, clip: MixClip) => ({
    ...(clip.id != null ? { id: clip.id } : {}),
    trackId,
    episodeId,
    assetId: clip.assetId,
    startMs: clip.startMs,
    endMs: clip.endMs,
    sourceStartMs: clip.sourceStartMs,
    gainDb: clip.gainDb,
    pan: clip.pan,
    fadeInMs: clip.fadeInMs,
    fadeOutMs: clip.fadeOutMs,
    fadeCurve: clip.fadeCurve,
    locked: Boolean(clip.locked),
    muted: Boolean(clip.muted),
    name: clip.name,
    sourceUrl: clip.audioUrl,
    audioUrl: clip.audioUrl,
    takeId: clip.takeId,
    followTake: true,
    loop: Boolean(clip.loop),
    status: 'ready',
    lineId: clip.lineId,
    createdAt: now(),
    updatedAt: now(),
  })

  db.transaction((tx) => {
    const existing = tx.select().from(schema.episodeAudioTracks)
      .where(eq(schema.episodeAudioTracks.episodeId, episodeId))
      .all()
    const existingIds = new Set(existing.map((track) => track.id))
    for (const track of existing) {
      if (persistedIds.has(track.id)) continue
      tx.delete(schema.episodeAudioClips)
        .where(eq(schema.episodeAudioClips.trackId, track.id))
        .run()
      tx.delete(schema.episodeAudioTracks)
        .where(eq(schema.episodeAudioTracks.id, track.id))
        .run()
    }

    for (const track of persistTracks) {
      const values = {
        episodeId,
        dramaId: episode.dramaId,
        kind: track.role === 'voice' || track.role === 'dialogue' ? 'voice' : track.role,
        role: track.role,
        name: track.name,
        volume: track.volume,
        pan: track.pan,
        busId: busIdByKey.get(track.busId) ?? null,
        muted: Boolean(track.muted),
        solo: Boolean(track.solo),
        ducking: Boolean(track.ducking),
        loop: Boolean(track.loop),
        locked: Boolean(track.locked),
        hidden: Boolean(track.hidden),
        color: track.color,
        height: track.height,
        stemAssetId: track.stemAssetId,
        sortOrder: track.sortOrder,
        updatedAt: now(),
      }
      if (track.id != null && existingIds.has(track.id)) {
        tx.update(schema.episodeAudioTracks).set(values)
          .where(eq(schema.episodeAudioTracks.id, track.id))
          .run()
        tx.delete(schema.episodeAudioClips)
          .where(eq(schema.episodeAudioClips.trackId, track.id))
          .run()
        for (const clip of track.clips) {
          tx.insert(schema.episodeAudioClips).values(clipValues(track.id, clip)).run()
        }
      } else {
        const inserted = tx.insert(schema.episodeAudioTracks).values({
          ...values,
          ...(track.id != null ? { id: track.id } : {}),
          createdAt: now(),
        }).returning().get()
        for (const clip of track.clips) {
          tx.insert(schema.episodeAudioClips).values(clipValues(inserted.id, clip)).run()
        }
      }
    }

    for (const bus of plan.buses) {
      const id = busIdByKey.get(bus.key)
      if (!id) continue
      tx.update(schema.audioBuses).set({
        name: bus.name,
        volume: numberOr(bus.volume, 1),
        muted: Boolean(bus.muted),
        solo: Boolean(bus.solo),
        ducking: Boolean(bus.ducking),
        duckRatio: numberOr(bus.duckRatio, 6),
        duckAttackMs: numberOr(bus.duckAttackMs, 20),
        duckReleaseMs: numberOr(bus.duckReleaseMs, 250),
        lufsTarget: bus.lufsTarget ?? null,
        limiterCeiling: bus.limiterCeiling ?? null,
        updatedAt: now(),
      }).where(eq(schema.audioBuses.id, id)).run()
    }

    tx.update(schema.mixRevisions).set({ isCurrent: false })
      .where(eq(schema.mixRevisions.episodeId, episodeId))
      .run()
    tx.update(schema.mixRevisions).set({ isCurrent: true })
      .where(eq(schema.mixRevisions.id, revisionId))
      .run()
    tx.update(schema.episodes).set({ mixRevisionId: revisionId, mixVirtualTracks: virtualOverridesJson, updatedAt: now() })
      .where(eq(schema.episodes.id, episodeId))
      .run()
  })

  const fresh = db.select().from(schema.mixRevisions)
    .where(eq(schema.mixRevisions.id, revisionId))
    .get()!
  return { revision: toRevision(fresh), plan }
}
