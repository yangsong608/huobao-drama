<template>
  <div v-if="open" class="overlay" @click.self="close">
    <div class="dialog merge-dialog">
      <div class="dialog-head">
        <div>
          <div class="dialog-title">{{ t('workbench.extractPreviewTitle') }}</div>
          <div class="merge-desc">{{ t('workbench.extractPreviewHint') }}</div>
        </div>
        <button class="btn btn-icon btn-sm btn-ghost ml-auto" type="button" :aria-label="t('common.close')" @click="close">×</button>
      </div>

      <div class="dialog-body">
        <div v-if="!plan" class="merge-empty">{{ t('workbench.extractPreviewEmpty') }}</div>
        <template v-else>
          <div class="merge-summary">
            <span class="merge-chip is-added">{{ t('workbench.mergeAdded') }} {{ plan.summary.added }}</span>
            <span class="merge-chip is-updated">{{ t('workbench.mergeUpdated') }} {{ plan.summary.updated }}</span>
            <span class="merge-chip is-removed">{{ t('workbench.mergeRemoved') }} {{ plan.summary.removed }}</span>
            <span class="merge-chip">{{ t('workbench.mergeKept') }} {{ plan.summary.kept }}</span>
            <span class="merge-chip">{{ t('workbench.mergeSkipped') }} {{ plan.summary.skipped }}</span>
            <span class="merge-chip">{{ t('workbench.mergeTombstoned') }} {{ plan.summary.tombstoned }}</span>
          </div>

          <div class="merge-groups">
            <article v-for="group in plan.groups" :key="group.storyboardId" class="merge-group">
              <header class="merge-group-head">
                <span class="merge-group-title">{{ t('workbench.shot', { n: group.storyboardNumber }) }}</span>
                <span v-if="group.skipped" class="merge-group-note">{{ t('workbench.mergeGroupSkipped') }}</span>
                <span v-else-if="!groupItems(group).length" class="merge-group-note">{{ t('workbench.mergeNoChange') }}</span>
              </header>
              <ul v-if="groupItems(group).length" class="merge-list">
                <li
                  v-for="item in groupItems(group)"
                  :key="itemKey(group, item)"
                  :class="['merge-item', `is-${item.kind}`, { 'is-skipped': isSkipped(group, item) }]"
                >
                  <label v-if="skippable(item)" class="merge-skip">
                    <input
                      type="checkbox"
                      :checked="isSkipped(group, item)"
                      @change="toggleSkip(group, item)"
                    />
                    {{ t('workbench.mergeSkip') }}
                  </label>
                  <span :class="['merge-kind', `is-${item.kind}`]">{{ kindLabel(item.kind) }}</span>
                  <span class="merge-text">{{ item.kind === 'kept' && item.previousText ? item.previousText : item.text }}</span>
                  <span v-if="item.kind === 'updated' && item.previousText" class="merge-prev">{{ item.previousText }}</span>
                  <span v-if="item.speakerName" class="merge-speaker">{{ item.speakerName }}</span>
                </li>
              </ul>
            </article>
          </div>
        </template>
      </div>

      <div class="dialog-foot">
        <span class="merge-foot">{{ t('workbench.mergeSkipHint') }}</span>
        <button class="btn" type="button" :disabled="applying" @click="close">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" type="button" :disabled="!plan || applying" @click="apply">
          {{ applying ? t('workbench.mergeApplying') : t('workbench.extractApply') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { MergeDecision, MergeGroup, MergeItem, MergeKind, MergePlan } from '~/composables/useApi'

const props = defineProps<{
  open: boolean
  plan: MergePlan | null
  applying?: boolean
}>()

const emit = defineEmits<{
  close: []
  apply: [decisions: MergeDecision[]]
}>()

const { t } = useI18n()
const skipped = ref<string[]>([])

watch(() => props.plan?.extractionId, () => { skipped.value = [] })

function groupItems(group: MergeGroup): MergeItem[] {
  return [
    ...group.added,
    ...group.updated,
    ...group.removed,
    ...group.kept,
    ...group.tombstoned,
  ]
}

function skippable(item: MergeItem) {
  return item.kind === 'added' || item.kind === 'updated' || item.kind === 'removed'
}

function itemKey(group: MergeGroup, item: MergeItem) {
  return `${group.storyboardId}|${item.kind}|${item.lineId ?? item.text}`
}

function isSkipped(group: MergeGroup, item: MergeItem) {
  return skipped.value.includes(itemKey(group, item))
}

function toggleSkip(group: MergeGroup, item: MergeItem) {
  const key = itemKey(group, item)
  skipped.value = skipped.value.includes(key)
    ? skipped.value.filter(entry => entry !== key)
    : [...skipped.value, key]
}

function kindLabel(kind: MergeKind) {
  const map: Record<MergeKind, string> = {
    added: t('workbench.mergeAdded'),
    updated: t('workbench.mergeUpdated'),
    removed: t('workbench.mergeRemoved'),
    kept: t('workbench.mergeKept'),
    tombstoned: t('workbench.mergeTombstoned'),
  }
  return map[kind]
}

function close() {
  if (props.applying) return
  emit('close')
}

function apply() {
  if (!props.plan) return
  const decisions: MergeDecision[] = []
  for (const group of props.plan.groups) {
    for (const item of groupItems(group)) {
      if (!skippable(item) || !isSkipped(group, item)) continue
      decisions.push({
        storyboardId: group.storyboardId,
        kind: item.kind,
        lineId: item.lineId,
        text: item.text,
        action: 'skip',
      })
    }
  }
  emit('apply', decisions)
}
</script>

<style scoped>
.merge-dialog { width: min(860px, 94vw); max-height: 88vh; }
.merge-desc { margin-top: 3px; font-size: 11.5px; color: var(--text-3); }
.merge-empty { padding: 28px; text-align: center; font-size: 12px; color: var(--text-3); }
.merge-summary { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.merge-chip { padding: 2px 9px; border-radius: 999px; background: var(--overlay-track); color: var(--text-2); font-size: 11px; }
.merge-chip.is-added { color: var(--success); background: var(--success-bg); }
.merge-chip.is-updated { color: var(--accent); background: var(--accent-bg); }
.merge-chip.is-removed { color: var(--action-danger); background: var(--danger-bg, rgba(217, 83, 79, .14)); }
.merge-groups { display: flex; flex-direction: column; gap: 10px; }
.merge-group { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.merge-group-head { display: flex; align-items: center; gap: 8px; }
.merge-group-title { font-size: 11.5px; font-weight: 700; color: var(--text-2); }
.merge-group-note { font-size: 10.5px; color: var(--text-3); }
.merge-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.merge-item { display: flex; align-items: baseline; gap: 7px; font-size: 11.5px; line-height: 1.5; flex-wrap: wrap; }
.merge-item.is-skipped { opacity: .45; }
.merge-skip { display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; color: var(--text-3); white-space: nowrap; }
.merge-kind { flex: none; padding: 1px 6px; border-radius: 4px; background: var(--overlay-track); color: var(--text-2); font-size: 10px; }
.merge-kind.is-added { color: var(--success); background: var(--success-bg); }
.merge-kind.is-updated { color: var(--accent); background: var(--accent-bg); }
.merge-kind.is-removed { color: var(--action-danger); background: var(--danger-bg, rgba(217, 83, 79, .14)); }
.merge-text { color: var(--text-1); min-width: 0; }
.merge-prev { color: var(--text-3); text-decoration: line-through; font-size: 10.5px; }
.merge-speaker { margin-left: auto; color: var(--text-3); font-size: 10.5px; white-space: nowrap; }
.merge-foot { flex: 1; min-width: 0; font-size: 11px; color: var(--text-3); }
</style>
