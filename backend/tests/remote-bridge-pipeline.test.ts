/**
 * P5 桥请求管线：入口矩阵、路径规范化、只读/Origin、信任头剥离与注入、
 * 管理/主机接口 404、Range 透传、SSE 不缓冲与错误不泄露
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-remote-pipeline-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { createRemoteBridgePipeline, normalizeBridgePath } = await import('../src/services/remote-bridge-pipeline.ts')
const { BRIDGE_TRUST_HEADERS, getBridgeTrustKeyForInternalUse } = await import('../src/services/remote-bridge.ts')
const { db } = await import('../src/db/index.ts')

test.after(() => {
  db.$client.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const ORIGIN = 'http://192.0.2.10:5680'
const CLIENT_IP = '192.0.2.20'

interface Captured {
  url: string
  request: Request
}

function device(scope: 'full' | 'readonly') {
  return {
    id: `dev-${scope}`,
    name: '手机',
    platform: 'ios' as const,
    tokenHash: 'unused',
    scope,
    createdAt: '2026-11-10T00:00:00.000Z',
    lastSeenAt: null,
    expiresAt: '2099-01-01T00:00:00.000Z',
    revokedAt: null,
    userAgent: null,
    lastIp: null,
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  })
}

function setup(respond?: (request: Request) => Response | Promise<Response>) {
  const calls: Captured[] = []
  const touched: { id: string; ip: string | undefined }[] = []
  const pipeline = createRemoteBridgePipeline({
    appFetch: async (request) => {
      calls.push({ url: request.url, request })
      return respond ? respond(request) : json(200, { ok: true })
    },
    origin: () => ORIGIN,
    authenticate: (token) => {
      if (token === 'full-token') return device('full')
      if (token === 'readonly-token') return device('readonly')
      return null
    },
    touch: (record, ip) => { touched.push({ id: record.id, ip }) },
  })
  return { pipeline, calls, touched }
}

function request(pathname: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('cookie', `huobao_device=${init.cookie}`)
  return new Request(new URL(pathname, ORIGIN), { ...init, headers })
}

async function bodyOf(response: Response) {
  return JSON.parse(await response.text()) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// 路径规范化
// ---------------------------------------------------------------------------

test('路径规范化：合法路径保留，穿越/双重编码/反斜杠/控制字符拒绝', () => {
  assert.equal(normalizeBridgePath('/api/v1/dramas'), '/api/v1/dramas')
  assert.equal(normalizeBridgePath('/api//v1///dramas'), '/api/v1/dramas')
  assert.equal(normalizeBridgePath('/pair/'), '/pair/')
  assert.equal(normalizeBridgePath('/%E4%B8%AD%E6%96%87'), '/中文')
  assert.equal(normalizeBridgePath('/drama/7/'), '/drama/7/')

  assert.equal(normalizeBridgePath('/api/%2e%2e/admin'), null)
  assert.equal(normalizeBridgePath('/api/./admin'), null)
  assert.equal(normalizeBridgePath('/api/%252e%252e/admin'), null)
  assert.equal(normalizeBridgePath('/api%5c..%5cadmin'), null)
  assert.equal(normalizeBridgePath('/api/%00admin'), null)
  assert.equal(normalizeBridgePath('/api/%3fadmin'), null)
  assert.equal(normalizeBridgePath('/api/%E0%A4%A'), null)
  assert.equal(normalizeBridgePath('relative'), null)
})

test('入口：非法路径直接 400 且不进入主应用，错误体不泄露请求路径', async () => {
  const { pipeline, calls } = setup()
  const response = await pipeline(request('/api/%252e%252e/admin', { cookie: 'full-token' }), CLIENT_IP)
  assert.equal(response.status, 400)
  const body = await bodyOf(response)
  assert.equal(body.error_code, 'REMOTE_BAD_PATH')
  assert.deepEqual(Object.keys(body).sort(), ['code', 'error_code', 'message'])
  assert.equal(JSON.stringify(body).includes('%2e'), false)
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------------------
// 入口矩阵
// ---------------------------------------------------------------------------

test('未配对：业务页面 302 到配对页，API 与静态媒体 401，公开壳与公开接口放行', async () => {
  const { pipeline, calls } = setup()

  const page = await pipeline(request('/drama/7?tab=script'), CLIENT_IP)
  assert.equal(page.status, 302)
  assert.equal(page.headers.get('location'), '/pair?next=%2Fdrama%2F7%3Ftab%3Dscript')

  const api = await pipeline(request('/api/v1/dramas'), CLIENT_IP)
  assert.equal(api.status, 401)
  assert.equal((await bodyOf(api)).error_code, 'REMOTE_UNAUTHORIZED')

  const staticMedia = await pipeline(request('/static/files/a.mp4'), CLIENT_IP)
  assert.equal(staticMedia.status, 401)
  assert.equal((await bodyOf(staticMedia)).error_code, 'REMOTE_UNAUTHORIZED')

  const pairPage = await pipeline(request('/pair?c=abc&next=%2F'), CLIENT_IP)
  assert.equal(pairPage.status, 200)
  assert.equal(calls.at(-1)?.url, `${ORIGIN}/pair?c=abc&next=%2F`)

  const shell = await pipeline(request('/_nuxt/app.js'), CLIENT_IP)
  assert.equal(shell.status, 200)

  const publicInfo = await pipeline(request('/api/v1/remote/public-info'), CLIENT_IP)
  assert.equal(publicInfo.status, 200)
  assert.equal(publicInfo.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(publicInfo.headers.get('cache-control'), 'no-store')

  const pairRequest = await pipeline(request('/api/v1/remote/pair/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ code: 'x' }),
  }), CLIENT_IP)
  assert.equal(pairRequest.status, 200)

  const unknown = await pipeline(request('/some-unknown-page'), CLIENT_IP)
  assert.equal(unknown.status, 302)
  assert.equal(unknown.headers.get('location'), '/pair?next=%2F')
})

test('未配对：公开接口方法受限，未知方法 405，OPTIONS 204 不鉴权', async () => {
  const { pipeline, calls } = setup()

  const wrongMethod = await pipeline(request('/api/v1/remote/public-info', { method: 'POST', headers: { origin: ORIGIN } }), CLIENT_IP)
  assert.equal(wrongMethod.status, 405)
  assert.equal((await bodyOf(wrongMethod)).error_code, 'METHOD_NOT_ALLOWED')

  const options = await pipeline(request('/api/v1/dramas', { method: 'OPTIONS' }), CLIENT_IP)
  assert.equal(options.status, 204)
  assert.match(options.headers.get('allow') || '', /GET/)
  assert.equal(calls.length, 0)

  const extensionMethod = await pipeline(request('/api/v1/dramas', { method: 'PROPFIND' }), CLIENT_IP)
  assert.equal(extensionMethod.status, 405)
})

test('全量设备：业务读写进入主应用并注入信任头，管理/主机专属接口 404', async () => {
  const { pipeline, calls, touched } = setup()

  const read = await pipeline(request('/api/v1/dramas', { cookie: 'full-token' }), CLIENT_IP)
  assert.equal(read.status, 200)
  assert.equal(calls.length, 1)

  const write = await pipeline(request('/api/v1/dramas', {
    method: 'POST',
    cookie: 'full-token',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ title: '新剧' }),
  }), CLIENT_IP)
  assert.equal(write.status, 200)
  assert.equal(await calls.at(-1)?.request.text(), JSON.stringify({ title: '新剧' }))

  for (const hostPath of [
    '/api/v1/remote/status',
    '/api/v1/remote/settings',
    '/api/v1/remote/devices',
    '/api/v1/remote/pairing',
    '/api/v1/storage/files',
    '/api/v1/server-update/check',
    '/api/v1/mcp/token',
    '/api/v1/ai-configs',
    '/api/v1/ai-providers/1',
    '/api/v1/settings/media',
  ]) {
    const response = await pipeline(request(hostPath, { cookie: 'full-token' }), CLIENT_IP)
    assert.equal(response.status, 404, hostPath)
    assert.equal((await bodyOf(response)).error_code, 'NOT_FOUND')
  }
  assert.equal(calls.length, 2)

  const session = await pipeline(request('/api/v1/remote/session', { cookie: 'full-token' }), CLIENT_IP)
  assert.equal(session.status, 200)
  assert.equal(calls.at(-1)?.url, `${ORIGIN}/api/v1/remote/session`)

  const touchedIds = touched.map(item => item.id)
  assert.ok(touchedIds.includes('dev-full'))
  assert.ok(touched.some(item => item.ip === CLIENT_IP))
})

test('只读设备：GET 与心跳/登出放行，写操作 403 且不进入主应用', async () => {
  const { pipeline, calls } = setup()

  const read = await pipeline(request('/api/v1/dramas', { cookie: 'readonly-token' }), CLIENT_IP)
  assert.equal(read.status, 200)

  const write = await pipeline(request('/api/v1/dramas', {
    method: 'POST',
    cookie: 'readonly-token',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: '{}',
  }), CLIENT_IP)
  assert.equal(write.status, 403)
  assert.equal((await bodyOf(write)).error_code, 'REMOTE_READONLY')

  for (const allowedPath of ['/api/v1/presence', '/api/v1/remote/logout']) {
    const response = await pipeline(request(allowedPath, {
      method: 'POST',
      cookie: 'readonly-token',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: '{}',
    }), CLIENT_IP)
    assert.equal(response.status, 200, allowedPath)
  }
  assert.equal(calls.length, 3)
})

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

test('Origin：非 GET 缺失或跨源 403，正确来源放行；GET 不要求 Origin', async () => {
  const { pipeline, calls } = setup()

  const noOrigin = await pipeline(request('/api/v1/dramas', {
    method: 'POST', cookie: 'full-token', headers: { 'content-type': 'application/json' }, body: '{}',
  }), CLIENT_IP)
  assert.equal(noOrigin.status, 403)
  assert.equal((await bodyOf(noOrigin)).error_code, 'REMOTE_ORIGIN_FORBIDDEN')

  const crossOrigin = await pipeline(request('/api/v1/dramas', {
    method: 'POST',
    cookie: 'full-token',
    headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
    body: '{}',
  }), CLIENT_IP)
  assert.equal(crossOrigin.status, 403)

  const publicNoOrigin = await pipeline(request('/api/v1/remote/pair/request', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }), CLIENT_IP)
  assert.equal(publicNoOrigin.status, 403)

  assert.equal(calls.length, 0)

  const ok = await pipeline(request('/api/v1/dramas', {
    method: 'POST',
    cookie: 'full-token',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: '{}',
  }), CLIENT_IP)
  assert.equal(ok.status, 200)

  const readNoOrigin = await pipeline(request('/api/v1/dramas', { cookie: 'full-token' }), CLIENT_IP)
  assert.equal(readNoOrigin.status, 200)
  assert.equal(calls.length, 2)
})

// ---------------------------------------------------------------------------
// 信任头与转发
// ---------------------------------------------------------------------------

test('信任头：客户端伪造值被剥离，桥写入正确密钥与设备上下文，Cookie 不转发', async () => {
  const { pipeline, calls } = setup()
  await pipeline(request('/api/v1/dramas', {
    cookie: 'full-token',
    headers: {
      'x-huobao-bridge-key': 'forged-key',
      'x-huobao-device-id': 'evil-device',
      'x-huobao-device-scope': 'host',
      'x-huobao-role': 'host',
      'x-forwarded-for': '10.0.0.1',
    },
  }), CLIENT_IP)

  const forwarded = calls[0].request.headers
  const bridgeKey = getBridgeTrustKeyForInternalUse()
  assert.ok(bridgeKey.length > 20)
  assert.equal(forwarded.get(BRIDGE_TRUST_HEADERS.key), bridgeKey)
  assert.equal(forwarded.get(BRIDGE_TRUST_HEADERS.deviceId), 'dev-full')
  assert.equal(forwarded.get(BRIDGE_TRUST_HEADERS.scope), 'full')
  assert.equal(forwarded.get(BRIDGE_TRUST_HEADERS.role), 'guest')
  assert.equal(forwarded.get('x-forwarded-for'), CLIENT_IP)
  assert.equal(forwarded.get('cookie'), null)
})

test('Range 与条件请求头原样透传，206/Content-Range 不被改写', async () => {
  let seenRange: string | null = null
  let seenEtag: string | null = null
  const { pipeline } = setup((received) => {
    seenRange = received.headers.get('range')
    seenEtag = received.headers.get('if-none-match')
    return new Response('abc', {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': 'bytes 0-2/10',
        'Accept-Ranges': 'bytes',
        'ETag': 'W/"v1"',
      },
    })
  })

  const response = await pipeline(request('/static/files/a.mp4', {
    cookie: 'full-token',
    headers: { range: 'bytes=0-2', 'if-none-match': 'W/"v1"' },
  }), CLIENT_IP)

  assert.equal(seenRange, 'bytes=0-2')
  assert.equal(seenEtag, 'W/"v1"')
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 0-2/10')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(response.headers.get('etag'), 'W/"v1"')
  assert.equal(await response.text(), 'abc')
})

test('SSE 流式响应不被缓冲：首块在流关闭前即可读出', async () => {
  const encoder = new TextEncoder()
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => { release = resolve })
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode('data: hello\n\n'))
      await gate
      controller.enqueue(encoder.encode('data: bye\n\n'))
      controller.close()
    },
  })
  const { pipeline } = setup(() => new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  }))

  const response = await pipeline(request('/api/v1/sync/events', { cookie: 'full-token' }), CLIENT_IP)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(response.body, stream)

  const reader = response.body!.getReader()
  const first = await reader.read()
  assert.equal(new TextDecoder().decode(first.value), 'data: hello\n\n')

  release!()
  const second = await reader.read()
  assert.equal(new TextDecoder().decode(second.value), 'data: bye\n\n')
  assert.equal((await reader.read()).done, true)
})

test('安全头：所有响应附加 nosniff 与 DENY；配对相关响应额外禁止缓存和 Referer', async () => {
  const { pipeline } = setup()

  const unauth = await pipeline(request('/api/v1/dramas'), CLIENT_IP)
  assert.equal(unauth.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(unauth.headers.get('x-frame-options'), 'DENY')
  assert.equal(unauth.headers.get('cache-control'), 'no-store')

  const page = await pipeline(request('/settings'), CLIENT_IP)
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(page.headers.get('x-frame-options'), 'DENY')

  const pair = await pipeline(request('/pair'), CLIENT_IP)
  assert.equal(pair.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(pair.headers.get('cache-control'), 'no-store')

  const business = await pipeline(request('/api/v1/dramas', { cookie: 'full-token' }), CLIENT_IP)
  assert.equal(business.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(business.headers.get('x-frame-options'), 'DENY')
})
