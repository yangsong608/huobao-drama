/**
 * 归档旧分镜任务（只读，不删除）。
 *
 * 用法：cd backend && npx tsx scripts/archive-legacy-pipeline-jobs.ts
 * 输出：<DATA_ROOT>/migrations/legacy-pipeline-jobs-<ISO>.json
 *
 * 旧路径下线前先导出 storyboard_split_jobs / storyboard_audit_jobs / storyboard_pipeline_jobs；
 * 物理删表另走审批，不在本脚本内执行。
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DATA_ROOT } from '../src/utils/paths.js'

const dbPath = process.env.SQLITE_PATH || path.resolve(DATA_ROOT, '..', 'huobao.sqlite3')
if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`)
  process.exit(1)
}

const sqlite = new Database(dbPath, { readonly: true })
const tables = ['storyboard_split_jobs', 'storyboard_audit_jobs', 'storyboard_pipeline_jobs']
const result: Record<string, unknown> = {
  exported_at: new Date().toISOString(),
  db_path: dbPath,
  tables: {},
}

for (const table of tables) {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  if (!exists) {
    ;(result.tables as Record<string, unknown>)[table] = { exists: false, rows: [] }
    continue
  }
  const rows = sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
  ;(result.tables as Record<string, unknown>)[table] = { exists: true, count: rows.length, rows }
}

const outDir = path.join(DATA_ROOT, 'migrations')
fs.mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outFile = path.join(outDir, `legacy-pipeline-jobs-${stamp}.json`)
fs.writeFileSync(outFile, JSON.stringify(result, null, 2))
sqlite.close()
console.log(`已归档旧分镜任务：${outFile}`)
