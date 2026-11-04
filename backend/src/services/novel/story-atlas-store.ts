import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { now } from '../../utils/response.js'
import {
  StoryAtlasValidationError,
  normalizeTimelineEvents,
  normalizeWorldMap,
  parseTimelineEvents,
  parseWorldMap,
  serializeTimelineEvents,
  serializeWorldMap,
  type TimelineEvent,
  type WorldMapData,
} from './story-atlas.js'

export class StoryAtlasConflictError extends Error {
  readonly currentUpdatedAt: string | null
  constructor(currentUpdatedAt: string | null) {
    super('小说已被其他任务更新，请刷新后重试')
    this.name = 'StoryAtlasConflictError'
    this.currentUpdatedAt = currentUpdatedAt
  }
}

export class StoryAtlasNotFoundError extends Error {
  constructor() {
    super('小说不存在')
    this.name = 'StoryAtlasNotFoundError'
  }
}

function activeRow(novelId: number) {
  return db.select().from(schema.novels)
    .where(and(eq(schema.novels.id, novelId), isNull(schema.novels.deletedAt)))
    .get()
}

function requireRow(novelId: number) {
  const row = activeRow(novelId)
  if (!row) throw new StoryAtlasNotFoundError()
  return row
}

export function writeTimelineEvents(novelId: number, events: TimelineEvent[]): void {
  requireRow(novelId)
  db.update(schema.novels)
    .set({ timelineEvents: serializeTimelineEvents(events), updatedAt: now() })
    .where(eq(schema.novels.id, novelId))
    .run()
}

export function writeWorldMap(novelId: number, map: WorldMapData): void {
  requireRow(novelId)
  db.update(schema.novels)
    .set({ worldMap: serializeWorldMap(map), updatedAt: now() })
    .where(eq(schema.novels.id, novelId))
    .run()
}

export function saveStoryAtlas(
  novelId: number,
  patch: { timelineEvents?: unknown; worldMap?: unknown; baseUpdatedAt?: string | null },
) {
  if (patch.timelineEvents === undefined && patch.worldMap === undefined) {
    throw new StoryAtlasValidationError('timeline_events 或 world_map 至少提供一个')
  }
  return db.transaction((tx) => {
    const row = tx.select().from(schema.novels)
      .where(and(eq(schema.novels.id, novelId), isNull(schema.novels.deletedAt)))
      .get()
    if (!row) throw new StoryAtlasNotFoundError()
    if (patch.baseUpdatedAt !== undefined && patch.baseUpdatedAt !== null && patch.baseUpdatedAt !== row.updatedAt) {
      throw new StoryAtlasConflictError(row.updatedAt)
    }

    const warnings: string[] = []
    const currentMap = parseWorldMap(row.worldMap)
    let nextMap = currentMap
    if (patch.worldMap !== undefined) {
      const normalized = normalizeWorldMap(patch.worldMap, { strict: true })
      nextMap = normalized.data
      warnings.push(...normalized.warnings)
    }
    const placeIds = nextMap?.places.map((place) => place.id) ?? []

    let nextTimeline = parseTimelineEvents(row.timelineEvents)
    if (patch.timelineEvents !== undefined) {
      const normalized = normalizeTimelineEvents(patch.timelineEvents, {
        strict: true,
        maxChapter: row.numberOfChapters ?? 100,
        placeIds,
      })
      nextTimeline = normalized.events
      warnings.push(...normalized.warnings)
    } else if (patch.worldMap !== undefined) {
      const normalized = normalizeTimelineEvents(nextTimeline, {
        maxChapter: row.numberOfChapters ?? 100,
        placeIds,
      })
      nextTimeline = normalized.events
      warnings.push(...normalized.warnings)
    }

    const updatedAt = now()
    tx.update(schema.novels).set({
      timelineEvents: serializeTimelineEvents(nextTimeline),
      worldMap: nextMap ? serializeWorldMap(nextMap) : null,
      updatedAt,
    }).where(eq(schema.novels.id, novelId)).run()

    return { timelineEvents: nextTimeline, worldMap: nextMap, updatedAt, warnings }
  })
}
