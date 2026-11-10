/**
 * P2 配对会话：一次性码、短码、next 白名单、限流、二维码与状态机
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  createPairingSession,
  submitPairingRequest,
  getPairingRequestStatus,
  getPairingSession,
  approvePairingRequest,
  denyPairingRequest,
  cancelPairingSession,
  cancelPairingRequest,
  claimPairingRequest,
  normalizeRemoteNextPath,
  createPairingQrSvg,
  RemotePairingError,
  __resetRemotePairingForTests,
  PAIRING_TTL_MS,
} = await import('../src/services/remote-pairing.ts')

const BASE = 'http://192.0.2.10:5680'
const T0 = 1_800_000_000_000

function reset() {
  __resetRemotePairingForTests()
}

function expectError(fn: () => unknown, code: string, status: number) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof RemotePairingError, `expected RemotePairingError, got ${String(error)}`)
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    return true
  })
}

test('next 白名单：合法路径保留，非法路径回退 /', () => {
  const valid = ['/', '/settings', '/settings?tab=remote', '/drama/12', '/drama/12/episode/3', '/novels', '/novels/abc?x=1', '/huobao-novel', '/huobao-novel/abc']
  for (const path of valid) assert.equal(normalizeRemoteNextPath(path), path, path)

  const invalid = [
    undefined, null, '', 'abc', 'https://evil.example', '//evil.example', '/\\evil', '/drama/../settings',
    '/admin', '/drama/', '/drama/./3', '/settings\u0000', '/settings<script>', `/${'a'.repeat(520)}`,
  ]
  for (const path of invalid) assert.equal(normalizeRemoteNextPath(path), '/', String(path))
})

test('创建会话：码/短码格式、120 秒过期、二维码载荷与 SVG 无外部引用', () => {
  reset()
  const created = createPairingSession({ baseUrl: BASE, next: '/drama/12/episode/3' }, T0)
  assert.match(created.code, /^[A-Za-z0-9_-]{43}$/)
  assert.match(created.shortCode, /^\d{6}$/)
  assert.equal(created.next, '/drama/12/episode/3')
  assert.equal(new Date(created.expiresAt).getTime(), T0 + PAIRING_TTL_MS)
  assert.ok(created.qrPayload.startsWith(`${BASE}/pair?c=`))
  assert.ok(created.qrPayload.includes(`next=${encodeURIComponent('/drama/12/episode/3')}`))

  const svg = created.qrSvg
  assert.ok(svg.startsWith('<svg'))
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'))
  assert.equal(/<script/i.test(svg), false)
  assert.equal(/href=|src=|<image/i.test(svg), false)

  const view = getPairingSession(created.pairingId, T0)
  assert.equal(view.status, 'waiting')
  assert.deepEqual(view.requests, [])
})

test('非法 baseUrl 拒绝创建', () => {
  reset()
  for (const baseUrl of ['', 'not-a-url', 'ftp://192.0.2.10:5680', 'http://192.0.2.10:5680/path', 'http://user@192.0.2.10:5680']) {
    expectError(() => createPairingSession({ baseUrl, next: '/' }, T0), 'PAIRING_INVALID_BASE', 400)
  }
})

test('最多 3 个并发会话；过期后释放名额', () => {
  reset()
  createPairingSession({ baseUrl: BASE, next: '/' }, T0)
  createPairingSession({ baseUrl: BASE, next: '/' }, T0 + 1)
  createPairingSession({ baseUrl: BASE, next: '/' }, T0 + 2)
  expectError(() => createPairingSession({ baseUrl: BASE, next: '/' }, T0 + 3), 'PAIRING_SESSION_LIMIT', 409)
  const later = createPairingSession({ baseUrl: BASE, next: '/' }, T0 + PAIRING_TTL_MS + 1)
  assert.ok(later.pairingId)
})

test('完整流程：提交→待确认→批准→领取一次；返回 next 与范围', () => {
  reset()
  const created = createPairingSession({ baseUrl: BASE, next: '/drama/7' }, T0)
  const submitted = submitPairingRequest({
    code: created.code, name: '  手机  ', platform: 'ios', ip: '192.0.2.20', userAgent: 'iPhone UA',
  }, T0 + 100)
  assert.equal(submitted.status, 'pending')

  const waiting = getPairingRequestStatus(submitted.waitToken, T0 + 3_000)
  assert.equal(waiting.status, 'pending')

  const sessionView = getPairingSession(created.pairingId, T0 + 3_100)
  assert.equal(sessionView.status, 'pending')
  assert.equal(sessionView.requests.length, 1)
  assert.equal(sessionView.requests[0].name, '手机')

  approvePairingRequest(created.pairingId, submitted.requestId, 'readonly', T0 + 4_000)
  const approved = getPairingRequestStatus(submitted.waitToken, T0 + 6_100)
  assert.equal(approved.status, 'approved')
  assert.equal(approved.next, '/drama/7')

  let issueCount = 0
  const issue = () => {
    issueCount += 1
    return {
      device: {
        id: 'dev-flow', name: '手机', platform: 'ios' as const, scope: 'readonly' as const,
        createdAt: new Date(T0).toISOString(), lastSeenAt: null,
        expiresAt: new Date(T0 + 30 * 86_400_000).toISOString(), revokedAt: null, status: 'active' as const, ipMasked: '192.0.2.*',
      },
      token: 'device-token',
    }
  }
  const claimed = claimPairingRequest(submitted.waitToken, issue, T0 + 6_200)
  assert.equal(claimed.token, 'device-token')
  assert.equal(claimed.next, '/drama/7')
  assert.equal(issueCount, 1)
  expectError(() => claimPairingRequest(submitted.waitToken, issue, T0 + 6_300), 'PAIRING_EXPIRED', 410)
  assert.equal(issueCount, 1)
})

test('未批准领取返回 202 PAIRING_PENDING', () => {
  reset()
  const created = createPairingSession({ baseUrl: BASE, next: '/' }, T0)
  const submitted = submitPairingRequest({ code: created.code, name: '手机', platform: 'android', ip: '192.0.2.21' }, T0 + 10)
  expectError(() => claimPairingRequest(submitted.waitToken, () => { throw new Error('must not issue') }, T0 + 20), 'PAIRING_PENDING', 202)

  approvePairingRequest(created.pairingId, submitted.requestId, 'full', T0 + 30)
  let issuedContext: any = null
  const claimed = claimPairingRequest(submitted.waitToken, (context) => {
    issuedContext = context
    return {
      device: {
        id: 'dev-1', name: context.name, platform: context.platform, scope: context.scope,
        createdAt: new Date(T0).toISOString(), lastSeenAt: null,
        expiresAt: new Date(T0 + 30 * 86_400_000).toISOString(), revokedAt: null, status: 'active', ipMasked: '192.0.2.*',
      },
      token: 'device-token',
    }
  }, T0 + 40)
  assert.equal(claimed.token, 'device-token')
  assert.equal(claimed.next, '/')
  assert.equal(issuedContext.scope, 'full')
  assert.equal(issuedContext.ip, '192.0.2.21')

  expectError(() => claimPairingRequest(submitted.waitToken, () => { throw new Error('must not issue twice') }, T0 + 50), 'PAIRING_EXPIRED', 410)
})

test('拒绝：手机轮询得到 PAIRING_DENIED，会话可继续等待新请求', () => {
  reset()
  const created = createPairingSession({ baseUrl: BASE, next: '/' }, T0)
  const submitted = submitPairingRequest({ code: created.code, name: '手机', platform: 'ios', ip: '192.0.2.30' }, T0 + 10)
  denyPairingRequest(created.pairingId, submitted.requestId, T0 + 20)
  expectError(() => getPairingRequestStatus(submitted.waitToken, T0 + 3_000), 'PAIRING_DENIED', 403)
  assert.equal(getPairingSession(created.pairingId, T0 + 3_100).status, 'waiting')

  const again = submitPairingRequest({ code: created.shortCode, name: '平板', platform: 'ipad', ip: '192.0.2.31' }, T0 + 3_200)
  assert.equal(getPairingSession(created.pairingId, T0 + 3_300).status, 'pending')
  assert.ok(again.requestId)
})

test('取消自己的请求：轮询返回 410；电脑取消会话后码不可再用', () => {
  reset()
  const created = createPairingSession({ baseUrl: BASE, next: '/' }, T0)
  const submitted = submitPairingRequest({ code: created.code, name: '手机', platform: 'web', ip: '192.0.2.40' }, T0 + 10)
  cancelPairingRequest(submitted.waitToken, T0 + 20)
  expectError(() => getPairingRequestStatus(submitted.waitToken, T0 + 3_000), 'PAIRING_EXPIRED', 410)

  const another = submitPairingRequest({ code: created.code, name: '手机', platform: 'web', ip: '192.0.2.41' }, T0 + 4_000)
  cancelPairingSession(created.pairingId, T0 + 5_000)
  expectError(() => getPairingRequestStatus(another.waitToken, T0 + 7_500), 'PAIRING_EXPIRED', 410)
  expectError(
    () => submitPairingRequest({ code: created.shortCode, name: '手机', platform: 'web', ip: '192.0.2.42' }, T0 + 8_000),
    'PAIRING_EXPIRED', 410,
  )
})

test('配对码 120 秒后过期，过期请求不进入确认列表', () => {
  reset()
  const created = createPairingSession({ baseUrl: BASE, next: '/' }, T0)
  const submitted = submitPairingRequest({ code: created.code, name: '手机', platform: 'ios', ip: '192.0.2.50' }, T0 + 10)
  const view = getPairingSession(created.pairingId, T0 + PAIRING_TTL_MS + 1)
  assert.equal(view.status, 'expired')
  assert.equal(view.requests[0].status, 'expired')
  expectError(() => getPairingRequestStatus(submitted.waitToken, T0 + PAIRING_TTL_MS + 2_000), 'PAIRING_EXPIRED', 410)
  expectError(
    () => submitPairingRequest({ code: created.code, name: '手机', platform: 'ios', ip: '192.0.2.51' }, T0 + PAIRING_TTL_MS + 3_000),
    'PAIRING_EXPIRED', 410,
  )
})

test('短码按 IP 与全局双限流；超限 429 不清除请求', () => {
  reset()
  const created = createPairingSession({ baseUrl: BASE, next: '/' }, T0)
  // 同一 IP 短码尝试 5 次后第 6 次 429
  for (let i = 0; i < 5; i += 1) {
    submitPairingRequest({ code: created.shortCode, name: `手机${i}`, platform: 'ios', ip: '192.0.2.60' }, T0 + i)
  }
  expectError(
    () => submitPairingRequest({ code: created.shortCode, name: '手机x', platform: 'ios', ip: '192.0.2.60' }, T0 + 10),
    'REMOTE_RATE_LIMITED', 429,
  )

  // 另外 3 个 IP 各 5 次，累计 20 次；全局桶随后拒绝新 IP
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 5; j += 1) {
      submitPairingRequest({ code: created.shortCode, name: 'x', platform: 'ios', ip: `192.0.2.${100 + i}` }, T0 + 20 + i * 10 + j)
    }
  }
  expectError(
    () => submitPairingRequest({ code: created.shortCode, name: 'x', platform: 'ios', ip: '192.0.2.200' }, T0 + 60),
    'REMOTE_RATE_LIMITED', 429,
  )

  // 全局限流不清除已有请求
  const view = getPairingSession(created.pairingId, T0 + 61)
  assert.equal(view.requests.length, 20)
  assert.ok(view.requests.every(request => request.status === 'pending'))
})

test('状态轮询每 waitToken 每 2 秒最多 1 次；超限 429 但请求仍可继续等待', () => {
  reset()
  const created = createPairingSession({ baseUrl: BASE, next: '/' }, T0)
  const submitted = submitPairingRequest({ code: created.code, name: '手机', platform: 'ios', ip: '192.0.2.70' }, T0 + 10)
  assert.equal(getPairingRequestStatus(submitted.waitToken, T0 + 3_000).status, 'pending')
  expectError(() => getPairingRequestStatus(submitted.waitToken, T0 + 4_000), 'REMOTE_RATE_LIMITED', 429)
  assert.equal(getPairingRequestStatus(submitted.waitToken, T0 + 5_000).status, 'pending')
})
