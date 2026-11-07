/**
 * 剪辑导出（设计 §6.10）：
 * - 启动即返回 export_id，渲染在后台继续（RUNNING 集合 + 台账 status 双保险防同工程并发）；
 * - 产物落在项目存储 episodes/<episodeId>/exports/<exportId>/ 下（与拼接/混音导出同一台账 episode_exports）；
 * - 完成后把成片投影进成片中心（video_merges，kind=edit/origin=export），
 *   set_current 时经 film-hub 收口设为当前成片；
 * - 草稿领先于当前版本时自动创建「导出里程碑」版本。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWritableEpisode } from './edit-access.js'
import { EditWorkspaceError } from './edit-errors.js'
import { loadProjectPlan, currentRevisionFor } from './edit-draft-service.js'
import { requireEditProject, type EditProjectRow } from './edit-project-service.js'
import { getEditSettings } from './app-settings.js'
import {
  aspectOf,
  computeLayout,
  dialogueSyncHashOf,
  editSyncHashOf,
  planHashOf,
  sourceFingerprintOf,
  subtitleHashOf,
  validateEditPlan,
  type EditPlanV1,
} from './edit-plan.js'
import {
  EXPORT_PRESETS,
  resolveEditExportPreset,
  type EditExportPresetKey,
} from './export-presets.js'
import { buildEditAss, buildEditSrt } from './edit-subtitle-ass.js'
import { blockingFeaturesOf, renderEditVideo } from './edit-render-plan.js'
import { buildTimelineForPlan } from './edit-timeline-data.js'
import { dialogPlacementsOf } from './edit-timeline.js'
import { setCurrentFilm } from './film-hub.js'
import { createEditRevision } from './edit-revision-service.js'
import { projectStorageRelative, projectSubdirPath } from './project-storage.js'
import { estimateExportBytes } from './export-render.js'
import { mixSyncStatusOf } from './edit-mix-sync.js'
import { compileEpisodePlan, type MixPlan } from './mix-plan.js'
import { renderMixAudio } from './mix-render.js'
import type { MixSourceWarning } from './mix-source.js'
import {
  assertCapacity,
  ExportCapacityError,
  formatBytes,
  freeBytesForDrama,
} from './export-capacity.js'
import { reuseKeyOf, markFailed, removeExportFiles } from './export-service.js'
import { getAbsolutePath } from '../utils/storage.js'

const SUBTITLE_MODES = new Set(['burn', 'soft', 'none'])
const AUDIO_SOURCES = new Set(['auto', 'mix', 'clip', 'silent'])
/** 剪辑导出复用时的额外忽略键：标题与“设为当前”是副作用，*Requested 仅用于诊断 */
const EDIT_REUSE_IGNORED_PARAMS = ['title', 'set_current', 'autoRequested', 'audioRequested']
const RUNNING_STATUSES = ['pending', 'running', 'rendering']
/** project_id 级进程内并发守卫（与台账 status 双保险） */
const RUNNING = new Set<number>()
/** 每个编辑导出记录持有的渲染控制器：取消时直接中止其 FFmpeg 子进程 */
const editJobs = new Map<number, AbortController>()
/** 进程内全局并发计数；多进程部署不在本期范围，计数只在当前进程有效 */
let activeEditCount = 0

function assertEditConcurrency(): void {
  const { concurrency } = getEditSettings().export
  if (activeEditCount >= concurrency) {
    throw new EditWorkspaceError(409, 'EDIT_EXPORT_CONCURRENCY', '导出任务已达并发上限，请等待其他导出完成')
  }
}

function editRecordOf(exportId: number) {
  return db.select().from(schema.episodeExports)
    .where(and(
      eq(schema.episodeExports.id, exportId),
      eq(schema.episodeExports.kind, 'edit'),
      isNull(schema.episodeExports.deletedAt),
    ))
    .get()
}

function requireEditRecord(exportId: number) {
  const row = editRecordOf(exportId)
  if (!row) throw new EditWorkspaceError(404, 'EXPORT_NOT_FOUND', '导出任务不存在')
  return row
}

function removeEditExportDir(episodeId: number, exportId: number): void {
  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) return
  removeExportFiles(projectSubdirPath(episode.dramaId, `episodes/${episode.id}/exports/${exportId}`))
}

function now(): string {
  return new Date().toISOString()
}

type EffectiveAudioSource = 'mix' | 'clip' | 'silent'

interface ResolvedExportAudio {
  effective: EffectiveAudioSource
  mixRevisionId: number | null
  planRevisionId: number | null
}

function audioNotAlignedError(): EditWorkspaceError {
  return new EditWorkspaceError(
    409,
    'EDIT_MIX_NOT_ALIGNED',
    '混音与当前剪辑计划未对齐，请先在混音台保存新版本，或改选剪辑原声/静音',
  )
}

/**
 * E3-3：audio_source 在服务端解析为实际管线。
 * mix_status 与剪辑台同源（mixSyncStatusOf），aligned 还要求哈希属于本次导出的计划，
 * 避免工程切换后误用另一份计划的混音；显式 mix 未对齐直接 409，不降级。
 */
function resolveExportAudio(input: {
  episodeId: number
  plan: EditPlanV1
  planHash: string
  requested: string
  requireAlignedMix: boolean
}): ResolvedExportAudio {
  const status = mixSyncStatusOf(input.episodeId)
  const aligned = status.status === 'aligned'
    && status.edit_plan_hash === input.planHash
    && status.mix_revision_id != null
  const planRevisionId = status.mix_revision_id
  if (input.requested === 'mix') {
    if (!aligned) throw audioNotAlignedError()
    return { effective: 'mix', mixRevisionId: status.mix_revision_id!, planRevisionId }
  }
  if (input.requested === 'clip') {
    return { effective: 'clip', mixRevisionId: null, planRevisionId }
  }
  if (input.requested === 'silent') {
    return { effective: 'silent', mixRevisionId: null, planRevisionId }
  }
  if (aligned) return { effective: 'mix', mixRevisionId: status.mix_revision_id!, planRevisionId }
  if (input.requireAlignedMix) throw audioNotAlignedError()
  const hasClipAudio = input.plan.clips.some((clip) => Boolean(clip.source?.hasAudio))
  return { effective: hasClipAudio ? 'clip' : 'silent', mixRevisionId: null, planRevisionId }
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
  audio_source?: unknown
  set_current?: unknown
  title?: unknown
  base_version?: unknown
}, overrides: { freeBytes?: number | null } = {}): Promise<{
  exportId: number
  reused: boolean
  sourceWarnings: MixSourceWarning[]
}> {
  getWritableEpisode(episodeId)
  if (!getEditSettings().export.enabled) {
    throw new EditWorkspaceError(409, 'EDIT_EXPORT_DISABLED', '剪辑导出已关闭')
  }
  const projectId = Number(body.project_id)
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new EditWorkspaceError(400, 'EDIT_PROJECT_ID', '缺少有效的 project_id')
  }
  const project = requireEditProject(episodeId, projectId)
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, project.dramaId)).get()
  const requestedPreset = typeof body.preset === 'string' && body.preset ? body.preset : 'auto'
  let preset: EditExportPresetKey
  try {
    preset = resolveEditExportPreset(requestedPreset, aspectOf(drama?.aspectRatio))
  } catch {
    throw new EditWorkspaceError(400, 'EDIT_PRESET_INVALID', '导出预设无效')
  }
  const subtitleMode = body.subtitle_mode === undefined || body.subtitle_mode === null
    ? 'burn'
    : String(body.subtitle_mode)
  if (!SUBTITLE_MODES.has(subtitleMode)) {
    throw new EditWorkspaceError(400, 'EDIT_SUBTITLE_MODE_INVALID', '字幕模式必须为 burn / soft / none')
  }
  const audioRequested = body.audio_source === undefined || body.audio_source === null
    ? 'auto'
    : String(body.audio_source)
  if (!AUDIO_SOURCES.has(audioRequested)) {
    throw new EditWorkspaceError(400, 'EDIT_AUDIO_SOURCE_INVALID', '音频来源必须为 auto / mix / clip / silent')
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

  const unsupported = blockingFeaturesOf(plan)
  if (unsupported.length) {
    throw new EditWorkspaceError(
      422,
      'EDIT_RENDER_UNSUPPORTED',
      `计划包含暂不支持导出的字段：${unsupported.map((item) => item.message).join('；')}`,
      { issues: unsupported },
    )
  }

  const layout = computeLayout(plan)
  const { maxDurationSec } = getEditSettings().export
  if (layout.durationMs > maxDurationSec * 1000) {
    throw new EditWorkspaceError(
      422,
      'EDIT_DURATION_LIMIT',
      `成片时长 ${Math.ceil(layout.durationMs / 1000)} 秒，超过上限 ${maxDurationSec} 秒`,
    )
  }

  const planHash = planHashOf(plan)
  const sourceVideoHash = sourceFingerprintOf(plan)
  const subtitleHash = subtitleHashOf(plan)
  const editSyncHash = editSyncHashOf(plan)
  const timeline = buildTimelineForPlan(episodeId, plan)
  const dialogueSyncHash = dialogueSyncHashOf(dialogPlacementsOf(timeline.linePlacements))
  const resolvedAudio = resolveExportAudio({
    episodeId,
    plan,
    planHash,
    requested: audioRequested,
    requireAlignedMix: getEditSettings().export.requireAlignedMix === true,
  })
  const { mixRevisionId, planRevisionId } = resolvedAudio
  const effectiveAudio = resolvedAudio.effective

  const set_current = body.set_current === true
  const title = typeof body.title === 'string' && body.title.trim()
    ? body.title.trim().slice(0, 200)
    : null
  const paramsJson = JSON.stringify({
    renderMode: 'edit',
    audioSource: effectiveAudio,
    audioRequested,
    autoRequested: requestedPreset,
    subtitleMode,
    setCurrent: set_current,
    preset,
    title,
  })
  const reuseOptions = { ignoreParams: EDIT_REUSE_IGNORED_PARAMS }
  const reuseKey = reuseKeyOf({
    kind: 'edit',
    preset,
    planHash,
    sourceVideoHash,
    subtitleHash,
    paramsJson,
    mixRevisionId,
  }, reuseOptions)
  const reusable = db.select().from(schema.episodeExports)
    .where(and(
      eq(schema.episodeExports.episodeId, episodeId),
      eq(schema.episodeExports.kind, 'edit'),
      eq(schema.episodeExports.renderMode, 'edit'),
      eq(schema.episodeExports.status, 'completed'),
      isNull(schema.episodeExports.deletedAt),
      eq(schema.episodeExports.projectId, project.id),
      eq(schema.episodeExports.preset, preset),
      eq(schema.episodeExports.subtitleMode, subtitleMode),
      eq(schema.episodeExports.editPlanHash, planHash),
      mixRevisionId == null
        ? isNull(schema.episodeExports.mixRevisionId)
        : eq(schema.episodeExports.mixRevisionId, mixRevisionId),
    ))
    .orderBy(desc(schema.episodeExports.createdAt), desc(schema.episodeExports.id))
    .get()
  if (reusable?.outputUrl
    && reuseKeyOf({
      kind: reusable.kind,
      preset: reusable.preset,
      planHash: reusable.editPlanHash,
      sourceVideoHash: reusable.sourceVideoHash,
      subtitleHash: reusable.subtitleHash,
      paramsJson: reusable.paramsJson,
      mixRevisionId: reusable.mixRevisionId,
    }, reuseOptions) === reuseKey
    && fs.existsSync(getAbsolutePath(reusable.outputUrl))) {
    if (set_current) {
      const film = db.select().from(schema.videoMerges)
        .where(and(
          eq(schema.videoMerges.exportId, reusable.id),
          isNull(schema.videoMerges.deletedAt),
        ))
        .orderBy(desc(schema.videoMerges.id))
        .get()
      if (film) await setCurrentFilm(episodeId, film.id)
    }
    return { exportId: reusable.id, reused: true, sourceWarnings: [] }
  }

  // 复用直接返回已有成片，不占用渲染并发；只有真正新建渲染任务才受全局上限约束
  assertEditConcurrency()

  const presetSpec = EXPORT_PRESETS[preset]
  const requiredBytes = estimateExportBytes('video', layout.durationMs, presetSpec)
    + estimateExportBytes('mix', layout.durationMs, presetSpec)
  const freeBytes = overrides.freeBytes !== undefined
    ? overrides.freeBytes
    : freeBytesForDrama(project.dramaId)
  try {
    assertCapacity(requiredBytes, freeBytes)
  } catch (error) {
    if (error instanceof ExportCapacityError) {
      throw new EditWorkspaceError(
        507,
        'EDIT_DISK_FULL',
        `磁盘空间不足：预计需要 ${formatBytes(error.requiredBytes)}，剩余 ${formatBytes(error.freeBytes)}`,
      )
    }
    throw error
  }

  // 混音分支启动时编译一次：启动响应需要降级告警，运行阶段复用同一份计划
  let mixPlan: MixPlan | undefined
  let sourceWarnings: MixSourceWarning[] = []
  if (effectiveAudio === 'mix') {
    const compiled = await compileEpisodePlan(episodeId, project.dramaId)
    mixPlan = compiled.plan
    sourceWarnings = compiled.warnings
    // 编译是异步的：期间可能有同工程导出抢先登记，插入前必须重新确认互斥
    const busyAfterCompile = db.select().from(schema.episodeExports)
      .where(and(
        eq(schema.episodeExports.kind, 'edit'),
        inArray(schema.episodeExports.status, RUNNING_STATUSES),
        isNull(schema.episodeExports.deletedAt),
      )).all()
      .find((row) => row.projectId === project.id)
    if (busyAfterCompile || RUNNING.has(project.id)) {
      throw new EditWorkspaceError(409, 'EXPORT_ALREADY_RUNNING', '该工程已有导出任务进行中')
    }
  }

  // 草稿领先于版本时自动创建里程碑版本（设计 6.10 流程 3）
  const currentRevision = currentRevisionFor(project.id)
  let revisionId = currentRevision?.id ?? null
  let revisionNo = currentRevision?.revisionNo ?? 0
  if (!currentRevision || currentRevision.planHash !== planHash) {
    const created = createEditRevision(project, { note: '导出里程碑', plan })
    revisionId = created.revision.id
    revisionNo = created.revision.revision_no ?? 0
  }

  const exportRow = db.insert(schema.episodeExports).values({
    episodeId,
    kind: 'edit',
    preset,
    status: 'pending',
    progress: 0,
    projectId: project.id,
    sourceMergeId: project.sourceMergeId,
    editRevisionId: revisionId,
    planRevisionId,
    mixRevisionId,
    editPlanHash: planHash,
    editSyncHash,
    dialogueSyncHash,
    subtitleHash,
    sourceVideoHash,
    subtitleMode,
    renderMode: 'edit',
    paramsJson,
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
    audio: effectiveAudio,
    mixPlan,
  })
  return { exportId: exportRow.id, reused: false, sourceWarnings }
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
  audio: EffectiveAudioSource
  mixPlan?: MixPlan
}): Promise<void> {
  const controller = new AbortController()
  editJobs.set(ctx.exportId, controller)
  activeEditCount += 1
  RUNNING.add(ctx.project.id)
  const patch = (values: Record<string, unknown>) =>
    db.update(schema.episodeExports).set(values as never)
      .where(eq(schema.episodeExports.id, ctx.exportId)).run()
  const patchIfRunning = (values: Record<string, unknown>) =>
    db.update(schema.episodeExports).set(values as never)
      .where(and(
        eq(schema.episodeExports.id, ctx.exportId),
        inArray(schema.episodeExports.status, RUNNING_STATUSES),
      )).run()
  let dirAbs: string | null = null
  let tempAudioDir: string | null = ctx.audio === 'mix'
    ? projectSubdirPath(ctx.project.dramaId, `temp/edit-render-${ctx.exportId}`)
    : null
  try {
    patch({ status: 'rendering', progress: 5, error: null })
    const layout = computeLayout(ctx.plan)
    const episode = db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, ctx.episodeId)).get()
    if (!episode) throw new Error('分集不存在，无法导出')

    // 产物目录：项目存储 episodes/<episodeId>/exports/<exportId>/（与拼接/混音导出一致）
    const subDir = `episodes/${ctx.episodeId}/exports/${ctx.exportId}`
    dirAbs = projectSubdirPath(ctx.project.dramaId, subDir)
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

    // 混音 WAV 在画面组装完成后才渲染；失败不得回退原声，导出直接失败
    const audioInput = ctx.audio === 'mix'
      ? {
        mode: 'mix' as const,
        prepare: async (signal: AbortSignal | undefined, onProgress: (pct: number) => void) => {
          if (!ctx.mixPlan || !tempAudioDir) throw new Error('混音计划不可用，无法导出')
          const wavPath = path.join(tempAudioDir, 'mix.wav')
          await fsp.mkdir(tempAudioDir, { recursive: true })
          await renderMixAudio(ctx.mixPlan, {
            outputPath: wavPath,
            format: 'wav',
            codec: 'pcm_s24le',
            signal,
            onProgress,
          })
          return wavPath
        },
      }
      : { mode: ctx.audio }

    const { durationMs } = await renderEditVideo({
      plan: ctx.plan,
      outputPath: outputAbs,
      subtitleMode: ctx.subtitleMode,
      assPath,
      srtPath,
      signal: controller.signal,
      audio: audioInput,
      onProgress: (pct) => patch({ progress: Math.max(5, Math.min(95, Math.round(pct))) }),
    })
    patch({ progress: 96 })

    // 渲染结束与取消同时发生时，取消优先：不得投影成片或覆盖 cancelled 状态
    if (controller.signal.aborted || editRecordOf(ctx.exportId)?.status === 'cancelled') {
      if (editJobs.get(ctx.exportId) === controller) {
        await fsp.rm(outputAbs, { force: true }).catch(() => {})
      }
      return
    }
    // 已被新任务接管（如取消后立即重试）时，旧任务不得再改状态或清理同名产物
    if (editJobs.get(ctx.exportId) !== controller) return

    const frameMs = 1000 / Math.max(1, ctx.plan.project.fps)
    if (Math.abs(durationMs - layout.durationMs) > frameMs) {
      throw new Error(`导出时长偏差超过 1 帧：${durationMs}ms vs ${layout.durationMs}ms`)
    }
    const stat = await fsp.stat(outputAbs)
    const completed = patchIfRunning({
      status: 'completed',
      progress: 100,
      outputUrl: outputRel,
      durationMs,
      sizeBytes: stat.size,
      fileName: `${baseName}.mp4`,
      finishedAt: now(),
    })
    // 条件更新命中 0 行说明状态已被取消，产物按取消清理
    if (!completed.changes) {
      await fsp.rm(outputAbs, { force: true }).catch(() => {})
      return
    }

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
      duration: Math.round(durationMs / 1000),
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
    // 取消是用户显式动作：catch 里先看台账，cancelled 只清理，不得覆盖为 failed
    const ownsJob = editJobs.get(ctx.exportId) === controller
    const status = editRecordOf(ctx.exportId)?.status
    if (controller.signal.aborted || status === 'cancelled') {
      if (ownsJob && dirAbs) removeExportFiles(dirAbs)
      return
    }
    // 成片已投影后（如设为当前失败）不得回收已完成产物；被新任务接管时同样不再插手
    if (status === 'completed' || !ownsJob) return
    markFailed(
      ctx.exportId,
      cause instanceof Error ? cause.message : '导出失败',
      dirAbs ?? undefined,
    )
  } finally {
    RUNNING.delete(ctx.project.id)
    if (editJobs.get(ctx.exportId) === controller) editJobs.delete(ctx.exportId)
    activeEditCount = Math.max(0, activeEditCount - 1)
    // 临时混音 WAV 无论成功/失败/取消都不留在项目存储里
    if (tempAudioDir) {
      await fsp.rm(tempAudioDir, { recursive: true, force: true }).catch(() => {})
      tempAudioDir = null
    }
  }
}

/** 取消编辑导出：置 cancelled 后中止 FFmpeg，渲染器负责清理半成品 */
export function cancelEditExport(exportId: number) {
  const row = requireEditRecord(exportId)
  if (row.status === 'cancelled') return getEditExportStatus(row.episodeId, exportId)
  if (!RUNNING_STATUSES.includes(String(row.status))) {
    throw new EditWorkspaceError(409, 'EDIT_EXPORT_CANCEL_INVALID', '导出已结束，无法取消')
  }
  db.update(schema.episodeExports)
    .set({ status: 'cancelled', error: null, finishedAt: now() })
    .where(and(
      eq(schema.episodeExports.id, exportId),
      inArray(schema.episodeExports.status, RUNNING_STATUSES),
    ))
    .run()
  editJobs.get(exportId)?.abort()
  removeEditExportDir(row.episodeId, exportId)
  return getEditExportStatus(row.episodeId, exportId)
}

/** 重试编辑导出：沿用原记录 id，重新校验计划后回到编辑渲染管线 */
export async function retryEditExport(exportId: number) {
  const row = requireEditRecord(exportId)
  if (!['failed', 'cancelled'].includes(String(row.status))) {
    throw new EditWorkspaceError(409, 'EDIT_EXPORT_RETRY_INVALID', '只有失败或已取消的导出可以重试')
  }
  if (!getEditSettings().export.enabled) {
    throw new EditWorkspaceError(409, 'EDIT_EXPORT_DISABLED', '剪辑导出已关闭')
  }
  const project = row.projectId
    ? db.select().from(schema.editProjects)
      .where(and(
        eq(schema.editProjects.id, row.projectId),
        isNull(schema.editProjects.deletedAt),
      ))
      .get()
    : undefined
  if (!project) {
    throw new EditWorkspaceError(404, 'EDIT_PROJECT_NOT_FOUND', '剪辑工程不存在，无法重试')
  }
  getWritableEpisode(project.episodeId)
  if (!project.sourceMergeId) {
    throw new EditWorkspaceError(400, 'EDIT_LEGACY_EXPORT', '旧版工程不支持导出，请先另存为成片工程')
  }
  const runningRow = db.select().from(schema.episodeExports)
    .where(and(
      eq(schema.episodeExports.kind, 'edit'),
      inArray(schema.episodeExports.status, RUNNING_STATUSES),
      isNull(schema.episodeExports.deletedAt),
    )).all()
    .find((item) => item.id !== exportId && item.projectId === project.id)
  if (runningRow || RUNNING.has(project.id)) {
    throw new EditWorkspaceError(409, 'EXPORT_ALREADY_RUNNING', '该工程已有导出任务进行中')
  }
  assertEditConcurrency()

  const plan = loadProjectPlan(project)
  const blocking = validateEditPlan(plan).find((issue) => issue.severity === 'error')
  if (blocking) {
    throw new EditWorkspaceError(400, 'EDIT_PLAN_INVALID', `计划无法导出：${blocking.message}`)
  }
  const unsupported = blockingFeaturesOf(plan)
  if (unsupported.length) {
    throw new EditWorkspaceError(
      422,
      'EDIT_RENDER_UNSUPPORTED',
      `计划包含暂不支持导出的字段：${unsupported.map((item) => item.message).join('；')}`,
      { issues: unsupported },
    )
  }
  const layout = computeLayout(plan)
  const { maxDurationSec } = getEditSettings().export
  if (layout.durationMs > maxDurationSec * 1000) {
    throw new EditWorkspaceError(
      422,
      'EDIT_DURATION_LIMIT',
      `成片时长 ${Math.ceil(layout.durationMs / 1000)} 秒，超过上限 ${maxDurationSec} 秒`,
    )
  }

  let params: Record<string, unknown> = {}
  try {
    params = JSON.parse(row.paramsJson || '{}') as Record<string, unknown>
  } catch {
    params = {}
  }
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, project.dramaId)).get()
  const requestedPreset = typeof params.autoRequested === 'string' && params.autoRequested
    ? params.autoRequested
    : (row.preset || 'auto')
  let preset: EditExportPresetKey
  try {
    preset = resolveEditExportPreset(requestedPreset, aspectOf(drama?.aspectRatio))
  } catch {
    throw new EditWorkspaceError(400, 'EDIT_PRESET_INVALID', '导出预设无效')
  }
  const subtitleMode = SUBTITLE_MODES.has(String(row.subtitleMode)) ? String(row.subtitleMode) : 'burn'
  // 新记录保存 audioRequested；旧记录只有 audioSource（当时存的即请求值）
  const audioRequested = AUDIO_SOURCES.has(String(params.audioRequested))
    ? String(params.audioRequested)
    : AUDIO_SOURCES.has(String(params.audioSource))
      ? String(params.audioSource)
      : 'auto'

  const presetSpec = EXPORT_PRESETS[preset]
  const requiredBytes = estimateExportBytes('video', layout.durationMs, presetSpec)
    + estimateExportBytes('mix', layout.durationMs, presetSpec)
  try {
    assertCapacity(requiredBytes, freeBytesForDrama(project.dramaId))
  } catch (error) {
    if (error instanceof ExportCapacityError) {
      throw new EditWorkspaceError(
        507,
        'EDIT_DISK_FULL',
        `磁盘空间不足：预计需要 ${formatBytes(error.requiredBytes)}，剩余 ${formatBytes(error.freeBytes)}`,
      )
    }
    throw error
  }

  const planHash = planHashOf(plan)
  const sourceVideoHash = sourceFingerprintOf(plan)
  const subtitleHash = subtitleHashOf(plan)
  const editSyncHash = editSyncHashOf(plan)
  const timeline = buildTimelineForPlan(project.episodeId, plan)
  const dialogueSyncHash = dialogueSyncHashOf(dialogPlacementsOf(timeline.linePlacements))
  // 重试按当前事实重新解析：计划/混音可能在失败后已变化，未对齐的显式混音依旧 409
  const resolvedAudio = resolveExportAudio({
    episodeId: project.episodeId,
    plan,
    planHash,
    requested: audioRequested,
    requireAlignedMix: getEditSettings().export.requireAlignedMix === true,
  })
  const { mixRevisionId, planRevisionId } = resolvedAudio
  const effectiveAudio = resolvedAudio.effective

  let mixPlan: MixPlan | undefined
  if (effectiveAudio === 'mix') {
    const compiled = await compileEpisodePlan(project.episodeId, project.dramaId)
    mixPlan = compiled.plan
    const busyAfterCompile = db.select().from(schema.episodeExports)
      .where(and(
        eq(schema.episodeExports.kind, 'edit'),
        inArray(schema.episodeExports.status, RUNNING_STATUSES),
        isNull(schema.episodeExports.deletedAt),
      )).all()
      .find((item) => item.id !== exportId && item.projectId === project.id)
    if (busyAfterCompile || RUNNING.has(project.id)) {
      throw new EditWorkspaceError(409, 'EXPORT_ALREADY_RUNNING', '该工程已有导出任务进行中')
    }
  }

  const currentRevision = currentRevisionFor(project.id)
  let revisionId = currentRevision?.id ?? null
  let revisionNo = currentRevision?.revisionNo ?? 0
  if (!currentRevision || currentRevision.planHash !== planHash) {
    const created = createEditRevision(project, { note: '导出里程碑', plan })
    revisionId = created.revision.id
    revisionNo = created.revision.revision_no ?? 0
  }

  const setCurrent = params.setCurrent === true
  const title = typeof params.title === 'string' && params.title ? params.title : null
  const paramsJson = JSON.stringify({
    renderMode: 'edit',
    audioSource: effectiveAudio,
    audioRequested,
    autoRequested: requestedPreset,
    subtitleMode,
    setCurrent,
    preset,
    title,
  })

  db.update(schema.episodeExports)
    .set({
      status: 'pending',
      progress: 0,
      error: null,
      outputUrl: null,
      durationMs: null,
      sizeBytes: null,
      fileName: null,
      finishedAt: null,
      isCurrent: false,
      preset,
      subtitleMode,
      editRevisionId: revisionId,
      planRevisionId,
      mixRevisionId,
      editPlanHash: planHash,
      editSyncHash,
      dialogueSyncHash,
      subtitleHash,
      sourceVideoHash,
      paramsJson,
    })
    .where(eq(schema.episodeExports.id, exportId))
    .run()

  void runEditExport({
    exportId,
    episodeId: project.episodeId,
    project,
    plan,
    subtitleMode: subtitleMode as 'burn' | 'soft' | 'none',
    preset,
    setCurrent,
    title,
    revisionId,
    revisionNo,
    audio: effectiveAudio,
    mixPlan,
  })
  return getEditExportStatus(project.episodeId, exportId)
}

/** 测试/热重载：中止内存中的编辑任务并清零并发计数 */
export function resetEditExportRuntime(): void {
  for (const controller of editJobs.values()) {
    try { controller.abort() } catch { /* 已结束 */ }
  }
  editJobs.clear()
  activeEditCount = 0
  RUNNING.clear()
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
  let audioSource: string | null = null
  try {
    const params = JSON.parse(row.paramsJson || '{}') as Record<string, unknown>
    if (AUDIO_SOURCES.has(String(params.audioSource))) audioSource = String(params.audioSource)
  } catch {
    audioSource = null
  }
  return {
    id: row.id,
    episode_id: row.episodeId,
    kind: row.kind,
    preset: row.preset,
    status: row.status,
    progress: row.progress ?? 0,
    subtitle_mode: row.subtitleMode ?? null,
    audio_source: audioSource,
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
