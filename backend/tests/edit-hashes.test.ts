import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_TAIL_GAP_MS,
  createSingleClipPlan,
  dialogueSyncHashOf,
  editSyncHashOf,
  planHashOf,
  projectSettingsForAspect,
  renderHashOf,
  shortHash,
  sourceFingerprintOf,
  subtitleHashOf,
  validateEditPlan,
  type EditClip,
  type EditClipSource,
  type EditOverlay,
  type EditPlanV1,
  type EditSubtitleCue,
} from '../src/services/edit-plan.ts'

const project = projectSettingsForAspect('9:16', 30)

function source(id = 1, durationMs = 10000): EditClipSource {
  return {
    kind: 'storyboard',
    id,
    url: `static/projects/1/videos/${id}.mp4`,
    durationMs,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: true,
    fingerprint: `${durationMs}:1000`,
    label: '镜头',
  }
}

function clip(id: string, patch: Partial<EditClip> = {}): EditClip {
  return {
    id,
    kind: 'video',
    source: source(1, 10000),
    sourceInMs: 0,
    sourceOutMs: 10000,
    speed: 1,
    gapBeforeMs: 0,
    videoFadeInMs: 0,
    videoFadeOutMs: 0,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    filter: { preset: 'none', intensity: 100 },
    ...patch,
  }
}

function overlay(endMs: number): EditOverlay {
  return {
    id: 'ov_1',
    kind: 'text',
    text: {
      text: '标题', preset: 'title', fontFamily: 'sans-serif', fontSize: 48,
      color: '#ffffff', strokeColor: '#000000', strokeWidth: 0, backgroundColor: null,
      align: 'center', x: 0.5, y: 0.2,
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

function basePlan(): EditPlanV1 {
  const plan = createSingleClipPlan(7, source(), project)
  plan.clips = [clip('clp_1')]
  return plan
}

test('校验：空计划无问题，非法结构产生 error/warning', () => {
  assert.deepEqual(validateEditPlan(basePlan()), [])

  const plan = basePlan()
  plan.version = 2 as any
  plan.clips.push(clip('clp_1'))
  plan.clips[0].source.url = ''
  plan.clips[0].sourceOutMs = 2000
  plan.clips[0].videoFadeInMs = 1200
  plan.clips[0].videoFadeOutMs = 1200
  const issues = validateEditPlan(plan)
  assert.ok(issues.some((item) => item.severity === 'error' && item.code === 'VERSION'))
  assert.ok(issues.some((item) => item.severity === 'error' && item.code === 'CLIP_ID_DUPLICATE'))
  assert.ok(issues.some((item) => item.severity === 'error' && item.code === 'CLIP_SOURCE_URL'))
  assert.ok(issues.some((item) => item.severity === 'warning' && item.code === 'CLIP_FADE_SUM'))

  const badProject = basePlan()
  badProject.project.aspect = '4:3' as any
  badProject.project.tailGapMs = MAX_TAIL_GAP_MS + 1
  const projectIssues = validateEditPlan(badProject)
  assert.ok(projectIssues.some((item) => item.code === 'PROJECT_ASPECT'))
  assert.ok(projectIssues.some((item) => item.code === 'PROJECT_TAIL_GAP'))

  const subtitled = basePlan()
  subtitled.subtitles = [
    { id: 'cue_1', text: '第一句', startMs: 0, endMs: 2000, style: 'default', source: 'manual', follow: false },
    { id: 'cue_2', text: '第二句', startMs: 1000, endMs: 12000, style: 'default', source: 'manual', follow: false },
  ]
  const subtitleIssues = validateEditPlan(subtitled)
  assert.ok(subtitleIssues.some((item) => item.code === 'SUBTITLE_OVERLAP'))
  assert.ok(subtitleIssues.some((item) => item.code === 'SUBTITLE_BEYOND_END'))
})

test('哈希：稳定、忽略非渲染元数据、字幕只进 plan/subtitle', () => {
  const plan = basePlan()
  assert.equal(planHashOf(plan), planHashOf(basePlan()))
  assert.equal(shortHash({ b: 1, a: [2, 3] }), shortHash({ a: [2, 3], b: 1 }))
  assert.equal(shortHash({ a: 1 }).length, 32)

  const meta = basePlan()
  meta.markers = [{ id: 'm1', atMs: 500, label: '看这里', color: '#ff0' }]
  meta.clips[0].source.label = '改了标签'
  meta.clips[0].lineId = 99
  meta.layout = { contentEndMs: 1, durationMs: 1, clips: [], transitions: [] }
  assert.equal(planHashOf(meta), planHashOf(plan))

  const cue: EditSubtitleCue = {
    id: 'cue_1', text: '你好', startMs: 0, endMs: 1000,
    style: 'default', source: 'manual', follow: false,
  }
  const subtitled = basePlan()
  subtitled.subtitles = [cue]
  assert.notEqual(planHashOf(subtitled), planHashOf(plan))
  assert.notEqual(subtitleHashOf(subtitled), subtitleHashOf(plan))
  assert.equal(renderHashOf(subtitled), renderHashOf(plan))

  // cue 外观修改必须改变 plan/subtitle 哈希（Task 15 裁决：外观参与哈希）
  const styled = basePlan()
  styled.subtitles = [{
    ...cue,
    appearance: {
      fontFamily: 'Arial', fontSize: 42, color: '#ff0000', strokeColor: '#000000',
      strokeWidth: 2, backgroundColor: '#000000', backgroundOpacity: 0.5,
      align: 'center', xPct: 50, yPct: 80,
    },
  }]
  assert.notEqual(planHashOf(styled), planHashOf(subtitled), '外观变化应改变 planHash')
  assert.notEqual(subtitleHashOf(styled), subtitleHashOf(subtitled), '外观变化应改变 subtitleHash')
})

test('哈希：cue 外观字段参与字幕哈希', () => {
  const cue: EditSubtitleCue = {
    id: 'cue_1', text: '你好', startMs: 0, endMs: 1000,
    style: 'default', source: 'manual', follow: false,
  }
  const plain = basePlan()
  plain.subtitles = [cue]
  const styled = basePlan()
  styled.subtitles = [{
    ...cue,
    appearance: {
      fontFamily: 'PingFang SC', fontSize: 44, color: '#ffffff', strokeColor: '#000000',
      strokeWidth: 1, backgroundColor: null, backgroundOpacity: 0,
      align: 'center', xPct: 50, yPct: 85,
    },
  }]
  assert.notEqual(planHashOf(plain), planHashOf(styled))
  assert.notEqual(subtitleHashOf(plain), subtitleHashOf(styled))
})

test('哈希：淡入淡出只影响 renderHash，不影响 editSyncHash', () => {
  const plain = basePlan()
  const faded = basePlan()
  faded.clips[0].videoFadeInMs = 300
  faded.clips[0].videoFadeOutMs = 200
  assert.notEqual(renderHashOf(faded), renderHashOf(plain))
  assert.equal(editSyncHashOf(faded), editSyncHashOf(plain))
  assert.notEqual(planHashOf(faded), planHashOf(plain))
})

test('哈希：拆分片段不改变 editSyncHash', () => {
  const single = basePlan()
  const split = basePlan()
  split.clips = [
    { ...single.clips[0], id: 'clp_1', sourceOutMs: 4000 },
    { ...single.clips[0], id: 'clp_2', sourceInMs: 4000, sourceOutMs: 10000 },
  ]
  assert.equal(editSyncHashOf(split), editSyncHashOf(single))
  assert.notEqual(renderHashOf(split), renderHashOf(single))
})

test('哈希：换源、转场、叠加轨延长总时长会改变 editSyncHash', () => {
  const a = basePlan()
  const b = basePlan()
  b.clips[0].source = source(2, 10000)
  assert.notEqual(editSyncHashOf(a), editSyncHashOf(b))

  const two = basePlan()
  two.clips = [
    clip('clp_1', { source: source(1, 5000), sourceOutMs: 5000 }),
    clip('clp_2', { source: source(2, 5000), sourceOutMs: 5000, gapBeforeMs: 0 }),
  ]
  const cut = editSyncHashOf(two)
  two.transitions = [{ id: 'tr_1', fromClipId: 'clp_1', toClipId: 'clp_2', type: 'dissolve', durationMs: 400 }]
  assert.notEqual(editSyncHashOf(two), cut)

  const withOverlay = basePlan()
  withOverlay.overlays = [overlay(5000)]
  const short = editSyncHashOf(withOverlay)
  withOverlay.overlays = [overlay(9000)]
  assert.equal(editSyncHashOf(withOverlay), short, '叠加轨未超过主轨，不应影响混音')

  const longer = basePlan()
  longer.overlays = [overlay(12000)]
  assert.notEqual(editSyncHashOf(longer), short, '叠加轨延长总时长必须影响混音')
})

test('哈希：源素材指纹随文件指纹、换源与裁剪点变化，顺序无关', () => {
  const plan = basePlan()
  const fingerprint = sourceFingerprintOf(plan)
  assert.equal(fingerprint.length, 32)
  assert.equal(sourceFingerprintOf(basePlan()), fingerprint)

  const reordered = basePlan()
  reordered.clips = [
    { ...clip('clp_2'), source: source(2, 5000), sourceOutMs: 5000 },
    { ...clip('clp_1'), source: source(1, 5000), sourceOutMs: 5000 },
  ]
  const flipped = basePlan()
  flipped.clips = [
    { ...clip('clp_1'), source: source(1, 5000), sourceOutMs: 5000 },
    { ...clip('clp_2'), source: source(2, 5000), sourceOutMs: 5000 },
  ]
  assert.equal(sourceFingerprintOf(reordered), sourceFingerprintOf(flipped))

  const changedFile = basePlan()
  changedFile.clips[0].source.fingerprint = '9:9'
  assert.notEqual(sourceFingerprintOf(changedFile), fingerprint)

  const swapped = basePlan()
  swapped.clips[0].source = source(2, 10000)
  assert.notEqual(sourceFingerprintOf(swapped), fingerprint)

  const trimmedIn = basePlan()
  trimmedIn.clips[0].sourceInMs = 1000
  assert.notEqual(sourceFingerprintOf(trimmedIn), fingerprint)

  const trimmedOut = basePlan()
  trimmedOut.clips[0].sourceOutMs = 8000
  assert.notEqual(sourceFingerprintOf(trimmedOut), fingerprint)
})

test('哈希：配音 Take 顺序、URL、指纹与时长变化均失效', () => {
  const first = dialogueSyncHashOf([
    { lineId: 1, voiceTakeId: 10, takeUrl: 'static/a.wav', takeFingerprint: '1:1', durationMs: 1000 },
    { lineId: 2, voiceTakeId: 20, takeUrl: 'static/b.wav', takeFingerprint: '2:2', durationMs: 1200 },
  ])
  const same = dialogueSyncHashOf([
    { lineId: 1, voiceTakeId: 10, takeUrl: 'static/a.wav', takeFingerprint: '1:1', durationMs: 1000 },
    { lineId: 2, voiceTakeId: 20, takeUrl: 'static/b.wav', takeFingerprint: '2:2', durationMs: 1200 },
  ])
  const changedTake = dialogueSyncHashOf([
    { lineId: 1, voiceTakeId: 11, takeUrl: 'static/a.wav', takeFingerprint: '1:1', durationMs: 1000 },
    { lineId: 2, voiceTakeId: 20, takeUrl: 'static/b.wav', takeFingerprint: '2:2', durationMs: 1200 },
  ])
  const reordered = dialogueSyncHashOf([
    { lineId: 2, voiceTakeId: 20, takeUrl: 'static/b.wav', takeFingerprint: '2:2', durationMs: 1200 },
    { lineId: 1, voiceTakeId: 10, takeUrl: 'static/a.wav', takeFingerprint: '1:1', durationMs: 1000 },
  ])
  assert.equal(first, same)
  assert.notEqual(first, changedTake)
  assert.notEqual(first, reordered)
  assert.equal(first.length, 32)
})
