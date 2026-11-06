import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  frameMsOf,
  snapToFrame,
  rippleDeleteFrame,
  insertImageClip,
  insertFreezeFrame,
  buildFreezeTail,
  insertImageAtPlayheadNeedsSplit,
} = await import('../app/utils/edit-frame-commands.ts')
const { createClipFromSource } = await import('../app/utils/edit-commands.ts')
const { computeLocalLayout } = await import('../app/utils/edit-layout.ts')

function videoSource(id, durationMs) {
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

function imageAssetSource(id) {
  return {
    url: `static/${id}.png`,
    width: 1080,
    height: 1920,
    fingerprint: `img:${id}`,
    label: id,
  }
}

function plan(clips, fps = 25) {
  return {
    version: 1,
    episodeId: 1,
    project: {
      aspect: '16:9',
      width: 1920,
      height: 1080,
      fps,
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
  }
}

function planWithSingleVideoClip(durationMs, fps = 25) {
  const clip = {
    ...createClipFromSource('v1', videoSource('v1', durationMs)),
    sourceInMs: 0,
    sourceOutMs: durationMs,
  }
  return plan([clip], fps)
}

function planWithImageClip(durationMs) {
  const source = {
    kind: 'asset',
    id: 'img1',
    url: 'static/img1.png',
    durationMs,
    width: 1080,
    height: 1920,
    fps: null,
    hasAudio: false,
    fingerprint: 'img:1',
  }
  const clip = {
    ...createClipFromSource('img1', source, { kind: 'image' }),
    sourceInMs: 0,
    sourceOutMs: durationMs,
  }
  return plan([clip], 25)
}

function errorsOf(result) {
  return result.issues.filter((item) => item.severity === 'error')
}

test('帧网格：frameMsOf 与 snapToFrame', () => {
  assert.equal(frameMsOf(25), 40)
  assert.equal(frameMsOf(30), Math.round((1000 / 30) * 1000) / 1000)
  assert.equal(snapToFrame(1010, 25), 1000)
  assert.equal(snapToFrame(45, 25), 40)
})

test('帧级删除：片段内部删一帧，时长减一帧、片段数 +1、后续内容前移', () => {
  const planInput = planWithSingleVideoClip(10_000, 25)
  const before = computeLocalLayout(planInput).duration_ms
  const result = rippleDeleteFrame(planInput, 5000, 25)
  assert.equal(errorsOf(result).length, 0)
  const after = computeLocalLayout(result.plan).duration_ms
  assert.equal(before - after, 40)
  assert.equal(result.plan.clips.length, 2)
  // 前半段收短一帧，后半段（原内容 5000 起）整体前移 40ms
  assert.equal(result.plan.clips[0].sourceOutMs, 4960)
  const starts = computeLocalLayout(result.plan).clips.map((item) => item.timeline_start_ms)
  assert.deepEqual(starts, [0, 4960])
})

test('帧级删除：speed=2 时删一帧时间线 = 源区间缩 2 帧', () => {
  const base = planWithSingleVideoClip(10_000, 25)
  const fast = { ...base.clips[0], speed: 2 }
  const planInput = plan([fast], 25)
  const before = computeLocalLayout(planInput).duration_ms
  // 2520 = 63 帧（25fps 帧网格上的对齐位置）
  const result = rippleDeleteFrame(planInput, 2520, 25)
  assert.equal(errorsOf(result).length, 0)
  assert.equal(before - computeLocalLayout(result.plan).duration_ms, 40)
  assert.equal(result.plan.clips[0].sourceOutMs, 4960)
})

test('帧级删除：播放头在片段开头且存在前一片段时，裁掉前一片段的最后一帧', () => {
  const clipA = {
    ...createClipFromSource('a', videoSource('a', 10_000)),
    sourceInMs: 0,
    sourceOutMs: 5000,
  }
  const clipB = {
    ...createClipFromSource('b', videoSource('b', 10_000)),
    sourceInMs: 0,
    sourceOutMs: 5000,
  }
  const planInput = plan([clipA, clipB], 25)
  const result = rippleDeleteFrame(planInput, 5000, 25)
  assert.equal(errorsOf(result).length, 0)
  assert.equal(result.plan.clips.length, 2)
  assert.equal(result.plan.clips[0].sourceOutMs, 4960)
  assert.equal(result.plan.clips[1].sourceInMs, 0)
})

test('帧级删除：时间线起点（无前一片段）时，首片段 sourceInMs 增加一帧', () => {
  const planInput = planWithSingleVideoClip(10_000, 25)
  const result = rippleDeleteFrame(planInput, 0, 25)
  assert.equal(errorsOf(result).length, 0)
  assert.equal(result.plan.clips.length, 1)
  assert.equal(result.plan.clips[0].sourceInMs, 40)
})

test('帧级删除：片段太短时报 FRAME_DELETE_TOO_SHORT 并返回原计划', () => {
  const planInput = planWithSingleVideoClip(200, 25)
  const result = rippleDeleteFrame(planInput, 100, 25)
  const errors = errorsOf(result)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'FRAME_DELETE_TOO_SHORT')
  assert.equal(result.plan, planInput)
  assert.equal(result.plan.clips.length, 1)
})

test('帧级删除：图片片段内部删一帧，时长减一帧', () => {
  const planInput = planWithImageClip(3000)
  const before = computeLocalLayout(planInput).duration_ms
  const result = rippleDeleteFrame(planInput, 1500, 25)
  assert.equal(errorsOf(result).length, 0)
  assert.equal(before - computeLocalLayout(result.plan).duration_ms, 40)
})

test('帧级删除：只剩 1 帧的图片片段再删时报错', () => {
  const planInput = planWithImageClip(40)
  const result = rippleDeleteFrame(planInput, 0, 25)
  const errors = errorsOf(result)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'FRAME_DELETE_TOO_SHORT')
  assert.equal(result.plan.clips[0].sourceOutMs, 40)
})

test('插入图片片段：在片段中间先分割再插入，默认 3000ms，后续内容后移', () => {
  const planInput = planWithSingleVideoClip(10_000, 25)
  const result = insertImageClip(planInput, 5000, 25, imageAssetSource('pic'))
  assert.equal(errorsOf(result).length, 0)
  assert.equal(result.plan.clips.length, 3)
  const image = result.plan.clips[1]
  assert.equal(image.kind, 'image')
  assert.equal(image.sourceOutMs - image.sourceInMs, 3000)
  const layout = computeLocalLayout(result.plan)
  assert.equal(layout.duration_ms, 13_000)
  assert.equal(layout.clips[1].timeline_start_ms, 5000)
  assert.equal(layout.clips[2].timeline_start_ms, 8000)
})

test('插入图片片段：时长超出 30 秒或低于下限时被夹取并带 warning', () => {
  const long = insertImageClip(planWithSingleVideoClip(10_000, 25), 20_000, 25, imageAssetSource('pic'), 50_000)
  assert.equal(errorsOf(long).length, 0)
  assert.ok(long.issues.some((item) => item.severity === 'warning' && item.code === 'IMAGE_DURATION_CLAMPED'))
  assert.equal(long.plan.clips[1].sourceOutMs - long.plan.clips[1].sourceInMs, 30_000)

  const short = insertImageClip(planWithSingleVideoClip(10_000, 25), 20_000, 25, imageAssetSource('pic'), 5)
  assert.equal(errorsOf(short).length, 0)
  assert.ok(short.issues.some((item) => item.severity === 'warning' && item.code === 'IMAGE_DURATION_CLAMPED'))
  // 图片片段最短 1 帧（规范 §6.3）：25fps → 40ms
  assert.equal(short.plan.clips[1].sourceOutMs - short.plan.clips[1].sourceInMs, 40)
})

test('插入定格帧：默认 1000ms', () => {
  const result = insertFreezeFrame(planWithSingleVideoClip(10_000, 25), 20_000, 25, imageAssetSource('frz'))
  assert.equal(errorsOf(result).length, 0)
  assert.equal(result.plan.clips.length, 2)
  assert.equal(result.plan.clips[1].kind, 'image')
  assert.equal(result.plan.clips[1].sourceOutMs - result.plan.clips[1].sourceInMs, 1000)
})

test('定格延长：在指定片段后追加图片片段，原片段不动', () => {
  const planInput = planWithSingleVideoClip(10_000, 25)
  const result = buildFreezeTail(planInput, 'v1', 5000, 25, imageAssetSource('frz'))
  assert.equal(errorsOf(result).length, 0)
  assert.equal(result.plan.clips.length, 2)
  assert.equal(result.plan.clips[0].id, 'v1')
  assert.equal(result.plan.clips[0].sourceOutMs, 10_000)
  assert.equal(result.plan.clips[1].kind, 'image')
  assert.equal(result.plan.clips[1].sourceOutMs - result.plan.clips[1].sourceInMs, 5000)
})

test('定格延长：时长上限 600000ms', () => {
  const planInput = planWithSingleVideoClip(10_000, 25)
  const result = buildFreezeTail(planInput, 'v1', 10_000_000, 25, imageAssetSource('frz'))
  assert.equal(errorsOf(result).length, 0)
  assert.equal(result.plan.clips[1].sourceOutMs - result.plan.clips[1].sourceInMs, 600_000)
})

test('播放头插入图片是否需要先分割', () => {
  const planInput = planWithSingleVideoClip(10_000, 25)
  assert.equal(insertImageAtPlayheadNeedsSplit(planInput, 5000, 25), true)
  assert.equal(insertImageAtPlayheadNeedsSplit(planInput, 0, 25), false)
  assert.equal(insertImageAtPlayheadNeedsSplit(planInput, 10_000, 25), false)
})
