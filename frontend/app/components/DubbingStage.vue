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

    <div :class="['dub-body', { 'is-generate': currentStep === 2 }]">
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
              <button class="btn btn-sm" type="button" :disabled="busy || !episodeId" @click="showLineEditor = true">
                <Plus :size="11" />
                {{ t('workbench.addLine') }}
              </button>
              <button class="btn btn-sm is-primary" type="button" :disabled="busy || !episodeId || mergePreviewing" @click="openExtractPreview">
                <Loader2 v-if="mergePreviewing" :size="11" class="animate-spin" />
                <ScanSearch v-else :size="11" />
                {{ t('workbench.extractPreview') }}
              </button>
            </div>
          </div>

          <div v-if="!lines.length" class="dub-empty">
            <ListTodo :size="28" />
            <div class="dub-empty-title">{{ t('workbench.stepEmptyLines') }}</div>
            <div class="dub-empty-desc">{{ t('workbench.empty') }}</div>
            <div class="dub-empty-actions">
              <button class="btn btn-primary btn-sm" type="button" @click="showLineEditor = true">{{ t('workbench.addLine') }}</button>
              <button class="btn btn-sm" type="button" @click="emit('go-stage', 'videos')">
                {{ t('workbench.gotoVideos') }}
              </button>
            </div>
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
              mode="script"
              :missing-voice-character-ids="missingVoiceCharacterIds"
              :narrator-missing-voice="narratorMissingVoice"
              :voice-groups="voiceProfiles"
              :narrator-voice="narratorVoice"
              @play="playLine"
              @save="saveLineText"
              @locate="locateLine"
              @move="handleMove"
              @remove="removeLine"
              @toggle-lock="toggleLock"
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
            <div class="dub-tabs">
              <button
                type="button"
                :class="['dub-tab', { on: voiceView === 'profiles' }]"
                @click="voiceView = 'profiles'"
              >{{ t('workbench.voiceViewProfiles') }}</button>
              <button
                type="button"
                :class="['dub-tab', { on: voiceView === 'lines' }]"
                @click="voiceView = 'lines'"
              >{{ t('workbench.voiceViewLines') }}</button>
            </div>
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

          <template v-if="voiceView === 'profiles'">
            <div v-if="!voiceTotalCount" class="dub-empty">
              <Mic :size="28" />
              <div class="dub-empty-title">{{ t('workbench.stepEmptyVoices') }}</div>
              <div class="dub-empty-desc">{{ t('workbench.empty') }}</div>
              <button class="btn btn-primary btn-sm" type="button" @click="goStep(0)">{{ t('workbench.stepLines') }}</button>
            </div>
            <div v-else class="dub-voice-list">
              <VoiceProfileCard
                v-if="narratorLineCount"
                scope="narrator"
                :drama-id="dramaId"
                :episode-id="episodeId"
                :name="t('workbench.narrator')"
                :line-count="narratorLineCount"
                @updated="onVoiceChanged"
              />
              <VoiceProfileCard
                v-for="speaker in dialogueSpeakers"
                :key="speaker.characterId"
                scope="character"
                :drama-id="dramaId"
                :episode-id="episodeId"
                :character-id="speaker.characterId"
                :name="speaker.name"
                :line-count="speaker.lineCount"
                @updated="onVoiceChanged"
              />
            </div>
          </template>
          <template v-else>
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
            <div class="dub-batch-bar">
              <span class="dub-batch-count">{{ t('workbench.batchSelectHint', { n: selectedLineIds.length }) }}</span>
              <BaseSelect v-model="batchVoiceId" :options="allVoiceOptions" class="dub-batch-select" />
              <button class="btn btn-sm" type="button" :disabled="!selectedLineIds.length || batchAssigning" @click="applyBatchVoice">
                <Loader2 v-if="batchAssigning" :size="11" class="animate-spin" />
                {{ t('workbench.batchAssign') }}
              </button>
            </div>
            <LineList
              ref="lineListRef"
              :lines="filteredLines"
              :busy="busy"
              :saving="saving"
              :empty-text="t('workbench.empty')"
              mode="voice"
              selectable
              show-issues
              :missing-voice-character-ids="missingVoiceCharacterIds"
              :narrator-missing-voice="narratorMissingVoice"
              :voice-groups="voiceProfiles"
              :narrator-voice="narratorVoice"
              @play="playLine"
              @save="saveLineText"
              @locate="locateLine"
              @assign-voice="assignLineVoice"
              @selection-change="selectedLineIds = $event"
            />
          </template>
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
                :disabled="generationRunning || retryingFailed"
                @click="retryFailed"
              >
                <Loader2 v-if="retryingFailed" :size="11" class="animate-spin" />
                {{ t('workbench.retryFailed') }}
              </button>
            </div>
          </div>

          <div class="dub-gen-batch">
            <div class="dub-gen-batch-row">
              <label class="dub-gen-field">
                <span>{{ t('generate.filter') }}</span>
                <BaseSelect v-model="batchFilter" :options="batchFilterOptions" />
              </label>
              <label class="dub-gen-field">
                <span>{{ t('generate.contextMode') }}</span>
                <BaseSelect v-model="batchContextMode" :options="batchContextOptions" />
              </label>
              <label class="dub-gen-field is-narrow">
                <span>{{ t('generate.concurrency') }}</span>
                <BaseSelect v-model="batchConcurrency" :options="batchConcurrencyOptions" />
              </label>
              <label class="dub-gen-check">
                <input v-model="batchForce" type="checkbox" />
                <span>{{ t('generate.force') }}</span>
              </label>
              <div class="dub-gen-batch-actions">
                <button
                  v-if="!generationRunning"
                  class="btn btn-sm is-primary"
                  type="button"
                  :disabled="!lines.length"
                  @click="startGenerationBatch"
                >
                  <Play :size="11" />
                  {{ t('generate.start') }}
                </button>
                <button v-else class="btn btn-sm" type="button" @click="cancelGenerationBatch">
                  {{ t('generate.cancel') }}
                </button>
              </div>
            </div>
            <div v-if="batchJob" class="dub-gen-batch-progress">
              <div class="dub-bar"><span :style="{ width: batchProgress + '%' }" /></div>
              <div class="dub-gen-batch-copy">
                <span>{{ t('generate.summary', {
                  done: batchJob.done,
                  total: batchJob.total,
                  ok: batchJob.ok,
                  failed: batchJob.failed,
                  skipped: batchJob.skipped,
                  cached: batchJob.cached,
                }) }}</span>
                <span v-if="batchJob.status === 'running' && batchJob.currentLineId">
                  {{ t('generate.progressNote', { id: batchJob.currentLineId }) }}
                </span>
                <span v-else-if="batchJob.status === 'cancelled'">{{ t('generate.cancelled') }}</span>
                <span v-else-if="batchJob.status === 'done'">{{ t('generate.done') }}</span>
              </div>
            </div>
            <p v-else class="dub-hint">{{ t('generate.startHint') }}</p>
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
            mode="generate"
            :active-line-id="activeLineId"
            :take-counts="takeCounts"
            :generating-ids="generatingLineIds"
            @play="playLine"
            @synthesize="synthesizeLine"
            @inspect="inspectLine"
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
          <div class="dub-mix-stage">
            <MixStage
              ref="mixStageRef"
              :episode-id="episodeId"
              :drama-id="dramaId"
              :duration-ms="timelineTotalMs"
              :line-texts="mixLineTexts"
              :line-numbers="mixLineNumbers"
              :video-url="videoUrl"
              :cues="timelineCues"
              @soundscape-busy="mixSoundscapeBusy = $event"
              @locate-line="locateMixLine"
              @regenerate-line="regenerateMixLine"
              @timeline-retimed="loadTimeline"
            >
              <template #actions>
                <button class="btn btn-sm" type="button" :disabled="loading" @click="loadTimeline">
                  <Loader2 v-if="loading" :size="11" class="animate-spin" />
                  {{ t('workbench.refreshTimeline') }}
                </button>
              </template>

              <template #settings>
                <section class="dub-mix-card is-inline">
                  <h3 class="dub-card-title">{{ t('workbench.mixTitle') }}</h3>
                  <label class="dub-field">
                    <span class="dub-field-label">{{ t('workbench.subtitleMode') }}</span>
                    <BaseSelect v-model="subtitleMode" :options="subtitleOptions" />
                  </label>
                  <label class="dub-field">
                    <span class="dub-field-label">{{ t('workbench.originalAudio') }}</span>
                    <BaseSelect v-model="originalAudio" :options="originalOptions" :disabled="originalAudioLocked" />
                    <span v-if="originalAudioLocked" class="dub-field-hint">{{ t('workbench.originalAudioSilentLocked') }}</span>
                  </label>
                  <label class="dub-field">
                    <span class="dub-field-label">{{ t('workbench.ducking') }} <span class="mono">{{ duckingRatio }}</span></span>
                    <input v-model.number="duckingRatio" class="dub-range" type="range" min="2" max="12" step="1" :disabled="originalAudioLocked" />
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
                </section>
              </template>
            </MixStage>
            <div class="dub-next-bar">
              <span class="dub-next-copy">{{ mixSoundscapeBusy ? t('workbench.soundscapeBusy') : t('workbench.previewDoneHint') }}</span>
              <button class="btn btn-sm is-primary" type="button" :disabled="mixSoundscapeBusy" @click="nextStep">
                {{ t('workbench.nextStep', { step: stepDefs[4].label }) }}
                <ArrowRight :size="11" />
              </button>
            </div>
          </div>
        </template>

        <!-- 5. 合成导出 -->
        <template v-else>
          <ExportStage
            :episode-id="episodeId"
            :drama-id="dramaId"
            @go-stage="goStep"
            @changed="exportDone = $event"
          />
        </template>
      </section>

      <aside v-if="currentStep === 2" class="dub-inspector is-take">
        <TakeInspector
          :line="activeLine"
          :takes="activeTakes"
          :preview="activePreview"
          :generating="generatingActive"
          :analyzing="analyzingLine"
          :activating-take-id="activatingTakeId"
          :removing-take-id="removingTakeId"
          @preview="requestTakePreview"
          @analyze="analyzeTakeContext"
          @generate="generateActiveTake"
          @activate="activateTake"
          @remove="removeTake"
        />
      </aside>
      <aside v-else class="dub-inspector">
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
          <template v-else>{{ t('workbench.selectedLine') }}</template>
        </div>
        <div class="dub-player-text">
          <template v-if="selectedLine">{{ selectedLine.text }}</template>
          <template v-else>{{ t('workbench.noSelectedLine') }}</template>
        </div>
      </div>
      <audio ref="player" class="dub-player-audio" controls preload="none" />
    </footer>

    <LineEditorDialog
      :open="showLineEditor"
      :episode-id="episodeId"
      :lines="lines"
      :submitting="saving"
      @close="showLineEditor = false"
      @submit="submitNewLine"
    />
    <DialogueMergeDialog
      :open="showMergeDialog"
      :plan="mergePlan"
      :applying="mergeApplying"
      @close="closeMergeDialog"
      @apply="applyMerge"
    />
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
  Plus,
  RefreshCw,
  ScanSearch,
  SlidersHorizontal,
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { MergeDecision, StoryboardLine, TakeOverrides } from '~/composables/useApi'
import type { NewLinePayload } from '~/composables/useDubbingSession'
import BaseSelect from '~/components/BaseSelect.vue'
import DialogueMergeDialog from '~/components/DialogueMergeDialog.vue'
import ExportStage from '~/components/ExportStage.vue'
import LineEditorDialog from '~/components/LineEditorDialog.vue'
import LineList from '~/components/LineList.vue'
import MixStage from '~/components/MixStage.vue'
import TakeInspector from '~/components/TakeInspector.vue'

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
  originalAudioLocked,
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
  serviceError,
  dialogueSpeakers,
  narratorLineCount,
  voiceProfiles,
  narratorVoice,
  narratorMissingVoice,
  missingVoiceSpeakers,
  missingVoiceCharacterIds,
  longLines,
  emptyLines,
  voiceFallbackNotice,
  voiceReadyCount,
  voiceTotalCount,
  allVoiceOptions,
  voiceLoading,
  voiceGeneratingAll,
  timelineCues,
  timelineTotalMs,
  videoUrl,
  mergePlan,
  mergePreviewing,
  mergeApplying,
  load,
  loadVoices,
  loadTimeline,
  applyBgm,
  uploadBgm,
  addLine,
  removeLine,
  moveLine,
  toggleLock,
  previewExtract,
  applyExtract,
  clearMergePlan,
  synthesizeAll,
  synthesizeLine,
  takes,
  saveLineText,
  assignLineVoice,
  assignVoiceToLines,
  generateMissingVoices,
} = session

const exportDone = ref(false)
watch(() => props.episodeId, () => { exportDone.value = false })

const stepDefs = computed(() => [
  { key: 'lines', label: t('workbench.stepLines'), hint: t('workbench.stepHintLines'), icon: ListTodo },
  { key: 'voices', label: t('workbench.stepVoices'), hint: t('workbench.stepHintVoices'), icon: Mic },
  { key: 'generate', label: t('workbench.stepGenerate'), hint: t('workbench.stepHintGenerate'), icon: AudioLines },
  { key: 'preview', label: t('workbench.stepPreview'), hint: t('workbench.stepHintPreview'), icon: SlidersHorizontal },
  { key: 'export', label: t('workbench.stepExport'), hint: t('workbench.stepHintExport'), icon: Download },
])

const currentStep = computed(() => Math.max(0, Math.min(props.step || 0, stepDefs.value.length - 1)))
const mixLineTexts = computed<Record<number, string>>(() => {
  const map: Record<number, string> = {}
  for (const line of lines.value) map[line.id] = line.text
  return map
})
const mixLineNumbers = computed<Record<number, number>>(() => {
  const map: Record<number, number> = {}
  for (const line of lines.value) map[line.id] = line.lineNo
  return map
})
const stepDone = (index: number) => {
  if (index === 0) return lines.value.length > 0 && emptyLines.value.length === 0
  if (index === 1) return voiceTotalCount.value > 0 && voiceReadyCount.value === voiceTotalCount.value
  if (index === 2) return lines.value.length > 0 && readyCount.value === lines.value.length
  if (index === 3) return timelineCues.value.length > 0
  return exportDone.value || state.value?.status === 'done' || Boolean(state.value?.outputUrl)
}

const stageIndex: Record<string, number> = { lines: 0, voices: 1, generate: 2, preview: 3, export: 4 }
function goStep(index: number | string) {
  if (typeof index === 'string') {
    const mapped = stageIndex[index]
    if (mapped === undefined) {
      emit('go-stage', index)
      return
    }
    index = mapped
  }
  if (index < 0 || index >= stepDefs.value.length) return
  if (mixSoundscapeBusy.value) {
    if (index !== currentStep.value) {
      toast.error(t('workbench.soundscapeBusy'))
      return
    }
  }
  emit('update:step', index)
  if (index === 3) void loadTimeline()
}
function nextStep() { goStep(currentStep.value + 1) }
async function onVoiceChanged() {
  await Promise.all([load(), loadVoices()])
}

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

const selectedLineIds = ref<number[]>([])
const batchVoiceId = ref('')
const batchAssigning = ref(false)
const lineListRef = ref<{ clearSelection?: () => void } | null>(null)
async function applyBatchVoice() {
  if (!selectedLineIds.value.length) return
  batchAssigning.value = true
  try {
    await assignVoiceToLines(selectedLineIds.value, batchVoiceId.value ? Number(batchVoiceId.value) : null)
    lineListRef.value?.clearSelection?.()
  } finally {
    batchAssigning.value = false
  }
}

const voiceView = ref<'profiles' | 'lines'>('profiles')
const showLineEditor = ref(false)
const showMergeDialog = ref(false)

function handleMove(line: StoryboardLine, direction: -1 | 1) {
  void moveLine(line, direction, filteredLines.value.map(item => item.id))
}

async function submitNewLine(payload: NewLinePayload) {
  const ok = await addLine(payload)
  if (ok) showLineEditor.value = false
}

async function openExtractPreview() {
  const plan = await previewExtract()
  if (plan) showMergeDialog.value = true
}

async function applyMerge(decisions: MergeDecision[]) {
  const ok = await applyExtract(decisions)
  if (ok) showMergeDialog.value = false
}

function closeMergeDialog() {
  if (mergeApplying.value) return
  showMergeDialog.value = false
  clearMergePlan()
}

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

const batchFilter = ref<'pending' | 'failed' | 'audio_stale' | 'all'>('pending')
const batchFilterOptions = computed(() => [
  { label: t('generate.filterPending'), value: 'pending' },
  { label: t('generate.filterFailed'), value: 'failed' },
  { label: t('generate.filterStale'), value: 'audio_stale' },
  { label: t('generate.filterAll'), value: 'all' },
])
const batchContextMode = ref<'off' | 'light' | 'deep'>('light')
const batchContextOptions = computed(() => [
  { label: t('take.modeOff'), value: 'off' },
  { label: t('take.modeLight'), value: 'light' },
  { label: t('take.modeDeep'), value: 'deep' },
])
const batchConcurrency = ref(2)
const batchConcurrencyOptions = [1, 2, 3, 4].map(value => ({
  label: t('generate.concurrencyValue', { n: value }),
  value,
}))
const batchForce = ref(false)
const retryingFailed = ref(false)
const batchJob = computed(() => takes.batchJob.value)
const batchProgress = computed(() => takes.batchProgress.value)
const generationRunning = computed(() =>
  synthesizing.value || takes.batchRunning.value || retryingFailed.value)

function startGenerationBatch() {
  if (!lines.value.length || generationRunning.value) return
  if (batchForce.value && !window.confirm(t('generate.forceConfirm'))) return
  void synthesizeAll({
    filter: batchFilter.value,
    contextMode: batchContextMode.value,
    force: batchForce.value,
    concurrency: batchConcurrency.value,
  })
}
function cancelGenerationBatch() {
  void takes.cancelBatch()
}

const activeLineId = ref<number | null>(null)
const activeLine = computed(() => lines.value.find(line => line.id === activeLineId.value) || null)
const activeTakes = computed(() => activeLine.value ? takes.takesFor(activeLine.value.id) : [])
const activePreview = computed(() => activeLine.value ? takes.previewFor(activeLine.value.id) : null)
const generatingActive = computed(() => activeLine.value ? takes.isGenerating(activeLine.value.id) : false)
const generatingLineIds = computed(() => takes.generatingLineIds.value)
const activatingTakeId = computed(() => takes.activatingTakeId.value)
const removingTakeId = computed(() => takes.removingTakeId.value)
const analyzingLine = ref(false)
const takeCounts = computed(() => {
  const counts: Record<number, number> = {}
  for (const line of lines.value) {
    const count = takes.takesFor(line.id).length
    if (count) counts[line.id] = count
  }
  return counts
})

function inspectLine(line: StoryboardLine) {
  activeLineId.value = line.id
  selectedLine.value = line
  void Promise.all([
    takes.loadTakes(line.id),
    takes.previewContext(line.id, 'light'),
  ])
}

async function requestTakePreview(mode: 'off' | 'light' | 'deep') {
  if (!activeLine.value) return
  analyzingLine.value = mode === 'deep'
  try {
    await takes.previewContext(activeLine.value.id, mode)
  } finally {
    analyzingLine.value = false
  }
}

async function analyzeTakeContext() {
  await requestTakePreview('deep')
}

async function generateActiveTake(payload: { mode: 'off' | 'light' | 'deep'; overrides: TakeOverrides }) {
  if (!activeLine.value) return
  const result = await takes.generate(activeLine.value.id, {
    contextMode: payload.mode,
    overrides: payload.overrides,
    force: true,
  })
  if (!result) return
  serviceError.value = ''
  await Promise.all([load(), loadTimeline()])
}

async function activateTake(takeId: number) {
  const take = await takes.activate(takeId)
  if (take) await Promise.all([load(), loadTimeline()])
}

async function removeTake(takeId: number) {
  const removed = await takes.remove(takeId)
  if (removed) await Promise.all([load(), loadTimeline()])
}

watch(
  [() => currentStep.value, () => genLines.value.map(line => line.id).join(',')],
  ([step]) => {
    if (step === 2) void takes.loadTakesForLines(genLines.value.map(line => line.id))
  },
  { immediate: true },
)
watch(lines, (list) => {
  if (activeLineId.value && !list.some(line => line.id === activeLineId.value)) {
    activeLineId.value = null
  }
})

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
const mixStageRef = ref<{ seekTo: (ms: number) => void } | null>(null)
const mixSoundscapeBusy = ref(false)
const selectedLine = ref<StoryboardLine | null>(null)

function mediaUrl(url: string) {
  return url.startsWith('/') || /^https?:\/\//i.test(url) ? url : `/${url}`
}
function playLine(line: StoryboardLine) {
  if (!line.audioUrl || !player.value) return
  selectedLine.value = line
  player.value.src = mediaUrl(line.audioUrl)
  void player.value.play().catch(() => {})
}
function locateLine(line: StoryboardLine) {
  const cue = timelineCues.value.find(item => item.lineId === line.id)
  if (!cue) {
    toast.error(t('workbench.locateMissing'))
    return
  }
  goStep(3)
  nextTick(() => mixStageRef.value?.seekTo(cue.subtitleStartMs))
}
function locateMixLine(lineId: number) {
  const cue = timelineCues.value.find(item => item.lineId === lineId)
  if (!cue) {
    toast.error(t('workbench.locateMissing'))
    return
  }
  mixStageRef.value?.seekTo(cue.subtitleStartMs)
}
function regenerateMixLine(lineId: number) {
  const line = lines.value.find(item => item.id === lineId)
  if (!line) return
  inspectLine(line)
  goStep(2)
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
  if (id && id !== previous) {
    activeLineId.value = null
    takes.resetBatch()
    void load()
  }
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
.dub-body.is-generate { grid-template-columns: minmax(0, 1fr) 372px; }
.dub-main {
  min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--surface-outline); border-radius: var(--radius-lg);
  background: var(--surface-raised); padding: 10px 12px; overflow: hidden;
}
.dub-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dub-batch-bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg-2); }
.dub-batch-count { font-size: 11px; color: var(--text-3); }
.dub-batch-select { min-width: 180px; }
.dub-gen-batch { display: flex; flex-direction: column; gap: 7px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-2); }
.dub-gen-batch-row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.dub-gen-field { display: flex; flex-direction: column; gap: 3px; min-width: 120px; font-size: 10px; color: var(--text-3); }
.dub-gen-field.is-narrow { min-width: 84px; }
.dub-gen-check { display: flex; align-items: center; gap: 5px; padding-bottom: 5px; font-size: 10.5px; color: var(--text-2); cursor: pointer; }
.dub-gen-check input { margin: 0; accent-color: var(--accent); }
.dub-gen-batch-actions { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.dub-gen-batch-progress { display: flex; flex-direction: column; gap: 4px; }
.dub-gen-batch-copy { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 10.5px; color: var(--text-3); }
.dub-toolbar-title { font-size: 11.5px; color: var(--text-2); font-weight: 600; }
.dub-tabs { display: inline-flex; gap: 3px; padding: 2px; border-radius: var(--radius-pill); background: var(--bg-0); }
.dub-tab {
  padding: 3px 10px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.dub-tab:hover { color: var(--text-1); }
.dub-tab.on { color: var(--accent); background: var(--accent-bg); }
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
.dub-empty-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center; }
.dub-notice { display: flex; align-items: center; gap: 7px; padding: 7px 10px; border-radius: 8px; font-size: 11.5px; }
.dub-notice.is-warn { color: #8a5a00; background: rgba(196, 138, 27, .1); }
.dub-next-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-top: 2px; }
.dub-next-copy { flex: 1; min-width: 0; font-size: 11px; color: var(--text-3); line-height: 1.5; }
.dub-voice-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.dub-generation-summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-2); }
.dub-hint { margin: 0; font-size: 11px; line-height: 1.6; color: var(--text-3); }
.dub-progress { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-2); }
.dub-bar { height: 6px; border-radius: 3px; background: var(--overlay-track); overflow: hidden; }
.dub-bar span { display: block; height: 100%; background: var(--accent); transition: width .3s; }
.dub-mix-stage { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.dub-mix-stage :deep(.mx-stage) { flex: 1; height: auto; min-height: 480px; }
.dub-mix-stage > .dub-next-bar { flex: none; }
.dub-mix-card { min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-1); }
.dub-mix-card.is-inline { gap: 8px; padding: 0; border: none; border-radius: 0; background: transparent; overflow: visible; }
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
  .dub-body, .dub-body.is-generate { grid-template-columns: minmax(0, 1fr); }
  .dub-inspector { display: none; }
}
</style>
