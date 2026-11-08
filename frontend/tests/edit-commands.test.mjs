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
  setClipAudioFades,
  setClipFilter,
  setClipPitch,
  setClipAudioEffect,
  setClipVolume,
  setProjectAudioFades,
  setTransform,
  setTransition,
  removeTransition,
  closeGaps,
  duplicateClip,
  addMarker,
  deleteMarker,
  DEFAULT_MARKER_COLOR,
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

  // 有间隙的交界直接拒绝，而不是悄悄丢弃转场
  const gapped = plan([clip('a'), clip('b', { gapBeforeMs: 500 })])
  const blocked = setTransition(gapped, 'a', 'b', {})
  assert.equal(blocked.plan, gapped)
  assert.ok(blocked.issues.some((item) => item.code === 'TRANSITION_GAP_BLOCKED'))
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

test('复制片段：原样克隆插入其后并承接指向后段的转场', () => {
  const base = plan(
    [clip('a'), clip('b')],
    { transitions: [{ id: 'tr_ab', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationMs: 400 }] },
  )
  const result = duplicateClip(base, 'a', 'a_copy')
  assert.deepEqual(result.plan.clips.map((item) => item.id), ['a', 'a_copy', 'b'])
  const copy = result.plan.clips[1]
  assert.equal(copy.source.id, 'a')
  assert.equal(copy.sourceInMs, result.plan.clips[0].sourceInMs)
  assert.equal(copy.sourceOutMs, result.plan.clips[0].sourceOutMs)
  assert.equal(copy.gapBeforeMs, 0)
  assert.deepEqual(starts(result), [0, 5000, 9600], '副本承接 400ms 转场，b 起点前移 400ms')
  assert.deepEqual(result.plan.transitions, [{ id: 'tr_ab', fromClipId: 'a_copy', toClipId: 'b', type: 'dissolve', durationMs: 400 }])

  const missing = duplicateClip(base, 'zz', 'zz_copy')
  assert.ok(missing.issues.some((item) => item.severity === 'error' && item.code === 'CLIP_NOT_FOUND'))
  const dupId = duplicateClip(base, 'a', 'b')
  assert.ok(dupId.issues.some((item) => item.severity === 'error' && item.code === 'CLIP_ID_DUPLICATE'))
})

test('时间线标记：添加、点击定位与删除', () => {
  const base = plan([clip('a')])
  const added = addMarker(base, { id: 'mk1', atMs: 2500, label: '高潮', color: '#ff5470' })
  assert.deepEqual(added.plan.markers, [{ id: 'mk1', atMs: 2500, label: '高潮', color: '#ff5470' }])

  const second = addMarker(added.plan, { id: 'mk2', atMs: 1000, label: '', color: '' })
  assert.deepEqual(second.plan.markers.map((item) => item.atMs), [1000, 2500], '标记按时间排序')
  assert.equal(second.plan.markers[0].color, DEFAULT_MARKER_COLOR, '未指定颜色时用默认标记色')

  const removed = deleteMarker(second.plan, 'mk1')
  assert.deepEqual(removed.plan.markers.map((item) => item.id), ['mk2'])
  const missing = deleteMarker(second.plan, 'zz')
  assert.ok(missing.issues.some((item) => item.severity === 'error' && item.code === 'MARKER_NOT_FOUND'))
})

test('画面调整：缩放/位移/旋转/翻转夹取与复原', () => {
  const base = plan([clip('a')])
  const scaled = setTransform(base, 'a', { scale: 1.5, x: 0.2, y: -0.1 })
  assert.equal(scaled.plan.clips[0].transform.scale, 1.5)
  assert.equal(scaled.plan.clips[0].transform.x, 0.2)
  assert.equal(scaled.plan.clips[0].transform.y, -0.1)

  const clamped = setTransform(base, 'a', { scale: 5, x: -2, rotation: 45 })
  assert.equal(clamped.plan.clips[0].transform.scale, 2)
  assert.equal(clamped.plan.clips[0].transform.x, -1)
  assert.equal(clamped.plan.clips[0].transform.rotation, 0, '非法旋转回落 0')

  const flip = setTransform(base, 'a', { flipH: true, flipV: true })
  assert.equal(flip.plan.clips[0].transform.flipH, true)
  assert.equal(flip.plan.clips[0].transform.flipV, true)

  const reset = setTransform(flip.plan, 'a', { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false })
  assert.deepEqual(reset.plan.clips[0].transform, { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false })

  const missing = setTransform(base, 'zz', { scale: 2 })
  assert.ok(missing.issues.some((item) => item.severity === 'error' && item.code === 'CLIP_NOT_FOUND'))
})

test('滤镜预设与强度：设置、夹取与还原原色', () => {
  const base = plan([clip('a')])
  const filtered = setClipFilter(base, 'a', 'mono', 80)
  assert.deepEqual(filtered.plan.clips[0].filter, { preset: 'mono', intensity: 80 })

  const clamped = setClipFilter(base, 'a', 'mono', 150)
  assert.equal(clamped.plan.clips[0].filter.intensity, 100)

  const cleared = setClipFilter(filtered.plan, 'a', 'none', 0)
  assert.deepEqual(cleared.plan.clips[0].filter, { preset: 'none', intensity: 0 })

  const missing = setClipFilter(base, 'zz', 'mono', 50)
  assert.ok(missing.issues.some((item) => item.severity === 'error' && item.code === 'CLIP_NOT_FOUND'))
})

test('片段音量 0–2 倍夹取，静音与复原', () => {
  const base = plan([clip('a')])
  const muted = setClipVolume(base, 'a', 0)
  assert.equal(muted.plan.clips[0].volume, 0)

  const boosted = setClipVolume(base, 'a', 1.75)
  assert.equal(boosted.plan.clips[0].volume, 1.75)

  const clamped = setClipVolume(base, 'a', 3)
  assert.equal(clamped.plan.clips[0].volume, 2)

  const restored = setClipVolume(base, 'a', 1)
  assert.equal(restored.plan.clips[0].volume, 1)

  const missing = setClipVolume(base, 'zz', 2)
  assert.ok(missing.issues.some((item) => item.severity === 'error' && item.code === 'CLIP_NOT_FOUND'))
})

test('独立音频淡入淡出与视频淡入淡出互不影响，各自夹取', () => {
  const base = plan([clip('a')])
  const withFades = setClipFades(base, 'a', 800, 600)
  assert.equal(withFades.plan.clips[0].videoFadeInMs, 800)

  const result = setClipAudioFades(withFades.plan, 'a', 400, 300)
  assert.equal(result.plan.clips[0].audioFadeInMs, 400)
  assert.equal(result.plan.clips[0].audioFadeOutMs, 300)
  assert.equal(result.plan.clips[0].videoFadeInMs, 800, '视频淡入不受影响')
  assert.equal(result.plan.clips[0].videoFadeOutMs, 600, '视频淡出不受影响')

  const clamped = setClipAudioFades(base, 'a', 99999, -5)
  assert.equal(clamped.plan.clips[0].audioFadeInMs, 1500)
  assert.equal(clamped.plan.clips[0].audioFadeOutMs, 0)

  const missing = setClipAudioFades(base, 'zz', 100, 100)
  assert.ok(missing.issues.some((item) => item.severity === 'error' && item.code === 'CLIP_NOT_FOUND'))
})

test('工程级片头片尾音频淡入淡出 0–3000ms 夹取', () => {
  const base = plan([clip('a')])
  const result = setProjectAudioFades(base, 1200, 2000)
  assert.equal(result.plan.project.audioFadeInMs, 1200)
  assert.equal(result.plan.project.audioFadeOutMs, 2000)

  const clamped = setProjectAudioFades(base, 99999, -1)
  assert.equal(clamped.plan.project.audioFadeInMs, 3000)
  assert.equal(clamped.plan.project.audioFadeOutMs, 0)
})

test('音调升降 −12..+12 半音夹取，特效白名单外回落 none', () => {
  const base = plan([clip('a')])

  const up = setClipPitch(base, 'a', 5)
  assert.equal(up.plan.clips[0].pitchSemitones, 5)

  const clamped = setClipPitch(base, 'a', 99)
  assert.equal(clamped.plan.clips[0].pitchSemitones, 12)

  const down = setClipPitch(base, 'a', -0.4)
  assert.equal(down.plan.clips[0].pitchSemitones, 0)

  const effect = setClipAudioEffect(base, 'a', 'telephone')
  assert.equal(effect.plan.clips[0].audioEffect.preset, 'telephone')

  const bogus = setClipAudioEffect(base, 'a', 'bogus')
  assert.equal(bogus.plan.clips[0].audioEffect.preset, 'none')

  const missing = setClipPitch(base, 'zz', 3)
  assert.ok(missing.issues.some((item) => item.severity === 'error' && item.code === 'CLIP_NOT_FOUND'))
})

test('图片片段尾部可拉长到 30 秒上限，视频仍受源长限制', () => {
  const img = plan([imageClip('img1', 5000)])
  const extended = trimClipEnd(img, 'img1', 25000)
  assert.equal(extended.plan.clips[0].sourceOutMs, 30000, '图片可延长到 30 秒')
  assert.equal(computeLocalLayout(extended.plan).clips[0].content_duration_ms, 30000)

  const capped = trimClipEnd(img, 'img1', 40000)
  assert.equal(capped.plan.clips[0].sourceOutMs, 30000, '超出 30 秒被夹取')
  assert.ok(capped.issues.some((item) => item.code === 'CLIP_TRIM_CLAMPED'))

  const video = plan([clip('a')])
  const videoExtended = trimClipEnd(video, 'a', 30000)
  assert.equal(videoExtended.plan.clips[0].sourceOutMs, 10000, '视频不得超出源素材时长')
})
