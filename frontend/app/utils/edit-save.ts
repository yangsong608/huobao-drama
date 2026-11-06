import type { EditPlanV1 } from './edit-plan'

export interface EditSaveQueueOptions {
  save: (plan: EditPlanV1) => Promise<void>
  delayMs?: number
  onError?: (error: unknown) => void
  setTimeoutFn?: (handler: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

export interface EditSaveQueue {
  schedule(plan: EditPlanV1): void
  flush(): Promise<void>
  cancel(): void
  pending(): boolean
  idle(): Promise<void>
}

/**
 * 计划快照只做 JSON 深拷贝：调用方可能传入 Vue 的深层响应式代理，
 * structuredClone 遇到代理会抛 DataCloneError 直接打断自动保存。
 */
function snapshotPlan(plan: EditPlanV1): EditPlanV1 {
  return JSON.parse(JSON.stringify(plan)) as EditPlanV1
}

export function createEditSaveQueue(options: EditSaveQueueOptions): EditSaveQueue {
  const delay = Math.max(0, Number(options.delayMs ?? 300) || 0)
  const setTimer = options.setTimeoutFn
    ?? ((handler: () => void, ms: number) => setTimeout(handler, ms))
  const clearTimer = options.clearTimeoutFn
    ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let pendingPlan: EditPlanV1 | null = null
  let timer: unknown = null
  let chain: Promise<void> = Promise.resolve()

  function enqueue(): Promise<void> {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    if (!pendingPlan) return chain
    const plan = pendingPlan
    pendingPlan = null
    chain = chain
      .then(() => options.save(plan))
      .catch((error) => {
        options.onError?.(error)
      })
    return chain
  }

  function schedule(plan: EditPlanV1): void {
    pendingPlan = snapshotPlan(plan)
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      void enqueue()
    }, delay)
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    for (;;) {
      if (pendingPlan) {
        await enqueue()
        continue
      }
      const current = chain
      await current
      if (!pendingPlan && current === chain) break
    }
  }

  function cancel(): void {
    if (timer !== null) clearTimer(timer)
    timer = null
    pendingPlan = null
  }

  return {
    schedule,
    flush,
    cancel,
    pending: () => pendingPlan !== null,
    idle: () => chain,
  }
}
