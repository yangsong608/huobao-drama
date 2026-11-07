/**
 * 台词表演参数（设计 7.3.3 / 7.4）。
 *
 * light 用规则在零成本下推导；deep 交给文本模型并严格校验，失败回退 light。
 * 两种模式都只产出表演参数，绝不改写台词正文。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getDubbingDefaults } from './app-settings.js'
import { buildLineContext, type ContextMode, type LineContext } from './line-context.js'
import { callTextJson } from './text-call.js'
import { resolveVoiceForLine, type VoiceRow } from './voice-profile.js'

export interface PerformanceParams {
  emotion: string | null
  speed: number
  instruct: string | null
  pause_hints: { after: string; ms: number }[]
  pronunciation: Record<string, string>
  notes: string | null
}

export interface AnalyzeLinePerformanceResult {
  context: LineContext
  params: PerformanceParams
  source: 'light' | 'deep' | 'fallback'
  error?: string
}

export interface AnalyzeLinePerformanceOptions {
  mode?: ContextMode
  overrides?: Partial<PerformanceParams>
  deps?: { callTextJson?: typeof callTextJson }
}

const MAX_PAUSE_MS = 3000
const DEEP_SYSTEM = '你是短剧配音导演。只输出 JSON，不得改写台词，不得把邻句原文写进 instruct。'

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

function validSpeed(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const speed = Number(value)
  return Number.isFinite(speed) && speed >= 0.5 && speed <= 1.5 ? speed : null
}

function sanitizePauseHints(value: unknown): { after: string; ms: number }[] {
  if (!Array.isArray(value)) return []
  const hints: { after: string; ms: number }[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const after = textOrNull((item as any).after)
    const ms = Number((item as any).ms)
    if (!after || !Number.isFinite(ms) || ms <= 0) continue
    hints.push({ after, ms: Math.min(MAX_PAUSE_MS, Math.round(ms)) })
  }
  return hints
}

function sanitizePronunciation(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim()
    const pronunciation = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (key && pronunciation) result[key] = pronunciation
  }
  return result
}

function applyOverrides(
  base: PerformanceParams,
  overrides?: Partial<PerformanceParams>,
): PerformanceParams {
  if (!overrides) return base
  const params: PerformanceParams = {
    ...base,
    pause_hints: base.pause_hints.map(item => ({ ...item })),
    pronunciation: { ...base.pronunciation },
  }
  if (overrides.emotion !== undefined) params.emotion = textOrNull(overrides.emotion)
  if (overrides.speed !== undefined) {
    const speed = validSpeed(overrides.speed)
    if (speed !== null) params.speed = speed
  }
  if (overrides.instruct !== undefined) params.instruct = textOrNull(overrides.instruct)
  if (overrides.pause_hints !== undefined) params.pause_hints = sanitizePauseHints(overrides.pause_hints)
  if (overrides.pronunciation !== undefined) {
    params.pronunciation = {
      ...params.pronunciation,
      ...sanitizePronunciation(overrides.pronunciation),
    }
  }
  if (overrides.notes !== undefined) params.notes = textOrNull(overrides.notes)
  return params
}

function lightParams(
  line: typeof schema.storyboardLines.$inferSelect,
  voice: VoiceRow | null,
  context: LineContext,
): PerformanceParams {
  const defaults = getDubbingDefaults()
  return {
    emotion: textOrNull(line.emotion) ?? textOrNull(voice?.emotion) ?? null,
    speed: validSpeed(line.speed) ?? validSpeed(voice?.speed) ?? validSpeed(defaults.voiceSpeed) ?? 1,
    instruct: textOrNull(line.direction),
    pause_hints: [],
    pronunciation: { ...context.pronunciation },
    notes: null,
  }
}

function deepPrompt(context: LineContext): string {
  return [
    '根据以下语境，为「当前台词」设计表演参数。',
    JSON.stringify(context, null, 2),
    [
      '只输出 JSON 对象，字段：',
      'emotion: 中文情绪词；',
      'speed: 0.5–1.5 的数字；',
      'instruct: 中文表演指令（音色、语气、停顿），不得复述邻句原文；',
      'pause_hints: [{ after: 台词中的词, ms: 毫秒 }]；',
      'pronunciation: { 词: 拼音 }；',
      'notes: 一句话表演说明。',
    ].join('\n'),
  ].join('\n\n')
}

function deepParams(
  raw: unknown,
  base: PerformanceParams,
): PerformanceParams {
  const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const pronunciation = sanitizePronunciation(data.pronunciation)
  return {
    emotion: textOrNull(data.emotion) ?? base.emotion,
    speed: validSpeed(data.speed) ?? base.speed,
    instruct: textOrNull(data.instruct) ?? base.instruct,
    pause_hints: Array.isArray(data.pause_hints)
      ? sanitizePauseHints(data.pause_hints)
      : base.pause_hints,
    pronunciation: { ...base.pronunciation, ...pronunciation },
    notes: textOrNull(data.notes),
  }
}

export async function analyzeLinePerformance(
  lineId: number,
  options: AnalyzeLinePerformanceOptions = {},
): Promise<AnalyzeLinePerformanceResult> {
  const line = db.select().from(schema.storyboardLines)
    .where(and(eq(schema.storyboardLines.id, lineId), isNull(schema.storyboardLines.deletedAt)))
    .get()
  if (!line) throw new Error('台词不存在')

  const mode = options.mode === 'off' || options.mode === 'deep' ? options.mode : 'light'
  const context = buildLineContext(lineId, mode)
  const voice = resolveVoiceForLine({
    voiceId: line.voiceId,
    characterId: line.characterId,
    dramaId: line.dramaId,
    lineId: line.id,
  })
  const base = applyOverrides(lightParams(line, voice, context), options.overrides)

  if (mode !== 'deep') {
    return { context, params: base, source: 'light' }
  }

  try {
    const call = options.deps?.callTextJson ?? callTextJson
    const { data } = await call({
      system: DEEP_SYSTEM,
      prompt: deepPrompt(context),
      responseFormat: 'json',
      temperature: 0.3,
      maxTokens: 800,
      timeoutMs: 60_000,
    })
    const params = applyOverrides(deepParams(data, base), options.overrides)
    return { context, params, source: 'deep' }
  } catch (error: any) {
    return {
      context,
      params: base,
      source: 'fallback',
      error: String(error?.message || error).slice(0, 500),
    }
  }
}
