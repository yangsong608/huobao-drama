/**
 * 工程草稿写入（设计 §6.1、§6.11）：保存与丢弃。
 * 草稿按 project_id 唯一（idx_edit_drafts_project）；写闸门（off/readonly 403）
 * 先于计划归一化与任何写行；保存走 BEGIN IMMEDIATE 事务并在事务内二次校验版本。
 */
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWritableEpisode } from './edit-access.js'
import { throwVersionConflict } from './edit-conflict.js'
import { EditWorkspaceError } from './edit-errors.js'
import {
  computeLayout,
  editSyncHashOf,
  planHashOf,
  subtitleAppearanceForPreset,
  type EditProjectSettings,
} from './edit-plan.js'
import { normalizeEditPlan } from './edit-normalize.js'
import { layoutResponse, parsePlanJson, planHashes } from './edit-response.js'
import type { EditPlanV1 } from './edit-plan.js'
import { loadEditTimelineData } from './edit-timeline-data.js'
import { buildEditTimeline, dialogPlacementsOf } from './edit-timeline.js'
import type { EditProjectRow } from './edit-project-service.js'

export function draftFor(projectId: number) {
  return db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.projectId, projectId))
    .get() ?? null
}

export function currentRevisionFor(projectId: number) {
  return db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.projectId, projectId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.editRevisions.createdAt), desc(schema.editRevisions.id))
    .get() ?? null
}

export function draftDirtyFor(projectId: number): boolean {
  const draft = draftFor(projectId)
  const revision = currentRevisionFor(projectId)
  return Boolean(draft) && (
    !revision
    || !revision.planHash
    || draft!.planHash !== revision.planHash
  )
}

/**
 * 工程当前计划（草稿优先，其次当前版本）；两者都不可解析时抛 EDIT_NO_PLAN。
 * 与 getEpisodeEditState 的读优先级一致，复用同一 parsePlanJson，不另造第二套反序列化。
 */
export function loadProjectPlan(project: EditProjectRow): EditPlanV1 {
  const raw = draftFor(project.id)?.planJson ?? currentRevisionFor(project.id)?.planJson
  const parsed = parsePlanJson(raw)
  if (!parsed) throw new EditWorkspaceError(409, 'EDIT_NO_PLAN', '工程还没有计划，无法执行该操作')
  // 存量计划（新增字段之前的版本）在此补齐默认值：导出与抽帧都以本函数为唯一读入口，
  // 否则旧计划缺 pitchSemitones/audioEffect 会被 validateEditPlan 的严格校验拦死导出
  return normalizeEditPlan(parsed, {
    episodeId: project.episodeId,
    project: projectSettingsFor(project),
  }).plan
}

function projectSettingsFor(project: EditProjectRow): EditProjectSettings {
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, project.dramaId)).get()
  const raw = drama?.aspectRatio
  const aspect = raw === '9:16' || raw === '16:9' || raw === '1:1' ? raw : '16:9'
  const width = aspect === '16:9' ? 1920 : 1080
  const height = aspect === '16:9' ? 1080 : 1920
  return {
    aspect,
    width,
    height,
    fps: 30,
    background: 'black',
    defaultFit: aspect === '16:9' ? 'fit' : 'fill',
    defaultTransition: 'cut',
    defaultSubtitleStyle: 'default',
    defaultExportPreset: aspect === '9:16' ? 'edit-vertical-hd' : 'edit-horizontal-hd',
    tailGapMs: 0,
    audioFadeInMs: 0,
    audioFadeOutMs: 0,
    subtitleAppearance: subtitleAppearanceForPreset('default'),
    subtitleSafeAreaPct: 8,
  }
}

export async function saveEditDraft(
  episodeId: number,
  project: EditProjectRow,
  input: Record<string, unknown>,
) {
  const episode = getWritableEpisode(episodeId)
  const fallback = projectSettingsFor(project)
  const { plan, issues } = normalizeEditPlan(input.plan, {
    episodeId,
    project: fallback,
  })
  const rawBaseVersion = input.base_version
  const baseVersion = typeof rawBaseVersion === 'number' ? rawBaseVersion : Number.NaN
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new EditWorkspaceError(400, 'EDIT_BASE_VERSION', '缺少有效的 base_version')
  }
  const force = input.force === true
  const before = draftFor(project.id)
  if (!force && (before?.version ?? 0) !== baseVersion) {
    throwVersionConflict(episodeId, before ?? undefined)
  }

  const ts = new Date().toISOString()
  const planJson = JSON.stringify(plan)
  const planHash = planHashOf(plan)
  const syncHash = editSyncHashOf(plan)
  const revision = currentRevisionFor(project.id)
  const result = db.transaction((tx) => {
    const live = tx.select().from(schema.episodeEditDrafts)
      .where(eq(schema.episodeEditDrafts.projectId, project.id))
      .get()
    if (!force && (live?.version ?? 0) !== baseVersion) {
      return { conflict: live ?? undefined, version: 0 }
    }
    const version = (live?.version ?? 0) + 1
    if (live) {
      tx.update(schema.episodeEditDrafts).set({
        planJson, planHash, editSyncHash: syncHash, version,
        baseRevisionId: revision?.id ?? null, updatedAt: ts,
      }).where(eq(schema.episodeEditDrafts.projectId, project.id)).run()
    } else {
      tx.insert(schema.episodeEditDrafts).values({
        episodeId: project.episodeId,
        dramaId: project.dramaId,
        projectId: project.id,
        planJson, planHash, editSyncHash: syncHash, version,
        baseRevisionId: revision?.id ?? null,
        createdAt: ts, updatedAt: ts,
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
    draft_dirty: draftDirtyFor(project.id),
  }
}

export function discardEditDraft(project: EditProjectRow) {
  getWritableEpisode(project.episodeId)
  const result = db.delete(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.projectId, project.id))
    .run()
  return { discarded: result.changes > 0 }
}
