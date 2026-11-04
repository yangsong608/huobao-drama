import { formatWritingStyle, requireNumber, text } from './shared.js'
import {
  NARRATIVE_PERSON_RULES,
  normalizeNarrativePerson,
  narrativePersonLabel,
} from '../story-atlas.js'

export interface BlueprintParams {
  userGuidance?: unknown
  novelArchitecture?: unknown
  numberOfChapters: unknown
  narrativePerson?: unknown
}

export interface BlueprintChunkedParams extends BlueprintParams {
  chapterList?: unknown
  startChapter: unknown
  endChapter: unknown
}

export interface FirstDraftParams {
  chapterNumber: unknown
  chapterTitle?: unknown
  chapterRole?: unknown
  chapterPurpose?: unknown
  suspenseLevel?: unknown
  foreshadowing?: unknown
  plotTwistLevel?: unknown
  chapterSummary?: unknown
  charactersInvolved?: unknown
  keyItems?: unknown
  sceneLocation?: unknown
  timeConstraint?: unknown
  novelSetting?: unknown
  writingStyle?: unknown
  wordNumber: unknown
  userGuidance?: unknown
  narrativePerson?: unknown
  narration?: unknown
  timelineContext?: unknown
  mapContext?: unknown
}

export interface NextDraftParams {
  globalSummary?: unknown
  previousChapterExcerpt?: unknown
  userGuidance?: unknown
  characterState?: unknown
  shortSummary?: unknown
  novelSetting?: unknown
  writingStyle?: unknown
  chapterNumber: unknown
  chapterTitle?: unknown
  chapterRole?: unknown
  chapterPurpose?: unknown
  suspenseLevel?: unknown
  foreshadowing?: unknown
  plotTwistLevel?: unknown
  chapterSummary?: unknown
  wordNumber: unknown
  charactersInvolved?: unknown
  keyItems?: unknown
  sceneLocation?: unknown
  timeConstraint?: unknown
  nextChapterNumber: unknown
  nextChapterTitle?: unknown
  nextChapterRole?: unknown
  nextChapterPurpose?: unknown
  nextSuspenseLevel?: unknown
  nextForeshadowing?: unknown
  nextPlotTwistLevel?: unknown
  nextChapterSummary?: unknown
  narrativePerson?: unknown
  narration?: unknown
  timelineContext?: unknown
  mapContext?: unknown
}

export interface EnrichParams {
  chapterText?: unknown
  wordNumber: unknown
  narrativePerson?: unknown
  narration?: unknown
  writingStyle?: unknown
}

interface NarrativeContextParams {
  narrativePerson?: unknown
  narration?: unknown
  writingStyle?: unknown
  timelineContext?: unknown
  mapContext?: unknown
}

const narrativeContext = (params: NarrativeContextParams): string => `
叙述人称：${narrativePersonLabel(normalizeNarrativePerson(params.narrativePerson))}
叙述规则：${NARRATIVE_PERSON_RULES[normalizeNarrativePerson(params.narrativePerson)]}
本章旁白：${text(params.narration, 'narration') || '(无)'}
旁白要求：将旁白转化为正文中的叙述段落或过渡，不要照抄说明，不要使用「旁白：」标签。
文风要求：${formatWritingStyle(params.writingStyle) || '(未指定)'}

时间线上下文：
${text(params.timelineContext, 'timelineContext') || '(无)'}

地点上下文：
${text(params.mapContext, 'mapContext') || '(无)'}
`

export const blueprint = (params: BlueprintParams): string => `
基于以下元素：
- 内容指导：${text(params.userGuidance, 'userGuidance') || '无'}
- 叙述人称：${narrativePersonLabel(normalizeNarrativePerson(params.narrativePerson))}
- 小说架构：
${text(params.novelArchitecture, 'novelArchitecture')}

设计${requireNumber(params.numberOfChapters, 'numberOfChapters')}章的节奏分布（根据小说类型调整风格）：
1. 章节集群划分：
- 每3-5章构成一个情节单元，包含完整的小高潮
- 单元之间合理安排情感节奏（张弛有度）
- 关键转折章需预留铺垫

2. 每章需明确：
- 章节定位（角色/事件/主题等）
- 核心内容（剧情推进/情感发展/角色成长等）
- 情感基调（符合小说类型的情感色彩）
- 伏笔操作（埋设/强化/回收）
- 情节张力（★☆☆☆☆ 到 ★★★★★）
- 旁白描述（用于正文叙述的旁白、过渡或信息补充，50-80字）

输出格式示例：
第n章 - [标题]
本章定位：[角色/事件/主题/...]
核心作用：[推进/转折/发展/升温/...]
情感强度：[平缓/渐进/高潮/...]
伏笔操作：埋设(A线索)→强化(B关系)...
情节张力：★☆☆☆☆
本章简述：[一句话概括]
旁白描述：[本章旁白的语气、视角、补充信息或过渡作用]

要求：
- 使用精炼语言描述，每章字数控制在100字以内。
- 合理安排节奏，确保整体情感曲线的连贯性。
- 在生成${requireNumber(params.numberOfChapters, 'numberOfChapters')}章前不要出现结局章节。
- **情节设计需符合小说类型的风格和情感基调**。

仅给出最终文本，不要解释任何内容。
`

export const blueprintChunked = (params: BlueprintChunkedParams): string => `
基于以下元素：
- 内容指导：${text(params.userGuidance, 'userGuidance') || '无'}
- 叙述人称：${narrativePersonLabel(normalizeNarrativePerson(params.narrativePerson))}
- 小说架构：
${text(params.novelArchitecture, 'novelArchitecture')}

需要生成总共${requireNumber(params.numberOfChapters, 'numberOfChapters')}章的节奏分布，

当前已有章节目录（若为空则说明是初始生成）：
${text(params.chapterList, 'chapterList') || '(无)'}

现在请设计第${requireNumber(params.startChapter, 'startChapter')}章到第${requireNumber(params.endChapter, 'endChapter')}章的节奏分布（根据小说类型调整风格）：
1. 章节集群划分：
- 每3-5章构成一个情节单元，包含完整的小高潮
- 单元之间合理安排情感节奏（张弛有度）
- 关键转折章需预留铺垫

2. 每章需明确：
- 章节定位（角色/事件/主题等）
- 核心内容（剧情推进/情感发展/角色成长等）
- 情感基调（符合小说类型的情感色彩）
- 伏笔操作（埋设/强化/回收）
- 情节张力（★☆☆☆☆ 到 ★★★★★）
- 旁白描述（用于正文叙述的旁白、过渡或信息补充，50-80字）

输出格式示例：
第n章 - [标题]
本章定位：[角色/事件/主题/...]
核心作用：[推进/转折/发展/升温/...]
情感强度：[平缓/渐进/高潮/...]
伏笔操作：埋设(A线索)→强化(B关系)...
情节张力：★☆☆☆☆
本章简述：[一句话概括]
旁白描述：[本章旁白的语气、视角、补充信息或过渡作用]

要求：
- 使用精炼语言描述，每章字数控制在100字以内。
- 合理安排节奏，确保整体情感曲线的连贯性。
- 在生成${requireNumber(params.numberOfChapters, 'numberOfChapters')}章前不要出现结局章节。
- **情节设计需符合小说类型的风格和情感基调**。

仅给出最终文本，不要解释任何内容。
`

export const firstDraft = (params: FirstDraftParams): string => `
即将创作：第 ${requireNumber(params.chapterNumber, 'chapterNumber')} 章《${text(params.chapterTitle, 'chapterTitle')}》
本章定位：${text(params.chapterRole, 'chapterRole')}
核心作用：${text(params.chapterPurpose, 'chapterPurpose')}
悬念密度：${text(params.suspenseLevel, 'suspenseLevel')}
伏笔操作：${text(params.foreshadowing, 'foreshadowing')}
认知颠覆：${text(params.plotTwistLevel, 'plotTwistLevel')}
本章简述：${text(params.chapterSummary, 'chapterSummary')}

可用元素：
- 核心人物：${text(params.charactersInvolved, 'charactersInvolved') || '(未指定)'}
- 关键道具：${text(params.keyItems, 'keyItems') || '(未指定)'}
- 空间坐标：${text(params.sceneLocation, 'sceneLocation') || '(未指定)'}
- 时间压力：${text(params.timeConstraint, 'timeConstraint') || '(未指定)'}

${narrativeContext(params)}

参考文档：
- 小说设定：
${text(params.novelSetting, 'novelSetting')}

完成第 ${requireNumber(params.chapterNumber, 'chapterNumber')} 章的正文，字数要求${requireNumber(params.wordNumber, 'wordNumber')}字，根据小说类型设计2个或以上的场景：
1. 对话场景：
   - 体现人物性格和关系
   - 推动剧情或情感发展

2. 动作/互动场景：
   - 环境交互细节（感官描写）
   - 节奏控制（根据情节需要调整）
   - 通过行动展现人物特质

3. 心理/情感场景：
   - 人物内心活动描写
   - 情感变化的细腻刻画
   - 符合小说类型的情感基调

4. 环境场景：
   - 场景氛围营造
   - 环境与人物心情的呼应
   - 符合小说类型的整体风格

格式要求：
- 仅返回章节正文文本；
- 不使用分章节小标题；
- 不要使用markdown格式。

额外指导：${text(params.userGuidance, 'userGuidance') || '(无)'}
`

export const nextDraft = (params: NextDraftParams): string => `
参考文档：
└── 前文摘要：
    ${text(params.globalSummary, 'globalSummary')}

└── 前章结尾段：
    ${text(params.previousChapterExcerpt, 'previousChapterExcerpt')}

└── 用户指导：
    ${text(params.userGuidance, 'userGuidance') || '(无)'}

└── 角色状态：
    ${text(params.characterState, 'characterState')}

└── 当前章节摘要：
    ${text(params.shortSummary, 'shortSummary') || '(无)'}

└── 小说设定：
${text(params.novelSetting, 'novelSetting')}

${narrativeContext(params)}

当前章节信息：
第${requireNumber(params.chapterNumber, 'chapterNumber')}章《${text(params.chapterTitle, 'chapterTitle')}》：
├── 章节定位：${text(params.chapterRole, 'chapterRole')}
├── 核心作用：${text(params.chapterPurpose, 'chapterPurpose')}
├── 悬念密度：${text(params.suspenseLevel, 'suspenseLevel')}
├── 伏笔设计：${text(params.foreshadowing, 'foreshadowing')}
├── 转折程度：${text(params.plotTwistLevel, 'plotTwistLevel')}
├── 章节简述：${text(params.chapterSummary, 'chapterSummary')}
├── 字数要求：${requireNumber(params.wordNumber, 'wordNumber')}字
├── 核心人物：${text(params.charactersInvolved, 'charactersInvolved') || '(未指定)'}
├── 关键道具：${text(params.keyItems, 'keyItems') || '(未指定)'}
├── 场景地点：${text(params.sceneLocation, 'sceneLocation') || '(未指定)'}
└── 时间压力：${text(params.timeConstraint, 'timeConstraint') || '(未指定)'}

下一章节目录
第${requireNumber(params.nextChapterNumber, 'nextChapterNumber')}章《${text(params.nextChapterTitle, 'nextChapterTitle')}》：
├── 章节定位：${text(params.nextChapterRole, 'nextChapterRole')}
├── 核心作用：${text(params.nextChapterPurpose, 'nextChapterPurpose')}
├── 悬念密度：${text(params.nextSuspenseLevel, 'nextSuspenseLevel')}
├── 伏笔设计：${text(params.nextForeshadowing, 'nextForeshadowing')}
├── 转折程度：${text(params.nextPlotTwistLevel, 'nextPlotTwistLevel')}
└── 章节简述：${text(params.nextChapterSummary, 'nextChapterSummary')}

依据前面所有设定，开始完成第 ${requireNumber(params.chapterNumber, 'chapterNumber')} 章的正文，字数要求${requireNumber(params.wordNumber, 'wordNumber')}字，
内容生成严格遵循：
- 用户指导
- 当前章节摘要
- 当前章节信息
- 无逻辑漏洞
确保章节内容与前文摘要、前章结尾段衔接流畅、下一章目录保证上下文完整性，

格式要求：
- 仅返回章节正文文本；
- 不使用分章节小标题；
- 不要使用markdown格式。
`

export const enrich = (params: EnrichParams): string => `
以下章节文本较短，请在保持剧情连贯的前提下进行扩写，使其更充实，接近 ${requireNumber(params.wordNumber, 'wordNumber')} 字左右。

叙述人称：${narrativePersonLabel(normalizeNarrativePerson(params.narrativePerson))}
叙述规则：${NARRATIVE_PERSON_RULES[normalizeNarrativePerson(params.narrativePerson)]}
本章旁白：${text(params.narration, 'narration') || '(无)'}
文风要求：${formatWritingStyle(params.writingStyle) || '(未指定)'}

原内容：
${text(params.chapterText, 'chapterText')}

要求：
- 保持剧情连贯性
- 增加环境描写和心理描写
- 丰富对话和场景细节
- 保持叙述声音，不新增与旁白冲突的视角信息
- 仅给出最终文本，不要解释任何内容
`

export interface ChapterTimelineParams {
  chapterNo: unknown
  chapterText?: unknown
  existingEvents?: unknown
  worldMapJson?: unknown
  neighborEvents?: unknown
}

export const chapterTimeline = (params: ChapterTimelineParams): string => `
请从以下第${requireNumber(params.chapterNo, 'chapterNo')}章正文中提取 1–3 条对后续有影响的时间事件。

本章已有事件：
${text(params.existingEvents, 'existingEvents') || '(无)'}

世界地图地点：
${text(params.worldMapJson, 'worldMapJson') || '(无)'}

相邻章事件：
${text(params.neighborEvents, 'neighborEvents') || '(无)'}

章节正文：
${text(params.chapterText, 'chapterText')}

要求：
- chapterNo 必须等于 ${requireNumber(params.chapterNo, 'chapterNo')}
- 可复用已有事件 id 表示更新；新事件可省略 id，服务端生成
- 不重复其他章节事件
- placeId 只能引用上面地图中已有的地点
- 严格输出 JSON，不要 Markdown、解释或代码围栏：{"events":[{"id":"ch012-1","chapterNo":12,"timeLabel":"当夜","title":"雨夜对峙","summary":"...","placeId":"place-1","characters":["林晚"],"importance":4}]}

只输出 JSON。
`

export const chapterPrompts = {
  blueprint,
  blueprintChunked,
  firstDraft,
  nextDraft,
  enrich,
  chapterTimeline,
}
