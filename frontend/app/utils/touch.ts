/**
 * 触控交互纯函数：交互目标识别、长按判定、双指距离与缩放夹取
 *
 * - 不读取 DOM / Vue，服务端与 Node 测试可直接导入求值
 * - 长按阈值统一来自 tablet-layout，避免组件散落魔法数
 */

import { LONG_PRESS_MS, LONG_PRESS_MOVE_PX } from './tablet-layout.ts'

export interface InteractiveLike {
  tagName?: string
  type?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

/** 交互元素选择器：长按不得在这些元素内启动 */
export const INTERACTIVE_SELECTOR = 'input, textarea, select, button, a[href], [contenteditable="true"], [role="textbox"], [role="button"], [role="slider"], [role="combobox"]'

const INTERACTIVE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'])

/**
 * 判断指针目标是否为交互元素。
 * 提供 closest 时以选择器命中为准；否则按 tagName / isContentEditable 回退。
 */
export function isInteractiveTarget(target: InteractiveLike | null | undefined): boolean {
  if (!target) return false
  if (typeof target.closest === 'function') {
    try {
      return Boolean(target.closest(INTERACTIVE_SELECTOR))
    } catch {
      // 非 DOM 实现的 closest 抛错时退回标签判断，避免中断长按流程
    }
  }
  if (target.isContentEditable) return true
  return INTERACTIVE_TAGS.has(String(target.tagName || '').toUpperCase())
}

/** 长按判定：按住 >= 500ms 且位移 <= 8px；等于 8px 仍然有效 */
export function shouldTriggerLongPress(heldMs: number, movedPx: number): boolean {
  return heldMs >= LONG_PRESS_MS && movedPx <= LONG_PRESS_MOVE_PX
}

/** 两点欧氏距离（client 坐标） */
export function distanceBetween(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1)
}

/** 双指缩放比例：初始距离非法或为 0 时返回 1，避免除零/NaN 污染缩放值 */
export function pinchScale(startDistance: number, currentDistance: number): number {
  if (!Number.isFinite(startDistance) || !Number.isFinite(currentDistance)) return 1
  if (startDistance <= 0 || currentDistance <= 0) return 1
  return currentDistance / startDistance
}

/** 缩放夹取：非法值回退到 min，再收敛到 [min, max] */
export function clampZoom(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}
