import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const episode = read('app/views/drama/episode.vue')
const useApi = read('app/composables/useApi.ts')
const locales = ['zh', 'en', 'ja', 'ko'].map((name) => JSON.parse(read(`app/locales/${name}.json`)))

test('task API exposes episode-scoped bulk clear', () => {
  assert.match(useApi, /clearByEpisode: \(episodeId: number\) => api\.del<\{ deleted: number \}>\(`\/episodes\/\$\{episodeId\}\/generation-tasks`\)/)
})

test('task drawer only offers clearing finished tasks behind confirmation', () => {
  // 清空范围只统计 completed/failed，保留进行中任务与成片版本
  assert.match(episode, /const genTaskClearableCount = computed\(\(\) =>\s*genTasks\.value\.filter\(t => t\.status === 'completed' \|\| t\.status === 'failed'\)\.length/)
  assert.match(episode, /:disabled="!genTaskClearableCount \|\| clearTasks\.loading"/)
  assert.match(episode, /@click="clearTasks\.open = true"/)
  assert.match(episode, /taskAPI\.clearByEpisode\(epId\.value\)/)
  assert.match(episode, /failedVideoMessages\.value = \{\}/)
  assert.match(episode, /t\('episode\.tasks\.clearTitle'\)/)
  assert.match(episode, /t\('episode\.tasks\.clearMessage', \{ n: genTaskClearableCount \}\)/)
  assert.match(episode, /@confirm="confirmClearGenTasks"/)
  // 清空合并记录/磁盘文件不属于该动作
  assert.doesNotMatch(episode, /confirmClearGenTasks[\s\S]{0,600}mergeAPI/)
})

test('clear task copy exists in all four locales', () => {
  for (const dict of locales) {
    const tasks = dict.episode?.tasks
    assert.ok(tasks, 'episode.tasks missing')
    for (const key of ['clear', 'clearTitle', 'clearMessage', 'clearConfirm', 'cleared']) {
      assert.equal(typeof tasks[key], 'string')
      assert.ok(tasks[key].length > 0, `episode.tasks.${key} empty`)
    }
    assert.match(tasks.clearMessage, /\{n\}/)
    assert.match(tasks.cleared, /\{n\}/)
  }
})
