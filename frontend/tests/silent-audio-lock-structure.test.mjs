import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const appRoot = new URL('../app/', import.meta.url)
const readApp = (path) => readFileSync(new URL(path, appRoot), 'utf8')

const session = readApp('composables/useDubbingSession.ts')
const stage = readApp('components/DubbingStage.vue')

test('剧集静音模式锁定原声选项并强制 mute', () => {
  assert.match(session, /episodeVideoAudioMode/)
  assert.match(session, /originalAudioLocked = computed\(\(\) => episodeVideoAudioMode\.value === 'silent'\)/)
  assert.match(session, /if \(originalAudioLocked\.value\) originalAudio\.value = 'mute'/)
})

test('Task 11 移除旧混音卡后，静音锁定不再出现在配音工作台（设置收口到整集设置/导出对话框）', () => {
  assert.doesNotMatch(stage, /:disabled="originalAudioLocked"/)
  assert.doesNotMatch(stage, /workbench\.originalAudioSilentLocked/)
})

test('四语言提供静音锁定提示', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(readApp(`locales/${lang}.json`))
    assert.ok(locale.workbench?.originalAudioSilentLocked, `${lang} missing originalAudioSilentLocked`)
  }
})
