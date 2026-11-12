import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const useApi = read('app/composables/useApi.ts')
const episode = read('app/views/drama/episode.vue')

test('链式流水线 API：创建、最近运行、trace、暂停与继续', () => {
  assert.match(useApi, /export const pipelineChainAPI/)
  assert.match(useApi, /createRun: \(payload: \{/)
  assert.match(useApi, /\/pipelines\/runs'/)
  assert.match(useApi, /runs\/latest\//)
  assert.match(useApi, /trace: \(runId: number\)/)
  assert.match(useApi, /resume: \(runId: number\)/)
})

test('制作页改用链式流水线接口拆分，不再走超长同步请求', () => {
  assert.match(episode, /pipelineChainAPI\.createRun/)
  assert.match(episode, /pipelineChainAPI\.latestRun/)
  assert.match(episode, /pipelineChainAPI\.resume/)
  assert.match(episode, /pipelineChainAPI\.trace/)
  assert.match(episode, /splitJob/)
  assert.match(episode, /splitRunning/)
  assert.match(episode, /startSplitPolling|splitPoll/)
  assert.equal(/runAgent\('storyboard_breaker'/.test(episode), false)
  // 续拆提示要出现在工具栏与空态
  assert.match(episode, /episode\.sb\.splitProgress/)
  assert.match(episode, /episode\.sb\.resumeSplit/)
  assert.match(episode, /episode\.sb\.pipelineRepairProgress/)
  // 进入页面恢复最近任务
  assert.match(episode, /restoreSplitJob/)
})

test('分块拆分文案四语言齐全且占位符一致', () => {
  const required = {
    splitProgress: ['{done}', '{total}', '{shots}'],
    splitFailed: ['{chunk}', '{total}', '{error}'],
    splitDone: ['{n}'],
    resumeSplit: [],
    splitActionFailed: [],
    splitStartFailed: [],
  }
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    for (const [key, placeholders] of Object.entries(required)) {
      const text = locale.episode?.sb?.[key]
      assert.ok(text, `${lang} 缺少 episode.sb.${key}`)
      for (const placeholder of placeholders) {
        assert.ok(text.includes(placeholder), `${lang} episode.sb.${key} 缺少 ${placeholder}`)
      }
    }
  }
})

test('失败镜提供人工处理入口：定位编辑 + 保存后继续校验', () => {
  assert.match(episode, /video-split-manual/)
  assert.match(episode, /focusPipelineShotNumber/)
  assert.match(episode, /focusPipelineShot\(shot\)/)
  assert.match(episode, /episode\.sb\.manualEdit/)
  assert.match(episode, /episode\.sb\.manualContinue/)
  assert.match(episode, /episode\.sb\.manualLocateHint/)
  const manualBlock = episode.slice(episode.indexOf('video-split-manual'), episode.indexOf('step-empty video-task-empty-state'))
  assert.match(manualBlock, /@click="resumeSplit"/)
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    for (const key of ['manualTitle', 'manualDesc', 'manualEdit', 'manualContinue', 'manualMissing', 'manualLocateHint']) {
      assert.equal(typeof locale.episode?.sb?.[key], 'string', `${lang} 缺少 episode.sb.${key}`)
    }
    assert.equal(typeof locale.episode?.soundPanel?.buttonHint, 'string', `${lang} 缺少 episode.soundPanel.buttonHint`)
  }
})

test('制作页通过 Vue SFC 编译：纯 JS script setup 不得混入类型标注', () => {
  const filename = 'episode.vue'
  const { descriptor, errors } = parse(episode, { filename })
  assert.deepEqual(errors, [], 'SFC 结构解析失败')
  assert.equal(descriptor.scriptSetup?.lang, undefined, '该页面为纯 JS script setup')
  compileScript(descriptor, { id: 'episode' })
  const template = compileTemplate({ source: descriptor.template.content, filename, id: 'episode' })
  assert.deepEqual(template.errors, [], '模板编译失败')
})
