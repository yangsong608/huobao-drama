/**
 * 导出预设（设计 9.3/9.7）：预设解析、字幕模式与文件名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  EXPORT_PRESETS,
  ExportPresetError,
  buildExportFilename,
  canonicalExportPreset,
  normalizeSubtitleMode,
  resolveEditExportPreset,
  resolveExportPreset,
} = await import('../src/services/export-presets.ts')

test('六套预设覆盖三种产物与画幅', () => {
  assert.deepEqual(Object.keys(EXPORT_PRESETS).sort(), [
    'audio-wav', 'horizontal-hd', 'square-hd', 'stems', 'vertical-hd', 'vertical-high',
  ])
  assert.equal(EXPORT_PRESETS['vertical-hd'].width, 1080)
  assert.equal(EXPORT_PRESETS['vertical-hd'].height, 1920)
  assert.equal(EXPORT_PRESETS['horizontal-hd'].width, 1920)
  assert.equal(EXPORT_PRESETS['horizontal-hd'].height, 1080)
  assert.equal(EXPORT_PRESETS['square-hd'].width, 1080)
  assert.equal(EXPORT_PRESETS['square-hd'].height, 1080)
  assert.equal(EXPORT_PRESETS['square-hd'].videoCodec, 'h264')
  assert.equal(EXPORT_PRESETS['square-hd'].audioCodec, 'aac')
  assert.equal(EXPORT_PRESETS['square-hd'].sampleRate, 48000)
  assert.deepEqual(EXPORT_PRESETS['square-hd'].subtitleModes, ['soft', 'burn', 'none'])
  assert.equal(EXPORT_PRESETS['vertical-high'].audioBitrateKbps, 256)
  assert.equal(EXPORT_PRESETS['audio-wav'].kind, 'mix')
  assert.equal(EXPORT_PRESETS['audio-wav'].extension, 'wav')
  assert.equal(EXPORT_PRESETS['stems'].kind, 'stems')
  assert.equal(EXPORT_PRESETS['stems'].extension, 'zip')
})

test('按画幅与产物解析默认预设', () => {
  assert.equal(resolveExportPreset({ aspect: '9:16' }).key, 'vertical-hd')
  assert.equal(resolveExportPreset({ aspect: '16:9' }).key, 'horizontal-hd')
  assert.equal(resolveExportPreset({ aspect: '1:1' }).key, 'square-hd')
  assert.equal(resolveExportPreset({ kind: 'mix' }).key, 'audio-wav')
  assert.equal(resolveExportPreset({ kind: 'stems' }).key, 'stems')
  assert.equal(resolveExportPreset({ preset: 'vertical-high' }).key, 'vertical-high')
  assert.equal(resolveExportPreset({ preset: 'auto', aspect: '1:1' }).key, 'square-hd')
  assert.throws(() => resolveExportPreset({ preset: '4k' }), ExportPresetError)
  assert.throws(() => resolveExportPreset({ preset: 'vertical-hd', kind: 'mix' }), ExportPresetError)
  assert.throws(() => resolveExportPreset({ preset: 'auto', kind: 'mix' }), ExportPresetError)
})

test('旧预设键只在解析层生效', () => {
  assert.equal(canonicalExportPreset('edit-vertical-hd'), 'vertical-hd')
  assert.equal(canonicalExportPreset('edit-horizontal-hd'), 'horizontal-hd')
  assert.equal(canonicalExportPreset('edit-source'), 'auto')
  assert.equal(canonicalExportPreset('vertical-hd'), 'vertical-hd')
  assert.equal(canonicalExportPreset('auto'), 'auto')
  assert.equal(canonicalExportPreset('edit-unknown'), null)

  assert.equal(resolveEditExportPreset('edit-vertical-hd', '16:9'), 'vertical-hd')
  assert.equal(resolveEditExportPreset('edit-horizontal-hd', '9:16'), 'horizontal-hd')
  assert.equal(resolveEditExportPreset('edit-source', '1:1'), 'square-hd')
  assert.equal(resolveEditExportPreset('auto', '9:16'), 'vertical-hd')
  assert.equal(resolveEditExportPreset('auto', '16:9'), 'horizontal-hd')
  assert.equal(resolveEditExportPreset('auto', '1:1'), 'square-hd')
  assert.equal(resolveEditExportPreset('auto', null), 'vertical-hd')
  assert.equal(resolveEditExportPreset('vertical-high', '16:9'), 'vertical-high')
  assert.throws(() => resolveEditExportPreset('audio-wav', '9:16'), ExportPresetError)
  assert.throws(() => resolveEditExportPreset('4k', '9:16'), ExportPresetError)
})

test('字幕模式按预设能力收敛', () => {
  const vertical = EXPORT_PRESETS['vertical-hd']
  const high = EXPORT_PRESETS['vertical-high']
  const audio = EXPORT_PRESETS['audio-wav']
  assert.equal(normalizeSubtitleMode('burn', vertical), 'burn')
  assert.equal(normalizeSubtitleMode('bad', vertical), 'soft')
  assert.equal(normalizeSubtitleMode('burn', high), 'soft')
  assert.equal(normalizeSubtitleMode('none', high), 'none')
  assert.equal(normalizeSubtitleMode('burn', audio), 'none')
})

test('文件名去除非法字符并截断 80 字', () => {
  const name = buildExportFilename({
    episodeNumber: 1,
    title: '雨夜',
    preset: EXPORT_PRESETS['vertical-hd'],
    at: new Date(2026, 10, 5, 15, 20),
  })
  assert.equal(name, 'EP001_雨夜_竖屏高清_20261105-1520.mp4')

  const dirty = buildExportFilename({
    episodeNumber: 12,
    title: '雨/夜:第*二?集"<终>|',
    preset: EXPORT_PRESETS['horizontal-hd'],
    at: new Date(2026, 10, 5, 9, 5),
  })
  assert.equal(dirty, 'EP012_雨_夜_第_二_集_终_横屏高清_20261105-0905.mp4')

  const long = buildExportFilename({
    episodeNumber: 3,
    title: '很'.repeat(120),
    preset: EXPORT_PRESETS['audio-wav'],
    at: new Date(2026, 10, 5, 9, 5),
  })
  assert.ok([...long].length <= 80, `length=${[...long].length}`)
  assert.ok(long.endsWith('.wav'))
})
