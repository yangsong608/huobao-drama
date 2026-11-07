import fs from 'node:fs'
import path from 'node:path'
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import { probeMedia } from './export-validation.js'

export type FilmKind = 'concat' | 'mix' | 'edit' | 'import'
export type FilmOrigin = 'concat' | 'export' | 'import' | 'legacy'

export class FilmError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface FilmSummary {
  id: number
  title: string
  kind: FilmKind
  origin: FilmOrigin
  url: string
  subtitle_url: string | null
  duration_ms: number
  duration_unknown: boolean
  created_at: string
  is_current: boolean
  source_merge_id: number | null
  export_id: number | null
  edit_revision_id: number | null
  mix_revision_id: number | null
  edit_project_id: number | null
}

export interface FilmDetail extends FilmSummary {
  has_audio: boolean
  width: number | null
  height: number | null
  subtitle_burned: boolean
  subtitle_cues: number | null
  edit_project: { id: number; updated_at: string } | null
}

const FILM_KINDS: FilmKind[] = ['concat', 'mix', 'edit', 'import']
const FILM_ORIGINS: FilmOrigin[] = ['concat', 'export', 'import', 'legacy']

function kindOf(value: unknown): FilmKind {
  return FILM_KINDS.includes(value as FilmKind) ? value as FilmKind : 'concat'
}

function originOf(value: unknown): FilmOrigin {
  return FILM_ORIGINS.includes(value as FilmOrigin) ? value as FilmOrigin : 'legacy'
}

export function filmKindOf(value: unknown): FilmKind {
  return kindOf(value)
}

export function getFilmRow(filmId: number) {
  const row = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, filmId)).get()
  if (!row || row.deletedAt) throw new FilmError(404, 'FILM_NOT_FOUND', '成片不存在或已删除')
  return row
}

function activeProjectsOf(episodeId: number, filmIds: number[]) {
  if (filmIds.length === 0) return new Map<number, { id: number; updated_at: string }>()
  const rows = db.select().from(schema.editProjects)
    .where(and(
      eq(schema.editProjects.episodeId, episodeId),
      inArray(schema.editProjects.sourceMergeId, filmIds),
      isNull(schema.editProjects.deletedAt),
    ))
    .all()
  return new Map(rows.map((row) => [row.sourceMergeId!, { id: row.id, updated_at: row.updatedAt }]))
}

export function listFilms(episodeId: number, limit = 50) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new FilmError(404, 'EPISODE_NOT_FOUND', '集不存在')
  const rows = db.select().from(schema.videoMerges)
    .where(and(
      eq(schema.videoMerges.episodeId, episodeId),
      eq(schema.videoMerges.status, 'completed'),
      isNull(schema.videoMerges.deletedAt),
    ))
    .orderBy(desc(schema.videoMerges.createdAt), desc(schema.videoMerges.id))
    .limit(Math.min(100, Math.max(1, limit)))
    .all()
    .filter((row) => Boolean(row.mergedUrl))
  const projects = activeProjectsOf(episodeId, rows.map((row) => row.id))
  return {
    episode_id: episodeId,
    current_film_id: episode.currentFilmId ?? null,
    films: rows.map((row) => ({
      id: row.id,
      title: row.title || `第 ${episode.episodeNumber} 集成片`,
      kind: kindOf(row.kind),
      origin: originOf(row.origin),
      url: row.mergedUrl!,
      subtitle_url: row.subtitleUrl ?? null,
      duration_ms: Math.max(0, Math.round((row.duration || 0) * 1000)),
      duration_unknown: !row.duration || row.duration <= 0,
      created_at: row.createdAt,
      is_current: episode.currentFilmId === row.id,
      source_merge_id: row.sourceMergeId ?? null,
      export_id: row.exportId ?? null,
      edit_revision_id: row.editRevisionId ?? null,
      mix_revision_id: row.mixRevisionId ?? null,
      edit_project_id: projects.get(row.id)?.id ?? null,
    })) satisfies FilmSummary[],
  }
}

function countSrtCues(file: string): number | null {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const matches = text.match(/-->/g)
    return matches ? matches.length : 0
  } catch {
    return null
  }
}

export async function getFilmDetail(filmId: number): Promise<FilmDetail> {
  const row = getFilmRow(filmId)
  if (!row.mergedUrl) throw new FilmError(404, 'FILM_NOT_FOUND', '成片不存在或已删除')
  const abs = getAbsolutePath(row.mergedUrl)
  if (!fs.existsSync(abs)) throw new FilmError(422, 'FILM_UNREADABLE', '成片文件无法读取，请重新生成')
  const probe = await probeMedia(abs).catch(() => null)
  const project = row.episodeId
    ? db.select().from(schema.editProjects)
        .where(and(
          eq(schema.editProjects.episodeId, row.episodeId),
          eq(schema.editProjects.sourceMergeId, row.id),
          isNull(schema.editProjects.deletedAt),
        ))
        .get()
    : undefined
  return {
    id: row.id,
    title: row.title || `成片 ${row.id}`,
    kind: kindOf(row.kind),
    origin: originOf(row.origin),
    url: row.mergedUrl,
    subtitle_url: row.subtitleUrl ?? null,
    duration_ms: Math.max(0, Math.round((row.duration || 0) * 1000)),
    duration_unknown: !row.duration || row.duration <= 0,
    created_at: row.createdAt,
    is_current: Boolean(row.episodeId && db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, row.episodeId)).get()?.currentFilmId === row.id),
    source_merge_id: row.sourceMergeId ?? null,
    export_id: row.exportId ?? null,
    edit_revision_id: row.editRevisionId ?? null,
    mix_revision_id: row.mixRevisionId ?? null,
    edit_project_id: project?.id ?? null,
    has_audio: Boolean(probe?.audio),
    width: probe?.video?.width || null,
    height: probe?.video?.height || null,
    subtitle_burned: Boolean(row.subtitleBurned),
    subtitle_cues: row.subtitleUrl && !row.subtitleBurned
      ? countSrtCues(getAbsolutePath(row.subtitleUrl))
      : null,
    edit_project: project ? { id: project.id, updated_at: project.updatedAt } : null,
  }
}

export function setCurrentFilm(episodeId: number, filmId: number) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode || episode.deletedAt) throw new FilmError(404, 'EPISODE_NOT_FOUND', '集不存在')
  const film = getFilmRow(filmId)
  if (film.episodeId !== episodeId) throw new FilmError(400, 'FILM_EPISODE_MISMATCH', '成片不属于该集')
  if (film.status !== 'completed' || !film.mergedUrl) {
    throw new FilmError(409, 'FILM_NOT_READY', '成片尚未完成')
  }
  if (!fs.existsSync(getAbsolutePath(film.mergedUrl))) {
    throw new FilmError(422, 'FILM_UNREADABLE', '成片文件无法读取，请重新生成')
  }
  const subtitleUrl = film.subtitleBurned ? null : (film.subtitleUrl ?? null)
  const duration = film.duration && film.duration > 0
    ? film.duration
    : Math.round((episode.duration || 0))
  db.transaction((tx) => {
    tx.update(schema.episodes).set({
      currentFilmId: film.id,
      videoUrl: film.mergedUrl,
      subtitleUrl,
      duration,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.episodes.id, episodeId)).run()
    if (film.exportId) {
      const target = tx.select().from(schema.episodeExports)
        .where(eq(schema.episodeExports.id, film.exportId)).get()
      if (target) {
        // 唯一索引按 (episode_id, kind) 判重：必须清掉同 kind 的旧 current，编辑导出同样适用
        tx.update(schema.episodeExports).set({ isCurrent: false })
          .where(and(
            eq(schema.episodeExports.episodeId, episodeId),
            eq(schema.episodeExports.kind, target.kind),
            eq(schema.episodeExports.isCurrent, true),
            ne(schema.episodeExports.id, target.id),
          )).run()
        tx.update(schema.episodeExports).set({ isCurrent: true })
          .where(eq(schema.episodeExports.id, target.id)).run()
      }
    }
  }, { behavior: 'immediate' })
  return { current_film_id: film.id, video_url: film.mergedUrl, subtitle_url: subtitleUrl }
}

export function bootstrapCurrentFilmIfEmpty(episodeId: number, filmId: number): boolean {
  const film = getFilmRow(filmId)
  if (film.status !== 'completed' || !film.mergedUrl) return false
  const result = db.update(schema.episodes).set({
    currentFilmId: film.id,
    videoUrl: film.mergedUrl,
    subtitleUrl: film.subtitleBurned ? null : (film.subtitleUrl ?? null),
    duration: film.duration && film.duration > 0 ? film.duration : undefined,
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(schema.episodes.id, episodeId),
    isNull(schema.episodes.currentFilmId),
  )).run()
  return result.changes > 0
}

export function deleteFilm(filmId: number) {
  const film = getFilmRow(filmId)
  if (film.episodeId) {
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, film.episodeId)).get()
    if (episode?.currentFilmId === filmId) {
      throw new FilmError(409, 'FILM_IS_CURRENT', '这是当前成片，请先把其他成片设为当前')
    }
  }
  const ts = new Date().toISOString()
  let deletedProjectId: number | null = null
  db.transaction((tx) => {
    tx.update(schema.videoMerges).set({ deletedAt: ts }).where(eq(schema.videoMerges.id, filmId)).run()
    if (film.episodeId) {
      const project = tx.select().from(schema.editProjects)
        .where(and(
          eq(schema.editProjects.episodeId, film.episodeId),
          eq(schema.editProjects.sourceMergeId, filmId),
          isNull(schema.editProjects.deletedAt),
        ))
        .get()
      if (project) {
        deletedProjectId = project.id
        tx.update(schema.editProjects).set({ status: 'deleted', deletedAt: ts, updatedAt: ts })
          .where(eq(schema.editProjects.id, project.id)).run()
        tx.update(schema.episodes).set({ editProjectId: null, updatedAt: ts })
          .where(and(
            eq(schema.episodes.id, film.episodeId),
            eq(schema.episodes.editProjectId, project.id),
          )).run()
      }
    }
  }, { behavior: 'immediate' })
  return { deleted: true, deleted_project_id: deletedProjectId }
}

export function renameFilm(filmId: number, rawTitle: unknown) {
  const film = getFilmRow(filmId)
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  if (title.length < 1 || title.length > 80) {
    throw new FilmError(400, 'FILM_TITLE_INVALID', '标题需要 1–80 个字')
  }
  db.update(schema.videoMerges).set({ title }).where(eq(schema.videoMerges.id, film.id)).run()
  return { id: film.id, title }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function localMinute(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function exportKindOf(record: typeof schema.episodeExports.$inferSelect): FilmKind {
  return record.projectId ? 'edit' : 'mix'
}

export function projectFilmFromExport(exportId: number, episodeId?: number): number {
  const record = db.select().from(schema.episodeExports).where(eq(schema.episodeExports.id, exportId)).get()
  if (!record) throw new FilmError(404, 'EXPORT_NOT_FOUND', '导出记录不存在')
  if (episodeId && record.episodeId !== episodeId) {
    throw new FilmError(404, 'EXPORT_NOT_FOUND', '该集下没有这条导出记录')
  }
  if (record.filmId) {
    const existing = db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, record.filmId)).get()
    if (existing && !existing.deletedAt) return existing.id
  }
  if (record.status !== 'completed' || !record.outputUrl) {
    throw new FilmError(409, 'EXPORT_NOT_COMPLETED', '导出尚未完成')
  }
  if (!fs.existsSync(getAbsolutePath(record.outputUrl))) {
    throw new FilmError(422, 'FILM_UNREADABLE', '成片文件无法读取，请重新生成')
  }
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, record.episodeId)).get()
  if (!episode) throw new FilmError(404, 'EPISODE_NOT_FOUND', '集不存在')
  const params = (() => {
    try { return JSON.parse(record.paramsJson || '{}') } catch { return {} }
  })() as Record<string, unknown>
  const kind = exportKindOf(record)
  const title = kind === 'edit'
    ? `第 ${episode.episodeNumber} 集 剪辑成片（${localMinute()}）`
    : `第 ${episode.episodeNumber} 集 混音成片（${localMinute()}）`
  const subtitleMode = String(params.subtitleMode ?? record.subtitleMode ?? 'none')
  const subtitleBurned = subtitleMode === 'burn' || subtitleMode === 'hard'
  const durationSeconds = Math.max(0, Math.round((record.durationMs || 0) / 1000))
  try {
    const filmId = db.transaction((tx) => {
      const inserted = tx.insert(schema.videoMerges).values({
        episodeId: record.episodeId,
        dramaId: episode.dramaId,
        title,
        provider: 'ffmpeg',
        model: 'ffmpeg-export',
        status: 'completed',
        mergedUrl: record.outputUrl!,
        duration: durationSeconds,
        kind,
        origin: 'export',
        sourceMergeId: record.sourceMergeId ?? null,
        exportId: record.id,
        editRevisionId: record.editRevisionId ?? null,
        mixRevisionId: record.mixRevisionId ?? null,
        planHash: record.planHash ?? null,
        subtitleBurned,
        subtitleUrl: subtitleBurned ? null : (typeof params.subtitleUrl === 'string' ? params.subtitleUrl : null),
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      }).returning().get()
      tx.update(schema.episodeExports).set({ filmId: inserted.id })
        .where(eq(schema.episodeExports.id, record.id)).run()
      return inserted.id
    }, { behavior: 'immediate' })
    if (params.setCurrent === true) setCurrentFilm(record.episodeId, filmId)
    return filmId
  } catch (error) {
    if (error instanceof FilmError) throw error
    throw new FilmError(500, 'FILM_PROJECTION_FAILED', '成片入库失败，可重试')
  }
}
