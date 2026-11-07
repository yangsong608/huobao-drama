<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Minus, Plus, RotateCcw } from 'lucide-vue-next'

const props = defineProps<{
  shot: any | null
  scene: any | null
  characters: any[]
  selectedEntity: { type: 'character' | 'camera'; characterId?: number } | null
  canEdit: boolean
}>()

const emit = defineEmits<{
  'select-entity': [entity: { type: 'character' | 'camera'; characterId?: number } | null]
  'update-camera': [payload: {
    storyboardId: number
    patch: {
      position?: { x: number; y: number; z: number }
      look_at?: { x: number; y: number; z: number }
    }
  }]
  'update-blocking': [payload: {
    storyboardId: number
    characterId: number
    patch: { x?: number; z?: number; rotation?: number }
  }]
}>()

const { t } = useI18n()

const PX_PER_METER = 40
const STAGE_HALF_EXTENT = 20

const zoom = ref(1)
const surface = ref<HTMLElement | null>(null)
const dragging = ref(false)
const charPreview = ref<{ characterId: number; x: number; z: number; rotation: number } | null>(null)
const cameraPreview = ref<{
  position?: { x: number; y: number; z: number }
  look_at?: { x: number; y: number; z: number }
} | null>(null)

const sceneImage = computed(() => imageSrc(props.scene?.imageUrl || props.scene?.image_url))
const sceneName = computed(() => String(props.scene?.location || ''))
const blocking = computed(() => Array.isArray(props.shot?.blocking) ? props.shot.blocking : [])
const camera = computed(() => props.shot?.camera || null)
const pixelPerMeter = computed(() => PX_PER_METER * zoom.value)
const storyboardId = computed(() => Number(props.shot?.storyboard_id) || 0)

const cameraPosition = computed(() => ({
  x: Number(camera.value?.position?.x) || 0,
  y: Number(camera.value?.position?.y) || 0,
  z: Number(camera.value?.position?.z) || 0,
}))
const cameraLookAt = computed(() => ({
  x: Number(camera.value?.look_at?.x) || 0,
  y: Number(camera.value?.look_at?.y) || 0,
  z: Number(camera.value?.look_at?.z) || 0,
}))
const displayPosition = computed(() => cameraPreview.value?.position ?? cameraPosition.value)
const displayLookAt = computed(() => cameraPreview.value?.look_at ?? cameraLookAt.value)

const cameraAngle = computed(() => {
  const dx = displayLookAt.value.x - displayPosition.value.x
  const dz = displayLookAt.value.z - displayPosition.value.z
  if (!dx && !dz) return 0
  return (Math.atan2(dz, dx) * 180) / Math.PI
})

const coneLength = computed(() => 3 * pixelPerMeter.value)
const coneHeight = computed(() => {
  const lens = Math.max(1, Number(camera.value?.lens_mm) || 35)
  const halfAngle = Math.atan(18 / lens)
  return Math.max(40, Math.round(2 * coneLength.value * Math.tan(halfAngle)))
})

const characterMap = computed(() => new Map(props.characters.map((item) => [Number(item.id), item])))
const isCameraDragging = computed(() => dragging.value && Boolean(cameraPreview.value))

function imageSrc(raw: unknown): string {
  const value = String(raw || '')
  if (!value) return ''
  if (/^https?:\/\//i.test(value) || value.startsWith('/')) return value
  return `/${value}`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function clampExtent(value: number): number {
  return Math.min(STAGE_HALF_EXTENT, Math.max(-STAGE_HALF_EXTENT, value))
}

function normalizeRotation(value: number): number {
  const wrapped = value % 360
  return round2(wrapped < 0 ? wrapped + 360 : wrapped)
}

function positionStyle(x: unknown, z: unknown) {
  const px = Number(x) || 0
  const pz = Number(z) || 0
  return {
    left: `calc(50% + ${px * pixelPerMeter.value}px)`,
    top: `calc(50% + ${pz * pixelPerMeter.value}px)`,
  }
}

function previewOf(item: any) {
  return charPreview.value?.characterId === Number(item.character_id) ? charPreview.value : null
}

function characterX(item: any): number {
  return previewOf(item)?.x ?? (Number(item.x) || 0)
}

function characterZ(item: any): number {
  return previewOf(item)?.z ?? (Number(item.z) || 0)
}

function characterRotation(item: any): number {
  return previewOf(item)?.rotation ?? (Number(item.rotation) || 0)
}

function characterStyle(item: any) {
  return positionStyle(characterX(item), characterZ(item))
}

function characterImage(item: any): string {
  return imageSrc(characterMap.value.get(Number(item.character_id))?.imageUrl)
}

function characterInitial(item: any): string {
  return String(item.name || characterMap.value.get(Number(item.character_id))?.name || '?').slice(0, 1)
}

function coneStyle() {
  return {
    width: `${coneLength.value}px`,
    height: `${coneHeight.value}px`,
    transform: `translate(0, -50%) rotate(${cameraAngle.value}deg)`,
  }
}

function isSelected(type: 'character' | 'camera', characterId?: number): boolean {
  if (!props.selectedEntity || props.selectedEntity.type !== type) return false
  return type === 'camera' || props.selectedEntity.characterId === characterId
}

function zoomBy(delta: number) {
  zoom.value = Math.min(2, Math.max(0.5, Math.round((zoom.value + delta) * 100) / 100))
}

function resetZoom() {
  zoom.value = 1
}

function clearSelection() {
  emit('select-entity', null)
}

interface DragState {
  kind: 'character-move' | 'character-rotate' | 'camera-move' | 'camera-rotate'
  pointerId: number
  characterId?: number
  startClientX: number
  startClientY: number
  originX: number
  originZ: number
  moved: boolean
}

let drag: DragState | null = null

function surfaceRect(): DOMRect | null {
  return surface.value?.getBoundingClientRect() ?? null
}

function metersAt(event: PointerEvent): { x: number; z: number } {
  const box = surfaceRect()
  if (!box) return { x: 0, z: 0 }
  return {
    x: (event.clientX - box.left - box.width / 2) / pixelPerMeter.value,
    z: (event.clientY - box.top - box.height / 2) / pixelPerMeter.value,
  }
}

function beginDrag(event: PointerEvent, kind: DragState['kind'], characterId?: number) {
  if (!props.canEdit || !props.shot) return
  if (event.pointerType === 'mouse' && event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  const target = event.currentTarget as HTMLElement | null
  target?.setPointerCapture?.(event.pointerId)

  const item = characterId != null
    ? blocking.value.find((entry: any) => Number(entry.character_id) === Number(characterId))
    : null

  drag = {
    kind,
    pointerId: event.pointerId,
    characterId: characterId != null ? Number(characterId) : undefined,
    startClientX: event.clientX,
    startClientY: event.clientY,
    originX: kind.startsWith('character') ? Number(item?.x) || 0 : cameraPosition.value.x,
    originZ: kind.startsWith('character') ? Number(item?.z) || 0 : cameraPosition.value.z,
    moved: false,
  }
  dragging.value = true

  if (kind === 'character-move' || kind === 'character-rotate') {
    charPreview.value = {
      characterId: Number(characterId),
      x: Number(item?.x) || 0,
      z: Number(item?.z) || 0,
      rotation: Number(item?.rotation) || 0,
    }
    emit('select-entity', { type: 'character', characterId: Number(characterId) })
  } else if (kind === 'camera-move') {
    cameraPreview.value = { position: { ...cameraPosition.value } }
    emit('select-entity', { type: 'camera' })
  } else {
    cameraPreview.value = { look_at: { ...cameraLookAt.value } }
    emit('select-entity', { type: 'camera' })
  }
}

function rotationToward(event: PointerEvent, x: number, z: number): number {
  const box = surfaceRect()
  if (!box) return 0
  const cx = box.left + box.width / 2 + x * pixelPerMeter.value
  const cy = box.top + box.height / 2 + z * pixelPerMeter.value
  const angle = (Math.atan2(event.clientX - cx, -(event.clientY - cy)) * 180) / Math.PI
  return normalizeRotation(angle)
}

function lookAtToward(event: PointerEvent): { x: number; y: number; z: number } | null {
  const box = surfaceRect()
  if (!box) return null
  const px = cameraPosition.value.x
  const pz = cameraPosition.value.z
  const cx = box.left + box.width / 2 + px * pixelPerMeter.value
  const cy = box.top + box.height / 2 + pz * pixelPerMeter.value
  const dx = event.clientX - cx
  const dy = event.clientY - cy
  const length = Math.hypot(dx, dy)
  if (!length) return null
  const radius = Math.max(
    0.5,
    Math.hypot(cameraLookAt.value.x - px, cameraLookAt.value.z - pz),
  )
  return {
    x: round2(clampExtent(px + (radius * dx) / length)),
    y: round2(cameraLookAt.value.y),
    z: round2(clampExtent(pz + (radius * dy) / length)),
  }
}

function onDragMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return
  const dx = event.clientX - drag.startClientX
  const dy = event.clientY - drag.startClientY
  if (!drag.moved && Math.hypot(dx, dy) < 2) return
  drag.moved = true

  if (drag.kind === 'character-move' && charPreview.value) {
    const meters = metersAt(event)
    charPreview.value.x = round2(clampExtent(meters.x))
    charPreview.value.z = round2(clampExtent(meters.z))
  } else if (drag.kind === 'character-rotate' && charPreview.value) {
    charPreview.value.rotation = rotationToward(event, charPreview.value.x, charPreview.value.z)
  } else if (drag.kind === 'camera-move' && cameraPreview.value?.position) {
    const meters = metersAt(event)
    cameraPreview.value.position = {
      x: round2(clampExtent(meters.x)),
      y: cameraPreview.value.position.y,
      z: round2(clampExtent(meters.z)),
    }
  } else if (drag.kind === 'camera-rotate' && cameraPreview.value) {
    const lookAt = lookAtToward(event)
    if (lookAt) cameraPreview.value.look_at = lookAt
  }
}

function clearPreview() {
  charPreview.value = null
  cameraPreview.value = null
}

function endDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return
  const finished = drag
  drag = null
  dragging.value = false
  ;(event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId)

  const boardId = storyboardId.value
  if (boardId && finished.moved) {
    if (finished.kind === 'character-move' && charPreview.value) {
      emit('update-blocking', {
        storyboardId: boardId,
        characterId: charPreview.value.characterId,
        patch: { x: charPreview.value.x, z: charPreview.value.z },
      })
    } else if (finished.kind === 'character-rotate' && charPreview.value) {
      emit('update-blocking', {
        storyboardId: boardId,
        characterId: charPreview.value.characterId,
        patch: { rotation: charPreview.value.rotation },
      })
    } else if (finished.kind === 'camera-move' && cameraPreview.value?.position) {
      emit('update-camera', {
        storyboardId: boardId,
        patch: { position: { ...cameraPreview.value.position } },
      })
    } else if (finished.kind === 'camera-rotate' && cameraPreview.value?.look_at) {
      emit('update-camera', {
        storyboardId: boardId,
        patch: { look_at: { ...cameraPreview.value.look_at } },
      })
    }
  }

  clearPreview()
}

function cancelDrag() {
  drag = null
  dragging.value = false
  clearPreview()
}
</script>

<template>
  <div class="director-stage">
    <div class="director-stage-toolbar">
      <span class="director-stage-scene">
        {{ sceneName || t('director.stage.sceneUnknown') }}
        <span v-if="!sceneImage && props.shot" class="director-stage-scene-missing">{{ t('director.stage.noScene') }}</span>
      </span>
      <span :class="['director-stage-hint', { 'is-readonly': !props.canEdit }]">
        {{ props.canEdit ? t('director.stage.dragHint') : t('director.stage.readonlyHint') }}
      </span>
      <div class="director-stage-zoom">
        <button type="button" class="director-icon-btn" :title="t('director.stage.zoomOut')" :aria-label="t('director.stage.zoomOut')" @click="zoomBy(-0.1)">
          <Minus :size="12" />
        </button>
        <span class="director-zoom-value">{{ Math.round(zoom * 100) }}%</span>
        <button type="button" class="director-icon-btn" :title="t('director.stage.zoomIn')" :aria-label="t('director.stage.zoomIn')" @click="zoomBy(0.1)">
          <Plus :size="12" />
        </button>
        <button type="button" class="director-icon-btn" :title="t('director.stage.zoomReset')" :aria-label="t('director.stage.zoomReset')" @click="resetZoom">
          <RotateCcw :size="12" />
        </button>
      </div>
    </div>

    <div class="director-stage-canvas" @click.self="clearSelection">
      <div
        ref="surface"
        class="director-stage-surface"
        :style="{ '--grid-size': `${pixelPerMeter}px` }"
        @click.self="clearSelection"
      >
        <div v-if="sceneImage" class="director-stage-scene-bg" :style="{ backgroundImage: `url(${sceneImage})` }" />
        <div class="director-stage-grid" aria-hidden="true" />

        <template v-if="props.shot">
          <div
            v-for="item in blocking"
            :key="`char-${item.character_id}`"
            :class="[
              'director-character',
              { selected: isSelected('character', Number(item.character_id)) },
              { 'is-editable': props.canEdit },
              { 'is-dragging': charPreview?.characterId === Number(item.character_id) },
            ]"
            :style="characterStyle(item)"
            role="button"
            :tabindex="props.canEdit ? 0 : -1"
            :aria-label="item.name || t('director.stage.character')"
            @pointerdown="beginDrag($event, 'character-move', Number(item.character_id))"
            @pointermove="onDragMove"
            @pointerup="endDrag"
            @pointercancel="cancelDrag"
            @keydown.enter="emit('select-entity', { type: 'character', characterId: Number(item.character_id) })"
            @keydown.space.prevent="emit('select-entity', { type: 'character', characterId: Number(item.character_id) })"
          >
            <span
              class="director-character-arrow"
              :class="{ 'is-handle': props.canEdit }"
              :style="{ transform: `rotate(${characterRotation(item)}deg)` }"
              :title="props.canEdit ? t('director.stage.rotateCharacter') : undefined"
              aria-hidden="true"
              @pointerdown.stop="beginDrag($event, 'character-rotate', Number(item.character_id))"
              @pointermove.stop="onDragMove"
              @pointerup.stop="endDrag"
              @pointercancel.stop="cancelDrag"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M5 1L8 8H2L5 1Z" fill="currentColor" />
              </svg>
            </span>
            <span class="director-character-avatar">
              <img v-if="characterImage(item)" :src="characterImage(item)" :alt="item.name" draggable="false" />
              <span v-else class="director-character-initial">{{ characterInitial(item) }}</span>
            </span>
            <span class="director-character-name">{{ item.name || t('director.stage.character') }}</span>
          </div>

          <template v-if="camera">
            <button
              type="button"
              :class="['director-camera', { selected: isSelected('camera'), 'is-editable': props.canEdit, 'is-dragging': isCameraDragging }]"
              :style="positionStyle(displayPosition.x, displayPosition.z)"
              :aria-label="t('director.stage.camera')"
              @pointerdown="beginDrag($event, 'camera-move')"
              @pointermove="onDragMove"
              @pointerup="endDrag"
              @pointercancel="cancelDrag"
            >
              <span class="director-camera-cone" :style="coneStyle()" aria-hidden="true" />
              <span class="director-camera-icon" aria-hidden="true">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M23 7l-7 5 7 5V7z" />
                  <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                </svg>
              </span>
              <span class="director-camera-label">{{ camera.lens_mm || 35 }}mm</span>
            </button>
            <button
              type="button"
              :class="['director-camera-target', { 'is-editable': props.canEdit }]"
              :style="positionStyle(displayLookAt.x, displayLookAt.z)"
              :aria-label="t('director.stage.cameraTarget')"
              :title="props.canEdit ? t('director.stage.rotateCamera') : undefined"
              @pointerdown="beginDrag($event, 'camera-rotate')"
              @pointermove="onDragMove"
              @pointerup="endDrag"
              @pointercancel="cancelDrag"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M6 1v3M6 8v3M1 6h3M8 6h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                <circle cx="6" cy="6" r="1.6" fill="currentColor" />
              </svg>
            </button>
          </template>
        </template>
      </div>

      <div v-if="!props.shot" class="director-stage-empty">
        <StudioEmptyState
          :title="t('director.stage.emptyTitle')"
          :description="t('director.stage.emptyDesc')"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.director-stage {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--bg-0);
}
.director-stage-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 36px;
  min-height: 36px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-bg);
}
.director-stage-scene {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-shrink: 0;
  max-width: 34%;
  font-size: var(--text-meta);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.director-stage-scene-missing {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-1);
  color: var(--text-2);
}
.director-stage-hint {
  flex: 1;
  min-width: 0;
  font-size: var(--text-meta);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.director-stage-hint.is-readonly { font-style: italic; }
.director-stage-zoom {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.director-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-xs);
  height: var(--control-xs);
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  color: var(--text-1);
  cursor: pointer;
}
.director-icon-btn:hover { background: var(--bg-hover); color: var(--text-0); }
.director-zoom-value {
  min-width: 40px;
  text-align: center;
  font-size: var(--text-meta);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.director-stage-canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.director-stage-surface {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.director-stage-scene-bg {
  position: absolute;
  inset: 0;
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  opacity: 0.32;
  filter: saturate(0.85);
  pointer-events: none;
}
.director-stage-grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(to right, var(--border) 1px, transparent 1px),
    linear-gradient(to bottom, var(--border) 1px, transparent 1px);
  background-size: var(--grid-size) var(--grid-size);
  opacity: 0.55;
  pointer-events: none;
}
.director-stage-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.director-character {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-1);
  transform: translate(-50%, -50%);
  cursor: pointer;
  touch-action: none;
  user-select: none;
  outline: none;
}
.director-character.is-editable { cursor: grab; }
.director-character.is-dragging { cursor: grabbing; z-index: 4; }
.director-character:focus-visible .director-character-avatar {
  box-shadow: 0 0 0 3px var(--accent-soft, rgba(88, 166, 255, 0.35));
}
.director-character-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 2px solid var(--panel-bg);
  border-radius: 50%;
  overflow: hidden;
  background: var(--bg-1);
  box-shadow: var(--shadow-sm);
}
.director-character-avatar img { width: 100%; height: 100%; object-fit: cover; }
.director-character-initial { font-size: var(--text-label); font-weight: 700; color: var(--text-1); }
.director-character-arrow {
  position: absolute;
  top: -11px;
  left: 50%;
  color: var(--accent);
  transform-origin: 50% 100%;
}
.director-character-arrow.is-handle {
  padding: 4px;
  margin: -4px;
  cursor: grab;
  touch-action: none;
}
.director-character-arrow.is-handle:hover { filter: drop-shadow(0 0 3px var(--accent-soft, rgba(88, 166, 255, 0.5))); }
.director-character-name {
  max-width: 72px;
  padding: 0 4px;
  border-radius: var(--radius-sm);
  background: var(--panel-bg);
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.director-character.selected .director-character-avatar {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft, rgba(88, 166, 255, 0.25));
}
.director-camera {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 2px solid var(--panel-bg);
  border-radius: 50%;
  background: var(--text-2);
  color: var(--panel-bg);
  transform: translate(-50%, -50%);
  cursor: pointer;
  z-index: 2;
  touch-action: none;
  user-select: none;
}
.director-camera.is-editable { cursor: grab; }
.director-camera.is-dragging { cursor: grabbing; }
.director-camera.selected { border-color: var(--accent); background: var(--accent); }
.director-camera-cone {
  position: absolute;
  left: 50%;
  top: 50%;
  transform-origin: 0 50%;
  background: var(--accent);
  opacity: 0.16;
  clip-path: polygon(0 50%, 100% 0, 100% 100%);
  pointer-events: none;
}
.director-camera-icon { display: inline-flex; position: relative; z-index: 1; }
.director-camera-label {
  position: absolute;
  top: 30px;
  left: 50%;
  transform: translateX(-50%);
  padding: 0 4px;
  border-radius: var(--radius-sm);
  background: var(--panel-bg);
  font-size: 11px;
  color: var(--text-2);
  white-space: nowrap;
}
.director-camera-target {
  position: absolute;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px dashed var(--accent);
  border-radius: 50%;
  background: var(--panel-bg);
  color: var(--accent);
  transform: translate(-50%, -50%);
  z-index: 3;
  touch-action: none;
  pointer-events: auto;
}
.director-camera-target.is-editable { cursor: move; }
.director-camera-target.is-editable:hover { background: var(--accent-soft, rgba(88, 166, 255, 0.18)); }
.director-stage :is(button, input, select):focus-visible { outline: none; box-shadow: var(--focus-ring); }
</style>
