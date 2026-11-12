/**
 * 链式分镜流水线：链定义、步骤插件、规则包、参数覆盖、运行快照与步骤追踪。
 *
 * 设计原则：
 * - 内置插件/链/规则包由代码播种到数据库，UI 只读取；用户通过覆盖表调整参数与可选步骤。
 * - 运行前固化快照；步骤执行写 pipeline_step_runs，便于 trace 与复现。
 * - 现有四段式拆分逻辑作为内置插件执行器，不在本文件重写业务规则。
 */
import { and, desc, eq, notInArray } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { loadAssignedKnowledge, getKnowledge } from '../agents/knowledge.js'
import { skillsManagerWorkspace } from '../agents/skills.js'

export type PipelineStepKind = 'deterministic' | 'llm' | 'validate' | 'human' | 'finalize'
export type PipelineStepScope = 'episode' | 'chunk' | 'shot'
export type PipelineStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'manual'
export type PipelineOverrideScope = 'global' | 'project' | 'episode'

export interface PipelineStepDefinition {
  key: string
  name: string
  version: string
  kind: PipelineStepKind
  scope: PipelineStepScope
  description: string
  required: boolean
  defaultEnabled: boolean
  available: boolean
  note?: string
  agent?: string
  promptRef?: string
  skillRefs?: string[]
  knowledgeRefs?: string[]
  toolRefs?: string[]
  rulePacks?: string[]
}

export interface PipelineParameterDefinition {
  key: string
  label: string
  type: 'number' | 'boolean' | 'string'
  default: number | boolean | string
  min?: number
  max?: number
  step?: number
  options?: string[]
  stepKey?: string
  locked?: boolean
  description?: string
}

export interface PipelineChainDefinition {
  key: string
  name: string
  version: string
  description: string
  stepKeys: string[]
  defaultParameters: Record<string, number | boolean | string>
  parameters: PipelineParameterDefinition[]
}

export interface PipelineRuleDefinition {
  key: string
  name: string
  severity: 'error' | 'warning' | 'info'
  locked: boolean
  scope: 'shot' | 'pair' | 'chunk' | 'episode'
  description: string
}

export interface PipelineRulePackDefinition {
  key: string
  name: string
  version: string
  rules: PipelineRuleDefinition[]
}

export interface PipelineRunParameters {
  shotMaxAttempts: number
  blockMaxAttempts: number
  excerptRejectRatio: number
  excerptWarnRatio: number
  coverageFloorRatio: number
  coverageGateEnabled: boolean
  soundMaxAttempts: number
  maxWallClockMinutes: number
  splitPresetKey: string
  /** 0 = 关闭；连续失败达到次数后自动跳过并标记 */
  autoSkipAfterAttempts: number
}

export interface PipelineOverrides {
  parameters?: Record<string, unknown>
  stepToggles?: Record<string, boolean>
  knowledgeRefs?: Record<string, string[]>
}

export interface PipelineChainView {
  key: string
  name: string
  version: string
  description: string
  builtin: boolean
  steps: Array<PipelineStepDefinition & { enabled: boolean }>
  parameters: Array<PipelineParameterDefinition & { value: number | boolean | string }>
  overrides: PipelineOverrides
  default_parameters: Record<string, number | boolean | string>
  scope_type: PipelineOverrideScope
  scope_id: number
}

export const BASE_STEP_KEYS = [
  'prepare',
  'skeleton-split',
  'skeleton-gate',
  'shot-repair',
  'shot-validate',
  'sound-design',
  'sound-validate',
  'finalize',
] as const

export const REQUIRED_STEP_KEYS = new Set([
  'prepare',
  'skeleton-split',
  'skeleton-gate',
  'shot-repair',
  'shot-validate',
  'sound-design',
  'sound-validate',
  'finalize',
])

const DEFAULT_PARAMETERS: PipelineRunParameters = {
  shotMaxAttempts: 3,
  blockMaxAttempts: 2,
  excerptRejectRatio: 0.25,
  excerptWarnRatio: 0.6,
  coverageFloorRatio: 0.9,
  coverageGateEnabled: true,
  soundMaxAttempts: 2,
  maxWallClockMinutes: 60,
  splitPresetKey: 'inherit',
  autoSkipAfterAttempts: 0,
}

const PARAMETER_DEFS: PipelineParameterDefinition[] = [
  { key: 'shotMaxAttempts', label: '逐镜最大尝试', type: 'number', default: 3, min: 2, max: 5, step: 1, stepKey: 'shot-repair', description: '初始 + 重试的总次数；用完进入人工队列。' },

  { key: 'autoSkipAfterAttempts', label: '连续失败自动跳过', type: 'number', default: 0, min: 0, max: 10, step: 1, stepKey: 'shot-repair', description: '0=关闭；连续失败达到次数后自动跳过并标记，继续下一镜。' },
  { key: 'blockMaxAttempts', label: '块级最大尝试', type: 'number', default: 2, min: 1, max: 3, step: 1, stepKey: 'skeleton-split', description: '单块骨架覆盖率不足或调用失败时的重拆次数。' },
  { key: 'excerptRejectRatio', label: '摘录拒收阈值', type: 'number', default: 0.25, min: 0.2, max: 0.35, step: 0.01, stepKey: 'skeleton-gate', description: '单块摘录覆盖率低于此值判失败。' },
  { key: 'excerptWarnRatio', label: '摘录警告阈值', type: 'number', default: 0.6, min: 0.5, max: 0.8, step: 0.01, stepKey: 'skeleton-gate', description: '低于此值记录警告但继续。' },
  { key: 'coverageFloorRatio', label: '覆盖下限比例', type: 'number', default: 0.9, min: 0.85, max: 1, step: 0.01, stepKey: 'skeleton-gate', description: '整集分镜数低于方案下限的折算比例时阻断。' },
  { key: 'coverageGateEnabled', label: '整集覆盖门禁', type: 'boolean', default: true, stepKey: 'skeleton-gate', description: '关闭后只提示覆盖不足，不阻断完成。' },
  { key: 'soundMaxAttempts', label: '声音设计尝试', type: 'number', default: 2, min: 1, max: 3, step: 1, stepKey: 'sound-design', description: '声音计划保存或校验失败时的重试次数。' },
  { key: 'maxWallClockMinutes', label: '单集墙钟上限', type: 'number', default: 60, min: 10, max: 240, step: 5, stepKey: 'finalize', description: '超过后暂停运行，等待人工处理。' },
  { key: 'splitPresetKey', label: '拆分预设', type: 'string', default: 'inherit', options: ['inherit', 'standard', 'hook-beat-extended', 'h3-compact'], stepKey: 'skeleton-split', description: '默认跟随剧集选择；也可为本次运行覆盖。方案只影响风格与节奏，不覆盖 6–15 秒/单机位硬约束。' },
]

const PLUGIN_SEEDS: PipelineStepDefinition[] = [
  {
    key: 'prepare', name: '准备上下文', version: '1', kind: 'deterministic', scope: 'episode',
    description: '校验剧集/剧本、canonical 场景、分块、清理旧分镜与帧资产。', required: true, defaultEnabled: true, available: true,
  },
  {
    key: 'skeleton-split', name: '预拆骨架', version: '1', kind: 'llm', scope: 'chunk',
    description: '按场次分块产出骨架，只写逐字原文摘录与动作摘要。', required: true, defaultEnabled: true, available: true,
    agent: 'storyboard_director', promptRef: 'prompts/storyboard_director.md',
    skillRefs: ['skills/storyboard-director/SKILL.md'],
    knowledgeRefs: ['short-drama-grammar', 'storyboard-direction'],
    toolRefs: ['read_storyboard_context', 'save_storyboard_skeletons'],
    rulePacks: ['coverage'],
  },
  {
    key: 'skeleton-gate', name: '骨架覆盖门禁', version: '1', kind: 'validate', scope: 'chunk',
    description: '校验单块摘录覆盖率与整集分镜数下限。', required: true, defaultEnabled: true, available: true,
    rulePacks: ['coverage'],
  },
  {
    key: 'shot-repair', name: '逐镜修补', version: '1', kind: 'llm', scope: 'shot',
    description: '加载完整场次与前后镜上下文，逐镜补全台词、动作、调度与四区提示词。', required: true, defaultEnabled: true, available: true,
    agent: 'storyboard_director', promptRef: 'prompts/storyboard_director.md',
    skillRefs: ['skills/storyboard-director/SKILL.md'],
    knowledgeRefs: ['storyboard-direction', 'continuity-and-transitions'],
    toolRefs: ['read_storyboard_pipeline_context', 'save_repaired_storyboard'],
    rulePacks: ['unit-contract', 'dialogue-integrity', 'pair-continuity'],
  },
  {
    key: 'shot-validate', name: '逐镜校验', version: '1', kind: 'validate', scope: 'shot',
    description: '单机位、6–15 秒、四区、台词完整、发声动作与相邻镜配对。', required: true, defaultEnabled: true, available: true,
    rulePacks: ['unit-contract', 'dialogue-integrity', 'dialogue-capacity', 'pair-continuity'],
  },
  {
    key: 'sound-design', name: '声音设计', version: '1', kind: 'llm', scope: 'episode',
    description: '按场景/剧情声音单元设计 BGM、环境声、音效、静默；单镜只写增量。', required: true, defaultEnabled: true, available: true,
    agent: 'storyboard_director', promptRef: 'prompts/storyboard_director.md',
    skillRefs: ['skills/storyboard-director/SKILL.md'],
    knowledgeRefs: ['voice-and-narration', 'continuity-and-transitions'],
    toolRefs: ['read_storyboard_pipeline_context', 'save_sound_plan'],
    rulePacks: ['sound'],
  },
  {
    key: 'sound-validate', name: '声音校验', version: '1', kind: 'validate', scope: 'episode',
    description: '校验覆盖、同轨不重叠、单元单 BGM、不逐镜重启、native/post 不混用。', required: true, defaultEnabled: true, available: true,
    rulePacks: ['sound'],
  },
  {
    key: 'finalize', name: '收尾', version: '1', kind: 'finalize', scope: 'episode',
    description: '写入完成快照、事件与任务状态。', required: true, defaultEnabled: true, available: true,
  },
]

const CHAIN_SEEDS: PipelineChainDefinition[] = [
  {
    key: 'standard-four-stage', name: '标准四段式', version: '1',
    description: '默认生产链：预拆 → 逐镜修补/校验 → 声音设计。',
    stepKeys: [...BASE_STEP_KEYS],
    defaultParameters: { ...DEFAULT_PARAMETERS },
    parameters: PARAMETER_DEFS,
  },
  {
    key: 'strict-four-stage', name: '严格四段式', version: '1',
    description: '关键集使用：逐镜重试更多、覆盖下限更严；边界契约与人工停点不变。',
    stepKeys: [...BASE_STEP_KEYS],
    defaultParameters: {
      ...DEFAULT_PARAMETERS,
      shotMaxAttempts: 4,
      blockMaxAttempts: 3,
      coverageFloorRatio: 0.95,
    },
    parameters: PARAMETER_DEFS,
  },
  {
    key: 'light-four-stage', name: '轻量四段式', version: '1',
    description: '试拍/草稿：逐镜重试更少、覆盖下限放宽；硬规则与人工停点不变。',
    stepKeys: [...BASE_STEP_KEYS],
    defaultParameters: {
      ...DEFAULT_PARAMETERS,
      shotMaxAttempts: 2,
      blockMaxAttempts: 1,
      coverageFloorRatio: 0.85,
    },
    parameters: PARAMETER_DEFS,
  },
]

const RULE_PACK_SEEDS: PipelineRulePackDefinition[] = [
  {
    key: 'unit-contract', name: '分镜单位合同', version: '1',
    rules: [
      { key: 'single-camera', name: '单机位/单主体/连续动作', severity: 'error', locked: true, scope: 'shot', description: '禁止【镜头2】及以后。' },
      { key: 'duration', name: '6–15 秒', severity: 'error', locked: true, scope: 'shot', description: '镜头时长必须在 6–15 秒之间。' },
      { key: 'time-frames', name: '时间帧连续', severity: 'error', locked: true, scope: 'shot', description: '时间帧 1–6 秒、连续覆盖 duration。' },
      { key: 'four-sections', name: '固定四区', severity: 'error', locked: true, scope: 'shot', description: '信息头、画面调度、时间帧、负面约束。' },
      { key: 'action-endpoints', name: '动作端点', severity: 'error', locked: true, scope: 'shot', description: '有角色的镜头必须写动作起点/终点。' },
    ],
  },
  {
    key: 'dialogue-integrity', name: '台词完整性', version: '1',
    rules: [
      { key: 'verbatim', name: '台词逐字', severity: 'error', locked: true, scope: 'shot', description: 'description 与 video_prompt 台词逐字一致。' },
      { key: 'source-lines', name: '原文台词不丢', severity: 'error', locked: true, scope: 'shot', description: '原文引号台词必须保留。' },
      { key: 'vocal-action', name: '发声动作必须有台词', severity: 'error', locked: true, scope: 'shot', description: '喊/叫卖/揽客/吆喝等必须有具体台词。' },
      { key: 'no-invented-lines', name: '不得凭空加台词', severity: 'error', locked: true, scope: 'shot', description: '原文无发声动作时不得自行加台词。' },
      { key: 'no-placeholder', name: '禁止占位台词', severity: 'error', locked: true, scope: 'shot', description: '禁止「无」等占位台词。' },
    ],
  },
  {
    key: 'dialogue-capacity', name: '台词容量', version: '1',
    rules: [
      { key: 'chars-per-second', name: '4 字/秒 + 1 秒气口', severity: 'error', locked: true, scope: 'shot', description: '超出镜头容量必须拆到相邻分镜。' },
    ],
  },
  {
    key: 'pair-continuity', name: '相邻镜连贯', version: '1',
    rules: [
      { key: 'screen-sides', name: '屏幕左右', severity: 'error', locked: true, scope: 'pair', description: '同场人物左右不得无故翻转。' },
      { key: 'landmarks', name: '地标侧', severity: 'error', locked: true, scope: 'pair', description: '同场门窗/地标侧不得翻面。' },
      { key: 'axis', name: '轴线', severity: 'error', locked: true, scope: 'pair', description: '越轴必须有中性镜头过渡。' },
      { key: 'action-match', name: '动作端点配对', severity: 'error', locked: true, scope: 'pair', description: '上一镜动作终点与下一镜起点匹配。' },
    ],
  },
  {
    key: 'coverage', name: '覆盖与绑定', version: '1',
    rules: [
      { key: 'excerpt-coverage', name: '原文摘录覆盖', severity: 'error', locked: true, scope: 'chunk', description: '单块摘录覆盖率低于阈值判失败。' },
      { key: 'shot-floor', name: '整集分镜数下限', severity: 'error', locked: false, scope: 'episode', description: '低于方案下限可阻断完成。' },
      { key: 'scene-binding', name: '场景绑定', severity: 'warning', locked: false, scope: 'shot', description: '镜头应绑定 canonical 场景。' },
      { key: 'asset-binding', name: '资产绑定', severity: 'warning', locked: false, scope: 'shot', description: '出场角色/道具应绑定既有资产。' },
    ],
  },
  {
    key: 'sound', name: '声音规则', version: '1',
    rules: [
      { key: 'coverage', name: '每镜被环境声/静默覆盖', severity: 'error', locked: true, scope: 'episode', description: '普通分镜必须有环境声或静默。' },
      { key: 'no-overlap', name: '同轨不重叠', severity: 'error', locked: true, scope: 'episode', description: 'BGM/环境声/静默同轨不能重叠。' },
      { key: 'one-bgm', name: '单元单 BGM', severity: 'error', locked: true, scope: 'episode', description: '同一声音单元只能一条 BGM。' },
      { key: 'no-restart', name: '不逐镜重启', severity: 'error', locked: true, scope: 'episode', description: '同单元后续镜头延续 BGM，不重新起。' },
      { key: 'no-cross-scene-ambience', name: '环境声不跨场景', severity: 'error', locked: true, scope: 'episode', description: '环境声不能跨不同场景。' },
      { key: 'delivery', name: 'native/post 不混用', severity: 'error', locked: true, scope: 'episode', description: '一集只能选一种交付方式。' },
    ],
  },
]

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    if (!value) return fallback
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function safeJson(value: unknown, max = 4000): string | null {
  if (value === undefined || value === null) return null
  try {
    const text = JSON.stringify(value)
    return text.length > max ? `${text.slice(0, max)}…` : text
  } catch {
    return null
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

async function hashWorkspaceFile(path: string): Promise<string | null> {
  try {
    const fsm = skillsManagerWorkspace.filesystem
    if (!fsm) return null
    const raw = await fsm.readFile(path, { encoding: 'utf-8' })
    return hashText(String(raw))
  } catch {
    return null
  }
}

function clampNumber(value: unknown, def: PipelineParameterDefinition): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return Number(def.default)
  const min = def.min ?? n
  const max = def.max ?? n
  return Math.max(min, Math.min(max, n))
}

export function validatePipelineOverrides(raw: unknown): PipelineOverrides {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const parameters = input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters)
    ? input.parameters as Record<string, unknown>
    : {}
  const stepToggles = input.stepToggles && typeof input.stepToggles === 'object' && !Array.isArray(input.stepToggles)
    ? input.stepToggles as Record<string, unknown>
    : {}
  const knowledgeRefs = input.knowledgeRefs && typeof input.knowledgeRefs === 'object' && !Array.isArray(input.knowledgeRefs)
    ? input.knowledgeRefs as Record<string, unknown>
    : {}
  return {
    parameters,
    stepToggles: Object.fromEntries(Object.entries(stepToggles).map(([key, value]) => [key, value === true])),
    knowledgeRefs: Object.fromEntries(Object.entries(knowledgeRefs).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] : [],
    ])),
  }
}

export function resolvePipelineParameters(chain: PipelineChainDefinition, overrides: PipelineOverrides): PipelineRunParameters {
  const merged: Record<string, unknown> = { ...chain.defaultParameters, ...(overrides.parameters || {}) }
  const out = { ...DEFAULT_PARAMETERS } as PipelineRunParameters
  for (const def of PARAMETER_DEFS) {
    const raw = merged[def.key]
    if (def.type === 'number') {
      (out as any)[def.key] = clampNumber(raw, def)
    } else if (def.type === 'boolean') {
      (out as any)[def.key] = typeof raw === 'boolean' ? raw : Boolean(def.default)
    } else {
      const rawValue = raw ?? def.default
      const rawStr: string = (rawValue as any).toString()
      const allowed = Array.isArray(def.options) ? def.options : null
      ;(out as any)[def.key] = allowed && !allowed.includes(rawStr) ? (def.default as any).toString() : rawStr
    }
  }
  return out
}

export function resolveStepEnabled(step: PipelineStepDefinition, overrides: PipelineOverrides): boolean {
  if (step.required) return true
  const toggled = overrides.stepToggles?.[step.key]
  return typeof toggled === 'boolean' ? toggled : step.defaultEnabled
}

function chainRowFromSeed(seed: PipelineChainDefinition) {
  return {
    key: seed.key,
    name: seed.name,
    description: seed.description,
    version: seed.version,
    definitionJson: JSON.stringify({
      key: seed.key,
      name: seed.name,
      version: seed.version,
      description: seed.description,
      stepKeys: seed.stepKeys,
      defaultParameters: seed.defaultParameters,
      parameters: seed.parameters,
    }),
    builtin: 1,
    enabled: 1,
  }
}

export async function ensurePipelineSeeds(): Promise<void> {
  const ts = now()
  for (const step of PLUGIN_SEEDS) {
    const existing = db.select().from(schema.pipelinePlugins)
      .where(eq(schema.pipelinePlugins.key, step.key)).get()
    const values = {
      key: step.key,
      name: step.name,
      version: step.version,
      kind: step.kind,
      manifestJson: JSON.stringify(step),
      builtin: 1,
      enabled: 1,
      updatedAt: ts,
    }
    if (existing) {
      db.update(schema.pipelinePlugins).set(values).where(eq(schema.pipelinePlugins.id, existing.id)).run()
    } else {
      db.insert(schema.pipelinePlugins).values({ ...values, createdAt: ts }).run()
    }
  }
  for (const chain of CHAIN_SEEDS) {
    const existing = db.select().from(schema.pipelineChains)
      .where(eq(schema.pipelineChains.key, chain.key)).get()
    const values = chainRowFromSeed(chain)
    if (existing) {
      db.update(schema.pipelineChains).set({ ...values, updatedAt: ts }).where(eq(schema.pipelineChains.id, existing.id)).run()
    } else {
      db.insert(schema.pipelineChains).values({ ...values, createdAt: ts, updatedAt: ts }).run()
    }
  }
  for (const pack of RULE_PACK_SEEDS) {
    const existing = db.select().from(schema.pipelineRulePacks)
      .where(eq(schema.pipelineRulePacks.key, pack.key)).get()
    const values = {
      key: pack.key,
      name: pack.name,
      version: pack.version,
      rulesJson: JSON.stringify(pack),
      builtin: 1,
      enabled: 1,
      updatedAt: ts,
    }
    if (existing) {
      db.update(schema.pipelineRulePacks).set(values).where(eq(schema.pipelineRulePacks.id, existing.id)).run()
    } else {
      db.insert(schema.pipelineRulePacks).values({ ...values, createdAt: ts }).run()
    }
  }
  // 清理已下线的内置步骤/规则包（旧版本播种过），避免设置页继续显示无效项
  db.delete(schema.pipelinePlugins)
    .where(and(
      eq(schema.pipelinePlugins.builtin, 1),
      notInArray(schema.pipelinePlugins.key, PLUGIN_SEEDS.map(item => item.key)),
    ))
    .run()
  db.delete(schema.pipelineRulePacks)
    .where(and(
      eq(schema.pipelineRulePacks.builtin, 1),
      notInArray(schema.pipelineRulePacks.key, RULE_PACK_SEEDS.map(item => item.key)),
    ))
    .run()
}

function chainFromRow(row: typeof schema.pipelineChains.$inferSelect): PipelineChainDefinition {
  const parsed = parseJson<Partial<PipelineChainDefinition>>(row.definitionJson, {})
  const seed = CHAIN_SEEDS.find(item => item.key === row.key)
  return {
    key: row.key,
    name: row.name,
    version: row.version || '1',
    description: row.description || '',
    stepKeys: Array.isArray(parsed.stepKeys) && parsed.stepKeys.length ? parsed.stepKeys : (seed?.stepKeys || [...BASE_STEP_KEYS]),
    defaultParameters: parsed.defaultParameters || seed?.defaultParameters || { ...DEFAULT_PARAMETERS },
    parameters: Array.isArray(parsed.parameters) && parsed.parameters.length ? parsed.parameters : (seed?.parameters || PARAMETER_DEFS),
  }
}

function pluginFromRow(row: typeof schema.pipelinePlugins.$inferSelect): PipelineStepDefinition {
  return parseJson<PipelineStepDefinition>(row.manifestJson, PLUGIN_SEEDS.find(item => item.key === row.key)!)
}

export function listPipelineChains(): Array<{ key: string; name: string; version: string; description: string; builtin: boolean; step_keys: string[] }> {
  const order: Record<string, number> = {
    'standard-four-stage': 0,
    'strict-four-stage': 1,
    'light-four-stage': 2,
  }
  const rows = db.select().from(schema.pipelineChains).all()
  return rows.filter(row => row.enabled !== 0).map(row => {
    const chain = chainFromRow(row)
    return {
      key: row.key,
      name: row.name,
      version: row.version || '1',
      description: row.description || '',
      builtin: row.builtin !== 0,
      step_keys: chain.stepKeys,
    }
  }).sort((a, b) => {
    const diff = (order[a.key] ?? 99) - (order[b.key] ?? 99)
    return diff !== 0 ? diff : a.key.localeCompare(b.key)
  })
}

export function listPipelinePlugins(): PipelineStepDefinition[] {
  return db.select().from(schema.pipelinePlugins).all()
    .filter(row => row.enabled !== 0)
    .map(pluginFromRow)
    .sort((a, b) => BASE_STEP_KEYS.indexOf(a.key as any) - BASE_STEP_KEYS.indexOf(b.key as any))
}

export function listPipelineRulePacks(): PipelineRulePackDefinition[] {
  return db.select().from(schema.pipelineRulePacks).all()
    .filter(row => row.enabled !== 0)
    .map(row => parseJson<PipelineRulePackDefinition>(row.rulesJson, RULE_PACK_SEEDS.find(item => item.key === row.key)!))
}

export function getChainOverride(chainKey: string, scopeType: PipelineOverrideScope, scopeId = 0): PipelineOverrides {
  const row = db.select().from(schema.pipelineChainOverrides)
    .where(and(
      eq(schema.pipelineChainOverrides.chainKey, chainKey),
      eq(schema.pipelineChainOverrides.scopeType, scopeType),
      eq(schema.pipelineChainOverrides.scopeId, scopeId),
    ))
    .get()
  return validatePipelineOverrides(parseJson(row?.overridesJson, {}))
}

function mergeOverrides(base: PipelineOverrides, next: PipelineOverrides): PipelineOverrides {
  return {
    parameters: { ...(base.parameters || {}), ...(next.parameters || {}) },
    stepToggles: { ...(base.stepToggles || {}), ...(next.stepToggles || {}) },
    knowledgeRefs: { ...(base.knowledgeRefs || {}), ...(next.knowledgeRefs || {}) },
  }
}

export function resolveChainForRun(chainKey: string, dramaId?: number | null, episodeId?: number | null): {
  chain: PipelineChainDefinition
  overrides: PipelineOverrides
  parameters: PipelineRunParameters
} {
  const row = db.select().from(schema.pipelineChains).where(eq(schema.pipelineChains.key, chainKey)).get()
  const chain = row ? chainFromRow(row) : CHAIN_SEEDS.find(item => item.key === chainKey) || CHAIN_SEEDS[0]
  let overrides = getChainOverride(chain.key, 'global', 0)
  if (dramaId) overrides = mergeOverrides(overrides, getChainOverride(chain.key, 'project', dramaId))
  if (episodeId) overrides = mergeOverrides(overrides, getChainOverride(chain.key, 'episode', episodeId))
  return { chain, overrides, parameters: resolvePipelineParameters(chain, overrides) }
}

export function getPipelineChainView(chainKey: string, scopeType: PipelineOverrideScope = 'global', scopeId = 0): PipelineChainView | null {
  const row = db.select().from(schema.pipelineChains).where(eq(schema.pipelineChains.key, chainKey)).get()
  const seed = CHAIN_SEEDS.find(item => item.key === chainKey)
  if (!row && !seed) return null
  const chain = row ? chainFromRow(row) : seed!
  const plugins = listPipelinePlugins()
  const pluginMap = new Map(plugins.map(item => [item.key, item]))
  const overrides = getChainOverride(chain.key, scopeType, scopeId)
  const parameters = resolvePipelineParameters(chain, overrides)
  return {
    key: chain.key,
    name: chain.name,
    version: chain.version,
    description: chain.description,
    builtin: row ? row.builtin !== 0 : true,
    steps: chain.stepKeys.map(key => pluginMap.get(key)).filter(Boolean).map(step => ({
      ...step!,
      enabled: resolveStepEnabled(step!, overrides),
    })),
    parameters: PARAMETER_DEFS.map(def => ({
      ...def,
      value: (parameters as any)[def.key],
    })),
    overrides,
    default_parameters: chain.defaultParameters,
    scope_type: scopeType,
    scope_id: scopeId,
  }
}

export function saveChainOverride(input: {
  chainKey: string
  scopeType: PipelineOverrideScope
  scopeId?: number
  parameters?: Record<string, unknown>
  stepToggles?: Record<string, boolean>
  knowledgeRefs?: Record<string, string[]>
}): PipelineOverrides {
  const chainRow = db.select().from(schema.pipelineChains)
    .where(eq(schema.pipelineChains.key, input.chainKey)).get()
  if (!chainRow && !CHAIN_SEEDS.some(item => item.key === input.chainKey)) throw new Error('拆分流水线模板不存在')
  const scopeType = input.scopeType
  if (!['global', 'project', 'episode'].includes(scopeType)) throw new Error('scope_type 无效')
  const scopeId = scopeType === 'global' ? 0 : Number(input.scopeId || 0)
  if (scopeType !== 'global' && (!Number.isInteger(scopeId) || scopeId <= 0)) throw new Error('scope_id 无效')
  const raw = validatePipelineOverrides({
    parameters: input.parameters,
    stepToggles: input.stepToggles,
    knowledgeRefs: input.knowledgeRefs,
  })
  const pluginMap = new Map(listPipelinePlugins().map(item => [item.key, item]))
  for (const [key, enabled] of Object.entries(raw.stepToggles || {})) {
    const step = pluginMap.get(key)
    if (!step) throw new Error(`未知步骤：${key}`)
    if (step.required && enabled === false) throw new Error(`必选步骤不可关闭：${key}`)
    if (!step.available && enabled === true) throw new Error(`步骤暂不可启用：${key}`)
  }
  const ts = now()
  const existing = db.select().from(schema.pipelineChainOverrides)
    .where(and(
      eq(schema.pipelineChainOverrides.chainKey, input.chainKey),
      eq(schema.pipelineChainOverrides.scopeType, scopeType),
      eq(schema.pipelineChainOverrides.scopeId, scopeId),
    ))
    .get()
  const overridesJson = JSON.stringify(raw)
  if (existing) {
    db.update(schema.pipelineChainOverrides)
      .set({ overridesJson, updatedAt: ts })
      .where(eq(schema.pipelineChainOverrides.id, existing.id)).run()
  } else {
    db.insert(schema.pipelineChainOverrides).values({
      scopeType,
      scopeId,
      chainKey: input.chainKey,
      overridesJson,
      createdAt: ts,
      updatedAt: ts,
    }).run()
  }
  return raw
}

export function resetChainOverride(chainKey: string, scopeType: PipelineOverrideScope, scopeId = 0): void {
  db.delete(schema.pipelineChainOverrides)
    .where(and(
      eq(schema.pipelineChainOverrides.chainKey, chainKey),
      eq(schema.pipelineChainOverrides.scopeType, scopeType),
      eq(schema.pipelineChainOverrides.scopeId, scopeType === 'global' ? 0 : Number(scopeId || 0)),
    ))
    .run()
}

export async function buildRunSnapshot(input: {
  chain: PipelineChainDefinition
  parameters: PipelineRunParameters
  overrides: PipelineOverrides
  model?: string | null
  configId?: number | null
}): Promise<Record<string, unknown>> {
  const steps = listPipelinePlugins().filter(step => input.chain.stepKeys.includes(step.key))
  const promptHashes: Record<string, string | null> = {}
  const skillHashes: Record<string, string | null> = {}
  for (const step of steps) {
    if (step.promptRef && promptHashes[step.promptRef] === undefined) {
      promptHashes[step.promptRef] = await hashWorkspaceFile(step.promptRef)
    }
    for (const skill of step.skillRefs || []) {
      if (skillHashes[skill] === undefined) skillHashes[skill] = await hashWorkspaceFile(skill)
    }
  }
  const knowledge = await loadAssignedKnowledge('storyboard_director', 'zh').catch(error => ({
    text: '',
    ids: [] as string[],
    version: `error:${error instanceof Error ? error.message : String(error)}`,
    missing: [] as string[],
  }))
  const rulePacks = listPipelineRulePacks()
  const stepKnowledge: Record<string, { ids: string[]; hashes: Record<string, string | null> }> = {}
  for (const step of steps) {
    const ids = input.overrides.knowledgeRefs?.[step.key] || step.knowledgeRefs || []
    const hashes: Record<string, string | null> = {}
    for (const id of ids) {
      const item = await getKnowledge(id, 'zh').catch(() => null)
      hashes[id] = item?.contentHash || null
    }
    stepKnowledge[step.key] = { ids: [...ids], hashes }
  }
  return {
    version: 1,
    created_at: now(),
    app_version: process.env.HUOBAO_VERSION || 'development',
    chain: {
      key: input.chain.key,
      name: input.chain.name,
      version: input.chain.version,
      step_keys: input.chain.stepKeys,
    },
    parameters: input.parameters,
    overrides: input.overrides,
    model: input.model || null,
    config_id: input.configId || null,
    components: {
      plugins: steps.map(step => ({ key: step.key, version: step.version, kind: step.kind, scope: step.scope })),
      prompt_hashes: promptHashes,
      skill_hashes: skillHashes,
      knowledge: {
        assigned_agent: 'storyboard_director',
        ids: knowledge.ids,
        version: knowledge.version,
        step_bindings: stepKnowledge,
      },
      rule_packs: rulePacks.map(pack => ({ key: pack.key, version: pack.version, hash: hashText(JSON.stringify(pack)) })),
    },
  }
}

export interface StepRunInput {
  jobId: number
  stepKey: string
  stepVersion?: string
  scope: PipelineStepScope
  itemKey?: string
  input?: unknown
  model?: string | null
}

export function startStepRun(input: StepRunInput): number {
  const ts = now()
  const row = db.insert(schema.pipelineStepRuns).values({
    jobId: input.jobId,
    stepKey: input.stepKey,
    stepVersion: input.stepVersion || '1',
    scope: input.scope,
    itemKey: input.itemKey || 'episode',
    status: 'running',
    attempts: 1,
    inputJson: safeJson(input.input),
    model: input.model || null,
    startedAt: ts,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  return row.id
}

export function finishStepRun(id: number, patch: {
  status: PipelineStepStatus
  issues?: string[]
  output?: unknown
  attempts?: number
  promptHash?: string | null
  knowledgeHash?: string | null
  rulePackHash?: string | null
  model?: string | null
}): void {
  db.update(schema.pipelineStepRuns).set({
    status: patch.status,
    ...(patch.attempts !== undefined ? { attempts: patch.attempts } : {}),
    ...(patch.issues !== undefined ? { issuesJson: patch.issues.length ? JSON.stringify(patch.issues) : null } : {}),
    ...(patch.output !== undefined ? { outputJson: safeJson(patch.output) } : {}),
    ...(patch.promptHash !== undefined ? { promptHash: patch.promptHash } : {}),
    ...(patch.knowledgeHash !== undefined ? { knowledgeHash: patch.knowledgeHash } : {}),
    ...(patch.rulePackHash !== undefined ? { rulePackHash: patch.rulePackHash } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    finishedAt: now(),
    updatedAt: now(),
  }).where(eq(schema.pipelineStepRuns.id, id)).run()
}

export function markStepSkipped(input: StepRunInput & { reason: string }): void {
  const id = startStepRun(input)
  finishStepRun(id, { status: 'skipped', issues: [input.reason] })
}

export function setCurrentStep(jobId: number, stepKey: string | null): void {
  db.update(schema.storyboardPipelineJobs).set({
    currentStepKey: stepKey,
    updatedAt: now(),
  }).where(eq(schema.storyboardPipelineJobs.id, jobId)).run()
}

export function listStepRuns(jobId: number): Array<typeof schema.pipelineStepRuns.$inferSelect> {
  return db.select().from(schema.pipelineStepRuns)
    .where(eq(schema.pipelineStepRuns.jobId, jobId))
    .orderBy(schema.pipelineStepRuns.id)
    .all()
}

export function getLatestPipelineStepError(jobId: number): string | null {
  const row = db.select().from(schema.pipelineStepRuns)
    .where(and(eq(schema.pipelineStepRuns.jobId, jobId), eq(schema.pipelineStepRuns.status, 'failed')))
    .orderBy(desc(schema.pipelineStepRuns.id))
    .limit(1)
    .get()
  return parseJson<string[]>(row?.issuesJson, [])[0] || null
}
