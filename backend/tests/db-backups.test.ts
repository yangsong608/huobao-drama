import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {
  MAX_BACKUPS,
  applyPendingRestore,
  createBackupFromConnection,
  deleteBackup,
  fileSha256,
  listBackups,
  prepareStartupBackup,
  readRestoreRequest,
  readRestoreResult,
  requestRestore,
} from '../src/services/db-backups.ts'

const roots: string[] = []

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huobao-backup-${label}-`))
  roots.push(root)
  return root
}

function seedDb(root: string): { dbPath: string; db: Database.Database } {
  const dbPath = path.join(root, 'huobao.sqlite3')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  db.prepare('INSERT INTO items (name) VALUES (?)').run('alpha')
  return { dbPath, db }
}

function itemNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    return db.prepare('SELECT name FROM items ORDER BY id').all().map((row: any) => row.name)
  } finally {
    db.close()
  }
}

function dbFacts(dbPath: string): { integrity: string; tables: number } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const integrity = String(db.pragma('integrity_check', { simple: true }))
    const row = db.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).get() as { n: number }
    return { integrity, tables: row.n }
  } finally {
    db.close()
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

test('首次启动与版本升级自动备份且校验和一致', async () => {
  const root = tempRoot('startup')
  const { dbPath, db } = seedDb(root)
  db.close()

  const first = await prepareStartupBackup({ dbPath, dataRoot: root, appVersion: '1.0.0' })
  assert.ok(first.created, first.error)
  assert.equal(first.created?.reason, 'first-start')
  assert.equal(first.created?.appVersion, '1.0.0')
  const file = path.join(root, 'backups', first.created!.name)
  assert.equal(await fileSha256(file), first.created?.sha256)

  const repeat = await prepareStartupBackup({ dbPath, dataRoot: root, appVersion: '1.0.0' })
  assert.equal(repeat.created, undefined)
  assert.equal(repeat.skipped, 'not-needed')

  await sleep(5)
  const upgrade = await prepareStartupBackup({ dbPath, dataRoot: root, appVersion: '1.0.1' })
  assert.equal(upgrade.created?.reason, 'upgrade')
  assert.equal(upgrade.created?.appVersion, '1.0.1')
  assert.equal((await listBackups(root)).length, 2)
})

test('空库不生成自动备份', async () => {
  const root = tempRoot('empty')
  const dbPath = path.join(root, 'huobao.sqlite3')
  const db = new Database(dbPath)
  db.close()
  const result = await prepareStartupBackup({ dbPath, dataRoot: root, appVersion: '1.0.0' })
  assert.equal(result.skipped, 'empty-db')
  assert.equal((await listBackups(root)).length, 0)
})

test('备份保留最新三份并可按名删除', async () => {
  const root = tempRoot('retention')
  const { db } = seedDb(root)
  const created = []
  for (let index = 0; index < MAX_BACKUPS + 2; index += 1) {
    created.push(await createBackupFromConnection(db, 'manual', { dataRoot: root, appVersion: '1.0.0' }))
    await sleep(5)
  }
  db.close()

  const metas = await listBackups(root)
  assert.equal(metas.length, MAX_BACKUPS)
  const kept = new Set(metas.map(meta => meta.name))
  assert.ok(kept.has(created.at(-1)!.name))
  assert.ok(kept.has(created.at(-2)!.name))
  assert.ok(kept.has(created.at(-3)!.name))
  assert.ok(!kept.has(created[0].name))

  await deleteBackup(created.at(-1)!.name, root)
  assert.equal((await listBackups(root)).length, MAX_BACKUPS - 1)
})

test('恢复请求生成安全备份，重启前替换主库', async () => {
  const root = tempRoot('restore')
  const { dbPath, db } = seedDb(root)
  const backup = await createBackupFromConnection(db, 'manual', { dataRoot: root, appVersion: '1.0.0' })
  const backupFile = dbFacts(path.join(root, 'backups', backup.name))
  assert.equal(backupFile.integrity, 'ok')
  assert.equal(backupFile.tables, 1)

  db.prepare('INSERT INTO items (name) VALUES (?)').run('beta')
  assert.deepEqual(itemNames(dbPath), ['alpha', 'beta'])

  const request = await requestRestore(backup.name, { dataRoot: root, db, appVersion: '1.0.0' })
  assert.equal(request.name, backup.name)
  assert.equal(request.sha256, backup.sha256)
  assert.ok((await readRestoreRequest(root))?.safetyBackup)

  const metas = await listBackups(root)
  assert.ok(metas.some(meta => meta.reason === 'pre-restore'))
  assert.ok(metas.some(meta => meta.name === backup.name), '恢复目标必须保留')

  await assert.rejects(() => deleteBackup(backup.name, root), /等待恢复/)

  db.close()
  const result = await applyPendingRestore({ dbPath, dataRoot: root })
  assert.equal(result?.ok, true)
  assert.equal(result?.name, backup.name)
  assert.equal(await readRestoreRequest(root), null)
  assert.equal((await readRestoreResult(root))?.ok, true)
  assert.deepEqual(itemNames(dbPath), ['alpha'])
  const restored = dbFacts(dbPath)
  assert.equal(restored.integrity, 'ok')
  assert.equal(restored.tables, 1, '恢复后的库表数量应与备份一致')
})

test('校验和不匹配的恢复失败且保留原库', async () => {
  const root = tempRoot('corrupt')
  const { dbPath, db } = seedDb(root)
  const backup = await createBackupFromConnection(db, 'manual', { dataRoot: root, appVersion: '1.0.0' })
  db.prepare('INSERT INTO items (name) VALUES (?)').run('beta')

  await requestRestore(backup.name, { dataRoot: root, db, appVersion: '1.0.0' })
  db.close()

  fs.appendFileSync(path.join(root, 'backups', backup.name), Buffer.from([0x00]))
  const result = await applyPendingRestore({ dbPath, dataRoot: root })
  assert.equal(result?.ok, false)
  assert.match(result?.error ?? '', /校验和/)
  assert.deepEqual(itemNames(dbPath), ['alpha', 'beta'])
  assert.equal(await readRestoreRequest(root), null)
})
