import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-storage-route-'))
process.env.SQLITE_PATH = path.join(root, 'huobao.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_APP = '1'

const backupFile = path.join(root, 'backups', 'huobao-20261111-120000-000-manual.sqlite3')
fs.mkdirSync(path.dirname(backupFile), { recursive: true })
fs.writeFileSync(backupFile, Buffer.alloc(64, 1))
fs.writeFileSync(`${backupFile}.json`, JSON.stringify({
  name: 'huobao-20261111-120000-000-manual.sqlite3',
  reason: 'manual',
  createdAt: '2026-11-11T12:00:00.000Z',
  sizeBytes: 64,
  sha256: 'x',
  appVersion: '4.0.35',
}))
const backupDirBytes = fs.statSync(backupFile).size + fs.statSync(`${backupFile}.json`).size
fs.mkdirSync(path.join(root, 'sync'), { recursive: true })
fs.writeFileSync(path.join(root, 'sync', 'state.bin'), Buffer.alloc(4, 2))
fs.mkdirSync(path.join(root, 'static', 'images'), { recursive: true })
fs.writeFileSync(path.join(root, 'static', 'images', 'a.png'), Buffer.alloc(10, 3))
fs.writeFileSync(path.join(root, '.app-storage.json'), JSON.stringify({
  runtimeBytes: 1000,
  logsBytes: 200,
  cacheBytes: 30,
  updatedAt: '2026-11-11T12:00:00.000Z',
}))

const { sqlite } = await import('../src/db/index.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/storage.ts')).default)

after(() => {
  try { sqlite.close() } catch { /* 已关闭 */ }
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.HUOBAO_APP
})

test('应用模式存储统计包含备份、同步、运行时与阈值', async () => {
  const body = await (await app.request('/')).json() as any
  assert.equal(body.code, 200)
  const data = body.data
  assert.equal(data.mode, 'app')
  assert.equal(data.usage.backups, backupDirBytes)
  assert.equal(data.usage.sync, 4)
  assert.equal(data.usage.images, 10)
  assert.equal(data.app.runtimeBytes, 1000)
  assert.equal(data.app.logsBytes, 200)
  assert.equal(data.app.cacheBytes, 30)
  assert.equal(data.app.updatedAt, '2026-11-11T12:00:00.000Z')
  assert.equal(data.app.totalBytes, data.usage.total + 1230)
  assert.equal(data.backups.count, 1)
  assert.equal(data.backups.bytes, backupDirBytes)
  assert.equal(data.storage.warnBytes, 2 * 1024 * 1024 * 1024)
  assert.equal(data.storage.blockBytes, 500 * 1024 * 1024)
  assert.ok(['ok', 'warn', 'blocked', 'unknown'].includes(data.storage.level))
  assert.equal(typeof data.freeBytes, 'number')
})
