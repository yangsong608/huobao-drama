import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { getTableColumns } from 'drizzle-orm'
import { initSqliteSchema } from '../src/db/sqlite-schema.ts'
import { breakdownMethods, episodes } from '../src/db/schema.ts'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-breakdown-service-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db } = await import('../src/db/index.ts')
const svc = await import('../src/services/breakdown-methods.ts')
const agents = await import('../src/agents/index.ts')
const breakdownRoutes = await import('../src/routes/breakdownMethods.ts')
const episodeRoutes = await import('../src/routes/episodes.ts')
const { Hono } = await import('hono')

const api = new Hono()
api.route('/breakdown-methods', breakdownRoutes.default)
api.route('/episodes', episodeRoutes.default)

async function readJson(res: Response) {
  return await res.json() as any
}

function sendJson(path: string, method: string, body: unknown) {
  return api.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
after(() => {
  try { (db as any).$client?.close() } catch {}
  fs.rmSync(serviceRoot, { recursive: true, force: true })
})

const ts = '2026-01-01T00:00:00.000Z'
let epSeq = 0
function newEpisode(method?: string | null) {
  const row = db.insert(episodes).values({
    dramaId: 1,
    episodeNumber: ++epSeq,
    title: `第${epSeq}集`,
    breakdownMethod: method ?? null,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  return row.id
}


function tempDatabase(): { sqlite: Database.Database; close: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-breakdown-methods-'))
  const sqlite = new Database(path.join(root, 'test.sqlite3'))
  return {
    sqlite,
    close: () => {
      sqlite.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function columns(sqlite: Database.Database, table: string) {
  return new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  )
}

test('新库包含 breakdown_methods 表与 episodes.breakdown_method 列', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)

    const table = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'breakdown_methods'")
      .get()
    assert.ok(table, '缺少 breakdown_methods 表')

    for (const name of [
      'id', 'key', 'name', 'description', 'prompt', 'skill',
      'builtin', 'sort_order', 'created_at', 'updated_at',
    ]) {
      assert.ok(columns(sqlite, 'breakdown_methods').has(name), `breakdown_methods 缺少 ${name}`)
    }
    assert.ok(columns(sqlite, 'episodes').has('breakdown_method'), 'episodes 缺少 breakdown_method')
  } finally {
    close()
  }
})

test('breakdown_methods.key 唯一且默认值符合契约', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.prepare(
      "INSERT INTO breakdown_methods (key, name, created_at, updated_at) VALUES ('standard', '标准', 'x', 'x')",
    ).run()
    assert.throws(
      () => sqlite.prepare(
        "INSERT INTO breakdown_methods (key, name, created_at, updated_at) VALUES ('standard', '重复', 'x', 'x')",
      ).run(),
      /UNIQUE/,
    )
    const row = sqlite.prepare(
      "SELECT description, prompt, skill, builtin, sort_order FROM breakdown_methods WHERE key = 'standard'",
    ).get() as { description: string; prompt: string; skill: string; builtin: number; sort_order: number }
    assert.equal(row.description, '')
    assert.equal(row.prompt, '')
    assert.equal(row.skill, '')
    assert.equal(row.builtin, 0)
    assert.equal(row.sort_order, 0)
  } finally {
    close()
  }
})

test('旧库补齐 episodes.breakdown_method 且保留历史行', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.exec('ALTER TABLE episodes DROP COLUMN breakdown_method')
    assert.ok(!columns(sqlite, 'episodes').has('breakdown_method'))
    sqlite.prepare(
      "INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, '历史集', 'x', 'x')",
    ).run()

    initSqliteSchema(sqlite)

    assert.ok(columns(sqlite, 'episodes').has('breakdown_method'))
    const row = sqlite.prepare('SELECT title, breakdown_method FROM episodes WHERE id = 1').get() as {
      title: string
      breakdown_method: string | null
    }
    assert.equal(row.title, '历史集')
    assert.equal(row.breakdown_method, null)
  } finally {
    close()
  }
})

test('重复初始化保持幂等，不重复建表', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    initSqliteSchema(sqlite)
    const count = sqlite.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'breakdown_methods'",
    ).get() as { n: number }
    assert.equal(count.n, 1)
  } finally {
    close()
  }
})

test('Drizzle breakdownMethods 与 episodes 定义包含契约字段', () => {
  const methodColumns = getTableColumns(breakdownMethods)
  for (const name of [
    'id', 'key', 'name', 'description', 'prompt', 'skill',
    'builtin', 'sortOrder', 'createdAt', 'updatedAt',
  ]) {
    assert.ok(name in methodColumns, `Drizzle breakdownMethods 缺少 ${name}`)
  }
  const episodeColumns = getTableColumns(episodes)
  assert.ok('breakdownMethod' in episodeColumns, 'Drizzle episodes 缺少 breakdownMethod')
})

test('首次播种补齐五条内置方案，重复播种不覆盖编辑', async () => {
  await svc.ensureBreakdownMethodsSeeded()
  const list = svc.listBreakdownMethods()
  assert.deepEqual(list.map(item => item.key), [
    'standard', 'hook-beat', 'director-board', 'h3-compact', 'trailer-cut',
  ])
  assert.ok(list.every(item => item.builtin === 1))

  db.update(breakdownMethods).set({ name: '改过的钩子' }).where(eq(breakdownMethods.key, 'hook-beat')).run()
  await svc.ensureBreakdownMethodsSeeded()
  assert.equal(svc.getBreakdownMethod('hook-beat')?.name, '改过的钩子')

  svc.resetBreakdownMethod('hook-beat')
  assert.equal(svc.getBreakdownMethod('hook-beat')?.name, '爆款钩子节拍')
})

test('内置方案文本符合内容要求，standard 两段为空', () => {
  const standard = svc.getBreakdownMethod('standard')!
  assert.equal(standard.prompt.trim(), '')
  assert.equal(standard.skill.trim(), '')

  const expected: Record<string, { prompt: string; skill: string }> = {
    'hook-beat': { prompt: '钩子', skill: '开场' },
    'director-board': { prompt: '机位', skill: '景别' },
    'h3-compact': { prompt: 'H3', skill: '24 字' },
    'trailer-cut': { prompt: '冲击', skill: '动作切点' },
  }
  for (const [key, words] of Object.entries(expected)) {
    const method = svc.getBreakdownMethod(key)!
    assert.ok(method.prompt.includes(words.prompt), `${key} prompt 缺少 ${words.prompt}`)
    assert.ok(method.skill.includes(words.skill), `${key} skill 缺少 ${words.skill}`)
    assert.ok(method.description.trim().length > 0, `${key} 缺少说明`)
  }
})

test('创建、更新、复制方案并保持字段契约', () => {
  const created = svc.createBreakdownMethod({
    name: '  测试方案  ',
    description: ' 测试说明 ',
    prompt: '提示词正文',
    skill: 'Skill 正文',
  })
  assert.match(created.key, /^custom-/)
  assert.equal(created.name, '测试方案')
  assert.equal(created.description, '测试说明')
  assert.equal(created.builtin, 0)
  assert.ok(created.sortOrder > 50)

  const updated = svc.updateBreakdownMethod(created.key, { name: '测试方案二' })
  assert.equal(updated.name, '测试方案二')
  assert.equal(updated.prompt, '提示词正文')

  const source = svc.getBreakdownMethod('hook-beat')!
  const copy = svc.duplicateBreakdownMethod('hook-beat')
  assert.match(copy.key, /^custom-/)
  assert.equal(copy.name, `${source.name} 副本`)
  assert.equal(copy.prompt, source.prompt)
  assert.equal(copy.skill, source.skill)
  assert.equal(copy.builtin, 0)

  svc.deleteBreakdownMethod(created.key)
  svc.deleteBreakdownMethod(copy.key)
  assert.equal(svc.getBreakdownMethod(created.key), null)
})

test('内置方案不可删除，自定义删除后释放引用剧集', () => {
  const custom = svc.createBreakdownMethod({ name: '待删除方案' })
  const first = newEpisode(custom.key)
  const second = newEpisode(custom.key)
  assert.throws(() => svc.deleteBreakdownMethod('standard'), /内置/)

  const result = svc.deleteBreakdownMethod(custom.key)
  assert.equal(result.releasedEpisodes, 2)
  const rows = db.select().from(episodes).all().filter(row => row.id === first || row.id === second)
  assert.deepEqual(rows.map(row => row.breakdownMethod), [null, null])
})

test('使用计数只统计未删除剧集', () => {
  const custom = svc.createBreakdownMethod({ name: '计数方案' })
  newEpisode(custom.key)
  newEpisode(custom.key)
  const deleted = newEpisode(custom.key)
  db.update(episodes).set({ deletedAt: ts }).where(eq(episodes.id, deleted)).run()
  const item = svc.listBreakdownMethods().find(row => row.key === custom.key)!
  assert.equal(item.usageCount, 2)
  svc.deleteBreakdownMethod(custom.key)
})

test('方案块：未编辑 standard 为空，自定义块含标题、优先声明与两段正文', () => {
  const standardEp = newEpisode('standard')
  assert.equal(svc.getEpisodeBreakdownBlock(standardEp), null)

  const custom = svc.createBreakdownMethod({
    name: '自定义方案',
    prompt: '自定义提示词',
    skill: '自定义 Skill 正文',
  })
  const ep = newEpisode(custom.key)
  const block = svc.getEpisodeBreakdownBlock(ep)!
  assert.ok(block.includes('## 当前分镜拆分方案：自定义方案'))
  assert.ok(block.includes('以本方案为准'))
  assert.ok(block.includes('### 方案提示词\n自定义提示词'))
  assert.ok(block.includes('### 方案 Skill\n自定义 Skill 正文'))

  db.update(breakdownMethods).set({ skill: '' }).where(eq(breakdownMethods.key, custom.key)).run()
  const promptOnly = svc.getEpisodeBreakdownBlock(ep)!
  assert.ok(promptOnly.includes('### 方案提示词'))
  assert.ok(!promptOnly.includes('### 方案 Skill'))

  assert.equal(svc.getEpisodeBreakdownBlock(undefined), null)
  assert.equal(svc.getEpisodeBreakdownBlock(999999), null)
  svc.deleteBreakdownMethod(custom.key)
})

test('按集读取：编辑后的 standard 会注入，未知 key 回退为空', () => {
  const standard = svc.getBreakdownMethod('standard')!
  db.update(breakdownMethods).set({ prompt: '标准补充规则' }).where(eq(breakdownMethods.key, 'standard')).run()
  const ep = newEpisode('standard')
  assert.ok(svc.getEpisodeBreakdownBlock(ep)!.includes('标准补充规则'))
  svc.resetBreakdownMethod('standard')
  assert.equal(svc.getEpisodeBreakdownBlock(ep), null)

  const unknown = newEpisode('not-exists')
  assert.equal(svc.getEpisodeBreakdownBlock(unknown), null)
  assert.equal(standard.prompt, '')
})

test('composeAgentInstructions 固定顺序拼接并过滤空值', () => {
  assert.equal(
    agents.composeAgentInstructions({ base: '基础提示词', language: '语言指令' }),
    '基础提示词\n\n语言指令',
  )

  const composed = agents.composeAgentInstructions({
    base: '基础提示词',
    skills: '基础 Skill',
    breakdown: '## 当前分镜拆分方案：钩子\n\n以本方案为准',
    voice: '声音引用',
    language: '语言指令',
  })
  assert.ok(composed.indexOf('基础 Skill') < composed.indexOf('## 当前分镜拆分方案'))
  assert.ok(composed.indexOf('## 当前分镜拆分方案') < composed.indexOf('声音引用'))

  const filtered = agents.composeAgentInstructions({
    base: '基础提示词',
    skills: '',
    breakdown: null,
    voice: undefined,
    language: '语言指令',
  })
  assert.equal(filtered, '基础提示词\n\n语言指令')
  assert.ok(!filtered.includes('\n\n\n'))
})

test('仅 storyboard_breaker 读取方案块，拼接顺序固定', () => {
  const source = fs.readFileSync(new URL('../src/agents/index.ts', import.meta.url), 'utf8')
  assert.equal([...source.matchAll(/getEpisodeBreakdownBlock\(/g)].length, 1)
  assert.match(
    source,
    /type === 'storyboard_breaker'[\s\S]{0,160}getEpisodeBreakdownBlock\(getEpisodeId\(requestContext\)\)/,
  )
  assert.match(source, /base: baseInstructions,\s*skills: skillInstructions,\s*breakdown,/)
  assert.match(source, /breakdown,\s*voice: voiceInstructions,\s*language: languageDirective,/)
})

test('剧集方案块经 composeAgentInstructions 注入，自动流程无新增方案参数', () => {
  const custom = svc.createBreakdownMethod({
    name: '注入方案',
    prompt: '注入提示词',
    skill: '注入 Skill',
  })
  const ep = newEpisode(custom.key)
  const block = svc.getEpisodeBreakdownBlock(ep)
  const text = agents.composeAgentInstructions({
    base: '基础提示词',
    skills: '基础 Skill',
    breakdown: block,
    voice: '声音引用',
    language: '语言指令',
  })
  assert.ok(text.includes('## 当前分镜拆分方案：注入方案'))
  assert.ok(text.includes('以本方案为准'))
  assert.ok(text.includes('### 方案提示词\n注入提示词'))
  svc.deleteBreakdownMethod(custom.key)

  const standardEp = newEpisode('standard')
  assert.equal(
    agents.composeAgentInstructions({
      base: '基础提示词',
      skills: '基础 Skill',
      breakdown: svc.getEpisodeBreakdownBlock(standardEp),
      voice: '声音引用',
      language: '语言指令',
    }),
    '基础提示词\n\n基础 Skill\n\n声音引用\n\n语言指令',
  )

  const automationSource = fs.readFileSync(
    new URL('../src/services/automation.ts', import.meta.url),
    'utf8',
  )
  const start = automationSource.indexOf('stepStoryboards')
  const body = automationSource.slice(start, start + 3000)
  assert.match(body, /getAgent\('storyboard_breaker'\)/)
  assert.doesNotMatch(body, /breakdownMethod|breakdown_method/)
})

test('方案接口覆盖列表、详情、创建、更新、复制、恢复、删除与错误码', async () => {
  await svc.ensureBreakdownMethodsSeeded()

  let res = await api.request('/breakdown-methods')
  assert.equal(res.status, 200)
  let payload = await readJson(res)
  assert.equal(payload.code, 200)
  assert.equal(payload.data.list.length, 5)
  assert.equal(payload.data.list[0].key, 'standard')
  assert.ok('usage_count' in payload.data.list[0])
  assert.ok(!('prompt' in payload.data.list[0]))
  assert.ok(!('skill' in payload.data.list[0]))

  res = await api.request('/breakdown-methods/hook-beat')
  assert.equal(res.status, 200)
  payload = await readJson(res)
  assert.ok(payload.data.prompt.includes('钩子'))
  assert.equal(payload.data.sort_order, 20)

  assert.equal((await api.request('/breakdown-methods/not-exists')).status, 404)

  res = await sendJson('/breakdown-methods', 'POST', {
    name: '接口方案',
    description: '接口说明',
    prompt: '接口提示词',
    skill: '接口 Skill',
  })
  assert.equal(res.status, 201)
  payload = await readJson(res)
  const customKey = payload.data.key
  assert.match(customKey, /^custom-/)
  assert.equal(payload.data.builtin, 0)
  assert.equal(payload.data.name, '接口方案')
  assert.ok(payload.data.sort_order > 50)

  res = await sendJson(`/breakdown-methods/${customKey}`, 'PUT', { name: '接口方案改' })
  assert.equal(res.status, 200)
  payload = await readJson(res)
  assert.equal(payload.data.name, '接口方案改')
  assert.equal(payload.data.prompt, '接口提示词')

  res = await sendJson('/breakdown-methods/hook-beat/duplicate', 'POST', {})
  assert.equal(res.status, 201)
  payload = await readJson(res)
  const duplicateKey = payload.data.key
  assert.equal(payload.data.name, '爆款钩子节拍 副本')
  assert.match(duplicateKey, /^custom-/)

  res = await sendJson('/breakdown-methods/hook-beat/reset', 'POST', {})
  assert.equal(res.status, 200)
  payload = await readJson(res)
  assert.equal(payload.data.name, '爆款钩子节拍')

  res = await sendJson(`/breakdown-methods/${customKey}/reset`, 'POST', {})
  assert.equal(res.status, 400)

  res = await api.request('/breakdown-methods/standard', { method: 'DELETE' })
  assert.equal(res.status, 400)

  res = await api.request(`/breakdown-methods/${customKey}`, { method: 'DELETE' })
  assert.equal(res.status, 200)
  payload = await readJson(res)
  assert.equal(payload.data.released_episodes, 0)
  assert.equal(svc.getBreakdownMethod(customKey), null)

  assert.equal((await api.request('/breakdown-methods/not-exists', { method: 'DELETE' })).status, 404)
  assert.equal((await sendJson('/breakdown-methods/not-exists', 'PUT', { name: 'x' })).status, 404)
  assert.equal((await sendJson('/breakdown-methods/not-exists/reset', 'POST', {})).status, 404)
  assert.equal((await sendJson('/breakdown-methods/not-exists/duplicate', 'POST', {})).status, 404)

  assert.equal((await sendJson('/breakdown-methods', 'POST', { name: 'x'.repeat(61) })).status, 400)
  assert.equal((await sendJson('/breakdown-methods', 'POST', {
    name: '超长提示词',
    prompt: 'x'.repeat(20001),
  })).status, 400)
  assert.equal((await sendJson('/breakdown-methods', 'POST', {
    name: '超长技能',
    skill: 'x'.repeat(40001),
  })).status, 400)

  await api.request(`/breakdown-methods/${duplicateKey}`, { method: 'DELETE' })
})

test('剧集 PUT 支持 breakdown_method 合法、置空与未知 key', async () => {
  const episodeId = newEpisode(null)
  const before = db.select().from(episodes).where(eq(episodes.id, episodeId)).get()!

  let res = await sendJson(`/episodes/${episodeId}`, 'PUT', { breakdown_method: 'hook-beat' })
  let payload: any
  assert.equal(res.status, 200)
  let row = db.select().from(episodes).where(eq(episodes.id, episodeId)).get()!
  assert.equal(row.breakdownMethod, 'hook-beat')
  assert.equal(row.title, before.title)

  res = await sendJson(`/episodes/${episodeId}`, 'PUT', { breakdown_method: '' })
  assert.equal(res.status, 200)
  row = db.select().from(episodes).where(eq(episodes.id, episodeId)).get()!
  assert.equal(row.breakdownMethod, null)

  res = await sendJson(`/episodes/${episodeId}`, 'PUT', { breakdown_method: 'not-exists' })
  assert.equal(res.status, 400)
  payload = await readJson(res)
  assert.match(payload.message, /拆分方案不存在/)

  res = await sendJson(`/episodes/${episodeId}`, 'PUT', { breakdown_method: null })
  assert.equal(res.status, 200)
})

test('名称、prompt、skill 长度边界', () => {
  assert.throws(() => svc.createBreakdownMethod({ name: '   ' }), /名称/)
  assert.throws(() => svc.createBreakdownMethod({ name: 'x'.repeat(61) }), /名称/)
  assert.throws(() => svc.createBreakdownMethod({ name: '边界', prompt: 'x'.repeat(20001) }), /提示词/)
  assert.throws(() => svc.createBreakdownMethod({ name: '边界', skill: 'x'.repeat(40001) }), /Skill/)

  const ok = svc.createBreakdownMethod({
    name: 'x'.repeat(60),
    prompt: 'x'.repeat(20000),
    skill: 'x'.repeat(40000),
  })
  assert.equal(ok.name.length, 60)
  svc.deleteBreakdownMethod(ok.key)
})
