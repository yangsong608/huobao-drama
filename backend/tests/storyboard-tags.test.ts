import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  parseStoryboardTags,
  serializeStoryboardTags,
  deriveStoryboardTags,
} = await import('../src/services/storyboard-tags.ts')

test('标签解析支持数组、JSON、去重、非法值与上限', () => {
  assert.deepEqual(parseStoryboardTags(['combat', 'combat', 'unknown', 'empty']), ['combat', 'empty'])
  assert.deepEqual(parseStoryboardTags('["narration","dialogue"]'), ['narration', 'dialogue'])
  assert.deepEqual(parseStoryboardTags('not-json'), [])
  assert.deepEqual(parseStoryboardTags(null), [])
  const many = parseStoryboardTags([
    'transition', 'character', 'empty', 'dialogue', 'narration',
    'combat', 'competition', 'memory', 'transition', 'combat',
  ])
  assert.equal(many.length, 8)
  assert.equal(serializeStoryboardTags([]), null)
  assert.equal(serializeStoryboardTags(['combat']), '["combat"]')
})

test('自动标签：空镜、角色、对白、旁白、战斗、比拼、回忆、转场', () => {
  assert.deepEqual(
    deriveStoryboardTags({ characterCount: 0, description: '空荡的街道，风吹过。', videoPrompt: '' }),
    ['empty'],
  )
  const dialogue = deriveStoryboardTags({
    characterCount: 1,
    description: '张三说：「快走！」',
  })
  assert.ok(dialogue.includes('character'))
  assert.ok(dialogue.includes('dialogue'))
  assert.ok(!dialogue.includes('narration'))

  const narration = deriveStoryboardTags({
    characterCount: 1,
    description: '旁白（画外音）：「三年前，他离开了家乡。」',
  })
  assert.ok(narration.includes('narration'))
  assert.ok(!narration.includes('dialogue'))

  const combat = deriveStoryboardTags({
    characterCount: 2,
    description: '两人拔剑相向。',
    videoPrompt: '刀光碰撞，火花四溅。',
  })
  assert.ok(combat.includes('combat'))

  const competition = deriveStoryboardTags({
    characterCount: 2,
    description: '厨艺大赛决赛，评委席注视。',
  })
  assert.ok(competition.includes('competition'))

  const memory = deriveStoryboardTags({
    characterCount: 1,
    description: '多年前的往事浮现在眼前。',
  })
  assert.ok(memory.includes('memory'))

  const transition = deriveStoryboardTags({
    characterCount: 0,
    transition: 'fade',
    transitionKind: 'ai',
    description: '街景淡出。',
  })
  assert.ok(transition.includes('transition'))
})

test('战斗与比拼判定不依赖题材关键词', () => {
  const modernCombat = deriveStoryboardTags({
    characterCount: 2,
    description: '街头拳赛，两人扭打在一起，围观者惊呼。',
  })
  assert.ok(modernCombat.includes('combat'))
  const sciFiRace = deriveStoryboardTags({
    characterCount: 2,
    description: '机甲竞速赛冲过终点，计时牌刷新比分。',
  })
  assert.ok(sciFiRace.includes('competition'))
})
