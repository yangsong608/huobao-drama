import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_CLIP_FRAMES,
  aspectOf,
  bootstrapFps,
  clipContentDurationMs,
  computeLayout,
  createEmptyEditPlan,
  createSingleClipPlan,
  minimumClipMs,
  projectSettingsForAspect,
  type EditClip,
  type EditClipSource,
  type EditOverlay,
  type EditPlanV1,
  type EditProjectSettings,
} from '../src/services/edit-plan.ts'

const project: EditProjectSettings = projectSettingsForAspect('9:16', 30)

function source(id = 1, durationMs = 60000): EditClipSource {
  return {
    kind: 'episode-video',
    id,
    url: `static/projects/1/videos/${id}.mp4`,
    durationMs,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: true,
    fingerprint: `${durationMs}:1000`,
    label: `片段 ${id}`,
  }
}

function clip(id: string, durationMs: number, patch: Partial<EditClip> = {}): EditClip {
  return {
    id,
    kind: 'video',
    source: source(1, 60000),
    sourceInMs: 0,
    sourceOutMs: durationMs,
    speed: 1,
    gapBeforeMs: 0,
    videoFadeInMs: 0,
    videoFadeOutMs: 0,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    filter: { preset: 'none', intensity: 100 },
    ...patch,
  }
}

function textOverlay(endMs: number): EditOverlay {
  return {
    id: 'ov_1',
    kind: 'text',
    text: {
      text: '标题',
      preset: 'title',
      fontFamily: 'sans-serif',
      fontSize: 48,
      color: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 0,
      backgroundColor: null,
      align: 'center',
      x: 0.5,
      y: 0.2,
    },
    startMs: 0,
    endMs,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    opacity: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    track: 0,
  }
}

test('工程默认值、画幅与帧率归一', () => {
  assert.equal(aspectOf('9:16'), '9:16')
  assert.equal(aspectOf('4:3'), '16:9')

  assert.equal(bootstrapFps(23.976), 24)
  assert.equal(bootstrapFps(25), 25)
  assert.equal(bootstrapFps(29.97), 30)
  assert.equal(bootstrapFps(60), 30)
  assert.equal(bootstrapFps(12), 30)
  assert.equal(bootstrapFps(null), 30)

  assert.equal(minimumClipMs(30), 100)
  assert.equal(minimumClipMs(24), 125)
  assert.equal(MIN_CLIP_FRAMES, 3)

  const vertical = projectSettingsForAspect('9:16', 60)
  assert.deepEqual(
    { aspect: vertical.aspect, width: vertical.width, height: vertical.height, fps: vertical.fps, preset: vertical.defaultExportPreset },
    { aspect: '9:16', width: 1080, height: 1920, fps: 30, preset: 'vertical-hd' },
  )
  const horizontal = projectSettingsForAspect('16:9', 24)
  assert.deepEqual(
    { width: horizontal.width, height: horizontal.height, fps: horizontal.fps, preset: horizontal.defaultExportPreset },
    { width: 1920, height: 1080, fps: 24, preset: 'horizontal-hd' },
  )
  const square = projectSettingsForAspect('1:1', 25)
  assert.deepEqual(
    { width: square.width, height: square.height, preset: square.defaultExportPreset },
    { width: 1080, height: 1080, preset: 'square-hd' },
  )
})

test('空计划与单片段计划', () => {
  const empty = createEmptyEditPlan(42, project)
  assert.equal(empty.version, 1)
  assert.equal(empty.episodeId, 42)
  assert.deepEqual(empty.clips, [])
  assert.deepEqual(empty.transitions, [])
  assert.deepEqual(computeLayout(empty), { contentEndMs: 0, durationMs: 0, clips: [], transitions: [] })

  const single = createSingleClipPlan(42, source(7, 12000), project)
  assert.equal(single.clips.length, 1)
  assert.equal(single.clips[0].source.kind, 'episode-video')
  assert.equal(single.clips[0].source.id, 7)
  assert.equal(single.clips[0].sourceInMs, 0)
  assert.equal(single.clips[0].sourceOutMs, 12000)
  assert.equal(single.clips[0].speed, 1)
  assert.equal(clipContentDurationMs(single.clips[0]), 12000)

  const layout = computeLayout(single)
  assert.equal(layout.contentEndMs, 12000)
  assert.equal(layout.durationMs, 12000)
})

test('布局：片头空档、转场重叠、片段空档、尾段与叠加轨', () => {
  const plan = createEmptyEditPlan(1, { ...project, tailGapMs: 500 })
  plan.clips = [
    clip('clp_a', 5000, { gapBeforeMs: 1000 }),
    clip('clp_b', 4000, { gapBeforeMs: 300, source: source(2, 60000) }),
  ]
  plan.transitions = [{
    id: 'tr_1',
    fromClipId: 'clp_a',
    toClipId: 'clp_b',
    type: 'dissolve',
    durationMs: 400,
  }]
  plan.overlays = [textOverlay(9600)]

  const layout = computeLayout(plan)
  assert.deepEqual(layout.clips, [
    { clipId: 'clp_a', timelineStartMs: 1000, timelineEndMs: 6000, contentDurationMs: 5000 },
    { clipId: 'clp_b', timelineStartMs: 5900, timelineEndMs: 9900, contentDurationMs: 4000 },
  ])
  assert.equal(layout.contentEndMs, 9900)
  assert.equal(layout.durationMs, 10400)
  assert.deepEqual(layout.transitions, [{
    id: 'tr_1',
    fromClipId: 'clp_a',
    toClipId: 'clp_b',
    overlapMs: 400,
  }])
})

test('布局：变速改变内容时长', () => {
  const plan = createEmptyEditPlan(1, project)
  plan.clips = [clip('clp_a', 10000, { speed: 2 })]
  const layout = computeLayout(plan)
  assert.equal(layout.contentEndMs, 5000)
  assert.equal(layout.durationMs, 5000)
})
