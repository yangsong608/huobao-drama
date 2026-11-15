import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BRIDGE_ROLES, type BridgeRole } from './roles.js'

export interface RoleModelConfig {
  provider: string
  model: string
}

export interface BridgeConfig {
  roles: Record<BridgeRole, RoleModelConfig>
  timeouts: {
    llmMs: number
    agentMs: number
  }
  maxAgentTasks: number
}

export const BRIDGE_HOME = path.join(os.homedir(), '.dsh', 'moss-huobao-bridge')
export const CONFIG_FILE = path.join(BRIDGE_HOME, 'config.json')
export const TASKS_FILE = path.join(BRIDGE_HOME, 'tasks.json')

export function configFile(): string {
  return process.env.MOSS_HUOBAO_CONFIG ?? CONFIG_FILE
}

export function tasksFile(): string {
  return process.env.MOSS_HUOBAO_TASKS ?? TASKS_FILE
}

const DEFAULT_ROLE_MODELS: Record<BridgeRole, RoleModelConfig> = {
  script_rewriter: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  extractor: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  storyboard_director: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  storyboard_breaker: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  prompt_generator: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  storyboard_auditor: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  voice_designer: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  sound_designer: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  translator: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  generic: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
}

export function defaultConfig(): BridgeConfig {
  return {
    roles: Object.fromEntries(
      BRIDGE_ROLES.map(role => [role, { ...DEFAULT_ROLE_MODELS[role] }]),
    ) as Record<BridgeRole, RoleModelConfig>,
    timeouts: { llmMs: 120_000, agentMs: 600_000 },
    maxAgentTasks: 2,
  }
}

export interface LoadedConfig {
  config: BridgeConfig
  warnings: string[]
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < min || n > max) return fallback
  return Math.trunc(n)
}

export function loadConfig(file = configFile()): LoadedConfig {
  const config = defaultConfig()
  const warnings: string[] = []
  if (!fs.existsSync(file)) return { config, warnings }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (cause) {
    warnings.push(`config.json 解析失败，使用默认配置：${cause instanceof Error ? cause.message : String(cause)}`)
    return { config, warnings }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('config.json 不是对象，使用默认配置')
    return { config, warnings }
  }
  const record = raw as Record<string, unknown>
  const roles = record.roles
  if (roles !== null && typeof roles === 'object' && !Array.isArray(roles)) {
    for (const role of BRIDGE_ROLES) {
      const entry = (roles as Record<string, unknown>)[role]
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const candidate = entry as Record<string, unknown>
      const provider = typeof candidate.provider === 'string' ? candidate.provider.trim() : ''
      const model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
      if (provider !== '' && model !== '') config.roles[role] = { provider, model }
      else warnings.push(`角色 ${role} 的 provider/model 不完整，使用默认值`)
    }
  }
  const timeouts = record.timeouts
  if (timeouts !== null && typeof timeouts === 'object' && !Array.isArray(timeouts)) {
    const t = timeouts as Record<string, unknown>
    config.timeouts.llmMs = positiveInt(t.llmMs, config.timeouts.llmMs, 1_000, 900_000)
    config.timeouts.agentMs = positiveInt(t.agentMs, config.timeouts.agentMs, 10_000, 3_600_000)
  }
  config.maxAgentTasks = positiveInt(record.maxAgentTasks, config.maxAgentTasks, 1, 8)
  return { config, warnings }
}

export function ensureConfig(file = configFile()): LoadedConfig {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, `${JSON.stringify(defaultConfig(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  return loadConfig(file)
}

export function resolveRoleModel(config: BridgeConfig, role: string): RoleModelConfig {
  const known = BRIDGE_ROLES.includes(role as BridgeRole) ? (role as BridgeRole) : 'generic'
  return config.roles[known]
}
