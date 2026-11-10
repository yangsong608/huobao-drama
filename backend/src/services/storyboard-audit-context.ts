/**
 * 分镜动作检验 · 上下文构建
 *
 * 把一集分镜整理成规则层输入、语义窗口、只读保护和指纹：
 * - 窗口按分镜号每 16 个目标、步长 15 重叠规划，窗口外降级为仅规则；
 * - 没有数据库台词时从 video_prompt 派生只读台词（id 为空，不参与台词指纹）；
 * - 只读保护覆盖帧/视频/字幕资产、台词音频/锁定/Take 和进行中的生成任务。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import { parseVideoPrompt, type CastMember } from './dialogue-lines.js'
import {
  getStoryboardAuditPolicy,
  storyboardAuditRuleOptions,
  type StoryboardAuditPolicy,
} from './app-settings.js'
import { getMaxSegmentSeconds } from './breakdown-methods.js'
import {
  parsePromptSegments,
  planAuditWindows,
  type AuditAssetCatalog,
  type AuditIssue,
  type AuditLineInput,
  type AuditShotInput,
  type AuditWindowPlan,
  type ParsedPromptSegment,
  type StoryboardRuleInput,
} from './storyboard-audit-rules.js'

export const AUDIT_SCRIPT_CONTEXT_LIMIT = 6000
const ASSET_NAME_LIMIT = 120

export type AuditLineOrigin = 'db' | 'prompt'

export interface AuditContextLine extends AuditLineInput {
  id: number | null
  lineNo: number | null
  speakerType: string | null
  speakerName: string | null
  characterId: number | null
  text: string
  speakText: string | null
  origin: AuditLineOrigin
  audioUrl: string | null
  audioDurationMs: number | null
  plannedStartMs: number | null
  plannedEndMs: number | null
  voiceDurationMs: number | null
  locked: boolean
  voiceLocked: boolean
  activeTakeId: number | null
  hasReadyTake: boolean
}

export interface AuditBoundAssetView {
  id: number
  name: string
  imageUrl: string | null
  deleted: boolean
  linked: boolean
}

export type AuditProtectionReason =
  | 'frame_asset'
  | 'video_asset'
  | 'subtitle_asset'
  | 'line_audio'
  | 'line_locked'
  | 'active_take'
  | 'active_task'

export interface AuditShotProtection {
  readOnly: boolean
  reasons: AuditProtectionReason[]
}

export interface AuditContextShot {
  id: number
  storyboardNumber: number
  title: string | null
  sceneId: number | null
  location: string | null
  time: string | null
  shotType: string | null
  angle: string | null
  movement: string | null
  result: string | null
  atmosphere: string | null
  description: string | null
  imagePrompt: string | null
  videoPrompt: string | null
  transition: string | null
  transitionKind: string | null
  transitionText: string | null
  transitionSubtitle: string | null
  continuity: string | null
  duration: number
  composedImage: string | null
  firstFrameImage: string | null
  lastFrameImage: string | null
  referenceImages: string | null
  videoUrl: string | null
  composedVideoUrl: string | null
  subtitleUrl: string | null
  sceneAsset: AuditBoundAssetView | null
  characterAssets: AuditBoundAssetView[]
  propAssets: AuditBoundAssetView[]
  lines: AuditContextLine[]
  protection: AuditShotProtection
  ruleInput: AuditShotInput
  fingerprint: string
}

export interface AuditContinuityPair {
  key: string
  index: number
  from: AuditContextShot
  to: AuditContextShot
  bridge: AuditContextShot[]
  crossCard: boolean
  windowIndex: number
  fingerprint: string
}

export interface AuditWindowContext {
  index: number
  targets: AuditContextShot[]
  contextBefore: AuditContextShot | null
  contextAfter: AuditContextShot | null
  fromShotNumber: number
  toShotNumber: number
  pairs: AuditContinuityPair[]
  fingerprint: string
}

export interface AuditEpisodeContext {
  episodeId: number
  dramaId: number
  episodeTitle: string
  episodeDuration: number
  /** 当前拆分方式单段时长上限，修复延长时长时不得突破 */
  maxSegmentSeconds: number
  script: string
  scriptTruncated: boolean
  cast: CastMember[]
  assets: AuditAssetCatalog
  shots: AuditContextShot[]
  windows: AuditWindowContext[]
  continuityPairs: AuditContinuityPair[]
  transitionIds: number[]
  ruleOnlyIds: number[]
  semanticTruncated: boolean
  policy: StoryboardAuditPolicy
  ruleInput: StoryboardRuleInput
  fingerprints: {
    shots: Record<string, string>
    lines: Record<string, string>
  }
}

export interface AuditFingerprintSnapshot {
  episodeId: number
  shots: Record<string, string>
  lines: Record<string, string>
}

export interface BuildAuditContextOptions {
  fileExists?: (relativePath: string) => boolean
  scriptLimit?: number
  policy?: StoryboardAuditPolicy
}

export interface AuditShotFingerprintInput {
  storyboardNumber?: number | null
  title?: string | null
  description?: string | null
  videoPrompt?: string | null
  shotType?: string | null
  angle?: string | null
  movement?: string | null
  transition?: string | null
  transitionKind?: string | null
  transitionText?: string | null
  transitionSubtitle?: string | null
  continuity?: string | null
  duration?: number | null
  result?: string | null
  atmosphere?: string | null
  imagePrompt?: string | null
  sceneId?: number | null
  location?: string | null
  time?: string | null
  referenceImages?: string | null
  composedImage?: string | null
  firstFrameImage?: string | null
  lastFrameImage?: string | null
  videoUrl?: string | null
  composedVideoUrl?: string | null
  subtitleUrl?: string | null
  characterIds?: number[]
  propIds?: number[]
}

export interface AuditLineFingerprintInput {
  text?: string | null
  speakText?: string | null
  speakerType?: string | null
  speakerName?: string | null
  characterId?: number | null
  plannedStartMs?: number | null
  plannedEndMs?: number | null
  voiceStartMs?: number | null
  voiceDurationMs?: number | null
  audioUrl?: string | null
  audioDurationMs?: number | null
  activeTakeId?: number | null
  locked?: boolean | null
  voiceLocked?: boolean | null
  textRevision?: number | null
  hasReadyTake?: boolean
}

const EXTERNAL_FILE_RE = /^(?:(?:https?:)?\/\/|data:)/i
const ACTIVE_TASK_TYPES = ['image', 'video', 'audio'] as const

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function stableHash(values: unknown[]): string {
  return sha1(JSON.stringify(values))
}

function asText(value: string | null | undefined): string {
  return value == null ? '' : String(value)
}

function sortIds(values: number[] | null | undefined): number[] {
  return [...new Set((values ?? []).filter((id) => Number.isFinite(id) && id > 0))].sort((left, right) => left - right)
}

function chunkValues<T>(values: T[], size = 400): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

function defaultFileExists(relativePath: string): boolean {
  const value = (relativePath || '').trim()
  if (!value) return false
  if (EXTERNAL_FILE_RE.test(value)) return true
  try {
    return existsSync(getAbsolutePath(value))
  } catch {
    return false
  }
}

function referenceImageCount(raw: string | null | undefined): number {
  const value = (raw || '').trim()
  if (!value) return 0
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return 1
    return parsed.filter((item) => typeof item === 'string' && item.trim()).length
  } catch {
    return 1
  }
}

export function computeAuditShotFingerprint(shot: AuditShotFingerprintInput): string {
  return stableHash([
    shot.storyboardNumber ?? 0,
    asText(shot.title),
    asText(shot.description),
    asText(shot.videoPrompt),
    asText(shot.shotType),
    asText(shot.angle),
    asText(shot.movement),
    asText(shot.transition),
    asText(shot.transitionKind),
    asText(shot.transitionText),
    asText(shot.transitionSubtitle),
    asText(shot.continuity),
    shot.duration ?? 0,
    asText(shot.result),
    asText(shot.atmosphere),
    asText(shot.imagePrompt),
    shot.sceneId ?? null,
    asText(shot.location),
    asText(shot.time),
    asText(shot.referenceImages),
    asText(shot.composedImage),
    asText(shot.firstFrameImage),
    asText(shot.lastFrameImage),
    asText(shot.videoUrl),
    asText(shot.composedVideoUrl),
    asText(shot.subtitleUrl),
    sortIds(shot.characterIds),
    sortIds(shot.propIds),
  ])
}

export function computeAuditLineFingerprint(line: AuditLineFingerprintInput): string {
  return stableHash([
    asText(line.text),
    asText(line.speakText),
    asText(line.speakerType),
    asText(line.speakerName),
    line.characterId ?? null,
    line.plannedStartMs ?? null,
    line.plannedEndMs ?? null,
    line.voiceStartMs ?? null,
    line.voiceDurationMs ?? null,
    asText(line.audioUrl),
    line.audioDurationMs ?? null,
    line.activeTakeId ?? null,
    Boolean(line.locked),
    Boolean(line.voiceLocked),
    line.textRevision ?? null,
    Boolean(line.hasReadyTake),
  ])
}

function truncateScript(raw: string, limit: number): { script: string; truncated: boolean } {
  const script = raw.trim()
  if (!script) return { script: '', truncated: false }
  if (script.length <= limit) return { script, truncated: false }
  return {
    script: `${script.slice(0, limit).trimEnd()}\n\n（剧本超过 ${limit} 字，已截断）`,
    truncated: true,
  }
}

function loadEpisode(episodeId: number) {
  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, episodeId))
    .get()
  if (!episode || episode.deletedAt) throw new Error('剧集不存在或已删除')
  return episode
}

function liveStoryboards(episodeId: number) {
  return db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber, schema.storyboards.id)
    .all()
}

function loadBindings(table: typeof schema.storyboardCharacters | typeof schema.storyboardProps, shotIds: number[]) {
  const map = new Map<number, number[]>()
  for (const batch of chunkValues(shotIds)) {
    if (!batch.length) continue
    const rows = db.select().from(table).where(inArray(table.storyboardId, batch)).all()
    for (const row of rows) {
      const key = row.storyboardId as number
      const assetId = (row as { characterId?: number; propId?: number }).characterId
        ?? (row as { propId?: number }).propId
      if (assetId == null) continue
      const group = map.get(key) || []
      group.push(assetId)
      map.set(key, group)
    }
  }
  return map
}

function loadEpisodeLinks(episodeId: number) {
  const characters = db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
  const scenes = db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
  const props = db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId)).all()
  return {
    characterIds: characters.map((row) => row.characterId),
    sceneIds: scenes.map((row) => row.sceneId),
    propIds: props.map((row) => row.propId),
  }
}

function loadReadyTakes(lineIds: number[]) {
  const byId = new Set<number>()
  const activeByLine = new Set<number>()
  for (const batch of chunkValues(lineIds)) {
    if (!batch.length) continue
    const rows = db.select().from(schema.lineTakes)
      .where(and(
        inArray(schema.lineTakes.lineId, batch),
        eq(schema.lineTakes.status, 'ready'),
        isNull(schema.lineTakes.deletedAt),
      ))
      .all()
    for (const row of rows) {
      byId.add(row.id)
      if (row.isActive) activeByLine.add(row.lineId)
    }
  }
  return { byId, activeByLine }
}

function loadActiveTaskShotIds(episodeId: number, shotIds: number[]) {
  const active = new Set<number>()
  for (const batch of chunkValues(shotIds)) {
    if (!batch.length) continue
    const rows = db.select().from(schema.sysTask)
      .where(and(
        eq(schema.sysTask.episodeId, episodeId),
        eq(schema.sysTask.status, 'processing'),
        inArray(schema.sysTask.type, [...ACTIVE_TASK_TYPES]),
        inArray(schema.sysTask.storyboardId, batch),
      ))
      .all()
    for (const row of rows) {
      if (row.storyboardId != null) active.add(row.storyboardId)
    }
  }
  return active
}

function assetView(
  id: number,
  asset: { id: number; name: string; imageUrl?: string | null; deletedAt?: string | null } | undefined,
  linked: boolean,
): AuditBoundAssetView {
  if (!asset) {
    return {
      id,
      name: `未知资产#${id}`,
      imageUrl: null,
      deleted: true,
      linked: false,
    }
  }
  return {
    id: asset.id,
    name: (asset.name || '').slice(0, ASSET_NAME_LIMIT) || `资产#${asset.id}`,
    imageUrl: asset.imageUrl ?? null,
    deleted: Boolean(asset.deletedAt),
    linked,
  }
}

function protectionReasons(
  shot: typeof schema.storyboards.$inferSelect,
  lines: AuditContextLine[],
  activeTaskIds: Set<number>,
): AuditProtectionReason[] {
  const reasons: AuditProtectionReason[] = []
  if (asText(shot.composedImage).trim()
    || asText(shot.firstFrameImage).trim()
    || asText(shot.lastFrameImage).trim()
    || referenceImageCount(shot.referenceImages) > 0) {
    reasons.push('frame_asset')
  }
  if (asText(shot.videoUrl).trim() || asText(shot.composedVideoUrl).trim()) reasons.push('video_asset')
  if (asText(shot.subtitleUrl).trim()) reasons.push('subtitle_asset')
  if (lines.some((line) => asText(line.audioUrl).trim() || (line.audioDurationMs ?? 0) > 0)) reasons.push('line_audio')
  if (lines.some((line) => line.locked || line.voiceLocked)) reasons.push('line_locked')
  if (lines.some((line) => line.hasReadyTake)) reasons.push('active_take')
  if (activeTaskIds.has(shot.id)) reasons.push('active_task')
  return reasons
}

function dbLinesByShot(episodeId: number) {
  const rows = db.select().from(schema.storyboardLines)
    .where(and(eq(schema.storyboardLines.episodeId, episodeId), isNull(schema.storyboardLines.deletedAt)))
    .orderBy(schema.storyboardLines.sortOrder, schema.storyboardLines.lineNo, schema.storyboardLines.id)
    .all()
  const map = new Map<number, (typeof rows)[number][]>()
  for (const row of rows) {
    if (row.storyboardId == null) continue
    const group = map.get(row.storyboardId) || []
    group.push(row)
    map.set(row.storyboardId, group)
  }
  return { rows, map }
}

function toContextLine(row: (typeof schema.storyboardLines.$inferSelect), readyTakes: {
  byId: Set<number>
  activeByLine: Set<number>
}): AuditContextLine {
  const hasReadyTake = (row.activeTakeId != null && readyTakes.byId.has(row.activeTakeId))
    || readyTakes.activeByLine.has(row.id)
  return {
    id: row.id,
    storyboardId: row.storyboardId,
    lineNo: row.lineNo,
    speakerType: row.speakerType,
    speakerName: row.speakerName,
    characterId: row.characterId,
    text: row.text,
    speakText: row.speakText,
    origin: 'db',
    audioUrl: row.audioUrl,
    audioDurationMs: row.audioDurationMs,
    plannedStartMs: row.plannedStartMs,
    plannedEndMs: row.plannedEndMs,
    voiceDurationMs: row.voiceDurationMs,
    locked: Boolean(row.locked),
    voiceLocked: Boolean(row.voiceLocked),
    activeTakeId: row.activeTakeId,
    hasReadyTake,
  }
}

function derivedLines(shot: typeof schema.storyboards.$inferSelect, cast: CastMember[]): AuditContextLine[] {
  const prompt = asText(shot.videoPrompt).trim()
  if (!prompt) return []
  const parsed = parseVideoPrompt(prompt, { cast, durationMs: Math.round((shot.duration || 0) * 1000) })
  return parsed.map((line) => ({
    id: null,
    storyboardId: shot.id,
    lineNo: line.lineNo,
    speakerType: line.speakerType,
    speakerName: line.speakerName,
    characterId: line.characterId,
    text: line.text,
    speakText: line.speakText,
    origin: 'prompt',
    audioUrl: null,
    audioDurationMs: null,
    plannedStartMs: line.plannedStartMs,
    plannedEndMs: line.plannedEndMs,
    voiceDurationMs: null,
    locked: false,
    voiceLocked: false,
    activeTakeId: null,
    hasReadyTake: false,
  }))
}

function buildShotFingerprint(shot: typeof schema.storyboards.$inferSelect, characterIds: number[], propIds: number[]) {
  return computeAuditShotFingerprint({
    ...shot,
    characterIds,
    propIds,
  })
}

export function buildAuditEpisodeContext(
  episodeId: number,
  options: BuildAuditContextOptions = {},
): AuditEpisodeContext {
  if (!Number.isFinite(episodeId) || episodeId <= 0) throw new Error('剧集不存在或已删除')
  const episode = loadEpisode(episodeId)
  const policy = options.policy ?? getStoryboardAuditPolicy()
  const ruleOptions = storyboardAuditRuleOptions(policy)
  const fileExists = options.fileExists ?? defaultFileExists
  const scriptLimit = Math.max(400, options.scriptLimit ?? AUDIT_SCRIPT_CONTEXT_LIMIT)
  const { script, truncated: scriptTruncated } = truncateScript(
    String(episode.scriptContent || episode.content || ''),
    scriptLimit,
  )

  const storyboardRows = liveStoryboards(episodeId)
  const shotIds = storyboardRows.map((row) => row.id)
  const characterBindings = loadBindings(schema.storyboardCharacters, shotIds)
  const propBindings = loadBindings(schema.storyboardProps, shotIds)
  const links = loadEpisodeLinks(episodeId)

  const characterRows = db.select().from(schema.characters)
    .where(eq(schema.characters.dramaId, episode.dramaId)).all()
  const sceneRows = db.select().from(schema.scenes)
    .where(eq(schema.scenes.dramaId, episode.dramaId)).all()
  const propRows = db.select().from(schema.props)
    .where(eq(schema.props.dramaId, episode.dramaId)).all()
  const characterById = new Map(characterRows.map((row) => [row.id, row]))
  const sceneById = new Map(sceneRows.map((row) => [row.id, {
    id: row.id,
    name: row.location,
    imageUrl: row.imageUrl,
    deletedAt: row.deletedAt,
  }]))
  const propById = new Map(propRows.map((row) => [row.id, row]))

  const cast: CastMember[] = characterRows
    .filter((row) => !row.deletedAt)
    .sort((left, right) => left.id - right.id)
    .map((row) => ({ id: row.id, name: row.name }))

  const { rows: dbLineRows, map: dbLinesByShotMap } = dbLinesByShot(episodeId)
  const dbLineIds = dbLineRows.map((row) => row.id)
  const readyTakes = loadReadyTakes(dbLineIds)
  const activeTaskIds = loadActiveTaskShotIds(episodeId, shotIds)

  const linkedCharacters = new Set(links.characterIds)
  const linkedScenes = new Set(links.sceneIds)
  const linkedProps = new Set(links.propIds)

  const shots: AuditContextShot[] = []
  const fingerprints = { shots: {} as Record<string, string>, lines: {} as Record<string, string> }
  for (const row of storyboardRows) {
    const characterIds = characterBindings.get(row.id) ?? []
    const propIds = propBindings.get(row.id) ?? []
    const dbLines = dbLinesByShotMap.get(row.id)
    const lines = dbLines?.length
      ? dbLines.map((line) => toContextLine(line, readyTakes))
      : derivedLines(row, cast)
    for (const line of dbLines ?? []) {
      fingerprints.lines[String(line.id)] = computeAuditLineFingerprint({
        ...line,
        hasReadyTake: readyTakes.byId.has(line.activeTakeId ?? -1) || readyTakes.activeByLine.has(line.id),
      })
    }
    const protectionReasonsList = protectionReasons(row, lines, activeTaskIds)
    const shotFingerprint = buildShotFingerprint(row, characterIds, propIds)
    fingerprints.shots[String(row.id)] = shotFingerprint
    const sceneAsset = row.sceneId != null
      ? assetView(row.sceneId, sceneById.get(row.sceneId), linkedScenes.has(row.sceneId))
      : null
    shots.push({
      id: row.id,
      storyboardNumber: row.storyboardNumber,
      title: row.title,
      sceneId: row.sceneId,
      location: row.location,
      time: row.time,
      shotType: row.shotType,
      angle: row.angle,
      movement: row.movement,
      result: row.result,
      atmosphere: row.atmosphere,
      description: row.description,
      imagePrompt: row.imagePrompt,
      videoPrompt: row.videoPrompt,
      transition: row.transition,
      transitionKind: row.transitionKind,
      transitionText: row.transitionText,
      transitionSubtitle: row.transitionSubtitle,
      continuity: row.continuity,
      duration: row.duration ?? 0,
      composedImage: row.composedImage,
      firstFrameImage: row.firstFrameImage,
      lastFrameImage: row.lastFrameImage,
      referenceImages: row.referenceImages,
      videoUrl: row.videoUrl,
      composedVideoUrl: row.composedVideoUrl,
      subtitleUrl: row.subtitleUrl,
      sceneAsset,
      characterAssets: characterIds.map((id) => assetView(id, characterById.get(id), linkedCharacters.has(id))),
      propAssets: propIds.map((id) => assetView(id, propById.get(id), linkedProps.has(id))),
      lines,
      protection: { readOnly: protectionReasonsList.length > 0, reasons: protectionReasonsList },
      ruleInput: {
        id: row.id,
        storyboardNumber: row.storyboardNumber,
        duration: row.duration ?? 0,
        description: row.description,
        videoPrompt: row.videoPrompt,
        shotType: row.shotType,
        angle: row.angle,
        movement: row.movement,
        continuity: row.continuity,
        transition: row.transition,
        time: row.time,
        transitionKind: row.transitionKind,
        sceneId: row.sceneId,
        location: row.location,
        referenceImages: row.referenceImages,
        characterIds,
        propIds,
      },
      fingerprint: shotFingerprint,
    })
  }

  const assets: AuditAssetCatalog = {
    characters: characterRows.map((row) => ({
      id: row.id,
      dramaId: row.dramaId,
      name: row.name,
      imageUrl: row.imageUrl,
      deletedAt: row.deletedAt,
    })),
    scenes: sceneRows.map((row) => ({
      id: row.id,
      dramaId: row.dramaId,
      name: row.location,
      imageUrl: row.imageUrl,
      deletedAt: row.deletedAt,
    })),
    props: propRows.map((row) => ({
      id: row.id,
      dramaId: row.dramaId,
      name: row.name,
      imageUrl: row.imageUrl,
      deletedAt: row.deletedAt,
    })),
    episodeCharacterIds: links.characterIds,
    episodeSceneIds: links.sceneIds,
    episodePropIds: links.propIds,
    fileExists,
  }

  // 过渡分镜是已有解决方案，不参与单镜检验；窗口只规划真实分镜，真实分镜之间跨卡成对判定。
  const realShots = shots.filter((shot) => shot.transitionKind == null)
  const transitionIds = shots
    .filter((shot) => shot.transitionKind != null)
    .map((shot) => shot.id)
  const planning = policy.semantic.enabled && (policy.checks.shot || policy.checks.continuity || policy.checks.assets)
    ? planAuditWindows(realShots.map((shot) => ({
      id: shot.id,
      storyboardNumber: shot.storyboardNumber,
    })), {
      size: policy.semantic.windowSize,
      step: policy.semantic.windowStep,
      maxWindows: policy.semantic.maxWindows,
    })
    : {
      windows: [] as ReturnType<typeof planAuditWindows>['windows'],
      ruleOnlyIds: realShots.map((shot) => shot.id),
      truncated: false,
    }
  const shotById = new Map(shots.map((shot) => [shot.id, shot]))
  const baseWindows: Omit<AuditWindowContext, 'pairs'>[] = planning.windows.map((plan) => {
    const targets = plan.targets
      .map((target) => shotById.get(target.id))
      .filter((shot): shot is AuditContextShot => Boolean(shot))
    return {
      index: plan.index,
      targets,
      contextBefore: plan.contextBefore ? shotById.get(plan.contextBefore.id) ?? null : null,
      contextAfter: plan.contextAfter ? shotById.get(plan.contextAfter.id) ?? null : null,
      fromShotNumber: targets[0]?.storyboardNumber ?? 0,
      toShotNumber: targets[targets.length - 1]?.storyboardNumber ?? 0,
      fingerprint: sha1(targets.map((shot) => shot.id).join(',')),
    }
  })
  const windowIndexByToId = new Map<number, number>()
  for (const window of baseWindows) {
    for (const target of window.targets) {
      if (!windowIndexByToId.has(target.id)) windowIndexByToId.set(target.id, window.index)
    }
  }
  const continuityPairs: AuditContinuityPair[] = []
  let previousReal: AuditContextShot | null = null
  let bridge: AuditContextShot[] = []
  for (const shot of shots) {
    if (shot.transitionKind != null) {
      if (previousReal) bridge.push(shot)
      continue
    }
    if (previousReal) {
      const windowIndex = windowIndexByToId.get(shot.id)
      if (windowIndex != null) {
        continuityPairs.push({
          key: `P${previousReal.id}-${shot.id}`,
          index: continuityPairs.length,
          from: previousReal,
          to: shot,
          bridge,
          crossCard: bridge.length > 0,
          windowIndex,
          fingerprint: stableHash([
            previousReal.fingerprint,
            shot.fingerprint,
            ...bridge.map((item) => item.fingerprint),
          ]),
        })
      }
    }
    previousReal = shot
    bridge = []
  }
  const windows: AuditWindowContext[] = baseWindows.map((window) => ({
    ...window,
    pairs: continuityPairs.filter((pair) => pair.windowIndex === window.index),
  }))

  return {
    episodeId,
    dramaId: episode.dramaId,
    episodeTitle: episode.title,
    episodeDuration: episode.duration ?? 0,
    maxSegmentSeconds: getMaxSegmentSeconds(episode.breakdownMethod),
    script,
    scriptTruncated,
    cast,
    assets,
    shots,
    windows,
    continuityPairs,
    transitionIds,
    ruleOnlyIds: planning.ruleOnlyIds,
    semanticTruncated: planning.truncated,
    policy,
    ruleInput: {
      dramaId: episode.dramaId,
      shots: realShots.map((shot) => shot.ruleInput),
      lines: realShots.flatMap((shot) => shot.lines.map((line) => ({ ...line, storyboardId: shot.id }))),
      cast,
      assets,
      options: { checks: ruleOptions.checks, thresholds: ruleOptions.thresholds },
    },
    fingerprints,
  }
}

export function loadAuditFingerprintSnapshot(episodeId: number): AuditFingerprintSnapshot {
  const shots = liveStoryboards(episodeId)
  const shotIds = shots.map((shot) => shot.id)
  const characterBindings = loadBindings(schema.storyboardCharacters, shotIds)
  const propBindings = loadBindings(schema.storyboardProps, shotIds)
  const { rows: lineRows } = dbLinesByShot(episodeId)
  const readyTakes = loadReadyTakes(lineRows.map((line) => line.id))

  const shotFingerprints: Record<string, string> = {}
  for (const shot of shots) {
    shotFingerprints[String(shot.id)] = buildShotFingerprint(
      shot,
      characterBindings.get(shot.id) ?? [],
      propBindings.get(shot.id) ?? [],
    )
  }
  const lineFingerprints: Record<string, string> = {}
  for (const line of lineRows) {
    lineFingerprints[String(line.id)] = computeAuditLineFingerprint({
      ...line,
      hasReadyTake: readyTakes.byId.has(line.activeTakeId ?? -1) || readyTakes.activeByLine.has(line.id),
    })
  }
  return { episodeId, shots: shotFingerprints, lines: lineFingerprints }
}

function assetStatusText(asset: AuditBoundAssetView | null): string {
  if (!asset) return '未绑定'
  const parts = [asset.name]
  if (asset.deleted) parts.push('已删除')
  parts.push(asset.linked ? '已关联本集' : '未关联本集')
  parts.push((asset.imageUrl || '').trim() ? '有资产图' : '缺少资产图')
  return parts.join('｜')
}

const PROTECTION_LABELS: Record<AuditProtectionReason, string> = {
  frame_asset: '帧资产',
  video_asset: '视频资产',
  subtitle_asset: '字幕资产',
  line_audio: '台词音频',
  line_locked: '台词锁定',
  active_take: '生效 Take',
  active_task: '生成任务进行中',
}

const TRANSITION_KIND_LABELS: Record<string, string> = {
  empty: '空镜',
  scene: '场景卡',
  text: '文字卡',
}

function transitionKindLabel(shot: AuditContextShot): string {
  const kind = (shot.transitionKind || '').trim()
  return TRANSITION_KIND_LABELS[kind] || kind || '过渡分镜'
}

function transitionCardText(shot: AuditContextShot): string {
  return (shot.transitionText || shot.transitionSubtitle || shot.description || '').trim()
}

function shotBlock(shot: AuditContextShot, suffix = ''): string[] {
  const lines: string[] = []
  lines.push(`### #${shot.storyboardNumber} ${shot.title || `镜头${shot.storyboardNumber}`}${suffix}`)
  if (shot.transitionKind != null) {
    const text = transitionCardText(shot)
    lines.push(`- 过渡分镜：${transitionKindLabel(shot)}${text ? `「${text}」` : ''}（已有过渡，不参与检验）`)
    return lines
  }
  lines.push(`- 时长：${shot.duration} 秒｜景别：${shot.shotType || '未填'}｜角度：${shot.angle || '未填'}｜运镜：${shot.movement || '未填'}`)
  lines.push(`- 转场：${shot.transition || 'cut'}｜连贯：${shot.continuity || '未填'}`)
  lines.push(`- 场景：${shot.location || '未指定'}（场景资产：${assetStatusText(shot.sceneAsset)}）｜时间：${(shot.time || '').trim() || '未填'}`)
  lines.push(`- 出场角色：${shot.characterAssets.length ? shot.characterAssets.map((asset) => `${asset.name}${asset.linked ? '' : '（未关联本集）'}`).join('、') : '无'}`)
  if (shot.propAssets.length) {
    lines.push(`- 道具：${shot.propAssets.map((asset) => asset.name).join('、')}`)
  }
  lines.push(`- 画面描述：${(shot.description || '（空）').replace(/\s+/g, ' ')}`)
  if ((shot.videoPrompt || '').trim()) {
    lines.push('- 视频提示词：')
    lines.push('```')
    lines.push(shot.videoPrompt || '')
    lines.push('```')
  } else {
    lines.push('- 视频提示词：（空）')
  }
  if (shot.lines.length) {
    lines.push('- 台词/旁白：')
    for (const line of shot.lines) {
      const origin = line.origin === 'prompt' ? '派生' : '数据库'
      lines.push(`  - ${line.speakerName || '未知'}（${origin}）：${line.text}`)
    }
  }
  if (shot.protection.readOnly) {
    lines.push(`- 只读：只读（${shot.protection.reasons.map((reason) => PROTECTION_LABELS[reason]).join('、')}）`)
  }
  return lines
}

function assetListLines(title: string, assets: AuditBoundAssetView[]): string[] {
  if (!assets.length) return [`### ${title}`, '- 无']
  return [`### ${title}`, ...assets.map((asset) => `- ${assetStatusText(asset)}`)]
}

function segmentText(segment: ParsedPromptSegment): string {
  return `${segment.startSec}-${segment.endSec}秒：${segment.text}`.trim()
}

function promptEdgeText(shot: AuditContextShot, edge: 'first' | 'last'): string {
  const segments = parsePromptSegments(shot.videoPrompt)
  if (segments.length) {
    return segmentText(edge === 'first' ? segments[0] : segments[segments.length - 1])
  }
  const fallback = (shot.videoPrompt || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (fallback.length) return fallback[edge === 'first' ? 0 : fallback.length - 1]
  return '（无视频提示词）'
}

function characterGroupText(shot: AuditContextShot): string {
  return shot.characterAssets.length ? shot.characterAssets.map((asset) => asset.name).join('、') : '无'
}

export function buildAuditContinuityPrompt(
  context: AuditEpisodeContext,
  pair: AuditContinuityPair,
  options: { recheck?: boolean } = {},
): string {
  const total = context.continuityPairs.length || 1
  const autoInsert = context.policy.autoRepair.enabled
    && context.policy.autoRepair.semanticFix
    && context.policy.autoRepair.autoInsertTransition
  const lines: string[] = []
  lines.push(options.recheck
    ? '你是短剧分镜动作检验员。本次是修复后的成对复查：只判定这一对相邻真实分镜的衔接是否已经修好。'
    : '你是短剧分镜动作检验员。本次只判定一对相邻真实分镜的衔接：上一镜的动作结果必须由下一镜的首段画面承接。')
  lines.push('')
  lines.push(`## 成对连贯判定 ${pair.index + 1}/${total}：#${pair.from.storyboardNumber} → #${pair.to.storyboardNumber}`)
  lines.push('')
  lines.push('## 上一镜')
  lines.push(...shotBlock(pair.from))
  lines.push('')
  lines.push('## 下一镜')
  lines.push(...shotBlock(pair.to))
  lines.push('')
  if (pair.crossCard) {
    lines.push('## 中间过渡分镜（已存在的过渡，不再参与分析）')
    for (const item of pair.bridge) {
      const text = transitionCardText(item)
      lines.push(`- #${item.storyboardNumber}｜${transitionKindLabel(item)}${text ? `：${text}` : ''}`)
    }
    lines.push('- 这些过渡分镜说明断点已经处理过：不要把它们当作检验对象，也不要建议再插入新的过渡分镜。')
    lines.push('- 如果过渡分镜已经交代了时间、地点或人物变化，两侧真实分镜即使字面不同也应判 connected。')
    lines.push('- 只有过渡分镜解释不足、两侧动作结果明显接不上时才判 broken；此时 suggestedTransition 必须为 null。')
    lines.push('')
  }
  lines.push('## 对照信息')
  lines.push(`- 时间：上一镜 ${(pair.from.time || '').trim() || '未填'}｜下一镜 ${(pair.to.time || '').trim() || '未填'}`)
  lines.push(`- 角色组：上一镜 ${characterGroupText(pair.from)}｜下一镜 ${characterGroupText(pair.to)}`)
  lines.push(`- 上一镜末段：${promptEdgeText(pair.from, 'last')}`)
  lines.push(`- 下一镜首段：${promptEdgeText(pair.to, 'first')}`)
  lines.push('')
  lines.push('## 判定规则')
  lines.push('- 必须逐字阅读两侧完整视频提示词后再判断；continuity 字段只是声明，不是证据，声明与提示词不符时以提示词为准。')
  lines.push('- 上一镜末段的动作、视线、位置、道具状态必须由下一镜首段可见地承接；接不上、跳时间、换地点、换人物组却没有可见过渡动作，判 broken。')
  lines.push('- 只看这一对，不评价其他分镜，不修改分镜；证据必须引用两侧提示词里的具体差异。')
  if (pair.crossCard) {
    lines.push('- 本对跨过已存在的过渡分镜，suggestedTransition 必须为 null，服务端不会再次插入。')
  } else if (autoInsert) {
    lines.push('- 判 broken 且确实需要过渡时，填写 suggestedTransition（empty 空镜 / scene 场景 / text 文字卡）；服务端只会为这一对插入 1 个过渡分镜。')
    lines.push('- 过渡类型按断点性质选择，不要一律填 empty：时间/年代/时刻明确跳变 → text；地点明确变化且下一镜有场景资产 → scene；同地点同时间只缺动作缓冲 → empty。')
    lines.push('- 同一集连续多个断点不要重复同一种类型：能用 scene 或 text 合理交代时优先换用，只有同场景动作缓冲才继续 empty；空镜拍法由服务端轮换，不要重复描述同一种空镜。')
  } else {
    lines.push('- 本次不自动插入过渡分镜，suggestedTransition 一律填 null，由人工处理。')
  }
  lines.push('')
  lines.push('## 结论提交')
  lines.push('- 必须调用 report_continuity_verdict 提交结论：verdict=connected 或 broken，不能只在文字里说明。')
  lines.push('- broken 时填写 severity（默认 warning，动作/场景直接断裂可用 error）、evidence（两侧提示词的具体差异）和 suggestion。')
  lines.push('- 未调用工具视为本次判定失败，会触发重试。')
  return lines.join('\n')
}

export function buildAuditWindowPrompt(
  context: AuditEpisodeContext,
  window: AuditWindowContext,
  options: { recheck?: boolean } = {},
): string {
  const total = context.windows.length
  const lines: string[] = []
  if (options.recheck) {
    lines.push('你是短剧分镜动作检验员。本次是修复后的复查：只复查目标分镜，重点确认修复没有引入新的动作、表情或资产问题。')
  } else {
    lines.push('你是短剧分镜动作检验员。只检查「目标分镜」，窗口外分镜只读，不要对它们报问题。')
  }
  lines.push('')
  lines.push(`## 动作检验${options.recheck ? '复查' : ''}窗口 ${window.index}/${total}`)
  lines.push(`- 目标：第 ${window.fromShotNumber}–${window.toShotNumber} 镜（${window.targets.length} 个）`)
  const reportable: string[] = []
  if (context.policy.checks.shot) reportable.push('semantic_shot_description（检查 1）')
  if (context.policy.checks.assets) reportable.push('semantic_asset_mismatch（检查 5）')
  lines.push(`- 可报告问题码：${reportable.length ? reportable.join('、') : '（本集策略已关闭本窗口的语义检查项）'}`)
  lines.push('- 每条问题必须调用 report_storyboard_issues 上报；问题只报一次，没有问题时不要编造。')
  lines.push('- 上报时用 storyboardNumber 填写镜头号（如 17），storyboardId 可省略；相关镜头用 relatedStoryboardNumbers 填镜头号。')
  if (context.policy.checks.continuity) {
    lines.push('- 检查 2（相邻连贯）由逐对判定单独完成：本窗口不要报检查 2，也不要调用 report_continuity_verdict。')
  }
  const autoRepair = context.policy.autoRepair
  if (autoRepair.enabled && autoRepair.semanticFix) {
    lines.push('- 只做判断，不修改分镜；repairable 可省略，服务端按策略判定是否进入受控修复。')
  } else {
    lines.push('- 只做判断，不修改分镜；repairable 一律填 false。')
  }
  if (window.targets.some((shot) => shot.protection.readOnly)) {
    lines.push('- 目标中带「只读」的分镜仍可报问题，但后续不会自动修复。')
  }
  lines.push('')
  lines.push('## 剧本（节选）')
  lines.push(context.script || '（无剧本）')
  lines.push('')
  lines.push('## 本集角色')
  lines.push(context.cast.length ? context.cast.map((member) => `- ${member.name}`).join('\n') : '- 无')
  lines.push('')
  lines.push('## 资产')
  const sceneAssets = context.assets.scenes
    .filter((asset) => !asset.deletedAt)
    .map((asset) => assetView(asset.id, asset, context.assets.episodeSceneIds.includes(asset.id)))
  lines.push(...assetListLines('场景', sceneAssets))
  const characterAssets = context.assets.characters
    .filter((asset) => !asset.deletedAt)
    .map((asset) => assetView(asset.id, asset, context.assets.episodeCharacterIds.includes(asset.id)))
  lines.push(...assetListLines('角色', characterAssets))
  const propAssets = context.assets.props
    .filter((asset) => !asset.deletedAt)
    .map((asset) => assetView(asset.id, asset, context.assets.episodePropIds.includes(asset.id)))
  lines.push(...assetListLines('道具', propAssets))
  lines.push('')
  lines.push(`## 目标分镜（${window.targets.length} 个）`)
  for (const shot of window.targets) lines.push(...shotBlock(shot))
  lines.push('')
  lines.push('## 只读上下文')
  const contextShots = [
    ...(window.contextBefore ? [{ shot: window.contextBefore, suffix: '（上一镜 · 只读）' }] : []),
    ...(window.contextAfter ? [{ shot: window.contextAfter, suffix: '（下一镜 · 只读）' }] : []),
  ]
  if (!contextShots.length) {
    lines.push('- 无')
  } else {
    for (const entry of contextShots) lines.push(...shotBlock(entry.shot, entry.suffix))
  }
  return lines.join('\n')
}

const REPAIR_ACTION_GUIDE: Record<string, string> = {
  fill_camera_fields: '补全镜头字段：shotType、angle、movement，只能从已有描述和提示词归纳',
  normalize_video_prompt: '规范化视频提示词：videoPrompt，必要时同步 description；保留全部真实台词与旁白',
  rewrite_description: '重写画面描述：description、videoPrompt、result；不新增角色、道具、剧情，不改台词文本',
  fix_continuity: '补连贯性：后一镜的 continuity、transition，必要时 description、videoPrompt',
  extend_duration: '延长镜头时长：duration 与 videoPrompt（时间轴必须同步）；只能增加，且不超过当前拆分方式单段上限',
}

export function buildAuditRepairPrompt(context: AuditEpisodeContext, issues: AuditIssue[]): string {
  const repairable = issues.filter((issue) => (
    issue.status === 'open'
    && issue.repairable
    && issue.check !== 5
    && issue.repairAction !== 'insert_transition_shot'
  ))
  const shotById = new Map(context.shots.map((shot) => [shot.id, shot]))
  const shotIds = [...new Set(repairable.map((issue) => issue.storyboardId))]
  const lines: string[] = []
  lines.push('你是短剧分镜受控修复员。下面列出本轮可自动修复的问题，请只针对这些问题提交修复动作。')
  lines.push('')
  lines.push('## 修复规则')
  lines.push('- 每条动作必须调用 apply_storyboard_repair 提交，只需引用问题编号 issueId；storyboardId 可省略，服务端按 issueId 定位分镜。')
  lines.push('- 把本轮所有有把握的动作放在一次 apply_storyboard_repair 调用里批量提交；不要分批提交，也不要只处理一部分就结束。')
  lines.push('- 没有把握、需要创作判断或证据不足的问题不要提交动作，交给人工处理；若确实没有任何可安全执行的动作，直接结束本轮。')
  lines.push('- 不新增角色、场景、道具、台词或旁白；不改台词文本与说话人。')
  lines.push(`- 延长时长只能增加且不得超过 ${context.maxSegmentSeconds} 秒（当前拆分方式单段上限）；超出上限的台词容量问题不要提交动作，交人工压缩或拆分台词。`)
  lines.push('- 过渡分镜插入由服务端内部完成；你不要提交或描述任何插卡动作，也不要改变分镜数量或分镜号。')
  lines.push('- 带「只读」的分镜不允许修改；检查 5 的资产问题不允许自动修复。')
  lines.push('- 同一分镜最多 3 条动作，同一字段只能修改一次。')
  lines.push('')
  lines.push('## 动作与允许字段')
  for (const [action, guide] of Object.entries(REPAIR_ACTION_GUIDE)) lines.push(`- ${action}：${guide}`)
  lines.push('')
  lines.push(`## 待修复问题（${repairable.length} 条）`)
  for (const issue of repairable) {
    const shot = shotById.get(issue.storyboardId)
    lines.push(`- ${issue.id}｜第 ${issue.storyboardNumber} 镜｜检查 ${issue.check}｜${issue.severity}｜${issue.code}`)
    lines.push(`  - 问题：${issue.message}`)
    if (issue.evidence) lines.push(`  - 证据：${issue.evidence}`)
    if (issue.suggestion) lines.push(`  - 建议：${issue.suggestion}`)
    if (issue.repairAction) lines.push(`  - 指定动作：${issue.repairAction}`)
    if (issue.suggestedTransition) lines.push(`  - 过渡类型：${issue.suggestedTransition}`)
    if (issue.relatedStoryboardIds?.length) {
      lines.push(`  - 相关分镜 ID：${issue.relatedStoryboardIds.join('、')}`)
    }
    if (shot?.protection.readOnly) {
      lines.push(`  - 只读：该镜受保护（${shot.protection.reasons.map((reason) => PROTECTION_LABELS[reason]).join('、')}），不要提交动作`)
    }
  }
  lines.push('')
  lines.push(`## 涉及分镜（${shotIds.length} 个）`)
  for (const shotId of shotIds) {
    const shot = shotById.get(shotId)
    if (shot) lines.push(...shotBlock(shot))
  }
  return lines.join('\n')
}
