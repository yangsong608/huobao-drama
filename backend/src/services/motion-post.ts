/**
 * 图文动画兜底（V2 · M4-1）
 *
 * 视频生成失败/未生成时，用分镜图 + 景别推拉 + xfade 转场拼出一集可交付的「动态分镜」。
 *
 * 时长策略（设计 §9.3）：有配音 = 该镜台词音频总长 + 0.6s；无配音按 4.5 字/秒估算；clamp 2.5–8s。
 * 字幕统一走 6.5 的 SRT/ASS；有配音时把对话轨、BGM、字幕一次混流；
 * 无配音只有 BGM 时循环播放并片尾淡出；两者都没有则输出无声画面。
 */
import fs from 'fs'
import path from 'path'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { projectStorageRelative, projectSubdirPath } from './project-storage.js'
import { ffmpeg } from '../utils/ffmpeg.js'
import { buildTimeline, type TimelineLine } from './timeline.js'
import { buildDialogueTrack, buildLoopedBgmTrack, mixEpisodeAudio, probeDurationMs } from './audio-mix.js'
import { buildSubtitleCues, maxCharsForAspect, toAss, toSrt } from './subtitles.js'
import { getDubbingDefaults } from './app-settings.js'
import {
  TRANSITION_MS,
  buildBgmOnlyFilter,
  buildXfadePlan,
  buildZoompanFilter,
  estimateShotDurationMs,
  pickShotMotion,
  type ShotMotion,
} from './motion-plan.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export interface MotionPostOptions {
  bgmUrl?: string | null
  /** 是否把成片写回 episodes.video_url（默认 false，作为新版本保留） */
  setAsEpisodeVideo?: boolean
  width?: number
  height?: number
}

export interface MotionPostResult {
  mergeId: number
  url: string
  durationMs: number
  shots: number
  subtitleUrl: string | null
  subtitleAssUrl: string | null
  withDialogue: boolean
  hasBgm: boolean
}

interface FfmpegInput {
  path: string
  options?: string[]
}

function runFfmpeg(inputs: FfmpegInput[], filter: string | null, outputOptions: string[], output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
    for (const input of inputs) {
      cmd.input(input.path)
      if (input.options?.length) cmd.inputOptions(input.options)
    }
    if (filter) cmd.complexFilter(filter)
    cmd.outputOptions(outputOptions)
    cmd.output(output)
    cmd.on('end', () => resolve())
    cmd.on('error', (err, _stdout, stderr) => {
      reject(new Error(`${err.message}${stderr ? `\n${String(stderr).slice(-1200)}` : ''}`))
    })
    cmd.run()
  })
}

/** 单张图 → 推拉镜头片段；多留 0.5s 尾巴给 xfade 转场，成片阶段再裁掉 */
async function renderShot(
  image: string,
  durationMs: number,
  motion: ShotMotion,
  output: string,
  width: number,
  height: number,
): Promise<void> {
  const seconds = Math.max(0.5, (durationMs + TRANSITION_MS) / 1000)
  const frames = Math.max(1, Math.round(seconds * 24))
  const filter = [
    `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
    `crop=${width * 2}:${height * 2}`,
    buildZoompanFilter(motion, width, height, frames),
    'format=yuv420p[vout]',
  ].join(',')
  await runFfmpeg(
    [{ path: image }],
    filter,
    [
      '-y', '-map', '[vout]', '-t', seconds.toFixed(3), '-r', '24',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart',
    ],
    output,
  )
}

/**
 * 生成图文动画版本。返回新版本地址，不覆盖已有成片（除显式要求）。
 */
export async function renderMotionPost(episodeId: number, dramaId: number, options: MotionPostOptions = {}): Promise<MotionPostResult> {
  logTaskStart('Motion', 'episode', { episodeId })
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new Error('剧集不存在')
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  const width = options.width ?? (drama?.aspectRatio === '9:16' ? 1080 : 1920)
  const height = options.height ?? (drama?.aspectRatio === '9:16' ? 1920 : 1080)

  const storyboards = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
  if (!storyboards.length) throw new Error('本集还没有分镜，无法生成图文动画')

  const lines = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.episodeId, episodeId))
    .all()
    .filter((l) => !l.stale)

  const workDir = projectSubdirPath(dramaId, 'temp')
  fs.mkdirSync(workDir, { recursive: true })
  const clipDir = path.join(workDir, `motion-${episodeId}-${Date.now()}`)
  fs.mkdirSync(clipDir, { recursive: true })

  try {
    const candidates: {
      storyboardId: number
      storyboardNumber: number
      imagePath: string
      durationMs: number
      motion: ShotMotion
    }[] = []

    for (const sb of storyboards) {
      const scene = sb.sceneId ? db.select().from(schema.scenes).where(eq(schema.scenes.id, sb.sceneId)).get() : null
      const imageUrl = sb.composedImage || sb.firstFrameImage || scene?.imageUrl || null
      if (!imageUrl) continue
      const abs = path.isAbsolute(imageUrl) ? imageUrl : getAbsolutePath(imageUrl)
      if (!fs.existsSync(abs)) continue

      const shotLines = lines.filter((l) => l.storyboardId === sb.id)
      const voicedMs = shotLines.reduce((n, l) => n + (l.audioDurationMs || 0), 0)
      const text = shotLines.map((l) => l.subtitleText || l.text || '').join('')
        || sb.description || sb.videoPrompt || ''
      candidates.push({
        storyboardId: sb.id,
        storyboardNumber: sb.storyboardNumber,
        imagePath: abs,
        durationMs: estimateShotDurationMs(text, voicedMs),
        motion: pickShotMotion(sb.shotType, candidates.length),
      })
    }

    if (!candidates.length) throw new Error('没有可用的分镜图（需要先生成首帧/场景图）')

    const files: string[] = []
    const clips: { storyboardId: number; storyboardNumber: number; durationMs: number }[] = []
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i]
      const file = path.join(clipDir, `${String(i).padStart(3, '0')}.mp4`)
      try {
        await renderShot(candidate.imagePath, candidate.durationMs, candidate.motion, file, width, height)
        files.push(file)
        clips.push({
          storyboardId: candidate.storyboardId,
          storyboardNumber: candidate.storyboardNumber,
          durationMs: candidate.durationMs,
        })
      } catch (error: any) {
        console.warn(`[motion] 单镜渲染失败 ${path.basename(candidate.imagePath)}：${error?.message || error}`)
      }
    }
    if (!files.length) throw new Error('分镜图渲染全部失败')

    const plan = buildXfadePlan(clips.map((c) => c.durationMs))
    const mergedDir = projectSubdirPath(dramaId, 'merged')
    fs.mkdirSync(mergedDir, { recursive: true })
    const stamp = Date.now()
    const outputName = `motion-${episodeId}-${stamp}.mp4`
    const outputPath = path.join(mergedDir, outputName)

    await runFfmpeg(
      files.map((file) => ({ path: file })),
      plan.graph,
      [
        '-y', '-map', '[vout]', '-r', '24', '-t', (plan.totalMs / 1000).toFixed(3),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-an', '-movflags', '+faststart',
      ],
      outputPath,
    )

    const defaults = getDubbingDefaults()
    const subtitleMode = defaults.subtitleMode
    const voiced = lines.filter((l) => l.audioUrl && l.audioDurationMs
      && (l.storyboardId == null ? l.voiceStartMs != null : clips.some((c) => c.storyboardId === l.storyboardId)))
    const bgmSource = options.bgmUrl || episode.bgmUrl || null
    const bgmPath = bgmSource ? (path.isAbsolute(bgmSource) ? bgmSource : getAbsolutePath(bgmSource)) : null
    const bgmExists = bgmPath && fs.existsSync(bgmPath) ? bgmPath : null

    let subtitleUrl: string | null = null
    let subtitleAssUrl: string | null = null
    let withDialogue = false
    let hasBgm = false

    if (voiced.length) {
      const timeline = buildTimeline({
        clips,
        lines: voiced.map<TimelineLine>((row) => ({
          lineId: row.id,
          storyboardId: row.storyboardId,
          lineNo: row.lineNo,
          text: row.subtitleText || row.text || '',
          speaker: row.speakerName || '旁白',
          kind: (row.speakerType as TimelineLine['kind']) || 'narration',
          plannedStartMs: row.plannedStartMs ?? 0,
          startOverrideMs: row.voiceStartMs ?? null,
          durationOverrideMs: row.voiceDurationMs ?? null,
          audioDurationMs: row.audioDurationMs || 0,
          audioUrl: row.audioUrl,
          speed: row.speed ?? 1,
        })),
        totalDurationMs: plan.totalMs,
      })

      const perLine = maxCharsForAspect(width, height)
      const marks = { markNarration: defaults.narratorPrefix }
      let srtPath: string | null = null
      let assPath: string | null = null
      if (subtitleMode !== 'none') {
        const cues = buildSubtitleCues(timeline.cues, { maxCharsPerLine: perLine, ...marks })
        const subDir = projectSubdirPath(dramaId, 'subtitles')
        fs.mkdirSync(subDir, { recursive: true })
        const srtName = `motion-ep${episodeId}-${stamp}.srt`
        const assName = `motion-ep${episodeId}-${stamp}.ass`
        srtPath = path.join(subDir, srtName)
        assPath = path.join(subDir, assName)
        fs.writeFileSync(srtPath, toSrt(cues, { maxCharsPerLine: perLine, ...marks }), 'utf-8')
        fs.writeFileSync(assPath, toAss(cues, {
          maxCharsPerLine: perLine,
          width,
          height,
          fontSize: defaults.subtitleFontSize,
          marginV: defaults.subtitleMargin,
          ...marks,
        }), 'utf-8')
        subtitleUrl = projectStorageRelative(dramaId, 'subtitles', srtName)
        subtitleAssUrl = projectStorageRelative(dramaId, 'subtitles', assName)
      }

      const dialoguePath = path.join(workDir, `motion-dialogue-${episodeId}-${stamp}.wav`)
      const audioByLine = new Map(voiced.map((row) => [row.id, row.audioUrl ? getAbsolutePath(row.audioUrl) : '']))
      await buildDialogueTrack(
        timeline.cues.map((cue) => ({ audioPath: audioByLine.get(cue.lineId) || '', startMs: cue.startMs, lineId: cue.lineId })),
        plan.totalMs,
        dialoguePath,
        workDir,
      )

      const mixedPath = path.join(mergedDir, `motion-mix-${episodeId}-${stamp}.mp4`)
      await mixEpisodeAudio({
        videoPath: outputPath,
        dialoguePath,
        outputPath: mixedPath,
        options: {
          // 图文画面没有原声，对话轨就是唯一主体
          originalAudio: 'mute',
          subtitlePath: subtitleMode === 'none' ? null : srtPath,
          subtitleAssPath: subtitleMode === 'burn' ? assPath : null,
          subtitleMode,
          durationMs: plan.totalMs,
          bgmPath: bgmExists,
          bgmVolume: defaults.bgmVolume,
          duckingRatio: defaults.duckingRatio,
          targetLufs: defaults.targetLufs,
          width,
          height,
        },
      })
      fs.rmSync(dialoguePath, { force: true })
      fs.rmSync(outputPath, { force: true })
      fs.renameSync(mixedPath, outputPath)
      withDialogue = true
      hasBgm = Boolean(bgmExists)
    } else if (bgmExists) {
      const totalSec = Math.max(1, plan.totalMs / 1000)
      const mixedPath = path.join(mergedDir, `motion-bgm-${episodeId}-${stamp}.mp4`)
      const bgmTrack = await buildLoopedBgmTrack(bgmExists, plan.totalMs, workDir)
      try {
        await runFfmpeg(
          [{ path: outputPath }, { path: bgmTrack }],
          `[1:a]${buildBgmOnlyFilter(defaults.bgmVolume, totalSec)}[aout]`,
          [
            '-y', '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
            '-t', totalSec.toFixed(3), '-movflags', '+faststart',
          ],
          mixedPath,
        )
      } finally {
        fs.rmSync(bgmTrack, { force: true })
      }
      fs.rmSync(outputPath, { force: true })
      fs.renameSync(mixedPath, outputPath)
      hasBgm = true
    }

    const url = projectStorageRelative(dramaId, 'merged', outputName)
    const probedMs = await probeDurationMs(outputPath)
    const durationMs = probedMs || plan.totalMs
    const insert = db.insert(schema.videoMerges).values({
      episodeId,
      dramaId,
      title: `Episode ${episodeId} Motion`,
      provider: 'ffmpeg',
      model: 'ffmpeg-motion-xfade',
      status: 'completed',
      kind: 'motion',
      scenes: JSON.stringify(clips.map((c) => c.storyboardId)),
      mergedUrl: url,
      duration: Math.round(durationMs / 1000),
      subtitleUrl,
      bgmUrl: options.bgmUrl ?? null,
      mixOptions: JSON.stringify({
        bgmUrl: options.bgmUrl ?? null,
        bgmVolume: hasBgm ? defaults.bgmVolume : null,
        subtitleMode: subtitleUrl ? subtitleMode : 'none',
        subtitleAssUrl,
        transitionMs: TRANSITION_MS,
        width,
        height,
      }),
      createdAt: now(),
      completedAt: now(),
    }).run()
    const mergeId = Number((insert as any).lastInsertRowid)

    db.insert(schema.assets).values({
      dramaId,
      episodeId,
      name: `第 ${episode.episodeNumber} 集 · 图文动画`,
      description: `${clips.length} 个分镜，${withDialogue ? '含配音轨' : hasBgm ? '含 BGM' : '无音轨'}`,
      type: 'motion_post',
      category: 'video',
      url,
      localPath: outputPath,
      duration: Math.round(durationMs / 1000),
      width,
      height,
      format: 'mp4',
      mimeType: 'video/mp4',
      createdAt: now(),
      updatedAt: now(),
    }).run()

    if (options.setAsEpisodeVideo) {
      db.update(schema.episodes).set({
        videoUrl: url,
        subtitleUrl,
        duration: Math.round(durationMs / 1000),
        updatedAt: now(),
      }).where(eq(schema.episodes.id, episodeId)).run()
    }
    if (options.bgmUrl) {
      db.update(schema.episodes).set({ bgmUrl: options.bgmUrl, updatedAt: now() }).where(eq(schema.episodes.id, episodeId)).run()
    }

    logTaskSuccess('Motion', 'episode', { episodeId, mergeId, shots: clips.length, durationMs, withDialogue, hasBgm })
    return {
      mergeId,
      url,
      durationMs,
      shots: clips.length,
      subtitleUrl,
      subtitleAssUrl,
      withDialogue,
      hasBgm,
    }
  } catch (error: any) {
    logTaskError('Motion', 'episode', { episodeId, error: error?.message || String(error) })
    throw error
  } finally {
    fs.rmSync(clipDir, { recursive: true, force: true })
  }
}
