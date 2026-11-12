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

function normalizeText(text: string) {
  return String(text || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s\u3000]+/g, '')
}

function extractQuotedSegments(text: string): PlanSpeechSegment[] {
  const source = String(text || '')
  const segments: PlanSpeechSegment[] = []
  for (const span of findQuotedSpans(source)) {
    const before = source.slice(Math.max(0, span.start - 32), span.start).replace(/\s+$/, '')
    const speakerMatch = before.match(SPEAKER_COLON_RE)
    const speaker = speakerMatch?.[1]?.replace(/^@/, '') || (META_BEFORE_QUOTE_RE.test(before) ? '旁白' : '')
    const value = normalizeText(span.inner)
    if (!value) continue
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

function endsWithSpeechLeadIn(sourceExcerpt: string) {
  return SPEECH_LEAD_IN_RE.test(String(sourceExcerpt || '').trim())
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

export function validatePlanSequence(plans: PlanShot[], options: {
  minDuration?: number
  maxDuration?: number
} = {}): PlanGateResult {
  const minDuration = options.minDuration ?? 6
  const maxDuration = options.maxDuration ?? 15
  const issues: PlanIssue[] = []
  const boundaries: BoundaryContract[] = []

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
    if (!sourceSegments.length && plan.speechSegments.length) {
      issues.push(issue('plan_speech_invented', plan.shotNumber, `${label}原文没有台词，计划却包含台词。`, plan.speechSegments.map(item => item.text).join('、')))
    }
    if (sourceSegments.length && plan.speechSegments.length) {
      const planned = plan.speechSegments.map(item => normalizeText(item.text)).join('')
      const missing = sourceSegments.filter(item => !planned.includes(normalizeText(item.text)))
      if (missing.length) {
        issues.push(issue('plan_speech_incomplete', plan.shotNumber, `${label}计划漏掉原文台词。`, missing.map(item => item.text).join('、')))
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
    if (sameScene) {
      for (const [field, label] of [
        ['screenLeft', '画面左'],
        ['screenRight', '画面右'],
        ['axisSide', '轴线'],
        ['landmarkSide', '地标侧'],
      ] as const) {
        const a = String(current[field] || '').trim()
        const b = String(next[field] || '').trim()
        if (a && b && a !== b) {
          issues.push(issue(
            'scene_constant_flip',
            next.shotNumber,
            `同场相邻镜${label}不一致：第 ${current.shotNumber} 镜「${a}」，第 ${next.shotNumber} 镜「${b}」。`,
            boundaryKey,
            'error',
            boundaryKey,
          ))
        }
      }
    }

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
