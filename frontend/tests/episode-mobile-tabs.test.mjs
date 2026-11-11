/**
 * 手机分集工作台（A5）：五页签、紧凑顶栏与「更多」浮层、四语文案。
 * 只读源码结构测试：不执行组件、不启动 Nuxt。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const APP_ROOT = new URL('../app/', import.meta.url)

function read(relativePath) {
  try {
    return readFileSync(new URL(relativePath, APP_ROOT), 'utf8')
  } catch (error) {
    assert.fail(`无法读取 app/${relativePath}：${error.message}`)
  }
}

const tabsSource = read('components/EpisodeMobileTabs.vue')
const episodeSource = read('views/drama/episode.vue')
const phoneBlock = episodeSource.slice(episodeSource.indexOf('@media (max-width: 744px)'))

test('手机分集页签覆盖剧本/分镜/资产/生成/任务且只在 ≤743 显示', () => {
  for (const id of ['script', 'storyboard', 'assets', 'generate', 'tasks']) {
    assert.match(tabsSource, new RegExp(`id: '${id}'`), `缺少页签 ${id}`)
  }
  assert.match(tabsSource, /role="tablist"/)
  assert.match(tabsSource, /role="tab"/)
  assert.match(tabsSource, /:aria-selected="active === item\.id"/)
  assert.match(tabsSource, /emit\('select', item\.id\)/)
  assert.match(tabsSource, /min-width: 44px/)
  assert.match(tabsSource, /min-height: 44px/)
  assert.match(tabsSource, /@media \(min-width: 744px\)[\s\S]*?\.episode-mobile-tabs \{ display: none; \}/)
})

test('分集页只在手机挂载页签，并由页签切换面板与视频子视图', () => {
  assert.match(episodeSource, /<EpisodeMobileTabs[\s\S]*?v-if="isNarrow"/)
  assert.match(episodeSource, /:active="mobileStage"/)
  assert.match(episodeSource, /@select="selectMobileStage"/)

  const start = episodeSource.indexOf('function selectMobileStage')
  assert.notEqual(start, -1, '缺少 selectMobileStage')
  const end = episodeSource.indexOf('\n}', start)
  const body = episodeSource.slice(start, end)
  assert.match(body, /stage === 'tasks'[\s\S]*?openTaskDrawer\(\)/)
  assert.match(body, /goMainStage\(stage\)/)
  assert.match(body, /prodTab\.value = 'videos'/)
  assert.match(body, /setTabletPane\(stage === 'storyboard' \? 'shots' : 'edit'\)/)
  assert.match(body, /mobileMoreOpen\.value = false/)
})

test('页签高亮跟随现有面板状态', () => {
  const start = episodeSource.indexOf('const mobileStage = computed')
  assert.notEqual(start, -1, '缺少 mobileStage')
  const end = episodeSource.indexOf('function selectMobileStage', start)
  const body = episodeSource.slice(start, end)
  assert.match(body, /taskDrawer\.value[\s\S]*?'tasks'/)
  assert.match(body, /panel\.value === 'script'[\s\S]*?'script'/)
  assert.match(body, /prodTab\.value === 'assets'[\s\S]*?'assets'/)
  assert.match(body, /tabletPane\.value === 'shots' \? 'storyboard' : 'generate'/)
})

test('手机顶栏收成单行，模型与操作进入「更多」浮层且命中区 44px', () => {
  assert.match(episodeSource, /class="btn topbar-more-btn"[\s\S]*?:aria-expanded="mobileMoreOpen"/)
  assert.match(episodeSource, /<div class="studio-topbar-side" :class="\{ 'is-mobile-open': mobileMoreOpen \}">/)
  assert.match(episodeSource, /class="mobile-more-scrim"/)
  assert.match(episodeSource, /class="mobile-more-head"/)
  assert.match(episodeSource, /v-if="isNarrow" type="button" class="btn topbar-steps-btn" @click="mobileMoreOpen = false; openStepsDrawer\(\)"/)

  assert.match(phoneBlock, /\.studio-topbar \{[\s\S]*?flex-direction: row;/)
  assert.match(phoneBlock, /\.studio-meta-row \{ display: none; \}/)
  assert.match(phoneBlock, /\.studio-topbar-side \{ display: none; \}/)
  assert.match(phoneBlock, /\.studio-topbar-side\.is-mobile-open \{[\s\S]*?position: absolute;/)
  assert.match(phoneBlock, /\.studio-topbar \.topbar-more-btn \{[\s\S]*?min-height: 44px;/)
  assert.match(phoneBlock, /\.studio-topbar-side \.studio-actions \.btn \{[\s\S]*?min-height: 44px;/)
})

test('手机视频面板按单列堆叠，页签不再被两列压成竖排', () => {
  const compactBlock = episodeSource.slice(episodeSource.indexOf('@media (max-width: 900px)'))
  assert.match(
    compactBlock,
    /\.video-task-workbench,\s*\.video-task-workbench\.has-player \{[\s\S]*?grid-template-columns: 1fr;/,
    'has-player 特异性必须覆盖为单列',
  )
  assert.match(compactBlock, /\.video-tablet-bar \{[\s\S]*?display: flex;/)
})

test('横屏手机压缩顶栏，步骤条与模型选择横向滚动不重叠', () => {
  assert.match(
    episodeSource,
    /@media \(max-width: 1180px\) and \(max-height: 520px\) \{[\s\S]*?\.studio-model-picks \{[\s\S]*?flex-wrap: nowrap;[\s\S]*?overflow-x: auto;/,
    '横屏手机缺少模型选择单行规则',
  )
  assert.match(
    episodeSource,
    /\.studio-model-picks :deep\(\.model-select-label\) \{ white-space: nowrap; \}/,
    '模型标签必须单行，避免被压成竖排',
  )
  assert.match(
    episodeSource,
    /\.pipe-section \{ flex-direction: row; align-items: center; gap: 2px; flex-shrink: 0; \}/,
    '横向步骤条分组不得被压缩，否则文字重叠',
  )
})

test('四语文案包含手机分集页签全部键', () => {
  const locales = ['zh', 'en', 'ja', 'ko']
  const keys = ['label', 'more', 'moreTitle', 'closeMore', 'script', 'storyboard', 'assets', 'generate', 'tasks']
  for (const locale of locales) {
    const json = JSON.parse(read(`locales/${locale}.json`))
    assert.ok(json.episode.mobileTabs, `${locale} 缺少 episode.mobileTabs`)
    for (const key of keys) {
      assert.ok(json.episode.mobileTabs[key], `${locale} 缺少 episode.mobileTabs.${key}`)
    }
  }
})
