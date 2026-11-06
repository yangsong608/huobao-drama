import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.ts'

function tempDatabase(): { sqlite: Database.Database; close: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-schema-'))
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

function objects(sqlite: Database.Database, type: 'table' | 'index') {
  return new Set(
    (sqlite.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as { name: string }[])
      .map((row) => row.name),
  )
}

test('新建库包含剪辑工作台表、列与索引', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)

    const tables = objects(sqlite, 'table')
    for (const name of [
      'episode_edit_drafts',
      'edit_revisions',
      'edit_renders',
      'episode_media_proxies',
      'episode_locks',
    ]) {
      assert.ok(tables.has(name), `缺少表 ${name}`)
    }

    const indexes = objects(sqlite, 'index')
    for (const name of [
      'idx_edit_drafts_project',
      'idx_edit_revisions_project_no',
      'idx_edit_revisions_project_current',
      'idx_edit_renders_project_cache',
      'idx_edit_renders_sync',
      'idx_edit_renders_revision',
      'idx_media_proxies_source',
    ]) {
      assert.ok(indexes.has(name), `缺少索引 ${name}`)
    }

    for (const name of ['edit_revision_id', 'edit_plan_hash', 'edit_sync_hash', 'edit_enabled']) {
      assert.ok(columns(sqlite, 'episodes').has(name), `episodes 缺少 ${name}`)
    }
    for (const name of ['edit_revision_id', 'edit_sync_hash', 'dialogue_sync_hash', 'source_kind']) {
      assert.ok(columns(sqlite, 'mix_revisions').has(name), `mix_revisions 缺少 ${name}`)
    }
    for (const name of [
      'edit_revision_id', 'mix_revision_id', 'edit_plan_hash', 'edit_sync_hash',
      'dialogue_sync_hash', 'render_mode', 'subtitle_mode', 'file_name',
    ]) {
      assert.ok(columns(sqlite, 'episode_exports').has(name), `episode_exports 缺少 ${name}`)
    }
  } finally {
    close()
  }
})

test('旧数据默认值与重复初始化保持幂等', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    initSqliteSchema(sqlite)

    sqlite.prepare(
      "INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, '测试集', 'x', 'x')",
    ).run()
    const episode = sqlite.prepare('SELECT edit_enabled, edit_revision_id FROM episodes WHERE id = 1').get() as {
      edit_enabled: number
      edit_revision_id: number | null
    }
    assert.equal(episode.edit_enabled, 0)
    assert.equal(episode.edit_revision_id, null)

    sqlite.prepare(
      "INSERT INTO mix_revisions (episode_id, revision_no, plan_json, created_at) VALUES (1, 1, '{}', 'x')",
    ).run()
    const mix = sqlite.prepare('SELECT source_kind, edit_sync_hash FROM mix_revisions WHERE id = 1').get() as {
      source_kind: string
      edit_sync_hash: string | null
    }
    assert.equal(mix.source_kind, 'legacy')
    assert.equal(mix.edit_sync_hash, null)
  } finally {
    close()
  }
})

test('旧集已有剪辑版本时回填 edit_enabled 与当前版本指针', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.prepare(
      "INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, '旧集', 'x', 'x')",
    ).run()
    sqlite.prepare(
      `INSERT INTO edit_revisions
       (episode_id, revision_no, plan_json, plan_hash, edit_sync_hash, is_current, created_at)
       VALUES (1, 1, '{}', 'p', 's', 1, 'x')`,
    ).run()

    initSqliteSchema(sqlite)

    const episode = sqlite.prepare('SELECT edit_enabled, edit_revision_id FROM episodes WHERE id = 1').get() as {
      edit_enabled: number
      edit_revision_id: number | null
    }
    assert.equal(episode.edit_enabled, 1)
    assert.equal(episode.edit_revision_id, 1)
  } finally {
    close()
  }
})
