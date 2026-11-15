import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { apply } from '../src/host/index.js'
import type { Logger } from '../src/host/logger.js'

const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

test('apply 启动专用桥、写描述文件并可清理', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-huobao-host-'))
  const config = path.join(dir, 'config.json')
  const tasks = path.join(dir, 'tasks.json')
  const descriptor = path.join(dir, 'bridge.json')
  const runtime = path.join(dir, 'huobao-runtime.json')
  const previous = {
    config: process.env.MOSS_HUOBAO_CONFIG,
    tasks: process.env.MOSS_HUOBAO_TASKS,
    descriptor: process.env.MOSS_HUOBAO_BRIDGE_DESCRIPTOR,
    runtime: process.env.HUOBAO_RUNTIME_FILE,
  }
  process.env.MOSS_HUOBAO_CONFIG = config
  process.env.MOSS_HUOBAO_TASKS = tasks
  process.env.MOSS_HUOBAO_BRIDGE_DESCRIPTOR = descriptor
  process.env.HUOBAO_RUNTIME_FILE = runtime

  let cleanup: (() => void) | undefined
  const services: Record<string, unknown> = {
    llm: {
      listProviders: () => ['deepseek-official'],
      async *stream() {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    agents: {
      async create() {
        throw new Error('not used')
      },
    },
  }
  const ctx = {
    effect: (callback: () => (() => void) | void) => {
      cleanup = callback() as (() => void) | undefined
      return () => {}
    },
    get: (name: string) => services[name],
    logger,
  }

  try {
    await apply(ctx)
    assert.equal(fs.existsSync(descriptor), true)
    const raw = JSON.parse(fs.readFileSync(descriptor, 'utf8')) as { bridgeBaseUrl: string; token: string }
    assert.match(raw.bridgeBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/moss-huobao$/)
    assert.match(raw.token, /^[0-9a-f]{64}$/)

    const health = await fetch(`${raw.bridgeBaseUrl}/health`, {
      headers: { authorization: `Bearer ${raw.token}` },
    })
    assert.equal(health.status, 200)
    const body = await health.json() as { llmBridge: boolean; agentBridge: boolean; huobaoApi: string }
    assert.equal(body.llmBridge, true)
    assert.equal(body.agentBridge, true)
    assert.equal(body.huobaoApi, 'unknown')

    assert.ok(cleanup !== undefined)
    cleanup()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(fs.existsSync(descriptor), false)
  } finally {
    if (previous.config === undefined) delete process.env.MOSS_HUOBAO_CONFIG
    else process.env.MOSS_HUOBAO_CONFIG = previous.config
    if (previous.tasks === undefined) delete process.env.MOSS_HUOBAO_TASKS
    else process.env.MOSS_HUOBAO_TASKS = previous.tasks
    if (previous.descriptor === undefined) delete process.env.MOSS_HUOBAO_BRIDGE_DESCRIPTOR
    else process.env.MOSS_HUOBAO_BRIDGE_DESCRIPTOR = previous.descriptor
    if (previous.runtime === undefined) delete process.env.HUOBAO_RUNTIME_FILE
    else process.env.HUOBAO_RUNTIME_FILE = previous.runtime
  }
})

test('桥描述文件写入失败时不保留桥接服务', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-huobao-host-bad-'))
  const blocked = path.join(dir, 'blocked')
  fs.writeFileSync(blocked, 'not a dir')
  const previous = {
    config: process.env.MOSS_HUOBAO_CONFIG,
    tasks: process.env.MOSS_HUOBAO_TASKS,
    descriptor: process.env.MOSS_HUOBAO_BRIDGE_DESCRIPTOR,
  }
  process.env.MOSS_HUOBAO_CONFIG = path.join(dir, 'config.json')
  process.env.MOSS_HUOBAO_TASKS = path.join(dir, 'tasks.json')
  process.env.MOSS_HUOBAO_BRIDGE_DESCRIPTOR = path.join(blocked, 'bridge.json')
  const ctx = {
    effect: () => () => {},
    get: () => undefined,
    logger,
  }
  try {
    await apply(ctx)
    assert.equal(fs.existsSync(path.join(blocked, 'bridge.json')), false)
  } finally {
    if (previous.config === undefined) delete process.env.MOSS_HUOBAO_CONFIG
    else process.env.MOSS_HUOBAO_CONFIG = previous.config
    if (previous.tasks === undefined) delete process.env.MOSS_HUOBAO_TASKS
    else process.env.MOSS_HUOBAO_TASKS = previous.tasks
    if (previous.descriptor === undefined) delete process.env.MOSS_HUOBAO_BRIDGE_DESCRIPTOR
    else process.env.MOSS_HUOBAO_BRIDGE_DESCRIPTOR = previous.descriptor
  }
})
