<template>
  <div v-if="visible" ref="rootEl" class="remote-status-badge">
    <button
      type="button"
      class="rsb-trigger"
      :class="`tone-${triggerTone}`"
      :aria-label="triggerAria"
      :aria-expanded="isGuest ? panelOpen : undefined"
      :aria-haspopup="isGuest ? 'true' : 'dialog'"
      @click="onTrigger"
    >
      <span class="rsb-dot" aria-hidden="true" />
      <MonitorSmartphone :size="14" :stroke-width="1.8" />
      <span class="rsb-label">{{ triggerText }}</span>
      <span v-if="!isGuest && onlineCount" class="rsb-count">{{ onlineCount }}</span>
      <span v-if="readonlyGuest" class="rsb-tag">{{ t('remote.readonly.badge') }}</span>
      <ChevronDown v-if="isGuest" :size="12" class="rsb-chevron" :class="{ 'is-open': panelOpen }" />
    </button>

    <div
      v-if="isGuest && panelOpen"
      class="rsb-panel"
      role="group"
      :aria-label="t('remote.badge.panelTitle')"
    >
      <div class="rsb-panel-head">
        <MonitorSmartphone :size="16" :stroke-width="1.8" />
        <strong>{{ t('remote.badge.connected') }}</strong>
        <span v-if="readonlyGuest" class="rsb-tag">{{ t('remote.readonly.badge') }}</span>
      </div>
      <dl class="rsb-facts">
        <div>
          <dt>{{ t('remote.badge.hostName') }}</dt>
          <dd>{{ hostName }}</dd>
        </div>
        <div>
          <dt>{{ t('remote.badge.hostPage') }}</dt>
          <dd>{{ hostPage }}</dd>
        </div>
        <div>
          <dt>{{ t('remote.badge.syncLabel') }}</dt>
          <dd class="rsb-sync" :class="`tone-${syncTone}`">
            <span class="rsb-sync-dot" aria-hidden="true" />
            {{ syncText }}
          </dd>
        </div>
      </dl>
      <p v-if="readonlyGuest" class="rsb-hint">{{ t('remote.readonly.notice') }}</p>
      <div class="rsb-actions">
        <button type="button" class="btn" @click="rePair">
          <RefreshCw :size="13" />
          {{ t('remote.badge.rePair') }}
        </button>
        <button type="button" class="btn btn-danger" @click="logout">
          <LogOut :size="13" />
          {{ t('remote.badge.logout') }}
        </button>
      </div>
    </div>

    <RemoteAccessDialog v-if="!isGuest" :open="dialogOpen" :next="currentPath" @close="onDialogClose" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ChevronDown, LogOut, MonitorSmartphone, RefreshCw } from 'lucide-vue-next'
import RemoteAccessDialog from '~/components/RemoteAccessDialog.vue'
import { usePresence, presencePageLabel } from '~/composables/usePresence'
import { useRealtimeSync } from '~/composables/useRealtimeSync'
import { logoutRemoteSession, sanitizeRemoteNext, useRemoteRole } from '~/composables/useRemoteGuest'
import { remotePairingAPI, type RemoteStatus } from '~/composables/useRemotePairing'
import { isAppClient } from '~/composables/useAppBridge'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const role = useRemoteRole()
const { state: syncState } = useRealtimeSync()
const { state: presence, start, stop, refresh } = usePresence()

const rootEl = ref<HTMLElement | null>(null)
const hostVisible = ref(false)
const hostActiveCount = ref(0)
const dialogOpen = ref(false)
const panelOpen = ref(false)

const isGuest = computed(() => role.role === 'guest' && role.paired)
const readonlyGuest = computed(() => isGuest.value && role.readonly)
const isAppMode = isAppClient()
const visible = computed(() => !isAppMode && (isGuest.value || hostVisible.value))
const currentPath = computed(() => route.fullPath)
const guestEntries = computed(() => presence.entries.filter(entry => entry.role === 'guest'))
const hostEntry = computed(() => presence.entries.find(entry => entry.role === 'host') || null)
const onlineCount = computed(() => (presence.ready ? guestEntries.value.length : hostActiveCount.value))

const hostName = computed(() =>
  hostEntry.value?.name || role.serverName || t('remote.badge.hostFallback'),
)
const hostPage = computed(() => presencePageLabel(hostEntry.value?.context) || t('remote.badge.unknownPage'))

const syncTone = computed(() => {
  if (syncState.status === 'unpaired') return 'error'
  if (syncState.conflict) return 'warning'
  if (syncState.status === 'offline' || syncState.status === 'reconnecting') return 'error'
  if (syncState.status === 'connecting' || syncState.status === 'idle') return 'pending'
  return 'ok'
})
const syncText = computed(() => {
  if (syncState.status === 'unpaired' || (role.role === 'guest' && !role.paired)) {
    return t('remote.badge.sync.unpaired')
  }
  if (syncState.conflict) return t('remote.badge.sync.conflict')
  if (syncState.status === 'offline' || syncState.status === 'reconnecting') {
    return t('remote.badge.sync.offline')
  }
  if (syncState.status === 'connecting' || syncState.status === 'idle') {
    return t('remote.badge.sync.connecting')
  }
  return t('remote.badge.sync.online')
})

const triggerTone = computed(() => {
  if (!isGuest.value) return onlineCount.value > 0 ? 'ok' : 'idle'
  return syncTone.value
})
const triggerText = computed(() => (isGuest.value ? t('remote.badge.connected') : t('remote.badge.hostEntry')))
const triggerAria = computed(() => {
  if (isGuest.value) {
    return readonlyGuest.value
      ? t('remote.badge.ariaGuestReadonly', { host: hostName.value })
      : t('remote.badge.ariaGuest', { host: hostName.value })
  }
  return t('remote.badge.ariaHost', { n: onlineCount.value })
})

function applyHostStatus(running: boolean, activeDevices: number): void {
  hostActiveCount.value = Math.max(0, activeDevices)
  hostVisible.value = running || activeDevices > 0
  if (hostVisible.value) start()
  else stop()
}

async function loadHostStatus(): Promise<void> {
  if (isAppMode || role.role !== 'host' || !role.ready) return
  try {
    const status: RemoteStatus | null = await remotePairingAPI.status()
    const active = (status?.devices ?? []).filter(device => device.status === 'active').length
    applyHostStatus(Boolean(status?.running), active)
  } catch {
    hostVisible.value = false
    stop()
  }
}

function syncPresenceMode(): void {
  if (isAppMode) {
    hostVisible.value = false
    hostActiveCount.value = 0
    stop()
    return
  }
  if (isGuest.value) {
    hostVisible.value = false
    hostActiveCount.value = 0
    start()
    return
  }
  if (role.role === 'host' && role.ready) {
    void loadHostStatus()
    return
  }
  stop()
}

function onRemoteStatusEvent(event: Event): void {
  if (isAppMode || !role.ready || role.role === 'guest') return
  const detail = (event as CustomEvent)?.detail || {}
  applyHostStatus(Boolean(detail.running), Number(detail.activeDevices) || 0)
}

function onTrigger(): void {
  if (isGuest.value) {
    panelOpen.value = !panelOpen.value
    if (panelOpen.value) void refresh()
    return
  }
  if (hostVisible.value) dialogOpen.value = true
}

function onDialogClose(): void {
  dialogOpen.value = false
  void loadHostStatus()
}

function nextPath(): string {
  return sanitizeRemoteNext(`${window.location.pathname}${window.location.search}${window.location.hash}`)
}

function rePair(): void {
  panelOpen.value = false
  void router.push(`/pair?next=${encodeURIComponent(nextPath())}`)
}

async function logout(): Promise<void> {
  panelOpen.value = false
  try {
    await logoutRemoteSession()
  } finally {
    window.location.assign(`/pair?next=${encodeURIComponent(nextPath())}`)
  }
}

function onDocumentPointerDown(event: Event): void {
  if (rootEl.value?.contains(event.target as Node)) return
  panelOpen.value = false
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') panelOpen.value = false
}

function bindPanelDismiss(): void {
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onDocumentKeydown)
}

function unbindPanelDismiss(): void {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('keydown', onDocumentKeydown)
}

watch(panelOpen, (open) => { open ? bindPanelDismiss() : unbindPanelDismiss() })
watch(isGuest, (guest) => { if (!guest) panelOpen.value = false })
watch(() => route.fullPath, () => { panelOpen.value = false })

watch(
  [() => role.ready, () => role.role, () => role.paired],
  syncPresenceMode,
  { immediate: true },
)

onMounted(() => {
  window.addEventListener('huobao:remote-status', onRemoteStatusEvent)
})

onBeforeUnmount(() => {
  window.removeEventListener('huobao:remote-status', onRemoteStatusEvent)
  unbindPanelDismiss()
  stop()
})
</script>

<style scoped>
.remote-status-badge { position: relative; display: inline-flex; }
.rsb-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.18s var(--ease-out);
}
.rsb-trigger:hover { color: var(--text-0); background: var(--bg-hover); }
.rsb-trigger:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.rsb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-3);
}
.rsb-trigger.tone-ok .rsb-dot { background: var(--success); }
.rsb-trigger.tone-warning .rsb-dot { background: var(--warning); }
.rsb-trigger.tone-error .rsb-dot { background: var(--error); }
.rsb-trigger.tone-pending .rsb-dot { background: var(--warning); }
.rsb-label { overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
.rsb-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 10px;
  font-weight: 700;
}
.rsb-tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: var(--radius-pill);
  background: var(--warn-bg);
  color: var(--warn-text);
  font-size: 10px;
  font-weight: 700;
}
.rsb-chevron { transition: transform 0.18s var(--ease-out); }
.rsb-chevron.is-open { transform: rotate(180deg); }

.rsb-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 60;
  width: min(320px, calc(100vw - 24px));
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  box-shadow: var(--shadow-elevated);
  color: var(--text-1);
}
.rsb-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-0);
  font-size: 13px;
}
.rsb-panel-head strong { flex: 1; min-width: 0; }
.rsb-facts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 10px 0 0;
}
.rsb-facts > div { display: grid; grid-template-columns: 82px 1fr; gap: 8px; align-items: start; }
.rsb-facts dt { font-size: 11.5px; color: var(--text-3); }
.rsb-facts dd {
  margin: 0;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
  word-break: break-word;
}
.rsb-sync { display: inline-flex; align-items: center; gap: 6px; }
.rsb-sync-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); flex-shrink: 0; }
.rsb-sync.tone-ok .rsb-sync-dot { background: var(--success); }
.rsb-sync.tone-warning .rsb-sync-dot { background: var(--warning); }
.rsb-sync.tone-error .rsb-sync-dot { background: var(--error); }
.rsb-sync.tone-pending .rsb-sync-dot { background: var(--warning); }
.rsb-hint {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--warn-bg);
  color: var(--warn-text);
  font-size: 11.5px;
  line-height: 1.55;
}
.rsb-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
  flex-wrap: wrap;
}
.rsb-actions .btn { min-height: 36px; }

@media (max-width: 900px) {
  .rsb-label { max-width: 110px; }
}

@media (hover: none) and (pointer: coarse) {
  .rsb-trigger { min-height: 44px; padding: 0 12px; }
  .rsb-actions .btn { min-height: 44px; flex: 1; }
}
</style>
