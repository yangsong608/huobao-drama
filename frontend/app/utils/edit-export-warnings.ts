// 与 backend/src/services/edit-render-plan.ts 的 buildRenderReport 保持同名 code；
// 后端是权威，前端仅用于导出前预览降级清单（设计 6.10 支持范围表）。
import type { EditPlanV1 } from './edit-plan'
import { MAX_TRANSITION_MS, MIN_TRANSITION_MS } from './edit-plan.ts'
import { isSupportedTransitionType } from './edit-transition-types.ts'

export interface ExportWarning { code: string, i18nKey: string }

const WARNINGS: Record<string, string> = {
  TRANSITION_HARD_CUT: 'edit.exportWarnTransition',
  SPEED_CLAMPED: 'edit.exportWarnSpeed',
}

export function collectExportWarnings(plan: EditPlanV1): ExportWarning[] {
  const codes: string[] = []
  const clipIndex = new Map(plan.clips.map((clip, index) => [clip.id, index]))
  const hasHardCutTransition = plan.transitions?.some((transition) => {
    const from = clipIndex.get(transition.fromClipId)
    const to = clipIndex.get(transition.toClipId)
    return from === undefined
      || to !== from + 1
      || !isSupportedTransitionType(transition.type)
      || Number(plan.clips[to].gapBeforeMs) > 0
      || Number(transition.durationMs) < MIN_TRANSITION_MS
      || Number(transition.durationMs) > MAX_TRANSITION_MS
  }) ?? false
  if (hasHardCutTransition) codes.push('TRANSITION_HARD_CUT')
  if (plan.clips.some((clip) => (Number(clip.speed) || 1) < 0.25 || (Number(clip.speed) || 1) > 4)) {
    codes.push('SPEED_CLAMPED')
  }
  return codes.map((code) => ({ code, i18nKey: WARNINGS[code] }))
}
