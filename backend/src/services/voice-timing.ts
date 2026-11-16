/**
 * Voice Timing Profile：计划期只用真实配音证据估算台词时长，不生成新 TTS。
 *
 * 证据来自两条既有链路：
 * - 音色试听 `voice_samples`（设计/克隆阶段的真实样音）
 * - 已生成的台词 Take `line_takes`（生产阶段的真实成品）
 *
 * 拟合 duration = pause + chars / rate；单样本时退回观测语速。
 * 没有证据的角色使用全局默认值，并在计划诊断里明确标为 default。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { speechTextChars } from './dialogue-timing.js'
import {
  fitVoiceTiming,
  type VoiceTimingProfile,
  type VoiceTimingSample,
} from './voice-timing-fit.js'

export type { VoiceTimingFit, VoiceTimingProfile, VoiceTimingSample } from './voice-timing-fit.js'
export { estimateLineSeconds, fitVoiceTiming } from './voice-timing-fit.js'

interface Evidence {
  samples: VoiceTimingSample[]
  characterId: number | null
  voiceId: number | null
  source: 'line_takes' | 'voice_samples'
}

function addEvidence(
  evidence: Map<string, Evidence>,
  speaker: string,
  sample: VoiceTimingSample,
  meta: { characterId: number | null; voiceId: number | null; source: Evidence['source'] },
) {
  const key = String(speaker || '').trim()
  if (!key) return
  const current = evidence.get(key)
  if (!current) {
    evidence.set(key, { samples: [sample], ...meta })
    return
  }
  current.samples.push(sample)
  if (current.samples.length > 12) current.samples.shift()
  current.characterId = current.characterId ?? meta.characterId
  current.voiceId = current.voiceId ?? meta.voiceId
  if (meta.source === 'line_takes') current.source = 'line_takes'
}

function speakerOfLine(row: {
  characterId: number | null
  speakerType: string | null
  speakerName: string | null
}, characterNames: Map<number, string>, aliasToCanonical: Map<string, string>): string {
  if (row.characterId && characterNames.has(row.characterId)) return characterNames.get(row.characterId)!
  if (row.speakerType === 'narration' || row.speakerType === 'inner') return '旁白'
  const raw = String(row.speakerName || '').trim()
  return raw ? (aliasToCanonical.get(raw) || raw) : '旁白'
}

function characterAliases(name: string): string[] {
  const canonical = String(name || '').trim()
  if (!canonical) return []
  const aliases = new Set<string>([canonical])
  const base = canonical.replace(/[（(].*?[）)]/g, '').trim()
  if (base.length >= 2) aliases.add(base)
  for (const match of canonical.matchAll(/[（(]([^）)]+)[）)]/g)) {
    for (const part of match[1].split(/[\/、,，]/)) {
      const alias = part.trim()
      if (alias.length >= 2) aliases.add(alias)
    }
  }
  return [...aliases]
}

/** 读取项目内角色/旁白的真实配音证据，生成按说话人索引的语速档案。 */
export async function collectVoiceTimingProfiles(dramaId: number): Promise<Record<string, VoiceTimingProfile>> {
  const characters = db.select({ id: schema.characters.id, name: schema.characters.name })
    .from(schema.characters)
    .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
    .all()
  const characterNames = new Map(characters.map(character => [character.id, character.name]))
  const aliasesByCanonical = new Map(characters.map(character => [character.name, characterAliases(character.name)]))
  const aliasToCanonical = new Map<string, string>()
  for (const character of characters) {
    for (const alias of aliasesByCanonical.get(character.name) || [character.name]) {
      if (!aliasToCanonical.has(alias)) aliasToCanonical.set(alias, character.name)
    }
  }

  const voices = db.select().from(schema.characterVoices)
    .where(and(eq(schema.characterVoices.dramaId, dramaId), isNull(schema.characterVoices.deletedAt)))
    .all()
  const voiceById = new Map(voices.map(voice => [voice.id, voice]))

  const evidence = new Map<string, Evidence>()

  const samples = db.select({
    voiceId: schema.voiceSamples.voiceId,
    text: schema.voiceSamples.text,
    durationMs: schema.voiceSamples.durationMs,
  }).from(schema.voiceSamples)
    .where(and(
      eq(schema.voiceSamples.dramaId, dramaId),
      eq(schema.voiceSamples.status, 'ready'),
      isNull(schema.voiceSamples.deletedAt),
    ))
    .orderBy(desc(schema.voiceSamples.createdAt))
    .limit(400)
    .all()
  for (const sample of samples) {
    const durationSeconds = Number(sample.durationMs) / 1000
    const voice = voiceById.get(sample.voiceId)
    const speaker = voice
      ? (voice.scope === 'narrator' ? '旁白' : (voice.characterId ? characterNames.get(voice.characterId) || voice.name : voice.name))
      : ''
    if (!speaker) continue
    addEvidence(evidence, speaker, { chars: speechTextChars(sample.text), durationSeconds }, {
      characterId: voice?.characterId ?? null,
      voiceId: sample.voiceId,
      source: 'voice_samples',
    })
  }

  const takes = db.select({
    text: schema.lineTakes.text,
    speakText: schema.lineTakes.speakText,
    durationMs: schema.lineTakes.durationMs,
    voiceId: schema.lineTakes.voiceId,
    characterId: schema.storyboardLines.characterId,
    speakerType: schema.storyboardLines.speakerType,
    speakerName: schema.storyboardLines.speakerName,
  }).from(schema.lineTakes)
    .innerJoin(schema.storyboardLines, eq(schema.storyboardLines.id, schema.lineTakes.lineId))
    .where(and(
      eq(schema.lineTakes.dramaId, dramaId),
      eq(schema.lineTakes.status, 'ready'),
      eq(schema.lineTakes.isActive, true),
      isNull(schema.lineTakes.deletedAt),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .orderBy(desc(schema.lineTakes.createdAt))
    .limit(800)
    .all()
  for (const take of takes) {
    const durationSeconds = Number(take.durationMs) / 1000
    const speaker = speakerOfLine(take, characterNames, aliasToCanonical)
    addEvidence(evidence, speaker, {
      chars: speechTextChars(take.speakText || take.text),
      durationSeconds,
    }, {
      characterId: take.characterId ?? null,
      voiceId: take.voiceId ?? null,
      source: 'line_takes',
    })
  }

  const profiles: Record<string, VoiceTimingProfile> = {}
  for (const [speaker, item] of evidence) {
    const fit = fitVoiceTiming(item.samples)
    if (!fit) continue
    const profile: VoiceTimingProfile = {
      speaker,
      ...fit,
      characterId: item.characterId,
      voiceId: item.voiceId,
      sampleCount: item.samples.length,
      source: item.source,
    }
    const aliases = aliasesByCanonical.get(speaker) || [speaker]
    for (const alias of aliases) profiles[alias] = profile
  }
  return profiles
}