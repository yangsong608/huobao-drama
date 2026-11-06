/**
 * 草稿写入（S2 Task 5）：保存与丢弃。
 * 写闸门（off/readonly 403）先于计划归一化与任何写行；
 * 保存走单个 BEGIN IMMEDIATE 事务，事务内重新读取草稿版本做二次校验，
 * 避免"预检查通过 → 并发写入"之间的竞态。
 */
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWritableEpisode } from './edit-access.js'
import { throwVersionConflict } from './edit-conflict.js'
import { EditWorkspaceError } from './edit-errors.js'
import {
  aspectOf,
  computeLayout,
  editSyncHashOf,
  planHashOf,
  projectSettingsForAspect,
  type EditProjectSettings,
} from './edit-plan.js'
import { normalizeEditPlan } from './edit-normalize.js'
import { layoutResponse, parsePlanJson, planHashes } from './edit-response.js'
import { loadEditTimelineData } from './edit-timeline-data.js'
import { buildEditTimeline, dialogPlacementsOf } from './edit-timeline.js'

function projectFor(episode: typeof schema.episodes.$inferSelect): EditProjectSettings {
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId))
    .get()
  return projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30)
}

function currentDraft(episodeId: number) {
  return db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
    .get()
}

function currentRevision(episodeId: number) {
  return db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.episodeId, episodeId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .get()
}

function draftDirtyOf(episodeId: number): boolean {
  const draft = currentDraft(episodeId)
  const revision = currentRevision(episodeId)
  return Boolean(draft) && (
    !revision
    || !revision.planHash
    || draft!.planHash !== revision.planHash
  )
}

export async function saveEditDraft(
  episodeId: number,
  input: Record<string, unknown>,
) {
  // 写闸门先跑：off/readonly 直接 403，不归一化计划、不写任何行。
  const episode = getWritableEpisode(episodeId)
  const project = projectFor(episode)
  const { plan, issues } = normalizeEditPlan(input.plan, { episodeId, project })
  // 只接受 JSON 数字：null / "0" / true 之类的隐式转换不算有效的 base_version。
  const rawBaseVersion = input.base_version
  const baseVersion = typeof rawBaseVersion === 'number' ? rawBaseVersion : Number.NaN
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new EditWorkspaceError(400, 'EDIT_BASE_VERSION', '缺少有效的 base_version')
  }
  const force = input.force === true
  const before = currentDraft(episodeId)
  if (!force && (before?.version ?? 0) !== baseVersion) {
    throwVersionConflict(episodeId, before)
  }

  const ts = new Date().toISOString()
  const planJson = JSON.stringify(plan)
  const planHash = planHashOf(plan)
  const syncHash = editSyncHashOf(plan)
  const revision = currentRevision(episodeId)
  const result = db.transaction((tx) => {
    const live = tx.select().from(schema.episodeEditDrafts)
      .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
      .get()
    if (!force && (live?.version ?? 0) !== baseVersion) {
      return { conflict: live ?? undefined, version: 0 }
    }
    const version = (live?.version ?? 0) + 1
    if (live) {
      tx.update(schema.episodeEditDrafts).set({
        planJson,
        planHash,
        editSyncHash: syncHash,
        version,
        baseRevisionId: revision?.id ?? null,
        updatedAt: ts,
      }).where(eq(schema.episodeEditDrafts.episodeId, episodeId)).run()
    } else {
      tx.insert(schema.episodeEditDrafts).values({
        episodeId,
        dramaId: episode.dramaId,
        planJson,
        planHash,
        editSyncHash: syncHash,
        version,
        baseRevisionId: revision?.id ?? null,
        createdAt: ts,
        updatedAt: ts,
      }).run()
    }
    return { conflict: null, version }
  }, { behavior: 'immediate' })

  if (result.conflict !== null || result.version === 0) {
    throwVersionConflict(episodeId, result.conflict ?? undefined)
  }

  const { lines, takes } = loadEditTimelineData(episodeId)
  const timeline = buildEditTimeline(plan, lines, takes)
  return {
    version: result.version,
    updated_at: ts,
    plan,
    layout: layoutResponse(computeLayout(plan)),
    hashes: planHashes(plan, dialogPlacementsOf(timeline.linePlacements)),
    issues,
    draft_dirty: draftDirtyOf(episodeId),
  }
}

export function discardEditDraft(episodeId: number) {
  getWritableEpisode(episodeId)
  const result = db.delete(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
    .run()
  return { discarded: result.changes > 0 }
}
