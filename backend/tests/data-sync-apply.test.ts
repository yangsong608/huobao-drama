/**
 * A8 快照与应用：在线备份、完整性/指纹/行数校验、事务替换、运行时表清理、
 * 非同步表保留、备份保留与磁盘预检。隔离数据库与临时目录。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-sync-apply-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema, sqlite } = await import('../src/db/index.ts')
const {
  createSyncDatabaseSnapshot,
  inspectSyncDatabaseSnapshot,
  validateSyncSnapshot,
  SyncSnapshotError,
} = await import('../src/services/data-sync-snapshot.ts')
const {
  applySyncSnapshot,
  listSyncBackups,
  SyncApplyError,
} = await import('../src/services/data-sync-apply.ts')
const { syncSchemaFingerprint, syncTableRowCounts } = await import('../src/services/data-sync-scope.ts')

const ts = new Date().toISOString()
after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function seedSource() {
  const drama = await db.insert(schema.dramas).values({
    title: '源项目', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts,
  }).returning()
  const dramaId = drama[0].id
  const episode = await db.insert(schema.episodes).values({
    dramaId, episodeNumber: 1, title: '源第1集', createdAt: ts, updatedAt: ts,
  }).returning()
  await db.insert(schema.storyboards).values({
    episodeId: episode[0].id, storyboardNumber: 1, description: '源分镜', createdAt: ts, updatedAt: ts,
  })
  await db.insert(schema.sysTask).values({ type: 'video', status: 'processing', createdAt: ts, updatedAt: ts })
  await db.insert(schema.appSettings).values({ key: 'keep-me', value: 'target-value', updatedAt: ts })
  return { dramaId, episodeId: episode[0].id }
}

function snapshotPath(name = 'db.sqlite3') {
  return path.join(root, 'sync', 'staging', 'run-test', name)
}

const source = await seedSource()

test('在线快照：integrity、schema 指纹与行数可用', async () => {
  const info = await createSyncDatabaseSnapshot(snapshotPath())
  assert.equal(info.integrity, 'ok')
  assert.equal(info.schemaFingerprint, syncSchemaFingerprint())
  assert.ok(info.fileSize > 0)
  const rows = new Map(info.rowCounts.map(item => [item.table, item.rows]))
  assert.equal(rows.get('dramas'), 1)
  assert.equal(rows.get('episodes'), 1)
  assert.equal(rows.get('storyboards'), 1)
  assert.equal(rows.get('sys_task'), undefined, '不同步表不得进入行数清单')
  assert.doesNotThrow(() => validateSyncSnapshot(snapshotPath(), {
    schemaFingerprint: info.schemaFingerprint,
    rowCounts: info.rowCounts,
    fileSize: info.fileSize,
  }))
})

test('应用快照：覆盖同步表、保留不同步表、清理运行时表并备份', async () => {
  const info = await createSyncDatabaseSnapshot(snapshotPath())
  const expected = {
    schemaFingerprint: info.schemaFingerprint,
    rowCounts: info.rowCounts,
    fileSize: info.fileSize,
  }

  // 目标端污染：改标题、删分镜、加项目与任务、改 app_settings
  await db.update(schema.dramas).set({ title: '被覆盖' }).where(eq(schema.dramas.id, source.dramaId))
  await db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, source.episodeId))
  await db.insert(schema.dramas).values({ title: '目标多余', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts })
  await db.insert(schema.sysTask).values({ type: 'image', status: 'processing', createdAt: ts, updatedAt: ts })
  await db.update(schema.appSettings).set({ value: 'target-value-2' }).where(eq(schema.appSettings.key, 'keep-me'))

  const result = await applySyncSnapshot(snapshotPath(), expected, { requiredBytes: 0 })
  assert.ok(result.backupPath.includes(`${path.sep}sync${path.sep}backups${path.sep}`))
  assert.equal(result.tables, 52)
  assert.ok(result.rows >= 3)

  const dramas = await db.select().from(schema.dramas)
  assert.equal(dramas.length, 1)
  assert.equal(dramas[0].title, '源项目')
  const storyboards = await db.select().from(schema.storyboards)
  assert.equal(storyboards.length, 1)
  const tasks = await db.select().from(schema.sysTask)
  assert.equal(tasks.length, 0, '运行时任务表必须清空')
  const settings = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'keep-me'))
  assert.equal(settings[0]?.value, 'target-value-2', '不同步表保留目标端值')

  const backups = await listSyncBackups()
  assert.equal(backups.length, 1)
  assert.ok(backups[0].size > 0)

  // AUTOINCREMENT 计数已更新，新插入不会复用已删除的 ID
  const next = await db.insert(schema.dramas).values({
    title: '应用后新增', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts,
  }).returning()
  assert.ok(next[0].id > source.dramaId)
})

test('快照校验拒绝 schema/行数/大小不一致与损坏文件', async () => {
  const info = await createSyncDatabaseSnapshot(snapshotPath('validate.sqlite3'))
  assert.throws(
    () => validateSyncSnapshot(snapshotPath('validate.sqlite3'), {
      schemaFingerprint: 'b'.repeat(64), rowCounts: info.rowCounts,
    }),
    (error: any) => error instanceof SyncSnapshotError && error.code === 'SYNC_SNAPSHOT_SCHEMA',
  )
  const badRows = info.rowCounts.map(item => item.table === 'dramas' ? { ...item, rows: 99 } : item)
  assert.throws(
    () => validateSyncSnapshot(snapshotPath('validate.sqlite3'), {
      schemaFingerprint: info.schemaFingerprint, rowCounts: badRows,
    }),
    (error: any) => error?.code === 'SYNC_SNAPSHOT_ROWS',
  )
  assert.throws(
    () => validateSyncSnapshot(snapshotPath('validate.sqlite3'), {
      schemaFingerprint: info.schemaFingerprint, rowCounts: info.rowCounts, fileSize: info.fileSize + 1,
    }),
    (error: any) => error?.code === 'SYNC_SNAPSHOT_SIZE',
  )

  const corrupt = snapshotPath('corrupt.sqlite3')
  await fs.mkdir(path.dirname(corrupt), { recursive: true })
  await fs.writeFile(corrupt, 'not a sqlite database')
  assert.throws(
    () => inspectSyncDatabaseSnapshot(corrupt),
    (error: any) => error instanceof SyncSnapshotError,
  )
})

test('路径与磁盘：快照必须在 sync 内，空间不足拒绝应用', async () => {
  const info = await createSyncDatabaseSnapshot(snapshotPath('disk.sqlite3'))
  await assert.rejects(
    () => createSyncDatabaseSnapshot(path.join(root, 'outside.sqlite3')),
    (error: any) => error?.code === 'SYNC_SNAPSHOT_PATH',
  )
  await assert.rejects(
    () => applySyncSnapshot(snapshotPath('disk.sqlite3'), {
      schemaFingerprint: info.schemaFingerprint,
      rowCounts: info.rowCounts,
    }, { requiredBytes: Number.MAX_SAFE_INTEGER }),
    (error: any) => error instanceof SyncApplyError && error.code === 'SYNC_DISK_FULL',
  )
  // 不使用只读连接做写入校验，确保当前库仍可用
  const rows = syncTableRowCounts()
  assert.ok(rows.length === 52)
})
