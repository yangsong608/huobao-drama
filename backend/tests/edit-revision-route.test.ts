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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-revision-'))
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
  title: '剪辑版本', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'shot.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=25:d=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  videoFile,
], { stdio: 'ignore' })
const videoUrl = `static/projects/${drama.id}/videos/shot.mp4`

const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '版本集', createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, title: '镜一',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).run()

// 成片行 + 打开工程（版本按 project_id 组织；首次 GET 在 on 模式落初始版本 v1 + 草稿 v1）
const film = db.insert(schema.videoMerges).values({
  episodeId: episode.id, dramaId: drama.id, title: '成片',
  provider: 'ffmpeg', model: 'test',
  status: 'completed', mergedUrl: videoUrl, kind: 'concat', createdAt: ts,
}).returning().get()
const project = openProjectForFilm(episode.id, film.id).project

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function json(response: Response): Promise<any> {
  return response.json()
}

async function loadState() {
  const response = await app.request(`/episodes/${episode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  return (await json(response)).data
}

function postRevision(body: unknown) {
  return app.request(`/episodes/${episode.id}/edit/revisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('创建版本递增 revision_no 并同步草稿', async () => {
  setEditWorkspaceMode('on')
  const state = await loadState()
  assert.equal(state.current_revision.revision_no, 1)
  assert.equal(state.draft.version, 1)

  const plan = state.plan
  plan.project.tailGapMs = 500
  const response = await postRevision({
    project_id: project.id,
    base_version: 1,
    note: '手动版本',
    plan,
    update_draft: true,
  })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.revision.revision_no, 2)
  assert.equal(data.revision.note, '手动版本')
  assert.equal(data.revision.is_current, true)
  assert.equal(data.revision.plan_hash.length, 32)
  assert.equal(data.draft_version, 2)
  assert.equal(data.draft_dirty, false)

  const list = await app.request(`/episodes/${episode.id}/edit/revisions?project_id=${project.id}`)
  assert.equal(list.status, 200)
  const items = (await json(list)).data.items
  assert.equal(items.length, 2)
  assert.ok(items.every((item: any) => item.project_id === project.id))
  assert.equal(items[0].revision_no, 2)
  assert.equal(items[0].is_current, true)
  assert.equal(items[1].revision_no, 1)
  assert.equal(items[1].is_current, false)
})

test('过期 base_version 返回 409，详情返回不可变计划', async () => {
  setEditWorkspaceMode('on')
  const stale = await postRevision({ project_id: project.id, base_version: 1, note: '过期' })
  assert.equal(stale.status, 409)
  const staleData = await json(stale)
  assert.equal(staleData.code, 'EDIT_VERSION_CONFLICT')
  assert.equal(staleData.data.current_version, 2)

  const list = await app.request(`/episodes/${episode.id}/edit/revisions?project_id=${project.id}`)
  const items = (await json(list)).data.items
  const first = items.find((item: any) => item.revision_no === 1)
  const detail = await app.request(`/episodes/${episode.id}/edit/revisions/${first.id}?project_id=${project.id}`)
  assert.equal(detail.status, 200)
  const detailData = (await json(detail)).data
  assert.equal(detailData.revision.revision_no, 1)
  assert.equal(detailData.plan.project.tailGapMs, 0)

  const missing = await app.request(`/episodes/${episode.id}/edit/revisions/99999?project_id=${project.id}`)
  assert.equal(missing.status, 404)
  assert.equal((await json(missing)).code, 'EDIT_REVISION_NOT_FOUND')
})

test('update_draft=false 保留草稿并返回真实 dirty', async () => {
  setEditWorkspaceMode('on')
  const state = await loadState()
  const plan = state.plan
  plan.project.tailGapMs = 900
  const response = await postRevision({
    project_id: project.id,
    base_version: state.draft.version,
    note: '仅版本',
    plan,
    update_draft: false,
  })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.revision.revision_no, 3)
  assert.equal(data.draft_version, state.draft.version)
  assert.equal(data.draft_dirty, true)
})

test('恢复旧版本会创建新版本并同步草稿', async () => {
  setEditWorkspaceMode('on')
  const before = await loadState()
  const list = await app.request(`/episodes/${episode.id}/edit/revisions?project_id=${project.id}`)
  const items = (await json(list)).data.items
  const first = items.find((item: any) => item.revision_no === 1)

  const response = await app.request(
    `/episodes/${episode.id}/edit/revisions/${first.id}/restore`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: project.id, base_version: before.draft.version }),
    },
  )
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.revision.revision_no, 4)
  assert.equal(data.revision.note, '恢复自版本 v1')
  assert.equal(data.revision.is_current, true)
  assert.equal(data.draft_dirty, false)

  const afterState = await loadState()
  assert.equal(afterState.plan.project.tailGapMs, 0)
  assert.equal(afterState.current_revision.revision_no, 4)
})

test('readonly 可读版本列表但禁止创建与恢复', async () => {
  setEditWorkspaceMode('readonly')
  const list = await app.request(`/episodes/${episode.id}/edit/revisions?project_id=${project.id}`)
  assert.equal(list.status, 200)
  const create = await postRevision({ project_id: project.id, base_version: 1 })
  assert.equal(create.status, 403)
  assert.equal((await json(create)).code, 'EDIT_READONLY')
  const restore = await app.request(
    `/episodes/${episode.id}/edit/revisions/1/restore`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: project.id, base_version: 1 }),
    },
  )
  assert.equal(restore.status, 403)
})
