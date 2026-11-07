/**
 * A1-7：抽屉会话、断线续传与安全渲染
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAgentMarkdown } from '../app/utils/agent-markdown.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

function flatten(blocks) {
  return blocks.flatMap((block) => {
    if (block.type === 'heading') return [{ type: block.type, text: block.inlines.map(token => token.text).join('') }]
    if (block.type === 'paragraph' || block.type === 'quote') {
      return block.lines.map(line => ({ type: block.type, text: line.map(token => token.text).join('') }))
    }
    if (block.type === 'list') return block.items.map(item => ({ type: block.type, text: item.map(token => token.text).join('') }))
    return [{ type: block.type, text: block.text ?? '' }]
  })
}

test('Markdown 子集：标题、列表、代码与 HTTP(S) 链接', () => {
  const blocks = parseAgentMarkdown('# 标题\n\n- 一\n- 二\n\n```js\nconst a = 1 < 2\n```\n\n[官网](https://example.com/a)')
  const flat = flatten(blocks)
  assert.ok(flat.some(item => item.type === 'heading' && item.text === '标题'))
  assert.ok(flat.some(item => item.type === 'list' && item.text === '一'))
  assert.ok(flat.some(item => item.type === 'code' && item.text.includes('const a = 1 < 2')))
  const link = blocks
    .find(block => block.type === 'paragraph')
    ?.lines.flat()
    .find(token => token.type === 'link')
  assert.equal(link?.href, 'https://example.com/a')
})

test('原始 HTML、脚本与图片按纯文本处理，不产生标签', () => {
  const blocks = parseAgentMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n![图](https://example.com/a.png)')
  const serialized = JSON.stringify(blocks)
  assert.doesNotMatch(serialized, /"type":"(html|image|script)"/)
  assert.doesNotMatch(serialized, /"href":"javascript:/)
  const texts = flatten(blocks).map(item => item.text).join('\n')
  assert.match(texts, /<script>alert\(1\)<\/script>/)
  assert.match(texts, /<img src=x onerror=alert\(1\)>/)
  assert.match(texts, /!\[图\]/)
})

test('javascript: 与 data: 链接只保留文字', () => {
  for (const source of ['[点我](javascript:alert(1))', '[点我](data:text/html;base64,PHNjcmlwdD4=)']) {
    const blocks = parseAgentMarkdown(source)
    const links = JSON.stringify(blocks).match(/"type":"link"/g) ?? []
    assert.equal(links.length, 0)
    assert.ok(flatten(blocks).some(item => item.text.includes('点我')))
  }
})

test('抽屉使用结构化渲染，不启用 v-html 与外部图片', () => {
  const dock = read('app/components/agent/AgentDock.vue')
  const markdown = read('app/components/agent/AgentMarkdown.vue')
  const inline = read('app/components/agent/AgentInline.vue')
  assert.match(dock, /<AgentMarkdown/)
  assert.doesNotMatch(dock, /v-html/)
  assert.doesNotMatch(markdown, /v-html/)
  assert.doesNotMatch(dock, /<img\b/)
  assert.doesNotMatch(markdown, /<img\b/)
  assert.match(inline, /target="_blank"/)
  assert.match(inline, /rel="noopener noreferrer"/)
  assert.match(inline, /token\.type === 'link'/)
})

test('会话、历史与分页接口集中在 assistantAPI 封装', () => {
  const api = read('app/composables/useApi.ts')
  for (const token of [
    'export const assistantAPI',
    "'/assistant/sessions/resolve'",
    "'/assistant/sessions'",
    '/assistant/sessions/${sessionId}/messages',
    '/assistant/sessions/${sessionId}/cancel',
    'streamUrl:',
    'before_id',
  ]) {
    assert.ok(api.includes(token), `missing ${token}`)
  }
  const source = read('app/composables/useAssistant.ts')
  for (const token of ['refreshThreads', 'switchSession', 'loadEarlier']) {
    assert.ok(source.includes(token), `missing ${token}`)
  }
})

test('SSE 支持 after_seq 续传、重连与终态收敛', () => {
  const source = read('app/composables/useAssistant.ts')
  const api = read('app/composables/useApi.ts')
  assert.ok(api.includes('after_seq='), 'missing after_seq in streamUrl')
  for (const token of [
    'AbortController',
    'scheduleReconnect',
    "event === 'reset'",
    "event === 'delta'",
    "event === 'done'",
    "event === 'error'",
    'streamCursor',
  ]) {
    assert.ok(source.includes(token), `missing ${token}`)
  }
})

test('生成中禁用发送，停止按钮独立；关闭抽屉不取消回答', () => {
  const dock = read('app/components/agent/AgentDock.vue')
  assert.match(dock, /:disabled="!sendReady \|\| !draft\.trim\(\)"/)
  assert.match(dock, /@click="cancel"/)
  assert.doesNotMatch(dock, /@click="closeAgentDock"[^>]*cancel/)
  const closeHandler = dock.match(/@click="closeAgentDock"/g) ?? []
  assert.equal(closeHandler.length, 1)
  const source = read('app/composables/useAssistant.ts')
  assert.match(source, /const busy = computed\(\(\) => sending\.value \|\| cancelling\.value \|\| streaming\.value\)/)
})

test('自动识别锁定作用域；关闭自动识别后需手动选择作用域', () => {
  const dock = read('app/components/agent/AgentDock.vue')
  assert.match(dock, /scope\.autoDetect !== false/)
  assert.match(dock, /v-if="!autoDetect"[\s\S]*v-model="manualScopeKind"/)
  assert.match(dock, /const sendReady = computed\(\(\) => canSend\.value && Boolean\(effectiveScope\.value\)\)/)
})

test('工具展开显示纯文本参数与结果', () => {
  const dock = read('app/components/agent/AgentDock.vue')
  assert.match(dock, /agent-tool-args/)
  assert.match(dock, /argsText/)
  assert.match(dock, /agent-tool-result/)
})

test('工具轨迹折叠且为纯文本；提案卡一次一个、无批量与自动应用', () => {
  const dock = read('app/components/agent/AgentDock.vue')
  const card = read('app/components/agent/AgentProposalCard.vue')
  assert.match(dock, /<details[\s\S]*agent-tools/)
  assert.match(dock, /agent-tool-result/)
  assert.match(dock, /plainToolText/)
  assert.match(dock, /<AgentProposalCard/)
  assert.match(dock, /messageProposals\(message\)/)
  assert.doesNotMatch(card, /v-html/)
  assert.doesNotMatch(card, /applyAll|batchApply|apply_all|批量/)
  assert.doesNotMatch(card, /watch\([\s\S]*applyProposal/)
  assert.doesNotMatch(card, /onMounted\([\s\S]*applyProposal/)
  assert.match(card, /confirmReject/)
  assert.match(card, /proposal\.before/)
  assert.match(card, /proposal\.after/)
  assert.match(card, /assistant\.proposal\.expiredReasons/)
  assert.match(card, /AGENT_PROPOSAL_CONFLICT/)
  assert.match(card, /:disabled="disabled \|\| Boolean\(busy\)"/)
  const assistant = read('app/composables/useAssistant.ts')
  assert.match(assistant, /event === 'proposal'/)
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`app/locales/${locale}.json`))
    for (const key of ['apply', 'reject', 'viewRaw', 'conflictHint', 'expiredHint', 'applying']) {
      assert.equal(typeof json.assistant.proposal?.[key], 'string', `${locale} missing assistant.proposal.${key}`)
    }
  }
})

test('建议卡只提供导航，不自动执行或批量执行', () => {
  const dock = read('app/components/agent/AgentDock.vue')
  const card = read('app/components/agent/AgentSuggestionCard.vue')
  const adapter = read('app/composables/useAgentPageAdapter.ts')
  const assistant = read('app/composables/useAssistant.ts')

  assert.match(dock, /<AgentSuggestionCard/)
  assert.match(dock, /messageSuggestions\(message\)/)
  assert.match(dock, /activeAdapter\.value\?\.runSuggestion/)
  assert.match(dock, /onSuggestionOpen/)
  assert.match(dock, /suggestionMatchesScope\(suggestion, scope\.value\)/)
  assert.match(dock, /const target = suggestionNavigation\(suggestion\)/)
  assert.doesNotMatch(dock, /agentAPI|runAgent|createAgentProposal/)
  const navigation = read('app/utils/agent-suggestion-navigation.ts')
  assert.match(navigation, /prefill\.storyboard_id/)
  assert.match(navigation, /focus_storyboard_id/)
  assert.match(navigation, /query\.focus_line_id/)
  assert.match(navigation, /{ open: page }/)
  assert.doesNotMatch(card, /v-html/)
  assert.doesNotMatch(card, /applyAll|batchApply|apply_all|runAll|批量/)
  assert.doesNotMatch(card, /onMounted|watch\(/)
  assert.match(card, /emit\('open', suggestion\)/)
  assert.match(card, /assistant\.suggestion\.noAutoRun/)
  assert.match(card, /action === 'agent\.run'/)
  assert.match(assistant, /event === 'suggestion'/)
  assert.match(adapter, /export interface AgentSuggestionPrefill/)
  assert.match(adapter, /runSuggestion\?:/)

  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`app/locales/${locale}.json`))
    const suggestion = json.assistant.suggestion
    assert.equal(typeof suggestion?.title, 'string', `${locale} missing assistant.suggestion.title`)
    assert.equal(typeof suggestion?.openAgent, 'string', `${locale} missing assistant.suggestion.openAgent`)
    assert.equal(typeof suggestion?.openPage, 'string', `${locale} missing assistant.suggestion.openPage`)
    assert.equal(typeof suggestion?.noAutoRun, 'string', `${locale} missing assistant.suggestion.noAutoRun`)
    for (const target of ['script_rewriter', 'extractor', 'storyboard_breaker', 'prompt_generator', 'voice_designer']) {
      assert.equal(typeof suggestion?.targets?.agents?.[target], 'string', `${locale} missing suggestion agent ${target}`)
    }
    for (const page of ['script', 'assets', 'videos', 'dubbing', 'edit', 'director', 'mix', 'delivery']) {
      assert.equal(typeof suggestion?.targets?.pages?.[page], 'string', `${locale} missing suggestion page ${page}`)
    }
  }
})

test('稳定错误码映射四语文案，未知错误保留脱敏后的原文', () => {
  const codes = [
    'AGENT_DISABLED',
    'AGENT_INTERNAL',
    'AGENT_MESSAGE_NOT_FOUND',
    'AGENT_SCOPE_FORBIDDEN',
    'AGENT_SCOPE_GONE',
    'AGENT_SCOPE_INVALID',
    'AGENT_SCOPE_NOT_FOUND',
    'AGENT_SESSION_CONFLICT',
    'AGENT_SESSION_INVALID',
    'AGENT_SESSION_NOT_FOUND',
    'assistant_failed',
    'interrupted',
  ]
  const dock = read('app/components/agent/AgentDock.vue')
  assert.match(dock, /localizedAssistantError/)
  assert.match(dock, /t\(`assistant\.errors\.\$\{code\}`\)/)
  assert.doesNotMatch(dock, /\{\{ error \}\}/)
  const source = read('app/composables/useAssistant.ts')
  assert.match(source, /sanitizeErrorText/)
  assert.match(source, /\.slice\(0, 300\)/)
  const api = read('app/composables/useApi.ts')
  assert.match(api, /error\.errorCode = typeof json\.error_code === 'string'/)
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`app/locales/${locale}.json`))
    for (const code of codes) {
      assert.equal(typeof json.assistant.errors?.[code], 'string', `${locale} missing assistant.errors.${code}`)
    }
  }
})
