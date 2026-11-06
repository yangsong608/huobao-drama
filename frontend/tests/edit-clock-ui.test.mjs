import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('剪辑页播放时钟契约与回退横幅', () => {
  const clock = read('app/composables/useEditClock.ts')
  assert.match(clock, /EDIT_DRIFT_MS/)
  assert.match(clock, /120/)
  assert.match(clock, /AudioContext|audioContext/)

  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /useEditClock/)
  assert.match(workbench, /audioBanner/)

  const zh = JSON.parse(read('app/locales/zh.json'))
  assert.ok(zh.edit.audioBannerStale)
  assert.ok(zh.edit.audioBannerNone)
})

test('音频模式基于服务端 state.audio.mode，横幅传到预览', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  // 替代旧的 plan.clips.some(hasAudio) 判定
  assert.doesNotMatch(workbench, /clips\.some\(\(clip\) => clip\.source\?\.hasAudio\)/)
  assert.match(workbench, /audio\??\.mode/)
  assert.match(workbench, /syncVideo/)

  const preview = read('app/components/edit/EditPreview.vue')
  assert.match(preview, /audioBanner/)
  assert.doesNotMatch(preview, /audioModeVideo/)

  for (const locale of ['en', 'ja', 'ko']) {
    const data = JSON.parse(read(`app/locales/${locale}.json`))
    assert.ok(data.edit.audioBannerStale)
    assert.ok(data.edit.audioBannerNone)
  }
})
