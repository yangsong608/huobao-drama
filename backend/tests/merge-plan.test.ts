import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
  buildMergeTransitionGraph,
  mergeTransitionDurationMs,
  mergeTransitionStyle,
} from '../src/services/merge-plan.js'

test('转场类型只认 fade/dissolve/wipe，其余按硬切', () => {
  assert.equal(mergeTransitionStyle('fade'), 'fade')
  assert.equal(mergeTransitionStyle('dissolve'), 'dissolve')
  assert.equal(mergeTransitionStyle('wipe'), 'wipeleft')
  assert.equal(mergeTransitionStyle('cut'), null)
  assert.equal(mergeTransitionStyle('unknown'), null)
})

test('转场时长按相邻镜头较短者的 20% 计算并夹在 120–500ms', () => {
  assert.equal(mergeTransitionDurationMs(10_000, 10_000), 500)
  assert.equal(mergeTransitionDurationMs(2_000, 10_000), 400)
  assert.equal(mergeTransitionDurationMs(400, 10_000), MIN_TRANSITION_MS)
  assert.equal(mergeTransitionDurationMs(1_000, 1_000), 200)
  assert.equal(MAX_TRANSITION_MS, 500)
})

test('硬切用 concat，转场用 xfade 且 offset 扣掉重叠时长', () => {
  const { graph, totalMs, usedTransitions } = buildMergeTransitionGraph([
    { durationMs: 10_000, transition: 'cut' },
    { durationMs: 10_000, transition: 'fade' },
    { durationMs: 10_000, transition: 'cut' },
    { durationMs: 10_000, transition: 'dissolve' },
  ], 1920, 1080)

  assert.match(graph, /\[v0\]\[v1\]xfade=transition=fade:duration=0\.500:offset=9\.500\[v1x\]/)
  assert.match(graph, /\[a0\]\[a1\]acrossfade=d=0\.500:c1=tri:c2=tri\[a1x\]/)
  assert.match(graph, /\[v1x\]\[v2\]concat=n=2:v=1:a=0\[v2x\]/)
  assert.match(graph, /\[v2x\]\[v3\]xfade=transition=dissolve:duration=0\.500:offset=29\.000\[v3x\]/)
  assert.match(graph, /\[a3x\]loudnorm=I=-16\.5:TP=-3\.0:LRA=11\[aout\]/)
  assert.match(graph, /\[v3x\]null\[vout\]/)
  assert.equal(usedTransitions.length, 2)
  // 10 + (10 - 0.5) + 10 + (10 - 0.5)
  assert.equal(totalMs, 39_000)
})

test('相邻镜头过短时退化为硬切，避免 xfade 吞掉画面', () => {
  const { graph, usedTransitions } = buildMergeTransitionGraph([
    { durationMs: 500, transition: 'cut' },
    { durationMs: 500, transition: 'fade' },
  ], 1280, 720)
  assert.match(graph, /concat=n=2:v=1:a=0/)
  assert.equal(usedTransitions.length, 0)
})
