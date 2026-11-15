import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { defaultConfig } from '../src/shared/config.js'
import { startAgentTask, type AgentHandleLike, type ToolDefinition, type ToolRegistry } from '../src/host/agent-bridge.js'
import { TaskRegistry } from '../src/host/task-registry.js'
import type { Logger } from '../src/host/logger.js'

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-huobao-agent-'))
  return path.join(dir, 'tasks.json')
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: 'idem-1',
    huobaoTaskId: 42,
    role: 'extractor',
    taskType: 'extract',
    dramaId: 1,
    episodeId: 2,
    input: { script: 'hello' },
    ...overrides,
  }
}

test('Agent 桥创建会话并通过完成工具收敛任务', async () => {
  const registry = new TaskRegistry(tempFile())
  let registered: ToolDefinition | undefined
  let taskIdFromPrompt = ''
  const handle: AgentHandleLike = {
    agent: {
      followup(message: unknown) {
        const content = (message as { content: Array<{ text: string }> }).content[0]?.text ?? ''
        taskIdFromPrompt = /taskId 必须是 "([^"]+)"/.exec(content)?.[1] ?? ''
        void (async () => {
          await Promise.resolve()
          await registered?.execute({
            taskId: taskIdFromPrompt,
            status: 'succeeded',
            summary: '完成',
            result: { count: 1 },
          })
        })()
      },
      async whenIdle() {
        await new Promise(resolve => setTimeout(resolve, 5))
      },
      cancel() {},
      session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }] },
    },
    async dispose() {},
  }
  const agents = {
    async create(options: unknown) {
      const setup = (options as { setup?: (ctx: { tools: ToolRegistry }) => void }).setup
      const tools: ToolRegistry = {
        register(definition) {
          registered = definition
        },
      }
      setup?.({ tools })
      return handle
    },
  }
  const accepted = await startAgentTask(request(), {
    agents,
    config: defaultConfig(),
    registry,
    logger,
  })
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.dshTaskId, taskIdFromPrompt)
  const settled = await registry.waitForCompletion(accepted.dshTaskId, 1_000)
  assert.equal(settled.status, 'succeeded')
  assert.deepEqual(settled.result, { count: 1 })
})

test('相同幂等键返回既有任务', async () => {
  const registry = new TaskRegistry(tempFile())
  const agents = {
    async create(): Promise<AgentHandleLike> {
      throw new Error('should not create twice')
    },
  }
  const first = new TaskRegistry(tempFile())
  const handle: AgentHandleLike = {
    agent: {
      followup() {},
      async whenIdle() {},
      cancel() {},
    },
    async dispose() {},
  }
  const created = await startAgentTask(request(), {
    agents: { async create() { return handle } },
    config: defaultConfig(),
    registry: first,
    logger,
  })
  const second = await startAgentTask(request(), {
    agents,
    config: defaultConfig(),
    registry: first,
    logger,
  })
  assert.equal(second.dshTaskId, created.dshTaskId)
  assert.equal(second.existing, true)
  assert.equal(registry.list().length, 0)
})

test('Agent 空闲未调用完成工具时标记 INCOMPLETE_OUTPUT', async () => {
  const registry = new TaskRegistry(tempFile())
  const handle: AgentHandleLike = {
    agent: {
      followup() {},
      async whenIdle() {},
      cancel() {},
      session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '没有调用工具' }] }] },
    },
    async dispose() {},
  }
  const config = defaultConfig()
  config.timeouts.agentMs = 500
  const accepted = await startAgentTask(request(), {
    agents: { async create() { return handle } },
    config,
    registry,
    logger,
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  const task = registry.get(accepted.dshTaskId)
  assert.equal(task?.status, 'failed')
  assert.equal(task?.errorCode, 'INCOMPLETE_OUTPUT')
})

test('Agent 服务缺失返回 BRIDGE_UNAVAILABLE', async () => {
  const registry = new TaskRegistry(tempFile())
  await assert.rejects(
    () => startAgentTask(request(), { config: defaultConfig(), registry, logger }),
    (cause: unknown) => (cause as { code?: string }).code === 'BRIDGE_UNAVAILABLE',
  )
})
