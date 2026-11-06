<template>
  <aside class="ed-inspector">
    <template v-if="clip">
      <header class="ed-insp-head">
        <b>{{ clip.source?.label || t('edit.clip') }}</b>
        <span>{{ clip.source?.kind }}</span>
      </header>

      <section class="ed-insp-section">
        <h4>{{ t('edit.source') }}</h4>
        <dl class="ed-insp-grid">
          <div><dt>{{ t('edit.duration') }}</dt><dd>{{ formatPrecise(clip.source?.durationMs || 0) }}</dd></div>
          <div><dt>{{ t('edit.resolution') }}</dt><dd>{{ clip.source?.width }}×{{ clip.source?.height }}</dd></div>
          <div><dt>{{ t('edit.inOut') }}</dt><dd>{{ formatPrecise(clip.sourceInMs) }} – {{ formatPrecise(clip.sourceOutMs) }}</dd></div>
          <div><dt>{{ t('edit.speed') }}</dt><dd>{{ clip.speed.toFixed(2) }}×</dd></div>
        </dl>
        <div class="ed-insp-row" v-if="!readonly">
          <span>{{ t('edit.sourceIn') }}</span>
          <button type="button" @click="$emit('trim-start', 100)">+100</button>
          <button type="button" @click="$emit('trim-start', -100)">−100</button>
          <button type="button" @click="$emit('trim-start', 1000)">+1s</button>
          <button type="button" @click="$emit('trim-start', -1000)">−1s</button>
        </div>
        <div class="ed-insp-row" v-if="!readonly">
          <span>{{ t('edit.sourceOut') }}</span>
          <button type="button" @click="$emit('trim-end', 100)">+100</button>
          <button type="button" @click="$emit('trim-end', -100)">−100</button>
          <button type="button" @click="$emit('trim-end', 1000)">+1s</button>
          <button type="button" @click="$emit('trim-end', -1000)">−1s</button>
        </div>
      </section>

      <section class="ed-insp-section">
        <h4>{{ t('edit.timeline') }}</h4>
        <label class="ed-insp-field">
          <span>{{ t('edit.speed') }} {{ clip.speed.toFixed(2) }}×</span>
          <input
            type="range" min="0.25" max="4" step="0.05" :value="clip.speed" :disabled="readonly"
            @change="$emit('speed', Number($event.target.value))"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.gap') }}</span>
          <input
            type="number" min="0" max="300000" step="100" :value="clip.gapBeforeMs" :disabled="readonly"
            @change="$emit('gap', Number($event.target.value))"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.fadeIn') }}</span>
          <input
            type="number" min="0" max="1500" step="50" :value="clip.videoFadeInMs" :disabled="readonly"
            @change="$emit('fades', { inMs: Number($event.target.value), outMs: clip.videoFadeOutMs })"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.fadeOut') }}</span>
          <input
            type="number" min="0" max="1500" step="50" :value="clip.videoFadeOutMs" :disabled="readonly"
            @change="$emit('fades', { inMs: clip.videoFadeInMs, outMs: Number($event.target.value) })"
          />
        </label>
      </section>

      <section v-if="placement" class="ed-insp-section">
        <h4>{{ t('edit.linePlacement') }}</h4>
        <dl class="ed-insp-grid">
          <div><dt>{{ t('edit.speaker') }}</dt><dd>{{ placement.speaker_name || t('edit.narration') }}</dd></div>
          <div><dt>{{ t('edit.duration') }}</dt><dd>{{ formatPrecise(placement.duration_ms) }}</dd></div>
        </dl>
        <p class="ed-insp-text">{{ placement.text }}</p>
        <p v-if="placement.overflows_clip" class="ed-insp-warn">
          {{ t('edit.lineOverflow', { ms: placement.overflow_ms }) }}
        </p>
      </section>

      <section class="ed-insp-section">
        <h4>{{ t('edit.actions') }}</h4>
        <div class="ed-insp-actions" v-if="!readonly">
          <button type="button" :disabled="!canSplit" @click="$emit('split', splitOffsetMs)">
            <Scissors :size="12" /> {{ t('edit.split') }}
          </button>
          <button class="is-danger" type="button" @click="$emit('remove', { ripple: true })">
            <Trash2 :size="12" /> {{ t('edit.deleteClip') }}
          </button>
          <button class="is-muted" type="button" @click="$emit('remove', { ripple: false })">
            {{ t('edit.deleteKeepGap') }}
          </button>
        </div>
        <p v-else class="ed-insp-text">{{ t('edit.readonlyEdit') }}</p>
      </section>
    </template>

    <div v-else class="ed-insp-empty">
      <MousePointer2 :size="20" />
      <p>{{ t('edit.noSelection') }}</p>
    </div>

    <section class="ed-insp-section">
      <h4>{{ t('edit.project') }}</h4>
      <dl class="ed-insp-grid">
        <div><dt>{{ t('edit.resolution') }}</dt><dd>{{ state.plan.project.width }}×{{ state.plan.project.height }}</dd></div>
        <div><dt>{{ t('edit.fps') }}</dt><dd>{{ state.plan.project.fps }}</dd></div>
        <div><dt>{{ t('edit.aspect') }}</dt><dd>{{ state.plan.project.aspect }}</dd></div>
        <div><dt>{{ t('edit.tailGap') }}</dt><dd>{{ formatClock(state.plan.project.tailGapMs) }}</dd></div>
      </dl>
    </section>

    <section class="ed-insp-section">
      <h4>{{ t('edit.hashes') }}</h4>
      <dl class="ed-insp-hashes">
        <div><dt>{{ t('edit.planHash') }}</dt><dd>{{ state.hashes.plan_hash }}</dd></div>
        <div><dt>{{ t('edit.editSyncHash') }}</dt><dd>{{ state.hashes.edit_sync_hash }}</dd></div>
        <div><dt>{{ t('edit.renderHash') }}</dt><dd>{{ state.hashes.render_hash }}</dd></div>
        <div><dt>{{ t('edit.dialogueSyncHash') }}</dt><dd>{{ state.hashes.dialogue_sync_hash }}</dd></div>
        <div><dt>{{ t('edit.subtitleHash') }}</dt><dd>{{ state.hashes.subtitle_hash }}</dd></div>
      </dl>
    </section>

    <section class="ed-insp-section">
      <h4>{{ t('edit.audio') }}</h4>
      <p class="ed-insp-text">
        {{ state.audio?.mode === 'video' ? t('edit.audioModeVideo') : t('edit.audioModeNone') }}
      </p>
    </section>

    <section class="ed-insp-section">
      <h4>{{ t('edit.warnings') }}</h4>
      <p v-if="!state.media_warnings?.length" class="ed-insp-text">{{ t('edit.noWarnings') }}</p>
      <ul v-else class="ed-insp-warnings">
        <li v-for="warning in state.media_warnings" :key="`${warning.code}-${warning.path}`">
          <b>{{ warning.code }}</b> {{ warning.message }}
        </li>
      </ul>
    </section>
  </aside>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { MousePointer2, Scissors, Trash2 } from 'lucide-vue-next'
import { formatClock } from '~/utils/edit-plan'
import { formatPrecise } from '~/utils/edit-timecode'

const props = defineProps({
  plan: { type: Object, required: true },
  layout: { type: Object, required: true },
  clipId: { type: String, default: '' },
  placement: { type: Object, default: null },
  state: { type: Object, required: true },
  currentMs: { type: Number, default: 0 },
  readonly: { type: Boolean, default: false },
})
defineEmits(['trim-start', 'trim-end', 'speed', 'gap', 'fades', 'split', 'remove'])
const { t } = useI18n()

const clip = computed(() => props.plan.clips.find((item) => item.id === props.clipId) ?? null)
const layoutClip = computed(() => (
  props.layout.clips.find((item) => item.clip_id === props.clipId) ?? null
))
// 与 splitClip 的 minimumSourceMs 边界一致（3 秒按帧率折算），避免按钮可用但命令拒绝
const canSplit = computed(() => Boolean(
  layoutClip.value
  && props.currentMs - layoutClip.value.timeline_start_ms
    >= Math.ceil(3000 / Math.max(1, Number(props.plan.project?.fps) || 30))
  && layoutClip.value.timeline_end_ms - props.currentMs
    >= Math.ceil(3000 / Math.max(1, Number(props.plan.project?.fps) || 30)),
))
const splitOffsetMs = computed(() => (
  layoutClip.value ? Math.round(props.currentMs - layoutClip.value.timeline_start_ms) : 0
))
</script>

<style scoped>
.ed-inspector {
  min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
  gap: 10px; padding: 12px; border-left: 1px solid var(--border); background: var(--bg-1);
}
.ed-insp-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ed-insp-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.ed-insp-head span { flex: 0 0 auto; font-size: 9px; color: var(--text-3); }
.ed-insp-section { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
.ed-insp-section h4 { margin: 0; font-size: 10px; font-weight: 650; letter-spacing: .04em; color: var(--text-3); }
.ed-insp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 0; }
.ed-insp-grid div { min-width: 0; }
.ed-insp-grid dt { font-size: 9px; color: var(--text-3); }
.ed-insp-grid dd { margin: 0; overflow: hidden; text-overflow: ellipsis; font-size: 10px; color: var(--text-1); }
.ed-insp-row { display: flex; align-items: center; gap: 4px; }
.ed-insp-row span { flex: 1; font-size: 9px; color: var(--text-3); }
.ed-insp-row button, .ed-insp-actions button {
  height: 22px; padding: 0 6px; display: inline-flex; align-items: center; gap: 3px;
  border: 1px solid var(--border); border-radius: 5px; background: var(--bg-2);
  color: var(--text-1); font-size: 9px; cursor: pointer;
}
.ed-insp-row button:hover, .ed-insp-actions button:hover { border-color: var(--accent); }
.ed-insp-field { display: flex; flex-direction: column; gap: 3px; font-size: 9px; color: var(--text-3); }
.ed-insp-field input[type='range'] { width: 100%; accent-color: var(--accent); }
.ed-insp-field input[type='number'] {
  width: 100%; height: 26px; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-2); color: var(--text-0); font-size: 10px;
}
.ed-insp-text { margin: 0; font-size: 10px; color: var(--text-2); line-height: 1.5; }
.ed-insp-warn { margin: 0; font-size: 10px; color: var(--warning); line-height: 1.5; }
.ed-insp-actions { display: flex; flex-wrap: wrap; gap: 5px; }
.ed-insp-actions button.is-danger { color: var(--action-danger); border-color: color-mix(in srgb, var(--action-danger) 40%, var(--border)); }
.ed-insp-actions button.is-muted { color: var(--text-2); }
.ed-insp-actions button:disabled { opacity: .45; cursor: not-allowed; }
.ed-insp-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 8px; color: var(--text-3); }
.ed-insp-empty p { margin: 0; font-size: 10px; }
.ed-insp-hashes { display: flex; flex-direction: column; gap: 3px; margin: 0; }
.ed-insp-hashes div { display: flex; justify-content: space-between; gap: 8px; }
.ed-insp-hashes dt { flex: 0 0 auto; font-size: 9px; color: var(--text-3); }
.ed-insp-hashes dd {
  margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 9px; color: var(--text-2);
}
.ed-insp-warnings { margin: 0; padding-left: 14px; display: flex; flex-direction: column; gap: 4px; }
.ed-insp-warnings li { font-size: 9px; color: var(--text-2); line-height: 1.4; }
.ed-insp-warnings b { color: var(--warning); font-weight: 600; }
</style>
