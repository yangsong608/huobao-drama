import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const episode = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const episodesRoute = readFileSync(new URL('../../backend/src/routes/episodes.ts', import.meta.url), 'utf8')
const tagsService = readFileSync(new URL('../../backend/src/services/storyboard-tags.ts', import.meta.url), 'utf8')
const locales = ['zh', 'en', 'ja', 'ko'].map(lang => [
  lang,
  JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')),
])

test('分镜卡片显示数据库镜头号，删除确认不再用列表序号', () => {
  assert.match(episode, /:title="t\('episode\.vid\.dbShotNumber'\)"/)
  assert.match(episode, /#S\{\{ String\(task\.shotNumber\)\.padStart\(2, '0'\) \}\}/)
  assert.match(episode, /const shotNumber = storyboardNumberOf\(sb\) \|\| index \+ 1/)
  assert.match(episode, /number: storyboardNumberOf\(sb\) \|\|/)
  assert.doesNotMatch(episode, /number: row\?\.index \+ 1/)
  const addStart = episode.indexOf('async function addStoryboard()')
  const addBlock = episode.slice(addStart, addStart + 900)
  assert.match(addBlock, /const nextShotNumber = sbs\.value\.reduce/)
  assert.match(addBlock, /newShotTitle', \{ n: nextShotNumber \}/)
  for (const [lang, bundle] of locales) {
    assert.equal(typeof bundle.episode?.vid?.dbShotNumber, 'string', `${lang} 缺少 episode.vid.dbShotNumber`)
  }
})

test('分镜卡片提供预置标签、手动增删与自动标签回退', () => {
  assert.match(episode, /const STORYBOARD_TAG_PRESETS = \[/)
  for (const key of ['transition', 'character', 'empty', 'dialogue', 'narration', 'combat', 'competition', 'memory']) {
    assert.match(episode, new RegExp(`'${key}'`), `缺少标签预设 ${key}`)
  }
  assert.match(episode, /function storyboardTagList\(sb\)/)
  assert.match(episode, /parseStoryboardTagValue\(sb\?\.tags\)/)
  assert.match(episode, /sb\?\.auto_tags \?\? sb\?\.autoTags/)
  assert.match(episode, /async function toggleStoryboardTag\(sb, key\)/)
  assert.match(episode, /await storyboardAPI\.update\(sb\.id, \{ tags: next \}\)/)
  assert.match(episode, /class="video-task-tags"/)
  assert.match(episode, /class="storyboard-tag-menu"/)
  assert.match(episode, /:class="'is-' \+ tag"/)
  assert.match(episode, /\.storyboard-tag\.is-transition/)
  for (const [lang, bundle] of locales) {
    for (const key of ['edit', 'transition', 'character', 'empty', 'dialogue', 'narration', 'combat', 'competition', 'memory']) {
      assert.equal(typeof bundle.episode?.sb?.tags?.[key], 'string', `${lang} 缺少 episode.sb.tags.${key}`)
    }
  }
})

test('列表接口过滤已删除分镜并返回存储标签与自动标签', () => {
  assert.match(episodesRoute, /isNull\(schema\.storyboards\.deletedAt\)/)
  assert.match(episodesRoute, /tags: parseStoryboardTags\(row\.tags\)/)
  assert.match(episodesRoute, /auto_tags: deriveStoryboardTags\(\{/)
  assert.match(tagsService, /NARRATION_LINE_RE/)
  assert.match(tagsService, /STORYBOARD_TAG_KEYS = \[/)
})
