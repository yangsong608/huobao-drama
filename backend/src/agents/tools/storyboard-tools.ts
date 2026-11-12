/**
 * 分镜拆解 Agent 工具
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { db, getInsertId, schema } from '../../db/index.js'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess, logTaskWarn } from '../../utils/task-logger.js'
import { getContentLanguageFromRC, getDramaId, getEpisodeId } from '../context.js'
import { resolveVoiceMentions } from '../../services/character-voice-references.js'
import { getDramaBackground } from '../../services/drama-background.js'
import { cleanupFrameAssetsForEpisode } from '../../services/storyboard-frame-assets.js'
import { parseContractFromPrompt, syncStoryboardContract } from '../../services/storyboard-contract.js'
import { stripPlaceholderDialogue, validateStoryboardUnit } from '../../services/storyboard-unit-contract.js'
import { validateRepairedShot } from '../../services/storyboard-shot-validation.js'
import { buildShotSoundDelta, parseSoundSection, setSoundSection, type SoundSection, type ShotSoundCue } from '../../services/storyboard-sound.js'
import { applyAssetAliases, buildAssetAliasMap } from '../../services/asset-aliases.js'
import { getCanonicalSceneGroups, resolveCanonicalSceneByName, resolveCanonicalSceneId } from '../../services/scene-canonical.js'
import { evaluateContractPairIssues } from '../../services/storyboard-contract-audit.js'
import { createSceneSidePlan, normalizeSceneSides } from '../../services/storyboard-scene-sides.js'
import {
  extractPlanSpeechSegments,
  planIssuesText,
  validatePlanSequence,
  type PlanShot,
} from '../../services/storyboard-plan-contract.js'
import { getMaxSegmentSeconds } from '../../services/breakdown-methods.js'
import {
  formatDialogueIntegrityIssue,
  inspectDialogueIntegrity,
} from '../../services/dialogue-integrity.js'

async function validateVideoPromptVoices(prompt: string | undefined, dramaId: number, characterIds: number[] = []) {
  if (!prompt?.includes('#')) return
  const characters = await db.select({ id: schema.characters.id, name: schema.characters.name, voiceAudioUrl: schema.characters.voiceAudioUrl }).from(schema.characters)
    .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
  // Validate the model's references, but persist the original editable #tokens.
  resolveVoiceMentions(prompt, characters.map(c => ({ ...c, bound: characterIds.includes(c.id) })))
}

async function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  const uniqueIds = [...new Set((characterIds || []).filter(Boolean))]
  db.transaction((tx) => {
    tx.delete(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).run()
    for (const characterId of uniqueIds) {
      tx.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()
    }
  })
}

async function syncStoryboardProps(storyboardId: number, propIds: number[]) {
  const uniqueIds = [...new Set((propIds || []).filter(Boolean))]
  db.transaction((tx) => {
    tx.delete(schema.storyboardProps)
      .where(eq(schema.storyboardProps.storyboardId, storyboardId)).run()
    for (const propId of uniqueIds) {
      tx.insert(schema.storyboardProps).values({ storyboardId, propId }).run()
    }
  })
}

/** 合同解析是增强字段，失败不能阻断分镜保存；contract_version=0 表示未解析 */
async function syncContractSafe(storyboardId: number) {
  try {
    await syncStoryboardContract(storyboardId)
  } catch (error) {
    logTaskWarn('StoryboardTool', 'contract-sync-failed', {
      storyboardId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function getEpisodeSceneIds(episodeId: number) {
  const links = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  return new Set(links.map(link => link.sceneId))
}

async function getEpisodeCharacterIds(episodeId: number) {
  const links = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  return new Set(links.map(link => link.characterId))
}

async function getEpisodePropIds(episodeId: number) {
  const links = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  return new Set(links.map(link => link.propId))
}

async function validateStoryboardBindings(episodeId: number, dramaId: number, sceneId: number | null | undefined, characterIds: number[] | undefined, propIds?: number[] | undefined) {
  const episodeSceneIds = await getEpisodeSceneIds(episodeId)
  const episodeCharacterIds = await getEpisodeCharacterIds(episodeId)
  const episodePropIds = await getEpisodePropIds(episodeId)

  // 场景/角色/道具属于本剧但尚未关联到当前集时，自动补关联（拆分时即完成绑定）
  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    const [scene] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId))
    if (!scene || scene.dramaId !== dramaId || scene.deletedAt) {
      throw new Error(`scene_id ${sceneId} 不属于当前项目`)
    }
    await db.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: now() }).onConflictDoNothing()
  }

  const uniqueCharacterIds = [...new Set((characterIds || []).filter(Boolean))]
  for (const characterId of uniqueCharacterIds) {
    if (episodeCharacterIds.has(characterId)) continue
    const [character] = await db.select().from(schema.characters).where(eq(schema.characters.id, characterId))
    if (!character || character.dramaId !== dramaId || character.deletedAt) {
      throw new Error(`character_id ${characterId} 不属于当前项目`)
    }
    await db.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: now() }).onConflictDoNothing()
  }

  const uniquePropIds = [...new Set((propIds || []).filter(Boolean))]
  for (const propId of uniquePropIds) {
    if (episodePropIds.has(propId)) continue
    const [prop] = await db.select().from(schema.props).where(eq(schema.props.id, propId))
    if (!prop || prop.dramaId !== dramaId || prop.deletedAt) {
      throw new Error(`prop_id ${propId} 不属于当前项目`)
    }
    await db.insert(schema.episodeProps).values({ episodeId, propId, createdAt: now() }).onConflictDoNothing()
  }
}

type ToolContext = ToolExecutionContext | undefined

function requireIds(context: ToolContext): { episodeId: number; dramaId: number } | { error: string } {
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!episodeId || !dramaId) return { error: 'Missing episodeId/dramaId in request context' }
  return { episodeId, dramaId }
}

interface StoryboardChunkRuntime {
  script?: string
  index?: number
  total?: number
  label?: string
  shotStart?: number
  state?: { replaced: boolean; nextShot: number }
}

/** 分块拆分上下文：由 storyboard-split-jobs 服务按块注入，普通单次拆分不设置 */
function getChunkRuntime(context: ToolContext): StoryboardChunkRuntime {
  const rc = context?.requestContext
  return {
    script: rc?.get('storyboardChunkScript' as never) as string | undefined,
    index: rc?.get('storyboardChunkIndex' as never) as number | undefined,
    total: rc?.get('storyboardChunkTotal' as never) as number | undefined,
    label: rc?.get('storyboardChunkLabel' as never) as string | undefined,
    shotStart: rc?.get('storyboardChunkShotStart' as never) as number | undefined,
    state: rc?.get('storyboardChunkState' as never) as { replaced: boolean; nextShot: number } | undefined,
  }
}

function isChunkMode(chunk: StoryboardChunkRuntime) {
  return typeof chunk.index === 'number' && !!chunk.state
}

interface StoryboardPipelineRuntime {
  jobId?: number
  stage?: 'skeleton' | 'repair' | 'sound'
  chunk?: {
    script?: string
    index?: number
    total?: number
    label?: string
    shotStart?: number
    state?: { replaced: boolean; nextShot: number; saved: number; excerptCursor?: number }
  }
  shotNumber?: number
  skeleton?: Record<string, any>
  previousShots?: Array<Record<string, any>>
  nextDrafts?: Array<Record<string, any>>
  sceneText?: string
  novelSceneText?: string
  issues?: string[]
}

function getPipelineRuntime(context: ToolContext): StoryboardPipelineRuntime {
  const rc = context?.requestContext
  const rawSkeleton = rc?.get('pipelineSkeleton' as never) as Record<string, any> | undefined
  const skeleton = rawSkeleton ? {
    ...rawSkeleton,
    id: rawSkeleton.id,
    title: rawSkeleton.title ?? '',
    sceneId: rawSkeleton.sceneId ?? rawSkeleton.scene_id ?? null,
    location: rawSkeleton.location ?? '',
    time: rawSkeleton.time ?? '',
    characterIds: rawSkeleton.characterIds ?? rawSkeleton.character_ids ?? [],
    propIds: rawSkeleton.propIds ?? rawSkeleton.prop_ids ?? [],
    duration: rawSkeleton.duration ?? 0,
    transition: rawSkeleton.transition ?? 'cut',
    continuity: rawSkeleton.continuity ?? '',
    sourceExcerpt: rawSkeleton.sourceExcerpt ?? rawSkeleton.source_excerpt ?? '',
    attempts: rawSkeleton.attempts ?? 0,
  } : undefined
  return {
    jobId: rc?.get('pipelineJobId' as never) as number | undefined,
    stage: rc?.get('pipelineStage' as never) as StoryboardPipelineRuntime['stage'],
    chunk: {
      script: rc?.get('pipelineChunkScript' as never) as string | undefined,
      index: rc?.get('pipelineChunkIndex' as never) as number | undefined,
      total: rc?.get('pipelineChunkTotal' as never) as number | undefined,
      label: rc?.get('pipelineChunkLabel' as never) as string | undefined,
      shotStart: rc?.get('pipelineChunkShotStart' as never) as number | undefined,
      state: rc?.get('pipelineChunkState' as never) as { replaced: boolean; nextShot: number; saved: number; excerptCursor?: number } | undefined,
    },
    shotNumber: rc?.get('pipelineShotNumber' as never) as number | undefined,
    skeleton,
    previousShots: rc?.get('pipelinePreviousShots' as never) as Array<Record<string, any>> | undefined,
    nextDrafts: rc?.get('pipelineNextDrafts' as never) as Array<Record<string, any>> | undefined,
    sceneText: rc?.get('pipelineSceneText' as never) as string | undefined,
    novelSceneText: rc?.get('pipelineNovelSceneText' as never) as string | undefined,
    issues: rc?.get('pipelineIssues' as never) as string[] | undefined,
  }
}

/** 清空整集分镜及其关联/台词/末帧资产（整集重建时调用） */
async function clearEpisodeStoryboards(episodeId: number, ts: string) {
  const existingStoryboardRows = await db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
  for (const storyboardId of existingStoryboardRows.map(sb => sb.id)) {
    await db.delete(schema.storyboardCharacters)
      .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    await db.delete(schema.storyboardProps)
      .where(eq(schema.storyboardProps.storyboardId, storyboardId))
  }
  // 分镜整体重建时挂载台词一并软删，避免 storyboard_id 悬空成孤儿（绝对锚点台词保留）
  await db.update(schema.storyboardLines)
    .set({ deletedAt: ts, updatedAt: ts })
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNotNull(schema.storyboardLines.storyboardId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .run()
  await db.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId))
  // 分镜来源已整体重建，旧末帧资产随之作废，避免孤儿资产还留在本集资产列表里
  cleanupFrameAssetsForEpisode(db, episodeId, ts)
}

const readStoryboardContext = createTool({
  id: 'read_storyboard_context',
  description: 'Read the screenplay and all project characters, scenes, and props for storyboard breakdown. Items not yet linked to this episode are still reusable; saving a storyboard links them automatically.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const chunk = getChunkRuntime(context)
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: 'Episode not found' }
    // 分块拆分时只把当前块剧本交给模型，避免它读完整集后自行改范围、重复拆其它场次
    const script = chunk.script || ep.scriptContent || ep.content
    if (!script) return { error: 'Episode has no script' }

    const charLinks = await db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId))
    const sceneLinks = await db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId))
    const propLinks = await db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId))

    const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
    const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))
    const linkedPropIds = new Set(propLinks.map(link => link.propId))

    const chars = await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId))
    const scns = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId))
    const prps = await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId))
    const existingStoryboards = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))

    const characters = chars
      .filter(c => !c.deletedAt)
      .map(c => ({
        id: c.id,
        name: c.name,
        role: c.role || '',
        description: c.description || '',
        appearance: c.appearance || '',
        styling: c.styling || '',
        image_url: c.imageUrl || '',
        reference_images: c.referenceImages || '',
        linked_to_episode: linkedCharacterIds.has(c.id),
        has_voice: Boolean(c.voiceAudioUrl?.trim()),
        voice_reference: c.voiceAudioUrl?.trim() ? `#${c.name}` : null,
      }))

    const scenes = scns
      .filter(s => !s.deletedAt)
      .map(s => ({
        id: s.id,
        location: s.location,
        time: s.time,
        prompt: s.prompt || '',
        lighting: s.lighting || '',
        image_url: s.imageUrl || '',
        linked_to_episode: linkedSceneIds.has(s.id),
        storyboard_count: s.storyboardCount || 0,
      }))

    const props = prps
      .filter(p => !p.deletedAt)
      .map(p => ({
        id: p.id,
        name: p.name,
        type: p.type || '',
        description: p.description || '',
        image_url: p.imageUrl || '',
        linked_to_episode: linkedPropIds.has(p.id),
      }))

    // 分块拆分只需要最近几镜做衔接参考，避免历史分镜挤占上下文
    const liveExistingStoryboards = existingStoryboards.filter(sb => !sb.deletedAt)
    const firstChunkBeforeReplace = isChunkMode(chunk) && chunk.index === 0 && !chunk.state?.replaced
    const visibleExistingStoryboards = isChunkMode(chunk)
      ? (firstChunkBeforeReplace
          ? []
          : [...liveExistingStoryboards]
              .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
              .slice(-6))
      : liveExistingStoryboards

    const existingStoryboardPayload = await Promise.all(visibleExistingStoryboards
      .map(async (sb) => {
        const links = await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
        const sbPropLinks = await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, sb.id))
        return {
          id: sb.id,
          shot_number: sb.storyboardNumber,
          title: sb.title || '',
          scene_id: sb.sceneId,
          character_ids: links.map(link => link.characterId),
          available_voice_references: characters
            .filter(c => c.has_voice && links.some(link => link.characterId === c.id))
            .map(c => ({ character_id: c.id, name: c.name, voice_reference: c.voice_reference })),
          prop_ids: sbPropLinks.map(link => link.propId),
          shot_type: sb.shotType || '',
          duration: sb.duration || 0,
          description: sb.description || '',
          atmosphere: sb.atmosphere || '',
          transition: sb.transition || 'cut',
          continuity: sb.continuity || '',
          video_prompt: sb.videoPrompt || '',
        }
      }))

    const payload = {
      project: {
        background: await getDramaBackground(dramaId),
      },
      episode: {
        id: ep.id,
        title: ep.title,
        episode_number: ep.episodeNumber,
        description: ep.description || '',
      },
      script,
      ...(isChunkMode(chunk)
        ? {
            chunk: {
              index: (chunk.index as number) + 1,
              total: chunk.total || 0,
              label: chunk.label || '',
            },
          }
        : {}),
      characters,
      scenes,
      props,
      existing_storyboards: existingStoryboardPayload,
    }
    logTaskSuccess('StoryboardTool', 'read-context', {
      episodeId,
      dramaId,
      characters: characters.length,
      scenes: scenes.length,
      props: props.length,
      existingStoryboards: payload.existing_storyboards.length,
      scriptLength: script.length,
    })
    return payload
  },
})

const storyboardFields = z.object({
  shot_number: z.number(),
  title: z.string().optional(),
  shot_type: z.string().optional(),
  angle: z.string().optional(),
  movement: z.string().optional(),
  location: z.string().optional(),
  time: z.string().optional(),
  description: z.string().optional(),
  result: z.string().optional(),
  atmosphere: z.string().optional(),
  image_prompt: z.string().optional(),
  video_prompt: z.string().optional(),
  bgm_prompt: z.string().optional(),
  sound_effect: z.string().optional(),
  transition: z.enum(['cut', 'fade', 'dissolve', 'wipe']).optional(),
  continuity: z.string().optional(),
  duration: z.number().optional(),
  scene_id: z.number().nullable().optional(),
  character_ids: z.array(z.number()).optional(),
  prop_ids: z.array(z.number()).optional(),
})

const HEADER_CHARACTER_RE = /人物|登场人物|登場人物|characters?|인물|등장인물/i
const HEADER_SCENE_RE = /场景|scene|シーン|장면/i
const HEADER_LINE_START_RE = /^(?:出场人物|登场人物|登場人物|人物|characters?|인물|등장인물|场景|scene|シーン|장면)\s*[：:@]/i
const TIME_SEGMENT_RE = /^(\s*)(\d+(?:\.\d+)?)\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*(秒|s|초)/i
const AUDIO_DIRECTIVE_RE = /^\s*(?:音频|audio)\s*[：:]/i
const NARRATION_RE = /旁白(?:\s*[（(][^）)]*[）)])?\s*[：:]\s*/
const EMPTY_CHARACTER_NAMES = new Set(['无', '没有', '沒有', 'なし', '없음', 'none'])
const EMPTY_SCENE_NAMES = new Set(['未指定', '不明', 'unspecified', 'なし', '미지정'])

function mentionName(value: string) {
  return value.trim().replace(/^@+/, '').replace(/[。．.；;，,、｜|／/]+$/, '').trim()
}

function buildVideoPromptHeader(
  names: string[],
  sceneName: string | null | undefined,
  language: string | null | undefined,
) {
  const people = [...new Set(names.map(mentionName).filter(Boolean))]
  const scene = sceneName ? mentionName(sceneName) : ''
  const mentions = (separator: string) => people.map(name => `@${name}`).join(separator)
  switch (language) {
    case 'en':
      return `Characters: ${people.length ? mentions(', ') : 'None'} | Scene: ${scene ? `@${scene}` : 'Unspecified'}`
    case 'ja':
      return `登場人物：${people.length ? mentions('、') : 'なし'}／シーン：${scene ? `@${scene}` : '未指定'}`
    case 'ko':
      return `등장인물: ${people.length ? mentions(', ') : '없음'} | 장면: ${scene ? `@${scene}` : '미지정'}`
    default:
      return `出场人物：${people.length ? mentions('、') : '无'}｜场景：${scene ? `@${scene}` : '未指定'}`
  }
}

function parseVideoPromptHeader(line: string): { names: string[], scene: string | null } | null {
  if (TIME_SEGMENT_RE.test(line) || !HEADER_LINE_START_RE.test(line.trim())) return null
  const characterMatch = HEADER_CHARACTER_RE.exec(line)
  const sceneMatch = HEADER_SCENE_RE.exec(line)
  if (!characterMatch || !sceneMatch) return null
  const characterStart = characterMatch.index + characterMatch[0].length
  const sceneStart = sceneMatch.index
  const characterSection = sceneStart > characterStart
    ? line.slice(characterStart, sceneStart)
    : line.slice(characterStart)
  const sceneSection = line.slice(sceneMatch.index + sceneMatch[0].length)
  const names = characterSection
    .replace(/^[：:\s]+/, '')
    .split(/[、，,；;｜|／/]+/)
    .map(mentionName)
    .filter(Boolean)
    .filter(name => !EMPTY_CHARACTER_NAMES.has(name.toLowerCase()))
  const scene = mentionName(sceneSection.replace(/^[：:\s｜|／/]+/, ''))
  return {
    names,
    scene: scene && !EMPTY_SCENE_NAMES.has(scene.toLowerCase()) ? scene : null,
  }
}

function normalizeNarration(line: string) {
  let result = ''
  let rest = line
  while (rest) {
    const match = NARRATION_RE.exec(rest)
    if (!match) {
      result += rest
      break
    }
    result += rest.slice(0, match.index) + '旁白（画外音）：'
    rest = rest.slice(match.index + match[0].length)
    if (rest.startsWith('「')) {
      const close = rest.indexOf('」')
      if (close >= 0) {
        result += rest.slice(0, close + 1)
        rest = rest.slice(close + 1)
        continue
      }
    }
    const next = NARRATION_RE.exec(rest)
    const end = next ? next.index : rest.length
    const spoken = rest.slice(0, end).trim().replace(/^「+/, '').replace(/」+$/, '').trim()
    result += spoken ? `「${spoken}」` : ''
    rest = next ? rest.slice(end) : ''
  }
  return result
}

function normalizeVideoPromptBody(lines: string[]) {
  return lines
    .filter(line => !AUDIO_DIRECTIVE_RE.test(line))
    .map(line => normalizeNarration(line.replace(TIME_SEGMENT_RE, '$1$2-$3$4')))
}

function normalizeVideoPrompt(
  prompt: string | undefined,
  names: string[],
  sceneName: string | null | undefined,
  language: string | null | undefined,
) {
  if (!prompt || !prompt.trim()) return prompt
  const lines = prompt.split(/\r?\n/)
  const headerIndex = lines.findIndex(line => line.trim())
  const parsed = headerIndex >= 0 ? parseVideoPromptHeader(lines[headerIndex]) : null
  const useBindings = names.length > 0 || Boolean(sceneName)
  const header = buildVideoPromptHeader(
    useBindings ? names : parsed?.names ?? [],
    useBindings ? sceneName : parsed?.scene ?? null,
    language,
  )
  const bodyLines = parsed
    ? lines.filter((_, index) => index !== headerIndex)
    : [...lines]
  while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift()
  while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop()
  const body = normalizeVideoPromptBody(bodyLines).join('\n')
  return body.trim() ? `${header}\n${body}` : header
}

const saveStoryboards = createTool({
  id: 'save_storyboards',
  description: 'Save storyboards for this episode. Call in batches of at most 8 storyboards: the first batch must set replace_existing: true (clears all old storyboards for the episode, then writes), every following batch omits replace_existing (appends). Rows are upserted by shot_number, so overlapping batches and retries never create duplicates.',
  inputSchema: z.object({
    replace_existing: z.boolean().optional(),
    storyboards: z.array(storyboardFields),
  }),
  execute: async ({ storyboards, replace_existing }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const chunk = getChunkRuntime(context)
    const chunkMode = isChunkMode(chunk)
    const ts = now()
    logTaskProgress('StoryboardTool', 'save-begin', {
      episodeId,
      dramaId,
      chunkIndex: chunkMode ? chunk.index : undefined,
      replaceExisting: replace_existing === true,
      count: storyboards.length,
      shotNumbers: storyboards.map(sb => sb.shot_number).join(','),
    })
    // Check all voice references before replace_existing can remove the previous storyboards.
    for (const sb of storyboards) {
      await validateVideoPromptVoices(sb.video_prompt, dramaId, sb.character_ids)
    }
    // 分块模式忽略模型自带的 shot_number，按剧情顺序由系统连续编号，避免块间撞号覆盖
    const batch = chunkMode
      ? [...storyboards].sort((a, b) => a.shot_number - b.shot_number)
      : storyboards

    // 资产别名与 canonical 场景必须在查询/清空旧分镜之前归一，避免保存后仍引用别名
    const aliasMap = await buildAssetAliasMap(dramaId)
    const canonicalGroups = await getCanonicalSceneGroups(dramaId)
    const canonicalSceneMap = new Map<number, number>()
    for (const group of canonicalGroups) {
      for (const aliasId of group.aliasIds) canonicalSceneMap.set(aliasId, group.canonicalId)
    }
    for (const sb of batch) {
      sb.description = stripPlaceholderDialogue(applyAssetAliases(sb.description, aliasMap))
      sb.video_prompt = stripPlaceholderDialogue(applyAssetAliases(sb.video_prompt, aliasMap))
      if (typeof sb.scene_id === 'number') sb.scene_id = canonicalSceneMap.get(sb.scene_id) ?? sb.scene_id
      // 模型只填 location 没填 scene_id 时，按 canonical 场景名自动绑定，避免整镜无场景
      if (sb.scene_id == null && sb.location) {
        const group = resolveCanonicalSceneByName(canonicalGroups, sb.location)
        if (group) sb.scene_id = group.canonicalId
      }
    }

    // 角色/场景名查询与提示词规范化必须在清空旧分镜之前完成：
    // 台词完整性校验一旦失败就拒绝整批保存，不能先删旧数据再报错
    const characterIds = [...new Set(batch.flatMap(sb => sb.character_ids || []).filter(Boolean))]
    const sceneIds = [...new Set(batch
      .map(sb => sb.scene_id)
      .filter((id): id is number => typeof id === 'number'))]
    const characterNameMap = new Map<number, string>()
    const sceneNameMap = new Map<number, string>()
    if (characterIds.length) {
      const rows = await db.select({ id: schema.characters.id, name: schema.characters.name })
        .from(schema.characters)
        .where(and(
          eq(schema.characters.dramaId, dramaId),
          inArray(schema.characters.id, characterIds),
          isNull(schema.characters.deletedAt),
        ))
      for (const row of rows) characterNameMap.set(row.id, row.name)
    }
    if (sceneIds.length) {
      const rows = await db.select({ id: schema.scenes.id, location: schema.scenes.location })
        .from(schema.scenes)
        .where(and(
          eq(schema.scenes.dramaId, dramaId),
          inArray(schema.scenes.id, sceneIds),
          isNull(schema.scenes.deletedAt),
        ))
      for (const row of rows) sceneNameMap.set(row.id, row.location)
    }
    const promptLanguage = getContentLanguageFromRC(context?.requestContext)
    const normalizedPrompts = batch.map((sb) => {
      const characterNames = (sb.character_ids || [])
        .map(id => characterNameMap.get(id))
        .filter((name): name is string => Boolean(name))
      const sceneName = sb.scene_id != null ? sceneNameMap.get(sb.scene_id) ?? null : null
      const normalized = normalizeVideoPrompt(sb.video_prompt, characterNames, sceneName, promptLanguage)
      return normalized
    })
    // 分块模式由系统控制替换：仅第 1 块第一次保存时清空旧分镜
    const shouldReplace = chunkMode
      ? chunk.index === 0 && !chunk.state!.replaced
      : replace_existing === true

    // 场景左右归一：用同场第一镜建立左右表，后续镜头自动纠正，避免模型反复翻转
    if (chunkMode) {
      const allCharacters = await db.select({ id: schema.characters.id, name: schema.characters.name })
        .from(schema.characters)
        .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
      const plans = new Map<number, ReturnType<typeof createSceneSidePlan>>()
      if (!shouldReplace) {
        const live = await db.select().from(schema.storyboards)
          .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
          .orderBy(schema.storyboards.storyboardNumber)
        for (const row of live) {
          if (row.sceneId == null || row.transitionKind || !row.videoPrompt) continue
          const links = await db.select().from(schema.storyboardCharacters)
            .where(eq(schema.storyboardCharacters.storyboardId, row.id))
          const parsed = parseContractFromPrompt(row.videoPrompt, allCharacters, links.map(link => link.characterId))
          if (parsed.contractVersion <= 0) continue
          const plan = plans.get(row.sceneId) || createSceneSidePlan(undefined, row.videoPrompt)
          plans.set(row.sceneId, plan)
          // replace only the plan's latest shot for this scene; use last live row
          plan.left = new Set(parsed.screenLeft)
          plan.right = new Set(parsed.screenRight)
        }
      }
      for (let index = 0; index < batch.length; index += 1) {
        const sb = batch[index]
        if (sb.scene_id == null) continue
        const plan = plans.get(sb.scene_id) || createSceneSidePlan()
        const normalized = normalizeSceneSides(normalizedPrompts[index] || '', plan, allCharacters)
        if (normalized.swapped) {
          normalizedPrompts[index] = normalized.prompt
          sb.video_prompt = normalized.prompt
          logTaskWarn('StoryboardTool', 'scene-side-normalized', {
            episodeId,
            shotNumber: sb.shot_number,
            sceneId: sb.scene_id,
          })
        }
        plans.set(sb.scene_id, plan)
      }
    }

    // 强校验只作用于分块拆分保存；普通 save/update 仍允许旧的单字段编辑
    const unitErrors = chunkMode
      ? batch.flatMap((sb, index) => {
          if (!String(sb.video_prompt || '').trim()) return []
          return validateStoryboardUnit({
            description: sb.description,
            videoPrompt: normalizedPrompts[index],
            characterIds: sb.character_ids,
            duration: sb.duration,
            shotLabel: `本块第 ${index + 1} 个分镜`,
          })
        })
      : []
    if (unitErrors.length) {
      logTaskWarn('StoryboardTool', 'unit-contract-rejected', {
        episodeId,
        errors: unitErrors.join('；'),
      })
      throw new Error(
        `拒绝保存：分镜不符合「一个机位/一个主体/一个连续动作 + 固定四区」硬约束。${unitErrors.join('；')}。请拆成独立分镜并补齐画面调度、动作起点/终点、负面约束后重试。`,
      )
    }
    if (chunkMode) {
      const allCharacters = await db.select({ id: schema.characters.id, name: schema.characters.name })
        .from(schema.characters)
        .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
      const parsedContracts = batch.map((sb, index) => parseContractFromPrompt(
        normalizedPrompts[index],
        allCharacters,
        sb.character_ids || [],
      ))
      const pairShot = (parsed: ReturnType<typeof parseContractFromPrompt>, sceneId: number | null | undefined, number: number, id: number) => ({
        id,
        storyboardNumber: number,
        sceneId: sceneId ?? null,
        coverageType: null as string | null,
        axisSide: parsed.axisSide,
        screenLeft: parsed.screenLeft,
        screenRight: parsed.screenRight,
        foregroundShoulder: parsed.foregroundShoulder,
        castOnScreen: parsed.castOnScreen,
        backgroundLandmarks: parsed.backgroundLandmarks,
        sceneGeographyId: null as number | null,
        contractVersion: parsed.contractVersion,
        transition: 'cut',
        actionStart: parsed.actionStart,
        actionEnd: parsed.actionEnd,
      })
      const entries = batch.map((sb, index) => pairShot(parsedContracts[index], sb.scene_id, sb.shot_number, index + 1))
      const missingSides = batch.flatMap((sb, index) => {
        if ((sb.character_ids?.length || 0) < 2) return []
        const parsed = parsedContracts[index]
        const errors: string[] = []
        if (!parsed.screenLeft.length || !parsed.screenRight.length) {
          errors.push(`本块第 ${index + 1} 个分镜有多个画内角色，但画面左/右没有写全角色`)
        }
        if (!parsed.axisSide) errors.push(`本块第 ${index + 1} 个分镜有多个画内角色，但缺少轴线A/B`)
        return errors
      })
      if (missingSides.length) {
        throw new Error(`拒绝保存：${missingSides.join('；')}。请补齐画面左右、轴线和背景地标后再保存。`)
      }
      if (!shouldReplace) {
        const [previous] = await db.select().from(schema.storyboards)
          .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
          .orderBy(desc(schema.storyboards.storyboardNumber))
          .limit(1)
        if (previous && !previous.transitionKind && previous.sceneId != null && previous.videoPrompt) {
          const previousLinks = await db.select().from(schema.storyboardCharacters)
            .where(eq(schema.storyboardCharacters.storyboardId, previous.id))
          const previousParsed = parseContractFromPrompt(
            previous.videoPrompt,
            allCharacters,
            previousLinks.map(link => link.characterId),
          )
          if (previousParsed.contractVersion > 0) {
            entries.unshift(pairShot(previousParsed, previous.sceneId, previous.storyboardNumber, previous.id))
          }
        }
      }
      const pairErrors: string[] = []
      for (let i = 1; i < entries.length; i += 1) {
        const from = entries[i - 1]
        const to = entries[i]
        if (from.sceneId == null || from.sceneId !== to.sceneId) continue
        if (from.contractVersion <= 0 || to.contractVersion <= 0) continue
        const issues = evaluateContractPairIssues(from, to)
          .filter(issue => ['screen_direction_flip', 'set_mirror', 'axis_cross'].includes(issue.code))
        for (const issue of issues) pairErrors.push(`${issue.message}${issue.evidence ? `（${issue.evidence}）` : ''}`)
      }
      if (pairErrors.length) {
        logTaskWarn('StoryboardTool', 'scene-direction-rejected', { episodeId, errors: pairErrors.join('；') })
        throw new Error(
          `拒绝保存：同一场戏的屏幕左右/地标/轴线发生翻转。${pairErrors.join('；')}。同一场戏先定一次屏幕左右、轴线和地标侧，后续同场分镜必须沿用。`,
        )
      }
    }
    const dialogueFailures = batch.flatMap((sb, index) => {
      const report = inspectDialogueIntegrity(sb.description, normalizedPrompts[index])
      if (!report || report.ok) return []
      return [formatDialogueIntegrityIssue(
        report,
        chunkMode ? `本块第 ${index + 1} 个分镜` : `第 ${sb.shot_number} 镜`,
      )]
    })
    if (dialogueFailures.length) {
      logTaskWarn('StoryboardTool', 'dialogue-integrity-rejected', {
        episodeId,
        failures: dialogueFailures.join('；'),
      })
      throw new Error(
        `拒绝保存：video_prompt 没有逐字保留 description 的台词和标点。3 秒分段可以拆开句子，但不允许压缩、删字、改字或丢标点。${dialogueFailures.join('；')}。请从 description 逐字复制台词（含全部标点）后重试。`,
      )
    }

    // 分块模式由系统控制替换：仅第 1 块第一次保存时清空旧分镜；
    // 后续块/同块后续批次即使模型按基础提示词传了 replace_existing 也只能追加
    if (shouldReplace) {
      await clearEpisodeStoryboards(episodeId, ts)
      if (chunkMode) chunk.state!.replaced = true
    }

    // shot_number → id 索引（含本次调用内新增的行），保证按分镜号幂等 upsert
    const existingRows = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
    const shotToId = new Map<number, number>(
      existingRows.filter(sb => !sb.deletedAt).map(sb => [sb.storyboardNumber, sb.id]),
    )
    const patchedShots: number[] = []

    for (const [index, sb] of batch.entries()) {
      await validateStoryboardBindings(episodeId, dramaId, sb.scene_id, sb.character_ids, sb.prop_ids)
      const shotNumber = chunkMode ? chunk.state!.nextShot : sb.shot_number
      const videoPrompt = normalizedPrompts[index]
      if (videoPrompt !== sb.video_prompt) patchedShots.push(shotNumber)
      const existingId = chunkMode ? undefined : shotToId.get(shotNumber)
      if (existingId !== undefined) {
        await db.update(schema.storyboards).set({
          title: sb.title, shotType: sb.shot_type,
          angle: sb.angle, movement: sb.movement,
          location: sb.location, time: sb.time,
          description: sb.description, result: sb.result,
          atmosphere: sb.atmosphere, imagePrompt: sb.image_prompt,
          videoPrompt, bgmPrompt: sb.bgm_prompt,
          soundEffect: sb.sound_effect,
          transition: sb.transition || 'cut', continuity: sb.continuity,
          sceneId: sb.scene_id, duration: sb.duration || 10,
          updatedAt: ts,
        }).where(eq(schema.storyboards.id, existingId))
        if (chunkMode) chunk.state!.nextShot = shotNumber + 1
        await syncStoryboardCharacters(existingId, sb.character_ids || [])
        await syncStoryboardProps(existingId, sb.prop_ids || [])
        await syncContractSafe(existingId)
      } else {
        const res = await db.insert(schema.storyboards).values({
          episodeId,
          storyboardNumber: shotNumber,
          title: sb.title, shotType: sb.shot_type,
          angle: sb.angle, movement: sb.movement,
          location: sb.location, time: sb.time,
          description: sb.description, result: sb.result,
          atmosphere: sb.atmosphere, imagePrompt: sb.image_prompt,
          videoPrompt, bgmPrompt: sb.bgm_prompt,
          soundEffect: sb.sound_effect,
          transition: sb.transition || 'cut', continuity: sb.continuity,
          sceneId: sb.scene_id, duration: sb.duration || 10,
          createdAt: ts, updatedAt: ts,
        })
        const newId = getInsertId(res)
        shotToId.set(shotNumber, newId)
        if (chunkMode) chunk.state!.nextShot = shotNumber + 1
        await syncStoryboardCharacters(newId, sb.character_ids || [])
        await syncStoryboardProps(newId, sb.prop_ids || [])
        await syncContractSafe(newId)
      }
    }

    if (patchedShots.length) {
      logTaskWarn('StoryboardTool', 'video-prompt-header-patched', {
        episodeId,
        count: patchedShots.length,
        shotNumbers: patchedShots.join(','),
      })
    }

    // 整集时长 = 当前全部存活分镜时长之和（分批保存时不能再按单批累加）
    const allRows = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))
    const totalDuration = allRows
      .filter(sb => !sb.deletedAt)
      .reduce((sum, sb) => sum + (sb.duration || 0), 0)

    await db.update(schema.episodes)
      .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
      .where(eq(schema.episodes.id, episodeId))

    logTaskSuccess('StoryboardTool', 'save-complete', {
      episodeId,
      count: storyboards.length,
      totalDuration,
    })
    return { message: `Saved ${storyboards.length} storyboards`, count: storyboards.length, total_duration: totalDuration }
  },
})

const updateStoryboard = createTool({
  id: 'update_storyboard',
  description: 'Update a specific storyboard shot.',
  inputSchema: z.object({
    storyboard_id: z.number(),
    title: z.string().optional(),
    shot_type: z.string().optional(),
    angle: z.string().optional(),
    movement: z.string().optional(),
    location: z.string().optional(),
    time: z.string().optional(),
    result: z.string().optional(),
    atmosphere: z.string().optional(),
    image_prompt: z.string().optional(),
    video_prompt: z.string().optional(),
    bgm_prompt: z.string().optional(),
    sound_effect: z.string().optional(),
    description: z.string().optional(),
    transition: z.enum(['cut', 'fade', 'dissolve', 'wipe']).optional(),
    continuity: z.string().optional(),
    scene_id: z.number().nullable().optional(),
    character_ids: z.array(z.number()).optional(),
    prop_ids: z.array(z.number()).optional(),
    duration: z.number().optional(),
  }),
  execute: async ({ storyboard_id, ...fields }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id))
    if (!storyboard || storyboard.episodeId !== episodeId || storyboard.deletedAt) return { error: `Storyboard ${storyboard_id} not found in this episode` }

    // 过滤模型回传的垃圾值：视频提示词 Agent 常把整行字段回传，
    // 拿不准的字符串字段写成 "null"/"undefined"，直接覆盖会毁掉已有内容
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const v = fields[key]
      if (typeof v === 'string' && (v === 'null' || v === 'undefined' || v === 'NULL' || v === 'Null')) {
        delete fields[key]
      }
    }

    logTaskProgress('StoryboardTool', 'update-begin', {
      episodeId,
      storyboardId: storyboard_id,
      fields: Object.keys(fields),
    })

    const aliasMap = await buildAssetAliasMap(dramaId)
    if ('description' in fields) fields.description = stripPlaceholderDialogue(applyAssetAliases(fields.description, aliasMap))
    if ('video_prompt' in fields) fields.video_prompt = stripPlaceholderDialogue(applyAssetAliases(fields.video_prompt, aliasMap))
    if ('scene_id' in fields) fields.scene_id = await resolveCanonicalSceneId(dramaId, fields.scene_id)

    const currentCharacterIds = ('character_ids' in fields
      ? fields.character_ids
      : (await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)))
          .map(link => link.characterId)) ?? []

    const currentPropIds = 'prop_ids' in fields
      ? fields.prop_ids
      : (await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, storyboard_id)))
          .map(link => link.propId)

    await validateVideoPromptVoices(fields.video_prompt, dramaId, currentCharacterIds)
    await validateStoryboardBindings(
      episodeId,
      dramaId,
      'scene_id' in fields ? fields.scene_id : storyboard.sceneId,
      currentCharacterIds,
      currentPropIds,
    )

    if ('video_prompt' in fields) {
      const uniqueCharacterIds = [...new Set(currentCharacterIds.filter(Boolean))]
      const characterNameMap = new Map<number, string>()
      if (uniqueCharacterIds.length) {
        const rows = await db.select({ id: schema.characters.id, name: schema.characters.name })
          .from(schema.characters)
          .where(and(
            eq(schema.characters.dramaId, dramaId),
            inArray(schema.characters.id, uniqueCharacterIds),
            isNull(schema.characters.deletedAt),
          ))
        for (const row of rows) characterNameMap.set(row.id, row.name)
      }
      const sceneId = 'scene_id' in fields ? fields.scene_id : storyboard.sceneId
      let sceneName: string | null = null
      if (sceneId != null) {
        const [scene] = await db.select({ location: schema.scenes.location })
          .from(schema.scenes)
          .where(and(
            eq(schema.scenes.id, sceneId),
            eq(schema.scenes.dramaId, dramaId),
            isNull(schema.scenes.deletedAt),
          ))
        sceneName = scene?.location ?? null
      }
      fields.video_prompt = normalizeVideoPrompt(
        fields.video_prompt,
        uniqueCharacterIds
          .map(id => characterNameMap.get(id))
          .filter((name): name is string => Boolean(name)),
        sceneName,
        getContentLanguageFromRC(context?.requestContext),
      ) || ''
      // 重新生成的提示词可能只写四区；保留第四步已写入的声音短增量
      if (!parseSoundSection(fields.video_prompt)) {
        const previousSound = parseSoundSection(storyboard.videoPrompt)
        if (previousSound) {
          fields.video_prompt = setSoundSection(
            fields.video_prompt,
            previousSound,
            getContentLanguageFromRC(context?.requestContext),
          )
        }
      }
      const effectiveDescription = 'description' in fields ? fields.description : storyboard.description
      // 只有同时重写 description + video_prompt 时才做完整单位校验；单改提示词保留手工编辑能力
      if ('description' in fields) {
        const unitErrors = validateStoryboardUnit({
          description: effectiveDescription,
          videoPrompt: fields.video_prompt,
          characterIds: currentCharacterIds,
          duration: 'duration' in fields ? fields.duration : storyboard.duration,
          shotLabel: `分镜 ${storyboard.storyboardNumber}`,
          checkSubshots: true,
        })
        if (unitErrors.length) {
          throw new Error(
            `拒绝更新：${unitErrors.join('；')}。请补齐固定四区并保证一个分镜只有一个连续镜头。`,
          )
        }
      }
      const integrity = inspectDialogueIntegrity(effectiveDescription, fields.video_prompt)
      if (integrity && !integrity.ok) {
        throw new Error(
          `拒绝更新：${formatDialogueIntegrityIssue(integrity, `分镜 ${storyboard.storyboardNumber}`)}。3 秒分段可以拆开句子，但台词必须从 description 逐字复制并保留全部标点；请修正后重试。`,
        )
      }
    }

    const updates: Record<string, any> = { updatedAt: now() }
    if ('title' in fields) updates.title = fields.title
    if ('shot_type' in fields) updates.shotType = fields.shot_type
    if ('angle' in fields) updates.angle = fields.angle
    if ('movement' in fields) updates.movement = fields.movement
    if ('location' in fields) updates.location = fields.location
    if ('time' in fields) updates.time = fields.time
    if ('result' in fields) updates.result = fields.result
    if ('atmosphere' in fields) updates.atmosphere = fields.atmosphere
    if ('image_prompt' in fields) updates.imagePrompt = fields.image_prompt
    if ('video_prompt' in fields) {
      updates.videoPrompt = fields.video_prompt
      updates.finalPromptOverride = null
    }
    if ('bgm_prompt' in fields) updates.bgmPrompt = fields.bgm_prompt
    if ('sound_effect' in fields) updates.soundEffect = fields.sound_effect
    if ('transition' in fields) updates.transition = fields.transition
    if ('continuity' in fields) updates.continuity = fields.continuity
    if ('description' in fields) updates.description = fields.description
    if ('scene_id' in fields) updates.sceneId = fields.scene_id
    if ('duration' in fields) updates.duration = fields.duration
    await db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id))
    if ('character_ids' in fields) await syncStoryboardCharacters(storyboard_id, fields.character_ids || [])
    if ('prop_ids' in fields) await syncStoryboardProps(storyboard_id, fields.prop_ids || [])
    if (['video_prompt', 'character_ids', 'description', 'shot_type', 'duration'].some(key => key in fields)) {
      await syncContractSafe(storyboard_id)
    }
    logTaskSuccess('StoryboardTool', 'update-complete', {
      episodeId,
      storyboardId: storyboard_id,
      updatedFields: Object.keys(updates),
      characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      propIds: 'prop_ids' in fields ? (fields.prop_ids || []).join(',') : undefined,
    })
    return { message: `Storyboard ${storyboard_id} updated` }
  },
})

const readStoryboardPipelineContext = createTool({
  id: 'read_storyboard_pipeline_context',
  description: 'Read context for the current four-stage storyboard pipeline stage: skeleton, repair, or sound.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const runtime = getPipelineRuntime(context)
    const stage = runtime.stage || 'skeleton'
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep) return { error: 'Episode not found' }

    const chars = (await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId))).filter(c => !c.deletedAt)
    const scns = (await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId))).filter(s => !s.deletedAt)
    const prps = (await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId))).filter(p => !p.deletedAt)
    const characters = chars.map(c => ({
      id: c.id,
      name: c.name,
      role: c.role || '',
      appearance: c.appearance || '',
      styling: c.styling || '',
      has_voice: Boolean(c.voiceAudioUrl?.trim()),
      voice_reference: c.voiceAudioUrl?.trim() ? `#${c.name}` : null,
    }))
    const scenes = scns.map(s => ({
      id: s.id,
      location: s.location,
      time: s.time,
      prompt: s.prompt || '',
      lighting: s.lighting || '',
    }))
    const props = prps.map(p => ({ id: p.id, name: p.name, type: p.type || '', description: p.description || '' }))

    if (stage === 'skeleton') {
      const canonicalGroups = await getCanonicalSceneGroups(dramaId)
      return {
        stage,
        project: { background: await getDramaBackground(dramaId) },
        episode: { id: ep.id, title: ep.title, episode_number: ep.episodeNumber },
        chunk: runtime.chunk ? {
          index: (runtime.chunk.index || 0) + 1,
          total: runtime.chunk.total || 0,
          label: runtime.chunk.label || '',
          script: runtime.chunk.script || '',
        } : null,
        previous_skeletons: runtime.previousShots || [],
        canonical_scenes: canonicalGroups.map(group => ({
          scene_id: group.canonicalId,
          location: group.name,
          aliases: group.aliasIds,
        })),
        characters,
        scenes,
        props,
      }
    }

    if (stage === 'repair') {
      return {
        stage,
        episode: { id: ep.id, title: ep.title, episode_number: ep.episodeNumber },
        target_shot_number: runtime.shotNumber || null,
        skeleton: runtime.skeleton || null,
        scene_text: runtime.sceneText || '',
        novel_scene_text: runtime.novelSceneText || '',
        previous_repaired_shots: runtime.previousShots || [],
        next_draft_shots: runtime.nextDrafts || [],
        known_issues: runtime.issues || [],
        characters,
        scenes,
        props,
      }
    }

    const shots = (await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)))
      .filter(row => !row.deletedAt)
      .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
    const links = await db.select().from(schema.storyboardCharacters)
      .where(inArray(schema.storyboardCharacters.storyboardId, shots.map(row => row.id)))
    const linkMap = new Map<number, number[]>()
    for (const link of links) {
      const list = linkMap.get(link.storyboardId) || []
      list.push(link.characterId)
      linkMap.set(link.storyboardId, list)
    }
    return {
      stage: 'sound',
      episode: { id: ep.id, title: ep.title, episode_number: ep.episodeNumber },
      shots: shots.map(row => ({
        shot_number: row.storyboardNumber,
        storyboard_id: row.id,
        scene_id: row.sceneId,
        location: row.location || '',
        time: row.time || '',
        duration: row.duration || 0,
        transition: row.transition || 'cut',
        transition_kind: row.transitionKind || null,
        description: row.description || '',
        has_dialogue: inspectDialogueIntegrity(row.description, row.videoPrompt) !== null,
        sound_effect: row.soundEffect || '',
        character_ids: linkMap.get(row.id) || [],
      })),
      characters,
      scenes,
      props,
    }
  },
})

const skeletonFields = z.object({
  title: z.string().optional(),
  scene_id: z.number().nullable().optional(),
  location: z.string().optional(),
  time: z.string().optional(),
  character_ids: z.array(z.number()).optional(),
  prop_ids: z.array(z.number()).optional(),
  duration: z.number(),
  transition: z.enum(['cut', 'fade', 'dissolve', 'wipe']).optional(),
  continuity: z.string().optional(),
  action_summary: z.string(),
  source_excerpt: z.string(),
  action_start: z.string().optional(),
  action_end: z.string().optional(),
  coverage_type: z.string().optional(),
  boundary_type: z.enum(['speech', 'action', 'reaction', 'scene', 'time']).optional(),
  boundary_word: z.string().optional(),
  screen_left: z.string().optional(),
  screen_right: z.string().optional(),
  axis_side: z.string().optional(),
  landmark_side: z.string().optional(),
})

function normalizeExcerptText(text: string) {
  return String(text || '').replace(/\s+/g, '')
}

const saveStoryboardSkeletons = createTool({
  id: 'save_storyboard_skeletons',
  description: 'Save storyboard skeletons for the current script chunk. Skeletons contain only scene, cast, duration, action summary and a verbatim source excerpt; do not write final dialogue or video prompts here.',
  inputSchema: z.object({ skeletons: z.array(skeletonFields) }),
  execute: async ({ skeletons }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const runtime = getPipelineRuntime(context)
    if (runtime.stage !== 'skeleton' || !runtime.chunk?.state) {
      return { error: 'save_storyboard_skeletons 只能在预拆阶段调用' }
    }
    const chunkScript = String(runtime.chunk.script || '')
    if (!chunkScript.trim()) return { error: '预拆分段为空' }
    const normalizedScript = normalizeExcerptText(chunkScript)
    const state = runtime.chunk.state
    let cursor = state.excerptCursor || 0
    const errors: string[] = []

    const aliasMap = await buildAssetAliasMap(dramaId)
    const canonicalGroups = await getCanonicalSceneGroups(dramaId)
    const canonicalSceneMap = new Map<number, number>()
    for (const group of canonicalGroups) {
      for (const aliasId of group.aliasIds) canonicalSceneMap.set(aliasId, group.canonicalId)
    }

    const rows: Array<typeof schema.storyboardSkeletons.$inferInsert> = []
    const planShots: PlanShot[] = []
    for (const [index, skeleton] of skeletons.entries()) {
      const excerpt = String(skeleton.source_excerpt || '').trim()
      const summary = String(skeleton.action_summary || '').trim()
      const storyboardNumber = state.nextShot + index
      const label = `本块第 ${index + 1} 个骨架`
      if (!summary) errors.push(`${label}缺少动作摘要。`)
      if (!excerpt) errors.push(`${label}缺少原文摘录。`)
      const speechSegments = extractPlanSpeechSegments(excerpt)
      const duration = Number(skeleton.duration || 0)
      if (duration < 6 || duration > 15) errors.push(`${label}时长 ${duration} 秒，必须在 6-15 秒之间。`)
      if (excerpt) {
        const normalizedExcerpt = normalizeExcerptText(excerpt)
        const position = normalizedScript.indexOf(normalizedExcerpt, cursor)
        if (position < 0) {
          errors.push(`${label}的原文摘录不是本段剧本的逐字内容（允许去空白），不能改写、概括或跨段摘取。`)
        } else {
          cursor = position + normalizedExcerpt.length
        }
      }

      let sceneId = typeof skeleton.scene_id === 'number'
        ? canonicalSceneMap.get(skeleton.scene_id) ?? skeleton.scene_id
        : null
      const location = String(skeleton.location || '').trim()
      if (sceneId == null && location) {
        const group = resolveCanonicalSceneByName(canonicalGroups, location)
        if (group) sceneId = group.canonicalId
      }
      if (sceneId == null) errors.push(`${label}没有绑定场景；请填写 scene_id 或可匹配的场景 location。`)
      try {
        await validateStoryboardBindings(episodeId, dramaId, sceneId, skeleton.character_ids, skeleton.prop_ids)
      } catch (error) {
        errors.push(`${label}${error instanceof Error ? error.message : String(error)}`)
      }
      const scene = sceneId != null ? canonicalGroups.find(group => group.canonicalId === sceneId) : null
      rows.push({
        jobId: runtime.jobId!,
        episodeId,
        dramaId,
        chunkIndex: runtime.chunk.index ?? null,
        storyboardNumber,
        sceneId,
        title: skeleton.title ? applyAssetAliases(skeleton.title, aliasMap) : null,
        location: location || scene?.name || null,
        time: skeleton.time || null,
        characterIds: JSON.stringify([...new Set(skeleton.character_ids || [])]),
        propIds: JSON.stringify([...new Set(skeleton.prop_ids || [])]),
        duration,
        transition: skeleton.transition || 'cut',
        continuity: skeleton.continuity || null,
        actionStart: skeleton.action_start?.trim() || null,
        actionEnd: skeleton.action_end?.trim() || null,
        coverageType: skeleton.coverage_type?.trim() || null,
        speechSegmentsJson: JSON.stringify(speechSegments),
        boundaryType: skeleton.boundary_type || (speechSegments.length ? 'speech' : 'action'),
        boundaryWord: skeleton.boundary_word?.trim() || null,
        screenLeft: skeleton.screen_left?.trim() || null,
        screenRight: skeleton.screen_right?.trim() || null,
        axisSide: skeleton.axis_side?.trim() || null,
        landmarkSide: skeleton.landmark_side?.trim() || null,
        planVersion: 1,
        actionSummary: applyAssetAliases(summary, aliasMap),
        sourceExcerpt: excerpt,
        status: 'draft',
        createdAt: now(),
        updatedAt: now(),
      })
      planShots.push({
        shotNumber: storyboardNumber,
        sceneId,
        sourceExcerpt: excerpt,
        duration,
        actionStart: skeleton.action_start?.trim() || null,
        actionEnd: skeleton.action_end?.trim() || null,
        coverageType: skeleton.coverage_type?.trim() || null,
        speechSegments,
        boundaryType: skeleton.boundary_type || (speechSegments.length ? 'speech' : 'action'),
        boundaryWord: skeleton.boundary_word?.trim() || null,
        screenLeft: skeleton.screen_left?.trim() || null,
        screenRight: skeleton.screen_right?.trim() || null,
        axisSide: skeleton.axis_side?.trim() || null,
        landmarkSide: skeleton.landmark_side?.trim() || null,
      })
    }
    if (!errors.length && planShots.length) {
      const episode = db.select({ breakdownMethod: schema.episodes.breakdownMethod })
        .from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId))
        .get()
      const previous = db.select().from(schema.storyboardSkeletons)
        .where(eq(schema.storyboardSkeletons.jobId, runtime.jobId!))
        .orderBy(desc(schema.storyboardSkeletons.storyboardNumber))
        .limit(1)
        .get()
      const previousPlan: PlanShot | null = previous ? {
        shotNumber: previous.storyboardNumber,
        sceneId: previous.sceneId,
        sourceExcerpt: previous.sourceExcerpt,
        duration: previous.duration || 0,
        actionStart: previous.actionStart,
        actionEnd: previous.actionEnd,
        coverageType: previous.coverageType,
        speechSegments: extractPlanSpeechSegments(previous.sourceExcerpt),
        boundaryType: previous.boundaryType,
        boundaryWord: previous.boundaryWord,
        screenLeft: previous.screenLeft,
        screenRight: previous.screenRight,
        axisSide: previous.axisSide,
        landmarkSide: previous.landmarkSide,
      } : null
      const planGate = validatePlanSequence(
        [...(previousPlan ? [previousPlan] : []), ...planShots],
        { minDuration: 6, maxDuration: getMaxSegmentSeconds(episode?.breakdownMethod) },
      )
      if (planGate.issues.some(item => item.severity === 'error')) {
        const messages = planGate.issues.filter(item => item.severity === 'error').map(item => item.message)
        logTaskWarn('StoryboardPipeline', 'plan-gate-rejected', { episodeId, errors: messages.join('；') })
        throw new Error(`拒绝保存骨架：${planIssuesText(planGate.issues.filter(item => item.severity === 'error'))}。请合并被拆开的说话提示与台词，或把上一镜截到提示之前。`)
      }
      for (const boundary of planGate.boundaries) {
        const row = rows.find(item => item.storyboardNumber === boundary.fromShotNumber)
        if (row) {
          row.boundaryOutJson = JSON.stringify(boundary)
        } else {
          db.update(schema.storyboardSkeletons)
            .set({ boundaryOutJson: JSON.stringify(boundary), updatedAt: now() })
            .where(and(
              eq(schema.storyboardSkeletons.jobId, runtime.jobId!),
              eq(schema.storyboardSkeletons.storyboardNumber, boundary.fromShotNumber),
            ))
            .run()
        }
      }
    }
    if (errors.length) {
      logTaskWarn('StoryboardPipeline', 'skeleton-rejected', { episodeId, errors: errors.join('；') })
      throw new Error(`拒绝保存骨架：${errors.join('；')}。原文摘录必须从本段剧本逐字截取，骨架不写最终台词和视频提示词。`)
    }
    for (const row of rows) db.insert(schema.storyboardSkeletons).values(row).run()
    state.nextShot += rows.length
    state.saved += rows.length
    state.excerptCursor = cursor
    const coverage = normalizedScript.length ? cursor / normalizedScript.length : 0
    logTaskSuccess('StoryboardPipeline', 'skeletons-saved', {
      jobId: runtime.jobId,
      chunk: (runtime.chunk.index || 0) + 1,
      count: rows.length,
      nextShot: state.nextShot,
      coverage: Number(coverage.toFixed(3)),
    })
    return {
      message: `Saved ${rows.length} storyboard skeletons`,
      count: rows.length,
      shot_numbers: rows.map(row => row.storyboardNumber),
      excerpt_coverage: Number(coverage.toFixed(3)),
    }
  },
})

const repairedShotFields = z.object({
  skeleton_id: z.number(),
  title: z.string().optional(),
  shot_type: z.string().optional(),
  angle: z.string().optional(),
  movement: z.string().optional(),
  atmosphere: z.string().optional(),
  image_prompt: z.string().optional(),
  description: z.string(),
  video_prompt: z.string(),
  transition: z.enum(['cut', 'fade', 'dissolve', 'wipe']).optional(),
  continuity: z.string().optional(),
  duration: z.number().optional(),
  scene_id: z.number().nullable().optional(),
  character_ids: z.array(z.number()).optional(),
  prop_ids: z.array(z.number()).optional(),
})

const saveRepairedStoryboard = createTool({
  id: 'save_repaired_storyboard',
  description: 'Save exactly one repaired storyboard shot. The shot must have a concrete description with any dialogue from the novel and a fixed four-section video_prompt. Server rejects the save when the shot fails per-shot validation.',
  inputSchema: repairedShotFields,
  execute: async (input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const runtime = getPipelineRuntime(context)
    const skeleton = runtime.skeleton
    if (runtime.stage !== 'repair' || !skeleton || !runtime.shotNumber) {
      return { error: 'save_repaired_storyboard 只能在逐镜修补阶段调用' }
    }
    if (Number(input.skeleton_id) !== Number(skeleton.id)) {
      return { error: `骨架 ID 不匹配：本轮只能修补骨架 ${skeleton.id}` }
    }
    const shotNumber = runtime.shotNumber
    const ts = now()
    const aliasMap = await buildAssetAliasMap(dramaId)
    const canonicalScene = await resolveCanonicalSceneId(
      dramaId,
      typeof input.scene_id === 'number' ? input.scene_id : (skeleton.sceneId ?? skeleton.scene_id ?? null),
    )
    const description = stripPlaceholderDialogue(applyAssetAliases(input.description || '', aliasMap))
    let videoPrompt = stripPlaceholderDialogue(applyAssetAliases(input.video_prompt || '', aliasMap))
    const characterIds: number[] = [...new Set<number>(
      ((input.character_ids ?? skeleton.characterIds ?? skeleton.character_ids ?? []) as number[]).filter(Boolean),
    )]
    const propIds: number[] = [...new Set<number>(
      ((input.prop_ids ?? skeleton.propIds ?? skeleton.prop_ids ?? []) as number[]).filter(Boolean),
    )]
    const duration = Number(input.duration || skeleton.duration || 0)
    await validateStoryboardBindings(episodeId, dramaId, canonicalScene, characterIds, propIds)
    if (canonicalScene == null) {
      return { error: '该镜没有场景；请补 scene_id 或 location 后重试。' }
    }

    const allCharacters = await db.select({ id: schema.characters.id, name: schema.characters.name })
      .from(schema.characters)
      .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
    const characterNameMap = new Map(allCharacters.map(row => [row.id, row.name]))
    const [sceneRow] = await db.select({ location: schema.scenes.location })
      .from(schema.scenes)
      .where(eq(schema.scenes.id, canonicalScene))
    videoPrompt = normalizeVideoPrompt(
      videoPrompt,
      characterIds.map(id => characterNameMap.get(id)).filter((name): name is string => Boolean(name)),
      sceneRow?.location || null,
      getContentLanguageFromRC(context?.requestContext),
    ) || ''
    await validateVideoPromptVoices(videoPrompt, dramaId, characterIds)

    const previous = runtime.previousShots?.[0] || null
    if (previous?.videoPrompt && previous?.sceneId === canonicalScene) {
      const previousContract = parseContractFromPrompt(
        previous.videoPrompt,
        allCharacters,
        previous.characterIds || [],
      )
      const plan = createSceneSidePlan(previousContract, previous.videoPrompt)
      const normalized = normalizeSceneSides(videoPrompt, plan, allCharacters)
      if (normalized.swapped) {
        videoPrompt = normalized.prompt
        logTaskWarn('StoryboardPipeline', 'scene-side-normalized', { episodeId, shotNumber })
      }
    }

    const values = {
      title: input.title || skeleton.title,
      shotType: input.shot_type,
      angle: input.angle,
      movement: input.movement,
      location: skeleton.location,
      time: skeleton.time,
      description,
      atmosphere: input.atmosphere,
      imagePrompt: input.image_prompt,
      videoPrompt,
      finalPromptOverride: null,
      transition: input.transition || skeleton.transition || 'cut',
      continuity: input.continuity || skeleton.continuity,
      sceneId: canonicalScene,
      duration,
      updatedAt: ts,
    }
    // 即使校验失败也落一行草稿：停下等人工时用户能在页面上直接修这一镜
    const persistCandidate = async () => {
      const [existing] = await db.select().from(schema.storyboards)
        .where(and(
          eq(schema.storyboards.episodeId, episodeId),
          eq(schema.storyboards.storyboardNumber, shotNumber),
        ))
      let storyboardId = existing?.id
      if (existing) {
        db.update(schema.storyboards).set(values).where(eq(schema.storyboards.id, existing.id)).run()
      } else {
        const res = await db.insert(schema.storyboards).values({
          episodeId,
          storyboardNumber: shotNumber,
          ...values,
          createdAt: ts,
        })
        storyboardId = getInsertId(res)
      }
      await syncStoryboardCharacters(storyboardId!, characterIds)
      await syncStoryboardProps(storyboardId!, propIds)
      await syncContractSafe(storyboardId!)
      return storyboardId!
    }

    const planSpeechSegments = (() => {
      try {
        const parsed = JSON.parse(skeleton.speechSegmentsJson || '[]')
        if (Array.isArray(parsed) && parsed.length) {
          return parsed.filter(item => item && typeof item.text === 'string')
        }
      } catch {
        // 旧骨架没有计划台词字段，从原文摘录补算
      }
      return extractPlanSpeechSegments(skeleton.sourceExcerpt).map(item => ({ speaker: item.speaker, text: item.text }))
    })()
    const validation = validateRepairedShot({
      sourceExcerpt: skeleton.sourceExcerpt,
      planSpeechSegments,
      description,
      videoPrompt,
      characterIds,
      duration,
      sceneId: canonicalScene,
      characters: allCharacters,
      shotLabel: `第 ${shotNumber} 镜`,
      previous: previous ? {
        storyboardNumber: previous.storyboardNumber,
        sceneId: previous.sceneId ?? null,
        videoPrompt: previous.videoPrompt || '',
        transition: previous.transition || 'cut',
        characterIds: previous.characterIds || [],
      } : null,
      transition: input.transition || skeleton.transition || 'cut',
    })
    if (validation.errors.length) {
      const draftId = await persistCandidate()
      db.update(schema.storyboardSkeletons).set({
        status: 'repairing',
        storyboardId: draftId,
        attempts: (skeleton.attempts || 0) + 1,
        issuesJson: JSON.stringify(validation.errors),
        updatedAt: ts,
      }).where(eq(schema.storyboardSkeletons.id, skeleton.id)).run()
      logTaskWarn('StoryboardPipeline', 'repair-rejected', {
        episodeId,
        shotNumber,
        storyboardId: draftId,
        errors: validation.errors.join('；'),
      })
      throw new Error(`拒绝保存：第 ${shotNumber} 镜未通过逐镜校验。${validation.errors.join('；')}`)
    }

    const storyboardId = await persistCandidate()
    const skeletonUpdate = db.update(schema.storyboardSkeletons).set({
      status: 'repaired',
      storyboardId,
      attempts: (skeleton.attempts || 0) + 1,
      issuesJson: validation.warnings.length ? JSON.stringify(validation.warnings) : null,
      repairLogJson: JSON.stringify({ at: ts, warnings: validation.warnings }),
      updatedAt: ts,
    }).where(eq(schema.storyboardSkeletons.id, Number(skeleton.id))).run()
    if (!skeletonUpdate.changes) {
      logTaskWarn('StoryboardPipeline', 'skeleton-update-missed', {
        skeletonId: skeleton.id,
        shotNumber,
      })
    }
    logTaskSuccess('StoryboardPipeline', 'shot-repaired', {
      episodeId,
      shotNumber,
      storyboardId,
      warnings: validation.warnings.length,
    })
    return {
      message: `第 ${shotNumber} 镜修补完成`,
      storyboard_id: storyboardId,
      shot_number: shotNumber,
      warnings: validation.warnings,
    }
  },
})

const soundCueFields = z.object({
  unit_key: z.string(),
  unit_label: z.string().optional(),
  kind: z.enum(['bgm', 'ambience', 'sfx', 'silence']),
  from_shot_number: z.number().int(),
  to_shot_number: z.number().int(),
  description: z.string(),
  intensity: z.string().optional(),
  entry: z.string().optional(),
  exit: z.string().optional(),
  delivery: z.enum(['native', 'post']).optional(),
})

const saveSoundPlan = createTool({
  id: 'save_sound_plan',
  description: 'Save the episode sound plan after all shots are validated. Cues span shots/scenes; each shot gets only a short sound delta, never a repeated full BGM style.',
  inputSchema: z.object({
    summary: z.string().optional(),
    delivery: z.enum(['native', 'post']),
    cues: z.array(soundCueFields),
  }),
  execute: async ({ summary, delivery, cues }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const runtime = getPipelineRuntime(context)
    if (runtime.stage !== 'sound') return { error: 'save_sound_plan 只能在声音设计阶段调用' }
    const ts = now()
    const shots = (await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId)))
      .filter(row => !row.deletedAt && !row.transitionKind)
      .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
    if (!shots.length) return { error: '本集没有可设计声音的分镜' }
    const shotByNumber = new Map(shots.map(row => [row.storyboardNumber, row]))
    const errors: string[] = []
    const normalizedCues: Array<ShotSoundCue & { unit_key: string; unit_label?: string; delivery: 'native' | 'post'; intensity?: string; entry?: string; exit?: string }> = []
    for (const [index, cue] of cues.entries()) {
      const label = `第 ${index + 1} 条声音线索`
      const from = shotByNumber.get(cue.from_shot_number)
      const to = shotByNumber.get(cue.to_shot_number)
      if (!from || !to) {
        errors.push(`${label}的起止镜头不在本集已校验分镜中。`)
        continue
      }
      if (cue.from_shot_number > cue.to_shot_number) errors.push(`${label}起止镜头颠倒。`)
      if (!cue.unit_key.trim()) errors.push(`${label}缺少 unit_key。`)
      if (!cue.description.trim()) errors.push(`${label}缺少声音描述。`)
      if (cue.delivery && cue.delivery !== delivery) {
        errors.push(`${label}的 delivery=${cue.delivery} 与整集 delivery=${delivery} 不一致；同一集不能混用 native/post BGM。`)
      }
      normalizedCues.push({
        kind: cue.kind,
        from_shot_number: cue.from_shot_number,
        to_shot_number: cue.to_shot_number,
        description: cue.description.trim(),
        intensity: cue.intensity,
        entry: cue.entry,
        exit: cue.exit,
        unit_key: cue.unit_key.trim(),
        unit_label: cue.unit_label,
        delivery: cue.delivery || delivery,
      })
    }

    // 同轨 BGM/环境声/静默不得重叠（跨声音单元也不行）；sfx 允许叠加
    const exclusive = normalizedCues.filter(cue => cue.kind !== 'sfx')
    for (let i = 0; i < exclusive.length; i += 1) {
      for (let j = i + 1; j < exclusive.length; j += 1) {
        const a = exclusive[i]
        const b = exclusive[j]
        if (a.kind !== b.kind) continue
        if (a.from_shot_number <= b.to_shot_number && b.from_shot_number <= a.to_shot_number) {
          errors.push(`${a.kind} 线索在镜头 ${Math.max(a.from_shot_number, b.from_shot_number)}-${Math.min(a.to_shot_number, b.to_shot_number)} 重叠；BGM/环境声/静默不能重叠或逐镜重启。`)
        }
      }
    }
    // 每个已校验镜头必须落在环境声或静默线索内
    const unitKeys = [...new Set(normalizedCues.map(cue => cue.unit_key))]
    const bgmByUnit = new Map<string, number>()
    for (const cue of normalizedCues) {
      if (cue.kind === 'bgm') bgmByUnit.set(cue.unit_key, (bgmByUnit.get(cue.unit_key) || 0) + 1)
    }
    for (const [unit, count] of bgmByUnit) {
      if (count > 1) errors.push(`声音单元「${unit}」起了 ${count} 段 BGM；同一单元只能建立一次 BGM 弧，后续分镜继续不重启。`)
    }
    // 同一场戏内不允许逐镜重起 BGM；除非中间有明确的静默区间
    const scenesById = new Map<number, typeof shots>()
    for (const shot of shots) {
      if (shot.sceneId == null) continue
      const list = scenesById.get(shot.sceneId) || []
      list.push(shot)
      scenesById.set(shot.sceneId, list)
    }
    for (const [sceneId, sceneShots] of scenesById) {
      const bgmCues = normalizedCues.filter(cue =>
        cue.kind === 'bgm'
        && sceneShots.some(shot => shot.storyboardNumber >= cue.from_shot_number && shot.storyboardNumber <= cue.to_shot_number))
      if (bgmCues.length <= 1) continue
      const silenceCoversGap = (from: number, to: number) => normalizedCues.some(cue =>
        cue.kind === 'silence' && cue.from_shot_number <= to && cue.to_shot_number >= from)
      const sorted = [...bgmCues].sort((a, b) => a.from_shot_number - b.from_shot_number)
      const restartWithoutSilence = sorted.some((cue, index) => {
        if (index === 0) return false
        const previous = sorted[index - 1]
        return !silenceCoversGap(previous.to_shot_number, cue.from_shot_number)
      })
      if (restartWithoutSilence) {
        errors.push(`场景 ${sceneId} 内起了 ${bgmCues.length} 段 BGM；同一场戏的 BGM 应连续或先静默再进入，不能逐镜重启。`)
      }
    }
    for (const shot of shots) {
      const covering = normalizedCues.filter(cue =>
        cue.from_shot_number <= shot.storyboardNumber
        && cue.to_shot_number >= shot.storyboardNumber)
      const units = new Set(covering.map(cue => cue.unit_key))
      if (units.size > 1) {
        errors.push(`第 ${shot.storyboardNumber} 镜被 ${units.size} 个声音单元同时覆盖（${[...units].join('、')}）；同一镜的 cue 必须属于同一声音单元。`)
      }
      const covered = covering.some(cue => cue.kind === 'ambience' || cue.kind === 'silence')
      if (!covered) errors.push(`第 ${shot.storyboardNumber} 镜没有归入声音单元（缺环境声或静默线索）。`)
    }
    // 环境声按地点/时间建立底噪：一条环境声不能跨不同场景
    for (const cue of normalizedCues) {
      if (cue.kind !== 'ambience') continue
      const sceneIds = new Set(shots
        .filter(shot => shot.storyboardNumber >= cue.from_shot_number && shot.storyboardNumber <= cue.to_shot_number)
        .map(shot => shot.sceneId)
        .filter((id): id is number => id != null))
      if (sceneIds.size > 1) {
        errors.push(`声音单元「${cue.unit_key}」的环境声跨了 ${sceneIds.size} 个场景；环境声必须按地点/时间分段，不能一条铺满跨场。`)
      }
    }
    // 对白优先级：强 BGM 覆盖有台词的分镜视为压过对白
    for (const cue of normalizedCues) {
      if (cue.kind !== 'bgm' || !/强|高|盖过|激烈|high|strong/i.test(cue.intensity || '')) continue
      const dialogueShot = shots.find(shot =>
        shot.storyboardNumber >= cue.from_shot_number
        && shot.storyboardNumber <= cue.to_shot_number
        && inspectDialogueIntegrity(shot.description, shot.videoPrompt) !== null)
      if (dialogueShot) {
        errors.push(`BGM 强度「${cue.intensity}」覆盖了有台词的第 ${dialogueShot.storyboardNumber} 镜；请降低 BGM 强度或改到无台词区间。`)
      }
    }
    if (errors.length) {
      logTaskWarn('StoryboardPipeline', 'sound-plan-rejected', { episodeId, errors: errors.join('；') })
      throw new Error(`拒绝保存声音计划：${errors.join('；')}`)
    }

    const previousPlans = await db.select().from(schema.soundPlans)
      .where(eq(schema.soundPlans.episodeId, episodeId))
    const version = previousPlans.reduce((max, row) => Math.max(max, row.version || 0), 0) + 1
    const plan = await db.insert(schema.soundPlans).values({
      episodeId,
      dramaId,
      version,
      status: 'done',
      planJson: JSON.stringify({ summary: summary || '', delivery, cues: normalizedCues }),
      validationJson: JSON.stringify({ errors: [], units: unitKeys.length }),
      model: null,
      configId: null,
      createdAt: ts,
      updatedAt: ts,
    })
    const planId = getInsertId(plan)
    for (const [index, cue] of normalizedCues.entries()) {
      const from = shotByNumber.get(cue.from_shot_number)!
      const to = shotByNumber.get(cue.to_shot_number)!
      db.insert(schema.soundCues).values({
        planId,
        unitKey: cue.unit_key,
        unitLabel: cue.unit_label || null,
        kind: cue.kind,
        fromShotId: from.id,
        toShotId: to.id,
        fromShotNumber: cue.from_shot_number,
        toShotNumber: cue.to_shot_number,
        description: cue.description,
        intensity: cue.intensity || null,
        entry: cue.entry || null,
        exit: cue.exit || null,
        delivery: cue.delivery,
        sortOrder: index,
        createdAt: ts,
        updatedAt: ts,
      }).run()
    }

    // 逐镜派生短增量；只改声音分区，不动画面/台词
    let patched = 0
    for (const shot of shots) {
      const cuesForShot = normalizedCues.filter(cue =>
        cue.from_shot_number <= shot.storyboardNumber && cue.to_shot_number >= shot.storyboardNumber)
      const unitKey = cuesForShot[0]?.unit_key || `shot-${shot.storyboardNumber}`
      const section: SoundSection = buildShotSoundDelta({
        shotNumber: shot.storyboardNumber,
        delivery,
        language: getContentLanguageFromRC(context?.requestContext),
        cues: cuesForShot.map(cue => ({
          kind: cue.kind,
          from_shot_number: cue.from_shot_number,
          to_shot_number: cue.to_shot_number,
          description: cue.description,
          intensity: cue.intensity,
          entry: cue.entry,
          exit: cue.exit,
        })),
      })
      const prompt = setSoundSection(
        shot.videoPrompt || '',
        section,
        getContentLanguageFromRC(context?.requestContext),
      )
      const cueIds = cuesForShot.map(cue => `${cue.kind}:${cue.from_shot_number}-${cue.to_shot_number}`)
      const bgmCue = cuesForShot.find(cue => cue.kind === 'bgm')
      const ambienceCue = cuesForShot.find(cue => cue.kind === 'silence')
        || cuesForShot.find(cue => cue.kind === 'ambience')
      // 单元级来源只写在 cue 真正开始的镜头，后续镜头不重复完整风格；跨场 BGM 不在新场重写
      const bgmAnchor = bgmCue && bgmCue.from_shot_number === shot.storyboardNumber ? bgmCue.description : null
      const ambienceAnchor = ambienceCue && ambienceCue.from_shot_number === shot.storyboardNumber
        ? ambienceCue.description
        : null
      db.update(schema.storyboards).set({
        videoPrompt: prompt,
        finalPromptOverride: null,
        soundUnitKey: unitKey,
        soundCue: JSON.stringify({
          plan_id: planId,
          unit_key: unitKey,
          cue_ids: cueIds,
          delta_text: [section.bgm, section.ambience, section.sfx, section.silence].filter(Boolean).join('；'),
        }),
        bgmPrompt: bgmAnchor,
        soundEffect: ambienceAnchor,
        updatedAt: ts,
      }).where(eq(schema.storyboards.id, shot.id)).run()
      patched += 1
    }
    logTaskSuccess('StoryboardPipeline', 'sound-plan-saved', {
      episodeId,
      planId,
      version,
      cues: normalizedCues.length,
      units: unitKeys.length,
      patched,
    })
    return {
      message: `声音计划已保存：${unitKeys.length} 个声音单元，${normalizedCues.length} 条线索`,
      plan_id: planId,
      version,
      units: unitKeys.length,
      cues: normalizedCues.length,
      patched_shots: patched,
    }
  },
})

export const storyboardTools = { readStoryboardContext, saveStoryboards, updateStoryboard }
export const storyboardDirectorTools = {
  readStoryboardPipelineContext,
  saveStoryboardSkeletons,
  saveRepairedStoryboard,
  saveSoundPlan,
}
