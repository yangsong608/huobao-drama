import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const useApi = read('app/composables/useApi.ts')
const episode = read('app/views/drama/episode.vue')

test('分块拆分 API：创建、最近任务、按 ID 查询与续拆', () => {
  assert.match(useApi, /export const storyboardSplitAPI/)
  assert.match(useApi, /\/agent\/storyboard_breaker\/split-jobs'/)
  assert.match(useApi, /split-jobs\/latest\//)
  assert.match(useApi, /\/resume/)
})

test('制作页改用分块任务接口拆分，不再走超长同步请求', () => {
  assert.match(episode, /storyboardSplitAPI\.create/)
  assert.match(episode, /storyboardSplitAPI\.latest/)
  assert.match(episode, /storyboardSplitAPI\.resume/)
  assert.match(episode, /splitJob/)
  assert.match(episode, /splitRunning/)
  assert.match(episode, /startSplitPolling|splitPoll/)
  assert.equal(/runAgent\('storyboard_breaker'/.test(episode), false)
  // 续拆提示要出现在工具栏与空态
  assert.match(episode, /episode\.sb\.splitProgress/)
  assert.match(episode, /episode\.sb\.resumeSplit/)
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

test('制作页通过 Vue SFC 编译：纯 JS script setup 不得混入类型标注', () => {
  const filename = 'episode.vue'
  const { descriptor, errors } = parse(episode, { filename })
  assert.deepEqual(errors, [], 'SFC 结构解析失败')
  assert.equal(descriptor.scriptSetup?.lang, undefined, '该页面为纯 JS script setup')
  compileScript(descriptor, { id: 'episode' })
  const template = compileTemplate({ source: descriptor.template.content, filename, id: 'episode' })
  assert.deepEqual(template.errors, [], '模板编译失败')
})
