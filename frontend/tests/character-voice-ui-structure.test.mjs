import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const detail = read('app/views/drama/detail.vue')
const episode = read('app/views/drama/episode.vue')
const panel = read('app/components/VoiceProfilePanel.vue')
const characterVoice = read('app/components/CharacterVoice.vue')

function locale(name) {
  return JSON.parse(read(`app/locales/${name}.json`))
}

test('voice profile shows a persistent video-reference sync state', () => {
  assert.match(panel, /const syncState = computed/)
  assert.match(panel, /voice_audio_url/)
  assert.match(panel, /voiceProfile\.syncStateSynced/)
  assert.match(panel, /voiceProfile\.syncStateStale/)
  assert.match(panel, /voiceProfile\.syncStateNone/)
  assert.match(panel, /voiceProfile\.syncHintStale/)
  assert.match(panel, /lastSynced/)
})

test('voice profile exposes version switching and collapses advanced settings', () => {
  assert.match(panel, /v-if="voices\.length > 1"/)
  assert.match(panel, /<select v-model="activeId"/)
  assert.match(panel, /voiceProfile\.version/)
  assert.match(panel, /<details class="vp-advanced">/)
  assert.match(panel, /voiceProfile\.advanced/)
  assert.match(panel, /v-model="promptDraft"/)
  assert.match(panel, /v-model="externalIdDraft"/)
})

test('voice profile states which providers support reference audio', () => {
  assert.match(panel, /voiceProfile\.capabilityHint/)
})

test('asset dialogs render one unified voice stack with profile first', () => {
  for (const page of [detail, episode]) {
    const stack = page.match(/<div[^>]*class="voice-stack"[^>]*>[\s\S]*?<\/div>\s*<\/aside>/)?.[0] || ''
    assert.ok(stack, 'missing .voice-stack in asset dialog')
    assert.match(stack, /<VoiceProfilePanel/)
    assert.match(stack, /<CharacterVoice/)
    assert.ok(stack.indexOf('<VoiceProfilePanel') < stack.indexOf('<CharacterVoice'))
  }
})

test('direct reference audio upload is labelled separately from the voice profile', () => {
  assert.match(characterVoice, /t\('characterVoice\.sampleTitle'\)/)
  assert.match(characterVoice, /t\('characterVoice\.directHint'\)/)
})

test('new voice UI keys exist in all four locales', () => {
  for (const name of ['zh', 'en', 'ja', 'ko']) {
    const messages = locale(name)
    for (const key of [
      'version',
      'syncStateSynced',
      'syncStateStale',
      'syncStateNone',
      'syncHintStale',
      'advanced',
      'capabilityHint',
    ]) {
      assert.ok(messages.voiceProfile?.[key], `${name} missing voiceProfile.${key}`)
    }
    for (const key of ['sampleTitle', 'directHint']) {
      assert.ok(messages.characterVoice?.[key], `${name} missing characterVoice.${key}`)
    }
  }
})
