import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const studioCss = readFileSync(new URL('../app/assets/studio.css', import.meta.url), 'utf8')
const indexPage = readFileSync(new URL('../app/pages/index.vue', import.meta.url), 'utf8')
const appHeader = readFileSync(new URL('../app/components/AppHeader.vue', import.meta.url), 'utf8')
const baseSelect = readFileSync(new URL('../app/components/BaseSelect.vue', import.meta.url), 'utf8')
const dramaDetail = readFileSync(new URL('../app/views/drama/detail.vue', import.meta.url), 'utf8')
const episodeWorkbench = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')

test('global button system exposes complete button tokens and states', () => {
  assert.match(studioCss, /--button-height:\s*36px/)
  assert.match(studioCss, /--button-height-sm:\s*30px/)
  assert.match(studioCss, /--button-height-icon:\s*36px/)
  assert.match(studioCss, /--button-focus:\s*rgba\(249,115,22,0\.20\)/)
  assert.match(studioCss, /--radius-pill:\s*980px/)
  assert.match(studioCss, /\.btn\s*\{[\s\S]*?border-radius:\s*var\(--button-radius\)/)
  assert.match(studioCss, /\.btn:focus-visible\s*\{/)
  assert.match(studioCss, /\.btn-danger\s*\{/)
  assert.match(studioCss, /\.btn-danger:hover\s*\{/)
})

test('button-like controls share focus-visible and active hooks', () => {
  assert.match(indexPage, /\.filter-chip:focus-visible\s*\{/)
  assert.match(appHeader, /\.nav-link:focus-visible\s*\{/)
  assert.match(appHeader, /\.brand:focus-visible\s*\{/)
  assert.match(baseSelect, /\.base-select-trigger:focus-visible\s*\{/)
  assert.match(studioCss, /\.app-menu-item:focus-visible\s*\{/)
  assert.match(studioCss, /\.app-menu-item\.selected\s*\{/)
})

test('custom return buttons use the unified quiet circular surface', () => {
  assert.match(dramaDetail, /\.back-btn\s*\{[\s\S]*?background:\s*var\(--overlay-track\)/)
  assert.match(dramaDetail, /\.back-btn:focus-visible\s*\{/)
  assert.match(episodeWorkbench, /\.back-btn\s*\{[\s\S]*?background:\s*var\(--overlay-track\)/)
  assert.match(episodeWorkbench, /\.back-btn:focus-visible\s*\{/)
})
