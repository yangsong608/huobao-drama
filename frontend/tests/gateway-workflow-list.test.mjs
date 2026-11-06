import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const settingsPage = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')

test('gateway workflow loading unwraps the API envelope', () => {
  assert.match(settingsPage, /const result = await aiConfigAPI\.comfyWorkflows\(/)
  assert.match(
    settingsPage,
    /const workflows = Array\.isArray\(result\)\s*\n?\s*\? result\s*\n?\s*: \(Array\.isArray\(result\?\.workflows\) \? result\.workflows : \[\]\)/,
  )
  assert.match(settingsPage, /gwWorkflows\.value = workflows/)
})

test('gateway workflow selection falls back to the first returned workflow', () => {
  assert.match(settingsPage, /cfgForm\.provider_settings\.workflow_slug = gwWorkflows\.value\[0\]\.slug/)
  assert.match(settingsPage, /const current = cfgForm\.provider_settings\.workflow_slug/)
  assert.match(settingsPage, /!gwWorkflows\.value\.some\(item => item\.slug === current\)/)
})

test('gateway config persists slug and drops legacy JSON fields', () => {
  assert.match(settingsPage, /: \['workflow_slug', 'negative_prompt', 'seed'\]/)
  assert.match(settingsPage, /\? \['workflow_slug', 'negative_prompt', 'seed', 'fps', 'client_id'\]/)
  assert.match(settingsPage, /\? \['workflow', 'output_node', 'output_key'\]\s*\n?\s*: \['workflow_slug'\]/)
  assert.match(settingsPage, /throw new Error\(t\('settings\.cfg\.gatewayWorkflowRequired'\)\)/)
})
