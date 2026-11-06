/**
 * 不可变剪辑版本（S2 Task 6）：列表、详情、创建与恢复。
 * - 写闸门（off/readonly 403）先于计划归一化与任何写行；
 * - 新版本号 = 该集最大 revision_no + 1；
 * - 清除其他 is_current、插入新版本、同步草稿、更新分集指针在同一
 *   BEGIN IMMEDIATE 事务内完成，事务内二次校验草稿版本；
 * - 恢复 = 以旧版本计划创建新版本，旧行保持不可变。
 */
import { and, desc, eq, max } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getReadableEpisode, getWritableEpisode } from './edit-access.js'
import { throwVersionConflict } from './edit-conflict.js'
import { EditWorkspaceError } from './edit-errors.js'
import {
  aspectOf,
  computeLayout,
  editSyncHashOf,
  planHashOf,
  projectSettingsForAspect,
  renderHashOf,
  type EditProjectSettings,
} from './edit-plan.js'
import { normalizeEditPlan } from './edit-normalize.js'
import { parsePlanJson, revisionResponse } from './edit-response.js'

function projectFor(episode: typeof schema.episodes.$inferSelect): EditProjectSettings {
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId))
    .get()
  return projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30)
}

function draftOf(episodeId: number) {
  return db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
    .get()
}

/** 当前版本读取：与 edit-service.ts 同一 canonical 排序（createdAt desc, id desc）。 */
function currentRevisionOf(episodeId: number) {
  return db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.episodeId, episodeId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.editRevisions.createdAt), desc(schema.editRevisions.id))
    .get()
}

function dirtyOf(episodeId: number): boolean {
  const draft = draftOf(episodeId)
  const revision = currentRevisionOf(episodeId)
  return Boolean(draft) && (
    !revision
    || !revision.planHash
    || draft!.planHash !== revision.planHash
  )
}

function planOrThrow(raw: unknown, episodeId: number, project: EditProjectSettings) {
  if (raw == null) {
    throw new EditWorkspaceError(400, 'EDIT_PLAN_INVALID', '没有可保存的计划')
  }
  return normalizeEditPlan(raw, { episodeId, project })
}

export function listEditRevisions(episodeId: number) {
  getReadableEpisode(episodeId)
  const items = db.select().from(schema.editRevisions)
    .where(eq(schema.editRevisions.episodeId, episodeId))
    .orderBy(desc(schema.editRevisions.revisionNo), desc(schema.editRevisions.id))
    .all()
    .map(revisionResponse)
  return { items }
}

export function getEditRevision(episodeId: number, revisionId: number) {
  getReadableEpisode(episodeId)
  const row = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.id, revisionId),
      eq(schema.editRevisions.episodeId, episodeId),
    ))
    .get()
  if (!row) throw new EditWorkspaceError(404, 'EDIT_REVISION_NOT_FOUND', '剪辑版本不存在')
  const plan = parsePlanJson(row.planJson)
  if (!plan) throw new EditWorkspaceError(500, 'EDIT_REVISION_CORRUPT', '版本计划损坏')
  return { revision: revisionResponse(row), plan }
}

export function createEditRevision(
  episodeId: number,
  input: Record<string, unknown>,
) {
  // 写闸门先跑：off/readonly 直接 403，不归一化计划、不写任何行。
  const episode = getWritableEpisode(episodeId)
  const project = projectFor(episode)
  const draft = draftOf(episodeId)
  const current = currentRevisionOf(episodeId)

  const source = input.plan
    ?? parsePlanJson(draft?.planJson)
    ?? parsePlanJson(current?.planJson)
  const { plan } = planOrThrow(source, episodeId, project)
  const force = input.force === true
  const baseVersion = input.base_version === undefined || input.base_version === null
    ? null
    : Number(input.base_version)
  if (baseVersion !== null && (!Number.isSafeInteger(baseVersion) || baseVersion < 0)) {
    throw new EditWorkspaceError(400, 'EDIT_BASE_VERSION', '缺少有效的 base_version')
  }
  if (!force && baseVersion !== null && (draft?.version ?? 0) !== baseVersion) {
    throwVersionConflict(episodeId, draft)
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
      .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
      .get()
    if (!force && baseVersion !== null && (liveDraft?.version ?? 0) !== baseVersion) {
      return { conflict: liveDraft ?? null, revision: null, draftVersion: null }
    }
    const maxRow = tx.select({ value: max(schema.editRevisions.revisionNo) })
      .from(schema.editRevisions)
      .where(eq(schema.editRevisions.episodeId, episodeId))
      .get()
    const revisionNo = Number(maxRow?.value ?? 0) + 1

    tx.update(schema.editRevisions)
      .set({ isCurrent: false })
      .where(and(
        eq(schema.editRevisions.episodeId, episodeId),
        eq(schema.editRevisions.isCurrent, true),
      ))
      .run()
    const inserted = tx.insert(schema.editRevisions).values({
      episodeId,
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

    tx.update(schema.episodes).set({
      editRevisionId: inserted.id,
      editPlanHash: planHash,
      editSyncHash: syncHash,
      editEnabled: true,
      updatedAt: ts,
    }).where(eq(schema.episodes.id, episodeId)).run()

    let draftVersion = liveDraft?.version ?? null
    if (updateDraft) {
      draftVersion = (liveDraft?.version ?? 0) + 1
      if (liveDraft) {
        tx.update(schema.episodeEditDrafts).set({
          planJson,
          planHash,
          editSyncHash: syncHash,
          version: draftVersion,
          baseRevisionId: inserted.id,
          updatedAt: ts,
        }).where(eq(schema.episodeEditDrafts.episodeId, episodeId)).run()
      } else {
        tx.insert(schema.episodeEditDrafts).values({
          episodeId,
          dramaId: episode.dramaId,
          planJson,
          planHash,
          editSyncHash: syncHash,
          version: draftVersion,
          baseRevisionId: inserted.id,
          createdAt: ts,
          updatedAt: ts,
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
    draft_dirty: dirtyOf(episodeId),
  }
}

export function restoreEditRevision(
  episodeId: number,
  revisionId: number,
  input: Record<string, unknown>,
) {
  getWritableEpisode(episodeId)
  const row = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.id, revisionId),
      eq(schema.editRevisions.episodeId, episodeId),
    ))
    .get()
  if (!row) throw new EditWorkspaceError(404, 'EDIT_REVISION_NOT_FOUND', '剪辑版本不存在')
  const plan = parsePlanJson(row.planJson)
  if (!plan) throw new EditWorkspaceError(500, 'EDIT_REVISION_CORRUPT', '版本计划损坏')
  return createEditRevision(episodeId, {
    plan,
    base_version: input.base_version,
    note: `恢复自版本 v${row.revisionNo}`,
    update_draft: true,
  })
}
