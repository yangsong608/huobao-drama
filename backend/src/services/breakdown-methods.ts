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

/** 当前方案的单段最长秒数；空值/自定义缺失按标准方案 15 秒 */
export function getMaxSegmentSeconds(breakdownMethod?: string | null): number {
  const seed = breakdownMethod
    ? DEFAULT_BREAKDOWN_METHODS.find(item => item.key === breakdownMethod)
    : null
  return seed?.maxSegmentSeconds ?? 15
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
  const maxSegmentSeconds = getMaxSegmentSeconds(episode.breakdownMethod)
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

/** 平台硬约束：方案只能追加风格，不能覆盖 description / video_prompt 的统一格式 */
const PLATFORM_VIDEO_PROMPT_RULES = [
  '### 平台硬约束（任何方案不得覆盖）',
  '以下规则优先于本方案和基础提示词中的任何相反描述；旧方案里的「段落/子镜头/2-4 个子镜头」一律按本硬约束改写。',
  '- 拆分单位：一个分镜 = 一个机位 + 一个主体 + 一个连续动作。需要换机位、换主体、换动作/情绪节点时，必须新开分镜；禁止在一个分镜里切镜。',
  '- description 只能写一个连续镜头，最多一个【镜头1】或直接写连续画面；禁止【镜头2】及以后。同一机位内的连续运动可写成多个时间帧，但时间帧不是子镜头。',
  '- 每个分镜 6-15 秒；内部时间帧每段 1-6 秒，连续不重叠，最后一段结束时间等于 duration。',
  '- video_prompt 固定四区，顺序不可变：第一行信息头；第二行「画面调度」；中间时间帧；最后「负面约束」。',
  '- 信息头固定为「出场人物：@角色A、@角色B｜场景：@场景名」（英文 Characters/Scene，日文 登場人物/シーン，韩文 등장인물/장면）；没有角色写「出场人物：无」，没有场景写「场景：未指定」；信息头独立一行，不加句号。',
  '- 画面调度固定写「画面调度：画面左：…；画面右：…；过…肩；背景地标：窗在左后、门在右后；轴线A；动作起点：…；动作终点：…」；没有过肩写「无过肩」，没有地标写「背景地标：无」，单人/空镜写「轴线无」，双人及以上必须写「轴线A」或「轴线B」；有角色的分镜必须写动作起点和动作终点。',
  '- 时间帧从「0-3秒：」开始，每段 1-6 秒，段内画面必须属于同一个机位/主体/连续动作；台词按 4 字/秒容量分配，装不下就拆到相邻分镜，不能靠加快语速硬塞。',
  '- 台词只写「@角色名说：「台词」」，旁白只写「旁白（画外音）：「台词」」；必须从 description 对应位置逐字复制（含全部标点和语气词），只允许在原文标点或语义停顿处拆到相邻时间帧。',
  '- 场景必须使用 canonical scene_id；同名场景只选 canonical，禁止在 54/55/56 等别名之间另选。',
  '- 同一场戏的屏幕左右、轴线、背景地标侧是场景级常量：先定一次，后续同场分镜沿用，禁止在后续镜头交换人物左右或门窗侧。',
  '- 提到角色/场景/道具必须写 @名称；名称必须使用 canonical 资产名（如 @唐大郎（唐奕），不是 @唐大郎）。',
  '- 声音不在拆分/修补阶段逐镜写全：BGM/环境声由校验后的第四步按场景/剧情声音单元统一设计，届时只在负面约束前插入本镜短增量。',
  '- 最后一行固定写「负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品」。',
  '- 不要写「音频：」要求行或音色/混音指令（声音由生成参数控制）。',
].join('\n')

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
    '### 新拆分单位（覆盖本方案内任何旧表述）',
    '本方案中所有「分镜段落」「段内 2-4 个子镜头」「子镜头」的旧表述，一律按以下新规则改写：一个分镜 = 一个机位 + 一个主体 + 一个连续动作；需要换机位、换主体、换动作/情绪节点时新开分镜；一个分镜 6-15 秒；不再有【镜头2】及以后。方案里的钩子、覆盖、节奏建议保留，但不得再把多个机位合并进一个分镜。',
  ]
  if (prompt) sections.push(`### 方案提示词\n${prompt}`)
  if (skill) sections.push(`### 方案 Skill\n${skill}`)
  sections.push(PLATFORM_VIDEO_PROMPT_RULES)
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
