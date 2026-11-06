/**
 * 生成轨与片段放置：四类轨、音效位置、循环与淡化、幂等重建、群众台词归轨。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-soundscape-tracks-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { listAudioTracks } = await import('../src/services/audio-tracks.ts')
const { applySoundscapePlan } = await import('../src/services/soundscape-tracks.ts')
import type { SoundscapeItem, SoundscapePlan } from '../src/services/soundscape-compiler.ts'

const audioFile = path.join(root, 'static', 'audio', 'a.mp3')
fs.mkdirSync(path.dirname(audioFile), { recursive: true })
fs.writeFileSync(audioFile, 'fake-audio')

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: 'Soundscape tracks', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 1,
  title: '第 1 集',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()

function item(patch: Partial<SoundscapeItem>): SoundscapeItem {
  return {
    itemId: 'ambience:scene:10',
    category: 'ambience',
    source: 'generate',
    sceneId: 10,
    storyboardId: null,
    startMs: 0,
    endMs: 9000,
    seconds: 45,
    prompt: 'prompt',
    negativePrompt: 'negative',
    loop: false,
    lineIds: [],
    degraded: false,
    seed: 1,
    sourceHash: 'hash-1',
    cached: false,
    ...patch,
  }
}

function plan(items: SoundscapeItem[], mode: SoundscapePlan['mode'] = 'scenes'): SoundscapePlan {
  return {
    mode,
    items,
    warnings: [],
    counts: { total: items.length, generate: items.filter((entry) => entry.source === 'generate').length, lines: items.filter((entry) => entry.source === 'lines').length, cached: 0 },
    estimatedSeconds: 0,
    degraded: false,
    sceneLabels: { 10: 1 },
    sceneFirstStoryboards: { 10: { startMs: 0, endMs: 5000 } },
    lineCues: {},
  }
}

function assets() {
  return new Map([
    ['hash-1', { id: 501, url: audioFile }],
    ['hash-2', { id: 502, url: audioFile }],
    ['hash-3', { id: 503, url: audioFile }],
    ['hash-4', { id: 504, url: audioFile }],
  ])
}

test('按场景创建四类生成轨与片段，淡化与音效位置正确', () => {
  const result = applySoundscapePlan({
    episodeId: episode.id,
    mode: 'scenes',
    plan: plan([
      item({}),
      item({ itemId: 'sfx:scene:10', category: 'sfx', sourceHash: 'hash-2', seconds: 5 }),
      item({ itemId: 'crowd:scene:10', category: 'crowd', sourceHash: 'hash-3', seconds: 30 }),
      item({ itemId: 'bgm:episode', category: 'bgm', sceneId: null, sourceHash: 'hash-4', endMs: 20000 }),
    ]),
    succeededCategories: new Set(['ambience', 'sfx', 'crowd', 'bgm']),
    assetsByHash: assets(),
    lineRefs: new Map(),
  })
  assert.equal(result.clipCount, 4)
  const tracks = listAudioTracks(episode.id)
  const byRole = new Map(tracks.map((track) => [track.role, track]))
  assert.deepEqual([...byRole.keys()].sort(), ['ambience', 'bgm', 'crowd', 'sfx'])
  assert.equal(byRole.get('ambience')!.origin, 'soundscape')
  assert.equal(byRole.get('ambience')!.name, '环境声（AI）')
  assert.equal(byRole.get('ambience')!.volume, 0.7)
  assert.equal(byRole.get('sfx')!.volume, 0.8)
  assert.equal(byRole.get('crowd')!.volume, 0.5)
  assert.equal(byRole.get('bgm')!.volume, 1)
  assert.equal(byRole.get('crowd')!.kind, 'voice')
  assert.equal(byRole.get('crowd')!.role, 'crowd')

  const buses = db.select().from(schema.audioBuses).where(eq(schema.audioBuses.episodeId, episode.id)).all()
  const busId = (key: string) => buses.find((bus) => bus.key === key)!.id
  assert.equal(byRole.get('ambience')!.busId, busId('original'))
  assert.equal(byRole.get('sfx')!.busId, busId('sfx'))
  assert.equal(byRole.get('crowd')!.busId, busId('dialogue'))
  assert.equal(byRole.get('bgm')!.busId, busId('bgm'))

  const ambience = byRole.get('ambience')!.clips[0]
  assert.deepEqual([ambience.startMs, ambience.endMs, ambience.fadeInMs, ambience.fadeOutMs], [0, 9000, 0, 300])
  assert.equal(ambience.name, '场景 1 · 环境声')
  assert.equal(ambience.assetId, 501)
  assert.equal(ambience.loop, false)

  const sfx = byRole.get('sfx')!.clips[0]
  assert.deepEqual([sfx.startMs, sfx.endMs, sfx.fadeInMs, sfx.fadeOutMs], [150, 5000, 300, 300])
  assert.equal(sfx.name, '场景 1 · 音效')

  const bgm = byRole.get('bgm')!.clips[0]
  assert.deepEqual([bgm.startMs, bgm.endMs, bgm.fadeInMs, bgm.fadeOutMs], [0, 20000, 0, 0])
  assert.equal(bgm.name, '整集配乐')
})

test('重新生成只重建成功类别，失败类别保留旧片段', () => {
  const first = listAudioTracks(episode.id).find((track) => track.role === 'ambience')!
  const oldClipId = first.clips[0].id
  const result = applySoundscapePlan({
    episodeId: episode.id,
    mode: 'scenes',
    plan: plan([
      item({ sourceHash: 'hash-2' }),
      item({ itemId: 'sfx:scene:10', category: 'sfx', sourceHash: 'hash-2' }),
    ]),
    succeededCategories: new Set(['ambience']),
    assetsByHash: assets(),
    lineRefs: new Map(),
  })
  assert.equal(result.clipCount, 1)
  const tracks = listAudioTracks(episode.id)
  const ambience = tracks.find((track) => track.role === 'ambience')!
  assert.equal(ambience.clips.length, 1)
  assert.notEqual(ambience.clips[0].id, oldClipId)
  assert.equal(ambience.clips[0].assetId, 502)
  const sfx = tracks.find((track) => track.role === 'sfx')!
  assert.equal(sfx.clips[0].assetId, 502)
})

test('群众台词模式写入激活 Take，缺少配音只警告', () => {
  const result = applySoundscapePlan({
    episodeId: episode.id,
    mode: 'scenes',
    plan: plan([
      item({
        itemId: 'crowd:scene:10',
        category: 'crowd',
        source: 'lines',
        seconds: 0,
        prompt: '',
        negativePrompt: '',
        lineIds: [201, 202],
        sourceHash: '',
      }),
    ]),
    succeededCategories: new Set(['crowd']),
    assetsByHash: assets(),
    lineRefs: new Map([
      [201, { lineId: 201, lineNo: 3, speaker: '路人甲', startMs: 1000, durationMs: 1200, audioUrl: audioFile, takeId: 77 }],
    ]),
  })
  assert.equal(result.clipCount, 1)
  assert.match(result.warnings.join('\n'), /第 202 句群众台词尚未配音/)
  const crowd = listAudioTracks(episode.id).find((track) => track.role === 'crowd')!
  assert.equal(crowd.clips.length, 1)
  assert.equal(crowd.clips[0].lineId, 201)
  assert.equal(crowd.clips[0].takeId, 77)
  assert.equal(crowd.clips[0].name, '群众台词 · 路人甲')
  assert.deepEqual([crowd.clips[0].startMs, crowd.clips[0].endMs], [1000, 2200])
})

test('assets-only 不创建轨道与片段', () => {
  const drama2 = db.insert(schema.dramas).values({ title: 'Assets only', createdAt: ts, updatedAt: ts }).returning().get()
  const episode2 = db.insert(schema.episodes).values({
    dramaId: drama2.id, episodeNumber: 1, title: '第 1 集', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const result = applySoundscapePlan({
    episodeId: episode2.id,
    mode: 'assets-only',
    plan: plan([item({})], 'assets-only'),
    succeededCategories: new Set(['ambience']),
    assetsByHash: assets(),
    lineRefs: new Map(),
  })
  assert.deepEqual(result, { trackIds: [], clipCount: 0, warnings: [] })
  assert.equal(listAudioTracks(episode2.id).length, 0)
  assert.equal(db.select().from(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.episodeId, episode2.id)).all().length, 0)
})
