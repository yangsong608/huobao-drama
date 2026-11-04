<template>
  <div class="card compass-toolbar">
    <div class="toolbar-group">
      <button
        type="button"
        class="btn btn-primary btn-sm"
        :disabled="running || !canGenerateBase"
        :title="!canGenerateBase ? t('novels.compass.emptyArchitecture') : ''"
        @click="emit('generate')"
      >
        {{ graphGenerated ? t('novels.compass.regenerate') : t('novels.compass.generate') }}
      </button>
      <button
        v-if="graphGenerated"
        type="button"
        class="btn btn-sm"
        :disabled="running || !hasChapters"
        :title="!hasChapters ? t('novels.compass.noWrittenChapters') : ''"
        @click="emit('snapshots')"
      >
        {{ t('novels.compass.snapshots') }}
      </button>
      <button
        v-if="graphGenerated"
        type="button"
        class="btn btn-sm"
        :disabled="running"
        @click="emit('audit')"
      >
        {{ t('novels.compass.audit') }}
        <span v-if="auditCount" class="tag tag-accent">{{ auditCount }}</span>
      </button>
    </div>

    <div class="toolbar-group">
      <button v-if="running" type="button" class="btn btn-danger btn-sm" @click="emit('cancel')">
        {{ t('novels.compass.cancel') }}
      </button>
      <template v-else>
        <button
          v-if="graphGenerated"
          type="button"
          class="btn btn-sm"
          :class="{ 'btn-ghost': auditVisible }"
          @click="emit('toggle-audit')"
        >
          {{ t('novels.compass.showAudit') }}
        </button>
        <button v-if="graphGenerated" type="button" class="btn btn-sm" @click="emit('reset-view')">
          {{ t('novels.compass.resetView') }}
        </button>
        <button v-if="graphGenerated" type="button" class="btn btn-sm" @click="emit('export-png')">
          {{ t('novels.compass.exportPng') }}
        </button>
        <button v-if="graphGenerated" type="button" class="btn btn-sm" @click="emit('export-html')">
          {{ t('novels.compass.exportHtml') }}
        </button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  running: boolean
  graphGenerated: boolean
  hasChapters: boolean
  canGenerateBase: boolean
  auditCount: number
  auditVisible: boolean
}>()

const emit = defineEmits<{
  (event: 'generate'): void
  (event: 'snapshots'): void
  (event: 'audit'): void
  (event: 'toggle-audit'): void
  (event: 'export-png'): void
  (event: 'export-html'): void
  (event: 'reset-view'): void
  (event: 'cancel'): void
}>()

const { t } = useI18n()
</script>

<style scoped>
.compass-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
}
.toolbar-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
