import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateActionTiming } from '../src/services/action-timing.ts'

test('动作时长只计可见动作，不把服装和背景描写算成时间', () => {
  const staticText = '她穿白色圆领T恤外罩浅卡其色工装衬衫，脖子上挂着校报记者证，斜挎一台旧单反，背景是横幅与折叠桌。'
  assert.equal(estimateActionTiming(staticText).events, 0)
  assert.equal(estimateActionTiming(staticText).seconds, 0)

  const action = estimateActionTiming('她回头转身，右手按下快门。')
  assert.equal(action.events, 2)
  assert.ok(action.seconds > 0)
})

test('慢动作比快动作需要更长事件时间', () => {
  const slow = estimateActionTiming('她慢慢抬起手，缓缓把预算单放下。')
  const fast = estimateActionTiming('她突然抬手，一把放下预算单。')
  assert.ok(slow.seconds > fast.seconds)
})

test('静态对白引号不重复计入动作', () => {
  const timing = estimateActionTiming('他抬手。@沈砚说：「快走！」')
  assert.equal(timing.events, 1)
})
