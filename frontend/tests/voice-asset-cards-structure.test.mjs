import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const episode = read('app/views/drama/episode.vue')
const grid = read('app/components/VoiceAssetGrid.vue')
const fields = read('app/components/VoiceAssetFields.vue')
const lineList = read('app/components/LineList.vue')
const dubbingStage = read('app/components/DubbingStage.vue')
const session = read('app/composables/useDubbingSession.ts')

function locale(name) {
  return JSON.parse(read(`app/locales/${name}.json`))
}

test('episode production area exposes a voice card tab', () => {
  assert.match(episode, /\['assets', 'voices', 'videos'\]/)
  assert.match(episode, /v-if="prodTab === 'voices'"/)
  assert.match(episode, /<VoiceAssetGrid/)
  assert.match(episode, /episode\.prod\.voices/)
})

test('voice asset grid renders narrator and character cards with version control', () => {
  assert.match(grid, /voiceProfileAPI\.list/)
  assert.match(grid, /voiceProfileAPI\.narrator\.get/)
  assert.match(grid, /class="voice-card is-narrator"/)
  assert.match(grid, /<VoiceAssetFields/)
  assert.match(grid, /class="voice-version"/)
  assert.match(grid, /selectVersion\(group, \$event\)/)
  assert.match(grid, /voiceProfileAPI\.cloneTo/)
  assert.match(grid, /generateMissing/)
  assert.match(grid, /voiceProfileAPI\.sampleById/)
})

test('voice asset fields edit prompt and design instruct on the card', () => {
  assert.match(fields, /v-model="draft\.voicePrompt"/)
  assert.match(fields, /v-model="draft\.designInstruct"/)
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

test('dubbing session exposes flat voice options for assignment', () => {
  assert.match(session, /const allVoiceOptions = computed/)
  assert.match(session, /async function assignVoiceToLines/)
  assert.match(session, /voice_id: voiceId/)
})

test('voice cards and line assignment keys exist in all four locales', () => {
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
    ]) {
      assert.ok(messages.episode?.voice?.[key], `${name} missing episode.voice.${key}`)
    }
    for (const key of ['voiceAuto', 'voiceOwnGroup', 'voiceOtherGroup', 'voiceCross', 'voiceAssignHint', 'batchSelectHint', 'batchAssign']) {
      assert.ok(messages.workbench?.[key], `${name} missing workbench.${key}`)
    }
  }
})
