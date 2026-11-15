import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBridgeServer } from '../src/host/bridge-server.js'
import type { Logger } from '../src/host/logger.js'

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

test('HTTP 桥鉴权、健康检查与 LLM 路由', async () => {
  const server = await startBridgeServer({
    token: 'test-token',
    logger,
    handlers: {
      health: async () => ({ ok: true }),
      llmChat: async body => ({ echo: body }),
      startAgentTask: async body => ({ accepted: body }),
      getAgentTask: () => ({ id: 't1' }),
      cancelAgentTask: () => ({ id: 't1', status: 'cancelled' }),
      listAgentTasks: () => [],
    },
  })
  const base = `http://127.0.0.1:${server.port}/moss-huobao`
  try {
    const unauthorized = await fetch(`${base}/health`)
    assert.equal(unauthorized.status, 401)

    const health = await fetch(`${base}/health`, {
      headers: { authorization: 'Bearer test-token' },
    })
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true })

    const llm = await fetch(`${base}/llm/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ role: 'generic', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(llm.status, 200)
    assert.deepEqual(await llm.json(), {
      echo: { role: 'generic', messages: [{ role: 'user', content: 'hi' }] },
    })

    const notFound = await fetch(`${base}/missing`, {
      headers: { authorization: 'Bearer test-token' },
    })
    assert.equal(notFound.status, 404)
  } finally {
    await server.close()
  }
})
