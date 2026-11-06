<template>
  <article
    :class="['mx-th', { 'is-active': active, 'is-virtual': track.virtual, 'is-muted': track.effectiveMuted }]"
    :style="{ height: `${height}px`, '--track-color': track.color || '#38bdf8' }"
    @click="emit('select', track)"
  >
    <header class="mx-th-head">
      <span class="mx-th-dot" />
      <span class="mx-th-role">{{ roleLabel }}</span>
      <input
        v-if="!track.virtual"
        class="mx-th-name"
        :value="track.name"
        :title="track.name"
        :aria-label="t('mix.trackName')"
        @click.stop
        @change="rename"
      />
      <span v-else class="mx-th-name is-readonly" :title="track.name">{{ track.name }}</span>
      <span v-if="track.origin === 'soundscape'" class="mx-th-auto is-ai" :title="t('mix.soundscape.aiTrack')">{{ t('mix.soundscape.aiBadge') }}</span>
      <span v-if="track.virtual" class="mx-th-auto">{{ t('mix.trackVirtual') }}</span>
      <button
        v-if="!track.virtual"
        :class="['mx-th-icon', { on: track.locked }]"
        type="button"
        :title="track.locked ? t('mix.trackUnlock') : t('mix.trackLock')"
        @click.stop="toggle('locked')"
      >
        <Lock v-if="track.locked" :size="11" />
        <LockOpen v-else :size="11" />
      </button>
      <button
        v-if="!track.virtual"
        :class="['mx-th-icon', { on: track.hidden }]"
        type="button"
        :title="track.hidden ? t('mix.trackShow') : t('mix.trackHide')"
        @click.stop="toggle('hidden')"
      >
        <EyeOff v-if="track.hidden" :size="11" />
        <Eye v-else :size="11" />
      </button>
      <button
        v-if="!track.virtual"
        class="mx-th-icon is-danger"
        type="button"
        :title="t('mix.trackRemove')"
        @click.stop="emit('remove', track)"
      >
        <Trash2 :size="11" />
      </button>
    </header>

    <div class="mx-th-row">
      <button :class="['mx-th-toggle', { on: track.muted }]" type="button" :title="t('mix.trackMute')" @click.stop="toggle('muted')">{{ t('mix.trackMuteShort') }}</button>
      <button :class="['mx-th-toggle', { on: track.solo }]" type="button" :title="t('mix.trackSolo')" @click.stop="toggle('solo')">{{ t('mix.trackSoloShort') }}</button>
      <button v-if="!track.virtual" :class="['mx-th-toggle', { on: track.ducking }]" type="button" :title="t('mix.trackDuck')" @click.stop="toggle('ducking')">{{ t('mix.trackDuckShort') }}</button>
      <button :class="['mx-th-toggle', { on: track.loop }]" type="button" :title="t('mix.trackLoop')" @click.stop="toggle('loop')">{{ t('mix.trackLoopShort') }}</button>
      <span v-if="track.virtual" class="mx-th-note">{{ t(track.role === 'voice' ? 'mix.trackVirtualVoiceHint' : 'mix.trackVirtualHint', { n: track.clips.length }) }}</span>
      <span v-else class="mx-th-clips">{{ t('mix.clipCount', { n: track.clips.length }) }}</span>
    </div>

    <div class="mx-th-row is-faders">
      <span class="mx-th-fader-label" :title="t('mix.trackVolume')">{{ volumePct }}%</span>
      <input
        class="mx-th-range"
        type="range"
        min="0"
        max="200"
        step="1"
        :value="volumePct"
        :aria-label="t('mix.trackVolume')"
        @pointerdown.stop="emit('begin-change')"
        @pointerup.stop="emit('end-change')"
        @input.stop="setVolume"
        @change.stop="emit('end-change')"
      />
      <span class="mx-th-fader-label is-pan" :title="t('mix.trackPan')">{{ panLabel }}</span>
      <input
        class="mx-th-range is-pan"
        type="range"
        min="-100"
        max="100"
        step="1"
        :value="panPct"
        :aria-label="t('mix.trackPan')"
        @pointerdown.stop="emit('begin-change')"
        @pointerup.stop="emit('end-change')"
        @input.stop="setPan"
        @change.stop="emit('end-change')"
      />
      <span
        class="mx-th-meter"
        :title="t('mix.levelGain')"
        aria-hidden="true"
      ><i :style="{ height: `${meterPct}%` }" /></span>
    </div>

    <span
      v-if="!track.virtual"
      class="mx-th-resize"
      :title="t('mix.trackResize')"
      @pointerdown.stop.prevent="onResizeDown"
      @pointermove.stop="onResizeMove"
      @pointerup.stop="onResizeUp"
      @pointercancel.stop="onResizeUp"
    />
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, EyeOff, Lock, LockOpen, Trash2 } from 'lucide-vue-next'
import type { StageTrack } from '~/composables/useMixStage'

const props = defineProps<{
  track: StageTrack
  active: boolean
}>()

const emit = defineEmits<{
  select: [track: StageTrack]
  update: [track: StageTrack, patch: Record<string, unknown>]
  remove: [track: StageTrack]
  resize: [track: StageTrack, height: number]
  'begin-change': []
  'end-change': []
}>()

const { t } = useI18n()

const ROLE_KEYS: Record<string, string> = {
  dialogue: 'mix.roleDialogue',
  voice: 'mix.roleDialogue',
  crowd: 'mix.roleCrowd',
  original: 'mix.roleOriginal',
  ambience: 'mix.roleAmbience',
  sfx: 'mix.roleSfx',
  bgm: 'mix.roleBgm',
  custom: 'mix.roleCustom',
}

const roleLabel = computed(() => {
  const key = ROLE_KEYS[props.track.role]
  return key ? t(key) : props.track.role
})
const height = computed(() => Math.min(160, Math.max(56, Number(props.track.height) || 72)))
const volumePct = computed(() => Math.round((Number(props.track.volume) || 0) * 100))
const panPct = computed(() => Math.round((Number(props.track.pan) || 0) * 100))
const panLabel = computed(() => {
  const pan = Number(props.track.pan) || 0
  if (Math.abs(pan) < 0.02) return t('mix.panCenter')
  const amount = Math.round(Math.abs(pan) * 100)
  return pan < 0 ? t('mix.panLeft', { n: amount }) : t('mix.panRight', { n: amount })
})
const meterPct = computed(() => {
  if (props.track.effectiveMuted || props.track.hidden) return 0
  return Math.max(2, Math.round(Math.min(1, Math.max(0, Number(props.track.volume) || 0)) * 100))
})

function toggle(key: 'muted' | 'solo' | 'ducking' | 'loop' | 'locked' | 'hidden') {
  if (props.track.virtual && key !== 'muted' && key !== 'solo' && key !== 'loop') return
  emit('update', props.track, { [key]: !props.track[key] })
}

function rename(event: Event) {
  const input = event.target as HTMLInputElement
  const name = input.value.trim()
  if (!name || name === props.track.name) {
    input.value = props.track.name
    return
  }
  emit('update', props.track, { name })
}

function setVolume(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  emit('update', props.track, { volume: value / 100 })
}

function setPan(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  emit('update', props.track, { pan: value / 100 })
}

let resizing = false
let startY = 0
let startHeight = 0

function onResizeDown(event: PointerEvent) {
  if (props.track.virtual) return
  resizing = true
  startY = event.clientY
  startHeight = height.value
  emit('begin-change')
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onResizeMove(event: PointerEvent) {
  if (!resizing) return
  const next = Math.min(160, Math.max(56, startHeight + event.clientY - startY))
  emit('resize', props.track, Math.round(next))
}

function onResizeUp(event: PointerEvent) {
  if (!resizing) return
  resizing = false
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  emit('end-change')
}
</script>

<style scoped>
.mx-th {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px 8px 6px;
  border-bottom: 1px solid var(--border);
  border-left: 3px solid var(--track-color);
  background: var(--bg-1);
  overflow: hidden;
  cursor: default;
}
.mx-th.is-active { background: var(--bg-2); box-shadow: inset 0 0 0 1px var(--accent-glow); }
.mx-th.is-virtual { background: repeating-linear-gradient(135deg, var(--bg-1) 0 6px, var(--bg-0) 6px 12px); }
.mx-th.is-muted { opacity: .68; }
.mx-th-head { display: flex; align-items: center; gap: 5px; min-height: 18px; }
.mx-th-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--track-color); }
.mx-th-role { flex: none; padding: 0 5px; border-radius: 999px; background: var(--bg-0); font-size: 9px; line-height: 14px; color: var(--text-3); white-space: nowrap; }
.mx-th-name { flex: 1; min-width: 0; height: 18px; padding: 0 4px; border: 1px solid transparent; border-radius: 4px; background: transparent; font: inherit; font-size: 11px; font-weight: 600; color: var(--text-0); text-overflow: ellipsis; }
.mx-th-name:hover, .mx-th-name:focus { border-color: var(--border); background: var(--bg-0); outline: none; }
.mx-th-name.is-readonly { font-weight: 500; color: var(--text-2); white-space: nowrap; overflow: hidden; }
.mx-th-auto { flex: none; font-size: 9px; color: var(--accent-text); }
.mx-th-auto.is-ai { padding: 0 4px; border-radius: 999px; background: var(--accent-bg); color: var(--accent-text); font-weight: 600; }
.mx-th-icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; padding: 0; border: none; border-radius: 4px; background: transparent; color: var(--text-3); cursor: pointer; }
.mx-th-icon:hover { color: var(--text-0); background: var(--bg-hover); }
.mx-th-icon.on { color: var(--accent-text); }
.mx-th-icon.is-danger:hover { color: var(--action-danger); background: var(--action-danger-bg); }
.mx-th-row { display: flex; align-items: center; gap: 3px; min-height: 17px; }
.mx-th-toggle { width: auto; min-width: 19px; height: 17px; padding: 0 3px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-0); color: var(--text-3); font: inherit; font-size: 8.5px; font-weight: 700; line-height: 1; white-space: nowrap; cursor: pointer; }
.mx-th-toggle:hover { color: var(--text-1); }
.mx-th-toggle.on { border-color: var(--accent-glow); background: var(--accent-bg); color: var(--accent-text); }
.mx-th-clips { margin-left: auto; font-size: 9px; color: var(--text-3); white-space: nowrap; }
.mx-th-note { font-size: 9.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mx-th-row.is-faders { gap: 4px; }
.mx-th-fader-label { flex: none; width: 30px; font-size: 9px; color: var(--text-3); font-variant-numeric: tabular-nums; }
.mx-th-fader-label.is-pan { width: 30px; text-align: right; }
.mx-th-range { flex: 1; min-width: 24px; height: 12px; accent-color: var(--accent); cursor: pointer; }
.mx-th-range.is-pan { flex: none; width: 32px; }
.mx-th-meter { flex: none; display: flex; align-items: flex-end; width: 4px; height: 14px; border-radius: 2px; background: var(--bg-3); overflow: hidden; }
.mx-th-meter i { display: block; width: 100%; border-radius: 2px; background: linear-gradient(0deg, var(--success), var(--warning) 72%, var(--error)); }
.mx-th-resize { position: absolute; left: 0; right: 0; bottom: 0; height: 5px; cursor: ns-resize; }
.mx-th-resize::after { content: ''; position: absolute; left: 50%; bottom: 2px; width: 22px; height: 1px; margin-left: -11px; background: var(--border-strong); opacity: 0; }
.mx-th:hover .mx-th-resize::after { opacity: .8; }
</style>
