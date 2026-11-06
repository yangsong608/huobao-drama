/**
 * 阶段 5 · 合成导出状态
 *
 * - 导出记录是唯一状态源：启动后轮询列表，任一记录 pending/running 时每 1.5s 刷新；
 * - 检查项随 episode 变化重新拉取，不在这里推导可导出性；
 * - 组件卸载时调用 dispose，in-flight 请求不得再启动轮询。
 */
import {
  exportAPI,
  type ExportChecks,
  type ExportKind,
  type ExportRecord,
  type ExportSubtitleMode,
} from '~/composables/useApi'

export interface UseExportSessionOptions {
  episodeId: () => number | null
  dramaId?: () => number | null
  onChanged?: (hasOutput: boolean) => void
}

const POLL_INTERVAL_MS = 1500
const POLL_MAX_ERRORS = 5

export function useExportSession(options: UseExportSessionOptions) {
  const checks = ref<ExportChecks | null>(null)
  const records = ref<ExportRecord[]>([])
  const loading = ref(false)
  const starting = ref(false)
  const lastReused = ref(false)
  const error = ref('')
  const preset = ref('vertical-hd')
  const subtitleMode = ref<ExportSubtitleMode>('soft')

  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollToken = 0
  let loadToken = 0
  let disposed = false

  const active = computed(() => records.value.find((record) => (
    record.status === 'pending' || record.status === 'running'
  )) || null)

  const hasOutput = computed(() => records.value.some((record) => (
    record.kind === 'video' && record.status === 'completed' && Boolean(record.outputUrl)
  )))

  function notify() {
    options.onChanged?.(hasOutput.value)
  }

  function setPreset(value: string) {
    preset.value = value
  }

  function setSubtitleMode(value: ExportSubtitleMode) {
    subtitleMode.value = value
  }

  function stopPolling() {
    pollToken += 1
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  function dispose() {
    disposed = true
    loadToken += 1
    stopPolling()
  }

  async function refresh() {
    const episodeId = options.episodeId()
    if (!episodeId || disposed) return
    const token = ++loadToken
    loading.value = true
    error.value = ''
    try {
      const [nextChecks, list] = await Promise.all([
        exportAPI.checks(episodeId),
        exportAPI.list(episodeId),
      ])
      if (token !== loadToken) return
      checks.value = nextChecks
      records.value = list.items
      notify()
      if (active.value) startPolling()
      else stopPolling()
    } catch (err: any) {
      if (token !== loadToken) return
      error.value = err?.message || '读取导出状态失败'
    } finally {
      if (token === loadToken) loading.value = false
    }
  }

  async function reloadRecords() {
    const episodeId = options.episodeId()
    if (!episodeId || disposed) return
    const token = ++loadToken
    const list = await exportAPI.list(episodeId)
    if (disposed || token !== loadToken || options.episodeId() !== episodeId) return
    records.value = list.items
    notify()
    if (active.value) startPolling()
    else stopPolling()
  }

  function startPolling() {
    if (disposed) return
    stopPolling()
    const token = pollToken
    let failures = 0
    const tick = async () => {
      const episodeId = options.episodeId()
      if (disposed || !episodeId || token !== pollToken) return
      try {
        const list = await exportAPI.list(episodeId)
        if (disposed || token !== pollToken) return
        failures = 0
        records.value = list.items
        notify()
        if (active.value) {
          pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
        } else {
          pollTimer = null
        }
      } catch (err: any) {
        if (disposed || token !== pollToken) return
        failures += 1
        error.value = err?.message || '读取导出状态失败'
        // 瞬时网络错误继续退避轮询，避免一次失败后进度永远停住
        if (failures < POLL_MAX_ERRORS) {
          pollTimer = setTimeout(tick, POLL_INTERVAL_MS * failures)
        } else {
          pollTimer = null
        }
      }
    }
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS)
  }

  async function start(kind: ExportKind, overrides: {
    preset?: string
    subtitleMode?: ExportSubtitleMode
    sourceFilmId?: number | null
    title?: string | null
    setCurrent?: boolean
  } = {}) {
    const episodeId = options.episodeId()
    if (!episodeId || disposed || starting.value) return null
    starting.value = true
    lastReused.value = false
    error.value = ''
    try {
      const result = await exportAPI.start(episodeId, {
        kind,
        ...(kind === 'video'
          ? {
              preset: overrides.preset || preset.value,
              subtitle_mode: overrides.subtitleMode || subtitleMode.value,
              ...(overrides.sourceFilmId ? { source_film_id: overrides.sourceFilmId } : {}),
              ...(overrides.title ? { title: overrides.title } : {}),
              ...(overrides.setCurrent ? { set_current: true } : {}),
            }
          : {}),
      })
      if (disposed) return result.record
      lastReused.value = Boolean(result.reused)
      await refresh()
      if (!disposed) startPolling()
      return result.record
    } catch (err: any) {
      if (!disposed) error.value = err?.message || '启动导出失败'
      return null
    } finally {
      starting.value = false
    }
  }

  async function run(action: () => Promise<unknown>, fallback: string) {
    try {
      error.value = ''
      await action()
      await reloadRecords()
      return true
    } catch (err: any) {
      error.value = err?.message || fallback
      return false
    }
  }

  async function cancel(id: number) {
    return run(() => exportAPI.cancel(id), '取消导出失败')
  }

  async function retry(id: number) {
    const ok = await run(() => exportAPI.retry(id), '重试导出失败')
    if (ok) startPolling()
    return ok
  }

  async function setCurrent(id: number) {
    const episodeId = options.episodeId()
    return run(() => exportAPI.setCurrent(id, episodeId || undefined), '设为当前成片失败')
  }

  async function remove(id: number) {
    const ok = await run(() => exportAPI.remove(id), '删除导出失败')
    if (ok) await refresh()
    return ok
  }

  return {
    checks,
    exports: records,
    active,
    hasOutput,
    loading,
    starting,
    lastReused,
    error,
    preset,
    subtitleMode,
    setPreset,
    setSubtitleMode,
    start,
    cancel,
    retry,
    setCurrent,
    remove,
    refresh,
    startPolling,
    stopPolling,
    dispose,
  }
}
