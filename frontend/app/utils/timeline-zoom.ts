export const TIMELINE_ZOOM_MIN = 1
export const TIMELINE_ZOOM_MAX = 240
export const TIMELINE_END_PADDING = 160

export function fitTimelineZoom(viewportWidth: number, durationMs: number): number {
  const seconds = Number.isFinite(durationMs) ? durationMs / 1000 : 0
  const available = Number.isFinite(viewportWidth) ? viewportWidth - TIMELINE_END_PADDING : 0
  if (seconds <= 0 || available <= 0) return TIMELINE_ZOOM_MIN
  const zoom = Math.floor((available / seconds) * 100) / 100
  return Math.min(TIMELINE_ZOOM_MAX, Math.max(TIMELINE_ZOOM_MIN, zoom))
}