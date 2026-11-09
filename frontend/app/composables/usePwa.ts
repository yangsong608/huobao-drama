/**
 * PWA 运行时状态（模块级单例）
 *
 * - 插件 pwa.client.ts 在应用启动阶段调用 initPwa() 并写入安装/更新状态；
 *   AppHeader 与 PwaStatus 只读取状态、触发动作，不各自维护副本。
 * - 离线判定只认 /api/v1/health 的真实探测结果：单次 3 秒超时，连续失败 2 次才置离线，
 *   任一次成功立即恢复；浏览器网卡在线状态不参与判定（它不代表后端可达）。
 * - Service Worker 的更新只记录「就绪」并提示，不调用 skipWaiting / clients.claim，
 *   也不自动刷新页面；updateDismissed 只影响提示显示，不改变 SW 状态。
 * - initPwa() 幂等：重复调用不会重复绑定监听。
 */
import { readonly, ref, shallowRef, watch } from 'vue'

/** 后端健康检查（同源，根路径部署） */
const HEALTH_PATH = '/api/v1/health'
/** 单次探测超时：3 秒 */
const HEALTH_TIMEOUT_MS = 3000
/** 连续失败次数达到该值才判定离线 */
const HEALTH_FAILURE_LIMIT = 2
/** 离线期间定时复测后端的间隔：15 秒 */
const OFFLINE_RECHECK_MS = 15000

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed', platform?: string }>
}

/** 浏览器可安装事件（beforeinstallprompt 只在满足安装条件时派发） */
const deferredPrompt = shallowRef<BeforeInstallPromptEvent | null>(null)

const canInstall = ref(false)
const isStandalone = ref(false)
const isIos = ref(false)
const offline = ref(false)
const updateReady = ref(false)
const updateDismissed = ref(false)
const installHintOpen = ref(false)

/** initPwa 幂等标记 */
let initialized = false
/** 连续失败计数（成功即清零） */
let failureCount = 0
/** 进行中的健康探测，避免并发请求打出多份失败计数 */
let pendingHealth: AbortController | null = null
/** 离线复测定时器：只在离线期间存在，在线期间必须为 null（不常驻轮询） */
let offlineRecheckTimer: ReturnType<typeof setInterval> | null = null

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const displayStandalone = typeof window.matchMedia === 'function'
    && window.matchMedia('(display-mode: standalone)').matches
  const navigatorStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return displayStandalone || navigatorStandalone
}

function detectIos(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  // iPadOS 13+ 默认桌面 UA 与 macOS 相同，用触点多指特征区分
  const iPadOs = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1
  return /iPad|iPhone|iPod/.test(ua) || iPadOs
}

function recordFailure() {
  failureCount += 1
  if (failureCount >= HEALTH_FAILURE_LIMIT) offline.value = true
}

function recordSuccess() {
  failureCount = 0
  offline.value = false
}

/** 探测后端可达性；resp.ok 即视为可达 */
async function checkHealth(): Promise<void> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return

  pendingHealth?.abort()
  const controller = new AbortController()
  pendingHealth = controller

  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const resp = await fetch(HEALTH_PATH, { signal: controller.signal, cache: 'no-store' })
    if (resp.ok) recordSuccess()
    else recordFailure()
  } catch {
    // 被更新的探测取代时不计数，避免连续事件把失败次数刷到阈值
    if (pendingHealth === controller) recordFailure()
  } finally {
    clearTimeout(timer)
    if (pendingHealth === controller) pendingHealth = null
  }
}

/** 浏览器给出安装能力：存下事件，等待用户从头部入口触发 */
function captureInstallPrompt(event: BeforeInstallPromptEvent): void {
  deferredPrompt.value = event
  canInstall.value = true
}

/** 已安装（appinstalled）：清空安装能力与 iOS 引导 */
function markInstalled(): void {
  deferredPrompt.value = null
  canInstall.value = false
  installHintOpen.value = false
}

/** 新版本已就绪：只提示，不刷新；已关闭提示的不会因再次检测被强制弹出 */
function markUpdateReady(): void {
  updateReady.value = true
}

/** 有安装事件时拉起浏览器安装面板；iOS 没有该事件时改开「分享 → 添加到主屏幕」说明 */
async function promptInstall(): Promise<void> {
  const event = deferredPrompt.value
  if (!event) {
    if (isIos.value && !isStandalone.value) installHintOpen.value = true
    return
  }
  try {
    await event.prompt()
    if (event.userChoice && typeof event.userChoice.then === 'function') await event.userChoice
  } catch {
    /* 用户取消或浏览器拒绝：静默，不阻塞页面 */
  }
  deferredPrompt.value = null
  canInstall.value = false
}

function toggleInstallHint(): void {
  installHintOpen.value = !installHintOpen.value
}

/** 只关闭提示，不影响已就绪的 SW 更新状态 */
function dismissUpdate(): void {
  updateDismissed.value = true
}

function initPwa(): void {
  if (typeof window === 'undefined') return
  if (initialized) return
  initialized = true

  isStandalone.value = detectStandalone()
  isIos.value = detectIos()
  if (isStandalone.value) {
    deferredPrompt.value = null
    canInstall.value = false
  }

  // 网络恢复后立刻复测；接口层捕获到的网络级失败也立即复测，达到阈值才提示离线
  window.addEventListener('online', () => { void checkHealth() })
  window.addEventListener('huobao:network-error', () => { void checkHealth() })

  // 后端（非网卡）故障没有浏览器事件可等：离线期间每 15 秒复测，恢复在线即清除定时器；
  // 在线时不建立定时器，避免常驻轮询。initPwa 幂等 + 启动前判空，不会重复建立。
  watch(offline, (isOffline) => {
    if (isOffline) {
      if (offlineRecheckTimer === null) {
        offlineRecheckTimer = setInterval(() => { void checkHealth() }, OFFLINE_RECHECK_MS)
      }
      return
    }
    if (offlineRecheckTimer !== null) {
      clearInterval(offlineRecheckTimer)
      offlineRecheckTimer = null
    }
  })

  // 页面从后台回到前台时若仍处于离线，立即复测一次；监听随 initPwa 幂等只绑定一次
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && offline.value) void checkHealth()
  })

  void checkHealth()
}

export function usePwa() {
  return {
    canInstall: readonly(canInstall),
    isStandalone: readonly(isStandalone),
    isIos: readonly(isIos),
    offline: readonly(offline),
    updateReady: readonly(updateReady),
    updateDismissed: readonly(updateDismissed),
    installHintOpen: readonly(installHintOpen),
    captureInstallPrompt,
    markInstalled,
    markUpdateReady,
    promptInstall,
    toggleInstallHint,
    dismissUpdate,
    initPwa,
    checkHealth,
  }
}
