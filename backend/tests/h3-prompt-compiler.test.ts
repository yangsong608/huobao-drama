import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  compileH3Prompt,
  compileLocalH3Prompt,
  clearH3TranslationCache,
  H3_TRANSLATOR_SYSTEM,
} = await import('../src/services/h3-prompt.ts')

const SHOT = [
  '国风2.5D插画，柔和晨光',
  '人物：@图片2林小雨、@图片3陈默',
  '场景：@图片1包子铺门前',
  '音频：清晨集市环境声，无背景音乐',
  '0-3秒：@图片1包子铺门前，@图片2林小雨抬头，#林小雨轻声说：「早上好。」@图片3陈默点头。',
  '3-6秒：旁白（画外音）：「三年前的冬天，她第一次来到这里。」',
].join('\n')

test('deterministic compiler removes subtitle sources and rewrites structure', () => {
  const out = compileH3Prompt(SHOT, 'native')
  assert.match(out, /Characters: <Picture 2>林小雨/)
  assert.match(out, /Scene: <Picture 1>包子铺门前/)
  assert.match(out, /Audio: /)
  assert.match(out, /\[0-3s\]/)
  assert.match(out, /\[3-6s\]/)
  assert.match(out, /林小雨 speaks in Mandarin, mouth moving/)
  assert.match(out, /Off-screen narrator/)
  assert.doesNotMatch(out, /[「」“”]/)
  assert.doesNotMatch(out, /#|@|音色参考音频/)
  assert.doesNotMatch(out, /早上好|三年前的冬天/)
})

test('ambient and silent modes drop audio and narration lines but keep mouth movement', () => {
  for (const mode of ['ambient', 'silent'] as const) {
    const out = compileH3Prompt(SHOT, mode)
    assert.doesNotMatch(out, /^Audio:/m)
    assert.doesNotMatch(out, /Off-screen narrator/)
    assert.doesNotMatch(out, /清晨集市环境声|三年前的冬天/)
    assert.match(out, /speaks in Mandarin, mouth moving/)
  }
})

test('unknown hash and at tokens are removed without losing surrounding action', () => {
  const out = compileH3Prompt('#01 镜头：@林小雨推门，#无名角色离开。', 'native')
  assert.match(out, /#01/)
  assert.doesNotMatch(out, /@|#无名角色/)
  assert.match(out, /林小雨推门/)
})

test('translation runs once per compiled prompt and its English result is used', async () => {
  clearH3TranslationCache()
  let calls = 0
  const translate = async (text: string) => {
    calls += 1
    assert.match(text, /Characters:/)
    assert.match(text, /<Picture 2>/)
    return '```text\nCharacters: <Picture 2> Lin Xiaoyu. [0-3s] She looks up and speaks in Mandarin, mouth moving.\n```'
  }
  const first = await compileLocalH3Prompt(SHOT, 'native', { translate })
  assert.equal(first, 'Characters: <Picture 2> Lin Xiaoyu. [0-3s] She looks up and speaks in Mandarin, mouth moving.')
  const second = await compileLocalH3Prompt(SHOT, 'native', { translate })
  assert.equal(second, first)
  assert.equal(calls, 1)
})

test('translation failure falls back to the deterministic prompt instead of failing generation', async () => {
  clearH3TranslationCache()
  const out = await compileLocalH3Prompt('人物：林小雨\n0-3秒：@图片1林小雨抬头。', 'native', {
    translate: async () => { throw new Error('text model offline') },
  })
  assert.match(out, /Characters: 林小雨/)
  assert.match(out, /\[0-3s\] <Picture 1>林小雨抬头/)
})

test('english-only prompts skip the text model entirely', async () => {
  let calls = 0
  const out = await compileLocalH3Prompt('A cat runs across a rainy street.', 'native', {
    translate: async () => { calls += 1; return 'unused' },
  })
  assert.equal(out, 'A cat runs across a rainy street.')
  assert.equal(calls, 0)
})

test('translator instructions forbid dialogue text and subtitle sources', () => {
  assert.match(H3_TRANSLATOR_SYSTEM, /<Picture N>/)
  assert.match(H3_TRANSLATOR_SYSTEM, /subtitles/i)
  assert.match(H3_TRANSLATOR_SYSTEM, /never write dialogue/i)
})
