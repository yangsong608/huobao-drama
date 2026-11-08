import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  findActiveTransition,
  incomingTransitionStyle,
  outgoingTransitionStyle,
  whiteFlashOpacity,
  blackFlashOpacity,
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

test('入场样式：缩放推近/挤压/裁切二段式，其余类型由快照层承担', () => {
  assert.equal(incomingTransitionStyle('dissolve', 0.5).opacity, undefined)
  assert.equal(incomingTransitionStyle('zoom-in', 0).transform, 'scale(0.350)')
  assert.equal(incomingTransitionStyle('zoom-in', 1).transform, 'scale(1.000)')
  assert.equal(incomingTransitionStyle('squeeze-h', 0.75).transform, 'scaleX(0.500)')
  assert.equal(incomingTransitionStyle('circle-crop', 0.75).transform, 'scale(0.750)')
  assert.equal(incomingTransitionStyle('black', 0.75).opacity, '0.500')
  assert.deepEqual(incomingTransitionStyle('wipe-left', 0.5), {})
})

test('出场样式：46 种各有专属退场（位移/裁切/挖孔/缩放/透明度）', () => {
  // fade 家族：透明度退场
  assert.equal(outgoingTransitionStyle('dissolve', 0.25).opacity, '0.750')
  // 位移家族
  assert.equal(outgoingTransitionStyle('push-left', 0.5).transform, 'translateX(-50.00%)')
  assert.equal(outgoingTransitionStyle('smooth-up', 0.5).transform, 'translateY(-50.00%)')
  // 裁切家族：擦除方向与 ffmpeg 语义一致
  assert.equal(outgoingTransitionStyle('wipe-left', 0.5).clipPath, 'inset(0 0 0 50.00%)')
  assert.equal(outgoingTransitionStyle('wipe-up', 0.5).clipPath, 'inset(50.00% 0 0 0)')
  assert.match(outgoingTransitionStyle('corner-wipe-tl', 0.5).clipPath, /polygon/)
  assert.match(outgoingTransitionStyle('diagonal-br', 0.25).clipPath, /polygon/)
  // 挖孔家族：中心 mask 揭示入场画面
  assert.match(outgoingTransitionStyle('circle-open', 0.5).maskImage, /radial-gradient/)
  assert.match(outgoingTransitionStyle('radial', 0.5).maskImage, /radial-gradient/)
  // 开合缩放家族
  assert.equal(outgoingTransitionStyle('vertical-open', 0.5).transform, 'scaleY(0.500)')
  assert.equal(outgoingTransitionStyle('horizontal-close', 0.5).clipPath, 'inset(0 25.00% 0 25.00%)')
  assert.equal(outgoingTransitionStyle('squeeze-h', 0.25).transform, 'scaleX(0.500)')
  assert.equal(outgoingTransitionStyle('squeeze-h', 0.75).opacity, '0')
  // 切片斜切家族
  assert.match(outgoingTransitionStyle('slice-hl', 0.5).clipPath, /inset/)
  assert.match(outgoingTransitionStyle('slice-vu', 0.5).transform, /skewY/)
  // 二段式裁切：后半程快照退场交由入场缩放
  assert.equal(outgoingTransitionStyle('circle-crop', 0.75).opacity, '0')
  assert.equal(outgoingTransitionStyle('rect-crop', 0.25).clipPath, 'inset(12.50%)')
  assert.equal(outgoingTransitionStyle('rect-crop', 0.75).opacity, '0')
  // 滤镜家族
  assert.match(outgoingTransitionStyle('gray-fade', 0.5).filter, /grayscale/)
  assert.match(outgoingTransitionStyle('blur', 0.5).filter, /blur/)
  assert.match(outgoingTransitionStyle('pixelize', 0.5).filter, /contrast/)
})

test('遮罩曲线：白闪/黑场都在中点到达峰值，其他类型恒为 0', () => {
  assert.equal(whiteFlashOpacity('white', 0), 0)
  assert.equal(whiteFlashOpacity('white', 0.5), 1)
  assert.equal(whiteFlashOpacity('white', 1), 0)
  assert.equal(blackFlashOpacity('black', 0.5), 1)
  assert.equal(blackFlashOpacity('black', 0.25), 0.5)
  assert.equal(whiteFlashOpacity('black', 0.5), 0)
  assert.equal(blackFlashOpacity('dissolve', 0.5), 0)
})