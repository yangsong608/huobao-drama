import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { eq } from 'drizzle-orm'
import { success, badRequest } from '../utils/response.js'
import { saveUploadedFile, generateImageThumb } from '../utils/storage.js'
import { AUDIO_MAX_BYTES, AudioUploadError, saveAudioUpload } from '../utils/audio-upload.js'
import { db, schema } from '../db/index.js'

const app = new Hono()

/**
 * 上传可带 drama_id：带项目时落到 static/projects/<id>/uploads，
 * 不带时保持历史全局 static/uploads（风格参考图等）。
 */
function resolveDramaId(raw: unknown): { id?: number; error?: string } {
  if (raw === undefined || raw === null || raw === '') return {}
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) return { error: '项目编号无效' }
  const row = db.select({ id: schema.dramas.id }).from(schema.dramas)
    .where(eq(schema.dramas.id, id)).get()
  if (!row) return { error: '项目不存在' }
  return { id }
}

// POST /upload/image
app.post('/image', async (c) => {
  const body = await c.req.parseBody()
  const file = body['file']

  if (!file || !(file instanceof File)) {
    return badRequest(c, '文件必填')
  }
  const { id: dramaId, error } = resolveDramaId(body['drama_id'] ?? body['dramaId'])
  if (error) return badRequest(c, error)

  const buffer = await file.arrayBuffer()
  const path = await saveUploadedFile(buffer, 'uploads', file.name, { dramaId })
  // 同步生成列表页缩略图，上传图与生图走同一套展示链路（失败不影响上传结果）
  await generateImageThumb(path)
  return success(c, { url: `/${path}`, path })
})

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v'])
const VIDEO_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'])
const VIDEO_MAX = 50 * 1024 * 1024 // 50MB

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

async function saveMediaUpload(
  c: any,
  kind: 'video' | 'audio',
  allowedExt: Set<string>,
  allowedMime: Set<string>,
  maxBytes: number,
) {
  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || !(file instanceof File)) {
    return badRequest(c, '文件必填')
  }
  const { id: dramaId, error } = resolveDramaId(body['drama_id'] ?? body['dramaId'])
  if (error) return badRequest(c, error)
  const label = kind === 'video' ? '视频' : '音频'
  const ext = extOf(file.name)
  // MIME 可伪造，扩展名兜底；空 / octet-stream 视为未知类型，仅按扩展名校验
  const mimeKnown = file.type && file.type !== 'application/octet-stream'
  if (!allowedExt.has(ext) || (mimeKnown && !allowedMime.has(file.type))) {
    return badRequest(c, `仅支持 ${Array.from(allowedExt).join('/')} 格式的${label}文件`)
  }
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength > maxBytes) {
    return badRequest(c, `${label}文件大小不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB`)
  }
  const path = await saveUploadedFile(buffer, 'uploads', file.name, { dramaId })
  return success(c, { url: `/${path}`, path })
}

// POST /upload/video — 参考视频上传（Seedance 多模态参考用）
app.post('/video', async (c) => saveMediaUpload(c, 'video', VIDEO_EXT, VIDEO_MIME, VIDEO_MAX))

// POST /upload/audio — 参考音频上传（Seedance 多模态参考用）
app.post('/audio', bodyLimit({ maxSize: AUDIO_MAX_BYTES + 64 * 1024,
  onError: c => badRequest(c, '音频文件大小不能超过 20MB'),
}), async (c) => {
  try {
    const body = await c.req.parseBody()
    const { id: dramaId, error } = resolveDramaId(body['drama_id'] ?? body['dramaId'])
    if (error) return badRequest(c, error)
    return success(c, await saveAudioUpload(body.file, { dramaId }))
  } catch (error) {
    if (error instanceof AudioUploadError) return badRequest(c, error.message)
    throw error
  }
})

export default app
