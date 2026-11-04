/**
 * AI 过渡片段合片插入 — 纯规划 + 数据/文件校验
 *
 * 只把已完成、启用、来源未变且文件可读的过渡插在断点之间；
 * 其余断点保留原转场并把原因写入快照，任何回退都不阻断合片。
 */
import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import { ffmpeg } from '../utils/ffmpeg.js'
import { transitionSourceHash } from './transition-plan.js'

export interface MergeStoryboard {
  id: number
  url: string
  transition?: string | null
}

export interface TransitionCandidate {
  id: number
  fromStoryboardId: number
  toStoryboardId: number
  videoUrl: string | null
  durationActual: number | null
  enabled: boolean | null
  status: string
  stale: boolean
  /** 文件存在但 ffprobe 无法解析（损坏），合片时剔除 */
  corrupt?: boolean
}

export interface TransitionMergeClip {
  url: string
  transition?: string | null
  transitionMs?: number | null
  transitionId?: number
}

export interface TransitionSnapshotEntry {
  from_storyboard_id: number
  to_storyboard_id: number
  transition_id: number | null
  status: 'used' | 'fallback'
  reason?: string
  video_url?: string
}

export interface TransitionInsertionResult {
  clips: TransitionMergeClip[]
  snapshot: TransitionSnapshotEntry[]
  used: number
  fallback: number
}

const MIN_TRANSITION_CLIP_MS = 300
const DEFAULT_EDGE_TRANSITION_MS = 200

function fallbackReason(candidate: TransitionCandidate | undefined): string {
  if (!candidate) return 'missing'
  if (candidate.enabled === false) return 'skipped'
  if (candidate.status !== 'completed') return candidate.status || 'missing'
  if (candidate.stale) return 'stale'
  if (candidate.corrupt) return 'corrupt'
  if (!candidate.videoUrl) return 'file-missing'
  return 'too-short'
}

function isUsable(candidate: TransitionCandidate | undefined): candidate is TransitionCandidate & { videoUrl: string } {
  return !!candidate
    && candidate.enabled !== false
    && candidate.status === 'completed'
    && !candidate.stale
    && !candidate.corrupt
    && !!candidate.videoUrl
    && Number(candidate.durationActual) * 1000 >= MIN_TRANSITION_CLIP_MS
}

/** 纯函数：按断点插入过渡片段，返回增强后的合片序列与断点快照 */
export function buildTransitionInsertion(
  storyboards: MergeStoryboard[],
  candidates: TransitionCandidate[],
  options: { transitionMs?: number } = {},
): TransitionInsertionResult {
  const byKey = new Map<string, TransitionCandidate>()
  for (const candidate of candidates) {
    const key = `${candidate.fromStoryboardId}:${candidate.toStoryboardId}`
    const current = byKey.get(key)
    if (!current || candidate.id > current.id) byKey.set(key, candidate)
  }
  const edgeMs = Math.max(1, Math.round(Number(options.transitionMs) || DEFAULT_EDGE_TRANSITION_MS))
  const clips: TransitionMergeClip[] = []
  const snapshot: TransitionSnapshotEntry[] = []
  let used = 0
  let fallback = 0

  for (let i = 0; i < storyboards.length; i++) {
    const storyboard = storyboards[i]
    if (i > 0) {
      const previous = storyboards[i - 1]
      const candidate = byKey.get(`${previous.id}:${storyboard.id}`)
      if (isUsable(candidate)) {
        clips.push({
          url: candidate.videoUrl,
          transition: 'fade',
          transitionMs: edgeMs,
          transitionId: candidate.id,
        })
        clips.push({ url: storyboard.url, transition: 'fade', transitionMs: edgeMs })
        snapshot.push({
          from_storyboard_id: previous.id,
          to_storyboard_id: storyboard.id,
          transition_id: candidate.id,
          status: 'used',
          video_url: candidate.videoUrl,
        })
        used++
        continue
      }
      fallback++
      snapshot.push({
        from_storyboard_id: previous.id,
        to_storyboard_id: storyboard.id,
        transition_id: candidate?.id ?? null,
        status: 'fallback',
        reason: fallbackReason(candidate),
      })
    }
    clips.push({ url: storyboard.url, transition: storyboard.transition || 'cut' })
  }

  return { clips, snapshot, used, fallback }
}

function statFor(relativePath: string): { size: number; mtimeMs: number } {
  try {
    const stat = fs.statSync(getAbsolutePath(relativePath))
    return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
  } catch {
    return { size: 0, mtimeMs: 0 }
  }
}

function fileExists(relativePath: string | null | undefined): boolean {
  if (!relativePath) return false
  try {
    return fs.statSync(getAbsolutePath(relativePath)).size > 0
  } catch {
    return false
  }
}

function probeDurationSeconds(file: string): Promise<number | null> {
  return new Promise(resolve => {
    ffmpeg.ffprobe(getAbsolutePath(file), (error, metadata) => {
      if (error) return resolve(null)
      const value = Number(metadata?.format?.duration)
      resolve(Number.isFinite(value) && value > 0 ? Math.round(value * 1000) / 1000 : null)
    })
  })
}

function boundaryHash(previous: MergeStoryboard, current: MergeStoryboard): string {
  const from = statFor(previous.url)
  const to = statFor(current.url)
  return transitionSourceHash({
    fromVideoUrl: previous.url,
    toVideoUrl: current.url,
    fromSize: from.size,
    fromMtimeMs: from.mtimeMs,
    toSize: to.size,
    toMtimeMs: to.mtimeMs,
  })
}

/** 读取本集过渡记录并与当前镜头来源指纹比对；不可用原因由纯函数统一归类 */
export async function loadTransitionCandidates(
  episodeId: number,
  storyboards: MergeStoryboard[],
): Promise<TransitionCandidate[]> {
  const rows = await db.select().from(schema.videoTransitions)
    .where(eq(schema.videoTransitions.episodeId, episodeId))
  if (!rows.length) return []
  const byKey = new Map<string, typeof schema.videoTransitions.$inferSelect>()
  for (const row of rows) {
    const key = `${row.fromStoryboardId}:${row.toStoryboardId}`
    const current = byKey.get(key)
    if (!current || row.id > current.id) byKey.set(key, row)
  }

  const candidates: TransitionCandidate[] = []
  for (let i = 1; i < storyboards.length; i++) {
    const previous = storyboards[i - 1]
    const current = storyboards[i]
    const row = byKey.get(`${previous.id}:${current.id}`)
    if (!row) continue
    const exists = fileExists(row.videoUrl)
    // 设计 9.4：文件必须存在且能 ffprobe；解析失败时不能用库里的旧时长兜底，
    // 否则损坏文件会被当成可用片段插进合片序列，导致整次合片失败。
    const probed = exists && row.videoUrl ? await probeDurationSeconds(row.videoUrl) : null
    candidates.push({
      id: row.id,
      fromStoryboardId: row.fromStoryboardId,
      toStoryboardId: row.toStoryboardId,
      videoUrl: exists ? row.videoUrl : null,
      durationActual: probed,
      enabled: row.enabled,
      status: row.status || 'missing',
      stale: row.sourceHash !== boundaryHash(previous, current),
      corrupt: exists && probed === null,
    })
  }
  return candidates
}

export async function prepareTransitionInsertion(
  episodeId: number,
  storyboards: MergeStoryboard[],
  options: { transitionMs?: number } = {},
): Promise<TransitionInsertionResult> {
  const candidates = await loadTransitionCandidates(episodeId, storyboards)
  return buildTransitionInsertion(storyboards, candidates, options)
}
