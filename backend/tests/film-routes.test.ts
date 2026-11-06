import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-film-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/films.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({ title: '剧', createdAt: ts, updatedAt: ts }).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const url = `static/projects/${drama.id}/videos/f.mp4`
fs.writeFileSync(path.join(root, url), Buffer.from('x'))
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '集', createdAt: ts, updatedAt: ts,
}).returning().get()
const film = db.insert(schema.videoMerges).values({
  episodeId: episode.id, dramaId: drama.id, provider: 'ffmpeg', model: 'm',
  status: 'completed', kind: 'concat', origin: 'concat', mergedUrl: url, duration: 5,
  title: '拼接一', createdAt: ts,
}).returning().get()

after(() => fs.rmSync(root, { recursive: true, force: true }))

async function body(response: Response) {
  return response.json() as Promise<any>
}

test('GET /episodes/:id/films 返回成片与当前指针', async () => {
  const response = await app.request(`/episodes/${episode.id}/films`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await body(response)).data
  assert.equal(data.current_film_id, null)
  assert.equal(data.films[0].id, film.id)
  assert.equal(data.films[0].duration_ms, 5000)
})

test('POST current 写入指针；DELETE 当前返回 409；PATCH 改名', async () => {
  const current = await app.request(`/episodes/${episode.id}/films/${film.id}/current`, { method: 'POST' })
  assert.equal(current.status, 200, await current.clone().text())
  assert.equal((await body(current)).data.current_film_id, film.id)

  const remove = await app.request(`/films/${film.id}`, { method: 'DELETE' })
  assert.equal(remove.status, 409)
  assert.equal((await body(remove)).code, 'FILM_IS_CURRENT')

  const patch = await app.request(`/films/${film.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '新名字' }),
  })
  assert.equal(patch.status, 200)
  assert.equal((await body(patch)).data.title, '新名字')
})

test('GET /films/:id 返回详情与是否含音轨', async () => {
  const response = await app.request(`/films/${film.id}`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await body(response)).data
  assert.equal(data.id, film.id)
  assert.equal(data.subtitle_burned, false)
  assert.equal(data.duration_ms, 5000)
})

test('投影重试只对已完成视频导出生效', async () => {
  const exportRow = db.insert(schema.episodeExports).values({
    episodeId: episode.id, kind: 'video', status: 'completed', outputUrl: url,
    durationMs: 5000, createdAt: ts,
  }).returning().get()
  const response = await app.request(`/episodes/${episode.id}/exports/${exportRow.id}/project-film`, { method: 'POST' })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await body(response)).data
  assert.ok(data.film_id)

  const pending = db.insert(schema.episodeExports).values({
    episodeId: episode.id, kind: 'video', status: 'running', outputUrl: url, createdAt: ts,
  }).returning().get()
  const rejected = await app.request(`/episodes/${episode.id}/exports/${pending.id}/project-film`, { method: 'POST' })
  assert.equal(rejected.status, 409)
})
