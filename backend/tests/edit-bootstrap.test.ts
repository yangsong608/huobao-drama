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
const { persistInitialProjectPlan } = await import('../src/services/edit-bootstrap.ts')
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

const seedEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '初始计划集', createdAt: ts, updatedAt: ts,
}).returning().get()
const seedProject = db.insert(schema.editProjects).values({
  episodeId: seedEpisode.id, dramaId: drama.id, sourceMergeId: null,
  title: '旧版工程', status: 'active', createdAt: ts, updatedAt: ts,
}).returning().get()
db.update(schema.episodes).set({ editProjectId: seedProject.id })
  .where(eq(schema.episodes.id, seedEpisode.id)).run()

// 草稿 JSON 损坏：persistInitialProjectPlan 必须能在唯一索引下自愈重建。
const corruptDraftEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '草稿损坏', createdAt: ts, updatedAt: ts,
}).returning().get()
const corruptProject = db.insert(schema.editProjects).values({
  episodeId: corruptDraftEpisode.id, dramaId: drama.id, sourceMergeId: null,
  title: '损坏草稿工程', status: 'active', createdAt: ts, updatedAt: ts,
}).returning().get()
db.update(schema.episodes).set({ editProjectId: corruptProject.id })
  .where(eq(schema.episodes.id, corruptDraftEpisode.id)).run()
db.insert(schema.episodeEditDrafts).values({
  episodeId: corruptDraftEpisode.id,
  dramaId: drama.id,
  projectId: corruptProject.id,
  planJson: '{"version":1,"project":',
  planHash: 'broken',
  version: 7,
  createdAt: ts,
  updatedAt: ts,
}).run()

// 指针指向其他工程的集：指针不得被改写。
const otherPointerEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 3, title: '指针他属', createdAt: ts, updatedAt: ts,
}).returning().get()
const otherProject = db.insert(schema.editProjects).values({
  episodeId: otherPointerEpisode.id, dramaId: drama.id, sourceMergeId: null,
  title: '另一工程', status: 'active', createdAt: ts, updatedAt: ts,
}).returning().get()
const pointerProject = db.insert(schema.editProjects).values({
  episodeId: otherPointerEpisode.id, dramaId: drama.id, sourceMergeId: null,
  title: '目标工程', status: 'active', createdAt: ts, updatedAt: ts,
}).returning().get()
db.update(schema.episodes).set({ editProjectId: otherProject.id })
  .where(eq(schema.episodes.id, otherPointerEpisode.id)).run()

const readonlyEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 4, title: '只读集', videoUrl, createdAt: ts, updatedAt: ts,
}).returning().get()

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function planOf(episodeId: number) {
  return createEmptyEditPlan(episodeId, projectSettingsForAspect('16:9'))
}

test('on 模式落初始版本与草稿，并同步当前打开工程的分集指针', () => {
  setEditWorkspaceMode('on')
  const plan = planOf(seedEpisode.id)
  const result = persistInitialProjectPlan({
    episodeId: seedEpisode.id,
    dramaId: drama.id,
    projectId: seedProject.id,
    plan,
    mode: 'on',
  })
  assert.equal(result.created, true)
  assert.equal(result.draftVersion, 1)

  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.projectId === seedProject.id)
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.projectId === seedProject.id)
  assert.equal(revisions.length, 1)
  assert.equal(drafts.length, 1)
  assert.equal(revisions[0].isCurrent, true)
  assert.equal(revisions[0].note, '自动初始化')
  assert.equal(drafts[0].version, 1)
  assert.equal(drafts[0].baseRevisionId, revisions[0].id)
  assert.ok(result.revisionId === revisions[0].id)

  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, seedEpisode.id)).get()
  assert.equal(episode?.editRevisionId, revisions[0].id)
  assert.equal(episode?.editProjectId, seedProject.id)
})

test('重复调用复用已落库版本，不新增版本或草稿', () => {
  setEditWorkspaceMode('on')
  const before = db.select().from(schema.editRevisions).all()
    .filter((row) => row.projectId === seedProject.id)
  const result = persistInitialProjectPlan({
    episodeId: seedEpisode.id,
    dramaId: drama.id,
    projectId: seedProject.id,
    plan: planOf(seedEpisode.id),
    mode: 'on',
  })
  assert.equal(result.created, false)
  assert.equal(result.revisionId, before[0].id)
  const after = db.select().from(schema.editRevisions).all()
    .filter((row) => row.projectId === seedProject.id)
  assert.equal(after.length, before.length)
})

test('readonly 模式绝不落库，只回传计划本身', () => {
  setEditWorkspaceMode('readonly')
  const beforeRevisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.projectId === seedProject.id)
  const beforeDrafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.projectId === seedProject.id)
  const plan = planOf(seedEpisode.id)
  const result = persistInitialProjectPlan({
    episodeId: seedEpisode.id,
    dramaId: drama.id,
    projectId: seedProject.id,
    plan,
    mode: 'readonly',
  })
  assert.equal(result.created, false)
  assert.equal(result.revisionId, null)
  assert.equal(result.draftVersion, null)
  assert.deepEqual(result.plan, plan)
  const afterRevisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.projectId === seedProject.id)
  const afterDrafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.projectId === seedProject.id)
  assert.deepEqual(afterRevisions, beforeRevisions)
  assert.deepEqual(afterDrafts, beforeDrafts)
})

test('草稿损坏时自愈重建草稿与初始版本，且幂等', () => {
  setEditWorkspaceMode('on')
  const result = persistInitialProjectPlan({
    episodeId: corruptDraftEpisode.id,
    dramaId: drama.id,
    projectId: corruptProject.id,
    plan: planOf(corruptDraftEpisode.id),
    mode: 'on',
  })
  assert.equal(result.created, true)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.projectId === corruptProject.id)
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.projectId === corruptProject.id)
  assert.equal(revisions.length, 1)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].version, 1)
  assert.notEqual(drafts[0].planHash, 'broken')
  assert.equal(drafts[0].editSyncHash, editSyncHashOf(planOf(corruptDraftEpisode.id)))
  assert.equal(drafts[0].planHash, planHashOf(planOf(corruptDraftEpisode.id)))

  // 第二次调用必须幂等：不新增行，草稿保持重建后的 version 1。
  const second = persistInitialProjectPlan({
    episodeId: corruptDraftEpisode.id,
    dramaId: drama.id,
    projectId: corruptProject.id,
    plan: planOf(corruptDraftEpisode.id),
    mode: 'on',
  })
  assert.equal(second.created, false)
  assert.equal(second.draftVersion, 1)
  const revisionsAfter = db.select().from(schema.editRevisions).all()
    .filter((row) => row.projectId === corruptProject.id)
  const draftsAfter = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.projectId === corruptProject.id)
  assert.equal(revisionsAfter.length, 1)
  assert.equal(draftsAfter.length, 1)
})

test('分集指针指向其他工程时不改写指针', () => {
  setEditWorkspaceMode('on')
  const result = persistInitialProjectPlan({
    episodeId: otherPointerEpisode.id,
    dramaId: drama.id,
    projectId: pointerProject.id,
    plan: planOf(otherPointerEpisode.id),
    mode: 'on',
  })
  assert.equal(result.created, true)
  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, otherPointerEpisode.id)).get()
  assert.equal(episode?.editProjectId, otherProject.id)
  assert.equal(episode?.editRevisionId, null)
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
