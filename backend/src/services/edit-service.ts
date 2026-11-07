/**
 * 剪辑工作台状态（工程化，设计 §6.1、§6.11）：读优先级 草稿 → 当前版本 → 成片初始计划 → 空计划。
 * 工程解析：显式 project_id → episodes.edit_project_id → 当前成片工程 → 最新工程；
 * 无工程且 on 模式且有可用成片时自动打开第一个成片的工程并落初始计划与版本；
 * 无工程且 readonly 时返回成片临时计划（不落库）；无成片返回空态，不建工程。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getEditSettings } from './app-settings.js'
import {
  aspectOf,
  computeLayout,
  createEmptyEditPlan,
  dialogueSyncHashOf,
  projectSettingsForAspect,
  validateEditPlan,
  type EditAudioState,
  type EditIssue,
  type EditPlanV1,
} from './edit-plan.js'
import { getReadableEpisode } from './edit-access.js'
import { hasStoryboardMedia, persistInitialProjectPlan } from './edit-bootstrap.js'
import { buildFilmEditPlan } from './edit-film-plan.js'
import {
  currentRevisionFor,
  draftDirtyFor,
  draftFor,
} from './edit-draft-service.js'
import {
  listEditProjects,
  openProjectForFilm,
  projectResponse,
  resolveEditProject,
  type EditProjectRow,
} from './edit-project-service.js'
import { listFilms } from './film-hub.js'
import { layoutResponse, parsePlanJson, planHashes, revisionResponse } from './edit-response.js'
import { buildTimelineForPlan, placementsResponse } from './edit-timeline-data.js'
import { dialogPlacementsOf } from './edit-timeline.js'
import { existingProjectForEpisode } from './edit-mix-sync.js'

type EpisodeRow = typeof schema.episodes.$inferSelect
type EditWorkspaceMode = ReturnType<typeof getReadableEpisode>['mode']

function filmsOf(episodeId: number) {
  return listFilms(episodeId, 50).films.filter((film) => Boolean(film.url))
}

function mixStatusOf(episodeId: number, revision: { id: number } | null, hashes: { edit_sync_hash: string }, dialogueHash: string) {
  const mixRevision = db.select().from(schema.mixRevisions)
    .where(and(
      eq(schema.mixRevisions.episodeId, episodeId),
      eq(schema.mixRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.mixRevisions.createdAt))
    .get()

  const mixReasons: string[] = []
  if (mixRevision) {
    if (!mixRevision.editSyncHash) mixReasons.push('legacy_mix')
    else if (mixRevision.editSyncHash !== hashes.edit_sync_hash) mixReasons.push('timing_changed')
    if (mixRevision.dialogueSyncHash && mixRevision.dialogueSyncHash !== dialogueHash) {
      mixReasons.push('dialogue_changed')
    }
  }

  return {
    status: !mixRevision ? 'missing' : mixReasons.length ? 'stale' : 'aligned',
    reasons: mixReasons,
    edit_revision_id: revision?.id ?? null,
    mix_revision_id: mixRevision?.id ?? null,
    summary: null,
  }
}

function warningsResponse(warnings: EditIssue[]) {
  return warnings.map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path,
  }))
}

/** 编辑导出记录（设计 §5.2）：仅 kind=edit 且 render_mode=edit，软删过滤，时间倒序 */
function rendersOf(episodeId: number) {
  const items = db.select().from(schema.episodeExports)
    .where(and(
      eq(schema.episodeExports.episodeId, episodeId),
      eq(schema.episodeExports.kind, 'edit'),
      eq(schema.episodeExports.renderMode, 'edit'),
      isNull(schema.episodeExports.deletedAt),
    ))
    .orderBy(desc(schema.episodeExports.createdAt), desc(schema.episodeExports.id))
    .limit(10)
    .all()
    .map((row) => ({
      id: row.id,
      status: row.status,
      progress: row.progress ?? 0,
      output_url: row.outputUrl ?? null,
      preset: row.preset,
      subtitle_mode: row.subtitleMode ?? null,
      duration_ms: row.durationMs ?? null,
      size_bytes: row.sizeBytes ?? null,
      error: row.error ?? null,
      created_at: row.createdAt,
    }))
  return { latest: items[0] ?? null, items }
}

/** 能力位（设计 §5.2）：只解释模式、开关、工程可用性；不支持字段/磁盘/时长交给 dialog 与服务端 */
function capabilitiesOf(
  mode: EditWorkspaceMode,
  project: Pick<EditProjectRow, 'sourceMergeId'> | null,
  lock: { kind: string; owner: string; expires_at: string } | null,
) {
  const exportEnabled = getEditSettings().export.enabled
  let exportBlockedReason: string | null = null
  if (mode !== 'on') exportBlockedReason = '当前为只读模式，不能导出'
  else if (!exportEnabled) exportBlockedReason = '剪辑导出已关闭'
  else if (!project) exportBlockedReason = '还没有可导出的工程'
  else if (!project.sourceMergeId) exportBlockedReason = '旧版工程不支持导出，请先另存为成片工程'
  return {
    can_edit: mode === 'on',
    can_export: exportBlockedReason === null,
    export_blocked_reason: exportBlockedReason,
    lock,
  }
}

/** 最新可用的混音成片（kind='mix' completed，未删除）：aligned 时作为剪辑预览音轨 */
function latestMixFilmUrlOf(episodeId: number) {
  const row = db.select().from(schema.videoMerges)
    .where(and(
      eq(schema.videoMerges.episodeId, episodeId),
      eq(schema.videoMerges.kind, 'mix'),
      eq(schema.videoMerges.status, 'completed'),
      isNull(schema.videoMerges.deletedAt),
    ))
    .orderBy(desc(schema.videoMerges.createdAt), desc(schema.videoMerges.id))
    .get()
  return row?.mergedUrl?.trim() || ''
}

/** 单片段源（源成片/整集视频）：state.audio 的原声回退来源 */
function singleClipSourceOf(plan: EditPlanV1) {
  if (plan.clips.length !== 1) return null
  const kind = plan.clips[0].source.kind
  return kind === 'merge' || kind === 'episode-video' ? plan.clips[0] : null
}

/**
 * state.audio（设计 §6.9）：混音 aligned 且有混音成片 → mix（WebAudio 主时钟）；
 * 否则单片段源成片有原声 → video（reference_only = mix_status stale，视频即时钟）；都没有 → none。
 */
function audioStateOf(
  episodeId: number,
  mixStatus: { status: string; mix_revision_id: number | null },
  singleSource: EditPlanV1['clips'][number] | null,
  durationMs: number,
): EditAudioState {
  if (mixStatus.status === 'aligned') {
    const mixUrl = latestMixFilmUrlOf(episodeId)
    if (mixUrl) {
      return {
        mode: 'mix',
        url: mixUrl,
        reference_only: false,
        duration_ms: durationMs,
        mix_revision_id: mixStatus.mix_revision_id ?? null,
      }
    }
  }
  if (singleSource && singleSource.source.hasAudio) {
    return {
      mode: 'video',
      url: singleSource.source.url,
      reference_only: mixStatus.status === 'stale',
      duration_ms: durationMs,
      mix_revision_id: mixStatus.mix_revision_id ?? null,
    }
  }
  return { mode: 'none', reference_only: false, mix_revision_id: null }
}

/** 空态（无成片）：不建工程、不写草稿/版本。 */
function emptyStateOf(
  episode: EpisodeRow,
  mode: EditWorkspaceMode,
  projects: ReturnType<typeof listEditProjects>['items'],
  reason: 'NO_FILM',
) {
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId)).get()
  const plan = createEmptyEditPlan(episode.id, projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30))
  return {
    episode_id: episode.id,
    episode_number: episode.episodeNumber,
    enabled: true,
    mode,
    empty_reason: reason,
    project: null,
    projects,
    films: filmsOf(episode.id),
    legacy_project: false,
    draft: null,
    current_revision: null,
    current_revision_plan: null,
    plan,
    layout: layoutResponse(computeLayout(plan)),
    hashes: planHashes(plan),
    draft_dirty: false,
    mix_status: { status: 'missing', reasons: [], edit_revision_id: null, mix_revision_id: null, summary: null },
    renders: rendersOf(episode.id),
    audio: { mode: 'none', reference_only: false, mix_revision_id: null } satisfies EditAudioState,
    media_warnings: [],
    line_placements: placementsResponse([]),
    rough_cut_available: false,
    capabilities: capabilitiesOf(mode, null, null),
  }
}

/** readonly 无工程但有成片：返回临时成片计划，绝不落库、不建工程。 */
function tempReadonlyStateOf(
  episode: EpisodeRow,
  mode: EditWorkspaceMode,
  projects: ReturnType<typeof listEditProjects>['items'],
  plan: EditPlanV1,
  warnings: EditIssue[],
) {
  const timeline = buildTimelineForPlan(episode.id, plan)
  const placements = timeline.linePlacements
  for (const item of timeline.unmappedLines) {
    warnings.push({
      severity: 'warning',
      code: 'LINE_UNMAPPED',
      path: `line:${item.lineId}`,
      message: `台词未映射到片段（${item.reason}）`,
    })
  }
  const dialogueHash = dialogueSyncHashOf(dialogPlacementsOf(placements))
  const hashes = {
    ...planHashes(plan, dialogPlacementsOf(placements)),
    dialogue_sync_hash: dialogueHash,
  }
  const layout = computeLayout(plan)
  const mixStatus = mixStatusOf(episode.id, null, hashes, dialogueHash)
  const singleSource = singleClipSourceOf(plan)
  return {
    episode_id: episode.id,
    episode_number: episode.episodeNumber,
    enabled: true,
    mode,
    empty_reason: null,
    project: null,
    projects,
    films: filmsOf(episode.id),
    legacy_project: false,
    draft: null,
    current_revision: null,
    current_revision_plan: null,
    plan,
    layout: layoutResponse(layout),
    hashes,
    draft_dirty: false,
    mix_status: mixStatus,
    renders: rendersOf(episode.id),
    audio: audioStateOf(episode.id, mixStatus, singleSource, layout.durationMs),
    media_warnings: warningsResponse(warnings),
    line_placements: placementsResponse(placements),
    rough_cut_available: false,
    capabilities: capabilitiesOf(mode, null, null),
  }
}

export async function getEpisodeEditState(
  episodeId: number,
  projectIdParam?: number | null,
  options: { readOnly?: boolean } = {},
) {
  // 404（分集不存在）/ 403（开关关闭）先于任何工程解析与成片自动打开，顺序与文案由 getReadableEpisode 保证。
  const { episode, mode } = getReadableEpisode(episodeId)
  const readOnly = options.readOnly === true

  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId))
    .get()
  const projects = listEditProjects(episodeId).items

  // 只读：显式 project_id 仅做归属校验；其余只解析既有工程，绝不自动打开/创建
  let project: EditProjectRow | null = readOnly
    ? (projectIdParam
        ? resolveEditProject(episodeId, projectIdParam)
        : existingProjectForEpisode(episodeId))
    : resolveEditProject(episodeId, projectIdParam ?? null)
  const warnings: EditIssue[] = []

  if (!project) {
    const films = filmsOf(episode.id)
    if (films.length > 0) {
      if (mode === 'on' && !readOnly) {
        project = openProjectForFilm(episodeId, films[0].id).project
      } else {
        // readonly：有成片但无工程 → 临时成片计划，不建工程、不落库
        const filmRow = db.select().from(schema.videoMerges)
          .where(eq(schema.videoMerges.id, films[0].id)).get()
        const built = filmRow
          ? await buildFilmEditPlan({ episodeId: episode.id, film: filmRow, warnings })
          : null
        if (built) return tempReadonlyStateOf(episode, mode, projects, built, warnings)
        return emptyStateOf(episode, mode, projects, 'NO_FILM')
      }
    }
  }
  if (!project) return emptyStateOf(episode, mode, projects, 'NO_FILM')

  let draft = draftFor(project.id)
  let revision = currentRevisionFor(project.id)

  let plan = parsePlanJson(draft?.planJson)
  if (draft && !plan) {
    warnings.push({
      severity: 'warning',
      code: 'DRAFT_INVALID',
      path: 'draft.plan_json',
      message: '草稿计划损坏，已忽略',
    })
  }
  let revisionPlan = parsePlanJson(revision?.planJson)
  if (revision && !revisionPlan) {
    warnings.push({
      severity: 'warning',
      code: 'REVISION_INVALID',
      path: 'revision.plan_json',
      message: '版本计划损坏，已忽略',
    })
  }
  if (!plan) plan = revisionPlan

  if (!plan) {
    const projectSettings = projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30)
    if (project.sourceMergeId && project.sourceUrl) {
      const filmRow = db.select().from(schema.videoMerges)
        .where(eq(schema.videoMerges.id, project.sourceMergeId))
        .get()
      if (filmRow) {
        const built = await buildFilmEditPlan({
          episodeId: episode.id,
          film: filmRow,
          warnings,
        })
        if (built) {
          if (readOnly) {
            plan = built
          } else {
            const persisted = persistInitialProjectPlan({
              episodeId: episode.id,
              dramaId: episode.dramaId,
              projectId: project.id,
              plan: built,
              mode,
            })
            plan = persisted.plan
            // 成片初始计划可能新建版本（并发首读时复用已落库版本）；
            // 只要落到了某个版本，就必须重新读取，否则会错误地报告 current_revision: null。
            if (persisted.revisionId) {
              draft = draftFor(project.id)
              revision = currentRevisionFor(project.id)
              revisionPlan = parsePlanJson(revision?.planJson)
            }
          }
        }
      }
    }
    if (!plan) plan = createEmptyEditPlan(episode.id, projectSettings)
  } else {
    warnings.push(...validateEditPlan(plan))
  }

  const timeline = buildTimelineForPlan(episodeId, plan)
  const placements = timeline.linePlacements
  const dialogueHash = dialogueSyncHashOf(dialogPlacementsOf(placements))
  for (const item of timeline.unmappedLines) {
    warnings.push({
      severity: 'warning',
      code: 'LINE_UNMAPPED',
      path: `line:${item.lineId}`,
      message: `台词未映射到片段（${item.reason}）`,
    })
  }

  const layout = computeLayout(plan)
  const hashes = {
    ...planHashes(plan, dialogPlacementsOf(placements)),
    dialogue_sync_hash: dialogueHash,
  }

  const draftDirty = draftDirtyFor(project.id)

  const lockRow = db.select().from(schema.episodeLocks)
    .where(eq(schema.episodeLocks.episodeId, episodeId))
    .get()
  const lock = lockRow && Date.parse(lockRow.expiresAt) > Date.now()
    ? { kind: lockRow.kind, owner: lockRow.owner, expires_at: lockRow.expiresAt }
    : null

  const singleSource = singleClipSourceOf(plan)
  const mixStatus = mixStatusOf(episodeId, revision, hashes, dialogueHash)
  const audio = audioStateOf(episodeId, mixStatus, singleSource, layout.durationMs)

  return {
    episode_id: episode.id,
    episode_number: episode.episodeNumber,
    enabled: true,
    mode,
    empty_reason: null,
    project: projectResponse(project),
    projects,
    legacy_project: !project.sourceMergeId,
    draft: draft
      ? {
          plan: parsePlanJson(draft.planJson),
          version: draft.version,
          updated_at: draft.updatedAt,
        }
      : null,
    current_revision: revision ? revisionResponse(revision) : null,
    current_revision_plan: revisionPlan,
    plan,
    layout: layoutResponse(layout),
    hashes,
    draft_dirty: draftDirty,
    mix_status: mixStatus,
    renders: rendersOf(episode.id),
    audio,
    media_warnings: warningsResponse(warnings),
    line_placements: placementsResponse(placements),
    rough_cut_available: !project.sourceMergeId && hasStoryboardMedia(episodeId),
    capabilities: capabilitiesOf(mode, project, lock),
  }
}
