/**
 * 导演台计划服务：D0 提供只读计划视图。
 * 镜头/子镜头/机位/站位全部存 doc_json；GET 不写任何表。
 */
import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, max } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getDirectorSettings, type DirectorSettings } from './app-settings.js'

export type DirectorMode = 'off' | 'readonly' | 'on'

export interface DirectorVec3 {
  x: number
  y: number
  z: number
}

export interface DirectorCamera {
  shot_type: string
  angle: string
  movement: string
  lens_mm: number
  height_m: number
  position: DirectorVec3
  look_at: DirectorVec3
}

export interface DirectorBlocking {
  character_id: number
  name: string
  x: number
  y: number
  z: number
  rotation: number
}

export interface DirectorSubshot {
  no: number
  description: string
  duration_sec: number
  path_index: number
}

export interface DirectorShot {
  storyboard_id: number
  shot_number: number
  scene_id: number | null
  duration_sec: number
  camera: DirectorCamera
  blocking: DirectorBlocking[]
  subshots: DirectorSubshot[]
  notes: string
  dirty_fields: string[]
}

export interface DirectorPlanDoc {
  version: 1
  episode_id: number
  based_on: { storyboard_hash: string; storyboard_count: number }
  view: { mode: '2d' | '3d'; zoom: number }
  shots: DirectorShot[]
}

export interface DirectorPlanView {
  version: number
  doc_version: number
  based_on: DirectorPlanDoc['based_on']
  view: DirectorPlanDoc['view']
  shots: DirectorShot[]
}

export interface DirectorStoryboardSummary {
  id: number
  storyboard_number: number
  duration: number
  shot_type: string | null
  angle: string | null
  movement: string | null
  has_video: boolean
  updated_at: string
}

export interface DirectorPlanPayload {
  mode: DirectorMode
  can_edit: boolean
  view3d_enabled: boolean
  plan: DirectorPlanView
  /** 当前分镜指纹；冲突后用户确认重对齐时写回文档 based_on */
  current_based_on: DirectorPlanDoc['based_on']
  storyboards: DirectorStoryboardSummary[]
  warnings: string[]
}

export class DirectorError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export interface StoryboardRowLike {
  id: number
  episodeId: number
  sceneId: number | null
  storyboardNumber: number
  shotType: string | null
  angle: string | null
  movement: string | null
  description: string | null
  videoPrompt: string | null
  duration: number | null
  videoUrl: string | null
  composedVideoUrl: string | null
  updatedAt: string
}

export interface StoryboardFingerprint {
  overall: string
  shots: Array<{ id: number; number: number; hash: string }>
}

const SHOT_MARKER_RE = /【镜头\s*(\d+)\s*】/g
const BASELINE_HASH_RE = /^[0-9a-f]{16}$/

function sha256Short(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function shotFingerprint(row: StoryboardRowLike): string {
  return sha256Short(JSON.stringify([
    row.id,
    row.storyboardNumber,
    row.shotType ?? '',
    row.angle ?? '',
    row.movement ?? '',
    row.duration ?? 0,
    row.description ?? '',
    row.videoPrompt ?? '',
    row.updatedAt,
  ]))
}

export function fingerprintStoryboards(rows: StoryboardRowLike[]): StoryboardFingerprint {
  const shots = rows.map((row) => ({
    id: row.id,
    number: row.storyboardNumber,
    hash: shotFingerprint(row),
  }))
  const overall = sha256Short(JSON.stringify({
    count: rows.length,
    shots: rows.map((row) => [row.id, row.storyboardNumber, shotFingerprint(row)]),
  }))
  return { overall, shots }
}

export function serializeStoryboardBaseline(rows: StoryboardRowLike[]): string {
  const fingerprint = fingerprintStoryboards(rows)
  const entries = fingerprint.shots.map((shot) => `${shot.id}:${shot.number}:${shot.hash}`)
  return `${fingerprint.overall}|${entries.join(',')}`
}

export function parseStoryboardBaseline(raw: string | null | undefined): StoryboardFingerprint | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const [overall, entries = ''] = text.split('|')
  if (!BASELINE_HASH_RE.test(overall)) return null
  const shots: StoryboardFingerprint['shots'] = []
  for (const entry of entries.split(',')) {
    if (!entry) continue
    const [idRaw, numberRaw, hash] = entry.split(':')
    const id = Number(idRaw)
    const number = Number(numberRaw)
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(number) || !BASELINE_HASH_RE.test(hash ?? '')) {
      return null
    }
    shots.push({ id, number, hash })
  }
  return { overall, shots }
}

function parseSubshots(description: string | null, durationSec: number): DirectorSubshot[] {
  const text = String(description ?? '')
  const matches = [...text.matchAll(SHOT_MARKER_RE)]
  const sequential = matches.length > 0 && matches.every((match, index) => Number(match[1]) === index + 1)
  if (!sequential) {
    return [{ no: 1, description: text.trim(), duration_sec: round2(durationSec), path_index: 0 }]
  }
  const totalCents = Math.round(durationSec * 100)
  const baseCents = Math.floor(totalCents / matches.length)
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length
    const cents = index === matches.length - 1
      ? totalCents - baseCents * (matches.length - 1)
      : baseCents
    return {
      no: index + 1,
      description: text.slice(start, end).trim(),
      duration_sec: Math.max(0, cents) / 100,
      path_index: index,
    }
  })
}

function clampShotDuration(
  raw: unknown,
  settings: DirectorSettings,
): { value: number; clamped: boolean } {
  const source = Number(raw)
  const fallback = settings.duration.min
  if (!Number.isFinite(source) || source <= 0) return { value: fallback, clamped: true }
  if (source < settings.duration.min) return { value: settings.duration.min, clamped: true }
  if (source > settings.duration.max) return { value: settings.duration.max, clamped: true }
  return { value: round2(source), clamped: false }
}

interface BlockingCharacter {
  id: number
  name: string
}

function defaultBlocking(characters: BlockingCharacter[]): DirectorBlocking[] {
  if (characters.length === 0) return []
  if (characters.length === 1) {
    return [{ character_id: characters[0].id, name: characters[0].name, x: 0, y: 0, z: 0, rotation: 0 }]
  }
  return characters.map((character, index) => {
    const angle = (Math.PI * 2 * index) / characters.length - Math.PI / 2
    return {
      character_id: character.id,
      name: character.name,
      x: round2(Math.cos(angle) * 1.2),
      y: 0,
      z: round2(Math.sin(angle) * 1.2),
      rotation: 0,
    }
  })
}

function blockingCenter(blocking: DirectorBlocking[]): DirectorVec3 {
  if (blocking.length === 0) return { x: 0, y: 1.2, z: 0 }
  const sum = blocking.reduce((acc, item) => ({ x: acc.x + item.x, z: acc.z + item.z }), { x: 0, z: 0 })
  return { x: round2(sum.x / blocking.length), y: 1.2, z: round2(sum.z / blocking.length) }
}

function buildEmptyShot(
  row: StoryboardRowLike,
  settings: DirectorSettings,
  characters: BlockingCharacter[],
): { shot: DirectorShot; durationClamped: boolean } {
  const duration = clampShotDuration(row.duration, settings)
  const blocking = defaultBlocking(characters)
  return {
    shot: {
      storyboard_id: row.id,
      shot_number: row.storyboardNumber,
      scene_id: row.sceneId ?? null,
      duration_sec: duration.value,
      camera: {
        shot_type: String(row.shotType ?? ''),
        angle: String(row.angle ?? ''),
        movement: String(row.movement ?? ''),
        lens_mm: 35,
        height_m: 1.6,
        position: { x: 0, y: 0, z: 0 },
        look_at: blockingCenter(blocking),
      },
      blocking,
      subshots: parseSubshots(row.description, duration.value),
      notes: '',
      dirty_fields: [],
    },
    durationClamped: duration.clamped,
  }
}

export function buildEmptyDirectorDoc(
  episodeId: number,
  rows: StoryboardRowLike[],
  settings: DirectorSettings,
  charactersByStoryboard: Map<number, BlockingCharacter[]>,
): DirectorPlanDoc {
  return {
    version: 1,
    episode_id: episodeId,
    based_on: {
      storyboard_hash: fingerprintStoryboards(rows).overall,
      storyboard_count: rows.length,
    },
    view: { mode: settings.view.default, zoom: 1 },
    shots: rows.map((row) => buildEmptyShot(row, settings, charactersByStoryboard.get(row.id) ?? []).shot),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function finiteOr(value: unknown, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function normalizeVec3(raw: unknown, fallback: DirectorVec3): DirectorVec3 {
  if (!isPlainObject(raw)) return { ...fallback }
  return {
    x: round2(finiteOr(raw.x, fallback.x)),
    y: round2(finiteOr(raw.y, fallback.y)),
    z: round2(finiteOr(raw.z, fallback.z)),
  }
}

function normalizeCamera(raw: unknown, fallback: DirectorCamera): DirectorCamera {
  if (raw === undefined || raw === null) return { ...fallback }
  if (!isPlainObject(raw)) throw new Error('camera 必须是对象')
  return {
    shot_type: typeof raw.shot_type === 'string' ? raw.shot_type : fallback.shot_type,
    angle: typeof raw.angle === 'string' ? raw.angle : fallback.angle,
    movement: typeof raw.movement === 'string' ? raw.movement : fallback.movement,
    lens_mm: round2(finiteOr(raw.lens_mm, fallback.lens_mm)),
    height_m: round2(finiteOr(raw.height_m, fallback.height_m)),
    position: normalizeVec3(raw.position, fallback.position),
    look_at: normalizeVec3(raw.look_at, fallback.look_at),
  }
}

function normalizeBlocking(raw: unknown): DirectorBlocking[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('blocking 必须是数组')
  return raw.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`blocking[${index}] 必须是对象`)
    const characterId = Number(item.character_id)
    if (!Number.isSafeInteger(characterId) || characterId <= 0) {
      throw new Error(`blocking[${index}].character_id 非法`)
    }
    return {
      character_id: characterId,
      name: typeof item.name === 'string' ? item.name : '',
      x: round2(finiteOr(item.x, 0)),
      y: round2(finiteOr(item.y, 0)),
      z: round2(finiteOr(item.z, 0)),
      rotation: round2(finiteOr(item.rotation, 0)),
    }
  })
}

function normalizeSubshots(raw: unknown, durationSec: number): DirectorSubshot[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('subshots 必须是数组')
  return raw.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`subshots[${index}] 必须是对象`)
    return {
      no: Math.max(1, Math.round(finiteOr(item.no, index + 1))),
      description: typeof item.description === 'string' ? item.description : '',
      duration_sec: round2(Math.max(0, finiteOr(item.duration_sec, durationSec))),
      path_index: Math.round(finiteOr(item.path_index, index)),
    }
  })
}

function normalizeStoredShot(
  raw: unknown,
  index: number,
  fallback: DirectorShot | null,
): DirectorShot {
  if (!isPlainObject(raw)) throw new Error(`shots[${index}] 必须是对象`)
  const storyboardId = Number(raw.storyboard_id)
  if (!Number.isSafeInteger(storyboardId) || storyboardId <= 0) {
    throw new Error(`shots[${index}].storyboard_id 非法`)
  }
  const shotNumber = Number(raw.shot_number)
  if (!Number.isSafeInteger(shotNumber) || shotNumber <= 0) {
    throw new Error(`shots[${index}].shot_number 非法`)
  }
  const durationSec = finiteOr(raw.duration_sec, fallback?.duration_sec ?? 0)
  const fallbackCamera = fallback?.camera ?? {
    shot_type: '',
    angle: '',
    movement: '',
    lens_mm: 35,
    height_m: 1.6,
    position: { x: 0, y: 0, z: 0 },
    look_at: { x: 0, y: 1.2, z: 0 },
  }
  const camera = normalizeCamera(raw.camera, fallbackCamera)
  const blocking = normalizeBlocking(raw.blocking)
  const subshots = normalizeSubshots(
    raw.subshots === undefined || raw.subshots === null ? fallback?.subshots : raw.subshots,
    durationSec,
  )
  return {
    storyboard_id: storyboardId,
    shot_number: shotNumber,
    scene_id: raw.scene_id === null || raw.scene_id === undefined ? (fallback?.scene_id ?? null) : Number(raw.scene_id) || null,
    duration_sec: round2(Math.max(0, durationSec)),
    camera,
    blocking,
    subshots,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    dirty_fields: Array.isArray(raw.dirty_fields)
      ? raw.dirty_fields.filter((field): field is string => typeof field === 'string')
      : [],
  }
}

export interface ParsedStoredDoc {
  view: DirectorPlanDoc['view']
  basedOn: DirectorPlanDoc['based_on'] | null
  shots: DirectorShot[]
  docVersion: number
}

export function parseStoredDoc(raw: string): ParsedStoredDoc {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new DirectorError(422, 'DIRECTOR_PLAN_INVALID', '导演计划文档不是合法 JSON')
  }
  if (!isPlainObject(parsed)) {
    throw new DirectorError(422, 'DIRECTOR_PLAN_INVALID', '导演计划文档必须是对象')
  }
  const rawShots = parsed.shots
  if (!Array.isArray(rawShots)) {
    throw new DirectorError(422, 'DIRECTOR_PLAN_INVALID', '导演计划文档缺少 shots 数组')
  }
  const shots: DirectorShot[] = []
  try {
    rawShots.forEach((item, index) => {
      shots.push(normalizeStoredShot(item, index, null))
    })
  } catch (error) {
    throw new DirectorError(422, 'DIRECTOR_PLAN_INVALID', `导演计划文档结构非法：${(error as Error).message}`)
  }
  const viewRaw = isPlainObject(parsed.view) ? parsed.view : {}
  const basedOnRaw = isPlainObject(parsed.based_on) ? parsed.based_on : null
  return {
    view: {
      mode: viewRaw.mode === '3d' ? '3d' : '2d',
      zoom: Math.min(2, Math.max(0.5, finiteOr(viewRaw.zoom, 1))),
    },
    basedOn: basedOnRaw
      ? {
          storyboard_hash: typeof basedOnRaw.storyboard_hash === 'string' ? basedOnRaw.storyboard_hash : '',
          storyboard_count: Math.max(0, Math.round(finiteOr(basedOnRaw.storyboard_count, 0))),
        }
      : null,
    shots,
    docVersion: 1,
  }
}

export interface LoadedContext {
  episode: typeof schema.episodes.$inferSelect
  rows: StoryboardRowLike[]
  settings: DirectorSettings
  planRow: typeof schema.directorPlans.$inferSelect | null
  charactersByStoryboard: Map<number, BlockingCharacter[]>
  characterImages: Map<number, string | null>
  scenesById: Map<number, { location: string; imageUrl: string | null }>
}

export async function loadContext(episodeId: number): Promise<LoadedContext> {
  const settings = getDirectorSettings()
  if (settings.mode === 'off') {
    throw new DirectorError(403, 'DIRECTOR_DISABLED', '导演台已关闭')
  }
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode || episode.deletedAt) {
    throw new DirectorError(404, 'DIRECTOR_EPISODE_NOT_FOUND', '分集不存在')
  }
  const rows = await db.select().from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.episodeId, episodeId),
      isNull(schema.storyboards.deletedAt),
    ))
    .orderBy(asc(schema.storyboards.storyboardNumber), asc(schema.storyboards.id))
  const [planRow] = await db.select().from(schema.directorPlans)
    .where(eq(schema.directorPlans.episodeId, episodeId))

  const storyboardIds = rows.map((row) => row.id)
  const storyboardLinks = storyboardIds.length > 0
    ? await db.select().from(schema.storyboardCharacters)
      .where(inArray(schema.storyboardCharacters.storyboardId, storyboardIds))
    : []
  const episodeCharacterLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharacterIds = new Set(episodeCharacterLinks.map((link) => link.characterId))
  const allCharacters = episodeCharacterIds.size > 0
    ? await db.select().from(schema.characters)
      .where(and(
        eq(schema.characters.dramaId, episode.dramaId),
        isNull(schema.characters.deletedAt),
      ))
    : []
  const charactersById = new Map(
    allCharacters
      .filter((character) => episodeCharacterIds.has(character.id))
      .map((character) => [character.id, character]),
  )
  const charactersByStoryboard = new Map<number, BlockingCharacter[]>()
  for (const link of storyboardLinks) {
    const character = charactersById.get(link.characterId)
    if (!character) continue
    const list = charactersByStoryboard.get(link.storyboardId) ?? []
    list.push({ id: character.id, name: character.name })
    charactersByStoryboard.set(link.storyboardId, list)
  }
  const characterImages = new Map(
    [...charactersById.values()].map((character) => [character.id, character.imageUrl ?? null] as const),
  )

  const sceneIds = [...new Set(rows.map((row) => row.sceneId).filter((id): id is number => typeof id === 'number' && id > 0))]
  const sceneRows = sceneIds.length > 0
    ? await db.select().from(schema.scenes).where(inArray(schema.scenes.id, sceneIds))
    : []
  const scenesById = new Map(
    sceneRows
      .filter((scene) => !scene.deletedAt)
      .map((scene) => [scene.id, { location: scene.location, imageUrl: scene.imageUrl ?? null }] as const),
  )

  return { episode, rows, settings, planRow: planRow ?? null, charactersByStoryboard, characterImages, scenesById }
}

function reconcileShots(
  context: LoadedContext,
  stored: DirectorShot[] | null,
  warnings: string[],
): { shots: DirectorShot[]; durationClamped: number } {
  const storedById = new Map<number, DirectorShot>()
  let orphanCount = 0
  const currentIds = new Set(context.rows.map((row) => row.id))
  for (const shot of stored ?? []) {
    if (!currentIds.has(shot.storyboard_id)) {
      orphanCount += 1
      continue
    }
    if (storedById.has(shot.storyboard_id)) {
      throw new DirectorError(422, 'DIRECTOR_PLAN_INVALID', '导演计划文档包含重复镜头')
    }
    storedById.set(shot.storyboard_id, shot)
  }
  if (orphanCount > 0) warnings.push(`计划含 ${orphanCount} 个不属于本集的镜头，已忽略`)
  let durationClamped = 0
  const shots = context.rows.map((row) => {
    const existing = storedById.get(row.id)
    if (existing) return existing
    const built = buildEmptyShot(row, context.settings, context.charactersByStoryboard.get(row.id) ?? [])
    if (built.durationClamped) durationClamped += 1
    return built.shot
  })
  return { shots, durationClamped }
}

function buildWarnings(
  context: LoadedContext,
  shots: DirectorShot[],
  durationClamped: number,
  baselineHash: string | null | undefined = context.planRow?.basedOnHash,
): string[] {
  const warnings: string[] = []
  const { settings, rows } = context

  if (rows.length > settings.stage.maxShots) {
    warnings.push(`镜头数 ${rows.length} 超过上限 ${settings.stage.maxShots}，导演台为只读`)
  }
  if (durationClamped > 0) {
    warnings.push(`${durationClamped} 个镜头时长超出 ${settings.duration.min}–${settings.duration.max}s，生成计划已钳制`)
  }
  const storedOutOfRange = shots.filter((shot) => (
    shot.duration_sec < settings.duration.min || shot.duration_sec > settings.duration.max
  ))
  if (storedOutOfRange.length > 0) {
    warnings.push(`镜头时长超出 ${settings.duration.min}–${settings.duration.max}s：镜头 ${storedOutOfRange.map((shot) => shot.shot_number).join('、')}`)
  }
  const subshotMismatch = shots.filter((shot) => {
    if (shot.subshots.length === 0) return false
    const total = shot.subshots.reduce((sum, item) => sum + item.duration_sec, 0)
    return Math.abs(total - shot.duration_sec) > 0.2
  })
  if (subshotMismatch.length > 0) {
    warnings.push(`子镜头总时长不一致：镜头 ${subshotMismatch.map((shot) => shot.shot_number).join('、')}`)
  }

  const missingScenes = new Map<number, string>()
  for (const row of rows) {
    if (typeof row.sceneId !== 'number' || row.sceneId <= 0) {
      missingScenes.set(0, '未绑定场景')
      continue
    }
    const scene = context.scenesById.get(row.sceneId)
    if (!scene?.imageUrl) missingScenes.set(row.sceneId, scene?.location ?? `场景 ${row.sceneId}`)
  }
  if (missingScenes.size > 0) {
    const names = [...missingScenes.values()].slice(0, 3).join('、')
    warnings.push(`场景图缺失：${missingScenes.size} 个场景（${names}）`)
  }

  const usedCharacterIds = new Set<number>()
  for (const shot of shots) {
    for (const item of shot.blocking) usedCharacterIds.add(item.character_id)
  }
  const missingCharacters = [...usedCharacterIds]
    .filter((id) => context.characterImages.get(id) === null)
    .map((id) => {
      const shot = shots.find((item) => item.blocking.some((blocking) => blocking.character_id === id))
      return shot?.blocking.find((blocking) => blocking.character_id === id)?.name || `角色 ${id}`
    })
  if (missingCharacters.length > 0) {
    const names = missingCharacters.slice(0, 3).join('、')
    warnings.push(`人物图缺失：${missingCharacters.length} 个角色（${names}）`)
  }

  const baseline = parseStoryboardBaseline(baselineHash)
  if (baseline) {
    const current = fingerprintStoryboards(rows)
    if (current.overall !== baseline.overall) {
      const currentById = new Map(current.shots.map((shot) => [shot.id, shot]))
      const baselineById = new Map(baseline.shots.map((shot) => [shot.id, shot]))
      const added = current.shots.filter((shot) => !baselineById.has(shot.id)).map((shot) => shot.number)
      const removed = baseline.shots.filter((shot) => !currentById.has(shot.id)).map((shot) => shot.number)
      const modified = current.shots
        .filter((shot) => {
          const previous = baselineById.get(shot.id)
          return previous && previous.hash !== shot.hash
        })
        .map((shot) => shot.number)
      if (added.length > 0) warnings.push(`分镜新增：镜头 ${added.join('、')}`)
      if (removed.length > 0) warnings.push(`分镜删除：镜头 ${removed.join('、')}`)
      if (modified.length > 0) warnings.push(`分镜修改：镜头 ${modified.join('、')}`)
      if (added.length === 0 && removed.length === 0 && modified.length === 0) {
        warnings.push('分镜已变化，请核对计划')
      }
    }
  }

  return warnings
}

export async function getDirectorPlanView(episodeId: number): Promise<DirectorPlanPayload> {
  const context = await loadContext(episodeId)
  const { settings, rows, planRow } = context
  const warnings: string[] = []

  let storedShots: DirectorShot[] | null = null
  let storedView: DirectorPlanDoc['view'] = { mode: settings.view.default, zoom: 1 }
  let storedBasedOn: DirectorPlanDoc['based_on'] | null = null
  if (planRow?.docJson) {
    const parsed = parseStoredDoc(planRow.docJson)
    storedShots = parsed.shots
    storedView = parsed.view
    storedBasedOn = parsed.basedOn
  }

  const reconciled = reconcileShots(context, storedShots, warnings)
  warnings.push(...buildWarnings(context, reconciled.shots, reconciled.durationClamped))

  const currentFingerprint = fingerprintStoryboards(rows)
  const plan: DirectorPlanView = {
    version: planRow?.version ?? 0,
    doc_version: planRow?.docVersion ?? 1,
    based_on: storedBasedOn ?? {
      storyboard_hash: currentFingerprint.overall,
      storyboard_count: rows.length,
    },
    view: storedView,
    shots: reconciled.shots,
  }
  const storyboards: DirectorStoryboardSummary[] = rows.map((row) => ({
    id: row.id,
    storyboard_number: row.storyboardNumber,
    duration: Number(row.duration ?? 0),
    shot_type: row.shotType ?? null,
    angle: row.angle ?? null,
    movement: row.movement ?? null,
    has_video: Boolean(row.videoUrl || row.composedVideoUrl),
    updated_at: row.updatedAt,
  }))

  return {
    mode: settings.mode,
    can_edit: settings.mode === 'on' && rows.length <= settings.stage.maxShots,
    view3d_enabled: settings.view3d.enabled,
    plan,
    current_based_on: {
      storyboard_hash: currentFingerprint.overall,
      storyboard_count: currentFingerprint.shots.length,
    },
    storyboards,
    warnings,
  }
}

// --- D1 保存、版本与恢复 ---

const STAGE_HALF_EXTENT_M = 20
const SUBSHOT_TOLERANCE_SEC = 0.2
const MAX_PLAN_REVISIONS = 50
const DIRTY_FIELD_NAMES = new Set(['shot_type', 'angle', 'movement', 'duration'])

export interface DirectorSaveResult {
  version: number
  doc_version: number
  can_apply: boolean
  apply_blocked_reason: string | null
  warnings: string[]
  revision_no: number
  updated_at: string
}

export interface DirectorRevisionSummary {
  id: number
  revision_no: number
  note: string | null
  is_current: boolean
  created_at: string
}

export interface DirectorRevisionList {
  plan_version: number
  revisions: DirectorRevisionSummary[]
}

function invalidDoc(message: string): never {
  throw new DirectorError(422, 'DIRECTOR_PLAN_INVALID', message)
}

function rejected(message: string, data?: Record<string, unknown>): never {
  throw new DirectorError(400, 'DIRECTOR_PLAN_REJECTED', message, data)
}

function requireDocObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) invalidDoc(`${label} 必须是对象`)
  return value
}

function requireDocNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidDoc(`${label} 必须是数字`)
  return value
}

function requireDocString(value: unknown, label: string): string {
  if (typeof value !== 'string') invalidDoc(`${label} 必须是字符串`)
  return value
}

function requireDocInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalidDoc(`${label} 必须是整数`)
  return value
}

function parseSaveVec3(raw: unknown, label: string): DirectorVec3 {
  const obj = requireDocObject(raw, label)
  return {
    x: round2(requireDocNumber(obj.x, `${label}.x`)),
    y: round2(requireDocNumber(obj.y, `${label}.y`)),
    z: round2(requireDocNumber(obj.z, `${label}.z`)),
  }
}

function parseSaveBlocking(raw: unknown, label: string): DirectorBlocking {
  const obj = requireDocObject(raw, label)
  const characterId = requireDocInteger(obj.character_id, `${label}.character_id`)
  if (characterId <= 0) invalidDoc(`${label}.character_id 非法`)
  return {
    character_id: characterId,
    name: requireDocString(obj.name, `${label}.name`),
    x: round2(requireDocNumber(obj.x, `${label}.x`)),
    y: round2(requireDocNumber(obj.y, `${label}.y`)),
    z: round2(requireDocNumber(obj.z, `${label}.z`)),
    rotation: round2(requireDocNumber(obj.rotation, `${label}.rotation`)),
  }
}

function parseSaveSubshot(raw: unknown, label: string): DirectorSubshot {
  const obj = requireDocObject(raw, label)
  return {
    no: requireDocInteger(obj.no, `${label}.no`),
    description: requireDocString(obj.description, `${label}.description`),
    duration_sec: round2(requireDocNumber(obj.duration_sec, `${label}.duration_sec`)),
    path_index: requireDocInteger(obj.path_index, `${label}.path_index`),
  }
}

function parseSaveShot(raw: unknown, index: number): DirectorShot {
  const label = `shots[${index}]`
  const obj = requireDocObject(raw, label)
  const storyboardId = requireDocInteger(obj.storyboard_id, `${label}.storyboard_id`)
  if (storyboardId <= 0) invalidDoc(`${label}.storyboard_id 非法`)
  const shotNumber = requireDocInteger(obj.shot_number, `${label}.shot_number`)
  if (shotNumber <= 0) invalidDoc(`${label}.shot_number 非法`)
  const cameraRaw = requireDocObject(obj.camera, `${label}.camera`)
  if (!Array.isArray(obj.blocking)) invalidDoc(`${label}.blocking 必须是数组`)
  if (!Array.isArray(obj.subshots)) invalidDoc(`${label}.subshots 必须是数组`)
  const rawSceneId = obj.scene_id
  let sceneId: number | null = null
  if (rawSceneId !== null && rawSceneId !== undefined) {
    sceneId = requireDocInteger(rawSceneId, `${label}.scene_id`)
    if (sceneId <= 0) sceneId = null
  }
  return {
    storyboard_id: storyboardId,
    shot_number: shotNumber,
    scene_id: sceneId,
    duration_sec: round2(requireDocNumber(obj.duration_sec, `${label}.duration_sec`)),
    camera: {
      shot_type: requireDocString(cameraRaw.shot_type, `${label}.camera.shot_type`),
      angle: requireDocString(cameraRaw.angle, `${label}.camera.angle`),
      movement: requireDocString(cameraRaw.movement, `${label}.camera.movement`),
      lens_mm: round2(requireDocNumber(cameraRaw.lens_mm, `${label}.camera.lens_mm`)),
      height_m: round2(requireDocNumber(cameraRaw.height_m, `${label}.camera.height_m`)),
      position: parseSaveVec3(cameraRaw.position, `${label}.camera.position`),
      look_at: parseSaveVec3(cameraRaw.look_at, `${label}.camera.look_at`),
    },
    blocking: obj.blocking.map((item, blockingIndex) => parseSaveBlocking(item, `${label}.blocking[${blockingIndex}]`)),
    subshots: obj.subshots.map((item, subshotIndex) => parseSaveSubshot(item, `${label}.subshots[${subshotIndex}]`)),
    notes: typeof obj.notes === 'string' ? obj.notes : '',
    dirty_fields: Array.isArray(obj.dirty_fields)
      ? [...new Set(obj.dirty_fields.filter((field): field is string => typeof field === 'string' && DIRTY_FIELD_NAMES.has(field)))]
      : [],
  }
}

function parseSaveDoc(raw: unknown, episodeId: number): DirectorPlanDoc {
  const obj = requireDocObject(raw, '导演计划文档')
  if (obj.version !== 1) invalidDoc('导演计划文档 version 必须为 1')
  const docEpisodeId = requireDocInteger(obj.episode_id, 'episode_id')
  if (docEpisodeId !== episodeId) invalidDoc('导演计划文档 episode_id 与当前集不一致')
  if (!Array.isArray(obj.shots)) invalidDoc('导演计划文档缺少 shots 数组')
  const viewRaw = isPlainObject(obj.view) ? obj.view : {}
  let mode: '2d' | '3d' = '2d'
  if (viewRaw.mode !== undefined) {
    if (viewRaw.mode !== '2d' && viewRaw.mode !== '3d') invalidDoc('view.mode 必须是 2d 或 3d')
    mode = viewRaw.mode
  }
  const zoom = viewRaw.zoom === undefined
    ? 1
    : Math.min(2, Math.max(0.5, requireDocNumber(viewRaw.zoom, 'view.zoom')))
  const basedOnRaw = isPlainObject(obj.based_on) ? obj.based_on : {}
  return {
    version: 1,
    episode_id: episodeId,
    based_on: {
      storyboard_hash: typeof basedOnRaw.storyboard_hash === 'string' ? basedOnRaw.storyboard_hash : '',
      storyboard_count: Number.isSafeInteger(Number(basedOnRaw.storyboard_count))
        ? Math.max(0, Number(basedOnRaw.storyboard_count))
        : 0,
    },
    view: { mode, zoom: round2(zoom) },
    shots: obj.shots.map((item, index) => parseSaveShot(item, index)),
  }
}

function assertStageXZ(x: number, z: number, label: string, data: Record<string, unknown>) {
  if (Math.abs(x) > STAGE_HALF_EXTENT_M || Math.abs(z) > STAGE_HALF_EXTENT_M) {
    rejected(`${label} 超出舞台 ±${STAGE_HALF_EXTENT_M} 米边界`, data)
  }
}

function assertStageY(y: number, label: string, data: Record<string, unknown>) {
  if (y < 0 || y > STAGE_HALF_EXTENT_M) {
    rejected(`${label} 高度必须在 0–${STAGE_HALF_EXTENT_M} 米之间`, data)
  }
}

export function mismatchedSubshotShots(shots: DirectorShot[]): number[] {
  const numbers: number[] = []
  for (const shot of shots) {
    const total = round2(shot.subshots.reduce((sum, item) => sum + item.duration_sec, 0))
    if (Math.abs(total - shot.duration_sec) > SUBSHOT_TOLERANCE_SEC) {
      numbers.push(shot.shot_number)
    }
  }
  return numbers
}

function applyBlockedReason(shots: DirectorShot[]): string | null {
  const numbers = mismatchedSubshotShots(shots)
  return numbers.length === 0
    ? null
    : `子镜头总时长与镜头时长相差超过 ${SUBSHOT_TOLERANCE_SEC} 秒：镜头 ${numbers.join('、')}`
}

export function assertDirectorWritable(context: LoadedContext): void {
  if (context.settings.mode !== 'on') {
    throw new DirectorError(403, 'DIRECTOR_READONLY', '导演台为只读')
  }
  if (context.rows.length > context.settings.stage.maxShots) {
    throw new DirectorError(
      403,
      'DIRECTOR_READONLY',
      `镜头数超过上限 ${context.settings.stage.maxShots}，导演台为只读`,
    )
  }
}

function validateShotsForSave(context: LoadedContext, shots: DirectorShot[]): void {
  const { settings, rows } = context
  const rowById = new Map(rows.map((row) => [row.id, row]))
  if (shots.length !== rows.length) {
    const docIds = new Set(shots.map((shot) => shot.storyboard_id))
    const missing = rows.filter((row) => !docIds.has(row.id)).map((row) => row.storyboardNumber)
    const extra = shots.filter((shot) => !rowById.has(shot.storyboard_id)).map((shot) => shot.shot_number)
    throw new DirectorError(409, 'DIRECTOR_PLAN_SHOT_COUNT', '分镜数量已变化，请重新加载导演计划', {
      current_count: rows.length,
      doc_count: shots.length,
      missing_storyboards: missing,
      extra_storyboards: extra,
    })
  }

  const seenIds = new Set<number>()
  for (const shot of shots) {
    const data = { shot_number: shot.shot_number, storyboard_id: shot.storyboard_id }
    if (seenIds.has(shot.storyboard_id)) {
      rejected('导演计划包含重复镜头', data)
    }
    seenIds.add(shot.storyboard_id)
    const row = rowById.get(shot.storyboard_id)
    if (!row) rejected('镜头不属于当前集', data)
    if (shot.shot_number !== row.storyboardNumber) {
      rejected('镜头序号与当前分镜不一致', data)
    }
    if (shot.scene_id !== (row.sceneId ?? null)) {
      rejected('镜头场景与当前分镜不一致', data)
    }
    if (shot.duration_sec < settings.duration.min || shot.duration_sec > settings.duration.max) {
      rejected(`镜头 ${shot.shot_number} 时长必须在 ${settings.duration.min}–${settings.duration.max} 秒之间`, data)
    }
    if (!(shot.camera.lens_mm > 0) || shot.camera.lens_mm > 300) {
      rejected(`镜头 ${shot.shot_number} 焦距必须在 1–300mm 之间`, data)
    }
    if (shot.camera.height_m < 0 || shot.camera.height_m > STAGE_HALF_EXTENT_M) {
      rejected(`镜头 ${shot.shot_number} 机位高度必须在 0–${STAGE_HALF_EXTENT_M} 米之间`, data)
    }
    assertStageXZ(shot.camera.position.x, shot.camera.position.z, `镜头 ${shot.shot_number} 摄影机位置`, data)
    assertStageY(shot.camera.position.y, `镜头 ${shot.shot_number} 摄影机位置`, data)
    assertStageXZ(shot.camera.look_at.x, shot.camera.look_at.z, `镜头 ${shot.shot_number} 目标点`, data)
    assertStageY(shot.camera.look_at.y, `镜头 ${shot.shot_number} 目标点`, data)

    const seenCharacters = new Set<number>()
    for (const item of shot.blocking) {
      if (seenCharacters.has(item.character_id)) {
        rejected(`镜头 ${shot.shot_number} 站位包含重复角色`, { ...data, character_id: item.character_id })
      }
      seenCharacters.add(item.character_id)
      if (!context.characterImages.has(item.character_id)) {
        rejected(`角色 ${item.name || item.character_id} 未关联当前集`, { ...data, character_id: item.character_id })
      }
      assertStageXZ(item.x, item.z, `镜头 ${shot.shot_number} 角色 ${item.name || item.character_id} 站位`, data)
      assertStageY(item.y, `镜头 ${shot.shot_number} 角色 ${item.name || item.character_id} 站位`, data)
    }

    if (shot.subshots.length === 0) {
      rejected(`镜头 ${shot.shot_number} 至少保留 1 个子镜头`, data)
    }
    shot.subshots.forEach((subshot, subshotIndex) => {
      if (subshot.no !== subshotIndex + 1) {
        rejected(`镜头 ${shot.shot_number} 子镜头序号必须连续`, { ...data, subshot_no: subshot.no })
      }
      if (subshot.duration_sec < 0) {
        rejected(`镜头 ${shot.shot_number} 子镜头时长不能为负`, { ...data, subshot_no: subshot.no })
      }
    })
  }
}

function versionConflict(plan: { version: number | null; updatedAt: string } | null): DirectorError {
  return new DirectorError(409, 'DIRECTOR_VERSION_CONFLICT', '导演计划已被其他窗口保存，请刷新后再试', {
    current_version: plan?.version ?? 0,
    updated_at: plan?.updatedAt ?? null,
  })
}

function planBaseline(
  context: LoadedContext,
  requested?: DirectorPlanDoc['based_on'],
): { raw: string; fingerprint: StoryboardFingerprint } {
  const current = {
    raw: serializeStoryboardBaseline(context.rows),
    fingerprint: fingerprintStoryboards(context.rows),
  }
  const stored = parseStoryboardBaseline(context.planRow?.basedOnHash)
  if (stored && context.planRow?.basedOnHash) {
    // 冲突后用户显式提交当前指纹时重对齐权威基线；普通保存仍沿用已存基线。
    if (
      requested
      && requested.storyboard_hash
      && requested.storyboard_hash === current.fingerprint.overall
      && requested.storyboard_count === current.fingerprint.shots.length
    ) {
      return current
    }
    return { raw: context.planRow.basedOnHash, fingerprint: stored }
  }
  return current
}

function cleanupRevisions(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  planId: number,
): void {
  const stale = tx.select({
    id: schema.directorPlanRevisions.id,
    revisionNo: schema.directorPlanRevisions.revisionNo,
  })
    .from(schema.directorPlanRevisions)
    .where(and(
      eq(schema.directorPlanRevisions.planId, planId),
      eq(schema.directorPlanRevisions.isCurrent, 0),
    ))
    .orderBy(asc(schema.directorPlanRevisions.revisionNo), asc(schema.directorPlanRevisions.id))
    .all()
  const overflow = stale.length + 1 - MAX_PLAN_REVISIONS
  if (overflow > 0) {
    tx.delete(schema.directorPlanRevisions)
      .where(inArray(schema.directorPlanRevisions.id, stale.slice(0, overflow).map((row) => row.id)))
      .run()
  }
}

export async function saveDirectorPlan(
  episodeId: number,
  input: Record<string, unknown>,
): Promise<DirectorSaveResult> {
  const context = await loadContext(episodeId)
  assertDirectorWritable(context)
  const baseVersion = input.base_version
  if (typeof baseVersion !== 'number' || !Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new DirectorError(400, 'DIRECTOR_BASE_VERSION', '缺少有效的 base_version')
  }
  const doc = parseSaveDoc(input.doc, episodeId)
  validateShotsForSave(context, doc.shots)
  const note = typeof input.note === 'string' && input.note.trim()
    ? input.note.trim().slice(0, 200)
    : null
  const baseline = planBaseline(context, doc.based_on)
  const basedOn: DirectorPlanDoc['based_on'] = {
    storyboard_hash: baseline.fingerprint.overall,
    storyboard_count: baseline.fingerprint.shots.length,
  }
  const docJson = JSON.stringify({ ...doc, based_on: basedOn })
  const ts = new Date().toISOString()

  const outcome = db.transaction((tx) => {
    const live = tx.select().from(schema.directorPlans)
      .where(eq(schema.directorPlans.episodeId, episodeId))
      .get() ?? null
    const liveVersion = live?.version ?? 0
    if (liveVersion !== baseVersion) {
      return { conflict: live, version: 0, revisionNo: 0 }
    }
    const nextVersion = liveVersion + 1
    let planId: number
    if (live) {
      tx.update(schema.directorPlans).set({
        docJson,
        docVersion: 1,
        version: nextVersion,
        basedOnHash: baseline.raw,
        updatedAt: ts,
      }).where(eq(schema.directorPlans.id, live.id)).run()
      planId = live.id
    } else {
      const inserted = tx.insert(schema.directorPlans).values({
        episodeId,
        dramaId: context.episode.dramaId,
        docJson,
        docVersion: 1,
        version: nextVersion,
        basedOnHash: baseline.raw,
        createdAt: ts,
        updatedAt: ts,
      }).returning({ id: schema.directorPlans.id }).get()
      planId = inserted.id
    }

    tx.update(schema.directorPlanRevisions)
      .set({ isCurrent: 0 })
      .where(and(
        eq(schema.directorPlanRevisions.planId, planId),
        eq(schema.directorPlanRevisions.isCurrent, 1),
      ))
      .run()
    const maxRow = tx.select({ value: max(schema.directorPlanRevisions.revisionNo) })
      .from(schema.directorPlanRevisions)
      .where(eq(schema.directorPlanRevisions.planId, planId))
      .get()
    const revisionNo = Number(maxRow?.value ?? 0) + 1
    tx.insert(schema.directorPlanRevisions).values({
      planId,
      revisionNo,
      docJson,
      note,
      isCurrent: 1,
      createdAt: ts,
    }).run()
    cleanupRevisions(tx, planId)
    return { conflict: null, version: nextVersion, revisionNo }
  }, { behavior: 'immediate' })

  if (outcome.conflict || outcome.version === 0) {
    throw versionConflict(outcome.conflict)
  }

  return {
    version: outcome.version,
    doc_version: 1,
    can_apply: applyBlockedReason(doc.shots) === null,
    apply_blocked_reason: applyBlockedReason(doc.shots),
    warnings: buildWarnings(context, doc.shots, 0, baseline.raw),
    revision_no: outcome.revisionNo,
    updated_at: ts,
  }
}

export async function listDirectorRevisions(episodeId: number): Promise<DirectorRevisionList> {
  const context = await loadContext(episodeId)
  if (!context.planRow) {
    return { plan_version: 0, revisions: [] }
  }
  const rows = await db.select().from(schema.directorPlanRevisions)
    .where(eq(schema.directorPlanRevisions.planId, context.planRow.id))
    .orderBy(desc(schema.directorPlanRevisions.revisionNo), desc(schema.directorPlanRevisions.id))
  return {
    plan_version: context.planRow.version ?? 0,
    revisions: rows.map((row) => ({
      id: row.id,
      revision_no: row.revisionNo,
      note: row.note ?? null,
      is_current: row.isCurrent === 1,
      created_at: row.createdAt,
    })),
  }
}

export async function restoreDirectorRevision(
  episodeId: number,
  revisionId: number,
): Promise<DirectorSaveResult> {
  const context = await loadContext(episodeId)
  assertDirectorWritable(context)
  const plan = context.planRow
  if (!plan) {
    throw new DirectorError(404, 'DIRECTOR_PLAN_NOT_FOUND', '导演计划尚未保存，没有可恢复的版本')
  }
  const revision = await db.select().from(schema.directorPlanRevisions)
    .where(and(
      eq(schema.directorPlanRevisions.id, revisionId),
      eq(schema.directorPlanRevisions.planId, plan.id),
    ))
    .get()
  if (!revision?.docJson) {
    throw new DirectorError(404, 'DIRECTOR_REVISION_NOT_FOUND', '导演版本不存在')
  }
  let revisionDoc: unknown
  try {
    revisionDoc = JSON.parse(revision.docJson)
  } catch {
    throw new DirectorError(422, 'DIRECTOR_PLAN_INVALID', '导演版本文档不是合法 JSON')
  }
  const doc = parseSaveDoc(revisionDoc, episodeId)
  validateShotsForSave(context, doc.shots)
  const baseline = planBaseline(context)
  const basedOn: DirectorPlanDoc['based_on'] = {
    storyboard_hash: baseline.fingerprint.overall,
    storyboard_count: baseline.fingerprint.shots.length,
  }
  const docJson = JSON.stringify({ ...doc, based_on: basedOn })
  const note = `恢复自版本 v${revision.revisionNo}`
  const ts = new Date().toISOString()

  const outcome = db.transaction((tx) => {
    const live = tx.select().from(schema.directorPlans)
      .where(eq(schema.directorPlans.id, plan.id))
      .get()
    if (!live) {
      throw new DirectorError(404, 'DIRECTOR_PLAN_NOT_FOUND', '导演计划不存在')
    }
    const nextVersion = (live.version ?? 0) + 1
    tx.update(schema.directorPlans).set({
      docJson,
      docVersion: 1,
      version: nextVersion,
      basedOnHash: baseline.raw,
      updatedAt: ts,
    }).where(eq(schema.directorPlans.id, live.id)).run()
    tx.update(schema.directorPlanRevisions)
      .set({ isCurrent: 0 })
      .where(and(
        eq(schema.directorPlanRevisions.planId, live.id),
        eq(schema.directorPlanRevisions.isCurrent, 1),
      ))
      .run()
    const maxRow = tx.select({ value: max(schema.directorPlanRevisions.revisionNo) })
      .from(schema.directorPlanRevisions)
      .where(eq(schema.directorPlanRevisions.planId, live.id))
      .get()
    const revisionNo = Number(maxRow?.value ?? 0) + 1
    tx.insert(schema.directorPlanRevisions).values({
      planId: live.id,
      revisionNo,
      docJson,
      note,
      isCurrent: 1,
      createdAt: ts,
    }).run()
    cleanupRevisions(tx, live.id)
    return { version: nextVersion, revisionNo }
  }, { behavior: 'immediate' })

  return {
    version: outcome.version,
    doc_version: 1,
    can_apply: applyBlockedReason(doc.shots) === null,
    apply_blocked_reason: applyBlockedReason(doc.shots),
    warnings: buildWarnings(context, doc.shots, 0, baseline.raw),
    revision_no: outcome.revisionNo,
    updated_at: ts,
  }
}
