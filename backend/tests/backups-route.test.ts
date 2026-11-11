import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-backup-route-'))
process.env.SQLITE_PATH = path.join(root, 'huobao.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_APP = '1'
process.env.HUOBAO_VERSION = '4.0.35'

const { sqlite } = await import('../src/db/index.ts')
const { readRestoreRequest } = await import('../src/services/db-backups.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/backups.ts')).default)

after(() => {
  try { sqlite.close() } catch { /* 已关闭 */ }
  fs.rmSync(root, { recursive: true, force: true })
})

async function json(response: Response): Promise<any> {
  return response.json()
}

test('备份接口：列表、创建、下载、恢复请求与删除保护', async () => {
  const empty = await json(await app.request('/'))
  assert.equal(empty.code, 200)
  assert.deepEqual(empty.data.backups, [])
  assert.equal(empty.data.maxBackups, 3)

  const created = await json(await app.request('/', { method: 'POST' }))
  assert.equal(created.code, 201)
  assert.equal(created.data.reason, 'manual')

  const list = await json(await app.request('/'))
  assert.equal(list.data.backups.length, 1)
  assert.equal(list.data.backups[0].name, created.data.name)

  const download = await app.request(`/${created.data.name}/download`)
  assert.equal(download.status, 200)
  assert.match(download.headers.get('content-disposition') ?? '', /attachment/)
  const onDisk = fs.readFileSync(path.join(root, 'backups', created.data.name))
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), onDisk)

  const restore = await json(await app.request(`/${created.data.name}/restore`, { method: 'POST' }))
  assert.equal(restore.code, 200)
  assert.equal(restore.data.restartRequired, true)
  assert.ok((await readRestoreRequest(root))?.safetyBackup)

  const blocked = await json(await app.request(`/${created.data.name}`, { method: 'DELETE' }))
  assert.equal(blocked.code, 400)
  assert.match(blocked.message, /等待恢复/)
})

test('非独立应用模式拒绝访问', async () => {
  process.env.HUOBAO_APP = '0'
  const response = await app.request('/')
  assert.equal(response.status, 403)
  process.env.HUOBAO_APP = '1'
})
