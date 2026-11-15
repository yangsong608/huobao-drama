import type { HealthView } from '../shared/contracts.js'
import type { BridgeConfig } from '../shared/config.js'
import { findHuobaoRuntime, probeHuobaoApi, probeHuobaoMcp } from './descriptor.js'
import type { LlmService } from './llm-bridge.js'
import type { TaskRegistry } from './task-registry.js'

export interface HealthDeps {
  registry: TaskRegistry
  config: BridgeConfig
  llm?: LlmService
  agents?: { create?: unknown }
  port: number
  pluginVersion: string
  dshVersion: string
}

export async function buildHealth(deps: HealthDeps): Promise<HealthView> {
  const runtime = findHuobaoRuntime()
  const [huobaoApi, huobaoMcp] = await Promise.all([
    probeHuobaoApi(runtime),
    probeHuobaoMcp(runtime),
  ])
  let providers: string[] = []
  try {
    providers = deps.llm?.listProviders?.() ?? []
  } catch {
    providers = []
  }
  return {
    pluginVersion: deps.pluginVersion,
    dshVersion: deps.dshVersion,
    bridgePort: deps.port,
    llmBridge: Boolean(deps.llm && typeof deps.llm.stream === 'function'),
    agentBridge: Boolean(deps.agents && typeof deps.agents.create === 'function'),
    huobaoApi,
    huobaoMcp,
    taskCounts: deps.registry.counts(),
    fallbackRate: deps.registry.fallbackRate(),
    providers,
    roles: deps.config.roles,
    lastError: deps.registry.getLastError(),
  }
}
