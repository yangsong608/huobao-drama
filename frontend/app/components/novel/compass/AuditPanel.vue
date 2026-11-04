<template>
  <transition name="slide-right">
    <aside v-if="visible" class="audit-panel">
      <header class="audit-head">
        <div class="audit-title">
          <ShieldAlert :size="16" />
          <span>{{ t('novels.compass.auditPanel.title') }}</span>
        </div>
        <div class="audit-counts">
          <span v-if="groups.error.length" class="count is-error">{{ groups.error.length }}</span>
          <span v-if="groups.warning.length" class="count is-warning">{{ groups.warning.length }}</span>
          <span v-if="groups.info.length" class="count is-info">{{ groups.info.length }}</span>
          <button type="button" class="close-btn" :aria-label="t('novels.compass.sidebar.close')" @click="emit('close')">
            <X :size="15" />
          </button>
        </div>
      </header>

      <div class="audit-body">
        <p v-if="!items.length" class="audit-empty">{{ t('novels.compass.auditPanel.empty') }}</p>
        <template v-else>
          <details
            v-for="severity in severities"
            v-show="groups[severity].length"
            :key="severity"
            class="audit-group"
            :open="severity !== 'info'"
          >
            <summary>
              <component :is="severityIcon(severity)" :size="14" />
              <span>{{ t(`novels.compass.auditPanel.severity.${severity}`) }}</span>
              <span class="group-count">{{ groups[severity].length }}</span>
            </summary>
            <div class="audit-list">
              <article
                v-for="(item, index) in groups[severity]"
                :key="`${severity}-${index}`"
                class="audit-item"
                tabindex="0"
                role="button"
                @click="locate(item)"
                @keydown.enter.prevent="locate(item)"
              >
                <p class="audit-message">{{ item.message }}</p>
                <div class="audit-meta">
                  <span v-if="typeLabel(item.type)" class="audit-type">{{ typeLabel(item.type) }}</span>
                  <span v-if="item.chapters?.length" class="audit-chapters">
                    {{ t('novels.compass.auditPanel.chapters', { list: item.chapters.join(', ') }) }}
                  </span>
                  <button type="button" class="locate-btn" @click.stop="locate(item)">
                    <LocateFixed :size="12" />
                    {{ t('novels.compass.auditPanel.locate') }}
                  </button>
                </div>
              </article>
            </div>
          </details>
        </template>
      </div>

      <footer class="audit-foot">
        {{ audit?.lastAuditAt
          ? t('novels.compass.auditPanel.lastAudit', { time: formatTime(audit.lastAuditAt) })
          : t('novels.compass.auditPanel.never') }}
      </footer>
    </aside>
  </transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, AlertTriangle, Info, LocateFixed, ShieldAlert, X } from 'lucide-vue-next'
import type { GraphAudit, GraphAuditItem } from '~/utils/novel-graph'

const props = defineProps<{
  audit: GraphAudit | null
  visible: boolean
}>()

const emit = defineEmits<{
  (event: 'locate', item: GraphAuditItem): void
  (event: 'close'): void
}>()

const { t, locale } = useI18n()

const severities = ['error', 'warning', 'info'] as const
type Severity = typeof severities[number]

const items = computed<GraphAuditItem[]>(() => props.audit?.inconsistencies || [])

const groups = computed<Record<Severity, GraphAuditItem[]>>(() => {
  const result: Record<Severity, GraphAuditItem[]> = { error: [], warning: [], info: [] }
  for (const item of items.value) {
    const severity = (severities as readonly string[]).includes(item.severity)
      ? item.severity as Severity
      : 'info'
    result[severity].push(item)
  }
  return result
})

function severityIcon(severity: Severity) {
  if (severity === 'error') return AlertCircle
  if (severity === 'warning') return AlertTriangle
  return Info
}

function typeLabel(type: string): string {
  if (!type) return ''
  const key = `novels.compass.auditPanel.types.${type}`
  const label = t(key)
  return label === key ? type : label
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(locale.value)
}

function locate(item: GraphAuditItem) {
  emit('locate', item)
}
</script>

<style scoped>
.audit-panel {
  width: 300px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--bg-hover);
  overflow: hidden;
}
.audit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.audit-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
}
.audit-counts {
  display: flex;
  align-items: center;
  gap: 4px;
}
.count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10.5px;
  line-height: 17px;
  text-align: center;
}
.count.is-error {
  background: color-mix(in srgb, var(--error) 16%, transparent);
  color: var(--error);
}
.count.is-warning {
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  color: var(--warning);
}
.count.is-info {
  background: color-mix(in srgb, var(--info) 16%, transparent);
  color: var(--info);
}
.close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.close-btn:hover {
  background: var(--bg-active, rgba(255, 255, 255, 0.08));
  color: var(--text-0);
}
.audit-body {
  flex: 1;
  overflow: auto;
  padding: 8px;
}
.audit-empty {
  margin: 0;
  padding: 28px 12px;
  text-align: center;
  color: var(--text-3);
  font-size: 12.5px;
}
.audit-group {
  margin-bottom: 6px;
}
.audit-group summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 6px;
  border-radius: 7px;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  list-style: none;
}
.audit-group summary::-webkit-details-marker {
  display: none;
}
.audit-group summary:hover {
  background: var(--bg-active, rgba(255, 255, 255, 0.06));
}
.group-count {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--text-3);
}
.audit-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 2px 0 6px;
}
.audit-item {
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--surface-raised);
  cursor: pointer;
}
.audit-item:hover {
  border-color: color-mix(in srgb, var(--novel-accent) 40%, var(--border));
}
.audit-message {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-1);
  word-break: break-word;
}
.audit-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--text-3);
}
.audit-type {
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-hover);
}
.audit-chapters {
  color: var(--text-3);
}
.locate-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-2);
  font-size: 10.5px;
  cursor: pointer;
}
.locate-btn:hover {
  color: var(--novel-accent);
  border-color: var(--novel-accent);
}
.audit-foot {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  font-size: 10.5px;
  color: var(--text-3);
}
.slide-right-enter-active,
.slide-right-leave-active {
  transition: transform 0.22s ease, opacity 0.22s ease;
}
.slide-right-enter-from,
.slide-right-leave-to {
  transform: translateX(16px);
  opacity: 0;
}
@media (max-width: 760px) {
  .audit-panel {
    width: 100%;
    border-left: none;
    border-top: 1px solid var(--border);
  }
}
</style>
