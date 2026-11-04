import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('story timeline is a controlled editor with grouping and pagination', () => {
  const source = read('app/components/novel/story/StoryTimeline.vue')
  assert.match(source, /defineProps/)
  assert.match(source, /update:events/)
  assert.match(source, /editable/)
  assert.match(source, /PAGE_SIZE/)
  assert.match(source, /groupedEvents/)
  assert.match(source, /addEvent|removeEvent|updateEvent/)
})

test('world map renders echarts graph with highlight and edit controls', () => {
  const source = read('app/components/novel/story/WorldMap.vue')
  assert.match(source, /buildMapGraphOption/)
  assert.match(source, /update:mapData/)
  assert.match(source, /highlightIds/)
  assert.match(source, /editable/)
  assert.match(source, /chart\.setOption/)
  assert.match(source, /select-place/)
})

test('architecture panel exposes seven items and atlas controls', () => {
  const source = read('app/components/novel/ArchitecturePanel.vue')
  assert.match(source, /worldMap/)
  assert.match(source, /timeline/)
  assert.match(source, /StoryTimeline/)
  assert.match(source, /WorldMap/)
  assert.match(source, /startAtlas/)
  assert.match(source, /generateMissing|missingSteps/)
  assert.match(source, /force/)
})

test('architecture panel recovers atlas jobs', () => {
  const source = read('app/components/novel/ArchitecturePanel.vue')
  assert.match(source, /type === 'atlas'/)
  assert.match(source, /watchJob/)
})

test('blueprint panel adds narration column and patch dialog', () => {
  const source = read('app/components/novel/ChapterBlueprintPanel.vue')
  assert.match(source, /narration/)
  assert.match(source, /updateBlueprintNarration/)
  assert.match(source, /narrationDialog|narration-dialog/)
  assert.doesNotMatch(source, /await novelAPI\.update\([^)]*narration/)
})

test('writer panel mounts chapter atlas card and timeline warning', () => {
  const source = read('app/components/novel/ChapterWriterPanel.vue')
  assert.match(source, /ChapterAtlasCard/)
  assert.match(source, /timelineUpdated/)
  assert.match(source, /timelineError/)
})

test('compass switches relations/timeline/map and starts atlas job', () => {
  const source = read('app/components/novel/compass/InspirationCompass.vue')
  assert.match(source, /StoryTimeline/)
  assert.match(source, /WorldMap/)
  assert.match(source, /compass\.views/)
  assert.match(source, /startStoryAtlas/)
})

test('create dialog defaults to first person', () => {
  const source = read('app/components/novel/CreateProjectDialog.vue')
  assert.match(source, /narrative_person/)
  assert.match(source, /narrativePerson:\s*'first'/)
  assert.match(source, /novels\.createDialog\.narrativePersonLabel/)
})

test('novel detail shows person and seven-step progress', () => {
  const source = read('app/views/novel/detail.vue')
  assert.match(source, /narrativePerson/)
  assert.match(source, /worldMap/)
  assert.match(source, /timelineEvents/)
  assert.match(source, /7/)
  assert.match(source, /novels\.narrativePerson/)
})
