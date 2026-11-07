<template>
  <div class="ed-top-wrap">
    <header class="ed-top">
      <div class="ed-top-left">
        <button class="ed-icon" type="button" :title="t('edit.back')" @click="$emit('back')">
          <ArrowLeft :size="16" />
        </button>
        <span class="ed-brand"><Scissors :size="14" /> {{ t('edit.title') }}</span>
        <span class="ed-episode">{{ episodeLabel }}</span>
        <span :class="['ed-chip', readonly ? 'is-muted' : 'is-on']">
          {{ readonly ? t('edit.readonly') : t('edit.on') }}
        </span>
        <span v-if="legacy" class="ed-chip is-muted">{{ t('edit.legacyProject') }}</span>
        <AppMenu v-model:open="mixOpen" :min-width="244">
          <template #trigger>
            <button
              :class="['ed-chip', 'ed-mix-chip', `is-${mixStatus}`]"
              type="button"
              :aria-expanded="mixOpen"
              :title="mixHint"
            >
              <span class="ed-mix-shape" aria-hidden="true" />{{ mixLabel }}
            </button>
          </template>
          <div class="ed-mix-pop">
            <span :class="['ed-chip', 'ed-mix-chip', `is-${mixStatus}`]">
              <span class="ed-mix-shape" aria-hidden="true" />{{ mixLabel }}
            </span>
            <ul v-if="mixReasons.length" class="ed-mix-reasons">
              <li v-for="reason in mixReasons" :key="reason">{{ t(`edit.mixReason.${reason}`) }}</li>
            </ul>
            <p class="ed-mix-hint">{{ mixHint }}</p>
            <button class="ed-mix-go" type="button" @click="goMix">
              <AudioLines :size="12" />{{ t('edit.goMix') }}
            </button>
          </div>
        </AppMenu>
      </div>

      <div v-if="canEdit" class="ed-top-center">
        <button class="ed-icon" type="button" :title="t('edit.undo')" :disabled="!canUndo" @click="$emit('undo')">
          <Undo2 :size="15" />
        </button>
        <button class="ed-icon" type="button" :title="t('edit.redo')" :disabled="!canRedo" @click="$emit('redo')">
          <Redo2 :size="15" />
        </button>
        <button
          class="ed-save"
          :class="saveTone"
          type="button"
          :title="t('edit.saveNow')"
          @click="$emit('save')"
        >
          <span class="ed-save-dot"></span>{{ saveLabel }}
        </button>
      </div>

      <div class="ed-top-right">
        <button
          v-if="activeRender"
          class="ed-export-live"
          type="button"
          :title="t('edit.exportActiveHint')"
          @click="$emit('open-export', activeRender.id)"
        >
          <span class="ed-live-dot"></span>{{ t('edit.exportActive', { pct: activeRender.progress }) }}
        </button>
        <template v-if="canEdit">
          <button
            class="ed-action"
            type="button"
            :disabled="roughCutBusy || subtitleBusy"
            @click="$emit('suggest-subtitles')"
          >
            <Captions :size="13" />
            <span>{{ subtitleBusy ? t('edit.subtitleSuggestRunning') : t('edit.subtitleSuggest') }}</span>
          </button>
          <button
            class="ed-action"
            type="button"
            :disabled="roughCutBusy || subtitleBusy"
            @click="$emit('rough-cut')"
          >
            <Wand2 :size="13" />
            <span>{{ roughCutBusy ? t('edit.roughCutRunning') : t('edit.roughCut') }}</span>
          </button>
        </template>
        <button
          class="ed-action"
          type="button"
          :disabled="!canExport"
          :title="canExport ? exportButtonTitle : exportBlockedReason"
          @click="$emit('open-export')"
        >
          <Download :size="13" />
          <span>{{ exportLabel }}</span>
        </button>
        <span v-if="!canExport && exportBlockedReason" class="ed-blocked">{{ exportBlockedReason }}</span>
        <button class="ed-action" type="button" @click="$emit('open-revisions')">
          <History :size="13" /><span>{{ t('edit.versionTitle') }}</span>
        </button>
        <button class="ed-icon" type="button" :title="t('edit.subtitleListTitle')" @click="$emit('toggle-subtitles')">
          <Captions :size="15" />
        </button>
        <button class="ed-icon" type="button" :title="t('edit.libraryToggle')" @click="$emit('toggle-media')">
          <PanelLeft :size="15" />
        </button>
        <button v-if="showAgent" class="ed-icon" type="button" :title="t('assistant.title')" @click="$emit('open-agent')">
          <Sparkles :size="15" />
        </button>
        <button class="ed-icon" type="button" :title="t('edit.shortcuts')" @click="$emit('shortcuts')">
          <Keyboard :size="15" />
        </button>
        <button
          v-if="canEdit"
          class="ed-icon"
          type="button"
          :title="t('edit.discardDraft')"
          :disabled="!dirty"
          @click="$emit('discard')"
        >
          <Trash2 :size="15" />
        </button>
      </div>
    </header>
    <p v-if="readonly" class="ed-readonly-bar">{{ t('edit.readonlyHint') }}</p>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import {
  ArrowLeft, AudioLines, Captions, Download, History, Keyboard, PanelLeft, Redo2, Scissors, Sparkles, Trash2, Undo2, Wand2,
} from 'lucide-vue-next'
import AppMenu from '~/components/AppMenu.vue'

const props = defineProps({
  state: { type: Object, required: true },
  episodeLabel: { type: String, default: '' },
  saveStatus: { type: String, default: 'idle' },
  dirty: { type: Boolean, default: false },
  canUndo: { type: Boolean, default: false },
  canRedo: { type: Boolean, default: false },
  canEdit: { type: Boolean, default: false },
  legacy: { type: Boolean, default: false },
  roughCutBusy: { type: Boolean, default: false },
  subtitleBusy: { type: Boolean, default: false },
  showAgent: { type: Boolean, default: false },
})
const emit = defineEmits([
  'back', 'undo', 'redo', 'save', 'discard', 'open-revisions',
  'rough-cut', 'suggest-subtitles', 'open-export', 'shortcuts', 'toggle-media', 'toggle-subtitles',
  'go-mix', 'open-agent',
])
const { t } = useI18n()

const MIX_REASONS = ['legacy_mix', 'timing_changed', 'dialogue_changed']
const mixOpen = ref(false)
const mixStatus = computed(() => {
  const status = props.state.mix_status?.status
  return status === 'aligned' || status === 'stale' ? status : 'missing'
})
const mixReasons = computed(() =>
  (props.state.mix_status?.reasons ?? []).filter((reason) => MIX_REASONS.includes(reason)),
)
const mixHint = computed(() => {
  if (mixStatus.value === 'aligned') return t('mix.editSync.alignedHint')
  if (mixStatus.value === 'stale') return t('mix.editSync.staleHint')
  return t('mix.editSync.missingHint')
})
function goMix() {
  mixOpen.value = false
  emit('go-mix')
}

const readonly = computed(() => !props.canEdit)
const activeRender = computed(() => {
  const latest = props.state.renders?.latest
  if (!latest || !['pending', 'running', 'rendering'].includes(String(latest.status))) return null
  return { id: latest.id, progress: Math.round(Number(latest.progress) || 0) }
})
const canExport = computed(() => props.state.capabilities?.can_export === true)
const exportBlockedReason = computed(() => String(props.state.capabilities?.export_blocked_reason || ''))
// 设计 §4.2：草稿脏时导出按钮显示“先保存”，点击由工作台先保存再打开对话框
const exportLabel = computed(() => (props.dirty ? t('edit.exportSaveFirst') : t('edit.exportTitle')))
const exportButtonTitle = computed(() => (props.dirty ? t('edit.exportSaveFirstHint') : t('edit.exportTitle')))
const mixLabel = computed(() => {
  if (mixStatus.value === 'aligned') return t('edit.mixAligned')
  if (mixStatus.value === 'stale') return t('edit.mixStale')
  return t('edit.mixMissing')
})
const saveLabel = computed(() => {
  if (props.saveStatus === 'saving') return t('edit.saveSaving')
  if (props.saveStatus === 'conflict') return t('edit.saveConflict')
  if (props.saveStatus === 'error') return t('edit.saveFailed')
  if (props.saveStatus === 'saved') return t('edit.saveSaved')
  return props.dirty ? t('edit.savePending') : t('edit.saveSaved')
})
const saveTone = computed(() => {
  if (props.saveStatus === 'saving') return 'is-saving'
  if (props.saveStatus === 'conflict') return 'is-conflict'
  if (props.saveStatus === 'error') return 'is-error'
  return props.dirty ? 'is-pending' : 'is-saved'
})
</script>

<style scoped>
.ed-top-wrap { flex: 0 0 auto; display: flex; flex-direction: column; }
.ed-top {
  height: 52px; padding: 0 14px; display: flex; align-items: center;
  gap: 12px; border-bottom: 1px solid var(--border); background: var(--bg-1);
}
.ed-top-left { min-width: 0; display: flex; align-items: center; gap: 10px; }
.ed-top-center { display: flex; align-items: center; gap: 4px; padding-left: 4px; border-left: 1px solid var(--border); }
.ed-top-right { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.ed-icon {
  width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 8px; background: transparent;
  color: var(--text-1); cursor: pointer;
}
.ed-icon:hover { background: var(--bg-hover); }
.ed-icon:disabled { opacity: .35; cursor: not-allowed; }
.ed-brand { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 650; white-space: nowrap; }
.ed-episode {
  max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; color: var(--text-2);
}
.ed-chip {
  height: 22px; padding: 0 8px; display: inline-flex; align-items: center; border-radius: 999px;
  font-size: 11px; font-weight: 600; white-space: nowrap;
}
.ed-chip.is-muted { background: var(--bg-2); color: var(--text-2); }
.ed-chip.is-on { background: var(--accent-bg); color: var(--accent-text); }
.ed-chip.is-aligned { background: var(--success-bg); color: var(--success); }
.ed-chip.is-missing { background: var(--bg-2); color: var(--text-2); }
.ed-chip.is-stale { background: var(--warning-bg); color: var(--warning); }
.ed-mix-chip { gap: 5px; border: 1px solid transparent; font-family: inherit; cursor: pointer; }
.ed-mix-chip:hover { filter: brightness(1.06); }
.ed-mix-shape {
  width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: currentColor;
}
.ed-mix-chip.is-stale .ed-mix-shape { border-radius: 1px; transform: rotate(45deg); }
.ed-mix-chip.is-missing .ed-mix-shape { border-radius: 1px; }
.ed-mix-pop { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
.ed-mix-reasons { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 3px; color: var(--text-1); font-size: 11px; line-height: 1.5; }
.ed-mix-hint { margin: 0; color: var(--text-3); font-size: 10px; line-height: 1.5; }
.ed-mix-go {
  height: 28px; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  border: 1px solid var(--accent); border-radius: 7px; background: var(--accent-bg);
  color: var(--accent-text); font-size: 11px; font-weight: 600; cursor: pointer;
}
.ed-mix-go:hover { filter: brightness(1.08); }
.ed-save {
  height: 26px; padding: 0 9px; display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2);
  color: var(--text-2); font-size: 10px; cursor: pointer; white-space: nowrap;
}
.ed-save:hover { border-color: var(--accent); }
.ed-save-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.ed-save.is-saved { color: var(--success); }
.ed-save.is-saving, .ed-save.is-pending { color: var(--warning); }
.ed-save.is-error, .ed-save.is-conflict { color: var(--action-danger); }
.ed-export-live {
  height: 26px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--warning); border-radius: 999px; background: var(--warning-bg);
  color: var(--warning); font-size: 10px; font-variant-numeric: tabular-nums;
  cursor: pointer; white-space: nowrap;
}
.ed-live-dot {
  width: 6px; height: 6px; border-radius: 50%; background: currentColor;
  animation: ed-live-pulse 1.2s ease-in-out infinite;
}
@keyframes ed-live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.ed-action {
  height: 28px; padding: 0 9px; display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border); border-radius: 7px; background: var(--bg-2);
  color: var(--text-1); font-size: 10px; cursor: pointer; white-space: nowrap;
}
.ed-action:hover { border-color: var(--accent); color: var(--text-0); }
.ed-action:disabled { opacity: .45; cursor: not-allowed; }
.ed-readonly-bar {
  margin: 0; padding: 5px 14px; border-bottom: 1px solid var(--border);
  background: var(--bg-2); color: var(--text-3); font-size: 10px;
}
.ed-blocked {
  max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-3); font-size: 10px;
}
@media (max-width: 1180px) {
  .ed-episode { max-width: 150px; }
  .ed-action span { display: none; }
  .ed-action { width: 28px; padding: 0; justify-content: center; }
}
@media (max-width: 900px) {
  .ed-top { gap: 6px; padding: 0 8px; }
  .ed-brand, .ed-episode { display: none; }
}
</style>
