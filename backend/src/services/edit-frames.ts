/**
 * 剪辑工作台抽帧（设计 §6.x）：从计划片段的源视频按源时间点抽取 PNG 单帧。
 * - 片段来自 loadProjectPlan（草稿优先，其次当前版本）；
 * - offset 相对片段内容时间，先夹取到片段内，再按变速换算成源时间；
 * - 帧文件落在项目 edit/frames，文件名包含源文件指纹与源时间点，
 *   同一来源同一时间点重复请求直接命中缓存文件；
 * - 长边限制 1920 且不放大，尺寸奇数向下取偶。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { checkFfmpegSuite, ffmpeg } from '../utils/ffmpeg.js'
import { getAbsolutePath } from '../utils/storage.js'
import { fingerprintOfFile } from './edit-media.js'
import { EditWorkspaceError } from './edit-errors.js'
import { loadProjectPlan } from './edit-draft-service.js'
import type { EditProjectRow } from './edit-project-service.js'
import {
  ensureProjectStorageLayout,
  projectStorageRelative,
  projectSubdirPath,
} from './project-storage.js'

const FRAME_MAX_EDGE = 1920

function evenFloor(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2)
}

function scaleFilter(width: number, height: number, maxEdge: number = FRAME_MAX_EDGE): string {
  const longEdge = Math.max(width, height)
  if (longEdge <= maxEdge) return `scale=${evenFloor(width)}:${evenFloor(height)}`
  const ratio = maxEdge / longEdge
  return `scale=${evenFloor(width * ratio)}:${evenFloor(height * ratio)}`
}

function frameError(status: number, code: string, message: string) {
  const error = new Error(message) as Error & { status?: number; code?: string }
  error.status = status
  error.code = code
  return error
}

/**
 * 源文件指纹：size/mtime 的 sha256 摘要（32 位十六进制）。
 * 与 video-frames.ts 的来源指纹思路一致——来源被替换后指纹变化，缓存自动失效。
 */
async function frameFingerprintOf(file: string): Promise<string> {
  const raw = await fingerprintOfFile(file)
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

async function probePngSize(file: string): Promise<{ width: number; height: number }> {
  const sharp = (await import('sharp')).default
  const meta = await sharp(file).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}

function runFfmpegFrame(source: string, seekSeconds: number, filter: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(source)
      .seekInput(seekSeconds)
      .outputOptions(['-frames:v', '1', '-vf', filter])
      .output(output)
      .on('end', () => resolve())
      .on('error', (error: Error) => reject(new Error(`抽帧失败：${error.message}`)))
      .run()
  })
}

export async function extractEditFrame(input: {
  episodeId: number
  project: EditProjectRow
  clipId: string
  offsetMs: number
}): Promise<{ url: string; width: number; height: number; fingerprint: string }> {
  // 没有计划时工程里没有任何片段——对抽帧而言即「片段不存在」（404），
  // 而不是「工程还没有计划」（409，保留给计划类操作）。
  let plan
  try {
    plan = loadProjectPlan(input.project)
  } catch (error) {
    if (error instanceof EditWorkspaceError && error.code === 'EDIT_NO_PLAN') {
      throw frameError(404, 'CLIP_NOT_FOUND', '片段不存在或已被删除')
    }
    throw error
  }
  const clip = plan.clips.find((item) => item.id === input.clipId)
  if (!clip) {
    throw frameError(404, 'CLIP_NOT_FOUND', '片段不存在或已被删除')
  }
  if (clip.kind !== 'video' || !clip.source?.url) {
    throw frameError(400, 'CLIP_NOT_VIDEO', '只有视频片段才能抽帧')
  }

  const contentMs = Math.max(1, clip.sourceOutMs - clip.sourceInMs)
  const offset = Math.min(Math.max(0, Math.round(input.offsetMs)), contentMs - 1)
  const sourceMs = clip.sourceInMs + Math.round(offset * (Number(clip.speed) || 1))

  const sourceAbsolute = getAbsolutePath(clip.source.url)
  if (!fs.existsSync(sourceAbsolute)) {
    throw frameError(422, 'FRAME_SOURCE_MISSING', '片段源视频文件不存在，无法抽帧')
  }

  const fingerprint = await frameFingerprintOf(sourceAbsolute)
  const dramaId = input.project.dramaId
  await ensureProjectStorageLayout(dramaId)
  const filename = `frame-${fingerprint.slice(0, 12)}-${sourceMs}.png`
  const relativePath = projectStorageRelative(dramaId, 'edit/frames', filename)
  const absolutePath = path.join(projectSubdirPath(dramaId, 'edit/frames'), filename)

  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).size === 0) {
    const { ffmpeg: ffmpegOk } = await checkFfmpegSuite()
    if (!ffmpegOk) {
      throw frameError(503, 'FRAME_FFMPEG_UNAVAILABLE', 'FFmpeg 不可用，无法抽帧；请在设置页「通用 → 媒体工具」指定 FFmpeg 目录')
    }
    await fsp.mkdir(path.dirname(absolutePath), { recursive: true })

    // 输入定位可能落在最后一帧之后（源时长与片段出点存在编码误差）导致输出 0 帧，
    // 此时按 80/200/400/800ms 逐步前移重试，最后回落到 0，保证总能取到一帧。
    const seekAttempts = [sourceMs]
    for (const back of [80, 200, 400, 800]) {
      const candidate = sourceMs - back
      if (candidate >= 0 && !seekAttempts.includes(candidate)) seekAttempts.push(candidate)
    }
    if (!seekAttempts.includes(0)) seekAttempts.push(0)

    let extracted = false
    let lastError: Error | null = null
    for (const seekMs of seekAttempts) {
      try {
        await runFfmpegFrame(sourceAbsolute, seekMs / 1000, scaleFilter(clip.source.width, clip.source.height), absolutePath)
        const stat = await fsp.stat(absolutePath).catch(() => null)
        if (stat && stat.size > 0) {
          extracted = true
          break
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
      await fsp.rm(absolutePath, { force: true })
    }
    if (!extracted) {
      await fsp.rm(absolutePath, { force: true })
      throw frameError(500, 'FRAME_EXTRACT_FAILED', lastError?.message || '抽帧失败：源视频无法解码出画面，请稍后重试')
    }
  }

  const outputFingerprint = await frameFingerprintOf(absolutePath)
  const { width, height } = await probePngSize(absolutePath)
  return { url: `/${relativePath}`, width, height, fingerprint: outputFingerprint }
}
