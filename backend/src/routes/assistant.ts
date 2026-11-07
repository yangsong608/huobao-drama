/**
 * 助手会话路由（/assistant）
 * 生成只由 POST /messages 启动；SSE 只订阅，不触发生成。
 */
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { success, badRequest, notFound } from '../utils/response.js'
import { getAgentSettings } from '../services/app-settings.js'
import {
  AgentScopeError,
  parseWorkspaceKey,
  validateAgentScope,
  type AgentScope,
} from '../agents/agent-scope.js'
import {
  AgentSessionConflictError,
  AgentSessionError,
  AgentSessionNotFoundError,
  archiveSession,
  cancelMessage,
  createSession,
  createTurnMessages,
  deleteSession,
  getMessageForSession,
  getRunningAssistantMessage,
  getSessionById,
  listMessages,
  listSessions,
  resolveSession,
  type AgentMessageRow,
  type AgentSessionRow,
} from '../services/agent-sessions.js'
import {
  abortAgentStream,
  closeAgentStream,
  createAgentStream,
  getAgentStreamText,
  publishAgentEvent,
  subscribeAgentStream,
} from '../services/agent-stream.js'
import { runAssistantTurn } from '../services/agent-assistant.js'

const app = new Hono()
const HEARTBEAT_MS = Math.max(100, Number(process.env.AGENT_HEARTBEAT_MS || 15_000))

type Preset = 'assistant' | 'director'

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

async function readJson(c: any): Promise<Record<string, any>> {
  try {
    const body = await c.req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  } catch {
    throw new AgentSessionError('请求体必须是 JSON 对象')
  }
}

function parsePreset(raw: unknown): Preset | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (raw !== 'assistant' && raw !== 'director') {
    throw new AgentScopeError('preset 必须是 assistant 或 director', 422, 'AGENT_SCOPE_INVALID')
  }
  return raw
}

function parseConfigId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) throw new AgentSessionError('config_id 必须是正整数')
  return id
}

function parseScopeJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const { workspace_key: _workspaceKey, ...rest } = parsed
    return rest
  } catch {
    return {}
  }
}

function parseMessageJson(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function serializeSession(row: AgentSessionRow) {
  return {
    id: row.id,
    workspace_key: row.workspaceKey,
    preset: row.preset || 'assistant',
    title: row.title,
    status: row.status,
    last_message_at: row.lastMessageAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function serializeMessage(row: AgentMessageRow) {
  return {
    id: row.id,
    session_id: row.sessionId,
    role: row.role,
    content: row.content || '',
    status: row.status,
    scope: parseMessageJson(row.scopeJson),
    preset: row.preset,
    tool_calls: parseMessageJson(row.toolCallsJson),
    tool_results: parseMessageJson(row.toolResultsJson),
    suggestions: parseMessageJson(row.suggestionsJson),
    model: row.model,
    text_config_id: row.textConfigId,
    error: row.error,
    created_at: row.createdAt,
    finished_at: row.finishedAt,
  }
}

function errorResponse(c: any, error: unknown) {
  if (error instanceof AgentScopeError) {
    return c.json({ code: error.status, message: error.message, error_code: error.code }, error.status)
  }
  if (error instanceof AgentSessionNotFoundError) {
    return c.json({ code: 404, message: error.message, error_code: error.code }, 404)
  }
  if (error instanceof AgentSessionConflictError) {
    return c.json({ code: 409, message: error.message, error_code: error.code }, 409)
  }
  if (error instanceof AgentSessionError) {
    return c.json({ code: 422, message: error.message, error_code: error.code }, 422)
  }
  console.error('[assistant]', error instanceof Error ? error.message : error)
  return c.json({ code: 500, message: '服务器内部错误', error_code: 'AGENT_INTERNAL' }, 500)
}

function dockDisabled(c: any) {
  return c.json({ code: 403, message: '智能体入口已关闭', error_code: 'AGENT_DISABLED' }, 403)
}

/** 只校验线程键与目标存活；具体消息作用域在发消息时再校验 */
function workspaceScope(raw: unknown): AgentScope {
  const key = parseWorkspaceKey(raw)
  const workspaceKey = String(raw).trim()
  const scope: AgentScope = {
    workspace_key: workspaceKey,
    kind: key.kind,
    ...(key.kind === 'novel' ? { novel_id: key.id } : {}),
    ...(key.kind === 'drama' ? { drama_id: key.id } : {}),
  }
  validateAgentScope({ workspaceKey, scope })
  return scope
}

function assertPresetEnabled(preset: Preset) {
  if (preset === 'director' && !getAgentSettings().director.enabled) {
    throw new AgentScopeError('导演专员已关闭', 403, 'AGENT_SCOPE_FORBIDDEN')
  }
}

/** 归档/新对话前中止进行中的回答并广播终态，避免 SSE 悬挂 */
function stopLiveTurn(sessionId: number) {
  const running = getRunningAssistantMessage(sessionId)
  if (!running) return
  const text = getAgentStreamText(running.id) || String(running.content ?? '')
  abortAgentStream(running.id)
  publishAgentEvent(running.id, 'done', {
    message_id: running.id,
    text,
    status: 'cancelled',
  })
  closeAgentStream(running.id)
}

// POST /assistant/sessions/resolve — 按 workspace_key 取活动线程，没有则创建
app.post('/sessions/resolve', async (c) => {
  if (!getAgentSettings().dock.enabled) return dockDisabled(c)
  try {
    const body = await readJson(c)
    const scope = workspaceScope(body.workspace_key)
    const preset = parsePreset(body.preset) ?? 'assistant'
    assertPresetEnabled(preset)
    const session = resolveSession({ workspaceKey: scope.workspace_key, preset })
    const page = listMessages(session.id, { limit: 50 })
    return success(c, {
      session: serializeSession(session),
      messages: page.items.map(serializeMessage),
      has_more: page.has_more,
    })
  } catch (error) {
    return errorResponse(c, error)
  }
})

// POST /assistant/sessions — 新对话：取消并归档旧线程后新建
app.post('/sessions', async (c) => {
  if (!getAgentSettings().dock.enabled) return dockDisabled(c)
  try {
    const body = await readJson(c)
    const scope = workspaceScope(body.workspace_key)
    const preset = parsePreset(body.preset) ?? 'assistant'
    assertPresetEnabled(preset)

    const active = listSessions({ workspaceKey: scope.workspace_key, status: 'active', limit: 1 }).items[0]
    if (active) stopLiveTurn(active.id)
    const session = createSession({ workspaceKey: scope.workspace_key, preset })
    return success(c, { session: serializeSession(session), messages: [], has_more: false })
  } catch (error) {
    return errorResponse(c, error)
  }
})

// GET /assistant/sessions?workspace_key=&status=&limit=&offset=
app.get('/sessions', (c) => {
  try {
    const rawStatus = c.req.query('status') || 'active'
    if (!['active', 'archived', 'all'].includes(rawStatus)) {
      throw new AgentSessionError('status 必须是 active / archived / all')
    }
    const workspaceKey = c.req.query('workspace_key')?.trim() || undefined
    const limit = Number(c.req.query('limit') ?? 20)
    const offset = Number(c.req.query('offset') ?? 0)
    const page = listSessions({
      ...(workspaceKey ? { workspaceKey } : {}),
      status: rawStatus as 'active' | 'archived' | 'all',
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(Number.isFinite(offset) ? { offset } : {}),
    })
    return success(c, { items: page.items.map(serializeSession), has_more: page.has_more })
  } catch (error) {
    return errorResponse(c, error)
  }
})

// GET /assistant/sessions/:id?before_id=&limit=
app.get('/sessions/:id', (c) => {
  const sessionId = parseId(c.req.param('id'))
  if (!sessionId) return badRequest(c, '会话编号无效')
  try {
    const session = getSessionById(sessionId)
    const rawBefore = c.req.query('before_id')
    const beforeId = rawBefore ? parseId(rawBefore) : null
    if (rawBefore && !beforeId) throw new AgentSessionError('before_id 无效')
    const limit = Number(c.req.query('limit') ?? 50)
    const page = listMessages(sessionId, {
      ...(beforeId ? { beforeId } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    })
    return success(c, {
      session: serializeSession(session),
      messages: page.items.map(serializeMessage),
      has_more: page.has_more,
    })
  } catch (error) {
    return errorResponse(c, error)
  }
})

// POST /assistant/sessions/:id/messages
app.post('/sessions/:id/messages', async (c) => {
  if (!getAgentSettings().dock.enabled) return dockDisabled(c)
  const sessionId = parseId(c.req.param('id'))
  if (!sessionId) return badRequest(c, '会话编号无效')
  try {
    const settings = getAgentSettings()
    const body = await readJson(c)
    const session = getSessionById(sessionId)
    if (session.status !== 'active') throw new AgentSessionConflictError('会话已归档，请新建对话')

    const content = String(body.message ?? '').trim()
    if (!content) throw new AgentSessionError('消息内容不能为空')
    if (content.length > settings.message.maxChars) {
      throw new AgentSessionError(`消息长度不能超过 ${settings.message.maxChars} 字`)
    }

    const preset = parsePreset(body.preset) ?? ((session.preset === 'director' ? 'director' : 'assistant') as Preset)
    if (session.preset && session.preset !== preset) {
      throw new AgentSessionError('线程预设与请求预设不一致')
    }
    const scope = validateAgentScope({
      workspaceKey: session.workspaceKey,
      scope: body.scope,
      preset,
      allowDirector: settings.director.enabled,
    })

    const requestModel = typeof body.model === 'string' ? body.model.trim() : ''
    const configId = parseConfigId(body.config_id)
    const effectiveModel = requestModel
      || (preset === 'director' ? settings.director.model : settings.model)
      || null

    const { userMessage, assistantMessage } = createTurnMessages({
      sessionId,
      content,
      scope,
      preset,
      model: effectiveModel,
      textConfigId: configId ?? null,
    })

    createAgentStream({
      messageId: assistantMessage.id,
      sessionId,
      model: effectiveModel,
      preset,
      scope: parseScopeJson(JSON.stringify(scope)),
    })

    const run = runAssistantTurn({
      sessionId,
      workspaceKey: session.workspaceKey,
      scope,
      preset,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      ...(requestModel ? { model: requestModel } : {}),
      ...(configId ? { textConfigId: configId } : {}),
    })

    if (settings.stream.enabled) {
      void run
      return success(c, {
        user_message_id: userMessage.id,
        assistant_message_id: assistantMessage.id,
        stream_url: `/api/v1/assistant/sessions/${sessionId}/stream?message_id=${assistantMessage.id}`,
      })
    }

    await run
    const final = getMessageForSession(sessionId, assistantMessage.id) ?? assistantMessage
    return success(c, {
      user_message_id: userMessage.id,
      assistant_message_id: assistantMessage.id,
      text: final.content || '',
      status: final.status,
    })
  } catch (error) {
    return errorResponse(c, error)
  }
})

// GET /assistant/sessions/:id/stream?message_id=&after_seq=
app.get('/sessions/:id/stream', (c) => {
  const sessionId = parseId(c.req.param('id'))
  if (!sessionId) return badRequest(c, '会话编号无效')
  const messageId = parseId(c.req.query('message_id'))
  if (!messageId) return badRequest(c, 'message_id 无效')

  let message: AgentMessageRow | null = null
  try {
    getSessionById(sessionId)
    message = getMessageForSession(sessionId, messageId)
  } catch (error) {
    return errorResponse(c, error)
  }
  if (!message) return notFound(c, '消息不存在')

  const rawAfter = Number(c.req.query('after_seq') ?? 0)
  const afterSeq = Number.isFinite(rawAfter) && rawAfter > 0 ? Math.floor(rawAfter) : 0

  if (message.status !== 'running') {
    return streamSSE(c, async (stream) => {
      const scope = parseScopeJson(message!.scopeJson)
      await stream.writeSSE({
        event: 'start',
        data: JSON.stringify({ message_id: message!.id, model: message!.model || '', preset: message!.preset || 'assistant', seq: 0 }),
      })
      await stream.writeSSE({ event: 'scope', data: JSON.stringify({ ...scope, seq: 0 }) })
      if (message!.content) {
        await stream.writeSSE({ event: 'reset', data: JSON.stringify({ text: message!.content, seq: 0 }) })
      }
      if (message!.status === 'failed' || message!.status === 'interrupted') {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            message_id: message!.id,
            code: message!.status === 'interrupted' ? 'interrupted' : 'assistant_failed',
            message: message!.error || '生成失败',
          }),
        })
      } else {
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ message_id: message!.id, text: message!.content || '', status: message!.status }),
        })
      }
    })
  }

  return streamSSE(c, async (stream) => {
    let closed = false
    let release: (() => void) | undefined
    const finished = new Promise<void>((resolve) => { release = resolve })
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let chain: Promise<void> = Promise.resolve()
    let subscription: ReturnType<typeof subscribeAgentStream> = null

    const write = (event: string, data: Record<string, unknown>) => {
      chain = chain
        .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
        .then(() => {})
        .catch(() => {})
      return chain
    }

    const cleanup = () => {
      if (closed) return
      closed = true
      subscription?.unsubscribe()
      if (heartbeat) clearInterval(heartbeat)
      c.req.raw.signal.removeEventListener('abort', cleanup)
      release?.()
    }

    subscription = subscribeAgentStream(messageId, afterSeq, (event) => {
      write(event.event, event.data)
      if (event.event === 'done' || event.event === 'error') cleanup()
    })

    if (!subscription) {
      await write('reset', { text: message!.content || '', seq: 0 })
      await write('error', { message_id: messageId, code: 'interrupted', message: '生成已中断' })
      return
    }

    stream.onAbort(cleanup)
    c.req.raw.signal.addEventListener('abort', cleanup)
    heartbeat = setInterval(() => {
      chain = chain.then(() => stream.write(': ping\n\n')).then(() => {}).catch(() => {})
    }, HEARTBEAT_MS)

    try {
      if (subscription.reset) {
        await write('start', { ...subscription.start, seq: 0 })
        await write('scope', { ...subscription.scope, seq: 0 })
        await write('reset', { text: subscription.reset.text, seq: subscription.reset.seq })
        if (subscription.terminal) {
          await write(subscription.terminal.event, subscription.terminal.data)
          cleanup()
        }
      } else {
        for (const event of subscription.initial) {
          await write(event.event, event.data)
          if (event.event === 'done' || event.event === 'error') cleanup()
        }
      }
      if (!closed) subscription.activate()
      await finished
      await chain
    } finally {
      cleanup()
    }
  })
})

// POST /assistant/sessions/:id/cancel
app.post('/sessions/:id/cancel', (c) => {
  const sessionId = parseId(c.req.param('id'))
  if (!sessionId) return badRequest(c, '会话编号无效')
  try {
    getSessionById(sessionId)
    const running = getRunningAssistantMessage(sessionId)
    if (!running) throw new AgentSessionConflictError('没有进行中的回答')
    const text = getAgentStreamText(running.id) || String(running.content ?? '')
    abortAgentStream(running.id)
    const updated = cancelMessage(running.id, text)
    publishAgentEvent(running.id, 'done', {
      message_id: running.id,
      text,
      status: 'cancelled',
    })
    closeAgentStream(running.id)
    return success(c, { message: serializeMessage(updated) })
  } catch (error) {
    return errorResponse(c, error)
  }
})

// POST /assistant/sessions/:id/archive
app.post('/sessions/:id/archive', (c) => {
  const sessionId = parseId(c.req.param('id'))
  if (!sessionId) return badRequest(c, '会话编号无效')
  try {
    stopLiveTurn(sessionId)
    const session = archiveSession(sessionId)
    return success(c, { session: serializeSession(session) })
  } catch (error) {
    return errorResponse(c, error)
  }
})

// DELETE /assistant/sessions/:id — 软删除
app.delete('/sessions/:id', (c) => {
  const sessionId = parseId(c.req.param('id'))
  if (!sessionId) return badRequest(c, '会话编号无效')
  try {
    stopLiveTurn(sessionId)
    const session = deleteSession(sessionId)
    return success(c, { session: serializeSession(session) })
  } catch (error) {
    return errorResponse(c, error)
  }
})

export default app
