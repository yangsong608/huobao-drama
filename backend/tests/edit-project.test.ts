import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-project-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const filmDir = path.join(root, 'static')
fs.mkdirSync(filmDir, { recursive: true })
// setCurrentFilm 要求成片 completed 且 merged_url 文件真实存在，先在静态目录落盘占位文件
for (const name of ['a.mp4', 'b.mp4']) {
  fs.writeFileSync(path.join(filmDir, name), `fake-video-${name}`)
}

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const {
  resolveEditProject,
  openProjectForFilm,
  requireEditProject,
  listEditProjects,
} = await import('../src/services/edit-project-service.ts')

const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '工程解析', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '集', createdAt: ts, updatedAt: ts,
}).returning().get()

function insertFilm(mergedUrl: string, kind = 'concat', createdAt = ts) {
  return db.insert(schema.videoMerges).values({
    episodeId: episode.id, dramaId: drama.id, title: `成片 ${mergedUrl}`,
    provider: 'ffmpeg', model: 'test',
    status: 'completed', mergedUrl, kind, createdAt,
  }).returning().get()
}
const filmA = insertFilm('a.mp4', 'concat', '2026-11-01T00:00:00.000Z')
const filmB = insertFilm('b.mp4', 'mix', '2026-11-02T00:00:00.000Z')

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('openProjectForFilm 创建工程并记录打开指针，重复打开复用', () => {
  setEditWorkspaceMode('on')
  const first = openProjectForFilm(episode.id, filmA.id)
  assert.equal(first.created, true)
  assert.equal(first.project.sourceMergeId, filmA.id)
  assert.equal(first.project.dramaId, drama.id)
  const opened = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, episode.id)).get()
  assert.equal(opened?.editProjectId, first.project.id)

  const second = openProjectForFilm(episode.id, filmA.id)
  assert.equal(second.created, false)
  assert.equal(second.project.id, first.project.id)
})

test('工程按 (episode, film) 唯一，删除后可重建', () => {
  const { editProjects } = schema
  assert.throws(() => db.insert(editProjects).values({
    episodeId: episode.id, dramaId: drama.id, sourceMergeId: filmA.id,
    title: '重复', status: 'active', createdAt: ts, updatedAt: ts,
  }).run(), /UNIQUE/)

  db.update(editProjects).set({ status: 'deleted', deletedAt: ts })
    .where(eq(editProjects.id, first_project_id())).run()
  const recreated = openProjectForFilm(episode.id, filmA.id)
  assert.equal(recreated.created, true)
})

function first_project_id(): number {
  return db.select().from(schema.editProjects).all()
    .find((row) => row.sourceMergeId === filmA.id && !row.deletedAt)!.id
}

test('resolveEditProject 按 打开指针 → 当前成片工程 → 最新工程 顺序解析', () => {
  // 指针指向已删除工程时跳过，回退到最新成片工程
  const fallback = resolveEditProject(episode.id)
  assert.ok(fallback)
  assert.equal(fallback!.sourceMergeId, filmA.id)

  // 当前成片的工程优先
  db.update(schema.episodes).set({ currentFilmId: filmB.id })
    .where(eq(schema.episodes.id, episode.id)).run()
  assert.equal(resolveEditProject(episode.id)!.sourceMergeId, filmB.id)

  // 打开指针优先于当前成片
  openProjectForFilm(episode.id, filmA.id)
  assert.equal(resolveEditProject(episode.id)!.sourceMergeId, filmA.id)

  // 显式 project_id 优先于指针
  const other = openProjectForFilm(episode.id, filmB.id).project
  assert.equal(resolveEditProject(episode.id, other.id)!.id, other.id)
})

test('requireEditProject 拒绝跨集/已删除工程', () => {
  const project = resolveEditProject(episode.id)!
  // EditWorkspaceError 的 code 与 message 分离（面向用户文案保持中文），这里按 code 断言
  assert.throws(
    () => requireEditProject(episode.id + 1, project.id),
    (error: any) => error?.code === 'EDIT_PROJECT_NOT_FOUND',
  )
  db.update(schema.editProjects).set({ deletedAt: ts })
    .where(eq(schema.editProjects.id, project.id)).run()
  assert.throws(
    () => requireEditProject(episode.id, project.id),
    (error: any) => error?.code === 'EDIT_PROJECT_NOT_FOUND',
  )
})

test('listEditProjects 返回成片标题与旧版标记', () => {
  const legacy = db.insert(schema.editProjects).values({
    episodeId: episode.id, dramaId: drama.id, title: '旧版工程',
    status: 'active', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const { items } = listEditProjects(episode.id)
  const legacyItem = items.find((item: any) => item.id === legacy.id)
  assert.equal(legacyItem.legacy, true)
  assert.equal(legacyItem.film_title, null)
  const filmItem = items.find((item: any) => item.source_merge_id === filmA.id)
  assert.equal(filmItem.legacy, false)
  assert.equal(filmItem.film_title, `成片 a.mp4`)
  assert.equal(filmItem.film_kind, 'concat')
})

test('工程路由：列出与按成片打开', async () => {
  setEditWorkspaceMode('on')
  const listed = await app.request(`/episodes/${episode.id}/edit/projects`)
  assert.equal(listed.status, 200)
  const listedData = (await listed.json()).data
  assert.ok(listedData.items.length >= 2)

  const opened = await app.request(`/episodes/${episode.id}/edit/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ film_id: filmA.id }),
  })
  assert.equal(opened.status, 200, await opened.clone().text())
  const openedData = (await opened.json()).data
  assert.equal(openedData.project.source_merge_id, filmA.id)

  const missing = await app.request(`/episodes/${episode.id}/edit/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ film_id: 99999 }),
  })
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'FILM_NOT_FOUND')
})
