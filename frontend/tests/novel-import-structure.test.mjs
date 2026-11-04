/**
 * V3 P3-3 导入短剧：弹窗默认值、服务可用性约束、四语言文案
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

test('novelAPI 提供导入预览/列表/提交/删除端点', () => {
  const api = read('app/composables/useNovelApi.ts')
  assert.match(api, /previewImport/)
  assert.match(api, /\/novels\/\$\{id\}\/imports\/preview/)
  assert.match(api, /imports:\s*\(id: number\)/)
  assert.match(api, /importToDrama/)
  assert.match(api, /deleteImport/)
  assert.match(api, /\/novels\/\$\{id\}\/imports\/\$\{importId\}/)
})

test('导入弹窗默认值：16:9、1200 字、含草稿、规则背景、自动动作关闭', () => {
  const dialog = read('app/components/novel/ImportToDramaDialog.vue')
  assert.match(dialog, /aspectRatio: '16:9'/)
  assert.match(dialog, /targetWords: 1200/)
  assert.match(dialog, /includeDraft: true/)
  assert.match(dialog, /backgroundMode: 'rule'/)
  assert.match(dialog, /autoExtract: false/)
  assert.match(dialog, /autoPipeline: false/)
  assert.match(dialog, /form\.aspectRatio = '16:9'/)
  assert.match(dialog, /form\.targetWords = 1200/)
})

test('导入弹窗按服务可用性置灰全自动，并生成 request_id', () => {
  const dialog = read('app/components/novel/ImportToDramaDialog.vue')
  assert.match(dialog, /canAutoPipeline = computed\(\(\) => textReady\.value && imageReady\.value && videoReady\.value\)/)
  assert.match(dialog, /:disabled="!canAutoPipeline"/)
  assert.match(dialog, /form\.autoPipeline = false/)
  assert.match(dialog, /randomUUID/)
  assert.match(dialog, /previewImport/)
  assert.match(dialog, /importToDrama/)
  assert.match(dialog, /auto_extract/)
  assert.match(dialog, /auto_pipeline/)
})

test('导出面板挂载导入入口并在成功后跳转短剧详情', () => {
  const panel = read('app/components/novel/ExportPanel.vue')
  assert.match(panel, /NovelImportToDramaDialog/)
  assert.match(panel, /novels\.import\.button/)
  assert.match(panel, /navigateTo\(`\/drama\/\$\{payload\.dramaId\}`\)/)
})

test('四语言导入文案键对齐', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map((lang) => JSON.parse(read(`app/locales/${lang}.json`)))
  for (const locale of locales) {
    const keys = leafKeys(locale.novels)
    for (const key of [
      'import.button',
      'import.title',
      'import.subtitle',
      'import.targetTitle',
      'import.titleTemplate',
      'import.aspectRatio',
      'import.style',
      'import.chapters',
      'import.includeDraft',
      'import.splitMode',
      'import.splitWords',
      'import.splitChapter',
      'import.backgroundMode',
      'import.autoExtract',
      'import.autoPipeline',
      'import.preview',
      'import.submit',
      'import.failed',
    ]) {
      assert.ok(keys.includes(`novels.${key}`.slice('novels.'.length)), `missing ${key}`)
    }
  }
  const base = leafKeys(locales[0].novels).sort()
  for (const locale of locales.slice(1)) {
    assert.deepEqual(leafKeys(locale.novels).sort(), base)
  }
})
