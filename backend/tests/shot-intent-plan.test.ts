import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  buildShotIntentPlan,
  formatIntentPlanBlock,
  intentPlanFromRow,
  validateIntentAdherence,
  validateSilentRuns,
} = await import('../src/services/shot-intent-plan.ts')

test('战斗镜只看内容：不同题材都能识别，且默认禁止旁白', () => {
  const samples = [
    '两名剑客拔剑相向，刀光一闪，剑锋相撞。',
    '两军阵前炮火轰鸣，士兵冲锋，爆炸掀起尘土。',
    '机甲的拳头砸在对方装甲上，火花四溅。',
  ]
  for (const excerpt of samples) {
    const plan = buildShotIntentPlan({
      duration: 8,
      actionSummary: excerpt,
      sourceExcerpt: excerpt,
      characterCount: 2,
    })
    assert.equal(plan.intent, 'combat', excerpt)
    assert.equal(plan.narration.mode, 'none', excerpt)
    assert.equal(plan.action.category, 'combat', excerpt)
    assert.equal(plan.action.narrationForbidden, true, excerpt)
    assert.ok(plan.action.vfx.length > 0)
    assert.match(formatIntentPlanBlock(plan), /禁止旁白/)
  }
})

test('比拼/竞技不依赖武林玄幻等题材，机甲竞速不会被误判成战斗', () => {
  const samples = [
    '厨艺大赛进入决赛，评委席上众人注视，选手端出最后一道菜。',
    '机甲竞速赛冲过第三赛道，计时牌刷新比分。',
    '辩论赛总决赛，双方选手交替发言，观众席安静。',
  ]
  for (const excerpt of samples) {
    const plan = buildShotIntentPlan({
      duration: 8,
      actionSummary: excerpt,
      sourceExcerpt: excerpt,
      characterCount: 2,
    })
    assert.equal(plan.intent, 'competition', excerpt)
    assert.equal(plan.narration.mode, 'none', excerpt)
    assert.equal(plan.action.narrationForbidden, true, excerpt)
  }
})

test('动作镜没有原文旁白时禁止旁白', () => {
  const plan = buildShotIntentPlan({
    duration: 7,
    actionSummary: '她推门进屋，把篮子放在桌上。',
    actionStart: '她站在门外',
    actionEnd: '篮子落在桌上',
    sourceExcerpt: '她推门进屋，把篮子放在桌上。',
    characterCount: 1,
    projectStyleText: '调教大宋 宋史·市井商战 古代 街市',
  })
  assert.equal(plan.intent, 'action')
  assert.equal(plan.narration.mode, 'none')
  assert.equal(plan.action.category, 'action')
  assert.ok(plan.action.beats.length > 0)
  assert.ok(plan.action.vfx.some(item => /冲击|风格|写实/.test(item)))
  assert.equal(plan.action.styleNote, '古代市井质感与写实动作冲击')
  const modern = buildShotIntentPlan({
    duration: 7,
    actionSummary: '司机推开车门，冲过马路。',
    sourceExcerpt: '司机推开车门，冲过马路。',
    characterCount: 1,
    projectStyleText: '现代都市悬疑',
  })
  assert.equal(modern.action.styleNote, '写实都市动作与现场环境反馈')
})

test('原文明确标注旁白时逐字保留，即使镜头内容是战斗', () => {
  const line = '三年前的那场大战，他失去了师父。'
  const plan = buildShotIntentPlan({
    duration: 10,
    actionSummary: '两军交战，刀光剑影。',
    sourceExcerpt: `旁白（画外音）：「${line}」\n两军交战，刀光剑影。`,
    speechSegments: [{ speaker: '旁白', text: line, sourceQuote: `旁白（画外音）：「${line}」` }],
    characterCount: 2,
  })
  assert.equal(plan.intent, 'combat')
  assert.equal(plan.narration.mode, 'source')
  assert.deepEqual(plan.narration.lines, [line])
  assert.equal(plan.action.narrationForbidden, false)
})

test('对白镜不生成旁白，旁白预算按正常语速计算', () => {
  const plan = buildShotIntentPlan({
    duration: 6,
    sourceExcerpt: '张三说：「快走！」',
    speechSegments: [{ speaker: '张三', text: '快走！' }],
    characterCount: 1,
  })
  assert.equal(plan.intent, 'dialogue')
  assert.equal(plan.narration.mode, 'none')
  assert.equal(plan.narration.budgetChars, 34)
  const longLine = '这是一段超过三十四个字预算的旁白内容需要拆分到相邻镜头继续说完并保证每个镜头都能完整表达'
  const overflow = buildShotIntentPlan({
    duration: 6,
    sourceExcerpt: `旁白：${longLine}`,
    characterCount: 1,
  })
  assert.equal(overflow.narration.mode, 'source')
  assert.equal(overflow.narration.overflow, true)
})

test('角色介绍只在角色首次出现时成立', () => {
  const input = {
    duration: 8,
    sourceExcerpt: '众人第一次见到这位新来的掌柜，她转身离开。',
    actionSummary: '她转身离开',
    characterCount: 1,
    characterIds: [7],
  }
  const first = buildShotIntentPlan({ ...input, previousCharacterIds: [] })
  assert.equal(first.intent, 'character_intro')
  const later = buildShotIntentPlan({ ...input, previousCharacterIds: [7] })
  assert.notEqual(later.intent, 'character_intro')
})

test('意图门禁拦截动作镜自行加旁白，并要求计划旁白逐字落地', () => {
  const combat = buildShotIntentPlan({
    duration: 8,
    sourceExcerpt: '两人挥剑相撞，火花四溅。',
    actionSummary: '两人挥剑相撞',
    characterCount: 2,
  })
  const blocked = validateIntentAdherence(
    combat,
    '两人挥剑相撞。旁白（画外音）：「他们不知道，这是最后一战。」',
    '信息头\n旁白（画外音）：「他们不知道，这是最后一战。」',
  )
  assert.ok(blocked.errors.some(item => item.includes('禁止旁白')))

  const narration = buildShotIntentPlan({
    duration: 8,
    sourceExcerpt: '旁白：他离开家乡。',
    characterCount: 1,
  })
  const missing = validateIntentAdherence(narration, '他站在门口。', '信息头\n他站在门口。')
  assert.ok(missing.errors.some(item => item.includes('计划旁白没有逐字写入 description')))
})

test('逐字旁白拆进多个时间帧仍算完整落地', () => {
  const plan = buildShotIntentPlan({
    duration: 6,
    sourceExcerpt: '旁白：摊位后面，罗晴把一叠预算单拍在折叠桌上。',
    characterCount: 1,
  })
  assert.equal(plan.narration.mode, 'source')
  const desc = '罗晴把预算单拍在桌上。旁白（画外音）：「摊位后面，罗晴把一叠预算单拍在折叠桌上。」'
  const prompt = [
    '0-1秒：罗晴抬起预算单。旁白（画外音）：「摊位后面，」',
    '1-5秒：罗晴把预算单拍在桌上。旁白（画外音）：「罗晴把一叠预算单拍在折叠桌上」',
  ].join('\n')
  const result = validateIntentAdherence(plan, desc, prompt)
  assert.deepEqual(result.errors.filter(item => item.includes('计划旁白')), [])
})

test('只有发声要求、没有具体台词时仍按对白计划处理', () => {
  const plan = buildShotIntentPlan({
    duration: 7,
    sourceExcerpt: '小贩站在街边吆喝揽客。',
    actionSummary: '小贩吆喝揽客',
    speechRequirement: { speaker: '小贩', basis: '吆喝揽客' },
    characterCount: 1,
  })
  assert.equal(plan.intent, 'dialogue')
  assert.equal(plan.narration.mode, 'none')
  assert.ok(plan.evidence.some(item => item.includes('吆喝揽客')))
})

test('旁白里提到战斗不会把安静的画面判成战斗镜', () => {
  const plan = buildShotIntentPlan({
    duration: 10,
    sourceExcerpt: '旁白：多年前那场厮杀，他至今记得。\n她坐在窗前，低头缝补衣服。',
    speechSegments: [{ speaker: '旁白', text: '多年前那场厮杀，他至今记得。' }],
    characterCount: 1,
  })
  assert.equal(plan.intent, 'exposition')
  assert.equal(plan.narration.mode, 'source')
  assert.equal(plan.action.category, 'none')
})

test('意图计划标签包含记忆/战斗/比拼等结构信息', () => {
  const memory = buildShotIntentPlan({
    duration: 8,
    sourceExcerpt: '多年前的往事浮现在眼前。',
    characterCount: 1,
  })
  assert.equal(memory.intent, 'exposition')
  assert.ok(memory.tags.includes('memory'))
  const combat = buildShotIntentPlan({
    duration: 8,
    sourceExcerpt: '两人拔剑相向。',
    characterCount: 2,
  })
  assert.ok(combat.tags.includes('combat'))
})

test('开场建置镜允许把原文背景叙述作为画外旁白', () => {
  const plan = buildShotIntentPlan({
    duration: 6,
    shotType: 'establishing',
    sourceExcerpt: '卯时未过，朝阳初升，邓州西市街面已是人声鼎沸。',
    characterCount: 0,
    isOpeningShot: true,
  })
  assert.equal(plan.intent, 'empty')
  assert.equal(plan.narration.mode, 'source')
  assert.ok(plan.narration.lines.length > 0)
  assert.ok(plan.tags.includes('narration'))
  assert.ok(!plan.tags.includes('empty'))
  const later = buildShotIntentPlan({
    duration: 6,
    shotType: 'establishing',
    sourceExcerpt: '卯时未过，朝阳初升，邓州西市街面已是人声鼎沸。',
    characterCount: 0,
    isOpeningShot: false,
  })
  assert.equal(later.narration.mode, 'none')
  const longer = buildShotIntentPlan({
    duration: 10,
    shotType: 'establishing',
    sourceExcerpt: '卯时未过，朝阳初升，邓州西市街面已是人声鼎沸，各色商铺临街而立，贩夫走卒往来穿梭。',
    characterCount: 0,
    isOpeningShot: true,
  })
  assert.ok([...longer.narration.lines[0]].length <= 24)
})

test('连续无声门禁：最多 2 个连续无声镜，单个不超过 6 秒', () => {
  const entry = (n: number, duration = 6) => ({
    storyboardNumber: n,
    intent: 'action' as const,
    duration,
    speechCount: 0,
    narrationMode: 'none' as const,
  })
  assert.equal(validateSilentRuns([entry(1), entry(2)]).length, 0)
  assert.ok(validateSilentRuns([entry(1), entry(2), entry(3)]).some(item => item.includes('连续 3 个无声镜')))
  assert.ok(validateSilentRuns([entry(1, 8)]).some(item => item.includes('超过 6 秒')))
  assert.equal(validateSilentRuns([
    { ...entry(1), intent: 'combat' },
    { ...entry(2), intent: 'combat' },
    { ...entry(3), intent: 'combat' },
  ]).length, 0)
})

test('压缩过渡镜按 transition 处理，并允许原文叙述旁白', () => {
  const plan = buildShotIntentPlan({
    duration: 6,
    actionSummary: '她回身望向门外的长队。',
    sourceExcerpt: '她回身望向门外的长队，心里愈发不是滋味。',
    characterCount: 1,
    compressedSilent: true,
  })
  assert.equal(plan.intent, 'transition')
  assert.equal(plan.narration.mode, 'source')
  assert.ok(plan.tags.includes('transition'))
  assert.equal(plan.action.category, 'none')
})

test('意图计划可从骨架行读取并保持结构', () => {
  const plan = buildShotIntentPlan({
    duration: 8,
    sourceExcerpt: '两人交手，拳风呼啸。',
    actionSummary: '两人交手',
    characterCount: 2,
  })
  const restored = intentPlanFromRow({
    intentType: plan.intent,
    narrationJson: JSON.stringify(plan.narration),
    actionPlanJson: JSON.stringify(plan.action),
  })
  assert.ok(restored)
  assert.equal(restored?.intent, 'combat')
  assert.equal(restored?.narration.mode, 'none')
  assert.equal(restored?.action.category, 'combat')
})

test('旁白驱动形态：动作镜产出改写式旁白计划，不再禁旁白', () => {
  const plan = buildShotIntentPlan({
    duration: 10,
    actionSummary: '她推门进屋，把篮子放在桌上。',
    sourceExcerpt: '她推门进屋，把篮子放在桌上，心里盘算着明天的生计。',
    characterCount: 1,
    narrationForm: 'narration',
  })
  assert.equal(plan.narration.mode, 'adapted')
  assert.equal(plan.narration.form, 'narration')
  assert.ok(plan.narration.lines.length > 0)
  assert.equal(plan.action.narrationForbidden, false)
  assert.ok(plan.tags.includes('narration'))
  const block = formatIntentPlanBlock(plan)
  assert.match(block, /改写式画外旁白/)
  assert.match(block, /第三人称完整句/)
  assert.match(block, /不得逐字复述对白/)
})

test('旁白驱动形态：对白镜旁白素材排除对白原文', () => {
  const plan = buildShotIntentPlan({
    duration: 12,
    sourceExcerpt: '唐奕回到柜台，望着店外忙碌的马老三。马老三说：「咱就留在这吧。」夫妇俩担起抚养的重担。',
    speechSegments: [{ speaker: '马老三', text: '咱就留在这吧。' }],
    characterCount: 2,
    narrationForm: 'narration',
  })
  assert.equal(plan.intent, 'dialogue')
  assert.equal(plan.narration.mode, 'adapted')
  assert.ok(!plan.narration.lines.join('').includes('咱就留在这吧'))
  assert.equal(plan.action.narrationForbidden, false)
})

test('旁白驱动形态：纯对白无叙述 prose 时不配旁白', () => {
  const plan = buildShotIntentPlan({
    duration: 8,
    sourceExcerpt: '马老三说：「咱就留在这吧。」',
    speechSegments: [{ speaker: '马老三', text: '咱就留在这吧。' }],
    characterCount: 1,
    narrationForm: 'narration',
  })
  assert.equal(plan.narration.mode, 'none')
  assert.equal(plan.narration.form, 'narration')
})

test('旁白驱动形态：第 1 镜必须有开场旁白', () => {
  const plan = buildShotIntentPlan({
    duration: 8,
    sourceExcerpt: '邓州西市，清晨的街面渐渐热闹起来。',
    characterCount: 0,
    isOpeningShot: true,
    narrationForm: 'narration',
  })
  assert.equal(plan.narration.mode, 'adapted')
  assert.match(plan.narration.reason, /开场/)
})

test('旁白驱动形态：战斗镜也可配改写式旁白', () => {
  const plan = buildShotIntentPlan({
    duration: 10,
    actionSummary: '两名剑客拔剑相向，刀光一闪。',
    sourceExcerpt: '两名剑客拔剑相向，刀光一闪，这一战关乎师门荣辱。',
    characterCount: 2,
    narrationForm: 'narration',
  })
  assert.equal(plan.intent, 'combat')
  assert.equal(plan.narration.mode, 'adapted')
  assert.equal(plan.action.narrationForbidden, false)
})

test('旁白驱动形态：原文明确标注旁白仍逐字保留为 source', () => {
  const plan = buildShotIntentPlan({
    duration: 10,
    sourceExcerpt: '旁白：「多年以后，唐奕仍记得那个清晨。」他站在门口。',
    characterCount: 1,
    narrationForm: 'narration',
  })
  assert.equal(plan.narration.mode, 'source')
  assert.ok(plan.narration.lines.some(line => line.includes('多年以后')))
})

test('对白驱动形态不受 narration 形态扩展影响：动作镜仍禁旁白', () => {
  const plan = buildShotIntentPlan({
    duration: 7,
    actionSummary: '她推门进屋，把篮子放在桌上。',
    sourceExcerpt: '她推门进屋，把篮子放在桌上。',
    characterCount: 1,
    narrationForm: 'dialogue',
  })
  assert.equal(plan.narration.mode, 'none')
  assert.equal(plan.action.narrationForbidden, true)
})

test('改写式旁白门禁：不要求逐字，但须写入两处且不超预算', () => {
  const plan = buildShotIntentPlan({
    duration: 10,
    sourceExcerpt: '唐奕回到柜台，望着店外忙碌的马老三，一切井然有序。',
    characterCount: 1,
    narrationForm: 'narration',
  })
  assert.equal(plan.narration.mode, 'adapted')
  const rewritten = '唐奕回到柜台里，望着店外马老三守着锅灶，一切井然有序。'
  const desc = `唐奕回到柜台。旁白（画外音）：「${rewritten}」`
  const prompt = `0-10秒：唐奕站在柜台后。旁白（画外音）：「${rewritten}」，嘴唇闭合。`
  const ok = validateIntentAdherence(plan, desc, prompt)
  assert.deepEqual(ok.errors, [])

  const missingDesc = validateIntentAdherence(plan, '唐奕回到柜台。', prompt)
  assert.ok(missingDesc.errors.some(item => item.includes('description')))

  const longLine = '唐奕回到柜台里望着店外马老三守着锅灶店内马婶前后支应一切井然有序他嘴角牵起一个弧度拿起柜下一块两尺多长的半弧木条用小刀继续雕琢吉他琴头神情踏实宁静'
  const over = validateIntentAdherence(
    plan,
    `旁白（画外音）：「${longLine}」`,
    `0-10秒：旁白（画外音）：「${longLine}」`,
  )
  assert.ok(over.errors.some(item => item.includes('超出本镜预算')))
})

test('改写式旁白计入有声镜：连续无声门禁不误伤', () => {
  const entries = [1, 2, 3].map(number => ({
    storyboardNumber: number,
    intent: 'action' as const,
    duration: 6,
    speechCount: 0,
    narrationMode: 'adapted' as const,
  }))
  assert.deepEqual(validateSilentRuns(entries), [])
})
