/**
 * V3 导出 tab：TXT/Markdown 下载入口与四语言文案
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

test('novelAPI 提供导出地址并指向 /novels/:id/export', () => {
  const api = read('app/composables/useNovelApi.ts')
  assert.match(api, /exportUrl/)
  assert.match(api, /\/novels\/\$\{id\}\/export\?format=\$\{format\}/)
})

test('导出面板提供 TXT/Markdown 下载与进度摘要', () => {
  const panel = read('app/components/novel/ExportPanel.vue')
  assert.match(panel, /exportUrl/)
  assert.match(panel, /'txt'/)
  assert.match(panel, /'md'/)
  assert.match(panel, /download/)
  assert.match(panel, /totalWords|completedChapters/)
  assert.match(panel, /novels\.export\./)
})

test('详情页挂载导出 tab', () => {
  const detail = read('app/views/novel/detail.vue')
  assert.match(detail, /NovelExportPanel/)
  assert.match(detail, /'export'/)
  assert.match(detail, /activeTab === 'export'/)
})

test('四语言导出文案键对齐', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map((lang) => JSON.parse(read(`app/locales/${lang}.json`)))
  for (const locale of locales) {
    const keys = leafKeys(locale.novels)
    for (const key of [
      'tabs.export',
      'export.title',
      'export.subtitle',
      'export.completed',
      'export.totalWords',
      'export.txt',
      'export.md',
      'export.empty',
    ]) {
      assert.ok(keys.includes(`novels.${key}`.slice('novels.'.length)), `missing ${key}`)
    }
  }
  const base = leafKeys(locales[0].novels).sort()
  for (const locale of locales.slice(1)) {
    assert.deepEqual(leafKeys(locale.novels).sort(), base)
  }
})
