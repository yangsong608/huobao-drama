<template>
  <section class="video-workbench" :class="{ compact: isCompact }">
    <button v-if="isCompact" type="button" class="drawer-toggle btn btn-sm" @click="drawerOpen = true">
      <PanelLeft :size="14" /> {{ t('video.projects') }}
    </button>
    <div v-if="isCompact && drawerOpen" class="drawer-scrim" @click="drawerOpen = false"></div>
    <div class="video-rail-wrap" :class="{ open: drawerOpen }">
      <VideoProjectList
        :projects="projects"
        :active-id="id"
        :loading="projectsLoading"
        @create="createOpen = true"
        @select="selectProject"
        @rename="startRename"
        @duplicate="duplicateProject"
        @delete="deleteTarget = $event"
      />
    </div>

    <main class="video-main">
      <div v-if="loading && !project" class="loading-state">
        <Loader2 :size="24" class="animate-spin" />
        <span>{{ t('common.loading') }}</span>
      </div>

      <template v-else-if="project">
        <header class="workbench-head">
          <div class="head-project">
            <button v-if="isCompact" type="button" class="btn btn-icon btn-sm" @click="drawerOpen = true"><PanelLeft :size="15" /></button>
            <div>
              <div class="head-line">
                <h1 class="project-title">{{ project.title }}</h1>
                <span class="mode-pill">{{ t(`video.mode.${project.mode}`) }}</span>
                <span class="status-pill" :class="`is-${project.status || 'draft'}`">{{ t(`video.status.${project.status || 'draft'}`) }}</span>
              </div>
              <p class="project-intro">{{ project.mode === 'face' ? t('video.faceIntro') : t('video.characterIntro') }}</p>
            </div>
          </div>
          <div class="head-actions">
            <span v-if="currentRunId" class="run-id mono">#{{ currentRunId }}</span>
            <BaseSelect
              v-if="runOptions.length > 1"
              class="run-version-select"
              :model-value="selectedRunId ?? ''"
              :options="runOptions"
              :searchable="false"
              :placeholder="t('video.workbench.version')"
              @update:model-value="selectRun"
            />
            <button type="button" class="btn btn-sm" :disabled="refreshing" @click="refreshAll">
              <RefreshCw :size="13" :class="{ 'animate-spin': refreshing }" />
              {{ t('common.refresh') }}
            </button>
          </div>
        </header>

        <div v-if="error" class="error-banner card">
          <TriangleAlert :size="14" />
          <span>{{ error }}</span>
          <button type="button" class="btn btn-sm" @click="error = ''">{{ t('common.close') }}</button>
        </div>

        <div v-if="preflight" class="preflight-strip" :class="{ ok: preflight.ok, bad: !preflight.ok }">
          <span class="preflight-icon">
            <CheckCircle2 v-if="preflight.ok" :size="14" />
            <TriangleAlert v-else :size="14" />
          </span>
          <span v-if="preflight.ok">{{ t('video.workbench.preflightOk') }}</span>
          <span v-else>{{ t('video.workbench.preflightFailed') }}：{{ blockerText }}</span>
          <span v-if="preflight.warnings?.length" class="preflight-warn">
            {{ warningText }}
          </span>
        </div>

        <div class="workbench-grid">
          <section class="panel input-panel card">
            <div class="panel-head">
              <div>
                <h2 class="panel-title">{{ t('video.workbench.inputTitle') }}</h2>
                <p class="panel-sub">{{ t('video.workbench.inputSub') }}</p>
              </div>
            </div>

            <label class="field">
              <span class="field-label">{{ t('video.workbench.prompt') }}</span>
              <textarea
                v-model="prompt"
                class="textarea"
                rows="3"
                maxlength="4000"
                :placeholder="t('video.workbench.promptPlaceholder')"
                @input="promptDirty = true"
              ></textarea>
              <span class="field-hint">{{ t('video.workbench.promptHint') }}</span>
            </label>

            <div class="upload-grid">
              <div
                class="drop-zone"
                :class="{ filled: project.source_video_url, busy: busy === 'source' }"
                @click="sourceInput?.click()"
                @dragover.prevent
                @drop.prevent="onDrop($event, 'source')"
              >
                <input ref="sourceInput" type="file" accept="video/mp4,video/quicktime,video/webm,.m4v" class="sr-only" @change="onSourcePicked" />
                <UploadCloud :size="20" :stroke-width="1.5" />
                <span class="drop-title">{{ project.source_video_url ? t('video.workbench.replaceVideo') : t('video.workbench.uploadVideo') }}</span>
                <span class="drop-sub">{{ t('video.workbench.videoHint') }}</span>
                <span v-if="project.source_video_url" class="drop-file">{{ sourceName }}</span>
                <span v-if="busy === 'source'" class="drop-file">{{ t('video.workbench.uploading') }}</span>
              </div>

              <div
                class="drop-zone"
                :class="{ filled: project.reference_face_urls?.length, busy: busy === 'face' }"
                @click="faceInput?.click()"
                @dragover.prevent
                @drop.prevent="onDrop($event, 'face')"
              >
                <input ref="faceInput" type="file" accept="image/png,image/jpeg,image/webp" class="sr-only" @change="onFacePicked" />
                <ScanFace :size="20" :stroke-width="1.5" />
                <span class="drop-title">{{ t('video.workbench.uploadFace') }}</span>
                <span class="drop-sub">{{ t('video.workbench.faceHint') }}</span>
                <span v-if="project.reference_face_urls?.length" class="face-strip">
                  <img v-for="url in project.reference_face_urls" :key="url" :src="url" alt="" class="face-thumb" />
                  <span class="drop-file">{{ project.reference_face_urls.length }}/4</span>
                </span>
                <span v-if="busy === 'face'" class="drop-file">{{ t('video.workbench.uploading') }}</span>
              </div>
            </div>

            <label class="field">
              <span class="field-label">{{ t('video.workbench.config') }}</span>
              <div class="config-line">
                <BaseSelect
                  :model-value="configId ?? ''"
                  :options="configOptions"
                  :placeholder="t('video.workbench.configPlaceholder')"
                  :searchable="false"
                  @update:model-value="changeConfig"
                />
                <NuxtLink to="/settings?tab=ai" class="btn btn-sm">{{ t('video.workbench.goSettings') }}</NuxtLink>
              </div>
              <span v-if="!configOptions.length" class="field-hint warn-text">{{ t('video.workbench.configMissing') }}</span>
              <span v-else class="field-hint">{{ selectedConfigName }}</span>
              <span v-if="routeSummary" class="field-hint route-hint">
                {{ t('video.workbench.routeUsing') }}：{{ routeSummary }}
              </span>
            </label>

            <div class="action-row">
              <button type="button" class="btn" :disabled="Boolean(busy) || isActive" @click="runPreflight">
                <ShieldCheck :size="13" /> {{ t('video.workbench.preflight') }}
              </button>
              <button type="button" class="btn" :disabled="Boolean(busy) || isActive || !project.source_video_url" @click="analyze">
                <Loader2 v-if="busy === 'analyze'" :size="13" class="animate-spin" />
                <Scissors v-else :size="13" />
                {{ busy === 'analyze' ? t('video.workbench.analyzing') : t('video.workbench.analyze') }}
              </button>
              <button type="button" class="btn" :disabled="Boolean(busy) || isActive || !canAiAnalyze" @click="aiAnalyze">
                <Loader2 v-if="busy === 'ai'" :size="13" class="animate-spin" />
                <WandSparkles v-else :size="13" />
                {{ busy === 'ai' ? t('video.workbench.aiAnalyzing') : t('video.workbench.aiAnalysis') }}
              </button>
            </div>

            <div class="shot-plan">
              <div class="section-line">
                <h3 class="section-title">{{ t('video.workbench.shots') }}</h3>
                <span v-if="shotsData?.run" class="tag">{{ t('video.workbench.chunkCount', { n: shotsData.run.total_chunks || 0 }) }}</span>
              </div>
              <p v-if="!displayShots.length" class="muted">{{ t('video.workbench.noShots') }}</p>
              <div v-for="shot in displayShots" :key="shot.id" class="shot-row">
                <div class="shot-head">
                  <span class="shot-name">{{ t('video.workbench.shot', { n: shot.shot_index + 1 }) }}</span>
                  <span class="shot-meta">{{ t('video.workbench.duration', { s: (shot.duration_ms / 1000).toFixed(1) }) }}</span>
                  <span class="tag">{{ t('video.workbench.chunkCount', { n: shot.chunks?.length || shot.chunk_count || 0 }) }}</span>
                  <span v-if="shot.status" class="shot-status">{{ statusLabel(shot.status) }}</span>
                </div>
                <div v-for="chunk in shot.chunks || []" :key="chunk.id" class="chunk-row">
                  <span class="chunk-index">{{ t('video.workbench.chunk', { n: chunk.chunk_index + 1 }) }}</span>
                  <span class="chunk-time mono">{{ ms(chunk.source_start_ms) }}–{{ ms(chunk.source_end_ms) }}</span>
                  <span class="chunk-overlap" v-if="chunk.overlap_before_ms">{{ t('video.workbench.overlap', { s: (chunk.overlap_before_ms / 1000).toFixed(1) }) }}</span>
                  <span class="chunk-status" :class="`is-${chunk.status}`">{{ statusLabel(chunk.status) }}</span>
                  <span v-if="chunk.seam_verdict" class="seam-pill" :class="chunk.seam_verdict">{{ t(`video.workbench.seam_${chunk.seam_verdict}`) }}</span>
                  <button
                    v-if="!isActive && (chunk.status === 'failed' || chunk.seam_verdict === 'warning')"
                    type="button"
                    class="btn btn-sm retry-btn"
                    @click="retryChunk(chunk.id)"
                  >
                    <RotateCcw :size="11" /> {{ t('video.workbench.retry') }}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section class="panel prompt-panel card">
            <div class="panel-head">
              <div>
                <h2 class="panel-title">{{ t('video.workbench.promptTitle') }}</h2>
                <p class="panel-sub">{{ t('video.workbench.promptSub') }}</p>
              </div>
              <button type="button" class="btn btn-sm" :disabled="!promptPlan || Boolean(busy) || isActive" @click="savePromptPlan">
                <Save :size="13" /> {{ t('video.workbench.savePrompt') }}
              </button>
            </div>

            <template v-if="promptPlan">
              <div v-for="person in promptPlan.people || []" :key="person.slot" class="prompt-person">
                <div class="person-head">
                  <span>{{ person.name || t('video.workbench.person', { n: person.slot }) }}</span>
                  <span class="tag">{{ t('video.workbench.caption') }}</span>
                </div>
                <textarea v-model="person.caption" class="textarea" rows="2" @input="promptDirty = true"></textarea>
              </div>

              <label class="field">
                <span class="field-label">{{ t('video.workbench.globalPrompt') }}</span>
                <textarea v-model="promptPlan.global_prompt" class="textarea" rows="2" @input="promptDirty = true"></textarea>
              </label>
              <label class="field">
                <span class="field-label">{{ t('video.workbench.negativePrompt') }}</span>
                <textarea v-model="promptPlan.negative_prompt" class="textarea" rows="2" @input="promptDirty = true"></textarea>
              </label>

              <div class="prompt-shot" v-for="shot in displayShots" :key="`prompt-${shot.id}`">
                <div class="person-head">
                  <span>{{ t('video.workbench.shot', { n: shot.shot_index + 1 }) }}</span>
                  <span class="tag">{{ t('video.workbench.shotPrompt') }}</span>
                </div>
                <textarea
                  v-if="project.mode === 'character'"
                  v-model="planShotFor(shot).scene_reference_prompt"
                  class="textarea"
                  rows="2"
                  :placeholder="t('video.workbench.scenePrompt')"
                  @input="promptDirty = true"
                ></textarea>
                <textarea
                  v-model="planShotFor(shot).final_prompt"
                  class="textarea"
                  rows="3"
                  :placeholder="t('video.workbench.finalPrompt')"
                  @input="promptDirty = true"
                ></textarea>
                <template v-if="project.mode === 'character'">
                  <div class="scene-ref-block">
                    <div class="scene-ref-head">
                      <span class="field-label">{{ t('video.workbench.sceneRef') }}</span>
                      <span v-if="shot.scene_reference_path" class="tag tag-success">{{ t('video.workbench.confirmed') }}</span>
                      <span v-else class="tag tag-error">{{ t('video.workbench.referenceNeeded') }}</span>
                    </div>
                    <div v-if="sceneCandidates(shot).length" class="candidate-grid">
                      <button
                        v-for="path in sceneCandidates(shot)"
                        :key="path"
                        type="button"
                        class="candidate"
                        :class="{ selected: shot.scene_reference_path === path }"
                        @click="confirmScene(shot, path)"
                      >
                        <img :src="`/${path}`" alt="" />
                        <span v-if="shot.scene_reference_path === path" class="candidate-check"><Check :size="12" /></span>
                      </button>
                    </div>
                    <p v-else class="muted">{{ t('video.workbench.sceneRefHint') }}</p>
                  </div>
                </template>
              </div>

              <div class="generation-row">
                <label class="field inline-field">
                  <span class="field-label">{{ t('video.workbench.seed') }}</span>
                  <input v-model.number="promptPlan.generation.seed" class="input mono" type="number" step="1" @input="promptDirty = true" />
                </label>
                <label class="field inline-field">
                  <span class="field-label">{{ t('video.workbench.steps') }}</span>
                  <input v-model.number="promptPlan.generation.steps" class="input mono" type="number" min="1" max="80" step="1" @input="promptDirty = true" />
                </label>
              </div>
            </template>
            <div v-else class="muted empty-prompt">
              <WandSparkles :size="22" :stroke-width="1.4" />
              <span>{{ t('video.workbench.noPrompt') }}</span>
            </div>
          </section>

          <section class="panel output-panel card">
            <div class="panel-head">
              <div>
                <h2 class="panel-title">{{ t('video.workbench.outputTitle') }}</h2>
                <p class="panel-sub">{{ t('video.workbench.outputSub') }}</p>
              </div>
              <div class="output-actions">
                <button
                  v-if="isActive"
                  type="button"
                  class="btn btn-sm danger-btn"
                  @click="cancelRun"
                >
                  <Square :size="12" /> {{ t('video.workbench.cancel') }}
                </button>
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  :disabled="!canGenerate || Boolean(busy)"
                  @click="generate"
                >
                  <Loader2 v-if="busy === 'generate'" :size="12" class="animate-spin" />
                  <Play v-else :size="12" />
                  {{ busy === 'generate' ? t('video.workbench.generating') : t('video.workbench.generate') }}
                </button>
              </div>
            </div>

            <div v-if="runStatus" class="progress-block">
              <div class="progress-line">
                <span>{{ statusLabel(runStatus) }}</span>
                <span class="mono">{{ runProgress }}%</span>
                <span v-if="runData?.completed_chunks !== undefined" class="muted">
                  {{ t('video.workbench.chunkProgress', { done: runData.completed_chunks || 0, total: runData.total_chunks || 0 }) }}
                </span>
              </div>
              <div class="progress-track"><i :style="{ width: `${runProgress}%` }"></i></div>
            </div>

            <div v-if="outputUrl" class="output-grid">
              <video class="output-video" :src="outputUrl" controls playsinline></video>
              <div class="output-side">
                <a v-if="outputUrl" class="btn btn-sm" :href="outputUrl" download>{{ t('video.workbench.download') }}</a>
                <div v-if="outputMeta" class="output-meta">
                  <span>{{ t('video.workbench.outputDuration', { s: (outputMeta.duration_ms / 1000).toFixed(2) }) }}</span>
                  <span>{{ outputMeta.width }}×{{ outputMeta.height }} · {{ outputMeta.fps?.toFixed?.(1) || outputMeta.fps }}fps</span>
                  <span>{{ t('video.workbench.outputFrames', { n: outputMeta.frame_count }) }}</span>
                  <span>{{ outputMeta.has_audio ? t('video.workbench.hasAudio') : t('video.workbench.silent') }}</span>
                </div>
                <div v-if="outputMeta?.warnings?.length" class="output-warnings">
                  <TriangleAlert :size="13" />
                  <span v-for="warning in outputMeta.warnings" :key="warning">{{ warning }}</span>
                </div>
              </div>
            </div>
            <div v-else class="empty-output">
              <Clapperboard :size="30" :stroke-width="1.3" />
              <p>{{ t('video.workbench.noOutput') }}</p>
            </div>

            <div v-if="runData?.error_message" class="run-error">
              <TriangleAlert :size="14" />
              <span>{{ runData.error_code || 'ERROR' }}：{{ runData.error_message }}</span>
            </div>

            <div class="lower-grid">
              <div class="seam-panel">
                <div class="section-line">
                  <h3 class="section-title">{{ t('video.workbench.seams') }}</h3>
                  <span class="tag">{{ seamRows.length }}</span>
                </div>
                <p v-if="!seamRows.length" class="muted">{{ t('video.workbench.noSeams') }}</p>
                <div v-for="row in seamRows" :key="`${row.shotId}-${row.chunk.id}`" class="seam-row">
                  <div class="seam-row-head">
                    <span>{{ t('video.workbench.shot', { n: row.shotIndex + 1 }) }} · {{ t('video.workbench.chunk', { n: row.chunk.chunk_index + 1 }) }}</span>
                    <span class="seam-pill" :class="row.chunk.seam_verdict">{{ t(`video.workbench.seam_${row.chunk.seam_verdict}`) }}</span>
                  </div>
                  <div class="seam-metrics">
                    <span>SSIM {{ fmt(row.chunk.seam_ssim) }}</span>
                    <span>{{ t('video.workbench.colorDelta') }} {{ fmt(row.chunk.seam_color_delta) }}</span>
                    <span>{{ t('video.workbench.faceSimilarity') }} {{ row.chunk.seam_face_similarity === null ? t('video.workbench.notDetected') : fmt(row.chunk.seam_face_similarity) }}</span>
                    <span v-if="row.chunk.retry_count">{{ t('video.workbench.retryCount', { n: row.chunk.retry_count }) }}</span>
                  </div>
                </div>
              </div>

              <div class="log-panel">
                <button type="button" class="log-toggle" @click="logsOpen = !logsOpen">
                  <ChevronDown :size="13" :class="{ rotated: !logsOpen }" />
                  {{ t('video.workbench.logs') }}
                  <span class="tag">{{ logs.length }}</span>
                </button>
                <div v-if="logsOpen" class="log-list">
                  <div v-if="!logs.length" class="muted">{{ t('video.workbench.noLogs') }}</div>
                  <div v-for="log in logs" :key="log.id" class="log-line" :class="`level-${log.level}`">
                    <span class="log-time mono">{{ timeOf(log.created_at) }}</span>
                    <span class="log-stage">{{ log.stage }}</span>
                    <span class="log-message">{{ log.message }}</span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </template>

      <div v-else class="loading-state">
        <span>{{ t('video.empty.loadFailed') }}</span>
        <button type="button" class="btn btn-sm" @click="refreshAll">{{ t('common.refresh') }}</button>
      </div>
    </main>

    <VideoCreateDialog v-model:open="createOpen" @created="onCreated" />
    <ConfirmDialog
      :open="Boolean(deleteTarget)"
      :title="t('video.deleteDialog.title')"
      :message="deleteMessage"
      :confirm-text="t('video.deleteDialog.confirm')"
      :loading="deleting"
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />
    <div v-if="renameTarget" class="overlay" @click.self="renameTarget = null">
      <div class="dialog" style="width:min(420px, calc(100vw - 40px))" role="dialog" aria-modal="true">
        <div class="dialog-head">
          <h2 class="dialog-title">{{ t('video.renameDialog.title') }}</h2>
          <button type="button" class="btn btn-icon btn-sm ml-auto" @click="renameTarget = null"><X :size="15" /></button>
        </div>
        <div class="dialog-body">
          <label class="field">
            <span class="field-label">{{ t('video.createDialog.titleLabel') }}</span>
            <input v-model.trim="renameTitle" class="input" maxlength="120" @keydown.enter.prevent="confirmRename" />
          </label>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" :disabled="saving" @click="renameTarget = null">{{ t('common.cancel') }}</button>
          <button type="button" class="btn btn-primary" :disabled="saving || !renameTitle.trim()" @click="confirmRename">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check, CheckCircle2, ChevronDown, Clapperboard, Loader2, PanelLeft, Play, RefreshCw,
  RotateCcw, Save, ScanFace, Scissors, ShieldCheck, Square, TriangleAlert, UploadCloud,
  WandSparkles, X,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { aiConfigAPI, videoAPI } from '~/composables/useApi'
import { useViewport } from '~/composables/useViewport'
import { useVisibilityPolling } from '~/composables/useVisibilityPolling'
import { toastError } from '~/composables/useToast'
import { videoSwapRouteText } from '~/utils/video-swap-route'
import VideoProjectList from '~/components/video/VideoProjectList.vue'
import VideoCreateDialog from '~/components/video/VideoCreateDialog.vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import BaseSelect from '~/components/BaseSelect.vue'

const { t, te } = useI18n()
const route = useRoute()
const router = useRouter()
const { isCompact } = useViewport()
const DEFAULT_FACE_PROMPT = "Faceswap. Replace the person's face with the reference face. Preserve original hair, body, clothing, pose, expression, camera, scene, lighting and audio timing. Natural skin, cinematic quality."

const id = computed(() => Number(route.params.id))
const loading = ref(true)
const refreshing = ref(false)
const deleting = ref(false)
const saving = ref(false)
const busy = ref('')
const error = ref('')
const drawerOpen = ref(false)
const createOpen = ref(false)
const project = ref<any>(null)
const projects = ref<any[]>([])
const projectsLoading = ref(false)
const configs = ref<any[]>([])
const configId = ref<number | null>(null)
const preflight = ref<any>(null)
const shotsData = ref<any>({ run: null, shots: [] })
const runDetails = ref<any>(null)
const runs = ref<any[]>([])
const selectedRunId = ref<number | null>(null)
const prompt = ref('')
const promptDirty = ref(false)
const promptPlan = ref<any>(null)
const logsOpen = ref(false)
const deleteTarget = ref<any | null>(null)
const renameTarget = ref<any | null>(null)
const renameTitle = ref('')
const sourceInput = ref<HTMLInputElement>()
const faceInput = ref<HTMLInputElement>()
let pollBusy = false
let lastStage = ''

const currentRunId = computed<number | null>(() => selectedRunId.value || project.value?.latest_run_id || shotsData.value?.run?.id || null)
const runOptions = computed(() => runs.value.map(item => ({
  label: `#${item.id} · ${statusLabel(item.status)}${item.merge_path ? ' · ✓' : ''}`,
  value: item.id,
})))
const runData = computed(() => runDetails.value?.run || shotsData.value?.run || null)
const runStatus = computed(() => runData.value?.status || project.value?.status || '')
const runProgress = computed(() => {
  if (runStatus.value === 'completed') return 100
  return Math.max(0, Math.min(100, Number(runData.value?.progress) || 0))
})
const isActive = computed(() => ['analyzing', 'probing', 'shot_detection', 'chunking', 'queued', 'submitting', 'generating', 'chunk_done', 'seam_check', 'shot_done', 'merging', 'postprocessing'].includes(runStatus.value))
const canAiAnalyze = computed(() => Boolean(currentRunId.value) && ['analyzed', 'prompt_ready', 'scene_ref_ready'].includes(runStatus.value))
const canGenerate = computed(() => {
  if (!currentRunId.value || !configId.value) return false
  if (['prompt_ready', 'completed', 'failed', 'cancelled'].includes(runStatus.value)) return true
  return project.value?.mode === 'face' && runStatus.value === 'analyzed'
})
const configOptions = computed(() => configs.value.map(item => ({ label: item.name || `${item.provider} · ${item.id}`, value: item.id })))
const selectedConfigName = computed(() => configs.value.find(item => item.id === configId.value)?.name || '')
const routeSummary = computed(() => {
  const route = preflight.value?.route
  if (!route) return ''
  return videoSwapRouteText(t as any, project.value?.mode === 'character' ? 'character' : 'face', route)
})
const outputUrl = computed(() => runData.value?.merge_path ? `/${runData.value.merge_path}` : null)
const outputMeta = computed(() => runData.value?.output_meta || null)
const logs = computed(() => Array.isArray(runDetails.value?.logs) ? runDetails.value.logs.slice(-200) : [])
const blockerText = computed(() => (preflight.value?.blockers || []).map((item: any) => item.message).join(t('common.listJoin')))
const warningText = computed(() => (preflight.value?.warnings || []).map((item: any) => item.message).join(t('common.listJoin')))
const deleteMessage = computed(() => t('video.deleteDialog.message', { title: deleteTarget.value?.title || '' }))
const sourceName = computed(() => {
  const path = project.value?.source_video_path || ''
  return path.split('/').pop() || path
})
const displayShots = computed(() => {
  const base = runDetails.value?.shots?.length ? runDetails.value.shots : (shotsData.value?.shots || [])
  return base.map((shot: any) => {
    const plan = planShotFor(shot)
    return { ...plan, ...shot, scene_reference_candidates: plan?.scene_reference_candidates || shot.scene_reference_candidates || [] }
  })
})
const seamRows = computed(() => {
  const rows: any[] = []
  for (const shot of displayShots.value) {
    for (const chunk of shot.chunks || []) {
      if (chunk.seam_verdict || chunk.seam_ssim !== null) rows.push({ shotId: shot.id, shotIndex: shot.shot_index, chunk })
    }
  }
  return rows
})

watch(() => runStatus.value, (value) => {
  if (value === 'failed') logsOpen.value = true
  if (value !== lastStage) {
    lastStage = value
    void loadPreflight()
  }
})

async function loadProjects() {
  projectsLoading.value = true
  try {
    const result = await videoAPI.list({ page_size: 100 })
    projects.value = Array.isArray(result?.items) ? result.items : []
  } finally {
    projectsLoading.value = false
  }
}

async function loadProject() {
  const value = await videoAPI.get(id.value)
  project.value = value
  prompt.value = value.prompt || (value.mode === 'face' ? DEFAULT_FACE_PROMPT : '')
  configId.value = value.config_id || null
  if (value.mode === 'character' && !promptDirty.value) promptDirty.value = false
}

async function loadConfigs() {
  try {
    const list = await aiConfigAPI.list('video-swap')
    configs.value = Array.isArray(list) ? list : []
    if (!configId.value || !configs.value.some(item => item.id === configId.value)) {
      configId.value = configs.value[0]?.id ?? null
    }
  } catch { configs.value = [] }
}

async function loadRuns() {
  try {
    const list = await videoAPI.runs(id.value)
    runs.value = Array.isArray(list) ? list : []
    if (!selectedRunId.value || !runs.value.some(item => item.id === selectedRunId.value)) {
      selectedRunId.value = runs.value[0]?.id || project.value?.latest_run_id || null
    }
  } catch { runs.value = [] }
}

async function loadPreflight() {
  if (!id.value) return
  try { preflight.value = await videoAPI.preflight(id.value) } catch { preflight.value = null }
}

async function loadPlan(runId?: number | null) {
  if (!runId) {
    shotsData.value = { run: null, shots: [] }
    runDetails.value = null
    return
  }
  const [plan, details] = await Promise.all([
    videoAPI.shots(id.value, runId),
    videoAPI.run(id.value, runId),
  ])
  shotsData.value = plan || { run: null, shots: [] }
  runDetails.value = details || null
  if (!promptDirty.value && shotsData.value?.run?.final_prompt_json) {
    promptPlan.value = JSON.parse(JSON.stringify(shotsData.value.run.final_prompt_json))
  }
}

async function refreshAll() {
  if (!id.value) return
  refreshing.value = true
  error.value = ''
  try {
    await Promise.all([loadProject(), loadProjects()])
    await loadConfigs()
    await loadRuns()
    await loadPlan(currentRunId.value)
    await loadPreflight()
  } catch (e: any) {
    error.value = e?.message || t('video.empty.loadFailed')
  } finally {
    refreshing.value = false
    loading.value = false
  }
}

async function poll() {
  if (pollBusy || !id.value) return
  pollBusy = true
  try {
    const value = await videoAPI.get(id.value)
    project.value = value
    const listItem = projects.value.find(item => item.id === value.id)
    if (listItem) {
      listItem.status = value.status
      listItem.latest_run = value.latest_run
      listItem.updated_at = value.updated_at
    }
    if (!promptDirty.value) prompt.value = value.prompt || ''
    await loadRuns()
    const runId = selectedRunId.value || value.latest_run_id
    if (runId) {
      const details = await videoAPI.run(id.value, runId)
      runDetails.value = details
      if (!promptDirty.value && ['analyzed', 'prompt_ready', 'scene_ref_ready'].includes(details.run?.status)) {
        shotsData.value = await videoAPI.shots(id.value, runId)
        if (shotsData.value?.run?.final_prompt_json) promptPlan.value = JSON.parse(JSON.stringify(shotsData.value.run.final_prompt_json))
      }
    }
  } catch {
    /* 轮询失败保留上一次状态 */
  } finally {
    pollBusy = false
  }
}

const polling = useVisibilityPolling(poll, 2500, { immediate: true })

onMounted(async () => {
  await refreshAll()
  polling.start()
})

watch(id, async (next, prev) => {
  if (!next || next === prev) return
  loading.value = true
  promptDirty.value = false
  promptPlan.value = null
  await refreshAll()
})

function statusLabel(value: string | null | undefined) {
  if (!value) return '—'
  const key = `video.runStatus.${value}`
  return te(key) ? t(key) : value
}

function planShotFor(shot: any) {
  if (!shot) return {}
  const plan = shotsData.value?.run?.final_prompt_json
  if (!plan) return shot.final_prompt_json || {}
  return (plan.shots || []).find((item: any) => Number(item.shot_id) === Number(shot.id))
    || (plan.shots || []).find((item: any) => Number(item.shot_index) === Number(shot.shot_index))
    || {}
}

function sceneCandidates(shot: any) {
  const plan = planShotFor(shot)
  return plan?.scene_reference_candidates || shot?.scene_reference_candidates || []
}

function ms(value: number | null | undefined) {
  const seconds = (Number(value) || 0) / 1000
  return `${seconds.toFixed(2)}s`
}

function fmt(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(3)
}

function timeOf(raw: string | null | undefined) {
  if (!raw) return ''
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

async function changeConfig(value: number | string) {
  configId.value = Number(value) || null
  if (!project.value) return
  try {
    await videoAPI.update(id.value, { config_id: configId.value })
    project.value = { ...project.value, config_id: configId.value }
    await loadPreflight()
  } catch (e) {
    toastError(e)
  }
}

function onSourcePicked(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) void uploadSource(file)
  ;(event.target as HTMLInputElement).value = ''
}

function onFacePicked(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) void uploadFace(file)
  ;(event.target as HTMLInputElement).value = ''
}

function onDrop(event: DragEvent, kind: 'source' | 'face') {
  const file = event.dataTransfer?.files?.[0]
  if (file) void (kind === 'source' ? uploadSource(file) : uploadFace(file))
}

async function uploadSource(file: File) {
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|m4v)$/i.test(file.name)) {
    toast.warning(t('video.workbench.videoFormat'))
    return
  }
  if (file.size > 256 * 1024 * 1024) {
    toast.warning(t('video.workbench.videoTooLarge'))
    return
  }
  busy.value = 'source'
  try {
    await videoAPI.uploadSource(id.value, file)
    toast.success(t('video.workbench.uploaded'))
    await refreshAll()
  } catch (e) {
    toastError(e)
  } finally {
    busy.value = ''
  }
}

async function uploadFace(file: File) {
  if (!file.type.startsWith('image/')) {
    toast.warning(t('video.workbench.faceFormat'))
    return
  }
  if (file.size > 20 * 1024 * 1024) {
    toast.warning(t('video.workbench.faceTooLarge'))
    return
  }
  busy.value = 'face'
  try {
    await videoAPI.uploadFace(id.value, file)
    toast.success(t('video.workbench.uploaded'))
    await refreshAll()
  } catch (e) {
    toastError(e)
  } finally {
    busy.value = ''
  }
}

async function runPreflight() {
  try {
    preflight.value = await videoAPI.preflight(id.value)
    toast.success(preflight.value?.ok ? t('video.workbench.preflightOk') : t('video.workbench.preflightFailed'))
  } catch (e) {
    toastError(e)
  }
}

async function saveProjectField() {
  await videoAPI.update(id.value, { prompt: prompt.value, config_id: configId.value })
  promptDirty.value = false
}

async function analyze() {
  busy.value = 'analyze'
  try {
    await saveProjectField()
    const result = await videoAPI.analyze(id.value)
    if (result?.run_id) selectedRunId.value = result.run_id
    toast.success(t('video.workbench.analysisStarted'))
    await poll()
  } catch (e) {
    toastError(e)
  } finally {
    busy.value = ''
  }
}

async function aiAnalyze() {
  if (!currentRunId.value) return
  busy.value = 'ai'
  try {
    await saveProjectField()
    const result = await videoAPI.aiAnalysis(id.value)
    if (result?.run_id) selectedRunId.value = result.run_id
    toast.success(t('video.workbench.aiStarted'))
    await poll()
  } catch (e) {
    toastError(e)
  } finally {
    busy.value = ''
  }
}

function selectRun(value: number | string) {
  selectedRunId.value = Number(value) || null
  promptDirty.value = false
  promptPlan.value = null
  void loadPlan(selectedRunId.value)
}

async function savePromptPlan() {
  if (!promptPlan.value) return
  saving.value = true
  try {
    await saveProjectField()
    await videoAPI.savePrompt(id.value, { run_id: currentRunId.value, ...promptPlan.value })
    promptDirty.value = false
    toast.success(t('video.workbench.promptSaved'))
    await loadPlan(currentRunId.value)
    await poll()
  } catch (e) {
    toastError(e)
  } finally {
    saving.value = false
  }
}

async function confirmScene(shot: any, path: string) {
  try {
    await videoAPI.confirmSceneReference(id.value, shot.id, path)
    toast.success(t('video.workbench.confirmed'))
    await loadPlan(currentRunId.value)
    await loadPreflight()
  } catch (e) {
    toastError(e)
  }
}

async function generate() {
  if (project.value?.mode === 'character' && displayShots.value.some((shot: any) => !shot.scene_reference_path)) {
    toast.warning(t('video.workbench.referenceNeeded'))
    return
  }
  busy.value = 'generate'
  try {
    await saveProjectField()
    if (promptDirty.value) await savePromptPlan()
    const result = await videoAPI.generate(id.value, currentRunId.value || undefined)
    if (result?.run_id) selectedRunId.value = result.run_id
    toast.success(t('video.workbench.generationStarted'))
    await poll()
    logsOpen.value = true
  } catch (e) {
    toastError(e)
  } finally {
    busy.value = ''
  }
}

async function cancelRun() {
  if (!currentRunId.value) return
  try {
    await videoAPI.cancel(id.value, currentRunId.value)
    toast.warning(t('video.workbench.cancelled'))
    await poll()
  } catch (e) {
    toastError(e)
  }
}

async function retryChunk(chunkId: number) {
  try {
    await videoAPI.retryChunk(id.value, chunkId)
    toast.success(t('video.workbench.retryStarted'))
    await poll()
  } catch (e) {
    toastError(e)
  }
}

function selectProject(value: any) {
  drawerOpen.value = false
  if (Number(value.id) === id.value) return
  router.push(`/videos/${value.id}`)
}

function onCreated(value: any) {
  createOpen.value = false
  if (value?.id) router.push(`/videos/${value.id}`)
}

function startRename(value: any) {
  renameTarget.value = value
  renameTitle.value = value.title
}

async function confirmRename() {
  if (!renameTarget.value || !renameTitle.value.trim()) return
  saving.value = true
  try {
    await videoAPI.update(renameTarget.value.id, { title: renameTitle.value.trim() })
    toast.success(t('common.saved'))
    renameTarget.value = null
    await refreshAll()
  } catch (e) {
    toastError(e)
  } finally {
    saving.value = false
  }
}

async function duplicateProject(value: any) {
  try {
    const created = await videoAPI.duplicate(value.id)
    toast.success(t('video.menu.duplicated'))
    await loadProjects()
    if (created?.id) router.push(`/videos/${created.id}`)
  } catch (e) {
    toastError(e)
  }
}

async function confirmDelete() {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  try {
    await videoAPI.del(target.id)
    toast.success(t('video.deleteDialog.deleted'))
    deleteTarget.value = null
    await loadProjects()
    if (Number(target.id) === id.value || !projects.value.length) router.push('/videos')
  } catch (e) {
    toastError(e)
  } finally {
    deleting.value = false
  }
}
</script>

<style scoped>
.video-workbench { display: flex; height: 100%; min-height: 0; position: relative; background: var(--surface-base); }
.video-rail-wrap { display: flex; min-height: 0; }
.video-main { flex: 1; min-width: 0; overflow-y: auto; padding: 18px 22px 40px; }
.loading-state { min-height: 300px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-3); font-size: 12px; }
.workbench-head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 10px; }
.head-project { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.head-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.project-title { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -.02em; color: var(--text-0); }
.mode-pill { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-0); color: var(--text-2); font-size: 10px; }
.route-hint { color: var(--accent); }
.status-pill { padding: 2px 8px; border-radius: 999px; font-size: 10px; background: var(--bg-1); color: var(--text-2); }
.status-pill.is-completed { background: var(--success-bg); color: var(--success); }
.status-pill.is-failed { background: var(--action-danger-bg); color: var(--action-danger); }
.status-pill.is-generating, .status-pill.is-analyzing { background: var(--accent-bg); color: var(--accent-text); }
.project-intro { margin: 5px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--text-3); }

.head-actions { margin-left: auto; display: flex; align-items: center; gap: 7px; flex-shrink: 0; }
.run-version-select { width: 150px; }
.run-version-select :deep(.base-select-trigger) { min-height: 30px; font-size: 10.5px; }
.run-id { color: var(--text-3); font-size: 10.5px; }
.error-banner { display: flex; align-items: center; gap: 8px; padding: 9px 12px; color: var(--action-danger); margin-bottom: 10px; }
.error-banner .btn { margin-left: auto; }
.preflight-strip { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 8px 12px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-0); font-size: 11.5px; color: var(--text-2); margin-bottom: 12px; }
.preflight-strip.ok { border-color: color-mix(in srgb, var(--success) 30%, var(--border)); }
.preflight-strip.bad { border-color: color-mix(in srgb, var(--action-danger) 30%, var(--border)); color: var(--action-danger); }
.preflight-warn { color: var(--text-3); }
.workbench-grid { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(0, .92fr); gap: 12px; align-items: start; }
.panel { padding: 14px; min-width: 0; }
.panel-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; }
.panel-title { margin: 0; font-size: 13px; font-weight: 650; color: var(--text-0); }
.panel-sub { margin: 3px 0 0; font-size: 10.5px; line-height: 1.5; color: var(--text-3); }
.panel-head > .btn { margin-left: auto; flex-shrink: 0; }
.panel-head > .output-actions { margin-left: auto; display: flex; gap: 6px; }
.upload-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 4px 0 12px; }
.drop-zone { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; min-height: 126px; padding: 10px; border: 1px dashed var(--border-strong); border-radius: var(--radius); background: var(--bg-0); color: var(--text-3); text-align: center; cursor: pointer; transition: border-color .15s, background .15s; }
.drop-zone:hover { border-color: var(--accent); background: var(--accent-bg); }
.drop-zone.filled { border-style: solid; border-color: var(--border); }
.drop-title { color: var(--text-1); font-size: 12px; font-weight: 600; }
.drop-sub { font-size: 10px; line-height: 1.45; }
.drop-file { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--accent-text); font-size: 10.5px; }
.face-strip { display: flex; align-items: center; gap: 3px; }
.face-thumb { width: 22px; height: 22px; border-radius: 5px; object-fit: cover; border: 1px solid var(--border); }
.config-line { display: flex; gap: 7px; align-items: center; }
.config-line :deep(.base-select) { flex: 1; min-width: 0; }
.warn-text { color: var(--action-danger); }
.action-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 14px; }
.shot-plan { border-top: 1px solid var(--border); padding-top: 12px; }
.section-line { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; }
.section-title { margin: 0; font-size: 12px; font-weight: 650; color: var(--text-0); }
.shot-row { padding: 8px 0; border-bottom: 1px solid var(--border); }
.shot-row:last-child { border-bottom: 0; }
.shot-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.shot-name { font-size: 12px; font-weight: 600; color: var(--text-1); }
.shot-meta { font-size: 10.5px; color: var(--text-3); }
.shot-status { margin-left: auto; font-size: 10px; color: var(--text-3); }
.chunk-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 4px 0 4px 12px; font-size: 10.5px; color: var(--text-3); }
.chunk-index { color: var(--text-2); }
.chunk-time { font-size: 10px; }
.chunk-overlap { color: var(--text-3); }
.chunk-status.is-completed { color: var(--success); }
.chunk-status.is-failed { color: var(--action-danger); }
.chunk-status.is-generating, .chunk-status.is-seam_check { color: var(--accent-text); }
.seam-pill { padding: 1px 6px; border-radius: 999px; font-size: 9.5px; }
.seam-pill.ok { background: var(--success-bg); color: var(--success); }
.seam-pill.warning { background: var(--action-warning-bg, var(--accent-bg)); color: var(--action-warning, var(--accent-text)); }
.retry-btn { margin-left: auto; }
.prompt-person, .prompt-shot { padding: 8px 0; border-bottom: 1px solid var(--border); }
.prompt-person:last-child, .prompt-shot:last-child { border-bottom: 0; }
.person-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 5px; color: var(--text-2); font-size: 11px; font-weight: 600; }
.prompt-shot .textarea { margin-top: 5px; }
.scene-ref-block { margin-top: 7px; padding: 8px; border-radius: var(--radius); background: var(--bg-0); border: 1px solid var(--border); }
.scene-ref-head { display: flex; align-items: center; gap: 7px; }
.candidate-grid { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.candidate { position: relative; padding: 0; border: 2px solid transparent; border-radius: 6px; overflow: hidden; background: var(--bg-1); cursor: pointer; }
.candidate img { display: block; width: 92px; height: 56px; object-fit: cover; }
.candidate.selected { border-color: var(--accent); }
.candidate-check { position: absolute; right: 3px; bottom: 3px; width: 17px; height: 17px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--accent); color: var(--on-accent); }
.generation-row { display: flex; gap: 10px; margin-top: 10px; }
.inline-field { flex: 1; min-width: 0; }
.empty-prompt { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 160px; }
.progress-block { padding: 9px 10px; border-radius: var(--radius); background: var(--bg-0); border: 1px solid var(--border); margin-bottom: 10px; }
.progress-line { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-2); }
.progress-line .mono { margin-left: auto; }
.progress-track { height: 5px; margin-top: 7px; border-radius: 999px; background: var(--bg-1); overflow: hidden; }
.progress-track i { display: block; height: 100%; background: var(--accent-gradient); transition: width .3s var(--ease-out); }
.output-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(170px, .65fr); gap: 10px; margin-bottom: 10px; }
.output-video { width: 100%; aspect-ratio: 16/9; border-radius: var(--radius); background: #000; object-fit: contain; }
.output-side { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.output-meta { display: flex; flex-direction: column; gap: 3px; color: var(--text-3); font-size: 10.5px; }
.output-warnings { display: flex; flex-direction: column; gap: 3px; color: var(--action-warning, var(--accent-text)); font-size: 10.5px; }
.empty-output { min-height: 150px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--text-3); font-size: 11.5px; border: 1px dashed var(--border); border-radius: var(--radius); background: var(--bg-0); }
.empty-output p { margin: 0; }
.run-error { display: flex; gap: 7px; align-items: flex-start; padding: 8px 10px; margin-top: 8px; border-radius: var(--radius); background: var(--action-danger-bg); color: var(--action-danger); font-size: 11px; }
.lower-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
.seam-panel, .log-panel { min-width: 0; border-top: 1px solid var(--border); padding-top: 10px; }
.seam-row { padding: 6px 0; border-bottom: 1px solid var(--border); }
.seam-row-head { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--text-2); }
.seam-row-head .seam-pill { margin-left: auto; }
.seam-metrics { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 3px; font-size: 10px; color: var(--text-3); }
.log-toggle { display: inline-flex; align-items: center; gap: 5px; border: 0; background: none; color: var(--text-1); font-size: 12px; font-weight: 650; cursor: pointer; padding: 0 0 8px; }
.log-toggle .rotated { transform: rotate(-90deg); }
.log-list { max-height: 220px; overflow-y: auto; border-radius: var(--radius); background: var(--bg-0); border: 1px solid var(--border); padding: 6px 8px; }
.log-line { display: grid; grid-template-columns: 54px 74px minmax(0, 1fr); gap: 6px; align-items: baseline; font-size: 10px; line-height: 1.55; color: var(--text-2); padding: 2px 0; }
.log-time { color: var(--text-3); }
.log-stage { color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-message { overflow-wrap: anywhere; }
.log-line.level-warn .log-message { color: var(--action-warning, var(--accent-text)); }
.log-line.level-error .log-message { color: var(--action-danger); }
.muted { color: var(--text-3); font-size: 11px; line-height: 1.6; }
.danger-btn { color: var(--action-danger); }
.drawer-toggle { position: absolute; z-index: 5; top: 8px; left: 8px; }
.drawer-scrim { position: fixed; inset: 0; z-index: 30; background: var(--scrim); }
.video-workbench.compact .video-rail-wrap { position: fixed; z-index: 40; inset: var(--safe-top) auto 0 0; width: min(300px, 88vw); transform: translateX(-102%); transition: transform .2s var(--ease-out); box-shadow: var(--shadow-elevated); }
.video-workbench.compact .video-rail-wrap.open { transform: translateX(0); }
.video-workbench.compact .video-main { padding: 46px 12px 32px; }
.video-workbench.compact .workbench-grid, .video-workbench.compact .lower-grid { grid-template-columns: 1fr; }
@media (max-width: 900px) {
  .video-main { padding: 16px 14px 32px; }
  .workbench-grid { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .upload-grid, .output-grid { grid-template-columns: 1fr; }
  .output-actions { flex-wrap: wrap; }
  .project-title { font-size: 16px; }
}
</style>
