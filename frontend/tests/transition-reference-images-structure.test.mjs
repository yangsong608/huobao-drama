/**
 * 过渡镜头参考图（槽位替换 + 追加列表）前端结构测试。
 * 后端契约：PUT /merge/transitions/:id/reference-images（#36）；
 * 前端：useApi 方法、详情弹窗槽位上传/恢复与追加列表、能力提示、四语文案。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const episode = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const locales = ['zh', 'en', 'ja', 'ko'].map(lang => [
  lang,
  JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')),
])

test('API 暴露参考图保存接口（槽位上传 + 追加列表）', () => {
  assert.match(api, /saveReferenceImages: \(id: number, payload: Record<string, any>\) => api\.put<any>\(`\/merge\/transitions\/\$\{id\}\/reference-images`/)
})

test('详情弹窗生效帧上传优先，支持槽位上传与恢复默认', () => {
  assert.match(episode, /function transitionUploadedFrameUrl\(boundary, slot\)/)
  assert.match(episode, /function transitionDetailEffectiveFrameUrl\(boundary, slot\)/)
  assert.match(episode, /transitionDetailEffectiveFrameUrl\(transitionDetailBoundary, 'first'\)/)
  assert.match(episode, /transitionDetailEffectiveFrameUrl\(transitionDetailBoundary, 'last'\)/)
  assert.match(episode, /function uploadTransitionSlotImage\(boundary, slot\)/)
  assert.match(episode, /uploadTransitionSlotImage\(transitionDetailBoundary, 'first'\)/)
  assert.match(episode, /uploadTransitionSlotImage\(transitionDetailBoundary, 'last'\)/)
  assert.match(episode, /function resetTransitionSlot\(boundary, slot\)/)
  assert.match(episode, /resetTransitionSlot\(transitionDetailBoundary, 'first'\)/)
  assert.match(episode, /resetTransitionSlot\(transitionDetailBoundary, 'last'\)/)
  assert.match(episode, /class="transition-detail-slots"/)
  assert.match(episode, /uploadAPI\.image\(file, dramaId\)/)
})

test('追加参考图列表可添加与移除，受模型上限约束', () => {
  assert.match(episode, /function transitionReferenceUrls\(boundary\)/)
  assert.match(episode, /function transitionReferenceLimit\(\)/)
  assert.match(episode, /function addTransitionReferences\(boundary\)/)
  assert.match(episode, /addTransitionReferences\(transitionDetailBoundary\)/)
  assert.match(episode, /async function removeTransitionReference\(boundary, index\)/)
  assert.match(episode, /removeTransitionReference\(transitionDetailBoundary, i\)/)
  assert.match(episode, /class="transition-ref-list"/)
  assert.match(episode, /toast\.info\(t\('episode\.export\.aiTransition\.refsLimit'/)
  assert.match(episode, /reference_image_urls: \[\.\.\.existing, \.\.\.uploaded\]/)
  assert.match(episode, /transitionAPI\.saveReferenceImages\(boundary\.id, payload\)/)
})

test('模型不支持首尾帧与参考图混用时给出降级提示', () => {
  assert.match(episode, /function transitionReferenceAllowed\(\)/)
  assert.match(episode, /reference_images_allowed === true/)
  assert.match(episode, /v-if="!transitionReferenceAllowed\(\) && transitionReferenceUrls\(transitionDetailBoundary\)\.length"/)
  assert.match(episode, /aiTransition\.refsNotAllowed/)
})

test('断点兜底对象包含参考图三字段，缺失断点不再丢字段', () => {
  assert.match(episode, /first_frame_upload_url: null,\s*\n\s*last_frame_upload_url: null,\s*\n\s*reference_image_urls: \[\]/)
})

test('拼接弹窗断点行显示参考图计数', () => {
  assert.match(episode, /function transitionRefCountLabel\(b\)/)
  assert.match(episode, /v-if="transitionRefCountLabel\(b\)"/)
  assert.match(episode, /class="ai-transition-refs-badge"/)
})

test('过渡卡片缩略图与详情优先用上传槽位图', () => {
  assert.match(episode, /v-if="b\.first_frame_upload_url \|\| b\.first_frame_url"/)
  assert.match(episode, /:src="'\/' \+ \(b\.first_frame_upload_url \|\| b\.first_frame_url\)"/)
})

test('四语言都包含槽位与参考图文案', () => {
  for (const [lang, bundle] of locales) {
    const copy = bundle?.episode?.export?.aiTransition
    assert.ok(copy, `${lang} 缺少 aiTransition`)
    for (const key of [
      'slotUpload', 'slotUploading', 'slotRestore', 'slotUpdated', 'slotRestored', 'slotUploadedTag',
      'refsTitle', 'refsHint', 'refsAdd', 'refsAdding', 'refsEmpty',
      'refsLimit', 'refsNotAllowed', 'refsDone', 'refsRemoved', 'refsBadge',
    ]) {
      assert.equal(typeof copy?.[key], 'string', `${lang} 缺少 aiTransition.${key}`)
    }
    assert.match(copy.refsHint, /\{n\}/, `${lang} refsHint 缺少 {n}`)
    assert.match(copy.refsLimit, /\{n\}/, `${lang} refsLimit 缺少 {n}`)
    assert.match(copy.refsBadge, /\{n\}/, `${lang} refsBadge 缺少 {n}`)
  }
})
