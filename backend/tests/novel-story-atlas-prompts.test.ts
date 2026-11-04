import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NOVEL_PROMPT_VERSION,
  architecturePrompts,
  buildNovelArchitecture,
  buildNovelSetting,
  chapterPrompts,
} from '../src/services/novel/prompts/index.ts'

test('prompt version is 1.2.0 and architecture includes POV and context', () => {
  assert.equal(NOVEL_PROMPT_VERSION, '1.2.0')
  const architecture = buildNovelArchitecture({
    topic: '权谋',
    genre: ['古装'],
    numberOfChapters: 30,
    wordNumber: 3000,
    coreSeed: '种子',
    characterDynamics: '角色',
    worldBuilding: '世界',
    plotArchitecture: '情节',
    narrativePerson: 'first',
    timelineContext: '- 第1章 第一日：开端',
    mapContext: '- 钟楼（北境）：旧钟',
  })
  assert.match(architecture, /叙述人称：第一人称/)
  assert.match(architecture, /时间线参考/)
  assert.match(architecture, /地图参考/)
  const setting = buildNovelSetting({ genre: ['古装'], coreSeed: '种子', narrativePerson: 'third_limited' })
  assert.match(setting, /叙述人称：第三人称限知/)
  assert.match(setting, /只呈现视角人物可知的信息/)
})

test('world map prompt asks for strict JSON and schema keys', () => {
  const prompt = architecturePrompts.worldMap({
    genre: ['古装'],
    coreSeed: '种子',
    worldBuilding: '世界',
    plotArchitecture: '情节',
    characterDynamics: '角色',
  })
  assert.match(prompt, /只输出 JSON/)
  for (const key of ['regions', 'factions', 'places', 'routes', 'regionId', 'importance']) {
    assert.match(prompt, new RegExp(key))
  }
})

test('timeline prompt includes chapter count and target count guidance', () => {
  const prompt = architecturePrompts.timeline({
    genre: ['古装'],
    coreSeed: '种子',
    plotArchitecture: '情节',
    characterDynamics: '角色',
    worldMapJson: '{"places":[]}',
    numberOfChapters: 30,
  })
  assert.match(prompt, /30/)
  assert.match(prompt, /10/)
  assert.match(prompt, /只输出 JSON/)
})

test('blueprint prompts include POV and narration line', () => {
  const prompt = chapterPrompts.blueprint({ novelArchitecture: '架构', numberOfChapters: 3, narrativePerson: 'first' })
  assert.match(prompt, /叙述人称：第一人称/)
  assert.match(prompt, /旁白描述/)
  const chunked = chapterPrompts.blueprintChunked({
    novelArchitecture: '架构', numberOfChapters: 3, startChapter: 1, endChapter: 3, narrativePerson: 'first',
  })
  assert.match(chunked, /旁白描述/)
})

test('draft prompts include POV, narration, timeline and map context', () => {
  const common = {
    chapterNumber: 2,
    chapterTitle: '雨夜',
    wordNumber: 3000,
    narrativePerson: 'first',
    narration: '冷雨压住节奏。',
    timelineContext: '- 第2章 当夜：对峙',
    mapContext: '- 钟楼（北境）：旧钟',
  }
  const first = chapterPrompts.firstDraft({ ...common, novelSetting: '设定' })
  const next = chapterPrompts.nextDraft({
    ...common,
    globalSummary: '前文',
    previousChapterExcerpt: '前章',
    characterState: '状态',
    shortSummary: '简述',
    nextChapterNumber: 3,
  })
  const enrich = chapterPrompts.enrich({ chapterText: '正文', wordNumber: 3000, narrativePerson: 'first', narration: '冷雨压住节奏。' })
  for (const prompt of [first, next]) {
    assert.match(prompt, /叙述人称：第一人称/)
    assert.match(prompt, /本章旁白：冷雨压住节奏。/)
    assert.match(prompt, /时间线上下文/)
    assert.match(prompt, /地点上下文/)
  }
  assert.match(enrich, /叙述人称：第一人称/)
  assert.match(enrich, /本章旁白/)
})

test('chapter timeline prompt requires current chapter and strict JSON', () => {
  const prompt = chapterPrompts.chapterTimeline({
    chapterNo: 12,
    chapterText: '正文',
    existingEvents: '[]',
    worldMapJson: '{"places":[]}',
    neighborEvents: '- 第11章：前情',
  })
  assert.match(prompt, /第12章/)
  assert.match(prompt, /1–3|1-3/)
  assert.match(prompt, /只输出 JSON/)
})
