/**
 * 小说工作台结构：布局预检、tabs 回退、三栏断点与顶栏切换
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}

test('布局先读设置，tabs 模式直接返回且不请求工作台聚合接口', () => {
  const source = read('app/composables/useNovelWorkbench.ts')
  assert.match(source, /novelAPI\.settings\(\)/)
  assert.match(source, /payload\?\.settings\?\.workbench\?\.layout/)
  assert.match(source, /const layoutReady = computed\(\(\) => configuredLayout\.value !== null\)/)
  assert.match(source, /if \(target === 'tabs'\)[\s\S]*?return[\s\S]*?novelAPI\.workbench\(novelId\)/)
})

test('写作页签按布局就绪状态渲染，tabs 不挂载三栏壳', () => {
  const source = read('app/views/novel/detail.vue')
  assert.match(source, /v-if="!workbenchLayoutReady"/)
  assert.match(source, /NovelWorkbenchShell v-else-if="workbenchLayout === 'split'"/)
  assert.match(source, /NovelChapterWriterPanel\s+v-else-if="workbenchLayout === 'tabs'"/)
})

test('顶栏布局切换持久化并立即生效', () => {
  const source = read('app/views/novel/detail.vue')
  assert.match(source, /class="layout-switch"/)
  assert.match(source, /switchWorkbenchLayout\('split'\)/)
  assert.match(source, /switchWorkbenchLayout\('tabs'\)/)
  assert.match(source, /novelAPI\.saveSettings\(\{ workbench: \{ layout: next \} \}\)/)
  assert.match(source, /setWorkbenchLayout\(next\)/)
  assert.match(source, /if \(next === 'split'\) await loadWorkbench\(\)/)
})

test('三栏宽度与断点符合计划：240 可拖 200–320、右栏 320 可收 40、960/720', () => {
  const source = read('app/components/novel/workspace/NovelWorkbenchShell.vue')
  assert.match(source, /const railWidth = ref\(240\)/)
  assert.match(source, /Math\.max\(200, Math\.min\(320,/)
  assert.match(source, /var\(--inspector-w, 320px\)/)
  assert.match(source, /minmax\(0, 1fr\) 40px/)
  assert.match(source, /@media \(max-width: 960px\)/)
  assert.match(source, /@media \(max-width: 720px\)/)
  assert.match(source, /grid-template-columns: minmax\(0, 1fr\)/)
  assert.match(source, /transform: translateX\(100%\)/)
})
