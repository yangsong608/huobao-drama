<script setup lang="ts">
defineProps<{
  icon?: string
  title: string
  description?: string
  actionLabel?: string
  compact?: boolean
}>()

const emit = defineEmits<{ action: [] }>()
</script>

<template>
  <div class="studio-empty" :class="{ compact }">
    <slot name="icon">
      <span v-if="icon" class="studio-empty-icon" aria-hidden="true">{{ icon }}</span>
    </slot>
    <p class="studio-empty-title">{{ title }}</p>
    <p v-if="!compact && description" class="studio-empty-desc">{{ description }}</p>
    <slot name="action">
      <button
        v-if="actionLabel"
        type="button"
        class="studio-empty-action focus-ring"
        @click="emit('action')"
      >{{ actionLabel }}</button>
    </slot>
  </div>
</template>

<style scoped>
.studio-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  max-width: 360px;
  margin: 0 auto;
  padding: 24px 16px;
  text-align: center;
}
.studio-empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  line-height: 1;
  color: var(--text-3);
}
.studio-empty-title {
  font-size: var(--text-strong);
  font-weight: 600;
  line-height: 1.4;
  color: var(--text-0);
}
.studio-empty-desc {
  font-size: var(--text-label);
  line-height: 1.55;
  color: var(--text-2);
}
.studio-empty-action {
  height: var(--control-sm);
  margin-top: 4px;
  padding: 0 14px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--button-bg);
  color: var(--button-text);
  font-size: var(--text-meta);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.studio-empty-action:hover {
  background: var(--button-bg-hover);
  color: var(--button-text-hover);
}
.studio-empty.compact .studio-empty-icon { display: none; }
.studio-empty.compact .studio-empty-desc { display: none; }
.studio-empty.compact { padding: 12px 16px; }
</style>
