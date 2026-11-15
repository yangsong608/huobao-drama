import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const { initSqliteSchema } = await import('../src/db/sqlite-schema.ts')
const schema = await import('../src/db/schema.ts')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-swap-schema-'))
after(async () => { await fs.rm(root, { recursive: true, force: true }) })

function openDb(name: string) {
  return new Database(path.join(root, `${name}.sqlite3`))
}

function columnsOf(db: Database.Database, table: string) {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name))
}

test('creates the five video swap tables with columns, indexes and defaults', () => {
  const db = openDb('fresh')
  initSqliteSchema(db)

  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name),
  )
  for (const table of [
    'video_projects', 'video_swap_runs', 'video_swap_shots', 'video_swap_chunks', 'video_swap_run_logs',
  ]) {
    assert.ok(tables.has(table), `missing ${table}`)
  }

  const projectColumns = columnsOf(db, 'video_projects')
  for (const column of [
    'title', 'mode', 'status', 'source_video_path', 'source_video_meta', 'reference_face_paths',
    'prompt', 'config_id', 'latest_run_id', 'created_at', 'updated_at', 'deleted_at',
  ]) assert.ok(projectColumns.has(column), `video_projects missing ${column}`)

  const runColumns = columnsOf(db, 'video_swap_runs')
  for (const column of [
    'project_id', 'mode', 'config_id', 'status', 'stage', 'progress', 'analysis_json',
    'final_prompt_json', 'scene_reference_path', 'max_generation_seconds', 'chunk_overlap_ms',
    'min_chunk_seconds', 'max_chunks', 'audio_master_path', 'proxy_path', 'total_chunks', 'completed_chunks',
    'merge_path', 'output_meta', 'params_json', 'edl_json', 'gateway_job_id', 'error_code', 'error_message',
    'started_at', 'finished_at', 'created_at', 'updated_at',
  ]) assert.ok(runColumns.has(column), `video_swap_runs missing ${column}`)

  assert.ok(columnsOf(db, 'video_swap_shots').has('scene_reference_candidates'))
  const chunkColumns = columnsOf(db, 'video_swap_chunks')
  for (const column of [
    'run_id', 'shot_id', 'chunk_index', 'source_start_ms', 'source_end_ms', 'overlap_before_ms',
    'overlap_after_ms', 'warmup_frames', 'target_frames', 'trim_start_ms', 'trim_end_ms', 'status', 'gateway_job_id',
    'seam_ssim', 'seam_color_delta', 'seam_face_similarity', 'seam_verdict', 'seam_json', 'retry_count',
  ]) assert.ok(chunkColumns.has(column), `video_swap_chunks missing ${column}`)

  const indexes = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(r => r.name),
  )
  for (const index of [
    'idx_video_projects_updated', 'idx_video_projects_status', 'idx_video_swap_runs_project',
    'idx_video_swap_runs_status', 'idx_video_swap_shots_status', 'idx_video_swap_chunks_shot',
    'idx_video_swap_chunks_status', 'idx_video_swap_logs_run', 'idx_video_swap_logs_stage',
  ]) assert.ok(indexes.has(index), `missing index ${index}`)

  const now = '2026-11-14T00:00:00.000Z'
  db.prepare('INSERT INTO video_projects (title, created_at, updated_at) VALUES (?, ?, ?)').run('测试项目', now, now)
  const project = db.prepare('SELECT * FROM video_projects WHERE id = 1').get() as any
  assert.equal(project.mode, 'face')
  assert.equal(project.status, 'draft')
  assert.equal(project.reference_face_paths, '[]')
  assert.equal(project.prompt, '')

  const run = db.prepare(
    'INSERT INTO video_swap_runs (project_id, mode, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(1, 'face', now, now)
  const runId = Number(run.lastInsertRowid)
  assert.equal((db.prepare('SELECT status FROM video_swap_runs WHERE id = ?').get(runId) as any).status, 'uploaded')

  db.prepare(
    `INSERT INTO video_swap_shots
      (run_id, shot_index, start_ms, end_ms, duration_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, 0, 0, 6000, 6000, now, now)
  const shot = db.prepare('SELECT id FROM video_swap_shots WHERE run_id = ? AND shot_index = 0').get(runId) as any
  assert.throws(() => db.prepare(
    `INSERT INTO video_swap_shots
      (run_id, shot_index, start_ms, end_ms, duration_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, 0, 0, 6000, 6000, now, now))

  db.prepare(
    `INSERT INTO video_swap_chunks
      (run_id, shot_id, chunk_index, source_start_ms, source_end_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, shot.id, 0, 0, 6000, now, now)
  assert.throws(() => db.prepare(
    `INSERT INTO video_swap_chunks
      (run_id, shot_id, chunk_index, source_start_ms, source_end_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(runId, shot.id, 0, 0, 6000, now, now))

  const runFks = db.prepare('PRAGMA foreign_key_list(video_swap_runs)').all() as any[]
  assert.ok(runFks.some(fk => fk.table === 'video_projects' && fk.on_delete === 'CASCADE'))
  const chunkFks = db.prepare('PRAGMA foreign_key_list(video_swap_chunks)').all() as any[]
  assert.ok(chunkFks.some(fk => fk.table === 'video_swap_shots' && fk.on_delete === 'CASCADE'))

  for (const name of [
    'videoProjects', 'videoSwapRuns', 'videoSwapShots', 'videoSwapChunks', 'videoSwapRunLogs',
  ]) assert.ok(schema[name], `drizzle export missing ${name}`)

  db.close()
})

test('initializes an existing legacy database without losing rows', () => {
  const db = openDb('legacy')
  db.exec(`CREATE TABLE dramas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`)
  db.prepare('INSERT INTO dramas (title, created_at, updated_at) VALUES (?, ?, ?)')
    .run('旧项目', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

  initSqliteSchema(db)

  const row = db.prepare('SELECT title FROM dramas WHERE id = 1').get() as any
  assert.equal(row.title, '旧项目')
  assert.ok(columnsOf(db, 'video_projects').has('mode'))
  assert.ok(columnsOf(db, 'video_swap_chunks').has('seam_ssim'))
  db.close()
})
