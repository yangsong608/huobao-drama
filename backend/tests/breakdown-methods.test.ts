import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { getTableColumns } from 'drizzle-orm'
import { initSqliteSchema } from '../src/db/sqlite-schema.ts'
import { breakdownMethods, episodes, storyboards } from '../src/db/schema.ts'

const serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-breakdown-service-'))
process.env.SQLITE_PATH = path.join(serviceRoot, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = serviceRoot
process.env.STORAGE_PATH = path.join(serviceRoot, 'static')
process.env.WORKSPACE_PATH = path.join(serviceRoot, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db } = await import('../src/db/index.ts')
const svc = await import('../src/services/breakdown-methods.ts')
const { DEFAULT_BREAKDOWN_METHODS } = await import('../src/services/breakdown-method-defaults.ts')
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


function newScriptEpisode(method: string | null, chars: number) {
  const script = '剧'.repeat(chars)
  const row = db.insert(episodes).values({
    dramaId: 1,
    episodeNumber: ++epSeq,
    title: `第${epSeq}集`,
    content: script,
    scriptContent: script,
    breakdownMethod: method,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  return row.id
}

function addStoryboards(episodeId: number, count: number) {
  for (let index = 1; index <= count; index += 1) {
    db.insert(storyboards).values({
      episodeId,
      storyboardNumber: index,
      duration: 10,
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }
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

test('首次播种补齐六条内置方案，重复播种不覆盖编辑', async () => {
  await svc.ensureBreakdownMethodsSeeded()
  const list = svc.listBreakdownMethods()
  assert.deepEqual(list.map(item => item.key), [
    'standard', 'hook-beat', 'hook-beat-extended', 'director-board', 'h3-compact', 'trailer-cut',
  ])
  assert.ok(list.every(item => item.builtin === 1))

  db.update(breakdownMethods).set({ name: '改过的钩子' }).where(eq(breakdownMethods.key, 'hook-beat')).run()
  db.update(breakdownMethods).set({ name: '改过的扩展版' }).where(eq(breakdownMethods.key, 'hook-beat-extended')).run()
  await svc.ensureBreakdownMethodsSeeded()
  assert.equal(svc.getBreakdownMethod('hook-beat')?.name, '改过的钩子')
  assert.equal(svc.getBreakdownMethod('hook-beat-extended')?.name, '改过的扩展版')

  svc.resetBreakdownMethod('hook-beat')
  svc.resetBreakdownMethod('hook-beat-extended')
  assert.equal(svc.getBreakdownMethod('hook-beat')?.name, '爆款钩子节拍')
  assert.equal(svc.getBreakdownMethod('hook-beat-extended')?.name, '爆款钩子节拍·扩展版')
})

test('扩展版预置方案覆盖开场、钩子节点、机位、台词与自检', async () => {
  await svc.ensureBreakdownMethodsSeeded()
  const extended = svc.getBreakdownMethod('hook-beat-extended')!
  assert.equal(extended.builtin, 1)
  assert.equal(extended.sortOrder, 25)
  assert.ok(extended.description.includes('参考'))
  for (const word of [
    '外力施压', '开场 0–3 秒', '段尾钩子', '6–12 秒', '2–3 个子镜头',
    'A 主镜', 'B 反打', 'C 特写', 'D 环境', '台词', '自检',
  ]) {
    assert.ok(extended.skill.includes(word), `扩展版 Skill 缺少 ${word}`)
  }
  assert.ok(extended.prompt.includes('钩子'))
  assert.ok(extended.prompt.includes('外力施压'))

  const ep = newEpisode('hook-beat-extended')
  const block = svc.getEpisodeBreakdownBlock(ep)!
  assert.ok(block.includes('## 当前分镜拆分方案：爆款钩子节拍·扩展版'))
  assert.ok(block.includes('### 方案提示词'))
  assert.ok(block.includes('### 方案 Skill'))
  assert.ok(block.includes('A 主镜'))
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

test('六个内置方案声明单段最长秒数，用于计算覆盖下限', () => {
  const expected: Record<string, number> = {
    standard: 15,
    'hook-beat': 12,
    'hook-beat-extended': 12,
    'director-board': 10,
    'h3-compact': 8,
    'trailer-cut': 6,
  }
  for (const [key, max] of Object.entries(expected)) {
    const seed = DEFAULT_BREAKDOWN_METHODS.find(item => item.key === key)
    assert.ok(seed, `缺少内置方案 ${key}`)
    assert.equal(seed.maxSegmentSeconds, max, `${key} 单段上限错误`)
  }
})

test('五个启用方案的规则都包含剧本全覆盖、段落数下限与逐场自检', () => {
  const expectedFloor: Record<string, string> = {
    'hook-beat': '27 段',
    'hook-beat-extended': '27 段',
    'director-board': '33 段',
    'h3-compact': '41 段',
    'trailer-cut': '54 段',
  }
  for (const key of Object.keys(expectedFloor)) {
    const seed = DEFAULT_BREAKDOWN_METHODS.find(item => item.key === key)!
    for (const word of ['剧本全覆盖', '段落数下限', '逐场', '不得删场']) {
      assert.ok(seed.skill.includes(word), `${key} Skill 缺少 ${word}`)
    }
    assert.ok(seed.prompt.includes('剧本全覆盖'), `${key} 提示词缺少剧本全覆盖`)
    assert.ok(seed.skill.includes(`至少 ${expectedFloor[key]}`), `${key} 缺少 3000 字样例下限`)
  }
})

test('覆盖下限按剧本字数与方案单段上限计算，并按存活分镜判定', async () => {
  await svc.ensureBreakdownMethodsSeeded()

  const extendedEp = newScriptEpisode('hook-beat-extended', 3000)
  let coverage = svc.getEpisodeCoverage(extendedEp)!
  assert.equal(coverage.scriptChars, 3000)
  assert.equal(coverage.maxSegmentSeconds, 12)
  assert.equal(coverage.targetSeconds, 360)
  assert.equal(coverage.floor, 27)
  assert.equal(coverage.actual, 0)
  assert.equal(coverage.ok, false)

  addStoryboards(extendedEp, 27)
  coverage = svc.getEpisodeCoverage(extendedEp)!
  assert.equal(coverage.actual, 27)
  assert.equal(coverage.ok, true)

  const standardEp = newScriptEpisode('standard', 3000)
  assert.equal(svc.getEpisodeCoverage(standardEp)!.floor, 22)
  const custom = svc.createBreakdownMethod({ name: '覆盖测试方案' })
  const customEp = newScriptEpisode(custom.key, 3000)
  assert.equal(svc.getEpisodeCoverage(customEp)!.maxSegmentSeconds, 15)
  svc.deleteBreakdownMethod(custom.key)

  addStoryboards(standardEp, 21)
  assert.equal(svc.getEpisodeCoverage(standardEp)!.ok, false, '低于下限必须判定不完整')
  const deletedEp = newScriptEpisode('hook-beat-extended', 3000)
  addStoryboards(deletedEp, 27)
  const removed = db.select().from(storyboards).where(eq(storyboards.episodeId, deletedEp)).all()[0]
  db.update(storyboards).set({ deletedAt: ts }).where(eq(storyboards.id, removed.id)).run()
  assert.equal(svc.getEpisodeCoverage(deletedEp)!.actual, 26)
  assert.equal(svc.getEpisodeCoverage(deletedEp)!.ok, false, '软删分镜不计入覆盖')

  assert.equal(svc.getEpisodeCoverage(undefined), null)
  assert.equal(svc.getEpisodeCoverage(999999), null)
})

test('未编辑过的内置方案随版本自动升级，用户编辑保留', async () => {
  await svc.ensureBreakdownMethodsSeeded()
  const seed = DEFAULT_BREAKDOWN_METHODS.find(item => item.key === 'hook-beat')!
  const oldTs = '2025-01-01T00:00:00.000Z'

  try {
    // 旧版本播种的行：创建时间与更新时间相同，代表从未编辑
    db.update(breakdownMethods).set({
      prompt: '旧版提示词',
      skill: '旧版技能',
      description: '旧版说明',
      createdAt: oldTs,
      updatedAt: oldTs,
    }).where(eq(breakdownMethods.key, 'hook-beat')).run()
    await svc.ensureBreakdownMethodsSeeded(true)
    let row = svc.getBreakdownMethod('hook-beat')!
    assert.equal(row.prompt, seed.prompt)
    assert.equal(row.skill, seed.skill)
    assert.equal(row.description, seed.description)

    // 编辑过的行（更新时间晚于创建时间）必须保留
    db.update(breakdownMethods).set({
      prompt: '用户自定义提示词',
      skill: '用户自定义技能',
      updatedAt: '2025-01-02T00:00:00.000Z',
    }).where(eq(breakdownMethods.key, 'hook-beat')).run()
    await svc.ensureBreakdownMethodsSeeded(true)
    row = svc.getBreakdownMethod('hook-beat')!
    assert.equal(row.prompt, '用户自定义提示词')
    assert.equal(row.skill, '用户自定义技能')
  } finally {
    svc.resetBreakdownMethod('hook-beat')
  }
  assert.equal(svc.getBreakdownMethod('hook-beat')!.prompt, seed.prompt)
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

test('方案块尾部固定追加平台硬约束，任何方案不得覆盖 video_prompt 基础规范', async () => {
  await svc.ensureBreakdownMethodsSeeded()
  const custom = svc.createBreakdownMethod({
    name: '平台硬约束测试方案',
    prompt: '方案提示词：按钩子节拍拆分',
    skill: '方案 Skill：自检只看钩子',
  })
  try {
    const ep = newEpisode(custom.key)
    const block = svc.getEpisodeBreakdownBlock(ep)!
    for (const word of [
      '### 平台硬约束',
      '任何方案不得覆盖',
      '一个分镜 = 一个机位',
      '禁止在一个分镜里切镜',
      '出场人物：@角色A、@角色B｜场景：@场景名',
      '画面调度：画面左',
      '动作起点',
      '动作终点',
      '负面约束：只出现画内人物',
      '0-3秒：',
      '最后一段结束时间等于 duration',
      '@角色名说：「台词」',
      '旁白（画外音）：「台词」',
      '逐字复制',
      '4 字/秒',
      'canonical scene_id',
      '不要写「音频：」',
    ]) {
      assert.ok(block.includes(word), `硬约束块缺少 ${word}`)
    }
    assert.ok(
      block.indexOf('### 平台硬约束') > block.indexOf('方案 Skill：自检只看钩子'),
      '硬约束必须排在方案正文之后',
    )

    const extendedEp = newEpisode('hook-beat-extended')
    assert.ok(svc.getEpisodeBreakdownBlock(extendedEp)!.includes('### 平台硬约束'))
  } finally {
    svc.deleteBreakdownMethod(custom.key)
  }
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

test('分镜 Agent（拆分/导演）读取方案块，拼接顺序固定', () => {
  const source = fs.readFileSync(new URL('../src/agents/index.ts', import.meta.url), 'utf8')
  assert.equal([...source.matchAll(/getEpisodeBreakdownBlock\(/g)].length, 1)
  assert.match(
    source,
    /\['storyboard_breaker', 'storyboard_director'\][\s\S]{0,200}getEpisodeBreakdownBlock\(\s*getEpisodeId\(requestContext\),[\s\S]{0,160}pipelineBreakdownMethod/,
  )
  assert.match(source, /base: baseInstructions,\s*knowledge: knowledge\.text,\s*skills: skillInstructions,\s*breakdown,/)
  assert.match(source, /breakdown,\s*unit: \['storyboard_breaker', 'storyboard_director'\][\s\S]{0,80}voice: voiceInstructions,\s*language: languageDirective,/)
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
  assert.match(body, /createStoryboardPipelineJob\(/)
  assert.doesNotMatch(body, /breakdownMethod|breakdown_method/)
})

test('方案接口覆盖列表、详情、创建、更新、复制、恢复、删除与错误码', async () => {
  await svc.ensureBreakdownMethodsSeeded()

  let res = await api.request('/breakdown-methods')
  assert.equal(res.status, 200)
  let payload = await readJson(res)
  assert.equal(payload.code, 200)
  assert.equal(payload.data.list.length, 6)
  assert.equal(payload.data.list[0].key, 'standard')
  assert.equal(payload.data.list[2].key, 'hook-beat-extended')
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

test('Agent 路由注入覆盖下限并在生成结束后返回覆盖结果', () => {
  const source = fs.readFileSync(new URL('../src/routes/agent.ts', import.meta.url), 'utf8')
  assert.match(source, /getEpisodeCoverage\(episode_id\)/)
  assert.match(source, /本次拆分覆盖要求/)
  assert.match(source, /段落数下限/)
  assert.match(source, /coverage: coverageResult/)
  const afterGenerate = source.indexOf('coverageResult')
  const generateCall = source.indexOf('agent.generate(')
  assert.ok(afterGenerate > generateCall, '覆盖结果必须在生成结束后再计算')
})

test('基础分镜提示词与技能写明统一的 description / video_prompt 格式', () => {
  const prompt = fs.readFileSync(
    new URL('../workspace/prompts/storyboard_breaker.md', import.meta.url),
    'utf8',
  )
  const skill = fs.readFileSync(
    new URL('../workspace/skills/storyboard-breaker/SKILL.md', import.meta.url),
    'utf8',
  )
  for (const marker of [
    '一个分镜 = 一个机位',
    '禁止在一个分镜里写【镜头2】',
    '出场人物：@角色A、@角色B｜场景：@场景名',
    '画面调度：画面左',
    '动作起点',
    '动作终点',
    '负面约束：只出现画内人物',
    '0-3秒：',
    '最后一段结束等于 duration',
    '@角色名说：「台词」',
    '旁白（画外音）：「台词」',
    '4 字/秒',
  ]) {
    assert.ok(prompt.includes(marker), `基础提示词缺少 ${marker}`)
  }
  for (const marker of [
    '【镜头1】',
    '画面调度',
    '动作起点',
    '负面约束',
    '@角色名说：「台词」',
    '旁白（画外音）：「台词」',
  ]) {
    assert.ok(skill.includes(marker), `基础 Skill 缺少 ${marker}`)
  }
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
