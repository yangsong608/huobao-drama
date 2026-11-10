/**
 * P8 SSE 事件流：hello、change、回放、reset、心跳、撤销、桥关闭与订阅清理
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-sync-stream-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const {
  getSyncRevision,
  emitChange,
  __resetSyncEventsForTests,
  SYNC_RING_CAPACITY,
} = await import('../src/services/sync-events.ts')
const {
  countSyncSubscribers,
  registerSyncSubscriber,
  broadcastPresence,
  __resetSyncStreamForTests,
  __hasRevokeListenerForTests,
} = await import('../src/services/sync-stream.ts')
const { issueRemoteDevice, revokeRemoteDevice } = await import('../src/services/remote-devices.ts')
const { setRemoteAccessSettings } = await import('../src/services/remote-access.ts')
const {
  BRIDGE_TRUST_HEADERS,
  getBridgeTrustKeyForInternalUse,
  enableRemoteBridge,
  disableRemoteBridge,
  __setBridgeListenerFactoryForTests,
  __setBridgeAddressListerForTests,
  __setBridgePortCheckerForTests,
  __resetRemoteBridgeForTests,
} = await import('../src/services/remote-bridge.ts')
const { createSyncRoutes } = await import('../src/routes/sync.ts')

const DOC_ADDRESS = '10.99.0.1'

test.after(async () => {
  await __resetRemoteBridgeForTests()
  db.$client.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test.beforeEach(async () => {
  await __resetRemoteBridgeForTests()
  __resetSyncEventsForTests()
  __resetSyncStreamForTests()
  db.delete(schema.remoteDevices).run()
  setRemoteAccessSettings({ sessionDays: 30 })
})

interface ParsedSse {
  event: string
  data: string
  id: string | null
}

function parseSseBlock(block: string): ParsedSse | null {
  let event = ''
  let id: string | null = null
  const data: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line || line.startsWith(':')) continue
    const index = line.indexOf(':')
    const field = index >= 0 ? line.slice(0, index) : line
    let value = index >= 0 ? line.slice(index + 1) : ''
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') id = value
  }
  if (!event && data.length === 0) return null
  return { event: event || 'message', data: data.join('\n'), id }
}

interface OpenedStream {
  response: Response
  controller: AbortController
  next(timeoutMs?: number): Promise<ParsedSse | null>
  nextEvent(name: string, timeoutMs?: number): Promise<ParsedSse | null>
  close(): Promise<void>
}

async function openStream(app: Hono, pathname: string, headers: Record<string, string> = {}): Promise<OpenedStream> {
  const controller = new AbortController()
  const response = await app.request(pathname, { headers, signal: controller.signal })
  assert.equal(response.status, 200)
  assert.ok(response.body)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const buffered: ParsedSse[] = []
  const waiters: Array<(value: ParsedSse | null) => void> = []
  let buffer = ''
  let ended = false

  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const parsed = parseSseBlock(block)
          if (!parsed) continue
          const waiter = waiters.shift()
          if (waiter) waiter(parsed)
          else buffered.push(parsed)
        }
      }
    } catch {
      // 客户端取消后读取会中断，按流结束处理
    } finally {
      ended = true
      while (waiters.length > 0) waiters.shift()!(null)
    }
  })()

  const next = (timeoutMs = 1500): Promise<ParsedSse | null> => {
    if (buffered.length > 0) return Promise.resolve(buffered.shift()!)
    if (ended) return Promise.resolve(null)
    return new Promise(resolve => {
      const waiter = (value: ParsedSse | null) => {
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        resolve(null)
      }, timeoutMs)
      waiters.push(waiter)
    })
  }

  return {
    response,
    controller,
    next,
    async nextEvent(name: string, timeoutMs = 2000): Promise<ParsedSse | null> {
      const deadline = Date.now() + timeoutMs
      while (true) {
        const remain = deadline - Date.now()
        if (remain <= 0) return null
        const event = await next(remain)
        if (!event) return null
        if (event.event === name) return event
      }
    },
    async close() {
      try { await reader.cancel() } catch { /* ignore */ }
      controller.abort()
      await pump
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return predicate()
}

function issueDevice(scope: 'full' | 'readonly' = 'full') {
  return issueRemoteDevice({
    name: scope === 'readonly' ? '只读手机' : '手机',
    platform: 'ios',
    ip: '192.0.2.30',
    userAgent: 'iPhone UA',
    scope,
  })
}

function guestHeaders(deviceId: string, scope: 'full' | 'readonly'): Record<string, string> {
  return {
    [BRIDGE_TRUST_HEADERS.key]: getBridgeTrustKeyForInternalUse(),
    [BRIDGE_TRUST_HEADERS.deviceId]: deviceId,
    [BRIDGE_TRUST_HEADERS.scope]: scope,
    [BRIDGE_TRUST_HEADERS.role]: 'guest',
  }
}

function hostApp(heartbeatMs = 60_000) {
  return createSyncRoutes({ heartbeatMs, serverName: () => '测试主机' })
}

test('revision 与 hello：版本、服务器名与防缓冲响应头', async (t) => {
  const app = hostApp()
  const revision = await app.request('/revision')
  assert.equal(revision.status, 200)
  const revisionBody = await revision.json() as { code: number; data: { instanceId: string; seq: number } }
  assert.equal(revisionBody.code, 200)
  assert.equal(revisionBody.data.instanceId, getSyncRevision().instanceId)
  assert.equal(revisionBody.data.seq, getSyncRevision().seq)

  const opened = await openStream(app, '/events?clientId=pc-tab-1')
  t.after(() => opened.controller.abort())
  const hello = await opened.next()
  assert.ok(hello)
  assert.equal(hello.event, 'hello')
  assert.equal(hello.id, String(getSyncRevision().seq))
  const data = JSON.parse(hello.data) as { instanceId: string; seq: number; serverName: string }
  assert.equal(data.instanceId, getSyncRevision().instanceId)
  assert.equal(data.seq, getSyncRevision().seq)
  assert.equal(data.serverName, '测试主机')

  assert.match(opened.response.headers.get('content-type') || '', /text\/event-stream/)
  assert.match(opened.response.headers.get('cache-control') || '', /no-cache/)
  assert.match(opened.response.headers.get('cache-control') || '', /no-transform/)
  assert.equal(opened.response.headers.get('x-accel-buffering'), 'no')
  await opened.close()
})

test('change 事件：成功写后广播，事件 id 等于序号', async (t) => {
  const app = hostApp()
  const opened = await openStream(app, '/events')
  t.after(() => opened.controller.abort())
  assert.equal((await opened.next())?.event, 'hello')

  const event = emitChange({ method: 'post', path: '/api/v1/episodes/9?tab=1', source: 'user' })
  const change = await opened.nextEvent('change')
  assert.ok(change)
  assert.equal(change.id, String(event.seq))
  const payload = JSON.parse(change.data) as Record<string, unknown>
  assert.deepEqual(payload, {
    seq: event.seq,
    method: 'POST',
    path: '/api/v1/episodes/9',
    source: 'user',
    at: event.at,
  })
  await opened.close()
})

test('Last-Event-ID 回放：只补缺口，多值取最后，非法值不回放', async (t) => {
  const app = hostApp()
  const first = emitChange({ method: 'POST', path: '/api/v1/episodes/1' })
  const second = emitChange({ method: 'PUT', path: '/api/v1/episodes/2' })
  const third = emitChange({ method: 'DELETE', path: '/api/v1/episodes/3' })

  const replayed = await openStream(app, '/events', { 'Last-Event-ID': String(first.seq) })
  t.after(() => replayed.controller.abort())
  assert.equal((await replayed.next())?.event, 'hello')
  const eventB = await replayed.nextEvent('change')
  const eventC = await replayed.nextEvent('change')
  assert.equal(eventB?.id, String(second.seq))
  assert.equal(eventC?.id, String(third.seq))
  assert.equal(await replayed.next(100), null)

  const multi = await openStream(app, '/events', { 'Last-Event-ID': `0, ${second.seq}` })
  t.after(() => multi.controller.abort())
  assert.equal((await multi.next())?.event, 'hello')
  const onlyThird = await multi.nextEvent('change')
  assert.equal(onlyThird?.id, String(third.seq))
  assert.equal(await multi.next(100), null)

  const invalid = await openStream(app, '/events', { 'Last-Event-ID': 'not-a-number' })
  t.after(() => invalid.controller.abort())
  assert.equal((await invalid.next())?.event, 'hello')
  assert.equal(await invalid.next(100), null)

  const current = await openStream(app, '/events', { 'Last-Event-ID': String(getSyncRevision().seq) })
  t.after(() => current.controller.abort())
  assert.equal((await current.next())?.event, 'hello')
  assert.equal(await current.next(100), null)
  await Promise.all([replayed.close(), multi.close(), invalid.close(), current.close()])
})

test('回放过旧或超前：发送 reset 并以当前序号对齐', async (t) => {
  const app = hostApp()
  const total = SYNC_RING_CAPACITY + 2
  let newest = 0
  for (let index = 0; index < total; index += 1) {
    newest = emitChange({ method: 'POST', path: `/api/v1/storyboards/${index}` }).seq
  }

  const tooOld = await openStream(app, '/events', { 'Last-Event-ID': '1' })
  t.after(() => tooOld.controller.abort())
  assert.equal((await tooOld.next())?.event, 'hello')
  const reset = await tooOld.nextEvent('reset')
  assert.ok(reset)
  assert.equal(reset.id, String(newest))
  const payload = JSON.parse(reset.data) as { instanceId: string; seq: number }
  assert.equal(payload.instanceId, getSyncRevision().instanceId)
  assert.equal(payload.seq, newest)
  assert.equal(await tooOld.next(100), null)

  const ahead = await openStream(app, '/events', { 'Last-Event-ID': String(newest + 100) })
  t.after(() => ahead.controller.abort())
  assert.equal((await ahead.next())?.event, 'hello')
  assert.equal((await ahead.nextEvent('reset'))?.id, String(newest))

  const otherInstance = await openStream(app, '/events?instanceId=other-instance', {
    'Last-Event-ID': String(newest),
  })
  t.after(() => otherInstance.controller.abort())
  assert.equal((await otherInstance.next())?.event, 'hello')
  const instanceReset = await otherInstance.nextEvent('reset')
  assert.ok(instanceReset)
  assert.equal(JSON.parse(instanceReset.data).instanceId, getSyncRevision().instanceId)
  await Promise.all([tooOld.close(), ahead.close(), otherInstance.close()])
})

test('心跳 ping；访客设备失效时下发 revoked 并关闭', async (t) => {
  const hostStreamApp = createSyncRoutes({ heartbeatMs: 20, serverName: () => '测试主机' })
  const hostStream = await openStream(hostStreamApp, '/events')
  t.after(() => hostStream.controller.abort())
  assert.equal((await hostStream.next())?.event, 'hello')
  const ping = await hostStream.nextEvent('ping', 2000)
  assert.ok(ping)
  assert.match((JSON.parse(ping.data) as { at: string }).at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(ping.id, String(getSyncRevision().seq))
  await hostStream.close()

  const device = issueDevice('readonly')
  let active = true
  const guestApp = createSyncRoutes({
    heartbeatMs: 20,
    serverName: () => '测试主机',
    isDeviceActive: () => active,
  })
  const guestStream = await openStream(guestApp, '/events', guestHeaders(device.record.id, 'readonly'))
  t.after(() => guestStream.controller.abort())
  assert.equal((await guestStream.next())?.event, 'hello')
  assert.equal(countSyncSubscribers('guest'), 1)
  assert.equal(await guestStream.nextEvent('ping', 2000) !== null, true)

  active = false
  const revoked = await guestStream.nextEvent('revoked', 2000)
  assert.ok(revoked)
  assert.equal(JSON.parse(revoked.data).deviceId, device.record.id)
  assert.equal(await guestStream.next(1000), null)
  assert.equal(await waitFor(() => countSyncSubscribers('guest') === 0), true)
  await guestStream.close()
})

test('访客只读可订阅，在线状态按角色分发且不下发越权身份', async (t) => {
  const device = issueDevice('readonly')
  const app = hostApp()
  const hostStream = await openStream(app, '/events?clientId=pc-tab-1')
  const guestStream = await openStream(app, '/events?clientId=phone-1', guestHeaders(device.record.id, 'readonly'))
  t.after(() => hostStream.controller.abort())
  t.after(() => guestStream.controller.abort())
  assert.equal((await hostStream.next())?.event, 'hello')
  assert.equal((await guestStream.next())?.event, 'hello')
  assert.equal(countSyncSubscribers('host'), 1)
  assert.equal(countSyncSubscribers('guest'), 1)

  const metas: Array<{ role: string; deviceId: string | null; clientId: string | null; scope: string | null }> = []
  broadcastPresence(meta => {
    metas.push({ role: meta.role, deviceId: meta.deviceId, clientId: meta.clientId, scope: meta.scope })
    return meta.role === 'host' ? { viewers: ['pc'] } : { viewers: [] }
  })

  const hostPresence = await hostStream.nextEvent('presence')
  const guestPresence = await guestStream.nextEvent('presence')
  assert.deepEqual(JSON.parse(hostPresence!.data), { viewers: ['pc'] })
  assert.deepEqual(JSON.parse(guestPresence!.data), { viewers: [] })

  const hostMeta = metas.find(meta => meta.role === 'host')
  const guestMeta = metas.find(meta => meta.role === 'guest')
  assert.deepEqual(hostMeta, { role: 'host', deviceId: null, clientId: 'pc-tab-1', scope: null })
  assert.deepEqual(guestMeta, {
    role: 'guest',
    deviceId: device.record.id,
    clientId: 'phone-1',
    scope: 'readonly',
  })

  await Promise.all([hostStream.close(), guestStream.close()])
})

test('撤销设备：推送 revoked、关闭流，旧会话重连 401', async (t) => {
  const device = issueDevice('full')
  const app = hostApp()
  const opened = await openStream(app, '/events', guestHeaders(device.record.id, 'full'))
  t.after(() => opened.controller.abort())
  assert.equal((await opened.next())?.event, 'hello')

  revokeRemoteDevice(device.record.id)
  const revoked = await opened.nextEvent('revoked')
  assert.ok(revoked)
  assert.equal(JSON.parse(revoked.data).deviceId, device.record.id)
  assert.equal(await opened.next(1000), null)
  assert.equal(await waitFor(() => countSyncSubscribers('guest') === 0), true)
  await opened.close()

  const reconnect = await app.request('/events', { headers: guestHeaders(device.record.id, 'full') })
  assert.equal(reconnect.status, 401)
  const body = await reconnect.json() as { error_code: string }
  assert.equal(body.error_code, 'REMOTE_UNAUTHORIZED')
  assert.equal((await app.request('/revision', { headers: guestHeaders(device.record.id, 'full') })).status, 401)

  const publicHeaders = {
    [BRIDGE_TRUST_HEADERS.key]: getBridgeTrustKeyForInternalUse(),
    [BRIDGE_TRUST_HEADERS.role]: 'public',
  }
  assert.equal((await app.request('/events', { headers: publicHeaders })).status, 401)
})

test('断开清理：订阅者不泄漏，测试重置后总线监听仍挂载', async () => {
  const app = hostApp()
  const opened = await openStream(app, '/events')
  assert.equal((await opened.next())?.event, 'hello')
  assert.equal(countSyncSubscribers(), 1)
  await opened.close()
  assert.equal(await waitFor(() => countSyncSubscribers() === 0), true)

  assert.equal(__hasRevokeListenerForTests(), true)
  __resetSyncEventsForTests()
  __resetSyncStreamForTests()
  const second = await openStream(app, '/events')
  assert.equal((await second.next())?.event, 'hello')
  emitChange({ method: 'POST', path: '/api/v1/tasks/1' })
  assert.ok(await second.nextEvent('change'))
  await second.close()
})

test('桥关闭：只关闭访客订阅，主机订阅继续收到事件', async (t) => {
  __setBridgeListenerFactoryForTests(() => ({
    listening: Promise.resolve(),
    close: async () => {},
    closeAllConnections: () => {},
  }))
  __setBridgeAddressListerForTests(() => [{ address: DOC_ADDRESS, interfaceName: 'en0' }])
  __setBridgePortCheckerForTests(async () => true)
  await enableRemoteBridge({ fetch: async () => new Response('ok') })

  const device = issueDevice('full')
  const app = hostApp()
  const hostStream = await openStream(app, '/events')
  const guestStream = await openStream(app, '/events', guestHeaders(device.record.id, 'full'))
  t.after(() => hostStream.controller.abort())
  t.after(() => guestStream.controller.abort())
  assert.equal((await hostStream.next())?.event, 'hello')
  assert.equal((await guestStream.next())?.event, 'hello')

  await disableRemoteBridge()
  assert.equal(await guestStream.next(1000), null)
  assert.equal(await waitFor(() => countSyncSubscribers('guest') === 0), true)
  assert.equal(countSyncSubscribers('host'), 1)

  emitChange({ method: 'POST', path: '/api/v1/episodes/7' })
  assert.ok(await hostStream.nextEvent('change'))
  await hostStream.close()
  await guestStream.close()
})

test('订阅者回调失败只移除自身，不影响其他订阅者', () => {
  const received: number[] = []
  registerSyncSubscriber({ role: 'host', deviceId: null, clientId: 'bad', scope: null }, () => {
    throw new Error('boom')
  })
  const off = registerSyncSubscriber({ role: 'host', deviceId: null, clientId: 'ok', scope: null }, (event) => {
    if (event.kind === 'change') received.push(event.event.seq)
  })
  assert.equal(countSyncSubscribers(), 2)

  const event = emitChange({ method: 'POST', path: '/api/v1/novels/1' })
  assert.deepEqual(received, [event.seq])
  assert.equal(countSyncSubscribers(), 1)
  off()
  assert.equal(countSyncSubscribers(), 0)
})
