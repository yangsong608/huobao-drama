/** 预览同步决策：只有源地址变化才重载，同源片段切换只按需定位，避免视频元素回到黑帧。 */
export type PreviewSyncAction = 'load' | 'seek' | 'none'

export function decidePreviewSync(
  previousSrc: string,
  nextSrc: string,
  videoMs: number,
  targetMs: number,
  toleranceMs = 120,
): PreviewSyncAction {
  if (previousSrc !== nextSrc) return 'load'
  const drift = Math.abs((Number(videoMs) || 0) - (Number(targetMs) || 0))
  return drift > Math.max(0, Number(toleranceMs) || 0) ? 'seek' : 'none'
}