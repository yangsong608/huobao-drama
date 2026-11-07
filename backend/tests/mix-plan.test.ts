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
  excludeMixLine,
  hashMixPlan,
  listMixExcludedLines,
  listMixRevisions,
  restoreMixLine,
  restoreMixRevision,
  saveMixPlan,
} = await import('../src/services/mix-plan.ts')
const { updateLine } = await import('../src/services/line-workbench.ts')
const { deleteEpisodeAsset } = await import('../src/services/audio-separation.ts')

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
  origin?: string | null; episodeId?: number
}) {
  return db.insert(schema.episodeAudioTracks).values({
    episodeId: input.episodeId ?? episode.id, dramaId: 1, kind: input.kind, role: input.role, name: input.name,
    volume: 1, pan: 0, busId: input.busId ?? null, muted: input.muted ?? false, solo: input.solo ?? false,
    ducking: input.role !== 'voice', loop: false, locked: false, hidden: false,
    color: '#0ea5e9', height: 72, sortOrder: 10, origin: input.origin ?? null,
    createdAt: ts, updatedAt: ts,
  }).returning().get()
}

function insertClip(trackId: number, input: {
  startMs: number; endMs: number; url: string | null; name?: string; episodeId?: number
}) {
  return db.insert(schema.episodeAudioClips).values({
    trackId, episodeId: input.episodeId ?? episode.id, startMs: input.startMs, endMs: input.endMs,
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
  db.insert(schema.videoMerges).values({
    episodeId: emptyEpisode.id, dramaId: 1, title: '空集成片', provider: 'ffmpeg', model: 'test',
    status: 'completed', kind: 'concat', origin: 'concat', mergedUrl: shotUrl, duration: 2,
    createdAt: ts, completedAt: ts,
  }).run()

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

test('台词时间写回后虚拟对白片段随之移动', async () => {
  try {
    updateLine(line.id, { voiceStartMs: 800 })
    const plan = await compileMixPlan(episode.id, 1)
    const virtual = plan.tracks.find((track) => track.virtual)!
    assert.equal(virtual.clips.length, 1)
    assert.equal(virtual.clips[0].startMs, 800)
    assert.equal(virtual.clips[0].endMs, 1800)
  } finally {
    updateLine(line.id, { voiceStartMs: null })
  }
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
  assert.match(hashMixPlan(first), /^[0-9a-f]{32}$/, 'planHash 与剪辑侧 shortHash 同为 32 位')
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
  assert.match(v1.planHash || '', /^[0-9a-f]{32}$/)
  // 无编辑工程：对齐哈希按 null 写入，旧版语义
  const v1Row = db.select().from(schema.mixRevisions).where(eq(schema.mixRevisions.id, v1.id)).get()!
  assert.equal(v1Row.editSyncHash, null)
  assert.equal(v1Row.dialogueSyncHash, null)

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

const [compatEpisode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 6, title: '第6集', bgmUrl: toneUrl, createdAt: ts, updatedAt: ts,
}).returning().all()
db.insert(schema.videoMerges).values({
  episodeId: compatEpisode.id, dramaId: 1, title: '第6集合片', provider: 'ffmpeg', model: 'test',
  status: 'completed', kind: 'concat', mergedUrl: shotUrl, duration: 2,
  createdAt: ts, completedAt: ts,
}).run()
const [compatStoryboard] = db.insert(schema.storyboards).values({
  episodeId: compatEpisode.id, storyboardNumber: 1, description: '街头', videoUrl: shotUrl,
  createdAt: ts, updatedAt: ts,
}).returning().all()
const [crowdLine] = db.insert(schema.storyboardLines).values({
  episodeId: compatEpisode.id, dramaId: 1, storyboardId: compatStoryboard.id,
  lineNo: 1, sortOrder: 1, speakerType: 'crowd', speakerName: '路人甲',
  text: '快看那边！', speakText: '快看那边！', plannedStartMs: 0, audioDurationMs: 1000,
  audioUrl: toneUrl, status: 'ready', createdAt: ts, updatedAt: ts,
}).returning().all()
const [crowdTake] = db.insert(schema.lineTakes).values({
  lineId: crowdLine.id, episodeId: compatEpisode.id, dramaId: 1, takeNo: 1,
  text: crowdLine.text, speakText: crowdLine.speakText, audioUrl: toneUrl, durationMs: 1000,
  status: 'ready', isActive: true, createdAt: ts,
}).returning().all()

test('生成的环境声轨与原声总床共存，origin 随计划返回', async () => {
  const before = await compileMixPlan(compatEpisode.id, 1)
  assert.ok(
    before.tracks.some((track) => track.virtual && track.role === 'original'),
    '前置条件：合片原声床存在',
  )

  const generated = insertTrack({
    role: 'ambience', kind: 'ambience', name: '环境声（AI）', origin: 'soundscape',
    episodeId: compatEpisode.id,
  })
  insertClip(generated.id, { startMs: 0, endMs: 2000, url: toneUrl, episodeId: compatEpisode.id })

  const plan = await compileMixPlan(compatEpisode.id, 1)
  assert.ok(
    plan.tracks.some((track) => track.virtual && track.role === 'original'),
    'AI 环境声不得关闭合片原声床',
  )
  assert.equal(plan.tracks.find((track) => track.id === generated.id)!.origin, 'soundscape')
  assert.equal(
    plan.tracks.find((track) => track.virtual && track.role === 'voice')!.origin,
    null,
    '虚拟轨 origin 必须为 null',
  )
})

test('群众声轨引用的台词不再进入虚拟对白轨，删除后自动恢复', async () => {
  const before = await compileMixPlan(compatEpisode.id, 1)
  const beforeVoice = before.tracks.find((track) => track.virtual && track.role === 'voice')!
  assert.equal(beforeVoice.clips.length, 1)
  assert.equal(beforeVoice.clips[0].lineId, crowdLine.id)

  const crowdTrack = insertTrack({
    role: 'crowd', kind: 'voice', name: '群众声（AI）', origin: 'soundscape',
    episodeId: compatEpisode.id,
  })
  db.insert(schema.episodeAudioClips).values({
    trackId: crowdTrack.id, episodeId: compatEpisode.id,
    assetId: null, takeId: crowdTake.id, lineId: crowdLine.id,
    startMs: 0, endMs: 1000, sourceStartMs: 0, gainDb: 0, pan: 0,
    fadeInMs: 300, fadeOutMs: 300, fadeCurve: 'linear',
    sourceUrl: toneUrl, audioUrl: toneUrl, status: 'ready', name: '群众台词 · 路人甲',
    createdAt: ts, updatedAt: ts,
  }).run()

  const after = await compileMixPlan(compatEpisode.id, 1)
  assert.equal(
    after.tracks.find((track) => track.virtual && track.role === 'voice')!.clips.length,
    0,
    '已被群众轨放置的台词不得在虚拟对白轨重复播放',
  )

  db.delete(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.trackId, crowdTrack.id)).run()
  db.delete(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.id, crowdTrack.id)).run()
  const restored = await compileMixPlan(compatEpisode.id, 1)
  assert.equal(
    restored.tracks.find((track) => track.virtual && track.role === 'voice')!.clips.length,
    1,
    '删除群众轨后台词回到虚拟对白轨',
  )
})

test('生成 BGM 轨关闭虚拟 BGM，删除生成素材后虚拟 BGM 恢复', async () => {
  const before = await compileMixPlan(compatEpisode.id, 1)
  assert.ok(before.tracks.some((track) => track.virtual && track.role === 'bgm'))

  const bgmTrack = insertTrack({
    role: 'bgm', kind: 'bgm', name: '配乐（AI）', origin: 'soundscape', episodeId: compatEpisode.id,
  })
  const bgmAsset = db.insert(schema.episodeAudioAssets).values({
    episodeId: compatEpisode.id, dramaId: 1, kind: 'soundscape', status: 'ready',
    sourceHash: 'c'.repeat(64), url: toneUrl, durationMs: 2000,
    engine: 'comfyui', model: 'stable-audio-open', createdAt: ts,
  }).returning().get()
  db.insert(schema.episodeAudioClips).values({
    trackId: bgmTrack.id, episodeId: compatEpisode.id, assetId: bgmAsset.id,
    startMs: 0, endMs: 2000, sourceStartMs: 0, gainDb: 0, pan: 0,
    fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear',
    sourceUrl: toneUrl, audioUrl: toneUrl, status: 'ready', name: '本集配乐（AI）',
    createdAt: ts, updatedAt: ts,
  }).run()
  const after = await compileMixPlan(compatEpisode.id, 1)
  assert.equal(after.tracks.some((track) => track.virtual && track.role === 'bgm'), false)

  assert.equal(deleteEpisodeAsset(compatEpisode.id, bgmAsset.id), true)
  const tracks = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, compatEpisode.id)).all()
  assert.ok(tracks.some((track) => track.id === bgmTrack.id), '生成轨保留为空轨')
  const restored = await compileMixPlan(compatEpisode.id, 1)
  assert.ok(
    restored.tracks.some((track) => track.virtual && track.role === 'bgm'),
    '删除生成素材后虚拟 BGM 必须恢复',
  )
})

test('保存混音计划保留生成轨 origin 与片段引用，新轨无法伪造 origin', async () => {
  const [saveEpisode] = db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber: 7, title: '第7集', createdAt: ts, updatedAt: ts,
  }).returning().all()
  db.insert(schema.videoMerges).values({
    episodeId: saveEpisode.id, dramaId: 1, title: '保存集成片', provider: 'ffmpeg', model: 'test',
    status: 'completed', kind: 'concat', origin: 'concat', mergedUrl: shotUrl, duration: 2,
    createdAt: ts, completedAt: ts,
  }).run()
  const asset = db.insert(schema.episodeAudioAssets).values({
    episodeId: saveEpisode.id, dramaId: 1, kind: 'soundscape', status: 'ready',
    sourceHash: 'a'.repeat(64), url: toneUrl, durationMs: 1000,
    engine: 'comfyui', model: 'stable-audio-open', createdAt: ts,
  }).returning().get()
  const track = db.insert(schema.episodeAudioTracks).values({
    episodeId: saveEpisode.id, dramaId: 1, kind: 'ambience', role: 'ambience', name: '环境声（AI）',
    origin: 'soundscape', volume: 0.7, pan: 0, muted: false, solo: false, ducking: true,
    loop: false, locked: false, hidden: false, sortOrder: 0, createdAt: ts, updatedAt: ts,
  }).returning().get()
  const clip = db.insert(schema.episodeAudioClips).values({
    trackId: track.id, episodeId: saveEpisode.id, assetId: asset.id,
    startMs: 0, endMs: 1000, sourceStartMs: 0, gainDb: 0, pan: 0,
    fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear',
    sourceUrl: toneUrl, audioUrl: toneUrl, status: 'ready', name: '场景 1 · 环境声',
    createdAt: ts, updatedAt: ts,
  }).returning().get()

  const saved = await saveMixPlan(saveEpisode.id, 1, {
    tracks: [
      { id: track.id, role: 'ambience', name: '改名后的环境声', busId: 'original', origin: 'sfx' } as any,
      { role: 'sfx', name: '用户音效', origin: 'soundscape' } as any,
    ],
    clips: [
      { id: clip.id, trackId: track.id, assetId: asset.id, startMs: 0, endMs: 1000, audioUrl: toneUrl },
    ],
  })

  const stored = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.id, track.id)).get()!
  assert.equal(stored.origin, 'soundscape', '更新轨道不得覆盖 origin')
  assert.equal(stored.name, '改名后的环境声')

  const storedClip = db.select().from(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.id, clip.id)).get()!
  assert.equal(storedClip.assetId, asset.id)
  assert.equal(storedClip.audioUrl, toneUrl)

  assert.equal(saved.tracks.find((item) => item.id === track.id)!.origin, 'soundscape')
  const userTrack = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, saveEpisode.id)).all()
    .find((item) => item.role === 'sfx')!
  assert.equal(userTrack.origin, null, '新建轨不能由客户端伪造 origin')
})

test('恢复版本时保留生成轨 origin，合片原声床不被误关', async () => {
  const aiTrack = insertTrack({
    role: 'ambience', kind: 'ambience', name: 'AI 环境声', origin: 'soundscape',
    episodeId: bedEpisode.id,
  })
  const revision = await createMixRevision(bedEpisode.id, 'AI 轨快照')
  const before = await compileMixPlan(bedEpisode.id, 1)
  assert.ok(
    before.tracks.some((track) => track.virtual && track.role === 'original'),
    '前置条件：带 AI 环境声时原声总床仍存在',
  )

  db.delete(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.id, aiTrack.id)).run()
  restoreMixRevision(bedEpisode.id, revision.id)

  const stored = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.id, aiTrack.id)).get()
  assert.ok(stored, '版本恢复应重建 AI 轨道')
  assert.equal(stored.origin, 'soundscape', '恢复的生成轨必须保留 origin')

  const restored = await compileMixPlan(bedEpisode.id, 1)
  assert.ok(
    restored.tracks.some((track) => track.virtual && track.role === 'original'),
    '恢复的 AI 环境声不得关闭合片原声床',
  )

  db.delete(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.trackId, aiTrack.id)).run()
  db.delete(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.id, aiTrack.id)).run()
  db.delete(schema.mixRevisions)
    .where(eq(schema.mixRevisions.id, revision.id)).run()
})

test('对白台词可从混音移除并恢复', async () => {
  const before = await compileMixPlan(episode.id, 1)
  const voice = before.tracks.find((track) => track.virtual && track.role === 'voice')!
  assert.equal(voice.clips.length, 1)
  const lineId = voice.clips[0].lineId!

  excludeMixLine(episode.id, lineId)
  const after = await compileMixPlan(episode.id, 1)
  assert.equal(
    after.tracks.find((track) => track.virtual && track.role === 'voice')!.clips.length,
    0,
    '移除后台词不得再出现在虚拟对白轨',
  )
  assert.deepEqual(
    listMixExcludedLines(episode.id).map((row) => row.lineId),
    [lineId],
  )

  restoreMixLine(episode.id, lineId)
  const restored = await compileMixPlan(episode.id, 1)
  assert.equal(
    restored.tracks.find((track) => track.virtual && track.role === 'voice')!.clips.length,
    1,
    '恢复后台词回到虚拟对白轨',
  )
  assert.equal(listMixExcludedLines(episode.id).length, 0)
})

test('移除对白校验台词归属与存在性', () => {
  assert.throws(() => excludeMixLine(episode.id, 999999), /台词不存在/)
  assert.throws(() => restoreMixLine(episode.id, 999999), /台词不存在/)
})

test('虚拟对白轨按角色分轨', async () => {
  const [spkEpisode] = db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber: 4, title: '第4集', createdAt: ts, updatedAt: ts,
  }).returning().all()
  db.insert(schema.videoMerges).values({
    episodeId: spkEpisode.id, dramaId: 1, title: `Episode ${spkEpisode.id}`, provider: 'ffmpeg', model: 'test',
    status: 'completed', kind: 'concat', mergedUrl: shotUrl, duration: 2,
    createdAt: ts, completedAt: ts,
  }).run()
  const [spkStoryboard] = db.insert(schema.storyboards).values({
    episodeId: spkEpisode.id, storyboardNumber: 1, description: '对峙', videoUrl: shotUrl,
    createdAt: ts, updatedAt: ts,
  }).returning().all()
  const insertLine = (lineNo: number, speaker: string, text: string, plannedStartMs: number) =>
    db.insert(schema.storyboardLines).values({
      episodeId: spkEpisode.id, dramaId: 1, storyboardId: spkStoryboard.id,
      lineNo, sortOrder: lineNo, speakerType: 'dialogue', speakerName: speaker,
      text, speakText: text, plannedStartMs, audioDurationMs: 1000, audioUrl: toneUrl,
      status: 'ready', createdAt: ts, updatedAt: ts,
    }).returning().get()
  const lineA = insertLine(1, '林小雨', '你骗了我三年。', 200)
  const lineB = insertLine(2, '顾云舟', '我没有。', 1500)
  const lineC = insertLine(3, '林小雨', '证据呢？', 2800)
  for (const l of [lineA, lineB, lineC]) {
    db.insert(schema.lineTakes).values({
      lineId: l.id, episodeId: spkEpisode.id, dramaId: 1, takeNo: 1,
      text: l.text, speakText: l.speakText, audioUrl: toneUrl, durationMs: 1000,
      status: 'ready', isActive: true, createdAt: ts,
    }).run()
  }

  const plan = await compileMixPlan(spkEpisode.id, 1)
  const voiceTracks = plan.tracks.filter((t) => t.virtual && t.role === 'voice')
  assert.equal(voiceTracks.length, 2, '每个有对白的角色应各有一条虚拟对白轨')
  assert.deepEqual(
    voiceTracks.map((t) => t.name),
    ['林小雨', '顾云舟'],
    '对白轨按首次出场顺序以角色命名',
  )
  assert.deepEqual(voiceTracks[0].clips.map((c) => c.lineId), [lineA.id, lineC.id])
  assert.deepEqual(voiceTracks[1].clips.map((c) => c.lineId), [lineB.id])
  assert.equal(voiceTracks[0].busId, 'dialogue')
  assert.notEqual(voiceTracks[0].color, voiceTracks[1].color, '不同角色轨道颜色应可区分')
})
