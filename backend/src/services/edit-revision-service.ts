/**
 * 不可变剪辑版本（工程作用域）：版本号按工程自增；恢复 = 以旧计划建新版本。
 * episodes 指针只在被改工程是当前打开工程时同步。
 */
import { and, desc, eq, max } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWritableEpisode } from './edit-access.js'
import { throwVersionConflict } from './edit-conflict.js'
import { EditWorkspaceError } from './edit-errors.js'
import {
  aspectOf,
  computeLayout,
  editSyncHashOf,
  planHashOf,
  renderHashOf,
  subtitleAppearanceForPreset,
  type EditProjectSettings,
} from './edit-plan.js'
import { normalizeEditPlan } from './edit-normalize.js'
import { parsePlanJson, revisionResponse } from './edit-response.js'
import { currentRevisionFor, draftDirtyFor, draftFor } from './edit-draft-service.js'
import type { EditProjectRow } from './edit-project-service.js'

export function listEditRevisions(project: EditProjectRow) {
  const items = db.select().from(schema.editRevisions)
    .where(eq(schema.editRevisions.projectId, project.id))
    .orderBy(desc(schema.editRevisions.revisionNo), desc(schema.editRevisions.id))
    .all()
    .map((row) => ({ ...revisionResponse(row), project_id: row.projectId }))
  return { items }
}

export function getEditRevision(project: EditProjectRow, revisionId: number) {
  const row = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.id, revisionId),
      eq(schema.editRevisions.projectId, project.id),
    ))
    .get()
  if (!row) throw new EditWorkspaceError(404, 'EDIT_REVISION_NOT_FOUND', '剪辑版本不存在')
  const plan = parsePlanJson(row.planJson)
  if (!plan) throw new EditWorkspaceError(500, 'EDIT_REVISION_CORRUPT', '版本计划损坏')
  return { revision: revisionResponse(row), plan }
}

function fallbackSettingsOf(project: EditProjectRow): EditProjectSettings {
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, project.dramaId)).get()
  const raw = drama?.aspectRatio
  const aspect = raw === '9:16' || raw === '16:9' || raw === '1:1' ? raw : '16:9'
  return {
    aspect,
    width: aspect === '16:9' ? 1920 : 1080,
    height: aspect === '16:9' ? 1080 : 1920,
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

export function createEditRevision(
  project: EditProjectRow,
  input: Record<string, unknown>,
) {
  const episodeId = project.episodeId
  getWritableEpisode(episodeId)
  const fallback = fallbackSettingsOf(project)
  const draft = draftFor(project.id)
  const current = currentRevisionFor(project.id)

  const source = input.plan
    ?? parsePlanJson(draft?.planJson)
    ?? parsePlanJson(current?.planJson)
  if (source == null) {
    throw new EditWorkspaceError(400, 'EDIT_PLAN_INVALID', '没有可保存的计划')
  }
  const { plan } = normalizeEditPlan(source, { episodeId, project: fallback })
  const force = input.force === true
  const baseVersion = input.base_version === undefined || input.base_version === null
    ? null
    : Number(input.base_version)
  if (baseVersion !== null && (!Number.isSafeInteger(baseVersion) || baseVersion < 0)) {
    throw new EditWorkspaceError(400, 'EDIT_BASE_VERSION', '缺少有效的 base_version')
  }
  if (!force && baseVersion !== null && (draft?.version ?? 0) !== baseVersion) {
    throwVersionConflict(episodeId, draft ?? undefined)
  }

  const updateDraft = input.update_draft !== false
  const note = typeof input.note === 'string' && input.note.trim()
    ? input.note.trim().slice(0, 200)
    : null
  const ts = new Date().toISOString()
  const planJson = JSON.stringify(plan)
  const planHash = planHashOf(plan)
  const syncHash = editSyncHashOf(plan)
  const layout = computeLayout(plan)

  const result = db.transaction((tx) => {
    const liveDraft = tx.select().from(schema.episodeEditDrafts)
      .where(eq(schema.episodeEditDrafts.projectId, project.id))
      .get()
    if (!force && baseVersion !== null && (liveDraft?.version ?? 0) !== baseVersion) {
      return { conflict: liveDraft ?? null, revision: null, draftVersion: null }
    }
    const maxRow = tx.select({ value: max(schema.editRevisions.revisionNo) })
      .from(schema.editRevisions)
      .where(eq(schema.editRevisions.projectId, project.id))
      .get()
    const revisionNo = Number(maxRow?.value ?? 0) + 1

    tx.update(schema.editRevisions)
      .set({ isCurrent: false })
      .where(and(
        eq(schema.editRevisions.projectId, project.id),
        eq(schema.editRevisions.isCurrent, true),
      ))
      .run()
    const inserted = tx.insert(schema.editRevisions).values({
      episodeId,
      projectId: project.id,
      revisionNo,
      planJson,
      planHash,
      editSyncHash: syncHash,
      renderHash: renderHashOf(plan),
      durationMs: layout.durationMs,
      clipCount: plan.clips.length,
      note,
      isCurrent: true,
      createdAt: ts,
    }).returning().get()

    const episode = tx.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId)).get()
    if (episode?.editProjectId === project.id) {
      tx.update(schema.episodes).set({
        editRevisionId: inserted.id,
        editPlanHash: planHash,
        editSyncHash: syncHash,
        editEnabled: true,
        updatedAt: ts,
      }).where(eq(schema.episodes.id, episodeId)).run()
    }

    let draftVersion = liveDraft?.version ?? null
    if (updateDraft) {
      draftVersion = (liveDraft?.version ?? 0) + 1
      if (liveDraft) {
        tx.update(schema.episodeEditDrafts).set({
          planJson, planHash, editSyncHash: syncHash, version: draftVersion,
          baseRevisionId: inserted.id, updatedAt: ts,
        }).where(eq(schema.episodeEditDrafts.projectId, project.id)).run()
      } else {
        tx.insert(schema.episodeEditDrafts).values({
          episodeId,
          dramaId: project.dramaId,
          projectId: project.id,
          planJson, planHash, editSyncHash: syncHash, version: draftVersion,
          baseRevisionId: inserted.id, createdAt: ts, updatedAt: ts,
        }).run()
      }
    }
    return { conflict: null, revision: inserted, draftVersion }
  }, { behavior: 'immediate' })

  if (result.conflict !== null || !result.revision) {
    throwVersionConflict(episodeId, result.conflict ?? undefined)
  }

  return {
    revision: revisionResponse(result.revision),
    draft_version: result.draftVersion,
    draft_dirty: draftDirtyFor(project.id),
  }
}

export function restoreEditRevision(
  project: EditProjectRow,
  revisionId: number,
  input: Record<string, unknown>,
) {
  getWritableEpisode(project.episodeId)
  const row = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.id, revisionId),
      eq(schema.editRevisions.projectId, project.id),
    ))
    .get()
  if (!row) throw new EditWorkspaceError(404, 'EDIT_REVISION_NOT_FOUND', '剪辑版本不存在')
  const plan = parsePlanJson(row.planJson)
  if (!plan) throw new EditWorkspaceError(500, 'EDIT_REVISION_CORRUPT', '版本计划损坏')
  return createEditRevision(project, {
    plan,
    base_version: input.base_version,
    note: `恢复自版本 v${row.revisionNo}`,
    update_draft: true,
  })
}
