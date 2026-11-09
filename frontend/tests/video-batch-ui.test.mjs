import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(path.join(root, rel), 'utf8')
const episode = read('app/views/drama/episode.vue')
const useApi = read('app/composables/useApi.ts')

test('批量视频 API：创建、查询、停止走剧集接口', () => {
  assert.match(useApi, /startVideoBatch:\s*\(id: number, payload/)
  assert.match(useApi, /\/episodes\/\$\{id\}\/video-batch`/)
  assert.match(useApi, /videoBatchStatus:\s*\(id: number\)/)
  assert.match(useApi, /stopVideoBatch:\s*\(id: number\)[\s\S]{0,80}video-batch\/stop/)
})

test('确认弹窗提供并发数选择（1-5，默认 1，本地记住）', () => {
  assert.match(episode, /videoBatchConcurrency/)
  assert.match(episode, /huobao\.videoBatchConcurrency/)
  assert.match(episode, /v-for="n in 5"/)
  assert.match(episode, /v-model\.number="batchVideoConcurrency"/)
  assert.match(episode, /t\('episode\.vid\.confirmConcurrency'\)/)
  assert.match(episode, /t\('episode\.vid\.confirmConcurrencyHint'\)/)
})

test('开始批量改为后端持久批次，不再逐个直接发起', () => {
  assert.match(episode, /async function confirmBatchVideos/)
  assert.match(episode, /episodeAPI\.startVideoBatch\(/)
  assert.match(episode, /concurrency:\s*batchVideoConcurrency\.value/)
  assert.match(episode, /items:\s*targets\.map/)
  assert.ok(!/targets\.forEach\(sb => genVid/.test(episode), '批量开始不得继续使用前端 forEach 并发')
  assert.match(episode, /batchFailedConfirm/)
})

test('批次进度轮询：可见时 3 秒刷新、结束自动停、停止后续按钮', () => {
  assert.match(episode, /useVisibilityPolling\(\(\) => refreshVideoBatch\(\), 3000\)/)
  assert.match(episode, /function startVideoBatchPolling/)
  assert.match(episode, /videoBatchPoll\.start\(\)/)
  assert.match(episode, /videoBatchPoll\.stop\(\)/)
  assert.match(episode, /function stopBatchVideo/)
  assert.match(episode, /episodeAPI\.stopVideoBatch\(/)
  assert.match(episode, /t\('episode\.vid\.batchStop'\)/)
  assert.match(episode, /class="video-batch-strip"/)
  assert.match(episode, /videoBatchProgress/)
})

test('进入页面恢复运行中批次并把在途项标为生成中', () => {
  assert.match(episode, /episodeAPI\.videoBatchStatus\(/)
  assert.match(episode, /refreshVideoBatch\(\)/)
  assert.match(episode, /pendingVideoIds\.value = \[/)
  assert.match(episode, /onMounted\([\s\S]{0,1200}refreshVideoBatch/)
  assert.match(episode, /onBeforeUnmount\([\s\S]{0,400}videoBatchPoll\.stop\(\)/)
})

test('四语言包含批量并发与进度文案', () => {
  const keys = [
    'confirmConcurrency', 'confirmConcurrencyHint',
    'batchRunning', 'batchCounts', 'batchStop', 'batchStopped', 'batchDone',
    'batchAlreadyRunning', 'batchFailedConfirm', 'batchFailedNote',
  ]
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const json = JSON.parse(read(`app/locales/${locale}.json`))
    const vid = json.episode.vid
    for (const key of keys) {
      assert.equal(typeof vid[key], 'string', `${locale}.episode.vid.${key}`)
      assert.ok(vid[key].length > 0, `${locale}.episode.vid.${key}`)
    }
  }
})
