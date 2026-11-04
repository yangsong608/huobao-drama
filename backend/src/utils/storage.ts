/**
 * 文件存储工具 — 下载远程文件到本地
 */
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { v4 as uuid } from 'uuid'
import { STORAGE_ROOT } from './paths.js'
import {
  getProjectStorageRoot,
  isProjectStoragePath,
  isValidDramaId,
  parseProjectStoragePath,
  projectStorageRelative,
  resolveProjectStorageFile,
} from '../services/project-storage.js'

export interface StorageWriteOptions {
  /** 传入项目 ID 时写入 static/projects/<id>/<subDir>，否则写全局 static/<subDir> */
  dramaId?: number | null
}

/** 计算逻辑相对路径与物理目录 */
function writeTarget(subDir: string, filename: string, options: StorageWriteOptions = {}) {
  if (isValidDramaId(options.dramaId)) {
    return {
      dir: path.join(getProjectStorageRoot(options.dramaId), subDir),
      relative: projectStorageRelative(options.dramaId, subDir, filename),
    }
  }
  return {
    dir: path.join(STORAGE_ROOT, subDir),
    relative: `static/${subDir}/${filename}`,
  }
}

/**
 * 下载远程文件到本地存储
 */
export async function downloadFile(url: string, subDir: string, options: StorageWriteOptions = {}): Promise<string> {
  const ext = getExtFromUrl(url)
  const filename = `${uuid()}${ext}`
  const target = writeTarget(subDir, filename, options)
  fs.mkdirSync(target.dir, { recursive: true })
  const filePath = path.join(target.dir, filename)

  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`)

  const buffer = Buffer.from(await resp.arrayBuffer())
  fs.writeFileSync(filePath, buffer)

  return target.relative
}

/**
 * 保存上传的文件
 */
export async function saveUploadedFile(
  data: ArrayBuffer,
  subDir: string,
  originalName: string,
  options: StorageWriteOptions = {},
): Promise<string> {
  const ext = path.extname(originalName) || '.bin'
  const filename = `${uuid()}${ext}`
  const target = writeTarget(subDir, filename, options)
  fs.mkdirSync(target.dir, { recursive: true })

  fs.writeFileSync(path.join(target.dir, filename), Buffer.from(data))
  return target.relative
}

function getExtFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname
    const ext = path.extname(pathname)
    if (ext && ext.length <= 5) return ext
  } catch {}
  return '.bin'
}

/**
 * 获取本地文件的绝对路径
 * - static/projects/<id>/... → 按项目当前存储根解析（自定义目录/默认目录）
 * - 其他 static/... → 历史全局目录，保持原行为
 */
export function getAbsolutePath(relativePath: string): string {
  const projectPath = parseProjectStoragePath(relativePath)
  if (projectPath) return resolveProjectStorageFile(projectPath.dramaId, projectPath.rest)
  if (isProjectStoragePath(relativePath)) throw new Error(`非法的项目文件路径：${relativePath}`)
  if (relativePath.startsWith('static/')) {
    return path.join(STORAGE_ROOT, '..', relativePath)
  }
  return path.join(STORAGE_ROOT, relativePath)
}

/**
 * 保存 Base64 编码的图片数据到本地存储
 * 用于 Gemini 等只返回 base64 数据的厂商
 */
export async function saveBase64Image(
  base64Data: string,
  mimeType: string,
  subDir: string,
  options: StorageWriteOptions = {},
): Promise<string> {
  // 从 mimeType 推断文件扩展名
  const ext = mimeTypeToExt(mimeType)
  const filename = `${uuid()}${ext}`
  const target = writeTarget(subDir, filename, options)
  fs.mkdirSync(target.dir, { recursive: true })

  const buffer = Buffer.from(base64Data, 'base64')
  fs.writeFileSync(path.join(target.dir, filename), buffer)

  return target.relative
}

/** 由图片相对路径推导缩略图路径：static/images/x.png → static/images/x_thumb.webp */
export function thumbPathFor(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '_thumb.webp')
}

/**
 * 为已落盘图片生成列表页缩略图（宽 400 WebP，与原图同目录）。
 * 失败（文件损坏/格式异常等）返回 null，不阻断主流程。
 */
export async function generateImageThumb(relativePath: string): Promise<string | null> {
  try {
    const thumbRel = thumbPathFor(relativePath)
    await sharp(getAbsolutePath(relativePath))
      .rotate()
      .resize({ width: 400, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(getAbsolutePath(thumbRel))
    return thumbRel
  } catch (err) {
    console.warn(`[storage] 缩略图生成失败 ${relativePath}:`, (err as Error).message)
    return null
  }
}

export function readImageAsDataUrl(relativePath: string): string {
  const filePath = getAbsolutePath(relativePath)
  const buffer = fs.readFileSync(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const mimeType = extToMimeType(ext)
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

export async function readImageAsCompressedDataUrl(
  relativePath: string,
  options: {
    maxWidth?: number
    maxHeight?: number
    quality?: number
  } = {},
): Promise<string> {
  return compressImageAsDataUrl(getAbsolutePath(relativePath), options)
}

/**
 * 下载远程图片并压缩为 data URL（远程参考图归一化，供 multipart/base64 上传类厂商使用）
 */
export async function fetchImageAsCompressedDataUrl(
  url: string,
  options: {
    maxWidth?: number
    maxHeight?: number
    quality?: number
  } = {},
): Promise<string> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!resp.ok) throw new Error(`下载参考图失败: HTTP ${resp.status}`)
  return compressImageAsDataUrl(Buffer.from(await resp.arrayBuffer()), options)
}

/** sharp 输入 → 压缩 JPEG data URL（本地路径与远程下载共享同一压缩管线） */
async function compressImageAsDataUrl(
  input: string | Buffer,
  options: {
    maxWidth?: number
    maxHeight?: number
    quality?: number
  } = {},
): Promise<string> {
  const maxWidth = options.maxWidth ?? 768
  const maxHeight = options.maxHeight ?? 768
  const quality = options.quality ?? 68

  const resized = sharp(input).rotate().resize({
    width: maxWidth,
    height: maxHeight,
    fit: 'inside',
    withoutEnlargement: true,
  })
  const metadata = await resized.metadata()
  const output = metadata.hasAlpha
    ? await resized.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer()
    : await resized.jpeg({ quality, mozjpeg: true }).toBuffer()
  const mimeType = 'image/jpeg'
  return `data:${mimeType};base64,${output.toString('base64')}`
}

export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return {
    mimeType: match[1],
    data: match[2],
  }
}

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }
  return map[mimeType] || '.png'
}

function extToMimeType(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }
  return map[ext] || 'image/png'
}
