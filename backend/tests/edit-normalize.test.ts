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

test('字幕外观归一化：custom 接受、未知字体回退并警告、数值夹取', () => {
  const plan = dirtyPlan()
  plan.project.subtitleAppearance = {
    fontFamily: 'NotAFont', fontSize: 500, color: 'red', strokeColor: '#000000',
    strokeWidth: 99, backgroundColor: '#000000', backgroundOpacity: 200,
    align: 'diagonal', xPct: -5, yPct: 150,
  }
  plan.subtitles.push({
    id: 'cue_x', text: '测试', startMs: 0, endMs: 500, style: 'custom',
    role: null, source: 'manual', follow: false, anchor: null, lineId: null,
    warnings: [],
    appearance: { ...plan.project.subtitleAppearance },
  })
  const { plan: normalized, issues } = normalizeEditPlan(plan, { episodeId: 7, project })
  const appearance = normalized.project.subtitleAppearance
  assert.equal(appearance.fontFamily, 'PingFang SC')
  assert.equal(appearance.fontSize, 120)
  assert.equal(appearance.color, '#FFFFFF')
  assert.equal(appearance.strokeWidth, 8)
  assert.equal(appearance.backgroundOpacity, 100)
  assert.equal(appearance.align, 'center')
  assert.equal(appearance.xPct, 0)
  assert.equal(appearance.yPct, 100)
  assert.ok(issues.some((i) => i.code === 'SUBTITLE_FONT' && i.severity === 'warning'))
  assert.equal(normalized.subtitles[0].style, 'custom')
  assert.equal(normalized.project.subtitleSafeAreaPct, 8)
})

test('旧计划（无 subtitleAppearance/appearance）归一化不报错且默认来自 defaultSubtitleStyle', () => {
  const plan = dirtyPlan()
  // 模拟旧计划：不携带 subtitleAppearance 与 cue.appearance
  delete (plan.project as Record<string, unknown>).subtitleAppearance
  delete (plan.project as Record<string, unknown>).subtitleSafeAreaPct
  const { plan: normalized, issues } = normalizeEditPlan(plan, { episodeId: 7, project })
  assert.equal(normalized.project.subtitleAppearance.fontSize, 48)
  assert.equal(normalized.project.subtitleSafeAreaPct, 8)
  assert.equal(normalized.subtitles[0].appearance, undefined)
  assert.ok(!issues.some((i) => i.severity === 'error'))
})

test('图片片段出点截断到 30 秒、音量夹取 0–2、新转场类型保留', () => {
  const plan = dirtyPlan()
  const imageSource = { ...source, kind: 'asset' as const, url: 'static/projects/1/images/1.png', fps: null, hasAudio: false }
  const imageClip = {
    ...plan.clips[0],
    kind: 'image',
    source: imageSource,
    sourceInMs: 0,
    sourceOutMs: 120_000,
    speed: 1,
    gapBeforeMs: 0,
    videoFadeInMs: 0,
    videoFadeOutMs: 0,
    volume: 5,
  }
  const second = { ...imageClip, id: 'clp_b' }
  delete (second as Record<string, unknown>).volume
  plan.clips = [imageClip, second]
  plan.transitions = [{ id: 'tr_1', fromClipId: 'clp_a', toClipId: 'clp_b', type: 'circle-open', durationMs: 600 }]
  const { plan: normalized, issues } = normalizeEditPlan(plan, { episodeId: 7, project })
  assert.equal(normalized.clips[0].sourceOutMs, 30_000, '图片出点截断到 30 秒上限')
  assert.equal(normalized.clips[0].volume, 2, '音量夹取到 0–2')
  assert.equal(normalized.clips[1].volume, 1, '缺省音量为原声 1')
  assert.ok(issues.some((i) => i.code === 'CLIP_SOURCE_OUT' && i.severity === 'warning'))
  assert.ok(issues.some((i) => i.code === 'CLIP_VOLUME' && i.severity === 'warning'))
  assert.equal(normalized.transitions[0]?.type, 'circle-open', 'circle-open 属于支持的 16 种转场')
})

test('叠加窗口截断到主轨末尾并给出警告', () => {
  const plan = dirtyPlan()
  plan.overlays = [{
    id: 'ov_1',
    kind: 'video',
    source,
    startMs: 1000,
    endMs: 5000,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    opacity: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    track: 0,
  }]
  const { plan: normalized, issues } = normalizeEditPlan(plan, { episodeId: 7, project })
  assert.equal(normalized.overlays.length, 1)
  assert.equal(normalized.overlays[0].startMs, 1000)
  assert.equal(normalized.overlays[0].endMs, 2500, '叠加终点截断到主轨末尾（速度夹取后内容 2.5 秒）')
  assert.ok(issues.some((i) => i.code === 'OVERLAY_RANGE' && i.severity === 'warning'))
})

test('主轨为空与窗口过短的叠加被移除', () => {
  const emptyMain = dirtyPlan()
  emptyMain.clips = []
  emptyMain.overlays = [{
    id: 'ov_1', kind: 'text', text: {
      text: '标题', preset: 'title', fontFamily: 'PingFang SC', fontSize: 48,
      color: '#FFFFFF', strokeColor: '#000000', strokeWidth: 2, backgroundColor: null,
      align: 'center', x: 0.5, y: 0.5,
    }, startMs: 0, endMs: 1000, transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    opacity: 1, fadeInMs: 0, fadeOutMs: 0, track: 0,
  }]
  const emptyResult = normalizeEditPlan(emptyMain, { episodeId: 7, project })
  assert.equal(emptyResult.plan.overlays.length, 0)
  assert.ok(emptyResult.issues.some((i) => i.code === 'OVERLAY_RANGE' && i.severity === 'warning'))

  const tooShort = dirtyPlan()
  tooShort.overlays = [{
    id: 'ov_2', kind: 'text', text: {
      text: '标题', preset: 'title', fontFamily: 'PingFang SC', fontSize: 48,
      color: '#FFFFFF', strokeColor: '#000000', strokeWidth: 2, backgroundColor: null,
      align: 'center', x: 0.5, y: 0.5,
    }, startMs: 0, endMs: 10, transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    opacity: 1, fadeInMs: 0, fadeOutMs: 0, track: 0,
  }]
  const shortResult = normalizeEditPlan(tooShort, { episodeId: 7, project })
  assert.equal(shortResult.plan.overlays.length, 0)
  assert.ok(shortResult.issues.some((i) => i.code === 'OVERLAY_RANGE' && i.severity === 'warning'))
})

test('视频/图片叠加缺少素材直接拒绝保存', () => {
  const plan = dirtyPlan()
  plan.overlays = [{
    id: 'ov_1', kind: 'video',
    startMs: 0, endMs: 1000,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    opacity: 1, fadeInMs: 0, fadeOutMs: 0, track: 0,
  }]
  assert.throws(
    () => normalizeEditPlan(plan, { episodeId: 7, project }),
    (error: unknown) => error instanceof EditPlanRejectedError && error.code === 'OVERLAY_SOURCE',
  )
})

test('独立音频淡入淡出：旧计划回退视频淡入淡出，显式值截断并提示', () => {
  // 旧计划缺省 audioFadeInMs/audioFadeOutMs → 回退视频淡入淡出，保持既有导出行为
  const legacyResult = normalizeEditPlan(dirtyPlan(), { episodeId: 7, project })
  const legacyClip = legacyResult.plan.clips[0]
  assert.equal(legacyClip.audioFadeInMs, legacyClip.videoFadeInMs)
  assert.equal(legacyClip.audioFadeOutMs, legacyClip.videoFadeOutMs)
  assert.ok(!legacyResult.issues.some((issue) => issue.code === 'CLIP_AUDIO_FADE'))

  const clamped = dirtyPlan()
  clamped.clips[0].videoFadeInMs = 0
  clamped.clips[0].videoFadeOutMs = 0
  clamped.clips[0].audioFadeInMs = 99_999
  clamped.clips[0].audioFadeOutMs = -5
  const clampedResult = normalizeEditPlan(clamped, { episodeId: 7, project })
  assert.equal(clampedResult.plan.clips[0].audioFadeInMs, 1500)
  assert.equal(clampedResult.plan.clips[0].audioFadeOutMs, 0)
  assert.ok(clampedResult.issues.filter((issue) => issue.code === 'CLIP_AUDIO_FADE').length === 2)

  // 工程级片头/片尾淡：缺省回退 0，越界截断到 3000
  const projectFade = dirtyPlan()
  projectFade.project.audioFadeInMs = 99_999
  const projectResult = normalizeEditPlan(projectFade, { episodeId: 7, project })
  assert.equal(projectResult.plan.project.audioFadeInMs, 3000)
  assert.equal(projectResult.plan.project.audioFadeOutMs, 0)
})

test('音调与音频特效：缺省回退 0/none，越界截断，白名单外回落', () => {
  const legacyResult = normalizeEditPlan(dirtyPlan(), { episodeId: 7, project })
  assert.equal(legacyResult.plan.clips[0].pitchSemitones, 0)
  assert.equal(legacyResult.plan.clips[0].audioEffect.preset, 'none')
  assert.ok(!legacyResult.issues.some((issue) => issue.code === 'CLIP_PITCH'))
  assert.ok(!legacyResult.issues.some((issue) => issue.code === 'CLIP_AUDIO_EFFECT'))

  const clamped = dirtyPlan()
  clamped.clips[0].pitchSemitones = 99
  clamped.clips[0].audioEffect = { preset: 'bogus' }
  const clampedResult = normalizeEditPlan(clamped, { episodeId: 7, project })
  assert.equal(clampedResult.plan.clips[0].pitchSemitones, 12)
  assert.equal(clampedResult.plan.clips[0].audioEffect.preset, 'none')
  assert.ok(clampedResult.issues.some((issue) => issue.code === 'CLIP_PITCH'))
  assert.ok(clampedResult.issues.some((issue) => issue.code === 'CLIP_AUDIO_EFFECT'))

  const valid = dirtyPlan()
  valid.clips[0].pitchSemitones = -5
  valid.clips[0].audioEffect = { preset: 'telephone' }
  const validResult = normalizeEditPlan(valid, { episodeId: 7, project })
  assert.equal(validResult.plan.clips[0].pitchSemitones, -5)
  assert.equal(validResult.plan.clips[0].audioEffect.preset, 'telephone')
})
