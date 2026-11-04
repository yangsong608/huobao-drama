/**
 * P3-7 反向入口：GET /dramas/:id 返回 source_novel；小说列表返回 hasUpdate
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-drama-link-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: dramasRoute } = await import('../src/routes/dramas.ts')
const { listNovels } = await import('../src/services/novels.ts')
const { listNovelImports, syncNovelImport } = await import('../src/services/novel-import.ts')
const { planEpisodes } = await import('../src/services/script-import.ts')
const { contentHash } = await import('../src/utils/text-hash.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const ts = '2026-03-02T00:00:00.000Z'

function insertNovel(title = '长夜将明'): number {
  const res = db.insert(schema.novels).values({
    title,
    status: 'writing',
    contentUpdatedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertDrama(title: string, sourceNovelId: number | null = null): number {
  const res = db.insert(schema.dramas).values({
    title,
    style: '3d',
    status: 'draft',
    sourceNovelId,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  return Number(res.lastInsertRowid)
}

test('GET /dramas/:id 返回原著 id 与标题；无来源时为 null', async () => {
  const novelId = insertNovel()
  const linkedId = insertDrama('《长夜将明》短剧', novelId)
  const plainId = insertDrama('原创短剧')

  const linked = await dramasRoute.request(`/${linkedId}`)
  assert.equal(linked.status, 200)
  const linkedJson = await linked.json() as any
  assert.deepEqual(linkedJson.data.source_novel, { id: novelId, title: '长夜将明' })
  assert.equal(linkedJson.data.source_novel_id, novelId)

  const plain = await dramasRoute.request(`/${plainId}`)
  const plainJson = await plain.json() as any
  assert.equal(plainJson.data.source_novel, null)
})

test('小说列表 hasUpdate：章节 hash 变化为 true，映射同步后为 false，orphaned 恒 false', () => {
  const novelId = insertNovel('同步标记')
  const content = '第一章正文'
  db.insert(schema.novelChapters).values({
    novelId,
    chapterNo: 1,
    title: '第一章',
    content,
    wordCount: content.length,
    contentHash: contentHash(content),
    status: 'final',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const importRes = db.insert(schema.novelImports).values({
    novelId,
    dramaId: insertDrama('同步标记短剧', novelId),
    status: 'active',
    sourceUpdatedAt: ts,
    lastSyncedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const importId = Number(importRes.lastInsertRowid)
  const mappingRes = db.insert(schema.novelImportEpisodes).values({
    importId,
    chapterNo: 1,
    partNo: 1,
    episodeId: 1,
    contentHash: contentHash('旧正文'),
    chapterHash: contentHash('旧正文'),
    status: 'synced',
    syncedAt: ts,
  }).run()

  const before = listNovels().items.find((item) => item.id === novelId)
  assert.equal(before?.hasImport, true)
  assert.equal(before?.hasUpdate, true)

  db.update(schema.novelImportEpisodes)
    .set({ contentHash: contentHash(content), chapterHash: contentHash(content) })
    .where(eq(schema.novelImportEpisodes.id, Number(mappingRes.lastInsertRowid)))
    .run()
  const synced = listNovels().items.find((item) => item.id === novelId)
  assert.equal(synced?.hasUpdate, false)

  db.update(schema.novelImports).set({ status: 'orphaned' }).where(eq(schema.novelImports.id, importId)).run()
  const orphaned = listNovels().items.find((item) => item.id === novelId)
  assert.equal(orphaned?.hasUpdate, false)
})

test('部分同步按集内容判断更新：未变更集不产生幽灵更新', () => {
  const novelId = insertNovel('部分同步')
  const dramaId = insertDrama('部分同步短剧', novelId)
  const oldContent = ['甲。'.repeat(200), '乙。'.repeat(200), '丙。'.repeat(200)].join('\n\n')
  const newContent = ['甲。'.repeat(200), '乙。'.repeat(200), '丁。' + '丙。'.repeat(199)].join('\n\n')
  const chapterOf = (content: string) => ({
    index: 1,
    title: '第一章',
    content,
    charCount: [...content].length,
  })
  const oldPlans = planEpisodes([chapterOf(oldContent)], { splitMode: 'words', targetWords: 600 })
  const newPlans = planEpisodes([chapterOf(newContent)], { splitMode: 'words', targetWords: 600 })
  assert.equal(oldPlans.length, newPlans.length)
  const changedParts = newPlans
    .map((plan, i) => (plan.content === oldPlans[i].content ? 0 : i + 1))
    .filter((partNo) => partNo > 0)
  assert.equal(changedParts.length, 1)
  const changedPartNo = changedParts[0]

  db.insert(schema.novelChapters).values({
    novelId,
    chapterNo: 1,
    title: '第一章',
    content: newContent,
    wordCount: newContent.length,
    contentHash: contentHash(newContent),
    status: 'final',
    createdAt: ts,
    updatedAt: ts,
  }).run()
  const episodeIds = oldPlans.map((plan, i) => Number(db.insert(schema.episodes).values({
    dramaId,
    episodeNumber: i + 1,
    title: `第${i + 1}集`,
    content: plan.content,
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid))
  const importId = Number(db.insert(schema.novelImports).values({
    novelId,
    dramaId,
    status: 'active',
    sourceUpdatedAt: ts,
    lastSyncedAt: ts,
    lastSyncSummary: JSON.stringify({ split_mode: 'words', target_words: 600 }),
    createdAt: ts,
    updatedAt: ts,
  }).run().lastInsertRowid)
  oldPlans.forEach((plan, i) => {
    db.insert(schema.novelImportEpisodes).values({
      importId,
      chapterNo: 1,
      partNo: i + 1,
      episodeId: episodeIds[i],
      contentHash: contentHash(plan.content),
      chapterHash: contentHash(oldContent),
      status: 'synced',
      syncedAt: ts,
    }).run()
  })

  assert.equal(listNovelImports(novelId)[0]?.has_update, true)
  assert.equal(listNovels().items.find((item) => item.id === novelId)?.hasUpdate, true)

  const result = syncNovelImport(novelId, importId, {
    items: [{ chapter_no: 1, part_no: changedPartNo, action: 'update' }],
  })
  assert.equal(result.updated, 1)

  assert.equal(listNovelImports(novelId)[0]?.has_update, false)
  assert.equal(listNovels().items.find((item) => item.id === novelId)?.hasUpdate, false)
})
