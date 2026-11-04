import {
  NovelPromptParamError,
  buildNovelArchitecture,
  chapterPrompts,
} from './prompts/index.js'

export interface BlueprintChapter {
  number: number
  title: string
  position: string
  purpose: string
  suspense: string
  foreshadowing: string
  twistLevel: string
  summary: string
  charactersInvolved?: string
  keyItems?: string
  sceneLocation?: string
  timeConstraint?: string
  narration?: string
}

export interface BlueprintBlock {
  number: number
  title: string
  text: string
}

const TITLE_PATTERN = /^[ \t]*第\s*(\d+)\s*章[ \t]*(?:[-–—:：][ \t]*)?(.*?)[ \t]*$/gm

const FIELD_ALIASES = {
  position: ['本章定位', '章节定位'],
  purpose: ['核心作用', '核心内容'],
  suspense: ['悬念密度', '情感强度', '情节张力'],
  foreshadowing: ['伏笔操作', '伏笔'],
  twistLevel: ['认知颠覆', '情节张力', '反转程度'],
  summary: ['本章简述', '本章概要'],
  charactersInvolved: ['核心人物', '主要人物'],
  keyItems: ['关键道具'],
  sceneLocation: ['场景地点', '场景'],
  timeConstraint: ['时间压力'],
  narration: ['旁白描述', '旁白说明', '旁白'],
} as const

function extractField(text: string, aliases: readonly string[]): string {
  for (const field of aliases) {
    const match = text.match(new RegExp(`${field}[：:]\\s*(.+?)(?=\\n|$)`))
    if (match) return match[1].trim()
  }
  return ''
}

export function splitChapterBlueprintBlocks(blueprint?: string | null): BlueprintBlock[] {
  if (!blueprint) return []

  const headings: { number: number; title: string; start: number }[] = []
  TITLE_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TITLE_PATTERN.exec(blueprint)) !== null) {
    headings.push({ number: Number(match[1]), title: match[2].trim(), start: match.index })
  }

  return headings.map((heading, index) => ({
    number: heading.number,
    title: heading.title,
    text: blueprint.slice(heading.start, index + 1 < headings.length ? headings[index + 1].start : blueprint.length),
  }))
}

export function parseChapterBlueprint(blueprint?: string | null): BlueprintChapter[] {
  if (!blueprint) return []

  const chapters: BlueprintChapter[] = []
  const seen = new Set<number>()
  for (const block of splitChapterBlueprintBlocks(blueprint)) {
    if (seen.has(block.number)) continue
    seen.add(block.number)
    const chapter: BlueprintChapter = {
      number: block.number,
      title: block.title,
      position: extractField(block.text, FIELD_ALIASES.position),
      purpose: extractField(block.text, FIELD_ALIASES.purpose),
      suspense: extractField(block.text, FIELD_ALIASES.suspense),
      foreshadowing: extractField(block.text, FIELD_ALIASES.foreshadowing),
      twistLevel: extractField(block.text, FIELD_ALIASES.twistLevel),
      summary: extractField(block.text, FIELD_ALIASES.summary),
    }
    for (const field of ['charactersInvolved', 'keyItems', 'sceneLocation', 'timeConstraint', 'narration'] as const) {
      const value = extractField(block.text, FIELD_ALIASES[field])
      if (value) chapter[field] = value
    }
    chapters.push(chapter)
  }

  return chapters
}

export interface BlueprintGenerationProject {
  topic?: unknown
  genre?: unknown
  background?: unknown
  writingStyle?: unknown
  numberOfChapters: unknown
  wordNumber: unknown
  userGuidance?: unknown
  coreSeed?: unknown
  characterDynamics?: unknown
  worldBuilding?: unknown
  plotArchitecture?: unknown
  chapterBlueprint?: unknown
  narrativePerson?: unknown
}

export interface BlueprintRequestMeta {
  startChapter: number
  endChapter: number
  index: number
}

export interface BlueprintProgress {
  current: number
  total: number
  message: string
}

export interface BlueprintChunkState {
  chapterBlueprint: string
  chapters: BlueprintChapter[]
  startChapter: number
  endChapter: number
}

export interface BlueprintGenerationOptions {
  project: BlueprintGenerationProject
  generate: (prompt: string, meta: BlueprintRequestMeta) => Promise<string>
  maxTokens?: number
  contextChapterLimit?: number
  onProgress?: (progress: BlueprintProgress) => void
  onChunk?: (state: BlueprintChunkState) => void | Promise<void>
  shouldCancel?: () => boolean
}

export interface BlueprintGenerationResult {
  chapterBlueprint: string
  chapters: BlueprintChapter[]
  requests: number
  cancelled: boolean
}

function positiveInt(value: unknown, field: string): number {
  const parsed = Math.round(Number(value))
  if (!Number.isFinite(parsed) || parsed < 1) throw new NovelPromptParamError(`${field} 必须是正整数`)
  return parsed
}

export function resolveBlueprintChunkSize(maxTokens: unknown, numberOfChapters: number): number {
  const tokens = Number(maxTokens)
  const usableTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 8192
  const chapters = Math.max(1, Math.round(numberOfChapters))
  const chunkSize = Math.floor(usableTokens / 200 / 10) * 10 - 10
  return Math.max(1, Math.min(chunkSize, chapters))
}

export function limitChapterBlueprint(blueprint: string, limit: number): string {
  if (!blueprint) return ''
  const blocks = splitChapterBlueprintBlocks(blueprint)
  if (blocks.length <= limit) return blueprint
  return blocks.slice(-limit).map((block) => block.text.trim()).join('\n\n')
}

function mergeChapterChunk(
  chunkText: string,
  startChapter: number,
  endChapter: number,
  existingNumbers: Set<number>,
): string {
  const seen = new Set<number>()
  return splitChapterBlueprintBlocks(chunkText)
    .filter((block) => block.number >= startChapter && block.number <= endChapter)
    .sort((a, b) => a.number - b.number)
    .filter((block) => {
      if (existingNumbers.has(block.number) || seen.has(block.number)) return false
      seen.add(block.number)
      return true
    })
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

export async function generateChapterBlueprint(
  options: BlueprintGenerationOptions,
): Promise<BlueprintGenerationResult> {
  const { project } = options
  const total = positiveInt(project.numberOfChapters, 'numberOfChapters')
  const architecture = buildNovelArchitecture({ ...project, numberOfChapters: total })
  const existingBlueprint = typeof project.chapterBlueprint === 'string' ? project.chapterBlueprint.trim() : ''

  let blueprint = existingBlueprint
  let requests = 0
  let cancelled = false
  const existing = parseChapterBlueprint(blueprint)
  let currentStart = existing.reduce((max, chapter) => Math.max(max, chapter.number), 0) + 1

  const chunkSize = resolveBlueprintChunkSize(options.maxTokens, total)
  const contextChapterLimit = options.contextChapterLimit ?? 100

  const emitChunk = async (startChapter: number, endChapter: number) => {
    await options.onChunk?.({
      chapterBlueprint: blueprint,
      chapters: parseChapterBlueprint(blueprint),
      startChapter,
      endChapter,
    })
  }

  if (currentStart <= total) {
    if (!blueprint && chunkSize >= total) {
      options.onProgress?.({ current: 0, total, message: `正在生成章节大纲 (1-${total})...` })
      if (options.shouldCancel?.()) {
        return { chapterBlueprint: blueprint, chapters: parseChapterBlueprint(blueprint), requests, cancelled: true }
      }
      const prompt = chapterPrompts.blueprint({
        userGuidance: project.userGuidance,
        novelArchitecture: architecture,
        numberOfChapters: total,
        narrativePerson: project.narrativePerson,
      })
      const chunk = await options.generate(prompt, { startChapter: 1, endChapter: total, index: requests })
      requests += 1
      const merged = mergeChapterChunk(chunk, 1, total, new Set())
      if (merged) blueprint = merged
      await emitChunk(1, total)
      options.onProgress?.({ current: total, total, message: '章节大纲生成完成!' })
    } else {
      while (currentStart <= total) {
        if (options.shouldCancel?.()) {
          cancelled = true
          break
        }
        const currentEnd = Math.min(currentStart + chunkSize - 1, total)
        const prompt = chapterPrompts.blueprintChunked({
          userGuidance: project.userGuidance,
          novelArchitecture: architecture,
          numberOfChapters: total,
          chapterList: limitChapterBlueprint(blueprint, contextChapterLimit),
          startChapter: currentStart,
          endChapter: currentEnd,
          narrativePerson: project.narrativePerson,
        })
        const chunk = await options.generate(prompt, {
          startChapter: currentStart,
          endChapter: currentEnd,
          index: requests,
        })
        requests += 1
        const existingNumbers = new Set(parseChapterBlueprint(blueprint).map((chapter) => chapter.number))
        const merged = mergeChapterChunk(chunk, currentStart, currentEnd, existingNumbers)
        if (merged) blueprint = blueprint ? `${blueprint}\n\n${merged}` : merged
        await emitChunk(currentStart, currentEnd)
        options.onProgress?.({
          current: currentEnd,
          total,
          message: `章节大纲已生成 (${currentStart}-${currentEnd})`,
        })
        currentStart = currentEnd + 1
      }
      if (!cancelled && currentStart > total) {
        options.onProgress?.({ current: total, total, message: '章节大纲生成完成!' })
      }
    }
  }

  return {
    chapterBlueprint: blueprint,
    chapters: parseChapterBlueprint(blueprint),
    requests,
    cancelled,
  }
}

export function normalizeNarration(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 500) : ''
}

export function updateChapterNarration(
  blueprint: string | null | undefined,
  chapterNo: number,
  narration: string,
): string | null {
  const text = blueprint || ''
  const block = splitChapterBlueprintBlocks(text).find((item) => item.number === chapterNo)
  if (!block) return null
  const clean = normalizeNarration(narration)
  const lines = block.text
    .split('\n')
    .filter((line) => !/^\s*旁白(?:描述|说明)?\s*[：:]/.test(line))
  if (clean) {
    const anchor = lines.findIndex((line) => /^\s*本章简述\s*[：:]/.test(line))
    const narrationLine = `旁白描述：${clean}`
    if (anchor >= 0) lines.splice(anchor + 1, 0, narrationLine)
    else if (lines.length && !lines[lines.length - 1].trim()) lines.splice(lines.length - 1, 0, narrationLine)
    else lines.push(narrationLine)
  }
  const start = text.indexOf(block.text)
  return `${text.slice(0, start)}${lines.join('\n')}${text.slice(start + block.text.length)}`
}
