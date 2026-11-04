export interface StoryboardUpdateQueueDeps {
  update: (id: number, payload: Record<string, any>) => Promise<any>
  onError: (error: any) => void
  onRollback: () => void | Promise<void>
}

interface QueueEntry {
  pending: Record<string, any> | null
  running: boolean
  attempts: number
}

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 300

// 同一分镜的更新串行发送并合并：连续点多选素材时，避免旧请求后落地覆盖新数组
export function createStoryboardUpdateQueue(deps: StoryboardUpdateQueueDeps) {
  const entries = new Map<number, QueueEntry>()

  async function flush(id: number, entry: QueueEntry) {
    entry.running = true
    try {
      while (entry.pending) {
        const payload = entry.pending
        entry.pending = null
        try {
          await deps.update(id, payload)
          entry.attempts = 0
        } catch (error) {
          // 失败补丁不能丢：期间的新改动同字段优先，其余字段继续保留
          entry.pending = { ...payload, ...(entry.pending || {}) }
          entry.attempts += 1
          if (entry.attempts >= MAX_ATTEMPTS) {
            entry.pending = null
            entries.delete(id)
            try { deps.onError(error) } catch {}
            try { await deps.onRollback() } catch {}
            break
          }
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * entry.attempts))
        }
      }
    } finally {
      entry.running = false
    }
  }

  function queue(id: number, patch: Record<string, any>) {
    let entry = entries.get(id)
    if (!entry) {
      entry = { pending: null, running: false, attempts: 0 }
      entries.set(id, entry)
    }
    entry.pending = { ...(entry.pending || {}), ...patch }
    if (entry.running) return
    void flush(id, entry)
  }

  function hasPending() {
    for (const entry of entries.values()) {
      if (entry.running || entry.pending) return true
    }
    return false
  }

  function flushPending() {
    for (const [id, entry] of entries) {
      if (entry.running || !entry.pending) continue
      void flush(id, entry)
    }
  }

  return { queue, hasPending, flushPending }
}
