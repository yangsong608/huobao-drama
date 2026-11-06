import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EditPlanRejectedError,
  assertPlanInvariants,
  normalizeEditPlan,
} from '../src/services/edit-normalize.ts'
import {
  computeLayout,
  projectSettingsForAspect,
  type EditClipSource,
} from '../src/services/edit-plan.ts'
import { normalizeEditSourceUrl } from '../src/services/edit-source-url.ts'

const project = projectSettingsForAspect('16:9', 30)
const source: EditClipSource = {
  kind: 'storyboard',
  id: 1,
  url: 'static/projects/1/videos/1.mp4',
  durationMs: 10_000,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  fingerprint: '1000:1',
}

function dirtyPlan() {
  return {
    version: 1,
    episodeId: 999,
    project: { ...project, tailGapMs: 99_999 },
    clips: [{
      id: 'clp_a',
      kind: 'video',
      source,
      sourceInMs: -500,
      sourceOutMs: 12_000,
      speed: 9,
      gapBeforeMs: -3,
      videoFadeInMs: 900,
      videoFadeOutMs: 900,
      transform: { scale: 9, x: 2, y: -3, rotation: 45, flipH: 1, flipV: 0 },
      filter: { preset: 'bogus', intensity: 999 },
    }],
    transitions: [{ id: 'tr_1', fromClipId: 'clp_a', toClipId: 'ghost', type: 'bogus', durationMs: 20 }],
    subtitles: [{
      id: 'cue_1',
      text: '字'.repeat(520),
      startMs: 12_000,
      endMs: 12_000,
      style: 'bogus',
      source: 'manual',
      follow: true,
      anchor: { clipId: 'ghost', offsetMs: 0 },
    }],
    overlays: [],
    markers: [],
    layout: { contentEndMs: 1, durationMs: 1, clips: [], transitions: [] },
  }
}

test('URL 规范化保留站内相对地址并拒绝越界路径', () => {
  assert.equal(normalizeEditSourceUrl(' static/projects/1/a.mp4 '), 'static/projects/1/a.mp4')
  assert.equal(normalizeEditSourceUrl('/static/projects/1/a.mp4'), '/static/projects/1/a.mp4')
  assert.throws(() => normalizeEditSourceUrl('https://example.com/a.mp4'), /不支持远程媒体/)
  assert.throws(() => normalizeEditSourceUrl('/etc/passwd'), /不支持绝对路径/)
  assert.throws(() => normalizeEditSourceUrl('static/../secret.mp4'), /不支持的媒体路径/)
  assert.throws(() => normalizeEditSourceUrl('C:\\media\\a.mp4'), /不支持绝对路径/)
})

test('归一化截断数值、移除非法转场并重算布局', () => {
  const { plan, issues } = normalizeEditPlan(dirtyPlan(), { episodeId: 7, project })

  assert.equal(plan.episodeId, 7)
  assert.equal('layout' in plan, false)
  assert.equal(plan.project.tailGapMs, 60_000)
  const clip = plan.clips[0]
  assert.equal(clip.sourceInMs, 0)
  assert.equal(clip.sourceOutMs, 10_000)
  assert.equal(clip.speed, 4)
  assert.equal(clip.gapBeforeMs, 0)
  assert.ok(clip.videoFadeInMs + clip.videoFadeOutMs <= 2_500)
  assert.equal(clip.transform.scale, 2)
  assert.equal(clip.transform.rotation, 0)
  assert.equal(clip.filter.preset, 'none')
  assert.equal(clip.filter.intensity, 100)
  assert.deepEqual(plan.transitions, [])
  const cue = plan.subtitles[0]
  assert.equal(cue.text.length, 500)
  assert.equal(cue.follow, false)
  assert.equal(cue.anchor, null)
  assert.ok(cue.endMs > cue.startMs)
  assert.equal(plan.subtitles[0].style, 'default')
  assert.ok(issues.some((issue) => issue.code === 'CLIP_SPEED'))
  assert.ok(issues.some((issue) => issue.code === 'TRANSITION_ADJACENCY'))
  assert.doesNotThrow(() => assertPlanInvariants(plan))
  assert.equal(computeLayout(plan).clips[0].contentDurationMs, 2_500)
})

test('重复 ID、空源、过短片段与非法版本拒绝保存', () => {
  const duplicate = dirtyPlan()
  duplicate.clips.push({ ...duplicate.clips[0] })
  assert.throws(
    () => normalizeEditPlan(duplicate, { episodeId: 7, project }),
    (error: unknown) => error instanceof EditPlanRejectedError && error.code === 'CLIP_ID_DUPLICATE',
  )

  const emptyUrl = dirtyPlan()
  emptyUrl.clips[0].source = { ...source, url: ' ' }
  assert.throws(
    () => normalizeEditPlan(emptyUrl, { episodeId: 7, project }),
    (error: unknown) => error instanceof EditPlanRejectedError && error.code === 'CLIP_SOURCE_URL',
  )

  const tooShort = dirtyPlan()
  tooShort.clips[0].sourceOutMs = 50
  assert.throws(
    () => normalizeEditPlan(tooShort, { episodeId: 7, project }),
    (error: unknown) => error instanceof EditPlanRejectedError && error.code === 'CLIP_TOO_SHORT',
  )

  assert.throws(
    () => normalizeEditPlan({ ...dirtyPlan(), version: 2 }, { episodeId: 7, project }),
    (error: unknown) => error instanceof EditPlanRejectedError && error.code === 'VERSION',
  )
})
