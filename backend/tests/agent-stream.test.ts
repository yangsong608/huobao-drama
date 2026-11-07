/**
 * A1-6：消息接口、SSE 事件、断线续传、取消、非流式回退、归属校验与启动恢复
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-stream-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.AGENT_HEARTBEAT_MS = '120'

const { Hono } = await import('hono')
const { eq } = await import('drizzle-orm')
const assistantRoute = (await import('../src/routes/assistant.ts')).default
const { db, schema } = await import('../src/db/index.ts')
const sessions = await import('../src/services/agent-sessions.ts')
const streams = await import('../src/services/agent-stream.ts')
const { setAssistantStreamFactoryForTest } = await import('../src/services/agent-assistant.ts')
const { setAgentSettings } = await import('../src/services/app-settings.ts')

const app = new Hono()
app.route('/assistant', assistantRoute)

after(async () => {
  setAssistantStreamFactoryForTest(null)
  streams.resetAgentStreamsForTest()
  delete process.env.AGENT_DOCK
  await fs.rm(root, { recursive: true, force: true })
})

const ts = '2026-11-07T00:00:00.000Z'

function newNovel(title: string): number {
  return Number(db.insert(schema.novels).values({ title, createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
}

function newChapter(novelId: number, chapterNo = 1) {
  return Number(db.insert(schema.novelChapters).values({
    novelId,
    chapterNo,
    title: `第${chapterNo}章`,
    content: '第一章正文',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
}

async function postJson(url: string, body: Record<string, unknown>) {
  const res = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json() as any
  return { res, json }
}

async function resolveSessionId(novelId: number): Promise<number> {
  const { res, json } = await postJson('/assistant/sessions/resolve', { workspace_key: `novel:${novelId}` })
  assert.equal(res.status, 200, JSON.stringify(json))
  return json.data.session.id
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('SSE read timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

interface SseEvent { event: string; data: any }

function sseReader(response: Response) {
  assert.ok(response.body, 'SSE 响应应有 body')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const parseBlock = (block: string): SseEvent | null => {
    if (!block.trim()) return null
    if (block.startsWith(':')) return { event: 'comment', data: null }
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    return { event, data: data ? JSON.parse(data) : null }
  }

  return {
    async next(timeoutMs = 4000): Promise<SseEvent> {
      const deadline = Date.now() + timeoutMs
      while (true) {
        const idx = buffer.indexOf('\n\n')
        if (idx >= 0) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const parsed = parseBlock(block)
          if (parsed) return parsed
          continue
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('SSE read timeout')
        const read = await withTimeout(reader.read(), remaining)
        if (read.done) throw new Error('SSE stream ended')
        buffer += decoder.decode(read.value, { stream: true })
      }
    },
    cancel: () => reader.cancel().catch(() => {}),
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('waitFor timeout')
}

test('SSE：start/scope/reset → 工具事件 → done；终态重放不重复生成', async () => {
  const novelId = newNovel('流式小说')
  const chapterId = newChapter(novelId)
  const sessionId = await resolveSessionId(novelId)
  const gate = deferred()
  let calls = 0
  setAssistantStreamFactoryForTest(async () => {
    calls += 1
    const fullStream = (async function* () {
      yield { type: 'text-delta', payload: { text: '你' } }
      await gate.promise
      yield { type: 'tool-call', payload: { toolCallId: 'c1', toolName: 'read_novel_context', args: { novel_id: novelId } } }
      yield { type: 'tool-result', payload: { toolCallId: 'c1', toolName: 'read_novel_context', result: { novel: { title: '流式小说' } }, isError: false } }
      yield { type: 'text-delta', payload: { text: '好' } }
      yield { type: 'finish', payload: { output: { usage: { totalTokens: 12 } } } }
    })()
    return { fullStream }
  })

  try {
    const created = await postJson(`/assistant/sessions/${sessionId}/messages`, {
      message: '介绍一下这本小说',
      scope: { kind: 'novel', novel_id: novelId, focus: { chapter_id: chapterId } },
    })
    assert.equal(created.res.status, 200, JSON.stringify(created.json))
    assert.ok(created.json.data.stream_url.includes('message_id='))
    const messageId = created.json.data.assistant_message_id

    const sse = await app.request(`/assistant/sessions/${sessionId}/stream?message_id=${messageId}`)
    assert.equal(sse.status, 200)
    const reader = sseReader(sse)
    const start = await reader.next()
    assert.equal(start.event, 'start')
    const scope = await reader.next()
    assert.equal(scope.event, 'scope')
    assert.equal(scope.data.kind, 'novel')
    assert.equal(scope.data.novel_id, novelId)
    assert.equal(scope.data.workspace_key, undefined)
    const reset = await reader.next()
    assert.equal(reset.event, 'reset')
    assert.equal(reset.data.text, '你')

    gate.resolve()
    const seen: string[] = []
    let toolRunning = false
    let toolDone = false
    let done: SseEvent | null = null
    for (let i = 0; i < 30; i++) {
      const event = await reader.next()
      seen.push(event.event)
      if (event.event === 'tool' && event.data.status === 'running') {
        toolRunning = true
        assert.equal(event.data.name, 'read_novel_context')
      }
      if (event.event === 'tool' && event.data.status === 'done') {
        toolDone = true
        assert.ok(String(event.data.result).length <= 6000)
      }
      if (event.event === 'done') { done = event; break }
    }
    assert.ok(toolRunning, `缺少工具 running 事件：${seen.join(',')}`)
    assert.ok(toolDone, `缺少工具 done 事件：${seen.join(',')}`)
    assert.ok(done)
    assert.equal(done!.data.status, 'completed')
    assert.equal(done!.data.text, '你好')

    const stored = sessions.getMessageForSession(sessionId, messageId)!
    assert.equal(stored.status, 'completed')
    assert.equal(stored.content, '你好')
    assert.match(stored.toolCallsJson || '', /read_novel_context/)
    assert.match(stored.toolResultsJson || '', /流式小说/)

    const replay = await app.request(`/assistant/sessions/${sessionId}/stream?message_id=${messageId}`)
    assert.equal(replay.status, 200)
    const replayReader = sseReader(replay)
    assert.equal((await replayReader.next()).event, 'start')
    assert.equal((await replayReader.next()).event, 'scope')
    const replayReset = await replayReader.next()
    assert.equal(replayReset.event, 'reset')
    assert.equal(replayReset.data.text, '你好')
    const replayDone = await replayReader.next()
    assert.equal(replayDone.event, 'done')
    assert.equal(replayDone.data.status, 'completed')
    assert.equal(calls, 1, 'SSE 不应触发生成')
  } finally {
    setAssistantStreamFactoryForTest(null)
  }
})

test('SSE：每 15 秒心跳配置生效（测试用短间隔）', async () => {
  const novelId = newNovel('心跳小说')
  const sessionId = await resolveSessionId(novelId)
  const gate = deferred()
  setAssistantStreamFactoryForTest(async () => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', payload: { text: '等待' } }
      await gate.promise
      yield { type: 'finish', payload: {} }
    })(),
  }))

  try {
    const created = await postJson(`/assistant/sessions/${sessionId}/messages`, {
      message: '心跳测试',
      scope: { kind: 'novel', novel_id: novelId },
    })
    const messageId = created.json.data.assistant_message_id
    const sse = await app.request(`/assistant/sessions/${sessionId}/stream?message_id=${messageId}`)
    const reader = sseReader(sse)
    await reader.next()
    await reader.next()
    await reader.next()
    const heartbeat = await reader.next(1500)
    assert.equal(heartbeat.event, 'comment')
    await reader.cancel()
    gate.resolve()
  } finally {
    setAssistantStreamFactoryForTest(null)
  }
})

test('断线续传：after_seq 只补增量，不重复 reset', async () => {
  const novelId = newNovel('续传小说')
  const sessionId = await resolveSessionId(novelId)
  const startGate = deferred()
  const bGate = deferred()
  const cGate = deferred()
  let calls = 0
  setAssistantStreamFactoryForTest(async () => {
    calls += 1
    return {
      fullStream: (async function* () {
        await startGate.promise
        yield { type: 'text-delta', payload: { text: 'A' } }
        await bGate.promise
        yield { type: 'text-delta', payload: { text: 'B' } }
        await cGate.promise
        yield { type: 'text-delta', payload: { text: 'C' } }
        yield { type: 'finish', payload: {} }
      })(),
    }
  })

  try {
    const created = await postJson(`/assistant/sessions/${sessionId}/messages`, {
      message: '续传测试',
      scope: { kind: 'novel', novel_id: novelId },
    })
    const messageId = created.json.data.assistant_message_id
    const controller = new AbortController()
    const sse = await app.request(`/assistant/sessions/${sessionId}/stream?message_id=${messageId}`, {
      signal: controller.signal,
    })
    const reader = sseReader(sse)
    assert.equal((await reader.next()).event, 'start')
    assert.equal((await reader.next()).event, 'scope')
    assert.equal((await reader.next()).event, 'reset')

    startGate.resolve()
    const deltaA = await reader.next()
    assert.equal(deltaA.event, 'delta')
    assert.equal(deltaA.data.text, 'A')

    bGate.resolve()
    const deltaB = await reader.next()
    assert.equal(deltaB.event, 'delta')
    assert.equal(deltaB.data.text, 'B')
    const lastSeq = Number(deltaB.data.seq)
    controller.abort()

    const resumed = await app.request(
      `/assistant/sessions/${sessionId}/stream?message_id=${messageId}&after_seq=${lastSeq}`,
    )
    assert.equal(resumed.status, 200)
    const resumedReader = sseReader(resumed)
    const nextEventPromise = resumedReader.next(5000)
    cGate.resolve()
    const deltaC = await nextEventPromise
    assert.equal(deltaC.event, 'delta', '续传首条应为增量而不是 reset')
    assert.equal(deltaC.data.text, 'C')
    const done = await resumedReader.next()
    assert.equal(done.event, 'done')
    assert.equal(done.data.status, 'completed')
    assert.equal(calls, 1)

    const stored = sessions.getMessageForSession(sessionId, messageId)!
    assert.equal(stored.content, 'ABC')
  } finally {
    setAssistantStreamFactoryForTest(null)
  }
})

test('缓冲无法续传时改发 reset', async () => {
  const novelId = newNovel('重置小说')
  const sessionId = await resolveSessionId(novelId)
  const gate = deferred()
  setAssistantStreamFactoryForTest(async () => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', payload: { text: '快照' } }
      await gate.promise
      yield { type: 'finish', payload: {} }
    })(),
  }))

  try {
    const created = await postJson(`/assistant/sessions/${sessionId}/messages`, {
      message: '重置测试',
      scope: { kind: 'novel', novel_id: novelId },
    })
    const messageId = created.json.data.assistant_message_id
    const sse = await app.request(
      `/assistant/sessions/${sessionId}/stream?message_id=${messageId}&after_seq=999999`,
    )
    const reader = sseReader(sse)
    assert.equal((await reader.next()).event, 'start')
    assert.equal((await reader.next()).event, 'scope')
    const reset = await reader.next()
    assert.equal(reset.event, 'reset')
    assert.equal(reset.data.text, '快照')
    await reader.cancel()
    gate.resolve()
  } finally {
    setAssistantStreamFactoryForTest(null)
  }
})

test('取消：写入已生成文本、置 cancelled；重复取消 409', async () => {
  const novelId = newNovel('取消小说')
  const sessionId = await resolveSessionId(novelId)
  setAssistantStreamFactoryForTest(async ({ abortSignal }) => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', payload: { text: '半' } }
      await new Promise<void>((resolve) => {
        if (abortSignal?.aborted) return resolve()
        abortSignal?.addEventListener('abort', () => resolve(), { once: true })
      })
      yield { type: 'finish', payload: {} }
    })(),
  }))

  try {
    const created = await postJson(`/assistant/sessions/${sessionId}/messages`, {
      message: '取消测试',
      scope: { kind: 'novel', novel_id: novelId },
    })
    const messageId = created.json.data.assistant_message_id
    await waitFor(() => streams.getAgentStreamText(messageId).includes('半'))

    const cancelled = await postJson(`/assistant/sessions/${sessionId}/cancel`, {})
    assert.equal(cancelled.res.status, 200, JSON.stringify(cancelled.json))
    assert.equal(cancelled.json.data.message.status, 'cancelled')
    assert.equal(cancelled.json.data.message.content, '半')

    const again = await postJson(`/assistant/sessions/${sessionId}/cancel`, {})
    assert.equal(again.res.status, 409)

    const replay = await app.request(`/assistant/sessions/${sessionId}/stream?message_id=${messageId}`)
    const reader = sseReader(replay)
    await reader.next()
    await reader.next()
    assert.equal((await reader.next()).event, 'reset')
    const done = await reader.next()
    assert.equal(done.event, 'done')
    assert.equal(done.data.status, 'cancelled')
  } finally {
    setAssistantStreamFactoryForTest(null)
  }
})

test('非流式回退：stream.enabled=false 同步返回文本与状态', async () => {
  const novelId = newNovel('同步小说')
  const sessionId = await resolveSessionId(novelId)
  setAgentSettings({ stream: { enabled: false } })
  setAssistantStreamFactoryForTest(async () => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', payload: { text: '同步回答' } }
      yield { type: 'finish', payload: {} }
    })(),
  }))

  try {
    const created = await postJson(`/assistant/sessions/${sessionId}/messages`, {
      message: '同步测试',
      scope: { kind: 'novel', novel_id: novelId },
    })
    assert.equal(created.res.status, 200, JSON.stringify(created.json))
    assert.equal(created.json.data.text, '同步回答')
    assert.equal(created.json.data.status, 'completed')
    assert.equal(created.json.data.stream_url, undefined)
  } finally {
    setAgentSettings({ stream: { enabled: true } })
    setAssistantStreamFactoryForTest(null)
  }
})

test('SSE 归属：消息不属于该会话返回 404，缺 message_id 返回 400', async () => {
  const novelA = newNovel('归属甲')
  const novelB = newNovel('归属乙')
  const sessionA = await resolveSessionId(novelA)
  const sessionB = await resolveSessionId(novelB)
  setAssistantStreamFactoryForTest(async () => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', payload: { text: '甲的回答' } }
      yield { type: 'finish', payload: {} }
    })(),
  }))

  try {
    const created = await postJson(`/assistant/sessions/${sessionA}/messages`, {
      message: '甲的问题',
      scope: { kind: 'novel', novel_id: novelA },
    })
    const messageId = created.json.data.assistant_message_id
    await waitFor(() => sessions.getMessageForSession(sessionA, messageId)?.status === 'completed')

    const wrongOwner = await app.request(`/assistant/sessions/${sessionB}/stream?message_id=${messageId}`)
    assert.equal(wrongOwner.status, 404)
    const missing = await app.request(`/assistant/sessions/${sessionA}/stream`)
    assert.equal(missing.status, 400)
    const unknownMessage = await app.request(`/assistant/sessions/${sessionA}/stream?message_id=999999`)
    assert.equal(unknownMessage.status, 404)
  } finally {
    setAssistantStreamFactoryForTest(null)
  }
})

test('总开关关闭：resolve/新消息 403，历史仍可读', async () => {
  const novelId = newNovel('开关小说')
  const sessionId = await resolveSessionId(novelId)
  process.env.AGENT_DOCK = 'off'
  try {
    const resolved = await postJson('/assistant/sessions/resolve', { workspace_key: `novel:${novelId}` })
    assert.equal(resolved.res.status, 403)
    const sent = await postJson(`/assistant/sessions/${sessionId}/messages`, {
      message: '关闭后发送',
      scope: { kind: 'novel', novel_id: novelId },
    })
    assert.equal(sent.res.status, 403)
    const list = await app.request(`/assistant/sessions?workspace_key=novel:${novelId}`)
    assert.equal(list.status, 200)
    const detail = await app.request(`/assistant/sessions/${sessionId}`)
    assert.equal(detail.status, 200)
  } finally {
    delete process.env.AGENT_DOCK
  }
})

test('启动恢复：running 置 interrupted，提案过期、建议清空', () => {
  const novelId = newNovel('恢复小说')
  const session = sessions.resolveSession({ workspaceKey: `novel:${novelId}`, preset: 'assistant' })
  sessions.createUserMessage({ sessionId: session.id, content: '恢复测试' })
  const assistant = sessions.createAssistantMessage({ sessionId: session.id })
  db.update(schema.agentMessages)
    .set({ suggestionsJson: JSON.stringify([{ action: 'open', label: '继续' }]) })
    .where(eq(schema.agentMessages.id, assistant.id))
    .run()
  const proposalId = Number(db.insert(schema.agentProposals).values({
    sessionId: session.id,
    messageId: assistant.id,
    kind: 'asset.prompt.update',
    targetType: 'character',
    targetId: 1,
    status: 'proposed',
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)

  const count = sessions.recoverInterruptedMessages()
  assert.ok(count >= 1)

  const recovered = sessions.getMessageForSession(session.id, assistant.id)!
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.error, 'process_restart')
  assert.equal(recovered.suggestionsJson, null)
  const proposal = db.select().from(schema.agentProposals)
    .where(eq(schema.agentProposals.id, proposalId))
    .get()!
  assert.equal(proposal.status, 'expired')
  assert.equal(proposal.error, 'process_restart')
})
