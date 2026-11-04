<template>
  <div class="dubbing-stage">
    <header class="dub-head">
      <div class="dub-steps">
        <button
          v-for="(step, index) in stepDefs"
          :key="step.key"
          type="button"
          :class="['dub-step', { active: currentStep === index, done: stepDone(index) }]"
          @click="goStep(index)"
        >
          <span class="dub-step-no">{{ index + 1 }}</span>
          <component :is="step.icon" :size="12" />
          <span class="dub-step-label">{{ step.label }}</span>
          <CheckCircle2 v-if="stepDone(index)" :size="11" class="dub-step-check" />
        </button>
      </div>
      <div class="dub-head-actions">
        <span v-if="state" :class="['dub-chip', `is-${state.status}`]">{{ statusLabel }}</span>
        <button class="btn btn-sm" type="button" :disabled="loading" @click="load">
          <RefreshCw :size="11" :class="{ 'animate-spin': loading }" />
          {{ t('common.refresh') }}
        </button>
        <button class="btn btn-sm" type="button" @click="emit('open-preview')">
          {{ t('workbench.quickPreview') }}
        </button>
      </div>
    </header>

    <div v-if="serviceBanner" :class="['dub-banner', `is-${serviceBanner.kind}`]">
      <AlertCircle :size="14" class="dub-banner-icon" />
      <span class="dub-banner-text">{{ serviceBanner.text }}</span>
      <button v-if="serviceBanner.action" class="dub-banner-btn" type="button" @click="emit('open-settings')">
        {{ t('workbench.goSettings') }}
      </button>
    </div>

    <div class="dub-body">
      <section class="dub-main">
        <!-- 1. 台词准备 -->
        <template v-if="currentStep === 0">
          <div class="dub-toolbar">
            <div class="dub-filters">
              <button
                v-for="filter in lineFilters"
                :key="filter.key"
                type="button"
                :class="['dub-filter', { on: lineFilter === filter.key }]"
                @click="lineFilter = filter.key"
              >
                {{ filter.label }}
                <span class="dub-filter-count">{{ filter.count }}</span>
              </button>
            </div>
            <div class="dub-toolbar-actions">
              <button class="btn btn-sm" type="button" :disabled="busy || !episodeId" @click="extract">
                <Loader2 v-if="loading" :size="11" class="animate-spin" />
                {{ t('workbench.extract') }}
              </button>
            </div>
          </div>

          <div v-if="!lines.length" class="dub-empty">
            <ListTodo :size="28" />
            <div class="dub-empty-title">{{ t('workbench.stepEmptyLines') }}</div>
            <div class="dub-empty-desc">{{ t('workbench.empty') }}</div>
            <button class="btn btn-primary btn-sm" type="button" @click="emit('go-stage', 'videos')">
              {{ t('workbench.gotoVideos') }}
            </button>
          </div>
          <template v-else>
            <div v-if="voiceFallbackNotice" class="dub-notice is-warn">
              <AlertCircle :size="13" />
              <span>{{ t('workbench.voiceFallback') }}</span>
            </div>
            <LineList
              :lines="filteredLines"
              :busy="busy"
              :saving="saving"
              :empty-text="t('workbench.empty')"
              show-issues
              :missing-voice-character-ids="missingVoiceCharacterIds"
              :narrator-missing-voice="narratorMissingVoice"
              @play="playLine"
              @synthesize="synthesizeLine"
              @save="saveLineText"
              @locate="locateLine"
            />
            <div class="dub-next-bar">
              <span class="dub-next-copy">
                {{ t('workbench.lineSummary', { total: lines.length, empty: emptyLines.length, long: longLines.length }) }}
              </span>
              <button class="btn btn-sm is-primary" type="button" @click="nextStep">
                {{ t('workbench.nextStep', { step: stepDefs[1].label }) }}
                <ArrowRight :size="11" />
              </button>
            </div>
          </template>
        </template>

        <!-- 2. 音色分配 -->
        <template v-else-if="currentStep === 1">
          <div class="dub-toolbar">
            <span class="dub-toolbar-title">{{ t('workbench.voiceSummary', { ready: voiceReadyCount, total: voiceTotalCount }) }}</span>
            <div class="dub-toolbar-actions">
              <button class="btn btn-sm" type="button" :disabled="voiceLoading" @click="loadVoices">
                <Loader2 v-if="voiceLoading" :size="11" class="animate-spin" />
                {{ t('common.refresh') }}
              </button>
              <button
                class="btn btn-sm is-primary"
                type="button"
                :disabled="voiceGeneratingAll || !missingVoiceSpeakers.length"
                @click="generateMissingVoices"
              >
                <Loader2 v-if="voiceGeneratingAll" :size="11" class="animate-spin" />
                {{ t('workbench.voiceGenerateMissing') }}
              </button>
            </div>
          </div>

          <div v-if="!voiceTotalCount" class="dub-empty">
            <Mic :size="28" />
            <div class="dub-empty-title">{{ t('workbench.stepEmptyVoices') }}</div>
            <div class="dub-empty-desc">{{ t('workbench.empty') }}</div>
            <button class="btn btn-primary btn-sm" type="button" @click="goStep(0)">{{ t('workbench.stepLines') }}</button>
          </div>
          <div v-else class="dub-voice-list">
            <article
              v-if="narratorLineCount"
              :class="['dub-voice-card', { 'is-missing': narratorMissingVoice, 'is-playing': playingSample === 'narrator' }]"
            >
              <div class="dub-voice-main">
                <div class="dub-voice-head">
                  <strong>{{ t('workbench.narrator') }}</strong>
                  <span class="tag">{{ t('workbench.narration') }}</span>
                  <span class="dub-voice-count">{{ t('workbench.speakerLines', { n: narratorLineCount }) }}</span>
                </div>
                <div class="dub-voice-meta">
                  <template v-if="narratorVoice">
                    <span class="dub-voice-name">{{ narratorVoice.name }}</span>
                    <span :class="['dub-voice-state', narratorVoice.status === 'ready' ? 'is-ready' : '']">
                      {{ narratorVoice.status === 'ready' ? t('workbench.voiceReady') : narratorVoice.status }}
                    </span>
                  </template>
                  <span v-else class="is-warn">{{ t('workbench.voiceNone') }}</span>
                </div>
              </div>
              <div class="dub-voice-actions">
                <button
                  v-if="narratorVoice"
                  class="btn btn-sm"
                  type="button"
                  :disabled="playingSample === 'narrator'"
                  @click="auditionNarratorVoice"
                >
                  <Play :size="11" />
                  {{ t('workbench.voiceAudition') }}
                </button>
                <button
                  class="btn btn-sm"
                  type="button"
                  :disabled="narratorBusy"
                  @click="generateNarratorVoice(!!narratorVoice)"
                >
                  <Loader2 v-if="narratorBusy" :size="11" class="animate-spin" />
                  {{ narratorVoice ? t('workbench.voiceRegenerate') : t('workbench.voiceGenerate') }}
                </button>
              </div>
            </article>

            <article
              v-for="speaker in dialogueSpeakers"
              :key="speaker.characterId"
              :class="['dub-voice-card', { 'is-missing': !speaker.voice, 'is-playing': playingSample === speaker.characterId }]"
            >
              <div class="dub-voice-main">
                <div class="dub-voice-head">
                  <strong>{{ speaker.name }}</strong>
                  <span class="tag">{{ t('common.role') }}</span>
                  <span class="dub-voice-count">{{ t('workbench.speakerLines', { n: speaker.lineCount }) }}</span>
                </div>
                <div class="dub-voice-meta">
                  <template v-if="speaker.voice">
                    <span class="dub-voice-name">{{ speaker.voice.name }}</span>
                    <span :class="['dub-voice-state', speaker.voice.status === 'ready' ? 'is-ready' : '']">
                      {{ speaker.voice.status === 'ready' ? t('workbench.voiceReady') : speaker.voice.status }}
                    </span>
                  </template>
                  <span v-else class="is-warn">{{ t('workbench.voiceMissingHint') }}</span>
                </div>
              </div>
              <div class="dub-voice-actions">
                <button
                  v-if="speaker.voice"
                  class="btn btn-sm"
                  type="button"
                  :disabled="playingSample === speaker.characterId"
                  @click="auditionCharacterVoice(speaker)"
                >
                  <Play :size="11" />
                  {{ t('workbench.voiceAudition') }}
                </button>
                <button
                  class="btn btn-sm"
                  type="button"
                  :disabled="voiceBusyIds.includes(speaker.characterId)"
                  @click="generateCharacterVoice(speaker.characterId, !!speaker.voice)"
                >
                  <Loader2 v-if="voiceBusyIds.includes(speaker.characterId)" :size="11" class="animate-spin" />
                  {{ speaker.voice ? t('workbench.voiceRegenerate') : t('workbench.voiceGenerate') }}
                </button>
              </div>
            </article>
          </div>
          <div class="dub-next-bar">
            <span class="dub-next-copy">
              {{ missingVoiceSpeakers.length ? t('workbench.voiceMissingBatchHint', { n: missingVoiceSpeakers.length }) : t('workbench.voiceAllReady') }}
            </span>
            <button class="btn btn-sm is-primary" type="button" @click="nextStep">
              {{ t('workbench.nextStep', { step: stepDefs[2].label }) }}
              <ArrowRight :size="11" />
            </button>
          </div>
        </template>

        <!-- 3. 生成 -->
        <template v-else-if="currentStep === 2">
          <div class="dub-toolbar">
            <div class="dub-filters">
              <button
                v-for="filter in genFilters"
                :key="filter.key"
                type="button"
                :class="['dub-filter', { on: genFilter === filter.key }]"
                @click="genFilter = filter.key"
              >
                {{ filter.label }}
                <span class="dub-filter-count">{{ filter.count }}</span>
              </button>
            </div>
            <div class="dub-toolbar-actions">
              <button
                v-if="failedCount"
                class="btn btn-sm"
                type="button"
                :disabled="synthesizing || retryingFailed"
                @click="retryFailed"
              >
                <Loader2 v-if="retryingFailed" :size="11" class="animate-spin" />
                {{ t('workbench.retryFailed') }}
              </button>
              <button
                class="btn btn-sm is-primary"
                type="button"
                :disabled="synthesizing || !lines.length"
                @click="synthesizeAll"
              >
                <Loader2 v-if="synthesizing" :size="11" class="animate-spin" />
                {{ t('workbench.synthesizeAll') }}
              </button>
            </div>
          </div>

          <div class="dub-generation-summary">
            <span>{{ t('workbench.generateSummary', { ready: readyCount, total: lines.length, failed: failedCount }) }}</span>
            <span class="dub-hint">{{ t('workbench.longHint') }}</span>
          </div>
          <div v-if="state?.status === 'running'" class="dub-progress">
            <div class="dub-bar"><span :style="{ width: (state.progress || 0) + '%' }" /></div>
            <span>{{ state.progress }}% · {{ state.note }}</span>
          </div>
          <LineList
            :lines="genLines"
            :busy="busy"
            :saving="saving"
            :empty-text="t('workbench.genEmpty')"
            @play="playLine"
            @synthesize="synthesizeLine"
            @save="saveLineText"
            @locate="locateLine"
          />
          <div class="dub-next-bar">
            <span class="dub-next-copy">{{ t('workbench.generateDoneHint', { ready: readyCount, total: lines.length }) }}</span>
            <button class="btn btn-sm is-primary" type="button" @click="nextStep">
              {{ t('workbench.nextStep', { step: stepDefs[3].label }) }}
              <ArrowRight :size="11" />
            </button>
          </div>
        </template>

        <!-- 4. 预览与混音 -->
        <template v-else-if="currentStep === 3">
          <div class="dub-preview-grid">
            <div class="dub-preview-main">
              <SubtitlePreview ref="previewRef" :src="videoUrl" :cues="timelineCues" />
              <div class="dub-toolbar">
                <span class="dub-toolbar-title">{{ t('workbench.timelineCues', { n: timelineCues.length }) }}</span>
                <div class="dub-toolbar-actions">
                  <button class="btn btn-sm" type="button" :disabled="loading" @click="loadTimeline">
                    <Loader2 v-if="loading" :size="11" class="animate-spin" />
                    {{ t('workbench.refreshTimeline') }}
                  </button>
                  <button class="btn btn-sm" type="button" :disabled="!readyCount" @click="synthesizeAll">
                    {{ t('workbench.synthesizeAll') }}
                  </button>
                </div>
              </div>
            </div>

            <aside class="dub-mix-card">
              <h3 class="dub-card-title">{{ t('workbench.mixTitle') }}</h3>
              <label class="dub-field">
                <span class="dub-field-label">{{ t('workbench.subtitleMode') }}</span>
                <BaseSelect v-model="subtitleMode" :options="subtitleOptions" />
              </label>
              <label class="dub-field">
                <span class="dub-field-label">{{ t('workbench.originalAudio') }}</span>
                <BaseSelect v-model="originalAudio" :options="originalOptions" />
              </label>
              <label class="dub-field">
                <span class="dub-field-label">{{ t('workbench.ducking') }} <span class="mono">{{ duckingRatio }}</span></span>
                <input v-model.number="duckingRatio" class="dub-range" type="range" min="2" max="12" step="1" />
                <span class="dub-field-hint">{{ t('workbench.duckingHint') }}</span>
              </label>
              <label class="dub-field">
                <span class="dub-field-label">{{ t('workbench.bgm') }}</span>
                <BaseSelect v-model="bgmName" :options="bgmOptions" :placeholder="t('workbench.bgmNone')" />
              </label>
              <label class="dub-field">
                <span class="dub-field-label">{{ t('workbench.bgmVolume') }} <span class="mono">{{ bgmVolumePct }}%</span></span>
                <input v-model.number="bgmVolumePct" class="dub-range" type="range" min="0" max="100" step="1" />
              </label>
              <div class="dub-mix-actions">
                <button class="btn btn-sm" type="button" :disabled="bgmSaving || !episodeId" @click="applyBgm">
                  <Loader2 v-if="bgmSaving" :size="11" class="animate-spin" />
                  {{ t('workbench.bgmApply') }}
                </button>
                <label class="btn btn-sm dub-upload" :class="{ disabled: bgmUploading }">
                  {{ bgmUploading ? t('workbench.bgmUploading') : t('workbench.bgmUpload') }}
                  <input type="file" accept="audio/*" :disabled="bgmUploading" @change="uploadBgm" />
                </label>
              </div>
              <p class="dub-hint">{{ t('workbench.mixHint') }}</p>
            </aside>
          </div>
          <div class="dub-next-bar">
            <span class="dub-next-copy">{{ t('workbench.previewDoneHint') }}</span>
            <button class="btn btn-sm is-primary" type="button" @click="nextStep">
              {{ t('workbench.nextStep', { step: stepDefs[4].label }) }}
              <ArrowRight :size="11" />
            </button>
          </div>
        </template>

        <!-- 5. 导出 -->
        <template v-else>
          <div class="dub-export-grid">
            <section class="dub-export-card">
              <h3 class="dub-card-title">{{ t('workbench.startDub') }}</h3>
              <div class="dub-export-status">
                <span :class="['dub-chip', `is-${state?.status || 'idle'}`]">{{ statusLabel }}</span>
                <span class="dub-hint">{{ t('workbench.exportReadyCount', { ready: readyCount, total: lines.length }) }}</span>
              </div>
              <div v-if="state?.status === 'running'" class="dub-progress">
                <div class="dub-bar"><span :style="{ width: (state.progress || 0) + '%' }" /></div>
                <span>{{ state.progress }}% · {{ state.note }}</span>
              </div>
              <p v-else-if="state?.error" class="dub-error">{{ state.error }}</p>
              <p v-else-if="state?.status === 'done'" class="dub-ok">{{ t('workbench.doneHint') }}</p>
              <div class="dub-export-actions">
                <button
                  v-if="state?.status !== 'running'"
                  class="btn btn-primary btn-sm"
                  type="button"
                  :disabled="busy || !readyCount"
                  @click="startDub"
                >
                  <Play :size="11" />
                  {{ t('workbench.startDub') }}
                </button>
                <button v-else class="btn btn-sm" type="button" @click="stopDub">{{ t('workbench.stopDub') }}</button>
                <a v-if="state?.outputUrl" class="dub-link" :href="'/' + state.outputUrl" target="_blank" rel="noreferrer">
                  {{ t('workbench.openVideo') }}
                </a>
              </div>
              <p class="dub-hint">{{ t('workbench.startDubHint') }}</p>
            </section>

            <section class="dub-export-card">
              <h3 class="dub-card-title">{{ t('workbench.subtitleTimeline') }}</h3>
              <div class="dub-export-actions">
                <button class="btn btn-sm" type="button" :disabled="busy || !lines.length" @click="exportSubtitle('srt')">SRT</button>
                <button class="btn btn-sm" type="button" :disabled="busy || !lines.length" @click="exportSubtitle('ass')">ASS</button>
              </div>
              <p class="dub-hint">{{ t('workbench.exportHint') }}</p>
              <button class="btn btn-sm" type="button" @click="emit('go-stage', 'export')">
                {{ t('workbench.goExportStage') }}
                <ArrowRight :size="11" />
              </button>
            </section>
          </div>
        </template>
      </section>

      <aside class="dub-inspector">
        <section class="dub-inspector-card">
          <div class="dub-inspector-head">
            <h4>{{ stepDefs[currentStep].label }}</h4>
            <span v-if="state" :class="['dub-chip', `is-${state.status}`]">{{ statusLabel }}</span>
          </div>
          <p class="dub-inspector-hint">{{ stepDefs[currentStep].hint }}</p>
          <dl class="dub-metrics">
            <div><dt>{{ t('workbench.stepLines') }}</dt><dd>{{ lines.length }}</dd></div>
            <div><dt>{{ t('workbench.stepVoices') }}</dt><dd>{{ voiceReadyCount }}/{{ voiceTotalCount }}</dd></div>
            <div><dt>{{ t('workbench.stepGenerate') }}</dt><dd>{{ readyCount }}/{{ lines.length }}</dd></div>
            <div><dt>{{ t('workbench.stepPreview') }}</dt><dd>{{ timelineCues.length }}</dd></div>
          </dl>
        </section>

        <section class="dub-inspector-card">
          <h4>{{ t('workbench.progressTitle') }}</h4>
          <ol class="dub-checklist">
            <li
              v-for="(step, index) in stepDefs"
              :key="step.key"
              :class="{ done: stepDone(index), current: currentStep === index }"
              @click="goStep(index)"
            >
              <span class="dub-check-dot">
                <CheckCircle2 v-if="stepDone(index)" :size="11" />
                <span v-else>{{ index + 1 }}</span>
              </span>
              <span class="dub-check-label">{{ step.label }}</span>
            </li>
          </ol>
        </section>

        <section v-if="state?.status === 'running'" class="dub-inspector-card">
          <h4>{{ t('workbench.progressTitle') }}</h4>
          <div class="dub-progress">
            <div class="dub-bar"><span :style="{ width: (state.progress || 0) + '%' }" /></div>
            <span>{{ state.progress }}% · {{ state.note }}</span>
          </div>
        </section>
        <section v-else-if="state?.error" class="dub-inspector-card">
          <h4>{{ t('workbench.failed') }}</h4>
          <p class="dub-error">{{ state.error }}</p>
        </section>

        <section class="dub-inspector-card">
          <button class="btn btn-sm" type="button" @click="emit('open-preview')">{{ t('workbench.quickPreview') }}</button>
          <p class="dub-hint">{{ t('workbench.quickPreviewHint') }}</p>
        </section>
      </aside>
    </div>

    <footer class="dub-player">
      <div class="dub-player-info">
        <div class="dub-player-title">
          <template v-if="selectedLine">
            #{{ selectedLine.lineNo }} · {{ selectedLine.speakerName || t('workbench.narrator') }}
          </template>
          <template v-else-if="sampleLabel">{{ sampleLabel }}</template>
          <template v-else>{{ t('workbench.selectedLine') }}</template>
        </div>
        <div class="dub-player-text">
          <template v-if="selectedLine">{{ selectedLine.text }}</template>
          <template v-else-if="sampleLabel">{{ t('workbench.playingSample', { name: sampleLabel }) }}</template>
          <template v-else>{{ t('workbench.noSelectedLine') }}</template>
        </div>
      </div>
      <audio ref="player" class="dub-player-audio" controls preload="none" />
    </footer>
  </div>
</template>

<script setup lang="ts">
import {
  AlertCircle,
  ArrowRight,
  AudioLines,
  CheckCircle2,
  Clapperboard,
  Download,
  ListTodo,
  Loader2,
  Mic,
  Play,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { StoryboardLine } from '~/composables/useApi'
import BaseSelect from '~/components/BaseSelect.vue'
import LineList from '~/components/LineList.vue'
import SubtitlePreview from '~/components/SubtitlePreview.vue'

const props = defineProps<{
  episodeId: number | null
  dramaId: number
  step: number
}>()

const emit = defineEmits<{
  'update:step': [step: number]
  'open-preview': []
  'open-settings': []
  'go-stage': [stage: string]
  summary: [payload: Record<string, any>]
}>()

const { t } = useI18n()

const session = useDubbingSession({
  episodeId: () => props.episodeId,
  dramaId: () => props.dramaId,
  onUpdated: () => emit('summary', summaryPayload.value),
})

const {
  lines,
  state,
  loading,
  synthesizing,
  saving,
  subtitleMode,
  originalAudio,
  duckingRatio,
  bgmName,
  bgmVolumePct,
  bgmSaving,
  bgmUploading,
  busy,
  readyCount,
  failedCount,
  statusLabel,
  subtitleOptions,
  originalOptions,
  bgmOptions,
  serviceBanner,
  dialogueSpeakers,
  narratorLineCount,
  narratorVoice,
  narratorMissingVoice,
  missingVoiceSpeakers,
  missingVoiceCharacterIds,
  longLines,
  emptyLines,
  voiceFallbackNotice,
  voiceReadyCount,
  voiceTotalCount,
  voiceLoading,
  voiceBusyIds,
  narratorBusy,
  voiceGeneratingAll,
  timelineCues,
  videoUrl,
  load,
  loadVoices,
  loadTimeline,
  applyBgm,
  uploadBgm,
  extract,
  synthesizeAll,
  synthesizeLine,
  saveLineText,
  startDub,
  stopDub,
  exportSubtitle,
  generateCharacterVoice,
  generateMissingVoices,
  generateNarratorVoice,
  auditionCharacter,
  auditionNarrator,
} = session

const stepDefs = computed(() => [
  { key: 'lines', label: t('workbench.stepLines'), hint: t('workbench.stepHintLines'), icon: ListTodo },
  { key: 'voices', label: t('workbench.stepVoices'), hint: t('workbench.stepHintVoices'), icon: Mic },
  { key: 'generate', label: t('workbench.stepGenerate'), hint: t('workbench.stepHintGenerate'), icon: AudioLines },
  { key: 'preview', label: t('workbench.stepPreview'), hint: t('workbench.stepHintPreview'), icon: SlidersHorizontal },
  { key: 'export', label: t('workbench.stepExport'), hint: t('workbench.stepHintExport'), icon: Download },
])

const currentStep = computed(() => Math.max(0, Math.min(props.step || 0, stepDefs.value.length - 1)))
const stepDone = (index: number) => {
  if (index === 0) return lines.value.length > 0 && emptyLines.value.length === 0
  if (index === 1) return voiceTotalCount.value > 0 && voiceReadyCount.value === voiceTotalCount.value
  if (index === 2) return lines.value.length > 0 && readyCount.value === lines.value.length
  if (index === 3) return timelineCues.value.length > 0
  return state.value?.status === 'done' || Boolean(state.value?.outputUrl)
}

function goStep(index: number) {
  if (index < 0 || index >= stepDefs.value.length) return
  emit('update:step', index)
  if (index === 3) void loadTimeline()
}
function nextStep() { goStep(currentStep.value + 1) }

const lineFilter = ref<'all' | 'noVoice' | 'long' | 'empty'>('all')
const lineFilters = computed(() => [
  { key: 'all' as const, label: t('workbench.filterAll'), count: lines.value.length },
  { key: 'noVoice' as const, label: t('workbench.filterNoVoice'), count: lines.value.filter(lineMissingVoice).length },
  { key: 'long' as const, label: t('workbench.filterLong'), count: longLines.value.length },
  { key: 'empty' as const, label: t('workbench.filterEmpty'), count: emptyLines.value.length },
])
function lineMissingVoice(line: StoryboardLine) {
  if (line.speakerType !== 'dialogue') return narratorMissingVoice.value
  return Boolean(line.characterId && missingVoiceCharacterIds.value.includes(line.characterId))
}
const filteredLines = computed(() => {
  if (lineFilter.value === 'noVoice') return lines.value.filter(lineMissingVoice)
  if (lineFilter.value === 'long') return longLines.value
  if (lineFilter.value === 'empty') return emptyLines.value
  return lines.value
})

const genFilter = ref<'all' | 'pending' | 'failed' | 'ready'>('all')
const genFilters = computed(() => [
  { key: 'all' as const, label: t('workbench.filterAll'), count: lines.value.length },
  { key: 'pending' as const, label: t('workbench.statusPending'), count: Math.max(lines.value.length - readyCount.value - failedCount.value, 0) },
  { key: 'failed' as const, label: t('workbench.filterFailed'), count: failedCount.value },
  { key: 'ready' as const, label: t('workbench.filterReady'), count: readyCount.value },
])
const genLines = computed(() => {
  if (genFilter.value === 'failed') return lines.value.filter(line => line.status === 'failed')
  if (genFilter.value === 'ready') return lines.value.filter(line => line.status === 'ready' && line.audioUrl)
  if (genFilter.value === 'pending') return lines.value.filter(line => line.status !== 'ready' && line.status !== 'failed')
  return lines.value
})

const retryingFailed = ref(false)
async function retryFailed() {
  const failed = lines.value.filter(line => line.status === 'failed')
  if (!failed.length) return
  retryingFailed.value = true
  try {
    for (const line of failed) await synthesizeLine(line)
  } finally {
    retryingFailed.value = false
  }
}

const player = ref<HTMLAudioElement | null>(null)
const previewRef = ref<{ seekTo: (ms: number) => void } | null>(null)
const selectedLine = ref<StoryboardLine | null>(null)
const playingSample = ref<number | 'narrator' | null>(null)
const sampleLabel = ref('')

function mediaUrl(url: string) {
  return url.startsWith('/') || /^https?:\/\//i.test(url) ? url : `/${url}`
}
function playLine(line: StoryboardLine) {
  if (!line.audioUrl || !player.value) return
  selectedLine.value = line
  playingSample.value = null
  sampleLabel.value = ''
  player.value.src = mediaUrl(line.audioUrl)
  void player.value.play().catch(() => {})
}
function playSample(url: string, label: string, id: number | 'narrator') {
  if (!url || !player.value) return
  selectedLine.value = null
  playingSample.value = id
  sampleLabel.value = label
  player.value.src = mediaUrl(url)
  void player.value.play().catch(() => {})
}
async function auditionCharacterVoice(speaker: { characterId: number; name: string }) {
  const url = await auditionCharacter(speaker.characterId)
  if (url) playSample(url, speaker.name, speaker.characterId)
}
async function auditionNarratorVoice() {
  const url = await auditionNarrator()
  if (url) playSample(url, t('workbench.narrator'), 'narrator')
}
function locateLine(line: StoryboardLine) {
  const cue = timelineCues.value.find(item => item.lineId === line.id)
  if (!cue) {
    toast.error(t('workbench.locateMissing'))
    return
  }
  goStep(3)
  nextTick(() => previewRef.value?.seekTo(cue.subtitleStartMs))
}

const summaryPayload = computed(() => ({
  total: lines.value.length,
  ready: readyCount.value,
  failed: failedCount.value,
  status: state.value?.status || 'idle',
  missingVoice: missingVoiceSpeakers.value.length + (narratorMissingVoice.value ? 1 : 0),
  hasOutput: Boolean(state.value?.outputUrl),
  voiceReady: voiceReadyCount.value,
  voiceTotal: voiceTotalCount.value,
}))
watch(summaryPayload, payload => emit('summary', payload), { immediate: true })

onMounted(() => { void load() })
watch(() => props.episodeId, (id, previous) => {
  if (id && id !== previous) void load()
})
watch(() => props.step, step => {
  if (step === 3) void loadTimeline()
})
</script>

<style scoped>
.dubbing-stage { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px; }
.dub-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dub-steps { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; flex-wrap: wrap; }
.dub-step {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px;
  border: 1px solid var(--border); border-radius: var(--radius-pill);
  background: var(--bg-1); color: var(--text-3); font: inherit; font-size: 11.5px;
  cursor: pointer; transition: all .15s;
}
.dub-step:hover { color: var(--text-1); border-color: var(--text-3); }
.dub-step.active { color: var(--accent); border-color: var(--accent); background: var(--accent-bg); }
.dub-step.done { color: var(--success); border-color: var(--success-bg); background: var(--success-bg); }
.dub-step-no { width: 16px; height: 16px; border-radius: 50%; background: var(--overlay-track); display: inline-flex; align-items: center; justify-content: center; font-size: 9.5px; font-weight: 700; }
.dub-step.active .dub-step-no { background: var(--accent); color: var(--on-accent, #fff); }
.dub-step-check { flex-shrink: 0; }
.dub-head-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dub-chip { font-size: 10px; padding: 2px 8px; border-radius: 999px; background: var(--overlay-track); color: var(--text-2); white-space: nowrap; }
.dub-chip.is-done { color: var(--success); background: var(--success-bg); }
.dub-chip.is-running { color: var(--accent); background: var(--accent-bg); }
.dub-chip.is-failed { color: var(--action-danger); background: var(--danger-bg, rgba(217,83,79,.14)); }
.dub-chip.is-stale, .dub-chip.is-review { color: #c48a1b; background: rgba(196,138,27,.16); }
.dub-banner { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); font-size: 11.5px; line-height: 1.5; }
.dub-banner.is-warn { color: #8a5a00; background: rgba(196, 138, 27, .1); border-color: rgba(196, 138, 27, .35); }
.dub-banner.is-error { color: #a3312d; background: rgba(217, 83, 79, .09); border-color: rgba(217, 83, 79, .35); }
.dub-banner.is-info { color: var(--text-2); background: rgba(127, 127, 127, .07); }
.dub-banner-icon { flex: none; }
.dub-banner-text { flex: 1; min-width: 0; }
.dub-banner-btn { background: none; border: 1px solid currentColor; border-radius: 6px; padding: 2px 9px; font: inherit; font-size: 11px; color: inherit; cursor: pointer; white-space: nowrap; }
.dub-banner-btn:hover { background: rgba(127, 127, 127, .1); }
.dub-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 288px; gap: 8px; }
.dub-main {
  min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--surface-outline); border-radius: var(--radius-lg);
  background: var(--surface-raised); padding: 10px 12px; overflow: hidden;
}
.dub-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dub-toolbar-title { font-size: 11.5px; color: var(--text-2); font-weight: 600; }
.dub-toolbar-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.dub-filters { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.dub-filter {
  display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px;
  border: 1px solid transparent; border-radius: var(--radius-pill);
  background: var(--bg-0); color: var(--text-3); font: inherit; font-size: 11px; cursor: pointer;
}
.dub-filter:hover { color: var(--text-1); }
.dub-filter.on { color: var(--accent); background: var(--accent-bg); border-color: var(--accent-glow); }
.dub-filter-count { font-variant-numeric: tabular-nums; opacity: .8; }
.dub-empty { flex: 1; min-height: 240px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--text-3); text-align: center; }
.dub-empty-title { font-size: 14px; font-weight: 700; color: var(--text-1); }
.dub-empty-desc { font-size: 12px; max-width: 420px; line-height: 1.7; }
.dub-notice { display: flex; align-items: center; gap: 7px; padding: 7px 10px; border-radius: 8px; font-size: 11.5px; }
.dub-notice.is-warn { color: #8a5a00; background: rgba(196, 138, 27, .1); }
.dub-next-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 2px; }
.dub-next-copy { flex: 1; min-width: 0; font-size: 11px; color: var(--text-3); line-height: 1.5; }
.dub-voice-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.dub-voice-card {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-1);
}
.dub-voice-card.is-missing { border-color: rgba(196, 138, 27, .38); background: rgba(196, 138, 27, .05); }
.dub-voice-card.is-playing { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
.dub-voice-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dub-voice-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.dub-voice-head strong { font-size: 12.5px; color: var(--text-0); }
.dub-voice-count { margin-left: auto; font-size: 10.5px; color: var(--text-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dub-voice-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-2); flex-wrap: wrap; }
.dub-voice-name { color: var(--text-1); font-weight: 600; }
.dub-voice-state { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: var(--overlay-track); color: var(--text-2); }
.dub-voice-state.is-ready { color: var(--success); background: var(--success-bg); }
.dub-voice-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; flex-wrap: wrap; }
.is-warn { color: #8a5a00; }
.dub-generation-summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-2); }
.dub-hint { margin: 0; font-size: 11px; line-height: 1.6; color: var(--text-3); }
.dub-progress { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-2); }
.dub-bar { height: 6px; border-radius: 3px; background: var(--overlay-track); overflow: hidden; }
.dub-bar span { display: block; height: 100%; background: var(--accent); transition: width .3s; }
.dub-preview-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 250px; gap: 10px; }
.dub-preview-main { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.dub-mix-card { min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-1); }
.dub-card-title { margin: 0; font-size: 12.5px; font-weight: 700; color: var(--text-0); }
.dub-field { display: flex; flex-direction: column; gap: 4px; }
.dub-field-label { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; color: var(--text-2); }
.dub-field-hint { font-size: 10px; color: var(--text-3); line-height: 1.5; }
.dub-range { width: 100%; accent-color: var(--accent); }
.dub-mix-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.dub-upload { cursor: pointer; }
.dub-upload.disabled { opacity: .55; cursor: default; }
.dub-upload input { display: none; }
.dub-export-grid { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; align-content: start; }
.dub-export-card { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-1); }
.dub-export-status { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dub-export-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dub-link { color: var(--accent); font-size: 11.5px; text-decoration: none; }
.dub-link:hover { text-decoration: underline; }
.dub-error { margin: 0; color: var(--action-danger); font-size: 11px; line-height: 1.5; }
.dub-ok { margin: 0; color: var(--success); font-size: 11px; line-height: 1.5; }
.dub-inspector { min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.dub-inspector-card { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-1); }
.dub-inspector-card h4 { margin: 0; font-size: 11px; font-weight: 700; color: var(--text-2); text-transform: uppercase; letter-spacing: .04em; }
.dub-inspector-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.dub-inspector-hint { margin: 0; font-size: 11px; line-height: 1.6; color: var(--text-2); }
.dub-metrics { margin: 0; display: flex; flex-direction: column; gap: 5px; }
.dub-metrics > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; }
.dub-metrics dt { color: var(--text-3); margin: 0; }
.dub-metrics dd { margin: 0; color: var(--text-1); font-variant-numeric: tabular-nums; font-weight: 600; }
.dub-checklist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.dub-checklist li { display: flex; align-items: center; gap: 7px; padding: 4px 6px; border-radius: 6px; font-size: 11px; color: var(--text-2); cursor: pointer; }
.dub-checklist li:hover { background: var(--bg-0); }
.dub-checklist li.current { color: var(--accent); background: var(--accent-bg); }
.dub-checklist li.done { color: var(--success); }
.dub-check-dot { width: 16px; height: 16px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--overlay-track); font-size: 9.5px; font-weight: 700; flex-shrink: 0; }
.dub-checklist li.current .dub-check-dot { background: var(--accent); color: var(--on-accent, #fff); }
.dub-checklist li.done .dub-check-dot { background: var(--success-bg); color: var(--success); }
.dub-check-label { min-width: 0; }
.dub-player { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-1); }
.dub-player-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dub-player-title { font-size: 11.5px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dub-player-text { font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dub-player-audio { width: min(360px, 50%); height: 34px; }
.mono { font-family: var(--font-mono); color: var(--text-1); }
@media (max-width: 1100px) {
  .dub-body { grid-template-columns: minmax(0, 1fr); }
  .dub-inspector { display: none; }
  .dub-preview-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
