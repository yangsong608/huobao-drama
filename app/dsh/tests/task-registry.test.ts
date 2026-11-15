import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { TaskRegistry } from '../src/host/task-registry.js'

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-huobao-tasks-'))
  return path.join(dir, 'tasks.json')
}

function create(registry: TaskRegistry, id = 't1', key = 'idem-1') {
  return registry.create({
    dshTaskId: id,
    huobaoTaskId: 10,
    role: 'extractor',
    taskType: 'extract',
    idempotencyKey: key,
  })
}

test('创建、幂等、运行与成功完成', async () => {
  const file = tempFile()
  const registry = new TaskRegistry(file)
  const { task, existing } = create(registry)
  assert.equal(existing, false)
  assert.equal(task.status, 'queued')
  assert.equal(create(registry).existing, true)
  registry.setRunning('t1', 'session-1')
  const wait = registry.waitForCompletion('t1', 1_000)
  registry.completeFromTool('t1', {
    taskId: 't1',
    status: 'succeeded',
    summary: 'ok',
    result: { count: 2 },
  })
  const settled = await wait
  assert.equal(settled.status, 'succeeded')
  assert.deepEqual(settled.result, { count: 2 })
  assert.equal(registry.counts().succeeded, 1)
})

test('失败标记 fallbackSuggested 并记录错误', () => {
  const file = tempFile()
  const registry = new TaskRegistry(file)
  create(registry)
  registry.setRunning('t1', 'session-1')
  const failed = registry.fail('t1', 'UPSTREAM_ERROR', 'boom')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.fallbackSuggested, true)
  assert.equal(registry.getLastError(), 'UPSTREAM_ERROR: boom')
})

test('落盘后重新加载，活动任务收敛为 interrupted', () => {
  const file = tempFile()
  const first = new TaskRegistry(file, undefined, () => '2026-11-13T00:00:00.000Z')
  create(first)
  first.setRunning('t1', 'session-1')
  const second = new TaskRegistry(file, undefined, () => '2026-11-13T00:01:00.000Z')
  second.load()
  const task = second.get('t1')
  assert.equal(task?.status, 'interrupted')
  assert.equal(task?.errorCode, 'INTERRUPTED')
  assert.equal(second.counts().failed, 1)
})

test('取消与孤儿状态是终态', () => {
  const file = tempFile()
  const registry = new TaskRegistry(file)
  create(registry)
  registry.setRunning('t1', 'session-1')
  assert.equal(registry.cancel('t1').status, 'cancelled')
  create(registry, 't2', 'idem-2')
  registry.setRunning('t2', 'session-2')
  registry.markOrphaned('t2')
  assert.equal(registry.get('t2')?.status, 'orphaned')
})
