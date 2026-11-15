import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHARACTER_SHORT_MAX_SECONDS_DEFAULT,
  characterRelayWarmupFrames,
  characterRelayWarmupSeconds,
  characterShortMaxSeconds,
  configuredWorkflowSlugs,
  describeVideoSwapRoute,
  selectWorkflowSlug,
} from '../src/services/video-swap-workflow.ts'

test('face mode always selects the face workflow', () => {
  const settings = {
    face_workflow_slug: 'h3-face-swap',
    character_workflow_slug: 'h3-recast-relay',
    character_short_workflow_slug: 'h3-recast',
  }
  assert.equal(selectWorkflowSlug('face', settings, 3.5), 'h3-face-swap')
  assert.equal(selectWorkflowSlug('face', settings, 20), 'h3-face-swap')
  assert.deepEqual(configuredWorkflowSlugs('face', settings), ['h3-face-swap'])
})

test('face mode falls back to the legacy workflow_slug', () => {
  assert.equal(selectWorkflowSlug('face', { workflow_slug: 'legacy-face' }, 6), 'legacy-face')
})

test('character mode without a short workflow keeps the long workflow', () => {
  const settings = { character_workflow_slug: 'h3-recast-relay' }
  assert.equal(selectWorkflowSlug('character', settings, 3.5), 'h3-recast-relay')
  assert.equal(selectWorkflowSlug('character', settings, 20), 'h3-recast-relay')
  assert.deepEqual(configuredWorkflowSlugs('character', settings), ['h3-recast-relay'])
})

test('character mode routes short chunks to Recast and long chunks to Relay', () => {
  const settings = {
    character_workflow_slug: 'h3-recast-relay',
    character_short_workflow_slug: 'h3-recast',
    character_short_max_seconds: 6,
  }
  assert.equal(selectWorkflowSlug('character', settings, 3.5), 'h3-recast')
  assert.equal(selectWorkflowSlug('character', settings, 6), 'h3-recast')
  assert.equal(selectWorkflowSlug('character', settings, 6.1), 'h3-recast-relay')
  assert.equal(selectWorkflowSlug('character', settings, 20), 'h3-recast-relay')
  assert.deepEqual(configuredWorkflowSlugs('character', settings), ['h3-recast-relay', 'h3-recast'])
})

test('character short threshold is configurable and clamped', () => {
  const settings = {
    character_workflow_slug: 'h3-recast-relay',
    character_short_workflow_slug: 'h3-recast',
    character_short_max_seconds: 8,
  }
  assert.equal(selectWorkflowSlug('character', settings, 7), 'h3-recast')
  assert.equal(selectWorkflowSlug('character', settings, 9), 'h3-recast-relay')
  assert.equal(characterShortMaxSeconds({ character_short_max_seconds: 1 }), 2)
  assert.equal(characterShortMaxSeconds({ character_short_max_seconds: 99 }), 10)
  assert.equal(characterShortMaxSeconds({}), CHARACTER_SHORT_MAX_SECONDS_DEFAULT)
})

test('character short workflow still works when only workflow_slug is configured as the long fallback', () => {
  const settings = {
    workflow_slug: 'h3-recast-relay',
    character_short_workflow_slug: 'h3-recast',
  }
  assert.equal(selectWorkflowSlug('character', settings, 3.5), 'h3-recast')
  assert.equal(selectWorkflowSlug('character', settings, 20), 'h3-recast-relay')
})

test('missing character workflows return null and no configured slugs', () => {
  assert.equal(selectWorkflowSlug('character', {}, 3.5), null)
  assert.deepEqual(configuredWorkflowSlugs('character', {}), [])
})

test('Relay long chunks get a 124-frame warm-up by default, short/face do not', () => {
  const settings = {
    character_workflow_slug: 'h3-recast-relay',
    character_short_workflow_slug: 'h3-recast',
    character_short_max_seconds: 6,
  }
  assert.equal(characterRelayWarmupFrames('character', settings, 'h3-recast-relay'), 124)
  assert.equal(characterRelayWarmupFrames('character', settings, 'h3-recast'), 0)
  assert.equal(characterRelayWarmupFrames('face', settings, 'h3-face-swap'), 0)
  assert.equal(characterRelayWarmupFrames('character', { ...settings, character_relay_warmup_seconds: 0 }, 'h3-recast-relay'), 0)
  assert.equal(characterRelayWarmupFrames('character', { ...settings, character_relay_warmup_seconds: 99 }, 'h3-recast-relay'), 240)
})

test('a short-only character config can start a run but cannot submit long chunks', () => {
  const settings = { character_short_workflow_slug: 'h3-recast' }
  assert.equal(selectWorkflowSlug('character', settings), 'h3-recast')
  assert.equal(selectWorkflowSlug('character', settings, 3.5), 'h3-recast')
  assert.equal(selectWorkflowSlug('character', settings, 20), null)
})

test('route description exposes the active face engine and FaceFusion model', () => {
  const faceFusion = describeVideoSwapRoute('face', {
    face_engine: 'facefusion',
    face_workflow_slug: 'h3-face-swap',
    facefusion_model: 'hyperswap_1a_256',
    facefusion_execution_providers: 'cpu',
  })
  assert.equal(faceFusion.engine, 'facefusion')
  assert.equal(faceFusion.face_workflow, 'h3-face-swap')
  assert.equal(faceFusion.facefusion_model, 'hyperswap_1a_256')
  assert.equal(faceFusion.facefusion_provider, 'cpu')

  const h3 = describeVideoSwapRoute('face', {
    face_engine: 'h3',
    face_workflow_slug: 'h3-face-swap',
  })
  assert.equal(h3.engine, 'h3')
  assert.equal(h3.face_workflow, 'h3-face-swap')
  assert.equal(h3.facefusion_model, null)
})

test('route description exposes character short/long workflows and Relay warm-up', () => {
  const route = describeVideoSwapRoute('character', {
    face_engine: 'facefusion',
    character_workflow_slug: 'h3-recast-relay',
    character_short_workflow_slug: 'h3-recast',
    character_short_max_seconds: 6,
    character_relay_warmup_seconds: 5.17,
  })
  assert.equal(route.mode, 'character')
  assert.equal(route.engine, 'h3')
  assert.equal(route.character_short_workflow, 'h3-recast')
  assert.equal(route.character_long_workflow, 'h3-recast-relay')
  assert.equal(route.character_short_max_seconds, 6)
  assert.equal(route.character_relay_warmup_seconds, 5.17)
  assert.equal(route.facefusion_model, null)
})

test('Relay warm-up seconds are clamped independently from frame conversion', () => {
  assert.equal(characterRelayWarmupSeconds({}), 5.17)
  assert.equal(characterRelayWarmupSeconds({ character_relay_warmup_seconds: 0 }), 0)
  assert.equal(characterRelayWarmupSeconds({ character_relay_warmup_seconds: 99 }), 10)
})