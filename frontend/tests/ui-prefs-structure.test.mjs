/**
 * U2：界面偏好、设置页“界面”页签、小说阅读排版结构
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

const LOCALES = ['zh', 'en', 'ja', 'ko']

test('偏好内核使用设备存储、部署默认值与根节点属性', () => {
  const source = read('app/composables/useUiPrefs.ts')
  for (const token of [
    "UI_PREFS_STORAGE_KEY = 'huobao:ui-prefs'",
    "UI_DEFAULTS_STORAGE_KEY = 'huobao:ui-defaults'",
    'settingsAPI.ui()',
    'allowUserOverride',
    'sanitizeUiPrefs',
    'sanitizeUiDefaults',
    'dataset.density',
    'dataset.motion',
    "'--text-reading'",
    "'--reading-measure'",
    "'--font-reading'",
    'setUiPrefs',
    'resetUiPrefs',
    'loadUiSettings',
  ]) {
    assert.ok(source.includes(token), `useUiPrefs missing ${token}`)
  }
  assert.doesNotMatch(source, /dataset\.theme/, 'ui prefs must not touch data-theme')
  assert.doesNotMatch(source, /dataset\.actionLabels/, 'ui prefs must only write data-density and data-motion')
})

test('app.vue 挂载偏好内核并拉取部署默认值', () => {
  const source = read('app/app.vue')
  assert.match(source, /import \{ useUiPrefs \} from '~\/composables\/useUiPrefs'/)
  assert.match(source, /loadUiSettings\(\)/)
})

test('设置页“界面”页签紧随第一项且先于关于', () => {
  const source = read('app/pages/settings.vue')
  const tabsLine = source.match(/const SETTINGS_TABS = \[([^\]]+)\]/)
  assert.ok(tabsLine, 'SETTINGS_TABS missing')
  const tabs = tabsLine[1].split(',').map(item => item.trim().replaceAll("'", ''))
  assert.equal(tabs[0], 'ai')
  assert.equal(tabs[1], 'ui')
  assert.ok(tabs.indexOf('ui') < tabs.indexOf('about'))
  assert.match(source, /tab === 'ui'/)
  assert.match(source, /t\('settings\.tabs\.ui'\)/)
  for (const token of [
    'uiDensityOptions',
    'uiMotionOptions',
    'uiReadingFontOptions',
    'uiReadingSizeOptions',
    'uiReadingWidthOptions',
    'uiActionLabelOptions',
    'allowUserOverride',
    'resetUiPrefs',
    'settings.ui.lockedNote',
    'settings.ui.loadFailed',
  ]) {
    assert.ok(source.includes(token), `settings missing ${token}`)
  }
  assert.doesNotMatch(source, /settingsAPI\.saveUi/, 'U2 must not add a deployment default editor')
})

test('四语言界面偏好与专注阅读键齐全且同构', () => {
  const uiKeys = (ui) => {
    const keys = []
    const walk = (value, prefix) => {
      for (const [key, child] of Object.entries(value)) {
        const next = prefix ? `${prefix}.${key}` : key
        if (child && typeof child === 'object' && !Array.isArray(child)) walk(child, next)
        else keys.push(next)
      }
    }
    walk(ui, '')
    return keys.sort()
  }
  let expected = null
  for (const locale of LOCALES) {
    const json = JSON.parse(read(`app/locales/${locale}.json`))
    assert.equal(json.settings.tabs.ui.length > 0, true, `${locale} tabs.ui missing`)
    assert.equal(typeof json.novels.writer.focusReading, 'string', `${locale} focusReading missing`)
    assert.equal(typeof json.novels.writer.exitFocusReading, 'string', `${locale} exitFocusReading missing`)
    const keys = uiKeys(json.settings.ui)
    if (expected === null) expected = keys
    else assert.deepEqual(keys, expected, `${locale} settings.ui keys differ`)
  }
  for (const required of [
    'title',
    'desc',
    'appearance',
    'density.compact',
    'density.comfortable',
    'motion.system',
    'motion.full',
    'motion.reduced',
    'font.serif',
    'font.sans',
    'width.60',
    'width.68',
    'width.76',
    'actionLabels.on',
    'actionLabels.off',
    'reset',
    'resetHint',
    'lockedTitle',
    'lockedNote',
    'loadFailed',
    'retry',
  ]) {
    assert.ok(expected.includes(required), `settings.ui missing ${required}`)
  }
})

test('小说阅读使用阅读令牌并支持专注阅读', () => {
  const writer = read('app/components/novel/ChapterWriterPanel.vue')
  for (const token of [
    'var(--font-reading)',
    'var(--text-reading)',
    'var(--leading-reading)',
    'var(--reading-measure',
    'toggle-focus-reading',
    'aria-pressed',
    'novels.writer.focusReading',
  ]) {
    assert.ok(writer.includes(token), `writer missing ${token}`)
  }
  const detail = read('app/views/novel/detail.vue')
  for (const token of [
    'data-reading',
    'focusReading',
    ':focus-reading="focusReading"',
    '@toggle-focus-reading="toggleFocusReading"',
  ]) {
    assert.ok(detail.includes(token), `novel detail missing ${token}`)
  }
  const novelCss = read('app/assets/novel.css')
  assert.match(novelCss, /\[data-reading="on"\]/)
  assert.match(novelCss, /\[data-annotation-id\]/)
})

test('三栏尺寸与窄屏抽屉按 240/320、1180/860 对齐', () => {
  const shell = read('app/components/novel/workspace/NovelWorkbenchShell.vue')
  for (const token of [
    "const railWidth = ref(240)",
    "'--rail-w'",
    'var(--rail-w, 240px)',
    'var(--inspector-w, 320px)',
    '@media (max-width: 1180px)',
    '@media (max-width: 860px)',
    'focus-reading',
  ]) {
    assert.ok(shell.includes(token), `shell missing ${token}`)
  }
  const css = read('app/assets/studio.css')
  for (const token of ['--text-h1:', '--font-reading:', '--reading-measure:', '--focus-ring:', '--accent-text-strong:']) {
    assert.ok(css.includes(token), `studio.css missing ${token}`)
  }
})

test('设置接口暴露 GET /settings/ui', () => {
  const api = read('app/composables/useApi.ts')
  assert.match(api, /ui: \(\) => api\.get<\{ settings: UiDefaultsPayload \}>\('\/settings\/ui'\)/)
})
