import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  imageModelSupportsReferenceImages,
  imageReferenceLimit,
  resolutionSupportError,
  textModelSupportsVision,
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

test('本地 MiniMax shim 的 H3 额外支持 480p，云端仍只认 720p/1080p', () => {
  const local = videoModelCapabilities('minimax', 'MiniMax-H3', { localShim: true })
  assert.deepEqual(local.resolutions, ['480p', '720p', '1080p'])
  assert.equal(local.vendorResolutions['480p'], '480P')
  assert.equal(resolutionSupportError('minimax', 'MiniMax-H3', '480p', { localShim: true }), null)
  // shim 只实现了图片参考与首尾帧，音频/视频参考必须显式声明为 0
  assert.equal(local.referenceImages, 9)
  assert.equal(local.referenceVideos, 0)
  assert.equal(local.referenceAudios, 0)

  const cloud = videoModelCapabilities('minimax', 'MiniMax-H3')
  assert.deepEqual(cloud.resolutions, ['720p', '1080p'])
  assert.match(String(resolutionSupportError('minimax', 'MiniMax-H3', '480p')), /不支持/)
})

test('Wan 3.0 exposes all tiers and more references than Wan 2.x', () => {
  const wan3 = videoModelCapabilities('aliyun', 'wan3.0-video')
  assert.deepEqual(wan3.resolutions, ['480p', '720p', '1080p'])
  assert.equal(wan3.vendorResolutions['1080p'], '1080P')
  assert.equal(wan3.referenceImages, 10)
  assert.equal(wan3.minDuration, 2)
  assert.equal(wan3.maxDuration, 30)

  const wan2i2v = videoModelCapabilities('aliyun', 'wan2.2-i2v-plus')
  assert.equal(wan2i2v.referenceImages, 1)
  const wan2t2v = videoModelCapabilities('aliyun', 'wan2.2-t2v-plus')
  assert.equal(wan2t2v.referenceImages, 0)
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
