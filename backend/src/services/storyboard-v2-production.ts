/** V2 计划 → 现有骨架生产契约的投影；只做结构映射，不改写计划。 */
import { planStoryboardShots, type PlannedBeat, type PlannedStoryboardShot, type StoryboardPlanResult, type StoryboardPlannerInput } from './storyboard-planner.js'
import { buildStoryboardPlanV2, type V2Beat, type V2Plan, type V2Shot } from './storyboard-v2.js'
import type { VoiceTimingProfile } from './voice-timing-fit.js'
import type { V2CoveragePreset } from './storyboard-v2-presets.js'

const CUT_TO_BOUNDARY: Record<string, string | null> = {
  scene_open: null,
  scene_change: 'scene',
  new_beat: 'speech',
  listener_reaction: 'reaction',
  coverage_change: 'speech',
  action_change: 'action',
  duration_limit: 'speech',
}

function shotTypeOf(shot: V2Shot): PlannedStoryboardShot['shotType'] {
  if (shot.coverage === 'establishing') return 'establishing'
  if (shot.coverage === 'insert') return 'insert'
  if (shot.coverage === 'reaction') return 'reaction'
  if (shot.lines.length) return 'dialogue'
  return 'action'
}

function coverageRoleOf(shot: V2Shot): PlannedStoryboardShot['coverageRole'] {
  return shot.coverage === 'master' || shot.coverage === 'reverse' || shot.coverage === 'reaction'
    ? shot.coverage
    : null
}

function excerptOf(
  shot: V2Shot,
  beatsById: Map<string, V2Beat>,
  script: string,
): string {
  const source = String(script || '')
  const beats = shot.beatIds.map(id => beatsById.get(id)).filter((beat): beat is V2Beat => Boolean(beat))
  if (!beats.length) return ''
  let cursor = 0
  let out = ''
  for (const beat of beats) {
    if (!beat.fragment) {
      const start = Math.max(cursor, beat.sourceStart)
      const text = source.slice(start, beat.sourceEnd)
      if (text) {
        out += text
        cursor = Math.max(cursor, beat.sourceEnd)
      }
      continue
    }
    if (beat.fragmentIndex <= 0) {
      const raw = source.slice(beat.sourceStart, beat.sourceEnd)
      const partAt = raw.indexOf(beat.text)
      const end = partAt >= 0 ? beat.sourceStart + partAt + beat.text.length : beat.sourceEnd
      const start = Math.max(cursor, beat.sourceStart)
      const text = source.slice(start, end)
      out += text || beat.text
      cursor = Math.max(cursor, end)
    } else {
      out += beat.text
    }
  }
  return out.trim() || beats.map(beat => beat.text).join('')
}

function clausesOf(text: string): string[] {
  return String(text || '').split(/[，。！？；,.!?;]/).map(item => item.trim()).filter(Boolean)
}

function endpointsOf(
  startText: string | null,
  endText: string | null,
  speaker: string | null,
  hasSpeech: boolean,
): { start: string | null; end: string | null } {
  let start = String(startText || '').trim() || null
  let end = String(endText || '').trim() || null
  if (start && end && start !== end) return { start, end }
  const startClauses = clausesOf(start || '')
  const endClauses = clausesOf(end || '')
  if (startClauses.length && endClauses.length) {
    const first = startClauses[0]
    const last = endClauses[endClauses.length - 1]
    if (first !== last) return { start: first, end: last }
  }
  if (hasSpeech) {
    const who = speaker || '角色'
    return { start: `${who}开口`, end: `${who}说完` }
  }
  if (start) return { start, end: `${start}完成` }
  return { start: '动作开始', end: '动作结束' }
}

function beatOf(beat: V2Beat, index: number): PlannedBeat {
  return {
    index,
    kind: beat.kind,
    sceneId: beat.sceneId,
    text: beat.text,
    speaker: beat.speaker,
    dialogueText: beat.dialogueText,
    sourceQuote: beat.sourceQuote,
    sourceStart: beat.sourceStart,
    sourceEnd: beat.sourceEnd,
    fragment: beat.fragment,
    semantics: beat.semantics,
    speechRequirement: '',
  }
}

/** 将 V2 计划映射为现有管线锁定的 PlannedStoryboardShot，保留 V2 的覆盖/时长/空间/台词。 */
export function v2PlanToPlannedShots(
  plan: V2Plan,
  options: { script: string; shotStart: number },
): PlannedStoryboardShot[] {
  const beatsById = new Map(plan.beats.map(beat => [beat.beatId, beat]))
  return plan.shots.map((shot, index) => {
    const beats = shot.beatIds.map(id => beatsById.get(id)).filter((beat): beat is V2Beat => Boolean(beat))
    const speech = shot.lines.map((line, order) => ({
      speaker: line.speaker,
      text: line.text,
      sourceQuote: line.sourceQuote,
      order: order + 1,
    }))
    const actionTexts = shot.actions.map(action => action.text)
    const speaker = shot.lines[0]?.speaker || shot.actions[0]?.subject || null
    const rawStart = actionTexts[0] || speech[0]?.text || null
    const rawEnd = actionTexts.length > 1
      ? actionTexts[actionTexts.length - 1]
      : (speech[speech.length - 1]?.text || actionTexts[0] || null)
    const endpoints = endpointsOf(rawStart, rawEnd, speaker, shot.lines.length > 0)
    const sceneLabel = shot.sceneLabel
    const firstText = speech[0]?.text || actionTexts[0] || sceneLabel
    const summary = speaker
      ? `${speaker}：${firstText.replace(/\s+/g, ' ').slice(0, 48)}`
      : firstText.replace(/\s+/g, ' ').slice(0, 48)
    return {
      shotNumber: options.shotStart + index,
      storyboardNumber: options.shotStart + index,
      sceneId: shot.sceneId,
      location: shot.location,
      time: shot.time,
      sourceExcerpt: excerptOf(shot, beatsById, options.script),
      duration: shot.duration,
      actionStart: endpoints.start,
      actionEnd: endpoints.end,
      coverageType: shot.coverage,
      speechSegments: speech,
      boundaryType: CUT_TO_BOUNDARY[shot.cutReason] ?? null,
      boundaryWord: null,
      screenLeft: shot.screenLeft,
      screenRight: shot.screenRight,
      axisSide: shot.axisSide,
      landmarkSide: shot.landmarkSide,
      characterCount: shot.speakers.length,
      speechSource: speech.length ? 'planner' : undefined,
      shotType: shotTypeOf(shot),
      subject: speaker,
      subjects: [...shot.speakers],
      beatCount: beats.length,
      actionArc: {
        initial: endpoints.start || firstText,
        action: actionTexts[1] || endpoints.start || firstText,
        result: endpoints.end || firstText,
      },
      speechRequirement: null,
      narrativeRun: null,
      sceneLabel,
      titleHint: speaker ? `${speaker}：${firstText.slice(0, 14)}` : firstText.slice(0, 18),
      summaryHint: summary,
      transition: 'cut',
      speaker,
      segmentKind: shot.lines.length ? 'dialogue' : (shot.coverage === 'reaction' ? 'reaction' : 'action'),
      establishesScene: shot.coverage === 'establishing',
      coverageRole: coverageRoleOf(shot),
      beats: beats.map(beatOf),
    }
  })
}

/** 生产入口：根据开关选择 V1/V2 计划，并把 V2 投影到现有骨架契约。 */
export function planProductionStoryboardShots(
  input: StoryboardPlannerInput,
  options: {
    useV2: boolean
    timingProfiles?: Record<string, VoiceTimingProfile>
    coveragePreset?: V2CoveragePreset
  },
): StoryboardPlanResult {
  if (!options.useV2) return planStoryboardShots(input)
  const plan = buildStoryboardPlanV2(input, {
    timingProfiles: options.timingProfiles,
    coveragePreset: options.coveragePreset,
    minDuration: input.minDuration,
    maxDuration: input.maxDuration,
  })
  if (plan.issues.length) {
    const detail = plan.issues.slice(0, 3).map(issue => `${issue.ruleId}${issue.shotId ? `(${issue.shotId})` : ''}: ${issue.message}`).join('；')
    throw new Error(`V2 计划结构校验未通过：${detail}`)
  }
  const shots = v2PlanToPlannedShots(plan, { script: input.script, shotStart: input.shotStart })
  const excerptChars = shots.reduce((sum, shot) => sum + String(shot.sourceExcerpt || '').replace(/\s+/g, '').length, 0)
  const sourceChars = String(input.script || '').replace(/\s+/g, '').length
  return {
    shots,
    coverage: sourceChars ? excerptChars / sourceChars : 1,
    sceneCount: plan.diagnostics.sceneCount,
    sourceChars: plan.sourceChars,
  }
}