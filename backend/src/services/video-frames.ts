/**
 * 过渡首尾帧提取 — 从已生成的镜头视频取真实首帧/尾帧
 *
 * 帧文件落在项目 transitions/frames，文件名包含来源指纹（路径/大小/mtime），
 * 源视频被替换后自动换新名，避免合片误用旧画面。首尾各内缩 0.1s，
 * 规避编码首尾黑帧；长边限制 1280 且不放大。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'
import { getAbsolutePath } from '../utils/storage.js'
import {
  ensureProjectStorageLayout,
  parseProjectStoragePath,
  projectStorageRelative,
  projectSubdirPath,
} from './project-storage.js'

export type FramePosition = 'first' | 'last'

export interface ExtractedFrame {
  relativePath: string
  absolutePath: string
  width: number
  height: number
}

export interface ExtractFrameOptions {
  /** 缺省时从项目逻辑路径解析 */
  dramaId?: number
  maxEdge?: number
  /** 文件前缀，默认取源文件名；过渡调用传 sb-<id> */
  label?: string
}

interface VideoMeta {
  duration: number
  width: number
  height: number
}

function probeVideo(file: string): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, meta) => {
      if (err) return reject(new Error(`读取视频信息失败：${err.message}`))
      const stream = (meta?.streams || []).find(item => item.codec_type === 'video')
      const duration = Number(meta?.format?.duration)
      if (!stream || !stream.width || !stream.height || !Number.isFinite(duration) || duration <= 0) {
        return reject(new Error('无法读取视频宽高或时长'))
      }
      resolve({ duration, width: stream.width, height: stream.height })
    })
  })
}

function probeImageSize(file: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, meta) => {
      if (err) return reject(err)
      const stream = (meta?.streams || []).find(item => item.codec_type === 'video')
      if (!stream?.width || !stream?.height) return reject(new Error('抽帧结果无法读取尺寸'))
      resolve({ width: stream.width, height: stream.height })
    })
  })
}

function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2)
}

function scaleFilter(width: number, height: number, maxEdge: number): string {
  const longEdge = Math.max(width, height)
  if (longEdge <= maxEdge) return `scale=${evenFloor(width)}:${evenFloor(height)}`
  const ratio = maxEdge / longEdge
  return `scale=${evenFloor(width * ratio)}:${evenFloor(height * ratio)}`
}

function seekSeconds(position: FramePosition, duration: number): number {
  if (duration < 0.3) return position === 'first' ? 0 : Math.max(0, duration - 0.02)
  return position === 'first' ? 0.1 : Math.max(0, duration - 0.1)
}

function sourceHash(sourcePath: string, stat: fs.Stats): string {
  return crypto
    .createHash('sha256')
    .update([sourcePath, stat.size, stat.mtimeMs].join('|'))
    .digest('hex')
    .slice(0, 12)
}

function safeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'frame'
}

/** 抽取镜头视频首帧或尾帧；目标文件已存在且可读时直接复用 */
export async function extractVideoFrame(
  videoRelativePath: string,
  position: FramePosition,
  options: ExtractFrameOptions = {},
): Promise<ExtractedFrame> {
  const { ffmpeg: ffmpegOk, ffprobe: ffprobeOk } = await checkFfmpegSuite()
  if (!ffmpegOk || !ffprobeOk) {
    throw new Error('FFmpeg/FFprobe 不可用，无法提取过渡首尾帧；请在设置页「通用 → 媒体工具」指定 FFmpeg 目录')
  }

  const sourceAbsolute = getAbsolutePath(videoRelativePath)
  let stat: fs.Stats
  try {
    stat = fs.statSync(sourceAbsolute)
  } catch {
    throw new Error(`源视频不存在：${videoRelativePath}，请先重新生成镜头视频`)
  }
  if (!stat.isFile()) throw new Error(`源视频不存在：${videoRelativePath}，请先重新生成镜头视频`)

  const dramaId = options.dramaId ?? parseProjectStoragePath(videoRelativePath)?.dramaId
  if (!dramaId) throw new Error('过渡抽帧需要项目 ID')

  const label = safeLabel(options.label || path.basename(videoRelativePath, path.extname(videoRelativePath)))
  const filename = `${label}-${position}-${sourceHash(videoRelativePath, stat)}.jpg`
  const relativePath = projectStorageRelative(dramaId, 'transitions/frames', filename)
  const absolutePath = path.join(projectSubdirPath(dramaId, 'transitions/frames'), filename)

  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).size > 0) {
    try {
      const size = await probeImageSize(absolutePath)
      return { relativePath, absolutePath, ...size }
    } catch {
      await fsp.rm(absolutePath, { force: true })
    }
  }

  await ensureProjectStorageLayout(dramaId)
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true })

  const meta = await probeVideo(sourceAbsolute)
  const filter = scaleFilter(meta.width, meta.height, options.maxEdge ?? 1280)
  await new Promise<void>((resolve, reject) => {
    ffmpeg(sourceAbsolute)
      .seekInput(seekSeconds(position, meta.duration))
      .outputOptions(['-frames:v', '1', '-vf', filter, '-q:v', '2'])
      .output(absolutePath)
      .on('end', () => resolve())
      .on('error', (error: Error) => reject(new Error(`抽帧失败：${error.message}`)))
      .run()
  })

  const outputStat = await fsp.stat(absolutePath).catch(() => null)
  if (!outputStat || outputStat.size === 0) {
    await fsp.rm(absolutePath, { force: true })
    throw new Error(`抽帧结果为空：${videoRelativePath}`)
  }

  const size = await probeImageSize(absolutePath)
  return { relativePath, absolutePath, ...size }
}
