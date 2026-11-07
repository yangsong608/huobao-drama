/**
 * 智能体会话与消息服务
 * 只读写 agent_sessions / agent_messages（软删会话时同步处理 agent_proposals 过期），不写业务表。
 */
import { and, asc, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export class AgentSessionError extends Error {
  readonly code: string
  constructor(message: string, code = 'AGENT_SESSION_INVALID') {
    super(message)
    this.name = 'AgentSessionError'
    this.code = code
  }
}

export class AgentSessionNotFoundError extends AgentSessionError {
  constructor() {
    super('会话不存在', 'AGENT_SESSION_NOT_FOUND')
    this.name = 'AgentSessionNotFoundError'
  }
}

export class AgentSessionConflictError extends AgentSessionError {
  constructor(message = '当前回答仍在生成，请稍候') {
    super(message, 'AGENT_SESSION_CONFLICT')
    this.name = 'AgentSessionConflictError'
  }
}

export type AgentSessionRow = typeof schema.agentSessions.$inferSelect
export type AgentMessageRow = typeof schema.agentMessages.$inferSelect

const MESSAGE_STATUSES = ['completed', 'running', 'failed', 'cancelled', 'interrupted'] as const
const FINAL_ASSISTANT_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'] as const

function isUniqueWorkspaceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /UNIQUE constraint failed: agent_sessions\.workspace_key/.test(message)
    || /idx_agent_sessions_active/.test(message)
}

function activeSession(workspaceKey: string): AgentSessionRow | undefined {
  return db.select().from(schema.agentSessions)
    .where(and(
      eq(schema.agentSessions.workspaceKey, workspaceKey),
      eq(schema.agentSessions.status, 'active'),
      isNull(schema.agentSessions.deletedAt),
    ))
    .get()
}

function sessionById(sessionId: number): AgentSessionRow | undefined {
  return db.select().from(schema.agentSessions)
    .where(and(eq(schema.agentSessions.id, sessionId), isNull(schema.agentSessions.deletedAt)))
    .get()
}

function requireSession(sessionId: number): AgentSessionRow {
  const row = sessionById(sessionId)
  if (!row) throw new AgentSessionNotFoundError()
  return row
}

function cancelRunningMessages(tx: any, sessionId: number, content?: string) {
  const ts = now()
  tx.update(schema.agentMessages)
    .set({
      status: 'cancelled',
      finishedAt: ts,
      ...(content !== undefined ? { content } : {}),
    })
    .where(and(
      eq(schema.agentMessages.sessionId, sessionId),
      eq(schema.agentMessages.role, 'assistant'),
      eq(schema.agentMessages.status, 'running'),
    ))
    .run()
}

/** 按 workspace_key 取活动线程；不存在时创建。并发命中唯一索引时重读已存在线程 */
export function resolveSession(input: { workspaceKey: string; preset?: string; title?: string | null }): AgentSessionRow {
  const workspaceKey = String(input.workspaceKey || '').trim()
  if (!workspaceKey) throw new AgentSessionError('workspace_key 必填')
  const existing = activeSession(workspaceKey)
  if (existing) return existing

  const ts = now()
  try {
    const insert = db.insert(schema.agentSessions).values({
      workspaceKey,
      preset: input.preset || 'assistant',
      title: input.title ?? null,
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    }).run()
    const created = db.select().from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, Number(insert.lastInsertRowid)))
      .get()
    if (!created) throw new AgentSessionError('会话创建失败')
    return created
  } catch (error) {
    if (!isUniqueWorkspaceError(error)) throw error
    const raced = activeSession(workspaceKey)
    if (raced) return raced
    throw error
  }
}

/** 新对话：取消进行中回答 → 归档旧线程 → 创建新线程（同一事务） */
export function createSession(input: { workspaceKey: string; preset?: string; title?: string | null }): AgentSessionRow {
  const workspaceKey = String(input.workspaceKey || '').trim()
  if (!workspaceKey) throw new AgentSessionError('workspace_key 必填')
  const ts = now()
  return db.transaction((tx) => {
    const previous = tx.select().from(schema.agentSessions)
      .where(and(
        eq(schema.agentSessions.workspaceKey, workspaceKey),
        eq(schema.agentSessions.status, 'active'),
        isNull(schema.agentSessions.deletedAt),
      ))
      .get()
    if (previous) {
      cancelRunningMessages(tx, previous.id)
      tx.update(schema.agentSessions)
        .set({ status: 'archived', updatedAt: ts })
        .where(eq(schema.agentSessions.id, previous.id))
        .run()
    }
    const insert = tx.insert(schema.agentSessions).values({
      workspaceKey,
      preset: input.preset || 'assistant',
      title: input.title ?? null,
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    }).run()
    const created = tx.select().from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, Number(insert.lastInsertRowid)))
      .get()
    if (!created) throw new AgentSessionError('会话创建失败')
    return created
  })
}

export function listSessions(options: { workspaceKey?: string; status?: 'active' | 'archived' | 'all'; limit?: number; offset?: number } = {}) {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)))
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const conditions = [isNull(schema.agentSessions.deletedAt)]
  if (options.workspaceKey) conditions.push(eq(schema.agentSessions.workspaceKey, options.workspaceKey))
  if (options.status && options.status !== 'all') conditions.push(eq(schema.agentSessions.status, options.status))

  const rows = db.select().from(schema.agentSessions)
    .where(and(...conditions))
    .orderBy(desc(sql`COALESCE(${schema.agentSessions.lastMessageAt}, ${schema.agentSessions.createdAt})`), desc(schema.agentSessions.id))
    .limit(limit + 1)
    .offset(offset)
    .all()
  return { items: rows.slice(0, limit), has_more: rows.length > limit }
}

export function getSessionById(sessionId: number): AgentSessionRow {
  return requireSession(sessionId)
}

export function getSessionDetail(sessionId: number, messageLimit = 20) {
  const session = requireSession(sessionId)
  const messages = listMessages(sessionId, { limit: messageLimit })
  return { session, messages: messages.items, has_more: messages.has_more }
}

export function archiveSession(sessionId: number): AgentSessionRow {
  const session = requireSession(sessionId)
  const ts = now()
  return db.transaction((tx) => {
    cancelRunningMessages(tx, session.id)
    tx.update(schema.agentSessions)
      .set({ status: 'archived', updatedAt: ts })
      .where(eq(schema.agentSessions.id, session.id))
      .run()
    const updated = tx.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, session.id)).get()
    if (!updated) throw new AgentSessionNotFoundError()
    return updated
  })
}

/** 软删除会话；未处理提案置 expired，会话与消息保留 */
export function deleteSession(sessionId: number): AgentSessionRow {
  const session = requireSession(sessionId)
  const ts = now()
  return db.transaction((tx) => {
    cancelRunningMessages(tx, session.id)
    tx.update(schema.agentSessions)
      .set({ status: 'archived', deletedAt: ts, updatedAt: ts })
      .where(eq(schema.agentSessions.id, session.id))
      .run()
    tx.update(schema.agentProposals)
      .set({ status: 'expired', updatedAt: ts })
      .where(and(
        eq(schema.agentProposals.sessionId, session.id),
        eq(schema.agentProposals.status, 'proposed'),
      ))
      .run()
    const updated = tx.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, session.id)).get()
    if (!updated) throw new AgentSessionNotFoundError()
    return updated
  })
}

function sessionTitle(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 40)
}

function touchSession(tx: any, sessionId: number, ts: string, contentForTitle?: string) {
  const session = tx.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)).get()
  if (!session) throw new AgentSessionNotFoundError()
  tx.update(schema.agentSessions).set({
    lastMessageAt: ts,
    updatedAt: ts,
    ...(!session.title && contentForTitle ? { title: sessionTitle(contentForTitle) } : {}),
  }).where(eq(schema.agentSessions.id, sessionId)).run()
}

export function createUserMessage(input: {
  sessionId: number
  content: string
  scope?: unknown
  preset?: string
}): AgentMessageRow {
  const content = String(input.content ?? '').trim()
  if (!content) throw new AgentSessionError('消息内容不能为空')
  requireSession(input.sessionId)
  const ts = now()
  return db.transaction((tx) => {
    const insert = tx.insert(schema.agentMessages).values({
      sessionId: input.sessionId,
      role: 'user',
      content,
      status: 'completed',
      scopeJson: input.scope === undefined ? null : JSON.stringify(input.scope),
      preset: input.preset ?? null,
      createdAt: ts,
      finishedAt: ts,
    }).run()
    touchSession(tx, input.sessionId, ts, content)
    const row = tx.select().from(schema.agentMessages)
      .where(eq(schema.agentMessages.id, Number(insert.lastInsertRowid)))
      .get()
    if (!row) throw new AgentSessionError('消息写入失败')
    return row
  })
}

export function createAssistantMessage(input: {
  sessionId: number
  scope?: unknown
  preset?: string
  model?: string | null
  textConfigId?: number | null
}): AgentMessageRow {
  const session = requireSession(input.sessionId)
  if (session.status !== 'active') throw new AgentSessionConflictError('会话已归档，请新建对话')
  const running = db.select().from(schema.agentMessages)
    .where(and(
      eq(schema.agentMessages.sessionId, input.sessionId),
      eq(schema.agentMessages.role, 'assistant'),
      eq(schema.agentMessages.status, 'running'),
    ))
    .get()
  if (running) throw new AgentSessionConflictError()

  const ts = now()
  try {
    return db.transaction((tx) => {
      const insert = tx.insert(schema.agentMessages).values({
        sessionId: input.sessionId,
        role: 'assistant',
        content: '',
        status: 'running',
        scopeJson: input.scope === undefined ? null : JSON.stringify(input.scope),
        preset: input.preset ?? null,
        model: input.model ?? null,
        textConfigId: input.textConfigId ?? null,
        createdAt: ts,
      }).run()
      touchSession(tx, input.sessionId, ts)
      const row = tx.select().from(schema.agentMessages)
        .where(eq(schema.agentMessages.id, Number(insert.lastInsertRowid)))
        .get()
      if (!row) throw new AgentSessionError('消息写入失败')
      return row
    })
  } catch (error) {
    if (error instanceof Error && /idx_agent_messages_running|UNIQUE constraint failed: agent_messages\.session_id/.test(error.message)) {
      throw new AgentSessionConflictError()
    }
    throw error
  }
}

export function finishMessage(messageId: number, patch: {
  content?: string
  status?: (typeof FINAL_ASSISTANT_STATUSES)[number]
  toolCalls?: unknown
  toolResults?: unknown
  suggestions?: unknown
  error?: string | null
  model?: string | null
  textConfigId?: number | null
}): AgentMessageRow {
  const status = patch.status ?? 'completed'
  if (!(FINAL_ASSISTANT_STATUSES as readonly string[]).includes(status)) {
    throw new AgentSessionError(`消息状态无效：${status}`)
  }
  const row = db.select().from(schema.agentMessages).where(eq(schema.agentMessages.id, messageId)).get()
  if (!row) throw new AgentSessionError('消息不存在', 'AGENT_MESSAGE_NOT_FOUND')
  if (row.status !== 'running') throw new AgentSessionConflictError('消息已结束，不能重复写入')

  const ts = now()
  db.update(schema.agentMessages).set({
    ...(patch.content !== undefined ? { content: patch.content } : {}),
    status,
    ...(patch.toolCalls !== undefined ? { toolCallsJson: JSON.stringify(patch.toolCalls) } : {}),
    ...(patch.toolResults !== undefined ? { toolResultsJson: JSON.stringify(patch.toolResults) } : {}),
    ...(patch.suggestions !== undefined ? { suggestionsJson: JSON.stringify(patch.suggestions) } : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.textConfigId !== undefined ? { textConfigId: patch.textConfigId } : {}),
    finishedAt: ts,
  }).where(eq(schema.agentMessages.id, messageId)).run()

  const updated = db.select().from(schema.agentMessages).where(eq(schema.agentMessages.id, messageId)).get()
  if (!updated) throw new AgentSessionError('消息不存在', 'AGENT_MESSAGE_NOT_FOUND')
  return updated
}

export function cancelMessage(messageId: number, partialContent?: string): AgentMessageRow {
  const row = db.select().from(schema.agentMessages).where(eq(schema.agentMessages.id, messageId)).get()
  if (!row) throw new AgentSessionError('消息不存在', 'AGENT_MESSAGE_NOT_FOUND')
  if (row.status !== 'running') throw new AgentSessionConflictError('消息已结束，不能取消')
  return finishMessage(messageId, {
    ...(partialContent !== undefined ? { content: partialContent } : {}),
    status: 'cancelled',
  })
}

/** 同一事务内落库用户消息与 running 助手消息；已有 running 回答时 409 */
export function createTurnMessages(input: {
  sessionId: number
  content: string
  scope?: unknown
  preset?: string
  model?: string | null
  textConfigId?: number | null
}): { userMessage: AgentMessageRow; assistantMessage: AgentMessageRow } {
  const content = String(input.content ?? '').trim()
  if (!content) throw new AgentSessionError('消息内容不能为空')
  const session = requireSession(input.sessionId)
  if (session.status !== 'active') throw new AgentSessionConflictError('会话已归档，请新建对话')
  const ts = now()
  try {
    return db.transaction((tx) => {
      const running = tx.select().from(schema.agentMessages)
        .where(and(
          eq(schema.agentMessages.sessionId, input.sessionId),
          eq(schema.agentMessages.role, 'assistant'),
          eq(schema.agentMessages.status, 'running'),
        ))
        .get()
      if (running) throw new AgentSessionConflictError()

      const userInsert = tx.insert(schema.agentMessages).values({
        sessionId: input.sessionId,
        role: 'user',
        content,
        status: 'completed',
        scopeJson: input.scope === undefined ? null : JSON.stringify(input.scope),
        preset: input.preset ?? null,
        createdAt: ts,
        finishedAt: ts,
      }).run()
      const assistantInsert = tx.insert(schema.agentMessages).values({
        sessionId: input.sessionId,
        role: 'assistant',
        content: '',
        status: 'running',
        scopeJson: input.scope === undefined ? null : JSON.stringify(input.scope),
        preset: input.preset ?? null,
        model: input.model ?? null,
        textConfigId: input.textConfigId ?? null,
        createdAt: ts,
      }).run()
      touchSession(tx, input.sessionId, ts, content)
      const userMessage = tx.select().from(schema.agentMessages)
        .where(eq(schema.agentMessages.id, Number(userInsert.lastInsertRowid)))
        .get()
      const assistantMessage = tx.select().from(schema.agentMessages)
        .where(eq(schema.agentMessages.id, Number(assistantInsert.lastInsertRowid)))
        .get()
      if (!userMessage || !assistantMessage) throw new AgentSessionError('消息写入失败')
      return { userMessage, assistantMessage }
    })
  } catch (error) {
    if (error instanceof Error && /idx_agent_messages_running|UNIQUE constraint failed: agent_messages\.session_id/.test(error.message)) {
      throw new AgentSessionConflictError()
    }
    throw error
  }
}

export function getMessageForSession(sessionId: number, messageId: number): AgentMessageRow | null {
  return db.select().from(schema.agentMessages)
    .where(and(eq(schema.agentMessages.id, messageId), eq(schema.agentMessages.sessionId, sessionId)))
    .get() ?? null
}

export function getRunningAssistantMessage(sessionId: number): AgentMessageRow | null {
  return db.select().from(schema.agentMessages)
    .where(and(
      eq(schema.agentMessages.sessionId, sessionId),
      eq(schema.agentMessages.role, 'assistant'),
      eq(schema.agentMessages.status, 'running'),
    ))
    .get() ?? null
}

/** 启动恢复：残留 running 助手消息置 interrupted，本轮提案过期、建议清空 */
export function recoverInterruptedMessages(): number {
  const ts = now()
  const rows = db.select().from(schema.agentMessages)
    .where(and(eq(schema.agentMessages.role, 'assistant'), eq(schema.agentMessages.status, 'running')))
    .all()
  if (!rows.length) return 0
  db.transaction((tx) => {
    for (const row of rows) {
      tx.update(schema.agentMessages)
        .set({ status: 'interrupted', error: 'process_restart', suggestionsJson: null, finishedAt: ts })
        .where(eq(schema.agentMessages.id, row.id))
        .run()
      tx.update(schema.agentProposals)
        .set({ status: 'expired', error: 'process_restart', updatedAt: ts })
        .where(and(
          eq(schema.agentProposals.messageId, row.id),
          eq(schema.agentProposals.status, 'proposed'),
        ))
        .run()
    }
  })
  return rows.length
}

export function listMessages(sessionId: number, options: { beforeId?: number; limit?: number } = {}) {
  requireSession(sessionId)
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)))
  const conditions = [eq(schema.agentMessages.sessionId, sessionId)]
  if (options.beforeId) conditions.push(lt(schema.agentMessages.id, options.beforeId))
  const rows = db.select().from(schema.agentMessages)
    .where(and(...conditions))
    .orderBy(desc(schema.agentMessages.id))
    .limit(limit + 1)
    .all()
  const hasMore = rows.length > limit
  return { items: rows.slice(0, limit).reverse(), has_more: hasMore }
}
