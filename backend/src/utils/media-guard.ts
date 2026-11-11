/**
 * 四类媒体产出守卫：在解析请求体、写库、启动任务之前检查当前服务端能力。
 * 读接口、编辑接口与可降级增强（海报帧、波形、缩略帧）不使用本守卫。
 */
import type { MiddlewareHandler } from 'hono'
import {
  getMediaCapabilities,
  type MediaCapabilityKey,
} from '../services/media-capabilities.js'
import { mediaUnavailable } from './response.js'

export function mediaGate(key: MediaCapabilityKey = 'outputActions'): MiddlewareHandler {
  return async (c, next) => {
    const media = await getMediaCapabilities()
    if (media[key] !== true) return mediaUnavailable(c)
    await next()
  }
}

export const outputGate = mediaGate('outputActions')
export const separationGate = mediaGate('audioSeparation')
export const voiceGate = mediaGate('voiceActions')
export const ffprobeGate = mediaGate('ffprobe')
