<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import DirectorShotList from '~/components/director/DirectorShotList.vue'
import DirectorStage2D from '~/components/director/DirectorStage2D.vue'
import DirectorInspector from '~/components/director/DirectorInspector.vue'

const props = defineProps<{
  shots: any[]
  scenes: any[]
  characters: any[]
  selectedShotId: number | null
  selectedEntity: { type: 'character' | 'camera'; characterId?: number } | null
  view: '2d' | '3d'
  canEdit: boolean
  durationMin: number
  durationMax: number
  staleIds?: number[]
  previsMaxAssets?: number
  stage3dKey?: number
}>()

const emit = defineEmits<{
  'select-shot': [shotId: number]
  'select-entity': [entity: { type: 'character' | 'camera'; characterId?: number } | null]
  'update-shot': [payload: { storyboardId: number; patch: Record<string, any> }]
  'update-blocking': [payload: { storyboardId: number; characterId: number; patch: Record<string, any> }]
  'update-subshots': [payload: { storyboardId: number; subshots: any[] }]
  'stage3d-fallback': [reason: 'load-failed' | 'webgl-unavailable' | 'context-lost' | 'render-failed', detail?: string]
}>()

const { t } = useI18n()

const DirectorStage3D = defineAsyncComponent({
  loader: () => import('~/components/director/DirectorStage3D.vue'),
  timeout: 20000,
  onError(_error, _retry, fail) {
    fail()
    emit('stage3d-fallback', 'load-failed')
  },
})

const staleSet = computed(() => new Set((props.staleIds || []).map(Number)))
const selectedShot = computed(() => props.shots.find((shot) => shot.storyboard_id === props.selectedShotId) || null)
const selectedStale = computed(() => Boolean(selectedShot.value && staleSet.value.has(Number(selectedShot.value.storyboard_id))))
const sceneMap = computed(() => new Map(props.scenes.map((scene) => [Number(scene.id), scene])))
const selectedScene = computed(() => {
  const sceneId = Number(selectedShot.value?.scene_id)
  return sceneId ? sceneMap.value.get(sceneId) || null : null
})
</script>

<template>
  <div class="director-workbench">
    <DirectorShotList
      :shots="props.shots"
      :selected-id="props.selectedShotId"
      :stale-ids="props.staleIds"
      @select="emit('select-shot', $event)"
    />

    <div class="director-main">
      <DirectorStage2D
        v-if="props.view === '2d'"
        :shot="selectedShot"
        :scene="selectedScene"
        :characters="props.characters"
        :selected-entity="props.selectedEntity"
        :can-edit="props.canEdit"
        @select-entity="emit('select-entity', $event)"
        @update-camera="emit('update-shot', { storyboardId: $event.storyboardId, patch: { camera: $event.patch } })"
        @update-blocking="emit('update-blocking', $event)"
      />
      <Suspense v-else>
        <DirectorStage3D
          :key="props.stage3dKey || 0"
          :shots="props.shots"
          :scenes="props.scenes"
          :characters="props.characters"
          :selected-shot-id="props.selectedShotId"
          :selected-entity="props.selectedEntity"
          :max-assets="props.previsMaxAssets || 20"
          @select-shot="emit('select-shot', $event)"
          @select-entity="emit('select-entity', $event)"
          @fallback="(reason, detail) => emit('stage3d-fallback', reason, detail)"
        />
        <template #fallback>
          <div class="director-stage3d-loading">
            <Loader2 :size="18" class="animate-spin" />
            <span>{{ t('director.stage3d.loading') }}</span>
          </div>
        </template>
      </Suspense>
      <div class="director-shot-strip">
        <span class="director-strip-label">{{ t('director.strip.title') }}</span>
        <div class="director-strip-scroll">
          <button
            v-for="shot in props.shots"
            :key="`strip-${shot.storyboard_id}`"
            type="button"
            :class="['director-strip-item', { active: shot.storyboard_id === props.selectedShotId, 'is-stale': staleSet.has(Number(shot.storyboard_id)) }]"
            @click="emit('select-shot', shot.storyboard_id)"
          >
            <span class="director-strip-no">{{ shot.shot_number }}</span>
            <span class="director-strip-time">{{ Math.round(Number(shot.duration_sec) || 0) }}s</span>
            <span v-if="shot.has_video" class="director-strip-dot" aria-hidden="true" />
            <span
              v-if="staleSet.has(Number(shot.storyboard_id))"
              class="director-strip-stale"
              :title="t('director.apply.needsRegenerate')"
            >↻</span>
          </button>
        </div>
      </div>
    </div>

    <DirectorInspector
      :shot="selectedShot"
      :selected-entity="props.selectedEntity"
      :stale="selectedStale"
      :can-edit="props.canEdit"
      :duration-min="props.durationMin"
      :duration-max="props.durationMax"
      @update-shot="emit('update-shot', $event)"
      @update-blocking="emit('update-blocking', $event)"
      @update-subshots="emit('update-subshots', $event)"
    />
  </div>
</template>

<style scoped>
.director-workbench {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr) 320px;
  grid-template-rows: minmax(0, 1fr) auto;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.director-workbench > :deep(.director-shotlist) { grid-row: 1 / 3; }
.director-main {
  display: flex;
  flex-direction: column;
  grid-column: 2;
  grid-row: 1 / 3;
  min-width: 0;
  min-height: 0;
}
.director-workbench > :deep(.studio-inspector) { grid-column: 3; grid-row: 1; }
.director-shot-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 96px;
  min-height: 96px;
  padding: 0 10px;
  border-top: 1px solid var(--border);
  background: var(--panel-bg);
  grid-column: 2 / 4;
  grid-row: 2;
}
.director-strip-label {
  flex-shrink: 0;
  font-size: var(--text-meta);
  font-weight: 650;
  color: var(--text-2);
}
.director-strip-scroll {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  padding: 4px 0;
}
.director-strip-item {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: var(--control-sm);
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-1);
  color: var(--text-2);
  font-size: var(--text-meta);
  cursor: pointer;
  flex-shrink: 0;
}
.director-strip-item:hover { background: var(--bg-hover); color: var(--text-0); }
.director-strip-item.active { border-color: var(--accent); color: var(--text-0); background: var(--bg-active, var(--bg-hover)); }
.director-strip-item.is-stale { border-color: color-mix(in srgb, var(--warning, #b7791f) 50%, var(--border)); }
.director-strip-no { font-weight: 650; }
.director-strip-time { font-variant-numeric: tabular-nums; }
.director-strip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--success, #1a9d5a);
}
.director-strip-stale {
  color: var(--warning, #b7791f);
  font-size: 11px;
  line-height: 1;
}
.director-stage3d-loading {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 0;
  background: var(--media-surface, #0b0d10);
  color: var(--on-media, rgba(255, 255, 255, 0.85));
  font-size: var(--text-label);
}
@media (max-width: 1360px) {
  .director-workbench { grid-template-columns: 240px minmax(0, 1fr) 300px; }
}
</style>
