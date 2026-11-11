<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Ellipsis, Loader2, Plus, Trash2 } from 'lucide-vue-next'

const props = defineProps<{
  rows: any[]
  filter: string
  allCount: number
  pendingCount: number
  doneCount: number
  failedCount: number
  busy: boolean
  adding: boolean
  batch: any
  batchProgress: number
  selectMode: boolean
  selectedIds: number[]
  selectedSbId: number | null
  deleting: boolean
  isCompact: boolean
  tabletPane: string
  isComfyVideoMode: boolean
  comfyPendingTaskId: number | null
  comfyRunning: boolean
  remoteReadonly: boolean
  comfyConfigName: string
  comfyUiGateway: boolean
  comfyPreview: any
  comfyUiLoading: boolean
  comfyUiUrl: string
  comfyUiError: string
  comfyPreviewError: string
  comfyUiFrameKey: number
}>()

const emit = defineEmits<{
  filter: [state: string]
  add: []
  'stop-batch': []
  'close-batch': []
  'select-all': []
  'select-missing': []
  'clear-selection': []
  'pointer-down': [event: PointerEvent, task: any]
  'context-menu': [event: MouseEvent, task: any]
  'row-click': [sb: any]
  generate: [sb: any]
  regenerate: [sb: any]
  'copy-diagnostics': [id: number]
  'open-audit': [id: number]
  delete: [sb: any]
  'open-menu': [event: MouseEvent, task: any]
  'mode-change': [mode: string]
  'run-comfy': []
  'reload-comfy': []
  'open-comfy': []
  'open-comfy-settings': []
}>()

const { t } = useI18n()

function isSelected(id: number) {
  return props.selectedIds.includes(id)
}
</script>

<template>
  <section
    class="video-task-list"
    :class="{ 'is-comfy': isComfyVideoMode }"
    data-tablet-pane="shots"
    :role="isCompact ? 'tabpanel' : undefined"
    :aria-labelledby="isCompact ? 'video-tab-shots' : undefined"
    :id="isCompact ? 'video-panel-shots' : undefined"
    v-show="!isCompact || isComfyVideoMode || tabletPane === 'shots'"
  >
    <div class="video-task-head">
      <div>
        <div class="video-task-title">{{ t('episode.vid.listTitle') }}</div>
        <div class="video-task-meta">{{ filter ? t('episode.vid.listMetaFiltered', { n: rows.length, total: allCount }) : t('episode.vid.listMeta', { n: rows.length }) }}</div>
      </div>
      <div class="video-task-metrics">
        <button type="button" class="video-task-metric is-pending" :class="{ on: filter === 'pending' }" @click="emit('filter', 'pending')">{{ t('episode.vid.metricPending', { n: pendingCount }) }}</button>
        <button type="button" class="video-task-metric is-done" :class="{ on: filter === 'done' }" @click="emit('filter', 'done')">{{ t('episode.vid.metricDone', { n: doneCount }) }}</button>
        <button type="button" class="video-task-metric is-failed" :class="{ on: filter === 'failed' }" @click="emit('filter', 'failed')">{{ t('episode.vid.metricFailed', { n: failedCount }) }}</button>
      </div>
      <button class="btn btn-sm" :disabled="busy || adding" @click="emit('add')">
        <Loader2 v-if="adding" :size="11" class="animate-spin" />
        <Plus v-else :size="11" />
        {{ t('episode.vid.addShot') }}
      </button>
    </div>
    <div v-if="batch" class="video-batch-strip" :class="'is-' + batch.status">
      <div class="video-batch-strip-top">
        <span class="video-batch-strip-title">
          {{ batch.status === 'running'
            ? t('episode.vid.batchRunning', { done: batch.completed + batch.failed + batch.stopped, total: batch.total })
            : t('episode.vid.batchDone', { completed: batch.completed, failed: batch.failed }) }}
        </span>
        <span class="video-batch-strip-counts">
          {{ t('episode.vid.batchCounts', { processing: batch.processing, queued: batch.queued, completed: batch.completed, failed: batch.failed }) }}
        </span>
        <button v-if="batch.status === 'running'" type="button" class="btn btn-sm video-batch-stop" @click="emit('stop-batch')">
          {{ t('episode.vid.batchStop') }}
        </button>
        <button v-else type="button" class="btn btn-sm btn-ghost" @click="emit('close-batch')">
          {{ t('common.close') }}
        </button>
      </div>
      <div class="video-batch-progress">
        <div class="video-batch-progress-fill" :style="{ width: batchProgress + '%' }"></div>
      </div>
      <p v-if="batch.status === 'stopped'" class="video-batch-strip-note">{{ t('episode.vid.batchStopped') }}</p>
      <p v-else-if="batch.failed > 0" class="video-batch-strip-note">{{ t('episode.vid.batchFailedNote') }}</p>
    </div>
    <div v-if="selectMode" class="shot-quick-actions video-quick-actions">
      <button class="shot-quick-btn" @click="emit('select-all')">{{ t('episode.sb.selectAll') }}</button>
      <button class="shot-quick-btn" @click="emit('select-missing')">{{ t('episode.vid.selectMissing') }}</button>
      <button class="shot-quick-btn" @click="emit('clear-selection')">{{ t('episode.sb.clear') }}</button>
    </div>
    <div class="video-task-table">
      <div
        v-for="task in rows"
        :key="task.id"
        :data-sb-id="task.storyboard.id"
        :class="['video-task-row', 'is-' + task.state, { active: !selectMode && selectedSbId === task.storyboard.id, 'is-selected': selectMode && isSelected(task.id) }]"
        role="button"
        tabindex="0"
        data-long-press
        @pointerdown="emit('pointer-down', $event, task)"
        @contextmenu="emit('context-menu', $event, task)"
        @click="emit('row-click', task.storyboard)"
        @keydown.enter.prevent="emit('row-click', task.storyboard)"
        @keydown.space.prevent="emit('row-click', task.storyboard)"
      >
        <div class="video-task-preview">
          <span
            v-if="selectMode"
            class="shot-check video-task-check"
            :class="{ on: isSelected(task.id) }"
          >
            <svg v-if="isSelected(task.id)" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </span>
          <video
            v-if="task.hasVideo"
            :src="task.videoSrc"
            :poster="task.poster || undefined"
            preload="none"
            playsinline
            webkit-playsinline
            muted
            tabindex="-1"
          />
          <div v-else class="video-task-empty">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          </div>
          <span class="video-task-index">#{{ String(task.index + 1).padStart(2, '0') }}</span>
        </div>
        <div class="video-task-main">
          <div class="video-task-line">
            <strong class="video-task-name">{{ task.title }}</strong>
            <span v-if="task.transitionKind" class="video-task-transition-tag">{{ task.transitionLabel }}</span>
          </div>
          <div class="video-task-meta-line">
            <span :class="['video-task-state', 'is-' + task.state]">
              <i :class="['dot', task.state === 'done' && 'ok', task.state === 'pending' && 'pending']" />{{ task.statusLabel }}
            </span>
            <span class="video-task-sep">·</span>
            <span>{{ task.duration }}s</span>
            <template v-if="task.meta">
              <span class="video-task-sep">·</span>
              <span class="video-task-loc truncate">{{ task.meta }}</span>
            </template>
          </div>
          <div v-if="task.error" class="video-task-error" :title="task.error">
            {{ task.errorLabel }}
            <div class="flex gap-2">
              <button class="btn btn-sm" @click.stop="emit('copy-diagnostics', task.id)">{{ t('episode.recovery.diagnostics') }}</button>
              <button v-if="task.recoverable" class="btn btn-sm" @click.stop="emit('regenerate', task.storyboard)">{{ t('episode.recovery.newGeneration') }}</button>
            </div>
            <div v-if="task.moderationHint" class="video-task-error-hint">{{ task.moderationHint }}</div>
          </div>
        </div>
        <div class="video-task-actions">
          <button
            v-if="!isComfyVideoMode"
            class="btn btn-icon btn-sm video-task-action"
            :title="task.actionLabel"
            :disabled="task.state === 'pending'"
            @click.stop="emit('generate', task.storyboard)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          </button>
          <button
            v-if="task.auditVisible"
            type="button"
            class="btn btn-icon btn-sm video-task-audit"
            :class="task.auditClass"
            :title="task.auditTitle"
            :aria-label="task.auditTitle"
            @click.stop="emit('open-audit', task.storyboard.id)"
          >
            <Loader2 v-if="task.auditStatus === 'running'" :size="12" class="animate-spin" />
            <svg v-else-if="task.auditStatus === 'done' || task.auditStatus === 'ruleOnly'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <svg v-else-if="task.auditStatus === 'failed'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="7" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12" y2="16.6"/></svg>
            <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            <span v-if="task.auditBadge" class="video-task-audit-badge">{{ task.auditBadge }}</span>
            <span v-if="task.auditStale" class="video-task-audit-stale" aria-hidden="true" />
          </button>
          <button
            v-if="!selectMode"
            type="button"
            class="btn btn-icon btn-sm video-task-delete"
            :title="t('episode.vid.deleteShot')"
            :aria-label="t('episode.vid.deleteShot')"
            :disabled="busy || deleting"
            @click.stop="emit('delete', task.storyboard)"
          >
            <Trash2 :size="12" />
          </button>
          <button
            v-if="!selectMode"
            type="button"
            class="btn btn-icon btn-sm video-task-more"
            :title="t('tablet.more')"
            :aria-label="t('tablet.more')"
            @pointerdown.stop
            @click.stop="emit('open-menu', $event, task)"
          >
            <Ellipsis :size="12" />
          </button>
        </div>
      </div>
    </div>
    <div v-if="isComfyVideoMode" class="video-task-footer">
      <div v-if="comfyPendingTaskId" class="video-task-footer-status">
        <span class="dot pending" />
        <span>{{ t('episode.comfy.liveRunning', { id: comfyPendingTaskId }) }}</span>
      </div>
      <div class="video-task-footer-actions">
        <button type="button" class="btn" @click="emit('mode-change', 'native')">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          {{ t('episode.comfy.editNative') }}
        </button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="comfyRunning || !!comfyPendingTaskId || remoteReadonly"
          :title="remoteReadonly ? t('remote.readonly.notice') : undefined"
          @click="emit('run-comfy')"
        >
          <Loader2 v-if="comfyRunning" :size="11" class="animate-spin" />
          <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          {{ comfyPendingTaskId ? t('episode.comfy.running') : t('episode.comfy.submit') }}
        </button>
      </div>
    </div>
  </section>

  <section v-if="isComfyVideoMode" class="comfy-embed-stage">
    <div class="comfy-embed-head">
      <div class="comfy-embed-heading">
        <div class="comfy-embed-title">{{ t('episode.comfy.monitorTitle') }}</div>
        <div class="comfy-embed-sub">
          {{ comfyConfigName }}<span v-if="comfyUiGateway"> · {{ t('episode.comfy.viaGateway') }}</span>
        </div>
      </div>
      <div v-if="comfyPreview" class="comfy-embed-metrics">
        <span><b>{{ comfyPreview.timeline.segments.length }}</b>{{ t('episode.comfy.segments') }}</span>
        <span><b>{{ comfyPreview.timeline.totalFrames }}</b>{{ t('episode.comfy.frames') }}</span>
        <span><b>{{ comfyPreview.timeline.durationSec }}s</b></span>
        <span><b>{{ comfyPreview.mapping.width }}×{{ comfyPreview.mapping.height }}</b></span>
      </div>
      <span :class="['comfy-embed-live', { running: !!comfyPendingTaskId }]">
        <i class="dot" />
        {{ comfyPendingTaskId ? t('episode.comfy.liveRunning', { id: comfyPendingTaskId }) : t('episode.comfy.liveIdle') }}
      </span>
      <div class="comfy-embed-actions">
        <button type="button" class="btn btn-sm" :disabled="comfyUiLoading" @click="emit('reload-comfy')">
          <Loader2 v-if="comfyUiLoading" :size="11" class="animate-spin" />
          <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          {{ t('common.refresh') }}
        </button>
        <button type="button" class="btn btn-sm" :disabled="!comfyUiUrl" @click="emit('open-comfy')">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          {{ t('episode.comfy.open') }}
        </button>
      </div>
    </div>
    <div v-if="comfyPreviewError" class="comfy-embed-notice is-warning">
      <span>{{ comfyPreviewError }}</span>
      <button type="button" class="btn btn-sm" @click="emit('open-comfy-settings')">{{ t('episode.comfy.openSettings') }}</button>
    </div>
    <div v-else-if="comfyPreview && comfyPreview.warnings.length" class="comfy-embed-notice is-warning">
      <span v-for="(warning, wi) in comfyPreview.warnings" :key="wi">· {{ warning }}</span>
    </div>
    <div class="comfy-embed-body">
      <div v-if="comfyUiLoading && !comfyUiUrl" class="comfy-embed-state">
        <Loader2 :size="20" class="animate-spin" />
        <span>{{ t('episode.comfy.monitorLoading') }}</span>
      </div>
      <div v-else-if="comfyUiError" class="comfy-embed-state is-error">
        <div>{{ comfyUiError }}</div>
        <div class="comfy-embed-state-actions">
          <button type="button" class="btn btn-sm" @click="emit('reload-comfy')">{{ t('episode.comfy.retry') }}</button>
          <button type="button" class="btn btn-sm" @click="emit('open-comfy-settings')">{{ t('episode.comfy.openSettings') }}</button>
        </div>
      </div>
      <iframe
        v-else-if="comfyUiUrl"
        :key="comfyUiFrameKey"
        :src="comfyUiUrl"
        class="comfy-embed-frame"
        allow="clipboard-read; clipboard-write; fullscreen"
        referrerpolicy="no-referrer"
        allowfullscreen
      />
      <div v-else class="comfy-embed-state">{{ t('episode.comfy.noPreview') }}</div>
    </div>
    <div class="comfy-embed-foot">{{ t('episode.comfy.monitorReadonly') }}</div>
  </section>
</template>

<style scoped>
.video-task-list {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border: 0;
  border-radius: 0;
  background: var(--surface-raised);
}
.video-task-head {
  min-height: 48px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--surface-outline);
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
.video-task-metric,
.video-task-status {
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
.video-task-metric.is-done,
.video-task-status.is-done {
  color: var(--success);
  border-color: var(--success-bg);
  background: var(--success-bg);
}
.video-task-metric.is-pending,
.video-task-status.is-pending,
.video-task-status.is-ready {
  color: var(--accent-text);
  border-color: var(--accent-glow);
  background: var(--accent-bg);
}
.video-task-metric.is-failed,
.video-task-status.is-failed,
.video-task-status.is-blocked {
  color: var(--warning);
  border-color: var(--warning-bg);
  background: var(--warning-bg);
}
.video-task-table {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
/* 统计徽章兼作筛选器 */
button.video-task-metric { cursor: pointer; font-family: inherit; transition: box-shadow 0.15s; }
button.video-task-metric:hover { box-shadow: 0 0 0 2px var(--sel-glow); }
button.video-task-metric.on { box-shadow: 0 0 0 2px var(--accent); }
.video-task-row.is-selected { background: var(--sel-bg); box-shadow: inset 0 0 0 1.5px var(--sel); }
.video-task-check {
  position: absolute;
  top: 5px;
  right: 5px;
  z-index: 2;
  background: rgba(0,0,0,0.45);
  border-color: rgba(255,255,255,0.55);
}
.video-task-check.on { background: var(--accent); border-color: var(--accent); }
.shot-check {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1.5px solid var(--surface-outline-strong);
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--on-accent);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.shot-check:hover { border-color: var(--accent); }
.shot-check.on { background: var(--accent); border-color: var(--accent); }
.video-task-row {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-top: 1px solid var(--surface-outline);
  transition: background 0.16s var(--ease-out), border-color 0.16s var(--ease-out);
  cursor: pointer;
}
.video-task-row:first-child {
  border-top: 0;
}
.video-task-row:hover,
.video-task-row.is-pending {
  background: var(--bg-hover);
}
.video-task-row.is-failed {
  background: var(--error-bg);
}
.video-task-row.active {
  background: var(--sel-bg);
  box-shadow: inset 0 0 0 1.5px var(--sel), 0 0 0 3px var(--sel-glow);
}
.video-task-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.video-task-preview {
  position: relative;
  width: 56px;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
}
.video-task-preview video,
.video-task-preview img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.video-task-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.video-task-index {
  position: absolute;
  left: 3px;
  top: 3px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(0,0,0,0.56);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 800;
}
.video-task-main {
  min-width: 0;
}
.video-task-line {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.video-task-name {
  min-width: 0;
  font-size: 12px;
  line-height: 1.35;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.video-task-transition-tag {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-bg);
  color: var(--accent);
  font-size: 10px;
  line-height: 1.5;
  white-space: nowrap;
}
.video-task-meta-line {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-3);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
}
.video-task-loc {
  color: var(--text-2);
}
.video-task-sep { color: var(--text-3); opacity: 0.5; }
.video-task-error {
  margin-top: 5px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--error);
}
.video-task-error-hint {
  margin-top: 3px;
  color: var(--accent-text, var(--accent));
  font-weight: 600;
}
.video-task-status {
  justify-self: end;
  align-self: center;
}
/* 行内紧凑状态（窄列表用）：小圆点 + 文字 */
.video-task-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  white-space: nowrap;
}
.video-task-state.is-done { color: var(--success); }
.video-task-state.is-pending { color: var(--accent-text); }
.video-task-state.is-failed { color: var(--warning); }
.video-task-actions {
  justify-self: end;
  align-self: center;
  display: flex;
  align-items: center;
  gap: 4px;
}
.video-task-action {
  justify-self: end;
  align-self: center;
  min-width: 0;
  width: 24px;
  height: 24px;
  padding: 0;
}
.video-task-delete {
  justify-self: end;
  align-self: center;
  min-width: 0;
  width: 24px;
  height: 24px;
  padding: 0;
  opacity: 0;
  transition: opacity 0.15s var(--ease-out), color 0.15s var(--ease-out);
}
.video-task-row:hover .video-task-delete,
.video-task-delete:focus-visible { opacity: 1; }
.video-task-delete:hover { color: var(--error); }
.video-task-audit {
  justify-self: end;
  align-self: center;
  min-width: 28px;
  min-height: 28px;
  width: 28px;
  height: 28px;
  padding: 0;
  position: relative;
}
.audit-shot-pending { color: var(--text-3); }
.audit-shot-running { color: var(--accent-text); }
.audit-shot-done { color: var(--success); }
.audit-shot-failed { color: var(--warning); }
.audit-shot-ruleOnly { color: var(--accent-text); }
.audit-shot-stale { color: var(--warning); }
.video-task-audit-badge {
  position: absolute;
  top: -3px;
  right: -5px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border-radius: 999px;
  background: var(--warning);
  color: #fff;
  font-size: 8px;
  line-height: 13px;
  font-weight: 700;
  text-align: center;
}
.video-task-audit-stale {
  position: absolute;
  bottom: 1px;
  right: 1px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--warning);
}
.video-task-more {
  justify-self: end;
  align-self: center;
  min-width: 0;
  width: 24px;
  height: 24px;
  padding: 0;
  display: none;
}
.video-task-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-top: 1px solid var(--surface-outline);
  background: var(--surface-raised);
}
.video-task-footer-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
}
.video-task-footer-actions { display: flex; gap: 6px; }
.video-task-footer-actions .btn { flex: 1; justify-content: center; min-height: 28px; }
.video-batch-strip {
  margin: 8px 12px;
  padding: 8px 10px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.video-batch-strip-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.video-batch-strip-title { font-size: 12px; font-weight: 600; color: var(--text-0); }
.video-batch-strip-counts { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.video-batch-stop { margin-left: auto; }
.video-batch-progress { height: 4px; border-radius: 2px; background: var(--sel-bg); overflow: hidden; }
.video-batch-progress-fill { height: 100%; border-radius: 2px; background: var(--accent); transition: width 0.3s ease; }
.video-batch-strip.is-stopped .video-batch-progress-fill { background: var(--text-3); }
.video-batch-strip.is-done .video-batch-progress-fill { background: var(--success, var(--accent)); }
.video-batch-strip-note { margin: 0; font-size: 11px; color: var(--text-3); line-height: 1.5; }
.video-quick-actions { margin: 0 12px 10px; padding-top: 0; border-top: none; }
.shot-quick-btn {
  flex-shrink: 0;
  min-height: 24px;
  padding: 0 8px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
}
.shot-quick-btn:hover { text-decoration: underline; }
.shot-quick-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0 12px 10px;
  padding-top: 8px;
  border-top: 1px solid var(--surface-outline);
}
.shot-quick-actions .shot-quick-btn {
  min-height: 28px;
  padding: 0 10px;
  background: var(--surface-raised);
}
.shot-quick-actions .shot-quick-btn:hover { background: var(--bg-hover); }
@media (max-width: 1080px) {
  .video-task-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .video-task-metrics {
    width: 100%;
    margin-left: 0;
    justify-content: flex-start;
  }
  .video-task-row {
    grid-template-columns: 56px minmax(0, 1fr) auto;
  }
}
@media (max-width: 720px) {
  .video-batch-strip { margin: 0 8px 8px; }
  .video-batch-strip-counts { width: 100%; }
}
@media (hover: none) and (pointer: coarse) {
  .video-task-row { grid-template-columns: 56px minmax(0, 1fr) auto; }
  .video-task-actions { gap: 6px; }
  .video-task-more {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    min-width: 44px;
  }
  .video-task-action,
  .video-task-delete {
    width: 44px;
    height: 44px;
    min-width: 44px;
    opacity: 1;
  }
}
@media (max-width: 900px) {
  /* 紧凑 ComfyUI：列表定高内部滚动，保证左下角「修改/提交」可达 */
  .video-task-list.is-comfy {
    height: clamp(180px, 42vh, 420px);
  }
  /* 窄屏：ComfyUI 监控页纵向堆叠，保留可操作的页面高度 */
  .comfy-embed-stage {
    min-height: 72vh;
    border-top: 1px solid var(--surface-outline);
    border-left: 0;
  }
}
@media (max-width: 1180px) and (hover: none) and (pointer: coarse) {
  .video-task-row {
    min-height: 48px;
    grid-template-columns: 96px minmax(0, 1fr) auto;
  }
  .video-task-preview {
    width: 96px;
    height: 54px;
    aspect-ratio: auto;
  }
  .video-task-action,
  .video-task-more {
    min-width: 44px;
    min-height: 44px;
    width: 44px;
    height: 44px;
  }
  .video-task-delete { display: none; }
}
</style>
