<template>
  <section class="mix-board">
    <header class="mix-head">
      <div class="mix-head-title">
        <Layers :size="13" />
        <h3>{{ t('workbench.mixTracksTitle') }}</h3>
        <span class="mix-count">{{ t('workbench.mixTrackCount', { n: tracks.length }) }}</span>
        <span v-if="soloActive" class="mix-badge">{{ t('workbench.mixSoloActive') }}</span>
      </div>
      <div class="mix-head-actions">
        <BaseSelect v-model="newKind" :options="kindOptions" :searchable="false" class="mix-kind-select" />
        <button class="btn btn-sm" type="button" :disabled="!episodeId || creating" @click="addTrack">
          <Loader2 v-if="creating" :size="11" class="animate-spin" />
          <Plus v-else :size="11" />
          {{ t('workbench.mixTrackAdd') }}
        </button>
        <button class="mix-icon" type="button" :disabled="loading" :title="t('workbench.mixRefresh')" @click="load">
          <RefreshCw :size="12" :class="{ 'animate-spin': loading }" />
        </button>
      </div>
    </header>

    <p v-if="error" class="mix-error">{{ error }}</p>
    <p v-if="!episodeId" class="mix-empty">{{ t('workbench.mixNoEpisode') }}</p>
    <p v-else-if="!tracks.length && !loading" class="mix-empty">{{ t('workbench.mixTrackEmpty') }}</p>

    <div v-else class="mix-tracks">
      <article v-for="track in tracks" :key="track.id" :class="['mix-track', `is-${track.kind}`]">
        <div class="mix-track-head">
          <span class="mix-kind">{{ kindLabel(track.kind) }}</span>
          <input
            class="mix-name"
            :value="track.name"
            :aria-label="t('workbench.mixTrackName')"
            @change="renameTrack(track, $event)"
          />
          <button :class="['mix-toggle', { on: track.muted }]" type="button" :title="t('workbench.mixTrackMute')" @click="toggleTrack(track, 'muted')">M</button>
          <button :class="['mix-toggle', { on: track.solo }]" type="button" :title="t('workbench.mixTrackSolo')" @click="toggleTrack(track, 'solo')">S</button>
          <button :class="['mix-toggle', { on: track.ducking }]" type="button" :title="t('workbench.mixTrackDuck')" @click="toggleTrack(track, 'ducking')">
            {{ t('workbench.mixDuckShort') }}
          </button>
          <button :class="['mix-toggle', { on: track.loop }]" type="button" :title="t('workbench.mixTrackLoop')" @click="toggleTrack(track, 'loop')">
            {{ t('workbench.mixLoopShort') }}
          </button>
          <input
            class="mix-volume"
            type="range"
            min="0"
            max="200"
            step="1"
            :value="Math.round((track.volume ?? 1) * 100)"
            :title="t('workbench.mixTrackVolume')"
            @change="setVolume(track, $event)"
          />
          <span class="mix-volume-val">{{ Math.round((track.volume ?? 1) * 100) }}%</span>
          <button class="mix-icon is-danger" type="button" :title="t('workbench.mixTrackRemove')" @click="removeTrack(track)">
            <Trash2 :size="12" />
          </button>
        </div>

        <div class="mix-lane">
          <div
            v-for="clip in track.clips"
            :key="clip.id"
            :class="['mix-clip', { on: selectedClip?.clipId === clip.id }]"
            :style="clipStyle(clip)"
            @click="selectClip(track, clip)"
          >
            <span class="mix-clip-label">{{ clipLabel(clip) }}</span>
          </div>
          <span v-if="!track.clips.length" class="mix-lane-empty">{{ t('workbench.mixClipEmpty') }}</span>
        </div>

        <div class="mix-track-foot">
          <span class="mix-clip-count">{{ t('workbench.mixClipCount', { n: track.clips.length }) }}</span>
          <button class="mix-link" type="button" @click="openClipDraft(track)">{{ t('workbench.mixClipAdd') }}</button>
          <button v-if="selectedClip?.trackId === track.id" class="mix-link" type="button" @click="playSelectedClip">
            {{ t('workbench.mixClipAudition') }}
          </button>
        </div>

        <div v-if="clipDraft && clipDraft.trackId === track.id" class="mix-editor">
          <BaseSelect v-model="clipDraft.sourceName" :options="bgmSourceOptions" :placeholder="t('workbench.mixClipSource')" class="mix-editor-source" />
          <label class="mix-mini-field">
            <span>{{ t('workbench.mixClipStart') }}</span>
            <input v-model.number="clipDraft.startSec" type="number" min="0" step="0.1" />
          </label>
          <label class="mix-mini-field">
            <span>{{ t('workbench.mixClipEnd') }}</span>
            <input v-model.number="clipDraft.endSec" type="number" min="0" step="0.1" />
          </label>
          <button class="btn btn-sm is-primary" type="button" :disabled="clipSaving || !clipDraft.sourceName" @click="createClip">
            <Loader2 v-if="clipSaving" :size="11" class="animate-spin" />
            {{ t('workbench.mixClipConfirm') }}
          </button>
          <button class="btn btn-sm" type="button" @click="clipDraft = null">{{ t('workbench.mixCancel') }}</button>
        </div>

        <div v-if="selectedClip?.trackId === track.id" class="mix-editor">
          <label class="mix-mini-field">
            <span>{{ t('workbench.mixClipStart') }}</span>
            <input v-model.number="selectedClip.startSec" type="number" min="0" step="0.1" @change="saveClip" />
          </label>
          <label class="mix-mini-field">
            <span>{{ t('workbench.mixClipEnd') }}</span>
            <input v-model.number="selectedClip.endSec" type="number" min="0" step="0.1" @change="saveClip" />
          </label>
          <label class="mix-mini-field">
            <span>{{ t('workbench.mixClipFadeIn') }}</span>
            <input v-model.number="selectedClip.fadeInSec" type="number" min="0" step="0.1" @change="saveClip" />
          </label>
          <label class="mix-mini-field">
            <span>{{ t('workbench.mixClipFadeOut') }}</span>
            <input v-model.number="selectedClip.fadeOutSec" type="number" min="0" step="0.1" @change="saveClip" />
          </label>
          <button class="mix-link is-danger" type="button" @click="removeClip">{{ t('workbench.mixClipRemove') }}</button>
        </div>
      </article>
    </div>

    <div class="mix-panels">
      <section class="mix-panel">
        <h4>{{ t('workbench.mixVoiceTitle') }}</h4>
        <textarea v-model="voiceForm.text" class="mix-textarea" rows="3" :placeholder="t('workbench.mixVoiceTextPlaceholder')" />
        <div class="mix-panel-grid">
          <label class="mix-mini-field is-wide">
            <span>{{ t('workbench.mixVoiceVoice') }}</span>
            <BaseSelect v-model="voiceForm.voiceId" :options="voiceOptions" />
          </label>
          <label class="mix-mini-field">
            <span>{{ t('workbench.mixVoiceStart') }}</span>
            <input v-model.number="voiceForm.startSec" type="number" min="0" step="0.1" />
          </label>
          <label class="mix-mini-field">
            <span>{{ t('workbench.mixVoiceDuration') }}</span>
            <input v-model.number="voiceForm.durationSec" type="number" min="0" step="0.1" :placeholder="t('workbench.mixVoiceDurationAuto')" />
          </label>
        </div>
        <div class="mix-panel-actions">
          <button class="btn btn-sm is-primary" type="button" :disabled="voiceBusy || !voiceForm.text.trim() || !episodeId" @click="generateVoiceClip">
            <Loader2 v-if="voiceBusy" :size="11" class="animate-spin" />
            <Mic v-else :size="11" />
            {{ t('workbench.mixVoiceGenerate') }}
          </button>
          <span v-if="voiceCached" class="mix-cached">{{ t('workbench.mixVoiceCached') }}</span>
        </div>
        <p class="mix-hint">{{ t('workbench.mixVoiceHint') }}</p>
      </section>

      <section class="mix-panel">
        <h4>{{ t('workbench.mixRangeTitle') }}</h4>
        <div class="mix-panel-grid">
          <label class="mix-mini-field">
            <span>{{ t('workbench.mixRangeStart') }}</span>
            <input v-model.number="range.startSec" type="number" min="0" step="0.1" />
          </label>
          <label class="mix-mini-field">
            <span>{{ t('workbench.mixRangeEnd') }}</span>
            <input v-model.number="range.endSec" type="number" min="0" step="0.1" />
          </label>
        </div>
        <div class="mix-panel-actions">
          <button class="btn btn-sm is-primary" type="button" :disabled="previewBusy || !episodeId" @click="renderPreview">
            <Loader2 v-if="previewBusy" :size="11" class="animate-spin" />
            <Play v-else :size="11" />
            {{ t('workbench.mixRangeGenerate') }}
          </button>
          <span v-if="previewResult" class="mix-cached">
            {{ t('workbench.mixRangeResult', { n: previewResult.trackCount, s: (previewResult.durationMs / 1000).toFixed(1) }) }}
          </span>
        </div>
        <audio v-if="previewResult" class="mix-audio" :src="mediaUrl(previewResult.url)" controls preload="none" />
        <p class="mix-hint">{{ t('workbench.mixRangeHint') }}</p>
      </section>
    </div>

    <audio ref="clipPlayer" class="mix-hidden-audio" preload="none" />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Layers, Loader2, Mic, Play, Plus, RefreshCw, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import {
  audioTrackAPI,
  type AudioTrackKind,
  type EpisodeAudioClip,
  type EpisodeAudioTrack,
} from '~/composables/useApi'
import BaseSelect from '~/components/BaseSelect.vue'

const props = defineProps<{
  episodeId: number | null
  bgmItems: { name: string; url: string }[]
  voiceOptions: { label: string; value: string }[]
  durationMs: number
  bgmUrl?: string | null
  bgmVolume?: number
  originalAudio?: 'duck' | 'keep' | 'mute'
  duckingRatio?: number
}>()

const { t } = useI18n()

const tracks = ref<EpisodeAudioTrack[]>([])
const loading = ref(false)
const creating = ref(false)
const error = ref('')
const newKind = ref<AudioTrackKind>('ambience')

const kindOptions = computed(() => [
  { label: t('workbench.mixKindAmbience'), value: 'ambience' },
  { label: t('workbench.mixKindSfx'), value: 'sfx' },
  { label: t('workbench.mixKindBgm'), value: 'bgm' },
  { label: t('workbench.mixKindVoice'), value: 'voice' },
  { label: t('workbench.mixKindCustom'), value: 'custom' },
])
function kindLabel(kind: string) {
  return kindOptions.value.find(item => item.value === kind)?.label || kind
}

const soloActive = computed(() => tracks.value.some(track => track.solo && !track.muted))
const laneSpanMs = computed(() => {
  const clipMax = tracks.value.reduce(
    (max, track) => track.clips.reduce((inner, clip) => Math.max(inner, clip.endMs || 0), max),
    0,
  )
  return Math.max(props.durationMs || 0, clipMax, 1000)
})

function mediaUrl(url: string) {
  return url.startsWith('/') || /^https?:\/\//i.test(url) ? url : `/${url}`
}
function secToMs(value: unknown, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 1000)) : fallback
}
function msToSec(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, n / 1000) : 0
}
function clipLabel(clip: EpisodeAudioClip) {
  if (clip.text) return clip.text.slice(0, 24)
  const source = clip.sourceUrl || clip.audioUrl || ''
  const name = source.split('/').pop() || `#${clip.id}`
  try { return decodeURIComponent(name) } catch { return name }
}
function clipStyle(clip: EpisodeAudioClip) {
  const span = laneSpanMs.value
  const left = Math.min(100, Math.max(0, (clip.startMs / span) * 100))
  const width = Math.min(100 - left, Math.max(0.6, ((clip.endMs - clip.startMs) / span) * 100))
  return { left: `${left}%`, width: `${width}%` }
}

async function load() {
  if (!props.episodeId) { tracks.value = []; return }
  loading.value = true
  error.value = ''
  try {
    const result = await audioTrackAPI.list(props.episodeId)
    tracks.value = Array.isArray(result.items) ? result.items : []
  } catch (err: any) {
    error.value = err?.message || String(err)
  } finally {
    loading.value = false
  }
}
watch(() => props.episodeId, () => {
  selectedClip.value = null
  clipDraft.value = null
  previewResult.value = null
  voiceCached.value = false
  void load()
}, { immediate: true })

async function addTrack() {
  if (!props.episodeId) return
  creating.value = true
  error.value = ''
  try {
    const track = await audioTrackAPI.create(props.episodeId, { kind: newKind.value })
    tracks.value = [...tracks.value, track].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.id - b.id)
  } catch (err: any) {
    error.value = err?.message || String(err)
  } finally {
    creating.value = false
  }
}

async function patchTrack(track: EpisodeAudioTrack, patch: Record<string, any>) {
  if (!props.episodeId) return
  try {
    const updated = await audioTrackAPI.update(props.episodeId, track.id, patch)
    const index = tracks.value.findIndex(item => item.id === track.id)
    if (index >= 0) tracks.value[index] = updated
  } catch (err: any) {
    error.value = err?.message || String(err)
  }
}
function toggleTrack(track: EpisodeAudioTrack, key: 'muted' | 'solo' | 'ducking' | 'loop') {
  void patchTrack(track, { [key]: !track[key] })
}
function renameTrack(track: EpisodeAudioTrack, event: Event) {
  const name = (event.target as HTMLInputElement).value.trim()
  if (!name || name === track.name) {
    ;(event.target as HTMLInputElement).value = track.name
    return
  }
  void patchTrack(track, { name })
}
function setVolume(track: EpisodeAudioTrack, event: Event) {
  const pct = Math.max(0, Math.min(200, Number((event.target as HTMLInputElement).value) || 0))
  void patchTrack(track, { volume: pct / 100 })
}

async function removeTrack(track: EpisodeAudioTrack) {
  if (!props.episodeId) return
  try {
    await audioTrackAPI.remove(props.episodeId, track.id)
    tracks.value = tracks.value.filter(item => item.id !== track.id)
    if (selectedClip.value?.trackId === track.id) selectedClip.value = null
    if (clipDraft.value?.trackId === track.id) clipDraft.value = null
  } catch (err: any) {
    error.value = err?.message || String(err)
  }
}

const bgmSourceOptions = computed(() => props.bgmItems.map(item => ({ label: item.name, value: item.name })))
const clipDraft = ref<{ trackId: number; sourceName: string; startSec: number; endSec: number } | null>(null)
const clipSaving = ref(false)
function openClipDraft(track: EpisodeAudioTrack) {
  selectedClip.value = null
  clipDraft.value = {
    trackId: track.id,
    sourceName: '',
    startSec: range.value.startSec || 0,
    endSec: 0,
  }
}
function probeDuration(url: string): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio(mediaUrl(url))
    audio.preload = 'metadata'
    let settled = false
    const finish = (value: number) => {
      if (settled) return
      settled = true
      audio.src = ''
      resolve(value)
    }
    audio.onloadedmetadata = () => finish(audio.duration > 0 && Number.isFinite(audio.duration) ? audio.duration : 10)
    audio.onerror = () => finish(10)
    setTimeout(() => finish(10), 4000)
  })
}
watch(() => clipDraft.value?.sourceName, async (name) => {
  const draft = clipDraft.value
  if (!draft || !name) return
  const item = props.bgmItems.find(entry => entry.name === name)
  const duration = await probeDuration(item?.url || '')
  const current = clipDraft.value
  if (!current || current.sourceName !== name) return
  if (!current.endSec || current.endSec <= current.startSec) {
    current.endSec = Math.round((current.startSec + duration) * 10) / 10
  }
})

async function createClip() {
  const draft = clipDraft.value
  if (!props.episodeId || !draft) return
  const item = props.bgmItems.find(entry => entry.name === draft.sourceName)
  if (!item) { error.value = t('workbench.mixClipSourceMissing'); return }
  const startMs = secToMs(draft.startSec)
  const endMs = secToMs(draft.endSec, startMs + 1000)
  clipSaving.value = true
  try {
    await audioTrackAPI.addClip(props.episodeId, draft.trackId, {
      audio_url: item.url,
      start_ms: startMs,
      end_ms: endMs,
    })
    clipDraft.value = null
    await load()
  } catch (err: any) {
    error.value = err?.message || String(err)
  } finally {
    clipSaving.value = false
  }
}

const selectedClip = ref<{
  trackId: number
  clipId: number
  clip: EpisodeAudioClip
  startSec: number
  endSec: number
  fadeInSec: number
  fadeOutSec: number
} | null>(null)
function selectClip(track: EpisodeAudioTrack, clip: EpisodeAudioClip) {
  clipDraft.value = null
  selectedClip.value = {
    trackId: track.id,
    clipId: clip.id,
    clip,
    startSec: msToSec(clip.startMs),
    endSec: msToSec(clip.endMs),
    fadeInSec: msToSec(clip.fadeInMs),
    fadeOutSec: msToSec(clip.fadeOutMs),
  }
}
async function saveClip() {
  const current = selectedClip.value
  if (!props.episodeId || !current) return
  const startMs = secToMs(current.startSec)
  const endMs = secToMs(current.endSec, startMs + 1000)
  if (endMs - startMs < 50) { error.value = t('workbench.mixClipRangeInvalid'); return }
  try {
    await audioTrackAPI.updateClip(props.episodeId, current.clipId, {
      start_ms: startMs,
      end_ms: endMs,
      fade_in_ms: secToMs(current.fadeInSec),
      fade_out_ms: secToMs(current.fadeOutSec),
    })
    await load()
  } catch (err: any) {
    error.value = err?.message || String(err)
  }
}
async function removeClip() {
  const current = selectedClip.value
  if (!props.episodeId || !current) return
  try {
    await audioTrackAPI.removeClip(props.episodeId, current.clipId)
    selectedClip.value = null
    await load()
  } catch (err: any) {
    error.value = err?.message || String(err)
  }
}

const clipPlayer = ref<HTMLAudioElement | null>(null)
function playClip(clip: EpisodeAudioClip) {
  const url = clip.audioUrl || clip.sourceUrl
  if (!url || !clipPlayer.value) return
  clipPlayer.value.src = mediaUrl(url)
  void clipPlayer.value.play().catch(() => {})
}
function playSelectedClip() {
  if (selectedClip.value) playClip(selectedClip.value.clip)
}

const voiceForm = ref({ text: '', voiceId: '', startSec: 0, durationSec: 0 })
const voiceBusy = ref(false)
const voiceCached = ref(false)
async function generateVoiceClip() {
  if (!props.episodeId) return
  const text = voiceForm.value.text.trim()
  if (!text) return
  voiceBusy.value = true
  error.value = ''
  try {
    const result = await audioTrackAPI.voiceClip(props.episodeId, {
      text,
      voice_id: voiceForm.value.voiceId || null,
      start_ms: secToMs(voiceForm.value.startSec),
      duration_ms: Number(voiceForm.value.durationSec) > 0 ? secToMs(voiceForm.value.durationSec) : null,
    })
    voiceCached.value = result.cached
    toast.success(t('workbench.mixVoiceDone'))
    await load()
  } catch (err: any) {
    error.value = err?.message || String(err)
  } finally {
    voiceBusy.value = false
  }
}

const range = ref({ startSec: 0, endSec: 0 })
const previewBusy = ref(false)
const previewResult = ref<{ url: string; startMs: number; endMs: number; durationMs: number; trackCount: number; soloActive: boolean } | null>(null)
watch(() => props.durationMs, (duration) => {
  const end = Math.round((duration || 0) / 100) / 10
  if (!range.value.endSec || range.value.endSec > end || range.value.endSec <= range.value.startSec) {
    range.value.endSec = end
  }
  if (range.value.startSec >= range.value.endSec) range.value.startSec = 0
}, { immediate: true })
async function renderPreview() {
  if (!props.episodeId) return
  const startMs = secToMs(range.value.startSec)
  const endMs = secToMs(range.value.endSec)
  if (endMs - startMs < 200) { error.value = t('workbench.mixRangeTooShort'); return }
  previewBusy.value = true
  error.value = ''
  try {
    const result = await audioTrackAPI.preview(props.episodeId, {
      start_ms: startMs,
      end_ms: endMs,
      bgm_url: props.bgmUrl || null,
      bgm_volume: props.bgmVolume,
      original_audio: props.originalAudio,
      ducking_ratio: props.duckingRatio,
    })
    previewResult.value = result
  } catch (err: any) {
    error.value = err?.message || String(err)
  } finally {
    previewBusy.value = false
  }
}
</script>

<style scoped>
.mix-board { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.mix-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mix-head-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.mix-head-title h3 { margin: 0; font-size: 12.5px; font-weight: 700; color: var(--text-0); }
.mix-head-title svg { color: var(--text-2); }
.mix-count { font-size: 10.5px; color: var(--text-3); }
.mix-badge { font-size: 10px; padding: 1px 7px; border-radius: 999px; color: var(--accent); background: var(--accent-bg); }
.mix-head-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.mix-kind-select { width: 110px; }
.mix-icon { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-1); color: var(--text-2); cursor: pointer; }
.mix-icon:hover { color: var(--text-0); border-color: var(--border-strong, var(--border)); }
.mix-icon:disabled { opacity: .5; cursor: default; }
.mix-icon.is-danger:hover { color: var(--action-danger); }
.mix-error { margin: 0; font-size: 11px; line-height: 1.5; color: var(--action-danger); }
.mix-empty { margin: 0; padding: 12px; border: 1px dashed var(--border); border-radius: 8px; font-size: 11.5px; color: var(--text-3); text-align: center; }
.mix-tracks { display: flex; flex-direction: column; gap: 6px; }
.mix-track { display: flex; flex-direction: column; gap: 5px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-1); }
.mix-track.is-ambience { border-left: 3px solid #3c9d8f; }
.mix-track.is-sfx { border-left: 3px solid #c48a1b; }
.mix-track.is-bgm { border-left: 3px solid #6b7fd7; }
.mix-track.is-voice { border-left: 3px solid var(--accent); }
.mix-track.is-custom { border-left: 3px solid var(--text-3); }
.mix-track-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.mix-kind { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--overlay-track); color: var(--text-2); white-space: nowrap; }
.mix-name { min-width: 90px; max-width: 190px; flex: 1; height: 24px; padding: 0 7px; border: 1px solid transparent; border-radius: 6px; background: transparent; font: inherit; font-size: 11.5px; color: var(--text-0); }
.mix-name:hover, .mix-name:focus { border-color: var(--border); background: var(--bg-0); outline: none; }
.mix-toggle { min-width: 24px; height: 24px; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-0); color: var(--text-3); font: inherit; font-size: 10px; font-weight: 700; cursor: pointer; }
.mix-toggle:hover { color: var(--text-1); }
.mix-toggle.on { color: var(--accent); border-color: var(--accent-glow); background: var(--accent-bg); }
.mix-volume { width: 110px; accent-color: var(--accent); }
.mix-volume-val { width: 34px; font-size: 10.5px; color: var(--text-2); font-variant-numeric: tabular-nums; text-align: right; }
.mix-lane { position: relative; height: 24px; border-radius: 6px; background: repeating-linear-gradient(90deg, var(--overlay-track) 0 1px, transparent 1px 10%); overflow: hidden; }
.mix-clip { position: absolute; top: 2px; bottom: 2px; display: flex; align-items: center; padding: 0 6px; border-radius: 5px; background: var(--accent-bg); border: 1px solid var(--accent-glow); color: var(--text-1); cursor: pointer; overflow: hidden; }
.mix-clip.on { outline: 2px solid var(--accent); outline-offset: -1px; }
.mix-clip-label { font-size: 9.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mix-lane-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--text-3); }
.mix-track-foot { display: flex; align-items: center; gap: 10px; }
.mix-clip-count { font-size: 10px; color: var(--text-3); }
.mix-link { padding: 0; border: none; background: none; font: inherit; font-size: 10.5px; color: var(--accent); cursor: pointer; }
.mix-link:hover { text-decoration: underline; }
.mix-link.is-danger { color: var(--action-danger); }
.mix-editor { display: flex; align-items: flex-end; gap: 6px; flex-wrap: wrap; padding-top: 5px; border-top: 1px dashed var(--border); }
.mix-editor-source { width: 170px; }
.mix-mini-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mix-mini-field.is-wide { flex: 1; min-width: 160px; }
.mix-mini-field span { font-size: 9.5px; color: var(--text-3); }
.mix-mini-field input { width: 82px; height: 24px; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-0); font: inherit; font-size: 11px; color: var(--text-0); }
.mix-mini-field input:focus { outline: none; border-color: var(--accent); }
.mix-panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px; }
.mix-panel { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-1); }
.mix-panel h4 { margin: 0; font-size: 11.5px; font-weight: 700; color: var(--text-1); }
.mix-textarea { width: 100%; resize: vertical; min-height: 48px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-0); font: inherit; font-size: 11.5px; line-height: 1.6; color: var(--text-0); }
.mix-textarea:focus { outline: none; border-color: var(--accent); }
.mix-panel-grid { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.mix-panel-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mix-cached { font-size: 10px; color: var(--text-3); }
.mix-audio { width: 100%; height: 32px; }
.mix-hint { margin: 0; font-size: 10px; line-height: 1.5; color: var(--text-3); }
.mix-hidden-audio { display: none; }
</style>
