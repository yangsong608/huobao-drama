/** V1 vs V2 影子对比：只读数据库，不写计划、不生成 TTS/图片/视频。 */
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'
import { getCanonicalSceneGroups } from '../src/services/scene-canonical.js'
import { getSceneContractMap } from '../src/services/scene-contract.js'
import { collectVoiceTimingProfiles } from '../src/services/voice-timing.js'
import { resolveV2CoveragePreset } from '../src/services/storyboard-v2-config.js'
import { buildStoryboardPlanV2, type V2Plan } from '../src/services/storyboard-v2.js'

const presetKey = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : undefined
const ids = process.argv.slice(presetKey ? 3 : 2).map(Number).filter(id => Number.isSafeInteger(id) && id > 0)
const episodeIds = ids.length ? ids : [53, 48, 52, 49, 9]

interface V1Metrics {
  shotCount: number
  averageDuration: number
  minDuration: number
  maxDuration: number
  totalDuration: number
  dialogueShots: number
  silentShots: number
  silentLe2: number
  dialogueLines: number
  coverageCounts: Record<string, number>
}

interface V2Metrics {
  shotCount: number
  averageDuration: number
  minDuration: number
  maxDuration: number
  totalDuration: number
  dialogueShots: number
  silentShots: number
  silentLe2: number
  visibleSilentLe2: number
  staticSilentLe2: number
  staticMinimumShots: number
  dialogueLines: number
  actionBeats: number
  multiSpeakerShots: number
  closeUpShots: number
  coverageCounts: Record<string, number>
  cutReasonCounts: Record<string, number>
  issues: number
}

function sampleStats(values: number[]) {
  if (!values.length) return { average: 0, min: 0, max: 0, total: 0 }
  const total = values.reduce((sum, value) => sum + value, 0)
  return {
    average: Number((total / values.length).toFixed(1)),
    min: Math.min(...values),
    max: Math.max(...values),
    total,
  }
}

function countDialogueLines(prompt: string): number {
  const text = String(prompt || '')
  const spoken = text.match(/(?:@?[\u4e00-\u9fa5A-Za-z0-9·]{1,16}\s*(?:说|道|问|喊|答|叫|嚷|吼|骂)\s*[：:])|(?:旁白|画外音|心声|内心独白)\s*(?:（[^）]*）)?\s*[：:]/g) || []
  return spoken.length
}

function hasSpoken(text: string): boolean {
  return /(?:说|道|问|喊|答|叫|嚷|吼|骂)\s*[：:]|旁白|画外音|心声|内心独白/.test(text)
}

function v1Metrics(shots: Array<typeof schema.storyboards.$inferSelect>): V1Metrics {
  const durations = shots.map(shot => Number(shot.duration) || 0).filter(value => value > 0)
  const stats = sampleStats(durations)
  const coverageCounts: Record<string, number> = {}
  let dialogueShots = 0
  let silentShots = 0
  let silentLe2 = 0
  let dialogueLines = 0
  for (const shot of shots) {
    const prompt = String(shot.videoPrompt || '')
    const lines = countDialogueLines(prompt)
    dialogueLines += lines
    if (lines > 0 || hasSpoken(prompt)) dialogueShots += 1
    else {
      silentShots += 1
      if ((Number(shot.duration) || 0) <= 2) silentLe2 += 1
    }
    const coverage = String(shot.coverageType || 'unknown')
    coverageCounts[coverage] = (coverageCounts[coverage] || 0) + 1
  }
  return {
    shotCount: shots.length,
    averageDuration: stats.average,
    minDuration: stats.min,
    maxDuration: stats.max,
    totalDuration: stats.total,
    dialogueShots,
    silentShots,
    silentLe2,
    dialogueLines,
    coverageCounts,
  }
}

function v2Metrics(plan: V2Plan): V2Metrics {
  const durations = plan.shots.map(shot => shot.duration)
  const stats = sampleStats(durations)
  const coverageCounts: Record<string, number> = {}
  let dialogueShots = 0
  let silentShots = 0
  let silentLe2 = 0
  let visibleSilentLe2 = 0
  let staticSilentLe2 = 0
  let staticMinimumShots = 0
  let dialogueLines = 0
  let actionBeats = 0
  let multiSpeakerShots = 0
  let closeUpShots = 0
  for (const shot of plan.shots) {
    coverageCounts[shot.coverage] = (coverageCounts[shot.coverage] || 0) + 1
    if (shot.lines.length) dialogueShots += 1
    else {
      silentShots += 1
      if (shot.duration <= 2) {
        silentLe2 += 1
        if (shot.actions.some(action => action.events > 0)) visibleSilentLe2 += 1
        else staticSilentLe2 += 1
      }
    }
    if (shot.durationSource === 'platform_minimum') staticMinimumShots += 1
    dialogueLines += shot.lines.length
    actionBeats += shot.actions.length
    if (shot.speakers.length > 1) multiSpeakerShots += 1
    if (shot.camera.shotSize === 'close_up') closeUpShots += 1
  }
  return {
    shotCount: plan.shots.length,
    averageDuration: stats.average,
    minDuration: stats.min,
    maxDuration: stats.max,
    totalDuration: stats.total,
    dialogueShots,
    silentShots,
    silentLe2,
    visibleSilentLe2,
    staticSilentLe2,
    staticMinimumShots,
    dialogueLines,
    actionBeats,
    multiSpeakerShots,
    closeUpShots,
    coverageCounts,
    cutReasonCounts: plan.diagnostics.cutReasonCounts,
    issues: plan.issues.length,
  }
}

function risks(v1: V1Metrics, v2: V2Metrics): string[] {
  const risks: string[] = []
  if (v2.issues > 0) risks.push(`结构问题 ${v2.issues}`)
  if (v1.shotCount && v2.shotCount < v1.shotCount * 0.6) risks.push('镜头数明显少于 V1，检查是否合并过度')
  if (v1.shotCount && v2.shotCount > v1.shotCount * 1.5) risks.push('镜头数明显多于 V1，检查是否切碎')
  if (v2.shotCount && v2.staticSilentLe2 / v2.shotCount > 0.1) risks.push('2 秒静态描写镜占比超过 10%')
  if (v2.shotCount && (v2.coverageCounts.reaction || 0) / v2.shotCount > 0.4) risks.push('反应镜占比超过 40%')
  if (v1.averageDuration && v2.averageDuration > v1.averageDuration * 1.3) risks.push('平均时长明显长于 V1')
  if (v1.averageDuration && v2.averageDuration < v1.averageDuration * 0.65) risks.push('平均时长明显短于 V1')
  return risks
}

for (const episodeId of episodeIds) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) {
    console.log(JSON.stringify({ episodeId, error: 'episode_not_found' }))
    continue
  }
  const script = String(episode.scriptContent || episode.content || '').trim()
  const drama = db.select({ narrationForm: schema.dramas.narrationForm }).from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).get()
  const v1Shots = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
  const sceneGroups = await getCanonicalSceneGroups(episode.dramaId)
  const sceneContracts = await getSceneContractMap(episode.dramaId)
  const timingProfiles = await collectVoiceTimingProfiles(episode.dramaId)
  const characters = db.select({ name: schema.characters.name })
    .from(schema.characters)
    .where(and(eq(schema.characters.dramaId, episode.dramaId), isNull(schema.characters.deletedAt)))
    .all()
  const plan = script
    ? buildStoryboardPlanV2({
      script,
      shotStart: 1,
      characters,
      sceneGroups,
      sceneContracts,
      minDuration: 2,
      maxDuration: 15,
      narrationForm: drama?.narrationForm === 'narration' ? 'narration' : 'dialogue',
    }, { timingProfiles, coveragePreset: resolveV2CoveragePreset(presetKey) })
    : null
  const baseline = v1Metrics(v1Shots)
  const candidate = plan ? v2Metrics(plan) : null
  console.log(JSON.stringify({
    episode: { id: episode.id, dramaId: episode.dramaId, number: episode.episodeNumber, title: episode.title, scriptChars: script.length, narrationForm: drama?.narrationForm || 'dialogue' },
    preset: plan?.config || null,
    v1: baseline,
    v2: candidate,
    delta: candidate ? {
      shotRatio: baseline.shotCount ? Number((candidate.shotCount / baseline.shotCount).toFixed(2)) : null,
      averageDelta: Number((candidate.averageDuration - baseline.averageDuration).toFixed(1)),
      sourceDialogueBeats: plan.beats.filter(beat => beat.kind === 'dialogue').length,
      v1PromptSpeechCues: baseline.dialogueLines,
      v2DialogueLines: candidate.dialogueLines,
    } : null,
    risks: candidate ? risks(baseline, candidate) : ['no_script'],
  }, null, 2))
}