/**
 * 剪辑工作台聚合服务（S2）。
 * 只读优先级：草稿 → 当前版本 →（on）分镜多片段 bootstrap →（on）合片 → 成片 → 空计划。
 * readonly/off 只使用已有草稿/版本或成片，绝不写库。
 */
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  aspectOf,
  computeLayout,
  dialogueSyncHashOf,
  projectSettingsForAspect,
  validateEditPlan,
  type EditIssue,
} from './edit-plan.js'
import { getReadableEpisode } from './edit-access.js'
import { bootstrapEditPlan, hasStoryboardMedia } from './edit-bootstrap.js'
import { layoutResponse, parsePlanJson, planHashes, revisionResponse } from './edit-response.js'
import { buildTimelineForPlan, placementsResponse } from './edit-timeline-data.js'
import { dialogPlacementsOf } from './edit-timeline.js'

/** 草稿读取：episode_id 上有唯一索引，每集最多一行。 */
function loadDraft(episodeId: number) {
  return db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
    .get()
}

/** 当前版本读取：首次加载与 bootstrap 后重载共用同一排序，保证读到同一行。 */
function loadCurrentRevision(episodeId: number) {
  return db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.episodeId, episodeId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.editRevisions.createdAt), desc(schema.editRevisions.id))
    .get()
}

export async function getEpisodeEditState(episodeId: number) {
  // 404（分集不存在）先于 403（开关关闭）返回，顺序与文案由 getReadableEpisode 保证。
  const { episode, mode } = getReadableEpisode(episodeId)

  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId))
    .get()

  let draft = loadDraft(episodeId)
  let revision = loadCurrentRevision(episodeId)

  const warnings: EditIssue[] = []
  let plan = parsePlanJson(draft?.planJson)
  if (draft && !plan) {
    warnings.push({
      severity: 'warning',
      code: 'DRAFT_INVALID',
      path: 'draft.plan_json',
      message: '草稿计划损坏，已忽略',
    })
  }
  let revisionPlan = parsePlanJson(revision?.planJson)
  if (revision && !revisionPlan) {
    warnings.push({
      severity: 'warning',
      code: 'REVISION_INVALID',
      path: 'revision.plan_json',
      message: '版本计划损坏，已忽略',
    })
  }
  if (!plan) plan = revisionPlan

  if (!plan) {
    const project = projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30)
    const bootstrap = await bootstrapEditPlan({
      episodeId: episode.id,
      dramaId: episode.dramaId,
      project,
      mode,
      episodeVideoUrl: episode.videoUrl,
      warnings,
    })
    plan = bootstrap.plan
    // 分镜 bootstrap 可能新建版本，也可能在并发首读时复用已落库的版本；
    // 两种情况都带有版本 id，必须重新读取，否则会错误地报告 current_revision: null。
    if (bootstrap.initializedRevisionId) {
      draft = loadDraft(episodeId)
      revision = loadCurrentRevision(episodeId)
      revisionPlan = parsePlanJson(revision?.planJson)
    }
  } else {
    warnings.push(...validateEditPlan(plan))
  }

  const timeline = buildTimelineForPlan(episodeId, plan)
  const placements = timeline.linePlacements
  const dialogueHash = dialogueSyncHashOf(dialogPlacementsOf(placements))
  for (const item of timeline.unmappedLines) {
    warnings.push({
      severity: 'warning',
      code: 'LINE_UNMAPPED',
      path: `line:${item.lineId}`,
      message: `台词未映射到片段（${item.reason}）`,
    })
  }

  const layout = computeLayout(plan)
  const hashes = {
    ...planHashes(plan, dialogPlacementsOf(placements)),
    dialogue_sync_hash: dialogueHash,
  }

  const draftDirty = draft !== undefined && (
    !revision
    || !revision.planHash
    || draft.planHash !== revision.planHash
  )

  const mixRevision = db.select().from(schema.mixRevisions)
    .where(and(
      eq(schema.mixRevisions.episodeId, episodeId),
      eq(schema.mixRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.mixRevisions.createdAt))
    .get()

  const mixReasons: string[] = []
  if (mixRevision) {
    if (!mixRevision.editSyncHash) mixReasons.push('legacy_mix')
    else if (mixRevision.editSyncHash !== hashes.edit_sync_hash) mixReasons.push('timing_changed')
    if (mixRevision.dialogueSyncHash && mixRevision.dialogueSyncHash !== dialogueHash) {
      mixReasons.push('dialogue_changed')
    }
  }

  const lockRow = db.select().from(schema.episodeLocks)
    .where(eq(schema.episodeLocks.episodeId, episodeId))
    .get()
  const lock = lockRow && Date.parse(lockRow.expiresAt) > Date.now()
    ? { kind: lockRow.kind, owner: lockRow.owner, expires_at: lockRow.expiresAt }
    : null

  const singleSource = plan.clips.length === 1 && plan.clips[0].source.kind === 'episode-video'
    ? plan.clips[0]
    : null
  const audio = singleSource
    ? { mode: 'video' as const, url: singleSource.source.url, duration_ms: layout.durationMs }
    : { mode: 'none' as const }

  return {
    episode_id: episode.id,
    episode_number: episode.episodeNumber,
    enabled: true,
    mode,
    draft: draft
      ? {
          plan: parsePlanJson(draft.planJson),
          version: draft.version,
          updated_at: draft.updatedAt,
        }
      : null,
    current_revision: revision ? revisionResponse(revision) : null,
    current_revision_plan: revisionPlan,
    plan,
    layout: layoutResponse(layout),
    hashes,
    draft_dirty: draftDirty,
    mix_status: {
      status: !mixRevision ? 'missing' : mixReasons.length ? 'stale' : 'aligned',
      reasons: mixReasons,
      edit_revision_id: revision?.id ?? null,
      mix_revision_id: mixRevision?.id ?? null,
      summary: null,
    },
    renders: { cut: null, audio_ref: null },
    audio,
    media_warnings: warnings.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path,
    })),
    line_placements: placementsResponse(placements),
    rough_cut_available: hasStoryboardMedia(episodeId),
    capabilities: {
      can_edit: mode === 'on',
      can_export: false,
      lock,
    },
  }
}
