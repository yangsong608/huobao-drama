import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.ts'

function tempDatabase(): { sqlite: Database.Database; close: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-dubbing-schema-'))
  const sqlite = new Database(path.join(root, 'test.sqlite3'))
  return {
    sqlite,
    close: () => {
      sqlite.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function tableColumns(sqlite: Database.Database, table: string) {
  return new Map(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[])
      .map((row) => [row.name, row]),
  )
}

function tableExists(sqlite: Database.Database, table: string) {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
}

/** 旧版 storyboard_lines：storyboard_id NOT NULL，无锚点/排序/修订字段 */
const LEGACY_LINES_DDL = `CREATE TABLE storyboard_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storyboard_id INTEGER NOT NULL,
  episode_id INTEGER NOT NULL,
  drama_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  speaker_type TEXT NOT NULL DEFAULT 'dialogue',
  character_id INTEGER,
  voice_id INTEGER,
  voice_locked INTEGER DEFAULT 0,
  speaker_name TEXT,
  text TEXT NOT NULL,
  speak_text TEXT,
  subtitle_text TEXT,
  emotion TEXT,
  speed REAL DEFAULT 1.0,
  planned_start_ms INTEGER,
  planned_end_ms INTEGER,
  start_ms INTEGER,
  end_ms INTEGER,
  voice_start_ms INTEGER,
  voice_duration_ms INTEGER,
  audio_url TEXT,
  audio_duration_ms INTEGER,
  audio_hash TEXT,
  status TEXT DEFAULT 'pending',
  overflow_ms INTEGER DEFAULT 0,
  stale INTEGER DEFAULT 0,
  source TEXT DEFAULT 'auto',
  locked INTEGER DEFAULT 0,
  needs_review INTEGER DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (storyboard_id, line_no)
)`

test('新建库补齐台词锚点字段与配音工作台数据表', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)

    const columns = tableColumns(sqlite, 'storyboard_lines')
    assert.equal(columns.get('storyboard_id')?.notnull, 0, 'storyboard_id 必须可空以支持绝对锚点')
    for (const name of [
      'anchor_type',
      'sort_order',
      'origin_key',
      'text_revision',
      'audio_stale',
      'active_take_id',
      'deleted_at',
      'direction',
    ]) {
      assert.ok(columns.has(name), `storyboard_lines 缺少列 ${name}`)
    }

    for (const table of [
      'line_takes',
      'voice_samples',
      'line_tombstones',
      'episode_audio_assets',
      'audio_buses',
      'mix_revisions',
      'episode_exports',
      'dubbing_jobs',
    ]) {
      assert.ok(tableExists(sqlite, table), `缺少数据表 ${table}`)
    }

    const takeColumns = tableColumns(sqlite, 'line_takes')
    for (const name of ['line_id', 'take_no', 'text', 'voice_fingerprint', 'context_mode', 'context_hash', 'audio_url', 'is_active']) {
      assert.ok(takeColumns.has(name), `line_takes 缺少列 ${name}`)
    }
    assert.ok(tableColumns(sqlite, 'voice_samples').has('voice_id'))
    assert.ok(tableColumns(sqlite, 'episode_audio_assets').has('source_hash'))
    assert.ok(tableColumns(sqlite, 'mix_revisions').has('plan_json'))
    assert.ok(tableColumns(sqlite, 'episode_exports').has('is_current'))
    assert.ok(tableColumns(sqlite, 'dubbing_jobs').has('progress'))

    const activeTakeIndex = sqlite.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_line_takes_active'",
    ).get() as { sql?: string } | undefined
    assert.match(activeTakeIndex?.sql || '', /WHERE is_active = 1/i)
  } finally {
    close()
  }
})

test('旧库重建 storyboard_lines 时保留台词数据并补列', () => {
  const { sqlite, close } = tempDatabase()
  try {
    sqlite.exec(LEGACY_LINES_DDL)
    sqlite.exec('CREATE INDEX idx_lines_storyboard ON storyboard_lines (storyboard_id, line_no)')
    sqlite.exec('CREATE INDEX idx_lines_episode ON storyboard_lines (episode_id, start_ms)')
    const ts = new Date().toISOString()
    sqlite.prepare(
      `INSERT INTO storyboard_lines (storyboard_id, episode_id, drama_id, line_no, text, audio_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(7, 3, 1, 1, '别回头。', 'static/audio/old.wav', ts, ts)

    initSqliteSchema(sqlite)

    const columns = tableColumns(sqlite, 'storyboard_lines')
    assert.equal(columns.get('storyboard_id')?.notnull, 0)
    for (const name of ['anchor_type', 'sort_order', 'origin_key', 'text_revision', 'audio_stale', 'active_take_id', 'deleted_at', 'direction']) {
      assert.ok(columns.has(name), `迁移后缺少列 ${name}`)
    }
    const row = sqlite.prepare('SELECT storyboard_id, episode_id, text, audio_url FROM storyboard_lines LIMIT 1').get() as any
    assert.equal(row.storyboard_id, 7)
    assert.equal(row.episode_id, 3)
    assert.equal(row.text, '别回头。')
    assert.equal(row.audio_url, 'static/audio/old.wav')

    const indexes = new Set(
      (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'storyboard_lines'").all() as { name: string }[])
        .map((entry) => entry.name),
    )
    assert.ok(indexes.has('idx_lines_storyboard'))
    assert.ok(indexes.has('idx_lines_episode'))

    // 迁移后可以写入绝对锚点行（storyboard_id 为空）
    const insert = sqlite.prepare(
      `INSERT INTO storyboard_lines (storyboard_id, episode_id, drama_id, line_no, text, created_at, updated_at)
       VALUES (NULL, 3, 1, 2, '旁白开场。', ?, ?)`,
    )
    assert.doesNotThrow(() => insert.run(ts, ts))
  } finally {
    close()
  }
})
