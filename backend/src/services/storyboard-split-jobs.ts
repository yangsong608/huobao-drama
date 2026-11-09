/**
 * 分镜分块拆分任务
 *
 * 背景：整集拆分曾是一条几百秒的同步请求，模型长调用一旦网络失败/超时，
 * 前面生成的内容全部丢失（save_storyboards 尚未被调用时零产出）。
 * 这里把剧本按场次切成小块，每块单独调用 Agent 并立即保存：
 * - 已完成块持久化，失败/应用重启后可从未完成块继续；
 * - 每块有独立超时窗口，长剧本不会压在一次请求上；
 * - 镜头号由系统跨块连续分配，块间不会撞号覆盖。
 */
import { desc, eq, inArray } from 'drizzle-orm'
import type { RequestContext } from '@mastra/core/request-context'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import {
  getEpisodeCoverage,
  getMaxSegmentSeconds,
  type EpisodeCoverage,
} from './breakdown-methods.js'
import { logTaskError, logTaskProgress, logTaskSuccess, logTaskWarn } from '../utils/task-logger.js'
import { buildAgentRequestContext, type AgentRequestContextValues } from '../agents/context.js'

export const SPLIT_CHUNK_BUDGET = 1200

export type StoryboardSplitJobStatus = 'pending' | 'running' | 'done' | 'failed' | 'interrupted'
export type StoryboardSplitChunkStatus = 'pending' | 'running' | 'done' | 'failed'

export interface StoryboardSplitChunk {
  index: number
  label: string
  script: string
  status: StoryboardSplitChunkStatus
  shots: number
  error?: string
  /** 首段是否已经执行过替换（旧分镜已清空）；续拆时据此清理上次半截写入 */
  replaced?: boolean
  startedAt?: string
  finishedAt?: string
}

export type StoryboardSplitJobRow = typeof schema.storyboardSplitJobs.$inferSelect

export interface StoryboardSplitChunkView {
  index: number
  label: string
  status: StoryboardSplitChunkStatus
  shots: number
  error: string | null
}

export interface StoryboardSplitJobView {
  id: number
  episode_id: number
  drama_id: number
  status: StoryboardSplitJobStatus
  total_chunks: number
  completed_chunks: number
  shot_count: number
  error: string | null
  chunks: StoryboardSplitChunkView[]
  coverage: EpisodeCoverage | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

export interface StoryboardSplitJobInput {
  episodeId: number
  dramaId: number
  message: string
  model?: string
  configId?: number
  budgetChars?: number
}

export interface SplitChunkRunnerInput {
  jobId: number
  episodeId: number
  dramaId: number
  chunk: StoryboardSplitChunk
  totalChunks: number
  shotStart: number
  previousSummary: string
  baseMessage: string
  maxSegmentSeconds: number
  requestContext: RequestContext<AgentRequestContextValues>
}

export type SplitChunkRunner = (input: SplitChunkRunnerInput) => Promise<void>

const runningJobs = new Set<number>()

function nonWsLength(value: string) {
  return value.replace(/\s+/g, '').length
}

function isSceneHeader(line: string) {
  return /^#{1,4}\s*(?:S\s*\d+|第\s*\d+\s*场|场景\s*[0-9一二三四五六七八九十百]+)/i.test(line.trim())
}

function sceneLabel(header: string) {
  const sMatch = header.match(/\bS\s*0*(\d+)\b/i)
  if (sMatch) return `S${String(sMatch[1]).padStart(2, '0')}`
  const cnMatch = header.match(/第\s*(\d+)\s*场/)
  if (cnMatch) return `第${cnMatch[1]}场`
  return header.replace(/^#+\s*/, '').split(/[|｜]/)[0].trim().slice(0, 20) || '场次'
}

function rangeLabel(labels: string[]) {
  const sceneLabels = labels.filter(label => label && label !== '开头')
  if (!sceneLabels.length) return ''
  if (sceneLabels.length === 1) return sceneLabels[0]
  const first = sceneLabels[0]
  const last = sceneLabels[sceneLabels.length - 1]
  return first === last ? first : `${first}–${last}`
}

/** 按段落的非空白字数硬切；只丢弃空白，不丢任何正文/台词字符 */
function splitOversizedText(text: string, budget: number): string[] {
  const paragraphs = text.split(/\n{2,}/)
  const parts: string[] = []
  let current = ''

  const flush = () => {
    if (current.trim()) parts.push(current.trim())
    current = ''
  }

  for (const paragraph of paragraphs) {
    if (nonWsLength(paragraph) > budget) {
      flush()
      let buffer = ''
      let count = 0
      for (const char of paragraph) {
        buffer += char
        if (!/\s/.test(char)) count += 1
        if (count >= budget) {
          parts.push(buffer)
          buffer = ''
          count = 0
        }
      }
      if (buffer.trim()) parts.push(buffer)
      continue
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph
    if (nonWsLength(candidate) <= budget) {
      current = candidate
    } else {
      flush()
      current = paragraph
    }
  }
  flush()
  return parts
}

interface ScriptUnit {
  text: string
  label: string
  chars: number
  header?: string
  body?: string
}

function splitSections(script: string): { units: ScriptUnit[]; hasSceneHeaders: boolean } {
  const lines = script.split('\n')
  const headerIndexes: number[] = []
  lines.forEach((line, index) => {
    if (isSceneHeader(line)) headerIndexes.push(index)
  })
  if (!headerIndexes.length) return { units: [], hasSceneHeaders: false }

  const units: ScriptUnit[] = []
  const preamble = lines.slice(0, headerIndexes[0]).join('\n').trim()
  if (preamble) {
    units.push({ text: preamble, label: '开头', chars: nonWsLength(preamble) })
  }

  headerIndexes.forEach((start, index) => {
    const end = index + 1 < headerIndexes.length ? headerIndexes[index + 1] : lines.length
    const block = lines.slice(start, end).join('\n').trim()
    if (!block) return
    const [header, ...rest] = block.split('\n')
    const label = sceneLabel(header)
    const body = rest.join('\n').trim()
    const text = body ? `${header}\n\n${body}` : header
    units.push({ text, label, chars: nonWsLength(text), header, body })
  })
  return { units, hasSceneHeaders: true }
}

/**
 * 把整集剧本切成 1200 字左右的块：优先按场次边界切；单场超长时按段落切。
 * 返回值只含原文，不插入说明文字，所有块拼起来能还原剧本全部非空白字符。
 */
export function splitScriptIntoChunks(script: string, budgetChars = SPLIT_CHUNK_BUDGET): Array<{ label: string; script: string }> {
  const normalized = String(script || '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const budget = Math.max(400, Math.floor(budgetChars || SPLIT_CHUNK_BUDGET))

  const { units, hasSceneHeaders } = splitSections(normalized)
  if (!hasSceneHeaders) {
    const parts = splitOversizedText(normalized, budget)
    return parts.map((text, index) => ({ label: `片段 ${index + 1}/${parts.length}`, script: text }))
  }

  // 超长单元单独切分，保持原顺序；场景头只跟随第一片，其余片按剩余预算切正文
  const expanded: ScriptUnit[] = []
  for (const unit of units) {
    if (unit.chars <= budget) {
      expanded.push(unit)
      continue
    }
    if (!unit.header || !unit.body) {
      for (const part of splitOversizedText(unit.text, budget)) {
        expanded.push({ text: part, label: unit.label, chars: nonWsLength(part) })
      }
      continue
    }
    const headerChars = nonWsLength(unit.header)
    const bodyBudget = Math.max(200, budget - headerChars)
    const parts = splitOversizedText(unit.body, bodyBudget)
    parts.forEach((part, index) => {
      const text = index === 0 ? `${unit.header}\n\n${part}` : part
      expanded.push({ text, label: unit.label, chars: nonWsLength(text) })
    })
  }

  const chunks: Array<{ label: string; script: string }> = []
  let currentTexts: string[] = []
  let currentLabels: string[] = []
  let currentChars = 0

  const flush = () => {
    if (!currentTexts.length) return
    chunks.push({
      label: rangeLabel(currentLabels) || `第 ${chunks.length + 1} 段`,
      script: currentTexts.join('\n\n'),
    })
    currentTexts = []
    currentLabels = []
    currentChars = 0
  }

  for (const unit of expanded) {
    if (currentTexts.length && currentChars + unit.chars > budget) flush()
    currentTexts.push(unit.text)
    currentLabels.push(unit.label)
    currentChars += unit.chars
  }
  flush()

  // 场次很少时最后一块可能极小：并回上一块，减少一次模型调用（但不允许因此超预算）
  if (chunks.length > 1) {
    const tail = chunks[chunks.length - 1]
    const tailChars = nonWsLength(tail.script)
    const prevChars = nonWsLength(chunks[chunks.length - 2].script)
    if (tailChars < Math.min(200, budget / 4) && prevChars + tailChars <= budget) {
      chunks.pop()
      chunks[chunks.length - 1].script += `\n\n${tail.script}`
      chunks[chunks.length - 1].label = rangeLabel([chunks[chunks.length - 1].label, tail.label])
        || chunks[chunks.length - 1].label
    }
  }
  return chunks
}

function parseChunks(row: StoryboardSplitJobRow): StoryboardSplitChunk[] {
  try {
    const parsed = JSON.parse(row.chunks || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((chunk: any, index: number) => ({
      index: typeof chunk.index === 'number' ? chunk.index : index,
      label: String(chunk.label || `第 ${index + 1} 段`),
      script: String(chunk.script || ''),
      status: ['pending', 'running', 'done', 'failed'].includes(chunk.status) ? chunk.status : 'pending',
      shots: Number(chunk.shots || 0),
      error: chunk.error ? String(chunk.error) : undefined,
      replaced: chunk.replaced === true,
      startedAt: chunk.startedAt ? String(chunk.startedAt) : undefined,
      finishedAt: chunk.finishedAt ? String(chunk.finishedAt) : undefined,
    }))
  } catch {
    return []
  }
}

function toView(row: StoryboardSplitJobRow): StoryboardSplitJobView {
  const chunks = parseChunks(row)
  return {
    id: row.id,
    episode_id: row.episodeId,
    drama_id: row.dramaId,
    status: (row.status || 'pending') as StoryboardSplitJobStatus,
    total_chunks: row.totalChunks || chunks.length,
    completed_chunks: row.completedChunks || 0,
    shot_count: row.shotCount || 0,
    error: row.errorMsg || null,
    chunks: chunks.map(chunk => ({
      index: chunk.index,
      label: chunk.label,
      status: chunk.status,
      shots: chunk.shots,
      error: chunk.error || null,
    })),
    coverage: getEpisodeCoverage(row.episodeId),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    finished_at: row.finishedAt || null,
  }
}

function getJobRow(jobId: number) {
  return db.select().from(schema.storyboardSplitJobs)
    .where(eq(schema.storyboardSplitJobs.id, jobId))
    .get()
}

function getLatestRow(episodeId: number, statuses?: string[]) {
  const rows = db.select().from(schema.storyboardSplitJobs)
    .where(eq(schema.storyboardSplitJobs.episodeId, episodeId))
    .orderBy(desc(schema.storyboardSplitJobs.id))
    .all()
  return statuses?.length ? rows.find(row => statuses.includes(row.status || '')) : rows[0]
}

function liveStoryboards(episodeId: number) {
  return db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .all()
    .filter(row => !row.deletedAt)
}

function doneChunkCount(chunks: StoryboardSplitChunk[]) {
  return chunks.filter(chunk => chunk.status === 'done').length
}

/** 本块镜头起点 = 已完成前序块镜头数 + 1；不能按当前最大镜头号推算，否则续拆会跳过失败块的半截行 */
function chunkShotStart(chunks: StoryboardSplitChunk[], chunk: StoryboardSplitChunk) {
  return 1 + chunks
    .filter(item => item.index < chunk.index && item.status === 'done')
    .reduce((sum, item) => sum + (item.shots || 0), 0)
}

function deleteLinksFor(storyboardId: number) {
  db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .run()
  db.delete(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))
    .run()
}

/** 续拆/重试当前块前回滚该块半截写入的行（只可能是最后一块，镜头号 >= 本块起点） */
function rollbackChunkRows(episodeId: number, shotStart: number) {
  const rows = liveStoryboards(episodeId).filter(row => row.storyboardNumber >= shotStart)
  for (const row of rows) {
    deleteLinksFor(row.id)
    db.delete(schema.storyboards).where(eq(schema.storyboards.id, row.id)).run()
  }
  return rows.length
}

function buildPreviousSummary(episodeId: number, shotStart: number) {
  return liveStoryboards(episodeId)
    .filter(row => row.storyboardNumber < shotStart)
    .sort((a, b) => b.storyboardNumber - a.storyboardNumber)
    .slice(0, 2)
    .reverse()
    .map(row => `#${row.storyboardNumber} ${row.title || ''}：${String(row.description || '').replace(/\s+/g, ' ').slice(0, 100)}`)
    .join('\n')
}

function persistChunks(
  jobId: number,
  chunks: StoryboardSplitChunk[],
  patch: {
    status?: StoryboardSplitJobStatus
    completedChunks: number
    shotCount: number
    errorMsg?: string | null
    finishedAt?: string | null
  },
) {
  db.update(schema.storyboardSplitJobs).set({
    chunks: JSON.stringify(chunks),
    completedChunks: patch.completedChunks,
    shotCount: patch.shotCount,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.errorMsg !== undefined ? { errorMsg: patch.errorMsg } : {}),
    ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
    updatedAt: now(),
  }).where(eq(schema.storyboardSplitJobs.id, jobId)).run()
}

export function buildChunkMessage(input: SplitChunkRunnerInput): string {
  const chunkChars = nonWsLength(input.chunk.script)
  const chunkFloor = chunkChars > 0
    ? Math.ceil((chunkChars * 0.12 / input.maxSegmentSeconds) * 0.9)
    : 0
  const lines = [
    input.baseMessage.trim(),
    '',
    `## 本次为分段拆分（第 ${input.chunk.index + 1}/${input.totalChunks} 段）`,
    `整集剧本已按场次切成 ${input.totalChunks} 段，逐段调用并即时保存，避免单次请求过长。`,
    `- 本段范围：${input.chunk.label}，约 ${chunkChars} 字`,
    `- 只拆分下面给出的剧本片段，不要拆分或改写其它场次；read_storyboard_context 在本模式下也只返回本段。`,
    `- 本段段落数下限：${chunkFloor} 段（按 0.12 秒/字、单段最长 ${input.maxSegmentSeconds} 秒、90% 折算）。`,
    `- 直接调用 save_storyboards 保存本段全部分镜；shot_number 由系统跨段统一连续编号，按剧情顺序填写即可。`,
    `- 不要传 replace_existing：旧分镜与跨段编号由系统处理。`,
    `- 本段必须覆盖片段内全部场次、台词与关键动作，不得删场、并场。`,
  ]
  if (input.previousSummary) {
    lines.push(
      '',
      '### 上一段衔接',
      input.previousSummary,
      '本段第一镜的 continuity 必须承接上一段尾镜的尾动作、视线与站位。',
    )
  }
  lines.push('', `### 本段剧本片段（${input.chunk.label}）`, input.chunk.script)
  return lines.join('\n')
}

function buildRequestContext(row: StoryboardSplitJobRow, chunk: StoryboardSplitChunk, shotStart: number, totalChunks: number) {
  return buildAgentRequestContext({
    episodeId: row.episodeId,
    dramaId: row.dramaId,
    modelOverride: row.model || undefined,
    textConfigId: row.configId || undefined,
    storyboardChunkScript: chunk.script,
    storyboardChunkIndex: chunk.index,
    storyboardChunkTotal: totalChunks,
    storyboardChunkLabel: chunk.label,
    storyboardChunkShotStart: shotStart,
    storyboardChunkState: { replaced: false, nextShot: shotStart },
  })
}

async function defaultSplitChunkRunner(input: SplitChunkRunnerInput) {
  const { mastra } = await import('../mastra/index.js')
  const agent = mastra.getAgent('storyboard_breaker')
  if (!agent) throw new Error('拆分 Agent 不可用')
  await agent.generate(
    [{ role: 'user', content: buildChunkMessage(input) }],
    { maxSteps: 20, requestContext: input.requestContext },
  )
}

export function getStoryboardSplitJob(jobId: number): StoryboardSplitJobView | null {
  if (!Number.isFinite(jobId) || jobId <= 0) return null
  const row = getJobRow(jobId)
  return row ? toView(row) : null
}

export function getLatestStoryboardSplitJob(episodeId: number): StoryboardSplitJobView | null {
  if (!Number.isFinite(episodeId) || episodeId <= 0) return null
  const row = getLatestRow(episodeId)
  return row ? toView(row) : null
}

export async function createStoryboardSplitJob(
  input: StoryboardSplitJobInput,
  options: { autorun?: boolean } = {},
): Promise<{ job: StoryboardSplitJobView; alreadyRunning: boolean }> {
  const episodeId = Number(input.episodeId)
  const dramaId = Number(input.dramaId)
  if (!episodeId || !dramaId) throw new Error('需要 drama_id 与 episode_id')

  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId))
    .get()
  if (!episode || episode.deletedAt) throw new Error('剧集不存在')
  if (episode.dramaId !== dramaId) throw new Error('剧集不属于当前项目')

  const script = String(episode.scriptContent || episode.content || '').trim()
  if (!script) throw new Error('该集还没有剧本，无法拆分分镜')

  const active = getLatestRow(episodeId, ['pending', 'running'])
  if (active) {
    return { job: toView(active), alreadyRunning: true }
  }

  const parts = splitScriptIntoChunks(script, input.budgetChars)
  if (!parts.length) throw new Error('剧本为空，无法拆分分镜')

  const chunks: StoryboardSplitChunk[] = parts.map((part, index) => ({
    index,
    label: part.label,
    script: part.script,
    status: 'pending',
    shots: 0,
  }))
  const ts = now()
  const row = db.insert(schema.storyboardSplitJobs).values({
    episodeId,
    dramaId,
    status: 'pending',
    message: String(input.message || '').trim() || '请基于当前集剧本拆分分镜',
    model: input.model || null,
    configId: input.configId || null,
    chunks: JSON.stringify(chunks),
    totalChunks: chunks.length,
    completedChunks: 0,
    shotCount: liveStoryboards(episodeId).length,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()

  logTaskProgress('StoryboardSplit', 'created', {
    jobId: row.id,
    episodeId,
    chunks: chunks.length,
    scriptChars: nonWsLength(script),
  })

  if (options.autorun !== false) {
    void runStoryboardSplitJob(row.id).catch(error => {
      logTaskError('StoryboardSplit', 'run-crashed', {
        jobId: row.id,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  return { job: toView(row), alreadyRunning: false }
}

export async function resumeStoryboardSplitJob(
  jobId: number,
  options: { autorun?: boolean; runner?: SplitChunkRunner } = {},
): Promise<StoryboardSplitJobView> {
  const row = getJobRow(jobId)
  if (!row) throw new Error('拆分任务不存在')
  if (row.status === 'done') return toView(row)
  if (runningJobs.has(jobId)) return toView(row)

  const chunks = parseChunks(row)
  if (!chunks.length) throw new Error('拆分任务没有可继续的分段')
  for (const chunk of chunks) {
    if (chunk.status === 'running' || chunk.status === 'failed') {
      chunk.status = 'pending'
      chunk.error = undefined
      chunk.startedAt = undefined
      chunk.finishedAt = undefined
      chunk.shots = 0
    }
  }
  persistChunks(jobId, chunks, {
    status: 'pending',
    completedChunks: doneChunkCount(chunks),
    shotCount: liveStoryboards(row.episodeId).length,
    errorMsg: null,
    finishedAt: null,
  })

  logTaskProgress('StoryboardSplit', 'resume', {
    jobId,
    episodeId: row.episodeId,
    remaining: chunks.length - doneChunkCount(chunks),
  })
  if (options.autorun !== false) {
    void runStoryboardSplitJob(jobId, options.runner).catch(error => {
      logTaskError('StoryboardSplit', 'run-crashed', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
  return toView(getJobRow(jobId)!)
}

export async function runStoryboardSplitJob(
  jobId: number,
  runner: SplitChunkRunner = defaultSplitChunkRunner,
): Promise<void> {
  if (runningJobs.has(jobId)) return
  runningJobs.add(jobId)
  try {
    const row = getJobRow(jobId)
    if (!row) return
    if (row.status === 'done') return

    const episode = db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, row.episodeId))
      .get()
    const maxSegmentSeconds = getMaxSegmentSeconds(episode?.breakdownMethod)
    const chunks = parseChunks(row)
    persistChunks(jobId, chunks, {
      status: 'running',
      completedChunks: doneChunkCount(chunks),
      shotCount: liveStoryboards(row.episodeId).length,
      errorMsg: null,
    })

    for (const chunk of chunks) {
      if (chunk.status === 'done') continue
      chunk.status = 'running'
      chunk.startedAt = now()
      chunk.finishedAt = undefined
      chunk.error = undefined
      chunk.shots = 0
      persistChunks(jobId, chunks, {
        status: 'running',
        completedChunks: doneChunkCount(chunks),
        shotCount: liveStoryboards(row.episodeId).length,
        errorMsg: null,
      })

      const shotStart = chunk.index === 0 ? 1 : chunkShotStart(chunks, chunk)
      // 首段上次已替换过（旧分镜已清空）则整集只剩本任务的半截行；其余块回滚本块起点之后的行
      if (chunk.replaced) {
        const rolledBack = rollbackChunkRows(row.episodeId, 1)
        if (rolledBack > 0) {
          logTaskProgress('StoryboardSplit', 'rollback-partial', {
            jobId,
            chunk: chunk.index + 1,
            rows: rolledBack,
          })
        }
      } else if (chunk.index > 0) {
        const rolledBack = rollbackChunkRows(row.episodeId, shotStart)
        if (rolledBack > 0) {
          logTaskProgress('StoryboardSplit', 'rollback-partial', {
            jobId,
            chunk: chunk.index + 1,
            rows: rolledBack,
          })
        }
      }
      const beforeIds = new Set(liveStoryboards(row.episodeId).map(item => item.id))
      const requestContext = buildRequestContext(row, chunk, shotStart, chunks.length)
      const runnerInput: SplitChunkRunnerInput = {
        jobId,
        episodeId: row.episodeId,
        dramaId: row.dramaId,
        chunk,
        totalChunks: chunks.length,
        shotStart,
        previousSummary: buildPreviousSummary(row.episodeId, shotStart),
        baseMessage: row.message,
        maxSegmentSeconds,
        requestContext,
      }

      logTaskProgress('StoryboardSplit', 'chunk-start', {
        jobId,
        episodeId: row.episodeId,
        chunk: `${chunk.index + 1}/${chunks.length}`,
        label: chunk.label,
        shotStart,
        chars: nonWsLength(chunk.script),
      })

      try {
        await runner(runnerInput)
        const chunkState = requestContext.get('storyboardChunkState' as never) as { replaced: boolean; nextShot: number } | undefined
        if (chunkState?.replaced) chunk.replaced = true
        // 只统计本块新写入的行：首段旧分镜还在时，不能把旧行算成本块产出
        const shots = liveStoryboards(row.episodeId).filter(item => !beforeIds.has(item.id)).length
        if (shots <= 0) {
          throw new Error('本段没有保存任何分镜（模型可能只回复了文字）')
        }
        chunk.status = 'done'
        chunk.shots = shots
        chunk.finishedAt = now()
        const completed = doneChunkCount(chunks)
        persistChunks(jobId, chunks, {
          status: 'running',
          completedChunks: completed,
          shotCount: liveStoryboards(row.episodeId).length,
          errorMsg: null,
        })
        logTaskSuccess('StoryboardSplit', 'chunk-done', {
          jobId,
          chunk: `${chunk.index + 1}/${chunks.length}`,
          shots,
          completed,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const chunkState = requestContext.get('storyboardChunkState' as never) as { replaced: boolean; nextShot: number } | undefined
        if (chunkState?.replaced) chunk.replaced = true
        chunk.status = 'failed'
        chunk.error = message
        chunk.finishedAt = now()
        chunk.shots = liveStoryboards(row.episodeId).filter(item => !beforeIds.has(item.id)).length
        persistChunks(jobId, chunks, {
          status: 'failed',
          completedChunks: doneChunkCount(chunks),
          shotCount: liveStoryboards(row.episodeId).length,
          errorMsg: `第 ${chunk.index + 1}/${chunks.length} 段拆分失败：${message}`,
        })
        logTaskError('StoryboardSplit', 'chunk-failed', {
          jobId,
          chunk: `${chunk.index + 1}/${chunks.length}`,
          error: message,
        })
        return
      }
    }

    const liveCount = liveStoryboards(row.episodeId).length
    db.update(schema.storyboardSplitJobs).set({
      status: 'done',
      completedChunks: chunks.length,
      shotCount: liveCount,
      errorMsg: null,
      finishedAt: now(),
      updatedAt: now(),
    }).where(eq(schema.storyboardSplitJobs.id, jobId)).run()

    const coverage = getEpisodeCoverage(row.episodeId)
    logTaskSuccess('StoryboardSplit', 'done', {
      jobId,
      episodeId: row.episodeId,
      chunks: chunks.length,
      shots: liveCount,
      coverageFloor: coverage?.floor,
      coverageActual: coverage?.actual,
    })
    if (coverage && !coverage.ok) {
      logTaskWarn('StoryboardSplit', 'coverage-shortfall', {
        jobId,
        episodeId: row.episodeId,
        actual: coverage.actual,
        floor: coverage.floor,
      })
    }
  } catch (error) {
    // 非分段内的意外错误（DB/恢复逻辑）也要落库失败，不能让任务永远停在 running
    const message = error instanceof Error ? error.message : String(error)
    const latest = getJobRow(jobId)
    if (latest && latest.status !== 'done') {
      db.update(schema.storyboardSplitJobs).set({
        status: 'failed',
        errorMsg: `拆分任务异常终止：${message}`,
        updatedAt: now(),
      }).where(eq(schema.storyboardSplitJobs.id, jobId)).run()
    }
    logTaskError('StoryboardSplit', 'job-crashed', { jobId, error: message })
  } finally {
    runningJobs.delete(jobId)
  }
}

/** 启动恢复：上次进程退出时未完成的拆分任务标记为中断，等用户点「继续拆分剩余场次」 */
export function markInterruptedStoryboardSplits(): number {
  const result = db.update(schema.storyboardSplitJobs).set({
    status: 'interrupted',
    errorMsg: '应用退出导致拆分中断，可继续拆分剩余场次',
    updatedAt: now(),
  }).where(inArray(schema.storyboardSplitJobs.status, ['pending', 'running'])).run()
  return Number(result.changes || 0)
}
