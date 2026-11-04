/**
 * FFmpeg 多镜头拼接 — 将所有生成后的镜头视频拼接为一集
 */
import fs from 'fs'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { db, getInsertId, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'
import { getAbsolutePath } from '../utils/storage.js'
import { projectSubdirPath, projectStorageRelative } from './project-storage.js'
import { buildMergeTransitionGraph, computeMergeSourceHash, mergeTransitionStyle } from './merge-plan.js'
import { prepareTransitionInsertion, type TransitionSnapshotEntry } from './transition-merge.js'
import { normalizeVideoAudioMode, type VideoAudioMode } from './video-audio.js'

interface MergeClip {
  url: string
  transition: string
  transitionMs?: number | null
  transitionId?: number
}

export interface MergeOptions {
  useAiTransitions?: boolean
  /** 过渡片段两端相对上一片的转场时长（毫秒，默认 200） */
  transitionMs?: number
}

function toAbsPath(relativePath: string): string {
  return path.isAbsolute(relativePath) ? relativePath : getAbsolutePath(relativePath)
}

/**
 * 拼接一集的镜头视频。
 * 优先使用视频生成产物，兼容历史的 composedVideoUrl 数据。
 * 传入 storyboardIds 时只拼接所选镜头（仍按镜号顺序）。
 */
export async function mergeEpisodeVideos(
  episodeId: number,
  dramaId: number,
  storyboardIds?: number[],
  title?: string,
  options: MergeOptions = {},
): Promise<number> {
  const episode = await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  const audioMode = normalizeVideoAudioMode(episode?.videoAudioMode)

  let storyboards = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)

  if (storyboardIds?.length) {
    const allow = new Set(storyboardIds.map(Number))
    storyboards = storyboards.filter(sb => allow.has(sb.id))
  }

  // 允许部分拼接:按镜号顺序拼接已生成的镜头,未生成的跳过
  const baseClips = storyboards
    .map(sb => ({
      id: sb.id,
      url: sb.videoUrl || sb.composedVideoUrl || '',
      transition: sb.transition || 'cut',
    }))
    .filter(c => Boolean(c.url))

  if (baseClips.length === 0) throw new Error('所选镜头还没有可拼接的视频')

  let clips: MergeClip[] = baseClips.map(({ url, transition }) => ({ url, transition }))
  let transitionsSnapshot: TransitionSnapshotEntry[] = []
  let transitionUsed = 0
  let transitionFallback = 0
  if (options.useAiTransitions) {
    const prepared = await prepareTransitionInsertion(episodeId, baseClips, { transitionMs: options.transitionMs })
    clips = prepared.clips.map(clip => ({
      url: clip.url,
      transition: clip.transition || 'cut',
      transitionMs: clip.transitionMs,
      transitionId: clip.transitionId,
    }))
    transitionsSnapshot = prepared.snapshot
    transitionUsed = prepared.used
    transitionFallback = prepared.fallback
    logTaskStart('MergeTask', 'ai-transitions', {
      episodeId, used: transitionUsed, fallback: transitionFallback,
    })
  }

  // 拼接前探测 ffmpeg：二进制损坏时 fluent-ffmpeg 的同步 EFTYPE 会崩掉整个进程，
  // 这里提前拦截并给出可操作的修复指引（路由层会作为 400 返回前端）
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe) {
    throw new Error('本机 ffmpeg 不可用，无法拼接视频（常见于 node_modules 跨平台拷贝或 ffmpeg-static 下载损坏）。请删除 node_modules 后在本机重新 npm install，或设置 FFMPEG_BIN 指向有效的 ffmpeg 可执行文件后重启服务')
  }

  // 校验视频文件真实存在:DB 里的 video_url 可能指向已被清理的文件,
  // 直接拼会得到 ffmpeg 的 "No such file or directory" 晦涩报错
  const missing = baseClips.filter(c => !fs.existsSync(toAbsPath(c.url)))
  if (missing.length > 0) {
    const nums = missing.map(c => `S${baseClips.indexOf(c) + 1}`).join('、')
    throw new Error(`镜头 ${nums} 的视频文件已丢失（本地文件不存在），请重新生成这些镜头的视频，或在拼接时取消勾选`)
  }

  const videos = baseClips.map(c => c.url)

  logTaskStart('MergeTask', 'episode-merge', { episodeId, dramaId, clips: videos.length })

  // 创建 merge 记录
  const ts = now()
  const res = await db.insert(schema.videoMerges).values({
    episodeId,
    dramaId,
    title: title?.trim() || `Episode ${episodeId} Merge`,
    provider: 'ffmpeg',
    model: 'ffmpeg-concat-h264-aac',
    status: 'processing',
    scenes: JSON.stringify(videos),
    transitions: options.useAiTransitions ? JSON.stringify(transitionsSnapshot) : null,
    sourceHash: computeMergeSourceHash(clips, audioMode),
    mixOptions: JSON.stringify({
      audioMode,
      ...(options.useAiTransitions
        ? { aiTransitions: { requested: true, used: transitionUsed, fallback: transitionFallback } }
        : {}),
    }),
    createdAt: ts,
  })
  const mergeId = getInsertId(res)

  // 异步执行
  doMerge(mergeId, episodeId, dramaId, clips, audioMode).catch(async err => {
    logTaskError('MergeTask', 'episode-merge', { mergeId, episodeId, error: err.message })
    console.error(`[Merge] Failed:`, err)
    await db.update(schema.videoMerges)
      .set({ status: 'failed', errorMsg: err.message })
      .where(eq(schema.videoMerges.id, mergeId))
  })

  return mergeId
}

async function doMerge(mergeId: number, episodeId: number, dramaId: number, clips: MergeClip[], audioMode: VideoAudioMode) {
  const videos = clips.map(clip => clip.url)
  // 生成 concat 列表文件（项目临时目录；归档/清理时随项目一起管理）
  const listDir = projectSubdirPath(dramaId, 'temp')
  fs.mkdirSync(listDir, { recursive: true })
  const listPath = path.join(listDir, `${uuid()}.txt`)
  const canvasDir = path.join(listDir, `canvas-${uuid()}`)

  // 分辨率档位真正生效后，同集可能混有 864×480 / 1376×768 / 1920×1088 的镜头。
  // concat 要求各路流参数一致，尺寸不同会拼出花屏/截断，这里先统一到多数派的画布。
  let preparedVideos = await normalizeCanvasIfNeeded(videos, canvasDir)
  // AI 过渡片段可能无音轨（Wan 2.2 kf2v / 部分 ComfyUI 工作流）；补静音轨后才能走 xfade。
  const audioFillDir = clips.some(clip => clip.transitionId) && audioMode !== 'silent'
    ? path.join(listDir, `audio-${uuid()}`)
    : null
  if (audioFillDir) {
    preparedVideos = await ensureClipAudioTracks(preparedVideos, audioFillDir)
  }

  const listContent = preparedVideos
    .map(v => `file '${toAbsPath(v)}'`)
    .join('\n')
  fs.writeFileSync(listPath, listContent, 'utf-8')

  // 输出文件：项目 merged 子目录
  const outputDir = projectSubdirPath(dramaId, 'merged')
  fs.mkdirSync(outputDir, { recursive: true })
  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputFilename)

  // H3 每段成片响度差异极大（实测 -12.9 ~ -32.9 LUFS），直接拼会让旁白忽大忽小、
  // 整体偏轻。逐段 loudnorm 到 -16.5 LUFS 再 concat，能把各段拉到同一听感。
  // 有转场时走 xfade + acrossfade，音频交叉淡化避免镜头边界突变；
  // 任一段没有音轨时退回原来的 concat 路径，避免 filter 直接失败。
  let normalized = false
  let transitioned = false
  let silent = false
  try {
    if (audioMode === 'silent') {
      // silent 是成片硬约束：不保留任何音轨，也不做逐段响度归一。
      await mergeSilentVideos(preparedVideos, outputPath)
      silent = true
    } else if (await allClipsHaveAudio(preparedVideos)) {
      const hasTransitions = clips.some(clip => mergeTransitionStyle(clip.transition))
      if (hasTransitions) {
        try {
          await mergeWithTransitions(preparedVideos, clips, outputPath)
          transitioned = true
        } catch (error: any) {
          console.warn('[Merge] transition merge failed, falling back to concat:', error?.message || error)
          fs.rmSync(outputPath, { force: true })
        }
      }

      if (!transitioned) {
        try {
          await mergeWithNormalizedAudio(preparedVideos, outputPath, listDir)
          normalized = true
        } catch (error: any) {
          console.warn('[Merge] per-clip loudness normalization failed, falling back to plain concat:', error?.message || error)
          fs.rmSync(outputPath, { force: true })
        }
      }
    }

    if (!silent && !transitioned && !normalized) {
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(listPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions([
            '-fflags', '+genpts',
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '23',
            '-c:a', 'aac',
            '-ar', '48000',
            '-b:a', '192k',
            '-movflags', '+faststart',
          ])
          .output(outputPath)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run()
      })
    }
  } finally {
    // 无论成功失败都清掉 concat 列表与画布归一临时文件，避免 temp 目录堆积
    fs.rmSync(listPath, { force: true })
    fs.rmSync(canvasDir, { recursive: true, force: true })
    if (audioFillDir) fs.rmSync(audioFillDir, { recursive: true, force: true })
  }

  // 获取时长
  const duration = await getVideoDuration(outputPath)

  const mergedRelative = projectStorageRelative(dramaId, 'merged', outputFilename)

  // 成片海报帧（导出页封面用）
  await extractVideoPoster(mergedRelative)

  // 更新 merge 记录
  await db.update(schema.videoMerges)
    .set({ status: 'completed', mergedUrl: mergedRelative, duration, completedAt: now() })
    .where(eq(schema.videoMerges.id, mergeId))

  // 更新 episode
  await db.update(schema.episodes)
    .set({ videoUrl: mergedRelative, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))

  logTaskSuccess('MergeTask', 'episode-merge', {
    mergeId, episodeId, output: mergedRelative, duration, clips: videos.length,
    audio: silent ? 'silent (no audio track)' : transitioned ? 'xfade + acrossfade' : normalized ? 'per-clip loudnorm -16.5 LUFS' : 'plain concat',
  })
}

interface VideoSize {
  width: number
  height: number
}

function probeVideoSize(file: string): Promise<VideoSize | null> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) { resolve(null); return }
      const stream = (metadata.streams || []).find(s => s.codec_type === 'video')
      const width = Number(stream?.width || 0)
      const height = Number(stream?.height || 0)
      resolve(width > 0 && height > 0 ? { width, height } : null)
    })
  })
}

/**
 * 同集镜头分辨率不一致时，把每段补黑边缩放到「多数派画布」。
 * concat 要求各路视频流参数一致，直接拼不同尺寸会花屏；尺寸一致时原样返回，不额外转码。
 */
async function normalizeCanvasIfNeeded(videos: string[], workDir: string): Promise<string[]> {
  const sizes = await Promise.all(videos.map(v => probeVideoSize(toAbsPath(v))))
  const known = sizes.filter((s): s is VideoSize => Boolean(s))
  if (known.length !== videos.length || known.length === 0) return videos

  const counts = new Map<string, number>()
  for (const s of known) {
    const key = `${s.width}x${s.height}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  if (counts.size <= 1) return videos

  // 多数派优先；并列时取像素更多的，避免把整集降分辨率
  const target = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    const [aw, ah] = a[0].split('x').map(Number)
    const [bw, bh] = b[0].split('x').map(Number)
    return bw * bh - aw * ah
  })[0][0]
  const [rawWidth, rawHeight] = target.split('x').map(Number)
  const width = rawWidth & ~1
  const height = rawHeight & ~1
  console.warn(`[Merge] mixed clip sizes ${[...counts.keys()].join(' / ')}, normalizing to ${width}x${height}`)

  fs.mkdirSync(workDir, { recursive: true })
  const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`
  const normalized: string[] = []
  for (let i = 0; i < videos.length; i++) {
    const output = path.join(workDir, `${i}.mp4`)
    await new Promise<void>((resolve, reject) => {
      ffmpeg(toAbsPath(videos[i]))
        .videoFilters(filter)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '20',
          '-c:a', 'copy',
          '-movflags', '+faststart',
        ])
        .output(output)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
    normalized.push(output)
  }
  return normalized
}

function ffprobeHasAudio(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) { resolve(false); return }
      resolve((metadata.streams || []).some(stream => stream.codec_type === 'audio'))
    })
  })
}

async function allClipsHaveAudio(videos: string[]): Promise<boolean> {
  const results = await Promise.all(videos.map(v => ffprobeHasAudio(toAbsPath(v))))
  return results.every(Boolean)
}

/** 过渡片段无声时补一条静音轨，保证 xfade + acrossfade 路径可用 */
async function ensureClipAudioTracks(videos: string[], workDir: string): Promise<string[]> {
  const hasAudio = await Promise.all(videos.map(v => ffprobeHasAudio(toAbsPath(v))))
  if (hasAudio.every(Boolean)) return videos
  fs.mkdirSync(workDir, { recursive: true })
  const output: string[] = []
  for (let i = 0; i < videos.length; i++) {
    if (hasAudio[i]) {
      output.push(videos[i])
      continue
    }
    const target = path.join(workDir, `${i}.mp4`)
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(toAbsPath(videos[i]))
        .input('anullsrc=r=48000:cl=stereo')
        .inputOptions(['-f', 'lavfi'])
        .outputOptions([
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-shortest',
          '-movflags', '+faststart',
        ])
        .output(target)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
    output.push(target)
  }
  return output
}

/**
 * 静音模式合片：只输出视频流。
 * 逐段已统一画布，这里重编码一次以保证无音频流且容器参数一致。
 */
async function mergeSilentVideos(videos: string[], outputPath: string): Promise<void> {
  const listPath = path.join(path.dirname(outputPath), `.silent-${uuid()}.txt`)
  fs.writeFileSync(listPath, videos.map((video) => `file '${toAbsPath(video)}'`).join('\n'), 'utf-8')
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-fflags', '+genpts',
          '-an',
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '23',
          '-movflags', '+faststart',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
  } finally {
    fs.rmSync(listPath, { force: true })
  }
}

/**
 * ComfyUI 整集多段产物：按输出顺序拼接为单文件。
 * 单段直接复制；多段统一重编码，避免各段编码参数不一致导致 concat 失败。
 */
export async function concatVideoParts(videos: string[], outputPath: string, options: { silent?: boolean } = {}): Promise<void> {
  if (!videos.length) throw new Error('没有可拼接的视频片段')
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
  if (videos.length === 1) {
    await fs.promises.copyFile(toAbsPath(videos[0]), outputPath)
    return
  }
  if (options.silent) {
    await mergeSilentVideos(videos, outputPath)
    return
  }
  const withAudio = await allClipsHaveAudio(videos)
  const listPath = path.join(path.dirname(outputPath), `.comfy-${uuid()}.txt`)
  fs.writeFileSync(listPath, videos.map(video => `file '${toAbsPath(video)}'`).join('\n'), 'utf-8')
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-fflags', '+genpts',
          ...(withAudio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '23',
          '-movflags', '+faststart',
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
  } finally {
    fs.rmSync(listPath, { force: true })
  }
}

/**
 * 逐段响度归一后合并：每段先把音轨 loudnorm 到 -16.5 LUFS（真峰值 -3 dB 留 AAC 余量），
 * 与视频流 copy 封装成临时 mp4，最后 concat copy。
 * 不走 filter_complex：12 段以上多路 loudnorm 会触发 ffmpeg 滤镜重初始化错误。
 */
async function mergeWithNormalizedAudio(videos: string[], outputPath: string, workParent: string): Promise<void> {
  const workDir = path.join(workParent, `norm-${uuid()}`)
  fs.mkdirSync(workDir, { recursive: true })
  const normalized: string[] = []
  try {
    for (let i = 0; i < videos.length; i++) {
      const source = toAbsPath(videos[i])
      const audioPath = path.join(workDir, `${i}.m4a`)
      const clipPath = path.join(workDir, `${i}.mp4`)

      await new Promise<void>((resolve, reject) => {
        ffmpeg(source)
          .noVideo()
          .audioFilters('loudnorm=I=-16.5:TP=-3.0:LRA=11,aresample=48000')
          .audioCodec('aac')
          .audioBitrate('192k')
          .audioChannels(2)
          .format('ipod')
          .output(audioPath)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run()
      })

      await new Promise<void>((resolve, reject) => {
        ffmpeg(source)
          .input(audioPath)
          .outputOptions([
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'copy',
            '-c:a', 'copy',
            '-shortest',
            '-movflags', '+faststart',
          ])
          .output(clipPath)
          .on('end', () => resolve())
          .on('error', (err) => reject(err))
          .run()
      })
      normalized.push(clipPath)
    }

    const normalizedList = path.join(workDir, 'concat.txt')
    fs.writeFileSync(normalizedList, normalized.map(p => `file '${p}'`).join('\n'), 'utf-8')
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(normalizedList)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-fflags', '+genpts', '-c', 'copy', '-movflags', '+faststart'])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run()
    })
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

function probeDurationMs(file: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) { resolve(0); return }
      resolve(Math.round(Number(metadata.format.duration || 0) * 1000))
    })
  })
}

/**
 * 按分镜 transition 拼接：硬切走 concat，淡入淡出/叠化/划像走 xfade，
 * 音频同步 acrossfade，整片最后做一次 loudnorm。失败由调用方回退 concat。
 */
async function mergeWithTransitions(videos: string[], clips: MergeClip[], outputPath: string): Promise<void> {
  const [durationsMs, size] = await Promise.all([
    Promise.all(videos.map(v => probeDurationMs(toAbsPath(v)))),
    probeVideoSize(toAbsPath(videos[0])),
  ])
  if (!size) throw new Error('无法读取镜头尺寸，不能做转场拼接')
  if (durationsMs.some(d => d <= 0)) throw new Error('无法读取镜头时长，不能做转场拼接')

  const { graph } = buildMergeTransitionGraph(
    videos.map((_v, i) => ({
      durationMs: durationsMs[i],
      transition: clips[i]?.transition,
      transitionMs: clips[i]?.transitionMs,
    })),
    size.width,
    size.height,
  )

  const command = ffmpeg()
  videos.forEach(v => command.input(toAbsPath(v)))
  await new Promise<void>((resolve, reject) => {
    command
      .complexFilter(graph)
      .outputOptions([
        '-map', '[vout]',
        '-map', '[aout]',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-ar', '48000',
        '-b:a', '192k',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run()
  })
}

function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) { resolve(0); return }
      resolve(Math.round(metadata.format.duration || 0))
    })
  })
}
