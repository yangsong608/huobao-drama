/**
 * 应用模式本机访问控制：HUOBAO_APP=1 时所有请求必须携带壳注入的应用令牌。
 * 覆盖请求头/Cookie、缺失配置的 fail closed、桌面模式不受影响，以及内部 app.fetch 的令牌补齐。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  APP_TOKEN_COOKIE,
  APP_TOKEN_HEADER,
  appTokenMiddleware,
  withInternalAppToken,
} from '../src/middleware/app-token.ts'

const TOKEN = 'test-app-token-0123456789abcdef'

function makeApp() {
  const app = new Hono()
  app.use('*', appTokenMiddleware)
  app.get('/api/v1/health', c => c.json({ status: 'ok' }))
  app.get('/api/v1/sync/events', c => c.text('event-stream'))
  app.get('/', c => c.html('<html>app</html>'))
  app.post('/api/v1/dramas', c => c.json({ ok: true }))
  return app
}

function enterAppMode(token: string | null = TOKEN) {
  process.env.HUOBAO_APP = '1'
  if (token === null) delete process.env.HUOBAO_APP_TOKEN
  else process.env.HUOBAO_APP_TOKEN = token
}

test.afterEach(() => {
  delete process.env.HUOBAO_APP
  delete process.env.HUOBAO_APP_TOKEN
})

test('应用模式缺少令牌时 API、静态入口与 SSE 均返回 401', async () => {
  enterAppMode()
  const app = makeApp()
  for (const path of ['/api/v1/health', '/api/v1/sync/events', '/']) {
    const res = await app.request(path)
    assert.equal(res.status, 401, path)
    const body = await res.json()
    assert.equal(body.code, 401)
  }
})

test('应用模式错误令牌返回 401', async () => {
  enterAppMode()
  const app = makeApp()
  const res = await app.request('/api/v1/health', {
    headers: { [APP_TOKEN_HEADER]: 'wrong-token' },
  })
  assert.equal(res.status, 401)
})

test('应用模式请求头携带正确令牌放行', async () => {
  enterAppMode()
  const app = makeApp()
  const res = await app.request('/api/v1/health', {
    headers: { [APP_TOKEN_HEADER]: TOKEN },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { status: 'ok' })
})

test('应用模式 Cookie 携带正确令牌放行（静态、SSE、下载依赖此路径）', async () => {
  enterAppMode()
  const app = makeApp()
  for (const path of ['/', '/api/v1/sync/events']) {
    const res = await app.request(path, {
      headers: { cookie: `${APP_TOKEN_COOKIE}=${TOKEN}` },
    })
    assert.equal(res.status, 200, path)
  }
})

test('应用模式同时存在错误请求头与正确 Cookie 时仍放行', async () => {
  enterAppMode()
  const app = makeApp()
  const res = await app.request('/api/v1/health', {
    headers: {
      [APP_TOKEN_HEADER]: 'stale-header-token',
      cookie: `theme=dark; ${APP_TOKEN_COOKIE}=${TOKEN}`,
    },
  })
  assert.equal(res.status, 200)
})

test('查询串中的令牌不被接受', async () => {
  enterAppMode()
  const app = makeApp()
  const res = await app.request(`/api/v1/health?app_token=${TOKEN}`)
  assert.equal(res.status, 401)
})

test('应用模式未注入期望令牌时 fail closed，即使请求携带任意令牌', async () => {
  enterAppMode(null)
  const app = makeApp()
  const res = await app.request('/api/v1/health', {
    headers: { [APP_TOKEN_HEADER]: TOKEN },
  })
  assert.equal(res.status, 401)
  assert.equal((await res.json()).message, '应用令牌未配置')
})

test('桌面/服务器模式不启用令牌校验', async () => {
  delete process.env.HUOBAO_APP
  delete process.env.HUOBAO_APP_TOKEN
  const app = makeApp()
  for (const path of ['/api/v1/health', '/']) {
    const res = await app.request(path)
    assert.equal(res.status, 200, path)
  }
})

test('内部请求在应用模式下自动补齐令牌请求头', () => {
  enterAppMode()
  const init = withInternalAppToken({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"ok":true}',
  })
  const headers = new Headers(init.headers)
  assert.equal(headers.get(APP_TOKEN_HEADER), TOKEN)
  assert.equal(headers.get('content-type'), 'application/json')
  assert.equal(init.method, 'POST')
  assert.equal(init.body, '{"ok":true}')
})

test('内部请求在非应用模式或已有请求头时不改动 init', () => {
  const original = { method: 'GET' }
  assert.equal(withInternalAppToken(original), original)

  enterAppMode()
  const headers = new Headers({ [APP_TOKEN_HEADER]: 'existing' })
  const init = withInternalAppToken({ headers })
  assert.equal(new Headers(init.headers).get(APP_TOKEN_HEADER), 'existing')
})
