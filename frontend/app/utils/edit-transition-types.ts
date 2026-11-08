export const DEFAULT_TRANSITION_MS = 600

/** 与 backend XFADE_BY_TYPE 的 16 种转场一一对应 */
export const TRANSITION_TYPES = [
  { value: 'dissolve', labelKey: 'edit.transitionDissolve' },
  { value: 'white', labelKey: 'edit.transitionWhite' },
  { value: 'black', labelKey: 'edit.transitionBlack' },
  { value: 'push-left', labelKey: 'edit.transitionPushLeft' },
  { value: 'push-right', labelKey: 'edit.transitionPushRight' },
  { value: 'push-up', labelKey: 'edit.transitionPushUp' },
  { value: 'push-down', labelKey: 'edit.transitionPushDown' },
  { value: 'wipe-left', labelKey: 'edit.transitionWipeLeft' },
  { value: 'wipe-right', labelKey: 'edit.transitionWipeRight' },
  { value: 'wipe-up', labelKey: 'edit.transitionWipeUp' },
  { value: 'wipe-down', labelKey: 'edit.transitionWipeDown' },
  { value: 'blur', labelKey: 'edit.transitionBlur' },
  { value: 'circle-open', labelKey: 'edit.transitionCircleOpen' },
  { value: 'circle-close', labelKey: 'edit.transitionCircleClose' },
  { value: 'radial', labelKey: 'edit.transitionRadial' },
  { value: 'pixelize', labelKey: 'edit.transitionPixelize' },
] as const

export function isSupportedTransitionType(type: string): boolean {
  return TRANSITION_TYPES.some((item) => item.value === type)
}
