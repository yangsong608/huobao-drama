import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const studioCss = readFileSync(new URL('../app/assets/studio.css', import.meta.url), 'utf8')
const indexPage = readFileSync(new URL('../app/pages/index.vue', import.meta.url), 'utf8')
const appHeader = readFileSync(new URL('../app/components/AppHeader.vue', import.meta.url), 'utf8')
const episodeWorkbench = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const dramaDetail = readFileSync(new URL('../app/views/drama/detail.vue', import.meta.url), 'utf8')
const settingsPage = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')

function cssBlock(source, selector) {
  const start = source.indexOf(selector)
  assert.notEqual(start, -1, `missing selector ${selector}`)
  const open = source.indexOf('{', start)
  assert.notEqual(open, -1, `missing block for ${selector}`)

  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }

  throw new Error(`unterminated block for ${selector}`)
}

test('theme exposes the V2 light brand material system', () => {
  assert.match(studioCss, /--surface-base:\s*#f7f8fa/)
  assert.match(studioCss, /--surface-raised:\s*#ffffff/)
  assert.match(studioCss, /--surface-muted:\s*#f7f8fa/)
  assert.match(studioCss, /--surface-outline:\s*#e7e9ee/)
  assert.match(studioCss, /--accent:\s*#f97316/)
})

test('project entry is redesigned as a poster card grid', () => {
  assert.match(indexPage, /class="project-grid"/)
  assert.match(indexPage, /class="card project-card"/)
  assert.match(indexPage, /class="project-cover"/)
  assert.match(indexPage, /repeat\(auto-fill,\s*minmax\(240px,\s*1fr\)\)/)
  assert.match(indexPage, /background:\s*linear-gradient\(135deg,\s*var\(--accent-bg\)/)
})

test('global header uses the frosted glass material', () => {
  assert.match(studioCss, /--header-bg:\s*rgba\(247,248,250,0\.75\)/)
  assert.match(appHeader, /background:\s*var\(--header-bg\)/)
  assert.match(appHeader, /backdrop-filter:\s*blur\(20px\)\s*saturate\(180%\)/)
  assert.match(appHeader, /border-bottom:\s*1px solid var\(--border\)/)
})

test('workbench keeps the raised production surface and drops legacy panels', () => {
  assert.match(episodeWorkbench, /background:\s*var\(--surface-raised\)/)
  assert.doesNotMatch(episodeWorkbench, /rgba\(246,\s*248,\s*252,\s*0\.92\)/)
  assert.doesNotMatch(episodeWorkbench, /rgba\(27,\s*41,\s*64,\s*0\.08\)/)
})

test('settings page removes the legacy quick setup recommendation cards', () => {
  assert.doesNotMatch(settingsPage, /Quick Setup/)
  assert.doesNotMatch(settingsPage, /官方推荐配置/)
  assert.doesNotMatch(settingsPage, /officialPresetCards/)
  assert.doesNotMatch(settingsPage, /\.preset-card\s*\{/)
  assert.doesNotMatch(settingsPage, /background:\s*rgba\(255,255,255,0\.82\)/)
  assert.doesNotMatch(settingsPage, /background:\s*rgba\(244,248,255,0\.72\)/)
  assert.doesNotMatch(settingsPage, /background:\s*rgba\(255,255,255,0\.72\)/)
})

test('project episode dialog follows the light brand system', () => {
  assert.doesNotMatch(dramaDetail, /rgba\(122,167,255/)
  assert.doesNotMatch(dramaDetail, /rgba\(76,125,255/)
  assert.doesNotMatch(dramaDetail, /rgba\(242,247,255,0\.92\)/)
  assert.doesNotMatch(dramaDetail, /rgba\(244,248,255,0\.96\)/)
})

test('workbench active navigation uses brand selection tokens', () => {
  const pipeActive = cssBlock(episodeWorkbench, '.pipe-item.active {')
  const pipeActiveBar = cssBlock(episodeWorkbench, '.pipe-item.active::before')
  const iconActive = cssBlock(episodeWorkbench, '.icon-active {')

  assert.match(pipeActive, /background:\s*var\(--sel-bg\)/)
  assert.match(pipeActive, /color:\s*var\(--sel-text\)/)
  assert.doesNotMatch(pipeActive, /inset 3px 0 0 var\(--accent\)/)
  assert.match(pipeActiveBar, /background:\s*var\(--accent\)/)
  assert.match(iconActive, /background:\s*var\(--sel\)/)
})

test('workbench completed navigation uses quiet success states', () => {
  const doneItem = cssBlock(episodeWorkbench, '.pipe-item.done {')
  const doneIcon = cssBlock(episodeWorkbench, '.pipe-item.done .pipe-icon {')
  const iconDone = cssBlock(episodeWorkbench, '.icon-done {')
  const stageDoneDot = cssBlock(episodeWorkbench, '.stage-subnav-dot {')

  assert.doesNotMatch(doneItem, /#9fcaa7/)
  assert.match(doneIcon, /background:\s*var\(--success-bg\)/)
  assert.match(doneIcon, /color:\s*var\(--success\)/)
  assert.match(iconDone, /background:\s*var\(--success-bg\)/)
  assert.doesNotMatch(stageDoneDot, /#9fcaa7/)
  assert.match(stageDoneDot, /background:\s*var\(--success\)/)
  assert.match(episodeWorkbench, /\.pipe-item\.active\.done \.pipe-icon\s*\{/)
})
