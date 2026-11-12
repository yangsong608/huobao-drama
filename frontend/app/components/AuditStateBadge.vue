<template>
  <button
    v-if="state && state !== 'pass'"
    type="button"
    :class="['audit-state-badge', `is-${state}`, severity && `severity-${severity}`]"
    :title="title"
    :aria-label="title"
    @click.stop="$emit('open')"
  >
    <Loader2 v-if="state === 'running'" :size="12" class="audit-state-spin" />
    <XCircle v-else-if="state === 'error' || (state === 'stale' && severity === 'error')" :size="12" />
    <AlertTriangle v-else-if="state === 'warning' || (state === 'stale' && severity === 'warning')" :size="12" />
    <Info v-else-if="state === 'stale' && severity === 'info'" :size="12" />
    <ShieldCheck v-else-if="state === 'rule_only'" :size="12" />
    <AlertCircle v-else-if="state === 'failed'" :size="12" />
    <Clock v-else-if="state === 'pending' || state === 'queued'" :size="12" />
    <span v-else class="audit-state-dot" aria-hidden="true" />
    <span v-if="count > 0" class="audit-state-count">{{ count }}</span>
    <span v-if="state === 'stale'" class="audit-state-stale" aria-hidden="true" />
  </button>
</template>

<script setup>
import { Loader2, XCircle, AlertTriangle, AlertCircle, ShieldCheck, Clock, Info } from 'lucide-vue-next'

defineProps({
  state: { type: String, default: '' },
  severity: { type: String, default: '' },
  count: { type: Number, default: 0 },
  title: { type: String, default: '' },
})
defineEmits(['open'])
</script>

<style scoped>
.audit-state-badge {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 28px;
  min-height: 28px;
  padding: 0 5px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
}
.audit-state-badge:hover { background: var(--bg-2); }
.audit-state-spin { animation: audit-spin 0.9s linear infinite; }
@keyframes audit-spin { to { transform: rotate(360deg); } }
.audit-state-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.audit-state-count {
  font-size: 9px;
  font-weight: 800;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.audit-state-badge.is-pending,
.audit-state-badge.is-queued { color: var(--text-3); background: var(--bg-2); }
.audit-state-badge.is-running { color: var(--accent-text); background: var(--accent-bg); }
.audit-state-badge.is-warning { color: var(--warning); background: var(--warning-bg, rgba(180, 120, 20, 0.1)); }
.audit-state-badge.is-error { color: var(--danger); background: var(--danger-bg, rgba(190, 60, 50, 0.1)); }
.audit-state-badge.is-failed { color: var(--danger); background: var(--danger-bg, rgba(190, 60, 50, 0.1)); }
.audit-state-badge.is-rule_only { color: var(--accent-text); background: var(--accent-bg); }
.audit-state-badge.is-stale { color: var(--warning); background: var(--bg-2); border-style: dashed; border-color: var(--border); }
.audit-state-badge.is-stale.severity-error { color: var(--danger); }
.audit-state-badge.is-stale.severity-warning { color: var(--warning); }
.audit-state-stale {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warning);
  box-shadow: 0 0 0 1.5px var(--surface);
}
</style>
