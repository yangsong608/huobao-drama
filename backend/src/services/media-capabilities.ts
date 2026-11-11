/**
 * 媒体能力快照：按当前服务端实例判断 FFmpeg/FFprobe，不按设备类型判断。
 *
 * - 30 秒 TTL，成功与失败都缓存，避免每次请求都启动子进程。
 * - `?refresh=1` 跳过缓存；保存媒体设置后由路由主动失效。
 * - 独立应用（HUOBAO_APP=1）本机能力恒为不可用，即使 PATH 上碰巧存在二进制。
 * - 快照只含布尔值、缺失项与探测时间，不返回路径、来源、版本或环境变量。
 */
import { getFfmpegStatus } from '../utils/ffmpeg.js'

export type MediaCapabilityKey = 'outputActions' | 'audioSeparation' | 'voiceActions' | 'ffprobe'

export interface MediaCapabilities {
  ffmpeg: boolean
  ffprobe: boolean
  outputActions: boolean
  audioSeparation: boolean
  voiceActions: boolean
  missing: string[]
  checkedAt: string
}

export const MEDIA_CAPABILITY_TTL_MS = 30_000

function snapshot(ffmpeg: boolean, ffprobe: boolean): MediaCapabilities {
  const both = ffmpeg && ffprobe
  return {
    ffmpeg,
    ffprobe,
    outputActions: both,
    audioSeparation: both,
    voiceActions: both,
    missing: [
      ...(ffmpeg ? [] : ['ffmpeg']),
      ...(ffprobe ? [] : ['ffprobe']),
    ],
    checkedAt: new Date().toISOString(),
  }
}

let cached: MediaCapabilities | null = null
let cachedAt = 0
let inflight: Promise<MediaCapabilities> | null = null

export function isAppMediaMode(): boolean {
  return process.env.HUOBAO_APP === '1'
}

async function probe(): Promise<MediaCapabilities> {
  try {
    const status = await getFfmpegStatus()
    return snapshot(status.ffmpeg.available === true, status.ffprobe.available === true)
  } catch {
    // 探测异常一律按不可用处理，保证结构始终可解析
    return snapshot(false, false)
  }
}

export function invalidateMediaCapabilities(): void {
  cached = null
  cachedAt = 0
  inflight = null
}

export async function getMediaCapabilities(options: { refresh?: boolean } = {}): Promise<MediaCapabilities> {
  if (isAppMediaMode()) return snapshot(false, false)
  if (!options.refresh) {
    const fresh = cached && Date.now() - cachedAt < MEDIA_CAPABILITY_TTL_MS
    if (fresh) return cached as MediaCapabilities
    if (inflight) return inflight
  }
  const pending = probe().then((result) => {
    cached = result
    cachedAt = Date.now()
    return result
  })
  inflight = pending
  void pending.finally(() => {
    if (inflight === pending) inflight = null
  })
  return pending
}

export function mediaCapabilityReady(media: MediaCapabilities, key: MediaCapabilityKey): boolean {
  return media[key] === true
}
