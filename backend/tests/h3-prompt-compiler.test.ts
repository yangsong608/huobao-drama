import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  compileH3Prompt,
  compileLocalH3Prompt,
  clearH3TranslationCache,
  H3_TRANSLATOR_SYSTEM,
  translateH3Text,
} = await import('../src/services/h3-prompt.ts')

const SHOT = [
  '国风2.5D插画，柔和晨光',
  '人物：@图片2林小雨、@图片3陈默',
  '场景：@图片1包子铺门前',
  '音频：清晨集市环境声，无背景音乐',
  '0-3秒：@图片1包子铺门前，@图片2林小雨抬头，#林小雨轻声说：「早上好。」@图片3陈默点头。',
  '3-6秒：旁白（画外音）：「三年前的冬天，她第一次来到这里。」',
].join('\n')

test('native dialogue and narration compile to H3 <d> tags with their original words', () => {
  const out = compileH3Prompt(SHOT, 'native')
  assert.match(out, /Characters: <Picture 2>林小雨/)
  assert.match(out, /Scene: <Picture 1>包子铺门前/)
  assert.match(out, /Audio: /)
  assert.match(out, /\[0-3s\]/)
  assert.match(out, /\[3-6s\]/)
  assert.match(out, /林小雨 says, <d>\[Chinese\] 早上好。<\/d>/)
  assert.match(out, /Off-screen narrator says, <d>\[Chinese\] 三年前的冬天，她第一次来到这里。<\/d>/)
  assert.doesNotMatch(out, /speaks in Mandarin, mouth moving/)
  assert.doesNotMatch(out, /[「」“”]/)
  assert.doesNotMatch(out, /#|@|音色参考音频/)
})

const GENERIC_AUDIO_LINE_SHOT = [
  '人物：@图片1林小雨',
  '场景：@图片1包子铺门前',
  '音频：人声清晰靠前，环境音压低，无背景音乐；旁白/心声为画外音，不张口。',
  '0-3秒：@图片1包子铺门前，@图片1林小雨抬头。',
].join('\n')

test('generic audio line without narration does not become an off-screen narrator', () => {
  const out = compileH3Prompt(GENERIC_AUDIO_LINE_SHOT, 'native')
  assert.match(out, /^Audio: .*环境音自然/m)
  assert.doesNotMatch(out, /环境音压低/)
  assert.doesNotMatch(out, /Off-screen narrator/)
  assert.doesNotMatch(out, /旁白|画外音/)
})

test('generic audio line plus real narration yields exactly one narrator action', () => {
  const prompt = [
    '人物：@图片2林小雨',
    '场景：@图片1包子铺门前',
    '音频：人声清晰靠前，环境音压低，无背景音乐；旁白/心声为画外音，不张口。',
    '0-3秒：@图片2林小雨抬头。',
    '3-6秒：旁白（画外音）：「三年前的冬天，她第一次来到这里。」',
  ].join('\n')
  const out = compileH3Prompt(prompt, 'native')
  assert.equal((out.match(/Off-screen narrator/g) || []).length, 1)
  assert.match(out, /Off-screen narrator says, <d>\[Chinese\] 三年前的冬天，她第一次来到这里。<\/d>/)
  assert.match(out, /^Audio: .*环境音自然/m)
  assert.doesNotMatch(out, /环境音压低|旁白\/心声/)
})

test('ambient and silent modes drop audio and narration lines but keep mouth movement without tags', () => {
  for (const mode of ['ambient', 'silent'] as const) {
    const out = compileH3Prompt(SHOT, mode)
    assert.doesNotMatch(out, /^Audio:/m)
    assert.doesNotMatch(out, /Off-screen narrator/)
    assert.doesNotMatch(out, /<d>|<\/d>/)
    assert.doesNotMatch(out, /清晨集市环境声|早上好|三年前的冬天/)
    assert.match(out, /speaks in Mandarin, mouth moving/)
  }
})

test('short quoted terms keep their text while quote marks are removed', () => {
  const out = compileH3Prompt('场景：寻找“陆缘”，四周是无尽海。', 'native')
  assert.match(out, /寻找陆缘/)
  assert.doesNotMatch(out, /[「」“”]/)
  assert.doesNotMatch(out, /<d>/)
})

test('sentence-like quoted dialogue without a known speaker is kept inside an H3 dialogue tag', () => {
  const out = compileH3Prompt('0-3秒：林小雨：「早上好。」', 'native')
  assert.match(out, /<d>\[Chinese\] 早上好。<\/d>/)
  assert.doesNotMatch(out, /[「」“”]/)
})

test('unknown hash and at tokens are removed without losing surrounding action', () => {
  const out = compileH3Prompt('#01 镜头：@林小雨推门，#无名角色离开。', 'native')
  assert.match(out, /#01/)
  assert.doesNotMatch(out, /@|#无名角色/)
  assert.match(out, /林小雨推门/)
})

test('translation preserves dialogue tags exactly and translates only the prompt around them', async () => {
  clearH3TranslationCache()
  let calls = 0
  const translate = async (text: string) => {
    calls += 1
    assert.match(text, /Characters:/)
    assert.match(text, /<Picture 2>/)
    assert.match(text, /\[\[H3_DLG_0\]\][\s\S]*\[\[H3_DLG_1\]\]/)
    assert.doesNotMatch(text, /早上好|三年前的冬天/)
    return '```text\nCharacters: <Picture 2> Lin Xiaoyu. [0-3s] She looks up. [[H3_DLG_0]] [3-6s] [[H3_DLG_1]]\n```'
  }
  const expected = 'Characters: <Picture 2> Lin Xiaoyu. [0-3s] She looks up. <d>[Chinese] 早上好。</d> [3-6s] <d>[Chinese] 三年前的冬天，她第一次来到这里。</d>'
  const first = await compileLocalH3Prompt(SHOT, 'native', { translate })
  assert.equal(first, expected)
  const second = await compileLocalH3Prompt(SHOT, 'native', { translate })
  assert.equal(second, first)
  assert.equal(calls, 1)
})

test('translation that drops, duplicates or alters dialogue placeholders falls back to the deterministic prompt', async () => {
  clearH3TranslationCache()
  const dropped = await compileLocalH3Prompt(SHOT, 'native', {
    translate: async () => 'Characters: Lin Xiaoyu. [0-3s] She looks up.',
  })
  assert.match(dropped, /Characters: <Picture 2>林小雨/)
  assert.match(dropped, /林小雨 says, <d>\[Chinese\] 早上好。<\/d>/)

  clearH3TranslationCache()
  const duplicated = await compileLocalH3Prompt(SHOT, 'native', {
    translate: async () => '[[H3_DLG_0]] [[H3_DLG_0]] [[H3_DLG_1]]',
  })
  assert.equal(duplicated, compileH3Prompt(SHOT, 'native'))
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

test('translator instructions require dialogue placeholders to survive unchanged', () => {
  assert.match(H3_TRANSLATOR_SYSTEM, /\[\[H3_DLG_N\]\]/)
  assert.match(H3_TRANSLATOR_SYSTEM, /<d>\[Chinese\]/)
  assert.match(H3_TRANSLATOR_SYSTEM, /never translate|do not translate/i)
  assert.match(H3_TRANSLATOR_SYSTEM, /subtitles/i)
})

test('visual background translation that echoes Chinese is rejected', async () => {
  clearH3TranslationCache()
  const echoed = await translateH3Text('雨夜咖啡馆，暖黄灯光', {
    translate: async () => '雨夜咖啡馆，暖黄灯光',
  })
  assert.equal(echoed, null)

  const partial = await translateH3Text('雨夜咖啡馆，暖黄灯光', {
    translate: async () => 'Rainy night cafe, 暖黄灯光',
  })
  assert.equal(partial, null)

  const translated = await translateH3Text('雨夜咖啡馆，暖黄灯光', {
    translate: async () => 'Rainy night cafe with warm amber lighting',
  })
  assert.equal(translated, 'Rainy night cafe with warm amber lighting')
})
