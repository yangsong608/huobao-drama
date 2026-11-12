import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const settings = readFileSync(new URL('../app/pages/settings.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const locales = ['zh', 'en', 'ja', 'ko'].map(lang => [
  lang,
  JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')),
])

test('设置页 Agent 配置提供知识库子页，按 Agent 分配/编辑，不做全员共读', () => {
  assert.match(api, /export const knowledgeAPI = \{/)
  assert.match(api, /list: \(lang\?: string\) => api\.get\(`\/knowledge\$\{langQ\(lang\)\}`\)/)
  assert.match(api, /setAgents: \(id: string, agents: string\[\]\) => api\.put\(`\/knowledge\/\$\{id\}\/agents`, \{ agents \}\)/)
  assert.match(settings, /agentPane === 'knowledge'/)
  assert.match(settings, /loadKnowledge\(\)/)
  assert.match(settings, /toggleKnowledgeEdit/)
  assert.match(settings, /saveKnowledgeItem/)
  assert.match(settings, /assignKnowledge/)
  assert.match(settings, /unassignKnowledge/)
  assert.match(settings, /不做全员共读/)
  assert.match(settings, /knowledge\/\{\{ k\.id \}\}\.md/)
})

test('四语言补齐知识库设置文案', () => {
  for (const [lang, bundle] of locales) {
    const kb = bundle.settings?.knowledge || {}
    for (const key of ['tab', 'desc', 'assignedCount', 'assign', 'unassign', 'required', 'fileMissing', 'content']) {
      assert.equal(typeof kb[key], 'string', `${lang} 缺少 settings.knowledge.${key}`)
    }
    assert.equal(typeof bundle.settings?.agents?.voiceDesigner, 'string', `${lang} 缺少 settings.agents.voiceDesigner`)
  }
})

test('关键 Agent 取消最后一个必读知识库前二次确认', () => {
  assert.match(settings, /CRITICAL_KNOWLEDGE_AGENTS/)
  assert.match(settings, /没有必读知识库，拆分\/校验\/提示词会被阻断/)
})

test('知识库支持新建与删除，弹窗参与返回层', () => {
  assert.match(settings, /knowledgeAPI\.create/)
  assert.match(settings, /confirmAddKnowledge/)
  assert.match(settings, /deleteKnowledgeItem/)
  assert.match(settings, /knowledgeDialog\.value/)
})

test('四语言补齐知识库新建/删除文案', () => {
  for (const [lang, bundle] of locales) {
    const kb = bundle.settings?.knowledge || {}
    for (const key of ['add', 'addTitle', 'id', 'idHint', 'create', 'created', 'delete', 'deleteConfirm']) {
      assert.equal(typeof kb[key], 'string', `${lang} 缺少 settings.knowledge.${key}`)
    }
  }
})
