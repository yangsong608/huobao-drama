import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

const trackHead = read('app/components/MixTrackHead.vue')
const inspector = read('app/components/MixClipInspector.vue')
const mixStage = read('app/components/MixStage.vue')
const timeline = read('app/components/MixTimeline.vue')
const dubbing = read('app/components/DubbingStage.vue')
const zh = JSON.parse(read('app/locales/zh.json'))
const en = JSON.parse(read('app/locales/en.json'))
const ja = JSON.parse(read('app/locales/ja.json'))
const ko = JSON.parse(read('app/locales/ko.json'))

const locales = { zh, en, ja, ko }

const REQUIRED_MIX_KEYS = [
  'addTrackMenuTitle',
  'addTrackMenuHint',
  'trackAdded',
  'trackAddFailed',
  'newTrackHint',
  'newTrackName',
  'newTrackNamePlaceholder',
  'newTrackBusHint',
  'newTrackDisabledHint',
  'trackMuteShort',
  'trackSoloShort',
  'trackDuckShort',
  'trackLoopShort',
  'panCenter',
  'panLeft',
  'panRight',
  'clipVirtualHint',
  'clipManualHint',
  'trackVirtualFaderHint',
  'assetSourceHint',
  'engineUvr',
  'engineDemucs',
  'busHint',
  'takeLabel',
  'roleDialogueHint',
  'roleCrowdHint',
  'roleOriginalHint',
  'roleAmbienceHint',
  'roleSfxHint',
  'roleBgmHint',
  'roleCustomHint',
]

test('mix labels are localized instead of English abbreviations', () => {
  assert.match(trackHead, /t\('mix\.trackMuteShort'\)/)
  assert.match(trackHead, /t\('mix\.trackSoloShort'\)/)
  assert.match(trackHead, /t\('mix\.trackDuckShort'\)/)
  assert.match(trackHead, /t\('mix\.trackLoopShort'\)/)
  assert.doesNotMatch(trackHead, />M</)
  assert.doesNotMatch(trackHead, />S</)
  assert.doesNotMatch(trackHead, />D</)
  assert.doesNotMatch(trackHead, />L</)
  assert.match(trackHead, /t\('mix\.panCenter'\)/)
  assert.match(trackHead, /t\('mix\.panLeft', \{ n:/)
  assert.match(trackHead, /t\('mix\.panRight', \{ n:/)

  assert.doesNotMatch(inspector, />M</)
  assert.doesNotMatch(inspector, />S</)
  assert.doesNotMatch(inspector, />Duck</)
  assert.doesNotMatch(inspector, />Loop</)
  assert.match(inspector, /t\('mix\.trackDuck'\)/)
  assert.match(inspector, /t\('mix\.engineUvr'\)/)
  assert.match(inspector, /t\('mix\.engineDemucs'\)/)
  assert.match(inspector, /function panText/)
  assert.match(inspector, /t\('mix\.panCenter'\)/)
})

test('inspector shows the real dirty state, not a stale saved label', () => {
  assert.match(inspector, /dirty\?: boolean/)
  assert.match(inspector, /props\.dirty \? t\('mix\.unsaved'\)/)
  assert.match(inspector, /'is-dirty': dirty && !saving/)
  assert.match(mixStage, /:dirty="dirty"/)
  assert.match(mixStage, /:can-edit="Boolean\(episodeId\)/)
})

test('virtual dialogue clips get a compact read-only inspector', () => {
  assert.match(inspector, /<template v-if="virtual">/)
  assert.match(inspector, /<template v-else>/)
  assert.match(inspector, /t\('mix\.clipVirtualHint'\)/)
  assert.match(inspector, /t\('mix\.clipManualHint'\)/)
  assert.match(inspector, /v-if="clip\.takeId" class="mx-hint"/)
  assert.match(inspector, /t\('mix\.trackVirtualFaderHint'\)/)
  assert.match(inspector, /v-if="!track\.virtual" :class="\['mx-toggle'/)
})

test('new track card explains role, name and output group before creating', () => {
  assert.match(inspector, /canEdit\?: boolean/)
  assert.match(inspector, /t\('mix\.newTrackHint'\)/)
  assert.match(inspector, /t\('mix\.newTrackName'\)/)
  assert.match(inspector, /t\('mix\.newTrackBusHint', \{ bus:/)
  assert.match(inspector, /t\('mix\.newTrackDisabledHint'\)/)
  assert.match(inspector, /roleHint\(newRole\)/)
  assert.match(inspector, /emit\('add-track', newRole/)
  assert.match(mixStage, /t\('mix\.addTrackMenuTitle'\)/)
  assert.match(mixStage, /roleHint\(role\)/)
  assert.match(mixStage, /t\('mix\.trackAdded'/)
  assert.match(mixStage, /t\('mix\.trackAddFailed'\)/)
})

test('timeline localizes take labels', () => {
  assert.match(timeline, /t\('mix\.takeLabel', \{ id: clip\.takeId \}\)/)
  assert.doesNotMatch(timeline, /`Take #\$\{clip\.takeId\}`/)
})

test('dubbing preview has no duplicate synthesize-all action', () => {
  assert.doesNotMatch(dubbing, /@click="synthesizeAll/)
  assert.match(dubbing, /@click="loadTimeline"/)
})

test('shortcut hint avoids the solo S and names keys in Chinese', () => {
  assert.match(mixStage, /key === 'b'/)
  assert.doesNotMatch(mixStage, /key === 's'/)
  for (const locale of Object.values(locales)) {
    assert.equal(typeof locale.mix.shortcutHint, 'string')
    assert.match(locale.mix.shortcutHint, /B/)
  }
  assert.match(zh.mix.shortcutHint, /空格/)
  assert.match(zh.mix.shortcutHint, /Delete/)
})

test('all locales carry the new mix labels', () => {
  for (const [name, locale] of Object.entries(locales)) {
    for (const key of REQUIRED_MIX_KEYS) {
      assert.equal(typeof locale.mix[key], 'string', `${name}.mix.${key} missing`)
      assert.ok(locale.mix[key].length > 0, `${name}.mix.${key} empty`)
    }
  }
})

test('Chinese copy removes leftover English jargon', () => {
  for (const key of ['followTake', 'followTakeHint', 'trackVirtualHint', 'takeLabel']) {
    assert.doesNotMatch(zh.mix[key], /Take/, `zh.mix.${key}`)
  }
  assert.doesNotMatch(zh.mix.preview, /渲染/)
  assert.doesNotMatch(zh.mix.busSection, /总线/)
  assert.doesNotMatch(zh.mix.trackBus, /总线/)
  assert.doesNotMatch(zh.mix.trackDuck, /闪避/)
  assert.equal(zh.mix.trackVirtual, '自动生成')
  assert.equal(zh.mix.inspector, '属性面板')
  for (const key of ['bgmNone', 'bgmApplied', 'bgmUpload', 'bgmVolume']) {
    assert.doesNotMatch(zh.workbench[key], /BGM/, `zh.workbench.${key}`)
  }
  for (const key of ['empty', 'generateAnother', 'historyTitle', 'takeNo', 'deleteConfirm', 'compareHint']) {
    assert.doesNotMatch(zh.take[key], /Take/, `zh.take.${key}`)
  }
  assert.doesNotMatch(zh.generate.startHint, /Take/)
})