/**
 * 存储位置信息路由 — 设置页「存储位置」卡片数据源
 *
 * GET / → 当前模式(desktop/server)、目录路径、磁盘占用（分桶）与剩余空间。
 * 占用计算较重（全目录 walk）：内存缓存 60s TTL + stale-while-revalidate，
 * 过期时立即返回旧值并后台单飞重算（computing 防并发）；首次无值才同步等待。
 */
import { Hono } from 'hono'
import path from 'node:path'
import { and, isNotNull, isNull } from 'drizzle-orm'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'
import { db, dbPath, schema } from '../db/index.js'
import { dirUsage, volumeFreeBytes } from '../utils/dirsize.js'
import { success } from '../utils/response.js'
import { isPathInside, projectStorageUsage } from '../services/project-storage.js'

const app = new Hono()

const USAGE_TTL_MS = 60_000

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

  const mode = process.env.HUOBAO_DESKTOP === '1' ? 'desktop' : 'server'
  return success(c, {
    mode,
    dataDir: DATA_ROOT,
    storageRoot: STORAGE_ROOT,
    sqlitePath: dbPath,
    usage: cache.usage,
    usageStale: usageStale || cache.computing,
    computedAt: cache.computedAt,
    freeBytes: await volumeFreeBytes(DATA_ROOT),
  })
})

export default app
