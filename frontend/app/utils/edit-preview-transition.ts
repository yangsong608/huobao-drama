/**
 * 转场预览（单播放器近似）：
 * - 每次切到转场窗口时抓一帧出场画面，作为快照叠在视频上方退场；
 * - 入场画面按类型淡入 / 位移 / 模糊，白闪额外叠一层白色遮罩；
 * - 导出仍由 ffmpeg xfade/acrossfade 真实合成，预览只是近似。
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

/** 入场画面样式（当前视频元素） */
export function incomingTransitionStyle(
  type: string,
  progress: number,
): Record<string, string> {
  const p = Math.min(1, Math.max(0, Number(progress) || 0))
  if (type === 'push-left') return { transform: `translateX(${((1 - p) * 100).toFixed(2)}%)` }
  if (type === 'blur') {
    return {
      filter: `blur(${((1 - p) * 10).toFixed(2)}px)`,
      opacity: (0.35 + 0.65 * p).toFixed(3),
    }
  }
  if (type === 'dissolve') return { opacity: (0.35 + 0.65 * p).toFixed(3) }
  return {}
}

/** 出场快照样式（叠在视频上方） */
export function outgoingTransitionStyle(
  type: string,
  progress: number,
): Record<string, string> {
  const p = Math.min(1, Math.max(0, Number(progress) || 0))
  if (type === 'push-left') return { transform: `translateX(${(-p * 100).toFixed(2)}%)` }
  if (type === 'blur') {
    return {
      filter: `blur(${(p * 10).toFixed(2)}px)`,
      opacity: (1 - p).toFixed(3),
    }
  }
  if (type === 'white') return { opacity: (1 - p).toFixed(3) }
  return { opacity: (1 - p).toFixed(3) }
}

/** 白闪遮罩不透明度；其他转场为 0 */
export function whiteFlashOpacity(type: string, progress: number): number {
  if (type !== 'white') return 0
  const p = Math.min(1, Math.max(0, Number(progress) || 0))
  return Number((1 - p).toFixed(3))
}