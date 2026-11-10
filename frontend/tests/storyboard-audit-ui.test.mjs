import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const episode = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const api = readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')
const detail = readFileSync(new URL('../app/views/drama/detail.vue', import.meta.url), 'utf8')
const locales = ['zh', 'en', 'ja', 'ko'].map(lang => [
  lang,
  JSON.parse(readFileSync(new URL(`../app/locales/${lang}.json`, import.meta.url), 'utf8')),
])

test('动作检验接口集中在 storyboardAuditAPI，并复用过渡自定义创建接口', () => {
  assert.match(api, /export const storyboardAuditAPI = \{/)
  assert.match(api, /latest: \(episodeId: number\) => api\.get<any>\(`\/agent\/storyboard_auditor\/audit-jobs\/latest\/\$\{episodeId\}`\)/)
  assert.match(api, /create: \(payload: Record<string, any>\) => api\.post<any>\('\/agent\/storyboard_auditor\/audit-jobs', payload\)/)
  assert.match(api, /undo: \(id: number\) => api\.post<any>\(`\/agent\/storyboard_auditor\/audit-jobs\/\$\{id\}\/undo`, \{\}\)/)
  assert.match(api, /createCustom: \(epId: number, payload: Record<string, any>\) => api\.post<any>\(`\/merge\/episodes\/\$\{epId\}\/transitions\/custom`, payload\)/)
})

test('视频制作页工具栏提供动作检验按钮与状态标签', () => {
  assert.match(episode, /class="btn btn-sm episode-audit-btn"/)
  assert.match(episode, /runStoryboardAudit\(\)/)
  assert.match(episode, /class="episode-audit-status"/)
  assert.match(episode, /@click="openAuditPanel\(\)"/)
  assert.match(episode, /auditButtonLabel/)
  assert.match(episode, /auditStatusText/)
  assert.match(episode, /:disabled="!sbs\.length \|\| splitRunning \|\| splitStarting \|\| auditBusy \|\| auditRunning"/)
  const toolbarStart = episode.indexOf('class="prod-section-bar"')
  const toolbarEnd = episode.indexOf('class="step-empty video-task-empty-state"')
  const auditButtonAt = episode.indexOf('class="btn btn-sm episode-audit-btn"')
  assert.ok(auditButtonAt > toolbarStart && auditButtonAt < toolbarEnd, '动作检验按钮应在制作页工具栏内')
  assert.ok(
    episode.indexOf('batchVideoPrompts"') < auditButtonAt && auditButtonAt < episode.indexOf('@click="batchVideos"'),
    '动作检验按钮应位于批量提示词与批量视频之间',
  )
})

test('左侧每个镜头卡片在摄像头按钮右侧显示逐镜检验状态图标', () => {
  const rowStart = episode.indexOf('v-for="task in videoTaskRows"')
  const rowEnd = episode.indexOf('class="video-task-footer"')
  const row = episode.slice(rowStart, rowEnd)
  const cameraAt = row.indexOf('class="btn btn-icon btn-sm video-task-action"')
  const auditAt = row.indexOf('class="btn btn-icon btn-sm video-task-audit"')
  const deleteAt = row.indexOf('class="btn btn-icon btn-sm video-task-delete"')
  assert.ok(cameraAt > 0, '镜头卡片应有摄像头按钮')
  assert.ok(auditAt > cameraAt, '检验图标应在摄像头按钮右侧')
  assert.ok(deleteAt > auditAt, '检验图标应在删除按钮之前')
  assert.match(row, /@click\.stop="openAuditPanel\(task\.storyboard\.id\)"/)
  assert.match(row, /auditShotState\(task\.storyboard\)/)
  assert.match(row, /video-task-audit-badge/)
  assert.match(row, /video-task-audit-stale/)
  assert.match(episode, /function auditShotState\(sb\)/)
  for (const state of ['pending', 'running', 'done', 'failed']) {
    assert.match(episode, new RegExp(`is-\\$\\{shot\\.status\\}|audit-shot-${state}`), `缺少 ${state} 状态样式`)
  }
})

test('检验按最新任务轮询，拆分完成后补读并只应用最新请求', () => {
  assert.match(episode, /const auditState = ref\(\{ loading: false, job: null, loaded: false \}\)/)
  assert.match(episode, /const auditPoll = useVisibilityPolling\(/)
  assert.match(episode, /storyboardAuditAPI\.latest\(epId\.value\)/)
  assert.match(episode, /function scheduleAuditPoll\(\)/)
  assert.match(episode, /let auditRequestSeq = 0/)
  assert.match(episode, /if \(seq !== auditRequestSeq\) return/)
  assert.match(episode, /async function loadStoryboardAuditAfterSplit\(\)/)
  assert.match(episode, /void loadStoryboardAuditAfterSplit\(\)/)
  assert.match(episode, /await loadStoryboardAudit\(\{ silent: true \}\)/)
})

test('检验进行中禁用会改动分镜的入口', () => {
  assert.match(episode, /const auditRunning = computed\(/)
  assert.match(episode, /if \(auditRunning\.value\) \{[\s\S]{0,160}episode\.audit\.runningBlocked/)
  assert.match(episode, /async function genVid\(sb, opts = \{\}\) \{[\s\S]{0,260}auditRunning\.value/)
  assert.match(episode, /async function batchVideoPrompts\(\) \{[\s\S]{0,200}auditRunning\.value/)
  assert.match(episode, /async function genVideoPrompt\(sb\) \{[\s\S]{0,200}auditRunning\.value/)
  assert.match(episode, /:disabled="rn \|\| methodSaving \|\| splitRunning \|\| splitStarting \|\| auditRunning"/)
  assert.match(episode, /:disabled="splitStarting \|\| auditRunning"/)
  assert.match(episode, /:disabled="videoPromptBatch\.running \|\| !sbs\.length \|\| auditRunning"/)
})

test('检验面板按五项分组展示问题、过滤、修复记录与撤销', () => {
  assert.match(episode, /<aside v-if="auditPanel\.open" class="task-drawer audit-drawer"/)
  assert.match(episode, /auditCheckGroups/)
  assert.match(episode, /episode\.audit\.check\.\$\{group\.check\}/)
  assert.match(episode, /auditPanelFilter/)
  assert.match(episode, /episode\.audit\.filter\.\$\{option\.key\}/)
  assert.match(episode, /auditPanelIssues/)
  assert.match(episode, /auditIssueText\(issue\)/)
  assert.match(episode, /issue\.check === 2 && issue\.suggestedTransition/)
  assert.match(episode, /openTransitionCreateFromIssue\(issue\)/)
  assert.match(episode, /issue\.check === 5/)
  assert.match(episode, /gotoAssetPage\(\)/)
  assert.match(episode, /undoAuditRepair\(\)/)
  assert.match(episode, /storyboardAuditAPI\.undo\(/)
  assert.match(episode, /auditJob\.repair_log/)
  assert.match(episode, /episode\.audit\.empty\.clean/)
  assert.match(episode, /episode\.audit\.empty\.ruleOnly/)
  assert.match(episode, /episode\.audit\.empty\.stale/)
})

test('点击逐镜图标打开面板并只显示该镜问题，可定位与回到整集', () => {
  assert.match(episode, /function openAuditPanel\(shotId = null\)/)
  assert.match(episode, /auditPanel\.value = \{ open: true, shotId, filter: 'all' \}/)
  assert.match(episode, /function auditIssueVisible\(issue\)/)
  assert.match(episode, /issue\.storyboardId === auditPanel\.value\.shotId/)
  assert.match(episode, /function locateAuditShot\(issue\)/)
  assert.match(episode, /episode\.audit\.panel\.showAllShots/)
  assert.match(episode, /episode\.audit\.panel\.locateShot/)
})

test('检查 2 问题卡可直接打开过渡镜头创建弹窗，并按建议预填类型', () => {
  assert.match(episode, /const transitionCreate = ref\(\{/)
  assert.match(episode, /function openTransitionCreateFromIssue\(issue\)/)
  assert.match(episode, /suggestedTransition/)
  assert.match(episode, /function openTransitionCreateForBoundary\(boundary\)/)
  assert.match(episode, /transitionCreateKindOptions/)
  assert.match(episode, /episode\.audit\.transition\.kind\.empty/)
  assert.match(episode, /episode\.audit\.transition\.kind\.scene/)
  assert.match(episode, /episode\.audit\.transition\.kind\.text/)
  assert.match(episode, /class="dialog transition-create-dialog"/)
})

test('过渡建议按字符串类型与关联分镜定位边界，兼容蛇形字段', () => {
  assert.match(episode, /relatedStoryboardIds: issue\?\.relatedStoryboardIds \?\? issue\?\.related_storyboard_ids \?\? \[\]/)
  assert.match(episode, /const kind = String\(issue\?\.suggestedTransition \?\? issue\?\.suggested_transition \?\? ''\)/)
  assert.match(episode, /\['empty', 'scene', 'text'\]\.includes\(kind\)/)
  assert.match(episode, /ids\.has\(item\.fromId\) && ids\.has\(item\.toId\)/)
})

test('检验完成与仅规则状态使用后端 done / skipped_no_model 字面量', () => {
  assert.match(episode, /if \(job\.status === 'done'\) \{[\s\S]{0,160}episode\.audit\.runDone/)
  assert.match(episode, /auditJob\?\.semantic_status === 'skipped_no_model'/)
})

test('检验完成自动刷新分镜并保持按 ID 选中，插入过渡镜头后可见', () => {
  assert.match(episode, /function auditInsertedTransitionCount\(job\)/)
  assert.match(episode, /void resyncStoryboards\(\)/)
  assert.match(episode, /Number\(job\.total_shots \?\? job\.totalShots \?\? 0\)/)
  assert.match(episode, /totalShots !== sbs\.value\.length/)
  assert.match(episode, /if \(job\.status === 'done' && totalShots > 0 && totalShots !== sbs\.value\.length\)/)
  assert.match(episode, /const currentId = selectedSb\.value\?\.id/)
  assert.match(episode, /selectedSb\.value = sbs\.value\.find\(sb => sb\.id === currentId\)/)
  assert.match(episode, /episode\.audit\.insertedDone/)
  assert.match(episode, /function storyboardTransitionKind\(sb\)/)
  assert.match(episode, /transition_kind/)
  assert.match(episode, /video-task-transition-tag/)
  assert.match(episode, /episode\.audit\.transition\.badge/)
})

test('语义检验关闭、部分失败与截断在面板明确提示', () => {
  assert.match(episode, /const auditSemanticNote = computed\(/)
  assert.match(episode, /auditJob\?\.semantic_status === 'disabled'/)
  assert.match(episode, /episode\.audit\.empty\.semanticDisabled/)
  assert.match(episode, /episode\.audit\.empty\.semanticPartial/)
  assert.match(episode, /episode\.audit\.empty\.semanticFailed/)
  assert.match(episode, /episode\.audit\.empty\.semanticTruncated/)
  assert.match(episode, /class="audit-semantic-note"/)
})

test('过渡镜头弹窗校验类型、时长 2–5 秒、文字 20/40 字与场景归属', () => {
  assert.match(episode, /const TRANSITION_CUSTOM_DURATIONS = \[2, 2\.5, 3, 3\.5, 4, 4\.5, 5\]/)
  assert.match(episode, /transitionCreateKindOptions = computed/)
  assert.match(episode, /v-if="transitionCreate\.kind === 'text'"/)
  assert.match(episode, /maxlength="20"/)
  assert.match(episode, /maxlength="40"/)
  assert.match(episode, /v-if="transitionCreate\.kind === 'scene'"/)
  assert.match(episode, /transitionCreateScenes/)
  assert.match(episode, /function transitionCreateSubmit\(\)/)
  assert.match(episode, /transitionAPI\.createCustom\(epId\.value, payload\)/)
  assert.match(episode, /episode\.audit\.transition\.submitted/)
})

test('过渡详情区分 AI 与自定义类型，场景缺图显示降级标记', () => {
  assert.match(episode, /function transitionKindOf\(boundary\)/)
  assert.match(episode, /function transitionKindLabel\(boundary\)/)
  assert.match(episode, /transitionKindOf\(transitionDetailBoundary\) === 'ai'/)
  assert.match(episode, /transitionDetailBoundary\.degraded/)
  assert.match(episode, /episode\.export\.aiTransition\.degraded/)
  assert.match(episode, /episode\.export\.aiTransition\.editCustom/)
  assert.match(episode, /class="ai-transition-kind"/)
})

test('过渡卡片展示类型与降级状态，导出页可新建自定义过渡', () => {
  assert.match(episode, /class="ai-transition-kind"/)
  assert.match(episode, /transitionKindLabel\(b\)/)
  assert.match(episode, /openTransitionCreate\(\)/)
  assert.match(episode, /episode\.export\.aiTransition\.addCustom/)
  assert.match(episode, /transitionCreatePairs/)
})

test('任务中心识别整集动作检验任务', () => {
  assert.match(episode, /if \(kind === 'storyboard_audit'\) return t\('episode\.tasks\.runStoryboardAudit'\)/)
})

test('四语言补齐动作检验、过渡类型与自动化阶段文案', () => {
  for (const [lang, bundle] of locales) {
    const copy = bundle?.episode?.audit
    assert.ok(copy, `${lang} 缺少 episode.audit`)
    for (const key of ['button', 'rerun', 'runningBlocked', 'loadFailed', 'cleanTitle', 'issuesTitle', 'undo', 'undoDone', 'runDone', 'insertedDone']) {
      assert.equal(typeof copy?.[key], 'string', `${lang} 缺少 audit.${key}`)
    }
    for (const key of ['pending', 'running', 'done', 'failed', 'ruleOnly', 'stale']) {
      assert.equal(typeof copy?.shotStatus?.[key], 'string', `${lang} 缺少 audit.shotStatus.${key}`)
    }
    for (const check of ['1', '2', '3', '4', '5']) {
      assert.equal(typeof copy?.check?.[check], 'string', `${lang} 缺少 audit.check.${check}`)
    }
    for (const key of ['all', 'error', 'warning', 'info', 'manual', 'fixed']) {
      assert.equal(typeof copy?.filter?.[key], 'string', `${lang} 缺少 audit.filter.${key}`)
    }
    for (const key of ['kindName', 'duration', 'prompt', 'scene', 'textContent', 'textSubtitle', 'submit', 'submitting', 'submitted', 'title', 'badge']) {
      assert.equal(typeof copy?.transition?.[key], 'string', `${lang} 缺少 audit.transition.${key}`)
    }
    for (const key of ['semanticDisabled', 'semanticPartial', 'semanticFailed', 'semanticTruncated']) {
      assert.equal(typeof copy?.empty?.[key], 'string', `${lang} 缺少 audit.empty.${key}`)
    }
    for (const kind of ['ai', 'empty', 'scene', 'text']) {
      assert.equal(typeof copy?.transition?.kind?.[kind], 'string', `${lang} 缺少 audit.transition.kind.${kind}`)
    }
    assert.equal(typeof bundle?.episode?.tasks?.runStoryboardAudit, 'string', `${lang} 缺少 tasks.runStoryboardAudit`)
    assert.equal(typeof bundle?.detail?.automation?.stage?.storyboardAudit, 'string', `${lang} 缺少 detail.automation.stage.storyboardAudit`)
  }
  assert.match(detail, /storyboard_audit: 'storyboardAudit'/)
})

test('平板端检验抽屉与过渡弹窗全屏适配，检验按钮触摸区域不小于 28px', () => {
  assert.match(episode, /\.video-task-audit\s*\{[^}]*min-width:\s*28px/)
  assert.match(episode, /\.video-task-audit\s*\{[^}]*min-height:\s*28px/)
  assert.match(episode, /@media \(max-width: 1180px\) \{[\s\S]{0,4000}\.audit-drawer\s*\{[^}]*width:\s*100%/)
  assert.match(episode, /@media \(max-width: 1180px\) \{[\s\S]{0,6000}\.transition-create-dialog\s*\{[^}]*width:\s*100%/)
})
