import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-frames-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '抽帧', aspectRatio: '9:16', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '抽帧集', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'src.mp4')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=25:d=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoFile,
], { stdio: 'ignore' })
const sourceUrl = `static/projects/${drama.id}/videos/src.mp4`

setEditWorkspaceMode('on')

async function createProject(): Promise<{ filmId: number; projectId: number }> {
  const merge = db.insert(schema.videoMerges).values({
    episodeId: episode.id, dramaId: drama.id, title: '源成片', kind: 'concat',
    provider: 'test', model: 'test-model',
    status: 'completed', mergedUrl: sourceUrl, duration: 2000,
    createdAt: ts, completedAt: ts,
  }).returning().get()
  const opened = await app.request(`/episodes/${episode.id}/edit/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ film_id: merge.id }),
  })
  const data = (await opened.json()).data
  return { filmId: merge.id, projectId: data.project.id }
}

function pngBuffer(size = 64): Promise<Buffer> {
  return import('sharp').then((mod) => mod.default({
    create: { width: size, height: size, channels: 3, background: 'blue' },
  }).png().toBuffer())
}

after(() => fs.rmSync(root, { recursive: true, force: true }))

test('抽帧：返回 PNG、尺寸与指纹，重复请求命中缓存', async () => {
  const { projectId } = await createProject()
  const state = (await (await app.request(`/episodes/${episode.id}/edit?project_id=${projectId}`)).json()).data
  const clipId = state.plan.clips[0].id

  const first = await app.request(`/episodes/${episode.id}/edit/frames`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, clip_id: clipId, offset_ms: 500 }),
  })
  assert.equal(first.status, 200, await first.clone().text())
  const data = (await first.json()).data
  assert.match(data.url, /edit\/frames\/.+\.png$/)
  assert.ok(data.width > 0 && data.height > 0)
  assert.equal(data.fingerprint.length, 32)
  assert.ok(fs.existsSync(path.join(root, data.url)))

  const second = await app.request(`/episodes/${episode.id}/edit/frames`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, clip_id: clipId, offset_ms: 500 }),
  })
  assert.equal((await second.json()).data.url, data.url)
})

test('抽帧：未知片段 404、offset 越界夹取到片段内', async () => {
  const { projectId } = await createProject()
  const missing = await app.request(`/episodes/${episode.id}/edit/frames`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, clip_id: 'nope', offset_ms: 0 }),
  })
  assert.equal(missing.status, 404)

  const state = (await (await app.request(`/episodes/${episode.id}/edit?project_id=${projectId}`)).json()).data
  const clipId = state.plan.clips[0].id
  const out = await app.request(`/episodes/${episode.id}/edit/frames`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, clip_id: clipId, offset_ms: 99_999 }),
  })
  assert.equal(out.status, 200) // 夹取到片段末尾，不报错
})

test('图片上传：入库 edit/assets、同内容去重、非法类型拒绝', async () => {
  const buffer = await pngBuffer()
  const form = new FormData()
  form.append('file', new File([buffer], 'a.png', { type: 'image/png' }))
  const ok = await app.request(`/episodes/${episode.id}/edit/assets/images`, { method: 'POST', body: form })
  assert.equal(ok.status, 200, await ok.clone().text())
  const data = (await ok.json()).data
  assert.match(data.url, /edit\/assets\//)
  assert.equal(data.width, 64)
  assert.equal(data.fingerprint.length, 32)

  const again = await app.request(`/episodes/${episode.id}/edit/assets/images`, {
    method: 'POST',
    body: (() => { const f = new FormData(); f.append('file', new File([buffer], 'b.png', { type: 'image/png' })); return f })(),
  })
  assert.equal((await again.json()).data.url, data.url)

  const bad = await app.request(`/episodes/${episode.id}/edit/assets/images`, {
    method: 'POST',
    body: (() => { const f = new FormData(); f.append('file', new File([Buffer.from('text')], 'x.txt', { type: 'text/plain' })); return f })(),
  })
  assert.equal(bad.status, 400)
})

test('媒体库包含已上传图片', async () => {
  const media = (await (await app.request(`/episodes/${episode.id}/edit/media`)).json()).data
  assert.ok(Array.isArray(media.images))
  assert.ok(media.images.some((img: any) => img.width === 64))
})
