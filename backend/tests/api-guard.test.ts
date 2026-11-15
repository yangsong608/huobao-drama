import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGuardedFetch,
  hasApiGuard,
  isLoopbackHost,
  resolveApiGuardConfig,
} from '../src/middleware/api-guard.ts'

const ok = async () => new Response('ok', { status: 200 })

test('no credentials keeps the original fetch untouched', () => {
  const config = resolveApiGuardConfig({})
  assert.equal(hasApiGuard(config), false)
  assert.equal(createGuardedFetch(ok, config), ok)
})

test('loopback detection covers IPv4 loopback, IPv6 and localhost', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('127.8.9.10'), true)
  assert.equal(isLoopbackHost('::1'), true)
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('0.0.0.0'), false)
  assert.equal(isLoopbackHost('192.168.1.10'), false)
})

test('basic auth blocks missing/wrong credentials and accepts correct credentials', async () => {
  const guard = createGuardedFetch(ok, resolveApiGuardConfig({
    HUOBAO_API_USER: 'admin',
    HUOBAO_API_PASSWORD: 'secret',
  }))
  const denied = await guard(new Request('http://local/api/v1/dramas'))
  assert.equal(denied.status, 401)
  assert.match(denied.headers.get('www-authenticate') || '', /Basic/)

  const wrong = await guard(new Request('http://local/api/v1/dramas', {
    headers: { authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}` },
  }))
  assert.equal(wrong.status, 401)

  const allowed = await guard(new Request('http://local/api/v1/dramas', {
    headers: { authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` },
  }))
  assert.equal(allowed.status, 200)
})

test('bearer token and x-api-token are accepted, health and OPTIONS are exempt', async () => {
  const guard = createGuardedFetch(ok, resolveApiGuardConfig({ HUOBAO_API_TOKEN: 'token-123' }))
  assert.equal((await guard(new Request('http://local/api/v1/health'))).status, 200)
  assert.equal((await guard(new Request('http://local/api/v1/dramas', { method: 'OPTIONS' }))).status, 200)
  assert.equal((await guard(new Request('http://local/api/v1/dramas'))).status, 401)
  assert.equal((await guard(new Request('http://local/api/v1/dramas', {
    headers: { authorization: 'Bearer token-123' },
  }))).status, 200)
  assert.equal((await guard(new Request('http://local/api/v1/dramas', {
    headers: { 'x-api-token': 'token-123' },
  }))).status, 200)
})

test('half-configured basic auth fails fast', () => {
  assert.throws(() => resolveApiGuardConfig({ HUOBAO_API_USER: 'admin' }), /必须同时设置/)
  assert.throws(() => resolveApiGuardConfig({ HUOBAO_API_PASSWORD: 'secret' }), /必须同时设置/)
})
