import { test } from 'node:test'
import assert from 'node:assert/strict'

const { fitTimelineZoom, TIMELINE_ZOOM_MIN, TIMELINE_ZOOM_MAX } = await import('../app/utils/timeline-zoom.ts')

test('fit zoom uses the full width minus the trailing timeline padding', () => {
  assert.equal(fitTimelineZoom(1160, 60000), 16.66)
  assert.equal(fitTimelineZoom(1160, 10000), 100)
})

test('fit zoom clamps to the supported zoom range', () => {
  assert.equal(fitTimelineZoom(5000, 1000), TIMELINE_ZOOM_MAX)
  assert.equal(fitTimelineZoom(400, 600000), TIMELINE_ZOOM_MIN)
  assert.equal(fitTimelineZoom(0, 60000), TIMELINE_ZOOM_MIN)
  assert.equal(fitTimelineZoom(1160, 0), TIMELINE_ZOOM_MIN)
})

test('fitted timeline never overflows the viewport horizontally', () => {
  for (const [width, durationMs] of [[1160, 60000], [900, 300000], [1440, 240000]]) {
    const zoom = fitTimelineZoom(width, durationMs)
    const contentWidth = Math.ceil((durationMs / 1000) * zoom) + 160
    assert.ok(contentWidth <= width, `${contentWidth} <= ${width}`)
  }
})