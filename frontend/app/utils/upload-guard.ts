/**
 * 上传预检（平板相册/文件选择前置校验）
 *
 * - 只做类型与大小判断，不读接口、不碰 DOM，服务端与单元测试可直接调用
 * - 上限复用 tablet-layout 的 VIDEO_UPLOAD_MAX_MB / AUDIO_UPLOAD_MAX_MB，不重复定义数值
 * - 扩展名优先（iPad 相册可能给空 MIME），MIME 作为补充
 * - HEIC/HEIF 优先于 type 判定：前端直接拒绝，提示改用 JPEG/PNG/WebP
 */
import { AUDIO_UPLOAD_MAX_MB, VIDEO_UPLOAD_MAX_MB } from './tablet-layout.ts'

export const VIDEO_MAX_BYTES = VIDEO_UPLOAD_MAX_MB * 1024 * 1024
export const AUDIO_MAX_BYTES = AUDIO_UPLOAD_MAX_MB * 1024 * 1024
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024

export type UploadKind = 'image' | 'video' | 'audio'
export type UploadErrorReason = 'heic' | 'type' | 'too-large'

export interface UploadCheck {
  ok: boolean
  reason?: UploadErrorReason
  limitBytes?: number
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'webm'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac'])
const HEIC_EXTENSIONS = new Set(['heic', 'heif'])

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'])
const AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'audio/aac',
])
const HEIC_MIMES = new Set(['image/heic', 'image/heif'])

function extensionOf(name: string): string {
  const raw = String(name || '').trim()
  const dot = raw.lastIndexOf('.')
  if (dot < 0 || dot === raw.length - 1) return ''
  return raw.slice(dot + 1).toLowerCase()
}

function mimeOf(type: string): string {
  return String(type || '').toLowerCase().split(';')[0].trim()
}

function allowedExtensions(kind: UploadKind): Set<string> {
  if (kind === 'image') return IMAGE_EXTENSIONS
  if (kind === 'video') return VIDEO_EXTENSIONS
  return AUDIO_EXTENSIONS
}

function allowedMimes(kind: UploadKind): Set<string> {
  if (kind === 'image') return IMAGE_MIMES
  if (kind === 'video') return VIDEO_MIMES
  return AUDIO_MIMES
}

function limitBytesFor(kind: UploadKind, maxBytes?: number): number {
  if (typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0) return maxBytes
  if (kind === 'video') return VIDEO_MAX_BYTES
  if (kind === 'audio') return AUDIO_MAX_BYTES
  // 图片默认不限大小，避免误伤既有 /upload/image 入口；需要时由调用方传 maxBytes
  return 0
}

export function checkUploadFile(
  file: { name?: string; type?: string; size?: number },
  kind: UploadKind,
  options: { maxBytes?: number } = {},
): UploadCheck {
  const name = String(file?.name || '')
  const mime = mimeOf(String(file?.type || ''))
  const size = Number(file?.size) || 0
  const extension = extensionOf(name)

  if (HEIC_EXTENSIONS.has(extension) || HEIC_MIMES.has(mime)) return { ok: false, reason: 'heic' }

  const typeOk = allowedExtensions(kind).has(extension) || allowedMimes(kind).has(mime)
  if (!typeOk) return { ok: false, reason: 'type' }

  const limitBytes = limitBytesFor(kind, options.maxBytes)
  if (limitBytes > 0 && size > limitBytes) return { ok: false, reason: 'too-large', limitBytes }

  return { ok: true }
}

export function uploadErrorKey(check: UploadCheck, kind: UploadKind): string {
  if (check?.reason === 'heic') return 'tablet.upload.heic'
  if (check?.reason === 'too-large') {
    if (kind === 'video') return 'tablet.upload.videoTooLarge'
    if (kind === 'audio') return 'tablet.upload.audioTooLarge'
    return 'tablet.upload.imageTooLarge'
  }
  if (kind === 'video') return 'tablet.upload.videoTypes'
  if (kind === 'audio') return 'tablet.upload.audioTypes'
  return 'tablet.upload.imageTypes'
}
