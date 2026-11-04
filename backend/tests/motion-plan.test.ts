import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_SHOT_MS,
  MIN_SHOT_MS,
  TRANSITION_MS,
  buildBgmOnlyFilter,
  buildXfadePlan,
  buildZoompanFilter,
  estimateShotDurationMs,
  pickShotMotion,
} from '../src/services/motion-plan.js'

test('有配音的镜头时长 = 音频时长 + 0.6s，并夹在 2.5–8s', () => {
  assert.equal(estimateShotDurationMs('任意文本', 3000), 3600)
  assert.equal(estimateShotDurationMs('任意文本', 1000), MIN_SHOT_MS)
  assert.equal(estimateShotDurationMs('任意文本', 9000), MAX_SHOT_MS)
})

test('无配音的镜头按 4.5 字/秒估算并夹在 2.5–8s', () => {
  assert.equal(estimateShotDurationMs('一二三四五六七八九', null), 2500)
  assert.equal(estimateShotDurationMs('一'.repeat(18), null), 4000)
  assert.equal(estimateShotDurationMs('一'.repeat(100), null), MAX_SHOT_MS)
})

test('景别决定推拉：特写/近景拉近，全景/远景拉远或横移，其余按镜号交替', () => {
  assert.equal(pickShotMotion('特写', 0), 'zoom_in')
  assert.equal(pickShotMotion('近景', 1), 'zoom_in')
  assert.equal(pickShotMotion('全景', 0), 'zoom_out')
  assert.equal(pickShotMotion('远景', 1), 'pan_left')
  assert.equal(pickShotMotion('远景', 2), 'pan_right')
  assert.equal(pickShotMotion('中景', 0), 'zoom_in')
  assert.equal(pickShotMotion('中景', 1), 'zoom_out')
  assert.equal(pickShotMotion(null, 2), 'zoom_in')
})

test('推拉滤镜从 1.0 到 1.12 匀速，横移保持放大并覆盖全宽', () => {
  const zoomIn = buildZoompanFilter('zoom_in', 1920, 1080, 120)
  assert.match(zoomIn, /min\(1\+/)
  assert.match(zoomIn, /1\.12/)
  assert.match(zoomIn, /s=1920x1080/)
  assert.match(zoomIn, /fps=24/)

  const zoomOut = buildZoompanFilter('zoom_out', 1920, 1080, 120)
  assert.match(zoomOut, /max\(1\.12-/)

  const panLeft = buildZoompanFilter('pan_left', 1080, 1920, 240)
  assert.match(panLeft, /z='1\.12'/)
  assert.match(panLeft, /\(iw-iw\/zoom\)\*\(1-on\/240\)/)
  assert.match(panLeft, /s=1080x1920/)

  const panRight = buildZoompanFilter('pan_right', 1080, 1920, 240)
  assert.match(panRight, /\(iw-iw\/zoom\)\*on\/240/)
})

test('转场计划：每个镜头补 0.5s 尾巴，offset 按累计时长，成片总长不变', () => {
  const plan = buildXfadePlan([3000, 4000, 5000])
  assert.equal(plan.totalMs, 12000)
  assert.equal(plan.transitionMs, TRANSITION_MS)
  assert.deepEqual(plan.renderDurationsMs, [3500, 4500, 5500])
  assert.match(plan.graph, /\[0:v\]\[1:v\]xfade=transition=fade:duration=0\.500:offset=3\.000\[v1\]/)
  assert.match(plan.graph, /\[v1\]\[2:v\]xfade=transition=fade:duration=0\.500:offset=7\.000\[vout\]/)
})

test('单个镜头不做转场，成片总长与镜头一致', () => {
  const plan = buildXfadePlan([2500])
  assert.equal(plan.totalMs, 2500)
  assert.deepEqual(plan.renderDurationsMs, [2500])
  assert.equal(plan.graph, '[0:v]null[vout]')
})

test('无配音只有 BGM 时循环播放、0.18 音量、片尾 2s 淡出', () => {
  const filter = buildBgmOnlyFilter(0.18, 12)
  assert.equal(filter, 'volume=0.18,afade=t=out:st=10.000:d=2')
})
