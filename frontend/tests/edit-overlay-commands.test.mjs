import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  createVideoOverlay,
  createImageOverlay,
  createTextOverlay,
  moveOverlay,
  trimOverlay,
  setOverlayTransform,
  setOverlayOpacity,
  setOverlayFades,
  setOverlayText,
  removeOverlay,
  defaultOverlayTextStyle,
} = await import('../app/utils/edit-overlay-commands.ts')

function source(id, durationMs = 8000) {
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

function plan(extra = {}) {
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
    clips: [{
      id: 'clp_a',
      kind: 'video',
      source: source('clp_a'),
      sourceInMs: 0,
      sourceOutMs: 5000,
      speed: 1,
      volume: 1,
      gapBeforeMs: 0,
      videoFadeInMs: 0,
      videoFadeOutMs: 0,
      transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
      filter: { preset: 'none', intensity: 100 },
    }],
    transitions: [],
    subtitles: [],
    overlays: [],
    markers: [],
    ...extra,
  }
}

test('画中画：默认窗口取素材时长并落在播放头，超主轨截断', () => {
  const base = plan()
  const { plan: next, overlayId, issues } = createVideoOverlay(base, source('pip'), 1000)
  assert.ok(overlayId)
  assert.equal(issues.length, 0)
  const overlay = next.overlays[0]
  assert.equal(overlay.kind, 'video')
  assert.equal(overlay.startMs, 1000)
  assert.equal(overlay.endMs, 5000, '默认窗口取素材时长，但截断到主轨内容末尾 5000ms')
  assert.equal(overlay.transform.scale, 1)
  assert.equal(overlay.opacity, 1)

  // 短素材：窗口不超过素材时长
  const short = createVideoOverlay(base, source('pip2', 1500), 0)
  assert.equal(short.plan.overlays[0].endMs, 1500)

  // 播放头靠近主轨末尾：窗口截断到主轨内容末尾 5000ms
  const tail = createVideoOverlay(base, source('pip3', 8000), 4500)
  assert.equal(tail.plan.overlays[0].endMs, 5000)
  assert.ok(tail.plan.overlays[0].endMs > tail.plan.overlays[0].startMs)
})

test('图片与文字叠加：默认窗口 3 秒 / 2 秒，主轨为空时拒绝', () => {
  const base = plan()
  const image = createImageOverlay(base, { ...source('img'), url: 'static/img.png' }, 0)
  assert.equal(image.plan.overlays[0].kind, 'image')
  assert.equal(image.plan.overlays[0].endMs, 3000)

  const text = createTextOverlay(base, 0, { text: '标题' })
  assert.equal(text.plan.overlays[0].kind, 'text')
  assert.equal(text.plan.overlays[0].endMs, 2000)
  assert.equal(text.plan.overlays[0].text.text, '标题')
  assert.deepEqual(
    { ...defaultOverlayTextStyle(), ...{ text: '标题' } }.preset,
    'title',
  )

  const empty = plan({ clips: [] })
  assert.equal(createVideoOverlay(empty, source('x'), 0).overlayId, null)
  assert.ok(createVideoOverlay(empty, source('x'), 0).issues.some((i) => i.code === 'OVERLAY_NO_MAIN'))
  assert.equal(createImageOverlay(empty, source('x'), 0).overlayId, null)
  assert.equal(createTextOverlay(empty, 0).overlayId, null)
})

test('移动与裁剪叠加：主轨范围内收敛，最短一帧', () => {
  const base = plan()
  const created = createImageOverlay(base, { ...source('img'), url: 'static/img.png' }, 0)
  const id = created.overlayId

  const moved = moveOverlay(created.plan, id, 4200)
  let overlay = moved.plan.overlays[0]
  assert.equal(overlay.startMs, 2000, '3 秒窗口尾部贴合主轨末尾 5000ms')

  const trimmed = trimOverlay(moved.plan, id, { startMs: 1000, endMs: 6000 })
  overlay = trimmed.plan.overlays[0]
  assert.equal(overlay.startMs, 1000)
  assert.equal(overlay.endMs, 5000, '终点截断到主轨末尾')
  assert.ok(trimmed.issues.some((i) => i.code === 'OVERLAY_RANGE'))

  const tooShort = trimOverlay(trimmed.plan, id, { startMs: 1000, endMs: 1010 })
  overlay = tooShort.plan.overlays[0]
  assert.ok(overlay.endMs - overlay.startMs >= 34, '窗口最短一帧（30fps ≈ 34ms）')

  assert.equal(moveOverlay(base, 'ghost', 0).plan, base)
  assert.ok(moveOverlay(base, 'ghost', 0).issues.some((i) => i.code === 'OVERLAY_NOT_FOUND'))
})

test('画面调整：缩放 0.1–4、位移 -2..2、旋转翻转强制归零', () => {
  const base = plan()
  const created = createImageOverlay(base, { ...source('img'), url: 'static/img.png' }, 0)
  const id = created.overlayId
  const next = setOverlayTransform(created.plan, id, { scale: 9, x: 5, y: -5 })
  const transform = next.plan.overlays[0].transform
  assert.equal(transform.scale, 4)
  assert.equal(transform.x, 2)
  assert.equal(transform.y, -2)
  assert.equal(transform.rotation, 0)
  assert.equal(transform.flipH, false)
  assert.equal(transform.flipV, false)
})

test('不透明度与淡入淡出：0–1 与窗口夹取', () => {
  const base = plan()
  const created = createImageOverlay(base, { ...source('img'), url: 'static/img.png' }, 0)
  const id = created.overlayId
  const dimmed = setOverlayOpacity(created.plan, id, 1.5)
  assert.equal(dimmed.plan.overlays[0].opacity, 1)
  const transparent = setOverlayOpacity(dimmed.plan, id, -1)
  assert.equal(transparent.plan.overlays[0].opacity, 0)

  const faded = setOverlayFades(created.plan, id, 9999, 500)
  assert.equal(faded.plan.overlays[0].fadeInMs, 1500, '淡入夹取到 MAX_FADE_MS')
  assert.equal(faded.plan.overlays[0].fadeOutMs, 500)
})

test('文字样式：字号/描边/位置夹取，未知预设回退 subtitle', () => {
  const base = plan()
  const created = createTextOverlay(base, 0, { text: '标题' })
  const id = created.overlayId
  const styled = setOverlayText(created.plan, id, {
    text: '新标题'.padEnd(600, '字'),
    preset: 'bogus',
    fontSize: 999,
    strokeWidth: 99,
    x: 2,
    y: -1,
    align: 'bogus',
  })
  const style = styled.plan.overlays[0].text
  assert.equal(style.text.length, 500)
  assert.equal(style.preset, 'subtitle')
  assert.equal(style.fontSize, 300)
  assert.equal(style.strokeWidth, 20)
  assert.equal(style.x, 1)
  assert.equal(style.y, 0)
  assert.equal(style.align, 'center')

  assert.ok(setOverlayText(created.plan, 'ghost', {}).issues.some((i) => i.code === 'OVERLAY_NOT_FOUND'))
  const video = createVideoOverlay(base, source('pip'), 0)
  assert.ok(setOverlayText(video.plan, video.overlayId, {}).issues.some((i) => i.code === 'OVERLAY_NOT_TEXT'))
})

test('删除叠加：按 ID 移除，其余保留', () => {
  const base = plan()
  const first = createTextOverlay(base, 0, { text: '甲' })
  const second = createTextOverlay(first.plan, 0, { text: '乙' })
  const removed = removeOverlay(second.plan, first.overlayId)
  assert.equal(removed.plan.overlays.length, 1)
  assert.equal(removed.plan.overlays[0].text.text, '乙')
  assert.ok(removeOverlay(removed.plan, 'ghost').issues.some((i) => i.code === 'OVERLAY_NOT_FOUND'))
})
