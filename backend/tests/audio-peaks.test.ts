import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-peaks-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { computePeaksFromPcm, getPeaksForAsset } = await import('../src/services/audio-peaks.ts')
const { db, schema } = await import('../src/db/index.ts')

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('PCM 归一化与四层桶数正确', () => {
  const payload = computePeaksFromPcm(Int16Array.from([0, 16384, -32768, 32767]), 8000)
  assert.equal(payload.sampleRate, 8000)
  assert.deepEqual(payload.levels.map((level) => level.spp), [128, 512, 2048, 8192])
  for (const level of payload.levels) {
    assert.equal(level.peaks.length, 1)
    const [min, max] = level.peaks[0]
    assert.ok(Math.abs(min - (-1)) < 0.0001, `min 应为 -1，实际 ${min}`)
    assert.ok(Math.abs(max - 32767 / 32768) < 0.0001, `max 应归一化，实际 ${max}`)
  }
})

test('每层桶数符合 ceil(samples/spp)', () => {
  const samples = new Int16Array(300)
  for (let i = 0; i < samples.length; i += 1) samples[i] = i % 2 ? 1000 : -1000
  const payload = computePeaksFromPcm(samples, 8000)
  const expected = [3, 1, 1, 1]
  payload.levels.forEach((level, index) => {
    assert.equal(level.peaks.length, expected[index])
  })
})

test('空输入返回空 levels', () => {
  const payload = computePeaksFromPcm(new Int16Array(0), 8000)
  assert.deepEqual(payload.levels, [])
  assert.equal(payload.durationMs, 0)
})

test('素材 peaks：解码 8kHz 单声道并带 assetId 与时长', async () => {
  const ts = '2026-11-05T00:00:00.000Z'
  db.insert(schema.dramas).values({ title: '波形测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
  const [episode] = db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts,
  }).returning().all()

  const audioDir = path.join(root, 'static', 'projects', '1', 'audio')
  await fs.mkdir(audioDir, { recursive: true })
  const file = path.join(audioDir, 'tone.wav')
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-ar', '48000', '-ac', '2', file,
  ])
  const [asset] = db.insert(schema.episodeAudioAssets).values({
    episodeId: episode.id,
    dramaId: 1,
    kind: 'vocals',
    url: 'static/projects/1/audio/tone.wav',
    durationMs: 1000,
    sampleRate: 48000,
    channels: 2,
    engine: 'basic',
    status: 'ready',
    createdAt: ts,
  }).returning().all()

  const payload = await getPeaksForAsset(episode.id, asset.id)
  assert.equal(payload.assetId, asset.id)
  assert.equal(payload.sampleRate, 8000)
  assert.ok(Math.abs((payload.durationMs || 0) - 1000) < 50, `时长应约 1000ms，实际 ${payload.durationMs}`)
  assert.equal(payload.levels.length, 4)
  assert.ok(payload.levels[0].peaks.length > 0)
})
