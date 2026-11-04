/**
 * 过渡提示词：视觉分析指令与模型输出清洗。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  buildTransitionPromptSystemText,
  buildTransitionPromptUserText,
  parseTransitionPrompt,
} = await import('../src/services/transition-prompt.ts')

test('parse 去掉代码块、字段名与包裹引号，合并为单段', () => {
  const raw = '```text\n视频提示词：**雨滴从霓虹灯牌滑落，镜头沿着水洼向前推移，\n画面由冷蓝街景渐亮到咖啡馆暖光。**\n```'
  const prompt = parseTransitionPrompt(raw, { localShim: false })
  assert.equal(prompt, '雨滴从霓虹灯牌滑落，镜头沿着水洼向前推移，画面由冷蓝街景渐亮到咖啡馆暖光。')
})

test('parse 去掉英文 Prompt 前缀并保留正文', () => {
  const prompt = parseTransitionPrompt('Prompt: "The camera glides through rain toward a warm cafe doorway, reflections streaking across the wet street."', { localShim: true })
  assert.equal(prompt, 'The camera glides through rain toward a warm cafe doorway, reflections streaking across the wet street.')
})

test('parse 拒绝空输出与过短提示词', () => {
  assert.throws(() => parseTransitionPrompt('   ```\n```   ', { localShim: false }), /没有返回/)
  assert.throws(() => parseTransitionPrompt('过渡', { localShim: false }), /过短/)
})

test('本地 H3 拒绝中文提示词，英文正常通过', () => {
  assert.throws(
    () => parseTransitionPrompt('镜头从雨夜街角平滑推进到咖啡馆门口，光线逐渐变暖。', { localShim: true }),
    /英文/,
  )
  const english = parseTransitionPrompt('Camera glides forward through the rain as warm cafe light grows in the frame.', { localShim: true })
  assert.match(english, /^Camera glides/)
})

test('系统指令区分首帧/尾帧来源并约束输出语言', () => {
  const cloud = buildTransitionPromptSystemText(false)
  assert.match(cloud, /第一张图.*上一镜.*最后一帧/)
  assert.match(cloud, /第二张图.*下一镜.*第一帧/)
  assert.match(cloud, /镜头运动/)
  assert.match(cloud, /对白|字幕/)
  assert.match(cloud, /只输出/)

  const local = buildTransitionPromptSystemText(true)
  assert.match(local, /English only/i)
  assert.match(local, /no Chinese|禁止.*中文/i)
})

test('用户指令包含两镜描述、连续性与景别信息', () => {
  const text = buildTransitionPromptUserText({
    fromNumber: 3,
    toNumber: 4,
    prevDescription: '林晚站在雨夜街头。',
    nextDescription: '林晚推门走进咖啡馆。',
    continuity: '保持同一件湿透的风衣。',
    sameScene: false,
  })
  assert.match(text, /S3/)
  assert.match(text, /S4/)
  assert.match(text, /林晚站在雨夜街头/)
  assert.match(text, /林晚推门走进咖啡馆/)
  assert.match(text, /保持同一件湿透的风衣/)
})
