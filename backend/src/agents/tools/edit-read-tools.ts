/**
 * 助手只读工具集（剪辑 / 混音 / 交付）：
 * - 只查询，不建工程、不落初始计划/版本、不补默认总线、不创建导出或成片；
 * - 读取走 A2-1 的 readOnly 路径与既有只读事实源；
 * - 不返回完整计划 JSON、素材 URL、绝对路径或密钥。
 */
import { createTool } from '@mastra/core/tools'
import type { RequestContext } from '@mastra/core/request-context'
import { z } from 'zod'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { clipText, getAssistantBudget } from '../assistant-context.js'
import { getAssistantScope } from '../context.js'
import type { AgentScope } from '../agent-scope.js'
import { getEpisodeEditState } from '../../services/edit-service.js'
import { probeEditMedia } from '../../services/edit-media.js'
import { compileEpisodePlan, listMixRevisions } from '../../services/mix-plan.js'
import { MixSourceError } from '../../services/mix-source.js'
import { mixSyncStatusOf } from '../../services/edit-mix-sync.js'

const TRACK_REF_LIMIT = 20

function fail(error: string, hint: string, status?: number) {
  return status ? { error, hint, status } : { error, hint }
}

function limitResult<T extends Record<string, unknown>>(result: T): T | Record<string, unknown> {
  const maxChars = getAssistantBudget().maxResultChars
  const text = JSON.stringify(result)
  if (text.length <= maxChars) return result
  return {
    truncated: true,
    hint: '结果超过单次上限，已截断；请缩小 limit 或改用更精确的编号后重试。',
    preview: text.slice(0, Math.max(0, maxChars - 200)),
  }
}

/** 用户可见文案：去换行并抹掉路径样式的片段，避免把服务器路径带进对话 */
function safeText(raw: unknown, limit = 240): string {
  const text = String(raw ?? '').replace(/\r?\n+/g, ' ').trim()
  const withoutPaths = text
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '[路径]')
    .replace(/(?:\/[^\s'"]+){2,}/g, '[路径]')
    .replace(/\b(?:[\w.-]+\/){2,}[\w.-]+/g, '[路径]')
  return clipText(withoutPaths, limit).text
}

function scopedEpisodeId(scope: AgentScope | null, kind: AgentScope['kind'], episodeId: unknown) {
  if (!scope || scope.kind !== kind) {
    return fail('当前作用域不允许该读取', '请在对应工作台页面使用该工具。', 403)
  }
  const value = Number(episodeId)
  if (!Number.isInteger(value) || value <= 0) {
    return fail('episode_id 必须是正整数', '请从当前页面上下文传入当前分集编号。', 422)
  }
  if (value !== scope.episode_id) {
    return fail('分集编号与当前页面作用域不一致', '只能读取当前打开的分集，请勿传入其他分集编号。', 422)
  }
  return null
}

function scopedProjectId(scope: AgentScope | null, projectId: unknown) {
  const value = Number(projectId)
  if (!Number.isInteger(value) || value <= 0) {
    return fail('edit_project_id 必填且必须是正整数', '请传入当前剪辑工程的 edit_project_id。', 422)
  }
  if (!scope || scope.kind !== 'edit' || scope.edit_project_id !== value) {
    return fail('剪辑工程与当前页面作用域不一致', '只能读取当前打开的剪辑工程，请勿传入其他工程编号。', 422)
  }
  return null
}

function warningsSummary(warnings: Array<{ code: string; message: string }>) {
  return warnings.slice(0, 10).map((warning) => ({
    code: warning.code,
    message: safeText(warning.message, 160),
  }))
}

function revisionSummary(row: ReturnType<typeof listMixRevisions>[number]) {
  return {
    revision_id: row.id,
    revision_no: row.revisionNo,
    is_current: Boolean(row.isCurrent),
    source_film_id: row.sourceFilmId ?? null,
    edit_sync_hash: row.editSyncHash ?? null,
    dialogue_sync_hash: row.dialogueSyncHash ?? null,
    note: safeText(row.note, 120),
    created_at: row.createdAt,
  }
}

async function sourceStatus(source: { url?: string; fingerprint?: string } | null | undefined) {
  if (!source?.url) {
    return { missing: true, stale: false, current_fingerprint: null, reason: '缺少素材地址' }
  }
  try {
    const probe = await probeEditMedia(source.url)
    const stale = String(probe.fingerprint) !== String(source.fingerprint ?? '')
    return {
      missing: false,
      stale,
      current_fingerprint: probe.fingerprint,
      reason: stale ? '素材文件已变化' : null,
    }
  } catch {
    return { missing: true, stale: false, current_fingerprint: null, reason: '素材文件不存在或不可读' }
  }
}

const readEditState = createTool({
  id: 'read_edit_state',
  description: 'Read the current edit project state: clip count, duration, current revision, draft dirty flag, mix sync status with reasons, and the latest export. Only available on the edit workbench page. Does not create a project, draft or revision.',
  inputSchema: z.object({
    episode_id: z.number().int().positive().describe('Episode ID; must match the current page scope'),
    edit_project_id: z.number().int().positive().optional().describe('Edit project ID; optional when the page scope already binds the project'),
  }),
  execute: async ({ episode_id, edit_project_id }, context) => {
    const scope = getAssistantScope(context?.requestContext)
    const episodeError = scopedEpisodeId(scope, 'edit', episode_id)
    if (episodeError) return episodeError
    if (edit_project_id !== undefined) {
      const projectError = scopedProjectId(scope, edit_project_id)
      if (projectError) return projectError
    }
    const projectId = edit_project_id ?? scope!.edit_project_id

    try {
      const state = await getEpisodeEditState(scope!.episode_id!, projectId ?? null, { readOnly: true })
      if (!state.project) {
        return limitResult({
          episode_id: scope!.episode_id,
          no_edit_plan: true,
          empty_reason: state.empty_reason || 'NO_PROJECT',
          clip_count: 0,
          duration_ms: 0,
          mix_status: null,
          latest_export: null,
          hint: '当前集还没有剪辑工程；请先在剪辑工作台打开成片创建工程后再读取。',
        })
      }
      const revision = state.current_revision
      return limitResult({
        episode_id: scope!.episode_id,
        no_edit_plan: false,
        project: { id: state.project.id, title: state.project.title },
        clip_count: state.plan.clips.length,
        duration_ms: state.layout.duration_ms,
        version: revision
          ? {
              revision_id: revision.id,
              revision_no: revision.revision_no,
              created_at: revision.created_at,
            }
          : null,
        draft: {
          version: state.draft?.version ?? null,
          dirty: Boolean(state.draft_dirty),
        },
        mix_status: {
          status: state.mix_status.status,
          reasons: state.mix_status.reasons,
        },
        latest_export: state.renders.latest
          ? {
              export_id: state.renders.latest.id,
              status: state.renders.latest.status,
              preset: state.renders.latest.preset,
              subtitle_mode: state.renders.latest.subtitle_mode,
              duration_ms: state.renders.latest.duration_ms,
              error: state.renders.latest.error ? safeText(state.renders.latest.error) : null,
              created_at: state.renders.latest.created_at,
            }
          : null,
        hint: '该状态为只读快照；需要查看片段明细请用 read_edit_clips。',
      })
    } catch (error: any) {
      if (error?.status === 404) {
        return limitResult({
          episode_id: scope!.episode_id,
          no_edit_plan: true,
          empty_reason: 'NO_PROJECT',
          clip_count: 0,
          duration_ms: 0,
          mix_status: null,
          latest_export: null,
          hint: '当前集还没有可读取的剪辑工程；请先在剪辑工作台打开成片创建工程后再读取。',
        })
      }
      return fail(error?.message || '读取剪辑状态失败', '请确认剪辑工程仍然存在且当前分集可读。', error?.status || 500)
    }
  },
})

const readEditClips = createTool({
  id: 'read_edit_clips',
  description: 'List clips of the current edit project in timeline order: source kind/id, in/out points, source fingerprint, and stale/missing flags computed against current media. Requires the current edit_project_id. Does not return media URLs.',
  inputSchema: z.object({
    episode_id: z.number().int().positive().describe('Episode ID; must match the current page scope'),
    edit_project_id: z.number().int().positive().optional().describe('Current edit project ID; required explicitly (the scope project is never guessed)'),
  }),
  execute: async ({ episode_id, edit_project_id }, context) => {
    const scope = getAssistantScope(context?.requestContext)
    const episodeError = scopedEpisodeId(scope, 'edit', episode_id)
    if (episodeError) return episodeError
    const projectError = scopedProjectId(scope, edit_project_id)
    if (projectError) return projectError

    try {
      const state = await getEpisodeEditState(scope!.episode_id!, edit_project_id, { readOnly: true })
      if (!state.project) {
        return fail('剪辑工程不存在或已删除', '请先在剪辑工作台打开当前成片创建工程。', 404)
      }
      const layoutById = new Map(state.layout.clips.map((clip) => [clip.clip_id, clip]))
      const items = await Promise.all(state.plan.clips.map(async (clip, index) => {
        const layout = layoutById.get(clip.id)
        const status = await sourceStatus(clip.source)
        return {
          index,
          clip_id: clip.id,
          kind: clip.kind,
          source: {
            kind: clip.source.kind,
            id: clip.source.id,
            label: safeText(clip.source.label, 120),
          },
          timeline: {
            start_ms: layout?.timeline_start_ms ?? null,
            end_ms: layout?.timeline_end_ms ?? null,
            content_duration_ms: layout?.content_duration_ms ?? null,
          },
          source_range: {
            in_ms: clip.sourceInMs,
            out_ms: clip.sourceOutMs,
            duration_ms: Math.max(0, clip.sourceOutMs - clip.sourceInMs),
            speed: clip.speed,
          },
          fingerprint: clip.source.fingerprint,
          ...status,
        }
      }))
      return limitResult({
        episode_id: scope!.episode_id,
        edit_project_id,
        items,
        total: items.length,
        truncated: false,
        hint: items.length
          ? 'stale 表示素材指纹已变化，missing 表示素材不可读；两者都需回到剪辑台确认。'
          : '当前工程还没有片段；请先在剪辑台添加素材。',
      })
    } catch (error: any) {
      return fail(error?.message || '读取剪辑片段失败', '请确认剪辑工程仍然存在且当前分集可读。', error?.status || 500)
    }
  },
})

const readMixState = createTool({
  id: 'read_mix_state',
  description: 'Read the current mix state: buses, track counts, mute/solo, current mix revision, sync hashes, mix alignment status and stale reasons. Only available on the mix workbench page. Does not create default buses.',
  inputSchema: z.object({
    episode_id: z.number().int().positive().describe('Episode ID; must match the current page scope'),
  }),
  execute: async ({ episode_id }, context) => {
    const scope = getAssistantScope(context?.requestContext)
    const episodeError = scopedEpisodeId(scope, 'mix', episode_id)
    if (episodeError) return episodeError

    try {
      const { plan, warnings } = await compileEpisodePlan(
        scope!.episode_id!,
        scope!.drama_id!,
        null,
        { readOnly: true },
      )
      const sync = mixSyncStatusOf(scope!.episode_id!)
      const current = listMixRevisions(scope!.episode_id!).find((row) => row.isCurrent) ?? null
      const muted = plan.tracks.filter((track) => track.effectiveMuted || track.muted).length
      const solo = plan.tracks.filter((track) => track.solo).length
      return limitResult({
        episode_id: scope!.episode_id,
        mix_status: { status: sync.status, reasons: sync.reasons },
        sync_hashes: {
          edit_plan_hash: sync.edit_plan_hash,
          edit_sync_hash: sync.edit_sync_hash,
          dialogue_sync_hash: sync.dialogue_sync_hash,
        },
        mix_revision: current ? revisionSummary(current) : null,
        buses: plan.buses.map((bus) => ({
          key: bus.key,
          name: bus.name,
          volume: bus.volume,
          muted: Boolean(bus.muted),
          solo: Boolean(bus.solo),
        })),
        track_count: plan.tracks.length,
        muted_track_count: muted,
        solo_track_count: solo,
        source: plan.source
          ? {
              kind: plan.source.kind,
              film_id: plan.source.filmId,
              duration_ms: plan.source.durationMs,
              has_audio: plan.source.hasAudio,
            }
          : null,
        duration_ms: plan.durationMs,
        warnings: warningsSummary(warnings),
        hint: sync.status === 'aligned'
          ? '混音与当前剪辑版本对齐；可直接试听或导出。'
          : sync.status === 'stale'
            ? '混音已过期，原因见 mix_status.reasons；需要重新生成或对齐。'
            : sync.status === 'missing'
              ? '当前集还没有混音版本；可先在混音台创建。'
              : '当前集还没有可对齐的剪辑计划；请先在剪辑台完成工程。',
      })
    } catch (error: any) {
      if (error instanceof MixSourceError) {
        return fail(error.message, '请回到混音台确认来源成片是否可用。', error.status)
      }
      return fail(error?.message || '读取混音状态失败', '请确认当前集可读且混音数据完整。', error?.status || 500)
    }
  },
})

const readMixTracks = createTool({
  id: 'read_mix_tracks',
  description: 'List mix tracks: name, role, bus, clip count, volume, mute/solo, and source references. Does not return audio URLs and does not create default buses.',
  inputSchema: z.object({
    episode_id: z.number().int().positive().describe('Episode ID; must match the current page scope'),
  }),
  execute: async ({ episode_id }, context) => {
    const scope = getAssistantScope(context?.requestContext)
    const episodeError = scopedEpisodeId(scope, 'mix', episode_id)
    if (episodeError) return episodeError

    try {
      const { plan, warnings } = await compileEpisodePlan(
        scope!.episode_id!,
        scope!.drama_id!,
        null,
        { readOnly: true },
      )
      const items = plan.tracks.map((track, index) => {
        const assetIds = [...new Set(track.clips.map((clip) => clip.assetId).filter((id): id is number => typeof id === 'number'))]
        const takeIds = [...new Set(track.clips.map((clip) => clip.takeId).filter((id): id is number => typeof id === 'number'))]
        const lineIds = [...new Set(track.clips.map((clip) => clip.lineId).filter((id): id is number => typeof id === 'number'))]
        return {
          index,
          name: track.name,
          role: track.role,
          bus: track.busId,
          virtual: Boolean(track.virtual),
          clip_count: track.clips.length,
          volume: track.volume,
          pan: track.pan,
          muted: Boolean(track.muted),
          solo: Boolean(track.solo),
          effective_muted: Boolean(track.effectiveMuted),
          locked: Boolean(track.locked),
          hidden: Boolean(track.hidden),
          origin: track.origin ?? null,
          source_refs: {
            asset_ids: assetIds.slice(0, TRACK_REF_LIMIT),
            take_ids: takeIds.slice(0, TRACK_REF_LIMIT),
            line_ids: lineIds.slice(0, TRACK_REF_LIMIT),
          },
        }
      })
      return limitResult({
        episode_id: scope!.episode_id,
        items,
        total: items.length,
        truncated: false,
        warnings: warningsSummary(warnings),
        hint: items.length
          ? '片段音频地址不在此返回；需要具体素材请回混音台查看。'
          : '当前集还没有可选音轨；可在混音台添加配音或音效。',
      })
    } catch (error: any) {
      if (error instanceof MixSourceError) {
        return fail(error.message, '请回到混音台确认来源成片是否可用。', error.status)
      }
      return fail(error?.message || '读取混音轨道失败', '请确认当前集可读且混音数据完整。', error?.status || 500)
    }
  },
})

const readExportHistory = createTool({
  id: 'read_export_history',
  description: 'List export records of the current episode (newest first), including status, preset, duration, current flag, source merge/film and user-visible failure reason. Soft-deleted records are excluded. Does not return internal paths.',
  inputSchema: z.object({
    episode_id: z.number().int().positive().describe('Episode ID; must match the current page scope'),
    export_id: z.number().int().positive().optional().describe('Optional export ID filter; cross-episode IDs return an empty list'),
    limit: z.number().int().positive().max(50).optional().describe('Maximum records to return, default 10'),
  }),
  execute: async ({ episode_id, export_id, limit }, context) => {
    const scope = getAssistantScope(context?.requestContext)
    const episodeError = scopedEpisodeId(scope, 'delivery', episode_id)
    if (episodeError) return episodeError

    const take = Math.max(1, Math.min(50, Math.floor(limit ?? 10)))
    const conditions = [
      eq(schema.episodeExports.episodeId, scope!.episode_id!),
      isNull(schema.episodeExports.deletedAt),
    ]
    if (export_id !== undefined) conditions.push(eq(schema.episodeExports.id, export_id))
    const where = and(...conditions)
    const total = Number(db.select({ n: sql<number>`count(*)` })
      .from(schema.episodeExports)
      .where(where)
      .get()?.n ?? 0)
    const rows = db.select().from(schema.episodeExports)
      .where(where)
      .orderBy(desc(schema.episodeExports.createdAt), desc(schema.episodeExports.id))
      .limit(take + 1)
      .all()
    const items = rows.slice(0, take).map((row) => {
      const film = db.select({
        id: schema.videoMerges.id,
        title: schema.videoMerges.title,
        kind: schema.videoMerges.kind,
      }).from(schema.videoMerges)
        .where(and(
          eq(schema.videoMerges.exportId, row.id),
          eq(schema.videoMerges.episodeId, scope!.episode_id!),
          isNull(schema.videoMerges.deletedAt),
        ))
        .get() ?? null
      return {
        export_id: row.id,
        kind: row.kind,
        status: row.status,
        progress: row.progress ?? 0,
        preset: row.preset,
        subtitle_mode: row.subtitleMode ?? null,
        duration_ms: row.durationMs ?? null,
        size_bytes: row.sizeBytes ?? null,
        is_current: Boolean(row.isCurrent),
        plan_revision_id: row.planRevisionId ?? null,
        edit_revision_id: row.editRevisionId ?? null,
        mix_revision_id: row.mixRevisionId ?? null,
        source_merge_id: row.sourceMergeId ?? null,
        source_film: film
          ? { film_id: film.id, title: safeText(film.title, 120), kind: film.kind }
          : null,
        error: row.status === 'failed' ? safeText(row.error) : null,
        created_at: row.createdAt,
        finished_at: row.finishedAt ?? null,
      }
    })
    return limitResult({
      episode_id: scope!.episode_id,
      items,
      total,
      truncated: rows.length > take || total > take,
      hint: items.length
        ? '导出记录只含台账与来源引用；成片文件请在交付/成片中心查看。'
        : export_id !== undefined
          ? '该集下没有这条导出记录；不能按其他集的导出 ID 猜测成片。'
          : '该集还没有导出记录。',
    })
  },
})

export const EDIT_READ_TOOLS: Record<string, any> = {
  read_edit_state: readEditState,
  read_edit_clips: readEditClips,
}

export const MIX_READ_TOOLS: Record<string, any> = {
  read_mix_state: readMixState,
  read_mix_tracks: readMixTracks,
}

export const DELIVERY_READ_TOOLS: Record<string, any> = {
  read_export_history: readExportHistory,
}
