/**
 * 场景地理卡与覆盖计划
 *
 * - 场景地理卡：俯视布局、地标、机位 A/B、轴线；一个场景一张最新卡。
 * - 覆盖计划：从当前分镜派生覆盖单元/缺口，也可保存人工调整后的计划。
 */
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function json(value: unknown): string | null {
  if (value == null) return null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

export interface SceneGeographyView {
  id: number
  drama_id: number
  scene_id: number
  version: number
  layout: string
  landmarks: Array<{ name: string; screen_side?: string; note?: string }>
  camera_sides: Record<string, string[]>
  axis_line: string
  canonical_scene_id: number | null
  updated_at: string
}

function toGeographyView(row: typeof schema.sceneGeographies.$inferSelect): SceneGeographyView {
  return {
    id: row.id,
    drama_id: row.dramaId,
    scene_id: row.sceneId,
    version: row.version,
    layout: row.layoutJson || '',
    landmarks: parseJson(row.landmarksJson, []),
    camera_sides: parseJson(row.cameraSidesJson, { A: [], B: [] }),
    axis_line: row.axisLine || '',
    canonical_scene_id: row.canonicalSceneId ?? null,
    updated_at: row.updatedAt,
  }
}

export async function getSceneGeography(sceneId: number): Promise<SceneGeographyView | null> {
  const [row] = await db.select().from(schema.sceneGeographies)
    .where(eq(schema.sceneGeographies.sceneId, sceneId))
    .orderBy(desc(schema.sceneGeographies.version), desc(schema.sceneGeographies.id))
    .limit(1)
  return row ? toGeographyView(row) : null
}

export async function upsertSceneGeography(sceneId: number, input: {
  layout?: string
  landmarks?: unknown
  cameraSides?: unknown
  axisLine?: string
  canonicalSceneId?: number | null
}): Promise<SceneGeographyView> {
  const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
  if (!scene || scene.deletedAt) throw new Error('场景不存在')
  const existing = await getSceneGeography(sceneId)
  const ts = now()
  if (existing) {
    await db.update(schema.sceneGeographies).set({
      version: existing.version + 1,
      layoutJson: input.layout ?? existing.layout,
      landmarksJson: json(input.landmarks ?? existing.landmarks),
      cameraSidesJson: json(input.cameraSides ?? existing.camera_sides),
      axisLine: input.axisLine ?? existing.axis_line,
      canonicalSceneId: input.canonicalSceneId === undefined ? existing.canonical_scene_id : input.canonicalSceneId,
      updatedAt: ts,
    }).where(eq(schema.sceneGeographies.id, existing.id))
    return (await getSceneGeography(sceneId))!
  }
  const inserted = await db.insert(schema.sceneGeographies).values({
    dramaId: scene.dramaId,
    sceneId,
    version: 1,
    layoutJson: input.layout || '',
    landmarksJson: json(input.landmarks ?? []),
    cameraSidesJson: json(input.cameraSides ?? { A: [], B: [] }),
    axisLine: input.axisLine || '',
    canonicalSceneId: input.canonicalSceneId ?? scene.id,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  return toGeographyView(inserted)
}

export interface CoverageUnit {
  unit_id: string
  storyboard_id: number
  storyboard_number: number
  title: string
  coverage_type: string
  cast_on_screen: number[]
  screen_left: string[]
  screen_right: string[]
  duration: number
  shot_type: string
  inferred: boolean
}

export interface CoverageSummary {
  shot_count: number
  total_duration: number
  counts: Record<string, number>
  gaps: string[]
}

function parseIdArray(value: string | null | undefined): number[] {
  const parsed = parseJson<unknown>(value, [])
  return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : []
}

function parseStringArray(value: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(value, [])
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}

function inferCoverageType(shot: typeof schema.storyboards.$inferSelect): { type: string; inferred: boolean } {
  if (shot.coverageType) return { type: shot.coverageType, inferred: false }
  const text = `${shot.shotType || ''} ${shot.description || ''} ${shot.title || ''}`
  if (/空镜|过渡|转场/.test(text)) return { type: 'transition', inferred: true }
  if (/全景|远景|建立|环境/.test(text)) return { type: 'establishing', inferred: true }
  if (/过肩|肩后|肩越/.test(text)) return { type: 'ots', inferred: true }
  if (/双人|两人|对视|关系镜/.test(text)) return { type: 'two_shot', inferred: true }
  if (/反应|聆听|听着|皱眉|冷笑|震惊/.test(text)) return { type: 'reaction', inferred: true }
  if (/道具|手部|信件|碗|书|刀|灯|琴/.test(text)) return { type: 'insert', inferred: true }
  if (/特写/.test(text)) return { type: 'single', inferred: true }
  return { type: 'single', inferred: true }
}

function summarize(units: CoverageUnit[]): CoverageSummary {
  const counts: Record<string, number> = {}
  for (const unit of units) counts[unit.coverage_type] = (counts[unit.coverage_type] || 0) + 1
  const gaps: string[] = []
  if (!counts.establishing) gaps.push('missing_establishing')
  if (units.some(unit => unit.cast_on_screen.length > 1) && !counts.two_shot) gaps.push('missing_two_shot')
  if (!counts.reaction) gaps.push('missing_reaction')
  if (!counts.insert) gaps.push('missing_insert')
  return {
    shot_count: units.length,
    total_duration: Math.round(units.reduce((sum, unit) => sum + (Number(unit.duration) || 0), 0) * 10) / 10,
    counts,
    gaps,
  }
}

export async function deriveCoveragePlan(episodeId: number, sceneId: number) {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode || episode.deletedAt) throw new Error('剧集不存在')
  const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
  if (!scene || scene.deletedAt || scene.dramaId !== episode.dramaId) throw new Error('场景不属于当前项目')
  const shots = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), eq(schema.storyboards.sceneId, sceneId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
  const units: CoverageUnit[] = shots.map((shot) => {
    const coverage = inferCoverageType(shot)
    return {
      unit_id: `sb-${shot.id}`,
      storyboard_id: shot.id,
      storyboard_number: shot.storyboardNumber,
      title: shot.title || '',
      coverage_type: coverage.type,
      cast_on_screen: parseIdArray(shot.castOnScreen),
      screen_left: parseStringArray(shot.screenLeft),
      screen_right: parseStringArray(shot.screenRight),
      duration: Number(shot.duration) || 0,
      shot_type: shot.shotType || '',
      inferred: coverage.inferred,
    }
  })
  return {
    episode_id: episodeId,
    scene_id: sceneId,
    scene_name: scene.location,
    profile_key: null as string | null,
    version: 0,
    target_duration: Math.round(units.reduce((sum, unit) => sum + unit.duration, 0) * 10) / 10,
    units,
    summary: summarize(units),
    status: 'draft',
  }
}

export async function listCoveragePlans(episodeId: number) {
  const rows = await db.select().from(schema.coveragePlans)
    .where(eq(schema.coveragePlans.episodeId, episodeId))
    .orderBy(desc(schema.coveragePlans.version), asc(schema.coveragePlans.id))
  return rows.map(row => ({
    id: row.id,
    episode_id: row.episodeId,
    scene_id: row.sceneId,
    profile_key: row.profileKey,
    version: row.version,
    target_duration: row.targetDuration,
    units: parseJson(row.unitsJson, []),
    summary: parseJson(row.summaryJson, null),
    status: row.status,
    updated_at: row.updatedAt,
  }))
}

export async function getCoveragePlan(episodeId: number, sceneId: number) {
  const [row] = await db.select().from(schema.coveragePlans)
    .where(and(eq(schema.coveragePlans.episodeId, episodeId), eq(schema.coveragePlans.sceneId, sceneId)))
    .orderBy(desc(schema.coveragePlans.version), desc(schema.coveragePlans.id))
    .limit(1)
  if (!row) return null
  return {
    id: row.id,
    episode_id: row.episodeId,
    scene_id: row.sceneId,
    profile_key: row.profileKey,
    version: row.version,
    target_duration: row.targetDuration,
    units: parseJson(row.unitsJson, []),
    summary: parseJson(row.summaryJson, null),
    status: row.status,
    updated_at: row.updatedAt,
  }
}

export async function saveCoveragePlan(episodeId: number, sceneId: number, input: {
  profileKey?: string | null
  targetDuration?: number
  units?: unknown
  summary?: unknown
  status?: string
}) {
  const [episode] = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId))
  if (!episode || episode.deletedAt) throw new Error('剧集不存在')
  const existing = await getCoveragePlan(episodeId, sceneId)
  const ts = now()
  if (existing) {
    await db.update(schema.coveragePlans).set({
      profileKey: input.profileKey ?? existing.profile_key,
      version: existing.version + 1,
      targetDuration: input.targetDuration ?? existing.target_duration,
      unitsJson: json(input.units ?? existing.units),
      summaryJson: json(input.summary ?? existing.summary),
      status: input.status || 'draft',
      updatedAt: ts,
    }).where(eq(schema.coveragePlans.id, existing.id))
  } else {
    await db.insert(schema.coveragePlans).values({
      episodeId,
      sceneId,
      profileKey: input.profileKey ?? null,
      version: 1,
      targetDuration: input.targetDuration ?? 0,
      unitsJson: json(input.units ?? []),
      summaryJson: json(input.summary ?? null),
      status: input.status || 'draft',
      createdAt: ts,
      updatedAt: ts,
    })
  }
  // 计划是覆盖类型的权威来源：保存计划时回填到分镜合同
  const units = Array.isArray(input.units) ? input.units as Array<Record<string, any>> : []
  for (const unit of units) {
    const storyboardId = Number(unit.storyboard_id)
    const coverageType = String(unit.coverage_type || '').trim()
    if (!storyboardId || !coverageType) continue
    await db.update(schema.storyboards).set({ coverageType })
      .where(and(
        eq(schema.storyboards.id, storyboardId),
        eq(schema.storyboards.episodeId, episodeId),
        eq(schema.storyboards.sceneId, sceneId),
      ))
  }
  return (await getCoveragePlan(episodeId, sceneId))!
}
