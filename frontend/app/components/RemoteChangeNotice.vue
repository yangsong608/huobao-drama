<template>
  <div v-if="visible" class="remote-change-notice" role="status">
    <RefreshCw :size="14" class="remote-change-icon" aria-hidden="true" />
    <span class="remote-change-text">{{ t('remote.sync.remoteUpdate') }}</span>
    <div class="remote-change-actions">
      <button type="button" class="btn btn-sm remote-change-refresh" @click="emit('refresh')">
        {{ t('remote.sync.refresh') }}
      </button>
      <button type="button" class="btn btn-ghost btn-sm remote-change-keep" @click="emit('dismiss')">
        {{ t('remote.sync.keepMine') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { RefreshCw } from 'lucide-vue-next'

defineProps<{ visible: boolean }>()
const emit = defineEmits<{ (event: 'refresh'): void; (event: 'dismiss'): void }>()
const { t } = useI18n()
</script>

<style scoped>
.remote-change-notice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 8px;
  padding: 8px 12px;
  border: 1px solid var(--warn-border);
  border-radius: var(--radius);
  background: var(--warn-bg);
  color: var(--warn-text);
  font-size: 12px;
  line-height: 1.5;
}
.remote-change-icon { flex: 0 0 auto; }
.remote-change-text { flex: 1 1 220px; min-width: 0; }
.remote-change-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.remote-change-notice :deep(.btn) { min-height: var(--tap-min); }
@media (pointer: coarse) {
  .remote-change-actions { width: 100%; margin-left: 0; }
  .remote-change-actions :deep(.btn) { flex: 1 1 auto; }
}
</style>
