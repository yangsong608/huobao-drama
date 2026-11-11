<template>
  <div class="take-inspector">
    <p v-if="!line" class="take-empty">{{ t('take.empty') }}</p>
    <template v-else>
      <section class="take-card">
        <header class="take-head">
          <div class="take-head-title">
            <span class="take-line-no">#{{ line.lineNo }}</span>
            <strong>{{ line.speakerName || t('workbench.narrator') }}</strong>
            <span v-if="line.speakerType !== 'dialogue'" class="take-kind">
              {{ line.speakerType === 'inner' ? t('workbench.inner') : t('workbench.narration') }}
            </span>
          </div>
          <span class="take-text">{{ line.text }}</span>
        </header>

        <div class="take-mode-row">
          <span class="take-label">{{ t('take.mode') }}</span>
          <div class="take-segmented">
            <button
              v-for="item in modeOptions"
              :key="item.key"
              type="button"
              :class="['take-segment', { on: mode === item.key }]"
              @click="setMode(item.key)"
            >{{ item.label }}</button>
          </div>
        </div>

        <p v-if="mode === 'off'" class="take-hint">{{ t('take.contextOff') }}</p>
        <div v-else class="take-context">
          <div v-if="sceneLabel" class="take-context-row">
            <span class="take-context-label">{{ t('take.scene') }}</span>
            <span>{{ sceneLabel }}</span>
          </div>
          <div v-if="previousLines.length" class="take-context-block">
            <span class="take-context-label">{{ t('take.previous') }}</span>
            <p v-for="(item, index) in previousLines" :key="`prev-${index}`">
              <strong>{{ item.speaker }}</strong>
              <span>{{ item.text }}</span>
            </p>
          </div>
          <div v-if="currentLine" class="take-context-block is-current">
            <span class="take-context-label">{{ t('take.current') }}</span>
            <p>
              <strong>{{ currentLine.speaker }}</strong>
              <span>{{ currentLine.text }}</span>
            </p>
            <p v-if="currentLine.direction" class="take-context-direction">{{ currentLine.direction }}</p>
          </div>
          <div v-if="nextLines.length" class="take-context-block">
            <span class="take-context-label">{{ t('take.next') }}</span>
            <p v-for="(item, index) in nextLines" :key="`next-${index}`">
              <strong>{{ item.speaker }}</strong>
              <span>{{ item.text }}</span>
            </p>
          </div>
          <div v-if="arc" class="take-context-row">
            <span class="take-context-label">{{ t('take.arc') }}</span>
            <span>{{ arc }}</span>
          </div>
        </div>

        <p v-if="mode === 'deep' && deepFallback" class="take-warn">
          {{ t('take.deepFallback', { reason: preview?.error || '' }) }}
        </p>
        <p v-if="preview?.ignored.length" class="take-warn">
          {{ t('take.ignored', { fields: preview.ignored.join(', ') }) }}
        </p>
      </section>

      <section class="take-card">
        <header class="take-card-head">
          <h4>{{ t('take.voiceTitle') }}</h4>
          <span v-if="voiceInactive" class="take-badge is-generating">{{ t('take.voiceInactiveBadge') }}</span>
        </header>
        <BaseSelect v-model="selectedVoiceId" :options="voiceOptions" />
        <p class="take-hint">{{ voiceHint }}</p>
        <p v-if="characterVoiceMissing" class="take-warn">{{ t('take.characterVoiceMissing') }}</p>
        <p v-if="instructUnsupported" class="take-warn">{{ t('take.instructUnsupported') }}</p>
        <div v-if="needsSpeakerBinding" class="take-bind">
          <p class="take-hint">{{ t('take.speakerUnassigned') }}</p>
          <div v-if="bindingInline" class="take-bind-row">
            <BaseSelect
              v-model="inlineCharacterId"
              :options="castOptions"
              :placeholder="t('workbench.speakerPickCharacter')"
              class="take-bind-select"
            />
            <button class="btn btn-sm is-primary" type="button" :disabled="!inlineCharacterId" @click="confirmBindInline">
              {{ t('common.confirm') }}
            </button>
            <button class="btn btn-sm" type="button" @click="bindingInline = false">{{ t('common.cancel') }}</button>
          </div>
          <template v-else>
            <div class="take-bind-row">
              <button class="btn btn-sm is-primary" type="button" :disabled="!line.speakerName" @click="emit('bind-speaker')">
                <UserPlus :size="11" />
                {{ t('workbench.setAsCharacter') }}
              </button>
              <button class="btn btn-sm" type="button" :disabled="!line.speakerName || !castOptions.length" @click="bindingInline = true">
                {{ t('workbench.bindExisting') }}
              </button>
            </div>
            <p v-if="!line.speakerName" class="take-hint">{{ t('take.speakerNameMissing') }}</p>
          </template>
        </div>
      </section>

      <section class="take-card">
        <header class="take-card-head">
          <h4>{{ t('take.paramsTitle') }}</h4>
          <span v-if="sourceLabel" class="take-source">{{ sourceLabel }}</span>
        </header>
        <div :class="['take-fields', { 'is-locked': paramsLocked }]">
          <label class="take-field">
            <span>{{ t('take.emotion') }}</span>
            <input v-model="form.emotion" type="text" :disabled="paramsLocked" :placeholder="t('take.emotionPlaceholder')" />
          </label>
          <label class="take-field">
            <span>{{ t('take.speed') }} <span class="mono">{{ Number(form.speed).toFixed(2) }}</span></span>
            <input v-model.number="form.speed" type="range" min="0.5" max="1.5" step="0.05" :disabled="paramsLocked" />
          </label>
          <label class="take-field is-wide">
            <span>{{ t('take.instruct') }}</span>
            <textarea v-model="form.instruct" rows="2" :disabled="paramsLocked" :placeholder="t('take.instructPlaceholder')" />
          </label>
          <label class="take-field">
            <span>{{ t('take.seed') }}</span>
            <input v-model="form.seed" type="number" min="0" step="1" :disabled="paramsLocked" :placeholder="t('take.seedAuto')" />
          </label>
          <label class="take-field">
            <span>{{ t('take.notes') }}</span>
            <input v-model="form.notes" type="text" :disabled="paramsLocked" :placeholder="t('take.notesPlaceholder')" />
          </label>
        </div>
        <p class="take-hint">{{ t('take.overridesHint') }}</p>

        <div v-if="mode === 'deep' && !deepReady" class="take-analyze">
          <button class="btn btn-sm" type="button" :disabled="analyzing" @click="emit('analyze')">
            <Loader2 v-if="analyzing" :size="11" class="animate-spin" />
            <Sparkles v-else :size="11" />
            {{ analyzing ? t('take.analyzing') : t('take.analyze') }}
          </button>
          <span class="take-hint">{{ t('take.deepAnalyzeFirst') }}</span>
        </div>

        <div class="take-generate">
          <button class="btn btn-primary btn-sm" type="button" :disabled="!canGenerate" :title="voiceBlocked ? t('media.capability.actionDisabled') : undefined" @click="generate">
            <Loader2 v-if="generating" :size="11" class="animate-spin" />
            <AudioLines v-else :size="11" />
            {{ generating ? t('take.generating') : takes.length ? t('take.generateAnother') : t('take.generate') }}
          </button>
          <MediaCapabilityNotice v-if="voiceBlocked" action="voice" mode="inline" />
          <span v-if="generating" class="take-hint">{{ t('take.generateHint') }}</span>
        </div>
      </section>

      <section class="take-card">
        <header class="take-card-head">
          <h4>{{ t('take.historyTitle') }}</h4>
          <span class="take-count">{{ takes.length }}</span>
        </header>
        <p v-if="!takes.length" class="take-hint">{{ t('take.historyEmpty') }}</p>
        <ol v-else class="take-list">
          <li
            v-for="item in takes"
            :key="item.id"
            :class="['take-item', { 'is-active': item.isActive, 'is-playing': playingTakeId === item.id }]"
          >
            <div class="take-item-head">
              <span class="take-item-no">{{ t('take.takeNo', { n: item.takeNo }) }}</span>
              <span v-if="item.isActive" class="take-badge is-active">{{ t('take.active') }}</span>
              <span :class="['take-badge', `is-${item.status}`]">{{ statusLabel(item.status) }}</span>
              <span class="take-item-time">{{ formatTime(item.createdAt) }}</span>
            </div>
            <div class="take-item-meta">
              <span>{{ formatDuration(item.durationMs) }}</span>
              <span>{{ channelLabel(item) }}</span>
              <span>{{ modeLabel(item.contextMode) }}</span>
              <span v-if="item.seed !== null">{{ t('take.seedValue', { seed: item.seed }) }}</span>
            </div>
            <div class="take-item-actions">
              <button class="take-link" type="button" :disabled="!item.audioUrl" @click="playTake(item)">
                {{ playingTakeId === item.id ? t('take.stop') : t('take.play') }}
              </button>
              <button
                v-if="!item.isActive"
                class="take-link"
                type="button"
                :disabled="activatingTakeId === item.id"
                @click="emit('activate', item.id)"
              >{{ activatingTakeId === item.id ? t('take.activating') : t('take.activate') }}</button>
              <button
                class="take-link is-danger"
                type="button"
                :disabled="removingTakeId === item.id"
                @click="removeTake(item)"
              >{{ removingTakeId === item.id ? t('take.deleting') : t('take.delete') }}</button>
            </div>
            <p v-if="item.error" class="take-item-error">{{ item.error }}</p>
          </li>
        </ol>

        <div v-if="takesWithAudio.length > 1" class="take-compare">
          <div class="take-compare-head">
            <span class="take-label">{{ t('take.compare') }}</span>
            <span class="take-hint">{{ t('take.compareHint') }}</span>
          </div>
          <div class="take-compare-row">
            <label class="take-compare-field">
              <span>A</span>
              <select v-model.number="compareAId">
                <option v-for="item in takesWithAudio" :key="`a-${item.id}`" :value="item.id">
                  {{ t('take.takeNo', { n: item.takeNo }) }}
                </option>
              </select>
            </label>
            <label class="take-compare-field">
              <span>B</span>
              <select v-model.number="compareBId">
                <option v-for="item in takesWithAudio" :key="`b-${item.id}`" :value="item.id">
                  {{ t('take.takeNo', { n: item.takeNo }) }}
                </option>
              </select>
            </label>
            <button class="btn btn-sm" type="button" :disabled="!canCompare" @click="compare">
              <GitCompare :size="11" />
              {{ t('take.comparePlay') }}
            </button>
          </div>
        </div>
      </section>
      <audio ref="audio" preload="none" @ended="onEnded" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { AudioLines, GitCompare, Loader2, Sparkles, UserPlus } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { LineContextPreview, LineTake, StoryboardLine, TakeOverrides, TtsCapabilities, VoiceProfile, VoiceProfileList } from '~/composables/useApi'
import BaseSelect from '~/components/BaseSelect.vue'
import MediaCapabilityNotice from '~/components/MediaCapabilityNotice.vue'
import { useMediaCapabilities } from '~/composables/useMediaCapabilities'

interface VoiceMetaEntry {
  name: string
  isActive: boolean
  hasInstruct: boolean
}

const props = withDefaults(defineProps<{
  line: StoryboardLine | null
  takes: LineTake[]
  preview: LineContextPreview | null
  generating?: boolean
  analyzing?: boolean
  activatingTakeId?: number | null
  removingTakeId?: number | null
  voiceOptions?: { label: string; value: string }[]
  voiceGroups?: VoiceProfileList[]
  voiceMeta?: Record<number, VoiceMetaEntry>
  narratorVoice?: VoiceProfile | null
  capabilities?: TtsCapabilities | null
  castOptions?: { label: string; value: string }[]
}>(), {
  generating: false,
  analyzing: false,
  activatingTakeId: null,
  removingTakeId: null,
  voiceOptions: () => [],
  voiceGroups: () => [],
  voiceMeta: () => ({}),
  narratorVoice: null,
  capabilities: null,
  castOptions: () => [],
})

const emit = defineEmits<{
  preview: [mode: 'off' | 'light' | 'deep']
  analyze: []
  generate: [payload: { mode: 'off' | 'light' | 'deep'; overrides: TakeOverrides }]
  activate: [takeId: number]
  remove: [takeId: number]
  'assign-voice': [voiceId: number | null]
  'bind-speaker': []
  'bind-character': [characterId: number]
}>()

const { t } = useI18n()
const mode = ref<'off' | 'light' | 'deep'>('light')
const analyzedLineId = ref<number | null>(null)
const form = reactive({
  emotion: '',
  speed: 1,
  instruct: '',
  seed: '',
  notes: '',
})
const audio = ref<HTMLAudioElement | null>(null)
const playingTakeId = ref<number | null>(null)
const compareAId = ref<number | null>(null)
const compareBId = ref<number | null>(null)
let compareNextId: number | null = null

const modeOptions = computed(() => [
  { key: 'off' as const, label: t('take.modeOff') },
  { key: 'light' as const, label: t('take.modeLight') },
  { key: 'deep' as const, label: t('take.modeDeep') },
])

const previousLines = computed(() => (props.preview?.context.previous || []).slice(-2))
const nextLines = computed(() => (props.preview?.context.next || []).slice(0, 2))
const currentLine = computed(() => props.preview?.context.current || null)
const arc = computed(() => props.preview?.context.arc || '')
const sceneLabel = computed(() => {
  const scene = props.preview?.context.scene
  if (!scene) return ''
  const parts = [
    scene.shotNumber ? t('take.shot', { n: scene.shotNumber }) : '',
    scene.shotSummary || '',
    scene.durationMs ? formatSeconds(scene.durationMs) : '',
  ]
  return parts.filter(Boolean).join(' · ')
})
const sourceLabel = computed(() => {
  const source = props.preview?.source
  if (source === 'deep') return t('take.sourceDeep')
  if (source === 'light') return t('take.sourceLight')
  if (source === 'fallback') return t('take.sourceFallback')
  return ''
})
const deepReady = computed(() => Boolean(
  props.line
  && props.preview?.context.lineId === props.line.id
  && props.preview?.context.mode === 'deep'
  && analyzedLineId.value === props.line.id,
))
const deepFallback = computed(() => mode.value === 'deep' && props.preview?.source === 'fallback')
const paramsLocked = computed(() => mode.value === 'deep' && !deepReady.value)
const mediaCaps = useMediaCapabilities()
const voiceBlocked = computed(() => !mediaCaps.voiceReady.value)
const canGenerate = computed(() => Boolean(props.line) && !props.generating && !paramsLocked.value && !voiceBlocked.value)
const takesWithAudio = computed(() => props.takes.filter(item => item.audioUrl))
const canCompare = computed(() =>
  Boolean(compareAId.value && compareBId.value && compareAId.value !== compareBId.value))

const selectedVoiceId = computed({
  get: () => (props.line?.voiceId ? String(props.line.voiceId) : ''),
  set: (value: string) => emit('assign-voice', value ? Number(value) : null),
})
const resolvedVoiceId = computed(() => {
  if (!props.line) return null
  if (props.line.voiceId) return props.line.voiceId
  const group = props.voiceGroups.find(item => item.character_id === props.line?.characterId)
  if (group?.active_voice_id) return group.active_voice_id
  if (props.narratorVoice?.id) return props.narratorVoice.id
  return null
})
const resolvedMeta = computed(() =>
  resolvedVoiceId.value ? props.voiceMeta[resolvedVoiceId.value] ?? null : null)
const voiceInactive = computed(() =>
  Boolean(props.line?.voiceId && resolvedMeta.value && !resolvedMeta.value.isActive))
const characterVoiceMissing = computed(() => Boolean(
  props.line
  && props.line.characterId
  && !props.line.voiceId
  && !props.voiceGroups.some(item => item.character_id === props.line?.characterId && item.active_voice_id)))
const instructUnsupported = computed(() => Boolean(
  resolvedMeta.value?.hasInstruct && props.capabilities && !props.capabilities.designInstruct))
const voiceHint = computed(() => {
  if (!props.line) return ''
  if (props.line.voiceId) return resolvedMeta.value ? t('take.voiceManualHint') : t('take.voiceUnknown')
  const group = props.voiceGroups.find(item => item.character_id === props.line?.characterId)
  if (group?.active_voice_id) return t('take.voiceAutoHint', { name: group.character_name })
  return t('take.voiceNarratorHint')
})
const needsSpeakerBinding = computed(() =>
  Boolean(props.line && props.line.speakerType === 'dialogue' && !props.line.characterId))
const bindingInline = ref(false)
const inlineCharacterId = ref('')

function confirmBindInline() {
  const characterId = Number(inlineCharacterId.value)
  if (!characterId) return
  emit('bind-character', characterId)
  bindingInline.value = false
  inlineCharacterId.value = ''
}

watch(() => props.line?.id, () => {
  mode.value = 'light'
  analyzedLineId.value = null
  playingTakeId.value = null
  compareNextId = null
  bindingInline.value = false
  inlineCharacterId.value = ''
  audio.value?.pause()
  resetForm()
}, { immediate: true })

watch(() => props.preview, (preview) => {
  if (!props.line || !preview) return
  if (preview.context.lineId !== props.line.id) return
  if (preview.context.mode !== mode.value) return
  if (preview.context.mode === 'deep') analyzedLineId.value = props.line.id
  form.emotion = preview.params.emotion || ''
  form.speed = preview.params.speed || 1
  form.instruct = preview.params.instruct || ''
  form.notes = preview.params.notes || ''
  const activeTake = props.takes.find(item => item.isActive)
  form.seed = activeTake?.seed !== null && activeTake?.seed !== undefined ? String(activeTake.seed) : ''
}, { deep: true })

watch(takesWithAudio, (list) => {
  if (!list.some(item => item.id === compareAId.value)) compareAId.value = list[0]?.id ?? null
  if (!list.some(item => item.id === compareBId.value)) compareBId.value = list[1]?.id ?? list[0]?.id ?? null
}, { immediate: true })

function resetForm() {
  form.emotion = ''
  form.speed = props.preview?.params.speed || 1
  form.instruct = ''
  form.seed = ''
  form.notes = ''
}

function setMode(next: 'off' | 'light' | 'deep') {
  if (mode.value === next) return
  mode.value = next
  analyzedLineId.value = next === 'deep' ? null : analyzedLineId.value
  if (next === 'deep') return
  emit('preview', next)
}

function generate() {
  if (!props.line || !canGenerate.value) return
  const overrides: TakeOverrides = {
    emotion: form.emotion.trim() || null,
    speed: Number(form.speed),
    instruct: form.instruct.trim() || null,
    notes: form.notes.trim() || null,
  }
  if (form.seed !== '') overrides.seed = Number(form.seed)
  emit('generate', { mode: mode.value, overrides })
}

function mediaUrl(url: string) {
  return url.startsWith('/') || /^https?:\/\//i.test(url) ? url : `/${url}`
}

function startTake(item: LineTake, nextId: number | null = null) {
  if (!item.audioUrl || !audio.value) return
  compareNextId = nextId
  audio.value.src = mediaUrl(item.audioUrl)
  playingTakeId.value = item.id
  void audio.value.play().catch(() => {
    playingTakeId.value = null
    compareNextId = null
  })
}

function playTake(item: LineTake) {
  if (playingTakeId.value === item.id) {
    compareNextId = null
    audio.value?.pause()
    audio.value?.removeAttribute('src')
    audio.value?.load()
    playingTakeId.value = null
    return
  }
  startTake(item)
}

function compare() {
  const first = props.takes.find(item => item.id === compareAId.value)
  const second = props.takes.find(item => item.id === compareBId.value)
  if (!first?.audioUrl || !second?.audioUrl || first.id === second.id) return
  startTake(first, second.id)
}

function onEnded() {
  if (compareNextId !== null) {
    const next = props.takes.find(item => item.id === compareNextId)
    compareNextId = null
    if (next?.audioUrl) {
      startTake(next)
      return
    }
  }
  playingTakeId.value = null
}

function removeTake(item: LineTake) {
  if (!window.confirm(t('take.deleteConfirm', { n: item.takeNo }))) return
  emit('remove', item.id)
}

function channelLabel(item: LineTake) {
  if (!item.provider && !item.model) return '—'
  return [item.provider, item.model].filter(Boolean).join(' · ')
}

function statusLabel(status: string) {
  if (status === 'ready') return t('take.statusReady')
  if (status === 'failed') return t('take.statusFailed')
  if (status === 'generating') return t('take.statusGenerating')
  return status
}

function modeLabel(value: string) {
  if (value === 'off') return t('take.modeOff')
  if (value === 'deep') return t('take.modeDeep')
  return t('take.modeLight')
}

function formatSeconds(ms: number) {
  return `${(ms / 1000).toFixed(2)}s`
}

function formatDuration(ms: number | null) {
  return ms ? formatSeconds(ms) : '—'
}

function formatTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
</script>

<style scoped>
.take-inspector { display: flex; flex-direction: column; gap: 8px; }
.take-empty { margin: 0; padding: 18px 12px; border: 1px dashed var(--border); border-radius: var(--radius-lg); color: var(--text-3); font-size: 11.5px; line-height: 1.7; text-align: center; }
.take-card { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-1); }
.take-head { display: flex; flex-direction: column; gap: 4px; }
.take-head-title { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); }
.take-line-no { color: var(--text-3); font-variant-numeric: tabular-nums; }
.take-kind { font-size: 9.5px; padding: 0 5px; border-radius: 4px; background: var(--overlay-track); color: var(--text-3); }
.take-text { font-size: 12px; line-height: 1.55; color: var(--text-0); word-break: break-word; }
.take-label { font-size: 10.5px; color: var(--text-3); text-transform: uppercase; letter-spacing: .04em; }
.take-mode-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.take-segmented { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--radius-pill); background: var(--bg-0); }
.take-segment { padding: 2px 9px; border: none; border-radius: var(--radius-pill); background: transparent; color: var(--text-3); font: inherit; font-size: 10.5px; cursor: pointer; }
.take-segment:hover { color: var(--text-1); }
.take-segment.on { color: var(--accent); background: var(--accent-bg); }
.take-context { display: flex; flex-direction: column; gap: 6px; }
.take-context-row { display: flex; gap: 6px; font-size: 10.5px; line-height: 1.5; color: var(--text-2); }
.take-context-label { flex: none; min-width: 36px; color: var(--text-3); }
.take-context-block { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border-radius: 6px; background: var(--bg-0); }
.take-context-block p { margin: 0; display: flex; gap: 5px; font-size: 10.5px; line-height: 1.5; color: var(--text-2); }
.take-context-block p strong { flex: none; color: var(--text-1); font-weight: 600; }
.take-context-block p span { min-width: 0; }
.take-context-block.is-current { border: 1px solid var(--accent-glow); background: var(--accent-bg); }
.take-context-direction { color: var(--text-3) !important; font-style: italic; }
.take-hint { margin: 0; font-size: 10.5px; line-height: 1.6; color: var(--text-3); }
.take-warn { margin: 0; padding: 5px 8px; border-radius: 6px; background: rgba(196, 138, 27, .12); color: #8a5a00; font-size: 10.5px; line-height: 1.5; }
.take-card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.take-card-head h4 { margin: 0; font-size: 11px; font-weight: 700; color: var(--text-2); text-transform: uppercase; letter-spacing: .04em; }
.take-source, .take-count { font-size: 9.5px; padding: 1px 6px; border-radius: 999px; background: var(--overlay-track); color: var(--text-3); }
.take-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 7px; }
.take-fields.is-locked { opacity: .5; }
.take-field { display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--text-3); }
.take-field.is-wide { grid-column: 1 / -1; }
.take-field input, .take-field textarea, .take-field select {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 11px; color: var(--text-1);
  background: var(--bg-2, transparent); border: 1px solid var(--border); border-radius: 5px; padding: 3px 6px;
}
.take-field textarea { resize: vertical; min-height: 38px; line-height: 1.5; }
.take-field input[type="range"] { padding: 0; accent-color: var(--accent); border: none; background: transparent; }
.mono { font-family: var(--font-mono); color: var(--text-2); }
.take-analyze, .take-generate { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.take-bind { display: flex; flex-direction: column; gap: 5px; padding-top: 6px; border-top: 1px dashed var(--border); }
.take-bind-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.take-bind-select { width: 170px; }
.take-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; max-height: 260px; overflow-y: auto; }
.take-item { display: flex; flex-direction: column; gap: 4px; padding: 7px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-0); }
.take-item.is-active { border-color: var(--accent-glow); background: var(--accent-bg); }
.take-item.is-playing { box-shadow: inset 0 0 0 1px var(--accent); }
.take-item-head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-size: 10.5px; color: var(--text-2); }
.take-item-no { font-weight: 700; color: var(--text-1); }
.take-badge { font-size: 9px; padding: 0 5px; border-radius: 999px; background: var(--overlay-track); color: var(--text-3); }
.take-badge.is-active { color: var(--accent); background: var(--accent-bg); }
.take-badge.is-ready { color: var(--success); background: var(--success-bg); }
.take-badge.is-failed { color: var(--action-danger); background: var(--danger-bg, rgba(217,83,79,.14)); }
.take-badge.is-generating { color: #c48a1b; background: rgba(196,138,27,.16); }
.take-item-time { margin-left: auto; color: var(--text-3); font-variant-numeric: tabular-nums; }
.take-item-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 9.5px; color: var(--text-3); }
.take-item-meta span { padding: 0 5px; border-radius: 4px; background: var(--overlay-track); }
.take-item-actions { display: flex; align-items: center; gap: 8px; }
.take-link { padding: 0; border: none; background: none; color: var(--text-3); font: inherit; font-size: 10.5px; cursor: pointer; }
.take-link:hover { color: var(--accent); }
.take-link:disabled { opacity: .45; cursor: default; }
.take-link.is-danger { color: var(--action-danger); }
.take-item-error { margin: 0; font-size: 10px; line-height: 1.5; color: var(--action-danger); word-break: break-word; }
.take-compare { display: flex; flex-direction: column; gap: 5px; padding-top: 6px; border-top: 1px dashed var(--border); }
.take-compare-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.take-compare-row { display: flex; align-items: flex-end; gap: 6px; flex-wrap: wrap; }
.take-compare-field { display: flex; flex-direction: column; gap: 2px; font-size: 10px; color: var(--text-3); }
.take-compare-field select { font: inherit; font-size: 10.5px; color: var(--text-1); background: var(--bg-2, transparent); border: 1px solid var(--border); border-radius: 5px; padding: 2px 4px; }
audio { display: none; }
</style>
