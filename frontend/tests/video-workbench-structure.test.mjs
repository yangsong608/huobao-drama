import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const exists = (file) => fs.existsSync(path.join(root, file))

function keysOf(value, prefix = '') {
  const keys = []
  for (const [key, child] of Object.entries(value || {})) {
    const next = prefix ? `${prefix}.${key}` : key
    if (child && typeof child === 'object' && !Array.isArray(child)) keys.push(...keysOf(child, next))
    else keys.push(next)
  }
  return keys.sort()
}

test('video module routes, nav and API are wired', () => {
  const config = read('nuxt.config.ts')
  const header = read('app/components/AppHeader.vue')
  const api = read('app/composables/useApi.ts')
  const list = read('app/pages/videos/index.vue')
  const detail = read('app/views/video/detail.vue')
  const rail = read('app/components/video/VideoProjectList.vue')

  assert.match(config, /path: '\/videos\/:id'/)
  assert.match(header, /to="\/videos"/)
  assert.match(api, /export const videoAPI/)
  for (const method of ['routePreview', 'uploadSource', 'uploadFace', 'preflight', 'analyze', 'aiAnalysis', 'savePrompt', 'confirmSceneReference', 'generate', 'runs', 'cancel', 'retryChunk']) {
    assert.match(api, new RegExp(`${method}:`), `missing videoAPI.${method}`)
  }
  assert.ok(exists('app/pages/videos/index.vue'))
  assert.ok(exists('app/views/video/detail.vue'))
  assert.ok(exists('app/components/video/VideoProjectList.vue'))
  assert.ok(exists('app/components/video/VideoCreateDialog.vue'))
  assert.match(list, /videoAPI\.list/)
  assert.match(read('app/components/video/VideoCreateDialog.vue'), /videoAPI\.create/)
  assert.match(read('app/components/video/VideoCreateDialog.vue'), /config_id: configId\.value/)
  assert.match(read('app/components/video/VideoCreateDialog.vue'), /videoSwapRouteText/)
  assert.match(read('app/components/video/VideoCreateDialog.vue'), /route\.value\?\.\[value\]/)
  assert.match(read('app/components/video/VideoCreateDialog.vue'), /modelHelpTitle/)
  assert.match(read('app/utils/video-swap-route.ts'), /facefusion_model/)
  assert.match(detail, /videoSwapRouteText/)
  assert.match(detail, /routeSummary/)
  assert.match(detail, /videoAPI\.generate/)
  assert.match(detail, /videoAPI\.cancel/)
  assert.match(detail, /runOptions/)
  assert.match(detail, /selectedRunId/)
  assert.match(detail, /scene_reference_candidates/)
  assert.match(detail, /seam_ssim/)
  assert.match(detail, /DEFAULT_FACE_PROMPT/)
  assert.match(detail, /mode === 'face' && runStatus\.value === 'analyzed'/)
  assert.match(rail, /video\.menu\.rename/)
  assert.doesNotMatch(detail, /workflow_slug|workflow JSON|workflowJson/)
  // 输出区只有一个播放器，源视频不另开播放器
  assert.equal((detail.match(/<video\b/g) || []).length, 1)
  // 移动端抽屉
  assert.match(detail, /drawerOpen/)
  assert.match(detail, /isCompact/)
})

test('video-swap settings include gateway fields and thresholds', () => {
  const settings = read('app/pages/settings.vue')
  assert.match(settings, /video-swap/)
  assert.match(settings, /face_workflow_slug/)
  assert.match(settings, /character_workflow_slug/)
  assert.match(settings, /analysis_config_id/)
  assert.match(settings, /scene_ref_base_url/)
  assert.match(settings, /seam_ssim_threshold/)
  assert.match(settings, /chunk_overlap_seconds/)
  assert.match(settings, /max_auto_retries/)
  assert.match(settings, /faceEngineH3Hint/)
  assert.match(settings, /face_engine/)
})

test('video locale keys stay consistent across four languages', () => {
  const locales = ['zh', 'en', 'ja', 'ko'].map(code => ({
    code,
    json: JSON.parse(read(`app/locales/${code}.json`)),
  }))
  const base = keysOf(locales[0].json.video)
  assert.ok(base.length > 50)
  for (const { code, json } of locales.slice(1)) {
    assert.deepEqual(keysOf(json.video), base, `${code} video keys differ`)
  }
  for (const { code, json } of locales) {
    assert.equal(typeof json.layout?.nav?.videos, 'string', `${code} missing nav.videos`)
    assert.equal(typeof json.common?.serviceType?.videoSwap, 'string', `${code} missing serviceType.videoSwap`)
    assert.equal(typeof json.settings?.cfg?.videoSwap?.faceWorkflow, 'string', `${code} missing settings videoSwap`)
    assert.equal(typeof json.video?.route?.character, 'string', `${code} missing video.route.character`)
    assert.equal(typeof json.video?.createDialog?.modelHelpTitle, 'string', `${code} missing createDialog.modelHelpTitle`)
    assert.doesNotMatch(json.video?.mode?.face || '', /H3/, `${code} face mode should not name an engine`)
    assert.doesNotMatch(json.video?.mode?.character || '', /H3|Recast/, `${code} character mode should not name an engine`)
  }
})
