import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const appRoot = new URL('../app/', import.meta.url)
const readApp = (path) => readFileSync(new URL(path, appRoot), 'utf8')

const episodePage = readApp('views/drama/episode.vue')
const dramaPage = readApp('views/drama/detail.vue')
const settingsPage = readApp('pages/settings.vue')
const useApi = readApp('composables/useApi.ts')

/**
 * 音频/音色能力边界（V2）
 *
 * V1 移除了旧语音链路（voice_assigner / MiniMax TTS / aiVoices）。
 * V2 重新引入音色档案与 Qwen3-TTS，但旧分配逻辑、旧 MiniMax 预设
 * 与 episodes.audio_config_id 不得回归。
 */
test('frontend API client keeps legacy TTS endpoints removed and exposes V2 voice profiles', () => {
  assert.doesNotMatch(useApi, /generateTTS/)
  assert.doesNotMatch(useApi, /ai-voices/)
  assert.doesNotMatch(useApi, /generate-voice-sample/)
  assert.doesNotMatch(useApi, /generate-tts/)

  assert.match(useApi, /voiceProfileAPI/)
  assert.match(useApi, /\/voices\/narrator/)
})

test('episode and project pages do not restore legacy voice assignment controls', () => {
  assert.doesNotMatch(episodePage, /voice_assigner/)
  assert.doesNotMatch(episodePage, /AI 匹配声音/)
  assert.doesNotMatch(episodePage, /updateCharVoice/)
  assert.doesNotMatch(episodePage, /previewVoiceSample/)
  assert.doesNotMatch(episodePage, /audioConfigs/)

  assert.doesNotMatch(dramaPage, /audio_config_id/)
  assert.doesNotMatch(dramaPage, /audioConfigs/)
})

test('settings page supports V2 audio service while legacy TTS presets stay removed', () => {
  assert.doesNotMatch(settingsPage, /voice_assigner/)
  assert.doesNotMatch(settingsPage, /音色分配/)
  assert.doesNotMatch(settingsPage, /speech-2\.8-hd/)

  assert.match(settingsPage, /qwen3-tts/)
  assert.match(settingsPage, /serviceMeta/)
})