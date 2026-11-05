<template>
  <div class="mx-ins">
    <header class="mx-ins-head">
      <SlidersHorizontal :size="12" />
      <h4>{{ t('mix.inspector') }}</h4>
      <span class="mx-ins-state">{{ saving ? t('mix.saving') : t('mix.saved') }}</span>
    </header>

    <div class="mx-ins-scroll">
      <section v-if="separation?.status === 'running'" class="mx-card is-sep">
        <div class="mx-card-head">
          <span class="mx-chip is-accent">{{ t('mix.separationRunning') }}</span>
          <span class="mx-muted">{{ separation.progress }}%</span>
        </div>
        <div class="mx-mini-bar"><span :style="{ width: `${separation.progress || 0}%` }" /></div>
        <p class="mx-hint">{{ separation.step || t('mix.separationPreparing') }}</p>
        <button class="mx-btn is-plain" type="button" @click="emit('cancel-separation')">{{ t('mix.separationCancel') }}</button>
      </section>

      <section v-else-if="separation?.status === 'failed'" class="mx-card is-danger">
        <div class="mx-card-head">
          <span class="mx-chip is-danger">{{ t('mix.separationFailed') }}</span>
        </div>
        <p class="mx-hint">{{ separation.error || t('mix.separationFailedHint') }}</p>
        <button class="mx-btn" type="button" @click="emit('separate', true)">{{ t('mix.separationRetry') }}</button>
      </section>

      <p v-if="basicEngine" class="mx-note is-warning">{{ t('mix.engineBasicHint') }}</p>

      <!-- 片段 -->
      <section v-if="clip" class="mx-card">
        <div class="mx-card-head">
          <span class="mx-chip" :style="{ borderColor: track?.color || undefined, color: track?.color || undefined }">{{ t('mix.clipSection') }}</span>
          <span v-if="clip.takeId" class="mx-chip is-accent">{{ t('mix.followTake', { id: clip.takeId }) }}</span>
          <span v-else class="mx-chip">{{ t('mix.manualClip') }}</span>
        </div>

        <p v-if="lineText" class="mx-line-text">
          <span v-if="lineNumber" class="mx-line-no">{{ t('mix.lineNumber', { n: lineNumber }) }}</span>
          {{ lineText }}
        </p>

        <p v-if="!clip.usable" class="mx-note is-danger">
          {{ t('mix.clipUnusable') }}<template v-if="clip.reason"> · {{ clip.reason }}</template>
        </p>

        <label class="mx-field">
          <span>{{ t('mix.clipName') }}</span>
          <input
            :value="clip.name || ''"
            :placeholder="t('mix.clipNamePlaceholder')"
            :disabled="!clipEditable"
            @change="setName"
          />
        </label>

        <div class="mx-grid2">
          <label class="mx-field">
            <span>{{ t('mix.start') }}</span>
            <input type="number" min="0" step="0.01" :value="toSec(clip.startMs)" :disabled="!clipEditable" @change="setStart" />
          </label>
          <label class="mx-field">
            <span>{{ t('mix.end') }}</span>
            <input type="number" min="0" step="0.01" :value="toSec(clip.endMs)" :disabled="!clipEditable" @change="setEnd" />
          </label>
        </div>
        <div class="mx-grid2">
          <label class="mx-field">
            <span>{{ t('mix.duration') }}</span>
            <input :value="toSec(clip.endMs - clip.startMs)" disabled />
          </label>
          <label class="mx-field">
            <span>{{ t('mix.sourceOffset') }}</span>
            <input type="number" min="0" step="0.01" :value="toSec(clip.sourceStartMs)" :disabled="!clipEditable" @change="setSourceStart" />
          </label>
        </div>

        <div class="mx-field">
          <span class="mx-field-label">{{ t('mix.gain') }} <b>{{ clip.gainDb.toFixed(1) }} dB</b></span>
          <input
            class="mx-range"
            type="range"
            min="-24"
            max="12"
            step="0.5"
            :value="clip.gainDb"
            :disabled="!clipEditable"
            @pointerdown="emit('begin-change')"
            @pointerup="emit('end-change')"
            @input="setGain"
            @change="emit('end-change')"
          />
        </div>
        <div class="mx-field">
          <span class="mx-field-label">{{ t('mix.pan') }} <b>{{ panLabel }}</b></span>
          <input
            class="mx-range"
            type="range"
            min="-100"
            max="100"
            step="1"
            :value="Math.round(clip.pan * 100)"
            :disabled="!clipEditable"
            @pointerdown="emit('begin-change')"
            @pointerup="emit('end-change')"
            @input="setPan"
            @change="emit('end-change')"
          />
        </div>
        <div class="mx-grid2">
          <label class="mx-field">
            <span>{{ t('mix.fadeIn') }}</span>
            <input type="number" min="0" step="0.05" :value="toSec(clip.fadeInMs)" :disabled="!clipEditable" @change="setFadeIn" />
          </label>
          <label class="mx-field">
            <span>{{ t('mix.fadeOut') }}</span>
            <input type="number" min="0" step="0.05" :value="toSec(clip.fadeOutMs)" :disabled="!clipEditable" @change="setFadeOut" />
          </label>
        </div>
        <label class="mx-field">
          <span>{{ t('mix.fadeCurve') }}</span>
          <BaseSelect
            :model-value="clip.fadeCurve"
            :options="curveOptions"
            :searchable="false"
            :disabled="!clipEditable"
            @update:model-value="setCurve"
          />
        </label>

        <div class="mx-toggle-row">
          <button :class="['mx-toggle', { on: clip.loop }]" type="button" :disabled="!clipEditable && !clip.loop" @click="toggleClip('loop')">{{ t('mix.loopClip') }}</button>
          <button :class="['mx-toggle', { on: clip.muted }]" type="button" :disabled="!clipEditable && !clip.muted" @click="toggleClip('muted')">{{ t('mix.mutedClip') }}</button>
          <button :class="['mx-toggle', { on: clip.locked }]" type="button" :disabled="virtual || trackLocked" @click="toggleClip('locked')">{{ t('mix.lockedClip') }}</button>
        </div>

        <p class="mx-hint">{{ t('mix.followTakeHint') }}</p>

        <div class="mx-actions">
          <button v-if="clip.lineId" class="mx-btn is-plain" type="button" @click="emit('locate-line', clip.lineId)">{{ t('mix.locateLine') }}</button>
          <button v-if="clip.lineId" class="mx-btn is-plain" type="button" @click="emit('regenerate-line', clip.lineId)">{{ t('mix.regenerateLine') }}</button>
          <button class="mx-btn is-plain" type="button" :disabled="!clipEditable" @click="emit('split-clip', clip)">{{ t('mix.splitClip') }}</button>
          <button class="mx-btn is-plain" type="button" :disabled="virtual" @click="emit('duplicate-clip', clip)">{{ t('mix.duplicateClip') }}</button>
          <button class="mx-btn is-danger" type="button" :disabled="!clipEditable" @click="emit('remove-clip', clip)">{{ t('mix.deleteClip') }}</button>
        </div>
      </section>

      <!-- 轨道 -->
      <section v-if="track" class="mx-card">
        <div class="mx-card-head">
          <span class="mx-chip" :style="{ borderColor: track.color || undefined, color: track.color || undefined }">{{ t('mix.trackSection') }}</span>
          <span v-if="track.virtual" class="mx-chip is-accent">{{ t('mix.trackVirtual') }}</span>
          <span class="mx-muted">{{ t('mix.clipCount', { n: track.clips.length }) }}</span>
        </div>

        <p v-if="track.virtual" class="mx-hint">{{ t('mix.trackVirtualHint', { n: track.clips.length }) }}</p>

        <label v-if="!track.virtual" class="mx-field">
          <span>{{ t('mix.trackName') }}</span>
          <input :value="track.name" :disabled="trackLocked" @change="setTrackName" />
        </label>
        <div v-if="!track.virtual" class="mx-grid2">
          <label class="mx-field">
            <span>{{ t('mix.trackRole') }}</span>
            <BaseSelect :model-value="track.role" :options="roleOptions" :searchable="false" :disabled="trackLocked" @update:model-value="setTrackRole" />
          </label>
          <label class="mx-field">
            <span>{{ t('mix.trackBus') }}</span>
            <BaseSelect :model-value="track.busId" :options="busOptions" :searchable="false" :disabled="trackLocked" @update:model-value="setTrackBus" />
          </label>
        </div>

        <template v-if="!track.virtual">
          <div class="mx-field">
            <span class="mx-field-label">{{ t('mix.trackVolume') }} <b>{{ Math.round(track.volume * 100) }}%</b></span>
            <input
              class="mx-range"
              type="range"
              min="0"
              max="200"
              step="1"
              :value="Math.round(track.volume * 100)"
              :disabled="trackLocked"
              @pointerdown="emit('begin-change')"
              @pointerup="emit('end-change')"
              @input="setTrackVolume"
              @change="emit('end-change')"
            />
          </div>
          <div class="mx-field">
            <span class="mx-field-label">{{ t('mix.trackPan') }} <b>{{ trackPanLabel }}</b></span>
            <input
              class="mx-range"
              type="range"
              min="-100"
              max="100"
              step="1"
              :value="Math.round(track.pan * 100)"
              :disabled="trackLocked"
              @pointerdown="emit('begin-change')"
              @pointerup="emit('end-change')"
              @input="setTrackPan"
              @change="emit('end-change')"
            />
          </div>
          <div class="mx-toggle-row">
            <button :class="['mx-toggle', { on: track.muted }]" type="button" :disabled="trackLocked" @click="toggleTrack('muted')">M</button>
            <button :class="['mx-toggle', { on: track.solo }]" type="button" :disabled="trackLocked" @click="toggleTrack('solo')">S</button>
            <button :class="['mx-toggle', { on: track.ducking }]" type="button" :disabled="trackLocked" @click="toggleTrack('ducking')">Duck</button>
            <button :class="['mx-toggle', { on: track.loop }]" type="button" :disabled="trackLocked" @click="toggleTrack('loop')">Loop</button>
            <button :class="['mx-toggle', { on: track.locked }]" type="button" @click="toggleTrack('locked')">{{ t('mix.trackLock') }}</button>
          </div>
          <button class="mx-btn is-danger" type="button" @click="emit('remove-track', track)">{{ t('mix.trackRemove') }}</button>
        </template>
      </section>

      <section v-if="!track && !clip" class="mx-card">
        <p class="mx-hint">{{ t('mix.noSelection') }}</p>
      </section>

      <section class="mx-card">
        <div class="mx-card-head">
          <span class="mx-chip">{{ t('mix.newTrack') }}</span>
        </div>
        <div class="mx-inline">
          <BaseSelect v-model="newRole" :options="roleOptions" :searchable="false" />
          <button class="mx-btn" type="button" @click="emit('add-track', newRole)">{{ t('mix.addTrack') }}</button>
        </div>
      </section>

      <!-- 集级设置（由宿主注入：字幕模式、原声、BGM 等） -->
      <slot name="settings" />

      <!-- 素材库 -->
      <section class="mx-card">
        <div class="mx-card-head">
          <span class="mx-chip">{{ t('mix.assets') }}</span>
          <span class="mx-muted">{{ assets.length }}</span>
        </div>
        <p v-if="!assets.length" class="mx-hint">{{ t('mix.assetEmpty') }}</p>
        <ul v-else class="mx-assets">
          <li v-for="asset in assets" :key="asset.id" class="mx-asset">
            <div class="mx-asset-main">
              <span class="mx-asset-kind">{{ kindLabel(asset.kind) }}</span>
              <span class="mx-asset-name" :title="assetName(asset)">{{ assetName(asset) }}</span>
              <span class="mx-asset-meta">
                {{ engineLabel(asset.engine) }}
                <template v-if="asset.durationMs"> · {{ formatMs(asset.durationMs) }}</template>
              </span>
            </div>
            <div class="mx-asset-actions">
              <button class="mx-btn is-plain" type="button" :disabled="!asset.url" @click="emit('insert-asset', asset)">{{ t('mix.assetInsert') }}</button>
              <button class="mx-btn is-danger" type="button" @click="emit('remove-asset', asset)">{{ t('mix.assetRemove') }}</button>
            </div>
          </li>
        </ul>
      </section>

      <!-- 总线 -->
      <details class="mx-card mx-details">
        <summary>{{ t('mix.busSection') }}</summary>
        <div v-for="bus in buses.filter(item => item.key !== 'master')" :key="bus.key" class="mx-bus">
          <div class="mx-bus-head">
            <span class="mx-bus-name">{{ busName(bus.key) }}</span>
            <span v-if="track?.busId === bus.key" class="mx-chip is-accent">{{ t('mix.busCurrent') }}</span>
            <span class="mx-muted">{{ Math.round(bus.volume * 100) }}%</span>
            <button :class="['mx-toggle', { on: bus.muted }]" type="button" @click="patchBus(bus, { muted: !bus.muted })">M</button>
            <button :class="['mx-toggle', { on: bus.solo }]" type="button" @click="patchBus(bus, { solo: !bus.solo })">S</button>
          </div>
          <input
            class="mx-range"
            type="range"
            min="0"
            max="200"
            step="1"
            :value="Math.round(bus.volume * 100)"
            :aria-label="busName(bus.key)"
            @pointerdown="emit('begin-change')"
            @pointerup="emit('end-change')"
            @input="setBusVolume(bus, $event)"
            @change="emit('end-change')"
          />
          <div v-if="track?.busId === bus.key" class="mx-grid3">
            <label class="mx-field">
              <span>{{ t('mix.duckRatio') }}</span>
              <input type="number" min="1" max="20" step="1" :value="bus.duckRatio" @change="setBusNumber(bus, 'duckRatio', $event)" />
            </label>
            <label class="mx-field">
              <span>{{ t('mix.duckAttack') }}</span>
              <input type="number" min="0" max="500" step="10" :value="bus.duckAttackMs" @change="setBusNumber(bus, 'duckAttackMs', $event)" />
            </label>
            <label class="mx-field">
              <span>{{ t('mix.duckRelease') }}</span>
              <input type="number" min="0" max="2000" step="10" :value="bus.duckReleaseMs" @change="setBusNumber(bus, 'duckReleaseMs', $event)" />
            </label>
          </div>
        </div>
        <div class="mx-target">
          <span>{{ t('mix.lufsTarget') }} <b>{{ master?.lufs ?? '—' }} LUFS</b></span>
          <span>{{ t('mix.truePeakTarget') }} <b>{{ master?.truePeak ?? '—' }} dBTP</b></span>
          <span class="mx-muted">{{ t('mix.targetHint') }}</span>
        </div>
      </details>

      <!-- 版本 -->
      <details v-if="revisions.length" class="mx-card mx-details">
        <summary>{{ t('mix.revisionSection') }}</summary>
        <ul class="mx-revisions">
          <li v-for="revision in revisions" :key="revision.id" class="mx-revision">
            <div class="mx-revision-main">
              <span>#{{ revision.revisionNo }}</span>
              <span class="mx-muted">{{ formatDate(revision.createdAt) }}</span>
              <span v-if="revision.isCurrent" class="mx-chip is-accent">{{ t('mix.revisionCurrent') }}</span>
            </div>
            <button class="mx-btn is-plain" type="button" :disabled="revision.isCurrent" @click="emit('restore-revision', revision)">{{ t('mix.revisionRestore') }}</button>
          </li>
        </ul>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { SlidersHorizontal } from 'lucide-vue-next'
import BaseSelect from '~/components/BaseSelect.vue'
import type {
  EpisodeAudioAsset,
  MixBus,
  MixClip as MixClipType,
  MixRevision,
  SeparationStatus,
} from '~/composables/useApi'
import type { StageClip, StageTrack } from '~/composables/useMixStage'

const props = defineProps<{
  clip: StageClip | null
  track: StageTrack | null
  buses: MixBus[]
  assets: EpisodeAudioAsset[]
  revisions: MixRevision[]
  separation: SeparationStatus | null
  lineText?: string | null
  lineNumber?: number | null
  master?: { lufs: number; truePeak: number; limiter: string } | null
  saving?: boolean
}>()

const emit = defineEmits<{
  'update-clip': [clip: StageClip, patch: Partial<MixClipType>]
  'update-track': [track: StageTrack, patch: Record<string, unknown>]
  'update-bus': [bus: MixBus, patch: Record<string, unknown>]
  'remove-clip': [clip: StageClip]
  'split-clip': [clip: StageClip]
  'duplicate-clip': [clip: StageClip]
  'locate-line': [lineId: number]
  'regenerate-line': [lineId: number]
  'add-track': [role: string]
  'remove-track': [track: StageTrack]
  'insert-asset': [asset: EpisodeAudioAsset]
  'remove-asset': [asset: EpisodeAudioAsset]
  'restore-revision': [revision: MixRevision]
  'separate': [force: boolean]
  'cancel-separation': []
  'begin-change': []
  'end-change': []
}>()

const { t } = useI18n()

const ROLE_KEYS: Record<string, string> = {
  dialogue: 'mix.roleDialogue',
  voice: 'mix.roleDialogue',
  crowd: 'mix.roleCrowd',
  original: 'mix.roleOriginal',
  ambience: 'mix.roleAmbience',
  sfx: 'mix.roleSfx',
  bgm: 'mix.roleBgm',
  custom: 'mix.roleCustom',
}
const BUS_KEYS: Record<string, string> = {
  dialogue: 'mix.busDialogue',
  original: 'mix.busOriginal',
  sfx: 'mix.busSfx',
  bgm: 'mix.busBgm',
  master: 'mix.busMaster',
}
const ASSET_KEYS: Record<string, string> = {
  original: 'mix.assetKindOriginal',
  vocals: 'mix.assetKindVocals',
  instrumental: 'mix.assetKindInstrumental',
  drums: 'mix.assetKindDrums',
  bass: 'mix.assetKindBass',
  other: 'mix.assetKindOther',
}

const newRole = ref('sfx')
const roleOptions = computed(() => ['dialogue', 'crowd', 'original', 'ambience', 'sfx', 'bgm', 'custom'].map(role => ({
  value: role,
  label: ROLE_KEYS[role] ? t(ROLE_KEYS[role]) : role,
})))
const busOptions = computed(() => props.buses.filter(bus => bus.key !== 'master').map(bus => ({
  value: bus.key,
  label: busName(bus.key),
})))
const curveOptions = computed(() => [
  { value: 'linear', label: t('mix.curveLinear') },
  { value: 'equal_power', label: t('mix.curveEqualPower') },
])

const virtual = computed(() => Boolean(props.track?.virtual))
const trackLocked = computed(() => Boolean(props.track?.locked))
const clipEditable = computed(() => Boolean(props.clip)
  && !virtual.value
  && !trackLocked.value
  && !props.clip?.locked)
const basicEngine = computed(() => props.separation?.engine === 'basic'
  || props.assets.some(asset => asset.engine === 'basic'))
const panLabel = computed(() => {
  const pan = Number(props.clip?.pan) || 0
  if (Math.abs(pan) < 0.02) return 'C'
  return `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`
})
const trackPanLabel = computed(() => {
  const pan = Number(props.track?.pan) || 0
  if (Math.abs(pan) < 0.02) return 'C'
  return `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`
})

function busName(key: string): string {
  return BUS_KEYS[key] ? t(BUS_KEYS[key]) : key
}
function kindLabel(kind: string): string {
  return ASSET_KEYS[kind] ? t(ASSET_KEYS[kind]) : (kind || t('mix.assetKindOther'))
}
function engineLabel(engine: string | null): string {
  if (!engine) return t('mix.engineUnknown')
  if (engine === 'basic') return t('mix.engineBasic')
  if (engine === 'uvr') return 'UVR'
  if (engine === 'demucs') return 'Demucs'
  return engine
}
function assetName(asset: EpisodeAudioAsset): string {
  const raw = String(asset.url || '').split('/').pop() || ''
  if (!raw) return `${kindLabel(asset.kind)} #${asset.id}`
  try { return decodeURIComponent(raw) } catch { return raw }
}
function toSec(ms: number): number {
  return Math.round(Math.max(0, Number(ms) || 0)) / 1000
}
function fromEvent(event: Event): number {
  return Number((event.target as HTMLInputElement).value)
}
function toMs(value: number): number {
  return Math.max(0, Math.round(value * 1000))
}
function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}
function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function emitClip(patch: Partial<MixClipType>) {
  if (!props.clip) return
  emit('update-clip', props.clip, patch)
}
function setName(event: Event) {
  const value = (event.target as HTMLInputElement).value.trim()
  emitClip({ name: value || null })
}
function setStart(event: Event) {
  const value = fromEvent(event)
  if (Number.isFinite(value)) emitClip({ startMs: toMs(value) })
}
function setEnd(event: Event) {
  const value = fromEvent(event)
  if (Number.isFinite(value)) emitClip({ endMs: toMs(value) })
}
function setSourceStart(event: Event) {
  const value = fromEvent(event)
  if (Number.isFinite(value)) emitClip({ sourceStartMs: toMs(value) })
}
function setGain(event: Event) {
  const value = fromEvent(event)
  if (Number.isFinite(value)) emitClip({ gainDb: value })
}
function setPan(event: Event) {
  const value = fromEvent(event)
  if (Number.isFinite(value)) emitClip({ pan: value / 100 })
}
function setFadeIn(event: Event) {
  const value = fromEvent(event)
  if (Number.isFinite(value)) emitClip({ fadeInMs: toMs(value) })
}
function setFadeOut(event: Event) {
  const value = fromEvent(event)
  if (Number.isFinite(value)) emitClip({ fadeOutMs: toMs(value) })
}
function setCurve(value: string | number) {
  emitClip({ fadeCurve: value === 'equal_power' ? 'equal_power' : 'linear' })
}
function toggleClip(key: 'loop' | 'muted' | 'locked') {
  if (!props.clip) return
  emitClip({ [key]: !props.clip[key] } as Partial<MixClipType>)
}

function emitTrack(patch: Record<string, unknown>) {
  if (!props.track) return
  emit('update-track', props.track, patch)
}
function setTrackName(event: Event) {
  const value = (event.target as HTMLInputElement).value.trim()
  if (value) emitTrack({ name: value })
}
function setTrackRole(value: string | number) {
  emitTrack({ role: String(value) })
}
function setTrackBus(value: string | number) {
  emitTrack({ busId: String(value) })
}
function setTrackVolume(event: Event) {
  const value = fromEvent(event)
  if (Number.isFinite(value)) emitTrack({ volume: value / 100 })
}
function setTrackPan(event: Event) {
  const value = fromEvent(event)
  if (Number.isFinite(value)) emitTrack({ pan: value / 100 })
}
function toggleTrack(key: 'muted' | 'solo' | 'ducking' | 'loop' | 'locked') {
  if (!props.track) return
  emitTrack({ [key]: !props.track[key] })
}

function patchBus(bus: MixBus, patch: Record<string, unknown>) {
  emit('update-bus', bus, patch)
}
function setBusVolume(bus: MixBus, event: Event) {
  const value = fromEvent(event)
  if (Number.isFinite(value)) patchBus(bus, { volume: value / 100 })
}
function setBusNumber(bus: MixBus, key: 'duckRatio' | 'duckAttackMs' | 'duckReleaseMs', event: Event) {
  const value = fromEvent(event)
  if (Number.isFinite(value)) patchBus(bus, { [key]: Math.round(value) })
}
</script>

<style scoped>
.mx-ins { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--bg-1); border-left: 1px solid var(--border); }
.mx-ins-head { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 10px; border-bottom: 1px solid var(--border); color: var(--text-2); }
.mx-ins-head h4 { margin: 0; font-size: 11.5px; font-weight: 700; color: var(--text-0); }
.mx-ins-state { margin-left: auto; font-size: 9.5px; color: var(--text-3); }
.mx-ins-scroll { flex: 1; min-height: 0; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.mx-card { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-0); }
.mx-card.is-sep { border-color: var(--accent-glow); }
.mx-card.is-danger { border-color: var(--action-danger); background: var(--action-danger-bg); }
.mx-card-head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.mx-chip { padding: 0 6px; border: 1px solid var(--border); border-radius: 999px; font-size: 9px; line-height: 15px; color: var(--text-2); white-space: nowrap; }
.mx-chip.is-accent { border-color: var(--accent-glow); background: var(--accent-bg); color: var(--accent-text); }
.mx-chip.is-danger { border-color: var(--action-danger); color: var(--action-danger); }
.mx-muted { margin-left: auto; font-size: 9.5px; color: var(--text-3); }
.mx-mini-bar { height: 4px; border-radius: 2px; background: var(--bg-3); overflow: hidden; }
.mx-mini-bar span { display: block; height: 100%; background: var(--accent); transition: width .2s ease; }
.mx-line-text { margin: 0; padding: 6px 7px; border-radius: 6px; background: var(--bg-1); border-left: 2px solid var(--accent); font-size: 10.5px; line-height: 1.55; color: var(--text-1); }
.mx-line-no { margin-right: 4px; font-weight: 700; color: var(--accent-text); }
.mx-note { margin: 0; padding: 6px 8px; border-radius: 6px; font-size: 10px; line-height: 1.5; }
.mx-note.is-warning { background: var(--warning-bg); color: var(--warning); }
.mx-note.is-danger { background: var(--action-danger-bg); color: var(--action-danger); }
.mx-hint { margin: 0; font-size: 9.5px; line-height: 1.5; color: var(--text-3); }
.mx-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mx-field > span { font-size: 9.5px; color: var(--text-3); }
.mx-field > span b { color: var(--text-1); font-weight: 600; font-variant-numeric: tabular-nums; }
.mx-field input:not([type='range']) { width: 100%; height: 24px; min-width: 0; padding: 0 6px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-1); font: inherit; font-size: 10.5px; color: var(--text-0); }
.mx-field input:focus { outline: none; border-color: var(--accent); }
.mx-field input:disabled { opacity: .55; }
.mx-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.mx-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.mx-inline { display: flex; align-items: center; gap: 6px; }
.mx-inline > :first-child { flex: 1; min-width: 0; }
.mx-range { width: 100%; height: 14px; accent-color: var(--accent); cursor: pointer; }
.mx-range:disabled { opacity: .5; cursor: default; }
.mx-toggle-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.mx-toggle { height: 21px; padding: 0 7px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-1); color: var(--text-3); font: inherit; font-size: 9.5px; font-weight: 600; cursor: pointer; }
.mx-toggle:hover { color: var(--text-1); }
.mx-toggle.on { border-color: var(--accent-glow); background: var(--accent-bg); color: var(--accent-text); }
.mx-toggle:disabled { opacity: .5; cursor: default; }
.mx-actions { display: flex; flex-wrap: wrap; gap: 5px; padding-top: 2px; }
.mx-btn { height: 24px; padding: 0 8px; border: 1px solid var(--accent); border-radius: 5px; background: var(--accent); color: var(--action-primary-text); font: inherit; font-size: 10px; font-weight: 600; cursor: pointer; }
.mx-btn:hover { background: var(--action-primary-hover); }
.mx-btn.is-plain { border-color: var(--border); background: var(--bg-1); color: var(--text-1); }
.mx-btn.is-plain:hover { border-color: var(--accent); color: var(--accent-text); }
.mx-btn.is-danger { border-color: transparent; background: var(--action-danger-bg); color: var(--action-danger); }
.mx-btn.is-danger:hover { background: var(--action-danger); color: #fff; }
.mx-btn:disabled { opacity: .45; cursor: default; }
.mx-assets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.mx-asset { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-1); }
.mx-asset-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.mx-asset-kind { font-size: 9px; color: var(--accent-text); }
.mx-asset-name { font-size: 10px; color: var(--text-0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mx-asset-meta { font-size: 9px; color: var(--text-3); }
.mx-asset-actions { display: flex; gap: 4px; flex: none; }
.mx-asset-actions .mx-btn { height: 21px; padding: 0 6px; font-size: 9px; }
.mx-details summary { cursor: pointer; font-size: 10.5px; font-weight: 600; color: var(--text-1); list-style: none; }
.mx-details summary::-webkit-details-marker { display: none; }
.mx-details summary::before { content: '＋'; margin-right: 4px; color: var(--text-3); }
.mx-details[open] summary::before { content: '－'; }
.mx-bus { display: flex; flex-direction: column; gap: 3px; padding-top: 5px; border-top: 1px dashed var(--border); }
.mx-bus-head { display: flex; align-items: center; gap: 4px; }
.mx-bus-name { font-size: 10px; font-weight: 600; color: var(--text-1); }
.mx-bus-head .mx-toggle { width: 18px; height: 18px; padding: 0; }
.mx-bus .mx-range { height: 12px; }
.mx-target { display: flex; flex-wrap: wrap; gap: 4px 10px; padding-top: 6px; border-top: 1px dashed var(--border); font-size: 9.5px; color: var(--text-2); }
.mx-target b { color: var(--text-0); font-variant-numeric: tabular-nums; }
.mx-revisions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.mx-revision { display: flex; align-items: center; gap: 6px; }
.mx-revision-main { display: flex; align-items: center; gap: 5px; flex: 1; min-width: 0; font-size: 9.5px; color: var(--text-1); }
.mx-revision-main .mx-muted { margin-left: 0; }
.mx-revision .mx-btn { height: 21px; padding: 0 6px; font-size: 9px; }
</style>
