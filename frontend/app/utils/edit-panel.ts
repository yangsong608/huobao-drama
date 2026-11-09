/**
 * 剪辑工作台抽屉纯函数（P7）
 *
 * - 三个抽屉（素材 / 检查器 / 字幕）互斥，只用一个名字表示当前抽屉
 * - 不读 DOM/window，Node 可直接 import
 */

export type EditDrawerName = 'media' | 'inspector' | 'subtitles'

/** 点同一个抽屉返回 null（关闭），点另一个返回新抽屉，当前为 null 返回 requested */
export function nextDrawer(
  current: EditDrawerName | null,
  requested: EditDrawerName,
): EditDrawerName | null {
  if (current === requested) return null
  return requested
}

/** 当前抽屉是否是指定名字 */
export function isDrawerOpen(current: EditDrawerName | null, name: EditDrawerName): boolean {
  return current === name
}

/** 检查器底部抽屉高度（dvh）：默认 55，非有限值回退 55，夹取到 [min, max] */
export function clampInspectorDrawerVh(value: number, min = 35, max = 80): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 55
  return Math.min(max, Math.max(min, numeric))
}
