<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="requestClose">
      <div class="dialog remote-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-dialog-title">
        <div class="dialog-head">
          <div class="dialog-head-copy">
            <div id="remote-dialog-title" class="dialog-title">{{ t('remote.dialog.title') }}</div>
            <div class="dialog-desc">{{ t('remote.dialog.desc') }}</div>
          </div>
          <button type="button" class="btn btn-icon btn-ghost remote-close ml-auto" :aria-label="t('remote.dialog.close')" @click="requestClose">
            <X :size="16" />
          </button>
        </div>

        <div class="dialog-body remote-body">
          <div class="remote-status" :class="`tone-${statusTone}`">
            <span class="remote-dot" aria-hidden="true" />
            <div class="remote-status-copy">
              <div class="remote-status-title">{{ statusLabel }}</div>
              <div v-if="running && currentUrl" class="remote-status-url mono">{{ currentUrl }}</div>
              <div v-else-if="status?.bindAddress" class="remote-status-url mono">{{ status.bindAddress }}:{{ status.port }}</div>
            </div>
            <div class="remote-status-actions">
              <button v-if="!running" type="button" class="btn btn-primary" :disabled="state.enabling" @click="retryEnable">
                <Loader2 v-if="state.enabling" :size="14" class="animate-spin" />
                {{ state.enabling ? t('remote.dialog.enabling') : t('remote.dialog.enable') }}
              </button>
              <button v-else type="button" class="btn" :disabled="state.disabling" @click="askDisable">
                <Loader2 v-if="state.disabling" :size="14" class="animate-spin" />
                {{ t('remote.dialog.disable') }}
              </button>
            </div>
          </div>

          <div v-if="displayError" class="remote-alert" role="alert">
            <span class="remote-alert-text">{{ remoteErrorMessage(displayError) }}</span>
            <div class="remote-alert-actions">
              <button v-if="displayError === 'BRIDGE_PORT_IN_USE'" type="button" class="btn btn-sm" @click="focusPort">
                {{ t('remote.dialog.changePort') }}
              </button>
              <button v-if="!running" type="button" class="btn btn-sm" :disabled="state.enabling" @click="retryEnable">
                {{ t('remote.dialog.retry') }}
              </button>
            </div>
          </div>

          <p class="remote-hint">{{ t('remote.dialog.saveHint') }}</p>

          <div class="remote-grid">
            <section class="remote-panel remote-qr-panel">
              <div class="panel-head">
                <span>{{ t('remote.dialog.qrTitle') }}</span>
                <span v-if="pairingLive" class="tag tag-success">{{ pairingStateLabel }}</span>
                <span v-else class="tag">{{ pairingStateLabel }}</span>
              </div>

              <template v-if="pairingLive && pairing">
                <div class="qr-frame">
                  <div class="qr-code" v-html="pairing.qrSvg" />
                </div>
                <div class="qr-short">
                  <span class="field-label">{{ t('remote.dialog.shortCode') }}</span>
                  <strong class="qr-short-code mono">{{ pairing.shortCode }}</strong>
                </div>
                <div class="qr-meta">
                  <span>{{ t('remote.dialog.expiresIn', { time: countdownText }) }}</span>
                </div>
                <div class="qr-address">
                  <span class="field-label">{{ t('remote.dialog.address') }}</span>
                  <span class="qr-address-value mono">{{ currentUrl || addressOptions[0] || '-' }}</span>
                </div>
                <div class="qr-actions">
                  <button type="button" class="btn btn-sm" @click="copyLink">
                    <Copy :size="13" />
                    {{ t('remote.dialog.copyLink') }}
                  </button>
                </div>
                <div class="qr-page">{{ t('remote.dialog.currentPage', { page: currentPageLabel }) }}</div>
                <p class="remote-note">{{ t('remote.dialog.shortCodeHint') }}</p>
              </template>

              <div v-else class="qr-empty">
                <QrCode :size="30" class="qr-empty-icon" />
                <p>{{ pairingStateLabel }}</p>
                <button v-if="running" type="button" class="btn btn-primary" :disabled="state.creating" @click="regenerate">
                  <Loader2 v-if="state.creating" :size="14" class="animate-spin" />
                  {{ t('remote.dialog.regenerate') }}
                </button>
                <button v-else type="button" class="btn" :disabled="state.enabling" @click="retryEnable">
                  {{ t('remote.dialog.enable') }}
                </button>
                <p class="remote-note">{{ t('remote.dialog.shortCodeHint') }}</p>
              </div>
            </section>

            <section class="remote-panel remote-requests-panel">
              <div class="panel-head">
                <span>{{ t('remote.dialog.requests') }}</span>
                <span v-if="pending.length" class="tag tag-warning">{{ pending.length }}</span>
              </div>

              <div v-if="!pending.length" class="remote-empty">{{ t('remote.dialog.noRequests') }}</div>
              <div
                v-for="request in pending"
                :key="request.requestId"
                class="remote-request"
                :class="{ fresh: freshRequestIds.includes(request.requestId) }"
              >
                <div class="remote-request-head">
                  <strong class="remote-request-name">{{ request.name }}</strong>
                  <span class="tag">{{ platformLabel(request.platform) }}</span>
                </div>
                <div class="remote-request-meta">
                  <span v-if="maskIp(request.ip)" class="mono">{{ maskIp(request.ip) }}</span>
                  <span>{{ formatDateTime(request.createdAt) }}</span>
                </div>
                <div class="remote-request-actions">
                  <button
                    type="button"
                    class="btn btn-primary remote-action"
                    :disabled="busyRequestId === request.requestId"
                    @click="approve(request.requestId, 'full')"
                  >{{ t('remote.dialog.approveFull') }}</button>
                  <button
                    type="button"
                    class="btn remote-action"
                    :disabled="busyRequestId === request.requestId"
                    @click="approve(request.requestId, 'readonly')"
                  >{{ t('remote.dialog.approveReadonly') }}</button>
                  <button
                    type="button"
                    class="btn btn-ghost remote-action"
                    :disabled="busyRequestId === request.requestId"
                    @click="deny(request.requestId)"
                  >{{ t('remote.dialog.deny') }}</button>
                </div>
              </div>

              <div class="panel-head panel-head-devices">
                <span>{{ t('remote.dialog.devices') }}</span>
                <span class="panel-head-tools">
                  <span v-if="devices.length" class="tag">{{ t('remote.dialog.deviceCount', { n: devices.length }) }}</span>
                  <button v-if="devices.length" type="button" class="btn btn-sm btn-danger" @click="askRevokeAll">
                    {{ t('remote.dialog.revokeAll') }}
                  </button>
                </span>
              </div>
              <RemoteDeviceList
                :devices="devices"
                :presence="presenceState.entries"
                @revoke="askRevoke"
                @relay="relayToDevice"
              />
            </section>
          </div>

          <section class="remote-settings">
            <div class="panel-head">
              <span>{{ t('remote.dialog.settings') }}</span>
              <span class="remote-confirm-note">
                <ShieldCheck :size="13" />
                {{ t('remote.dialog.confirmAlways') }}
              </span>
            </div>
            <div class="remote-settings-grid">
              <label class="field">
                <span class="field-label">{{ t('remote.dialog.deviceName') }}</span>
                <input v-model="form.deviceName" class="input" maxlength="40" :placeholder="t('remote.dialog.deviceNamePlaceholder')" />
              </label>
              <label class="field">
                <span class="field-label">{{ t('remote.dialog.port') }}</span>
                <input
                  ref="portInput"
                  v-model.number="form.port"
                  class="input"
                  type="number"
                  inputmode="numeric"
                  min="1024"
                  max="65535"
                  :disabled="running"
                />
                <span v-if="running" class="field-hint">{{ t('remote.dialog.portLocked') }}</span>
              </label>
              <label class="field">
                <span class="field-label">{{ t('remote.dialog.sessionDays') }}</span>
                <select v-model.number="form.sessionDays" class="input">
                  <option v-for="days in sessionDayOptions" :key="days" :value="days">
                    {{ t('remote.dialog.days', { n: days }) }}
                  </option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">{{ t('remote.dialog.bindAddress') }}</span>
                <select v-model="form.bindAddress" class="input" :disabled="running || !addressOptions.length">
                  <option v-if="!addressOptions.length" value="">{{ t('remote.dialog.noAddress') }}</option>
                  <option v-for="address in addressOptions" :key="address" :value="address">{{ address }}</option>
                </select>
                <span class="field-hint">{{ running ? t('remote.dialog.bindLocked') : t('remote.dialog.bindHint') }}</span>
              </label>
            </div>
            <div class="remote-settings-actions">
              <span class="remote-note">{{ t('remote.dialog.foot') }}</span>
              <button type="button" class="btn btn-primary" :disabled="state.saving" @click="saveSettings">
                <Loader2 v-if="state.saving" :size="14" class="animate-spin" />
                {{ state.saving ? t('remote.dialog.saving') : t('remote.dialog.save') }}
              </button>
            </div>
          </section>
        </div>

        <div class="dialog-foot">
          <span class="dialog-foot-copy">{{ t('remote.dialog.foot') }}</span>
          <button type="button" class="btn" @click="requestClose">{{ t('common.close') }}</button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="confirm.open"
      :title="confirmTitle"
      :message="confirmMessage"
      :confirm-text="confirmLabel"
      :loading="confirm.loading"
      @cancel="closeConfirm"
      @confirm="runConfirm"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Copy, Loader2, QrCode, ShieldCheck, X } from 'lucide-vue-next'
import { useOverlayHistory } from '~/composables/useOverlayHistory'
import { remoteErrorMessage } from '~/composables/useRemoteGuest'
import { presenceState, refreshPresenceEntries, safePresenceRelayPath } from '~/composables/usePresence'
import {
  useRemotePairing,
  type RemoteDeviceItem,
  type RemoteSessionDays,
} from '~/composables/useRemotePairing'
import type { RemotePlatform } from '~/composables/useRemoteGuest'

const props = withDefaults(defineProps<{ open: boolean; next?: string; nextLabel?: string }>(), {
  next: '/',
  nextLabel: '',
})
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const router = useRouter()

const {
  state,
  freshRequestIds,
  remainingSeconds,
  pairingEnded,
  pairingClaimed,
  pendingRequests,
  refreshStatus,
  ensureBridge,
  enableBridge,
  disableBridge,
  updateSettings,
  createPairing,
  regeneratePairing,
  approveRequest,
  denyRequest,
  revokeDevice,
  revokeAllDevices,
  startPolling,
  suspend,
} = useRemotePairing()

const form = reactive({
  deviceName: '',
  port: 5680,
  sessionDays: 30 as RemoteSessionDays,
  bindAddress: '',
})
const portInput = ref<HTMLInputElement | null>(null)
const busyRequestId = ref('')

const sessionDayOptions: RemoteSessionDays[] = [7, 30, 90]

const status = computed(() => state.status)
const devices = computed(() => status.value?.devices ?? [])
const pairing = computed(() => state.pairing)
const running = computed(() => status.value?.running === true)
const currentUrl = computed(() => status.value?.urls[0] || '')
const currentPageLabel = computed(() => props.nextLabel || props.next || '/')
const pairingLive = computed(() => !!pairing.value && !pairingEnded.value)
const pending = pendingRequests
const displayError = computed(() => state.actionError || status.value?.lastErrorCode || '')
const statusTone = computed(() => {
  if (state.enabling || state.disabling) return 'pending'
  if (status.value?.state === 'error' || displayError.value) return 'error'
  return running.value ? 'ok' : 'idle'
})
const statusKey = computed(() => {
  if (!state.ready && !status.value) return 'loading'
  if (state.enabling) return 'enabling'
  if (state.disabling) return 'disabling'
  if (status.value?.state === 'error') return 'error'
  return running.value ? 'running' : 'disabled'
})
const statusLabel = computed(() => t(`remote.dialog.status.${statusKey.value}`))
const addressOptions = computed(() => {
  const list = [...(status.value?.addresses ?? [])]
  const current = form.bindAddress || status.value?.bindAddress || ''
  if (current && !list.includes(current)) list.unshift(current)
  return list
})
const pairingStateLabel = computed(() => {
  if (pairingClaimed.value) return t('remote.dialog.claimed')
  if (state.pairingStatus === 'approved') return t('remote.dialog.approved')
  if (pending.value.length) return t('remote.dialog.requestPending')
  if (pairingLive.value) return t('remote.dialog.waiting')
  if (!pairing.value) {
    if (state.creating) return t('remote.dialog.generating')
    return running.value ? t('remote.dialog.noCode') : t('remote.dialog.notReady')
  }
  if (state.pairingStatus === 'cancelled') return t('remote.dialog.cancelled')
  return t('remote.dialog.expired')
})
const countdownText = computed(() => {
  const seconds = remainingSeconds.value
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
})

function platformLabel(platform: RemotePlatform): string {
  return t(`remote.platform.${platform}`)
}

/** 配对会话只返回原始 IP；界面按服务端同一规则掩码，不展示完整地址 */
function maskIp(value: string | null | undefined): string {
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(value || '')
  return match ? `${match[1]}.*` : ''
}

function formatDateTime(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
}

function syncFormFromStatus(): void {
  const current = state.status
  if (!current) return
  form.deviceName = current.deviceName
  form.port = current.port
  form.sessionDays = current.sessionDays
  form.bindAddress = current.bindAddress || current.addresses[0] || ''
}

function notifyActionError(): void {
  if (!state.actionError) return
  toast.error(remoteErrorMessage(state.actionError))
}

async function retryEnable(): Promise<void> {
  const ok = await enableBridge(form.bindAddress || status.value?.addresses[0])
  if (!ok) {
    notifyActionError()
    return
  }
  syncFormFromStatus()
  if (!state.pairing || pairingEnded.value) {
    const created = await createPairing(props.next)
    if (!created) notifyActionError()
  }
  startPolling()
}

async function regenerate(): Promise<void> {
  const ok = await regeneratePairing(props.next)
  if (!ok) notifyActionError()
}

async function approve(requestId: string, scope: 'full' | 'readonly'): Promise<void> {
  busyRequestId.value = requestId
  try {
    const ok = await approveRequest(requestId, scope)
    if (!ok) {
      notifyActionError()
      return
    }
    toast.success(scope === 'readonly' ? t('remote.dialog.approvedReadonly') : t('remote.dialog.approvedFull'))
  } finally {
    busyRequestId.value = ''
  }
}

async function deny(requestId: string): Promise<void> {
  busyRequestId.value = requestId
  try {
    const ok = await denyRequest(requestId)
    if (ok) toast.success(t('remote.dialog.denied'))
    else notifyActionError()
  } finally {
    busyRequestId.value = ''
  }
}

async function saveSettings(): Promise<void> {
  const deviceName = form.deviceName.trim()
  if (!deviceName) {
    toast.error(t('remote.dialog.deviceNameRequired'))
    return
  }
  const ok = await updateSettings({
    deviceName,
    port: Number(form.port),
    sessionDays: form.sessionDays,
  })
  if (ok) {
    syncFormFromStatus()
    toast.success(t('remote.dialog.saved'))
  } else {
    notifyActionError()
  }
}

function focusPort(): void {
  portInput.value?.focus()
  portInput.value?.select()
}

async function copyLink(): Promise<void> {
  const text = pairing.value?.qrPayload
  if (!text) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      throw new Error('clipboard unavailable')
    }
    toast.success(t('remote.dialog.copied'))
  } catch {
    // 局域网 HTTP 下 Clipboard API 可能不可用，退回隐藏 textarea 复制
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let copied = false
    try {
      copied = document.execCommand('copy')
    } catch {
      copied = false
    }
    document.body.removeChild(area)
    if (copied) toast.success(t('remote.dialog.copied'))
    else toast.error(t('remote.dialog.copyFailed'))
  }
}

type ConfirmKind = 'disable' | 'revoke' | 'revokeAll'
const confirm = reactive({
  open: false,
  kind: 'disable' as ConfirmKind,
  device: null as RemoteDeviceItem | null,
  loading: false,
})

const confirmTitle = computed(() => {
  if (confirm.kind === 'revoke') return t('remote.confirm.revokeTitle')
  if (confirm.kind === 'revokeAll') return t('remote.confirm.revokeAllTitle')
  return t('remote.confirm.disableTitle')
})
const confirmMessage = computed(() => {
  if (confirm.kind === 'revoke') {
    return t('remote.confirm.revokeMessage', { name: confirm.device?.name || '' })
  }
  if (confirm.kind === 'revokeAll') {
    return t('remote.confirm.revokeAllMessage', { n: devices.value.length })
  }
  return t('remote.confirm.disableMessage')
})
const confirmLabel = computed(() => {
  if (confirm.kind === 'revoke') return t('remote.confirm.revokeConfirm')
  if (confirm.kind === 'revokeAll') return t('remote.confirm.revokeAllConfirm')
  return t('remote.confirm.disableConfirm')
})

function askDisable(): void {
  confirm.kind = 'disable'
  confirm.device = null
  confirm.open = true
}

function askRevoke(device: RemoteDeviceItem): void {
  confirm.kind = 'revoke'
  confirm.device = device
  confirm.open = true
}

/** 反向接力：电脑端跳到手机当前所在页面；只接受站内路径 */
function relayToDevice(path: string): void {
  const safe = safePresenceRelayPath(path)
  if (!safe) {
    toast.error(t('remote.errors.badPath'))
    return
  }
  emit('close')
  void router.push(safe)
}

function askRevokeAll(): void {
  confirm.kind = 'revokeAll'
  confirm.device = null
  confirm.open = true
}

function closeConfirm(): void {
  if (confirm.loading) return
  confirm.open = false
}

async function runConfirm(): Promise<void> {
  if (confirm.loading) return
  confirm.loading = true
  let ok = false
  try {
    if (confirm.kind === 'revoke' && confirm.device) ok = await revokeDevice(confirm.device.id)
    else if (confirm.kind === 'revokeAll') ok = await revokeAllDevices()
    else ok = await disableBridge()
  } finally {
    confirm.loading = false
    confirm.open = false
  }
  if (ok) {
    if (confirm.kind === 'disable') syncFormFromStatus()
    toast.success(t('remote.dialog.actionDone'))
  } else {
    notifyActionError()
  }
}

let bootstrapping = false

async function bootstrap(): Promise<void> {
  if (bootstrapping) return
  bootstrapping = true
  try {
    startPolling()
    await refreshStatus()
    syncFormFromStatus()
    void refreshPresenceEntries()
    if (!state.status?.running) {
      const enabled = await ensureBridge()
      if (!enabled) {
        notifyActionError()
        return
      }
      syncFormFromStatus()
    }
    if (!state.pairing || pairingEnded.value) {
      const created = await createPairing(props.next)
      if (!created) notifyActionError()
    }
  } finally {
    bootstrapping = false
  }
}

function requestClose(): void {
  emit('close')
}

const overlay = useOverlayHistory(requestClose)

watch(() => props.open, (open) => {
  if (open) {
    overlay.open()
    void bootstrap()
  } else {
    overlay.close()
    suspend()
    confirm.open = false
  }
}, { immediate: true })

onUnmounted(() => {
  suspend()
})
</script>

<style scoped>
.remote-dialog {
  width: min(980px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
}
.dialog-head-copy { min-width: 0; }
.dialog-desc {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-2);
}
.remote-close {
  width: 44px;
  min-width: 44px;
  height: 44px;
  min-height: 44px;
}
.remote-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.remote-dialog .btn { min-height: 44px; }
.remote-status {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.remote-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-3);
}
.tone-ok .remote-dot { background: var(--success); }
.tone-error .remote-dot { background: var(--error); }
.tone-pending .remote-dot { background: var(--warning); animation: pulse 1.4s ease-in-out infinite; }
.remote-status-copy { min-width: 0; }
.remote-status-title { font-size: 13px; font-weight: 650; color: var(--text-0); }
.remote-status-url {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-2);
  word-break: break-all;
}
.remote-status-actions { margin-left: auto; display: flex; gap: 8px; flex-shrink: 0; }
.remote-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px solid var(--error);
  border-radius: var(--radius);
  background: var(--error-bg);
  color: var(--error);
  font-size: 12.5px;
}
.remote-alert-text { flex: 1; min-width: 180px; }
.remote-alert-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.remote-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}
.remote-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
  gap: 16px;
  align-items: start;
}
.remote-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  padding: 14px;
  min-width: 0;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text-0);
}
.panel-head-tools { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.panel-head-devices { margin-top: 18px; }
.qr-frame {
  display: flex;
  justify-content: center;
  padding: 10px;
  border-radius: var(--radius);
  background: #fff;
  border: 1px solid var(--border);
}
.qr-code { width: 200px; height: 200px; }
.qr-code :deep(svg) { width: 100%; height: 100%; display: block; }
.qr-short {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-top: 12px;
}
.qr-short-code {
  font-size: 26px;
  letter-spacing: 0.22em;
  font-weight: 700;
  color: var(--text-0);
}
.qr-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-2);
}
.qr-address { margin-top: 10px; display: flex; flex-direction: column; gap: 3px; }
.qr-address-value { font-size: 11.5px; color: var(--text-1); word-break: break-all; }
.qr-actions { margin-top: 8px; }
.qr-page {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--overlay-track);
  font-size: 12px;
  color: var(--text-1);
  word-break: break-all;
}
.remote-note { margin: 8px 0 0; font-size: 11.5px; line-height: 1.55; color: var(--text-2); }
.qr-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 18px 10px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text-2);
}
.qr-empty-icon { color: var(--text-3); }
.qr-empty p { margin: 0; }
.remote-empty {
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  font-size: 12px;
  color: var(--text-2);
  text-align: center;
}
.remote-request {
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface);
}
.remote-request + .remote-request { margin-top: 8px; }
.remote-request.fresh {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--button-focus);
  animation: fadeUp 0.22s var(--ease-out);
}
.remote-request-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.remote-request-name {
  font-size: 13px;
  color: var(--text-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.remote-request-meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-2);
}
.remote-request-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.remote-action { flex: 1 1 120px; }
.remote-settings {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  padding: 14px;
}
.remote-confirm-note {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--success);
}
.remote-settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.remote-settings-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.remote-settings-actions .remote-note { flex: 1; min-width: 200px; margin: 0; }
.field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.field-label { font-size: 11.5px; font-weight: 600; color: var(--text-2); }
.field-hint { font-size: 11px; color: var(--text-3); }
.remote-dialog .input { min-height: 44px; }
@media (max-width: 900px) {
  .remote-grid { grid-template-columns: 1fr; }
  .remote-settings-grid { grid-template-columns: 1fr; }
  .remote-status { flex-wrap: wrap; }
  .remote-status-actions { width: 100%; margin-left: 19px; }
}
@media (max-width: 560px) {
  .remote-dialog { width: calc(100vw - 16px); max-height: calc(100vh - 16px); }
  .qr-code { width: 168px; height: 168px; }
  .remote-action { flex: 1 1 100%; }
}
</style>
