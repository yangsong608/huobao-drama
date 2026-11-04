/**
 * P3-7 同步 UI 与反向入口：API、同步弹窗、导出列表、卡片更新点、短剧详情横幅、四语言
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

function read(path) {
  return fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

function leafKeys(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([key, item]) => leafKeys(item, prefix ? `${prefix}.${key}` : key))
}

test('novelAPI 提供同步预览与提交端点', () => {
  const api = read('app/composables/useNovelApi.ts')
  assert.match(api, /previewSync: \(id: number, importId: number\)/)
  assert.match(api, /\/novels\/\$\{id\}\/imports\/\$\{importId\}\/preview/)
  assert.match(api, /sync: \(id: number, importId: number, data: Record<string, unknown>\)/)
  assert.match(api, /\/novels\/\$\{id\}\/imports\/\$\{importId\}\/sync/)
})

test('SyncNovelDialog 分类展示、逐条勾选、冲突原因与覆盖/重建二次确认', () => {
  const dialog = read('app/components/novel/SyncNovelDialog.vue')
  assert.match(dialog, /novelAPI\.previewSync/)
  assert.match(dialog, /novelAPI\.sync/)
  assert.match(dialog, /preview\.counts/)
  assert.match(dialog, /selectedKeys/)
  assert.match(dialog, /kind === 'new'/)
  assert.match(dialog, /kind === 'updated'/)
  assert.match(dialog, /kind === 'conflict'/)
  assert.match(dialog, /kind === 'missing'/)
  assert.match(dialog, /item\.reasons/)
  assert.match(dialog, /actionOf\(item\)/)
  assert.match(dialog, /'recreate'/)
  assert.match(dialog, /'overwrite'/)
  assert.match(dialog, /window\.confirm/)
  assert.match(dialog, /emit\('synced'/)
  assert.match(dialog, /novels\.sync\.confirmOverwrite/)
  assert.match(dialog, /novels\.sync\.reason\./)
})

test('导出 tab 展示已导入短剧、上次同步、有更新、打开/同步/再导入', () => {
  const panel = read('app/components/novel/ExportPanel.vue')
  assert.match(panel, /novelAPI\.imports/)
  assert.match(panel, /SyncNovelDialog/)
  assert.match(panel, /imports\.value/)
  assert.match(panel, /syncTarget/)
  assert.match(panel, /item\.has_update/)
  assert.match(panel, /item\.last_synced_at/)
  assert.match(panel, /item\.drama_missing/)
  assert.match(panel, /novels\.export\.adaptedTitle/)
  assert.match(panel, /novels\.export\.openDrama/)
  assert.match(panel, /novels\.export\.reimport/)
  assert.match(panel, /navigateTo\(`\/drama\/\$\{item\.drama_id\}`\)/)
  assert.match(panel, /novels\.export\.updateAvailable/)
})

test('小说卡片显示已改编与原著更新红点', () => {
  const card = read('app/components/novel/ProjectCard.vue')
  assert.match(card, /project\.hasImport/)
  assert.match(card, /project\.hasUpdate/)
  assert.match(card, /update-dot/)
})

test('短剧详情显示改编来源与 source_stale 横幅，并可跳回原著', () => {
  const detail = read('app/views/drama/detail.vue')
  assert.match(detail, /drama\.source_novel/)
  assert.match(detail, /detail\.source\.adaptedFrom/)
  assert.match(detail, /navigateTo\(`\/novels\/\$\{drama\.source_novel\.id\}\?tab=export`\)/)
  assert.match(detail, /staleEpisodes/)
  assert.match(detail, /detail\.source\.staleTitle/)
  assert.match(detail, /detail\.source\.staleMessage/)
  assert.match(detail, /detail\.source\.sync/)
  assert.match(detail, /detail\.source\.openNovel/)
})

test('四语言同步与来源文案键对齐', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map((lang) => JSON.parse(read(`app/locales/${lang}.json`)))
  for (const locale of locales) {
    const novelKeys = leafKeys(locale.novels)
    for (const key of [
      'sync.title',
      'sync.subtitle',
      'sync.loading',
      'sync.updatedAt',
      'sync.neverSynced',
      'sync.counts',
      'sync.kind.new',
      'sync.kind.updated',
      'sync.kind.conflict',
      'sync.kind.missing',
      'sync.reason.has_script',
      'sync.reason.has_storyboards',
      'sync.reason.has_video',
      'sync.reason.has_subtitle',
      'sync.reason.has_dubbing',
      'sync.reason.content_edited',
      'sync.reason.automation_running',
      'sync.reason.dubbing_running',
      'sync.reason.episode_deleted',
      'sync.overwriteHint',
      'sync.confirmOverwrite',
      'sync.submit',
      'sync.submitting',
      'sync.success',
      'sync.failed',
      'sync.empty',
      'sync.selectAll',
      'sync.selectNone',
      'export.adaptedTitle',
      'export.reimport',
      'export.openDrama',
      'export.syncButton',
      'export.dramaMissing',
      'export.orphaned',
      'export.lastSynced',
      'export.episodeCount',
      'export.updateAvailable',
      'badges.update',
    ]) {
      assert.ok(novelKeys.includes(key), `missing novels.${key}`)
    }
    const detailKeys = leafKeys(locale.detail)
    for (const key of ['source.adaptedFrom', 'source.openNovel', 'source.staleTitle', 'source.staleMessage', 'source.sync']) {
      assert.ok(detailKeys.includes(key), `missing detail.${key}`)
    }
    assert.equal(typeof locale.novels.sync.reason.has_script, 'string')
  }
  const baseNovels = leafKeys(locales[0].novels).sort()
  const baseDetail = leafKeys(locales[0].detail).sort()
  for (const locale of locales.slice(1)) {
    assert.deepEqual(leafKeys(locale.novels).sort(), baseNovels)
    assert.deepEqual(leafKeys(locale.detail).sort(), baseDetail)
  }
})
