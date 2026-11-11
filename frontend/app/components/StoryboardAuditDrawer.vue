<template>
  <div v-if="open" class="task-drawer-overlay" @click.self="emit('close')">
    <aside class="task-drawer audit-drawer" role="dialog" aria-modal="true" :aria-label="t('episode.audit.panel.title')">
      <header class="task-drawer-head">
        <div>
          <div class="video-task-title">{{ t('episode.audit.panel.title') }}</div>
          <div class="video-task-meta">
            {{ statusText }}
            <template v-if="job"> · {{ t('episode.audit.panel.trigger') }}: {{ t(`episode.audit.trigger.${job.trigger || 'manual'}`) }}</template>
          </div>
        </div>
        <div class="task-drawer-head-actions">
          <button class="btn btn-sm" :disabled="busy || running || !canRun" @click="emit('run')">
            <Loader2 v-if="busy || running" :size="11" class="animate-spin" />
            {{ running ? t('episode.audit.shotStatus.running') : (job ? t('episode.audit.rerun') : t('episode.audit.button')) }}
          </button>
          <button class="btn btn-ghost btn-icon" :aria-label="t('episode.audit.panel.close')" @click="emit('close')"><X :size="14" /></button>
        </div>
      </header>
      <div v-if="running" class="audit-progress">
        <div class="audit-progress-bar"><span :style="{ width: progressPercent + '%' }" /></div>
        <span class="video-task-meta">{{ t('episode.audit.panel.progress', { done: job?.completed_windows || 0, total: job?.total_windows || 0 }) }}</span>
      </div>
      <div class="video-task-metrics task-drawer-metrics">
        <span class="video-task-metric is-failed">{{ t('episode.audit.filter.error') }} {{ job?.error_count || 0 }}</span>
        <span class="video-task-metric is-pending">{{ t('episode.audit.filter.warning') }} {{ job?.warning_count || 0 }}</span>
        <span class="video-task-metric is-done">{{ t('episode.audit.filter.info') }} {{ job?.info_count || 0 }}</span>
      </div>
      <div v-if="semanticNote" class="audit-semantic-note">{{ semanticNote }}</div>
      <div v-if="job?.stale" class="audit-stale-note">{{ t('episode.audit.empty.stale') }}</div>
      <div v-if="job?.status === 'failed'" class="audit-error-note">
        {{ t('episode.audit.panel.jobError', { message: job.error_msg || '' }) }}
      </div>
      <div v-if="shotLabel" class="audit-shot-scope">
        <span>{{ shotLabel }}</span>
        <button class="btn btn-sm" @click="emit('show-all-shots')">{{ t('episode.audit.panel.showAllShots') }}</button>
      </div>
      <div class="audit-filter-row">
        <button
          v-for="option in filterOptions"
          :key="option.key"
          type="button"
          :class="['audit-filter-chip', { on: filter === option.key }]"
          @click="emit('update:filter', option.key)"
        >{{ t(`episode.audit.filter.${option.key}`) }}</button>
        <span class="audit-filter-count">{{ issues.length }}</span>
      </div>
      <div v-if="!issues.length" class="step-empty task-drawer-empty">
        <div class="empty-visual">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
        </div>
        <div class="empty-title">
          {{ shotLabel ? t('episode.audit.panel.noIssuesForShot') : (job ? t('episode.audit.empty.clean') : t('episode.audit.cleanTitle')) }}
        </div>
        <div class="empty-desc">
          <template v-if="job?.semantic_status === 'skipped_no_model'">{{ t('episode.audit.empty.ruleOnly') }}</template>
          <template v-else-if="job?.semantic_status === 'disabled'">{{ t('episode.audit.empty.semanticDisabled') }}</template>
          <template v-else-if="!job">{{ t('episode.audit.empty.none') }}</template>
          <template v-else>{{ statusText }}</template>
        </div>
      </div>
      <div v-else class="task-drawer-body audit-issue-list">
        <section v-for="group in checkGroups" :key="group.check" class="audit-group">
          <div class="audit-group-head">
            <span class="audit-group-title">{{ t(`episode.audit.check.${group.check}`) }}</span>
            <span class="audit-group-count">{{ group.issues.length }}</span>
          </div>
          <article v-for="issue in group.issues" :key="issue.id" :class="['audit-issue', `is-${issue.severity}`]">
            <div class="audit-issue-head">
              <span class="audit-issue-severity">{{ t(`episode.audit.severity.${issue.severity}`) }}</span>
              <span v-if="issue.storyboardNumber" class="audit-issue-shot">S{{ issue.storyboardNumber }}</span>
              <span v-if="issue.fixed" class="audit-issue-fixed">{{ t('episode.audit.filter.fixed') }}</span>
              <span v-else-if="issue.manual" class="audit-issue-manual">{{ t('episode.audit.filter.manual') }}</span>
            </div>
            <p class="audit-issue-text">{{ issueText(issue) }}</p>
            <p v-if="issue.evidence" class="audit-issue-evidence">{{ issue.evidence }}</p>
            <p v-if="issue.suggestion" class="audit-issue-suggestion">{{ issue.suggestion }}</p>
            <div class="audit-issue-actions">
              <button v-if="issue.storyboardId" class="btn btn-sm" :title="t('episode.audit.panel.locateShot')" @click="emit('locate', issue)">
                {{ t('episode.audit.panel.locateShot') }}
              </button>
              <button v-if="issue.check === 2 && issue.suggestedTransition" class="btn btn-sm btn-primary" @click="emit('create-transition', issue)">
                {{ t('episode.audit.transition.title') }}
              </button>
              <button v-if="issue.check === 5" class="btn btn-sm" @click="emit('goto-assets')">
                {{ t('episode.prod.assets') }}
              </button>
            </div>
          </article>
        </section>
      </div>
      <div class="audit-repair-log">
        <div class="audit-group-head">
          <span class="audit-group-title">{{ t('episode.audit.panel.repairLog') }}</span>
          <span v-if="job?.fixed_count" class="audit-group-count">{{ job.fixed_count }}</span>
        </div>
        <div v-if="job?.repair_log?.length" class="audit-repair-list">
          <div v-for="(entry, i) in job.repair_log" :key="i" class="audit-repair-item">
            <span v-if="entry?.storyboardNumber" class="audit-issue-shot">S{{ entry.storyboardNumber }}</span>
            <span>{{ entry?.message || entry?.summary || entry?.action || entry?.code || entry }}</span>
          </div>
        </div>
        <p v-else class="dim audit-repair-empty">{{ t('episode.audit.panel.repairEmpty') }}</p>
      </div>
      <footer class="audit-drawer-foot">
        <button v-if="job?.can_undo" class="btn" :disabled="busy || running" :title="t('episode.audit.panel.undoTitle')" @click="emit('undo')">
          {{ busy ? t('episode.audit.panel.running') : t('episode.audit.undo') }}
        </button>
        <button class="btn" style="margin-left:auto" @click="emit('close')">{{ t('episode.audit.panel.close') }}</button>
      </footer>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Loader2, X } from 'lucide-vue-next'

defineProps<{
  open: boolean
  statusText: string
  job: any
  busy: boolean
  running: boolean
  progressPercent: number
  semanticNote: string
  shotLabel: string
  filter: string
  filterOptions: Array<{ key: string }>
  issues: any[]
  checkGroups: Array<{ check: number; issues: any[] }>
  canRun: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'run'): void
  (e: 'undo'): void
  (e: 'update:filter', value: string): void
  (e: 'show-all-shots'): void
  (e: 'locate', issue: any): void
  (e: 'create-transition', issue: any): void
  (e: 'goto-assets'): void
}>()

const { t, te } = useI18n()

function issueText(issue: any) {
  const key = `episode.audit.code.${issue?.code}`
  if (issue?.code && te(key)) return t(key)
  return issue?.message || issue?.suggestion || issue?.code || ''
}
</script>

<style scoped>
/* 共享抽屉骨架（与分集任务抽屉一致），随组件自包含 */
.task-drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 118;
  display: flex;
  justify-content: flex-end;
  background: var(--scrim);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  animation: fadeIn 0.18s var(--ease-out);
}
.task-drawer {
  width: min(560px, 100vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--panel-bg);
  border-left: 1px solid var(--panel-border);
  box-shadow: var(--shadow-xl);
  animation: taskDrawerIn 0.22s var(--ease-out);
}
@keyframes taskDrawerIn {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.task-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--surface-outline);
}
.task-drawer-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.task-drawer-metrics {
  padding: 10px 16px;
  border-bottom: 1px solid var(--surface-outline);
}
.task-drawer-body {
  flex: 1;
  overflow-y: auto;
}
.task-drawer-empty {
  flex: 1;
  justify-content: center;
}
.video-task-title {
  font-size: 13px;
  line-height: 1.2;
  font-weight: 850;
  color: var(--text-0);
}
.video-task-meta {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--text-3);
}
.video-task-metrics {
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}
.video-task-metric {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 22px;
  padding: 0 8px;
  border: 1px solid var(--surface-outline);
  border-radius: 999px;
  background: var(--overlay-track);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 750;
  white-space: nowrap;
}
.video-task-metric.is-done {
  color: var(--success);
  border-color: var(--success-bg);
  background: var(--success-bg);
}
.video-task-metric.is-pending {
  color: var(--accent-text);
  border-color: var(--accent-glow);
  background: var(--accent-bg);
}
.video-task-metric.is-failed {
  color: var(--warning);
  border-color: var(--warning-bg);
  background: var(--warning-bg);
}
.dim { color: var(--text-3); }
.audit-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--surface-outline);
}
.audit-progress-bar {
  flex: 1;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--surface-outline);
}
.audit-progress-bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.2s var(--ease-out);
}
.audit-stale-note,
.audit-error-note {
  margin: 0;
  padding: 8px 16px;
  border-bottom: 1px solid var(--surface-outline);
  font-size: 11px;
  color: var(--warning);
}
.audit-error-note { color: var(--error); }
.audit-semantic-note {
  margin: 0;
  padding: 8px 16px;
  border-bottom: 1px solid var(--surface-outline);
  font-size: 11px;
  color: var(--text-2);
}
.audit-shot-scope {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--surface-outline);
  font-size: 12px;
  color: var(--text-2);
}
.audit-filter-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-bottom: 1px solid var(--surface-outline);
}
.audit-filter-chip {
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
}
.audit-filter-chip:hover { color: var(--text-1); border-color: var(--border-strong); }
.audit-filter-chip.on { background: var(--accent-bg); color: var(--accent-text); border-color: var(--accent); }
.audit-filter-count { margin-left: auto; font-size: 11px; color: var(--text-3); }
.audit-issue-list {
  padding: 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.audit-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.audit-group-title { font-size: 12px; font-weight: 700; color: var(--text-1); }
.audit-group-count {
  min-width: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--surface-outline);
  color: var(--text-2);
  font-size: 10px;
  text-align: center;
}
.audit-issue {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--warning);
  border-radius: 8px;
  background: var(--surface-raised);
}
.audit-issue.is-error { border-left-color: var(--error); }
.audit-issue.is-warning { border-left-color: var(--warning); }
.audit-issue.is-info { border-left-color: var(--accent); }
.audit-issue-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
}
.audit-issue-severity { color: var(--warning); font-weight: 700; }
.audit-issue.is-error .audit-issue-severity { color: var(--error); }
.audit-issue.is-info .audit-issue-severity { color: var(--accent-text); }
.audit-issue-shot {
  padding: 0 5px;
  border-radius: 999px;
  background: var(--surface-outline);
  color: var(--text-2);
}
.audit-issue-fixed { color: var(--success); }
.audit-issue-manual { color: var(--text-3); }
.audit-issue-text { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-1); }
.audit-issue-evidence { margin: 0; font-size: 11px; line-height: 1.4; color: var(--text-3); }
.audit-issue-suggestion { margin: 0; font-size: 11px; line-height: 1.4; color: var(--text-2); }
.audit-issue-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.audit-repair-log {
  padding: 10px 16px 14px;
  border-top: 1px solid var(--surface-outline);
}
.audit-repair-list { display: flex; flex-direction: column; gap: 4px; }
.audit-repair-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
}
.audit-repair-empty { margin: 0; font-size: 11px; }
.audit-drawer-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--surface-outline);
}
@media (max-width: 1180px) {
  .task-drawer.audit-drawer { width: 100%; }
}
</style>
