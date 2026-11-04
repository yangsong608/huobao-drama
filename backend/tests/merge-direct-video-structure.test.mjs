import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const mergeService = readFileSync(new URL('../src/services/ffmpeg-merge.ts', import.meta.url), 'utf8')
const episodesRoute = readFileSync(new URL('../src/routes/episodes.ts', import.meta.url), 'utf8')
const backendIndex = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const useApi = readFileSync(new URL('../../frontend/app/composables/useApi.ts', import.meta.url), 'utf8')
const composeRoutePath = new URL('../src/routes/compose.ts', import.meta.url)
const composeServicePath = new URL('../src/services/ffmpeg-compose.ts', import.meta.url)

test('episode merge uses generated videos directly without requiring compose output', () => {
  assert.doesNotMatch(mergeService, /Only composed storyboards can be merged/)
  assert.match(mergeService, /sb\.videoUrl\s*\|\|\s*sb\.composedVideoUrl/)
  assert.match(mergeService, /missing\.length > 0/)
  // 逐段响度归一：H3 各段电平差异大，合并时必须拉平
  assert.match(mergeService, /loudnorm=I=-16\.5/)
  assert.match(mergeService, /allClipsHaveAudio/)
})

test('compose workflow is no longer exposed through API surfaces', () => {
  assert.doesNotMatch(episodesRoute, /compose_shots/)
  assert.doesNotMatch(backendIndex, /api\.route\('\/compose'/)
  assert.doesNotMatch(useApi, /export const composeAPI/)
  assert.equal(existsSync(composeRoutePath), false)
  assert.equal(existsSync(composeServicePath), false)
})
