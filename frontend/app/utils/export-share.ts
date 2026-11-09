/**
 * 导出产物分享（平板 Web Share / 链接回退）
 *
 * - 纯函数决策：无 share → 不分享；不能分享文件 → 链接；尺寸未知或超限 → 链接
 * - 只有已知 sizeBytes ≤ SHARE_FILE_LIMIT 才会 fetch 成 File，避免把大文件整体读进内存
 * - 用户取消（AbortError）一律静默返回 cancelled，不弹错误
 * - 不读接口、不依赖组件，Node 与浏览器都能调用（默认值在调用时才解析）
 */
import { SHARE_FILE_LIMIT } from './tablet-layout.ts'

export type ShareMode = 'files' | 'link' | 'none'
export type ShareOutcome = 'shared-files' | 'shared-link' | 'fallback-link' | 'cancelled' | 'opened' | 'failed'

interface ShareNavigator {
  share?: (data: ShareData) => Promise<void>
  canShare?: (data: ShareData) => boolean
}

interface ShareFetchResponse {
  ok: boolean
  blob: () => Promise<Blob>
}

export interface ShareUrlOrFileOptions {
  url: string
  title?: string
  text?: string
  sizeBytes?: number | null
  fileName?: string
  nav?: ShareNavigator | null
  fetchImpl?: (input: string, init?: RequestInit) => Promise<ShareFetchResponse>
  openImpl?: (url: string) => void
}

export function decideShareMode(input: {
  hasShare: boolean
  canShareFiles: boolean
  sizeBytes?: number | null
}): ShareMode {
  if (!input.hasShare) return 'none'
  if (!input.canShareFiles) return 'link'
  const size = input.sizeBytes
  // 尺寸未知不下载：一律走链接分享，避免大文件整体读入内存
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return 'link'
  if (size > SHARE_FILE_LIMIT) return 'link'
  return 'files'
}

export function probeCanShareFiles(nav: { canShare?: (data: ShareData) => boolean } | null | undefined): boolean {
  if (!nav || typeof nav.canShare !== 'function') return false
  if (typeof File === 'undefined') return false
  try {
    const probe = new File([new Uint8Array([0])], 'probe.bin', { type: 'application/octet-stream' })
    return Boolean(nav.canShare({ files: [probe] }))
  } catch {
    return false
  }
}

export function shareNoticeKey(
  outcome: ShareOutcome,
): 'tablet.share.gestureFallback' | 'tablet.share.opened' | 'tablet.share.failed' | null {
  if (outcome === 'fallback-link') return 'tablet.share.gestureFallback'
  if (outcome === 'opened') return 'tablet.share.opened'
  if (outcome === 'failed') return 'tablet.share.failed'
  return null
}

export function withObjectUrl<T>(
  blob: Blob,
  action: (url: string) => T,
  deps: { create?: (blob: Blob) => string; revoke?: (url: string) => void } = {},
): T {
  const create = deps.create || ((value: Blob) => URL.createObjectURL(value))
  const revoke = deps.revoke || ((url: string) => URL.revokeObjectURL(url))
  const url = create(blob)
  try {
    return action(url)
  } finally {
    revoke(url)
  }
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError')
}

function resolveFileName(fileName: string | undefined, url: string): string {
  const explicit = String(fileName || '').trim()
  if (explicit) return explicit
  try {
    const path = new URL(url, 'http://localhost').pathname
    const last = decodeURIComponent(path.split('/').filter(Boolean).pop() || '')
    if (last) return last
  } catch {
    // URL 不可解析时退回固定名称
  }
  return 'export.bin'
}

function toFile(blob: Blob, fileName: string | undefined, url: string): File {
  const type = blob && blob.type ? blob.type : 'application/octet-stream'
  return new File([blob], resolveFileName(fileName, url), { type })
}

function defaultNavigator(): ShareNavigator | null {
  if (typeof navigator === 'undefined') return null
  return navigator as unknown as ShareNavigator
}

function defaultOpen(url: string) {
  if (typeof window === 'undefined') throw new Error('window unavailable')
  // windowFeatures 带 noopener/noreferrer 时 window.open 规范上恒返回 null，无法区分「已打开」与「被拦截」；
  // 先取窗口引用再断开 opener 并导航，兼顾拦截判定与 tabnabbing 防护。
  const win = window.open('about:blank', '_blank')
  if (!win) throw new Error('popup blocked')
  win.opener = null
  win.location.href = url
}

function defaultFetch(input: string, init?: RequestInit): Promise<ShareFetchResponse> {
  return fetch(input, init) as unknown as Promise<ShareFetchResponse>
}

export async function shareUrlOrFile(options: ShareUrlOrFileOptions): Promise<ShareOutcome> {
  const url = String(options.url || '')
  const nav = options.nav !== undefined ? options.nav : defaultNavigator()
  const openImpl = options.openImpl || defaultOpen
  const fetchImpl = options.fetchImpl || defaultFetch
  const { title, text } = options

  function openUrl(): ShareOutcome {
    try {
      openImpl(url)
      return 'opened'
    } catch {
      return 'failed'
    }
  }

  const hasShare = Boolean(nav && typeof nav.share === 'function')
  if (!hasShare) return openUrl()

  const share = nav!.share!.bind(nav)

  function canShareFile(file: File): boolean {
    if (!nav || typeof nav.canShare !== 'function') return false
    try {
      return Boolean(nav.canShare({ files: [file] }))
    } catch {
      return false
    }
  }

  async function shareLink(): Promise<ShareOutcome> {
    try {
      await share({ url, title, text })
      return 'shared-link'
    } catch (error) {
      if (isAbortError(error)) return 'cancelled'
      return openUrl()
    }
  }

  const mode = decideShareMode({ hasShare, canShareFiles: probeCanShareFiles(nav), sizeBytes: options.sizeBytes })
  if (mode !== 'files') return shareLink()

  let file: File | null = null
  try {
    const response = await fetchImpl(url, { credentials: 'same-origin' })
    if (response && response.ok) file = toFile(await response.blob(), options.fileName, url)
  } catch {
    file = null
  }
  if (!file) return shareLink()
  if (file.size > SHARE_FILE_LIMIT) return shareLink()
  if (!canShareFile(file)) return shareLink()

  try {
    await share({ files: [file], title, text })
    return 'shared-files'
  } catch (error) {
    if (isAbortError(error)) return 'cancelled'
    const linkOutcome = await shareLink()
    if (linkOutcome === 'shared-link' || linkOutcome === 'opened') return 'fallback-link'
    if (linkOutcome === 'cancelled') return 'cancelled'
    try {
      withObjectUrl(file, openImpl)
      return 'opened'
    } catch {
      return 'failed'
    }
  }
}
