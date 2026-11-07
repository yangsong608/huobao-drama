/**
 * A0-1：生产类型与预设类型拆分、注册表 workspace 隔离、提示词管理全类型
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-agent-reg-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'

const {
  PRODUCTION_AGENT_TYPES,
  PRESET_AGENT_TYPES,
  allAgentTypes,
  validAgentTypes,
  agentRegistry,
  DEFAULT_PROMPTS,
} = await import('../src/agents/index.ts')
const { default: agentRoutes } = await import('../src/routes/agent.ts')
const { default: promptRoutes } = await import('../src/routes/prompts.ts')

const app = new Hono()
app.route('/api/v1/agent', agentRoutes)
app.route('/api/v1/prompts', promptRoutes)

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function json<T = any>(response: Response): Promise<T> {
  return response.json() as Promise<T>
}

test('类型集合：生产恰好 5 个、预设 2 个、全集 7 个', () => {
  assert.deepEqual([...PRODUCTION_AGENT_TYPES], [
    'script_rewriter',
    'extractor',
    'storyboard_breaker',
    'prompt_generator',
    'voice_designer',
  ])
  assert.deepEqual([...PRESET_AGENT_TYPES], ['assistant', 'director'])
  assert.equal(allAgentTypes.length, 7)
  assert.deepEqual(validAgentTypes, [...PRODUCTION_AGENT_TYPES])
  for (const type of allAgentTypes) {
    assert.ok(DEFAULT_PROMPTS[type]?.name, `${type} 缺少默认提示词`)
    assert.ok(DEFAULT_PROMPTS[type]?.instructions, `${type} 缺少默认指令`)
  }
})

test('注册表：7 个 Agent，生产挂 workspace，预设不挂且无文件/命令工具', async () => {
  assert.deepEqual(Object.keys(agentRegistry).sort(), [...allAgentTypes].sort())
  for (const type of PRODUCTION_AGENT_TYPES) {
    assert.equal(agentRegistry[type].hasOwnWorkspace(), true, `${type} 应保留 workspace`)
  }
  for (const type of PRESET_AGENT_TYPES) {
    const agent = agentRegistry[type]
    assert.equal(agent.hasOwnWorkspace(), false, `${type} 不得挂 workspace`)
    const tools = await agent.listTools()
    const names = Object.keys(tools)
    for (const forbidden of ['read_file', 'write_file', 'edit_file', 'delete_file', 'execute_command']) {
      assert.ok(!names.includes(forbidden), `${type} 不应包含 ${forbidden}`)
    }
  }
})

test('生产聊天入口只认五个生产 Agent', async () => {
  for (const type of PRESET_AGENT_TYPES) {
    const res = await app.request(`/api/v1/agent/${type}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', drama_id: 1, episode_id: 1 }),
    })
    assert.equal(res.status, 400)
    assert.match((await json(res)).message, /无效的 Agent 类型/)
    const debug = await app.request(`/api/v1/agent/${type}/debug`)
    assert.equal(debug.status, 400)
  }
  const ok = await app.request('/api/v1/agent/script_rewriter/debug')
  assert.equal(ok.status, 200)
})

test('/prompts 覆盖七个类型，预设可读写重置', async () => {
  const list = await json<any>(await app.request('/api/v1/prompts'))
  assert.equal(list.data.length, 7)
  assert.deepEqual(list.data.map((item: any) => item.agent_type).sort(), [...allAgentTypes].sort())

  const initial = await json<any>(await app.request('/api/v1/prompts/assistant'))
  assert.equal(initial.data.name, '助手')
  assert.equal(initial.data.is_default, true)
  assert.match(initial.data.system_prompt, /只读创作助手/)

  const saved = await app.request('/api/v1/prompts/assistant', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '助手', model: 'test-model', system_prompt: '自定义助手规则' }),
  })
  assert.equal(saved.status, 200)
  const afterSave = await json<any>(await app.request('/api/v1/prompts/assistant'))
  assert.equal(afterSave.data.system_prompt, '自定义助手规则')
  assert.equal(afterSave.data.model, 'test-model')
  assert.equal(afterSave.data.is_default, false)

  const localized = await app.request('/api/v1/prompts/assistant?lang=en', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Assistant', model: 'wrong-model', system_prompt: 'English rules' }),
  })
  assert.equal(localized.status, 200)
  const baseStill = await json<any>(await app.request('/api/v1/prompts/assistant'))
  assert.equal(baseStill.data.model, 'test-model')
  const en = await json<any>(await app.request('/api/v1/prompts/assistant?lang=en'))
  assert.equal(en.data.system_prompt, 'English rules')
  assert.equal(en.data.model, 'test-model')

  const director = await json<any>(await app.request('/api/v1/prompts/director'))
  assert.equal(director.data.name, '导演专员')
  assert.match(director.data.system_prompt, /导演计划与分镜/)

  const reset = await app.request('/api/v1/prompts/assistant/reset', { method: 'POST' })
  assert.equal(reset.status, 200)
  const afterReset = await json<any>(await app.request('/api/v1/prompts/assistant'))
  assert.equal(afterReset.data.system_prompt, DEFAULT_PROMPTS.assistant.instructions)
  assert.equal(afterReset.data.is_default, true)
})
