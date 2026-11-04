/**
 * 流水线任务规则（提示词）— 可在设置页查看/编辑，存 app_settings
 *
 * 与 Agent 的 System Prompt 的区别：
 * - System Prompt（workspace/prompts/<agent>.md）定义「这个 Agent 是谁、怎么思考」
 * - 任务规则（本文件）定义「这一步要它做什么」，即每次调用时发给 Agent 的用户消息
 *
 * 规则里的 {{占位符}} 运行时替换：
 *   {{videoModel}} {{characters}} {{scenes}} {{props}} {{shotNumber}} {{storyboardId}}
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export type PipelineRuleKey = 'rewrite' | 'extract.characters' | 'extract.scenes' | 'extract.props' | 'storyboards' | 'video_prompts' | 'voice.design'

export const PIPELINE_RULE_KEYS: PipelineRuleKey[] = [
  'rewrite',
  'extract.characters',
  'extract.scenes',
  'extract.props',
  'storyboards',
  'video_prompts',
  'voice.design',
]

export const DEFAULT_PIPELINE_RULES: Record<PipelineRuleKey, string> = {
  rewrite: '请读取剧本并改写为格式化剧本，然后保存',
  'extract.characters': '请从本集剧本中提取所有角色信息（外貌需融合性格、含妆造），先用 read_existing_characters 读取项目已有角色，同名或近名（带括号定位/别名，如「林小雨（主角）」与「林小雨」）直接复用已有、不要重复创建，再用 save_dedup_characters 保存。本次只提取角色，不要提取场景和道具。',
  'extract.scenes': '请从本集剧本中提取所有场景信息（地点、时间、光影等），先用 read_existing_scenes 读取已有场景去重，再用 save_dedup_scenes 保存。本次只提取场景，不要提取角色和道具。',
  'extract.props': '请从本集剧本中提取关键道具——必须同时满足：① 直接推动剧情（出现/交接/损坏/发现会引发情节转折，如凶器、信物、关键文件、定情礼物、证据）；② 值得单独生成白底单品图（分镜会给它特写或反复出现）。判定三问任一答"否"即放弃：删掉它剧情依然成立吗？它只是随手使用的日常物品（手机、筷子、水杯）吗？它是场景陈设（桌椅、灯具）吗？宁可少提不要多提，一集通常 0-3 个，超过 3 个只保留最重要的 3 个，没有就一个都不提取（save_dedup_props 传空数组）。description 只记录物品外貌。先用 read_existing_props 读取已有道具去重，再用 save_dedup_props 保存。本次只提取道具，不要提取角色和场景。',
  storyboards: `请基于当前集剧本拆分分镜，并为每个分镜段落同时生成 video_prompt（视频生成提示词）。
本次视频模型：{{videoModel}}，请按该模型的特性与时长限制生成 video_prompt。

项目已有角色：{{characters}}
项目已有场景：{{scenes}}
项目已有道具：{{props}}

绑定要求：
- 每个镜头必须根据剧本内容，从上述项目已有角色中选出出场的角色绑定 character_ids（ID 必须来自上述列表；有角色出场就必须绑定，不要遗漏）
- 每个镜头尽量匹配上述已有场景填写 scene_id（ID 必须来自上述列表），不要凭空创造新场景
- 每个镜头出现关键道具（被使用、交接、特写或在画面中明显可见）时，从上述项目已有道具中绑定 prop_ids（ID 必须来自上述列表）；没有道具出现可传空数组
- 上述素材可能来自同项目其他剧集，可直接复用；保存时会自动关联到当前集
- 只有纯环境空镜头才可以不绑定角色
- 每个镜头填写 transition（cut / fade / dissolve / wipe，与上一镜的转场方式）和 continuity（承接上一镜的尾动作、视线、站位、环境声如何延续；第一镜写「开场」）
- 每段结尾保留 2-3 秒尾部动作、空镜或情绪停顿，便于剪辑衔接；同一场景的 sound_effect 必须复用同一段环境声描述，保证拼接后声床连续

语音容量（硬约束）：
- 段落时长 × 4 字/秒 = 该段台词 + 旁白可容纳的字数上限（再留 1 秒气口）。例：12 秒最多约 44 个汉字；超出必须拆成两个段落，不得靠加快语速硬塞
- 旁白、回忆、心里活动统一写成「旁白（画外音）：内容」，不要写成角色开口说；画面中该角色不张口`,
  video_prompts: `请为分镜 #{{shotNumber}}(ID:{{storyboardId}})生成视频提示词(video_prompt)。视频模型:{{videoModel}},请根据该模型的特性和时长限制生成。
请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围、时长以及 continuity（承接上一镜的尾动作/视线/站位）和 sound_effect（本镜环境声）,据此生成 video_prompt(第一行是信息头：列出该分镜出场的人物与场景，用 @角色名/@场景名 引用；不要写「音频：」要求行或音色/混音指令（声音由生成参数控制）；之后按 3 秒分段换行、用 @角色名/@场景名/@道具名 引用参考素材；开头 0-1 秒承接上一镜的尾部动作，结尾留 2-3 秒可剪辑的尾部动作或空镜；段落内允许多镜头切镜，段与段可以是不同景别/角度/对象，但不跨场景，切镜点对齐分镜 description 的【镜头N】结构),然后调用 update_storyboard 保存到分镜 ID:{{storyboardId}}。update_storyboard 参数只传 storyboard_id 和 video_prompt 两个键,不要回传该分镜的其他任何字段,不要重新拆分整集。

语音预算（硬约束）：
- 每个 3 秒段最多 12 个汉字的台词/旁白；长句按语义拆到相邻段，不得把整段旁白塞进一句
- 旁白/心里活动写成「旁白（画外音，普通话，语速平缓）：…」，角色台词写成「角色名说：「…」」；不要把旁白写成角色开口
- 不要念出时间码、镜号或画面描述`,
  'voice.design': `你是短剧配音导演。根据角色设定，为每个角色设计一个可辨识的声音。

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
- 只输出 JSON，不要解释。`,
}

/** 读取规则；未自定义且默认值为空时返回传入的兜底文本 */
export function getPipelineRuleOrDefault(key: PipelineRuleKey, fallback: string): string {
  const value = getPipelineRule(key)
  return value && value.trim() ? value : fallback
}

const SETTING_PREFIX = 'pipeline.rule.'
/** 单条规则上限：与设置页输入框 maxlength 保持一致 */
const MAX_RULE_CHARS = 12000
const settingKey = (key: PipelineRuleKey) => `${SETTING_PREFIX}${key}`

function isRuleKey(value: string): value is PipelineRuleKey {
  return (PIPELINE_RULE_KEYS as string[]).includes(value)
}

/** 读取规则原文（未自定义时返回默认值）；未知 key 返回 '' */
export function getPipelineRule(key: PipelineRuleKey): string {
  try {
    const row = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, settingKey(key))).get()
    const value = String(row?.value ?? '').trim()
    return value || DEFAULT_PIPELINE_RULES[key]
  } catch {
    return DEFAULT_PIPELINE_RULES[key]
  }
}

/** 运行时渲染：替换 {{占位符}}，未提供的占位符原样保留（便于排查） */
export function renderPipelineRule(key: PipelineRuleKey, vars: Record<string, string | number | undefined> = {}): string {
  const template = getPipelineRule(key)
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined || value === null ? match : String(value)
  })
}

export interface PipelineRuleItem {
  key: PipelineRuleKey
  rule: string
  default_rule: string
  is_default: boolean
}

export function listPipelineRules(): PipelineRuleItem[] {
  return PIPELINE_RULE_KEYS.map((key) => {
    const row = (() => {
      try {
        return db.select().from(schema.appSettings).where(eq(schema.appSettings.key, settingKey(key))).get()
      } catch {
        return undefined
      }
    })()
    const custom = String(row?.value ?? '').trim()
    return {
      key,
      rule: custom || DEFAULT_PIPELINE_RULES[key],
      default_rule: DEFAULT_PIPELINE_RULES[key],
      is_default: !custom,
    }
  })
}

/** 保存规则；空白串视为恢复默认 */
export function setPipelineRule(key: PipelineRuleKey, value: unknown): string {
  if (!isRuleKey(key)) throw new Error('未知的规则类型')
  const text = String(value ?? '').trim()
  // 与设置页输入框上限一致：防止误粘贴超长文本把每次请求都撑爆
  if (text.length > MAX_RULE_CHARS) throw new Error(`规则过长（上限 ${MAX_RULE_CHARS} 字）`)
  try {
    if (!text) {
      db.delete(schema.appSettings).where(eq(schema.appSettings.key, settingKey(key))).run()
    } else {
      db.insert(schema.appSettings)
        .values({ key: settingKey(key), value: text, updatedAt: now() })
        .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: text, updatedAt: now() } })
        .run()
    }
  } catch (error: any) {
    throw new Error(`保存规则失败：${error?.message || error}`)
  }
  return getPipelineRule(key)
}

export function resetPipelineRule(key: PipelineRuleKey): string {
  if (!isRuleKey(key)) throw new Error('未知的规则类型')
  db.delete(schema.appSettings).where(eq(schema.appSettings.key, settingKey(key))).run()
  return DEFAULT_PIPELINE_RULES[key]
}

export { isRuleKey }
