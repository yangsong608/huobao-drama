<template>
  <Teleport to="body">
    <div v-if="open" class="ed-export-mask" @click.self="close()">
      <section class="ed-export" role="dialog" :aria-label="t('edit.exportTitle')">
        <header>
          <b>{{ t('edit.exportTitle') }}</b>
          <button type="button" class="ed-close" :disabled="busy" @click="close()">×</button>
        </header>

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
            <option value="vertical-hd">{{ t('edit.presetVerticalHd') }}</option>
            <option value="horizontal-hd">{{ t('edit.presetHorizontalHd') }}</option>
            <option value="vertical-high">{{ t('edit.presetVerticalHigh') }}</option>
          </select>
        </label>
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

        <footer>
          <button
            type="button"
            class="ed-start"
            :disabled="busy || !canEdit || !warningsAcked"
            @click="startExport"
          >
            {{ busy ? t('edit.exportRunning') : t('edit.exportStart') }}
          </button>
        </footer>
        <p v-if="progressText" class="ed-progress">{{ progressText }}</p>
        <p v-if="error" class="ed-error">{{ error }}</p>
      </section>
    </div>
  </Teleport>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { editAPI } from '~/composables/useApi'
import { useVisibilityPolling } from '~/composables/useVisibilityPolling'
import { collectExportWarnings } from '~/utils/edit-export-warnings'

// 导出确认弹窗（设计 6.10）：只读展示计划降级清单（后端 buildRenderReport 同名 code），
// 不修改计划——导出以保存后的服务端计划为准。启动后轮询 GET /edit/render/:exportId。
const props = defineProps({
  open: { type: Boolean, default: false },
  episodeId: { type: Number, required: true },
  projectId: { type: Number, default: 0 },
  version: { type: Number, default: 0 },
  plan: { type: Object, required: true },
  canEdit: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'exported'])
const { t } = useI18n()

const busy = ref(false)
const warningsAcked = ref(false)
const subtitleMode = ref('burn')
const setCurrent = ref(false)
const preset = ref('vertical-hd')
const progressText = ref('')
const error = ref('')
// 导出状态 2s 轮询：exportId 通过闭包传入，隐藏暂停、卸载必停
let exportId = 0
const exportPoll = useVisibilityPolling(() => pollStatus(exportId), 2000)

const warnings = computed(() => collectExportWarnings(props.plan))

// 预设跟随工程画幅：9:16 → 竖屏 HD，16:9 → 横屏 HD，1:1 → 竖屏 HD（后端仅支持三种预设）
watch(() => props.plan?.project?.aspect, (aspect) => {
  if (aspect === '16:9') preset.value = 'horizontal-hd'
  else preset.value = 'vertical-hd'
}, { immediate: true })

// 降级清单变化（计划被外部刷新）时重置确认勾选；无降级项时无需勾选即可导出
watch(warnings, (value) => {
  warningsAcked.value = !value.length
}, { immediate: true })

watch(() => props.open, (value) => {
  if (!value) stopPolling()
})

function close() {
  if (busy.value) return
  emit('close')
}

function stopPolling() {
  exportPoll.stop()
}

function startExport() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  progressText.value = t('edit.exportRunning')
  void runExport()
}

async function runExport() {
  try {
    const body = {
      preset: preset.value,
      subtitle_mode: subtitleMode.value,
      set_current: setCurrent.value,
      base_version: props.version,
    }
    if (props.projectId > 0) body.project_id = props.projectId
    const { export_id: id } = await editAPI.render(props.episodeId, body)
    stopPolling()
    exportId = id
    exportPoll.start()
    await pollStatus(exportId)
  } catch (cause) {
    error.value = cause?.message || t('edit.exportFailed')
    busy.value = false
  }
}

async function pollStatus(exportId) {
  try {
    // 状态行字段与后端 getEditExportStatus 同构（snake_case）
    const status = await editAPI.renderStatus(props.episodeId, exportId)
    // 弹窗关闭 / 组件卸载后迟到的响应：不改状态、不 emit
    if (!exportPoll.isRunning()) return
    progressText.value = `${t('edit.exportProgress')} ${Math.round(Number(status.progress) || 0)}%`
    if (status.status !== 'completed' && status.status !== 'failed') return
    stopPolling()
    busy.value = false
    if (status.status === 'failed') {
      error.value = status.error || t('edit.exportFailed')
      return
    }
    if (status.error) {
      error.value = status.error
      progressText.value = ''
      emit('exported', status)
      return
    }
    progressText.value = ''
    emit('exported', status)
    emit('close')
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
.ed-warn-list {
  display: flex; flex-direction: column; gap: 4px; padding: 9px 11px; border-radius: 9px;
  background: color-mix(in srgb, var(--warning) 10%, var(--bg-1));
}
.ed-warn-list b { font-size: 11px; color: var(--warning); }
.ed-warn-list p { margin: 0; font-size: 11px; color: var(--text-2); }
.ed-ack { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: 11px; color: var(--text-1); cursor: pointer; }
.ed-row { display: flex; align-items: center; gap: 12px; font-size: 12px; }
.ed-row > span:first-child { flex: 0 0 88px; color: var(--text-2); }
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
.ed-progress { margin: 0; font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.ed-error {
  margin: 0; padding: 6px 9px; border-radius: 7px; font-size: 11px;
  background: color-mix(in srgb, var(--action-danger) 10%, var(--bg-1)); color: var(--action-danger);
}
@media (hover: none) and (pointer: coarse) {
  .ed-close { min-width: var(--tap-min); min-height: var(--tap-min); }
}
</style>
