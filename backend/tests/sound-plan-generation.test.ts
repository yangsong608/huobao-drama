/**
 * 声音设计生成与加入音轨：无配置拒绝、状态、实际时间校验、幂等与替换。
 */
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-sound-plan-generation-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
await fs.mkdir(path.join(root, 'static'), { recursive: true })

const videoPath = path.join(root, 'shot.mp4')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1',
  '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', videoPath,
])
const audioPath = path.join(root, 'sound.wav')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-ar', '48000', '-ac', '2', audioPath,
])

const { db, schema } = await import('../src/db/index.ts')
const {
  SoundPlanError,
  attachSoundCue,
  getSoundPlanStatus,
  startSoundPlanGeneration,
} = await import('../src/services/sound-plan-generation.ts')
const { describeSoundPlan } = await import('../src/services/sound-plan-audio.ts')

const ts = new Date().toISOString()
let episodeId = 0
let cueId = 0
let noVideoCueId = 0
let assetId = 0

async function seed() {
  const ep = await db.insert(schema.episodes).values({
    dramaId: 1,
    episodeNumber: 901,
    title: '声音设计测试',
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  episodeId = ep.id
  const plan = await db.insert(schema.soundPlans).values({
    episodeId,
    dramaId: 1,
    version: 1,
    status: 'done',
    planJson: JSON.stringify({ delivery: 'post', summary: '测试计划' }),
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const withVideo = await db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 1,
    duration: 1,
    videoUrl: videoPath,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  await db.insert(schema.storyboards).values({
    episodeId,
    storyboardNumber: 2,
    duration: 1,
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const cue = await db.insert(schema.soundCues).values({
    planId: plan.id,
    unitKey: 'unit-1',
    unitLabel: '街道夜',
    kind: 'ambience',
    fromShotId: withVideo.id,
    toShotId: withVideo.id,
    fromShotNumber: 1,
    toShotNumber: 1,
    description: '街道夜的环境底噪',
    delivery: 'post',
    sortOrder: 0,
    generationStatus: 'idle',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  cueId = cue.id
  const noVideoCue = await db.insert(schema.soundCues).values({
    planId: plan.id,
    unitKey: 'unit-2',
    unitLabel: '无视频镜头',
    kind: 'sfx',
    fromShotId: withVideo.id + 1,
    toShotId: withVideo.id + 1,
    fromShotNumber: 2,
    toShotNumber: 2,
    description: '脚步声',
    delivery: 'post',
    sortOrder: 2,
    generationStatus: 'idle',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  noVideoCueId = noVideoCue.id
  const asset = await db.insert(schema.episodeAudioAssets).values({
    episodeId,
    dramaId: 1,
    kind: 'soundscape',
    url: audioPath,
    durationMs: 1000,
    status: 'ready',
    metadataJson: JSON.stringify({ source: 'sound-plan', cueId, category: 'ambience', startMs: 0, endMs: 1000, timeSource: 'timeline' }),
    createdAt: ts,
  }).returning().get()
  assetId = asset.id
  await db.update(schema.soundCues).set({
    assetId: asset.id,
    generationStatus: 'ready',
    generatedAt: ts,
  }).where(eq(schema.soundCues.id, cueId))
  const noVideoAsset = await db.insert(schema.episodeAudioAssets).values({
    episodeId,
    dramaId: 1,
    kind: 'soundscape',
    url: audioPath,
    durationMs: 1000,
    status: 'ready',
    metadataJson: JSON.stringify({ source: 'sound-plan', cueId: noVideoCueId, category: 'sfx', timeSource: 'planned' }),
    createdAt: ts,
  }).returning().get()
  await db.update(schema.soundCues).set({
    assetId: noVideoAsset.id,
    generationStatus: 'ready',
    generatedAt: ts,
  }).where(eq(schema.soundCues.id, noVideoCueId))
}

before(async () => {
  await seed()
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('无 audio-gen 配置时启动生成返回 503', async () => {
  await assert.rejects(
    () => startSoundPlanGeneration(episodeId, { cueIds: [cueId] }),
    (error: any) => error instanceof SoundPlanError && error.status === 503,
  )
})

test('状态：没有任务时返回 idle', () => {
  const status = getSoundPlanStatus(episodeId)
  assert.equal(status.status, 'idle')
  assert.equal(status.counts.total, 0)
})

test('实际时间轴存在时加入音轨，重复加入幂等，replace 可替换', async () => {
  const first = await attachSoundCue(episodeId, cueId)
  assert.ok(first.trackId > 0)
  assert.ok(first.clipId > 0)
  assert.equal(first.startMs, 0)
  assert.equal(first.endMs, 1000)
  const track = db.select().from(schema.episodeAudioTracks).where(eq(schema.episodeAudioTracks.id, first.trackId)).get()
  assert.equal(track?.origin, 'sound-plan')
  assert.equal(track?.role, 'ambience')
  const clip = db.select().from(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.id, first.clipId)).get()
  assert.equal(clip?.soundCueId, cueId)
  assert.equal(clip?.assetId, assetId)

  const second = await attachSoundCue(episodeId, cueId)
  assert.equal(second.clipId, first.clipId, '重复加入不应新增片段')

  const replaced = await attachSoundCue(episodeId, cueId, { replaceExisting: true })
  assert.notEqual(replaced.clipId, first.clipId)
  assert.equal(replaced.startMs, 0)
})

test('没有实际视频时间轴时加入音轨返回 409', async () => {
  await assert.rejects(
    () => attachSoundCue(episodeId, noVideoCueId),
    (error: any) => error instanceof SoundPlanError && error.status === 409,
  )
})

test('describeSoundPlan 返回来源、素材和可加入状态', async () => {
  const view = await describeSoundPlan(episodeId, 1, { audioConfigReady: false })
  const cue = view.cues.find(item => item.id === cueId)
  assert.ok(cue)
  assert.equal(cue?.time_source, 'timeline')
  assert.equal(cue?.can_attach, true)
  assert.equal(cue?.can_generate, false)
  assert.equal(cue?.asset?.id != null, true)
  assert.equal(cue?.attached, true)
})
