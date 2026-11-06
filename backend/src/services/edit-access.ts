import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getEditWorkspaceMode, type EditWorkspaceMode } from './app-settings.js'
import { EditWorkspaceError } from './edit-errors.js'

export type ReadableEpisode = typeof schema.episodes.$inferSelect

export function loadEpisodeOrThrow(episodeId: number): ReadableEpisode {
  const episode = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .get()
  if (!episode) throw new EditWorkspaceError(404, 'EPISODE_NOT_FOUND', '分集不存在')
  return episode
}

export function getReadableEpisode(episodeId: number): {
  episode: ReadableEpisode
  mode: Exclude<EditWorkspaceMode, 'off'>
} {
  const episode = loadEpisodeOrThrow(episodeId)
  const mode = getEditWorkspaceMode()
  if (mode === 'off') throw new EditWorkspaceError(403, 'EDIT_WORKSPACE_OFF', '剪辑工作台已关闭')
  return { episode, mode }
}

export function getWritableEpisode(episodeId: number): ReadableEpisode {
  const { episode, mode } = getReadableEpisode(episodeId)
  if (mode !== 'on') throw new EditWorkspaceError(403, 'EDIT_READONLY', '剪辑工作台为只读模式')
  return episode
}

export function projectForEpisode(episode: ReadableEpisode) {
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).get()
  return { drama, aspectRatio: drama?.aspectRatio ?? null }
}
