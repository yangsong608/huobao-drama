/** 与 backend buildClipFilterChain 同语义的滤镜预设表；cssFilterFor 供预览端近似渲染 */
export const FILTER_PRESETS = [
  { value: 'none', labelKey: 'edit.filterNone' },
  { value: 'clear', labelKey: 'edit.filterClear' },
  { value: 'warm', labelKey: 'edit.filterWarm' },
  { value: 'cool', labelKey: 'edit.filterCool' },
  { value: 'cinematic', labelKey: 'edit.filterCinematic' },
  { value: 'mono', labelKey: 'edit.filterMono' },
  { value: 'vintage', labelKey: 'edit.filterVintage' },
] as const

export function isSupportedFilterPreset(preset: string): boolean {
  return FILTER_PRESETS.some((item) => item.value === preset)
}

/** CSS filter 近似（强度 0–100 线性缩放；导出端 ffmpeg eq/colorbalance 为权威） */
export function cssFilterFor(preset: string, intensity: number): string {
  const k = Math.max(0, Math.min(100, Math.round(Number(intensity) || 0))) / 100
  if (!k || preset === 'none') return ''
  switch (preset) {
    case 'clear':
      return `brightness(${(1 + 0.02 * k).toFixed(3)}) saturate(${(1 + 0.15 * k).toFixed(3)}) contrast(${(1 + 0.06 * k).toFixed(3)})`
    case 'warm':
      return `saturate(${(1 + 0.1 * k).toFixed(3)}) contrast(${(1 + 0.05 * k).toFixed(3)}) sepia(${(0.25 * k).toFixed(3)})`
    case 'cool':
      return `saturate(${(1 + 0.08 * k).toFixed(3)}) contrast(${(1 + 0.05 * k).toFixed(3)}) hue-rotate(${(12 * k).toFixed(2)}deg)`
    case 'cinematic':
      return `contrast(${(1 + 0.14 * k).toFixed(3)}) saturate(${(1 - 0.08 * k).toFixed(3)})`
    case 'mono':
      return `grayscale(${k.toFixed(3)}) contrast(${(1 + 0.08 * k).toFixed(3)})`
    case 'vintage':
      return `sepia(${(0.35 * k).toFixed(3)}) saturate(${(1 - 0.25 * k).toFixed(3)}) contrast(${(1 - 0.05 * k).toFixed(3)}) brightness(${(1 + 0.03 * k).toFixed(3)})`
    default:
      return ''
  }
}

/** 变换的 CSS transform 近似：缩放 + 画布比例位移 + 旋转 + 翻转 */
export function cssTransformFor(transform) {
  if (!transform) return ''
  const scale = Math.max(0.5, Math.min(2, Number(transform.scale) || 1))
  const x = Math.max(-1, Math.min(1, Number(transform.x) || 0))
  const y = Math.max(-1, Math.min(1, Number(transform.y) || 0))
  const rotation = Number(transform.rotation) || 0
  const parts = []
  if (x || y) parts.push(`translate(${(x * 100).toFixed(1)}%, ${(y * 100).toFixed(1)}%)`)
  if (scale !== 1) parts.push(`scale(${scale.toFixed(2)})`)
  if (rotation) parts.push(`rotate(${rotation}deg)`)
  if (transform.flipH) parts.push('scaleX(-1)')
  if (transform.flipV) parts.push('scaleY(-1)')
  return parts.join(' ')
}
