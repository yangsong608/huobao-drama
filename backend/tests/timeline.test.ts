import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildTimeline, MAX_ATEMPO, type TimelineClip, type TimelineLine } from '../src/services/timeline.js'

const clip = (id: number, durationMs: number): TimelineClip => ({ storyboardId: id, storyboardNumber: id, durationMs })
const line = (id: number, shotId: number, durationMs: number, planned = 0): TimelineLine => ({
  lineId: id,
  storyboardId: shotId,
  lineNo: id,
  text: `第${id}句`,
  speaker: '旁白',
  kind: 'narration',
  plannedStartMs: planned,
  audioDurationMs: durationMs,
})

test('镜头起点累加正确：第二镜的计划时间要加 shotStart', () => {
  const r = buildTimeline({
    clips: [clip(1, 3000), clip(2, 4000)],
    lines: [line(1, 2, 1000, 500)],
  })
  assert.equal(r.cues[0].startMs, 3500)
  assert.equal(r.cues[0].endMs, 4500)
  assert.equal(r.totalDurationMs, 7000)
})

test('planned_start_ms 是镜头内相对时间，不会被当成整集绝对时间', () => {
  const r = buildTimeline({
    clips: [clip(1, 3000)],
    lines: [line(1, 1, 800, 3000)],
  })
  // 计划 3000ms 已被镜长夹住：起点 = 0 + max(250, 3000) = 3000
  assert.equal(r.cues[0].startMs, 3000)
})

test('手动绝对起点与占位时长覆盖自动排布', () => {
  const r = buildTimeline({
    clips: [clip(1, 3000), clip(2, 3000)],
    lines: [
      { ...line(1, 1, 1000), startOverrideMs: 1200, durationOverrideMs: 400 },
      { ...line(2, 1, 1000), startOverrideMs: 5000 },
    ],
    totalDurationMs: 6000,
  })
  assert.equal(r.cues[0].startMs, 1200)
  assert.equal(r.cues[0].endMs, 1600)
  assert.equal(r.cues[1].startMs, 5000)
  assert.equal(r.cues[1].endMs, 6000)
})

test('手动起点越过片尾的台词被跳过并记录', () => {
  const r = buildTimeline({
    clips: [clip(1, 3000)],
    lines: [{ ...line(1, 1, 1000), startOverrideMs: 4000 }],
    totalDurationMs: 3000,
  })
  assert.equal(r.cues.length, 0)
  assert.deepEqual(r.skippedLineIds, [1])
})

test('绝对锚点台词不依赖镜头，按整集时间排布', () => {
  const r = buildTimeline({
    clips: [clip(1, 3000), clip(2, 3000)],
    lines: [
      line(2, 2, 800),
      { ...line(1, 0, 1200), storyboardId: null, lineNo: 1, startOverrideMs: 500 },
    ],
    totalDurationMs: 6000,
  })
  assert.equal(r.cues.length, 2)
  assert.equal(r.cues[0].lineId, 1)
  assert.equal(r.cues[0].shotId, null)
  assert.equal(r.cues[0].startMs, 500)
  assert.equal(r.cues[0].endMs, 1700)
  assert.equal(r.cues[1].startMs, 3250)
})

test('绝对锚点缺少手动起点时跳过，不静默排到 0', () => {
  const r = buildTimeline({
    clips: [clip(1, 3000)],
    lines: [{ ...line(1, 0, 1000), storyboardId: null }],
    totalDurationMs: 3000,
  })
  assert.equal(r.cues.length, 0)
  assert.deepEqual(r.skippedLineIds, [1])
})

test('首句至少留 250ms 呼吸，同镜内不重叠', () => {
  const r = buildTimeline({
    clips: [clip(1, 8000)],
    lines: [line(1, 1, 2000, 0), line(2, 1, 2000, 300)],
  })
  assert.equal(r.cues[0].startMs, 250)
  assert.equal(r.cues[0].endMs, 2250)
  // 第二句被 cursor 推到第一句之后（+180ms 间隔），不覆盖前一句尾音
  assert.equal(r.cues[1].startMs, 2430)
  assert.equal(r.cues[1].overlap, false)
})

test('超长先 atempo（≤1.12），仍超只记 overflow 不截断', () => {
  const r = buildTimeline({
    clips: [clip(1, 3000), clip(2, 3000)],
    lines: [line(1, 1, 5000, 250)],
  })
  const cue = r.cues[0]
  assert.equal(cue.speed, MAX_ATEMPO)
  assert.equal(r.atempoCount, 1)
  // 5000 / 1.12 ≈ 4464，起点 250 → 4714，镜尾 3000 + 1500 容差 = 4500，溢出 214
  assert.equal(cue.endMs, 4714)
  assert.equal(cue.overflowMs, 214)
})

test('字幕结束不越过下一句开始前 100ms', () => {
  const r = buildTimeline({
    clips: [clip(1, 10000)],
    lines: [line(1, 1, 3000, 250), line(2, 1, 3000, 2800)],
  })
  const [first, second] = r.cues
  assert.ok(first.subtitleEndMs <= second.startMs - 100)
  assert.equal(second.subtitleStartMs, second.startMs)
})

test('整集最后一句超出片尾时裁到片尾并标记 trimmed', () => {
  const r = buildTimeline({
    clips: [clip(1, 2000)],
    lines: [line(1, 1, 3000, 250)],
  })
  const cue = r.cues[0]
  assert.equal(cue.endMs, 2000)
  assert.equal(cue.trimmed, true)
  assert.equal(r.trimmedCount, 1)
})

test('找不到镜头归属的台词被跳过并记录', () => {
  const r = buildTimeline({
    clips: [clip(1, 3000)],
    lines: [line(1, 1, 1000), line(2, 99, 1000)],
  })
  assert.equal(r.cues.length, 1)
  assert.deepEqual(r.skippedLineIds, [2])
})

test('无台词时时间轴仍返回视频总时长', () => {
  const r = buildTimeline({ clips: [clip(1, 2500), clip(2, 1500)], lines: [] })
  assert.equal(r.cues.length, 0)
  assert.equal(r.totalDurationMs, 4000)
})
