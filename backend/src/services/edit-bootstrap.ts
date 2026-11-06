import { and, asc, desc, eq, isNull, max } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { EditWorkspaceMode } from './app-settings.js'
import { editSourceFromUrl } from './edit-media.js'
import {
  computeLayout,
  createEmptyEditPlan,
  createSingleClipPlan,
  editSyncHashOf,
  minimumClipMs,
  planHashOf,
  renderHashOf,
  type EditClip,
  type EditIssue,
  type EditPlanV1,
  type EditProjectSettings,
  type EditTransition,
} from './edit-plan.js'
import { parsePlanJson } from './edit-response.js'

export interface StoryboardAssembly {
  clips: EditClip[]
  transitions: EditTransition[]
  warnings: EditIssue[]
  materialCount: number
  skipped: number
}

function defaultTransform() {
  return { scale: 1, x: 0, y: 0, rotation: 0 as const, flipH: false, flipV: false }
}

function defaultFilter() {
  return { preset: 'none' as const, intensity: 100 }
}

export function hasStoryboardMedia(episodeId: number): boolean {
  const rows = db.select({
    videoUrl: schema.storyboards.videoUrl,
    composedVideoUrl: schema.storyboards.composedVideoUrl,
  }).from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .all()
  return rows.some((row) => Boolean(row.videoUrl || row.composedVideoUrl))
}

export async function assembleStoryboardClips(
  episodeId: number,
  project: EditProjectSettings,
  options: { transition?: 'cut' | 'dissolve' } = {},
): Promise<StoryboardAssembly> {
  const rows = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber), asc(schema.storyboards.id))
    .all()
  const clips: EditClip[] = []
  const warnings: EditIssue[] = []
  let skipped = 0

  for (const row of rows) {
    const url = row.videoUrl || row.composedVideoUrl || ''
    if (!url) {
      skipped += 1
      warnings.push({
        severity: 'warning',
        code: 'STORYBOARD_MISSING_VIDEO',
        path: `storyboards[${row.id}].video_url`,
        message: `分镜 ${row.storyboardNumber} 没有视频`,
      })
      continue
    }
    try {
      const source = await editSourceFromUrl({
        kind: 'storyboard',
        id: row.id,
        url,
        label: `分镜 ${row.storyboardNumber}`,
      })
      if (source.durationMs < minimumClipMs(project.fps)) {
        skipped += 1
        warnings.push({
          severity: 'warning',
          code: 'CLIP_TOO_SHORT',
          path: `storyboards[${row.id}]`,
          message: `分镜 ${row.storyboardNumber} 短于 3 帧`,
        })
        continue
      }
      clips.push({
        id: `clp_sb_${row.id}`,
        kind: 'video',
        source,
        sourceInMs: 0,
        sourceOutMs: source.durationMs,
        speed: 1,
        gapBeforeMs: 0,
        videoFadeInMs: 0,
        videoFadeOutMs: 0,
        transform: defaultTransform(),
        filter: defaultFilter(),
      })
    } catch (error) {
      skipped += 1
      warnings.push({
        severity: 'warning',
        code: 'MEDIA_MISSING',
        path: `storyboards[${row.id}].video_url`,
        message: error instanceof Error ? error.message : '分镜视频不可读',
      })
    }
  }

  const transitions: EditTransition[] = []
  if (options.transition === 'dissolve') {
    for (let index = 1; index < clips.length; index += 1) {
      transitions.push({
        id: `tr_${clips[index - 1].id}_${clips[index].id}`,
        fromClipId: clips[index - 1].id,
        toClipId: clips[index].id,
        type: 'dissolve',
        durationMs: 500,
      })
    }
  }

  return { clips, transitions, warnings, materialCount: clips.length, skipped }
}

export interface PersistBootstrapResult {
  revisionId: number | null
  draftVersion: number | null
  plan: EditPlanV1
  created: boolean
}

export function persistInitialEditPlan(input: {
  episodeId: number
  dramaId: number
  plan: EditPlanV1
  mode: EditWorkspaceMode
}): PersistBootstrapResult {
  if (input.mode !== 'on') {
    return { revisionId: null, draftVersion: null, plan: input.plan, created: false }
  }
  return db.transaction((tx) => {
    const existing = tx.select().from(schema.editRevisions)
      .where(and(
        eq(schema.editRevisions.episodeId, input.episodeId),
        eq(schema.editRevisions.isCurrent, true),
      ))
      .get()
    const existingPlan = parsePlanJson(existing?.planJson)
    if (existing && existingPlan) {
      const draft = tx.select().from(schema.episodeEditDrafts)
        .where(eq(schema.episodeEditDrafts.episodeId, input.episodeId))
        .get()
      return {
        revisionId: existing.id,
        draftVersion: draft?.version ?? null,
        plan: existingPlan,
        created: false,
      }
    }

    const ts = new Date().toISOString()
    const layout = computeLayout(input.plan)
    const planJson = JSON.stringify(input.plan)
    const planHash = planHashOf(input.plan)
    const syncHash = editSyncHashOf(input.plan)
    const maxRow = tx.select({ value: max(schema.editRevisions.revisionNo) })
      .from(schema.editRevisions)
      .where(eq(schema.editRevisions.episodeId, input.episodeId))
      .get()
    const revisionNo = Number(maxRow?.value ?? 0) + 1

    tx.update(schema.editRevisions)
      .set({ isCurrent: false })
      .where(and(
        eq(schema.editRevisions.episodeId, input.episodeId),
        eq(schema.editRevisions.isCurrent, true),
      ))
      .run()
    const revision = tx.insert(schema.editRevisions).values({
      episodeId: input.episodeId,
      revisionNo,
      planJson,
      planHash,
      editSyncHash: syncHash,
      renderHash: renderHashOf(input.plan),
      durationMs: layout.durationMs,
      clipCount: input.plan.clips.length,
      note: '自动初始化',
      isCurrent: true,
      createdAt: ts,
    }).returning().get()

    // episode_edit_drafts 在 episode_id 上有唯一索引。读路径只有在没有可解析的
    // 草稿计划时才会走到 bootstrap，因此这里残留的行要么是无法解析的损坏草稿，
    // 要么是孤立的草稿；在同一事务内先替换再写入，避免唯一约束让 GET 永久 500。
    tx.delete(schema.episodeEditDrafts)
      .where(eq(schema.episodeEditDrafts.episodeId, input.episodeId))
      .run()
    tx.insert(schema.episodeEditDrafts).values({
      episodeId: input.episodeId,
      dramaId: input.dramaId,
      planJson,
      planHash,
      editSyncHash: syncHash,
      version: 1,
      baseRevisionId: revision.id,
      createdAt: ts,
      updatedAt: ts,
    }).run()
    tx.update(schema.episodes).set({
      editRevisionId: revision.id,
      editPlanHash: planHash,
      editSyncHash: syncHash,
      editEnabled: true,
      updatedAt: ts,
    }).where(eq(schema.episodes.id, input.episodeId)).run()

    return {
      revisionId: revision.id,
      draftVersion: 1,
      plan: input.plan,
      created: true,
    }
  }, { behavior: 'immediate' })
}

export interface BootstrapInput {
  episodeId: number
  dramaId: number
  project: EditProjectSettings
  mode: EditWorkspaceMode
  episodeVideoUrl: string | null
  warnings: EditIssue[]
}

export interface BootstrapResult {
  plan: EditPlanV1
  source: 'storyboard' | 'merge' | 'episode-video' | 'empty'
  initializedRevisionId: number | null
  draftVersion: number | null
}

export async function bootstrapEditPlan(input: BootstrapInput): Promise<BootstrapResult> {
  if (input.mode === 'on') {
    const assembly = await assembleStoryboardClips(input.episodeId, input.project)
    input.warnings.push(...assembly.warnings)
    if (assembly.clips.length > 0) {
      const plan: EditPlanV1 = {
        ...createEmptyEditPlan(input.episodeId, input.project),
        clips: assembly.clips,
        transitions: assembly.transitions,
      }
      const persisted = persistInitialEditPlan({
        episodeId: input.episodeId,
        dramaId: input.dramaId,
        plan,
        mode: input.mode,
      })
      return {
        plan: persisted.plan,
        source: 'storyboard',
        // 并发首读时 persistInitialEditPlan 可能复用已落库的版本（created = false）。
        // 只要分镜 bootstrap 落到了某个版本，就必须回传该 id，让读路径重新加载草稿/版本。
        initializedRevisionId: persisted.revisionId,
        draftVersion: persisted.draftVersion,
      }
    }

    const merge = db.select().from(schema.videoMerges)
      .where(and(
        eq(schema.videoMerges.episodeId, input.episodeId),
        eq(schema.videoMerges.status, 'completed'),
        isNull(schema.videoMerges.deletedAt),
      ))
      .orderBy(desc(schema.videoMerges.createdAt), desc(schema.videoMerges.id))
      .get()
    if (merge?.mergedUrl) {
      try {
        const source = await editSourceFromUrl({
          kind: 'merge',
          id: merge.id,
          url: merge.mergedUrl,
          label: '既有合片',
        })
        return {
          plan: createSingleClipPlan(input.episodeId, source, input.project),
          source: 'merge',
          initializedRevisionId: null,
          draftVersion: null,
        }
      } catch (error) {
        input.warnings.push({
          severity: 'warning',
          code: 'MERGE_MEDIA_MISSING',
          path: 'video_merges.merged_url',
          message: error instanceof Error ? error.message : '合片不可读',
        })
      }
    }
  }

  if (input.episodeVideoUrl) {
    try {
      const source = await editSourceFromUrl({
        kind: 'episode-video',
        id: input.episodeId,
        url: input.episodeVideoUrl,
      })
      return {
        plan: createSingleClipPlan(input.episodeId, source, input.project),
        source: 'episode-video',
        initializedRevisionId: null,
        draftVersion: null,
      }
    } catch (error) {
      input.warnings.push({
        severity: 'warning',
        code: 'MEDIA_MISSING',
        path: 'episode.video_url',
        message: error instanceof Error ? error.message : '当前成片不可读',
      })
    }
  }

  return {
    plan: createEmptyEditPlan(input.episodeId, input.project),
    source: 'empty',
    initializedRevisionId: null,
    draftVersion: null,
  }
}
