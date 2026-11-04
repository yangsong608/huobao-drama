import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStoryboardUpdateQueue } from '../app/utils/storyboard-update-queue.ts'

const episode = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')

async function waitIdle(queue) {
  for (let i = 0; i < 200; i++) {
    if (!queue.hasPending()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('分镜更新队列未在预期时间内结束')
}

test('请求失败后保留补丁，并优先采用期间产生的新改动', async () => {
  const calls = []
  let attempt = 0
  const queue = createStoryboardUpdateQueue({
    update: async (id, payload) => {
      calls.push({ id, payload })
      attempt++
      if (attempt === 1) throw new Error('network')
    },
    onError: () => {},
    onRollback: async () => {},
  })

  queue.queue(7, { character_ids: [1] })
  await new Promise(resolve => setTimeout(resolve, 0))
  queue.queue(7, { prop_ids: [2] })
  await waitIdle(queue)

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].payload, { character_ids: [1], prop_ids: [2] })
  assert.equal(queue.hasPending(), false)
})

test('重试达到上限后回滚界面并只提示一次', async () => {
  const calls = []
  const errors = []
  const resyncs = []
  const queue = createStoryboardUpdateQueue({
    update: async (id, payload) => {
      calls.push({ id, payload })
      throw new Error('still failing')
    },
    onError: error => errors.push(error),
    onRollback: async () => { resyncs.push(true) },
  })

  queue.queue(9, { scene_id: 3 })
  await waitIdle(queue)

  assert.equal(calls.length, 3)
  assert.equal(errors.length, 1)
  assert.equal(resyncs.length, 1)
  assert.equal(queue.hasPending(), false)
})

test('页面离开前提示未保存改动，并在卸载时继续冲刷待发补丁', () => {
  assert.match(episode, /function warnPendingStoryboardUpdates/)
  assert.match(episode, /addEventListener\('beforeunload', warnPendingStoryboardUpdates\)/)
  assert.match(episode, /removeEventListener\('beforeunload', warnPendingStoryboardUpdates\)/)
  assert.match(episode, /onBeforeUnmount\(\(\) => \{[\s\S]{0,400}flushPendingStoryboardUpdates\(\)/)
})
