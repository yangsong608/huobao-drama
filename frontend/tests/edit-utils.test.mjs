import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  computeLocalLayout,
  activeClipIndex,
  clipTimelineOffsetMs,
  sourceTimeAt,
  timelineTimeForSource,
} = await import('../app/utils/edit-layout.ts')
const {
  formatPrecise,
  formatClockMs,
  parseClockMs,
  snapToFrame,
  msToFrames,
  framesToMs,
} = await import('../app/utils/edit-timecode.ts')
const { collectSnapPoints, snapTime } = await import('../app/utils/edit-snap.ts')
const {
  syncFollowedCues,
  migrateCueAnchorsForSplit,
  shiftCueAnchors,
  scaleCueAnchorsForSpeed,
  cueFollowRange,
} = await import('../app/utils/edit-follow.ts')

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
    id,
    kind: 'video',
    source: source(id),
    sourceInMs: 0,
    sourceOutMs: 5000,
    speed: 1,
    gapBeforeMs: 0,
    videoFadeInMs: 0,
    videoFadeOutMs: 0,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    filter: { preset: 'none', intensity: 1 },
    lineId: null,
    videoTakeAssetId: null,
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

test('本地布局与后端一致：转场重叠、空档与尾段', () => {
  const layout = computeLocalLayout(plan(
    [clip('a'), clip('b', { gapBeforeMs: 500 })],
    {
      project: { ...plan([]).project, tailGapMs: 200 },
      transitions: [{ id: 'tr1', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationMs: 400 }],
    },
  ))
  assert.deepEqual(layout.clips.map((item) => ({
    id: item.clip_id,
    start: item.timeline_start_ms,
    end: item.timeline_end_ms,
    content: item.content_duration_ms,
  })), [
    { id: 'a', start: 0, end: 5000, content: 5000 },
    { id: 'b', start: 5100, end: 10100, content: 5000 },
  ])
  assert.equal(layout.transitions[0].overlap_ms, 400)
  assert.equal(layout.content_end_ms, 10100)
  assert.equal(layout.duration_ms, 10300)
})

test('定位活动片段与源时间，覆盖空档', () => {
  const layout = computeLocalLayout(plan([
    clip('a', { sourceInMs: 1000, sourceOutMs: 6000, speed: 2 }),
    clip('b', { gapBeforeMs: 500 }),
  ]))
  assert.deepEqual(layout.clips.map((item) => [item.timeline_start_ms, item.timeline_end_ms]), [
    [0, 2500],
    [3000, 8000],
  ])
  assert.equal(activeClipIndex(layout, 0), 0)
  assert.equal(activeClipIndex(layout, 2499), 0)
  assert.equal(activeClipIndex(layout, 2700), 0)
  assert.equal(activeClipIndex(layout, 3000), 1)
  assert.equal(clipTimelineOffsetMs(layout, 'a', 1250), 1250)
  assert.equal(clipTimelineOffsetMs(layout, 'a', 9000), 2500)
  assert.equal(sourceTimeAt(plan([
    clip('a', { sourceInMs: 1000, sourceOutMs: 6000, speed: 2 }),
    clip('b'),
  ]), layout, 1250), 3500)
  assert.equal(timelineTimeForSource(plan([
    clip('a', { sourceInMs: 1000, sourceOutMs: 6000, speed: 2 }),
    clip('b'),
  ]), layout, 'a', 3500), 1250)
})

test('精确时间码与帧吸附', () => {
  assert.equal(formatPrecise(61234), '01:01.234')
  assert.equal(formatPrecise(3723004), '01:02:03.004')
  assert.equal(formatPrecise(-10), '00:00.000')
  assert.equal(msToFrames(1000, 25), 25)
  assert.equal(framesToMs(25, 25), 1000)
  assert.equal(msToFrames(500, 30), 15)
  assert.ok(Math.abs(snapToFrame(1010, 30) - 1000) < 1)
  assert.ok(Math.abs(snapToFrame(1020, 30) - 1033.333) < 1)
})

test('字幕时间 mm:ss.mmm 解析与回写', () => {
  assert.equal(formatClockMs(61234), '01:01.234')
  assert.equal(parseClockMs('01:02.500'), 62500)
  assert.equal(parseClockMs('1:02:03.250'), 3723250)
})

test('吸附点收集与阈值选择', () => {
  const layout = computeLocalLayout(plan([clip('a'), clip('b')]))
  const target = plan([clip('a'), clip('b')], {
    subtitles: [{
      id: 'cue1', text: '字幕', startMs: 3000, endMs: 3600,
      style: 'default', source: 'manual', follow: false, anchor: null,
    }],
  })
  const points = collectSnapPoints(target, layout, 1200)
  assert.ok(points.some((item) => item.kind === 'clip-start' && item.ms === 5000))
  assert.ok(points.some((item) => item.kind === 'clip-end' && item.ms === 5000))
  assert.ok(points.some((item) => item.kind === 'cue-start' && item.ms === 3000))
  assert.deepEqual(snapTime(3040, points, 60), {
    ms: 3000,
    point: points.find((item) => item.kind === 'cue-start'),
  })
  assert.deepEqual(snapTime(1245, points, 60), {
    ms: 1200,
    point: points.find((item) => item.kind === 'playhead'),
  })
  assert.deepEqual(snapTime(4200, points, 60), { ms: 4200, point: null })
})

test('跟随字幕随片段位置重算，手动字幕不动', () => {
  const base = plan([clip('a', { gapBeforeMs: 700 }), clip('b')], {
    subtitles: [{
      id: 'follow1', text: '跟随', startMs: 1000, endMs: 1600,
      style: 'default', source: 'line', follow: true,
      anchor: { clipId: 'a', offsetMs: 1000 }, lineId: 7,
    }, {
      id: 'manual1', text: '手动', startMs: 1000, endMs: 1600,
      style: 'default', source: 'manual', follow: false, anchor: null,
    }],
  })
  const layout = computeLocalLayout(base)
  const synced = syncFollowedCues(base, layout)
  assert.equal(synced.subtitles[0].startMs, 1700)
  assert.equal(synced.subtitles[0].endMs, 2300)
  assert.equal(synced.subtitles[1].startMs, 1000)
  assert.deepEqual(cueFollowRange(synced.subtitles[0], layout), { startMs: 1700, endMs: 2300 })
  assert.equal(cueFollowRange(synced.subtitles[1], layout), null)

  // 边界 1：锚点超出片段内容时长，镜像后端回退到「片段起点 + 100ms」
  assert.equal(layout.clips[0].timeline_start_ms, 700)
  assert.equal(layout.clips[0].timeline_end_ms, 5700)
  const overflowCue = {
    id: 'follow_overflow', text: '越界', startMs: 1000, endMs: 1600,
    style: 'default', source: 'line', follow: true,
    anchor: { clipId: 'a', offsetMs: 9000 }, lineId: 8,
  }
  assert.deepEqual(cueFollowRange(overflowCue, layout), { startMs: 700, endMs: 800 })
  const overflowPlan = plan([clip('a', { gapBeforeMs: 700 }), clip('b')], {
    subtitles: [overflowCue],
  })
  const overflowSynced = syncFollowedCues(overflowPlan, layout)
  assert.equal(overflowSynced.subtitles[0].startMs, 700)
  assert.equal(overflowSynced.subtitles[0].endMs, 800)

  // 边界 2：时长 <100ms 的跟随字幕补齐到 100ms（后端 Math.max(100, ...) 口径）
  const tinyCue = {
    id: 'follow_tiny', text: '极短', startMs: 1700, endMs: 1740,
    style: 'default', source: 'line', follow: true,
    anchor: { clipId: 'a', offsetMs: 1000 }, lineId: 9,
  }
  const tinyPlan = plan([clip('a', { gapBeforeMs: 700 }), clip('b')], {
    subtitles: [tinyCue],
  })
  const tinySynced = syncFollowedCues(tinyPlan, layout)
  assert.equal(tinySynced.subtitles[0].startMs, 1700)
  assert.equal(tinySynced.subtitles[0].endMs - tinySynced.subtitles[0].startMs, 100)
})

test('分割迁移锚点，裁剪平移锚点，变速缩放锚点', () => {
  const base = plan([clip('a'), clip('b')], {
    subtitles: [{
      id: 'cue1', text: '前半', startMs: 1200, endMs: 1700,
      style: 'default', source: 'line', follow: true,
      anchor: { clipId: 'a', offsetMs: 1200 }, lineId: 1,
    }, {
      id: 'cue2', text: '后半', startMs: 2200, endMs: 2700,
      style: 'default', source: 'line', follow: true,
      anchor: { clipId: 'a', offsetMs: 2200 }, lineId: 2,
    }],
  })
  const split = migrateCueAnchorsForSplit(base, 'a', 2000, 'a_second')
  assert.deepEqual(split.subtitles[0].anchor, { clipId: 'a', offsetMs: 1200 })
  assert.deepEqual(split.subtitles[1].anchor, { clipId: 'a_second', offsetMs: 200 })

  const shifted = shiftCueAnchors(base, 'a', 500)
  assert.deepEqual(shifted.subtitles[0].anchor, { clipId: 'a', offsetMs: 700 })
  assert.deepEqual(shifted.subtitles[1].anchor, { clipId: 'a', offsetMs: 1700 })

  const scaled = scaleCueAnchorsForSpeed(base, 'a', 1, 2)
  assert.deepEqual(scaled.subtitles[0].anchor, { clipId: 'a', offsetMs: 600 })
  assert.deepEqual(scaled.subtitles[1].anchor, { clipId: 'a', offsetMs: 1100 })
})
