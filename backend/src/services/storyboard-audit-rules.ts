/**
 * 分镜动作检验 · 规则层（纯函数）
 *
 * 只做确定性判断：字段完整性、视频提示词结构、空镜阈值、台词容量与资产引用。
 * 不读数据库、不调用模型；上下文与任务编排由 storyboard-audit 服务注入。
 */
import { extractDrafts, type CastMember } from './dialogue-lines.js'
import {
  formatDialogueIntegrityIssue,
  inspectDialogueIntegrity,
} from './dialogue-integrity.js'

export type AuditCheck = 1 | 2 | 3 | 4 | 5
export type AuditSeverity = 'error' | 'warning' | 'info'
export type AuditSource = 'rule' | 'semantic' | 'rule+semantic'
export type AuditIssueStatus = 'open' | 'fixed' | 'manual' | 'stale' | 'rolled_back'
export type TransitionSuggestion = 'empty' | 'scene' | 'text'

export const CHARS_PER_SECOND = 4
export const LINE_BREATH_SECONDS = 1
export const LINE_REQUIRED_MAX_SECONDS = 6
export const LINE_SHORT_ERROR_GAP_MS = 1000
export const LINE_OVERLONG_GAP_MS = 3000
export const SILENT_WITH_CHARACTER_WARN_MS = 8000
export const SILENT_WITH_CHARACTER_ERROR_MS = 12000
export const EMPTY_SHOT_WARN_MS = 6000
export const PROMPT_SEGMENT_MAX_CHARS = 12
export const SEMANTIC_WINDOW_SIZE = 16
export const SEMANTIC_WINDOW_STEP = 15
export const MAX_SEMANTIC_WINDOWS = 20
export const MAX_AUDIT_ISSUES = 400
export const MAX_WINDOW_SEMANTIC_ISSUES = 30

export const AUDIT_TRANSITION_KINDS: readonly TransitionSuggestion[] = ['empty', 'scene', 'text']

export const AUDIT_RULE_CODES_BY_CHECK: Record<AuditCheck, readonly string[]> = {
  1: [
    'shot_missing_description',
    'shot_missing_video_prompt',
    'shot_missing_camera_fields',
    'description_multiple_subshots',
    'prompt_missing_header',
    'prompt_blocking_missing',
    'prompt_negative_missing',
    'prompt_timeline_broken',
    'prompt_dialogue_mismatch',
    'prompt_segment_too_long',
    'prompt_segment_duration_invalid',
    'prompt_action_in_dialogue',
    'speaker_unbound',
    'speaker_unknown',
  ],
  2: [
    'continuity_missing',
    'cross_scene_cut_without_continuity',
    'adjacent_time_jump',
    'screen_direction_flip',
    'set_mirror',
    'axis_cross',
    'scene_geography_mismatch',
    'cast_presence_break',
    'foreground_shoulder_missing',
    'coverage_gap',
  ],
  3: ['silent_shot_long', 'empty_shot_long'],
  4: [
    'line_insufficient_duration',
    'line_requires_split',
    'line_overlong_duration',
    'shot_dialogue_over_capacity',
  ],
  5: [
    'scene_binding_missing',
    'scene_binding_invalid',
    'scene_not_linked',
    'character_binding_invalid',
    'character_not_linked',
    'prop_binding_invalid',
    'prop_not_linked',
    'binding_duplicate',
    'reference_character_unbound',
    'reference_character_unknown',
    'character_asset_missing',
    'scene_asset_missing',
    'prop_asset_missing',
    'asset_reference_malformed',
    'asset_file_missing',
  ],
}

export const AUDIT_SEMANTIC_CODE_BY_CHECK: Record<string, AuditCheck> = {
  semantic_shot_description: 1,
  semantic_continuity_break: 2,
  semantic_asset_mismatch: 5,
}

export interface AuditShotInput {
  id: number
  storyboardNumber: number
  duration: number
  description: string | null
  videoPrompt: string | null
  shotType: string | null
  angle: string | null
  movement: string | null
  continuity: string | null
  transition: string | null
  time: string | null
  transitionKind: string | null
  sceneId: number | null
  location: string | null
  referenceImages: string | null
  characterIds: number[]
  propIds: number[]
}

export interface AuditLineInput {
  id?: number | null
  storyboardId?: number | null
  lineNo?: number | null
  speakerType?: string | null
  speakerName?: string | null
  characterId?: number | null
  text?: string | null
  speakText?: string | null
  audioDurationMs?: number | null
  plannedStartMs?: number | null
  plannedEndMs?: number | null
  voiceDurationMs?: number | null
}

export interface AuditAssetRecord {
  id: number
  dramaId: number
  name: string
  imageUrl?: string | null
  deletedAt?: string | null
}

export type AuditCharacterAsset = AuditAssetRecord
export type AuditSceneAsset = AuditAssetRecord
export type AuditPropAsset = AuditAssetRecord

export interface AuditAssetCatalog {
  characters: AuditCharacterAsset[]
  scenes: AuditSceneAsset[]
  props: AuditPropAsset[]
  episodeCharacterIds: number[]
  episodeSceneIds: number[]
  episodePropIds: number[]
  fileExists?: (relativePath: string) => boolean
}

export interface AuditRuleChecks {
  shot: boolean
  continuity: boolean
  silent: boolean
  lineDuration: boolean
  assets: boolean
}

export interface AuditRuleThresholds {
  charsPerSecond: number
  lineBreathSeconds: number
  lineRequiredMaxSeconds: number
  silentCharacterWarnMs: number
  silentCharacterErrorMs: number
  emptyShotWarnMs: number
  promptSegmentMaxChars: number
}

export interface AuditRuleOptions {
  checks?: Partial<AuditRuleChecks>
  thresholds?: Partial<AuditRuleThresholds>
}

export interface AuditWindowOptions {
  size: number
  step: number
  maxWindows: number
}

export interface StoryboardRuleInput {
  dramaId: number
  shots: AuditShotInput[]
  lines: AuditLineInput[]
  cast: CastMember[]
  assets: AuditAssetCatalog
  options?: AuditRuleOptions
}

export interface AuditIssueDraft {
  check: AuditCheck
  source: AuditSource
  severity: AuditSeverity
  code: string
  storyboardId: number
  storyboardNumber: number
  lineId?: number | null
  relatedStoryboardIds?: number[]
  message: string
  evidence?: string
  suggestion?: string
  repairable: boolean
  repairAction?: string | null
  suggestedTransition?: TransitionSuggestion | null
  status?: AuditIssueStatus
  windowIndex?: number | null
}

export interface AuditIssue extends AuditIssueDraft {
  id: string
}

export interface ParsedPromptSegment {
  index: number
  startSec: number
  endSec: number
  text: string
}

export interface AuditWindowTarget {
  id: number
  storyboardNumber: number
}

export interface AuditWindowPlan {
  index: number
  targets: AuditWindowTarget[]
  contextBefore: AuditWindowTarget | null
  contextAfter: AuditWindowTarget | null
}

export interface AuditWindowPlanningResult {
  windows: AuditWindowPlan[]
  ruleOnlyIds: number[]
  truncated: boolean
}

export interface AuditLimitOptions {
  maxTotal?: number
  maxPerWindow?: number
}

export interface AuditLimitResult {
  issues: AuditIssueDraft[]
  truncated: boolean
  truncatedWindows: number
}

const PROMPT_TIME_RE = /(?:^|\n)[ \t]*(\d+(?:\.\d+)?)\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s|초)\s*[：:]?/gi
const PROMPT_TIME_LINE_RE = /^\s*\d+(?:\.\d+)?\s*[-–—~～至]\s*\d+(?:\.\d+)?\s*(?:秒|s|초)\s*[：:]?/i
const HEADER_START_RE = /^(?:出场人物|登场人物|登場人物|人物|characters?|인물|등장인물)\s*[：:@]/i
const HEADER_SCENE_RE = /(?:[｜|／/]\s*)?(?:场景|scene|シーン|장면)\s*[：:@]/i
const SUB_SHOT_RE = /【\s*镜头\s*\d+\s*】/
const PLACEHOLDER_RE = /^(?:待补充|待定|待完善|暂无|无|略|同上|tbd|todo|null|undefined|na|n\/a|[-—–…]+)$/i
const MENTION_TOKEN_RE = /@([^\s@，。、；：:,.!?！？｜|／/（）()【】\[\]「」『』《》<>…—–~～]+)/gu
const EXTERNAL_IMAGE_RE = /^(?:(?:https?:)?\/\/|data:)/i
const HIGH_CONFIDENCE_ACTION_RE = /(镜头(?:推近|拉远|推进|拉出|摇|移|跟|升|降|切换|特写)|特写镜头|近景|中景|全景|远景|俯拍|仰拍|航拍|空镜|画面(?:切|转|淡)|切黑|黑场|满脸[^，。！？\s]{0,6}(?:激愤|愤怒|震惊|惊讶|失望|悲伤|喜悦|笑意)|不由(?:地)?[^，。！？\s]{0,6}(?:相视|对视|皱眉|叹气|笑了|落泪|后退|握拳)|忍不住[^，。！？\s]{0,6}(?:相视|对视|笑了|哭|叹气)|相视一笑|对视一眼|握紧拳头|攥紧拳头|眉头(?:一皱|紧锁|微皱)|嘴角(?:微扬|上扬|抽搐)|眼神(?:一暗|闪躲|游移)|叹了口气|点了点头|摇了摇头|转身(?:离开|离去|就走))/

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function isBlank(value: string | null | undefined): boolean {
  return !value || !value.trim()
}

function severityRank(severity: AuditSeverity): number {
  return severity === 'error' ? 3 : severity === 'warning' ? 2 : 1
}

function moreSevere(left: AuditSeverity, right: AuditSeverity): AuditSeverity {
  return severityRank(right) > severityRank(left) ? right : left
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function formatSeconds(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function clip(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function mergeEvidence(first: string | undefined, second: string | undefined): string {
  const left = (first || '').trim()
  const right = (second || '').trim()
  if (!left) return clip(right)
  if (!right || left.includes(right)) return clip(left)
  return clip(`${left}；${right}`)
}

/** 高置信度的运镜/表情/动作描述，修复时允许把误当台词的这类文本移出对话 */
export function looksLikeActionDescription(text: string | null | undefined): boolean {
  return Boolean(text && HIGH_CONFIDENCE_ACTION_RE.test(text))
}

export function countPronounceableChars(text: string | null | undefined): number {
  if (!text) return 0
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length
}

export function requiredLineDurationMs(
  text: string | null | undefined,
  options: Pick<Partial<AuditRuleThresholds>, 'charsPerSecond' | 'lineBreathSeconds'> = {},
): number {
  const chars = countPronounceableChars(text)
  const charsPerSecond = options.charsPerSecond ?? CHARS_PER_SECOND
  const breath = options.lineBreathSeconds ?? LINE_BREATH_SECONDS
  const seconds = round1(chars / charsPerSecond + breath)
  return Math.round(seconds * 1000)
}

function resolvedThresholds(options: AuditRuleOptions | undefined): AuditRuleThresholds {
  const input = options?.thresholds ?? {}
  return {
    charsPerSecond: input.charsPerSecond ?? CHARS_PER_SECOND,
    lineBreathSeconds: input.lineBreathSeconds ?? LINE_BREATH_SECONDS,
    lineRequiredMaxSeconds: input.lineRequiredMaxSeconds ?? LINE_REQUIRED_MAX_SECONDS,
    silentCharacterWarnMs: input.silentCharacterWarnMs ?? SILENT_WITH_CHARACTER_WARN_MS,
    silentCharacterErrorMs: input.silentCharacterErrorMs ?? SILENT_WITH_CHARACTER_ERROR_MS,
    emptyShotWarnMs: input.emptyShotWarnMs ?? EMPTY_SHOT_WARN_MS,
    promptSegmentMaxChars: input.promptSegmentMaxChars ?? PROMPT_SEGMENT_MAX_CHARS,
  }
}

function isPlaceholderDescription(text: string): boolean {
  const compact = text.trim().replace(/[\s。．.！!？?；;，,、]/g, '')
  return !compact || PLACEHOLDER_RE.test(compact)
}

export function parsePromptSegments(videoPrompt: string | null | undefined): ParsedPromptSegment[] {
  // 负面约束是独立分区，不属于任何时间帧；必须先截掉，否则会被算成台词/旁白
  const raw = String(videoPrompt || '').replace(/\r\n?/g, '\n')
  const negativeStart = raw.search(/\n\s*(?:负面约束|Negative constraints|ネガティブ制約|네거티브 제약)\s*[：:]/i)
  const text = negativeStart >= 0 ? raw.slice(0, negativeStart) : raw
  const marks: { index: number; bodyStart: number; startSec: number; endSec: number }[] = []
  const re = new RegExp(PROMPT_TIME_RE.source, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    marks.push({
      index: match.index,
      bodyStart: match.index + match[0].length,
      startSec: Number(match[1]),
      endSec: Number(match[2]),
    })
  }
  return marks.map((mark, index) => ({
    index: index + 1,
    startSec: mark.startSec,
    endSec: mark.endSec,
    text: text.slice(mark.bodyStart, index + 1 < marks.length ? marks[index + 1].index : text.length).trim(),
  }))
}

export interface ParsedPromptSections {
  hasBlockingMarker: boolean
  blocking: string
  hasSoundMarker: boolean
  sound: string
  hasNegativeMarker: boolean
  negative: string
}

/** 解析固定分区里的「画面调度」「负面约束」；旧格式没有这两个标记时不报缺失。 */
export function parsePromptSections(videoPrompt: string | null | undefined): ParsedPromptSections {
  const lines = String(videoPrompt || '').replace(/\r\n?/g, '\n').split('\n')
  const blockingRe = /^\s*(?:画面调度|Blocking|画面演出|화면 연출)\s*[：:]\s*(.*)$/i
  const soundRe = /^\s*(?:声音|Sound|音響|사운드)\s*[：:]\s*(.*)$/i
  const negativeRe = /^\s*(?:负面约束|Negative constraints|ネガティブ制約|네거티브 제약)\s*[：:]\s*(.*)$/i
  let hasBlockingMarker = false
  let blocking = ''
  let hasSoundMarker = false
  let sound = ''
  let hasNegativeMarker = false
  let negative = ''
  for (const line of lines) {
    const blockingMatch = blockingRe.exec(line)
    if (blockingMatch) {
      hasBlockingMarker = true
      if (!blocking) blocking = blockingMatch[1].trim()
      continue
    }
    const soundMatch = soundRe.exec(line)
    if (soundMatch) {
      hasSoundMarker = true
      if (!sound) sound = soundMatch[1].trim()
      continue
    }
    const negativeMatch = negativeRe.exec(line)
    if (negativeMatch) {
      hasNegativeMarker = true
      if (!negative) negative = negativeMatch[1].trim()
    }
  }
  return { hasBlockingMarker, blocking, hasSoundMarker, sound, hasNegativeMarker, negative }
}

export function hasVideoPromptHeader(videoPrompt: string | null | undefined): boolean {
  const firstLine = (videoPrompt || '').trimStart().split(/\r?\n/, 1)[0]?.trim() || ''
  if (!firstLine || PROMPT_TIME_LINE_RE.test(firstLine)) return false
  return HEADER_START_RE.test(firstLine) && HEADER_SCENE_RE.test(firstLine)
}

function effectiveLineDurationMs(line: AuditLineInput): number | null {
  if ((line.audioDurationMs ?? 0) > 0) return line.audioDurationMs as number
  if (line.plannedStartMs != null && line.plannedEndMs != null) {
    const planned = line.plannedEndMs - line.plannedStartMs
    if (planned > 0) return planned
  }
  if ((line.voiceDurationMs ?? 0) > 0) return line.voiceDurationMs as number
  return null
}

function lineSourceText(line: AuditLineInput): string {
  return line.speakText && line.speakText.trim() ? line.speakText : (line.text || '')
}

function sceneKey(shot: AuditShotInput): string {
  if (shot.sceneId != null) return `id:${shot.sceneId}`
  const location = (shot.location || '').trim().toLowerCase()
  return location ? `loc:${location}` : ''
}

function normalizeTransition(value: string | null | undefined): string {
  return (value || 'cut').trim().toLowerCase()
}

const TIME_OF_DAY_BUCKETS: Array<{ rank: number; pattern: RegExp }> = [
  { rank: 1, pattern: /凌晨|黎明|拂晓|破晓/ },
  { rank: 2, pattern: /清晨|早晨|早上|一早|晨/ },
  { rank: 3, pattern: /上午/ },
  { rank: 4, pattern: /中午|午间|午时|正午|晌午/ },
  { rank: 5, pattern: /下午|午后/ },
  { rank: 6, pattern: /傍晚|黄昏|日落|薄暮/ },
  { rank: 7, pattern: /夜晚|晚上|夜里|夜间|深夜|午夜|入夜|夜/ },
]

/** 只识别明确的时段词；日/白天等泛化值不参与判断，避免把普通日夜场景当成跳时。 */
function timeOfDayRank(value: string | null | undefined): number | null {
  const text = (value || '').trim()
  if (!text) return null
  for (const bucket of TIME_OF_DAY_BUCKETS) {
    if (bucket.pattern.test(text)) return bucket.rank
  }
  return null
}

function isExternalImage(value: string): boolean {
  return EXTERNAL_IMAGE_RE.test(value.trim())
}

function cleanMentionToken(token: string): string {
  return token
    .replace(/(?:说|道|问|喊|答|嘟囔|自语|吼|叫|低声|轻声|冷声|沉声|笑|看向|望着)+$/u, '')
    .trim()
}

function mentionTokens(text: string): string[] {
  const tokens: string[] = []
  const re = new RegExp(MENTION_TOKEN_RE.source, 'gu')
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) tokens.push(match[1])
  return unique(tokens)
}

function pushIssue(
  issues: AuditIssueDraft[],
  shot: AuditShotInput,
  issue: Omit<AuditIssueDraft, 'storyboardId' | 'storyboardNumber' | 'source' | 'status'> & {
    source?: AuditSource
    status?: AuditIssueStatus
  },
) {
  issues.push({
    ...issue,
    source: issue.source ?? 'rule',
    status: issue.status ?? 'open',
    storyboardId: shot.id,
    storyboardNumber: shot.storyboardNumber,
  })
}

function checkShotFields(
  shot: AuditShotInput,
  issues: AuditIssueDraft[],
  cast: CastMember[],
  shotLines: AuditLineInput[],
  thresholds: AuditRuleThresholds,
) {
  if (isBlank(shot.description) || isPlaceholderDescription(shot.description || '')) {
    pushIssue(issues, shot, {
      check: 1,
      severity: 'error',
      code: 'shot_missing_description',
      message: '画面描述为空或只有占位词，无法判断动作、表情与旁白位置。',
      evidence: clip((shot.description || '').trim()),
      suggestion: '补写谁在做什么、肢体细节、表情、视线和结果。',
      repairable: false,
    })
  } else if ((((shot.description || '').match(/【镜头\s*\d+】/g)) || []).length > 1) {
    pushIssue(issues, shot, {
      check: 1,
      severity: 'error',
      code: 'description_multiple_subshots',
      message: '一个分镜里出现了多个【镜头N】子镜头；新规则要求一个分镜 = 一个机位/一个主体/一个连续动作。',
      evidence: clip(shot.description || ''),
      suggestion: '把每个【镜头N】拆成独立分镜，保留各自的机位、主体和连续动作；不要在一个分镜里切镜。',
      repairable: false,
    })
  }

  const missingCamera = [
    isBlank(shot.shotType) ? '景别' : '',
    isBlank(shot.angle) ? '角度' : '',
    isBlank(shot.movement) ? '运镜' : '',
  ].filter(Boolean)
  if (missingCamera.length) {
    pushIssue(issues, shot, {
      check: 1,
      severity: 'warning',
      code: 'shot_missing_camera_fields',
      message: `分镜缺少${missingCamera.join('、')}描述。`,
      evidence: `shot_type=${shot.shotType || ''}；angle=${shot.angle || ''}；movement=${shot.movement || ''}`,
      suggestion: '从画面描述和视频提示词中归纳景别、角度与运镜，不新增剧情。',
      repairable: true,
      repairAction: 'fill_camera_fields',
    })
  }

  if (isBlank(shot.videoPrompt)) {
    pushIssue(issues, shot, {
      check: 1,
      severity: 'error',
      code: 'shot_missing_video_prompt',
      message: '视频提示词为空，无法生成视频。',
      suggestion: '先补齐该镜的视频提示词再重新检验。',
      repairable: false,
    })
  } else {
    checkVideoPrompt(shot, shot.videoPrompt || '', issues, cast, thresholds)
  }

  checkSpeakers(shot, shotLines, issues, cast)
}

function checkVideoPrompt(
  shot: AuditShotInput,
  prompt: string,
  issues: AuditIssueDraft[],
  cast: CastMember[],
  thresholds: AuditRuleThresholds,
) {
  if (!hasVideoPromptHeader(prompt)) {
    pushIssue(issues, shot, {
      check: 1,
      severity: 'warning',
      code: 'prompt_missing_header',
      message: '视频提示词第一行不是「出场人物：…｜场景：…」信息头。',
      evidence: clip(prompt.split(/\r?\n/, 1)[0] || ''),
      suggestion: '把信息头补为第一行，角色和场景继续使用 @引用。',
      repairable: true,
      repairAction: 'normalize_video_prompt',
    })
  }

  const sections = parsePromptSections(prompt)
  const fixedFormat = sections.hasBlockingMarker || sections.hasNegativeMarker
  if (fixedFormat && (!sections.hasBlockingMarker || !sections.blocking)) {
    pushIssue(issues, shot, {
      check: 1,
      severity: 'warning',
      code: 'prompt_blocking_missing',
      message: '固定分区提示词缺少「画面调度」：没有写清屏幕左右、过肩和背景地标。',
      evidence: clip(prompt.split(/\r?\n/, 1)[0] || ''),
      suggestion: '在提示词分区里补「画面调度：画面左…、画面右…、过谁的肩、窗/门/桌在哪」。',
      repairable: false,
    })
  }
  if (fixedFormat && (!sections.hasNegativeMarker || !sections.negative)) {
    pushIssue(issues, shot, {
      check: 1,
      severity: 'warning',
      code: 'prompt_negative_missing',
      message: '固定分区提示词缺少「负面约束」：画内人物、加人、字幕和现代物品没有约束。',
      evidence: clip(prompt.split(/\r?\n/, 1)[0] || ''),
      suggestion: '在提示词分区里补「负面约束：只出现画内人物；不换脸/换装/加人；不生成字幕；不出现现代物品」。',
      repairable: false,
    })
  }

  const segments = parsePromptSegments(prompt)
  const timelineProblems: string[] = []
  if (!segments.length) {
    timelineProblems.push('未找到从「0-3秒」开始的时间分段')
  } else {
    const first = segments[0]
    const firstDuration = first.endSec - first.startSec
    if (first.startSec !== 0 || firstDuration < 1 || firstDuration > 6) {
      timelineProblems.push(`首段应从 0 秒开始、时长 1-6 秒，实际 ${formatSeconds(first.startSec)}-${formatSeconds(first.endSec)} 秒`)
    }
    for (let index = 1; index < segments.length; index += 1) {
      const previous = segments[index - 1]
      const current = segments[index]
      if (Math.abs(current.startSec - previous.endSec) > 0.01) {
        timelineProblems.push(current.startSec < previous.endSec
          ? `第 ${index + 1} 段时间与上一段重叠`
          : `第 ${index + 1} 段与上一段之间有空档`)
      }
    }
    for (const segment of segments) {
      if (segment.endSec <= segment.startSec) {
        timelineProblems.push(`第 ${segment.index} 段结束时间不大于开始时间`)
      }
    }
    const last = segments[segments.length - 1]
    if (shot.duration > 0 && Math.abs(last.endSec - shot.duration) > 0.01) {
      timelineProblems.push(`最后一段结束 ${formatSeconds(last.endSec)} 秒与镜头时长 ${formatSeconds(shot.duration)} 秒不一致`)
    }
  }
  if (timelineProblems.length) {
    pushIssue(issues, shot, {
      check: 1,
      severity: 'warning',
      code: 'prompt_timeline_broken',
      message: `视频提示词时间轴不连续或与镜头时长不一致：${timelineProblems.join('；')}`,
      evidence: clip(timelineProblems.join('；')),
      suggestion: '从 0 秒起连续分段，每段 1-6 秒，时间不重叠不留空，最后一段结束等于镜头时长。',
      repairable: true,
      repairAction: 'normalize_video_prompt',
    })
  }

  const invalidDurations = segments.filter((segment) => {
    const duration = segment.endSec - segment.startSec
    return duration < 1 || duration > 6
  })
  if (invalidDurations.length) {
    pushIssue(issues, shot, {
      check: 1,
      severity: 'warning',
      code: 'prompt_segment_duration_invalid',
      message: '视频提示词存在小于 1 秒或大于 6 秒的时间段。',
      evidence: clip(invalidDurations
        .map(segment => `${formatSeconds(segment.startSec)}-${formatSeconds(segment.endSec)} 秒（${formatSeconds(segment.endSec - segment.startSec)} 秒）`)
        .join('；')),
      suggestion: '把每段调到 1-6 秒；调整后保持时间轴连续，最后一段结束等于镜头时长。',
      repairable: false,
    })
  }

  const dialogueIntegrity = inspectDialogueIntegrity(shot.description, prompt)
  if (dialogueIntegrity && !dialogueIntegrity.ok) {
    pushIssue(issues, shot, {
      check: 1,
      severity: 'error',
      code: 'prompt_dialogue_mismatch',
      message: '视频提示词没有逐字保留画面描述中的台词/旁白：存在压缩、删字、改字或丢失标点。',
      evidence: clip(`${formatDialogueIntegrityIssue(dialogueIntegrity, '')}；原文：${dialogueIntegrity.expected}`),
      suggestion: '从 description 对应【镜头N】逐字复制台词和全部标点；3 秒分段只拆分、不压缩，长句在原文标点或语义停顿处拆到相邻段。',
      repairable: true,
      repairAction: 'normalize_video_prompt',
    })
  }

  const overlongSegments: string[] = []
  const actionInDialogue: string[] = []
  const charsPerSecond = thresholds.promptSegmentMaxChars / 3
  for (const segment of segments) {
    const drafts = extractDrafts(segment.text, cast)
    const spokenChars = drafts.reduce((sum, draft) => sum + countPronounceableChars(draft.text), 0)
    const segmentSeconds = Math.max(0, segment.endSec - segment.startSec)
    const capacity = Math.max(1, Math.round(segmentSeconds * charsPerSecond))
    if (spokenChars > capacity) {
      overlongSegments.push(`${formatSeconds(segment.startSec)}-${formatSeconds(segment.endSec)} 秒共 ${spokenChars} 字（容量 ${capacity} 字）`)
    }
    for (const draft of drafts) {
      if (HIGH_CONFIDENCE_ACTION_RE.test(draft.text)) {
        actionInDialogue.push(`${formatSeconds(segment.startSec)}-${formatSeconds(segment.endSec)} 秒 ${draft.name || '台词'}：${draft.text}`)
      }
    }
  }
  if (overlongSegments.length) {
    pushIssue(issues, shot, {
      check: 1,
      severity: 'warning',
      code: 'prompt_segment_too_long',
      message: '视频提示词某个时间段的台词/旁白超过该段容量（4 字/秒）。',
      evidence: clip(unique(overlongSegments).join('；')),
      suggestion: '在原文标点或语义停顿处把长句拆到相邻时间段/分镜，或延长该段时长；保留全部文字与标点；自动修复不改台词。',
      repairable: false,
    })
  }
  if (actionInDialogue.length) {
    pushIssue(issues, shot, {
      check: 1,
      severity: 'warning',
      code: 'prompt_action_in_dialogue',
      message: '台词或旁白里出现了运镜、景别、表情、心理或动作描述，可能被视频模型当成台词念出。',
      evidence: clip(unique(actionInDialogue).join('；')),
      suggestion: '把动作、表情和运镜移回画面描述，台词只保留角色实际说出的内容。',
      repairable: true,
      repairAction: 'normalize_video_prompt',
    })
  }
}

function checkSpeakers(
  shot: AuditShotInput,
  shotLines: AuditLineInput[],
  issues: AuditIssueDraft[],
  cast: CastMember[],
) {
  const castById = new Map<number, CastMember>()
  const castByName = new Map<string, CastMember>()
  for (const member of cast) {
    if (!member.name) continue
    if (member.id != null) castById.set(member.id, member)
    if (!castByName.has(member.name)) castByName.set(member.name, member)
  }
  const boundIds = new Set(shot.characterIds)

  for (const line of shotLines) {
    if ((line.speakerType || 'dialogue') !== 'dialogue') continue
    if (isBlank(line.text)) continue
    const byId = line.characterId != null ? castById.get(line.characterId) : undefined
    const byName = line.speakerName ? castByName.get(line.speakerName) : undefined
    const member = byId ?? byName
    if (member?.id != null && boundIds.has(member.id)) continue
    if (member) {
      pushIssue(issues, shot, {
        check: 1,
        severity: 'info',
        code: 'speaker_unbound',
        lineId: line.id ?? null,
        message: `说话人「${member.name}」在本集角色列表内，但没有绑定到该分镜，请确认是否为画外音或补充绑定。`,
        evidence: clip(line.text || ''),
        suggestion: '人工确认是否需要把该角色绑定到本分镜；系统不会自动改绑定。',
        repairable: false,
      })
    } else {
      pushIssue(issues, shot, {
        check: 1,
        severity: 'warning',
        code: 'speaker_unknown',
        lineId: line.id ?? null,
        message: `说话人「${line.speakerName || '未知'}」不在本集角色列表，请确认说话人或先创建角色。`,
        evidence: clip(line.text || ''),
        suggestion: '人工处理：绑定到本集角色、改为旁白或修正说话人。',
        repairable: false,
      })
    }
  }
}

function checkContinuity(shots: AuditShotInput[], issues: AuditIssueDraft[], bridgedPairs: Set<string>) {
  for (let index = 1; index < shots.length; index += 1) {
    const shot = shots[index]
    const previous = shots[index - 1]
    if (bridgedPairs.has(`${previous.id}:${shot.id}`)) continue
    const previousRank = timeOfDayRank(previous.time)
    const currentRank = timeOfDayRank(shot.time)
    if (normalizeTransition(shot.transition) === 'cut'
      && previousRank != null
      && currentRank != null
      && Math.abs(currentRank - previousRank) >= 2) {
      pushIssue(issues, shot, {
        check: 2,
        severity: 'info',
        code: 'adjacent_time_jump',
        relatedStoryboardIds: [previous.id],
        message: `相邻两镜时间从「${(previous.time || '').trim()}」直接硬切到「${(shot.time || '').trim()}」，成对判定会重点核对这里是否需要过渡。`,
        evidence: `上一镜：第 ${previous.storyboardNumber} 镜「${(previous.time || '').trim()}」；本镜：第 ${shot.storyboardNumber} 镜「${(shot.time || '').trim()}」；转场：cut`,
        suggestion: '等待成对判定结论；只有判定 broken 时才会按建议插入过渡分镜。',
        repairable: false,
        repairAction: null,
        suggestedTransition: null,
      })
    }
    if (!isBlank(shot.continuity)) continue
    pushIssue(issues, shot, {
      check: 2,
      severity: 'warning',
      code: 'continuity_missing',
      relatedStoryboardIds: [previous.id],
      message: '第二镜及之后的分镜没有填写 continuity，无法确认与上一镜的尾动作、视线和站位是否承接。',
      evidence: `上一镜：${previous.storyboardNumber}；本镜：${shot.storyboardNumber}`,
      suggestion: '补写本镜如何承接上一镜的尾动作、视线方向、人物站位和道具位置。',
      repairable: true,
      repairAction: 'fix_continuity',
    })
    const previousScene = sceneKey(previous)
    const currentScene = sceneKey(shot)
    if (normalizeTransition(shot.transition) === 'cut'
      && previousScene
      && currentScene
      && previousScene !== currentScene) {
      pushIssue(issues, shot, {
        check: 2,
        severity: 'warning',
        code: 'cross_scene_cut_without_continuity',
        relatedStoryboardIds: [previous.id],
        message: '相邻两镜场景不同、使用硬切且没有 continuity，可能缺少跨场景承接。',
        evidence: `上一镜场景：${previous.sceneId ?? previous.location ?? '未指定'}；本镜场景：${shot.sceneId ?? shot.location ?? '未指定'}`,
        suggestion: '补充跨场景承接说明，或考虑在断点添加过渡镜头。',
        repairable: true,
        repairAction: 'fix_continuity',
      })
    }
  }
}

function checkSilentShots(
  shots: AuditShotInput[],
  linesByShot: Map<number, AuditLineInput[]>,
  issues: AuditIssueDraft[],
  thresholds: AuditRuleThresholds,
) {
  for (const shot of shots) {
    const durationMs = Math.round(shot.duration * 1000)
    if (durationMs <= 0) continue
    const shotLines = linesByShot.get(shot.id) ?? []
    if (shotLines.some((line) => !isBlank(line.text))) continue
    if (shot.characterIds.length > 0) {
      if (durationMs >= thresholds.silentCharacterErrorMs) {
        pushIssue(issues, shot, {
          check: 3,
          severity: 'error',
          code: 'silent_shot_long',
          message: `镜头时长 ${formatSeconds(shot.duration)} 秒且没有任何台词/旁白，有角色出镜但长时间无对话。`,
          suggestion: '补充台词或旁白，或者缩短、拆分该镜头；这属于创作决策，需要人工处理。',
          repairable: false,
        })
      } else if (durationMs >= thresholds.silentCharacterWarnMs) {
        pushIssue(issues, shot, {
          check: 3,
          severity: 'warning',
          code: 'silent_shot_long',
          message: `镜头时长 ${formatSeconds(shot.duration)} 秒且没有任何台词/旁白，有角色出镜但长时间无对话。`,
          suggestion: '确认这段无对话是否必要；如需保留，考虑缩短或拆分镜头。',
          repairable: false,
        })
      }
    } else if (durationMs >= thresholds.emptyShotWarnMs) {
      pushIssue(issues, shot, {
        check: 3,
        severity: 'warning',
        code: 'empty_shot_long',
        message: `镜头时长 ${formatSeconds(shot.duration)} 秒且没有任何台词/旁白，属于长时间空镜。`,
        suggestion: '确认空镜时长是否必要；如需保留，考虑缩短或拆分镜头。',
        repairable: false,
      })
    }
  }
}

function checkLineDurations(
  shots: AuditShotInput[],
  linesByShot: Map<number, AuditLineInput[]>,
  issues: AuditIssueDraft[],
  thresholds: AuditRuleThresholds,
) {
  for (const shot of shots) {
    const shotLines = (linesByShot.get(shot.id) ?? [])
      .filter((line) => !isBlank(line.text))
      .sort((left, right) => (left.lineNo ?? 0) - (right.lineNo ?? 0) || (left.id ?? 0) - (right.id ?? 0))
    let totalChars = 0
    const lineSummary: string[] = []

    for (const line of shotLines) {
      const sourceText = lineSourceText(line)
      const chars = countPronounceableChars(sourceText)
      if (chars === 0) continue
      totalChars += chars
      const requiredMs = requiredLineDurationMs(sourceText, thresholds)
      const effectiveMs = effectiveLineDurationMs(line)
      const requiredSeconds = requiredMs / 1000
      const effectiveSeconds = effectiveMs == null ? null : effectiveMs / 1000
      lineSummary.push(`${line.speakerName || '未知'}：${requiredSeconds.toFixed(1)} 秒`)
      const textEvidence = clip(line.text || sourceText, 200)

      // 派生台词是按提示词标点拆出来的片段，不能逐片段套 1 秒气口；
      // 片段级时长只对数据库中的真实台词行判断，整镜容量统一在下面按总字数计算。
      if (line.id != null && effectiveMs != null) {
        const gapMs = requiredMs - effectiveMs
        if (gapMs > 0) {
          const gapSeconds = gapMs / 1000
          const severity: AuditSeverity = gapMs > LINE_SHORT_ERROR_GAP_MS ? 'error' : 'warning'
          pushIssue(issues, shot, {
            check: 4,
            severity,
            code: 'line_insufficient_duration',
            lineId: line.id ?? null,
            message: `这一句有效时长 ${effectiveSeconds?.toFixed(1)} 秒，少于需要的 ${requiredSeconds.toFixed(1)} 秒（${chars} 个可发音字符），缺口 ${gapSeconds.toFixed(1)} 秒。`,
            evidence: textEvidence,
            suggestion: '延长镜头或压缩台词；自动修复不会拆句、不会改台词文本。',
            repairable: false,
          })
        }
        if (effectiveMs - requiredMs >= LINE_OVERLONG_GAP_MS) {
          const extraSeconds = (effectiveMs - requiredMs) / 1000
          pushIssue(issues, shot, {
            check: 4,
            severity: 'warning',
            code: 'line_overlong_duration',
            lineId: line.id ?? null,
            message: `这一句有效时长 ${effectiveSeconds?.toFixed(1)} 秒，比需要的 ${requiredSeconds.toFixed(1)} 秒多 ${extraSeconds.toFixed(1)} 秒。`,
            evidence: textEvidence,
            suggestion: '压缩这一句的占时，或把长句拆分到相邻分镜。',
            repairable: false,
          })
        }
      }

      if (line.id != null && requiredMs > thresholds.lineRequiredMaxSeconds * 1000) {
        pushIssue(issues, shot, {
          check: 4,
          severity: 'warning',
          code: 'line_requires_split',
          lineId: line.id ?? null,
          message: `单句需要约 ${requiredSeconds.toFixed(1)} 秒（${chars} 个可发音字符），超过 ${thresholds.lineRequiredMaxSeconds} 秒，建议拆分。`,
          evidence: textEvidence,
          suggestion: '拆分为多句或拆分到相邻分镜；首版不自动改台词行结构。',
          repairable: false,
        })
      }
    }

    const totalRequiredMs = totalChars > 0
      ? Math.round((totalChars / thresholds.charsPerSecond + thresholds.lineBreathSeconds) * 1000)
      : 0
    if (shot.duration > 0 && totalRequiredMs > Math.round(shot.duration * 1000)) {
      pushIssue(issues, shot, {
        check: 4,
        severity: 'error',
        code: 'shot_dialogue_over_capacity',
        message: `本镜台词/旁白共需 ${(totalRequiredMs / 1000).toFixed(1)} 秒（${totalChars} 字，含 1 秒气口），超过镜头时长 ${formatSeconds(shot.duration)} 秒。`,
        evidence: clip(lineSummary.join('；')),
        suggestion: '延长镜头时长、减少台词或拆分到相邻分镜。',
        repairable: true,
        repairAction: 'extend_duration',
      })
    }
  }
}

function checkAssets(
  shot: AuditShotInput,
  issues: AuditIssueDraft[],
  input: StoryboardRuleInput,
) {
  const { assets, dramaId } = input
  const characterById = new Map(assets.characters.map((asset) => [asset.id, asset]))
  const sceneById = new Map(assets.scenes.map((asset) => [asset.id, asset]))
  const propById = new Map(assets.props.map((asset) => [asset.id, asset]))
  const episodeCharacters = new Set(assets.episodeCharacterIds)
  const episodeScenes = new Set(assets.episodeSceneIds)
  const episodeProps = new Set(assets.episodePropIds)

  const checkImage = (
    asset: AuditAssetRecord,
    kind: 'character' | 'scene' | 'prop',
  ) => {
    const imageUrl = (asset.imageUrl || '').trim()
    if (!imageUrl) {
      pushIssue(issues, shot, {
        check: 5,
        severity: 'warning',
        code: `${kind}_asset_missing`,
        message: `${kind === 'character' ? '角色' : kind === 'scene' ? '场景' : '道具'}「${asset.name}」没有资产图。`,
        evidence: `id=${asset.id}`,
        suggestion: '去资产页生成或补充资产图；检验面板不会直接触发生成。',
        repairable: false,
      })
      return
    }
    if (isExternalImage(imageUrl) || !assets.fileExists) return
    let exists = true
    try {
      exists = assets.fileExists(imageUrl)
    } catch {
      exists = true
    }
    if (!exists) {
      pushIssue(issues, shot, {
        check: 5,
        severity: 'warning',
        code: 'asset_file_missing',
        message: `${kind === 'character' ? '角色' : kind === 'scene' ? '场景' : '道具'}「${asset.name}」的图片文件不存在。`,
        evidence: imageUrl,
        suggestion: '去资产页重新上传或生成；外链不探测文件。',
        repairable: false,
      })
    }
  }

  if (shot.sceneId == null) {
    pushIssue(issues, shot, {
      check: 5,
      severity: 'warning',
      code: 'scene_binding_missing',
      message: '该分镜没有绑定场景，场景参考图与场景一致性无法保证。',
      suggestion: '在分镜资产面板选择或创建场景。',
      repairable: false,
    })
  } else {
    const scene = sceneById.get(shot.sceneId)
    if (!scene || scene.deletedAt || scene.dramaId !== dramaId) {
      pushIssue(issues, shot, {
        check: 5,
        severity: 'error',
        code: 'scene_binding_invalid',
        message: '分镜绑定的场景不存在、已删除或不属于当前项目。',
        evidence: `scene_id=${shot.sceneId}`,
        suggestion: '重新选择当前项目内未删除的场景。',
        repairable: false,
      })
    } else {
      if (!episodeScenes.has(scene.id)) {
        pushIssue(issues, shot, {
          check: 5,
          severity: 'info',
          code: 'scene_not_linked',
          message: `场景「${scene.name}」存在，但尚未关联到本集。`,
          evidence: `scene_id=${scene.id}`,
          suggestion: '跨集使用是允许的；保存分镜时会自动关联。',
          repairable: false,
        })
      }
      checkImage(scene, 'scene')
    }
  }

  const duplicatedCharacters = shot.characterIds.length !== unique(shot.characterIds).length
  const duplicatedProps = shot.propIds.length !== unique(shot.propIds).length
  if (duplicatedCharacters || duplicatedProps) {
    pushIssue(issues, shot, {
      check: 5,
      severity: 'warning',
      code: 'binding_duplicate',
      message: `${duplicatedCharacters ? '角色' : ''}${duplicatedCharacters && duplicatedProps ? '和' : ''}${duplicatedProps ? '道具' : ''}绑定存在重复，请人工确认。`,
      evidence: duplicatedCharacters ? `character_ids=${shot.characterIds.join(',')}` : `prop_ids=${shot.propIds.join(',')}`,
      suggestion: '系统不会自动删除重复绑定行。',
      repairable: false,
    })
  }

  const boundCharacterNames = new Set<string>()
  for (const characterId of unique(shot.characterIds)) {
    const character = characterById.get(characterId)
    if (!character || character.deletedAt || character.dramaId !== dramaId) {
      pushIssue(issues, shot, {
        check: 5,
        severity: 'error',
        code: 'character_binding_invalid',
        message: '分镜绑定的角色不存在、已删除或不属于当前项目。',
        evidence: `character_id=${characterId}`,
        suggestion: '重新选择当前项目内未删除的角色。',
        repairable: false,
      })
      continue
    }
    boundCharacterNames.add(character.name)
    if (!episodeCharacters.has(character.id)) {
      pushIssue(issues, shot, {
        check: 5,
        severity: 'info',
        code: 'character_not_linked',
        message: `角色「${character.name}」存在，但尚未关联到本集。`,
        evidence: `character_id=${character.id}`,
        suggestion: '跨集使用是允许的；保存分镜时会自动关联。',
        repairable: false,
      })
    }
    checkImage(character, 'character')
  }

  for (const propId of unique(shot.propIds)) {
    const prop = propById.get(propId)
    if (!prop || prop.deletedAt || prop.dramaId !== dramaId) {
      pushIssue(issues, shot, {
        check: 5,
        severity: 'error',
        code: 'prop_binding_invalid',
        message: '分镜绑定的道具不存在、已删除或不属于当前项目。',
        evidence: `prop_id=${propId}`,
        suggestion: '重新选择当前项目内未删除的道具。',
        repairable: false,
      })
      continue
    }
    if (!episodeProps.has(prop.id)) {
      pushIssue(issues, shot, {
        check: 5,
        severity: 'info',
        code: 'prop_not_linked',
        message: `道具「${prop.name}」存在，但尚未关联到本集。`,
        evidence: `prop_id=${prop.id}`,
        suggestion: '跨集使用是允许的；保存分镜时会自动关联。',
        repairable: false,
      })
    }
    checkImage(prop, 'prop')
  }

  checkReferenceImages(shot, issues)
  checkMentions(shot, issues, input, boundCharacterNames)
}

function checkReferenceImages(shot: AuditShotInput, issues: AuditIssueDraft[]) {
  const raw = (shot.referenceImages || '').trim()
  if (!raw) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    pushIssue(issues, shot, {
      check: 5,
      severity: 'warning',
      code: 'asset_reference_malformed',
      message: '分镜参考图字段不是合法 JSON 数组。',
      evidence: clip(raw, 200),
      suggestion: '修正 reference_images 为字符串数组；系统不会自动改字段。',
      repairable: false,
    })
    return
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
    pushIssue(issues, shot, {
      check: 5,
      severity: 'warning',
      code: 'asset_reference_malformed',
      message: '分镜参考图数组包含空元素或非字符串元素。',
      evidence: clip(raw, 200),
      suggestion: '修正 reference_images 为字符串数组；系统不会自动改字段。',
      repairable: false,
    })
  }
}

function checkMentions(
  shot: AuditShotInput,
  issues: AuditIssueDraft[],
  input: StoryboardRuleInput,
  boundCharacterNames: Set<string>,
) {
  const text = `${shot.description || ''}\n${shot.videoPrompt || ''}`
  if (!text.trim()) return
  const sameProjectAssets = [
    ...input.assets.characters,
    ...input.assets.scenes,
    ...input.assets.props,
  ].filter((asset) => asset.dramaId === input.dramaId && !asset.deletedAt)
  const validCharacters = input.assets.characters
    .filter((character) => character.dramaId === input.dramaId && !character.deletedAt)
  const charactersByName = new Map<string, AuditCharacterAsset[]>()
  for (const character of validCharacters) {
    const group = charactersByName.get(character.name) || []
    group.push(character)
    charactersByName.set(character.name, group)
  }

  const unboundNames = new Set<string>()
  const ambiguousNames = new Set<string>()
  for (const [name, group] of charactersByName) {
    if (!text.includes(`@${name}`)) continue
    if (group.length > 1) {
      ambiguousNames.add(name)
      continue
    }
    if (!boundCharacterNames.has(name)) unboundNames.add(name)
  }
  if (unboundNames.size || ambiguousNames.size) {
    const evidence = [
      unboundNames.size ? `未绑定：${[...unboundNames].join('、')}` : '',
      ambiguousNames.size ? `同名多角色：${[...ambiguousNames].join('、')}` : '',
    ].filter(Boolean).join('；')
    pushIssue(issues, shot, {
      check: 5,
      severity: 'warning',
      code: 'reference_character_unbound',
      message: ambiguousNames.size
        ? `@引用匹配到同名多角色（${[...ambiguousNames].join('、')}），请人工确认绑定。`
        : '@引用的角色在本项目中存在，但没有绑定到该分镜。',
      evidence,
      suggestion: '人工确认后补充或调整分镜角色绑定；系统不会自动改绑定。',
      repairable: false,
    })
  }

  const knownNames = unique(sameProjectAssets.map((asset) => asset.name))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  const unknownNames = new Set<string>()
  for (const token of mentionTokens(text)) {
    const cleaned = cleanMentionToken(token)
    if (!cleaned) continue
    if (knownNames.some((name) => cleaned === name || cleaned.startsWith(name))) continue
    unknownNames.add(cleaned)
  }
  if (unknownNames.size) {
    pushIssue(issues, shot, {
      check: 5,
      severity: 'warning',
      code: 'reference_character_unknown',
      message: '@引用的名称在本项目角色、场景和道具清单中都找不到。',
      evidence: [...unknownNames].join('、'),
      suggestion: '检查 @引用名称是否与资产清单完全一致；系统不会自动改引用。',
      repairable: false,
    })
  }
}

export function evaluateStoryboardRules(input: StoryboardRuleInput): AuditIssueDraft[] {
  const ordered = [...input.shots].sort((left, right) => (
    left.storyboardNumber - right.storyboardNumber || left.id - right.id
  ))
  // 过渡分镜是已有解决方案，不再作为检验对象；两侧真实分镜跨卡成对，由 AI 单独判定。
  const shots = ordered.filter((shot) => shot.transitionKind == null)
  const bridgedPairs = new Set<string>()
  let previousReal: AuditShotInput | null = null
  let previousRealIndex = -1
  for (let index = 0; index < ordered.length; index += 1) {
    const shot = ordered[index]
    if (shot.transitionKind != null) continue
    if (previousReal && index - previousRealIndex > 1) {
      bridgedPairs.add(`${previousReal.id}:${shot.id}`)
    }
    previousReal = shot
    previousRealIndex = index
  }
  const realIds = new Set(shots.map((shot) => shot.id))
  const linesByShot = new Map<number, AuditLineInput[]>()
  for (const line of input.lines) {
    if (line.storyboardId == null || !realIds.has(line.storyboardId)) continue
    const group = linesByShot.get(line.storyboardId) || []
    group.push(line)
    linesByShot.set(line.storyboardId, group)
  }

  const thresholds = resolvedThresholds(input.options)
  const checks = input.options?.checks ?? {}
  const issues: AuditIssueDraft[] = []
  if (checks.shot !== false) {
    for (const shot of shots) {
      checkShotFields(shot, issues, input.cast, linesByShot.get(shot.id) ?? [], thresholds)
    }
  }
  if (checks.continuity !== false) checkContinuity(shots, issues, bridgedPairs)
  if (checks.silent !== false) checkSilentShots(shots, linesByShot, issues, thresholds)
  if (checks.lineDuration !== false) checkLineDurations(shots, linesByShot, issues, thresholds)
  if (checks.assets !== false) {
    for (const shot of shots) {
      checkAssets(shot, issues, input)
    }
  }
  return dedupeAuditIssues(issues)
}

function ruleLocationKey(issue: AuditIssueDraft): string {
  return `${issue.check}|${issue.storyboardId}|${issue.lineId ?? ''}`
}

function ruleIssueKey(issue: AuditIssueDraft): string {
  return `${ruleLocationKey(issue)}|${issue.code}`
}

function semanticIssueKey(issue: AuditIssueDraft): string {
  const related = [...(issue.relatedStoryboardIds ?? [])].sort((left, right) => left - right).join(',')
  return `${issue.check}|${issue.storyboardId}|${related}|${issue.code}`
}

function mergeRuleDuplicate(target: AuditIssueDraft, incoming: AuditIssueDraft) {
  target.severity = moreSevere(target.severity, incoming.severity)
  target.evidence = mergeEvidence(target.evidence, incoming.evidence)
  target.suggestion = target.suggestion || incoming.suggestion
  target.suggestedTransition = target.suggestedTransition ?? incoming.suggestedTransition
  target.repairable = target.repairable || incoming.repairable
  target.repairAction = target.repairAction || incoming.repairAction
  target.windowIndex = target.windowIndex ?? incoming.windowIndex
  if (target.status !== 'manual' && incoming.status === 'manual') target.status = 'manual'
  if (target.source !== 'rule+semantic' && incoming.source === 'rule+semantic') target.source = 'rule+semantic'
}

export function dedupeAuditIssues(issues: AuditIssueDraft[]): AuditIssueDraft[] {
  const result: AuditIssueDraft[] = []
  const ruleKeys = new Map<string, number>()
  const ruleLocations = new Map<string, number>()
  const semanticKeys = new Map<string, AuditIssueDraft>()
  const semanticOrder: AuditIssueDraft[] = []

  for (const raw of issues) {
    const issue: AuditIssueDraft = { ...raw }
    if (issue.source === 'semantic') {
      const key = semanticIssueKey(issue)
      const existing = semanticKeys.get(key)
      if (!existing) {
        semanticKeys.set(key, issue)
        semanticOrder.push(issue)
        continue
      }
      if ((issue.evidence || '').length > (existing.evidence || '').length) {
        existing.evidence = issue.evidence
      }
      existing.severity = moreSevere(existing.severity, issue.severity)
      existing.suggestion = existing.suggestion || issue.suggestion
      existing.suggestedTransition = existing.suggestedTransition ?? issue.suggestedTransition
      existing.windowIndex = existing.windowIndex ?? issue.windowIndex
      continue
    }

    const key = ruleIssueKey(issue)
    const index = ruleKeys.get(key)
    if (index == null) {
      ruleKeys.set(key, result.length)
      const location = ruleLocationKey(issue)
      if (!ruleLocations.has(location)) ruleLocations.set(location, result.length)
      result.push(issue)
    } else {
      mergeRuleDuplicate(result[index], issue)
    }
  }

  for (const semantic of semanticOrder) {
    // 检查 2 的规则提示只是给成对判定提供线索，不能和 AI 结论合并成一条。
    if (semantic.check === 2) {
      result.push(semantic)
      continue
    }
    const locationIndex = ruleLocations.get(ruleLocationKey(semantic))
    if (locationIndex == null) {
      result.push(semantic)
      continue
    }
    const target = result[locationIndex]
    target.source = 'rule+semantic'
    target.severity = moreSevere(target.severity, semantic.severity)
    target.evidence = mergeEvidence(target.evidence, semantic.evidence || semantic.message)
    target.suggestion = target.suggestion || semantic.suggestion
    target.suggestedTransition = target.suggestedTransition ?? semantic.suggestedTransition
    target.windowIndex = target.windowIndex ?? semantic.windowIndex
  }
  return result
}

export function limitAuditIssues(
  issues: AuditIssueDraft[],
  options: AuditLimitOptions = {},
): AuditLimitResult {
  const maxTotal = options.maxTotal ?? MAX_AUDIT_ISSUES
  const maxPerWindow = options.maxPerWindow ?? MAX_WINDOW_SEMANTIC_ISSUES
  const windowCounts = new Map<number, number>()
  const droppedWindows = new Set<number>()
  const kept: AuditIssueDraft[] = []
  let truncated = false

  for (const issue of issues) {
    const semantic = issue.source === 'semantic' || issue.source === 'rule+semantic'
    if (semantic && issue.windowIndex != null) {
      const count = windowCounts.get(issue.windowIndex) ?? 0
      if (count >= maxPerWindow) {
        truncated = true
        droppedWindows.add(issue.windowIndex)
        continue
      }
      windowCounts.set(issue.windowIndex, count + 1)
    }
    kept.push(issue)
  }

  if (kept.length > maxTotal) {
    truncated = true
    kept.length = maxTotal
  }
  return { issues: kept, truncated, truncatedWindows: droppedWindows.size }
}

export function assignIssueIds(issues: AuditIssueDraft[], prefix = 'ISSUE'): AuditIssue[] {
  return issues.map((issue, index) => ({ ...issue, id: `${prefix}-${index + 1}` }))
}

export function validateAuditIssueDraft(issue: AuditIssueDraft): string[] {
  const problems: string[] = []
  const validChecks: AuditCheck[] = [1, 2, 3, 4, 5]
  if (!validChecks.includes(issue.check)) problems.push('检查项必须为 1-5')
  if (!['error', 'warning', 'info'].includes(issue.severity)) problems.push('严重级别必须为 error/warning/info')
  if (!['rule', 'semantic', 'rule+semantic'].includes(issue.source)) problems.push('问题来源必须为 rule/semantic/rule+semantic')
  if (!issue.message || !issue.message.trim()) problems.push('问题描述不能为空')

  const ruleCodes = AUDIT_RULE_CODES_BY_CHECK[issue.check] ?? []
  const semanticCheck = AUDIT_SEMANTIC_CODE_BY_CHECK[issue.code]
  const isRuleCode = ruleCodes.includes(issue.code)
  const isSemanticCode = semanticCheck != null
  if (!isRuleCode && !isSemanticCode) problems.push(`未登记的问题码：${issue.code}`)
  if (isSemanticCode && semanticCheck !== issue.check) {
    problems.push(`${issue.code} 只能用于检查 ${semanticCheck}`)
  }
  if (issue.source === 'semantic' && !isSemanticCode) problems.push('语义问题必须使用语义问题码')
  if (issue.source === 'rule' && !isRuleCode) problems.push('规则问题必须使用规则问题码')
  if (issue.source === 'rule+semantic' && !isRuleCode) problems.push('规则+语义问题必须保留规则问题码')

  if (issue.suggestedTransition != null) {
    if (issue.check !== 2) problems.push('suggestedTransition 只允许用于检查 2')
    if (!AUDIT_TRANSITION_KINDS.includes(issue.suggestedTransition)) {
      problems.push('suggestedTransition 值必须为 empty/scene/text')
    }
  }
  if (issue.check === 5 && issue.repairable) problems.push('检查 5 的问题不允许自动修复')
  return problems
}

export function planAuditWindows(
  shots: AuditWindowTarget[],
  options: Partial<AuditWindowOptions> = {},
): AuditWindowPlanningResult {
  const size = Math.max(2, options.size ?? SEMANTIC_WINDOW_SIZE)
  const step = Math.max(1, Math.min(size, options.step ?? SEMANTIC_WINDOW_STEP))
  const maxWindows = Math.max(1, options.maxWindows ?? MAX_SEMANTIC_WINDOWS)
  const sorted = [...shots].sort((left, right) => (
    left.storyboardNumber - right.storyboardNumber || left.id - right.id
  ))
  const windows: AuditWindowPlan[] = []
  let start = 0
  while (start < sorted.length && windows.length < maxWindows) {
    const remaining = sorted.length - start
    if (remaining < 2 && windows.length > 0) {
      const last = windows[windows.length - 1]
      for (const target of sorted.slice(start)) {
        if (!last.targets.some((item) => item.id === target.id)) last.targets.push(target)
      }
      break
    }
    const targets = sorted.slice(start, start + size)
    windows.push({
      index: windows.length + 1,
      targets,
      contextBefore: start > 0 ? sorted[start - 1] : null,
      contextAfter: sorted[start + targets.length] ?? null,
    })
    start += step
  }
  const covered = new Set(windows.flatMap((window) => window.targets.map((target) => target.id)))
  const ruleOnlyIds = sorted.filter((shot) => !covered.has(shot.id)).map((shot) => shot.id)
  return { windows, ruleOnlyIds, truncated: ruleOnlyIds.length > 0 }
}
