/**
 * P4 远程桥：地址分类、端口检查、状态机、启停与信任头
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-remote-bridge-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const {
  classifyIPv4,
  listPrivateIPv4Addresses,
  checkPortAvailable,
  enableRemoteBridge,
  disableRemoteBridge,
  getRemoteBridgeStatus,
  onRemoteBridgeClosing,
  applyBridgeTrustHeaders,
  readBridgeTrustContext,
  BRIDGE_TRUST_HEADERS,
  RemoteBridgeError,
  __setBridgeListenerFactoryForTests,
  __setBridgeAddressListerForTests,
  __setBridgePortCheckerForTests,
  __resetRemoteBridgeForTests,
} = await import('../src/services/remote-bridge.ts')
const { setRemoteAccessSettings } = await import('../src/services/remote-access.ts')
const { db } = await import('../src/db/index.ts')

test.after(async () => {
  await __resetRemoteBridgeForTests()
  db.$client.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test.beforeEach(async () => {
  await __resetRemoteBridgeForTests()
  setRemoteAccessSettings({ port: 5680, bindAddress: '' })
})

const ADDRESS = '192.168.1.20'

function installFakeListener(overrides: {
  rejectListening?: Error
  throwOnCreate?: Error
} = {}) {
  const events: string[] = []
  let captured: { fetch: unknown; port: number; hostname: string } | null = null
  __setBridgeListenerFactoryForTests((options) => {
    if (overrides.throwOnCreate) throw overrides.throwOnCreate
    captured = options
    return {
      listening: overrides.rejectListening ? Promise.reject(overrides.rejectListening) : Promise.resolve(),
      close: async () => { events.push('close') },
      closeAllConnections: () => { events.push('closeAllConnections') },
    }
  })
  __setBridgeAddressListerForTests(() => [{ address: ADDRESS, interfaceName: 'en0' }])
  __setBridgePortCheckerForTests(async () => true)
  return { events, getCaptured: () => captured }
}

const fakeFetch = async () => new Response('ok')

test('IPv4 分类覆盖私有、回环、链路本地、共享、公网、组播、通配、保留', () => {
  const cases: Array<[string, string]> = [
    ['10.0.0.1', 'private'], ['10.255.255.255', 'private'],
    ['172.16.0.1', 'private'], ['172.31.255.254', 'private'],
    ['192.168.0.1', 'private'], ['192.168.31.100', 'private'],
    ['127.0.0.1', 'loopback'],
    ['169.254.10.2', 'link-local'],
    ['100.64.0.1', 'shared'], ['100.127.255.255', 'shared'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['8.8.8.8', 'public'], ['172.15.0.1', 'public'], ['172.32.0.1', 'public'],
    ['0.0.0.0', 'unspecified'],
    ['', 'invalid'], ['::1', 'invalid'], ['192.168.1', 'invalid'], ['192.168.1.256', 'invalid'],
  ]
  for (const [value, expected] of cases) assert.equal(classifyIPv4(value), expected, value)
})

test('私有地址枚举：跳过内部、链路本地、共享、公网、IPv6 与重复', () => {
  const addresses = listPrivateIPv4Addresses({
    en0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    lo0: [
      { address: '127.0.0.1', family: 'IPv4', internal: true },
      { address: '::1', family: 'IPv6', internal: true },
    ],
    en1: [
      { address: '10.1.2.3', family: 4, internal: false },
      { address: '169.254.1.1', family: 'IPv4', internal: false },
      { address: '100.64.0.9', family: 'IPv4', internal: false },
      { address: '8.8.8.8', family: 'IPv4', internal: false },
      { address: '192.168.1.20', family: 'IPv4', internal: false },
    ],
  } as never)
  assert.deepEqual(addresses, [
    { address: '192.168.1.20', interfaceName: 'en0' },
    { address: '10.1.2.3', interfaceName: 'en1' },
  ])
})

test('端口占用检查：占用返回 false，释放后返回 true', async () => {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  assert.equal(await checkPortAvailable(port, '127.0.0.1'), false)
  await new Promise<void>(resolve => server.close(() => resolve()))
  assert.equal(await checkPortAvailable(port, '127.0.0.1'), true)
})

test('默认关闭；手动开启后监听指定私有地址与端口', async () => {
  const initial = getRemoteBridgeStatus()
  assert.equal(initial.state, 'disabled')
  assert.equal(initial.running, false)
  assert.equal(initial.port, 5680)
  assert.deepEqual(initial.urls, [])
  assert.equal(initial.error, null)

  const fake = installFakeListener()
  const status = await enableRemoteBridge({ fetch: fakeFetch, port: 5691, bindAddress: ADDRESS })
  assert.equal(status.state, 'running')
  assert.equal(status.enabled, true)
  assert.equal(status.port, 5691)
  assert.equal(status.bindAddress, ADDRESS)
  assert.deepEqual(status.urls, [`http://${ADDRESS}:5691`])
  assert.equal(fake.getCaptured()?.hostname, ADDRESS)
  assert.equal(fake.getCaptured()?.port, 5691)
  assert.equal(fake.getCaptured()?.fetch, fakeFetch)

  const settings = (await import('../src/services/remote-access.ts')).getRemoteAccessSettings()
  assert.equal(settings.port, 5691)
  assert.equal(settings.bindAddress, ADDRESS)
  assert.equal(JSON.stringify(status).includes('x-huobao-bridge-key'), false)
})

test('无私有地址、非法绑定、端口占用与监听失败都返回可读错误', async () => {
  installFakeListener()

  __setBridgeAddressListerForTests(() => [])
  const noAddress = await enableRemoteBridge({ fetch: fakeFetch })
  assert.equal(noAddress.state, 'error')
  assert.equal(noAddress.errorCode, 'BRIDGE_NO_PRIVATE_ADDRESS')
  assert.ok(noAddress.error?.includes('局域网私有地址'))
  assert.equal(noAddress.retryable, true)

  const loopback = await enableRemoteBridge({ fetch: fakeFetch, bindAddress: '127.0.0.1' })
  assert.equal(loopback.errorCode, 'BRIDGE_INVALID_BIND')

  __setBridgeAddressListerForTests(() => [{ address: ADDRESS, interfaceName: 'en0' }])
  __setBridgePortCheckerForTests(async () => false)
  const occupied = await enableRemoteBridge({ fetch: fakeFetch, bindAddress: ADDRESS })
  assert.equal(occupied.state, 'error')
  assert.equal(occupied.errorCode, 'BRIDGE_PORT_IN_USE')
  assert.ok(occupied.error?.includes('端口'))

  __setBridgePortCheckerForTests(async () => true)
  installFakeListener({ throwOnCreate: Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }) })
  const failed = await enableRemoteBridge({ fetch: fakeFetch, bindAddress: ADDRESS })
  assert.equal(failed.state, 'error')
  assert.equal(failed.errorCode, 'BRIDGE_PORT_IN_USE')
})

test('重复开启幂等；运行中切换状态返回 409', async () => {
  installFakeListener()
  const first = await enableRemoteBridge({ fetch: fakeFetch, bindAddress: ADDRESS })
  assert.equal(first.state, 'running')
  const second = await enableRemoteBridge({ fetch: fakeFetch, bindAddress: ADDRESS, port: 5999 })
  assert.equal(second.port, first.port)

  // 模拟切换中：关闭后重新开启并让端口检查挂起，第二次开启立即返回 409
  await disableRemoteBridge()
  let release!: (available: boolean) => void
  __setBridgePortCheckerForTests(() => new Promise<boolean>(resolve => { release = resolve }))
  const pending = enableRemoteBridge({ fetch: fakeFetch, bindAddress: ADDRESS })
  await assert.rejects(
    () => enableRemoteBridge({ fetch: fakeFetch, bindAddress: ADDRESS }),
    (error: unknown) => error instanceof RemoteBridgeError && error.code === 'BRIDGE_BUSY' && error.status === 409,
  )
  release(true)
  await pending
})

test('关闭：停止监听、通知 SSE 关闭、清理连接，重复关闭幂等', async () => {
  const fake = installFakeListener()
  const hookEvents: string[] = []
  const unsubscribe = onRemoteBridgeClosing(() => hookEvents.push('hook'))
  await enableRemoteBridge({ fetch: fakeFetch, bindAddress: ADDRESS })
  assert.equal(getRemoteBridgeStatus().running, true)

  const disabled = await disableRemoteBridge()
  assert.equal(disabled.state, 'disabled')
  assert.equal(disabled.running, false)
  assert.deepEqual(disabled.urls, [])
  assert.deepEqual(hookEvents, ['hook'])
  assert.ok(fake.events.includes('close'))
  assert.ok(fake.events.includes('closeAllConnections'))

  const again = await disableRemoteBridge()
  assert.equal(again.state, 'disabled')
  assert.deepEqual(hookEvents, ['hook'])
  unsubscribe()
  await enableRemoteBridge({ fetch: fakeFetch, bindAddress: ADDRESS })
  await disableRemoteBridge()
  assert.deepEqual(hookEvents, ['hook'])
})

test('信任头：仅桥密钥匹配时接受设备上下文，伪造头被忽略', () => {
  const record = {
    id: 'device-1', name: '手机', platform: 'ios', tokenHash: 'hash', scope: 'readonly',
    createdAt: '2026-11-10T00:00:00.000Z', lastSeenAt: null,
    expiresAt: '2026-12-10T00:00:00.000Z', revokedAt: null, userAgent: null, lastIp: null,
  } as const

  const headers = new Headers({
    [BRIDGE_TRUST_HEADERS.key]: 'forged',
    [BRIDGE_TRUST_HEADERS.deviceId]: record.id,
    [BRIDGE_TRUST_HEADERS.scope]: record.scope,
    [BRIDGE_TRUST_HEADERS.role]: 'guest',
  })
  assert.equal(readBridgeTrustContext(headers), null)

  applyBridgeTrustHeaders(headers, record as never)
  assert.deepEqual(readBridgeTrustContext(headers), { deviceId: record.id, scope: 'readonly', role: 'guest' })

  const wrongScope = new Headers(headers)
  wrongScope.set(BRIDGE_TRUST_HEADERS.scope, 'admin')
  assert.equal(readBridgeTrustContext(wrongScope), null)

  const wrongRole = new Headers(headers)
  wrongRole.set(BRIDGE_TRUST_HEADERS.role, 'host')
  assert.equal(readBridgeTrustContext(wrongRole), null)
})
