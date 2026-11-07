<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Plus, Trash2 } from 'lucide-vue-next'
import StudioInspectorPanel from '~/components/studio/StudioInspectorPanel.vue'
import StudioEmptyState from '~/components/studio/StudioEmptyState.vue'

const props = defineProps<{
  shot: any | null
  selectedEntity: { type: 'character' | 'camera'; characterId?: number } | null
  canEdit: boolean
  durationMin: number
  durationMax: number
  stale?: boolean
}>()

const emit = defineEmits<{
  'update-shot': [payload: {
    storyboardId: number
    patch: { camera?: Record<string, any>; duration_sec?: number; notes?: string }
  }]
  'update-blocking': [payload: {
    storyboardId: number
    characterId: number
    patch: { x?: number; z?: number; rotation?: number }
  }]
  'update-subshots': [payload: { storyboardId: number; subshots: any[] }]
}>()

const { t } = useI18n()

const SUBSHOT_TOLERANCE = 0.2

const blocking = computed(() => Array.isArray(props.shot?.blocking) ? props.shot.blocking : [])
const camera = computed(() => props.shot?.camera || null)
const subshots = computed(() => Array.isArray(props.shot?.subshots) ? props.shot.subshots : [])
const selectedCharacter = computed(() => {
  if (props.selectedEntity?.type !== 'character') return null
  return blocking.value.find((item: any) => Number(item.character_id) === Number(props.selectedEntity?.characterId)) || null
})

const storyboardId = computed(() => Number(props.shot?.storyboard_id) || 0)
const subshotTotal = computed(() => round2(subshots.value.reduce(
  (sum: number, item: any) => sum + (Number(item.duration_sec) || 0),
  0,
)))
const subshotMismatch = computed(() => (
  Math.abs(subshotTotal.value - (Number(props.shot?.duration_sec) || 0)) > SUBSHOT_TOLERANCE
))
const durationValue = computed(() => Number(props.shot?.duration_sec) || 0)

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function num(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '0'
}

function inputValue(event: Event): string {
  return String((event.target as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? '')
}

function inputNumber(event: Event): number {
  return Number((event.target as HTMLInputElement | null)?.value)
}

function commitShot(patch: {
  camera?: Record<string, any>
  duration_sec?: number
  notes?: string
}) {
  if (!props.canEdit || !storyboardId.value) return
  emit('update-shot', { storyboardId: storyboardId.value, patch })
}

function commitBlocking(patch: { x?: number; z?: number; rotation?: number }) {
  if (!props.canEdit || !storyboardId.value || !selectedCharacter.value) return
  emit('update-blocking', {
    storyboardId: storyboardId.value,
    characterId: Number(selectedCharacter.value.character_id),
    patch,
  })
}

function commitSubshots(list: any[]) {
  if (!props.canEdit || !storyboardId.value) return
  emit('update-subshots', { storyboardId: storyboardId.value, subshots: list })
}

function commitCamera(patch: Record<string, any>) {
  commitShot({ camera: patch })
}

function commitDuration(event: Event) {
  const value = inputNumber(event)
  if (!Number.isFinite(value)) return
  commitShot({ duration_sec: value })
}

function commitNotes(event: Event) {
  commitShot({ notes: inputValue(event) })
}

function commitCameraPosition(axis: 'x' | 'z', event: Event) {
  const value = inputNumber(event)
  if (!Number.isFinite(value) || !camera.value) return
  commitCamera({
    position: {
      ...camera.value.position,
      [axis]: value,
    },
  })
}

function commitCameraHeight(event: Event) {
  const value = inputNumber(event)
  if (!Number.isFinite(value) || !camera.value) return
  commitCamera({
    height_m: value,
    position: {
      ...camera.value.position,
      y: value,
    },
  })
}

function commitLookAt(axis: 'x' | 'y' | 'z', event: Event) {
  const value = inputNumber(event)
  if (!Number.isFinite(value) || !camera.value) return
  commitCamera({
    look_at: {
      ...camera.value.look_at,
      [axis]: value,
    },
  })
}

function commitLens(event: Event) {
  const value = inputNumber(event)
  if (!Number.isFinite(value)) return
  commitCamera({ lens_mm: value })
}

function commitBlockingAxis(axis: 'x' | 'z', event: Event) {
  const value = inputNumber(event)
  if (!Number.isFinite(value)) return
  commitBlocking({ [axis]: value })
}

function commitRotation(event: Event) {
  const value = inputNumber(event)
  if (!Number.isFinite(value)) return
  commitBlocking({ rotation: value })
}

function updateSubshot(index: number, patch: Record<string, any>) {
  const list = subshots.value.map((item: any) => ({ ...item }))
  if (!list[index]) return
  list[index] = { ...list[index], ...patch }
  commitSubshots(list)
}

function commitSubshotDescription(index: number, event: Event) {
  updateSubshot(index, { description: inputValue(event) })
}

function commitSubshotDuration(index: number, event: Event) {
  const value = inputNumber(event)
  if (!Number.isFinite(value)) return
  updateSubshot(index, { duration_sec: value })
}

function addSubshot() {
  const list = subshots.value.map((item: any) => ({ ...item }))
  const remaining = round2((Number(props.shot?.duration_sec) || 0) - subshotTotal.value)
  list.push({
    no: list.length + 1,
    description: '',
    duration_sec: round2(Math.max(0, remaining)),
    path_index: list.length,
  })
  commitSubshots(list)
}

function removeSubshot(index: number) {
  if (subshots.value.length <= 1) return
  const list = subshots.value
    .filter((_: any, i: number) => i !== index)
    .map((item: any, i: number) => ({ ...item, no: i + 1, path_index: i }))
  commitSubshots(list)
}
</script>

<template>
  <StudioInspectorPanel :title="t('director.inspector.title')">
    <template #header>
      <span class="director-inspector-title">
        {{ t('director.inspector.title') }}
        <span v-if="props.selectedEntity?.type === 'character'" class="director-inspector-kicker">{{ t('director.stage.character') }}</span>
        <span v-else-if="props.selectedEntity?.type === 'camera'" class="director-inspector-kicker">{{ t('director.stage.camera') }}</span>
        <span v-else-if="props.shot" class="director-inspector-kicker">{{ t('director.inspector.shot', { n: props.shot.shot_number }) }}</span>
      </span>
    </template>

    <StudioEmptyState
      v-if="!props.shot"
      :title="t('director.inspector.emptyTitle')"
      :description="t('director.inspector.emptyDesc')"
    />

    <div v-else class="director-inspector-body">
      <div v-if="props.stale" class="director-stale-banner" role="status">
        <b>{{ t('director.apply.needsRegenerate') }}</b>
        <span>{{ t('director.apply.staleHint') }}</span>
      </div>
      <section class="director-section">
        <h4 class="director-section-title">{{ t('director.inspector.shot', { n: props.shot.shot_number }) }}</h4>
        <label class="director-form-row">
          <span>{{ t('director.inspector.duration') }}</span>
          <input
            type="number"
            :value="num(props.shot.duration_sec)"
            :min="props.durationMin"
            :max="props.durationMax"
            step="0.1"
            :disabled="!props.canEdit"
            @change="commitDuration"
          />
        </label>
        <p class="director-form-hint">{{ t('director.inspector.durationHint', { min: props.durationMin, max: props.durationMax }) }}</p>
        <label class="director-form-row">
          <span>{{ t('director.inspector.shotType') }}</span>
          <input
            type="text"
            :value="props.shot.camera?.shot_type || ''"
            :disabled="!props.canEdit"
            :placeholder="t('director.inspector.notSet')"
            @change="commitCamera({ shot_type: inputValue($event) })"
          />
        </label>
        <label class="director-form-row">
          <span>{{ t('director.inspector.angle') }}</span>
          <input
            type="text"
            :value="props.shot.camera?.angle || ''"
            :disabled="!props.canEdit"
            :placeholder="t('director.inspector.notSet')"
            @change="commitCamera({ angle: inputValue($event) })"
          />
        </label>
        <label class="director-form-row">
          <span>{{ t('director.inspector.movement') }}</span>
          <input
            type="text"
            :value="props.shot.camera?.movement || ''"
            :disabled="!props.canEdit"
            :placeholder="t('director.inspector.notSet')"
            @change="commitCamera({ movement: inputValue($event) })"
          />
        </label>
      </section>

      <section v-if="selectedCharacter" class="director-section">
        <h4 class="director-section-title">{{ t('director.inspector.blocking') }}</h4>
        <div class="director-form-row is-static">
          <span>{{ t('director.inspector.name') }}</span>
          <b class="director-static-value">{{ selectedCharacter.name || t('director.inspector.notSet') }}</b>
        </div>
        <label class="director-form-row">
          <span>{{ t('director.inspector.x') }}</span>
          <input
            type="number"
            :value="num(selectedCharacter.x)"
            step="0.1"
            :disabled="!props.canEdit"
            @change="commitBlockingAxis('x', $event)"
          />
        </label>
        <label class="director-form-row">
          <span>{{ t('director.inspector.z') }}</span>
          <input
            type="number"
            :value="num(selectedCharacter.z)"
            step="0.1"
            :disabled="!props.canEdit"
            @change="commitBlockingAxis('z', $event)"
          />
        </label>
        <label class="director-form-row">
          <span>{{ t('director.inspector.rotation') }}</span>
          <input
            type="number"
            :value="num(selectedCharacter.rotation)"
            min="0"
            max="360"
            step="1"
            :disabled="!props.canEdit"
            @change="commitRotation"
          />
        </label>
        <p class="director-form-hint">{{ t('director.inspector.rotationHint') }}</p>
      </section>

      <section v-if="camera && !selectedCharacter" class="director-section">
        <h4 class="director-section-title">{{ t('director.inspector.camera') }}</h4>
        <label class="director-form-row">
          <span>{{ t('director.inspector.lens') }}</span>
          <input
            type="number"
            :value="num(camera.lens_mm)"
            min="1"
            max="300"
            step="1"
            :disabled="!props.canEdit"
            @change="commitLens"
          />
        </label>
        <p class="director-form-hint">{{ t('director.inspector.lensHint') }}</p>
        <label class="director-form-row">
          <span>{{ t('director.inspector.height') }}</span>
          <input
            type="number"
            :value="num(camera.height_m)"
            min="0"
            max="20"
            step="0.1"
            :disabled="!props.canEdit"
            @change="commitCameraHeight"
          />
        </label>
        <p class="director-form-hint">{{ t('director.inspector.heightHint') }}</p>
        <div class="director-form-row is-static">
          <span>{{ t('director.inspector.cameraPosition') }}</span>
          <span class="director-inline-fields">
            <label>
              <span>{{ t('director.inspector.x') }}</span>
              <input type="number" :value="num(camera.position?.x)" step="0.1" :disabled="!props.canEdit" @change="commitCameraPosition('x', $event)" />
            </label>
            <label>
              <span>{{ t('director.inspector.z') }}</span>
              <input type="number" :value="num(camera.position?.z)" step="0.1" :disabled="!props.canEdit" @change="commitCameraPosition('z', $event)" />
            </label>
          </span>
        </div>
        <div class="director-form-row is-static">
          <span>{{ t('director.inspector.targetPoint') }}</span>
          <span class="director-inline-fields">
            <label>
              <span>{{ t('director.inspector.x') }}</span>
              <input type="number" :value="num(camera.look_at?.x)" step="0.1" :disabled="!props.canEdit" @change="commitLookAt('x', $event)" />
            </label>
            <label>
              <span>{{ t('director.inspector.y') }}</span>
              <input type="number" :value="num(camera.look_at?.y)" step="0.1" :disabled="!props.canEdit" @change="commitLookAt('y', $event)" />
            </label>
            <label>
              <span>{{ t('director.inspector.z') }}</span>
              <input type="number" :value="num(camera.look_at?.z)" step="0.1" :disabled="!props.canEdit" @change="commitLookAt('z', $event)" />
            </label>
          </span>
        </div>
      </section>

      <section class="director-section">
        <h4 class="director-section-title">{{ t('director.inspector.subshots') }}</h4>
        <p v-if="!subshots.length" class="director-muted">{{ t('director.inspector.noSubshots') }}</p>
        <div v-for="(sub, index) in subshots" :key="sub.no ?? index" class="director-subshot">
          <div class="director-subshot-head">
            <span>{{ t('director.inspector.subshot', { n: sub.no ?? index + 1 }) }}</span>
            <span class="director-muted">{{ t('director.inspector.pathSegment', { n: Number(sub.path_index) + 1 }) }}</span>
          </div>
          <label class="director-form-row">
            <span>{{ t('director.inspector.description') }}</span>
            <textarea
              class="director-subshot-input"
              rows="2"
              :value="sub.description || ''"
              :disabled="!props.canEdit"
              :placeholder="t('director.inspector.notSet')"
              @change="commitSubshotDescription(index, $event)"
            />
          </label>
          <div class="director-subshot-foot">
            <label class="director-form-row is-compact">
              <span>{{ t('director.inspector.duration') }}</span>
              <input
                type="number"
                :value="num(sub.duration_sec)"
                min="0"
                step="0.1"
                :disabled="!props.canEdit"
                @change="commitSubshotDuration(index, $event)"
              />
            </label>
            <button
              type="button"
              class="director-subshot-remove"
              :disabled="!props.canEdit || subshots.length <= 1"
              :aria-label="t('director.inspector.removeSubshot')"
              @click="removeSubshot(index)"
            >
              <Trash2 :size="12" />
              {{ t('director.inspector.removeSubshot') }}
            </button>
          </div>
        </div>
        <button
          type="button"
          class="director-subshot-add"
          :disabled="!props.canEdit"
          @click="addSubshot"
        >
          <Plus :size="12" />
          {{ t('director.inspector.addSubshot') }}
        </button>
        <p class="director-form-hint">{{ t('director.inspector.atLeastOneSubshot') }}</p>
        <p v-if="subshots.length > 4" class="director-form-hint">{{ t('director.inspector.subshotLimitHint') }}</p>
      </section>

      <section class="director-section">
        <h4 class="director-section-title">{{ t('director.inspector.validation') }}</h4>
        <p class="director-form-hint">
          {{ t('director.inspector.subshotTotal', { total: subshotTotal, duration: durationValue }) }}
        </p>
        <p v-if="subshotMismatch" class="director-validation is-error">
          {{ t('director.inspector.subshotMismatch') }}
        </p>
        <p v-else class="director-validation is-ok">
          {{ t('director.inspector.subshotOk') }}
        </p>
      </section>

      <section class="director-section">
        <h4 class="director-section-title">{{ t('director.inspector.notes') }}</h4>
        <textarea
          class="director-notes-input"
          rows="3"
          :value="props.shot.notes || ''"
          :disabled="!props.canEdit"
          :placeholder="t('director.inspector.notesPlaceholder')"
          @change="commitNotes"
        />
      </section>
    </div>
  </StudioInspectorPanel>
</template>

<style scoped>
.director-inspector-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.director-inspector-kicker {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-1);
  color: var(--text-2);
  font-size: var(--text-meta);
  font-weight: 500;
}
.director-inspector-body { padding: 4px 0 12px; }
.director-section { padding: 10px 12px; border-bottom: 1px solid var(--border); }
.director-section:last-child { border-bottom: none; }
.director-section-title {
  margin: 0 0 8px;
  font-size: var(--text-meta);
  font-weight: 650;
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.director-form-row {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: var(--text-label);
  color: var(--text-2);
}
.director-form-row.is-static { align-items: center; }
.director-form-row.is-compact { grid-template-columns: 44px 78px; padding: 0; }
.director-form-row input,
.director-subshot-input,
.director-notes-input {
  width: 100%;
  min-width: 0;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  color: var(--text-0);
  font-size: var(--text-meta);
  font-variant-numeric: tabular-nums;
}
.director-subshot-input,
.director-notes-input {
  height: auto;
  padding: 5px 7px;
  line-height: 1.5;
  resize: vertical;
}
.director-form-row input:focus,
.director-subshot-input:focus,
.director-notes-input:focus { outline: none; border-color: var(--accent); }
.director-form-row input:disabled,
.director-subshot-input:disabled,
.director-notes-input:disabled { opacity: 0.65; cursor: not-allowed; }
.director-static-value { font-size: var(--text-label); color: var(--text-0); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.director-inline-fields { display: flex; align-items: center; gap: 6px; min-width: 0; }
.director-inline-fields label { display: flex; align-items: center; gap: 3px; min-width: 0; flex: 1; }
.director-inline-fields label span { flex-shrink: 0; font-size: 11px; color: var(--text-2); }
.director-inline-fields input { width: 100%; height: 24px; }
.director-form-hint { margin: 3px 0 6px; padding-left: 82px; font-size: 11px; line-height: 1.45; color: var(--text-2); }
.director-muted { margin: 0; font-size: var(--text-meta); color: var(--text-2); }
.director-stale-banner {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--warning, #b7791f) 40%, var(--border));
  border-radius: var(--radius-sm);
  background: var(--warning-soft, rgba(217, 152, 38, 0.1));
  color: var(--warning, #b7791f);
  font-size: var(--text-meta);
  line-height: 1.5;
}
.director-stale-banner b { font-size: var(--text-label); }
.director-stale-banner span { color: var(--text-1); }
.director-subshot { padding: 6px 0; border-top: 1px dashed var(--border); }
.director-subshot:first-of-type { border-top: none; }
.director-subshot-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--text-meta);
  color: var(--text-1);
  font-weight: 600;
}
.director-subshot-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.director-subshot-remove,
.director-subshot-add {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}
.director-subshot-remove:hover:not(:disabled),
.director-subshot-add:hover:not(:disabled) { border-color: var(--accent); color: var(--text-0); }
.director-subshot-remove:disabled,
.director-subshot-add:disabled { opacity: 0.45; cursor: not-allowed; }
.director-subshot-add { margin-top: 8px; }
.director-validation { margin: 2px 0 0; font-size: 11px; line-height: 1.5; }
.director-validation.is-ok { color: var(--success, #1a9d5a); }
.director-validation.is-error { color: var(--warning, #b7791f); }
.studio-inspector :is(button, input, select, textarea, summary):focus-visible { outline: none; box-shadow: var(--focus-ring); }
</style>
