/**
 * 声音设计 cue 的时间、内容与提示词编译
 *
 * 第四步声音计划是权威来源；生成时按 cue 覆盖的分镜解析实际/计划时间，
 * 收集场景、分镜和台词窗口，再编译成 Stable Audio 可用的英文提示词。
 */
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { callTextJson } from './text-call.js'
import { previewTimeline } from './dubbing.js'
import {
  clampSeconds,
  DEFAULT_NEGATIVE_PROMPTS,
  fallbackAmbiencePrompt,
  fallbackBgmPrompt,
  fallbackSfxPrompt,
  translateSoundscapeHints,
  type SoundscapeCategory,
} from './soundscape-compiler.js'
import type { TimelineCue, TimelineResult } from './timeline.js'

export type CueAudioKind = 'bgm' | 'ambience' | 'sfx'
export type CueTimeSource = 'timeline' | 'planned' | 'stored'

export interface SoundPlanCueAssetInfo {
  id: number
  url: string
  durationMs: number
  model: string
  createdAt: string
  status: string
}

export interface SoundPlanCueTiming {
  startMs: number
  endMs: number
  timeSource: CueTimeSource
}

export interface SoundPlanCueContext extends SoundPlanCueTiming {
  cue: typeof schema.soundCues.$inferSelect
  category: CueAudioKind
  seconds: number
  sceneLocation: string
  sceneTime: string
  dialogueCount: number
  dialogueSummary: string
  sourceSummary: string
  warnings: string[]
}

export interface SoundPlanCueAudioItem extends SoundPlanCueContext {
  prompt: string
  negativePrompt: string
  degraded: boolean
}

export interface SoundPlanViewCue {
  id: number
  unit_key: string
  unit_label: string
  kind: string
  from_shot_number: number | null
  to_shot_number: number | null
  from_shot_id: number
  to_shot_id: number
  description: string
  intensity: string
  entry: string
  exit: string
  delivery: string
  start_ms: number
  end_ms: number
  time_source: CueTimeSource
  scene_location: string
  scene_time: string
  dialogue_count: number
  source_summary: string
  asset: SoundPlanCueAssetInfo | null
  generation_status: string
  generation_error: string
  generated_at: string | null
  can_generate: boolean
  can_attach: boolean
  attached: boolean
}

export interface SoundPlanView {
  plan: {
    id: number
    version: number
    status: string
    delivery: string
    summary: string
    created_at: string
  } | null
  cues: SoundPlanViewCue[]
  warnings: string[]
  audio_config_ready: boolean
}

const CATEGORY_LABELS: Record<CueAudioKind, string> = {
  ambience: '环境声',
  sfx: '音效',
  bgm: 'BGM',
}

const CUE_PROMPT_BATCH_SIZE = 6

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export function cueCategory(kind: string): CueAudioKind | null {
  return kind === 'ambience' || kind === 'sfx' || kind === 'bgm' ? kind : null
}

function plannedTimeline(storyboards: Array<typeof schema.storyboards.$inferSelect>) {
  const result = new Map<number, { startMs: number; endMs: number }>()
  let cursor = 0
  for (const shot of storyboards) {
    const durationMs = Math.max(0, Math.round(Number(shot.duration || 5) * 1000))
    result.set(shot.id, { startMs: cursor, endMs: cursor + durationMs })
    cursor += durationMs
  }
  return result
}

function resolveShotRange(
  cue: typeof schema.soundCues.$inferSelect,
  storyboards: Array<typeof schema.storyboards.$inferSelect>,
): {
  from: typeof schema.storyboards.$inferSelect | undefined
  to: typeof schema.storyboards.$inferSelect | undefined
  range: Array<typeof schema.storyboards.$inferSelect>
} {
  const fromNumber = Number(cue.fromShotNumber) || 0
  const toNumber = Number(cue.toShotNumber) || 0
  if (fromNumber > 0 && toNumber > 0) {
    const range = storyboards.filter(shot => {
      const number = Number(shot.storyboardNumber) || 0
      return number >= fromNumber && number <= toNumber
    })
    if (range.length) {
      return { from: range[0], to: range[range.length - 1], range }
    }
  }
  const byId = new Map(storyboards.map(shot => [shot.id, shot]))
  const from = byId.get(cue.fromShotId)
  const to = byId.get(cue.toShotId)
  if (!from || !to) return { from, to, range: [] }
  const low = Math.min(from.storyboardNumber ?? from.id, to.storyboardNumber ?? to.id)
  const high = Math.max(from.storyboardNumber ?? from.id, to.storyboardNumber ?? to.id)
  const range = storyboards.filter(shot => {
    const number = Number(shot.storyboardNumber) || shot.id
    return number >= low && number <= high
  })
  return { from, to, range: range.length ? range : [from, to] }
}

export function resolveCueTiming(
  cue: typeof schema.soundCues.$inferSelect,
  storyboards: Array<typeof schema.storyboards.$inferSelect>,
  timeline: TimelineResult,
): SoundPlanCueTiming {
  const actual = new Map(timeline.clips.map(clip => [clip.storyboardId, clip]))
  const { from, to } = resolveShotRange(cue, storyboards)
  const actualFrom = from ? actual.get(from.id) : undefined
  const actualTo = to ? actual.get(to.id) : undefined
  if (actualFrom && actualTo) {
    return {
      startMs: Math.min(actualFrom.startMs, actualTo.startMs),
      endMs: Math.max(actualFrom.endMs, actualTo.endMs),
      timeSource: 'timeline',
    }
  }

  const planned = plannedTimeline(storyboards)
  const plannedFrom = from ? planned.get(from.id) : undefined
  const plannedTo = to ? planned.get(to.id) : undefined
  if (plannedFrom && plannedTo) {
    return {
      startMs: Math.min(plannedFrom.startMs, plannedTo.startMs),
      endMs: Math.max(plannedFrom.endMs, plannedTo.endMs),
      timeSource: 'planned',
    }
  }

  const fallbackStart = Number(cue.startMs)
  const fallbackEnd = Number(cue.endMs)
  return {
    startMs: Number.isFinite(fallbackStart) ? Math.max(0, Math.round(fallbackStart)) : 0,
    endMs: Number.isFinite(fallbackEnd) ? Math.max(0, Math.round(fallbackEnd)) : 0,
    timeSource: 'stored',
  }
}

/** 生成时长：BGM/环境声 30–45 秒，音效 2–10 秒 */
export function cueSeconds(category: CueAudioKind, durationMs: number): number {
  if (category === 'sfx') {
    return clampSeconds(category, Math.max(2, Math.round(durationMs / 1000)))
  }
  return clampSeconds(category, Math.max(30, Math.round(durationMs / 1000)))
}

function dialogueInRange(cues: TimelineCue[], startMs: number, endMs: number) {
  return cues.filter(cue => cue.startMs < endMs && cue.endMs > startMs)
}

export interface LoadedSoundPlan {
  plan: typeof schema.soundPlans.$inferSelect | null
  cues: Array<typeof schema.soundCues.$inferSelect>
  storyboards: Array<typeof schema.storyboards.$inferSelect>
  scenes: Map<number, typeof schema.scenes.$inferSelect>
  timeline: TimelineResult
}

export async function loadLatestSoundPlan(episodeId: number, dramaId: number): Promise<LoadedSoundPlan> {
  const plan = db.select().from(schema.soundPlans)
    .where(eq(schema.soundPlans.episodeId, episodeId))
    .orderBy(desc(schema.soundPlans.id))
    .limit(1)
    .get() ?? null
  const cues = plan
    ? db.select().from(schema.soundCues)
      .where(eq(schema.soundCues.planId, plan.id))
      .orderBy(asc(schema.soundCues.sortOrder))
      .all()
    : []
  const storyboards = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
  const sceneIds = [...new Set(storyboards.map(shot => shot.sceneId).filter((id): id is number => id != null))]
  const scenes = sceneIds.length
    ? db.select().from(schema.scenes).where(inArray(schema.scenes.id, sceneIds)).all()
    : []
  const timeline = await previewTimeline(episodeId, dramaId)
  return {
    plan,
    cues,
    storyboards,
    scenes: new Map(scenes.map(scene => [scene.id, scene])),
    timeline,
  }
}

export function cueContexts(
  loaded: LoadedSoundPlan,
  cueIds?: number[],
): { contexts: SoundPlanCueContext[]; warnings: string[] } {
  const warnings: string[] = []
  const wanted = cueIds?.length ? new Set(cueIds) : null
  const contexts: SoundPlanCueContext[] = []

  for (const cue of loaded.cues) {
    if (wanted && !wanted.has(cue.id)) continue
    const category = cueCategory(cue.kind)
    if (!category) continue

    const timing = resolveCueTiming(cue, loaded.storyboards, loaded.timeline)
    const fromNumber = Number(cue.fromShotNumber) || 0
    const toNumber = Number(cue.toShotNumber) || 0
    const { range } = resolveShotRange(cue, loaded.storyboards)
    const sceneRows = range
      .map(shot => (shot.sceneId == null ? null : loaded.scenes.get(shot.sceneId)))
      .filter((scene): scene is typeof schema.scenes.$inferSelect => Boolean(scene))
    const sceneLocation = unique(sceneRows.map(scene => text(scene.location))).join('、')
    const sceneTime = unique(sceneRows.map(scene => text(scene.time))).join('、')
    const dialogueCues = dialogueInRange(loaded.timeline.cues, timing.startMs, timing.endMs)
    const dialogueSummary = dialogueCues
      .slice(0, 4)
      .map(item => `${item.speaker || '旁白'}：${truncate(text(item.text), 60)}`)
      .join('；')
    const rangeLabel = fromNumber && toNumber
      ? `#${fromNumber}–#${toNumber}`
      : `#${cue.fromShotId}–#${cue.toShotId}`
    const sourceSummary = [
      rangeLabel,
      sceneLocation || '未设定地点',
      sceneTime || '未设定时间',
      truncate(text(cue.description), 80),
    ].filter(Boolean).join(' · ')

    if (timing.endMs <= timing.startMs) {
      warnings.push(`线索 ${rangeLabel} 没有有效时长，已按默认时长生成`)
    }

    contexts.push({
      ...timing,
      cue,
      category,
      seconds: cueSeconds(category, Math.max(0, timing.endMs - timing.startMs)),
      sceneLocation,
      sceneTime,
      dialogueCount: dialogueCues.length,
      dialogueSummary,
      sourceSummary,
      warnings: [],
    })
  }

  if (wanted) {
    const found = new Set(contexts.map(item => item.cue.id))
    for (const id of wanted) {
      if (!found.has(id)) warnings.push(`声音线索 ${id} 不存在或不是可生成的类别`)
    }
  }
  return { contexts, warnings }
}

function formatCueForPrompt(context: SoundPlanCueContext, range: Array<typeof schema.storyboards.$inferSelect>): string {
  const shots = range.map(shot => [
    `#${shot.storyboardNumber ?? shot.id}`,
    `地点：${shot.location || context.sceneLocation || '未设定'}`,
    `时间：${shot.time || context.sceneTime || '未设定'}`,
    `时长：${Number(shot.duration || 5)}s`,
    `氛围：${shot.atmosphere || '未设定'}`,
    `画面：${truncate(text(shot.description || shot.videoPrompt), 160)}`,
  ].join('；')).join('\n')
  return [
    `cueId：${context.cue.id}`,
    `类别：${CATEGORY_LABELS[context.category]}`,
    `描述：${context.cue.description}`,
    `强度：${context.cue.intensity || '未设定'}`,
    `进入：${context.cue.entry || '未设定'}`,
    `退出：${context.cue.exit || '未设定'}`,
    `镜头范围：${context.sourceSummary}`,
    `时间：${context.startMs}–${context.endMs} 毫秒（${context.timeSource === 'timeline' ? '实际时间轴' : '计划时间'}）`,
    `台词窗口：${context.dialogueCount ? `${context.dialogueCount} 句；${context.dialogueSummary}` : '无'}`,
    '分镜：',
    shots || '（无分镜）',
  ].join('\n')
}

function parseCuePromptResponse(data: unknown): Record<number, { prompt: string; negativePrompt: string }> {
  const result: Record<number, { prompt: string; negativePrompt: string }> = {}
  const raw = data && typeof data === 'object' && Array.isArray((data as any).cues)
    ? (data as any).cues as unknown[]
    : []
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    const cueId = Number(row.cueId)
    if (!Number.isInteger(cueId) || cueId <= 0) continue
    const prompt = text(row.prompt)
    if (!prompt) continue
    result[cueId] = { prompt, negativePrompt: text(row.negativePrompt) }
  }
  return result
}

function fallbackPrompt(context: SoundPlanCueContext): { prompt: string; negativePrompt: string; degraded: boolean } {
  const hints = translateSoundscapeHints([
    context.sceneLocation,
    context.sceneTime,
    context.cue.description,
    context.cue.intensity,
  ])
  if (context.category === 'ambience') {
    return {
      prompt: fallbackAmbiencePrompt(hints, context.cue.description),
      negativePrompt: DEFAULT_NEGATIVE_PROMPTS.ambience,
      degraded: true,
    }
  }
  if (context.category === 'sfx') {
    return {
      prompt: fallbackSfxPrompt(hints, context.cue.description),
      negativePrompt: DEFAULT_NEGATIVE_PROMPTS.sfx,
      degraded: true,
    }
  }
  return {
    prompt: fallbackBgmPrompt(hints, context.cue.description),
    negativePrompt: DEFAULT_NEGATIVE_PROMPTS.bgm,
    degraded: true,
  }
}

export interface CompileCuePromptsOptions {
  prompts?: Record<number, string>
  negatives?: Record<number, string>
}

/** 批量编译 cue 提示词；文本模型不可用时逐条确定性降级 */
export async function compileCuePrompts(
  contexts: SoundPlanCueContext[],
  storyboards: Array<typeof schema.storyboards.$inferSelect>,
  options: CompileCuePromptsOptions = {},
): Promise<{ items: SoundPlanCueAudioItem[]; warnings: string[] }> {
  const warnings: string[] = []
  const rangeFor = (context: SoundPlanCueContext) => resolveShotRange(context.cue, storyboards).range

  const items: SoundPlanCueAudioItem[] = []
  const pending = contexts.filter(context => !text(options.prompts?.[context.cue.id]))

  for (let offset = 0; offset < pending.length; offset += CUE_PROMPT_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + CUE_PROMPT_BATCH_SIZE)
    let parsed: Record<number, { prompt: string; negativePrompt: string }> = {}
    try {
      const response = await callTextJson<{ cues?: unknown[] }>({
        system: [
          '你是短剧声音设计师，为 Stable Audio Open 编写英文提示词。',
          '只输出 JSON，不要解释；所有 prompt 和 negativePrompt 必须是英文。',
          '环境声：连续、无对白、无音乐、空间一致、可循环。',
          '音效：具体动作/物体/事件、Foley、短促、干声、不含对白和音乐。',
          'BGM：电影感纯音乐、情绪与强度明确、无 vocals、可循环，不要逐镜重启。',
          '结合分镜的地点、时间、画面和台词窗口；台词密集处降低 BGM 强度。',
          '负向提示词要排除对白、人声、歌词、音乐（按类别）。',
          '输出格式：{"cues":[{"cueId":12,"prompt":"...","negativePrompt":"..."}]}',
        ].join('\n'),
        prompt: `请为以下声音线索编译英文提示词：\n\n${batch.map(context => formatCueForPrompt(context, rangeFor(context))).join('\n\n---\n\n')}`,
        responseFormat: 'json',
        temperature: 0.4,
        maxTokens: 4000,
        timeoutMs: 180_000,
      })
      parsed = parseCuePromptResponse(response.data)
    } catch {
      warnings.push(`线索 ${batch.map(context => `#${context.cue.id}`).join('、')} 的提示词编译失败，使用通用模板`)
    }

    for (const context of batch) {
      const ai = parsed[context.cue.id]
      if (ai) {
        items.push({
          ...context,
          prompt: ai.prompt,
          negativePrompt: text(options.negatives?.[context.cue.id]) || ai.negativePrompt || DEFAULT_NEGATIVE_PROMPTS[context.category],
          degraded: false,
        })
        continue
      }
      const fallback = fallbackPrompt(context)
      items.push({
        ...context,
        prompt: fallback.prompt,
        negativePrompt: text(options.negatives?.[context.cue.id]) || fallback.negativePrompt,
        degraded: fallback.degraded,
      })
    }
  }

  for (const context of contexts) {
    const override = text(options.prompts?.[context.cue.id])
    if (!override) continue
    const fallback = fallbackPrompt(context)
    items.push({
      ...context,
      prompt: override,
      negativePrompt: text(options.negatives?.[context.cue.id]) || fallback.negativePrompt,
      degraded: false,
    })
  }

  items.sort((a, b) => a.cue.sortOrder - b.cue.sortOrder)
  return { items, warnings: unique(warnings) }
}

/** 抽屉读取：不调用文本模型，只返回时间、来源、已生成素材和可执行状态 */
export async function describeSoundPlan(
  episodeId: number,
  dramaId: number,
  options: { audioConfigReady?: boolean } = {},
): Promise<SoundPlanView> {
  const loaded = await loadLatestSoundPlan(episodeId, dramaId)
  if (!loaded.plan) {
    return { plan: null, cues: [], warnings: [], audio_config_ready: Boolean(options.audioConfigReady) }
  }
  const { contexts, warnings } = cueContexts(loaded)
  const byCue = new Map(contexts.map(context => [context.cue.id, context]))
  const assetRows = loaded.cues
    .map(cue => cue.assetId)
    .filter((id): id is number => id != null)
  const assets = assetRows.length
    ? db.select().from(schema.episodeAudioAssets)
      .where(inArray(schema.episodeAudioAssets.id, assetRows))
      .all()
    : []
  const assetsById = new Map(assets.map(asset => [asset.id, asset]))
  const audioReady = Boolean(options.audioConfigReady)
  const cueIds = loaded.cues.map(cue => cue.id)
  const attachedCueIds = new Set(cueIds.length
    ? db.select({ soundCueId: schema.episodeAudioClips.soundCueId })
      .from(schema.episodeAudioClips)
      .where(and(
        eq(schema.episodeAudioClips.episodeId, episodeId),
        inArray(schema.episodeAudioClips.soundCueId, cueIds),
      ))
      .all()
      .map(row => row.soundCueId)
      .filter((id): id is number => id != null)
    : [])

  const cues: SoundPlanViewCue[] = loaded.cues.map(cue => {
    const context = byCue.get(cue.id)
    const asset = cue.assetId ? assetsById.get(cue.assetId) : undefined
    const assetInfo = asset && asset.url
      ? {
        id: asset.id,
        url: asset.url,
        durationMs: Number(asset.durationMs || 0),
        model: asset.model || '',
        createdAt: asset.createdAt,
        status: asset.status || 'ready',
      }
      : null
    return {
      id: cue.id,
      unit_key: cue.unitKey,
      unit_label: cue.unitLabel || '',
      kind: cue.kind,
      from_shot_number: cue.fromShotNumber ?? null,
      to_shot_number: cue.toShotNumber ?? null,
      from_shot_id: cue.fromShotId,
      to_shot_id: cue.toShotId,
      description: cue.description,
      intensity: cue.intensity || '',
      entry: cue.entry || '',
      exit: cue.exit || '',
      delivery: cue.delivery || 'native',
      start_ms: context?.startMs ?? Number(cue.startMs || 0),
      end_ms: context?.endMs ?? Number(cue.endMs || 0),
      time_source: context?.timeSource ?? 'stored',
      scene_location: context?.sceneLocation || '',
      scene_time: context?.sceneTime || '',
      dialogue_count: context?.dialogueCount || 0,
      source_summary: context?.sourceSummary || '',
      asset: assetInfo,
      generation_status: assetInfo ? 'ready' : (cue.generationStatus || 'idle'),
      generation_error: cue.generationError || '',
      generated_at: cue.generatedAt ?? null,
      can_generate: cueCategory(cue.kind) != null && audioReady,
      can_attach: Boolean(assetInfo) && context?.timeSource === 'timeline',
      attached: attachedCueIds.has(cue.id),
    }
  })

  return {
    plan: {
      id: loaded.plan.id,
      version: loaded.plan.version,
      status: loaded.plan.status,
      delivery: (() => {
        try { return JSON.parse(loaded.plan.planJson || '{}').delivery || 'native' } catch { return 'native' }
      })(),
      summary: (() => {
        try { return JSON.parse(loaded.plan.planJson || '{}').summary || '' } catch { return '' }
      })(),
      created_at: loaded.plan.createdAt,
    },
    cues,
    warnings,
    audio_config_ready: audioReady,
  }
}
