/**
 * 视频换人媒体工具：片段源提取、按帧裁切、镜头/整片合并、原声回填与 ffprobe 校验。
 * 所有命令使用参数数组（fluent-ffmpeg），不拼接 shell 字符串。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ffmpeg } from '../utils/ffmpeg.js'

export const SWAP_FPS = 24

export class VideoSwapMediaError extends Error {}

export interface MediaInfo {
  durationMs: number
  width: number
  height: number
  fps: number
  frameCount: number
  hasAudio: boolean
  audioDurationMs: number | null
  videoCodec: string
  audioCodec: string | null
  sizeBytes: number
}

function parseRate(raw: unknown, fallback = SWAP_FPS): number {
  const text = String(raw ?? '').trim()
  const match = /^(\d+)\/(\d+)$/.exec(text)
  if (match) {
    const numerator = Number(match[1])
    const denominator = Number(match[2])
    if (numerator > 0 && denominator > 0) return numerator / denominator
  }
  const value = Number(text)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function run(command: ReturnType<typeof ffmpeg>, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    command
      .output(output)
      .on('end', () => resolve())
      .on('error', (error: Error) => reject(new VideoSwapMediaError(error.message)))
      .run()
  })
}

export function probeMedia(file: string): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, async (error, meta) => {
      if (error) return reject(new VideoSwapMediaError(`读取媒体信息失败：${error.message}`))
      const streams = (meta?.streams || []) as any[]
      const video = streams.find(stream => stream.codec_type === 'video')
      const audio = streams.find(stream => stream.codec_type === 'audio')
      if (!video) return reject(new VideoSwapMediaError('没有视频流'))
      const streamDuration = Number(video.duration)
      const formatDuration = Number(meta?.format?.duration)
      const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : formatDuration
      if (!Number.isFinite(duration) || duration <= 0) {
        return reject(new VideoSwapMediaError('无法读取视频时长'))
      }
      const fps = parseRate(video.avg_frame_rate || video.r_frame_rate)
      const nbFrames = Number(video.nb_frames)
      const frameCount = Number.isFinite(nbFrames) && nbFrames > 0
        ? Math.round(nbFrames)
        : Math.max(1, Math.round(duration * fps))
      const audioDuration = Number(audio?.duration)
      let sizeBytes = 0
      try {
        sizeBytes = (await fsp.stat(file)).size
      } catch {
        sizeBytes = 0
      }
      resolve({
        durationMs: Math.round(duration * 1000),
        width: Number(video.width) || 0,
        height: Number(video.height) || 0,
        fps,
        frameCount,
        hasAudio: Boolean(audio),
        audioDurationMs: Number.isFinite(audioDuration) && audioDuration > 0
          ? Math.round(audioDuration * 1000)
          : null,
        videoCodec: String(video.codec_name || ''),
        audioCodec: audio ? String(audio.codec_name || '') : null,
        sizeBytes,
      })
    })
  })
}

export async function extractSourceChunk(
  source: string,
  output: string,
  startMs: number,
  endMs: number,
): Promise<void> {
  const durationMs = Math.max(1, Math.round(endMs - startMs))
  const info = await probeMedia(source).catch(() => null)
  await fsp.mkdir(path.dirname(output), { recursive: true })
  await fsp.rm(output, { force: true })
  const videoOptions = [
    '-vf', `fps=${SWAP_FPS}`,
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
  ]
  const command = ffmpeg(source)
    .seekInput(startMs / 1000)
    .duration(durationMs / 1000)
    .videoCodec('libx264')
  if (info?.hasAudio) {
    command.outputOptions([...videoOptions, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'])
  } else {
    // 网关工作流的 VHS_LoadVideo 需要音频流，无音轨源必须补静音轨，否则任务直接失败
    command
      .input('anullsrc=r=44100:cl=stereo')
      .inputFormat('lavfi')
      .outputOptions([
        ...videoOptions,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-shortest',
        '-movflags', '+faststart',
      ])
  }
  await run(command, output)
  const stat = await fsp.stat(output).catch(() => null)
  if (!stat || stat.size === 0) throw new VideoSwapMediaError('片段源视频提取失败')
}

/** Relay 首窗口是源身份：前置同源预卷，生成后由 runner 裁掉。 */
export async function extractSourceChunkWithWarmup(
  source: string,
  output: string,
  startMs: number,
  endMs: number,
  warmupFrames: number,
): Promise<void> {
  const frames = Math.max(0, Math.round(warmupFrames))
  if (!frames) {
    await extractSourceChunk(source, output, startMs, endMs)
    return
  }
  const warmupMs = Math.round((frames / SWAP_FPS) * 1000)
  if (startMs >= warmupMs) {
    await extractSourceChunk(source, output, startMs - warmupMs, endMs)
    return
  }
  const tag = `${Date.now()}-${Math.round(startMs)}`
  const pre = `${output}.warmup-${tag}.mp4`
  const chunk = `${output}.chunk-${tag}.mp4`
  try {
    await extractSourceChunk(source, pre, 0, warmupMs)
    await extractSourceChunk(source, chunk, startMs, endMs)
    await concatVideoParts([pre, chunk], output, { audio: true })
  } finally {
    await fsp.rm(pre, { force: true }).catch(() => {})
    await fsp.rm(chunk, { force: true }).catch(() => {})
  }
}

export async function trimChunkVideo(
  input: string,
  output: string,
  headFrames: number,
  coreFrames: number,
  targetSize?: { width: number; height: number },
): Promise<MediaInfo> {
  const info = await probeMedia(input)
  const head = Math.max(0, Math.round(headFrames))
  const core = Math.max(1, Math.round(coreFrames))
  const availableFrames = Math.max(1, Math.floor((info.durationMs / 1000) * SWAP_FPS))
  if (availableFrames < head + core) {
    throw new VideoSwapMediaError(
      `生成片段帧数不足：需要 ${head + core} 帧，实际 ${availableFrames} 帧`,
    )
  }
  await fsp.mkdir(path.dirname(output), { recursive: true })
  await fsp.rm(output, { force: true })
  const width = Math.round(Number(targetSize?.width) || 0)
  const height = Math.round(Number(targetSize?.height) || 0)
  const scale = width > 1 && height > 1
    ? `,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
    : ''
  await run(ffmpeg(input)
    .videoCodec('libx264')
    .outputOptions([
      '-vf', `fps=${SWAP_FPS}${scale},trim=start_frame=${head}:end_frame=${head + core},setpts=PTS-STARTPTS`,
      '-frames:v', String(core),
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-movflags', '+faststart',
    ]), output)
  const trimmed = await probeMedia(output)
  if (Math.abs(trimmed.frameCount - core) > 1) {
    throw new VideoSwapMediaError(`裁切片段帧数异常：期望 ${core}，实际 ${trimmed.frameCount}`)
  }
  return trimmed
}

export async function concatVideoParts(
  parts: string[],
  output: string,
  options: { audio?: boolean } = {},
): Promise<void> {
  if (!parts.length) throw new VideoSwapMediaError('没有可合并的视频片段')
  await fsp.mkdir(path.dirname(output), { recursive: true })
  await fsp.rm(output, { force: true })
  if (parts.length === 1) {
    await fsp.copyFile(parts[0], output)
    return
  }
  const listFile = `${output}.concat.txt`
  const lines = parts.map(item => `file '${item.replace(/'/g, "'\\''")}'`)
  await fsp.writeFile(listFile, `${lines.join('\n')}\n`)
  try {
    await run(ffmpeg()
      .input(listFile)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .videoCodec('libx264')
      .outputOptions([
        '-vf', `fps=${SWAP_FPS}`,
        '-preset', 'veryfast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        ...(options.audio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
        '-movflags', '+faststart',
      ]), output)
  } finally {
    await fsp.rm(listFile, { force: true })
  }
  const info = await probeMedia(output)
  if (info.frameCount <= 0) throw new VideoSwapMediaError('合并视频为空')
}

export async function muxOriginalAudio(
  video: string,
  audioRelativeOrAbsolute: string | null,
  output: string,
): Promise<MediaInfo> {
  await fsp.mkdir(path.dirname(output), { recursive: true })
  await fsp.rm(output, { force: true })
  if (!audioRelativeOrAbsolute || !fs.existsSync(audioRelativeOrAbsolute)) {
    await fsp.copyFile(video, output)
    return probeMedia(output)
  }
  const audioInfo = await probeMedia(audioRelativeOrAbsolute).catch(() => null)
  if (!audioInfo?.hasAudio) {
    await fsp.copyFile(video, output)
    return probeMedia(output)
  }
  await run(ffmpeg(video)
    .input(audioRelativeOrAbsolute)
    .complexFilter('[1:a]apad[a]')
    .outputOptions([
      '-map', '0:v:0',
      '-map', '[a]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
    ]), output)
  return probeMedia(output)
}

export function framesForMs(ms: number, fps = SWAP_FPS): number {
  return Math.max(0, Math.round((Math.max(0, ms) / 1000) * fps))
}

export async function extractLastFrame(input: string, output: string): Promise<void> {
  const info = await probeMedia(input)
  const index = Math.max(0, Math.floor((info.durationMs / 1000) * SWAP_FPS) - 1)
  await fsp.mkdir(path.dirname(output), { recursive: true })
  await fsp.rm(output, { force: true })
  await new Promise<void>((resolve, reject) => {
    ffmpeg(input)
      .outputOptions([
        '-vf', `fps=${SWAP_FPS},select=eq(n\\,${index})`,
        '-vsync', 'vfr',
        '-frames:v', '1',
      ])
      .output(output)
      .on('end', () => resolve())
      .on('error', (error: Error) => reject(new VideoSwapMediaError(`提取片段末帧失败：${error.message}`)))
      .run()
  })
  const stat = await fsp.stat(output).catch(() => null)
  if (!stat || stat.size === 0) throw new VideoSwapMediaError('片段末帧为空')
}
