/**
 * P7 同步事件总线：序号、环形缓冲、回放/重置、来源、排除规则与失败隔离
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'

const {
  SYNC_RING_CAPACITY,
  __resetSyncEventsForTests,
  emitChange,
  getSyncInstanceId,
  getSyncRevision,
  replaySyncEvents,
  subscribeSyncEvents,
} = await import('../src/services/sync-events.ts')
const { syncEventMiddleware, resolveSyncSource } = await import('../src/middleware/sync-events.ts')
const { BRIDGE_TRUST_HEADERS, getBridgeTrustKeyForInternalUse } = await import('../src/services/remote-bridge.ts')

test.beforeEach(() => {
  __resetSyncEventsForTests()
})

function signBridgeHeaders(headers: Headers, deviceId: string, scope: 'full' | 'readonly' = 'full') {
  headers.set(BRIDGE_TRUST_HEADERS.key, getBridgeTrustKeyForInternalUse())
  headers.set(BRIDGE_TRUST_HEADERS.deviceId, deviceId)
  headers.set(BRIDGE_TRUST_HEADERS.scope, scope)
  headers.set(BRIDGE_TRUST_HEADERS.role, 'guest')
}

function makeApp() {
  const app = new Hono()
  app.use('*', syncEventMiddleware)
  app.get('/api/v1/things', c => c.json({ ok: true }))
  app.post('/api/v1/things', c => c.json({ ok: true }))
  app.put('/api/v1/things/1', c => c.json({ ok: true }))
  app.delete('/api/v1/things/1', c => c.json({ ok: true }))
  app.post('/api/v1/fail-400', c => c.json({ message: 'bad' }, 400))
  app.post('/api/v1/fail-500', c => c.json({ message: 'boom' }, 500))
  app.post('/api/v1/remote/pairing', c => c.json({ ok: true }))
  app.post('/api/v1/sync/ack', c => c.json({ ok: true }))
  app.post('/api/v1/presence', c => c.json({ ok: true }))
  app.post('/api/v1/presence/heartbeat', c => c.json({ ok: true }))
  app.post('/api/v1x/other', c => c.json({ ok: true }))
  app.post('/other', c => c.json({ ok: true }))
  return app
}

test('序号单调递增，事件只含元数据字段且不带查询串', async () => {
  const app = makeApp()
  const res = await app.request('/api/v1/things?secret=abc#frag', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '不应出现在事件中的台词' }),
  })
  assert.equal(res.status, 200)

  const revision = getSyncRevision()
  assert.equal(revision.seq, 1)
  assert.equal(revision.instanceId, getSyncInstanceId())

  const replay = replaySyncEvents({ lastEventSeq: 0 })
  assert.equal(replay.mode, 'events')
  if (replay.mode !== 'events') return
  assert.equal(replay.events.length, 1)
  const event = replay.events[0]
  assert.deepEqual(Object.keys(event).sort(), ['at', 'instanceId', 'method', 'path', 'seq', 'source'])
  assert.equal(event.path, '/api/v1/things')
  assert.equal(event.method, 'POST')
  assert.equal(event.source, 'server')
  assert.equal(event.instanceId, revision.instanceId)
  assert.ok(!JSON.stringify(event).includes('secret'))
  assert.ok(!JSON.stringify(event).includes('不应出现'))
})

test('环形缓冲只保留最近 500 条，过旧序号回放得到 reset', () => {
  for (let index = 0; index < SYNC_RING_CAPACITY + 10; index += 1) {
    emitChange({ method: 'PUT', path: `/api/v1/things/${index + 1}` })
  }
  const revision = getSyncRevision()
  assert.equal(revision.seq, SYNC_RING_CAPACITY + 10)

  const oldest = revision.seq - SYNC_RING_CAPACITY + 1
  const full = replaySyncEvents({ lastEventSeq: oldest - 1 })
  assert.equal(full.mode, 'events')
  if (full.mode === 'events') {
    assert.equal(full.events.length, SYNC_RING_CAPACITY)
    assert.equal(full.events[0].seq, oldest)
    assert.equal(full.events.at(-1)?.seq, revision.seq)
  }

  const tooOld = replaySyncEvents({ lastEventSeq: oldest - 2 })
  assert.deepEqual(tooOld, { mode: 'reset', revision })
})

test('回放边界：相同序号为空、超前/负数/实例变化为 reset', () => {
  emitChange({ method: 'POST', path: '/api/v1/a' })
  emitChange({ method: 'POST', path: '/api/v1/b' })
  const revision = getSyncRevision()
  const instanceId = getSyncInstanceId()

  assert.deepEqual(replaySyncEvents({ lastEventSeq: revision.seq }), { mode: 'empty' })
  assert.deepEqual(replaySyncEvents({}), { mode: 'empty' })
  assert.deepEqual(replaySyncEvents({ lastEventSeq: null }), { mode: 'empty' })
  assert.deepEqual(replaySyncEvents({ lastEventSeq: 1.5 }), { mode: 'empty' })
  assert.deepEqual(replaySyncEvents({ lastEventSeq: revision.seq + 1 }), { mode: 'reset', revision })
  assert.deepEqual(replaySyncEvents({ lastEventSeq: -1 }), { mode: 'reset', revision })
  assert.deepEqual(
    replaySyncEvents({ lastEventSeq: 1, clientInstanceId: 'another-instance' }),
    { mode: 'reset', revision },
  )

  const replay = replaySyncEvents({ lastEventSeq: 1, clientInstanceId: instanceId })
  assert.equal(replay.mode, 'events')
  if (replay.mode === 'events') assert.deepEqual(replay.events.map(event => event.path), ['/api/v1/b'])
})

test('来源优先级：认证设备 id > X-Client-Id > server', () => {
  const guest = new Headers({ 'x-client-id': 'phone-browser' })
  signBridgeHeaders(guest, 'device-123')
  assert.equal(resolveSyncSource(guest), 'device-123')

  const forged = new Headers({
    'x-client-id': 'phone-browser',
    [BRIDGE_TRUST_HEADERS.key]: 'forged-key',
    [BRIDGE_TRUST_HEADERS.deviceId]: 'device-666',
    [BRIDGE_TRUST_HEADERS.scope]: 'full',
    [BRIDGE_TRUST_HEADERS.role]: 'guest',
  })
  assert.equal(resolveSyncSource(forged), 'phone-browser')

  const publicDevice = new Headers({
    [BRIDGE_TRUST_HEADERS.key]: getBridgeTrustKeyForInternalUse(),
    [BRIDGE_TRUST_HEADERS.role]: 'public',
  })
  assert.equal(resolveSyncSource(publicDevice), 'server')
  assert.equal(resolveSyncSource(new Headers()), 'server')
})

test('来源非法字符归一为 server', () => {
  const event = emitChange({ method: 'POST', path: '/api/v1/a', source: 'bad <source> "x"' })
  assert.equal(event.source, 'server')
  const ok = emitChange({ method: 'POST', path: '/api/v1/b', source: 'client-1:tab_2' })
  assert.equal(ok.source, 'client-1:tab_2')
})

test('中间件排除矩阵：GET/失败/配对/同步/在线状态/非 API 不发事件', async () => {
  const app = makeApp()
  const cases: Array<{ path: string; method: string; body?: string }> = [
    { path: '/api/v1/things', method: 'GET' },
    { path: '/api/v1/fail-400', method: 'POST' },
    { path: '/api/v1/fail-500', method: 'POST' },
    { path: '/api/v1/remote/pairing', method: 'POST' },
    { path: '/api/v1/sync/ack', method: 'POST' },
    { path: '/api/v1/presence', method: 'POST' },
    { path: '/api/v1/presence/heartbeat', method: 'POST' },
    { path: '/api/v1x/other', method: 'POST' },
    { path: '/other', method: 'POST' },
  ]
  for (const item of cases) {
    await app.request(item.path, { method: item.method, body: item.body })
  }
  assert.equal(getSyncRevision().seq, 0)
})

test('业务写成功才发事件：PUT/DELETE 与设备来源', async () => {
  const app = makeApp()
  const headers = new Headers({ 'x-client-id': 'pc-tab' })
  signBridgeHeaders(headers, 'device-abc', 'readonly')
  await app.request('/api/v1/things/1', { method: 'PUT', headers })
  await app.request('/api/v1/things/1', { method: 'DELETE' })
  await app.request('/api/v1/things', { method: 'POST', headers: { 'x-client-id': 'pc-tab' } })

  const replay = replaySyncEvents({ lastEventSeq: 0 })
  assert.equal(replay.mode, 'events')
  if (replay.mode !== 'events') return
  assert.deepEqual(replay.events.map(event => event.method), ['PUT', 'DELETE', 'POST'])
  assert.deepEqual(replay.events.map(event => event.source), ['device-abc', 'server', 'pc-tab'])
  assert.equal(getSyncRevision().seq, 3)
})

test('并发写入不产生重复事件或重复序号', async () => {
  const app = makeApp()
  await Promise.all(Array.from({ length: 25 }, () => app.request('/api/v1/things', { method: 'POST' })))
  const revision = getSyncRevision()
  assert.equal(revision.seq, 25)
  const replay = replaySyncEvents({ lastEventSeq: 0 })
  assert.equal(replay.mode, 'events')
  if (replay.mode !== 'events') return
  assert.equal(replay.events.length, 25)
  assert.deepEqual(replay.events.map(event => event.seq), Array.from({ length: 25 }, (_, index) => index + 1))
})

test('订阅者抛错不影响业务响应与其他订阅者', async () => {
  const received: number[] = []
  subscribeSyncEvents(() => { throw new Error('broken listener') })
  subscribeSyncEvents(event => { received.push(event.seq) })

  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    const app = makeApp()
    const res = await app.request('/api/v1/things', { method: 'POST' })
    assert.equal(res.status, 200)
  } finally {
    console.warn = originalWarn
  }

  assert.deepEqual(received, [1])
  assert.equal(getSyncRevision().seq, 1)
  assert.ok(warnings.some(line => line.includes('listener failed')))
})

test('取消订阅后不再收到事件', () => {
  const received: number[] = []
  const unsubscribe = subscribeSyncEvents(event => { received.push(event.seq) })
  emitChange({ method: 'POST', path: '/api/v1/a' })
  unsubscribe()
  emitChange({ method: 'POST', path: '/api/v1/b' })
  assert.deepEqual(received, [1])
})

test('reset 后序号从 0 重新开始（仅测试钩子）', () => {
  emitChange({ method: 'POST', path: '/api/v1/a' })
  __resetSyncEventsForTests()
  assert.equal(getSyncRevision().seq, 0)
  assert.deepEqual(replaySyncEvents({ lastEventSeq: 0 }), { mode: 'empty' })
})
