/**
 * 声音提示词生成（V2 · 5.3）
 *
 * 一次 LLM 调用产出：中文 voice_prompt（人看/二次生成）+ 英文 design_instruct（直传 VoiceDesign）
 * + 试听文本 sample_text。规则文本来自「流程规则」的 voice.design，可在设置页编辑。
 *
 * 失败不阻塞生图：LLM 失败时用模板兜底（appearance/role 拼），标 voice_prompt_source='template'。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { callTextJson, extractJson } from './text-call.js'
import { getPipelineRuleOrDefault } from './pipeline-rules.js'
import { activateVoice, createVoice, getVoice, listVoiceRows, setNarratorVoice, updateVoice } from './voice-profile.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'

export interface VoiceDesignCharacter {
  id?: number | null
  name: string
  role?: string | null
  description?: string | null
  appearance?: string | null
  personality?: string | null
  /** 角色第一句台词，用作试听文本 */
  sampleLine?: string | null
}

export interface VoiceProfileSuggestion {
  /** 旁白档案使用 scope='narrator'；缺省按角色处理 */
  scope?: 'character' | 'narrator'
  character_name: string
  gender: string
  age_range: string
  voice_prompt: string
  design_instruct: string
  sample_text: string
  emotion: string
  speed: number
  source: 'llm' | 'template'
}

export interface VoiceDesignInput {
  characters: VoiceDesignCharacter[]
  dramaId?: number
  episodeId?: number
  background?: string | null
  genre?: string | null
  language?: string | null
  /** LLM 未给出合法语速时的默认值（设置页「音色默认」） */
  defaultSpeed?: number
  model?: string
  configId?: number
  /** false 时跳过 Agent，直接单次 LLM（调试/降级用） */
  useAgent?: boolean
}

const DEFAULT_RULE = `你是短剧配音导演。根据角色设定，为每个角色设计一个可辨识的声音。

输出 JSON（不要多余文字）：
{
  "profiles": [
    {
      "character_name": "角色名（必须与输入完全一致）",
      "gender": "male | female | other",
      "age_range": "如 14-16 / 25-30 / 55-65",
      "voice_prompt": "中文声音提示词，60-120 字：年龄感、音色、音区、语速、口音/口癖、气质、情绪基线",
      "design_instruct": "English instruction for VoiceDesign, fixed order: age & gender -> timbre -> pitch -> pace -> accent -> temperament -> emotional baseline",
      "sample_text": "该角色的一句台词（优先用给定台词，没有就写一句符合人设的话，≤30 字）",
      "emotion": "情绪基线，如 克制 / 自信、调侃 / 阴冷",
      "speed": 1.0
    }
  ]
}

要求：
- 声音必须与角色身份一致：少年不能写成低沉中年音，老年不能写成少女音；
- 同一项目内角色之间要有区分度（音色/音区/语速至少一项明显不同）；
- 旁白风格统一、克制、少情绪，不参与角色区分；
- voice_prompt 用中文，design_instruct 用英文且可直接作为 VoiceDesign 的 voice_description；
- sample_text 直接用角色原台词，便于对比音色；
- 只输出 JSON，不要解释。`

function safeSpeed(value: unknown, fallback: number): number {
  const n = Number(value)
  const base = Number.isFinite(fallback) && fallback >= 0.5 && fallback <= 1.5 ? fallback : 1
  return Number.isFinite(n) && n >= 0.5 && n <= 1.5 ? n : base
}

function templateProfile(character: VoiceDesignCharacter, defaultSpeed = 1): VoiceProfileSuggestion {
  const text = [character.appearance, character.description, character.personality].filter(Boolean).join('，')
  const gender = /女|她|姑娘|少女|母|姐|妹/.test(text) ? 'female' : /男|他|少年|老者|父|兄|弟/.test(text) ? 'male' : 'other'
  const ageMatch = text.match(/(\d{1,2})\s*(?:岁|来岁|出头)/)
  const ageRange = ageMatch ? `${ageMatch[1]}-${Number(ageMatch[1]) + 3}` : gender === 'female' ? '20-30' : '25-35'
  return {
    character_name: character.name,
    gender,
    age_range: ageRange,
    voice_prompt: `${character.name}：${ageRange} 岁${gender === 'female' ? '女性' : gender === 'male' ? '男性' : ''}，音色自然，语速中等，情绪克制，符合角色身份`,
    design_instruct: `A ${ageRange} year old ${gender === 'female' ? 'female' : gender === 'male' ? 'male' : 'person'} speaking Mandarin, natural timbre, medium pitch, medium pace, restrained emotion, believable for the role`,
    sample_text: character.sampleLine || `我是${character.name}。`,
    emotion: '自然',
    speed: safeSpeed(defaultSpeed, 1),
    source: 'template',
  }
}

function normalizeSuggestion(raw: any, character: VoiceDesignCharacter, defaultSpeed = 1): VoiceProfileSuggestion | null {
  if (!raw || typeof raw !== 'object') return null
  const voicePrompt = String(raw.voice_prompt || '').trim()
  const design = String(raw.design_instruct || '').trim()
  if (!voicePrompt || !design) return null
  return {
    character_name: character.name,
    gender: ['male', 'female', 'other'].includes(String(raw.gender)) ? String(raw.gender) : 'other',
    age_range: String(raw.age_range || '').trim() || '25-35',
    voice_prompt: voicePrompt.slice(0, 600),
    design_instruct: design.slice(0, 1200),
    sample_text: String(raw.sample_text || character.sampleLine || `我是${character.name}。`).slice(0, 80),
    emotion: String(raw.emotion || '自然').slice(0, 60),
    speed: safeSpeed(raw.speed, defaultSpeed),
    source: 'llm',
  }
}

function toolNameOf(entry: any): string | null {
  return entry?.payload?.toolName || entry?.toolName || entry?.tool?.toolName || entry?.tool?.id || entry?.name || null
}

function toolResultOf(entry: any): any {
  const raw = entry?.payload?.result ?? entry?.result ?? entry?.payload?.output ?? entry?.output ?? entry?.data ?? null
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return raw }
}

/** 从 Agent 的工具结果 / 文本里取出 profiles；取不到返回 null */
function profilesFromAgentResult(result: any): any[] | null {
  for (const entry of result?.toolResults || []) {
    if (!String(toolNameOf(entry) || '').includes('save_voice_profiles')) continue
    const payload = toolResultOf(entry)
    if (Array.isArray(payload?.profiles)) return payload.profiles
    if (Array.isArray(payload)) return payload
  }
  try {
    const parsed: any = extractJson(String(result?.text || ''))
    const list = Array.isArray(parsed) ? parsed : parsed?.profiles
    if (Array.isArray(list)) return list
  } catch { /* 文本不是 JSON */ }
  return null
}

/** 走 voice_designer Agent（M1-3）：读取角色 → 设计 → 保存工具落库 */
async function generateWithAgent(
  input: VoiceDesignInput,
  characters: VoiceDesignCharacter[],
  prompt: string,
): Promise<VoiceProfileSuggestion[] | null> {
  if (input.useAgent === false || !input.dramaId) return null
  if ((process.env.VOICE_DESIGN_AGENT || 'on').toLowerCase() === 'off') return null
  const agent = mastra.getAgent('voice_designer')
  if (!agent) return null

  const requestContext = buildAgentRequestContext({
    episodeId: input.episodeId || 0,
    dramaId: input.dramaId,
    modelOverride: input.model,
    textConfigId: input.configId,
  })
  const result = await agent.generate(
    [{ role: 'user', content: `${prompt}\n\n请调用 read_characters_for_voice 核对角色，再调用 save_voice_profiles 保存全部 ${characters.length} 个角色；若 narrator_missing=true，再补一条 scope="narrator" 的旁白档案。` }],
    { maxSteps: 8, requestContext },
  )
  const rawProfiles = profilesFromAgentResult(result)
  if (!rawProfiles?.length) return null

  return characters.map((character) => {
    const raw = rawProfiles.find((p) => String(p?.character_name || '').trim() === character.name)
    return normalizeSuggestion(raw, character, input.defaultSpeed) || templateProfile(character, input.defaultSpeed)
  })
}

/** 生成声音提示词（不落库）；优先 Agent，失败回退单次 LLM，再回退模板 */
export async function generateVoiceProfiles(input: VoiceDesignInput): Promise<VoiceProfileSuggestion[]> {
  const characters = input.characters.filter((c) => c.name)
  if (!characters.length) return []

  const rule = getPipelineRuleOrDefault('voice.design', DEFAULT_RULE)
  const list = characters
    .map((c, i) => [
      `${i + 1}. ${c.name}`,
      c.role ? `   身份：${c.role}` : '',
      c.appearance ? `   样貌：${c.appearance}` : '',
      c.personality ? `   性格：${c.personality}` : '',
      c.description ? `   简介：${c.description}` : '',
      c.sampleLine ? `   台词：${c.sampleLine}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n')

  const prompt = [
    input.background ? `项目背景：${input.background}` : '',
    input.genre ? `题材：${input.genre}` : '',
    input.language ? `内容语言：${input.language}` : '',
    `角色列表：\n${list}`,
    `请为以上 ${characters.length} 个角色各设计一个声音，输出 profiles 数组。`,
  ].filter(Boolean).join('\n\n')

  try {
    const viaAgent = await generateWithAgent(input, characters, `${rule}\n\n${prompt}`)
    if (viaAgent) return viaAgent
  } catch (err: any) {
    console.warn('[voice-design] Agent 生成失败，回退单次 LLM：', err?.message || err)
  }

  try {
    const { data } = await callTextJson<{ profiles?: any[] }>({
      system: rule,
      prompt,
      model: input.model,
      configId: input.configId,
      maxTokens: 4096,
      temperature: 0.7,
    })
    const rawProfiles = Array.isArray(data?.profiles) ? data.profiles : []
    const out: VoiceProfileSuggestion[] = []
    for (const character of characters) {
      const raw = rawProfiles.find((p) => String(p?.character_name || '').trim() === character.name)
      const normalized = normalizeSuggestion(raw, character, input.defaultSpeed)
      out.push(normalized || templateProfile(character, input.defaultSpeed))
    }
    return out
  } catch (err: any) {
    console.warn('[voice-design] LLM 生成失败，回退模板：', err?.message || err)
    return characters.map((character) => templateProfile(character, input.defaultSpeed))
  }
}

/** 从剧本/分镜里取角色第一句台词，作为试听文本 */
export function collectSampleLines(episodeId: number): Map<string, string> {
  const map = new Map<string, string>()
  const rows = db.select().from(schema.storyboardLines)
    .where(eq(schema.storyboardLines.episodeId, episodeId))
    .all()
    .filter((l) => l.speakerName && l.text)
  for (const row of rows) {
    if (!row.speakerName || map.has(row.speakerName)) continue
    map.set(row.speakerName, (row.text || '').slice(0, 40))
  }

  const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  for (const raw of String(episode?.scriptContent || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || map.size > 200) continue
    const match = line.match(/^@?([^\s:：]{1,20})\s*[:：]\s*(.+)$/) || line.match(/^@([^\s:：]{1,20})\s+(.+)$/)
    if (!match) continue
    const name = match[1].trim()
    if (!name || map.has(name)) continue
    map.set(name, match[2].trim().slice(0, 40))
  }
  return map
}

export interface ApplyProfilesResult {
  created: number
  updated: number
  skipped: number
  voiceIds: number[]
}

/**
 * 落库：同角色已有激活音色默认跳过（force 才覆盖）；
 * 没有则新建一条 `source='design'`、`status='draft'` 的档案。
 */
export function applyVoiceProfiles(
  dramaId: number,
  profiles: VoiceProfileSuggestion[],
  options: { force?: boolean; language?: string } = {},
): ApplyProfilesResult {
  const result: ApplyProfilesResult = { created: 0, updated: 0, skipped: 0, voiceIds: [] }
  const characters = db.select().from(schema.characters)
    .where(and(eq(schema.characters.dramaId, dramaId), isNull(schema.characters.deletedAt)))
    .all()
  const existing = listVoiceRows(dramaId)

  for (const profile of profiles) {
    if (profile.scope === 'narrator') {
      const versions = existing.filter((v) => v.scope === 'narrator')
      const active = versions.find((v) => v.isActive)
      if (active && !options.force) {
        result.skipped += 1
        result.voiceIds.push(active.id)
        continue
      }
      if (versions[0]) {
        const updated = updateVoice(versions[0].id, {
          voicePrompt: profile.voice_prompt,
          designInstruct: profile.design_instruct,
          sampleText: profile.sample_text,
          gender: profile.gender,
          ageRange: profile.age_range,
          emotion: profile.emotion,
          speed: profile.speed,
          ...(options.language ? { language: options.language } : {}),
          voicePromptSource: profile.source,
          status: versions[0].status === 'ready' ? 'ready' : 'draft',
        })
        if (updated) {
          setNarratorVoice(dramaId, updated.id)
          result.updated += 1
          result.voiceIds.push(updated.id)
        }
        continue
      }
      const created = createVoice({
        dramaId,
        scope: 'narrator',
        name: '旁白',
        source: 'design',
        voicePrompt: profile.voice_prompt,
        voicePromptSource: profile.source,
        designInstruct: profile.design_instruct,
        sampleText: profile.sample_text,
        gender: profile.gender,
        ageRange: profile.age_range,
        emotion: profile.emotion,
        speed: profile.speed,
        language: options.language,
        status: 'draft',
      })
      setNarratorVoice(dramaId, created.id)
      result.created += 1
      result.voiceIds.push(created.id)
      continue
    }

    const character = characters.find((c) => c.name === profile.character_name)
    if (!character) {
      result.skipped += 1
      continue
    }
    const versions = existing.filter((v) => v.characterId === character.id)
    const active = versions.find((v) => v.isActive)
    if (active && !options.force) {
      result.skipped += 1
      result.voiceIds.push(active.id)
      continue
    }

    if (active && options.force) {
      db.update(schema.characterVoices)
        .set({ isActive: false, updatedAt: now() })
        .where(eq(schema.characterVoices.id, active.id))
        .run()
    }

    const draft = versions.find((v) => !v.isActive && v.source === 'design' && v.status !== 'ready')
    if (draft) {
      const updated = updateVoice(draft.id, {
        voicePrompt: profile.voice_prompt,
        designInstruct: profile.design_instruct,
        sampleText: profile.sample_text,
        gender: profile.gender,
        ageRange: profile.age_range,
        emotion: profile.emotion,
        speed: profile.speed,
        ...(options.language ? { language: options.language } : {}),
        voicePromptSource: profile.source,
        status: 'draft',
      })
      if (updated) {
        result.updated += 1
        result.voiceIds.push(updated.id)
        // 首次生成即激活，用户不用再点一次才能试听
        if (!active && !versions.some((v) => v.isActive)) {
          activateVoice(character.id, updated.id)
        }
      }
      continue
    }

    const created = createVoice({
      dramaId,
      characterId: character.id,
      name: `${character.name} · 声线`,
      source: 'design',
      voicePrompt: profile.voice_prompt,
      voicePromptSource: profile.source,
      designInstruct: profile.design_instruct,
      sampleText: profile.sample_text,
      gender: profile.gender,
      ageRange: profile.age_range,
      emotion: profile.emotion,
      speed: profile.speed,
      language: options.language,
      status: 'draft',
    })
    if (!versions.some((v) => v.isActive)) activateVoice(character.id, created.id)
    result.created += 1
    result.voiceIds.push(created.id)
  }
  return result
}

/** 旁白音色：一条 profile 复用同一套生成逻辑 */
export async function generateNarratorProfile(
  dramaId: number,
  options: {
    force?: boolean
    model?: string
    configId?: number
    episodeId?: number
    language?: string
    speed?: number
  } = {},
) {
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).get()
  if (!drama) throw new Error('项目不存在')

  const existing = listVoiceRows(dramaId).filter((v) => v.scope === 'narrator')
  if (existing.length && !options.force) return existing[0]

  const character: VoiceDesignCharacter = {
    name: '旁白',
    role: '画外音',
    description: `为《${drama.title}》担任旁白，风格统一、克制、少情绪，${drama.genre ? `题材：${drama.genre}` : ''}`,
    sampleLine: '故事，要从那年冬天说起。',
  }
  const [profile] = await generateVoiceProfiles({
    characters: [character],
    dramaId,
    episodeId: options.episodeId,
    // 旁白单条生成走直调 LLM，避免 Agent 的 save_voice_profiles 旁路再建一条
    useAgent: false,
    background: drama.background,
    genre: drama.genre,
    language: options.language,
    defaultSpeed: options.speed,
    model: options.model,
    configId: options.configId,
  })

  if (existing.length && options.force) {
    const updated = updateVoice(existing[0].id, {
      voicePrompt: profile.voice_prompt,
      designInstruct: profile.design_instruct,
      sampleText: profile.sample_text,
      gender: profile.gender,
      ageRange: profile.age_range,
      emotion: profile.emotion,
      speed: profile.speed,
      ...(options.language ? { language: options.language } : {}),
      voicePromptSource: profile.source,
      status: existing[0].status === 'ready' ? 'ready' : 'draft',
    })
    return updated!
  }

  const created = createVoice({
    dramaId,
    scope: 'narrator',
    name: '旁白',
    source: 'design',
    voicePrompt: profile.voice_prompt,
    voicePromptSource: profile.source,
    designInstruct: profile.design_instruct,
    sampleText: profile.sample_text,
    gender: profile.gender,
    ageRange: profile.age_range,
    emotion: profile.emotion,
    speed: profile.speed,
    language: options.language,
    status: 'draft',
  })
  // 首次生成即绑定为项目旁白，避免「生成了但没绑」导致旁白句无音色
  setNarratorVoice(dramaId, created.id)
  return getVoice(created.id) || created
}
