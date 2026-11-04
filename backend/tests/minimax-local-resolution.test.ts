/**
 * MiniMax 适配器：本地 shim 的档位/比例透传
 *
 * 官方只认 768P / 2K，480p 与 720p 会被压成同一档；图生视频又不带 ratio。
 * 本地 shim 需要更细的档位和显式比例才能算对画布，所以只在本地目标上补扩展字段，
 * 云端请求必须保持官方 schema 不变（多传字段可能被严格校验拒绝）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MiniMaxVideoAdapter } from '../src/services/adapters/minimax-video.ts'
import type { AIConfig, VideoGenerationRecord } from '../src/services/adapters/types.ts'

const adapter = new MiniMaxVideoAdapter()

const localConfig: AIConfig = {
  provider: 'minimax',
  baseUrl: 'http://127.0.0.1:8190',
  apiKey: 'local',
  model: 'MiniMax-H3',
}

const cloudConfig: AIConfig = {
  provider: 'minimax',
  baseUrl: 'https://api.minimax.chat',
  apiKey: 'sk-test',
  model: 'MiniMax-H3',
}

const record = (patch: Partial<VideoGenerationRecord> = {}): VideoGenerationRecord => ({
  id: 1,
  model: 'MiniMax-H3',
  prompt: '雨夜，沈砚推门而入',
  duration: 10,
  resolution: '720p',
  aspectRatio: '9:16',
  firstFrameUrl: 'http://127.0.0.1:8190/files/first.png',
  ...patch,
})

test('本地 shim：透传档位与竖屏比例，同时保留官方 resolution 字段', () => {
  const req = adapter.buildGenerateRequest(localConfig, record())
  assert.equal(req.body.resolution, '768P')
  assert.equal(req.body.resolution_tier, '720p')
  assert.equal(req.body.aspect_ratio, '9:16')
  // 有首帧时官方不允许 ratio，保持省略
  assert.equal(req.body.ratio, undefined)
})

test('本地 shim：1080p 仍映射到官方 2K，档位原样带给画布换算', () => {
  const req = adapter.buildGenerateRequest(localConfig, record({ resolution: '1080p', firstFrameUrl: null }))
  assert.equal(req.body.resolution, '2K')
  assert.equal(req.body.resolution_tier, '1080p')
  assert.equal(req.body.aspect_ratio, '9:16')
  // 文生视频按官方要求必须带 ratio
  assert.equal(req.body.ratio, '9:16')
})

test('本地 shim：480p 走自有档位，官方 resolution 用 H3 能接受的 480P', () => {
  const req = adapter.buildGenerateRequest(localConfig, record({ resolution: '480p', firstFrameUrl: null }))
  assert.equal(req.body.resolution, '480P')
  assert.equal(req.body.resolution_tier, '480p')
  assert.equal(req.body.aspect_ratio, '9:16')
  assert.equal(req.body.ratio, '9:16')
})

test('本地 shim：ambient / silent 都透传，native 不写扩展字段', () => {
  const ambient = adapter.buildGenerateRequest(localConfig, record({ audioMode: 'ambient' }))
  assert.equal(ambient.body.audio_mode, 'ambient')

  const silent = adapter.buildGenerateRequest(localConfig, record({ audioMode: 'silent' }))
  assert.equal(silent.body.audio_mode, 'silent')

  const native = adapter.buildGenerateRequest(localConfig, record({ audioMode: 'native' }))
  assert.equal(Object.prototype.hasOwnProperty.call(native.body, 'audio_mode'), false)
})

test('本地 shim：分辨率为空时不写档位字段，比例回落到 16:9', () => {
  const req = adapter.buildGenerateRequest(localConfig, record({ resolution: null, aspectRatio: null }))
  assert.equal(req.body.resolution_tier, undefined)
  assert.equal(req.body.aspect_ratio, '16:9')
})

test('云端：不带任何本地扩展字段，schema 与官方一致', () => {
  const req = adapter.buildGenerateRequest(cloudConfig, record({ resolution: '1080p' }))
  assert.equal(req.body.resolution, '2K')
  assert.equal(Object.prototype.hasOwnProperty.call(req.body, 'resolution_tier'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(req.body, 'aspect_ratio'), false)
})

test('自定义端口的本地 shim 也认（不限 127.0.0.1）', () => {
  const req = adapter.buildGenerateRequest({ ...localConfig, baseUrl: 'http://192.168.1.20:8190' }, record())
  assert.equal(req.body.resolution_tier, '720p')
  assert.equal(req.body.aspect_ratio, '9:16')
})
