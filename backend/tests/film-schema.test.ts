import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.ts'

function tempDatabase(): { sqlite: Database.Database; close: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-film-schema-'))
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

test('新建库包含成片中心表、列与索引', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)

    const tables = new Set(
      (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((row) => row.name),
    )
    assert.ok(tables.has('edit_projects'), '缺少 edit_projects')

    for (const name of ['origin', 'source_merge_id', 'export_id', 'edit_revision_id', 'mix_revision_id', 'plan_hash', 'subtitle_burned']) {
      assert.ok(columns(sqlite, 'video_merges').has(name), `video_merges 缺少 ${name}`)
    }
    for (const name of ['current_film_id', 'mix_source_merge_id', 'edit_project_id']) {
      assert.ok(columns(sqlite, 'episodes').has(name), `episodes 缺少 ${name}`)
    }
    for (const name of ['source_merge_id', 'film_id', 'project_id']) {
      assert.ok(columns(sqlite, 'episode_exports').has(name), `episode_exports 缺少 ${name}`)
    }
    assert.ok(columns(sqlite, 'mix_revisions').has('source_film_id'))
    for (const table of ['episode_edit_drafts', 'edit_revisions', 'edit_renders']) {
      assert.ok(columns(sqlite, table).has('project_id'), `${table} 缺少 project_id`)
    }

    const names = indexes(sqlite)
    for (const name of [
      'idx_edit_drafts_project',
      'idx_edit_revisions_project_no',
      'idx_edit_revisions_project_current',
      'idx_edit_renders_project_cache',
      'idx_films_export',
      'idx_films_episode',
      'idx_edit_projects_source',
      'idx_edit_projects_legacy',
    ]) {
      assert.ok(names.has(name), `缺少索引 ${name}`)
    }
    for (const name of [
      'idx_edit_drafts_episode',
      'idx_edit_revisions_no',
      'idx_edit_revisions_current',
      'idx_edit_renders_cache_key',
    ]) {
      assert.ok(!names.has(name), `旧索引仍存在：${name}`)
    }
  } finally {
    close()
  }
})

test('历史 kind 归并为 concat，origin 回填 legacy，重复执行幂等', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.prepare(
      "INSERT INTO video_merges (episode_id, provider, model, status, merged_url, kind, created_at) VALUES (1, 'ffmpeg', 'm', 'completed', 'a.mp4', 'comfyui', 'x')",
    ).run()
    sqlite.prepare(
      "INSERT INTO video_merges (episode_id, provider, model, status, merged_url, kind, created_at) VALUES (1, 'ffmpeg', 'm', 'completed', 'b.mp4', NULL, 'x')",
    ).run()
    sqlite.prepare(
      "INSERT INTO video_merges (episode_id, provider, model, status, merged_url, kind, origin, created_at) VALUES (1, 'ffmpeg', 'm', 'completed', 'c.mp4', 'mix', 'export', 'x')",
    ).run()

    initSqliteSchema(sqlite)
    initSqliteSchema(sqlite)

    const rows = sqlite.prepare('SELECT merged_url, kind, origin FROM video_merges ORDER BY id').all() as {
      merged_url: string; kind: string; origin: string
    }[]
    assert.deepEqual(rows.map((row) => [row.merged_url, row.kind, row.origin]), [
      ['a.mp4', 'concat', 'legacy'],
      ['b.mp4', 'concat', 'legacy'],
      ['c.mp4', 'mix', 'export'],
    ])
  } finally {
    close()
  }
})

test('同一集可以保存多份工程草稿，同一工程仍唯一', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.exec("INSERT INTO dramas (title, created_at, updated_at) VALUES ('剧', 'x', 'x')")
    sqlite.exec("INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, '集', 'x', 'x')")
    sqlite.prepare(
      "INSERT INTO edit_projects (episode_id, drama_id, title, created_at, updated_at) VALUES (1, 1, 'A', 'x', 'x')",
    ).run()
    sqlite.prepare(
      "INSERT INTO edit_projects (episode_id, drama_id, title, created_at, updated_at) VALUES (1, 1, 'B', 'x', 'x')",
    ).run()

    sqlite.prepare(
      "INSERT INTO episode_edit_drafts (episode_id, project_id, plan_json, version, created_at, updated_at) VALUES (1, 1, '{}', 1, 'x', 'x')",
    ).run()
    sqlite.prepare(
      "INSERT INTO episode_edit_drafts (episode_id, project_id, plan_json, version, created_at, updated_at) VALUES (1, 2, '{}', 1, 'x', 'x')",
    ).run()
    assert.throws(() => sqlite.prepare(
      "INSERT INTO episode_edit_drafts (episode_id, project_id, plan_json, version, created_at, updated_at) VALUES (1, 1, '{}', 2, 'x', 'x')",
    ).run(), /UNIQUE/)
  } finally {
    close()
  }
})

test('current_film_id 按 URL 回填，同 URL 取最新未删除成片', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.exec("INSERT INTO dramas (title, created_at, updated_at) VALUES ('剧', 'x', 'x')")
    sqlite.exec("INSERT INTO episodes (drama_id, episode_number, title, video_url, created_at, updated_at) VALUES (1, 1, '集', 'same.mp4', 'x', 'x')")
    sqlite.exec("INSERT INTO video_merges (episode_id, provider, model, status, merged_url, kind, created_at) VALUES (1, 'f', 'm', 'completed', 'same.mp4', 'concat', '2026-01-01')")
    sqlite.exec("INSERT INTO video_merges (episode_id, provider, model, status, merged_url, kind, created_at) VALUES (1, 'f', 'm', 'completed', 'same.mp4', 'concat', '2026-02-01')")

    initSqliteSchema(sqlite)

    const episode = sqlite.prepare('SELECT current_film_id FROM episodes WHERE id = 1').get() as { current_film_id: number }
    assert.equal(episode.current_film_id, 2)
  } finally {
    close()
  }
})

test('旧草稿回填到 source_merge_id 为空的旧工程', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.exec("INSERT INTO dramas (title, created_at, updated_at) VALUES ('剧', 'x', 'x')")
    sqlite.exec("INSERT INTO episodes (drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, '老集', 'x', 'x')")
    sqlite.exec("INSERT INTO episode_edit_drafts (episode_id, plan_json, version, created_at, updated_at) VALUES (1, '{}', 0, 'x', 'x')")

    initSqliteSchema(sqlite)

    const project = sqlite.prepare('SELECT id, source_merge_id, source_url FROM edit_projects WHERE episode_id = 1').get() as {
      id: number; source_merge_id: number | null; source_url: string | null
    }
    assert.ok(project.id)
    assert.equal(project.source_merge_id, null)
    const draft = sqlite.prepare('SELECT project_id FROM episode_edit_drafts WHERE episode_id = 1').get() as { project_id: number }
    assert.equal(draft.project_id, project.id)
  } finally {
    close()
  }
})
