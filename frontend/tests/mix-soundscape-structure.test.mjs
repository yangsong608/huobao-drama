import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const api = read('app/composables/useApi.ts')
const stage = read('app/composables/useMixStage.ts')

test('mix API exposes soundscape types and four endpoints', () => {
  assert.match(api, /export type SoundscapeCategory = 'ambience' \| 'sfx' \| 'crowd' \| 'bgm'/)
  assert.match(api, /export type SoundscapeMode = 'scenes' \| 'episode-bed' \| 'assets-only'/)
  assert.match(api, /export interface SoundscapePreview/)
  assert.match(api, /export interface SoundscapeStatus/)
  assert.match(api, /previewSoundscape: \(episodeId: number, data: SoundscapeRequest\)/)
  assert.match(api, /startSoundscape: \(episodeId: number, data: SoundscapeRequest\)/)
  assert.match(api, /soundscapeStatus: \(episodeId: number\)/)
  assert.match(api, /cancelSoundscape: \(episodeId: number\)/)
  assert.match(api, /\/episodes\/\$\{episodeId\}\/audio\/soundscape\/preview`/)
  assert.match(api, /\/episodes\/\$\{episodeId\}\/audio\/soundscape\/status`/)
  assert.match(api, /\/episodes\/\$\{episodeId\}\/audio\/soundscape\/cancel`/)
})

test('useMixStage owns soundscape polling, cancellation and refresh-before-idle', () => {
  assert.match(stage, /type SoundscapePreview/)
  assert.match(stage, /const soundscapeStatus = ref<SoundscapeStatus \| null>\(null\)/)
  assert.match(stage, /const soundscapePlan = ref<SoundscapePreview \| null>\(null\)/)
  assert.match(stage, /const soundscapeRefreshing = ref\(false\)/)
  assert.match(stage, /const soundscapeRunning = computed/)
  assert.match(stage, /let soundscapePollToken = 0/)
  assert.match(stage, /function stopSoundscapePolling\(\)/)
  assert.match(stage, /async function startSoundscape\(request: SoundscapeRequest\)/)
  assert.match(stage, /async function previewSoundscape\(request: SoundscapeRequest\)/)
  assert.match(stage, /async function cancelSoundscape\(\)/)
  assert.match(stage, /await Promise\.all\(\[loadAssets\(\), refreshPlan\(\)\]\)/)
  assert.match(stage, /soundscapeRunning,/)
  assert.match(stage, /startSoundscape,/)
  assert.match(stage, /cancelSoundscape,/)
})

test('soundscape polling retries transient failures and cancel always refreshes', () => {
  assert.match(stage, /const episodeChanged = loadedEpisode !== episodeId/)
  assert.match(stage, /if \(episodeChanged\) \{\n\s+stopSoundscapePolling\(\)\n\s+soundscapePlan\.value = null/)
  assert.match(stage, /async function cancelSoundscape\(\)[\s\S]*?finally \{/)
  assert.ok(
    (stage.match(/soundscapeTimer = setTimeout\(tick, POLL_INTERVAL_MS\)/g) ?? []).length >= 2,
    'poll failure must re-arm the timer',
  )
})

test('soundscape dialog loads scenes and emits preview/start requests', () => {
  const dialog = read('app/components/MixSoundscapeDialog.vue')
  assert.match(dialog, /preview: SoundscapePreview \| null/)
  assert.match(dialog, /episodeAPI\.scenes\(props\.episodeId\)/)
  assert.match(dialog, /v-for="mode in MODES"/)
  assert.match(dialog, /v-for="category in CATEGORIES"/)
  assert.match(dialog, /form\.crowdMode/)
  assert.match(dialog, /form\.sceneIds/)
  assert.match(dialog, /allScenes/)
  assert.match(dialog, /promptDraft/)
  assert.match(dialog, /emit\('preview', buildRequest\(\)\)/)
  assert.match(dialog, /emit\('start', buildRequest\(\)\)/)
})

test('soundscape dialog re-seeds prompt drafts when a retained preview is reshown', () => {
  const dialog = read('app/components/MixSoundscapeDialog.vue')
  assert.match(dialog, /function syncDrafts\(preview: SoundscapePreview \| null\)/)
  assert.match(dialog, /function resetForm\(\)[\s\S]*?syncDrafts\(props\.preview\)/)
  assert.match(dialog, /watch\(\(\) => props\.preview,[\s\S]*?syncDrafts\(value\)/)
})

test('soundscape dialog only sends overrides for user-edited prompts', () => {
  const dialog = read('app/components/MixSoundscapeDialog.vue')
  assert.match(dialog, /const promptDirty = reactive<Record<string, boolean>>\(\{\}\)/)
  assert.match(dialog, /maxlength="2000"/)
  assert.match(dialog, /@input="promptDirty\[item\.itemId\] = true"/)
  assert.match(
    dialog,
    /function resetDrafts\(\) \{[^}]*delete promptDirty\[key\][^}]*\}/,
    'resetDrafts 必须在函数体内清空 dirty 标记',
  )
  assert.match(
    dialog,
    /if \(!promptDirty\[item\.itemId\] \|\| !\(promptDraft\[item\.itemId\] \?\? ''\)\.trim\(\)\)/,
    '清空输入后必须回填默认提示词',
  )
  assert.match(dialog, /:placeholder="t\('mix\.soundscape\.promptPlaceholder'\)"/)
  assert.match(dialog, /if \(!prompt\) \{\s*delete promptDirty\[item\.itemId\]\s*continue\s*\}/)
  assert.match(
    dialog,
    /if \(!promptDirty\[item\.itemId\]\) continue/,
    'buildRequest 必须跳过未编辑的草稿',
  )
})

test('soundscape dialog scrolls start errors into view inside the scrollable body', () => {
  const dialog = read('app/components/MixSoundscapeDialog.vue')
  assert.match(dialog, /<p v-if="error" ref="errorRef" class="ss-error">/)
  assert.match(
    dialog,
    /watch\(\(\) => props\.error,[\s\S]*?await nextTick\(\)\s*\n\s*errorRef\.value\?\.scrollIntoView/,
    '错误出现后必须滚入视野，否则会被折叠的提示词列表挤出弹窗可视区',
  )
})

test('cancel after completed refreshes assets and only toasts success when cancelled', () => {
  assert.match(
    stage,
    /async function cancelSoundscape\(\)[\s\S]*?status\.status === 'completed'[\s\S]*?await Promise\.all\(\[loadAssets\(\), refreshPlan\(\)\]\)/,
    '任务恰好完成时取消必须刷新素材与计划',
  )
  assert.match(stage, /if \(err\?\.status !== 409\) throw err/, '任务已完成导致的 409 必须吞掉')
  const mixStage = read('app/components/MixStage.vue')
  assert.match(mixStage, /const cancelled = await cancelSoundscape\(\)/)
  assert.match(
    mixStage,
    /if \(cancelled\)[^\n]*\{\s*\n\s*toast\.success\(t\('mix\.soundscape\.cancelDone'\)\)/,
    '只有服务端确实取消成功时才提示已取消',
  )
})

test('MixStage exposes the soundscape entry, progress, dialog and generation lock', () => {
  const mixStage = read('app/components/MixStage.vue')
  assert.match(mixStage, /<Sparkles :size="12" \/>/)
  assert.match(mixStage, /const canGenerateSound = computed\(\(\) => Boolean\(props\.episodeId && props\.durationMs > 0\)\)/)
  assert.match(mixStage, /:class="\['mx-stage', \{ 'is-generating': soundscapeRunning \}\]"/)
  assert.match(mixStage, /v-if="soundscapeRunning" class="mx-progress"/)
  assert.match(mixStage, /soundscapeStatus\?\.step \|\| t\('mix\.soundscape\.preparing'\)/)
  assert.match(mixStage, /@click="onCancelSoundscape"/)
  assert.match(mixStage, /:can-edit="Boolean\(episodeId\) && !soundscapeRunning"/)
  assert.match(mixStage, /<MixSoundscapeDialog/)
  assert.match(mixStage, /@preview="onSoundscapePreview"/)
  assert.match(mixStage, /@start="onSoundscapeStart"/)
  assert.match(mixStage, /emit\('soundscape-busy', busy\)/)
})

test('AI generated tracks are marked and export waits for generation', () => {
  const trackHead = read('app/components/MixTrackHead.vue')
  const dubbing = read('app/components/DubbingStage.vue')
  assert.match(trackHead, /track\.origin === 'soundscape'/)
  assert.match(trackHead, /mix\.soundscape\.aiBadge/)
  assert.match(dubbing, /@soundscape-busy="mixSoundscapeBusy = \$event"/)
  assert.match(dubbing, /const mixSoundscapeBusy = ref\(false\)/)
  assert.match(dubbing, /if \(mixSoundscapeBusy\.value\)/)
  assert.match(dubbing, /:disabled="mixSoundscapeBusy"/)
})

test('master bus controls are locked during soundscape generation', () => {
  const mixStage = read('app/components/MixStage.vue')
  assert.match(mixStage, /:title="t\('mix\.masterMute'\)" :disabled="soundscapeRunning" @click="toggleMasterMute"/)
  assert.match(mixStage, /class="mx-master-range"[\s\S]*?:disabled="soundscapeRunning"[\s\S]*?@input="setMasterVolume"/)
})

test('settings exposes the audio-gen ComfyUI configuration form', () => {
  const settings = read('app/pages/settings.vue')
  assert.match(settings, /\{ type: 'audio-gen', label: t\('common\.serviceType\.audioGen'\) \}/)
  assert.match(settings, /'audio-gen': \{ label: t\('common\.serviceType\.audioGen'\), desc: t\('settings\.ai\.meta\.audioGen'\) \}/)
  assert.match(settings, /cfgForm\.service_type === 'audio-gen' && cfgForm\.provider === 'comfyui'/)
  assert.match(settings, /v-model="cfgForm\.provider_settings\.timeout_ms"/)
  assert.match(settings, /v-model="cfgForm\.provider_settings\.normalize_loudness"/)
  assert.match(settings, /v-model="cfgForm\.provider_settings\.model_license"/)
  assert.match(settings, /'audio-gen': \{\s+comfyui: \{ label: 'ComfyUI 本地音频工作流'/)
  assert.match(settings, /models: \['stable-audio-open-1\.0'\]/)
  assert.match(settings, /return \['workflow', 'output_node', 'output_key', 'negative_prompt', 'seed', 'timeout_ms', 'normalize_loudness', 'model_license'\]/)
  assert.match(settings, /key === 'timeout_ms'/)
})

test('soundscape copy exists in all four locales', () => {
  const scalar = [
    'title', 'subtitle', 'entry', 'entryHint', 'needMerge', 'running', 'preparing',
    'cancel', 'cancelDone', 'cancelFailed', 'startFailed', 'previewFailed', 'started',
    'done', 'failed', 'aiBadge', 'aiTrack', 'categoriesLabel', 'categoryRequired',
    'crowdModeLabel', 'sceneScope', 'allScenes', 'sceneLabel', 'noScenes', 'sceneRequired',
    'overwrite', 'overwriteHint', 'previewTitle', 'previewCount', 'estimated', 'degraded',
    'prompts', 'promptPlaceholder', 'reuseLine', 'itemDegraded', 'preview', 'start', 'wholeEpisode',
  ]
  const groups = {
    mode: ['scenes', 'episodeBed', 'assetsOnly'],
    modeHint: ['scenes', 'episodeBed', 'assetsOnly'],
    categories: ['ambience', 'sfx', 'crowd', 'bgm'],
    crowdMode: ['walla', 'lines'],
    crowdModeHint: ['walla', 'lines'],
  }
  const settingsKeys = [
    'audioWorkflowHint', 'audioOutputNodeHint', 'audioTimeout', 'audioTimeoutHint',
    'audioNormalize', 'audioNormalizeHint', 'modelLicense', 'modelLicenseHint',
  ]
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const dict = JSON.parse(read(`app/locales/${lang}.json`))
    const block = dict.mix?.soundscape
    assert.ok(block, `${lang} missing mix.soundscape`)
    for (const key of scalar) assert.equal(typeof block[key], 'string', `${lang} missing mix.soundscape.${key}`)
    for (const [group, keys] of Object.entries(groups)) {
      for (const key of keys) {
        assert.equal(typeof block[group]?.[key], 'string', `${lang} missing mix.soundscape.${group}.${key}`)
      }
    }
    assert.equal(typeof dict.common?.serviceType?.audioGen, 'string', `${lang} missing common.serviceType.audioGen`)
    assert.equal(typeof dict.settings?.ai?.meta?.audioGen, 'string', `${lang} missing settings.ai.meta.audioGen`)
    assert.equal(typeof dict.workbench?.soundscapeBusy, 'string', `${lang} missing workbench.soundscapeBusy`)
    for (const key of settingsKeys) assert.equal(typeof dict.settings?.cfg?.[key], 'string', `${lang} missing settings.cfg.${key}`)
  }
})
