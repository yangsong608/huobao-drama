import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const pages = {
  index: read('app/pages/index.vue'),
  detail: read('app/views/drama/detail.vue'),
  delivery: read('app/components/EpisodeDeliveryDialog.vue'),
  exportStage: read('app/components/ExportStage.vue'),
  editExport: read('app/components/edit/EditExportDialog.vue'),
  settings: read('app/pages/settings.vue'),
}

function styleOf(source) {
  const match = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  assert.ok(match, 'missing <style> block')
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '')
}

function rulesOf(style) {
  const rules = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = pattern.exec(style))) {
    rules.push({
      selectors: match[1].split(',').map((item) => item.trim()),
      body: match[2],
    })
  }
  return rules
}

function ruleBody(style, selector) {
  const rule = rulesOf(style).find((item) => item.selectors.includes(selector))
  assert.ok(rule, `missing CSS rule: ${selector}`)
  return rule.body
}

function fontPx(body) {
  const match = body.match(/font-size:\s*([\d.]+)px/)
  return match ? Number(match[1]) : null
}

function assertMinFont(style, prefixes, min, label) {
  for (const rule of rulesOf(style)) {
    const touched = rule.selectors.some((selector) => prefixes.some((prefix) => selector.startsWith(prefix)))
    if (!touched) continue
    const size = fontPx(rule.body)
    if (size == null) continue
    assert.ok(size >= min, `${label}: ${rule.selectors[0]} font-size ${size}px < ${min}px`)
  }
}

function assertNoSubEleven(style, label) {
  assert.doesNotMatch(
    style,
    /font-size:\s*(?:9|9\.5|10|10\.5)px/,
    `${label}: touched block still contains 9/10px fonts`,
  )
}

const localeNames = ['zh', 'en', 'ja', 'ko']
const locale = (name) => JSON.parse(read(`app/locales/${name}.json`))

test('项目列表：统一空态、元信息字号与键盘焦点', () => {
  const source = pages.index
  const style = styleOf(source)
  assert.match(source, /import StudioEmptyState from '~\/components\/studio\/StudioEmptyState\.vue'/)
  assert.match(source, /<StudioEmptyState[\s\S]{0,120}class="project-empty"/)
  assert.match(source, /@action="showCreate = true"/)
  assert.equal(fontPx(ruleBody(style, '.launcher-title')), 18)
  assert.equal(fontPx(ruleBody(style, '.launcher-sub')), 12)
  assert.match(ruleBody(style, '.launcher-sub'), /var\(--text-2\)/)
  assert.equal(fontPx(ruleBody(style, '.project-meta')), 12)
  assert.equal(fontPx(ruleBody(style, '.project-foot')), 12)
  assert.equal(fontPx(ruleBody(style, '.cover-ratio')), 11)
  assert.match(ruleBody(style, '.project-meta .tag-accent'), /var\(--accent-text-strong\)/)
  assert.match(ruleBody(style, '.filter-chip:focus-visible'), /var\(--focus-ring\)/)
  assert.match(ruleBody(style, '.project-card:focus-visible'), /var\(--focus-ring\)/)
  assertMinFont(style, ['.launcher-', '.project-', '.filter-chip', '.cover-', '.style-ref-'], 11, '项目列表')
})

test('项目详情：空态、页头字号与焦点', () => {
  const source = pages.detail
  const style = styleOf(source)
  assert.equal((source.match(/<StudioEmptyState/g) || []).length, 2)
  assert.equal(fontPx(ruleBody(style, '.page-title')), 18)
  assert.equal(fontPx(ruleBody(style, '.source-line')), 12)
  assert.equal(fontPx(ruleBody(style, '.bg-line')), 12)
  assert.equal(fontPx(ruleBody(style, '.bg-line-label')), 11)
  assert.equal(fontPx(ruleBody(style, '.ep-meta')), 12)
  assert.equal(fontPx(ruleBody(style, '.asset-meta')), 12)
  assert.match(ruleBody(style, '.ep-meta'), /var\(--text-2\)/)
  assert.match(ruleBody(style, '.source-link'), /var\(--accent-text-strong\)/)
  assert.match(ruleBody(style, '.back-btn:focus-visible'), /var\(--focus-ring\)/)
  assert.ok(
    (source.match(/:title="t\('common\.close'\)" :aria-label="t\('common\.close'\)"/g) || []).length >= 5,
    '项目详情：图标关闭按钮需同时有 title 与 aria-label',
  )
  assertMinFont(
    style,
    ['.page-title', '.source-', '.bg-line', '.ep-meta', '.asset-meta', '.mat-detail', '.afp-', '.asset-', '.character-visual'],
    11,
    '项目详情',
  )
})

test('交付对话框：四类状态 chip 同时有图标与文字', () => {
  const source = pages.delivery
  const style = styleOf(source)
  assert.match(source, /role="dialog"/)
  assert.match(source, /aria-modal="true"/)
  assert.match(source, /aria-labelledby="delivery-dialog-title"/)
  assert.match(source, /id="delivery-dialog-title"/)
  assert.match(source, /:title="t\('common\.close'\)"/)
  assert.match(source, /:aria-label="t\('common\.close'\)"/)
  assert.match(source, /function statusClass/)
  assert.match(source, /function statusLabel/)
  assert.match(source, /function statusIcon/)
  assert.match(source, /tag-error/)
  assert.match(source, /tag-warning/)
  assert.match(source, /tag-info/)
  assert.match(source, /class="delivery-status-icon" aria-hidden="true"/)
  assert.match(source, /<StudioEmptyState[\s\S]{0,120}class="delivery-empty"/)
  assert.equal(fontPx(ruleBody(style, '.delivery-name')), 13.5)
  assert.equal(fontPx(ruleBody(style, '.delivery-item-meta')), 12)
  assert.equal(fontPx(ruleBody(style, '.delivery-status-icon')), 11)
  assert.match(ruleBody(style, '.delivery-item-meta'), /var\(--text-2\)/)
  assertNoSubEleven(style, '交付对话框')
})

test('导出阶段：状态图标、空态与焦点', () => {
  const source = pages.exportStage
  const style = styleOf(source)
  assert.match(source, /<StudioEmptyState[\s\S]{0,120}class="ex-empty-side"/)
  assert.match(source, /statusIcon\(active\.status\)/)
  assert.match(source, /statusIcon\(record\.status\)/)
  assert.match(source, /class="ex-chip-icon" aria-hidden="true"/)
  assert.equal(fontPx(ruleBody(style, '.ex-chip')), 11)
  assert.equal(fontPx(ruleBody(style, '.ex-chip-icon')), 11)
  assert.match(ruleBody(style, '.ex-chip'), /inline-flex/)
  const focus = ruleBody(style, '.ex-btn:focus-visible')
  assert.match(focus, /var\(--focus-ring\)/)
  assertNoSubEleven(style, '导出阶段')
})

test('导出对话框：overlay/dialog 骨架、36px 主操作与禁用原因', () => {
  const source = pages.editExport
  const style = styleOf(source)
  assert.match(source, /<div v-if="open" class="overlay"/)
  assert.match(source, /<section class="dialog ed-export" role="dialog" aria-modal="true" aria-labelledby="ed-export-title">/)
  assert.match(source, /class="dialog-head"/)
  assert.match(source, /id="ed-export-title" class="dialog-title"/)
  assert.match(source, /class="dialog-body ed-export-body"/)
  assert.match(source, /class="dialog-foot ed-export-foot"/)
  assert.match(ruleBody(style, '.ed-export'), /width:\s*min\(480px, calc\(100vw - 32px\)\)/)
  const start = ruleBody(style, '.ed-start')
  assert.match(start, /height:\s*36px/)
  assert.match(start, /var\(--text-body\)/)
  assert.match(source, /t\('edit\.exportStart'\)/)
  assert.match(source, /startDisabledReason/)
  assert.match(source, /t\('edit\.exportDisabledReadonly'\)/)
  assert.match(style, /:is\(button, select, input\):focus-visible/)
  assert.match(style, /var\(--focus-ring\)/)
  assert.match(ruleBody(style, '.ed-done > b'), /var\(--accent-text-strong\)/)
  assert.match(ruleBody(style, '.ed-reused b'), /var\(--accent-text-strong\)/)
  assertNoSubEleven(style, '导出对话框')
  for (const feature of ['collectExportWarnings', 'subtitleMode', 'setCurrent', 'editAPI.render', 'renderStatus', 'base_version', 'audioSource', 'exportAPI.cancel', 'exportAPI.retry']) {
    assert.match(source, new RegExp(feature.replace('.', '\\.')))
  }
})

test('设置页：标题层级、导航指示条与焦点令牌', () => {
  const source = pages.settings
  const style = styleOf(source)
  assert.match(ruleBody(style, '.settings-title'), /var\(--text-h1\)/)
  assert.equal(fontPx(ruleBody(style, '.settings-desc')), 13.5)
  assert.equal(fontPx(ruleBody(style, '.svc-group-title')), 15)
  assert.equal(fontPx(ruleBody(style, '.field-label')), 12.5)
  assert.equal(fontPx(ruleBody(style, '.field-hint')), 12)
  assert.match(ruleBody(style, '.field-hint'), /var\(--text-2\)/)
  assert.match(ruleBody(style, '.nav-item'), /position:\s*relative/)
  assert.match(ruleBody(style, '.nav-item.active'), /background:\s*var\(--accent-bg\)/)
  assert.match(ruleBody(style, '.nav-item.active::before'), /background:\s*var\(--accent\)/)
  assert.match(ruleBody(style, '.nav-item:focus-visible'), /var\(--focus-ring\)/)
  assert.ok((style.match(/var\(--focus-ring\)/g) || []).length >= 5)
  assert.ok(
    (source.match(/:title="t\('common\.delete'\)" :aria-label="t\('common\.delete'\)"/g) || []).length >= 5,
    '设置页：删除类图标按钮需同时有 title 与 aria-label',
  )
  assert.match(source, /:title="t\('common\.edit'\)" :aria-label="t\('common\.edit'\)"/)
  assert.match(source, /class="style-ref-remove" :title="t\('common\.delete'\)" :aria-label="t\('common\.delete'\)"/)
  assert.match(source, /:title="t\('common\.add'\)"[\s\S]{0,40}:aria-label="t\('common\.add'\)"/)
  assertNoSubEleven(style, '设置页')
  assert.match(source, /\{ element: '\.nav-item:has\(\.lucide-cpu\), \.nav-item:nth-of-type\(1\)'/)
})

test('U4 新增文案：四语言键齐全且为空态/状态提供文字', () => {
  const keys = {
    delivery: ['statusRendering', 'statusFailed', 'statusCanceled', 'statusQueued'],
    edit: ['exportDisabledReadonly', 'exportDisabledBlocked', 'exportDisabledAck', 'exportStart'],
  }
  for (const name of localeNames) {
    const data = locale(name)
    for (const [group, list] of Object.entries(keys)) {
      for (const key of list) {
        const value = data[group]?.[key]
        assert.equal(typeof value, 'string', `${name}: ${group}.${key}`)
        assert.ok(value.length > 0, `${name}: ${group}.${key} is empty`)
      }
    }
  }
})
