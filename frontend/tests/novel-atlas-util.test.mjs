import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMapGraphOption,
  eventPlaceIds,
  filterTimelineEvents,
} from '../app/utils/novel-atlas.ts'

const events = [
  { id: 'a', chapterNo: 1, title: '一', placeId: 'p1', status: 'planned' },
  { id: 'b', chapterNo: 2, title: '二', placeId: 'p2', status: 'confirmed' },
  { id: 'c', chapterNo: 3, title: '三', placeId: 'p1', status: 'planned' },
]

test('filterTimelineEvents supports chapter/all/confirmed scopes', () => {
  assert.deepEqual(filterTimelineEvents(events, { chapterNo: 2, scope: 'chapter' }).map((e) => e.id), ['b'])
  assert.deepEqual(filterTimelineEvents(events, { chapterNo: 2, scope: 'all' }).map((e) => e.id), ['a', 'b', 'c'])
  assert.deepEqual(filterTimelineEvents(events, { chapterNo: 2, scope: 'confirmed' }).map((e) => e.id), ['b'])
})

test('eventPlaceIds returns unique ids for a chapter', () => {
  assert.deepEqual([...eventPlaceIds(events, 2)], ['p2'])
  assert.deepEqual([...eventPlaceIds(events, 1)], ['p1'])
})

test('buildMapGraphOption maps places, highlight and routes', () => {
  const option = buildMapGraphOption({
    version: 1,
    generatedAt: null,
    regions: [{ id: 'r1', name: '北境', color: '#123456' }],
    factions: [{ id: 'f1', name: '守夜人', color: '#abcdef' }],
    places: [
      { id: 'p1', name: '钟楼', regionId: 'r1', factionId: 'f1', x: 0.25, y: 0.5, importance: 5 },
      { id: 'p2', name: '渡口', x: 0.8, y: 0.2, importance: 2 },
    ],
    routes: [{ id: 'rt', from: 'p1', to: 'p2', type: 'road', label: '旧驿道' }],
  }, { highlightIds: new Set(['p1']), dark: true })

  assert.equal(option.series[0].type, 'graph')
  assert.equal(option.series[0].layout, 'none')
  const node = option.series[0].data.find((item) => item.id === 'p1')
  assert.equal(node.itemStyle.color, '#abcdef')
  assert.equal(node.itemStyle.borderWidth, 3)
  assert.equal(option.series[0].links[0].source, 'p1')
  assert.equal(option.series[0].links[0].target, 'p2')
})

test('buildMapGraphOption returns empty graph for null map', () => {
  const option = buildMapGraphOption(null)
  assert.deepEqual(option.series[0].data, [])
  assert.deepEqual(option.series[0].links, [])
})
