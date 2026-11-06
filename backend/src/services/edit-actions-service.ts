import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWritableEpisode } from './edit-access.js'
import { assembleStoryboardClips } from './edit-bootstrap.js'
import { EditWorkspaceError } from './edit-errors.js'
import {
  aspectOf,
  createEmptyEditPlan,
  projectSettingsForAspect,
  type EditIssue,
  type EditPlanV1,
  type EditProjectSettings,
  type EditSubtitleCue,
} from './edit-plan.js'
import { normalizeEditPlan } from './edit-normalize.js'
import { planEnvelope, parsePlanJson } from './edit-response.js'
import { createEditRevision } from './edit-revision-service.js'
import { buildTimelineForPlan } from './edit-timeline-data.js'
import { dialogPlacementsOf, suggestSubtitles } from './edit-timeline.js'
import type { EditProjectRow } from './edit-project-service.js'

/**
 * 动作上下文（工程作用域）：基础计划按 project_id 读取草稿 → 当前版本；
 * 归一化 fallback 仍取剧集画幅（工程 settings 由旧版工程沿用剧集设置）。
 */
function actionContext(episodeId: number, project: EditProjectRow) {
  getWritableEpisode(episodeId)
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, project.dramaId))
    .get()
  const fallback = projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30)
  const draft = db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.projectId, project.id))
    .get()
  const revision = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.projectId, project.id),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.editRevisions.createdAt), desc(schema.editRevisions.id))
    .get()
  const stored = parsePlanJson(draft?.planJson) ?? parsePlanJson(revision?.planJson)
  return { project: fallback, stored }
}

function normalizeInput(
  raw: unknown,
  episodeId: number,
  project: EditProjectSettings,
) {
  return normalizeEditPlan(
    raw ?? createEmptyEditPlan(episodeId, project),
    { episodeId, project },
  )
}

function transitionBetween(fromClipId: string, toClipId: string) {
  return {
    id: `tr_rc_${fromClipId}_${toClipId}`,
    fromClipId,
    toClipId,
    type: 'dissolve' as const,
    durationMs: 500,
  }
}

export async function roughCutEditPlan(
  episodeId: number,
  project: EditProjectRow,
  input: Record<string, unknown>,
) {
  const context = actionContext(episodeId, project)
  const base = normalizeInput(input.plan ?? context.stored, episodeId, context.project)
  const mode = input.mode === 'append' ? 'append' : 'replace'
  const transition = input.transition === 'dissolve' ? 'dissolve' : 'cut'
  const assembly = await assembleStoryboardClips(episodeId, context.project, { transition })
  if (assembly.materialCount === 0) {
    throw new EditWorkspaceError(400, 'ROUGH_CUT_NO_MATERIAL', '没有可用的分镜视频')
  }

  let added = 0
  let skipped = assembly.skipped
  const issues: EditIssue[] = [...base.issues]
  let next: EditPlanV1
  if (mode === 'replace') {
    if (base.plan.subtitles.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'SUBTITLES_CLEARED',
        path: 'subtitles',
        message: '替换时间线后原字幕已清空，请重新生成字幕建议',
      })
    }
    next = {
      ...base.plan,
      clips: assembly.clips,
      transitions: assembly.transitions,
      subtitles: [],
    }
    added = assembly.materialCount
  } else {
    const existingSources = new Set(
      base.plan.clips.map((clip) => `${clip.source.kind}:${clip.source.id}`),
    )
    const appended = assembly.clips.filter(
      (clip) => !existingSources.has(`${clip.source.kind}:${clip.source.id}`),
    )
    skipped += assembly.clips.length - appended.length
    added = appended.length
    const appendedIds = new Set(appended.map((clip) => clip.id))
    const lastBase = base.plan.clips[base.plan.clips.length - 1] ?? null
    const firstAppended = appended[0] ?? null
    const mergedTransitions = [
      ...base.plan.transitions,
      ...assembly.transitions.filter(
        (item) => appendedIds.has(item.fromClipId) && appendedIds.has(item.toClipId),
      ),
    ]
    if (transition === 'dissolve' && lastBase && firstAppended) {
      mergedTransitions.push(transitionBetween(lastBase.id, firstAppended.id))
    }
    next = {
      ...base.plan,
      clips: [...base.plan.clips, ...appended],
      transitions: mergedTransitions,
    }
  }

  // 先归一化结果计划并构建时间线，确认无异常后再写“初剪前快照”：
  // 若归一化抛 EditPlanRejectedError，不能让快照版本与分集指针先行落库，
  // 否则会留下前端拿不到的版本且当前版本已被移走。
  const normalized = normalizeEditPlan(next, { episodeId, project: context.project })
  const timeline = buildTimelineForPlan(episodeId, normalized.plan)

  let snapshotRevision: ReturnType<typeof createEditRevision>['revision'] | null = null
  if (input.create_revision === true) {
    // 快照只建版本、不写草稿：本动作响应不返回 draft_version，若快照抬高草稿版本，
    // 前端随后的自动保存（始终带 base_version）会立刻 409。
    const snapshot = createEditRevision(project, {
      base_version: input.base_version,
      note: '初剪前快照',
      plan: base.plan,
      update_draft: false,
    })
    snapshotRevision = snapshot.revision
  }

  return {
    ...planEnvelope(
      normalized.plan,
      [...issues, ...assembly.warnings, ...normalized.issues],
      dialogPlacementsOf(timeline.linePlacements),
    ),
    applied: { added, skipped },
    snapshot_revision: snapshotRevision,
  }
}

export function suggestEditSubtitles(
  episodeId: number,
  project: EditProjectRow,
  input: Record<string, unknown>,
) {
  const context = actionContext(episodeId, project)
  const base = normalizeInput(input.plan ?? context.stored, episodeId, context.project)
  const mode = input.mode === 'replace' ? 'replace' : 'fill'
  const timeline = buildTimelineForPlan(episodeId, base.plan)
  const suggested = suggestSubtitles(base.plan, timeline.linePlacements)

  const cues: EditSubtitleCue[] = [...base.plan.subtitles]
  let added = 0
  let updated = 0
  let skipped = 0
  if (mode === 'replace') {
    const manual = cues.filter((cue) => cue.source !== 'line')
    updated = cues.length - manual.length
    skipped = manual.length
    cues.splice(0, cues.length, ...manual, ...suggested)
    added = suggested.length
  } else {
    const existingLines = new Set(
      cues.map((cue) => cue.lineId).filter((lineId): lineId is number => lineId != null),
    )
    for (const cue of suggested) {
      if (cue.lineId != null && existingLines.has(cue.lineId)) {
        skipped += 1
        continue
      }
      cues.push(cue)
      added += 1
      if (cue.lineId != null) existingLines.add(cue.lineId)
    }
  }

  const next: EditPlanV1 = {
    ...base.plan,
    subtitles: cues.sort(
      (left, right) => left.startMs - right.startMs
        || left.endMs - right.endMs
        || left.id.localeCompare(right.id),
    ),
  }
  const normalized = normalizeEditPlan(next, { episodeId, project: context.project })
  const resultTimeline = buildTimelineForPlan(episodeId, normalized.plan)
  return {
    ...planEnvelope(
      normalized.plan,
      [...base.issues, ...normalized.issues],
      dialogPlacementsOf(resultTimeline.linePlacements),
    ),
    added,
    updated,
    skipped,
  }
}
