/**
 * N3 上下文包：预览组装、只读、预算整句截断、导入注入 adaptationNotes、幂等与警告
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { eq, sql } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-context-pack-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: novelImportRoutes } = await import('../src/routes/novelImports.ts')
const { buildNovelContextPack } = await import('../src/services/novel-context-pack.ts')
const { commitNovelImport, CONTEXT_PACK_SKIPPED_WARNING } = await import('../src/services/novel-import.ts')
const { setNovelSettings } = await import('../src/services/app-settings.ts')
const { contentHash } = await import('../src/utils/text-hash.ts')

const app = new Hono()
app.route('/api/v1/novels', novelImportRoutes)

const ts = '2026-03-01T00:00:00.000Z'

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function json(response: Response) {
  return response.json() as Promise<any>
}

function insertNovel(overrides: Record<string, unknown> = {}): number {
  const res = db.insert(schema.novels).values({
    title: '雨夜行',
    topic: '民国探案',
    genre: JSON.stringify(['悬疑', '民国']),
    coreSeed: '侦探在雨夜追查连环失踪案',
    characterDynamics: '师徒二人互相隐瞒',
    worldBuilding: '民国上海，雨夜潮湿。',
    plotArchitecture: '三幕式追凶',
    characterState: '主角从孤僻走向信任',
    chapterBlueprint: '第1章 雨夜\n本章简述：侦探在雨夜发现脚印。\n第2章 尾随\n本章简述：助手暗中跟踪。',
    numberOfChapters: 2,
    status: 'writing',
    contentUpdatedAt: ts,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
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

function insertAnnotation(novelId: number, chapterNo: number, quote: string, status = 'open', note = ''): void {
  db.insert(schema.novelAnnotations).values({
    novelId,
    chapterNo,
    quote,
    startOffset: 0,
    endOffset: quote.length,
    prefix: '',
    suffix: '',
    note,
    kind: 'adapt',
    status,
    createdAt: ts,
    updatedAt: ts,
  }).run()
}

function insertForeshadow(novelId: number, title: string, status = 'planted', setupChapter = 1, payoffChapter: number | null = 2): void {
  db.insert(schema.novelForeshadows).values({
    novelId,
    title,
    setupChapter,
    payoffChapter,
    status,
    evidenceQuote: '雨声掩盖了脚步声',
    note: '',
    source: 'manual',
    createdAt: ts,
    updatedAt: ts,
  }).run()
}

function fullBook(): number {
  const novelId = insertNovel()
  insertChapter(novelId, 1, '甲'.repeat(700), '雨夜')
  insertChapter(novelId, 2, '乙'.repeat(700), '尾随')
  return novelId
}

async function preview(novelId: number, body: Record<string, unknown>) {
  return app.request(`/api/v1/novels/${novelId}/context-pack/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('预览：空小说返回空文本与零计数', async () => {
  const novelId = insertNovel({
    chapterBlueprint: '',
    coreSeed: '',
    characterDynamics: '',
    worldBuilding: '',
    plotArchitecture: '',
    characterState: '',
  })
  const response = await preview(novelId, {})
  assert.equal(response.status, 200)
  const data = (await json(response)).data
  assert.equal(data.text, '')
  assert.equal(data.chars, 0)
  assert.equal(data.truncated, false)
  assert.deepEqual(data.included, { chapters: 0, annotations: 0, foreshadows: 0 })

  assert.equal((await preview(999999, {})).status, 404)
  assert.equal((await preview(novelId, { chapter_nos: 'bad' })).status, 400)
  assert.equal((await preview(novelId, { max_chars: 'bad' })).status, 400)
})

test('预览：按所选章节聚合圣经、蓝图摘要、未回收伏笔与批注，且只读', async () => {
  const novelId = fullBook()
  insertAnnotation(novelId, 1, '他把信放回抽屉', 'open', '暗示身份')
  insertAnnotation(novelId, 1, '雨停了', 'resolved', '氛围已确认')
  insertAnnotation(novelId, 1, '已删除的旧引文', 'orphaned', '不应出现')
  insertAnnotation(novelId, 2, '助手在门外', 'open', '不应出现')
  insertForeshadow(novelId, '抽屉里的信', 'planted', 1, 2)
  insertForeshadow(novelId, '旧怀表', 'paid', 1, 2)
  insertForeshadow(novelId, '失踪的邻居', 'abandoned', 1, null)

  const before = {
    annotations: db.select().from(schema.novelAnnotations).where(eq(schema.novelAnnotations.novelId, novelId)).all(),
    foreshadows: db.select().from(schema.novelForeshadows).where(eq(schema.novelForeshadows.novelId, novelId)).all(),
    chapters: db.select().from(schema.novelChapters).where(eq(schema.novelChapters.novelId, novelId)).all(),
  }

  const response = await preview(novelId, {
    chapter_nos: [1],
    include_annotations: true,
    include_unresolved_foreshadows: true,
    max_chars: 4000,
  })
  assert.equal(response.status, 200)
  const data = (await json(response)).data
  assert.equal(data.chars, data.text.length)
  assert.equal(data.truncated, false)
  assert.ok(data.text.startsWith('【小说改编上下文】\n小说：《雨夜行》'))
  assert.ok(data.text.includes('【故事圣经】'))
  assert.ok(data.text.includes('【核心种子】\n侦探在雨夜追查连环失踪案'))
  assert.ok(data.text.includes('【剧情架构】\n三幕式追凶'))
  assert.ok(data.text.includes('【章节摘要】'))
  assert.ok(data.text.includes('- 第1章《雨夜》：侦探在雨夜发现脚印。'))
  assert.ok(!data.text.includes('- 第2章'))
  assert.ok(data.text.includes('【未回收伏笔】'))
  assert.ok(data.text.includes('抽屉里的信'))
  assert.ok(!data.text.includes('旧怀表'))
  assert.ok(!data.text.includes('失踪的邻居'))
  assert.ok(data.text.includes('【批注摘录】'))
  assert.ok(data.text.includes('他把信放回抽屉'))
  assert.ok(data.text.includes('雨停了'))
  assert.ok(!data.text.includes('已删除的旧引文'))
  assert.ok(!data.text.includes('助手在门外'))
  assert.deepEqual(data.included, { chapters: 1, annotations: 2, foreshadows: 1 })

  const after = {
    annotations: db.select().from(schema.novelAnnotations).where(eq(schema.novelAnnotations.novelId, novelId)).all(),
    foreshadows: db.select().from(schema.novelForeshadows).where(eq(schema.novelForeshadows.novelId, novelId)).all(),
    chapters: db.select().from(schema.novelChapters).where(eq(schema.novelChapters.novelId, novelId)).all(),
  }
  assert.deepEqual(after, before)
})

test('预览：设置默认关闭批注/伏笔，预算 500–20000 钳制且整句截断', async () => {
  const novelId = fullBook()
  insertAnnotation(novelId, 1, '批注引文')
  insertForeshadow(novelId, '伏笔标题')

  setNovelSettings({ contextPack: { includeAnnotations: false, includeUnresolved: false } })
  let data = (await json(await preview(novelId, { chapter_nos: [1] }))).data
  assert.ok(!data.text.includes('【批注摘录】'))
  assert.ok(!data.text.includes('【未回收伏笔】'))
  setNovelSettings({ contextPack: { includeAnnotations: true, includeUnresolved: true } })

  const longNovel = insertNovel({ worldBuilding: '潮湿的雨夜笼罩着整条街。'.repeat(160) })
  insertChapter(longNovel, 1, '丙'.repeat(700))
  insertAnnotation(longNovel, 1, '批注引文')
  insertForeshadow(longNovel, '伏笔标题')

  data = (await json(await preview(longNovel, {
    chapter_nos: [1],
    include_annotations: true,
    include_unresolved_foreshadows: true,
    max_chars: 1,
  }))).data
  assert.ok(data.text.length <= 500)
  assert.equal(data.truncated, true)
  assert.match(data.text, /[。！？!?；;…]$/)

  const service = buildNovelContextPack(longNovel, { chapter_nos: [1], max_chars: 1 })
  assert.equal(service.max_chars, 500)
  assert.ok(service.chars <= 500)
  assert.equal(service.truncated, true)
  assert.match(service.text, /[。！？!?；;…]$/)
  assert.equal(buildNovelContextPack(longNovel, { max_chars: 999999 }).max_chars, 20000)
})

test('导入：上下文包写入 adaptationNotes，与预览一致，重复 request_id 不重复追加', async () => {
  const novelId = fullBook()
  insertAnnotation(novelId, 1, '他把信放回抽屉', 'open', '暗示身份')
  insertForeshadow(novelId, '抽屉里的信', 'planted', 1, 2)

  const result = await commitNovelImport(novelId, {
    request_id: 'ctx-import-1',
    include_context_pack: true,
    context_pack_max_chars: 4000,
  })
  assert.equal(result.existing, false)
  assert.deepEqual(result.warnings, [])
  assert.ok(result.context_pack)
  assert.ok(result.context_pack!.chars > 0)
  assert.deepEqual(result.context_pack!.included, { chapters: 2, annotations: 1, foreshadows: 1 })

  const expected = buildNovelContextPack(novelId, { chapter_nos: [1, 2], max_chars: 4000 })
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, result.drama_id)).get()!
  const bible = JSON.parse(drama.storyBible || '{}')
  assert.equal(bible.adaptationNotes, expected.text)
  assert.equal(bible.coreSeed, '侦探在雨夜追查连环失踪案')

  const summary = JSON.parse(
    db.select().from(schema.novelImports).where(eq(schema.novelImports.id, result.import_id)).get()!.lastSyncSummary || '{}',
  )
  assert.equal(summary.context_pack.chars, expected.chars)
  assert.equal(summary.context_pack.truncated, false)
  assert.deepEqual(summary.context_pack.included, { chapters: 2, annotations: 1, foreshadows: 1 })

  const repeat = await commitNovelImport(novelId, {
    request_id: 'ctx-import-1',
    include_context_pack: true,
    context_pack_max_chars: 4000,
  })
  assert.equal(repeat.existing, true)
  assert.equal(repeat.import_id, result.import_id)
  assert.deepEqual(repeat.context_pack, result.context_pack)
  const dramas = db.select().from(schema.dramas).where(eq(schema.dramas.sourceNovelId, novelId)).all()
  assert.equal(dramas.length, 1)
  assert.equal(JSON.parse(dramas[0].storyBible || '{}').adaptationNotes, expected.text)

  db.update(schema.novelImports)
    .set({ lastSyncSummary: JSON.stringify({ context_pack: 'skipped' }) })
    .where(eq(schema.novelImports.id, result.import_id))
    .run()
  const skipped = await commitNovelImport(novelId, { request_id: 'ctx-import-1', include_context_pack: true })
  assert.equal(skipped.existing, true)
  assert.equal(skipped.context_pack, null)
  assert.deepEqual(skipped.warnings, [CONTEXT_PACK_SKIPPED_WARNING])
})

test('路由：导入返回上下文包摘要与空警告，重复请求保持一致', async () => {
  const novelId = fullBook()
  const body = { request_id: 'ctx-route-1', include_context_pack: true, context_pack_max_chars: 4000 }
  const response = await app.request(`/api/v1/novels/${novelId}/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
  const data = (await json(response)).data
  assert.deepEqual(data.warnings, [])
  assert.ok(data.context_pack.chars > 0)
  assert.deepEqual(data.context_pack.included, { chapters: 2, annotations: 0, foreshadows: 0 })

  const repeat = (await json(await app.request(`/api/v1/novels/${novelId}/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))).data
  assert.equal(repeat.existing, true)
  assert.equal(repeat.import_id, data.import_id)
  assert.deepEqual(repeat.context_pack, data.context_pack)
})

test('导入：未勾选时不写 adaptationNotes，摘要记录 off；参数类型校验', async () => {
  const novelId = fullBook()
  const result = await commitNovelImport(novelId, { request_id: 'ctx-import-off' })
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, result.drama_id)).get()!
  const bible = JSON.parse(drama.storyBible || '{}')
  assert.equal(bible.adaptationNotes, undefined)
  assert.equal(bible.coreSeed, '侦探在雨夜追查连环失踪案')
  assert.equal(result.context_pack, null)
  const summary = JSON.parse(
    db.select().from(schema.novelImports).where(eq(schema.novelImports.id, result.import_id)).get()!.lastSyncSummary || '{}',
  )
  assert.equal(summary.context_pack, 'off')

  const badFlag = await app.request(`/api/v1/novels/${novelId}/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ include_context_pack: 'yes' }),
  })
  assert.equal(badFlag.status, 400)
  const badMax = await app.request(`/api/v1/novels/${novelId}/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ include_context_pack: true, context_pack_max_chars: 'abc' }),
  })
  assert.equal(badMax.status, 400)
})

test('导入：上下文包生成失败不阻断导入，返回警告并记录 skipped', async () => {
  const novelId = fullBook()
  db.run(sql`ALTER TABLE novel_foreshadows RENAME TO novel_foreshadows_ctx_tmp`)
  let result: any
  try {
    result = await commitNovelImport(novelId, { request_id: 'ctx-fail', include_context_pack: true })
  } finally {
    db.run(sql`ALTER TABLE novel_foreshadows_ctx_tmp RENAME TO novel_foreshadows`)
  }
  assert.equal(result.existing, false)
  assert.ok(result.episode_count > 0)
  assert.deepEqual(result.warnings, [CONTEXT_PACK_SKIPPED_WARNING])
  assert.equal(result.context_pack, null)

  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, result.drama_id)).get()!
  assert.equal(JSON.parse(drama.storyBible || '{}').adaptationNotes, undefined)
  const summary = JSON.parse(
    db.select().from(schema.novelImports).where(eq(schema.novelImports.id, result.import_id)).get()!.lastSyncSummary || '{}',
  )
  assert.equal(summary.context_pack, 'skipped')
})
