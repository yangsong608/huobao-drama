<template>
  <aside class="ed-inspector">
    <template v-if="cue">
      <header class="ed-insp-head">
        <b>{{ t('edit.subtitleEditTitle') }}</b>
        <span>{{ formatClockMs(cue.startMs) }} – {{ formatClockMs(cue.endMs) }}</span>
      </header>

      <section class="ed-insp-section">
        <h4>{{ t('edit.subtitleText') }}</h4>
        <textarea
          v-model="textDraft"
          class="ed-insp-textarea"
          rows="2"
          @change="emitPatch({ text: textDraft })"
        />
      </section>

      <section class="ed-insp-section">
        <h4>{{ t('edit.subtitleTime') }}</h4>
        <div class="ed-row">
          <label>{{ t('edit.startTime') }}
            <input :value="formatClockMs(cue.startMs)" @change="onStartInput($event)" />
          </label>
          <label>{{ t('edit.endTime') }}
            <input :value="formatClockMs(cue.endMs)" @change="onEndInput($event)" />
          </label>
        </div>
        <div class="ed-row">
          <button class="frameBack" type="button" @click="nudgeFrames(-1)">−1 {{ t('edit.frameUnit') }}</button>
          <button class="frameForward" type="button" @click="nudgeFrames(1)">+1 {{ t('edit.frameUnit') }}</button>
        </div>
        <div class="ed-row">
          <button class="alignPlayhead" type="button" @click="$emit('cue-align-start')">{{ t('edit.alignPlayheadStart') }}</button>
          <button class="alignPlayhead" type="button" @click="$emit('cue-align-end')">{{ t('edit.alignPlayheadEnd') }}</button>
        </div>
        <label class="ed-check">
          <input type="checkbox" :checked="cue.follow" @change="$emit('cue-follow', $event.target.checked)" />
          {{ t('edit.followClip') }}
        </label>
      </section>

      <section v-if="!subtitleStylesEnabled" class="ed-insp-section ed-insp-note">
        <p>{{ t('edit.subtitleStylesDisabled') }}</p>
      </section>

      <section v-if="subtitleStylesEnabled" class="ed-insp-section">
        <h4>{{ t('edit.subtitleStyle') }}</h4>
        <label class="ed-insp-field">
          <span>{{ t('edit.fontFamily') }}</span>
          <select v-model="styleDraft.fontFamily" @change="applyStyleDraft()">
            <option v-for="f in fonts" :key="f" :value="f">{{ f }}</option>
          </select>
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.fontSize') }} {{ styleDraft.fontSize }}px</span>
          <input type="range" min="12" max="120" v-model.number="styleDraft.fontSize" @change="applyStyleDraft()" />
        </label>
        <div class="ed-row">
          <label>{{ t('edit.textColor') }} <input type="color" v-model="styleDraft.color" @change="applyStyleDraft()" /></label>
          <label>{{ t('edit.strokeColor') }} <input type="color" v-model="styleDraft.strokeColor" @change="applyStyleDraft()" /></label>
        </div>
        <label class="ed-insp-field">
          <span>{{ t('edit.strokeWidth') }} {{ styleDraft.strokeWidth }}</span>
          <input type="range" min="0" max="8" step="0.5" v-model.number="styleDraft.strokeWidth" @change="applyStyleDraft()" />
        </label>
        <div class="ed-row">
          <label>{{ t('edit.backgroundColor') }} <input type="color" v-model="bgColor" @change="applyStyleDraft()" /></label>
          <label>{{ t('edit.backgroundOpacity') }}
            <input type="range" min="0" max="100" v-model.number="styleDraft.backgroundOpacity" @change="applyStyleDraft()" />
          </label>
        </div>
        <div class="ed-row" role="radiogroup">
          <button v-for="a in ['left', 'center', 'right']" :key="a" type="button"
            :class="{ 'is-on': styleDraft.align === a }" @click="styleDraft.align = a; applyStyleDraft()">
            {{ t(`edit.align_${a}`) }}
          </button>
        </div>
      </section>

      <section v-if="subtitleStylesEnabled" class="ed-insp-section">
        <h4>{{ t('edit.subtitlePosition') }}</h4>
        <div class="ed-row" role="radiogroup">
          <button type="button" :class="{ 'is-on': styleDraft.yPct <= 33 }" @click="setPosition(styleDraft.xPct ?? 50, 12)">{{ t('edit.posTop') }}</button>
          <button type="button" :class="{ 'is-on': styleDraft.yPct > 33 && styleDraft.yPct <= 66 }" @click="setPosition(styleDraft.xPct ?? 50, 50)">{{ t('edit.posMiddle') }}</button>
          <button type="button" :class="{ 'is-on': styleDraft.yPct > 66 }" @click="setPosition(styleDraft.xPct ?? 50, 85)">{{ t('edit.posBottom') }}</button>
        </div>
        <div class="ed-nineGrid" role="radiogroup">
          <button v-for="cell in NINE_GRID" :key="cell.key" type="button"
            :class="{ 'is-on': cell.x === (styleDraft.xPct ?? 50) && cell.y === (styleDraft.yPct ?? 85) }"
            :title="`${cell.x}, ${cell.y}`"
            @click="setPosition(cell.x, cell.y)" />
        </div>
        <div class="ed-row">
          <label>X <input type="range" min="0" max="100" v-model.number="styleDraft.xPct" @change="applyStyleDraft()" /></label>
          <label>Y <input type="range" min="0" max="100" v-model.number="styleDraft.yPct" @change="applyStyleDraft()" /></label>
        </div>
        <label class="ed-check">
          <input type="checkbox" v-model="showSafeAreaLocal" /> {{ t('edit.showSafeArea') }}
        </label>
        <p v-if="outOfBounds" class="ed-insp-warn">{{ t('edit.subtitleOutOfBounds') }}</p>
      </section>

      <section v-if="subtitleStylesEnabled" class="ed-insp-section">
        <h4>{{ t('edit.subtitleBatch') }}</h4>
        <div class="ed-row">
          <button type="button" @click="$emit('cue-apply-all', effectiveAppearance)">{{ t('edit.applyAll') }}</button>
          <button type="button" @click="$emit('cue-set-default', effectiveAppearance)">{{ t('edit.setDefault') }}</button>
        </div>
      </section>

      <section class="ed-insp-section">
        <h4>{{ t('edit.subtitleActions') }}</h4>
        <div class="ed-row">
          <button class="is-danger" type="button" @click="$emit('cue-delete')">{{ t('edit.deleteCue') }}</button>
          <button type="button" @click="$emit('cue-split')">{{ t('edit.splitAtPlayhead') }}</button>
          <button type="button" @click="$emit('cue-merge-next')">{{ t('edit.mergeNext') }}</button>
        </div>
      </section>
    </template>

    <template v-else-if="clip">
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
import { formatClock, SUBTITLE_FONT_WHITELIST, resolveCueAppearance } from '~/utils/edit-plan'
import { formatPrecise, formatClockMs, parseClockMs, frameDurationMs } from '~/utils/edit-timecode'

const props = defineProps({
  plan: { type: Object, required: true },
  layout: { type: Object, required: true },
  clipId: { type: String, default: '' },
  placement: { type: Object, default: null },
  state: { type: Object, required: true },
  currentMs: { type: Number, default: 0 },
  readonly: { type: Boolean, default: false },
  cue: { type: Object, default: null },
  /** edit.ux.subtitleStyles：关闭时只隐藏样式/位置/批量外观区，文本与时间不受影响 */
  subtitleStylesEnabled: { type: Boolean, default: true },
})
const emit = defineEmits([
  'trim-start', 'trim-end', 'speed', 'gap', 'fades', 'split', 'remove',
  'cue-update', 'cue-apply-all', 'cue-set-default', 'cue-delete', 'cue-split',
  'cue-merge-next', 'cue-align-start', 'cue-align-end', 'cue-follow',
])
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

// ---- 字幕编辑（cue 页） ----
const fonts = SUBTITLE_FONT_WHITELIST
const NINE_GRID = [
  { key: 'tl', x: 12, y: 12 }, { key: 'tc', x: 50, y: 12 }, { key: 'tr', x: 88, y: 12 },
  { key: 'ml', x: 12, y: 50 }, { key: 'mc', x: 50, y: 50 }, { key: 'mr', x: 88, y: 50 },
  { key: 'bl', x: 12, y: 85 }, { key: 'bc', x: 50, y: 85 }, { key: 'br', x: 88, y: 85 },
]

function defaultStyleDraft() {
  const base = props.cue
    ? resolveCueAppearance(props.cue, props.plan.project)
    : null
  return {
    fontFamily: base?.fontFamily ?? 'PingFang SC',
    fontSize: Number(base?.fontSize ?? 48),
    color: base?.color ?? '#FFFFFF',
    strokeColor: base?.strokeColor ?? '#000000',
    strokeWidth: Number(base?.strokeWidth ?? 2),
    backgroundColor: base?.backgroundColor ?? null,
    backgroundOpacity: Number(base?.backgroundOpacity ?? 0),
    align: base?.align ?? 'center',
    xPct: Number(base?.xPct ?? 50),
    yPct: Number(base?.yPct ?? 85),
  }
}

const textDraft = ref('')
const styleDraft = ref(defaultStyleDraft())
const showSafeAreaLocal = ref(false)

watch(
  () => props.cue,
  (cue) => {
    if (!cue) return
    textDraft.value = String(cue.text ?? '')
    styleDraft.value = defaultStyleDraft()
  },
  { immediate: true, deep: true },
)

const effectiveAppearance = computed(() => ({ ...styleDraft.value }))

// 背景色允许为 null（无背景），color input 需要一个具体色值
const bgColor = computed({
  get: () => styleDraft.value.backgroundColor ?? '#000000',
  set: (value) => { styleDraft.value.backgroundColor = value },
})

const safeAreaPct = computed(() => (
  Math.max(0, Number(props.plan.project?.subtitleSafeAreaPct ?? 8))
))
const outOfBounds = computed(() => (
  styleDraft.value.xPct < safeAreaPct.value
  || styleDraft.value.xPct > 100 - safeAreaPct.value
  || styleDraft.value.yPct < safeAreaPct.value
  || styleDraft.value.yPct > 100 - safeAreaPct.value
))

function emitPatch(patch) {
  emit('cue-update', patch)
}

function applyStyleDraft() {
  emit('cue-update', { appearance: { ...styleDraft.value } })
}

function setPosition(x, y) {
  styleDraft.value.xPct = x
  styleDraft.value.yPct = y
  applyStyleDraft()
}

function nudgeFrames(delta) {
  if (!props.cue) return
  const frame = frameDurationMs(props.plan.project?.fps ?? 30)
  const shift = Math.round(frame * (Number(delta) || 0))
  emit('cue-update', {
    startMs: Math.max(0, Math.round(props.cue.startMs) + shift),
    endMs: Math.max(0, Math.round(props.cue.endMs) + shift),
  })
}

function onStartInput(event) {
  const value = parseClockMs(event.target.value)
  if (!Number.isFinite(value) || !props.cue) {
    event.target.value = formatClockMs(props.cue?.startMs ?? 0)
    return
  }
  emit('cue-update', { startMs: Math.max(0, value), endMs: Math.round(props.cue.endMs) })
}

function onEndInput(event) {
  const value = parseClockMs(event.target.value)
  if (!Number.isFinite(value) || !props.cue) {
    event.target.value = formatClockMs(props.cue?.endMs ?? 0)
    return
  }
  emit('cue-update', { startMs: Math.round(props.cue.startMs), endMs: Math.max(0, value) })
}
</script>

<style scoped>
.ed-inspector {
  min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
  gap: 10px; padding: 12px; border-left: 1px solid var(--border); background: var(--bg-1);
}
.ed-insp-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ed-insp-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.ed-insp-head span { flex: 0 0 auto; font-size: var(--text-micro); color: var(--text-3); }
.ed-insp-section { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
.ed-insp-section h4 { margin: 0; font-size: var(--text-micro); font-weight: 650; letter-spacing: .04em; color: var(--text-3); }
.ed-insp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 0; }
.ed-insp-grid div { min-width: 0; }
.ed-insp-grid dt { font-size: var(--text-micro); color: var(--text-3); }
.ed-insp-grid dd { margin: 0; overflow: hidden; text-overflow: ellipsis; font-size: var(--text-micro); color: var(--text-1); }
.ed-insp-row { display: flex; align-items: center; gap: 4px; }
.ed-insp-row span { flex: 1; font-size: var(--text-micro); color: var(--text-3); }
.ed-insp-row button, .ed-insp-actions button {
  height: 22px; padding: 0 6px; display: inline-flex; align-items: center; gap: 3px;
  border: 1px solid var(--border); border-radius: 5px; background: var(--bg-2);
  color: var(--text-1); font-size: var(--text-micro); cursor: pointer;
}
.ed-insp-row button:hover, .ed-insp-actions button:hover { border-color: var(--accent); }
.ed-insp-row button.is-on { border-color: var(--accent); color: var(--accent-text); background: var(--accent-bg); }
.ed-insp-row button.is-danger { color: var(--action-danger); border-color: color-mix(in srgb, var(--action-danger) 40%, var(--border)); }
.ed-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: var(--text-micro); color: var(--text-3); }
.ed-row label { display: inline-flex; align-items: center; gap: 4px; }
.ed-row input[type='range'] { width: 90px; accent-color: var(--accent); }
.ed-row input[type='color'] { width: 24px; height: 20px; padding: 0; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-2); cursor: pointer; }
.ed-row input[type='text'], .ed-row input:not([type]) {
  width: 82px; height: 22px; padding: 0 5px; border: 1px solid var(--border); border-radius: 5px;
  background: var(--bg-2); color: var(--text-0); font-size: var(--text-micro); font-variant-numeric: tabular-nums;
}
.ed-row select {
  height: 24px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-2);
  color: var(--text-0); font-size: var(--text-micro);
}
.ed-check { display: inline-flex; align-items: center; gap: 5px; font-size: var(--text-micro); color: var(--text-2); cursor: pointer; }
.ed-check input { accent-color: var(--accent); }
.ed-nineGrid {
  display: grid; grid-template-columns: repeat(3, 26px); grid-auto-rows: 18px; gap: 4px; width: fit-content;
}
.ed-nineGrid button {
  border: 1px solid var(--border); border-radius: 4px; background: var(--bg-2); cursor: pointer; padding: 0;
}
.ed-nineGrid button:hover { border-color: var(--accent); }
.ed-nineGrid button.is-on { background: var(--accent-bg); border-color: var(--accent); }
.ed-insp-textarea {
  width: 100%; min-height: 44px; padding: 5px 7px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-2); color: var(--text-0); font-size: 11px; line-height: 1.5; resize: vertical;
}
.ed-insp-field { display: flex; flex-direction: column; gap: 3px; font-size: var(--text-micro); color: var(--text-3); }
.ed-insp-field input[type='range'] { width: 100%; accent-color: var(--accent); }
.ed-insp-field input[type='number'] {
  width: 100%; height: 26px; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-2); color: var(--text-0); font-size: var(--text-micro);
}
.ed-insp-text { margin: 0; font-size: var(--text-micro); color: var(--text-2); line-height: 1.5; }
.ed-insp-note p { margin: 0; font-size: var(--text-micro); color: var(--text-3); line-height: 1.5; }
.ed-insp-warn { margin: 0; font-size: var(--text-micro); color: var(--warning); line-height: 1.5; }
.ed-insp-actions { display: flex; flex-wrap: wrap; gap: 5px; }
.ed-insp-actions button.is-danger { color: var(--action-danger); border-color: color-mix(in srgb, var(--action-danger) 40%, var(--border)); }
.ed-insp-actions button.is-muted { color: var(--text-2); }
.ed-insp-actions button:disabled { opacity: .45; cursor: not-allowed; }
.ed-insp-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 8px; color: var(--text-3); }
.ed-insp-empty p { margin: 0; font-size: var(--text-micro); }
.ed-insp-hashes { display: flex; flex-direction: column; gap: 3px; margin: 0; }
.ed-insp-hashes div { display: flex; justify-content: space-between; gap: 8px; }
.ed-insp-hashes dt { flex: 0 0 auto; font-size: var(--text-micro); color: var(--text-3); }
.ed-insp-hashes dd {
  margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: var(--text-micro); color: var(--text-2);
}
.ed-insp-warnings { margin: 0; padding-left: 14px; display: flex; flex-direction: column; gap: 4px; }
.ed-insp-warnings li { font-size: var(--text-micro); color: var(--text-2); line-height: 1.4; }
.ed-insp-warnings b { color: var(--warning); font-weight: 600; }
</style>
