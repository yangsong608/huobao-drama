import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const { initSqliteSchema } = await import('../src/db/sqlite-schema.ts')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-atlas-migrate-'))
after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('legacy novels gain three columns and backfill third_limited', () => {
  const db = new Database(path.join(root, 'legacy.sqlite3'))
  db.exec(`CREATE TABLE novels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )`)
  db.prepare('INSERT INTO novels (title, created_at, updated_at) VALUES (?, ?, ?)')
    .run('旧书', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')

  initSqliteSchema(db)

  const columns = db.prepare('PRAGMA table_info(novels)').all() as { name: string }[]
  const names = columns.map((column) => column.name)
  assert.ok(names.includes('narrative_person'))
  assert.ok(names.includes('timeline_events'))
  assert.ok(names.includes('world_map'))
  const row = db.prepare('SELECT narrative_person FROM novels WHERE title = ?').get('旧书') as { narrative_person: string }
  assert.equal(row.narrative_person, 'third_limited')

  const fresh = new Database(path.join(root, 'fresh.sqlite3'))
  initSqliteSchema(fresh)
  const freshRows = fresh.prepare('PRAGMA table_info(novels)').all() as { name: string; dflt_value: string | null }[]
  const person = freshRows.find((column) => column.name === 'narrative_person')
  assert.equal(person?.dflt_value, "'first'")
  db.close()
  fresh.close()
})
