/**
 * 过渡计划：断点、模型有效时长、提示词与来源指纹。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertCustomTransitionDuration,
  audibleCharCount,
  buildCloudTransitionPrompt,
  buildLocalTransitionPrompt,
  buildTransitionBoundaries,
  customTransitionSourceHash,
  effectiveTransitionDuration,
  normalizeTransitionKind,
  normalizeTransitionText,
  parseTransitionKind,
  transitionEdgeMode,
  transitionSourceHash,
} from '../src/services/transition-plan.ts'

test('断点按合片实际镜头序列相邻生成', () => {
  assert.deepEqual(buildTransitionBoundaries([]), [])
  assert.deepEqual(buildTransitionBoundaries([{ id: 1, storyboardNumber: 1 }]), [])
  assert.deepEqual(
    buildTransitionBoundaries([
      { id: 11, storyboardNumber: 1 },
      { id: 13, storyboardNumber: 3 },
      { id: 14, storyboardNumber: 4 },
    ]),
    [
      { index: 1, fromStoryboardId: 11, toStoryboardId: 13, fromNumber: 1, toNumber: 3 },
      { index: 2, fromStoryboardId: 13, toStoryboardId: 14, fromNumber: 3, toNumber: 4 },
    ],
  )
})

test('有效时长按模型档位折算', () => {
  assert.equal(effectiveTransitionDuration('aliyun', 'wan3.0-video', 2), 2)
  assert.equal(effectiveTransitionDuration('aliyun', 'wan3.0-video', 3), 3)
  assert.equal(effectiveTransitionDuration('aliyun', 'wan3.0-video', 1), 2)
  assert.equal(effectiveTransitionDuration('aliyun', 'wan3.0-video', 8), 8)

  assert.equal(effectiveTransitionDuration('volcengine', 'doubao-seedance-2-0-260128', 2), 4)
  assert.equal(effectiveTransitionDuration('volcengine', 'doubao-seedance-2-0-260128', 3), 4)
  assert.equal(effectiveTransitionDuration('volcengine', 'doubao-seedance-2-0-260128', 5), 5)

  assert.equal(effectiveTransitionDuration('volcengine', 'doubao-seedance-1-0-lite-i2v-250428', 3), 3)

  assert.equal(effectiveTransitionDuration('minimax', 'MiniMax-H3', 3), 4)
  assert.equal(effectiveTransitionDuration('minimax', 'MiniMax-H3', 5), 5)

  assert.equal(effectiveTransitionDuration('minimax', 'MiniMax-H3', 2, { localShim: true }), 2.333)
  assert.equal(effectiveTransitionDuration('minimax', 'MiniMax-H3', 3, { localShim: true }), 3.042)
  assert.equal(effectiveTransitionDuration('minimax', 'MiniMax-H3', 4, { localShim: true }), 4.458)
  assert.equal(effectiveTransitionDuration('minimax', 'MiniMax-H3', 5, { localShim: true }), 5.167)

  assert.equal(effectiveTransitionDuration('comfyui', 'comfyui-video', 3), 3)
  assert.equal(effectiveTransitionDuration('aliyun', 'wan2.2-i2v-plus', 3), 5)
})

test('云端提示词包含镜头上下文并清掉对白引文', () => {
  const prompt = buildCloudTransitionPrompt({
    fromNumber: 1,
    toNumber: 2,
    prevVisual: '林晚站在雨夜街头，低声说：“别走，听我解释。”',
    nextVisual: '她推开咖啡馆的门，暖光落在脸上。',
    continuity: '同一人物，外号“小鹿”，服装不变。',
    sameScene: false,
  })

  assert.match(prompt, /S1/)
  assert.match(prompt, /S2/)
  assert.match(prompt, /林晚站在雨夜街头/)
  assert.match(prompt, /推开咖啡馆的门/)
  assert.match(prompt, /小鹿/)
  assert.doesNotMatch(prompt, /别走/)
  assert.doesNotMatch(prompt, /[“”"]/)
  assert.match(prompt, /柔和视觉桥接/)
  assert.match(prompt, /无对白、无旁白、无歌声/)
  assert.match(prompt, /不生成字幕或文字/)
})

test('同场景过渡提示强调连续运镜', () => {
  const prompt = buildCloudTransitionPrompt({
    fromNumber: 3,
    toNumber: 4,
    prevVisual: '两人站在天台栏杆旁。',
    nextVisual: '两人转身看向城市夜景。',
    sameScene: true,
  })
  assert.match(prompt, /保持同一场景/)
  assert.doesNotMatch(prompt, /柔和视觉桥接/)
})

test('本地 H3 提示词只保留英文骨架，中文片段直接省略', () => {
  const prompt = buildLocalTransitionPrompt({
    prevVisual: '两人站在天台栏杆旁。',
    nextVisual: null,
    continuity: '',
  })
  assert.match(prompt, /A short cinematic transition shot/)
  assert.match(prompt, /No new characters, no scene change/)
  assert.doesNotMatch(prompt, /[\u4e00-\u9fff]/)

  const english = buildLocalTransitionPrompt({
    prevVisual: 'Two people stand by the rooftop railing.',
    nextVisual: 'They turn toward the city lights.',
    continuity: 'Same wardrobe and lighting.',
  })
  assert.match(english, /Previous shot: Two people stand/)
  assert.match(english, /Next shot: They turn toward/)
  assert.match(english, /Continuity: Same wardrobe/)
})

test('过渡类型：历史空值按 ai，未知值在解析时拒绝', () => {
  assert.equal(normalizeTransitionKind(undefined), 'ai')
  assert.equal(normalizeTransitionKind(''), 'ai')
  assert.equal(normalizeTransitionKind('AI'), 'ai')
  assert.equal(normalizeTransitionKind('empty'), 'empty')
  assert.equal(normalizeTransitionKind('scene'), 'scene')
  assert.equal(normalizeTransitionKind('text'), 'text')
  assert.equal(normalizeTransitionKind('bogus'), 'ai')

  assert.equal(parseTransitionKind('empty'), 'empty')
  assert.equal(parseTransitionKind('scene'), 'scene')
  assert.equal(parseTransitionKind('text'), 'text')
  assert.equal(parseTransitionKind('ai'), 'ai')
  assert.throws(() => parseTransitionKind('bogus'), /类型不合法/)
})

test('文字视频两端硬切，其余过渡保持淡入淡出', () => {
  assert.equal(transitionEdgeMode('text'), 'cut')
  assert.equal(transitionEdgeMode('ai'), 'fade')
  assert.equal(transitionEdgeMode('empty'), 'fade')
  assert.equal(transitionEdgeMode('scene'), 'fade')
})

test('文字视频按可发音字符计数并校验标题副标题', () => {
  assert.equal(audibleCharCount('雨夜，街角！'), 4)
  assert.equal(audibleCharCount('Hello world!'), 10)
  assert.equal(audibleCharCount('  ！？…  '), 0)

  assert.deepEqual(normalizeTransitionText({ title: '  三年后  ', subtitle: '   ' }), {
    title: '三年后', subtitle: null,
  })
  assert.deepEqual(normalizeTransitionText({ title: '三年后', subtitle: '雨夜重逢' }), {
    title: '三年后', subtitle: '雨夜重逢',
  })
  assert.throws(() => normalizeTransitionText({ title: '   ' }), /主标题/)
  assert.throws(() => normalizeTransitionText({ title: '字'.repeat(21) }), /20/)
  assert.throws(() => normalizeTransitionText({ title: '标题', subtitle: '字'.repeat(41) }), /40/)
})

test('自定义过渡时长只允许 2-5 秒', () => {
  assert.equal(assertCustomTransitionDuration(2), 2)
  assert.equal(assertCustomTransitionDuration('3.5'), 3.5)
  assert.equal(assertCustomTransitionDuration(5), 5)
  assert.throws(() => assertCustomTransitionDuration(1.9), /2-5/)
  assert.throws(() => assertCustomTransitionDuration(6), /2-5/)
  assert.throws(() => assertCustomTransitionDuration('abc'), /2-5/)
})

test('自定义过渡使用独立指纹，不依赖相邻镜头视频', () => {
  const base = {
    kind: 'empty' as const,
    prompt: '空无一人的雨夜街角，路灯下积水泛着微光。',
    duration: 3,
    audioMode: 'silent',
  }
  const hash = customTransitionSourceHash(base)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(customTransitionSourceHash({ ...base }), hash)
  assert.notEqual(customTransitionSourceHash({ ...base, prompt: '另一段空镜描述' }), hash)
  assert.notEqual(customTransitionSourceHash({ ...base, duration: 4 }), hash)
  assert.notEqual(customTransitionSourceHash({ ...base, audioMode: 'ambient' }), hash)

  const text = customTransitionSourceHash({
    kind: 'text', textContent: '三年后', textSubtitle: '雨夜重逢', duration: 3, audioMode: 'silent',
  })
  assert.notEqual(customTransitionSourceHash({
    kind: 'text', textContent: '三年后', textSubtitle: null, duration: 3, audioMode: 'silent',
  }), text)

  const scene = customTransitionSourceHash({
    kind: 'scene', prompt: '镜头缓慢推近', sceneId: 8, sceneImageUrl: 'static/scenes/a.jpg',
    duration: 3, audioMode: 'ambient',
  })
  assert.notEqual(customTransitionSourceHash({
    kind: 'scene', prompt: '镜头缓慢推近', sceneId: 8, sceneImageUrl: 'static/scenes/b.jpg',
    duration: 3, audioMode: 'ambient',
  }), scene)
  assert.notEqual(customTransitionSourceHash({
    kind: 'scene', prompt: '镜头缓慢推近', sceneId: 9, sceneImageUrl: 'static/scenes/a.jpg',
    duration: 3, audioMode: 'ambient',
  }), scene)
  assert.throws(() => customTransitionSourceHash({ ...base, kind: 'ai' as never }), /类型不合法/)
})

test('来源指纹随任一来源信息变化', () => {
  const base = {
    fromVideoUrl: 'static/projects/1/videos/a.mp4',
    toVideoUrl: 'static/projects/1/videos/b.mp4',
    fromSize: 1000,
    fromMtimeMs: 1_000,
    toSize: 2000,
    toMtimeMs: 2_000,
  }
  const hash = transitionSourceHash(base)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(transitionSourceHash({ ...base }), hash)
  assert.notEqual(transitionSourceHash({ ...base, fromMtimeMs: 1_001 }), hash)
  assert.notEqual(transitionSourceHash({ ...base, toVideoUrl: 'static/projects/1/videos/c.mp4' }), hash)
})
