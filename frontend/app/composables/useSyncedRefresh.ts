/**
 * 页面级同步刷新注册：
 * - 页面提供路径匹配器与刷新函数，事件命中且可见时 300–500 毫秒防抖刷新。
 * - 隐藏时只记待刷新；恢复可见再执行。
 * - 表单未保存 / 保存中只提示「另一台设备已更新此内容」，由用户选择刷新或保留。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ensureRealtimeSync,
  keepSyncedViewLocal,
  refreshSyncedView,
  registerSyncedView,
  unregisterSyncedView,
  type SyncedView,
} from './useRealtimeSync'

export { hasFocusedEditor } from './useRealtimeSync'

export interface SyncedRefreshOptions {
  /** 同一时刻每个页面只注册一次；用于覆盖热更新重复注册 */
  id: string
  match: (path: string, method: string) => boolean
  refresh: () => unknown | Promise<unknown>
  isDirty?: () => boolean
  isSaving?: () => boolean
}

export function useSyncedRefresh(options: SyncedRefreshOptions) {
  const remoteChange = ref(false)
  const view: SyncedView = {
    id: options.id,
    match: options.match,
    refresh: options.refresh,
    isDirty: options.isDirty,
    isSaving: options.isSaving,
    notify: () => { remoteChange.value = view.conflict },
    pending: false,
    conflict: false,
    timer: null,
  }

  onMounted(() => {
    registerSyncedView(view)
    void ensureRealtimeSync()
  })
  onBeforeUnmount(() => unregisterSyncedView(view))

  async function applyRemoteChange(): Promise<void> {
    remoteChange.value = false
    await refreshSyncedView(view)
  }

  function keepLocalChanges(): void {
    keepSyncedViewLocal(view)
    remoteChange.value = false
  }

  return { remoteChange, applyRemoteChange, keepLocalChanges }
}
