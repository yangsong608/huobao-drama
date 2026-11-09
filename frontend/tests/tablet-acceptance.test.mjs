/**
 * P10 平板端验收（Part B）
 *
 * 两类证据，缺一不可：
 *   1) 结构断言：轮询封装接线、预算与部署文档章节、首屏预取清单、遗留清理、依赖集合；
 *   2) 行为断言：Node 直接 import createVisibilityPolling，用假 host 真实驱动
 *      「隐藏停表 / 恢复补一次 / in-flight 不重入 / stop 静默 / immediate」五条契约。
 *
 * 注意：本文件读取的 `frontend/.output/public/index.html` 是 P0 构建产物（改造前），
 * 只用于核对首屏预取结构；改造后的包体与首屏指标在文档与证据中标记「待构建复测」。
 * 结构测试不替代业务验收：真机、部署运行时与真实生成的结论必须以证据文件为准。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const APP_ROOT = new URL('../app/', import.meta.url)
const DOC_URL = new URL('../../docs/平板端部署与访问说明.md', import.meta.url)
const INDEX_HTML_URL = new URL('../.output/public/index.html', import.meta.url)

const COARSE_QUERY = '@media (hover: none) and (pointer: coarse)'

// P10 预算（gzip）。常量在此定义，文档断言由它派生，避免两处数字漂移。
const ENTRY_GZIP_BUDGET_KB = 330
const ROUTE_GZIP_BUDGET_KB = 420
const TOTAL_RATIO_BUDGET = 1.05

// P0 基线（tmp/2026-11-09平板端适配自测留证/基线.md）
const ENTRY_BASELINE_GZIP_KB = 310
const ROUTE_BASELINE_GZIP_KB = 380
const TOTAL_BASELINE_LABEL = '3.8MB'

// 迁移后的 5 个文件与其轮询实例（共 9 处调用）
const MIGRATED_FILES = [
  {
    path: 'views/drama/episode.vue',
    polls: ['breakdownPoll', 'genTasksPoll', 'transitionPoll', 'mergePoll', 'videoBatchPoll'],
  },
  { path: 'components/QueuePanel.vue', polls: ['queuePoll'] },
  { path: 'components/GridSheetDialog.vue', polls: ['gridPoll'] },
  { path: 'components/edit/EditExportDialog.vue', polls: ['exportPoll'] },
  { path: 'pages/settings.vue', polls: ['usagePoll'] },
]

// docs/平板端部署与访问说明.md 第十三节的 13 个视口
const TEST_MATRIX = [
  ['1366×1024', 'iPad Pro 12.9 横屏'],
  ['1194×834', 'iPad Pro 11 横屏'],
  ['1180×820', '平板窗口上限'],
  ['1024×768', 'iPad 10.9 横屏'],
  ['1024×600', '安卓平板短横屏'],
  ['901×1000', '平板窗口下限'],
  ['1024×1366', 'iPad 10.9 竖屏'],
  ['834×1194', 'iPad Air 11 竖屏'],
  ['820×1180', 'iPad 10.9 竖屏'],
  ['768×1024', 'iPad mini 竖屏'],
  ['744×1133', 'iPad mini 6 竖屏'],
  ['743×1000', '手机边界'],
  ['1440×900', '桌面回归'],
]

// b8b6f49:frontend/package.json 的已知依赖集合。P10 不得新增依赖。
const EXPECTED_DEPENDENCIES = {
  '@pinia/nuxt': '^1.0.3',
  '@vicons/ionicons5': '^0.13.0',
  'driver.js': '^1.8.0',
  echarts: '^6.1.0',
  'lucide-vue-next': '^0.511.0',
  'naive-ui': '^2.45.3',
  nuxt: '^3.17.5',
  pinia: '^4.1.0',
  vue: '^3.5.13',
  'vue-i18n': '^11.4.10',
  'vue-router': '^4.5.1',
  'vue-sonner': '^1.2.4',
}
const EXPECTED_DEV_DEPENDENCIES = {
  '@nuxtjs/tailwindcss': '^6.14.0',
  tailwindcss: '^3.4.19',
  typescript: '^5.8.3',
}

function readApp(relativePath) {
  try {
    return readFileSync(new URL(relativePath, APP_ROOT), 'utf8')
  } catch (error) {
    assert.fail(`无法读取 app/${relativePath}：${error.message}`)
  }
}

function readDoc() {
  try {
    return readFileSync(DOC_URL, 'utf8')
  } catch (error) {
    assert.fail(`无法读取 docs/平板端部署与访问说明.md：${error.message}`)
  }
}

/** 取一次调用的完整文本（含括号内全部内容），用于容忍 `onBeforeUnmount(stop)` 与 `onBeforeUnmount(() => …)` */
function callText(source, callee) {
  const at = source.indexOf(`${callee}(`)
  assert.notEqual(at, -1, `缺少调用 ${callee}(`)
  let depth = 0
  for (let i = at + callee.length; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(at, i + 1)
    }
  }
  assert.fail(`调用 ${callee}( 括号未闭合`)
}

/**
 * 裸定时器计数：先剔除 `setTimeout(`，再数 `setInterval(`。
 * episode.vue 仍保留 tour / 重试退避 / sleep 等 setTimeout，不能算进轮询残留。
 */
function countSetIntervalCalls(source) {
  const withoutTimeouts = source.replace(/setTimeout\s*\(/g, '')
  return (withoutTimeouts.match(/setInterval\s*\(/g) ?? []).length
}

function countOccurrences(source, literal) {
  return source.split(literal).length - 1
}

/** 可注入假 host：显式控制 hidden 状态、可见性监听与定时器，不依赖真实 DOM。 */
function createFakeHost(initialHidden = false) {
  let hidden = initialHidden
  const listeners = new Set()
  const timers = new Map()
  let nextTimerId = 1
  const host = {
    isHidden: () => hidden,
    addVisibilityListener: (callback) => { listeners.add(callback) },
    removeVisibilityListener: (callback) => { listeners.delete(callback) },
    setInterval: (callback, ms) => {
      const id = nextTimerId
      nextTimerId += 1
      timers.set(id, { id, callback, ms })
      return id
    },
    clearInterval: (id) => { timers.delete(id) },
  }
  return {
    host,
    listenerCount: () => listeners.size,
    timerCount: () => timers.size,
    timers: () => [...timers.values()],
    firstTimer() {
      const [timer] = timers.values()
      assert.ok(timer, '期望存在定时器')
      return timer
    },
    setHidden(value) { hidden = value },
    fireVisibilityChange() {
      for (const callback of [...listeners]) callback()
    },
    fireTimers() {
      for (const timer of [...timers.values()]) timer.callback()
    },
  }
}

const flushMicrotasks = () => new Promise((resolve) => { setImmediate(resolve) })

const { createVisibilityPolling } = await import('../app/composables/useVisibilityPolling.ts')

test('轮询封装：可见性工厂、卸载必停与 5 个迁移点均无裸 setInterval', () => {
  const polling = readApp('composables/useVisibilityPolling.ts')
  assert.match(polling, /export function createVisibilityPolling\(/, '缺少可注入 host 的纯工厂')
  assert.match(polling, /export function useVisibilityPolling\(/, '缺少 Vue 封装')
  for (const token of ['visibilitychange', 'inFlight', 'isRunning']) {
    assert.ok(polling.includes(token), `useVisibilityPolling.ts 缺少 ${token}`)
  }
  // 卸载必停：A1 写作 onBeforeUnmount(() => { polling.stop() })，与 onBeforeUnmount(stop) 语义等价，
  // 这里断言「卸载钩子的参数里调用了 stop」，两种写法都通过，不锁定单一字面量。
  const unmountCall = callText(polling, 'onBeforeUnmount')
  assert.match(unmountCall, /\.stop\(\)/, '卸载钩子必须调用 stop()')
  // document host 接线：hidden 判定与 window 定时器
  assert.match(polling, /document\.hidden/, 'document host 必须以 document.hidden 判定可见性')
  assert.match(polling, /window\.setInterval/, 'document host 的定时器必须走 window.setInterval')

  let totalPolls = 0
  for (const { path, polls } of MIGRATED_FILES) {
    const source = readApp(path)
    assert.ok(
      source.includes("import { useVisibilityPolling } from '~/composables/useVisibilityPolling'"),
      `${path} 未从 ~/composables/useVisibilityPolling 引入封装`,
    )
    const calls = countOccurrences(source, 'useVisibilityPolling(')
    assert.equal(calls, polls.length, `${path} 的 useVisibilityPolling( 调用数应为 ${polls.length}`)
    for (const name of polls) {
      assert.ok(source.includes(`const ${name} = useVisibilityPolling(`), `${path} 缺少 ${name} 迁移点`)
    }
    assert.equal(countSetIntervalCalls(source), 0, `${path} 仍有裸 setInterval（迁移后必须为 0）`)
    totalPolls += calls
  }
  assert.equal(totalPolls, 9, '迁移点总数应为 9 处（episode 5 + 队列/宫格/导出/设置各 1）')

  // 宫格迟到响应隔离：旧一轮响应不得写状态、停新轮询或对新 id 切图
  const gridSource = readApp('components/GridSheetDialog.vue')
  const gridCall = callText(gridSource, 'useVisibilityPolling')
  assert.match(gridCall, /const id = pollId/, '宫格轮询必须锁定本次请求对应的 sheet id')
  assert.match(
    gridCall,
    /if \(id !== pollId \|\| !gridPoll\.isRunning\(\)\) return/,
    '迟到响应必须先校验 id 与轮询状态',
  )
  assert.match(gridCall, /await split\(id\)/, '切图必须使用本次请求的 id，而不是可变的 pollId')

  // episode.vue 的 setTimeout 未迁移，剔除后计数才有意义
  const episode = readApp('views/drama/episode.vue')
  assert.ok(episode.includes('setTimeout('), 'episode.vue 应保留 tour / 退避 / sleep 等 setTimeout')
})

test('轮询行为（真实调用 createVisibilityPolling）：隐藏停表、恢复补一次、in-flight 不重入、stop 静默、immediate', async () => {
  // 1) 隐藏时 start：只挂监听，不建定时器，不执行任务；重复 start 幂等
  const hiddenRun = createFakeHost(true)
  let hiddenCalls = 0
  const hiddenPoll = createVisibilityPolling(hiddenRun.host, () => { hiddenCalls += 1 }, 3000)
  hiddenPoll.start()
  hiddenPoll.start()
  assert.equal(hiddenPoll.isRunning(), true)
  assert.equal(hiddenCalls, 0, '隐藏时 start 不得执行任务')
  assert.equal(hiddenRun.timerCount(), 0, '隐藏时 start 不得创建定时器')
  assert.equal(hiddenRun.listenerCount(), 1, 'start 幂等：重复 start 不得重复注册 visibilitychange')

  // 2) 恢复可见：立即执行一次并重建定时器；之后恢复原周期
  hiddenRun.setHidden(false)
  hiddenRun.fireVisibilityChange()
  assert.equal(hiddenCalls, 1, '恢复可见必须立即补一次')
  assert.equal(hiddenRun.timerCount(), 1, '恢复可见必须重建定时器')
  assert.equal(hiddenRun.firstTimer().ms, 3000, '定时器周期应保持调用方传入值')
  hiddenRun.fireTimers()
  assert.equal(hiddenCalls, 2)

  // 3) 再次隐藏：只清定时器、保留监听；再次恢复：立即补一次
  hiddenRun.setHidden(true)
  hiddenRun.fireVisibilityChange()
  assert.equal(hiddenRun.timerCount(), 0, '隐藏必须清除定时器')
  assert.equal(hiddenRun.listenerCount(), 1, '隐藏时监听必须保留以便恢复')
  assert.equal(hiddenPoll.isRunning(), true, '隐藏不算 stop')
  hiddenRun.setHidden(false)
  hiddenRun.fireVisibilityChange()
  assert.equal(hiddenCalls, 3, '第二次恢复仍需立即补一次')
  assert.equal(hiddenRun.timerCount(), 1)
  hiddenPoll.stop()
  assert.equal(hiddenRun.listenerCount(), 0)

  // 4) 同实例不并发：上一次任务未完成时，定时 tick 与可见性恢复都不得重入
  const pendingRun = createFakeHost(false)
  let pendingCalls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const pendingPoll = createVisibilityPolling(pendingRun.host, () => {
    pendingCalls += 1
    return gate
  }, 4000)
  pendingPoll.start()
  pendingRun.fireTimers()
  assert.equal(pendingCalls, 1)
  pendingRun.fireTimers()
  assert.equal(pendingCalls, 1, '上一轮未完成时定时 tick 不得重入')
  pendingRun.fireVisibilityChange()
  assert.equal(pendingCalls, 1, 'in-flight 期间恢复可见也不得并发')
  release()
  await flushMicrotasks()
  pendingRun.fireTimers()
  assert.equal(pendingCalls, 2, '上一轮完成后下一 tick 应恢复正常')
  release()
  await flushMicrotasks()
  pendingPoll.stop()

  // 5) stop() 后：running=false、清表、移除监听；残留 tick 与监听不再执行；stop 幂等
  const stopRun = createFakeHost(false)
  let stopCalls = 0
  const stopPoll = createVisibilityPolling(stopRun.host, () => { stopCalls += 1 }, 1000)
  stopPoll.start()
  stopRun.fireTimers()
  assert.equal(stopCalls, 1)
  const leftoverTimer = stopRun.firstTimer()
  stopPoll.stop()
  assert.equal(stopPoll.isRunning(), false)
  assert.equal(stopRun.timerCount(), 0, 'stop 必须清除定时器')
  assert.equal(stopRun.listenerCount(), 0, 'stop 必须移除 visibilitychange')
  leftoverTimer.callback()
  assert.equal(stopCalls, 1, 'stop 之后残留 tick 不得执行')
  stopRun.fireVisibilityChange()
  assert.equal(stopCalls, 1, 'stop 之后可见性监听不得执行')
  stopPoll.stop()
  assert.equal(stopRun.timerCount(), 0)
  assert.equal(stopRun.listenerCount(), 0)

  // 6) immediate: true 且页面可见：start 立即执行一次
  const immediateRun = createFakeHost(false)
  let immediateCalls = 0
  const immediatePoll = createVisibilityPolling(
    immediateRun.host,
    () => { immediateCalls += 1 },
    2000,
    { immediate: true },
  )
  immediatePoll.start()
  assert.equal(immediateCalls, 1, 'immediate 必须立即执行一次')
  assert.equal(immediateRun.timerCount(), 1, 'immediate 后仍需按周期轮询')
  immediatePoll.stop()

  // 7) stop→start 后旧任务迟到：不得阻塞新一轮，也不得清掉新一轮的 in-flight
  const staleRun = createFakeHost(false)
  const staleGates = []
  let staleCalls = 0
  const stalePoll = createVisibilityPolling(staleRun.host, () => {
    staleCalls += 1
    return new Promise((resolve) => { staleGates.push(resolve) })
  }, 5000)
  stalePoll.start()
  staleRun.fireTimers()
  assert.equal(staleCalls, 1)
  stalePoll.stop()
  stalePoll.start()
  staleRun.fireTimers()
  assert.equal(staleCalls, 2, '重启后的第一轮不得被上一轮在途请求阻塞')
  staleGates[0]()
  await flushMicrotasks()
  staleRun.fireTimers()
  assert.equal(staleCalls, 2, '旧一轮迟到的释放不得清除新一轮的 in-flight 标记')
  staleGates[1]()
  await flushMicrotasks()
  staleRun.fireTimers()
  assert.equal(staleCalls, 3, '新一轮完成后应恢复正常轮询')
  stalePoll.stop()

  // 8) 任务同步自停：不得留下空转定时器或监听
  const selfRun = createFakeHost(false)
  const selfPoll = createVisibilityPolling(selfRun.host, () => { selfPoll.stop() }, 1000, { immediate: true })
  selfPoll.start()
  assert.equal(selfPoll.isRunning(), false)
  assert.equal(selfRun.timerCount(), 0, '同步自停后不得残留空转 interval')
  assert.equal(selfRun.listenerCount(), 0, '同步自停后必须移除 visibilitychange')
})

test('预算常量与部署文档：330KB / 420KB / 105% 对照 P0 基线 310KB / 380KB / 3.8MB', () => {
  assert.equal(ENTRY_GZIP_BUDGET_KB, 330)
  assert.equal(ROUTE_GZIP_BUDGET_KB, 420)
  assert.equal(TOTAL_RATIO_BUDGET, 1.05)
  assert.equal(Math.round(TOTAL_RATIO_BUDGET * 100), 105)

  const doc = readDoc()
  assert.ok(
    doc.includes(`${ENTRY_GZIP_BUDGET_KB}KB`),
    `部署文档缺少入口脚本预算 ${ENTRY_GZIP_BUDGET_KB}KB`,
  )
  assert.ok(
    doc.includes(`${ROUTE_GZIP_BUDGET_KB}KB`),
    `部署文档缺少最大路由块预算 ${ROUTE_GZIP_BUDGET_KB}KB`,
  )
  assert.ok(
    doc.includes(`${Math.round(TOTAL_RATIO_BUDGET * 100)}%`),
    '部署文档缺少总量预算 105%',
  )
  assert.ok(doc.includes(`${ENTRY_BASELINE_GZIP_KB}KB`), '部署文档缺少 P0 入口基线 310KB')
  assert.ok(doc.includes(`${ROUTE_BASELINE_GZIP_KB}KB`), '部署文档缺少 P0 最大文件基线 380KB')
  assert.ok(doc.includes(TOTAL_BASELINE_LABEL), '部署文档缺少 P0 总量基线 3.8MB')

  // 预算必须严于「不劣化」：入口与路由块预算高于基线，总量按 105% 封顶
  assert.ok(ENTRY_GZIP_BUDGET_KB > ENTRY_BASELINE_GZIP_KB)
  assert.ok(ROUTE_GZIP_BUDGET_KB > ROUTE_BASELINE_GZIP_KB)
  assert.ok(TOTAL_RATIO_BUDGET >= 1)
  // 构建未获批准：改造后指标不得用 P0 数字冒充，文档必须写明待复测
  assert.ok(doc.includes('待构建复测'), '部署文档必须标明改造后包体/首屏指标待构建复测')
})

test('验收章节与测试矩阵：四节齐全，13 个视口与 iPad Safari / 安卓 Chrome 在列', () => {
  const doc = readDoc()
  for (const heading of [
    '## 十、部署前置验收',
    '## 十一、生成前置验收',
    '## 十三、平板端测试矩阵',
    '## 十四、真机验收与已知限制',
  ]) {
    assert.ok(doc.includes(heading), `部署文档缺少章节「${heading}」`)
  }

  assert.equal(TEST_MATRIX.length, 13, '测试矩阵必须为 13 个视口')
  for (const [viewport, usage] of TEST_MATRIX) {
    assert.ok(doc.includes(viewport), `测试矩阵缺少视口 ${viewport}（${usage}）`)
  }
  // 矩阵必须落在第十三节内，避免别处偶然出现同名字符串被误判
  const start = doc.indexOf('## 十三、平板端测试矩阵')
  const end = doc.indexOf('## 十四、真机验收与已知限制')
  assert.ok(start !== -1 && end > start, '第十三节结构异常')
  const matrix = doc.slice(start, end)
  for (const [viewport] of TEST_MATRIX) {
    assert.ok(matrix.includes(viewport), `第十三节矩阵缺少视口 ${viewport}`)
  }
  assert.ok(matrix.includes('iPad Safari'), '测试矩阵缺少 iPad Safari')
  assert.ok(matrix.includes('安卓 Chrome'), '测试矩阵缺少安卓 Chrome')
})

test('部署前置验收：MIME、根路径、缓存、Range/206、SSE、访问控制与 5679 检查项齐全', () => {
  const doc = readDoc()
  const start = doc.indexOf('## 十、部署前置验收')
  const end = doc.indexOf('## 十一、生成前置验收')
  assert.ok(start !== -1 && end > start, '缺少第十节「部署前置验收」')
  const section = doc.slice(start, end)

  const required = [
    ['application/manifest+json', '清单 MIME'],
    ['站点根路径', '根路径部署'],
    ['sw.js', 'sw.js 缓存头'],
    ['no-cache', 'sw.js no-cache'],
    ['index.html', 'index.html 缓存头'],
    ['不得长缓存', 'index.html 不得长缓存'],
    ['/_nuxt/', '_nuxt 哈希资源'],
    ['immutable', '_nuxt immutable'],
    ['Range', 'Range 透传'],
    ['206 Partial Content', '206 分段响应'],
    ['SSE', 'SSE 流式'],
    ['不缓冲', 'SSE 不缓冲'],
    ['访问控制', '访问控制'],
    ['5679 不暴露公网', '5679 不暴露公网'],
  ]
  for (const [keyword, label] of required) {
    assert.ok(section.includes(keyword), `部署前置验收缺少 ${label}（${keyword}）`)
  }
})

test('生成前置验收：PUBLIC_BASE_URL 三态、/static 上游、访问控制不得关闭、真实生成失败即阻塞', () => {
  const doc = readDoc()
  const start = doc.indexOf('## 十一、生成前置验收')
  const end = doc.indexOf('## 十二、性能预算与首屏预取审计')
  assert.ok(start !== -1 && end > start, '缺少第十一节「生成前置验收」')
  const section = doc.slice(start, end)

  assert.ok(section.includes('PUBLIC_BASE_URL'), '生成前置验收缺少 PUBLIC_BASE_URL')
  for (const state of ['未配置', '同源反代', '外部地址']) {
    assert.ok(section.includes(state), `生成前置验收缺少 PUBLIC_BASE_URL 三态之一：${state}`)
  }
  assert.match(section, /\/static`? 上游可达/, '/static 上游可达性检查缺失')
  assert.ok(section.includes('访问控制不得关闭'), '必须写明访问控制不得关闭')
  assert.ok(section.includes('真实生成'), '必须包含真实生成验收')
  assert.ok(section.includes('失败即「阻塞」'), '真实生成失败必须标阻塞')
  assert.match(section, /阻塞（无运行实例\/模型会话）/, '缺少无运行实例/模型会话的阻塞口径')
})

test('首屏预取审计：index.html 仅 1 条 modulepreload 指向入口，prefetch 脚本不含 episode/edit/mix', () => {
  const doc = readDoc()
  assert.ok(doc.includes('首屏预取审计'), '部署文档缺少「首屏预取审计」')
  assert.ok(doc.includes('待构建复测'), '构建未获批准时必须在文档中写明待构建复测')

  if (!existsSync(INDEX_HTML_URL)) {
    // 构建产物缺失时不得静默跳过：文档必须记录「待构建复测」与 P0 口径
    assert.ok(doc.includes('待构建复测'), '缺少 index.html 且文档未记录待构建复测')
    return
  }

  const html = readFileSync(INDEX_HTML_URL, 'utf8')
  // 该产物为 2026-11-09 04:26 的 P0 构建（改造前），只用于预取结构审计
  assert.ok(doc.includes('P0 构建产物'), '文档必须注明现有 index.html 是 P0 构建产物')

  const attrOf = (tag, name) => {
    const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
    return match ? match[1] : null
  }
  const linkTags = html.match(/<link\b[^>]*>/g) ?? []
  const modulepreloads = linkTags.filter((tag) => attrOf(tag, 'rel') === 'modulepreload')
  assert.equal(modulepreloads.length, 1, `index.html 的 modulepreload 必须恰好 1 条，实际 ${modulepreloads.length}`)

  const entryMatch = html.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/)
  assert.ok(entryMatch, 'index.html 缺少入口 module script')
  const entrySrc = entryMatch[1]
  assert.equal(attrOf(modulepreloads[0], 'href'), entrySrc, 'modulepreload 必须指向入口脚本')
  assert.match(entrySrc, /^\/_nuxt\/[\w.-]+\.js$/, `入口脚本路径异常：${entrySrc}`)

  const scriptPrefetches = linkTags.filter(
    (tag) => attrOf(tag, 'rel') === 'prefetch' && attrOf(tag, 'as') === 'script',
  )
  assert.ok(scriptPrefetches.length > 0, 'prefetch script 清单为空，审计断言会落空')
  for (const tag of scriptPrefetches) {
    const href = attrOf(tag, 'href')
    assert.ok(href, `prefetch script 缺少 href：${tag}`)
    assert.doesNotMatch(href, /episode|edit|mix/i, `首屏不得预取重路由块：${href}`)
  }
})

test('遗留清理：抽屉 128px、粗指针 44px 兜底、栈感知 Escape、焦点 preventScroll、弹窗拦截与媒体控件选择器', () => {
  const dubbing = readApp('components/DubbingStage.vue')
  assert.ok(dubbing.includes('128px'), 'DubbingStage 底部抽屉必须为 128px')
  assert.doesNotMatch(dubbing, /108px/, 'DubbingStage 不得残留 108px')
  assert.ok(
    countOccurrences(dubbing, '128px') >= 2,
    'DubbingStage 的 128px 应同时覆盖 bottom 与 max-height 两处',
  )

  const css = readApp('assets/studio.css')
  const lastCoarse = css.lastIndexOf(COARSE_QUERY)
  assert.notEqual(lastCoarse, -1, 'studio.css 缺少粗指针媒体查询')
  const tail = css.slice(lastCoarse)
  assert.ok(tail.includes('button, .btn, .btn-sm, .btn-icon'), 'studio.css 末尾粗指针块缺少按钮命中区选择器')
  assert.ok(tail.includes('min-height: var(--tap-min)'), 'studio.css 末尾粗指针块缺少 44px 命中区')
  assert.ok(tail.includes('.btn-icon { min-width: var(--tap-min); }'), '图标按钮粗指针下必须补足 44px 宽度')
  const exportDialog = readApp('components/edit/EditExportDialog.vue')
  assert.ok(
    exportDialog.includes('.ed-close { min-width: var(--tap-min); min-height: var(--tap-min); }'),
    '导出弹窗关闭按钮粗指针下必须补足 44×44 命中区',
  )
  const settingsPage = readApp('pages/settings.vue')
  const settingsCoarse = settingsPage.slice(settingsPage.lastIndexOf(COARSE_QUERY))
  assert.ok(
    settingsCoarse.includes('.btn-icon.btn-sm { min-width: var(--tap-min); min-height: var(--tap-min); }'),
    '设置页复合选择器图标按钮在粗指针下必须补足 44×44 命中区',
  )

  const confirm = readApp('components/ConfirmDialog.vue')
  assert.ok(confirm.includes('isTopOverlay'), 'ConfirmDialog 缺少栈感知判定')
  assert.match(confirm, /function cancel\(\)/, 'ConfirmDialog 应把 cancel 提为具名函数')
  assert.match(confirm, /!isTopOverlay\(cancel\)/, 'ConfirmDialog 的键盘处理必须受栈顶判定门控')

  const overlay = readApp('composables/useOverlayHistory.ts')
  assert.ok(overlay.includes('preventScroll: true'), '焦点归还必须使用 preventScroll: true')
  assert.match(overlay, /export function isTopOverlay\(/, 'useOverlayHistory 缺少 isTopOverlay 导出')

  const share = readApp('utils/export-share.ts')
  assert.ok(share.includes('if (!win) throw'), 'window.open 被拦截必须判失败')
  assert.ok(share.includes('popup blocked'), '缺少 popup blocked 失败原因')
  assert.match(share, /window\.open\('about:blank', '_blank'\)/, '必须先取窗口引用才能判拦截')
  assert.match(share, /win\.opener = null/, '打开新窗口后必须断开 opener')
  assert.match(share, /win\.location\.href = url/, '取得窗口后再导航到目标地址')
  assert.doesNotMatch(share, /noopener,noreferrer/, '带 noopener/noreferrer 的 window.open 恒返回 null，不能用于判拦截')

  const episode = readApp('views/drama/episode.vue')
  assert.ok(episode.includes('audio[controls]'), 'episode.vue 焦点陷阱/抽屉选择器缺少 audio[controls]')
  assert.ok(episode.includes('video[controls]'), 'episode.vue 焦点陷阱/抽屉选择器缺少 video[controls]')
})

test('无新增依赖/后端改动：前端依赖集合与 b8b6f49 一致，轮询封装只依赖 vue 且不进入后端', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(pkg.dependencies, EXPECTED_DEPENDENCIES, 'P10 不得新增运行时依赖')
  assert.deepEqual(pkg.devDependencies, EXPECTED_DEV_DEPENDENCIES, 'P10 不得新增开发依赖')

  const polling = readApp('composables/useVisibilityPolling.ts')
  const externalImports = [...polling.matchAll(/^import\s[^\n]*?from\s+'([^']+)'/gm)].map((match) => match[1])
  assert.deepEqual(externalImports, ['vue'], '轮询封装只能依赖既有 vue，不得引入新包')

  // 5 个迁移点必须引用本地 composable，而不是任何新包
  for (const { path } of MIGRATED_FILES) {
    const source = readApp(path)
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)]
      .map((match) => match[1])
      .filter((specifier) => specifier.includes('useVisibilityPolling'))
    assert.deepEqual(specifiers, ['~/composables/useVisibilityPolling'], `${path} 的轮询来源必须唯一`)
  }

  // 后端源码不得引入前端轮询封装（P10 不允许改后端）
  const backendSrc = new URL('../../backend/src/', import.meta.url)
  assert.ok(existsSync(backendSrc), '缺少 backend/src，无法核对后端未被改动')
  const backendRoot = fileURLToPath(backendSrc)
  const backendSources = readdirSync(backendRoot, { recursive: true })
    .filter((entry) => /\.(?:ts|mjs|js)$/.test(entry))
  const polluted = backendSources.filter((entry) =>
    readFileSync(join(backendRoot, entry), 'utf8').includes('useVisibilityPolling'))
  assert.deepEqual(polluted, [], 'P10 轮询封装不得出现在后端源码中')
})
