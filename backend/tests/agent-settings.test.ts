/**
 * A3-3 页面绑定、工具权限与预算设置
 * 覆盖：defaultPreset 回退、空数组非法、allowedScopes 收窄、allowedTools 交集、message > context 拒绝。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-settings-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'storage')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { default: settingsRoutes } = await import('../src/routes/settings.ts')
const {
  AGENT_EPISODE_ROUTE,
  AGENT_PAGES_DEFAULTS,
  agentPageAllowsScope,
} = await import('../src/services/app-settings.ts')
const { getPresetTools } = await import('../src/agents/tools/read-tools.ts')
const { buildAssistantRequestContext } = await import('../src/agents/context.ts')

const app = new Hono()
app.route('/api/v1/settings', settingsRoutes)

async function json(response: Response) {
  const body: any = await response.json()
  return { status: response.status, ...(body.data ?? {}), message: body.message }
}

function put(payload: unknown) {
  return app.request('/api/v1/settings/agent', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

const ENV_KEYS = ['AGENT_DOCK', 'AGENT_DIRECTOR', 'AGENT_STREAM', 'AGENT_PROPOSALS', 'AGENT_SUGGESTIONS'] as const
const savedEnv: Record<string, string | undefined> = {}
before(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})
after(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await fs.rm(root, { recursive: true, force: true })
})

test('defaultPreset=director 只在分集路由默认绑定且允许 director 作用域时保留', async () => {
  let res = await put({
    pages: {
      version: 1,
      bindings: [{ route: '/', entries: ['floating'], defaultPreset: 'director', quickPrompts: [], allowedScopes: ['home'] }],
    },
  })
  assert.equal(res.status, 200)
  assert.equal((await json(res)).settings.pages.bindings[0].defaultPreset, 'assistant')

  res = await put({
    pages: {
      version: 1,
      bindings: [{ route: AGENT_EPISODE_ROUTE, entries: ['floating', 'stage'], defaultPreset: 'director', quickPrompts: [], allowedScopes: ['episode'] }],
    },
  })
  assert.equal((await json(res)).settings.pages.bindings[0].defaultPreset, 'assistant')

  res = await put({
    pages: {
      version: 1,
      bindings: [{ route: AGENT_EPISODE_ROUTE, entries: ['floating', 'stage'], defaultPreset: 'director', quickPrompts: [], allowedScopes: ['episode', 'director'] }],
    },
  })
  assert.equal((await json(res)).settings.pages.bindings[0].defaultPreset, 'director')

  res = await put({
    pages: {
      version: 1,
      bindings: [{ route: AGENT_EPISODE_ROUTE, stage: 'videos', entries: ['stage'], defaultPreset: 'director', quickPrompts: [], allowedScopes: ['director'] }],
    },
  })
  assert.equal((await json(res)).settings.pages.bindings[0].defaultPreset, 'assistant')
})

test('allowedScopes/allowedTools 空数组非法，整份页面配置回退默认矩阵', async () => {
  for (const patch of [{ allowedScopes: [] }, { allowedTools: [] }]) {
    const res = await put({
      pages: {
        version: 1,
        bindings: [{ route: '/', entries: ['floating'], defaultPreset: 'assistant', quickPrompts: [], ...patch }],
      },
    })
    assert.equal(res.status, 200)
    assert.deepEqual((await json(res)).settings.pages, AGENT_PAGES_DEFAULTS)
  }
})

test('entries 为空数组表示隐藏入口并原样保存', async () => {
  const res = await put({
    pages: {
      version: 1,
      bindings: [{ route: '/', entries: [], defaultPreset: 'assistant', quickPrompts: [] }],
    },
  })
  assert.equal(res.status, 200)
  const pages = (await json(res)).settings.pages
  assert.equal(pages.bindings.length, 1)
  assert.deepEqual(pages.bindings[0].entries, [])
})

test('allowedScopes 只收窄作用域；导演台在分集路由始终放行，阶段绑定覆盖路由默认', () => {
  const pages = {
    version: 1,
    bindings: [
      { route: AGENT_EPISODE_ROUTE, entries: ['floating', 'stage'], defaultPreset: 'assistant', quickPrompts: [], allowedScopes: ['episode'] },
      { route: AGENT_EPISODE_ROUTE, stage: 'mix', entries: ['stage'], defaultPreset: 'assistant', quickPrompts: [], allowedScopes: ['mix'] },
    ],
  }
  assert.equal(agentPageAllowsScope({ kind: 'episode', stage: 'videos' }, pages), true)
  assert.equal(agentPageAllowsScope({ kind: 'director' }, pages), true)
  assert.equal(agentPageAllowsScope({ kind: 'mix' }, pages), true)
  assert.equal(agentPageAllowsScope({ kind: 'delivery' }, pages), false)
})

test('allowedTools 只收窄只读工具，propose_change / suggest_action 仍按配置注册', async () => {
  const res = await put({
    proposals: { enabled: true },
    suggestions: { enabled: true },
    pages: {
      version: 1,
      bindings: [{
        route: AGENT_EPISODE_ROUTE,
        entries: ['floating', 'stage'],
        defaultPreset: 'assistant',
        quickPrompts: [],
        allowedTools: ['read_storyboards', 'read_episode_context'],
      }],
    },
  })
  assert.equal(res.status, 200)

  const requestContext = buildAssistantRequestContext({
    sessionId: 1,
    messageId: 1,
    workspaceKey: 'drama:1',
    scope: { workspace_key: 'drama:1', kind: 'director', drama_id: 1, episode_id: 1 },
    preset: 'assistant',
  })
  const keys = Object.keys(getPresetTools(requestContext)).sort()
  assert.deepEqual(keys, ['propose_change', 'read_episode_context', 'read_storyboards', 'suggest_action'])
})

test('allowedTools 含提案/建议工具视为非法结构，回退默认矩阵', async () => {
  const res = await put({
    pages: {
      version: 1,
      bindings: [{
        route: AGENT_EPISODE_ROUTE,
        entries: ['floating', 'stage'],
        defaultPreset: 'assistant',
        quickPrompts: [],
        allowedTools: ['read_storyboards', 'propose_change'],
      }],
    },
  })
  assert.equal(res.status, 200)
  assert.deepEqual((await json(res)).settings.pages, AGENT_PAGES_DEFAULTS)
})

test('message.maxChars > context.maxChars 拒绝保存 400', async () => {
  const res = await put({ context: { maxChars: 4000 }, message: { maxChars: 12000 } })
  assert.equal(res.status, 400)
  assert.match((await json(res)).message, /message\.maxChars/)
})
