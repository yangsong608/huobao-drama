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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-draft-'))
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
  title: '剪辑草稿', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'film.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  videoFile,
], { stdio: 'ignore' })
const videoUrl = `static/projects/${drama.id}/videos/film.mp4`

const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '草稿集', videoUrl,
  createdAt: ts, updatedAt: ts,
}).returning().get()
const readonlyEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '只读集', videoUrl,
  createdAt: ts, updatedAt: ts,
}).returning().get()

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function json(response: Response): Promise<any> {
  return response.json()
}

async function loadPlan(episodeId: number) {
  const response = await app.request(`/episodes/${episodeId}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  return (await json(response)).data.plan
}

function putDraft(episodeId: number, body: unknown) {
  return app.request(`/episodes/${episodeId}/edit/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('保存草稿版本递增，过期 base_version 返回 409 与当前计划', async () => {
  setEditWorkspaceMode('on')
  const plan = await loadPlan(episode.id)
  plan.project.tailGapMs = 500

  const first = await putDraft(episode.id, { base_version: 0, plan })
  assert.equal(first.status, 200, await first.clone().text())
  const firstData = (await json(first)).data
  assert.equal(firstData.version, 1)
  assert.match(firstData.updated_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(firstData.draft_dirty, true)
  assert.equal(firstData.hashes.plan_hash.length, 32)
  assert.equal(firstData.hashes.subtitle_hash.length, 32)

  const stale = await putDraft(episode.id, { base_version: 0, plan })
  assert.equal(stale.status, 409)
  const staleData = await json(stale)
  assert.equal(staleData.code, 'EDIT_VERSION_CONFLICT')
  assert.equal(staleData.data.current_version, 1)
  assert.equal(staleData.data.current_plan.project.tailGapMs, 500)
  assert.ok(staleData.data.updated_at)

  plan.project.tailGapMs = 700
  const forced = await putDraft(episode.id, { base_version: 0, plan, force: true })
  assert.equal(forced.status, 200, await forced.clone().text())
  const forcedData = (await json(forced)).data
  assert.equal(forcedData.version, 2)
  assert.equal(forcedData.plan.project.tailGapMs, 700)

  const state = await app.request(`/episodes/${episode.id}/edit`)
  const stateData = (await json(state)).data
  assert.equal(stateData.draft.version, 2)
  assert.equal(stateData.plan.project.tailGapMs, 700)
})

test('非法计划返回 400 EDIT_PLAN_INVALID 且不覆盖草稿', async () => {
  setEditWorkspaceMode('on')
  const plan = await loadPlan(episode.id)
  plan.clips.push({ ...plan.clips[0] })
  const response = await putDraft(episode.id, { base_version: 2, plan })
  assert.equal(response.status, 400)
  const data = await json(response)
  assert.equal(data.code, 'EDIT_PLAN_INVALID')
  assert.equal(data.data.code, 'CLIP_ID_DUPLICATE')

  const state = await app.request(`/episodes/${episode.id}/edit`)
  const stateData = (await json(state)).data
  assert.equal(stateData.draft.version, 2)
})

test('readonly 保存草稿返回 403 且不创建草稿', async () => {
  setEditWorkspaceMode('readonly')
  const plan = await loadPlan(readonlyEpisode.id)
  const response = await putDraft(readonlyEpisode.id, { base_version: 0, plan })
  assert.equal(response.status, 403)
  assert.equal((await json(response)).code, 'EDIT_READONLY')
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)
  assert.equal(drafts.length, 0)
})

test('DELETE 丢弃草稿后回退到成片计划', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${episode.id}/edit/draft`, { method: 'DELETE' })
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await json(response)).data.discarded, true)

  const second = await app.request(`/episodes/${episode.id}/edit/draft`, { method: 'DELETE' })
  assert.equal((await json(second)).data.discarded, false)

  const state = await app.request(`/episodes/${episode.id}/edit`)
  const data = (await json(state)).data
  assert.equal(data.draft, null)
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.plan.clips[0].source.kind, 'episode-video')
})
