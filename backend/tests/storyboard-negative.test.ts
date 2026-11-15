import { test } from 'node:test'
import assert from 'node:assert/strict'
const {
  ensureNoDialogueNegativeConstraint,
  ensureNegativeConsistency,
  promptHasNarration,
  promptHasDialogue,
  promptHasSpokenContent,
  NO_DIALOGUE_NEGATIVE_ZH,
  NO_DIALOGUE_NEGATIVE_EN,
} = await import('../src/services/storyboard-negative.ts')
const { parseContractFromPrompt } = await import('../src/services/storyboard-contract.ts')

const PROMPT = [
  '出场人物：@贾婆子｜场景：@街道',
  '画面调度：画面左：贾婆子；画面右：人群；轴线A；动作起点：蔫下来；动作终点：望向唐记',
  '0-3秒：贾婆子垂下肩膀，酸溜溜地望向唐记。',
  '负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品',
].join('\n')

test('无台词镜头在负面约束追加固定文案', () => {
  const output = ensureNoDialogueNegativeConstraint(PROMPT)
  assert.match(output, new RegExp(`负面约束：.*${NO_DIALOGUE_NEGATIVE_ZH}`))
  assert.equal(ensureNoDialogueNegativeConstraint(output), output)
  const contract = parseContractFromPrompt(output, [])
  assert.match(String(contract.negativeConstraints), /不生成任何对话，对白以及旁白/)
})

test('有引号台词、旁白或 <d> 标签的镜头不追加', () => {
  assert.equal(promptHasSpokenContent('0-3秒：贾婆子说：「都等等——唐大郎！」'), true)
  assert.equal(promptHasSpokenContent('3-6秒：旁白（画外音）：「三年前的冬天。」'), true)
  assert.equal(promptHasSpokenContent('X says, <d>[Chinese] 你好</d>'), true)
  const dialogue = PROMPT.replace('负面约束：', '0-3秒：贾婆子抬高声音喊：「都等等——唐大郎！」\n负面约束：')
  assert.equal(ensureNoDialogueNegativeConstraint(dialogue), dialogue)
})

test('短专有名词引号不算台词', () => {
  const prompt = PROMPT.replace('望向唐记。', '望向「唐记」。')
  assert.equal(promptHasSpokenContent(prompt), false)
  assert.match(ensureNoDialogueNegativeConstraint(prompt), /不生成任何对话/)
})

test('没有负面约束行时保持原样，由四区校验补完整分区', () => {
  const prompt = '出场人物：无｜场景：@街道\n画面调度：空镜\n0-3秒：雨落屋檐。'
  assert.equal(ensureNoDialogueNegativeConstraint(prompt), prompt)
})

test('英文提示词使用英文约束文案', () => {
  const prompt = 'Characters: none | Scene: street\n0-3s: Rain falls.\nNegative constraints: no subtitles'
  const output = ensureNoDialogueNegativeConstraint(prompt)
  assert.match(output, new RegExp(NO_DIALOGUE_NEGATIVE_EN, 'i'))
  assert.doesNotMatch(output, /不生成任何对话/)
})

const SILENT_PROMPT = `${PROMPT}；${NO_DIALOGUE_NEGATIVE_ZH}`
const NARRATION_LINE = '0-3秒：贾婆子望向唐记。旁白（画外音）：「贾婆子吃味地扫向远处唐记门前的人头攒动」'

test('有旁白无对白：静音子句降级为禁对白，放开旁白', () => {
  const prompt = SILENT_PROMPT.replace('0-3秒：贾婆子垂下肩膀，酸溜溜地望向唐记。', NARRATION_LINE)
  assert.equal(promptHasNarration(prompt), true)
  assert.equal(promptHasDialogue(prompt), false)
  const output = ensureNegativeConsistency(prompt)
  assert.doesNotMatch(output, /不生成任何对话，对白以及旁白/)
  assert.match(output, /不生成任何对白与对话/)
  assert.equal(ensureNegativeConsistency(output), output)
})

test('有旁白有对白：静音子句整句移除', () => {
  const prompt = SILENT_PROMPT.replace(
    '0-3秒：贾婆子垂下肩膀，酸溜溜地望向唐记。',
    `${NARRATION_LINE}\n3-6秒：贾婆子喊：「都等等——唐大郎！」`,
  )
  assert.equal(promptHasNarration(prompt), true)
  assert.equal(promptHasDialogue(prompt), true)
  const output = ensureNegativeConsistency(prompt)
  assert.doesNotMatch(output, /不生成任何对话，对白以及旁白/)
  assert.doesNotMatch(output, /不生成任何对白与对话/)
  assert.match(output, /不生成字幕/)
  assert.equal(ensureNegativeConsistency(output), output)
})

test('无旁白无对白：双向入口仍追加完整静音子句', () => {
  const output = ensureNegativeConsistency(PROMPT)
  assert.match(output, new RegExp(NO_DIALOGUE_NEGATIVE_ZH))
  assert.equal(ensureNegativeConsistency(output), output)
})

test('有对白无旁白：双向入口保持原样', () => {
  const dialogue = PROMPT.replace('负面约束：', '0-3秒：贾婆子抬高声音喊：「都等等——唐大郎！」\n负面约束：')
  assert.equal(ensureNegativeConsistency(dialogue), dialogue)
})

test('英文静音子句在有旁白时降级', () => {
  const prompt = `Characters: none | Scene: street\n0-3s: Narrator (off-screen): "Three years ago." Rain falls.\nNegative constraints: no subtitles; ${NO_DIALOGUE_NEGATIVE_EN}`
  const output = ensureNegativeConsistency(prompt)
  assert.doesNotMatch(output, /off-screen narration/)
  assert.match(output, /do not generate any dialogue or spoken lines/)
})

test('手改旁白后重评估：ep9 矛盾提示词修正', () => {
  const prompt = [
    '出场人物：@贾婆子、@六婶｜场景：@邓州西市街道',
    '画面调度：画面左：街面商铺；画面右：人流；轴线A；动作起点：贾婆子面向对方；动作终点：贾婆子说完',
    '0-3秒：贾婆子撇着嘴望向唐记。旁白（画外音）：「贾婆子吃味地扫向远处唐记门前的人头攒动」，近景。',
    '负面约束：只出现画内人物；不生成字幕；不出现与项目时代冲突的物品。；不生成任何对话，对白以及旁白',
  ].join('\n')
  const output = ensureNegativeConsistency(prompt)
  assert.doesNotMatch(output, /不生成任何对话，对白以及旁白/)
  assert.match(output, /不生成任何对白与对话/)
})
