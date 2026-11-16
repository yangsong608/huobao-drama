import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStoryboardPlanV2 } from '../src/services/storyboard-v2.ts'
import { V2_COVERAGE_PRESETS } from '../src/services/storyboard-v2-presets.ts'
import { renderV2PlanMarkdown } from '../src/services/storyboard-v2-markdown.ts'

const script = `## S01 | 内景 · 唐记食铺 | 清晨

唐奕：来了。

沈砚：走。

她看了他一眼。`

test('V2 计划记录当前覆盖预设与节奏目标', () => {
  const balanced = V2_COVERAGE_PRESETS.find(preset => preset.key === 'balanced')!
  const plan = buildStoryboardPlanV2({ script, shotStart: 1, maxDuration: 15, minDuration: 2 }, { coveragePreset: balanced })
  assert.equal(plan.config.coveragePresetKey, 'balanced')
  assert.equal(plan.config.rhythmTargetSeconds, 5)
  assert.equal(plan.shots.some(shot => shot.camera.shotSize === 'close_up'), false)
})

test('短剧快节奏预设提高近景倾向', () => {
  const fast = V2_COVERAGE_PRESETS.find(preset => preset.key === 'fast')!
  const fastScript = `${script}\n\n曹斌：为什么？\n\n沈砚：因为打印成绩单的时候，它总在最关键的时候坏。`
  const plan = buildStoryboardPlanV2({ script: fastScript, shotStart: 1, maxDuration: 15, minDuration: 2 }, { coveragePreset: fast })
  assert.equal(plan.config.closeUpBias, 'high')
  assert.ok(plan.shots.some(shot => shot.camera.shotSize === 'close_up'))
})

test('反应强调/对话优先预设会改变反应切镜倾向', () => {
  const reaction = V2_COVERAGE_PRESETS.find(preset => preset.key === 'reaction')!
  const dialogue = V2_COVERAGE_PRESETS.find(preset => preset.key === 'dialogue')!
  const withReaction = buildStoryboardPlanV2({ script, shotStart: 1, maxDuration: 15, minDuration: 2 }, { coveragePreset: reaction })
  const withDialogue = buildStoryboardPlanV2({ script, shotStart: 1, maxDuration: 15, minDuration: 2 }, { coveragePreset: dialogue })
  assert.ok(withReaction.shots.length >= withDialogue.shots.length)
  assert.ok(withReaction.shots.some(shot => shot.coverage === 'reaction'))
})

test('V2 Markdown 导出包含预设、镜头与结构问题', () => {
  const plan = buildStoryboardPlanV2({ script, shotStart: 1, maxDuration: 15, minDuration: 2 })
  const markdown = renderV2PlanMarkdown(plan)
  assert.match(markdown, /分镜 V2 计划/)
  assert.match(markdown, /覆盖预设：/)
  assert.match(markdown, /## 镜头/)
  assert.match(markdown, /S001/)
})
