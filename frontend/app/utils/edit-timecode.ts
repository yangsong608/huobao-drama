function pad(value: number, size = 2): string {
  return String(Math.max(0, Math.floor(value))).padStart(size, '0')
}

export function formatPrecise(ms: number): string {
  const total = Math.max(0, Math.round(Number(ms) || 0))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const millis = total % 1000
  const body = `${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`
  return hours > 0 ? `${pad(hours)}:${body}` : body
}

export function frameDurationMs(fps: number): number {
  const value = Number(fps)
  return 1000 / (Number.isFinite(value) && value > 0 ? value : 30)
}

export function snapToFrame(ms: number, fps: number): number {
  const frame = frameDurationMs(fps)
  return Math.round((Number(ms) || 0) / frame) * frame
}

export function msToFrames(ms: number, fps: number): number {
  return Math.round((Number(ms) || 0) / frameDurationMs(fps))
}

export function framesToMs(frames: number, fps: number): number {
  return Math.round((Number(frames) || 0) * frameDurationMs(fps))
}
