/**
 * 镜头意图与旁白/动作计划
 *
 * 链式管线中位于骨架覆盖门禁之后、逐镜修补之前。
 * 意图只看镜头内容，不看题材；题材只用于动作特效的风格描述。
 * 战斗/比拼/动作镜默认禁止旁白；只有原文明确标注旁白时才保留。
 */
import type { StoryboardTagKey } from './storyboard-tags.js'
import type { NarrationForm } from './pipeline-chain.js'
import {
  COMBAT_RE,
  COMPETITION_RE,
  combatEvidence as findCombatEvidence,
  competitionEvidence as findCompetitionEvidence,
  strongCombatEvidence as findStrongCombatEvidence,
} from './storyboard-content.js'

export type ShotIntentType =
  | 'dialogue'
  | 'exposition'
  | 'character_intro'
  | 'combat'
  | 'competition'
  | 'action'
  | 'transition'
  | 'empty'

export type NarrationMode = 'none' | 'source' | 'adapted'

export interface NarrationPlan {
  mode: NarrationMode
  /** 原文明确标注的旁白逐字保留；adapted 模式下为供改写的原文叙述候选 */
  lines: string[]
  /** 与 lines 对应的原文摘录片段 */
  sourceQuotes: string[]
  /** 按 4 字/秒 + 1 秒气口折算的本镜旁白字数上限 */
  budgetChars: number
  /** 原文旁白超出本镜容量；修补时按原文标点拆到相邻镜，不得截断 */
  overflow: boolean
  reason: string
  /** 产出本计划的旁白形态；旧数据缺省按 dialogue 处理 */
  form?: NarrationForm
}

export interface ActionPlan {
  category: 'none' | 'combat' | 'competition' | 'action'
  /** 动作编排节拍：按动作起点、过程、终点排列 */
  beats: string[]
  /** 特效方向；题材只影响这里的风格词 */
  vfx: string[]
  camera: string
  sound: string
  styleNote: string
  narrationForbidden: boolean
}

export interface ShotIntentPlan {
  intent: ShotIntentType
  narration: NarrationPlan
  action: ActionPlan
  tags: StoryboardTagKey[]
  evidence: string[]
}

export interface ShotIntentInput {
  storyboardNumber?: number
  duration?: number | null
  transition?: string | null
  shotType?: string | null
  actionSummary?: string | null
  actionStart?: string | null
  actionEnd?: string | null
  sourceExcerpt?: string | null
  speechSegments?: Array<{ speaker?: string | null; text?: string; sourceQuote?: string }>
  /** 原文只有发声动作、没有具体词时，由计划层要求补一句台词 */
  speechRequirement?: { speaker?: string; basis?: string } | null
  characterCount?: number
  /** 同集前序镜头已经出现过的角色；用于角色介绍只在首次出现时成立 */
  previousCharacterIds?: number[]
  characterIds?: number[]
  /** 项目类型/背景/标签文本；只用于特效风格，不参与意图判定 */
  projectStyleText?: string | null
  /** 本集第一镜：允许把原文背景叙述作为开场画外音 */
  isOpeningShot?: boolean
  /** 多个连续叙述节拍压缩成的单机位过渡镜：允许原文叙述作为画外旁白 */
  compressedSilent?: boolean
  /** 旁白形态：dialogue 沿用对白驱动规则；narration 允许任意镜改写式旁白 */
  narrationForm?: NarrationForm
}

const ACTION_RE = /(?:跑|奔|追|逃|走|站|坐|躺|推|拉|抬|扔|抓|抱|打|踢|挥|冲|躲|翻|爬|跳|跪|倒地|扑|拽|扯|掀|砸|劈|砍|刺|举|放|拿|端|递|接|转身|回头|低头|抬头|皱眉|笑|哭|喘|颤抖|挣扎|按住|扶住|蹲下|起身|退后|逼近|挡在|冲出|闯入|扫|看|望|盯|瞥|瞪|瞟|瞄|听|见|等|探|催|劝|回|进|出|守|搬|扛|提|背|握|立|伫|静立|未动|醒|睁|跟随|尾随|离开|进来|出来|出去|回来|发现|切|炒|煮|盛|装|吃|喝|咬|嚼|吹|弹|唱|写|画|读|念)/
/** 多字/明确动作词：用于区分静态道具特写与真的发生动作的建置镜 */
const STRONG_ACTION_RE = /(?:跑|奔|追|逃|站起|站立|站着|坐下|坐在|躺着|躺在|转身|反身|回头|低头|抬头|皱眉|笑|哭|喘|颤抖|挣扎|按住|扶住|蹲下|起身|退后|逼近|挡在|冲出|闯入|扫了一眼|扫视|看向|望着|盯着|看着|看见|瞥了|瞪了|瞟了|瞄了|听见|听到|等着|探出|催促|苦劝|骂完|骂道|骂了|回到|走回|走进|走出|进来|出来|出去|回来|离开|拿起|放下|端起|递给|接过|举起|抬起|推开|拉开|抓住|抱住|搬|扛|提|背|握|伫立|静立|未动|睁眼|跟随|尾随|发现|雕琢|切菜|炒菜|煮饭|盛饭|装填|吃饭|喝茶|喝水|咬住|咀嚼|吹奏|弹奏|唱道|写字|书写|画画|绘画|读书|朗读|念道)/
const MEMORY_CUE_RE = /(?:画面回溯|回溯|回忆|多年前|往事|当年|曾经|原来|从前|早年|彼时|此时|与此同时|画面闪回|闪回)/
const INTERNAL_CUE_RE = /(?:思念|发愁|心想|暗想|寻思|盘算|心中|心里|内心|前世|记忆|了解|明白|知道|发现)/
const DIALOGUE_QUOTE_RE = /[「“"][^」”"]{2,}[」”"]/
const NARRATION_MARKER_RE = /(?:旁白|画外音|解说词?|内心独白|心声|narration|voice[\s-]?over|inner\s+voice)/i
const NARRATION_LINE_DETECT_RE = /(?:^|[\n。；;])\s*(?:旁白|画外音|解说词?|内心独白|心声)\s*(?:（[^）]*）|\([^)]*\))?\s*[：:]/
const NARRATION_LINE_RE = /(?:旁白|画外音|解说词?|内心独白|心声)\s*(?:（[^）]*）|\([^)]*\))?\s*[：:]\s*([^\n]+)/g
const NARRATION_SPEAKER_RE = /^(?:旁白|画外音|解说|内心独白|心声|narration|voice[\s-]?over|inner\s+voice)$/i
const INTRO_RE = /(?:第一次|初次|初见|首次登场|初次登场|自我介绍|介绍道|名叫|名字叫|正是|身份为|新来的|初来乍到|第一次见|首次出现)/
const WEAPON_RE = /(?:刀|剑|枪|棍|箭|斧|戟|鞭|锤|匕首|暗器|弓|弩|盾)/
const FIST_RE = /(?:拳|脚|掌|肘|膝|擒拿|锁喉|摔|扭打|搏斗)/
const MAGIC_RE = /(?:法术|灵力|真气|符|阵|神通|剑诀|法诀|灵光|仙力|妖力)/
const FIREARM_RE = /(?:枪口|子弹|炮弹|爆炸|火光|硝烟|开火|射击|轰炸|导弹|激光|能量束)/
const MECHA_RE = /(?:机甲|战车|战机|飞船|引擎|推进器|金属|机械)/
const MODERN_STYLE_RE = /(?:现代|都市|校园|职场|当代|民国)/
const WUXIA_STYLE_RE = /(?:武侠|江湖|门派|镖局|客栈|衙门|朝堂)/
const HISTORICAL_STYLE_RE = /(?:古装|古代|宋|唐|明|清|元|汉|魏晋|朝代|市井|商铺|街市)/
const XIANXIA_STYLE_RE = /(?:玄幻|仙侠|修真|修仙|灵界|仙界|灵气|法术)/
const SCI_FI_STYLE_RE = /(?:科幻|星际|未来|机甲|赛博|外星|太空)/
const WAR_STYLE_RE = /(?:战争|军旅|战场|军队|士兵|将军|军阀|抗战|战役)/

function cleanText(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeForMatch(value: unknown) {
  return String(value || '').replace(/[\s\u3000]+/g, '')
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 8) {
  const result: string[] = []
  for (const value of values) {
    const text = cleanText(value)
    if (!text || result.includes(text)) continue
    result.push(text)
    if (result.length >= limit) break
  }
  return result
}

function truncate(value: string, max = 40) {
  const text = cleanText(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function stripQuoteWrapper(value: string) {
  return value
    .replace(/^[「“"']+/, '')
    .replace(/[」”"']+$/, '')
    .replace(/[（(]\s*[）)]/g, '')
    .trim()
}

function narrationSegmentsFromSpeech(segments: ShotIntentInput['speechSegments']) {
  return (segments || [])
    .filter(item => NARRATION_SPEAKER_RE.test(cleanText(item?.speaker)))
    .map(item => ({
      text: stripQuoteWrapper(cleanText(item?.text)),
      sourceQuote: cleanText(item?.sourceQuote),
    }))
    .filter(item => item.text && !/^无[。.]?$/.test(item.text))
}

function stripNarrationLines(text: string) {
  return String(text || '').replace(NARRATION_LINE_RE, '')
}

function narrationSegmentsFromExcerpt(excerpt: string) {
  const result: Array<{ text: string; sourceQuote: string }> = []
  NARRATION_LINE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = NARRATION_LINE_RE.exec(excerpt))) {
    const raw = String(match[1] || '').split('\n')[0]
    const text = stripQuoteWrapper(raw).replace(/[」”"']+$/, '').trim()
    if (!text || /^无[。.]?$/.test(text)) continue
    result.push({ text, sourceQuote: match[0].trim() })
  }
  return result
}

function dialogueSegmentsFrom(speech: ShotIntentInput['speechSegments'], excerpt: string) {
  const explicit = (speech || [])
    .filter(item => !NARRATION_SPEAKER_RE.test(cleanText(item?.speaker)))
    .map(item => cleanText(item?.text))
    .filter(Boolean)
  if (explicit.length) return uniqueStrings(explicit, 12)
  const visible = stripNarrationLines(excerpt)
  const quotes = [...visible.matchAll(/[「“"]([^」”"]{2,})[」”"]/g)]
    .map(match => cleanText(match[1]))
    .filter(text => text && !/^无[。.]?$/.test(text))
  return uniqueStrings(quotes, 12)
}

function actionClauses(input: ShotIntentInput) {
  const clauses: string[] = []
  for (const value of [input.actionStart, input.actionEnd, input.actionSummary]) {
    const text = cleanText(value)
    if (text) clauses.push(truncate(text, 36))
  }
  const excerpt = cleanText(stripNarrationLines(input.sourceExcerpt || ''))
  for (const sentence of excerpt.split(/[。！？!?…\n]+/)) {
    const text = cleanText(sentence)
    if (!text) continue
    if (DIALOGUE_QUOTE_RE.test(text) && !ACTION_RE.test(text)) continue
    if (ACTION_RE.test(text) || COMBAT_RE.test(text) || COMPETITION_RE.test(text)) {
      clauses.push(truncate(text, 32))
    }
    if (clauses.length >= 6) break
  }
  return uniqueStrings(clauses, 6)
}

function resolveStyle(projectStyleText: string) {
  if (XIANXIA_STYLE_RE.test(projectStyleText)) return '东方灵力光效与气劲波纹'
  if (SCI_FI_STYLE_RE.test(projectStyleText)) return '硬表面金属与能量光效'
  if (WAR_STYLE_RE.test(projectStyleText)) return '战场烟尘与写实冲击'
  if (WUXIA_STYLE_RE.test(projectStyleText)) return '写实冷兵器与武侠招式'
  if (HISTORICAL_STYLE_RE.test(projectStyleText)) return '古代市井质感与写实动作冲击'
  if (MODERN_STYLE_RE.test(projectStyleText)) return '写实都市动作与现场环境反馈'
  return '写实动作与物理冲击'
}

function buildVfx(category: ActionPlan['category'], text: string, styleNote: string) {
  if (category === 'none') return []
  const vfx: string[] = []
  if (category === 'competition') {
    vfx.push('比赛动作的节奏与器材反馈')
    if (/球/.test(text)) vfx.push('球体轨迹与地面反弹')
    if (/厨|菜|锅|刀/.test(text)) vfx.push('灶火、油花与刀工细节')
    if (/棋|子|盘/.test(text)) vfx.push('落子特写与棋盘质感')
    if (/舞/.test(text)) vfx.push('衣摆与灯光流动')
  }
  if (MAGIC_RE.test(text)) vfx.push('灵力光效与空气波纹')
  if (WEAPON_RE.test(text)) vfx.push('兵器轨迹与碰撞火花')
  if (FIST_RE.test(text)) vfx.push('拳脚冲击与衣料抖动')
  if (FIREARM_RE.test(text)) vfx.push('枪口焰光与烟尘碎屑')
  if (MECHA_RE.test(text)) vfx.push('金属火花与机械结构反馈')
  if (!vfx.length) vfx.push('动作冲击与尘土飞散')
  vfx.push(styleNote)
  return uniqueStrings(vfx, 5)
}

function buildCamera(category: ActionPlan['category']) {
  if (category === 'combat') return '手持近身跟拍，冲击瞬间短促升格，终点回到动作端点'
  if (category === 'competition') return '侧向跟拍与环绕，关键得分动作推近'
  if (category === 'action') return '跟随主体横移，动作端点推近'
  return ''
}

function buildSound(category: ActionPlan['category']) {
  if (category === 'combat') return '破风、打击、兵器碰撞、脚步与喘息'
  if (category === 'competition') return '环境人声、器材声与节奏点'
  if (category === 'action') return '脚步、衣料摩擦与道具碰撞声'
  return ''
}

function detectIntent(input: ShotIntentInput, dialogueCount: number, narrationCount: number, characterCount: number) {
  const excerpt = cleanText(stripNarrationLines(input.sourceExcerpt || ''))
  const text = [input.actionSummary, input.actionStart, input.actionEnd, excerpt].map(cleanText).join(' ')
  const combatEvidence = findCombatEvidence(text)
  const strongCombatEvidence = findStrongCombatEvidence(text)
  const competitionEvidence = findCompetitionEvidence(text)
  // 有比赛/竞速等明确竞技语境时，只有真正的攻击动作才能改判战斗；
  // “机甲竞速”“战车拉力”里的机甲/战车只是比赛载体，不是战斗。
  if (competitionEvidence.length && !strongCombatEvidence.length) {
    return { intent: 'competition' as ShotIntentType, evidence: competitionEvidence.slice(0, 4) }
  }
  if (strongCombatEvidence.length) {
    return { intent: 'combat' as ShotIntentType, evidence: strongCombatEvidence.slice(0, 4) }
  }
  if (combatEvidence.length) {
    return { intent: 'combat' as ShotIntentType, evidence: combatEvidence.slice(0, 4) }
  }
  const firstAppearance = Array.isArray(input.characterIds)
    && input.characterIds.length > 0
    && (input.characterIds || []).some(id => !(input.previousCharacterIds || []).includes(id))
  if (firstAppearance && INTRO_RE.test(`${text} ${excerpt}`)) {
    return { intent: 'character_intro' as ShotIntentType, evidence: [excerpt.match(INTRO_RE)?.[0] || '初次登场'] }
  }
  if (dialogueCount > 0 || input.speechRequirement) {
    return {
      intent: 'dialogue' as ShotIntentType,
      evidence: input.speechRequirement?.basis ? [`发声动作：${input.speechRequirement.basis}`] : [],
    }
  }
  if (narrationCount > 0) return { intent: 'exposition' as ShotIntentType, evidence: [] }
  if (input.compressedSilent) {
    return { intent: 'transition' as ShotIntentType, evidence: ['压缩过渡镜'] }
  }
  if (input.shotType === 'transition') return { intent: 'transition' as ShotIntentType, evidence: ['镜头类型：转场'] }
  const hasAction = ACTION_RE.test(text)
  const hasStrongAction = STRONG_ACTION_RE.test(text)
  if (!hasStrongAction && (MEMORY_CUE_RE.test(text) || INTERNAL_CUE_RE.test(text))) {
    return { intent: 'exposition' as ShotIntentType, evidence: ['记忆/内心/概述画面'] }
  }
  if (characterCount === 0 && !hasStrongAction) {
    return { intent: 'empty' as ShotIntentType, evidence: ['无角色、无动作、无台词'] }
  }
  if (input.shotType === 'reaction') {
    return { intent: 'action' as ShotIntentType, evidence: ['镜头类型：reaction'] }
  }
  if (['establishing', 'insert'].includes(String(input.shotType || '')) && !hasStrongAction) {
    return { intent: 'empty' as ShotIntentType, evidence: ['环境/道具空镜'] }
  }
  if (hasAction || COMBAT_RE.test(text) || COMPETITION_RE.test(text)) {
    return { intent: 'action' as ShotIntentType, evidence: [] }
  }
  if (input.transition && input.transition !== 'cut' && characterCount === 0) {
    return { intent: 'transition' as ShotIntentType, evidence: [`转场：${input.transition}`] }
  }
  return { intent: (characterCount > 0 ? 'action' : 'empty') as ShotIntentType, evidence: [] }
}

const CONTEXT_NARRATION_MAX_CHARS = 24

/** 旁白驱动形态的改写素材：原文去掉旁白行、对白引号与说话归属子句后剩下的叙述 prose */
function narrationProseCandidate(excerpt: string): string {
  const text = cleanText(
    stripNarrationLines(excerpt)
      .replace(/[「“"][^」”"]*[」”"]/g, '')
      .replace(/[^，。！？!?；;\n]*(?:说道|笑道|喊道|叫道|问道|答道|骂道|自说到|开口|嘟囔|低语|说|喊|叫|问|答|骂|念|唱|(?<![味知报])道)\s*[：:]/g, ''),
  )
  return text.replace(/^[，。！？!?；;、\s]+/, '').replace(/[，、；;]+$/, '').trim()
}

function selectContextNarration(excerpt: string, budgetChars: number): string {
  const text = cleanText(stripNarrationLines(excerpt))
  if (!text) return ''
  const budget = Math.min(budgetChars, CONTEXT_NARRATION_MAX_CHARS)
  const clauses = text.split(/(?<=[，。！？!?；;])/).map(cleanText).filter(Boolean)
  let result = ''
  for (const clause of clauses) {
    const next = result + clause
    if ([...next].length > budget) break
    result = next
  }
  if (!result) result = [...text].slice(0, budget).join('')
  return result.replace(/[，、；;]+$/, '').trim()
}

function planTags(intent: ShotIntentType, hasDialogue: boolean, hasNarration: boolean, characterCount: number, transition: string | null | undefined, hasMemory: boolean, compressedSilent = false): StoryboardTagKey[] {
  const tags: StoryboardTagKey[] = []
  const push = (key: StoryboardTagKey) => { if (!tags.includes(key)) tags.push(key) }
  if ((transition && transition !== 'cut') || compressedSilent) push('transition')
  if (characterCount > 0 && intent !== 'empty') push('character')
  if (hasDialogue) push('dialogue')
  if (hasNarration) push('narration')
  if (intent === 'combat') push('combat')
  if (intent === 'competition') push('competition')
  if (intent === 'empty' && !hasNarration) push('empty')
  if (intent === 'transition') push('transition')
  if (hasMemory) push('memory')
  return tags
}

export function buildShotIntentPlan(input: ShotIntentInput): ShotIntentPlan {
  const excerpt = String(input.sourceExcerpt || '')
  const duration = Number(input.duration || 0) || 6
  const budgetChars = Math.max(4, Math.floor((duration - 1) * 4))
  const characterCount = Number(input.characterCount || 0)
  const speechNarration = narrationSegmentsFromSpeech(input.speechSegments)
  const excerptNarration = narrationSegmentsFromExcerpt(excerpt)
  const narrationSegments = uniqueStrings(
    [...speechNarration, ...excerptNarration].map(item => item.text),
    12,
  ).map(text => {
    const source = [...speechNarration, ...excerptNarration].find(item => item.text === text)
    return { text, sourceQuote: source?.sourceQuote || '' }
  })
  const dialogueSegments = dialogueSegmentsFrom(input.speechSegments, excerpt)
  const detected = detectIntent(input, dialogueSegments.length, narrationSegments.length, characterCount)
  const intent = detected.intent
  const form: NarrationForm = input.narrationForm === 'narration' ? 'narration' : 'dialogue'
  let finalNarrationSegments = narrationSegments
  let contextNarration = false
  let adaptedNarration = false
  const compressedSilent = Boolean(input.compressedSilent)
  if (!finalNarrationSegments.length && form === 'narration') {
    // 旁白驱动形态：任意镜可用原文叙述 prose 作改写素材；对白镜排除对白原文
    const prose = narrationProseCandidate(excerpt)
    const line = prose || (input.isOpeningShot ? selectContextNarration(excerpt, budgetChars) : '')
    if (line) {
      finalNarrationSegments = [{ text: line, sourceQuote: line }]
      adaptedNarration = true
    }
  } else if (
    !finalNarrationSegments.length
    && !dialogueSegments.length
    && !input.speechRequirement
    && (input.isOpeningShot || compressedSilent)
    && intent !== 'combat'
    && intent !== 'competition'
  ) {
    const line = selectContextNarration(excerpt, budgetChars)
    if (line) {
      finalNarrationSegments = [{ text: line, sourceQuote: line }]
      contextNarration = true
    }
  }
  const styleNote = resolveStyle(String(input.projectStyleText || ''))
  const category: ActionPlan['category'] = intent === 'combat'
    ? 'combat'
    : intent === 'competition'
      ? 'competition'
      : intent === 'action'
        ? 'action'
        : 'none'
  const narrationText = finalNarrationSegments.map(item => item.text).join('')
  const narrationLength = [...narrationText.replace(/[\s\u3000]+/g, '')].length
  const narration: NarrationPlan = finalNarrationSegments.length
    ? {
        mode: adaptedNarration ? 'adapted' : 'source',
        lines: finalNarrationSegments.map(item => item.text),
        sourceQuotes: finalNarrationSegments.map(item => item.sourceQuote),
        budgetChars,
        overflow: narrationLength > budgetChars,
        form,
        reason: adaptedNarration
          ? (input.isOpeningShot
              ? '旁白驱动形态开场镜：必须有开场画外旁白（时间/地点/氛围/钩子），以原文叙述为素材改写。'
              : '旁白驱动形态：以原文叙述为素材改写为第三人称画外旁白；可写情绪/心理/前因，画面人物不张嘴。')
          : contextNarration
            ? (compressedSilent
                ? '压缩过渡镜，用原文叙述作为画外旁白；画面人物不张嘴。'
                : '开场建置镜，用原文背景叙述作为画外旁白。')
            : '原文明确标注旁白，按原文逐字保留；画面人物不张嘴。',
      }
    : {
        mode: 'none',
        lines: [],
        sourceQuotes: [],
        budgetChars,
        overflow: false,
        form,
        reason: form === 'narration'
          ? '原文没有叙述依据，本镜不配旁白。'
          : category !== 'none'
            ? '战斗/比拼/动作镜头用动作、特效与声音叙事，不配旁白。'
            : '原文没有旁白依据，不得自行添加旁白。',
      }
  const action: ActionPlan = {
    category,
    beats: category === 'none' ? [] : actionClauses(input),
    vfx: buildVfx(category, `${input.actionSummary || ''} ${stripNarrationLines(excerpt)}`, styleNote),
    camera: buildCamera(category),
    sound: buildSound(category),
    styleNote: category === 'none' ? '' : styleNote,
    narrationForbidden: form === 'dialogue' && category !== 'none' && narration.mode === 'none',
  }
  return {
    intent,
    narration,
    action,
    tags: planTags(
      intent,
      dialogueSegments.length > 0,
      narration.mode !== 'none',
      characterCount,
      input.transition,
      MEMORY_CUE_RE.test(`${excerpt} ${input.actionSummary || ''}`),
      compressedSilent,
    ),
    evidence: detected.evidence,
  }
}

/** 从成稿文本抽取旁白/画外音行（剥离负面约束分区）；修补落库与手改重算共用。 */
export function narrationLinesFromText(text: string): string[] {
  const body = String(text || '').split(/\n\s*(?:负面约束|Negative constraints|ネガティブ制約|네거티브 제약)\s*[：:]/i)[0]
  return [...body.matchAll(NARRATION_LINE_RE)]
    .map(match => stripQuoteWrapper(String(match[1] || '').split('\n')[0]).replace(/[」”"']+$/, '').trim())
    .filter(line => line && !/^无[。.]?$/.test(line))
}

export function parseNarrationPlan(raw: unknown): NarrationPlan | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as NarrationPlan
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as NarrationPlan : null
  } catch {
    return null
  }
}

export function parseActionPlan(raw: unknown): ActionPlan | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as ActionPlan
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ActionPlan : null
  } catch {
    return null
  }
}

/** 从骨架行读取已落库的意图计划；旧骨架没有计划时返回 null。 */
export function intentPlanFromRow(row: {
  intentType?: string | null
  narrationJson?: string | null
  actionPlanJson?: string | null
} | null | undefined): ShotIntentPlan | null {
  if (!row?.intentType) return null
  const narration = parseNarrationPlan(row.narrationJson)
  const action = parseActionPlan(row.actionPlanJson)
  if (!narration || !action) return null
  return {
    intent: row.intentType as ShotIntentType,
    narration,
    action,
    tags: [],
    evidence: [],
  }
}

export interface SilentRunEntry {
  storyboardNumber: number
  intent: ShotIntentType
  duration: number
  speechCount: number
  narrationMode: NarrationMode
  /** 原文只有发声动作、计划要求补台词；不算无声镜 */
  speechRequirement?: boolean
}

/**
 * 连续无声门禁：对白场景最多允许 2 个连续无声镜，单个无声镜不超过 6 秒。
 * 战斗/比拼连续动作段不受连续数量限制。
 */
export function validateSilentRuns(entries: SilentRunEntry[], maxRun = 2, maxSilentDuration = 6): string[] {
  const issues: string[] = []
  let run: SilentRunEntry[] = []
  const flush = () => {
    if (run.length > maxRun) {
      issues.push(
        `第 ${run[0].storyboardNumber}-${run[run.length - 1].storyboardNumber} 镜连续 ${run.length} 个无声镜；`
        + `请合并为压缩过渡镜、补原文旁白或删除重复反应镜。`,
      )
    }
    run = []
  }
  for (const entry of entries) {
    const exempt = entry.intent === 'combat' || entry.intent === 'competition'
    const silent = entry.speechCount === 0 && !entry.speechRequirement && entry.narrationMode === 'none'
    if (silent && !exempt) {
      run.push(entry)
      if (entry.duration > maxSilentDuration) {
        issues.push(`第 ${entry.storyboardNumber} 镜是无台词镜，时长 ${entry.duration} 秒，超过 ${maxSilentDuration} 秒上限。`)
      }
    } else {
      flush()
    }
  }
  flush()
  return issues
}

const ON_SCREEN_MOUTH_RE = /(?:张嘴|张口|开口(?:说|道|喊|叫)?|嘴唇(?:开合|翕动|张合)|嘴巴(?:开合|翕动|张合))/

export function validateIntentAdherence(
  plan: Pick<ShotIntentPlan, 'intent' | 'narration' | 'action'> | null | undefined,
  description: string,
  videoPrompt: string,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  if (!plan) return { errors, warnings }
  const desc = String(description || '')
  const prompt = String(videoPrompt || '')
  // 负面约束里的“不生成旁白”不是旁白内容，不能触发意图门禁。
  const promptWithoutNegatives = prompt.split(/\n\s*(?:负面约束|Negative constraints|ネガティブ制約|네거티브 제약)\s*[：:]/i)[0]
  const combined = `${desc}\n${promptWithoutNegatives}`
  const hasNarrationMarker = NARRATION_LINE_DETECT_RE.test(combined)
  const formNarration = plan.narration.form === 'narration'
  if (plan.narration.mode === 'none') {
    if (hasNarrationMarker) {
      errors.push(`本镜意图为${intentLabel(plan.intent)}，计划明确禁止旁白/画外音；请删掉旁白，改用动作、特效与声音叙事。`)
    }
  } else if (plan.narration.mode === 'adapted') {
    // 改写式旁白：不要求逐字，但必须写入 description 与 video_prompt，且不超预算
    if (!NARRATION_LINE_DETECT_RE.test(desc)) {
      errors.push('旁白驱动形态：本镜计划要求画外旁白，description 缺少旁白/画外音。')
    }
    if (!NARRATION_LINE_DETECT_RE.test(promptWithoutNegatives)) {
      errors.push('旁白驱动形态：本镜计划要求画外旁白，video_prompt 缺少旁白/画外音。')
    }
    const actualChars = [...promptWithoutNegatives.matchAll(NARRATION_LINE_RE)]
      .map(match => String(match[1] || '').split('\n')[0])
      .join('')
      .replace(/[\s\u3000，。！？；：、“”‘’（）《》【】…—,.!?;:"'()\[\]]/g, '').length
    if (actualChars > plan.narration.budgetChars) {
      errors.push(`旁白约 ${actualChars} 字，超出本镜预算 ${plan.narration.budgetChars} 字（4 字/秒 + 1 秒气口）；请延长时长或按标点拆到相邻镜，不得截断。`)
    }
    const mouthText = desc.replace(/(?:不|没|未)(?:有)?(?:张嘴|张口|开口|说话)/g, '')
    if (ON_SCREEN_MOUTH_RE.test(mouthText)) {
      warnings.push('旁白镜头里出现了张嘴/开口动作；旁白应只作为画外音，画面人物保持嘴唇闭合。')
    }
  } else {
    for (const line of plan.narration.lines) {
      const normalized = normalizeForMatch(line)
      if (!normalized) continue
      if (!normalizeForMatch(desc).includes(normalized)) {
        errors.push(`计划旁白没有逐字写入 description：「${truncate(line, 24)}」。`)
      }
      if (!normalizeForMatch(prompt).includes(normalized)) {
        errors.push(`计划旁白没有逐字写入 video_prompt：「${truncate(line, 24)}」。`)
      }
    }
    if (!plan.narration.lines.length && hasNarrationMarker) {
      errors.push('旁白计划为空，但成稿出现了旁白/画外音；请删除。')
    }
    const mouthText = desc.replace(/(?:不|没|未)(?:有)?(?:张嘴|张口|开口|说话)/g, '')
    if (ON_SCREEN_MOUTH_RE.test(mouthText) && plan.narration.mode === 'source') {
      warnings.push('旁白镜头里出现了张嘴/开口动作；旁白应只作为画外音，画面人物保持嘴唇闭合。')
    }
  }
  if (plan.narration.overflow) {
    warnings.push(formNarration
      ? `原文旁白素材约超出本镜容量（上限 ${plan.narration.budgetChars} 字），请按标点拆到相邻镜或延长时长。`
      : `原文旁白约超出本镜容量（上限 ${plan.narration.budgetChars} 字），请按原文标点拆到相邻镜，不得截断或改写。`)
  }
  return { errors, warnings }
}

export function intentLabel(intent: ShotIntentType): string {
  const labels: Record<ShotIntentType, string> = {
    dialogue: '对白',
    exposition: '叙述/旁白',
    character_intro: '角色介绍',
    combat: '战斗/打斗',
    competition: '比拼/竞技',
    action: '动作',
    transition: '转场',
    empty: '空镜',
  }
  return labels[intent] || intent
}

/** 修补提示词里的计划块：计划是唯一裁定，修补只能执行，不能改意图或自行加旁白。 */
export function formatIntentPlanBlock(plan: ShotIntentPlan): string {
  const formNarration = plan.narration.form === 'narration'
  const narration = plan.narration.mode === 'source'
    ? `仅保留原文旁白（逐字）：${plan.narration.lines.map(line => `「${line}」`).join('；')}`
    : plan.narration.mode === 'adapted'
      ? [
          `改写式画外旁白，素材原文：${plan.narration.lines.map(line => `「${line}」`).join('；')}`,
          '- 旁白风格：第三人称完整句，主语明确，称呼用项目规范名；可写情绪、心理与前因后果；不得逐字复述对白原文。',
          '- 旁白与对白分时共存：同一时间帧内不得既有台词又有旁白；按时间帧分段，旁白在标点处断开，禁止词中断开。',
          '- 旁白与画面同步：旁白说到的人物/动作必须画内可见；画面人物嘴唇闭合，不张嘴。',
        ].join('\n')
      : formNarration
        ? '本镜原文没有叙述依据，不配旁白；人物不张口说话'
        : '禁止旁白/画外音/内心独白；人物不张口说话'
  const actionLines = plan.action.category !== 'none'
    ? [
        `- 动作类别：${plan.action.category}（题材只影响特效风格）`,
        `- 动作编排：${plan.action.beats.length ? plan.action.beats.join(' → ') : '按动作起点到终点写连续动作'}`,
        `- 特效：${plan.action.vfx.join('；') || '写实动作冲击'}`,
        `- 机位：${plan.action.camera}`,
        `- 声音元素：${plan.action.sound}`,
        `- 风格：${plan.action.styleNote}`,
      ]
    : ['- 本镜不是动作/战斗/比拼镜，不生成动作特效编排。']
  return [
    '### 镜头意图计划（本步已裁定，修补必须执行）',
    `- 意图：${intentLabel(plan.intent)}${plan.evidence.length ? `（依据：${plan.evidence.join('、')}）` : ''}`,
    `- 旁白：${narration}`,
    `- 旁白字数上限：${plan.narration.budgetChars} 字（4 字/秒 + 1 秒气口）`,
    ...actionLines,
    plan.action.narrationForbidden
      ? '- 硬约束：本镜没有原文旁白依据，禁止新增任何旁白、画外音、内心独白；原文对白仍按计划台词或骨架发声要求执行。'
      : '',
  ].filter(Boolean).join('\n')
}
