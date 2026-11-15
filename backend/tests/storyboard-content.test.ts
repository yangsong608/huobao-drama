import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  combatEvidence,
  competitionEvidence,
  isCombatOrCompetitionText,
  strongCombatEvidence,
} = await import('../src/services/storyboard-content.ts')

test('战斗/比拼分类不依赖题材，只认镜头内容', () => {
  assert.ok(isCombatOrCompetitionText('两人拔剑相向，剑锋相撞。'))
  assert.ok(isCombatOrCompetitionText('机甲竞速赛冲过终点，计时牌刷新比分。'))
  assert.ok(isCombatOrCompetitionText('厨艺大赛决赛，评委席注视。'))
  assert.ok(isCombatOrCompetitionText('厨艺对决进入最后一轮。'))
  assert.equal(isCombatOrCompetitionText('她坐在窗前，望着门外的长街。'), false)
  assert.ok(strongCombatEvidence('两人拔剑相向').includes('拔剑'))
  assert.equal(strongCombatEvidence('厨艺对决').length, 0)
  assert.ok(competitionEvidence('厨艺大赛决赛').includes('厨艺'))
  assert.ok(combatEvidence('机甲战斗').includes('战斗'))
})
