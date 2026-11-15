export const AGENT_ROLES = [
  'script_rewriter',
  'extractor',
  'storyboard_director',
  'storyboard_breaker',
  'prompt_generator',
  'storyboard_auditor',
  'voice_designer',
] as const

export type AgentRole = (typeof AGENT_ROLES)[number]

export const BRIDGE_ONLY_ROLES = ['sound_designer', 'translator', 'generic'] as const

export type BridgeOnlyRole = (typeof BRIDGE_ONLY_ROLES)[number]

export const BRIDGE_ROLES = [...AGENT_ROLES, ...BRIDGE_ONLY_ROLES] as const

export type BridgeRole = (typeof BRIDGE_ROLES)[number]

const agentRoleSet: ReadonlySet<string> = new Set(AGENT_ROLES)
const bridgeRoleSet: ReadonlySet<string> = new Set(BRIDGE_ROLES)

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && agentRoleSet.has(value)
}

export function isBridgeRole(value: unknown): value is BridgeRole {
  return typeof value === 'string' && bridgeRoleSet.has(value)
}

export function normalizeBridgeRole(value: unknown): BridgeRole {
  return isBridgeRole(value) ? value : 'generic'
}
