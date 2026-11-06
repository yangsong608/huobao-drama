import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LINE_GAP_MS,
  MIN_LEAD_MS,
  buildEditTimeline,
  dialogPlacementsOf,
  mergeSuggestedSubtitles,
  suggestSubtitles,
  type EditLineRow,
  type EditTakeRow,
} from '../src/services/edit-timeline.ts'
import {
  createEmptyEditPlan,
  dialogueSyncHashOf,
  projectSettingsForAspect,
  type EditClipSource,
} from '../src/services/edit-plan.ts'

const project = projectSettingsForAspect('16:9', 30)

function source(id: number, durationMs: number): EditClipSource {
  return {
    kind: 'storyboard',
    id,
    url: `static/projects/1/videos/${id}.mp4`,
    durationMs,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    fingerprint: `${durationMs}:1`,
  }
}

function plan() {
  const value = createEmptyEditPlan(42, project)
  value.clips = [
    {
      id: 'clp_sb_11', kind: 'video', source: source(11, 5000), sourceInMs: 0, sourceOutMs: 5000,
      speed: 1, gapBeforeMs: 0, videoFadeInMs: 0, videoFadeOutMs: 0,
      transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
      filter: { preset: 'none', intensity: 100 },
    },
    {
      id: 'clp_sb_12', kind: 'video', source: source(12, 4000), sourceInMs: 0, sourceOutMs: 4000,
      speed: 1, gapBeforeMs: 0, videoFadeInMs: 0, videoFadeOutMs: 0,
      transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
      filter: { preset: 'none', intensity: 100 },
    },
  ]
  return value
}

function line(patch: Partial<EditLineRow>): EditLineRow {
  return {
    id: 1,
    storyboardId: 11,
    lineNo: 1,
    sortOrder: 0,
    text: '台词',
    subtitleText: null,
    speakerName: '林晚',
    speakerType: 'dialogue',
    voiceId: null,
    voiceStartMs: null,
    voiceDurationMs: null,
    audioUrl: 'static/audio/1.mp3',
    audioDurationMs: 1000,
    activeTakeId: null,
    anchorType: 'shot',
    ...patch,
  }
}

const takes: EditTakeRow[] = [{
  id: 77,
  lineId: 1,
  audioUrl: 'static/audio/take77.mp3',
  durationMs: 1200,
  hash: 'take77hash',
  isActive: true,
}]

test('按镜头顺序放置台词，保留溢出并映射绝对锚点', () => {
  const lines: EditLineRow[] = [
    line({ id: 1, audioDurationMs: 1000, activeTakeId: 77 }),
    line({ id: 2, lineNo: 2, audioDurationMs: 5000, text: '第二句' }),
    line({ id: 3, storyboardId: 12, lineNo: 1, audioDurationMs: 800, text: '第三句' }),
    line({ id: 4, storyboardId: 99, lineNo: 1, text: '无镜头' }),
    line({ id: 5, storyboardId: 12, lineNo: 2, anchorType: 'absolute', voiceStartMs: 6200, audioDurationMs: 900, text: '绝对句' }),
  ]
  const result = buildEditTimeline(plan(), lines, takes)

  assert.equal(result.durationMs, 9000)
  assert.equal(result.linePlacements.length, 4)
  assert.equal(result.unmappedLines.length, 1)
  assert.equal(result.unmappedLines[0].lineId, 4)

  const [first, second, third, absolute] = result.linePlacements
  assert.equal(first.lineId, 1)
  assert.equal(first.startMs, MIN_LEAD_MS)
  assert.equal(first.durationMs, 1200)
  assert.equal(first.voiceTakeId, 77)
  assert.equal(first.audioUrl, 'static/audio/take77.mp3')
  assert.equal(first.audioFingerprint, 'take77hash')

  assert.equal(second.startMs, MIN_LEAD_MS + 1200 + LINE_GAP_MS)
  assert.equal(second.overflowsClip, true)
  assert.ok(second.overflowMs > 0)

  assert.equal(third.clipId, 'clp_sb_12')
  assert.equal(third.startMs, 5000 + MIN_LEAD_MS)
  assert.equal(absolute.startMs, 6200)
  assert.equal(absolute.anchorType, 'absolute')

  const cues = suggestSubtitles(plan(), result.linePlacements)
  assert.equal(cues.length, 4)
  assert.equal(cues[0].follow, true)
  assert.deepEqual(cues[0].anchor, { clipId: 'clp_sb_11', offsetMs: MIN_LEAD_MS })
  assert.equal(cues[0].source, 'line')
  assert.equal(cues[0].lineId, 1)
  assert.ok(cues[1].warnings?.includes('SUBTITLE_OVERFLOW'))
  const absoluteCue = cues.find((cue) => cue.lineId === 5)
  assert.equal(absoluteCue?.startMs, 6200)

  const hashA = dialogueSyncHashOf(dialogPlacementsOf(result.linePlacements))
  const hashB = dialogueSyncHashOf(dialogPlacementsOf(result.linePlacements))
  assert.equal(hashA, hashB)
})

test('字幕合并不覆盖手动文本，只刷新未改动的台词 cue', () => {
  const result = buildEditTimeline(plan(), [line({ id: 1 })], [])
  const suggested = suggestSubtitles(plan(), result.linePlacements)
  const manual = {
    ...suggested[0],
    text: '用户改过的字幕',
    source: 'manual' as const,
    follow: false,
    anchor: null,
  }
  const merged = mergeSuggestedSubtitles([manual], suggested)
  assert.equal(merged.added, 0)
  assert.equal(merged.updated, 0)
  assert.equal(merged.cues[0].text, '用户改过的字幕')

  const editable = { ...suggested[0], text: '台词', startMs: 0, endMs: 100 }
  const refreshed = mergeSuggestedSubtitles([editable], suggested)
  assert.equal(refreshed.updated, 1)
  assert.equal(refreshed.cues[0].startMs, suggested[0].startMs)
})

test('绝对锚点落在片段空档时归到后一片段而非时间线末尾片段', () => {
  const gapped = plan()
  gapped.clips[1].gapBeforeMs = 1000
  gapped.clips.push({
    id: 'clp_sb_13', kind: 'video', source: source(13, 3000), sourceInMs: 0, sourceOutMs: 3000,
    speed: 1, gapBeforeMs: 0, videoFadeInMs: 0, videoFadeOutMs: 0,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    filter: { preset: 'none', intensity: 100 },
  })
  const result = buildEditTimeline(gapped, [
    line({ id: 6, storyboardId: 12, anchorType: 'absolute', voiceStartMs: 5500, audioDurationMs: 900, text: '空档句' }),
  ], [])

  assert.equal(result.linePlacements.length, 1)
  assert.equal(result.unmappedLines.length, 0)
  const [placed] = result.linePlacements
  assert.equal(placed.clipId, 'clp_sb_12')
  assert.equal(placed.startMs, 6000)
  assert.equal(placed.endMs, 6900)
  assert.equal(placed.anchorType, 'absolute')
})
