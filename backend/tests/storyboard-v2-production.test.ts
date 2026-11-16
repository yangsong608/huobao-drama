import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStoryboardPlanV2 } from '../src/services/storyboard-v2.ts'
import { planProductionStoryboardShots, v2PlanToPlannedShots } from '../src/services/storyboard-v2-production.ts'
import { buildPlannedShotsBlock } from '../src/services/storyboard-planner.ts'

const script = `## S01 | 内景 · 唐记食铺 | 清晨

唐奕坐在柜台后整理木料。

唐奕：今天的木料已经整理好了。

沈砚：走。`

test('V2 计划可投影为现有骨架生产契约', () => {
  const plan = buildStoryboardPlanV2({
    script,
    shotStart: 1,
    maxDuration: 15,
    minDuration: 2,
    characters: [{ name: '唐奕' }, { name: '沈砚' }],
  })
  assert.equal(plan.issues.length, 0)
  const shots = v2PlanToPlannedShots(plan, { script, shotStart: 10 })
  assert.equal(shots.length, plan.shots.length)
  assert.equal(shots[0].storyboardNumber, 10)
  assert.equal(shots[0].shotNumber, 10)
  assert.ok(script.replace(/\s+/g, '').includes(shots[0].sourceExcerpt.replace(/\s+/g, '')))
  assert.equal(shots[0].coverageType, plan.shots[0].coverage)
  assert.equal(shots[0].speechSegments[0]?.text, '今天的木料已经整理好了。')
  assert.ok(shots[0].duration >= 2)
  const block = buildPlannedShotsBlock(shots, 'dialogue')
  assert.match(block, /固定 \d+ 个骨架/)
  assert.match(block, /第 10 镜/)
})


test('生产入口可按开关选择 V1/V2，并返回可锁定镜头', () => {
  const base = {
    script,
    shotStart: 1,
    maxDuration: 15,
    minDuration: 2,
    characters: [{ name: '唐奕' }, { name: '沈砚' }],
  }
  const v2 = planProductionStoryboardShots(base, { useV2: true })
  const v1 = planProductionStoryboardShots(base, { useV2: false })
  assert.ok(v2.shots.length > 0)
  assert.ok(v1.shots.length > 0)
  assert.ok(v2.coverage > 0)
  assert.ok(v1.coverage > 0)
  assert.equal(v2.shots[0].storyboardNumber, 1)
})


test('长台词拆片投影后摘录仍按原文顺序连续', () => {
  const long = '这是一段很长的台词，用来验证拆片后的骨架摘录不会重复整句，也不会破坏原文顺序，所以这里继续写到超过十五秒的长度。'
  const longScript = `## S01 | 内景 · 唐记食铺 | 清晨\n\n唐奕：${long}`
  const plan = buildStoryboardPlanV2({
    script: longScript,
    shotStart: 1,
    maxDuration: 15,
    minDuration: 2,
    characters: [{ name: '唐奕' }],
  }, {
    timingProfiles: {
      唐奕: {
        speaker: '唐奕', characterId: 1, voiceId: 1, charsPerSecond: 3, pauseSeconds: 0, sampleCount: 2, source: 'line_takes',
      },
    },
  })
  const shots = v2PlanToPlannedShots(plan, { script: longScript, shotStart: 1 })
  assert.ok(shots.length >= 2)
  const body = longScript.split('\n').filter(line => line.trim() && !line.startsWith('##')).join('').replace(/\s+/g, '')
  let cursor = 0
  for (const shot of shots) {
    const excerpt = shot.sourceExcerpt.replace(/\s+/g, '')
    const index = body.indexOf(excerpt, cursor)
    assert.ok(index >= cursor, `摘录不在原文顺序中：${excerpt}`)
    cursor = index + excerpt.length
  }
})
