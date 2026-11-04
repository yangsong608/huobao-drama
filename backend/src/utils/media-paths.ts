/**
 * FFmpeg 目录配置的共享路径规则
 * app-settings 负责持久化，db/index 注入读取器，utils/ffmpeg 只消费 loader，避免循环依赖
 */
import os from 'os'
import path from 'path'

export const MEDIA_FFMPEG_DIR_KEY = 'media.ffmpegDir'
const MAX_DIR_LENGTH = 500

export class MediaPathValidationError extends Error {}

export function mediaBinaryName(base: 'ffmpeg' | 'ffprobe'): string {
  return process.platform === 'win32' ? `${base}.exe` : base
}

/** 空值表示自动解析；自定义目录只接受绝对路径，开头的 ~ 展开为 home */
export function normalizeFfmpegDir(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') throw new MediaPathValidationError('ffmpegDir 必须是字符串')
  let dir = value.trim()
  if (!dir) return ''
  if (dir.includes('\0')) throw new MediaPathValidationError('ffmpegDir 包含非法字符')
  if (dir === '~') dir = os.homedir()
  else if (dir.startsWith('~/') || dir.startsWith('~\\')) dir = path.join(os.homedir(), dir.slice(2))
  if (dir.length > MAX_DIR_LENGTH) {
    throw new MediaPathValidationError(`ffmpegDir 不能超过 ${MAX_DIR_LENGTH} 个字符`)
  }
  if (!path.isAbsolute(dir)) throw new MediaPathValidationError('ffmpegDir 必须是绝对路径')
  return dir
}
