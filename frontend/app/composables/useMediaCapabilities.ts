/**
 * 媒体能力状态（A6）：唯一状态源，按当前连接的服务端判断 FFmpeg/FFprobe。
 * - 启动加载一次；失败 fail-closed 并允许手动重试。
 * - 模块级单例，桌面 / 平板 / 手机使用同一判断，不读取设备类型。
 * - 只有 ready 且对应字段为 true 才允许产出动作。
 */
import { computed, readonly, ref } from 'vue'
import { mediaCapabilitiesAPI } from '~/composables/useApi'

export type MediaCapabilityState = 'idle' | 'loading' | 'ready' | 'failed'
export type MediaCapabilityAction = 'output' | 'separation' | 'voice' | 'probe'
export type MediaBlockReason = 'loading' | 'failed' | 'unavailable' | null

export interface MediaCapabilities {
  ffmpeg: boolean
  ffprobe: boolean
  outputActions: boolean
  audioSeparation: boolean
  voiceActions: boolean
  missing: string[]
  checkedAt: string
}

const REQUEST_TIMEOUT_MS = 12_000

const state = ref<MediaCapabilityState>('idle')
const media = ref<MediaCapabilities | null>(null)
const errorMessage = ref('')
let loadPromise: Promise<void> | null = null

function normalizeMedia(input: any): MediaCapabilities | null {
  const value = input?.media ?? input
  if (!value || typeof value !== 'object') return null
  const bools = ['ffmpeg', 'ffprobe', 'outputActions', 'audioSeparation', 'voiceActions'] as const
  if (!bools.every(key => typeof value[key] === 'boolean')) return null
  if (!Array.isArray(value.missing) || !value.missing.every((item: unknown) => typeof item === 'string')) return null
  if (typeof value.checkedAt !== 'string' || !value.checkedAt) return null
  return {
    ffmpeg: value.ffmpeg,
    ffprobe: value.ffprobe,
    outputActions: value.outputActions,
    audioSeparation: value.audioSeparation,
    voiceActions: value.voiceActions,
    missing: [...value.missing],
    checkedAt: value.checkedAt,
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('media capability timeout')), REQUEST_TIMEOUT_MS)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

async function load(force: boolean): Promise<void> {
  if (!force) {
    if (state.value === 'ready') return
    if (loadPromise) return loadPromise
  }
  state.value = 'loading'
  errorMessage.value = ''
  const pending = (async () => {
    try {
      const result = await withTimeout(mediaCapabilitiesAPI.media())
      const normalized = normalizeMedia(result)
      if (!normalized) throw new Error('invalid media capability payload')
      media.value = normalized
      state.value = 'ready'
    } catch (error: any) {
      // 网络、超时、非 2xx、结构不合法一律按不可用处理
      media.value = null
      state.value = 'failed'
      errorMessage.value = error?.message || String(error)
    } finally {
      loadPromise = null
    }
  })()
  loadPromise = pending
  return pending
}

function fieldFor(action: MediaCapabilityAction): keyof MediaCapabilities {
  if (action === 'separation') return 'audioSeparation'
  if (action === 'voice') return 'voiceActions'
  if (action === 'probe') return 'ffprobe'
  return 'outputActions'
}

function actionReady(action: MediaCapabilityAction): boolean {
  return state.value === 'ready' && media.value?.[fieldFor(action)] === true
}

function blockReason(action: MediaCapabilityAction): MediaBlockReason {
  if (state.value === 'ready') return actionReady(action) ? null : 'unavailable'
  if (state.value === 'failed') return 'failed'
  return 'loading'
}

export function useMediaCapabilities() {
  return {
    state: readonly(state),
    media: readonly(media),
    error: readonly(errorMessage),
    ensureLoaded: () => load(false),
    refresh: () => load(true),
    actionReady,
    blockReason,
    outputReady: computed(() => actionReady('output')),
    separationReady: computed(() => actionReady('separation')),
    voiceReady: computed(() => actionReady('voice')),
    probeReady: computed(() => actionReady('probe')),
  }
}

/** 503 兜底：命中 MEDIA_UNAVAILABLE 时强制刷新能力，返回是否命中 */
export function handleMediaCapabilityError(error: any): boolean {
  if (error?.errorCode !== 'MEDIA_UNAVAILABLE') return false
  void load(true)
  return true
}
