/**
 * A8 清单：表行数 + schema 指纹 + 媒体哈希清单，绑定 run 并落盘。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-sync-manifest-'))
const storage = path.join(root, 'static')
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = storage
process.env.MYSQL_AUTO_IMPORT = 'false'

const { syncSchemaFingerprint } = await import('../src/services/data-sync-scope.ts')
const {
  buildSyncManifest,
  prepareSyncRunManifest,
  readSyncRunManifest,
  manifestFilePath,
  SyncManifestError,
} = await import('../src/services/data-sync-manifest.ts')
const {
  createSyncRun,
  approveSyncRun,
  getSyncRun,
  __resetSyncRunsForTests,
} = await import('../src/services/data-sync-runs.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function createApprovedRun(deviceId: string, fingerprint = syncSchemaFingerprint()) {
  const run = createSyncRun({
    deviceId,
    direction: 'pull',
    clientVersion: '4.0.35',
    serverVersion: '4.0.35',
    schemaFingerprint: fingerprint,
  })
  approveSyncRun(run.id)
  return run
}

test('清单：包含 44 张表行数、schema 指纹与媒体哈希', async () => {
  await fs.mkdir(path.join(storage, 'videos'), { recursive: true })
  await fs.writeFile(path.join(storage, 'videos/a.mp4'), Buffer.from('media-a'))
  const manifest = await buildSyncManifest('4.0.35')
  assert.equal(manifest.version, '4.0.35')
  assert.equal(manifest.schemaFingerprint, syncSchemaFingerprint())
  assert.equal(manifest.tables.length, 44)
  assert.equal(manifest.media.length, 1)
  assert.equal(manifest.media[0].path, 'static/videos/a.mp4')
  assert.match(String(manifest.media[0].sha256), /^[0-9a-f]{64}$/)
  assert.equal(manifest.totalBytes, 7)
})

test('绑定 run：清单落盘、run 进入 manifest_ready、可回读', async () => {
  __resetSyncRunsForTests()
  const run = createApprovedRun('device-manifest', syncSchemaFingerprint())
  const manifest = await prepareSyncRunManifest(run.id, '4.0.35')
  assert.equal(getSyncRun(run.id).status, 'manifest_ready')
  const file = manifestFilePath(getSyncRun(run.id))
  await assert.doesNotReject(() => fs.stat(file))
  const read = await readSyncRunManifest(run.id)
  assert.ok(read)
  assert.deepEqual(read?.tables, manifest.tables)
  assert.deepEqual(read?.media, manifest.media)
})

test('清单与 run 绑定：未确认、schema 不一致、未生成时拒绝/返回空', async () => {
  __resetSyncRunsForTests()
  const pending = createSyncRun({
    deviceId: 'device-pending',
    direction: 'push',
    clientVersion: '4.0.35',
    serverVersion: '4.0.35',
    schemaFingerprint: syncSchemaFingerprint(),
  })
  await assert.rejects(
    () => prepareSyncRunManifest(pending.id, '4.0.35'),
    (error: any) => error instanceof SyncManifestError && error.code === 'SYNC_MANIFEST_STATE',
  )

  const wrongSchema = createApprovedRun('device-schema', 'b'.repeat(64))
  await assert.rejects(
    () => prepareSyncRunManifest(wrongSchema.id, '4.0.35'),
    (error: any) => error?.code === 'SYNC_MANIFEST_SCHEMA',
  )

  __resetSyncRunsForTests()
  const empty = createApprovedRun('device-empty', syncSchemaFingerprint())
  assert.equal(await readSyncRunManifest(empty.id), null)
})
