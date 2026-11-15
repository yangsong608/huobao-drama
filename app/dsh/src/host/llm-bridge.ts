import crypto from 'node:crypto'
import type { LlmChatRequest, LlmChatResponse, LlmUsage } from '../shared/contracts.js'
import { BridgeError } from '../shared/errors.js'
import { resolveRoleModel, type BridgeConfig } from '../shared/config.js'
import { normalizeBridgeRole } from '../shared/roles.js'

export interface LlmTextDeltaChunk {
  type: 'text-delta'
  index: number
  text: string
}

export interface LlmBlockEndChunk {
  type: 'block-end'
  index: number
  block: { type: string; text?: string }
}

export interface LlmUsageChunk {
  type: 'usage'
  usage?: unknown
}

export interface LlmFinishChunk {
  type: 'finish'
  reason: {
    kind: string
    failure?: { code?: string; message?: string }
  }
}

export type LlmStreamChunk =
  | LlmTextDeltaChunk
  | LlmBlockEndChunk
  | LlmUsageChunk
  | LlmFinishChunk
  | { type: string; [key: string]: unknown }

export interface LlmService {
  stream(options: Record<string, unknown>): AsyncIterable<LlmStreamChunk>
  listProviders?(): string[]
}

interface DshTextBlock {
  type: 'text'
  text: string
}

interface DshMessage {
  role: 'system' | 'user' | 'assistant'
  content: DshTextBlock[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeContent(content: unknown): DshTextBlock[] | null {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return null
  const blocks: DshTextBlock[] = []
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return null
    blocks.push({ type: 'text', text: block.text })
  }
  return blocks
}

function normalizeMessages(body: LlmChatRequest): DshMessage[] {
  const messages: DshMessage[] = []
  if (typeof body.system === 'string' && body.system.trim() !== '') {
    messages.push({ role: 'system', content: [{ type: 'text', text: body.system }] })
  }
  for (const message of body.messages) {
    if (!isRecord(message)) throw new BridgeError('INVALID_REQUEST', 'messages 项必须是对象')
    const role = message.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new BridgeError('INVALID_REQUEST', `不支持的消息角色：${String(role)}`)
    }
    const content = normalizeContent(message.content)
    if (content === null || content.length === 0) {
      throw new BridgeError('INVALID_REQUEST', '消息 content 必须是非空文本或文本块数组')
    }
    messages.push({ role, content })
  }
  if (messages.length === 0) throw new BridgeError('INVALID_REQUEST', 'messages 不能为空')
  return messages
}

function normalizeUsage(value: unknown): LlmUsage | undefined {
  if (!isRecord(value)) return undefined
  const usage: LlmUsage = {}
  if (typeof value.inputTokens === 'number') usage.inputTokens = value.inputTokens
  if (typeof value.outputTokens === 'number') usage.outputTokens = value.outputTokens
  if (typeof value.totalTokens === 'number') usage.totalTokens = value.totalTokens
  if (typeof value.cachedInputTokens === 'number') usage.cachedInputTokens = value.cachedInputTokens
  return Object.keys(usage).length === 0 ? undefined : usage
}

function failureCode(code: string | undefined): 'AUTH' | 'RATE_LIMIT' | 'INVALID_REQUEST' | 'UPSTREAM_ERROR' {
  if (code === 'AUTH' || code === 'MISSING_CREDENTIAL' || code === 'INVALID_CREDENTIAL') return 'AUTH'
  if (code === 'RATE_LIMIT' || code === 'QUOTA') return 'RATE_LIMIT'
  if (code === 'CONTEXT_WINDOW_EXCEEDED' || code === 'INVALID_MODEL_CONFIG') return 'INVALID_REQUEST'
  return 'UPSTREAM_ERROR'
}

export async function handleLlmChat(
  body: unknown,
  deps: { llm?: LlmService; config: BridgeConfig },
): Promise<LlmChatResponse> {
  if (!isRecord(body)) throw new BridgeError('INVALID_REQUEST', '请求体必须是 JSON 对象')
  if (!Array.isArray(body.messages)) throw new BridgeError('INVALID_REQUEST', 'messages 必须是数组')
  const request = body as unknown as LlmChatRequest
  const role = normalizeBridgeRole(request.role)
  const model = resolveRoleModel(deps.config, role)
  if (!deps.llm || typeof deps.llm.stream !== 'function') {
    throw new BridgeError('BRIDGE_UNAVAILABLE', 'DSH LLM 服务不可用')
  }
  const messages = normalizeMessages(request)
  const timeoutMs = typeof request.timeoutMs === 'number' && request.timeoutMs > 0
    ? Math.min(Math.max(request.timeoutMs, 1_000), 900_000)
    : deps.config.timeouts.llmMs

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()

  let text = ''
  let sawDelta = false
  let sawFinish = false
  let usage: LlmUsage | undefined
  let finishKind = 'stop'
  try {
    for await (const chunk of deps.llm.stream({
      provider: model.provider,
      model: model.model,
      messages,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
      signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') {
        const delta = chunk as LlmTextDeltaChunk
        if (typeof delta.text === 'string') {
          text += delta.text
          sawDelta = true
        }
        continue
      }
      if (chunk.type === 'block-end') {
        const end = chunk as LlmBlockEndChunk
        if (!sawDelta && end.block?.type === 'text' && typeof end.block.text === 'string') {
          text += end.block.text
        }
        continue
      }
      if (chunk.type === 'usage') {
        usage = normalizeUsage((chunk as LlmUsageChunk).usage)
        continue
      }
      if (chunk.type === 'finish') {
        const finish = chunk as LlmFinishChunk
        sawFinish = true
        finishKind = finish.reason?.kind ?? 'stop'
        if (finishKind === 'error') {
          const failure = finish.reason?.failure
          throw new BridgeError(failureCode(failure?.code), failure?.message ?? '模型调用失败')
        }
        if (finishKind === 'aborted') {
          throw new BridgeError(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut ? '模型调用超时' : '模型调用已取消')
        }
      }
    }
  } catch (cause) {
    if (cause instanceof BridgeError) throw cause
    if (timedOut) throw new BridgeError('TIMEOUT', '模型调用超时')
    throw new BridgeError('UPSTREAM_ERROR', cause instanceof Error ? cause.message : String(cause))
  } finally {
    clearTimeout(timer)
  }

  if (!sawFinish) {
    throw new BridgeError('UPSTREAM_ERROR', '模型流未正常结束（缺少 finish）')
  }

  return {
    id: crypto.randomUUID(),
    model: `${model.provider}/${model.model}`,
    engine: 'dsh',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: finishKind,
    }],
    usage,
    traceId: request.traceId,
  }
}
