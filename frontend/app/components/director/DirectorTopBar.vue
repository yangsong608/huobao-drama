<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { History, Loader2, Save, SlidersHorizontal, Sparkles } from 'lucide-vue-next'
import StudioTopBar from '~/components/studio/StudioTopBar.vue'
import type { DirectorSaveStatus } from '~/composables/useDirectorPlan'

const props = defineProps<{
  title: string
  mode: 'off' | 'readonly' | 'on'
  canEdit: boolean
  version: number
  view: '2d' | '3d'
  view3dEnabled?: boolean
  saveStatus: DirectorSaveStatus
  saveError?: string
  note: string
  lastSavedAt?: string
  canApply: boolean
  applying: boolean
  applyBlockedReason?: string
  directorAgentEnabled?: boolean
}>()

const emit = defineEmits<{
  'update:view': [value: '2d' | '3d']
  'update:note': [value: string]
  save: []
  retry: []
  'open-revisions': []
  'open-apply': []
  'open-director-agent': []
}>()

const { t } = useI18n()

const modeLabel = computed(() => t(`director.mode.${props.mode}`))

const saveStatusLabel = computed(() => {
  if (props.saveStatus === 'idle') {
    return props.version > 0 ? t('director.save.idle') : t('director.topbar.unsaved')
  }
  return t(`director.save.${props.saveStatus}`)
})

const lastSavedLabel = computed(() => (
  props.lastSavedAt ? t('director.save.savedAt', { time: formatTime(props.lastSavedAt) }) : ''
))

const noteModel = computed({
  get: () => props.note,
  set: (value: string) => emit('update:note', value),
})

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString()
}
</script>

<template>
  <StudioTopBar dense class="director-topbar">
    <template #left>
      <div class="director-title-block">
        <span class="director-title">{{ props.title }}</span>
        <span class="director-mode" :class="`is-${props.mode}`">{{ modeLabel }}</span>
      </div>
    </template>
    <template #center>
      <div class="director-view-tabs" role="tablist" :aria-label="t('director.tab.label')">
        <button
          type="button"
          role="tab"
          :aria-selected="props.view === '2d'"
          :class="['director-view-tab', { active: props.view === '2d' }]"
          @click="emit('update:view', '2d')"
        >
          {{ t('director.subtab.2d') }}
        </button>
        <button
          v-if="props.view3dEnabled"
          type="button"
          role="tab"
          :aria-selected="props.view === '3d'"
          :class="['director-view-tab', { active: props.view === '3d' }]"
          @click="emit('update:view', '3d')"
        >
          {{ t('director.subtab.3d') }}
        </button>
      </div>
    </template>
    <template #right>
      <span
        v-if="props.canEdit"
        :class="['director-save-state', `is-${props.saveStatus}`]"
        :title="props.saveError || ''"
      >
        <Loader2 v-if="props.saveStatus === 'saving'" :size="11" class="animate-spin" />
        {{ saveStatusLabel }}
      </span>
      <span v-if="props.lastSavedAt" class="director-saved-at">{{ lastSavedLabel }}</span>
      <span class="director-version">
        {{ props.version > 0 ? t('director.topbar.version', { version: props.version }) : t('director.topbar.unsaved') }}
      </span>
      <template v-if="props.canEdit">
        <input
          v-model="noteModel"
          class="director-note-input"
          type="text"
          maxlength="200"
          :placeholder="t('director.save.notePlaceholder')"
        />
        <button
          type="button"
          class="director-action-btn is-primary"
          :disabled="props.saveStatus === 'saving'"
          @click="emit('save')"
        >
          <Loader2 v-if="props.saveStatus === 'saving'" :size="12" class="animate-spin" />
          <Save v-else :size="12" />
          {{ t('director.save.save') }}
        </button>
        <button v-if="props.saveStatus === 'error'" type="button" class="director-action-btn" @click="emit('retry')">
          {{ t('director.save.retry') }}
        </button>
        <button
          type="button"
          class="director-action-btn is-apply"
          :disabled="!props.canApply || props.applying"
          :title="props.applyBlockedReason || ''"
          @click="emit('open-apply')"
        >
          <Loader2 v-if="props.applying" :size="12" class="animate-spin" />
          <SlidersHorizontal v-else :size="12" />
          {{ t('director.apply.open') }}
        </button>
      </template>
      <button
        v-if="props.directorAgentEnabled"
        type="button"
        class="director-action-btn is-agent"
        :title="t('director.agent.hint')"
        @click="emit('open-director-agent')"
      >
        <Sparkles :size="12" />
        {{ t('director.agent.open') }}
      </button>
      <button
        v-if="props.canEdit || props.version > 0"
        type="button"
        class="director-action-btn"
        @click="emit('open-revisions')"
      >
        <History :size="12" />
        {{ t('director.revisions.title') }}
      </button>
      <span v-if="!props.canEdit" class="director-readonly">{{ t('director.topbar.readonly') }}</span>
    </template>
  </StudioTopBar>
</template>

<style scoped>
.director-topbar { flex-shrink: 0; }
.director-title-block {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.director-title {
  font-size: var(--text-strong);
  font-weight: 650;
  color: var(--text-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.director-mode {
  flex-shrink: 0;
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  font-size: var(--text-meta);
  color: var(--text-2);
  background: var(--bg-1);
}
.director-mode.is-on {
  border-color: var(--accent-border, var(--accent));
  color: var(--accent);
}
.director-view-tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
}
.director-view-tab {
  height: var(--control-xs);
  padding: 0 12px;
  border: none;
  border-radius: calc(var(--radius-sm) - 2px);
  background: transparent;
  color: var(--text-2);
  font-size: var(--text-meta);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.director-view-tab:hover { color: var(--text-0); background: var(--bg-hover); }
.director-view-tab.active { color: var(--text-0); background: var(--panel-bg); box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.08)); }
.director-version {
  font-size: var(--text-meta);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.director-readonly {
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: var(--bg-1);
  color: var(--text-2);
  font-size: var(--text-meta);
  flex-shrink: 0;
}
.director-save-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-1);
  color: var(--text-2);
  font-size: var(--text-meta);
  white-space: nowrap;
}
.director-save-state.is-dirty { color: var(--warning, #b7791f); border-color: color-mix(in srgb, var(--warning, #b7791f) 45%, var(--border)); }
.director-save-state.is-saving { color: var(--accent); border-color: var(--accent); }
.director-save-state.is-saved { color: var(--success, #1a9d5a); border-color: color-mix(in srgb, var(--success, #1a9d5a) 45%, var(--border)); }
.director-save-state.is-error,
.director-save-state.is-conflict { color: var(--action-danger, #c0392b); border-color: color-mix(in srgb, var(--action-danger, #c0392b) 45%, var(--border)); }
.director-saved-at {
  flex-shrink: 0;
  font-size: var(--text-meta);
  color: var(--text-3);
  white-space: nowrap;
}
.director-note-input {
  width: 128px;
  min-width: 0;
  height: var(--control-xs);
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  color: var(--text-0);
  font-size: var(--text-meta);
  flex-shrink: 1;
}
.director-note-input::placeholder { color: var(--text-3); }
.director-note-input:focus { outline: none; border-color: var(--accent); }
.director-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  height: var(--control-xs);
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  color: var(--text-1);
  font-size: var(--text-meta);
  white-space: nowrap;
  cursor: pointer;
}
.director-action-btn:hover { border-color: var(--accent); color: var(--text-0); }
.director-action-btn.is-primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast, #fff);
}
.director-action-btn.is-apply {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  color: var(--accent);
}
.director-action-btn.is-agent {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: var(--accent-soft, rgba(88, 166, 255, 0.08));
  color: var(--accent);
}
.director-action-btn:disabled { opacity: 0.55; cursor: not-allowed; }
@media (max-width: 1440px) {
  .director-saved-at { display: none; }
  .director-note-input { width: 104px; }
}
</style>
