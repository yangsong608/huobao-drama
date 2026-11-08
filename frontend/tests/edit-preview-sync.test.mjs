import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const { decidePreviewSync } = await import('../app/utils/edit-preview-sync.ts')

test('同源分割边界不重载视频，只按需定位', () => {
  assert.equal(decidePreviewSync('/a.mp4', '/a.mp4', 5000, 5016), 'none')
  assert.equal(decidePreviewSync('/a.mp4', '/a.mp4', 5000, 5600), 'seek')
  assert.equal(decidePreviewSync('/a.mp4', '/b.mp4', 5000, 5000), 'load')
})

test('预览组件：clipKey 变化不调用 video.load()', () => {
  const preview = read('app/components/edit/EditPreview.vue')
  assert.match(preview, /decidePreviewSync/)
  assert.match(preview, /watch\(\s*\(\) => props\.src/)

  const clipKeyWatch = preview.match(/watch\(\s*\(\) => props\.clipKey[\s\S]*?\n\)/)
  assert.ok(clipKeyWatch, '应存在 clipKey 监听')
  assert.doesNotMatch(clipKeyWatch[0], /\.load\(\)/)
  assert.match(clipKeyWatch[0], /applySourceTime|seek/)
})