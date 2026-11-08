import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  findActiveTransition,
  incomingTransitionStyle,
  outgoingTransitionStyle,
  whiteFlashOpacity,
} = await import('../app/utils/edit-preview-transition.ts')

function layoutWithOverlap() {
  return {
    duration_ms: 9500,
    content_end_ms: 9500,
    clips: [
      { clip_id: 'a', timeline_start_ms: 0, timeline_end_ms: 5000, content_duration_ms: 5000 },
      { clip_id: 'b', timeline_start_ms: 4500, timeline_end_ms: 9500, content_duration_ms: 5000 },
    ],
    transitions: [{ id: 'tr_ab', from_clip_id: 'a', to_clip_id: 'b', overlap_ms: 500 }],
  }
}

function planWithTransition(type = 'dissolve') {
  return {
    clips: [],
    transitions: [{ id: 'tr_ab', fromClipId: 'a', toClipId: 'b', type, durationMs: 500 }],
  }
}

test('转场窗口：重叠区内返回进度，窗口外返回 null', () => {
  const layout = layoutWithOverlap()
  const plan = planWithTransition()
  assert.equal(findActiveTransition(plan, layout, 4499), null)
  const mid = findActiveTransition(plan, layout, 4750)
  assert.equal(mid?.type, 'dissolve')
  assert.equal(mid?.durationMs, 500)
  assert.equal(mid?.progress, 0.5)
  assert.equal(findActiveTransition(plan, layout, 5000), null)
})

test('无转场或时间不重叠时不做预览', () => {
  const layout = layoutWithOverlap()
  assert.equal(findActiveTransition({ clips: [], transitions: [] }, layout, 4600), null)
  const noOverlap = {
    ...layout,
    clips: [
      { clip_id: 'a', timeline_start_ms: 0, timeline_end_ms: 5000, content_duration_ms: 5000 },
      { clip_id: 'b', timeline_start_ms: 5000, timeline_end_ms: 10000, content_duration_ms: 5000 },
    ],
  }
  assert.equal(findActiveTransition(planWithTransition(), noOverlap, 5000), null)
})

test('入场样式：叠化淡入、左推从右侧进入、模糊由虚到实', () => {
  assert.equal(incomingTransitionStyle('dissolve', 0).opacity, '0.350')
  assert.equal(incomingTransitionStyle('dissolve', 1).opacity, '1.000')
  assert.equal(incomingTransitionStyle('push-left', 0).transform, 'translateX(100.00%)')
  assert.equal(incomingTransitionStyle('push-left', 1).transform, 'translateX(0.00%)')
  assert.match(incomingTransitionStyle('blur', 0).filter, /blur\(10\.00px\)/)
})

test('出场样式：快照按类型退场，白闪遮罩从 1 淡到 0', () => {
  assert.equal(outgoingTransitionStyle('dissolve', 0.25).opacity, '0.750')
  assert.equal(outgoingTransitionStyle('push-left', 0.5).transform, 'translateX(-50.00%)')
  assert.equal(whiteFlashOpacity('white', 0), 1)
  assert.equal(whiteFlashOpacity('white', 0.4), 0.6)
  assert.equal(whiteFlashOpacity('dissolve', 0.4), 0)
})