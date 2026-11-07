/**
 * 智能体设置缓存（`/settings/agent`）
 *
 * 抽屉与设置页共用同一份缓存；加载失败不阻塞页面，抽屉按默认开启处理。
 * 配置更新后由保存方调用 `applyAgentSettings` 回写，避免重复请求。
 */
import { computed, ref } from 'vue'
import type { AgentEntryType, AgentPreset, AgentScopeKind } from './useAgentPageAdapter'
import { settingsAPI } from './useApi'

export interface AgentPageBinding {
  route: string
  stage?: string
  entries: AgentEntryType[]
  defaultPreset: AgentPreset
  quickPrompts: string[]
  allowedScopes?: AgentScopeKind[]
  allowedTools?: string[]
}

export interface AgentSettings {
  dock: { enabled: boolean }
  pages: { version: 1; bindings: AgentPageBinding[] }
  director: { enabled: boolean; model: string }
  stream: { enabled: boolean }
  proposals: { enabled: boolean; types: string[] }
  suggestions: { enabled: boolean; actions: string[] }
  scope: { autoDetect: boolean }
  maxSteps: number
  timeoutSec: number
  context: { maxChars: number }
  message: { maxChars: number }
  tools: { maxResultChars: number }
  history: { maxMessages: number }
  session: { retentionDays: number }
  model: string
}

const agentSettings = ref<AgentSettings | null>(null)
const agentSettingsLoading = ref(false)
const agentSettingsError = ref('')
let inflight: Promise<AgentSettings | null> | null = null

export function applyAgentSettings(next: AgentSettings): void {
  agentSettings.value = next
}

export function useAgentSettings() {
  const dockEnabled = computed(() => agentSettings.value?.dock.enabled !== false)

  async function loadAgentSettings(force = false): Promise<AgentSettings | null> {
    if (agentSettings.value && !force) return agentSettings.value
    if (inflight) return inflight
    agentSettingsLoading.value = true
    agentSettingsError.value = ''
    inflight = settingsAPI.agent()
      .then((res) => {
        agentSettings.value = res.settings
        return res.settings
      })
      .catch((err: any) => {
        agentSettingsError.value = err?.message || String(err)
        return null
      })
      .finally(() => {
        agentSettingsLoading.value = false
        inflight = null
      })
    return inflight
  }

  return { agentSettings, agentSettingsLoading, agentSettingsError, dockEnabled, loadAgentSettings }
}
