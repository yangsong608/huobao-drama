/**
 * 手机主导航（A5）：≤743 底部页签、顶栏导航隐藏、任务中心页与四语文案。
 * 与既有测试一致：读取源码做结构断言，不做浏览器运行。
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

const tabbarSource = read('components/MobileTabBar.vue')
const headerSource = read('components/AppHeader.vue')
const defaultLayout = read('layouts/default.vue')
const novelLayout = read('layouts/novel.vue')
const tasksPage = read('pages/tasks.vue')
const queuePanel = read('components/QueuePanel.vue')

test('底部页签覆盖四个主入口并始终保持可爬取', () => {
  for (const route of ['/', '/tasks', '/novels', '/settings']) {
    assert.ok(tabbarSource.includes(`to: '${route}'`), `底部页签缺少 ${route}`)
  }
  assert.match(tabbarSource, /<NuxtLink/)
  assert.match(tabbarSource, /aria-current="isActive\(item\.id\) \? 'page' : undefined"/)
  assert.doesNotMatch(tabbarSource, /<nav[\s\S]{0,120}v-if=/, '导航不得按视口条件移除，任务页需要被静态生成爬取')
})

test('底部页签只在 ≤743 显示，手机顶栏导航让位', () => {
  assert.match(tabbarSource, /@media \(min-width: 744px\)[\s\S]*?\.mobile-tabbar \{ display: none; \}/)
  assert.match(tabbarSource, /min-height: 44px/)
  assert.match(tabbarSource, /min-width: 44px/)
  const phoneBlock = headerSource.slice(headerSource.indexOf('@media (max-width: 743px)'))
  assert.match(phoneBlock, /\.header-nav \{ display: none; \}/)
})

test('软键盘弹出与配对页隐藏底部页签', () => {
  assert.match(tabbarSource, /focusin/)
  assert.match(tabbarSource, /focusout/)
  assert.match(tabbarSource, /'is-keyboard': keyboardOpen/)
  assert.match(tabbarSource, /\.mobile-tabbar\.is-keyboard/)
  assert.match(tabbarSource, /route\.path\.startsWith\('\/pair'\)/)
})

test('默认布局与小说布局挂载底部页签，工作室布局不挂载', () => {
  assert.match(defaultLayout, /<MobileTabBar \/>/)
  assert.match(novelLayout, /<MobileTabBar \/>/)
})

test('任务中心页复用现有队列组件并适配手机行布局', () => {
  assert.match(tasksPage, /<QueuePanel \/>/)
  assert.match(tasksPage, /t\('queue\.title'\)/)
  assert.match(queuePanel, /@media \(max-width: 743px\)/)
  assert.match(queuePanel, /\.queue-note \{ flex: 1 0 100%; white-space: normal;/)
  assert.match(queuePanel, /\.queue-actions \.wb-mini \{ min-width: 44px; min-height: 44px;/)
})

test('四语文案包含底部页签全部键', () => {
  const locales = ['zh', 'en', 'ja', 'ko']
  const keys = ['label', 'projects', 'tasks', 'novels', 'me']
  for (const locale of locales) {
    const json = JSON.parse(read(`locales/${locale}.json`))
    assert.ok(json.mobileNav, `${locale} 缺少 mobileNav`)
    for (const key of keys) {
      assert.ok(json.mobileNav[key], `${locale} 缺少 mobileNav.${key}`)
    }
  }
})
