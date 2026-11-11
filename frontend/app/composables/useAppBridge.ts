/**
 * 独立应用壳（window.huobaoApp）类型声明、应用模式识别与持久化。
 *
 * 壳加载首页时附加 client=android-app 查询参数，或直接注入 window.huobaoApp；
 * 两者任一成立即视为应用模式，写入本机存储供后续路由沿用。
 * 浏览器、服务器与桌面壳环境返回 false，行为不变。
 */
export interface HuobaoAppBridge {
  platform: 'android'
  /** 打开扫码接力（由壳接管相机，结果回传壳内页面） */
  openScanner: () => void
  /** 从电脑桥页面返回本机运行时 */
  backToLocal: () => void
  /** 上报当前活动任务数，供前台服务通知与保活策略使用 */
  setActiveTaskCount: (count: number) => void
  /** 恢复备份后重启本机后端；返回 false 表示壳拒绝了请求 */
  restartBackend: () => boolean
  /** 导出后端与壳日志到系统分享面板 */
  exportLogs: () => Promise<{ ok: boolean, path?: string, error?: string }>
}

export const APP_CLIENT_MODE = 'android-app'
const CLIENT_QUERY_KEY = 'client'
const STORAGE_KEY = 'huobao:client-mode'

let appClient = false
let initialized = false

export function useAppBridge(): HuobaoAppBridge | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { huobaoApp?: HuobaoAppBridge }).huobaoApp ?? null
}

function rememberAppClient(): void {
  appClient = true
  try {
    localStorage.setItem(STORAGE_KEY, APP_CLIENT_MODE)
  } catch {
    /* 存储不可用时仅保留本次会话的内存标记 */
  }
}

/**
 * 在应用启动阶段调用一次：识别壳信号、清理 client 查询参数并持久化。
 * 重复调用无副作用。
 */
export function initAppModeSignal(): void {
  if (typeof window === 'undefined' || initialized) return
  initialized = true

  let fromQuery = false
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.get(CLIENT_QUERY_KEY) === APP_CLIENT_MODE) {
      fromQuery = true
      url.searchParams.delete(CLIENT_QUERY_KEY)
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    }
  } catch {
    /* 地址不可解析时仅依赖壳对象与存储 */
  }

  if (fromQuery || useAppBridge()) {
    rememberAppClient()
    return
  }

  try {
    appClient = localStorage.getItem(STORAGE_KEY) === APP_CLIENT_MODE
  } catch {
    appClient = false
  }
}

export function isAppClient(): boolean {
  if (!initialized) initAppModeSignal()
  return appClient
}

/** 测试用：重置内存标记 */
export function __resetAppModeForTests(): void {
  appClient = false
  initialized = false
}
