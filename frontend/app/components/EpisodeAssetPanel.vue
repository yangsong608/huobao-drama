<template>
  <div class="prod-section-bar">
    <span class="dim" style="font-size:12px">{{ t('episode.prod.assets') }}</span>
    <span class="tag mono">{{ t('episode.prod.readyCount', { ready: assetReadyCount, total: assetTotalCount }) }}</span>
    <div class="ml-auto flex gap-1 asset-bar-actions">
      <button
        v-for="et in extractTargets"
        :key="et.key"
        class="btn btn-sm asset-btn-extract"
        :disabled="isExtracting(et.key)"
        @click="emit('extract', et.key)"
      >
        <Loader2 v-if="isExtracting(et.key)" :size="11" class="animate-spin" />
        <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        {{ (et.key === 'characters' ? charCount : et.key === 'scenes' ? sceneCount : propCount) ? t('episode.prod.reextract', { type: et.label }) : t('episode.prod.extract', { type: et.label }) }}
      </button>
      <span class="asset-bar-divider" />
      <button class="btn btn-sm asset-btn-batch" @click="emit('batch', 'character')">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        {{ t('episode.prod.batchChar') }}
      </button>
      <button class="btn btn-sm asset-btn-batch" @click="emit('batch', 'scene')">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        {{ t('episode.prod.batchScene') }}
      </button>
      <button class="btn btn-sm asset-btn-batch" @click="emit('batch', 'prop')">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        {{ t('episode.prod.batchProp') }}
      </button>
    </div>
  </div>
  <div v-if="extracting.length && !charCount && !sceneCount && !propCount" class="step-loading">
    <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
    <div class="loading-text">{{ t('episode.prod.extractingTypes', { types: extractingLabels }) }}</div>
  </div>
  <div v-else-if="!charCount && !sceneCount && !propCount" class="step-empty asset-empty-state">
    <div class="empty-visual">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    </div>
    <div class="empty-title">{{ t('episode.prod.emptyTitle') }}</div>
    <div class="empty-desc">{{ t('episode.prod.emptyDesc') }}</div>
    <button class="btn btn-primary" :disabled="!!extracting.length || remoteReadonly" :title="remoteReadonly ? t('remote.readonly.notice') : undefined" @click="emit('extract-all')">
      <Loader2 v-if="extracting.length" :size="13" class="animate-spin" />
      <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      {{ extracting.length ? t('episode.prod.extractingTypesDots', { types: extractingLabels }) : t('episode.prod.startExtract') }}
    </button>
  </div>
  <template v-else>
    <div class="asset-section-title">
      {{ t('common.role') }}
      <button class="asset-add-btn" @click="emit('add', 'character')"><Plus :size="11" /> {{ t('common.add') }}</button>
    </div>
    <template v-if="characters.length">
      <div class="character-asset-grid">
        <article
          v-for="c in characters"
          :key="c.id"
          class="card character-asset-card"
          tabindex="0"
          role="button"
          @click="emit('open-detail', 'character', c)"
          @keydown.enter.self.prevent="emit('open-detail', 'character', c)"
          @keydown.space.self.prevent="emit('open-detail', 'character', c)"
        >
          <button class="asset-del-btn" :title="t('episode.asset.delChar')" @click.stop="emit('remove', 'character', c)"><X :size="11" /></button>
          <div class="character-asset-main">
            <div class="character-asset-overview"><div class="character-portrait">
                <img
                  v-if="c.image_url || c.imageUrl"
                  :src="thumbOf(assetImageSrc(c))"
                  class="previewable-image"
                  loading="lazy"
                  @error="thumbFallback($event, assetImageSrc(c))"
                  @click.stop="previewAsset('character', c)"
                />
                <div v-else class="character-portrait-empty">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </div>
                <span class="asset-cover-badge" :class="(c.image_url || c.imageUrl) ? 'is-ready' : (isPendingChar(c.id) ? 'is-pending' : '')">
                  {{ (c.image_url || c.imageUrl) ? t('episode.asset.portraitReady') : (isPendingChar(c.id) ? t('episode.asset.portraitPending') : t('episode.asset.portraitTodo')) }}
                </span>
              </div>

              <div class="character-asset-head">
                <div class="character-title-block">
                  <div class="character-name-row">
                    <strong class="character-name">{{ c.name }}</strong>
                    <span class="tag">{{ c.role || t('common.role') }}</span>
                    <span v-if="assetRefs(c).length" class="tag tag-ref">{{ t('episode.asset.refBadge', { n: assetRefs(c).length }) }}</span>
                  </div>
                  <div class="character-visual-summary" :title="characterVisualSummary(c)">
                    <span>{{ t('episode.asset.appearance') }}{{ characterAppearanceValue(c) }}</span>
                    <span>{{ t('episode.asset.styling') }}{{ characterStylingValue(c) }}</span>
                  </div>
                </div>
                <button class="btn btn-sm character-gen-btn" :disabled="isPendingChar(c.id)" @click.stop="emit('generate', 'character', c.id)">
                  <Loader2 v-if="isPendingChar(c.id)" :size="11" class="animate-spin" />
                  {{ (c.image_url || c.imageUrl) ? t('episode.asset.regen') : (isPendingChar(c.id) ? t('episode.asset.generating') : t('episode.asset.generate')) }}
                </button>
                <button class="btn btn-sm" :title="t('episode.asset.uploadCharImage')" :disabled="isUploading('character', c.id)" @click.stop="emit('upload', 'character', c.id)">
                  <Loader2 v-if="isUploading('character', c.id)" :size="11" class="animate-spin" />
                  <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                  {{ t('episode.asset.upload') }}
                </button>
              </div>
            </div>
            <div class="asset-final-prompt" :title="c.final_prompt || c.finalPrompt || ''">
              <span class="afp-label">{{ t('episode.asset.finalPromptTurnaround') }}</span>
              <span :class="['afp-text', !(c.final_prompt || c.finalPrompt) && 'dim']">{{ c.final_prompt || c.finalPrompt || t('episode.asset.finalPromptAutoTurnaround') }}</span>
            </div>
          </div>
        </article>
      </div>
    </template>

    <div class="asset-section-title">
      {{ t('common.scene') }}
      <span class="asset-shared-hint">{{ t('episode.asset.sharedHint') }}</span>
      <button class="asset-add-btn" @click="emit('add', 'scene')"><Plus :size="11" /> {{ t('common.add') }}</button>
    </div>
    <template v-if="scenes.length">
      <div class="asset-grid">
        <div
          v-for="s in scenes"
          :key="s.id"
          class="card asset-card asset-click-card"
          tabindex="0"
          role="button"
          @click="emit('open-detail', 'scene', s)"
          @keydown.enter.prevent="emit('open-detail', 'scene', s)"
          @keydown.space.prevent="emit('open-detail', 'scene', s)"
        >
          <button class="asset-del-btn" :title="t('episode.asset.delScene')" @click.stop="emit('remove', 'scene', s)"><X :size="11" /></button>
          <div class="asset-cover wide">
            <img
              v-if="s.image_url || s.imageUrl"
              :src="thumbOf(assetImageSrc(s))"
              class="previewable-image"
              loading="lazy"
              @error="thumbFallback($event, assetImageSrc(s))"
              @click.stop="previewAsset('scene', s)"
            />
            <div v-else class="asset-cover-empty">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            </div>
            <span class="asset-cover-badge" :class="(s.image_url || s.imageUrl) ? 'is-ready' : (isPendingScene(s.id) ? 'is-pending' : '')">{{ (s.image_url || s.imageUrl) ? t('episode.asset.ready') : (isPendingScene(s.id) ? t('episode.asset.generating') : t('episode.asset.todo')) }}</span>
          </div>
          <div class="asset-body">
            <div class="prop-name-row">
              <span class="asset-name" :title="s.location">{{ s.location }}</span>
              <span class="asset-ep-badge" :class="isEpisodeScoped(s) ? 'is-current' : 'is-other'">{{ isEpisodeScoped(s) ? t('episode.asset.currentEpisodeBadge') : t('episode.asset.otherEpisodeBadge') }}</span>
            </div>
            <div class="asset-meta asset-desc dim" :title="sceneDescriptionValue(s)">{{ sceneDescriptionValue(s) }}</div>
            <div v-if="sceneLightingValue(s)" class="asset-meta asset-light dim" :title="sceneLightingValue(s)">{{ t('episode.asset.lighting') }}{{ sceneLightingValue(s) }}</div>
            <div class="asset-meta asset-final" :class="{ dim: !(s.final_prompt || s.finalPrompt) }" :title="s.final_prompt || s.finalPrompt || ''">
              <span class="afp-label">{{ t('episode.asset.finalPromptFixed') }}</span>
              {{ s.final_prompt || s.finalPrompt || t('episode.asset.finalPromptAutoFixed') }}
            </div>
          </div>
          <div class="asset-foot">
            <span :class="['dot', (s.image_url || s.imageUrl) && 'ok', isPendingScene(s.id) && 'pending']" />
            <span v-if="assetRefs(s).length" class="asset-ref-chip">{{ t('episode.asset.refBadge', { n: assetRefs(s).length }) }}</span>
            <button class="btn btn-sm ml-auto" :title="t('episode.asset.uploadSceneImage')" :disabled="isUploading('scene', s.id)" @click.stop="emit('upload', 'scene', s.id)">
              <Loader2 v-if="isUploading('scene', s.id)" :size="11" class="animate-spin" />
              <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              {{ t('episode.asset.upload') }}
            </button>
            <button class="btn btn-sm" :disabled="isPendingScene(s.id)" @click.stop="emit('generate', 'scene', s.id)">
              <Loader2 v-if="isPendingScene(s.id)" :size="11" class="animate-spin" />
              {{ (s.image_url || s.imageUrl) ? t('episode.asset.regen') : (isPendingScene(s.id) ? t('episode.asset.generating') : t('episode.asset.generate')) }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <div class="asset-section-title">
      {{ t('common.prop') }}
      <span class="asset-shared-hint">{{ t('episode.asset.sharedHint') }}</span>
      <button class="asset-add-btn" @click="emit('add', 'prop')"><Plus :size="11" /> {{ t('common.add') }}</button>
    </div>
    <div v-if="propItems.length" class="asset-grid">
      <div
        v-for="p in propItems"
        :key="p.id"
        class="card asset-card asset-click-card prop-card"
        tabindex="0"
        role="button"
        @click="emit('open-detail', 'prop', p)"
        @keydown.enter.prevent="emit('open-detail', 'prop', p)"
        @keydown.space.prevent="emit('open-detail', 'prop', p)"
      >
        <button class="asset-del-btn" :title="t('episode.asset.delProp')" @click.stop="emit('remove', 'prop', p)"><X :size="11" /></button>
        <div class="asset-cover wide">
          <img
            v-if="p.image_url || p.imageUrl"
            :src="thumbOf(assetImageSrc(p))"
            class="previewable-image"
            loading="lazy"
            @error="thumbFallback($event, assetImageSrc(p))"
            @click.stop="previewAsset('prop', p)"
          />
          <div v-else class="asset-cover-empty">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
          </div>
          <span class="asset-cover-badge" :class="(p.image_url || p.imageUrl) ? 'is-ready' : (isPendingProp(p.id) ? 'is-pending' : '')">{{ (p.image_url || p.imageUrl) ? t('episode.asset.ready') : (isPendingProp(p.id) ? t('episode.asset.generating') : t('episode.asset.todo')) }}</span>
        </div>
        <div class="asset-body">
          <div class="prop-name-row">
            <span class="asset-name" :title="p.name">{{ p.name }}</span>
            <span class="tag">{{ p.type || t('common.prop') }}</span>
            <span class="asset-ep-badge" :class="isEpisodeScoped(p) ? 'is-current' : 'is-other'">{{ isEpisodeScoped(p) ? t('episode.asset.currentEpisodeBadge') : t('episode.asset.otherEpisodeBadge') }}</span>
          </div>
          <div class="asset-meta asset-desc dim" :title="p.description || ''">{{ p.description || t('episode.asset.noDescription') }}</div>
          <div class="asset-meta asset-final" :class="{ dim: !(p.final_prompt || p.finalPrompt) }" :title="p.final_prompt || p.finalPrompt || ''">
            <span class="afp-label">{{ t('episode.asset.finalPromptWhiteBg') }}</span>
            {{ p.final_prompt || p.finalPrompt || t('episode.asset.finalPromptAutoWhiteBg') }}
          </div>
        </div>
        <div class="asset-foot">
          <span :class="['dot', (p.image_url || p.imageUrl) && 'ok', isPendingProp(p.id) && 'pending']" />
          <span v-if="assetRefs(p).length" class="asset-ref-chip">{{ t('episode.asset.refBadge', { n: assetRefs(p).length }) }}</span>
          <button class="btn btn-sm ml-auto" :title="t('episode.asset.uploadPropImage')" :disabled="isUploading('prop', p.id)" @click.stop="emit('upload', 'prop', p.id)">
            <Loader2 v-if="isUploading('prop', p.id)" :size="11" class="animate-spin" />
            <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            {{ t('episode.asset.upload') }}
          </button>
          <button class="btn btn-sm" :disabled="isPendingProp(p.id)" @click.stop="emit('generate', 'prop', p.id)">
            <Loader2 v-if="isPendingProp(p.id)" :size="11" class="animate-spin" />
            {{ (p.image_url || p.imageUrl) ? t('episode.asset.regen') : (isPendingProp(p.id) ? t('episode.asset.generating') : t('episode.asset.generate')) }}
          </button>
        </div>
      </div>
    </div>
    <div v-else class="asset-props-empty">{{ t('episode.asset.propsEmpty') }}</div>
  </template>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Loader2, Plus, X } from 'lucide-vue-next'
import { thumbFallback, thumbOf } from '~/composables/useMedia'

const props = defineProps<{
  characters: any[]
  scenes: any[]
  propItems: any[]
  charCount: number
  sceneCount: number
  propCount: number
  assetReadyCount: number
  assetTotalCount: number
  extractTargets: Array<{ key: string; label: string }>
  extracting: string[]
  extractingLabels: string
  remoteReadonly: boolean
  pendingCharIds: number[]
  pendingSceneIds: number[]
  pendingPropIds: number[]
  uploadingKeys: string[]
}>()

const emit = defineEmits<{
  (e: 'extract', key: string): void
  (e: 'extract-all'): void
  (e: 'batch', kind: 'character' | 'scene' | 'prop'): void
  (e: 'open-detail', kind: string, item: any): void
  (e: 'add', kind: string): void
  (e: 'remove', kind: string, item: any): void
  (e: 'generate', kind: string, id: number): void
  (e: 'upload', kind: string, id: number): void
  (e: 'preview', src: string, title: string): void
}>()

const { t } = useI18n()

const isExtracting = (key: string) => props.extracting.includes(key)
const isPendingChar = (id: number) => props.pendingCharIds.includes(id)
const isPendingScene = (id: number) => props.pendingSceneIds.includes(id)
const isPendingProp = (id: number) => props.pendingPropIds.includes(id)
const isUploading = (kind: string, id: number) => props.uploadingKeys.includes(`${kind}:${id}`)

function assetImageSrc(item: any) {
  const raw = item?.image_url || item?.imageUrl || ''
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw
  return `/${raw}`
}

function parseAssetRefs(value: any): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
    } catch {
      return []
    }
  }
  return []
}

function assetRefs(item: any) {
  return parseAssetRefs(item?.reference_images ?? item?.referenceImages)
}

const isEpisodeScoped = (item: any) => !!(item?.in_episode ?? item?.inEpisode)

function characterAppearanceValue(char: any) {
  return char?.appearance || t('episode.asset.appearanceTodo')
}

function characterStylingValue(char: any) {
  return char?.styling || t('episode.asset.stylingTodo')
}

function characterVisualSummary(char: any) {
  return `${t('episode.asset.appearance')}${characterAppearanceValue(char)} · ${t('episode.asset.styling')}${characterStylingValue(char)}`
}

function sceneDescriptionValue(scene: any) {
  return scene?.prompt || scene?.description || t('episode.asset.sceneDescTodo')
}

function sceneLightingValue(scene: any) {
  return scene?.lighting || t('episode.asset.sceneLightTodo')
}

function previewAsset(kind: string, item: any) {
  const src = assetImageSrc(item)
  if (!src) return
  const title = kind === 'character'
    ? t('episode.asset.charImageTitle', { name: item?.name })
    : kind === 'scene'
      ? t('episode.asset.sceneImageTitle', { name: item?.location })
      : t('episode.asset.propImageTitle', { name: item?.name })
  emit('preview', src, title)
}
</script>

<style scoped>
/* 资产栏动作：提取（虚线中性）与批量生成（强调色）视觉分组 */
.asset-bar-actions { align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.asset-bar-divider { width: 1px; height: 16px; margin: 0 4px; background: var(--surface-outline-strong); }
.asset-btn-extract {
  background: transparent;
  color: var(--text-2);
  box-shadow: none;
  border: 1px dashed var(--surface-outline-strong);
}
.asset-btn-extract:hover { background: var(--surface-muted); color: var(--text-1); }
.asset-btn-batch {
  background: var(--accent-bg);
  color: var(--accent-text);
  box-shadow: none;
}
.asset-btn-batch:hover { background: var(--accent); color: var(--on-accent); }

/* 资产分区标题：新增入口 + 卡片删除按钮 */
.asset-section-title { display: flex; align-items: center; gap: 8px; }
.asset-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px dashed var(--surface-outline-strong);
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.asset-add-btn:hover { color: var(--accent-text); border-color: var(--accent-text); }
.character-asset-card, .asset-click-card { position: relative; }
.asset-del-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s;
}
.asset-del-btn:hover { background: var(--action-danger); }
.character-asset-card:hover .asset-del-btn,
.asset-click-card:hover .asset-del-btn { opacity: 1; }

/* Asset grid */
.asset-section-title {
  margin-top: 2px;
  font-size: 12px;
  font-weight: 800;
  color: var(--text-1);
  letter-spacing: 0.04em;
}
.prop-name-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.prop-name-row .asset-name {
  min-width: 0;
}
.asset-props-empty {
  padding: 14px;
  border: 1px dashed var(--surface-outline);
  border-radius: var(--radius);
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
}
.asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; align-items: stretch; }
.character-asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 260px));
  justify-content: start;
  gap: 10px;
}
.asset-card {
  display: flex; flex-direction: column; overflow: hidden;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s var(--ease-out);
}
.asset-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.asset-click-card,
.character-asset-card {
  cursor: pointer;
}
.asset-click-card:focus-visible,
.character-asset-card:focus-visible {
  outline: none;
  border-color: var(--accent-glow);
  box-shadow: 0 0 0 3px var(--button-focus), var(--shadow-panel);
}
.character-asset-card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s var(--ease-out);
}
.character-asset-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lift);
  border-color: var(--border-strong);
}
.character-portrait {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  align-self: start;
  margin: 0;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--bg-2);
  overflow: hidden;
}
.character-portrait img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.character-portrait-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.character-asset-main {
  min-width: 0;
  width: 100%;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.character-asset-overview {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.character-asset-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.character-title-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.character-name-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex-wrap: wrap;
}
.character-name {
  font-size: 13px;
  line-height: 1.25;
  color: var(--text-0);
}
.character-gen-btn { flex-shrink: 0; align-self: center; }
.asset-final-prompt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 7px;
  border-top: 1px solid var(--border);
  font-size: 10.5px;
  line-height: 1.5;
}
.afp-label {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text-3);
}
.afp-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
  color: var(--text-2);
}
.afp-text.dim { color: var(--text-3); }
.asset-final {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
  color: var(--text-2);
}
.asset-final .afp-label { margin-right: 4px; }
.character-visual-summary {
  max-width: 100%;
  display: flex;
  gap: 8px;
  overflow: hidden;
  color: var(--text-3);
  font-size: 10.5px;
  line-height: 1.45;
  white-space: nowrap;
}
.character-visual-summary span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.asset-cover { position: relative; aspect-ratio: 1; background: var(--bg-2); overflow: hidden; }
.asset-cover.wide { aspect-ratio: 16/9; }
.asset-cover img { width: 100%; height: 100%; object-fit: cover; }
.previewable-image { cursor: zoom-in; transition: transform 0.18s var(--ease-out), filter 0.18s var(--ease-out); }
.previewable-image:hover { transform: scale(1.015); filter: saturate(1.04); }
.asset-cover-badge {
  position: absolute;
  top: 7px;
  left: 7px;
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(255,255,255,0.85);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  color: var(--text-2);
  font-size: 9.5px;
  font-weight: 700;
}
.asset-cover-badge.is-ready {
  background: var(--success-bg);
  color: var(--tag-success-text);
}
.asset-cover-badge.is-pending {
  background: var(--accent-bg);
  color: var(--accent-text);
}
.asset-cover-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.asset-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px 8px;
  min-width: 0;
}
.asset-name {
  font-size: 13px;
  font-weight: 650;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 本集 / 其他集归属徽标（全剧共享资产展示） */
.asset-ep-badge {
  flex: none;
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  white-space: nowrap;
}
.asset-ep-badge.is-current {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}
.asset-ep-badge.is-other {
  color: var(--text-2);
  background: var(--surface-muted);
  border: 1px solid var(--surface-outline);
}
.asset-shared-hint {
  font-size: 11px;
  color: var(--text-2);
  white-space: nowrap;
}
.asset-meta { font-size: 11px; line-height: 1.5; }
.asset-desc {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
}
.asset-light {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.asset-foot { display: flex; align-items: center; gap: 4px; padding: 7px 11px; border-top: 1px solid var(--border); }
.asset-ref-chip {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 6px;
  white-space: nowrap;
}
.tag-ref { color: var(--accent-text); background: var(--accent-bg); border-color: transparent; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--bg-3); flex-shrink: 0; }
.dot.ok { background: var(--success); }
.dot.pending {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

/* Step Empty / Loading（资产提取空态，样式与剧本面板一致） */
.step-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; min-height: 300px; gap: 10px; padding: 46px;
  animation: fadeIn 0.3s var(--ease-out);
}
.empty-visual {
  width: 72px; height: 72px; border-radius: 22px;
  background: var(--bg-1); color: var(--accent);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 8px;
}
.empty-title { font-size: 22px; font-weight: 700; font-family: var(--font-display); color: var(--text-0); }
.empty-desc { font-size: 13px; color: var(--text-2); max-width: 420px; text-align: center; line-height: 1.8; }
.step-loading {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; gap: 12px;
}
.loading-text { font-size: 13px; color: var(--text-2); }

@media (max-width: 1180px) {
  .asset-grid,
  .character-asset-grid {
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  }
  .character-asset-grid { justify-content: start; }
}
@media (max-width: 900px) {
  .asset-grid,
  .character-asset-grid {
    grid-template-columns: 1fr;
  }
  .character-asset-card {
    min-height: 0;
  }
  .character-asset-overview {
    grid-template-columns: 1fr;
  }
  .character-portrait {
    width: auto;
  }
  .character-asset-main {
    padding: 10px;
  }
  .character-asset-head {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
