import { test } from 'node:test'
import assert from 'node:assert/strict'

const { validateRepairedShot } = await import('../src/services/storyboard-shot-validation.ts')
const { buildShotIntentPlan } = await import('../src/services/shot-intent-plan.ts')

const promptWith = (frames: string, cast = '@甲') => `出场人物：${cast}｜场景：@街
画面调度：画面左：甲；画面右：无；无过肩；背景地标：无；轴线无；动作起点：甲站立；动作终点：甲完成
${frames}
负面约束：只出现画内人物；不生成字幕`

test('拆分方案单段上限会进入逐镜校验', () => {
  const input = {
    sourceExcerpt: '甲说：「走。」',
    description: '甲开口，@甲说：「走。」',
    videoPrompt: '出场人物：@甲｜场景：@街\n画面调度：画面左：甲；画面右：无；无过肩；背景地标：无；轴线无；动作起点：甲站立；动作终点：甲说完\n0-3秒：甲开口，@甲说：「走。」\n负面约束：只出现画内人物',
    duration: 9,
    shotLabel: '第 1 镜',
  }
  const withoutSchemeLimit = validateRepairedShot(input)
  assert.equal(withoutSchemeLimit.errors.some(item => item.includes('拆分方案单段上限')), false)
  const withSchemeLimit = validateRepairedShot({ ...input, maxAllowedSeconds: 8 })
  assert.ok(withSchemeLimit.errors.some(item => item.includes('超过当前拆分方案单段上限 8 秒')))
})

test('开场上下文旁白不被当成计划外台词', () => {
  const excerpt = '邓州西市，清晨的街面渐渐热闹起来，唐记食铺门前排起了长队。'
  const plan = buildShotIntentPlan({ duration: 8, sourceExcerpt: excerpt, characterCount: 0, isOpeningShot: true })
  assert.equal(plan.narration.mode, 'source')
  const line = plan.narration.lines[0]
  const result = validateRepairedShot({
    sourceExcerpt: excerpt,
    description: `清晨的邓州西市街面。旁白（画外音）：「${line}」`,
    videoPrompt: promptWith(`0-4秒：清晨街面渐热闹。旁白（画外音）：「${line}」\n4-8秒：唐记门前排起长队。`, '无'),
    duration: 8,
    intentPlan: plan,
    planSpeechSegments: [],
  })
  assert.equal(result.errors.some(item => item.includes('计划外台词') || item.includes('自行加了台词')), false)
})

test('改写式旁白通过校验：不要求逐字原文，须写入两处且不超预算', () => {
  const excerpt = '唐奕回到柜台，望着店外忙碌的马老三，一切井然有序。'
  const plan = buildShotIntentPlan({ duration: 10, sourceExcerpt: excerpt, characterCount: 1, narrationForm: 'narration' })
  assert.equal(plan.narration.mode, 'adapted')
  const rewritten = '唐奕回到柜台里，望着店外马老三守着锅灶，一切井然有序。'
  const result = validateRepairedShot({
    sourceExcerpt: excerpt,
    description: `唐奕回到柜台。旁白（画外音）：「${rewritten}」`,
    videoPrompt: promptWith(`0-6秒：唐奕回到柜台后。旁白（画外音）：「${rewritten}」\n6-10秒：唐奕望向店外，嘴唇闭合。`),
    duration: 10,
    intentPlan: plan,
    planSpeechSegments: [],
  })
  assert.deepEqual(result.errors, [])
})

test('改写式旁白超预算被拦截', () => {
  const excerpt = '唐奕回到柜台，望着店外忙碌的马老三，一切井然有序。'
  const plan = buildShotIntentPlan({ duration: 6, sourceExcerpt: excerpt, characterCount: 1, narrationForm: 'narration' })
  const longLine = '唐奕回到柜台里望着店外马老三守着锅灶店内马婶前后支应一切井然有序他嘴角牵起一个弧度拿起柜下半弧木条雕琢琴头'
  const result = validateRepairedShot({
    sourceExcerpt: excerpt,
    description: `旁白（画外音）：「${longLine}」`,
    videoPrompt: promptWith(`0-3秒：唐奕站在柜台后。旁白（画外音）：「${longLine}」\n3-6秒：唐奕望向店外。`),
    duration: 6,
    intentPlan: plan,
    planSpeechSegments: [],
  })
  assert.ok(result.errors.some(item => item.includes('超出本镜预算')))
})

test('改写式旁白只写提示词不写 description 被拦截', () => {
  const excerpt = '唐奕回到柜台，望着店外忙碌的马老三，一切井然有序。'
  const plan = buildShotIntentPlan({ duration: 10, sourceExcerpt: excerpt, characterCount: 1, narrationForm: 'narration' })
  const line = '唐奕回到柜台里，望着店外马老三守着锅灶。'
  const result = validateRepairedShot({
    sourceExcerpt: excerpt,
    description: '唐奕回到柜台。',
    videoPrompt: promptWith(`0-5秒：唐奕回到柜台后。旁白（画外音）：「${line}」\n5-10秒：唐奕望向店外。`),
    duration: 10,
    intentPlan: plan,
    planSpeechSegments: [],
  })
  assert.ok(result.errors.some(item => item.includes('description 缺少旁白')))
})

test('对白与旁白分时共存：对白逐字保留，旁白不算计划外台词', () => {
  const excerpt = '马老三说：「咱就留在这吧。」夫妇俩担起抚养的重担。'
  const speech = [{ speaker: '马老三', text: '咱就留在这吧。' }]
  const plan = buildShotIntentPlan({ duration: 12, sourceExcerpt: excerpt, speechSegments: speech, characterCount: 1, narrationForm: 'narration' })
  assert.equal(plan.narration.mode, 'adapted')
  const narration = '夫妇俩担起抚养的重担'
  const result = validateRepairedShot({
    sourceExcerpt: excerpt,
    description: `@马老三说：「咱就留在这吧。」旁白（画外音）：「${narration}」`,
    videoPrompt: promptWith(`0-4秒：@马老三说：「咱就留在这吧。」\n4-8秒：夫妇俩守在病榻旁。旁白（画外音）：「${narration}」\n8-12秒：马老三扛起货物。`, '@马老三'),
    duration: 12,
    intentPlan: plan,
    planSpeechSegments: speech,
  })
  assert.equal(result.errors.some(item => item.includes('计划外台词')), false)
  assert.equal(result.errors.some(item => item.includes('没有逐字保留计划台词')), false)
})
