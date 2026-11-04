/**
 * V3 i18n 收尾：小说相关组件实际使用的 t() 键、动态键族、
 * settings.novel / layout.nav 四语言对齐
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = new URL('../app/', import.meta.url)
const appRootPath = fileURLToPath(appRoot)
const read = (relative) => fs.readFileSync(new URL(relative, appRoot), 'utf8')
const locales = Object.fromEntries(
  ['zh', 'en', 'ja', 'ko'].map((lang) => [lang, JSON.parse(read(`locales/${lang}.json`))]),
)
const LANGS = ['zh', 'en', 'ja', 'ko']

function hasKey(locale, dotted) {
  let node = locale
  for (const part of dotted.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return false
    node = node[part]
  }
  return true
}

function leafKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, item]) => leafKeys(item, prefix ? `${prefix}.${key}` : key))
}

function sourceFiles(dir) {
  const files = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(vue|ts)$/.test(entry.name)) files.push(full)
    }
  }
  walk(path.join(appRootPath, dir))
  return files
}

test('小说相关源码中所有字面量 t() 键在四语言均存在', () => {
  const files = [
    ...sourceFiles('components/novel'),
    ...sourceFiles('views/novel'),
    ...sourceFiles('pages/novels'),
    new URL('stores/novel.ts', appRoot),
    new URL('composables/useNovelApi.ts', appRoot),
    new URL('composables/useNovelJobStream.ts', appRoot),
    new URL('components/AppHeader.vue', appRoot),
  ]
  const used = new Map()
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g)) {
      const key = match[1]
      if (!used.has(key)) used.set(key, [])
      used.get(key).push(file.pathname || file)
    }
  }
  assert.ok(used.size > 100, `expected a broad key surface, got ${used.size}`)
  for (const lang of LANGS) {
    for (const [key, sources] of used) {
      assert.ok(hasKey(locales[lang], key), `missing ${key} in ${lang} (used by ${sources[0]})`)
    }
  }
})

test('动态键族在四语言齐全（tab/状态/同步/架构/罗盘）', () => {
  const families = [
    ['overview', 'architecture', 'blueprint', 'writer', 'compass', 'export'].map((v) => `novels.tabs.${v}`),
    ['draft', 'writing', 'completed'].map((v) => `novels.status.${v}`),
    ['draft', 'final'].map((v) => `novels.chapterStatus.${v}`),
    ['new', 'updated', 'conflict', 'missing'].map((v) => `novels.sync.kind.${v}`),
    [
      'has_script', 'has_storyboards', 'has_video', 'has_subtitle',
      'has_dubbing', 'content_edited', 'automation_running', 'dubbing_running', 'episode_deleted',
    ].map((v) => `novels.sync.reason.${v}`),
    ['coreSeed', 'characterDynamics', 'characterState', 'worldBuilding', 'plotArchitecture', 'worldMap', 'timeline']
      .map((v) => `novels.architecture.fields.${v}`),
    ['error', 'warning', 'info'].map((v) => `novels.compass.auditPanel.severity.${v}`),
    ['active', 'deceased', 'offline'].map((v) => `novels.compass.status.${v}`),
    ['character', 'faction', 'location', 'item'].map((v) => `novels.compass.nodeTypes.${v}`),
    ['hostile', 'romantic', 'alliance', 'neutral', 'family', 'mentor']
      .map((v) => `novels.compass.relations.${v}`),
    ['base', 'snapshots', 'audit', 'atlas'].map((v) => `novels.compass.success.${v}`),
    ['relations', 'timeline', 'map'].map((v) => `novels.compass.views.${v}`),
    ['first', 'third_limited', 'third_omniscient'].map((v) => `novels.narrativePerson.${v}`),
  ].flat()
  for (const lang of LANGS) {
    for (const key of families) {
      assert.ok(hasKey(locales[lang], key), `missing ${key} in ${lang}`)
    }
  }
})

test('settings.novel 与 layout.nav 四语言键对齐', () => {
  for (const [namespace, section] of [['settings', 'novel'], ['layout', 'nav']]) {
    const base = leafKeys(locales.zh[namespace]?.[section]).sort()
    assert.ok(base.length > 0)
    for (const lang of LANGS.slice(1)) {
      assert.deepEqual(
        leafKeys(locales[lang][namespace]?.[section]).sort(),
        base,
        `${namespace}.${section} keys differ in ${lang}`,
      )
    }
  }
})

test('头部入口名称与设计 §13.3 一致（短剧/小说/设置）', () => {
  const nav = locales.zh.layout.nav
  assert.deepEqual(
    { projects: nav.projects, novels: nav.novels, settings: nav.settings },
    { projects: '短剧', novels: '小说', settings: '设置' },
  )
})

test('语言切换器覆盖四语言且导航入口均有文案', () => {
  const i18n = read('composables/i18n.ts')
  for (const lang of LANGS) assert.match(i18n, new RegExp(`value: '${lang}'`))
  assert.match(read('components/LocaleSwitcher.vue'), /UI_LOCALES/)
  const header = read('components/AppHeader.vue')
  assert.match(header, /LocaleSwitcher/)
  for (const key of ['projects', 'novels', 'settings']) {
    assert.match(header, new RegExp(`layout\\.nav\\.${key}`))
  }
})
