/**
 * V3 P3-4 同步：Hn/Hs/He 分类、冲突原因、覆盖保留产物、recreate、拆分变化、409、orphaned
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-sync-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: novelImportRoutes } = await import('../src/routes/novelImports.ts')
const {
  commitNovelImport,
  previewNovelImportSync,
  syncNovelImport,
  listNovelImports,
} = await import('../src/services/novel-import.ts')
const { contentHash } = await import('../src/utils/text-hash.ts')

const app = new Hono()
app.route('/api/v1/novels', novelImportRoutes)

const ts = '2026-02-01T00:00:00.000Z'
let requestSeq = 0

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function json(response: Response) {
  return response.json() as Promise<any>
}

function insertNovel(title = '同步测试'): number {
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

function insertChapter(novelId: number, chapterNo: number, content: string, title = `第${chapterNo}章`): number {
  const res = db.insert(schema.novelChapters).values({
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
  return Number(res.lastInsertRowid)
}

function updateChapter(novelId: number, chapterNo: number, content: string): void {
  db.update(schema.novelChapters)
    .set({
      content,
      contentHash: contentHash(content),
      wordCount: content.length,
      updatedAt: '2026-02-02T00:00:00.000Z',
    })
    .where(and(eq(schema.novelChapters.novelId, novelId), eq(schema.novelChapters.chapterNo, chapterNo)))
    .run()
  db.update(schema.novels)
    .set({ contentUpdatedAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z' })
    .where(eq(schema.novels.id, novelId))
    .run()
}

async function seedImport(contents: string[]): Promise<{
  novelId: number
  importId: number
  dramaId: number
  episodeIds: number[]
}> {
  const novelId = insertNovel()
  contents.forEach((content, index) => insertChapter(novelId, index + 1, content))
  const result = await commitNovelImport(novelId, {
    request_id: `sync-req-${++requestSeq}`,
    split_mode: 'words',
    target_words: 1200,
  })
  return { novelId, importId: result.import_id, dramaId: result.drama_id, episodeIds: result.episode_ids }
}

function mappingOf(importId: number, chapterNo: number, partNo = 1) {
  return db.select().from(schema.novelImportEpisodes)
    .where(and(
      eq(schema.novelImportEpisodes.importId, importId),
      eq(schema.novelImportEpisodes.chapterNo, chapterNo),
      eq(schema.novelImportEpisodes.partNo, partNo),
    ))
    .get()
}

function episodeOf(id: number) {
  return db.select().from(schema.episodes).where(eq(schema.episodes.id, id)).get()
}

function setEpisode(id: number, patch: Partial<typeof schema.episodes.$inferInsert>) {
  db.update(schema.episodes).set(patch).where(eq(schema.episodes.id, id)).run()
}

function addStoryboard(episodeId: number): void {
  db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    title: '镜头1',
    createdAt: ts,
    updatedAt: ts,
  }).run()
}

function addQueueJob(episodeId: number, dramaId: number): number {
  const res = db.insert(schema.pipelineJobs).values({
    kind: 'automation',
    dramaId,
    episodeId,
    resource: 'automation',
    status: 'queued',
    createdAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function para(text: string, count: number): string {
  return `${text.repeat(count)}\n\n`
}

test('预览分类：new/updated/conflict/missing/unchanged 且默认同步保留冲突', async () => {
  const { novelId, importId, dramaId, episodeIds } = await seedImport([
    '甲'.repeat(700),
    '乙'.repeat(700),
    '丙'.repeat(700),
    '丁'.repeat(700),
  ])
  updateChapter(novelId, 1, '甲改'.repeat(350))
  updateChapter(novelId, 2, '乙改'.repeat(350))
  setEpisode(episodeIds[1], { scriptContent: '已有剧本' })
  updateChapter(novelId, 4, '')
  insertChapter(novelId, 5, '戊'.repeat(700))
  setEpisode(episodeIds[0], { description: '保留字段' })

  const preview = previewNovelImportSync(novelId, importId)
  assert.deepEqual(preview.counts, { new: 1, updated: 1, conflict: 1, missing: 1, unchanged: 1 })
  assert.deepEqual(
    preview.items.map((item) => [item.chapter_no, item.kind]),
    [[1, 'updated'], [2, 'conflict'], [4, 'missing'], [5, 'new']],
  )
  assert.deepEqual(preview.items[1].reasons, ['has_script'])
  assert.equal(preview.items[1].action, 'skip')
  assert.equal(preview.items[3].action, 'create')
  assert.equal(preview.items[2].action, 'orphan')
  assert.equal(listNovelImports(novelId)[0].has_update, true)

  const result = syncNovelImport(novelId, importId, {})
  assert.equal(result.created, 1)
  assert.equal(result.updated, 1)
  assert.equal(result.skipped, 1)
  assert.equal(result.orphaned, 1)
  assert.equal(result.overwritten, 0)

  const changed = episodeOf(episodeIds[0])
  assert.equal(changed?.content, '甲改'.repeat(350))
  assert.equal(changed?.description, '保留字段')

  assert.equal(episodeOf(episodeIds[1])?.content, '乙'.repeat(700), '冲突默认不覆盖')
  assert.equal(mappingOf(importId, 4)?.status, 'orphaned')

  const created = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, dramaId), eq(schema.episodes.sourceChapterNo, 5)))
    .get()
  assert.ok(created)
  assert.equal(created?.episodeNumber, 5)
  assert.equal(created?.content, '戊'.repeat(700))
  assert.equal(mappingOf(importId, 5)?.status, 'synced')
  assert.equal(mappingOf(importId, 5)?.contentHash, contentHash('戊'.repeat(700)))

  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  assert.equal(drama?.totalEpisodes, 5)
  const importRow = db.select().from(schema.novelImports).where(eq(schema.novelImports.id, importId)).get()
  assert.ok(importRow?.lastSyncedAt)
  assert.equal(importRow?.sourceUpdatedAt, '2026-02-02T00:00:00.000Z')
  const summary = JSON.parse(importRow?.lastSyncSummary || '{}')
  assert.equal(summary.created, 1)
  assert.equal(summary.updated, 1)
  assert.equal(summary.orphaned, 1)

  const afterPreview = previewNovelImportSync(novelId, importId)
  assert.equal(afterPreview.counts.new, 0)
  assert.equal(afterPreview.counts.updated, 0)
  assert.equal(afterPreview.counts.missing, 0)
  assert.equal(afterPreview.counts.conflict, 1)
  assert.equal(listNovelImports(novelId)[0].has_update, true, '被跳过的冲突仍待处理')
})

test('冲突原因覆盖产物、手改、运行中与已删除集', async () => {
  const contents = Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(0x4e00 + i)}`.repeat(700))
  const { novelId, importId, episodeIds } = await seedImport(contents)
  for (let i = 0; i < 7; i += 1) updateChapter(novelId, i + 1, `${String.fromCharCode(0x4e00 + i)}改`.repeat(350))

  setEpisode(episodeIds[0], { videoUrl: '/static/a.mp4' })
  addStoryboard(episodeIds[0])
  setEpisode(episodeIds[1], { videoUrl: '/static/b.mp4' })
  setEpisode(episodeIds[2], { subtitleUrl: '/static/c.srt' })
  setEpisode(episodeIds[3], { dubStatus: 'done' })
  setEpisode(episodeIds[4], { content: `${episodeOf(episodeIds[4])?.content || ''}手改` })
  setEpisode(episodeIds[5], { automationStatus: 'running' })
  setEpisode(episodeIds[6], { dubStatus: 'running' })
  db.update(schema.episodes)
    .set({ deletedAt: '2026-02-03T00:00:00.000Z' })
    .where(eq(schema.episodes.id, episodeIds[7]))
    .run()

  const preview = previewNovelImportSync(novelId, importId)
  assert.equal(preview.counts.conflict, 8)
  const byChapter = new Map(preview.items.map((item) => [item.chapter_no, item]))
  assert.deepEqual(byChapter.get(1)?.reasons, ['has_storyboards', 'has_video'])
  assert.deepEqual(byChapter.get(2)?.reasons, ['has_video'])
  assert.deepEqual(byChapter.get(3)?.reasons, ['has_subtitle'])
  assert.deepEqual(byChapter.get(4)?.reasons, ['has_dubbing'])
  assert.deepEqual(byChapter.get(5)?.reasons, ['content_edited'])
  assert.deepEqual(byChapter.get(6)?.reasons, ['automation_running'])
  assert.deepEqual(byChapter.get(7)?.reasons, ['dubbing_running'])
  assert.deepEqual(byChapter.get(8)?.reasons, ['episode_deleted'])
  assert.equal(byChapter.get(8)?.action, 'recreate')
})

test('overwrite 覆盖正文并保留剧本/分镜，写入 source_stale', async () => {
  const { novelId, importId, episodeIds } = await seedImport(['庚'.repeat(700)])
  const episodeId = episodeIds[0]
  setEpisode(episodeId, { scriptContent: '旧剧本' })
  addStoryboard(episodeId)
  updateChapter(novelId, 1, '庚新'.repeat(350))

  const before = previewNovelImportSync(novelId, importId)
  assert.equal(before.items[0].kind, 'conflict')
  assert.ok(before.items[0].reasons?.includes('has_script'))
  assert.ok(before.items[0].reasons?.includes('has_storyboards'))

  const result = syncNovelImport(novelId, importId, {
    items: [{ chapter_no: 1, part_no: 1, action: 'overwrite' }],
  })
  assert.equal(result.overwritten, 1)

  const episode = episodeOf(episodeId)
  assert.equal(episode?.content, '庚新'.repeat(350))
  assert.equal(episode?.scriptContent, '旧剧本')
  assert.equal(episode?.sourceStale, true)
  const storyboards = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .all()
  assert.equal(storyboards.length, 1)

  const mapping = mappingOf(importId, 1)!
  assert.equal(mapping.status, 'synced')
  assert.equal(mapping.contentHash, contentHash('庚新'.repeat(350)))
  assert.equal(previewNovelImportSync(novelId, importId).counts.conflict, 0)
})

test('recreate：目标集已删除时新建集并改映射', async () => {
  const { novelId, importId, dramaId, episodeIds } = await seedImport(['辛'.repeat(700)])
  const oldId = episodeIds[0]
  db.update(schema.episodes)
    .set({ deletedAt: '2026-02-03T00:00:00.000Z' })
    .where(eq(schema.episodes.id, oldId))
    .run()

  const preview = previewNovelImportSync(novelId, importId)
  assert.equal(preview.items[0].kind, 'conflict')
  assert.deepEqual(preview.items[0].reasons, ['episode_deleted'])
  assert.equal(preview.items[0].action, 'recreate')

  const result = syncNovelImport(novelId, importId, {
    items: [{ chapter_no: 1, part_no: 1, action: 'recreate' }],
  })
  assert.equal(result.recreated, 1)
  assert.equal(episodeOf(oldId)?.deletedAt, '2026-02-03T00:00:00.000Z', '旧集保持删除')

  const mapping = mappingOf(importId, 1)!
  assert.notEqual(mapping.episodeId, oldId)
  assert.equal(mapping.status, 'synced')
  const recreated = episodeOf(mapping.episodeId)
  assert.equal(recreated?.episodeNumber, 2)
  assert.equal(recreated?.deletedAt, null)
  assert.equal(recreated?.content, '辛'.repeat(700))
  assert.equal(previewNovelImportSync(novelId, importId).items.length, 0)
})

test('拆分数量变化：缩短多余 part 置 orphaned 不删集，再增长时复活映射', async () => {
  const long = `${para('长', 1000)}${para('长', 1000)}${para('长', 1000)}`
  const { novelId, importId, dramaId, episodeIds } = await seedImport([long])
  assert.equal(episodeIds.length, 3)

  updateChapter(novelId, 1, '短'.repeat(700))
  let preview = previewNovelImportSync(novelId, importId)
  assert.deepEqual(preview.items.map((item) => [item.part_no, item.kind]), [[1, 'updated'], [2, 'missing'], [3, 'missing']])

  syncNovelImport(novelId, importId, {})
  assert.equal(mappingOf(importId, 1, 2)?.status, 'orphaned')
  assert.equal(mappingOf(importId, 1, 3)?.status, 'orphaned')
  assert.equal(
    db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, dramaId)).all().length,
    3,
    '多余集不删除',
  )

  updateChapter(novelId, 1, `${para('长', 1000)}${para('长', 1000)}`)
  preview = previewNovelImportSync(novelId, importId)
  assert.deepEqual(preview.items.map((item) => [item.part_no, item.kind]), [[1, 'updated'], [2, 'new']])

  syncNovelImport(novelId, importId, {})
  const revived = mappingOf(importId, 1, 2)!
  assert.equal(revived.status, 'synced')
  assert.ok(revived.episodeId > 0)
  assert.equal(episodeOf(revived.episodeId)?.episodeNumber, 4)
  assert.equal(mappingOf(importId, 1, 3)?.status, 'orphaned')
})

test('自动化/配音/队列运行中同步整批 409', async () => {
  const { novelId, importId, dramaId, episodeIds } = await seedImport(['壬'.repeat(700)])
  const episodeId = episodeIds[0]
  updateChapter(novelId, 1, '壬新'.repeat(350))
  const url = `/api/v1/novels/${novelId}/imports/${importId}/sync`
  const body = { items: [{ chapter_no: 1, part_no: 1, action: 'overwrite' }] }

  setEpisode(episodeId, { automationStatus: 'running' })
  let response = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 409)
  assert.deepEqual((await json(response)).data.episode_ids, [episodeId])

  setEpisode(episodeId, { automationStatus: 'idle', dubStatus: 'running' })
  response = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 409)

  setEpisode(episodeId, { dubStatus: 'idle' })
  const jobId = addQueueJob(episodeId, dramaId)
  response = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 409)
  assert.equal(episodeOf(episodeId)?.content, '壬'.repeat(700), '409 时不写正文')

  db.delete(schema.pipelineJobs).where(eq(schema.pipelineJobs.id, jobId)).run()
  response = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ chapter_no: 1, part_no: 1, action: 'update' }] }),
  })
  assert.equal(response.status, 200)
  assert.equal(episodeOf(episodeId)?.content, '壬新'.repeat(350))
})

test('路由：preview/sync 参数与 404/400 校验', async () => {
  const { novelId, importId } = await seedImport(['癸'.repeat(700)])
  updateChapter(novelId, 1, '癸新'.repeat(350))

  const previewResponse = await app.request(`/api/v1/novels/${novelId}/imports/${importId}/preview`)
  assert.equal(previewResponse.status, 200)
  const preview = (await json(previewResponse)).data
  assert.equal(preview.import_id, importId)
  assert.equal(preview.counts.updated, 1)

  const missing = await app.request(`/api/v1/novels/${novelId}/imports/99999/preview`)
  assert.equal(missing.status, 404)

  const badAction = await app.request(`/api/v1/novels/${novelId}/imports/${importId}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ chapter_no: 1, part_no: 1, action: 'explode' }] }),
  })
  assert.equal(badAction.status, 400)

  const unknownItem = await app.request(`/api/v1/novels/${novelId}/imports/${importId}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ chapter_no: 9, part_no: 1, action: 'update' }] }),
  })
  assert.equal(unknownItem.status, 400)

  const ok = await app.request(`/api/v1/novels/${novelId}/imports/${importId}/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ chapter_no: 1, part_no: 1, action: 'update' }] }),
  })
  assert.equal(ok.status, 200)
  const result = (await json(ok)).data
  assert.equal(result.updated, 1)
  assert.equal(result.import_id, importId)
})

test('缺章同步置 orphaned 后 has_update 归零', async () => {
  const { novelId, importId } = await seedImport(['子'.repeat(700)])
  updateChapter(novelId, 1, '')
  assert.equal(listNovelImports(novelId)[0].has_update, true)

  const result = syncNovelImport(novelId, importId, {})
  assert.equal(result.orphaned, 1)
  assert.equal(mappingOf(importId, 1)?.status, 'orphaned')
  assert.equal(listNovelImports(novelId)[0].has_update, false)
  assert.equal(previewNovelImportSync(novelId, importId).items.length, 0)
})
