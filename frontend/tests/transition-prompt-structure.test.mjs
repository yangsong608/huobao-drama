import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const episode = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const locales = ['zh', 'en', 'ja', 'ko'].map(lang => [
  lang,
  JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')),
])

test('断点行内提示词编辑器复用合片弹窗，不新增独立页面', () => {
  assert.match(episode, /class="ai-transition-row-head"/)
  assert.match(episode, /v-if="b\.id && transitionPromptOpen\[transitionPromptKey\(b\)\]"/)
  assert.match(episode, /class="input ai-transition-prompt-input"/)
  assert.match(episode, /toggleTransitionPrompt\(b\)/)
  assert.doesNotMatch(episode, /new-page|transition-prompt-dialog/i)
})

test('分析、保存、按提示词重生成均带当前文本模型', () => {
  assert.match(episode, /transitionAPI\.analyze\(boundary\.id, transitionTextModelPayload\(\)\)/)
  assert.match(episode, /transitionAPI\.savePrompt\(boundary\.id, prompt\)/)
  assert.match(episode, /transitionAPI\.retry\(boundary\.id, \{ prompt, \.\.\.transitionTextModelPayload\(\) \}\)/)
  assert.match(episode, /const model = chatModelOverride\(\)/)
  assert.match(episode, /text_model: model/)
  assert.match(episode, /text_config_id: configId/)
  assert.match(episode, /b\.status === 'processing' \|\| b\.status === 'pending'/)
})

test('提示词来源在界面可见，视觉回退有说明', () => {
  assert.match(episode, /transitionPromptSourceLabel\(b\)/)
  assert.match(episode, /transitionPromptEffectiveSource\(b\) === 'fallback'/)
  assert.match(episode, /aiTransition\.prompt\.fallbackNote/)
})

test('API 暴露分析与保存提示词接口', () => {
  assert.match(api, /analyze: \(id: number, payload: Record<string, any> = \{\}\) => api\.post<any>\(`\/merge\/transitions\/\$\{id\}\/analyze`/)
  assert.match(api, /savePrompt: \(id: number, prompt: string\) => api\.put<any>\(`\/merge\/transitions\/\$\{id\}\/prompt`/)
  assert.match(api, /retry: \(id: number, payload: Record<string, any> = \{\}\) => api\.post<any>/)
})

test('准备结果按失败断点提示，不把全失败当成功', () => {
  assert.match(episode, /const result = await transitionAPI\.prepare/)
  assert.match(episode, /result\?\.failures/)
  assert.match(episode, /const createdCount = Number\(result\?\.created \|\| 0\)/)
  assert.match(episode, /if \(createdCount === 0\) toast\.error\(message\)/)
  assert.match(episode, /toast\.warning\(t\('episode\.export\.aiTransition\.partialFailed'/)
})

test('重试与重生成都携带当前文本模型', () => {
  assert.match(episode, /transitionAPI\.retry\(boundary\.id, transitionTextModelPayload\(\)\)/)
  assert.match(episode, /transitionAPI\.retry\(boundary\.id, \{ prompt, \.\.\.transitionTextModelPayload\(\) \}\)/)
})

test('提示词草稿按脏状态同步，避免旧草稿覆盖新提示词', () => {
  assert.match(episode, /transitionPromptDirty/)
  assert.match(episode, /markTransitionPromptDirty\(b\)/)
  assert.match(episode, /function syncTransitionPromptDrafts\(\)/)
  assert.match(episode, /if \(transitionPromptOpen\.value\[key\] && !transitionPromptDirty\.value\[key\]\)/)
})

test('分析成功后本地来源立即切换为 AI 分析', () => {
  assert.match(episode, /transitionPromptAnalyzed/)
  assert.match(episode, /transitionPromptEffectiveSource/)
  assert.match(episode, /transitionPromptAnalyzed\.value = \{ \.\.\.transitionPromptAnalyzed\.value, \[key\]: true \}/)
})

test('跳过的断点提供重新生成入口', () => {
  assert.match(episode, /v-if="b\.status === 'skipped'"[\s\S]{0,220}retryTransitionItem\(b\)/)
  for (const [lang, bundle] of locales) {
    assert.ok(bundle?.episode?.export?.aiTransition?.resume, `${lang} 缺少 aiTransition.resume`)
  }
})

test('过渡列表只应用最新请求结果，离页后不再重启轮询', () => {
  assert.match(episode, /let transitionRequestSeq = 0/)
  assert.match(episode, /const seq = \+\+transitionRequestSeq/)
  assert.match(episode, /if \(seq !== transitionRequestSeq\) return/)
  assert.match(episode, /function scheduleTransitionPoll\(ids, seq\)/)
  assert.match(episode, /if \(panel\.value !== 'export'\) return/)
  assert.match(episode, /if \(current !== 'export'\) \{[\s\S]{0,120}transitionRequestSeq\+\+/)
})

test('过渡加载失败有可见提示', () => {
  assert.match(episode, /toastError\(e, \{ fallback: 'episode\.export\.aiTransition\.loadFailed' \}\)/)
  for (const [lang, bundle] of locales) {
    assert.ok(bundle?.episode?.export?.aiTransition?.loadFailed, `${lang} 缺少 aiTransition.loadFailed`)
  }
})

test('准备过渡按当前目标断点数量确认，不用全局计数', () => {
  assert.match(episode, /function transitionTargetCount\(ids\)/)
  assert.match(episode, /const targets = transitionTargetCount\(ids\)/)
  assert.doesNotMatch(episode, /const targets = missingTransitionCount\.value/)
})

test('分析结果不覆盖请求期间用户新写的草稿', () => {
  assert.match(episode, /const draftAtStart = transitionPromptDraftOf\(boundary\)/)
  assert.match(episode, /if \(transitionPromptDraftOf\(boundary\) !== draftAtStart\)/)
  assert.match(episode, /if \(transitionPromptDraftOf\(boundary\) === prompt\) markTransitionPromptClean\(boundary\)/)
  for (const [lang, bundle] of locales) {
    assert.ok(bundle?.episode?.export?.aiTransition?.prompt?.draftKept, `${lang} 缺少 prompt.draftKept`)
  }
})

test('提示词提交中禁用输入，输入框有无障碍标签', () => {
  assert.match(episode, /class="input ai-transition-prompt-input"[\s\S]{0,320}:disabled="transitionPromptBusy\[transitionPromptKey\(b\)\]"/)
  assert.match(episode, /:aria-label="t\('episode\.export\.aiTransition\.prompt\.label'\)"/)
  for (const [lang, bundle] of locales) {
    assert.ok(bundle?.episode?.export?.aiTransition?.prompt?.label, `${lang} 缺少 prompt.label`)
  }
})

test('合片弹窗异步加载不会覆盖用户手动切换的过渡开关', () => {
  assert.match(episode, /useAiTransitionsTouched: false/)
  assert.match(episode, /@change="mergeDialog\.useAiTransitionsTouched = true"/)
  assert.match(episode, /if \(mergeDialog\.value\.useAiTransitionsTouched\) return/)
})

test('过渡任务运行中禁用批量生成按钮', () => {
  assert.match(episode, /:disabled="!transitionSupported \|\| transitionPreparing \|\| transitionBusy"/)
  assert.match(episode, /transitionPreparing \|\| transitionBusy \|\| !mergeDialogBoundaries\.length/)
})

test('四语言都包含部分失败文案', () => {
  for (const [lang, bundle] of locales) {
    const value = bundle?.episode?.export?.aiTransition?.partialFailed
    assert.equal(typeof value, 'string', `${lang} 缺少 partialFailed`)
    assert.match(value, /\{n\}/, `${lang} partialFailed 缺少 {n}`)
  }
})

test('四语言都包含提示词编辑器文案', () => {
  for (const [lang, bundle] of locales) {
    const prompt = bundle?.episode?.export?.aiTransition?.prompt
    assert.ok(prompt, `${lang} 缺少提示词文案`)
    for (const key of ['toggle', 'analyze', 'analyzing', 'analyzeDone', 'placeholder', 'save', 'saved', 'regenerate', 'empty', 'hint', 'fallbackNote']) {
      assert.ok(prompt[key], `${lang} 缺少 prompt.${key}`)
    }
    for (const source of ['ai', 'fallback', 'manual', 'none']) {
      assert.ok(prompt.source?.[source], `${lang} 缺少 prompt.source.${source}`)
    }
  }
})
