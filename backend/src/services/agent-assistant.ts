/**
 * 助手回合执行器：组装上下文 → 调用预设 Agent → 推送流事件并落库。
 * 生成只由 POST /messages 启动；不写业务表。
 */
import { agentRegistry } from '../agents/index.js'
import { buildAssistantRequestContext } from '../agents/context.js'
import {
  buildScopeSummary,
  clipText,
  getAssistantBudget,
  redactSecrets,
  sanitizeAssistantError,
  trimAssistantHistory,
  type AssistantHistoryMessage,
} from '../agents/assistant-context.js'
import type { AgentScope } from '../agents/agent-scope.js'
import {
  AgentSessionConflictError,
  finishMessage,
  listMessages,
} from './agent-sessions.js'
import {
  abortAgentStream,
  appendAgentDelta,
  closeAgentStream,
  getAgentAbortSignal,
  getAgentStreamText,
  publishAgentEvent,
} from './agent-stream.js'
import { recordDiagnosticError } from './agent-diagnostics.js'

export interface AssistantTurnInput {
  sessionId: number
  workspaceKey: string
  scope: AgentScope
  preset: 'assistant' | 'director'
  userMessageId: number
  assistantMessageId: number
  model?: string
  textConfigId?: number
}

export interface AssistantStreamArgs {
  preset: 'assistant' | 'director'
  messages: AssistantHistoryMessage[]
  requestContext: unknown
  abortSignal?: AbortSignal
  maxSteps: number
  messageId: number
}

export interface AssistantStreamLike {
  fullStream: AsyncIterable<any>
}

type AssistantStreamFactory = (args: AssistantStreamArgs) => Promise<AssistantStreamLike>

let streamFactoryOverride: AssistantStreamFactory | null = null

/** 测试注入：跳过真实模型，按同一 chunk 协议产出事件 */
export function setAssistantStreamFactoryForTest(factory: AssistantStreamFactory | null): void {
  streamFactoryOverride = factory
}

async function defaultStreamFactory(args: AssistantStreamArgs): Promise<AssistantStreamLike> {
  const agent = agentRegistry[args.preset] as any
  if (!agent) throw new Error('助手未注册')
  return agent.stream(args.messages, {
    maxSteps: args.maxSteps,
    requestContext: args.requestContext,
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
  })
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return '无参数'
  const raw = typeof args === 'string' ? args : JSON.stringify(args)
  return clipText(redactSecrets(raw || ''), 160).text || '无参数'
}

function rawToolResult(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return String(value)
  }
}

function errorFromChunk(chunk: any): Error {
  const payload = chunk?.payload?.error ?? chunk?.error
  if (payload instanceof Error) return payload
  return new Error(typeof payload === 'string' && payload ? payload : '模型调用失败')
}

/**
 * 执行一轮回答；永不抛出（后台任务）。
 * 终态写入数据库后由本函数发 done/error 并关闭流。
 */
export async function runAssistantTurn(input: AssistantTurnInput): Promise<void> {
  const budget = getAssistantBudget()
  const signal = getAgentAbortSignal(input.assistantMessageId)
  let text = ''
  let timedOut = false
  const toolCalls: Array<{ toolName: string; args: unknown }> = []
  const toolResults: Array<{ toolName: string; result: string; status: 'done' | 'failed' }> = []
  let usage: unknown = null

  const timer = setTimeout(() => {
    timedOut = true
    abortAgentStream(input.assistantMessageId)
  }, Math.max(1, budget.timeoutSec) * 1000)
  timer.unref?.()

  let status: 'completed' | 'failed' | 'cancelled' = 'completed'
  let failure = ''

  try {
    const rows = listMessages(input.sessionId, {
      limit: Math.min(100, budget.historyMaxMessages + 10),
    }).items
    const history: AssistantHistoryMessage[] = rows
      .filter((row) => row.id !== input.assistantMessageId)
      .filter((row) => row.role === 'user' || (row.role === 'assistant' && String(row.content ?? '').trim().length > 0))
      .map((row) => ({ role: row.role as 'user' | 'assistant', content: String(row.content ?? '') }))
    const trimmed = trimAssistantHistory(history, {
      maxMessages: budget.historyMaxMessages,
      maxChars: budget.maxChars,
      reserveChars: Math.min(budget.maxResultChars, Math.floor(budget.maxChars / 2)),
    })
    const messages: AssistantHistoryMessage[] = [
      { role: 'system', content: buildScopeSummary(input.scope) },
      ...trimmed.messages,
    ]

    const requestContext = buildAssistantRequestContext({
      sessionId: input.sessionId,
      messageId: input.assistantMessageId,
      workspaceKey: input.workspaceKey,
      scope: input.scope,
      preset: input.preset,
      dramaId: input.scope.drama_id,
      episodeId: input.scope.episode_id,
      modelOverride: input.model,
      textConfigId: input.textConfigId,
    })

    const factory = streamFactoryOverride ?? defaultStreamFactory
    const result = await factory({
      preset: input.preset,
      messages,
      requestContext,
      abortSignal: signal,
      maxSteps: budget.maxSteps,
      messageId: input.assistantMessageId,
    })

    for await (const chunk of result.fullStream as AsyncIterable<any>) {
      const type = chunk?.type
      if (type === 'text-delta') {
        const delta = String(chunk?.payload?.text ?? chunk?.text ?? '')
        if (delta) {
          text += delta
          appendAgentDelta(input.assistantMessageId, delta)
        }
        continue
      }
      if (type === 'tool-call') {
        const name = String(chunk?.payload?.toolName ?? chunk?.toolName ?? 'tool')
        const args = chunk?.payload?.args ?? chunk?.args ?? null
        toolCalls.push({ toolName: name, args })
        publishAgentEvent(input.assistantMessageId, 'tool', {
          name,
          status: 'running',
          summary: summarizeArgs(args),
          args,
        })
        continue
      }
      if (type === 'tool-result') {
        const name = String(chunk?.payload?.toolName ?? chunk?.toolName ?? 'tool')
        const isError = Boolean(chunk?.payload?.isError ?? chunk?.isError)
        const raw = rawToolResult(
          chunk?.payload?.result ?? chunk?.result ?? chunk?.payload?.output ?? chunk?.output,
        )
        const clipped = clipText(redactSecrets(raw), budget.maxResultChars)
        const resultStatus: 'done' | 'failed' = isError ? 'failed' : 'done'
        toolResults.push({ toolName: name, result: clipped.text, status: resultStatus })
        publishAgentEvent(input.assistantMessageId, 'tool', {
          name,
          status: resultStatus,
          summary: clipText(redactSecrets(raw), 200).text,
          result: clipped.text,
          ...(clipped.truncated ? { truncated: true } : {}),
        })
        continue
      }
      if (type === 'error') {
        throw errorFromChunk(chunk)
      }
      if (type === 'finish') {
        usage = chunk?.payload?.output?.usage ?? chunk?.payload?.usage ?? null
        continue
      }
    }

    if (signal?.aborted) {
      status = timedOut ? 'failed' : 'cancelled'
      if (timedOut) failure = '请求超时'
    }
  } catch (error) {
    if (timedOut) {
      status = 'failed'
      failure = '请求超时'
    } else if (signal?.aborted) {
      status = 'cancelled'
    } else {
      status = 'failed'
      failure = sanitizeAssistantError(error)
      recordDiagnosticError('assistant', failure)
    }
  } finally {
    clearTimeout(timer)
  }

  const finalText = text || getAgentStreamText(input.assistantMessageId)
  try {
    finishMessage(input.assistantMessageId, {
      content: finalText,
      status,
      toolCalls,
      toolResults,
      ...(failure ? { error: failure } : {}),
    })
  } catch (error) {
    // 取消/归档路由已写入终态并广播 done，这里不再重复
    if (!(error instanceof AgentSessionConflictError)) {
      console.error('[assistant] finish message failed:', error instanceof Error ? error.message : error)
    }
    return
  }

  if (status === 'completed') {
    publishAgentEvent(input.assistantMessageId, 'done', {
      message_id: input.assistantMessageId,
      text: finalText,
      status,
      ...(usage ? { usage } : {}),
    })
  } else if (status === 'cancelled') {
    publishAgentEvent(input.assistantMessageId, 'done', {
      message_id: input.assistantMessageId,
      text: finalText,
      status,
    })
  } else {
    publishAgentEvent(input.assistantMessageId, 'error', {
      message_id: input.assistantMessageId,
      code: timedOut ? 'timeout' : 'assistant_failed',
      message: failure || '模型调用失败',
    })
  }
  closeAgentStream(input.assistantMessageId)
}
