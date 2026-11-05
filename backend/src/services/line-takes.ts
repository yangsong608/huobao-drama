/**
 * 台词 Take 生命周期（设计 7.2 / 7.5）。
 *
 * 单句、批量与自动配音都从这里生成：能力裁剪 → 语境/参数快照 → 内容哈希复用
 * → 写 line_takes → 同步激活音频。TTS 协议保持不变，表演指令通过音色 instruct
 * 字段透传（当前通道不支持时记录在 params_json.ignored）。
 */
import crypto from 'crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAudioConfig, normalizeSpeakText, synthesize, type AudioConfig } from './tts.js'
import { capabilitiesFor, type TtsCapability } from './tts-capabilities.js'
import {
  analyzeLinePerformance,
  type AnalyzeLinePerformanceResult,
  type PerformanceParams,
} from './line-performance.js'
import {
  buildLineContext,
  contextHash,
  type ContextMode,
  type LineContext,
} from './line-context.js'
import { getVoice, resolveVoiceForLine, type VoiceRow } from './voice-profile.js'

export type LineRow = typeof schema.storyboardLines.$inferSelect
export type TakeRow = typeof schema.lineTakes.$inferSelect

export interface TakeOverrides extends Partial<PerformanceParams> {
  seed?: number | null
  note?: string | null
  language?: string | null
}

export interface GenerateTakeInput {
  lineId: number
  contextMode?: ContextMode
  overrides?: TakeOverrides
  performance?: PerformanceParams | null
  voiceId?: number | null
  force?: boolean
  reuse?: boolean
  activate?: boolean
}

export interface GenerateTakeDeps {
  config?: AudioConfig | null
  synthesize?: typeof synthesize
  analyze?: typeof analyzeLinePerformance
  capability?: TtsCapability
}

export interface GenerateTakeResult {
  take: TakeRow
  line: LineRow
  cached: boolean
  context: LineContext
  params: PerformanceParams
  source: string
}

const MAX_SEED = 2_147_483_647

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

function normalizeSeed(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const seed = Number(value)
  return Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED ? seed : null
}

function validSpeed(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const speed = Number(value)
  return Number.isFinite(speed) && speed >= 0.5 && speed <= 1.5 ? speed : null
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
  return `{${entries.join(',')}}`
}

export function voiceFingerprint(voice: VoiceRow): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    voice.id,
    voice.updatedAt,
    voice.voicePrompt || '',
    voice.designInstruct || '',
    voice.refAudioUrl || '',
    voice.refText || '',
    Boolean(voice.xVectorOnly),
  ])).digest('hex')
}

function loadLine(lineId: number): LineRow {
  const line = db.select().from(schema.storyboardLines)
    .where(and(eq(schema.storyboardLines.id, lineId), isNull(schema.storyboardLines.deletedAt)))
    .get()
  if (!line) throw new Error('台词不存在')
  return line
}

function reloadLine(lineId: number): LineRow {
  return db.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, lineId)).get()!
}

function markLineFailure(lineId: number, message: string) {
  db.update(schema.storyboardLines)
    .set({ status: 'failed', error: message.slice(0, 500), updatedAt: now() })
    .where(eq(schema.storyboardLines.id, lineId))
    .run()
}

function performanceOverrides(overrides?: TakeOverrides): Partial<PerformanceParams> | undefined {
  if (!overrides) return undefined
  const { seed, note, language, ...rest } = overrides
  return Object.keys(rest).length ? rest : undefined
}

interface ComposedRequest {
  synthParams: any
  ignored: string[]
  sentSpeed: number | null
  sentEmotion: string | null
  sentLanguage: string | null
  sentSeed: number | null
  performanceInstruct: string | null
  requestedSeed: number | null
  voiceRef: Record<string, string | boolean | undefined>
  renderHash: string
}

function composeRequest(input: {
  config: AudioConfig
  capability: TtsCapability
  voice: VoiceRow
  text: string
  params: PerformanceParams
  language: string | null
  seed: number | null
  meta: Record<string, number | undefined>
}): ComposedRequest {
  const { config, capability, voice, text, params } = input
  const ignored = new Set<string>(capability.ignored)

  const sendSpeed = capability.speed && !ignored.has('speed')
  const sendEmotion = capability.emotion && !ignored.has('emotion')
  const sendSeed = capability.seed && !ignored.has('seed')
  if (params.speed !== null && !sendSpeed) ignored.add('speed')
  if (params.emotion && !sendEmotion) ignored.add('emotion')

  const sentSpeed = sendSpeed ? validSpeed(params.speed) : null
  const sentEmotion = sendEmotion ? textOrNull(params.emotion) : null
  const requestedSeed = normalizeSeed(input.seed)
  const sentSeed = sendSeed
    ? requestedSeed ?? normalizeSeed(config.settings?.seed)
    : null
  if (requestedSeed !== null && sentSeed === null) ignored.add('seed')

  const language = textOrNull(input.language)
  const externalVoiceId = voice.externalVoiceId || undefined
  const sendVoicePrompt = capability.voicePrompt && !ignored.has('voicePrompt')
  const sendDesignInstruct = capability.designInstruct && !ignored.has('designInstruct')
  if (!sendVoicePrompt && voice.voicePrompt) ignored.add('voicePrompt')
  if (!sendDesignInstruct && voice.designInstruct) ignored.add('designInstruct')

  const performanceInstruct = textOrNull(params.instruct)
  const sendInstruct = sendDesignInstruct && Boolean(performanceInstruct)
  if (performanceInstruct && !sendInstruct) ignored.add('instruct')

  let voicePrompt = sendVoicePrompt ? textOrNull(voice.voicePrompt) : null
  let designInstruct = sendDesignInstruct ? textOrNull(voice.designInstruct) : null
  if (performanceInstruct && sendInstruct) {
    if (voicePrompt) voicePrompt = `${voicePrompt}；${performanceInstruct}`
    if (designInstruct) designInstruct = `${designInstruct}；${performanceInstruct}`
    if (!voicePrompt && !designInstruct) designInstruct = performanceInstruct
  }

  const sendRef = capability.refAudio && !ignored.has('refAudio')
  if (!sendRef && (voice.refAudioUrl || voice.refText)) ignored.add('refAudio')

  const voiceRef = {
    externalVoiceId,
    voicePrompt: voicePrompt || undefined,
    designInstruct: designInstruct || undefined,
    refAudioUrl: sendRef ? voice.refAudioUrl || undefined : undefined,
    refText: sendRef ? voice.refText || undefined : undefined,
    xVectorOnly: sendRef ? Boolean(voice.xVectorOnly) : undefined,
  }

  const settings = config.settings || {}
  const renderHash = crypto.createHash('sha256').update(stableStringify({
    provider: config.provider,
    model: config.model || voice.model || '',
    config_id: config.id ?? null,
    voice_fingerprint: voiceFingerprint(voice),
    speak_text: normalizeSpeakText(text),
    voice: voiceRef,
    speed: sentSpeed,
    emotion: sentEmotion,
    language,
    seed: sentSeed,
    settings: {
      format: settings.format ?? null,
      sampleRate: settings.sampleRate ?? null,
      resourceId: settings.resourceId ?? null,
      defaultVoiceId: settings.defaultVoiceId ?? null,
      maxNewTokens: settings.maxNewTokens ?? null,
      language: settings.language ?? null,
      seed: settings.seed ?? null,
      emotion: settings.emotion ?? null,
    },
  })).digest('hex')

  return {
    synthParams: {
      text,
      voice: voiceRef,
      speed: sentSpeed ?? undefined,
      emotion: sentEmotion ?? undefined,
      language: language ?? undefined,
      seed: sentSeed ?? undefined,
      configId: config.id,
      meta: input.meta,
    },
    ignored: [...ignored].sort(),
    sentSpeed,
    sentEmotion,
    sentLanguage: language,
    sentSeed,
    performanceInstruct,
    requestedSeed,
    voiceRef,
    renderHash,
  }
}

export function listLineTakes(lineId: number): TakeRow[] {
  return db.select().from(schema.lineTakes)
    .where(and(eq(schema.lineTakes.lineId, lineId), isNull(schema.lineTakes.deletedAt)))
    .orderBy(desc(schema.lineTakes.takeNo))
    .all()
}

export function activateTake(takeId: number): TakeRow {
  const take = db.select().from(schema.lineTakes)
    .where(and(eq(schema.lineTakes.id, takeId), isNull(schema.lineTakes.deletedAt)))
    .get()
  if (!take) throw new Error('Take 不存在')
  if (take.status !== 'ready' || !take.audioUrl) throw new Error('Take 尚未生成完成')

  return db.transaction((tx) => {
    tx.update(schema.lineTakes)
      .set({ isActive: false })
      .where(and(eq(schema.lineTakes.lineId, take.lineId), eq(schema.lineTakes.isActive, true)))
      .run()
    const activated = tx.update(schema.lineTakes)
      .set({ isActive: true })
      .where(eq(schema.lineTakes.id, take.id))
      .returning()
      .get()!
    tx.update(schema.storyboardLines).set({
      audioUrl: take.audioUrl,
      audioDurationMs: take.durationMs,
      audioHash: take.hash,
      voiceId: take.voiceId,
      activeTakeId: take.id,
      status: 'ready',
      audioStale: false,
      error: null,
      updatedAt: now(),
    }).where(eq(schema.storyboardLines.id, take.lineId)).run()
    return activated
  })
}

export function deleteTake(takeId: number): { lineId: number; fallbackTakeId: number | null } {
  const take = db.select().from(schema.lineTakes)
    .where(and(eq(schema.lineTakes.id, takeId), isNull(schema.lineTakes.deletedAt)))
    .get()
  if (!take) throw new Error('Take 不存在')

  return db.transaction((tx) => {
    tx.update(schema.lineTakes)
      .set({ deletedAt: now(), isActive: false })
      .where(eq(schema.lineTakes.id, take.id))
      .run()
    if (!take.isActive) return { lineId: take.lineId, fallbackTakeId: null }

    const fallback = tx.select().from(schema.lineTakes)
      .where(and(
        eq(schema.lineTakes.lineId, take.lineId),
        isNull(schema.lineTakes.deletedAt),
        eq(schema.lineTakes.status, 'ready'),
      ))
      .orderBy(desc(schema.lineTakes.takeNo))
      .all()
      .find(row => Boolean(row.audioUrl))

    if (fallback) {
      tx.update(schema.lineTakes).set({ isActive: true }).where(eq(schema.lineTakes.id, fallback.id)).run()
      tx.update(schema.storyboardLines).set({
        audioUrl: fallback.audioUrl,
        audioDurationMs: fallback.durationMs,
        audioHash: fallback.hash,
        voiceId: fallback.voiceId,
        activeTakeId: fallback.id,
        status: 'ready',
        audioStale: false,
        error: null,
        updatedAt: now(),
      }).where(eq(schema.storyboardLines.id, take.lineId)).run()
      return { lineId: take.lineId, fallbackTakeId: fallback.id }
    }

    tx.update(schema.storyboardLines).set({
      audioUrl: null,
      audioDurationMs: null,
      audioHash: null,
      activeTakeId: null,
      status: 'pending',
      audioStale: false,
      error: null,
      updatedAt: now(),
    }).where(eq(schema.storyboardLines.id, take.lineId)).run()
    return { lineId: take.lineId, fallbackTakeId: null }
  })
}

export function takeStatus(episodeId: number): {
  total: number
  ready: number
  pending: number
  failed: number
  stale: number
  takes: number
} {
  const lines = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .all()
  const takeRows = db.select().from(schema.lineTakes)
    .where(and(
      eq(schema.lineTakes.episodeId, episodeId),
      isNull(schema.lineTakes.deletedAt),
    ))
    .all()
  return {
    total: lines.length,
    ready: lines.filter(row => row.status === 'ready').length,
    pending: lines.filter(row => row.status === 'pending').length,
    failed: lines.filter(row => row.status === 'failed').length,
    stale: lines.filter(row => Boolean(row.audioStale)).length,
    takes: takeRows.length,
  }
}

export async function generateTake(
  input: GenerateTakeInput,
  deps: GenerateTakeDeps = {},
): Promise<GenerateTakeResult> {
  const line = loadLine(input.lineId)
  const mode: ContextMode = input.contextMode === 'off' || input.contextMode === 'deep'
    ? input.contextMode
    : 'light'

  const text = (line.speakText || line.text || '').trim()
  if (!text) {
    markLineFailure(line.id, '台词为空，无法生成')
    throw new Error('台词为空，无法生成')
  }

  const voice = input.voiceId
    ? getVoice(input.voiceId)
    : resolveVoiceForLine({ voiceId: line.voiceId, characterId: line.characterId, dramaId: line.dramaId })
  if (!voice || voice.dramaId !== line.dramaId) {
    markLineFailure(line.id, '没有可用音色，请先在角色面板生成或绑定旁白音色')
    throw new Error('没有可用音色，请先在角色面板生成或绑定旁白音色')
  }

  const config = deps.config !== undefined ? deps.config : await getAudioConfig()
  if (!config) {
    markLineFailure(line.id, '未配置语音服务，请先在设置中添加并启用 audio 服务')
    const error = new Error('未配置语音服务，请先在设置中添加并启用 audio 服务')
    ;(error as Error & { code?: string }).code = 'no_audio_config'
    throw error
  }

  const overrides = input.overrides
  let analysis: Omit<AnalyzeLinePerformanceResult, 'source'> & { source: string }
  if (input.performance) {
    analysis = {
      context: buildLineContext(line.id, mode),
      params: input.performance,
      source: 'manual',
    }
  } else {
    const analyze = deps.analyze ?? analyzeLinePerformance
    analysis = await analyze(line.id, {
      mode,
      overrides: performanceOverrides(overrides),
    })
  }

  const language = textOrNull(overrides?.language) ?? textOrNull(voice.language)
  const seed = overrides?.seed !== undefined ? normalizeSeed(overrides.seed) : normalizeSeed(voice.seed)
  const capability = deps.capability ?? capabilitiesFor(config)
  const composed = composeRequest({
    config,
    capability,
    voice,
    text,
    params: analysis.params,
    language,
    seed,
    meta: {
      dramaId: line.dramaId,
      episodeId: line.episodeId,
      lineId: line.id,
      characterId: line.characterId ?? undefined,
    },
  })

  if (input.reuse && !input.force) {
    const existing = db.select().from(schema.lineTakes)
      .where(and(
        eq(schema.lineTakes.lineId, line.id),
        eq(schema.lineTakes.status, 'ready'),
        isNull(schema.lineTakes.deletedAt),
      ))
      .orderBy(desc(schema.lineTakes.takeNo))
      .all()
      .find((row) => {
        try {
          return JSON.parse(row.paramsJson || '{}').render_hash === composed.renderHash
        } catch {
          return false
        }
      })
    if (existing) {
      const activated = input.activate === false ? existing : activateTake(existing.id)
      return {
        take: activated,
        line: reloadLine(line.id),
        cached: true,
        context: analysis.context,
        params: analysis.params,
        source: analysis.source,
      }
    }
  }

  const contextJson = JSON.stringify(analysis.context)
  const fingerprint = voiceFingerprint(voice)
  const paramsJson = JSON.stringify({
    emotion: composed.sentEmotion,
    speed: composed.sentSpeed,
    language: composed.sentLanguage,
    instruct: composed.performanceInstruct,
    seed: composed.sentSeed,
    requested_seed: composed.requestedSeed,
    pause_hints: analysis.params.pause_hints,
    pronunciation: analysis.params.pronunciation,
    notes: analysis.params.notes,
    note: textOrNull(overrides?.note),
    ignored: composed.ignored,
    render_hash: composed.renderHash,
    context_mode: analysis.context.mode,
  })

  const previous = db.select().from(schema.lineTakes)
    .where(eq(schema.lineTakes.lineId, line.id))
    .orderBy(desc(schema.lineTakes.takeNo))
    .get()
  const created = db.insert(schema.lineTakes).values({
    lineId: line.id,
    episodeId: line.episodeId,
    dramaId: line.dramaId,
    takeNo: (previous?.takeNo ?? 0) + 1,
    text: line.text,
    speakText: text,
    textRevision: line.textRevision ?? 1,
    voiceId: voice.id,
    voiceFingerprint: fingerprint,
    provider: config.provider,
    model: config.model || voice.model || null,
    configId: config.id ?? null,
    paramsJson,
    contextMode: analysis.context.mode,
    contextJson,
    contextHash: contextHash(analysis.context),
    status: 'generating',
    createdAt: now(),
  }).run()
  const takeId = getInsertId(created)

  try {
    const synth = deps.synthesize ?? synthesize
    const result = await synth(composed.synthParams)
    const ready = db.update(schema.lineTakes).set({
      audioUrl: result.url,
      durationMs: result.durationMs,
      hash: result.hash,
      status: 'ready',
      error: null,
    }).where(eq(schema.lineTakes.id, takeId)).returning().get()!
    const take = input.activate === false ? ready : activateTake(ready.id)
    return {
      take,
      line: reloadLine(line.id),
      cached: result.cached,
      context: analysis.context,
      params: analysis.params,
      source: analysis.source,
    }
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 500)
    db.update(schema.lineTakes).set({ status: 'failed', error: message })
      .where(eq(schema.lineTakes.id, takeId))
      .run()
    markLineFailure(line.id, message)
    throw error
  }
}
