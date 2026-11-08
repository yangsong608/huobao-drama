import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  durationSupportError,
  imageModelSupportsReferenceImages,
  imageReferenceLimit,
  resolutionSupportError,
  textModelSupportsVision,
  videoMaxDuration,
  videoModelCapabilities,
  videoResolutionTier,
  videoResolutionTiers,
} from '../src/services/model-capabilities.ts'

test('Seedance 2.0 mini/fast cap at 720p while the standard model supports 1080p', () => {
  const mini = videoModelCapabilities('volcengine', 'doubao-seedance-2-0-mini-260615')
  assert.deepEqual(mini.resolutions, ['480p', '720p'])
  assert.equal(mini.family, 'seedance-2.0-fast')
  assert.equal(resolutionSupportError('volcengine', 'doubao-seedance-2-0-mini-260615', '1080p')?.includes('480p / 720p'), true)

  const fast = videoModelCapabilities('volcengine', 'doubao-seedance-2-0-fast-260128')
  assert.deepEqual(fast.resolutions, ['480p', '720p'])

  const standard = videoModelCapabilities('volcengine', 'doubao-seedance-2-0-260128')
  assert.deepEqual(standard.resolutions, ['480p', '720p', '1080p'])
  assert.equal(standard.vendorResolutions['1080p'], '1080p')
  assert.equal(resolutionSupportError('volcengine', 'doubao-seedance-2-0-260128', '1080p'), null)
  assert.equal(standard.referenceImages, 9)
})

test('Seedance 1.x keeps three tiers and only i2v accepts a single reference image', () => {
  const t2v = videoModelCapabilities('volcengine', 'doubao-seedance-1-0-lite-t2v-250428')
  assert.deepEqual(t2v.resolutions, ['480p', '720p', '1080p'])
  assert.equal(t2v.referenceImages, 0)
  assert.equal(t2v.referenceVideos, 0)

  const i2v = videoModelCapabilities('volcengine', 'doubao-seedance-1-0-lite-i2v-250428')
  assert.equal(i2v.referenceImages, 1)
})

test('MiniMax H3 variants expose their real tiers and vendor names', () => {
  const h3 = videoModelCapabilities('minimax', 'MiniMax-H3')
  assert.deepEqual(h3.resolutions, ['720p', '1080p'])
  assert.equal(h3.vendorResolutions['720p'], '768P')
  assert.equal(h3.vendorResolutions['1080p'], '2K')
  assert.equal(resolutionSupportError('minimax', 'MiniMax-H3', '480p')?.includes('768P / 2K'), true)

  assert.deepEqual(videoModelCapabilities('minimax', 'MiniMax-H3-Highspeed').resolutions, ['720p'])
  assert.deepEqual(videoModelCapabilities('minimax', 'MiniMax-H3-Lite').resolutions, ['480p', '720p'])
  assert.equal(videoModelCapabilities('minimax', 'MiniMax-H3-Highspeed').vendorResolutions['720p'], '768P')
})

test('本地 MiniMax shim 的 H3 支持 480p/720p，1080p 超出 24GB 显存能力', () => {
  const local = videoModelCapabilities('minimax', 'MiniMax-H3', { localShim: true })
  assert.deepEqual(local.resolutions, ['480p', '720p'])
  assert.equal(local.vendorResolutions['480p'], '480P')
  assert.equal(resolutionSupportError('minimax', 'MiniMax-H3', '480p', { localShim: true }), null)
  assert.match(String(resolutionSupportError('minimax', 'MiniMax-H3', '1080p', { localShim: true })), /不支持/)
  // shim 只实现了图片参考与首尾帧，音频/视频参考必须显式声明为 0
  assert.equal(local.referenceImages, 9)
  assert.equal(local.referenceVideos, 0)
  assert.equal(local.referenceAudios, 0)

  const cloud = videoModelCapabilities('minimax', 'MiniMax-H3')
  assert.deepEqual(cloud.resolutions, ['720p', '1080p'])
  assert.match(String(resolutionSupportError('minimax', 'MiniMax-H3', '480p')), /不支持/)
})

test('本地 H3 的 720p 时长上限为 8 秒，480p 保持 15 秒', () => {
  const options = { localShim: true }
  assert.equal(videoMaxDuration('minimax', 'MiniMax-H3', '720p', options), 8)
  assert.equal(videoMaxDuration('minimax', 'MiniMax-H3', '480p', options), 15)
  assert.equal(videoMaxDuration('minimax', 'MiniMax-H3', '720p'), 15)
  assert.equal(videoMaxDuration('minimax', 'MiniMax-H3', '1080p'), 15)

  assert.match(String(durationSupportError('minimax', 'MiniMax-H3', '720p', 10, options)), /8 秒/)
  assert.equal(durationSupportError('minimax', 'MiniMax-H3', '720p', 8, options), null)
  assert.equal(durationSupportError('minimax', 'MiniMax-H3', '480p', 15, options), null)
  assert.match(String(durationSupportError('minimax', 'MiniMax-H3', '480p', 16, options)), /15 秒/)
  assert.equal(durationSupportError('minimax', 'MiniMax-H3', '720p', 10), null)
})

test('Wan 3.0 exposes all tiers and more references than Wan 2.x', () => {
  const wan3 = videoModelCapabilities('aliyun', 'wan3.0-video')
  assert.deepEqual(wan3.resolutions, ['480p', '720p', '1080p'])
  assert.equal(wan3.vendorResolutions['1080p'], '1080P')
  assert.equal(wan3.referenceImages, 10)
  assert.equal(wan3.minDuration, 2)
  assert.equal(wan3.maxDuration, 30)
  // Wan 3.0 的 parameters.audio 默认 true，必须按原生音频模型对待
  assert.equal(wan3.nativeAudio, true)

  const wan2i2v = videoModelCapabilities('aliyun', 'wan2.2-i2v-plus')
  assert.equal(wan2i2v.referenceImages, 1)
  const wan2t2v = videoModelCapabilities('aliyun', 'wan2.2-t2v-plus')
  assert.equal(wan2t2v.referenceImages, 0)
})

test('first/last frame support follows real model families', () => {
  // 首尾帧过渡依赖模型同时接受首帧与尾帧
  assert.equal(videoModelCapabilities('aliyun', 'wan3.0-video').firstLastFrame, true)
  assert.equal(videoModelCapabilities('aliyun', 'wan2.2-i2v-plus').firstLastFrame, false)
  assert.equal(videoModelCapabilities('aliyun', 'wan2.2-t2v-plus').firstLastFrame, false)

  assert.equal(videoModelCapabilities('volcengine', 'doubao-seedance-2-0-260128').firstLastFrame, true)
  assert.equal(videoModelCapabilities('volcengine', 'doubao-seedance-2-5-260901').firstLastFrame, true)
  assert.equal(videoModelCapabilities('volcengine', 'doubao-seedance-1-0-lite-i2v-250428').firstLastFrame, true)
  assert.equal(videoModelCapabilities('volcengine', 'doubao-seedance-1-0-lite-t2v-250428').firstLastFrame, false)

  assert.equal(videoModelCapabilities('minimax', 'MiniMax-H3').firstLastFrame, true)
  assert.equal(videoModelCapabilities('minimax', 'MiniMax-H3', { localShim: true }).firstLastFrame, true)
  assert.equal(videoModelCapabilities('comfyui', 'comfyui-video').firstLastFrame, true)
})

test('videoResolutionTiers preserves a stored tier the new model no longer supports', () => {
  assert.deepEqual(videoResolutionTiers('volcengine', 'doubao-seedance-2-0-mini-260615', '1080p'), ['480p', '720p', '1080p'])
  assert.deepEqual(videoResolutionTiers('minimax', 'MiniMax-H3', undefined), ['720p', '1080p'])
  assert.equal(videoResolutionTier('768P'), '720p')
  assert.equal(videoResolutionTier('2K'), '1080p')
  assert.equal(videoResolutionTier('nonsense'), '')
})

test('image reference support follows model families instead of provider defaults', () => {
  assert.equal(imageModelSupportsReferenceImages('aliyun', 'qwen-image'), false)
  assert.equal(imageModelSupportsReferenceImages('aliyun', 'qwen-image-edit'), true)
  assert.equal(imageReferenceLimit('aliyun', 'qwen-image-edit'), 3)
  assert.equal(imageModelSupportsReferenceImages('openai', 'dall-e-3'), false)
  assert.equal(imageModelSupportsReferenceImages('openai', 'gpt-image-2'), true)
  assert.equal(imageModelSupportsReferenceImages('gemini', 'gemini-3-pro-image'), true)
  assert.equal(imageModelSupportsReferenceImages('volcengine', 'doubao-seedream-3-0-t2i-250415'), true)
  assert.equal(imageModelSupportsReferenceImages('comfyui', 'comfyui-image'), true)
})

test('vision support filters image generators and known text-only models', () => {
  assert.equal(textModelSupportsVision('gemini', 'gemini-3.1-pro-preview'), true)
  assert.equal(textModelSupportsVision('openai', 'gpt-4o'), true)
  assert.equal(textModelSupportsVision('aliyun', 'qwen-vl-max'), true)
  assert.equal(textModelSupportsVision('openai', 'deepseek-v4-pro'), false)
  assert.equal(textModelSupportsVision('aliyun', 'qwen-image'), false)
  assert.equal(textModelSupportsVision('openai', ''), false)
  assert.equal(textModelSupportsVision('openai', 'my-local-vision-model'), true)
})
