/**
 * 剪辑工作台图片素材（设计 §6.x）：上传入库项目 edit/assets，同内容去重。
 * - 仅允许 PNG / JPG / WebP，≤20MB，≤4096×4096（按解码后的真实格式校验）；
 * - 文件名取内容 sha256 摘要前 16 位，同内容上传天然命中同一文件；
 * - 列表合并「已上传图片 + 分镜首帧/合成图」，供前端素材选择器使用。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  projectStorageRelative,
  projectSubdirPath,
} from './project-storage.js'

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_BYTES = 20 * 1024 * 1024
const MAX_EDGE = 4096

export interface EditImageAsset {
  url: string
  width: number
  height: number
  fingerprint: string
  source: 'uploaded' | 'storyboard'
  label: string
}

function assetError(status: number, code: string, message: string) {
  const error = new Error(message) as Error & { status?: number; code?: string }
  error.status = status
  error.code = code
  return error
}

export async function saveEditImageAsset(
  dramaId: number,
  file: File,
): Promise<{ url: string; width: number; height: number; fingerprint: string }> {
  if (!ALLOWED.has(file.type)) throw assetError(400, 'IMAGE_TYPE', '仅支持 PNG / JPG / WebP 图片')
  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.byteLength > MAX_BYTES) throw assetError(400, 'IMAGE_TOO_LARGE', '图片不能超过 20MB')

  const sharp = (await import('sharp')).default
  const meta = await sharp(buffer).metadata().catch(() => null)
  const format = meta?.format === 'jpg' ? 'jpeg' : meta?.format
  if (!meta || !format || !ALLOWED.has(`image/${format}`)) {
    throw assetError(400, 'IMAGE_DECODE', '图片无法解码，请换一张 PNG / JPG / WebP 图片')
  }
  if ((meta.width ?? 0) > MAX_EDGE || (meta.height ?? 0) > MAX_EDGE) {
    throw assetError(400, 'IMAGE_DIMENSIONS', '图片尺寸不能超过 4096×4096')
  }

  const fingerprint = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)
  const ext = format === 'jpeg' ? 'jpg' : format
  const filename = `${fingerprint.slice(0, 16)}.${ext}`
  const relativePath = projectStorageRelative(dramaId, 'edit/assets', filename)
  const absolutePath = path.join(projectSubdirPath(dramaId, 'edit/assets'), filename)
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true })
  if (!fs.existsSync(absolutePath)) await fsp.writeFile(absolutePath, buffer)
  return { url: `/${relativePath}`, width: meta.width ?? 0, height: meta.height ?? 0, fingerprint }
}

export async function listEditImageAssets(dramaId: number): Promise<EditImageAsset[]> {
  const sharp = (await import('sharp')).default
  const dir = projectSubdirPath(dramaId, 'edit/assets')
  const files = await fsp.readdir(dir).catch(() => [] as string[])
  const uploaded: EditImageAsset[] = []
  for (const name of files.filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).sort()) {
    const absolutePath = path.join(dir, name)
    const meta = await sharp(absolutePath).metadata().catch(() => null)
    if (!meta?.width || !meta?.height) continue
    const relativePath = projectStorageRelative(dramaId, 'edit/assets', name)
    uploaded.push({
      url: `/${relativePath}`,
      width: meta.width,
      height: meta.height,
      fingerprint: name.replace(/\.[^.]+$/, ''),
      source: 'uploaded',
      label: name,
    })
  }
  return uploaded
}
