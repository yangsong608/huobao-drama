/**
 * V3 小说前端结构：共享头部、列表/创建、数据层、旧链重定向、四语言键
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

function leafKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, item]) => leafKeys(item, prefix ? `${prefix}.${key}` : key))
}

test('小说布局复用共享头部并独立滚动', () => {
  const layout = read('app/layouts/novel.vue')
  assert.match(layout, /<AppHeader\s*\/>/)
  assert.match(layout, /n-config-provider/)
  assert.match(layout, /class="novel-scope"/)
  assert.match(layout, /\.novel-scope\s*\{[^}]*overflow:\s*hidden/)
  assert.match(layout, /:deep\(\.n-config-provider\)\s*\{[^}]*flex:\s*1/)
})

test('AppHeader 提供短剧/小说/设置三入口', () => {
  const header = read('app/components/AppHeader.vue')
  assert.match(header, /to="\/"/)
  assert.match(header, /to="\/novels"/)
  assert.match(header, /to="\/settings"/)
  for (const key of ['projects', 'novels', 'settings']) {
    assert.match(header, new RegExp(`layout\\.nav\\.${key}`))
  }
})

test('小说列表页接线 store、卡片、创建弹窗与删除确认', () => {
  const page = read('app/pages/novels/index.vue')
  assert.match(page, /definePageMeta\(\{\s*layout:\s*'novel'\s*\}\)/)
  assert.match(page, /useNovelStore/)
  assert.match(page, /ProjectCard\.vue/)
  assert.match(page, /CreateProjectDialog\.vue/)
  assert.match(page, /<ConfirmDialog/)
  assert.match(page, /navigateTo\(`\/novels\/\$\{project\.id\}`\)/)
})

test('小说详情路由使用 novel 布局并拉取详情', () => {
  const detail = read('app/views/novel/detail.vue')
  assert.match(detail, /definePageMeta\(\{\s*layout:\s*'novel'\s*\}\)/)
  assert.match(detail, /store\.fetchNovel\(id\)/)
  assert.match(detail, /blueprintChapters/)
})

test('小说详情页自适应可用宽度并可独立滚动', () => {
  const detail = read('app/views/novel/detail.vue')
  const pageBlock = detail.match(/\.page\s*\{[^}]*\}/)?.[0] || ''
  assert.match(pageBlock, /(?<!-)width:\s*100%/)
  assert.match(pageBlock, /overflow-y:\s*auto/)
  assert.doesNotMatch(pageBlock, /max-width:\s*1080px/)
})

test('旧链重定向不查 legacy，统一 replace 到 /novels', () => {
  for (const file of ['app/pages/huobao-novel.vue', 'app/pages/huobao-novel/[...slug].vue']) {
    const page = read(file)
    assert.match(page, /definePageMeta\(\{\s*layout:\s*'default'\s*\}\)/)
    assert.match(page, /navigateTo\('\/novels',\s*\{\s*replace:\s*true\s*\}\)/)
    assert.doesNotMatch(page, /legacy_id|localStorage|hash/i)
  }
})

test('Pinia store 与 API 封装覆盖列表/详情/章节/设置', () => {
  const store = read('app/stores/novel.ts')
  for (const name of ['list', 'current', 'graph', 'job', 'loading', 'saving', 'error']) {
    assert.match(store, new RegExp(`const ${name} = ref`))
  }
  assert.match(store, /camelizeKeys/)
  assert.match(store, /saveChapter/)
  const api = read('app/composables/useNovelApi.ts')
  assert.match(api, /'\/novels'/)
  assert.match(api, /`\/novels\/\$\{id\}\/chapters\/\$\{chapterNo\}`/)
  assert.match(api, /'\/settings\/novel'/)
})

test('新建与设定弹窗支持题材、背景与文风快照', () => {
  const create = read('app/components/novel/CreateProjectDialog.vue')
  for (const token of ['genrePresets', 'background', 'writingStyles', 'writing_style', 'writingStyleCustom']) {
    assert.ok(create.includes(token), `CreateProjectDialog missing ${token}`)
  }
  const settingsDialog = read('app/components/novel/NovelSettingsDialog.vue')
  for (const token of ['background', 'writing_style', 'genrePresets', 'store.updateNovel']) {
    assert.ok(settingsDialog.includes(token), `NovelSettingsDialog missing ${token}`)
  }
  const detail = read('app/views/novel/detail.vue')
  assert.match(detail, /NovelSettingsDialog/)
  assert.match(detail, /novel\.background/)
  assert.match(detail, /novel\.writingStyle/)
})

test('四语言 novels 命名空间键对齐', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map((lang) => JSON.parse(read(`app/locales/${lang}.json`)))
  const base = leafKeys(locales[0].novels).sort()
  assert.ok(base.length > 40)
  for (const locale of locales.slice(1)) {
    assert.deepEqual(leafKeys(locale.novels).sort(), base)
  }
})
