/**
 * 过渡表结构：新库建表/索引，旧库启动时自动补列，不改历史数据。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const { initSqliteSchema } = await import('../src/db/sqlite-schema.ts')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-transition-schema-'))
after(async () => { await fs.rm(root, { recursive: true, force: true }) })

const TRANSITION_COLUMNS = [
  'id', 'episode_id', 'drama_id', 'from_storyboard_id', 'to_storyboard_id',
  'from_video_url', 'to_video_url', 'first_frame_url', 'last_frame_url', 'source_hash',
  'prompt', 'prompt_source', 'provider', 'model', 'config_id', 'config_base_url',
  'duration_requested', 'duration_effective', 'duration_actual', 'audio_mode',
  'status', 'video_url', 'sys_task_id', 'error_msg', 'enabled',
  'created_at', 'updated_at', 'completed_at',
]

test('新库创建 video_transitions、任务外键列与合片快照列', () => {
  const db = new Database(path.join(root, 'fresh.sqlite3'))
  initSqliteSchema(db)

  const columns = (db.prepare('PRAGMA table_info(video_transitions)').all() as { name: string }[]).map(c => c.name)
  assert.deepEqual(columns, TRANSITION_COLUMNS)

  const indexes = db.prepare('PRAGMA index_list(video_transitions)').all() as { name: string; unique: number }[]
  const boundary = indexes.find(index => index.name === 'idx_video_transitions_boundary')
  assert.equal(boundary?.unique, 1)
  assert.ok(indexes.some(index => index.name === 'idx_video_transitions_episode'))
  assert.ok(indexes.some(index => index.name === 'idx_video_transitions_status'))

  const taskColumns = (db.prepare('PRAGMA table_info(sys_task)').all() as { name: string }[]).map(c => c.name)
  assert.ok(taskColumns.includes('transition_id'))
  const taskIndexes = (db.prepare('PRAGMA index_list(sys_task)').all() as { name: string }[]).map(index => index.name)
  assert.ok(taskIndexes.includes('idx_sys_task_transition_id'))

  const mergeColumns = (db.prepare('PRAGMA table_info(video_merges)').all() as { name: string }[]).map(c => c.name)
  assert.ok(mergeColumns.includes('transitions'))
  db.close()
})

test('旧库启动时补齐过渡列，历史任务与合片记录不变', () => {
  const db = new Database(path.join(root, 'legacy.sqlite3'))
  db.exec(`
    CREATE TABLE sys_task (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      storyboard_id INTEGER,
      drama_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE video_merges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO sys_task (type, storyboard_id, drama_id, created_at, updated_at)
      VALUES ('video', 7, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO video_merges (provider, model, status, created_at)
      VALUES ('minimax', 'MiniMax-H3', 'completed', '2026-01-01T00:00:00.000Z');
  `)

  initSqliteSchema(db)

  const taskColumns = (db.prepare('PRAGMA table_info(sys_task)').all() as { name: string }[]).map(c => c.name)
  assert.ok(taskColumns.includes('transition_id'))
  const row = db.prepare('SELECT storyboard_id, transition_id FROM sys_task WHERE id = 1').get() as any
  assert.equal(row.storyboard_id, 7)
  assert.equal(row.transition_id, null)

  const mergeColumns = (db.prepare('PRAGMA table_info(video_merges)').all() as { name: string }[]).map(c => c.name)
  assert.ok(mergeColumns.includes('transitions'))
  const merge = db.prepare('SELECT status, transitions FROM video_merges WHERE id = 1').get() as any
  assert.equal(merge.status, 'completed')
  assert.equal(merge.transitions, null)
  db.close()
})

test('旧库的过渡表补齐 prompt_source，历史提示词保持原样', () => {
  const db = new Database(path.join(root, 'legacy-transitions.sqlite3'))
  db.exec(`
    CREATE TABLE video_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      drama_id INTEGER,
      from_storyboard_id INTEGER NOT NULL,
      to_storyboard_id INTEGER NOT NULL,
      from_video_url TEXT,
      to_video_url TEXT,
      first_frame_url TEXT,
      last_frame_url TEXT,
      source_hash TEXT,
      prompt TEXT,
      provider TEXT,
      model TEXT,
      config_id INTEGER,
      config_base_url TEXT,
      duration_requested REAL,
      duration_effective REAL,
      duration_actual REAL,
      audio_mode TEXT DEFAULT 'ambient',
      status TEXT DEFAULT 'pending',
      video_url TEXT,
      sys_task_id INTEGER,
      error_msg TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    INSERT INTO video_transitions
      (episode_id, from_storyboard_id, to_storyboard_id, prompt, status, created_at, updated_at)
      VALUES (1, 2, 3, '旧版文字提示词', 'completed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `)

  initSqliteSchema(db)

  const columns = (db.prepare('PRAGMA table_info(video_transitions)').all() as { name: string }[]).map(c => c.name)
  assert.ok(columns.includes('prompt_source'))
  const row = db.prepare('SELECT prompt, prompt_source, status FROM video_transitions WHERE id = 1').get() as any
  assert.equal(row.prompt, '旧版文字提示词')
  assert.equal(row.prompt_source, null)
  assert.equal(row.status, 'completed')
  db.close()
})
