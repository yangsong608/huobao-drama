/**
 * 项目媒体文件服务 — /static/projects/<dramaId>/<subDir>/<file>
 *
 * 不能再用 serveStatic(root=DATA_ROOT)：项目自定义目录可能在任意磁盘。
 * 这里按 dramas.storage_dir 解析真实路径，并实现 Range（视频拖动进度条必需）。
 * 历史文件仍由 index.ts 的 serveStatic 提供，两者互不影响。
 */
import { Hono } from 'hono'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { getProjectStorageRoot, isPathInside } from '../services/project-storage.js'

const app = new Hono()

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

const CACHE_CONTROL = 'public, max-age=31536000, immutable'

app.on(['GET', 'HEAD'], '/:id/:rest{.+}', async (c) => {
  const dramaId = Number(c.req.param('id'))
  if (!Number.isSafeInteger(dramaId) || dramaId <= 0) return c.notFound()

  let rest: string
  try {
    rest = decodeURIComponent(c.req.param('rest'))
  } catch {
    return c.notFound()
  }
  if (!rest || rest.includes('\\') || rest.split('/').some(part => !part || part === '..')) {
    return c.notFound()
  }

  const root = getProjectStorageRoot(dramaId)
  const absolute = path.resolve(root, ...rest.split('/'))
  if (!isPathInside(root, absolute)) return c.notFound()

  let stat: fs.Stats
  try {
    stat = await fsp.stat(absolute)
  } catch {
    return c.notFound()
  }
  if (!stat.isFile()) return c.notFound()

  const headers: Record<string, string> = {
    'Content-Type': MIME[path.extname(absolute).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': CACHE_CONTROL,
    'Last-Modified': stat.mtime.toUTCString(),
  }
  const isHead = c.req.method === 'HEAD'
  const range = c.req.header('range')

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!match || (match[1] === '' && match[2] === '')) return rangeNotSatisfiable(c, stat.size, headers)

    let start: number
    let end: number
    if (match[1] === '') {
      // bytes=-500：最后 500 字节
      const suffix = Number(match[2])
      if (!Number.isFinite(suffix) || suffix <= 0) return rangeNotSatisfiable(c, stat.size, headers)
      start = Math.max(0, stat.size - suffix)
      end = stat.size - 1
    } else {
      start = Number(match[1])
      end = match[2] === '' ? stat.size - 1 : Number(match[2])
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= stat.size) {
      return rangeNotSatisfiable(c, stat.size, headers)
    }
    end = Math.min(end, stat.size - 1)

    const partialHeaders = {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': String(end - start + 1),
    }
    if (isHead) return c.body(null, 206, partialHeaders)
    const stream = fs.createReadStream(absolute, { start, end })
    return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 206, partialHeaders)
  }

  const fullHeaders = { ...headers, 'Content-Length': String(stat.size) }
  if (isHead) return c.body(null, 200, fullHeaders)
  const stream = fs.createReadStream(absolute)
  return c.body(Readable.toWeb(stream) as unknown as ReadableStream, 200, fullHeaders)
})

function rangeNotSatisfiable(c: any, size: number, headers: Record<string, string>) {
  return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${size}` })
}

export default app
