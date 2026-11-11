<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import { thumbFallback, thumbOf } from '~/composables/useMedia'
import { useMediaCapabilities } from '~/composables/useMediaCapabilities'

const props = defineProps<{
  visible: boolean
  storyboard: any
  transitionOptions: any[]
  refBindableAssets: any[]
  refKinds: { kind: string; label: string; hint: string }[]
  mentionOptions: any[]
  promptGenerating: boolean
  promptBatchRunning: boolean
  previousShotFrameRef: any
}>()

const emit = defineEmits<{
  'update-field': [field: string, value: any]
  'toggle-bind': [asset: any]
  'open-viewer': [src: string, title: string]
  'generate-prompt': []
  'goto-generate': []
}>()

const { t } = useI18n()
const mediaCaps = useMediaCapabilities()
const generationHintVisible = computed(() => mediaCaps.state.value === 'ready' && !mediaCaps.outputReady.value)
const descriptionInput = ref<HTMLTextAreaElement | null>(null)

function focusDescription() {
  descriptionInput.value?.focus()
}
defineExpose({ focusDescription })

function assetSrc(asset: any) {
  const raw = asset?.imageUrl || asset?.image_url || ''
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw
  return `/${raw}`
}

function groupAssets(kind: string) {
  return props.refBindableAssets.filter(asset => asset.kind === kind)
}
</script>

<template>
  <div class="video-main-col" v-show="visible">
    <div class="video-main-scroll">
      <p v-if="generationHintVisible" class="media-generation-hint">{{ t('media.capability.generationHint') }}</p>
      <div class="video-main-grid">
        <section class="video-inspector-section">
          <span class="video-inspector-label">{{ t('episode.sb.descSection') }}</span>
          <label class="field">
            <span class="field-label">{{ t('episode.sb.descLabel') }} <span class="dim">({{ t('episode.sb.descHint') }})</span></span>
            <textarea ref="descriptionInput" :value="storyboard.description || ''" class="textarea video-desc-textarea" rows="7" @blur="emit('update-field', 'description', $event.target.value)" :placeholder="t('episode.sb.descPlaceholder')" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('episode.sb.atmosphere') }}</span>
            <textarea :value="storyboard.atmosphere || ''" class="textarea" rows="2" @blur="emit('update-field', 'atmosphere', $event.target.value)" :placeholder="t('episode.sb.atmospherePlaceholder')" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('episode.sb.transition') }}</span>
            <BaseSelect
              :model-value="storyboard.transition || 'cut'"
              :options="transitionOptions"
              :searchable="false"
              @update:model-value="v => emit('update-field', 'transition', v)"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('episode.sb.continuity') }}</span>
            <textarea :value="storyboard.continuity || ''" class="textarea" rows="2" @blur="emit('update-field', 'continuity', $event.target.value)" :placeholder="t('episode.sb.continuityPlaceholder')" />
          </label>
        </section>

        <section class="video-inspector-section">
          <div class="video-inspector-prompt-head">
            <span class="video-inspector-label">{{ t('episode.ref.title') }}</span>
            <span class="tag mono">{{ t('episode.ref.boundCount', { bound: refBindableAssets.filter(a => a.bound).length, total: refBindableAssets.length }) }}</span>
          </div>
          <p class="storyboard-ref-scope-hint">{{ t('episode.ref.scopeHint') }}</p>
          <div class="storyboard-ref-list is-embedded">
            <template v-for="g in refKinds" :key="g.kind">
              <div v-if="groupAssets(g.kind).length" class="storyboard-ref-group">
                <div class="storyboard-ref-group-label">{{ g.label }} <span class="dim">· {{ g.hint }}</span></div>
                <div
                  v-for="asset in groupAssets(g.kind)"
                  :key="asset.key"
                  :class="['storyboard-ref-item', { bound: asset.bound }]"
                  :title="asset.bound ? t('episode.ref.clickRemove') : t('episode.ref.clickAdd')"
                  @click="emit('toggle-bind', asset)"
                >
                  <button
                    type="button"
                    class="storyboard-ref-thumb"
                    :disabled="!asset.ready"
                    @click.stop="asset.ready && emit('open-viewer', assetSrc(asset), `${asset.name} ${asset.typeLabel}`)"
                  >
                    <img v-if="asset.ready" :src="thumbOf(assetSrc(asset))" class="previewable-image" loading="lazy" @error="thumbFallback($event, assetSrc(asset))" />
                    <span v-else>{{ asset.kind === 'scene' ? t('episode.ref.shortScene') : asset.kind === 'prop' ? t('episode.ref.shortProp') : t('episode.ref.shortChar') }}</span>
                  </button>
                  <div class="storyboard-ref-main">
                    <span class="storyboard-ref-name">
                      {{ asset.name }}
                      <span class="storyboard-ref-scope">{{ asset.linked ? '' : t('episode.ref.projectAsset') }}</span>
                    </span>
                    <span class="storyboard-ref-meta">{{ asset.typeLabel }} · {{ asset.meta }}</span>
                    <span :class="['storyboard-ref-state', asset.bound && asset.ready ? 'is-ready' : '']">
                      {{ asset.bound ? (asset.ready ? t('episode.ref.usable') : t('episode.ref.notReady')) : t('episode.ref.unbound') }}
                    </span>
                    <button v-if="asset.bound && !asset.ready" type="button" class="storyboard-ref-goto" @click.stop="emit('goto-generate')">{{ t('episode.ref.gotoGenerate') }}</button>
                  </div>
                </div>
              </div>
            </template>
            <div v-if="!refBindableAssets.length" class="storyboard-ref-empty">{{ t('episode.ref.empty') }}</div>
          </div>
        </section>
      </div>

      <section class="video-inspector-section">
        <div class="video-inspector-prompt-head">
          <span class="video-inspector-label video-inspector-label-hero">{{ t('episode.sb.videoPromptSection') }}</span>
          <button
            type="button"
            class="btn btn-sm"
            :disabled="promptGenerating || promptBatchRunning"
            @click="emit('generate-prompt')"
          >
            <Loader2 v-if="promptGenerating" :size="11" class="animate-spin" />
            {{ (storyboard.video_prompt || storyboard.videoPrompt) ? t('episode.sb.regenPrompt') : t('episode.sb.aiGenerate') }}
          </button>
        </div>
        <MentionTextarea
          :model-value="storyboard.video_prompt || storyboard.videoPrompt || ''"
          :options="mentionOptions"
          :rows="14"
          input-class="textarea video-inspector-prompt"
          :placeholder="t('episode.inspector.videoPromptPlaceholder')"
          @commit="v => emit('update-field', 'video_prompt', v)"
        />
        <p class="voice-reference-hint">{{ t('characterVoice.referenceHint') }}</p>
        <p v-if="previousShotFrameRef" class="voice-reference-hint">{{ t('episode.frameAssets.autoPromptHint', { token: previousShotFrameRef.token }) }}</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.voice-reference-hint {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-3);
}
/* 中列：纯编辑区（分镜描述/氛围/视频提示词），占满高度 */
.video-main-col {
  min-width: 0;
  min-height: 0;
  display: flex;
}
.video-main-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px 16px 16px;
  background: var(--surface-raised);
}
/* 生成前检查动线集中一屏：上双栏（画面描述/氛围 ｜ 参考绑定），下整宽（视频提示词） */
.media-generation-hint {
  margin: 0;
  padding: 7px 10px;
  border: 1px dashed var(--surface-outline);
  border-radius: var(--radius);
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.5;
}
.video-main-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 500; color: var(--text-1); }
.video-inspector-section { display: flex; flex-direction: column; gap: 7px; }
.video-inspector-label { color: var(--text-0); font-size: 12px; font-weight: 700; }
.video-inspector-label-hero {
  color: var(--accent);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.video-inspector-label-hero::before {
  content: '';
  width: 3px;
  height: 13px;
  border-radius: 2px;
  background: var(--accent);
}
.video-inspector-prompt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
/* MentionTextarea 内部元素需 :deep 穿透（scoped 样式默认到不了子组件内部） */
:deep(.video-inspector-prompt) {
  min-height: 176px;
  font-size: 13px;
  line-height: 1.6;
}
.storyboard-ref-list {
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
/* 嵌入中栏时：不自带内边距；高度封顶内部滚动，避免把下方提示词顶出首屏 */
.storyboard-ref-list.is-embedded { overflow: visible; padding: 0; }
.video-main-grid .storyboard-ref-list.is-embedded { max-height: 300px; overflow-y: auto; }
.storyboard-ref-group {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}
.storyboard-ref-group + .storyboard-ref-group {
  margin-top: 4px;
}
.storyboard-ref-group-label {
  grid-column: 1 / -1;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  letter-spacing: 0.02em;
  padding: 0 2px;
}
.storyboard-ref-scope-hint {
  margin: 2px 0 6px;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--text-3);
}
.storyboard-ref-scope {
  display: inline-block;
  margin-left: 5px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--surface-outline);
  color: var(--text-3);
  font-size: 9.5px;
  font-weight: 600;
  vertical-align: 1px;
}
.storyboard-ref-scope:empty { display: none; }
.storyboard-ref-goto {
  flex-shrink: 0;
  align-self: center;
  border: none;
  background: transparent;
  padding: 0 2px;
  border-radius: var(--radius-sm, 6px);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
}
.storyboard-ref-goto:hover {
  background: var(--accent-bg);
}
.storyboard-ref-item {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  padding: 5px 7px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface-raised);
  cursor: pointer;
  transition: border-color 0.15s var(--ease-out), opacity 0.15s var(--ease-out);
}
.storyboard-ref-item:hover { border-color: var(--accent); }
.storyboard-ref-item:not(.bound) {
  background: transparent;
  border-color: var(--border);
  opacity: 0.72;
}
.storyboard-ref-item:not(.bound):hover { opacity: 1; border-color: var(--accent); }
.storyboard-ref-item:not(.bound) .storyboard-ref-main .storyboard-ref-name { color: var(--text-2); }
.storyboard-ref-item.bound {
  border-color: var(--accent);
  background: var(--accent-bg);
}
.storyboard-ref-item.bound:hover { border-color: var(--accent); }
.storyboard-ref-thumb {
  width: 30px;
  aspect-ratio: 1;
  border-radius: var(--radius-sm);
  border: 1px solid var(--surface-outline);
  overflow: hidden;
  background: var(--bg-2);
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 800;
}
.storyboard-ref-thumb:disabled { cursor: default; }
.storyboard-ref-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.storyboard-ref-main { min-width: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 6px; }
.storyboard-ref-name {
  flex: none;
  max-width: 42%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-0);
}
.storyboard-ref-state {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 10px;
  color: var(--text-3);
}
.storyboard-ref-state.is-ready { color: var(--success); }
.storyboard-ref-meta {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.storyboard-ref-empty {
  padding: 14px 10px;
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.5;
  border: 1px dashed var(--surface-outline);
  border-radius: var(--radius);
}
@media (max-width: 1080px) {
  .video-main-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 900px) {
  /* 窄屏：中列改为纵向堆叠，由外层 workbench 整体滚动 */
  .video-main-col {
    display: flex;
    flex-direction: column;
    flex: none;
  }
  .video-main-scroll {
    flex: none;
    overflow: visible;
  }
  .video-desc-textarea { min-height: 120px; }
}
</style>
