/** useEditClock 卸载时关闭 AudioContext（Task 24 Minor：WebAudio 资源释放） */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const instances = []

class FakeAudioContext {
  constructor() {
    instances.push(this)
    this.currentTime = 0
    this.destination = {}
    this.closeCount = 0
  }
  async resume() {}
  decodeAudioData() {
    return Promise.resolve({ duration: 2 })
  }
  createBufferSource() {
    return {
      connect() {},
      start() {},
      stop() { throw new Error('not started') },
      disconnect() {},
      onended: null,
    }
  }
  close() {
    this.closeCount += 1
    return Promise.resolve()
  }
}

globalThis.window = { AudioContext: FakeAudioContext }
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })

const { effectScope } = await import('vue')
const { useEditClock } = await import('../app/composables/useEditClock.ts')

test('卸载时关闭 AudioContext；start() 之后可重建', async () => {
  const scope = effectScope()
  let clock
  scope.run(() => {
    clock = useEditClock({ audioUrl: () => 'static/a.wav', playing: () => false })
  })
  assert.equal(instances.length, 0, '创建 composable 不应立即建上下文')

  const started = await clock.start(0)
  assert.equal(started, true)
  assert.equal(instances.length, 1)

  scope.stop()
  assert.equal(instances[0].closeCount, 1, 'scope 释放应关闭 AudioContext')

  // close 幂等：重复释放不再报错、不重复关闭已置空的上下文
  await clock.start(0)
  assert.equal(instances.length, 2, 'close 后 start() 应重建上下文')
  assert.equal(instances[1].closeCount, 0)
})
