/**
 * 可见性感知轮询（P10）
 *
 * 统一收敛工作台里「后台状态轮询」的生命周期：页面隐藏即停、恢复可见立即补一次、
 * 同一实例不并发、stop 之后彻底不再触发、组件卸载必停。
 *
 * 拆成两层，便于 Node 单测核心逻辑（不依赖 DOM / Vue）：
 *   createVisibilityPolling(host, task, ms, opts)  纯工厂，宿主能力全部注入
 *   useVisibilityPolling(task, ms, opts)           Vue 封装，host 走 document / window，卸载时 stop
 *
 * 不读接口、不持久化；请求本身的取消由调用方决定（stop 不取消已发出的请求）。
 */
import { onBeforeUnmount } from 'vue'

export interface VisibilityPollingHost {
  isHidden: () => boolean
  addVisibilityListener: (cb: () => void) => void
  removeVisibilityListener: (cb: () => void) => void
  setInterval: (cb: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
}

export interface VisibilityPollingOptions {
  /** start 时若页面可见，是否立即执行一次任务（默认 false：等第一个周期） */
  immediate?: boolean
}

export interface VisibilityPolling {
  start: () => void
  stop: () => void
  isRunning: () => boolean
}

export function createVisibilityPolling(
  host: VisibilityPollingHost,
  task: () => void | Promise<void>,
  intervalMs: number,
  options?: VisibilityPollingOptions,
): VisibilityPolling {
  let running = false
  let inFlight = false
  // 代际令牌：stop/start 后旧任务迟到的释放不得清掉新一轮的 inFlight
  let generation = 0
  // 宿主可能返回 0/'' 等假值 id，用 null 作为「无定时器」哨兵
  let timer: unknown = null

  function clearTimer() {
    if (timer === null) return
    host.clearInterval(timer)
    timer = null
  }

  function ensureTimer() {
    // 任务可能在 immediate tick 中同步自停；此时不得留下空转 interval
    if (!running || timer !== null) return
    timer = host.setInterval(() => { tick() }, intervalMs)
  }

  function tick() {
    if (!running || host.isHidden() || inFlight) return
    inFlight = true
    const token = generation
    let result: void | Promise<void>
    try {
      result = task()
    } catch {
      // 任务同步抛错不打断轮询；错误文案由任务自身决定（多数站点本来就静默）
      inFlight = false
      return
    }
    if (result && typeof (result as Promise<void>).then === 'function') {
      // 只用于解除 inFlight，不改变任务的错误策略；拒绝也静默，避免 unhandled rejection
      const release = () => { if (token === generation) inFlight = false }
      (result as Promise<void>).then(release, release)
      return
    }
    inFlight = false
  }

  function onVisibilityChange() {
    if (!running) return
    if (host.isHidden()) {
      // 隐藏：只停定时器，保留监听以便恢复时立即补一次
      clearTimer()
      return
    }
    tick()
    ensureTimer()
  }

  function start() {
    if (running) return
    running = true
    generation += 1
    inFlight = false
    host.addVisibilityListener(onVisibilityChange)
    if (host.isHidden()) return
    if (options?.immediate) tick()
    ensureTimer()
  }

  function stop() {
    running = false
    generation += 1
    inFlight = false
    clearTimer()
    host.removeVisibilityListener(onVisibilityChange)
  }

  return { start, stop, isRunning: () => running }
}

const NOOP_POLLING: VisibilityPolling = {
  start: () => {},
  stop: () => {},
  isRunning: () => false,
}

/** Vue 封装：无 document（SSR / Node 直接调用）时返回 no-op 实例 */
export function useVisibilityPolling(
  task: () => void | Promise<void>,
  intervalMs: number,
  options?: VisibilityPollingOptions,
): VisibilityPolling {
  if (typeof document === 'undefined' || typeof window === 'undefined') return NOOP_POLLING

  const host: VisibilityPollingHost = {
    isHidden: () => document.hidden,
    addVisibilityListener: (cb) => { document.addEventListener('visibilitychange', cb) },
    removeVisibilityListener: (cb) => { document.removeEventListener('visibilitychange', cb) },
    setInterval: (cb, ms) => window.setInterval(cb, ms),
    clearInterval: (id) => { window.clearInterval(id as number) },
  }

  const polling = createVisibilityPolling(host, task, intervalMs, options)
  onBeforeUnmount(() => { polling.stop() })
  return polling
}
