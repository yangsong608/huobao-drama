<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Loader2, X } from 'lucide-vue-next'
import type { DirectorApplyField, DirectorApplyResult } from '~/composables/useApi'

interface ApplyShotLike {
  storyboard_id: number
  shot_number: number
  duration_sec: number
  board_duration?: number
  has_video?: boolean
  dirty_fields?: string[]
}

const props = defineProps<{
  shots: ApplyShotLike[]
  applySettings: { fields: DirectorApplyField[]; promptAppend: boolean; subshotSync: boolean; fps: number }
  baseVersion: number
  mismatchedShots: number[]
  canApply: boolean
  applyBlockedReason?: string
  applying: boolean
  unsavedPlan?: boolean
  result: DirectorApplyResult | null
  error: { message?: string; code?: string; status?: number; data?: any } | null
}>()

const emit = defineEmits<{
  close: []
  apply: [payload: {
    storyboard_ids: number[]
    fields: DirectorApplyField[]
    append_prompt: boolean
    sync_subshots: boolean
  }]
  reload: []
  realign: []
  'view-storyboards': []
}>()

const { t } = useI18n()

const ALL_FIELDS: DirectorApplyField[] = ['shot_type', 'angle', 'movement', 'duration']

const availableFields = computed(() => new Set(props.applySettings.fields))
const selectedIds = ref<number[]>([])
const selectedFields = ref<DirectorApplyField[]>([])
const appendPrompt = ref(false)
const syncSubshots = ref(false)

const selectedShots = computed(() => props.shots.filter((shot) => selectedIds.value.includes(Number(shot.storyboard_id))))
const selectedHasVideo = computed(() => selectedShots.value.filter((shot) => shot.has_video).length)
const mismatchedSelected = computed(() => props.shots
  .filter((shot) => selectedIds.value.includes(Number(shot.storyboard_id)))
  .filter((shot) => props.mismatchedShots.includes(Number(shot.shot_number))))
const submitCount = computed(() => selectedIds.value.length)
const isResult = computed(() => Boolean(props.result))

function initDefaults(): void {
  const dirtyShots = props.shots.filter((shot) => (shot.dirty_fields || []).length > 0)
  selectedIds.value = dirtyShots.map((shot) => Number(shot.storyboard_id))
  const union = new Set<string>()
  for (const shot of dirtyShots) {
    for (const field of shot.dirty_fields || []) union.add(field)
  }
  selectedFields.value = props.applySettings.fields.filter((field) => union.has(field))
  appendPrompt.value = false
  syncSubshots.value = false
}

onMounted(initDefaults)

function fieldDirtyCount(field: DirectorApplyField): number {
  return props.shots.filter((shot) => (shot.dirty_fields || []).includes(field)).length
}

function toggleShot(id: number): void {
  if (props.applying) return
  const index = selectedIds.value.indexOf(id)
  if (index >= 0) selectedIds.value.splice(index, 1)
  else selectedIds.value.push(id)
}

function toggleField(field: DirectorApplyField): void {
  if (props.applying || !availableFields.value.has(field)) return
  const index = selectedFields.value.indexOf(field)
  if (index >= 0) selectedFields.value.splice(index, 1)
  else selectedFields.value.push(field)
}

function toggleAll(): void {
  if (props.applying) return
  selectedIds.value = selectedIds.value.length === props.shots.length
    ? []
    : props.shots.map((shot) => Number(shot.storyboard_id))
}

function alignDuration(durationSec: number): { frames: number; seconds: number } {
  const fps = props.applySettings.fps > 0 ? props.applySettings.fps : 24
  const desired = Math.max(1, Math.round(Number(durationSec) * fps))
  const frames = desired <= 5 ? 5 : Math.max(0, Math.round((desired - 5) / 17)) * 17 + 5
  return { frames, seconds: Math.round((frames / fps) * 100) / 100 }
}

function durationText(value: unknown): string {
  const num = Number(value)
  return Number.isFinite(num) ? t('director.inspector.seconds', { n: Math.round(num * 100) / 100 }) : '—'
}

function fieldLabel(field: string): string {
  const key = `director.apply.field.${field}`
  const label = t(key)
  return label === key ? field : label
}

const blockedReason = computed(() => {
  if (props.applying) return t('director.apply.blockedApplying')
  if (!props.canApply) return props.applyBlockedReason || t('director.apply.blockedReadonly')
  if (mismatchedSelected.value.length > 0) return t('director.apply.blockedMismatch')
  if (!selectedIds.value.length) return t('director.apply.blockedNoShots')
  if (!selectedFields.value.length) return t('director.apply.blockedNoFields')
  return ''
})

const conflictBlocksSubmit = computed(() => {
  const code = String(props.error?.code || '')
  return code === 'DIRECTOR_STORYBOARD_CONFLICT' || code === 'DIRECTOR_VERSION_CONFLICT'
})
const canSubmit = computed(() => !blockedReason.value && !props.applying && !conflictBlocksSubmit.value)

const conflictData = computed<Record<string, any> | null>(() => {
  if (!props.error || String(props.error.code || '') !== 'DIRECTOR_STORYBOARD_CONFLICT') return null
  return props.error.data || {}
})

const subshotConflict = computed<Record<string, any> | null>(() => {
  if (!props.error || String(props.error.code || '') !== 'DIRECTOR_SUBSHOT_CONFLICT') return null
  return props.error.data || {}
})

const conflictShots = computed<any[]>(() => (
  Array.isArray(conflictData.value?.conflicts) ? conflictData.value?.conflicts : []
))

const errorMessage = computed(() => {
  const error = props.error
  if (!error) return ''
  const code = String(error.code || '')
  if (code === 'DIRECTOR_STORYBOARD_CONFLICT') return t('director.apply.conflictDesc')
  if (code === 'DIRECTOR_VERSION_CONFLICT') return t('director.apply.versionConflictDesc')
  if (code === 'DIRECTOR_SUBSHOT_CONFLICT') return t('director.apply.subshotConflictDesc')
  if (code === 'DIRECTOR_APPLY_DISABLED') return t('director.apply.applyDisabledDesc')
  return String(error.message || t('director.apply.errorDesc'))
})

const canReload = computed(() => {
  const code = String(props.error?.code || '')
  return code === 'DIRECTOR_STORYBOARD_CONFLICT' || code === 'DIRECTOR_VERSION_CONFLICT' || code === 'DIRECTOR_SUBSHOT_CONFLICT'
})

const canRealign = computed(() => String(props.error?.code || '') === 'DIRECTOR_STORYBOARD_CONFLICT')

function conflictReasonLabel(reason: unknown): string {
  const key = `director.apply.conflictReason.${String(reason || '')}`
  const label = t(key)
  return label === key ? String(reason || '') : label
}

function submit(): void {
  if (!canSubmit.value) return
  emit('apply', {
    storyboard_ids: [...selectedIds.value],
    fields: [...selectedFields.value],
    append_prompt: appendPrompt.value,
    sync_subshots: syncSubshots.value,
  })
}

function requestClose(): void {
  if (props.applying) return
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') requestClose()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

const resultApplied = computed(() => {
  const ids = props.result?.applied || []
  return props.shots.filter((shot) => ids.includes(Number(shot.storyboard_id)))
})
const resultSkipped = computed(() => {
  const ids = props.result?.skipped || []
  return props.shots.filter((shot) => ids.includes(Number(shot.storyboard_id)))
})
const resultStale = computed(() => {
  const ids = props.result?.stale || []
  return props.shots.filter((shot) => ids.includes(Number(shot.storyboard_id)))
})

function snapshotOf(id: number) {
  return props.result?.snapshots.find((item) => Number(item.storyboard_id) === Number(id)) || null
}

function snapshotKeys(snapshot: { before: Record<string, unknown>; after: Record<string, unknown> }): string[] {
  const keys = new Set([...Object.keys(snapshot.before || {}), ...Object.keys(snapshot.after || {})])
  keys.delete('duration_frames')
  return [...keys]
}

function writtenFields(id: number): string[] {
  const snapshot = snapshotOf(id)
  if (!snapshot) return []
  return snapshotKeys(snapshot)
}

function cellText(snapshot: { before: Record<string, unknown>; after: Record<string, unknown> }, side: 'before' | 'after', key: string): string {
  if (key === 'duration') {
    const value = snapshot[side]?.duration
    if (value == null) return '—'
    if (side === 'after' && snapshot.after?.duration_frames != null) {
      return `${durationText(value)} · ${t('director.apply.frames', { n: Number(snapshot.after.duration_frames) })}`
    }
    return durationText(value)
  }
  const value = snapshot[side]?.[key]
  if (value == null || value === '') return '—'
  return String(value)
}

function snapshotIsLong(snapshot: { before: Record<string, unknown>; after: Record<string, unknown> }): boolean {
  return snapshotKeys(snapshot).some((key) => (
    String(snapshot.before?.[key] ?? '').length > 90 || String(snapshot.after?.[key] ?? '').length > 90
  ))
}

function skipReason(id: number): string {
  const detail = props.result?.skipped_details.find((item) => Number(item.storyboard_id) === Number(id))
  if (!detail) return t('director.apply.reasonSameValue')
  const reason = String(detail.reason || '')
  if (reason === '字段值未变化') return t('director.apply.reasonSameValue')
  if (reason === '提示词已含【机位】标记') return t('director.apply.reasonMarkerExists')
  if (reason === '子镜头描述未变化') return t('director.apply.reasonDescriptionUnchanged')
  if (reason === '字段未选') return t('director.apply.reasonNotSelected')
  return reason || t('director.apply.reasonSameValue')
}
</script>

<template>
  <Teleport to="body">
    <div class="director-apply-mask" @click.self="requestClose">
      <section class="director-apply" role="dialog" :aria-label="t('director.apply.title')">
        <header class="director-apply-head">
          <div class="director-apply-title">
            <b>{{ isResult ? t('director.apply.resultTitle') : t('director.apply.title') }}</b>
            <span v-if="!isResult" class="director-apply-version">{{ t('director.apply.baseVersion', { version: props.baseVersion }) }}</span>
          </div>
          <button type="button" class="director-apply-close" :aria-label="t('director.apply.close')" :disabled="props.applying" @click="requestClose">
            <X :size="14" />
          </button>
        </header>

        <div class="director-apply-body">
          <template v-if="isResult && props.result">
            <p class="director-apply-subtitle">{{ t('director.apply.resultSubtitle') }}</p>

            <div class="director-result-summary">
              <span class="is-applied">{{ t('director.apply.resultApplied') }} {{ props.result.applied.length }}</span>
              <span class="is-skipped">{{ t('director.apply.resultSkipped') }} {{ props.result.skipped.length }}</span>
              <span class="is-stale">{{ t('director.apply.resultStale') }} {{ props.result.stale.length }}</span>
            </div>

            <section class="director-result-group">
              <h4>{{ t('director.apply.resultApplied') }}</h4>
              <p v-if="!resultApplied.length" class="director-result-empty">{{ t('director.apply.resultNone') }}</p>
              <ul v-else class="director-result-list">
                <li v-for="shot in resultApplied" :key="`applied-${shot.storyboard_id}`">
                  <span class="director-result-shot">{{ t('director.shotList.shot', { n: shot.shot_number }) }}</span>
                  <span class="director-result-fields">
                    <span v-for="field in writtenFields(Number(shot.storyboard_id))" :key="field" class="director-result-chip">
                      {{ fieldLabel(field) }}
                    </span>
                  </span>
                  <span v-if="(props.result.stale || []).includes(Number(shot.storyboard_id))" class="director-result-stale">
                    {{ t('director.apply.needsRegenerate') }}
                  </span>
                </li>
              </ul>
            </section>

            <section class="director-result-group">
              <h4>{{ t('director.apply.resultSkipped') }}</h4>
              <p v-if="!resultSkipped.length" class="director-result-empty">{{ t('director.apply.noneSkipped') }}</p>
              <ul v-else class="director-result-list">
                <li v-for="shot in resultSkipped" :key="`skipped-${shot.storyboard_id}`">
                  <span class="director-result-shot">{{ t('director.shotList.shot', { n: shot.shot_number }) }}</span>
                  <span class="director-result-reason">{{ skipReason(Number(shot.storyboard_id)) }}</span>
                </li>
              </ul>
            </section>

            <section v-if="resultStale.length" class="director-result-group">
              <h4>{{ t('director.apply.resultStale') }}</h4>
              <div class="director-result-stale-list">
                <span v-for="shot in resultStale" :key="`stale-${shot.storyboard_id}`" class="director-result-stale">
                  {{ t('director.shotList.shot', { n: shot.shot_number }) }}
                </span>
              </div>
              <p class="director-result-hint">{{ t('director.apply.staleHint') }}</p>
            </section>

            <section v-if="props.result.snapshots.length" class="director-result-group">
              <h4>{{ t('director.apply.snapshots') }}</h4>
              <details
                v-for="snapshot in props.result.snapshots"
                :key="`snapshot-${snapshot.storyboard_id}`"
                class="director-snapshot"
                :open="!snapshotIsLong(snapshot)"
              >
                <summary>
                  {{ t('director.shotList.shot', { n: snapshot.storyboard_number }) }}
                  <span class="director-snapshot-fields">
                    <span v-for="key in snapshotKeys(snapshot)" :key="key">{{ fieldLabel(key) }}</span>
                  </span>
                </summary>
                <table class="director-snapshot-table">
                  <thead>
                    <tr>
                      <th>{{ t('director.apply.fieldName') }}</th>
                      <th>{{ t('director.apply.before') }}</th>
                      <th>{{ t('director.apply.after') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="key in snapshotKeys(snapshot)" :key="key">
                      <td>{{ fieldLabel(key) }}</td>
                      <td>{{ cellText(snapshot, 'before', key) }}</td>
                      <td>{{ cellText(snapshot, 'after', key) }}</td>
                    </tr>
                  </tbody>
                </table>
              </details>
            </section>

            <section v-if="props.result.warnings.length" class="director-apply-warnings">
              <div class="director-apply-warning-title">
                <AlertTriangle :size="13" />
                <b>{{ t('director.apply.warningsTitle') }}</b>
              </div>
              <ul>
                <li v-for="(warning, index) in props.result.warnings" :key="index">{{ warning }}</li>
              </ul>
            </section>
          </template>

          <template v-else>
            <p class="director-apply-subtitle">{{ t('director.apply.subtitle') }}</p>

            <section v-if="props.error" class="director-apply-error" role="alert">
              <div class="director-apply-warning-title">
                <AlertTriangle :size="13" />
                <b>{{ t('director.apply.errorTitle') }}</b>
              </div>
              <p>{{ errorMessage }}</p>
              <p v-if="subshotConflict" class="director-subshot-detail">
                {{ t('director.apply.subshotConflictDetail', {
                  plan: subshotConflict.plan_subshots ?? '—',
                  markers: subshotConflict.description_markers ?? '—',
                }) }}
              </p>
              <ul v-if="conflictShots.length" class="director-conflict-list">
                <li v-for="item in conflictShots" :key="`${item.storyboard_id}-${item.reason}`">
                  <span>{{ t('director.shotList.shot', { n: item.storyboard_number }) }}</span>
                  <span class="director-conflict-reason">{{ conflictReasonLabel(item.reason) }}</span>
                </li>
              </ul>
              <button v-if="canRealign" type="button" class="director-apply-btn is-primary" @click="emit('realign')">
                {{ t('director.apply.realign') }}
              </button>
              <button v-if="canReload" type="button" class="director-apply-btn" @click="emit('reload')">
                {{ t('director.apply.reload') }}
              </button>
            </section>

            <section v-if="mismatchedSelected.length || selectedHasVideo || props.unsavedPlan" class="director-apply-warnings">
              <div class="director-apply-warning-title">
                <AlertTriangle :size="13" />
                <b>{{ t('director.apply.warningsTitle') }}</b>
              </div>
              <ul>
                <li v-if="props.unsavedPlan">{{ t('director.apply.warningUnsaved') }}</li>
                <li v-for="shot in mismatchedSelected" :key="`mismatch-${shot.storyboard_id}`">
                  {{ t('director.apply.warningMismatch', { n: shot.shot_number }) }}
                </li>
                <li v-if="selectedHasVideo">{{ t('director.apply.warningHasVideo', { count: selectedHasVideo }) }}</li>
              </ul>
            </section>

            <div class="director-apply-grid">
              <section class="director-apply-panel">
                <div class="director-apply-panel-head">
                  <b>{{ t('director.apply.shotsTitle') }}</b>
                  <button type="button" class="director-apply-link" :disabled="props.applying || !props.shots.length" @click="toggleAll">
                    {{ selectedIds.length === props.shots.length ? t('director.apply.clearAll') : t('director.apply.selectAll') }}
                  </button>
                </div>
                <p class="director-apply-hint">{{ t('director.apply.shotsHint') }}</p>
                <div class="director-apply-shot-list">
                  <button
                    v-for="shot in props.shots"
                    :key="`apply-shot-${shot.storyboard_id}`"
                    type="button"
                    :class="['director-apply-shot', { active: selectedIds.includes(Number(shot.storyboard_id)) }]"
                    :disabled="props.applying"
                    @click="toggleShot(Number(shot.storyboard_id))"
                  >
                    <span class="director-apply-check" aria-hidden="true">
                      <span v-if="selectedIds.includes(Number(shot.storyboard_id))">✓</span>
                    </span>
                    <span class="director-apply-shot-main">
                      <span class="director-apply-shot-no">{{ t('director.shotList.shot', { n: shot.shot_number }) }}</span>
                      <span class="director-apply-shot-meta">
                        {{ durationText(shot.duration_sec) }}
                        <span v-if="shot.has_video" class="director-apply-tag">{{ t('director.shotList.hasVideo') }}</span>
                        <span v-if="(shot.dirty_fields || []).length" class="director-apply-tag is-dirty">{{ t('director.apply.dirty') }}</span>
                      </span>
                    </span>
                  </button>
                  <p v-if="!props.shots.length" class="director-apply-empty">{{ t('director.apply.empty') }}</p>
                </div>
              </section>

              <section class="director-apply-panel">
                <div class="director-apply-panel-head">
                  <b>{{ t('director.apply.fieldsTitle') }}</b>
                </div>
                <p class="director-apply-hint">{{ t('director.apply.fieldsHint') }}</p>
                <div class="director-apply-field-list">
                  <label
                    v-for="field in ALL_FIELDS"
                    :key="field"
                    :class="['director-apply-field', { 'is-off': !availableFields.has(field) }]"
                  >
                    <input
                      type="checkbox"
                      :checked="selectedFields.includes(field)"
                      :disabled="props.applying || !availableFields.has(field)"
                      @change="toggleField(field)"
                    />
                    <span class="director-apply-field-name">{{ fieldLabel(field) }}</span>
                    <span v-if="!availableFields.has(field)" class="director-apply-tag">{{ t('director.apply.configOff') }}</span>
                    <span v-else-if="fieldDirtyCount(field)" class="director-apply-tag is-dirty">
                      {{ t('director.apply.changedCount', { count: fieldDirtyCount(field) }) }}
                    </span>
                    <span v-else class="director-apply-tag">{{ t('director.apply.keepOriginal') }}</span>
                  </label>
                </div>

                <div class="director-apply-panel-head is-options">
                  <b>{{ t('director.apply.optionsTitle') }}</b>
                </div>
                <label :class="['director-apply-option', { 'is-off': !props.applySettings.promptAppend }]">
                  <input v-model="appendPrompt" type="checkbox" :disabled="props.applying || !props.applySettings.promptAppend" />
                  <span>
                    <b>{{ t('director.apply.appendPrompt') }}</b>
                    <small>{{ props.applySettings.promptAppend ? t('director.apply.appendPromptHint') : t('director.apply.configOff') }}</small>
                  </span>
                </label>
                <label :class="['director-apply-option', { 'is-off': !props.applySettings.subshotSync }]">
                  <input v-model="syncSubshots" type="checkbox" :disabled="props.applying || !props.applySettings.subshotSync" />
                  <span>
                    <b>{{ t('director.apply.syncSubshots') }}</b>
                    <small>{{ props.applySettings.subshotSync ? t('director.apply.syncSubshotsHint') : t('director.apply.configOff') }}</small>
                  </span>
                </label>
              </section>
            </div>

            <section class="director-apply-durations">
              <div class="director-apply-panel-head">
                <b>{{ t('director.apply.durationTitle') }}</b>
                <span class="director-apply-hint is-inline">{{ t('director.apply.durationHint', { fps: props.applySettings.fps }) }}</span>
              </div>
              <p v-if="!selectedShots.length" class="director-apply-empty">{{ t('director.apply.durationEmpty') }}</p>
              <table v-else class="director-duration-table">
                <thead>
                  <tr>
                    <th>{{ t('director.apply.shotColumn') }}</th>
                    <th>{{ t('director.apply.current') }}</th>
                    <th>{{ t('director.apply.planned') }}</th>
                    <th>{{ t('director.apply.aligned') }}</th>
                    <th>{{ t('director.apply.framesColumn') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="shot in selectedShots" :key="`duration-${shot.storyboard_id}`">
                    <td>{{ t('director.shotList.shot', { n: shot.shot_number }) }}</td>
                    <td>{{ durationText(shot.board_duration) }}</td>
                    <td>{{ durationText(shot.duration_sec) }}</td>
                    <td :class="{ 'is-changed': alignDuration(shot.duration_sec).seconds !== Number(shot.board_duration) }">
                      {{ durationText(alignDuration(shot.duration_sec).seconds) }}
                    </td>
                    <td :class="{ 'is-changed': alignDuration(shot.duration_sec).seconds !== Number(shot.board_duration) }">
                      {{ t('director.apply.frames', { n: alignDuration(shot.duration_sec).frames }) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </section>
          </template>
        </div>

        <footer class="director-apply-foot">
          <template v-if="isResult">
            <button type="button" class="director-apply-btn is-primary" @click="emit('close')">
              {{ t('director.apply.close') }}
            </button>
            <button type="button" class="director-apply-btn" @click="emit('view-storyboards')">
              {{ t('director.apply.viewStoryboards') }}
            </button>
          </template>
          <template v-else>
            <span :class="['director-apply-blocked', { 'is-ready': !blockedReason }]">
              {{ blockedReason || t('director.apply.readyHint', { count: submitCount }) }}
            </span>
            <button type="button" class="director-apply-btn" :disabled="props.applying" @click="requestClose">
              {{ t('director.apply.close') }}
            </button>
            <button
              type="button"
              class="director-apply-btn is-primary"
              :disabled="!canSubmit"
              :title="blockedReason"
              @click="submit"
            >
              <Loader2 v-if="props.applying" :size="12" class="animate-spin" />
              {{ props.applying ? t('director.apply.applying') : t('director.apply.submit', { count: submitCount }) }}
            </button>
          </template>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.director-apply-mask {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.5);
}
.director-apply {
  display: flex;
  flex-direction: column;
  width: 760px;
  max-width: 100%;
  max-height: 88vh;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 12px);
  background: var(--bg-1);
  box-shadow: var(--shadow-lg, 0 18px 50px rgba(0, 0, 0, 0.35));
}
.director-apply-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.director-apply-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.director-apply-title b { font-size: var(--text-strong); color: var(--text-0); }
.director-apply-version {
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-2, var(--bg-1));
  color: var(--text-2);
  font-size: var(--text-meta);
}
.director-apply-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}
.director-apply-close:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-0); }
.director-apply-close:disabled { opacity: 0.45; cursor: not-allowed; }
.director-apply-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
}
.director-apply-subtitle { margin: 0; font-size: var(--text-meta); color: var(--text-2); line-height: 1.5; }
.director-apply-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.director-apply-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 9px);
  background: var(--bg-0, var(--panel-bg));
}
.director-apply-panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.director-apply-panel-head b { font-size: var(--text-label); color: var(--text-0); }
.director-apply-panel-head.is-options { margin-top: 12px; }
.director-apply-hint { margin: 0 0 6px; font-size: var(--text-meta); color: var(--text-3); line-height: 1.45; }
.director-apply-hint.is-inline { margin: 0; }
.director-apply-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: var(--text-meta);
  cursor: pointer;
}
.director-apply-link:disabled { opacity: 0.45; cursor: not-allowed; }
.director-apply-shot-list { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; }
.director-apply-shot {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-1);
  text-align: left;
  cursor: pointer;
}
.director-apply-shot:hover:not(:disabled) { background: var(--bg-hover); }
.director-apply-shot.active { border-color: var(--accent); background: var(--accent-soft, rgba(88, 166, 255, 0.08)); color: var(--text-0); }
.director-apply-shot:disabled { opacity: 0.6; cursor: not-allowed; }
.director-apply-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-top: 2px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-1);
  color: var(--accent-contrast, #fff);
  font-size: 10px;
  flex-shrink: 0;
}
.director-apply-shot.active .director-apply-check { border-color: var(--accent); background: var(--accent); }
.director-apply-shot-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.director-apply-shot-no { font-size: var(--text-label); font-weight: 650; }
.director-apply-shot-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: var(--text-meta);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.director-apply-tag {
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--bg-2, var(--bg-1));
  color: var(--text-3);
  font-size: 10px;
  white-space: nowrap;
}
.director-apply-tag.is-dirty {
  background: var(--warning-soft, rgba(217, 152, 38, 0.14));
  color: var(--warning, #b7791f);
}
.director-apply-empty { margin: 0; padding: 10px 0; font-size: var(--text-meta); color: var(--text-3); text-align: center; }
.director-apply-field-list { display: flex; flex-direction: column; gap: 2px; }
.director-apply-field {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 4px;
  border-radius: var(--radius-sm);
  font-size: var(--text-label);
  color: var(--text-1);
  cursor: pointer;
}
.director-apply-field:hover { background: var(--bg-hover); }
.director-apply-field.is-off { color: var(--text-3); cursor: not-allowed; }
.director-apply-field input { margin: 0; }
.director-apply-field-name { flex: 1; min-width: 0; }
.director-apply-option {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 5px 4px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.director-apply-option:hover { background: var(--bg-hover); }
.director-apply-option.is-off { color: var(--text-3); cursor: not-allowed; }
.director-apply-option input { margin-top: 2px; }
.director-apply-option span { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.director-apply-option b { font-size: var(--text-label); font-weight: 600; color: inherit; }
.director-apply-option small { font-size: var(--text-meta); color: var(--text-3); line-height: 1.4; }
.director-apply-durations {
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 9px);
  background: var(--bg-0, var(--panel-bg));
}
.director-duration-table,
.director-snapshot-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-meta);
  font-variant-numeric: tabular-nums;
}
.director-duration-table th,
.director-snapshot-table th {
  padding: 4px 6px;
  border-bottom: 1px solid var(--border);
  color: var(--text-3);
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}
.director-duration-table td,
.director-snapshot-table td {
  padding: 4px 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  color: var(--text-1);
  vertical-align: top;
  white-space: pre-wrap;
  word-break: break-word;
}
.director-duration-table td.is-changed { color: var(--warning, #b7791f); font-weight: 650; }
.director-apply-warnings,
.director-apply-error {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: var(--warning-soft, rgba(217, 152, 38, 0.1));
  color: var(--warning, #b7791f);
  font-size: var(--text-meta);
}
.director-apply-error {
  border: 1px solid color-mix(in srgb, var(--action-danger, #c0392b) 35%, transparent);
  background: color-mix(in srgb, var(--action-danger, #c0392b) 9%, var(--bg-1));
  color: var(--action-danger, #c0392b);
}
.director-apply-warning-title { display: flex; align-items: center; gap: 5px; }
.director-apply-warning-title svg { flex-shrink: 0; }
.director-apply-warnings ul,
.director-apply-error ul { margin: 0; padding-left: 16px; line-height: 1.5; }
.director-apply-error p { margin: 0; color: var(--text-1); line-height: 1.5; }
.director-subshot-detail { font-variant-numeric: tabular-nums; }
.director-conflict-list { list-style: none; padding-left: 0 !important; }
.director-conflict-list li { display: flex; align-items: center; gap: 8px; }
.director-conflict-reason { color: var(--text-2); }
.director-apply-error .director-apply-btn { align-self: flex-start; }
.director-result-summary { display: flex; flex-wrap: wrap; gap: 8px; }
.director-result-summary span {
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  background: var(--bg-2, var(--bg-1));
  color: var(--text-2);
  font-size: var(--text-meta);
  font-variant-numeric: tabular-nums;
}
.director-result-summary .is-applied { color: var(--success, #1a9d5a); }
.director-result-summary .is-stale { color: var(--warning, #b7791f); }
.director-result-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 9px);
  background: var(--bg-0, var(--panel-bg));
}
.director-result-group h4 { margin: 0; font-size: var(--text-label); color: var(--text-0); }
.director-result-empty { margin: 0; font-size: var(--text-meta); color: var(--text-3); }
.director-result-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.director-result-list li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  padding: 4px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  font-size: var(--text-meta);
  color: var(--text-1);
}
.director-result-list li:last-child { border-bottom: none; }
.director-result-shot { font-weight: 650; color: var(--text-0); }
.director-result-fields { display: flex; flex-wrap: wrap; gap: 4px; }
.director-result-chip {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft, rgba(88, 166, 255, 0.1));
  color: var(--accent);
  font-size: 10px;
}
.director-result-reason { color: var(--text-2); }
.director-result-stale { color: var(--warning, #b7791f); font-size: var(--text-meta); font-weight: 600; }
.director-result-stale-list { display: flex; flex-wrap: wrap; gap: 6px; }
.director-result-stale-list span {
  padding: 1px 7px;
  border: 1px solid color-mix(in srgb, var(--warning, #b7791f) 40%, var(--border));
  border-radius: var(--radius-pill);
  background: var(--warning-soft, rgba(217, 152, 38, 0.1));
}
.director-result-hint { margin: 0; font-size: var(--text-meta); color: var(--text-2); line-height: 1.5; }
.director-snapshot { border-top: 1px solid var(--border); padding-top: 5px; }
.director-snapshot:first-of-type { border-top: none; }
.director-snapshot summary {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-meta);
  color: var(--text-0);
  cursor: pointer;
}
.director-snapshot-fields { display: flex; flex-wrap: wrap; gap: 4px; color: var(--text-3); font-weight: 400; }
.director-snapshot-fields span { padding: 0 5px; border-radius: var(--radius-pill); background: var(--bg-2, var(--bg-1)); font-size: 10px; }
.director-snapshot-table { margin-top: 5px; }
.director-apply-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
}
.director-apply-blocked { flex: 1; min-width: 0; font-size: var(--text-meta); color: var(--text-3); line-height: 1.4; }
.director-apply-blocked.is-ready { color: var(--text-2); }
.director-apply-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: var(--control-sm);
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  color: var(--text-1);
  font-size: var(--text-meta);
  white-space: nowrap;
  cursor: pointer;
}
.director-apply-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--text-0); }
.director-apply-btn.is-primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast, #fff);
}
.director-apply-btn:disabled { opacity: 0.5; cursor: not-allowed; }
@media (max-width: 720px) {
  .director-apply-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
