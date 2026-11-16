import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateLineSeconds, fitVoiceTiming } from '../src/services/voice-timing-fit.ts'

test('真实样音可拟合角色语速与句间停顿', () => {
  const fit = fitVoiceTiming([
    { chars: 10, durationSeconds: 2 },
    { chars: 30, durationSeconds: 5 },
  ])
  assert.ok(fit)
  assert.equal(fit!.charsPerSecond, 6.67)
  assert.equal(fit!.pauseSeconds, 0.5)
})

test('单样本保留观测语速，不引入固定 6 字/秒', () => {
  const fit = fitVoiceTiming([{ chars: 24, durationSeconds: 2.4 }])
  assert.ok(fit)
  assert.equal(fit!.charsPerSecond, 10)
  assert.equal(fit!.pauseSeconds, 0)
  const seconds = estimateLineSeconds('这是十个字左右的一句话', fit)
  assert.ok(seconds < 2)
})

test('异常样本不参与拟合', () => {
  assert.equal(fitVoiceTiming([]), null)
  assert.equal(fitVoiceTiming([{ chars: 0, durationSeconds: 2 }]), null)
  assert.equal(fitVoiceTiming([{ chars: 10, durationSeconds: 100 }]), null)
})

test('没有档案时回到默认语速与气口', () => {
  assert.equal(estimateLineSeconds('一二三四五六', undefined), 1.25)
})