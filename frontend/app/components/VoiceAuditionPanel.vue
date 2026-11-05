<template>
  <section class="vap">
    <header class="vap-head">
      <strong>{{ t('voiceProfile.auditionTitle') }}</strong>
      <span v-if="meta?.channel?.provider" class="vap-channel">
        {{ meta.channel.provider }}<template v-if="meta.channel.model"> / {{ meta.channel.model }}</template>
      </span>
      <span class="vap-seed">{{ t('voiceProfile.seed') }}: {{ seed ?? '-' }}</span>
    </header>

    <textarea
      v-model="auditionText"
      class="vap-text"
      rows="3"
      :maxlength="meta?.max_chars || 300"
      :placeholder="t('voiceProfile.auditionPlaceholder')"
      @input="source = 'custom'"
    />
    <div class="vap-meta">
      <span :class="['vap-source', `is-${source}`]">{{ sourceLabel }}</span>
      <span>{{ [...auditionText].length }}/{{ meta?.max_chars || 300 }}</span>
      <button type="button" class="btn btn-sm" @click="randomSeed">{{ t('voiceProfile.randomSeed') }}</button>
      <button type="button" class="btn btn-sm" @click="restoreDefault">{{ t('voiceProfile.restoreDefault') }}</button>
    </div>

    <div class="vap-actions">
      <button type="button" class="btn btn-sm is-primary" :disabled="busy || !auditionText.trim()" @click="generate">
        <Loader2 v-if="busy" :size="11" class="animate-spin" />
        <Play v-else :size="11" />
        {{ t('voiceProfile.auditionGenerate') }}
      </button>
      <button
        type="button"
        class="btn btn-sm"
        :disabled="busy || !latestSample"
        @click="latestSample && store.setAsSample(voice, latestSample.id)"
      >
        <Check :size="11" />
        {{ t('voiceProfile.setAsSample') }}
      </button>
    </div>

    <audio v-if="playUrl" ref="player" class="vap-audio" controls preload="none" :src="mediaUrl(playUrl)" />

    <div class="vap-history">
      <div class="vap-history-title">{{ t('voiceProfile.history') }}</div>
      <p v-if="!samples.length" class="vap-empty">{{ t('voiceProfile.noHistory') }}</p>
      <div v-for="sample in samples" :key="sample.id" class="vap-history-row">
        <button type="button" class="vap-history-text" @click="play(sample)">
          <Play :size="10" />
          <span>{{ sample.text }}</span>
        </button>
        <span class="vap-history-meta">
          {{ sample.durationMs ? `${(sample.durationMs / 1000).toFixed(1)}s` : '-' }} · {{ shortTime(sample.createdAt) }}
        </span>
        <button type="button" class="btn btn-xs" :disabled="busy" @click="store.setAsSample(voice, sample.id)">
          {{ t('voiceProfile.setSample') }}
        </button>
        <button type="button" class="btn btn-xs is-danger" :disabled="busy" @click="store.deleteAudition(voice, sample.id)">
          {{ t('voiceProfile.deleteSample') }}
        </button>
      </div>
    </div>

    <details class="vap-speech">
      <summary>{{ t('voiceProfile.speechTitle') }}</summary>
      <p class="vap-hint">{{ t('voiceProfile.speechHint', { n: meta?.max_speech_chars || 2000 }) }}</p>
      <textarea v-model="speechText" class="vap-text" rows="4" :maxlength="meta?.max_speech_chars || 2000" />
      <div class="vap-actions">
        <button type="button" class="btn btn-sm is-primary" :disabled="busy || !speechText.trim()" @click="speak">
          <Loader2 v-if="busy" :size="11" class="animate-spin" />
          <Mic v-else :size="11" />
          {{ t('voiceProfile.speechGenerate') }}
        </button>
      </div>

      <div v-if="speechSample?.audioUrl" class="vap-speech-result">
        <audio class="vap-audio" controls preload="none" :src="mediaUrl(speechSample.audioUrl)" />
        <button
          v-if="episodeId"
          type="button"
          class="btn btn-sm"
          :disabled="busy"
          @click="linesOpen = !linesOpen"
        >
          {{ t('voiceProfile.applyToLines') }}
        </button>
      </div>

      <div v-if="linesOpen" class="vap-lines">
        <label v-for="line in lines" :key="line.id" class="vap-line">
          <input v-model="selectedLineIds" type="checkbox" :value="line.id">
          <span>{{ line.speakerName || t('workbench.narrator') }}：{{ line.text }}</span>
        </label>
        <p v-if="!lines.length" class="vap-empty">{{ t('voiceProfile.noHistory') }}</p>
        <div class="vap-actions">
          <button
            type="button"
            class="btn btn-sm is-primary"
            :disabled="busy || !selectedLineIds.length"
            @click="applyLines"
          >
            {{ t('voiceProfile.applySelected', { n: selectedLineIds.length }) }}
          </button>
        </div>
      </div>
    </details>
  </section>
</template>

<script setup lang="ts">
import { Check, Loader2, Mic, Play } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { dubbingAPI, type StoryboardLine, type VoiceProfile, type VoiceSample } from '~/composables/useApi'
import { useVoiceProfiles } from '~/composables/useVoiceProfiles'

const props = defineProps<{
  voice: VoiceProfile
  episodeId?: number | null
}>()

const emit = defineEmits<{
  updated: []
}>()

const { t } = useI18n()
const store = useVoiceProfiles({
  dramaId: () => props.voice.dramaId,
  episodeId: () => props.episodeId ?? null,
  onChanged: () => emit('updated'),
})

const meta = computed(() => store.auditionMetaByVoice.value[props.voice.id] || null)
const samples = computed(() => store.samplesByVoice.value[props.voice.id] || [])
const auditionText = ref('')
const speechText = ref('')
const seed = ref<number | null>(props.voice.seed ?? null)
const defaultSeed = ref<number | null>(props.voice.seed ?? null)
const source = ref<'default' | 'custom' | 'line'>('default')
const defaultText = ref('')
const playUrl = ref('')
const speechSample = ref<VoiceSample | null>(null)
const lines = ref<StoryboardLine[]>([])
const selectedLineIds = ref<number[]>([])
const linesOpen = ref(false)
const player = ref<HTMLAudioElement | null>(null)
const busy = computed(() => store.isBusy(props.voice.scope === 'narrator' ? 'narrator' : `c${props.voice.characterId ?? ''}`))
const latestSample = computed(() => samples.value.find(sample => sample.status === 'ready' && sample.audioUrl) || null)
const sourceLabel = computed(() => ({
  default: t('voiceProfile.textSourceDefault'),
  custom: t('voiceProfile.textSourceCustom'),
  line: t('voiceProfile.textSourceLine'),
}[source.value]))

function mediaUrl(url: string) {
  return url.startsWith('/') || /^https?:\/\//i.test(url) ? url : `/${url}`
}

function shortTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function play(sample: VoiceSample) {
  if (!sample.audioUrl) return
  playUrl.value = sample.audioUrl
  nextTick(() => { void player.value?.play().catch(() => {}) })
}

async function reload() {
  const result = await store.loadAuditions(props.voice, props.episodeId)
  if (!result) return
  if (!auditionText.value) {
    auditionText.value = result.text
    defaultText.value = result.text
    source.value = result.text_source
  }
  seed.value = result.seed ?? props.voice.seed ?? null
  defaultSeed.value = seed.value
}

async function generate() {
  const text = auditionText.value.trim()
  if (!text) return
  const sample = await store.generateAudition(props.voice, {
    text,
    seed: seed.value,
    textSource: source.value,
    episodeId: props.episodeId,
  })
  if (!sample?.audioUrl) return
  playUrl.value = sample.audioUrl
  seed.value = sample.seed
  defaultSeed.value = sample.seed
}

function randomSeed() {
  seed.value = Math.floor(Math.random() * 2_000_000_000)
}

function restoreDefault() {
  auditionText.value = defaultText.value
  source.value = meta.value?.text_source || 'default'
  seed.value = defaultSeed.value
}

async function speak() {
  const sample = await store.generateSpeech(props.voice, { text: speechText.value.trim(), seed: seed.value })
  if (!sample) return
  speechSample.value = sample
}

async function loadLines() {
  if (!props.episodeId || lines.value.length) return
  try {
    const result = await dubbingAPI.lines(props.episodeId)
    lines.value = (result.items || []).filter(line => !line.voiceLocked)
  } catch {
    lines.value = []
  }
}

async function applyLines() {
  if (!props.episodeId) return
  const ok = await store.applyToLines(props.voice, props.episodeId, selectedLineIds.value)
  if (ok) {
    selectedLineIds.value = []
    linesOpen.value = false
  }
}

watch(linesOpen, open => { if (open) void loadLines() })
onMounted(async () => {
  await store.loadCapabilities()
  await reload()
  auditionText.value = auditionText.value || props.voice.sampleText || ''
  seed.value = seed.value ?? props.voice.seed ?? null
})
watch(() => props.voice.id, () => {
  auditionText.value = ''
  speechText.value = ''
  speechSample.value = null
  playUrl.value = ''
  lines.value = []
  selectedLineIds.value = []
  linesOpen.value = false
  void reload()
})
</script>

<style scoped>
.vap { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--border); padding-top: 8px; }
.vap-head, .vap-meta, .vap-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vap-head { justify-content: space-between; font-size: 11.5px; }
.vap-channel, .vap-seed, .vap-history-meta { font-size: 10.5px; color: var(--text-3); }
.vap-text { width: 100%; resize: vertical; font-size: 12px; line-height: 1.6; padding: 7px 9px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-2); color: var(--text-0); }
.vap-source { border-radius: 999px; padding: 1px 7px; font-size: 10px; background: var(--overlay-track, rgba(127,127,127,.12)); color: var(--text-2); }
.vap-source.is-line { color: var(--success, #2e9e5b); background: var(--success-bg, rgba(46,158,91,.12)); }
.vap-source.is-custom { color: #c48a1b; background: rgba(196,138,27,.12); }
.vap-audio { width: 100%; height: 32px; }
.vap-history { display: flex; flex-direction: column; gap: 4px; }
.vap-history-title { font-size: 11px; font-weight: 600; color: var(--text-2); }
.vap-empty, .vap-hint { margin: 0; font-size: 10.5px; color: var(--text-3); }
.vap-history-row { display: flex; align-items: center; gap: 6px; font-size: 10.5px; }
.vap-history-text { display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1; border: none; background: transparent; color: var(--text-1); cursor: pointer; text-align: left; font-size: 10.5px; }
.vap-history-text span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vap-speech summary { cursor: pointer; font-size: 11px; color: var(--text-2); }
.vap-speech { display: flex; flex-direction: column; gap: 6px; border-top: 1px dashed var(--border); padding-top: 8px; }
.vap-speech-result { display: flex; flex-direction: column; gap: 6px; }
.vap-lines { max-height: 180px; overflow: auto; display: flex; flex-direction: column; gap: 3px; }
.vap-line { display: flex; gap: 6px; align-items: flex-start; font-size: 10.5px; color: var(--text-1); }
</style>
