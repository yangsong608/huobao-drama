import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const episode = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const storyboardList = readFileSync(new URL('../app/components/EpisodeStoryboardList.vue', import.meta.url), 'utf8')
const auditDrawer = readFileSync(new URL('../app/components/StoryboardAuditDrawer.vue', import.meta.url), 'utf8')
const taskDrawer = readFileSync(new URL('../app/components/EpisodeTaskDrawer.vue', import.meta.url), 'utf8')
const auditBadge = readFileSync(new URL('../app/components/AuditStateBadge.vue', import.meta.url), 'utf8')
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
  const rowStart = storyboardList.indexOf('v-for="task in rows"')
  const rowEnd = storyboardList.indexOf('class="video-task-footer"')
  const row = storyboardList.slice(rowStart, rowEnd)
  const cameraAt = row.indexOf('class="btn btn-icon btn-sm video-task-action"')
  const auditAt = row.indexOf('<AuditStateBadge')
  const deleteAt = row.indexOf('class="btn btn-icon btn-sm video-task-delete"')
  assert.ok(cameraAt > 0, '镜头卡片应有摄像头按钮')
  assert.ok(auditAt > cameraAt, '检验图标应在摄像头按钮右侧')
  assert.ok(deleteAt > auditAt, '检验图标应在删除按钮之前')
  assert.match(row, /@open="emit\('open-audit', task\.storyboard\.id\)"/)
  assert.match(row, /:state="task\.auditDisplay\.state"/)
  assert.match(row, /:severity="task\.auditDisplay\.severity"/)
  assert.match(row, /:count="task\.auditDisplay\.count"/)
  assert.match(episode, /function auditShotState\(sb\)/)
  assert.match(episode, /function auditShotDisplay\(sb\)/)
  for (const state of ['pending', 'running', 'failed', 'pass', 'warning', 'error', 'stale', 'rule_only']) {
    assert.match(episode, new RegExp(`state: '${state}'`), `缺少 ${state} 派生状态`)
  }
  for (const state of ['pending', 'running', 'warning', 'error', 'failed', 'rule_only', 'stale']) {
    assert.match(auditBadge, new RegExp(`is-${state}`), `缺少 ${state} 状态样式`)
  }
})

test('检验完成后干净的镜头不再显示检验状态标识（D12 干净就隐藏）', () => {
  assert.match(storyboardList, /v-if="task\.auditVisible"/)
  assert.match(episode, /function auditShotMarkerVisible\(sb\)/)
  assert.match(episode, /function auditShotMarkerVisible\(sb\) \{/)
  assert.match(episode, /if \(!auditJob\.value\) return false/)
  assert.match(episode, /view\.state !== 'pass' && view\.state !== 'none'/)
  assert.match(episode, /if \(shot\.status === 'done'\) return \{ state: 'pass'/)
})

test('镜头行操作按钮收进同一容器，栅格固定三列避免删除按钮换行', () => {
  assert.match(storyboardList, /class="video-task-actions"[\s\S]{0,600}class="btn btn-icon btn-sm video-task-action"/)
  assert.match(storyboardList, /class="video-task-actions"[\s\S]{0,4000}class="btn btn-icon btn-sm video-task-delete"/)
  assert.match(storyboardList, /\.video-task-row \{\s*display: grid;\s*grid-template-columns: 56px minmax\(0, 1fr\) auto;/)
  assert.match(storyboardList, /\.video-task-actions \{[^}]*justify-self: end;[^}]*display: flex;/)
})

test('检验抽屉位于遮罩容器内，避免被遮罩压暗与拦截点击', () => {
  assert.match(auditDrawer, /<div v-if="open" class="task-drawer-overlay" @click\.self="emit\('close'\)">\s*<aside\s+class="task-drawer audit-drawer"/)
  assert.ok(!/<div v-if="open" class="task-drawer-overlay"[^>]*\/>/.test(auditDrawer), '遮罩不能自闭合')
  assert.match(episode, /<StoryboardAuditDrawer[\s\S]*?@close="closeAuditPanel"/, '分集页必须挂载检验抽屉组件')
  assert.match(auditDrawer, /<\/aside>\s*<\/div>\s*<\/template>/, '检验抽屉必须在遮罩容器闭合前结束')
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
  assert.match(auditDrawer, /class="task-drawer audit-drawer"/)
  assert.match(episode, /const auditCheckGroups = computed/)
  assert.match(auditDrawer, /v-for="group in checkGroups"/)
  assert.match(auditDrawer, /episode\.audit\.check\.\$\{group\.check\}/)
  assert.match(episode, /const auditPanelFilter = computed/)
  assert.match(auditDrawer, /episode\.audit\.filter\.\$\{option\.key\}/)
  assert.match(episode, /const auditPanelIssues = computed/)
  assert.match(auditDrawer, /function issueText\(issue: any\)/)
  assert.match(auditDrawer, /\{\{ issueText\(issue\) \}\}/)
  assert.match(auditDrawer, /issue\.check === 2 && issue\.suggestedTransition/)
  assert.match(episode, /function openTransitionCreateFromIssue\(issue\)/)
  assert.match(auditDrawer, /emit\('create-transition', issue\)/)
  assert.match(auditDrawer, /issue\.check === 5/)
  assert.match(episode, /function gotoAssetPage\(\)/)
  assert.match(auditDrawer, /emit\('goto-assets'\)/)
  assert.match(episode, /async function undoAuditRepair\(\)/)
  assert.match(auditDrawer, /emit\('undo'\)/)
  assert.match(episode, /storyboardAuditAPI\.undo\(/)
  assert.match(auditDrawer, /job\?\.repair_log/)
  assert.match(auditDrawer, /episode\.audit\.empty\.clean/)
  assert.match(auditDrawer, /episode\.audit\.empty\.ruleOnly/)
  assert.match(auditDrawer, /episode\.audit\.empty\.stale/)
})

test('点击逐镜图标打开面板并只显示该镜问题，可定位与回到整集', () => {
  assert.match(episode, /function openAuditPanel\(shotId = null\)/)
  assert.match(episode, /auditPanel\.value = \{ open: true, shotId, filter: 'all' \}/)
  assert.match(episode, /function auditIssueVisible\(issue\)/)
  assert.match(episode, /issue\.storyboardId === auditPanel\.value\.shotId/)
  assert.match(episode, /function locateAuditShot\(issue\)/)
  assert.match(auditDrawer, /episode\.audit\.panel\.showAllShots/)
  assert.match(auditDrawer, /episode\.audit\.panel\.locateShot/)
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
  assert.match(episode, /episode\.audit\.transition\.kind\.fade/)
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
  assert.match(episode, /status === 'skipped_no_model'/)
  assert.match(auditDrawer, /job\?\.semantic_status === 'skipped_no_model'/)
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
  assert.match(storyboardList, /video-task-transition-tag/)
  assert.match(episode, /episode\.audit\.transition\.badge/)
})

test('语义检验关闭、部分失败与截断在面板明确提示', () => {
  assert.match(episode, /const auditSemanticNote = computed\(/)
  assert.match(episode, /if \(status === 'disabled'\) return t\('episode\.audit\.empty\.semanticDisabled'\)/)
  assert.match(episode, /'episode\.audit\.empty\.semanticDisabled'/)
  assert.match(episode, /'episode\.audit\.empty\.semanticPartial'/)
  assert.match(episode, /'episode\.audit\.empty\.semanticFailed'/)
  assert.match(episode, /'episode\.audit\.empty\.semanticTruncated'/)
  assert.match(auditDrawer, /class="audit-semantic-note"/)
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

test('过渡弹窗支持本地转场与六种样式，转场不要求提示词', () => {
  assert.match(episode, /const FADE_STYLE_VALUES = \['dissolve', 'dip-black', 'dip-white', 'wipe-left', 'slide-left', 'circle-open'\]/)
  assert.match(episode, /fadeStyleOptions = computed/)
  assert.match(episode, /v-if="transitionCreate\.kind === 'fade'"/)
  assert.match(episode, /episode\.audit\.transition\.fadeStyleLabel/)
  assert.match(episode, /episode\.audit\.transition\.fadeHint/)
  assert.match(episode, /if \(kind === 'fade'\) payload\.style = transitionCreate\.value\.style/)
  assert.match(episode, /transitionCreate\.kind !== 'text' && transitionCreate\.kind !== 'fade'/)
  assert.match(episode, /function fadeStyleLabel\(style\)/)
  assert.match(episode, /kind === 'fade' \? `\$\{label\} · \$\{fadeStyleLabel\(boundary\?\.style\)\}` : label/)
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

test('过渡详情可切换类型，本地转场显示当前样式', () => {
  assert.match(episode, /function switchTransitionKind\(boundary, kind\)/)
  assert.match(episode, /episode\.export\.aiTransition\.switchKind/)
  assert.match(episode, /transitionCreateKindOptions\.filter\(item => item\.value !== transitionKindOf\(transitionDetailBoundary\)\)/)
  assert.match(episode, /transitionKindOf\(transitionDetailBoundary\) === 'fade'[\s\S]{0,120}fadeStyleLabel\(transitionDetailBoundary\.style\)/)
})

test('过渡卡片展示类型与降级状态，导出页可新建自定义过渡', () => {
  assert.match(episode, /class="ai-transition-kind"/)
  assert.match(episode, /transitionKindLabel\(b\)/)
  assert.match(episode, /openTransitionCreate\(\)/)
  assert.match(episode, /episode\.export\.aiTransition\.addCustom/)
  assert.match(episode, /transitionCreatePairs/)
})

test('任务中心识别整集动作检验任务', () => {
  assert.match(taskDrawer, /if \(kind === 'storyboard_audit'\) return t\('episode\.tasks\.runStoryboardAudit'\)/)
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
    for (const kind of ['ai', 'empty', 'scene', 'text', 'fade']) {
      assert.equal(typeof copy?.transition?.kind?.[kind], 'string', `${lang} 缺少 audit.transition.kind.${kind}`)
    }
    assert.equal(typeof copy?.transition?.fadeStyleLabel, 'string', `${lang} 缺少 audit.transition.fadeStyleLabel`)
    assert.equal(typeof copy?.transition?.fadeHint, 'string', `${lang} 缺少 audit.transition.fadeHint`)
    for (const style of ['dissolve', 'dip-black', 'dip-white', 'wipe-left', 'slide-left', 'circle-open']) {
      assert.equal(typeof copy?.transition?.fadeStyle?.[style], 'string', `${lang} 缺少 audit.transition.fadeStyle.${style}`)
    }
    assert.equal(typeof bundle?.episode?.export?.aiTransition?.switchKind, 'string', `${lang} 缺少 export.aiTransition.switchKind`)
    assert.equal(typeof bundle?.episode?.tasks?.runStoryboardAudit, 'string', `${lang} 缺少 tasks.runStoryboardAudit`)
    assert.equal(typeof bundle?.detail?.automation?.stage?.storyboardAudit, 'string', `${lang} 缺少 detail.automation.stage.storyboardAudit`)
  }
  assert.match(detail, /storyboard_audit: 'storyboardAudit'/)
})

test('平板端检验抽屉与过渡弹窗全屏适配，检验按钮触摸区域不小于 28px', () => {
  assert.match(auditBadge, /\.audit-state-badge\s*\{[^}]*min-width:\s*28px/)
  assert.match(auditBadge, /\.audit-state-badge\s*\{[^}]*min-height:\s*28px/)
  assert.match(auditDrawer, /@media \(max-width: 1180px\) \{[\s\S]{0,4000}\.task-drawer\.audit-drawer\s*\{[^}]*width:\s*100%/)
  assert.match(episode, /@media \(max-width: 1180px\) \{[\s\S]{0,6000}\.transition-create-dialog\s*\{[^}]*width:\s*100%/)
})
