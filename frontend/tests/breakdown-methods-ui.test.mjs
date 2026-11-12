import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const settings = read('app/pages/settings.vue')
const useApi = read('app/composables/useApi.ts')

const BREAKDOWN_KEYS = [
  'title', 'subtitle', 'new', 'name', 'description', 'prompt', 'skill',
  'promptHint', 'skillHint', 'bothEmptyHint', 'save', 'saving', 'saved',
  'reset', 'resetConfirm', 'duplicate', 'delete', 'deleteTitle', 'deleteMessage',
  'deleteUsage', 'unsaved', 'empty', 'loadFailed', 'builtin', 'custom',
  'customized', 'usage',
]

test('设置页新增分镜拆分页签，位于规则与智能体之间', () => {
  assert.match(settings, /const SETTINGS_TABS = \[[^\]]*'rules', 'breakdown', 'pipeline', 'agents'/)
  assert.match(settings, /id: 'breakdown', label: t\('settings\.tabs\.breakdown'\), icon: Layers/)
  assert.match(settings, /import \{[^}]*Layers[^}]*\} from 'lucide-vue-next'/)
  assert.match(settings, /v-if="tab === 'breakdown'"/)
  assert.match(settings, /if \(t === 'breakdown'\) loadBreakdownMethods\(\)/)
})

test('设置页方案管理只通过 breakdownMethodAPI 调用接口', () => {
  assert.match(useApi, /export const breakdownMethodAPI = \{/)
  for (const method of ['list', 'get', 'create', 'update', 'del', 'reset', 'duplicate']) {
    assert.match(useApi, new RegExp(`${method}: \\(`), `breakdownMethodAPI.${method}`)
  }
  assert.match(useApi, /breakdownMethodAPI\.list|api\.get\('\/breakdown-methods'\)/)
  assert.match(settings, /breakdownMethodAPI\.list\(\)/)
  assert.match(settings, /breakdownMethodAPI\.get\(/)
  assert.match(settings, /breakdownMethodAPI\.create\(/)
  assert.match(settings, /breakdownMethodAPI\.update\(/)
  assert.match(settings, /breakdownMethodAPI\.reset\(/)
  assert.match(settings, /breakdownMethodAPI\.duplicate\(/)
  assert.match(settings, /breakdownMethodAPI\.del\(/)
  assert.doesNotMatch(settings, /fetch\('\/api\/v1\/breakdown-methods/)
})

test('方案编辑支持新增、保存、复制、恢复默认与删除确认', () => {
  for (const state of [
    'breakdownMethods', 'breakdownLoading', 'breakdownSaving',
    'breakdownDraft', 'breakdownOriginal', 'breakdownEditingKey', 'breakdownToDelete',
  ]) {
    assert.match(settings, new RegExp(`const ${state} = ref`), state)
  }
  assert.match(settings, /const breakdownDirty = computed/)
  assert.match(settings, /function loadBreakdownMethods/)
  assert.match(settings, /function selectBreakdownMethod/)
  assert.match(settings, /function newBreakdownMethod/)
  assert.match(settings, /async function saveBreakdownMethod/)
  assert.match(settings, /async function resetBreakdownMethod/)
  assert.match(settings, /async function duplicateBreakdownMethod/)
  assert.match(settings, /async function confirmDeleteBreakdownMethod/)
  assert.match(settings, /window\.confirm\(t\('settings\.breakdown\.unsaved'\)\)/)
  assert.match(settings, /window\.confirm\(t\('settings\.breakdown\.resetConfirm'\)\)/)
  assert.match(settings, /:open="!!breakdownToDelete"/)
  assert.match(settings, /t\('settings\.breakdown\.deleteUsage', \{ count: breakdownToDelete\?\.usage_count \|\| 0 \}\)/)
  assert.match(settings, /v-if="currentBreakdownMethod && !currentBreakdownMethod\.builtin"/)
  assert.match(settings, /v-if="currentBreakdownMethod\?\.builtin"/)
  assert.match(settings, /breakdownDraft(?:\.value)?\.prompt\.trim\(\)/)
  assert.match(settings, /breakdownDraft(?:\.value)?\.skill\.trim\(\)/)
  assert.match(settings, /v-if="bothBreakdownTextsEmpty"/)
})

test('未保存标记使用短标签，切换确认沿用完整提示', () => {
  assert.match(settings, /v-if="breakdownDirty"[^>]*>\{\{ t\('settings\.breakdown\.unsavedTag'\) \}\}/)
  assert.match(settings, /window\.confirm\(t\('settings\.breakdown\.unsaved'\)\)/)
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const messages = JSON.parse(read(`app/locales/${lang}.json`))
    const tag = messages.settings?.breakdown?.unsavedTag
    assert.ok(typeof tag === 'string' && tag.trim(), `${lang} 缺少 settings.breakdown.unsavedTag`)
    assert.notEqual(tag, messages.settings.breakdown.unsaved, `${lang} unsavedTag 不能复用确认句`)
    assert.ok(tag.length <= 12, `${lang} unsavedTag 应为短标签`)
  }
})

test('方案列表标题显示方案数量而非集数', () => {
  assert.match(settings, /t\('settings\.breakdown\.methodCount', \{ count: breakdownMethods\.length \}\)/)
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const messages = JSON.parse(read(`app/locales/${lang}.json`))
    const label = messages.settings?.breakdown?.methodCount
    assert.ok(typeof label === 'string' && label.trim(), `${lang} 缺少 settings.breakdown.methodCount`)
    assert.match(label, /\{count\}/, `${lang} methodCount 需要计数占位符`)
    assert.notEqual(label, messages.settings.breakdown.usage, `${lang} methodCount 不能复用集数文案`)
  }
})

test('四种语言的页签与管理文案齐全', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const messages = JSON.parse(read(`app/locales/${lang}.json`))
    assert.ok(messages.settings?.tabs?.breakdown, `${lang} 缺少 settings.tabs.breakdown`)
    for (const key of BREAKDOWN_KEYS) {
      const value = messages.settings?.breakdown?.[key]
      assert.ok(typeof value === 'string' && value.trim(), `${lang} 缺少 settings.breakdown.${key}`)
    }
  }
})
