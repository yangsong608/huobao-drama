import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { isAutomationRunning } from './automation.js'

export type ReworkReason = 'automation_running' | 'dubbing_running' | 'queue_running'

export class ReworkError extends Error {
  status: 404 | 409
  details?: Record<string, unknown>

  constructor(message: string, status: 404 | 409 = 409, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ReworkError'
    this.status = status
    this.details = details
  }
}

export interface ReworkResult {
  episodeId: number
  deletedStoryboards: number
}

/**
 * 按新原文重做：清剧本、软删分镜、重置自动化状态，保留视频/合片与 source_stale。
 * source_stale 只由自动化成功后的 finishRun(done) 清零。
 */
export function reworkEpisode(episodeId: number): ReworkResult {
  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId)).get()
  if (!episode || episode.deletedAt) throw new ReworkError('剧集不存在', 404)

  const reasons: ReworkReason[] = []
  if (isAutomationRunning(episodeId) || episode.automationStatus === 'running') {
    reasons.push('automation_running')
  }
  if (episode.dubStatus === 'running') reasons.push('dubbing_running')
  const queued = db.select({ id: schema.pipelineJobs.id }).from(schema.pipelineJobs)
    .where(and(
      eq(schema.pipelineJobs.episodeId, episodeId),
      inArray(schema.pipelineJobs.status, ['queued', 'running']),
    ))
    .all()
  if (queued.length) reasons.push('queue_running')
  if (reasons.length) {
    throw new ReworkError('自动化/配音/队列运行中，暂不能重做', 409, { reasons })
  }

  const ts = now()
  return db.transaction((tx) => {
    const active = tx.select({ id: schema.storyboards.id }).from(schema.storyboards)
      .where(and(
        eq(schema.storyboards.episodeId, episodeId),
        isNull(schema.storyboards.deletedAt),
      ))
      .all()
    if (active.length) {
      tx.update(schema.storyboards)
        .set({ deletedAt: ts, updatedAt: ts })
        .where(and(
          eq(schema.storyboards.episodeId, episodeId),
          isNull(schema.storyboards.deletedAt),
        ))
        .run()
    }
    tx.update(schema.episodes)
      .set({
        scriptContent: null,
        automationStatus: 'idle',
        automationStage: null,
        automationProgress: 0,
        automationNote: null,
        automationError: null,
        automationStartedAt: null,
        automationFinishedAt: null,
        updatedAt: ts,
      })
      .where(eq(schema.episodes.id, episodeId))
      .run()
    return { episodeId, deletedStoryboards: active.length }
  })
}
