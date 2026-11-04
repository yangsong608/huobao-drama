/**
 * V2/V3 数据库契约校验（可反复执行，用于偏离检查）
 *
 * 用法：
 *   npx tsx scripts/verify-schema.ts <dbPath>            # 只校验
 *   npx tsx scripts/verify-schema.ts <dbPath> --init      # 先跑幂等建表再加列，再校验
 *
 * 校验对象与 docs/V2-产品功能详细设计.md 12.1 / 12.3 一致。
 */
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { initSqliteSchema } from '../src/db/sqlite-schema.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const dbPath = args.find((a) => !a.startsWith('--')) || path.resolve(here, '../../data/huobao.sqlite3')
const shouldInit = args.includes('--init')

const REQUIRED_TABLES: Record<string, string[]> = {
  character_voices: [
    'drama_id', 'character_id', 'scope', 'name', 'source', 'provider', 'model', 'external_voice_id',
    'voice_prompt', 'voice_prompt_source', 'design_instruct', 'ref_audio_url', 'ref_text', 'x_vector_only',
    'sample_url', 'sample_text', 'speed', 'emotion', 'language', 'seed', 'consent_confirmed_at',
    'status', 'is_active', 'created_at', 'updated_at', 'deleted_at',
  ],
  storyboard_lines: [
    'storyboard_id', 'episode_id', 'drama_id', 'line_no', 'speaker_type', 'character_id', 'voice_id',
    'voice_locked', 'speaker_name', 'text', 'speak_text', 'subtitle_text', 'emotion', 'speed',
    'planned_start_ms', 'planned_end_ms', 'start_ms', 'end_ms', 'audio_url', 'audio_duration_ms',
    'audio_hash', 'status', 'overflow_ms', 'stale', 'source', 'locked', 'needs_review', 'error',
  ],
  grid_sheets: ['drama_id', 'episode_id', 'kind', 'rows', 'cols', 'prompt', 'image_url', 'cells', 'inset', 'status', 'error'],
  script_imports: ['drama_id', 'filename', 'source_hash', 'raw_text', 'chapter_count', 'status'],
  script_chapters: ['import_id', 'drama_id', 'chapter_index', 'part_no', 'title', 'content', 'char_count', 'episode_id'],
  pipeline_jobs: [
    'kind', 'drama_id', 'episode_id', 'resource', 'status', 'priority', 'payload', 'progress', 'note',
    'error', 'attempts', 'max_attempts', 'locked_by', 'heartbeat_at', 'created_at', 'started_at', 'finished_at',
  ],
  novels: [
    'title', 'topic', 'genre', 'number_of_chapters', 'word_number', 'user_guidance',
    'core_seed', 'character_dynamics', 'world_building', 'plot_architecture', 'character_state',
    'chapter_blueprint', 'global_summary', 'graph_meta', 'architecture_generated', 'blueprint_generated',
    'status', 'content_updated_at', 'narrative_person', 'timeline_events', 'world_map',
    'background', 'writing_style', 'created_at', 'updated_at', 'deleted_at',
  ],
  novel_chapters: ['novel_id', 'chapter_no', 'title', 'content', 'word_count', 'content_hash', 'status', 'created_at', 'updated_at'],
  novel_graph_snapshots: ['novel_id', 'chapter_no', 'nodes', 'edges', 'created_at', 'updated_at'],
  novel_chapter_graphs: ['novel_id', 'chapter_no', 'nodes', 'edges', 'created_at', 'updated_at'],
  novel_jobs: [
    'novel_id', 'type', 'chapter_no', 'status', 'stage', 'progress', 'total', 'message', 'partial',
    'result', 'error', 'error_code', 'cancel_requested', 'created_at', 'started_at', 'finished_at',
  ],
  novel_imports: [
    'novel_id', 'drama_id', 'request_id', 'mode', 'status', 'source_updated_at', 'last_synced_at',
    'last_sync_summary', 'created_at', 'updated_at',
  ],
  novel_import_episodes: [
    'import_id', 'chapter_no', 'part_no', 'episode_id', 'content_hash', 'chapter_hash',
    'synced_title', 'status', 'synced_at',
  ],
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  episodes: [
    'auto_dub', 'dub_status', 'dub_progress', 'dub_note', 'subtitle_url', 'video_audio_mode', 'bgm_url',
    'source_chapter_no', 'source_part_no', 'source_stale',
  ],
  characters: ['voice_prompt', 'voice_status'],
  video_merges: ['kind', 'source_hash', 'subtitle_url', 'dialogue_track_url', 'bgm_url', 'mix_options'],
  storyboards: ['source_hash', 'transition', 'continuity'],
  dramas: ['narrator_voice_id', 'bgm_url', 'source_novel_id', 'story_bible', 'visual_background'],
}

const db = new Database(dbPath)
if (shouldInit) initSqliteSchema(db)

const problems: string[] = []

const tableExists = (t: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)

const columnsOf = (t: string): Set<string> =>
  new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name))

for (const [table, cols] of Object.entries(REQUIRED_TABLES)) {
  if (!tableExists(table)) {
    problems.push(`缺表 ${table}`)
    continue
  }
  const actual = columnsOf(table)
  const missing = cols.filter((c) => !actual.has(c))
  if (missing.length) problems.push(`${table} 缺列：${missing.join(', ')}`)
}

for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
  if (!tableExists(table)) {
    problems.push(`缺表 ${table}`)
    continue
  }
  const actual = columnsOf(table)
  const missing = cols.filter((c) => !actual.has(c))
  if (missing.length) problems.push(`${table} 缺列：${missing.join(', ')}`)
}

// 索引只做提示，不影响退出码
const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all() as { name: string }[]).map((r) => r.name)
const expectedIndexes = [
  'idx_character_voices_char', 'idx_character_voices_drama', 'idx_lines_storyboard', 'idx_lines_episode',
  'idx_pipeline_jobs_status', 'idx_pipeline_jobs_episode',
  'idx_novels_updated', 'idx_novel_chapters_novel', 'idx_novel_jobs_novel', 'idx_novel_jobs_running',
  'idx_novel_imports_request', 'idx_novel_imports_drama', 'idx_novel_import_eps_import',
]
const missingIndexes = expectedIndexes.filter((i) => !indexes.includes(i))

db.close()

console.log(`\n数据库契约校验：${dbPath}${shouldInit ? '（已执行幂等初始化）' : ''}`)
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`)
  if (missingIndexes.length) console.error(`  · 缺失索引（不阻塞）：${missingIndexes.join(', ')}`)
  console.error(`\n结果：${problems.length} 项不符合 V2 设计`)
  process.exit(1)
}
console.log(`  ✓ ${Object.keys(REQUIRED_TABLES).length} 张新表、${Object.keys(REQUIRED_COLUMNS).length} 张扩展表全部就位`)
if (missingIndexes.length) console.log(`  · 缺失索引（不阻塞）：${missingIndexes.join(', ')}`)
console.log('结果：通过')
