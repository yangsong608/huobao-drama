import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const settingsPage = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')
const voicePanel = readFileSync(new URL('../app/components/VoiceProfilePanel.vue', import.meta.url), 'utf8')
const resolutionUtil = readFileSync(new URL('../app/utils/video-resolution.ts', import.meta.url), 'utf8')
const capabilityUtil = readFileSync(new URL('../app/utils/model-capabilities.ts', import.meta.url), 'utf8')

function locale(name) {
  return JSON.parse(readFileSync(new URL(`../app/locales/${name}.json`, import.meta.url), 'utf8'))
}

test('settings dialog exposes provider-specific fields for cloud and local media', () => {
  assert.match(settingsPage, /const CFG_SETTING_KEYS = computed\(\(\) => \{/)
  assert.match(settingsPage, /\['workflow', 'output_node', 'output_key', 'negative_prompt', 'seed'\]/)
  assert.match(settingsPage, /\? \['workflow', 'output_node', 'output_key', 'negative_prompt', 'seed', 'fps', 'client_id'\]/)
  assert.match(settingsPage, /provider === 'volcengine'\) return \['defaultVoiceId', 'resourceId', 'uid', 'appId', 'accessKey', 'format', 'sampleRate', 'emotion'\]/)
  assert.match(settingsPage, /return \['defaultVoiceId', 'format', 'sampleRate', 'emotion'\]/)

  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.workflow"/)
  assert.match(settingsPage, /class="textarea mono cfg-workflow"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.output_node"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.output_key"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.seed"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.fps"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.defaultVoiceId"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.resourceId"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.appId"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.accessKey"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.uid"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.sampleRate"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.emotion"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.prompt_extend"/)
  assert.match(settingsPage, /v-model="cfgForm\.provider_settings\.watermark"/)
})

test('provider settings are validated and merged on save without dropping unknown keys', () => {
  assert.match(settingsPage, /function collectProviderSettings\(\)/)
  assert.match(settingsPage, /throws? new Error\(t\('settings\.cfg\.workflowRequired'\)\)|throw new Error\(t\('settings\.cfg\.workflowRequired'\)\)/)
  assert.match(settingsPage, /throw new Error\(t\('settings\.cfg\.workflowInvalid'\)\)/)
  assert.match(settingsPage, /throw new Error\(t\('settings\.cfg\.seedInvalid'\)\)/)
  assert.match(settingsPage, /throw new Error\(t\('settings\.cfg\.fpsInvalid'\)\)/)
  assert.match(settingsPage, /throw new Error\(t\('settings\.cfg\.sampleRateInvalid'\)\)/)
  assert.match(settingsPage, /const outgoing = \{ \.\.\.cfgOriginalSettings\.value \}/)
  assert.match(settingsPage, /provider_settings: providerSettings/)

  assert.match(settingsPage, /cfgForm\.provider_settings = emptyProviderSettings\(\)/)
  assert.match(settingsPage, /function startEditCfg/)
  assert.match(settingsPage, /JSON\.stringify\(merged\.workflow, null, 2\)/)
})

test('voice profile exposes an external voice ID for cloud TTS providers', () => {
  assert.match(voicePanel, /v-model="externalIdDraft"/)
  assert.match(voicePanel, /t\('voiceProfile\.externalVoiceId'\)/)
  assert.match(voicePanel, /t\('voiceProfile\.externalVoiceIdHint'\)/)
  assert.match(voicePanel, /voiceProfileAPI\.update\(props\.character\.id, \{ external_voice_id: next \|\| null \}\)/)
  assert.match(voicePanel, /toast\.success\(t\('voiceProfile\.externalVoiceIdSaved'\)\)/)
})

test('ComfyUI uses the shared resolution tiers', () => {
  assert.match(capabilityUtil, /return build\('comfyui', \['480p', '720p', '1080p'\], \{ '480p': '480p', '720p': '720p', '1080p': '1080p' \}/)
  assert.match(resolutionUtil, /videoModelCapabilities\(videoResolutionProvider\(provider\), model, options\)/)
  assert.match(resolutionUtil, /export function videoResolutionOptions\(\n  provider: string \| null \| undefined,\n  current: string \| null \| undefined,\n  t: \(key: string\) => string,\n  model\?: string \| null,\n  options: VideoCapabilityOptions = \{\},/)
})

test('new provider settings and external voice keys exist in all four locales', () => {
  for (const name of ['zh', 'en', 'ja', 'ko']) {
    const messages = locale(name)
    for (const key of [
      'providerSettings',
      'providerSettingsInvalid',
      'comfyWorkflow',
      'workflowRequired',
      'workflowInvalid',
      'seedInvalid',
      'fpsInvalid',
      'sampleRateInvalid',
      'defaultVoice',
      'resourceId',
      'appId',
      'accessKey',
      'legacyAuthHint',
      'audioFormat',
      'sampleRate',
      'emotion',
      'promptExtend',
      'watermark',
    ]) {
      assert.ok(messages.settings?.cfg?.[key], `${name} missing settings.cfg.${key}`)
    }
    for (const key of ['externalVoiceId', 'externalVoiceIdPlaceholder', 'externalVoiceIdHint', 'externalVoiceIdSaved']) {
      assert.ok(messages.voiceProfile?.[key], `${name} missing voiceProfile.${key}`)
    }
  }
})
