/**
 * 剪辑工作台波形：按源地址查询 peaks（复用 audio-peaks 缓存）
 * - 合法站内相对地址：真实 FFmpeg 解码出 4 级 peaks，二次命中缓存
 * - 非法地址：远程 / 越界 / 空值一律 400
 * - 集不存在：404
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-peaks-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { PeaksError, getPeaksForEditSource, computePeaksFromPcm } = await import('../src/services/audio-peaks.ts')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '波形', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()

const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '波形集', createdAt: ts, updatedAt: ts,
}).returning().get()

const audioDir = path.join(root, 'static', 'projects', String(drama.id), 'audio')
fs.mkdirSync(audioDir, { recursive: true })

const wavFile = path.join(audioDir, 'tone.wav')
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-c:a', 'pcm_s16le', wavFile,
], { stdio: 'ignore' })
const wavUrl = `static/projects/${drama.id}/audio/tone.wav`

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('合法源地址返回真实 peaks 且二次查询命中缓存', async () => {
  const payload = await getPeaksForEditSource(episode.id, wavUrl)
  assert.equal(payload.sampleRate, 8000)
  assert.ok(Math.abs(payload.durationMs - 2000) <= 100, `时长应约 2000ms，实际 ${payload.durationMs}`)
  assert.equal(payload.levels.length, 4)
  for (const level of payload.levels) {
    assert.ok(level.peaks.length > 0, `spp=${level.spp} 应有峰值`)
    for (const [min, max] of level.peaks) {
      assert.ok(min >= -1 && min <= 1 && max >= -1 && max <= 1, '峰值应归一化到 [-1,1]')
      assert.ok(max >= min, 'max 不得小于 min')
    }
  }
  // 低分辨率层峰值密度对应 8kHz/128 ≈ 62.5 peaks/s
  const fine = payload.levels[0]
  assert.ok(Math.abs(fine.peaks.length / 2 - 62.5) < 3, `spp=128 应约 125 个峰值，实际 ${fine.peaks.length}`)

  const cached = await getPeaksForEditSource(episode.id, wavUrl)
  assert.equal(cached.durationMs, payload.durationMs)
  assert.deepEqual(cached.levels, payload.levels)
})

test('非法地址（远程/越界/空值）拒绝为 400', async () => {
  for (const bad of ['https://example.com/a.mp4', 'static/../../secret.wav', '../escape.wav', '']) {
    await assert.rejects(
      () => getPeaksForEditSource(episode.id, bad),
      (error: unknown) => error instanceof PeaksError && error.status === 400,
      `应拒绝非法地址：${bad}`,
    )
  }
})

test('集不存在返回 404', async () => {
  await assert.rejects(
    () => getPeaksForEditSource(999999, wavUrl),
    (error: unknown) => error instanceof PeaksError && error.status === 404,
  )
})

test('computePeaksFromPcm 空输入与静音输入', () => {
  const empty = computePeaksFromPcm(new Int16Array(0))
  assert.equal(empty.durationMs, 0)
  assert.equal(empty.levels.length, 0)

  const silence = computePeaksFromPcm(new Int16Array(8000))
  assert.equal(silence.durationMs, 1000)
  for (const [min, max] of silence.levels[0].peaks) {
    assert.equal(min, 0)
    assert.equal(max, 0)
  }
})
