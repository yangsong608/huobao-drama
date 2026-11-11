#!/usr/bin/env node
/**
 * 运行时容器自测：SQLite、sharp、FFmpeg 缺席、后端健康与建表。
 * 由 build.sh 复制进运行中的容器执行，不进入运行时包。
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'

const requireFromRuntime = createRequire('/opt/huobao/package.json')
const result = { ok: false, checks: {} }

function fail(name, detail) {
  result.checks[name] = { ok: false, detail }
  console.error(JSON.stringify(result, null, 2))
  process.exit(1)
}

try {
  const Database = requireFromRuntime('better-sqlite3')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-smoke-'))
  const db = new Database(path.join(dir, 'smoke.sqlite'))
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  db.prepare('INSERT INTO t (v) VALUES (?)').run('ok')
  const row = db.prepare('SELECT v FROM t WHERE id = 1').get()
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v
  db.close()
  if (!row || row.v !== 'ok') fail('better-sqlite3', '读写结果不符')
  result.checks['better-sqlite3'] = { ok: true, sqliteVersion }
} catch (err) {
  fail('better-sqlite3', String(err))
}

try {
  const sharp = requireFromRuntime('sharp')
  const raw = Buffer.alloc(8 * 8 * 3, 0x40)
  const png = await sharp(raw, { raw: { width: 8, height: 8, channels: 3 } }).png().toBuffer()
  const meta = await sharp(png).metadata()
  if (meta.width !== 8 || meta.height !== 8 || meta.format !== 'png') fail('sharp', `元数据不符: ${JSON.stringify(meta)}`)
  result.checks.sharp = { ok: true, version: sharp.versions ? sharp.versions.vips : 'unknown', outputBytes: png.length }
} catch (err) {
  fail('sharp', String(err))
}

try {
  for (const pkg of ['ffmpeg-static', 'ffprobe-static']) {
    try {
      requireFromRuntime.resolve(pkg)
      fail('ffmpeg-absent', `${pkg} 不应存在`)
    } catch {
      // 预期缺席
    }
  }
  for (const bin of ['ffmpeg', 'ffprobe']) {
    for (const dir of (process.env.PATH || '').split(':')) {
      if (dir && fs.existsSync(path.join(dir, bin))) fail('ffmpeg-absent', `PATH 中存在 ${bin}: ${dir}`)
    }
  }
  result.checks['ffmpeg-absent'] = { ok: true }
} catch (err) {
  fail('ffmpeg-absent', String(err))
}

const healthUrl = process.env.SMOKE_HEALTH_URL || 'http://127.0.0.1:5679/api/v1/health'
let health
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(healthUrl)
    if (res.ok) {
      health = await res.json()
      break
    }
  } catch {
    // 后端可能仍在启动
  }
  await new Promise(r => setTimeout(r, 1000))
}
if (!health || health.status !== 'ok') fail('health', `健康检查失败: ${JSON.stringify(health)}`)
result.checks.health = { ok: true, version: health.version || null }

try {
  const sqlitePath = process.env.SMOKE_SQLITE_PATH
  if (!sqlitePath) throw new Error('缺少 SMOKE_SQLITE_PATH')
  const Database = requireFromRuntime('better-sqlite3')
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true })
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  db.close()
  if (!tables.includes('dramas')) fail('schema', `缺少 dramas 表，现有 ${tables.length} 张表`)
  result.checks.schema = { ok: true, tableCount: tables.length }
} catch (err) {
  fail('schema', String(err))
}

result.ok = true
console.log(JSON.stringify(result, null, 2))
