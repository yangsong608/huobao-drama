import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const episode = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const locales = ['zh', 'en', 'ja', 'ko'].map(lang => [
  lang,
  JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')),
])

test('旧批量动作检验入口、面板与状态图标已从视频页移除', () => {
  assert.doesNotMatch(episode, /AuditStateBadge/)
  assert.doesNotMatch(episode, /auditPanel\.open/)
  assert.doesNotMatch(episode, /episode-audit-btn/)
  assert.doesNotMatch(episode, /episode-audit-status/)
  assert.doesNotMatch(episode, /runStoryboardAudit\(\)/)
  assert.doesNotMatch(episode, /undoAuditRepair\(\)/)
  assert.doesNotMatch(api, /storyboardAuditAPI/)
  assert.doesNotMatch(api, /storyboard-audit/)
})

test('失败镜使用新的人工处理与步骤追踪入口', () => {
  assert.match(episode, /video-split-manual/)
  assert.match(episode, /focusPipelineShotNumber/)
  assert.match(episode, /openPipelineTrace/)
  assert.match(episode, /episode\.sb\.manualDesc/)
  assert.match(episode, /episode\.sb\.manualEdit/)
  assert.match(episode, /episode\.sb\.manualContinue/)
})

test('四语言补齐人工处理文案', () => {
  for (const [lang, bundle] of locales) {
    for (const key of ['manualTitle', 'manualDesc', 'manualEdit', 'manualContinue', 'manualMissing', 'manualLocateHint']) {
      assert.equal(typeof bundle.episode?.sb?.[key], 'string', `${lang} 缺少 episode.sb.${key}`)
    }
  }
})
