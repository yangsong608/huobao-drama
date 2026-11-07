// 与 backend/src/services/edit-render-plan.ts 的 buildRenderReport / blockingFeaturesOf 保持同名 code；
// 后端是权威，前端仅用于导出前预览阻断清单与降级清单（设计 6.5/6.10 支持范围表）。
import type { EditPlanV1 } from './edit-plan'

export interface ExportIssue { code: string, path: string, i18nKey: string }
export interface ExportWarning { code: string, i18nKey: string }
export interface ExportCheck { blocking: ExportIssue[], warnings: ExportWarning[] }

const WARNINGS: Record<string, string> = {
  TRANSITION_HARD_CUT: 'edit.exportWarnTransition',
  FILTER_UNSUPPORTED: 'edit.exportWarnFilter',
  TRANSFORM_UNSUPPORTED: 'edit.exportWarnTransform',
  OVERLAY_UNSUPPORTED: 'edit.exportWarnOverlay',
  SPEED_CLAMPED: 'edit.exportWarnSpeed',
}

export function collectExportWarnings(plan: EditPlanV1): ExportCheck {
  const blocking: ExportIssue[] = []
  plan.overlays?.forEach((_overlay, index) => {
    blocking.push({
      code: 'OVERLAY_UNSUPPORTED',
      path: `overlays[${index}]`,
      i18nKey: 'edit.exportBlocked.overlay',
    })
  })
  plan.clips.forEach((clip, index) => {
    if (clip.filter?.preset && clip.filter.preset !== 'none') {
      blocking.push({
        code: 'FILTER_UNSUPPORTED',
        path: `clips[${index}].filter`,
        i18nKey: 'edit.exportBlocked.filter',
      })
    }
    if (clip.transform
      && (clip.transform.scale !== 1 || clip.transform.x !== 0 || clip.transform.y !== 0)) {
      blocking.push({
        code: 'TRANSFORM_UNSUPPORTED',
        path: `clips[${index}].transform`,
        i18nKey: 'edit.exportBlocked.transform',
      })
    }
    const speed = Number(clip.speed) || 1
    if (speed < 0.5 || speed > 2) {
      blocking.push({
        code: 'SPEED_UNSUPPORTED',
        path: `clips[${index}].speed`,
        i18nKey: 'edit.exportBlocked.speed',
      })
    }
  })
  plan.transitions?.forEach((_transition, index) => {
    blocking.push({
      code: 'TRANSITION_UNSUPPORTED',
      path: `transitions[${index}]`,
      i18nKey: 'edit.exportBlocked.transition',
    })
  })

  const warnings: ExportWarning[] = []
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
  for (const code of codes) warnings.push({ code, i18nKey: WARNINGS[code] })
  return { blocking, warnings }
}
