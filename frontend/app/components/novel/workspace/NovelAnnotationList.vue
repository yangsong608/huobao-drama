<template>
  <div class="annotation-list">
    <div class="annotation-toolbar">
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        :disabled="!selection"
        :title="selection ? undefined : String(t('novels.workbench.annotations.addHint'))"
        @click="openCreate"
      >
        {{ t('novels.workbench.annotations.add') }}
      </button>
      <span v-if="selection" class="annotation-selection-hint">
        {{ t('novels.workbench.annotations.selectionReady', { n: selection.quote.length }) }}
      </span>
      <span v-else class="annotation-selection-hint">{{ t('novels.workbench.annotations.addHint') }}</span>
    </div>

    <p v-if="error" class="panel-error">{{ error }}</p>

    <form v-if="creating" class="annotation-create" @submit.prevent="saveCreate">
      <div class="annotation-field">
        <span class="annotation-field-label">{{ t('novels.workbench.annotations.quoteLabel') }}</span>
        <blockquote v-if="selection" class="annotation-quote">{{ selection.quote }}</blockquote>
        <p v-else class="annotation-orphan-hint">{{ t('novels.workbench.annotations.addHint') }}</p>
      </div>
      <div class="annotation-field">
        <span class="annotation-field-label">{{ t('novels.workbench.annotations.kindLabel') }}</span>
        <select v-model="createKind" class="input input-sm">
          <option v-for="kind in KINDS" :key="kind" :value="kind">
            {{ t(`novels.workbench.annotations.kinds.${kind}`) }}
          </option>
        </select>
      </div>
      <div class="annotation-field">
        <span class="annotation-field-label">{{ t('novels.workbench.annotations.noteLabel') }}</span>
        <textarea
          ref="noteInput"
          v-model="createNote"
          class="textarea annotation-note-input"
          rows="3"
          :placeholder="t('novels.workbench.annotations.notePlaceholder')"
        ></textarea>
      </div>
      <div class="annotation-actions">
        <button type="submit" class="btn btn-primary btn-sm" :disabled="!selection || busy">
          {{ t('novels.workbench.annotations.save') }}
        </button>
        <button type="button" class="btn btn-ghost btn-sm" @click="creating = false">
          {{ t('novels.workbench.annotations.cancel') }}
        </button>
      </div>
    </form>

    <StudioEmptyState
      v-if="!sorted.length && !creating"
      icon="📝"
      :title="t('novels.workbench.annotations.emptyTitle')"
      :description="t('novels.workbench.annotations.emptyDesc')"
    />

    <article
      v-for="(annotation, index) in visible"
      :key="annotation.id"
      :class="['annotation-card', {
        on: activeId === annotation.id,
        orphaned: annotation.status === 'orphaned',
        resolved: annotation.status === 'resolved',
      }]"
      @click="activate(annotation)"
    >
      <header class="annotation-card-head">
        <span class="annotation-no">{{ index + 1 }}</span>
        <span class="annotation-kind">{{ t(`novels.workbench.annotations.kinds.${annotation.kind || 'note'}`) }}</span>
        <span
          v-if="annotation.status !== 'open'"
          :class="['annotation-status', annotation.status]"
        >{{ t(`novels.workbench.annotations.status.${annotation.status}`) }}</span>
        <time v-if="annotation.created_at" class="annotation-time">{{ formatTime(annotation.created_at) }}</time>
      </header>

      <blockquote class="annotation-quote">{{ annotation.quote }}</blockquote>

      <template v-if="editingId === annotation.id">
        <select v-model="editKind" class="input input-sm">
          <option v-for="kind in KINDS" :key="kind" :value="kind">
            {{ t(`novels.workbench.annotations.kinds.${kind}`) }}
          </option>
        </select>
        <textarea v-model="editNote" class="textarea annotation-note-input" rows="3"></textarea>
        <div class="annotation-actions">
          <button type="button" class="btn btn-primary btn-sm" :disabled="busy" @click.stop="saveEdit(annotation)">
            {{ t('novels.workbench.annotations.save') }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" @click.stop="editingId = null">
            {{ t('novels.workbench.annotations.cancel') }}
          </button>
        </div>
      </template>

      <template v-else>
        <p v-if="annotation.note" class="annotation-note">{{ annotation.note }}</p>
        <p v-if="annotation.status === 'orphaned'" class="annotation-orphan-hint">
          {{ t('novels.workbench.annotations.orphanedHint') }}
        </p>

        <div v-if="rebindingId === annotation.id" class="annotation-rebind">
          <p class="annotation-orphan-hint">
            {{ selection
              ? t('novels.workbench.annotations.rebindReady', { quote: selection.quote.slice(0, 30) })
              : t('novels.workbench.annotations.rebindHint') }}
          </p>
          <div class="annotation-actions">
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="!selection || busy"
              @click.stop="saveRebind(annotation)"
            >
              {{ t('novels.workbench.annotations.rebind') }}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click.stop="rebindingId = null">
              {{ t('novels.workbench.annotations.cancel') }}
            </button>
          </div>
        </div>

        <div v-else class="annotation-actions">
          <button
            v-if="annotation.status === 'orphaned'"
            type="button"
            class="btn btn-ghost btn-sm"
            @click.stop="startRebind(annotation)"
          >
            {{ t('novels.workbench.annotations.rebind') }}
          </button>
          <template v-else>
            <button type="button" class="btn btn-ghost btn-sm" @click.stop="startEdit(annotation)">
              {{ t('novels.workbench.annotations.edit') }}
            </button>
            <button
              v-if="annotation.status === 'resolved'"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy"
              @click.stop="setStatus(annotation, 'open')"
            >
              {{ t('novels.workbench.annotations.reopen') }}
            </button>
            <button
              v-else
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy"
              @click.stop="setStatus(annotation, 'resolved')"
            >
              {{ t('novels.workbench.annotations.resolve') }}
            </button>
          </template>
          <button
            type="button"
            class="btn btn-ghost btn-sm annotation-delete"
            :disabled="busy"
            @click.stop="remove(annotation)"
          >
            {{ t('novels.workbench.annotations.delete') }}
          </button>
        </div>
      </template>
    </article>

    <button
      v-if="resolvedCount"
      type="button"
      class="annotation-resolved-toggle"
      @click="showResolved = !showResolved"
    >
      {{ showResolved
        ? t('novels.workbench.annotations.hideResolved')
        : t('novels.workbench.annotations.showResolved') }}
      ({{ resolvedCount }})
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { novelAPI } from '~/composables/useNovelApi'
import type { NovelSelection, WorkbenchAnnotation } from '~/composables/useNovelWorkbench'

const props = defineProps<{
  novelId: number
  chapterNo: number
  annotations: WorkbenchAnnotation[]
  selection: NovelSelection | null
  activeId: number | null
  draftNonce: number
}>()
const emit = defineEmits<{
  (event: 'changed'): void
  (event: 'locate', annotation: WorkbenchAnnotation): void
  (event: 'active', annotationId: number | null): void
}>()

const KINDS = ['note', 'adapt', 'question'] as const

const { t } = useI18n()
const creating = ref(false)
const createNote = ref('')
const createKind = ref<string>('note')
const editingId = ref<number | null>(null)
const editNote = ref('')
const editKind = ref<string>('note')
const rebindingId = ref<number | null>(null)
const showResolved = ref(false)
const busy = ref(false)
const error = ref('')
const noteInput = ref<HTMLTextAreaElement | null>(null)

const sorted = computed(() =>
  [...props.annotations].sort((a, b) => a.start_offset - b.start_offset || a.id - b.id),
)
const resolvedCount = computed(() => sorted.value.filter((item) => item.status === 'resolved').length)
const visible = computed(() =>
  sorted.value.filter((item) => showResolved.value || item.status !== 'resolved' || item.id === props.activeId),
)

watch(() => props.draftNonce, (value) => {
  if (value) openCreate()
})

watch(() => props.chapterNo, () => {
  creating.value = false
  editingId.value = null
  rebindingId.value = null
  error.value = ''
})

function openCreate() {
  if (!props.selection) return
  creating.value = true
  createNote.value = ''
  createKind.value = 'note'
  editingId.value = null
  rebindingId.value = null
  error.value = ''
  nextTick(() => noteInput.value?.focus())
}

function activate(annotation: WorkbenchAnnotation) {
  emit('active', annotation.id)
  emit('locate', annotation)
}

function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

async function saveCreate() {
  if (!props.selection || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await novelAPI.createAnnotation(props.novelId, {
      chapter_no: props.chapterNo,
      quote: props.selection.quote,
      start_offset: props.selection.start,
      end_offset: props.selection.end,
      prefix: props.selection.prefix,
      suffix: props.selection.suffix,
      note: createNote.value.trim(),
      kind: createKind.value,
    })
    creating.value = false
    emit('changed')
  } catch (err: any) {
    error.value = err?.message || String(t('novels.workbench.annotations.saveFailed'))
  } finally {
    busy.value = false
  }
}

function startEdit(annotation: WorkbenchAnnotation) {
  editingId.value = annotation.id
  editNote.value = annotation.note || ''
  editKind.value = annotation.kind || 'note'
  creating.value = false
  rebindingId.value = null
  error.value = ''
}

async function saveEdit(annotation: WorkbenchAnnotation) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await novelAPI.updateAnnotation(props.novelId, annotation.id, {
      note: editNote.value.trim(),
      kind: editKind.value,
    })
    editingId.value = null
    emit('changed')
  } catch (err: any) {
    error.value = err?.message || String(t('novels.workbench.annotations.saveFailed'))
  } finally {
    busy.value = false
  }
}

async function setStatus(annotation: WorkbenchAnnotation, status: 'open' | 'resolved') {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await novelAPI.updateAnnotation(props.novelId, annotation.id, { status })
    emit('changed')
  } catch (err: any) {
    error.value = err?.message || String(t('novels.workbench.annotations.saveFailed'))
  } finally {
    busy.value = false
  }
}

function startRebind(annotation: WorkbenchAnnotation) {
  rebindingId.value = annotation.id
  creating.value = false
  editingId.value = null
  error.value = ''
}

async function saveRebind(annotation: WorkbenchAnnotation) {
  if (!props.selection || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await novelAPI.updateAnnotation(props.novelId, annotation.id, {
      quote: props.selection.quote,
      start_offset: props.selection.start,
      end_offset: props.selection.end,
      prefix: props.selection.prefix,
      suffix: props.selection.suffix,
      status: 'open',
    })
    rebindingId.value = null
    emit('changed')
  } catch (err: any) {
    error.value = err?.message || String(t('novels.workbench.annotations.saveFailed'))
  } finally {
    busy.value = false
  }
}

async function remove(annotation: WorkbenchAnnotation) {
  if (busy.value) return
  if (!window.confirm(String(t('novels.workbench.annotations.deleteConfirm')))) return
  busy.value = true
  error.value = ''
  try {
    await novelAPI.deleteAnnotation(props.novelId, annotation.id)
    if (props.activeId === annotation.id) emit('active', null)
    emit('changed')
  } catch (err: any) {
    error.value = err?.message || String(t('novels.workbench.annotations.saveFailed'))
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.annotation-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  min-height: 0;
}
.annotation-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.annotation-selection-hint {
  font-size: 11px;
  color: var(--text-3);
}
.panel-error {
  margin: 0;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--error) 45%, transparent);
  background: var(--error-bg);
  color: var(--error);
  font-size: 11.5px;
}
.annotation-create {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}
.annotation-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.annotation-field-label {
  font-size: 11px;
  color: var(--text-3);
}
.annotation-note-input {
  min-height: 64px;
  font-size: 12px;
  resize: vertical;
}
.annotation-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-1);
  cursor: pointer;
  transition: border-color 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out);
}
.annotation-card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
.annotation-card.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
}
.annotation-card.orphaned {
  border-style: dashed;
}
.annotation-card.resolved {
  opacity: 0.78;
}
.annotation-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.annotation-no {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--bg-2);
  color: var(--text-2);
  font-size: 10px;
  font-weight: 700;
}
.annotation-kind {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--overlay-track);
  color: var(--text-2);
  font-size: 10.5px;
}
.annotation-status {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10.5px;
}
.annotation-status.orphaned {
  background: color-mix(in srgb, #e0a43c 16%, transparent);
  color: #e0a43c;
}
.annotation-status.resolved {
  background: var(--success-bg);
  color: var(--success);
}
.annotation-time {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-3);
}
.annotation-quote {
  margin: 0;
  padding: 6px 8px;
  border-left: 2px solid var(--accent);
  border-radius: 0 6px 6px 0;
  background: var(--bg-2);
  color: var(--text-1);
  font-size: 11.5px;
  line-height: 1.55;
  overflow-wrap: break-word;
}
.annotation-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-1);
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.annotation-orphan-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: #e0a43c;
}
.annotation-rebind {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.annotation-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.annotation-actions .btn {
  padding: 3px 8px;
  font-size: 11px;
}
.annotation-delete {
  margin-left: auto;
  color: var(--error);
}
.annotation-resolved-toggle {
  align-self: flex-start;
  padding: 2px 0;
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
}
.annotation-resolved-toggle:hover {
  color: var(--text-1);
}
</style>
