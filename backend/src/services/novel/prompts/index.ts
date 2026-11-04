import { formatGenre, formatWritingStyle, requireNumber, text } from './shared.js'
import {
  NARRATIVE_PERSON_RULES,
  normalizeNarrativePerson,
  narrativePersonLabel,
} from '../story-atlas.js'

export const NOVEL_PROMPT_VERSION = '1.2.0'

export { architecturePrompts } from './architecture.js'
export { chapterPrompts } from './chapter.js'
export { utilityPrompts } from './utility.js'
export { compassPrompts } from './compass.js'
export { NovelPromptParamError } from './shared.js'

export interface NovelArchitectureContextParams {
  topic?: unknown
  genre?: unknown
  background?: unknown
  writingStyle?: unknown
  numberOfChapters: unknown
  wordNumber: unknown
  coreSeed?: unknown
  characterDynamics?: unknown
  worldBuilding?: unknown
  plotArchitecture?: unknown
  narrativePerson?: unknown
  timelineContext?: unknown
  mapContext?: unknown
}

export function buildNovelArchitecture(params: NovelArchitectureContextParams): string {
  return `
#=== 0) 小说设定 ===
主题：${text(params.topic, 'topic')}，类型：${formatGenre(params.genre)}，篇幅：约${requireNumber(params.numberOfChapters, 'numberOfChapters')}章（每章${requireNumber(params.wordNumber, 'wordNumber')}字）
叙述人称：${narrativePersonLabel(normalizeNarrativePerson(params.narrativePerson))}
故事背景：${text(params.background, 'background') || '(未指定)'}
文风要求：${formatWritingStyle(params.writingStyle) || '(未指定)'}

#=== 1) 核心种子 ===
${text(params.coreSeed, 'coreSeed')}

#=== 2) 角色动力学 ===
${text(params.characterDynamics, 'characterDynamics')}

#=== 3) 世界观 ===
${text(params.worldBuilding, 'worldBuilding')}

#=== 4) 三幕式情节架构 ===
${text(params.plotArchitecture, 'plotArchitecture')}
${params.timelineContext ? `\n#=== 5) 时间线参考 ===\n${text(params.timelineContext, 'timelineContext')}\n` : ''}${params.mapContext ? `\n#=== 6) 地图参考 ===\n${text(params.mapContext, 'mapContext')}\n` : ''}`
}

export interface NovelSettingContextParams {
  topic?: unknown
  genre?: unknown
  background?: unknown
  writingStyle?: unknown
  coreSeed?: unknown
  characterDynamics?: unknown
  worldBuilding?: unknown
  plotArchitecture?: unknown
  narrativePerson?: unknown
}

export function buildNovelSetting(params: NovelSettingContextParams): string {
  return `
小说类型：${formatGenre(params.genre)}
叙述人称：${narrativePersonLabel(normalizeNarrativePerson(params.narrativePerson))}
叙述规则：${NARRATIVE_PERSON_RULES[normalizeNarrativePerson(params.narrativePerson)]}

故事背景：${text(params.background, 'background') || '(未指定)'}

文风要求：${formatWritingStyle(params.writingStyle) || '(未指定)'}

核心种子：${text(params.coreSeed, 'coreSeed')}

角色体系：${text(params.characterDynamics, 'characterDynamics')}

世界观：${text(params.worldBuilding, 'worldBuilding')}

情节架构：${text(params.plotArchitecture, 'plotArchitecture')}
`
}
