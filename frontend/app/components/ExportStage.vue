<template>
  <div v-if="!episodeId" class="ex-empty">
    <FileOutput :size="28" />
    <p>{{ t('export.noEpisode') }}</p>
  </div>

  <div v-else class="ex-stage">
    <div class="ex-main">
      <section class="ex-card">
        <header class="ex-card-head">
          <div>
            <h3>{{ t('export.checkTitle') }}</h3>
            <p class="ex-hint">{{ t('export.checkHint') }}</p>
          </div>
          <button class="ex-btn is-ghost" type="button" :disabled="loading" @click="refresh">
            <RefreshCw :size="11" :class="{ 'animate-spin': loading }" />
            {{ t('export.refresh') }}
          </button>
        </header>
        <p v-if="error" class="ex-alert">{{ error }}</p>
        <ul v-if="checks" class="ex-checks">
          <li v-for="item in checkItems" :key="item.key" :class="['ex-check', { 'is-bad': !item.ok }]">
            <CheckCircle2 v-if="item.ok" :size="14" class="ex-check-icon is-ok" />
            <AlertCircle v-else :size="14" class="ex-check-icon is-bad" />
            <div class="ex-check-copy">
              <span class="ex-check-label">{{ item.label }}</span>
              <span class="ex-check-msg">{{ item.message }}</span>
            </div>
            <button
              v-if="!item.ok && item.action"
              class="ex-btn is-tiny"
              type="button"
              @click="emit('go-stage', item.action)"
            >
              {{ item.actionLabel }}
            </button>
          </li>
        </ul>
        <div v-else-if="loading" class="ex-loading">
          <Loader2 :size="14" class="animate-spin" />
          <span>{{ t('export.loading') }}</span>
        </div>
      </section>

      <section class="ex-card">
        <header class="ex-card-head">
          <div>
            <h3>{{ t('export.videoOptions') }}</h3>
            <p class="ex-hint">{{ t('export.presetHint') }} · {{ t('export.subtitleHint') }}</p>
          </div>
        </header>
        <div class="ex-fields">
          <label class="ex-field">
            <span class="ex-field-label">{{ t('export.presetTitle') }}</span>
            <BaseSelect :model-value="preset" :options="presetOptions" @update:model-value="setPreset" />
          </label>
          <label class="ex-field">
            <span class="ex-field-label">{{ t('export.subtitleMode') }}</span>
            <BaseSelect :model-value="subtitleMode" :options="subtitleOptions" @update:model-value="setSubtitleMode" />
          </label>
        </div>
      </section>

      <section class="ex-card">
        <header class="ex-card-head">
          <div>
            <h3>{{ t('export.actionsTitle') }}</h3>
            <p class="ex-hint">{{ t('export.reuseHint') }}</p>
          </div>
        </header>
        <ExportUnavailableNotice v-if="exportLocalOnly" />
        <div class="ex-start-grid">
          <button class="ex-start" type="button" :disabled="exportLocalOnly || !canStart || !checks?.mixReady" :title="exportLocalOnly ? t('export.gate.unavailable') : undefined" @click="start('mix')">
            <FileAudio :size="16" />
            <b>{{ t('export.exportMix') }}</b>
            <span>{{ t('export.mixHint') }}</span>
          </button>
          <button
            class="ex-start is-primary"
            type="button"
            :disabled="exportLocalOnly || !canStart || !checks?.videoReady || (subtitleMode !== 'none' && !checks?.subtitles.ok)"
            :title="exportLocalOnly ? t('export.gate.unavailable') : undefined"
            @click="start('video')"
          >
            <Film :size="16" />
            <b>{{ t('export.exportVideo') }}</b>
            <span>{{ t('export.videoHint') }}</span>
          </button>
          <button class="ex-start" type="button" :disabled="exportLocalOnly || !canStart || !checks?.stemsReady" :title="exportLocalOnly ? t('export.gate.unavailable') : undefined" @click="start('stems')">
            <Layers :size="16" />
            <b>{{ t('export.exportStems') }}</b>
            <span>{{ t('export.stemsHint') }}</span>
          </button>
        </div>
        <p v-if="lastReused" class="ex-hint">{{ t('export.reusedHint') }}</p>
        <p v-if="active" class="ex-hint">{{ t('export.activeHint') }}</p>
      </section>

      <section v-if="active" class="ex-card is-active">
        <header class="ex-card-head">
          <div>
            <h3>{{ t('export.progressTitle') }}</h3>
            <p class="ex-hint">{{ kindLabel(active.kind) }} · {{ presetLabel(active.preset) }}</p>
          </div>
          <span :class="['ex-chip', `is-${active.status || 'pending'}`]">{{ statusLabel(active.status) }}</span>
        </header>
        <div class="ex-progress">
          <div class="ex-bar"><span :style="{ width: `${active.progress || 0}%` }" /></div>
          <span class="ex-progress-val">{{ active.progress || 0 }}%</span>
          <button class="ex-btn is-tiny" type="button" @click="cancel(active.id)">{{ t('export.cancel') }}</button>
        </div>
        <p v-if="active.error" class="ex-alert">{{ active.error }}</p>
      </section>

      <section class="ex-card">
        <header class="ex-card-head">
          <div>
            <h3>{{ t('export.outputTitle') }}</h3>
            <p class="ex-hint">{{ t('export.outputHint') }}</p>
          </div>
          <span v-if="outputRecord?.isCurrent" class="ex-chip is-current">{{ t('export.current') }}</span>
        </header>
        <div v-if="outputRecord" class="ex-output">
          <div class="ex-output-main">
            <b>{{ presetLabel(outputRecord.preset) }}</b>
            <span class="ex-output-meta">
              {{ formatDuration(outputRecord.durationMs) }} · {{ formatSize(outputRecord.sizeBytes) }} · {{ formatLoudness(outputRecord) }}
            </span>
          </div>
          <div class="ex-row">
            <a class="ex-btn is-primary" :href="fileUrl(outputRecord.outputUrl)" target="_blank" rel="noreferrer">
              <Play :size="11" />
              {{ t('export.play') }}
            </a>
            <button
              v-if="isTablet && outputRecord.outputUrl && outputRecord.status === 'completed'"
              class="ex-btn"
              type="button"
              @click="shareRecord(outputRecord)"
            >
              {{ t('tablet.share.label') }}
            </button>
            <button
              v-if="!outputRecord.isCurrent"
              class="ex-btn"
              type="button"
              @click="setCurrent(outputRecord.id)"
            >
              {{ t('export.setCurrent') }}
            </button>
          </div>
          <p v-if="isTablet" class="ex-hint ex-save-hint">{{ t('tablet.share.saveHint') }}</p>
        </div>
        <p v-else class="ex-hint">{{ t('export.noOutput') }}</p>
      </section>
    </div>

    <aside class="ex-side">
      <header class="ex-side-head">
        <h3>{{ t('export.records') }}</h3>
        <span class="ex-count">{{ exports.length }}</span>
      </header>
      <p class="ex-hint">{{ t('export.recordsHint') }}</p>

      <div v-if="!exports.length" class="ex-empty-side">
        <FileOutput :size="22" />
        <span>{{ t('export.emptyRecords') }}</span>
      </div>

      <article
        v-for="record in exports"
        :key="record.id"
        :class="['ex-record', { 'is-current': record.isCurrent, 'is-dead': record.status === 'failed' || record.status === 'cancelled' }]"
      >
        <header class="ex-record-head">
          <span class="ex-kind">{{ kindLabel(record.kind) }}</span>
          <span :class="['ex-chip', `is-${record.status || 'pending'}`]">{{ statusLabel(record.status) }}</span>
          <span class="ex-record-time">{{ formatTime(record.createdAt) }}</span>
        </header>
        <div class="ex-record-meta">
          <span>{{ presetLabel(record.preset) }}</span>
          <span>{{ formatDuration(record.durationMs) }}</span>
          <span>{{ formatSize(record.sizeBytes) }}</span>
          <span>{{ formatLoudness(record) }}</span>
        </div>
        <p v-if="record.error" class="ex-alert">{{ record.error }}</p>
        <div class="ex-record-actions">
          <a
            v-if="record.outputUrl && (record.kind === 'video' || record.kind === 'stems')"
            class="ex-btn is-tiny"
            :href="fileUrl(record.outputUrl)"
            target="_blank"
            rel="noreferrer"
          >
            {{ record.kind === 'video' ? t('export.play') : t('export.download') }}
          </a>
          <button
            v-if="record.kind === 'mix' && record.outputUrl"
            class="ex-btn is-tiny"
            type="button"
            @click="playMix(record)"
          >
            {{ t('export.play') }}
          </button>
          <a
            v-if="record.kind === 'mix' && record.outputUrl"
            class="ex-btn is-tiny"
            :href="fileUrl(record.outputUrl)"
            download
          >
            {{ t('export.download') }}
          </a>
          <button
            v-if="isTablet && record.outputUrl && record.status === 'completed'"
            class="ex-btn is-tiny"
            type="button"
            @click="shareRecord(record)"
          >
            {{ t('tablet.share.label') }}
          </button>
          <button
            v-if="record.kind === 'video' && record.status === 'completed' && !record.isCurrent"
            class="ex-btn is-tiny"
            type="button"
            @click="setCurrent(record.id)"
          >
            {{ t('export.setCurrent') }}
          </button>
          <button
            v-if="record.status === 'failed' || record.status === 'cancelled'"
            class="ex-btn is-tiny"
            type="button"
            :disabled="exportLocalOnly"
            :title="exportLocalOnly ? t('export.gate.unavailable') : undefined"
            @click="retry(record.id)"
          >
            {{ t('export.retry') }}
          </button>
          <button
            v-if="record.status === 'pending' || record.status === 'running'"
            class="ex-btn is-tiny"
            type="button"
            @click="cancel(record.id)"
          >
            {{ t('export.cancel') }}
          </button>
          <button
            v-if="record.status !== 'pending' && record.status !== 'running'"
            class="ex-btn is-tiny is-danger"
            type="button"
            @click="remove(record.id)"
          >
            {{ t('export.remove') }}
          </button>
        </div>
      </article>

      <audio v-if="playingUrl" class="ex-audio" :src="playingUrl" controls autoplay />
    </aside>
  </div>
</template>

<script setup lang="ts">
import {
  AlertCircle,
  CheckCircle2,
  FileAudio,
  FileOutput,
  Film,
  Layers,
  Loader2,
  Play,
  RefreshCw,
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { ExportKind, ExportRecord, ExportStatus } from '~/composables/useApi'
import BaseSelect from '~/components/BaseSelect.vue'
import ExportUnavailableNotice from '~/components/ExportUnavailableNotice.vue'
import { useViewport } from '~/composables/useViewport'
import { useExportCapability } from '~/composables/useExportCapability'
import { shareNoticeKey, shareUrlOrFile } from '~/utils/export-share'

const props = defineProps<{
  episodeId: number | null
  dramaId: number
}>()

const emit = defineEmits<{
  'go-stage': [stage: string]
  changed: [hasOutput: boolean]
}>()

const { t } = useI18n()
const { isTablet } = useViewport()
const { localOnly: exportLocalOnly } = useExportCapability()

const {
  checks,
  exports,
  active,
  hasOutput,
  loading,
  starting,
  lastReused,
  error,
  preset,
  subtitleMode,
  setPreset,
  setSubtitleMode,
  start: startExport,
  cancel,
  retry: retryExport,
  setCurrent,
  remove: removeExport,
  refresh,
  stopPolling,
  dispose,
} = useExportSession({
  episodeId: () => props.episodeId,
  dramaId: () => props.dramaId,
})

/** 离线守卫：断网时不发起导出，直接提示需要连接服务器 */
function ensureOnline() {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return true
  toast.error(t('tablet.status.needServer'))
  return false
}

// 模板仍调用 start('mix') / retry(id)，这里包一层能力与离线守卫
function start(kind: ExportKind, overrides: Parameters<typeof startExport>[1] = {}) {
  if (exportLocalOnly.value) {
    toast.info(t('export.gate.hint'))
    return null
  }
  if (!ensureOnline()) return null
  return startExport(kind, overrides)
}

function retry(id: number) {
  if (exportLocalOnly.value) {
    toast.info(t('export.gate.hint'))
    return false
  }
  if (!ensureOnline()) return false
  return retryExport(id)
}

watch(
  () => props.episodeId,
  async (episodeId) => {
    playingUrl.value = ''
    if (episodeId) {
      await refresh()
      // hasOutput 值不变时 watch 不会触发，切换集后必须显式重发
      emit('changed', hasOutput.value)
    } else {
      stopPolling()
      emit('changed', false)
    }
  },
  { immediate: true },
)

watch(hasOutput, (value) => emit('changed', value), { immediate: true })

onBeforeUnmount(dispose)

const presetOptions = computed(() => [
  { value: 'vertical-hd', label: t('export.preset.verticalHd') },
  { value: 'horizontal-hd', label: t('export.preset.horizontalHd') },
  { value: 'vertical-high', label: t('export.preset.verticalHigh') },
])
const supportsBurn = computed(() => preset.value !== 'vertical-high')
const subtitleOptions = computed(() => [
  { value: 'soft', label: t('export.subtitle.soft') },
  ...(supportsBurn.value ? [{ value: 'burn', label: t('export.subtitle.burn') }] : []),
  { value: 'none', label: t('export.subtitle.none') },
])
watch([preset, subtitleMode], () => {
  if (!supportsBurn.value && subtitleMode.value === 'burn') setSubtitleMode('soft')
})

const canStart = computed(() => Boolean(props.episodeId)
  && !active.value
  && !loading.value
  && !starting.value
  && Boolean(checks.value?.ffmpeg.ok)
  && Boolean(checks.value?.disk.ok))

const checkItems = computed(() => {
  if (!checks.value) return []
  const items: { key: string; label: string; message: string; ok: boolean; action?: string; actionLabel?: string }[] = [
    {
      key: 'lines',
      label: t('export.checks.lines'),
      message: checks.value.lines.message,
      ok: checks.value.lines.ok,
      action: checks.value.lines.total > 0 && checks.value.lines.ready < checks.value.lines.total ? 'generate' : 'lines',
      actionLabel: checks.value.lines.total > 0 && checks.value.lines.ready < checks.value.lines.total
        ? t('export.goGenerate')
        : t('export.goLines'),
    },
    {
      key: 'video',
      label: t('export.checks.video'),
      message: checks.value.video.message,
      ok: checks.value.video.ok,
      action: 'videos',
      actionLabel: t('export.goVideos'),
    },
    {
      key: 'mix',
      label: t('export.checks.mix'),
      message: checks.value.mix.message,
      ok: checks.value.mix.ok,
      action: 'preview',
      actionLabel: t('export.goPreview'),
    },
    {
      key: 'subtitles',
      label: t('export.checks.subtitles'),
      message: checks.value.subtitles.message,
      ok: checks.value.subtitles.ok,
      action: 'generate',
      actionLabel: t('export.goGenerate'),
    },
    {
      key: 'ffmpeg',
      label: t('export.checks.ffmpeg'),
      message: checks.value.ffmpeg.message,
      ok: checks.value.ffmpeg.ok,
    },
    {
      key: 'disk',
      label: t('export.checks.disk'),
      message: checks.value.disk.message,
      ok: checks.value.disk.ok,
    },
  ]
  return items
})

const outputRecord = computed(() => {
  const videos = exports.value.filter((record) => (
    record.kind === 'video' && record.status === 'completed' && Boolean(record.outputUrl)
  ))
  return videos.find((record) => record.isCurrent) || videos[0] || null
})

const playingUrl = ref('')

function fileUrl(url: string | null) {
  if (!url) return ''
  return url.startsWith('http') || url.startsWith('/') ? url : `/${url}`
}

function playMix(record: ExportRecord) {
  playingUrl.value = fileUrl(record.outputUrl)
}

function fileNameFromUrl(url: string | null) {
  if (!url) return ''
  const path = url.split('?')[0].split('#')[0]
  return path.split('/').filter(Boolean).pop() || ''
}

/** 平板分享：文件 ≤100MB 用 File，尺寸未知或超限走链接；提示按结果类型区分 */
async function shareRecord(record: ExportRecord) {
  if (!record.outputUrl || !ensureOnline()) return
  const url = new URL(fileUrl(record.outputUrl), window.location.origin).toString()
  const outcome = await shareUrlOrFile({
    url,
    title: `${kindLabel(record.kind)} · ${presetLabel(record.preset)}`,
    sizeBytes: record.sizeBytes,
    fileName: fileNameFromUrl(record.outputUrl),
  })
  const key = shareNoticeKey(outcome)
  if (!key) return
  if (outcome === 'failed') toast.error(t(key))
  else toast.info(t(key))
}

function kindLabel(kind: ExportKind | null) {
  return t(`export.kind.${kind || 'mix'}`)
}

function presetLabel(key: string | null) {
  if (!key) return '—'
  const labelKey = `export.preset.${key.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())}`
  const label = t(labelKey)
  return label === labelKey ? key : label
}

function statusLabel(status: ExportStatus | null) {
  return t(`export.status.${status || 'pending'}`)
}

function formatDuration(ms: number | null) {
  if (ms == null || ms <= 0) return '—'
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatSize(bytes: number | null) {
  if (bytes == null || bytes <= 0) return '—'
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function formatLoudness(record: ExportRecord) {
  return record.lufs == null ? '—' : `${record.lufs.toFixed(1)} LUFS`
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function remove(id: number) {
  if (!window.confirm(t('export.confirmRemove'))) return
  await removeExport(id)
}
</script>

<style scoped>
.ex-stage {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 10px;
  overflow: hidden;
}
.ex-main {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 2px;
}
.ex-side {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-1);
}
.ex-card {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 11px 13px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-1);
}
.ex-card.is-active { border-color: var(--accent-glow); }
.ex-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ex-card-head h3 { margin: 0; font-size: 12.5px; font-weight: 700; color: var(--text-0); }
.ex-hint { margin: 0; font-size: 10.5px; line-height: 1.6; color: var(--text-3); }
.ex-alert { margin: 0; padding: 7px 9px; border-radius: 7px; background: var(--warning-bg); color: var(--action-danger); font-size: 10.5px; line-height: 1.55; word-break: break-word; }
.ex-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-0); color: var(--text-1); font: inherit; font-size: 10.5px; font-weight: 600;
  cursor: pointer; text-decoration: none; white-space: nowrap;
}
.ex-btn:hover { border-color: var(--accent); color: var(--accent-text); }
.ex-btn.is-primary { border-color: var(--accent); background: var(--accent); color: var(--action-primary-text); }
.ex-btn.is-primary:hover { background: var(--action-primary-hover); color: #fff; }
.ex-btn.is-ghost { border-color: transparent; background: transparent; color: var(--text-3); }
.ex-btn.is-tiny { height: 22px; padding: 0 7px; font-size: 10px; }
.ex-btn.is-danger:hover { border-color: var(--action-danger); color: var(--action-danger); background: var(--action-danger-bg); }
.ex-btn:disabled { opacity: .45; cursor: default; }
.ex-checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.ex-check {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border: 1px solid transparent; border-radius: 7px; background: var(--bg-2);
}
.ex-check.is-bad { border-color: var(--warning-bg); }
.ex-check-icon { flex: none; }
.ex-check-icon.is-ok { color: var(--success); }
.ex-check-icon.is-bad { color: var(--warning); }
.ex-check-copy { min-width: 0; display: flex; flex-direction: column; gap: 1px; flex: 1; }
.ex-check-label { font-size: 11px; font-weight: 650; color: var(--text-1); }
.ex-check-msg { font-size: 10px; color: var(--text-3); line-height: 1.45; word-break: break-word; }
.ex-loading { display: flex; align-items: center; gap: 7px; padding: 10px 0; font-size: 11px; color: var(--text-3); }
.ex-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 9px; }
.ex-field { display: flex; flex-direction: column; gap: 4px; }
.ex-field-label { font-size: 10.5px; color: var(--text-2); }
.ex-start-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 8px; }
.ex-start {
  display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
  padding: 10px 11px; border: 1px solid var(--border); border-radius: 9px;
  background: var(--bg-0); color: var(--text-2); font: inherit; text-align: left; cursor: pointer;
}
.ex-start:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-bg); }
.ex-start svg { color: var(--accent-text); }
.ex-start b { font-size: 11.5px; color: var(--text-0); }
.ex-start span { font-size: 10px; line-height: 1.45; color: var(--text-3); }
.ex-start.is-primary { border-color: var(--accent); background: var(--accent-bg); }
.ex-start:disabled { opacity: .5; cursor: default; }
.ex-progress { display: flex; align-items: center; gap: 8px; }
.ex-bar { flex: 1; height: 6px; border-radius: 3px; background: var(--overlay-track); overflow: hidden; }
.ex-bar span { display: block; height: 100%; background: var(--accent); transition: width .3s; }
.ex-progress-val { font-size: 10.5px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.ex-output { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ex-output-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ex-output-main b { font-size: 11.5px; color: var(--text-0); }
.ex-output-meta { font-size: 10px; color: var(--text-3); }
.ex-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ex-chip {
  padding: 0 6px; border: 1px solid var(--border); border-radius: 999px;
  font-size: 9px; line-height: 16px; color: var(--text-2); white-space: nowrap;
}
.ex-chip.is-pending, .ex-chip.is-running { border-color: var(--accent-glow); background: var(--accent-bg); color: var(--accent-text); }
.ex-chip.is-completed { border-color: transparent; background: var(--accent-bg); color: var(--success); }
.ex-chip.is-failed, .ex-chip.is-cancelled { border-color: transparent; background: var(--warning-bg); color: var(--action-danger); }
.ex-chip.is-current { border-color: var(--accent); background: var(--accent); color: var(--action-primary-text); }
.ex-side-head { display: flex; align-items: center; gap: 7px; }
.ex-side-head h3 { margin: 0; font-size: 12px; font-weight: 700; color: var(--text-0); }
.ex-count { padding: 0 6px; border-radius: 999px; background: var(--bg-2); color: var(--text-3); font-size: 9.5px; line-height: 16px; }
.ex-empty-side {
  flex: 1; min-height: 140px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; color: var(--text-3); font-size: 10.5px; text-align: center;
}
.ex-record {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px 9px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-0);
}
.ex-record.is-current { border-color: var(--accent-glow); }
.ex-record.is-dead { opacity: .82; }
.ex-record-head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.ex-kind { font-size: 10.5px; font-weight: 700; color: var(--text-1); }
.ex-record-time { margin-left: auto; font-size: 9.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.ex-record-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 9.5px; color: var(--text-3); }
.ex-record-actions { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ex-audio { width: 100%; height: 32px; }
.ex-empty {
  flex: 1; min-height: 240px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; color: var(--text-3); font-size: 12px;
}
@media (max-width: 1080px) {
  .ex-stage { grid-template-columns: minmax(0, 1fr); overflow-y: auto; }
  .ex-main, .ex-side { overflow: visible; }
}

/* 平板：分享/下载等动作至少 44px 命中区 */
@media (max-width: 1180px) {
  .ex-row .ex-btn,
  .ex-record-actions .ex-btn { min-height: 44px; }
  .ex-record-actions .ex-btn { padding: 0 10px; font-size: 10.5px; }
  .ex-save-hint { display: block; }
}
</style>
