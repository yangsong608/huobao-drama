import { schema } from '../db/index.js'
import {
  computeLayout,
  dialogueSyncHashOf,
  editSyncHashOf,
  planHashOf,
  renderHashOf,
  subtitleHashOf,
  type DialoguePlacement,
  type EditIssue,
  type EditLayout,
  type EditPlanV1,
} from './edit-plan.js'

export type EditRevisionRow = typeof schema.editRevisions.$inferSelect

export function parsePlanJson(raw: string | null | undefined): EditPlanV1 | null {
  if (!raw) return null
  try {
    const plan = JSON.parse(raw) as EditPlanV1
    if (!plan || plan.version !== 1 || !plan.project || !Array.isArray(plan.clips)) return null
    return {
      ...plan,
      transitions: Array.isArray(plan.transitions) ? plan.transitions : [],
      subtitles: Array.isArray(plan.subtitles) ? plan.subtitles : [],
      overlays: Array.isArray(plan.overlays) ? plan.overlays : [],
      markers: Array.isArray(plan.markers) ? plan.markers : [],
    }
  } catch {
    return null
  }
}

export function layoutResponse(layout: EditLayout) {
  return {
    content_end_ms: layout.contentEndMs,
    duration_ms: layout.durationMs,
    clips: layout.clips.map((clip) => ({
      clip_id: clip.clipId,
      timeline_start_ms: clip.timelineStartMs,
      timeline_end_ms: clip.timelineEndMs,
      content_duration_ms: clip.contentDurationMs,
    })),
    transitions: layout.transitions.map((transition) => ({
      id: transition.id,
      from_clip_id: transition.fromClipId,
      to_clip_id: transition.toClipId,
      overlap_ms: transition.overlapMs,
    })),
  }
}

export function planHashes(plan: EditPlanV1, placements: DialoguePlacement[] = []) {
  return {
    plan_hash: planHashOf(plan),
    render_hash: renderHashOf(plan),
    edit_sync_hash: editSyncHashOf(plan),
    dialogue_sync_hash: dialogueSyncHashOf(placements),
    subtitle_hash: subtitleHashOf(plan),
  }
}

export function revisionResponse(row: EditRevisionRow) {
  return {
    id: row.id,
    revision_no: row.revisionNo,
    note: row.note,
    duration_ms: row.durationMs,
    clip_count: row.clipCount,
    plan_hash: row.planHash,
    edit_sync_hash: row.editSyncHash,
    created_at: row.createdAt,
    is_current: row.isCurrent,
  }
}

export function planEnvelope(
  plan: EditPlanV1,
  issues: EditIssue[],
  placements: DialoguePlacement[] = [],
) {
  return {
    plan,
    layout: layoutResponse(computeLayout(plan)),
    hashes: planHashes(plan, placements),
    issues,
  }
}
