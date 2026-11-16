/**
 * 分镜 V2 计划核心：Beat → Coverage → Timing。
 *
 * 当前阶段只读复用 v1 的剧本节拍解析结果，不沿用 v1 的镜头边界/句数/字数规则；
 * 镜头覆盖、切镜理由和时长在这里重新生成。后续再把 Beat 解析独立出来。
 */
import {
  parseStoryboardBeats,
  type RawBeat,
  type SceneBlock,
  type StoryboardPlannerInput,
} from './storyboard-planner.js'
import { estimateActionTiming } from './action-timing.js'
import { speechTextChars } from './dialogue-timing.js'
import { estimateLineSeconds, type VoiceTimingProfile } from './voice-timing-fit.js'
import {
  DEFAULT_V2_COVERAGE_PRESET,
  type V2CloseUpBias,
  type V2CoveragePreset,
} from './storyboard-v2-presets.js'

export type V2Coverage = 'master' | 'over_shoulder' | 'reverse' | 'reaction' | 'insert' | 'establishing'

export type V2CutReason =
  | 'scene_open'
  | 'scene_change'
  | 'new_beat'
  | 'listener_reaction'
  | 'coverage_change'
  | 'action_change'
  | 'duration_limit'

export type V2RuleTier = 'structural_invariant' | 'reviewed_invariant' | 'craft_default' | 'taste_option'

export interface V2Beat {
  beatId: string
  sceneId: number | null
  sceneLabel: string
  location: string | null
  time: string | null
  sourceStart: number
  sourceEnd: number
  kind: 'dialogue' | 'action'
  speaker: string
  text: string
  dialogueText: string
  sourceQuote: string
  fragment: boolean
  fragmentIndex: number
  fragmentTotal: number
  semantics: RawBeat['semantics']
  order: number
}

export interface V2Line {
  beatId: string
  speaker: string
  text: string
  sourceQuote: string
  sourceStart: number
  sourceEnd: number
  estimatedSeconds: number
}

export interface V2Action {
  beatId: string
  text: string
  events: number
  estimatedSeconds: number
  subject: string | null
  target: string | null
  narration: boolean
}

export interface V2Camera {
  shotSize: 'wide' | 'medium' | 'medium_close' | 'close_up'
  angle: 'eye_level' | 'high_angle' | 'low_angle' | 'over_shoulder'
  movement: 'static' | 'follow' | 'push_in'
}

export interface V2Shot {
  shotId: string
  sceneId: number | null
  sceneLabel: string
  location: string | null
  time: string | null
  beatIds: string[]
  coverage: V2Coverage
  cutReason: V2CutReason
  cutDetail: string
  subject: string | null
  camera: V2Camera
  screenLeft: string | null
  screenRight: string | null
  axisSide: string | null
  landmarkSide: string | null
  lines: V2Line[]
  actions: V2Action[]
  speakers: string[]
  duration: number
  durationSource: 'dialogue_audio_estimate' | 'narration_audio_estimate' | 'action_events' | 'mixed' | 'platform_minimum'
}

export interface V2Issue {
  ruleId: string
  tier: V2RuleTier
  shotId: string | null
  message: string
  evidence: string
}

export interface V2PlanConfig {
  coveragePresetKey: string
  coveragePresetName: string
  rhythmTargetSeconds: number
  closeUpBias: V2CloseUpBias
}

export interface V2Plan {
  version: 2
  sourceChars: number
  config: V2PlanConfig
  beats: V2Beat[]
  shots: V2Shot[]
  issues: V2Issue[]
  diagnostics: {
    sceneCount: number
    beatCount: number
    shotCount: number
    averageDuration: number
    estimatedDialogueSeconds: number
    estimatedActionSeconds: number
    coverageCounts: Record<string, number>
    cutReasonCounts: Record<string, number>
    timingProfileSources: Record<string, string>
    unclaimedBeats: string[]
  }
}

export interface V2PlanOptions {
  minDuration?: number
  maxDuration?: number
  /** 按说话人索引的真实配音语速档案；没有档案时使用默认语速。 */
  timingProfiles?: Record<string, VoiceTimingProfile>
  /** 覆盖预设；不传时使用默认平衡覆盖。 */
  coveragePreset?: V2CoveragePreset
}

const EXPLANATORY_ANSWER_RE = /^\s*(?:因为|所以|其实|原因是|主要是|就是|这不是|那不是)/
const QUESTION_END_RE = /[？?]\s*$/

function profileOf(profiles: Record<string, VoiceTimingProfile> | undefined, speaker: string): VoiceTimingProfile | undefined {
  return profiles && speaker ? profiles[speaker] : undefined
}

function lineSeconds(text: string, profiles: Record<string, VoiceTimingProfile> | undefined, speaker: string): number {
  return estimateLineSeconds(text, profileOf(profiles, speaker))
}

function beatToV2(beat: RawBeat, scene: SceneBlock, order: number, part?: {
  text: string
  index: number
  total: number
}): V2Beat {
  const baseId = `beat-${scene.sceneId ?? scene.label}-${beat.start}-${beat.end}-${beat.kind}-${order}`
  return {
    beatId: part && part.total > 1 ? `${baseId}-p${part.index + 1}` : baseId,
    sceneId: scene.sceneId,
    sceneLabel: scene.label,
    location: scene.location || null,
    time: scene.time || null,
    sourceStart: beat.start,
    sourceEnd: beat.end,
    kind: beat.kind,
    speaker: String(beat.speaker || ''),
    text: part ? part.text : String(beat.text || ''),
    dialogueText: part ? part.text : String(beat.dialogueText || ''),
    sourceQuote: part ? part.text : String(beat.sourceQuote || ''),
    fragment: part ? (part.total > 1 || beat.fragment) : Boolean(beat.fragment),
    fragmentIndex: part?.index ?? 0,
    fragmentTotal: part?.total ?? 1,
    semantics: beat.semantics,
    order,
  }
}

function lineOf(beat: V2Beat, profiles: Record<string, VoiceTimingProfile> | undefined): V2Line {
  return {
    beatId: beat.beatId,
    speaker: beat.speaker || '角色',
    text: beat.dialogueText || beat.text,
    sourceQuote: beat.sourceQuote || beat.dialogueText || beat.text,
    sourceStart: beat.sourceStart,
    sourceEnd: beat.sourceEnd,
    estimatedSeconds: lineSeconds(beat.dialogueText || beat.text, profiles, beat.speaker),
  }
}

type NarrationForm = 'dialogue' | 'narration'

function actionTimingFor(
  beat: V2Beat,
  narrationForm: NarrationForm,
  profiles: Record<string, VoiceTimingProfile> | undefined,
): { events: number; seconds: number; narration: boolean } {
  if (narrationForm === 'narration') {
    return { events: 0, seconds: lineSeconds(beat.text, profiles, '旁白'), narration: true }
  }
  const timing = estimateActionTiming(beat.text)
  return { ...timing, narration: false }
}

function actionOf(
  beat: V2Beat,
  narrationForm: NarrationForm,
  profiles: Record<string, VoiceTimingProfile> | undefined,
): V2Action {
  const timing = actionTimingFor(beat, narrationForm, profiles)
  return {
    beatId: beat.beatId,
    text: beat.text,
    events: timing.events,
    estimatedSeconds: timing.seconds,
    subject: beat.semantics.subject || null,
    target: beat.semantics.target || null,
    narration: timing.narration,
  }
}

function lastLine(shot: V2Shot): V2Line | null {
  return shot.lines[shot.lines.length - 1] || null
}

function firstSpeaker(shot: V2Shot): string {
  return shot.lines[0]?.speaker || shot.actions[0]?.subject || ''
}

function projectedDuration(
  shot: V2Shot,
  beat: V2Beat,
  profiles: Record<string, VoiceTimingProfile> | undefined,
  narrationForm: NarrationForm,
): number {
  const addition = beat.kind === 'dialogue'
    ? lineSeconds(beat.dialogueText || beat.text, profiles, beat.speaker)
    : actionTimingFor(beat, narrationForm, profiles).seconds
  return shot.duration + addition
}

function isReactionOnly(beat: V2Beat): boolean {
  return beat.kind === 'action'
    && estimateActionTiming(beat.text).events <= 1
    && !beat.semantics.target
}

function isStaticActionBeat(beat: V2Beat, narrationForm: NarrationForm): boolean {
  return narrationForm !== 'narration' && beat.kind === 'action' && estimateActionTiming(beat.text).events === 0
}

function hasVisibleAction(shot: V2Shot): boolean {
  return shot.actions.some(action => action.events > 0)
}

function cameraForCoverage(coverage: V2Coverage, preset: V2CoveragePreset): V2Camera {
  switch (coverage) {
    case 'establishing':
      return { shotSize: 'wide', angle: 'eye_level', movement: 'static' }
    case 'master':
      return { shotSize: 'medium', angle: 'eye_level', movement: 'static' }
    case 'over_shoulder':
      return { shotSize: 'medium_close', angle: 'over_shoulder', movement: 'static' }
    case 'insert':
      return { shotSize: 'close_up', angle: 'high_angle', movement: 'static' }
    case 'reaction':
      return {
        shotSize: preset.closeUpBias === 'low' ? 'medium_close' : 'close_up',
        angle: 'eye_level',
        movement: 'static',
      }
    case 'reverse':
    default:
      return {
        shotSize: preset.closeUpBias === 'high' ? 'close_up' : 'medium_close',
        angle: 'eye_level',
        movement: 'static',
      }
  }
}

function coverageForStart(beat: V2Beat, sceneFirst: boolean, explanatory: boolean): V2Coverage {
  if (beat.kind === 'dialogue') {
    if (explanatory) return 'reverse'
    return sceneFirst ? 'master' : 'reverse'
  }
  if (sceneFirst) return 'establishing'
  return 'reaction'
}

function cutForAppending(
  shot: V2Shot,
  beat: V2Beat,
  maxDuration: number,
  profiles: Record<string, VoiceTimingProfile> | undefined,
  preset: V2CoveragePreset,
  narrationForm: NarrationForm,
): { reason: V2CutReason; detail: string } | null {
  const duration = projectedDuration(shot, beat, profiles, narrationForm)
  if (beat.kind === 'dialogue') {
    if (!shot.lines.length) {
      if (shot.actions.length && !hasVisibleAction(shot) && duration <= maxDuration) return null
      return { reason: 'coverage_change', detail: '从动作/反应切到有台词主体' }
    }
    const previous = lastLine(shot)
    if (preset.dialogueCoverage === 'speaker_cut'
      && previous?.speaker
      && beat.speaker
      && previous.speaker !== beat.speaker) {
      return { reason: 'coverage_change', detail: '预设要求换说话人时切换覆盖' }
    }
    if (previous && QUESTION_END_RE.test(previous.text)
      && EXPLANATORY_ANSWER_RE.test(beat.dialogueText || beat.text)) {
      return { reason: 'new_beat', detail: '问题之后的解释性回答开启新节拍' }
    }
    if (duration > maxDuration) {
      return { reason: 'duration_limit', detail: `当前镜加台词预计超过 ${maxDuration} 秒` }
    }
    return null
  }

  // 静态描写是视觉依据，不因主体/视角变化单独切镜；只有可见动作才参与动作镜判断。
  if (isStaticActionBeat(beat, narrationForm)) {
    return duration > maxDuration
      ? { reason: 'duration_limit', detail: `当前镜加动作预计超过 ${maxDuration} 秒` }
      : null
  }

  // 动作：同主体的连续反应可以继续留在此镜；换主体、信息事件变化或超时才另起。
  const nextSubject = beat.semantics.subject || ''
  const previousAction = shot.actions[shot.actions.length - 1]
  if (!shot.actions.length && shot.lines.length) {
    if (preset.reactionCoverage === 'always') {
      return { reason: 'listener_reaction', detail: '预设要求反应独立成镜' }
    }
    if (preset.reactionCoverage === 'minimal' && duration <= maxDuration) return null
    if (isReactionOnly(beat) && duration <= maxDuration) return null
    if (duration > maxDuration) {
      return { reason: 'duration_limit', detail: `当前镜加动作预计超过 ${maxDuration} 秒` }
    }
    return { reason: 'listener_reaction', detail: '对白后的动作形成新的反应节拍' }
  }
  if (shot.actions.length && shot.lines.length) {
    if (preset.reactionCoverage === 'always') {
      return { reason: 'listener_reaction', detail: '预设要求反应独立成镜' }
    }
    if (preset.actionSubject === 'cut'
      && nextSubject
      && previousAction?.subject
      && nextSubject !== previousAction.subject) {
      return { reason: 'action_change', detail: '动作主体与当前镜主体不同' }
    }
    if (duration > maxDuration) {
      return { reason: 'duration_limit', detail: `当前镜加动作预计超过 ${maxDuration} 秒` }
    }
    return null
  }
  if (shot.actions.length && duration > maxDuration) {
    return { reason: 'duration_limit', detail: `当前镜加动作预计超过 ${maxDuration} 秒` }
  }
  if (preset.actionSubject === 'cut'
    && shot.actions.length
    && nextSubject
    && shot.subject
    && nextSubject !== shot.subject) {
    return { reason: 'action_change', detail: '动作主体与当前镜主体不同' }
  }
  return duration > maxDuration
    ? { reason: 'duration_limit', detail: `当前镜加动作预计超过 ${maxDuration} 秒` }
    : null
}

function makeShot(
  beat: V2Beat,
  sceneFirst: boolean,
  explanatory: boolean,
  proof: V2CutReason,
  detail: string,
  minDuration: number,
  profiles: Record<string, VoiceTimingProfile> | undefined,
  sceneContracts: StoryboardPlannerInput['sceneContracts'],
  preset: V2CoveragePreset,
  narrationForm: NarrationForm,
): V2Shot {
  const coverage = coverageForStart(beat, sceneFirst, explanatory)
  const camera = cameraForCoverage(coverage, preset)
  const contract = beat.sceneId ? sceneContracts?.get(beat.sceneId) : undefined
  const shot: V2Shot = {
    shotId: '',
    sceneId: beat.sceneId,
    sceneLabel: beat.sceneLabel,
    location: beat.location,
    time: beat.time,
    beatIds: [],
    coverage,
    cutReason: proof,
    cutDetail: detail,
    subject: beat.kind === 'dialogue' ? beat.speaker || null : beat.semantics.subject || null,
    camera,
    screenLeft: contract?.screenLeft ?? null,
    screenRight: contract?.screenRight ?? null,
    axisSide: contract?.axisSide ?? null,
    landmarkSide: contract?.landmarkSide ?? null,
    lines: [],
    actions: [],
    speakers: [],
    duration: minDuration,
    durationSource: 'platform_minimum',
  }
  appendBeat(shot, beat, profiles, narrationForm)
  finalizeDuration(shot)
  return shot
}

function appendBeat(
  shot: V2Shot,
  beat: V2Beat,
  profiles: Record<string, VoiceTimingProfile> | undefined,
  narrationForm: NarrationForm,
) {
  shot.beatIds.push(beat.beatId)
  if (beat.kind === 'dialogue') {
    shot.lines.push(lineOf(beat, profiles))
    if (beat.speaker && !shot.speakers.includes(beat.speaker)) shot.speakers.push(beat.speaker)
    if (!shot.subject) shot.subject = beat.speaker || null
  } else {
    shot.actions.push(actionOf(beat, narrationForm, profiles))
    if (beat.semantics.subject && !shot.speakers.includes(beat.semantics.subject)) {
      shot.speakers.push(beat.semantics.subject)
    }
    if (!shot.subject) shot.subject = beat.semantics.subject || null
  }
}

function finalizeDuration(shot: V2Shot) {
  const dialogueSeconds = shot.lines.reduce((sum, line) => sum + line.estimatedSeconds, 0)
  const actionSeconds = shot.actions.reduce((sum, action) => sum + action.estimatedSeconds, 0)
  const hasNarration = shot.actions.some(action => action.narration)
  shot.duration = Math.max(2, Math.ceil(Math.max(dialogueSeconds, actionSeconds)))
  shot.durationSource = dialogueSeconds && actionSeconds
    ? 'mixed'
    : dialogueSeconds
      ? 'dialogue_audio_estimate'
      : actionSeconds
        ? (hasNarration && !shot.actions.some(action => !action.narration) ? 'narration_audio_estimate' : 'action_events')
        : 'platform_minimum'
}

function splitDialogueText(text: string, capacity: number): string[] {
  const chars = speechTextChars(text)
  if (chars <= capacity) return [text]
  const segments = text.match(/[^，。！？；,.!?;]+[，。！？；,.!?;]?/g) || [text]
  const chunks: string[] = []
  let current = ''
  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }
  for (const segment of segments) {
    if (speechTextChars(segment) > capacity) {
      flush()
      const charsList = [...segment]
      while (charsList.length > capacity) chunks.push(charsList.splice(0, capacity).join('').trim())
      current = charsList.join('')
      continue
    }
    if (current && speechTextChars(current + segment) > capacity) flush()
    current += segment
  }
  flush()
  return chunks.filter(item => speechTextChars(item) > 0)
}

function dialogueCapacity(
  speaker: string,
  maxDuration: number,
  profiles: Record<string, VoiceTimingProfile> | undefined,
): number {
  const profile = profileOf(profiles, speaker)
  const charsPerSecond = profile?.charsPerSecond && profile.charsPerSecond > 0 ? profile.charsPerSecond : 6
  const pause = profile && Number.isFinite(profile.pauseSeconds) ? profile.pauseSeconds : 0.25
  return Math.max(8, Math.floor((maxDuration - pause) * charsPerSecond))
}

function flattenBeats(
  input: StoryboardPlannerInput,
  maxDuration: number,
  profiles: Record<string, VoiceTimingProfile> | undefined,
  narrationForm: NarrationForm,
): V2Beat[] {
  const beats: V2Beat[] = []
  let order = 1
  for (const scene of parseStoryboardBeats({ ...input, maxDuration })) {
    for (const beat of scene.beats) {
      const spoken = beat.kind === 'dialogue' || narrationForm === 'narration'
      if (spoken) {
        const spokenText = beat.kind === 'dialogue'
          ? String(beat.dialogueText || beat.text || '')
          : String(beat.text || '')
        const speaker = beat.kind === 'dialogue' ? beat.speaker : '旁白'
        const parts = splitDialogueText(spokenText, dialogueCapacity(speaker, maxDuration, profiles))
        parts.forEach((part, index) => {
          beats.push(beatToV2(beat, scene.scene, order, { text: part, index, total: parts.length }))
          order += 1
        })
      } else {
        beats.push(beatToV2(beat, scene.scene, order))
        order += 1
      }
    }
  }
  return beats
}

function sceneKey(beat: V2Beat): string {
  return `${beat.sceneId ?? ''}|${beat.sceneLabel}|${beat.location ?? ''}|${beat.time ?? ''}`
}

/** 生成 V2 计划；当前先用 v1 只负责剧本节拍解析，覆盖与时长在 V2 内重新计算。 */
export function buildStoryboardPlanV2(input: StoryboardPlannerInput, options: V2PlanOptions = {}): V2Plan {
  const minDuration = Math.max(2, Math.min(15, options.minDuration ?? input.minDuration ?? 2))
  const maxDuration = Math.max(minDuration, Math.min(20, options.maxDuration ?? input.maxDuration ?? 15))
  const timingProfiles = options.timingProfiles
  const preset = options.coveragePreset || DEFAULT_V2_COVERAGE_PRESET
  const narrationForm: NarrationForm = input.narrationForm === 'narration' ? 'narration' : 'dialogue'
  const beats = flattenBeats(input, maxDuration, timingProfiles, narrationForm)
  const shots: V2Shot[] = []
  let current: V2Shot | null = null
  let currentSceneKey = ''
  let sceneHasMaster = false

  for (const beat of beats) {
    const nextSceneKey = sceneKey(beat)
    const sceneChanged = Boolean(current && currentSceneKey !== nextSceneKey)
    if (sceneChanged || !current) {
      const proof = sceneChanged ? 'scene_change' : 'scene_open'
      current = makeShot(
        beat,
        true,
        false,
        proof,
        sceneChanged ? '场景变化，必须新开镜' : '本场建立镜',
        minDuration,
        timingProfiles,
        input.sceneContracts,
        preset,
        narrationForm,
      )
      if (current.lines.length && !sceneHasMaster) {
        current.coverage = 'master'
        current.camera = cameraForCoverage('master', preset)
        sceneHasMaster = true
      }
      shots.push(current)
      currentSceneKey = nextSceneKey
      sceneHasMaster = current.coverage === 'master'
      continue
    }

    const explanatory = beat.kind === 'dialogue'
      && Boolean(lastLine(current) && QUESTION_END_RE.test(lastLine(current)!.text))
      && EXPLANATORY_ANSWER_RE.test(beat.dialogueText || beat.text)
    const cut = cutForAppending(current, beat, maxDuration, timingProfiles, preset, narrationForm)
    if (cut || explanatory) {
      const reason = explanatory ? 'new_beat' : cut!.reason
      const detail = explanatory ? '问题之后的解释性回答开启新节拍' : cut!.detail
      const next = makeShot(
        beat,
        false,
        explanatory,
        reason,
        detail,
        minDuration,
        timingProfiles,
        input.sceneContracts,
        preset,
        narrationForm,
      )
      if (next.lines.length && !sceneHasMaster && !explanatory) {
        next.coverage = 'master'
        next.camera = cameraForCoverage('master', preset)
        sceneHasMaster = true
      }
      shots.push(next)
      current = next
      continue
    }
    const hadLines = current.lines.length > 0
    appendBeat(current, beat, timingProfiles, narrationForm)
    if (!hadLines && current.lines.length > 0
      && current.coverage === 'establishing'
      && !hasVisibleAction(current)) {
      current.coverage = 'master'
      current.camera = cameraForCoverage('master', preset)
      sceneHasMaster = true
    }
    finalizeDuration(current)
  }

  shots.forEach((shot, index) => { shot.shotId = `S${String(index + 1).padStart(3, '0')}` })
  const config: V2PlanConfig = {
    coveragePresetKey: preset.key,
    coveragePresetName: preset.name,
    rhythmTargetSeconds: preset.targetAverageSeconds,
    closeUpBias: preset.closeUpBias,
  }
  const issues = validateStoryboardPlanV2(
    {
      version: 2,
      sourceChars: input.script.length,
      config,
      beats,
      shots,
      issues: [],
      diagnostics: emptyDiagnostics(),
    },
    { minDuration, maxDuration },
  )
  return {
    version: 2,
    sourceChars: input.script.length,
    config,
    beats,
    shots,
    issues,
    diagnostics: summarizePlan(beats, shots, timingProfiles),
  }
}

function emptyDiagnostics() {
  return {
    sceneCount: 0,
    beatCount: 0,
    shotCount: 0,
    averageDuration: 0,
    estimatedDialogueSeconds: 0,
    estimatedActionSeconds: 0,
    coverageCounts: {},
    cutReasonCounts: {},
    timingProfileSources: {},
    unclaimedBeats: [],
  }
}

function summarizePlan(
  beats: V2Beat[],
  shots: V2Shot[],
  profiles: Record<string, VoiceTimingProfile> | undefined,
): V2Plan['diagnostics'] {
  const coverageCounts: Record<string, number> = {}
  const cutReasonCounts: Record<string, number> = {}
  const timingProfileSources: Record<string, string> = {}
  let estimatedDialogueSeconds = 0
  let estimatedActionSeconds = 0
  for (const shot of shots) {
    coverageCounts[shot.coverage] = (coverageCounts[shot.coverage] || 0) + 1
    cutReasonCounts[shot.cutReason] = (cutReasonCounts[shot.cutReason] || 0) + 1
    for (const line of shot.lines) {
      estimatedDialogueSeconds += line.estimatedSeconds
      timingProfileSources[line.speaker] = profileOf(profiles, line.speaker)?.source ?? 'default'
    }
    for (const action of shot.actions) estimatedActionSeconds += action.estimatedSeconds
  }
  const claimed = new Set(shots.flatMap(shot => shot.beatIds))
  const unclaimedBeats = beats.filter(beat => !claimed.has(beat.beatId)).map(beat => beat.beatId)
  return {
    sceneCount: new Set(shots.map(shot => `${shot.sceneId ?? ''}|${shot.sceneLabel}|${shot.location ?? ''}|${shot.time ?? ''}`)).size,
    beatCount: beats.length,
    shotCount: shots.length,
    averageDuration: Number((shots.reduce((sum, shot) => sum + shot.duration, 0) / Math.max(1, shots.length)).toFixed(1)),
    estimatedDialogueSeconds: Number(estimatedDialogueSeconds.toFixed(1)),
    estimatedActionSeconds: Number(estimatedActionSeconds.toFixed(1)),
    coverageCounts,
    cutReasonCounts,
    timingProfileSources,
    unclaimedBeats,
  }
}

/** 只校验结构不变量；创作偏好由 reviewed/craft/taste 层处理。 */
export function validateStoryboardPlanV2(plan: V2Plan, options: V2PlanOptions = {}): V2Issue[] {
  const minDuration = Math.max(2, Math.min(15, options.minDuration ?? 2))
  const maxDuration = Math.max(minDuration, Math.min(20, options.maxDuration ?? 15))
  const issues: V2Issue[] = []
  const claimed = new Map<string, string>()
  const beatsById = new Map(plan.beats.map(beat => [beat.beatId, beat]))
  const sceneSides = new Map<string, Pick<V2Shot, 'screenLeft' | 'screenRight' | 'axisSide' | 'landmarkSide'>>()
  for (const shot of plan.shots) {
    if (shot.duration < minDuration || shot.duration > maxDuration) {
      issues.push({ ruleId: 'SHT-16', tier: 'structural_invariant', shotId: shot.shotId, message: '镜头时长超出平台可执行范围', evidence: `${shot.duration}s` })
    }
    if (shot.beatIds.length === 0) {
      issues.push({ ruleId: 'COV-01', tier: 'structural_invariant', shotId: shot.shotId, message: '镜头没有 claim 任何节拍', evidence: shot.sceneLabel })
    }
    if (!shot.camera) {
      issues.push({ ruleId: 'COV-05', tier: 'structural_invariant', shotId: shot.shotId, message: '镜头缺少景别/机位', evidence: shot.coverage })
    }
    const shotSceneKey = `${shot.sceneId ?? ''}|${shot.sceneLabel}|${shot.location ?? ''}|${shot.time ?? ''}`
    const sceneIdentity = shot.sceneId != null ? `scene:${shot.sceneId}` : shotSceneKey
    if (shot.screenLeft || shot.screenRight || shot.axisSide || shot.landmarkSide) {
      const previous = sceneSides.get(sceneIdentity)
      if (!previous) {
        sceneSides.set(sceneIdentity, {
          screenLeft: shot.screenLeft,
          screenRight: shot.screenRight,
          axisSide: shot.axisSide,
          landmarkSide: shot.landmarkSide,
        })
      } else if (
        previous.screenLeft !== shot.screenLeft
        || previous.screenRight !== shot.screenRight
        || previous.axisSide !== shot.axisSide
        || previous.landmarkSide !== shot.landmarkSide
      ) {
        issues.push({ ruleId: 'COV-06', tier: 'structural_invariant', shotId: shot.shotId, message: '同一场景的屏幕左右/轴线发生无依据翻转', evidence: shot.sceneLabel })
      }
    }
    for (const beatId of shot.beatIds) {
      if (claimed.has(beatId)) {
        issues.push({ ruleId: 'SHT-01', tier: 'structural_invariant', shotId: shot.shotId, message: '同一节拍被多个镜头 claim', evidence: beatId })
      }
      claimed.set(beatId, shot.shotId)
      const beat = beatsById.get(beatId)
      if (beat && sceneKey(beat) !== shotSceneKey) {
        issues.push({ ruleId: 'COV-03', tier: 'structural_invariant', shotId: shot.shotId, message: '同一镜跨了多个场景', evidence: beatId })
      }
    }
    for (const line of shot.lines) {
      const beat = beatsById.get(line.beatId)
      const expected = beat ? (beat.dialogueText || beat.text) : ''
      if (!beat || beat.kind !== 'dialogue' || line.text !== expected) {
        issues.push({ ruleId: 'SHT-02', tier: 'structural_invariant', shotId: shot.shotId, message: '台词没有逐字对应原文节拍', evidence: line.text.slice(0, 60) })
      }
    }
    if (!shot.cutReason) {
      issues.push({ ruleId: 'COV-02', tier: 'structural_invariant', shotId: shot.shotId, message: '镜头缺少切镜/合镜理由', evidence: shot.sceneLabel })
    }
  }
  for (const beat of plan.beats) {
    if (!claimed.has(beat.beatId)) {
      issues.push({ ruleId: 'SHT-01', tier: 'structural_invariant', shotId: null, message: '原文节拍没有被镜头覆盖，也没有省略理由', evidence: beat.text.slice(0, 60) })
    }
  }
  return issues
}
