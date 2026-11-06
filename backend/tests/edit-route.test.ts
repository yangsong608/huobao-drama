import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-route-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const {
  createEmptyEditPlan,
  editSyncHashOf,
  planHashOf,
  projectSettingsForAspect,
} = await import('../src/services/edit-plan.ts')

const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '剪辑只读', aspectRatio: '9:16', createdAt: ts, updatedAt: ts,
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
const sourceUrl = `static/projects/${drama.id}/videos/film.mp4`

const emptyEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '空集', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '有成片', videoUrl: sourceUrl, createdAt: ts, updatedAt: ts,
}).returning().get()
const missingEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 3, title: '媒体缺失',
  videoUrl: `static/projects/${drama.id}/videos/missing.mp4`, createdAt: ts, updatedAt: ts,
}).returning().get()
const draftEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 4, title: '草稿优先', createdAt: ts, updatedAt: ts,
}).returning().get()
const offEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 5, title: '开关关闭', createdAt: ts, updatedAt: ts,
}).returning().get()

// 成片行 + 打开工程（工程化剪辑状态：读路径按工程组织）
const film = db.insert(schema.videoMerges).values({
  episodeId: videoEpisode.id, dramaId: drama.id, title: '成片',
  provider: 'ffmpeg', model: 'test',
  status: 'completed', mergedUrl: sourceUrl, kind: 'concat', createdAt: ts,
}).returning().get()
const { openProjectForFilm } = await import('../src/services/edit-project-service.ts')
const filmProject = openProjectForFilm(videoEpisode.id, film.id).project

// 草稿优先集：旧版工程（source_merge_id 为空，不服务本测试用途，仅承载草稿/版本）
const legacyProject = db.insert(schema.editProjects).values({
  episodeId: draftEpisode.id, dramaId: drama.id, sourceMergeId: null,
  title: '旧版工程', status: 'active', createdAt: ts, updatedAt: ts,
}).returning().get()
db.update(schema.episodes).set({ editProjectId: legacyProject.id })
  .where(eq(schema.episodes.id, draftEpisode.id)).run()

const revisionPlan = createEmptyEditPlan(draftEpisode.id, projectSettingsForAspect('16:9'))
db.insert(schema.editRevisions).values({
  episodeId: draftEpisode.id,
  projectId: legacyProject.id,
  revisionNo: 1,
  planJson: JSON.stringify(revisionPlan),
  planHash: planHashOf(revisionPlan),
  editSyncHash: editSyncHashOf(revisionPlan),
  isCurrent: true,
  createdAt: ts,
}).run()
const draftPlan = createEmptyEditPlan(draftEpisode.id, {
  ...projectSettingsForAspect('16:9'),
  tailGapMs: 300,
})
db.insert(schema.episodeEditDrafts).values({
  episodeId: draftEpisode.id,
  dramaId: drama.id,
  projectId: legacyProject.id,
  planJson: JSON.stringify(draftPlan),
  planHash: planHashOf(draftPlan),
  editSyncHash: editSyncHashOf(draftPlan),
  version: 2,
  createdAt: ts,
  updatedAt: ts,
}).run()

setEditWorkspaceMode('readonly')

function json(response: Response): Promise<any> {
  return response.json()
}

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('空集返回空计划且不创建草稿/版本', async () => {
  const response = await app.request(`/episodes/${emptyEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.episode_id, emptyEpisode.id)
  assert.equal(data.enabled, true)
  assert.equal(data.mode, 'readonly')
  assert.equal(data.empty_reason, 'NO_FILM')
  assert.equal(data.project, null)
  assert.deepEqual(data.films, [])
  assert.deepEqual(data.plan.clips, [])
  assert.equal(data.layout.duration_ms, 0)
  assert.equal(data.current_revision, null)
  assert.equal(data.draft, null)
  assert.equal(data.capabilities.can_edit, false)
  assert.equal(data.capabilities.can_export, false)

  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === emptyEpisode.id)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === emptyEpisode.id)
  assert.equal(drafts.length, 0)
  assert.equal(revisions.length, 0)
})

test('当前成片 bootstrap 为单片段并返回工程信息', async () => {
  const response = await app.request(`/episodes/${videoEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.empty_reason, null)
  assert.equal(data.project.id, filmProject.id)
  assert.equal(data.project.source_merge_id, film.id)
  assert.equal(data.legacy_project, false)
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.plan.clips[0].source.kind, 'merge')
  assert.equal(data.plan.clips[0].source.url, sourceUrl)
  assert.equal(data.plan.clips[0].source.width, 320)
  assert.equal(data.plan.clips[0].source.height, 240)
  assert.equal(data.plan.clips[0].source.fps, 25)
  // 成片 320x240 → 16:9（画幅取成片宽高比，不再是剧集 9:16）
  assert.equal(data.plan.project.aspect, '16:9')
  assert.equal(data.plan.project.width, 1920)
  assert.equal(data.plan.project.height, 1080)
  assert.ok(Math.abs(data.layout.duration_ms - 2000) <= 200)
  // Task 24（§6.9）：单片段源成片有原声 → mode='video'（混音不可用时回放源原声，reference_only 仅在 stale 时为 true）
  assert.equal(data.audio.mode, 'video')
  assert.equal(data.audio.reference_only, false)
  assert.equal(data.hashes.plan_hash.length, 32)
  assert.equal(data.hashes.edit_sync_hash.length, 32)
  assert.equal(data.draft_dirty, false)

  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === videoEpisode.id)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === videoEpisode.id)
  assert.equal(drafts.length, 0)
  assert.equal(revisions.length, 0)
})

test('无成片（含媒体缺失路径）返回 NO_FILM 空态', async () => {
  const response = await app.request(`/episodes/${missingEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.empty_reason, 'NO_FILM')
  assert.equal(data.project, null)
  assert.deepEqual(data.plan.clips, [])
  assert.deepEqual(data.films, [])
})

test('已有草稿时草稿优先，并返回版本指针与 dirty 标记', async () => {
  const response = await app.request(`/episodes/${draftEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.plan.project.tailGapMs, 300)
  assert.equal(data.draft.version, 2)
  assert.equal(data.current_revision.revision_no, 1)
  assert.equal(data.current_revision.id, 1)
  assert.equal(data.draft_dirty, true)
})

test('legacy 混音记录显示 stale 与 legacy_mix 原因', async () => {
  db.insert(schema.mixRevisions).values({
    episodeId: videoEpisode.id,
    revisionNo: 1,
    planJson: '{}',
    planHash: 'legacy-mix',
    isCurrent: true,
    createdAt: ts,
  }).run()
  const response = await app.request(`/episodes/${videoEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.mix_status.status, 'stale')
  assert.ok(data.mix_status.reasons.includes('legacy_mix'))
  assert.equal(data.mix_status.mix_revision_id, 1)
})

test('开关 off 返回 403，非法与大编号返回 400/404', async () => {
  setEditWorkspaceMode('off')
  const off = await app.request(`/episodes/${offEpisode.id}/edit`)
  assert.equal(off.status, 403)
  assert.equal((await json(off)).code, 'EDIT_WORKSPACE_OFF')
  setEditWorkspaceMode('readonly')

  const invalid = await app.request('/episodes/abc/edit')
  assert.equal(invalid.status, 400)
  const missing = await app.request('/episodes/99999/edit')
  assert.equal(missing.status, 404)
})

test('on 模式无成片返回空态且不写草稿', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${emptyEpisode.id}/edit`)
  assert.equal(response.status, 200)
  const data = (await json(response)).data
  assert.equal(data.mode, 'on')
  assert.equal(data.empty_reason, 'NO_FILM')
  assert.equal(data.project, null)
  assert.equal(data.capabilities.can_edit, true)
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === emptyEpisode.id)
  assert.equal(drafts.length, 0)
  setEditWorkspaceMode('readonly')
})
