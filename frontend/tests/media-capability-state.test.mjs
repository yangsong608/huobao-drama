/**
 * A6 前端媒体能力状态机：单一状态源、fail-closed、超时、幂等加载、503 兜底。
 * 只做结构断言，不启动浏览器。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('../app/', import.meta.url)
const read = rel => readFileSync(new URL(rel, root), 'utf8')

const caps = read('composables/useMediaCapabilities.ts')
const plugin = read('plugins/media-capabilities.client.ts')
const api = read('composables/useApi.ts')
const exportCaps = read('composables/useExportCapability.ts')

test('能力状态为模块级单例，四态与派生值齐全', () => {
  assert.match(caps, /const state = ref<MediaCapabilityState>\('idle'\)/)
  assert.match(caps, /const media = ref<MediaCapabilities \| null>\(null\)/)
  assert.match(caps, /export type MediaCapabilityState = 'idle' \| 'loading' \| 'ready' \| 'failed'/)
  for (const derived of ['outputReady', 'separationReady', 'voiceReady', 'probeReady']) {
    assert.match(caps, new RegExp(`${derived}: computed\\(\\(\\) => actionReady\\(`), derived)
  }
  assert.match(caps, /export function useMediaCapabilities\(\)/)
  assert.match(caps, /ensureLoaded: \(\) => load\(false\)/)
  assert.match(caps, /refresh: \(\) => load\(true\)/)
})

test('结构校验与 fail-closed：字段不全即 failed，失败与超时按不可用', () => {
  for (const field of ['ffmpeg', 'ffprobe', 'outputActions', 'audioSeparation', 'voiceActions']) {
    assert.match(caps, new RegExp(`'${field}'`), field)
  }
  assert.match(caps, /typeof value\[key\] === 'boolean'/)
  assert.match(caps, /invalid media capability payload/)
  assert.match(caps, /state\.value = 'failed'/)
  assert.match(caps, /REQUEST_TIMEOUT_MS = 12_000/)
  assert.match(caps, /setTimeout\(\(\) => reject\(new Error\('media capability timeout'\)\)/)
  assert.match(caps, /if \(state\.value === 'ready'\) return actionReady\(action\) \? null : 'unavailable'/)
  assert.match(caps, /if \(state\.value === 'failed'\) return 'failed'/)
  assert.match(caps, /return 'loading'/)
})

test('不读取设备类型、UA 或视口宽度', () => {
  for (const pattern of [/isTablet/, /navigator\.userAgent/, /innerWidth/, /matchMedia/]) {
    assert.doesNotMatch(caps, pattern)
  }
  assert.doesNotMatch(plugin, /isAppClient|isTablet|userAgent|innerWidth/)
})

test('启动加载幂等：ready 不重复请求，同时只允许一个在途请求', () => {
  assert.match(caps, /if \(state\.value === 'ready'\) return/)
  assert.match(caps, /if \(loadPromise\) return loadPromise/)
  assert.match(caps, /loadPromise = pending/)
  assert.match(plugin, /void caps\.ensureLoaded\(\)/)
})

test('503 MEDIA_UNAVAILABLE：保留 error_code、派发事件并强制刷新', () => {
  assert.match(api, /export const mediaCapabilitiesAPI = \{/)
  assert.match(api, /media: \(\) => api\.get<\{ media: any \}>\('\/capabilities'\)/)
  assert.match(api, /error\.errorCode = typeof json\.error_code === 'string' \? json\.error_code : undefined/)
  assert.match(api, /error\.errorCode === 'MEDIA_UNAVAILABLE'/)
  assert.match(api, /huobao:media-unavailable/)
  assert.match(caps, /error\?\.errorCode !== 'MEDIA_UNAVAILABLE'/)
  assert.match(caps, /void load\(true\)/)
  assert.match(plugin, /addEventListener\('huobao:media-unavailable'/)
  assert.match(plugin, /toast\.warning\(i18n\.global\.t\('media\.capability\.actionDisabled'\)\)/)
  assert.match(plugin, /void caps\.refresh\(\)/)
})

test('导出能力改为服务端媒体能力判定', () => {
  assert.match(exportCaps, /useMediaCapabilities/)
  assert.match(exportCaps, /localOnly: computed\(\(\) => !caps\.outputReady\.value\)/)
})
