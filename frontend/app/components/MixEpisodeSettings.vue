<script setup lang="ts">
import { computed } from 'vue'
import { Sparkles, Volume2, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  source: { filmId: number; kind: string; url: string; durationMs: number; hasAudio: boolean } | null
  warnings: { code: string; message: string }[]
  tracks: { role: string; muted: boolean; volume: number }[]
  soundscapeRunning: boolean
  canGenerateSound: boolean
  durationMs: number
  /** 简报 Produces 接口要求；本组件当前不直接消费，保留契约位 */
  separation?: { status?: string; progress?: number; step?: string; error?: string } | null
  hasAnyAudio?: boolean
}>()
const emit = defineEmits<{
  (e: 'change-source'): void
  (e: 'toggle-role', role: string, muted: boolean): void
  (e: 'set-role-volume', role: string, volume: number): void
  (e: 'generate-sound'): void
  (e: 'withdraw-sound'): void
  (e: 'open-export'): void
}>()
const { t } = useI18n()

// 三个声音开关（文案锚点）：保留原声 / 使用配音对白 / 播放背景音乐
const SWITCHES = [
  { role: 'original', labelKey: 'mix.episode.keepOriginal', hintKey: 'mix.episode.keepOriginalHint' },
  { role: 'voice', labelKey: 'mix.episode.useDialogue', hintKey: 'mix.episode.useDialogueHint' },
  { role: 'bgm', labelKey: 'mix.episode.playBgm', hintKey: 'mix.episode.playBgmHint' },
] as const

function trackOf(role: string) {
  return props.tracks.find((track) => track.role === role) ?? null
}
function percentOf(role: string): number {
  return Math.round((trackOf(role)?.volume ?? 1) * 100)
}
const nonConcat = computed(() => Boolean(props.source && props.source.kind !== 'concat'))
</script>

<template>
  <section class="mx-card episode-settings">
    <div class="mx-card-head">
      <span class="mx-chip is-accent">{{ t('mix.episode.title') }}</span>
    </div>

    <div class="mx-source-row">
      <span class="mx-source-label">{{ t('mix.episode.source') }}</span>
      <b>{{ t(`films.kind.${source?.kind || 'concat'}`) }}</b>
      <button class="mx-btn is-plain" type="button" @click="emit('change-source')">
        {{ t('mix.episode.changeSource') }}
      </button>
    </div>

    <p v-if="nonConcat" class="mx-note is-warning">{{ t('mix.episode.nonConcat') }}</p>
    <p v-for="warning in warnings" :key="warning.code" class="mx-note is-warning">
      <AlertTriangle :size="12" /> {{ warning.message }}
    </p>

    <div v-for="item in SWITCHES" :key="item.role" class="mx-switch-row">
      <div>
        <b>{{ t(item.labelKey) }}</b>
        <p class="mx-hint">{{ t(item.hintKey) }}</p>
      </div>
      <button
        :class="['mx-toggle', { on: !(trackOf(item.role)?.muted ?? false) }]"
        type="button"
        :aria-pressed="!(trackOf(item.role)?.muted ?? false)"
        @click="emit('toggle-role', item.role, !(trackOf(item.role)?.muted ?? false))"
      >
        {{ trackOf(item.role)?.muted ? t('mix.episode.off') : t('mix.episode.on') }}
      </button>
      <label class="mx-field">
        <span><Volume2 :size="11" /> {{ t('mix.episode.volume') }} {{ percentOf(item.role) }}%</span>
        <input
          class="mx-range"
          type="range"
          min="0"
          max="100"
          step="1"
          :value="percentOf(item.role)"
          @input="emit('set-role-volume', item.role, Number(($event.target as HTMLInputElement).value) / 100)"
        />
      </label>
    </div>

    <!-- 背景声入口（文案锚点：生成背景声） -->
    <button class="mx-btn is-primary" type="button" :disabled="!source || !canGenerateSound || soundscapeRunning" @click="emit('generate-sound')">
      <Sparkles :size="12" />
      {{ t('mix.episode.generateSound') }}
    </button>
    <button v-if="soundscapeRunning" class="mx-btn is-plain" type="button" @click="emit('withdraw-sound')">
      <RefreshCw :size="12" />
      {{ t('mix.soundscape.cancel') }}
    </button>
    <p class="mx-hint">{{ t('mix.episode.generateSoundHint') }}</p>

    <!-- 导出前检查 -->
    <div class="mx-check-summary">
      <b>{{ t('mix.episode.checkTitle') }}</b>
      <span><CheckCircle2 :size="11" /> {{ t('mix.episode.checkSource', { time: (source?.durationMs || 0) / 1000 }) }}</span>
      <span><CheckCircle2 :size="11" /> {{ t('mix.episode.checkDuration', { time: durationMs / 1000 }) }}</span>
      <button class="mx-btn is-plain" type="button" @click="emit('open-export')">
        {{ t('mix.episode.export') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
/* 样式复用检查器的 .mx-* 视觉语言；插槽内容取不到检查器 scoped 样式，这里按同值复制 */
.mx-card { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-0); }
.mx-card-head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.mx-chip { padding: 0 6px; border: 1px solid var(--border); border-radius: 999px; font-size: 9px; line-height: 15px; color: var(--text-2); white-space: nowrap; }
.mx-chip.is-accent { border-color: var(--accent-glow); background: var(--accent-bg); color: var(--accent-text); }
.mx-note { margin: 0; padding: 6px 8px; border-radius: 6px; font-size: 10px; line-height: 1.5; }
.mx-note.is-warning { background: var(--warning-bg); color: var(--warning); }
.mx-hint { margin: 0; font-size: 9.5px; line-height: 1.5; color: var(--text-3); }
.mx-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mx-field > span { font-size: 9.5px; color: var(--text-3); }
.mx-field > span b { color: var(--text-1); font-weight: 600; font-variant-numeric: tabular-nums; }
.mx-range { width: 100%; height: 14px; accent-color: var(--accent); cursor: pointer; }
.mx-toggle { height: 21px; padding: 0 7px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-1); color: var(--text-3); font: inherit; font-size: 9.5px; font-weight: 600; cursor: pointer; }
.mx-toggle.on { border-color: var(--accent-glow); background: var(--accent-bg); color: var(--accent-text); }
.mx-btn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: 1px solid var(--accent); border-radius: 5px; background: var(--accent); color: var(--action-primary-text); font: inherit; font-size: 10px; font-weight: 600; cursor: pointer; justify-content: center; }
.mx-btn.is-plain { border-color: var(--border); background: var(--bg-1); color: var(--text-1); }
.mx-btn.is-plain:hover { border-color: var(--accent); color: var(--accent-text); }
.mx-btn:disabled { opacity: .45; cursor: default; }
/* 新增类仅做布局 */
.mx-source-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 10.5px; color: var(--text-1); }
.mx-source-row .mx-btn { margin-left: auto; }
.mx-source-label { font-size: 9.5px; color: var(--text-3); }
.mx-switch-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: 1px dashed var(--border); }
.mx-switch-row > div { flex: 1; min-width: 0; }
.mx-switch-row > div b { font-size: 10.5px; color: var(--text-0); }
.mx-switch-row .mx-field { flex: none; width: 118px; }
.mx-check-summary { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding-top: 6px; border-top: 1px dashed var(--border); font-size: 9.5px; color: var(--text-2); }
.mx-check-summary b { font-size: 10px; color: var(--text-1); }
.mx-check-summary span { display: inline-flex; align-items: center; gap: 3px; }
</style>
