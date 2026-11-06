// 与 backend/src/services/edit-render-plan.ts 的 buildRenderReport 保持同名 code；
// 后端是权威，前端仅用于导出前预览降级清单（设计 6.10 支持范围表）。
import type { EditPlanV1 } from './edit-plan'

export interface ExportWarning { code: string, i18nKey: string }

const WARNINGS: Record<string, string> = {
  TRANSITION_HARD_CUT: 'edit.exportWarnTransition',
  FILTER_UNSUPPORTED: 'edit.exportWarnFilter',
  TRANSFORM_UNSUPPORTED: 'edit.exportWarnTransform',
  OVERLAY_UNSUPPORTED: 'edit.exportWarnOverlay',
  SPEED_CLAMPED: 'edit.exportWarnSpeed',
}

export function collectExportWarnings(plan: EditPlanV1): ExportWarning[] {
  const codes: string[] = []
  if (plan.transitions?.length) codes.push('TRANSITION_HARD_CUT')
  if (plan.clips.some((clip) => clip.filter?.preset && clip.filter.preset !== 'none')) {
    codes.push('FILTER_UNSUPPORTED')
  }
  if (plan.clips.some((clip) => clip.transform
    && (clip.transform.scale !== 1 || clip.transform.x !== 0 || clip.transform.y !== 0))) {
    codes.push('TRANSFORM_UNSUPPORTED')
  }
  if (plan.overlays?.length) codes.push('OVERLAY_UNSUPPORTED')
  if (plan.clips.some((clip) => (Number(clip.speed) || 1) < 0.5 || (Number(clip.speed) || 1) > 2)) {
    codes.push('SPEED_CLAMPED')
  }
  return codes.map((code) => ({ code, i18nKey: WARNINGS[code] }))
}
