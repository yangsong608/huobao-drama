import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-state-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const { openProjectForFilm } = await import('../src/services/edit-project-service.ts')

const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '工程状态', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const filmFile = path.join(videoDir, 'film.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  filmFile,
], { stdio: 'ignore' })
const filmUrl = `static/projects/${drama.id}/videos/film.mp4`

const emptyEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '无成片', createdAt: ts, updatedAt: ts,
}).returning().get()
const filmEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '有成片', createdAt: ts, updatedAt: ts,
}).returning().get()

const film = db.insert(schema.videoMerges).values({
  episodeId: filmEpisode.id, dramaId: drama.id, title: '拼接成片 A',
  provider: 'ffmpeg', model: 'test',
  status: 'completed', mergedUrl: filmUrl, kind: 'concat', createdAt: ts,
}).returning().get()

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function getEdit(episodeId: number, query = ''): Promise<any> {
  const response = await app.request(`/episodes/${episodeId}/edit${query}`)
  assert.equal(response.status, 200, await response.clone().text())
  return (await response.json()).data
}

test('无成片：空态不建工程、不写草稿', async () => {
  setEditWorkspaceMode('on')
  const data = await getEdit(emptyEpisode.id)
  assert.equal(data.empty_reason, 'NO_FILM')
  assert.equal(data.project, null)
  assert.deepEqual(data.plan.clips, [])
  assert.deepEqual(data.films, [])
  assert.equal(data.capabilities.can_edit, true)
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === emptyEpisode.id)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === emptyEpisode.id)
  assert.equal(drafts.length, 0)
  assert.equal(revisions.length, 0)
})

test('on 模式进入成片：自动创建工程并落初始计划与版本', async () => {
  setEditWorkspaceMode('on')
  const data = await getEdit(filmEpisode.id)
  assert.ok(data.project)
  assert.equal(data.project.source_merge_id, film.id)
  assert.equal(data.project.film_title, '拼接成片 A')
  assert.equal(data.legacy_project, false)
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.plan.clips[0].source.kind, 'merge')
  assert.equal(data.plan.clips[0].source.url, filmUrl)
  assert.ok(data.current_revision)
  assert.equal(data.draft_dirty, false)

  const project = openProjectForFilm(filmEpisode.id, film.id).project
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.projectId === project.id)
  assert.equal(drafts.length, 1)
  const opened = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, filmEpisode.id)).get()
  assert.equal(opened?.editProjectId, project.id)

  // 再次进入复用同一工程与草稿
  const again = await getEdit(filmEpisode.id)
  assert.equal(again.project.id, data.project.id)
  assert.equal(again.draft.version, data.draft.version)
})

test('readonly 模式不落库：返回临时计划且不创建工程', async () => {
  setEditWorkspaceMode('readonly')
  const freshEpisode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 3, title: '只读集', createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.videoMerges).values({
    episodeId: freshEpisode.id, dramaId: drama.id, title: '成片 B',
    provider: 'ffmpeg', model: 'test',
    status: 'completed', mergedUrl: filmUrl, kind: 'concat', createdAt: ts,
  }).run()
  const data = await getEdit(freshEpisode.id)
  assert.equal(data.project, null)
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.capabilities.can_edit, false)
  const projects = db.select().from(schema.editProjects).all()
    .filter((row) => row.episodeId === freshEpisode.id)
  assert.equal(projects.length, 0)
})

test('显式 project_id 优先，跨集工程返回 404', async () => {
  setEditWorkspaceMode('on')
  const other = openProjectForFilm(filmEpisode.id, film.id).project
  const data = await getEdit(filmEpisode.id, `?project_id=${other.id}`)
  assert.equal(data.project.id, other.id)

  const missing = await app.request(`/episodes/${filmEpisode.id}/edit?project_id=999999`)
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'EDIT_PROJECT_NOT_FOUND')
})

test('草稿与版本按工程隔离，指针只更新打开中的工程', async () => {
  setEditWorkspaceMode('on')
  const data = await getEdit(filmEpisode.id)
  const projectId = data.project.id

  const save = await app.request(`/episodes/${filmEpisode.id}/edit/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: data.draft.version, plan: data.plan }),
  })
  assert.equal(save.status, 200, await save.clone().text())
  const saved = (await save.json()).data
  assert.equal(saved.version, data.draft.version + 1)

  const revision = await app.request(`/episodes/${filmEpisode.id}/edit/revisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, base_version: saved.version, note: 'v1' }),
  })
  assert.equal(revision.status, 200, await revision.clone().text())
  const revisionData = (await revision.json()).data
  assert.equal(revisionData.revision.revision_no, 2)

  const listed = await app.request(`/episodes/${filmEpisode.id}/edit/revisions?project_id=${projectId}`)
  const listedData = (await listed.json()).data
  assert.equal(listedData.items.length, 2)
  assert.ok(listedData.items.every((item: any) => item.project_id === projectId))
})

test('初剪/字幕建议在成片工程上返回 409 EDIT_ACTION_LEGACY_ONLY', async () => {
  setEditWorkspaceMode('on')
  const data = await getEdit(filmEpisode.id)
  const rough = await app.request(`/episodes/${filmEpisode.id}/edit/rough-cut`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: data.project.id, mode: 'replace', plan: data.plan }),
  })
  assert.equal(rough.status, 409)
  assert.equal((await rough.json()).code, 'EDIT_ACTION_LEGACY_ONLY')
})

test('成片文件缺失时自动打开工程返回 422 FILM_UNREADABLE', async () => {
  setEditWorkspaceMode('on')
  const brokenEpisode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 4, title: '成片文件缺失', createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.videoMerges).values({
    episodeId: brokenEpisode.id, dramaId: drama.id, title: '缺失成片',
    provider: 'ffmpeg', model: 'test',
    status: 'completed', mergedUrl: `static/projects/${drama.id}/videos/ghost.mp4`, kind: 'concat', createdAt: ts,
  }).run()
  const response = await app.request(`/episodes/${brokenEpisode.id}/edit`)
  assert.equal(response.status, 422)
  assert.equal((await response.json()).code, 'FILM_UNREADABLE')
})
