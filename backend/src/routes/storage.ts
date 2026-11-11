/**
 * 存储位置信息路由 — 设置页「存储位置」卡片数据源
 *
 * GET / → 当前模式(desktop/server)、目录路径、磁盘占用（分桶）与剩余空间。
 * 占用计算较重（全目录 walk）：内存缓存 60s TTL + stale-while-revalidate，
 * 过期时立即返回旧值并后台单飞重算（computing 防并发）；首次无值才同步等待。
 */
import { Hono } from 'hono'
import fs from 'node:fs/promises'
import path from 'node:path'
import { and, isNotNull, isNull } from 'drizzle-orm'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
import { db, dbPath, schema } from '../db/index.js'
import { dirUsage } from '../utils/dirsize.js'
import { success } from '../utils/response.js'
import { isPathInside, projectStorageUsage } from '../services/project-storage.js'
import { currentStorageState } from '../services/storage-guard.js'
import { listBackups } from '../services/db-backups.js'

const app = new Hono()

const USAGE_TTL_MS = 60_000
const APP_STORAGE_FILE = '.app-storage.json'

interface AppStorageSnapshot {
  runtimeBytes: number
  logsBytes: number
  cacheBytes: number
  updatedAt: string | null
}

async function readAppSnapshot(): Promise<AppStorageSnapshot> {
  const empty: AppStorageSnapshot = { runtimeBytes: 0, logsBytes: 0, cacheBytes: 0, updatedAt: null }
  try {
    const raw = JSON.parse(await fs.readFile(path.join(DATA_ROOT, APP_STORAGE_FILE), 'utf8')) as Record<string, unknown>
    const pick = (key: string) => {
      const value = Number(raw[key])
      return Number.isFinite(value) && value >= 0 ? value : 0
    }
    return {
      runtimeBytes: pick('runtimeBytes'),
      logsBytes: pick('logsBytes'),
      cacheBytes: pick('cacheBytes'),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    }
  } catch {
    return empty
  }
}

interface UsageCache {
  usage: Awaited<ReturnType<typeof dirUsage>> | null
  computedAt: string | null
  computing: boolean
}
const cache: UsageCache = { usage: null, computedAt: null, computing: false }

async function computeUsage() {
  if (cache.computing) return
  cache.computing = true
  try {
    const usage = await dirUsage(DATA_ROOT, dbPath)
    // 项目自定义目录可能在外置盘，dirUsage(DATA_ROOT) 扫不到；按子目录并入同一套桶
    const custom = await db.select({ id: schema.dramas.id, storageDir: schema.dramas.storageDir })
      .from(schema.dramas)
      .where(and(isNull(schema.dramas.deletedAt), isNotNull(schema.dramas.storageDir)))
    for (const row of custom) {
      const dir = String(row.storageDir || '').trim()
      if (!dir || !path.isAbsolute(dir) || isPathInside(DATA_ROOT, dir)) continue
      const projectUsage = await projectStorageUsage(row.id)
      for (const item of projectUsage.subdirs) {
        if (item.name === 'images' || item.name === 'videos' || item.name === 'merged'
          || item.name === 'uploads' || item.name === 'temp') {
          usage[item.name] += item.bytes
          usage.total += item.bytes
        }
      }
    }
    cache.usage = usage
    cache.computedAt = new Date().toISOString()
  } finally {
    cache.computing = false
  }
}

// 启动 10s 后后台预热一次，用户进设置页时大概率已命中缓存
const warmup = setTimeout(() => { void computeUsage() }, 10_000)
warmup.unref?.()

app.get('/', async (c) => {
  const fresh = cache.computedAt && (Date.now() - new Date(cache.computedAt).getTime()) < USAGE_TTL_MS
  let usageStale = false
  if (!fresh) {
    if (cache.usage) {
      // stale-while-revalidate：先回旧值，后台重算
      usageStale = true
      void computeUsage()
    } else {
      // 首次无值，同步等待首算（保证进入页面必有数据）
      await computeUsage()
    }
  }

  const mode = process.env.HUOBAO_APP === '1'
    ? 'app'
    : process.env.HUOBAO_DESKTOP === '1' ? 'desktop' : 'server'
  const storage = await currentStorageState()
  const appStorage = mode === 'app' ? await readAppSnapshot() : null
  const backupMeta = mode === 'app' ? await listBackups(DATA_ROOT) : []
  return success(c, {
    mode,
    dataDir: DATA_ROOT,
    storageRoot: STORAGE_ROOT,
    sqlitePath: dbPath,
    usage: cache.usage,
    usageStale: usageStale || cache.computing,
    computedAt: cache.computedAt,
    freeBytes: storage.freeBytes,
    storage: {
      level: storage.level,
      warnBytes: storage.warnBytes,
      blockBytes: storage.blockBytes,
    },
    app: appStorage
      ? {
          ...appStorage,
          totalBytes: (cache.usage?.total ?? 0)
            + appStorage.runtimeBytes + appStorage.logsBytes + appStorage.cacheBytes,
        }
      : null,
    backups: mode === 'app'
      ? { count: backupMeta.length, bytes: cache.usage?.backups ?? 0 }
      : null,
  })
})

export default app
