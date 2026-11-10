/**
 * P3 设备会话：令牌哈希、Cookie 属性、撤销/过期、设备上限、活跃节流与配对领取一次
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-remote-devices-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const {
  issueRemoteDevice,
  authenticateRemoteDevice,
  touchRemoteDevice,
  revokeRemoteDevice,
  revokeAllRemoteDevices,
  listRemoteDeviceViews,
  countActiveRemoteDevices,
  assertRemoteDeviceCapacity,
  cleanupRemoteDevices,
  onRemoteDeviceRevoked,
  parseRemoteDeviceCookie,
  buildRemoteDeviceCookie,
  buildClearedRemoteDeviceCookie,
  hostRemoteSession,
  guestRemoteSession,
  RemoteDeviceError,
  REMOTE_DEVICE_COOKIE,
  MAX_ACTIVE_REMOTE_DEVICES,
  REMOTE_DEVICE_TOUCH_INTERVAL_MS,
  REMOTE_DEVICE_RETENTION_MS,
} = await import('../src/services/remote-devices.ts')
const { setRemoteAccessSettings, toRemoteDeviceView } = await import('../src/services/remote-access.ts')
const { createPairingSession, submitPairingRequest, approvePairingRequest, claimPairingRequest, __resetRemotePairingForTests } =
  await import('../src/services/remote-pairing.ts')

const T0 = 1_800_000_000_000

test.after(() => {
  db.$client.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test.beforeEach(() => {
  db.delete(schema.remoteDevices).run()
  setRemoteAccessSettings({ sessionDays: 30 })
})

function issue(nowMs = T0, overrides: Record<string, unknown> = {}) {
  return issueRemoteDevice({
    name: '手机', platform: 'ios', ip: '192.0.2.20', userAgent: 'iPhone UA', scope: 'full', nowMs, ...overrides,
  })
}

test('签发：数据库只存哈希，令牌只返回一次，有效期按设置', () => {
  setRemoteAccessSettings({ sessionDays: 7 })
  const issued = issue()
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(issued.record.tokenHash.length, 64)
  assert.notEqual(issued.record.tokenHash, issued.token)
  assert.equal(issued.record.expiresAt, new Date(T0 + 7 * 86_400_000).toISOString())

  const rows = db.select().from(schema.remoteDevices).all()
  const serialized = JSON.stringify(rows)
  assert.equal(serialized.includes(issued.token), false)
  assert.ok(serialized.includes(issued.record.tokenHash))

  const view = toRemoteDeviceView(issued.record)
  assert.equal(JSON.stringify(view).includes(issued.record.tokenHash), false)
  assert.equal(JSON.stringify(view).includes('192.0.2.20'), false)
  setRemoteAccessSettings({ sessionDays: 30 })
})

test('Cookie：HttpOnly/SameSite/Path/有效期；HTTPS 加 Secure；清除为 Max-Age=0', () => {
  const http = buildRemoteDeviceCookie('token-value', 30 * 86_400, false)
  assert.ok(http.startsWith(`${REMOTE_DEVICE_COOKIE}=token-value`))
  assert.ok(http.includes('Path=/'))
  assert.ok(http.includes('HttpOnly'))
  assert.ok(http.includes('SameSite=Lax'))
  assert.ok(http.includes(`Max-Age=${30 * 86_400}`))
  assert.equal(http.includes('Secure'), false)

  const https = buildRemoteDeviceCookie('token-value', 7 * 86_400, true)
  assert.ok(https.includes('Secure'))

  const cleared = buildClearedRemoteDeviceCookie(true)
  assert.ok(cleared.startsWith(`${REMOTE_DEVICE_COOKIE}=;`))
  assert.ok(cleared.includes('Max-Age=0'))
  assert.ok(cleared.includes('Secure'))

  assert.equal(parseRemoteDeviceCookie(`a=1; ${REMOTE_DEVICE_COOKIE}=abc; b=2`), 'abc')
  assert.equal(parseRemoteDeviceCookie(`${REMOTE_DEVICE_COOKIE}="abc"`), 'abc')
  assert.equal(parseRemoteDeviceCookie('a=1'), null)
  assert.equal(parseRemoteDeviceCookie(undefined), null)
})

test('校验：有效令牌通过，错误/过期/撤销令牌拒绝', () => {
  const issued = issue()
  const record = authenticateRemoteDevice(issued.token, T0 + 1000)
  assert.ok(record)
  assert.equal(record.id, issued.record.id)
  assert.equal(authenticateRemoteDevice('x'.repeat(43), T0), null)
  assert.equal(authenticateRemoteDevice(null, T0), null)
  assert.equal(authenticateRemoteDevice(issued.token, T0 + 31 * 86_400_000), null)

  revokeRemoteDevice(issued.record.id, T0 + 2000)
  assert.equal(authenticateRemoteDevice(issued.token, T0 + 3000), null)
})

test('最近活跃节流：5 分钟内不写库，之后更新一次', () => {
  const issued = issue()
  const touchedOnce = touchRemoteDevice(issued.record, '192.0.2.30', T0 + 60_000)
  assert.equal(touchedOnce.lastSeenAt, issued.record.lastSeenAt)

  const touchedLater = touchRemoteDevice(issued.record, '192.0.2.30', T0 + REMOTE_DEVICE_TOUCH_INTERVAL_MS + 1)
  assert.equal(touchedLater.lastSeenAt, new Date(T0 + REMOTE_DEVICE_TOUCH_INTERVAL_MS + 1).toISOString())
  assert.equal(touchedLater.lastIp, '192.0.2.30')
  const row = db.select().from(schema.remoteDevices).all().find(item => item.id === issued.record.id)
  assert.equal(row?.lastIp, '192.0.2.30')
})

test('设备上限 10 台；撤销一台后可再签发', () => {
  const issued = []
  for (let i = 0; i < MAX_ACTIVE_REMOTE_DEVICES; i += 1) {
    issued.push(issue(T0 + i, { name: `设备${i}` }))
  }
  assert.equal(countActiveRemoteDevices(T0 + 20), MAX_ACTIVE_REMOTE_DEVICES)
  assert.throws(
    () => issue(T0 + 20),
    (error: unknown) => error instanceof RemoteDeviceError && error.code === 'REMOTE_DEVICE_LIMIT' && error.status === 409,
  )
  assert.throws(() => assertRemoteDeviceCapacity(T0 + 20), /最多同时连接/)

  revokeRemoteDevice(issued[0].record.id, T0 + 30)
  assert.equal(countActiveRemoteDevices(T0 + 31), MAX_ACTIVE_REMOTE_DEVICES - 1)
  assert.ok(issue(T0 + 40).record.id)
})

test('撤销事件通知与全部撤销', () => {
  const events: string[] = []
  const unsubscribe = onRemoteDeviceRevoked(id => events.push(id))
  const first = issue()
  const second = issue()
  assert.equal(revokeRemoteDevice(first.record.id, T0 + 1000).changed, true)
  assert.equal(revokeRemoteDevice(first.record.id, T0 + 2000).changed, false)
  assert.deepEqual(events, [first.record.id])

  const all = revokeAllRemoteDevices(T0 + 3000)
  assert.ok(all.ids.includes(second.record.id))
  assert.equal(events.length, 2)
  unsubscribe()
  const third = issue()
  revokeRemoteDevice(third.record.id, T0 + 4000)
  assert.equal(events.length, 2)
})

test('设备列表只含展示字段；清理按保留期执行', () => {
  const active = issue(T0)
  const revoked = issue(T0)
  revokeRemoteDevice(revoked.record.id, T0 + 1000)
  const views = listRemoteDeviceViews()
  assert.ok(views.some(view => view.id === active.record.id && view.status === 'active'))
  assert.ok(views.some(view => view.id === revoked.record.id && view.status === 'revoked'))

  const deleted = cleanupRemoteDevices(T0 + REMOTE_DEVICE_RETENTION_MS + 2000)
  assert.ok(deleted >= 1)
  const remaining = listRemoteDeviceViews()
  assert.ok(remaining.some(view => view.id === active.record.id))
  assert.equal(remaining.some(view => view.id === revoked.record.id), false)

  cleanupRemoteDevices(T0 + 61 * 86_400_000)
  assert.equal(listRemoteDeviceViews().some(view => view.id === active.record.id), false)
})

test('主机/访客会话序列化', () => {
  const issued = issue(T0, { scope: 'readonly' })
  const host = hostRemoteSession()
  assert.equal(host.role, 'host')
  assert.equal(host.readonly, false)
  assert.ok(host.serverName)

  const guest = guestRemoteSession(issued.record)
  assert.equal(guest.role, 'guest')
  assert.equal(guest.deviceId, issued.record.id)
  assert.equal(guest.readonly, true)
  assert.equal(guest.scope, 'readonly')
  assert.equal(guest.expiresAt, issued.record.expiresAt)
  assert.equal(JSON.stringify(guest).includes(issued.token), false)
})

test('配对领取与设备签发串联：只能领取一次', () => {
  __resetRemotePairingForTests()
  const created = createPairingSession({ baseUrl: 'http://192.0.2.10:5680', next: '/drama/3' }, T0)
  const submitted = submitPairingRequest({
    code: created.code, name: '平板', platform: 'ipad', ip: '192.0.2.50', userAgent: 'iPad UA',
  }, T0 + 10)
  approvePairingRequest(created.pairingId, submitted.requestId, 'readonly', T0 + 20)

  const claimed = claimPairingRequest(submitted.waitToken, (context) => {
    const issued = issueRemoteDevice({ ...context, nowMs: T0 + 30 })
    return { device: toRemoteDeviceView(issued.record), token: issued.token }
  }, T0 + 30)
  assert.equal(claimed.device.name, '平板')
  assert.equal(claimed.device.scope, 'readonly')
  assert.equal(claimed.next, '/drama/3')
  assert.ok(authenticateRemoteDevice(claimed.token, T0 + 40))

  assert.throws(
    () => claimPairingRequest(submitted.waitToken, () => { throw new Error('must not issue') }, T0 + 50),
    /配对请求已失效/,
  )
})
