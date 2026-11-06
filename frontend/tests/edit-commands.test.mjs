import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  createClipFromSource,
  insertClip,
  appendClip,
  removeClip,
  moveClip,
  trimClipStart,
  trimClipEnd,
  splitClip,
  setClipSpeed,
  setClipGap,
  setClipFades,
  setTransition,
  removeTransition,
  closeGaps,
  moveCue,
  setCueText,
  deleteCue,
} = await import('../app/utils/edit-commands.ts')
const {
  createEditHistory,
  pushEditHistory,
  undoEditHistory,
  redoEditHistory,
  canUndo,
  canRedo,
} = await import('../app/utils/edit-history.ts')
const { computeLocalLayout } = await import('../app/utils/edit-layout.ts')

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
    ...createClipFromSource(id, source(id, overrides.sourceDurationMs || 10000)),
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

function starts(value) {
  const target = value.plan ?? value
  return computeLocalLayout(target).clips.map((item) => item.timeline_start_ms)
}

test('插入、追加、涟漪删除与非涟漪删除', () => {
  const base = plan([clip('a')])
  const inserted = insertClip(base, clip('b'), { index: 0 })
  assert.deepEqual(inserted.plan.clips.map((item) => item.id), ['b', 'a'])
  assert.equal(base.clips.length, 1)
  assert.equal(inserted.focusClipId, 'b')

  const appended = appendClip(inserted.plan, clip('c'))
  assert.deepEqual(appended.plan.clips.map((item) => item.id), ['b', 'a', 'c'])

  const ripple = removeClip(appended.plan, 'a', { ripple: true })
  assert.deepEqual(ripple.plan.clips.map((item) => item.id), ['b', 'c'])
  assert.deepEqual(starts(ripple), [0, 5000])

  const kept = removeClip(appended.plan, 'a', { ripple: false })
  assert.deepEqual(kept.plan.clips.map((item) => item.id), ['b', 'c'])
  assert.deepEqual(starts(kept), [0, 10000])

  const withTransition = plan(
    [clip('a'), clip('b')],
    { transitions: [{ id: 'tr_ab', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationMs: 400 }] },
  )
  const middle = insertClip(withTransition, clip('x'), { index: 1 })
  assert.deepEqual(middle.plan.clips.map((item) => item.id), ['a', 'x', 'b'])
  assert.equal(middle.plan.transitions.length, 0)
  assert.ok(middle.issues.some((item) => item.code === 'TRANSITION_ADJACENCY'))
})

test('移动片段保持自身空档并清理不再相邻的转场', () => {
  const base = plan(
    [clip('a'), clip('b'), clip('c')],
    { transitions: [
      { id: 'tr_ab', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationMs: 400 },
      { id: 'tr_bc', fromClipId: 'b', toClipId: 'c', type: 'dissolve', durationMs: 400 },
    ] },
  )
  const moved = moveClip(base, 'c', 0)
  assert.deepEqual(moved.plan.clips.map((item) => item.id), ['c', 'a', 'b'])
  assert.deepEqual(moved.plan.transitions.map((item) => item.id), ['tr_ab'])
})

test('头部裁剪支持涟漪与非涟漪，且最短片段受限', () => {
  const base = plan([clip('a', { gapBeforeMs: 300 }), clip('b')])
  assert.deepEqual(starts(base), [300, 5300])

  const ripple = trimClipStart(base, 'a', 1000)
  assert.equal(ripple.plan.clips[0].sourceInMs, 1000)
  assert.deepEqual(starts(ripple), [300, 4300])

  const kept = trimClipStart(base, 'a', 1000, { ripple: false })
  assert.equal(kept.plan.clips[0].sourceInMs, 1000)
  assert.equal(kept.plan.clips[1].gapBeforeMs, 1000)
  assert.deepEqual(starts(kept), [300, 5300])

  const clamped = trimClipStart(base, 'a', -5000)
  assert.equal(clamped.plan.clips[0].sourceInMs, 0)
  assert.ok(clamped.issues.some((item) => item.code === 'CLIP_TRIM_CLAMPED'))
})

test('尾部裁剪、空档、淡入淡出与变速', () => {
  const base = plan([clip('a'), clip('b')])
  const tail = trimClipEnd(base, 'a', -1000, { ripple: false })
  assert.equal(tail.plan.clips[0].sourceOutMs, 4000)
  assert.equal(tail.plan.clips[1].gapBeforeMs, 1000)
  assert.deepEqual(starts(tail), [0, 5000])

  const gap = setClipGap(base, 'b', 800)
  assert.equal(gap.plan.clips[1].gapBeforeMs, 800)
  assert.deepEqual(starts(gap), [0, 5800])

  const fades = setClipFades(plan([clip('a', { sourceOutMs: 2000 }), clip('b')]), 'a', 1500, 1500)
  assert.ok(
    fades.plan.clips[0].videoFadeInMs + fades.plan.clips[0].videoFadeOutMs
      <= fades.plan.clips[0].sourceOutMs - fades.plan.clips[0].sourceInMs,
  )
  assert.ok(fades.issues.some((item) => item.code === 'CLIP_FADE_CLAMPED'))

  const speed = setClipSpeed(base, 'a', 2)
  assert.equal(speed.plan.clips[0].speed, 2)
  assert.deepEqual(starts(speed), [0, 2500])

  const zeroSpeed = setClipSpeed(base, 'a', 0)
  assert.equal(zeroSpeed.plan.clips[0].speed, 0.25)
})

test('分割片段迁移转场与跟随字幕锚点', () => {
  const base = plan(
    [clip('a', { videoFadeOutMs: 400, lineId: 9 }), clip('b')],
    {
      transitions: [{ id: 'tr_ab', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationMs: 300 }],
      subtitles: [
        {
          id: 'cue1', text: '前半', startMs: 1200, endMs: 1700,
          style: 'default', source: 'line', follow: true,
          anchor: { clipId: 'a', offsetMs: 1200 }, lineId: 1,
        },
        {
          id: 'cue2', text: '后半', startMs: 2200, endMs: 2700,
          style: 'default', source: 'line', follow: true,
          anchor: { clipId: 'a', offsetMs: 2200 }, lineId: 2,
        },
      ],
    },
  )
  const result = splitClip(base, 'a', 2000, 'a_second')
  assert.deepEqual(result.plan.clips.map((item) => item.id), ['a', 'a_second', 'b'])
  assert.equal(result.plan.clips[0].sourceOutMs, 2000)
  assert.equal(result.plan.clips[1].sourceInMs, 2000)
  assert.equal(result.plan.clips[0].videoFadeOutMs, 0)
  assert.equal(result.plan.clips[1].videoFadeOutMs, 400)
  assert.equal(result.plan.clips[1].lineId, 9)
  assert.equal(result.plan.transitions[0].fromClipId, 'a_second')
  assert.deepEqual(result.plan.subtitles[0].anchor, { clipId: 'a', offsetMs: 1200 })
  assert.deepEqual(result.plan.subtitles[1].anchor, { clipId: 'a_second', offsetMs: 200 })
  assert.equal(result.plan.subtitles[1].startMs, 2200)

  const tooShort = splitClip(base, 'a', 50, 'a_short')
  assert.equal(tooShort.plan.clips.length, 2)
  assert.equal(tooShort.issues[0].severity, 'error')
  assert.equal(tooShort.plan, base)
  assert.ok(tooShort.issues.some((item) => item.code === 'SPLIT_TOO_SHORT'))
})

test('转场设置、移除与空档闭合', () => {
  const base = plan([clip('a'), clip('b')])
  const added = setTransition(base, 'a', 'b', { type: 'dissolve', durationMs: 600 })
  assert.equal(added.plan.transitions.length, 1)
  assert.equal(added.plan.transitions[0].durationMs, 600)
  assert.deepEqual(starts(added), [0, 4400])

  const small = plan([clip('a', { sourceOutMs: 1200 }), clip('b')])
  const capped = setTransition(small, 'a', 'b', { durationMs: 1500 })
  assert.equal(capped.plan.transitions[0].durationMs, 1166)

  const notAdjacent = setTransition(base, 'b', 'a', {})
  assert.equal(notAdjacent.plan.transitions.length, 0)
  assert.ok(notAdjacent.issues.some((item) => item.code === 'TRANSITION_NOT_ADJACENT'))

  const removed = removeTransition(added.plan, added.plan.transitions[0].id)
  assert.equal(removed.plan.transitions.length, 0)

  const spaced = setClipGap(added.plan, 'b', 1000)
  assert.equal(spaced.plan.transitions.length, 0)
  assert.ok(spaced.issues.some((item) => item.code === 'TRANSITION_GAP'))
  const closed = closeGaps(spaced.plan)
  assert.equal(closed.plan.clips[1].gapBeforeMs, 0)
})

test('字幕移动解除跟随，文本可修改', () => {
  const base = plan([clip('a')], {
    subtitles: [{
      id: 'cue1', text: '原字幕', startMs: 1000, endMs: 1600,
      style: 'default', source: 'line', follow: true,
      anchor: { clipId: 'a', offsetMs: 1000 }, lineId: 1,
    }],
  })
  const moved = moveCue(base, 'cue1', 2500)
  assert.equal(moved.plan.subtitles[0].startMs, 2500)
  assert.equal(moved.plan.subtitles[0].endMs, 3100)
  assert.equal(moved.plan.subtitles[0].follow, false)
  assert.equal(moved.plan.subtitles[0].anchor, null)
  assert.ok(moved.issues.some((item) => item.code === 'CUE_DETACHED'))

  const text = setCueText(moved.plan, 'cue1', '新字幕')
  assert.equal(text.plan.subtitles[0].text, '新字幕')
  assert.equal(deleteCue(text.plan, 'cue1').plan.subtitles.length, 0)
})

test('撤销历史限制 50 步且丢弃分叉', () => {
  const p1 = plan([clip('a')])
  const p2 = plan([clip('a'), clip('b')])
  const p3 = plan([clip('a'), clip('b'), clip('c')])
  let history = createEditHistory(p1, 2)
  history = pushEditHistory(history, p2)
  history = pushEditHistory(history, p3)
  assert.equal(history.past.length, 2)
  assert.equal(canUndo(history), true)
  assert.equal(canRedo(history), false)

  history = undoEditHistory(history)
  assert.deepEqual(history.present.clips.map((item) => item.id), ['a', 'b'])
  history = undoEditHistory(history)
  assert.deepEqual(history.present.clips.map((item) => item.id), ['a'])
  history = undoEditHistory(history)
  assert.deepEqual(history.present.clips.map((item) => item.id), ['a'])

  history = redoEditHistory(history)
  assert.deepEqual(history.present.clips.map((item) => item.id), ['a', 'b'])
  const branch = plan([clip('x')])
  history = pushEditHistory(history, branch)
  assert.deepEqual(history.present.clips.map((item) => item.id), ['x'])
  assert.equal(canRedo(history), false)
})

function imageClip(id, durationMs, overrides = {}) {
  const src = {
    kind: 'asset',
    id,
    url: `static/${id}.png`,
    durationMs,
    width: 800,
    height: 600,
    fps: null,
    hasAudio: false,
    fingerprint: `${id}:1`,
  }
  return {
    ...createClipFromSource(id, src),
    kind: 'image',
    sourceOutMs: durationMs,
    ...overrides,
  }
}

test('图片片段最短 1 帧：插入、裁剪、分割放行一帧图片（规范 §6.3）', () => {
  // fps 30 → 1 帧约 33ms；视频的 3 帧（100ms）下限不再适用于图片
  const inserted = insertClip(plan([clip('a')]), imageClip('img1', 33))
  assert.equal(inserted.issues.filter((item) => item.severity === 'error').length, 0, '一帧图片应可插入')

  const trimmedEnd = trimClipEnd(plan([imageClip('img1', 1000)]), 'img1', -967)
  assert.equal(trimmedEnd.issues.filter((item) => item.severity === 'error').length, 0, '图片可裁到 1 帧')
  assert.equal(computeLocalLayout(trimmedEnd.plan).clips[0].content_duration_ms, 33)

  const trimmedStart = trimClipStart(plan([imageClip('img1', 1000)]), 'img1', 967)
  assert.equal(trimmedStart.issues.filter((item) => item.severity === 'error').length, 0, '图片可从头部裁到 1 帧')
  assert.equal(computeLocalLayout(trimmedStart.plan).clips[0].content_duration_ms, 33)

  const split = splitClip(plan([imageClip('img1', 100)]), 'img1', 50, 'img2')
  assert.equal(split.issues.filter((item) => item.severity === 'error').length, 0, '小图片应可分割')
  assert.deepEqual(split.plan.clips.map((item) => item.id), ['img1', 'img2'])
  assert.equal(computeLocalLayout(split.plan).clips[0].content_duration_ms, 50)
  assert.equal(computeLocalLayout(split.plan).clips[1].content_duration_ms, 50)
})

test('视频片段仍保持 3 帧最短时长', () => {
  const inserted = insertClip(plan([clip('a')]), clip('v', { sourceOutMs: 99 }))
  assert.ok(inserted.issues.some((item) => item.severity === 'error' && item.code === 'CLIP_TOO_SHORT'))

  const trimmed = trimClipEnd(plan([clip('v', { sourceOutMs: 300 })]), 'v', -250)
  assert.equal(computeLocalLayout(trimmed.plan).clips[0].content_duration_ms, 100, '视频不得裁破 3 帧下限')
})
