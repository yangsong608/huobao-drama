import crypto from 'node:crypto'
import type { AgentTaskAccepted, AgentTaskRequest, AgentTaskView } from '../shared/contracts.js'
import { BridgeError } from '../shared/errors.js'
import { resolveRoleModel, type BridgeConfig } from '../shared/config.js'
import { isAgentRole } from '../shared/roles.js'
import type { Logger } from './logger.js'
import type { StoredTask, TaskRegistry } from './task-registry.js'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export interface ToolRegistry {
  register(definition: ToolDefinition): unknown
}

export interface AgentScopedContext {
  tools?: ToolRegistry
  get?: (name: string, strict?: boolean) => unknown
}

export interface AgentSessionLike {
  deriveMessages?: () => unknown[]
}

export interface AgentLike {
  followup(message: unknown): void
  whenIdle(): Promise<void>
  cancel(cause: unknown): void
  session?: AgentSessionLike
}

export interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

export interface AgentsService {
  create(options: unknown): Promise<AgentHandleLike>
}

export interface AgentBridgeDeps {
  agents?: AgentsService
  config: BridgeConfig
  registry: TaskRegistry
  logger: Logger
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BridgeError('INVALID_REQUEST', `${name} 必填且必须是非空字符串`)
  }
  return value.trim()
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BridgeError('INVALID_REQUEST', `${name} 必填且必须是数字`)
  }
  return value
}

function normalizeRequest(body: unknown): AgentTaskRequest {
  if (!isRecord(body)) throw new BridgeError('INVALID_REQUEST', '请求体必须是 JSON 对象')
  const role = body.role
  if (!isAgentRole(role)) throw new BridgeError('INVALID_REQUEST', 'role 必须是 7 个 Agent 角色之一')
  const input = body.input
  if (!isRecord(input)) throw new BridgeError('INVALID_REQUEST', 'input 必须是对象')
  return {
    idempotencyKey: requiredString(body.idempotencyKey, 'idempotencyKey'),
    huobaoTaskId: requiredNumber(body.huobaoTaskId, 'huobaoTaskId'),
    role,
    taskType: requiredString(body.taskType, 'taskType'),
    dramaId: requiredNumber(body.dramaId, 'dramaId'),
    episodeId: typeof body.episodeId === 'number' ? body.episodeId : undefined,
    input,
    contentLanguage: typeof body.contentLanguage === 'string' ? body.contentLanguage : undefined,
    callbackUrl: typeof body.callbackUrl === 'string' ? body.callbackUrl : undefined,
    deadlineMs: typeof body.deadlineMs === 'number' ? body.deadlineMs : undefined,
    traceId: typeof body.traceId === 'string' ? body.traceId : undefined,
  }
}

function resolveTools(agentCtx: AgentScopedContext): ToolRegistry {
  const direct = agentCtx.tools
  if (direct !== undefined && typeof direct.register === 'function') return direct
  const fromGet = typeof agentCtx.get === 'function' ? agentCtx.get('tools', false) : undefined
  if (isRecord(fromGet) && typeof fromGet.register === 'function') {
    return fromGet as unknown as ToolRegistry
  }
  throw new BridgeError('BRIDGE_UNAVAILABLE', 'DSH 工具服务不可用，无法注册完成工具')
}

function buildPrompt(request: AgentTaskRequest, dshTaskId: string): string {
  const input = JSON.stringify(request.input)
  const episode = request.episodeId === undefined ? '未指定' : String(request.episodeId)
  const language = request.contentLanguage ?? 'zh'
  return [
    `你是火宝短剧的 ${request.role}，任务类型为 ${request.taskType}。`,
    `项目 ID：${request.dramaId}；剧集 ID：${episode}；内容语言：${language}。`,
    `输入数据（JSON）：${input}`,
    '',
    '执行要求：',
    '1. 只处理当前任务，不要修改无关项目或剧集。',
    '2. 完成或失败后，必须调用工具 huobao_task_complete，不要只在回复里说明。',
    `3. 调用时 taskId 必须是 "${dshTaskId}"。`,
    '4. 成功时 status 传 "succeeded"，把结构化结果放在 result；失败时 status 传 "failed"，并填 errorCode/errorMessage。',
    '5. summary 必填，用一句中文说明结果。',
  ].join('\n')
}

function readAssistantText(handle: AgentHandleLike): string | undefined {
  const messages = handle.agent.session?.deriveMessages?.()
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

function completionTool(
  dshTaskId: string,
  registry: TaskRegistry,
): ToolDefinition {
  return {
    name: 'huobao_task_complete',
    description: '提交火宝短剧任务结果。任务成功或失败后必须调用一次；这是唯一的完成信号。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'DSH 任务 ID，必须与提示中的 taskId 一致' },
        status: { type: 'string', enum: ['succeeded', 'failed'] },
        result: { type: 'object', description: '结构化业务结果' },
        errorCode: { type: 'string' },
        errorMessage: { type: 'string' },
        summary: { type: 'string', description: '一句中文结果说明' },
      },
      required: ['taskId', 'status', 'summary'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          taskId: { type: 'string' },
          status: { type: 'string' },
          error: { type: 'string' },
        },
      },
    },
    execute: async (args) => {
      if (args.taskId !== dshTaskId) {
        return { ok: false, taskId: dshTaskId, error: 'taskId 不匹配' }
      }
      if (typeof args.summary !== 'string' || args.summary.trim() === '') {
        return { ok: false, taskId: dshTaskId, error: 'summary 必填' }
      }
      if (args.status !== 'succeeded' && args.status !== 'failed') {
        return { ok: false, taskId: dshTaskId, error: 'status 必须是 succeeded 或 failed' }
      }
      try {
        const task = registry.completeFromTool(dshTaskId, args)
        return { ok: true, taskId: dshTaskId, status: task.status }
      } catch (cause) {
        return {
          ok: false,
          taskId: dshTaskId,
          error: cause instanceof Error ? cause.message : String(cause),
        }
      }
    },
  }
}

async function runAgentTask(
  handle: AgentHandleLike,
  task: StoredTask,
  deps: AgentBridgeDeps,
): Promise<void> {
  const timeoutMs = deps.config.timeouts.agentMs
  try {
    const settled = await Promise.race([
      deps.registry.waitForCompletion(task.dshTaskId, timeoutMs),
      handle.agent.whenIdle().then(() => null),
    ])
    if (settled === null) {
      const text = readAssistantText(handle)
      deps.registry.failIfActive(
        task.dshTaskId,
        'INCOMPLETE_OUTPUT',
        text === undefined
          ? 'Agent 空闲但未调用 huobao_task_complete'
          : `Agent 空闲但未调用 huobao_task_complete；最后回复：${text.slice(0, 300)}`,
      )
    }
  } catch (cause) {
    if (cause instanceof BridgeError && cause.code === 'TIMEOUT') {
      deps.registry.failIfActive(task.dshTaskId, 'TIMEOUT', cause.message)
      try {
        handle.agent.cancel({ kind: 'user' })
      } catch {
        /* 取消失败不覆盖超时状态 */
      }
      return
    }
    deps.registry.failIfActive(
      task.dshTaskId,
      'UPSTREAM_ERROR',
      cause instanceof Error ? cause.message : String(cause),
    )
  }
}

export async function startAgentTask(body: unknown, deps: AgentBridgeDeps): Promise<AgentTaskAccepted> {
  const request = normalizeRequest(body)
  const existingTask = deps.registry.findByIdempotencyKey(request.idempotencyKey)
  if (existingTask !== undefined) {
    return {
      dshTaskId: existingTask.dshTaskId,
      dshSessionId: existingTask.dshSessionId ?? '',
      status: 'accepted',
      acceptedAt: existingTask.createdAt,
      existing: true,
    }
  }
  if (deps.registry.activeCount() >= deps.config.maxAgentTasks) {
    throw new BridgeError('BUSY', `并发 Agent 任务已达上限 ${deps.config.maxAgentTasks}`)
  }
  if (!deps.agents || typeof deps.agents.create !== 'function') {
    throw new BridgeError('BRIDGE_UNAVAILABLE', 'DSH Agent 服务不可用')
  }

  const dshTaskId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const { task, existing } = deps.registry.create({
    dshTaskId,
    huobaoTaskId: request.huobaoTaskId,
    role: request.role,
    taskType: request.taskType,
    idempotencyKey: request.idempotencyKey,
    traceId: request.traceId,
  })
  if (existing) {
    return {
      dshTaskId: task.dshTaskId,
      dshSessionId: task.dshSessionId ?? '',
      status: 'accepted',
      acceptedAt: task.createdAt,
      existing: true,
    }
  }

  const model = resolveRoleModel(deps.config, request.role)
  const prompt = buildPrompt(request, dshTaskId)
  let handle: AgentHandleLike
  try {
    handle = await deps.agents.create({
      sessionId,
      agentOptions: { provider: model.provider, model: model.model },
      setup: (agentCtx: AgentScopedContext) => {
        const tools = resolveTools(agentCtx)
        tools.register(completionTool(dshTaskId, deps.registry))
      },
    })
  } catch (cause) {
    deps.registry.fail(dshTaskId, 'UPSTREAM_ERROR', cause instanceof Error ? cause.message : String(cause))
    throw new BridgeError('UPSTREAM_ERROR', cause instanceof Error ? cause.message : String(cause))
  }

  deps.registry.setRunning(dshTaskId, sessionId)
  deps.registry.attachHandle(dshTaskId, handle)
  try {
    handle.agent.followup({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'moss-huobao' },
    })
  } catch (cause) {
    deps.registry.fail(dshTaskId, 'UPSTREAM_ERROR', cause instanceof Error ? cause.message : String(cause))
    throw new BridgeError('UPSTREAM_ERROR', cause instanceof Error ? cause.message : String(cause))
  }

  void runAgentTask(handle, task, deps)
  deps.logger.info(`Agent 任务已派发：${dshTaskId} role=${request.role} huobaoTask=${request.huobaoTaskId}`)
  return {
    dshTaskId,
    dshSessionId: sessionId,
    status: 'accepted',
    acceptedAt: new Date().toISOString(),
  }
}

export function getAgentTask(id: string, registry: TaskRegistry): AgentTaskView {
  const task = registry.get(id)
  if (task === undefined) throw new BridgeError('NOT_FOUND', `任务 ${id} 不存在`)
  return registry.toView(task)
}

export function listAgentTasks(registry: TaskRegistry): AgentTaskView[] {
  return registry.list().map(task => registry.toView(task))
}

export function cancelAgentTask(id: string, registry: TaskRegistry): AgentTaskView {
  const task = registry.cancel(id)
  const handle = registry.getHandle(id)
  if (handle?.agent !== undefined) {
    try {
      handle.agent.cancel({ kind: 'user' })
    } catch {
      /* 取消失败不改变已记录状态 */
    }
  }
  return registry.toView(task)
}
