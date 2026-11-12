import { test } from 'node:test'
import assert from 'node:assert/strict'

const { validatePlanSequence } = await import('../src/services/storyboard-plan-contract.ts')
const { validateRepairedShot } = await import('../src/services/storyboard-shot-validation.ts')

function plan(number, overrides = {}) {
  return {
    shotNumber: number,
    sceneId: 38,
    location: '邓州西市街道',
    sourceExcerpt: `第${number}镜原文。`,
    duration: 8,
    actionStart: '站在店前',
    actionEnd: '看向街面',
    coverageType: 'A',
    speechSegments: [],
    boundaryType: 'action',
    boundaryWord: null,
    screenLeft: '自家店门一侧（贾婆子）',
    screenRight: '唐记门前一侧',
    axisSide: '轴线A',
    landmarkSide: '自家店门在左后',
    ...overrides,
  }
}

function planErrors(plans) {
  return validatePlanSequence(plans, { minDuration: 6, maxDuration: 15 }).issues.filter(item => item.severity === 'error')
}

test('计划门禁：场景常量以建立镜为准，只标偏离的镜头', () => {
  const errors = planErrors([
    plan(1),
    plan(2, { screenLeft: '唐记门前一侧（六婶）', screenRight: '自家店门一侧（贾婆子）' }),
    plan(3),
  ])
  const flip = errors.find(item => item.code === 'scene_constant_flip')
  assert.ok(flip)
  assert.equal(flip.shotNumber, 2, '应标偏离的第 2 镜，而不是后面的第 3 镜')
  assert.match(flip.message, /同场建立镜第 1 镜/)
})

test('计划门禁：多说话人、台词超容量、内部动作端点、跨室内外都被拒绝', () => {
  const errors = planErrors([
    plan(1, {
      duration: 6,
      speechSegments: [
        { speaker: '甲', text: '这是一句很长很长的第一句台词', order: 1 },
        { speaker: '乙', text: '这是另一句很长很长的第二句台词', order: 2 },
      ],
      actionEnd: '愈发心酸',
      actionStart: '反身回了店里',
    }),
  ])
  assert.ok(errors.some(item => item.code === 'multi_speaker_shot'))
  assert.ok(errors.some(item => item.code === 'dialogue_over_capacity'))
  assert.ok(errors.some(item => item.code === 'action_endpoint_internal'))
  assert.ok(errors.some(item => item.code === 'location_change_inside_shot'))
})

test('渲染门禁：单时间帧台词超容量被拒绝', () => {
  const prompt = [
    '出场人物：@甲｜场景：@大堂',
    '画面调度：画面左：甲；画面右：乙；无过肩；背景地标：门在左后；轴线A；动作起点：甲站着；动作终点：甲抬头',
    '0-3秒：甲站着说：「这是一句超过十二个字的台词」',
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品',
  ].join('\n')
  const result = validateRepairedShot({
    sourceExcerpt: '甲站着说：「这是一句超过十二个字的台词」',
    description: '甲站着说：「这是一句超过十二个字的台词」',
    videoPrompt: prompt,
    characterIds: [1],
    duration: 6,
  })
  assert.ok(result.errors.some(item => item.includes('3 秒最多容纳')))
})

test('完成态发声动作不再要求本镜补台词', () => {
  const prompt = [
    '出场人物：@贾婆子｜场景：@邓州西市街道',
    '画面调度：画面左：自家店门；画面右：唐记长队；无过肩；背景地标：门在左后；轴线无；动作起点：贾婆子回店；动作终点：贾婆子看向长队',
    '0-3秒：贾婆子转身回到店里。',
    '3-8秒：她站在门内侧，低头叹气，看向画面右的唐记长队。',
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品',
  ].join('\n')
  const result = validateRepairedShot({
    sourceExcerpt: '骂完自觉无趣，反身回了店里，望着唐记门前排到街面上的长队，愈发心酸。',
    description: '贾婆子转身回到店里，站在门内侧，低头叹气，看向画面右的唐记长队。',
    videoPrompt: prompt,
    characterIds: [1],
    duration: 8,
  })
  assert.equal(result.errors.some(item => item.includes('发声动作')), false)
})

test('计划门禁：叙述性引号（专有名词/拟声词）不按台词处理', () => {
  const errors = planErrors([plan(1, {
    sourceExcerpt: '他抱着"半截扁担"似的木器走进店来，只听"啪嗒"一声，人人都来"求方便"。',
    speechSegments: [],
  })])
  assert.equal(errors.some(item => item.code === 'plan_speech_missing'), false)
  assert.equal(errors.some(item => item.code === 'plan_speech_invented'), false)
})

test('计划门禁：省略号台词逐字比对，不因 … 与 …… 差异误报', () => {
  const errors = planErrors([plan(1, {
    sourceExcerpt: '孙郎中：少拿……',
    speechSegments: [{ speaker: '孙郎中', text: '少拿……', sourceQuote: '少拿……', order: 1 }],
  })])
  assert.equal(errors.some(item => item.code === 'plan_speech_incomplete'), false)
})

test('v3 计划门禁：起终点相同/缺失/文档标题/多主体被拒绝', () => {
  const base = plan(1, { shotType: 'action', subject: '贾婆子', subjects: ['贾婆子'], actionArc: { initial: '站', action: '看', result: '看' } })
  const same = planErrors([{ ...base, actionStart: '看向店门', actionEnd: '看向店门' }])
  assert.ok(same.some(item => item.code === 'action_start_equals_end'))
  const missing = planErrors([{ ...base, actionStart: null, actionEnd: '看向店门' }])
  assert.ok(missing.some(item => item.code === 'action_endpoint_missing'))
  const title = planErrors([{ ...base, sourceExcerpt: '# 唐记食铺' }])
  assert.ok(title.some(item => item.code === 'doc_title_as_shot'))
  const multi = planErrors([{ ...base, subjects: ['贾婆子', '六婶', '马老三', '众人'] }])
  assert.ok(multi.some(item => item.code === 'multi_subject_shot'))
})

test('渲染门禁：提示词动作弧被改写时拒绝', () => {
  const prompt = [
    '出场人物：@张三｜场景：@大堂',
    '画面调度：画面左：张三；画面右：无；无过肩；背景地标：门在右后；轴线无；动作起点：张三走向门口；动作终点：张三转身',
    '0-6秒：张三走向门口，转身看向店内。',
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品',
  ].join('\n')
  const result = validateRepairedShot({
    sourceExcerpt: '张三站在门口，抬手看向店内。',
    description: '张三站在门口，抬手看向店内。',
    videoPrompt: prompt,
    characters: [{ id: 1, name: '张三' }],
    characterIds: [1],
    duration: 6,
    expectedShotType: 'action',
    expectedActionStart: '张三站在门口',
    expectedActionEnd: '张三抬手看向店内',
  })
  assert.ok(result.errors.some(item => item.includes('动作起点与计划不一致')))
  assert.ok(result.errors.some(item => item.includes('动作终点与计划不一致')))
})

test('渲染门禁：description 左右与画面调度左右矛盾被拒绝，正反例不误报', () => {
  const chars = [{ id: 1, name: '贾婆子' }, { id: 2, name: '六婶' }]
  const prompt = (left, right) => [
    '出场人物：@贾婆子、@六婶｜场景：@邓州西市街道',
    `画面调度：画面左：${left}；画面右：${right}；无过肩；背景地标：店门在左后；轴线A；动作起点：贾婆子开口；动作终点：贾婆子说完`,
    '0-4秒：@贾婆子说：「老叼婆！」',
    '4-8秒：@贾婆子扁着嘴。',
    '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品',
  ].join('\n')
  const bad = validateRepairedShot({
    sourceExcerpt: '贾婆子朝着六婶背身暗啐一口。贾婆子：（低声）老叼婆！',
    description: '贾婆子立在画面左自家店前，六婶已向画面右唐记门前背身远去。@贾婆子说：「老叼婆！」',
    videoPrompt: prompt('唐记门前一侧（六婶）', '自家店门前一侧（贾婆子）'),
    characters: chars,
    characterIds: [1, 2],
    duration: 8,
  })
  assert.match(bad.errors.join('；'), /左右矛盾/)

  const good = validateRepairedShot({
    sourceExcerpt: '六婶摇着丝帕向贾婆子走近。贾婆子：（热情地）呦！',
    description: '六婶自画面右摇着丝帕向画面左的贾婆子走近。@贾婆子说：「呦！」',
    videoPrompt: prompt('自家店门前一侧（贾婆子）', '唐记门前一侧（六婶）'),
    characters: chars,
    characterIds: [1, 2],
    duration: 8,
  })
  assert.equal(good.errors.some(item => item.includes('左右矛盾')), false)
})
