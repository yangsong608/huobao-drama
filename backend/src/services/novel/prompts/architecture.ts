import { formatGenre, formatWritingStyle, requireNumber, text } from './shared.js'

export interface CoreSeedParams {
  topic?: unknown
  genre?: unknown
  background?: unknown
  writingStyle?: unknown
  numberOfChapters: unknown
  wordNumber: unknown
}

export interface CharacterDynamicsParams {
  genre?: unknown
  background?: unknown
  writingStyle?: unknown
  userGuidance?: unknown
  coreSeed?: unknown
}

export interface WorldBuildingParams extends CharacterDynamicsParams {}

export interface PlotArchitectureParams extends CharacterDynamicsParams {
  characterDynamics?: unknown
  worldBuilding?: unknown
}

export interface CharacterStateParams {
  characterDynamics?: unknown
}

export const coreSeed = (params: CoreSeedParams): string => `
作为专业作家，请用"雪花写作法"第一步构建故事核心：
主题：${text(params.topic, 'topic')}
类型：${formatGenre(params.genre)}
篇幅：约${requireNumber(params.numberOfChapters, 'numberOfChapters')}章（每章${requireNumber(params.wordNumber, 'wordNumber')}字）
故事背景：${text(params.background, 'background') || '(未指定)'}
文风要求：${formatWritingStyle(params.writingStyle) || '(未指定)'}

请根据【${formatGenre(params.genre)}】类型的特点，用单句公式概括故事本质。

不同类型的示例：
- 悬疑/惊悚类："当[主角]遭遇[核心事件]，必须[关键行动]，否则[灾难后果]；与此同时，[隐藏的更大危机]正在发酵。"
- 言情/温馨类："当[主角]在[背景环境]中遇见[另一角色]，两人因[契机]产生羁绊，在[成长/治愈过程]中收获[情感结局]。"
- 玄幻/仙侠类："当[主角]获得[机缘]，踏上[修炼之路]，面对[挑战]，逐步成长为[最终成就]。"
- 都市/现实类："当[主角]面临[现实困境]，通过[努力方式]，实现[人生目标]，同时收获[情感/成长]。"

要求：
1. **严格遵循【${formatGenre(params.genre)}】类型的核心特征和情感基调**
2. 体现人物核心驱动力
3. 暗示世界观或故事背景的关键特点
4. 使用25-100字精准表达

仅返回故事核心文本，不要解释任何内容。
`

export const characterDynamics = (params: CharacterDynamicsParams): string => `
基于以下元素：
- 小说类型：${formatGenre(params.genre) || '通用'}
- 故事背景：${text(params.background, 'background') || '无'}
- 文风要求：${formatWritingStyle(params.writingStyle) || '无'}
- 内容指导：${text(params.userGuidance, 'userGuidance') || '无'}
- 核心种子：${text(params.coreSeed, 'coreSeed')}

请设计3-6个具有动态变化潜力的核心角色，每个角色需包含：
特征：
- 背景、外貌、性别、年龄、职业等
- 角色独特之处或成长空间

核心驱动力三角：
- 表面追求（物质目标）
- 深层渴望（情感需求）
- 灵魂需求（哲学层面）

角色弧线设计：
初始状态 → 触发事件 → 内心转变 → 成长节点 → 最终状态

角色关系网（根据【${formatGenre(params.genre) || '通用'}】类型调整）：
- 与其他角色的关系和互动模式
- 角色间的羁绊或张力来源
- 情感连接点（友情/爱情/亲情/信任等）
- 可能的误解或需要跨越的障碍

**重要**：角色设计需符合【${formatGenre(params.genre) || '通用'}】类型的情感基调。

要求：
仅给出最终文本，不要解释任何内容。
`

export const worldBuilding = (params: WorldBuildingParams): string => `
基于以下元素：
- 小说类型：${formatGenre(params.genre) || '通用'}
- 故事背景：${text(params.background, 'background') || '无'}
- 内容指导：${text(params.userGuidance, 'userGuidance') || '无'}
- 核心故事："${text(params.coreSeed, 'coreSeed')}"

为服务上述内容，请构建适合【${formatGenre(params.genre) || '通用'}】类型的世界观：

1. 物理维度：
- 空间结构（地理环境、主要场景）
- 时间背景（故事发生的时代/时间跨度）
- 规则体系（该世界的基本运行法则）

2. 社会维度：
- 社会结构（人物所处的社会环境）
- 文化氛围（风俗、习惯、价值观）
- 生活方式（日常生活的细节设定）

3. 情感维度：
- 贯穿全书的核心意象（如反复出现的场景、物品、象征）
- 环境氛围与故事情感的呼应关系
- 场景设计如何强化【${formatGenre(params.genre) || '通用'}】类型的情感体验

**重要**：世界观设计需服务于【${formatGenre(params.genre) || '通用'}】类型的核心体验，营造符合类型特点的氛围。

要求：
每个维度至少包含3个可与角色决策产生互动的动态元素。
仅给出最终文本，不要解释任何内容。
`

export const plotArchitecture = (params: PlotArchitectureParams): string => `
基于以下元素：
- 小说类型：${formatGenre(params.genre) || '通用'}
- 故事背景：${text(params.background, 'background') || '无'}
- 内容指导：${text(params.userGuidance, 'userGuidance') || '无'}
- 核心种子：${text(params.coreSeed, 'coreSeed')}
- 角色体系：${text(params.characterDynamics, 'characterDynamics')}
- 世界观：${text(params.worldBuilding, 'worldBuilding')}

请根据【${formatGenre(params.genre) || '通用'}】类型设计三幕式情节架构：

第一幕（开端） 
- 日常状态展示（3处场景铺垫，体现【${formatGenre(params.genre) || '通用'}】的氛围）
- 引出故事：展示主线、感情线、副线的开端
- 契机事件：推动故事发展的触发点（改变角色关系或状态）
- 初步反应：主角面对变化的第一反应

第二幕（发展）
- 剧情深入：主线+感情线的交织发展
- 挑战与成长：角色面临的困难和内心变化
- 情感升温/矛盾激化：关系发展的关键节点
- 重要转折：改变故事走向的关键时刻

第三幕（高潮与结局）
- 核心冲突爆发：故事的高潮部分
- 角色抉择：主角做出重要决定
- 情感/事件收尾：符合【${formatGenre(params.genre) || '通用'}】类型的结局处理

**重要**：情节设计需符合【${formatGenre(params.genre) || '通用'}】类型读者的期待，确保情感基调一致。

每个阶段需包含3个关键节点及其伏笔设计。
仅给出最终文本，不要解释任何内容。
`

export const characterState = (params: CharacterStateParams): string => `
依据当前角色动力学设定：${text(params.characterDynamics, 'characterDynamics')}

请生成一个角色状态文档，内容格式：
例：
张三：
├──物品:
│  ├──青衫：一件破损的青色长袍，带有暗红色的污渍
│  └──寒铁长剑：一柄断裂的铁剑，剑身上刻有古老的符文
├──能力
│  ├──技能1：强大的精神感知能力：能够察觉到周围人的心中活动
│  └──技能2：无形攻击：能够释放一种无法被视觉捕捉的精神攻击
├──状态
│  ├──身体状态: 身材挺拔，穿着华丽的铠甲，面色冷峻
│  └──心理状态: 目前的心态比较平静，但内心隐藏着对柳溪镇未来掌控的野心和不安
├──主要角色间关系网
│  ├──李四：张三从小就与她有关联，对她的成长一直保持关注
│  └──王二：两人之间有着复杂的过去，最近因一场冲突而让对方感到威胁
├──触发或加深的事件
│  ├──村庄内突然出现不明符号：这个不明符号似乎在暗示柳溪镇即将发生重大事件
│  └──李四被刺穿皮肤：这次事件让两人意识到对方的强大实力，促使他们迅速离开队伍

要求：
仅返回编写好的角色状态文本，不要解释任何内容。
`

export interface WorldMapPromptParams extends CharacterDynamicsParams {
  characterDynamics?: unknown
  worldBuilding?: unknown
  plotArchitecture?: unknown
}

export const worldMap = (params: WorldMapPromptParams): string => `
基于以下元素：
- 小说类型：${formatGenre(params.genre) || '通用'}
- 核心种子：${text(params.coreSeed, 'coreSeed')}
- 世界观：${text(params.worldBuilding, 'worldBuilding')}
- 情节架构：${text(params.plotArchitecture, 'plotArchitecture')}
- 角色体系：${text(params.characterDynamics, 'characterDynamics')}

请为这个故事设计世界地图，供写作时定位场景与路线：
- 3-6 个区域（regions），每个区域有 id、name、description、color
- 3-6 个势力（factions），每个势力有 id、name、color
- 8-20 个地点（places），每个地点有 id、name、regionId、factionId、x、y、description、importance
- 5-15 条路线（routes），每条路线有 id、from、to、type、label
- x/y 为 0..1 的归一化坐标，左上为原点；地点不要重叠
- 路线只连接已定义地点；type 只能是 road/sea/air/portal/other
- id 使用小写英文、数字、连字符，同一对象内唯一

严格输出以下 JSON 结构，不要 Markdown、解释或代码围栏：
{"regions":[{"id":"region-1","name":"北境","description":"...","color":"#7c9cbf"}],"factions":[{"id":"faction-1","name":"守夜人","color":"#b07c5c"}],"places":[{"id":"place-1","name":"旧钟楼","regionId":"region-1","factionId":"faction-1","x":0.42,"y":0.31,"description":"...","importance":4}],"routes":[{"id":"route-1","from":"place-1","to":"place-2","type":"road","label":"旧驿道"}]}

只输出 JSON。
`

export interface TimelinePromptParams {
  genre?: unknown
  coreSeed?: unknown
  plotArchitecture?: unknown
  characterDynamics?: unknown
  worldMapJson?: unknown
  numberOfChapters: unknown
}

export const timeline = (params: TimelinePromptParams): string => {
  const chapters = requireNumber(params.numberOfChapters, 'numberOfChapters')
  const targetCount = Math.max(3, Math.min(60, Math.round(chapters / 3)))
  return `
基于以下元素：
- 小说类型：${formatGenre(params.genre) || '通用'}
- 核心种子：${text(params.coreSeed, 'coreSeed')}
- 情节架构：${text(params.plotArchitecture, 'plotArchitecture')}
- 角色体系：${text(params.characterDynamics, 'characterDynamics')}
- 世界地图 JSON：${text(params.worldMapJson, 'worldMapJson')}
- 全书章节数：${chapters}

请提取全书关键时间事件线。目标数量约 ${targetCount} 条（章节数 / 3，限制在 3-60 条），只写关键转折、伏笔与关系变化，不要求每章都有。
每个事件包含 chapterNo、timeLabel、title、summary、placeId、placeName、characters、importance。
chapterNo 必须在 1..${chapters} 内；placeId 优先引用地图地点，无法匹配时给 placeName；importance 为 1-5；timeLabel 用故事内相对时间。

严格输出以下 JSON 结构，不要 Markdown、解释或代码围栏：
{"events":[{"chapterNo":1,"timeLabel":"第一日 黄昏","title":"钟楼失火","summary":"主角在钟楼发现父亲留下的半张地图。","placeId":"place-1","placeName":"旧钟楼","characters":["林晚","周砚"],"importance":5}]}

只输出 JSON。
`
}

export const architecturePrompts = {
  coreSeed,
  characterDynamics,
  worldBuilding,
  plotArchitecture,
  characterState,
  worldMap,
  timeline,
}
