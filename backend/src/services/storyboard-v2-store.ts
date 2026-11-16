/** V2 计划持久化与确认：只生成/存储计划，不调用 TTS、图片或视频。 */
import { and, desc, eq, isNull, ne } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getCanonicalSceneGroups } from './scene-canonical.js'
import { getSceneContractMap } from './scene-contract.js'
import { getV2ReviewChecklist, resolveV2CoveragePreset } from './storyboard-v2-config.js'
import { collectVoiceTimingProfiles } from './voice-timing.js'
import { buildStoryboardPlanV2, type V2Plan } from './storyboard-v2.js'

export interface CreateV2PlanInput {
  episodeId: number
  minDuration?: number
  maxDuration?: number
  coveragePresetKey?: string
}

export interface V2PlanView {
  id: number
  episode_id: number
  drama_id: number
  version: number
  status: string
  plan: V2Plan
  issues: V2Plan['issues']
  diagnostics: V2Plan['diagnostics']
  review_checklist: ReturnType<typeof getV2ReviewChecklist>
  confirmed_at: string | null
  created_at: string
  updated_at: string
}

function parsePlan(row: typeof schema.storyboardV2Plans.$inferSelect): V2Plan {
  return JSON.parse(row.planJson) as V2Plan
}

export function v2PlanView(row: typeof schema.storyboardV2Plans.$inferSelect): V2PlanView {
  const plan = parsePlan(row)
  return {
    id: row.id,
    episode_id: row.episodeId,
    drama_id: row.dramaId,
    version: row.version,
    status: row.status,
    plan,
    issues: plan.issues,
    diagnostics: plan.diagnostics,
    review_checklist: getV2ReviewChecklist(),
    confirmed_at: row.confirmedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

export async function createV2Plan(input: CreateV2PlanInput): Promise<V2PlanView> {
  const episodeId = Number(input.episodeId)
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) throw new Error('剧集编号无效')
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode || episode.deletedAt) throw new Error('剧集不存在')
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).get()
  const script = String(episode.scriptContent || episode.content || '').trim()
  if (!script) throw new Error('该集还没有剧本')
  const characters = db.select({ name: schema.characters.name })
    .from(schema.characters)
    .where(and(eq(schema.characters.dramaId, episode.dramaId), isNull(schema.characters.deletedAt)))
    .all()
  const sceneGroups = await getCanonicalSceneGroups(episode.dramaId)
  const sceneContracts = await getSceneContractMap(episode.dramaId)
  const timingProfiles = await collectVoiceTimingProfiles(episode.dramaId)
  const coveragePreset = resolveV2CoveragePreset(input.coveragePresetKey)
  const plan = buildStoryboardPlanV2({
    script,
    shotStart: 1,
    characters,
    sceneGroups,
    sceneContracts,
    minDuration: input.minDuration,
    maxDuration: input.maxDuration,
    narrationForm: drama?.narrationForm === 'narration' ? 'narration' : 'dialogue',
  }, { timingProfiles, coveragePreset })
  const latest = db.select({ version: schema.storyboardV2Plans.version })
    .from(schema.storyboardV2Plans)
    .where(eq(schema.storyboardV2Plans.episodeId, episodeId))
    .orderBy(desc(schema.storyboardV2Plans.version))
    .get()
  const version = Number(latest?.version || 0) + 1
  const ts = now()
  const row = db.insert(schema.storyboardV2Plans).values({
    episodeId,
    dramaId: episode.dramaId,
    version,
    status: 'draft',
    planJson: JSON.stringify(plan),
    issuesJson: JSON.stringify(plan.issues),
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  return v2PlanView(row)
}

export function getV2Plan(id: number): V2PlanView | null {
  const row = db.select().from(schema.storyboardV2Plans).where(eq(schema.storyboardV2Plans.id, id)).get()
  return row ? v2PlanView(row) : null
}

export function getLatestV2Plan(episodeId: number): V2PlanView | null {
  const row = db.select().from(schema.storyboardV2Plans)
    .where(eq(schema.storyboardV2Plans.episodeId, episodeId))
    .orderBy(desc(schema.storyboardV2Plans.version))
    .get()
  return row ? v2PlanView(row) : null
}

export function confirmV2Plan(id: number): V2PlanView {
  const row = db.select().from(schema.storyboardV2Plans).where(eq(schema.storyboardV2Plans.id, id)).get()
  if (!row) throw new Error('V2 计划不存在')
  const plan = parsePlan(row)
  if (plan.issues.length) throw new Error('V2 计划仍有结构问题，不能确认')
  const ts = now()
  db.update(schema.storyboardV2Plans)
    .set({ status: 'superseded', updatedAt: ts })
    .where(and(
      eq(schema.storyboardV2Plans.episodeId, row.episodeId),
      eq(schema.storyboardV2Plans.status, 'confirmed'),
      ne(schema.storyboardV2Plans.id, row.id),
    ))
    .run()
  db.update(schema.storyboardV2Plans)
    .set({ status: 'confirmed', confirmedAt: ts, updatedAt: ts })
    .where(eq(schema.storyboardV2Plans.id, row.id))
    .run()
  return v2PlanView(db.select().from(schema.storyboardV2Plans).where(eq(schema.storyboardV2Plans.id, row.id)).get()!)
}
