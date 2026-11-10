/**
 * P1 远程接力基座：remote_devices 建表幂等、令牌哈希唯一、远程设置校验与设备展示序列化
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-remote-access-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db } = await import('../src/db/index.ts')
const { initSqliteSchema } = await import('../src/db/sqlite-schema.ts')
const {
  getRemoteAccessSettings,
  setRemoteAccessSettings,
  resetRemoteAccessSettings,
  RemoteSettingsValidationError,
  isPrivateIPv4,
  toRemoteDeviceView,
  maskRemoteIp,
  remoteDeviceStatus,
} = await import('../src/services/remote-access.ts')

test.after(() => {
  db.$client.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function tableColumns(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name)
}

function rawDatabase(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-remote-schema-'))
  const sqlite = new Database(path.join(dir, 'schema.sqlite3'))
  sqlite.exec('PRAGMA foreign_keys = ON')
  initSqliteSchema(sqlite)
  initSqliteSchema(sqlite)
  return sqlite
}

test('remote_devices 建表可重复执行且字段完整', () => {
  const sqlite = rawDatabase()
  try {
    assert.deepEqual(tableColumns(sqlite, 'remote_devices'), [
      'id', 'name', 'platform', 'token_hash', 'scope',
      'created_at', 'last_seen_at', 'expires_at', 'revoked_at', 'user_agent', 'last_ip',
    ])
    const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'remote_devices'")
      .all() as { name: string }[]
    const names = indexes.map(row => row.name)
    assert.ok(names.includes('idx_remote_devices_token'))
    assert.ok(names.includes('idx_remote_devices_expires'))
    assert.ok(names.includes('idx_remote_devices_revoked'))
  } finally {
    sqlite.close()
  }
})

test('token_hash 唯一约束生效', () => {
  const sqlite = rawDatabase()
  try {
    const insert = sqlite.prepare(`INSERT INTO remote_devices
      (id, name, platform, token_hash, scope, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    insert.run('d1', '手机', 'ios', 'hash-a', 'full', '2026-11-10T00:00:00.000Z', '2026-12-10T00:00:00.000Z')
    assert.throws(
      () => insert.run('d2', '平板', 'ipad', 'hash-a', 'readonly', '2026-11-10T00:00:00.000Z', '2026-12-10T00:00:00.000Z'),
      /UNIQUE/,
    )
  } finally {
    sqlite.close()
  }
})

test('远程设置：默认值、读写与恢复默认', () => {
  const defaults = getRemoteAccessSettings()
  assert.equal(defaults.port, 5680)
  assert.equal(defaults.bindAddress, '')
  assert.equal(defaults.sessionDays, 30)
  assert.ok(defaults.deviceName.length >= 1 && defaults.deviceName.length <= 40)

  const updated = setRemoteAccessSettings({
    port: 5690,
    bindAddress: '192.168.1.20',
    sessionDays: 90,
    deviceName: '  剪辑台  ',
  })
  assert.deepEqual(updated, { port: 5690, bindAddress: '192.168.1.20', sessionDays: 90, deviceName: '剪辑台' })
  assert.deepEqual(getRemoteAccessSettings(), updated)

  setRemoteAccessSettings({ sessionDays: 7 })
  assert.equal(getRemoteAccessSettings().sessionDays, 7)
  assert.equal(getRemoteAccessSettings().port, 5690)

  const reset = resetRemoteAccessSettings()
  assert.equal(reset.port, 5680)
  assert.equal(reset.bindAddress, '')
  assert.equal(reset.sessionDays, 30)
  assert.deepEqual(getRemoteAccessSettings(), reset)
})

test('远程设置：非法值拒绝写入且保留原值', () => {
  setRemoteAccessSettings({ port: 5700 })
  const cases: Array<{ patch: unknown; field: string }> = [
    { patch: { port: 80 }, field: 'port' },
    { patch: { port: 70000 }, field: 'port' },
    { patch: { port: 5680.5 }, field: 'port' },
    { patch: { bindAddress: '127.0.0.1' }, field: 'bindAddress' },
    { patch: { bindAddress: '8.8.8.8' }, field: 'bindAddress' },
    { patch: { bindAddress: '169.254.10.2' }, field: 'bindAddress' },
    { patch: { sessionDays: 14 }, field: 'sessionDays' },
    { patch: { deviceName: '   ' }, field: 'deviceName' },
  ]
  for (const { patch, field } of cases) {
    assert.throws(
      () => setRemoteAccessSettings(patch),
      (error: unknown) => error instanceof RemoteSettingsValidationError && error.field === field,
    )
  }
  assert.equal(getRemoteAccessSettings().port, 5700)
  assert.equal(getRemoteAccessSettings().bindAddress, '')
})

test('私有 IPv4 判定：仅 RFC1918', () => {
  for (const ip of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.31.100']) {
    assert.equal(isPrivateIPv4(ip), true, ip)
  }
  for (const ip of ['', '0.0.0.0', '127.0.0.1', '172.15.0.1', '172.32.0.1', '169.254.1.1', '192.169.1.1', '224.0.0.1', '192.168.1', 'abc', '192.168.1.256', '::1']) {
    assert.equal(isPrivateIPv4(ip), false, ip)
  }
})

test('设备展示序列化剥离令牌哈希与完整 UA/IP', () => {
  const view = toRemoteDeviceView({
    id: 'device-1',
    name: '手机',
    platform: 'ios',
    tokenHash: 'secret-hash',
    scope: 'readonly',
    createdAt: '2026-11-10T00:00:00.000Z',
    lastSeenAt: '2026-11-10T01:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    revokedAt: null,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) secret',
    lastIp: '192.168.31.100',
  })
  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes('secret-hash'), false)
  assert.equal(serialized.includes('Mozilla'), false)
  assert.equal(serialized.includes('192.168.31.100'), false)
  assert.equal(view.ipMasked, '192.168.31.*')
  assert.equal(view.status, 'active')
  assert.equal(view.scope, 'readonly')
})

test('IP 掩码与设备状态', () => {
  assert.equal(maskRemoteIp(null), '')
  assert.equal(maskRemoteIp('not-an-ip'), '')
  assert.equal(maskRemoteIp('10.1.2.3'), '10.1.2.*')

  const base = { revokedAt: null, expiresAt: '2026-12-10T00:00:00.000Z' }
  assert.equal(remoteDeviceStatus(base, '2026-11-10T00:00:00.000Z'), 'active')
  assert.equal(remoteDeviceStatus(base, '2026-12-10T00:00:00.000Z'), 'expired')
  assert.equal(remoteDeviceStatus({ ...base, revokedAt: '2026-11-11T00:00:00.000Z' }, '2026-11-10T00:00:00.000Z'), 'revoked')
})
