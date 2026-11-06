/**
 * 剪辑导出（设计 §6.10）：
 * - 启动即返回 export_id，渲染在后台继续（RUNNING 集合 + 台账 status 双保险防同工程并发）；
 * - 产物落在项目存储 episodes/<episodeId>/exports/<exportId>/ 下（与拼接/混音导出同一台账 episode_exports）；
 * - 完成后把成片投影进成片中心（video_merges，kind=edit/origin=export），
 *   set_current 时经 film-hub 收口设为当前成片；
 * - 草稿领先于当前版本时自动创建「导出里程碑」版本。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getReadableEpisode } from './edit-access.js'
import { EditWorkspaceError } from './edit-errors.js'
import { loadProjectPlan, currentRevisionFor } from './edit-draft-service.js'
import { requireEditProject, type EditProjectRow } from './edit-project-service.js'
import {
  computeLayout,
  editSyncHashOf,
  planHashOf,
  validateEditPlan,
  type EditPlanV1,
} from './edit-plan.js'
import { buildEditAss, buildEditSrt } from './edit-subtitle-ass.js'
import { renderEditVideo } from './edit-render-plan.js'
import { setCurrentFilm } from './film-hub.js'
import { createEditRevision } from './edit-revision-service.js'
import { projectStorageRelative, projectSubdirPath } from './project-storage.js'

const EDIT_PRESETS = new Set(['vertical-hd', 'horizontal-hd', 'vertical-high'])
const SUBTITLE_MODES = new Set(['burn', 'soft', 'none'])
const RUNNING_STATUSES = ['pending', 'running', 'rendering']
/** project_id 级进程内并发守卫（与台账 status 双保险） */
const RUNNING = new Set<number>()

function now(): string {
  return new Date().toISOString()
}

/**
 * 模块加载时收尾上次进程遗留的剪辑导出（kind=edit 的 pending/running/rendering），
 * 语义与 export-service.recoverInterruptedExports 一致：标为 failed，
 * 避免 UI 永远转圈或新导出被 EXPORT_ALREADY_RUNNING 永久挡住。
 */
export function recoverInterruptedEditExports(): void {
  try {
    db.update(schema.episodeExports)
      .set({ status: 'failed', error: '服务重启，任务已中断', finishedAt: now() })
      .where(and(
        eq(schema.episodeExports.kind, 'edit'),
        inArray(schema.episodeExports.status, RUNNING_STATUSES),
      ))
      .run()
  } catch {
    /* 数据库尚未就绪时忽略 */
  }
}

recoverInterruptedEditExports()

function defaultFilmTitle(episodeNumber: number | null, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const time = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  return `第 ${episodeNumber ?? '-'} 集 剪辑成片（${time}）`
}

export async function startEditExport(episodeId: number, body: {
  project_id?: unknown
  preset?: unknown
  subtitle_mode?: unknown
  set_current?: unknown
  title?: unknown
  base_version?: unknown
}): Promise<{ exportId: number }> {
  getReadableEpisode(episodeId)
  const projectId = Number(body.project_id)
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new EditWorkspaceError(400, 'EDIT_PROJECT_ID', '缺少有效的 project_id')
  }
  const project = requireEditProject(episodeId, projectId)
  const preset = String(body.preset ?? '')
  if (!EDIT_PRESETS.has(preset)) {
    throw new EditWorkspaceError(400, 'EDIT_PRESET_INVALID', '导出预设无效')
  }
  const subtitleMode = body.subtitle_mode === undefined || body.subtitle_mode === null
    ? 'burn'
    : String(body.subtitle_mode)
  if (!SUBTITLE_MODES.has(subtitleMode)) {
    throw new EditWorkspaceError(400, 'EDIT_SUBTITLE_MODE_INVALID', '字幕模式必须为 burn / soft / none')
  }
  if (!project.sourceMergeId) {
    throw new EditWorkspaceError(400, 'EDIT_LEGACY_EXPORT', '旧版工程不支持导出，请先另存为成片工程')
  }

  const draft = db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.projectId, project.id)).get()
  const draftVersion = draft?.version ?? 0
  if (Number(body.base_version) !== draftVersion) {
    throw new EditWorkspaceError(409, 'EDIT_VERSION_CONFLICT', '计划已更新，请刷新后重试')
  }

  const runningRow = db.select().from(schema.episodeExports)
    .where(and(
      eq(schema.episodeExports.kind, 'edit'),
      inArray(schema.episodeExports.status, RUNNING_STATUSES),
      isNull(schema.episodeExports.deletedAt),
    )).all()
    .find((row) => row.projectId === project.id)
  if (runningRow || RUNNING.has(project.id)) {
    throw new EditWorkspaceError(409, 'EXPORT_ALREADY_RUNNING', '该工程已有导出任务进行中')
  }

  const plan = loadProjectPlan(project)
  const blocking = validateEditPlan(plan).find((issue) => issue.severity === 'error')
  if (blocking) {
    throw new EditWorkspaceError(400, 'EDIT_PLAN_INVALID', `计划无法导出：${blocking.message}`)
  }

  // 草稿领先于版本时自动创建里程碑版本（设计 6.10 流程 3）
  const currentRevision = currentRevisionFor(project.id)
  let revisionId = currentRevision?.id ?? null
  let revisionNo = currentRevision?.revisionNo ?? 0
  if (!currentRevision || currentRevision.planHash !== planHashOf(plan)) {
    const created = createEditRevision(project, { note: '导出里程碑', plan })
    revisionId = created.revision.id
    revisionNo = created.revision.revision_no ?? 0
  }

  const set_current = body.set_current === true
  const title = typeof body.title === 'string' && body.title.trim()
    ? body.title.trim().slice(0, 200)
    : null
  const exportRow = db.insert(schema.episodeExports).values({
    episodeId,
    kind: 'edit',
    preset,
    status: 'pending',
    progress: 0,
    projectId: project.id,
    sourceMergeId: project.sourceMergeId,
    editRevisionId: revisionId,
    editPlanHash: planHashOf(plan),
    editSyncHash: editSyncHashOf(plan),
    subtitleMode,
    renderMode: 'edit',
    paramsJson: JSON.stringify({ set_current, title }),
    isCurrent: false,
    createdAt: now(),
  }).returning().get()

  void runEditExport({
    exportId: exportRow.id,
    episodeId,
    project,
    plan,
    subtitleMode: subtitleMode as 'burn' | 'soft' | 'none',
    preset,
    setCurrent: set_current,
    title,
    revisionId,
    revisionNo,
  })
  return { exportId: exportRow.id }
}

async function runEditExport(ctx: {
  exportId: number
  episodeId: number
  project: EditProjectRow
  plan: EditPlanV1
  subtitleMode: 'burn' | 'soft' | 'none'
  preset: string
  setCurrent: boolean
  title: string | null
  revisionId: number | null
  revisionNo: number
}): Promise<void> {
  RUNNING.add(ctx.project.id)
  const patch = (values: Record<string, unknown>) =>
    db.update(schema.episodeExports).set(values as never)
      .where(eq(schema.episodeExports.id, ctx.exportId)).run()
  try {
    patch({ status: 'rendering', progress: 5, error: null })
    const layout = computeLayout(ctx.plan)
    const episode = db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, ctx.episodeId)).get()
    if (!episode) throw new Error('分集不存在，无法导出')

    // 产物目录：项目存储 episodes/<episodeId>/exports/<exportId>/（与拼接/混音导出一致）
    const subDir = `episodes/${ctx.episodeId}/exports/${ctx.exportId}`
    const dirAbs = projectSubdirPath(ctx.project.dramaId, subDir)
    await fsp.mkdir(dirAbs, { recursive: true })
    const baseName = `第${episode.episodeNumber ?? '-'}集-剪辑-v${ctx.revisionNo}-${ctx.exportId}`
    const outputRel = projectStorageRelative(ctx.project.dramaId, subDir, `${baseName}.mp4`)
    const outputAbs = path.join(dirAbs, `${baseName}.mp4`)

    let assPath: string | undefined
    let srtPath: string | undefined
    if (ctx.subtitleMode === 'burn') {
      assPath = path.join(dirAbs, `${baseName}.ass`)
      srtPath = path.join(dirAbs, `${baseName}.srt`)
      await fsp.writeFile(assPath, buildEditAss(ctx.plan), 'utf8')
      await fsp.writeFile(srtPath, buildEditSrt(ctx.plan), 'utf8')
    } else if (ctx.subtitleMode === 'soft') {
      srtPath = path.join(dirAbs, `${baseName}.srt`)
      await fsp.writeFile(srtPath, buildEditSrt(ctx.plan), 'utf8')
    }

    const { durationMs } = await renderEditVideo({
      plan: ctx.plan,
      outputPath: outputAbs,
      subtitleMode: ctx.subtitleMode,
      assPath,
      srtPath,
      onProgress: (pct) => patch({ progress: Math.max(10, Math.min(95, Math.round(pct))) }),
    })

    const frameMs = 1000 / Math.max(1, ctx.plan.project.fps)
    if (Math.abs(durationMs - layout.durationMs) > frameMs) {
      throw new Error(`导出时长偏差超过 1 帧：${durationMs}ms vs ${layout.durationMs}ms`)
    }
    const stat = await fsp.stat(outputAbs)
    patch({
      status: 'completed',
      progress: 100,
      outputUrl: outputRel,
      durationMs,
      sizeBytes: stat.size,
      fileName: `${baseName}.mp4`,
      finishedAt: now(),
    })

    // 投影成片（设计 6.10 流程 8–9）
    const filmTitle = ctx.title || defaultFilmTitle(episode.episodeNumber, new Date())
    const subtitleUrl = ctx.subtitleMode === 'soft'
      ? projectStorageRelative(ctx.project.dramaId, subDir, `${baseName}.srt`)
      : null
    const film = db.insert(schema.videoMerges).values({
      episodeId: ctx.episodeId,
      dramaId: ctx.project.dramaId,
      title: filmTitle,
      provider: 'edit',
      model: ctx.preset,
      kind: 'edit',
      origin: 'export',
      status: 'completed',
      mergedUrl: outputRel,
      duration: Math.round(durationMs),
      sourceMergeId: ctx.project.sourceMergeId,
      exportId: ctx.exportId,
      editRevisionId: ctx.revisionId,
      planHash: planHashOf(ctx.plan),
      subtitleUrl,
      subtitleBurned: ctx.subtitleMode === 'burn',
      createdAt: now(),
      completedAt: now(),
    }).returning().get()
    if (ctx.setCurrent) await setCurrentFilm(ctx.episodeId, film.id)
  } catch (cause) {
    patch({
      status: 'failed',
      error: cause instanceof Error ? cause.message.slice(0, 2000) : '导出失败',
      finishedAt: now(),
    })
  } finally {
    RUNNING.delete(ctx.project.id)
  }
}

export function getEditExportStatus(episodeId: number, exportId: number) {
  const row = db.select().from(schema.episodeExports)
    .where(and(
      eq(schema.episodeExports.id, exportId),
      eq(schema.episodeExports.episodeId, episodeId),
      isNull(schema.episodeExports.deletedAt),
    ))
    .get()
  if (!row) throw new EditWorkspaceError(404, 'EXPORT_NOT_FOUND', '导出任务不存在')
  return {
    id: row.id,
    episode_id: row.episodeId,
    kind: row.kind,
    preset: row.preset,
    status: row.status,
    progress: row.progress ?? 0,
    subtitle_mode: row.subtitleMode ?? null,
    render_mode: row.renderMode ?? null,
    output_url: row.outputUrl ?? null,
    duration_ms: row.durationMs ?? null,
    size_bytes: row.sizeBytes ?? null,
    error: row.error ?? null,
    project_id: row.projectId ?? null,
    source_merge_id: row.sourceMergeId ?? null,
    edit_revision_id: row.editRevisionId ?? null,
    created_at: row.createdAt,
    finished_at: row.finishedAt ?? null,
  }
}
