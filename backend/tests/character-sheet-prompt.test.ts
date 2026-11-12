import { test } from 'node:test'
import assert from 'node:assert/strict'
const {
  buildCharacterSheetFallbackPrompt,
  ensureCharacterSheetGuard,
  CHARACTER_SHEET_GUARD_ZH,
  CHARACTER_SHEET_GUARD_EN,
} = await import('../src/services/character-sheet-prompt.ts')

const char = {
  name: '唐奕',
  appearance: '十六七岁的少年，清瘦挺拔',
  description: '唐记食铺掌灶者',
  styling: '灰蓝色交领短褐',
}

test('角色兜底提示词是左侧正脸 + 右侧无头三视图，不是半身海报', () => {
  const prompt = buildCharacterSheetFallbackPrompt(char, '国风3D')
  assert.match(prompt, /角色设定参考图/)
  assert.match(prompt, /左侧正脸特写占画面约四分之一/)
  assert.match(prompt, /三张等高无头全身视图/)
  assert.match(prompt, /只显示颈部以下的躯干、双臂、双腿和服装/)
  assert.match(prompt, /不出现头部、人脸或头发/)
  assert.doesNotMatch(prompt, /每个全身视图必须完整包含头发/)
  assert.doesNotMatch(prompt, /半身角色海报构图/)
})

test('已有提示词缺少无头三视图约束时追加一次，不重复追加', () => {
  const base = '角色设定参考图，左侧正脸特写，右侧三视图'
  const guarded = ensureCharacterSheetGuard(base)
  assert.match(guarded, /无头全身视图/)
  assert.equal(ensureCharacterSheetGuard(guarded), guarded)
})

test('旧版完整头脚守卫会被清掉，换成无头三视图守卫', () => {
  const legacy = '角色设定参考图，左侧正脸特写，右侧三视图，每个全身视图必须完整包含头发、面部、颈部、躯干、双臂、双腿和双脚，头顶和脚底都不能被画框裁切，禁止无头人台、断头'
  const guarded = ensureCharacterSheetGuard(legacy)
  assert.doesNotMatch(guarded, /禁止无头人台/)
  assert.doesNotMatch(guarded, /完整包含头发/)
  assert.match(guarded, /无头全身视图/)
})

test('中文和英文提示词使用对应语言的无头守卫', () => {
  assert.match(ensureCharacterSheetGuard('角色三视图'), /版式硬约束/)
  assert.match(ensureCharacterSheetGuard('Character turnaround sheet'), /Layout constraints/)
  assert.match(CHARACTER_SHEET_GUARD_ZH, /无头全身视图/)
  assert.match(CHARACTER_SHEET_GUARD_EN, /headless full-body/i)
})
