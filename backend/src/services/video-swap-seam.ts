/**
 * 接缝检查：比较上一片段最后一帧与下一片段第一帧。
 * SSIM 与颜色差在本进程计算；人脸相似度是可插拔可空指标，没有本地人脸模型时为 null。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { ffmpeg } from '../utils/ffmpeg.js'
import { probeMedia, SWAP_FPS } from './video-swap-media.js'

export interface SeamThresholds {
  ssim: number
  colorDelta: number
  faceSimilarity: number
}

export interface SeamMetrics {
  ssim: number
  colorDelta: number
  faceSimilarity: number | null
}

export interface SeamRecord {
  prev_chunk_id: number
  next_chunk_id: number
  prev_frame_path: string
  next_frame_path: string
  ssim: number
  color_delta: number
  face_similarity: number | null
  verdict: 'ok' | 'warning'
  thresholds: SeamThresholds
  checked_at: string
}

export type FaceSimilarityProvider = (
  prevFrame: string,
  nextFrame: string,
) => Promise<number | null>

export const DEFAULT_SEAM_THRESHOLDS: SeamThresholds = {
  ssim: 0.92,
  colorDelta: 12,
  faceSimilarity: 0.75,
}

export function seamThresholdsFromSettings(settings: Record<string, unknown> = {}): SeamThresholds {
  const pick = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(settings[key])
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
  }
  return {
    ssim: pick('seam_ssim_threshold', DEFAULT_SEAM_THRESHOLDS.ssim, 0, 1),
    colorDelta: pick('seam_color_delta_threshold', DEFAULT_SEAM_THRESHOLDS.colorDelta, 0, 255),
    faceSimilarity: pick('seam_face_similarity_threshold', DEFAULT_SEAM_THRESHOLDS.faceSimilarity, 0, 1),
  }
}

export function seamVerdict(metrics: SeamMetrics, thresholds: SeamThresholds): 'ok' | 'warning' {
  if (!Number.isFinite(metrics.ssim) || !Number.isFinite(metrics.colorDelta)) return 'warning'
  if (metrics.ssim < thresholds.ssim) return 'warning'
  if (metrics.colorDelta > thresholds.colorDelta) return 'warning'
  if (metrics.faceSimilarity !== null && metrics.faceSimilarity < thresholds.faceSimilarity) return 'warning'
  return 'ok'
}

async function extractFrame(video: string, frameIndex: number, output: string): Promise<void> {
  await fsp.mkdir(path.dirname(output), { recursive: true })
  await fsp.rm(output, { force: true })
  await new Promise<void>((resolve, reject) => {
    ffmpeg(video)
      .outputOptions([
        '-vf', `fps=${SWAP_FPS},select=eq(n\\,${Math.max(0, Math.round(frameIndex))})`,
        '-vsync', 'vfr',
        '-frames:v', '1',
      ])
      .output(output)
      .on('end', () => resolve())
      .on('error', (error: Error) => reject(new Error(`提取接缝帧失败：${error.message}`)))
      .run()
  })
  const stat = await fsp.stat(output).catch(() => null)
  if (!stat || stat.size === 0) throw new Error('接缝帧为空')
}

async function decodeRgb(file: string): Promise<{ data: Buffer; width: number; height: number }> {
  const result = await sharp(file)
    .resize(256, 256, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data: result.data, width: result.info.width, height: result.info.height }
}

export async function computeSeamMetrics(
  prevFrame: string,
  nextFrame: string,
  faceSimilarity?: FaceSimilarityProvider,
): Promise<SeamMetrics> {
  const [a, b] = await Promise.all([decodeRgb(prevFrame), decodeRgb(nextFrame)])
  const pixels = Math.min(a.width * a.height, b.width * b.height)
  if (!pixels) throw new Error('接缝帧尺寸无效')
  let sumA = 0
  let sumB = 0
  let sumAA = 0
  let sumBB = 0
  let sumAB = 0
  let colorDelta = 0
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 3
    const ar = a.data[offset]
    const ag = a.data[offset + 1]
    const ab = a.data[offset + 2]
    const br = b.data[offset]
    const bg = b.data[offset + 1]
    const bb = b.data[offset + 2]
    const ga = (ar + ag + ab) / 3
    const gb = (br + bg + bb) / 3
    sumA += ga
    sumB += gb
    sumAA += ga * ga
    sumBB += gb * gb
    sumAB += ga * gb
    colorDelta += (Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb)) / 3
  }
  const meanA = sumA / pixels
  const meanB = sumB / pixels
  const varianceA = Math.max(0, sumAA / pixels - meanA * meanA)
  const varianceB = Math.max(0, sumBB / pixels - meanB * meanB)
  const covariance = sumAB / pixels - meanA * meanB
  const c1 = (0.01 * 255) ** 2
  const c2 = (0.03 * 255) ** 2
  const numerator = (2 * meanA * meanB + c1) * (2 * covariance + c2)
  const denominator = (meanA * meanA + meanB * meanB + c1) * (varianceA + varianceB + c2)
  const ssim = denominator > 0 ? numerator / denominator : 0
  let face: number | null = null
  if (faceSimilarity) {
    try {
      const value = await faceSimilarity(prevFrame, nextFrame)
      face = value !== null && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null
    } catch {
      face = null
    }
  }
  return {
    ssim: Math.round(Math.min(1, Math.max(0, ssim)) * 10_000) / 10_000,
    colorDelta: Math.round((colorDelta / pixels) * 100) / 100,
    faceSimilarity: face === null ? null : Math.round(face * 10_000) / 10_000,
  }
}

export async function checkVideoSeam(input: {
  prevVideo: string
  nextVideo: string
  prevChunkId: number
  nextChunkId: number
  seamDir: string
  thresholds: SeamThresholds
  faceSimilarity?: FaceSimilarityProvider
}): Promise<SeamRecord> {
  const [prevInfo, nextInfo] = await Promise.all([
    probeMedia(input.prevVideo),
    probeMedia(input.nextVideo),
  ])
  const prevFrame = path.join(input.seamDir, `prev-chunk-${input.prevChunkId}.png`)
  const nextFrame = path.join(input.seamDir, `next-chunk-${input.nextChunkId}.png`)
  const prevLastIndex = Math.max(0, Math.floor((prevInfo.durationMs / 1000) * SWAP_FPS) - 1)
  await extractFrame(input.prevVideo, prevLastIndex, prevFrame)
  await extractFrame(input.nextVideo, 0, nextFrame)
  const metrics = await computeSeamMetrics(prevFrame, nextFrame, input.faceSimilarity)
  return {
    prev_chunk_id: input.prevChunkId,
    next_chunk_id: input.nextChunkId,
    prev_frame_path: prevFrame,
    next_frame_path: nextFrame,
    ssim: metrics.ssim,
    color_delta: metrics.colorDelta,
    face_similarity: metrics.faceSimilarity,
    verdict: seamVerdict(metrics, input.thresholds),
    thresholds: input.thresholds,
    checked_at: new Date().toISOString(),
  }
}
