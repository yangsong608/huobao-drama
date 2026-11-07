/**
 * B0 基础层四命名空间设置（ui / director / edit / agent）
 * 覆盖：默认值、空对象/单键更新、数值钳制、枚举回退、字符串布尔、未知键、
 * 跨字段 400、环境变量优先级且不落库、非对象 400、novel.* 回归。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-foundation-settings-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { default: settingsRoutes } = await import('../src/routes/settings.ts')
const { db, schema } = await import('../src/db/index.js')
const {
  UI_SETTINGS_DEFAULTS,
  DIRECTOR_SETTINGS_DEFAULTS,
  EDIT_SETTINGS_DEFAULTS,
  AGENT_SETTINGS_DEFAULTS,
  AGENT_PAGES_DEFAULTS,
} = await import('../src/services/app-settings.ts')

const app = new Hono()
app.route('/api/v1/settings', settingsRoutes)

async function json(response: Response) {
  const body: any = await response.json()
  // success() 包装为 { code, data, message }；展开 data 使 res.settings 直接可用
  return { status: response.status, ...(body.data ?? {}) }
}

async function get(ns: string) {
  const res = await app.request(`/api/v1/settings/${ns}`)
  const body: any = await res.json()
  return { status: res.status, settings: body.data?.settings, message: body.message }
}

async function put(ns: string, payload: unknown) {
  return app.request(`/api/v1/settings/${ns}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** 直接读取 app_settings 中某命名空间的落库 JSON（用于断言环境变量未写入） */
function storedRaw(key: string): string | null {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, key))
    .get() as { value?: string } | undefined
  return row?.value ?? null
}

const ENV_KEYS = [
  'UI_DEFAULTS_DENSITY', 'UI_DEFAULTS_MOTION', 'UI_DEFAULTS_READING_FONT', 'UI_DEFAULTS_READING_SIZE',
  'UI_DEFAULTS_ACTION_LABELS', 'UI_ALLOW_USER_OVERRIDE',
  'DIRECTOR_MODE', 'DIRECTOR_3D',
  'EDIT_EXPORT', 'EDIT_FILM_SOURCES',
  'AGENT_DOCK', 'AGENT_DIRECTOR', 'AGENT_STREAM', 'AGENT_PROPOSALS', 'AGENT_SUGGESTIONS',
] as const

const savedEnv: Record<string, string | undefined> = {}
before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
})
after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// --- GET 默认值 ---

test('GET /ui 返回 6 键默认值', async () => {
  delete process.env.UI_DEFAULTS_DENSITY
  delete process.env.UI_DEFAULTS_MOTION
  delete process.env.UI_DEFAULTS_READING_FONT
  delete process.env.UI_DEFAULTS_READING_SIZE
  delete process.env.UI_DEFAULTS_ACTION_LABELS
  delete process.env.UI_ALLOW_USER_OVERRIDE
  const res = await get('ui')
  assert.equal(res.status, 200)
  assert.deepEqual(res.settings, UI_SETTINGS_DEFAULTS)
  assert.deepEqual(res.settings.defaults, {
    density: 'compact', motion: 'system', readingFont: 'serif', readingSize: 16, actionLabels: true,
  })
  assert.equal(res.settings.allowUserOverride, true)
})

test('GET /director 返回 11 键默认值', async () => {
  delete process.env.DIRECTOR_MODE
  delete process.env.DIRECTOR_3D
  const res = await get('director')
  assert.equal(res.status, 200)
  assert.deepEqual(res.settings, DIRECTOR_SETTINGS_DEFAULTS)
  assert.deepEqual(res.settings.apply.fields, ['shot_type', 'angle', 'movement', 'duration'])
  assert.deepEqual(res.settings.duration, { min: 8, max: 15, fps: '24' })
  assert.equal(res.settings.mode, 'off')
})

test('GET /edit 返回 11 键默认值', async () => {
  delete process.env.EDIT_EXPORT
  delete process.env.EDIT_FILM_SOURCES
  const res = await get('edit')
  assert.equal(res.status, 200)
  assert.deepEqual(res.settings, EDIT_SETTINGS_DEFAULTS)
  assert.equal(res.settings.filmSources.enabled, false)
})

test('GET /agent 返回 18 键默认值与内置页面矩阵', async () => {
  for (const k of ['AGENT_DOCK', 'AGENT_DIRECTOR', 'AGENT_STREAM', 'AGENT_PROPOSALS', 'AGENT_SUGGESTIONS']) {
    delete process.env[k]
  }
  const res = await get('agent')
  assert.equal(res.status, 200)
  assert.deepEqual(res.settings, AGENT_SETTINGS_DEFAULTS)
  assert.equal(res.settings.pages.version, 1)
  assert.deepEqual(res.settings.proposals.types, ['storyboard.update', 'asset.prompt.update', 'line.update'])
  assert.deepEqual(res.settings.suggestions.actions, ['agent.run', 'page.open'])
  assert.equal(res.settings.maxSteps, 8)
  assert.equal(res.settings.session.retentionDays, 30)
  assert.equal(res.settings.dock.enabled, true)
})

// --- 部分更新 / 清洗 ---

test('ui：空对象更新返回完整配置；单键更新覆盖其余保持', async () => {
  let res = await json(await put('ui', {}))
  assert.equal(res.status, 200)
  assert.deepEqual(res.settings, UI_SETTINGS_DEFAULTS)

  res = await json(await put('ui', { defaults: { density: 'comfortable' } }))
  assert.equal(res.settings.defaults.density, 'comfortable')
  assert.equal(res.settings.defaults.motion, 'system')
  assert.equal(res.settings.allowUserOverride, true)

  res = await json(await put('ui', { allowUserOverride: false }))
  assert.equal(res.settings.allowUserOverride, false)
  assert.equal(res.settings.defaults.density, 'comfortable')

  // 恢复默认，避免影响后续断言
  res = await json(await put('ui', { defaults: { density: 'compact' }, allowUserOverride: true }))
  assert.deepEqual(res.settings, UI_SETTINGS_DEFAULTS)
})

test('ui：越界钳制、非法枚举回退、字符串布尔、未知键忽略', async () => {
  const res = await json(await put('ui', {
    unknownKey: 'ignored',
    defaults: {
      readingSize: 99,
      motion: 'bogus',
      actionLabels: 'off',
    },
    allowUserOverride: 'on',
  }))
  assert.equal(res.status, 200)
  assert.equal(res.settings.defaults.readingSize, 18)
  assert.equal(res.settings.defaults.motion, 'system')
  assert.equal(res.settings.defaults.actionLabels, false)
  assert.equal(res.settings.allowUserOverride, true)
  assert.equal('unknownKey' in res.settings, false)
})

test('director：数值钳制、fps 枚举、apply.fields 白名单子集', async () => {
  const res = await json(await put('director', {
    duration: { min: 2, max: 99, fps: 60 },
    stage: { maxShots: 9999 },
    previs: { maxAssets: 1 },
    apply: { fields: ['angle', 'bogus', 'angle', 'movement'] },
    mode: 'on',
  }))
  assert.equal(res.status, 200)
  assert.deepEqual(res.settings.duration, { min: 6, max: 20, fps: '24' })
  assert.equal(res.settings.stage.maxShots, 500)
  assert.equal(res.settings.previs.maxAssets, 5)
  assert.deepEqual(res.settings.apply.fields, ['angle', 'movement'])
  assert.equal(res.settings.mode, 'on')
})

test('director：min > max 拒绝保存返回 400 且数据库不变', async () => {
  const before = storedRaw('director.settings')
  const res = await put('director', { duration: { min: 12, max: 8 } })
  assert.equal(res.status, 400)
  assert.match((await res.json()).message, /min/)
  assert.equal(storedRaw('director.settings'), before)
})

test('director/edit：子对象部分更新保留兄弟键', async () => {
  // director：先存完整 duration，再只更新 min
  await json(await put('director', { duration: { min: 8, max: 20, fps: '25' } }))
  const res = await json(await put('director', { duration: { min: 10 } }))
  assert.deepEqual(res.settings.duration, { min: 10, max: 20, fps: '25' })

  // edit：先存 export 多键，再只更新 concurrency
  await json(await put('edit', { export: { subtitleMode: 'burn', maxDurationSec: 3600, concurrency: 2 } }))
  const res2 = await json(await put('edit', { export: { concurrency: 1 } }))
  assert.equal(res2.settings.export.subtitleMode, 'burn')
  assert.equal(res2.settings.export.maxDurationSec, 3600)
  assert.equal(res2.settings.export.concurrency, 1)

  // 恢复默认，避免影响后续用例
  await json(await put('director', { duration: DIRECTOR_SETTINGS_DEFAULTS.duration, mode: 'off' }))
  await json(await put('edit', { export: { subtitleMode: 'soft', maxDurationSec: 1800, concurrency: 1 } }))
})

test('edit：钳制与枚举清洗', async () => {
  const res = await json(await put('edit', {
    export: {
      defaultPreset: 'bogus',
      subtitleMode: 'burn',
      audioSource: 'mix',
      maxDurationSec: 10,
      concurrency: 9,
      requireAlignedMix: 1,
    },
    ux: { markers: 'off' },
  }))
  assert.equal(res.status, 200)
  assert.equal(res.settings.export.defaultPreset, 'auto')
  assert.equal(res.settings.export.subtitleMode, 'burn')
  assert.equal(res.settings.export.audioSource, 'mix')
  assert.equal(res.settings.export.maxDurationSec, 60)
  assert.equal(res.settings.export.concurrency, 2)
  assert.equal(res.settings.export.requireAlignedMix, true)
  assert.equal(res.settings.ux.markers, false)
})

test('agent：数值钳制、提案/建议白名单子集、空数组表示全关', async () => {
  let res = await json(await put('agent', {
    maxSteps: 99,
    timeoutSec: 1,
    context: { maxChars: 999999 },
    message: { maxChars: 100 },
    tools: { maxResultChars: 0 },
    history: { maxMessages: 1 },
    session: { retentionDays: 1000 },
    proposals: { types: ['storyboard.update', 'bogus', 'line.update'] },
    suggestions: { actions: [] },
  }))
  assert.equal(res.status, 200)
  assert.equal(res.settings.maxSteps, 16)
  assert.equal(res.settings.timeoutSec, 30)
  assert.equal(res.settings.context.maxChars, 32000)
  assert.equal(res.settings.message.maxChars, 500)
  assert.equal(res.settings.tools.maxResultChars, 1000)
  assert.equal(res.settings.history.maxMessages, 5)
  assert.equal(res.settings.session.retentionDays, 365)
  assert.deepEqual(res.settings.proposals.types, ['storyboard.update', 'line.update'])
  assert.deepEqual(res.settings.suggestions.actions, [])

  // 恢复默认
  res = await json(await put('agent', {
    proposals: { types: AGENT_SETTINGS_DEFAULTS.proposals.types },
    suggestions: { actions: AGENT_SETTINGS_DEFAULTS.suggestions.actions },
  }))
  assert.deepEqual(res.settings.proposals.types, AGENT_SETTINGS_DEFAULTS.proposals.types)
  assert.deepEqual(res.settings.suggestions.actions, AGENT_SETTINGS_DEFAULTS.suggestions.actions)
})

test('agent：message.maxChars > context.maxChars 拒绝保存 400 且数据库不变', async () => {
  const before = storedRaw('agent.settings')
  const res = await put('agent', { context: { maxChars: 4000 }, message: { maxChars: 12000 } })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(body.message, /message\.maxChars/)
  assert.equal(storedRaw('agent.settings'), before)
})

test('agent.pages：合法结构白名单；同 (route,stage) 重复、空 allowedScopes、解析失败均回退默认', async () => {
  // 合法自定义
  let res = await json(await put('agent', {
    pages: {
      version: 1,
      bindings: [
        { route: '/drama/:id/episode/:episodeNumber', stage: 'videos', entries: ['floating', 'stage'], defaultPreset: 'assistant', quickPrompts: ['检查这一镜的提示词是否完整'], allowedScopes: ['episode'], allowedTools: ['read_episode_context', 'read_storyboards'] },
      ],
    },
  }))
  assert.equal(res.status, 200)
  assert.equal(res.settings.pages.bindings.length, 1)
  assert.equal(res.settings.pages.bindings[0].stage, 'videos')
  assert.deepEqual(res.settings.pages.bindings[0].allowedTools, ['read_episode_context', 'read_storyboards'])

  // 同 (route, stage) 重复 → 整体回退默认矩阵
  res = await json(await put('agent', {
    pages: {
      version: 1,
      bindings: [
        { route: '/', entries: ['floating'], defaultPreset: 'assistant' },
        { route: '/', entries: ['floating'], defaultPreset: 'assistant' },
      ],
    },
  }))
  assert.equal(res.status, 200)
  assert.deepEqual(res.settings.pages, AGENT_PAGES_DEFAULTS)

  // allowedScopes 空数组非法 → 回退默认
  res = await json(await put('agent', {
    pages: {
      version: 1,
      bindings: [
        { route: '/', entries: ['floating'], defaultPreset: 'assistant', allowedScopes: [] },
      ],
    },
  }))
  assert.deepEqual(res.settings.pages, AGENT_PAGES_DEFAULTS)

  // 非 JSON 结构（bindings 不是数组）→ 回退默认
  res = await json(await put('agent', { pages: { version: 1, bindings: 'bogus' } }))
  assert.deepEqual(res.settings.pages, AGENT_PAGES_DEFAULTS)

  // 未知 scope → 回退默认
  res = await json(await put('agent', {
    pages: {
      version: 1,
      bindings: [{ route: '/', entries: ['floating'], defaultPreset: 'assistant', allowedScopes: ['bogus'] }],
    },
  }))
  assert.deepEqual(res.settings.pages, AGENT_PAGES_DEFAULTS)

  // allowedTools 含白名单外工具（提案工具）→ 回退默认
  res = await json(await put('agent', {
    pages: {
      version: 1,
      bindings: [{ route: '/', entries: ['floating'], defaultPreset: 'assistant', allowedTools: ['read_project_list', 'propose_change'] }],
    },
  }))
  assert.deepEqual(res.settings.pages, AGENT_PAGES_DEFAULTS)
})

test('非对象请求体返回 400（四命名空间一致）', async () => {
  for (const ns of ['ui', 'director', 'edit', 'agent']) {
    const res = await put(ns, ['array'])
    assert.equal(res.status, 400, ns)
    const res2 = await put(ns, 'string')
    assert.equal(res2.status, 400, ns)
  }
})

// --- 环境变量优先级且不落库 ---

test('AGENT_DOCK=off 强制关闭；保存其他键不把环境变量值写库', async () => {
  delete process.env.AGENT_DOCK
  let res = await json(await put('agent', { maxSteps: 10 }))
  assert.equal(res.settings.dock.enabled, true)

  process.env.AGENT_DOCK = 'off'
  res = await get('agent')
  assert.equal(res.settings.dock.enabled, false)

  // 带着环境变量保存其他键：落库 JSON 中 dock.enabled 仍是 true
  res = await json(await put('agent', { timeoutSec: 180 }))
  assert.equal(res.status, 200)
  const raw = JSON.parse(storedRaw('agent.settings')!)
  assert.equal(raw.dock.enabled, true)

  // 环境变量未设置/非 off 时以设置页为准
  process.env.AGENT_DOCK = 'on'
  res = await get('agent')
  assert.equal(res.settings.dock.enabled, true)
  delete process.env.AGENT_DOCK
  res = await get('agent')
  assert.equal(res.settings.dock.enabled, true)
})

test('UI / DIRECTOR / EDIT 环境变量优先级', async () => {
  process.env.UI_DEFAULTS_DENSITY = 'comfortable'
  process.env.UI_DEFAULTS_READING_SIZE = '17'
  process.env.UI_ALLOW_USER_OVERRIDE = '0'
  let res = await get('ui')
  assert.equal(res.settings.defaults.density, 'comfortable')
  assert.equal(res.settings.defaults.readingSize, 17)
  assert.equal(res.settings.allowUserOverride, false)
  delete process.env.UI_DEFAULTS_DENSITY
  delete process.env.UI_DEFAULTS_READING_SIZE
  delete process.env.UI_ALLOW_USER_OVERRIDE

  process.env.DIRECTOR_MODE = 'readonly'
  process.env.DIRECTOR_3D = 'off'
  res = await get('director')
  assert.equal(res.settings.mode, 'readonly')
  assert.equal(res.settings.view3d.enabled, false)
  delete process.env.DIRECTOR_MODE
  delete process.env.DIRECTOR_3D

  process.env.EDIT_EXPORT = 'off'
  process.env.EDIT_FILM_SOURCES = 'on'
  res = await get('edit')
  assert.equal(res.settings.export.enabled, false)
  assert.equal(res.settings.filmSources.enabled, true)
  delete process.env.EDIT_EXPORT
  delete process.env.EDIT_FILM_SOURCES

  // 环境变量值未落库
  const raw = JSON.parse(storedRaw('edit.settings')!)
  assert.equal(raw.export.enabled, true)
  assert.equal(raw.filmSources.enabled, false)
})

// --- novel.* 回归 ---

test('novel 设置读写回归不受影响', async () => {
  let res = await get('novel')
  assert.equal(res.status, 200)
  const original = res.settings

  res = await json(await put('novel', { importTargetWords: 1500 }))
  assert.equal(res.status, 200)
  assert.equal(res.settings.importTargetWords, 1500)

  res = await json(await put('novel', { importTargetWords: original.importTargetWords }))
  assert.equal(res.settings.importTargetWords, original.importTargetWords)
})
