import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const settingsPage = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')
const aiConfigRoute = readFileSync(new URL('../../backend/src/routes/aiConfigs.ts', import.meta.url), 'utf8')
const volcengineAdapter = readFileSync(new URL('../../backend/src/services/adapters/volcengine-video.ts', import.meta.url), 'utf8')

test('video presets default to direct Seedance 2.0 generation', () => {
  const combined = `${settingsPage}\n${aiConfigRoute}\n${volcengineAdapter}`
  assert.doesNotMatch(combined, /doubao-seedance-1-5-pro-251215/)
  assert.match(settingsPage, /火山方舟 Seedance/)
  assert.match(settingsPage, /doubao-seedance-2-0-260128/)
  assert.match(settingsPage, /doubao-seedance-2-0-fast-260128/)
  assert.match(settingsPage, /doubao-seedance-2-0-mini-260615/)
})

test('video presets use official provider endpoints', () => {
  const presetsStart = settingsPage.indexOf('const providerPresets = {')
  const quickStart = settingsPage.indexOf('const huobaoQuickConfigs = [')
  const providerPresets = settingsPage.slice(presetsStart, quickStart)
  assert.doesNotMatch(providerPresets, /api\.firemux\.com/)
  assert.match(settingsPage, /https:\/\/ark\.cn-beijing\.volces\.com/)
  assert.match(providerPresets, /https:\/\/dashscope\.aliyuncs\.com/)
  assert.match(settingsPage, /https:\/\/dashscope\.aliyuncs\.com/)
  assert.doesNotMatch(settingsPage, /https:\/\/api\.vidu\.com/)
})

test('Wan 3.0 quick preset targets the Qwen gateway namespace', () => {
  const quickStart = settingsPage.indexOf('const huobaoQuickConfigs = computed(() => {')
  assert.notEqual(quickStart, -1)
  const quickConfigs = settingsPage.slice(quickStart, settingsPage.indexOf('\n})', quickStart) + 3)
  assert.match(quickConfigs, /provider:\s*'aliyun'/)
  assert.ok(quickConfigs.includes('base_url: `${base}/qwen`'), 'missing Qwen gateway route')
  assert.match(quickConfigs, /wan3\.0-video-prime/)
  assert.match(quickConfigs, /wan3\.0-video/)
})
