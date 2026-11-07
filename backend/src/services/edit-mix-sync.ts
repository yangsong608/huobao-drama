/**
 * 剪辑-混音同步事实源（设计 §4.3、§5.2）：
 * 只读解析当前编辑工程与计划，计算与混音版本相同的两类哈希并给出对齐状态。
 * 不创建工程、不写草稿/版本，也不调用任何 compile* 入口（它们会补默认总线）。
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  dialogueSyncHashOf,
  editSyncHashOf,
  planHashOf,
} from './edit-plan.js'
import { currentRevisionFor, loadProjectPlan } from './edit-draft-service.js'
import { projectForFilm, type EditProjectRow } from './edit-project-service.js'
import { buildTimelineForPlan } from './edit-timeline-data.js'
import { dialogPlacementsOf } from './edit-timeline.js'

export type MixSyncStatus = 'aligned' | 'stale' | 'missing' | 'no_edit_plan'
export type MixSyncReason = 'legacy_mix' | 'timing_changed' | 'dialogue_changed'

export interface MixSyncHashSet {
  project: EditProjectRow
  editRevisionId: number | null
  editPlanHash: string
  editSyncHash: string
  dialogueSyncHash: string
}

export interface MixSyncStatusResult {
  status: MixSyncStatus
  reasons: MixSyncReason[]
  edit_revision_id: number | null
  edit_plan_hash: string | null
  edit_sync_hash: string | null
  dialogue_sync_hash: string | null
  mix_revision_id: number | null
}

function currentMixRevisionOf(episodeId: number) {
  return db.select().from(schema.mixRevisions)
    .where(and(
      eq(schema.mixRevisions.episodeId, episodeId),
      eq(schema.mixRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.mixRevisions.createdAt), desc(schema.mixRevisions.id))
    .get() ?? null
}

/**
 * 与 resolveEditProject() 的只读部分同序：当前成片工程 → episode.editProjectId → 最近工程。
 * 当前成片没有工程时继续回退，不自动打开/创建（openProjectForFilm 属写路径，禁止在此调用）。
 */
export function existingProjectForEpisode(episodeId: number): EditProjectRow | null {
  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) return null
  if (episode.currentFilmId) {
    const filmProject = projectForFilm(episodeId, episode.currentFilmId)
    if (filmProject) return filmProject
  }
  if (episode.editProjectId) {
    const opened = db.select().from(schema.editProjects)
      .where(and(
        eq(schema.editProjects.id, episode.editProjectId),
        eq(schema.editProjects.episodeId, episodeId),
        isNull(schema.editProjects.deletedAt),
      ))
      .get()
    if (opened) return opened
  }
  return db.select().from(schema.editProjects)
    .where(and(
      eq(schema.editProjects.episodeId, episodeId),
      isNull(schema.editProjects.deletedAt),
    ))
    .orderBy(sql`${schema.editProjects.sourceMergeId} IS NULL ASC`, desc(schema.editProjects.updatedAt))
    .get() ?? null
}

export function editHashesForEpisode(episodeId: number): MixSyncHashSet | null {
  const project = existingProjectForEpisode(episodeId)
  if (!project) return null
  let plan
  try {
    plan = loadProjectPlan(project)
  } catch {
    return null
  }
  const timeline = buildTimelineForPlan(episodeId, plan)
  const placements = dialogPlacementsOf(timeline.linePlacements)
  return {
    project,
    editRevisionId: currentRevisionFor(project.id)?.id ?? null,
    editPlanHash: planHashOf(plan),
    editSyncHash: editSyncHashOf(plan),
    dialogueSyncHash: dialogueSyncHashOf(placements),
  }
}

export function mixSyncStatusOf(episodeId: number): MixSyncStatusResult {
  const revision = currentMixRevisionOf(episodeId)
  const hashes = editHashesForEpisode(episodeId)
  if (!hashes) {
    return {
      status: 'no_edit_plan',
      reasons: [],
      edit_revision_id: null,
      edit_plan_hash: null,
      edit_sync_hash: null,
      dialogue_sync_hash: null,
      mix_revision_id: revision?.id ?? null,
    }
  }
  if (!revision) {
    return {
      status: 'missing',
      reasons: [],
      edit_revision_id: hashes.editRevisionId,
      edit_plan_hash: hashes.editPlanHash,
      edit_sync_hash: hashes.editSyncHash,
      dialogue_sync_hash: hashes.dialogueSyncHash,
      mix_revision_id: null,
    }
  }
  const reasons: MixSyncReason[] = []
  if (!revision.editSyncHash) reasons.push('legacy_mix')
  else if (revision.editSyncHash !== hashes.editSyncHash) reasons.push('timing_changed')
  if (revision.dialogueSyncHash && revision.dialogueSyncHash !== hashes.dialogueSyncHash) {
    reasons.push('dialogue_changed')
  }
  return {
    status: reasons.length ? 'stale' : 'aligned',
    reasons,
    edit_revision_id: hashes.editRevisionId,
    edit_plan_hash: hashes.editPlanHash,
    edit_sync_hash: hashes.editSyncHash,
    dialogue_sync_hash: hashes.dialogueSyncHash,
    mix_revision_id: revision.id,
  }
}

/** createMixRevision() 使用：无编辑计划时返回 null，两列留空。 */
export function mixHashesForEpisode(episodeId: number): { editSyncHash: string; dialogueSyncHash: string } | null {
  const hashes = editHashesForEpisode(episodeId)
  if (!hashes) return null
  return { editSyncHash: hashes.editSyncHash, dialogueSyncHash: hashes.dialogueSyncHash }
}
