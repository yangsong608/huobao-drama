import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { EditWorkspaceError } from './edit-errors.js'
import { parsePlanJson } from './edit-response.js'

type DraftRow = typeof schema.episodeEditDrafts.$inferSelect

/**
 * 409 冲突体：当前草稿版本、当前计划与更新时间。
 * 草稿计划损坏时回退到当前版本的计划，保证客户端总能拿到可对比的基线。
 */
export function conflictDataFor(episodeId: number, draft: DraftRow | undefined) {
  const revision = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.episodeId, episodeId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .get()
  return {
    current_version: draft?.version ?? 0,
    current_plan: parsePlanJson(draft?.planJson) ?? parsePlanJson(revision?.planJson),
    updated_at: draft?.updatedAt ?? null,
  }
}

export function throwVersionConflict(episodeId: number, draft: DraftRow | undefined): never {
  throw new EditWorkspaceError(
    409,
    'EDIT_VERSION_CONFLICT',
    '此集已在另一个窗口修改',
    conflictDataFor(episodeId, draft),
  )
}
