/**
 * 数据库备份与恢复路由（仅独立应用模式）
 *
 * - GET    /                 备份列表、等待中的恢复、上次恢复结果
 * - POST   /                 立即创建手动备份
 * - DELETE /:name            删除备份（等待恢复中的目标受保护）
 * - GET    /:name/download   下载备份文件（流式）
 * - POST   /:name/restore    创建恢复请求与安全备份，随后由壳重启后端；
 *                            真正的整库替换发生在下次打开数据库之前
 */
import { Hono } from 'hono'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { Readable } from 'node:stream'
import { DATA_ROOT } from '../utils/paths.js'
import { dbPath, sqlite } from '../db/index.js'
import { badRequest, created, notFound, success } from '../utils/response.js'
import {
  MAX_BACKUPS,
  backupPath,
  createBackupFromConnection,
  deleteBackup,
  isBackupName,
  listBackups,
  readRestoreRequest,
  readRestoreResult,
  requestRestore,
} from '../services/db-backups.js'

const app = new Hono()

app.use('*', async (c, next) => {
  if (process.env.HUOBAO_APP !== '1') {
    return c.json({ code: 403, message: '仅独立应用模式可用' }, 403)
  }
  await next()
})

async function pendingName(): Promise<string | null> {
  const pending = await readRestoreRequest(DATA_ROOT)
  return pending?.name ?? null
}

app.get('/', async (c) => {
  const [backups, pending, lastRestore] = await Promise.all([
    listBackups(DATA_ROOT),
    readRestoreRequest(DATA_ROOT),
    readRestoreResult(DATA_ROOT),
  ])
  return success(c, {
    backups,
    pendingRestore: pending,
    lastRestore,
    maxBackups: MAX_BACKUPS,
  })
})

app.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (body && typeof body !== 'object') return badRequest(c, '请求体必须是对象')
  const pending = await pendingName()
  if (pending) return badRequest(c, '已有恢复任务等待应用重启')
  try {
    const meta = await createBackupFromConnection(sqlite, 'manual', {
      dataRoot: DATA_ROOT,
      appVersion: process.env.HUOBAO_VERSION,
      protect: pending,
    })
    return created(c, meta)
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '备份失败')
  }
})

app.delete('/:name', async (c) => {
  const name = c.req.param('name')
  if (!isBackupName(name)) return badRequest(c, '备份文件名无效')
  try {
    await deleteBackup(name, DATA_ROOT)
    return success(c, { deleted: name })
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '删除失败')
  }
})

app.get('/:name/download', async (c) => {
  const name = c.req.param('name')
  if (!isBackupName(name)) return badRequest(c, '备份文件名无效')
  const file = backupPath(name, DATA_ROOT)
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) return notFound(c, '备份不存在')
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream
  return c.body(stream, 200, {
    'Content-Type': 'application/vnd.sqlite3',
    'Content-Length': String(stat.size),
    'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  })
})

app.post('/:name/restore', async (c) => {
  const name = c.req.param('name')
  if (!isBackupName(name)) return badRequest(c, '备份文件名无效')
  try {
    const request = await requestRestore(name, {
      dataRoot: DATA_ROOT,
      db: sqlite,
      appVersion: process.env.HUOBAO_VERSION,
    })
    // 数据库仍被当前进程占用，真正的替换发生在下次打开连接前；
    // 前端收到 restartRequired 后通过壳桥重启后端（桥不可用时下次启动也会生效）
    return success(c, { ...request, dbPath, restartRequired: true })
  } catch (error) {
    return badRequest(c, error instanceof Error ? error.message : '恢复请求失败')
  }
})

export default app
