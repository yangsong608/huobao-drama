import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.ts'

function tempDatabase(): { sqlite: Database.Database; close: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-audit-schema-'))
  const sqlite = new Database(path.join(root, 'test.sqlite3'))
  return {
    sqlite,
    close: () => {
      sqlite.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function columns(sqlite: Database.Database, table: string) {
  return new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  )
}

function indexes(sqlite: Database.Database) {
  return new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[])
      .map((row) => row.name),
  )
}

test('新建库包含动作检验任务表与索引', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    for (const name of [
      'episode_id',
      'drama_id',
      'trigger',
      'status',
      'phase',
      'total_shots',
      'total_windows',
      'completed_windows',
      'issue_count',
      'error_count',
      'warning_count',
      'info_count',
      'repairable_count',
      'fixed_count',
      'manual_count',
      'semantic_status',
      'repair_status',
      'rollback',
      'model',
      'config_id',
      'issues_json',
      'windows_json',
      'shot_status_json',
      'summary_json',
      'snapshot_json',
      'repair_log_json',
      'fingerprints_json',
      'error_msg',
      'started_at',
      'finished_at',
      'created_at',
      'updated_at',
    ]) {
      assert.ok(columns(sqlite, 'storyboard_audit_jobs').has(name), `storyboard_audit_jobs 缺少 ${name}`)
    }
    const names = indexes(sqlite)
    assert.ok(names.has('idx_storyboard_audit_jobs_episode'))
    assert.ok(names.has('idx_storyboard_audit_jobs_status'))
  } finally {
    close()
  }
})

test('新建库的 video_transitions 含类型扩展列', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    const names = columns(sqlite, 'video_transitions')
    for (const name of ['kind', 'scene_id', 'text_content', 'text_subtitle', 'edge_mode']) {
      assert.ok(names.has(name), `video_transitions 缺少 ${name}`)
    }
    const row = sqlite.prepare(`INSERT INTO video_transitions
      (episode_id, from_storyboard_id, to_storyboard_id, created_at, updated_at)
      VALUES (1, 1, 2, '2026-01-01', '2026-01-01')`).run()
    assert.ok(row.lastInsertRowid)
    const inserted = sqlite.prepare('SELECT kind, edge_mode FROM video_transitions WHERE id = ?')
      .get(row.lastInsertRowid) as { kind: string; edge_mode: string }
    assert.equal(inserted.kind, 'ai')
    assert.equal(inserted.edge_mode, 'fade')
  } finally {
    close()
  }
})

test('旧库启动迁移补列且历史过渡按 ai 处理，可重复执行', () => {
  const { sqlite, close } = tempDatabase()
  try {
    sqlite.exec(`CREATE TABLE video_transitions (
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
      prompt_source TEXT,
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
    )`)
    sqlite.prepare(`INSERT INTO video_transitions
      (episode_id, from_storyboard_id, to_storyboard_id, source_hash, created_at, updated_at, video_url)
      VALUES (9, 90, 91, 'legacy-hash', '2026-01-01', '2026-01-01', 'static/transition.mp4')`).run()

    initSqliteSchema(sqlite)
    initSqliteSchema(sqlite)

    const names = columns(sqlite, 'video_transitions')
    for (const name of ['kind', 'scene_id', 'text_content', 'text_subtitle', 'edge_mode']) {
      assert.ok(names.has(name), `迁移后缺少 ${name}`)
    }
    const row = sqlite.prepare('SELECT kind, source_hash, video_url FROM video_transitions WHERE episode_id = 9')
      .get() as { kind: string; source_hash: string; video_url: string }
    assert.equal(row.kind, 'ai')
    assert.equal(row.source_hash, 'legacy-hash')
    assert.equal(row.video_url, 'static/transition.mp4')
  } finally {
    close()
  }
})

test('新建库含检验策略快照与过渡分镜列', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    assert.ok(columns(sqlite, 'storyboard_audit_jobs').has('policy_json'))
    for (const name of ['transition_kind', 'transition_text', 'transition_subtitle']) {
      assert.ok(columns(sqlite, 'storyboards').has(name), `storyboards 缺少 ${name}`)
    }
  } finally {
    close()
  }
})

test('旧库迁移补检验策略与过渡分镜列，可重复执行', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.exec('ALTER TABLE storyboard_audit_jobs DROP COLUMN policy_json')
    sqlite.exec('ALTER TABLE storyboards DROP COLUMN transition_kind')
    sqlite.exec('ALTER TABLE storyboards DROP COLUMN transition_text')
    sqlite.exec('ALTER TABLE storyboards DROP COLUMN transition_subtitle')
    initSqliteSchema(sqlite)
    initSqliteSchema(sqlite)
    assert.ok(columns(sqlite, 'storyboard_audit_jobs').has('policy_json'))
    for (const name of ['transition_kind', 'transition_text', 'transition_subtitle']) {
      assert.ok(columns(sqlite, 'storyboards').has(name), `迁移后缺少 ${name}`)
    }
  } finally {
    close()
  }
})
