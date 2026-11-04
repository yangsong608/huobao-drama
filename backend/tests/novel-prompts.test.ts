import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NOVEL_PROMPT_VERSION,
  architecturePrompts,
  chapterPrompts,
  utilityPrompts,
  compassPrompts,
  buildNovelArchitecture,
  buildNovelSetting,
  NovelPromptParamError,
} from '../src/services/novel/prompts/index.js'

const ARCHITECTURE_KEYS = ['coreSeed', 'characterDynamics', 'worldBuilding', 'plotArchitecture', 'characterState', 'worldMap', 'timeline']
const CHAPTER_KEYS = ['blueprint', 'blueprintChunked', 'firstDraft', 'nextDraft', 'enrich', 'chapterTimeline']
const UTILITY_KEYS = ['summary', 'updateCharacterState']
const COMPASS_KEYS = ['extractGraph', 'extractChapterDelta', 'auditGraph', 'extractChapterGraph']

test('exposes the original prompt version and all four categories', () => {
  assert.equal(NOVEL_PROMPT_VERSION, '1.2.0')
  assert.deepEqual(Object.keys(architecturePrompts), ARCHITECTURE_KEYS)
  assert.deepEqual(Object.keys(chapterPrompts), CHAPTER_KEYS)
  assert.deepEqual(Object.keys(utilityPrompts), UTILITY_KEYS)
  assert.deepEqual(Object.keys(compassPrompts), COMPASS_KEYS)
  for (const group of [architecturePrompts, chapterPrompts, utilityPrompts, compassPrompts]) {
    for (const fn of Object.values(group)) assert.equal(typeof fn, 'function')
  }
})

test('architecture prompts keep the original wording and type-specific tone', () => {
  const text = architecturePrompts.coreSeed({
    topic: '江湖旧梦',
    genre: ['武侠', '悬疑'],
    numberOfChapters: 12,
    wordNumber: 2500,
  })

  assert.match(text, /用"雪花写作法"第一步构建故事核心/)
  assert.match(text, /主题：江湖旧梦/)
  assert.match(text, /类型：武侠 \/ 悬疑/)
  assert.match(text, /篇幅：约12章（每章2500字）/)
  assert.match(text, /仅返回故事核心文本，不要解释任何内容。/)
})

test('chapter prompts preserve the star tension scale and output template', () => {
  const text = chapterPrompts.blueprint({
    userGuidance: '节奏明快',
    novelArchitecture: '设定文本',
    numberOfChapters: 8,
  })

  assert.match(text, /情节张力（★☆☆☆☆ 到 ★★★★★）/)
  assert.match(text, /第n章 - \[标题\]/)
  assert.match(text, /情节张力：★☆☆☆☆/)
  assert.match(text, /在生成8章前不要出现结局章节/)
})

test('nextDraft falls back to placeholders for optional elements', () => {
  const text = chapterPrompts.nextDraft({
    globalSummary: '前文摘要',
    previousChapterExcerpt: '前章结尾',
    chapterNumber: 2,
    chapterTitle: '夜行',
    chapterRole: '推进',
    chapterPurpose: '升温',
    suspenseLevel: '★★★☆☆',
    foreshadowing: '埋线',
    plotTwistLevel: '★★☆☆☆',
    chapterSummary: '本章简述',
    wordNumber: 2000,
    nextChapterNumber: 3,
    nextChapterTitle: '交锋',
    nextChapterRole: '转折',
    nextChapterPurpose: '冲突',
    nextSuspenseLevel: '★★★★☆',
    nextForeshadowing: '回收',
    nextPlotTwistLevel: '★★★★☆',
    nextChapterSummary: '下章简述',
  })

  assert.match(text, /第2章《夜行》/)
  assert.match(text, /├── 核心人物：\(未指定\)/)
  assert.match(text, /└── 时间压力：\(未指定\)/)
  assert.match(text, /当前章节摘要：\n    \(无\)/)
  assert.match(text, /不要使用markdown格式。/)
})

test('background and writing style flow into architecture, setting and chapter drafts', () => {
  const style = { key: 'suspense', name: '悬疑冷峻', prompt: '短句与留白' }
  const architecture = buildNovelArchitecture({
    topic: '长夜',
    genre: '悬疑',
    numberOfChapters: 10,
    wordNumber: 1800,
    background: '民国上海',
    writingStyle: style,
  })
  assert.match(architecture, /故事背景：民国上海/)
  assert.match(architecture, /文风要求：悬疑冷峻：短句与留白/)

  const setting = buildNovelSetting({
    genre: ['悬疑'],
    background: '民国上海',
    writingStyle: style,
    coreSeed: '种子',
  })
  assert.match(setting, /故事背景：民国上海/)
  assert.match(setting, /文风要求：悬疑冷峻：短句与留白/)

  const first = chapterPrompts.firstDraft({
    chapterNumber: 1,
    chapterTitle: '开端',
    wordNumber: 2000,
    novelSetting: '小说设定文本',
    narration: '窗外雨声渐密',
    writingStyle: style,
  })
  assert.match(first, /小说设定：\n小说设定文本/)
  assert.match(first, /文风要求：悬疑冷峻：短句与留白/)

  const next = chapterPrompts.nextDraft({
    chapterNumber: 2,
    chapterTitle: '夜行',
    wordNumber: 2000,
    nextChapterNumber: 3,
    novelSetting: '小说设定文本',
    narration: '街灯摇晃',
    writingStyle: style,
  })
  assert.match(next, /小说设定：\n小说设定文本/)
  assert.match(next, /文风要求：悬疑冷峻：短句与留白/)

  const enriched = chapterPrompts.enrich({ chapterText: '原文', wordNumber: 2000, writingStyle: style })
  assert.match(enriched, /文风要求：悬疑冷峻：短句与留白/)
})

test('compass prompts keep the strict JSON extraction contract', () => {
  const text = compassPrompts.extractChapterDelta({
    currentNodes: [{ id: 'char_zhangsan', label: '张三', type: 'character', status: 'active' }],
    currentEdges: [],
    chapterNumber: 4,
    chapterText: '正文',
  })

  assert.match(text, /=== 当前图谱状态 ===/)
  assert.match(text, /=== 第 4 章内容 ===/)
  assert.match(text, /"newNodes"/)
  assert.match(text, /仅输出 JSON，不要 markdown 代码块标记/)
  assert.match(text, /"id":"char_zhangsan"/)
})

test('architecture context keeps the #=== section markers verbatim', () => {
  const architecture = buildNovelArchitecture({
    topic: '长夜',
    genre: '悬疑',
    numberOfChapters: 10,
    wordNumber: 1800,
    coreSeed: '种子',
    characterDynamics: '角色',
    worldBuilding: '世界',
    plotArchitecture: '情节',
  })

  assert.match(architecture, /\n#=== 0\) 小说设定 ===\n主题：长夜，类型：悬疑，篇幅：约10章（每章1800字）/)
  assert.match(architecture, /\n#=== 1\) 核心种子 ===\n种子/)
  assert.match(architecture, /\n#=== 2\) 角色动力学 ===\n角色/)
  assert.match(architecture, /\n#=== 3\) 世界观 ===\n世界/)
  assert.match(architecture, /\n#=== 4\) 三幕式情节架构 ===\n情节\n$/)

  const setting = buildNovelSetting({
    genre: ['悬疑', '科幻'],
    coreSeed: '种子',
    characterDynamics: '角色',
    worldBuilding: '世界',
    plotArchitecture: '情节',
  })
  assert.equal(
    setting,
    '\n小说类型：悬疑 / 科幻\n叙述人称：第三人称限知\n叙述规则：第三人称限知叙述。围绕视角人物展开，只呈现视角人物可知的信息；不进入其他角色内心。\n\n故事背景：(未指定)\n\n文风要求：(未指定)\n\n核心种子：种子\n\n角色体系：角色\n\n世界观：世界\n\n情节架构：情节\n',
  )
})

test('rejects invalid numeric params with a typed error', () => {
  assert.throws(
    () => chapterPrompts.firstDraft({ chapterNumber: 'abc' } as never),
    (error: unknown) => error instanceof NovelPromptParamError && /chapterNumber/.test(error.message),
  )
  assert.throws(
    () => chapterPrompts.enrich({ chapterText: '正文', wordNumber: '' } as never),
    (error: unknown) => error instanceof NovelPromptParamError && /wordNumber/.test(error.message),
  )
})
