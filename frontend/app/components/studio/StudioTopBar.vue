<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  title?: string
  subtitle?: string
  backTo?: string
  dense?: boolean
}>()

const emit = defineEmits<{ back: [] }>()

const { t } = useI18n()

function onBack() {
  if (props.backTo) {
    navigateTo(props.backTo)
  } else {
    emit('back')
  }
}
</script>

<template>
  <header class="studio-topbar" :class="{ dense: props.dense }">
    <div class="studio-topbar-side studio-topbar-left">
      <slot name="left">
        <button type="button" class="studio-topbar-back focus-ring" :aria-label="t('common.back')" @click="onBack">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
            <path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </slot>
      <div v-if="props.title || $slots.title" class="studio-topbar-titles">
        <slot name="title">
          <span class="studio-topbar-title">{{ props.title }}</span>
        </slot>
        <span v-if="props.subtitle" class="studio-topbar-subtitle">{{ props.subtitle }}</span>
      </div>
    </div>
    <div v-if="$slots.center" class="studio-topbar-center">
      <slot name="center" />
    </div>
    <div v-if="$slots.right" class="studio-topbar-side studio-topbar-right">
      <slot name="right" />
    </div>
  </header>
</template>

<style scoped>
.studio-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--topbar-h);
  min-height: var(--topbar-h);
  padding: 0 var(--topbar-pad-x);
  border-bottom: 1px solid var(--border);
  background: var(--panel-bg);
}
.studio-topbar.dense {
  height: var(--control-lg);
  min-height: var(--control-lg);
}
.studio-topbar-side {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.studio-topbar-left { flex: 1 1 0; }
.studio-topbar-center {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  min-width: 0;
}
.studio-topbar-right {
  flex: 1 1 0;
  justify-content: flex-end;
  gap: 6px;
}
.studio-topbar-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-sm);
  height: var(--control-sm);
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-1);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.studio-topbar-back:hover { background: var(--bg-hover); color: var(--text-0); }
.studio-topbar-titles {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
}
.studio-topbar-title {
  font-size: var(--text-strong);
  font-weight: 650;
  line-height: 1.3;
  color: var(--text-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.studio-topbar-subtitle {
  font-size: var(--text-meta);
  line-height: 1.4;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
