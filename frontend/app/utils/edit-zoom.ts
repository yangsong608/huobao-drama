/**
 * 剪辑时间线缩放纯函数（P7）
 *
 * - 剪辑时间线保留自己的 0.25–8 缩放域，不套用混音时间线的 px/s 口径
 * - 双指缩放按焦点锚定滚动位置：焦点下的时间在缩放前后保持不动
 * - 不读 DOM/window，Node 可直接 import
 */

export const EDIT_ZOOM_MIN = 0.25
export const EDIT_ZOOM_MAX = 8

/** 非有限值返回 1，其余夹取到 [0.25, 8] */
export function clampEditZoom(value: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return Math.min(EDIT_ZOOM_MAX, Math.max(EDIT_ZOOM_MIN, numeric))
}

export interface AnchoredScrollInput {
  scrollLeft: number
  focalX: number
  padPx: number
  ratio: number
}

/**
 * 焦点锚定后的横向滚动位置。
 * 正确公式：(scrollLeft + focalX - padPx) * ratio + padPx - focalX
 * 结果非有限或 <0 时回退到 Math.max(0, scrollLeft)；比率非有限时同样回退。
 */
export function anchoredScrollLeft(input: AnchoredScrollInput): number {
  const scrollLeft = Number(input.scrollLeft)
  const focalX = Number(input.focalX)
  const padPx = Number(input.padPx)
  const ratio = Number(input.ratio)
  const fallback = Math.max(0, Number.isFinite(scrollLeft) ? scrollLeft : 0)
  if (!Number.isFinite(ratio) || !Number.isFinite(focalX) || !Number.isFinite(padPx)) {
    return fallback
  }
  const next = (scrollLeft + focalX - padPx) * ratio + padPx - focalX
  if (!Number.isFinite(next) || next < 0) return fallback
  return next
}
