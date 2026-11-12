/**
 * 逐镜校验（第三段）
 *
 * 修补完一镜就立即校验这一镜，不通过不进入下一镜。
 * 这里只做确定性检查；语义连贯由修补 Agent 在上下文里自行处理，
 * 规则层负责：合同/分区/台词完整性、发声动作必须有具体台词、原剧本台词不丢、相邻镜方向与动作端点。
 */
import { validateStoryboardUnit } from './storyboard-unit-contract.js'
import { extractSpokenQuotes, inspectDialogueIntegrity } from './dialogue-integrity.js'
import { findQuotedSpans } from './dialogue-lines.js'
import { parseContractFromPrompt, type ParsedContract } from './storyboard-contract.js'
import { evaluateContractPairIssues } from './storyboard-contract-audit.js'

/** 强发声动词：出现即表示角色在说话/叫喊，必须给出具体台词 */
const VOCAL_VERB_RE = /(?:喊道?|叫道|喊话|高喊|吆喝|叫卖|揽客|嚷道?|吼道?|骂道?|呼唤|招呼道|嘟囔|嘀咕|自语|问道|答道|追问道|念叨|唱道)/g
const VOCAL_VERB_EN_RE = /\b(?:shouts?|yells?|calls? out|hollers?|cries out|mutters?|murmurs?|whispers?|announces?|asks?|replies?|answers?)\b/gi

export interface VocalIntent {
  /** 原文/画面里有发声动作 */
  vocal: boolean
  /** 原文里已有明确引号台词 */
  hasExplicitLine: boolean
  /** 触发词，供问题证据展示 */
  evidence: string[]
}

function stripQuoted(text: string) {
  return String(text || '').replace(/「[^」]*」|“[^”]*”|"[^"]*"/g, '')
}

export function detectVocalIntent(text: string | null | undefined): VocalIntent {
  const source = String(text || '')
  const evidence = [...new Set([
    ...[...stripQuoted(source).matchAll(VOCAL_VERB_RE)].map(match => match[0]),
    ...[...stripQuoted(source).matchAll(VOCAL_VERB_EN_RE)].map(match => match[0]),
  ])]
  return {
    vocal: evidence.length > 0,
    hasExplicitLine: extractSpokenQuotes(source).length > 0,
    evidence,
  }
}

function normalizedQuotes(text: string) {
  return extractSpokenQuotes(text).map(quote => quote.text)
}

const NON_SPEECH_PREFIX_RE = /(?:招牌|告示|字幕|标题|牌匾|匾额|书信|信上|榜文|写着|印着|刻着|上书)\s*[：:]?\s*$/

/**
 * 原文台词引号（宽松）：小说里常见「张三：“快走！”」不带说话动词，也要算台词。
 * 只排除招牌/字幕/书信等非口白引号。
 */
function extractSourceQuotes(text: string): string[] {
  const source = String(text || '')
  const result: string[] = []
  for (const span of findQuotedSpans(source)) {
    const before = source.slice(Math.max(0, span.start - 24), span.start).replace(/\s+$/, '')
    if (NON_SPEECH_PREFIX_RE.test(before)) continue
    const normalized = span.inner.replace(/[\s\u3000]+/g, '')
    if (normalized) result.push(normalized)
  }
  return result
}

function includesAllQuotes(container: string[], source: string[]) {
  const joined = container.join('')
  return source.filter(text => !joined.includes(text))
}

export interface RepairedShotInput {
  sourceExcerpt?: string | null
  description?: string | null
  videoPrompt?: string | null
  characterIds?: number[]
  duration?: number | null
  sceneId?: number | null
  characters?: Array<{ id: number; name: string }>
  shotLabel?: string
  previous?: {
    storyboardNumber: number
    sceneId: number | null
    videoPrompt: string | null
    transition?: string | null
    characterIds?: number[]
  } | null
  transition?: string | null
}

export interface RepairedShotValidation {
  errors: string[]
  warnings: string[]
  parsedContract: ParsedContract | null
}

/** 单镜校验；errors 非空表示该镜必须重修补，不能进入下一镜 */
export function validateRepairedShot(input: RepairedShotInput): RepairedShotValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const label = input.shotLabel || '本镜'
  const description = String(input.description || '')
  const prompt = String(input.videoPrompt || '')
  const source = String(input.sourceExcerpt || '')

  errors.push(...validateStoryboardUnit({
    description,
    videoPrompt: prompt,
    characterIds: input.characterIds,
    duration: input.duration,
    shotLabel: label,
    checkSubshots: true,
  }))

  const sourceIntent = detectVocalIntent(source)
  const descriptionIntent = detectVocalIntent(description)
  const sourceQuotes = extractSourceQuotes(source)
  const descriptionQuotes = normalizedQuotes(description)
  const promptQuotes = normalizedQuotes(prompt)

  if (sourceQuotes.length) {
    const missing = includesAllQuotes(descriptionQuotes, sourceQuotes)
    if (missing.length) {
      errors.push(`${label}漏掉了原剧本台词：${missing.map(text => `「${text.slice(0, 30)}${text.length > 30 ? '…' : ''}」`).join('、')}；必须逐字保留，不能改写成动作。`)
    }
  } else if (sourceIntent.vocal && !descriptionQuotes.length) {
    errors.push(`${label}原剧本是「${sourceIntent.evidence.slice(0, 3).join('、')}」这类发声动作，但分镜没有补出具体台词。必须遵循小说语意补一句可拍的具体台词，不能改成拍围裙/翻炊饼等非语言动作。`)
  } else if (!sourceIntent.vocal && descriptionQuotes.length) {
    errors.push(`${label}原剧本此段没有台词或发声动作，修补却自行加了台词；请删掉创作台词，或从原文中找到依据。`)
  }

  if (descriptionIntent.vocal && !descriptionQuotes.length) {
    errors.push(`${label}description 写了「${descriptionIntent.evidence.slice(0, 3).join('、')}」但没有任何具体台词；发声动作必须写出「@角色说：「…」」的具体内容。`)
  }

  if (promptQuotes.length) {
    if (!descriptionQuotes.length) {
      errors.push(`${label}video_prompt 有台词，但 description 没有台词原文；台词只能来自 description。`)
    } else {
      const missing = includesAllQuotes(promptQuotes, descriptionQuotes)
      if (missing.length) warnings.push(`${label}video_prompt 没有逐字保留 description 的全部台词：${missing.length} 句缺失。`)
    }
  }

  const integrity = inspectDialogueIntegrity(description, prompt)
  if (integrity && !integrity.ok) {
    errors.push(`${label}video_prompt 没有逐字保留 description 台词和标点，缺少「${integrity.missing.slice(0, 40)}」。`)
  }

  const promptForSpeech = prompt.split(/\n\s*(?:负面约束|Negative constraints|ネガティブ制約|네거티브 제약)\s*[：:]/i)[0]
  const promptIntent = detectVocalIntent(stripQuoted(promptForSpeech))
  if (promptIntent.vocal && !promptQuotes.length) {
    errors.push(`${label}video_prompt 写了「${promptIntent.evidence.slice(0, 3).join('、')}」却没有具体台词；视频模型会生成无内容的喊叫动作。`)
  }

  const parsedContract = parseContractFromPrompt(prompt, input.characters || [], input.characterIds || [])
  if (input.previous && parsedContract.contractVersion > 0 && input.previous.videoPrompt) {
    const previousContract = parseContractFromPrompt(input.previous.videoPrompt, input.characters || [], input.previous.characterIds || [])
    if (previousContract.contractVersion > 0) {
      const issues = evaluateContractPairIssues(
        {
          id: -1,
          storyboardNumber: input.previous.storyboardNumber,
          sceneId: input.previous.sceneId ?? null,
          coverageType: null,
          axisSide: previousContract.axisSide,
          screenLeft: previousContract.screenLeft,
          screenRight: previousContract.screenRight,
          foregroundShoulder: previousContract.foregroundShoulder,
          castOnScreen: previousContract.castOnScreen,
          backgroundLandmarks: previousContract.backgroundLandmarks,
          sceneGeographyId: null,
          contractVersion: previousContract.contractVersion,
          transition: input.previous.transition || 'cut',
          actionStart: previousContract.actionStart,
          actionEnd: previousContract.actionEnd,
        },
        {
          id: -2,
          storyboardNumber: (input.previous.storyboardNumber || 0) + 1,
          sceneId: input.sceneId ?? null,
          coverageType: null,
          axisSide: parsedContract.axisSide,
          screenLeft: parsedContract.screenLeft,
          screenRight: parsedContract.screenRight,
          foregroundShoulder: parsedContract.foregroundShoulder,
          castOnScreen: parsedContract.castOnScreen,
          backgroundLandmarks: parsedContract.backgroundLandmarks,
          sceneGeographyId: null,
          contractVersion: parsedContract.contractVersion,
          transition: input.transition || 'cut',
          actionStart: parsedContract.actionStart,
          actionEnd: parsedContract.actionEnd,
        },
      )
      for (const issue of issues) {
        if (issue.severity === 'error') errors.push(issue.message)
        else warnings.push(issue.message)
      }
    }
  }

  return { errors, warnings, parsedContract }
}
