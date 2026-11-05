/**
 * 台词抽取（落库）——路由与自动化共用
 *
 * 兼容旧入口：内部走「预览计划 + 应用合并」，不再先删后插。
 * - 未变化的镜头按 source_hash 跳过（force 才重抽）；
 * - 人工/锁定行保留；命中墓碑的自动行不重建；未匹配旧自动行标 stale。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { applyEpisodeMerge, planEpisodeMerge } from './dialogue-merge.js'

export interface ExtractLinesResult {
  total: number
  inserted: number
  skipped: number
  kept: number
  needsReview: number
  unknown: number
}

export function extractEpisodeLines(
  episodeId: number,
  options: { force?: boolean; storyboardIds?: number[] } = {},
): ExtractLinesResult {
  const plan = planEpisodeMerge(episodeId, options)
  const applied = applyEpisodeMerge(episodeId, plan)
  const rows = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .all()
  return {
    total: rows.length,
    inserted: applied.inserted,
    skipped: applied.skipped,
    kept: applied.kept,
    needsReview: rows.filter((row) => row.needsReview).length,
    unknown: rows.filter((row) => row.speakerName === '未知').length,
  }
}
