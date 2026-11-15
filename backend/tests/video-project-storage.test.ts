import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-swap-storage-'))
process.env.HUOBAO_DATA_DIR = root

const storage = await import('../src/services/video-project-storage.ts')
const route = await import('../src/routes/video-project-files.ts')
const { Hono } = await import('hono')

before(async () => {
  await storage.ensureVideoProjectStorageLayout(7)
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('creates the isolated video project layout', async () => {
  for (const sub of storage.VIDEO_PROJECT_SUBDIRS) {
    const stat = await fs.stat(path.join(storage.getVideoProjectStorageRoot(7), sub))
    assert.ok(stat.isDirectory(), `missing ${sub}`)
  }
  assert.equal(
    storage.videoProjectStorageRelative(7, 'outputs', 'a.mp4'),
    'static/video-projects/7/outputs/a.mp4',
  )
})

test('parses and resolves only safe project paths', () => {
  assert.deepEqual(storage.parseVideoProjectStoragePath('static/video-projects/7/outputs/a.mp4'), {
    projectId: 7,
    rest: 'outputs/a.mp4',
  })
  assert.equal(storage.parseVideoProjectStoragePath('static/projects/7/outputs/a.mp4'), null)
  assert.equal(storage.parseVideoProjectStoragePath('static/video-projects/7/../a.mp4'), null)
  assert.throws(() => storage.resolveVideoProjectStorageFile(7, '../secret.txt'))
  assert.throws(() => storage.videoProjectStorageRelative(7, 'unknown', 'a.mp4'))
})

test('serves full and ranged video files', async () => {
  const file = storage.resolveVideoProjectStorageFile(7, 'outputs/clip.mp4')
  await fs.writeFile(file, '0123456789')
  const app = new Hono()
  app.route('/static/video-projects', route.default)

  const full = await app.fetch(new Request('http://local/static/video-projects/7/outputs/clip.mp4'))
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'video/mp4')
  assert.equal(await full.text(), '0123456789')

  const partial = await app.fetch(new Request('http://local/static/video-projects/7/outputs/clip.mp4', {
    headers: { range: 'bytes=2-5' },
  }))
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(await partial.text(), '2345')

  const traversal = await app.fetch(new Request('http://local/static/video-projects/7/outputs/%2e%2e/%2e%2e/secret.txt'))
  assert.equal(traversal.status, 404)
})

test('removes the whole project media tree', async () => {
  await storage.removeVideoProjectStorage(7)
  assert.equal(storage.videoProjectStorageExists(7), false)
})
