export const DEFAULT_TRANSITION_MS = 1000

export type EditTransitionCategory =
  | 'basic'
  | 'slide'
  | 'wipe'
  | 'open-close'
  | 'zoom-squeeze'
  | 'slice-diag'
  | 'effect'

export const TRANSITION_CATEGORIES = [
  { value: 'basic', labelKey: 'edit.transitionCatBasic' },
  { value: 'slide', labelKey: 'edit.transitionCatSlide' },
  { value: 'wipe', labelKey: 'edit.transitionCatWipe' },
  { value: 'open-close', labelKey: 'edit.transitionCatOpenClose' },
  { value: 'zoom-squeeze', labelKey: 'edit.transitionCatZoomSqueeze' },
  { value: 'slice-diag', labelKey: 'edit.transitionCatSliceDiag' },
  { value: 'effect', labelKey: 'edit.transitionCatEffect' },
] as const

/** 与 backend XFADE_BY_TYPE 的 46 种转场一一对应 */
export const TRANSITION_TYPES = [
  { value: 'dissolve', labelKey: 'edit.transitionDissolve', category: 'basic' },
  { value: 'white', labelKey: 'edit.transitionWhite', category: 'basic' },
  { value: 'black', labelKey: 'edit.transitionBlack', category: 'basic' },
  { value: 'grain-dissolve', labelKey: 'edit.transitionGrainDissolve', category: 'basic' },
  { value: 'fast-fade', labelKey: 'edit.transitionFastFade', category: 'basic' },
  { value: 'slow-fade', labelKey: 'edit.transitionSlowFade', category: 'basic' },
  { value: 'distance-fade', labelKey: 'edit.transitionDistanceFade', category: 'basic' },
  { value: 'gray-fade', labelKey: 'edit.transitionGrayFade', category: 'basic' },
  { value: 'push-left', labelKey: 'edit.transitionPushLeft', category: 'slide' },
  { value: 'push-right', labelKey: 'edit.transitionPushRight', category: 'slide' },
  { value: 'push-up', labelKey: 'edit.transitionPushUp', category: 'slide' },
  { value: 'push-down', labelKey: 'edit.transitionPushDown', category: 'slide' },
  { value: 'smooth-left', labelKey: 'edit.transitionSmoothLeft', category: 'slide' },
  { value: 'smooth-right', labelKey: 'edit.transitionSmoothRight', category: 'slide' },
  { value: 'smooth-up', labelKey: 'edit.transitionSmoothUp', category: 'slide' },
  { value: 'smooth-down', labelKey: 'edit.transitionSmoothDown', category: 'slide' },
  { value: 'wipe-left', labelKey: 'edit.transitionWipeLeft', category: 'wipe' },
  { value: 'wipe-right', labelKey: 'edit.transitionWipeRight', category: 'wipe' },
  { value: 'wipe-up', labelKey: 'edit.transitionWipeUp', category: 'wipe' },
  { value: 'wipe-down', labelKey: 'edit.transitionWipeDown', category: 'wipe' },
  { value: 'corner-wipe-tl', labelKey: 'edit.transitionCornerWipeTl', category: 'wipe' },
  { value: 'corner-wipe-tr', labelKey: 'edit.transitionCornerWipeTr', category: 'wipe' },
  { value: 'corner-wipe-bl', labelKey: 'edit.transitionCornerWipeBl', category: 'wipe' },
  { value: 'corner-wipe-br', labelKey: 'edit.transitionCornerWipeBr', category: 'wipe' },
  { value: 'radial', labelKey: 'edit.transitionRadial', category: 'wipe' },
  { value: 'vertical-open', labelKey: 'edit.transitionVerticalOpen', category: 'open-close' },
  { value: 'vertical-close', labelKey: 'edit.transitionVerticalClose', category: 'open-close' },
  { value: 'horizontal-open', labelKey: 'edit.transitionHorizontalOpen', category: 'open-close' },
  { value: 'horizontal-close', labelKey: 'edit.transitionHorizontalClose', category: 'open-close' },
  { value: 'circle-open', labelKey: 'edit.transitionCircleOpen', category: 'open-close' },
  { value: 'circle-close', labelKey: 'edit.transitionCircleClose', category: 'open-close' },
  { value: 'circle-crop', labelKey: 'edit.transitionCircleCrop', category: 'open-close' },
  { value: 'rect-crop', labelKey: 'edit.transitionRectCrop', category: 'open-close' },
  { value: 'zoom-in', labelKey: 'edit.transitionZoomIn', category: 'zoom-squeeze' },
  { value: 'squeeze-h', labelKey: 'edit.transitionSqueezeH', category: 'zoom-squeeze' },
  { value: 'squeeze-v', labelKey: 'edit.transitionSqueezeV', category: 'zoom-squeeze' },
  { value: 'slice-hl', labelKey: 'edit.transitionSliceHl', category: 'slice-diag' },
  { value: 'slice-hr', labelKey: 'edit.transitionSliceHr', category: 'slice-diag' },
  { value: 'slice-vu', labelKey: 'edit.transitionSliceVu', category: 'slice-diag' },
  { value: 'slice-vd', labelKey: 'edit.transitionSliceVd', category: 'slice-diag' },
  { value: 'diagonal-tl', labelKey: 'edit.transitionDiagonalTl', category: 'slice-diag' },
  { value: 'diagonal-tr', labelKey: 'edit.transitionDiagonalTr', category: 'slice-diag' },
  { value: 'diagonal-bl', labelKey: 'edit.transitionDiagonalBl', category: 'slice-diag' },
  { value: 'diagonal-br', labelKey: 'edit.transitionDiagonalBr', category: 'slice-diag' },
  { value: 'blur', labelKey: 'edit.transitionBlur', category: 'effect' },
  { value: 'pixelize', labelKey: 'edit.transitionPixelize', category: 'effect' },
] as const satisfies readonly { value: string; labelKey: string; category: EditTransitionCategory }[]

/** 检查器快捷网格：每类挑最常用的代表，全量走转场库 */
export const COMMON_TRANSITION_TYPES = [
  'dissolve', 'white', 'black', 'push-left', 'wipe-left', 'zoom-in', 'blur', 'circle-open',
] as const

export function transitionsByCategory(category: EditTransitionCategory) {
  return TRANSITION_TYPES.filter((option) => option.category === category)
}

export function transitionTypeOption(type: string) {
  return TRANSITION_TYPES.find((option) => option.value === type) ?? null
}

export function isSupportedTransitionType(type: string): boolean {
  return TRANSITION_TYPES.some((item) => item.value === type)
}
