import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('剪辑顶栏是 44px 平铺外壳', () => {
  const top = read('app/components/edit/EditTopBar.vue')
  const block = top.slice(top.indexOf('.ed-top {'), top.indexOf('.ed-top-left'))
  assert.match(block, /height:\s*var\(--topbar-h\)/)
  assert.match(block, /padding:\s*0 var\(--topbar-pad-x\)/)
  assert.match(block, /border-bottom:\s*1px solid var\(--border\)/)
  assert.match(block, /background:\s*var\(--panel-bg\)/)
  assert.doesNotMatch(block, /height:\s*52px/)
})

test('剪辑组件不再使用 9/10px 字号', () => {
  const dir = new URL('app/components/edit/', root)
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.vue'))) {
    const source = readFileSync(new URL(name, dir), 'utf8')
    assert.doesNotMatch(source, /font-size:\s*(?:9|10|10\.5)px/, name)
  }
  const page = read('app/views/drama/edit.vue')
  assert.doesNotMatch(page, /font-size:\s*(?:9|10|10\.5)px/)
})

test('剪辑工作台保持 236/300 固定栏宽', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /grid-template-columns:\s*236px minmax\(0, 1fr\) 300px/)
  assert.doesNotMatch(workbench, /grid-template-columns:\s*220px/)
  assert.doesNotMatch(workbench, /minmax\(0, 1fr\) 272px/)
})

test('剪辑空态复用 StudioEmptyState 结构', () => {
  const empty = read('app/components/edit/EditEmptyState.vue')
  assert.match(empty, /StudioEmptyState/)
})
