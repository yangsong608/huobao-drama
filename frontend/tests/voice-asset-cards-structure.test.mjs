import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const exists = (path) => existsSync(new URL(path, root))

const episode = read('app/views/drama/episode.vue')
const card = read('app/components/VoiceProfileCard.vue')
const fields = read('app/components/VoiceAssetFields.vue')
const lineList = read('app/components/LineList.vue')
const dubbingStage = read('app/components/DubbingStage.vue')
const session = read('app/composables/useDubbingSession.ts')
const store = read('app/composables/useVoiceProfiles.ts')

function locale(name) {
  return JSON.parse(read(`app/locales/${name}.json`))
}

test('production area no longer exposes a standalone voice tab', () => {
  assert.doesNotMatch(episode, /\['assets', 'voices', 'videos'\]/)
  assert.doesNotMatch(episode, /prodTab === 'voices'/)
  assert.doesNotMatch(episode, /<VoiceAssetGrid/)
  assert.doesNotMatch(episode, /prod:voices/)
  assert.equal(exists('app/components/VoiceAssetGrid.vue'), false)
  assert.equal(exists('app/components/VoiceProfilePanel.vue'), false)
})

test('dubbing voice assignment step mounts the shared voice profile card', () => {
  assert.match(dubbingStage, /<VoiceProfileCard/)
  assert.match(dubbingStage, /scope="narrator"/)
  assert.match(dubbingStage, /scope="character"/)
  assert.match(dubbingStage, /:line-count="narratorLineCount"/)
  assert.match(dubbingStage, /:line-count="speaker\.lineCount"/)
  assert.match(dubbingStage, /generateMissingVoices/)
})

test('shared card edits profile, version, sync and reference audio in one place', () => {
  assert.match(card, /useVoiceProfiles/)
  assert.match(card, /<VoiceAssetFields/)
  assert.match(card, /<CharacterVoice/)
  assert.match(card, /v-if="versions\.length > 1"/)
  assert.match(card, /v-model="selectedId"/)
  assert.match(card, /class="vpc-version"/)
  assert.match(card, /const syncState = computed/)
  assert.match(card, /voiceProfile\.syncStateSynced/)
  assert.match(card, /voiceProfile\.syncStateStale/)
  assert.match(card, /voiceProfile\.syncHintStale/)
  assert.match(card, /voiceProfile\.capabilityHint/)
  assert.match(card, /referenceAudio/)
})

test('shared store owns every voice API call used by all entries', () => {
  for (const call of [
    'voiceProfileAPI.list',
    'voiceProfileAPI.narrator.get',
    'voiceProfileAPI.narrator.generate',
    'voiceProfileAPI.narrator.bind',
    'voiceProfileAPI.generate',
    'voiceProfileAPI.updateById',
    'voiceProfileAPI.sampleById',
    'voiceProfileAPI.activateById',
    'voiceProfileAPI.cloneTo',
    'voiceProfileAPI.removeById',
    'voiceProfileAPI.sync',
    'voiceProfileAPI.clone',
  ]) {
    assert.match(store, new RegExp(call.replace('.', '\\.')), `store missing ${call}`)
  }
  assert.match(store, /external_voice_id/)
  assert.match(store, /const groups = ref<VoiceProfileList\[\]>\(\[\]\)/)
  assert.match(store, /async function persistVoice/)
  assert.match(store, /async function generateFromDraft/)
  assert.match(store, /voice_prompt: draft\.voicePrompt/)
  assert.match(store, /return audition\(fresh\)/)
})

test('voice fields edit prompt, design instruct, external id and metadata', () => {
  assert.match(fields, /v-model="draft\.voicePrompt"/)
  assert.match(fields, /v-model="draft\.designInstruct"/)
  assert.match(fields, /v-model="draft\.externalVoiceId"/)
  assert.match(fields, /<details/)
  assert.match(fields, /voice\.gender/)
  assert.match(fields, /voice\.ageRange/)
})

test('line list assigns a voice per line with cross-character warning', () => {
  assert.match(lineList, /voiceGroups\?: VoiceProfileList\[\]/)
  assert.match(lineList, /assignVoice: \[line: StoryboardLine, voiceId: number \| null\]/)
  assert.match(lineList, /selectionChange: \[ids: number\[\]\]/)
  assert.match(lineList, /class="line-voice-select"/)
  assert.match(lineList, /is-cross/)
  assert.match(lineList, /v-if="selectable"/)
})

test('dubbing stage offers batch voice assignment over selected lines', () => {
  assert.match(dubbingStage, /class="dub-batch-bar"/)
  assert.match(dubbingStage, /assignVoiceToLines/)
  assert.match(dubbingStage, /applyBatchVoice/)
  assert.match(dubbingStage, /@selection-change="selectedLineIds = \$event"/)
  assert.match(dubbingStage, /:voice-groups="voiceProfiles"/)
})

test('dubbing session consumes the shared voice store instead of owning voice state', () => {
  assert.match(session, /useVoiceProfiles/)
  assert.match(session, /const allVoiceOptions = computed/)
  assert.match(session, /async function assignVoiceToLines/)
  assert.match(session, /voice_id: voiceId/)
  assert.doesNotMatch(session, /const voiceProfiles = ref/)
  assert.doesNotMatch(session, /async function generateCharacterVoice/)
})

test('generate step can force-regenerate all lines with their current voices', () => {
  assert.match(dubbingStage, /@click="startGenerationBatch"/)
  assert.match(dubbingStage, /window\.confirm\(t\('generate\.forceConfirm'\)\)/)
  assert.match(dubbingStage, /force: batchForce\.value/)
  assert.match(session, /async function synthesizeAll\(optionsBatch: SynthesizeAllOptions = \{\}\)/)
  assert.match(session, /takeStore\.startBatch\(/)
  assert.doesNotMatch(dubbingStage, /@click="synthesizeAll"/)
  assert.match(dubbingStage, /@updated="onVoiceChanged"/)
  for (const name of ['zh', 'en', 'ja', 'ko']) {
    const messages = locale(name)
    assert.ok(messages.generate?.force, `${name} missing generate.force`)
    assert.ok(messages.generate?.forceConfirm, `${name} missing generate.forceConfirm`)
  }
})

test('voice cards, shared editor and line assignment keys exist in all four locales', () => {
  for (const name of ['zh', 'en', 'ja', 'ko']) {
    const messages = locale(name)
    for (const key of [
      'title',
      'generateAll',
      'prompt',
      'designInstruct',
      'audition',
      'setActive',
      'narratorGroup',
      'characterGroup',
      'clone',
      'cloneNarrator',
      'batchSummary',
      'statusReady',
      'referenceAudioHint',
      'generateVoice',
      'generatingVoice',
      'rewritePrompt',
      'promptHint',
      'designInstructAdvancedHint',
    ]) {
      assert.ok(messages.episode?.voice?.[key], `${name} missing episode.voice.${key}`)
    }
    for (const key of ['voiceAuto', 'voiceOwnGroup', 'voiceOtherGroup', 'voiceCross', 'voiceAssignHint', 'batchSelectHint', 'batchAssign']) {
      assert.ok(messages.workbench?.[key], `${name} missing workbench.${key}`)
    }
    for (const key of ['edit', 'done', 'saveAndGenerate', 'dirtyHint']) {
      assert.ok(messages.voiceProfile?.[key], `${name} missing voiceProfile.${key}`)
    }
  }
})
