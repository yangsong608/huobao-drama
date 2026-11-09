import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const episode = read('app/views/drama/episode.vue')
const useApi = read('app/composables/useApi.ts')
const locales = ['zh', 'en', 'ja', 'ko'].map((name) => JSON.parse(read(`app/locales/${name}.json`)))

test('task API exposes episode task center aggregation', () => {
  assert.match(useApi, /taskCenter: \(episodeId: number\) => api\.get<[\s\S]*?>\(`\/episodes\/\$\{episodeId\}\/task-center`\)/)
})

test('task drawer renders tabs for generation, voices, audio, pipeline and exports', () => {
  assert.match(episode, /const taskCenterTab = ref\(/)
  for (const tab of ['all', 'tasks', 'voices', 'audio', 'pipeline', 'exports']) {
    assert.match(episode, new RegExp(`key: '${tab}'`))
  }
  assert.match(episode, /t\('episode\.tasks\.tabTasks'\)/)
  assert.match(episode, /t\('episode\.tasks\.tabVoices'\)/)
  assert.match(episode, /t\('episode\.tasks\.tabAudio'\)/)
  assert.match(episode, /t\('episode\.tasks\.tabPipeline'\)/)
  assert.match(episode, /t\('episode\.tasks\.tabExports'\)/)
  // 生成任务与合并行归入 tasks 分类，其余来源各自分类
  assert.match(episode, /category: 'tasks'/)
  // 页签随可见行过滤
  assert.match(episode, /const visibleTaskCenterRows = computed\(/)
  assert.match(episode, /counts\.tasks_active/)
  assert.match(episode, /counts\.merges_active/)
})

test('task center aggregates every persisted task source', () => {
  assert.match(episode, /taskAPI\.taskCenter\(epId\.value\)/)
  assert.match(episode, /\(taskCenterData\.value\?\.voices\?\.items \|\| \[\]\)/)
  assert.match(episode, /const audio = taskCenterData\.value\?\.audio/)
  assert.match(episode, /for \(const job of audio\.jobs \|\| \[\]\)/)
  assert.match(episode, /const pipeline = taskCenterData\.value\?\.pipeline/)
  assert.match(episode, /for \(const job of pipeline\.jobs \|\| \[\]\)/)
  assert.match(episode, /\(taskCenterData\.value\?\.exports \|\| \[\]\)/)
  // 顶栏角标用后端全量活跃计数（含语音/混音/流水线/导出）
  assert.match(episode, /taskCenterData\.value\?\.counts\?\.total_active/)
})

test('non image/video task kinds have their own labels', () => {
  assert.match(episode, /kind === 'audio'\) return t\('episode\.tasks\.kindAudio'\)/)
  assert.match(episode, /kind === 'text'\) return t\('episode\.tasks\.kindText'\)/)
  assert.match(episode, /kind === 'voice'\) return t\('episode\.tasks\.kindVoice'\)/)
  assert.match(episode, /kind === 'pipeline'\) return t\('episode\.tasks\.kindPipeline'\)/)
  assert.match(episode, /kind === 'export'\) return t\('episode\.tasks\.kindExport'\)/)
  assert.match(episode, /return t\('episode\.tasks\.kindOther'\)/)
})

test('task center copy exists in all four locales', () => {
  const keys = [
    'centerTitle', 'metaCenter', 'tabAll', 'tabTasks', 'tabVoices', 'tabAudio', 'tabPipeline', 'tabExports',
    'kindAudio', 'kindText', 'kindVoice', 'kindPipeline', 'kindExport', 'kindOther',
    'statusQueued', 'statusRunning', 'statusCancelled', 'voiceReady', 'voiceLine', 'takeN',
    'dubSession', 'jobSoundscape', 'jobSeparate', 'pipelineAuto', 'pipelineJob', 'exportJob',
    'activeHint', 'runVideoPrompts', 'runExtract', 'runTakeBatch', 'runDub',
  ]
  for (const dict of locales) {
    const tasks = dict.episode?.tasks
    assert.ok(tasks, 'episode.tasks missing')
    for (const key of keys) {
      assert.equal(typeof tasks[key], 'string', `episode.tasks.${key} missing`)
      assert.ok(tasks[key].length > 0, `episode.tasks.${key} empty`)
    }
    assert.match(tasks.metaCenter, /\{n\}/)
  }
})
