<template>
  <div class="chapter-graph" :style="{ height: `${height}px` }">
    <CompassGraph v-if="graphData" :snapshot="graphData" :dark="isDark" compact />
    <p v-else class="chapter-graph-empty">{{ t('novels.writer.graphEmpty') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTheme } from '~/composables/useTheme'
import type { GraphSnapshot } from '~/utils/novel-graph'
import CompassGraph from './CompassGraph.vue'

defineProps<{
  graphData: GraphSnapshot | null
  height?: number
}>()

const { t } = useI18n()
const { resolvedTheme } = useTheme()
const isDark = computed(() => resolvedTheme.value === 'dark')
</script>

<style scoped>
.chapter-graph {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--bg-hover);
}
.chapter-graph-empty {
  margin: 0;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  font-size: 12px;
}
</style>
