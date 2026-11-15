import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { and, desc, eq, inArray, isNull, like, sql } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import {
  ensureVideoProjectStorageLayout,
  getVideoProjectStorageRoot,
  isValidVideoProjectId,
  parseVideoProjectStoragePath,
  removeVideoProjectStorage,
  resolveVideoProjectStorageFile,
  videoProjectStorageRelative,
} from './video-project-storage.js'

export const VIDEO_SOURCE_MAX_BYTES = 256 * 1024 * 1024
export const VIDEO_FACE_MAX_BYTES = 20 * 1024 * 1024
export const MAX_REFERENCE_FACES = 4
export const MIN_REFERENCE_FACE_EDGE = 128

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.m4v'])
const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MODES = new Set(['face', 'character'])
const STATUSES = new Set(['draft', 'analyzing', 'ready', 'generating', 'completed', 'failed'])
export const ACTIVE_RUN_STATUSES = [
  'uploaded', 'probing', 'shot_detection', 'chunking', 'analyzing', 'scene_ref_ready',
  'prompt_ready', 'queued', 'generating', 'chunk_done', 'seam_check', 'shot_done',
  'merging', 'postprocessing',
]

export class VideoProjectValidationError extends Error {}
export class VideoProjectNotFoundError extends Error {}

export type VideoProjectRow = typeof schema.videoProjects.$inferSelect

function nowIso() {
  return new Date().toISOString()
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function hashBytes(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 20)
}

function isVideoHeader(buffer: Buffer): boolean {
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') return true
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return true
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF'
    && buffer.subarray(8, 12).toString('latin1') === 'AVI ') return true
  return false
}

function parseFacePaths(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string' && item.length > 0)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : []
  } catch {
    return []
  }
}

function parseMeta(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function urlOf(relativePath: string | null | undefined): string | null {
  return relativePath ? `/${relativePath}` : null
}

function serializeLatestRun(row: typeof schema.videoSwapRuns.$inferSelect | null | undefined) {
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    error_code: row.errorCode,
    error_message: row.errorMessage,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function serializeProject(row: VideoProjectRow, latestRun?: typeof schema.videoSwapRuns.$inferSelect | null) {
  const facePaths = parseFacePaths(row.referenceFacePaths)
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    status: row.status,
    source_video_path: row.sourceVideoPath,
    source_video_url: urlOf(row.sourceVideoPath),
    source_video_meta: parseMeta(row.sourceVideoMeta),
    reference_face_paths: facePaths,
    reference_face_urls: facePaths.map(p => `/${p}`),
    prompt: row.prompt,
    config_id: row.configId,
    latest_run_id: row.latestRunId,
    latest_run: serializeLatestRun(latestRun),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
  }
}

function validateTitle(raw: unknown): string {
  const title = String(raw ?? '').trim()
  if (!title) throw new VideoProjectValidationError('项目名称不能为空')
  if (title.length > 200) throw new VideoProjectValidationError('项目名称不能超过 200 个字符')
  return title
}

function validateMode(raw: unknown): 'face' | 'character' {
  const mode = String(raw ?? '').trim()
  if (!MODES.has(mode)) throw new VideoProjectValidationError('项目模式必须是 face 或 character')
  return mode as 'face' | 'character'
}

function validatePrompt(raw: unknown): string {
  const prompt = String(raw ?? '').trim()
  if (prompt.length > 20000) throw new VideoProjectValidationError('提示词不能超过 20000 个字符')
  return prompt
}

function validateConfigId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) throw new VideoProjectValidationError('配置编号无效')
  return id
}

function getProjectRow(id: number): VideoProjectRow | null {
  if (!isValidVideoProjectId(id)) return null
  const row = db.select().from(schema.videoProjects)
    .where(and(eq(schema.videoProjects.id, id), isNull(schema.videoProjects.deletedAt)))
    .get()
  return row ?? null
}

function latestRunFor(projectId: number) {
  return db.select().from(schema.videoSwapRuns)
    .where(eq(schema.videoSwapRuns.projectId, projectId))
    .orderBy(desc(schema.videoSwapRuns.createdAt))
    .get() ?? null
}

function previousProjectFile(relativePath: string | null | undefined, projectId: number): string | null {
  if (!relativePath) return null
  const parsed = parseVideoProjectStoragePath(relativePath)
  if (!parsed || parsed.projectId !== projectId) return null
  try {
    return resolveVideoProjectStorageFile(projectId, parsed.rest)
  } catch {
    return null
  }
}

async function removeIfExists(file: string | null): Promise<void> {
  if (!file) return
  await fsp.rm(file, { force: true }).catch(() => undefined)
}

async function copyProjectFile(relativePath: string, newProjectId: number, subdir: string): Promise<string | null> {
  const parsed = parseVideoProjectStoragePath(relativePath)
  if (!parsed) return null
  let source: string
  try {
    source = resolveVideoProjectStorageFile(parsed.projectId, parsed.rest)
  } catch {
    return null
  }
  if (!fs.existsSync(source)) return null
  const destinationRelative = videoProjectStorageRelative(newProjectId, subdir, path.basename(source))
  const destination = resolveVideoProjectStorageFile(newProjectId, destinationRelative.slice(`static/video-projects/${newProjectId}/`.length))
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  await fsp.copyFile(source, destination)
  return destinationRelative
}

export function listVideoProjects(input: {
  keyword?: string | null
  status?: string | null
  page?: number | null
  pageSize?: number | null
} = {}) {
  const page = Math.max(1, Number(input.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(input.pageSize) || 50))
  const conditions = [isNull(schema.videoProjects.deletedAt)]
  const keyword = String(input.keyword ?? '').trim()
  if (keyword) conditions.push(like(schema.videoProjects.title, `%${keyword}%`))
  const status = String(input.status ?? '').trim()
  if (status) {
    if (!STATUSES.has(status)) throw new VideoProjectValidationError('项目状态无效')
    conditions.push(eq(schema.videoProjects.status, status))
  }
  const where = and(...conditions)
  const total = Number(db.select({ count: sql<number>`count(*)` })
    .from(schema.videoProjects)
    .where(where)
    .get()?.count ?? 0)
  const rows = db.select().from(schema.videoProjects)
    .where(where)
    .orderBy(desc(schema.videoProjects.updatedAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all()
  const ids = rows.map(row => row.id)
  const latest = new Map<number, typeof schema.videoSwapRuns.$inferSelect>()
  if (ids.length) {
    const runs = db.select().from(schema.videoSwapRuns)
      .where(inArray(schema.videoSwapRuns.projectId, ids))
      .orderBy(desc(schema.videoSwapRuns.createdAt))
      .all()
    for (const run of runs) {
      if (!latest.has(run.projectId)) latest.set(run.projectId, run)
    }
  }
  return {
    items: rows.map(row => serializeProject(row, latest.get(row.id))),
    pagination: {
      page,
      page_size: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize),
    },
  }
}

export function getVideoProject(id: number) {
  const row = getProjectRow(id)
  if (!row) return null
  return serializeProject(row, latestRunFor(id))
}

export async function createVideoProject(input: {
  title: unknown
  mode: unknown
  prompt?: unknown
  config_id?: unknown
}) {
  const title = validateTitle(input.title)
  const mode = validateMode(input.mode)
  const prompt = validatePrompt(input.prompt)
  const configId = validateConfigId(input.config_id)
  const stamp = nowIso()
  const inserted = db.insert(schema.videoProjects).values({
    title,
    mode,
    status: 'draft',
    prompt,
    configId,
    referenceFacePaths: '[]',
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const id = getInsertId(inserted)
  try {
    await ensureVideoProjectStorageLayout(id)
  } catch (error) {
    db.delete(schema.videoProjects).where(eq(schema.videoProjects.id, id)).run()
    await removeVideoProjectStorage(id).catch(() => undefined)
    throw error
  }
  return getVideoProject(id)!
}

export async function updateVideoProject(id: number, input: {
  title?: unknown
  prompt?: unknown
  config_id?: unknown
}) {
  const row = getProjectRow(id)
  if (!row) throw new VideoProjectNotFoundError('视频项目不存在')
  const patch: Record<string, unknown> = { updatedAt: nowIso() }
  let resetStatus = false
  if (input.title !== undefined) patch.title = validateTitle(input.title)
  if (input.prompt !== undefined) {
    patch.prompt = validatePrompt(input.prompt)
    resetStatus = patch.prompt !== row.prompt
  }
  if (input.config_id !== undefined) {
    patch.configId = validateConfigId(input.config_id)
    resetStatus = resetStatus || patch.configId !== row.configId
  }
  if (resetStatus) patch.status = 'draft'
  db.update(schema.videoProjects).set(patch).where(eq(schema.videoProjects.id, id)).run()
  return getVideoProject(id)!
}

export async function duplicateVideoProject(id: number) {
  const source = getProjectRow(id)
  if (!source) throw new VideoProjectNotFoundError('视频项目不存在')
  const duplicate = await createVideoProject({
    title: `${source.title} 副本`.slice(0, 200),
    mode: source.mode,
    prompt: source.prompt,
    config_id: source.configId,
  })
  if (!duplicate) throw new Error('复制项目失败')
  const newId = duplicate.id as number
  try {
    const copiedSource = source.sourceVideoPath
      ? await copyProjectFile(source.sourceVideoPath, newId, 'source')
      : null
    const copiedFaces: string[] = []
    for (const face of parseFacePaths(source.referenceFacePaths)) {
      const copied = await copyProjectFile(face, newId, 'faces')
      if (copied) copiedFaces.push(copied)
    }
    db.update(schema.videoProjects).set({
      sourceVideoPath: copiedSource,
      referenceFacePaths: JSON.stringify(copiedFaces),
      updatedAt: nowIso(),
    }).where(eq(schema.videoProjects.id, newId)).run()
  } catch (error) {
    db.delete(schema.videoProjects).where(eq(schema.videoProjects.id, newId)).run()
    await removeVideoProjectStorage(newId).catch(() => undefined)
    throw error
  }
  return getVideoProject(newId)!
}

export async function deleteVideoProject(id: number): Promise<boolean> {
  const row = getProjectRow(id)
  if (!row) return false
  const activeRun = db.select({ id: schema.videoSwapRuns.id })
    .from(schema.videoSwapRuns)
    .where(and(
      eq(schema.videoSwapRuns.projectId, id),
      inArray(schema.videoSwapRuns.status, ACTIVE_RUN_STATUSES),
    ))
    .get()
  if (activeRun) throw new VideoProjectValidationError('项目有运行中的换人任务，请先取消运行')
  const runIds = db.select({ id: schema.videoSwapRuns.id })
    .from(schema.videoSwapRuns)
    .where(eq(schema.videoSwapRuns.projectId, id))
    .all()
    .map(item => item.id)
  db.transaction(() => {
    if (runIds.length) {
      db.delete(schema.videoSwapRunLogs).where(inArray(schema.videoSwapRunLogs.runId, runIds)).run()
      db.delete(schema.videoSwapChunks).where(inArray(schema.videoSwapChunks.runId, runIds)).run()
      db.delete(schema.videoSwapShots).where(inArray(schema.videoSwapShots.runId, runIds)).run()
      db.delete(schema.videoSwapRuns).where(inArray(schema.videoSwapRuns.id, runIds)).run()
    }
    db.update(schema.videoProjects).set({
      deletedAt: nowIso(),
      updatedAt: nowIso(),
      latestRunId: null,
    }).where(eq(schema.videoProjects.id, id)).run()
  })
  await removeVideoProjectStorage(id)
  return true
}

export async function saveVideoProjectSource(
  id: number,
  file: { name: string; type?: string; buffer: Buffer },
) {
  const row = getProjectRow(id)
  if (!row) throw new VideoProjectNotFoundError('视频项目不存在')
  if (!file.buffer.length) throw new VideoProjectValidationError('视频文件为空')
  if (file.buffer.length > VIDEO_SOURCE_MAX_BYTES) {
    throw new VideoProjectValidationError('视频文件不能超过 256MB')
  }
  const ext = extOf(file.name)
  const mime = String(file.type || '').toLowerCase()
  if (!VIDEO_EXTS.has(ext) || (mime && mime !== 'application/octet-stream' && !VIDEO_MIMES.has(mime))) {
    throw new VideoProjectValidationError('仅支持 MP4/MOV/WebM/M4V 视频')
  }
  if (!isVideoHeader(file.buffer)) {
    throw new VideoProjectValidationError('上传内容不是有效视频')
  }
  await ensureVideoProjectStorageLayout(id)
  const filename = `source-${hashBytes(file.buffer)}${ext}`
  const logical = videoProjectStorageRelative(id, 'source', filename)
  const absolute = resolveVideoProjectStorageFile(id, `source/${filename}`)
  const oldFile = previousProjectFile(row.sourceVideoPath, id)
  await fsp.writeFile(absolute, file.buffer)
  if (oldFile && oldFile !== absolute) await removeIfExists(oldFile)
  const meta = {
    original_name: file.name,
    size: file.buffer.length,
    mime: mime || null,
    uploaded_at: nowIso(),
  }
  db.update(schema.videoProjects).set({
    sourceVideoPath: logical,
    sourceVideoMeta: JSON.stringify(meta),
    status: 'draft',
    updatedAt: nowIso(),
  }).where(eq(schema.videoProjects.id, id)).run()
  return getVideoProject(id)!
}

export async function saveVideoProjectFace(
  id: number,
  file: { name: string; type?: string; buffer: Buffer },
) {
  const row = getProjectRow(id)
  if (!row) throw new VideoProjectNotFoundError('视频项目不存在')
  if (!file.buffer.length) throw new VideoProjectValidationError('参考人脸文件为空')
  if (file.buffer.length > VIDEO_FACE_MAX_BYTES) {
    throw new VideoProjectValidationError('参考人脸不能超过 20MB')
  }
  const mime = String(file.type || '').toLowerCase()
  const originalExt = extOf(file.name)
  if (mime && mime !== 'application/octet-stream' && !IMAGE_MIMES.has(mime)) {
    throw new VideoProjectValidationError('参考人脸必须是 PNG/JPEG/WebP 图片')
  }
  if (originalExt && !IMAGE_EXTS.has(originalExt)) {
    throw new VideoProjectValidationError('参考人脸必须是 PNG/JPEG/WebP 图片')
  }
  let meta: sharp.Metadata
  try {
    meta = await sharp(file.buffer).metadata()
  } catch {
    throw new VideoProjectValidationError('参考人脸不是有效图片')
  }
  const width = Number(meta.width || 0)
  const height = Number(meta.height || 0)
  if (width < MIN_REFERENCE_FACE_EDGE || height < MIN_REFERENCE_FACE_EDGE) {
    throw new VideoProjectValidationError(`参考人脸至少 ${MIN_REFERENCE_FACE_EDGE}x${MIN_REFERENCE_FACE_EDGE}`)
  }
  const ext = meta.format === 'jpeg' ? '.jpg' : meta.format === 'png' ? '.png' : meta.format === 'webp' ? '.webp' : originalExt
  if (!IMAGE_EXTS.has(ext)) throw new VideoProjectValidationError('参考人脸格式不支持')
  const faces = parseFacePaths(row.referenceFacePaths)
  if (faces.length >= MAX_REFERENCE_FACES) {
    throw new VideoProjectValidationError(`参考人脸最多 ${MAX_REFERENCE_FACES} 张`)
  }
  await ensureVideoProjectStorageLayout(id)
  const filename = `face-${hashBytes(file.buffer)}${ext}`
  const logical = videoProjectStorageRelative(id, 'faces', filename)
  const absolute = resolveVideoProjectStorageFile(id, `faces/${filename}`)
  await fsp.writeFile(absolute, file.buffer)
  if (!faces.includes(logical)) faces.push(logical)
  db.update(schema.videoProjects).set({
    referenceFacePaths: JSON.stringify(faces),
    status: 'draft',
    updatedAt: nowIso(),
  }).where(eq(schema.videoProjects.id, id)).run()
  return getVideoProject(id)!
}

export function getVideoProjectRowForPreflight(id: number): VideoProjectRow | null {
  return getProjectRow(id)
}

export function videoProjectUploadLimits() {
  return {
    sourceMaxBytes: VIDEO_SOURCE_MAX_BYTES,
    faceMaxBytes: VIDEO_FACE_MAX_BYTES,
    maxFaces: MAX_REFERENCE_FACES,
  }
}

export { getVideoProjectStorageRoot }
