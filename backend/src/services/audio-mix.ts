/**
 * 配音混音（V2 · 6.6）
 *
 * 输入：合片视频（原声底）+ 逐句 TTS + 可选 BGM + 可选字幕
 * 处理：
 *   1. 逐句 adelay 拼成整集对话轨（>60 句分块，避免滤镜图过大）
 *   2. 原声过 sidechaincompress 被配音压低 6–9 dB
 *   3. BGM 循环、片尾淡出、再被配音压一次
 *   4. alimiter + loudnorm 统一到 −16 LUFS / −2 dBTP
 *
 * 两个容易踩的坑：
 * - 原声是立体声、配音是单声道，进入 sidechaincompress 前必须都过
 *   aformat=channel_layouts=stereo，否则报 Media type mismatch；
 * - `amix` 默认 normalize=1 会把整体电平除以输入数，必须显式 normalize=0。
 */
import fs from 'fs'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { ffmpeg } from '../utils/ffmpeg.js'

export interface DialogueCueInput {
  /** 本地绝对路径（TTS 缓存文件） */
  audioPath: string
  startMs: number
  /** 仅用于日志 */
  lineId?: number
}

export interface MixOptions {
  /** keep 不压原声；duck 压 6–9 dB；mute 直接归零 */
  originalAudio?: 'keep' | 'duck' | 'mute'
  duckingThreshold?: number
  duckingRatio?: number
  bgmPath?: string | null
  /** BGM 线性音量，默认 0.18（约 −15 dBFS） */
  bgmVolume?: number
  targetLufs?: number
  targetTp?: number
  durationMs?: number
  /** 字幕：不传则不出字幕轨 */
  subtitlePath?: string | null
  /** 烧录专用 ASS 路径；libass 的 ass 滤镜不能读 SRT（实测报 Could not create a libass track） */
  subtitleAssPath?: string | null
  subtitleMode?: 'soft' | 'burn' | 'none'
  /** 画布宽高（烧录字幕时计算样式用） */
  width?: number
  height?: number
  /** 成片附加音轨（环境声/音效/BGM/额外语音） */
  tracks?: MixTrackInput[]
}

export interface MixClipInput {
  audioPath: string
  startMs: number
  endMs: number
  sourceStartMs?: number
  fadeInMs?: number
  fadeOutMs?: number
}

export interface MixTrackInput {
  id?: number
  kind: string
  name: string
  volume: number
  muted?: boolean
  solo?: boolean
  ducking?: boolean
  loop?: boolean
  clips: MixClipInput[]
}

export interface MixResult {
  outputPath: string
  durationMs: number
  hasBgm: boolean
  originalAudio: string
  subtitleMode: string
}

const SR = 48000
const CHUNK_SIZE = 20

const AFMT = `aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=stereo`

/** 用 fluent-ffmpeg 执行一条自定义参数命令 */
function execFfmpeg(inputs: { path: string; options?: string[] }[], filter: string | null, outputOptions: string[], output: string): Promise<void> {
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

/**
 * 把短 BGM 循环并裁到成片时长，生成有限长度的音轨。
 * 直接把 `-stream_loop -1` 的无限输入塞进 amix：输出虽然写完了，
 * 但 BGM 输入线程等不到 EOF，ffmpeg 会一直不退出（实测 mac ffmpeg 6.1）。
 */
export async function buildLoopedBgmTrack(bgmPath: string, durationMs: number, workDir: string): Promise<string> {
  const durationSec = Math.max(0.5, durationMs / 1000)
  fs.mkdirSync(workDir, { recursive: true })
  const output = path.join(workDir, `bgm-${uuid()}.wav`)
  await execFfmpeg(
    [{ path: bgmPath, options: ['-stream_loop', '-1'] }],
    `[0:a]${AFMT},atrim=0:${durationSec.toFixed(3)},asetpts=N/SR/TB[bgm]`,
    ['-map', '[bgm]', '-c:a', 'pcm_s16le', '-ar', String(SR), '-ac', '2', '-t', durationSec.toFixed(3)],
    output,
  )
  return output
}

/** ffmpeg 滤镜参数里的路径：反斜杠转正斜杠，转义冒号、单引号与方括号 */
function escapeFilterPath(file: string): string {
  return file
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

/**
 * 烧录字幕的 -vf。
 * libass 的 ass 滤镜只认 ASS/SSA；拿 .srt 会报 Could not create a libass track。
 * 因此优先用 ASS，没有 ASS 时退回 subtitles 滤镜（它能读 SRT）。
 */
export function buildBurnFilter(subtitlePath?: string | null, subtitleAssPath?: string | null): string | null {
  if (subtitleAssPath) return `ass='${escapeFilterPath(subtitleAssPath)}'`
  if (!subtitlePath) return null
  if (/\.ass$/i.test(subtitlePath)) return `ass='${escapeFilterPath(subtitlePath)}'`
  return `subtitles='${escapeFilterPath(subtitlePath)}'`
}

export function probeDurationMs(file: string): Promise<number> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, meta) => {
      if (err) return resolve(0)
      const seconds = Number(meta?.format?.duration)
      resolve(Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0)
    })
  })
}

export function hasAudioStream(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (err, meta) => {
      if (err) return resolve(false)
      resolve((meta?.streams || []).some((s) => s.codec_type === 'audio'))
    })
  })
}

/** 把单个片段渲染为独立音频（循环素材先裁到片段长度），供音轨拼装使用 */
async function renderClipAudio(clip: MixClipInput, workDir: string, loop = false): Promise<string | null> {
  const clipMs = Math.round(clip.endMs - clip.startMs)
  if (clipMs <= 0 || !fs.existsSync(clip.audioPath)) return null
  const sourceStartSec = Math.max(0, (clip.sourceStartMs || 0) / 1000)
  const clipSec = clipMs / 1000
  const fadeInSec = Math.max(0, (clip.fadeInMs || 0) / 1000)
  const fadeOutSec = Math.max(0, (clip.fadeOutMs || 0) / 1000)
  const filters = [
    `[0:a]${AFMT}`,
    `atrim=${sourceStartSec.toFixed(3)}:${(sourceStartSec + clipSec).toFixed(3)}`,
    'asetpts=N/SR/TB',
  ]
  if (fadeInSec > 0) filters.push(`afade=t=in:st=0:d=${Math.min(fadeInSec, clipSec).toFixed(3)}`)
  if (fadeOutSec > 0) {
    const start = Math.max(0, clipSec - Math.min(fadeOutSec, clipSec))
    filters.push(`afade=t=out:st=${start.toFixed(3)}:d=${Math.min(fadeOutSec, clipSec).toFixed(3)}`)
  }
  filters.push('anull[c]')
  fs.mkdirSync(workDir, { recursive: true })
  const output = path.join(workDir, `clip-${uuid()}.wav`)
  await execFfmpeg(
    [{ path: clip.audioPath, options: loop ? ['-stream_loop', '-1'] : [] }],
    filters.join(','),
    ['-map', '[c]', '-t', clipSec.toFixed(3), '-c:a', 'pcm_s16le', '-ar', String(SR), '-ac', '2'],
    output,
  )
  return output
}

/** 把一条附加音轨的所有片段拼成与成片等长的轨；无有效片段返回 null */
export async function buildExtraTrackAudio(
  track: MixTrackInput,
  totalDurationMs: number,
  workDir: string,
): Promise<string | null> {
  const totalSec = Math.max(0.5, totalDurationMs / 1000)
  const clips = track.clips.filter((clip) => clip.audioPath && fs.existsSync(clip.audioPath) && clip.endMs > clip.startMs)
  if (!clips.length) return null

  const clipFiles: string[] = []
  for (const clip of clips) {
    const file = await renderClipAudio(clip, workDir, Boolean(track.loop))
    if (file) clipFiles.push(file)
  }
  if (!clipFiles.length) return null

  const parts: string[] = []
  clipFiles.forEach((_file, i) => {
    const delay = Math.max(0, Math.round(clips[i].startMs))
    parts.push(`[${i}:a]${AFMT},adelay=${delay}|${delay},apad=whole_dur=${totalSec.toFixed(3)},atrim=0:${totalSec.toFixed(3)}[c${i}]`)
  })
  const labels = clipFiles.map((_file, i) => `[c${i}]`).join('')
  const volume = Math.max(0, Math.min(2, Number(track.volume) || 0))
  if (clipFiles.length === 1) {
    parts.push(`[c0]volume=${volume}[out]`)
  } else {
    parts.push(`${labels}amix=inputs=${clipFiles.length}:normalize=0:duration=longest,volume=${volume}[out]`)
  }

  fs.mkdirSync(workDir, { recursive: true })
  const output = path.join(workDir, `track-${uuid()}.wav`)
  const inputs = clipFiles.map((file) => ({ path: file }))
  await execFfmpeg(inputs, parts.join(';'), ['-map', '[out]', '-c:a', 'pcm_s16le', '-ar', String(SR), '-ac', '2'], output)
  clipFiles.forEach((file) => fs.rmSync(file, { force: true }))
  return output
}

/** 拼装整集对话轨（静音底 + 逐句 adelay）。
 * 超过 60 句时按 20 句分块，每块都是一条与整集等长的轨，最后再 amix，
 * 避免单张滤镜图挂上百个输入。
 */
export async function buildDialogueTrack(
  cues: DialogueCueInput[],
  totalDurationMs: number,
  outputPath: string,
  workDir: string,
): Promise<{ durationMs: number; chunks: number }> {
  const totalSec = Math.max(0.5, totalDurationMs / 1000)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.mkdirSync(workDir, { recursive: true })

  const valid = cues.filter((c) => c.audioPath && fs.existsSync(c.audioPath))
  if (!valid.length) {
    await execFfmpeg(
      [{ path: 'anullsrc=r=48000:cl=stereo', options: ['-f', 'lavfi', '-t', String(totalSec)] }],
      null,
      ['-c:a', 'pcm_s16le', '-ar', String(SR), '-ac', '1'],
      outputPath,
    )
    return { durationMs: Math.round(totalSec * 1000), chunks: 0 }
  }

  const groups: DialogueCueInput[][] = []
  for (let i = 0; i < valid.length; i += CHUNK_SIZE) groups.push(valid.slice(i, i + CHUNK_SIZE))

  const chunkFiles: string[] = []
  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g]
    const inputs: { path: string; options?: string[] }[] = group.map((c) => ({ path: c.audioPath }))
    const parts: string[] = []
    group.forEach((cue, i) => {
      const delay = Math.max(0, Math.round(cue.startMs))
      parts.push(`[${i}:a]${AFMT},adelay=${delay}|${delay}[a${i}]`)
    })
    const mixInputs = group.map((_c, i) => `[a${i}]`).join('')
    parts.push(`${mixInputs}amix=inputs=${group.length}:normalize=0:duration=longest[raw]`)
    parts.push(`[raw]apad=whole_dur=${totalSec.toFixed(3)},atrim=0:${totalSec.toFixed(3)},asetpts=N/SR/TB[out]`)

    const chunkFile = path.join(workDir, `chunk-${g}-${uuid()}.wav`)
    await execFfmpeg(inputs, parts.join(';'), ['-map', '[out]', '-c:a', 'pcm_s16le', '-ar', String(SR), '-ac', '1'], chunkFile)
    chunkFiles.push(chunkFile)
  }

  if (chunkFiles.length === 1) {
    fs.copyFileSync(chunkFiles[0], outputPath)
    fs.rmSync(chunkFiles[0], { force: true })
  } else {
    const inputs = chunkFiles.map((f) => ({ path: f }))
    const parts: string[] = []
    chunkFiles.forEach((_f, i) => parts.push(`[${i}:a]${AFMT}[c${i}]`))
    parts.push(`${chunkFiles.map((_f, i) => `[c${i}]`).join('')}amix=inputs=${chunkFiles.length}:normalize=0:duration=longest[out]`)
    await execFfmpeg(inputs, parts.join(';'), ['-map', '[out]', '-c:a', 'pcm_s16le', '-ar', String(SR), '-ac', '1'], outputPath)
    chunkFiles.forEach((f) => fs.rmSync(f, { force: true }))
  }

  return { durationMs: await probeDurationMs(outputPath), chunks: groups.length }
}

export function buildMixGraph(options: Required<Pick<MixOptions, 'originalAudio' | 'duckingThreshold' | 'duckingRatio' | 'bgmVolume' | 'targetLufs' | 'targetTp'>>, hasBgm: boolean, durationSec: number): string {
  const parts: string[] = []
  const bedVolume = options.originalAudio === 'mute' ? 0 : options.originalAudio === 'keep' ? 1 : 0.85
  parts.push(`[0:a]${AFMT},volume=${bedVolume}[bed]`)

  if (hasBgm) {
    parts.push(`[1:a]${AFMT},asplit=3[vo_mix][vo_bed][vo_bgm]`)
    parts.push(`[2:a]${AFMT},volume=${options.bgmVolume},afade=t=out:st=${Math.max(0, durationSec - 2).toFixed(3)}:d=2[bgm]`)
  } else {
    parts.push(`[1:a]${AFMT},asplit=2[vo_mix][vo_bed]`)
  }

  if (options.originalAudio === 'keep' || options.originalAudio === 'mute') {
    parts.push('[bed]anull[ducked]')
  } else {
    parts.push(
      `[bed][vo_bed]sidechaincompress=threshold=${options.duckingThreshold}:ratio=${options.duckingRatio}:attack=15:release=320:makeup=1[ducked]`,
    )
  }

  if (hasBgm) {
    parts.push('[bgm][vo_bgm]sidechaincompress=threshold=0.05:ratio=2:attack=20:release=280:makeup=1[bgm_ducked]')
    parts.push('[ducked][bgm_ducked][vo_mix]amix=inputs=3:normalize=0:duration=first:weights=1 0.9 1.35[mix]')
  } else {
    parts.push('[ducked][vo_mix]amix=inputs=2:normalize=0:duration=first:weights=1 1.35[mix]')
  }

  parts.push(`[mix]alimiter=limit=0.95,loudnorm=I=${options.targetLufs}:TP=${options.targetTp}:LRA=9[out]`)
  return parts.join(';')
}

/**
 * 含附加音轨的混音图。轨道已提前渲染为与成片等长的独立输入。
 * 输入顺序：0 视频 / 1 对话 / 2 BGM（可选）/ 2..N 音轨 / 字幕。
 * range 用于范围试听：所有输入先裁到同一时间段。
 */
export function buildMixGraphWithTracks(
  options: Required<Pick<MixOptions, 'originalAudio' | 'duckingThreshold' | 'duckingRatio' | 'bgmVolume' | 'targetLufs' | 'targetTp'>>,
  layout: {
    hasBgm: boolean
    tracks: { volume: number; ducking: boolean }[]
    range?: { startSec: number; endSec: number }
    /** 范围试听不套片尾淡出，避免每段预览都以淡出收尾 */
    bgmFadeOut?: boolean
  },
  durationSec: number,
): string {
  const parts: string[] = []
  const trim = layout.range
    ? `,atrim=${layout.range.startSec.toFixed(3)}:${layout.range.endSec.toFixed(3)},asetpts=N/SR/TB`
    : ''
  const bedVolume = options.originalAudio === 'mute' ? 0 : options.originalAudio === 'keep' ? 1 : 0.85
  parts.push(`[0:a]${AFMT}${trim},volume=${bedVolume}[bed]`)

  const splitLabels = ['vo_mix', 'vo_bed']
  if (layout.hasBgm) splitLabels.push('vo_bgm')
  const duckingTracks = layout.tracks
    .map((track, index) => ({ ...track, index }))
    .filter((track) => track.ducking)
  for (const track of duckingTracks) splitLabels.push(`vo_trk${track.index}`)
  parts.push(`[1:a]${AFMT}${trim},asplit=${splitLabels.length}${splitLabels.map((label) => `[${label}]`).join('')}`)

  if (layout.hasBgm) {
    const fade = layout.bgmFadeOut === false
      ? ''
      : `,afade=t=out:st=${Math.max(0, durationSec - 2).toFixed(3)}:d=2`
    parts.push(`[2:a]${AFMT}${trim},volume=${options.bgmVolume}${fade}[bgm]`)
  }

  if (options.originalAudio === 'keep' || options.originalAudio === 'mute') {
    parts.push('[bed]anull[ducked]')
  } else {
    parts.push(
      `[bed][vo_bed]sidechaincompress=threshold=${options.duckingThreshold}:ratio=${options.duckingRatio}:attack=15:release=320:makeup=1[ducked]`,
    )
  }

  const mixLabels = ['[ducked]']
  const weights = [1]
  if (layout.hasBgm) {
    parts.push('[bgm][vo_bgm]sidechaincompress=threshold=0.05:ratio=2:attack=20:release=280:makeup=1[bgm_ducked]')
    mixLabels.push('[bgm_ducked]')
    weights.push(0.9)
  }

  const trackInputBase = 2 + (layout.hasBgm ? 1 : 0)
  layout.tracks.forEach((track, index) => {
    const volume = Math.max(0, Math.min(2, Number(track.volume) || 0))
    parts.push(`[${trackInputBase + index}:a]${AFMT}${trim},volume=${volume}[trk${index}]`)
    if (track.ducking) {
      parts.push(`[trk${index}][vo_trk${index}]sidechaincompress=threshold=0.05:ratio=2:attack=20:release=280:makeup=1[trk_duck${index}]`)
      mixLabels.push(`[trk_duck${index}]`)
    } else {
      mixLabels.push(`[trk${index}]`)
    }
    weights.push(1)
  })

  mixLabels.push('[vo_mix]')
  weights.push(1.35)
  parts.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0:duration=first:weights=${weights.join(' ')}[mix]`)
  parts.push(`[mix]alimiter=limit=0.95,loudnorm=I=${options.targetLufs}:TP=${options.targetTp}:LRA=9[out]`)
  return parts.join(';')
}

/**
 * 需要视频自带音轨；无音轨时先用 anullsrc 补一条静音底（保持滤镜图结构一致）。
 */
export async function mixEpisodeAudio(params: {
  videoPath: string
  dialoguePath: string
  outputPath: string
  options?: MixOptions
}): Promise<MixResult> {
  const { videoPath, dialoguePath, outputPath } = params
  const options = params.options || {}
  if (!fs.existsSync(videoPath)) throw new Error(`合片不存在：${videoPath}`)
  if (!fs.existsSync(dialoguePath)) throw new Error(`对话轨不存在：${dialoguePath}`)

  const durationMs = options.durationMs ?? (await probeDurationMs(videoPath))
  const durationSec = Math.max(1, durationMs / 1000)
  const originalAudio = options.originalAudio || 'duck'
  const bgmPath = options.bgmPath && fs.existsSync(options.bgmPath) ? options.bgmPath : null

  const resolved = {
    originalAudio,
    duckingThreshold: options.duckingThreshold ?? 0.05,
    duckingRatio: options.duckingRatio ?? 6,
    bgmVolume: options.bgmVolume ?? 0.18,
    targetLufs: options.targetLufs ?? -16,
    targetTp: options.targetTp ?? -2,
  }

  // 视频无音轨：先补一条静音，避免 [0:a] 直接失败
  let baseVideo = videoPath
  let tempSilent: string | null = null
  if (!(await hasAudioStream(videoPath))) {
    tempSilent = path.join(path.dirname(outputPath), `.silent-${uuid()}.mp4`)
    await execFfmpeg(
      [
        { path: videoPath },
        { path: 'anullsrc=r=48000:cl=stereo', options: ['-f', 'lavfi'] },
      ],
      null,
      ['-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart'],
      tempSilent,
    )
    baseVideo = tempSilent
  }

  const subtitleMode = options.subtitleMode || (options.subtitlePath ? 'soft' : 'none')
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  let tempBgm: string | null = null
  const tempTracks: string[] = []
  try {
    const activeTracks = (options.tracks || []).filter((track) => !track.muted)
    const inputs: { path: string; options?: string[] }[] = [{ path: baseVideo }, { path: dialoguePath }]
    // 输入顺序：0 视频 / 1 对话 / 2 BGM（可选）/ 2..N 音轨 / 最后 字幕（可选）
    if (bgmPath) {
      // 不能把无限循环的 BGM 直接当输入：amix 到时长就停，但 ffmpeg 会等输入 EOF 而挂住
      tempBgm = await buildLoopedBgmTrack(bgmPath, Math.round(durationSec * 1000), path.dirname(outputPath))
      inputs.push({ path: tempBgm })
    }

    const trackLayout: { volume: number; ducking: boolean }[] = []
    for (const track of activeTracks) {
      const file = await buildExtraTrackAudio(track, Math.round(durationSec * 1000), path.dirname(outputPath))
      if (!file) continue
      tempTracks.push(file)
      inputs.push({ path: file })
      trackLayout.push({ volume: track.volume, ducking: track.ducking !== false })
    }

    let subtitleInputIndex = -1
    if (subtitleMode === 'soft' && options.subtitlePath) {
      inputs.push({ path: options.subtitlePath, options: ['-f', 'srt'] })
      subtitleInputIndex = inputs.length - 1
    }

    const graph = trackLayout.length
      ? buildMixGraphWithTracks(resolved, { hasBgm: Boolean(bgmPath), tracks: trackLayout }, durationSec)
      : buildMixGraph(resolved, Boolean(bgmPath), durationSec)
    const outOptions = ['-map', '0:v:0', '-map', '[out]']

    if (subtitleMode === 'burn') {
      // 烧录必须重编码视频，与混音一次完成，避免二次编码
      const burnFilter = buildBurnFilter(options.subtitlePath, options.subtitleAssPath)
      if (burnFilter) {
        outOptions.push('-vf', burnFilter, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20')
      } else {
        outOptions.push('-c:v', 'copy')
      }
    } else {
      outOptions.push('-c:v', 'copy')
    }

    outOptions.push('-c:a', 'aac', '-b:a', '192k', '-ar', String(SR), '-ac', '2')
    if (subtitleMode === 'soft' && options.subtitlePath && subtitleInputIndex >= 0) {
      outOptions.push('-map', `${subtitleInputIndex}:s:0`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=chi')
    }
    // 不能用 -shortest：字幕流只到最后一个 cue，会把整片裁到字幕结束（实测丢了 5 秒）。
    // 用显式 -t 对齐成片时长。
    outOptions.push('-t', durationSec.toFixed(3), '-movflags', '+faststart')

    await execFfmpeg(inputs, graph, outOptions, outputPath)
  } finally {
    if (tempSilent) fs.rmSync(tempSilent, { force: true })
    if (tempBgm) fs.rmSync(tempBgm, { force: true })
    for (const file of tempTracks) fs.rmSync(file, { force: true })
  }

  return {
    outputPath,
    durationMs: await probeDurationMs(outputPath),
    hasBgm: Boolean(bgmPath),
    originalAudio,
    subtitleMode,
  }
}

/**
 * 范围试听：只出音频，所有输入裁到同一时间段，再走与成片相同的混音图。
 * 输出 m4a，供前端预览；不涉及视频编码。
 */
export async function renderAudioRange(params: {
  videoPath?: string | null
  dialoguePath: string
  outputPath: string
  rangeStartMs: number
  rangeEndMs: number
  options?: MixOptions
}): Promise<{ startMs: number; endMs: number; durationMs: number; hasBgm: boolean; trackCount: number }> {
  const options = params.options || {}
  if (!fs.existsSync(params.dialoguePath)) throw new Error(`对话轨不存在：${params.dialoguePath}`)

  const startMs = Math.max(0, Math.round(params.rangeStartMs || 0))
  const endMs = Math.max(startMs + 200, Math.round(params.rangeEndMs))
  const startSec = startMs / 1000
  const endSec = endMs / 1000
  const rangeSec = endSec - startSec
  const originalAudio = options.originalAudio || 'duck'
  const bgmPath = options.bgmPath && fs.existsSync(options.bgmPath) ? options.bgmPath : null

  const resolved = {
    originalAudio,
    duckingThreshold: options.duckingThreshold ?? 0.05,
    duckingRatio: options.duckingRatio ?? 6,
    bgmVolume: options.bgmVolume ?? 0.18,
    targetLufs: options.targetLufs ?? -16,
    targetTp: options.targetTp ?? -2,
  }

  const outDir = path.dirname(params.outputPath)
  const workDir = path.join(outDir, 'range-work')
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(workDir, { recursive: true })
  const tempFiles: string[] = []
  let hasBgm = false

  try {
    const inputs: { path: string; options?: string[] }[] = []
    if (params.videoPath && fs.existsSync(params.videoPath) && (await hasAudioStream(params.videoPath))) {
      inputs.push({ path: params.videoPath })
    } else {
      inputs.push({ path: 'anullsrc=r=48000:cl=stereo', options: ['-f', 'lavfi', '-t', endSec.toFixed(3)] })
    }
    inputs.push({ path: params.dialoguePath })

    if (bgmPath) {
      const looped = await buildLoopedBgmTrack(bgmPath, endMs, workDir)
      tempFiles.push(looped)
      inputs.push({ path: looped })
      hasBgm = true
    }

    const trackLayout: { volume: number; ducking: boolean }[] = []
    for (const track of (options.tracks || []).filter((t) => !t.muted)) {
      const file = await buildExtraTrackAudio(track, endMs, workDir)
      if (!file) continue
      tempFiles.push(file)
      inputs.push({ path: file })
      trackLayout.push({ volume: track.volume, ducking: track.ducking !== false })
    }

    const graph = buildMixGraphWithTracks(
      resolved,
      { hasBgm, tracks: trackLayout, range: { startSec, endSec }, bgmFadeOut: false },
      rangeSec,
    )
    await execFfmpeg(
      inputs,
      graph,
      ['-map', '[out]', '-c:a', 'aac', '-b:a', '192k', '-ar', String(SR), '-ac', '2', '-t', rangeSec.toFixed(3), '-movflags', '+faststart'],
      params.outputPath,
    )
  } finally {
    for (const file of tempFiles) fs.rmSync(file, { force: true })
  }

  return {
    startMs,
    endMs,
    durationMs: await probeDurationMs(params.outputPath),
    hasBgm,
    trackCount: (options.tracks || []).filter((t) => !t.muted).length,
  }
}
