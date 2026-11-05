/**
 * 音色试听 / 自由试音 / 历史（设计 6.2–6.4）。
 *
 * 每次生成都写 voice_samples；当前样音只在显式「设为样例」时更新。
 * 种子优先显式入参，其次音色版本 seed，最后自动分配并写回，保证可复现。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAudioConfig, synthesize, type AudioConfig } from './tts.js'
import { getVoice, updateVoice, type VoiceRow } from './voice-profile.js'
import { collectSampleLines } from './voice-design.js'

export const AUDITION_MAX_CHARS = 300
export const SPEECH_MAX_CHARS = 2000
const KEEP_PER_VOICE = 20

export type VoiceSampleKind = 'audition' | 'speech' | 'clone_test'
export type AuditionTextSource = 'default' | 'custom' | 'line'
export type VoiceSampleRow = typeof schema.voiceSamples.$inferSelect

export interface AuditionText {
  text: string
  source: AuditionTextSource
}

export interface GenerateVoiceSampleInput {
  voiceId: number
  kind?: VoiceSampleKind
  text?: string | null
  textSource?: AuditionTextSource | null
  seed?: number | null
  episodeId?: number | null
  setSample?: boolean
  params?: {
    speed?: number | null
    emotion?: string | null
    language?: string | null
  }
}

export interface VoiceSampleDeps {
  config?: AudioConfig | null
  synthesize?: typeof synthesize
}

export interface GenerateVoiceSampleResult {
  sample: VoiceSampleRow
  text: string
  textSource: AuditionTextSource
  seed: number
  cached: boolean
  truncated: boolean
}

function charCount(text: string): number {
  return [...text].length
}

function normalizeSeed(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const seed = Number(value)
  if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) return null
  return seed
}

function validSpeed(value: unknown): number | null {
  const speed = Number(value)
  return Number.isFinite(speed) && speed >= 0.5 && speed <= 1.5 ? speed : null
}

export function resolveAuditionText(voice: VoiceRow, episodeId?: number | null): AuditionText {
  const saved = String(voice.sampleText || '').trim()
  if (saved) return { text: saved, source: 'default' }

  if (episodeId && voice.characterId) {
    const character = db.select().from(schema.characters).where(eq(schema.characters.id, voice.characterId)).get()
    if (character) {
      const line = collectSampleLines(episodeId).get(character.name)
      if (line?.trim()) return { text: line.trim(), source: 'line' }
    }
  }
  return { text: `我是${voice.name}，很高兴见到你。`, source: 'default' }
}

export function ensureVoiceSeed(voice: VoiceRow): number {
  const existing = normalizeSeed(voice.seed)
  if (existing !== null) return existing
  const seed = 1 + Math.floor(Math.random() * 2_000_000_000)
  updateVoice(voice.id, { seed })
  return seed
}

export function listVoiceSamples(voiceId: number, limit = KEEP_PER_VOICE): VoiceSampleRow[] {
  return db.select().from(schema.voiceSamples)
    .where(and(eq(schema.voiceSamples.voiceId, voiceId), isNull(schema.voiceSamples.deletedAt)))
    .orderBy(desc(schema.voiceSamples.id))
    .limit(Math.max(1, Math.min(limit, 100)))
    .all()
}

function trimSamples(voiceId: number) {
  const rows = listVoiceSamples(voiceId, 100)
  for (const row of rows.slice(KEEP_PER_VOICE)) {
    db.update(schema.voiceSamples).set({ deletedAt: now() }).where(eq(schema.voiceSamples.id, row.id)).run()
  }
}

export function setVoiceSample(voiceId: number, sampleId: number): VoiceRow {
  const sample = db.select().from(schema.voiceSamples)
    .where(and(
      eq(schema.voiceSamples.id, sampleId),
      eq(schema.voiceSamples.voiceId, voiceId),
      isNull(schema.voiceSamples.deletedAt),
    ))
    .get()
  if (!sample || sample.status !== 'ready' || !sample.audioUrl) throw new Error('试听记录不存在或尚未生成完成')
  const updated = updateVoice(voiceId, { sampleUrl: sample.audioUrl, sampleText: sample.text, status: 'ready' })
  if (!updated) throw new Error('音色不存在')
  return updated
}

export function deleteVoiceSample(voiceId: number, sampleId: number): boolean {
  const sample = db.select().from(schema.voiceSamples)
    .where(and(
      eq(schema.voiceSamples.id, sampleId),
      eq(schema.voiceSamples.voiceId, voiceId),
      isNull(schema.voiceSamples.deletedAt),
    ))
    .get()
  if (!sample) return false
  db.update(schema.voiceSamples).set({ deletedAt: now() }).where(eq(schema.voiceSamples.id, sampleId)).run()
  return true
}

export async function generateVoiceSample(
  input: GenerateVoiceSampleInput,
  deps: VoiceSampleDeps = {},
): Promise<GenerateVoiceSampleResult> {
  const voice = getVoice(input.voiceId)
  if (!voice) throw new Error('音色不存在')

  const kind: VoiceSampleKind = input.kind ?? 'audition'
  const maxChars = kind === 'speech' ? SPEECH_MAX_CHARS : AUDITION_MAX_CHARS
  const resolved = resolveAuditionText(voice, input.episodeId)
  const provided = String(input.text ?? '').trim()
  const rawText = provided || resolved.text
  if (!rawText) throw new Error('试听文本不能为空')

  if (kind === 'speech' && charCount(rawText) > maxChars) {
    throw new Error(`自由试音文本不能超过 ${maxChars} 字`)
  }
  const truncated = charCount(rawText) > maxChars
  const text = truncated ? [...rawText].slice(0, maxChars).join('') : rawText
  const textSource: AuditionTextSource = input.textSource ?? (provided ? 'custom' : resolved.source)
  const explicitSeed = normalizeSeed(input.seed)
  const seed = explicitSeed ?? ensureVoiceSeed(voice)
  if (explicitSeed !== null && explicitSeed !== voice.seed) updateVoice(voice.id, { seed: explicitSeed })

  const params = {
    speed: validSpeed(input.params?.speed) ?? validSpeed(voice.speed) ?? 1,
    emotion: input.params?.emotion ?? voice.emotion ?? null,
    language: input.params?.language ?? voice.language ?? null,
    instruct: voice.designInstruct || voice.voicePrompt || null,
  }

  const config = deps.config !== undefined ? deps.config : await getAudioConfig()
  if (!config) {
    updateVoice(voice.id, { status: 'pending_model' })
    const error = new Error('未配置语音服务，请先在设置中添加并启用 audio 服务')
    ;(error as Error & { code?: string }).code = 'no_audio_config'
    throw error
  }

  const created = db.insert(schema.voiceSamples).values({
    voiceId: voice.id,
    dramaId: voice.dramaId,
    kind,
    text,
    textSource,
    seed,
    provider: config.provider,
    model: config.model || voice.model || null,
    paramsJson: JSON.stringify(params),
    status: 'generating',
    createdAt: now(),
  }).run()
  const sampleId = getInsertId(created)

  try {
    const synth = deps.synthesize ?? synthesize
    const result = await synth({
      text,
      voice: {
        externalVoiceId: voice.externalVoiceId || undefined,
        voicePrompt: voice.voicePrompt || undefined,
        designInstruct: voice.designInstruct || undefined,
        refAudioUrl: voice.refAudioUrl || undefined,
        refText: voice.refText || undefined,
        xVectorOnly: Boolean(voice.xVectorOnly),
      },
      speed: params.speed,
      emotion: params.emotion ?? undefined,
      language: params.language ?? undefined,
      seed,
    })
    const sample = db.update(schema.voiceSamples).set({
      audioUrl: result.url,
      durationMs: result.durationMs,
      hash: result.hash,
      status: 'ready',
      error: null,
    }).where(eq(schema.voiceSamples.id, sampleId)).returning().get()!

    trimSamples(voice.id)
    if (input.setSample) setVoiceSample(voice.id, sample.id)
    else if (kind === 'audition') updateVoice(voice.id, { status: 'ready' })

    return { sample, text, textSource, seed, cached: result.cached, truncated }
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 500)
    db.update(schema.voiceSamples).set({ status: 'failed', error: message }).where(eq(schema.voiceSamples.id, sampleId)).run()
    if (kind === 'audition') updateVoice(voice.id, { status: 'failed' })
    throw error
  }
}

/** 自由试音/试听后改派到台词：保留旧音频与 Take，只标 audio_stale */
export function assignVoiceToLines(voiceId: number, episodeId: number, lineIds: number[]): { updated: number } {
  const voice = getVoice(voiceId)
  if (!voice) throw new Error('音色不存在')
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new Error('剧集不存在')
  if (episode.dramaId !== voice.dramaId) throw new Error('音色与剧集不属于同一项目')

  const ids = [...new Set(lineIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))]
  if (!ids.length) return { updated: 0 }

  return db.transaction((tx) => {
    let updated = 0
    for (const lineId of ids) {
      const line = tx.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, lineId)).get()
      if (!line || line.episodeId !== episodeId || line.deletedAt || line.voiceLocked) continue
      tx.update(schema.storyboardLines).set({
        voiceId: voice.id,
        voiceLocked: true,
        audioStale: Boolean(line.audioUrl),
        error: null,
        updatedAt: now(),
      }).where(eq(schema.storyboardLines.id, lineId)).run()
      updated += 1
    }
    return { updated }
  })
}
