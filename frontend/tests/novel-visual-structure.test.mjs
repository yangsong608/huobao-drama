import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const appRoot = new URL('../app/', import.meta.url)
const read = (relative) => fs.readFileSync(new URL(relative, appRoot), 'utf8')

const PURPLE = /#(?:7c5cff|8f74ff|6a4ae0|a78bfa|b9a4ff|9370e8|6366f1)\b/i

test('novel scope 映射品牌强调色并移除紫色', () => {
  const css = read('assets/novel.css')
  assert.match(css, /\.novel-scope\s*\{[^}]*--novel-accent:\s*var\(--accent\)/s)
  assert.doesNotMatch(css, PURPLE)
  assert.match(css, /--font-body/)
})

test('preflight 关闭后 novel-scope 内有最小 reset', () => {
  const css = read('assets/novel.css')
  assert.match(css, /\.novel-scope,\s*\n\.novel-scope \*,\s*\n\.novel-scope \*::before,\s*\n\.novel-scope \*::after\s*\{\s*\n\s*box-sizing: border-box;/)
  assert.match(css, /\.novel-scope h1,\s*\n\.novel-scope h2,\s*\n\.novel-scope h3,\s*\n\.novel-scope p\s*\{\s*\n\s*margin: 0;/)
  assert.match(css, /\.novel-scope button,\s*\n\.novel-scope input,\s*\n\.novel-scope textarea,\s*\n\.novel-scope select\s*\{\s*\n\s*font: inherit;/)
})

test('Naive themeOverrides 使用品牌橙并跟随深色', () => {
  const layout = read('layouts/novel.vue')
  assert.match(layout, /darkTheme/)
  assert.match(layout, /primaryColor:\s*'#f97316'/)
  assert.match(layout, /primaryColor:\s*'#ffb076'/)
  assert.match(layout, /resolvedTheme\.value === 'dark'/)
  assert.match(layout, /common:\s*\{[\s\S]*borderRadius:\s*'10px'[\s\S]*fontFamily:\s*'var\(--font-body\)'/)
  for (const section of ['Card', 'Button', 'Tabs']) {
    assert.match(layout, new RegExp(`${section}:\\s*\\{`))
  }
  assert.match(layout, /tabBorderRadius/)
})

test('小说 UI 文件无紫色残留', () => {
  const targets = [
    'assets/novel.css',
    'layouts/novel.vue',
    'pages/novels/index.vue',
    'pages/huobao-novel.vue',
    'pages/huobao-novel/[...slug].vue',
    'views/novel/detail.vue',
    'utils/novel-graph.ts',
  ]
  for (const dir of ['components/novel', 'components/novel/compass']) {
    for (const entry of fs.readdirSync(new URL(`${dir}/`, appRoot))) {
      if (entry.endsWith('.vue')) targets.push(`${dir}/${entry}`)
    }
  }
  for (const relative of targets) {
    assert.doesNotMatch(read(relative), PURPLE, `紫色残留：${relative}`)
  }
})

test('小说列表复用短剧首页结构与共享基元', () => {
  const list = read('pages/novels/index.vue')
  assert.match(list, /class="launcher-head"/)
  assert.match(list, /class="launcher-title"/)
  assert.match(list, /class="hero-stats"/)
  assert.match(list, /class="tag"/)
  assert.match(list, /class="btn btn-primary"/)
  assert.match(list, /class="toolbar"/)
  assert.match(list, /class="search-box"/)
  assert.match(list, /class="chip-row"/)
  assert.match(list, /class="filter-chip"/)
  assert.match(list, /class="project-grid"/)
})

test('小说详情复用短剧页签与卡片结构', () => {
  const detail = read('views/novel/detail.vue')
  assert.match(detail, /class="page-head card"/)
  assert.match(detail, /class="back-btn"/)
  assert.match(detail, /class="page-title"/)
  assert.match(detail, /class="page-tabs"/)
  assert.match(detail, /class="tab-btn"/)
  assert.match(detail, /class="card detail-card"/)
})

test('小说弹窗复用全局 overlay/dialog', () => {
  const dialog = read('components/novel/CreateProjectDialog.vue')
  assert.match(dialog, /class="overlay"/)
  assert.match(dialog, /class="dialog"/)
  assert.match(dialog, /class="dialog-head"/)
  assert.match(dialog, /class="dialog-body"/)
  assert.match(dialog, /class="dialog-foot"/)
})

test('Tailwind 深色选择器与小说作用域生效', () => {
  const config = fs.readFileSync(new URL('../tailwind.config.ts', import.meta.url), 'utf8')
  assert.match(config, /darkMode:\s*\['selector', '\[data-theme="dark"\]'\]/)
  assert.match(config, /important:\s*'\.novel-scope'/)
  assert.match(config, /preflight:\s*false/)
})

test('共享 header 在 743px 以下收为图标并保留 title', () => {
  const header = read('components/AppHeader.vue')
  for (const key of ['projects', 'novels', 'settings']) {
    assert.match(header, new RegExp(`:title="t\\('layout\\.nav\\.${key}'\\)"`))
  }
  assert.match(header, /class="nav-label"/)
  assert.match(header, /@media \(max-width: 743px\)/)
  assert.match(header, /\.nav-label \{ display: none; \}/)
})

test('小说列表与详情在窄屏下收窄内边距与列数', () => {
  const list = read('pages/novels/index.vue')
  assert.match(list, /@media \(max-width: 743px\)/)
  assert.match(list, /\.page \{ padding: 16px 16px 40px; \}/)
  assert.match(list, /\.project-grid \{ grid-template-columns: 1fr; \}/)
  assert.match(list, /\.search-box \{ width: 100%;/)

  const detail = read('views/novel/detail.vue')
  assert.match(detail, /@media \(max-width: 743px\)/)
  assert.match(detail, /\.page \{ padding: 16px 16px 32px; \}/)
  assert.match(detail, /\.detail-grid \{ grid-template-columns: 1fr; \}/)
  assert.match(detail, /\.page-tabs/)
})
