/**
 * MixPlan 编译（设计 8.5）：总线、虚拟对白轨、solo、缺失素材、版本快照。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-mix-plan-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const {
  compileMixPlan,
  createMixRevision,
  ensureDefaultBuses,
  hashMixPlan,
  listMixRevisions,
  restoreMixRevision,
  saveMixPlan,
} = await import('../src/services/mix-plan.ts')

const ts = '2026-11-05T00:00:00.000Z'
db.insert(schema.dramas).values({ title: 'MixPlan 测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
const [episode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
}).returning().all()

const projectRoot = path.join(root, 'static', 'projects', '1')
const audioDir = path.join(projectRoot, 'audio')
const videoDir = path.join(projectRoot, 'videos')
await fs.mkdir(audioDir, { recursive: true })
await fs.mkdir(videoDir, { recursive: true })
const tonePath = path.join(audioDir, 'tone.wav')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-ar', '48000', '-ac', '2', tonePath,
])
const shotPath = path.join(videoDir, 'shot.mp4')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2',
  '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
  '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', '-ar', '48000', shotPath,
])
const silentShotPath = path.join(videoDir, 'shot-no-audio.mp4')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=2',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', silentShotPath,
])
const toneUrl = 'static/projects/1/audio/tone.wav'
const shotUrl = 'static/projects/1/videos/shot.mp4'
const silentShotUrl = 'static/projects/1/videos/shot-no-audio.mp4'

const [storyboard] = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, description: '雨夜', videoUrl: shotUrl,
  createdAt: ts, updatedAt: ts,
}).returning().all()
const [line] = db.insert(schema.storyboardLines).values({
  episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id,
  lineNo: 1, sortOrder: 1, speakerType: 'dialogue', speakerName: '林小雨',
  text: '你骗了我三年。', speakText: '你骗了我三年。',
  plannedStartMs: 200, audioDurationMs: 1000, audioUrl: toneUrl,
  status: 'ready', createdAt: ts, updatedAt: ts,
}).returning().all()
const [take] = db.insert(schema.lineTakes).values({
  lineId: line.id, episodeId: episode.id, dramaId: 1, takeNo: 1,
  text: line.text, speakText: line.speakText, audioUrl: toneUrl, durationMs: 1000,
  status: 'ready', isActive: true, createdAt: ts,
}).returning().all()

function insertTrack(input: {
  role: string; kind: string; name: string; solo?: boolean; muted?: boolean; busId?: number | null
}) {
  return db.insert(schema.episodeAudioTracks).values({
    episodeId: episode.id, dramaId: 1, kind: input.kind, role: input.role, name: input.name,
    volume: 1, pan: 0, busId: input.busId ?? null, muted: input.muted ?? false, solo: input.solo ?? false,
    ducking: input.role !== 'voice', loop: false, locked: false, hidden: false,
    color: '#0ea5e9', height: 72, sortOrder: 10, createdAt: ts, updatedAt: ts,
  }).returning().get()
}

function insertClip(trackId: number, input: { startMs: number; endMs: number; url: string | null; name?: string }) {
  return db.insert(schema.episodeAudioClips).values({
    trackId, episodeId: episode.id, startMs: input.startMs, endMs: input.endMs,
    sourceStartMs: 0, gainDb: 0, pan: 0, fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear',
    sourceUrl: input.url, audioUrl: input.url, status: 'ready', name: input.name || null,
    createdAt: ts, updatedAt: ts,
  }).returning().get()
}

const ambience = insertTrack({ role: 'ambience', kind: 'ambience', name: '环境声' })
insertClip(ambience.id, { startMs: 0, endMs: 1000, url: toneUrl })
const bgm = insertTrack({ role: 'bgm', kind: 'bgm', name: '配乐' })
insertClip(bgm.id, { startMs: 0, endMs: 2000, url: toneUrl })
const missing = insertTrack({ role: 'sfx', kind: 'sfx', name: '缺失音效' })
insertClip(missing.id, { startMs: 500, endMs: 1500, url: 'static/projects/1/audio/missing.wav' })

const [bedEpisode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 3, title: '第3集', bgmUrl: toneUrl, createdAt: ts, updatedAt: ts,
}).returning().all()
for (const episodeId of [episode.id, bedEpisode.id]) {
  db.insert(schema.videoMerges).values({
    episodeId, dramaId: 1, title: `Episode ${episodeId}`, provider: 'ffmpeg', model: 'test',
    status: 'completed', kind: 'concat', mergedUrl: shotUrl, duration: 2,
    createdAt: ts, completedAt: ts,
  }).run()
}

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('空轨道也生成默认总线与虚拟对白轨', async () => {
  const [emptyEpisode] = db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber: 2, title: '第2集', createdAt: ts, updatedAt: ts,
  }).returning().all()
  const created = ensureDefaultBuses(emptyEpisode.id)
  assert.deepEqual(created.map((bus) => bus.key), ['dialogue', 'original', 'sfx', 'bgm', 'master'])
  const again = ensureDefaultBuses(emptyEpisode.id)
  assert.deepEqual(again.map((bus) => bus.id), created.map((bus) => bus.id))

  const plan = await compileMixPlan(emptyEpisode.id, 1)
  assert.equal(plan.buses.length, 5)
  const virtual = plan.tracks.find((track) => track.virtual)
  assert.ok(virtual, '应生成虚拟对白轨')
  assert.equal(virtual.role, 'voice')
  assert.equal(virtual.busId, 'dialogue')
  assert.equal(virtual.clips.length, 0)
})

test('虚拟对白轨引用激活 Take 与时间轴起点', async () => {
  const plan = await compileMixPlan(episode.id, 1)
  const virtual = plan.tracks.find((track) => track.virtual)!
  assert.equal(virtual.clips.length, 1)
  assert.equal(virtual.clips[0].lineId, line.id)
  assert.equal(virtual.clips[0].takeId, take.id)
  assert.equal(virtual.clips[0].startMs, 250)
  assert.equal(virtual.clips[0].usable, true)
})

test('缺失素材标 unusable 且不中断编译', async () => {
  const plan = await compileMixPlan(episode.id, 1)
  const track = plan.tracks.find((item) => item.id === missing.id)!
  assert.ok(track)
  const clip = track.clips[0]
  assert.equal(clip.usable, false)
  assert.ok(clip.reason)
  assert.equal(track.clips.length, 1)
})

test('solo 派生 effectiveMuted，不改写 muted 原值', async () => {
  db.update(schema.episodeAudioTracks).set({ solo: true }).where(eq(schema.episodeAudioTracks.id, ambience.id)).run()
  const plan = await compileMixPlan(episode.id, 1)
  const ambienceTrack = plan.tracks.find((item) => item.id === ambience.id)!
  const bgmTrack = plan.tracks.find((item) => item.id === bgm.id)!
  const virtual = plan.tracks.find((item) => item.virtual)!
  assert.equal(ambienceTrack.effectiveMuted, false)
  assert.equal(bgmTrack.effectiveMuted, true)
  assert.equal(virtual.effectiveMuted, true)
  assert.equal(bgmTrack.muted, false)
  assert.equal(plan.buses.find((bus) => bus.key === 'master')!.effectiveMuted, false, 'solo 不应静音主输出')

  const stored = db.select().from(schema.episodeAudioTracks).where(eq(schema.episodeAudioTracks.id, bgm.id)).get()!
  assert.equal(stored.muted, false)
  db.update(schema.episodeAudioTracks).set({ solo: false }).where(eq(schema.episodeAudioTracks.id, ambience.id)).run()
})

test('solo 能试听默认静音轨并保持所属总线开启', async () => {
  db.update(schema.episodeAudioTracks)
    .set({ muted: true, solo: true })
    .where(eq(schema.episodeAudioTracks.id, ambience.id))
    .run()
  const plan = await compileMixPlan(episode.id, 1)
  const track = plan.tracks.find((item) => item.id === ambience.id)!
  assert.equal(track.effectiveMuted, false, 'solo 必须压过轨道自身静音')
  assert.equal(track.muted, true, 'solo 不应改写 muted 原值')
  assert.equal(plan.buses.find((bus) => bus.key === 'original')!.effectiveMuted, false, '所属总线必须保持开启')
  assert.equal(plan.tracks.find((item) => item.id === bgm.id)!.effectiveMuted, true)
  assert.equal(plan.buses.find((bus) => bus.key === 'bgm')!.effectiveMuted, true)
  db.update(schema.episodeAudioTracks)
    .set({ muted: false, solo: false })
    .where(eq(schema.episodeAudioTracks.id, ambience.id))
    .run()
})

test('总线 solo 让未 solo 总线上的轨道静音', async () => {
  const buses = ensureDefaultBuses(episode.id)
  const bgmBus = buses.find((bus) => bus.key === 'bgm')!
  db.update(schema.audioBuses).set({ solo: true }).where(eq(schema.audioBuses.id, bgmBus.id)).run()
  const plan = await compileMixPlan(episode.id, 1)
  assert.equal(plan.tracks.find((item) => item.id === bgm.id)!.effectiveMuted, false)
  assert.equal(plan.tracks.find((item) => item.id === ambience.id)!.effectiveMuted, true)
  assert.equal(plan.buses.find((bus) => bus.key === 'bgm')!.effectiveMuted, false)
  db.update(schema.audioBuses).set({ solo: false }).where(eq(schema.audioBuses.id, bgmBus.id)).run()
})

test('总线 solo 只隔离其他总线，不覆盖轨自身静音', async () => {
  const buses = ensureDefaultBuses(episode.id)
  const originalBus = buses.find((bus) => bus.key === 'original')!
  db.update(schema.episodeAudioTracks).set({ muted: true }).where(eq(schema.episodeAudioTracks.id, ambience.id)).run()
  db.update(schema.audioBuses).set({ solo: true }).where(eq(schema.audioBuses.id, originalBus.id)).run()
  const plan = await compileMixPlan(episode.id, 1)
  assert.equal(
    plan.tracks.find((item) => item.id === ambience.id)!.effectiveMuted,
    true,
    '总线 solo 不应放出该总线上被静音的轨道',
  )
  assert.equal(plan.buses.find((bus) => bus.key === 'original')!.effectiveMuted, false)
  assert.equal(plan.tracks.find((item) => item.id === bgm.id)!.effectiveMuted, true, '其他总线保持静音')
  db.update(schema.audioBuses).set({ solo: false }).where(eq(schema.audioBuses.id, originalBus.id)).run()
  db.update(schema.episodeAudioTracks).set({ muted: false }).where(eq(schema.episodeAudioTracks.id, ambience.id)).run()
})

test('plan hash 内容稳定，改音量后变化', async () => {
  const first = await compileMixPlan(episode.id, 1)
  const second = await compileMixPlan(episode.id, 1)
  assert.equal(hashMixPlan(first), hashMixPlan(second))
  db.update(schema.episodeAudioTracks).set({ volume: 0.5 }).where(eq(schema.episodeAudioTracks.id, ambience.id)).run()
  const changed = await compileMixPlan(episode.id, 1)
  assert.notEqual(hashMixPlan(first), hashMixPlan(changed))
  db.update(schema.episodeAudioTracks).set({ volume: 1 }).where(eq(schema.episodeAudioTracks.id, ambience.id)).run()
})

test('版本创建与恢复保持 is_current 唯一', async () => {
  const v1 = await createMixRevision(episode.id, '初版')
  assert.equal(v1.revisionNo, 1)
  assert.equal(v1.isCurrent, true)
  assert.match(v1.planHash || '', /^[0-9a-f]{64}$/)

  db.update(schema.episodeAudioTracks).set({ volume: 0.7 }).where(eq(schema.episodeAudioTracks.id, ambience.id)).run()
  const v2 = await createMixRevision(episode.id, '调整')
  assert.equal(v2.revisionNo, 2)
  const listed = listMixRevisions(episode.id)
  assert.equal(listed.filter((item) => item.isCurrent).length, 1)
  assert.equal(listed[0].id, v2.id)

  const restored = restoreMixRevision(episode.id, v1.id)
  assert.equal(restored.revision.id, v1.id)
  const after = listMixRevisions(episode.id)
  assert.equal(after.find((item) => item.id === v1.id)!.isCurrent, true)
  assert.equal(after.find((item) => item.id === v2.id)!.isCurrent, false)
  assert.equal(after.filter((item) => item.isCurrent).length, 1)

  const plan = await compileMixPlan(episode.id, 1)
  assert.equal(plan.tracks.find((item) => item.name === '环境声')!.volume, 1)
})

test('合片原声总床与本集 BGM 进入虚拟轨', async () => {
  const plan = await compileMixPlan(bedEpisode.id, 1)
  const original = plan.tracks.find((track) => track.virtual && track.role === 'original')
  assert.ok(original, '应生成原声总床')
  assert.equal(original.name, '原声总床')
  assert.equal(original.busId, 'original')
  assert.equal(original.clips.length, 1)
  assert.equal(original.clips[0].startMs, 0)
  assert.equal(original.clips[0].endMs, 2000)
  assert.equal(original.clips[0].audioUrl, shotUrl)
  assert.equal(original.clips[0].usable, true)

  const bgmTrack = plan.tracks.find((track) => track.virtual && track.role === 'bgm')
  assert.ok(bgmTrack, '应生成本集 BGM')
  assert.equal(bgmTrack.name, '配乐')
  assert.equal(bgmTrack.loop, true)
  assert.equal(bgmTrack.clips.length, 1)
  assert.equal(bgmTrack.clips[0].audioUrl, toneUrl)
  assert.equal(bgmTrack.clips[0].endMs, 2000)
  assert.equal(bgmTrack.clips[0].fadeOutMs, 2000)
  assert.equal(plan.durationMs, 2000)
  assert.equal(plan.tracks[0].role, 'voice', '虚拟对白轨保持第一')
})

test('虚拟轨覆盖可保存、参与 solo 派生并在版本恢复后回写', async () => {
  const saved = await saveMixPlan(bedEpisode.id, 1, {
    tracks: [],
    clips: [],
    virtualTracks: [
      { role: 'voice', volume: 0.4, muted: true },
      { role: 'bgm', solo: true },
    ],
  })
  const voice = saved.tracks.find((track) => track.virtual && track.role === 'voice')!
  const bgmVirtual = saved.tracks.find((track) => track.virtual && track.role === 'bgm')!
  assert.equal(voice.volume, 0.4)
  assert.equal(voice.muted, true)
  assert.equal(voice.effectiveMuted, true)
  assert.equal(bgmVirtual.solo, true)
  assert.equal(bgmVirtual.effectiveMuted, false, '虚拟 BGM solo 后应可听')

  const revision = await createMixRevision(bedEpisode.id, '虚拟轨快照')
  await saveMixPlan(bedEpisode.id, 1, {
    tracks: [],
    clips: [],
    virtualTracks: [
      { role: 'voice', volume: 1, muted: false },
      { role: 'bgm', solo: false },
    ],
  })
  const reset = await compileMixPlan(bedEpisode.id, 1)
  assert.equal(reset.tracks.find((track) => track.virtual && track.role === 'voice')!.volume, 1)
  assert.equal(reset.tracks.find((track) => track.virtual && track.role === 'bgm')!.solo, false)

  restoreMixRevision(bedEpisode.id, revision.id)
  const restored = await compileMixPlan(bedEpisode.id, 1)
  const restoredVoice = restored.tracks.find((track) => track.virtual && track.role === 'voice')!
  const restoredBgm = restored.tracks.find((track) => track.virtual && track.role === 'bgm')!
  assert.equal(restoredVoice.volume, 0.4)
  assert.equal(restoredVoice.muted, true)
  assert.equal(restoredBgm.solo, true)
})

test('已有原声/BGM 用户轨时不再生成重复虚拟轨', async () => {
  const plan = await compileMixPlan(episode.id, 1)
  assert.equal(plan.tracks.some((track) => track.virtual && track.role === 'original'), false)
  assert.equal(plan.tracks.some((track) => track.virtual && track.role === 'bgm'), false)
})

test('无声集不生成原声总床', async () => {
  const [silentEpisode] = db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber: 4, title: '第4集', videoAudioMode: 'silent',
    bgmUrl: toneUrl, createdAt: ts, updatedAt: ts,
  }).returning().all()
  db.insert(schema.videoMerges).values({
    episodeId: silentEpisode.id, dramaId: 1, title: '第4集合片', provider: 'ffmpeg', model: 'test',
    status: 'completed', kind: 'concat', mergedUrl: shotUrl, duration: 2,
    createdAt: ts, completedAt: ts,
  }).run()

  const plan = await compileMixPlan(silentEpisode.id, 1)
  assert.equal(plan.tracks.some((track) => track.virtual && track.role === 'original'), false)
  assert.equal(plan.tracks.some((track) => track.virtual && track.role === 'bgm'), true)
})

test('合片无音频流时不生成原声总床', async () => {
  const [noAudioEpisode] = db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber: 5, title: '第5集', createdAt: ts, updatedAt: ts,
  }).returning().all()
  db.insert(schema.videoMerges).values({
    episodeId: noAudioEpisode.id, dramaId: 1, title: '第5集合片', provider: 'ffmpeg', model: 'test',
    status: 'completed', kind: 'concat', mergedUrl: silentShotUrl, duration: 2,
    createdAt: ts, completedAt: ts,
  }).run()

  const plan = await compileMixPlan(noAudioEpisode.id, 1)
  assert.equal(plan.tracks.some((track) => track.virtual && track.role === 'original'), false)
  assert.equal(
    plan.tracks.some((track) => track.clips.some((clip) => clip.audioUrl === silentShotUrl)),
    false,
    '无音轨合片不应成为任何轨道素材',
  )
})
