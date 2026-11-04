import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const sqliteSchema = read('src/db/sqlite-schema.ts')
const drizzleSchema = read('src/db/schema.ts')
const verifySchema = read('scripts/verify-schema.ts')

const NOVEL_TABLES = [
  'novels',
  'novel_chapters',
  'novel_graph_snapshots',
  'novel_chapter_graphs',
  'novel_jobs',
  'novel_imports',
  'novel_import_episodes',
]

test('sqlite schema creates the seven V3 novel tables', () => {
  for (const table of NOVEL_TABLES) {
    assert.match(
      sqliteSchema,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`),
      `missing table ${table}`,
    )
  }
  assert.doesNotMatch(sqliteSchema, /legacy_id/)
})

test('novels keeps architecture, blueprint, graph and lifecycle columns', () => {
  const novels = sqliteSchema.slice(sqliteSchema.indexOf('CREATE TABLE IF NOT EXISTS novels'))
  for (const column of [
    'title', 'topic', 'genre', 'number_of_chapters', 'word_number', 'user_guidance',
    'core_seed', 'character_dynamics', 'world_building', 'plot_architecture', 'character_state',
    'chapter_blueprint', 'global_summary', 'graph_meta', 'architecture_generated',
    'blueprint_generated', 'status', 'content_updated_at',
    'narrative_person', 'timeline_events', 'world_map', 'background', 'writing_style',
    'created_at', 'updated_at', 'deleted_at',
  ]) {
    assert.match(novels, new RegExp(`\\b${column}\\b`), `novels missing ${column}`)
  }
})

test('novel tables carry the designed uniqueness and indexes', () => {
  assert.match(sqliteSchema, /UNIQUE \(novel_id, chapter_no\)/)
  assert.match(sqliteSchema, /UNIQUE \(import_id, chapter_no, part_no\)/)
  assert.match(sqliteSchema, /UNIQUE \(novel_id, drama_id\)/)
  assert.match(sqliteSchema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_novel_jobs_running ON novel_jobs \(novel_id\) WHERE status = 'running'/)
  for (const index of [
    'idx_novels_updated',
    'idx_novel_chapters_novel',
    'idx_novel_jobs_novel',
    'idx_novel_imports_request',
    'idx_novel_imports_drama',
    'idx_novel_import_eps_import',
  ]) {
    assert.match(sqliteSchema, new RegExp(`CREATE (UNIQUE )?INDEX IF NOT EXISTS ${index}\\b`), `missing ${index}`)
  }
})

test('existing drama and episode tables gain V3 source columns via alter table', () => {
  for (const column of ['source_novel_id', 'story_bible']) {
    assert.match(sqliteSchema, new RegExp(`ALTER TABLE dramas ADD COLUMN ${column}\\b`), `missing dramas.${column}`)
  }
  for (const column of ['source_chapter_no', 'source_part_no', 'source_stale']) {
    assert.match(sqliteSchema, new RegExp(`\\b${column}: '(INTEGER|INTEGER DEFAULT 0)'`), `missing episodes.${column}`)
  }
  assert.match(sqliteSchema, /ALTER TABLE episodes ADD COLUMN \$\{name\} \$\{type\}/)
})

test('drizzle mirrors the seven tables and five columns', () => {
  for (const table of NOVEL_TABLES) {
    assert.match(drizzleSchema, new RegExp(`sqliteTable\\('${table}'`), `drizzle missing ${table}`)
  }
  for (const column of ['source_novel_id', 'story_bible']) {
    assert.match(drizzleSchema, new RegExp(`integer\\('${column}'|text\\('${column}'`), `drizzle missing ${column}`)
  }
  for (const column of ['source_chapter_no', 'source_part_no', 'source_stale']) {
    assert.match(drizzleSchema, new RegExp(`integer\\('${column}'`), `drizzle missing ${column}`)
  }
})

test('drizzle and verify-schema know the story atlas columns', () => {
  for (const column of ['narrative_person', 'timeline_events', 'world_map']) {
    assert.match(drizzleSchema, new RegExp(`text\\('${column}'\\)`), `drizzle missing ${column}`)
  }
  for (const column of ['narrative_person', 'timeline_events', 'world_map', 'background', 'writing_style']) {
    assert.match(verifySchema, new RegExp(`'${column}'`), `verify-schema missing ${column}`)
  }
})

test('verify-schema knows the V3 tables and columns', () => {
  for (const table of NOVEL_TABLES) {
    assert.match(verifySchema, new RegExp(`\\b${table}: \\[`), `verify-schema missing ${table}`)
  }
  assert.match(verifySchema, /source_novel_id/)
  assert.match(verifySchema, /story_bible/)
  assert.match(verifySchema, /source_stale/)
})
