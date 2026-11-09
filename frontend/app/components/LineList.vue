<template>
  <div ref="viewport" class="line-list" :style="{ '--line-row-h': `${rowHeight}px` }" @scroll="onScroll">
    <div v-if="speakerFilter && speakers.length > 1" class="line-speakers">
      <button
        type="button"
        :class="['line-speaker-chip', { on: !activeSpeaker }]"
        @click="activeSpeaker = ''"
      >{{ t('workbench.filterAll') }} <em>{{ lines.length }}</em></button>
      <button
        v-for="speaker in speakers"
        :key="speaker.name"
        type="button"
        :class="['line-speaker-chip', { on: activeSpeaker === speaker.name }]"
        @click="activeSpeaker = speaker.name"
      >{{ speaker.name }} <em>{{ speaker.count }}</em></button>
    </div>
    <div v-if="filteredLines.length" class="line-spacer" :style="{ height: `${totalHeight}px` }">
      <article
        v-for="row in visibleRows"
        :key="row.line.id"
        :class="['line-row', `is-${row.line.status}`, row.line.stale && 'is-stale', activeLineId === row.line.id && 'is-active']"
        :style="{ transform: `translateY(${row.index * rowHeight}px)` }"
      >
        <div class="line-head">
          <input
            v-if="selectable"
            type="checkbox"
            class="line-select"
            :checked="isSelected(row.line.id)"
            @change="toggleSelect(row.line.id)"
            @click.stop
          />
          <span class="line-no">#{{ row.line.lineNo }}</span>
          <span v-if="row.line.storyboardNumber" class="line-shot">{{ t('workbench.shot', { n: row.line.storyboardNumber }) }}</span>
          <span class="line-speaker">{{ row.line.speakerName || t('workbench.narrator') }}</span>
          <span v-if="row.line.speakerType !== 'dialogue'" class="line-kind">
            {{ row.line.speakerType === 'inner' ? t('workbench.inner') : t('workbench.narration') }}
          </span>
          <span class="line-dur">{{ row.line.audioDurationMs ? `${(row.line.audioDurationMs / 1000).toFixed(1)}s` : '—' }}</span>
          <span v-if="row.line.overflowMs && row.line.overflowMs > 0" class="line-warn">+{{ (row.line.overflowMs / 1000).toFixed(1) }}s</span>
          <span v-if="row.line.stale" class="line-chip is-stale">{{ t('workbench.stale') }}</span>
          <span v-if="row.line.audioStale" class="line-chip is-stale">{{ t('workbench.audioStale') }}</span>
          <span v-if="row.line.locked" class="line-chip is-locked">{{ t('workbench.locked') }}</span>
          <span v-if="row.line.needsReview" class="line-chip is-review">{{ t('workbench.review') }}</span>
          <span v-if="row.line.status === 'failed'" class="line-chip is-failed">{{ t('workbench.failed') }}</span>
          <span v-if="generatingIds.includes(row.line.id)" class="line-chip is-generating">{{ t('take.statusGenerating') }}</span>
          <span v-if="mode === 'generate' && takeCounts[row.line.id]" class="line-chip is-take">{{ t('take.countChip', { n: takeCounts[row.line.id] }) }}</span>
          <span v-if="crossCharacter(row.line)" class="line-chip is-warn">{{ t('workbench.voiceCross') }}</span>
          <span v-if="missingVoice(row.line)" class="line-chip is-warn">{{ t('workbench.issueNoVoice') }}</span>
          <span v-if="longText(row.line)" class="line-chip is-warn">{{ t('workbench.issueLong') }}</span>
          <span v-if="emptyLine(row.line)" class="line-chip is-danger">{{ t('workbench.issueEmpty') }}</span>
        </div>

        <textarea
          v-if="editingId === row.line.id"
          v-model="editingText"
          class="line-edit"
          rows="2"
          :disabled="saving"
          @blur="commit(row.line)"
          @keydown.enter.exact.prevent="commit(row.line)"
          @keydown.esc="editingId = null"
        />
        <p
          v-else
          class="line-text"
          :class="{ 'is-readonly': !editable(row.line) }"
          :title="row.line.text"
          @dblclick="editable(row.line) && beginEdit(row.line)"
        >{{ row.line.text }}</p>

        <div class="line-actions">
          <template v-if="mode === 'script'">
            <span
              class="line-voice-chip"
              :class="{ 'is-cross': crossCharacter(row.line), 'is-missing': !voiceChipLabel(row.line) }"
              :title="t('workbench.voiceAssignHint')"
            >
              {{ voiceChipLabel(row.line) || t('workbench.voiceNone') }}
            </span>
            <button v-if="row.line.audioUrl" class="line-mini" type="button" @click="emit('play', row.line)">{{ t('workbench.play') }}</button>
            <button class="line-mini" type="button" @click="emit('locate', row.line)">{{ t('workbench.locate') }}</button>
            <button class="line-mini" type="button" :disabled="!editable(row.line)" @click="beginEdit(row.line)">{{ t('common.edit') }}</button>
            <button class="line-mini" type="button" :disabled="!canMove(row.line, -1)" @click="emit('move', row.line, -1)">{{ t('workbench.moveUp') }}</button>
            <button class="line-mini" type="button" :disabled="!canMove(row.line, 1)" @click="emit('move', row.line, 1)">{{ t('workbench.moveDown') }}</button>
            <button class="line-mini" type="button" @click="emit('toggleLock', row.line)">
              {{ row.line.locked ? t('workbench.unlock') : t('workbench.lock') }}
            </button>
            <button
              class="line-mini is-danger"
              type="button"
              :disabled="row.line.locked"
              :title="row.line.locked ? t('workbench.lockedHint') : t('workbench.delete')"
              @click="emit('remove', row.line)"
            >
              {{ t('workbench.delete') }}
            </button>
          </template>
          <template v-else>
            <select
              v-if="mode === 'voice'"
              class="line-voice-select"
              :class="{ 'is-cross': crossCharacter(row.line) }"
              :value="row.line.voiceId ?? ''"
              :title="t('workbench.voiceAssignHint')"
              @change="onVoiceChange(row.line, $event)"
            >
              <option value="">{{ t('workbench.voiceAuto') }}</option>
              <optgroup v-if="ownVoices(row.line).length" :label="t('workbench.voiceOwnGroup')">
                <option v-for="voice in ownVoices(row.line)" :key="voice.id" :value="voice.id">{{ voiceLabel(voice) }}</option>
              </optgroup>
              <optgroup v-if="narratorVoice" :label="t('workbench.narrator')">
                <option :value="narratorVoice.id">{{ voiceLabel(narratorVoice) }}</option>
              </optgroup>
              <optgroup v-if="otherVoiceOptions(row.line).length" :label="t('workbench.voiceOtherGroup')">
                <option v-for="item in otherVoiceOptions(row.line)" :key="item.voice.id" :value="item.voice.id">
                  {{ item.characterName }} · {{ voiceLabel(item.voice) }}
                </option>
              </optgroup>
            </select>
            <span v-else-if="mode !== 'generate'" class="line-voice-chip" :class="{ 'is-cross': crossCharacter(row.line), 'is-missing': !voiceChipLabel(row.line) }">
              {{ voiceChipLabel(row.line) || t('workbench.voiceNone') }}
            </span>
            <button v-if="row.line.audioUrl" class="line-mini" type="button" @click="emit('play', row.line)">{{ t('workbench.play') }}</button>
            <button v-if="mode === 'generate'" class="line-mini" type="button" @click="emit('inspect', row.line)">{{ t('take.inspect') }}</button>
            <button v-if="mode === 'generate'" class="line-mini" type="button" :disabled="busy || generatingIds.includes(row.line.id)" @click="emit('synthesize', row.line)">{{ t('workbench.resynthesize') }}</button>
            <button class="line-mini" type="button" @click="emit('locate', row.line)">{{ t('workbench.locate') }}</button>
            <button v-if="mode === 'voice'" class="line-mini" type="button" :disabled="!editable(row.line)" @click="beginEdit(row.line)">{{ t('common.edit') }}</button>
          </template>
          <span v-if="row.line.error" class="line-error" :title="row.line.error">{{ row.line.error }}</span>
        </div>
      </article>
    </div>
    <p v-else class="line-empty">{{ emptyText }}</p>
  </div>
</template>
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useViewport } from '~/composables/useViewport'
import type { StoryboardLine, VoiceProfile, VoiceProfileList } from '~/composables/useApi'

const props = withDefaults(defineProps<{
  lines: StoryboardLine[]
  busy?: boolean
  saving?: boolean
  emptyText?: string
  showIssues?: boolean
  missingVoiceCharacterIds?: number[]
  narratorMissingVoice?: boolean
  voiceGroups?: VoiceProfileList[]
  narratorVoice?: VoiceProfile | null
  selectable?: boolean
  mode?: 'script' | 'voice' | 'generate'
  speakerFilter?: boolean
  activeLineId?: number | null
  takeCounts?: Record<number, number>
  generatingIds?: number[]
}>(), {
  busy: false,
  saving: false,
  emptyText: '',
  showIssues: false,
  missingVoiceCharacterIds: () => [],
  narratorMissingVoice: false,
  voiceGroups: () => [],
  narratorVoice: null,
  selectable: false,
  mode: 'voice',
  speakerFilter: false,
  activeLineId: null,
  takeCounts: () => ({}),
  generatingIds: () => [],
})

const emit = defineEmits<{
  play: [line: StoryboardLine]
  synthesize: [line: StoryboardLine]
  inspect: [line: StoryboardLine]
  locate: [line: StoryboardLine]
  save: [line: StoryboardLine, text: string]
  assignVoice: [line: StoryboardLine, voiceId: number | null]
  selectionChange: [ids: number[]]
  move: [line: StoryboardLine, direction: -1 | 1]
  remove: [line: StoryboardLine]
  toggleLock: [line: StoryboardLine]
}>()

const { t } = useI18n()
const { isCoarsePointer } = useViewport()
const ROW_HEIGHT = 104
/** 粗指针下全局按钮 44px，104px 虚拟行放不下，触摸行高切到 132px */
const TOUCH_ROW_HEIGHT = 132
const OVERSCAN = 6

const rowHeight = computed(() => (isCoarsePointer.value ? TOUCH_ROW_HEIGHT : ROW_HEIGHT))

const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(360)
const editingId = ref<number | null>(null)
const editingText = ref('')
const selectedIds = ref<number[]>([])
let observer: ResizeObserver | null = null

const startIndex = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / rowHeight.value) - OVERSCAN))
const totalHeight = computed(() => filteredLines.value.length * rowHeight.value)
const speakerLabel = (line: StoryboardLine) => line.speakerName || t('workbench.narrator')
const speakers = computed(() => {
  const counts = new Map<string, number>()
  for (const line of props.lines) {
    const name = speakerLabel(line)
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }))
})
const activeSpeaker = ref('')
const filteredLines = computed(() =>
  activeSpeaker.value
    ? props.lines.filter(line => speakerLabel(line) === activeSpeaker.value)
    : props.lines)
watch(speakers, (list) => {
  if (activeSpeaker.value && !list.some(item => item.name === activeSpeaker.value)) {
    activeSpeaker.value = ''
  }
})
watch(activeSpeaker, () => {
  scrollTop.value = 0
  if (viewport.value) viewport.value.scrollTop = 0
})
const visibleRows = computed(() => {
  const count = Math.ceil(viewportHeight.value / rowHeight.value) + OVERSCAN * 2
  return filteredLines.value
    .slice(startIndex.value, startIndex.value + count)
    .map((line, i) => ({ line, index: startIndex.value + i }))
})

watch(() => props.lines, (rows) => {
  const ids = new Set(rows.map(row => row.id))
  if (selectedIds.value.some(id => !ids.has(id))) {
    selectedIds.value = selectedIds.value.filter(id => ids.has(id))
    emit('selectionChange', selectedIds.value)
  }
})

function isSelected(id: number) {
  return selectedIds.value.includes(id)
}
function toggleSelect(id: number) {
  selectedIds.value = isSelected(id)
    ? selectedIds.value.filter(item => item !== id)
    : [...selectedIds.value, id]
  emit('selectionChange', selectedIds.value)
}
function clearSelection() {
  selectedIds.value = []
  emit('selectionChange', [])
}
defineExpose({ clearSelection })

function voiceById(id: number | null | undefined): VoiceProfile | null {
  if (!id) return null
  for (const group of props.voiceGroups) {
    const voice = group.voices.find(item => item.id === id)
    if (voice) return voice
  }
  return props.narratorVoice?.id === id ? props.narratorVoice : null
}

function editable(line: StoryboardLine) {
  return props.mode !== 'generate' && !line.locked
}

function canMove(line: StoryboardLine, direction: -1 | 1) {
  // 角色筛选下相邻行可能被隐藏，移动会跨角色换序，直接禁用
  if (activeSpeaker.value) return false
  if (line.locked) return false
  const index = filteredLines.value.findIndex(item => item.id === line.id)
  const target = index >= 0 ? filteredLines.value[index + direction] : null
  return Boolean(target && target.storyboardId === line.storyboardId)
}

/** 无法读取当前音色时返回空串，由模板降级为「未生成」。 */
function voiceChipLabel(line: StoryboardLine) {
  const assigned = voiceById(line.voiceId)
  if (assigned) return assigned.name
  if (line.speakerType !== 'dialogue') return props.narratorVoice?.name || ''
  const group = props.voiceGroups.find(item => item.character_id === line.characterId)
  return group?.voices.find(voice => voice.id === group.active_voice_id)?.name || ''
}

function ownVoices(line: StoryboardLine): VoiceProfile[] {
  if (line.speakerType !== 'dialogue' || !line.characterId) return []
  const group = props.voiceGroups.find(item => item.character_id === line.characterId)
  return group ? [...group.voices].sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.id - a.id) : []
}

function otherVoiceOptions(line: StoryboardLine): { characterName: string; voice: VoiceProfile }[] {
  const options: { characterName: string; voice: VoiceProfile }[] = []
  for (const group of props.voiceGroups) {
    if (group.character_id === line.characterId) continue
    for (const voice of group.voices) options.push({ characterName: group.character_name, voice })
  }
  return options
}

function voiceLabel(voice: VoiceProfile) {
  const parts = [voice.name]
  if (voice.isActive) parts.push(t('workbench.voiceActiveShort'))
  if (voice.status !== 'ready') parts.push(voice.status)
  return parts.join(' · ')
}

function crossCharacter(line: StoryboardLine) {
  if (!line.voiceId) return false
  const voice = voiceById(line.voiceId)
  if (!voice) return false
  if (voice.characterId) return voice.characterId !== (line.characterId || null)
  return line.speakerType === 'dialogue'
}

function onVoiceChange(line: StoryboardLine, event: Event) {
  const raw = (event.target as HTMLSelectElement).value
  emit('assignVoice', line, raw ? Number(raw) : null)
}

function onScroll(event: Event) {
  scrollTop.value = (event.target as HTMLElement).scrollTop
}

function beginEdit(line: StoryboardLine) {
  editingId.value = line.id
  editingText.value = line.text
}

function commit(line: StoryboardLine) {
  if (editingId.value !== line.id) return
  const text = editingText.value.trim()
  editingId.value = null
  if (!text || text === line.text) return
  emit('save', line, text)
}

function missingVoice(line: StoryboardLine) {
  if (!props.showIssues) return false
  if (line.speakerType !== 'dialogue') return props.narratorMissingVoice
  return Boolean(line.characterId && props.missingVoiceCharacterIds.includes(line.characterId))
}
function longText(line: StoryboardLine) {
  return props.showIssues && [...line.text].length > 80
}
function emptyLine(line: StoryboardLine) {
  return props.showIssues && !line.text.trim()
}

onMounted(() => {
  if (!viewport.value) return
  viewportHeight.value = viewport.value.clientHeight || 360
  observer = new ResizeObserver((entries) => {
    const height = entries[0]?.contentRect?.height
    if (height) viewportHeight.value = height
  })
  observer.observe(viewport.value)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})
</script>

<style scoped>
.line-list {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
}
.line-spacer { position: relative; width: 100%; }
.line-row {
  position: absolute;
  inset: 0 0 auto 0;
  height: calc(var(--line-row-h, 104px) - 6px);
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-1, #fff);
  box-sizing: border-box;
}
.line-row.is-failed { border-color: rgba(217, 83, 79, .4); }
.line-row.is-stale { background: rgba(196, 138, 27, .06); }
.line-row.is-active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-glow); }
.line-head { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--text-3); flex-wrap: nowrap; overflow: hidden; }
.line-select { margin: 0; flex: 0 0 auto; }
.line-no { font-variant-numeric: tabular-nums; }
.line-shot { color: var(--text-3); }
.line-speaker { color: var(--text-2); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.line-kind { font-size: 10px; padding: 0 5px; border-radius: 4px; background: rgba(127, 127, 127, .12); white-space: nowrap; }
.line-dur { margin-left: auto; font-variant-numeric: tabular-nums; }
.line-warn { color: #c48a1b; }
.line-chip { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: rgba(127, 127, 127, .14); color: var(--text-2); white-space: nowrap; }
.line-chip.is-stale, .line-chip.is-review { color: #c48a1b; background: rgba(196, 138, 27, .16); }
.line-chip.is-failed { color: #d9534f; background: rgba(217, 83, 79, .14); }
.line-chip.is-warn { color: #c48a1b; background: rgba(196, 138, 27, .16); }
.line-chip.is-danger { color: #d9534f; background: rgba(217, 83, 79, .14); }
.line-chip.is-locked { color: var(--text-2); background: rgba(127, 127, 127, .2); }
.line-chip.is-generating { color: var(--accent); background: var(--accent-bg); }
.line-chip.is-take { color: var(--text-2); background: rgba(127, 127, 127, .14); }
.line-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-1);
  cursor: text;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.line-text.is-readonly { cursor: default; }
.line-edit {
  width: 100%;
  height: 44px;
  resize: none;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.5;
  padding: 4px 7px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-2, transparent);
  color: var(--text-1);
  box-sizing: border-box;
}
.line-actions { display: flex; align-items: center; gap: 8px; min-height: 14px; overflow: hidden; }
.line-voice-chip {
  max-width: 150px;
  padding: 1px 7px;
  border-radius: 999px;
  background: rgba(127, 127, 127, .12);
  color: var(--text-2);
  font-size: 10.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.line-voice-chip.is-cross { color: #c48a1b; background: rgba(196, 138, 27, .16); }
.line-voice-chip.is-missing { color: #c48a1b; background: rgba(196, 138, 27, .12); }
.line-voice-select {
  max-width: 190px;
  font: inherit;
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-2, transparent);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 1px 4px;
}
.line-voice-select.is-cross { border-color: rgba(196, 138, 27, .5); color: #c48a1b; }
.line-mini { background: none; border: none; padding: 0; font: inherit; font-size: 11px; color: var(--text-3); cursor: pointer; }
.line-mini:hover { color: var(--accent, #2b7bd6); }
.line-mini:disabled { opacity: .45; cursor: default; }
.line-mini.is-danger { color: var(--action-danger, #d9534f); }
.line-mini.is-danger:hover { color: var(--action-danger, #d9534f); opacity: .8; }
.line-error { margin-left: auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d9534f; font-size: 11px; }
.line-empty { color: var(--text-3); font-size: 12px; text-align: center; padding: 24px 0; }
.line-speakers { display: flex; flex-wrap: wrap; gap: 5px; padding-bottom: 6px; }
.line-speaker-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 9px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--bg-1, #fff); color: var(--text-2);
  font: inherit; font-size: 11px; cursor: pointer;
}
.line-speaker-chip em { font-style: normal; font-size: 10px; color: var(--text-3); }
.line-speaker-chip:hover { color: var(--text-1); border-color: var(--accent); }
.line-speaker-chip.on { border-color: var(--accent); background: var(--accent-bg); color: var(--accent-text); }
.line-speaker-chip.on em { color: var(--accent-text); }
</style>
