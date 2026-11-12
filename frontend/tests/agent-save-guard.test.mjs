import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const useAgent = read('app/composables/useAgent.ts')
const episode = read('app/views/drama/episode.vue')

test('代理返回 200 但缺少必需保存调用时不提示成功', () => {
  assert.match(useAgent, /function hasAgentToolCall/)
  assert.match(useAgent, /toolCalls/)
  assert.match(useAgent, /requireTool/)
  const checkIndex = useAgent.indexOf('hasAgentToolCall(data, options.requireTool)')
  const successIndex = useAgent.indexOf("toast.success(i18n.global.t('composables.agent.done'))")
  assert.ok(checkIndex >= 0, '缺少 requireTool 校验')
  assert.ok(successIndex > checkIndex, '必须先校验保存调用再提示成功')
  assert.match(useAgent, /toast\.error\(i18n\.global\.t\('composables\.agent\.noSave'\)\)/)
})

test('重新拆分走链式流水线接口：创建/续拆/进度轮询，替换与编号由后端负责', () => {
  assert.match(episode, /pipelineChainAPI\.createRun\(/)
  assert.match(episode, /pipelineChainAPI\.resume\(/)
  assert.match(episode, /pipelineChainAPI\.latestRun\(/)
  assert.match(episode, /const splitPoll = useVisibilityPolling\(/)
  // 单次同步调用已移除：不再由页面声明 save_storyboards / replace_existing
  assert.doesNotMatch(episode, /runAgent\('storyboard_breaker'/)
  assert.doesNotMatch(episode, /requireTool:\s*'save_storyboards'/)
  assert.doesNotMatch(episode, /replace_existing: true/)
})

test('四语言包含未保存错误提示', () => {
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    assert.ok(locale.composables?.agent?.noSave, `${lang} 缺少 composables.agent.noSave`)
  }
})

test('拆分方式选择器旁提示切换后需重新拆分才生效', () => {
  const selectIndex = episode.indexOf('video-method-select')
  const hintIndex = episode.indexOf('episode.sb.methodHint')
  assert.ok(hintIndex > selectIndex, '拆分方式选择器后缺少生效提示')
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    assert.ok(locale.episode?.sb?.methodHint, `${lang} 缺少 episode.sb.methodHint`)
  }
})

test('拆分保存后覆盖不足要提示实际段数与下限', () => {
  assert.match(useAgent, /function coverageShortfall/)
  assert.match(useAgent, /coverage\.ok !== false|coverage\.ok === false/)
  const guardIndex = useAgent.indexOf('hasAgentToolCall(data, options.requireTool)')
  const warningIndex = useAgent.indexOf("composables.agent.coverageShort")
  assert.ok(warningIndex > guardIndex, '覆盖不足提示必须在保存校验之后')

  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    const message = locale.composables?.agent?.coverageShort
    assert.ok(message, `${lang} 缺少 composables.agent.coverageShort`)
    assert.match(message, /\{actual\}/, `${lang} coverageShort 缺少 {actual}`)
    assert.match(message, /\{floor\}/, `${lang} coverageShort 缺少 {floor}`)
  }
})
