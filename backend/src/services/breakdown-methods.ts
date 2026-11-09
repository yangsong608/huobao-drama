/**
 * 分镜拆分方案服务：内置方案播种、自定义方案增删改查、按集解析注入块。
 *
 * 方案只提供「提示词 + Skill」两段增量文本；字段契约、ID 校验、分批保存等基础规范
 * 仍由 storyboard_breaker 的基础提示词与基础 Skill 负责，方案不得改动。
 */
import { and, asc, count, eq, isNotNull, isNull, max } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { logTaskWarn } from '../utils/task-logger.js'
import { DEFAULT_BREAKDOWN_METHODS } from './breakdown-method-defaults.js'

export type BreakdownMethodRow = typeof schema.breakdownMethods.$inferSelect
export type BreakdownMethodListItem = Pick<
  BreakdownMethodRow,
  'key' | 'name' | 'description' | 'builtin' | 'sortOrder'
> & {
  usageCount: number
  customized: boolean
}

export interface BreakdownMethodInput {
  name?: string
  description?: string
  prompt?: string
  skill?: string
}

const NAME_MAX = 60
const PROMPT_MAX = 20000
const SKILL_MAX = 40000

let seedPromise: Promise<void> | null = null

function normalizeName(value: unknown) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > NAME_MAX) {
    throw new Error(`方案名称不能为空，且不超过 ${NAME_MAX} 字`)
  }
  return name
}

function normalizeText(value: unknown, label: string, maxLength: number) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`方案${label}格式不正确`)
  if (value.length > maxLength) throw new Error(`方案${label}不能超过 ${maxLength} 字`)
  return value
}

function normalizeDescription(value: unknown) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value.trim() : ''
}

function nextSortOrder() {
  const row = db
    .select({ value: max(schema.breakdownMethods.sortOrder) })
    .from(schema.breakdownMethods)
    .get()
  return Number(row?.value ?? 0) + 10
}

function isCustomized(row: BreakdownMethodRow) {
  if (!row.builtin) return false
  const seed = DEFAULT_BREAKDOWN_METHODS.find(item => item.key === row.key)
  if (!seed) return false
  return (
    row.name !== seed.name ||
    row.description !== seed.description ||
    row.prompt !== seed.prompt ||
    row.skill !== seed.skill
  )
}

/** 启动时按 key 补齐内置方案；未编辑过的内置方案（createdAt === updatedAt）随版本升级文本，编辑过的行一律保留 */
export function ensureBreakdownMethodsSeeded(force = false): Promise<void> {
  const run = () => {
    const timestamp = now()
    db.transaction((tx) => {
      for (const seed of DEFAULT_BREAKDOWN_METHODS) {
        const existing = tx
          .select()
          .from(schema.breakdownMethods)
          .where(eq(schema.breakdownMethods.key, seed.key))
          .get()
        if (!existing) {
          tx.insert(schema.breakdownMethods).values({
            key: seed.key,
            name: seed.name,
            description: seed.description,
            prompt: seed.prompt,
            skill: seed.skill,
            builtin: 1,
            sortOrder: seed.sortOrder,
            createdAt: timestamp,
            updatedAt: timestamp,
          }).run()
          continue
        }
        const untouched = existing.builtin === 1 && existing.updatedAt === existing.createdAt
        const outdated = existing.name !== seed.name
          || existing.description !== seed.description
          || existing.prompt !== seed.prompt
          || existing.skill !== seed.skill
        if (!untouched || !outdated) continue
        tx.update(schema.breakdownMethods)
          .set({
            name: seed.name,
            description: seed.description,
            prompt: seed.prompt,
            skill: seed.skill,
            sortOrder: seed.sortOrder,
          })
          .where(eq(schema.breakdownMethods.key, seed.key))
          .run()
      }
    })
  }

  if (force) {
    seedPromise = Promise.resolve().then(run).catch((error) => {
      seedPromise = null
      throw error
    })
    return seedPromise
  }
  if (!seedPromise) {
    seedPromise = Promise.resolve().then(run).catch((error) => {
      seedPromise = null
      throw error
    })
  }
  return seedPromise
}

export function listBreakdownMethods(): BreakdownMethodListItem[] {
  const rows = db
    .select()
    .from(schema.breakdownMethods)
    .orderBy(asc(schema.breakdownMethods.sortOrder), asc(schema.breakdownMethods.id))
    .all()

  const usageRows = db
    .select({ key: schema.episodes.breakdownMethod, total: count() })
    .from(schema.episodes)
    .where(and(isNotNull(schema.episodes.breakdownMethod), isNull(schema.episodes.deletedAt)))
    .groupBy(schema.episodes.breakdownMethod)
    .all()
  const usage = new Map(usageRows.map(row => [row.key, Number(row.total)]))

  return rows.map(row => ({
    key: row.key,
    name: row.name,
    description: row.description,
    builtin: row.builtin,
    sortOrder: row.sortOrder,
    usageCount: usage.get(row.key) ?? 0,
    customized: isCustomized(row),
  }))
}

export function getBreakdownMethod(key: string): BreakdownMethodRow | null {
  if (!key) return null
  return db
    .select()
    .from(schema.breakdownMethods)
    .where(eq(schema.breakdownMethods.key, key))
    .get() ?? null
}

export interface EpisodeCoverage {
  episodeId: number
  scriptChars: number
  maxSegmentSeconds: number
  targetSeconds: number
  floor: number
  actual: number
  ok: boolean
}

/** 按剧本字数与方案单段上限计算段落数下限，用于判定本次拆分是否覆盖全剧 */
export function getEpisodeCoverage(episodeId?: number | null): EpisodeCoverage | null {
  if (!episodeId) return null
  const episode = db
    .select({
      id: schema.episodes.id,
      content: schema.episodes.content,
      scriptContent: schema.episodes.scriptContent,
      breakdownMethod: schema.episodes.breakdownMethod,
    })
    .from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId))
    .get()
  if (!episode) return null

  const script = (episode.scriptContent || episode.content || '').replace(/\s+/g, '')
  const scriptChars = [...script].length
  const seed = episode.breakdownMethod
    ? DEFAULT_BREAKDOWN_METHODS.find(item => item.key === episode.breakdownMethod)
    : null
  const maxSegmentSeconds = seed?.maxSegmentSeconds ?? 15
  const targetSeconds = Math.round(scriptChars * 0.12)
  const floor = targetSeconds > 0 ? Math.ceil((targetSeconds / maxSegmentSeconds) * 0.9) : 0
  const row = db
    .select({ total: count() })
    .from(schema.storyboards)
    .where(and(
      eq(schema.storyboards.episodeId, episodeId),
      isNull(schema.storyboards.deletedAt),
    ))
    .get()
  const actual = Number(row?.total ?? 0)

  return {
    episodeId,
    scriptChars,
    maxSegmentSeconds,
    targetSeconds,
    floor,
    actual,
    ok: actual >= floor,
  }
}

export function createBreakdownMethod(input: BreakdownMethodInput): BreakdownMethodRow {
  const name = normalizeName(input.name)
  const description = normalizeDescription(input.description)
  const prompt = normalizeText(input.prompt, '提示词', PROMPT_MAX)
  const skill = normalizeText(input.skill, 'Skill', SKILL_MAX)
  const timestamp = now()

  return db.insert(schema.breakdownMethods).values({
    key: `custom-${randomUUID()}`,
    name,
    description,
    prompt,
    skill,
    builtin: 0,
    sortOrder: nextSortOrder(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }).returning().get()
}

export function updateBreakdownMethod(key: string, input: BreakdownMethodInput): BreakdownMethodRow {
  const row = getBreakdownMethod(key)
  if (!row) throw new Error('方案不存在')

  const patch: Partial<BreakdownMethodRow> = { updatedAt: now() }
  if (input.name !== undefined) patch.name = normalizeName(input.name)
  if (input.description !== undefined) patch.description = normalizeDescription(input.description)
  if (input.prompt !== undefined) patch.prompt = normalizeText(input.prompt, '提示词', PROMPT_MAX)
  if (input.skill !== undefined) patch.skill = normalizeText(input.skill, 'Skill', SKILL_MAX)

  db.update(schema.breakdownMethods).set(patch).where(eq(schema.breakdownMethods.key, key)).run()
  return getBreakdownMethod(key)!
}

export function deleteBreakdownMethod(key: string): { releasedEpisodes: number } {
  const row = getBreakdownMethod(key)
  if (!row) throw new Error('方案不存在')
  if (row.builtin) throw new Error('内置方案不可删除')

  let releasedEpisodes = 0
  db.transaction((tx) => {
    const result = tx
      .update(schema.episodes)
      .set({ breakdownMethod: null, updatedAt: now() })
      .where(eq(schema.episodes.breakdownMethod, key))
      .run()
    releasedEpisodes = Number(result.changes ?? 0)
    tx.delete(schema.breakdownMethods).where(eq(schema.breakdownMethods.key, key)).run()
  })
  return { releasedEpisodes }
}

export function resetBreakdownMethod(key: string): BreakdownMethodRow {
  const row = getBreakdownMethod(key)
  if (!row) throw new Error('方案不存在')
  if (!row.builtin) throw new Error('仅内置方案可恢复默认')
  const seed = DEFAULT_BREAKDOWN_METHODS.find(item => item.key === key)
  if (!seed) throw new Error('内置方案默认内容缺失')

  db.update(schema.breakdownMethods).set({
    name: seed.name,
    description: seed.description,
    prompt: seed.prompt,
    skill: seed.skill,
    updatedAt: now(),
  }).where(eq(schema.breakdownMethods.key, key)).run()
  return getBreakdownMethod(key)!
}

export function duplicateBreakdownMethod(key: string): BreakdownMethodRow {
  const source = getBreakdownMethod(key)
  if (!source) throw new Error('方案不存在')

  const timestamp = now()
  return db.insert(schema.breakdownMethods).values({
    key: `custom-${randomUUID()}`,
    name: normalizeName(`${source.name} 副本`),
    description: source.description,
    prompt: source.prompt,
    skill: source.skill,
    builtin: 0,
    sortOrder: nextSortOrder(),
    createdAt: timestamp,
    updatedAt: timestamp,
  }).returning().get()
}

export function buildBreakdownMethodBlock(
  method: Pick<BreakdownMethodRow, 'name' | 'prompt' | 'skill'> | null,
): string | null {
  if (!method) return null
  const prompt = method.prompt.trim()
  const skill = method.skill.trim()
  if (!prompt && !skill) return null

  const sections = [
    `## 当前分镜拆分方案：${method.name}`,
    '本集已指定分镜拆分方案。以下要求与基础提示词或基础 Skill 冲突时，以本方案为准；字段、ID、分批保存与 shot_number 递增等基础规范不可改动。',
  ]
  if (prompt) sections.push(`### 方案提示词\n${prompt}`)
  if (skill) sections.push(`### 方案 Skill\n${skill}`)
  return sections.join('\n\n')
}

export function getEpisodeBreakdownBlock(episodeId?: number | null): string | null {
  if (!episodeId) return null
  try {
    const episode = db
      .select({ breakdownMethod: schema.episodes.breakdownMethod })
      .from(schema.episodes)
      .where(eq(schema.episodes.id, Number(episodeId)))
      .get()
    if (!episode?.breakdownMethod) return null

    const method = getBreakdownMethod(episode.breakdownMethod)
    if (!method) {
      logTaskWarn('BreakdownMethod', '剧集引用的拆分方案不存在，回退为标准规范', {
        episodeId,
        key: episode.breakdownMethod,
      })
      return null
    }
    return buildBreakdownMethodBlock(method)
  } catch (error) {
    logTaskWarn('BreakdownMethod', '读取剧集拆分方案失败，回退为标准规范', {
      episodeId,
      error: String(error),
    })
    return null
  }
}
