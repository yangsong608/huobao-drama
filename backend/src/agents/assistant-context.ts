/**
 * 助手上下文预算：作用域摘要、历史裁剪、工具截断、模型优先级。
 * 只做只读查询；摘要不触发建工程、落版本或补默认总线。
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getAgentSettings, type AgentSettings } from '../services/app-settings.js'
import { parseChapterBlueprint } from '../services/novel/blueprint.js'
import {
  narrativePersonLabel,
  normalizeNarrativePerson,
} from '../services/novel/story-atlas.js'
import type { AgentScope } from './agent-scope.js'

export const SCOPE_SUMMARY_MAX_CHARS = 2000
export const OMITTED_NOTICE = '（较早对话已省略）'

export interface AssistantBudget {
  maxSteps: number
  timeoutSec: number
  maxChars: number
  maxResultChars: number
  historyMaxMessages: number
  messageMaxChars: number
  scopeSummaryMaxChars: number
}

export function getAssistantBudget(): AssistantBudget {
  const settings = getAgentSettings()
  return {
    maxSteps: settings.maxSteps,
    timeoutSec: settings.timeoutSec,
    maxChars: settings.context.maxChars,
    maxResultChars: settings.tools.maxResultChars,
    historyMaxMessages: settings.history.maxMessages,
    messageMaxChars: settings.message.maxChars,
    scopeSummaryMaxChars: SCOPE_SUMMARY_MAX_CHARS,
  }
}

export function clipText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return { text: '', truncated: text.length > 0 }
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

function oneLine(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function countRows(table: any, where: any): number {
  const row = db.select({ count: sql<number>`count(*)` }).from(table).where(where).get()
  return Number(row?.count ?? 0)
}

export function summarizeGraphMeta(raw: string | null | undefined): {
  generated: boolean
  generatedAt: string | null
  auditCount: number
  auditErrors: number
  auditWarnings: number
  lastAuditAt: string | null
} {
  let parsed: any = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    parsed = null
  }
  const audit = parsed && typeof parsed.audit === 'object' && parsed.audit ? parsed.audit : {}
  const items = Array.isArray(audit.inconsistencies) ? audit.inconsistencies : []
  return {
    generated: Boolean(parsed?.graphGenerated),
    generatedAt: typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : null,
    auditCount: items.length,
    auditErrors: items.filter((item: any) => item?.severity === 'error').length,
    auditWarnings: items.filter((item: any) => item?.severity === 'warning').length,
    lastAuditAt: typeof audit.lastAuditAt === 'string' ? audit.lastAuditAt : null,
  }
}

function homeSummary(): string {
  const dramas = db.select({
    id: schema.dramas.id,
    title: schema.dramas.title,
    status: schema.dramas.status,
    totalEpisodes: schema.dramas.totalEpisodes,
    updatedAt: schema.dramas.updatedAt,
  }).from(schema.dramas)
    .where(isNull(schema.dramas.deletedAt))
    .orderBy(desc(schema.dramas.updatedAt))
    .limit(5)
    .all()
  const dramaCount = countRows(schema.dramas, isNull(schema.dramas.deletedAt))
  const episodeCount = countRows(schema.episodes, isNull(schema.episodes.deletedAt))
  const lines = ['【当前上下文】', '页面：首页', `项目：${dramaCount} 个；分集：${episodeCount} 集`]
  if (dramas.length) {
    lines.push('最近项目：')
    for (const drama of dramas) {
      lines.push(`- #${drama.id}《${oneLine(drama.title)}》 状态 ${oneLine(drama.status) || '-'}；共 ${drama.totalEpisodes ?? 0} 集；更新于 ${drama.updatedAt}`)
    }
  } else {
    lines.push('最近项目：暂无项目（尚未创建或已删除）')
  }
  return lines.join('\n')
}

function novelLibrarySummary(): string {
  const novels = db.select({
    id: schema.novels.id,
    title: schema.novels.title,
    status: schema.novels.status,
    numberOfChapters: schema.novels.numberOfChapters,
    blueprintGenerated: schema.novels.blueprintGenerated,
    updatedAt: schema.novels.updatedAt,
  }).from(schema.novels)
    .where(isNull(schema.novels.deletedAt))
    .orderBy(desc(schema.novels.updatedAt))
    .limit(5)
    .all()
  const total = countRows(schema.novels, isNull(schema.novels.deletedAt))
  const lines = ['【当前上下文】', '页面：小说库', `小说：${total} 本`]
  if (novels.length) {
    lines.push('最近更新：')
    for (const novel of novels) {
      const row = db.select({
        written: sql<number>`sum(case when length(trim(coalesce(content, ''))) > 0 then 1 else 0 end)`,
      }).from(schema.novelChapters)
        .where(eq(schema.novelChapters.novelId, novel.id))
        .get()
      const written = Number(row?.written ?? 0)
      lines.push(`- #${novel.id}《${oneLine(novel.title)}》 已写 ${written}/${novel.numberOfChapters ?? 0} 章；蓝图${novel.blueprintGenerated ? '已生成' : '未生成'}；状态 ${oneLine(novel.status) || '-'}；更新于 ${novel.updatedAt}`)
    }
  } else {
    lines.push('最近更新：暂无小说（尚未创建或已删除）')
  }
  return lines.join('\n')
}

function novelSummary(scope: AgentScope): string {
  const novelId = scope.novel_id
  if (!novelId) return '【当前上下文】\n页面：小说工作台\n未指定小说。'
  const novel = db.select().from(schema.novels)
    .where(and(eq(schema.novels.id, novelId), isNull(schema.novels.deletedAt)))
    .get()
  if (!novel) return '【当前上下文】\n页面：小说工作台\n小说不存在或已删除。'

  const aggregate = db.select({
    total: sql<number>`count(*)`,
    written: sql<number>`sum(case when length(trim(coalesce(content, ''))) > 0 then 1 else 0 end)`,
    words: sql<number>`sum(coalesce(word_count, 0))`,
  }).from(schema.novelChapters)
    .where(eq(schema.novelChapters.novelId, novelId))
    .get()
  const blueprint = parseChapterBlueprint(novel.chapterBlueprint)
  const graph = summarizeGraphMeta(novel.graphMeta)
  const person = normalizeNarrativePerson(novel.narrativePerson)

  const lines = [
    '【当前上下文】',
    '页面：小说工作台',
    `小说：《${oneLine(novel.title)}》（ID: ${novel.id}；状态 ${oneLine(novel.status) || '-'}）`,
    `章节：已建 ${Number(aggregate?.total ?? 0)} 章，已写 ${Number(aggregate?.written ?? 0)} 章，共 ${Number(aggregate?.words ?? 0)} 字；计划 ${novel.numberOfChapters ?? 0} 章`,
    `架构${novel.architectureGenerated ? '已生成' : '未生成'}；蓝图${novel.blueprintGenerated ? '已生成' : '未生成'}（解析 ${blueprint.length} 章）`,
    `叙事人称：${narrativePersonLabel(person)}`,
    `图谱：${graph.generated ? '已生成' : '未生成'}；审计 ${graph.auditCount} 项（错误 ${graph.auditErrors} / 警告 ${graph.auditWarnings}）`,
  ]

  const chapterId = scope.focus?.chapter_id
  if (chapterId) {
    const chapter = db.select().from(schema.novelChapters)
      .where(and(eq(schema.novelChapters.id, chapterId), eq(schema.novelChapters.novelId, novelId)))
      .get()
    if (chapter) {
      lines.push(`当前章节：第 ${chapter.chapterNo} 章《${oneLine(chapter.title) || `第${chapter.chapterNo}章`}》；状态 ${oneLine(chapter.status) || '-'}；${chapter.wordCount ?? 0} 字；最后修改 ${chapter.updatedAt}`)
    }
  }
  return lines.join('\n')
}

function dramaSummary(scope: AgentScope): string {
  const dramaId = scope.drama_id
  if (!dramaId) return '【当前上下文】\n页面：项目详情\n未指定项目。'
  const drama = db.select().from(schema.dramas)
    .where(and(eq(schema.dramas.id, dramaId), isNull(schema.dramas.deletedAt)))
    .get()
  if (!drama) return '【当前上下文】\n页面：项目详情\n项目不存在或已删除。'
  const episodes = db.select({
    id: schema.episodes.id,
    episodeNumber: schema.episodes.episodeNumber,
    title: schema.episodes.title,
    status: schema.episodes.status,
  }).from(schema.episodes)
    .where(and(eq(schema.episodes.dramaId, dramaId), isNull(schema.episodes.deletedAt)))
    .orderBy(schema.episodes.episodeNumber)
    .all()
  const lines = [
    '【当前上下文】',
    '页面：项目详情',
    `项目：《${oneLine(drama.title)}》（ID: ${drama.id}）`,
    `画幅：${oneLine(drama.aspectRatio) || '-'}；状态 ${oneLine(drama.status) || '-'}；分集 ${episodes.length} 集`,
  ]
  if (episodes.length) {
    const shown = episodes.slice(0, 12)
    lines.push(`分集：${shown.map((ep) => `第${ep.episodeNumber}集《${oneLine(ep.title)}》`).join('；')}${episodes.length > shown.length ? `；等 ${episodes.length} 集` : ''}`)
  } else {
    lines.push('分集：暂无分集')
  }
  return lines.join('\n')
}

function episodeSummary(scope: AgentScope): string {
  const dramaId = scope.drama_id
  const episodeId = scope.episode_id
  if (!dramaId || !episodeId) return '【当前上下文】\n页面：分集工作台\n未指定项目或分集。'
  const drama = db.select().from(schema.dramas)
    .where(and(eq(schema.dramas.id, dramaId), isNull(schema.dramas.deletedAt)))
    .get()
  const episode = db.select().from(schema.episodes)
    .where(and(
      eq(schema.episodes.id, episodeId),
      eq(schema.episodes.dramaId, dramaId),
      isNull(schema.episodes.deletedAt),
    ))
    .get()
  if (!drama || !episode) return '【当前上下文】\n页面：分集工作台\n项目或分集不存在，或已删除。'

  const storyboardCount = countRows(
    schema.storyboards,
    and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)),
  )
  const characterCount = countRows(schema.episodeCharacters, eq(schema.episodeCharacters.episodeId, episodeId))
  const sceneCount = countRows(schema.episodeScenes, eq(schema.episodeScenes.episodeId, episodeId))
  const propCount = countRows(schema.episodeProps, eq(schema.episodeProps.episodeId, episodeId))
  const lineStats = db.select({
    total: sql<number>`count(*)`,
    voiced: sql<number>`sum(case when active_take_id is not null or audio_url is not null then 1 else 0 end)`,
  }).from(schema.storyboardLines)
    .where(and(eq(schema.storyboardLines.episodeId, episodeId), isNull(schema.storyboardLines.deletedAt)))
    .get()
  const editProject = db.select({
    id: schema.editProjects.id,
    title: schema.editProjects.title,
    status: schema.editProjects.status,
  }).from(schema.editProjects)
    .where(and(eq(schema.editProjects.episodeId, episodeId), isNull(schema.editProjects.deletedAt)))
    .orderBy(desc(schema.editProjects.updatedAt))
    .get()
  const trackCount = countRows(schema.episodeAudioTracks, eq(schema.episodeAudioTracks.episodeId, episodeId))
  const exportCount = countRows(
    schema.episodeExports,
    and(eq(schema.episodeExports.episodeId, episodeId), isNull(schema.episodeExports.deletedAt)),
  )
  const scriptChars = (episode.scriptContent || episode.content || '').length
  const lines = [
    '【当前上下文】',
    `页面：分集工作台${scope.stage ? `（${scope.stage}）` : ''}`,
    `项目：《${oneLine(drama.title)}》（ID: ${drama.id}；画幅 ${oneLine(drama.aspectRatio) || '-'}）`,
    `当前集：第 ${episode.episodeNumber} 集《${oneLine(episode.title)}》（ID: ${episode.id}；状态 ${oneLine(episode.status) || '-'}）`,
    `剧本：${scriptChars} 字${episode.scriptContent ? '（已改写）' : episode.content ? '（原文未改写）' : '（暂无内容）'}`,
    `分镜：${storyboardCount} 个；资产绑定：角色 ${characterCount} / 场景 ${sceneCount} / 道具 ${propCount}`,
    `配音：台词 ${Number(lineStats?.total ?? 0)} 句，已生成 ${Number(lineStats?.voiced ?? 0)} 句`,
    `剪辑：${editProject ? `工程 #${editProject.id}《${oneLine(editProject.title)}》（${oneLine(editProject.status) || '-'}）` : '尚未建立工程'}`,
    `混音：音频轨 ${trackCount} 条；混音版本 ${episode.mixRevisionId ? `#${episode.mixRevisionId}` : '未生成'}`,
    `成片：${episode.currentFilmId ? `当前成片 #${episode.currentFilmId}` : '暂无当前成片'}；导出 ${exportCount} 条`,
  ]
  return lines.join('\n')
}

export function buildScopeSummary(scope: AgentScope): string {
  let summary = ''
  switch (scope.kind) {
    case 'home':
      summary = homeSummary()
      break
    case 'novel-library':
      summary = novelLibrarySummary()
      break
    case 'novel':
      summary = novelSummary(scope)
      break
    case 'drama':
      summary = dramaSummary(scope)
      break
    default:
      summary = episodeSummary(scope)
      break
  }
  return clipText(summary, SCOPE_SUMMARY_MAX_CHARS).text
}

export interface AssistantHistoryMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface TrimHistoryOptions {
  maxMessages: number
  maxChars: number
  /** 为工具结果预留的字数 */
  reserveChars?: number
}

export interface TrimmedHistory {
  messages: AssistantHistoryMessage[]
  omitted: boolean
  usedChars: number
  budgetChars: number
}

/** 历史裁剪：保留最近 N 条，超预算从最旧删除；当前消息永不裁剪 */
export function trimAssistantHistory(
  messages: AssistantHistoryMessage[],
  options: TrimHistoryOptions,
): TrimmedHistory {
  const maxMessages = Math.max(1, Math.floor(options.maxMessages))
  const budgetChars = Math.max(0, Math.floor(options.maxChars) - Math.max(0, Math.floor(options.reserveChars ?? 0)))
  const eligible = messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim())
    .map((message) => ({ role: message.role, content: message.content }))
  const kept = eligible.slice(-maxMessages)
  let omitted = eligible.length > kept.length
  let usedChars = kept.reduce((sum, message) => sum + message.content.length, 0)

  while (usedChars > budgetChars && kept.length > 1) {
    const removed = kept.shift()
    if (!removed) break
    usedChars -= removed.content.length
    omitted = true
  }

  const result: AssistantHistoryMessage[] = omitted
    ? [{ role: 'system', content: OMITTED_NOTICE }, ...kept]
    : kept
  return { messages: result, omitted, usedChars, budgetChars }
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(sk-[A-Za-z0-9_-]{8,})/g, '[密钥已隐藏]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[已隐藏]'],
  [/((?:api[_-]?key|access[_-]?token|token|secret)\s*[=:]\s*)[^\s,;[\]]+/gi, '$1[已隐藏]'],
]

/** 错误信息脱敏：不回显密钥/令牌，并限制长度 */
export function redactSecrets(text: string): string {
  let result = text
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement)
  return result
}

export function sanitizeAssistantError(error: unknown, maxChars = 300): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '模型调用失败'
  const text = redactSecrets(raw)
  return clipText(text || '模型调用失败', maxChars).text
}

/** 模型优先级：请求级 > agent.model / agent.director.model > 提示词文件（全局配置由 getModel 兜底） */
export function resolvePresetModel(input: {
  preset: 'assistant' | 'director'
  requestModel?: string
  settings?: Pick<AgentSettings, 'model' | 'director'>
  fileModel?: string
}): string | undefined {
  const requestModel = input.requestModel?.trim()
  if (requestModel) return requestModel
  const presetModel = (
    input.preset === 'director' ? input.settings?.director.model : input.settings?.model
  )?.trim()
  if (presetModel) return presetModel
  const fileModel = input.fileModel?.trim()
  return fileModel || undefined
}
