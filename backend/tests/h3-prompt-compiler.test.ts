import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const {
  compileH3Prompt,
  compileLocalH3Prompt,
  clearH3TranslationCache,
  H3_TRANSLATOR_SYSTEM,
  H3PromptTranslationError,
  shouldSilenceLocalH3Audio,
  stripH3AudioLine,
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

test('same speaker keeps multiple dialogue segments in one H3 tag', () => {
  const prompt = [
    '0-3秒：@图片2六婶说：「第一句。」@图片3贾婆子点头。',
    '3-6秒：@图片2六婶又说：「第二句，别忘了带篮子。」',
  ].join('\n')
  const out = compileH3Prompt(prompt, 'native')
  assert.equal((out.match(/<d>/g) || []).length, 1)
  assert.match(out, /六婶 says, <d>\[Chinese\] 第一句。第二句，别忘了带篮子。<\/d>/)
  assert.match(out, /六婶 continues speaking/)
  assert.doesNotMatch(out, /<d>\[Chinese\] 第二句/)
})

test('different speakers keep separate H3 dialogue tags', () => {
  const prompt = '0-3秒：@图片2六婶说：「第一句。」@图片3贾婆子说：「第二句。」'
  const out = compileH3Prompt(prompt, 'native')
  assert.equal((out.match(/<d>/g) || []).length, 2)
  assert.match(out, /六婶 says, <d>\[Chinese\] 第一句。<\/d>/)
  assert.match(out, /贾婆子 says, <d>\[Chinese\] 第二句。<\/d>/)
})

test('dialogue tags end at a sentence boundary before following visual description', () => {
  const prompt = [
    '0-3秒：@范公子怒目而视，@范公子说：「一心图强」满脸激愤。',
    '3-6秒：旁白（画外音）：「几位相公。」两人相视。',
  ].join('\n')
  const out = compileH3Prompt(prompt, 'native')
  assert.match(out, /<d>\[Chinese\] 一心图强<\/d>\.\s*满脸激愤/)
  assert.match(out, /<d>\[Chinese\] 几位相公。<\/d>\.\s*两人相视/)
  assert.doesNotMatch(out, /<\/d>\s*[，,；;]/)
  assert.doesNotMatch(out, /<\/d>[^\s。！？!?.;，,]/)
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
  const expected = [
    'Characters: <Picture 2> Lin Xiaoyu. [0-3s] She looks up. <d>[Chinese] 早上好。</d>. [3-6s] <d>[Chinese] 三年前的冬天，她第一次来到这里。</d>',
    'Only text inside <d> tags is spoken; all other text is visual description and must never be voiced.',
  ].join('\n')
  const first = await compileLocalH3Prompt(SHOT, 'native', { translate })
  assert.equal(first, expected)
  const second = await compileLocalH3Prompt(SHOT, 'native', { translate })
  assert.equal(second, first)
  assert.equal(calls, 1)
})

test('translation retries once before succeeding', async () => {
  clearH3TranslationCache()
  let calls = 0
  const out = await compileLocalH3Prompt(SHOT, 'native', {
    translate: async () => {
      calls += 1
      if (calls === 1) throw new Error('timeout')
      return 'Characters: <Picture 2> Lin Xiaoyu. [0-3s] She looks up. [[H3_DLG_0]] [3-6s] [[H3_DLG_1]]'
    },
  })
  assert.equal(calls, 2)
  assert.match(out, /<d>\[Chinese\] 早上好。<\/d>/)
  assert.match(out, /Only text inside <d> tags is spoken/)
})

test('translation that leaves Chinese outside dialogue tags is retried and then rejected', async () => {
  clearH3TranslationCache()
  let calls = 0
  await assert.rejects(
    () => compileLocalH3Prompt(SHOT, 'native', {
      translate: async () => {
        calls += 1
        return 'Characters: <Picture 2> 林小雨. [0-3s] She looks up. [[H3_DLG_0]] [3-6s] [[H3_DLG_1]]'
      },
    }),
    (err: any) => err instanceof H3PromptTranslationError && /标签外/.test(err.message),
  )
  assert.equal(calls, 2)
})

test('translation that drops or duplicates dialogue placeholders is retried and rejected', async () => {
  clearH3TranslationCache()
  let droppedCalls = 0
  await assert.rejects(
    () => compileLocalH3Prompt(SHOT, 'native', {
      translate: async () => {
        droppedCalls += 1
        return 'Characters: Lin Xiaoyu. [0-3s] She looks up.'
      },
    }),
    (err: any) => err instanceof H3PromptTranslationError,
  )
  assert.equal(droppedCalls, 2)

  clearH3TranslationCache()
  let duplicatedCalls = 0
  await assert.rejects(
    () => compileLocalH3Prompt(SHOT, 'native', {
      translate: async () => {
        duplicatedCalls += 1
        return '[[H3_DLG_0]] [[H3_DLG_0]] [[H3_DLG_1]]'
      },
    }),
    (err: any) => err instanceof H3PromptTranslationError,
  )
  assert.equal(duplicatedCalls, 2)
})

test('translation that invents extra dialogue tags is retried and rejected', async () => {
  clearH3TranslationCache()
  let calls = 0
  await assert.rejects(
    () => compileLocalH3Prompt(SHOT, 'native', {
      translate: async () => {
        calls += 1
        return 'Characters: Lin Xiaoyu. [0-3s] She looks up. [[H3_DLG_0]] <d>[Chinese] 旁白</d> [[H3_DLG_1]]'
      },
    }),
    (err: any) => err instanceof H3PromptTranslationError && /多余的对白标签/.test(err.message),
  )
  assert.equal(calls, 2)
})

test('translation failure rejects instead of submitting a Chinese prompt', async () => {
  clearH3TranslationCache()
  await assert.rejects(
    () => compileLocalH3Prompt('人物：林小雨\n0-3秒：@图片1林小雨抬头。', 'native', {
      translate: async () => { throw new Error('text model offline') },
    }),
    (err: any) =>
      err instanceof H3PromptTranslationError
      && /英文化失败/.test(err.message)
      && /text model offline/.test(err.message),
  )
})

test('native mode tells the model that only dialogue tags are voiced', async () => {
  clearH3TranslationCache()
  const translated = 'Characters: <Picture 2> Lin Xiaoyu. [0-3s] She looks up. [[H3_DLG_0]] [3-6s] [[H3_DLG_1]]'
  const withDialogue = await compileLocalH3Prompt(SHOT, 'native', { translate: async () => translated })
  assert.match(withDialogue, /Only text inside <d> tags is spoken/)

  const noDialogue = await compileLocalH3Prompt('A cat runs across a rainy street.', 'native')
  assert.match(noDialogue, /no spoken dialogue/i)
  assert.doesNotMatch(noDialogue, /Only text inside <d>/)

  const ambient = await compileLocalH3Prompt('A cat runs across a rainy street.', 'ambient')
  assert.doesNotMatch(ambient, /only text inside|no spoken dialogue/i)
})

test('english-only prompts skip the text model entirely', async () => {
  let calls = 0
  const out = await compileLocalH3Prompt('A cat runs across a rainy street.', 'native', {
    translate: async () => { calls += 1; return 'unused' },
  })
  assert.match(out, /^A cat runs across a rainy street\.\nThis shot has no spoken dialogue/)
  assert.equal(calls, 0)
})

test('任务层把无台词本地 H3 镜头降为 silent', () => {
  const source = readFileSync(new URL('../src/routes/tasks.ts', import.meta.url), 'utf8')
  assert.match(source, /shouldSilenceLocalH3Audio\(audioMode, videoPrompt, dialogueLineCount\)/)
  assert.match(source, /h3-no-dialogue-silent/)
  assert.match(source, /videoBody!\.audio_mode = 'silent'/)
  assert.match(source, /isNull\(schema\.storyboardLines\.deletedAt\)/)
})

test('无台词镜头降为 silent，不能只靠负面提示词', () => {
  assert.equal(shouldSilenceLocalH3Audio('native', 'A cat.\nThis shot has no spoken dialogue.', 0), true)
  assert.equal(shouldSilenceLocalH3Audio('native', 'X says, <d>[Chinese] 你好</d>', 0), false)
  assert.equal(shouldSilenceLocalH3Audio('native', 'A cat.', 1), false)
  assert.equal(shouldSilenceLocalH3Audio('ambient', 'A cat.', 0), false)
  assert.equal(stripH3AudioLine('A cat.\nAudio: rain and crowd\nShot: street'), 'A cat.\nShot: street')
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

  const injected = await translateH3Text('清晨薄雾，青石长街', {
    translate: async () => 'Morning mist, stone street <d>[Chinese] 旁白</d>',
  })
  assert.equal(injected, null)
})

test('translated background or style text is cached across shots', async () => {
  clearH3TranslationCache()
  let calls = 0
  const translate = async () => {
    calls += 1
    return 'Song dynasty warm gold 3D animation'
  }
  await translateH3Text('宋韵暖金 3D 国漫', { translate })
  await translateH3Text('宋韵暖金 3D 国漫', { translate })
  assert.equal(calls, 1)
})
