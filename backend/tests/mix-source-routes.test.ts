import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-mix-source-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/mix.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
db.insert(schema.dramas).values({ title: '混音路由', aspectRatio: '16:9', createdAt: ts, updatedAt: ts }).run()
const episode = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '第一集', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', '1', 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const filmPath = path.join(videoDir, 'film.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=1',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', filmPath,
], { stdio: 'ignore' })

function insertFilm(kind: string, title: string) {
  return db.insert(schema.videoMerges).values({
    episodeId: episode.id, dramaId: 1, title, provider: 'ffmpeg', model: 'test',
    status: 'completed', kind, origin: 'legacy', mergedUrl: 'static/projects/1/videos/film.mp4',
    duration: 1, createdAt: ts, completedAt: ts,
  }).returning().get()
}
const concat = insertFilm('concat', '拼接一')
const mixFilm = insertFilm('mix', '混音一')

after(() => fs.rmSync(root, { recursive: true, force: true }))

async function json(response: Response): Promise<any> {
  return response.json()
}

test('GET /mix 返回源成片与警告', async () => {
  const response = await app.request(`/episodes/${episode.id}/mix`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.source_film.filmId, concat.id)
  assert.deepEqual(data.source_warnings, [])
  assert.equal(data.source.filmId, concat.id)
})

test('PUT /mix/source 持久化选择并重新编译', async () => {
  const response = await app.request(`/episodes/${episode.id}/mix/source`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ film_id: mixFilm.id }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.source_film.filmId, mixFilm.id)
  assert.equal(data.source_film.kind, 'mix')
  assert.equal(data.source_warnings.some((item: any) => item.code === 'MIX_SOURCE_NON_CONCAT'), true)
  const stored = db.select().from(schema.episodes).where(eq(schema.episodes.id, episode.id)).get()!
  assert.equal(stored.mixSourceMergeId, mixFilm.id)
})

test('GET ?source_film_id= 使用指定源且不写持久化', async () => {
  db.update(schema.episodes).set({ mixSourceMergeId: mixFilm.id })
    .where(eq(schema.episodes.id, episode.id)).run()
  const response = await app.request(`/episodes/${episode.id}/mix?source_film_id=${concat.id}`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.source_film.filmId, concat.id)
  const stored = db.select().from(schema.episodes).where(eq(schema.episodes.id, episode.id)).get()!
  assert.equal(stored.mixSourceMergeId, mixFilm.id)
})

test('源成片不可读时返回 422 与错误码', async () => {
  const broken = db.insert(schema.videoMerges).values({
    episodeId: episode.id, dramaId: 1, title: '坏源', provider: 'ffmpeg', model: 'test',
    status: 'completed', kind: 'concat', origin: 'legacy',
    mergedUrl: 'static/projects/1/videos/missing.mp4', duration: 1, createdAt: ts, completedAt: ts,
  }).returning().get()
  const response = await app.request(`/episodes/${episode.id}/mix/source`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ film_id: broken.id }),
  })
  assert.equal(response.status, 422)
  assert.equal((await json(response)).code, 'MIX_SOURCE_UNREADABLE')
})

test('保存混音版本记录 source_film_id', async () => {
  db.update(schema.episodes).set({ mixSourceMergeId: concat.id })
    .where(eq(schema.episodes.id, episode.id)).run()
  const response = await app.request(`/episodes/${episode.id}/mix/revisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: '源版本' }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.sourceFilmId, concat.id)
})
