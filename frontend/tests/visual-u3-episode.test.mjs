import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const episode = read('app/views/drama/episode.vue')
const topbar = read('app/components/studio/StudioTopBar.vue')
const style = episode.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1]

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = style.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))
  assert.ok(match, `missing CSS rule: ${selector}`)
  return match[1]
}

function templateBlock(startMarker, endMarker) {
  const start = episode.indexOf(startMarker)
  assert.ok(start >= 0, `missing template marker: ${startMarker}`)
  const end = episode.indexOf(endMarker, start + startMarker.length)
  return episode.slice(start, end === -1 ? undefined : end)
}

test('episode topbar renders through StudioTopBar with the original entries', () => {
  assert.match(episode, /<StudioTopBar class="episode-topbar">/)
  assert.match(episode, /<template #left>/)
  assert.match(episode, /<template #center>/)
  assert.match(episode, /<template #right>/)
  assert.match(episode, /import StudioTopBar from '~\/components\/studio\/StudioTopBar\.vue'/)
  assert.match(episode, /navigateTo\(`\/drama\/\$\{dramaId\}`\)/)
  assert.match(episode, /@click="openDubbingStage"/)
  assert.match(episode, /@click="openEditWorkspace"/)
  assert.match(episode, /@click="deliveryOpen = true"/)
  assert.match(episode, /@click="refresh"/)
  assert.match(episode, /@click="openTaskDrawer"/)
  assert.match(episode, /<LocaleSwitcher \/>/)
  assert.match(episode, /class="btn btn-icon tour-help-btn"[^>]*:title="t\('tour\.helpTitle'\)"[^>]*:aria-label="t\('tour\.helpTitle'\)"/)
})

test('topbar is a flat 44px strip with no card decoration', () => {
  assert.match(topbar, /height:\s*var\(--topbar-h\)/)
  assert.match(topbar, /padding:\s*0 var\(--topbar-pad-x\)/)
  assert.match(topbar, /border-bottom:\s*1px solid var\(--border\)/)
  const override = cssRule('.episode-topbar.studio-topbar')
  assert.doesNotMatch(override, /border-radius|box-shadow/)
  assert.match(override, /background:\s*var\(--surface-soft\)/)
  const modelPicks = cssRule('.studio-model-picks')
  assert.match(modelPicks, /overflow-x:\s*auto/)
  assert.match(style, /@media \(max-width: 1360px\) \{\s*\.studio-meta-inline \{ display: none; \}/)
  assert.match(style, /@media \(max-width: 860px\)[\s\S]{0,400}\.episode-topbar\.studio-topbar \{[\s\S]*?flex-wrap: wrap/)
})

test('the three touched dialogs share head, body and foot structure', () => {
  const assetDetail = templateBlock('asset-detail-dialog', 'transition-detail-dialog')
  const transition = templateBlock('transition-detail-dialog', 'activeMerge')
  const create = templateBlock('asset-create-dialog', 'batchVideoConfirm')

  for (const [name, block] of [
    ['asset detail', assetDetail],
    ['transition detail', transition],
    ['asset create', create],
  ]) {
    assert.match(block, /class="dialog-head/, `${name} missing dialog-head`)
    assert.match(block, /class="dialog-body/, `${name} missing dialog-body`)
    assert.match(block, /class="dialog-foot/, `${name} missing dialog-foot`)
    assert.match(
      block,
      /role="dialog"[\s\S]{0,200}aria-modal="true"[\s\S]{0,200}aria-labelledby="/,
      `${name} missing dialog semantics`,
    )
    assert.match(
      block,
      /:title="t\('common\.close'\)"[\s\S]{0,120}:aria-label="t\('common\.close'\)"/,
      `${name} close button lacks accessible name`,
    )
  }
})

test('touched dialogs use the 480/640/880 width tiers and 24px body padding', () => {
  assert.match(cssRule('.asset-detail-dialog'), /width:\s*min\(880px, calc\(100vw - 48px\)\)/)
  assert.match(cssRule('.transition-detail-dialog'), /width:\s*min\(640px, calc\(100vw - 48px\)\)/)
  assert.match(cssRule('.asset-create-dialog'), /width:\s*480px/)
  assert.match(cssRule('.asset-detail-body'), /padding:\s*var\(--sp-6\)/)
  assert.match(cssRule('.asset-detail-head'), /padding:\s*var\(--sp-4\) var\(--sp-6\)/)
  assert.match(cssRule('.asset-detail-foot'), /padding:\s*var\(--sp-4\) var\(--sp-6\)/)
  assert.match(cssRule('.asset-detail-title'), /font-size:\s*17px/)
})

test('touched blocks only use the 11/12/13.5 body tiers', () => {
  const touched = /^\.(pipe-|sidebar-progress|step-num|step-name|storyboard-ref|asset-detail|asset-ref|asset-create|transition-detail|ai-transition-prompt|asset-card|character-asset|asset-cover-badge|asset-final-prompt|afp-|character-visual-summary|asset-name|asset-section-title|dialog-hint)/
  const allowed = new Set([11, 12, 13.5, 17])
  const blocks = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  const violations = []
  for (const [, selector, body] of blocks) {
    const key = selector.replace(/\s+/g, ' ').trim()
    if (!touched.test(key)) continue
    for (const size of body.matchAll(/font-size:\s*([0-9.]+)px/g)) {
      const value = Number.parseFloat(size[1])
      if (!allowed.has(value)) violations.push(`${key} -> ${value}px`)
    }
  }
  assert.deepEqual(violations, [])
  assert.match(cssRule('.step-num'), /font-family:\s*var\(--font-mono\)[\s\S]*font-size:\s*12px|font-family:\s*var\(--font-mono\)[\s\S]*font-size:\s*12px/)
})

test('disabled actions show a visible reason, not only a title', () => {
  assert.match(episode, /class="dialog-hint transition-detail-hint"/)
  const hints = episode.match(/t\('episode\.export\.aiTransition\.busyHint'\)/g) || []
  assert.ok(hints.length >= 3, 'busyHint must drive title and visible hint')
  assert.match(episode, /:title="assetCreate\.saving \? t\('episode\.create\.saving'\) : null"/)
  assert.match(episode, /\{\{ assetCreate\.saving \? t\('episode\.create\.saving'\) : t\('episode\.create\.submit', \{ type: assetCreateTypeLabel \}\) \}\}/)
})

test('tour anchors and the episode main flow entries stay unchanged', () => {
  assert.match(episode, /element: '\.studio-topbar-main'/)
  assert.match(episode, /element: '\.studio-actions \.tour-help-btn'/)
  for (const entry of ['openDubbingStage', 'openEditWorkspace', 'openTaskDrawer', 'refresh']) {
    assert.match(episode, new RegExp(entry))
  }
})

test('the new copy keys exist in all four locales', () => {
  const paths = [
    'episode.create.submit',
    'episode.create.saving',
    'episode.asset.savingChanges',
    'episode.asset.uploadingImage',
    'episode.export.aiTransition.busyHint',
  ]
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`app/locales/${locale}.json`))
    for (const path of paths) {
      const value = path.split('.').reduce((node, key) => node?.[key], json)
      assert.equal(typeof value, 'string', `${locale} missing ${path}`)
      assert.ok(value.length > 0, `${locale} has empty ${path}`)
    }
  }
})
