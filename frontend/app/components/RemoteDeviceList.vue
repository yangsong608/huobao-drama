<template>
  <div class="remote-device-list">
    <div v-if="!devices.length" class="rdl-empty">{{ t('remote.devices.empty') }}</div>
    <ul v-else class="rdl-items">
      <li v-for="device in devices" :key="device.id" class="rdl-item" :class="{ 'rdl-inactive': device.status !== 'active' }">
        <div class="rdl-main">
          <div class="rdl-title">
            <span class="rdl-name" :title="device.name">{{ device.name }}</span>
            <span class="tag" :class="device.scope === 'readonly' ? 'tag-info' : 'tag-accent'">
              {{ device.scope === 'readonly' ? t('remote.devices.scopeReadonly') : t('remote.devices.scopeFull') }}
            </span>
            <span
              class="tag"
              :class="statusTagClass(device)"
            >{{ statusText(device) }}</span>
          </div>
          <div class="rdl-meta">
            <span>{{ platformLabel(device.platform) }}</span>
            <span v-if="device.ipMasked" class="mono">{{ device.ipMasked }}</span>
            <span v-if="device.lastSeenAt">{{ t('remote.devices.lastSeen', { time: formatDateTime(device.lastSeenAt) }) }}</span>
            <span v-else>{{ t('remote.devices.neverSeen') }}</span>
          </div>
          <div v-if="device.status === 'active' && pageLabelOf(device)" class="rdl-page">
            <span>{{ t('remote.devices.currentPage', { page: pageLabelOf(device) }) }}</span>
            <button
              v-if="relayPathOf(device)"
              type="button"
              class="btn btn-sm rdl-relay"
              @click="relayTo(device)"
            >
              {{ t('remote.devices.openHere') }}
            </button>
          </div>
        </div>
        <button
          v-if="device.status === 'active'"
          type="button"
          class="btn btn-danger rdl-revoke"
          @click="emit('revoke', device)"
        >
          {{ t('remote.devices.revoke') }}
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { RemoteDeviceItem } from '~/composables/useRemotePairing'
import type { RemotePlatform } from '~/composables/useRemoteGuest'
import { presencePageLabel, safePresenceRelayPath, type PresenceEntry } from '~/composables/usePresence'

const { devices = [], presence = [] } = defineProps<{
  devices?: RemoteDeviceItem[]
  presence?: PresenceEntry[]
}>()
const emit = defineEmits<{
  revoke: [device: RemoteDeviceItem]
  relay: [path: string]
}>()
const { t, locale } = useI18n()

function presenceOf(device: RemoteDeviceItem): PresenceEntry | null {
  return presence.find(entry => entry.role === 'guest' && entry.id === device.id) || null
}

function pageLabelOf(device: RemoteDeviceItem): string {
  const entry = presenceOf(device)
  if (entry?.context) return presencePageLabel(entry.context)
  return device.page || ''
}

function relayPathOf(device: RemoteDeviceItem): string | null {
  if (device.status !== 'active') return null
  const entry = presenceOf(device)
  return safePresenceRelayPath(entry?.context?.path || device.page || '')
}

function relayTo(device: RemoteDeviceItem): void {
  const path = relayPathOf(device)
  if (path) emit('relay', path)
}

function platformLabel(platform: RemotePlatform): string {
  return t(`remote.platform.${platform}`)
}

function formatDateTime(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale.value, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function statusText(device: RemoteDeviceItem): string {
  if (device.status === 'revoked') return t('remote.devices.revoked')
  if (device.status === 'expired') return t('remote.devices.expired')
  return device.online ? t('remote.devices.online') : t('remote.devices.offline')
}

function statusTagClass(device: RemoteDeviceItem): string {
  if (device.status !== 'active') return 'tag-error'
  return device.online ? 'tag-success' : ''
}
</script>

<style scoped>
.remote-device-list { width: 100%; }
.rdl-empty {
  padding: 14px 0;
  font-size: 12.5px;
  color: var(--text-2);
}
.rdl-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rdl-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.rdl-inactive { opacity: 0.66; }
.rdl-main { flex: 1; min-width: 0; }
.rdl-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.rdl-name {
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}
.rdl-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--text-2);
}
.rdl-page {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--accent-text);
  word-break: break-all;
}
.rdl-relay {
  min-height: 32px;
  padding: 0 12px;
}
.rdl-revoke {
  min-height: 44px;
  padding: 0 16px;
  flex-shrink: 0;
}
@media (max-width: 560px) {
  .rdl-item { align-items: flex-start; flex-direction: column; }
  .rdl-revoke { width: 100%; }
  .rdl-name { max-width: 100%; white-space: normal; }
}
</style>
