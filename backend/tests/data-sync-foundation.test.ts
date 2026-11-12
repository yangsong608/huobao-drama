/**
 * A8 同步基座：范围/指纹/行数、媒体清单与路径边界、run 状态机与限流。
 * 隔离数据库与临时媒体目录，不读取开发库。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-sync-foundation-'))
const storage = path.join(root, 'static')
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = storage
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const {
  SYNC_TABLES,
  NON_SYNC_TABLES,
  RUNTIME_CLEAR_TABLES,
  inspectSyncScopeCoverage,
  assertSyncScopeCoverage,
  syncSchemaFingerprint,
  syncTableRowCounts,
  assertSyncTableRowCounts,
  SyncScopeError,
} = await import('../src/services/data-sync-scope.ts')
const {
  buildMediaManifest,
  normalizeMediaPath,
  mediaAbsolutePath,
  verifyMediaEntry,
  SyncMediaError,
} = await import('../src/services/data-sync-media.ts')
const {
  createSyncRun,
  getSyncRun,
  approveSyncRun,
  denySyncRun,
  attachSyncManifest,
  beginSyncTransfer,
  markSyncUploaded,
  beginSyncApply,
  completeSyncRun,
  cancelSyncRun,
  expireRuns,
  cleanupOrphanStaging,
  assertSyncCompatibility,
  __resetSyncRunsForTests,
  SYNC_RUN_TTL_MS,
  SyncRunError,
} = await import('../src/services/data-sync-runs.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('同步范围：65 张表 = 52 业务 + 13 不同步，运行时清理表在 non-sync 内', () => {
  assert.equal(SYNC_TABLES.length, 52)
  assert.equal(NON_SYNC_TABLES.length, 13)
  assert.equal(new Set([...SYNC_TABLES, ...NON_SYNC_TABLES]).size, 65)
  for (const table of RUNTIME_CLEAR_TABLES) {
    assert.ok(NON_SYNC_TABLES.includes(table), `${table} 应在不同步表内`)
  }
  const coverage = inspectSyncScopeCoverage()
  assert.deepEqual(coverage.unknown, [])
  assert.deepEqual(coverage.missing, [])
  assert.equal(coverage.ok, true)
  assert.doesNotThrow(() => assertSyncScopeCoverage())
})

test('schema 指纹：64 位十六进制、稳定且与行数据无关', async () => {
  const first = syncSchemaFingerprint()
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(syncSchemaFingerprint(), first)
  const ts = new Date().toISOString()
  await db.insert(schema.dramas).values({ title: '同步指纹测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts })
  assert.equal(syncSchemaFingerprint(), first, '新增行不得改变 schema 指纹')
})

test('行数清单：覆盖全部业务表，可校验且能识别不一致', () => {
  const counts = syncTableRowCounts()
  assert.equal(counts.length, 52)
  assert.ok(counts.every(item => Number.isInteger(item.rows) && item.rows >= 0))
  assert.doesNotThrow(() => assertSyncTableRowCounts(counts))
  const bad = counts.map(item => item.table === 'dramas' ? { ...item, rows: item.rows + 1 } : item)
  assert.throws(
    () => assertSyncTableRowCounts(bad),
    (error: any) => error instanceof SyncScopeError && error.code === 'SYNC_ROW_COUNT_MISMATCH',
  )
})

test('媒体路径：只允许 static 下的七个根，拒绝穿越/绝对路径/temp', () => {
  assert.equal(normalizeMediaPath('static/videos/a.mp4'), 'static/videos/a.mp4')
  for (const bad of [
    '/etc/passwd',
    'C:/secret.txt',
    'static/../app_settings',
    'static/videos/../../x',
    'static/temp/a.mp4',
    'static/videos//a.mp4',
    'static/videos/a\0.mp4',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => normalizeMediaPath(bad), SyncMediaError, String(bad))
  }
  assert.throws(() => mediaAbsolutePath('static/videos/../../app_settings'), SyncMediaError)
})

test('媒体清单：递归、排序、计算哈希、跳过符号链接与 temp', async () => {
  await fs.mkdir(path.join(storage, 'projects/p1'), { recursive: true })
  await fs.mkdir(path.join(storage, 'videos'), { recursive: true })
  await fs.mkdir(path.join(storage, 'temp'), { recursive: true })
  await fs.writeFile(path.join(storage, 'projects/p1/a.png'), Buffer.from('alpha'))
  await fs.writeFile(path.join(storage, 'videos/b.mp4'), Buffer.from('beta'))
  await fs.writeFile(path.join(storage, 'temp/c.txt'), Buffer.from('temp'))
  const outside = path.join(root, 'outside.txt')
  await fs.writeFile(outside, Buffer.from('outside'))
  await fs.symlink(outside, path.join(storage, 'videos/link.mp4'))

  const manifest = await buildMediaManifest({ includeHash: true })
  assert.deepEqual(manifest.items.map(item => item.path), ['static/projects/p1/a.png', 'static/videos/b.mp4'])
  assert.equal(manifest.totalFiles, 2)
  assert.equal(manifest.totalBytes, 9)
  assert.equal(
    manifest.items[0].sha256,
    crypto.createHash('sha256').update('alpha').digest('hex'),
  )
  assert.equal(manifest.items[1].sha256, crypto.createHash('sha256').update('beta').digest('hex'))
  await assert.doesNotReject(() => verifyMediaEntry(manifest.items[0]))
  await fs.writeFile(path.join(storage, 'projects/p1/a.png'), Buffer.from('changed'))
  await assert.rejects(() => verifyMediaEntry(manifest.items[0]), SyncMediaError)
})

test('run 状态机：确认→清单→传输→应用→完成', () => {
  __resetSyncRunsForTests()
  const now = 1_700_000_000_000
  const fingerprint = 'a'.repeat(64)
  const run = createSyncRun({
    deviceId: 'device-1',
    direction: 'pull',
    clientVersion: '4.0.35',
    serverVersion: '4.0.35',
    schemaFingerprint: fingerprint,
    clientLabel: 'Y700',
  }, { now })
  assert.equal(run.status, 'pending_confirmation')
  assert.equal(run.clientLabel, 'Y700')
  assert.equal(run.expiresAtMs, now + SYNC_RUN_TTL_MS)

  approveSyncRun(run.id, { now: now + 1 })
  attachSyncManifest(run.id, { totalFiles: 2, totalBytes: 100 }, { now: now + 2 })
  beginSyncTransfer(run.id, { now: now + 3 })
  markSyncUploaded(run.id, { now: now + 4 })
  beginSyncApply(run.id, { now: now + 5 })
  const done = completeSyncRun(run.id, { now: now + 6 })
  assert.equal(done.status, 'completed')
  assert.equal(done.manifest?.totalFiles, 2)
  assert.throws(
    () => beginSyncTransfer(run.id),
    (error: any) => error instanceof SyncRunError && error.code === 'SYNC_BAD_STATE',
  )
})

test('run 归属、版本/schema 校验与取消', () => {
  __resetSyncRunsForTests()
  assert.throws(
    () => assertSyncCompatibility(
      { deviceId: 'd', direction: 'pull', clientVersion: '4.0.35', serverVersion: '4.0.36', schemaFingerprint: 'a'.repeat(64) },
      { serverVersion: '4.0.35', schemaFingerprint: 'a'.repeat(64) },
    ),
    (error: any) => error?.code === 'SYNC_VERSION_MISMATCH',
  )
  assert.throws(
    () => assertSyncCompatibility(
      { deviceId: 'd', direction: 'pull', clientVersion: '4.0.35', serverVersion: '4.0.35', schemaFingerprint: 'a'.repeat(64) },
      { serverVersion: '4.0.35', schemaFingerprint: 'b'.repeat(64) },
    ),
    (error: any) => error?.code === 'SYNC_SCHEMA_MISMATCH',
  )

  const run = createSyncRun({
    deviceId: 'device-a',
    direction: 'push',
    clientVersion: '4.0.35',
    serverVersion: '4.0.35',
    schemaFingerprint: 'a'.repeat(64),
  })
  assert.throws(
    () => getSyncRun(run.id, 'device-b'),
    (error: any) => error?.code === 'SYNC_RUN_FORBIDDEN',
  )
  const cancelled = cancelSyncRun(run.id, 'device-a')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.errorCode, 'SYNC_CANCELLED')
})

test('限流与并发：同设备仅一个进行中，每分钟最多创建 3 次', () => {
  __resetSyncRunsForTests()
  const input = {
    deviceId: 'device-rate',
    direction: 'pull' as const,
    clientVersion: '4.0.35',
    serverVersion: '4.0.35',
    schemaFingerprint: 'a'.repeat(64),
  }
  const now = 1_700_000_000_000
  createSyncRun(input, { now })
  assert.throws(
    () => createSyncRun(input, { now: now + 1 }),
    (error: any) => error?.code === 'SYNC_RUN_ACTIVE',
  )

  const rateInput = { ...input, deviceId: 'device-minute' }
  for (let index = 0; index < 3; index += 1) {
    const run = createSyncRun(rateInput, { now: now + index })
    denySyncRun(run.id, { now: now + index })
  }
  assert.throws(
    () => createSyncRun(rateInput, { now: now + 3 }),
    (error: any) => error?.code === 'SYNC_RATE_LIMITED',
  )
})

test('过期：24 小时后作废，未确认的 run 不能继续', () => {
  __resetSyncRunsForTests()
  const input = {
    deviceId: 'device-expire',
    direction: 'pull' as const,
    clientVersion: '4.0.35',
    serverVersion: '4.0.35',
    schemaFingerprint: 'a'.repeat(64),
  }
  const now = 1_700_000_000_000
  const run = createSyncRun(input, { now })
  assert.equal(expireRuns({ now: now + SYNC_RUN_TTL_MS + 1 }), 1)
  assert.equal(getSyncRun(run.id).status, 'expired')
  assert.throws(
    () => approveSyncRun(run.id),
    (error: any) => error?.code === 'SYNC_BAD_STATE',
  )
})

test('暂存清理：启动时清空孤儿目录', async () => {
  __resetSyncRunsForTests()
  const orphan = path.join(root, 'sync', 'staging', 'orphan-run')
  await fs.mkdir(orphan, { recursive: true })
  await fs.writeFile(path.join(orphan, 'partial.bin'), Buffer.from('x'))
  const removed = await cleanupOrphanStaging()
  assert.ok(removed >= 1)
  await assert.rejects(() => fs.stat(orphan))
})
