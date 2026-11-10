/**
 * P6 远程管理接口：主机守卫、设置校验、启停、配对全流程、设备管理与会话
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-remote-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.HUOBAO_DESKTOP

const { db, schema } = await import('../src/db/index.ts')
const { createRemoteRoutes, defaultRemoteHostGuard } = await import('../src/routes/remote.ts')
const {
  __resetRemotePairingForTests,
} = await import('../src/services/remote-pairing.ts')
const {
  __resetRemoteBridgeForTests,
  __setBridgeAddressListerForTests,
  __setBridgeListenerFactoryForTests,
  __setBridgePortCheckerForTests,
  applyBridgeTrustHeaders,
  BRIDGE_TRUST_HEADERS,
  getBridgeTrustKeyForInternalUse,
  setRemoteBridgeFetch,
} = await import('../src/services/remote-bridge.ts')
const {
  authenticateRemoteDevice,
  getRemoteDevice,
  issueRemoteDevice,
  listRemoteDeviceViews,
} = await import('../src/services/remote-devices.ts')
const {
  resetRemoteAccessSettings,
  setRemoteAccessSettings,
  getRemoteAccessSettings,
} = await import('../src/services/remote-access.ts')
const { toRemoteDeviceView } = await import('../src/services/remote-access.ts')

const TEST_IP = '10.99.0.10'
const PHONE_IP = '10.99.0.20'

test.after(() => {
  db.$client.close()
  fs.rmSync(root, { recursive: true, force: true })
})

let closeCalls = 0

function installBridgeFakes(options: { addresses?: string[]; portAvailable?: boolean } = {}) {
  __setBridgeAddressListerForTests(() => (options.addresses ?? [TEST_IP]).map(address => ({ address, interfaceName: 'en0' })))
  __setBridgePortCheckerForTests(async () => options.portAvailable ?? true)
  __setBridgeListenerFactoryForTests(() => ({
    listening: Promise.resolve(),
    close: async () => { closeCalls += 1 },
    closeAllConnections: () => {},
  }))
}

test.beforeEach(async () => {
  db.delete(schema.remoteDevices).run()
  __resetRemotePairingForTests()
  await __resetRemoteBridgeForTests()
  resetRemoteAccessSettings()
  setRemoteAccessSettings({ deviceName: '测试电脑', port: 5680, sessionDays: 30, bindAddress: '' })
  setRemoteBridgeFetch(async () => new Response('bridge-stub'))
  closeCalls = 0
  installBridgeFakes()
})

function makeApp(guard: boolean | 'default' = true, online = false) {
  const app = new Hono()
  app.route('/api/v1/remote', createRemoteRoutes({
    hostGuard: guard === 'default' ? defaultRemoteHostGuard : () => guard,
    onlineInfo: online ? () => ({ online: true, page: '/drama/7' }) : undefined,
  }))
  return app
}

async function jsonResponse(response: Response) {
  return await response.json() as any
}

async function post(app: Hono, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function enableBridge(app: Hono) {
  const response = await post(app, '/api/v1/remote/enable', { bindAddress: TEST_IP })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return jsonResponse(response)
}

async function createPairing(app: Hono) {
  const response = await post(app, '/api/v1/remote/pairing')
  assert.equal(response.status, 200)
  return (await jsonResponse(response)).data as any
}

async function phoneRequest(app: Hono, code: string, name = '手机') {
  const response = await post(app, '/api/v1/remote/pair/request', { code, name, platform: 'ios' }, {
    'x-forwarded-for': PHONE_IP,
    'user-agent': 'TestPhone/1.0',
  })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  return (await jsonResponse(response)).data as any
}

function trustHeadersFor(deviceId: string) {
  const headers = new Headers()
  applyBridgeTrustHeaders(headers, getRemoteDevice(deviceId)!)
  return headers
}

// ---------------------------------------------------------------------------
// 主机守卫
// ---------------------------------------------------------------------------

test('主机守卫：拒绝时管理与公开配对 404，会话仍返回 host；允许时状态正常且不泄露敏感字段', async () => {
  const denied = makeApp(false)

  const status = await denied.request('/api/v1/remote/status')
  assert.equal(status.status, 404)
  assert.equal((await jsonResponse(status)).error_code, 'NOT_FOUND')

  const pairRequest = await post(denied, '/api/v1/remote/pair/request', { code: '123456' })
  assert.equal(pairRequest.status, 404)

  const session = await denied.request('/api/v1/remote/session')
  assert.equal(session.status, 200)
  assert.deepEqual((await jsonResponse(session)).data, { role: 'host', readonly: false, serverName: '测试电脑' })

  const allowed = makeApp(true)
  const ok = await allowed.request('/api/v1/remote/status')
  assert.equal(ok.status, 200)
  const text = await ok.text()
  const data = JSON.parse(text).data
  assert.equal(data.enabled, false)
  assert.equal(data.running, false)
  assert.equal(data.port, 5680)
  assert.equal(data.deviceName, '测试电脑')
  assert.deepEqual(data.urls, [])
  assert.deepEqual(data.addresses, [TEST_IP])
  assert.deepEqual(data.devices, [])
  assert.deepEqual(data.pending, [])
  assert.equal(text.includes('token_hash'), false)
  assert.equal(text.includes('tokenHash'), false)
  assert.equal(text.includes(getBridgeTrustKeyForInternalUse()), false)
  assert.equal(text.includes('HUOBAO'), false)
})

test('主机守卫默认实现：缺桌面环境 404，桥受信转发放行，伪造桥密钥 404', async () => {
  const app = makeApp('default')

  const noEnv = await app.request('/api/v1/remote/status')
  assert.equal(noEnv.status, 404)

  process.env.HUOBAO_DESKTOP = '1'
  try {
    const noSocket = await app.request('/api/v1/remote/status')
    assert.equal(noSocket.status, 404)

    const bridgeHeaders = new Headers()
    bridgeHeaders.set(BRIDGE_TRUST_HEADERS.key, getBridgeTrustKeyForInternalUse())
    bridgeHeaders.set(BRIDGE_TRUST_HEADERS.role, 'public')
    const viaBridge = await app.request('/api/v1/remote/public-info', { headers: bridgeHeaders })
    assert.equal(viaBridge.status, 200)

    const forged = new Headers()
    forged.set(BRIDGE_TRUST_HEADERS.key, 'forged-key')
    forged.set(BRIDGE_TRUST_HEADERS.role, 'public')
    const forgedResponse = await app.request('/api/v1/remote/status', { headers: forged })
    assert.equal(forgedResponse.status, 404)
  } finally {
    delete process.env.HUOBAO_DESKTOP
  }
})

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

test('设置：端口/天数/设备名校验；运行中改端口 409，同端口可保存', async () => {
  const app = makeApp(true)

  const ok = await app.request('/api/v1/remote/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: 6000, sessionDays: 7, deviceName: '书房电脑' }),
  })
  assert.equal(ok.status, 200)
  const saved = (await jsonResponse(ok)).data
  assert.equal(saved.port, 6000)
  assert.equal(saved.sessionDays, 7)
  assert.equal(saved.deviceName, '书房电脑')

  const badPort = await app.request('/api/v1/remote/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 80 }),
  })
  assert.equal(badPort.status, 400)
  const badPortBody = await jsonResponse(badPort)
  assert.equal(badPortBody.error_code, 'REMOTE_INVALID_SETTING')
  assert.equal(badPortBody.data.field, 'port')

  const badDays = await app.request('/api/v1/remote/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionDays: 14 }),
  })
  assert.equal(badDays.status, 400)
  assert.equal((await jsonResponse(badDays)).data.field, 'sessionDays')

  const badName = await app.request('/api/v1/remote/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceName: '   ' }),
  })
  assert.equal(badName.status, 400)
  assert.equal((await jsonResponse(badName)).data.field, 'deviceName')

  await enableBridge(app)

  const locked = await app.request('/api/v1/remote/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 6001 }),
  })
  assert.equal(locked.status, 409)
  assert.equal((await jsonResponse(locked)).error_code, 'BRIDGE_PORT_LOCKED')

  const samePort = await app.request('/api/v1/remote/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 6000, deviceName: '客厅电脑' }),
  })
  assert.equal(samePort.status, 200)
  assert.equal((await jsonResponse(samePort)).data.deviceName, '客厅电脑')
})

// ---------------------------------------------------------------------------
// 启停
// ---------------------------------------------------------------------------

test('启停：端口占用/无私有地址/公网地址返回可读错误，主应用不受影响；关闭后状态复位', async () => {
  const app = makeApp(true)

  __setBridgePortCheckerForTests(async () => false)
  const inUse = await post(app, '/api/v1/remote/enable', { bindAddress: TEST_IP })
  assert.equal(inUse.status, 409)
  const inUseBody = await jsonResponse(inUse)
  assert.equal(inUseBody.error_code, 'BRIDGE_PORT_IN_USE')
  assert.match(inUseBody.message, /端口/)
  assert.equal(inUseBody.data.state, 'error')

  const stillAlive = await app.request('/api/v1/remote/status')
  assert.equal(stillAlive.status, 200)
  assert.equal((await jsonResponse(stillAlive)).data.running, false)

  __setBridgePortCheckerForTests(async () => true)
  __setBridgeAddressListerForTests(() => [])
  const noAddress = await post(app, '/api/v1/remote/enable', {})
  assert.equal(noAddress.status, 409)
  assert.equal((await jsonResponse(noAddress)).error_code, 'BRIDGE_NO_PRIVATE_ADDRESS')

  __setBridgeAddressListerForTests(() => [{ address: TEST_IP, interfaceName: 'en0' }])
  const publicBind = await post(app, '/api/v1/remote/enable', { bindAddress: '192.0.2.10' })
  assert.equal(publicBind.status, 409)
  assert.equal((await jsonResponse(publicBind)).error_code, 'BRIDGE_INVALID_BIND')

  const started = await enableBridge(app)
  assert.equal(started.data.running, true)
  assert.deepEqual(started.data.urls, [`http://${TEST_IP}:5680`])
  assert.equal(getRemoteAccessSettings().bindAddress, TEST_IP)

  const disabled = await post(app, '/api/v1/remote/disable')
  assert.equal(disabled.status, 200)
  assert.equal((await jsonResponse(disabled)).data.running, false)
  assert.ok(closeCalls >= 1)
})

// ---------------------------------------------------------------------------
// 配对与设备
// ---------------------------------------------------------------------------

test('配对全流程：创建、手机请求、桌面批准只读、领取 Cookie、会话、设备列表与撤销', async () => {
  const app = makeApp(true, true)

  const beforeEnable = await post(app, '/api/v1/remote/pairing')
  assert.equal(beforeEnable.status, 409)
  assert.equal((await jsonResponse(beforeEnable)).error_code, 'BRIDGE_NOT_RUNNING')

  await enableBridge(app)
  const pairing = await createPairing(app)
  assert.match(pairing.code, /^[A-Za-z0-9_-]{43}$/)
  assert.match(pairing.shortCode, /^\d{6}$/)
  assert.equal(pairing.next, '/')
  assert.match(pairing.qrSvg, /^<svg/)
  assert.ok(pairing.qrPayload.includes('/pair?c='))
  assert.deepEqual(pairing.urls, [`http://${TEST_IP}:5680`])

  const sessionView = await app.request(`/api/v1/remote/pairing/${pairing.pairingId}`)
  assert.equal(sessionView.status, 200)
  assert.equal((await jsonResponse(sessionView)).data.status, 'waiting')

  const phone = await phoneRequest(app, pairing.shortCode, '小手机')
  assert.equal(phone.status, 'pending')
  assert.ok(phone.waitToken.length >= 40)

  const pendingView = await app.request(`/api/v1/remote/pairing/${pairing.pairingId}`)
  const pending = (await jsonResponse(pendingView)).data
  assert.equal(pending.status, 'pending')
  assert.equal(pending.requests.length, 1)
  assert.equal(pending.requests[0].name, '小手机')

  const statusView = await app.request('/api/v1/remote/status')
  const statusData = (await jsonResponse(statusView)).data
  assert.equal(statusData.pending.length, 1)
  assert.equal(statusData.pending[0].ipMasked, '10.99.0.*')

  const badScope = await post(app, `/api/v1/remote/pairing/${pairing.pairingId}/requests/${phone.requestId}/approve`, { scope: 'admin' })
  assert.equal(badScope.status, 400)
  assert.equal((await jsonResponse(badScope)).error_code, 'PAIRING_INVALID_SCOPE')

  const approved = await post(app, `/api/v1/remote/pairing/${pairing.pairingId}/requests/${phone.requestId}/approve`, { scope: 'readonly' })
  assert.equal(approved.status, 200)
  assert.equal((await jsonResponse(approved)).data.scope, 'readonly')

  const phoneStatus = await post(app, '/api/v1/remote/pair/status', { waitToken: phone.waitToken })
  assert.equal(phoneStatus.status, 200)
  assert.equal((await jsonResponse(phoneStatus)).data.status, 'approved')

  const claim = await post(app, '/api/v1/remote/pair/claim', { waitToken: phone.waitToken })
  assert.equal(claim.status, 200)
  const claimData = (await jsonResponse(claim)).data
  assert.equal(claimData.device.scope, 'readonly')
  assert.equal(claimData.next, '/')
  const setCookie = claim.headers.get('set-cookie') || ''
  assert.match(setCookie, /huobao_device=[A-Za-z0-9_-]{43}/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Lax/)
  assert.match(setCookie, /Path=\//)
  assert.match(setCookie, /Max-Age=2592000/)
  const token = /huobao_device=([^;]+)/.exec(setCookie)![1]
  assert.ok(authenticateRemoteDevice(token))

  const again = await post(app, '/api/v1/remote/pair/claim', { waitToken: phone.waitToken })
  assert.equal(again.status, 410)

  const deviceId = claimData.device.id
  const guestSession = await app.request('/api/v1/remote/session', { headers: trustHeadersFor(deviceId) })
  assert.equal(guestSession.status, 200)
  const guest = (await jsonResponse(guestSession)).data
  assert.equal(guest.role, 'guest')
  assert.equal(guest.scope, 'readonly')
  assert.equal(guest.readonly, true)

  const devices = await app.request('/api/v1/remote/devices')
  assert.equal(devices.status, 200)
  const list = (await jsonResponse(devices)).data
  assert.equal(list.length, 1)
  assert.equal(list[0].online, true)
  assert.equal(list[0].page, '/drama/7')
  assert.equal(list[0].ipMasked, '10.99.0.*')
  assert.deepEqual(Object.keys(list[0]).includes('tokenHash'), false)
  assert.deepEqual(Object.keys(list[0]).includes('userAgent'), false)
  assert.equal(JSON.stringify(list).includes(token), false)

  const revoked = await app.request(`/api/v1/remote/devices/${deviceId}`, { method: 'DELETE' })
  assert.equal(revoked.status, 200)
  assert.equal((await jsonResponse(revoked)).data.revoked, true)
  assert.equal(authenticateRemoteDevice(token), null)

  const afterRevoke = await app.request('/api/v1/remote/session', { headers: trustHeadersFor(deviceId) })
  assert.equal(afterRevoke.status, 401)
  assert.equal((await jsonResponse(afterRevoke)).error_code, 'REMOTE_UNAUTHORIZED')
})

test('配对拒绝与取消：手机查询得到明确错误，设备不会创建', async () => {
  const app = makeApp(true)
  await enableBridge(app)

  const pairing = await createPairing(app)
  const phone = await phoneRequest(app, pairing.shortCode)
  const denied = await post(app, `/api/v1/remote/pairing/${pairing.pairingId}/requests/${phone.requestId}/deny`)
  assert.equal(denied.status, 200)

  const status = await post(app, '/api/v1/remote/pair/status', { waitToken: phone.waitToken })
  assert.equal(status.status, 403)
  assert.equal((await jsonResponse(status)).error_code, 'PAIRING_DENIED')

  const claim = await post(app, '/api/v1/remote/pair/claim', { waitToken: phone.waitToken })
  assert.equal(claim.status, 403)
  assert.equal(listRemoteDeviceViews().length, 0)

  const second = await createPairing(app)
  const phone2 = await phoneRequest(app, second.code)
  const cancelled = await post(app, `/api/v1/remote/pairing/${second.pairingId}/cancel`)
  assert.equal(cancelled.status, 200)
  const phone2Status = await post(app, '/api/v1/remote/pair/cancel', { waitToken: phone2.waitToken })
  assert.equal(phone2Status.status, 410)
})

test('设备上限：已有 10 台时批准返回 409，不产生第 11 台', async () => {
  const app = makeApp(true)
  await enableBridge(app)
  for (let index = 0; index < 10; index += 1) {
    issueRemoteDevice({ name: `设备${index}`, platform: 'web', scope: 'full' })
  }

  const pairing = await createPairing(app)
  const phone = await phoneRequest(app, pairing.code)
  const approved = await post(app, `/api/v1/remote/pairing/${pairing.pairingId}/requests/${phone.requestId}/approve`, {})
  assert.equal(approved.status, 409)
  assert.equal((await jsonResponse(approved)).error_code, 'REMOTE_DEVICE_LIMIT')
  assert.equal(listRemoteDeviceViews().length, 10)
})

test('全部撤销与会话登出：设备立即失效并清除 Cookie', async () => {
  const app = makeApp(true)
  const first = issueRemoteDevice({ name: '设备A', platform: 'ios', scope: 'full' })
  const second = issueRemoteDevice({ name: '设备B', platform: 'android', scope: 'readonly' })

  const logout = await post(app, '/api/v1/remote/logout', undefined, Object.fromEntries(trustHeadersFor(first.record.id)))
  assert.equal(logout.status, 200)
  assert.equal((await jsonResponse(logout)).data.revoked, true)
  assert.match(logout.headers.get('set-cookie') || '', /huobao_device=;/)
  assert.equal(authenticateRemoteDevice(first.token), null)

  const revokeAll = await post(app, '/api/v1/remote/devices/revoke-all')
  assert.equal(revokeAll.status, 200)
  assert.equal((await jsonResponse(revokeAll)).data.count, 1)
  assert.equal(authenticateRemoteDevice(second.token), null)
})

test('公开信息只返回服务名、确认要求与 HTTPS 状态', async () => {
  const app = makeApp(true)
  const response = await app.request('/api/v1/remote/public-info')
  assert.equal(response.status, 200)
  const data = (await jsonResponse(response)).data
  assert.deepEqual(data, { name: '测试电脑', service: 'Huobao Drama', confirm: true, secure: false })
  assert.equal(JSON.stringify(data).includes('version'), false)
})

test('设备视图不包含内部字段，撤销记录保留状态', async () => {
  const app = makeApp(true)
  const issued = issueRemoteDevice({ name: '平板', platform: 'ipad', scope: 'full' })
  const view = toRemoteDeviceView(issued.record)
  assert.equal(view.status, 'active')

  const response = await app.request('/api/v1/remote/devices')
  const list = (await jsonResponse(response)).data
  assert.equal(list.length, 1)
  assert.equal(list[0].id, issued.record.id)
  assert.equal(list[0].online, false)
  assert.equal(list[0].page, null)
  assert.equal(JSON.stringify(list).includes(issued.token), false)
})
