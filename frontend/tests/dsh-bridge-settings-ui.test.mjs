import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const settings = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const locales = ['zh', 'en', 'ja', 'ko'].map(lang => [
  lang,
  JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')),
])

test('settings page wires DSH bridge status, toggle and endpoint', () => {
  assert.match(settings, /dshBridgeAPI/)
  assert.match(settings, /settings\.dsh\.title/)
  assert.match(settings, /settings\.dsh\.endpoint/)
  assert.match(settings, /toggleDshBridge/)
  assert.match(settings, /loadDshBridge/)
  assert.match(api, /export const dshBridgeAPI/)
  assert.match(api, /\/settings\/dsh-bridge/)
})

test('DSH bridge keys exist in all four locales', () => {
  const expected = [
    'title', 'desc', 'enabled', 'disabled', 'endpoint', 'connected', 'notFound',
    'noEndpoint', 'version', 'health', 'healthy', 'unhealthy', 'error', 'hint',
    'saved', 'saveFailed',
  ]
  for (const [lang, locale] of locales) {
    const dsh = locale.settings?.dsh
    assert.ok(dsh, `${lang} missing settings.dsh`)
    for (const key of expected) assert.ok(dsh[key], `${lang} missing settings.dsh.${key}`)
  }
})
