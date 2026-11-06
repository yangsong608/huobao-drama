import type { EditClip, EditLayout, EditPlanV1 } from './edit-plan'

export function localClipContentDurationMs(clip: EditClip): number {
  const speed = Number(clip.speed)
  if (!Number.isFinite(speed) || speed <= 0) return 0
  return Math.max(0, Math.round((Number(clip.sourceOutMs) - Number(clip.sourceInMs)) / speed))
}

export function computeLocalLayout(plan: EditPlanV1): EditLayout {
  const clips: EditLayout['clips'] = []
  const transitions: EditLayout['transitions'] = []
  let cursor = 0

  plan.clips.forEach((clip, index) => {
    const content = localClipContentDurationMs(clip)
    const previous = index === 0 ? null : plan.clips[index - 1]
    const transition = previous
      ? plan.transitions.find(
        (item) => item.fromClipId === previous.id && item.toClipId === clip.id,
      )
      : undefined
    const overlap = transition ? Math.max(0, Number(transition.durationMs) || 0) : 0
    const gap = Math.max(0, Number(clip.gapBeforeMs) || 0)
    const start = index === 0 ? gap : cursor - overlap + gap
    const end = start + content
    clips.push({
      clip_id: clip.id,
      timeline_start_ms: start,
      timeline_end_ms: end,
      content_duration_ms: content,
    })
    if (transition && overlap > 0) {
      transitions.push({
        id: transition.id,
        from_clip_id: previous!.id,
        to_clip_id: clip.id,
        overlap_ms: overlap,
      })
    }
    cursor = end
  })

  const contentEnd = clips.length ? clips[clips.length - 1].timeline_end_ms : 0
  const overlayEnd = plan.overlays.reduce((max, overlay) => Math.max(max, overlay.endMs), 0)
  return {
    content_end_ms: contentEnd,
    duration_ms: Math.max(contentEnd, overlayEnd) + Math.max(0, Number(plan.project.tailGapMs) || 0),
    clips,
    transitions,
  }
}

export function activeClipIndex(layout: EditLayout, timeMs: number): number {
  if (!layout.clips.length) return -1
  const time = Math.max(0, Number(timeMs) || 0)
  let index = 0
  for (let cursor = 0; cursor < layout.clips.length; cursor += 1) {
    if (time >= layout.clips[cursor].timeline_start_ms) index = cursor
    else break
  }
  return index
}

export function findLayoutClip(layout: EditLayout, clipId: string | null | undefined) {
  if (!clipId) return null
  return layout.clips.find((item) => item.clip_id === clipId) ?? null
}

export function clipTimelineOffsetMs(
  layout: EditLayout,
  clipId: string,
  timeMs: number,
): number {
  const clip = findLayoutClip(layout, clipId)
  if (!clip) return 0
  return Math.max(
    0,
    Math.min(clip.content_duration_ms, (Number(timeMs) || 0) - clip.timeline_start_ms),
  )
}

export function sourceTimeAt(
  plan: EditPlanV1,
  layout: EditLayout,
  timeMs: number,
): number {
  const index = activeClipIndex(layout, timeMs)
  if (index < 0) return 0
  const clip = plan.clips[index]
  const layoutClip = layout.clips[index]
  const offset = Math.max(
    0,
    Math.min(layoutClip.content_duration_ms, (Number(timeMs) || 0) - layoutClip.timeline_start_ms),
  )
  const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1
  return Math.round(Number(clip.sourceInMs) + offset * speed)
}

export function timelineTimeForSource(
  plan: EditPlanV1,
  layout: EditLayout,
  clipId: string,
  sourceMs: number,
): number {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) return 0
  const clip = plan.clips[index]
  const layoutClip = layout.clips[index]
  if (!layoutClip) return 0
  const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1
  const offset = (Number(sourceMs) - Number(clip.sourceInMs)) / speed
  return Math.round(
    layoutClip.timeline_start_ms
      + Math.max(0, Math.min(layoutClip.content_duration_ms, offset)),
  )
}
