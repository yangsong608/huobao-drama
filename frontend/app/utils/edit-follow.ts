import type {
  EditLayout,
  EditPlanV1,
  EditSubtitleCue,
} from './edit-plan'

export function cueFollowRange(
  cue: EditSubtitleCue,
  layout: EditLayout,
): { startMs: number; endMs: number } | null {
  if (!cue.follow || !cue.anchor) return null
  const target = layout.clips.find((clip) => clip.clip_id === cue.anchor!.clipId)
  if (!target) return null
  const duration = Math.max(100, cue.endMs - cue.startMs)
  let startMs = target.timeline_start_ms + Math.max(0, cue.anchor.offsetMs)
  let endMs = startMs + duration
  if (startMs < target.timeline_start_ms) startMs = target.timeline_start_ms
  if (endMs > target.timeline_end_ms) endMs = target.timeline_end_ms
  if (endMs <= startMs) {
    startMs = target.timeline_start_ms
    endMs = Math.min(target.timeline_end_ms, startMs + 100)
  }
  return { startMs, endMs }
}

export function syncFollowedCues(plan: EditPlanV1, layout: EditLayout): EditPlanV1 {
  return {
    ...plan,
    subtitles: plan.subtitles.map((cue) => {
      const range = cueFollowRange(cue, layout)
      if (!range) return cue
      return {
        ...cue,
        startMs: Math.round(range.startMs),
        endMs: Math.round(range.endMs),
      }
    }),
  }
}

export function migrateCueAnchorsForSplit(
  plan: EditPlanV1,
  sourceClipId: string,
  splitOffsetMs: number,
  secondClipId: string,
): EditPlanV1 {
  return {
    ...plan,
    subtitles: plan.subtitles.map((cue) => {
      if (cue.anchor?.clipId !== sourceClipId) return cue
      if (cue.anchor.offsetMs < splitOffsetMs) return cue
      return {
        ...cue,
        anchor: {
          clipId: secondClipId,
          offsetMs: Math.max(0, Math.round(cue.anchor.offsetMs - splitOffsetMs)),
        },
      }
    }),
  }
}

export function shiftCueAnchors(
  plan: EditPlanV1,
  clipId: string,
  deltaMs: number,
): EditPlanV1 {
  return {
    ...plan,
    subtitles: plan.subtitles.map((cue) => {
      if (cue.anchor?.clipId !== clipId) return cue
      return {
        ...cue,
        anchor: {
          clipId,
          offsetMs: Math.max(0, Math.round(cue.anchor.offsetMs - deltaMs)),
        },
      }
    }),
  }
}

export function scaleCueAnchorsForSpeed(
  plan: EditPlanV1,
  clipId: string,
  oldSpeed: number,
  newSpeed: number,
): EditPlanV1 {
  const from = Number(oldSpeed) > 0 ? Number(oldSpeed) : 1
  const to = Number(newSpeed) > 0 ? Number(newSpeed) : 1
  return {
    ...plan,
    subtitles: plan.subtitles.map((cue) => {
      if (cue.anchor?.clipId !== clipId) return cue
      return {
        ...cue,
        anchor: {
          clipId,
          offsetMs: Math.max(0, Math.round((cue.anchor.offsetMs * from) / to)),
        },
      }
    }),
  }
}
