/**
 * 覆盖层 ↔ 浏览器历史 / 焦点桥接（P4）
 *
 * 弹窗、抽屉等覆盖层打开时向历史压入一条带标记的记录，使平板/手机的
 * 返回手势、硬件返回键先关闭最上层覆盖层，而不是直接离开当前页面。
 *
 * 契约（P7–P9 复用）：
 *   useOverlayHistory(onClose) -> { open, close }
 *   - open()  只在首次打开时压栈；同一实例重复调用不重复记录
 *   - close() 当前 state 仍是本层标记时 history.back()，并吞掉这次 popstate
 *   - 模块级只注册一个 popstate 监听（栈非空时注册，栈空时移除），只关栈顶一层
 *   - 模块级只注册一个 keydown 监听：Escape 关闭栈顶
 *   - 打开时记录触发元素，关闭后焦点回到仍挂载的触发元素
 *   - html.huobao-overlay-open 在栈非空时保留，栈空时移除
 *   - 路由切换 / 组件卸载只清理标记（replaceState），绝不 history.back()
 *
 * 不读接口、不持久化、不依赖 usePwa。
 */
import { onBeforeUnmount } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'

const OVERLAY_STATE_KEY = '__huobaoOverlay'
const ROOT_CLASS = 'huobao-overlay-open'

interface OverlayLayer {
  token: number
  onClose: () => void
}

/** 后开先关的层栈；每层只保存 token 与关闭回调 */
const layers: OverlayLayer[] = []
let tokenSeed = 0
/** 由本模块主动 history.back() 时置位；随之而来的那一次 popstate 被吞掉 */
let pendingSelfBack = 0
let listening = false
/** 最近一次指针按下的目标：iOS 点击不会让按钮取得焦点，只能靠它兜底 */
let lastPointerTarget: Element | null = null
/** 指针记录器是模块级单例，多个覆盖层实例共享一个监听 */
let pointerRecorderBound = false

const FOCUSABLE_SELECTOR = 'button, a[href], input, select, textarea, [tabindex]'

function onPointerDown(event: PointerEvent) {
  // 图标按钮的按下目标是 <svg>/<path>，同样要记录，交给 closest 向上找可聚焦祖先
  lastPointerTarget = event.target instanceof Element ? event.target : null
}

/**
 * capture 阶段先于业务处理记录真正的按下目标；passive 保证不改变任何默认行为。
 * 只在首次 useOverlayHistory() 时注册，避免每个实例重复挂监听。
 */
function ensurePointerRecorder() {
  if (pointerRecorderBound || typeof window === 'undefined') return
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  pointerRecorderBound = true
}

/**
 * iOS 点击不会让按钮成为 activeElement（停留在 body），
 * 因此 activeElement 不可用时回落到最近一次指针目标，并向上解析到可聚焦祖先。
 */
function resolveTrigger(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body) return active
  const pointed = lastPointerTarget
  if (!pointed) return null
  const focusable = pointed.closest(FOCUSABLE_SELECTOR)
  if (focusable instanceof HTMLElement) return focusable
  return pointed instanceof HTMLElement ? pointed : null
}

function overlayTokenOf(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null
  const raw = (state as Record<string, unknown>)[OVERLAY_STATE_KEY]
  return typeof raw === 'number' ? raw : null
}

function currentToken(): number | null {
  if (typeof window === 'undefined') return null
  return overlayTokenOf(window.history.state)
}

function syncRootClass() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (layers.length) root.classList.add(ROOT_CLASS)
  else root.classList.remove(ROOT_CLASS)
}

/**
 * 单例监听：栈非空（或还有待确认的自身回退）时注册，否则移除，
 * 避免全局监听影响普通路由后退。
 */
function syncListeners() {
  if (typeof window === 'undefined') return
  const needed = layers.length > 0 || pendingSelfBack > 0
  if (needed && !listening) {
    window.addEventListener('popstate', onPopState)
    window.addEventListener('keydown', onKeydown)
    listening = true
    return
  }
  if (!needed && listening) {
    window.removeEventListener('popstate', onPopState)
    window.removeEventListener('keydown', onKeydown)
    listening = false
  }
}

/** 浏览器后退 / 返回手势：只关闭栈顶一层，绝不批量关闭 */
function onPopState() {
  if (pendingSelfBack > 0) {
    // 这次是本模块 close() 主动 history.back() 触发的，跳过以免误关下一层
    pendingSelfBack -= 1
    syncListeners()
    return
  }
  const top = layers.pop()
  if (!top) {
    syncListeners()
    return
  }
  syncRootClass()
  syncListeners()
  top.onClose()
}

/** Escape：只关闭栈顶一层；覆盖层自身也监听时以先处理者为准 */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  const top = layers[layers.length - 1]
  if (!top) return
  event.preventDefault()
  top.onClose()
}

function dropLayer(layer: OverlayLayer) {
  const index = layers.indexOf(layer)
  if (index >= 0) layers.splice(index, 1)
}

function restoreFocus(target: HTMLElement | null) {
  if (!target || !target.isConnected || typeof target.focus !== 'function') return
  try {
    // P10：preventScroll 避免关闭覆盖层时把页面滚回触发元素（P4 遗留）
    target.focus({ preventScroll: true })
  } catch {
    // 极少数老内核不认 FocusOptions 时退回无参调用，焦点仍要归还
    target.focus()
  }
}

/**
 * 本实例的回调是否正处于覆盖层栈顶。
 * ConfirmDialog 用它门控 Escape/Enter：多个弹窗叠加时只有最上层响应键盘。
 */
export function isTopOverlay(onClose: () => void): boolean {
  const top = layers[layers.length - 1]
  return Boolean(top && top.onClose === onClose)
}

export function useOverlayHistory(onClose: () => void): { open: () => void; close: () => void } {
  ensurePointerRecorder()
  let layer: OverlayLayer | null = null
  let trigger: HTMLElement | null = null

  function open() {
    if (typeof window === 'undefined') return
    if (layer) {
      // 仍在栈内说明已打开，不重复压栈；已被 popstate 弹出（组件因忙碌未真正关闭）则以新层重新登记
      if (layers.includes(layer)) return
      layer = null
      trigger = null
    }
    layer = { token: ++tokenSeed, onClose }
    trigger = resolveTrigger()
    layers.push(layer)
    syncRootClass()
    syncListeners()
    window.history.pushState({ ...window.history.state, [OVERLAY_STATE_KEY]: layer.token }, '')
  }

  function close() {
    if (!layer) return
    const closing = layer
    layer = null
    dropLayer(closing)
    syncRootClass()
    if (typeof window !== 'undefined' && currentToken() === closing.token) {
      // 只回退自己压入的那一条；pendingSelfBack 保证这次 popstate 不误关下一层
      pendingSelfBack += 1
      window.history.back()
    }
    syncListeners()
    const el = trigger
    trigger = null
    restoreFocus(el)
  }

  /** 路由切换 / 组件卸载：只清理标记，调用 history.back() 会打断导航 */
  function discard() {
    if (!layer) return
    const dropping = layer
    layer = null
    trigger = null
    dropLayer(dropping)
    syncRootClass()
    if (typeof window !== 'undefined' && currentToken() === dropping.token) {
      const next = { ...window.history.state } as Record<string, unknown>
      delete next[OVERLAY_STATE_KEY]
      window.history.replaceState(next, '')
    }
    syncListeners()
  }

  onBeforeRouteLeave(() => { discard() })
  onBeforeUnmount(() => { discard() })

  return { open, close }
}
