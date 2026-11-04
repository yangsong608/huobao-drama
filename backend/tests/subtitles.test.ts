import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildSubtitleCues,
  formatAssTime,
  formatSrtTime,
  maxCharsForAspect,
  splitText,
  toAss,
  toSrt,
  wrapLines,
} from '../src/services/subtitles.js'
import type { TimelineCue } from '../src/services/timeline.js'

function cue(partial: Partial<TimelineCue> & { lineId: number; startMs: number; endMs: number; text: string }): TimelineCue {
  return {
    shotId: 1,
    subtitleStartMs: partial.startMs,
    subtitleEndMs: partial.endMs,
    speaker: '旁白',
    kind: 'narration',
    speed: 1,
    overflowMs: 0,
    overlap: false,
    trimmed: false,
    audioDurationMs: partial.endMs - partial.startMs,
    audioUrl: null,
    ...partial,
  }
}

test('SRT/ASS 时间格式', () => {
  assert.equal(formatSrtTime(3_723_456), '01:02:03,456')
  assert.equal(formatAssTime(3_723_450), '1:02:03.45')
})

test('超长文本按标点切分且不超限', () => {
  const text = '他说这句话的时候声音很低，像是怕被人听见，又像是怕自己听不见，于是又重复了一遍。'
  const pieces = splitText(text, 20)
  assert.ok(pieces.length >= 2)
  for (const p of pieces) assert.ok([...p].length <= 20, `片段超长：${p}`)
  assert.equal(pieces.join(''), text)
})

test('两行排版优先在中间标点断开', () => {
  const lines = wrapLines('今天天气很好，我们一起出去走走吧', 10)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].endsWith('，'))
})

test('超长 cue 切成多条，时间按字数比例且不重叠', () => {
  const cues = buildSubtitleCues([
    cue({ lineId: 1, startMs: 0, endMs: 6000, text: '第一句话比较短。第二句话稍微长一点点，需要单独占一条字幕。第三句话也不短。' }),
  ])
  assert.ok(cues.length >= 2)
  for (let i = 1; i < cues.length; i += 1) {
    assert.ok(cues[i].startMs >= cues[i - 1].endMs - 1, '字幕时间不应重叠')
  }
  assert.equal(cues[0].startMs, 0)
  assert.equal(cues[cues.length - 1].endMs, 6000)
})

test('过短且同说话人的相邻 cue 合并', () => {
  const cues = buildSubtitleCues([
    cue({ lineId: 1, startMs: 0, endMs: 500, text: '嗯。' }),
    cue({ lineId: 2, startMs: 600, endMs: 1100, text: '我知道。' }),
  ])
  assert.equal(cues.length, 1)
  assert.equal(cues[0].text, '嗯。我知道。')
})

test('单条最长 6 秒，且不与下一条重叠', () => {
  const cues = buildSubtitleCues([
    cue({ lineId: 1, startMs: 0, endMs: 9000, text: '这一句会被截到六秒' }),
    cue({ lineId: 2, startMs: 6200, endMs: 7000, text: '下一句' }),
  ])
  assert.ok(cues[0].endMs <= 6200)
  assert.ok(cues[0].endMs - cues[0].startMs <= 6000)
})

test('SRT 输出包含序号、时间轴与两行文本', () => {
  const cues = buildSubtitleCues([cue({ lineId: 1, startMs: 1000, endMs: 3000, text: '这是一句测试旁白' })])
  const srt = toSrt(cues, { maxCharsPerLine: 5 })
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:03,000\n/)
  assert.ok(srt.includes('这是一句\n测试旁白'))
})

test('ASS 输出含样式与旁白斜体', () => {
  const cues = buildSubtitleCues([
    cue({ lineId: 1, startMs: 0, endMs: 2000, text: '旁白一句', kind: 'narration' }),
    cue({ lineId: 2, startMs: 2100, endMs: 4000, text: '角色一句', kind: 'dialogue', speaker: '唐大郎' }),
  ])
  const ass = toAss(cues, { width: 1080, height: 1920 })
  assert.match(ass, /PlayResX: 1080/)
  assert.match(ass, /Style: Narration,.*,-1,/)
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:02\.00,Narration/)
  assert.match(ass, /Dialogue: 0,0:00:02\.10,0:00:04\.00,Default,唐大郎/)
})

test('按画布比例决定每行字数', () => {
  assert.equal(maxCharsForAspect(1080, 1920), 14)
  assert.equal(maxCharsForAspect(1920, 1080), 20)
})
