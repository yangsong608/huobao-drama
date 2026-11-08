import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('左栏保留成片页签并挂回分镜素材库', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /EditSidebar/)
  assert.match(workbench, /EditMediaLibrary/)
  assert.match(workbench, /useEditMedia/)
  assert.match(workbench, /leftTab/)

  const sidebar = read('app/components/edit/EditSidebar.vue')
  assert.match(sidebar, /ContextMenu/)
  assert.match(sidebar, /emit\('open'/)
  assert.match(sidebar, /set-current/)
  assert.match(sidebar, /open-mix/)
  assert.match(sidebar, /rename/)
  assert.match(sidebar, /remove/)
  assert.match(sidebar, /disabled/)
})

test('切换成片：先自动保存，失败阻止，成功经 ?film= 重新加载', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /function switchFilm/)
  assert.match(workbench, /saveNow/)
  assert.match(workbench, /emit\('open-film'/)

  const page = read('app/views/drama/edit.vue')
  assert.match(page, /route\.query\.film/)
  assert.match(page, /openProject/)
  assert.match(page, /:key=/)
})

test('editAPI 工程参数与四语言文案', () => {
  const api = read('app/composables/useApi.ts')
  assert.match(api, /edit\/projects/)
  assert.match(api, /project_id/)

  const top = read('app/components/edit/EditTopBar.vue')
  assert.match(top, /legacy/)

  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const data = read(`app/locales/${lang}.json`)
    assert.match(data, /legacyProject/)
    assert.match(data, /filmsPanelTitle/)
    assert.match(data, /deleteBlocked/)
  }
})
