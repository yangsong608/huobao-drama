/**
 * 剪辑工作台视频素材：本地上传项目 edit/assets，同内容去重。
 * - 仅允许 MP4 / MOV / WebM / M4V，≤50MB；落盘后由 ffprobe 校验可解码；
 * - 列表返回可直接插入时间线的 EditClipSource（时长/宽高/音轨由探针给出）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { editSourceFromUrl } from './edit-media.js'
import {
  projectStorageRelative,
  projectSubdirPath,
} from './project-storage.js'
import type { EditClipSource } from './edit-plan.js'

const ALLOWED_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v'])
const ALLOWED_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'])
const MAX_BYTES = 50 * 1024 * 1024

function videoAssetError(status: number, code: string, message: string) {
  const error = new Error(message) as Error & { status?: number; code?: string }
  error.status = status
  error.code = code
  return error
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

export interface EditVideoAsset {
  url: string
  label: string
  fingerprint: string
  source: EditClipSource
}

export async function saveEditVideoAsset(
  dramaId: number,
  file: File,
): Promise<{ url: string; source: EditClipSource }> {
  const ext = extOf(file.name)
  const mime = String(file.type || '')
  // MIME 可伪造；扩展名必填，MIME 只在声明了非空且非 octet-stream 时校验
  const mimeKnown = mime && mime !== 'application/octet-stream'
  if (!ALLOWED_EXT.has(ext) || (mimeKnown && !ALLOWED_MIME.has(mime))) {
    throw videoAssetError(400, 'VIDEO_TYPE', '仅支持 MP4 / MOV / WebM / M4V 视频')
  }
  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.byteLength > MAX_BYTES) {
    throw videoAssetError(400, 'VIDEO_TOO_LARGE', '视频不能超过 50MB')
  }

  const fingerprint = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)
  const filename = `${fingerprint.slice(0, 16)}${ext}`
  const relativePath = projectStorageRelative(dramaId, 'edit/assets', filename)
  const absolutePath = path.join(projectSubdirPath(dramaId, 'edit/assets'), filename)
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true })
  if (!fs.existsSync(absolutePath)) await fsp.writeFile(absolutePath, buffer)

  const url = `/${relativePath}`
  try {
    const source = await editSourceFromUrl({
      kind: 'asset',
      id: fingerprint.slice(0, 16),
      url,
      label: file.name,
    })
    return { url, source }
  } catch (cause) {
    await fsp.rm(absolutePath, { force: true }).catch(() => {})
    throw videoAssetError(
      400,
      'VIDEO_DECODE',
      cause instanceof Error ? `视频无法解码：${cause.message}` : '视频无法解码',
    )
  }
}

export async function listEditVideoAssets(dramaId: number): Promise<EditVideoAsset[]> {
  const dir = projectSubdirPath(dramaId, 'edit/assets')
  const files = await fsp.readdir(dir).catch(() => [] as string[])
  const items: EditVideoAsset[] = []
  for (const name of files.filter((n) => ALLOWED_EXT.has(extOf(n))).sort()) {
    const relativePath = projectStorageRelative(dramaId, 'edit/assets', name)
    const url = `/${relativePath}`
    const fingerprint = name.replace(/\.[^.]+$/, '')
    try {
      const source = await editSourceFromUrl({
        kind: 'asset',
        id: fingerprint,
        url,
        label: name,
      })
      items.push({ url, label: name, fingerprint, source })
    } catch {
      // 损坏/不完整的上传文件不进入素材列表，避免插入不可播放片段
    }
  }
  return items
}