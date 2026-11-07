import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

const stemLibrary = fs.readFileSync(path.join(root, 'app/components/MixStemLibrary.vue'), 'utf8')
const mixStage = fs.readFileSync(path.join(root, 'app/components/MixStage.vue'), 'utf8')
const useMixStage = fs.readFileSync(path.join(root, 'app/composables/useMixStage.ts'), 'utf8')
const useApi = fs.readFileSync(path.join(root, 'app/composables/useApi.ts'), 'utf8')

test('素材库提供导入音频入口并透传文件', () => {
  assert.match(stemLibrary, /import-audio/, '应声明 import-audio 事件')
  assert.match(stemLibrary, /type="file"/, '应有隐藏的文件选择输入')
  assert.match(stemLibrary, /accept="\.mp3,\.wav,\.m4a,\.aac"/, '应限定支持的音频格式')
  assert.match(stemLibrary, /mix\.stems\.importAudio/, '导入按钮应使用 mix.stems.importAudio 文案')
  assert.match(stemLibrary, /assetKindImport/, 'kind=import 的素材应有兜底名称')
})

test('MixStage 接入导入流程并提示结果', () => {
  assert.match(mixStage, /@import-audio="onImportAudio"/, 'MixStemLibrary 应绑定导入事件')
  assert.match(mixStage, /function onImportAudio/, '应有导入处理函数')
  assert.match(mixStage, /mix\.importDone/, '导入成功应有提示')
  assert.match(mixStage, /mix\.importFailed/, '导入失败应有提示')
  assert.match(useMixStage, /async function importAudioAsset/, 'useMixStage 应提供导入方法')
  assert.match(useMixStage, /importAudioAsset,/, 'useMixStage 应导出导入方法')
  assert.match(useApi, /audio\/assets\/import/, 'API 层应调用导入端点')
})

test('四语言文案包含导入相关词条', () => {
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const data = JSON.parse(fs.readFileSync(path.join(root, `app/locales/${locale}.json`), 'utf8'))
    assert.ok(data.mix.stems.importAudio, `${locale} 应有 mix.stems.importAudio`)
    assert.ok(data.mix.assetKindImport, `${locale} 应有 mix.assetKindImport`)
    assert.ok(data.mix.importDone, `${locale} 应有 mix.importDone`)
    assert.ok(data.mix.importFailed, `${locale} 应有 mix.importFailed`)
    assert.match(data.mix.stems.intro, /track|トラック|트랙|轨道/, `${locale} intro 应包含自动建轨说明`)
  }
})

test('生成素材按分类显示名称而不是原始键名', () => {
  assert.match(stemLibrary, /asset\.kind === 'soundscape'/, '必须单独处理生成素材的命名')
  assert.match(
    stemLibrary,
    /SOUNDSCAPE_CATEGORY_KEYS[^}]*ambience: 'SoundscapeAmbience'[\s\S]*?sfx: 'SoundscapeSfx'[\s\S]*?crowd: 'SoundscapeCrowd'[\s\S]*?bgm: 'SoundscapeBgm'/,
    '四个分类必须映射到各自的 assetKindSoundscape* 文案键',
  )
  assert.match(stemLibrary, /mix\.assetKindSoundscape\b/, '未知分类应有「生成素材」兜底名称')
})

test('生成素材行显示提示词摘要便于区分多条素材', () => {
  assert.match(stemLibrary, /:title="assetTitle\(asset\)"/, '名称应有悬停完整信息')
  assert.match(stemLibrary, /function assetTitle\(/, '应提供 assetTitle 函数')
})

test('素材列表分页显示', () => {
  assert.match(stemLibrary, /const PAGE_SIZE = \d+/, '应定义分页大小')
  assert.match(stemLibrary, /const pagedAssets = computed/, '应按页切片素材列表')
  assert.match(stemLibrary, /v-for="asset in pagedAssets"/, '列表必须渲染当前页而不是全部')
  assert.match(stemLibrary, /v-if="pageCount > 1"/, '只有超过一页才显示分页器')
  assert.match(stemLibrary, /mix\.stems\.prevPage/, '上一页按钮应有文案')
  assert.match(stemLibrary, /mix\.stems\.nextPage/, '下一页按钮应有文案')
  assert.match(stemLibrary, /mix\.stems\.pageInfo/, '页码信息应有文案')
})

test('四语言文案包含生成素材命名与分页词条', () => {
  for (const locale of ['zh', 'en', 'ja', 'ko']) {
    const data = JSON.parse(fs.readFileSync(path.join(root, `app/locales/${locale}.json`), 'utf8'))
    assert.ok(data.mix.assetKindSoundscape, `${locale} 应有 mix.assetKindSoundscape`)
    for (const key of ['SoundscapeAmbience', 'SoundscapeSfx', 'SoundscapeCrowd', 'SoundscapeBgm']) {
      assert.ok(data.mix[`assetKind${key}`], `${locale} 应有 mix.assetKind${key}`)
    }
    assert.ok(data.mix.stems.prevPage, `${locale} 应有 mix.stems.prevPage`)
    assert.ok(data.mix.stems.nextPage, `${locale} 应有 mix.stems.nextPage`)
    assert.ok(data.mix.stems.pageInfo, `${locale} 应有 mix.stems.pageInfo`)
  }
})
