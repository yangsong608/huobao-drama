/**
 * 自建 H3 网关：显式 h3_gateway 标识必须与旧本机桥接地址区分开。
 * 远程网关不按端口猜测，只有用户勾选后才启用本地扩展协议。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MiniMaxVideoAdapter, isLocalShimConfig } from '../src/services/adapters/minimax-video.ts'
import { buildComfyViewUrl } from '../src/services/adapters/comfyui.ts'
import type { AIConfig, VideoGenerationRecord } from '../src/services/adapters/types.ts'

const adapter = new MiniMaxVideoAdapter()

const gatewayConfig: AIConfig = {
  provider: 'minimax',
  baseUrl: 'http://h3-gateway.example.com:8192',
  apiKey: 'gateway-token',
  model: 'MiniMax-H3',
  settings: { h3_gateway: true },
}

const remoteCloudConfig: AIConfig = {
  provider: 'minimax',
  baseUrl: 'http://h3-gateway.example.com:8192',
  apiKey: 'cloud-key',
  model: 'MiniMax-H3',
}

const record = (patch: Partial<VideoGenerationRecord> = {}): VideoGenerationRecord => ({
  id: 1,
  model: 'MiniMax-H3',
  prompt: 'Rainy night, the hero pushes the door open',
  duration: 2,
  resolution: '480p',
  aspectRatio: '9:16',
  firstFrameUrl: 'data:image/png;base64,AAAA',
  ...patch,
})

test('远程网关 + h3_gateway：按本地扩展协议发送', () => {
  assert.equal(isLocalShimConfig(gatewayConfig), true)
  const req = adapter.buildGenerateRequest(gatewayConfig, record({ allowShortDuration: true }))
  assert.equal(req.body.resolution, '480P')
  assert.equal(req.body.resolution_tier, '480p')
  assert.equal(req.body.aspect_ratio, '9:16')
  assert.equal(req.body.duration, 2)
})

test('远程地址未勾选 h3_gateway：仍按云端 H3 schema 处理', () => {
  assert.equal(isLocalShimConfig(remoteCloudConfig), false)
  const req = adapter.buildGenerateRequest(remoteCloudConfig, record({ resolution: '768p', duration: 5 }))
  assert.equal(Object.prototype.hasOwnProperty.call(req.body, 'resolution_tier'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(req.body, 'aspect_ratio'), false)
  assert.throws(
    () => adapter.buildGenerateRequest(remoteCloudConfig, record({ resolution: '480p', duration: 5 })),
    /不支持 480p/,
  )
})

test('旧本机桥接地址无需标识也能识别，且仅 minimax 生效', () => {
  assert.equal(isLocalShimConfig({ provider: 'minimax', baseUrl: 'http://127.0.0.1:8190', apiKey: '', model: '' }), true)
  assert.equal(isLocalShimConfig({ provider: 'minimax', baseUrl: 'http://localhost:9000', apiKey: '', model: '' }), true)
  assert.equal(isLocalShimConfig({ provider: 'aliyun', baseUrl: 'http://127.0.0.1:8190', apiKey: '', model: '' }), false)
  assert.equal(isLocalShimConfig(null), false)
})

test('ComfyUI 网关地址的产物 URL 带 token，直连 ComfyUI 不带', () => {
  const gatewayUrl = new URL(buildComfyViewUrl(
    { provider: 'comfyui', baseUrl: 'http://h3-gateway.example.com:8192/comfyui', apiKey: 'gateway-token', model: '' },
    { filename: 'h3/out.mp4', subfolder: '', type: 'output' },
  ))
  assert.equal(gatewayUrl.pathname, '/comfyui/view')
  assert.equal(gatewayUrl.searchParams.get('token'), 'gateway-token')
  assert.equal(gatewayUrl.searchParams.get('filename'), 'h3/out.mp4')

  const directUrl = new URL(buildComfyViewUrl(
    { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiKey: 'gateway-token', model: '' },
    { filename: 'out.png', subfolder: '', type: 'output' },
  ))
  assert.equal(directUrl.pathname, '/view')
  assert.equal(directUrl.searchParams.get('token'), null)
})
