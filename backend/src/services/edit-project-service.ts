/**
 * 剪辑工程解析（设计 §6.1、§6.11）：
 * - 一部源成片对应一个工程（idx_edit_projects_source 唯一）；
 * - 打开顺序：显式 project_id → 当前成片工程（不存在则按成片自动建工程）→
 *   episodes.edit_project_id 打开指针 → 最新成片工程（updatedAt 降序）→ 旧版工程（source_merge_id 为空）；
 *   说明：当前成片工程优先于打开指针，是简报测试「当前成片的工程优先」
 *   （设置 currentFilmId 后解析必须切到当前成片工程）的绑定要求；
 * - 本文件只负责工程行与解析，不构建计划、不写草稿；
 * - 旧版工程（source_merge_id 为空）只在列表/解析中出现，本服务不创建。
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { EditWorkspaceError } from './edit-errors.js'
import { setCurrentFilm, getFilmRow } from './film-hub.js'

export type EditProjectRow = typeof schema.editProjects.$inferSelect

export interface EditProjectSummary {
  id: number
  title: string
  status: string
  source_merge_id: number | null
  source_url: string | null
  film_title: string | null
  film_kind: string | null
  legacy: boolean
  updated_at: string
  revision_count: number
}

export function projectResponse(row: EditProjectRow): EditProjectSummary {
  const film = row.sourceMergeId
    ? db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, row.sourceMergeId)).get()
    : undefined
  const revisionCount = db.select().from(schema.editRevisions)
    .where(eq(schema.editRevisions.projectId, row.id))
    .all().length
  return {
    id: row.id,
    title: row.title,
    status: row.status ?? 'active',
    source_merge_id: row.sourceMergeId ?? null,
    source_url: row.sourceUrl ?? null,
    film_title: film?.title ?? null,
    film_kind: film?.kind ?? null,
    legacy: !row.sourceMergeId,
    updated_at: row.updatedAt,
    revision_count: revisionCount,
  }
}

function loadProject(projectId: number, episodeId: number): EditProjectRow | null {
  const row = db.select().from(schema.editProjects)
    .where(and(
      eq(schema.editProjects.id, projectId),
      eq(schema.editProjects.episodeId, episodeId),
      isNull(schema.editProjects.deletedAt),
    ))
    .get()
  return row ?? null
}

export function requireEditProject(episodeId: number, projectId: number): EditProjectRow {
  const row = loadProject(projectId, episodeId)
  if (!row) throw new EditWorkspaceError(404, 'EDIT_PROJECT_NOT_FOUND', '剪辑工程不存在或已删除')
  return row
}

export function projectForFilm(episodeId: number, filmId: number): EditProjectRow | null {
  return db.select().from(schema.editProjects)
    .where(and(
      eq(schema.editProjects.episodeId, episodeId),
      eq(schema.editProjects.sourceMergeId, filmId),
      isNull(schema.editProjects.deletedAt),
    ))
    .get() ?? null
}

export function resolveEditProject(episodeId: number, rawProjectId?: number | null): EditProjectRow | null {
  if (rawProjectId) return requireEditProject(episodeId, rawProjectId)
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new EditWorkspaceError(404, 'EPISODE_NOT_FOUND', '分集不存在')
  // 当前成片的工程优先（不存在则按成片打开/创建）
  if (episode.currentFilmId) {
    const filmProject = projectForFilm(episodeId, episode.currentFilmId)
    if (filmProject) return filmProject
    const film = db.select().from(schema.videoMerges)
      .where(eq(schema.videoMerges.id, episode.currentFilmId)).get()
    if (film && !film.deletedAt && film.episodeId === episodeId && film.mergedUrl) {
      return openProjectForFilm(episodeId, episode.currentFilmId).project
    }
  }
  if (episode.editProjectId) {
    const opened = loadProject(episode.editProjectId, episodeId)
    if (opened) return opened
  }
  const rows = db.select().from(schema.editProjects)
    .where(and(eq(schema.editProjects.episodeId, episodeId), isNull(schema.editProjects.deletedAt)))
    .orderBy(sql`${schema.editProjects.sourceMergeId} IS NULL ASC`, desc(schema.editProjects.updatedAt))
    .all()
  return rows[0] ?? null
}

export function setOpenEditProject(episodeId: number, projectId: number): void {
  db.update(schema.episodes).set({ editProjectId: projectId, updatedAt: new Date().toISOString() })
    .where(eq(schema.episodes.id, episodeId)).run()
}

export function openProjectForFilm(episodeId: number, filmId: number): {
  project: EditProjectRow
  created: boolean
} {
  const film = getFilmRow(filmId)
  if (film.episodeId !== episodeId) {
    throw new EditWorkspaceError(400, 'EDIT_FILM_MISMATCH', '成片不属于该集')
  }
  if (!film.mergedUrl) throw new EditWorkspaceError(422, 'EDIT_FILM_UNREADABLE', '成片文件不可用')
  const episodeRow = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episodeRow) throw new EditWorkspaceError(404, 'EPISODE_NOT_FOUND', '分集不存在')
  const existing = projectForFilm(episodeId, filmId)
  if (existing) {
    setOpenEditProject(episodeId, existing.id)
    // 当前成片只能经 film-hub 收口写入：校验 completed + 文件存在，并同步 videoUrl/subtitleUrl 镜像列
    setCurrentFilm(episodeId, film.id)
    return { project: existing, created: false }
  }
  const ts = new Date().toISOString()
  const project = db.insert(schema.editProjects).values({
    episodeId,
    dramaId: film.dramaId ?? episodeRow.dramaId,
    sourceMergeId: film.id,
    sourceUrl: film.mergedUrl,
    title: film.title?.trim() || `成片 ${film.id}`,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  setOpenEditProject(episodeId, project.id)
  setCurrentFilm(episodeId, film.id)
  return { project, created: true }
}

export function listEditProjects(episodeId: number) {
  const rows = db.select().from(schema.editProjects)
    .where(and(eq(schema.editProjects.episodeId, episodeId), isNull(schema.editProjects.deletedAt)))
    .orderBy(desc(schema.editProjects.updatedAt))
    .all()
  return { items: rows.map(projectResponse) }
}
