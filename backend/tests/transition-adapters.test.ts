/**
 * 过渡生成适配器边界：本地 H3 短时长、ComfyUI 首尾帧工作流门禁。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getVideoAdapter } from '../src/services/adapters/registry.ts'
import { assertComfyFirstLastFrameWorkflow } from '../src/services/adapters/comfyui.ts'

const minimax = getVideoAdapter('minimax')

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    model: 'MiniMax-H3',
    prompt: 'A short cinematic transition shot.',
    firstFrameUrl: 'data:image/jpeg;base64,AA==',
    lastFrameUrl: 'data:image/jpeg;base64,AA==',
    duration: 3,
    resolution: '720p',
    aspectRatio: '16:9',
    ...overrides,
  } as any
}

test('本地 shim 在 allowShortDuration 时保留短时长请求', async () => {
  const request = await minimax.buildGenerateRequest({
    provider: 'minimax',
    baseUrl: 'http://127.0.0.1:8190',
    apiKey: 'test',
    model: 'MiniMax-H3',
  }, record({ duration: 2.333, allowShortDuration: true }))
  assert.equal((request.body as any).duration, 2.333)
})

test('普通分镜与云端 H3 仍按 4 秒下限', async () => {
  const local = await minimax.buildGenerateRequest({
    provider: 'minimax',
    baseUrl: 'http://127.0.0.1:8190',
    apiKey: 'test',
    model: 'MiniMax-H3',
  }, record({ duration: 2 }))
  assert.equal((local.body as any).duration, 4)

  const cloud = await minimax.buildGenerateRequest({
    provider: 'minimax',
    baseUrl: 'https://api.minimax.io',
    apiKey: 'test',
    model: 'MiniMax-H3',
  }, record({ duration: 2, allowShortDuration: true }))
  assert.equal((cloud.body as any).duration, 4)
})

test('ComfyUI 工作流必须同时声明首帧与尾帧占位符', () => {
  assert.doesNotThrow(() => assertComfyFirstLastFrameWorkflow({
    1: { class_type: 'LoadImage', inputs: { image: '__FIRST_FRAME__' } },
    2: { class_type: 'LoadImage', inputs: { image: '__LAST_FRAME__' } },
  }))
  assert.doesNotThrow(() => assertComfyFirstLastFrameWorkflow({
    1: { class_type: 'LoadImage', inputs: { image: '__IMAGE__' } },
    2: { class_type: 'LoadImage', inputs: { image: '__LAST_FRAME__' } },
  }))

  assert.throws(
    () => assertComfyFirstLastFrameWorkflow({
      1: { class_type: 'LoadImage', inputs: { image: '__FIRST_FRAME__' } },
    }),
    /LAST_FRAME/,
  )
  assert.throws(
    () => assertComfyFirstLastFrameWorkflow({
      1: { class_type: 'LoadImage', inputs: { image: 'example.png' } },
      2: { class_type: 'LoadImage', inputs: { image: '__LAST_FRAME__' } },
    }),
    /FIRST_FRAME|IMAGE/,
  )
})
