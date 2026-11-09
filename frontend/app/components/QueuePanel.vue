<template>
  <section class="card svc-group queue-panel">
    <div class="svc-group-head">
      <div class="svc-group-heading">
        <span class="svc-group-title">{{ t('queue.title') }}</span>
        <div class="svc-group-sub">{{ t('queue.desc') }}</div>
      </div>
      <button class="btn btn-sm" :disabled="saving" @click="toggleEnabled">
        {{ enabled ? t('queue.enabled') : t('queue.disabled') }}
      </button>
    </div>

    <div class="queue-controls">
      <span class="queue-label">{{ t('queue.concurrency') }}</span>
      <div class="queue-concurrency">
        <BaseSelect v-model="concurrency" :options="concurrencyOptions" />
      </div>
      <span class="queue-stats">
        {{ t('queue.stats', { queued: stats.queued, running: stats.running, done: stats.done, failed: stats.failed }) }}
      </span>
      <button class="btn btn-sm" :disabled="loading" @click="load">{{ t('common.refresh') }}</button>
    </div>

    <div class="queue-list">
      <div v-for="job in jobs" :key="job.id" class="queue-row">
        <span :class="['queue-chip', `is-${job.status}`]">{{ statusLabel(job.status) }}</span>
        <span class="queue-kind">{{ job.kind }}</span>
        <span class="queue-episode">{{ job.episodeId ? `#${job.episodeId}` : '—' }}</span>
        <span v-if="job.position" class="queue-position">{{ t('queue.position', { n: job.position }) }}</span>
        <span class="queue-progress">{{ job.progress || 0 }}%</span>
        <span class="queue-note" :title="job.error || job.note || ''">{{ job.error || job.note || '' }}</span>
        <span class="queue-actions">
          <button v-if="job.status === 'failed' || job.status === 'cancelled'" class="wb-mini" type="button" @click="retry(job)">
            {{ t('queue.retry') }}
          </button>
          <button v-if="job.status === 'queued'" class="wb-mini" type="button" @click="cancel(job)">{{ t('queue.cancel') }}</button>
        </span>
      </div>
      <p v-if="!jobs.length" class="config-empty">{{ t('queue.empty') }}</p>
    </div>
  </section>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { jobsAPI } from '~/composables/useApi'
import { toastError } from '~/composables/useToast'
import { useVisibilityPolling } from '~/composables/useVisibilityPolling'
import BaseSelect from '~/components/BaseSelect.vue'

const { t } = useI18n()
const jobs = ref([])
const stats = ref({ queued: 0, running: 0, done: 0, failed: 0 })
const enabled = ref(false)
const concurrency = ref(1)
const loading = ref(false)
const saving = ref(false)
const concurrencyOptions = [1, 2, 3, 4].map(n => ({ label: String(n), value: n }))

// 队列状态 3s 轮询：隐藏暂停、恢复补刷一次、上一轮未完成不重入；卸载由封装停止
const queuePoll = useVisibilityPolling(() => load(), 3000)
let hydrating = false

async function load() {
  loading.value = true
  try {
    const [list, st] = await Promise.all([jobsAPI.list({ limit: 50 }), jobsAPI.stats()])
    jobs.value = list.items || []
    stats.value = st
    hydrating = true
    enabled.value = Boolean(st.enabled)
    concurrency.value = Number(st.max_concurrent || 1)
    await nextTick()
    hydrating = false
  } catch (error) {
    toastError(error)
  } finally {
    loading.value = false
  }
}

async function saveSettings() {
  saving.value = true
  try {
    const result = await jobsAPI.saveSettings({ enabled: enabled.value, max_concurrent: concurrency.value })
    enabled.value = Boolean(result.enabled)
    concurrency.value = Number(result.max_concurrent || 1)
    await load()
  } catch (error) {
    toastError(error)
  } finally {
    saving.value = false
  }
}

async function toggleEnabled() {
  enabled.value = !enabled.value
  await saveSettings()
}

async function retry(job) {
  try {
    await jobsAPI.retry(job.id)
    await load()
  } catch (error) {
    toastError(error)
  }
}

async function cancel(job) {
  try {
    await jobsAPI.cancel(job.id)
    await load()
  } catch (error) {
    toastError(error)
  }
}

function statusLabel(status) {
  return t(`queue.status.${status}`)
}

watch(concurrency, async (value, old) => {
  if (!hydrating && old !== undefined && value !== old) await saveSettings()
})

onMounted(() => {
  load()
  queuePoll.start()
})
</script>

<style scoped>
.queue-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 0; }
.queue-label { font-size: 12px; color: var(--text-2); }
.queue-concurrency { width: 88px; }
.queue-stats { font-size: 11px; color: var(--text-3); margin-left: auto; }
.queue-list { display: flex; flex-direction: column; gap: 4px; }
.queue-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 1px solid var(--border); border-radius: 7px; font-size: 11px; color: var(--text-2); }
.queue-chip { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: rgba(127,127,127,.14); }
.queue-chip.is-running { color: #2b7bd6; background: rgba(43,123,214,.14); }
.queue-chip.is-done { color: #2e9e5b; background: rgba(46,158,91,.14); }
.queue-chip.is-failed { color: #d9534f; background: rgba(217,83,79,.14); }
.queue-chip.is-cancelled { color: #c48a1b; background: rgba(196,138,27,.16); }
.queue-kind { font-weight: 600; color: var(--text-1); }
.queue-episode { color: var(--text-3); }
.queue-position { color: var(--accent, #2b7bd6); }
.queue-progress { font-variant-numeric: tabular-nums; }
.queue-note { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); }
.queue-actions { display: flex; gap: 8px; }
.queue-actions .wb-mini { background: none; border: none; padding: 0; font: inherit; font-size: 11px; color: var(--accent, #2b7bd6); cursor: pointer; }
</style>