<template>
  <div v-if="open" class="wb-mask" @click.self="close">
    <aside
      ref="panelEl"
      class="wb"
      role="dialog"
      aria-modal="true"
      :aria-label="t('workbench.quickPreview')"
      @keydown="onPanelKeydown"
    >
      <header class="wb-head">
        <div class="wb-title">
          <Mic :size="15" />
          <span>{{ t('workbench.quickPreview') }}</span>
          <span v-if="state" :class="['wb-chip', `is-${state.status}`]">{{ statusLabel }}</span>
        </div>
        <button class="wb-close" type="button" :aria-label="t('common.cancel')" @click="close">×</button>
      </header>

      <div v-if="serviceBanner" :class="['wb-banner', `is-${serviceBanner.kind}`]">
        <AlertCircle :size="14" class="wb-banner-icon" />
        <span class="wb-banner-text">{{ serviceBanner.text }}</span>
        <button v-if="serviceBanner.action" class="wb-banner-btn" type="button" @click="goSettings">
          {{ t('workbench.goSettings') }}
        </button>
      </div>

      <div class="wb-toolbar">
        <span class="wb-summary">{{ t('workbench.summary', { total: lines.length, ready: readyCount, failed: failedCount }) }}</span>
        <span class="wb-spacer" />
        <button class="btn btn-sm" type="button" :disabled="loading" @click="load">
          <RefreshCw :size="11" :class="{ 'animate-spin': loading }" />
          {{ t('common.refresh') }}
        </button>
        <button class="btn btn-sm is-primary" type="button" @click="openStage">
          {{ t('workbench.openStage') }}
          <ArrowRight :size="11" />
        </button>
      </div>

      <div v-if="state?.status === 'running'" class="wb-progress">
        <div class="wb-bar"><span :style="{ width: (state.progress || 0) + '%' }" /></div>
        <span>{{ state.progress }}% · {{ state.note }}</span>
      </div>
      <p v-else-if="state?.error" class="wb-error">{{ state.error }}</p>
      <p v-else-if="state?.status === 'done'" class="wb-ok">{{ t('workbench.doneHint') }}</p>

      <SubtitlePreview v-if="videoUrl || timelineCues.length" ref="preview" :src="videoUrl" :cues="timelineCues" />

      <div v-if="state?.outputUrl" class="wb-output">
        <a class="wb-link" :href="'/' + state.outputUrl" target="_blank" rel="noreferrer">{{ t('workbench.openVideo') }}</a>
        <button class="wb-link as-btn" type="button" :disabled="busy || !lines.length" @click="exportSubtitle('srt')">SRT</button>
        <button class="wb-link as-btn" type="button" :disabled="busy || !lines.length" @click="exportSubtitle('ass')">ASS</button>
      </div>

      <LineList
        :lines="lines"
        :busy="busy"
        :saving="saving"
        :empty-text="t('workbench.empty')"
        @play="play"
        @synthesize="synthesizeLine"
        @save="saveLineText"
        @locate="locateLine"
      />

      <footer class="wb-foot">
        <div class="wb-foot-info">
          <div class="wb-foot-title">
            <template v-if="selectedLine">#{{ selectedLine.lineNo }} · {{ selectedLine.speakerName || t('workbench.narrator') }}</template>
            <template v-else>{{ t('workbench.selectedLine') }}</template>
          </div>
          <div class="wb-foot-text">{{ selectedLine?.text || t('workbench.quickPreviewHint') }}</div>
        </div>
        <audio ref="player" class="wb-audio" controls />
      </footer>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { AlertCircle, ArrowRight, Mic, RefreshCw } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { StoryboardLine } from '~/composables/useApi'
import { useOverlayHistory } from '~/composables/useOverlayHistory'
import LineList from '~/components/LineList.vue'
import SubtitlePreview from '~/components/SubtitlePreview.vue'

const props = defineProps<{ open: boolean; episodeId: number | null; dramaId: number }>()
const emit = defineEmits<{ close: []; updated: []; 'open-stage': [] }>()
const { t } = useI18n()
const router = useRouter()

const session = useDubbingSession({
  episodeId: () => props.episodeId,
  dramaId: () => props.dramaId,
  onUpdated: () => emit('updated'),
})

const {
  lines,
  state,
  loading,
  saving,
  busy,
  readyCount,
  failedCount,
  statusLabel,
  serviceBanner,
  timelineCues,
  videoUrl,
  load,
  exportSubtitle,
  synthesizeLine,
  saveLineText,
} = session

const player = ref<HTMLAudioElement | null>(null)
const preview = ref<{ seekTo: (ms: number) => void } | null>(null)
const selectedLine = ref<StoryboardLine | null>(null)
const panelEl = ref<HTMLElement | null>(null)

// 快速预览是整页级覆盖层：登记返回层，Tab 在面板内循环，关闭后焦点归还触发元素
const panelHistory = useOverlayHistory(close)

function focusPanel() {
  const root = panelEl.value
  if (!root) return
  const focusables = Array.from(root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, audio[controls], video[controls], [tabindex]:not([tabindex="-1"])'))
    .filter(el => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true')
  focusables[0]?.focus()
}

function onPanelKeydown(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const root = panelEl.value
  if (!root) return
  const focusables = Array.from(root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, audio[controls], video[controls], [tabindex]:not([tabindex="-1"])'))
    .filter(el => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true')
  if (!focusables.length) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function mediaUrl(url: string) {
  return url.startsWith('/') || /^https?:\/\//i.test(url) ? url : `/${url}`
}

function play(line: StoryboardLine) {
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
  preview.value?.seekTo(cue.subtitleStartMs)
}

function goSettings() {
  close()
  router.push({ path: '/settings', query: { tab: 'dubbing' } })
}

function openStage() {
  emit('open-stage')
  close()
}

function close() {
  session.dispose()
  emit('close')
}

watch(() => [props.open, props.episodeId], ([open]) => {
  if (open) void load()
}, { immediate: true })

watch(() => props.open, (open) => {
  if (open) {
    panelHistory.open()
    nextTick(focusPanel)
  } else {
    panelHistory.close()
  }
}, { immediate: true })
</script>

<style scoped>
.wb-mask { position: fixed; inset: 0; background: rgba(0,0,0,.36); z-index: 80; display: flex; justify-content: flex-end; }
.wb { width: min(720px, 98vw); height: 100%; display: flex; flex-direction: column; gap: 10px; background: var(--bg-1, #fff); border-left: 1px solid var(--border); padding: 14px 16px; overflow: hidden; }
.wb-head { display: flex; align-items: center; justify-content: space-between; }
.wb-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; color: var(--text-1); }
.wb-close { background: none; border: none; font-size: 22px; line-height: 1; color: var(--text-3); cursor: pointer; }
.wb-banner { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); font-size: 11.5px; line-height: 1.5; }
.wb-banner.is-warn { color: #8a5a00; background: rgba(196, 138, 27, .1); border-color: rgba(196, 138, 27, .35); }
.wb-banner.is-error { color: #a3312d; background: rgba(217, 83, 79, .09); border-color: rgba(217, 83, 79, .35); }
.wb-banner.is-info { color: var(--text-2); background: rgba(127, 127, 127, .07); }
.wb-banner-icon { flex: none; }
.wb-banner-text { flex: 1; min-width: 0; }
.wb-banner-btn { background: none; border: 1px solid currentColor; border-radius: 6px; padding: 2px 9px; font: inherit; font-size: 11px; color: inherit; cursor: pointer; white-space: nowrap; }
.wb-banner-btn:hover { background: rgba(127, 127, 127, .1); }
.wb-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wb-summary { font-size: 11.5px; color: var(--text-2); }
.wb-spacer { flex: 1; }
.wb-chip { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: rgba(127,127,127,.14); color: var(--text-2); }
.wb-chip.is-done { color: #2e9e5b; background: rgba(46,158,91,.14); }
.wb-chip.is-running { color: #2b7bd6; background: rgba(43,123,214,.14); }
.wb-chip.is-failed { color: #d9534f; background: rgba(217,83,79,.14); }
.wb-chip.is-stale, .wb-chip.is-review { color: #c48a1b; background: rgba(196,138,27,.16); }
.wb-progress { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-2); }
.wb-bar { height: 6px; border-radius: 3px; background: rgba(127,127,127,.18); overflow: hidden; }
.wb-bar span { display: block; height: 100%; background: var(--accent, #2b7bd6); transition: width .3s; }
.wb-output { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wb-link { color: var(--accent, #2b7bd6); text-decoration: none; font-size: 11px; }
.wb-link.as-btn { background: none; border: none; padding: 0; cursor: pointer; }
.wb-link.as-btn:disabled { opacity: .45; cursor: default; }
.wb-error { color: #d9534f; font-size: 11px; margin: 0; }
.wb-ok { color: #2e9e5b; font-size: 11px; margin: 0; }
.wb-foot { display: flex; align-items: center; gap: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
.wb-foot-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wb-foot-title { font-size: 11.5px; font-weight: 600; color: var(--text-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wb-foot-text { font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wb-audio { width: min(320px, 48%); height: 32px; }
@media (max-width: 1180px) {
  .wb { max-height: var(--app-vvh, 100dvh); padding-bottom: calc(14px + var(--safe-bottom, 0px)); }
  .wb-close { min-width: var(--tap-min, 44px); min-height: var(--tap-min, 44px); }
}
@media (max-width: 900px) {
  .wb { width: 100%; }
  .wb-audio { width: 100%; min-height: 44px; }
  .wb-foot { flex-wrap: wrap; }
}
</style>
