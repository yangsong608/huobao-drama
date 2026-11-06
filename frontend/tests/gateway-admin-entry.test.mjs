import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const settingsPage = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')

const ADMIN_KEYS = [
  'gatewayAdminUrl',
  'gatewayAdminUrlPlaceholder',
  'gatewayAdminUrlRequired',
  'gatewayAdminOpen',
  'gatewayAdminCopy',
  'gatewayAdminCopied',
  'gatewayAdminHint',
]

test('gateway admin url is stored in localStorage and shared', () => {
  assert.match(settingsPage, /localStorage\.getItem\('huobao\.gatewayAdminUrl'\)/)
  assert.match(settingsPage, /watch\(gatewayAdminUrl/)
  assert.match(settingsPage, /localStorage\.setItem\('huobao\.gatewayAdminUrl'/)
})

test('gateway admin entry opens a new tab and requires a url', () => {
  assert.match(settingsPage, /function openGatewayAdmin\(\)/)
  assert.match(settingsPage, /toast\.warning\(t\('settings\.cfg\.gatewayAdminUrlRequired'\)\)/)
  assert.match(settingsPage, /window\.open\(url, '_blank', 'noopener'\)/)
  assert.match(settingsPage, /copyText\(gatewayAdminUrl\.value\.trim\(\), 'settings\.cfg\.gatewayAdminCopied'\)/)
})

test('gateway admin entry renders in both gateway mode blocks', () => {
  assert.match(settingsPage, /v-model="gatewayAdminUrl"/)
  const hintCount = (settingsPage.match(/t\('settings\.cfg\.gatewayAdminHint'\)/g) || []).length
  assert.equal(hintCount, 2)
  const openCount = (settingsPage.match(/@click="openGatewayAdmin"/g) || []).length
  assert.equal(openCount, 2)
})

test('gateway admin locale keys exist in all four languages', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locales = JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8'))
    const cfg = locales.settings?.cfg || {}
    for (const key of ADMIN_KEYS) {
      assert.ok(cfg[key], `${lang}.settings.cfg.${key} missing`)
    }
  }
})
