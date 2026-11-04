import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-novel-atlas-job-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { createNovel, getNovel } = await import('../src/services/novels.ts')
const { startNovelJob, getNovelJob } = await import('../src/services/novel-job-runner.ts')
const { saveStoryAtlas } = await import('../src/services/novel/story-atlas-store.ts')

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

function stub(calls: string[]) {
  return {
    async complete(prompt: string) {
      const key = prompt.includes('设计世界地图') ? 'worldMap' : 'timeline'
      calls.push(key)
      if (key === 'worldMap') {
        return JSON.stringify({ places: [{ id: 'p1', name: '钟楼', x: 0.2, y: 0.3 }], regions: [], factions: [], routes: [] })
      }
      return JSON.stringify({ events: [{ chapterNo: 1, title: '开端', placeId: 'p1' }] })
    },
  }
}

test('atlas job runs worldMap then timeline with total 2', async () => {
  const novel = createNovel({ title: '地图任务', number_of_chapters: 5 })
  const calls: string[] = []
  const { job, completion } = startNovelJob({ novelId: novel.id, type: 'atlas', llm: stub(calls) })
  await completion
  assert.deepEqual(calls, ['worldMap', 'timeline'])
  const row = getNovelJob(job.id)!
  assert.equal(row.status, 'done')
  assert.equal(row.total, 2)
  const result = JSON.parse(row.result || '{}')
  assert.equal(result.scope, 'atlas')
  assert.deepEqual(result.steps.map((step: any) => step.key), ['worldMap', 'timeline'])
  const stored = getNovel(novel.id)!
  assert.equal(stored.worldMap?.places[0].name, '钟楼')
  assert.equal(stored.timelineEvents[0].title, '开端')
})

test('executing worldMap forces timeline overwrite even when timeline exists', async () => {
  const novel = createNovel({ title: '联动任务', number_of_chapters: 5 })
  // 只预置时间线、不预置地图：地图步骤会执行，从而强制重跑时间线
  saveStoryAtlas(novel.id, {
    timelineEvents: [{ id: 'old-1', chapterNo: 1, timeLabel: '', title: '旧事件', summary: '', importance: 3, source: 'architecture', status: 'planned' }],
  })
  const calls: string[] = []
  await startNovelJob({ novelId: novel.id, type: 'atlas', llm: stub(calls) }).completion
  assert.deepEqual(calls, ['worldMap', 'timeline'])
  assert.equal(getNovel(novel.id)!.timelineEvents[0].title, '开端')
})

test('atlas job fails without writing when map has no places', async () => {
  const novel = createNovel({ title: '空地图', number_of_chapters: 5 })
  const before = getNovel(novel.id)!
  await startNovelJob({
    novelId: novel.id,
    type: 'atlas',
    llm: { async complete() { return JSON.stringify({ places: [] }) } },
  }).completion
  const job = getNovelJob((await import('../src/services/novel-job-runner.ts')).listNovelJobs(novel.id)[0].id)!
  assert.equal(job.status, 'failed')
  assert.equal(getNovel(novel.id)!.worldMap, before.worldMap)
})
