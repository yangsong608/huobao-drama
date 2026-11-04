/**
 * V3 P3-2 小说导入服务：预览、提交、request_id 幂等、背景/故事圣经
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-import-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { previewNovelImport, commitNovelImport, buildBackground } = await import('../src/services/novel-import.ts')
const { contentHash } = await import('../src/utils/text-hash.ts')

const ts = '2026-01-01T00:00:00.000Z'

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function insertNovel(overrides: Record<string, unknown> = {}): number {
  const res = db.insert(schema.novels).values({
    title: '雨夜行',
    topic: '民国探案',
    genre: JSON.stringify(['悬疑', '民国']),
    coreSeed: '侦探在雨夜追查连环失踪案',
    characterDynamics: '师徒二人互相隐瞒',
    worldBuilding: '世'.repeat(600),
    plotArchitecture: '三幕式追凶',
    characterState: '主角从孤僻走向信任',
    status: 'writing',
    contentUpdatedAt: ts,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  }).run()
  return Number(res.lastInsertRowid)
}

function insertChapter(novelId: number, chapterNo: number, title: string, content: string, status = 'draft'): void {
  db.insert(schema.novelChapters).values({
    novelId,
    chapterNo,
    title,
    content,
    wordCount: content.length,
    contentHash: contentHash(content),
    status,
    createdAt: ts,
    updatedAt: ts,
  }).run()
}

function paragraphBook(chapters: { no: number; title: string; paragraphs: number; chars: number; status?: string }[]): number {
  const novelId = insertNovel()
  for (const ch of chapters) {
    const content = Array.from({ length: ch.paragraphs }, () => '甲'.repeat(ch.chars)).join('\n\n')
    insertChapter(novelId, ch.no, ch.title, content, ch.status)
  }
  return novelId
}

test('预览：只统计有正文的章节，拆集标题与数量可预览', () => {
  const novelId = paragraphBook([
    { no: 1, title: '第一章 雨夜', paragraphs: 6, chars: 500 },
    { no: 2, title: '第二章 尾随', paragraphs: 1, chars: 700 },
  ])
  insertChapter(novelId, 3, '第三章 空白', '')

  const preview = previewNovelImport(novelId, { target_words: 1200 })
  assert.equal(preview.novel_id, novelId)
  assert.equal(preview.chapter_count, 2)
  assert.equal(preview.episode_count, 4)
  assert.deepEqual(preview.chapters.map((c) => c.chapter_no), [1, 2])
  assert.deepEqual(preview.episodes.map((e) => [e.chapter_no, e.part_no]), [[1, 1], [1, 2], [1, 3], [2, 1]])
  assert.equal(preview.episodes[0].title, '第一章 雨夜（1/3）')
  assert.equal(preview.episodes[3].title, '第二章 尾随')
  assert.equal(preview.existing_imports, 0)
})

test('预览：include_draft=false 只保留已定稿章节', () => {
  const novelId = insertNovel()
  insertChapter(novelId, 1, '第一章 草稿', '草'.repeat(700), 'draft')
  insertChapter(novelId, 2, '第二章 定稿', '定'.repeat(700), 'final')

  const all = previewNovelImport(novelId, {})
  assert.equal(all.chapter_count, 2)
  const finals = previewNovelImport(novelId, { include_draft: false })
  assert.equal(finals.chapter_count, 1)
  assert.deepEqual(finals.chapters.map((c) => c.chapter_no), [2])
})

test('提交：建项目/集/映射，写入故事圣经、背景与合并 metadata', async () => {
  const novelId = paragraphBook([
    { no: 1, title: '第一章 雨夜', paragraphs: 6, chars: 500, status: 'draft' },
    { no: 2, title: '第二章 尾随', paragraphs: 1, chars: 700, status: 'final' },
  ])

  const result = await commitNovelImport(novelId, {
    request_id: 'req-import-1',
    target_words: 1200,
    background_mode: 'rule',
  })
  assert.equal(result.existing, false)
  assert.equal(result.episode_count, 4)

  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, result.drama_id)).get()!
  assert.equal(drama.title, '《雨夜行》短剧')
  assert.equal(drama.aspectRatio, '16:9')
  assert.equal(drama.style, '3d')
  assert.equal(drama.sourceNovelId, novelId)
  assert.equal(drama.totalEpisodes, 4)
  assert.equal(drama.genre, '悬疑、民国')
  assert.deepEqual(JSON.parse(drama.tags || '[]'), ['悬疑', '民国'])
  assert.ok((drama.description || '').includes('民国探案'))
  assert.ok(drama.background && [...drama.background].length <= 400)
  assert.ok(drama.background!.startsWith('民国探案'))

  const bible = JSON.parse(drama.storyBible || '{}')
  assert.deepEqual(Object.keys(bible), ['coreSeed', 'characterDynamics', 'worldBuilding', 'plotArchitecture', 'characterState'])
  assert.equal(bible.coreSeed, '侦探在雨夜追查连环失踪案')
  assert.equal(bible.worldBuilding, '世'.repeat(600))

  const meta = JSON.parse(drama.metadata || '{}')
  assert.equal(meta.source, 'novel')
  assert.equal(meta.novel_id, novelId)
  assert.equal(meta.novel_title, '雨夜行')
  assert.equal(meta.import_id, result.import_id)

  const episodes = db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, result.drama_id)).all()
    .sort((a, b) => a.episodeNumber - b.episodeNumber)
  assert.deepEqual(episodes.map((e) => e.episodeNumber), [1, 2, 3, 4])
  assert.deepEqual(episodes.map((e) => [e.sourceChapterNo, e.sourcePartNo]), [[1, 1], [1, 2], [1, 3], [2, 1]])
  assert.equal(episodes[0].title, '第一章 雨夜（1/3）')
  assert.equal(episodes[3].title, '第二章 尾随')
  assert.ok(episodes.every((e) => (e.content || '').length > 0))
  assert.ok(episodes.every((e) => e.sourceStale === false))

  const mappings = db.select().from(schema.novelImportEpisodes)
    .where(eq(schema.novelImportEpisodes.importId, result.import_id)).all()
  assert.equal(mappings.length, 4)
  assert.ok(mappings.every((m) => m.status === 'synced' && m.contentHash && m.chapterHash))
  assert.deepEqual(mappings.map((m) => m.episodeId).sort((a, b) => a - b), episodes.map((e) => e.id).sort((a, b) => a - b))

  const imp = db.select().from(schema.novelImports).where(eq(schema.novelImports.id, result.import_id)).get()!
  assert.equal(imp.requestId, 'req-import-1')
  assert.equal(imp.status, 'active')
  assert.equal(imp.novelId, novelId)
  assert.equal(imp.dramaId, result.drama_id)
  assert.equal(imp.sourceUpdatedAt, ts)
  assert.ok(imp.lastSyncedAt)
  assert.deepEqual(JSON.parse(imp.lastSyncSummary || '{}').split_mode, 'words')
})

test('提交：request_id 幂等，重复提交返回同一导入且不重复建项目', async () => {
  const novelId = paragraphBook([{ no: 1, title: '第一章', paragraphs: 1, chars: 700 }])
  const first = await commitNovelImport(novelId, { request_id: 'same-request' })
  const second = await commitNovelImport(novelId, { request_id: 'same-request' })

  assert.equal(second.existing, true)
  assert.equal(second.import_id, first.import_id)
  assert.equal(second.drama_id, first.drama_id)
  assert.equal(second.episode_count, first.episode_count)

  const dramas = db.select().from(schema.dramas).where(eq(schema.dramas.sourceNovelId, novelId)).all()
  assert.equal(dramas.length, 1)
  const imports = db.select().from(schema.novelImports).where(eq(schema.novelImports.novelId, novelId)).all()
  assert.equal(imports.length, 1)
})

test('提交：chapter 拆集模式、9:16、自定义标题与样式', async () => {
  const novelId = paragraphBook([
    { no: 1, title: '第一章', paragraphs: 1, chars: 2500 },
    { no: 2, title: '第二章', paragraphs: 1, chars: 100 },
  ])
  const result = await commitNovelImport(novelId, {
    title: '雨夜探案',
    style: '2d',
    aspect_ratio: '9:16',
    split_mode: 'chapter',
  })
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, result.drama_id)).get()!
  assert.equal(drama.title, '雨夜探案')
  assert.equal(drama.style, '2d')
  assert.equal(drama.aspectRatio, '9:16')
  assert.equal(result.episode_count, 2)
})

test('提交：3 章按字数拆集，集号连续且标题带分集', async () => {
  const novelId = paragraphBook([
    { no: 1, title: '第一章', paragraphs: 1, chars: 700 },
    { no: 2, title: '第二章', paragraphs: 2, chars: 700 },
    { no: 3, title: '第三章', paragraphs: 1, chars: 700 },
  ])
  const result = await commitNovelImport(novelId, { target_words: 1200 })
  assert.equal(result.episode_count, 4)

  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, result.drama_id)).get()!
  assert.equal(drama.aspectRatio, '16:9')
  const episodes = db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, result.drama_id)).all()
    .sort((a, b) => a.episodeNumber - b.episodeNumber)
  assert.deepEqual(episodes.map((e) => e.episodeNumber), [1, 2, 3, 4])
  assert.deepEqual(episodes.map((e) => e.title), ['第一章', '第二章（1/2）', '第二章（2/2）', '第三章'])
})

test('基准：100 章导入（预览+提交）≤5s', async (t) => {
  const novelId = paragraphBook(Array.from({ length: 100 }, (_, i) => ({
    no: i + 1,
    title: `第${i + 1}章`,
    paragraphs: 1,
    chars: 700,
  })))
  const started = performance.now()
  const preview = previewNovelImport(novelId, { target_words: 1200 })
  const result = await commitNovelImport(novelId, { target_words: 1200, background_mode: 'none' })
  const elapsed = performance.now() - started
  t.diagnostic(`100 章导入耗时 ${elapsed.toFixed(1)}ms`)
  assert.equal(preview.chapter_count, 100)
  assert.equal(preview.episode_count, 100)
  assert.equal(result.episode_count, 100)
  assert.ok(elapsed <= 5000, `100 章导入耗时 ${elapsed.toFixed(1)}ms，超过 5s 基准`)
})

test('提交：无正文/无匹配章节时报错，不建空项目', async () => {
  const novelId = insertNovel()
  await assert.rejects(commitNovelImport(novelId, {}), /没有可导入的章节/)
  insertChapter(novelId, 1, '第一章 定稿', '定'.repeat(700), 'final')
  await assert.rejects(commitNovelImport(novelId, { include_draft: false, chapter_nos: [99] }), /没有可导入的章节/)
  const dramas = db.select().from(schema.dramas).where(eq(schema.dramas.sourceNovelId, novelId)).all()
  assert.equal(dramas.length, 0)
})

test('背景：rule 截断 400 字，none 为空，ai 无配置时回退 rule', async () => {
  const novelId = insertNovel()
  const novel = db.select().from(schema.novels).where(eq(schema.novels.id, novelId)).get()!
  const rule = await buildBackground(novel, 'rule')
  assert.equal(rule, await buildBackground(novel, 'rule'))
  assert.ok([...rule].length <= 400)
  assert.ok(rule.startsWith('民国探案'))

  assert.equal(await buildBackground(novel, 'none'), '')
  const fallback = await buildBackground(novel, 'ai')
  assert.equal(fallback, rule)
})

test('背景：ai 模式使用文本模型摘要并截断到 400 字', async () => {
  const novelId = insertNovel()
  const novel = db.select().from(schema.novels).where(eq(schema.novels.id, novelId)).get()!
  const nowIso = new Date().toISOString()
  const config = db.insert(schema.aiServiceConfigs).values({
    serviceType: 'text',
    provider: 'gemini',
    name: 'stub-gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'test',
    model: JSON.stringify(['gemini-test']),
    priority: 10,
    isActive: true,
    createdAt: nowIso,
    updatedAt: nowIso,
  }).run()

  const fetchImpl = (async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'AI摘要'.repeat(120) }] } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

  const summary = await buildBackground(novel, 'ai', { fetchImpl })
  assert.ok(summary.startsWith('AI摘要'))
  assert.ok([...summary].length <= 400)

  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, Number(config.lastInsertRowid))).run()
})
