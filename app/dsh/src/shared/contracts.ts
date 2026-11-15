import type { AgentRole, BridgeRole } from './roles.js'

export interface ChatTextBlock {
  type: 'text'
  text: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatTextBlock[]
}

export interface LlmChatRequest {
  role?: BridgeRole | string
  model?: string
  messages: ChatMessage[]
  system?: string
  temperature?: number
  maxTokens?: number
  responseFormat?: 'text' | 'json'
  timeoutMs?: number
  requestId?: string
  traceId?: string
}

export interface LlmUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
}

export interface LlmChatResponse {
  id: string
  model: string
  engine: 'dsh'
  choices: Array<{
    index: number
    message: { role: 'assistant'; content: string }
    finish_reason: string
  }>
  usage?: LlmUsage
  traceId?: string
}

export interface AgentTaskRequest {
  idempotencyKey: string
  huobaoTaskId: number
  role: AgentRole
  taskType: string
  dramaId: number
  episodeId?: number
  input: Record<string, unknown>
  contentLanguage?: string
  callbackUrl?: string
  deadlineMs?: number
  traceId?: string
}

export interface AgentTaskAccepted {
  dshTaskId: string
  dshSessionId: string
  status: 'accepted'
  acceptedAt: string
  existing?: boolean
}

export type BridgeTaskStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'needs_attention'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'orphaned'
  | 'fallback_running'
  | 'fallback_succeeded'
  | 'fallback_failed'

export interface AgentTaskView {
  dshTaskId: string
  huobaoTaskId: number
  role: AgentRole
  taskType: string
  status: BridgeTaskStatus
  dshSessionId?: string
  result?: Record<string, unknown>
  errorCode?: string
  errorMessage?: string
  fallbackSuggested?: boolean
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
}

export interface HealthView {
  pluginVersion: string
  dshVersion: string
  bridgePort: number
  llmBridge: boolean
  agentBridge: boolean
  huobaoApi: 'reachable' | 'unreachable' | 'unknown'
  huobaoMcp: 'running' | 'stopped' | 'unknown'
  taskCounts: {
    queued: number
    running: number
    succeeded: number
    failed: number
    fallback: number
  }
  fallbackRate: number
  providers: string[]
  roles: Record<string, { provider: string; model: string }>
  lastError?: string
}
