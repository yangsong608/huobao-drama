/**
 * 独立应用模式信号插件：壳加载首页时带 client=android-app，或已注入 window.huobaoApp。
 * 在组件挂载前写入本机存储并清理查询参数，PWA 与主机专属入口据此禁用。
 */
import { initAppModeSignal } from '~/composables/useAppBridge'

export default defineNuxtPlugin(() => {
  initAppModeSignal()
})
