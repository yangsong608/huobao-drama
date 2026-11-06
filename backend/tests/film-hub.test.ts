import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-film-hub-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const {
  bootstrapCurrentFilmIfEmpty,
  deleteFilm,
  listFilms,
  projectFilmFromExport,
  renameFilm,
  setCurrentFilm,
} = await import('../src/services/film-hub.ts')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '成片测试', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const outputUrl = `static/projects/${drama.id}/videos/out.mp4`
fs.writeFileSync(path.join(root, outputUrl), Buffer.from('fake-video'))

const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 3, title: '第三集', createdAt: ts, updatedAt: ts,
}).returning().get()

function film(values: Partial<typeof schema.videoMerges.$inferInsert> = {}) {
  return db.insert(schema.videoMerges).values({
    episodeId: episode.id,
    dramaId: drama.id,
    provider: 'ffmpeg',
    model: 'test',
    status: 'completed',
    kind: 'concat',
    origin: 'concat',
    mergedUrl: outputUrl,
    duration: 12,
    createdAt: ts,
    ...values,
  }).returning().get()
}

after(() => fs.rmSync(root, { recursive: true, force: true }))

test('列表只返回已完成、未删除成片，并换算 duration_ms', () => {
  const concat = film({ title: '拼接 A' })
  film({ title: '处理中', status: 'processing' })
  film({ title: '已删除', deletedAt: ts })

  const result = listFilms(episode.id)
  assert.equal(result.current_film_id, null)
  assert.equal(result.films.length, 1)
  assert.equal(result.films[0].id, concat.id)
  assert.equal(result.films[0].duration_ms, 12000)
  assert.equal(result.films[0].duration_unknown, false)
  assert.equal(result.films[0].kind, 'concat')
  assert.equal(result.films[0].is_current, false)
})

test('设为当前成片写入权威指针与兼容镜像，烧录字幕不回写 subtitle_url', () => {
  const concat = film({ title: '拼接 B', subtitleUrl: 'static/x.srt', subtitleBurned: false })
  const burned = film({ title: '烧录 C', subtitleUrl: 'static/y.srt', subtitleBurned: true })

  const first = setCurrentFilm(episode.id, concat.id)
  assert.equal(first.current_film_id, concat.id)
  assert.equal(first.video_url, outputUrl)
  assert.equal(first.subtitle_url, 'static/x.srt')

  const second = setCurrentFilm(episode.id, burned.id)
  assert.equal(second.subtitle_url, null)
  const row = db.select().from(schema.episodes).where(eqId(schema.episodes.id, episode.id)).get()!
  assert.equal(row.currentFilmId, burned.id)
  assert.equal(row.subtitleUrl, null)
  assert.equal(row.duration, 12)
})

test('删除当前成片返回 FILM_IS_CURRENT；删除其他成片软删除并级联软删除工程', () => {
  const current = film({ title: '当前' })
  setCurrentFilm(episode.id, current.id)
  assert.throws(() => deleteFilm(current.id), (error: any) => error.code === 'FILM_IS_CURRENT' && error.status === 409)

  const other = film({ title: '可删除' })
  const project = db.insert(schema.editProjects).values({
    episodeId: episode.id, dramaId: drama.id, sourceMergeId: other.id,
    sourceUrl: outputUrl, title: '工程', status: 'active', createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.update(schema.episodes).set({ editProjectId: project.id }).where(eqId(schema.episodes.id, episode.id)).run()

  const result = deleteFilm(other.id)
  assert.equal(result.deleted, true)
  assert.equal(result.deleted_project_id, project.id)
  const deleted = db.select().from(schema.videoMerges).where(eqId(schema.videoMerges.id, other.id)).get()!
  assert.ok(deleted.deletedAt)
  const deletedProject = db.select().from(schema.editProjects).where(eqId(schema.editProjects.id, project.id)).get()!
  assert.ok(deletedProject.deletedAt)
  const episodeRow = db.select().from(schema.episodes).where(eqId(schema.episodes.id, episode.id)).get()!
  assert.equal(episodeRow.editProjectId, null)
})

test('重命名只接受 1–80 字', () => {
  const target = film({ title: '旧标题' })
  assert.equal(renameFilm(target.id, '  新标题  ').title, '新标题')
  assert.throws(() => renameFilm(target.id, '   '), (error: any) => error.code === 'FILM_TITLE_INVALID')
  assert.throws(() => renameFilm(target.id, 'x'.repeat(81)), (error: any) => error.code === 'FILM_TITLE_INVALID')
})

test('导出投影幂等：同一 export 只生成一部成片，剪辑导出为 edit', () => {
  const exportRow = db.insert(schema.episodeExports).values({
    episodeId: episode.id, kind: 'video', status: 'completed', outputUrl,
    durationMs: 12_345, paramsJson: JSON.stringify({ setCurrent: false }),
    projectId: 99, createdAt: ts,
  }).returning().get()

  const firstId = projectFilmFromExport(exportRow.id)
  const secondId = projectFilmFromExport(exportRow.id)
  assert.equal(firstId, secondId)

  const saved = db.select().from(schema.videoMerges).where(eqId(schema.videoMerges.id, firstId)).get()!
  assert.equal(saved.kind, 'edit')
  assert.equal(saved.origin, 'export')
  assert.equal(saved.exportId, exportRow.id)
  assert.equal(saved.duration, 12)
  const exportAfter = db.select().from(schema.episodeExports).where(eqId(schema.episodeExports.id, exportRow.id)).get()!
  assert.equal(exportAfter.filmId, firstId)
})

test('bootstrap 只在 current_film_id 为空时建立初始当前成片', () => {
  db.update(schema.episodes).set({ currentFilmId: null, videoUrl: null }).where(eqId(schema.episodes.id, episode.id)).run()
  const target = film({ title: '初始' })
  assert.equal(bootstrapCurrentFilmIfEmpty(episode.id, target.id), true)
  assert.equal(bootstrapCurrentFilmIfEmpty(episode.id, target.id), false)
})

// 文件顶部：import { eq } from 'drizzle-orm'
const eqId = eq
