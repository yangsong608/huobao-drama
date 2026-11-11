/**
 * 独立应用模式信号：壳对象、client 查询参数、本机存储、PWA 跳过与安装入口隐藏。
 * 与仓库既有前端测试一致，读取源码做结构断言。
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

const bridgeSource = read('composables/useAppBridge.ts')
const pluginSource = read('plugins/app.client.ts')
const pwaPluginSource = read('plugins/pwa.client.ts')
const appHeaderSource = read('components/AppHeader.vue')

test('应用桥只暴露设计约定的受限方法，平台固定为 Android', () => {
  assert.match(bridgeSource, /export interface HuobaoAppBridge/)
  assert.match(bridgeSource, /platform: 'android'/)
  for (const method of ['openScanner', 'backToLocal', 'setActiveTaskCount', 'exportLogs']) {
    assert.match(bridgeSource, new RegExp(`\\b${method}\\b`), `应用桥缺少 ${method}`)
  }
  assert.match(bridgeSource, /huobaoApp/)
  assert.ok(!bridgeSource.includes(['new', 'Function'].join(' ')), '应用桥不得动态编译代码')
  assert.ok(!bridgeSource.includes('innerHTML'), '应用桥不得写入 HTML')
})

test('应用模式由壳对象或 client=android-app 触发，写入本机存储并清理查询参数', () => {
  assert.match(bridgeSource, /export const APP_CLIENT_MODE = 'android-app'/)
  assert.match(bridgeSource, /searchParams\.get\(CLIENT_QUERY_KEY\) === APP_CLIENT_MODE/)
  assert.match(bridgeSource, /searchParams\.delete\(CLIENT_QUERY_KEY\)/)
  assert.match(bridgeSource, /window\.history\.replaceState/)
  assert.match(bridgeSource, /localStorage\.setItem\(STORAGE_KEY, APP_CLIENT_MODE\)/)
  assert.match(bridgeSource, /localStorage\.getItem\(STORAGE_KEY\) === APP_CLIENT_MODE/)
  assert.match(bridgeSource, /export function initAppModeSignal\(\)/)
  assert.match(bridgeSource, /export function isAppClient\(\)/)
  // 存储不可用时不能抛错阻塞启动
  assert.match(bridgeSource, /catch \{[\s\S]{0,120}appClient = false/)
})

test('应用模式插件在组件挂载前初始化信号', () => {
  assert.match(pluginSource, /defineNuxtPlugin\(/)
  assert.match(pluginSource, /import \{ initAppModeSignal \} from '~\/composables\/useAppBridge'/)
  assert.match(pluginSource, /initAppModeSignal\(\)/)
  assert.doesNotMatch(pluginSource, /onMounted/)
})

test('PWA 插件在应用模式下提前返回且不注册 Service Worker', () => {
  assert.match(pwaPluginSource, /import \{ isAppClient \} from '~\/composables\/useAppBridge'/)
  assert.match(pwaPluginSource, /const hasAppShell = isAppClient\(\)/)
  assert.match(pwaPluginSource, /if \(hasDesktopShell \|\| hasAppShell\) return/)
  assert.match(pwaPluginSource, /&& !hasAppShell/)
  assert.ok(
    pwaPluginSource.indexOf('if (hasDesktopShell || hasAppShell) return')
      < pwaPluginSource.indexOf(".register('/sw.js'"),
    '应用模式必须早于 SW 注册返回',
  )
})

test('应用标题栏隐藏 PWA 安装入口', () => {
  assert.match(appHeaderSource, /import \{ isAppClient \} from '~\/composables\/useAppBridge'/)
  assert.match(appHeaderSource, /!isAppClient\(\) && !isStandalone\.value && \(canInstall\.value \|\| isIos\.value\)/)
})
