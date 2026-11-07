<template>
  <div class="foreshadow-board">
    <div class="foreshadow-toolbar">
      <button type="button" class="btn btn-ghost btn-sm" :disabled="creating" @click="openCreate">
        {{ t('novels.workbench.foreshadow.add') }}
      </button>
      <button
        v-if="autoExtract"
        type="button"
        class="btn btn-ghost btn-sm"
        :disabled="extracting"
        @click="extractCandidates"
      >
        {{ extracting ? t('novels.workbench.foreshadow.extracting') : t('novels.workbench.foreshadow.extract') }}
      </button>
    </div>

    <p v-if="error" class="panel-error">{{ error }}</p>

    <form v-if="creating" class="foreshadow-form" @submit.prevent="saveForm">
      <label class="foreshadow-field">
        <span>{{ t('novels.workbench.foreshadow.titleLabel') }}</span>
        <input v-model="form.title" class="input input-sm" :placeholder="t('novels.workbench.foreshadow.titlePlaceholder')" />
      </label>
      <div class="foreshadow-row">
        <label class="foreshadow-field">
          <span>{{ t('novels.workbench.foreshadow.setupLabel') }}</span>
          <input v-model="form.setupChapter" class="input input-sm" type="number" min="1" :max="chapterCount" />
        </label>
        <label class="foreshadow-field">
          <span>{{ t('novels.workbench.foreshadow.payoffLabel') }}</span>
          <input
            v-model="form.payoffChapter"
            class="input input-sm"
            type="number"
            min="1"
            :max="chapterCount"
            :placeholder="t('novels.workbench.foreshadow.payoffNone')"
          />
        </label>
      </div>
      <label class="foreshadow-field">
        <span>{{ t('novels.workbench.foreshadow.sourceLabel') }}</span>
        <select v-model="form.source" class="input input-sm">
          <option v-for="source in SOURCES" :key="source" :value="source">
            {{ t(`novels.workbench.foreshadow.sources.${source}`) }}
          </option>
        </select>
      </label>
      <label class="foreshadow-field">
        <span>{{ t('novels.workbench.foreshadow.evidenceLabel') }}</span>
        <textarea
          v-model="form.evidence"
          class="textarea foreshadow-textarea"
          rows="2"
          :placeholder="t('novels.workbench.foreshadow.evidencePlaceholder')"
        ></textarea>
      </label>
      <label class="foreshadow-field">
        <span>{{ t('novels.workbench.foreshadow.noteLabel') }}</span>
        <textarea
          v-model="form.note"
          class="textarea foreshadow-textarea"
          rows="2"
          :placeholder="t('novels.workbench.foreshadow.notePlaceholder')"
        ></textarea>
      </label>
      <div class="foreshadow-actions">
        <button type="submit" class="btn btn-primary btn-sm" :disabled="busy">
          {{ t('novels.workbench.foreshadow.save') }}
        </button>
        <button type="button" class="btn btn-ghost btn-sm" @click="creating = false">
          {{ t('novels.workbench.foreshadow.cancel') }}
        </button>
      </div>
    </form>

    <section v-if="candidatesOpen" class="foreshadow-candidates">
      <header class="foreshadow-candidates-head">
        <span>{{ t('novels.workbench.foreshadow.candidatesTitle') }}</span>
        <button type="button" class="foreshadow-link" @click="candidatesOpen = false">
          {{ t('novels.workbench.foreshadow.dismiss') }}
        </button>
      </header>
      <p v-if="!candidates.length" class="foreshadow-group-empty">
        {{ t('novels.workbench.foreshadow.candidateEmpty') }}
      </p>
      <article v-for="(candidate, index) in candidates" :key="`${candidate.title}-${candidate.setup_chapter}`" class="foreshadow-candidate">
        <div class="foreshadow-candidate-title">{{ candidate.title }}</div>
        <div class="foreshadow-candidate-meta">
          {{ t('novels.workbench.foreshadow.chapter', { n: candidate.setup_chapter }) }}
        </div>
        <div class="foreshadow-actions">
          <button type="button" class="btn btn-primary btn-sm" :disabled="busy" @click="confirmCandidate(candidate, index)">
            {{ t('novels.workbench.foreshadow.confirmCandidate') }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" @click="candidates.splice(index, 1)">
            {{ t('novels.workbench.foreshadow.dismiss') }}
          </button>
        </div>
      </article>
    </section>

    <section v-if="related.length" class="foreshadow-related">
      <header class="foreshadow-group-head">
        <span>{{ t('novels.workbench.foreshadow.relatedTitle') }}</span>
        <span class="foreshadow-group-count">{{ related.length }}</span>
      </header>
      <div
        v-for="item in related"
        :key="`related-${item.id}`"
        :class="['foreshadow-related-item', { on: activeId === item.id }]"
        @click="emit('active', item.id)"
      >
        <span :class="['foreshadow-status-dot', item.status]" :title="statusLabel(item.status)"></span>
        <span class="foreshadow-related-title">{{ item.title }}</span>
        <button
          v-if="item.setup_chapter"
          type="button"
          class="foreshadow-chapter-link"
          @click.stop="emit('jump', item.setup_chapter)"
        >{{ t('novels.workbench.foreshadow.jumpSetup', { n: item.setup_chapter }) }}</button>
        <button
          v-if="item.payoff_chapter"
          type="button"
          class="foreshadow-chapter-link"
          @click.stop="emit('jump', item.payoff_chapter)"
        >{{ t('novels.workbench.foreshadow.jumpPayoff', { n: item.payoff_chapter }) }}</button>
      </div>
    </section>

    <StudioEmptyState
      v-if="!sorted.length && !creating"
      icon="🪢"
      :title="t('novels.workbench.foreshadow.emptyTitle')"
      :description="t('novels.workbench.foreshadow.emptyDesc')"
    />

    <section v-for="group in groups" :key="group.status" class="foreshadow-group">
      <header class="foreshadow-group-head">
        <span>{{ statusLabel(group.status) }}</span>
        <span class="foreshadow-group-count">{{ group.items.length }}</span>
      </header>
      <p v-if="!group.items.length" class="foreshadow-group-empty">
        {{ t('novels.workbench.foreshadow.groupEmpty') }}
      </p>
      <article
        v-for="item in group.items"
        :key="item.id"
        :class="['foreshadow-card', { on: activeId === item.id, related: isRelated(item) }]"
        @click="emit('active', item.id)"
      >
        <header class="foreshadow-card-head">
          <span class="foreshadow-card-title">{{ item.title }}</span>
          <span class="foreshadow-source">{{ sourceLabel(item.source) }}</span>
        </header>
        <div class="foreshadow-card-meta">
          <button
            v-if="item.setup_chapter"
            type="button"
            class="foreshadow-chapter-link"
            @click.stop="emit('jump', item.setup_chapter)"
          >{{ t('novels.workbench.foreshadow.chapter', { n: item.setup_chapter }) }}</button>
          <span class="foreshadow-arrow">→</span>
          <button
            v-if="item.payoff_chapter"
            type="button"
            class="foreshadow-chapter-link"
            @click.stop="emit('jump', item.payoff_chapter)"
          >{{ t('novels.workbench.foreshadow.chapter', { n: item.payoff_chapter }) }}</button>
          <span v-else class="foreshadow-unset">{{ t('novels.workbench.foreshadow.payoffNone') }}</span>
          <span v-if="isRelated(item)" class="foreshadow-current">
            {{ t('novels.workbench.foreshadow.currentChapter') }}
          </span>
          <time v-if="item.updated_at" class="foreshadow-time">{{ formatTime(item.updated_at) }}</time>
        </div>
        <blockquote v-if="item.evidence_quote" class="foreshadow-evidence">{{ item.evidence_quote }}</blockquote>
        <p v-if="item.note" class="foreshadow-note">{{ item.note }}</p>

        <template v-if="editingId === item.id">
          <div class="foreshadow-form inline" @click.stop>
            <label class="foreshadow-field">
              <span>{{ t('novels.workbench.foreshadow.titleLabel') }}</span>
              <input v-model="form.title" class="input input-sm" />
            </label>
            <div class="foreshadow-row">
              <label class="foreshadow-field">
                <span>{{ t('novels.workbench.foreshadow.setupLabel') }}</span>
                <input v-model="form.setupChapter" class="input input-sm" type="number" min="1" :max="chapterCount" />
              </label>
              <label class="foreshadow-field">
                <span>{{ t('novels.workbench.foreshadow.payoffLabel') }}</span>
                <input v-model="form.payoffChapter" class="input input-sm" type="number" min="1" :max="chapterCount" />
              </label>
            </div>
            <label class="foreshadow-field">
              <span>{{ t('novels.workbench.foreshadow.sourceLabel') }}</span>
              <select v-model="form.source" class="input input-sm">
                <option v-for="source in SOURCES" :key="source" :value="source">
                  {{ t(`novels.workbench.foreshadow.sources.${source}`) }}
                </option>
              </select>
            </label>
            <label class="foreshadow-field">
              <span>{{ t('novels.workbench.foreshadow.evidenceLabel') }}</span>
              <textarea v-model="form.evidence" class="textarea foreshadow-textarea" rows="2"></textarea>
            </label>
            <label class="foreshadow-field">
              <span>{{ t('novels.workbench.foreshadow.noteLabel') }}</span>
              <textarea v-model="form.note" class="textarea foreshadow-textarea" rows="2"></textarea>
            </label>
            <div class="foreshadow-actions">
              <button type="button" class="btn btn-primary btn-sm" :disabled="busy" @click.stop="saveForm">
                {{ t('novels.workbench.foreshadow.save') }}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" @click.stop="editingId = null">
                {{ t('novels.workbench.foreshadow.cancel') }}
              </button>
            </div>
          </div>
        </template>

        <div v-else class="foreshadow-actions" @click.stop>
          <button
            v-for="target in statusActions(item.status)"
            :key="target"
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="busy"
            @click="transition(item, target)"
          >{{ actionLabel(item.status, target) }}</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="startEdit(item)">
            {{ t('novels.workbench.foreshadow.edit') }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm foreshadow-delete" :disabled="busy" @click="remove(item)">
            {{ t('novels.workbench.foreshadow.delete') }}
          </button>
        </div>
      </article>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { novelAPI } from '~/composables/useNovelApi'

const props = defineProps<{
  novelId: number
  chapterNo: number
  chapterCount: number
  foreshadows: any[]
  autoExtract: boolean
  activeId: number | null
}>()
const emit = defineEmits<{
  (event: 'changed'): void
  (event: 'jump', chapterNo: number): void
  (event: 'active', foreshadowId: number | null): void
}>()

const STATUS_ORDER = ['planned', 'planted', 'reinforced', 'paid', 'abandoned'] as const
const SOURCES = ['manual', 'blueprint', 'agent'] as const
const STATUS_ACTIONS: Record<string, string[]> = {
  planned: ['planted', 'abandoned'],
  planted: ['reinforced', 'paid', 'abandoned'],
  reinforced: ['paid', 'abandoned'],
  paid: ['planted'],
  abandoned: ['planned'],
}

const { t } = useI18n()
const creating = ref(false)
const editingId = ref<number | null>(null)
const busy = ref(false)
const error = ref('')
const extracting = ref(false)
const candidatesOpen = ref(false)
const candidates = ref<any[]>([])
const form = reactive({
  title: '',
  setupChapter: '',
  payoffChapter: '',
  source: 'manual',
  evidence: '',
  note: '',
})

const sorted = computed(() => {
  const related = (item: any) => (isRelated(item) ? 1 : 0)
  return [...props.foreshadows].sort((a, b) =>
    related(b) - related(a)
    || Number(a.setup_chapter || 0) - Number(b.setup_chapter || 0)
    || Number(a.id) - Number(b.id),
  )
})
const related = computed(() => sorted.value.filter((item) => isRelated(item)))
const groups = computed(() => STATUS_ORDER.map((status) => ({
  status,
  items: sorted.value.filter((item) => item.status === status),
})))

watch(() => props.chapterNo, () => {
  creating.value = false
  editingId.value = null
  error.value = ''
})

function isRelated(item: any) {
  return Number(item.setup_chapter) === props.chapterNo || Number(item.payoff_chapter) === props.chapterNo
}

function statusLabel(status: string) {
  return t(`novels.workbench.foreshadow.statuses.${status}`)
}

function sourceLabel(source: string) {
  return t(`novels.workbench.foreshadow.sources.${source || 'manual'}`)
}

function statusActions(status: string) {
  return STATUS_ACTIONS[status] || []
}

function actionLabel(from: string, target: string) {
  if (target === 'planted' && from === 'paid') return t('novels.workbench.foreshadow.reopenPlanted')
  if (target === 'planned' && from === 'abandoned') return t('novels.workbench.foreshadow.reopenPlanned')
  if (target === 'planted') return t('novels.workbench.foreshadow.plant')
  if (target === 'reinforced') return t('novels.workbench.foreshadow.reinforce')
  if (target === 'paid') return t('novels.workbench.foreshadow.payoff')
  return t('novels.workbench.foreshadow.abandon')
}

function formatTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString()
}

function resetForm() {
  form.title = ''
  form.setupChapter = String(props.chapterNo || 1)
  form.payoffChapter = ''
  form.source = 'manual'
  form.evidence = ''
  form.note = ''
}

function openCreate() {
  creating.value = true
  editingId.value = null
  error.value = ''
  resetForm()
}

function startEdit(item: any) {
  creating.value = false
  editingId.value = item.id
  error.value = ''
  form.title = item.title || ''
  form.setupChapter = String(item.setup_chapter || '')
  form.payoffChapter = item.payoff_chapter ? String(item.payoff_chapter) : ''
  form.source = item.source || 'manual'
  form.evidence = item.evidence_quote || ''
  form.note = item.note || ''
}

function payload() {
  const title = form.title.trim()
  if (!title) {
    error.value = String(t('novels.workbench.foreshadow.titleLabel'))
    return null
  }
  const setupChapter = Number(form.setupChapter)
  if (!Number.isSafeInteger(setupChapter) || setupChapter < 1) {
    error.value = String(t('novels.workbench.foreshadow.setupLabel'))
    return null
  }
  return {
    title,
    setup_chapter: setupChapter,
    payoff_chapter: form.payoffChapter === '' ? null : Number(form.payoffChapter),
    source: form.source,
    evidence_quote: form.evidence.trim(),
    note: form.note.trim(),
  }
}

async function saveForm() {
  if (busy.value) return
  const body = payload()
  if (!body) return
  busy.value = true
  error.value = ''
  try {
    if (editingId.value) {
      await novelAPI.updateForeshadow(props.novelId, editingId.value, body)
      editingId.value = null
    } else {
      await novelAPI.createForeshadow(props.novelId, body)
      creating.value = false
    }
    emit('changed')
  } catch (err: any) {
    error.value = err?.message || String(t('novels.workbench.foreshadow.saveFailed'))
  } finally {
    busy.value = false
  }
}

async function transition(item: any, status: string) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await novelAPI.updateForeshadow(props.novelId, item.id, { status })
    emit('changed')
  } catch (err: any) {
    error.value = err?.message || String(t('novels.workbench.foreshadow.transitionFailed'))
  } finally {
    busy.value = false
  }
}

async function remove(item: any) {
  if (busy.value) return
  if (!window.confirm(String(t('novels.workbench.foreshadow.deleteConfirm')))) return
  busy.value = true
  error.value = ''
  try {
    await novelAPI.deleteForeshadow(props.novelId, item.id)
    if (props.activeId === item.id) emit('active', null)
    emit('changed')
  } catch (err: any) {
    error.value = err?.message || String(t('novels.workbench.foreshadow.saveFailed'))
  } finally {
    busy.value = false
  }
}

async function extractCandidates() {
  if (extracting.value) return
  extracting.value = true
  error.value = ''
  try {
    const data: any = await novelAPI.foreshadowCandidates(props.novelId)
    candidates.value = Array.isArray(data?.items) ? data.items : []
    candidatesOpen.value = true
  } catch (err: any) {
    error.value = err?.message || String(t('novels.workbench.foreshadow.saveFailed'))
  } finally {
    extracting.value = false
  }
}

async function confirmCandidate(candidate: any, index: number) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await novelAPI.createForeshadow(props.novelId, {
      title: candidate.title,
      setup_chapter: candidate.setup_chapter,
      source: candidate.source || 'blueprint',
      evidence_quote: candidate.evidence_quote || '',
    })
    candidates.value.splice(index, 1)
    emit('changed')
  } catch (err: any) {
    error.value = err?.message || String(t('novels.workbench.foreshadow.saveFailed'))
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.foreshadow-board {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
}
.foreshadow-toolbar {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
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
.foreshadow-form {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}
.foreshadow-form.inline {
  margin-top: 6px;
  padding: 8px;
}
.foreshadow-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--text-3);
}
.foreshadow-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.foreshadow-textarea {
  min-height: 52px;
  font-size: 11.5px;
  resize: vertical;
}
.foreshadow-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.foreshadow-actions .btn {
  padding: 3px 8px;
  font-size: 11px;
}
.foreshadow-delete {
  margin-left: auto;
  color: var(--error);
}
.foreshadow-candidates {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px;
  border: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 10px;
}
.foreshadow-candidates-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 650;
  color: var(--text-1);
}
.foreshadow-candidate {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 7px 8px;
  border-radius: 8px;
  background: var(--bg-1);
}
.foreshadow-candidate-title {
  font-size: 12px;
  color: var(--text-0);
}
.foreshadow-candidate-meta {
  font-size: 10.5px;
  color: var(--text-3);
}
.foreshadow-link {
  border: none;
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  cursor: pointer;
}
.foreshadow-related {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border-radius: 10px;
  background: color-mix(in srgb, #e0a43c 8%, transparent);
}
.foreshadow-related-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 6px;
  cursor: pointer;
}
.foreshadow-related-item.on {
  background: var(--bg-2);
}
.foreshadow-related-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--text-1);
}
.foreshadow-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-3);
  flex-shrink: 0;
}
.foreshadow-status-dot.planned { background: #8a8f98; }
.foreshadow-status-dot.planted { background: #3c9a6a; }
.foreshadow-status-dot.reinforced { background: #4a8fd8; }
.foreshadow-status-dot.paid { background: #57b384; }
.foreshadow-status-dot.abandoned { background: #b06a6a; }
.foreshadow-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.foreshadow-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 650;
  color: var(--text-2);
}
.foreshadow-group-count {
  min-width: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-3);
  font-size: 10px;
  text-align: center;
}
.foreshadow-group-empty {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
}
.foreshadow-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 9px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-1);
  cursor: pointer;
  transition: border-color 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out);
}
.foreshadow-card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
.foreshadow-card.on {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 22%, transparent);
}
.foreshadow-card.related {
  border-left: 2px solid #e0a43c;
}
.foreshadow-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 6px;
}
.foreshadow-card-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-0);
  line-height: 1.4;
  overflow-wrap: break-word;
}
.foreshadow-source {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--overlay-track);
  color: var(--text-3);
  font-size: 9.5px;
}
.foreshadow-card-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  font-size: 10.5px;
  color: var(--text-3);
}
.foreshadow-chapter-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 10.5px;
  cursor: pointer;
}
.foreshadow-chapter-link:hover {
  text-decoration: underline;
}
.foreshadow-arrow {
  color: var(--text-3);
}
.foreshadow-unset {
  color: var(--text-3);
}
.foreshadow-current {
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, #e0a43c 16%, transparent);
  color: #e0a43c;
  font-size: 9.5px;
}
.foreshadow-time {
  margin-left: auto;
  font-size: 9.5px;
  color: var(--text-3);
}
.foreshadow-evidence {
  margin: 0;
  padding: 5px 7px;
  border-left: 2px solid var(--border);
  background: var(--bg-2);
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: break-word;
}
.foreshadow-note {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-1);
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
</style>
