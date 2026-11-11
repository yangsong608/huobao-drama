/**
 * PWA 客户端插件：应用启动阶段（组件挂载前）接线安装能力、SW 注册与离线探测。
 *
 * - 注册条件同时满足才注册 SW：生产构建、支持 serviceWorker、安全上下文、非桌面壳、非独立应用。
 *   开发环境、Electron 与内嵌独立应用永不注册；三者都跳过全部 PWA 逻辑。
 * - 只监听并记录「安装可用 / 已安装 / 新版本就绪」，不发强制跳过消息、不自动刷新。
 * - 注册失败静默，不阻塞应用启动。
 */
import { isAppClient } from '~/composables/useAppBridge'
import { usePwa, type BeforeInstallPromptEvent } from '~/composables/usePwa'

export default defineNuxtPlugin(() => {
  if (typeof window === 'undefined') return

  // preload 注入的桌面壳标记（仅 Electron 内存在）；桌面壳跳过全部 PWA 逻辑
  const hasDesktopShell = Boolean((window as Window & { huobaoDesktop?: unknown }).huobaoDesktop)
  // 内嵌独立应用由壳加载本机运行时，不安装 PWA；WebView 也不支持安装提示
  const hasAppShell = isAppClient()
  if (hasDesktopShell || hasAppShell) return

  const {
    captureInstallPrompt,
    markInstalled,
    markUpdateReady,
    initPwa,
  } = usePwa()

  initPwa()

  // 挂载前就监听，避免 beforeinstallprompt 早于组件挂载而丢失
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    captureInstallPrompt(event as BeforeInstallPromptEvent)
  })

  window.addEventListener('appinstalled', () => {
    markInstalled()
  })

  // 注册条件必须同时满足：生产构建、支持 SW、安全上下文、非桌面壳、非独立应用
  const canRegisterServiceWorker = import.meta.env.PROD
    && 'serviceWorker' in navigator
    && window.isSecureContext
    && !hasDesktopShell
    && !hasAppShell

  /**
   * 跟踪安装中的 worker：变为 installed 且已有 controller 才算「更新就绪」。
   * 注册 resolve 前就已存在的 installing / updatefound 之后的新 worker 共用此逻辑；
   * 首次安装没有 controller，不得置 updateReady。
   */
  function trackInstallingWorker(
    registration: ServiceWorkerRegistration,
    installing: ServiceWorker | null,
  ): void {
    if (!installing) return
    if (installing.state === 'installed' && navigator.serviceWorker.controller) {
      markUpdateReady()
      return
    }
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        markUpdateReady()
      }
    })
  }

  if (!canRegisterServiceWorker) return

  navigator.serviceWorker
    .register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then((registration) => {
      // 上次遗留的等待中 worker：只提示，由用户自行选择重新打开
      if (registration.waiting && navigator.serviceWorker.controller) markUpdateReady()

      // 注册 resolve 前已开始安装的 worker：补挂跟踪，避免漏掉更新事件
      trackInstallingWorker(registration, registration.installing)

      registration.addEventListener('updatefound', () => {
        trackInstallingWorker(registration, registration.installing)
      })
    })
    .catch(() => {
      /* 注册失败静默 */
    })
})
