import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-service-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const {
  listNovels,
  getNovel,
  createNovel,
  updateNovel,
  deleteNovel,
  refreshNovelStatus,
} = await import('../src/services/novels.ts')
const { saveChapter } = await import('../src/services/novel-chapters.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'

function createBaseNovel(title: string) {
  return createNovel({
    title,
    topic: '权谋',
    genre: ['古装', '悬疑'],
    number_of_chapters: 2,
    word_number: 3000,
    user_guidance: '节奏快',
  })
}

test('createNovel stores list metadata and parses genre', () => {
  const novel = createBaseNovel('长夜')
  assert.equal(novel.title, '长夜')
  assert.deepEqual(novel.genre, ['古装', '悬疑'])
  assert.equal(novel.numberOfChapters, 2)
  assert.equal(novel.status, 'draft')

  const { items, pagination } = listNovels({ keyword: '长夜' })
  assert.equal(pagination.total, 1)
  assert.equal(items.length, 1)
  assert.equal(items[0].writtenChapters, 0)
  assert.equal(items[0].hasImport, false)
  assert.equal(items[0].architectureGenerated, false)
})

test('getNovel returns chapters and parsed blueprint chapters', () => {
  const novel = createBaseNovel('大纲书')
  updateNovel(novel.id, {
    chapter_blueprint: '第1章 - 开端\n本章定位：引入\n情感强度：★★★☆☆',
  })
  saveChapter(novel.id, 1, { content: '第一章正文' })

  const detail = getNovel(novel.id)
  assert.ok(detail)
  assert.equal(detail.chapters.length, 1)
  assert.equal(detail.chapters[0].content, '第一章正文')
  assert.equal(detail.blueprintChapters.length, 1)
  assert.equal(detail.blueprintChapters[0].suspense, '★★★☆☆')
  assert.deepEqual(detail.imports, [])
})

test('updateNovel only writes whitelisted fields', () => {
  const novel = createBaseNovel('白名单')
  const updated = updateNovel(novel.id, {
    title: '白名单改',
    status: 'completed',
    core_seed: '种子',
    unknown_field: '忽略',
    genre: ['都市'],
  })
  assert.ok(updated)
  assert.equal(updated.title, '白名单改')
  assert.equal(updated.coreSeed, '种子')
  assert.deepEqual(updated.genre, ['都市'])
  assert.equal(updated.status, 'draft')
})

test('deleteNovel soft deletes and marks imports orphaned', async () => {
  const novel = createBaseNovel('待删')
  const dramaRes = await db.insert(schema.dramas).values({
    title: '改编短剧', status: 'draft', createdAt: ts, updatedAt: ts,
  })
  const dramaId = Number(dramaRes.lastInsertRowid)
  db.insert(schema.novelImports).values({
    novelId: novel.id, dramaId, status: 'active', createdAt: ts, updatedAt: ts,
  }).run()

  assert.equal(deleteNovel(novel.id), true)
  assert.equal(getNovel(novel.id), null)
  assert.equal(listNovels({ keyword: '待删' }).pagination.total, 0)
  const importRow = db.select().from(schema.novelImports).all()
    .find((row) => row.novelId === novel.id)
  assert.equal(importRow?.status, 'orphaned')
  assert.equal(deleteNovel(novel.id), false)
})

test('refreshNovelStatus moves draft to writing to completed', () => {
  const novel = createBaseNovel('状态书')
  assert.equal(refreshNovelStatus(novel.id), 'draft')

  saveChapter(novel.id, 1, { content: '一字' })
  assert.equal(refreshNovelStatus(novel.id), 'writing')

  saveChapter(novel.id, 2, { content: '二字' })
  assert.equal(refreshNovelStatus(novel.id), 'completed')
})

test('list written_chapters ignores empty chapter rows', () => {
  const novel = createBaseNovel('空章书')
  saveChapter(novel.id, 1, { title: '只有标题' })
  saveChapter(novel.id, 2, { content: '有正文' })
  const row = listNovels({ keyword: '空章书' }).items[0]
  assert.equal(row.writtenChapters, 1)
})

test('novels default to first person and allow switching', async () => {
  const { createNovel, getNovel, updateNovel } = await import('../src/services/novels.ts')
  const created = createNovel({ title: '人称书', number_of_chapters: 5 })
  assert.equal(created.narrativePerson, 'first')

  const switched = updateNovel(created.id, { narrative_person: 'third_omniscient' })
  assert.equal(switched?.narrativePerson, 'third_omniscient')
  assert.equal(getNovel(created.id)?.narrativePerson, 'third_omniscient')

  assert.throws(
    () => updateNovel(created.id, { narrative_person: 'second' }),
    /narrative_person/,
  )
})

test('detail exposes parsed atlas fields and never raw strings', async () => {
  const { createNovel, getNovel } = await import('../src/services/novels.ts')
  const { saveStoryAtlas } = await import('../src/services/novel/story-atlas-store.ts')
  const novel = createNovel({ title: '解析书', number_of_chapters: 5 })
  saveStoryAtlas(novel.id, {
    timelineEvents: [{ chapterNo: 1, title: '开端' }],
    worldMap: { places: [{ id: 'p1', name: '钟楼' }] },
    baseUpdatedAt: novel.updatedAt,
  })
  const detail = getNovel(novel.id)!
  assert.equal(Array.isArray(detail.timelineEvents), true)
  assert.equal(detail.timelineEvents[0].title, '开端')
  assert.equal(typeof detail.worldMap, 'object')
  assert.equal(detail.worldMap?.places[0].name, '钟楼')
  assert.equal('timeline_events' in detail, false)
})

test('background and writing style snapshot persist through create and update', () => {
  const created = createNovel({
    title: '文风书',
    background: '民国上海',
    writing_style: { key: ' suspense ', name: '悬疑', prompt: '  短句推进  ' },
  })
  assert.equal(created.background, '民国上海')
  assert.deepEqual(created.writingStyle, { key: 'suspense', name: '悬疑', prompt: '短句推进' })

  const updated = updateNovel(created.id, {
    background: '改到重庆',
    writing_style: JSON.stringify({ key: 'custom', name: '自定义', prompt: '留白' }),
  })
  assert.equal(updated?.background, '改到重庆')
  assert.deepEqual(updated?.writingStyle, { key: 'custom', name: '自定义', prompt: '留白' })
  assert.deepEqual(getNovel(created.id)?.writingStyle, { key: 'custom', name: '自定义', prompt: '留白' })

  const cleared = updateNovel(created.id, { writing_style: { key: 'blank', name: '空', prompt: '   ' } })
  assert.equal(cleared?.writingStyle, null)
})

test('generic novel update cannot write atlas columns', async () => {
  const { createNovel, getNovel, updateNovel } = await import('../src/services/novels.ts')
  const novel = createNovel({ title: '白名单书', number_of_chapters: 3 })
  updateNovel(novel.id, {
    world_map: { places: [{ id: 'p1', name: '偷写地图' }] },
    timeline_events: [{ chapterNo: 1, title: '偷写事件' }],
  })
  const detail = getNovel(novel.id)!
  assert.equal(detail.worldMap, null)
  assert.equal(detail.timelineEvents.length, 0)
})
