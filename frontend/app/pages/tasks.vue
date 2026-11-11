<template>
  <div class="tasks-page">
    <div class="tasks-head">
      <h1 class="tasks-title">{{ t('queue.title') }}</h1>
      <p class="tasks-sub">{{ t('queue.desc') }}</p>
    </div>
    <QueuePanel />
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import QueuePanel from '~/components/QueuePanel.vue'

const { t } = useI18n()
</script>

<style scoped>
.tasks-page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px calc(20px + var(--safe-bottom, 0px));
}

.tasks-head { margin-bottom: 16px; }
.tasks-title { margin: 0; font-size: 20px; font-weight: 700; color: var(--text-0); }
.tasks-sub { margin: 4px 0 0; font-size: 12.5px; color: var(--text-3); }

@media (max-width: 743px) {
  .tasks-page { padding: 14px 14px calc(16px + var(--safe-bottom, 0px)); }
  .tasks-title { font-size: 18px; }
}
</style>
