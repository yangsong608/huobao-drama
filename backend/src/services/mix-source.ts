import fs from 'fs'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import { now } from '../utils/response.js'
import { hasAudioStream, probeDurationMs } from './audio-mix.js'

export type MixSourceKind = 'concat' | 'mix' | 'edit' | 'import'

export interface MixPlanSource {
  filmId: number
  kind: MixSourceKind
  url: string
  durationMs: number
  hasAudio: boolean
  containsDialogue: boolean
  containsBgm: boolean
}

export type MixSourceWarningCode = 'MIX_SOURCE_NON_CONCAT' | 'MIX_SOURCE_NO_AUDIO' | 'MIX_SOURCE_FALLBACK'

export interface MixSourceWarning {
  code: MixSourceWarningCode
  message: string
}

export interface ResolvedMixSource {
  source: MixPlanSource
  warnings: MixSourceWarning[]
}

export class MixSourceError extends Error {
  status: 400 | 404 | 422
  code: 'MIX_SOURCE_MISSING' | 'MIX_SOURCE_UNREADABLE' | 'EPISODE_NOT_FOUND'

  constructor(status: 400 | 404 | 422, code: MixSourceError['code'], message: string) {
    super(message)
    this.name = 'MixSourceError'
    this.status = status
    this.code = code
  }
}

const SOURCE_KINDS: MixSourceKind[] = ['concat', 'mix', 'edit', 'import']

export function normalizeMixSourceKind(raw: unknown): MixSourceKind {
  const value = String(raw ?? '').trim()
  return SOURCE_KINDS.includes(value as MixSourceKind) ? value as MixSourceKind : 'concat'
}

type FilmRow = typeof schema.videoMerges.$inferSelect

function usableFilms(episodeId: number): FilmRow[] {
  return db.select().from(schema.videoMerges)
    .where(eq(schema.videoMerges.episodeId, episodeId))
    .all()
    .filter((row) => row.status === 'completed' && Boolean(row.mergedUrl) && !row.deletedAt)
    .sort((a, b) => (b.id || 0) - (a.id || 0))
}

async function readSource(row: FilmRow): Promise<MixPlanSource> {
  const url = String(row.mergedUrl || '').trim()
  if (!url || row.status !== 'completed' || row.deletedAt) {
    throw new MixSourceError(422, 'MIX_SOURCE_UNREADABLE', '所选成片文件无法读取')
  }
  let absolute: string
  try {
    absolute = getAbsolutePath(url)
  } catch {
    throw new MixSourceError(422, 'MIX_SOURCE_UNREADABLE', '所选成片文件无法读取')
  }
  if (!fs.existsSync(absolute)) {
    throw new MixSourceError(422, 'MIX_SOURCE_UNREADABLE', '所选成片文件无法读取')
  }
  const probed = await probeDurationMs(absolute).catch(() => 0)
  const fallback = Math.max(0, Math.round((row.duration || 0) * 1000))
  const durationMs = Math.round(probed > 0 ? probed : fallback)
  if (durationMs <= 0) {
    throw new MixSourceError(422, 'MIX_SOURCE_UNREADABLE', '所选成片文件无法读取')
  }
  const hasAudio = await hasAudioStream(absolute).catch(() => false)
  const kind = normalizeMixSourceKind(row.kind)
  return {
    filmId: row.id,
    kind,
    url,
    durationMs,
    hasAudio,
    containsDialogue: kind !== 'concat',
    containsBgm: kind !== 'concat',
  }
}

export async function resolveMixSource(
  episodeId: number,
  requestedFilmId?: number | null,
): Promise<ResolvedMixSource> {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new MixSourceError(404, 'EPISODE_NOT_FOUND', '集不存在')
  const films = usableFilms(episodeId)
  const warnings: MixSourceWarning[] = []

  let chosen: FilmRow | undefined
  if (requestedFilmId != null) {
    chosen = films.find((row) => row.id === requestedFilmId)
    if (!chosen) {
      const exists = db.select().from(schema.videoMerges)
        .where(eq(schema.videoMerges.id, requestedFilmId)).get()
      if (exists && exists.episodeId === episodeId) {
        throw new MixSourceError(422, 'MIX_SOURCE_UNREADABLE', '所选成片文件无法读取')
      }
      throw new MixSourceError(404, 'MIX_SOURCE_MISSING', '所选成片不存在')
    }
  } else if (episode.mixSourceMergeId) {
    chosen = films.find((row) => row.id === episode.mixSourceMergeId)
    if (!chosen) {
      warnings.push({ code: 'MIX_SOURCE_FALLBACK', message: '上次选择的源成片已不可用，已自动改用其他成片' })
    }
  }
  if (!chosen && episode.currentFilmId) {
    chosen = films.find((row) => row.id === episode.currentFilmId && normalizeMixSourceKind(row.kind) === 'concat')
  }
  if (!chosen) chosen = films.find((row) => normalizeMixSourceKind(row.kind) === 'concat')
  if (!chosen) chosen = films[0]
  if (!chosen) {
    throw new MixSourceError(400, 'MIX_SOURCE_MISSING', '请先在拼接导出生成一部成片')
  }

  const source = await readSource(chosen)
  if (source.kind !== 'concat') {
    warnings.push({
      code: 'MIX_SOURCE_NON_CONCAT',
      message: '这部成片已经包含配音或配乐。为避免人声重复，对白和配乐轨已默认关闭。',
    })
  }
  if (!source.hasAudio) {
    warnings.push({
      code: 'MIX_SOURCE_NO_AUDIO',
      message: '这部成片没有声音，你仍可以添加配音或背景声。',
    })
  }
  return { source, warnings }
}

export async function persistMixSource(
  episodeId: number,
  filmId: number,
): Promise<ResolvedMixSource> {
  const resolved = await resolveMixSource(episodeId, filmId)
  db.update(schema.episodes)
    .set({ mixSourceMergeId: resolved.source.filmId, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))
    .run()
  return resolved
}
