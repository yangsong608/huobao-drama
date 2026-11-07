/**
 * 助手抽屉会话状态（A1-7）
 *
 * 一个全局实例：消息流、SSE 订阅与线程状态都在模块级保存，
 * 关闭抽屉只隐藏界面，不取消生成；切回页面后继续从断点续传。
 */
import { computed, ref } from 'vue'
import { API_BASE, assistantAPI } from './useApi'
import type { AgentPreset, AgentScope, AgentSuggestion } from './useAgentPageAdapter'

export type AssistantMessageStatus = 'completed' | 'running' | 'failed' | 'cancelled' | 'interrupted'

export interface AssistantSession {
  id: number
  workspace_key: string
  preset: AgentPreset
  title: string
  status: 'active' | 'archived'
  last_message_at: string | null
  created_at: string
  updated_at: string
  message_count?: number
  proposal_count?: number
  scope?: AgentScope | null
}

export interface AssistantToolCall {
  name?: string
  toolName?: string
  status?: 'running' | 'done' | 'failed'
  summary?: string
  args?: unknown
}

export interface AssistantToolResult {
  toolName?: string
  name?: string
  result?: unknown
  status?: 'done' | 'failed'
}

export interface AssistantMessage {
  id: number
  session_id: number
  role: 'user' | 'assistant'
  content: string
  content_cleared?: boolean
  status: AssistantMessageStatus
  scope?: AgentScope | null
  preset?: AgentPreset
  tool_calls?: AssistantToolCall[] | null
  tool_results?: AssistantToolResult[] | null
  suggestions?: AgentSuggestion[] | null
  model?: string | null
  text_config_id?: number | null
  error?: string | null
  error_code?: string | null
  created_at: string
  finished_at?: string | null
}

export interface AssistantResolvePayload {
  session: AssistantSession
  messages: AssistantMessage[]
  has_more: boolean
}

export interface AssistantMessagePage {
  session: AssistantSession
  messages: AssistantMessage[]
  has_more: boolean
}

export interface AssistantThreadListPayload {
  items: AssistantSession[]
  has_more: boolean
}

export interface AssistantSendResult {
  user_message_id: number
  assistant_message_id: number
  stream_url?: string
  text?: string
  status?: AssistantMessageStatus
}

export type AssistantProposalStatus = 'proposed' | 'applied' | 'rejected' | 'conflict' | 'expired'

export interface AssistantProposal {
  id: number
  session_id: number
  message_id: number
  kind: 'storyboard.update' | 'asset.prompt.update' | 'line.update'
  target_type: 'storyboard' | 'line' | 'character' | 'scene' | 'prop'
  target_id: number
  drama_id: number
  episode_id: number | null
  before: Record<string, unknown>
  after: Record<string, unknown>
  rationale: string
  status: AssistantProposalStatus
  proposed_by: string
  applied_by: string | null
  applied_at: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export interface AssistantProposalWarning {
  code: string
  message: string
}

export interface AssistantProposalApplyResult {
  applied: boolean
  proposal: AssistantProposal
  warnings: AssistantProposalWarning[]
}


const session = ref<AssistantSession | null>(null)
const messages = ref<AssistantMessage[]>([])
const hasMore = ref(false)
const loadingSession = ref(false)
const loadingMore = ref(false)
const sending = ref(false)
const streaming = ref(false)
const cancelling = ref(false)
const error = ref('')
const errorCode = ref('')
const streamState = ref<'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'>('idle')
const threads = ref<AssistantSession[]>([])
const threadsHasMore = ref(false)
const threadsLoading = ref(false)
const proposals = ref<AssistantProposal[]>([])

let resolvedWorkspaceKey = ''
let activeReader: AbortController | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let streamCursor = 0
let reconnectAttempts = 0

export function sanitizeErrorText(raw: unknown): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text
    .replace(/\b(?:sk|ark)-[A-Za-z0-9_-]{8,}/gi, '***')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, '***')
    .slice(0, 300)
}

function setError(err: any): void {
  error.value = sanitizeErrorText(err?.message ?? err)
  errorCode.value = typeof err?.errorCode === 'string' ? err.errorCode : ''
}

function clearError(): void {
  error.value = ''
  errorCode.value = ''
}

function patchMessage(id: number, patch: Partial<AssistantMessage>): void {
  const current = messages.value.find(item => item.id === id)
  if (current) Object.assign(current, patch)
}

function upsertProposal(proposal: AssistantProposal): void {
  const index = proposals.value.findIndex(item => item.id === proposal.id)
  if (index >= 0) proposals.value[index] = proposal
  else proposals.value.push(proposal)
}

function proposalFromEvent(data: Record<string, any>): AssistantProposal | null {
  if (!data || !Number.isSafeInteger(Number(data.id)) || !Number.isSafeInteger(Number(data.message_id))) return null
  const { seq: _seq, ...rest } = data
  return rest as unknown as AssistantProposal
}

async function loadProposals(sessionId = session.value?.id): Promise<void> {
  if (!sessionId) return
  try {
    const payload = await assistantAPI.proposals(sessionId)
    proposals.value = payload.items
  } catch {
    // 提案加载失败不打断会话；打开卡片时会按需刷新
  }
}

async function refreshProposal(id: number): Promise<AssistantProposal | null> {
  try {
    const payload = await assistantAPI.proposal(id)
    upsertProposal(payload.proposal)
    return payload.proposal
  } catch {
    return null
  }
}

async function applyProposal(id: number): Promise<AssistantProposalApplyResult> {
  try {
    const result = await assistantAPI.applyProposal(id)
    upsertProposal(result.proposal)
    return result
  } catch (err) {
    await refreshProposal(id)
    throw err
  }
}

async function rejectProposal(id: number): Promise<AssistantProposal> {
  try {
    const payload = await assistantAPI.rejectProposal(id)
    upsertProposal(payload.proposal)
    return payload.proposal
  } catch (err) {
    await refreshProposal(id)
    throw err
  }
}

function appendToolCall(id: number, call: AssistantToolCall): void {
  const current = messages.value.find(item => item.id === id)
  if (!current) return
  if (!current.tool_calls) current.tool_calls = []
  current.tool_calls.push(call)
}

function appendToolResult(id: number, result: AssistantToolResult): void {
  const current = messages.value.find(item => item.id === id)
  if (!current) return
  if (!current.tool_results) current.tool_results = []
  current.tool_results.push(result)
  const pending = [...(current.tool_calls ?? [])].reverse().find(call => {
    const name = call.name || call.toolName
    return name === (result.toolName || result.name) && (call.status === 'running' || !call.status)
  })
  if (pending) pending.status = result.status
}

function stopReader(): void {
  activeReader?.abort()
  activeReader = null
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  streaming.value = false
  cancelling.value = false
  streamState.value = 'idle'
}

function handleStreamEvent(event: string, data: Record<string, any>, assistantId: number): void {
  if (data && Number.isFinite(Number(data.seq))) streamCursor = Number(data.seq)
  if (event === 'start') {
    if (data.model) patchMessage(assistantId, { model: String(data.model) })
    if (data.preset) patchMessage(assistantId, { preset: data.preset })
    return
  }
  if (event === 'scope') return
  if (event === 'reset') {
    patchMessage(assistantId, { content: String(data.text ?? '') })
    return
  }
  if (event === 'delta') {
    const current = messages.value.find(item => item.id === assistantId)
    if (current) current.content += String(data.text ?? '')
    return
  }
  if (event === 'tool') {
    const name = String(data.name ?? 'tool')
    if (data.status === 'running') {
      appendToolCall(assistantId, { name, status: 'running', summary: String(data.summary ?? ''), args: data.args })
    } else {
      appendToolResult(assistantId, {
        toolName: name,
        status: data.status === 'failed' ? 'failed' : 'done',
        result: String(data.result ?? data.summary ?? ''),
      })
    }
    return
  }
  if (event === 'proposal') {
    const proposal = proposalFromEvent(data)
    if (proposal) upsertProposal(proposal)
    return
  }
  if (event === 'suggestion') {
    const suggestions = Array.isArray(data.suggestions)
      ? data.suggestions
      : data.suggestion ? [data.suggestion] : []
    if (suggestions.length) patchMessage(assistantId, { suggestions })
    return
  }
  if (event === 'done') {
    patchMessage(assistantId, {
      content: String(data.text ?? ''),
      status: data.status === 'cancelled' ? 'cancelled' : 'completed',
      finished_at: new Date().toISOString(),
    })
    if (data.status === 'cancelled') void loadProposals()
    finishStream()
    return
  }
  if (event === 'error') {
    patchMessage(assistantId, {
      status: data.code === 'interrupted' ? 'interrupted' : 'failed',
      error: sanitizeErrorText(data.message),
      error_code: data.code ? String(data.code) : null,
      finished_at: new Date().toISOString(),
    })
    void loadProposals()
    finishStream()
  }
}

function finishStream(): void {
  streaming.value = false
  sending.value = false
  cancelling.value = false
  streamState.value = 'closed'
  reconnectAttempts = 0
  activeReader = null
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function parseSseBlock(raw: string): { event: string; data: Record<string, any> } | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (!dataLines.length) return null
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) }
  } catch {
    return null
  }
}

function scheduleReconnect(assistantId: number, sessionId: number): void {
  const current = messages.value.find(item => item.id === assistantId)
  if (!current || current.status !== 'running' || reconnectAttempts >= 6) {
    finishStream()
    return
  }
  reconnectAttempts += 1
  streamState.value = 'reconnecting'
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void pumpStream(assistantId, sessionId)
  }, Math.min(8000, 500 * 2 ** reconnectAttempts))
}

async function pumpStream(assistantId: number, sessionId: number): Promise<void> {
  const controller = new AbortController()
  activeReader?.abort()
  activeReader = controller
  streaming.value = true
  streamState.value = streamCursor > 0 ? 'reconnecting' : 'connecting'
  try {
    const url = assistantAPI.streamUrl(sessionId, assistantId, streamCursor)
    const resp = await fetch(`${API_BASE}${url}`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (resp.status === 403 || resp.status === 404) {
      const body = await resp.json().catch(() => null)
      patchMessage(assistantId, {
        status: 'failed',
        error: sanitizeErrorText(body?.message ?? (resp.status === 403 ? '助手入口已关闭' : '会话或消息不存在')),
        error_code: typeof body?.error_code === 'string' ? body.error_code : null,
        finished_at: new Date().toISOString(),
      })
      finishStream()
      return
    }
    if (!resp.ok || !resp.body) throw new Error(`SSE ${resp.status}`)
    streamState.value = 'open'
    reconnectAttempts = 0
    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const parsed = parseSseBlock(block)
        if (parsed) handleStreamEvent(parsed.event, parsed.data, assistantId)
        boundary = buffer.indexOf('\n\n')
      }
    }
    if (streaming.value) scheduleReconnect(assistantId, sessionId)
  } catch (err) {
    if (controller.signal.aborted) return
    scheduleReconnect(assistantId, sessionId)
  }
}

function adoptSession(payload: AssistantResolvePayload | AssistantMessagePage): void {
  session.value = payload.session
  messages.value = payload.messages
  hasMore.value = payload.has_more
  proposals.value = []
  resolvedWorkspaceKey = payload.session.workspace_key
  streamCursor = 0
  reconnectAttempts = 0
  void loadProposals(payload.session.id)
  const running = [...payload.messages].reverse().find(item => item.role === 'assistant' && item.status === 'running')
  if (running) {
    streaming.value = true
    void pumpStream(running.id, payload.session.id)
  } else {
    streaming.value = false
    streamState.value = 'idle'
  }
}

export function useAssistant() {
  const latestAssistant = computed(() => [...messages.value].reverse().find(item => item.role === 'assistant') ?? null)
  const busy = computed(() => sending.value || cancelling.value || streaming.value)
  const canSend = computed(() => Boolean(session.value) && !busy.value)

  async function resolve(scope: AgentScope, preset: AgentPreset = 'assistant', force = false): Promise<void> {
    if (!force && resolvedWorkspaceKey === scope.workspace_key && session.value) return
    stopReader()
    loadingSession.value = true
    clearError()
    try {
      const payload = await assistantAPI.resolve(scope.workspace_key, preset)
      adoptSession(payload)
    } catch (err: any) {
      setError(err)
      session.value = null
      messages.value = []
      proposals.value = []
      hasMore.value = false
    } finally {
      loadingSession.value = false
    }
  }

  async function newSession(scope: AgentScope, preset: AgentPreset = 'assistant'): Promise<void> {
    stopReader()
    clearError()
    try {
      const payload = await assistantAPI.create(scope.workspace_key, preset)
      adoptSession(payload)
      threads.value = []
    } catch (err: any) {
      setError(err)
    }
  }

  async function loadEarlier(): Promise<void> {
    if (!session.value || !hasMore.value || loadingMore.value || !messages.value.length) return
    loadingMore.value = true
    try {
      const first = messages.value[0]
      const payload = await assistantAPI.get(session.value.id, first.id, 50)
      const known = new Set(messages.value.map(item => item.id))
      messages.value = [...payload.messages.filter(item => !known.has(item.id)), ...messages.value]
      hasMore.value = payload.has_more
    } catch (err: any) {
      setError(err)
    } finally {
      loadingMore.value = false
    }
  }

  async function refreshThreads(): Promise<void> {
    if (!session.value) return
    threadsLoading.value = true
    try {
      const payload = await assistantAPI.list({
        workspaceKey: session.value.workspace_key,
        status: 'all',
        limit: 20,
        offset: 0,
      })
      threads.value = payload.items
      threadsHasMore.value = payload.has_more
    } catch {
      threads.value = []
      threadsHasMore.value = false
    } finally {
      threadsLoading.value = false
    }
  }

  async function loadMoreThreads(): Promise<void> {
    if (!session.value || !threadsHasMore.value || threadsLoading.value) return
    threadsLoading.value = true
    try {
      const payload = await assistantAPI.list({
        workspaceKey: session.value.workspace_key,
        status: 'all',
        limit: 20,
        offset: threads.value.length,
      })
      const known = new Set(threads.value.map(item => item.id))
      threads.value = [...threads.value, ...payload.items.filter(item => !known.has(item.id))]
      threadsHasMore.value = payload.has_more
    } catch {
      threadsHasMore.value = false
    } finally {
      threadsLoading.value = false
    }
  }

  async function switchSession(sessionId: number): Promise<void> {
    if (!session.value || session.value.id === sessionId) return
    stopReader()
    loadingSession.value = true
    clearError()
    try {
      const payload = await assistantAPI.get(sessionId, undefined, 50)
      adoptSession(payload)
    } catch (err: any) {
      setError(err)
    } finally {
      loadingSession.value = false
    }
  }

  async function send(content: string, scope: AgentScope, preset: AgentPreset = 'assistant'): Promise<void> {
    const text = content.trim()
    if (!text || !session.value || busy.value) return
    sending.value = true
    clearError()
    try {
      const previousTitle = session.value.title
      const response = await assistantAPI.send(session.value.id, {
        message: text,
        preset,
        scope,
      })
      const now = new Date().toISOString()
      messages.value.push({
        id: response.user_message_id,
        session_id: session.value.id,
        role: 'user',
        content: text,
        status: 'completed',
        scope,
        created_at: now,
      })
      messages.value.push({
        id: response.assistant_message_id,
        session_id: session.value.id,
        role: 'assistant',
        content: response.stream_url ? '' : (response.text ?? ''),
        status: response.stream_url ? 'running' : (response.status ?? 'completed'),
        scope,
        created_at: now,
        tool_calls: [],
        tool_results: [],
      })
      if (!previousTitle) session.value.title = text.slice(0, 40)
      if (response.stream_url) {
        streamCursor = 0
        reconnectAttempts = 0
        void pumpStream(response.assistant_message_id, session.value.id)
      } else {
        sending.value = false
        streaming.value = false
        streamState.value = 'closed'
      }
    } catch (err: any) {
      setError(err)
      sending.value = false
    }
  }

  async function cancel(): Promise<void> {
    if (!session.value || cancelling.value) return
    const running = [...messages.value].reverse().find(item => item.role === 'assistant' && item.status === 'running')
    if (!running) return
    cancelling.value = true
    try {
      const payload = await assistantAPI.cancel(session.value.id)
      stopReader()
      patchMessage(running.id, {
        content: payload.message.content ?? running.content,
        status: payload.message.status ?? 'cancelled',
        error: payload.message.error ?? null,
        finished_at: payload.message.finished_at ?? new Date().toISOString(),
      })
    } catch (err: any) {
      setError(err)
      cancelling.value = false
    }
  }

  return {
    session,
    messages,
    hasMore,
    loadingSession,
    loadingMore,
    sending,
    streaming,
    cancelling,
    busy,
    canSend,
    error,
    errorCode,
    streamState,
    threads,
    threadsHasMore,
    threadsLoading,
    proposals,
    latestAssistant,
    resolve,
    newSession,
    loadEarlier,
    refreshThreads,
    loadMoreThreads,
    switchSession,
    send,
    cancel,
    loadProposals,
    refreshProposal,
    applyProposal,
    rejectProposal,
  }
}
