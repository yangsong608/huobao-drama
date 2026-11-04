/**
 * BGM 曲库（V2 · M4-4）
 *
 * 本地曲库：data/static/bgm/<file>，前端通过 /static/bgm/<file> 试听。
 * 单集使用哪首 BGM 仍写在 episodes.bgm_url，由配音混音读取。
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DATA_ROOT } from '../utils/paths.js'
import { badRequest, notFound, success } from '../utils/response.js'

const app = new Hono()

const BGM_DIR = path.join(DATA_ROOT, 'static', 'bgm')
const MAX_BYTES = 20 * 1024 * 1024
const EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'])
const MIME_EXT: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
}

/** 只允许曲库内的单层文件名，拒绝路径穿越 */
function safeName(raw: unknown): string | null {
  const name = String(raw || '').trim()
  if (!name || name !== path.basename(name) || name.startsWith('.')) return null
  const ext = path.extname(name).toLowerCase()
  return EXTS.has(ext) ? name : null
}

function urlOf(name: string): string {
  return `/static/bgm/${encodeURIComponent(name)}`
}

app.get('/', async (c) => {
  await fsp.mkdir(BGM_DIR, { recursive: true })
  const entries = await fsp.readdir(BGM_DIR, { withFileTypes: true })
  const items = await Promise.all(entries
    .filter((entry) => entry.isFile() && EXTS.has(path.extname(entry.name).toLowerCase()))
    .map(async (entry) => {
      const stat = await fsp.stat(path.join(BGM_DIR, entry.name))
      return { name: entry.name, url: urlOf(entry.name), size: stat.size, updated_at: stat.mtime.toISOString() }
    }))
  items.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return success(c, { items, dir: BGM_DIR })
})

app.post('/upload', bodyLimit({
  maxSize: MAX_BYTES + 64 * 1024,
  onError: (c) => badRequest(c, 'BGM 文件不能超过 20MB'),
}), async (c) => {
  const body = await c.req.parseBody()
  const file = body.file
  if (!(file instanceof File)) return badRequest(c, '文件必填')

  const rawExt = path.extname(file.name).toLowerCase()
  const mimeExt = MIME_EXT[file.type] || ''
  const ext = EXTS.has(rawExt) ? rawExt : mimeExt
  if (!ext) return badRequest(c, '仅支持 mp3 / wav / m4a / aac / ogg / flac 音频')
  if (file.size > MAX_BYTES) return badRequest(c, 'BGM 文件不能超过 20MB')

  const base = path.basename(file.name, path.extname(file.name))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 60) || 'bgm'
  await fsp.mkdir(BGM_DIR, { recursive: true })
  let name = `${base}${ext}`
  for (let i = 2; fs.existsSync(path.join(BGM_DIR, name)); i += 1) name = `${base}-${i}${ext}`

  await fsp.writeFile(path.join(BGM_DIR, name), Buffer.from(await file.arrayBuffer()))
  return success(c, { name, url: urlOf(name) })
})

app.delete('/:name', async (c) => {
  const name = safeName(c.req.param('name'))
  if (!name) return badRequest(c, '文件名无效')
  const target = path.join(BGM_DIR, name)
  try {
    await fsp.unlink(target)
  } catch (error: any) {
    if (error?.code === 'ENOENT') return notFound(c, 'BGM 不存在')
    throw error
  }
  return success(c, { name })
})

export default app