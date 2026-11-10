<template>
  <div class="pair-page">
    <main class="pair-card">
      <div class="pair-brand">
        <img :src="brandLogo" alt="" class="pair-logo" />
        <div class="pair-brand-text">
          <span class="pair-brand-name">{{ t('app.title') }}</span>
          <span class="pair-brand-sub">{{ t('remote.pair.subtitle') }}</span>
        </div>
        <div class="pair-tools">
          <LocaleSwitcher />
        </div>
      </div>

      <div v-if="state === 'loading'" class="pair-state" role="status">
        <Loader2 :size="26" class="pair-spin" />
        <p class="pair-state-title">{{ t('remote.pair.loading') }}</p>
      </div>

      <div v-else-if="state === 'requesting'" class="pair-state" role="status">
        <Loader2 :size="26" class="pair-spin" />
        <p class="pair-state-title">{{ t('remote.pair.requesting') }}</p>
      </div>

      <div v-else-if="state === 'pending' || state === 'claiming'" class="pair-state">
        <Loader2 :size="26" class="pair-spin" />
        <h1 class="pair-state-title">{{ t('remote.pair.pendingTitle') }}</h1>
        <p class="pair-state-desc">{{ t('remote.pair.pendingHint') }}</p>
        <p v-if="publicComputer" class="pair-computer-line">{{ t('remote.pair.computer', { name: publicComputer }) }}</p>
        <p class="pair-countdown">{{ t('remote.pair.expiresIn', { time: remainingText }) }}</p>
        <p v-if="pollWarning" class="pair-warning" role="status">{{ t('remote.pair.reconnecting') }}</p>
        <p class="pair-help">{{ t('remote.pair.keepOpen') }}</p>
        <button type="button" class="pair-btn pair-btn-ghost" @click="cancelWaiting">
          {{ t('remote.pair.cancel') }}
        </button>
      </div>

      <div v-else-if="state === 'paired'" class="pair-state" role="status">
        <span class="pair-ok"><Check :size="22" /></span>
        <p class="pair-state-title">{{ t('remote.pair.paired') }}</p>
      </div>

      <template v-else>
        <div v-if="state === 'error'" class="pair-alert" role="alert">
          <TriangleAlert :size="18" class="pair-alert-icon" />
          <div>
            <strong>{{ t('remote.pair.errorTitle') }}</strong>
            <p>{{ errorMessage }}</p>
          </div>
        </div>

        <div v-if="info" class="pair-computer">
          <div class="pair-computer-main">
            <Smartphone :size="18" />
            <span>{{ t('remote.pair.computer', { name: info.name }) }}</span>
          </div>
          <div class="pair-chips">
            <span class="pair-chip">
              <ShieldCheck :size="12" />
              {{ info.secure ? t('remote.pair.secure') : t('remote.pair.insecure') }}
            </span>
            <span v-if="info.confirm" class="pair-chip">{{ t('remote.pair.confirmRequired') }}</span>
          </div>
          <p v-if="info.confirm" class="pair-help">{{ t('remote.pair.confirmHint') }}</p>
        </div>
        <p v-else class="pair-help">{{ t('remote.pair.unavailable') }}</p>

        <form class="pair-form" @submit.prevent="onSubmit">
          <label class="pair-label" for="pair-code">{{ t('remote.pair.codeLabel') }}</label>
          <input
            id="pair-code"
            v-model="codeInput"
            class="pair-input pair-code"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            autocapitalize="off"
            spellcheck="false"
            maxlength="43"
            :placeholder="t('remote.pair.codePlaceholder')"
            :aria-invalid="codeInvalid ? 'true' : undefined"
            @input="onCodeInput"
          />
          <p class="pair-help" :class="{ 'pair-help-error': codeInvalid }">
            {{ codeInvalid ? t('remote.pair.codeInvalid') : t('remote.pair.codeHint') }}
          </p>

          <template v-if="state === 'need-code'">
            <label class="pair-label" for="pair-device-name">{{ t('remote.pair.deviceName') }}</label>
            <input
              id="pair-device-name"
              v-model="deviceName"
              class="pair-input"
              type="text"
              maxlength="40"
              autocomplete="off"
              :placeholder="t('remote.pair.deviceNamePlaceholder')"
            />
            <p class="pair-help">{{ t('remote.pair.deviceNameHint') }}</p>
          </template>

          <button type="submit" class="pair-btn pair-btn-primary" :disabled="!codeValid">
            <Wifi :size="16" />
            {{ t('remote.pair.connect') }}
          </button>
        </form>

        <div class="pair-alt-actions">
          <button v-if="canRetryLast" type="button" class="pair-btn pair-btn-ghost" @click="retryLast">
            <RefreshCw :size="14" />
            {{ t('remote.pair.retry') }}
          </button>
          <button v-if="!info" type="button" class="pair-btn pair-btn-ghost" @click="bootstrap">
            <RefreshCw :size="14" />
            {{ t('remote.pair.retryConnect') }}
          </button>
        </div>
      </template>

      <p class="pair-foot">{{ t('remote.pair.foot') }}</p>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Check, Loader2, RefreshCw, ShieldCheck, Smartphone, TriangleAlert, Wifi } from 'lucide-vue-next'
import {
  cancelRemotePairing,
  claimRemotePairing,
  loadRemotePublicInfo,
  pollRemotePairing,
  remoteErrorMessage,
  resolveRemoteLanding,
  sanitizeRemoteNext,
  submitRemotePairing,
  type RemotePairingPublicInfo,
  type RemotePlatform,
} from '~/composables/useRemoteGuest'
import { detectRemotePlatform } from '~/utils/remote-platform'
import LocaleSwitcher from '~/components/LocaleSwitcher.vue'
import brandLogo from '~/assets/brand-logo.png'

definePageMeta({ layout: false })

type PairState = 'loading' | 'need-code' | 'requesting' | 'pending' | 'claiming' | 'paired' | 'error'

const POLL_INTERVAL_MS = 2500
const POLL_RETRY_MS = 4000
const MAX_NETWORK_FAILURES = 3
const CODE_RE = /^(\d{6}|[A-Za-z0-9_-]{43})$/

const { t } = useI18n()
const router = useRouter()

const state = ref<PairState>('loading')
const info = ref<RemotePairingPublicInfo | null>(null)
const platform = ref<RemotePlatform>('web')
const deviceName = ref('')
const codeInput = ref('')
const errorCode = ref<string | null>(null)
const localErrorKey = ref<string | null>(null)
const expiresAtMs = ref(0)
const nowMs = ref(Date.now())
const pollWarning = ref(false)
const lastSubmittedCode = ref('')

let scannedCode = ''
let nextValue = '/'
let waitToken = ''
let pollTimer: ReturnType<typeof setTimeout> | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
let pollGeneration = 0
let networkFailures = 0
let pendingWhenVisible = false
let unmounted = false
let lastDefaultName = ''

const defaultName = computed(() => t(`remote.platform.${platform.value}`))
const publicComputer = computed(() => info.value?.name || '')
const codeValid = computed(() => CODE_RE.test(codeInput.value.trim()))
const codeInvalid = computed(() => codeInput.value.trim().length > 0 && !codeValid.value)
const remainingSeconds = computed(() => Math.max(0, Math.ceil((expiresAtMs.value - nowMs.value) / 1000)))
const remainingText = computed(() => {
  const total = remainingSeconds.value
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
})
const errorMessage = computed(() => localErrorKey.value ? t(localErrorKey.value) : remoteErrorMessage(errorCode.value))
const canRetryLast = computed(() => {
  if (state.value !== 'error' || !info.value || !lastSubmittedCode.value) return false
  return errorCode.value !== 'PAIRING_EXPIRED' && errorCode.value !== 'PAIRING_DENIED'
})

watch(defaultName, (name) => {
  if (!deviceName.value || deviceName.value === lastDefaultName) deviceName.value = name
  lastDefaultName = name
}, { immediate: true })

function readPairingUrl(): void {
  try {
    const url = new URL(window.location.href)
    const rawCode = (url.searchParams.get('c') || '').trim()
    scannedCode = CODE_RE.test(rawCode) ? rawCode : ''
    nextValue = sanitizeRemoteNext(url.searchParams.get('next'))
    // 配对码只在内存中；读取后立即从地址栏移除，避免历史记录残留
    window.history.replaceState(window.history.state, '', '/pair')
  } catch {
    scannedCode = ''
    nextValue = '/'
  }
}

function setupIdentity(): void {
  platform.value = detectRemotePlatform()
}

function clearPollTimer(): void {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

function stopPolling(): void {
  clearPollTimer()
  pollGeneration += 1
  pendingWhenVisible = false
}

function stopClock(): void {
  if (clockTimer) {
    clearInterval(clockTimer)
    clockTimer = null
  }
}

function startClock(): void {
  if (clockTimer) return
  nowMs.value = Date.now()
  clockTimer = setInterval(() => {
    nowMs.value = Date.now()
    if (
      expiresAtMs.value
      && nowMs.value >= expiresAtMs.value
      && (state.value === 'pending' || state.value === 'claiming')
    ) {
      enterError({ errorCode: 'PAIRING_EXPIRED', status: 410 }, 'remote.errors.pairingExpired')
    }
  }, 1000)
}

function enterError(error: any, fallbackKey: string): void {
  const code = typeof error?.errorCode === 'string' ? error.errorCode : null
  stopPolling()
  stopClock()
  waitToken = ''
  errorCode.value = code
  localErrorKey.value = code ? null : fallbackKey
  pollWarning.value = false
  state.value = 'error'
}

function fallbackErrorKey(error: any): string {
  return error?.status === 404 ? 'remote.errors.disabled' : 'remote.pair.unavailable'
}

async function bootstrap(): Promise<void> {
  state.value = 'loading'
  errorCode.value = null
  localErrorKey.value = null
  pollWarning.value = false
  stopPolling()
  stopClock()
  try {
    info.value = await loadRemotePublicInfo()
  } catch (error: any) {
    info.value = null
    if (unmounted) return
    enterError(error, fallbackErrorKey(error))
    return
  }
  if (unmounted) return
  if (scannedCode) {
    await sendRequest(scannedCode)
    scannedCode = ''
  } else {
    state.value = 'need-code'
  }
}

async function sendRequest(rawCode: string): Promise<void> {
  const code = rawCode.trim()
  if (!CODE_RE.test(code)) return
  stopPolling()
  errorCode.value = null
  localErrorKey.value = null
  pollWarning.value = false
  networkFailures = 0
  lastSubmittedCode.value = code
  state.value = 'requesting'
  try {
    const result = await submitRemotePairing({
      code,
      name: deviceName.value.trim().slice(0, 40) || defaultName.value,
      platform: platform.value,
    })
    if (unmounted) return
    waitToken = result.waitToken
    expiresAtMs.value = Date.parse(result.expiresAt) || Date.now() + 120_000
    state.value = 'pending'
    startClock()
    schedulePoll()
  } catch (error: any) {
    if (unmounted) return
    enterError(error, fallbackErrorKey(error))
  }
}

function onSubmit(): void {
  if (!codeValid.value) return
  void sendRequest(codeInput.value)
}

function retryLast(): void {
  if (lastSubmittedCode.value) void sendRequest(lastSubmittedCode.value)
}

function onCodeInput(): void {
  const cleaned = codeInput.value.replace(/\s+/g, '')
  if (cleaned !== codeInput.value) codeInput.value = cleaned
}

function schedulePoll(delay = POLL_INTERVAL_MS): void {
  clearPollTimer()
  const generation = pollGeneration
  pollTimer = setTimeout(() => { void pollTick(generation) }, delay)
}

async function pollTick(generation: number): Promise<void> {
  if (unmounted || generation !== pollGeneration || !waitToken) return
  if (state.value !== 'pending' && state.value !== 'claiming') return
  if (typeof document !== 'undefined' && document.hidden) {
    pendingWhenVisible = true
    return
  }
  try {
    const result = await pollRemotePairing(waitToken)
    if (unmounted || generation !== pollGeneration) return
    networkFailures = 0
    pollWarning.value = false
    if (result.status === 'approved') {
      state.value = 'claiming'
      await claim()
      return
    }
    schedulePoll()
  } catch (error: any) {
    if (unmounted || generation !== pollGeneration) return
    if (error?.status === 429 || error?.errorCode === 'REMOTE_RATE_LIMITED') {
      schedulePoll(POLL_RETRY_MS)
      return
    }
    if (error?.status === 410 || error?.status === 403 || error?.errorCode === 'PAIRING_EXPIRED' || error?.errorCode === 'PAIRING_DENIED') {
      enterError(error, 'remote.pair.waitInterrupted')
      return
    }
    networkFailures += 1
    if (networkFailures >= MAX_NETWORK_FAILURES) {
      enterError(error, 'remote.pair.waitInterrupted')
      return
    }
    pollWarning.value = true
    schedulePoll(POLL_RETRY_MS)
  }
}

async function claim(): Promise<void> {
  if (!waitToken) return
  try {
    const result = await claimRemotePairing(waitToken)
    if (unmounted) return
    waitToken = ''
    stopPolling()
    stopClock()
    state.value = 'paired'
    const landing = resolveRemoteLanding(result.next || nextValue)
    await router.replace(landing.path)
  } catch (error: any) {
    if (unmounted) return
    if (error?.status === 202 || error?.errorCode === 'PAIRING_PENDING') {
      state.value = 'pending'
      schedulePoll(POLL_RETRY_MS)
      return
    }
    enterError(error, 'remote.pair.waitInterrupted')
  }
}

async function cancelWaiting(): Promise<void> {
  const token = waitToken
  stopPolling()
  stopClock()
  waitToken = ''
  if (token) {
    try { await cancelRemotePairing(token) } catch { /* 会话可能已结束 */ }
  }
  if (unmounted) return
  enterError(null, 'remote.pair.cancelled')
}

function onVisibility(): void {
  if (typeof document === 'undefined' || document.hidden) return
  if (pendingWhenVisible && waitToken && (state.value === 'pending' || state.value === 'claiming')) {
    pendingWhenVisible = false
    schedulePoll(0)
  }
}

onMounted(() => {
  readPairingUrl()
  setupIdentity()
  document.addEventListener('visibilitychange', onVisibility)
  void bootstrap()
})

onBeforeUnmount(() => {
  unmounted = true
  document.removeEventListener('visibilitychange', onVisibility)
  const token = waitToken
  const waiting = state.value === 'pending' || state.value === 'claiming'
  stopPolling()
  stopClock()
  waitToken = ''
  if (token && waiting) {
    void cancelRemotePairing(token).catch(() => {})
  }
})
</script>

<style scoped>
.pair-page {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(var(--safe-top) + 24px) 16px calc(var(--safe-bottom) + 24px);
  background:
    radial-gradient(120% 70% at 50% 0%, var(--accent-bg) 0%, transparent 60%),
    var(--bg-base);
}

.pair-card {
  width: 100%;
  max-width: 440px;
  padding: 24px 22px 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  background: var(--surface-raised);
  box-shadow: var(--shadow-elevated);
}

.pair-brand {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-bottom: 20px;
}
.pair-logo {
  width: 42px;
  height: 42px;
  object-fit: contain;
  border-radius: 12px;
}
.pair-brand-text { display: flex; flex-direction: column; min-width: 0; }
.pair-brand-name {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-0);
  line-height: 1.2;
}
.pair-brand-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.3;
}
.pair-tools { margin-left: auto; }
.pair-tools :deep(.locale-trigger) { min-height: var(--tap-min); }

.pair-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 26px 8px 18px;
  text-align: center;
}
.pair-spin { animation: pairSpin 0.9s linear infinite; color: var(--accent); }
@keyframes pairSpin { to { transform: rotate(360deg); } }
.pair-state-title {
  font-size: 16px;
  font-weight: 650;
  color: var(--text-0);
  line-height: 1.4;
}
.pair-state-desc {
  max-width: 300px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-2);
}
.pair-computer-line { font-size: 13px; color: var(--text-1); }
.pair-countdown {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--accent-text);
}
.pair-ok {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-pill);
  background: var(--success-bg);
  color: var(--success);
}

.pair-alert {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin-bottom: 16px;
  padding: 12px 14px;
  border: 1px solid var(--warn-border);
  border-radius: var(--radius);
  background: var(--warn-bg);
  color: var(--warn-text);
  font-size: 13px;
  line-height: 1.55;
}
.pair-alert strong { display: block; font-size: 13.5px; }
.pair-alert p { margin-top: 2px; }
.pair-alert-icon { flex-shrink: 0; margin-top: 1px; }

.pair-computer {
  padding: 12px 14px;
  margin-bottom: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-muted);
}
.pair-computer-main {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-1);
}
.pair-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.pair-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: var(--radius-pill);
  background: var(--surface-raised);
  border: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-2);
}

.pair-form { display: flex; flex-direction: column; gap: 8px; }
.pair-label {
  margin-top: 4px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-1);
}
.pair-input {
  width: 100%;
  min-height: var(--tap-min);
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-input);
  color: var(--text-0);
  font-size: var(--touch-input-font);
  font-family: inherit;
  outline: none;
  transition: border-color 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out);
}
.pair-input:focus {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.pair-code {
  font-family: var(--font-mono);
  font-size: 20px;
  letter-spacing: 0.16em;
  text-align: center;
}
.pair-code::placeholder {
  font-family: var(--font-body);
  font-size: 14px;
  letter-spacing: 0;
  color: var(--text-3);
}
.pair-help {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-3);
}
.pair-help-error { color: var(--error); }
.pair-warning { font-size: 12px; color: var(--warning); }

.pair-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: var(--tap-min);
  padding: 0 16px;
  border: none;
  border-radius: var(--radius-pill);
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.18s var(--ease-out);
}
.pair-btn-primary {
  margin-top: 6px;
  background: var(--action-primary);
  color: var(--action-primary-text);
  box-shadow: var(--shadow-xs);
}
.pair-btn-primary:hover { background: var(--action-primary-hover); }
.pair-btn-primary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
.pair-btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }
.pair-btn-ghost {
  background: transparent;
  color: var(--accent-text);
}
.pair-btn-ghost:hover { background: var(--accent-bg); }
.pair-alt-actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.pair-foot {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-3);
  text-align: center;
}

@media (max-width: 480px) {
  .pair-page { align-items: flex-start; padding-top: calc(var(--safe-top) + 14px); }
  .pair-card { padding: 20px 16px 16px; }
}
</style>
