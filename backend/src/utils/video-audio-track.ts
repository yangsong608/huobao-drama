import fs from 'node:fs'
import path from 'node:path'
import { v4 as uuid } from 'uuid'
import { ffmpeg } from './ffmpeg.js'

export function hasAudioStream(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) {
        resolve(false)
        return
      }
      resolve((metadata.streams || []).some((stream) => stream.codec_type === 'audio'))
    })
  })
}

/**
 * 静音模式兜底：部分云端模型忽略 audio_mode 仍返回带原声的视频。
 * 只重封装视频流，不改编码；无音轨时直接返回 false。
 */
export async function stripVideoAudio(file: string): Promise<boolean> {
  if (!(await hasAudioStream(file))) return false
  const ext = path.extname(file) || '.mp4'
  const temp = path.join(path.dirname(file), `.noaudio-${uuid()}${ext}`)
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(file)
        .noAudio()
        .videoCodec('copy')
        .output(temp)
        .on('end', () => resolve())
        .on('error', (error) => reject(error))
        .run()
    })
    fs.renameSync(temp, file)
    return true
  } finally {
    fs.rmSync(temp, { force: true })
  }
}
