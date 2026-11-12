/**
 * 分镜计划层契约：把骨架从“摘要”提升为可校验的 ShotPlan。
 *
 * 硬规则：
 * - 说话提示与台词原子化，不允许把提示留在一镜、台词放下一镜。
 * - 相邻镜必须续接；过渡词只允许单侧出现；下一镜不能重复上一镜开头。
 * - 同场屏幕左右、地标侧、轴线是场景常量，不得因说话人变化翻转。
 */
import { findQuotedSpans } from './dialogue-lines.js'
import { extractScriptDialogueSegments } from './dialogue-integrity.js'

export interface PlanSpeechSegment {
  speaker: string
  text: string
  sourceQuote: string
  order: number
}

export interface PlanShot {
  shotNumber: number
  sceneId: number | null
  location?: string | null
  time?: string | null
  sourceExcerpt: string
  duration: number
  actionStart: string | null
  actionEnd: string | null
  coverageType: string | null
  speechSegments: PlanSpeechSegment[]
  boundaryType: string | null
  boundaryWord: string | null
  screenLeft: string | null
  screenRight: string | null
  axisSide: string | null
  landmarkSide: string | null
  /** 画内人物数量：单人或空镜不建立人物轴线 */
  characterCount?: number
  /** 台词来源：excerpt=摘录提取；planner=长台词片段；inferred=发声动作推导 */
  speechSource?: 'excerpt' | 'planner' | 'inferred'
  /** establishing / action / dialogue / reaction / insert / transition */
  shotType?: string
  subject?: string | null
  subjects?: string[]
  beatCount?: number
  actionArc?: { initial: string; action: string; result: string } | null
  /** 原文只有发声动作、没有具体台词时必须补的 inferred 台词要求 */
  speechRequirement?: { speaker: string; basis: string } | null
}

/** 场景契约的最小只读视图；由 scene-contract 服务提供，避免服务间循环依赖 */
export interface PlanSceneContract {
  sceneId: number
  sceneName?: string | null
  screenLeft: string | null
  screenRight: string | null
  axisSide: string | null
  landmarkSide: string | null
  sourceShotNumber?: number | null
}

export interface BoundaryContract {
  fromShotNumber: number
  toShotNumber: number
  type: 'speech' | 'action' | 'reaction' | 'scene' | 'time'
  fromEndState: string
  toStartState: string
  transitionWord: string
  sides: {
    left: string | null
    right: string | null
    axis: string | null
    landmark: string | null
  }
}

export interface PlanIssue {
  layer: 'plan'
  code: string
  severity: 'error' | 'warning'
  shotNumber: number | null
  boundary: string | null
  message: string
  evidence: string
  fixable: boolean
}

export interface PlanGateResult {
  issues: PlanIssue[]
  boundaries: BoundaryContract[]
}

const META_BEFORE_QUOTE_RE = /(?:旁白|画外音|心声|内心独白|narration|voice[\s-]?over|inner\s+voice)\s*(?:[（(][^）)]*[）)])?\s*[：:]?\s*$/i
const SPEAKER_COLON_RE = /(@?[\u4e00-\u9fa5A-Za-z0-9·]{1,16})\s*(?:[（(][^）)]*[）)])?\s*[：:]\s*$/
const SPEECH_LEAD_IN_RE = /(?:[：:]|唱喝|唱喏|吆喝|叫卖|揽客|喊道?|叫道|说道|问道|答道|骂道?|嚷道?|吼道?)\s*[。！？!?…]*\s*$/
const SIGNBOARD_BEFORE_RE = /(?:写|印|刻|绣|标|题|显示|上书|挂着|贴着)[^，。！？!?]{0,8}[：:]?\s*$/
const NARRATIVE_QUOTE_SPEAKER_RE = /[的了着这那他她它我你更也都就才又还却的是]/

function normalizeText(text: string) {
  return String(text || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s\u3000]+/g, '')
}

function extractQuotedSegments(text: string): PlanSpeechSegment[] {
  const source = String(text || '')
  const segments: PlanSpeechSegment[] = []
  for (const span of findQuotedSpans(source)) {
    const before = source.slice(Math.max(0, span.start - 40), span.start).replace(/\s+$/, '')
    if (SIGNBOARD_BEFORE_RE.test(before)) continue
    const rawSpeaker = before.match(SPEAKER_COLON_RE)?.[1]?.replace(/^@/, '')
    const speakerMatch = rawSpeaker && !NARRATIVE_QUOTE_SPEAKER_RE.test(rawSpeaker) ? { 1: rawSpeaker } : null
    const narrated = META_BEFORE_QUOTE_RE.test(before)
    const spoken = SPEECH_LEAD_IN_RE.test(before)
    const value = normalizeText(span.inner)
    if (!value) continue
    // 没有说话提示的引号多数是专有名词/拟声词（“半截扁担”“啪嗒”“求方便”）；
    // 只有成句且带句读时才按无主台词保留，避免把叙述性引号误判为台词。
    if (!speakerMatch && !narrated && !spoken) {
      const compact = value.replace(/\s/g, '')
      if (compact.length < 3 || !/[。！？!?…，,；;]/.test(value)) continue
    }
    const speaker = speakerMatch?.[1]?.replace(/^@/, '') || (narrated ? '旁白' : '')
    segments.push({ speaker, text: value, sourceQuote: span.inner, order: segments.length + 1 })
  }
  return segments
}

/** 从原文摘录提取计划台词；剧本格式与引号格式都支持，按出现顺序去重。 */
export function extractPlanSpeechSegments(sourceExcerpt: string): PlanSpeechSegment[] {
  const segments = extractScriptDialogueSegments(sourceExcerpt).map((item, index) => ({
    speaker: item.speaker,
    text: normalizeText(item.text),
    sourceQuote: item.raw,
    order: index + 1,
  }))
  const seen = new Set(segments.map(item => item.text))
  for (const item of extractQuotedSegments(sourceExcerpt)) {
    if (seen.has(item.text)) continue
    seen.add(item.text)
    segments.push({ ...item, order: segments.length + 1 })
  }
  return segments.filter(item => item.text)
}

function startsWithSpeech(sourceExcerpt: string) {
  const text = String(sourceExcerpt || '').trim()
  if (!text) return false
  if (extractScriptDialogueSegments(text).length > 0) return true
  return /^[「『“"]/.test(text)
}

const SCRIPT_LINE_ONLY_RE = /^\s*(?:@)?[^\s，。！？；：、,.!?;:]{1,16}\s*(?:[（(][^）)]*[）)])?\s*[：:]\s*[。！？!?…\s]*$/

function endsWithSpeechLeadIn(sourceExcerpt: string) {
  const text = String(sourceExcerpt || '').trim()
  // `角色：……` 是完整的无词台词行，不是停在说话提示上
  if (SCRIPT_LINE_ONLY_RE.test(text)) return false
  return SPEECH_LEAD_IN_RE.test(text)
}

function repeatedBoundaryLength(current: string, next: string) {
  const a = normalizeText(current)
  const b = normalizeText(next)
  const max = Math.min(12, a.length, b.length)
  for (let len = max; len >= 2; len -= 1) {
    const prefix = b.slice(0, len)
    if (a.endsWith(prefix) && /[\u4e00-\u9fa5A-Za-z0-9]/.test(prefix)) return len
  }
  return 0
}

function issue(
  code: string,
  shotNumber: number | null,
  message: string,
  evidence: string,
  severity: 'error' | 'warning' = 'error',
  boundary: string | null = null,
): PlanIssue {
  return { layer: 'plan', code, severity, shotNumber, boundary, message, evidence, fixable: severity !== 'error' }
}

const INTERNAL_ACTION_RE = /(心酸|失落|渐弱|愈发|自觉|无趣|吃味|得意|紧张|害怕|高兴|难过|愤怒|委屈|不甘|眼红)/
const INTERNAL_ENDPOINT_ONLY_RE = /(自觉|愈发|渐弱|心里|心中|暗想|心想|盘算|寻思|琢磨|无趣|心酸|失落|不甘|眼红)/
const VISIBLE_ACTION_RE = /(站|坐|躺|靠|走|跑|转|抬|低|伸|收|放|拿|端|推|拉|举|摔|捡|看|望|扫|瞥|盯|白|瞪|瞟|瞄|皱|撇|点|摇|笑|哭|骂|喊|说|问|答|回|进|出|起|落|停|冲|退|跪|蹲|扶|抱|握|擦|切|雕|刻|拍|摸|指|掀|揭|倒|盛|装|穿|脱|递|接|追|躲|藏|愣|颤|抖|开张|吃|喝|捧|吹)/
const INDOOR_ACTION_RE = /((?:回|走进|走入|进了|进入)(?:了)?(?:店|屋|堂)(?:内|里)?)/
const OUTDOOR_LOCATION_RE = /(街|市|广场|门外|巷|路)/

function effectiveSpeechChars(text: string) {
  return String(text || '').replace(/[\s，。！？；：、“”‘’（）《》【】…—,.!?;:"'()\[\]]/g, '').length
}

export function validatePlanSequence(plans: PlanShot[], options: {
  minDuration?: number
  maxDuration?: number
  sceneContracts?: Map<number, PlanSceneContract>
  allowPendingInferredSpeech?: boolean
} = {}): PlanGateResult {
  const minDuration = options.minDuration ?? 6
  const maxDuration = options.maxDuration ?? 15
  const issues: PlanIssue[] = []
  const boundaries: BoundaryContract[] = []
  const canonicalByScene = new Map<number, { plan: PlanShot; origin: string }>()
  for (const contract of options.sceneContracts?.values() || []) {
    if (!contract.screenLeft && !contract.screenRight && !contract.axisSide && !contract.landmarkSide) continue
    canonicalByScene.set(Number(contract.sceneId), {
      plan: {
        shotNumber: contract.sourceShotNumber ?? 0,
        sceneId: contract.sceneId,
        sourceExcerpt: '',
        duration: 0,
        actionStart: null,
        actionEnd: null,
        coverageType: null,
        speechSegments: [],
        boundaryType: null,
        boundaryWord: null,
        screenLeft: contract.screenLeft,
        screenRight: contract.screenRight,
        axisSide: contract.axisSide,
        landmarkSide: contract.landmarkSide,
      },
      origin: `场景契约「${contract.sceneName || contract.sceneId}」`,
    })
  }
  for (const plan of plans) {
    if (plan.sceneId == null) continue
    const sceneId = Number(plan.sceneId)
    if (canonicalByScene.has(sceneId)) continue
    if (plan.screenLeft || plan.screenRight || plan.axisSide || plan.landmarkSide) {
      canonicalByScene.set(sceneId, { plan, origin: `同场建立镜第 ${plan.shotNumber} 镜` })
    }
  }

  for (const plan of plans) {
    const label = `第 ${plan.shotNumber} 镜`
    if (plan.duration < minDuration || plan.duration > maxDuration) {
      issues.push(issue('plan_duration', plan.shotNumber, `${label}时长 ${plan.duration} 秒，必须在 ${minDuration}-${maxDuration} 秒之间。`, plan.sourceExcerpt))
    }
    const sourceText = String(plan.sourceExcerpt || '').trim()
    if (!sourceText) {
      issues.push(issue('plan_excerpt_empty', plan.shotNumber, `${label}缺少原文摘录。`, ''))
      continue
    }
    if (/[：:]\s*$/.test(sourceText)) {
      issues.push(issue('speech_lead_in_incomplete', plan.shotNumber, `${label}摘录停在说话提示/冒号上，台词必须和说话提示同镜。`, sourceText.slice(-40)))
    }
    const sourceSegments = extractPlanSpeechSegments(sourceText)
    if (sourceSegments.length && !plan.speechSegments.length) {
      issues.push(issue('plan_speech_missing', plan.shotNumber, `${label}原文含台词，但计划没有台词原子单元。`, sourceSegments.map(item => item.text).join('、')))
    }
    if (!sourceSegments.length && plan.speechSegments.length && plan.speechSource !== 'planner' && plan.speechSource !== 'inferred') {
      issues.push(issue('plan_speech_invented', plan.shotNumber, `${label}原文没有台词，计划却包含台词。`, plan.speechSegments.map(item => item.text).join('、')))
    }
    if (!options.allowPendingInferredSpeech && plan.speechRequirement && !plan.speechSegments.length) {
      issues.push(issue(
        'vocal_action_without_speech',
        plan.shotNumber,
        `${label}有“${plan.speechRequirement.basis}”发声动作，但没有具体台词；必须在计划层补 inferred 台词。`,
        plan.sourceExcerpt.slice(0, 80),
      ))
    }
    if (/^#{1,4}\s+/.test(String(plan.sourceExcerpt || '').trim())) {
      issues.push(issue('doc_title_as_shot', plan.shotNumber, `${label}把文档标题当成了分镜正文。`, plan.sourceExcerpt.slice(0, 60)))
    }
    const subjects = [...new Set([
      ...(plan.subjects || []),
      ...(plan.subject ? [plan.subject] : []),
    ].map(item => String(item || '').trim()).filter(Boolean))]
    // 一个镜头只有一个焦点主体；允许最多一个到达/反应配角与台词同镜。
    if (subjects.length > 3) {
      issues.push(issue('multi_subject_shot', plan.shotNumber, `${label}包含多个动作主体（${subjects.join('、')}）；一个分镜只能一个焦点主体加最多两个配角。`, plan.sourceExcerpt.slice(0, 80)))
    }
    // 只有 v3 ShotPlan 才强制动作弧；旧计划/旧任务没有 shotType，不能因升级被误杀。
    const endpointExempt = !plan.shotType || plan.shotType === 'establishing' || plan.shotType === 'insert'
    if (!endpointExempt) {
      const start = String(plan.actionStart || '').trim()
      const end = String(plan.actionEnd || '').trim()
      if (!start || !end) {
        issues.push(issue('action_endpoint_missing', plan.shotNumber, `${label}缺少可见动作起点或终点。`, `${start || '空'} → ${end || '空'}`))
      } else if (normalizeText(start) === normalizeText(end)) {
        issues.push(issue('action_start_equals_end', plan.shotNumber, `${label}动作起点和终点相同，无法形成动作弧。`, start))
      }
    }
    if (sourceSegments.length && plan.speechSegments.length) {
      const planned = plan.speechSegments.map(item => normalizeText(item.text)).join('')
      const missing = sourceSegments.filter(item => !planned.includes(normalizeText(item.text)))
      if (missing.length) {
        issues.push(issue('plan_speech_incomplete', plan.shotNumber, `${label}计划漏掉原文台词。`, missing.map(item => item.text).join('、')))
      }
    }

    const speakers = [...new Set(plan.speechSegments.map(item => String(item.speaker || '').trim()).filter(Boolean))]
    if (speakers.length > 1) {
      issues.push(issue(
        'multi_speaker_shot',
        plan.shotNumber,
        `${label}有 ${speakers.length} 个说话人（${speakers.join('、')}）；一个分镜只能一个说话人，请拆成正反打或单人镜头。`,
        plan.sourceExcerpt.slice(0, 80),
      ))
    }

    const speechChars = plan.speechSegments.reduce((sum, item) => sum + effectiveSpeechChars(item.text), 0)
    const speechCapacity = Math.max(0, plan.duration - 1) * 4
    if (speechChars > speechCapacity) {
      issues.push(issue(
        'dialogue_over_capacity',
        plan.shotNumber,
        `${label}台词约 ${speechChars} 字，${plan.duration} 秒最多容纳 ${speechCapacity} 字；请拆到相邻分镜或延长时长，不要靠加快语速硬塞。`,
        plan.speechSegments.map(item => item.text).join('、'),
      ))
    }

    for (const [field, value] of [['动作起点', plan.actionStart], ['动作终点', plan.actionEnd]] as const) {
      const text = String(value || '').trim()
      const internalOnly = INTERNAL_ENDPOINT_ONLY_RE.test(text) || (INTERNAL_ACTION_RE.test(text) && !VISIBLE_ACTION_RE.test(text))
      if (text && internalOnly) {
        issues.push(issue(
          'action_endpoint_internal',
          plan.shotNumber,
          `${label}${field}「${text}」是心理/声音描述，不是可见动作；请改成手、视线、身体或道具的具体状态。`,
          text,
        ))
      }
    }

    const location = String(plan.location || '')
    // 舞台提示（如「（扔下一句，折回店里）」）不是本镜动作，不能据此判定跨室内外
    const actionAndExcerpt = `${plan.actionStart || ''} ${plan.actionEnd || ''} ${plan.sourceExcerpt || ''}`
      .replace(/[（(][^）)]*[）)]/g, '')
    if (location && OUTDOOR_LOCATION_RE.test(location) && INDOOR_ACTION_RE.test(actionAndExcerpt)) {
      issues.push(issue(
        'location_change_inside_shot',
        plan.shotNumber,
        `${label}地点是「${location}」，但动作进入「${actionAndExcerpt.match(INDOOR_ACTION_RE)?.[1] || '室内'}」；一个分镜不能跨室内外，请拆镜或改回门槛外动作。`,
        actionAndExcerpt.slice(0, 100),
      ))
    }

    const canonical = plan.sceneId == null ? null : canonicalByScene.get(Number(plan.sceneId))
    const isOriginShot = canonical?.origin.startsWith('同场建立镜') && canonical.plan.shotNumber === plan.shotNumber
    if (canonical && !isOriginShot) {
      for (const [field, labelText] of [
        ['screenLeft', '画面左'],
        ['screenRight', '画面右'],
        ['axisSide', '轴线'],
        ['landmarkSide', '地标侧'],
      ] as const) {
        const value = String(plan[field] || '').trim()
        const base = String(canonical.plan[field] || '').trim()
        if (value && base && value !== base) {
          issues.push(issue(
            'scene_constant_flip',
            plan.shotNumber,
            `${label}${labelText}「${value}」与${canonical.origin}「${base}」不一致；请修正本镜，不要翻转场景常量。`,
            `${canonical.origin}：${base} → ${label}：${value}`,
            'error',
            `${canonical.plan.shotNumber}-${plan.shotNumber}`,
          ))
        }
      }
    }
  }

  for (let index = 0; index < plans.length; index += 1) {
    const current = plans[index]
    const next = plans[index + 1]
    if (!next) continue
    const boundaryKey = `${current.shotNumber}-${next.shotNumber}`
    const currentText = current.sourceExcerpt
    const nextText = next.sourceExcerpt

    if (endsWithSpeechLeadIn(currentText) && startsWithSpeech(nextText)) {
      issues.push(issue(
        'speech_split_across_shots',
        current.shotNumber,
        `第 ${current.shotNumber} 镜停在说话提示/发声动作，第 ${next.shotNumber} 镜从台词开始；说出台词必须和提示同镜。`,
        `${currentText.slice(-40)} → ${nextText.slice(0, 40)}`,
        'error',
        boundaryKey,
      ))
    }

    const repeated = repeatedBoundaryLength(currentText, nextText)
    if (repeated >= 4) {
      issues.push(issue(
        'boundary_duplicate_prefix',
        next.shotNumber,
        `第 ${next.shotNumber} 镜开头重复了第 ${current.shotNumber} 镜结尾（${repeated} 字）。`,
        `${currentText.slice(-repeated)} → ${nextText.slice(0, repeated)}`,
        'error',
        boundaryKey,
      ))
    } else if (repeated >= 2) {
      issues.push(issue(
        'boundary_duplicate_prefix',
        next.shotNumber,
        `第 ${next.shotNumber} 镜开头疑似重复第 ${current.shotNumber} 镜结尾。`,
        `${currentText.slice(-repeated)} → ${nextText.slice(0, repeated)}`,
        'warning',
        boundaryKey,
      ))
    }

    const currentWord = String(current.boundaryWord || '').trim()
    const nextWord = String(next.boundaryWord || '').trim()
    if (currentWord && nextWord) {
      issues.push(issue('transition_word_duplicated', next.shotNumber, `过渡词在相邻两镜都出现：${currentWord} / ${nextWord}。`, boundaryKey, 'error', boundaryKey))
    }

    const sameScene = current.sceneId != null && next.sceneId != null && Number(current.sceneId) === Number(next.sceneId)

    const type: BoundaryContract['type'] = !sameScene
      ? 'scene'
      : (current.speechSegments.length && next.speechSegments.length && endsWithSpeechLeadIn(currentText) ? 'speech' : 'action')
    boundaries.push({
      fromShotNumber: current.shotNumber,
      toShotNumber: next.shotNumber,
      type,
      fromEndState: current.actionEnd || currentText.slice(-32),
      toStartState: next.actionStart || nextText.slice(0, 32),
      transitionWord: currentWord || nextWord,
      sides: {
        left: current.screenLeft,
        right: current.screenRight,
        axis: current.axisSide,
        landmark: current.landmarkSide,
      },
    })
  }

  return { issues, boundaries }
}

export function planIssuesText(issues: PlanIssue[]) {
  return issues.map(item => item.message).join('；')
}
