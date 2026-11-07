import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const REASONS = ['legacy_mix', 'timing_changed', 'dialogue_changed']

test('剪辑台混音胶囊：按钮化、只读原因与去混音入口', () => {
  const topbar = read('app/components/edit/EditTopBar.vue')
  assert.match(topbar, /<AppMenu v-model:open="mixOpen"/)
  assert.match(topbar, /class="ed-chip ed-mix-chip|'ed-chip', 'ed-mix-chip'/)
  assert.match(topbar, /props\.state\.mix_status\?\.reasons/)
  assert.match(topbar, /t\(`edit\.mixReason\.\$\{reason\}`\)/)
  assert.match(topbar, /mix\.editSync\.staleHint/)
  assert.match(topbar, /mix\.editSync\.missingHint/)
  assert.match(topbar, /@click="goMix"/)
  assert.match(topbar, /emit\('go-mix'\)/)
  // 胶囊只读：不得触发混音生成或对齐写操作
  assert.doesNotMatch(topbar, /mixAPI|editAPI\.|saveRevision|createMixRevision/)
})

test('剪辑台跳转：用路由与当前工程源成片构造混音深链', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  assert.match(workbench, /@go-mix="openMixWorkbench"/)
  assert.match(workbench, /function openMixWorkbench\(\)/)
  assert.match(workbench, /topState\.value\?\.project\?\.source_merge_id/)
  assert.ok(
    workbench.includes('path: `/drama/${route.params.id}/episode/${route.params.episodeNumber}`'),
    '跳转路径必须使用当前路由的 id 与 episodeNumber',
  )
  assert.match(workbench, /query = \{ panel: 'dubbing', step: '3' \}/)
  assert.match(workbench, /if \(filmId\) query\.film = String\(filmId\)/)
})

test('混音组合式函数：读取 edit_sync，保存/恢复后刷新镜像', () => {
  const stage = read('app/composables/useMixStage.ts')
  assert.match(stage, /const editSync = ref<MixEditSync \| null>\(null\)/)
  assert.match(stage, /if \(next\.edit_sync !== undefined\) editSync\.value = next\.edit_sync/)
  assert.match(stage, /async function refreshEditSync\(\)/)
  const save = stage.slice(stage.indexOf('async function saveRevision'))
  assert.match(save, /await refreshEditSync\(\)[\s\S]{0,80}return revision/)
  const restore = stage.slice(stage.indexOf('async function restoreRevision'))
  assert.match(restore.slice(0, restore.indexOf('async function renderMix')), /await refreshEditSync\(\)/)
  assert.match(stage, /^\s+editSync,$/m)
})

test('混音台镜像胶囊：同源原因可展开，回到剪辑台按 episodeNumber 显隐', () => {
  const mix = read('app/components/MixStage.vue')
  assert.match(mix, /v-if="editSync"/)
  assert.match(mix, /editSyncReasons/)
  assert.match(mix, /t\(`edit\.mixReason\.\$\{reason\}`\)/)
  assert.match(mix, /v-if="episodeNumber"[\s\S]{0,240}goEditWorkbench/)
  assert.match(mix, /function goEditWorkbench\(\)/)
  assert.ok(
    mix.includes('navigateTo(`/drama/${props.dramaId}/episode/${props.episodeNumber}/edit`)'),
    '回到剪辑台必须指向本集剪辑页',
  )
  assert.match(mix, /if \(!props\.episodeNumber\) return/)
  assert.match(mix, /mix\.editSync\.backToEdit/)
  assert.match(mix, /mix\.editSync\.noEditPlanHint/)
})

test('对齐文案：四语言共用原因与镜像键', () => {
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const data = JSON.parse(read(`app/locales/${locale}.json`))
    assert.equal(typeof data.edit.goMix, 'string', `${locale}: edit.goMix`)
    assert.ok(data.edit.goMix.length > 0, `${locale}: edit.goMix`)
    for (const reason of REASONS) {
      const value = data.edit.mixReason?.[reason]
      assert.equal(typeof value, 'string', `${locale}: edit.mixReason.${reason}`)
      assert.ok(value.length > 0, `${locale}: edit.mixReason.${reason}`)
    }
    for (const key of [
      'aligned', 'stale', 'missing', 'noEditPlan',
      'alignedHint', 'staleHint', 'missingHint', 'noEditPlanHint', 'backToEdit',
    ]) {
      const value = data.mix.editSync?.[key]
      assert.equal(typeof value, 'string', `${locale}: mix.editSync.${key}`)
      assert.ok(value.length > 0, `${locale}: mix.editSync.${key}`)
    }
  }
  const zh = JSON.parse(read('app/locales/zh.json'))
  assert.equal(zh.edit.mixReason.timing_changed, '画面时间变化')
  assert.equal(zh.mix.editSync.backToEdit, '回到剪辑台')
})
