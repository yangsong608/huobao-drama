/**
 * 视频换人镜头/片段计划的纯函数：
 * - 硬切镜头 → 0-based shot
 * - 镜头内按最大生成时长拆 0-based chunk
 * - 片段重叠、最短片段、最大片段数
 * - 稳定帧切点解析
 */
export const PLAN_FRAME_RATE = 24
export const DEFAULT_FACE_MAX_SECONDS = 8
export const DEFAULT_CHARACTER_MAX_SECONDS = 10
export const DEFAULT_CHUNK_OVERLAP_MS = 1000
export const DEFAULT_MIN_CHUNK_SECONDS = 5
export const DEFAULT_MAX_CHUNKS = 50
export const MIN_SHOT_MS = 300

export interface SceneSample {
  timeMs: number
  score: number
}

export interface PlannedChunk {
  chunkIndex: number
  sourceStartMs: number
  sourceEndMs: number
  overlapBeforeMs: number
  overlapAfterMs: number
  targetFrames: number
  cutPointConfidence: number
}

export interface PlannedShot {
  shotIndex: number
  startMs: number
  endMs: number
  durationMs: number
  chunkCount: number
  chunks: PlannedChunk[]
}

export type CutResolver = (
  nominalMs: number,
  minMs: number,
  maxMs: number,
) => { timeMs: number; confidence: number } | null

export class VideoPlanError extends Error {}

export function planShots(durationMs: number, sceneCutsMs: number[], minShotMs = MIN_SHOT_MS): Omit<PlannedShot, 'chunks' | 'chunkCount'>[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new VideoPlanError('视频时长无效')
  const cuts = [...new Set(
    sceneCutsMs
      .map(value => Math.round(Number(value)))
      .filter(value => Number.isFinite(value) && value > 0 && value < durationMs),
  )].sort((a, b) => a - b)
  const boundaries = [0]
  for (const cut of cuts) {
    const last = boundaries[boundaries.length - 1]
    if (cut - last < minShotMs) continue
    if (durationMs - cut < minShotMs) continue
    boundaries.push(cut)
  }
  boundaries.push(durationMs)
  const shots: Omit<PlannedShot, 'chunks' | 'chunkCount'>[] = []
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const startMs = boundaries[i]
    const endMs = boundaries[i + 1]
    if (endMs <= startMs) continue
    shots.push({
      shotIndex: shots.length,
      startMs,
      endMs,
      durationMs: endMs - startMs,
    })
  }
  if (!shots.length) {
    shots.push({ shotIndex: 0, startMs: 0, endMs: Math.round(durationMs), durationMs: Math.round(durationMs) })
  }
  return shots
}

export function chooseStableCut(
  samples: SceneSample[],
  nominalMs: number,
  windowMs = 500,
  minMs = 0,
  maxMs = Number.POSITIVE_INFINITY,
): { timeMs: number; confidence: number } | null {
  if (!Array.isArray(samples) || !samples.length) return null
  const low = Math.max(0, nominalMs - windowMs, minMs)
  const high = Math.min(nominalMs + windowMs, maxMs)
  let best: SceneSample | null = null
  for (const sample of samples) {
    if (!Number.isFinite(sample?.timeMs) || !Number.isFinite(sample?.score)) continue
    if (sample.timeMs < low || sample.timeMs > high) continue
    if (!best || sample.score < best.score || (sample.score === best.score && sample.timeMs > best.timeMs)) {
      best = sample
    }
  }
  if (!best) return null
  return {
    timeMs: Math.round(best.timeMs),
    confidence: Math.max(0, Math.min(1, 1 - best.score)),
  }
}

export function planShotChunks(shot: Omit<PlannedShot, 'chunks' | 'chunkCount'>, options: {
  maxGenerationSeconds: number
  overlapMs?: number
  minChunkSeconds?: number
  maxChunks?: number
  cutResolver?: CutResolver
}): PlannedChunk[] {
  const maxMs = Math.max(1000, Math.round(Number(options.maxGenerationSeconds) * 1000))
  const overlapMs = Math.max(0, Math.min(maxMs - 1000, Math.round(Number(options.overlapMs ?? DEFAULT_CHUNK_OVERLAP_MS))))
  const minMs = Math.max(1000, Math.min(maxMs, Math.round(Number(options.minChunkSeconds ?? DEFAULT_MIN_CHUNK_SECONDS) * 1000)))
  const maxChunks = Math.max(1, Math.round(Number(options.maxChunks ?? DEFAULT_MAX_CHUNKS)))
  const durationMs = shot.endMs - shot.startMs
  if (durationMs <= 0) throw new VideoPlanError('镜头时长无效')
  if (durationMs <= maxMs) {
    return [{
      chunkIndex: 0,
      sourceStartMs: shot.startMs,
      sourceEndMs: shot.endMs,
      overlapBeforeMs: 0,
      overlapAfterMs: 0,
      targetFrames: framesFor(durationMs),
      cutPointConfidence: 1,
    }]
  }

  const chunkCount = feasibleChunkCount(durationMs, maxMs, minMs, overlapMs, maxChunks)
  if (chunkCount === null) {
    const maxCoverage = maxChunks * maxMs - (maxChunks - 1) * overlapMs
    if (durationMs > maxCoverage) throw new VideoPlanError(`片段数超过上限 ${maxChunks}`)
    // 时长落在最短片段约束造成的“不可拆区间”，只能整段生成；
    // 这是比生成低于最短时长的片段更安全的降级。
    return [{
      chunkIndex: 0,
      sourceStartMs: shot.startMs,
      sourceEndMs: shot.endMs,
      overlapBeforeMs: 0,
      overlapAfterMs: 0,
      targetFrames: framesFor(durationMs),
      cutPointConfidence: 1,
    }]
  }

  const chunks: PlannedChunk[] = []
  let cursor = shot.startMs
  for (let i = 0; i < chunkCount; i += 1) {
    const chunksLeft = chunkCount - i
    if (chunksLeft === 1) {
      chunks.push(makeChunk(i, cursor, shot.endMs, i === 0 ? 0 : overlapMs, 0, 1))
      break
    }
    const remainingCoverage = shot.endMs - cursor
    const targetLength = (remainingCoverage + (chunksLeft - 1) * overlapMs) / chunksLeft
    const rest = chunksLeft - 1
    const minEnd = Math.max(cursor + minMs, shot.endMs + rest * overlapMs - rest * maxMs)
    const maxEnd = Math.min(cursor + maxMs, shot.endMs + rest * overlapMs - rest * minMs)
    const nominalEnd = cursor + Math.round(targetLength)
    const resolved = options.cutResolver?.(nominalEnd, minEnd, maxEnd) ?? null
    const end = Math.max(minEnd, Math.min(maxEnd, Math.round(resolved?.timeMs ?? nominalEnd)))
    if (end - cursor < minMs) throw new VideoPlanError('无法生成满足最短时长的片段')
    chunks.push(makeChunk(
      i,
      cursor,
      end,
      i === 0 ? 0 : overlapMs,
      overlapMs,
      resolved?.confidence ?? 1,
    ))
    cursor = end - overlapMs
  }
  return chunks
}

function feasibleChunkCount(
  coverageMs: number,
  maxMs: number,
  minMs: number,
  overlapMs: number,
  maxChunks: number,
): number | null {
  for (let count = 1; count <= maxChunks; count += 1) {
    const minTotal = count * minMs - (count - 1) * overlapMs
    const maxTotal = count * maxMs - (count - 1) * overlapMs
    if (coverageMs >= minTotal && coverageMs <= maxTotal) return count
  }
  return null
}

function makeChunk(
  chunkIndex: number,
  startMs: number,
  endMs: number,
  overlapBeforeMs: number,
  overlapAfterMs: number,
  confidence: number,
): PlannedChunk {
  return {
    chunkIndex,
    sourceStartMs: Math.round(startMs),
    sourceEndMs: Math.round(endMs),
    overlapBeforeMs,
    overlapAfterMs,
    targetFrames: framesFor(endMs - startMs),
    cutPointConfidence: Math.max(0, Math.min(1, confidence)),
  }
}

function framesFor(durationMs: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * PLAN_FRAME_RATE))
}

export function planVideoChunks(durationMs: number, sceneCutsMs: number[], options: {
  maxGenerationSeconds: number
  overlapMs?: number
  minChunkSeconds?: number
  maxChunks?: number
  cutResolver?: CutResolver
}): PlannedShot[] {
  const shots = planShots(durationMs, sceneCutsMs)
  const maxChunks = Math.max(1, Math.round(Number(options.maxChunks ?? DEFAULT_MAX_CHUNKS)))
  let total = 0
  return shots.map(shot => {
    const chunks = planShotChunks(shot, options)
    total += chunks.length
    if (total > maxChunks) throw new VideoPlanError(`片段数超过上限 ${maxChunks}`)
    return { ...shot, chunkCount: chunks.length, chunks }
  })
}

export function maxGenerationSecondsForMode(mode: string): number {
  return mode === 'character' ? DEFAULT_CHARACTER_MAX_SECONDS : DEFAULT_FACE_MAX_SECONDS
}
