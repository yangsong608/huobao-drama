import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const commands = await import('../app/utils/edit-commands.ts')
const { computeLocalLayout } = await import('../app/utils/edit-layout.ts')

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

function source(id, durationMs = 10000) {
  return {
    kind: 'storyboard',
    id,
    url: `static/${id}.mp4`,
    durationMs,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: false,
    fingerprint: '1:1',
  }
}

function clip(id, overrides = {}) {
  return {
    ...commands.createClipFromSource(id, source(id, overrides.sourceDurationMs || 10000)),
    sourceOutMs: 5000,
    ...overrides,
  }
}

function plan(clips, extra = {}) {
  return {
    version: 1,
    episodeId: 1,
    project: {
      aspect: '16:9',
      width: 1920,
      height: 1080,
      fps: 30,
      background: 'black',
      defaultFit: 'fit',
      defaultTransition: 'cut',
      defaultSubtitleStyle: 'default',
      defaultExportPreset: '1080p',
      tailGapMs: 0,
    },
    clips,
    transitions: [],
    subtitles: [],
    overlays: [],
    markers: [],
    ...extra,
  }
}

test('replaceClipSource 保留片段样式与顺序并替换素材', () => {
  assert.equal(typeof commands.replaceClipSource, 'function')
  const styled = clip('c1', {
    sourceInMs: 1000,
    sourceOutMs: 4000,
    gapBeforeMs: 300,
    videoFadeInMs: 200,
    videoFadeOutMs: 300,
    transform: { scale: 1.2, x: 10, y: -8, rotation: 0, flipH: true, flipV: false },
    filter: { preset: 'warm', intensity: 80 },
    lineId: 7,
    videoTakeAssetId: 99,
  })
  const input = plan([styled, clip('c2', { gapBeforeMs: 120 })])
  const result = commands.replaceClipSource(input, 'c1', source('s2', 8000))

  assert.equal(result.issues.filter((item) => item.severity === 'error').length, 0)
  assert.equal(result.plan.clips.length, 2)
  assert.equal(result.plan.clips[0].id, 'c1')
  assert.equal(result.plan.clips[1].id, 'c2')
  const out = result.plan.clips[0]
  assert.equal(out.source.id, 's2')
  assert.equal(out.source.url, 'static/s2.mp4')
  assert.equal(out.sourceInMs, 0)
  assert.equal(out.sourceOutMs, 3000)
  assert.equal(out.gapBeforeMs, 300)
  assert.equal(out.speed, 1)
  assert.equal(out.videoFadeInMs, 200)
  assert.equal(out.videoFadeOutMs, 300)
  assert.deepEqual(out.transform, styled.transform)
  assert.deepEqual(out.filter, styled.filter)
  assert.equal(out.lineId, 7)
  assert.equal(out.videoTakeAssetId, null)
  assert.equal(result.plan.clips[1].gapBeforeMs, 120)
  assert.equal(result.focusClipId, 'c1')
  // 原计划不被命令修改
  assert.equal(input.clips[0].source.id, 'c1')
  assert.equal(input.clips[0].sourceOutMs, 4000)
})

test('replaceClipSource 遇到较短素材时缩短片段并前移后续内容', () => {
  const input = plan([clip('c1'), clip('c2')])
  const result = commands.replaceClipSource(input, 'c1', source('s2', 2000))

  assert.equal(result.plan.clips[0].sourceOutMs, 2000)
  const layout = computeLocalLayout(result.plan)
  assert.equal(layout.clips[0].timeline_end_ms, 2000)
  assert.equal(layout.clips[1].timeline_start_ms, 2000)
  assert.ok(
    result.issues.some((item) => item.code === 'CLIP_REPLACED_SHORTER' && item.severity === 'warning'),
    '新素材较短时应给出缩短提示',
  )
})

test('replaceClipSource 把跟随字幕锚点收进新素材范围', () => {
  const input = plan([clip('c1'), clip('c2')], {
    subtitles: [{
      id: 'cue1',
      text: '台词',
      startMs: 4000,
      endMs: 5000,
      style: 'default',
      follow: true,
      anchor: { clipId: 'c1', offsetMs: 4000 },
      source: 'line',
      role: null,
      lineId: null,
      warnings: [],
    }],
  })
  const result = commands.replaceClipSource(input, 'c1', source('s2', 2000))
  const cue = result.plan.subtitles[0]

  assert.equal(cue.anchor.clipId, 'c1')
  assert.equal(cue.anchor.offsetMs, 1900)
  assert.equal(cue.startMs, 1900)
  assert.equal(cue.endMs, 2000)
})

test('replaceClipSource 拒绝过短素材并保持原计划引用', () => {
  const input = plan([clip('c1')])
  const result = commands.replaceClipSource(input, 'c1', source('tiny', 50))

  assert.equal(result.plan, input)
  assert.ok(result.issues.some(
    (item) => item.severity === 'error' && item.code === 'CLIP_SOURCE_TOO_SHORT',
  ))
  assert.equal(input.clips[0].source.id, 'c1')
})

test('replaceClipSource 对不存在的片段报错', () => {
  const input = plan([clip('c1')])
  const result = commands.replaceClipSource(input, 'nope', source('s2'))

  assert.equal(result.plan, input)
  assert.ok(result.issues.some(
    (item) => item.severity === 'error' && item.code === 'CLIP_NOT_FOUND',
  ))
})

test('剪辑工作台挂回素材库并接好加入与替换入口', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /EditMediaLibrary/)
  assert.match(workbench, /useEditMedia/)
  assert.match(workbench, /add-storyboard/)
  assert.match(workbench, /add-all/)
  assert.match(workbench, /replace-clip/)
  assert.match(workbench, /replaceClipSource/)

  const media = read('app/components/edit/EditMediaLibrary.vue')
  assert.match(media, /replace-clip/)
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    for (const key of ['replaceSelected', 'replacedClip', 'replaceSelectFirst']) {
      assert.equal(typeof locale.edit?.[key], 'string', `${lang} 缺少 edit.${key}`)
    }
  }
})
