<script setup lang="ts">
const props = defineProps<{
  title?: string
  width?: 280 | 300 | 320 | 340
  empty?: boolean
}>()

const widthValue = computed(() =>
  props.width ? `${props.width}px` : 'var(--inspector-w)'
)
</script>

<template>
  <aside class="studio-inspector" :style="{ width: widthValue }">
    <div class="studio-inspector-head">
      <slot name="header">
        <span class="studio-inspector-title">{{ props.title }}</span>
      </slot>
    </div>
    <div class="studio-inspector-body">
      <slot v-if="props.empty" name="empty">
        <StudioEmptyState v-if="props.title" :title="props.title" />
      </slot>
      <slot v-else />
    </div>
    <div v-if="$slots.footer" class="studio-inspector-foot">
      <slot name="footer" />
    </div>
  </aside>
</template>

<style scoped>
.studio-inspector {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-width: 0;
  border-left: 1px solid var(--border);
  background: var(--panel-bg);
}
.studio-inspector-head {
  display: flex;
  align-items: center;
  height: 40px;
  min-height: 40px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
}
.studio-inspector-title {
  font-size: var(--text-label);
  font-weight: 650;
  line-height: 1.3;
  color: var(--text-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.studio-inspector-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.studio-inspector-foot {
  flex-shrink: 0;
  border-top: 1px solid var(--border);
}
</style>
