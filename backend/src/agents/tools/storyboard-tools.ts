/**
 * 分镜拆解 Agent 工具
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { db, getInsertId, schema } from '../../db/index.js'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess, logTaskWarn } from '../../utils/task-logger.js'
import { getContentLanguageFromRC, getDramaId, getEpisodeId } from '../context.js'
import { resolveVoiceMentions } from '../../services/character-voice-references.js'
import { getDramaBackground } from '../../services/drama-background.js'
import { cleanupFrameAssetsForEpisode } from '../../services/storyboard-frame-assets.js'

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
    const visibleExistingStoryboards = isChunkMode(chunk)
      ? [...liveExistingStoryboards]
          .sort((a, b) => a.storyboardNumber - b.storyboardNumber)
          .slice(-6)
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
    // 分块模式由系统控制替换：仅第 1 块第一次保存时清空旧分镜；
    // 后续块/同块后续批次即使模型按基础提示词传了 replace_existing 也只能追加
    const shouldReplace = chunkMode
      ? chunk.index === 0 && !chunk.state!.replaced
      : replace_existing === true
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
    // 分块模式忽略模型自带的 shot_number，按剧情顺序由系统连续编号，避免块间撞号覆盖
    const batch = chunkMode
      ? [...storyboards].sort((a, b) => a.shot_number - b.shot_number)
      : storyboards

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
    const patchedShots: number[] = []
    const promptLanguage = getContentLanguageFromRC(context?.requestContext)

    for (const sb of batch) {
      await validateStoryboardBindings(episodeId, dramaId, sb.scene_id, sb.character_ids, sb.prop_ids)
      const shotNumber = chunkMode ? chunk.state!.nextShot : sb.shot_number
      const characterNames = (sb.character_ids || [])
        .map(id => characterNameMap.get(id))
        .filter((name): name is string => Boolean(name))
      const sceneName = sb.scene_id != null ? sceneNameMap.get(sb.scene_id) ?? null : null
      const videoPrompt = normalizeVideoPrompt(sb.video_prompt, characterNames, sceneName, promptLanguage)
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
      )
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
    if ('video_prompt' in fields) updates.videoPrompt = fields.video_prompt
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

export const storyboardTools = { readStoryboardContext, saveStoryboards, updateStoryboard }
