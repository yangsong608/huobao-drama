<template>
  <div
    v-if="reason"
    :class="['media-capability', `is-${reason}`, `is-${mode}`]"
    role="status"
    aria-live="polite"
  >
    <template v-if="mode === 'inline'">
      <span class="media-capability-badge" :title="inlineTitle">{{ inlineLabel }}</span>
    </template>
    <template v-else>
      <div class="media-capability-copy">
        <b>{{ title }}</b>
        <span v-if="body">{{ body }}</span>
        <span v-if="reason === 'unavailable'" class="media-capability-hint">{{ t('media.capability.settingsHint') }}</span>
      </div>
      <div class="media-capability-actions">
        <button
          v-if="reason !== 'loading' && showRetry"
          type="button"
          class="btn btn-sm"
          :disabled="state === 'loading'"
          @click="refresh"
        >
          {{ t('media.capability.retry') }}
        </button>
        <NuxtLink v-if="showConnect" class="btn btn-sm media-capability-connect" :to="connectTarget">
          {{ t('export.gate.connect') }}
        </NuxtLink>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { isAppClient } from '~/composables/useAppBridge'
import { useRemoteRole } from '~/composables/useRemoteGuest'
import { useMediaCapabilities, type MediaCapabilityAction } from '~/composables/useMediaCapabilities'

const props = withDefaults(defineProps<{
  action?: MediaCapabilityAction
  mode?: 'banner' | 'inline'
  showRetry?: boolean
}>(), {
  action: 'output',
  mode: 'banner',
  showRetry: true,
})

const { t } = useI18n()
const caps = useMediaCapabilities()
const role = useRemoteRole()
const reason = computed(() => caps.blockReason(props.action))
const state = computed(() => caps.state.value)
const showConnect = computed(() => isAppClient()
  && !(role.role === 'guest' && role.paired)
  && reason.value === 'unavailable')
const connectTarget = { path: '/settings', query: { tab: 'device' } }

const title = computed(() => {
  if (reason.value === 'loading') return t('media.capability.loading')
  if (reason.value === 'failed') return t('media.capability.failed')
  return t('media.capability.unavailableTitle')
})
const body = computed(() => {
  if (reason.value === 'unavailable') return t('media.capability.unavailableBody')
  return ''
})
const inlineLabel = computed(() => {
  if (reason.value === 'unavailable') return t('media.capability.badge')
  if (reason.value === 'failed') return '!'
  return '…'
})
const inlineTitle = computed(() => {
  if (reason.value === 'unavailable') {
    return props.action === 'probe'
      ? t('media.capability.probeDisabled')
      : t('media.capability.actionDisabled')
  }
  return title.value
})

function refresh() {
  void caps.refresh()
}
</script>

<style scoped>
.media-capability {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--warning);
  border-radius: var(--radius-md, 8px);
  background: var(--bg-1);
}
.media-capability.is-loading {
  border-left-color: var(--accent);
}
.media-capability-copy {
  flex: 1;
  min-width: 180px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.media-capability-copy b {
  font-size: 11.5px;
  color: var(--text-0);
}
.media-capability-copy span {
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--text-3);
}
.media-capability-hint {
  color: var(--text-2) !important;
}
.media-capability-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.media-capability-connect {
  border-color: var(--accent);
  color: var(--accent-text);
}
.media-capability.is-inline {
  display: inline-flex;
  padding: 0;
  border: 0;
  background: transparent;
}
.media-capability-badge {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border: 1px dashed var(--warning);
  border-radius: 999px;
  color: var(--warning);
  font-size: 10.5px;
  font-weight: 650;
  white-space: nowrap;
}
.is-inline.is-loading .media-capability-badge {
  border-color: var(--accent);
  color: var(--accent-text);
}
.is-inline.is-failed .media-capability-badge {
  border-color: var(--error);
  color: var(--error);
}
@media (max-width: 1180px) {
  .media-capability-actions .btn {
    min-height: 44px;
    padding: 0 14px;
  }
}
</style>
