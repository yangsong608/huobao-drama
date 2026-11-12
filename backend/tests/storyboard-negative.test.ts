import { test } from 'node:test'
import assert from 'node:assert/strict'
const {
  ensureNoDialogueNegativeConstraint,
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
