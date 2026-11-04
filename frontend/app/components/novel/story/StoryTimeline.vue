<template>
  <section class="story-timeline">
    <header class="story-timeline-head">
      <h3>{{ t('novels.timeline.title') }}</h3>
      <div class="story-timeline-actions">
        <BaseSelect v-model="scope" :options="scopeOptions" :searchable="false" />
        <button v-if="editable" type="button" class="btn btn-primary btn-sm" @click="addEvent">
          {{ t('novels.timeline.add') }}
        </button>
      </div>
    </header>

    <p v-if="!events.length" class="story-empty">{{ t('novels.timeline.empty') }}</p>

    <div v-for="group in pageGroups" :key="group.chapterNo" class="timeline-group">
      <button type="button" class="timeline-chapter" @click="$emit('select-chapter', group.chapterNo)">
        {{ t('novels.timeline.chapter', { no: group.chapterNo }) }}
      </button>
      <article
        v-for="event in group.events"
        :key="event.id"
        class="timeline-event"
        :class="{ 'is-current': event.chapterNo === chapterNo }"
      >
        <div class="timeline-event-main">
          <span class="timeline-time">{{ event.timeLabel || '—' }}</span>
          <strong>{{ event.title }}</strong>
          <span v-if="event.status" class="tag">{{ statusLabel(event.status) }}</span>
          <span v-if="event.source" class="tag">{{ sourceLabel(event.source) }}</span>
        </div>
        <p v-if="event.summary" class="timeline-summary">{{ event.summary }}</p>
        <p v-if="event.characters?.length" class="timeline-characters">
          {{ event.characters.join(' · ') }}
        </p>
        <p v-if="event.placeName || event.placeId" class="timeline-place">
          {{ event.placeName || event.placeId }}
        </p>
        <div v-if="editable" class="timeline-event-actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="editEvent(event)">{{ t('common.edit') }}</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="removeEvent(event.id)">{{ t('common.delete') }}</button>
        </div>
      </article>
    </div>

    <div v-if="pageCount > 1" class="timeline-pager">
      <button type="button" class="btn btn-sm" :disabled="page === 1" @click="page -= 1">‹</button>
      <span>{{ page }} / {{ pageCount }}</span>
      <button type="button" class="btn btn-sm" :disabled="page === pageCount" @click="page += 1">›</button>
    </div>

    <div v-if="editing" class="overlay" @click.self="closeEditor">
      <form class="dialog timeline-dialog" @submit.prevent="saveEvent">
        <header class="dialog-head">
          <h4 class="dialog-title">
            {{ editing.isNew ? t('novels.timeline.add') : t('common.edit') }}
          </h4>
        </header>
        <div class="dialog-body timeline-form">
          <label class="field">
            <span class="field-label">{{ t('novels.timeline.fields.chapterNo') }}</span>
            <input v-model.number="form.chapterNo" type="number" min="1" :max="maxChapterValue" class="input" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('novels.timeline.fields.timeLabel') }}</span>
            <input v-model="form.timeLabel" type="text" class="input" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('novels.timeline.fields.title') }}</span>
            <input v-model="form.title" type="text" class="input" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('novels.timeline.fields.summary') }}</span>
            <textarea v-model="form.summary" class="textarea" rows="3"></textarea>
          </label>
          <div class="field-row">
            <label class="field">
              <span class="field-label">{{ t('novels.timeline.fields.place') }}</span>
              <input v-model="form.placeId" type="text" class="input" placeholder="place-id" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('novels.timeline.fields.placeName') }}</span>
              <input v-model="form.placeName" type="text" class="input" />
            </label>
          </div>
          <label class="field">
            <span class="field-label">{{ t('novels.timeline.fields.characters') }}</span>
            <input v-model="form.charactersText" type="text" class="input" />
          </label>
          <div class="field-row">
            <label class="field">
              <span class="field-label">{{ t('novels.timeline.fields.importance') }}</span>
              <BaseSelect v-model="form.importance" :options="importanceOptions" :searchable="false" />
            </label>
            <label class="field">
              <span class="field-label">{{ t('novels.timeline.fields.status') }}</span>
              <BaseSelect v-model="form.status" :options="statusOptions" :searchable="false" />
            </label>
          </div>
          <p v-if="formError" class="form-error">{{ formError }}</p>
        </div>
        <footer class="dialog-foot">
          <button type="button" class="btn btn-ghost" @click="closeEditor">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn btn-primary">{{ t('common.save') }}</button>
        </footer>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseSelect from '~/components/BaseSelect.vue'

const props = defineProps<{ events: any[]; chapterNo?: number; editable?: boolean; maxChapter?: number }>()
const emit = defineEmits<{ (event: 'update:events', value: any[]): void; (event: 'select-chapter', value: number): void }>()
const { t } = useI18n()

const PAGE_SIZE = 20
const page = ref(1)
const scope = ref<'all' | 'chapter'>('all')
const editing = ref<any | null>(null)
const formError = ref('')
const form = reactive({
  chapterNo: 1,
  timeLabel: '',
  title: '',
  summary: '',
  placeId: '',
  placeName: '',
  charactersText: '',
  importance: 3,
  status: 'planned',
})

const maxChapterValue = computed(() => Math.max(1, Number(props.maxChapter) || 500))
const scopeOptions = computed(() => [
  { label: t('novels.timeline.scopeAll'), value: 'all' },
  { label: t('novels.timeline.scopeChapter'), value: 'chapter' },
])
const importanceOptions = [1, 2, 3, 4, 5].map((value) => ({ label: '★'.repeat(value), value }))
const statusOptions = computed(() => [
  { label: statusLabel('planned'), value: 'planned' },
  { label: statusLabel('confirmed'), value: 'confirmed' },
])

const filtered = computed(() => scope.value === 'chapter' && props.chapterNo
  ? props.events.filter((event) => event.chapterNo === props.chapterNo)
  : props.events)
const groupedEvents = computed(() => {
  const groups = new Map<number, any[]>()
  for (const event of filtered.value) {
    if (!groups.has(event.chapterNo)) groups.set(event.chapterNo, [])
    groups.get(event.chapterNo)!.push(event)
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([chapterNo, events]) => ({ chapterNo, events }))
})
const pageCount = computed(() => Math.max(1, Math.ceil(groupedEvents.value.length / PAGE_SIZE)))
const pageGroups = computed(() => groupedEvents.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))

watch(filtered, () => { page.value = 1 })
watch(pageCount, (count) => { if (page.value > count) page.value = count })

function statusLabel(value?: string) {
  if (!value) return '—'
  const key = `novels.timeline.status.${value}`
  const label = t(key)
  return label === key ? value : label
}

function sourceLabel(value?: string) {
  if (!value) return '—'
  const key = `novels.timeline.source.${value}`
  const label = t(key)
  return label === key ? value : label
}

function openEditor(event: any, isNew = false) {
  editing.value = { ...event, isNew }
  form.chapterNo = Number(event.chapterNo) || 1
  form.timeLabel = event.timeLabel || ''
  form.title = event.title || ''
  form.summary = event.summary || ''
  form.placeId = event.placeId || ''
  form.placeName = event.placeName || ''
  form.charactersText = Array.isArray(event.characters) ? event.characters.join('，') : ''
  form.importance = Number(event.importance) || 3
  form.status = event.status === 'confirmed' ? 'confirmed' : 'planned'
  formError.value = ''
}

function closeEditor() {
  editing.value = null
  formError.value = ''
}

function addEvent() {
  openEditor({
    id: `manual-${Date.now()}`,
    chapterNo: props.chapterNo || 1,
    timeLabel: '',
    title: '',
    summary: '',
    placeId: '',
    placeName: '',
    characters: [],
    importance: 3,
    status: 'planned',
    source: 'manual',
  }, true)
}

function editEvent(event: any) {
  openEditor(event)
}

function saveEvent() {
  if (!editing.value) return
  const title = form.title.trim()
  if (!title) {
    formError.value = String(t('novels.timeline.titleRequired'))
    return
  }
  const chapterNo = Math.min(maxChapterValue.value, Math.max(1, Math.round(Number(form.chapterNo) || 1)))
  const characters = form.charactersText
    .split(/[,，、]/)
    .map((name) => name.trim())
    .filter(Boolean)
  const nextEvent: Record<string, any> = {
    ...editing.value,
    chapterNo,
    timeLabel: form.timeLabel.trim(),
    title,
    summary: form.summary.trim(),
    importance: Math.min(5, Math.max(1, Math.round(Number(form.importance) || 3))),
    status: form.status,
  }
  if (form.placeId.trim()) nextEvent.placeId = form.placeId.trim()
  else delete nextEvent.placeId
  if (form.placeName.trim()) nextEvent.placeName = form.placeName.trim()
  else delete nextEvent.placeName
  if (characters.length) nextEvent.characters = characters
  else delete nextEvent.characters
  delete nextEvent.isNew

  const exists = props.events.some((event) => event.id === nextEvent.id)
  const next = exists
    ? props.events.map((event) => event.id === nextEvent.id ? nextEvent : event)
    : [...props.events, nextEvent]
  next.sort((a, b) => a.chapterNo - b.chapterNo)
  emit('update:events', next)
  closeEditor()
}

function removeEvent(id: string) {
  if (!window.confirm(String(t('novels.timeline.deleteConfirm')))) return
  emit('update:events', props.events.filter((event) => event.id !== id))
}
</script>

<style scoped>
.story-timeline {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.story-timeline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.story-timeline-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}
.story-timeline-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.story-empty {
  margin: 0;
  padding: 18px 0;
  color: var(--text-3);
  font-size: 12.5px;
  text-align: center;
}
.timeline-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.timeline-chapter {
  align-self: flex-start;
  border: none;
  background: transparent;
  padding: 0;
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.timeline-chapter:hover {
  text-decoration: underline;
}
.timeline-event {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-1);
}
.timeline-event.is-current {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: var(--accent-bg);
}
.timeline-event-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.timeline-time {
  min-width: 48px;
  color: var(--text-2);
  font-size: 12px;
}
.timeline-summary,
.timeline-characters,
.timeline-place {
  margin: 6px 0 0;
  color: var(--text-2);
  font-size: 12.5px;
  line-height: 1.65;
}
.timeline-event-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}
.timeline-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  font-size: 12px;
  color: var(--text-2);
}
.timeline-dialog {
  width: min(560px, calc(100vw - 32px));
}
.timeline-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
