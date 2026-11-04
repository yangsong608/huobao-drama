/**
 * 台词抽取落库（A-4 / M2-2 的先行版本）
 *
 * 用法：
 *   npx tsx scripts/dialogue-apply.ts <episodeId> [--dry]
 *
 * 规则（设计 6.1.4）：
 * - 每镜 source_hash = sha256(video_prompt)，未变则跳过；
 * - 同事务内删除 source IN ('auto','llm') 且 locked=0 的行，再插入新行；
 * - locked=1 的行保留，只标记 stale=1。
 */
import crypto from 'crypto'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseVideoPrompt, summarizeLines, type CastMember } from '../src/services/dialogue-lines.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const episodeId = Number(args.find((a) => !a.startsWith('--')) || 5)
const dry = args.includes('--dry')
const dbPath = path.resolve(here, '../../data/huobao.sqlite3')

const db = new Database(dbPath)
db.pragma('busy_timeout = 5000')

const episode = db.prepare('SELECT id, drama_id, title FROM episodes WHERE id = ?').get(episodeId) as
  | { id: number; drama_id: number; title: string }
  | undefined
if (!episode) {
  console.error(`episode ${episodeId} 不存在`)
  process.exit(1)
}

const cast = db.prepare('SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(episode.drama_id) as CastMember[]
const boards = db.prepare(
  `SELECT id, storyboard_number, duration, video_prompt, source_hash
   FROM storyboards
   WHERE episode_id = ? AND deleted_at IS NULL AND video_prompt IS NOT NULL AND video_prompt != ''
   ORDER BY storyboard_number`,
).all(episodeId) as { id: number; storyboard_number: number; duration: number; video_prompt: string; source_hash: string | null }[]

const deleteAuto = db.prepare("DELETE FROM storyboard_lines WHERE storyboard_id = ? AND source IN ('auto','llm') AND locked = 0")
const markStale = db.prepare('UPDATE storyboard_lines SET stale = 1, updated_at = ? WHERE storyboard_id = ? AND locked = 1')
const setHash = db.prepare('UPDATE storyboards SET source_hash = ? WHERE id = ?')
const insert = db.prepare(
  `INSERT INTO storyboard_lines
   (storyboard_id, episode_id, drama_id, line_no, speaker_type, character_id, speaker_name,
    text, speak_text, subtitle_text, planned_start_ms, planned_end_ms, status, source, needs_review, stale, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'auto', ?, 0, ?, ?)`,
)

let inserted = 0
let skipped = 0
let dropped = 0
const all = []
const ts = new Date().toISOString()

const apply = db.transaction(() => {
  for (const board of boards) {
    const hash = crypto.createHash('sha256').update(board.video_prompt).digest('hex')
    if (board.source_hash === hash) {
      skipped += 1
      continue
    }
    const lines = parseVideoPrompt(board.video_prompt, { cast, durationMs: (board.duration || 0) * 1000 })
    all.push(...lines)
    if (dry) continue

    dropped += deleteAuto.run(board.id).changes
    markStale.run(ts, board.id)
    for (const line of lines) {
      insert.run(
        board.id, episodeId, episode.drama_id, line.lineNo, line.speakerType, line.characterId, line.speakerName,
        line.text, line.speakText, line.subtitleText, line.plannedStartMs, line.plannedEndMs,
        line.needsReview ? 1 : 0, ts, ts,
      )
      inserted += 1
    }
    setHash.run(hash, board.id)
  }
})
apply()

const summary = summarizeLines(all)
console.log(`\n剧集 ${episodeId}（${episode.title}）${dry ? '【dry-run】' : ''}`)
console.log(`分镜 ${boards.length}｜跳过（hash 未变）${skipped}｜删除旧行 ${dropped}｜写入 ${inserted}`)
console.log(
  `抽取 ${summary.total} 句｜旁白/心声 ${summary.narration + summary.inner}｜对白 ${summary.dialogue}｜` +
  `未知 ${summary.unknown}（${(summary.unknownRatio * 100).toFixed(1)}%）｜待复核 ${summary.needsReview}`,
)
db.close()
