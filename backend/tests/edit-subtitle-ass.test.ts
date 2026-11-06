import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assAlignmentFor,
  buildEditAss,
  buildEditSrt,
  fallbackExportFont,
  resolveSubtitleAppearance,
} from '../src/services/edit-subtitle-ass.ts'
import { createSingleClipPlan, projectSettingsForAspect } from '../src/services/edit-plan.ts'

function planWithCue(style: any, appearance: any) {
  // 注意：实际签名为 createSingleClipPlan(episodeId, source, project)
  const plan = createSingleClipPlan(1, {
    kind: 'episode-video',
    id: 1,
    url: 'static/projects/1/videos/film.mp4',
    durationMs: 10_000,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: true,
    fingerprint: 'fp-1',
  }, {
    ...projectSettingsForAspect('9:16', 30),
    width: 1080,
    height: 1920,
  })
  plan.subtitles = [{
    id: 'cue_1',
    text: '你好，世界',
    startMs: 1000,
    endMs: 3000,
    style,
    role: null,
    source: 'manual',
    follow: false,
    anchor: null,
    lineId: null,
    warnings: [],
    ...(appearance ? { appearance } : {}),
  }]
  return plan
}

test('底部居中映射 \\an2 与 \\pos(540, 1632)', () => {
  const plan = planWithCue('custom', null)
  const ass = buildEditAss(plan)
  const line = ass.split('\n').find((l) => l.startsWith('Dialogue:'))
  assert.ok(line)
  assert.ok(line!.includes('\\an2'), line)
  assert.ok(line!.includes('\\pos(540,1632)'), line)
})

test('转义：大括号与反斜杠不进入 ASS 控制符', () => {
  const plan = planWithCue('default', null)
  plan.subtitles[0].text = '看{这个}路径\\projects\\1'
  const line = buildEditAss(plan).split('\n').find((l) => l.startsWith('Dialogue:'))
  assert.ok(line!.includes('看（这个）'), line)
  assert.ok(!line!.includes('\\projects'), line)
  assert.ok(line!.includes('＼projects'), line)
})

test('对齐 × 纵向区映射九宫格 an 值', () => {
  assert.equal(assAlignmentFor('left', 10), 7)
  assert.equal(assAlignmentFor('center', 10), 8)
  assert.equal(assAlignmentFor('right', 10), 9)
  assert.equal(assAlignmentFor('left', 50), 4)
  assert.equal(assAlignmentFor('center', 50), 5)
  assert.equal(assAlignmentFor('center', 85), 2)
  assert.equal(assAlignmentFor('right', 85), 3)
  assert.equal(assAlignmentFor('left', 85), 1)
})

test('cue 外观覆盖工程默认：字号/颜色/描边内联标签', () => {
  const plan = planWithCue('custom', {
    fontFamily: 'KaiTi', fontSize: 64, color: '#FF0000', strokeColor: '#00FF00',
    strokeWidth: 3, backgroundColor: null, backgroundOpacity: 0,
    align: 'center', xPct: 50, yPct: 85,
  })
  const line = buildEditAss(plan).split('\n').find((l) => l.startsWith('Dialogue:'))
  assert.ok(line!.includes('\\fnKaiTi'))
  assert.ok(line!.includes('\\fs64'))
  assert.ok(line!.includes('\\1c&H0000FF&'))
  assert.ok(line!.includes('\\3c&H00FF00&'))
  assert.ok(line!.includes('\\bord3'))
})

test('旧计划无 appearance：按 style 预设解析（outline 描边 4）', () => {
  const plan = planWithCue('outline', null)
  const resolved = resolveSubtitleAppearance(plan.subtitles[0], plan)
  assert.equal(resolved.strokeWidth, 4)
  const line = buildEditAss(plan).split('\n').find((l) => l.startsWith('Dialogue:'))
  assert.ok(line!.includes('\\bord4'))
})

test('有背景色的 cue 使用 Boxed 样式并带 \\4c 透明度', () => {
  const plan = planWithCue('box', null)
  const line = buildEditAss(plan).split('\n').find((l) => l.startsWith('Dialogue:'))
  assert.ok(line!.includes('Boxed,'))
  assert.ok(/\\4c&H[0-9A-F]{6}&/.test(line!))
  assert.ok(/\\4a&H[0-9A-F]{2}&/.test(line!))
})

test('SRT 按时间排序且含序号/时间行', () => {
  const plan = planWithCue('default', null)
  plan.subtitles.push({ ...plan.subtitles[0], id: 'cue_0', startMs: 0, endMs: 500 })
  const srt = buildEditSrt(plan)
  assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:00,500\n'))
  assert.ok(srt.includes('2\n00:00:01,000 --> 00:00:03,000\n你好，世界\n'))
})

test('导出字体回退：白名单缺失时逐级降级', () => {
  assert.equal(fallbackExportFont('PingFang SC', ['Noto Sans CJK SC']), 'Noto Sans CJK SC')
  assert.equal(fallbackExportFont('PingFang SC', ['PingFang SC']), 'PingFang SC')
  assert.equal(fallbackExportFont('KaiTi', ['Noto Sans CJK SC']), 'Noto Sans CJK SC')
  assert.equal(fallbackExportFont('KaiTi', []), 'sans-serif')
})
