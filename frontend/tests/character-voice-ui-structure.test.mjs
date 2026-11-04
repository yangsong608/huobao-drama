import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const detail = read('app/views/drama/detail.vue')
const episode = read('app/views/drama/episode.vue')
const card = read('app/components/VoiceProfileCard.vue')
const fields = read('app/components/VoiceAssetFields.vue')
const characterVoice = read('app/components/CharacterVoice.vue')

function locale(name) {
  return JSON.parse(read(`app/locales/${name}.json`))
}

test('shared voice card keeps a persistent video-reference sync state', () => {
  assert.match(card, /const syncState = computed/)
  assert.match(card, /voice_audio_url/)
  assert.match(card, /videoRefUrl/)
  assert.match(card, /voiceProfile\.syncStateSynced/)
  assert.match(card, /voiceProfile\.syncStateStale/)
  assert.match(card, /voiceProfile\.syncStateNone/)
  assert.match(card, /voiceProfile\.syncHintStale/)
  assert.match(card, /lastSynced/)
})

test('shared voice card exposes version switching and collapses advanced settings', () => {
  assert.match(card, /v-if="versions\.length > 1"/)
  assert.match(card, /<select v-model="selectedId"/)
  assert.match(card, /voiceProfile\.version/)
  assert.match(card, /<details class="vpc-advanced">/)
  assert.match(card, /voiceProfile\.advanced/)
  assert.match(fields, /v-model="draft\.externalVoiceId"/)
})

test('shared voice card states which providers support reference audio', () => {
  assert.match(card, /voiceProfile\.capabilityHint/)
  assert.match(card, /voiceProfile\.footHint/)
})

test('asset dialogs render one shared voice card below the sticky preview shell', () => {
  const cases = [
    { page: episode, cls: 'asset-detail-voice-row', panel: 'asset-detail-prompt-panel' },
    { page: detail, cls: 'mat-detail-voice-row', panel: 'mat-detail-prompt-panel' },
  ]
  for (const { page, cls, panel } of cases) {
    const row = page.match(new RegExp(`<div[^>]*class="${cls}"[^>]*>[\\s\\S]*?<\\/div>\\s*(?:<!--[\\s\\S]*?-->\\s*)?<section class="${panel}">`))?.[0] || ''
    assert.ok(row, `missing .${cls} as a sibling before .${panel}`)
    assert.match(row, /<VoiceProfileCard/)
    assert.match(row, /reference-audio/)
    assert.doesNotMatch(row, /default-expanded/)
    assert.doesNotMatch(row, /<VoiceProfilePanel/)
    assert.doesNotMatch(page, /<VoiceProfilePanel/)
    assert.doesNotMatch(page, /<CharacterVoice/)
    assert.doesNotMatch(page, /class="voice-stack"/)
    assert.doesNotMatch(page, new RegExp(`\\.${cls} \\{[^}]*grid-column`))
  }
})

test('shared voice card saves the edited prompt and synthesizes in one click', () => {
  assert.match(card, /async function generateVoiceNow/)
  assert.match(card, /store\.generateFromDraft/)
  assert.match(card, /audio\.play\(\)/)
  assert.match(card, /<audio/)
  assert.match(card, /controls/)
  assert.match(card, /data-voice-profile/)
  assert.match(card, /voiceProfile\.saveAndGenerate/)
  assert.match(card, /voiceProfile\.dirtyHint/)
  assert.match(card, /episode\.voice\.generateVoice/)
  assert.match(card, /episode\.voice\.generatingVoice/)
  assert.match(fields, /episode\.voice\.promptHint/)
  assert.match(fields, /episode\.voice\.designInstructAdvancedHint/)
})

test('direct reference audio upload stays labelled separately inside the card', () => {
  assert.match(card, /<CharacterVoice/)
  assert.match(characterVoice, /t\('characterVoice\.sampleTitle'\)/)
  assert.match(characterVoice, /t\('characterVoice\.directHint'\)/)
})

test('shared voice UI keys exist in all four locales', () => {
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
      'edit',
      'done',
    ]) {
      assert.ok(messages.voiceProfile?.[key], `${name} missing voiceProfile.${key}`)
    }
    for (const key of ['sampleTitle', 'directHint']) {
      assert.ok(messages.characterVoice?.[key], `${name} missing characterVoice.${key}`)
    }
    assert.ok(messages.episode?.voice?.referenceAudioHint, `${name} missing episode.voice.referenceAudioHint`)
  }
})
