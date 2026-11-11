<template>
  <nav class="episode-mobile-tabs" role="tablist" :aria-label="t('episode.mobileTabs.label')">
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      role="tab"
      class="episode-mobile-tab"
      :class="{ on: active === item.id }"
      :aria-selected="active === item.id"
      @click="emit('select', item.id)"
    >
      <component :is="item.icon" :size="18" :stroke-width="1.9" />
      <span class="episode-mobile-tab-label">{{ item.label }}</span>
      <span v-if="item.badge" class="episode-mobile-tab-badge">{{ item.badge }}</span>
    </button>
  </nav>
</template>

<script setup>
import { Clapperboard, FileText, FolderKanban, ListTodo, Sparkles } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  active: { type: String, default: '' },
  shots: { type: Number, default: 0 },
  assetsReady: { type: Number, default: 0 },
  assetsTotal: { type: Number, default: 0 },
  tasks: { type: Number, default: 0 },
})
const emit = defineEmits(['select'])
const { t } = useI18n()

const items = computed(() => [
  { id: 'script', label: t('episode.mobileTabs.script'), icon: FileText },
  { id: 'storyboard', label: t('episode.mobileTabs.storyboard'), icon: Clapperboard, badge: props.shots ? String(props.shots) : '' },
  {
    id: 'assets',
    label: t('episode.mobileTabs.assets'),
    icon: FolderKanban,
    badge: props.assetsTotal ? `${props.assetsReady}/${props.assetsTotal}` : '',
  },
  { id: 'generate', label: t('episode.mobileTabs.generate'), icon: Sparkles },
  { id: 'tasks', label: t('episode.mobileTabs.tasks'), icon: ListTodo, badge: props.tasks ? String(props.tasks) : '' },
])
</script>

<style scoped>
.episode-mobile-tabs {
  display: flex;
  flex-shrink: 0;
  height: 54px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.episode-mobile-tab {
  position: relative;
  flex: 1;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 4px 2px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  font: 700 11px var(--font-body);
  line-height: 1.1;
  cursor: pointer;
}

.episode-mobile-tab.on {
  color: var(--text-0);
  background: var(--bg-active);
}

.episode-mobile-tab:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--button-focus);
}

.episode-mobile-tab-label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.episode-mobile-tab-badge {
  position: absolute;
  top: 4px;
  right: calc(50% - 24px);
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--surface-outline);
  color: var(--text-2);
  font: 700 9px/15px var(--font-mono);
  text-align: center;
}

.episode-mobile-tab.on .episode-mobile-tab-badge {
  background: var(--accent-bg);
  color: var(--accent-text);
}

@media (min-width: 744px) {
  .episode-mobile-tabs { display: none; }
}
</style>
