/**
 * 台词抽取（落库）——路由与自动化共用
 *
 * 规则：
 * - `storyboards.source_hash` 未变且已有台词的行跳过（force 才重抽）；
 * - 人工锁定的行保留并标 stale，其余自动行先删后插，避免唯一键冲突；
 * - 说话人未知的行保留 needs_review，不猜。
 */
import crypto from 'crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { parseVideoPrompt, type CastMember } from './dialogue-lines.js'

export interface ExtractLinesResult {
  total: number
  inserted: number
  skipped: number
  kept: number
  needsReview: number
  unknown: number
}

export function extractEpisodeLines(episodeId: number, options: { force?: boolean } = {}): ExtractLinesResult {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new Error('剧集不存在')

  const storyboards = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()

  let inserted = 0
  let skipped = 0
  let kept = 0
  const ts = now()

  for (const sb of storyboards) {
    const prompt = sb.videoPrompt || sb.description || ''
    if (!prompt) { skipped += 1; continue }
    const hash = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 32)
    const existing = db.select().from(schema.storyboardLines)
      .where(eq(schema.storyboardLines.storyboardId, sb.id))
      .all()
    if (!options.force && sb.sourceHash === hash && existing.length) { skipped += 1; continue }

    const castRows = db.select().from(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
      .all()
    const cast: CastMember[] = castRows.map((row) => {
      const character = db.select().from(schema.characters).where(eq(schema.characters.id, row.characterId)).get()
      return { id: row.characterId, name: character?.name || '' }
    }).filter((c) => c.name)

    const parsed = parseVideoPrompt(prompt, { cast, durationMs: (sb.duration || 3) * 1000 })
    if (!parsed.length) { skipped += 1; continue }

    db.transaction((tx) => {
      for (const row of existing) {
        if (row.locked) {
          tx.update(schema.storyboardLines).set({ stale: true, updatedAt: ts }).where(eq(schema.storyboardLines.id, row.id)).run()
          kept += 1
        } else {
          tx.delete(schema.storyboardLines).where(eq(schema.storyboardLines.id, row.id)).run()
        }
      }
      for (const line of parsed) {
        tx.insert(schema.storyboardLines).values({
          storyboardId: sb.id,
          episodeId,
          dramaId: episode.dramaId,
          lineNo: line.lineNo,
          speakerType: line.speakerType,
          characterId: line.characterId,
          speakerName: line.speakerName,
          text: line.text,
          speakText: line.speakText,
          subtitleText: line.subtitleText,
          plannedStartMs: line.plannedStartMs,
          plannedEndMs: line.plannedEndMs,
          status: 'pending',
          source: 'auto',
          needsReview: line.needsReview,
          stale: false,
          locked: false,
          voiceLocked: false,
          createdAt: ts,
          updatedAt: ts,
        }).run()
        inserted += 1
      }
      tx.update(schema.storyboards).set({ sourceHash: hash, updatedAt: ts }).where(eq(schema.storyboards.id, sb.id)).run()
    })
  }

  const rows = db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.episodeId, episodeId)).all()
  return {
    total: rows.length,
    inserted,
    skipped,
    kept,
    needsReview: rows.filter((r) => r.needsReview).length,
    unknown: rows.filter((r) => r.speakerName === '未知').length,
  }
}
