<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ExportKind, ExportSubtitleMode } from '~/composables/useApi'

const props = defineProps<{
  open: boolean
  source: { kind: string; durationMs: number } | null
  episodeNumber: number
  defaultPreset: string
  active: { status?: string; progress?: number } | null
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'start', payload: {
    kind: ExportKind
    preset: string
    subtitleMode: ExportSubtitleMode
    title: string
    setCurrent: boolean
  }): void
}>()
const { t, te } = useI18n()

// locale 缺失时回退中文，保证四语言包同步前界面不空（与 FilmPicker 同策略）
function label(key: string, fallback: string) {
  return te(key) ? t(key) : fallback
}

const KIND_FALLBACK: Record<string, string> = {
  concat: '拼接成片',
  mix: '混音成片',
  edit: '剪辑成片',
  import: '导入成片',
}
function kindLabel(kind: string) {
  return label(`films.kind.${kind}`, KIND_FALLBACK[kind] || kind)
}

const kind = ref<ExportKind>('video')
const preset = ref(props.defaultPreset)
const subtitleMode = ref<ExportSubtitleMode>('copy')
const title = ref('')
const setCurrent = ref(false)

watch(() => props.open, (open) => {
  if (!open) return
  preset.value = props.defaultPreset
  subtitleMode.value = 'copy'
  setCurrent.value = false
  title.value = `第 ${props.episodeNumber} 集 混音成片（${new Date().toLocaleString()}）`
})
</script>

<template>
  <div v-if="open" class="modal-mask" @click.self="emit('close')">
    <div class="mix-export-dialog">
      <h3>{{ label('mix.export.title', '导出混音成片') }}</h3>
      <label>{{ label('mix.export.source', '源成片') }}
        <input :value="kindLabel(source?.kind || 'concat')" disabled />
      </label>
      <label>{{ label('mix.export.kind', '导出类型') }}
        <select v-model="kind">
          <option value="video">{{ label('mix.export.kindVideo', '视频成片') }}</option>
          <option value="mix">{{ label('mix.export.kindAudio', '仅音频') }}</option>
          <option value="stems">{{ label('mix.export.kindStems', '分轨 ZIP') }}</option>
        </select>
      </label>
      <label v-if="kind === 'video'">{{ label('mix.export.preset', '视频预设') }}
        <select v-model="preset">
          <option value="vertical-hd">{{ t('export.preset.verticalHd') }}</option>
          <option value="horizontal-hd">{{ t('export.preset.horizontalHd') }}</option>
        </select>
      </label>
      <label v-if="kind === 'video'">{{ label('mix.export.subtitle', '字幕') }}
        <select v-model="subtitleMode">
          <option value="copy">{{ label('mix.export.copySource', '复制源成片外挂字幕') }}</option>
          <option value="none">{{ label('mix.export.subtitleNone', '不添加') }}</option>
        </select>
      </label>
      <label>{{ label('mix.export.titleLabel', '标题') }} <input v-model="title" /></label>
      <label v-if="kind === 'video'" class="checkbox">
        <input v-model="setCurrent" type="checkbox" /> {{ label('mix.export.setCurrent', '设为当前成片') }}
      </label>
      <p v-if="active" class="hint">{{ active.status }} {{ active.progress || 0 }}%</p>
      <div class="actions">
        <button class="btn" type="button" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" type="button" :disabled="Boolean(active)" @click="emit('start', {
          kind, preset, subtitleMode, title, setCurrent,
        })">{{ label('mix.export.start', '开始导出') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
}
.mix-export-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 380px;
  max-width: 92vw;
  max-height: 84vh;
  overflow-y: auto;
  padding: 16px;
  border: 1px solid var(--border, #2a2a2a);
  border-radius: 12px;
  background: var(--bg-0, #fff);
}
.mix-export-dialog h3 { margin: 0 0 2px; font-size: 14px; color: var(--text-0, #111); }
.mix-export-dialog label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-2, #555); }
.mix-export-dialog label.checkbox { flex-direction: row; align-items: center; gap: 6px; }
.mix-export-dialog input,
.mix-export-dialog select {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border, #d0d0d0);
  border-radius: 6px;
  background: var(--bg-1, #fff);
  color: var(--text-0, #111);
  font: inherit;
  font-size: 12px;
}
.mix-export-dialog input:disabled { color: var(--text-2, #555); opacity: .8; }
.mix-export-dialog .hint { margin: 0; font-size: 10.5px; color: var(--accent-text, #4f7cff); }
.mix-export-dialog .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.mix-export-dialog .btn {
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--border, #d0d0d0);
  border-radius: 6px;
  background: var(--bg-1, #fff);
  color: var(--text-1, #333);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.mix-export-dialog .btn:hover { border-color: var(--accent, #4f7cff); color: var(--accent-text, #4f7cff); }
.mix-export-dialog .btn.btn-primary { border-color: var(--accent, #4f7cff); background: var(--accent, #4f7cff); color: var(--action-primary-text, #fff); }
.mix-export-dialog .btn.btn-primary:hover { background: var(--action-primary-hover, #3d66d9); color: #fff; }
.mix-export-dialog .btn:disabled { opacity: .5; cursor: default; }
</style>
