/**
 * A4-1 诊断：工具清单、路由模拟、模型可用性、只读试跑、写/未知/越界 400、错误脱敏。
 * 隔离 SQLite；断言试跑前后业务表与智能体表行数不变。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-diagnostics-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'storage')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { Hono } = await import('hono')
const assistantRoute = (await import('../src/routes/assistant.ts')).default
const { db, schema } = await import('../src/db/index.ts')
const {
  checkModels,
  listTools,
  recentErrors,
  recordDiagnosticError,
  resetDiagnosticErrorsForTest,
  runReadTool,
  simulateRoute,
} = await import('../src/services/agent-diagnostics.ts')
const { setDirectorSettings } = await import('../src/services/app-settings.ts')

const app = new Hono()
app.route('/assistant', assistantRoute)

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const ts = '2026-11-07T00:00:00.000Z'
const novel = db.insert(schema.novels).values({
  title: '诊断小说',
  numberOfChapters: 1,
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
db.insert(schema.novelChapters).values({
  novelId: novel.id,
  chapterNo: 1,
  title: '第1章',
  content: '诊断正文',
  createdAt: ts,
  updatedAt: ts,
}).run()
const drama = db.insert(schema.dramas).values({
  title: '诊断项目',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 1,
  title: '第1集',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()
db.insert(schema.aiServiceConfigs).values({
  serviceType: 'text',
  provider: 'openai',
  name: '主文本',
  baseUrl: 'https://api.secret.example/v1',
  apiKey: 'sk-diagnostic-secret-123456',
  model: JSON.stringify(['diagnostic-model']),
  priority: 10,
  isActive: true,
  createdAt: ts,
  updatedAt: ts,
}).run()

function tableCounts() {
  return {
    novels: db.select().from(schema.novels).all().length,
    chapters: db.select().from(schema.novelChapters).all().length,
    dramas: db.select().from(schema.dramas).all().length,
    episodes: db.select().from(schema.episodes).all().length,
    sessions: db.select().from(schema.agentSessions).all().length,
    messages: db.select().from(schema.agentMessages).all().length,
    proposals: db.select().from(schema.agentProposals).all().length,
  }
}

async function postJson(url: string, body: Record<string, unknown>) {
  const response = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as any }
}

async function getJson(url: string) {
  const response = await app.request(url)
  return { status: response.status, body: await response.json() as any }
}

test('工具清单区分只读与动作工具，并覆盖九个作用域', () => {
  const result = listTools()
  assert.ok(result.read_only_count >= 21)
  const names = result.tools.map(tool => tool.name)
  for (const name of [
    'read_novel_context', 'read_storyboards', 'read_edit_state', 'read_mix_tracks',
    'read_export_history', 'read_project_list', 'read_project_overview', 'read_script',
    'read_dubbing_status', 'read_delivery_status',
  ]) {
    assert.ok(names.includes(name), `缺少 ${name}`)
  }
  const proposals = result.tools.find(tool => tool.name === 'propose_change')
  assert.equal(proposals?.read_only, false)
  assert.deepEqual(result.scope_matrix['home'], ['read_project_list'])
  assert.ok(result.scope_matrix.drama.includes('read_project_overview'))
  assert.ok(result.scope_matrix.drama.includes('read_assets'))
  assert.ok(result.scope_matrix.drama.includes('read_delivery_status'))
  assert.ok(result.scope_matrix.novel.includes('read_novel_context'))
  assert.ok(result.scope_matrix.episode.includes('read_script'))
  assert.ok(result.scope_matrix.episode.includes('read_dubbing_status'))
  assert.ok(result.scope_matrix.director.includes('read_director_plan'))
  assert.ok(result.scope_matrix.director.includes('read_assets'))
  assert.ok(result.scope_matrix.edit.includes('read_edit_state'))
  assert.ok(result.scope_matrix.edit.includes('read_storyboards'))
  assert.ok(result.scope_matrix.mix.includes('read_mix_state'))
  assert.ok(result.scope_matrix.delivery.includes('read_delivery_status'))
  assert.equal(result.policies.retention_days, 30)
})

test('路由模拟返回适配器、作用域与允许工具', () => {
  const novelRoute = simulateRoute(`/novels/${novel.id}`)
  assert.equal(novelRoute.matched, true)
  assert.equal(novelRoute.adapter_id, 'novel-detail')
  assert.equal(novelRoute.scope?.kind, 'novel')
  assert.equal(novelRoute.scope?.novel_id, novel.id)
  assert.equal(novelRoute.scope_valid, true)
  assert.ok(novelRoute.tools.includes('read_novel_context'))

  const episodeRoute = simulateRoute(`/drama/${drama.id}/episode/1`)
  assert.equal(episodeRoute.scope?.kind, 'episode')
  assert.equal(episodeRoute.scope?.stage, 'script')
  assert.equal(episodeRoute.scope?.episode_id, episode.id)

  const mixRoute = simulateRoute(`/drama/${drama.id}/episode/1?panel=dubbing&step=3`)
  assert.equal(mixRoute.scope?.kind, 'mix')
  assert.equal(mixRoute.binding_stage, 'mix')
  assert.ok(mixRoute.tools.includes('read_mix_state'))

  const deliveryRoute = simulateRoute(`/drama/${drama.id}/episode/1?panel=dubbing&step=4`)
  assert.equal(deliveryRoute.scope?.kind, 'delivery')
  assert.ok(deliveryRoute.tools.includes('read_export_history'))

  const editRoute = simulateRoute(`/drama/${drama.id}/episode/1/edit?project_id=9`)
  assert.equal(editRoute.adapter_id, 'drama-edit')
  assert.equal(editRoute.scope?.kind, 'edit')
  assert.equal(editRoute.scope?.edit_project_id, 9)
  assert.equal(editRoute.scope_valid, true)

  const missing = simulateRoute('/settings')
  assert.equal(missing.matched, false)
  assert.equal(missing.adapter_id, null)
  assert.equal(missing.visible, false)
})

test('路由模拟按导演模式解析导演作用域', () => {
  setDirectorSettings({ mode: 'on' })
  try {
    const directorRoute = simulateRoute(`/drama/${drama.id}/episode/1?panel=director`)
    assert.equal(directorRoute.scope?.kind, 'director')
    assert.ok(directorRoute.tools.includes('read_director_plan'))
  } finally {
    setDirectorSettings({ mode: 'off' })
  }
  const fallback = simulateRoute(`/drama/${drama.id}/episode/1?panel=director`)
  assert.equal(fallback.scope?.kind, 'episode')
})

test('非法路由返回 400', () => {
  assert.throws(() => simulateRoute('novels'), /页面路由必须/)
  assert.throws(() => simulateRoute(''), /页面路由不能为空/)
})

test('模型可用性只暴露 ID/供应商/模型，不泄露地址与密钥', () => {
  const result = checkModels()
  assert.equal(result.available, true)
  const text = JSON.stringify(result)
  assert.ok(text.includes('diagnostic-model'))
  assert.ok(!text.includes('sk-diagnostic-secret'))
  assert.ok(!text.includes('api.secret.example'))
})

test('只读试跑成功且不改任何表', async () => {
  const before = tableCounts()
  const result = await runReadTool({
    tool: 'read_novel_context',
    args: {},
    scope: { workspace_key: `novel:${novel.id}`, kind: 'novel', novel_id: novel.id },
  })
  assert.equal(result.tool, 'read_novel_context')
  assert.equal(result.truncated, false)
  const payload = result.result as Record<string, any>
  assert.equal(payload.novel.title, '诊断小说')
  assert.deepEqual(tableCounts(), before)
})

test('写工具、未知工具、作用域不匹配与参数越界均 400 且不执行', async () => {
  const before = tableCounts()
  await assert.rejects(
    () => runReadTool({
      tool: 'propose_change',
      args: {},
      scope: { workspace_key: `novel:${novel.id}`, kind: 'novel', novel_id: novel.id },
    }),
    (error: any) => error?.status === 400 && error?.code === 'AGENT_DIAGNOSTIC_WRITE_TOOL',
  )
  await assert.rejects(
    () => runReadTool({
      tool: 'not_a_tool',
      args: {},
      scope: { workspace_key: `novel:${novel.id}`, kind: 'novel', novel_id: novel.id },
    }),
    (error: any) => error?.status === 400 && error?.code === 'AGENT_DIAGNOSTIC_UNKNOWN_TOOL',
  )
  await assert.rejects(
    () => runReadTool({
      tool: 'read_novel_context',
      args: {},
      scope: { workspace_key: 'novel-library', kind: 'novel-library' },
    }),
    (error: any) => error?.status === 400 && error?.code === 'AGENT_DIAGNOSTIC_SCOPE_MISMATCH',
  )
  await assert.rejects(
    () => runReadTool({
      tool: 'read_novel_chapter_content',
      args: { chapter_no: 0 },
      scope: { workspace_key: `novel:${novel.id}`, kind: 'novel', novel_id: novel.id },
    }),
    (error: any) => error?.status === 400 && error?.code === 'AGENT_DIAGNOSTIC_ARGS_INVALID',
  )
  assert.deepEqual(tableCounts(), before)
})

test('最近错误脱敏，不含密钥、Authorization、baseURL 与绝对路径', () => {
  resetDiagnosticErrorsForTest()
  recordDiagnosticError('test', new Error(
    'Authorization: Bearer sk-leak-123456789 https://api.secret.example/v1 /Users/demo/private/file.txt',
  ))
  const result = recentErrors()
  const text = JSON.stringify(result)
  assert.ok(!text.includes('sk-leak'))
  assert.ok(!text.includes('api.secret.example'))
  assert.ok(!text.includes('/Users/demo'))
  assert.ok(result.items.length >= 1)
})

test('GET /diagnostics 返回清单/模型/错误/路由模拟', async () => {
  const { status, body } = await getJson(`/assistant/diagnostics?route=/novels/${novel.id}`)
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.data.tools.tools))
  assert.equal(body.data.models.available, true)
  assert.equal(body.data.route.adapter_id, 'novel-detail')
  const text = JSON.stringify(body)
  assert.ok(!text.includes('sk-diagnostic-secret'))
  assert.ok(!text.includes('api.secret.example'))
})

test('POST /diagnostics/tool 只读成功，写工具 400', async () => {
  const ok = await postJson('/assistant/diagnostics/tool', {
    tool: 'read_novel_context',
    args: {},
    scope: { workspace_key: `novel:${novel.id}`, kind: 'novel', novel_id: novel.id },
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.data.result.novel.title, '诊断小说')

  const denied = await postJson('/assistant/diagnostics/tool', {
    tool: 'propose_change',
    args: {},
    scope: { workspace_key: `novel:${novel.id}`, kind: 'novel', novel_id: novel.id },
  })
  assert.equal(denied.status, 400)
  assert.equal(denied.body.error_code, 'AGENT_DIAGNOSTIC_WRITE_TOOL')
})
