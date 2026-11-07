/**
 * B0 基础层七张新表：novel_annotations / novel_foreshadows / director_plans /
 * director_plan_revisions / agent_sessions / agent_messages / agent_proposals
 * 覆盖：建表齐全、部分唯一索引、幂等重放、索引补齐、最小记录往返、逻辑关联不级联。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.ts'

const FOUNDATION_TABLES = [
  'novel_annotations',
  'novel_foreshadows',
  'director_plans',
  'director_plan_revisions',
  'agent_sessions',
  'agent_messages',
  'agent_proposals',
] as const

const FOUNDATION_INDEXES: Record<string, string> = {
  idx_novel_annotations_chapter: 'novel_annotations',
  idx_novel_foreshadows_status: 'novel_foreshadows',
  idx_director_plans_episode: 'director_plans',
  idx_director_plan_revisions_no: 'director_plan_revisions',
  idx_director_plan_revisions_current: 'director_plan_revisions',
  idx_agent_sessions_workspace: 'agent_sessions',
  idx_agent_sessions_active: 'agent_sessions',
  idx_agent_messages_session: 'agent_messages',
  idx_agent_messages_running: 'agent_messages',
  idx_agent_proposals_session: 'agent_proposals',
  idx_agent_proposals_status: 'agent_proposals',
}

function tempDatabase(): { sqlite: Database.Database; close: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-foundation-schema-'))
  const sqlite = new Database(path.join(root, 'test.sqlite3'))
  return {
    sqlite,
    close: () => {
      sqlite.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function tableNames(sqlite: Database.Database) {
  return new Set(
    (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .map((row) => row.name),
  )
}

function indexSql(sqlite: Database.Database, name: string) {
  const row = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) as { sql?: string } | undefined
  return row?.sql ?? null
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

test('七张新表与全部索引建成，含部分唯一索引 WHERE 子句', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    const tables = tableNames(sqlite)
    for (const table of FOUNDATION_TABLES) {
      assert.ok(tables.has(table), `缺少数据表 ${table}`)
    }
    for (const [name, table] of Object.entries(FOUNDATION_INDEXES)) {
      assert.ok(indexSql(sqlite, name), `缺少索引 ${name}`)
      const idx = indexSql(sqlite, name)!
      assert.ok(idx.includes(table), `索引 ${name} 未建在 ${table} 上`)
    }
    assert.match(indexSql(sqlite, 'idx_agent_sessions_active')!, /WHERE status = 'active'/i)
    assert.match(indexSql(sqlite, 'idx_agent_messages_running')!, /WHERE status = 'running' AND role = 'assistant'/i)
    assert.match(indexSql(sqlite, 'idx_director_plans_episode')!, /UNIQUE/i)
  } finally {
    close()
  }
})

test('重复初始化幂等：表数与索引数不变且不报错', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    const tablesFirst = tableNames(sqlite)
    const indexCountFirst = (sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").get() as { n: number }).n

    initSqliteSchema(sqlite)
    initSqliteSchema(sqlite)

    assert.deepEqual(tableNames(sqlite), tablesFirst)
    const indexCountAfter = (sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").get() as { n: number }).n
    assert.equal(indexCountAfter, indexCountFirst)
  } finally {
    close()
  }
})

test('手工删除索引后重启可补回', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    sqlite.exec('DROP INDEX idx_agent_proposals_status')
    assert.equal(indexSql(sqlite, 'idx_agent_proposals_status'), null)

    initSqliteSchema(sqlite)

    assert.ok(indexSql(sqlite, 'idx_agent_proposals_status'), '索引未补回')
  } finally {
    close()
  }
})

test('逐表插入最小记录并读回：默认值与 ISO 时间正确', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    const ts = new Date().toISOString()

    sqlite.prepare(
      'INSERT INTO novel_annotations (novel_id, chapter_no, quote, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(1, 3, '他攥紧了拳头。', '伏笔', ts, ts)
    sqlite.prepare(
      'INSERT INTO novel_foreshadows (novel_id, title, setup_chapter, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(1, '墙上的枪', 2, ts, ts)
    sqlite.prepare(
      'INSERT INTO director_plans (episode_id, drama_id, doc_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(10, 1, '{"shots":[]}', ts, ts)
    sqlite.prepare(
      'INSERT INTO director_plan_revisions (plan_id, revision_no, doc_json, is_current, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(1, 1, '{"shots":[]}', 1, ts)
    sqlite.prepare(
      'INSERT INTO agent_sessions (workspace_key, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('drama:1', '第一条会话', ts, ts)
    sqlite.prepare(
      'INSERT INTO agent_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
    ).run(1, 'user', '帮我看看第二集', ts)
    sqlite.prepare(
      'INSERT INTO agent_proposals (session_id, kind, target_type, target_id, drama_id, episode_id, after_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(1, 'storyboard.update', 'storyboard', 5, 1, 10, '{"title":"新标题"}', ts, ts)

    const ann = sqlite.prepare('SELECT * FROM novel_annotations WHERE novel_id = 1').get() as any
    assert.equal(ann.kind, 'note')
    assert.equal(ann.status, 'open')
    assert.match(ann.created_at, ISO)

    const fore = sqlite.prepare('SELECT * FROM novel_foreshadows WHERE novel_id = 1').get() as any
    assert.equal(fore.status, 'planned')
    assert.equal(fore.source, 'manual')
    assert.equal(fore.payoff_chapter, null)

    const plan = sqlite.prepare('SELECT * FROM director_plans WHERE episode_id = 10').get() as any
    assert.equal(plan.doc_version, 1)
    assert.equal(plan.version, 1)

    const rev = sqlite.prepare('SELECT * FROM director_plan_revisions WHERE plan_id = 1').get() as any
    assert.equal(rev.revision_no, 1)
    assert.equal(rev.is_current, 1)

    const session = sqlite.prepare('SELECT * FROM agent_sessions WHERE id = 1').get() as any
    assert.equal(session.preset, 'assistant')
    assert.equal(session.status, 'active')
    assert.equal(session.deleted_at, null)

    const msg = sqlite.prepare('SELECT * FROM agent_messages WHERE session_id = 1').get() as any
    assert.equal(msg.status, 'completed')
    assert.equal(msg.role, 'user')

    const proposal = sqlite.prepare('SELECT * FROM agent_proposals WHERE session_id = 1').get() as any
    assert.equal(proposal.status, 'proposed')
    assert.equal(proposal.proposed_by, 'agent')

    // 同 workspace_key 第二条 active 会话被部分唯一索引拒绝
    assert.throws(() => {
      sqlite.prepare('INSERT INTO agent_sessions (workspace_key, created_at, updated_at) VALUES (?, ?, ?)').run('drama:1', ts, ts)
    })
    // 同 (session_id) 第二条 running assistant 消息被部分唯一索引拒绝
    sqlite.prepare("INSERT INTO agent_messages (session_id, role, status, created_at) VALUES (?, 'assistant', 'running', ?)").run(1, ts)
    assert.throws(() => {
      sqlite.prepare("INSERT INTO agent_messages (session_id, role, status, created_at) VALUES (?, 'assistant', 'running', ?)").run(1, ts)
    })
    // 同 (plan_id, revision_no) 重复被拒绝
    assert.throws(() => {
      sqlite.prepare('INSERT INTO director_plan_revisions (plan_id, revision_no, created_at) VALUES (?, ?, ?)').run(1, 1, ts)
    })
  } finally {
    close()
  }
})

test('逻辑关联不级联：删除 director_plans 行后修订记录仍可查询', () => {
  const { sqlite, close } = tempDatabase()
  try {
    initSqliteSchema(sqlite)
    const ts = new Date().toISOString()
    sqlite.prepare('INSERT INTO director_plans (episode_id, drama_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(1, 1, ts, ts)
    sqlite.prepare('INSERT INTO director_plan_revisions (plan_id, revision_no, is_current, created_at) VALUES (?, ?, ?, ?)').run(1, 1, 1, ts)

    sqlite.prepare('DELETE FROM director_plans WHERE id = 1').run()

    const rev = sqlite.prepare('SELECT * FROM director_plan_revisions WHERE plan_id = 1').get() as any
    assert.ok(rev, '修订记录不应被级联删除')
    assert.equal(rev.revision_no, 1)
  } finally {
    close()
  }
})
