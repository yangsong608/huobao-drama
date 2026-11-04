/**
 * A-6 预览导出：合成 → 时间轴 → 对话轨 → 混音 + 软字幕
 *
 * 用法：
 *   npx tsx scripts/dub-preview.ts 5              # 真实 TTS（需已配置 audio 服务）
 *   npx tsx scripts/dub-preview.ts 5 --mock       # 无 TTS 时用等长音调占位，验证时间轴与混音
 *   npx tsx scripts/dub-preview.ts 5 --limit 8    # 只做前 8 句，快速试听
 *   npx tsx scripts/dub-preview.ts 5 --keep 0.3   # 原声保留 30%
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { asc, eq } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'
import { getAbsolutePath } from '../src/utils/storage.js'
import { STORAGE_ROOT } from '../src/utils/paths.js'
import { buildTimeline, scaleClipsToDuration, type TimelineLine } from '../src/services/timeline.js'
import { buildDialogueTrack, mixEpisodeAudio, probeDurationMs } from '../src/services/audio-mix.js'
import { buildSubtitleCues, maxCharsForAspect, toAss, toSrt } from '../src/services/subtitles.js'
import { synthesize, normalizeSpeakText } from '../src/services/tts.js'
import { mergeEpisodeVideos } from '../src/services/ffmpeg-merge.js'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static')

interface Args {
  episodeId: number
  mock: boolean
  limit: number
  keep: number | null
  outDir: string
  bgm: string | null
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const episodeId = Number(argv.find((a) => /^\d+$/.test(a)) || 5)
  const flag = (name: string) => argv.includes(`--${name}`)
  const value = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null
  }
  return {
    episodeId,
    mock: flag('mock'),
    limit: Number(value('limit') || 0),
    keep: value('keep') !== null ? Number(value('keep')) : null,
    outDir: value('out') || path.join(STORAGE_ROOT, '..', 'out', `ep${episodeId}`),
    bgm: value('bgm'),
  }
}

function makeMockTone(file: string, durationMs: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const seconds = Math.max(0.6, durationMs / 1000)
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=420:duration=${seconds}`,
    '-af', 'volume=0.35,afade=t=in:d=0.05,afade=t=out:st=' + (seconds - 0.15).toFixed(2) + ':d=0.15',
    '-ar', '24000', '-ac', '1', file,
  ])
}

async function main() {
  const args = parseArgs()
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, args.episodeId)).get()
  if (!episode) throw new Error(`第 ${args.episodeId} 集不存在`)

  const storyboards = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, args.episodeId))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
    .filter((s) => !s.deletedAt)

  const clips = [] as { storyboardId: number; storyboardNumber: number; durationMs: number; videoPath: string }[]
  for (const sb of storyboards) {
    const url = sb.videoUrl || sb.composedVideoUrl
    if (!url) continue
    const abs = path.isAbsolute(url) ? url : getAbsolutePath(url)
    if (!fs.existsSync(abs)) {
      console.warn(`[skip] S${sb.storyboardNumber} 视频文件缺失：${url}`)
      continue
    }
    const durationMs = await probeDurationMs(abs)
    if (durationMs <= 0) {
      console.warn(`[skip] S${sb.storyboardNumber} 无法读取时长`)
      continue
    }
    clips.push({ storyboardId: sb.id, storyboardNumber: sb.storyboardNumber, durationMs, videoPath: abs })
  }
  if (!clips.length) throw new Error('本集没有可用的镜头视频，请先生成视频并合片')

  const clipsSumMs = clips.reduce((n, c) => n + c.durationMs, 0)

  function latestMergedUrl(): string | null {
    const rows = db.select().from(schema.videoMerges)
      .where(eq(schema.videoMerges.episodeId, args.episodeId))
      .all()
      .filter((m) => m.status === 'completed' && m.mergedUrl)
      .sort((a, b) => (b.id || 0) - (a.id || 0))
    return rows[0]?.mergedUrl || episode!.videoUrl || null
  }

  async function remix(reason: string): Promise<string> {
    console.log(`[merge] ${reason}，开始重新合并…`)
    const mergeId = await mergeEpisodeVideos(args.episodeId, episode!.dramaId)
    const deadline = Date.now() + 10 * 60 * 1000
    for (;;) {
      const row = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, mergeId)).get()
      if (row?.status === 'completed' && row.mergedUrl) return row.mergedUrl
      if (row?.status === 'failed') throw new Error(`重新合并失败：${row.errorMsg || '未知错误'}`)
      if (Date.now() > deadline) throw new Error('重新合并超时（10 分钟）')
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  let mergedUrl = latestMergedUrl()
  if (!mergedUrl) throw new Error('本集还没有合片，请先执行一次「合并」')
  let videoPath = path.isAbsolute(mergedUrl) ? mergedUrl : getAbsolutePath(mergedUrl)
  let videoDurationMs = fs.existsSync(videoPath) ? await probeDurationMs(videoPath) : 0

  // 合片与当前镜头集合不一致（旧版本合片、补镜后未重拼）时先重新合并，
  // 否则时间轴会被迫整体缩放，字幕与画面对不上。
  if (!fs.existsSync(videoPath) || videoDurationMs <= 0 || Math.abs(videoDurationMs - clipsSumMs) > Math.max(1000, clipsSumMs * 0.05)) {
    const reason = !fs.existsSync(videoPath)
      ? '合片文件缺失'
      : `合片 ${videoDurationMs}ms 与镜头合计 ${clipsSumMs}ms 不一致`
    mergedUrl = await remix(reason)
    videoPath = path.isAbsolute(mergedUrl) ? mergedUrl : getAbsolutePath(mergedUrl)
    videoDurationMs = await probeDurationMs(videoPath)
    console.log(`[merge] 新合片 ${videoDurationMs}ms：${mergedUrl}`)
  }

  const rows = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.episodeId, args.episodeId))
    .orderBy(asc(schema.storyboardLines.storyboardId), asc(schema.storyboardLines.lineNo))
    .all()
    .filter((l) => !l.stale || l.stale === 0)

  if (!rows.length) {
    throw new Error('本集还没有台词，请先执行：npm run dialogue:apply -- ' + args.episodeId)
  }

  const selected = args.limit > 0 ? rows.slice(0, args.limit) : rows
  console.log(`第 ${args.episodeId} 集：${clips.length} 镜 / ${videoDurationMs}ms，台词 ${selected.length} 句`)

  const outDir = args.outDir
  const audioDir = path.join(outDir, 'audio')
  const workDir = path.join(outDir, 'work')
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(workDir, { recursive: true })

  // 音色解析：角色激活音色 → 项目旁白音色 → 提示词直造
  const voices = db.select().from(schema.characterVoices)
    .where(eq(schema.characterVoices.dramaId, episode.dramaId))
    .all()
    .filter((v) => !v.deletedAt)
  const activeByCharacter = new Map<number, typeof voices[number]>()
  let narratorVoice: typeof voices[number] | undefined
  for (const v of voices) {
    if (v.scope === 'narrator' && v.isActive) narratorVoice = v
    if (v.characterId && v.isActive) activeByCharacter.set(v.characterId, v)
  }

  const timelineLines: TimelineLine[] = []
  const audioByLine = new Map<number, string>()
  let synthFailures = 0

  for (const [i, row] of selected.entries()) {
    const text = normalizeSpeakText(row.speakText || row.text || '')
    if (!text) continue
    const chars = [...text].length
    let audioPath = ''
    let durationMs = 0

    if (args.mock) {
      durationMs = Math.round(Math.min(8000, Math.max(1200, (chars / 4.2) * 1000)))
      audioPath = path.join(audioDir, `line-${row.id}.wav`)
      makeMockTone(audioPath, durationMs)
    } else {
      const voice = row.characterId ? activeByCharacter.get(row.characterId) : narratorVoice
      const ref = voice || narratorVoice
      try {
        const result = await synthesize({
          text,
          speed: row.speed ?? 1,
          emotion: row.emotion ?? undefined,
          voice: {
            externalVoiceId: ref?.externalVoiceId || undefined,
            designInstruct: ref?.designInstruct || undefined,
            refAudioUrl: ref?.refAudioUrl || undefined,
            refText: ref?.refText || undefined,
          },
        })
        audioPath = getAbsolutePath(result.url)
        durationMs = result.durationMs
      } catch (err: any) {
        synthFailures += 1
        console.warn(`[tts] 第 ${i + 1} 句合成失败：${err?.message || err}`)
        continue
      }
    }

    audioByLine.set(row.id, audioPath)
    timelineLines.push({
      lineId: row.id,
      storyboardId: row.storyboardId,
      lineNo: row.lineNo,
      text: row.subtitleText || row.text || '',
      speaker: row.speakerName || '旁白',
      kind: (row.speakerType as TimelineLine['kind']) || 'narration',
      plannedStartMs: row.plannedStartMs ?? 0,
      audioDurationMs: durationMs,
      audioUrl: audioPath,
      speed: row.speed ?? 1,
    })
  }

  if (!timelineLines.length) throw new Error('没有成功合成任何台词')

  const scaled = scaleClipsToDuration(
    clips.map((c) => ({ storyboardId: c.storyboardId, storyboardNumber: c.storyboardNumber, durationMs: c.durationMs })),
    videoDurationMs,
  )

  const timeline = buildTimeline({
    clips: scaled.clips.map((c) => ({ storyboardId: c.storyboardId, storyboardNumber: c.storyboardNumber, durationMs: c.durationMs })),
    lines: timelineLines,
    totalDurationMs: videoDurationMs,
  })
  if (scaled.scaled) {
    console.warn(
      `[warn] 逐段时长之和与合片不一致（比例 ${scaled.ratio.toFixed(3)}），已按合片时长缩放时间轴。` +
      '若差距过大，说明合片是旧版本，建议重新合并后再导出',
    )
  }
  if (timeline.skippedLineIds.length) {
    console.warn(`[warn] ${timeline.skippedLineIds.length} 句台词所属镜头没有视频，已跳过`)
  }

  console.log(
    `时间轴：${timeline.cues.length} 句，atempo ${timeline.atempoCount} 句，溢出 ${timeline.cues.filter((c) => c.overflowMs > 0).length} 句，` +
    `重叠 ${timeline.overlapCount} 句，裁切 ${timeline.trimmedCount} 句`,
  )

  const dialoguePath = path.join(workDir, 'dialogue.wav')
  const dialogue = await buildDialogueTrack(
    timeline.cues.map((c) => ({ audioPath: audioByLine.get(c.lineId) || '', startMs: c.startMs, lineId: c.lineId })),
    videoDurationMs,
    dialoguePath,
    workDir,
  )
  console.log(`对话轨：${dialogue.durationMs}ms（${dialogue.chunks} 块）`)

  const aspectChars = maxCharsForAspect(864, 480)
  const subtitleCues = buildSubtitleCues(timeline.cues, { maxCharsPerLine: aspectChars })
  const baseName = `dub-preview-${Date.now()}`
  const srtPath = path.join(outDir, `${baseName}.srt`)
  const assPath = path.join(outDir, `${baseName}.ass`)
  fs.writeFileSync(srtPath, toSrt(subtitleCues, { maxCharsPerLine: aspectChars }), 'utf-8')
  fs.writeFileSync(assPath, toAss(subtitleCues, { maxCharsPerLine: aspectChars, width: 864, height: 480 }), 'utf-8')

  const outputPath = path.join(outDir, `${baseName}.mp4`)
  const originalAudio = args.keep === null ? 'duck' : args.keep >= 0.999 ? 'keep' : args.keep <= 0.001 ? 'mute' : 'duck'
  const mix = await mixEpisodeAudio({
    videoPath,
    dialoguePath,
    outputPath,
    options: {
      originalAudio,
      subtitlePath: srtPath,
      subtitleMode: 'soft',
      durationMs: videoDurationMs,
      bgmPath: args.bgm,
    },
  })
  fs.rmSync(dialoguePath, { force: true })
  fs.rmSync(workDir, { recursive: true, force: true })

  console.log('\n=== 产出 ===')
  console.log('视频：', outputPath, `${mix.durationMs}ms`)
  console.log('字幕：', srtPath)
  console.log('样式：', assPath)
  if (args.mock) console.log('注意：当前是 --mock 模式，听到的是等长音调，不是真实配音')
  if (synthFailures) console.log(`合成失败 ${synthFailures} 句（未计入时间轴）`)
}

main().catch((err) => {
  console.error('[dub-preview] 失败：', err?.message || err)
  process.exit(1)
})
