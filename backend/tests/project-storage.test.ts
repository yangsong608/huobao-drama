/**
 * 项目级存储验证（隔离库 + 临时目录，不读写用户数据）：
 * - 默认目录 static/projects/<id>/<sub>
 * - 自定义目录切换时搬移已有文件
 * - /static/projects 路由支持 Range
 * - 上传接口按 drama_id 落项目目录
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-project-storage-'))
const customDir = path.join(root, 'external', 'project-1')
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: dramasRoute } = await import('../src/routes/dramas.ts')
const { default: projectFilesRoute } = await import('../src/routes/project-files.ts')
const { default: uploadRoute } = await import('../src/routes/upload.ts')
const { getAbsolutePath, saveUploadedFile } = await import('../src/utils/storage.ts')
const { defaultProjectStorageRoot, getProjectStorageRoot, parseProjectStoragePath } =
  await import('../src/services/project-storage.ts')

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const ts = new Date().toISOString()

await db.insert(schema.dramas).values({ title: '存储测试项目', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts })

test('默认目录：写入 static/projects/<id>/<sub>，并可通过绝对路径解析', async () => {
  const stored = await saveUploadedFile(PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength), 'uploads', 'a.png', { dramaId: 1 })
  assert.match(stored, /^static\/projects\/1\/uploads\/[0-9a-f-]+\.png$/)
  const absolute = getAbsolutePath(stored)
  assert.equal(absolute, path.join(defaultProjectStorageRoot(1), 'uploads', path.basename(absolute)))
  assert.equal((await fs.stat(absolute)).size, PNG.length)
  assert.deepEqual(parseProjectStoragePath(stored), { dramaId: 1, rest: `uploads/${path.basename(stored)}` })
})

test('GET /dramas/:id/storage 返回默认目录与子目录占用', async () => {
  const app = new Hono().route('/dramas', dramasRoute)
  const res = await app.request('/dramas/1/storage')
  assert.equal(res.status, 200)
  const data = (await res.json() as any).data
  assert.equal(data.is_custom, false)
  assert.equal(data.effective_dir, defaultProjectStorageRoot(1))
  assert.ok(data.subdirs.some((d: any) => d.name === 'images'))
  assert.ok(data.total_bytes > 0)
})

test('PUT /dramas/:id/storage 切换目录并搬移已有文件', async () => {
  const app = new Hono().route('/dramas', dramasRoute)
  const before = await fs.readdir(path.join(defaultProjectStorageRoot(1), 'uploads'))
  const res = await app.request('/dramas/1/storage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storage_dir: customDir }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  const data = (await res.json() as any).data
  assert.equal(data.is_custom, true)
  assert.equal(data.effective_dir, customDir)
  assert.equal(getProjectStorageRoot(1), customDir)

  const moved = await fs.readdir(path.join(customDir, 'uploads'))
  assert.deepEqual(moved.sort(), before.sort())
  await assert.rejects(fs.stat(path.join(defaultProjectStorageRoot(1), 'uploads', before[0])))
})

test('切换后新文件写入自定义目录，旧逻辑路径仍可解析', async () => {
  const stored = await saveUploadedFile(PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength), 'images', 'b.png', { dramaId: 1 })
  const absolute = getAbsolutePath(stored)
  assert.equal(absolute, path.join(customDir, 'images', path.basename(absolute)))
  assert.equal((await fs.stat(absolute)).size, PNG.length)
})

test('PUT 拒绝相对路径', async () => {
  const app = new Hono().route('/dramas', dramasRoute)
  const res = await app.request('/dramas/1/storage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storage_dir: 'relative/dir' }),
  })
  assert.equal(res.status, 400)
})

test('/static/projects 支持普通请求与 Range', async () => {
  const app = new Hono().route('/static/projects', projectFilesRoute)
  const files = await fs.readdir(path.join(customDir, 'uploads'))
  const name = files[0]
  const res = await app.request(`/static/projects/1/uploads/${name}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  const body = Buffer.from(await res.arrayBuffer())
  assert.equal(body.length, PNG.length)

  const range = await app.request(`/static/projects/1/uploads/${name}`, {
    headers: { Range: 'bytes=0-3' },
  })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range'), `bytes 0-3/${PNG.length}`)
  assert.equal((await range.arrayBuffer()).byteLength, 4)

  const missing = await app.request('/static/projects/1/uploads/not-exist.png')
  assert.equal(missing.status, 404)
  const traversal = await app.request('/static/projects/1/..%2F..%2Fetc%2Fpasswd')
  assert.equal(traversal.status, 404)
})

test('上传接口带 drama_id 时落项目 uploads', async () => {
  const app = new Hono().route('/upload', uploadRoute)
  const form = new FormData()
  form.append('drama_id', '1')
  form.append('file', new File([PNG], 'upload.png', { type: 'image/png' }))
  const res = await app.request('/upload/image', { method: 'POST', body: form })
  assert.equal(res.status, 200, await res.clone().text())
  const data = (await res.json() as any).data
  assert.match(data.path, /^static\/projects\/1\/uploads\//)
  const absolute = getAbsolutePath(data.path)
  assert.ok(absolute.startsWith(customDir))
  assert.ok((await fs.stat(absolute)).size > 0)
})

test('恢复默认目录会把文件搬回 DATA_ROOT', async () => {
  const app = new Hono().route('/dramas', dramasRoute)
  const res = await app.request('/dramas/1/storage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storage_dir: null }),
  })
  assert.equal(res.status, 200, await res.clone().text())
  const data = (await res.json() as any).data
  assert.equal(data.is_custom, false)
  assert.equal(data.effective_dir, defaultProjectStorageRoot(1))
  assert.equal(getProjectStorageRoot(1), defaultProjectStorageRoot(1))
  const uploads = await fs.readdir(path.join(defaultProjectStorageRoot(1), 'uploads'))
  assert.ok(uploads.length >= 1)
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})
