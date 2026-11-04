import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const page = read('app/pages/settings.vue')
const useApi = read('app/composables/useApi.ts')

test('settings page exposes an FFmpeg directory card with detection status', () => {
  assert.match(page, /settings\.general\.mediaTitle/)
  assert.match(page, /v-model="mediaFfmpegDir"/)
  assert.match(page, /@click="saveMediaSettings"/)
  assert.match(page, /@click="restoreMediaAuto"/)
  assert.match(page, /@click="pickFfmpegDir"/)
  assert.match(page, /desktopBridge\.pickDirectory\(\)/)
  assert.match(page, /mediaFfmpegDir\.value = res\.path/)
  // 保存与恢复都走后端，并立即回填解析结果
  assert.match(page, /settingsAPI\.media\(\)/)
  assert.match(page, /settingsAPI\.saveMedia\(mediaFfmpegDir\.value\.trim\(\)\)/)
  assert.match(page, /function applyMediaPayload\(payload\)/)
  // 展示解析路径、来源、可用性与版本
  assert.match(page, /mediaStatus\.ffmpeg\.path/)
  assert.match(page, /mediaStatus\.ffmpeg\.version/)
  assert.match(page, /mediaStatus\.ffmpeg\.available/)
  assert.match(page, /mediaStatus\.ffprobe\.available/)
  assert.match(page, /MEDIA_SOURCE_LABELS\[mediaStatus\.ffmpeg\.source\]/)
  // 保存失败/未检测到时给出明确提示
  assert.match(page, /settings\.general\.mediaUnavailable/)
  assert.match(page, /settings\.general\.mediaSaveFailed/)
})

test('useApi defines media settings endpoints and payload types', () => {
  assert.match(useApi, /export type FfmpegSource = 'custom' \| 'env' \| 'static' \| 'path' \| 'none'/)
  assert.match(useApi, /export interface FfmpegStatus/)
  assert.match(useApi, /export interface MediaSettingsPayload/)
  assert.match(useApi, /media: \(\) => api\.get<MediaSettingsPayload>\('\/settings\/media'\)/)
  assert.match(useApi, /saveMedia: \(ffmpegDir: string\) => api\.put<MediaSettingsPayload>\('\/settings\/media', \{ ffmpegDir \}\)/)
})

test('FFmpeg directory copy is localized in all four locales', () => {
  const keys = [
    'mediaTitle',
    'mediaSub',
    'ffmpegDir',
    'ffmpegDirPlaceholder',
    'ffmpegDirNote',
    'ffmpegDirHint',
    'mediaChoose',
    'mediaSave',
    'mediaAuto',
    'mediaSaved',
    'mediaUnavailable',
    'mediaLoadFailed',
    'mediaSaveFailed',
    'mediaPickFailed',
    'mediaAvailable',
    'mediaUnavailableTag',
    'mediaSourceCustom',
    'mediaSourceEnv',
    'mediaSourceStatic',
    'mediaSourcePath',
    'mediaSourceNone',
  ]
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const dict = JSON.parse(read(`app/locales/${locale}.json`))
    for (const key of keys) {
      assert.equal(typeof dict.settings?.general?.[key], 'string', `${locale}.settings.general.${key}`)
      assert.ok(dict.settings.general[key].length > 0, `${locale}.settings.general.${key} empty`)
    }
  }
})
