<template>
  <div v-if="open" class="task-drawer-overlay" @click.self="emit('close')">
    <aside class="task-drawer" role="dialog" aria-modal="true" :aria-label="t('episode.tasks.centerTitle')">
      <header class="task-drawer-head">
        <div>
          <div class="video-task-title">{{ t('episode.tasks.centerTitle') }}</div>
          <div class="video-task-meta">{{ t('episode.tasks.metaCenter', { n: total, active: activeCount }) }}</div>
        </div>
        <div class="task-drawer-head-actions">
          <button class="btn btn-sm" :disabled="!clearableCount || clearing" @click="emit('clear')">
            <Trash2 :size="12" />
            {{ t('episode.tasks.clear') }}
          </button>
          <button class="btn btn-sm" @click="emit('refresh')">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            {{ t('common.refresh') }}
          </button>
          <button class="btn btn-ghost btn-icon" @click="emit('close')"><X :size="14" /></button>
        </div>
      </header>
      <div class="video-task-metrics task-drawer-metrics">
        <span class="video-task-metric is-pending">{{ t('episode.vid.metricPending', { n: activeCount }) }}</span>
        <span class="video-task-metric is-done">{{ t('episode.vid.metricDone', { n: doneCount }) }}</span>
        <span class="video-task-metric is-failed">{{ t('episode.vid.metricFailed', { n: failedCount }) }}</span>
      </div>
      <div class="task-center-tabs" role="tablist" :aria-label="t('episode.tasks.centerTitle')">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.key"
          :class="['task-center-tab', { on: activeTab === tab.key }]"
          @click="emit('update:tab', tab.key)"
        >
          <span>{{ tab.label }}</span>
          <span v-if="tab.count" class="task-center-tab-count">{{ tab.count }}</span>
          <span v-if="tab.active" class="task-center-tab-active" :title="t('episode.tasks.activeHint')">{{ tab.active }}</span>
        </button>
      </div>
      <div v-if="!rows.length" class="step-empty task-drawer-empty">
        <div class="empty-visual">
          <ListTodo :size="32" />
        </div>
        <div class="empty-title">{{ t('episode.tasks.emptyTitle') }}</div>
        <div class="empty-desc">{{ t('episode.tasks.emptyDesc') }}</div>
      </div>
      <div v-else class="video-task-table task-drawer-body">
        <div
          v-for="row in rows"
          :key="row.key"
          :class="['video-task-row', 'gen-task-row', 'is-' + row.statusClass]"
        >
          <div :class="['video-task-preview', { 'is-audio': row.previewType === 'audio' }]">
            <video
              v-if="row.previewType === 'video' && row.previewUrl"
              :src="previewSrc(row.previewUrl)"
              :poster="posterOf(previewSrc(row.previewUrl)) || undefined"
              controls
              preload="none"
              playsinline
              webkit-playsinline
            />
            <audio
              v-else-if="row.previewType === 'audio' && row.previewUrl"
              :src="previewSrc(row.previewUrl)"
              controls
              preload="none"
            />
            <img
              v-else-if="row.previewType === 'image' && row.previewUrl"
              :src="thumbOf(previewSrc(row.previewUrl))"
              :alt="row.targetLabel"
              loading="lazy"
              @error="thumbFallback($event, previewSrc(row.previewUrl))"
              @click="emit('view-image', previewSrc(row.previewUrl), row.targetLabel)"
            />
            <div v-else class="video-task-empty">
              <Loader2 v-if="row.statusClass === 'pending'" :size="18" class="animate-spin" />
              <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
            </div>
            <span class="video-task-index">{{ kindLabel(row.kind, row.transitionId) }}</span>
          </div>
          <div class="video-task-main">
            <div class="video-task-line">
              <strong class="video-task-name truncate">{{ row.targetLabel }}</strong>
            </div>
            <div class="video-task-meta-line">
              <span class="video-task-loc truncate">{{ row.providerLabel }}</span>
              <template v-if="duration(row)">
                <span class="video-task-sep">·</span>
                <span>{{ t('episode.tasks.duration', { dur: duration(row) }) }}</span>
              </template>
              <template v-if="typeof row.id === 'number'">
                <span class="video-task-sep">·</span>
                <span>#{{ row.id }}</span>
              </template>
            </div>
            <div v-if="row.detail" class="video-task-detail truncate" :title="row.detail">{{ row.detail }}</div>
            <div v-if="row.errorMsg" class="video-task-error" :title="row.errorMsg">
              {{ errorText(row.errorMsg) }}
              <div v-if="row.kind === 'video'" class="flex gap-2">
                <button v-if="row.recoverable" class="btn btn-sm" @click.stop="emit('recover', row.id, row.storyboardId)">{{ t('episode.recovery.restore') }}</button>
                <button class="btn btn-sm" @click.stop="emit('diagnostics', row.id)">{{ t('episode.recovery.diagnostics') }}</button>
              </div>
              <div v-if="row.kind === 'video' && moderationHint(row.errorMsg)" class="video-task-error-hint">{{ moderationHint(row.errorMsg) }}</div>
            </div>
          </div>
          <span :class="['video-task-status', 'is-' + row.statusClass]">
            <span :class="['dot', row.statusClass === 'done' && 'ok', row.statusClass === 'pending' && 'pending']" />
            {{ row.statusLabel }}
          </span>
        </div>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ListTodo, Loader2, Trash2, X } from 'lucide-vue-next'
import { MODERATION_RE, mapError } from '~/composables/useToast'
import { posterOf, thumbFallback, thumbOf } from '~/composables/useMedia'

defineProps<{
  open: boolean
  rows: any[]
  total: number
  activeCount: number
  doneCount: number
  failedCount: number
  clearableCount: number
  clearing: boolean
  tabs: Array<{ key: string; label: string; count?: number; active?: number }>
  activeTab: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'refresh'): void
  (e: 'clear'): void
  (e: 'update:tab', value: string): void
  (e: 'recover', taskId: number, storyboardId: number): void
  (e: 'diagnostics', taskId: number): void
  (e: 'view-image', src: string, title: string): void
}>()

const { t } = useI18n()

function kindLabel(kind: string, transitionId: number | null = null) {
  if (transitionId) return t('episode.tasks.transitionKind')
  if (kind === 'storyboard_audit') return t('episode.tasks.runStoryboardAudit')
  if (kind === 'image') return t('common.serviceType.image')
  if (kind === 'video') return t('common.serviceType.video')
  if (kind === 'audio') return t('episode.tasks.kindAudio')
  if (kind === 'text') return t('episode.tasks.kindText')
  if (kind === 'merge') return t('episode.tasks.mergeKind')
  if (kind === 'voice') return t('episode.tasks.kindVoice')
  if (kind === 'pipeline') return t('episode.tasks.kindPipeline')
  if (kind === 'export') return t('episode.tasks.kindExport')
  return t('episode.tasks.kindOther')
}

function previewSrc(url: string) {
  if (!url) return ''
  return /^https?:\/\//.test(url) ? url : '/' + url
}

function duration(row: any) {
  if (!row.createdAt || !row.completedAt) return ''
  const ms = new Date(row.completedAt).getTime() - new Date(row.createdAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  return ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`
}

function errorText(message: string) {
  return mapError(message)
}

function moderationHint(message: string) {
  return MODERATION_RE.test(String(message || '')) ? t('episode.vid.moderationHint') : ''
}
</script>

<style scoped>
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
.task-center-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--surface-outline);
  overflow-x: auto;
}
.task-center-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--text-3);
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.task-center-tab:hover {
  background: var(--surface-soft);
  color: var(--text-1);
}
.task-center-tab.on {
  background: var(--accent-bg);
  border-color: var(--surface-outline-strong);
  color: var(--text-1);
}
.task-center-tab-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.72;
}
.task-center-tab-active {
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 10px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.video-task-table {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
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
.gen-task-row {
  grid-template-columns: 84px minmax(0, 1fr) auto;
  cursor: default;
}
.gen-task-row .video-task-preview img {
  cursor: zoom-in;
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
.video-task-detail {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-3);
}
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
.video-task-preview.is-audio {
  display: flex;
  align-items: center;
  justify-content: center;
}
.video-task-preview.is-audio audio {
  width: 100%;
  height: 28px;
}
@media (hover: none) and (pointer: coarse) {
  .gen-task-row { grid-template-columns: 56px minmax(0, 1fr) auto; }
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
}
</style>
