<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import { thumbFallback, thumbOf } from '~/composables/useMedia'

const props = defineProps<{
  visible: boolean
  storyboard: any
  boundRefAssets: any[]
  frameAssets: any[]
  previousShotFrameRef: any
  frameAssetBusyId: number | null
  durationMax: number
  durationOverLimit: boolean
  effectiveVideoDuration: number
  effectiveSummary: string
  actionLabel: string
  actionDisabled: boolean
  readonlyTitle?: string
  isWan3Video: boolean
  preflightReport: any
  preflightStale: boolean
  preflightBusy: boolean
  acceptanceReport: any
  acceptanceStale: boolean
  acceptanceBusy: boolean
  verdictLabel: (verdict: string) => string
}>()

const emit = defineEmits<{
  'open-viewer': [src: string, title: string]
  'clear-first-frame': []
  'set-first-frame': [asset: any]
  'remove-frame-asset': [asset: any]
  'run-preflight': []
  'run-acceptance': []
  generate: []
}>()

const { t } = useI18n()

function assetSrc(asset: any) {
  const raw = asset?.imageUrl || asset?.image_url || ''
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw
  return `/${raw}`
}

function videoUrl(value: string) {
  if (!value) return ''
  return /^https?:\/\//i.test(value) ? value : '/' + value.replace(/^\/+/, '')
}

function currentFirstFrame() {
  return videoUrl(props.storyboard?.first_frame_image || props.storyboard?.firstFrameImage || '')
}
</script>

<template>
  <div class="video-inspector-body" v-show="visible">
    <section class="video-inspector-section">
      <div class="video-inspector-prompt-head">
        <span class="video-inspector-label">{{ t('episode.inspector.boundRefs') }}</span>
        <span class="tag mono">{{ boundRefAssets.length }}</span>
      </div>
      <div v-if="boundRefAssets.length" class="video-bound-refs">
        <button
          v-for="asset in boundRefAssets"
          :key="asset.key"
          type="button"
          class="video-bound-ref"
          :disabled="!asset.ready"
          :title="`${asset.name} · ${asset.typeLabel}`"
          @click="asset.ready && emit('open-viewer', assetSrc(asset), `${asset.name} · ${asset.typeLabel}`)"
        >
          <img v-if="asset.ready" :src="thumbOf(assetSrc(asset))" :alt="asset.name" loading="lazy" @error="thumbFallback($event, assetSrc(asset))" />
          <span v-else class="video-bound-ref-empty">{{ asset.kind === 'scene' ? t('episode.ref.shortScene') : asset.kind === 'prop' ? t('episode.ref.shortProp') : t('episode.ref.shortChar') }}</span>
          <small>{{ asset.name }}</small>
        </button>
      </div>
      <div v-else class="video-bound-refs-empty">{{ t('episode.inspector.noBoundRefs') }}</div>
    </section>
    <section class="video-inspector-section">
      <div class="video-inspector-prompt-head">
        <span class="video-inspector-label">{{ t('episode.frameAssets.title') }}</span>
        <span class="tag mono">{{ t('episode.frameAssets.onlyThisEpisode') }}</span>
      </div>
      <p class="voice-reference-hint">{{ t('episode.frameAssets.scopeHint') }}</p>
      <div v-if="previousShotFrameRef" class="frame-asset-current">
        <img :src="videoUrl(previousShotFrameRef.url)" class="frame-asset-current-thumb" alt="" loading="lazy" />
        <div class="frame-asset-current-meta">
          <span>{{ t('episode.frameAssets.previousRef') }}</span>
          <span class="dim">@{{ previousShotFrameRef.token }}</span>
          <span v-if="!currentFirstFrame() && !isWan3Video" class="tag tag-success">{{ t('episode.frameAssets.autoFirstFrame') }}</span>
        </div>
      </div>
      <div class="frame-asset-current">
        <template v-if="currentFirstFrame()">
          <img :src="currentFirstFrame()" class="frame-asset-current-thumb" alt="" loading="lazy" />
          <div class="frame-asset-current-meta">
            <span>{{ t('episode.frameAssets.current') }}</span>
            <button type="button" class="btn btn-sm" @click="emit('clear-first-frame')">
              {{ t('episode.frameAssets.clearFirstFrame') }}
            </button>
          </div>
        </template>
        <span v-else class="dim">{{ t('episode.frameAssets.noFirstFrame') }}</span>
      </div>
      <div class="frame-asset-bind-hint">{{ t('episode.frameAssets.bindHint') }}</div>
      <div v-if="frameAssets.length" class="frame-asset-grid">
        <div v-for="asset in frameAssets" :key="asset.id" class="frame-asset-card">
          <img :src="asset.src" alt="" loading="lazy" />
          <div class="frame-asset-card-foot">
            <span class="frame-asset-shot">{{ t('episode.frameAssets.sourceShot', { n: asset.shotNumber }) }}</span>
            <button
              v-if="!asset.current"
              type="button"
              class="btn btn-sm"
              :disabled="frameAssetBusyId === asset.id"
              @click="emit('set-first-frame', asset)"
            >
              <Loader2 v-if="frameAssetBusyId === asset.id" :size="11" class="animate-spin" />
              {{ t('episode.frameAssets.useAsFirstFrame') }}
            </button>
            <span v-else class="tag mono">{{ t('episode.frameAssets.fromCurrentShot') }}</span>
            <button
              type="button"
              class="frame-asset-del"
              :title="t('episode.frameAssets.delete')"
              :aria-label="t('episode.frameAssets.delete')"
              @click.stop="emit('remove-frame-asset', asset)"
            >×</button>
          </div>
        </div>
      </div>
      <div v-else class="video-bound-refs-empty">{{ t('episode.frameAssets.empty') }}</div>
    </section>
    <section class="video-inspector-section visual-check-section">
      <div class="video-inspector-prompt-head">
        <span class="video-inspector-label">{{ t('episode.visualCheck.title') }}</span>
        <span class="tag mono">{{ t('episode.visualCheck.hintTag') }}</span>
      </div>
      <p class="voice-reference-hint">{{ t('episode.visualCheck.hint') }}</p>
      <div class="visual-check-actions">
        <button
          type="button"
          class="btn btn-sm"
          :disabled="preflightBusy || !storyboard || !(storyboard.video_prompt || storyboard.videoPrompt)"
          :title="!(storyboard.video_prompt || storyboard.videoPrompt) ? t('episode.visualCheck.needPrompt') : undefined"
          @click="emit('run-preflight')"
        >
          <Loader2 v-if="preflightBusy" :size="11" class="animate-spin" />
          {{ preflightBusy ? t('episode.visualCheck.runningPreflight') : t('episode.visualCheck.runPreflight') }}
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :disabled="acceptanceBusy || !storyboard || !(storyboard.video_url || storyboard.videoUrl)"
          :title="!(storyboard.video_url || storyboard.videoUrl) ? t('episode.visualCheck.needVideo') : undefined"
          @click="emit('run-acceptance')"
        >
          <Loader2 v-if="acceptanceBusy" :size="11" class="animate-spin" />
          {{ acceptanceBusy ? t('episode.visualCheck.runningAcceptance') : t('episode.visualCheck.runAcceptance') }}
        </button>
      </div>
      <div class="visual-check-report">
        <div class="visual-check-row">
          <span class="visual-check-name">{{ t('episode.visualCheck.preflightResult') }}</span>
          <span v-if="preflightStale" class="tag tag-warning">{{ t('episode.visualCheck.stale') }}</span>
          <span v-if="preflightReport" :class="['tag', 'visual-verdict', 'is-' + preflightReport.verdict]">{{ verdictLabel(preflightReport.verdict) }}</span>
          <span v-else class="dim">{{ t('episode.visualCheck.notRun') }}</span>
        </div>
        <ul v-if="preflightReport && preflightReport.checks.length" class="visual-check-checks">
          <li v-for="item in preflightReport.checks" :key="item.key">
            <span>{{ item.label }}</span>
            <span :class="['visual-check-state', 'is-' + item.verdict]">{{ verdictLabel(item.verdict) }}</span>
          </li>
        </ul>
        <ul v-if="preflightReport && preflightReport.issues.length" class="visual-check-issues">
          <li v-for="(issue, index) in preflightReport.issues" :key="index">
            <span>{{ issue.message }}</span>
            <small v-if="issue.suggestion">{{ issue.suggestion }}</small>
          </li>
        </ul>
        <div v-else-if="preflightReport" class="visual-check-ok">{{ t('episode.visualCheck.noIssues') }}</div>

        <div class="visual-check-row">
          <span class="visual-check-name">{{ t('episode.visualCheck.acceptanceResult') }}</span>
          <span v-if="acceptanceStale" class="tag tag-warning">{{ t('episode.visualCheck.stale') }}</span>
          <span v-if="acceptanceReport" :class="['tag', 'visual-verdict', 'is-' + acceptanceReport.verdict]">{{ verdictLabel(acceptanceReport.verdict) }}</span>
          <span v-else class="dim">{{ t('episode.visualCheck.notRun') }}</span>
        </div>
        <ul v-if="acceptanceReport && acceptanceReport.checks.length" class="visual-check-checks">
          <li v-for="item in acceptanceReport.checks" :key="item.key">
            <span>{{ item.label }}</span>
            <span :class="['visual-check-state', 'is-' + item.verdict]">{{ verdictLabel(item.verdict) }}</span>
          </li>
        </ul>
        <ul v-if="acceptanceReport && acceptanceReport.issues.length" class="visual-check-issues">
          <li v-for="(issue, index) in acceptanceReport.issues" :key="index">
            <span>{{ issue.message }}</span>
            <small v-if="issue.suggestion">{{ issue.suggestion }}</small>
          </li>
        </ul>
        <div v-if="acceptanceReport && acceptanceReport.evidence.length" class="visual-check-frames">
          <button
            v-for="(frame, index) in acceptanceReport.evidence"
            :key="index"
            type="button"
            class="visual-check-frame"
            :title="frame.label"
            @click="emit('open-viewer', videoUrl(frame.path), frame.label)"
          >
            <img :src="videoUrl(frame.path)" :alt="frame.label" loading="lazy" />
          </button>
        </div>
      </div>
    </section>
  </div>

  <div class="video-inspector-footer" v-show="visible">
    <section class="video-inspector-section video-params-card">
      <div class="video-param-row">
        <span class="video-param-name">{{ t('episode.inspector.duration') }}</span>
        <span class="video-param-control">
          <span class="video-param-value">{{ Number(storyboard.duration) || 10 }}s</span>
          <span class="video-param-unit">{{ t('episode.inspector.durationUnit', { max: durationMax }) }}</span>
        </span>
      </div>
      <div class="video-param-hint">{{ t('episode.inspector.durationAutoHint') }}</div>
      <div v-if="durationOverLimit" class="video-param-hint video-param-warn">
        {{ t('episode.inspector.durationLimitWarning', { max: durationMax, dur: effectiveVideoDuration }) }}
      </div>
    </section>
    <div class="video-inspector-effective">{{ effectiveSummary }}</div>
    <button
      class="btn btn-primary video-inspector-action"
      :disabled="actionDisabled"
      :title="readonlyTitle"
      @click="emit('generate')"
    >
      {{ actionLabel }}
    </button>
  </div>
</template>

<style scoped>
.voice-reference-hint {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-3);
}
/* 生成前生效配置小结 */
.video-inspector-effective {
  margin: 0;
  padding: 4px 8px;
  border: 1px solid var(--accent-glow);
  border-radius: var(--radius);
  background: var(--accent-bg);
  color: var(--accent-text);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 生成参数：强调卡片，时长是当前分镜生成的核心参数 */
.video-params-card {
  padding: 7px 10px;
  border: 1px solid var(--accent-glow);
  border-radius: var(--radius-lg);
  background: var(--accent-bg);
}
.video-inspector-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; padding: 16px 18px 18px; }
/* 时长参数 + 生成操作常驻底部：不随检查器滚动 */
.video-inspector-footer {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 14px 11px;
  border-top: 1px solid var(--border);
  background: var(--surface-muted);
}
.video-inspector-section { display: flex; flex-direction: column; gap: 7px; }
.video-inspector-label { color: var(--text-0); font-size: 12px; font-weight: 700; }
.video-inspector-prompt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.video-inspector-action { width: 100%; min-height: 32px; height: 32px; padding: 0 12px; font-size: 12.5px; }
/* 绑定参考图：当前分镜已绑定素材的图片平铺（生成时作为参考图提交） */
.video-bound-refs { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 8px; }
.video-bound-ref {
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--bg-2);
  color: var(--text-3);
  cursor: pointer;
  transition: border-color 0.15s var(--ease-out);
}
.video-bound-ref:hover { border-color: var(--accent); }
.video-bound-ref:disabled { cursor: default; }
.video-bound-ref:disabled:hover { border-color: var(--surface-outline); }
.video-bound-ref img { width: 100%; height: 100%; object-fit: cover; display: block; }
.video-bound-ref small {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 2px 5px;
  background: rgba(0,0,0,0.58);
  color: #fff;
  font-size: 9.5px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.video-bound-ref-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 11px; }
.video-bound-refs-empty { padding: 10px; border: 1px dashed var(--surface-outline); border-radius: var(--radius); color: var(--text-3); font-size: 11px; line-height: 1.5; }
.frame-asset-current { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.frame-asset-current-thumb { width: 76px; height: 44px; object-fit: cover; border-radius: 6px; border: 1px solid var(--surface-outline); }
.frame-asset-current-meta { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; font-size: 11px; color: var(--text-2); }
.frame-asset-bind-hint { margin-top: 8px; font-size: 11px; line-height: 1.5; color: var(--text-3); }
.frame-asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 8px; margin-top: 8px; }
.frame-asset-card { display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--surface-outline); border-radius: var(--radius); background: var(--bg-2); }
.frame-asset-card > img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }
.frame-asset-card-foot { display: flex; align-items: center; gap: 4px; padding: 0 6px 6px; flex-wrap: wrap; }
.frame-asset-shot { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--text-3); }
.frame-asset-del { border: none; background: transparent; color: var(--text-3); cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px; }
.frame-asset-del:hover { color: var(--error); }
/* L2 视觉预检 / L3 生成后验收 */
.visual-check-section { border-top: 1px dashed var(--border); padding-top: 10px; }
.visual-check-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.visual-check-report { display: flex; flex-direction: column; gap: 6px; }
.visual-check-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--text-2); }
.visual-check-name { font-weight: 600; color: var(--text-1); }
.visual-check-checks { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 4px 12px; }
.visual-check-checks li { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 11px; color: var(--text-2); }
.visual-check-state { flex-shrink: 0; font-size: 10.5px; }
.visual-check-state.is-pass { color: var(--success); }
.visual-check-state.is-warn { color: var(--warning, #f59e0b); }
.visual-check-state.is-block, .visual-check-state.is-fail { color: var(--error); }
.visual-check-state.is-skipped { color: var(--text-3); }
.visual-verdict.is-pass { background: var(--success-bg); color: var(--tag-success-text); }
.visual-verdict.is-warn { background: var(--warning-bg); color: var(--tag-warning-text); }
.visual-verdict.is-block, .visual-verdict.is-fail { background: var(--error-bg); color: var(--error); }
.visual-check-issues { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 4px; font-size: 11px; line-height: 1.5; color: var(--text-2); }
.visual-check-issues small { display: block; color: var(--text-3); }
.visual-check-ok { font-size: 11px; color: var(--success); }
.visual-check-frames { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
.visual-check-frame { flex: 0 0 92px; aspect-ratio: 16 / 9; padding: 0; border: 1px solid var(--surface-outline); border-radius: 6px; overflow: hidden; background: var(--bg-2); cursor: pointer; }
.visual-check-frame:hover { border-color: var(--accent); }
.visual-check-frame img { display: block; width: 100%; height: 100%; object-fit: cover; }
.video-param-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; white-space: nowrap; }
.video-param-name { color: var(--text-1); font-weight: 600; flex-shrink: 0; }
.video-param-control { display: inline-flex; align-items: center; gap: 6px; }
.video-param-value { color: var(--text-1); text-align: right; font-size: 11px; }
.video-param-unit { font-size: 11px; color: var(--text-2); }
.video-param-hint { margin-top: 6px; font-size: 11px; line-height: 1.5; color: var(--text-3); white-space: normal; }
.video-param-warn { color: var(--warning, #f59e0b); }
@media (max-width: 900px) {
  .video-inspector-body {
    overflow: visible;
  }
  .video-param-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
    white-space: normal;
  }
}
</style>
