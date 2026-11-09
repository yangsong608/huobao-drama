/**
 * 长按原语：只对触控生效，鼠标/触控笔完全不受影响
 *
 * - 按下不 preventDefault，不阻断纵向滚动
 * - 位移 / 抬起 / 取消 / 滚动 / 失焦 / 页面隐藏都会取消计时器
 * - 触发后以捕获阶段吞掉下一次 click，避免长按后误触行选择或卡片点击
 * - onContextMenu 只在本轮触控长按期间阻止浏览器菜单，鼠标右键保持原样
 */
import { onBeforeUnmount, onMounted, readonly, ref } from 'vue'
import { LONG_PRESS_MS, LONG_PRESS_MOVE_PX } from '~/utils/tablet-layout'
import {
  distanceBetween,
  INTERACTIVE_SELECTOR,
  isInteractiveTarget,
  type InteractiveLike,
} from '~/utils/touch'

export interface LongPressOptions<T = unknown> {
  onTrigger: (payload: T, event: PointerEvent) => void
  delay?: number
  movePx?: number
}

interface PressState<T> {
  pointerId: number
  startX: number
  startY: number
  payload: T | undefined
  downEvent: PointerEvent
  timer: ReturnType<typeof setTimeout>
}

/** 触发后吞掉 click 的最长等待时间 */
const CLICK_SUPPRESS_MS = 700

export function useLongPress<T = unknown>(options: LongPressOptions<T>) {
  const active = ref(false)
  const delay = Math.max(0, Number(options.delay ?? LONG_PRESS_MS) || 0)
  const movePx = Math.max(0, Number(options.movePx ?? LONG_PRESS_MOVE_PX) || 0)

  let press: PressState<T> | null = null
  let lastPointerWasTouch = false
  // 长按刚触发的时刻：供 onContextMenu 判断是否属于本轮手势
  let longPressFiredAt = 0
  let suppressClickUntil = 0
  let suppressTimer: ReturnType<typeof setTimeout> | null = null
  let clickSuppressorAttached = false
  // 长按表面本身：只有落在它内部的兼容 click 才吞掉，菜单/其它区域的点击正常放行
  let suppressSurface: Element | null = null

  /**
   * 长按表面自身可能带 button / role=button（镜头行、影片卡片按钮），
   * 这种情况下命中表面本身不算交互元素；表面内部真正的按钮/输入仍然拦截。
   */
  function isBlockedByInteractiveTarget(event: PointerEvent): boolean {
    const target = event.target as InteractiveLike | null
    if (!isInteractiveTarget(target)) return false
    const surface = event.currentTarget as Element | null
    if (!surface || typeof target?.closest !== 'function') return true
    const matched = target.closest(INTERACTIVE_SELECTOR) as Element | null
    return !(matched && matched === surface && surface.hasAttribute('data-long-press'))
  }

  function clearPressTimer() {
    if (!press) return
    clearTimeout(press.timer)
    press = null
  }

  function detachClickSuppressor() {
    if (!clickSuppressorAttached) return
    clickSuppressorAttached = false
    window.removeEventListener('click', onSuppressedClick, true)
  }

  function releaseSuppression() {
    if (suppressTimer) {
      clearTimeout(suppressTimer)
      suppressTimer = null
    }
    suppressClickUntil = 0
    suppressSurface = null
    active.value = false
    detachClickSuppressor()
  }

  /**
   * 捕获阶段吞掉长按后的下一次 click。
   * 仅当点击仍落在长按表面内部时才拦截；用户点菜单或别处代表新意图，必须放行。
   */
  function onSuppressedClick(event: Event) {
    if (Date.now() > suppressClickUntil) {
      releaseSuppression()
      return
    }
    const surface = suppressSurface
    const target = event.target as Node | null
    let insideSurface = false
    if (surface && target && typeof surface.contains === 'function') {
      try {
        insideSurface = surface.contains(target)
      } catch {
        insideSurface = false
      }
    }
    if (!insideSurface) {
      // 不在长按表面内（菜单/其他区域）：不拦截，让其正常执行第一下点击
      releaseSuppression()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    releaseSuppression()
  }

  function attachClickSuppressor() {
    suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS
    if (!clickSuppressorAttached) {
      clickSuppressorAttached = true
      window.addEventListener('click', onSuppressedClick, true)
    }
    if (suppressTimer) clearTimeout(suppressTimer)
    suppressTimer = setTimeout(releaseSuppression, CLICK_SUPPRESS_MS)
  }

  function cancel() {
    clearPressTimer()
    releaseSuppression()
  }

  function fire() {
    const state = press
    if (!state) return
    press = null
    longPressFiredAt = Date.now()
    active.value = true
    attachClickSuppressor()
    options.onTrigger(state.payload as T, state.downEvent)
  }

  function onPointerDown(event: PointerEvent, payload?: T) {
    lastPointerWasTouch = event.pointerType === 'touch'
    if (event.pointerType !== 'touch') return
    cancel()
    if (isBlockedByInteractiveTarget(event)) return
    const surface = event.currentTarget as Element | null
    suppressSurface = surface && typeof surface.contains === 'function' ? surface : null
    const timer = setTimeout(fire, delay)
    press = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      payload,
      downEvent: event,
      timer,
    }
  }

  function onContextMenu(event: Event) {
    if (!lastPointerWasTouch) return
    // 仅本轮触控长按进行中或刚触发时拦截；单纯手指按下不再拦截
    const inWindow = press !== null || Date.now() - longPressFiredAt <= CLICK_SUPPRESS_MS
    if (inWindow) event.preventDefault()
  }

  function onWindowPointerMove(event: PointerEvent) {
    if (!press) return
    // 第二根手指参与时直接取消长按，交给双指手势
    if (event.pointerId !== press.pointerId) {
      clearPressTimer()
      active.value = false
      return
    }
    if (distanceBetween(press.startX, press.startY, event.clientX, event.clientY) > movePx) {
      clearPressTimer()
      active.value = false
    }
  }

  function onWindowPointerUp(event: PointerEvent) {
    if (!press || event.pointerId !== press.pointerId) return
    clearPressTimer()
  }

  function onWindowBlur() {
    cancel()
  }

  function onWindowScroll() {
    // 触发前滚动视为手势让位；触发后滚动不再追加以免误吞
    if (press) clearPressTimer()
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') cancel()
  }

  onMounted(() => {
    window.addEventListener('pointermove', onWindowPointerMove, { capture: true, passive: true })
    window.addEventListener('pointerup', onWindowPointerUp, { capture: true, passive: true })
    window.addEventListener('pointercancel', onWindowPointerUp, { capture: true, passive: true })
    window.addEventListener('blur', onWindowBlur, { capture: true, passive: true })
    window.addEventListener('scroll', onWindowScroll, { capture: true, passive: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onBeforeUnmount(() => {
    cancel()
    window.removeEventListener('pointermove', onWindowPointerMove, true)
    window.removeEventListener('pointerup', onWindowPointerUp, true)
    window.removeEventListener('pointercancel', onWindowPointerUp, true)
    window.removeEventListener('blur', onWindowBlur, true)
    window.removeEventListener('scroll', onWindowScroll, true)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  return {
    onPointerDown,
    onContextMenu,
    cancel,
    active: readonly(active),
  }
}
