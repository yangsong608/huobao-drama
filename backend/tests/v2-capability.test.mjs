import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const exists = (path) => existsSync(new URL(path, root))

/**
 * V2 正向能力断言（M0-D1 收口）
 *
 * M0-3 改写守卫测试时只保留了「旧实现不得回归」的负向断言；
 * V2 的 audio / grid 能力需在对应里程碑落地后补正向断言，
 * 否则文件被误删或路由未挂载时守卫测试仍会通过。
 */
test('V2 audio capability is implemented and mounted', () => {
  const index = read('src/index.ts')
  const tts = read('src/services/tts.ts')
  const ai = read('src/services/ai.ts')

  assert.equal(exists('src/services/adapters/qwen-tts.ts'), true)
  assert.equal(exists('src/services/adapters/cloud-tts.ts'), true)
  assert.match(tts, /adapters\/qwen-tts/)
  assert.match(tts, /adapters\/cloud-tts/)
  assert.match(ai, /audio:\s*\['qwen3-tts', 'aliyun', 'volcengine', 'openai-compatible'\]/)
  assert.match(index, /routes\/voices/)
  assert.match(index, /routes\/lines/)
  assert.match(index, /routes\/dubbing/)
})

test('V2 image/video providers include Aliyun and local ComfyUI', () => {
  const ai = read('src/services/ai.ts')
  const registry = read('src/services/adapters/registry.ts')

  assert.match(ai, /image:\s*\[[^\]]*'aliyun'[^\]]*'comfyui'[^\]]*\]/)
  assert.match(ai, /video:\s*\[[^\]]*'aliyun'[^\]]*'comfyui'[^\]]*\]/)
  assert.equal(exists('src/services/adapters/aliyun-image.ts'), true)
  assert.equal(exists('src/services/adapters/comfyui.ts'), true)
  assert.equal(exists('src/services/adapters/comfyui-image.ts'), true)
  assert.equal(exists('src/services/adapters/comfyui-video.ts'), true)
  assert.match(registry, /AliyunImageAdapter/)
  assert.match(registry, /ComfyUIImageAdapter/)
  assert.match(registry, /ComfyUIVideoAdapter/)
})

test('V2 grid capability is implemented and mounted', () => {
  const index = read('src/index.ts')

  assert.equal(exists('src/routes/grid.ts'), true)
  assert.equal(exists('src/services/grid-image.ts'), true)
  assert.match(index, /routes\/grid/)
  assert.match(read('src/routes/grid.ts'), /split/)
  assert.match(read('src/services/grid-image.ts'), /crop/)
})