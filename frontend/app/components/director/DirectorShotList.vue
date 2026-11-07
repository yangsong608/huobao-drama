<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  shots: any[]
  selectedId: number | null
  staleIds?: number[]
}>()

const staleSet = computed(() => new Set((props.staleIds || []).map(Number)))

const emit = defineEmits<{ select: [shotId: number] }>()

const { t } = useI18n()

function durationText(value: unknown): string {
  const num = Number(value)
  return Number.isFinite(num) ? t('director.inspector.seconds', { n: Math.round(num * 10) / 10 }) : '—'
}
</script>

<template>
  <aside class="director-shotlist">
    <div class="director-shotlist-head">
      <span>{{ t('director.shotList.title') }}</span>
      <span class="director-shotlist-count">{{ props.shots.length }}</span>
    </div>
    <div v-if="props.shots.length === 0" class="director-shotlist-empty">
      <p>{{ t('director.shotList.empty') }}</p>
      <p class="dim">{{ t('director.shotList.emptyHint') }}</p>
    </div>
    <div v-else class="director-shotlist-scroll">
      <button
        v-for="shot in props.shots"
        :key="shot.storyboard_id"
        type="button"
        :class="['director-shot-item', { active: shot.storyboard_id === props.selectedId }]"
        @click="emit('select', shot.storyboard_id)"
      >
        <span class="director-shot-no">{{ t('director.shotList.shot', { n: shot.shot_number }) }}</span>
        <span class="director-shot-meta">
          <span>{{ durationText(shot.duration_sec) }}</span>
          <span v-if="shot.has_video" class="director-shot-ready">{{ t('director.shotList.hasVideo') }}</span>
          <span v-if="staleSet.has(Number(shot.storyboard_id))" class="director-shot-stale">
            {{ t('director.apply.needsRegenerate') }}
          </span>
        </span>
        <span class="director-shot-camera">{{ shot.camera?.shot_type || t('director.inspector.notSet') }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.director-shotlist {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--panel-bg);
}
.director-shotlist-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  min-height: 40px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  font-size: var(--text-label);
  font-weight: 650;
  color: var(--text-0);
}
.director-shotlist-count {
  min-width: 20px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-1);
  color: var(--text-2);
  font-size: var(--text-meta);
  font-weight: 600;
  text-align: center;
}
.director-shotlist-empty {
  padding: 24px 16px;
  text-align: center;
  font-size: var(--text-label);
  color: var(--text-1);
  line-height: 1.6;
}
.director-shotlist-empty .dim { color: var(--text-2); font-size: var(--text-meta); }
.director-shotlist-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}
.director-shot-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  margin-bottom: 4px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-1);
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
.director-shot-item:hover { background: var(--bg-hover); }
.director-shot-item.active {
  border-color: var(--accent);
  background: var(--bg-active, var(--bg-hover));
  color: var(--text-0);
}
.director-shot-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  border-radius: var(--radius-pill);
  background: var(--accent);
}
.director-shot-item.active .director-shot-no { font-weight: 700; }
.director-shot-no { font-size: var(--text-label); font-weight: 650; color: inherit; }
.director-shot-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-meta);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.director-shot-ready { color: var(--success, #1a9d5a); }
.director-shot-stale {
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--warning-soft, rgba(217, 152, 38, 0.14));
  color: var(--warning, #b7791f);
  white-space: nowrap;
}
.director-shot-camera {
  font-size: var(--text-meta);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.director-shotlist :is(button):focus-visible { outline: none; box-shadow: var(--focus-ring); }
</style>
