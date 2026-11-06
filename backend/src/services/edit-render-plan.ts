/**
 * 剪辑渲染器（技术设计 §6.10 支持范围表）：
 * - 逐片段渲染为统一参数（WxH@fps + H.264 yuv420p + AAC 48k 立体声），再 concat -c copy；
 * - 降级项（转场→硬切、滤镜、缩放位移、叠加轨）通过 buildRenderReport 全量列出，
 *   供导出确认弹窗使用；渲染本身按降级后的语义输出；
 * - 字幕三模式：burn（ASS 重编码烧录）/ soft（mov_text 软字幕流）/ none；
 * - 不支持项绝不出现在报告中以外的位置：渲染前先产出完整警告清单。
 */
import { execFile, execFileSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getAbsolutePath } from '../utils/storage.js'
import { resolveFfmpegSuite } from '../utils/ffmpeg.js'
import { computeLayout, type EditClip, type EditPlanV1 } from './edit-plan.js'

export interface EditRenderWarning { code: string; message: string }

/** 导出降级清单：所有不支持项必须出现在报告中（设计 6.10 支持范围表） */
export function buildRenderReport(plan: EditPlanV1): { warnings: EditRenderWarning[] } {
  const warnings: EditRenderWarning[] = []
  if (plan.transitions.length) {
    warnings.push({ code: 'TRANSITION_HARD_CUT', message: '转场将按硬切导出' })
  }
  if (plan.clips.some((clip) => clip.filter.preset !== 'none')) {
    warnings.push({ code: 'FILTER_UNSUPPORTED', message: '滤镜暂不支持导出，将按原画面输出' })
  }
  if (plan.clips.some((clip) => clip.transform.scale !== 1 || clip.transform.x !== 0 || clip.transform.y !== 0)) {
    warnings.push({ code: 'TRANSFORM_UNSUPPORTED', message: '缩放与位移暂不支持导出' })
  }
  if (plan.overlays.length) {
    warnings.push({ code: 'OVERLAY_UNSUPPORTED', message: '叠加轨（画中画/文字）暂不支持导出，将忽略' })
  }
  if (plan.clips.some((clip) => (Number(clip.speed) || 1) < 0.5 || (Number(clip.speed) || 1) > 2)) {
    warnings.push({ code: 'SPEED_CLAMPED', message: '变速超出 0.5–2×，将夹取到支持范围' })
  }
  return { warnings }
}

const VIDEO_ARGS = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']
const AUDIO_ARGS = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']

function run(args: string[]): Promise<void> {
  const bin = resolveFfmpegSuite().ffmpeg.path || 'ffmpeg'
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['-hide_banner', '-loglevel', 'error', ...args],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error) => {
        if (error) reject(new Error(`渲染失败：${error.message}`))
        else resolve()
      },
    )
  })
}

/** 变速夹取到渲染支持范围（0.5–2×） */
function clampSpeed(clip: EditClip): number {
  const speed = Number(clip.speed)
  if (!Number.isFinite(speed) || speed <= 0) return 1
  return Math.min(2, Math.max(0.5, speed))
}

/** 计划里的源地址是存储相对路径；测试与外部导入允许绝对路径 */
function resolveSourceUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) throw new Error(`源素材必须为本地文件：${url}`)
  if (path.isAbsolute(url)) return url
  return getAbsolutePath(url)
}

function videoFilter(clip: EditClip, plan: EditPlanV1): string[] {
  const { width, height } = plan.project
  const fps = plan.project.fps
  const t = clip.transform
  const speed = clampSpeed(clip)
  const chain: string[] = []
  // 变速先压缩时间戳，后续 fade 的 st/d 均按换算后的输出时长计
  if (speed !== 1 && clip.kind === 'video') chain.push(`setpts=${(1 / speed).toFixed(6)}*PTS`)
  chain.push(`fps=${fps}`)
  if (t.rotation === 90) chain.push('transpose=1')
  if (t.rotation === 270) chain.push('transpose=2')
  if (t.rotation === 180) chain.push('transpose=1,transpose=1')
  if (t.flipH) chain.push('hflip')
  if (t.flipV) chain.push('vflip')
  if (plan.project.defaultFit === 'fill') {
    chain.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`)
    chain.push(`crop=${width}:${height}`)
  } else {
    chain.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`)
    chain.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`)
  }
  // 淡入淡出按速度换算后的输出时长计算（含等比缩短兜底）
  const outputContentMs = (clip.sourceOutMs - clip.sourceInMs) / speed
  if (clip.videoFadeInMs > 0) {
    chain.push(`fade=t=in:st=0:d=${(Math.min(clip.videoFadeInMs, outputContentMs) / 1000).toFixed(3)}`)
  }
  if (clip.videoFadeOutMs > 0) {
    const fadeOutMs = Math.min(clip.videoFadeOutMs, outputContentMs)
    chain.push(`fade=t=out:st=${((outputContentMs - fadeOutMs) / 1000).toFixed(3)}:d=${(fadeOutMs / 1000).toFixed(3)}`)
  }
  chain.push('format=yuv420p')
  return chain
}

function audioFilter(clip: EditClip): string[] {
  const speed = clampSpeed(clip)
  const chain: string[] = []
  if (speed !== 1) chain.push(`atempo=${speed}`)
  const outputContentMs = (clip.sourceOutMs - clip.sourceInMs) / speed
  if (clip.videoFadeInMs > 0) {
    chain.push(`afade=t=in:st=0:d=${(Math.min(clip.videoFadeInMs, outputContentMs) / 1000).toFixed(3)}`)
  }
  if (clip.videoFadeOutMs > 0) {
    const fadeOutMs = Math.min(clip.videoFadeOutMs, outputContentMs)
    chain.push(`afade=t=out:st=${((outputContentMs - fadeOutMs) / 1000).toFixed(3)}:d=${(fadeOutMs / 1000).toFixed(3)}`)
  }
  chain.push('aresample=48000')
  return chain
}

async function renderSegment(
  plan: EditPlanV1,
  clip: EditClip,
  file: string,
): Promise<void> {
  const { fps } = plan.project
  const speed = clampSpeed(clip)
  const sourceSec = ((clip.sourceOutMs - clip.sourceInMs) / 1000).toFixed(3)
  const outputSec = ((clip.sourceOutMs - clip.sourceInMs) / speed / 1000).toFixed(3)
  if (clip.kind === 'image') {
    // 图片片段：循环为视频帧，配 anullsrc 静音轨，时长按变速换算
    await run([
      '-y', '-loop', '1', '-t', outputSec, '-i', resolveSourceUrl(clip.source.url),
      '-f', 'lavfi', '-t', outputSec, '-i', 'anullsrc=r=48000:cl=stereo',
      '-map', '0:v:0', '-map', '1:a:0',
      '-vf', videoFilter(clip, plan).join(','), '-af', 'aresample=48000',
      '-r', String(fps), ...VIDEO_ARGS, ...AUDIO_ARGS,
      '-shortest', file,
    ])
    return
  }
  if (!clip.source.hasAudio) {
    // 无声视频：混入 anullsrc，保证拼接后始终存在音频流
    await run([
      '-y', '-ss', (clip.sourceInMs / 1000).toFixed(3), '-t', sourceSec, '-i', resolveSourceUrl(clip.source.url),
      '-f', 'lavfi', '-t', outputSec, '-i', 'anullsrc=r=48000:cl=stereo',
      '-map', '0:v:0', '-map', '1:a:0',
      '-vf', videoFilter(clip, plan).join(','),
      '-r', String(fps), ...VIDEO_ARGS, ...AUDIO_ARGS,
      '-shortest', file,
    ])
    return
  }
  await run([
    '-y', '-ss', (clip.sourceInMs / 1000).toFixed(3), '-t', sourceSec, '-i', resolveSourceUrl(clip.source.url),
    '-vf', videoFilter(clip, plan).join(','),
    '-af', audioFilter(clip).join(','),
    '-r', String(fps), ...VIDEO_ARGS, ...AUDIO_ARGS,
    file,
  ])
}

async function renderGap(plan: EditPlanV1, gapMs: number, file: string): Promise<void> {
  const { width, height, fps } = plan.project
  const sec = (gapMs / 1000).toFixed(3)
  await run([
    '-y',
    '-f', 'lavfi', '-t', sec, '-i', `color=c=black:s=${width}x${height}:r=${fps}`,
    '-f', 'lavfi', '-t', sec, '-i', 'anullsrc=r=48000:cl=stereo',
    '-r', String(fps), ...VIDEO_ARGS, ...AUDIO_ARGS,
    file,
  ])
}

export async function renderEditVideo(input: {
  plan: EditPlanV1
  outputPath: string
  subtitleMode: 'burn' | 'soft' | 'none'
  assPath?: string
  srtPath?: string
  onProgress?: (pct: number) => void
}): Promise<{ durationMs: number; warnings: EditRenderWarning[] }> {
  const warnings = buildRenderReport(input.plan).warnings
  const layout = computeLayout(input.plan)
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'huobao-edit-render-'))
  try {
    const listLines: string[] = []
    let prevEndMs = 0
    let index = 0
    for (const layoutClip of layout.clips) {
      const clip = input.plan.clips.find((c) => c.id === layoutClip.clipId)
      if (!clip) continue
      // 布局不含 gap 字段：空档 = 本片段起点 − 上一片段终点（转场重叠为负值，按硬切拼接）
      const gapMs = layoutClip.timelineStartMs - prevEndMs
      if (gapMs > 0) {
        const gapFile = path.join(workDir, `gap-${index}.mp4`)
        await renderGap(input.plan, gapMs, gapFile)
        listLines.push(`file '${gapFile.replace(/'/g, "'\\''")}'`)
      }
      const segFile = path.join(workDir, `seg-${index}.mp4`)
      await renderSegment(input.plan, clip, segFile)
      listLines.push(`file '${segFile.replace(/'/g, "'\\''")}'`)
      prevEndMs = layoutClip.timelineEndMs
      index += 1
      input.onProgress?.(Math.round((index / Math.max(1, layout.clips.length)) * 80))
    }
    if (!listLines.length) throw new Error('时间线没有任何可渲染片段')
    const listFile = path.join(workDir, 'list.txt')
    await fsp.writeFile(listFile, listLines.join('\n'), 'utf8')
    const concatFile = path.join(workDir, 'concat.mp4')
    await run(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', concatFile])
    input.onProgress?.(85)

    // 字幕阶段：burn 需要重编码；soft 挂 mov_text 流；none 直接拷贝。三分支统一 +faststart
    if (input.subtitleMode === 'burn' && input.assPath) {
      const assFilterPath = input.assPath.replace(/\\/g, '/').replace(/:/g, '\\:')
      await run([
        '-y', '-i', concatFile,
        '-vf', `ass=${assFilterPath}`,
        ...VIDEO_ARGS,
        '-c:a', 'copy', '-movflags', '+faststart', input.outputPath,
      ])
    } else if (input.subtitleMode === 'soft' && input.srtPath) {
      await run([
        '-y', '-i', concatFile, '-i', input.srtPath,
        '-c', 'copy', '-c:s', 'mov_text',
        '-metadata:s:s:0', 'language=chi', '-movflags', '+faststart', input.outputPath,
      ])
    } else {
      await run(['-y', '-i', concatFile, '-c', 'copy', '-movflags', '+faststart', input.outputPath])
    }
    input.onProgress?.(95)
    const durationMs = await probeDurationMs(input.outputPath)
    return { durationMs, warnings }
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true })
  }
}

async function probeDurationMs(file: string): Promise<number> {
  const bin = resolveFfmpegSuite().ffprobe.path || 'ffprobe'
  const out = execFileSync(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString()
  return Math.round(Number(out.trim()) * 1000)
}
