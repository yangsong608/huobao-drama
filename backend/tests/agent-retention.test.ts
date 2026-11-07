/**
 * A4-2 会话保留清理：30 天边界、仅归档/软删除、活动会话不动、
 * 清空消息正文/工具/建议但保留消息行与会话壳、提案保留、幂等。
 * 隔离 SQLite。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-retention-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'storage')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { cleanupExpiredAgentSessions, deleteSession } = await import('../src/services/agent-sessions.ts')
const { getAgentSettings, setAgentSettings } = await import('../src/services/app-settings.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const NOW = new Date('2026-11-08T12:00:00.000Z')
const iso = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()

function insertSession(input: { status?: string; lastMessageDays: number | null; createdDays?: number; deletedAt?: string | null; workspaceKey?: string }) {
  const created = iso(input.createdDays ?? 60)
  return db.insert(schema.agentSessions).values({
    workspaceKey: input.workspaceKey ?? 'novel-library',
    preset: 'assistant',
    title: `会话-${input.status ?? 'active'}`,
    status: input.status ?? 'active',
    lastMessageAt: input.lastMessageDays === null ? null : iso(input.lastMessageDays),
    createdAt: created,
    updatedAt: created,
    deletedAt: input.deletedAt ?? null,
  }).returning().get()
}

function insertMessage(sessionId: number, input: { role?: string; content?: string | null; withTools?: boolean } = {}) {
  const ts = iso(40)
  return db.insert(schema.agentMessages).values({
    sessionId,
    role: input.role ?? 'user',
    content: input.content === undefined ? '保留期正文' : input.content,
    status: 'completed',
    scopeJson: JSON.stringify({ workspace_key: 'novel-library' }),
    preset: 'assistant',
    toolCallsJson: input.withTools ? JSON.stringify([{ tool: 'list_novels' }]) : null,
    toolResultsJson: input.withTools ? JSON.stringify([{ result: 'ok' }]) : null,
    suggestionsJson: input.withTools ? JSON.stringify([{ action: 'open_novel' }]) : null,
    createdAt: ts,
    finishedAt: ts,
  }).returning().get()
}

function insertProposal(sessionId: number, messageId: number | null = null) {
  const ts = iso(40)
  return db.insert(schema.agentProposals).values({
    sessionId,
    messageId,
    kind: 'novel_update',
    targetType: 'novel',
    targetId: 1,
    beforeJson: JSON.stringify({ title: '旧' }),
    afterJson: JSON.stringify({ title: '新' }),
    rationale: '保留提案依据',
    status: 'proposed',
    proposedBy: 'agent',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
}

function getMessage(id: number) {
  return db.select().from(schema.agentMessages).where(eq(schema.agentMessages.id, id)).get()
}

test('仅清理超期归档/软删除会话；30 天边界、活动与会话不清理', () => {
  const oldArchived = insertSession({ status: 'archived', lastMessageDays: 40 })
  const oldDeleted = insertSession({ status: 'archived', lastMessageDays: 40, deletedAt: iso(39) })
  const oldActive = insertSession({ status: 'active', lastMessageDays: 40 })
  const recentArchived = insertSession({ status: 'archived', lastMessageDays: 5 })
  const boundaryArchived = insertSession({ status: 'archived', lastMessageDays: 30 })
  const noLastMessage = insertSession({ status: 'archived', lastMessageDays: null, createdDays: 40 })
  const messages = [oldArchived, oldDeleted, oldActive, recentArchived, boundaryArchived, noLastMessage]
    .map((session) => insertMessage(session.id))

  const result = cleanupExpiredAgentSessions({ now: NOW })
  assert.equal(result.sessions, 3)
  assert.equal(result.messages, 3)

  assert.equal(getMessage(messages[0].id)?.content, null)
  assert.equal(getMessage(messages[1].id)?.content, null)
  assert.equal(getMessage(messages[2].id)?.content, '保留期正文')
  assert.equal(getMessage(messages[3].id)?.content, '保留期正文')
  assert.equal(getMessage(messages[4].id)?.content, '保留期正文')
  assert.equal(getMessage(messages[5].id)?.content, null)
})

test('清空正文/工具/建议，保留会话壳、消息行、状态与时间，提案保留', () => {
  const session = insertSession({ status: 'archived', lastMessageDays: 40 })
  const user = insertMessage(session.id, { role: 'user' })
  const assistant = insertMessage(session.id, { role: 'assistant', withTools: true })
  const proposal = insertProposal(session.id, assistant.id)

  const result = cleanupExpiredAgentSessions({ now: NOW })
  assert.equal(result.sessions, 1)
  assert.equal(result.messages, 2)

  const sessionAfter = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, session.id)).get()
  assert.ok(sessionAfter)
  assert.equal(sessionAfter.status, 'archived')
  assert.equal(sessionAfter.lastMessageAt, session.lastMessageAt)
  assert.equal(sessionAfter.createdAt, session.createdAt)
  assert.equal(sessionAfter.updatedAt, session.updatedAt)

  const rows = db.select().from(schema.agentMessages)
    .where(eq(schema.agentMessages.sessionId, session.id)).all()
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.content, null)
    assert.equal(row.status, 'completed')
    assert.ok(row.scopeJson?.includes('novel-library'))
  }
  const assistantAfter = getMessage(assistant.id)
  assert.equal(assistantAfter?.toolCallsJson, null)
  assert.equal(assistantAfter?.toolResultsJson, null)
  assert.equal(assistantAfter?.suggestionsJson, null)
  assert.equal(assistantAfter?.createdAt, assistant.createdAt)
  assert.equal(assistantAfter?.finishedAt, assistant.finishedAt)
  assert.equal(getMessage(user.id)?.role, 'user')

  const proposalAfter = db.select().from(schema.agentProposals).where(eq(schema.agentProposals.id, proposal.id)).get()
  assert.equal(proposalAfter?.status, 'proposed')
  assert.equal(proposalAfter?.rationale, '保留提案依据')
})

test('软删除会话先过期提案，保留清理后提案记录仍在', () => {
  const session = insertSession({ status: 'active', lastMessageDays: 40, workspaceKey: 'novel:retention' })
  const message = insertMessage(session.id)
  const proposal = insertProposal(session.id, message.id)

  const deleted = deleteSession(session.id)
  assert.equal(deleted.status, 'archived')
  const expired = db.select().from(schema.agentProposals).where(eq(schema.agentProposals.id, proposal.id)).get()
  assert.equal(expired?.status, 'expired')
  assert.equal(expired?.error, 'session_deleted')

  const result = cleanupExpiredAgentSessions({ now: NOW })
  assert.equal(result.sessions, 1)
  assert.equal(result.messages, 1)

  const proposalAfter = db.select().from(schema.agentProposals).where(eq(schema.agentProposals.id, proposal.id)).get()
  assert.ok(proposalAfter)
  assert.equal(proposalAfter.status, 'expired')
  assert.equal(proposalAfter.error, 'session_deleted')
  const sessionAfter = db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, session.id)).get()
  assert.ok(sessionAfter)
  assert.equal(sessionAfter.status, 'archived')
  assert.ok(sessionAfter.deletedAt)
  assert.equal(getMessage(message.id)?.content, null)
})

test('重复清理幂等：第二次不再产生变更', () => {
  const session = insertSession({ status: 'archived', lastMessageDays: 40 })
  insertMessage(session.id)

  const first = cleanupExpiredAgentSessions({ now: NOW })
  assert.equal(first.sessions, 1)
  assert.equal(first.messages, 1)
  const countAfterFirst = db.select().from(schema.agentMessages)
    .where(eq(schema.agentMessages.sessionId, session.id)).all().length

  const second = cleanupExpiredAgentSessions({ now: NOW })
  assert.deepEqual(second, { sessions: 0, messages: 0 })
  assert.equal(
    db.select().from(schema.agentMessages).where(eq(schema.agentMessages.sessionId, session.id)).all().length,
    countAfterFirst,
  )
})

test('读取 agent.session.retentionDays 并钳制 7–365', () => {
  setAgentSettings({ session: { retentionDays: 7 } })
  assert.equal(getAgentSettings().session.retentionDays, 7)

  const within = insertSession({ status: 'archived', lastMessageDays: 6 })
  const beyond = insertSession({ status: 'archived', lastMessageDays: 10 })
  const withinMessage = insertMessage(within.id)
  const beyondMessage = insertMessage(beyond.id)

  const result = cleanupExpiredAgentSessions({ now: NOW })
  assert.ok(result.sessions >= 1)
  assert.ok(result.messages >= 1)
  assert.equal(getMessage(beyondMessage.id)?.content, null)
  assert.equal(getMessage(withinMessage.id)?.content, '保留期正文')

  setAgentSettings({ session: { retentionDays: 3 } })
  assert.equal(getAgentSettings().session.retentionDays, 7)
  setAgentSettings({ session: { retentionDays: 999 } })
  assert.equal(getAgentSettings().session.retentionDays, 365)
})
