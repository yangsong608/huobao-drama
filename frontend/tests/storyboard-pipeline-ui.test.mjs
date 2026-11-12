import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const episode = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const editor = readFileSync(new URL('../app/components/PromptSectionEditor.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const locales = ['zh', 'en', 'ja', 'ko'].map(lang => [
  lang,
  JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')),
])

test('视频制作页使用独立的拆分进度面板，不再用 banner + 空状态重复进度', () => {
  assert.match(episode, /class="video-split-panel"/)
  assert.match(episode, /v-if="splitRunning \|\| \(canResumeSplit && splitJob\)"/)
  assert.match(episode, /class="video-split-progress-track"/)
  assert.match(episode, /class="video-split-chunk-list"/)
  assert.match(episode, /@click="pauseSplit"/)
  assert.match(episode, /splitPausing/)
  assert.match(api, /pause: \(runId: number\) => api\.post\(`\/pipelines\/runs\/\$\{runId\}\/pause`/)
  // 模板里不应再出现旧的 banner 进度条
  const workbenchAt = episode.indexOf('class="video-task-workbench has-player"')
  const workbenchTail = episode.slice(workbenchAt)
  assert.ok(!workbenchTail.includes('video-split-banner'), '拆分进度不应再挂在 workbench 顶部')
})

test('提示词改为固定五分区编辑器，支持 @/# 资产与时间帧分段', () => {
  assert.match(episode, /<PromptSectionEditor/)
  assert.match(editor, /class="prompt-section"/)
  for (const label of ['cast', 'scene', 'blocking', 'segments', 'negative']) {
    assert.match(editor, new RegExp(`copy\\.${label}`), `缺少 ${label} 分区`)
  }
  assert.match(editor, /MentionTextarea/)
  assert.match(editor, /adjustSegment\(index, -0\.5\)/)
  assert.match(editor, /adjustSegment\(index, 0\.5\)/)
  assert.match(editor, /lockTotal/)
  assert.match(editor, /按台词分配|fitDialogue/)
  assert.match(editor, /emit\('duration', totalDuration\.value\)/)
  assert.match(editor, /watch\(\(\) => props\.modelValue/)
})

test('总时长由分段自动计算，右下角不再手动输入 duration', () => {
  assert.match(episode, /durationAutoHint/)
  assert.ok(!episode.includes('@change="onVideoDurationChange"'), '不应再保留手动时长输入')
  assert.match(episode, /<span class="video-param-value">\{\{ Number\(selectedSb\.duration\) \|\| 10 \}\}s<\/span>/)
})

test('旧检验图标已移除，失败镜通过人工处理区块操作', () => {
  assert.doesNotMatch(episode, /<AuditStateBadge/)
  assert.match(episode, /video-split-manual/)
  assert.match(episode, /focusPipelineShotNumber/)
  assert.match(episode, /episode\.sb\.manualEdit/)
  assert.match(episode, /episode\.sb\.manualContinue/)
})

test('四语言补齐拆分暂停与时长自动计算文案', () => {
  for (const [lang, bundle] of locales) {
    const sb = bundle.episode?.sb || {}
    const inspector = bundle.episode?.inspector || {}
    assert.equal(typeof sb.splitPause, 'string', `${lang} 缺少 episode.sb.splitPause`)
    assert.equal(typeof sb.splitPauseRequested, 'string', `${lang} 缺少 episode.sb.splitPauseRequested`)
    assert.equal(typeof inspector.durationAutoHint, 'string', `${lang} 缺少 episode.inspector.durationAutoHint`)
  }
})

const coverageBoard = readFileSync(new URL('../app/components/CoverageBoard.vue', import.meta.url), 'utf8')
const geographyDialog = readFileSync(new URL('../app/components/SceneGeographyDialog.vue', import.meta.url), 'utf8')

test('覆盖板按场景分组，显示覆盖类型/缺口/轴线信息并可打开地理卡', () => {
  assert.match(coverageBoard, /class="coverage-board"/)
  assert.match(coverageBoard, /v-for="group in groups"/)
  assert.match(coverageBoard, /class="coverage-chip"/)
  assert.match(coverageBoard, /open-geography/)
  assert.match(coverageBoard, /inferCoverageType/)
  assert.match(coverageBoard, /screenLeft/)
  assert.match(coverageBoard, /planningAPI\.deriveCoveragePlan/)
  assert.match(coverageBoard, /planningAPI\.coveragePlans/)
})

test('场景地理卡支持布局/地标/机位/轴线编辑并保存到规划 API', () => {
  assert.match(geographyDialog, /场景地理卡/)
  assert.match(geographyDialog, /v-model="form\.layout"/)
  assert.match(geographyDialog, /v-for="\(landmark, index\) in form\.landmarks"/)
  assert.match(geographyDialog, /机位 A/)
  assert.match(geographyDialog, /轴\s*线|主轴线/)
  assert.match(geographyDialog, /planningAPI\.saveSceneGeography/)
})

test('视频制作页接入覆盖板、地理卡和规划 API，并保留列表切换', () => {
  assert.match(episode, /<CoverageBoard/)
  assert.match(episode, /<SceneGeographyDialog/)
  assert.match(episode, /planningAPI\.sceneGeography/)
  assert.match(episode, /coverageMode/)
  assert.match(episode, /episode\.vid\.coverageMode/)
  assert.match(api, /export const planningAPI = \{/)
  for (const [lang, bundle] of locales) {
    assert.equal(typeof bundle.episode?.vid?.coverageMode, 'string', `${lang} 缺少 episode.vid.coverageMode`)
    assert.equal(typeof bundle.episode?.vid?.listMode, 'string', `${lang} 缺少 episode.vid.listMode`)
  }
})

test('生成前置门禁：单镜和批量生成前读取最新审计错误并阻断', () => {
  assert.match(api, /generationGate: \(id: number\) => api\.get\(`\/storyboards\/\$\{id\}\/generation-gate`\)/)
  assert.match(episode, /async function fetchGenerationGate\(sb\)/)
  assert.match(episode, /async function ensureGenerationGate\(sb, opts = \{\}\)/)
  assert.match(episode, /if \(!opts\.skipGate && !\(await ensureGenerationGate\(sb, opts\)\)\) return/)
  assert.match(episode, /const gateResults = await Promise\.all\(targets\.map/)
  assert.match(episode, /不能开始批量生成/)
  assert.match(episode, /toast\.error\(`不能生成：/)
})

test('尾帧链：上一镜末帧自动作为本镜首帧，Wan 3.0 降级为参考图', () => {
  assert.match(episode, /const previous = getPreviousShotFrameRef\(sb\)/)
  assert.match(episode, /const autoTail = !explicitFirst && previous\?\.url \? previous\.url : ''/)
  assert.match(episode, /const firstFrameImage = isWan3Video\.value \? '' : \(explicitFirst \|\| autoTail\)/)
  assert.match(episode, /params\.first_frame_url = firstFrameImage/)
  assert.match(episode, /referenceImages = referenceImages\.filter\(url => url !== firstFrameImage\)/)
  assert.match(episode, /t\('episode\.frameAssets\.autoFirstFrame'\)/)
  for (const [lang, data] of locales) {
    assert.ok(data.episode?.frameAssets?.autoFirstFrame, `${lang} 缺少自动首帧文案`)
  }
})

test('覆盖板刷新计划后同步镜头合同，旧分镜也能参与成对校验', () => {
  assert.match(api, /syncContracts: \(episodeId: number\) => api\.post\('\/storyboards\/contracts\/sync', \{ episode_id: episodeId \}\)/)
  assert.match(coverageBoard, /storyboardAPI\.syncContracts\(props\.episodeId\)/)
})

test('覆盖板可直接修改覆盖类型并保存本场计划', () => {
  assert.match(coverageBoard, /class="coverage-type-select"/)
  assert.match(coverageBoard, /changeCoverageType\(group, shot, \$event\.target\.value\)/)
  assert.match(coverageBoard, /planningAPI\.saveCoveragePlan\(props\.episodeId, group\.sceneId/)
  assert.match(coverageBoard, /function summarizeUnits\(units\)/)
})
