/**
 * P9 在线状态：心跳、过期、角色过滤、上下文白名单、撤销与桥关闭清理
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-presence-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const T0 = 1_800_000_000_000
let nowMs = T0

const { db, schema } = await import('../src/db/index.ts')
const {
  __resetPresenceForTests,
  __setPresenceClockForTests,
  getDevicePresence,
  listPresence,
  prunePresence,
  reportPresence,
  PRESENCE_TTL_MS,
} = await import('../src/services/presence.ts')
const {
  countSyncSubscribers,
  registerSyncSubscriber,
  __resetSyncStreamForTests,
} = await import('../src/services/sync-stream.ts')
const { __resetSyncEventsForTests } = await import('../src/services/sync-events.ts')
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
const { createPresenceRoutes } = await import('../src/routes/presence.ts')

__setPresenceClockForTests(() => nowMs)

test.after(async () => {
  __setPresenceClockForTests(null)
  await __resetRemoteBridgeForTests()
  db.$client.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test.beforeEach(async () => {
  nowMs = T0
  await __resetRemoteBridgeForTests()
  __resetSyncEventsForTests()
  __resetSyncStreamForTests()
  __resetPresenceForTests()
  db.delete(schema.remoteDevices).run()
  setRemoteAccessSettings({ sessionDays: 30 })
})

function issueDevice(scope: 'full' | 'readonly' = 'full', name = '手机') {
  return issueRemoteDevice({ name, platform: 'ios', ip: '192.0.2.40', userAgent: 'iPhone UA', scope })
}

function guestHeaders(deviceId: string, scope: 'full' | 'readonly'): Record<string, string> {
  return {
    [BRIDGE_TRUST_HEADERS.key]: getBridgeTrustKeyForInternalUse(),
    [BRIDGE_TRUST_HEADERS.deviceId]: deviceId,
    [BRIDGE_TRUST_HEADERS.scope]: scope,
    [BRIDGE_TRUST_HEADERS.role]: 'guest',
  }
}

function post(app: ReturnType<typeof createPresenceRoutes>, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-client-id': 'pc-tab-1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function get(app: ReturnType<typeof createPresenceRoutes>, headers: Record<string, string> = {}) {
  return app.request('/', { headers: { 'x-client-id': 'pc-tab-1', ...headers } })
}

test('主机心跳：上报上下文、心跳续期与读取', async () => {
  const app = createPresenceRoutes({ hostName: () => '工作室电脑' })
  const response = await post(app, {
    path: '/drama/episode?tab=mix#a',
    dramaId: 3,
    episodeId: 12,
    stage: '混音',
  })
  assert.equal(response.status, 200)
  const body = await response.json() as {
    code: number
    data: {
      role: string
      self: { name: string; context: Record<string, unknown>; lastSeenAt: string }
      entries: Array<{ id: string; role: string; name: string }>
      ttlSeconds: number
    }
  }
  assert.equal(body.code, 200)
  assert.equal(body.data.role, 'host')
  assert.equal(body.data.self.name, '工作室电脑')
  assert.deepEqual(body.data.self.context, { path: '/drama/episode', dramaId: 3, episodeId: 12, stage: '混音' })
  assert.equal(body.data.self.lastSeenAt, new Date(T0).toISOString())
  assert.equal(body.data.ttlSeconds, 60)
  assert.equal(body.data.entries.length, 1)
  assert.equal(body.data.entries[0].id, 'pc-tab-1')
  assert.equal(body.data.entries[0].role, 'host')

  const read = await get(app)
  const readBody = await read.json() as { data: { entries: Array<{ context: { path: string } }> } }
  assert.equal(readBody.data.entries.length, 1)
  assert.equal(readBody.data.entries[0].context.path, '/drama/episode')

  nowMs = T0 + 20_000
  const refreshed = await post(app, { path: '/drama/episode', dramaId: 3, episodeId: 13 })
  assert.equal((await refreshed.json() as { data: { self: { lastSeenAt: string; context: unknown } } }).data.self.lastSeenAt, new Date(nowMs).toISOString())
  assert.deepEqual(listPresence({ role: 'host' })[0].context, { path: '/drama/episode', dramaId: 3, episodeId: 13 })
})

test('过期：59 秒内在线，60 秒无心跳移除', () => {
  reportPresence({ role: 'host', clientId: 'pc-tab-1', name: '电脑', context: { path: '/a' } })
  nowMs = T0 + PRESENCE_TTL_MS - 1
  assert.equal(prunePresence(), 0)
  assert.equal(listPresence({ role: 'host' }).length, 1)

  nowMs = T0 + PRESENCE_TTL_MS
  assert.equal(prunePresence(), 1)
  assert.equal(listPresence({ role: 'host' }).length, 0)
  assert.equal(getDevicePresence('missing'), null)
})

test('角色过滤：主机看全部，访客只看主机与自己', async () => {
  const deviceA = issueDevice('readonly', '只读手机')
  const deviceB = issueDevice('full', '剪辑手机')
  const app = createPresenceRoutes({ hostName: () => '工作室电脑' })

  await post(app, { path: '/episode/1' })
  await post(app, { path: '/episode/1' }, { ...guestHeaders(deviceA.record.id, 'readonly'), 'x-client-id': 'phone-a' })
  nowMs += 1000
  await post(app, { path: '/episode/2' }, { ...guestHeaders(deviceB.record.id, 'full'), 'x-client-id': 'phone-b' })

  const hostView = await (await get(app)).json() as { data: { role: string; entries: Array<{ id: string }> } }
  assert.equal(hostView.data.role, 'host')
  assert.deepEqual(hostView.data.entries.map(entry => entry.id).sort(), ['pc-tab-1', deviceA.record.id, deviceB.record.id].sort())

  const guestAHeaders = { ...guestHeaders(deviceA.record.id, 'readonly'), 'x-client-id': 'phone-a' }
  const guestAView = await (await get(app, guestAHeaders)).json() as { data: { role: string; entries: Array<{ id: string; role: string }> } }
  assert.equal(guestAView.data.role, 'guest')
  assert.deepEqual(guestAView.data.entries.map(entry => entry.id).sort(), ['pc-tab-1', deviceA.record.id].sort())
  assert.equal(JSON.stringify(guestAView.data).includes(deviceB.record.id), false)

  const guestView = listPresence({ role: 'guest', deviceId: deviceA.record.id })
  assert.equal(guestView.length, 2)
  assert.equal(guestView[0].role, 'host')
  assert.equal(guestView[1].role, 'guest')
})

test('presence 事件按订阅者角色生成，不泄露其他访客', async () => {
  const deviceA = issueDevice('readonly', '只读手机')
  const deviceB = issueDevice('full', '剪辑手机')
  reportPresence({ role: 'host', clientId: 'pc-tab-1', name: '电脑', context: { path: '/host' } })
  reportPresence({
    role: 'guest', deviceId: deviceA.record.id, clientId: 'phone-a', name: '只读手机', scope: 'readonly',
    context: { path: '/a' },
  })

  const hostPayloads: Array<Array<{ id: string }>> = []
  const guestPayloads: Array<Array<{ id: string }>> = []
  registerSyncSubscriber({ role: 'host', deviceId: null, clientId: 'pc-tab-1', scope: null }, (event) => {
    if (event.kind === 'presence') hostPayloads.push(event.payload as Array<{ id: string }>)
  })
  registerSyncSubscriber({ role: 'guest', deviceId: deviceA.record.id, clientId: 'phone-a', scope: 'readonly' }, (event) => {
    if (event.kind === 'presence') guestPayloads.push(event.payload as Array<{ id: string }>)
  })

  reportPresence({
    role: 'guest', deviceId: deviceB.record.id, clientId: 'phone-b', name: '剪辑手机', scope: 'full',
    context: { path: '/b' },
  })

  const hostLatest = hostPayloads.at(-1)!
  const guestLatest = guestPayloads.at(-1)!
  assert.deepEqual(hostLatest.map(entry => entry.id).sort(), ['pc-tab-1', deviceA.record.id, deviceB.record.id].sort())
  assert.deepEqual(guestLatest.map(entry => entry.id).sort(), ['pc-tab-1', deviceA.record.id].sort())
  assert.equal(JSON.stringify(guestLatest).includes(deviceB.record.id), false)
  assert.equal(countSyncSubscribers(), 2)
  __resetSyncStreamForTests()
})

test('上下文白名单：只保留 path/dramaId/episodeId/stage，非法上报 400', async () => {
  const app = createPresenceRoutes()
  const response = await post(app, {
    path: '/novel/9',
    dramaId: 5,
    episodeId: 7,
    stage: '配音',
    script: '秘密台词',
    prompt: '秘密提示词',
    dialogue: '秘密对白',
    name: '伪造名称',
    role: 'guest',
  })
  const body = await response.json() as { data: { self: { context: Record<string, unknown>; role: string; name: string } } }
  assert.deepEqual(body.data.self.context, { path: '/novel/9', dramaId: 5, episodeId: 7, stage: '配音' })
  assert.equal(JSON.stringify(body.data.self).includes('秘密'), false)
  assert.equal(body.data.self.role, 'host')
  assert.notEqual(body.data.self.name, '伪造名称')

  const invalidBodies = [
    {},
    { path: 'novel/9' },
    { path: 123 },
  ]
  for (const invalid of invalidBodies) {
    const res = await post(app, invalid)
    assert.equal(res.status, 400)
    assert.equal((await res.json() as { error_code: string }).error_code, 'PRESENCE_INVALID')
  }
  const broken = await post(app, 'not-json')
  assert.equal(broken.status, 400)

  const stringId = await post(app, { path: '/ok', dramaId: '5', episodeId: -1 })
  const stringIdBody = await stringId.json() as { data: { self: { context: Record<string, unknown> } } }
  assert.deepEqual(stringIdBody.data.self.context, { path: '/ok' })

  const longStage = '控'.repeat(80)
  const longRes = await post(app, { path: '/ok', stage: longStage })
  const longBody = await longRes.json() as { data: { self: { context: { stage: string } } } }
  assert.equal(longBody.data.self.context.stage.length, 40)
})

test('访客身份由桥强制，只读可上报，撤销与公开请求 401', async () => {
  const device = issueDevice('readonly', '只读手机')
  const app = createPresenceRoutes({ hostName: () => '工作室电脑' })
  const headers = { ...guestHeaders(device.record.id, 'readonly'), 'x-client-id': 'phone-a' }

  const response = await post(app, { path: '/episode/1', role: 'host', name: '伪造' }, headers)
  assert.equal(response.status, 200)
  const body = await response.json() as { data: { role: string; self: { role: string; scope: string; name: string; clientId: string } } }
  assert.equal(body.data.role, 'guest')
  assert.equal(body.data.self.role, 'guest')
  assert.equal(body.data.self.scope, 'readonly')
  assert.equal(body.data.self.name, '只读手机')
  assert.equal(body.data.self.clientId, 'phone-a')

  revokeRemoteDevice(device.record.id)
  assert.equal((await post(app, { path: '/episode/1' }, headers)).status, 401)
  assert.equal((await get(app, headers)).status, 401)
  assert.equal((await (await get(app, headers)).json() as { error_code: string }).error_code, 'REMOTE_UNAUTHORIZED')

  const publicHeaders = {
    [BRIDGE_TRUST_HEADERS.key]: getBridgeTrustKeyForInternalUse(),
    [BRIDGE_TRUST_HEADERS.role]: 'public',
  }
  assert.equal((await get(app, publicHeaders)).status, 401)
})

test('撤销设备与桥关闭立即移除在线条目', async () => {
  const deviceA = issueDevice('full', '手机 A')
  const deviceB = issueDevice('full', '手机 B')
  reportPresence({ role: 'host', clientId: 'pc-tab-1', name: '电脑', context: { path: '/host' } })
  reportPresence({
    role: 'guest', deviceId: deviceA.record.id, clientId: 'phone-a', name: '手机 A', scope: 'full',
    context: { path: '/a' },
  })
  reportPresence({
    role: 'guest', deviceId: deviceB.record.id, clientId: 'phone-b', name: '手机 B', scope: 'full',
    context: { path: '/b' },
  })
  assert.equal(getDevicePresence(deviceA.record.id)?.page, '/a')

  revokeRemoteDevice(deviceA.record.id)
  assert.equal(getDevicePresence(deviceA.record.id), null)
  assert.equal(listPresence({ role: 'host' }).length, 2)

  __setBridgeListenerFactoryForTests(() => ({
    listening: Promise.resolve(),
    close: async () => {},
    closeAllConnections: () => {},
  }))
  __setBridgeAddressListerForTests(() => [{ address: '10.99.0.2', interfaceName: 'en0' }])
  __setBridgePortCheckerForTests(async () => true)
  await enableRemoteBridge({ fetch: async () => new Response('ok') })
  await disableRemoteBridge()

  const remaining = listPresence({ role: 'host' })
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].role, 'host')
})
