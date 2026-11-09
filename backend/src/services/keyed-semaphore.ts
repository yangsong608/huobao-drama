/**
 * 按接口（服务商/配置）隔离的并发调度。
 * 同一个 key 共享并发槽位或串行链，不同 key 互不约束。
 */

interface SemaphoreState {
  active: number
  waiters: (() => void)[]
}

const slots = new Map<string, SemaphoreState>()
const chains = new Map<string, Promise<unknown>>()

function stateOf(key: string): SemaphoreState {
  let state = slots.get(key)
  if (!state) {
    state = { active: 0, waiters: [] }
    slots.set(key, state)
  }
  return state
}

function acquire(key: string, limit: number): Promise<void> {
  const state = stateOf(key)
  if (state.active < limit) {
    state.active += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    state.waiters.push(() => {
      // 在唤醒时占位，避免同一轮事件循环内超额进入
      state.active += 1
      resolve()
    })
  })
}

function release(key: string) {
  const state = slots.get(key)
  if (!state) return
  state.active -= 1
  const next = state.waiters.shift()
  if (next) {
    next()
    return
  }
  if (state.active <= 0) slots.delete(key)
}

/** 同一个 key 最多 limit 个任务并发执行 */
export async function withKeyedSlot<T>(key: string, limit: number, task: () => Promise<T>): Promise<T> {
  const concurrency = Math.max(1, Math.floor(limit))
  await acquire(key, concurrency)
  try {
    return await task()
  } finally {
    release(key)
  }
}

/** 同一个 key 串行执行，不同 key 并行 */
export function withKeyedChain<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(() => undefined, () => undefined)
  chains.set(key, settled)
  const cleanup = () => {
    if (chains.get(key) === settled) chains.delete(key)
  }
  settled.then(cleanup, cleanup)
  return run
}
