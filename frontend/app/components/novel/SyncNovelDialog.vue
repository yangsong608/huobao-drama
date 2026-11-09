<template>
  <div v-if="open" class="overlay" @click.self="close">
    <div class="dialog" style="width: min(680px, calc(100vw - 40px))" role="dialog" aria-modal="true" :aria-label="t('novels.sync.title')">
      <div class="dialog-head">
        <div>
          <h2 class="dialog-title">
            <RefreshCw :size="16" :stroke-width="1.8" />
            {{ t('novels.sync.title') }}
          </h2>
          <p class="dialog-sub">{{ t('novels.sync.subtitle', { title: novel?.title || '' }) }}</p>
        </div>
        <button type="button" class="btn btn-icon btn-sm ml-auto" :disabled="submitting" :aria-label="t('common.close')" @click="close">
          <X :size="16" :stroke-width="1.8" />
        </button>
      </div>

      <div class="dialog-body">
        <p v-if="loading" class="sync-hint">{{ t('novels.sync.loading') }}</p>
        <p v-else-if="errorText" class="form-error">{{ errorText }}</p>

        <template v-else-if="preview">
          <section class="sync-summary">
            <div class="sync-summary-main">
              <span class="sync-counts">{{ t('novels.sync.counts', preview.counts) }}</span>
              <span class="sync-synced">
                {{ preview.last_synced_at ? t('novels.sync.updatedAt', { time: formatTime(preview.last_synced_at) }) : t('novels.sync.neverSynced') }}
              </span>
            </div>
            <div class="sync-select-actions">
              <button type="button" class="sync-link" @click="selectAll">{{ t('novels.sync.selectAll') }}</button>
              <button type="button" class="sync-link" @click="selectNone">{{ t('novels.sync.selectNone') }}</button>
            </div>
          </section>

          <p v-if="!items.length" class="sync-hint">{{ t('novels.sync.empty') }}</p>
          <div v-else class="sync-items">
            <label v-for="item in items" :key="keyOf(item)" class="sync-item" :class="`is-${item.kind}`">
              <input
                type="checkbox"
                :checked="selectedKeys.has(keyOf(item))"
                :disabled="submitting"
                @change="toggle(item, $event)"
              />
              <span class="sync-kind" :class="`kind-${item.kind}`">{{ t(`novels.sync.kind.${item.kind}`) }}</span>
              <span class="sync-title">{{ item.title || t('novels.detail.untitled') }}</span>
              <span class="sync-part">#{{ item.part_no }}</span>
              <span v-if="item.char_count != null" class="sync-meta">{{ item.char_count }} {{ t('novels.detail.wordUnit') }}</span>
              <span v-if="item.kind === 'conflict' && item.reasons?.length" class="sync-reasons">
                {{ reasonsText(item) }}
              </span>
              <span v-if="item.kind === 'conflict' || item.kind === 'missing'" class="sync-action-hint">
                {{ actionHint(item) }}
              </span>
            </label>
          </div>
        </template>
      </div>

      <div v-if="preview && !loading" class="dialog-foot">
        <button type="button" class="btn" :disabled="submitting" @click="close">{{ t('common.cancel') }}</button>
        <button type="button" class="btn btn-primary" :disabled="submitting || !selectedKeys.size" @click="submit">
          <Loader2 v-if="submitting" :size="13" class="animate-spin" />
          {{ submitting ? t('novels.sync.submitting') : t('novels.sync.submit') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, RefreshCw, X } from 'lucide-vue-next'
import { novelAPI } from '~/composables/useNovelApi'
import { useOverlayHistory } from '~/composables/useOverlayHistory'

const props = defineProps<{ open: boolean; novel: any; importId: number | null }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  synced: [payload: any]
}>()
const { t } = useI18n()

const loading = ref(false)
const submitting = ref(false)
const errorText = ref('')
const preview = ref<any>(null)
const selectedKeys = ref<Set<string>>(new Set())
let loadSeq = 0

const items = computed<any[]>(() => Array.isArray(preview.value?.items) ? preview.value.items : [])

function keyOf(item: any): string {
  return `${item.chapter_no}:${item.part_no}`
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function reasonsText(item: any): string {
  return (item.reasons || []).map((reason: string) => t(`novels.sync.reason.${reason}`)).join('、')
}

function actionHint(item: any): string {
  if (item.kind === 'missing') return t('novels.sync.action.orphan')
  if (item.reasons?.includes('episode_deleted')) return t('novels.sync.action.recreate')
  return t('novels.sync.overwriteHint')
}

function actionOf(item: any): string {
  if (item.kind === 'new') return 'create'
  if (item.kind === 'updated') return 'update'
  if (item.kind === 'missing') return 'orphan'
  return item.reasons?.includes('episode_deleted') ? 'recreate' : 'overwrite'
}

function toggle(item: any, event: Event) {
  const next = new Set(selectedKeys.value)
  if ((event.target as HTMLInputElement).checked) next.add(keyOf(item))
  else next.delete(keyOf(item))
  selectedKeys.value = next
}

function selectAll() {
  selectedKeys.value = new Set(items.value.map((item) => keyOf(item)))
}

function selectNone() {
  selectedKeys.value = new Set()
}

function close() {
  if (submitting.value) return
  emit('update:open', false)
}

// 返回键 / 返回手势先关弹窗（提交中保持原状）
const overlay = useOverlayHistory(() => close())
watch(() => props.open, (open) => {
  if (open) overlay.open()
  else overlay.close()
})

async function load() {
  if (!props.open || !props.importId || !props.novel?.id) return
  const seq = ++loadSeq
  loading.value = true
  submitting.value = false
  errorText.value = ''
  preview.value = null
  selectedKeys.value = new Set()
  try {
    const data: any = await novelAPI.previewSync(props.novel.id, props.importId)
    if (seq !== loadSeq) return
    preview.value = data
    selectedKeys.value = new Set((data.items || [])
      .filter((item: any) => item.kind === 'new' || item.kind === 'updated')
      .map((item: any) => keyOf(item)))
  } catch (error: any) {
    if (seq === loadSeq) errorText.value = error?.message || t('novels.sync.failed')
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

watch(() => [props.open, props.importId], load, { immediate: true })

async function submit() {
  if (!preview.value || !selectedKeys.value.size) return
  const selected = items.value.filter((item) => selectedKeys.value.has(keyOf(item)))
  const risky = selected.filter((item) => item.kind === 'conflict')
  if (risky.length && !window.confirm(t('novels.sync.confirmOverwrite', { n: risky.length }))) return

  submitting.value = true
  errorText.value = ''
  try {
    const result: any = await novelAPI.sync(props.novel.id, props.importId, {
      items: selected.map((item) => ({
        chapter_no: item.chapter_no,
        part_no: item.part_no,
        action: actionOf(item),
      })),
    })
    emit('synced', result)
    emit('update:open', false)
  } catch (error: any) {
    errorText.value = error?.message || t('novels.sync.failed')
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sync-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-hover);
}
.sync-summary-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sync-counts {
  color: var(--text-0);
  font-size: 13px;
  font-weight: 550;
}
.sync-synced {
  color: var(--text-3);
  font-size: 11.5px;
}
.sync-select-actions {
  display: flex;
  gap: 12px;
}
.sync-link {
  border: none;
  background: transparent;
  color: var(--accent-text);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}
.sync-link:hover {
  text-decoration: underline;
}
.sync-items {
  display: flex;
  flex-direction: column;
  max-height: 330px;
  overflow-y: auto;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-base);
}
.sync-item {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  cursor: pointer;
}
.sync-item:last-child {
  border-bottom: none;
}
.sync-item.is-conflict {
  background: color-mix(in srgb, var(--warning) 7%, transparent);
}
.sync-item.is-missing {
  opacity: 0.7;
}
.sync-kind {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--overlay-track);
  color: var(--text-2);
}
.sync-kind.kind-new {
  color: var(--success);
}
.sync-kind.kind-updated {
  color: var(--accent-text);
}
.sync-kind.kind-conflict {
  color: var(--warning);
}
.sync-title {
  color: var(--text-0);
  font-weight: 500;
}
.sync-part,
.sync-meta {
  color: var(--text-3);
  font-size: 11.5px;
}
.sync-reasons,
.sync-action-hint {
  width: 100%;
  padding-left: 24px;
  color: var(--text-3);
  font-size: 11.5px;
}
.sync-action-hint {
  color: var(--text-2);
}
.sync-hint {
  margin: 0;
  color: var(--text-3);
  font-size: 12.5px;
}
</style>
