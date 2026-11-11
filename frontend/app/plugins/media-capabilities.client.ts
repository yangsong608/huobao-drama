/**
 * 启动加载媒体能力：桌面 / 平板 / 手机一致，不跳过任何客户端。
 * 503 MEDIA_UNAVAILABLE 时统一提示并强制刷新，避免按钮停留在旧状态。
 */
import { toast } from 'vue-sonner'
import { i18n } from '~/composables/i18n'
import { useMediaCapabilities } from '~/composables/useMediaCapabilities'

export default defineNuxtPlugin(() => {
  const caps = useMediaCapabilities()
  void caps.ensureLoaded()
  if (typeof window === 'undefined') return
  window.addEventListener('huobao:media-unavailable', () => {
    toast.warning(i18n.global.t('media.capability.actionDisabled'))
    void caps.refresh()
  })
})
