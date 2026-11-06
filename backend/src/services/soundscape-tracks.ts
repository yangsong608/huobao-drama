/**
 * 声音场景生成轨与片段放置
 *
 * 每类一条 origin='soundscape' 的生成轨；按类别幂等重建片段。
 * assets-only 不触碰轨道；群众台词只引用激活 Take，不生成音频。
 */
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { createAudioClip, createAudioTrack } from './audio-tracks.js'
import { ensureDefaultBuses } from './mix-plan.js'
import type {
  SoundscapeCategory,
  SoundscapeItem,
  SoundscapeMode,
  SoundscapePlan,
} from './soundscape-compiler.js'

type TrackRow = typeof schema.episodeAudioTracks.$inferSelect

export const SOUNDSCAPE_CATEGORY_ORDER: SoundscapeCategory[] = ['ambience', 'sfx', 'crowd', 'bgm']

export const SOUNDSCAPE_TRACK_PRESETS: Record<SoundscapeCategory, {
  kind: string
  role: string
  name: string
  busKey: 'original' | 'sfx' | 'dialogue' | 'bgm'
  color: string
  volume: number
}> = {
  ambience: { kind: 'ambience', role: 'ambience', name: '环境声（AI）', busKey: 'original', color: '#0ea5e9', volume: 0.7 },
  sfx: { kind: 'sfx', role: 'sfx', name: '场景音效（AI）', busKey: 'sfx', color: '#a78bfa', volume: 0.8 },
  crowd: { kind: 'voice', role: 'crowd', name: '群众声（AI）', busKey: 'dialogue', color: '#f59e0b', volume: 0.5 },
  bgm: { kind: 'bgm', role: 'bgm', name: '配乐（AI）', busKey: 'bgm', color: '#22c55e', volume: 1 },
}

export interface SoundscapeAssetRef {
  id: number
  url: string
}

export interface SoundscapeLineRef {
  lineId: number
  lineNo: number
  speaker: string
  startMs: number
  durationMs: number
  audioUrl: string | null
  takeId: number | null
}

export interface ApplySoundscapePlanInput {
  episodeId: number
  mode: SoundscapeMode
  plan: SoundscapePlan
  succeededCategories: Set<SoundscapeCategory>
  assetsByHash: Map<string, SoundscapeAssetRef>
  lineRefs: Map<number, SoundscapeLineRef>
}

export interface ApplySoundscapePlanResult {
  trackIds: number[]
  clipCount: number
  warnings: string[]
}

function sceneName(plan: SoundscapePlan, sceneId: number | null): string {
  if (sceneId == null) return '整集'
  return `场景 ${plan.sceneLabels[sceneId] ?? sceneId}`
}

function fadeFor(item: SoundscapeItem, totalMs: number): { fadeInMs: number; fadeOutMs: number } {
  const duration = item.category === 'bgm' ? 800 : 300
  return {
    fadeInMs: item.startMs <= 0 ? 0 : duration,
    fadeOutMs: item.endMs >= totalMs ? 0 : duration,
  }
}

export function applySoundscapePlan(input: ApplySoundscapePlanInput): ApplySoundscapePlanResult {
  if (input.mode === 'assets-only') return { trackIds: [], clipCount: 0, warnings: [] }

  const warnings: string[] = []
  const totalMs = input.plan.items.reduce((max, item) => Math.max(max, item.endMs), 0)
  const buses = ensureDefaultBuses(input.episodeId)
  const busByKey = new Map(buses.map((bus) => [bus.key, bus.id]))
  const existing = db.select().from(schema.episodeAudioTracks)
    .where(and(
      eq(schema.episodeAudioTracks.episodeId, input.episodeId),
      eq(schema.episodeAudioTracks.origin, 'soundscape'),
    ))
    .all()

  const ensureTrack = (category: SoundscapeCategory): TrackRow => {
    const preset = SOUNDSCAPE_TRACK_PRESETS[category]
    const found = existing.find((track) => track.role === preset.role)
    if (found) return found
    const created = createAudioTrack(input.episodeId, {
      kind: preset.kind,
      role: preset.role,
      name: preset.name,
      volume: preset.volume,
      pan: 0,
      busId: busByKey.get(preset.busKey) ?? null,
      ducking: true,
      color: preset.color,
      height: 72,
      origin: 'soundscape',
    })
    existing.push(created)
    return created
  }

  let clipCount = 0
  const trackIds: number[] = []
  for (const category of SOUNDSCAPE_CATEGORY_ORDER) {
    if (!input.succeededCategories.has(category)) continue
    const preset = SOUNDSCAPE_TRACK_PRESETS[category]
    const track = ensureTrack(category)
    trackIds.push(track.id)
    // 重建片段必须原子：中途失败时回滚到旧片段，不能留下空轨
    let added = 0
    db.transaction(() => {
      db.delete(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.trackId, track.id)).run()

      for (const item of input.plan.items.filter((entry) => entry.category === category)) {
        if (item.source === 'lines') {
          for (const lineId of item.lineIds) {
            const ref = input.lineRefs.get(lineId)
            if (!ref || !ref.audioUrl) {
              warnings.push(`第 ${ref?.lineNo ?? lineId} 句群众台词尚未配音，已跳过`)
              continue
            }
            const startMs = Math.max(0, Math.round(ref.startMs))
            const endMs = startMs + Math.max(50, Math.round(ref.durationMs || 0))
            createAudioClip(input.episodeId, track.id, {
              startMs,
              endMs,
              sourceStartMs: 0,
              gainDb: 0,
              pan: 0,
              fadeInMs: 300,
              fadeOutMs: 300,
              loop: false,
              color: preset.color,
              name: `群众台词 · ${ref.speaker || '群众'}`,
              takeId: ref.takeId,
              lineId: ref.lineId,
              audioUrl: ref.audioUrl,
            })
            added += 1
          }
          continue
        }

        const asset = input.assetsByHash.get(item.sourceHash)
        if (!asset) {
          warnings.push(`生成项 ${item.itemId} 缺少素材，已跳过`)
          continue
        }
        const color = preset.color
        if (category === 'sfx') {
          const sceneId = item.sceneId
          const first = sceneId == null ? null : input.plan.sceneFirstStoryboards[sceneId]
          const startMs = (first?.startMs ?? item.startMs) + 150
          const endMs = Math.min(startMs + item.seconds * 1000, first?.endMs ?? item.endMs)
          if (endMs - startMs < 500) {
            warnings.push(`${sceneName(input.plan, sceneId)}的音效片段过短，已跳过`)
            continue
          }
          createAudioClip(input.episodeId, track.id, {
            startMs,
            endMs,
            sourceStartMs: 0,
            gainDb: 0,
            pan: 0,
            fadeInMs: 300,
            fadeOutMs: 300,
            loop: false,
            color,
            name: `${sceneName(input.plan, sceneId)} · 音效`,
            assetId: asset.id,
            audioUrl: asset.url,
          })
          added += 1
          continue
        }

        const fades = fadeFor(item, totalMs)
        const name = category === 'bgm'
          ? '整集配乐'
          : category === 'crowd'
            ? `${sceneName(input.plan, item.sceneId)} · 群众声`
            : item.sceneId == null
              ? '整集环境声'
              : `${sceneName(input.plan, item.sceneId)} · 环境声`
        createAudioClip(input.episodeId, track.id, {
          startMs: Math.max(0, Math.round(item.startMs)),
          endMs: Math.max(item.startMs + 50, Math.round(item.endMs)),
          sourceStartMs: 0,
          gainDb: 0,
          pan: 0,
          fadeInMs: fades.fadeInMs,
          fadeOutMs: fades.fadeOutMs,
          loop: item.loop,
          color,
          name,
          assetId: asset.id,
          audioUrl: asset.url,
        })
        added += 1
      }
    })
    clipCount += added
  }

  return { trackIds, clipCount, warnings }
}
