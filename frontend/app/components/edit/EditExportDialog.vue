<template>
  <Teleport to="body">
    <div v-if="open" class="ed-export-mask" @click.self="close()">
      <section class="ed-export" role="dialog" :aria-label="t('edit.exportTitle')">
        <header>
          <b>{{ t('edit.exportTitle') }}</b>
          <button type="button" class="ed-close" @click="close()">×</button>
        </header>

        <section v-if="completed" class="ed-done">
          <b>{{ t('edit.exportDoneTitle') }}</b>
          <p v-if="doneFileName" class="ed-done-name">{{ doneFileName }}</p>
          <div class="ed-done-stats">
            <span>{{ t('edit.exportDoneDuration') }} {{ formatDuration(doneStatus?.duration_ms) }}</span>
            <span>{{ t('edit.exportDoneSize') }} {{ formatSize(doneStatus?.size_bytes) }}</span>
            <span v-if="doneStatus?.finished_at">{{ t('edit.exportDoneAt') }} {{ formatDateTime(doneStatus.finished_at) }}</span>
          </div>
          <p v-if="doneStatus?.error" class="ed-done-warning">{{ doneStatus.error }}</p>
          <div class="ed-done-actions">
            <button type="button" :disabled="!doneOutputUrl" @click="openDoneFilm">{{ t('edit.exportOpenFilm') }}</button>
            <button type="button" @click="goDelivery">{{ t('edit.exportViewDelivery') }}</button>
            <button type="button" :disabled="!doneOutputUrl" @click="copyDonePath">
              {{ copyHint || t('edit.exportCopyPath') }}
            </button>
          </div>
        </section>

        <template v-if="!completed">
        <section v-if="blocking.length" class="ed-blocked-list">
          <b>{{ t('edit.exportBlocked.title') }}</b>
          <p v-for="item in blocking" :key="`${item.code}:${item.path}`">
            {{ t(item.i18nKey) }}<span class="ed-blocked-path">{{ item.path }}</span>
          </p>
          <p class="ed-blocked-bottom">{{ t('edit.exportBlocked.bottom') }}</p>
        </section>

        <section v-if="warnings.length" class="ed-warn-list">
          <b>{{ t('edit.exportWarningTitle') }}</b>
          <p v-for="w in warnings" :key="w.code">{{ t(w.i18nKey) }}</p>
          <label class="ed-ack">
            <input v-model="warningsAcked" type="checkbox" />
            <span>{{ t('edit.exportAck') }}</span>
          </label>
        </section>

        <label class="ed-row">
          <span>{{ t('edit.exportPreset') }}</span>
          <select v-model="preset" class="ed-select" :disabled="busy">
            <option value="auto">{{ t('edit.presetAuto') }}</option>
            <option value="vertical-hd">{{ t('edit.presetVerticalHd') }}</option>
            <option value="horizontal-hd">{{ t('edit.presetHorizontalHd') }}</option>
            <option value="square-hd">{{ t('edit.presetSquareHd') }}</option>
            <option value="vertical-high">{{ t('edit.presetVerticalHigh') }}</option>
          </select>
        </label>
        <p v-if="preset === 'auto'" class="ed-hint">{{ t('edit.exportAutoResolved', { label: resolvedPresetLabel }) }}</p>
        <label class="ed-row">
          <span>{{ t('edit.exportAudioTitle') }}</span>
          <select v-model="audioSource" class="ed-select" :disabled="busy">
            <option value="auto">{{ t('edit.audioSourceAuto') }}</option>
            <option value="mix">{{ t('edit.audioSourceMix') }}</option>
            <option value="clip">{{ t('edit.audioSourceClip') }}</option>
            <option value="silent">{{ t('edit.audioSourceSilent') }}</option>
          </select>
        </label>
        <p :class="['ed-hint', 'ed-audio-hint', { 'is-blocked': startBlocked }]">{{ audioHint }}</p>
        <p v-if="actualAudio" class="ed-hint ed-audio-actual">
          {{ t('edit.exportAudioActual', { label: actualAudio }) }}
        </p>
        <label class="ed-row">
          <span>{{ t('edit.exportSubtitle') }}</span>
          <span class="ed-radios" role="radiogroup">
            <label><input v-model="subtitleMode" type="radio" value="burn" :disabled="busy" />{{ t('edit.subtitleBurn') }}</label>
            <label><input v-model="subtitleMode" type="radio" value="soft" :disabled="busy" />{{ t('edit.subtitleSoft') }}</label>
            <label><input v-model="subtitleMode" type="radio" value="none" :disabled="busy" />{{ t('edit.subtitleNone') }}</label>
          </span>
        </label>
        <label class="ed-row">
          <span>{{ t('edit.exportSetCurrent') }}</span>
          <input v-model="setCurrent" type="checkbox" :disabled="busy" />
        </label>
        <div class="ed-estimate">
          <span>{{ t('edit.exportEstimateDuration') }} <b>{{ formatDuration(layoutDurationMs) }}</b></span>
          <span>{{ t('edit.exportEstimateSize') }} <b>{{ formatSize(estimatedBytes) }}</b></span>
        </div>

        <section v-if="busy" class="ed-running">
          <div class="ed-progress-head">
            <span>{{ t('edit.exportProgress') }}</span>
            <b>{{ progress }}%</b>
          </div>
          <div class="ed-progress-bar"><span :style="{ width: `${progress}%` }"></span></div>
          <p class="ed-progress-phase">{{ progressStage }}</p>
        </section>

        <footer v-if="!reused">
          <button v-if="busy" type="button" class="ed-secondary" @click="cancelExport">
            {{ cancelling ? t('edit.exportCancelling') : t('edit.exportCancel') }}
          </button>
          <button v-else-if="retryable" type="button" class="ed-start" @click="retryExport">
            {{ t('edit.exportRetry') }}
          </button>
          <button
            v-else
            type="button"
            class="ed-start"
            :disabled="!canEdit || blocking.length > 0 || !warningsAcked || startBlocked"
            @click="startExport"
          >
            {{ t('edit.exportStart') }}
          </button>
        </footer>
        <section v-if="reused" class="ed-reused">
          <b>{{ t('edit.exportReusedTitle') }}</b>
          <p>{{ t('edit.exportReusedHint') }}</p>
          <div class="ed-reused-actions">
            <button type="button" :disabled="!reusedOutputUrl" @click="openReusedFilm">
              {{ t('edit.exportOpenFilm') }}
            </button>
            <button type="button" @click="goDelivery">{{ t('edit.exportViewDelivery') }}</button>
          </div>
        </section>
        <section v-if="sourceWarnings.length" class="ed-warn-list ed-source-warnings">
          <b>{{ t('edit.exportSourceWarningsTitle') }}</b>
          <p v-for="warning in sourceWarnings" :key="warning.code">{{ warning.message }}</p>
        </section>
        <p v-if="cancelled" class="ed-cancelled">{{ t('edit.exportCancelled') }}</p>
        <p v-if="error" class="ed-error">{{ error }}</p>
        </template>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { editAPI, exportAPI } from '~/composables/useApi'
import { collectExportWarnings } from '~/utils/edit-export-warnings'

// 导出确认弹窗（设计 6.10）：只读展示计划降级清单（后端 buildRenderReport 同名 code），
// 不修改计划——导出以保存后的服务端计划为准。启动后轮询 GET /edit/render/:exportId。
const props = defineProps({
  open: { type: Boolean, default: false },
  episodeId: { type: Number, required: true },
  projectId: { type: Number, default: 0 },
  version: { type: Number, default: 0 },
  plan: { type: Object, required: true },
  /** 只读布局：预计时长取自服务端同源 layout.duration_ms */
  layout: { type: Object, default: () => ({ duration_ms: 0 }) },
  canEdit: { type: Boolean, default: false },
  settings: { type: Object, default: () => ({}) },
  /** 服务端 mix_status（与剪辑台同源）：仅用于展示提示与拦截显式混音 */
  mixStatus: { type: Object, default: null },
  /** 页面刷新后恢复轮询：最新记录仍处于进行中时由工作台传入 */
  resumeExportId: { type: Number, default: 0 },
  resumeStatus: { type: Object, default: null },
})
const emit = defineEmits(['close', 'exported', 'reused', 'delivery', 'cancelled', 'failed', 'progress'])
const { t } = useI18n()

const busy = ref(false)
const warningsAcked = ref(false)
const subtitleMode = ref('soft')
const setCurrent = ref(false)
const preset = ref('auto')
const audioSource = ref('auto')
const actualAudio = ref('')
const sourceWarnings = ref([])
const progress = ref(0)
const error = ref('')
const reused = ref(false)
const reusedOutputUrl = ref('')
const currentExportId = ref(0)
const failed = ref(false)
const cancelled = ref(false)
const cancelling = ref(false)
const completed = ref(false)
const doneStatus = ref(null)
const copyHint = ref('')
let pollTimer = 0

const exportCheck = computed(() => collectExportWarnings(props.plan))
const blocking = computed(() => exportCheck.value.blocking)
// 阻断项已经解释了不能导出的原因，不再叠加“将简化导出”的警告
const warnings = computed(() => (blocking.value.length ? [] : exportCheck.value.warnings))
const exportSettings = computed(() => props.settings?.export || {})
const presetLabels = computed(() => ({
  'vertical-hd': t('edit.presetVerticalHd'),
  'horizontal-hd': t('edit.presetHorizontalHd'),
  'square-hd': t('edit.presetSquareHd'),
  'vertical-high': t('edit.presetVerticalHigh'),
}))
// auto 的实际落点跟随工程画幅（与后端 resolveEditExportPreset 同口径）
const resolvedPresetKey = computed(() => {
  if (preset.value !== 'auto') return preset.value
  const aspect = props.plan?.project?.aspect
  if (aspect === '16:9') return 'horizontal-hd'
  if (aspect === '1:1') return 'square-hd'
  return 'vertical-hd'
})
const resolvedPresetLabel = computed(() => presetLabels.value[resolvedPresetKey.value] || '')
// 预计时长/大小镜像后端 estimateExportBytes：成片 + 混音 WAV 中间件
const layoutDurationMs = computed(() => Math.max(0, Number(props.layout?.duration_ms) || 0))
const PRESET_BITRATES = {
  'vertical-hd': { video: 10000, audio: 192 },
  'horizontal-hd': { video: 10000, audio: 192 },
  'square-hd': { video: 10000, audio: 192 },
  'vertical-high': { video: 14000, audio: 256 },
}
const estimatedBytes = computed(() => {
  const seconds = Math.max(1, layoutDurationMs.value / 1000)
  const spec = PRESET_BITRATES[resolvedPresetKey.value] || PRESET_BITRATES['vertical-hd']
  const video = Math.round((seconds * (spec.video + spec.audio) * 1000) / 8 * 1.1)
  const pcm = seconds * 48000 * 3 * 2
  return video + Math.round(pcm * 1.05) + 4096
})
const progressStage = computed(() => {
  const value = progress.value
  if (value >= 100) return t('edit.exportPhaseDone')
  if (value >= 92) return t('edit.exportPhaseFinalize')
  if (value >= 72) return t('edit.exportPhaseSubtitle')
  if (value >= 55) return t('edit.exportPhaseAudio')
  if (value >= 30) return t('edit.exportPhaseAssemble')
  if (value >= 5) return t('edit.exportPhaseNormalize')
  return t('edit.exportPhaseCheck')
})
const doneOutputUrl = computed(() => String(doneStatus.value?.output_url || ''))
const doneFileName = computed(() => {
  const url = doneOutputUrl.value.split('?')[0]
  if (!url) return ''
  const name = url.split('/').pop() || ''
  try { return decodeURIComponent(name) } catch { return name }
})

function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

function formatSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(value >= 100 * 1024 ** 2 ? 0 : 1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${Math.round(value)} B`
}

function formatDateTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}
// 音频来源与后端同口径：只用 mix_status 展示选择，不自行推断对齐
const mixAligned = computed(() => props.mixStatus?.status === 'aligned')
const clipHasAudio = computed(() => (props.plan?.clips ?? []).some((clip) => Boolean(clip?.source?.hasAudio)))
const explicitMixBlocked = computed(() => audioSource.value === 'mix' && !mixAligned.value)
const autoRequiresMix = computed(() => (
  audioSource.value === 'auto'
  && exportSettings.value.requireAlignedMix === true
  && !mixAligned.value
))
const startBlocked = computed(() => explicitMixBlocked.value || autoRequiresMix.value)
const audioLabels = computed(() => ({
  auto: t('edit.audioSourceAuto'),
  mix: t('edit.audioSourceMix'),
  clip: t('edit.audioSourceClip'),
  silent: t('edit.audioSourceSilent'),
}))
const audioHint = computed(() => {
  if (audioSource.value === 'mix') {
    return mixAligned.value ? t('edit.exportAudioHintMix') : t('edit.exportAudioHintMixBlocked')
  }
  if (audioSource.value === 'clip') return t('edit.exportAudioHintClip')
  if (audioSource.value === 'silent') return t('edit.exportAudioHintSilent')
  if (mixAligned.value) return t('edit.exportAudioHintAutoMix')
  if (autoRequiresMix.value) return t('edit.exportAudioHintAutoRequire')
  if (props.mixStatus?.status === 'stale') {
    return clipHasAudio.value ? t('edit.exportAudioHintAutoStaleClip') : t('edit.exportAudioHintAutoSilent')
  }
  if (clipHasAudio.value) return t('edit.exportAudioHintAutoClip')
  return t('edit.exportAudioHintAutoSilent')
})
const retryable = computed(() => !busy.value && currentExportId.value > 0 && (failed.value || cancelled.value))
const ACTIVE_STATUSES = ['pending', 'running', 'rendering']

// 打开时按配置初始化：默认预设与字幕模式来自 edit.export.*，不再硬编码
watch(() => props.open, (value) => {
  if (value) {
    preset.value = exportSettings.value.defaultPreset || 'auto'
    subtitleMode.value = exportSettings.value.subtitleMode || 'soft'
    audioSource.value = exportSettings.value.audioSource || 'auto'
    actualAudio.value = ''
    sourceWarnings.value = []
    reused.value = false
    reusedOutputUrl.value = ''
    error.value = ''
    failed.value = false
    cancelled.value = false
    cancelling.value = false
    completed.value = false
    doneStatus.value = null
    copyHint.value = ''
    currentExportId.value = 0
    progress.value = 0
    busy.value = false
    maybeResume()
  } else {
    stopPolling()
  }
}, { immediate: true })

// 降级清单变化（计划被外部刷新）时重置确认勾选；无降级项时无需勾选即可导出
watch(warnings, (value) => {
  warningsAcked.value = !value.length
}, { immediate: true })

watch(() => props.open, (value) => {
  if (!value) stopPolling()
})

// 页面刷新后恢复：进行中的记录直接轮询，关闭弹窗不取消任务；
// 失败/取消的最近记录恢复为“可重试”状态，重试仍沿用同一记录 id。
function maybeResume() {
  const id = Number(props.resumeExportId) || 0
  const status = props.resumeStatus
  if (!id || !status) return
  applyActualAudio(status)
  const state = String(status.status)
  if (ACTIVE_STATUSES.includes(state)) {
    currentExportId.value = id
    busy.value = true
    progress.value = Math.round(Number(status.progress) || 0)
    if (status.error) error.value = status.error
    // 让工作台顶栏同步显示进度胶囊（关闭弹窗后仍可见）
    emit('progress', { id, status: state, progress: Number(status.progress) || 0 })
    startPolling(id)
    return
  }
  if (state === 'failed') {
    currentExportId.value = id
    failed.value = true
    error.value = status.error || t('edit.exportFailed')
    return
  }
  if (state === 'cancelled') {
    currentExportId.value = id
    cancelled.value = true
  }
}

function close() {
  emit('close')
}

/** 状态行由服务端给出实际来源（auto 已解析），前端只做展示 */
function applyActualAudio(status) {
  const source = String(status?.audio_source || '')
  if (audioLabels.value[source]) actualAudio.value = audioLabels.value[source]
}

function stopPolling() {
  clearInterval(pollTimer)
  pollTimer = 0
}

function startPolling(exportId) {
  stopPolling()
  pollTimer = setInterval(() => void pollStatus(exportId), 2000)
}

function startExport() {
  if (busy.value) return
  busy.value = true
  reused.value = false
  reusedOutputUrl.value = ''
  error.value = ''
  failed.value = false
  cancelled.value = false
  cancelling.value = false
  completed.value = false
  doneStatus.value = null
  copyHint.value = ''
  currentExportId.value = 0
  actualAudio.value = ''
  sourceWarnings.value = []
  progress.value = 0
  void runExport()
}

async function runExport() {
  try {
    const body = {
      preset: preset.value,
      subtitle_mode: subtitleMode.value,
      audio_source: audioSource.value,
      set_current: setCurrent.value,
      base_version: props.version,
    }
    if (props.projectId > 0) body.project_id = props.projectId
    const result = await editAPI.render(props.episodeId, body)
    sourceWarnings.value = Array.isArray(result?.source_warnings) ? result.source_warnings : []
    if (result?.reused) {
      // 命中复用不轮询；补一次状态只为拿到成片地址，供“打开成片”使用
      stopPolling()
      busy.value = false
      reused.value = true
      let status = { id: result.export_id }
      try {
        status = await editAPI.renderStatus(props.episodeId, result.export_id)
        reusedOutputUrl.value = status.output_url || ''
        applyActualAudio(status)
      } catch {
        reusedOutputUrl.value = ''
      }
      emit('reused', status)
      return
    }
    const exportId = result.export_id
    currentExportId.value = exportId
    progress.value = Math.round(Number(result.progress) || 0)
    emit('progress', { id: exportId, status: String(result.status || 'pending'), progress: Number(result.progress) || 0 })
    startPolling(exportId)
    await pollStatus(exportId)
  } catch (cause) {
    error.value = cause?.message || t('edit.exportFailed')
    busy.value = false
  }
}

function openReusedFilm() {
  if (!reusedOutputUrl.value) return
  window.open(reusedOutputUrl.value, '_blank', 'noopener')
}

function openDoneFilm() {
  if (!doneOutputUrl.value) return
  window.open(doneOutputUrl.value, '_blank', 'noopener')
}

async function copyDonePath() {
  if (!doneOutputUrl.value) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
    await navigator.clipboard.writeText(doneOutputUrl.value)
    copyHint.value = t('edit.exportCopied')
  } catch {
    copyHint.value = t('edit.exportCopyFailed')
  }
}

function goDelivery() {
  emit('delivery')
}

async function cancelExport() {
  if (!currentExportId.value || !busy.value || cancelling.value) return
  cancelling.value = true
  try {
    await exportAPI.cancel(currentExportId.value)
    await pollStatus(currentExportId.value)
  } catch (cause) {
    error.value = cause?.message || t('edit.exportCancelFailed')
  } finally {
    cancelling.value = false
  }
}

async function retryExport() {
  if (!currentExportId.value || busy.value) return
  busy.value = true
  failed.value = false
  cancelled.value = false
  completed.value = false
  doneStatus.value = null
  copyHint.value = ''
  error.value = ''
  progress.value = 0
  try {
    await exportAPI.retry(currentExportId.value)
    startPolling(currentExportId.value)
    await pollStatus(currentExportId.value)
  } catch (cause) {
    busy.value = false
    failed.value = true
    error.value = cause?.message || t('edit.exportFailed')
  }
}

async function pollStatus(exportId) {
  try {
    // 状态行字段与后端 getEditExportStatus 同构（snake_case）
    const status = await editAPI.renderStatus(props.episodeId, exportId)
    applyActualAudio(status)
    if (ACTIVE_STATUSES.includes(String(status.status))) {
      progress.value = Math.round(Number(status.progress) || 0)
      emit('progress', status)
      return
    }
    stopPolling()
    busy.value = false
    progress.value = Math.round(Number(status.progress) || 0)
    if (status.status === 'cancelled') {
      // 取消是终态：停止轮询、保留重试入口，不进入 failed 分支
      cancelled.value = true
      failed.value = false
      completed.value = false
      doneStatus.value = null
      error.value = ''
      emit('cancelled', status)
      return
    }
    if (status.status === 'failed') {
      failed.value = true
      completed.value = false
      doneStatus.value = null
      error.value = status.error || t('edit.exportFailed')
      emit('failed', status)
      return
    }
    // 完成后保留弹窗，展示成片信息与打开/交付/复制路径；
    // completed-with-warning 仍只展示警告，不自动关闭。
    completed.value = true
    doneStatus.value = status
    progress.value = 100
    if (status.error) {
      error.value = status.error
      emit('exported', status)
      return
    }
    emit('exported', status)
  } catch (cause) {
    stopPolling()
    busy.value = false
    error.value = cause?.message || t('edit.exportFailed')
  }
}

onBeforeUnmount(stopPolling)
</script>

<style scoped>
.ed-export-mask {
  position: fixed; inset: 0; z-index: 65; display: flex; align-items: center;
  justify-content: center; padding: 24px; background: rgba(0, 0, 0, .5);
}
.ed-export {
  width: 440px; max-width: 100%; display: flex; flex-direction: column; gap: 12px;
  padding: 16px; border: 1px solid var(--border); border-radius: 12px;
  background: var(--bg-1); box-shadow: 0 18px 50px rgba(0, 0, 0, .35);
}
.ed-export header { display: flex; align-items: center; justify-content: space-between; }
.ed-export header b { font-size: 13px; }
.ed-close {
  width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent;
  color: var(--text-2); font-size: 18px; cursor: pointer;
}
.ed-close:disabled { opacity: .4; cursor: not-allowed; }
.ed-warn-list,
.ed-blocked-list {
  display: flex; flex-direction: column; gap: 4px; padding: 9px 11px; border-radius: 9px;
}
.ed-warn-list { background: color-mix(in srgb, var(--warning) 10%, var(--bg-1)); }
.ed-warn-list b { font-size: 11px; color: var(--warning); }
.ed-warn-list p { margin: 0; font-size: 11px; color: var(--text-2); }
.ed-blocked-list {
  background: color-mix(in srgb, var(--action-danger) 10%, var(--bg-1));
  border: 1px solid color-mix(in srgb, var(--action-danger) 35%, transparent);
}
.ed-blocked-list b { font-size: 11px; color: var(--action-danger); }
.ed-blocked-list p { margin: 0; font-size: 11px; color: var(--text-1); }
.ed-blocked-path { margin-left: 6px; color: var(--text-3); font-size: 10px; }
.ed-blocked-bottom { color: var(--text-2) !important; }
.ed-ack { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 11px; color: var(--text-1); cursor: pointer; }
.ed-row { display: flex; align-items: center; gap: 12px; font-size: 12px; }
.ed-row > span:first-child { flex: 0 0 88px; color: var(--text-2); }
.ed-hint { margin: -6px 0 0 100px; color: var(--text-3); font-size: 10px; }
.ed-audio-hint.is-blocked { color: var(--action-danger); }
.ed-audio-actual { color: var(--text-2); }
.ed-source-warnings { margin-top: 2px; }
.ed-select {
  flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--border);
  border-radius: 7px; background: var(--bg-2); color: var(--text-0); font-size: 11px;
}
.ed-radios { display: flex; gap: 14px; flex: 1; }
.ed-radios label, .ed-row > input[type='checkbox'] { cursor: pointer; }
.ed-radios { font-size: 11px; color: var(--text-1); }
.ed-radios input { margin-right: 4px; }
.ed-export footer { display: flex; justify-content: flex-end; }
.ed-start {
  height: 30px; padding: 0 16px; border: 1px solid var(--accent); border-radius: 8px;
  background: var(--accent-bg); color: var(--accent-text); font-size: 12px; cursor: pointer;
}
.ed-start:disabled { opacity: .45; cursor: not-allowed; }
.ed-secondary {
  height: 30px; padding: 0 16px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-2); color: var(--text-1); font-size: 12px; cursor: pointer;
}
.ed-cancelled { margin: 0; font-size: 11px; color: var(--text-2); }
.ed-done {
  display: flex; flex-direction: column; gap: 8px; padding: 14px;
  border-radius: 10px; background: color-mix(in srgb, var(--accent) 10%, var(--bg-1));
}
.ed-done > b { font-size: 13px; color: var(--accent-text); }
.ed-done-name {
  margin: 0; font-size: 11px; color: var(--text-1);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ed-done-stats { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--text-2); }
.ed-done-warning {
  margin: 0; padding: 6px 9px; border-radius: 7px; font-size: 11px;
  background: color-mix(in srgb, var(--warning) 12%, var(--bg-1)); color: var(--warning);
}
.ed-done-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.ed-done-actions button {
  height: 26px; padding: 0 12px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--bg-2); color: var(--text-0); font-size: 11px; cursor: pointer;
}
.ed-done-actions button:disabled { opacity: .45; cursor: not-allowed; }
.ed-estimate {
  display: flex; gap: 18px; padding-top: 4px; font-size: 11px; color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.ed-estimate b { margin-left: 5px; color: var(--text-1); font-weight: 600; }
.ed-running { display: flex; flex-direction: column; gap: 5px; }
.ed-progress-head {
  display: flex; justify-content: space-between; font-size: 11px; color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.ed-progress-bar {
  height: 6px; overflow: hidden; border-radius: 999px; background: var(--bg-3, var(--bg-2));
}
.ed-progress-bar > span {
  display: block; height: 100%; border-radius: inherit; background: var(--accent);
  transition: width .3s ease;
}
.ed-progress-phase { margin: 0; font-size: 10px; color: var(--text-3); }
.ed-reused {
  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 9px;
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-1));
}
.ed-reused b { font-size: 12px; color: var(--accent-text); }
.ed-reused p { margin: 0; font-size: 11px; color: var(--text-2); }
.ed-reused-actions { display: flex; gap: 8px; }
.ed-reused-actions button {
  height: 26px; padding: 0 12px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--bg-2); color: var(--text-0); font-size: 11px; cursor: pointer;
}
.ed-reused-actions button:disabled { opacity: .45; cursor: not-allowed; }
.ed-progress { margin: 0; font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.ed-error {
  margin: 0; padding: 6px 9px; border-radius: 7px; font-size: 11px;
  background: color-mix(in srgb, var(--action-danger) 10%, var(--bg-1)); color: var(--action-danger);
}
</style>
