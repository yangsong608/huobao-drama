/**
 * 按接口隔离的并发调度：
 * - 同一 key 遵守并发上限 / 串行链
 * - 不同 key 互不阻塞（不同服务商、不同模型、不同配置）
 * - 视频按配置有默认上限；图片未配置时不额外限流
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withKeyedChain, withKeyedSlot } from '../src/services/keyed-semaphore.ts'
import { providerConcurrency, withProviderSlot } from '../src/services/provider-concurrency.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('同一接口的并发槽位遵守上限，超出的调用排队', async () => {
  let active = 0
  let maxActive = 0
  const run = async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await sleep(15)
    active -= 1
  }
  await Promise.all([
    withKeyedSlot('same', 1, run),
    withKeyedSlot('same', 1, run),
    withKeyedSlot('same', 1, run),
  ])
  assert.equal(maxActive, 1)
})

test('同一接口上限为 2 时允许两个并发，第三个等待', async () => {
  let active = 0
  let maxActive = 0
  const gate = deferred()
  const run = async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await gate.promise
    active -= 1
  }
  const first = withKeyedSlot('limit-2', 2, run)
  const second = withKeyedSlot('limit-2', 2, run)
  const third = withKeyedSlot('limit-2', 2, run)
  await sleep(10)
  assert.equal(active, 2)
  gate.resolve()
  await Promise.all([first, second, third])
  assert.equal(maxActive, 2)
})

test('不同接口互不阻塞：各自 limit=1 也能同时进入', async () => {
  let entered = 0
  const gate = deferred()
  const run = async () => {
    entered += 1
    await gate.promise
  }
  const first = withKeyedSlot('interface-a', 1, run)
  const second = withKeyedSlot('interface-b', 1, run)
  await sleep(10)
  assert.equal(entered, 2, '不同接口不应共享信号量')
  gate.resolve()
  await Promise.all([first, second])
})

test('串行链按 key 隔离：同 key 顺序执行，不同 key 并行', async () => {
  const order: string[] = []
  const gate = deferred()
  const first = withKeyedChain('chain-a', async () => {
    order.push('a1-start')
    await gate.promise
    order.push('a1-end')
  })
  const second = withKeyedChain('chain-a', async () => {
    order.push('a2-start')
  })
  const other = withKeyedChain('chain-b', async () => {
    order.push('b-start')
  })
  await sleep(10)
  assert.deepEqual(order, ['a1-start', 'b-start'], '不同 key 不应排队')
  gate.resolve()
  await Promise.all([first, second, other])
  assert.deepEqual(order, ['a1-start', 'b-start', 'a1-end', 'a2-start'])
})

test('视频并发默认 5、可配置并夹取 1–10；图片未配置时不限流', () => {
  assert.equal(providerConcurrency('video', {}), 5)
  assert.equal(providerConcurrency('video', null), 5)
  assert.equal(providerConcurrency('video', { concurrency: 0 }), 5)
  assert.equal(providerConcurrency('video', { concurrency: 2 }), 2)
  assert.equal(providerConcurrency('video', { concurrency: 99 }), 10)
  assert.equal(providerConcurrency('image', {}), 0)
  assert.equal(providerConcurrency('image', { concurrency: 3 }), 3)
})

test('视频同配置受上限约束，不同配置并行', async () => {
  const configA = { id: 901, provider: 'firemux', baseUrl: 'https://a.example', model: 'h3', settings: { concurrency: 1 } }
  const configB = { id: 902, provider: 'firemux', baseUrl: 'https://b.example', model: 'h3', settings: { concurrency: 1 } }

  let activeA = 0
  let maxA = 0
  const gate = deferred()
  const first = withProviderSlot('video', configA, async () => {
    activeA += 1
    maxA = Math.max(maxA, activeA)
    await gate.promise
    activeA -= 1
  })
  const second = withProviderSlot('video', configA, async () => {
    activeA += 1
    maxA = Math.max(maxA, activeA)
    activeA -= 1
  })
  let enteredB = false
  const third = withProviderSlot('video', configB, async () => {
    enteredB = true
  })
  await sleep(10)
  assert.equal(activeA, 1, '同配置第二个任务应等待')
  assert.equal(enteredB, true, '不同配置不受影响')
  gate.resolve()
  await Promise.all([first, second, third])
  assert.equal(maxA, 1)
})
