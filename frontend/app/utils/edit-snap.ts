import type { EditLayout, EditPlanV1 } from './edit-plan'

export type EditSnapKind = 'zero' | 'clip-start' | 'clip-end' | 'cue-start' | 'cue-end' | 'playhead'

export interface EditSnapPoint {
  ms: number
  kind: EditSnapKind
}

export function collectSnapPoints(
  plan: EditPlanV1,
  layout: EditLayout,
  playheadMs = 0,
): EditSnapPoint[] {
  const points: EditSnapPoint[] = [{ ms: 0, kind: 'zero' }]
  for (const clip of layout.clips) {
    points.push({ ms: clip.timeline_start_ms, kind: 'clip-start' })
    points.push({ ms: clip.timeline_end_ms, kind: 'clip-end' })
  }
  for (const cue of plan.subtitles) {
    points.push({ ms: cue.startMs, kind: 'cue-start' })
    points.push({ ms: cue.endMs, kind: 'cue-end' })
  }
  points.push({ ms: Math.max(0, Math.round(playheadMs) || 0), kind: 'playhead' })
  const seen = new Set<string>()
  return points
    .sort((left, right) => left.ms - right.ms)
    .filter((point) => {
      const key = `${point.ms}:${point.kind}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function snapTime(
  valueMs: number,
  points: EditSnapPoint[],
  thresholdMs = 60,
): { ms: number; point: EditSnapPoint | null } {
  const value = Number(valueMs) || 0
  let best: EditSnapPoint | null = null
  let distance = Number.POSITIVE_INFINITY
  for (const point of points) {
    const current = Math.abs(point.ms - value)
    if (current <= thresholdMs && current < distance) {
      best = point
      distance = current
    }
  }
  return { ms: best ? best.ms : Math.round(value), point: best }
}
