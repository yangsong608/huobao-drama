<template>
  <div class="ed-top-wrap">
    <header class="ed-top">
      <div class="ed-top-row1">
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
          <span :class="['ed-chip', `is-${state.mix_status.status}`]">{{ mixLabel }}</span>
        </div>
        <!-- 平板行 1 的保存状态；桌面端隐藏，由行 2 的 ed-save 承载 -->
        <span class="ed-save ed-save-chip" :class="saveTone">
          <span class="ed-save-dot"></span>{{ saveLabel }}
        </span>
      </div>

      <div class="ed-top-row2">
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
          <template v-if="canEdit">
            <button
              class="ed-action ed-act-suggest"
              type="button"
              :disabled="roughCutBusy || subtitleBusy"
              @click="$emit('suggest-subtitles')"
            >
              <Captions :size="13" />
              <span>{{ subtitleBusy ? t('edit.subtitleSuggestRunning') : t('edit.subtitleSuggest') }}</span>
            </button>
            <button
              class="ed-action ed-act-rough"
              type="button"
              :disabled="roughCutBusy || subtitleBusy"
              @click="$emit('rough-cut')"
            >
              <Wand2 :size="13" />
              <span>{{ roughCutBusy ? t('edit.roughCutRunning') : t('edit.roughCut') }}</span>
            </button>
            <button
              class="ed-action ed-act-export"
              type="button"
              :title="t('edit.exportTitle')"
              :aria-label="t('edit.exportTitle')"
              :disabled="roughCutBusy || subtitleBusy"
              @click="$emit('open-export')"
            >
              <Download :size="13" />
              <span>{{ t('edit.exportTitle') }}</span>
            </button>
          </template>
          <button class="ed-action ed-act-revisions" type="button" @click="$emit('open-revisions')">
            <History :size="13" /><span>{{ t('edit.versionTitle') }}</span>
          </button>
          <button class="ed-icon ed-icon-subtitles" type="button" :title="t('edit.subtitleListTitle')" @click="$emit('toggle-subtitles')">
            <Captions :size="15" />
          </button>
          <button class="ed-icon ed-icon-media" type="button" :title="t('edit.libraryToggle')" @click="$emit('toggle-media')">
            <PanelLeft :size="15" />
          </button>
          <button class="ed-icon ed-icon-shortcuts" type="button" :title="t('edit.shortcuts')" @click="$emit('shortcuts')">
            <Keyboard :size="15" />
          </button>
          <button
            v-if="canEdit"
            class="ed-icon ed-icon-discard"
            type="button"
            :title="t('edit.discardDraft')"
            :disabled="!dirty"
            @click="$emit('discard')"
          >
            <Trash2 :size="15" />
          </button>
          <!-- 检查器开关：仅平板/窄桌面出现，桌面宽屏保持原有布局 -->
          <button
            class="ed-icon ed-icon-inspector"
            type="button"
            :title="t('tablet.drawers.inspector')"
            @click="$emit('toggle-inspector')"
          >
            <SlidersHorizontal :size="15" />
          </button>
          <button
            class="ed-icon ed-more-btn"
            type="button"
            :title="t('tablet.more')"
            aria-haspopup="menu"
            :aria-expanded="moreOpen ? 'true' : 'false'"
            @click="toggleMore"
          >
            <MoreHorizontal :size="16" />
          </button>
        </div>
      </div>
    </header>
    <p v-if="readonly" class="ed-readonly-bar">{{ t('edit.readonlyHint') }}</p>
    <!-- 窄屏「更多」浮层：承载次级操作，事件名与桌面一致 -->
    <div v-if="moreOpen" class="ed-more-backdrop" @click="closeMore"></div>
    <div v-if="moreOpen" class="ed-more-pop" role="menu">
      <button
        v-if="canEdit"
        class="ed-more-item"
        type="button"
        role="menuitem"
        :disabled="roughCutBusy || subtitleBusy"
        @click="runMore('suggest-subtitles')"
      >
        <Captions :size="15" />
        <span>{{ subtitleBusy ? t('edit.subtitleSuggestRunning') : t('edit.subtitleSuggest') }}</span>
      </button>
      <button
        v-if="canEdit"
        class="ed-more-item"
        type="button"
        role="menuitem"
        :disabled="roughCutBusy || subtitleBusy"
        @click="runMore('rough-cut')"
      >
        <Wand2 :size="15" />
        <span>{{ roughCutBusy ? t('edit.roughCutRunning') : t('edit.roughCut') }}</span>
      </button>
      <button class="ed-more-item" type="button" role="menuitem" @click="runMore('open-revisions')">
        <History :size="15" />
        <span>{{ t('edit.versionTitle') }}</span>
      </button>
      <button class="ed-more-item" type="button" role="menuitem" @click="runMore('shortcuts')">
        <Keyboard :size="15" />
        <span>{{ t('edit.shortcuts') }}</span>
      </button>
      <button
        v-if="canEdit"
        class="ed-more-item"
        type="button"
        role="menuitem"
        :disabled="!dirty"
        @click="runMore('discard')"
      >
        <Trash2 :size="15" />
        <span>{{ t('edit.discardDraft') }}</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { useViewport } from '~/composables/useViewport'
import {
  ArrowLeft, Captions, Download, History, Keyboard, MoreHorizontal, PanelLeft, Redo2, Scissors,
  SlidersHorizontal, Trash2, Undo2, Wand2,
} from 'lucide-vue-next'

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
})
const emit = defineEmits([
  'back', 'undo', 'redo', 'save', 'discard', 'open-revisions',
  'rough-cut', 'suggest-subtitles', 'open-export', 'shortcuts', 'toggle-media', 'toggle-subtitles',
  'toggle-inspector',
])
const { t } = useI18n()

const readonly = computed(() => !props.canEdit)
const mixLabel = computed(() => {
  if (props.state.mix_status?.status === 'aligned') return t('edit.mixAligned')
  if (props.state.mix_status?.status === 'stale') return t('edit.mixStale')
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

// ---- 窄屏「更多」浮层 ----
const moreOpen = ref(false)

function closeMore() {
  moreOpen.value = false
}

function toggleMore() {
  moreOpen.value = !moreOpen.value
}

function runMore(name) {
  closeMore()
  emit(name)
}

// Escape 在捕获阶段关闭浮层并阻断冒泡，避免工作台继续清空片段选中
function onMoreKeydown(event) {
  if (!moreOpen.value) return
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  closeMore()
}

const { isCompact } = useViewport()
watch(isCompact, (compact) => {
  if (!compact) closeMore()
})

onMounted(() => window.addEventListener('keydown', onMoreKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onMoreKeydown, true))
</script>

<style scoped>
.ed-top-wrap { flex: 0 0 auto; display: flex; flex-direction: column; }
/* 基础态两行容器均为 display:contents，宽屏 DOM 与视觉保持与改造前一致 */
.ed-top-row1, .ed-top-row2 { display: contents; }
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
/* 行 1 保存状态标签：仅窄屏出现 */
.ed-save-chip { display: none; }
.ed-action {
  height: 28px; padding: 0 9px; display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border); border-radius: 7px; background: var(--bg-2);
  color: var(--text-1); font-size: 10px; cursor: pointer; white-space: nowrap;
}
.ed-action:hover { border-color: var(--accent); color: var(--text-0); }
.ed-action:disabled { opacity: .45; cursor: not-allowed; }
/* 检查器开关只在平板/窄桌面出现；更多按钮只在窄屏出现 */
.ed-icon-inspector, .ed-more-btn { display: none; }
.ed-more-pop, .ed-more-backdrop { display: none; }
.ed-readonly-bar {
  margin: 0; padding: 5px 14px; border-bottom: 1px solid var(--border);
  background: var(--bg-2); color: var(--text-3); font-size: 10px;
}
@media (max-width: 1180px) {
  .ed-episode { max-width: 150px; }
  .ed-action span { display: none; }
  .ed-action { width: 28px; padding: 0; justify-content: center; }
  .ed-icon-inspector { display: inline-flex; }
}
@media (max-width: 900px) {
  /* 两行工具栏：行 1 返回/标题/状态，行 2 撤销重做保存与主操作；允许换行、不横向滚动 */
  .ed-top-wrap { position: relative; z-index: 56; }
  .ed-top { height: auto; min-height: 52px; padding: 6px 8px; flex-wrap: wrap; gap: 4px; }
  .ed-top-row1 { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; }
  .ed-top-row2 { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; }
  .ed-top-left { flex-wrap: wrap; gap: 6px; }
  .ed-brand, .ed-episode { display: none; }
  .ed-top-center { border-left: 0; padding-left: 0; gap: 6px; flex-wrap: wrap; }
  .ed-top-right { margin-left: auto; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .ed-save-chip { display: inline-flex; }
  .ed-top .ed-icon, .ed-top .ed-action { min-width: 44px; min-height: 44px; }
  .ed-top-center .ed-save { min-height: 44px; }
  .ed-action { width: auto; padding: 0 10px; }
  /* 次级操作仅在「更多」浮层中提供 */
  .ed-act-suggest, .ed-act-rough, .ed-act-revisions, .ed-icon-shortcuts, .ed-icon-discard { display: none; }
  /* 行 2 顺序：导出 / 媒体 / 检查器 / 字幕 / 更多 */
  .ed-act-export { order: 1; }
  .ed-icon-media { order: 2; }
  .ed-icon-inspector { order: 3; display: inline-flex; }
  .ed-icon-subtitles { order: 4; }
  .ed-more-btn { order: 5; display: inline-flex; }
  .ed-more-backdrop { display: block; position: fixed; inset: 0; z-index: 1; background: transparent; }
  .ed-more-pop {
    position: absolute; top: calc(100% + 4px); right: 8px; z-index: 2;
    display: flex; flex-direction: column; min-width: 224px; padding: 6px;
    border: 1px solid var(--border); border-radius: 12px; background: var(--bg-1);
    box-shadow: 0 12px 32px rgb(0 0 0 / 32%);
  }
  .ed-more-item {
    min-height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 10px;
    border: 0; border-radius: 8px; background: transparent; color: var(--text-1);
    font-size: 12px; text-align: left; cursor: pointer;
  }
  .ed-more-item:hover { background: var(--bg-hover); }
  .ed-more-item:disabled { opacity: .45; cursor: not-allowed; }
}
@media (max-width: 1180px) and (hover: none) and (pointer: coarse) {
  /* 粗指针下顶栏图标与操作按钮至少 44px 命中 */
  .ed-top .ed-icon, .ed-top .ed-action { min-width: 44px; min-height: 44px; }
}
</style>
