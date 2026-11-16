import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentModelFetch } from '../src/agents/model-fetch.ts'

test('正常响应原样透传', async () => {
  const guarded = createAgentModelFetch({
    timeoutMs: 1000,
    idleTimeoutMs: 1000,
    fetchImpl: async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })
  const response = await guarded('https://example.invalid/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '{"ok":true}')
})

test('请求头阶段超时会中止并报错', async () => {
  const guarded = createAgentModelFetch({
    timeoutMs: 50,
    idleTimeoutMs: 1000,
    fetchImpl: (input: any, init: any) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }),
  })
  await assert.rejects(
    () => guarded('https://example.invalid/v1/chat/completions', { method: 'POST', body: '{}' }),
    /模型请求超时/,
  )
})

test('响应流无数据时按空闲超时中止', async () => {
  const guarded = createAgentModelFetch({
    timeoutMs: 1000,
    idleTimeoutMs: 50,
    fetchImpl: async () => new Response(new ReadableStream({
      start() { /* 永不发送数据 */ },
    }), { status: 200 }),
  })
  const response = await guarded('https://example.invalid/v1/chat/completions', { method: 'POST', body: '{}' })
  await assert.rejects(() => response.text(), /响应流空闲超过/)
})

test('响应分块后会重置空闲计时并完整输出', async () => {
  let sent = 0
  const guarded = createAgentModelFetch({
    timeoutMs: 1000,
    idleTimeoutMs: 80,
    fetchImpl: async () => new Response(new ReadableStream({
      async pull(controller) {
        if (sent === 0) {
          sent += 1
          controller.enqueue(new TextEncoder().encode('hello '))
          return
        }
        if (sent === 1) {
          await new Promise(resolve => setTimeout(resolve, 30))
          sent += 1
          controller.enqueue(new TextEncoder().encode('world'))
          return
        }
        controller.close()
      },
    }), { status: 200 }),
  })
  const response = await guarded('https://example.invalid/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(await response.text(), 'hello world')
})
