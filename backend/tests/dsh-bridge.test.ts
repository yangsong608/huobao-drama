import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { callDshBridgeText, DshBridgeError, isDshBridgeEnabled } from '../src/services/dsh-bridge.js'
import { callText } from '../src/services/text-call.js'

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-dsh-bridge-'))
process.env.SQLITE_PATH = path.join(testRoot, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const originalEnv = {
  enable: process.env.DSH_BRIDGE_ENABLE,
  disable: process.env.DSH_BRIDGE_DISABLE,
  url: process.env.DSH_BRIDGE_URL,
  token: process.env.DSH_BRIDGE_TOKEN,
  strict: process.env.DSH_BRIDGE_STRICT,
}

afterEach(() => {
  for (const [key, value] of [
    ['DSH_BRIDGE_ENABLE', originalEnv.enable],
    ['DSH_BRIDGE_DISABLE', originalEnv.disable],
    ['DSH_BRIDGE_URL', originalEnv.url],
    ['DSH_BRIDGE_TOKEN', originalEnv.token],
    ['DSH_BRIDGE_STRICT', originalEnv.strict],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function startFakeBridge(handler: (body: any, req: http.IncomingMessage) => { status: number; body: unknown }) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const result = handler(body, req)
        const payload = JSON.stringify(result.body)
        res.writeHead(result.status, { 'content-type': 'application/json' })
        res.end(payload)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>(done => {
          server.close(() => done())
          server.closeAllConnections?.()
        }),
      })
    })
  })
}

test('callDshBridgeText 发送角色并解析响应', async () => {
  let seenRole = ''
  let seenAuth = ''
  const fake = await startFakeBridge((body, req) => {
    seenRole = body.role
    seenAuth = String(req.headers.authorization ?? '')
    return {
      status: 200,
      body: {
        model: 'ds-test',
        choices: [{ message: { content: 'ok' } }],
      },
    }
  })
  try {
    const result = await callDshBridgeText(
      { bridgeBaseUrl: fake.url, token: 'secret' },
      { role: 'translator', prompt: 'hi' },
    )
    assert.equal(result.text, 'ok')
    assert.equal(result.provider, 'dsh')
    assert.equal(result.model, 'ds-test')
    assert.equal(seenRole, 'translator')
    assert.equal(seenAuth, 'Bearer secret')
  } finally {
    await fake.close()
  }
})

test('callDshBridgeText 将错误码映射为 DshBridgeError', async () => {
  const fake = await startFakeBridge(() => ({
    status: 429,
    body: { error: { code: 'RATE_LIMIT', message: '限流' } },
  }))
  try {
    await assert.rejects(
      () => callDshBridgeText({ bridgeBaseUrl: fake.url, token: 't' }, { prompt: 'hi' }),
      (cause: unknown) => cause instanceof DshBridgeError && cause.code === 'RATE_LIMIT',
    )
  } finally {
    await fake.close()
  }
})

test('非 JSON 错误响应保留状态码与文本摘要', async () => {
  const fakeFetch = (async () => new Response('gateway timeout', { status: 500 })) as typeof fetch
  await assert.rejects(
    () => callDshBridgeText({ bridgeBaseUrl: 'http://127.0.0.1:1', token: 't' }, { prompt: 'hi' }, fakeFetch),
    (cause: unknown) => cause instanceof DshBridgeError
      && cause.code === 'UPSTREAM_ERROR'
      && cause.message.includes('gateway timeout'),
  )
})

test('isDshBridgeEnabled 需要显式环境开启', async () => {
  delete process.env.DSH_BRIDGE_ENABLE
  delete process.env.DSH_BRIDGE_URL
  delete process.env.DSH_BRIDGE_DISABLE
  assert.equal(await isDshBridgeEnabled(), false)
  process.env.DSH_BRIDGE_ENABLE = '1'
  assert.equal(await isDshBridgeEnabled(), true)
  process.env.DSH_BRIDGE_DISABLE = '1'
  assert.equal(await isDshBridgeEnabled(), false)
})

test('callText 在显式开启时走 DSH 桥', async () => {
  const fake = await startFakeBridge(() => ({
    status: 200,
    body: {
      model: 'ds-test',
      choices: [{ message: { content: 'bridge-ok' } }],
    },
  }))
  process.env.DSH_BRIDGE_ENABLE = '1'
  process.env.DSH_BRIDGE_URL = fake.url
  process.env.DSH_BRIDGE_TOKEN = 'secret'
  try {
    const result = await callText({ role: 'translator', prompt: 'hi' })
    assert.equal(result.text, 'bridge-ok')
    assert.equal(result.provider, 'dsh')
  } finally {
    await fake.close()
  }
})

test('严格模式下桥错误不被吞掉', async () => {
  const fake = await startFakeBridge(() => ({
    status: 503,
    body: { error: { code: 'BRIDGE_UNAVAILABLE', message: 'down' } },
  }))
  process.env.DSH_BRIDGE_ENABLE = '1'
  process.env.DSH_BRIDGE_URL = fake.url
  process.env.DSH_BRIDGE_TOKEN = 'secret'
  process.env.DSH_BRIDGE_STRICT = '1'
  try {
    await assert.rejects(
      () => callText({ prompt: 'hi' }),
      (cause: unknown) => cause instanceof DshBridgeError && cause.code === 'BRIDGE_UNAVAILABLE',
    )
  } finally {
    await fake.close()
  }
})
