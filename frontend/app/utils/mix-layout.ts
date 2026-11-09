/**
 * 混音工作台平板布局纯函数（P8）
 *
 * 断点、命中区与 DPR 封顶只在这里定义一次，MixStage / MixTimeline 与单元测试共用。
 * 不读 DOM / window，Node 与服务端可直接 import：
 * - 抽屉判定：容器 ≤900，或短横屏（宽 ≤1180 且高 ≤700）
 * - 片段边缘命中：粗指针 22px、桌面 7px，且不超过片段宽度的三分之一
 * - 波形 DPR：平板封顶 2，桌面 Retina 保持原值
 * - 缩放锚点滚动：不为负，非法输入回落而非 NaN
 */
import { TABLET_MAX } from './tablet-layout.ts'

/** 容器 ≤900 时检查器改为右侧抽屉 */
export const MIX_CONTAINER_DRAWER_MAX = 900
/** 短横屏判定高度上限（宽仍受 TABLET_MAX 约束） */
export const MIX_SHORT_LANDSCAPE_MAX_HEIGHT = 700
/** 平板波形画布的 DPR 上限，避免大画布叠加高分屏过载 */
export const MIX_DPR_MAX = 2

export interface MixViewportInput {
  viewportWidth: number
  viewportHeight: number
  containerWidth: number
}

/** 短横屏：视口宽在平板档内且高度不超过 700 */
export function isShortLandscape(viewportWidth: number, viewportHeight: number): boolean {
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)) return false
  return viewportWidth > 0 && viewportWidth <= TABLET_MAX
    && viewportHeight > 0 && viewportHeight <= MIX_SHORT_LANDSCAPE_MAX_HEIGHT
}

/** 紧凑容器：视口仍是平板档，且工作台自身宽度 ≤900 */
export function isCompactMixContainer(viewportWidth: number, containerWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(containerWidth)) return false
  return viewportWidth > 0 && viewportWidth <= TABLET_MAX
    && containerWidth > 0 && containerWidth <= MIX_CONTAINER_DRAWER_MAX
}

/** 检查器是否改右侧抽屉：容器紧凑或短横屏 */
export function shouldUseInspectorDrawer(input: MixViewportInput): boolean {
  return isCompactMixContainer(input.viewportWidth, input.containerWidth)
    || isShortLandscape(input.viewportWidth, input.viewportHeight)
}

/**
 * 选中片段时是否自动打开抽屉。
 * 只认容器紧凑：短横屏但容器 >900 时空间够三栏，交给顶部检查器按钮。
 */
export function shouldAutoOpenInspectorDrawer(input: { viewportWidth: number; containerWidth: number }): boolean {
  return isCompactMixContainer(input.viewportWidth, input.containerWidth)
}

/** 片段起止边的命中宽度：粗指针 22px / 桌面 7px，最多片段宽度的三分之一 */
export function mixEdgeHitPx(clipWidth: number, coarse: boolean): number {
  const width = Number.isFinite(clipWidth) && clipWidth > 0 ? clipWidth : 1
  return Math.min(coarse ? 22 : 7, Math.max(1, width) / 3)
}

/** 波形画布 DPR：平板封顶 2，桌面保持原值；非法值回退 1 */
export function capWaveformDpr(raw: number, viewportWidth: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1
  if (Number.isFinite(viewportWidth) && viewportWidth > 0 && viewportWidth <= TABLET_MAX) {
    return Math.min(raw, MIX_DPR_MAX)
  }
  return raw
}

/** 缩放后按时间锚点还原横向滚动：Math.max(0, timeSec * zoom - offsetX) */
export function mixAnchoredScrollLeft(timeSec: number, zoom: number, offsetX: number): number {
  const time = Number.isFinite(timeSec) ? timeSec : 0
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const offset = Number.isFinite(offsetX) ? offsetX : 0
  return Math.max(0, time * scale - offset)
}
