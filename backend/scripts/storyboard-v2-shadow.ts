/** V2 影子运行：只读剧本生成 Beat/Coverage/Timing 计划，不写库、不调用模型。 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'
import { buildStoryboardPlanV2 } from '../src/services/storyboard-v2.js'
import { getCanonicalSceneGroups } from '../src/services/scene-canonical.js'
import { getSceneContractMap } from '../src/services/scene-contract.js'
import { collectVoiceTimingProfiles } from '../src/services/voice-timing.js'
import { resolveV2CoveragePreset } from '../src/services/storyboard-v2-config.js'

const episodeId = Number(process.argv[2] || 53)
const presetKey = process.argv[3]
const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
if (!episode) throw new Error(`剧集 ${episodeId} 不存在`)
const drama = db.select({ narrationForm: schema.dramas.narrationForm }).from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).get()
const sceneGroups = await getCanonicalSceneGroups(episode.dramaId)
const sceneContracts = await getSceneContractMap(episode.dramaId)
const timingProfiles = await collectVoiceTimingProfiles(episode.dramaId)
const coveragePreset = resolveV2CoveragePreset(presetKey)
const characters = db.select({ name: schema.characters.name })
  .from(schema.characters)
  .where(eq(schema.characters.dramaId, episode.dramaId))
  .all()
const script = String(episode.scriptContent || episode.content || '').trim()
if (!script) throw new Error('该集没有剧本')
const plan = buildStoryboardPlanV2({
  script,
  shotStart: 1,
  characters,
  sceneGroups,
  sceneContracts,
  minDuration: 2,
  maxDuration: 15,
  narrationForm: drama?.narrationForm === 'narration' ? 'narration' : 'dialogue',
}, { timingProfiles, coveragePreset })

console.log(JSON.stringify({
  episode: { id: episode.id, title: episode.title, narrationForm: drama?.narrationForm || 'dialogue' },
  config: plan.config,
  timingProfiles: [...new Map(Object.values(timingProfiles).map(profile => [
    `${profile.speaker}|${profile.voiceId}|${profile.charsPerSecond}|${profile.source}`,
    {
      speaker: profile.speaker,
      charsPerSecond: profile.charsPerSecond,
      pauseSeconds: profile.pauseSeconds,
      sampleCount: profile.sampleCount,
      source: profile.source,
    },
  ])).values()],
  diagnostics: plan.diagnostics,
  issues: plan.issues,
  shots: plan.shots.map(shot => ({
    id: shot.shotId,
    scene: shot.sceneLabel,
    duration: shot.duration,
    durationSource: shot.durationSource,
    coverage: shot.coverage,
    camera: shot.camera,
    screenLeft: shot.screenLeft,
    screenRight: shot.screenRight,
    axisSide: shot.axisSide,
    cutReason: shot.cutReason,
    cutDetail: shot.cutDetail,
    speakers: shot.speakers,
    lines: shot.lines.map(line => ({ text: line.text, seconds: line.estimatedSeconds })),
    actions: shot.actions.map(action => action.text),
  })),
}, null, 2))
