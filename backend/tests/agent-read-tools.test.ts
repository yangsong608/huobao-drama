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
const { eq } = await import('drizzle-orm')

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

// ===== A1-4/A1-5 项目、分集、资产、分镜、配音、交付 =====

function insertDrama(title: string, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.dramas).values({ title, createdAt: ts, updatedAt: ts, ...extra }).run().lastInsertRowid)
}

function insertEpisode(dramaId: number, episodeNumber: number, title: string, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.episodes).values({
    dramaId, episodeNumber, title, createdAt: ts, updatedAt: ts, ...extra,
  }).run().lastInsertRowid)
}

function insertCharacter(dramaId: number, name: string, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.characters).values({ dramaId, name, createdAt: ts, updatedAt: ts, ...extra }).run().lastInsertRowid)
}

function insertScene(dramaId: number, location: string, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.scenes).values({
    dramaId, location, time: '夜', prompt: '场景提示词', createdAt: ts, updatedAt: ts, ...extra,
  }).run().lastInsertRowid)
}

function insertProp(dramaId: number, name: string, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.props).values({ dramaId, name, createdAt: ts, updatedAt: ts, ...extra }).run().lastInsertRowid)
}

function insertStoryboard(episodeId: number, storyboardNumber: number, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.storyboards).values({
    episodeId, storyboardNumber, title: `分镜${storyboardNumber}`, createdAt: ts, updatedAt: ts, ...extra,
  }).run().lastInsertRowid)
}

function insertLine(episodeId: number, dramaId: number, lineNo: number, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.storyboardLines).values({
    episodeId, dramaId, lineNo, text: `台词${lineNo}`, createdAt: ts, updatedAt: ts, ...extra,
  }).run().lastInsertRowid)
}

function insertTake(lineId: number, episodeId: number, dramaId: number, takeNo: number, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.lineTakes).values({
    lineId, episodeId, dramaId, takeNo, text: `台词${takeNo}`, status: 'ready', createdAt: ts, ...extra,
  }).run().lastInsertRowid)
}

function insertVoice(dramaId: number, name: string, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.characterVoices).values({
    dramaId, name, createdAt: ts, updatedAt: ts, ...extra,
  }).run().lastInsertRowid)
}

function insertMerge(episodeId: number, dramaId: number, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.videoMerges).values({
    episodeId, dramaId, title: `成片${episodeId}`, provider: 'test', model: 'test',
    status: 'completed', createdAt: ts, ...extra,
  }).run().lastInsertRowid)
}

function insertExport(episodeId: number, extra: Record<string, unknown> = {}) {
  return Number(db.insert(schema.episodeExports).values({
    episodeId, kind: 'video', status: 'completed', createdAt: ts, ...extra,
  }).run().lastInsertRowid)
}

const dramaA = insertDrama('长夜项目')
const epA1 = insertEpisode(dramaA, 1, '第一集', { scriptContent: '正式剧本内容' })
const epA2 = insertEpisode(dramaA, 2, '第二集', { content: '原始内容未改写' })
const epA3 = insertEpisode(dramaA, 3, '第三集', { scriptContent: '长'.repeat(7000) })
const dramaB = insertDrama('白昼项目')
const epB1 = insertEpisode(dramaB, 1, 'B 第一集', { scriptContent: '另一项目剧本' })
const deletedDrama = insertDrama('废弃项目', { deletedAt: ts })
const deletedEpisode = insertEpisode(deletedDrama, 1, '废弃集', { scriptContent: '不可见剧本' })

const charA1 = insertCharacter(dramaA, '林晚', {
  role: '主角', finalPrompt: '角色最终提示词', imageUrl: '/static/char-a.png', description: '冷静。',
})
const charA2 = insertCharacter(dramaA, '沈舟', { description: '尚未生成提示词。' })
const charB1 = insertCharacter(dramaB, '外人', { finalPrompt: '别项目角色' })
const deletedChar = insertCharacter(dramaA, '旧角色', { deletedAt: ts, finalPrompt: '删除角色' })
const sceneA1 = insertScene(dramaA, '旧宅')
const deletedScene = insertScene(dramaA, '废墟', { deletedAt: ts })
const propA1 = insertProp(dramaA, '怀表', { type: '道具' })

db.insert(schema.episodeCharacters).values({ episodeId: epA1, characterId: charA1, createdAt: ts }).run()
db.insert(schema.episodeCharacters).values({ episodeId: epA2, characterId: charA1, createdAt: ts }).run()
db.insert(schema.episodeCharacters).values({ episodeId: epA1, characterId: deletedChar, createdAt: ts }).run()
db.insert(schema.episodeCharacters).values({ episodeId: deletedEpisode, characterId: charA1, createdAt: ts }).run()
db.insert(schema.episodeScenes).values({ episodeId: epA1, sceneId: sceneA1, createdAt: ts }).run()
db.insert(schema.episodeScenes).values({ episodeId: epA1, sceneId: deletedScene, createdAt: ts }).run()
db.insert(schema.episodeProps).values({ episodeId: epA1, propId: propA1, createdAt: ts }).run()

const sbA1 = insertStoryboard(epA1, 1, {
  title: '开场', sceneId: sceneA1, duration: 5, shotType: 'medium', angle: 'eye level', movement: 'static',
  imagePrompt: '图片提示词', videoPrompt: '视频提示词', description: '分镜描述', videoUrl: '/static/shot-a1.mp4',
})
const sbA2 = insertStoryboard(epA1, 2, { deletedAt: ts, title: '已删除分镜', videoPrompt: '不可见' })
const sbB1 = insertStoryboard(epB1, 1, { title: 'B 分镜', videoPrompt: '别项目分镜' })

db.insert(schema.storyboardCharacters).values({ storyboardId: sbA1, characterId: charA1 }).run()
db.insert(schema.storyboardProps).values({ storyboardId: sbA1, propId: propA1 }).run()

const lineA1 = insertLine(epA1, dramaA, 1, {
  storyboardId: sbA1, speakerType: 'dialogue', speakerName: '林晚', text: '你终于来了。', audioUrl: '/static/line-a1.mp3',
})
const lineA2 = insertLine(epA1, dramaA, 2, {
  storyboardId: sbA1, speakerType: 'narrator', speakerName: '旁白', text: '夜色渐深。',
})
insertLine(epA1, dramaA, 3, { storyboardId: sbA1, text: '已删除台词', deletedAt: ts })
insertTake(lineA1, epA1, dramaA, 1, { isActive: true, audioUrl: '/static/take-a1.mp3' })
insertTake(lineA2, epA1, dramaA, 1, { deletedAt: ts, isActive: true, audioUrl: '/static/take-a2.mp3' })

insertVoice(dramaA, '林晚音色', {
  characterId: charA1, scope: 'character', isActive: true, status: 'ready',
})
insertVoice(dramaA, '旁白音色', { scope: 'narrator', isActive: true, status: 'ready' })
insertVoice(dramaA, '废弃音色', { scope: 'character', deletedAt: ts })

const mergeA1 = insertMerge(epA1, dramaA, {
  mergedUrl: '/static/film-a1.mp4', duration: 10, kind: 'mix', origin: 'export',
})
const mergeFailed = insertMerge(epA2, dramaA, {
  status: 'failed', errorMsg: '素材缺失，无法合片',
})
insertMerge(epA1, dramaA, { deletedAt: ts, mergedUrl: '/static/deleted-film.mp4' })
db.update(schema.episodes).set({ currentFilmId: mergeA1 }).where(eq(schema.episodes.id, epA1)).run()

const exportA1 = insertExport(epA1, {
  preset: 'final', durationMs: 10000, isCurrent: true, outputUrl: '/static/export-a1.mp4',
})
const exportFailed = insertExport(epA2, { status: 'failed', error: '渲染失败：编码器不可用' })
insertExport(epA1, { deletedAt: ts, outputUrl: '/static/deleted-export.mp4' })

const homeScope = { workspace_key: 'home', kind: 'home' }
const dramaScope = { workspace_key: `drama:${dramaA}`, kind: 'drama', drama_id: dramaA }
const episodeScope = {
  workspace_key: `drama:${dramaA}`, kind: 'episode', drama_id: dramaA, episode_id: epA1, stage: 'script',
}
const directorScope = { workspace_key: `drama:${dramaA}`, kind: 'director', drama_id: dramaA, episode_id: epA1 }
const editScope = { workspace_key: `drama:${dramaA}`, kind: 'edit', drama_id: dramaA, episode_id: epA1, edit_project_id: 1 }
const mixScope = { workspace_key: `drama:${dramaA}`, kind: 'mix', drama_id: dramaA, episode_id: epA1 }
const deliveryScope = { workspace_key: `drama:${dramaA}`, kind: 'delivery', drama_id: dramaA, episode_id: epA1 }

test('read_project_list 只接受首页作用域，软删项目不可见，返回集数', async () => {
  const result: any = await run(homeScope, 'read_project_list')
  assert.equal(result.total, 2)
  assert.deepEqual(new Set(result.items.map((item: any) => item.id)), new Set([dramaA, dramaB]))
  const itemA = result.items.find((item: any) => item.id === dramaA)
  assert.equal(itemA.episode_count, 3)
  assert.equal(itemA.title, '长夜项目')
  assert.ok(!result.items.some((item: any) => item.id === deletedDrama))
  assert.ok(result.hint.length > 0)

  assert.equal((toolsFor(homeScope) as any).read_project_overview, undefined)
  assert.equal((toolsFor(dramaScope) as any).read_project_list, undefined)
})

test('read_project_overview 按项目聚合集数、阶段与资产/分镜/成片计数', async () => {
  const result: any = await run(dramaScope, 'read_project_overview')
  assert.equal(result.project.id, dramaA)
  assert.equal(result.episode_count, 3)
  assert.equal(result.counts.characters, 2)
  assert.equal(result.counts.scenes, 1)
  assert.equal(result.counts.props, 1)
  assert.equal(result.counts.storyboards, 1)
  assert.equal(result.counts.lines, 2)
  assert.equal(result.counts.films, 1)
  assert.equal(result.counts.exports, 2)
  assert.equal(result.counts.current_films, 1)

  const first = result.episodes.find((item: any) => item.episode_id === epA1)
  assert.equal(first.episode_number, 1)
  assert.equal(first.stage, 'delivery')
  assert.equal(first.storyboard_count, 1)
  assert.equal(first.line_count, 2)
  assert.equal(first.has_current_film, true)
  const second = result.episodes.find((item: any) => item.episode_id === epA2)
  assert.equal(second.stage, 'script')
  assert.equal(second.script_chars, '原始内容未改写'.length)

  const deleted: any = await run(
    { workspace_key: `drama:${deletedDrama}`, kind: 'drama', drama_id: deletedDrama },
    'read_project_overview',
  )
  assert.equal(deleted.status, 404)
  assert.equal((toolsFor(episodeScope) as any).read_project_overview, undefined)
})

test('read_script 优先改写剧本，回退原文并标注，超限截断', async () => {
  const result: any = await run(episodeScope, 'read_script')
  assert.equal(result.source, 'script_content')
  assert.equal(result.original, false)
  assert.equal(result.content, '正式剧本内容')
  assert.equal(result.chars, '正式剧本内容'.length)
  assert.equal(result.truncated, false)

  const fallback: any = await run({ ...episodeScope, episode_id: epA2 }, 'read_script')
  assert.equal(fallback.source, 'content')
  assert.equal(fallback.original, true)
  assert.equal(fallback.content, '原始内容未改写')
  assert.match(fallback.note, /原文未改写/)

  const long: any = await run({ ...episodeScope, episode_id: epA3 }, 'read_script')
  assert.equal(long.truncated, true)
  assert.ok(JSON.stringify(long).length <= 6000)
  assert.match(long.hint, /截断/)

  assert.equal((toolsFor(directorScope) as any).read_script, undefined)
  assert.equal((toolsFor(dramaScope) as any).read_script, undefined)
})

test('read_dubbing_status 统计台词、take、旁白缺失与音色档案', async () => {
  const result: any = await run(episodeScope, 'read_dubbing_status')
  assert.equal(result.lines, 2)
  assert.equal(result.generated, 1)
  assert.equal(result.missing, 1)
  assert.equal(result.narrator.total, 1)
  assert.equal(result.narrator.generated, 0)
  assert.equal(result.narrator.missing, 1)
  assert.equal(result.takes.total, 1)
  assert.equal(result.takes.active, 1)
  assert.equal(result.takes.ready, 1)
  assert.equal(result.voices.total, 2)
  assert.equal(result.voices.active, 2)
  assert.equal(result.voices.narrator_present, true)
  assert.deepEqual(result.missing_line_refs.map((item: any) => item.line_id), [lineA2])
  const text = JSON.stringify(result)
  assert.ok(!text.includes('.mp3'))
  assert.ok(!text.includes('.wav'))

  assert.equal((toolsFor(directorScope) as any).read_dubbing_status, undefined)
})

test('read_assets 项目级列出全部资产，集内只列绑定资产，软删不可见', async () => {
  const project: any = await run(dramaScope, 'read_assets')
  assert.equal(project.characters.length, 2)
  assert.equal(project.scenes.length, 1)
  assert.equal(project.props.length, 1)
  assert.ok(!project.characters.some((item: any) => item.id === deletedChar))
  const bound = project.characters.find((item: any) => item.id === charA1)
  assert.equal(bound.bound_episode_count, 2)
  assert.equal(bound.has_final_prompt, true)
  assert.ok(!('final_prompt' in bound))
  const unbound = project.characters.find((item: any) => item.id === charA2)
  assert.equal(unbound.bound_episode_count, 0)

  const episode: any = await run(episodeScope, 'read_assets')
  assert.equal(episode.episode_id, epA1)
  assert.equal(episode.characters.length, 1)
  assert.equal(episode.characters[0].id, charA1)
  assert.equal(episode.characters[0].bound_current_episode, true)
  assert.equal(episode.scenes[0].name, '旧宅')
  assert.equal(episode.props[0].name, '怀表')

  const filtered: any = await run(episodeScope, 'read_assets', { asset_type: 'scene' })
  assert.equal(filtered.characters, undefined)
  assert.equal(filtered.scenes.length, 1)

  assert.equal((toolsFor(episodeScope) as any).read_storyboards !== undefined, true)
  assert.equal((toolsFor(dramaScope) as any).read_storyboards, undefined)
})

test('read_asset_detail 返回完整提示词与绑定集，跨项目/软删拒绝', async () => {
  const detail: any = await run(dramaScope, 'read_asset_detail', { asset_type: 'character', asset_id: charA1 })
  assert.equal(detail.final_prompt, '角色最终提示词')
  assert.equal(detail.has_image, true)
  assert.deepEqual(detail.bound_episodes.map((item: any) => item.episode_number), [1, 2])

  const episodeDetail: any = await run(episodeScope, 'read_asset_detail', { asset_type: 'character', asset_id: charA1 })
  assert.deepEqual(episodeDetail.bound_storyboards, [sbA1])

  const sceneDetail: any = await run(episodeScope, 'read_asset_detail', { asset_type: 'scene', asset_id: sceneA1 })
  assert.equal(sceneDetail.name, '旧宅')
  assert.equal(sceneDetail.final_prompt, null)

  const cross: any = await run(dramaScope, 'read_asset_detail', { asset_type: 'character', asset_id: charB1 })
  assert.equal(cross.status, 404)
  const deleted: any = await run(dramaScope, 'read_asset_detail', { asset_type: 'character', asset_id: deletedChar })
  assert.equal(deleted.status, 404)
  const deletedSceneResult: any = await run(dramaScope, 'read_asset_detail', { asset_type: 'scene', asset_id: deletedScene })
  assert.equal(deletedSceneResult.status, 404)
})

test('read_storyboards 列表不含提示词正文，派生作用域均可用', async () => {
  const result: any = await run(episodeScope, 'read_storyboards')
  assert.equal(result.total, 1)
  const item = result.storyboards[0]
  assert.equal(item.storyboard_id, sbA1)
  assert.equal(item.video_prompt_length, '视频提示词'.length)
  assert.equal(item.image_prompt_length, '图片提示词'.length)
  assert.ok(!('video_prompt' in item))
  assert.ok(!('description' in item))
  assert.equal(item.line_count, 2)
  assert.equal(item.character_count, 1)
  assert.equal(item.prop_count, 1)

  for (const kind of ['director', 'edit', 'mix', 'delivery']) {
    assert.ok((toolsFor({ ...episodeScope, kind, ...(kind === 'edit' ? { edit_project_id: 1 } : {}) }) as any).read_storyboards,
      `read_storyboards should be registered for ${kind}`)
  }
  assert.equal((toolsFor(dramaScope) as any).read_storyboards, undefined)

  const cross: any = await run(episodeScope, 'read_storyboard_detail', { storyboard_id: sbB1 })
  assert.equal(cross.status, 404)
  const deleted: any = await run(episodeScope, 'read_storyboard_detail', { storyboard_id: sbA2 })
  assert.equal(deleted.status, 404)
})

test('read_storyboard_detail 返回完整字段、绑定资产与未删台词', async () => {
  const result: any = await run(episodeScope, 'read_storyboard_detail', { storyboard_id: sbA1 })
  assert.equal(result.video_prompt, '视频提示词')
  assert.equal(result.image_prompt, '图片提示词')
  assert.equal(result.lines.length, 2)
  assert.equal(result.lines[0].text, '你终于来了。')
  assert.equal(result.lines[1].speaker_type, 'narrator')
  assert.deepEqual(result.characters, [{ id: charA1, name: '林晚' }])
  assert.deepEqual(result.props, [{ id: propA1, name: '怀表' }])
})

test('read_delivery_status 集内读取当前成片与失败原因，项目级聚合不要求 episode_id', async () => {
  const episode: any = await run(deliveryScope, 'read_delivery_status')
  assert.equal(episode.current_film.id, mergeA1)
  assert.equal(episode.merges.total, 1)
  assert.equal(episode.exports.total, 1)
  assert.equal(episode.merges.items[0].id, mergeA1)
  assert.equal(episode.exports.items[0].id, exportA1)

  const failed: any = await run({ ...deliveryScope, episode_id: epA2 }, 'read_delivery_status')
  assert.equal(failed.current_film, null)
  assert.equal(failed.merges.failed, 1)
  assert.equal(failed.exports.failed, 1)
  assert.match(failed.merges.items[0].error, /素材缺失/)
  assert.match(failed.exports.items[0].error, /渲染失败/)

  const project: any = await run(dramaScope, 'read_delivery_status')
  assert.equal(project.total, 3)
  assert.equal(project.counts.episodes_with_current_film, 1)
  assert.equal(project.counts.failed_merges, 1)
  assert.equal(project.counts.failed_exports, 1)
  const first = project.episodes.find((item: any) => item.episode_id === epA1)
  assert.equal(first.current_film.id, mergeA1)
  assert.equal(first.latest_export.id, exportA1)
  const second = project.episodes.find((item: any) => item.episode_id === epA2)
  assert.equal(second.current_film, null)
  assert.equal(second.failed_merges, 1)
  assert.equal(second.failed_exports, 1)

  assert.equal((toolsFor(episodeScope) as any).read_delivery_status, undefined)
  assert.equal((toolsFor(deliveryScope) as any).read_export_history !== undefined, true)
  assert.equal((toolsFor(dramaScope) as any).read_export_history, undefined)

  const text = JSON.stringify([episode, project])
  assert.ok(!text.includes(root))
  assert.ok(!text.includes('.mp4'))
})

test('项目/分集只读结果不含数据库路径、密钥或服务器绝对路径', async () => {
  const payloads = [
    await run(homeScope, 'read_project_list'),
    await run(dramaScope, 'read_project_overview'),
    await run(episodeScope, 'read_script'),
    await run(episodeScope, 'read_dubbing_status'),
    await run(dramaScope, 'read_assets'),
    await run(episodeScope, 'read_assets'),
    await run(dramaScope, 'read_asset_detail', { asset_type: 'character', asset_id: charA1 }),
    await run(episodeScope, 'read_storyboards'),
    await run(episodeScope, 'read_storyboard_detail', { storyboard_id: sbA1 }),
    await run(deliveryScope, 'read_delivery_status'),
    await run(dramaScope, 'read_delivery_status'),
  ]
  for (const payload of payloads) {
    const text = JSON.stringify(payload)
    assert.ok(!text.includes(root), 'tool result must not contain the database path')
    assert.ok(!text.includes('.sqlite3'))
    assert.ok(!text.toLowerCase().includes('apikey'))
    assert.ok(!text.toLowerCase().includes('baseurl'))
    assert.ok(!text.includes('/static/'))
  }
})
