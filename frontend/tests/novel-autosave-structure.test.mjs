/**
 * V3 自动保存/定稿：1.5s 防抖、乐观锁、409 冲突、定稿确认、已定稿回草稿
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

test('API 错误携带 HTTP 状态与 data，供 409 冲突读取最新正文', () => {
  const api = read('app/composables/useApi.ts')
  assert.match(api, /error\.status\s*=/)
  assert.match(api, /error\.data\s*=/)
  assert.match(api, /json\.data/)
})

test('ChapterWriterPanel 1.5s 防抖保存并带 base_updated_at', () => {
  const panel = read('app/components/novel/ChapterWriterPanel.vue')
  assert.match(panel, /1500/)
  assert.match(panel, /base_updated_at/)
  assert.match(panel, /setTimeout/)
  assert.match(panel, /flushSave|flush/)
  assert.match(panel, /onBeforeUnmount/)
})

test('409 冲突提供「保留我的/用最新」', () => {
  const panel = read('app/components/novel/ChapterWriterPanel.vue')
  assert.match(panel, /409/)
  assert.match(panel, /conflictTitle/)
  assert.match(panel, /keepMine/)
  assert.match(panel, /useLatest/)
  assert.match(panel, /conflicted/)
})

test('定稿先保存正文再建 finalize job，并需确认', () => {
  const panel = read('app/components/novel/ChapterWriterPanel.vue')
  assert.match(panel, /finalizeChapter/)
  assert.match(panel, /finalizeConfirm/)
  assert.match(panel, /finalize/)
  assert.match(panel, /isFinal/)
  assert.match(panel, /type === 'finalize'/)
})

test('编辑已定稿章节首次输入需确认并回 draft', () => {
  const panel = read('app/components/novel/ChapterWriterPanel.vue')
  assert.match(panel, /draftConfirm/)
  assert.match(panel, /draftConfirmed/)
  assert.match(panel, /status:\s*'draft'|'draft'/)
})

test('四语言自动保存/冲突/定稿文案键对齐', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map((lang) => JSON.parse(read(`app/locales/${lang}.json`)))
  const required = [
    'writer.finalize',
    'writer.finalizeConfirm',
    'writer.finalizing',
    'writer.finalBadge',
    'writer.conflictTitle',
    'writer.conflictHint',
    'writer.keepMine',
    'writer.useLatest',
    'writer.draftConfirm',
  ]
  for (const locale of locales) {
    const keys = leafKeys(locale.novels)
    for (const key of required) {
      assert.ok(keys.includes(`novels.${key}`.slice('novels.'.length)), `missing ${key}`)
    }
  }
  const base = leafKeys(locales[0].novels).sort()
  for (const locale of locales.slice(1)) {
    assert.deepEqual(leafKeys(locale.novels).sort(), base)
  }
})
