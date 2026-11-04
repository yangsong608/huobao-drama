import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  StoryAtlasValidationError,
  buildTimelineContext,
  mergeChapterTimeline,
  normalizeNarrativePerson,
  normalizeTimelineEvents,
  parseTimelineEvents,
  serializeTimelineEvents,
  type TimelineEvent,
} from '../src/services/novel/story-atlas.ts'

test('narrative person normalizes and falls back', () => {
  assert.equal(normalizeNarrativePerson('first'), 'first')
  assert.equal(normalizeNarrativePerson('third_omniscient'), 'third_omniscient')
  assert.equal(normalizeNarrativePerson('bogus'), 'third_limited')
  assert.equal(normalizeNarrativePerson(undefined, 'first'), 'first')
})

test('timeline normalizes ids, order, ranges and text limits', () => {
  const { events, warnings } = normalizeTimelineEvents([
    { chapterNo: 3, timeLabel: ' 第三日\n黄昏 ', title: ' 事件B ', summary: 'x'.repeat(600), importance: 9, placeId: 'p1', characters: ['甲', '乙'], source: 'architecture' },
    { chapterNo: 1, id: 'fixed-1', timeLabel: '第一日', title: '事件A', summary: ' ', importance: 0, status: 'confirmed' },
    { chapterNo: 99, title: '越界', timeLabel: '未来' },
    { chapterNo: 2, title: '' },
  ], { maxChapter: 10, defaultStatus: 'planned' })

  assert.deepEqual(events.map((event) => event.title), ['事件A', '事件B'])
  assert.equal(events[1].summary.length, 500)
  assert.equal(events[1].timeLabel, '第三日 黄昏')
  assert.equal(events[1].importance, 5)
  assert.equal(events[0].importance, 1)
  assert.equal(events[0].source, 'manual')
  assert.equal(events[0].status, 'confirmed')
  assert.match(events[1].id, /^evt-3-/)
  assert.ok(warnings.some((warning) => warning.includes('99')))
})

test('strict timeline validation throws on invalid chapter and duplicate ids regenerate', () => {
  assert.throws(
    () => normalizeTimelineEvents([{ chapterNo: 0, title: 'x' }], { maxChapter: 5, strict: true }),
    StoryAtlasValidationError,
  )
  const { events } = normalizeTimelineEvents([
    { id: 'same', chapterNo: 1, title: '一' },
    { id: 'same', chapterNo: 2, title: '二' },
  ], { maxChapter: 5 })
  assert.notEqual(events[0].id, events[1].id)
})

test('timeline serializes, parses and tolerates corrupt json', () => {
  const events = normalizeTimelineEvents([{ chapterNo: 1, title: '雾' }], { maxChapter: 10 }).events
  assert.deepEqual(parseTimelineEvents(serializeTimelineEvents(events)), events)
  assert.deepEqual(parseTimelineEvents('not json'), [])
  assert.deepEqual(parseTimelineEvents(null), [])
})

test('merge replaces only the target chapter and keeps stable order', () => {
  const existing: TimelineEvent[] = normalizeTimelineEvents([
    { id: 'a-1', chapterNo: 1, title: '旧一' },
    { id: 'a-2', chapterNo: 2, title: '旧二' },
    { id: 'a-3', chapterNo: 2, title: '旧三' },
    { id: 'a-4', chapterNo: 3, title: '旧四' },
  ], { maxChapter: 10 }).events
  const merged = mergeChapterTimeline(existing, 2, [
    { chapterNo: 2, title: '新二', source: 'chapter', status: 'confirmed' },
  ])
  assert.deepEqual(merged.map((event) => event.title), ['旧一', '新二', '旧四'])
  assert.equal(merged[1].source, 'chapter')
  assert.equal(merged[1].status, 'confirmed')
})

test('timeline context contains neighbors only', () => {
  const events = normalizeTimelineEvents([
    { chapterNo: 1, timeLabel: '前夜', title: '旧事', summary: '前情' },
    { chapterNo: 2, timeLabel: '当夜', title: '对峙', summary: '本章' },
    { chapterNo: 5, timeLabel: '多年后', title: '尾声', summary: '远处' },
  ], { maxChapter: 10 }).events
  const context = buildTimelineContext(events, 2, { radius: 1 })
  assert.match(context, /第1章 前夜：旧事/)
  assert.match(context, /第2章 当夜：对峙/)
  assert.doesNotMatch(context, /第5章/)
})

import {
  buildMapContext,
  normalizeWorldMap,
  parseModelJson,
  parseWorldMap,
  serializeWorldMap,
  readStoryAtlas,
} from '../src/services/novel/story-atlas.ts'

test('world map clamps coordinates, clears bad refs and drops bad routes', () => {
  const { data, warnings } = normalizeWorldMap({
    version: 1,
    regions: [{ id: 'r1', name: '北境', color: '#abc' }, { id: 'r1', name: '重复' }],
    factions: [{ id: 'f1', name: '守夜人' }],
    places: [
      { id: 'p1', name: '钟楼', regionId: 'r1', factionId: 'missing', x: -2, y: 3, importance: 9 },
      { id: 'p2', name: '渡口', regionId: 'missing' },
      { id: 'p3', name: '雪原', importance: 2 },
    ],
    routes: [
      { id: 'rt1', from: 'p1', to: 'p2', type: 'road' },
      { id: 'rt2', from: 'p1', to: 'nope', type: 'sea' },
      { id: 'rt3', from: 'p1', to: 'p2', type: 'sea' },
      { id: 'rt4', from: 'p2', to: 'p3', type: 'teleport' },
    ],
  })

  assert.ok(data)
  assert.equal(data!.version, 1)
  assert.equal(data!.places[0].x, 0)
  assert.equal(data!.places[0].y, 1)
  assert.equal(data!.places[0].importance, 5)
  assert.equal(data!.places[0].factionId, undefined)
  assert.equal(data!.places[1].regionId, undefined)
  assert.equal(data!.places[2].x >= 0 && data!.places[2].x <= 1, true)
  assert.equal(data!.places[2].y >= 0 && data!.places[2].y <= 1, true)
  assert.deepEqual(data!.routes.map((route) => route.id), ['rt1', 'rt4'])
  assert.equal(data!.routes[1].type, 'other')
  assert.equal(data!.regions.length, 2)
  assert.notEqual(data!.regions[0].id, data!.regions[1].id)
  assert.ok(warnings.length >= 2)
})

test('world map strict rejects non-object and empty places stays valid', () => {
  assert.throws(() => normalizeWorldMap(null, { strict: true }), StoryAtlasValidationError)
  const { data } = normalizeWorldMap({ version: 1, regions: [], factions: [], places: [], routes: [] })
  assert.deepEqual(data?.places, [])
})

test('world map parse tolerates corrupt json and serializes round-trip', () => {
  const { data } = normalizeWorldMap({ places: [{ id: 'p1', name: '城' }] })
  assert.deepEqual(parseWorldMap(serializeWorldMap(data!)), data)
  assert.equal(parseWorldMap('{broken'), null)
})

test('map context prefers chapter places and falls back to important places', () => {
  const { data } = normalizeWorldMap({
    regions: [{ id: 'r1', name: '北境' }],
    factions: [],
    places: [
      { id: 'p1', name: '钟楼', regionId: 'r1', description: '父亲失踪处', importance: 5 },
      { id: 'p2', name: '渡口', importance: 4 },
      { id: 'p3', name: '雪原', importance: 1 },
    ],
    routes: [],
  })
  const events = normalizeTimelineEvents([
    { chapterNo: 2, title: '对峙', placeId: 'p3' },
  ], { maxChapter: 10, placeIds: ['p1', 'p2', 'p3'] }).events
  assert.match(buildMapContext(data, events, 2), /雪原/)
  const fallback = buildMapContext(data, [], 2, { limit: 2 })
  assert.match(fallback, /钟楼/)
  assert.match(fallback, /渡口/)
  assert.doesNotMatch(fallback, /雪原/)
})

test('model json strips fences and rejects empty output', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseModelJson('说明 {"a":[1,2]} 结束'), { a: [1, 2] })
  assert.throws(() => parseModelJson('没有任何 JSON'), StoryAtlasValidationError)
})

test('readStoryAtlas parses both columns', () => {
  const { data } = normalizeWorldMap({ places: [{ id: 'p1', name: '城' }] })
  const parsed = readStoryAtlas({
    timelineEvents: [{ chapterNo: 1, title: '到达' }],
    worldMap: serializeWorldMap(data!),
  })
  assert.equal(parsed.timelineEvents.length, 1)
  assert.equal(parsed.worldMap?.places[0].name, '城')
})
