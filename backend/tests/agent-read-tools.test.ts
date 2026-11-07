/**
 * A1-4：小说五只读工具 — 作用域、软删、越界、截断与列表不含正文
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-read-tools-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.WORKSPACE_PATH = root
process.env.MYSQL_AUTO_IMPORT = 'false'

const { getPresetTools } = await import('../src/agents/tools/read-tools.ts')
const { buildAssistantRequestContext } = await import('../src/agents/context.ts')
const { db, schema } = await import('../src/db/index.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const ts = '2026-11-07T00:00:00.000Z'
const WORLD_MAP = {
  version: 1,
  generatedAt: ts,
  regions: [{ id: 'r1', name: '旧城' }],
  factions: [{ id: 'f1', name: '夜行会' }],
  places: [{ id: 'p1', name: '旧宅', regionId: 'r1', x: 10, y: 20, importance: 3 }],
  routes: [],
}
const GRAPH_META = JSON.stringify({
  version: 1,
  generatedAt: ts,
  graphGenerated: true,
  audit: {
    inconsistencies: [
      { type: 'timeline', severity: 'error', nodeIds: [], edgeIds: [], chapters: [1], message: '时间线冲突' },
      { type: 'place', severity: 'warning', nodeIds: [], edgeIds: [], chapters: [2], message: '地点未绑定' },
    ],
    lastAuditAt: ts,
  },
})

function insertNovel(title: string, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.novels).values({
    title,
    createdAt: ts,
    updatedAt: ts,
    ...extra,
  }).run().lastInsertRowid)
}

function insertChapter(novelId: number, chapterNo: number, content = '', extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.novelChapters).values({
    novelId,
    chapterNo,
    title: `第${chapterNo}章`,
    content,
    wordCount: content.length,
    createdAt: ts,
    updatedAt: ts,
    ...extra,
  }).run().lastInsertRowid)
}

const novelA = insertNovel('长夜将明', {
  status: 'writing',
  numberOfChapters: 5,
  characterState: '姓名：林晚，冷静。',
  characterDynamics: '林晚与沈舟互相试探。',
  chapterBlueprint: '第1章 开端\n本章简述：林晚回城。\n第2章 尾随\n本章简述：有人跟踪。\n第3章 对峙\n本章简述：正面冲突。',
  narrativePerson: 'first',
  architectureGenerated: true,
  blueprintGenerated: true,
  timelineEvents: JSON.stringify([
    { id: 'e1', chapterNo: 1, timeLabel: '夜', title: '回城', summary: '林晚回到旧城。', importance: 3, source: 'manual', status: 'planned' },
    { id: 'e2', chapterNo: 2, timeLabel: '深夜', title: '尾随', summary: '有人跟踪。', importance: 4, source: 'manual', status: 'confirmed' },
  ]),
  worldMap: JSON.stringify(WORLD_MAP),
  graphMeta: GRAPH_META,
})
const chapterA1 = insertChapter(novelA, 1, '林晚回到旧城，雨一直下。')
const chapterA2 = insertChapter(novelA, 2, '巨'.repeat(7000))

const novelB = insertNovel('白昼尽头', { numberOfChapters: 3 })
const chapterB1 = insertChapter(novelB, 1, '这是另一本小说，绝不可见。')
const deletedNovel = insertNovel('废弃旧稿', { deletedAt: ts })
insertChapter(deletedNovel, 1, '已删除小说的正文。')
const emptyNovel = insertNovel('空白新书', { numberOfChapters: 2 })

function rcFor(scope: any) {
  return buildAssistantRequestContext({
    sessionId: 1,
    messageId: 2,
    workspaceKey: scope.workspace_key,
    scope,
    preset: 'assistant',
    language: 'zh',
  })
}

function toolsFor(scope: any) {
  return getPresetTools(rcFor(scope))
}

async function run(scope: any, name: string, input: Record<string, unknown> = {}) {
  const tools = toolsFor(scope)
  assert.ok(tools[name], `tool ${name} should be registered for ${scope.kind}`)
  return (tools[name] as any).execute(input, { requestContext: rcFor(scope) })
}

const novelLibrary = { workspace_key: 'novel-library', kind: 'novel-library' }
const scopeA = { workspace_key: `novel:${novelA}`, kind: 'novel', novel_id: novelA }
const scopeB = { workspace_key: `novel:${novelB}`, kind: 'novel', novel_id: novelB }

test('read_novel_list 只接受小说库作用域，软删小说不可见，列表不含正文', async () => {
  const result: any = await run(novelLibrary, 'read_novel_list')
  assert.equal(result.total, 3)
  assert.deepEqual(new Set(result.items.map((item: any) => item.id)), new Set([novelA, novelB, emptyNovel]))
  assert.ok(!result.items.some((item: any) => item.id === deletedNovel))
  assert.ok(result.items.every((item: any) => !('content' in item)))
  assert.ok(result.hint.length > 0)

  assert.equal((toolsFor(scopeA) as any).read_novel_list, undefined)
})

test('read_novel_context 返回人物状态、蓝图与图谱审计，越界小说被拒绝', async () => {
  const result: any = await run(scopeA, 'read_novel_context')
  assert.equal(result.novel.id, novelA)
  assert.equal(result.characters.state, '姓名：林晚，冷静。')
  assert.equal(result.blueprint.total, 3)
  assert.equal(result.blueprint.items[0].title, '开端')
  assert.equal(result.narrative_person.label, '第一人称')
  assert.equal(result.graph.audit_count, 2)
  assert.equal(result.graph.audit_errors, 1)
  assert.equal(result.graph.audit_items[0].message, '时间线冲突')

  const cross: any = await run(scopeA, 'read_novel_context', { novel_id: novelB })
  assert.match(cross.error, /作用域不一致/)

  const deletedScope = { workspace_key: `novel:${deletedNovel}`, kind: 'novel', novel_id: deletedNovel }
  const deleted: any = await run(deletedScope, 'read_novel_context')
  assert.match(deleted.error, /不存在或已删除/)

  const empty: any = await run({ workspace_key: `novel:${emptyNovel}`, kind: 'novel', novel_id: emptyNovel }, 'read_novel_context')
  assert.equal(empty.blueprint.total, 0)
  assert.ok(empty.characters.empty_reason)
})

test('read_novel_chapters 列表不含正文，只返回当前小说章节', async () => {
  const result: any = await run(scopeA, 'read_novel_chapters')
  assert.equal(result.total, 2)
  assert.deepEqual(result.items.map((item: any) => item.chapter_no), [1, 2])
  assert.ok(result.items.every((item: any) => !('content' in item)))
  assert.ok(result.items.every((item: any) => item.chapter_id > 0))
  assert.equal(result.truncated, false)

  const limited: any = await run(scopeA, 'read_novel_chapters', { chapter_no_from: 2 })
  assert.equal(limited.total, 1)
  assert.equal(limited.items[0].chapter_no, 2)

  const b: any = await run(scopeB, 'read_novel_chapters')
  assert.equal(b.total, 1)
  assert.equal(b.items[0].chapter_no, 1)

  const empty: any = await run({ workspace_key: `novel:${emptyNovel}`, kind: 'novel', novel_id: emptyNovel }, 'read_novel_chapters')
  assert.equal(empty.total, 0)
  assert.match(empty.hint, /尚无已创建章节/)
})

test('read_novel_chapter_content 按小说隔离、支持编号/ID，超限截断', async () => {
  const byNo: any = await run(scopeA, 'read_novel_chapter_content', { chapter_no: 1 })
  assert.equal(byNo.chapter_id, chapterA1)
  assert.equal(byNo.content, '林晚回到旧城，雨一直下。')
  assert.equal(byNo.truncated, false)

  const byId: any = await run(scopeA, 'read_novel_chapter_content', { chapter_id: chapterA1 })
  assert.equal(byId.chapter_no, 1)

  const cross: any = await run(scopeA, 'read_novel_chapter_content', { chapter_id: chapterB1 })
  assert.match(cross.error, /不存在或不属于当前小说/)

  const missing: any = await run(scopeA, 'read_novel_chapter_content', {})
  assert.match(missing.error, /缺少章节编号/)

  const long: any = await run(scopeA, 'read_novel_chapter_content', { chapter_no: 2 })
  assert.equal(long.truncated, true)
  assert.ok(long.content.length < 7000)
  assert.ok(JSON.stringify(long).length <= 6000)
  assert.match(long.hint, /截断/)
})

test('read_novel_atlas 返回时间线、世界地图、POV 与图谱状态', async () => {
  const result: any = await run(scopeA, 'read_novel_atlas')
  assert.equal(result.novel.id, novelA)
  assert.equal(result.narrative_person.label, '第一人称')
  assert.equal(result.timeline.total, 2)
  assert.equal(result.timeline.items[0].title, '回城')
  assert.equal(result.world_map.total_places, 1)
  assert.equal(result.world_map.places[0].name, '旧宅')
  assert.equal(result.world_map.regions[0].name, '旧城')
  assert.equal(result.graph.generated, true)
  assert.equal(result.graph.audit_count, 2)

  const empty: any = await run({ workspace_key: `novel:${emptyNovel}`, kind: 'novel', novel_id: emptyNovel }, 'read_novel_atlas')
  assert.equal(empty.timeline.total, 0)
  assert.equal(empty.world_map.generated_at, null)
  assert.match(empty.hint, /尚未生成/)

  const cross: any = await run(scopeA, 'read_novel_atlas', { novel_id: novelB })
  assert.match(cross.error, /作用域不一致/)
})

test('错误作用域被拒绝，结果不泄露数据库路径', async () => {
  assert.equal((toolsFor(novelLibrary) as any).read_novel_context, undefined)
  assert.equal((toolsFor(novelLibrary) as any).read_novel_atlas, undefined)
  assert.equal((toolsFor(scopeA) as any).read_novel_list, undefined)

  const payloads = [
    await run(novelLibrary, 'read_novel_list'),
    await run(scopeA, 'read_novel_context'),
    await run(scopeA, 'read_novel_chapters'),
    await run(scopeA, 'read_novel_chapter_content', { chapter_no: 1 }),
    await run(scopeA, 'read_novel_atlas'),
  ]
  for (const payload of payloads) {
    const text = JSON.stringify(payload)
    assert.ok(!text.includes(root), 'tool result must not contain the database path')
    assert.ok(!text.includes('.sqlite3'))
    assert.ok(!text.toLowerCase().includes('apikey'))
    assert.ok(!text.toLowerCase().includes('baseurl'))
  }
})

test('工具注册不包含写工具或文件/命令工具', () => {
  const denied = ['write_file', 'edit_file', 'delete_file', 'execute_command', 'read_file', 'propose_change', 'suggest_action']
  for (const scope of [novelLibrary, scopeA]) {
    const names = Object.keys(toolsFor(scope))
    for (const name of denied) assert.ok(!names.includes(name), `${name} must not be registered`)
    assert.ok(names.every((name) => name.startsWith('read_novel_')))
  }
  assert.equal((toolsFor(novelLibrary) as any).read_novel_chapters, undefined)
  assert.equal((toolsFor(scopeA) as any).read_novel_list, undefined)
})
