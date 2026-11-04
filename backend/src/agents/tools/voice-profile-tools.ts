/**
 * 声音设计 Agent 工具（V2 · M1-3）
 *
 * read_characters_for_voice：读取项目角色、背景、题材、内容语言、旁白缺失状态，
 * 并附带每个角色在本集的首句台词（优先分镜，回退 script_content），供试听文本使用。
 * save_voice_profiles：校验并批量落库角色/旁白音色档案；已有激活音色默认跳过（force 覆盖）。
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../../db/index.js'
import { getContentLanguageFromRC, getDramaId, getEpisodeId } from '../context.js'
import { listVoiceRows } from '../../services/voice-profile.js'

const profileSchema = z.object({
  scope: z.enum(['character', 'narrator']).optional().describe('character（默认）或 narrator'),
  character_name: z.string().nullable().optional().describe('角色名；旁白可传 null'),
  gender: z.string().optional().describe('male / female / other'),
  age_range: z.string().optional().describe('如 14-16 / 25-30 / 55-65'),
  voice_prompt: z.string().describe('中文声音提示词（60-120 字）'),
  design_instruct: z.string().describe('英文 VoiceDesign 指令'),
  sample_text: z.string().optional().describe('试听文本（≤30 字，优先用角色原台词）'),
  emotion: z.string().optional().describe('情绪基线'),
  speed: z.number().min(0.5).max(1.5).optional(),
})

const readCharactersForVoice = createTool({
  id: 'read_characters_for_voice',
  description: 'Read project characters, background, genre, content language and narrator status, including each character’s first line in the current episode for audition.',
  inputSchema: z.object({
    character_ids: z.array(z.number()).optional().describe('只读取指定角色（省略则读取全部）'),
  }),
  execute: async ({ character_ids }, context) => {
    const requestContext = context?.requestContext
    const dramaId = getDramaId(requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    const episodeId = getEpisodeId(requestContext)

    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
    let rows = db.select().from(schema.characters)
      .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
      .all()
    if (character_ids?.length) rows = rows.filter((r) => character_ids.includes(r.id))

    const samples = episodeId
      ? (await import('../../services/voice-design.js')).collectSampleLines(episodeId)
      : new Map<string, string>()
    const voices = listVoiceRows(dramaId)

    return {
      drama_id: dramaId,
      episode_id: episodeId,
      title: drama?.title || null,
      background: drama?.background || null,
      genre: drama?.genre || null,
      language: getContentLanguageFromRC(requestContext) || 'zh',
      narrator_missing: !voices.some((v) => v.scope === 'narrator' && v.isActive),
      characters: rows.map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        description: c.description,
        appearance: c.appearance,
        personality: c.personality,
        sample_line: samples.get(c.name) || null,
      })),
    }
  },
})

const saveVoiceProfiles = createTool({
  id: 'save_voice_profiles',
  description: 'Validate and save voice profiles for characters and the narrator. Existing active voices are kept unless force=true.',
  inputSchema: z.object({
    profiles: z.array(profileSchema).describe('为每个角色/旁白设计的声音，一次传完整数组'),
    force: z.boolean().optional().describe('覆盖已有激活音色（默认 false）'),
  }),
  execute: async ({ profiles, force }, context) => {
    const dramaId = getDramaId(context?.requestContext)
    if (!dramaId) return { error: 'Missing dramaId in request context' }
    if (!profiles?.length) return { error: 'profiles 不能为空' }

    const normalized = []
    for (const profile of profiles) {
      const isNarrator = profile.scope === 'narrator'
      const name = String(profile.character_name || (isNarrator ? '旁白' : '')).trim()
      if (!name) return { error: '角色档案必须提供 character_name' }
      normalized.push({
        scope: isNarrator ? ('narrator' as const) : ('character' as const),
        character_name: name,
        gender: ['male', 'female', 'other'].includes(String(profile.gender)) ? String(profile.gender) : 'other',
        age_range: profile.age_range || '25-35',
        voice_prompt: profile.voice_prompt.slice(0, 600),
        design_instruct: profile.design_instruct.slice(0, 1200),
        sample_text: (profile.sample_text || `我是${name}。`).slice(0, 80),
        emotion: (profile.emotion || '自然').slice(0, 60),
        speed: profile.speed ?? 1,
        source: 'llm' as const,
      })
    }

    // 动态导入避免 agents → tools → voice-design → mastra 的静态循环
    const { applyVoiceProfiles } = await import('../../services/voice-design.js')
    const applied = applyVoiceProfiles(dramaId, normalized, { force: Boolean(force) })
    return { profiles, applied }
  },
})

export const createVoiceProfileTools = { readCharactersForVoice, saveVoiceProfiles }