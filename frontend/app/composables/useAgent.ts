import { toast } from 'vue-sonner'
import { api } from './useApi'
import { toastError } from './useToast'
import { i18n } from './i18n'

export interface AgentRunOptions {
  /** 成功响应里必须出现的工具调用；缺失说明模型只回复了文字、没有落库，按失败处理 */
  requireTool?: string
}

function normalizeToolName(name: unknown) {
  return String(name || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

export function hasAgentToolCall(data: any, toolName?: string) {
  if (!toolName) return true
  const target = normalizeToolName(toolName)
  const calls = Array.isArray(data?.toolCalls) ? data.toolCalls : []
  return calls.some((call: any) => normalizeToolName(call?.toolName) === target)
}

/** 后端按剧本字数与方案单段上限计算覆盖下限；返回未达标的覆盖对象 */
export function coverageShortfall(data: any) {
  const coverage = data?.coverage
  if (!coverage || coverage.ok !== false || !coverage.floor) return null
  return coverage
}

export function useAgent() {
  const running = ref(false)
  const runningType = ref<string | null>(null)

  async function run(type: string, msg: string, dramaId: number, episodeId: number, onDone?: () => void | Promise<void>, model?: string, configId?: number, onSettled?: (ok: boolean) => void | Promise<void>, options: AgentRunOptions = {}) {
    if (running.value) { toast.warning(i18n.global.t('composables.agent.busy')); return }
    running.value = true
    runningType.value = type
    let ok = false
    try {
      const data = await api.post<any>(`/agent/${type}/chat`, {
        message: msg,
        drama_id: dramaId,
        episode_id: episodeId,
        model: model || undefined,
        config_id: configId || undefined,
      })
      if (!hasAgentToolCall(data, options.requireTool)) {
        toast.error(i18n.global.t('composables.agent.noSave'))
        return
      }
      const shortfall = coverageShortfall(data)
      if (shortfall) {
        toast.warning(i18n.global.t('composables.agent.coverageShort', {
          actual: shortfall.actual,
          floor: shortfall.floor,
        }))
      } else {
        toast.success(i18n.global.t('composables.agent.done'))
      }
      await onDone?.()
      ok = true
    } catch (err: any) {
      toastError(err)
    } finally {
      running.value = false
      runningType.value = null
      // 失败/超时也要收尾：调用方借此刷新，避免页面停在旧空态
      await onSettled?.(ok)
    }
  }

  return { running, runningType, run }
}
