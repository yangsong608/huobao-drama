/**
 * V3 P3-3 导入路由：创建/列表/删除映射、request_id 幂等、has_update、自动入队
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-import-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: novelImportRoutes } = await import('../src/routes/novelImports.ts')
const { setQueueEnabled } = await import('../src/services/app-settings.ts')
const { contentHash } = await import('../src/utils/text-hash.ts')

const app = new Hono()
app.route('/api/v1/novels', novelImportRoutes)

const ts = '2026-02-01T00:00:00.000Z'

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function json(response: Response) {
  return response.json() as Promise<any>
}

function insertNovel(title = '导入路由测试'): number {
  const res = db.insert(schema.novels).values({
    title,
    topic: '民国探案',
    genre: JSON.stringify(['悬疑']),
    coreSeed: '侦探追查失踪案',
    status: 'writing',
    contentUpdatedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertChapter(novelId: number, chapterNo: number, content: string, title = `第${chapterNo}章`): void {
  db.insert(schema.novelChapters).values({
    novelId,
    chapterNo,
    title,
    content,
    wordCount: content.length,
    contentHash: contentHash(content),
    status: 'final',
    createdAt: ts,
    updatedAt: ts,
  }).run()
}

function importBook(): number {
  const novelId = insertNovel()
  insertChapter(novelId, 1, '甲'.repeat(700))
  insertChapter(novelId, 2, '乙'.repeat(700))
  return novelId
}

async function postImport(novelId: number, body: Record<string, unknown>) {
  return app.request(`/api/v1/novels/${novelId}/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('POST 建项目/映射并返回 import_id/drama_id/episode_count', async () => {
  const novelId = importBook()
  const response = await postImport(novelId, { request_id: 'req-a', title: '雨夜短剧' })
  assert.equal(response.status, 200)
  const payload = (await json(response)).data
  assert.equal(payload.episode_count, 2)
  assert.ok(payload.import_id > 0)
  assert.ok(payload.drama_id > 0)
  assert.equal(payload.existing, false)

  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, payload.drama_id)).get()
  assert.equal(drama?.title, '雨夜短剧')
  assert.equal(drama?.sourceNovelId, novelId)

  const mappings = db.select().from(schema.novelImportEpisodes)
    .where(eq(schema.novelImportEpisodes.importId, payload.import_id)).all()
  assert.equal(mappings.length, 2)
  assert.deepEqual(mappings.map((row) => row.chapterNo), [1, 2])
})

test('POST preview 返回章节/集数预检，不落库', async () => {
  const novelId = importBook()
  const response = await app.request(`/api/v1/novels/${novelId}/imports/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ split_mode: 'words', target_words: 1200, chapter_nos: [1] }),
  })
  assert.equal(response.status, 200)
  const preview = (await json(response)).data
  assert.equal(preview.chapter_count, 1)
  assert.equal(preview.episode_count, 1)
  assert.deepEqual(preview.chapters.map((row: any) => row.chapter_no), [1])
  assert.equal(preview.existing_imports, 0)
  assert.equal(db.select().from(schema.novelImports).where(eq(schema.novelImports.novelId, novelId)).all().length, 0)
  assert.equal(db.select().from(schema.dramas).where(eq(schema.dramas.sourceNovelId, novelId)).all().length, 0)
})

test('GET 列表返回短剧标题/集数/同步时间与 has_update', async () => {
  const novelId = importBook()
  const created = (await json(await postImport(novelId, { request_id: 'req-b' }))).data

  let list = (await json(await app.request(`/api/v1/novels/${novelId}/imports`))).data.items
  assert.equal(list.length, 1)
  assert.equal(list[0].import_id, created.import_id)
  assert.equal(list[0].drama_id, created.drama_id)
  assert.equal(list[0].drama_title, '《导入路由测试》短剧')
  assert.equal(list[0].episode_count, 2)
  assert.equal(list[0].status, 'active')
  assert.equal(list[0].has_update, false)
  assert.ok(list[0].last_synced_at)

  const chapter = db.select().from(schema.novelChapters)
    .where(and(eq(schema.novelChapters.novelId, novelId), eq(schema.novelChapters.chapterNo, 1)))
    .get()
  const next = `${chapter?.content || ''}改`
  db.update(schema.novelChapters)
    .set({ content: next, contentHash: contentHash(next) })
    .where(eq(schema.novelChapters.id, chapter!.id))
    .run()

  list = (await json(await app.request(`/api/v1/novels/${novelId}/imports`))).data.items
  assert.equal(list[0].has_update, true)
})

test('request_id 重复提交返回同一 import，不重复建项目', async () => {
  const novelId = importBook()
  const first = (await json(await postImport(novelId, { request_id: 'req-dup' }))).data
  const second = (await json(await postImport(novelId, { request_id: 'req-dup' }))).data

  assert.equal(second.import_id, first.import_id)
  assert.equal(second.drama_id, first.drama_id)
  assert.equal(second.existing, true)
  assert.equal(db.select().from(schema.novelImports).where(eq(schema.novelImports.novelId, novelId)).all().length, 1)
  assert.equal(db.select().from(schema.dramas).where(eq(schema.dramas.sourceNovelId, novelId)).all().length, 1)
})

test('request_id 已被其他小说使用时返回 400', async () => {
  const first = importBook()
  await postImport(first, { request_id: 'req-shared' })
  const second = importBook()
  const response = await postImport(second, { request_id: 'req-shared' })
  assert.equal(response.status, 400)
  assert.match((await json(response)).message, /request_id/)
})

test('DELETE 删除映射但保留短剧，并清空 source_novel_id 与 metadata.import_id', async () => {
  const novelId = importBook()
  const created = (await json(await postImport(novelId, { request_id: 'req-del' }))).data

  const response = await app.request(`/api/v1/novels/${novelId}/imports/${created.import_id}`, { method: 'DELETE' })
  assert.equal(response.status, 200)
  assert.equal((await json(response)).data.deleted, true)

  assert.equal(db.select().from(schema.novelImports).where(eq(schema.novelImports.id, created.import_id)).get(), undefined)
  assert.equal(
    db.select().from(schema.novelImportEpisodes).where(eq(schema.novelImportEpisodes.importId, created.import_id)).all().length,
    0,
  )

  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, created.drama_id)).get()
  assert.ok(drama, '短剧必须保留')
  assert.equal(drama?.sourceNovelId, null)
  const metadata = JSON.parse(drama?.metadata || '{}')
  assert.equal(metadata.import_id, undefined)
  assert.equal(metadata.source, 'novel')

  const again = await app.request(`/api/v1/novels/${novelId}/imports/${created.import_id}`, { method: 'DELETE' })
  assert.equal(again.status, 404)
})

test('陌生小说与陌生导入返回 404，非法请求体返回 400', async () => {
  const missingNovel = await postImport(99999, { request_id: 'req-x' })
  assert.equal(missingNovel.status, 404)

  const novelId = importBook()
  const missingImport = await app.request(`/api/v1/novels/${novelId}/imports/99999`, { method: 'DELETE' })
  assert.equal(missingImport.status, 404)

  const invalid = await app.request(`/api/v1/novels/${novelId}/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_words: '很多' }),
  })
  assert.equal(invalid.status, 400)

  const empty = await app.request(`/api/v1/novels/${novelId}/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([]),
  })
  assert.equal(empty.status, 400)
})

test('auto_pipeline：队列关闭不入队，开启后按集入队', async () => {
  setQueueEnabled(false)
  const novelId = importBook()
  const created = (await json(await postImport(novelId, { request_id: 'req-auto-off', auto_pipeline: true }))).data
  assert.equal(
    db.select().from(schema.pipelineJobs).where(eq(schema.pipelineJobs.dramaId, created.drama_id)).all().length,
    0,
  )

  setQueueEnabled(true)
  try {
    const queuedNovel = importBook()
    const queued = (await json(await postImport(queuedNovel, { request_id: 'req-auto-on', auto_pipeline: true }))).data
    const jobs = db.select().from(schema.pipelineJobs)
      .where(eq(schema.pipelineJobs.dramaId, queued.drama_id)).all()
    assert.equal(jobs.length, queued.episode_count)
    assert.ok(jobs.every((job) => job.status === 'queued' && job.kind === 'automation'))
  } finally {
    setQueueEnabled(false)
  }
})
