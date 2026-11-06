import { test } from 'node:test'
import assert from 'node:assert/strict'

// 与 tests/edit-commands.test.mjs 相同的加载方式：Node 22+ 原生剥离 TS 类型，直接 import .ts 源文件。
const {
  setCueTime,
  setCueAppearance,
  applyAppearanceToAll,
  setSubtitleProjectDefaults,
  mergeCueWithNext,
  splitCueAt,
  addCueAtPlayhead,
} = await import('../app/utils/edit-commands.ts')
const { createEmptyEditPlan, projectSettingsForAspect } = await import('../app/utils/edit-plan.ts')

function planWithCue() {
  const plan = createEmptyEditPlan(1, projectSettingsForAspect('9:16'))
  plan.subtitles.push({
    id: 'cue_1',
    text: '你好',
    startMs: 0,
    endMs: 1000,
    style: 'default',
    role: null,
    source: 'manual',
    follow: false,
    anchor: null,
    lineId: null,
    warnings: [],
  })
  return plan
}

function planWithTwoCues() {
  const plan = planWithCue()
  plan.subtitles.push({
    id: 'cue_2',
    text: '世界',
    startMs: 1000,
    endMs: 2000,
    style: 'default',
    role: null,
    source: 'manual',
    follow: false,
    anchor: null,
    lineId: null,
    warnings: [],
  })
  return plan
}

test('setCueTime 校验起止并保持最短 100ms', () => {
  const plan = planWithCue()
  const result = setCueTime(plan, 'cue_1', { startMs: 2000, endMs: 1000 })
  const cue = result.plan.subtitles.find((c) => c.id === 'cue_1')
  assert.equal(cue.endMs, cue.startMs + 100)
})

test('setCueAppearance 写入显式外观且 style 变为 custom', () => {
  const plan = planWithCue()
  const result = setCueAppearance(plan, 'cue_1', { fontSize: 72, yPct: 10 })
  const cue = result.plan.subtitles.find((c) => c.id === 'cue_1')
  assert.equal(cue.style, 'custom')
  assert.equal(cue.appearance.fontSize, 72)
  assert.equal(cue.appearance.yPct, 10)
  // 未 patch 的字段继承工程默认
  assert.equal(cue.appearance.fontFamily, result.plan.project.subtitleAppearance.fontFamily)
})

test('applyAppearanceToAll 覆盖全部 cue，setSubtitleProjectDefaults 只改工程默认', () => {
  let plan = planWithCue()
  plan = applyAppearanceToAll(plan, { ...plan.project.subtitleAppearance, fontSize: 60 }).plan
  assert.ok(plan.subtitles.every((c) => c.appearance?.fontSize === 60))
  const before = plan.subtitles.map((c) => c.appearance?.fontSize)
  plan = setSubtitleProjectDefaults(plan, {
    appearance: { ...plan.project.subtitleAppearance, fontSize: 36 },
    safeAreaPct: 10,
  }).plan
  assert.equal(plan.project.subtitleAppearance.fontSize, 36)
  assert.equal(plan.project.subtitleSafeAreaPct, 10)
  assert.deepEqual(plan.subtitles.map((c) => c.appearance?.fontSize), before)
})

test('mergeCueWithNext 合并相邻文本并删除后一条', () => {
  const plan = planWithTwoCues() // cue_1 0–1000，cue_2 1000–2000
  const result = mergeCueWithNext(plan, 'cue_1')
  assert.equal(result.plan.subtitles.length, 1)
  assert.equal(result.plan.subtitles[0].text, '你好世界')
  assert.equal(result.plan.subtitles[0].endMs, 2000)
})

test('mergeCueWithNext 间隔超过 200ms 时拒绝合并并给出 warning', () => {
  const plan = planWithTwoCues()
  plan.subtitles[1].startMs = 2500
  plan.subtitles[1].endMs = 3500
  const result = mergeCueWithNext(plan, 'cue_1')
  assert.equal(result.plan, plan)
  assert.equal(result.plan.subtitles.length, 2)
  assert.ok(result.issues.some((issue) => issue.code === 'CUE_NOT_MERGABLE'))
})

test('splitCueAt 在中点拆分，addCueAtPlayhead 在播放头新建 2s 字幕', () => {
  let plan = planWithTwoCues()
  plan = splitCueAt(plan, 'cue_1', 500).plan
  assert.equal(plan.subtitles.length, 3)
  plan = addCueAtPlayhead(plan, 3000, plan.project).plan
  const added = plan.subtitles.find((c) => c.startMs === 3000)
  assert.ok(added)
  assert.equal(added.endMs - added.startMs, 2000)
  assert.equal(added.source, 'manual')
})

test('splitCueAt 拆分点太靠边时拒绝并给出 warning', () => {
  const plan = planWithCue()
  const result = splitCueAt(plan, 'cue_1', 10)
  assert.equal(result.plan, plan)
  assert.ok(result.issues.some((issue) => issue.code === 'CUE_SPLIT_RANGE'))
})
