<template>
  <section class="proposal-card" :class="`proposal-card-${proposal.status}`" aria-live="polite">
    <header class="proposal-head">
      <div class="proposal-head-main">
        <PencilLine :size="13" class="proposal-icon" />
        <span class="proposal-title">{{ t('assistant.proposal.title') }}</span>
        <span class="tag">{{ kindLabel }}</span>
        <span class="tag" :class="statusTagClass">{{ statusLabel }}</span>
      </div>
      <span class="proposal-target">{{ targetLabel }}</span>
    </header>

    <div v-if="proposal.rationale" class="proposal-block">
      <div class="proposal-label">{{ t('assistant.proposal.rationale') }}</div>
      <p class="proposal-text">{{ proposal.rationale }}</p>
    </div>

    <div class="proposal-block">
      <div class="proposal-label">{{ t('assistant.proposal.diff') }}</div>
      <div v-for="row in diffs" :key="row.field" class="proposal-diff">
        <div class="proposal-field">
          <span>{{ fieldLabel(row.field) }}</span>
          <code>{{ row.field }}</code>
        </div>
        <div class="proposal-values">
          <div class="proposal-value">
            <span class="proposal-value-label">{{ t('assistant.proposal.before') }}</span>
            <p class="proposal-text" :class="{ clamp: !isExpanded(row.field) }">{{ shownValue(row, 'before') }}</p>
          </div>
          <div class="proposal-value">
            <span class="proposal-value-label">{{ t('assistant.proposal.after') }}</span>
            <p class="proposal-text" :class="{ clamp: !isExpanded(row.field) }">{{ shownValue(row, 'after') }}</p>
          </div>
        </div>
        <button v-if="isLongDiff(row)" type="button" class="btn btn-ghost btn-sm proposal-expand" @click="toggleField(row.field)">
          {{ isExpanded(row.field) ? t('assistant.proposal.collapse') : t('assistant.proposal.expand') }}
        </button>
      </div>
      <div v-if="!diffs.length" class="proposal-hint dim">{{ t('assistant.proposal.noDiff') }}</div>
    </div>

    <div v-if="conflictCurrent" class="proposal-alert proposal-alert-warning">
      <div class="proposal-alert-title">
        <AlertTriangle :size="13" />
        {{ t('assistant.proposal.conflictTitle') }}
      </div>
      <div class="proposal-label">{{ t('assistant.proposal.current') }}</div>
      <pre class="proposal-raw">{{ pretty(conflictCurrent) }}</pre>
      <p class="proposal-hint">{{ t('assistant.proposal.conflictHint') }}</p>
    </div>

    <div v-else-if="proposal.status === 'conflict'" class="proposal-alert proposal-alert-warning">
      <div class="proposal-alert-title">
        <AlertTriangle :size="13" />
        {{ t('assistant.proposal.conflictTitle') }}
      </div>
      <p class="proposal-hint">{{ t('assistant.proposal.conflictHint') }}</p>
    </div>

    <div v-if="proposal.status === 'expired'" class="proposal-alert proposal-alert-warning">
      <div class="proposal-alert-title">
        <AlertTriangle :size="13" />
        {{ t('assistant.proposal.expiredTitle') }}
      </div>
      <p class="proposal-hint">{{ expiredReason }}</p>
      <p class="proposal-hint">{{ t('assistant.proposal.expiredHint') }}</p>
    </div>

    <div v-if="proposal.status === 'applied'" class="proposal-audit dim">
      <Check :size="12" />
      <span>{{ appliedMeta }}</span>
    </div>

    <div v-if="errorText" class="proposal-alert proposal-alert-error">{{ errorText }}</div>

    <div v-if="showRaw" class="proposal-raw-wrap">
      <div class="proposal-block">
        <div class="proposal-label">before_json</div>
        <pre class="proposal-raw">{{ pretty(proposal.before) }}</pre>
      </div>
      <div class="proposal-block">
        <div class="proposal-label">after_json</div>
        <pre class="proposal-raw">{{ pretty(proposal.after) }}</pre>
      </div>
    </div>

    <footer class="proposal-actions">
      <button type="button" class="btn btn-ghost btn-sm" @click="showRaw = !showRaw">
        {{ showRaw ? t('assistant.proposal.hideRaw') : t('assistant.proposal.viewRaw') }}
      </button>
      <template v-if="proposal.status === 'proposed'">
        <template v-if="confirmReject">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="Boolean(busy)" @click="confirmReject = false">
            {{ t('assistant.proposal.cancel') }}
          </button>
          <button type="button" class="btn btn-danger btn-sm" :disabled="Boolean(busy)" @click="reject">
            <Loader2 v-if="busy === 'reject'" :size="12" class="animate-spin" />
            <X v-else :size="12" />
            {{ t('assistant.proposal.confirmReject') }}
          </button>
        </template>
        <template v-else>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="disabled || Boolean(busy)" @click="confirmReject = true">
            {{ t('assistant.proposal.reject') }}
          </button>
          <button type="button" class="btn btn-primary btn-sm" :disabled="disabled || Boolean(busy)" @click="apply">
            <Loader2 v-if="busy === 'apply'" :size="12" class="animate-spin" />
            <Check v-else :size="12" />
            {{ busy === 'apply' ? t('assistant.proposal.applying') : t('assistant.proposal.apply') }}
          </button>
        </template>
      </template>
    </footer>

    <p v-if="proposal.status === 'proposed' && disabled" class="proposal-hint dim">
      {{ t('assistant.proposal.disabledRunning') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Check, Loader2, PencilLine, X } from 'lucide-vue-next'
import {
  sanitizeErrorText,
  useAssistant,
  type AssistantProposal,
  type AssistantProposalStatus,
} from '~/composables/useAssistant'

const props = defineProps<{
  proposal: AssistantProposal
  disabled?: boolean
}>()

const emit = defineEmits<{ applied: [proposal: AssistantProposal] }>()

const { t } = useI18n()
const { applyProposal, rejectProposal } = useAssistant()

const busy = ref<'apply' | 'reject' | null>(null)
const confirmReject = ref(false)
const showRaw = ref(false)
const expandedFields = ref<string[]>([])
const errorCode = ref('')
const errorText = ref('')
const conflictCurrent = ref<Record<string, unknown> | null>(null)
const expiredReasonCode = ref('')

const kindKeys: Record<AssistantProposal['kind'], string> = {
  'storyboard.update': 'storyboard',
  'asset.prompt.update': 'asset',
  'line.update': 'line',
}
const targetKeys: Record<AssistantProposal['target_type'], string> = {
  storyboard: 'storyboard',
  line: 'line',
  character: 'character',
  scene: 'scene',
  prop: 'prop',
}
const statusKeys: Record<AssistantProposalStatus, string> = {
  proposed: 'proposed',
  applied: 'applied',
  rejected: 'rejected',
  conflict: 'conflict',
  expired: 'expired',
}
const statusTagClass = computed(() => {
  if (props.proposal.status === 'applied') return 'tag-success'
  if (props.proposal.status === 'rejected') return ''
  if (props.proposal.status === 'proposed') return 'tag-warning'
  return 'tag-error'
})

const kindLabel = computed(() => t(`assistant.proposal.kinds.${kindKeys[props.proposal.kind]}`))
const statusLabel = computed(() => t(`assistant.proposal.status.${statusKeys[props.proposal.status]}`))
const targetLabel = computed(() => (
  t('assistant.proposal.targetLabel', {
    type: t(`assistant.proposal.targets.${targetKeys[props.proposal.target_type]}`),
    id: props.proposal.target_id,
  })
))

const diffs = computed(() => {
  const before = props.proposal.before ?? {}
  const after = props.proposal.after ?? {}
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  return fields
    .map(field => ({ field, before: before[field], after: after[field] }))
    .filter(row => valueText(row.before) !== valueText(row.after))
})

const expiredReason = computed(() => {
  const code = expiredReasonCode.value || (props.proposal.status === 'expired' ? String(props.proposal.error || '') : '')
  if (code && code in EXPIRED_REASONS) return t(`assistant.proposal.expiredReasons.${code}`)
  return t('assistant.proposal.expiredReasons.unknown')
})

const appliedMeta = computed(() => t('assistant.proposal.appliedMeta', {
  by: props.proposal.applied_by || t('assistant.proposal.localUser'),
  at: formatTime(props.proposal.applied_at),
}))

const EXPIRED_REASONS: Record<string, true> = {
  expired_7d: true,
  session_deleted: true,
  target_missing: true,
  parent_deleted: true,
  target_moved: true,
  message_failed: true,
  message_cancelled: true,
  process_restart: true,
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function fieldLabel(field: string): string {
  const key = `assistant.proposal.fields.${field}`
  const label = t(key)
  return label === key ? field : label
}

function isLongDiff(row: { before: unknown; after: unknown }): boolean {
  return valueText(row.before).length > 120 || valueText(row.after).length > 120
}

function isExpanded(field: string): boolean {
  return expandedFields.value.includes(field)
}

function toggleField(field: string): void {
  expandedFields.value = isExpanded(field)
    ? expandedFields.value.filter(item => item !== field)
    : [...expandedFields.value, field]
}

function shownValue(row: { field: string; before: unknown; after: unknown }, side: 'before' | 'after'): string {
  const text = valueText(row[side])
  if (isExpanded(row.field) || text.length <= 120) return text
  return `${text.slice(0, 120)}…`
}

function formatTime(value: string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function localizedActionError(err: any): string {
  const code = typeof err?.errorCode === 'string' ? err.errorCode : ''
  errorCode.value = code
  if (code.startsWith('AGENT_PROPOSAL_')) {
    const key = `assistant.proposal.errors.${code}`
    const text = t(key)
    if (text !== key) return text
  }
  if (code === 'AGENT_DISABLED') return t('assistant.errors.AGENT_DISABLED')
  return sanitizeErrorText(err?.message)
}

async function apply(): Promise<void> {
  if (!props.proposal || props.proposal.status !== 'proposed' || props.disabled || busy.value) return
  busy.value = 'apply'
  errorCode.value = ''
  errorText.value = ''
  conflictCurrent.value = null
  try {
    const result = await applyProposal(props.proposal.id)
    emit('applied', result.proposal)
  } catch (err: any) {
    errorText.value = localizedActionError(err)
    if (err?.errorCode === 'AGENT_PROPOSAL_CONFLICT' && err?.details?.current) {
      conflictCurrent.value = err.details.current as Record<string, unknown>
    }
    if (err?.errorCode === 'AGENT_PROPOSAL_EXPIRED' && err?.details?.reason) {
      expiredReasonCode.value = String(err.details.reason)
    }
  } finally {
    busy.value = null
  }
}

async function reject(): Promise<void> {
  if (!props.proposal || props.proposal.status !== 'proposed' || busy.value) return
  busy.value = 'reject'
  errorCode.value = ''
  errorText.value = ''
  try {
    await rejectProposal(props.proposal.id)
    confirmReject.value = false
  } catch (err: any) {
    errorText.value = localizedActionError(err)
  } finally {
    busy.value = null
  }
}
</script>

<style scoped>
.proposal-card {
  margin-top: 10px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px);
  background: var(--surface);
  font-size: 12.5px;
}
.proposal-card-applied { border-color: color-mix(in srgb, var(--success) 45%, var(--border)); }
.proposal-card-conflict,
.proposal-card-expired { border-color: color-mix(in srgb, var(--warning) 45%, var(--border)); }

.proposal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.proposal-head-main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.proposal-icon { color: var(--accent); flex-shrink: 0; }
.proposal-title { font-weight: 700; }
.proposal-target {
  font-size: 11.5px;
  color: var(--text-2);
  font-family: var(--font-mono, monospace);
}

.proposal-block { margin-top: 10px; }
.proposal-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
  margin-bottom: 4px;
}
.proposal-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-1);
  line-height: 1.5;
}
.proposal-text.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.proposal-diff {
  padding: 8px 0;
  border-top: 1px dashed var(--border);
}
.proposal-diff:first-of-type { border-top: none; }
.proposal-field {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-1);
}
.proposal-field code {
  font-size: 10.5px;
  color: var(--text-3, var(--text-2));
  font-weight: 400;
}
.proposal-values {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 4px;
}
.proposal-value {
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--surface-raised);
  min-width: 0;
}
.proposal-value-label {
  display: block;
  font-size: 10px;
  color: var(--text-2);
  margin-bottom: 2px;
}
.proposal-expand { margin-top: 4px; padding-left: 0; }

.proposal-alert {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--surface-raised);
  border: 1px solid var(--border);
}
.proposal-alert-warning {
  border-color: color-mix(in srgb, var(--warning) 45%, var(--border));
  background: var(--warning-bg, var(--surface-raised));
}
.proposal-alert-error {
  border-color: color-mix(in srgb, var(--error) 45%, var(--border));
  background: var(--error-bg, var(--surface-raised));
  color: var(--error);
}
.proposal-alert-title {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 700;
  margin-bottom: 4px;
}
.proposal-hint { margin: 4px 0 0; font-size: 11.5px; line-height: 1.5; }

.proposal-audit {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 10px;
  font-size: 11.5px;
}

.proposal-raw-wrap { margin-top: 10px; }
.proposal-raw {
  margin: 0;
  padding: 8px;
  max-height: 220px;
  overflow: auto;
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-1);
  font: 11px/1.5 var(--font-mono, monospace);
  white-space: pre-wrap;
  word-break: break-word;
}

.proposal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
}
</style>
