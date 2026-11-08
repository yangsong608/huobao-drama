import { test } from 'node:test'
import assert from 'node:assert/strict'

const { collectExportWarnings } = await import('../app/utils/edit-export-warnings.ts')

function clip(id, gapBeforeMs = 0) {
  return {
    id,
    kind: 'video',
    source: {
      kind: 'storyboard', id, url: `static/${id}.mp4`, durationMs: 10000,
      width: 1080, height: 1920, fps: 30, hasAudio: false, fingerprint: '1:1',
    },
    sourceInMs: 0,
    sourceOutMs: 5000,
    speed: 1,
    gapBeforeMs,
    videoFadeInMs: 0,
    videoFadeOutMs: 0,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    filter: { preset: 'none', intensity: 0 },
  }
}

function plan(overrides = {}) {
  return {
    version: 1,
    episodeId: 1,
    project: {
      aspect: '16:9', width: 1920, height: 1080, fps: 30,
      background: 'black', defaultFit: 'fit', defaultTransition: 'cut',
      defaultSubtitleStyle: 'default', defaultExportPreset: '1080p', tailGapMs: 0,
    },
    clips: [clip('a'), clip('b')],
    transitions: [],
    subtitles: [],
    overlays: [],
    markers: [],
    ...overrides,
  }
}

const codes = (value) => collectExportWarnings(value).map((item) => item.code)

test('可渲染的转场不再误报硬切', () => {
  const value = plan({
    transitions: [{ id: 'tr1', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationMs: 600 }],
  })
  assert.ok(!codes(value).includes('TRANSITION_HARD_CUT'))
})

test('有间隙、失效或不支持的转场仍提示硬切', () => {
  const gapped = plan({
    clips: [clip('a'), clip('b', 500)],
    transitions: [{ id: 'tr1', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationMs: 600 }],
  })
  assert.ok(codes(gapped).includes('TRANSITION_HARD_CUT'))

  const unsupported = plan({
    transitions: [{ id: 'tr1', fromClipId: 'a', toClipId: 'b', type: 'spin', durationMs: 600 }],
  })
  assert.ok(codes(unsupported).includes('TRANSITION_HARD_CUT'))

  const broken = plan({
    transitions: [{ id: 'tr1', fromClipId: 'a', toClipId: 'missing', type: 'dissolve', durationMs: 600 }],
  })
  assert.ok(codes(broken).includes('TRANSITION_HARD_CUT'))
})

test('变速 0.25–4× 不再误报夹取，超范围才提示', () => {
  const withSpeed = (speed) => plan({ clips: [clip('a'), { ...clip('b'), speed }] })
  assert.ok(!codes(withSpeed(0.25)).includes('SPEED_CLAMPED'))
  assert.ok(!codes(withSpeed(4)).includes('SPEED_CLAMPED'))
  assert.ok(!codes(withSpeed(0.5)).includes('SPEED_CLAMPED'))
  assert.ok(codes(withSpeed(0.2)).includes('SPEED_CLAMPED'))
  assert.ok(codes(withSpeed(5)).includes('SPEED_CLAMPED'))
})

test('滤镜与画面调整真实导出，不再产生降级警告', () => {
  const styled = plan({
    clips: [
      clip('a'),
      {
        ...clip('b'),
        filter: { preset: 'mono', intensity: 60 },
        transform: { scale: 1.2, x: 0.1, y: -0.1, rotation: 90, flipH: true, flipV: false },
      },
    ],
  })
  assert.ok(!codes(styled).includes('FILTER_UNSUPPORTED'))
  assert.ok(!codes(styled).includes('TRANSFORM_UNSUPPORTED'))
})