/**
 * A1-1：会话解析、新对话归档、消息分页、取消与启动恢复
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-sessions-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const {
  resolveSession,
  createSession,
  listSessions,
  getSessionDetail,
  archiveSession,
  deleteSession,
  createUserMessage,
  createAssistantMessage,
  finishMessage,
  cancelMessage,
  recoverInterruptedMessages,
  listMessages,
} = await import('../src/services/agent-sessions.ts')
const { db, schema } = await import('../src/db/index.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('resolve 命中同一活动线程，重复调用不建新线程', () => {
  const a = resolveSession({ workspaceKey: 'novel:1' })
  const b = resolveSession({ workspaceKey: 'novel:1' })
  assert.equal(a.id, b.id)
  assert.equal(a.workspaceKey, 'novel:1')
  const rows = db.select().from(schema.agentSessions).all()
  assert.equal(rows.length, 1)
})

test('新对话归档旧线程并重新创建；标题取首条用户消息前 40 字', () => {
  const first = resolveSession({ workspaceKey: 'novel:2' })
  createUserMessage({ sessionId: first.id, content: '一'.repeat(60), preset: 'assistant' })
  const detail = getSessionDetail(first.id)
  assert.equal(detail.session.title, '一'.repeat(40))
  assert.equal(detail.messages.length, 1)
  assert.equal(detail.messages[0].role, 'user')

  const created = createSession({ workspaceKey: 'novel:2' })
  assert.notEqual(created.id, first.id)
  const old = db.select().from(schema.agentSessions).all().find(row => row.id === first.id)
  assert.equal(old?.status, 'archived')
  const active = listSessions({ workspaceKey: 'novel:2', status: 'active' })
  assert.equal(active.items.length, 1)
  assert.equal(active.items[0].id, created.id)
  const all = listSessions({ workspaceKey: 'novel:2', status: 'all' })
  assert.equal(all.items.length, 2)
})

test('同一会话只允许一条 running；完成后可继续发消息', () => {
  const session = resolveSession({ workspaceKey: 'novel:3' })
  const user = createUserMessage({ sessionId: session.id, content: '你好' })
  assert.equal(user.status, 'completed')
  const assistant = createAssistantMessage({ sessionId: session.id })
  assert.equal(assistant.status, 'running')
  assert.throws(() => createAssistantMessage({ sessionId: session.id }), /当前回答仍在生成/)

  const done = finishMessage(assistant.id, { content: '回答', status: 'completed', toolCalls: [{ toolName: 'read_novel_list' }] })
  assert.equal(done.status, 'completed')
  assert.ok(done.finishedAt)
  assert.match(done.toolCallsJson || '', /read_novel_list/)
  assert.throws(() => finishMessage(assistant.id, { content: '重复' }), /消息已结束/)
})

test('消息分页 before_id 向更早翻页并保持正序', () => {
  const session = resolveSession({ workspaceKey: 'novel:4' })
  for (let i = 0; i < 5; i++) createUserMessage({ sessionId: session.id, content: `第${i}条` })
  const latest = listMessages(session.id, { limit: 2 })
  assert.deepEqual(latest.items.map(row => row.content), ['第3条', '第4条'])
  assert.equal(latest.has_more, true)
  const earlier = listMessages(session.id, { beforeId: latest.items[0].id, limit: 2 })
  assert.deepEqual(earlier.items.map(row => row.content), ['第1条', '第2条'])
  assert.equal(earlier.has_more, true)
  const oldest = listMessages(session.id, { beforeId: earlier.items[0].id, limit: 2 })
  assert.deepEqual(oldest.items.map(row => row.content), ['第0条'])
  assert.equal(oldest.has_more, false)
})

test('取消只对 running 生效，重复取消 409', () => {
  const session = resolveSession({ workspaceKey: 'novel:5' })
  const assistant = createAssistantMessage({ sessionId: session.id })
  const cancelled = cancelMessage(assistant.id, '已生成一半')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.content, '已生成一半')
  assert.throws(() => cancelMessage(assistant.id), /消息已结束/)
})

test('归档不删除；软删除后列表不可见且提案过期', () => {
  const session = resolveSession({ workspaceKey: 'novel:6' })
  db.insert(schema.agentProposals).values({
    sessionId: session.id,
    kind: 'storyboard.update',
    targetType: 'storyboard',
    targetId: 1,
    status: 'proposed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run()
  archiveSession(session.id)
  const afterArchive = listSessions({ workspaceKey: 'novel:6', status: 'all' }).items
  assert.equal(afterArchive.length, 1)
  assert.equal(afterArchive[0].status, 'archived')
  assert.equal(db.select().from(schema.agentProposals).all()[0].status, 'proposed')

  deleteSession(session.id)
  assert.equal(listSessions({ workspaceKey: 'novel:6', status: 'all' }).items.length, 0)
  assert.equal(db.select().from(schema.agentProposals).all()[0].status, 'expired')
  assert.throws(() => getSessionDetail(session.id), /会话不存在/)
})

test('启动恢复把 running 置 interrupted', () => {
  const session = resolveSession({ workspaceKey: 'novel:7' })
  const assistant = createAssistantMessage({ sessionId: session.id })
  const count = recoverInterruptedMessages()
  assert.ok(count >= 1)
  const row = db.select().from(schema.agentMessages).all().find(item => item.id === assistant.id)
  assert.equal(row?.status, 'interrupted')
  assert.ok(row?.finishedAt)
  assert.equal(recoverInterruptedMessages(), 0)
})
