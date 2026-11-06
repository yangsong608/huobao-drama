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

/** 字幕时间显示：mm:ss.mmm（超过 1 小时为 h:mm:ss.mmm），与 formatPrecise 同口径 */
export const formatClockMs = formatPrecise

/** 解析 mm:ss.mmm / h:mm:ss.mmm / 纯毫秒数字为毫秒；无法解析时返回 NaN */
export function parseClockMs(text: string): number {
  const raw = String(text ?? '').trim()
  if (!raw) return Number.NaN
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw))
  const parts = raw.split(':')
  if (parts.length < 2 || parts.length > 3) return Number.NaN
  let total = 0
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$/.test(part.trim())) return Number.NaN
  }
  for (const part of parts.slice(0, -1)) {
    total = (total + Number(part.trim())) * 60
  }
  const last = Number(parts[parts.length - 1].trim())
  return Math.round((total + last) * 1000)
}
