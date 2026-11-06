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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-bootstrap-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const { getWritableEpisode } = await import('../src/services/edit-access.ts')
const { EditWorkspaceError } = await import('../src/services/edit-errors.ts')
const { bootstrapEditPlan } = await import('../src/services/edit-bootstrap.ts')
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
  title: '剪辑 bootstrap', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'shot.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  videoFile,
], { stdio: 'ignore' })
const videoUrl = `static/projects/${drama.id}/videos/shot.mp4`

const storyboardEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '分镜集', createdAt: ts, updatedAt: ts,
}).returning().get()
const sb1 = db.insert(schema.storyboards).values({
  episodeId: storyboardEpisode.id, storyboardNumber: 1, title: '镜一',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).returning().get()
const sb2 = db.insert(schema.storyboards).values({
  episodeId: storyboardEpisode.id, storyboardNumber: 2, title: '镜二',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).returning().get()

const readonlyEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '只读分镜集', createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.storyboards).values({
  episodeId: readonlyEpisode.id, storyboardNumber: 1, title: '只读镜',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).run()

const mergeEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 3, title: '合并集', createdAt: ts, updatedAt: ts,
}).returning().get()
const merge = db.insert(schema.videoMerges).values({
  episodeId: mergeEpisode.id, dramaId: drama.id, title: '合并', provider: 'test', model: 'test',
  status: 'completed', mergedUrl: videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).returning().get()

const missingShotsEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 4, title: '分镜缺视频', videoUrl,
  createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.storyboards).values({
  episodeId: missingShotsEpisode.id, storyboardNumber: 1, title: '无视频',
  duration: 2, createdAt: ts, updatedAt: ts,
}).run()

// 草稿 JSON 损坏 + 分镜可用的 on 模式分集：bootstrap 必须能在唯一索引下自愈。
const corruptDraftEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 5, title: '草稿损坏', createdAt: ts, updatedAt: ts,
}).returning().get()
const corruptSb2 = db.insert(schema.storyboards).values({
  episodeId: corruptDraftEpisode.id, storyboardNumber: 2, title: '损坏镜二',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).returning().get()
const corruptSb1 = db.insert(schema.storyboards).values({
  episodeId: corruptDraftEpisode.id, storyboardNumber: 1, title: '损坏镜一',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.episodeEditDrafts).values({
  episodeId: corruptDraftEpisode.id,
  dramaId: drama.id,
  planJson: '{"version":1,"project":',
  planHash: 'broken',
  version: 7,
  createdAt: ts,
  updatedAt: ts,
}).run()

// 已有合法草稿 + 可用分镜：草稿必须优先，且不新建版本。
const draftPriorityEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 6, title: '草稿优先于分镜', createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.storyboards).values({
  episodeId: draftPriorityEpisode.id, storyboardNumber: 1, title: '草稿优先镜',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).run()
const draftPriorityPlan = createEmptyEditPlan(draftPriorityEpisode.id, {
  ...projectSettingsForAspect('16:9'),
  tailGapMs: 450,
})
db.insert(schema.episodeEditDrafts).values({
  episodeId: draftPriorityEpisode.id,
  dramaId: drama.id,
  planJson: JSON.stringify(draftPriorityPlan),
  planHash: planHashOf(draftPriorityPlan),
  editSyncHash: editSyncHashOf(draftPriorityPlan),
  version: 2,
  createdAt: ts,
  updatedAt: ts,
}).run()

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function json(response: Response): Promise<any> {
  return response.json()
}

test('on 模式下分镜多片段 bootstrap 并创建初始版本与草稿', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${storyboardEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data

  assert.equal(data.mode, 'on')
  assert.equal(data.capabilities.can_edit, true)
  assert.equal(data.plan.clips.length, 2)
  assert.equal(data.plan.clips[0].id, `clp_sb_${sb1.id}`)
  assert.equal(data.plan.clips[1].id, `clp_sb_${sb2.id}`)
  assert.equal(data.plan.clips[0].source.kind, 'storyboard')
  assert.equal(data.plan.clips[0].source.durationMs, 2000)
  assert.equal(data.plan.project.aspect, '16:9')
  assert.deepEqual(data.plan.transitions, [])
  assert.equal(data.current_revision.revision_no, 1)
  assert.equal(data.current_revision.note, '自动初始化')
  assert.equal(data.current_revision.is_current, true)
  assert.equal(data.current_revision_plan.clips.length, 2)
  assert.equal(data.draft.version, 1)
  assert.equal(data.draft.plan.clips.length, 2)
  assert.equal(data.draft_dirty, false)
  assert.equal(data.hashes.subtitle_hash.length, 32)
  assert.equal(data.rough_cut_available, true)

  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === storyboardEpisode.id)
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === storyboardEpisode.id)
  assert.equal(revisions.length, 1)
  assert.equal(drafts.length, 1)
  assert.equal(revisions[0].clipCount, 2)
  assert.equal(revisions[0].isCurrent, true)

  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, storyboardEpisode.id)).get()
  assert.equal(episode?.editRevisionId, revisions[0].id)
})

test('重复 GET 复用初始版本，不会新增版本或草稿版本', async () => {
  setEditWorkspaceMode('on')
  const before = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === storyboardEpisode.id)
  const response = await app.request(`/episodes/${storyboardEpisode.id}/edit`)
  assert.equal(response.status, 200)
  const data = (await json(response)).data
  const afterRows = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === storyboardEpisode.id)
  assert.equal(afterRows.length, before.length)
  assert.equal(data.draft.version, 1)
})

test('readonly 不读取分镜、不写任何版本或草稿', async () => {
  setEditWorkspaceMode('readonly')
  const response = await app.request(`/episodes/${readonlyEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.deepEqual(data.plan.clips, [])
  assert.equal(data.current_revision, null)
  assert.equal(data.draft, null)
  assert.equal(data.rough_cut_available, true)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)
  assert.equal(revisions.length, 0)
  assert.equal(drafts.length, 0)
})

test('on 模式在无分镜时回退到已完成合并，且不落库', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${mergeEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.plan.clips[0].source.kind, 'merge')
  assert.equal(data.plan.clips[0].source.id, merge.id)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === mergeEpisode.id)
  assert.equal(revisions.length, 0)
})

test('分镜全部缺少视频时继续回退到当前成片并保留提示', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${missingShotsEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.plan.clips[0].source.kind, 'episode-video')
  assert.ok(data.media_warnings.some((item: any) => item.code === 'STORYBOARD_MISSING_VIDEO'))
})

test('草稿损坏时 on 模式分镜 bootstrap 自愈为 200，并重建草稿与初始版本', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${corruptDraftEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data

  assert.ok(data.media_warnings.some((item: any) => item.code === 'DRAFT_INVALID'))
  assert.equal(data.plan.clips.length, 2)
  assert.equal(data.plan.clips[0].id, `clp_sb_${corruptSb1.id}`)
  assert.equal(data.plan.clips[1].id, `clp_sb_${corruptSb2.id}`)
  assert.equal(data.draft.version, 1)
  assert.equal(data.current_revision.revision_no, 1)
  assert.equal(data.current_revision.is_current, true)

  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === corruptDraftEpisode.id)
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === corruptDraftEpisode.id)
  assert.equal(revisions.length, 1)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].version, 1)

  // 第二次 GET 必须仍为 200 且不新增行，证明恢复是幂等的。
  const second = await app.request(`/episodes/${corruptDraftEpisode.id}/edit`)
  assert.equal(second.status, 200, await second.clone().text())
  const secondData = (await json(second)).data
  assert.equal(secondData.draft.version, 1)
  assert.equal(secondData.current_revision.revision_no, 1)
  assert.equal(secondData.plan.clips.length, 2)
  const revisionsAfter = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === corruptDraftEpisode.id)
  const draftsAfter = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === corruptDraftEpisode.id)
  assert.equal(revisionsAfter.length, 1)
  assert.equal(draftsAfter.length, 1)
})

test('并发首读复用已有版本时 bootstrap 仍回传版本 id，读路径需重载', async () => {
  setEditWorkspaceMode('on')
  const revisionsBefore = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === corruptDraftEpisode.id)
  assert.equal(revisionsBefore.length, 1)

  // 模拟两个首次 GET 重叠：第二个 bootstrap 会复用第一个已落库的版本（created = false）。
  const result = await bootstrapEditPlan({
    episodeId: corruptDraftEpisode.id,
    dramaId: drama.id,
    project: projectSettingsForAspect('16:9'),
    mode: 'on',
    episodeVideoUrl: null,
    warnings: [],
  })
  assert.equal(result.source, 'storyboard')
  assert.equal(result.initializedRevisionId, revisionsBefore[0].id)
  assert.equal(result.draftVersion, 1)
  const revisionsAfter = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === corruptDraftEpisode.id)
  assert.equal(revisionsAfter.length, 1)
})

test('on 模式下已有合法草稿优先于分镜，且不新建版本', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${draftPriorityEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data

  assert.deepEqual(data.plan.clips, [])
  assert.equal(data.plan.project.tailGapMs, 450)
  assert.equal(data.draft.version, 2)
  assert.equal(data.current_revision, null)
  assert.equal(data.current_revision_plan, null)

  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === draftPriorityEpisode.id)
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === draftPriorityEpisode.id)
  assert.equal(revisions.length, 0)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].version, 2)
})

test('getWritableEpisode 在 readonly 下抛 403 EDIT_READONLY 且不写库', () => {
  setEditWorkspaceMode('readonly')
  const revisionsBefore = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)
  const draftsBefore = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)

  assert.throws(
    () => getWritableEpisode(readonlyEpisode.id),
    (error: unknown) => error instanceof EditWorkspaceError
      && error.status === 403
      && error.code === 'EDIT_READONLY'
      && error.message === '剪辑工作台为只读模式',
  )

  const revisionsAfter = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)
  const draftsAfter = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)
  assert.equal(revisionsAfter.length, revisionsBefore.length)
  assert.equal(draftsAfter.length, draftsBefore.length)
  assert.equal(revisionsAfter.length, 0)
  assert.equal(draftsAfter.length, 0)
})

test('getWritableEpisode 在 off 下抛 403 EDIT_WORKSPACE_OFF 且不写库', () => {
  setEditWorkspaceMode('off')
  const revisionsBefore = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)
  const draftsBefore = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)

  assert.throws(
    () => getWritableEpisode(readonlyEpisode.id),
    (error: unknown) => error instanceof EditWorkspaceError
      && error.status === 403
      && error.code === 'EDIT_WORKSPACE_OFF'
      && error.message === '剪辑工作台已关闭',
  )

  const revisionsAfter = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)
  const draftsAfter = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)
  assert.equal(revisionsAfter.length, revisionsBefore.length)
  assert.equal(draftsAfter.length, draftsBefore.length)
  assert.equal(revisionsAfter.length, 0)
  assert.equal(draftsAfter.length, 0)
  setEditWorkspaceMode('on')
})
