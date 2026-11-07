/**
 * MCP 服务验证（隔离库 + 随机空闲端口）：
 * - 默认关闭、无 token
 * - 开启后监听固定端口，Bearer token 才可用
 * - initialize / tools/list / tools/call 走通
 * - token 轮换后旧 token 立即失效
 * - 关闭后端口释放
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-mcp-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { default: dramasRoute } = await import('../src/routes/dramas.ts')
const { default: episodesRoute } = await import('../src/routes/episodes.ts')
const { default: mergeRoute } = await import('../src/routes/merge.ts')
const { default: uploadRoute } = await import('../src/routes/upload.ts')
const { default: charactersRoute } = await import('../src/routes/characters.ts')
const { default: scenesRoute } = await import('../src/routes/scenes.ts')
const { default: propsRoute } = await import('../src/routes/props.ts')
const { default: scriptImportRoute } = await import('../src/routes/scriptImport.ts')
const { default: novelsRoute } = await import('../src/routes/novels.ts')
const { default: novelJobsRoute } = await import('../src/routes/novelJobs.ts')
const { default: novelImportsRoute } = await import('../src/routes/novelImports.ts')
const { default: mcpRoute } = await import('../src/routes/mcp.ts')
const { applyMcpConfig, getMcpStatus, rotateMcpToken, setMcpMainApp } = await import('../src/services/mcp.ts')

const app = new Hono()
app.route('/api/v1/dramas', dramasRoute)
app.route('/api/v1/episodes', episodesRoute)
app.route('/api/v1/merge', mergeRoute)
app.route('/api/v1/upload', uploadRoute)
app.route('/api/v1/characters', charactersRoute)
app.route('/api/v1/scenes', scenesRoute)
app.route('/api/v1/props', propsRoute)
app.route('/api/v1', scriptImportRoute)
app.route('/api/v1/novels', novelImportsRoute)
app.route('/api/v1/novels', novelsRoute)
app.route('/api/v1/novel-jobs', novelJobsRoute)
app.route('/api/v1/mcp', mcpRoute)
setMcpMainApp(app as any)

const ts = new Date().toISOString()
await db.insert(schema.dramas).values({ title: 'MCP 测试项目', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts })
await db.insert(schema.episodes).values({ dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts })
await db.insert(schema.characters).values({
  name: '沈砚', role: '主角', description: '青衫书生', dramaId: 1, createdAt: ts, updatedAt: ts,
})
await db.insert(schema.scenes).values({
  dramaId: 1, location: '破庙', time: '夜', prompt: '雨夜破庙', createdAt: ts, updatedAt: ts,
})
await db.insert(schema.props).values({
  dramaId: 1, name: '青铜灯', description: '锈迹斑斑', createdAt: ts, updatedAt: ts,
})
await db.insert(schema.novels).values({
  title: 'MCP 小说', numberOfChapters: 2, wordNumber: 1200, status: 'draft', createdAt: ts, updatedAt: ts,
})
const chapterBody = '夜'.repeat(700)
await db.insert(schema.novelChapters).values([
  { novelId: 1, chapterNo: 1, title: '第一章 夜行', content: chapterBody, wordCount: 700, status: 'final', createdAt: ts, updatedAt: ts },
  { novelId: 1, chapterNo: 2, title: '第二章 天明', content: chapterBody, wordCount: 700, status: 'final', createdAt: ts, updatedAt: ts },
])

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

const port = await freePort()

async function rpc(body: unknown, token?: string) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

test('默认关闭：未开启时没有 token，也不监听', () => {
  const status = getMcpStatus()
  assert.equal(status.enabled, false)
  assert.equal(status.running, false)
  assert.equal(status.token, '')
  assert.ok(status.tool_count >= 15)
})

test('开启：生成 token 并监听固定端口', async () => {
  const status = await applyMcpConfig({ enabled: true, port })
  assert.equal(status.error, null)
  assert.equal(status.enabled, true)
  assert.equal(status.running, true)
  assert.equal(status.port, port)
  assert.equal(status.token.length, 48)
})

test('鉴权：无 token 返回 401', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(res.status, 401)
  assert.equal(res.json.error.code, -32001)
})

test('握手与工具列表：initialize / tools/list', async () => {
  const token = getMcpStatus().token
  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  }, token)
  assert.equal(init.status, 200)
  assert.equal(init.json.result.protocolVersion, '2025-06-18')
  assert.equal(init.json.result.serverInfo.name, 'huobao-drama')

  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, token)
  const names = list.json.result.tools.map((t: any) => t.name)
  assert.equal(names.length, getMcpStatus().tool_count)
  assert.equal(getMcpStatus().tool_count, 66)
  const expectedTools = [
    'list_projects', 'api_request', 'list_api_endpoints', 'generate_image', 'parse_script', 'import_novel_to_drama',
    'create_episode', 'update_episode', 'create_storyboard', 'update_storyboard', 'delete_storyboard',
    'list_novels', 'get_novel', 'list_novel_jobs', 'get_novel_job', 'list_novel_imports', 'get_novel_graph',
    'create_novel', 'update_novel', 'delete_novel', 'save_novel_chapter', 'delete_novel_import',
    'generate_novel_architecture', 'generate_novel_blueprint', 'generate_novel_chapter',
    'finalize_novel_chapter', 'enrich_novel_chapter', 'cancel_novel_job',
    'preview_novel_import', 'preview_novel_sync', 'sync_novel_import',
  ]
  for (const expected of expectedTools) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`)
  }
})

test('工具调用：list_projects 与 api_request', async () => {
  const token = getMcpStatus().token
  const call = await rpc({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'list_projects', arguments: {} },
  }, token)
  const payload = JSON.parse(call.json.result.content[0].text)
  assert.equal(payload.pagination.total, 1)
  assert.equal(payload.items[0].title, 'MCP 测试项目')

  const generic = await rpc({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'api_request', arguments: { method: 'GET', path: '/api/v1/dramas' } },
  }, token)
  assert.equal(generic.json.result.isError, undefined)
  const data = JSON.parse(generic.json.result.content[0].text)
  assert.equal(data.pagination.total, 1)
})

test('剧集工具：list_episodes / get_episode / get_merge_status 路径正确', async () => {
  const token = getMcpStatus().token
  const call = (name: string, args: any, id: number) => rpc({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  }, token)

  const list = await call('list_episodes', { drama_id: 1 }, 21)
  const listData = JSON.parse(list.json.result.content[0].text)
  assert.equal(list.json.result.isError, undefined)
  assert.equal(listData.length, 1)
  assert.equal(listData[0].title, '第1集')

  const one = await call('get_episode', { episode_id: 1 }, 22)
  assert.equal(one.json.result.isError, undefined)
  assert.equal(JSON.parse(one.json.result.content[0].text).title, '第1集')

  const merge = await call('get_merge_status', { episode_id: 1 }, 23)
  assert.equal(merge.json.result.isError, undefined)
  assert.equal(JSON.parse(merge.json.result.content[0].text), null)
})

test('剧本导入工具：parse_script 返回章节与拆集预览', async () => {
  const token = getMcpStatus().token
  const body = '天'.repeat(700)
  const text = `第一章 开端\n${body}\n\n第二章 转折\n${body}`
  const res = await rpc({
    jsonrpc: '2.0', id: 24, method: 'tools/call',
    params: { name: 'parse_script', arguments: { drama_id: 1, text, filename: 'novel.txt' } },
  }, token)
  assert.equal(res.json.result.isError, undefined, res.json.result.content?.[0]?.text)
  const data = JSON.parse(res.json.result.content[0].text)
  assert.equal(data.chapter_count, 2)
  assert.equal(data.chapters[0].title, '第一章 开端')
  assert.ok(data.episode_count >= 2)
})

test('小说导入工具：import_novel_to_drama 建剧并支持章节范围与幂等', async () => {
  const token = getMcpStatus().token
  const call = (args: any, id: number) => rpc({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'import_novel_to_drama', arguments: args },
  }, token)

  const first = await call({
    novel_id: 1,
    title: 'MCP 改编短剧',
    aspect_ratio: '9:16',
    target_words: 1200,
    chapter_range: '2',
    request_id: 'mcp-import-1',
  }, 25)
  assert.equal(first.json.result.isError, undefined, first.json.result.content?.[0]?.text)
  const data = JSON.parse(first.json.result.content[0].text)
  assert.equal(data.existing, false)
  assert.ok(data.drama_id > 0)
  assert.equal(data.episode_count, 1)

  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, data.drama_id)).get()
  assert.equal(drama?.title, 'MCP 改编短剧')
  assert.equal(drama?.aspectRatio, '9:16')
  assert.equal(drama?.sourceNovelId, 1)
  const episodes = db.select().from(schema.episodes).where(eq(schema.episodes.dramaId, data.drama_id)).all()
  assert.equal(episodes.length, 1)
  assert.equal(episodes[0].sourceChapterNo, 2)

  const again = await call({
    novel_id: 1,
    chapter_range: '1-2',
    request_id: 'mcp-import-1',
  }, 26)
  assert.equal(again.json.result.isError, undefined, again.json.result.content?.[0]?.text)
  const replay = JSON.parse(again.json.result.content[0].text)
  assert.equal(replay.existing, true)
  assert.equal(replay.drama_id, data.drama_id)

  const badRange = await call({ novel_id: 1, chapter_range: 'abc' }, 27)
  assert.equal(badRange.json.result.isError, true)
})

test('小说工具：列表/详情/创建/更新/软删与章节保存', async () => {
  const token = getMcpStatus().token
  const call = (name: string, args: any, id: number) => rpc({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  }, token)
  const dataOf = (res: any) => JSON.parse(res.json.result.content[0].text)

  const list = await call('list_novels', { keyword: 'MCP' }, 51)
  assert.equal(list.json.result.isError, undefined, list.json.result.content?.[0]?.text)
  const listData = dataOf(list)
  assert.equal(listData.pagination.total, 1)
  assert.equal(listData.items[0].title, 'MCP 小说')

  const detail = await call('get_novel', { novel_id: 1 }, 52)
  const detailData = dataOf(detail)
  assert.equal(detailData.chapters.length, 2)
  assert.equal(detailData.chapters[0].content, chapterBody)
  assert.ok(Array.isArray(detailData.imports))

  const created = await call('create_novel', {
    title: 'MCP 新建小说', genre: ['悬疑', '推理'], number_of_chapters: 3, word_number: 1500, topic: '旧宅',
  }, 53)
  assert.equal(created.json.result.isError, undefined, created.json.result.content?.[0]?.text)
  const createdData = dataOf(created)
  assert.equal(createdData.title, 'MCP 新建小说')
  assert.deepEqual(createdData.genre, ['悬疑', '推理'])
  assert.equal(createdData.number_of_chapters, 3)

  const updated = await call('update_novel', {
    novel_id: createdData.id, title: 'MCP 改名', topic: '新主题', architecture_generated: true,
  }, 54)
  assert.equal(updated.json.result.isError, undefined, updated.json.result.content?.[0]?.text)
  const updatedData = dataOf(updated)
  assert.equal(updatedData.title, 'MCP 改名')
  assert.equal(updatedData.topic, '新主题')
  assert.equal(updatedData.architecture_generated, true)

  const removed = await call('delete_novel', { novel_id: createdData.id }, 55)
  assert.equal(dataOf(removed).deleted, true)
  const gone = await call('get_novel', { novel_id: createdData.id }, 56)
  assert.equal(gone.json.result.isError, true)
  assert.match(gone.json.result.content[0].text, /HTTP 404/)

  const base = detailData.chapters[0].updated_at
  const saved = await call('save_novel_chapter', {
    novel_id: 1, chapter_no: 1, title: '第一章 改', content: '新正文'.repeat(100), status: 'draft', base_updated_at: base,
  }, 57)
  assert.equal(saved.json.result.isError, undefined, saved.json.result.content?.[0]?.text)
  const savedData = dataOf(saved)
  assert.equal(savedData.title, '第一章 改')
  assert.equal(savedData.status, 'draft')

  const conflict = await call('save_novel_chapter', {
    novel_id: 1, chapter_no: 1, content: '冲突正文', base_updated_at: base,
  }, 58)
  assert.equal(conflict.json.result.isError, true)
  assert.match(conflict.json.result.content[0].text, /HTTP 409/)
})

test('小说任务工具：列表/详情/取消', async () => {
  const token = getMcpStatus().token
  const call = (name: string, args: any, id: number) => rpc({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  }, token)
  const inserted = db.insert(schema.novelJobs).values({
    novelId: 1, type: 'chapter', chapterNo: 1, status: 'running', progress: 0, total: 0,
    createdAt: ts, startedAt: ts,
  }).run()
  const jobId = Number(inserted.lastInsertRowid)

  const list = await call('list_novel_jobs', { novel_id: 1, status: 'running' }, 59)
  const listData = JSON.parse(list.json.result.content[0].text)
  assert.ok(listData.items.some((item: any) => item.id === jobId))

  const one = await call('get_novel_job', { job_id: jobId }, 60)
  const oneData = JSON.parse(one.json.result.content[0].text)
  assert.equal(oneData.id, jobId)
  assert.equal(oneData.status, 'running')

  const cancelled = await call('cancel_novel_job', { job_id: jobId }, 61)
  const cancelledData = JSON.parse(cancelled.json.result.content[0].text)
  assert.equal(cancelledData.cancelled, true)
  assert.equal(cancelledData.job.status, 'cancelled')
})

test('小说导入/同步工具：预览、同步与删映射', async () => {
  const token = getMcpStatus().token
  const call = (name: string, args: any, id: number) => rpc({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  }, token)

  const preview = await call('preview_novel_import', { novel_id: 1, chapter_nos: [1], target_words: 1200 }, 62)
  assert.equal(preview.json.result.isError, undefined, preview.json.result.content?.[0]?.text)
  const previewData = JSON.parse(preview.json.result.content[0].text)
  assert.equal(previewData.chapter_count, 1)
  assert.equal(previewData.episode_count, 1)

  const graph = await call('get_novel_graph', { novel_id: 1 }, 63)
  assert.equal(graph.json.result.isError, undefined, graph.json.result.content?.[0]?.text)
  const graphData = JSON.parse(graph.json.result.content[0].text)
  assert.ok(Object.prototype.hasOwnProperty.call(graphData, 'graph_data'))
  assert.ok(Object.prototype.hasOwnProperty.call(graphData, 'chapter_graphs'))

  const importRow = db.select().from(schema.novelImports).where(eq(schema.novelImports.novelId, 1)).get()
  assert.ok(importRow)
  const imports = await call('list_novel_imports', { novel_id: 1 }, 64)
  const importsData = JSON.parse(imports.json.result.content[0].text)
  assert.ok(importsData.items.some((item: any) => item.import_id === importRow!.id))

  const before = await call('preview_novel_sync', { novel_id: 1, import_id: importRow!.id }, 65)
  assert.equal(before.json.result.isError, undefined, before.json.result.content?.[0]?.text)
  assert.equal(JSON.parse(before.json.result.content[0].text).counts.updated, 0)

  const detail = await call('get_novel', { novel_id: 1 }, 66)
  const chapter2 = JSON.parse(detail.json.result.content[0].text).chapters.find((row: any) => row.chapter_no === 2)
  const newContent = '改'.repeat(800)
  const saved = await call('save_novel_chapter', {
    novel_id: 1, chapter_no: 2, content: newContent, base_updated_at: chapter2.updated_at,
  }, 67)
  assert.equal(saved.json.result.isError, undefined, saved.json.result.content?.[0]?.text)

  const after = await call('preview_novel_sync', { novel_id: 1, import_id: importRow!.id }, 68)
  const afterData = JSON.parse(after.json.result.content[0].text)
  assert.equal(afterData.counts.updated, 1)

  const applied = await call('sync_novel_import', { novel_id: 1, import_id: importRow!.id }, 69)
  assert.equal(applied.json.result.isError, undefined, applied.json.result.content?.[0]?.text)
  const appliedData = JSON.parse(applied.json.result.content[0].text)
  assert.equal(appliedData.updated, 1)

  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.dramaId, importRow!.dramaId)).all()
    .find(row => row.sourceChapterNo === 2)
  assert.equal(episode?.content, newContent)

  const removed = await call('delete_novel_import', { novel_id: 1, import_id: importRow!.id }, 70)
  assert.equal(JSON.parse(removed.json.result.content[0].text).deleted, true)
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, importRow!.dramaId)).get()
  assert.equal(drama?.sourceNovelId, null)
})

test('小说生成工具：错误透传（小说不存在）', async () => {
  const token = getMcpStatus().token
  const call = (name: string, args: any, id: number) => rpc({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  }, token)
  const cases: [string, any][] = [
    ['generate_novel_architecture', { novel_id: 999 }],
    ['generate_novel_blueprint', { novel_id: 999 }],
    ['generate_novel_chapter', { novel_id: 999, chapter_no: 1 }],
    ['finalize_novel_chapter', { novel_id: 999, chapter_no: 1 }],
    ['enrich_novel_chapter', { novel_id: 999, chapter_no: 1 }],
  ]
  for (let i = 0; i < cases.length; i++) {
    const res = await call(cases[i][0], cases[i][1], 71 + i)
    assert.equal(res.json.result.isError, true, cases[i][0])
    assert.match(res.json.result.content[0].text, /小说不存在/, cases[i][0])
  }
})

test('上传工具：base64 图片落项目目录，空内容被拒', async () => {
  const token = getMcpStatus().token
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const ok = await rpc({
    jsonrpc: '2.0', id: 31, method: 'tools/call',
    params: { name: 'upload_image', arguments: { data_base64: `data:image/png;base64,${png}`, filename: 'ref.png', drama_id: 1 } },
  }, token)
  assert.equal(ok.json.result.isError, undefined)
  const data = JSON.parse(ok.json.result.content[0].text)
  assert.match(data.path, /^static\/projects\/1\/uploads\/[0-9a-f-]+\.png$/)
  assert.ok((await fs.stat(path.join(root, data.path))).size > 0)

  const bad = await rpc({
    jsonrpc: '2.0', id: 32, method: 'tools/call',
    params: { name: 'upload_image', arguments: { data_base64: '   ' } },
  }, token)
  assert.equal(bad.json.result.isError, true)
  assert.match(bad.json.result.content[0].text, /data_base64/)

  // 文件名没写扩展名时按媒体类型补齐，避免存成 .bin（浏览器与视觉模型都识别不了）
  const noExt = await rpc({
    jsonrpc: '2.0', id: 33, method: 'tools/call',
    params: { name: 'upload_image', arguments: { data_base64: png, filename: 'face', drama_id: 1 } },
  }, token)
  assert.equal(noExt.json.result.isError, undefined)
  assert.match(JSON.parse(noExt.json.result.content[0].text).path, /\.png$/)

  const wrongExt = await rpc({
    jsonrpc: '2.0', id: 34, method: 'tools/call',
    params: { name: 'upload_image', arguments: { data_base64: png, filename: 'face.bin', drama_id: 1 } },
  }, token)
  assert.match(JSON.parse(wrongExt.json.result.content[0].text).path, /\.png$/)
})

test('set_asset_image：上传即绑定角色成图，可直接用已上传路径绑场景/道具', async () => {
  const token = getMcpStatus().token
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const call = (name: string, args: any, id: number) => rpc({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  }, token)

  const character = await call('set_asset_image', {
    asset_type: 'character', asset_id: 1, data_base64: `data:image/png;base64,${png}`, filename: 'face.png', also_reference: true,
  }, 41)
  assert.equal(character.json.result.isError, undefined, character.json.result.content?.[0]?.text)
  const charData = JSON.parse(character.json.result.content[0].text)
  assert.match(charData.image_url, /^static\/projects\/1\/uploads\/[0-9a-f-]+\.png$/)
  assert.equal(charData.uploaded, true)
  assert.deepEqual(charData.reference_images, [charData.image_url])
  const charRow = db.select().from(schema.characters).where(eq(schema.characters.id, 1)).get()!
  assert.equal(charRow.imageUrl, charData.image_url)
  assert.equal(charRow.localPath, charData.image_url)
  assert.equal(JSON.parse(charRow.referenceImages!)[0], charData.image_url)

  // 场景：直接用刚上传的路径绑定，并置为 completed
  const scene = await call('set_asset_image', { asset_type: '场景', asset_id: 1, path: `/${charData.image_url}` }, 42)
  assert.equal(scene.json.result.isError, undefined, scene.json.result.content?.[0]?.text)
  const sceneRow = db.select().from(schema.scenes).where(eq(schema.scenes.id, 1)).get()!
  assert.equal(sceneRow.imageUrl, charData.image_url)
  assert.equal(sceneRow.status, 'completed')
  assert.equal(JSON.parse(scene.json.result.content[0].text).url, `/${charData.image_url}`)

  // 道具：http 外链原样存
  const prop = await call('set_asset_image', { asset_type: 'prop', asset_id: 1, path: 'https://example.com/prop.png' }, 43)
  assert.equal(prop.json.result.isError, undefined, prop.json.result.content?.[0]?.text)
  assert.equal(db.select().from(schema.props).where(eq(schema.props.id, 1)).get()!.imageUrl, 'https://example.com/prop.png')

  // 边界：非法类型、不存在的资产、路径不合法、两个来源都没传
  const badType = await call('set_asset_image', { asset_type: 'actor', asset_id: 1 }, 44)
  assert.equal(badType.json.result.isError, true)
  assert.match(badType.json.result.content[0].text, /character \/ scene \/ prop/)

  const missing = await call('set_asset_image', { asset_type: 'scene', asset_id: 999, data_base64: png }, 45)
  assert.equal(missing.json.result.isError, true)
  assert.match(missing.json.result.content[0].text, /不存在/)

  const badPath = await call('set_asset_image', { asset_type: 'character', asset_id: 1, path: '/etc/passwd' }, 46)
  assert.equal(badPath.json.result.isError, true)
  assert.match(badPath.json.result.content[0].text, /static\//)

  const empty = await call('set_asset_image', { asset_type: 'character', asset_id: 1 }, 47)
  assert.equal(empty.json.result.isError, true)
  assert.match(empty.json.result.content[0].text, /至少传一个/)
})

test('边界：非法 path 与未知工具都被拒绝', async () => {
  const token = getMcpStatus().token
  const badPath = await rpc({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'api_request', arguments: { method: 'GET', path: '/etc/passwd' } },
  }, token)
  assert.equal(badPath.json.result.isError, true)
  assert.match(badPath.json.result.content[0].text, /\/api\/v1\//)

  const unknown = await rpc({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'not_exists', arguments: {} },
  }, token)
  assert.equal(unknown.json.error.code, -32602)

  // MCP 自身配置不能被模型经 api_request 改掉（否则可能把自己关停/换 token）
  const selfConfig = await rpc({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: { name: 'api_request', arguments: { method: 'PUT', path: '/api/v1/mcp', body: { enabled: false } } },
  }, token)
  assert.equal(selfConfig.json.result.isError, true)
  assert.match(selfConfig.json.result.content[0].text, /设置页/)
})

test('token 轮换：旧 token 立即失效', async () => {
  const oldToken = getMcpStatus().token
  const newToken = rotateMcpToken()
  assert.notEqual(oldToken, newToken)

  const withOld = await rpc({ jsonrpc: '2.0', id: 7, method: 'ping' }, oldToken)
  assert.equal(withOld.status, 401)

  const withNew = await rpc({ jsonrpc: '2.0', id: 8, method: 'ping' }, newToken)
  assert.equal(withNew.status, 200)
  assert.deepEqual(withNew.json.result, {})
})

test('关闭：端口释放', async () => {
  const status = await applyMcpConfig({ enabled: false })
  assert.equal(status.enabled, false)
  assert.equal(status.running, false)
  const alive = await fetch(`http://127.0.0.1:${port}/mcp`).then(() => true).catch(() => false)
  assert.equal(alive, false)
})

after(async () => {
  await applyMcpConfig({ enabled: false }).catch(() => {})
  await fs.rm(root, { recursive: true, force: true })
})
