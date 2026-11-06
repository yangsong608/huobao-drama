import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createEditSaveQueue } = await import('../app/utils/edit-save.ts')
const {
  recoveryKey,
  planFingerprint,
  writeRecovery,
  readRecovery,
  clearRecovery,
  shouldOfferRecovery,
} = await import('../app/utils/edit-recovery.ts')

function plan(tailGapMs = 0) {
  return {
    version: 1,
    episodeId: 1,
    project: {
      aspect: '16:9', width: 1920, height: 1080, fps: 30,
      background: 'black', defaultFit: 'fit', defaultTransition: 'cut',
      defaultSubtitleStyle: 'default', defaultExportPreset: '1080p', tailGapMs,
    },
    clips: [],
    transitions: [],
    subtitles: [],
    overlays: [],
    markers: [],
  }
}

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
  }
}

test('300ms 防抖只保存最后一次计划', async () => {
  const calls = []
  const queue = createEditSaveQueue({
    delayMs: 5,
    save: async (value) => { calls.push(value.project.tailGapMs) },
  })
  queue.schedule(plan(100))
  queue.schedule(plan(200))
  assert.equal(queue.pending(), true)
  await queue.flush()
  assert.deepEqual(calls, [200])
  assert.equal(queue.pending(), false)
})

test('保存失败调用 onError，后续计划继续保存', async () => {
  const errors = []
  const saved = []
  let attempt = 0
  const queue = createEditSaveQueue({
    delayMs: 0,
    save: async (value) => {
      attempt += 1
      if (attempt === 1) throw new Error('网络断开')
      saved.push(value.project.tailGapMs)
    },
    onError: (error) => errors.push(error.message),
  })
  queue.schedule(plan(100))
  await queue.flush()
  queue.schedule(plan(200))
  await queue.flush()
  assert.deepEqual(errors, ['网络断开'])
  assert.deepEqual(saved, [200])
})

test('cancel 丢弃尚未执行的计划', async () => {
  const calls = []
  const queue = createEditSaveQueue({
    delayMs: 20,
    save: async (value) => { calls.push(value) },
  })
  queue.schedule(plan(300))
  queue.cancel()
  await queue.flush()
  assert.deepEqual(calls, [])
})

test('本地恢复记录可写入、读取、比对与清除', () => {
  const storage = memoryStorage()
  const base = plan(100)
  const next = plan(200)
  writeRecovery(storage, 9, next, 3, '2026-11-06T10:00:00.000Z')
  const record = readRecovery(storage, 9)
  assert.equal(record.episodeId, 9)
  assert.equal(record.baseVersion, 3)
  assert.equal(record.plan.project.tailGapMs, 200)
  assert.equal(record.savedAt, '2026-11-06T10:00:00.000Z')
  assert.equal(record.planHash, planFingerprint(next))
  assert.equal(shouldOfferRecovery(record, base), true)
  assert.equal(shouldOfferRecovery(record, next), false)

  clearRecovery(storage, 9)
  assert.equal(readRecovery(storage, 9), null)
  assert.equal(recoveryKey(9), 'huobao.edit.recovery.9')
})

test('损坏的恢复记录返回 null', () => {
  const storage = memoryStorage()
  storage.setItem(recoveryKey(1), '{bad json')
  assert.equal(readRecovery(storage, 1), null)
  storage.setItem(recoveryKey(1), JSON.stringify({ episodeId: 2, plan: {}, baseVersion: 0 }))
  assert.equal(readRecovery(storage, 1), null)
})
