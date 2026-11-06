import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  buildEditTimeline,
  type EditLinePlacement,
  type EditLineRow,
  type EditTakeRow,
  type EditTimelineResult,
} from './edit-timeline.js'
import type { EditPlanV1 } from './edit-plan.js'

export function loadEditTimelineData(episodeId: number): {
  lines: EditLineRow[]
  takes: EditTakeRow[]
} {
  const lines = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .all()
    .map((row): EditLineRow => ({
      id: row.id,
      storyboardId: row.storyboardId,
      lineNo: row.lineNo,
      sortOrder: row.sortOrder,
      text: row.text,
      subtitleText: row.subtitleText,
      speakerName: row.speakerName,
      speakerType: row.speakerType,
      voiceId: row.voiceId,
      voiceStartMs: row.voiceStartMs,
      voiceDurationMs: row.voiceDurationMs,
      audioUrl: row.audioUrl,
      audioDurationMs: row.audioDurationMs,
      activeTakeId: row.activeTakeId,
      anchorType: row.anchorType,
    }))

  const takes = db.select().from(schema.lineTakes)
    .where(and(
      eq(schema.lineTakes.episodeId, episodeId),
      isNull(schema.lineTakes.deletedAt),
    ))
    .all()
    .map((row): EditTakeRow => ({
      id: row.id,
      lineId: row.lineId,
      audioUrl: row.audioUrl,
      durationMs: row.durationMs,
      hash: row.hash,
      isActive: Boolean(row.isActive),
    }))

  return { lines, takes }
}

export function buildTimelineForPlan(
  episodeId: number,
  plan: EditPlanV1,
): EditTimelineResult {
  const { lines, takes } = loadEditTimelineData(episodeId)
  return buildEditTimeline(plan, lines, takes)
}

export interface EditLinePlacementResponse {
  line_id: number
  clip_id: string
  storyboard_id: number | null
  start_ms: number
  end_ms: number
  duration_ms: number
  text: string
  subtitle_text: string | null
  speaker_name: string | null
  voice_take_id: number | null
  audio_url: string | null
  audio_fingerprint: string | null
  overflows_clip: boolean
  overflow_ms: number
  anchor_type: 'shot' | 'absolute'
  warnings: string[]
}

export function placementsResponse(placements: EditLinePlacement[]): EditLinePlacementResponse[] {
  return placements.map((item) => ({
    line_id: item.lineId,
    clip_id: item.clipId,
    storyboard_id: item.storyboardId,
    start_ms: item.startMs,
    end_ms: item.endMs,
    duration_ms: item.durationMs,
    text: item.text,
    subtitle_text: item.subtitleText,
    speaker_name: item.speakerName,
    voice_take_id: item.voiceTakeId,
    audio_url: item.audioUrl,
    audio_fingerprint: item.audioFingerprint,
    overflows_clip: item.overflowsClip,
    overflow_ms: item.overflowMs,
    anchor_type: item.anchorType,
    warnings: item.warnings,
  }))
}
