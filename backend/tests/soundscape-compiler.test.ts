/**
 * 声音场景编译器：请求规范化、场景切片、生成项、群众规则、确定性模板。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SoundscapeError,
  buildSoundscapeDraft,
  clampSeconds,
  decorateSoundscapePlan,
  parseSoundscapeRequest,
  translateSoundscapeHints,
  type BuildSoundscapeDraftInput,
  type LineRecord,
  type SceneRecord,
  type StoryboardRecord,
} from '../src/services/soundscape-compiler.ts'
import type { TimelineClipPosition, TimelineCue } from '../src/services/timeline.ts'

const scenes: SceneRecord[] = [
  { id: 10, location: '街道', time: '夜', prompt: '霓虹灯下的街道', finalPrompt: null },
  { id: 11, location: '森林', time: '黄昏', prompt: '潮湿的森林', finalPrompt: null },
  { id: 12, location: '室内', time: '夜', prompt: null, finalPrompt: null },
]

const storyboards: StoryboardRecord[] = [
  { id: 101, sceneId: 10, storyboardNumber: 1, location: '街道', time: '夜', atmosphere: '紧张', bgmPrompt: '低沉弦乐', soundEffect: '雨声' },
  { id: 102, sceneId: 10, storyboardNumber: 2, location: '街道', time: '夜', atmosphere: '压抑', bgmPrompt: null, soundEffect: '脚步声' },
  { id: 103, sceneId: 11, storyboardNumber: 1, location: '森林', time: '黄昏', atmosphere: '神秘', bgmPrompt: '空灵', soundEffect: null },
  { id: 104, sceneId: 11, storyboardNumber: 2, location: '森林', time: '黄昏', atmosphere: '紧张', bgmPrompt: null, soundEffect: '风声' },
  { id: 105, sceneId: 12, storyboardNumber: 1, location: '室内', time: '夜', atmosphere: null, bgmPrompt: null, soundEffect: '开门声' },
  { id: 106, sceneId: null, storyboardNumber: 1, location: null, time: null, atmosphere: null, bgmPrompt: null, soundEffect: null },
]

const clips: TimelineClipPosition[] = [
  { storyboardId: 101, startMs: 0, endMs: 5000, durationMs: 5000 },
  { storyboardId: 102, startMs: 5000, endMs: 9000, durationMs: 4000 },
  { storyboardId: 103, startMs: 9000, endMs: 12000, durationMs: 3000 },
  { storyboardId: 104, startMs: 12000, endMs: 20000, durationMs: 8000 },
]

function cue(lineId: number, shotId: number, speaker: string, text: string, kind: TimelineCue['kind'] = 'dialogue'): TimelineCue {
  return {
    lineId, shotId, startMs: shotId * 10, endMs: shotId * 10 + 800,
    subtitleStartMs: shotId * 10, subtitleEndMs: shotId * 10 + 800,
    text, speaker, kind, speed: 1, overflowMs: 0, overlap: false, trimmed: false,
    audioDurationMs: 800, audioUrl: `/audio/${lineId}.mp3`,
  }
}

const cues: TimelineCue[] = [
  cue(201, 101, '路人甲', '快看那边'),
  cue(202, 102, '张三', '你好'),
  cue(203, 103, '村民们', '欢迎回来'),
  cue(204, 104, '旁白', '众人散去'),
]

const lines: LineRecord[] = [
  { id: 201, characterId: null, speakerType: 'dialogue', lineNo: 1 },
  { id: 202, characterId: 3, speakerType: 'dialogue', lineNo: 2 },
  { id: 203, characterId: null, speakerType: 'dialogue', lineNo: 3 },
  { id: 204, characterId: null, speakerType: 'narration', lineNo: 4 },
]

function draftInput(overrides: Partial<BuildSoundscapeDraftInput> = {}): BuildSoundscapeDraftInput {
  return {
    episodeId: 1,
    mode: 'scenes',
    categories: ['ambience', 'sfx', 'crowd', 'bgm'],
    crowdMode: 'walla',
    sceneIds: [],
    totalDurationMs: 20000,
    scenes,
    storyboards,
    clips,
    cues,
    lines,
    ...overrides,
  }
}

test('缺少合片时间轴时抛 400', () => {
  assert.throws(
    () => buildSoundscapeDraft(draftInput({ totalDurationMs: 0 })),
    (error: any) => error instanceof SoundscapeError && error.status === 400 && /合片/.test(error.message),
  )
})

test('场景范围由分镜并集计算，缺少视频的分镜跳过并警告', () => {
  const plan = buildSoundscapeDraft(draftInput())
  const ambience = plan.items.filter((item) => item.category === 'ambience')
  assert.deepEqual(ambience.map((item) => [item.itemId, item.startMs, item.endMs]), [
    ['ambience:scene:10', 0, 9000],
    ['ambience:scene:11', 9000, 20000],
  ])
  const warnings = plan.warnings.join('\n')
  assert.match(warnings, /分镜 105 没有可用视频/)
  assert.match(warnings, /分镜 106 未归属场景/)
  assert.match(warnings, /场景 3 没有可用分镜/)
})

test('四类生成项数量与 itemId 正确，BGM 始终整集一项', () => {
  const plan = buildSoundscapeDraft(draftInput())
  assert.deepEqual(plan.items.map((item) => item.itemId), [
    'ambience:scene:10',
    'ambience:scene:11',
    'sfx:scene:10',
    'sfx:scene:11',
    'crowd:scene:10',
    'crowd:scene:11',
    'bgm:episode',
  ])
  assert.equal(plan.items.filter((item) => item.category === 'bgm').length, 1)
  assert.equal(plan.items.find((item) => item.category === 'bgm')!.startMs, 0)
  assert.equal(plan.items.find((item) => item.category === 'bgm')!.endMs, 20000)
})

test('音效合并同场景多个 soundEffect，且降级模板输出英文', () => {
  const plan = buildSoundscapeDraft(draftInput())
  const sfx = plan.items.find((item) => item.itemId === 'sfx:scene:10')!
  assert.match(sfx.prompt, /rain/)
  assert.match(sfx.prompt, /footsteps/)
  assert.doesNotMatch(sfx.prompt, /[\u4e00-\u9fa5]/)
  assert.equal(sfx.degraded, true)
  const ambience = plan.items.find((item) => item.itemId === 'ambience:scene:10')!
  assert.match(ambience.prompt, /^ambient background, night, street, /)
  assert.equal(ambience.seconds, 45)
  const bgm = plan.items.find((item) => item.category === 'bgm')!
  assert.match(bgm.prompt, /^cinematic instrumental score, /)
  assert.match(bgm.prompt, /no vocals, subtle, loopable$/)
})

test('整集铺底模式：环境声一项覆盖整集，长于素材时 loop', () => {
  const plan = buildSoundscapeDraft(draftInput({
    mode: 'episode-bed',
    totalDurationMs: 60000,
    categories: ['ambience'],
  }))
  assert.equal(plan.items.length, 1)
  const item = plan.items[0]
  assert.equal(item.itemId, 'ambience:episode')
  assert.equal(item.startMs, 0)
  assert.equal(item.endMs, 60000)
  assert.equal(item.seconds, 45)
  assert.equal(item.loop, true)
})

test('群众台词规则识别旁白、具体角色，并与 LLM 结果合并', () => {
  const plan = buildSoundscapeDraft(draftInput({
    categories: ['crowd'],
    crowdMode: 'lines',
  }))
  assert.deepEqual(plan.items.map((item) => [item.itemId, item.source, item.lineIds]), [
    ['crowd:scene:10', 'lines', [201]],
    ['crowd:scene:11', 'lines', [203]],
  ])
  assert.ok(plan.items.every((item) => item.seconds === 0 && item.prompt === ''))

  const merged = buildSoundscapeDraft(draftInput({
    categories: ['crowd'],
    crowdMode: 'lines',
    prompts: { 10: { crowdLineIds: [202] } },
  }))
  assert.deepEqual(merged.items.find((item) => item.sceneId === 10)!.lineIds, [201, 202])
})

test('assets-only + 群众台词模式不产生任何生成项并警告', () => {
  const plan = buildSoundscapeDraft(draftInput({
    mode: 'assets-only',
    categories: ['crowd'],
    crowdMode: 'lines',
  }))
  assert.equal(plan.items.length, 0)
  assert.match(plan.warnings.join('\n'), /仅生成素材/)
})

test('场景筛选与场景序号', () => {
  const plan = buildSoundscapeDraft(draftInput({ sceneIds: [11] }))
  assert.deepEqual(plan.items.map((item) => item.itemId), [
    'ambience:scene:11',
    'sfx:scene:11',
    'crowd:scene:11',
    'bgm:episode',
  ])
  assert.throws(
    () => buildSoundscapeDraft(draftInput({ sceneIds: [999] })),
    (error: any) => error instanceof SoundscapeError && /没有可用的场景或分镜/.test(error.message),
  )
})

test('所选场景不可用时只警告一次', () => {
  const plan = buildSoundscapeDraft(draftInput({ sceneIds: [10, 12] }))
  assert.equal(plan.warnings.filter((warning) => warning.includes('场景 3')).length, 1)
  assert.equal(new Set(plan.warnings).size, plan.warnings.length)
})

test('LLM 提示词覆盖模板，degraded=false', () => {
  const plan = buildSoundscapeDraft(draftInput({
    prompts: {
      10: {
        ambiencePrompt: 'night street ambience',
        sfxPrompt: 'rain and footsteps',
        crowdPrompt: 'crowd walla',
        bgmMood: 'tense',
      },
    },
  }))
  assert.equal(plan.items.find((item) => item.itemId === 'ambience:scene:10')!.prompt, 'night street ambience')
  assert.equal(plan.items.find((item) => item.itemId === 'ambience:scene:10')!.degraded, false)
  assert.equal(plan.items.find((item) => item.itemId === 'sfx:scene:10')!.prompt, 'rain and footsteps')
  assert.equal(plan.items.find((item) => item.itemId === 'crowd:scene:10')!.prompt, 'crowd walla')
  assert.match(plan.items.find((item) => item.category === 'bgm')!.prompt, /tense/)
  assert.equal(plan.items.find((item) => item.category === 'bgm')!.degraded, false)
})

test('时长夹取与提示词覆盖解析', () => {
  assert.equal(clampSeconds('ambience', 1), 30)
  assert.equal(clampSeconds('ambience', 99), 45)
  assert.equal(clampSeconds('sfx', 1), 2)
  assert.equal(clampSeconds('sfx', 99), 10)
  assert.equal(clampSeconds('crowd', 1), 20)
  assert.equal(clampSeconds('crowd', 99), 45)
  assert.equal(clampSeconds('bgm', 1), 30)
  assert.equal(clampSeconds('bgm', 99), 45)
  assert.deepEqual(translateSoundscapeHints(['雨夜街道']), ['night', 'rain', 'street'])

  const request = parseSoundscapeRequest({
    mode: 'episode-bed',
    categories: ['bgm', 'bgm'],
    crowdMode: 'lines',
    sceneIds: [11, 11],
    overwrite: true,
    overrides: [{ itemId: 'bgm:episode', prompt: 'custom', seconds: 99 }],
  })
  assert.deepEqual(request, {
    mode: 'episode-bed',
    categories: ['bgm'],
    crowdMode: 'lines',
    sceneIds: [11],
    overwrite: true,
    overrides: [{ itemId: 'bgm:episode', prompt: 'custom', seconds: 99 }],
    categoryHints: {},
    configId: undefined,
  })
})

test('请求参数非法返回 400', () => {
  assert.throws(() => parseSoundscapeRequest({ categories: [] }), (error: any) => error.status === 400)
  assert.throws(() => parseSoundscapeRequest({ mode: 'nope', categories: ['ambience'] }), /模式/)
  assert.throws(() => parseSoundscapeRequest({ categories: ['voice'] }), /类别/)
  assert.throws(() => parseSoundscapeRequest({
    categories: ['ambience'],
    overrides: [{ itemId: 'ambience:episode', prompt: 'x'.repeat(2001) }],
  }), /2000/)
  assert.throws(() => parseSoundscapeRequest({
    categories: ['ambience'],
    overrides: Array.from({ length: 161 }, (_, index) => ({
      itemId: `ambience:scene:${index}`,
      prompt: 'x',
    })),
  }), /覆盖项过多/)
})

test('覆盖项数量超限时优先报数量错误', () => {
  assert.throws(() => parseSoundscapeRequest({
    categories: ['ambience'],
    overrides: Array.from({ length: 161 }, () => 42),
  }), /覆盖项过多/)
})

test('固定 seed 夹取到有效整数范围', () => {
  const draft = buildSoundscapeDraft(draftInput())
  const decorate = (fixedSeed: number | null) => decorateSoundscapePlan(draft, {
    episodeId: 1,
    model: 'stable-audio-open-1.0',
    workflowHash: 'workflow-hash-test',
    normalizeLoudness: true,
    fixedSeed,
  })
  const low = decorate(-5)
  assert.ok(
    low.items.filter((item) => item.source === 'generate').every((item) => item.seed === 0),
    '负 seed 应夹取为 0',
  )
  const high = decorate(2 ** 40)
  assert.ok(
    high.items.filter((item) => item.source === 'generate').every((item) => item.seed === 2147483647),
    '超大 seed 应夹取为 int32 上限',
  )
})

import {
  compileSoundscapePlan,
  hashSoundscapeWorkflow,
  parseScenePromptResponse,
  type SoundscapeCompileDeps,
} from '../src/services/soundscape-compiler.ts'
import type { TimelineResult } from '../src/services/timeline.ts'

function compileDeps(patch: Partial<SoundscapeCompileDeps> = {}): SoundscapeCompileDeps {
  const timeline: TimelineResult = {
    clips,
    cues,
    totalDurationMs: 20000,
    maxOverflowMs: 0,
    overlapCount: 0,
    atempoCount: 0,
    trimmedCount: 0,
    skippedLineIds: [],
  }
  return {
    timeline: async () => timeline,
    loadScenes: async () => scenes,
    loadStoryboards: async () => storyboards,
    loadLines: async () => lines,
    compileScenePrompts: async () => ({
      prompts: {
        10: { ambiencePrompt: 'night street ambience', bgmMood: 'tense' },
      },
      degraded: false,
      warnings: [],
    }),
    loadCachedHashes: async () => new Set<string>(),
    ...patch,
  }
}

function compileOptions(deps: Partial<SoundscapeCompileDeps> = {}, overrides: any[] = []) {
  return {
    request: parseSoundscapeRequest({
      categories: ['ambience', 'bgm'],
      overrides,
    }),
    model: 'stable-audio-open-1.0',
    workflowHash: 'workflow-hash-test',
    normalizeLoudness: true,
    fixedSeed: null,
    deps: compileDeps(deps),
  }
}

test('LLM 编译结果进入生成项，未返回的场景降级', async () => {
  const plan = await compileSoundscapePlan(1, 2, compileOptions())
  const scene10 = plan.items.find((item) => item.itemId === 'ambience:scene:10')!
  assert.equal(scene10.prompt, 'night street ambience')
  assert.equal(scene10.degraded, false)
  const scene11 = plan.items.find((item) => item.itemId === 'ambience:scene:11')!
  assert.equal(scene11.degraded, true)
  assert.equal(plan.counts.total, 3)
  assert.equal(plan.counts.generate, 3)
  assert.equal(plan.estimatedSeconds, 90)
  assert.equal(plan.degraded, true)
})

test('同输入两次编译得到相同种子与 sourceHash', async () => {
  const first = await compileSoundscapePlan(1, 2, compileOptions())
  const second = await compileSoundscapePlan(1, 2, compileOptions())
  for (let index = 0; index < first.items.length; index += 1) {
    assert.equal(first.items[index].seed, second.items[index].seed)
    assert.equal(first.items[index].sourceHash, second.items[index].sourceHash)
  }
  assert.match(first.items[0].sourceHash, /^[0-9a-f]{64}$/)
})

test('提示词覆盖改变提示词、夹取秒数并改变 sourceHash', async () => {
  const base = await compileSoundscapePlan(1, 2, compileOptions())
  const baseHash = base.items.find((item) => item.itemId === 'ambience:scene:10')!.sourceHash
  const plan = await compileSoundscapePlan(1, 2, compileOptions({}, [
    { itemId: 'ambience:scene:10', prompt: 'custom rain ambience', seconds: 99 },
    { itemId: 'ambience:episode', prompt: 'unknown item' },
  ]))
  const item = plan.items.find((entry) => entry.itemId === 'ambience:scene:10')!
  assert.equal(item.prompt, 'custom rain ambience')
  assert.equal(item.seconds, 45)
  assert.notEqual(item.sourceHash, baseHash)
  assert.match(plan.warnings.join('\n'), /ambience:episode 未匹配/)
})

test('固定 seed 时所有生成项共用同一值', async () => {
  const plan = await compileSoundscapePlan(1, 2, {
    ...compileOptions(),
    fixedSeed: 4242,
  })
  assert.ok(plan.items.every((item) => item.seed === 4242))
})

test('缓存命中标记 cached', async () => {
  const first = await compileSoundscapePlan(1, 2, compileOptions())
  const hash = first.items.find((item) => item.itemId === 'ambience:scene:10')!.sourceHash
  const plan = await compileSoundscapePlan(1, 2, compileOptions({
    loadCachedHashes: async () => new Set([hash]),
  }))
  assert.equal(plan.items.find((item) => item.itemId === 'ambience:scene:10')!.cached, true)
  assert.equal(plan.counts.cached, 1)
})

test('文本模型不可用时整体降级并警告', async () => {
  const plan = await compileSoundscapePlan(1, 2, compileOptions({
    compileScenePrompts: async () => { throw new Error('no text model') },
  }))
  assert.match(plan.warnings.join('\n'), /通用模板/)
  assert.equal(plan.degraded, true)
  assert.ok(plan.items.filter((item) => item.source === 'generate').every((item) => item.degraded))
})

test('解析场景提示词响应：去空白、过滤非法 lineId', () => {
  assert.deepEqual(parseScenePromptResponse({
    scenes: [
      {
        sceneId: 10,
        ambiencePrompt: '  night street  ',
        sfxPrompt: 'rain',
        crowdPrompt: '',
        bgmMood: 'tense',
        crowdLineIds: [201, '202', 'x', 0],
      },
    ],
  }), {
    10: {
      ambiencePrompt: 'night street',
      sfxPrompt: 'rain',
      bgmMood: 'tense',
      crowdLineIds: [201, 202],
    },
  })
  assert.deepEqual(parseScenePromptResponse({}), {})
})

test('工作流哈希稳定且区分内容', () => {
  const a = hashSoundscapeWorkflow({ 1: { class_type: 'A' } })
  const b = hashSoundscapeWorkflow({ 1: { class_type: 'A' } })
  const c = hashSoundscapeWorkflow({ 1: { class_type: 'B' } })
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('categoryHints 解析：去空白、丢空串、拒绝非法结构', () => {
  const request = parseSoundscapeRequest({
    categories: ['ambience', 'crowd'],
    categoryHints: {
      ambience: ' 海水拍打甲板 ',
      crowd: '菜市场早市，十几个人叫卖讨价还价',
      sfx: '   ',
      bgm: null,
    },
  })
  assert.deepEqual(request.categoryHints, {
    ambience: '海水拍打甲板',
    crowd: '菜市场早市，十几个人叫卖讨价还价',
  })
  assert.throws(
    () => parseSoundscapeRequest({ categories: ['ambience'], categoryHints: { voice: '非法类别' } }),
    (error: any) => error.status === 400 && /类别/.test(error.message),
  )
  assert.throws(
    () => parseSoundscapeRequest({ categories: ['ambience'], categoryHints: { ambience: 'x'.repeat(2001) } }),
    (error: any) => error.status === 400 && /2000/.test(error.message),
  )
  assert.throws(
    () => parseSoundscapeRequest({ categories: ['ambience'], categoryHints: '海水' }),
    (error: any) => error.status === 400,
  )
  assert.throws(
    () => parseSoundscapeRequest({ categories: ['ambience'], categoryHints: { ambience: 42 } }),
    (error: any) => error.status === 400,
  )
})

test('用户声音描述进入降级提示词（各类别）', () => {
  const plan = buildSoundscapeDraft(draftInput({
    categoryHints: {
      ambience: '海水拍打甲板',
      sfx: '木门吱呀作响',
      crowd: '菜市场早市，十几个人叫卖讨价还价',
      bgm: '悲壮的弦乐',
    },
  }))
  assert.match(plan.items.find((item) => item.itemId === 'ambience:scene:10')!.prompt, /海水拍打甲板/)
  assert.match(plan.items.find((item) => item.itemId === 'sfx:scene:10')!.prompt, /木门吱呀作响/)
  assert.match(plan.items.find((item) => item.itemId === 'crowd:scene:10')!.prompt, /菜市场早市/)
  assert.match(plan.items.find((item) => item.itemId === 'bgm:episode')!.prompt, /悲壮的弦乐/)
  const noHint = buildSoundscapeDraft(draftInput())
  assert.doesNotMatch(noHint.items.find((item) => item.itemId === 'ambience:scene:10')!.prompt, /海水拍打甲板/)
})

test('声音描述转发给 LLM 编译输入，LLM 结果优先且不重复追加', async () => {
  let captured: unknown = null
  const plan = await compileSoundscapePlan(1, 2, {
    ...compileOptions({
      compileScenePrompts: async (input) => {
        captured = input
        return { prompts: { 10: { ambiencePrompt: 'waves hitting wooden deck' } }, degraded: false, warnings: [] }
      },
    }),
    request: parseSoundscapeRequest({
      categories: ['ambience'],
      categoryHints: { ambience: '海水拍打甲板' },
    }),
  })
  assert.deepEqual((captured as any).categoryHints, { ambience: '海水拍打甲板' })
  const item = plan.items.find((entry) => entry.itemId === 'ambience:scene:10')!
  assert.equal(item.prompt, 'waves hitting wooden deck')
  assert.doesNotMatch(item.prompt, /海水拍打甲板/)
})

test('声音描述改变降级项的 sourceHash', async () => {
  const base = await compileSoundscapePlan(1, 2, compileOptions())
  const baseHash = base.items.find((item) => item.itemId === 'ambience:scene:11')!.sourceHash
  const plan = await compileSoundscapePlan(1, 2, {
    ...compileOptions(),
    request: parseSoundscapeRequest({
      categories: ['ambience'],
      categoryHints: { ambience: '海水拍打甲板' },
    }),
  })
  const item = plan.items.find((entry) => entry.itemId === 'ambience:scene:11')!
  assert.notEqual(item.sourceHash, baseHash)
  assert.match(item.prompt, /海水拍打甲板/)
})
