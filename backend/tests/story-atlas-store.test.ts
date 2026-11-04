import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-atlas-store-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { createNovel, getNovel } = await import('../src/services/novels.ts')
const {
  StoryAtlasConflictError,
  StoryAtlasNotFoundError,
  saveStoryAtlas,
  writeTimelineEvents,
  writeWorldMap,
} = await import('../src/services/novel/story-atlas-store.ts')
const {
  normalizeTimelineEvents,
  normalizeWorldMap,
} = await import('../src/services/novel/story-atlas.ts')

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('saveStoryAtlas writes both columns and refreshes updated_at', async () => {
  const novel = createNovel({ title: '坐标库', number_of_chapters: 10 })
  // 等过一个毫秒，避免同一毫秒内 updated_at 相同导致误判
  await new Promise((resolve) => setTimeout(resolve, 5))
  const map = normalizeWorldMap({
    places: [{ id: 'p1', name: '钟楼' }, { id: 'p2', name: '渡口' }],
    routes: [{ id: 'r1', from: 'p1', to: 'p2', type: 'road' }],
  }).data!
  const events = normalizeTimelineEvents([
    { chapterNo: 2, title: '对峙', placeId: 'p1' },
  ], { maxChapter: 10, placeIds: ['p1', 'p2'] }).events

  const saved = saveStoryAtlas(novel.id, {
    timelineEvents: events,
    worldMap: map,
    baseUpdatedAt: novel.updatedAt,
  })

  assert.equal(saved.timelineEvents.length, 1)
  assert.equal(saved.worldMap?.places.length, 2)
  assert.notEqual(saved.updatedAt, novel.updatedAt)
  const stored = getNovel(novel.id)
  assert.deepEqual(stored?.timelineEvents, events)
  assert.equal(stored?.worldMap?.places[0].name, '钟楼')
})

test('saveStoryAtlas rejects stale base_updated_at', () => {
  const novel = createNovel({ title: '冲突库', number_of_chapters: 5 })
  saveStoryAtlas(novel.id, {
    timelineEvents: [{ chapterNo: 1, title: '一' }],
    baseUpdatedAt: novel.updatedAt,
  })
  assert.throws(
    () => saveStoryAtlas(novel.id, {
      timelineEvents: [{ chapterNo: 2, title: '二' }],
      // 固定一个必然过期的基准，避免同一毫秒内 updated_at 未变化导致漏报
      baseUpdatedAt: '2000-01-01T00:00:00.000Z',
    }),
    (error: unknown) => error instanceof StoryAtlasConflictError
      && typeof (error as StoryAtlasConflictError).currentUpdatedAt === 'string',
  )
})

test('saving a new map clears timeline placeIds that no longer exist', () => {
  const novel = createNovel({ title: '地图联动', number_of_chapters: 5 })
  saveStoryAtlas(novel.id, {
    timelineEvents: [{ chapterNo: 1, title: '旧事件', placeId: 'p1', placeName: '旧钟楼' }],
    worldMap: { places: [{ id: 'p1', name: '旧钟楼' }] },
    baseUpdatedAt: novel.updatedAt,
  })
  const current = getNovel(novel.id)!
  const saved = saveStoryAtlas(novel.id, {
    worldMap: { places: [{ id: 'p2', name: '新渡口' }] },
    baseUpdatedAt: current.updatedAt,
  })
  assert.equal(saved.timelineEvents[0].placeId, undefined)
  assert.equal(saved.timelineEvents[0].placeName, '旧钟楼')
  assert.ok(saved.warnings.some((warning) => warning.includes('p1')))
})

test('store validates missing novel and empty patch', () => {
  assert.throws(() => saveStoryAtlas(999999, { timelineEvents: [] }), StoryAtlasNotFoundError)
  const novel = createNovel({ title: '空补丁', number_of_chapters: 3 })
  assert.throws(() => saveStoryAtlas(novel.id, {}), /至少提供/)
  assert.throws(() => writeTimelineEvents(999999, []), StoryAtlasNotFoundError)
  assert.throws(() => writeWorldMap(999999, normalizeWorldMap({ places: [] }).data!), StoryAtlasNotFoundError)
})
