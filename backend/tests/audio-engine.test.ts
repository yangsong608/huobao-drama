import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import {
  AudioEngineError,
  buildBasicSeparationFilters,
  getAudioEngineHealth,
  runSeparation,
} from '../src/services/audio-engine.js'
import { probeDurationMs } from '../src/services/audio-mix.js'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

function withoutSidecar(t: { after: (fn: () => void) => void }) {
  const savedUrl = process.env.AUDIO_ENGINE_URL
  const savedToken = process.env.AUDIO_ENGINE_TOKEN
  delete process.env.AUDIO_ENGINE_URL
  delete process.env.AUDIO_ENGINE_TOKEN
  t.after(() => {
    if (savedUrl === undefined) delete process.env.AUDIO_ENGINE_URL
    else process.env.AUDIO_ENGINE_URL = savedUrl
    if (savedToken === undefined) delete process.env.AUDIO_ENGINE_TOKEN
    else process.env.AUDIO_ENGINE_TOKEN = savedToken
  })
}

test('未配置 sidecar 时健康检查回落为基础分离', async (t) => {
  withoutSidecar(t)
  const health = await getAudioEngineHealth()
  assert.equal(health.mode, 'basic')
  assert.deepEqual(health.engines, ['basic'])
  assert.equal(health.available, health.ffmpeg)
  assert.equal(health.url, null)
})

test('基础分离滤镜同时包含中置提取与中置消除', () => {
  const { vocals, instrumental } = buildBasicSeparationFilters()
  assert.match(vocals, /pan=stereo\|c0=0\.5\*c0\+0\.5\*c1\|c1=0\.5\*c0\+0\.5\*c1/)
  assert.match(instrumental, /pan=stereo\|c0=0\.5\*c0-0\.5\*c1\|c1=0\.5\*c1-0\.5\*c0/)
  assert.match(vocals, /aformat=.*sample_rates=48000/)
})

test('请求 uvr 但未配置 sidecar 时抛 engine_unavailable', async (t) => {
  withoutSidecar(t)
  await assert.rejects(
    () => runSeparation(
      { sourcePath: '/tmp/not-a-real-source.wav', engine: 'uvr', outputDir: '/tmp/not-a-real-output' },
      {},
    ),
    (err: unknown) => err instanceof AudioEngineError && err.code === 'engine_unavailable',
  )
})

test('基础分离生成 vocals/instrumental 两路且时长一致', async (t) => {
  withoutSidecar(t)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-engine-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'source.wav')
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1',
    '-filter_complex', '[0:a][1:a]amerge=inputs=2[a]', '-map', '[a]',
    '-ar', '48000', '-ac', '2', source,
  ])

  const result = await runSeparation({ sourcePath: source, engine: 'basic', outputDir: dir }, {})
  assert.equal(result.engine, 'basic')
  assert.equal(result.confidence, null)
  assert.deepEqual(result.stems.map((stem) => stem.kind).sort(), ['instrumental', 'vocals'])
  for (const stem of result.stems) {
    assert.ok(fs.existsSync(stem.path), `${stem.kind} 文件应存在`)
    assert.equal(stem.sampleRate, 48000)
    assert.equal(stem.channels, 2)
    const duration = await probeDurationMs(stem.path)
    assert.ok(Math.abs(duration - 1000) < 120, `${stem.kind} 应约 1000ms，实际 ${duration}`)
  }
})

test('单声道源无法做基础分离，返回明确错误', async (t) => {
  withoutSidecar(t)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-engine-mono-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'mono.wav')
  execFileSync(ffmpegBin, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-ar', '48000', '-ac', '1', source,
  ])
  await assert.rejects(
    () => runSeparation({ sourcePath: source, engine: 'basic', outputDir: dir }, {}),
    (err: unknown) => err instanceof AudioEngineError && err.code === 'mono_source',
  )
})
