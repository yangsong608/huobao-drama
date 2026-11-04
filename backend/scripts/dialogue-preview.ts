/**
 * 台词抽取预览（只读）
 *
 * 用法：npx tsx scripts/dialogue-preview.ts <episodeId> [dbPath]
 * 输出：每镜抽到的句数、未知说话人比例、前若干句样例，用于验收 A-4 / 第 5 集 e2e。
 */
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseVideoPrompt, summarizeLines, type CastMember } from '../src/services/dialogue-lines.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const episodeId = Number(args[0] || 5)
const dbPath = args[1] || path.resolve(here, '../../data/huobao.sqlite3')

const db = new Database(dbPath, { readonly: true })

const episode = db.prepare('SELECT id, drama_id, title FROM episodes WHERE id = ?').get(episodeId) as
  | { id: number; drama_id: number; title: string }
  | undefined
if (!episode) {
  console.error(`episode ${episodeId} 不存在`)
  process.exit(1)
}

const cast = db.prepare('SELECT id, name FROM characters WHERE drama_id = ? AND deleted_at IS NULL').all(episode.drama_id) as CastMember[]

const boards = db.prepare(
  `SELECT id, storyboard_number, duration, video_prompt
   FROM storyboards
   WHERE episode_id = ? AND deleted_at IS NULL AND video_prompt IS NOT NULL AND video_prompt != ''
   ORDER BY storyboard_number`,
).all(episodeId) as { id: number; storyboard_number: number; duration: number; video_prompt: string }[]

let total = 0
const all = []
const rows: string[] = []

for (const board of boards) {
  const lines = parseVideoPrompt(board.video_prompt, { cast, durationMs: (board.duration || 0) * 1000 })
  const s = summarizeLines(lines)
  total += lines.length
  all.push(...lines)
  rows.push(
    `#${String(board.storyboard_number).padStart(2, '0')} 镜 ${String(board.duration || 0).padStart(2)}s ` +
    `句数 ${String(s.total).padStart(2)}｜旁白 ${s.narration + s.inner}｜对白 ${s.dialogue}｜未知 ${s.unknown}｜待复核 ${s.needsReview}`,
  )
}

const summary = summarizeLines(all)
console.log(`\n剧集 ${episodeId}（${episode.title}）｜分镜 ${boards.length}｜角色 ${cast.length}`)
console.log('-'.repeat(78))
for (const row of rows) console.log(row)
console.log('-'.repeat(78))
console.log(
  `合计 ${summary.total} 句｜旁白/心声 ${summary.narration + summary.inner}｜对白 ${summary.dialogue}｜` +
  `未知说话人 ${summary.unknown}（${(summary.unknownRatio * 100).toFixed(1)}%）｜待复核 ${summary.needsReview}`,
)

console.log('\n样例（前 10 句）：')
for (const line of all.slice(0, 10)) {
  console.log(
    `${String(line.lineNo).padStart(3)}. [${line.speakerType}] ${line.speakerName || '-'} ` +
    `${line.plannedStartMs}-${line.plannedEndMs}ms ${line.text}${line.needsReview ? '  ⚠︎' : ''}`,
  )
}
