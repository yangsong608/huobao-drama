import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')

const episode = read('../app/views/drama/episode.vue')
const tab = read('../app/components/director/DirectorTab.vue')
const topbar = read('../app/components/director/DirectorTopBar.vue')
const api = read('../app/composables/useApi.ts')

test('production tabs expose the director stage only when enabled', () => {
  assert.match(episode, /settingsAPI\.director\(\)/)
  assert.match(episode, /directorMode\.value !== 'off'/)
  assert.match(episode, /prodTab === 'director'/)
  assert.match(episode, /q\.panel === 'director'/)
  assert.match(episode, /directorInitialView/)
  assert.match(episode, /DirectorTab/)
})

test('director stage keeps the 3D subtab gated', () => {
  assert.match(topbar, /v-if="props\.view3dEnabled"/)
  assert.match(tab, /DirectorTopBar/)
  assert.match(tab, /view3dUnavailable/)
})

test('director API contract and locales are present', () => {
  assert.match(api, /export interface DirectorSettings/)
  assert.match(api, /export const directorAPI/)
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const data = JSON.parse(read(`../app/locales/${locale}.json`))
    assert.ok(data.director?.tab?.label, `${locale} director.tab.label`)
    assert.ok(data.director?.error?.closedTitle, `${locale} director.error.closedTitle`)
    assert.ok(data.director?.shotList?.title, `${locale} director.shotList.title`)
  }
})
