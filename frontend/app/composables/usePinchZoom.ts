/**
 * 双指缩放原语：只跟踪触控指针，不阻断默认行为
 *
 * - 第一指返回 false，交给组件原有单指逻辑
 * - 第二指按下时记录初始距离/缩放/中点，回调 onChange 时给出当前中点
 * - 任一指抬起或取消后不足两指即结束；组件卸载调用 cancel
 */
import { onBeforeUnmount, readonly, ref } from 'vue'
import { clampZoom, distanceBetween, pinchScale } from '~/utils/touch'

export interface PinchFocal {
  clientX: number
  clientY: number
}

export interface PinchZoomOptions {
  min: number
  max: number
  getValue: () => number
  onChange: (next: number, focal: PinchFocal) => void
  onStart?: () => void
  onEnd?: () => void
}

interface TrackedPoint {
  x: number
  y: number
}

export function usePinchZoom(options: PinchZoomOptions) {
  const active = ref(false)
  const pointers = new Map<number, TrackedPoint>()
  const min = Number(options.min)
  const max = Number(options.max)

  let startDistance = 0
  let startZoom = min

  function track(event: PointerEvent) {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  }

  function pair(): [TrackedPoint, TrackedPoint] | null {
    const values = [...pointers.values()]
    if (values.length < 2) return null
    return [values[0], values[1]]
  }

  function midpoint(a: TrackedPoint, b: TrackedPoint): PinchFocal {
    return { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }
  }

  function finish() {
    if (!active.value) return false
    active.value = false
    pointers.clear()
    options.onEnd?.()
    return true
  }

  function onPointerDown(event: PointerEvent): boolean {
    if (event.pointerType !== 'touch') return false
    track(event)
    if (active.value) return true
    const current = pair()
    if (!current) return false
    const [first, second] = current
    startDistance = distanceBetween(first.x, first.y, second.x, second.y)
    startZoom = clampZoom(Number(options.getValue()) || 0, min, max)
    active.value = true
    options.onStart?.()
    return true
  }

  function onPointerMove(event: PointerEvent): boolean {
    if (event.pointerType !== 'touch') return false
    if (!pointers.has(event.pointerId)) return false
    track(event)
    if (!active.value) return false
    const current = pair()
    if (!current) return false
    const [first, second] = current
    const focal = midpoint(first, second)
    const ratio = pinchScale(startDistance, distanceBetween(first.x, first.y, second.x, second.y))
    options.onChange(clampZoom(startZoom * ratio, min, max), focal)
    return true
  }

  function onPointerUp(event: PointerEvent) {
    if (event.pointerType !== 'touch') return
    pointers.delete(event.pointerId)
    if (active.value && pointers.size < 2) finish()
  }

  function cancel() {
    pointers.clear()
    if (!active.value) return
    active.value = false
    options.onEnd?.()
  }

  onBeforeUnmount(cancel)

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    cancel,
    active: readonly(active),
  }
}
