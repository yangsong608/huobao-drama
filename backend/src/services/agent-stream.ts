/**
 * 助手流式事件中心（进程内）
 * 生成只由 POST /messages 启动；SSE 只订阅。断线期间继续缓冲，终态以数据库为准。
 */
export type AgentStreamEventName =
  | 'start'
  | 'scope'
  | 'delta'
  | 'reset'
  | 'tool'
  | 'proposal'
  | 'suggestion'
  | 'done'
  | 'error'

export interface AgentStreamEvent {
  seq: number
  event: AgentStreamEventName
  data: Record<string, unknown>
}

type Listener = (event: AgentStreamEvent) => void

const MAX_BUFFER_EVENTS = 2000
const MAX_BUFFER_CHARS = 400_000
const CLOSE_TTL_MS = 10_000
export const AGENT_HEARTBEAT_MS = 15_000

interface StreamState {
  messageId: number
  sessionId: number
  seq: number
  text: string
  events: AgentStreamEvent[]
  bufferedChars: number
  droppedBefore: number
  subscribers: Set<Listener>
  abortController: AbortController
  closed: boolean
  startData: Record<string, unknown>
  scopeData: Record<string, unknown>
  createdAt: number
}

const streams = new Map<number, StreamState>()

function trimBuffer(state: StreamState) {
  while (
    state.events.length > MAX_BUFFER_EVENTS
    || state.bufferedChars > MAX_BUFFER_CHARS
  ) {
    const removed = state.events.shift()
    if (!removed) break
    state.bufferedChars -= JSON.stringify(removed.data).length
    state.droppedBefore = removed.seq
  }
}

function emit(state: StreamState, event: AgentStreamEventName, data: Record<string, unknown>): AgentStreamEvent | null {
  if (state.closed) return null
  const item: AgentStreamEvent = { seq: ++state.seq, event, data: { ...data, seq: state.seq } }
  state.events.push(item)
  state.bufferedChars += JSON.stringify(item.data).length
  trimBuffer(state)
  for (const listener of [...state.subscribers]) {
    try {
      listener(item)
    } catch {
      // 单个订阅者异常不影响其他订阅者与生成
    }
  }
  return item
}

export function createAgentStream(input: {
  messageId: number
  sessionId: number
  model?: string | null
  preset: string
  scope: Record<string, unknown>
}): StreamState {
  const state: StreamState = {
    messageId: input.messageId,
    sessionId: input.sessionId,
    seq: 0,
    text: '',
    events: [],
    bufferedChars: 0,
    droppedBefore: 0,
    subscribers: new Set(),
    abortController: new AbortController(),
    closed: false,
    startData: {
      message_id: input.messageId,
      model: input.model || '',
      preset: input.preset,
    },
    scopeData: input.scope,
    createdAt: Date.now(),
  }
  streams.set(input.messageId, state)
  emit(state, 'start', state.startData)
  emit(state, 'scope', state.scopeData)
  return state
}

export function getAgentStream(messageId: number): StreamState | undefined {
  return streams.get(messageId)
}

export function getAgentStreamText(messageId: number): string {
  return streams.get(messageId)?.text ?? ''
}

export function appendAgentDelta(messageId: number, text: string): AgentStreamEvent | null {
  const state = streams.get(messageId)
  if (!state || state.closed || !text) return null
  state.text += text
  return emit(state, 'delta', { text })
}

export function publishAgentEvent(
  messageId: number,
  event: AgentStreamEventName,
  data: Record<string, unknown>,
): AgentStreamEvent | null {
  const state = streams.get(messageId)
  if (!state) return null
  return emit(state, event, data)
}

export interface AgentSubscription {
  initial: AgentStreamEvent[]
  reset: { text: string; seq: number } | null
  start: Record<string, unknown>
  scope: Record<string, unknown>
  /** 缓冲中最后一条终态事件；reset 后需要补发，避免订阅方等待已关闭的流 */
  terminal: AgentStreamEvent | null
  activate: () => void
  unsubscribe: () => void
}

/** 订阅单条消息；返回初始回放或 reset 快照，activate 后开始推送实时事件 */
export function subscribeAgentStream(
  messageId: number,
  afterSeq: number,
  listener: Listener,
): AgentSubscription | null {
  const state = streams.get(messageId)
  if (!state) return null

  const baseline = Math.max(0, Math.floor(afterSeq))
  const firstBuffered = state.events[0]?.seq ?? state.seq + 1
  const canReplay = baseline > 0
    && baseline <= state.seq
    && state.droppedBefore <= baseline
    && firstBuffered <= baseline + 1
  const reset = canReplay ? null : { text: state.text, seq: state.seq }
  const initial = canReplay ? state.events.filter((item) => item.seq > baseline) : []
  const terminal = [...state.events].reverse().find((item) => item.event === 'done' || item.event === 'error') ?? null
  const queue: AgentStreamEvent[] = []
  let live = false

  const wrapped: Listener = (event) => {
    if (event.seq <= baseline) return
    if (!live) {
      queue.push(event)
      return
    }
    listener(event)
  }
  state.subscribers.add(wrapped)

  return {
    initial,
    reset,
    start: state.startData,
    scope: state.scopeData,
    terminal,
    activate: () => {
      live = true
      const gate = reset ? reset.seq : baseline
      for (const event of queue.splice(0)) {
        if (event.seq > gate) listener(event)
      }
    },
    unsubscribe: () => {
      state.subscribers.delete(wrapped)
    },
  }
}

export function abortAgentStream(messageId: number): boolean {
  const state = streams.get(messageId)
  if (!state || state.closed) return false
  state.abortController.abort()
  return true
}

export function isAgentStreamAborted(messageId: number): boolean {
  return streams.get(messageId)?.abortController.signal.aborted ?? false
}

export function getAgentAbortSignal(messageId: number): AbortSignal | undefined {
  return streams.get(messageId)?.abortController.signal
}

export function closeAgentStream(messageId: number): void {
  const state = streams.get(messageId)
  if (!state) return
  state.closed = true
  const timer = setTimeout(() => {
    if (streams.get(messageId) === state) streams.delete(messageId)
  }, CLOSE_TTL_MS)
  timer.unref?.()
}

export function resetAgentStreamsForTest(): void {
  for (const state of streams.values()) {
    state.closed = true
    state.subscribers.clear()
  }
  streams.clear()
}
