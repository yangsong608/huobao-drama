import { text } from './shared.js'

export interface SummaryParams {
  chapterText?: unknown
  globalSummary?: unknown
}

export interface UpdateCharacterStateParams {
  chapterText?: unknown
  oldState?: unknown
}

export const summary = (params: SummaryParams): string => `
以下是新完成的章节文本：
${text(params.chapterText, 'chapterText')}

这是当前的前文摘要（可为空）：
${text(params.globalSummary, 'globalSummary') || '(无)'}

请根据本章新增内容，更新前文摘要。
要求：
- 保留既有重要信息，同时融入新剧情要点
- 以简洁、连贯的语言描述全书进展
- 客观描绘，不展开联想或解释
- 总字数控制在2000字以内

仅返回前文摘要文本，不要解释任何内容。
`

export const updateCharacterState = (params: UpdateCharacterStateParams): string => `
以下是新完成的章节文本：
${text(params.chapterText, 'chapterText')}

这是当前的角色状态文档：
${text(params.oldState, 'oldState')}

请更新主要角色状态，保持原有格式结构。

要求：
- 请直接在已有文档基础上进行增删
- 不改变原有结构，语言尽量简洁、有条理
- 新出场角色简要描述即可，淡出视线的角色可删除

仅返回更新后的角色状态文本，不要解释任何内容。
`

export const utilityPrompts = {
  summary,
  updateCharacterState,
}
