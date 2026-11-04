import { toast } from 'vue-sonner'
import { api } from './useApi'
import { toastError } from './useToast'
import { i18n } from './i18n'

export function useAgent() {
  const running = ref(false)
  const runningType = ref<string | null>(null)

  async function run(type: string, msg: string, dramaId: number, episodeId: number, onDone?: () => void | Promise<void>, model?: string, configId?: number, onSettled?: (ok: boolean) => void | Promise<void>) {
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
      toast.success(i18n.global.t('composables.agent.done'))
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
