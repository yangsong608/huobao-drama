/**
 * 转场预览（单播放器近似，46 种全类型）：
 * - 出场快照按类型做退场动效（透明度/位移/clip-path 裁切/mask 挖孔/缩放），保证各类型预览可区分；
 * - 入场画面在视频元素上做辅助动效（缩放/透明度），白闪/黑场用全屏遮罩曲线；
 * - 导出仍由 ffmpeg xfade 真实合成，预览只是近似。
 */
import type { EditLayout, EditPlanV1 } from './edit-plan'

export interface PreviewTransitionState {
  key: string
  transitionId: string
  type: string
  progress: number
  durationMs: number
}

export function findActiveTransition(
  plan: EditPlanV1 | null | undefined,
  layout: EditLayout | null | undefined,
  currentMs: number,
): PreviewTransitionState | null {
  const clips = layout?.clips ?? []
  const transitions = plan?.transitions ?? []
  if (clips.length < 2 || !transitions.length) return null
  const time = Number(currentMs) || 0
  for (let index = 1; index < clips.length; index += 1) {
    const prev = clips[index - 1]
    const next = clips[index]
    const overlap = Number(prev.timeline_end_ms) - Number(next.timeline_start_ms)
    if (!(overlap > 0)) continue
    const transition = transitions.find(
      (item) => item.fromClipId === prev.clip_id && item.toClipId === next.clip_id,
    )
    if (!transition) continue
    const start = Number(next.timeline_start_ms)
    if (time < start || time >= start + overlap) continue
    return {
      key: `${transition.id}:${Math.round(start)}`,
      transitionId: transition.id,
      type: transition.type,
      progress: Math.min(1, Math.max(0, (time - start) / overlap)),
      durationMs: overlap,
    }
  }
  return null
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number(value) || 0))
const pct = (value: number) => `${(clamp01(value) * 100).toFixed(2)}%`

/** 中心挖孔遮罩（circle-open / radial：孔洞扩大揭示入场画面） */
function holeMask(p: number): string {
  const edge = clamp01(p) * 150
  return `radial-gradient(circle at 50% 50%, transparent ${(edge).toFixed(2)}%, black ${(edge + 2).toFixed(2)}%)`
}

/** 出场快照退场样式：p=0 完全覆盖入场画面，p=1 完全揭示 */
export function outgoingTransitionStyle(
  type: string,
  progress: number,
): Record<string, string> {
  const p = clamp01(progress)
  switch (type) {
    case 'push-left':
    case 'smooth-left':
      return { transform: `translateX(-${pct(p)})` }
    case 'push-right':
    case 'smooth-right':
      return { transform: `translateX(${pct(p)})` }
    case 'push-up':
    case 'smooth-up':
      return { transform: `translateY(-${pct(p)})` }
    case 'push-down':
    case 'smooth-down':
      return { transform: `translateY(${pct(p)})` }
    case 'wipe-left':
      return { clipPath: `inset(0 0 0 ${pct(p)})` }
    case 'wipe-right':
      return { clipPath: `inset(0 ${pct(p)} 0 0)` }
    case 'wipe-up':
      return { clipPath: `inset(${pct(p)} 0 0 0)` }
    case 'wipe-down':
      return { clipPath: `inset(0 0 ${pct(p)} 0)` }
    case 'corner-wipe-tl':
    case 'diagonal-tl':
      return { clipPath: `polygon(${pct(p)} 0, 100% 0, 100% 100%, 0 100%, 0 ${pct(p)})` }
    case 'corner-wipe-tr':
    case 'diagonal-tr':
      return { clipPath: `polygon(0 0, ${pct(1 - p)} 0, 100% ${pct(p)}, 100% 100%, 0 100%)` }
    case 'corner-wipe-bl':
    case 'diagonal-bl':
      return { clipPath: `polygon(0 0, 100% 0, 100% 100%, ${pct(p)} 100%, 0 ${pct(1 - p)})` }
    case 'corner-wipe-br':
    case 'diagonal-br':
      return { clipPath: `polygon(0 0, 100% 0, 100% ${pct(1 - p)}, ${pct(1 - p)} 100%, 0 100%)` }
    case 'radial':
    case 'circle-open':
      return { WebkitMaskImage: holeMask(p), maskImage: holeMask(p) }
    case 'circle-close':
      return { clipPath: `circle(${((1 - p) * 75).toFixed(2)}% at 50% 50%)` }
    case 'circle-crop':
      return p < 0.5
        ? { clipPath: `circle(${((1 - 2 * p) * 75).toFixed(2)}% at 50% 50%)` }
        : { opacity: '0' }
    case 'rect-crop':
      // 值域 0–50 超出 pct 内部 clamp 范围，直接计算
      return p < 0.5
        ? { clipPath: `inset(${(p * 50).toFixed(2)}%)` }
        : { opacity: '0' }
    case 'vertical-open':
      return { transform: `scaleY(${(1 - p).toFixed(3)})` }
    case 'vertical-close':
      return { clipPath: `inset(${pct(p * 0.5)} 0 ${pct(p * 0.5)} 0)` }
    case 'horizontal-open':
      return { transform: `scaleX(${(1 - p).toFixed(3)})` }
    case 'horizontal-close':
      return { clipPath: `inset(0 ${pct(p * 0.5)} 0 ${pct(p * 0.5)})` }
    case 'slice-hl':
      return { clipPath: `inset(0 0 0 ${pct(p)})`, transform: `skewX(${((1 - p) * -14).toFixed(2)}deg)` }
    case 'slice-hr':
      return { clipPath: `inset(0 ${pct(p)} 0 0)`, transform: `skewX(${((1 - p) * 14).toFixed(2)}deg)` }
    case 'slice-vu':
      return { clipPath: `inset(${pct(p)} 0 0 0)`, transform: `skewY(${((1 - p) * -10).toFixed(2)}deg)` }
    case 'slice-vd':
      return { clipPath: `inset(0 0 ${pct(p)} 0)`, transform: `skewY(${((1 - p) * 10).toFixed(2)}deg)` }
    case 'squeeze-h':
      return p < 0.5 ? { transform: `scaleX(${(1 - 2 * p).toFixed(3)})` } : { opacity: '0' }
    case 'squeeze-v':
      return p < 0.5 ? { transform: `scaleY(${(1 - 2 * p).toFixed(3)})` } : { opacity: '0' }
    case 'black':
      return { opacity: (1 - Math.min(1, p * 2)).toFixed(3) }
    case 'zoom-in':
      return { opacity: (1 - p).toFixed(3) }
    case 'gray-fade':
      return { opacity: (1 - p).toFixed(3), filter: `grayscale(${p.toFixed(3)})` }
    case 'blur':
      return { opacity: (1 - p).toFixed(3), filter: `blur(${(p * 10).toFixed(2)}px)` }
    case 'pixelize':
      return { opacity: (1 - p).toFixed(3), filter: `blur(${(p * 14).toFixed(2)}px) contrast(${(1 + p * 0.4).toFixed(2)})` }
    default:
      // fade 家族（dissolve/white/grain/fast/slow/distance）
      return { opacity: (1 - p).toFixed(3) }
  }
}

/** 入场画面（视频元素）辅助样式；多数类型由快照层承担，无需动效 */
export function incomingTransitionStyle(
  type: string,
  progress: number,
): Record<string, string> {
  const p = clamp01(progress)
  if (type === 'zoom-in') {
    return {
      transform: `scale(${(0.35 + 0.65 * p).toFixed(3)})`,
      opacity: Math.min(1, p * 1.4).toFixed(3),
    }
  }
  if (type === 'squeeze-h' && p >= 0.5) return { transform: `scaleX(${(2 * p - 1).toFixed(3)})` }
  if (type === 'squeeze-v' && p >= 0.5) return { transform: `scaleY(${(2 * p - 1).toFixed(3)})` }
  if ((type === 'circle-crop' || type === 'rect-crop') && p >= 0.5) {
    const grow = 2 * p - 1
    return { transform: `scale(${(0.5 + 0.5 * grow).toFixed(3)})` }
  }
  if (type === 'black') return { opacity: Math.max(0, 2 * p - 1).toFixed(3) }
  return {}
}

/** 白闪遮罩：中点最亮，两端无遮罩 */
export function whiteFlashOpacity(type: string, progress: number): number {
  if (type !== 'white') return 0
  const p = clamp01(progress)
  return Number((1 - Math.abs(1 - 2 * p)).toFixed(3))
}

/** 黑场遮罩：中点最暗，两端无遮罩 */
export function blackFlashOpacity(type: string, progress: number): number {
  if (type !== 'black') return 0
  const p = clamp01(progress)
  return Number((1 - Math.abs(1 - 2 * p)).toFixed(3))
}
