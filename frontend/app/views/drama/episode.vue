<template>
  <div class="studio" v-if="drama">
    <StudioTopBar class="episode-topbar">
      <template #left>
        <div class="studio-topbar-main">
          <button type="button" class="back-btn topbar-back" :aria-label="t('episode.topbar.back')" @click="navigateTo(`/drama/${dramaId}`)">
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
            </svg>
            {{ t('episode.topbar.back') }}
          </button>
          <div class="studio-identity">
            <h1 class="studio-title" :title="drama.title">{{ drama.title }}</h1>
            <span class="studio-episode-chip">{{ t('episode.topbar.episodeN', { n: episodeNumber }) }}</span>
            <div class="studio-meta-row">
              <span class="studio-meta-pill">{{ currentSubStageLabel }}</span>
              <span class="studio-meta-pill is-progress">{{ pipelineProgress }}/{{ pipelineTotal }}</span>
              <span class="studio-meta-inline">{{ t('episode.topbar.meta', { roles: chars.length, shots: sbs.length }) }}</span>
            </div>
          </div>
        </div>
      </template>

      <template #center>
        <div class="studio-model-picks">
          <ModelSelect
            v-if="textModelOptions.length"
            v-model="chatModel"
            :label="t('common.serviceType.text')"
            :options="textModelOptions"
            :default-label="t('episode.model.defaultWith', { model: textModelOptions[0].model })"
            :show-config="textModelMultiCfg"
          />
          <ModelSelect
            v-if="imageModelOptions.length"
            v-model="imageModel"
            :label="t('common.serviceType.image')"
            :options="imageModelOptions"
            :default-label="t('episode.model.defaultWith', { model: imageModelOptions[0].model })"
            :show-config="imageModelMultiCfg"
          />
          <ModelSelect
            v-if="videoModelOptions.length"
            v-model="videoModel"
            :label="isComfyVideoMode ? t('episode.comfy.modelLabel') : t('common.serviceType.video')"
            :options="videoModelOptions"
            :default-label="defaultVideoModelLabel"
            :show-config="videoModelMultiCfg"
          />
          <ModelSelect
            v-if="!isComfyVideoMode"
            v-model="episodeResolution"
            :label="t('episode.topbar.resolution')"
            :options="resolutionOptions"
            hide-default
          />
          <ModelSelect
            v-if="videoModelOptions.length"
            v-model="episodeVideoAudioMode"
            :label="t('episode.topbar.videoAudio')"
            :options="videoAudioModeOptions"
            hide-default
          />
        </div>
      </template>

      <template #right>
        <div class="studio-actions">
          <LocaleSwitcher />
          <button type="button" class="btn btn-icon tour-help-btn" :title="t('tour.helpTitle')" :aria-label="t('tour.helpTitle')" @click="startTour('episode', EPISODE_TOUR, t)">
            <CircleHelp :size="14" :stroke-width="1.8" aria-hidden="true" />
          </button>
          <button v-if="dubbingEnabled" type="button" class="btn" @click="openDubbingStage">
            <Mic :size="12" aria-hidden="true" />
            {{ t('workbench.title') }}
          </button>
          <button v-if="hasEditEntry" type="button" class="btn" @click="openEditWorkspace">
            <Scissors :size="12" aria-hidden="true" />
            {{ t('edit.entry') }}
          </button>
          <button type="button" class="btn" @click="deliveryOpen = true">
            <Download :size="12" aria-hidden="true" />
            {{ t('delivery.entry') }}
          </button>
          <button type="button" class="btn" @click="refresh">
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            {{ t('common.refresh') }}
          </button>
          <button type="button" class="btn task-drawer-trigger" @click="openTaskDrawer">
            <ListTodo :size="12" aria-hidden="true" />
            {{ t('episode.topbar.tasks') }}
            <span v-if="genTaskActiveCount" class="task-drawer-badge">{{ genTaskActiveCount }}</span>
          </button>
        </div>
      </template>
    </StudioTopBar>

    <div class="studio-body">
    <!-- ========== LEFT SIDEBAR ========== -->
    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
      <nav class="pipeline">
        <div
          v-for="section in sidebarSections"
          :key="section.id"
          :class="['pipe-section', 'is-' + sectionState(section.id)]"
        >
          <div class="pipe-section-label">
            <span v-if="sectionState(section.id) !== 'none'" class="pipe-section-state">
              <svg v-if="sectionState(section.id) === 'done'" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span v-else-if="sectionState(section.id) === 'active'" class="pipe-section-pulse" />
              <span v-else class="pipe-section-dot" />
            </span>
            <span>{{ section.label }}</span>
            <span v-if="sectionState(section.id) === 'active'" class="pipe-section-tag">{{ t('episode.sidebar.inProgress') }}</span>
          </div>
          <button
            v-for="item in section.items"
            :key="item.key"
            :class="['pipe-item pipe-item-sub', {
              active: activeSubStepKey === item.key,
              done: sectionState(section.id) === 'done',
              doing: sectionState(section.id) === 'active',
            }]"
            :title="sidebarCollapsed ? item.label : undefined"
            @click="goSubStep(item.key)"
          >
            <span class="pipe-icon" :class="sectionState(section.id) === 'done' ? 'icon-done' : activeSubStepKey === item.key ? 'icon-active' : ''">
              <!-- 收起态：始终显示步骤图标，进行中用右上角小脉冲点表达 -->
              <template v-if="sidebarCollapsed">
                <component :is="item.icon" :size="12" />
                <span v-if="sectionState(section.id) === 'active'" class="pipe-mini-pulse" />
              </template>
              <svg v-else-if="sectionState(section.id) === 'done'" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span v-else-if="sectionState(section.id) === 'active'" class="pipe-item-pulse" />
              <component v-else :is="item.icon" :size="11" />
            </span>
            <span class="pipe-copy">
              <span class="pipe-label">{{ item.label }}</span>
              <span v-if="item.desc" class="pipe-sub">{{ item.desc }}</span>
            </span>
          </button>
        </div>
      </nav>

      <!-- Bottom: 收起/展开 + Stage marquee + Refresh -->
      <div class="sidebar-bottom">
        <button
          type="button"
          class="sidebar-toggle"
          :title="t(sidebarCollapsed ? 'episode.sidebar.expand' : 'episode.sidebar.collapse')"
          @click="toggleSidebar"
        >
          <svg class="sidebar-toggle-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          <span v-if="!sidebarCollapsed">{{ t('episode.sidebar.collapse') }}</span>
        </button>
        <!-- 步骤跑马灯：四段主流程进度，当前段流动光效，点击段可跳转 -->
        <div class="sidebar-progress">
          <div class="sidebar-progress-head">
            <span class="sidebar-progress-title">{{ currentStageLabel }}</span>
            <span class="sidebar-progress-count">{{ currentMainIdx + 1 }}/{{ mainProgressSteps.length }}</span>
          </div>
          <div class="sidebar-progress-track">
            <button
              v-for="(s, i) in mainProgressSteps"
              :key="s.id"
              type="button"
              :class="['sidebar-progress-seg', { done: i < currentMainIdx || mainStageDone(s.id), current: i === currentMainIdx }]"
              :title="s.label"
              @click="goMainStage(s.id)"
            ><span class="sidebar-progress-seg-fill" /></button>
          </div>
          <div class="sidebar-progress-labels">
            <span
              v-for="(s, i) in mainProgressSteps"
              :key="s.id"
              :class="{ on: i === currentMainIdx, done: i < currentMainIdx || mainStageDone(s.id) }"
            >{{ s.label }}</span>
          </div>
        </div>
        <button class="refresh-btn" @click="refresh">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          {{ t('episode.sidebar.refreshData') }}
        </button>
      </div>
    </aside>

    <!-- ========== MAIN CONTENT ========== -->
    <main class="main">
      <!-- ===== SCRIPT PANEL ===== -->
      <div v-if="panel === 'script'" class="content-panel">
        <!-- Step 0: Raw Content -->
        <div v-if="scriptStep === 0" class="step-editor">
          <div class="step-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <span class="step-num">01</span>
                <span class="step-name">{{ t('episode.script.raw') }}</span>
              </div>
            </div>
            <div class="toolbar-right">
              <span v-if="rawLen" class="char-count">{{ t('episode.script.charCount', { n: rawLen }) }}</span>
              <button class="btn btn-sm" @click="saveRaw(); toast.success(t('episode.script.saved'))">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                {{ t('common.save') }}
              </button>
            </div>
          </div>
          <textarea
            class="fill-textarea"
            v-model="localRaw"
            :placeholder="t('episode.script.rawPlaceholder')"
          />
        </div>

        <!-- Step 1: Rewrite -->
        <div v-else-if="scriptStep === 1" class="step-editor">
          <div class="step-toolbar">
            <div class="toolbar-left">
              <div class="step-indicator">
                <span class="step-num">02</span>
                <span class="step-name">{{ t('episode.script.rewrite') }}</span>
              </div>
            </div>
            <div class="toolbar-right">
              <span v-if="scriptLen" class="char-count">{{ t('episode.script.charCount', { n: scriptLen }) }}</span>
              <button v-if="rawContent" class="btn btn-sm" @click="skipRewrite">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M13 18l6-6-6-6"/></svg>
                {{ t('episode.script.skipRewrite') }}
              </button>
              <button v-if="scriptContent" class="btn btn-sm" @click="doRewrite" :disabled="rn">
                <Loader2 v-if="rn && rt === 'script_rewriter'" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
                {{ t('episode.script.rewriteAgain') }}
              </button>
            </div>
          </div>

          <div v-if="!scriptContent && !rn" class="step-empty">
            <div class="empty-visual">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>
              </svg>
            </div>
            <div class="empty-title">{{ t('episode.script.emptyTitle') }}</div>
            <div class="empty-desc">{{ t('episode.script.emptyDesc') }}</div>
            <div class="step-empty-actions">
              <button class="btn btn-primary" @click="doRewrite">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                {{ t('episode.script.startRewrite') }}
              </button>
              <button class="btn" @click="skipRewrite">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/><path d="M13 18l6-6-6-6"/></svg>
                {{ t('episode.script.skipRewrite') }}
              </button>
            </div>
          </div>
          <div v-else-if="rn && rt === 'script_rewriter'" class="step-loading">
            <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
            <div class="loading-text">{{ t('episode.script.rewriting') }}</div>
          </div>
          <textarea v-else class="fill-textarea" v-model="localScript" :placeholder="t('episode.script.scriptPlaceholder')" />
        </div>
      </div>

      <!-- ===== PRODUCTION PANEL ===== -->
      <div v-else-if="panel === 'production'" class="content-panel">
        <!-- Guard: current production step prerequisites -->
        <div v-if="productionBlockMessage" class="step-empty" style="flex:1">
          <div class="empty-visual">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
          </div>
          <div class="empty-title">{{ t('episode.prod.notReady') }}</div>
          <div class="empty-desc">{{ productionBlockMessage }}</div>
          <button class="btn btn-primary" @click="goProductionBlockTarget">{{ productionBlockActionLabel }}</button>
        </div>

        <template v-else>
          <!-- 制作子步骤导航（资产/分镜拆分/视频生成）由左侧栏承担，顶部不再重复展示 -->
          <!-- Sub: Assets -->
          <div v-if="prodTab === 'assets'" class="prod-content">
            <div class="prod-section-bar">
              <span class="dim" style="font-size:12px">{{ t('episode.prod.assets') }}</span>
              <span class="tag mono">{{ t('episode.prod.readyCount', { ready: assetReadyCount, total: assetTotalCount }) }}</span>
              <div class="ml-auto flex gap-1 asset-bar-actions">
                <button
                  v-for="et in EXTRACT_TARGETS"
                  :key="et.key"
                  class="btn btn-sm asset-btn-extract"
                  :disabled="isExtracting(et.key)"
                  @click="doExtract(et.key)"
                >
                  <Loader2 v-if="isExtracting(et.key)" :size="11" class="animate-spin" />
                  <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  {{ (et.key === 'characters' ? chars.length : et.key === 'scenes' ? scenes.length : propItems.length) ? t('episode.prod.reextract', { type: et.label }) : t('episode.prod.extract', { type: et.label }) }}
                </button>
                <span class="asset-bar-divider" />
                <button class="btn btn-sm asset-btn-batch" @click="batchCharImages">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  {{ t('episode.prod.batchChar') }}
                </button>
                <button class="btn btn-sm asset-btn-batch" @click="batchSceneImages">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  {{ t('episode.prod.batchScene') }}
                </button>
                <button class="btn btn-sm asset-btn-batch" @click="batchPropImages">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  {{ t('episode.prod.batchProp') }}
                </button>
              </div>
            </div>
            <div v-if="extractingTargets.length && !chars.length && !scenes.length && !propItems.length" class="step-loading">
              <Loader2 :size="24" class="animate-spin" style="color:var(--accent)" />
              <div class="loading-text">{{ t('episode.prod.extractingTypes', { types: extractingLabels }) }}</div>
            </div>
            <div v-else-if="!chars.length && !scenes.length && !propItems.length" class="step-empty asset-empty-state">
              <div class="empty-visual">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              </div>
              <div class="empty-title">{{ t('episode.prod.emptyTitle') }}</div>
              <div class="empty-desc">{{ t('episode.prod.emptyDesc') }}</div>
              <button class="btn btn-primary" :disabled="!!extractingTargets.length" @click="doExtractAll">
                <Loader2 v-if="extractingTargets.length" :size="13" class="animate-spin" />
                <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                {{ extractingTargets.length ? t('episode.prod.extractingTypesDots', { types: extractingLabels }) : t('episode.prod.startExtract') }}
              </button>
            </div>
            <template v-else>
            <div class="asset-section-title">
              {{ t('common.role') }}
              <button class="asset-add-btn" @click="openAssetCreate('character')"><Plus :size="11" /> {{ t('common.add') }}</button>
            </div>
            <template v-if="visualChars.length">
            <div class="character-asset-grid">
              <article
                v-for="c in visualChars"
                :key="c.id"
                class="card character-asset-card"
                tabindex="0"
                role="button"
                @click="openAssetDetail('character', c)"
                @keydown.enter.self.prevent="openAssetDetail('character', c)"
                @keydown.space.self.prevent="openAssetDetail('character', c)"
              >
                <button class="asset-del-btn" :title="t('episode.asset.delChar')" @click.stop="askDeleteAsset('character', c)"><X :size="11" /></button>
                <div class="character-asset-main">
                  <div class="character-asset-overview"><div class="character-portrait">
                      <img
                        v-if="c.image_url || c.imageUrl"
                        :src="thumbOf(assetImageSrc(c))"
                        class="previewable-image"
                        loading="lazy"
                        @error="thumbFallback($event, assetImageSrc(c))"
                        @click.stop="openImageViewer(assetImageSrc(c), t('episode.asset.charImageTitle', { name: c.name }))"
                      />
                      <div v-else class="character-portrait-empty">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                      </div>
                      <span class="asset-cover-badge" :class="(c.image_url || c.imageUrl) ? 'is-ready' : (isPendingCharImage(c.id) ? 'is-pending' : '')">
                        {{ (c.image_url || c.imageUrl) ? t('episode.asset.portraitReady') : (isPendingCharImage(c.id) ? t('episode.asset.portraitPending') : t('episode.asset.portraitTodo')) }}
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
                      <button class="btn btn-sm character-gen-btn" :disabled="isPendingCharImage(c.id)" @click.stop="genCharImg(c.id)">
                        <Loader2 v-if="isPendingCharImage(c.id)" :size="11" class="animate-spin" />
                        {{ (c.image_url || c.imageUrl) ? t('episode.asset.regen') : (isPendingCharImage(c.id) ? t('episode.asset.generating') : t('episode.asset.generate')) }}
                      </button>
                      <button class="btn btn-sm" :title="t('episode.asset.uploadCharImage')" :disabled="isUploadingAsset('character', c.id)" @click.stop="uploadAssetImage('character', c.id)">
                        <Loader2 v-if="isUploadingAsset('character', c.id)" :size="11" class="animate-spin" />
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
              <button class="asset-add-btn" @click="openAssetCreate('scene')"><Plus :size="11" /> {{ t('common.add') }}</button>
            </div>
            <template v-if="scenes.length">
            <div class="asset-grid">
              <div
                v-for="s in scenes"
                :key="s.id"
                class="card asset-card asset-click-card"
                tabindex="0"
                role="button"
                @click="openAssetDetail('scene', s)"
                @keydown.enter.prevent="openAssetDetail('scene', s)"
                @keydown.space.prevent="openAssetDetail('scene', s)"
              >
                <button class="asset-del-btn" :title="t('episode.asset.delScene')" @click.stop="askDeleteAsset('scene', s)"><X :size="11" /></button>
                <div class="asset-cover wide">
                  <img
                    v-if="s.image_url || s.imageUrl"
                    :src="thumbOf(assetImageSrc(s))"
                    class="previewable-image"
                    loading="lazy"
                    @error="thumbFallback($event, assetImageSrc(s))"
                    @click.stop="openImageViewer(assetImageSrc(s), t('episode.asset.sceneImageTitle', { name: s.location }))"
                  />
                  <div v-else class="asset-cover-empty">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  </div>
                  <span class="asset-cover-badge" :class="(s.image_url || s.imageUrl) ? 'is-ready' : (isPendingSceneImage(s.id) ? 'is-pending' : '')">{{ (s.image_url || s.imageUrl) ? t('episode.asset.ready') : (isPendingSceneImage(s.id) ? t('episode.asset.generating') : t('episode.asset.todo')) }}</span>
                </div>
                <div class="asset-body">
                  <div class="asset-name" :title="s.location">{{ s.location }}</div>
                  <div class="asset-meta asset-desc dim" :title="sceneDescriptionValue(s)">{{ sceneDescriptionValue(s) }}</div>
                  <div v-if="sceneLightingValue(s)" class="asset-meta asset-light dim" :title="sceneLightingValue(s)">{{ t('episode.asset.lighting') }}{{ sceneLightingValue(s) }}</div>
                  <div class="asset-meta asset-final" :class="{ dim: !(s.final_prompt || s.finalPrompt) }" :title="s.final_prompt || s.finalPrompt || ''">
                    <span class="afp-label">{{ t('episode.asset.finalPromptFixed') }}</span>
                    {{ s.final_prompt || s.finalPrompt || t('episode.asset.finalPromptAutoFixed') }}
                  </div>
                </div>
                <div class="asset-foot">
                  <span :class="['dot', (s.image_url || s.imageUrl) && 'ok', isPendingSceneImage(s.id) && 'pending']" />
                  <span v-if="assetRefs(s).length" class="asset-ref-chip">{{ t('episode.asset.refBadge', { n: assetRefs(s).length }) }}</span>
                  <button class="btn btn-sm ml-auto" :title="t('episode.asset.uploadSceneImage')" :disabled="isUploadingAsset('scene', s.id)" @click.stop="uploadAssetImage('scene', s.id)">
                    <Loader2 v-if="isUploadingAsset('scene', s.id)" :size="11" class="animate-spin" />
                    <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    {{ t('episode.asset.upload') }}
                  </button>
                  <button class="btn btn-sm" :disabled="isPendingSceneImage(s.id)" @click.stop="genSceneImg(s.id)">
                    <Loader2 v-if="isPendingSceneImage(s.id)" :size="11" class="animate-spin" />
                    {{ (s.image_url || s.imageUrl) ? t('episode.asset.regen') : (isPendingSceneImage(s.id) ? t('episode.asset.generating') : t('episode.asset.generate')) }}
                  </button>
                </div>
              </div>
            </div>
            </template>

            <div class="asset-section-title">
              {{ t('common.prop') }}
              <button class="asset-add-btn" @click="openAssetCreate('prop')"><Plus :size="11" /> {{ t('common.add') }}</button>
            </div>
            <div v-if="propItems.length" class="asset-grid">
              <div
                v-for="p in propItems"
                :key="p.id"
                class="card asset-card asset-click-card prop-card"
                tabindex="0"
                role="button"
                @click="openAssetDetail('prop', p)"
                @keydown.enter.prevent="openAssetDetail('prop', p)"
                @keydown.space.prevent="openAssetDetail('prop', p)"
              >
                <button class="asset-del-btn" :title="t('episode.asset.delProp')" @click.stop="askDeleteAsset('prop', p)"><X :size="11" /></button>
                <div class="asset-cover wide">
                  <img
                    v-if="p.image_url || p.imageUrl"
                    :src="thumbOf(assetImageSrc(p))"
                    class="previewable-image"
                    loading="lazy"
                    @error="thumbFallback($event, assetImageSrc(p))"
                    @click.stop="openImageViewer(assetImageSrc(p), t('episode.asset.propImageTitle', { name: p.name }))"
                  />
                  <div v-else class="asset-cover-empty">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                  </div>
                  <span class="asset-cover-badge" :class="(p.image_url || p.imageUrl) ? 'is-ready' : (isPendingPropImage(p.id) ? 'is-pending' : '')">{{ (p.image_url || p.imageUrl) ? t('episode.asset.ready') : (isPendingPropImage(p.id) ? t('episode.asset.generating') : t('episode.asset.todo')) }}</span>
                </div>
                <div class="asset-body">
                  <div class="prop-name-row">
                    <span class="asset-name" :title="p.name">{{ p.name }}</span>
                    <span class="tag">{{ p.type || t('common.prop') }}</span>
                  </div>
                  <div class="asset-meta asset-desc dim" :title="p.description || ''">{{ p.description || t('episode.asset.noDescription') }}</div>
                  <div class="asset-meta asset-final" :class="{ dim: !(p.final_prompt || p.finalPrompt) }" :title="p.final_prompt || p.finalPrompt || ''">
                    <span class="afp-label">{{ t('episode.asset.finalPromptWhiteBg') }}</span>
                    {{ p.final_prompt || p.finalPrompt || t('episode.asset.finalPromptAutoWhiteBg') }}
                  </div>
                </div>
                <div class="asset-foot">
                  <span :class="['dot', (p.image_url || p.imageUrl) && 'ok', isPendingPropImage(p.id) && 'pending']" />
                  <span v-if="assetRefs(p).length" class="asset-ref-chip">{{ t('episode.asset.refBadge', { n: assetRefs(p).length }) }}</span>
                  <button class="btn btn-sm ml-auto" :title="t('episode.asset.uploadPropImage')" :disabled="isUploadingAsset('prop', p.id)" @click.stop="uploadAssetImage('prop', p.id)">
                    <Loader2 v-if="isUploadingAsset('prop', p.id)" :size="11" class="animate-spin" />
                    <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    {{ t('episode.asset.upload') }}
                  </button>
                  <button class="btn btn-sm" :disabled="isPendingPropImage(p.id)" @click.stop="genPropImg(p.id)">
                    <Loader2 v-if="isPendingPropImage(p.id)" :size="11" class="animate-spin" />
                    {{ (p.image_url || p.imageUrl) ? t('episode.asset.regen') : (isPendingPropImage(p.id) ? t('episode.asset.generating') : t('episode.asset.generate')) }}
                  </button>
                </div>
              </div>
            </div>
            <div v-else class="asset-props-empty">{{ t('episode.asset.propsEmpty') }}</div>
            </template>
          </div>

          <!-- Sub: Video Production（分镜拆分 + 视频生成 合并） -->
          <div v-if="prodTab === 'videos'" class="prod-content">
            <div class="prod-section-bar">
              <div class="video-mode-tabs" role="tablist" :aria-label="t('episode.comfy.modeLabel')">
                <button
                  type="button"
                  role="tab"
                  :aria-selected="!isComfyVideoMode"
                  :class="['video-mode-tab', { active: !isComfyVideoMode }]"
                  @click="changeEpisodeVideoMode('native')"
                >{{ t('episode.comfy.modeNative') }}</button>
                <button
                  type="button"
                  role="tab"
                  :aria-selected="isComfyVideoMode"
                  :class="['video-mode-tab', { active: isComfyVideoMode }]"
                  @click="changeEpisodeVideoMode('comfyui')"
                >{{ t('episode.comfy.modeComfy') }}</button>
              </div>
              <span class="dim" style="font-size:12px">{{ t('episode.prod.videos') }}</span>
              <span class="tag mono">{{ t('episode.sb.segmentStat', { n: sbs.length, dur: totalDuration }) }}</span>
              <span class="tag mono" :title="t('episode.vid.aspectRatio')">{{ dramaAspectRatio }}</span>
              <div class="ml-auto flex gap-1">
                <button class="btn btn-sm" :disabled="rn" @click="doBreakdown">
                  <Loader2 v-if="rt === 'storyboard_breaker'" :size="11" class="animate-spin" />
                  <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                  {{ sbs.length ? t('episode.sb.rebreak') : t('episode.sb.startBreak') }}
                </button>
                <button class="btn btn-sm" :disabled="videoPromptBatch.running || !sbs.length" @click="batchVideoPrompts">
                  <Loader2 v-if="videoPromptBatch.running" :size="11" class="animate-spin" />
                  <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  {{ videoPromptBatch.running ? t('episode.sb.promptProgress', { done: videoPromptBatch.completed, total: videoPromptBatch.total }) : (videoSelectMode && selectedVideoSbIds.length ? t('episode.sb.promptSelected', { n: selectedVideoSbIds.length }) : t('episode.sb.batchPrompts')) }}
                </button>
                <button v-if="recoverableVideoCount && !isComfyVideoMode" class="btn btn-sm video-retry-failed" @click="retryFailedVideos">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                  {{ t('episode.recovery.restoreFailed', { n: recoverableVideoCount }) }}
                </button>
                <button v-if="!isComfyVideoMode" class="btn btn-sm" :class="{ 'is-on': videoSelectMode }" @click="toggleVideoSelectMode">
                  {{ videoSelectMode ? t('episode.vid.selectDone', { n: selectedVideoSbIds.length }) : t('episode.vid.select') }}
                </button>
                <button v-if="!isComfyVideoMode" class="btn btn-sm" :disabled="!sbs.length" @click="batchVideos">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                  {{ videoSelectMode && selectedVideoSbIds.length ? t('episode.vid.batchSelected', { n: selectedVideoSbIds.length }) : t('episode.vid.batchVideos') }}
                </button>
              </div>
            </div>
            <div v-if="!sbs.length" class="step-empty video-task-empty-state">
              <div class="empty-visual">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="2" y="2" width="20" height="20" rx="2.5"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="8" x2="13" y2="16"/></svg>
              </div>
              <div class="empty-title">{{ t('episode.sb.emptyTitle') }}</div>
              <div class="empty-desc">{{ rt === 'storyboard_breaker' ? t('episode.sb.breakingElapsed', { s: breakdownElapsed }) : t('episode.sb.emptyDesc') }}</div>
              <div class="locked-config-banner">{{ t('episode.vid.lockedModel') }}{{ effectiveVideoModelLabel }}</div>
              <button class="btn btn-primary" :disabled="rn" @click="doBreakdown">
                <Loader2 v-if="rt === 'storyboard_breaker'" :size="13" class="animate-spin" />
                <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                {{ t('episode.sb.startBreak') }}
              </button>
            </div>
            <div v-else class="video-task-workbench has-player" :style="{ '--vleft': videoLeftW + 'px', '--vright': videoRightW + 'px' }">
              <section class="video-task-list">
                <div class="video-task-head">
                <div>
                  <div class="video-task-title">{{ t('episode.vid.listTitle') }}</div>
                  <div class="video-task-meta">{{ videoListFilter ? t('episode.vid.listMetaFiltered', { n: videoTaskRows.length, total: allVideoTaskRows.length }) : t('episode.vid.listMeta', { n: videoTaskRows.length }) }}</div>
                </div>
                <div class="video-task-metrics">
                  <button type="button" class="video-task-metric is-pending" :class="{ on: videoListFilter === 'pending' }" @click="toggleVideoFilter('pending')">{{ t('episode.vid.metricPending', { n: pendingVideoIds.length }) }}</button>
                  <button type="button" class="video-task-metric is-done" :class="{ on: videoListFilter === 'done' }" @click="toggleVideoFilter('done')">{{ t('episode.vid.metricDone', { n: videoTaskDoneCount }) }}</button>
                  <button type="button" class="video-task-metric is-failed" :class="{ on: videoListFilter === 'failed' }" @click="toggleVideoFilter('failed')">{{ t('episode.vid.metricFailed', { n: videoTaskFailedCount }) }}</button>
                </div>
                </div>
                <div v-if="videoSelectMode" class="shot-quick-actions video-quick-actions">
                  <button class="shot-quick-btn" @click="toggleSelectAllVideos">{{ t('episode.sb.selectAll') }}</button>
                  <button class="shot-quick-btn" @click="selectMissingVideos">{{ t('episode.vid.selectMissing') }}</button>
                  <button class="shot-quick-btn" @click="selectedVideoSbIds = []">{{ t('episode.sb.clear') }}</button>
                </div>
                <div class="video-task-table">
                <div
                  v-for="task in videoTaskRows"
                  :key="task.id"
                  :class="['video-task-row', 'is-' + videoTaskState(task.storyboard), { active: !videoSelectMode && selectedSb?.id === task.storyboard.id, 'is-selected': videoSelectMode && isVideoSbSelected(task.id) }]"
                  role="button"
                  tabindex="0"
                  @click="onVideoTaskRowClick(task.storyboard)"
                  @keydown.enter.prevent="onVideoTaskRowClick(task.storyboard)"
                  @keydown.space.prevent="onVideoTaskRowClick(task.storyboard)"
                >
                  <div class="video-task-preview">
                    <span
                      v-if="videoSelectMode"
                      class="shot-check video-task-check"
                      :class="{ on: isVideoSbSelected(task.id) }"
                    >
                      <svg v-if="isVideoSbSelected(task.id)" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </span>
                    <video
                      v-if="hasVid(task.storyboard)"
                      :src="'/' + getVideoUrl(task.storyboard)"
                      :poster="posterOf('/' + getVideoUrl(task.storyboard)) || undefined"
                      preload="none"
                      playsinline
                      muted
                      tabindex="-1"
                    />
                    <div v-else class="video-task-empty">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                    </div>
                    <span class="video-task-index">#{{ String(task.index + 1).padStart(2, '0') }}</span>
                  </div>
                  <div class="video-task-main">
                    <div class="video-task-line">
                      <strong class="video-task-name">{{ task.title }}</strong>
                    </div>
                    <div class="video-task-meta-line">
                      <span :class="['video-task-state', 'is-' + videoTaskState(task.storyboard)]">
                        <i :class="['dot', videoTaskState(task.storyboard) === 'done' && 'ok', videoTaskState(task.storyboard) === 'pending' && 'pending']" />{{ videoTaskStatusLabel(task.storyboard) }}
                      </span>
                      <span class="video-task-sep">·</span>
                      <span>{{ task.duration }}s</span>
                      <template v-if="task.meta">
                        <span class="video-task-sep">·</span>
                        <span class="video-task-loc truncate">{{ task.meta }}</span>
                      </template>
                    </div>
                    <div v-if="task.error" class="video-task-error" :title="task.error">
                      {{ videoErrorLabel(task.id, task.error) }}
                      <div class="flex gap-2">
                        <button class="btn btn-sm" @click.stop="copyVideoDiagnostics(task.id)">{{ t('episode.recovery.diagnostics') }}</button>
                        <button v-if="canRecoverVideo(task.id)" class="btn btn-sm" @click.stop="genVid(task.storyboard, { forceNew: true })">{{ t('episode.recovery.newGeneration') }}</button>
                      </div>
                      <div v-if="videoModerationHint(task.error)" class="video-task-error-hint">{{ videoModerationHint(task.error) }}</div>
                    </div>
                  </div>
                  <button
                    v-if="!isComfyVideoMode"
                    class="btn btn-icon btn-sm video-task-action"
                    :title="videoTaskActionLabel(task.storyboard)"
                    :disabled="videoTaskState(task.storyboard) === 'pending'"
                    @click.stop="genVid(task.storyboard)"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                  </button>
                </div>
                </div>
                <div v-if="isComfyVideoMode" class="video-task-footer">
                  <div v-if="comfyPendingTaskId" class="video-task-footer-status">
                    <span class="dot pending" />
                    <span>{{ t('episode.comfy.liveRunning', { id: comfyPendingTaskId }) }}</span>
                  </div>
                  <div class="video-task-footer-actions">
                    <button type="button" class="btn" @click="changeEpisodeVideoMode('native')">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                      {{ t('episode.comfy.editNative') }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-primary"
                      :disabled="comfyRunning || !!comfyPendingTaskId"
                      @click="runComfyEpisode"
                    >
                      <Loader2 v-if="comfyRunning" :size="11" class="animate-spin" />
                      <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                      {{ comfyPendingTaskId ? t('episode.comfy.running') : t('episode.comfy.submit') }}
                    </button>
                  </div>
                </div>
              </section>

              <section v-if="isComfyVideoMode" class="comfy-embed-stage">
                <div class="comfy-embed-head">
                  <div class="comfy-embed-heading">
                    <div class="comfy-embed-title">{{ t('episode.comfy.monitorTitle') }}</div>
                    <div class="comfy-embed-sub">
                      {{ comfyConfigName }}<span v-if="comfyUiGateway"> · {{ t('episode.comfy.viaGateway') }}</span>
                    </div>
                  </div>
                  <div v-if="comfyPreview" class="comfy-embed-metrics">
                    <span><b>{{ comfyPreview.timeline.segments.length }}</b>{{ t('episode.comfy.segments') }}</span>
                    <span><b>{{ comfyPreview.timeline.totalFrames }}</b>{{ t('episode.comfy.frames') }}</span>
                    <span><b>{{ comfyPreview.timeline.durationSec }}s</b></span>
                    <span><b>{{ comfyPreview.mapping.width }}×{{ comfyPreview.mapping.height }}</b></span>
                  </div>
                  <span :class="['comfy-embed-live', { running: !!comfyPendingTaskId }]">
                    <i class="dot" />
                    {{ comfyPendingTaskId ? t('episode.comfy.liveRunning', { id: comfyPendingTaskId }) : t('episode.comfy.liveIdle') }}
                  </span>
                  <div class="comfy-embed-actions">
                    <button type="button" class="btn btn-sm" :disabled="comfyUiLoading" @click="reloadComfyUi">
                      <Loader2 v-if="comfyUiLoading" :size="11" class="animate-spin" />
                      <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                      {{ t('common.refresh') }}
                    </button>
                    <button type="button" class="btn btn-sm" :disabled="!comfyUiUrl" @click="openComfyUI">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                      {{ t('episode.comfy.open') }}
                    </button>
                  </div>
                </div>
                <div v-if="comfyPreviewError" class="comfy-embed-notice is-warning">
                  <span>{{ comfyPreviewError }}</span>
                  <button type="button" class="btn btn-sm" @click="goComfySettings">{{ t('episode.comfy.openSettings') }}</button>
                </div>
                <div v-else-if="comfyPreview && comfyPreview.warnings.length" class="comfy-embed-notice is-warning">
                  <span v-for="(warning, wi) in comfyPreview.warnings" :key="wi">· {{ warning }}</span>
                </div>
                <div class="comfy-embed-body">
                  <div v-if="comfyUiLoading && !comfyUiUrl" class="comfy-embed-state">
                    <Loader2 :size="20" class="animate-spin" />
                    <span>{{ t('episode.comfy.monitorLoading') }}</span>
                  </div>
                  <div v-else-if="comfyUiError" class="comfy-embed-state is-error">
                    <div>{{ comfyUiError }}</div>
                    <div class="comfy-embed-state-actions">
                      <button type="button" class="btn btn-sm" @click="reloadComfyUi">{{ t('episode.comfy.retry') }}</button>
                      <button type="button" class="btn btn-sm" @click="goComfySettings">{{ t('episode.comfy.openSettings') }}</button>
                    </div>
                  </div>
                  <iframe
                    v-else-if="comfyUiUrl"
                    :key="comfyUiFrameKey"
                    :src="comfyUiUrl"
                    class="comfy-embed-frame"
                    allow="clipboard-read; clipboard-write; fullscreen"
                    referrerpolicy="no-referrer"
                    allowfullscreen
                  />
                  <div v-else class="comfy-embed-state">{{ t('episode.comfy.noPreview') }}</div>
                </div>
                <div class="comfy-embed-foot">{{ t('episode.comfy.monitorReadonly') }}</div>
              </section>

              <div v-else-if="selectedSb" class="video-task-side">
              <div class="video-main-col">
              <div class="video-main-scroll">
                <div class="video-main-grid">
                  <section class="video-inspector-section">
                    <span class="video-inspector-label">{{ t('episode.sb.descSection') }}</span>
                    <label class="field">
                      <span class="field-label">{{ t('episode.sb.descLabel') }} <span class="dim">({{ t('episode.sb.descHint') }})</span></span>
                      <textarea :value="selectedSb.description || ''" class="textarea" rows="7" @blur="updateField(selectedSb, 'description', $event.target.value)" :placeholder="t('episode.sb.descPlaceholder')" />
                    </label>
                    <label class="field">
                      <span class="field-label">{{ t('episode.sb.atmosphere') }}</span>
                      <textarea :value="selectedSb.atmosphere || ''" class="textarea" rows="2" @blur="updateField(selectedSb, 'atmosphere', $event.target.value)" :placeholder="t('episode.sb.atmospherePlaceholder')" />
                    </label>
                    <label class="field">
                      <span class="field-label">{{ t('episode.sb.transition') }}</span>
                      <BaseSelect
                        :model-value="selectedSb.transition || 'cut'"
                        :options="transitionOptions"
                        :searchable="false"
                        @update:model-value="v => updateField(selectedSb, 'transition', v)"
                      />
                    </label>
                    <label class="field">
                      <span class="field-label">{{ t('episode.sb.continuity') }}</span>
                      <textarea :value="selectedSb.continuity || ''" class="textarea" rows="2" @blur="updateField(selectedSb, 'continuity', $event.target.value)" :placeholder="t('episode.sb.continuityPlaceholder')" />
                    </label>
                  </section>

                  <section class="video-inspector-section">
                    <div class="video-inspector-prompt-head">
                      <span class="video-inspector-label">{{ t('episode.ref.title') }}</span>
                      <span class="tag mono">{{ t('episode.ref.boundCount', { bound: refBindableAssets.filter(a => a.bound).length, total: refBindableAssets.length }) }}</span>
                    </div>
                    <p class="storyboard-ref-scope-hint">{{ t('episode.ref.scopeHint') }}</p>
                    <div class="storyboard-ref-list is-embedded">
                      <template v-for="g in REF_KINDS" :key="g.kind">
                        <div v-if="refBindableAssets.filter(a => a.kind === g.kind).length" class="storyboard-ref-group">
                          <div class="storyboard-ref-group-label">{{ g.label }} <span class="dim">· {{ g.hint }}</span></div>
                          <div
                            v-for="asset in refBindableAssets.filter(a => a.kind === g.kind)"
                            :key="asset.key"
                            :class="['storyboard-ref-item', { bound: asset.bound }]"
                            :title="asset.bound ? t('episode.ref.clickRemove') : t('episode.ref.clickAdd')"
                            @click="toggleShotBind(selectedSb, asset)"
                          >
                            <button
                              type="button"
                              class="storyboard-ref-thumb"
                              :disabled="!asset.ready"
                              @click.stop="asset.ready && openImageViewer(assetImageSrc({ imageUrl: asset.imageUrl }), `${asset.name} ${asset.typeLabel}`)"
                            >
                              <img v-if="asset.ready" :src="thumbOf(assetImageSrc({ imageUrl: asset.imageUrl }))" class="previewable-image" loading="lazy" @error="thumbFallback($event, assetImageSrc({ imageUrl: asset.imageUrl }))" />
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
                              <button v-if="asset.bound && !asset.ready" type="button" class="storyboard-ref-goto" @click.stop="prodTab = 'assets'">{{ t('episode.ref.gotoGenerate') }}</button>
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
                        :disabled="videoPromptGeneratingIds.includes(selectedSb?.id) || videoPromptBatch.running"
                        @click="genVideoPrompt(selectedSb)"
                      >
                        <Loader2 v-if="videoPromptGeneratingIds.includes(selectedSb?.id)" :size="11" class="animate-spin" />
                        {{ (selectedSb.video_prompt || selectedSb.videoPrompt) ? t('episode.sb.regenPrompt') : t('episode.sb.aiGenerate') }}
                      </button>
                    </div>
                    <MentionTextarea
                      :model-value="selectedSb.video_prompt || selectedSb.videoPrompt || ''"
                      :options="mentionOptions"
                      :rows="14"
                      input-class="textarea video-inspector-prompt"
                      :placeholder="t('episode.inspector.videoPromptPlaceholder')"
                      @commit="v => updateField(selectedSb, 'video_prompt', v)"
                    />
                    <p class="voice-reference-hint">{{ t('characterVoice.referenceHint') }}</p>
                  </section>
              </div>
              </div>

              <aside class="video-task-inspector">
            <aside v-if="!isComfyVideoMode" class="video-task-player">
              <div class="video-player-head">
                <div class="video-player-head-info">
                  <div class="video-player-title">{{ t('episode.vid.playerTitle', { n: String(selectedVideoTaskNumber).padStart(2, '0') }) }}</div>
                  <span :class="['video-task-status', 'is-' + videoTaskState(selectedSb)]">
                    <span :class="['dot', videoTaskState(selectedSb) === 'done' && 'ok', videoTaskState(selectedSb) === 'pending' && 'pending']" />
                    {{ videoTaskStatusLabel(selectedSb) }}
                  </span>
                  <span v-if="selectedSb.duration" class="video-player-sub">{{ selectedSb.duration }}s</span>
                </div>
                <button
                  v-if="previewVideoUrl && !playerIsRemote"
                  class="btn btn-sm btn-primary"
                  @click="setAsMainVideo"
                >
                  {{ t('episode.vid.setMain') }}
                </button>
                <a
                  v-if="playerVideoUrl"
                  :href="playerVideoUrl"
                  :target="playerIsRemote ? '_blank' : undefined"
                  rel="noopener noreferrer"
                  download
                  class="btn btn-sm"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  {{ t('common.download') }}
                </a>
              </div>
              <div class="video-player-stage">
                <video
                  v-if="playerVideoUrl"
                  :key="playerVideoUrl"
                  :src="playerVideoUrl"
                  :poster="playerIsRemote ? undefined : posterOf(playerVideoUrl) || undefined"
                  @error="playerLoadFailed = true"
                  controls
                  preload="metadata"
                  playsinline
                  class="video-player-video"
                />
                <div v-else class="video-player-empty">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                  <div class="video-player-empty-copy">
                    <div class="video-player-empty-title">{{ videoAwaitingDelivery(selectedSb) ? t('episode.recovery.awaitingDelivery') : videoTaskState(selectedSb) === 'pending' ? t('episode.vid.emptyGenerating') : t('episode.vid.emptyNoVideo') }}</div>
                    <div class="video-player-empty-desc">{{ videoAwaitingDelivery(selectedSb) || canRecoverVideo(selectedSb?.id) ? t('episode.recovery.restoreHint') : videoTaskState(selectedSb) === 'pending' ? t('episode.vid.emptyGeneratingDesc') : t('episode.vid.emptyNoVideoDesc') }}</div>
                  </div>
                  <button
                    v-if="videoTaskState(selectedSb) !== 'pending'"
                    class="btn btn-primary btn-sm video-player-empty-action"
                    @click="genVid(selectedSb)"
                  >
                    {{ videoTaskActionLabel(selectedSb) }}
                  </button>
                </div>
              </div>
              <div v-if="playerIsRemote" class="video-remote-source">
                <span>{{ t('episode.recovery.remotePreview') }}</span>
                <a :href="playerVideoUrl" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">{{ playerVideoUrl }}</a>
                <span v-if="playerLoadFailed">{{ t('episode.recovery.remoteUnavailable') }}</span>
                <button v-if="!previewVideoUrl && canRecoverVideo(selectedSb?.id)" class="btn btn-sm" @click="recoverVideo(selectedSb)">{{ t('episode.recovery.restoreDownload') }}</button>
              </div>
            </aside>

            <div v-if="!isComfyVideoMode && sbVideoHistory.length" class="video-player-history">
              <div class="video-player-history-head">
                <span>{{ t('episode.vid.history') }}</span>
                <span class="video-player-history-count">{{ sbVideoHistory.length }}</span>
              </div>
              <div class="video-player-history-list">
                <div
                  v-for="h in sbVideoHistory"
                  :key="h.id"
                  :class="['video-history-item', { current: isCurrentVideo(h), viewing: !!previewVideoUrl && previewVideoUrl === taskVideoPath(h) }]"
                  role="button"
                  tabindex="0"
                  @click="previewHistoryVideo(h)"
                  @keydown.enter.prevent="previewHistoryVideo(h)"
                >
                  <video :src="videoSourceUrl(taskVideoPath(h))" :poster="posterOf(videoSourceUrl(taskVideoPath(h))) || undefined" preload="none" muted playsinline tabindex="-1" />
                  <span class="video-history-time">{{ formatHistoryTime(taskCreatedAt(h)) }}</span>
                  <span v-if="isCurrentVideo(h)" class="video-history-badge">{{ t('episode.vid.current') }}</span>
                  <button v-else type="button" class="video-history-del" :title="t('episode.vid.deleteRecord')" @click.stop="removeHistoryVideo(h)">×</button>
                </div>
              </div>
            </div>
                <div v-if="!isComfyVideoMode" class="video-inspector-body">
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
                        @click="asset.ready && openImageViewer(assetImageSrc({ imageUrl: asset.imageUrl }), `${asset.name} ${asset.typeLabel}`)"
                      >
                        <img v-if="asset.ready" :src="thumbOf(assetImageSrc({ imageUrl: asset.imageUrl }))" :alt="asset.name" loading="lazy" @error="thumbFallback($event, assetImageSrc({ imageUrl: asset.imageUrl }))" />
                        <span v-else class="video-bound-ref-empty">{{ asset.kind === 'scene' ? t('episode.ref.shortScene') : asset.kind === 'prop' ? t('episode.ref.shortProp') : t('episode.ref.shortChar') }}</span>
                        <small>{{ asset.name }}</small>
                      </button>
                    </div>
                    <div v-else class="video-bound-refs-empty">{{ t('episode.inspector.noBoundRefs') }}</div>
                  </section>
                </div>

                <!-- 分镜时长 + 生成操作常驻底部：不随检查器内容滚动 -->
                <div v-if="!isComfyVideoMode" class="video-inspector-footer">
                  <section class="video-inspector-section video-params-card">
                    <div class="video-param-row">
                      <span class="video-param-name">{{ t('episode.inspector.duration') }}</span>
                      <span class="video-param-control">
                        <input
                          :value="selectedSb.duration || 10"
                          type="number"
                          min="2"
                          max="30"
                          class="input video-duration-input"
                          @change="onVideoDurationChange"
                        />
                        <span class="video-param-unit">{{ t('episode.inspector.durationUnit') }}</span>
                      </span>
                    </div>
                    <div class="video-param-hint">{{ t('episode.inspector.durationHint') }}</div>
                  </section>
                  <div class="video-inspector-effective">
                    {{ t('episode.inspector.effective', { model: effectiveVideoModelLabel || t('episode.vid.defaultModel'), res: episodeResolutionShort, dur: effectiveVideoDuration }) }}
                  </div>
                  <button
                    class="btn btn-primary video-inspector-action"
                    :disabled="videoTaskState(selectedSb) === 'pending'"
                    @click="genVid(selectedSb)"
                  >
                    {{ videoTaskActionLabel(selectedSb) }}
                  </button>
                </div>

              </aside>
              </div>
              <div
                class="video-col-divider is-left"
                role="separator"
                aria-orientation="vertical"
                @pointerdown="startVideoColDrag('left', $event)"
                @dblclick="videoLeftW = VIDEO_COL_DEFAULTS.left"
              ></div>
              <div
                v-if="!isComfyVideoMode"
                class="video-col-divider is-right"
                role="separator"
                aria-orientation="vertical"
                @pointerdown="startVideoColDrag('right', $event)"
                @dblclick="videoRightW = VIDEO_COL_DEFAULTS.right"
              ></div>
            </div>
          </div>

          <!-- Sub: Director Stage（并列第二种导演方式，不改现有分镜与视频页签） -->
          <div v-if="prodTab === 'director'" class="director-pane">
            <DirectorTab
              :episode-id="episode?.id || 0"
              :characters="chars"
              :scenes="scenes"
              :initial-view="directorInitialView"
              :focus-storyboard-id="focusStoryboardId"
              @open-videos="prodTab = 'videos'"
              @back-to-drama="navigateTo(`/drama/${dramaId}`)"
            />
          </div>

          <!-- Production Navigator -->
        </template>
      </div>

      <!-- ===== DUBBING PANEL ===== -->
      <div v-else-if="panel === 'dubbing'" class="content-panel">
        <DubbingStage
          :episode-id="episode?.id || null"
          :drama-id="dramaId"
          :step="dubStep"
          :episode-number="episode?.episode_number || episodeNumber"
          :drama-aspect="dramaAspectRatio"
          :focus-track-id="focusTrackId || null"
          :focus-export-id="focusExportId || null"
          :focus-line-id="focusLineId || null"
          @update:step="dubStep = $event"
          @open-preview="dubOpen = true"
          @open-settings="goDubbingSettings"
          @go-stage="goMainStage"
          @summary="onDubSummary"
        />
      </div>

      <!-- ===== EXPORT PANEL ===== -->
      <div v-else class="content-panel">
        <div v-if="!sbs.length" class="step-empty" style="flex:1">
          <div class="empty-visual">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </div>
          <div class="empty-title">{{ t('episode.prod.notReady') }}</div>
          <div class="empty-desc">{{ t('episode.export.notReadyDesc') }}</div>
          <button class="btn btn-primary" @click="panel = 'script'">{{ t('episode.export.gotoScript') }}</button>
        </div>
        <div v-else class="export-split">
          <div class="export-main">
            <!-- 上方:成片列表 -->
            <div class="export-section">
              <div class="export-section-head">
                <span class="export-section-title">{{ t('episode.export.filmList') }}</span>
                <span class="dim" style="font-size:11px">{{ t('episode.export.countN', { n: exportMerges.length }) }}</span>
                <button
                  :class="['btn btn-sm ml-auto export-done-btn', { on: exportDone }]"
                  :title="t('episode.export.markDoneTitle')"
                  @click="toggleExportDone"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  {{ exportDone ? t('episode.export.markedDone') : t('episode.export.markDone') }}
                </button>
                <button class="btn btn-sm" @click="loadExportMerges">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                  {{ t('common.refresh') }}
                </button>
              </div>
              <div v-if="exportMerges.length" class="export-merge-strip">
                <div
                  v-for="m in exportMerges"
                  :key="m.id"
                  :class="['merge-card', m.status === 'completed' && m.merged_url && 'playable']"
                  :role="m.status === 'completed' && m.merged_url ? 'button' : undefined"
                  :tabindex="m.status === 'completed' && m.merged_url ? 0 : undefined"
                  @click="m.status === 'completed' && m.merged_url && (activeMerge = m)"
                  @keydown.enter.prevent="m.status === 'completed' && m.merged_url && (activeMerge = m)"
                >
                  <div class="merge-card-thumb">
                    <video
                      v-if="m.status === 'completed' && m.merged_url"
                      :src="'/' + m.merged_url"
                      :poster="posterOf('/' + m.merged_url) || undefined"
                      preload="none"
                      muted
                      playsinline
                      tabindex="-1"
                    />
                    <div v-else :class="['merge-card-pending', m.status === 'failed' && 'is-failed']" :title="m.status === 'failed' ? m.error_msg : null">
                      {{ m.status === 'failed' ? mapError(m.error_msg, { fallback: 'episode.export.mergeFailed' }) : t('episode.export.merging') }}
                    </div>
                    <span v-if="m.status === 'completed' && m.merged_url" class="merge-card-play">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                    </span>
                  </div>
                  <div class="merge-card-title" :title="m.title || t('episode.export.untitled')">{{ m.title || t('episode.export.untitled') }}</div>
                  <div class="merge-card-meta">
                    <span class="mono">{{ formatHistoryTime(m.created_at) }}</span>
                    <span v-if="m.duration">· {{ m.duration }}s</span>
                  </div>
                  <div class="merge-card-actions">
                    <a
                      v-if="m.status === 'completed' && m.merged_url"
                      :href="'/' + m.merged_url"
                      :download="mergeDownloadName(m)"
                      class="btn btn-sm"
                      @click.stop
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      {{ t('common.download') }}
                    </a>
                    <button
                      v-if="m.status === 'completed' && m.merged_url"
                      class="btn btn-sm"
                      :title="t('films.setCurrent')"
                      @click.stop="setFilmCurrent(m.id)"
                    >{{ t('films.setCurrent') }}</button>
                    <button
                      v-if="m.status === 'completed' && m.merged_url"
                      class="btn btn-sm"
                      :title="t('films.openMix')"
                      @click.stop="openFilmInMix(m.id)"
                    >{{ t('films.openMix') }}</button>
                    <button
                      v-if="m.status === 'completed' && m.merged_url"
                      class="btn btn-sm"
                      :title="t('films.openEdit')"
                      @click.stop="openFilmInEdit(m.id)"
                    >{{ t('films.openEdit') }}</button>
                    <button
                      class="btn btn-sm btn-ghost merge-card-del"
                      :title="t('episode.export.delete')"
                      @click.stop="deleteMerge(m)"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                  </div>
                </div>
              </div>
              <div v-else class="export-merge-empty">{{ t('episode.export.empty') }}</div>
            </div>

            <!-- 下方:镜头素材(可勾选) -->
            <div class="export-section export-section-grow">
              <div class="export-section-head">
                <span class="export-section-title">{{ t('episode.export.shotAssets') }}</span>
                <span class="dim" style="font-size:11px">{{ t('episode.export.shotStat', { done: shotVidCount, total: sbs.length, selected: exportSelectedReadyIds.length }) }}</span>
                <div v-if="exportSelectedReadyIds.length >= 2" :class="['ai-transition-chip', { busy: transitionBusy, unsupported: !transitionSupported }]">
                  <span class="ai-transition-chip-label">
                    {{ t('episode.export.aiTransition.summary', { ready: transitionSummary.ready, total: transitionSummary.total }) }}
                  </span>
                  <span v-if="transitionBusy" class="ai-transition-chip-state">
                    <Loader2 :size="10" class="animate-spin" />
                    {{ t('episode.export.aiTransition.status.processing') }}
                  </span>
                  <button
                    class="btn btn-sm"
                    :disabled="!transitionSupported || transitionPreparing || transitionBusy"
                    :title="transitionSupported ? null : t('episode.export.aiTransition.unsupported')"
                    @click="generateMissingTransitions"
                  >
                    <Loader2 v-if="transitionPreparing" :size="11" class="animate-spin" />
                    {{ transitionPreparing ? t('episode.export.aiTransition.preparing') : t('episode.export.aiTransition.generate') }}
                  </button>
                </div>
                <div class="ml-auto flex gap-1">
                  <button class="btn btn-sm" :disabled="!exportReadyIds.length" @click="toggleSelectAllExport">
                    {{ exportSelectedReadyIds.length === exportReadyIds.length && exportReadyIds.length ? t('episode.export.clearSelection') : t('episode.export.selectAllReady') }}
                  </button>
                  <button
                    class="btn btn-sm btn-primary"
                    :disabled="!exportSelectedReadyIds.length"
                    @click="openMergeDialog"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                    {{ t('episode.export.mergeSelected', { n: exportSelectedReadyIds.length }) }}
                  </button>
                </div>
              </div>
              <div class="export-grid">
                <div
                  v-for="(sb, i) in sbs"
                  :key="sb.id"
                  :class="['exp-card', { selected: isExportSelected(sb.id), playable: hasVid(sb) }]"
                  :role="hasVid(sb) ? 'button' : undefined"
                  :tabindex="hasVid(sb) ? 0 : undefined"
                  @click="toggleExportSelect(sb)"
                  @keydown.enter.prevent="toggleExportSelect(sb)"
                >
                  <div class="exp-thumb">
                    <video
                      v-if="hasVid(sb)"
                      :src="'/' + getVideoUrl(sb)"
                      :poster="posterOf('/' + getVideoUrl(sb)) || undefined"
                      preload="none"
                      muted
                      playsinline
                      tabindex="-1"
                    />
                    <div v-else class="exp-thumb-empty">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                    </div>
                    <span class="exp-thumb-index">#{{ String(i+1).padStart(2,'0') }}</span>
                    <span v-if="sb.duration" class="exp-thumb-duration">{{ sb.duration }}s</span>
                    <span
                      v-if="hasVid(sb)"
                      class="exp-play"
                      :title="t('episode.export.previewShot')"
                      @click.stop="previewShot = sb"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                    </span>
                    <span v-if="hasVid(sb)" :class="['exp-check', isExportSelected(sb.id) && 'on']">
                      <svg v-if="isExportSelected(sb.id)" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </span>
                  </div>
                  <div class="exp-row-line">
                    <span class="truncate" style="flex:1;font-size:11px">{{ sb.description || sb.title || '—' }}</span>
                    <span :class="['dot', hasVid(sb) && 'ok']" />
                  </div>
                </div>
              </div>
            </div>

            <!-- 镜头素材下方:已生成的过渡镜头 -->
            <div class="export-section">
              <div class="export-section-head">
                <span class="export-section-title">{{ t('episode.export.aiTransition.cardsTitle') }}</span>
                <span class="dim" style="font-size:11px">{{ t('episode.export.aiTransition.cardsStat', { n: transitionCards.length }) }}</span>
                <span v-if="transitionCards.length" class="dim ml-auto" style="font-size:11px">{{ t('episode.export.aiTransition.cardHint') }}</span>
              </div>
              <div v-if="transitionCards.length" class="ai-transition-cards">
                <button
                  v-for="b in transitionCards"
                  :key="b.id"
                  type="button"
                  class="ai-transition-card"
                  @click="openTransitionDetail(b)"
                >
                  <div class="ai-transition-card-thumb">
                    <img
                      v-if="b.first_frame_url"
                      :src="'/' + b.first_frame_url"
                      :alt="transitionPairLabel(b)"
                      loading="lazy"
                    />
                    <div v-else class="ai-transition-card-empty">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                    </div>
                    <span :class="['ai-transition-status', transitionStatusClass(b)]">{{ transitionStatusLabel(b) }}</span>
                    <span v-if="b.status === 'completed' && !b.stale && b.video_url" class="ai-transition-card-play">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                    </span>
                  </div>
                  <div class="ai-transition-card-line">
                    <span class="truncate">{{ transitionPairLabel(b) }}</span>
                    <span v-if="transitionDurationLabel(b)" class="dim">{{ transitionDurationLabel(b) }}</span>
                  </div>
                </button>
              </div>
              <div v-else class="export-merge-empty">{{ t('episode.export.aiTransition.cardsEmpty') }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== TASK DRAWER ===== -->
      <div v-if="taskDrawer" class="task-drawer-overlay" @click.self="closeTaskDrawer">
        <aside class="task-drawer" role="dialog" aria-modal="true" :aria-label="t('episode.tasks.title')">
          <header class="task-drawer-head">
            <div>
              <div class="video-task-title">{{ t('episode.tasks.title') }}</div>
              <div class="video-task-meta">{{ t('episode.tasks.meta', { n: genTaskRows.length }) }}</div>
            </div>
            <div class="task-drawer-head-actions">
              <button class="btn btn-sm" :disabled="!genTaskClearableCount || clearTasks.loading" @click="clearTasks.open = true">
                <Trash2 :size="12" />
                {{ t('episode.tasks.clear') }}
              </button>
              <button class="btn btn-sm" @click="loadGenTasks">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                {{ t('common.refresh') }}
              </button>
              <button class="btn btn-ghost btn-icon" :title="t('common.close')" :aria-label="t('common.close')" @click="closeTaskDrawer"><X :size="14" /></button>
            </div>
          </header>
          <div class="video-task-metrics task-drawer-metrics">
            <span class="video-task-metric is-pending">{{ t('episode.vid.metricPending', { n: genTaskActiveCount }) }}</span>
            <span class="video-task-metric is-done">{{ t('episode.vid.metricDone', { n: genTaskDoneCount }) }}</span>
            <span class="video-task-metric is-failed">{{ t('episode.vid.metricFailed', { n: genTaskFailedCount }) }}</span>
          </div>
          <div v-if="!genTaskRows.length" class="step-empty task-drawer-empty">
            <div class="empty-visual">
              <ListTodo :size="32" />
            </div>
            <div class="empty-title">{{ t('episode.tasks.emptyTitle') }}</div>
            <div class="empty-desc">{{ t('episode.tasks.emptyDesc') }}</div>
          </div>
          <div v-else class="video-task-table task-drawer-body">
            <div
              v-for="row in genTaskRows"
              :key="row.key"
              :class="['video-task-row', 'gen-task-row', 'is-' + genTaskStateClass(row.status)]"
            >
              <div class="video-task-preview">
                <video
                  v-if="row.previewUrl && (row.kind === 'video' || row.kind === 'merge')"
                  :src="genTaskPreviewSrc(row.previewUrl)"
                  :poster="posterOf(genTaskPreviewSrc(row.previewUrl)) || undefined"
                  controls
                  preload="none"
                  playsinline
                />
                <img
                  v-else-if="row.previewUrl"
                  :src="thumbOf(genTaskPreviewSrc(row.previewUrl))"
                  :alt="row.targetLabel"
                  loading="lazy"
                  @error="thumbFallback($event, genTaskPreviewSrc(row.previewUrl))"
                  @click="openImageViewer(genTaskPreviewSrc(row.previewUrl), row.targetLabel)"
                />
                <div v-else class="video-task-empty">
                  <Loader2 v-if="genTaskStateClass(row.status) === 'pending'" :size="18" class="animate-spin" />
                  <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                </div>
                <span class="video-task-index">{{ genTaskKindLabel(row.kind, row.transitionId) }}</span>
              </div>
              <div class="video-task-main">
                <div class="video-task-line">
                  <strong class="video-task-name truncate">{{ row.targetLabel }}</strong>
                </div>
                <div class="video-task-meta-line">
                  <span class="video-task-loc truncate">{{ row.provider }}{{ row.model ? ' · ' + row.model : '' }}</span>
                  <template v-if="genTaskDuration(row)">
                    <span class="video-task-sep">·</span>
                    <span>{{ t('episode.tasks.duration', { dur: genTaskDuration(row) }) }}</span>
                  </template>
                  <span class="video-task-sep">·</span>
                  <span>#{{ row.id }}</span>
                </div>
                <div v-if="row.errorMsg" class="video-task-error" :title="row.errorMsg">
                  {{ mapError(row.errorMsg) }}
                  <div v-if="row.kind === 'video'" class="flex gap-2">
                    <button v-if="row.recoverable" class="btn btn-sm" @click.stop="recoverTask(row.id, row.storyboardId)">{{ t('episode.recovery.restore') }}</button>
                    <button class="btn btn-sm" @click.stop="copyTaskDiagnostics(row.id)">{{ t('episode.recovery.diagnostics') }}</button>
                  </div>
                  <div v-if="row.kind === 'video' && videoModerationHint(row.errorMsg)" class="video-task-error-hint">{{ videoModerationHint(row.errorMsg) }}</div>
                </div>
              </div>
              <span :class="['video-task-status', 'is-' + genTaskStateClass(row.status)]">
                <span :class="['dot', genTaskStateClass(row.status) === 'done' && 'ok', genTaskStateClass(row.status) === 'pending' && 'pending']" />
                {{ genTaskStatusLabel(row.status) }}
              </span>
            </div>
          </div>
        </aside>
      </div>

      <div v-if="assetDetail.open && assetDetailItem" class="overlay asset-detail-overlay" @click.self="closeAssetDetail">
        <section
          class="dialog asset-detail-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="asset-detail-title"
        >
          <header class="dialog-head asset-detail-head">
            <div class="asset-detail-title-block">
              <span class="asset-detail-kicker">{{ assetTypeLabel(assetDetail.type) }}</span>
              <h2 id="asset-detail-title" class="asset-detail-title">{{ assetDetailTitle(assetDetail.type, assetDetailItem) }}</h2>
            </div>
            <div class="asset-detail-head-actions">
              <span class="tag" v-if="assetDetail.type === 'character'">{{ assetDetailItem.role || t('common.role') }}</span>
              <span class="tag" v-else-if="assetDetail.type === 'prop'">{{ assetDetailItem.type || t('common.prop') }}</span>
              <span class="tag" v-else>{{ assetDetailItem.time || t('episode.asset.noTime') }}</span>
              <button
                type="button"
                class="btn btn-ghost btn-icon"
                :title="t('common.close')"
                :aria-label="t('common.close')"
                @click="closeAssetDetail"
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          </header>

          <div class="dialog-body asset-detail-body">
            <div class="asset-detail-shell">
              <aside class="asset-detail-preview-panel">
                <div class="asset-detail-section-title">
                  <span>{{ t('episode.asset.visualPreview') }}</span>
                  <span :class="['asset-detail-state', assetImageSrc(assetDetailItem) ? 'is-ready' : '']">
                    {{ assetImageSrc(assetDetailItem) ? t('episode.asset.ready') : t('episode.asset.todo') }}
                  </span>
                </div>

                <button
                  type="button"
                  class="asset-detail-media-frame"
                  :disabled="!assetImageSrc(assetDetailItem)"
                  :aria-label="t('episode.asset.visualPreview')"
                  @click.stop="openImageViewer(assetImageSrc(assetDetailItem), assetDetailImageTitle(assetDetail.type, assetDetailItem))"
                >
                  <img
                    v-if="assetImageSrc(assetDetailItem)"
                    :src="thumbOf(assetImageSrc(assetDetailItem))"
                    class="previewable-image"
                    @error="thumbFallback($event, assetImageSrc(assetDetailItem))"
                  />
                  <span v-else class="asset-detail-media-empty">
                    <svg v-if="assetDetail.type === 'character'" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    <svg v-else-if="assetDetail.type === 'prop'" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                    <svg v-else width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  </span>
                </button>

                <div class="asset-detail-meta-row">
                  <div class="asset-detail-meta-item">
                    <span>{{ t('episode.asset.kindLabel') }}</span>
                    <strong>{{ assetDetail.type === 'character' ? t('episode.asset.charPortrait') : assetDetail.type === 'prop' ? t('common.prop') : t('episode.asset.sceneImage') }}</strong>
                  </div>
                  <div class="asset-detail-meta-item">
                    <span>{{ assetDetail.type === 'character' ? t('episode.asset.roleLabel') : assetDetail.type === 'prop' ? t('episode.asset.propTypeLabel') : t('episode.asset.timeLabel') }}</span>
                    <strong>{{ assetDetail.type === 'character' ? (assetDetailItem.role || t('common.role')) : assetDetail.type === 'prop' ? (assetDetailItem.type || t('common.prop')) : (assetDetailItem.time || t('episode.asset.noTime')) }}</strong>
                  </div>
                </div>

                <div class="asset-ref-block">
                  <div class="asset-detail-section-title">
                    <span>{{ t('episode.asset.refTitle') }}</span>
                    <span class="dim">{{ assetDetailRefs.length }}/{{ MAX_ASSET_REFS }}</span>
                  </div>
                  <div class="asset-ref-list">
                    <div v-for="(ref, index) in assetDetailRefs" :key="`${ref}-${index}`" class="asset-ref-item">
                      <img
                        :src="thumbOf(assetRefSrc(ref))"
                        :alt="t('episode.asset.refTitle')"
                        class="previewable-image"
                        @error="thumbFallback($event, assetRefSrc(ref))"
                        @click.stop="openImageViewer(assetRefSrc(ref), t('episode.asset.refTitle'))"
                      />
                      <button
                        type="button"
                        class="asset-ref-remove"
                        :title="t('common.delete')"
                        :aria-label="t('common.delete')"
                        @click.stop="removeAssetReference(assetDetail.type, assetDetailItem, index)"
                      >
                        <svg aria-hidden="true" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>
                    <button
                      v-if="assetDetailRefs.length < MAX_ASSET_REFS"
                      type="button"
                      class="asset-ref-add"
                      :disabled="isUploadingAssetRef(assetDetail.type, assetDetailItem.id)"
                      :title="t('episode.asset.refAdd')"
                      :aria-label="t('episode.asset.refAdd')"
                      @click.stop="addAssetReferences(assetDetail.type, assetDetailItem)"
                    >
                      <span v-if="isUploadingAssetRef(assetDetail.type, assetDetailItem.id)" class="asset-ref-spinner" />
                      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    </button>
                  </div>
                  <p v-if="assetDetailRefs.length" class="asset-ref-hint">{{ t('episode.asset.refHint') }}</p>
                  <p v-else class="asset-ref-hint">{{ t('episode.asset.refEmpty') }}</p>
                </div>
              </aside>

              <section class="asset-detail-editor-panel">
                <div class="asset-detail-section-title">
                  <span>{{ t('episode.asset.editInfo') }}</span>
                  <span class="dim">{{ assetDetail.type === 'character' ? t('episode.asset.editHintChar') : assetDetail.type === 'prop' ? t('episode.asset.editHintProp') : t('episode.asset.editHintScene') }}</span>
                </div>

                <div v-if="assetDetail.type === 'prop'" class="asset-detail-edit-grid asset-detail-edit-grid--prop">
                  <label class="asset-detail-edit-field">
                    <span>{{ t('episode.asset.appearanceOfObject') }}</span>
                    <textarea
                      v-model="assetDetailDraft.description"
                      class="textarea asset-detail-textarea"
                      rows="6"
                      :placeholder="t('episode.asset.appearancePlaceholder')"
                    />
                  </label>
                </div>

                <div v-else :class="['asset-detail-edit-grid', `asset-detail-edit-grid--${assetDetail.type}`]">
                  <label v-if="assetDetail.type === 'character'" class="asset-detail-edit-field">
                    <span>{{ t('episode.asset.appearanceField') }}</span>
                    <textarea
                      v-model="assetDetailDraft.appearance"
                      class="textarea asset-detail-textarea"
                      rows="6"
                      :placeholder="t('episode.asset.appearanceFieldPlaceholder')"
                    />
                  </label>
                  <label v-if="assetDetail.type === 'character'" class="asset-detail-edit-field">
                    <span>{{ t('episode.asset.stylingField') }}</span>
                    <textarea
                      v-model="assetDetailDraft.styling"
                      class="textarea asset-detail-textarea"
                      rows="6"
                      :placeholder="t('episode.asset.stylingFieldPlaceholder')"
                    />
                  </label>
                  <label v-if="assetDetail.type === 'scene'" class="asset-detail-edit-field">
                    <span>{{ t('episode.asset.sceneDescField') }}</span>
                    <textarea
                      v-model="assetDetailDraft.prompt"
                      class="textarea asset-detail-textarea"
                      rows="5"
                      :placeholder="t('episode.asset.sceneDescPlaceholder')"
                    />
                  </label>
                  <label v-if="assetDetail.type === 'scene'" class="asset-detail-edit-field">
                    <span>{{ t('episode.asset.sceneLightField') }}</span>
                    <textarea
                      v-model="assetDetailDraft.lighting"
                      class="textarea asset-detail-textarea"
                      rows="5"
                      :placeholder="t('episode.asset.sceneLightPlaceholder')"
                    />
                  </label>
                </div>

              </section>
            </div>

            <div v-if="assetDetail.type === 'character' && assetDetailItem" class="asset-detail-voice-row">
              <div class="asset-detail-section-title">
                <span>{{ t('episode.voice.title') }}</span>
                <span class="dim">{{ t('episode.voice.desc') }}</span>
              </div>
              <VoiceProfileCard
                :key="`voice-card-${assetDetailItem.id}`"
                scope="character"
                :drama-id="dramaId"
                :episode-id="epId"
                :character-id="assetDetailItem.id"
                :name="assetDetailItem.name"
                :character="assetDetailItem"
                reference-audio
                :video-ref-url="assetDetailItem.voice_audio_url || assetDetailItem.voiceAudioUrl || ''"
                @reference-updated="updateCharacterVoice"
              />
            </div>

            <section class="asset-detail-prompt-panel">
              <div class="asset-detail-section-title">
                <span>{{ assetDetail.type === 'character' ? t('episode.asset.finalPromptTurnaround') : assetDetail.type === 'scene' ? t('episode.asset.finalPromptFixed') : t('episode.asset.finalPromptWhiteBg') }}</span>
                <div class="asset-detail-prompt-head-actions">
                  <button
                    class="btn btn-sm"
                    :disabled="isGeneratingPrompt(assetDetail.type, assetDetailItem.id) || isAssetImagePending(assetDetail.type, assetDetailItem.id)"
                    @click="genAssetFinalPrompt"
                  >
                    <Loader2 v-if="isGeneratingPrompt(assetDetail.type, assetDetailItem.id)" :size="11" class="animate-spin" />
                    {{ isGeneratingPrompt(assetDetail.type, assetDetailItem.id) ? t('episode.asset.generating') : (assetFinalPrompt ? t('episode.asset.regenPrompt') : t('episode.asset.genPrompt')) }}
                  </button>
                  <span :class="['asset-detail-state', assetFinalPrompt && 'is-ready']">
                    {{ assetFinalPrompt ? t('episode.asset.ready') : t('episode.asset.todo') }}
                  </span>
                  <button
                    v-if="assetPromptDraft"
                    class="btn btn-ghost btn-sm asset-detail-copy-btn"
                    @click="copyAssetFinalPrompt"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    {{ t('common.copy') }}
                  </button>
                </div>
              </div>
              <textarea
                :value="assetPromptDraft"
                @input="onAssetPromptInput"
                class="textarea asset-detail-prompt-textarea"
                rows="5"
                :placeholder="assetDetail.type === 'character'
                  ? t('episode.asset.promptPlaceholderChar')
                  : assetDetail.type === 'scene'
                    ? t('episode.asset.promptPlaceholderScene')
                    : t('episode.asset.promptPlaceholderProp')"
              />
              <p class="asset-detail-prompt-hint">
                {{ assetDetail.type === 'character'
                  ? t('episode.asset.promptHintChar')
                  : assetDetail.type === 'scene'
                    ? t('episode.asset.promptHintScene')
                    : t('episode.asset.promptHintProp') }}
              </p>
            </section>
          </div>

          <footer class="dialog-foot asset-detail-foot">
            <div class="asset-detail-secondary-actions">
              <button type="button" class="btn btn-danger" @click="askDeleteAsset(assetDetail.type, assetDetailItem)">{{ t('common.delete') }}</button>
              <button type="button" class="btn" @click="closeAssetDetail">{{ t('common.close') }}</button>
            </div>
            <div class="asset-detail-primary-actions">
              <button
                type="button"
                class="btn"
                :disabled="isUploadingAsset(assetDetail.type, assetDetailItem.id)"
                :title="isUploadingAsset(assetDetail.type, assetDetailItem.id) ? t('episode.asset.uploadingImage') : null"
                @click="uploadAssetImage(assetDetail.type, assetDetailItem.id)"
              >
                <Loader2 v-if="isUploadingAsset(assetDetail.type, assetDetailItem.id)" :size="11" class="animate-spin" />
                <svg v-else aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                {{ isUploadingAsset(assetDetail.type, assetDetailItem.id) ? t('episode.asset.uploadingImage') : t('episode.asset.uploadImage') }}
              </button>
              <button
                v-if="assetDetail.type === 'character'"
                type="button"
                class="btn"
                :disabled="isPendingCharImage(assetDetailItem.id)"
                :title="isPendingCharImage(assetDetailItem.id) ? t('episode.asset.generating') : null"
                @click="genCharImg(assetDetailItem.id)"
              >
                {{ assetImageSrc(assetDetailItem) ? t('episode.asset.regenPortrait') : (isPendingCharImage(assetDetailItem.id) ? t('episode.asset.generating') : t('episode.asset.genPortrait')) }}
              </button>
              <button
                v-else-if="assetDetail.type === 'scene'"
                type="button"
                class="btn"
                :disabled="isPendingSceneImage(assetDetailItem.id)"
                :title="isPendingSceneImage(assetDetailItem.id) ? t('episode.asset.generating') : null"
                @click="genSceneImg(assetDetailItem.id)"
              >
                {{ assetImageSrc(assetDetailItem) ? t('episode.asset.regenScene') : (isPendingSceneImage(assetDetailItem.id) ? t('episode.asset.generating') : t('episode.asset.genScene')) }}
              </button>
              <button
                v-else-if="assetDetail.type === 'prop'"
                type="button"
                class="btn"
                :disabled="isPendingPropImage(assetDetailItem.id)"
                :title="isPendingPropImage(assetDetailItem.id) ? t('episode.asset.generating') : null"
                @click="genPropImg(assetDetailItem.id)"
              >
                {{ assetImageSrc(assetDetailItem) ? t('episode.asset.regenProp') : (isPendingPropImage(assetDetailItem.id) ? t('episode.asset.generating') : t('episode.asset.genProp')) }}
              </button>
              <button
                type="button"
                class="btn btn-primary"
                :disabled="savingAssetDetail"
                :title="savingAssetDetail ? t('episode.asset.savingChanges') : null"
                @click="saveAssetDetail"
              >
                <Loader2 v-if="savingAssetDetail" :size="12" class="animate-spin" />
                {{ savingAssetDetail ? t('episode.asset.savingChanges') : t('episode.asset.saveChanges') }}
              </button>
            </div>
          </footer>
        </section>
      </div>

      <div v-if="imageViewer.open && imageViewer.src" class="overlay image-viewer-overlay" @click.self="closeImageViewer">
        <div class="dialog image-viewer-dialog">
          <div class="image-viewer-head">
            <div class="image-viewer-title">{{ imageViewer.title || t('episode.viewer.imagePreview') }}</div>
            <button class="btn btn-ghost btn-icon" :title="t('common.close')" :aria-label="t('common.close')" @click="closeImageViewer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="image-viewer-body">
            <img :src="imageViewer.src" :alt="imageViewer.title || t('episode.viewer.imagePreview')" class="image-viewer-img" />
          </div>
        </div>
      </div>

      <div v-if="previewShot" class="overlay image-viewer-overlay" @click.self="previewShot = null">
        <div class="dialog image-viewer-dialog merge-viewer-dialog">
          <div class="image-viewer-head">
            <div class="image-viewer-title">{{ previewShot.previewLabel || t('episode.export.shotPreview', { n: shotNumberOf(previewShot) }) }}</div>
            <span v-if="previewShot.duration" class="dim" style="font-size:11px">{{ Number(previewShot.duration).toFixed(2).replace(/\.00$/, '') }}s</span>
            <a :href="'/' + getVideoUrl(previewShot)" :download="previewShot.downloadName || ''" class="btn btn-sm" style="margin-left:auto">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {{ t('common.download') }}
            </a>
            <button class="btn btn-ghost btn-icon" :title="t('common.close')" :aria-label="t('common.close')" @click="previewShot = null">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="merge-viewer-body">
            <video
              :key="previewShot.id"
              :src="'/' + getVideoUrl(previewShot)"
              controls
              autoplay
              playsinline
              class="merge-viewer-video"
            />
          </div>
        </div>
      </div>

      <div v-if="transitionDetailBoundary" class="overlay" @click.self="closeTransitionDetail">
        <div
          class="dialog transition-detail-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="transition-detail-title"
        >
          <header class="dialog-head">
            <div id="transition-detail-title" class="image-viewer-title">{{ t('episode.export.aiTransition.detailTitle') }}</div>
            <span :class="['ai-transition-status', transitionStatusClass(transitionDetailBoundary)]">
              {{ transitionStatusLabel(transitionDetailBoundary) }}
            </span>
            <span class="dim transition-detail-meta">{{ transitionPairLabel(transitionDetailBoundary) }}</span>
            <span v-if="transitionDurationLabel(transitionDetailBoundary)" class="dim transition-detail-meta">
              {{ transitionDurationLabel(transitionDetailBoundary) }}
            </span>
            <button
              type="button"
              class="btn btn-ghost btn-icon"
              style="margin-left:auto"
              :title="t('common.close')"
              :aria-label="t('common.close')"
              @click="closeTransitionDetail"
            >
              <X :size="14" aria-hidden="true" />
            </button>
          </header>
          <div class="dialog-body transition-detail-body">
            <div v-if="transitionDetailBoundary.video_url" class="transition-detail-video">
              <video
                :key="transitionDetailBoundary.video_url"
                :src="'/' + transitionDetailBoundary.video_url"
                :poster="posterOf('/' + transitionDetailBoundary.video_url) || undefined"
                controls
                playsinline
              />
            </div>
            <div v-else-if="transitionDetailBoundary.error_msg" class="transition-detail-error">
              {{ mapError(transitionDetailBoundary.error_msg) }}
            </div>
            <div v-if="transitionDetailBoundary.first_frame_url || transitionDetailBoundary.last_frame_url" class="transition-detail-frames">
              <button
                v-if="transitionDetailBoundary.first_frame_url"
                type="button"
                class="transition-detail-frame"
                @click="openImageViewer('/' + transitionDetailBoundary.first_frame_url, t('episode.export.aiTransition.firstFrame'))"
              >
                <img :src="'/' + transitionDetailBoundary.first_frame_url" :alt="t('episode.export.aiTransition.firstFrame')" loading="lazy" />
                <span>{{ t('episode.export.aiTransition.firstFrame') }}</span>
              </button>
              <button
                v-if="transitionDetailBoundary.last_frame_url"
                type="button"
                class="transition-detail-frame"
                @click="openImageViewer('/' + transitionDetailBoundary.last_frame_url, t('episode.export.aiTransition.lastFrame'))"
              >
                <img :src="'/' + transitionDetailBoundary.last_frame_url" :alt="t('episode.export.aiTransition.lastFrame')" loading="lazy" />
                <span>{{ t('episode.export.aiTransition.lastFrame') }}</span>
              </button>
            </div>
            <p v-if="transitionDetailBoundary.first_frame_url || transitionDetailBoundary.last_frame_url" class="ai-transition-prompt-note">
              {{ t('episode.export.aiTransition.framesHint') }}
            </p>
            <div class="ai-transition-prompt transition-detail-prompt">
              <div class="ai-transition-prompt-head">
                <span :class="['ai-transition-prompt-source', transitionPromptSourceClass(transitionDetailBoundary)]">
                  {{ transitionPromptSourceLabel(transitionDetailBoundary) }}
                </span>
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  :disabled="transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)]"
                  :title="transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)] ? t('episode.export.aiTransition.processingHint') : null"
                  @click="analyzeTransitionItem(transitionDetailBoundary)"
                >
                  {{ transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)]
                    ? t('episode.export.aiTransition.prompt.analyzing')
                    : t('episode.export.aiTransition.prompt.analyze') }}
                </button>
              </div>
              <textarea
                v-model="transitionPromptDrafts[transitionPromptKey(transitionDetailBoundary)]"
                class="input ai-transition-prompt-input"
                rows="4"
                maxlength="1200"
                :disabled="transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)]"
                :aria-label="t('episode.export.aiTransition.prompt.label')"
                :placeholder="t('episode.export.aiTransition.prompt.placeholder')"
                @input="markTransitionPromptDirty(transitionDetailBoundary)"
              />
              <div class="ai-transition-prompt-actions">
                <button
                  type="button"
                  class="btn btn-sm"
                  :disabled="transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)]"
                  :title="transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)] ? t('episode.export.aiTransition.busyHint') : null"
                  @click="saveTransitionPromptItem(transitionDetailBoundary)"
                >
                  {{ t('episode.export.aiTransition.prompt.save') }}
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-primary"
                  :disabled="transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)]
                    || transitionDetailBoundary.status === 'processing' || transitionDetailBoundary.status === 'pending'"
                  :title="transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)]
                    || transitionDetailBoundary.status === 'processing' || transitionDetailBoundary.status === 'pending'
                    ? t('episode.export.aiTransition.busyHint') : null"
                  @click="regenerateTransitionWithPrompt(transitionDetailBoundary)"
                >
                  {{ t('episode.export.aiTransition.prompt.regenerate') }}
                </button>
              </div>
              <p
                v-if="transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)]
                  || transitionDetailBoundary.status === 'processing' || transitionDetailBoundary.status === 'pending'"
                class="dialog-hint"
              >
                {{ t('episode.export.aiTransition.busyHint') }}
              </p>
              <p v-if="transitionPromptEffectiveSource(transitionDetailBoundary) === 'fallback'" class="ai-transition-prompt-note">
                {{ t('episode.export.aiTransition.prompt.fallbackNote') }}
              </p>
              <p class="ai-transition-prompt-note">{{ t('episode.export.aiTransition.prompt.hint') }}</p>
            </div>
          </div>
          <footer class="dialog-foot">
            <button
              type="button"
              class="btn btn-ghost transition-detail-delete"
              :disabled="transitionDetailBoundary.status === 'processing' || transitionDetailBoundary.status === 'pending'"
              :title="transitionDetailBoundary.status === 'processing' || transitionDetailBoundary.status === 'pending' ? t('episode.export.aiTransition.processingHint') : null"
              @click="askDeleteTransition(transitionDetailBoundary)"
            >
              <Trash2 :size="12" aria-hidden="true" />
              {{ t('episode.export.aiTransition.delete') }}
            </button>
            <span
              v-if="transitionDetailBoundary.status === 'processing' || transitionDetailBoundary.status === 'pending'"
              class="dialog-hint transition-detail-hint"
            >
              {{ t('episode.export.aiTransition.processingHint') }}
            </span>
            <button type="button" class="btn" style="margin-left:auto" @click="closeTransitionDetail">{{ t('common.close') }}</button>
          </footer>
        </div>
      </div>

      <div v-if="activeMerge" class="overlay image-viewer-overlay" @click.self="activeMerge = null">
        <div class="dialog image-viewer-dialog merge-viewer-dialog">
          <div class="image-viewer-head">
            <div class="image-viewer-title">{{ activeMerge.title || t('episode.viewer.filmPreview') }}</div>
            <span class="dim" style="font-size:11px">{{ formatHistoryTime(activeMerge.created_at) }}<template v-if="activeMerge.duration"> · {{ activeMerge.duration }}s</template></span>
            <a :href="'/' + activeMerge.merged_url" :download="mergeDownloadName(activeMerge)" class="btn btn-sm" style="margin-left:auto">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {{ t('episode.viewer.downloadFilm') }}
            </a>
            <button class="btn btn-ghost btn-icon" :title="t('common.close')" :aria-label="t('common.close')" @click="activeMerge = null">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="merge-viewer-body">
            <video
              :key="activeMerge.id"
              :src="'/' + activeMerge.merged_url"
              controls
              autoplay
              playsinline
              class="merge-viewer-video"
            />
          </div>
        </div>
      </div>

      <div v-if="assetCreate.open" class="overlay" @click.self="assetCreate.open = false">
        <div class="dialog asset-create-dialog" role="dialog" aria-modal="true" aria-labelledby="asset-create-title">
          <header class="dialog-head">
            <h2 id="asset-create-title" class="dialog-title">{{ t('episode.create.title', { type: assetCreateTypeLabel }) }}</h2>
            <button
              type="button"
              class="btn btn-ghost btn-icon"
              :title="t('common.close')"
              :aria-label="t('common.close')"
              @click="assetCreate.open = false"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </header>
          <div class="dialog-body asset-create-body">
            <template v-if="assetCreate.type === 'character'">
              <label class="field"><span class="field-label">{{ t('episode.create.name') }}</span><input v-model="assetCreateDraft.name" class="input" :placeholder="t('episode.create.namePlaceholderChar')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.create.roleField') }}</span><input v-model="assetCreateDraft.role" class="input" :placeholder="t('episode.create.rolePlaceholder')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.asset.appearanceField') }}</span><textarea v-model="assetCreateDraft.appearance" class="textarea" rows="3" :placeholder="t('episode.create.appearancePlaceholder')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.asset.stylingField') }}</span><textarea v-model="assetCreateDraft.styling" class="textarea" rows="2" :placeholder="t('episode.create.stylingPlaceholder')" /></label>
            </template>
            <template v-else-if="assetCreate.type === 'scene'">
              <label class="field"><span class="field-label">{{ t('episode.create.location') }}</span><input v-model="assetCreateDraft.location" class="input" :placeholder="t('episode.create.locationPlaceholder')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.create.time') }}</span><input v-model="assetCreateDraft.time" class="input" :placeholder="t('episode.create.timePlaceholder')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.asset.sceneDescField') }}</span><textarea v-model="assetCreateDraft.prompt" class="textarea" rows="3" :placeholder="t('episode.create.sceneDescPlaceholder')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.asset.sceneLightField') }}</span><input v-model="assetCreateDraft.lighting" class="input" :placeholder="t('episode.create.lightPlaceholder')" /></label>
            </template>
            <template v-else>
              <label class="field"><span class="field-label">{{ t('episode.create.name') }}</span><input v-model="assetCreateDraft.name" class="input" :placeholder="t('episode.create.namePlaceholderProp')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.create.typeField') }}</span><input v-model="assetCreateDraft.type" class="input" :placeholder="t('episode.create.typePlaceholder')" /></label>
              <label class="field"><span class="field-label">{{ t('episode.asset.appearanceOfObject') }}</span><textarea v-model="assetCreateDraft.description" class="textarea" rows="3" :placeholder="t('episode.create.appearanceOnlyPlaceholder')" /></label>
            </template>
          </div>
          <footer class="dialog-foot">
            <button type="button" class="btn" @click="assetCreate.open = false">{{ t('common.cancel') }}</button>
            <button
              type="button"
              class="btn btn-primary"
              :disabled="assetCreate.saving"
              :title="assetCreate.saving ? t('episode.create.saving') : null"
              @click="saveAssetCreate"
            >
              <Loader2 v-if="assetCreate.saving" :size="12" class="animate-spin" aria-hidden="true" />
              {{ assetCreate.saving ? t('episode.create.saving') : t('episode.create.submit', { type: assetCreateTypeLabel }) }}
            </button>
          </footer>
        </div>
      </div>

      <div v-if="batchVideoConfirm.open" class="overlay" @click.self="batchVideoConfirm.open = false">
        <div class="dialog batch-video-dialog">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.vid.confirmTitle') }}</h2>
            <button class="btn btn-ghost btn-icon" :title="t('common.close')" :aria-label="t('common.close')" @click="batchVideoConfirm.open = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </header>
          <div class="dialog-body batch-video-body">
            <div class="batch-video-row"><span>{{ t('episode.vid.confirmShots') }}</span><strong>{{ t('episode.vid.confirmShotsValue', { n: batchVideoConfirm.targets.length }) }}</strong></div>
            <div class="batch-video-row"><span>{{ t('episode.vid.confirmTotal') }}</span><strong>{{ t('episode.vid.confirmApprox', { n: batchVideoTotalDuration }) }}</strong></div>
            <div class="batch-video-row"><span>{{ t('episode.vid.confirmModel') }}</span><strong>{{ effectiveVideoModelLabel || t('episode.vid.defaultModel') }}</strong></div>
            <div class="batch-video-row"><span>{{ t('episode.vid.confirmResolution') }}</span><strong>{{ episodeResolutionLabel }}</strong></div>
            <p class="batch-video-note">{{ t('episode.vid.confirmNote') }}</p>
          </div>
          <footer class="dialog-foot">
            <button class="btn" @click="batchVideoConfirm.open = false">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" @click="confirmBatchVideos">{{ t('episode.vid.confirmStart', { n: batchVideoConfirm.targets.length }) }}</button>
          </footer>
        </div>
      </div>

      <div v-if="mergeDialog.open" class="overlay" @click.self="mergeDialog.open = false">
        <div class="dialog merge-title-dialog">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.export.titleDialog') }}</h2>
            <button class="btn btn-ghost btn-icon" :title="t('common.close')" :aria-label="t('common.close')" @click="mergeDialog.open = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </header>
          <div class="dialog-body">
            <label class="field">
              <span class="field-label">{{ t('episode.export.titleLabel') }}</span>
              <input
                v-model="mergeDialog.title"
                class="input"
                maxlength="80"
                :placeholder="t('episode.export.titlePlaceholder')"
                @keydown.enter.prevent="confirmMerge"
              />
            </label>
            <p class="batch-video-note">{{ t('episode.export.titleNote', { n: mergeDialog.ids.length }) }}</p>

            <div class="ai-transition-block">
              <label class="ai-transition-toggle">
                <input
                  v-model="mergeDialog.useAiTransitions"
                  type="checkbox"
                  :disabled="!transitionSupported || !mergeDialogBoundaries.length"
                  @change="mergeDialog.useAiTransitionsTouched = true"
                />
                <span>{{ t('episode.export.aiTransition.toggle') }}</span>
                <span class="dim">
                  {{ t('episode.export.aiTransition.readyHint', { ready: mergeDialogReadyCount, total: mergeDialogBoundaries.length }) }}
                </span>
                <span class="dim">
                  {{ t('episode.export.aiTransition.selectedHint', { n: mergeDialogSelectedCount, total: mergeDialogBoundaries.length }) }}
                </span>
              </label>
              <p v-if="!transitionSupported" class="batch-video-note">{{ t('episode.export.aiTransition.unsupported') }}</p>
              <template v-else>
                <div v-if="mergeDialogBoundaries.length" class="ai-transition-rows">
                  <div
                    v-for="b in mergeDialogBoundaries"
                    :key="`${b.from_storyboard_id}-${b.to_storyboard_id}`"
                    class="ai-transition-row"
                  >
                    <div class="ai-transition-row-head">
                      <label class="ai-transition-pick" :title="t('episode.export.aiTransition.pickHint')">
                        <input
                          type="checkbox"
                          :checked="isMergeBoundarySelected(b)"
                          :aria-label="transitionPairLabel(b)"
                          @change="toggleMergeBoundary(b)"
                        />
                      </label>
                      <span class="ai-transition-pair">{{ transitionPairLabel(b) }}</span>
                      <span :class="['ai-transition-status', transitionStatusClass(b)]">{{ transitionStatusLabel(b) }}</span>
                      <span v-if="transitionDurationLabel(b)" class="dim ai-transition-duration">{{ transitionDurationLabel(b) }}</span>
                      <span class="ai-transition-actions">
                        <button
                          v-if="b.id"
                          class="btn btn-sm btn-ghost"
                          @click="toggleTransitionPrompt(b)"
                        >
                          {{ t('episode.export.aiTransition.prompt.toggle') }}
                        </button>
                        <button
                          v-if="b.status === 'completed' && b.video_url && !b.stale"
                          class="btn btn-sm"
                          @click="openTransitionPreview(b)"
                        >
                          {{ t('episode.export.aiTransition.preview') }}
                        </button>
                        <button
                          v-if="b.status === 'failed' || b.stale"
                          class="btn btn-sm"
                          :disabled="transitionPreparing"
                          @click="retryTransitionItem(b)"
                        >
                          {{ t('episode.export.aiTransition.retry') }}
                        </button>
                        <button
                          v-if="b.status === 'skipped'"
                          class="btn btn-sm"
                          :disabled="transitionPreparing"
                          @click="retryTransitionItem(b)"
                        >
                          {{ t('episode.export.aiTransition.resume') }}
                        </button>
                        <button
                          v-if="b.enabled !== false && (b.status === 'completed' || b.status === 'failed')"
                          class="btn btn-sm btn-ghost"
                          :disabled="transitionPreparing"
                          @click="skipTransitionItem(b)"
                        >
                          {{ t('episode.export.aiTransition.skip') }}
                        </button>
                      </span>
                    </div>
                    <div v-if="b.id && transitionPromptOpen[transitionPromptKey(b)]" class="ai-transition-prompt">
                      <div class="ai-transition-prompt-head">
                        <span :class="['ai-transition-prompt-source', transitionPromptSourceClass(b)]">
                          {{ transitionPromptSourceLabel(b) }}
                        </span>
                        <button
                          class="btn btn-sm btn-ghost"
                          :disabled="transitionPromptBusy[transitionPromptKey(b)]"
                          @click="analyzeTransitionItem(b)"
                        >
                          {{ transitionPromptBusy[transitionPromptKey(b)]
                            ? t('episode.export.aiTransition.prompt.analyzing')
                            : t('episode.export.aiTransition.prompt.analyze') }}
                        </button>
                      </div>
                      <textarea
                        v-model="transitionPromptDrafts[transitionPromptKey(b)]"
                        class="input ai-transition-prompt-input"
                        rows="3"
                        maxlength="1200"
                        :disabled="transitionPromptBusy[transitionPromptKey(b)]"
                        :aria-label="t('episode.export.aiTransition.prompt.label')"
                        :placeholder="t('episode.export.aiTransition.prompt.placeholder')"
                        @input="markTransitionPromptDirty(b)"
                      />
                      <div class="ai-transition-prompt-actions">
                        <button
                          class="btn btn-sm"
                          :disabled="transitionPromptBusy[transitionPromptKey(b)]"
                          @click="saveTransitionPromptItem(b)"
                        >
                          {{ t('episode.export.aiTransition.prompt.save') }}
                        </button>
                        <button
                          class="btn btn-sm btn-primary"
                          :disabled="transitionPromptBusy[transitionPromptKey(b)]
                            || b.status === 'processing' || b.status === 'pending'"
                          @click="regenerateTransitionWithPrompt(b)"
                        >
                          {{ t('episode.export.aiTransition.prompt.regenerate') }}
                        </button>
                      </div>
                      <p v-if="transitionPromptEffectiveSource(b) === 'fallback'" class="ai-transition-prompt-note">
                        {{ t('episode.export.aiTransition.prompt.fallbackNote') }}
                      </p>
                      <p class="ai-transition-prompt-note">{{ t('episode.export.aiTransition.prompt.hint') }}</p>
                    </div>
                  </div>
                </div>
                <p v-else class="batch-video-note">{{ t('episode.export.aiTransition.needTwoShots') }}</p>
                <div class="ai-transition-pickers">
                  <label class="field">
                    <span class="field-label">{{ t('episode.export.aiTransition.duration') }}</span>
                    <select v-model.number="mergeDialog.duration" class="input">
                      <option v-for="seconds in [2, 3, 4, 5]" :key="seconds" :value="seconds">{{ seconds }}s</option>
                    </select>
                  </label>
                  <label class="field">
                    <span class="field-label">{{ t('episode.export.aiTransition.audioMode') }}</span>
                    <select v-model="mergeDialog.audioMode" class="input">
                      <option value="ambient">{{ t('episode.export.aiTransition.audioAmbient') }}</option>
                      <option value="silent">{{ t('episode.export.aiTransition.audioSilent') }}</option>
                    </select>
                  </label>
                </div>
                <p class="batch-video-note">{{ t('episode.export.aiTransition.fallbackHint') }}</p>
              </template>
            </div>
          </div>
          <footer class="dialog-foot">
            <button class="btn" @click="mergeDialog.open = false">{{ t('common.cancel') }}</button>
            <button
              class="btn"
              :disabled="!transitionSupported || transitionPreparing || transitionBusy || !mergeDialogSelectedCount"
              @click="generateMissingTransitions"
            >
              {{ t('episode.export.aiTransition.regenerateMissing') }}
            </button>
            <button class="btn btn-primary" :disabled="!mergeDialog.ids.length" @click="confirmMerge">
              {{ t('episode.export.mergeSelected', { n: mergeDialog.ids.length }) }}
            </button>
          </footer>
        </div>
      </div>

      <ConfirmDialog
        :open="assetDelete.open"
        :title="t('episode.delete.title', { type: assetDeleteTypeLabel })"
        :message="t('episode.delete.message', { type: assetDeleteTypeLabel, name: assetDeleteName })"
        :loading="assetDelete.loading"
        @confirm="confirmDeleteAsset"
        @cancel="assetDelete.open = false"
      />

      <ConfirmDialog
        :open="clearTasks.open"
        :title="t('episode.tasks.clearTitle')"
        :message="t('episode.tasks.clearMessage', { n: genTaskClearableCount })"
        :confirm-text="t('episode.tasks.clearConfirm')"
        :loading="clearTasks.loading"
        @confirm="confirmClearGenTasks"
        @cancel="clearTasks.open = false"
      />

      <ConfirmDialog
        :open="transitionDelete.open"
        :title="t('episode.export.aiTransition.deleteTitle')"
        :message="t('episode.export.aiTransition.deleteMessage', { pair: transitionDeletePair })"
        :confirm-text="t('episode.export.aiTransition.deleteConfirm')"
        :loading="transitionDelete.loading"
        @confirm="confirmDeleteTransition"
        @cancel="transitionDelete.open = false"
      />
    </main>
    </div>
  </div>

    <DubbingWorkbench
      :open="dubOpen"
      :episode-id="episode?.id || null"
      :drama-id="dramaId"
      @close="dubOpen = false"
      @updated="refresh"
      @open-stage="openDubbingStage"
    />
    <EpisodeDeliveryDialog
      :open="deliveryOpen"
      :episode-id="episode?.id || null"
      :current-video="episode?.videoUrl || episode?.video_url || null"
      @close="deliveryOpen = false"
      @updated="refresh"
    />
</template>

<script setup>
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import {
  Users, FileText, FolderKanban, Clapperboard, Download, Loader2,
  Plus, X, ListTodo, CircleHelp, Mic, AudioLines, SlidersHorizontal, Trash2, Scissors, Compass,
} from 'lucide-vue-next'
import { api, dramaAPI, episodeAPI, storyboardAPI, characterAPI, sceneAPI, propAPI, taskAPI, mergeAPI, transitionAPI, aiConfigAPI, uploadAPI, pipelineRuleAPI, dubbingAPI, filmAPI, settingsAPI } from '~/composables/useApi'
import { startTour, autoTour } from '~/composables/useTour'
import { useAgent } from '~/composables/useAgent'
import { useAgentPageAdapter } from '~/composables/useAgentPageAdapter'
import { resolveTextModelSelection } from '~/utils/text-model-selection'
import { episodeResolutionKey, isLocalH3Config, videoResolutionKey, videoResolutionOptions, videoResolutionProvider, videoResolutionVendor } from '~/utils/video-resolution'
import { videoModelCapabilities } from '~/utils/model-capabilities'
import { createStoryboardUpdateQueue } from '~/utils/storyboard-update-queue'
import { toastError, mapError, MODERATION_RE } from '~/composables/useToast'
import LocaleSwitcher from '~/components/LocaleSwitcher.vue'
import StudioTopBar from '~/components/studio/StudioTopBar.vue'
import EpisodeDeliveryDialog from '~/components/EpisodeDeliveryDialog.vue'

const DirectorTab = defineAsyncComponent(() => import('~/components/director/DirectorTab.vue'))

definePageMeta({ layout: 'studio' })

const { t } = useI18n()

const route = useRoute()
const router = useRouter()
const dramaId = Number(route.params.id)
const episodeNumber = Number(route.params.episodeNumber)
const dubOpen = ref(false)
const deliveryOpen = ref(false)
const dubbingEnabled = ref(false)

async function loadDubbingEnabled() {
  try {
    const result = await dubbingAPI.status()
    dubbingEnabled.value = Boolean(result?.enabled)
  } catch {
    dubbingEnabled.value = false
  }
}

const drama = ref(null), episode = ref(null), chars = ref([]), scenes = ref([]), propItems = ref([]), sbs = ref([]), mergeData = ref(null)
// 工作台面板位置记忆（按剧集隔离）：仅页面刷新(reload)时恢复到上次所在步骤；
// 从列表/详情页点击进入时始终默认「剧本」面板
const PANEL_STORE_KEY = `huobao:workbench:panel:${dramaId}:${episodeNumber}`
const isPageReload = (() => {
  try { return performance.getEntriesByType('navigation')[0]?.type === 'reload' } catch { return false }
})()
const storedPanel = (() => {
  if (!isPageReload) return null
  try { return JSON.parse(localStorage.getItem(PANEL_STORE_KEY) || 'null') } catch { return null }
})()
// 首个 refresh 时若已恢复面板位置，跳过按内容自动重置 scriptStep
let panelRestored = !!storedPanel
const panel = ref(['production', 'export', 'dubbing'].includes(storedPanel?.panel) ? storedPanel.panel : 'script')
// 导演台页签：设置异步读取；失败按 off 处理，不阻塞现有制作区
const directorMode = ref('off')
const directorModeLoaded = ref(false)
const directorInitialView = ref(undefined)
let directorLinkPending = false
let directorClosedNoticeShown = false
const { running: rn, runningType: rt, run: runAgent } = useAgent()
// 拆分是同步长请求：运行期间定时刷新，Agent 已写入的分镜能逐步出现；失败也会在 onSettled 刷新
const breakdownElapsed = ref(0)
let breakdownTimer = null
watch(rt, (value) => {
  if (breakdownTimer) { clearInterval(breakdownTimer); breakdownTimer = null }
  if (value !== 'storyboard_breaker') return
  breakdownElapsed.value = 0
  breakdownTimer = setInterval(() => {
    breakdownElapsed.value += 1
    if (breakdownElapsed.value % 5 === 0) void refresh()
  }, 1000)
})

const localRaw = ref(''), localScript = ref('')
const rawContent = computed(() => episode.value?.content || '')
const scriptContent = computed(() => episode.value?.script_content || episode.value?.scriptContent || '')
const epId = computed(() => episode.value?.id || 0)
const rawLen = computed(() => localRaw.value.replace(/\s/g, '').length || 0)
const scriptLen = computed(() => localScript.value.replace(/\s/g, '').length || 0)

// ===== 拼接导出:镜头选择 + 成片列表 =====
const exportSelectedIds = ref([]) // 勾选的镜头 id
const exportMerges = ref([])      // 成片(拼接记录)列表
let exportSelTouched = false      // 用户手动操作过选择后,不再自动全选

const exportReadyIds = computed(() => sbs.value.filter(s => hasVid(s)).map(s => s.id))
const exportSelectedReadyIds = computed(() => exportSelectedIds.value.filter(id => exportReadyIds.value.includes(id)))

watch(exportReadyIds, (ids) => {
  if (exportSelTouched) {
    exportSelectedIds.value = exportSelectedIds.value.filter(id => ids.includes(id))
  } else {
    exportSelectedIds.value = [...ids]
  }
})

function isExportSelected(id) { return exportSelectedIds.value.includes(id) }
function toggleExportSelect(sb) {
  if (!hasVid(sb)) return
  exportSelTouched = true
  exportSelectedIds.value = isExportSelected(sb.id)
    ? exportSelectedIds.value.filter(x => x !== sb.id)
    : [...exportSelectedIds.value, sb.id]
}
function toggleSelectAllExport() {
  exportSelTouched = true
  exportSelectedIds.value = exportSelectedReadyIds.value.length === exportReadyIds.value.length ? [] : [...exportReadyIds.value]
}

async function loadExportMerges() {
  if (!epId.value) return
  try { exportMerges.value = await mergeAPI.list(epId.value) || [] } catch { /* 静默 */ }
}

// ===== 成片中心动作（Phase B）：设当前 / 混音 / 剪辑 =====
async function setFilmCurrent(filmId) {
  try {
    await filmAPI.setCurrent(epId.value, filmId)
    await loadExportMerges()
    toast.success(t('films.setCurrentDone'))
  } catch (e) {
    toastError(e, { fallback: 'films.setCurrentFailed' })
  }
}

async function openFilmInMix(filmId) {
  try {
    await filmAPI.setCurrent(epId.value, filmId)
  } catch { /* 已是当前或网络异常时仍允许进入混音 */ }
  router.push({ path: route.path, query: { ...route.query, panel: 'dubbing', step: '3', film: String(filmId) } })
}

async function openFilmInEdit(filmId) {
  router.push(`/drama/${dramaId}/episode/${episode.value?.episode_number ?? episodeNumber}/edit?film=${filmId}`)
}

// 拼接页跳转通过 query 指向配音阶段第 4 步（预览与混音）；film 参数由混音侧后续任务消费
function applyRoutePanelQuery() {
  const q = route.query
  if (q.panel === 'dubbing') {
    panel.value = 'dubbing'
    const step = Number(q.step)
    if (Number.isInteger(step) && step >= 0 && step < DUB_STEP_KEYS.length) dubStep.value = step
  }
  if (q.panel === 'director') {
    if (q.view === '3d' || q.view === '2d') directorInitialView.value = q.view
    if (directorModeLoaded.value && directorMode.value === 'off') {
      if (prodTab.value === 'director') prodTab.value = 'videos'
      notifyDirectorClosed()
      return
    }
    panel.value = 'production'
    prodTab.value = 'director'
    if (!directorModeLoaded.value) directorLinkPending = true
  }
}

function notifyDirectorClosed() {
  if (directorClosedNoticeShown) return
  directorClosedNoticeShown = true
  toast.info(t('director.tab.closedHint'))
}

async function loadDirectorMode() {
  try {
    const result = await settingsAPI.director()
    const mode = result?.settings?.mode
    directorMode.value = ['off', 'readonly', 'on'].includes(mode) ? mode : 'off'
  } catch {
    directorMode.value = 'off'
  }
  directorModeLoaded.value = true
  if (directorMode.value !== 'off') {
    if (restoreDirectorTab && panel.value === 'production' && prodTab.value === 'assets') {
      prodTab.value = 'director'
    }
    return
  }
  if (directorLinkPending) {
    directorLinkPending = false
    notifyDirectorClosed()
  }
  if (prodTab.value === 'director') {
    prodTab.value = 'videos'
    panel.value = 'production'
  }
}

const scriptStep = ref(storedPanel ? (storedPanel.scriptStep === 0 ? 0 : 1) : 0)
// 旧版本地存储的 'storyboard' 子步骤已并入 'videos'（视频制作）
const storedProdTab = storedPanel?.prodTab === 'storyboard' ? 'videos' : storedPanel?.prodTab
// 旧的独立「音色」生产页已并入配音阶段的音色分配，历史本地状态迁移到该步骤。
const legacyVoicePanel = Boolean(storedProdTab) && !['assets', 'videos', 'director'].includes(String(storedProdTab))
const restoreDirectorTab = storedProdTab === 'director'
const prodTab = ref(['assets', 'videos'].includes(storedProdTab) ? storedProdTab : 'assets')
// 配音阶段的 5 个子步骤（与 DubbingStage 内部顺序一致）
const DUB_STEP_KEYS = ['lines', 'voices', 'generate', 'preview', 'export']
const storedDubStep = Number(storedPanel?.dubStep)
const dubStep = ref(legacyVoicePanel ? 1 : (Number.isInteger(storedDubStep) && storedDubStep >= 0 && storedDubStep < DUB_STEP_KEYS.length ? storedDubStep : 0))
const dubSummary = ref(null)
function onDubSummary(payload) { dubSummary.value = payload }
function openDubbingStage() { panel.value = 'dubbing' }
applyRoutePanelQuery()

// ===== 助手页面适配器：分集 / 混音 / 交付作用域（智能体规格 §4.2、§4.3） =====
const focusTrackId = ref(null)
const focusExportId = ref(null)
const focusStoryboardId = ref(null)
const focusLineId = ref(null)
const agentScope = computed(() => {
  const episodeId = Number(episode.value?.id) || 0
  if (!episodeId) return null
  const base = {
    workspace_key: `drama:${dramaId}`,
    drama_id: dramaId,
    episode_id: episodeId,
  }
  if (deliveryOpen.value || panel.value === 'export' || (panel.value === 'dubbing' && dubStep.value === 4)) {
    return {
      ...base,
      kind: 'delivery',
      ...(focusExportId.value != null ? { focus: { export_id: focusExportId.value } } : {}),
    }
  }
  if (panel.value === 'dubbing' && dubStep.value === 3) {
    return {
      ...base,
      kind: 'mix',
      ...(focusTrackId.value != null ? { focus: { track_id: focusTrackId.value } } : {}),
    }
  }
  if (panel.value === 'production' && prodTab.value === 'director' && directorMode.value !== 'off') {
    return {
      ...base,
      kind: 'director',
      ...(focusStoryboardId.value != null ? { focus: { storyboard_id: focusStoryboardId.value } } : {}),
    }
  }
  const stage = panel.value === 'script'
    ? 'script'
    : panel.value === 'production'
      ? (prodTab.value === 'videos' || prodTab.value === 'director' ? 'videos' : 'assets')
      : 'dubbing'
  return {
    ...base,
    kind: 'episode',
    stage,
    ...(focusLineId.value != null && panel.value === 'dubbing' && dubStep.value === 0
      ? { focus: { line_id: focusLineId.value } }
      : {}),
  }
})
function agentPrompts() {
  const kind = agentScope.value?.kind
  if (kind === 'director') return [t('assistant.prompts.director1'), t('assistant.prompts.director2')]
  if (kind === 'mix') return [t('assistant.prompts.mix1'), t('assistant.prompts.mix2')]
  if (kind === 'delivery') return [t('assistant.prompts.delivery1'), t('assistant.prompts.delivery2')]
  return [t('assistant.prompts.episode1'), t('assistant.prompts.episode2')]
}
useAgentPageAdapter({
  id: 'drama-episode',
  match: { name: 'drama-episode', pattern: /^\/drama\/\d+\/episode\/\d+$/ },
  scope: () => agentScope.value,
  entries: ['floating'],
  quickPrompts: agentPrompts,
  supportedScopes: ['episode', 'director', 'mix', 'delivery'],
  refresh: () => refresh(),
})

// 消费助手建议的 open/focus_* 参数：只做导航与定位，不执行生产动作
function applyAgentQuery() {
  const q = route.query
  const open = String(q.open || '').trim()
  if (open === 'edit') {
    const n = episode.value?.episode_number || episodeNumber
    const projectId = Number(q.project_id)
    router.push({
      path: `/drama/${dramaId}/episode/${n}/edit`,
      query: Number.isSafeInteger(projectId) && projectId > 0 ? { project_id: String(projectId) } : {},
    })
    return
  }
  if (open === 'script') {
    panel.value = 'script'
  } else if (open === 'assets') {
    panel.value = 'production'
    prodTab.value = 'assets'
  } else if (open === 'videos') {
    panel.value = 'production'
    prodTab.value = 'videos'
  } else if (open === 'director') {
    if (directorModeLoaded.value && directorMode.value === 'off') {
      notifyDirectorClosed()
    } else {
      panel.value = 'production'
      prodTab.value = 'director'
      directorInitialView.value = q.view === '3d' ? '3d' : q.view === '2d' ? '2d' : undefined
      if (!directorModeLoaded.value) directorLinkPending = true
    }
  } else if (open === 'dubbing') {
    panel.value = 'dubbing'
    dubStep.value = 0
  } else if (open === 'mix') {
    panel.value = 'dubbing'
    dubStep.value = 3
  } else if (open === 'delivery') {
    panel.value = 'dubbing'
    dubStep.value = 4
  }
  const trackId = Number(q.focus_track_id)
  focusTrackId.value = Number.isSafeInteger(trackId) && trackId > 0 ? trackId : null
  const exportId = Number(q.focus_export_id)
  focusExportId.value = Number.isSafeInteger(exportId) && exportId > 0 ? exportId : null
  const storyboardId = Number(q.focus_storyboard_id)
  focusStoryboardId.value = Number.isSafeInteger(storyboardId) && storyboardId > 0 ? storyboardId : null
  const lineApplies = open === 'dubbing' || (!open && panel.value === 'dubbing' && dubStep.value === 0)
  const lineId = Number(q.focus_line_id)
  focusLineId.value = lineApplies && Number.isSafeInteger(lineId) && lineId > 0 ? lineId : null
  if (open || q.focus_track_id || q.focus_export_id || q.focus_storyboard_id || q.focus_line_id) {
    const next = { ...route.query }
    delete next.open
    delete next.project_id
    delete next.focus_track_id
    delete next.focus_export_id
    delete next.focus_storyboard_id
    delete next.focus_line_id
    delete next.view
    router.replace({ path: route.path, query: next, hash: route.hash })
  }
}
applyAgentQuery()
watch(() => route.query, () => {
  applyRoutePanelQuery()
  applyAgentQuery()
})

const hasEditEntry = computed(() => Boolean(episode.value?.video_url || episode.value?.videoUrl))

function openEditWorkspace() {
  if (!episode.value) return
  const n = episode.value.episode_number || episode.value.episodeNumber || episodeNumber
  navigateTo(`/drama/${dramaId}/episode/${n}/edit`)
}
function goDubbingSettings() { navigateTo({ path: '/settings', query: { tab: 'dubbing' } }) }
// 面板位置变化即持久化
watch([panel, scriptStep, prodTab, dubStep], ([p, s, pt, ds]) => {
  try { localStorage.setItem(PANEL_STORE_KEY, JSON.stringify({ panel: p, scriptStep: s, prodTab: pt, dubStep: ds })) } catch { /* 静默 */ }
})
// ===== 视频制作三栏宽度：拖拽调节 + 全局持久化（双击分隔条恢复默认） =====
const VIDEO_COL_STORE_KEY = 'huobao:workbench:video-cols'
const VIDEO_COL_DEFAULTS = { left: 236, right: 340 }
const VIDEO_COL_LIMITS = { left: [180, 420], right: [260, 560] }
const storedVideoCols = (() => {
  try {
    const c = JSON.parse(localStorage.getItem(VIDEO_COL_STORE_KEY) || 'null')
    return c && typeof c === 'object' ? c : null
  } catch { return null }
})()
const clampVideoCol = (which, w) => Math.min(VIDEO_COL_LIMITS[which][1], Math.max(VIDEO_COL_LIMITS[which][0], Math.round(w)))
const videoLeftW = ref(clampVideoCol('left', Number(storedVideoCols?.left) || VIDEO_COL_DEFAULTS.left))
const videoRightW = ref(clampVideoCol('right', Number(storedVideoCols?.right) || VIDEO_COL_DEFAULTS.right))
watch([videoLeftW, videoRightW], ([l, r]) => {
  try { localStorage.setItem(VIDEO_COL_STORE_KEY, JSON.stringify({ left: l, right: r })) } catch { /* 静默 */ }
})
function startVideoColDrag(which, e) {
  if (e.button !== 0) return
  e.preventDefault()
  const target = e.currentTarget
  const startX = e.clientX
  const startW = which === 'left' ? videoLeftW.value : videoRightW.value
  const onMove = (ev) => {
    const dx = ev.clientX - startX
    const w = clampVideoCol(which, which === 'left' ? startW + dx : startW - dx)
    if (which === 'left') videoLeftW.value = w
    else videoRightW.value = w
  }
  const onUp = () => {
    target.removeEventListener('pointermove', onMove)
    target.removeEventListener('pointerup', onUp)
    target.removeEventListener('pointercancel', onUp)
    document.body.classList.remove('is-video-col-dragging')
  }
  document.body.classList.add('is-video-col-dragging')
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onUp)
  target.addEventListener('pointercancel', onUp)
  target.setPointerCapture?.(e.pointerId)
}
const activeExtractTab = ref('characters')
const prodTabIdx = computed({
  get: () => prodTabDefs.value.findIndex(d => d.id === prodTab.value),
  set: (v) => { prodTab.value = prodTabDefs.value[v]?.id || 'assets' },
})
const imageConfigs = ref([])
const videoConfigs = ref([])
const textConfigs = ref([])
// 生成时可选模型：空串 = 跟随配置默认（models[0]）。文本/图片是全局偏好；
// 视频模型属于集级配置，按 episodes.video_config_id 恢复，存储键按集隔离，避免跨集串用。
const MODEL_STORE_KEYS = { chat: 'huobao:model:chat', image: 'huobao:model:image' }
function readStoredModel(key, legacyKey = '') {
  try { return localStorage.getItem(key) || (legacyKey && localStorage.getItem(legacyKey)) || '' } catch { return '' }
}
// 顶栏文本模型：适用于所有 Chat Agent 调用（改写/提取/拆镜/视频提示词/最终提示词），空串 = 跟随配置默认
const chatModel = ref(readStoredModel(MODEL_STORE_KEYS.chat, 'huobao:model:rewrite'))
const imageModel = ref(readStoredModel(MODEL_STORE_KEYS.image))
const videoModel = ref('')
function persistModel(modelRef, key) {
  watch(modelRef, v => {
    try { v ? localStorage.setItem(key, v) : localStorage.removeItem(key) } catch {}
  })
}
persistModel(chatModel, MODEL_STORE_KEYS.chat)
persistModel(imageModel, MODEL_STORE_KEYS.image)
// 左侧菜单栏收起/展开：收起为窄图标栏给内容区让位，持久化到 localStorage
const SIDEBAR_COLLAPSED_KEY = 'huobao:sidebar-collapsed'
const sidebarCollapsed = ref((() => {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1' } catch { return false }
})())
function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value
  try {
    sidebarCollapsed.value
      ? localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1')
      : localStorage.removeItem(SIDEBAR_COLLAPSED_KEY)
  } catch { /* 静默 */ }
}
/** 默认项也传出界面显示的模型和所属配置，覆盖 Agent 文件中的其他默认模型。 */
function chatModelOverride() { return resolveTextModelSelection(textModelOptions.value, chatModel.value).model }
function chatConfigId() { return resolveTextModelSelection(textModelOptions.value, chatModel.value).configId }
const pendingCharImageIds = ref([])
const pendingSceneImageIds = ref([])
const pendingPropImageIds = ref([])
const pendingVideoIds = ref([])
const failedVideoMessages = ref({})
// 任务列表面板：顶栏按钮触发的右侧抽屉,按集聚合 sys_task + video_merges
const genTasks = ref([])
const genMerges = ref([])
const taskDrawer = ref(false)
const clearTasks = ref({ open: false, loading: false })
let genTasksTimer = null

function openTaskDrawer() {
  taskDrawer.value = true
  loadGenTasks()
  // 过渡任务没有分镜号，需要断点列表把 transition_id 还原成「S01 尾 → S02 首」
  void loadTransitions()
}
function closeTaskDrawer() {
  taskDrawer.value = false
}
const imageViewer = ref({ open: false, src: '', title: '' })
const activeMerge = ref(null) // 成片大预览弹窗中正在播放的拼接记录
const mergeDialog = ref({
  open: false,
  ids: [],
  title: '',
  useAiTransitions: false,
  useAiTransitionsTouched: false,
  selectedBoundaries: [],
  boundariesTouched: false,
  duration: 3,
  audioMode: 'ambient',
}) // 拼接前命名弹窗（含 AI 过渡开关与断点勾选）
const previewShot = ref(null) // 导出页镜头素材/过渡片段预览弹窗
const transitionDetail = ref({ open: false, id: null }) // 过渡镜头详情弹窗
const transitionDelete = ref({ open: false, loading: false, id: null })
const transitionState = ref({ loading: false, boundaries: [], provider: null })
const transitionPreparing = ref(false)
const transitionPromptOpen = ref({})
const transitionPromptDrafts = ref({})
const transitionPromptBusy = ref({})
const transitionPromptDirty = ref({})
const transitionPromptAnalyzed = ref({})
let transitionTimer = null
let transitionRequestSeq = 0
function shotNumberOf(sb) {
  const i = sbs.value.findIndex(s => s.id === sb?.id)
  return i >= 0 ? i + 1 : 0
}
// 导出步骤完成 = 用户手动标记（episodes.status = 'completed'），不再按最新拼接记录推算
const exportDone = computed(() => episode.value?.status === 'completed')
async function toggleExportDone() {
  if (!epId.value) return
  const status = exportDone.value ? 'active' : 'completed'
  try {
    await episodeAPI.update(epId.value, { status })
    if (episode.value) episode.value.status = status
    toast.success(status === 'completed' ? t('episode.export.markedDoneToast') : t('episode.export.unmarkDoneToast'))
  } catch (e) {
    toastError(e)
  }
}
// 弹窗只保存资产 id，item 由当前数组派生：refresh 替换数组后弹窗自动拿到新数据
const assetDetail = ref({ open: false, type: '', id: null })
const assetDetailItem = computed(() => {
  if (!assetDetail.value.open || assetDetail.value.id === null) return null
  const list = assetDetail.value.type === 'character'
    ? chars.value
    : assetDetail.value.type === 'scene'
      ? scenes.value
      : propItems.value
  return (list || []).find(item => item.id === assetDetail.value.id) || null
})
const assetDetailRefs = computed(() => assetRefs(assetDetailItem.value))
function updateCharacterVoice(id, voice) {
  const patch = { ...voice, voiceAudioUrl: voice.voice_audio_url, voiceAudioName: voice.voice_audio_name }
  const character = chars.value.find(item => item.id === id)
  if (character) Object.assign(character, patch)
}
const assetDetailDraft = ref({ appearance: '', styling: '', prompt: '', lighting: '', description: '' })
// 最终提示词手动编辑：dirty 时才随保存提交，避免无修改保存误清空 Agent 生成的提示词
const assetPromptDraft = ref('')
const assetPromptDirty = ref(false)
const savingAssetDetail = ref(false)

function isPendingCharImage(id) {
  return pendingCharImageIds.value.includes(id)
}

function openImageViewer(src, title = '') {
  if (!src) return
  imageViewer.value = { open: true, src, title }
}

function closeImageViewer() {
  imageViewer.value = { open: false, src: '', title: '' }
}

function openAssetDetail(type, item) {
  if (!item) return
  assetDetail.value = { open: true, type, id: item.id }
  assetDetailDraft.value = {
    appearance: item.appearance || '',
    styling: item.styling || '',
    prompt: item.prompt || (type === 'prop' ? '' : item.description) || '',
    lighting: item.lighting || '',
    description: item.description || '',
  }
  assetPromptDraft.value = item.final_prompt || item.finalPrompt || ''
  assetPromptDirty.value = false
}

function closeAssetDetail() {
  assetDetail.value = { open: false, type: '', id: null }
  assetDetailDraft.value = { appearance: '', styling: '', prompt: '', lighting: '', description: '' }
  assetPromptDraft.value = ''
  assetPromptDirty.value = false
}

// ─── 手动新增资产 ────────────────────────────────────────────
// 类型短显示名渲染时求值（不模块级固化），逻辑判断一律用 kind code
const assetKindLabelMap = computed(() => ({
  character: t('common.role'),
  scene: t('common.scene'),
  prop: t('common.prop'),
}))
function assetKindLabel(type) {
  return assetKindLabelMap.value[type] || t('episode.asset.fallbackType')
}
const assetCreate = ref({ open: false, type: 'character', saving: false })
const assetCreateDraft = ref({})
const assetCreateTypeLabel = computed(() => assetKindLabel(assetCreate.value.type))

function openAssetCreate(type) {
  assetCreateDraft.value = { name: '', role: '', appearance: '', styling: '', location: '', time: '', prompt: '', lighting: '', type: '', description: '' }
  assetCreate.value = { open: true, type, saving: false }
}

async function saveAssetCreate() {
  const d = assetCreateDraft.value
  const type = assetCreate.value.type
  if (assetCreate.value.saving) return
  if (type === 'scene' ? !d.location?.trim() : !d.name?.trim()) {
    toast.warning(type === 'scene' ? t('episode.create.locationRequired') : t('episode.create.nameRequired'))
    return
  }
  assetCreate.value.saving = true
  try {
    const base = { drama_id: dramaId, episode_id: epId.value }
    if (type === 'character') await characterAPI.create({ ...base, name: d.name, role: d.role, appearance: d.appearance, styling: d.styling })
    else if (type === 'scene') await sceneAPI.create({ ...base, location: d.location, time: d.time, prompt: d.prompt, lighting: d.lighting })
    else await propAPI.create({ ...base, name: d.name, type: d.type, description: d.description })
    toast.success(t('episode.create.created', { type: assetCreateTypeLabel.value }))
    assetCreate.value.open = false
    await refresh()
  } catch (e) {
    toastError(e)
  } finally {
    assetCreate.value.saving = false
  }
}

// ─── 删除资产 ────────────────────────────────────────────────
const assetDelete = ref({ open: false, type: '', item: null, loading: false })
const assetDeleteTypeLabel = computed(() => assetKindLabel(assetDelete.value.type))
const assetDeleteName = computed(() => assetDelete.value.item?.name || assetDelete.value.item?.location || '')

function askDeleteAsset(type, item) {
  assetDelete.value = { open: true, type, item, loading: false }
}

async function confirmDeleteAsset() {
  const { type, item } = assetDelete.value
  if (!item || assetDelete.value.loading) return
  assetDelete.value.loading = true
  try {
    if (type === 'character') await characterAPI.del(item.id)
    else if (type === 'scene') await sceneAPI.del(item.id)
    else await propAPI.del(item.id)
    toast.success(t('episode.delete.deleted', { type: assetDeleteTypeLabel.value }))
    assetDelete.value.open = false
    if (assetDetail.value.open && assetDetail.value.type === type && assetDetail.value.id === item.id) closeAssetDetail()
    await refresh()
  } catch (e) {
    toastError(e)
  } finally {
    assetDelete.value.loading = false
  }
}

function onAssetPromptInput(event) {
  assetPromptDraft.value = event.target.value
  assetPromptDirty.value = true
}

const assetFinalPrompt = computed(() => {
  const item = assetDetailItem.value
  return item?.final_prompt || item?.finalPrompt || ''
})

/** 弹窗 item 由列表派生，更新列表即同步弹窗 */
function applyFinalPrompt(type, id, fp) {
  const list = type === 'character' ? chars.value : type === 'scene' ? scenes.value : propItems.value
  const target = list.find(x => x.id === id)
  if (target) Object.assign(target, { final_prompt: fp, finalPrompt: fp })
}

const generatingPromptKeys = ref([])

function isGeneratingPrompt(type, id) {
  return generatingPromptKeys.value.includes(`${type}:${id}`)
}

/** 该资产图片是否在外层「生成」流程中（含提示词阶段与生图阶段） */
function isAssetImagePending(type, id) {
  return type === 'character' ? isPendingCharImage(id) : type === 'scene' ? isPendingSceneImage(id) : isPendingPropImage(id)
}

/**
 * 生成最终提示词（弹窗按钮与外层两段式生图共用同一 key 状态，避免重复触发）
 * force=true 时忽略已有提示词强制重新生成
 * 返回最终提示词；生成失败由接口抛错，Agent 返回空时返回 ''
 */
async function ensureAssetPrompt(type, id, force = false) {
  const key = `${type}:${id}`
  if (generatingPromptKeys.value.includes(key)) return ''
  generatingPromptKeys.value.push(key)
  try {
    const res = type === 'character'
      ? await characterAPI.generatePrompt(id, epId.value, force, chatModelOverride(), chatConfigId())
      : type === 'scene'
        ? await sceneAPI.generatePrompt(id, epId.value, force, chatModelOverride(), chatConfigId())
        : await propAPI.generatePrompt(id, epId.value, force, chatModelOverride(), chatConfigId())
    const fp = res?.final_prompt || res?.finalPrompt || ''
    if (fp) applyFinalPrompt(type, id, fp)
    return fp
  } finally {
    generatingPromptKeys.value = generatingPromptKeys.value.filter(k => k !== key)
  }
}

/** 弹窗内生成最终提示词（不生图）；已有最终提示词时重新生成（force） */
async function genAssetFinalPrompt() {
  const detail = assetDetail.value
  const item = assetDetailItem.value
  if (!detail.open || !item) return
  const force = !!assetFinalPrompt.value
  try {
    const fp = await ensureAssetPrompt(detail.type, item.id, force)
    if (!fp) throw new Error(t('episode.asset.promptGenFailedRetry'))
    assetPromptDraft.value = fp
    assetPromptDirty.value = false
    toast.success(force ? t('episode.asset.promptRegenerated') : t('episode.asset.promptGenerated'))
  } catch (e) {
    toastError(e, { fallback: 'episode.asset.promptGenFailed' })
  }
}

async function copyAssetFinalPrompt() {
  const text = assetPromptDraft.value || assetFinalPrompt.value
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('episode.asset.promptCopied'))
  } catch {
    toast.error(t('episode.asset.copyFailed'))
  }
}

async function saveAssetDetail() {
  const detail = assetDetail.value
  const item = assetDetailItem.value
  if (!detail.open || !item) return
  // 只提交真正修改过的字段：无修改保存不应触发后端的提示词失效置空
  const payload = {}
  let infoChanged = false
  if (detail.type === 'character') {
    if (assetDetailDraft.value.appearance !== (item.appearance || '')) payload.appearance = assetDetailDraft.value.appearance
    if (assetDetailDraft.value.styling !== (item.styling || '')) payload.styling = assetDetailDraft.value.styling
  } else if (detail.type === 'scene') {
    if (assetDetailDraft.value.prompt !== (item.prompt || '')) payload.prompt = assetDetailDraft.value.prompt
    if (assetDetailDraft.value.lighting !== (item.lighting || '')) payload.lighting = assetDetailDraft.value.lighting
  } else {
    if (assetDetailDraft.value.description !== (item.description || '')) payload.description = assetDetailDraft.value.description
  }
  infoChanged = Object.keys(payload).length > 0
  // 手动编辑过最终提示词才提交；空串视为清空
  if (assetPromptDirty.value) payload.final_prompt = assetPromptDraft.value.trim() || ''
  if (!infoChanged && !assetPromptDirty.value) {
    toast.info(t('episode.asset.noChanges'))
    return
  }
  savingAssetDetail.value = true
  try {
    if (detail.type === 'character') await characterAPI.update(item.id, payload)
    else if (detail.type === 'scene') await sceneAPI.update(item.id, payload)
    else await propAPI.update(item.id, payload)
    // 本地同步：手动编辑的提示词以草稿为准；仅信息字段变更时提示词已被后端置空
    const { final_prompt, ...infoPatch } = payload
    const promptValue = assetPromptDirty.value ? (payload.final_prompt || null) : (infoChanged ? null : (item.final_prompt || item.finalPrompt || null))
    Object.assign(item, infoPatch, { final_prompt: promptValue, finalPrompt: promptValue })
    const list = detail.type === 'character' ? chars.value : detail.type === 'scene' ? scenes.value : propItems.value
    const target = list.find(x => x.id === item.id)
    if (target) Object.assign(target, infoPatch, { final_prompt: promptValue, finalPrompt: promptValue })
    if (assetPromptDirty.value) assetPromptDraft.value = payload.final_prompt || ''
    assetPromptDirty.value = false
    toast.success(t('episode.asset.saved'))
  } catch (e) {
    toastError(e, { fallback: 'episode.asset.saveFailed' })
  } finally {
    savingAssetDetail.value = false
  }
}

function assetImageSrc(item) {
  const raw = item?.image_url || item?.imageUrl || ''
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/')) return raw
  return `/${raw}`
}

function assetDetailTitle(type, item) {
  if (!item) return ''
  if (type === 'character') return item.name || t('episode.asset.unnamedChar')
  if (type === 'prop') return item.name || t('episode.asset.unnamedProp')
  return item.location || t('episode.asset.unnamedScene')
}

/** 资产详情弹窗 kicker / aria-label 用长标签 */
function assetTypeLabel(type) {
  return { character: t('episode.asset.typeChar'), scene: t('episode.asset.typeScene'), prop: t('episode.asset.typeProp') }[type] || t('episode.asset.fallbackType')
}

/** 资产详情预览图标题（角色形象/场景图/道具图） */
function assetDetailImageTitle(type, item) {
  if (!item) return ''
  const kindLabel = type === 'character' ? t('episode.asset.charPortrait') : type === 'scene' ? t('episode.asset.sceneImage') : t('common.prop')
  return `${assetDetailTitle(type, item)} ${kindLabel}`
}

function characterAppearanceValue(char) {
  return char?.appearance || t('episode.asset.appearanceTodo')
}

function characterStylingValue(char) {
  return char?.styling || t('episode.asset.stylingTodo')
}

function characterVisualSummary(char) {
  return `${t('episode.asset.appearance')}${characterAppearanceValue(char)} · ${t('episode.asset.styling')}${characterStylingValue(char)}`
}

function sceneDescriptionValue(scene) {
  return scene?.prompt || scene?.description || t('episode.asset.sceneDescTodo')
}

function sceneLightingValue(scene) {
  return scene?.lighting || t('episode.asset.sceneLightTodo')
}

function handleImageViewerKeydown(event) {
  if (event.key !== 'Escape') return
  if (imageViewer.value.open) closeImageViewer()
  else if (assetDetail.value.open) closeAssetDetail()
  else if (previewShot.value) previewShot.value = null
  else if (taskDrawer.value) closeTaskDrawer()
}

onMounted(() => {
  window.addEventListener('keydown', handleImageViewerKeydown)
  window.addEventListener('beforeunload', warnPendingStoryboardUpdates)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleImageViewerKeydown)
  window.removeEventListener('beforeunload', warnPendingStoryboardUpdates)
  flushPendingStoryboardUpdates()
  stopGenTasksPolling()
  stopTransitionPolling()
  comfyPollSeq++
  if (breakdownTimer) { clearInterval(breakdownTimer); breakdownTimer = null }
})

function isPendingSceneImage(id) {
  return pendingSceneImageIds.value.includes(id)
}

function isPendingVideo(id) {
  return pendingVideoIds.value.includes(id)
}

function videoFailMessage(id) {
  return failedVideoMessages.value[id] || ''
}

// 内容审核类失败（真人/敏感内容，如火山的 OutputVideoSensitiveContentDetected）：
// 各厂商审核尺度不同，给出切换模型重试的引导
function videoModerationHint(msg) {
  return MODERATION_RE.test(String(msg || '')) ? t('episode.vid.moderationHint') : ''
}

function videoTaskState(sb) {
  if (hasVid(sb)) return 'done'
  if (isPendingVideo(sb?.id)) return 'pending'
  if (videoFailMessage(sb?.id)) return 'failed'
  return 'ready'
}

function latestVideoTask(id) {
  return genTasks.value.filter(task => task.type === 'video' && task.storyboard_id === id)
    .sort((a, b) => b.id - a.id)[0]
}
const recoverableVideoCount = computed(() => sbs.value.filter(sb => canRecoverVideo(sb.id)).length)
function canRecoverVideo(id) {
  const task = latestVideoTask(id)
  return !!task && task.status === 'failed' && task.error_code !== 'generation_failed'
    && !!(task.task_id || task.result_url)
}
function videoAwaitingDelivery(sb) {
  const task = latestVideoTask(sb?.id)
  return !!task && (!!task.result_url || task.error_code === 'delivery_failed' || task.stage === 'transferring')
}
function videoErrorLabel(id, error) {
  const task = latestVideoTask(id)
  if (task?.error_code === 'delivery_failed' || (task?.result_url && task?.status === 'failed')) return t('episode.recovery.downloadFailed')
  if (task?.error_code === 'submission_unknown') return t('episode.recovery.unknownSubmission')
  return mapError(error)
}
async function copyVideoDiagnostics(id) {
  const task = latestVideoTask(id)
  if (task) await copyTaskDiagnostics(task.id)
}
async function copyTaskDiagnostics(taskId) {
  try {
    const info = await taskAPI.diagnostics(taskId)
    await navigator.clipboard.writeText(JSON.stringify(info, null, 2))
    toast.success(t('episode.recovery.copied'))
  } catch (error) { toastError(error) }
}
async function recoverVideo(sb) {
  const task = latestVideoTask(sb.id)
  if (!task) return
  return recoverTask(task.id, sb.id)
}
async function recoverTask(taskId, storyboardId) {
  if (isPendingVideo(storyboardId)) return
  if (storyboardId) pendingVideoIds.value.push(storyboardId)
  try {
    await taskAPI.recover(taskId)
    delete failedVideoMessages.value[storyboardId]
    await refresh()
    pollVideoGeneration(taskId, storyboardId)
  } catch (error) {
    pendingVideoIds.value = pendingVideoIds.value.filter(id => id !== storyboardId)
    toastError(error)
  }
}

function videoTaskStatusLabel(sb) {
  const state = videoTaskState(sb)
  if (state === 'done') return t('episode.status.done')
  if (state === 'pending') {
    const stage = latestVideoTask(sb.id)?.stage
    return stage === 'downloading' ? t('episode.recovery.downloading')
      : stage === 'transferring' ? t('episode.recovery.transferring') : t('episode.status.generating')
  }
  if (state === 'failed' && latestVideoTask(sb?.id)?.result_url) return t('episode.recovery.localDownloadFailed')
  if (state === 'failed') return t('episode.status.failed')
  return t('episode.status.todo')
}

function videoTaskActionLabel(sb) {
  if (canRecoverVideo(sb?.id)) return t('episode.recovery.restore')
  if (latestVideoTask(sb?.id)?.status === 'failed') return t('episode.recovery.newGeneration')
  const state = videoTaskState(sb)
  if (state === 'done') return t('episode.asset.regen')
  if (state === 'pending') return t('episode.asset.generating')
  return t('episode.asset.generate')
}

const allVideoTaskRows = computed(() => sbs.value.map((sb, index) => {
  const duration = Number(sb.duration || 5)
  const referenceCount = getShotReferenceImages(sb).length
  const sceneName = getSceneName(sb)
  return {
    id: sb.id,
    index,
    storyboard: sb,
    title: sb.description || t('episode.vid.shotN', { n: String(index + 1).padStart(2, '0') }),
    meta: sceneName,
    duration: Number.isFinite(duration) ? duration : 5,
    referenceCount,
    state: videoTaskState(sb),
    // 只有当前处于失败状态才显示错误,避免重试成功的分镜残留历史错误信息
    error: videoTaskState(sb) === 'failed' ? videoFailMessage(sb.id) : '',
  }
}))
// 列表筛选：点击顶部统计徽章过滤（再点一次取消）
const videoListFilter = ref('')
const videoTaskRows = computed(() => videoListFilter.value
  ? allVideoTaskRows.value.filter(task => task.state === videoListFilter.value)
  : allVideoTaskRows.value)
const videoTaskDoneCount = computed(() => allVideoTaskRows.value.filter(task => task.state === 'done').length)
const videoTaskFailedCount = computed(() => allVideoTaskRows.value.filter(task => task.state === 'failed').length)
function toggleVideoFilter(state) {
  videoListFilter.value = videoListFilter.value === state ? '' : state
}

// ===== 批量视频：选择模式 + 生成前确认（视频生成成本高，避免误触全量触发） =====
const videoSelectMode = ref(false)
const selectedVideoSbIds = ref([])
const batchVideoConfirm = ref({ open: false, targets: [] })

function isVideoSbSelected(id) { return selectedVideoSbIds.value.includes(id) }
function toggleVideoSbSelect(id) {
  selectedVideoSbIds.value = isVideoSbSelected(id)
    ? selectedVideoSbIds.value.filter(item => item !== id)
    : [...selectedVideoSbIds.value, id]
}
function toggleVideoSelectMode() {
  videoSelectMode.value = !videoSelectMode.value
  if (!videoSelectMode.value) selectedVideoSbIds.value = []
}
function onVideoTaskRowClick(sb) {
  if (videoSelectMode.value) toggleVideoSbSelect(sb.id)
  else selectedSb.value = sb
}

// 旁白角色识别：按内容语言的关键词匹配（提取产物中的旁白角色不参与画面生成）
function isNarratorCharacter(char) {
  const text = `${char?.name || ''} ${char?.role || ''}`.toLowerCase()
  return ['旁白', '画外音', 'narrator', 'ナレーター', 'ナレーション', '내레이션', '해설'].some(k => text.includes(k))
}

const visualChars = computed(() => chars.value.filter(c => !isNarratorCharacter(c)))
// 参考素材从项目级资产池合并：本集已关联资产用本地最新数据覆盖，其他剧集素材也可直接绑定
function mergeAssetsById(projectAssets, episodeAssets) {
  const map = new Map()
  for (const asset of projectAssets) map.set(asset.id, asset)
  for (const asset of episodeAssets) map.set(asset.id, asset)
  return [...map.values()]
}
const projectVisualChars = computed(() =>
  (drama.value?.characters || []).filter(c => !c.deleted_at && !c.deletedAt && !isNarratorCharacter(c)),
)
const projectSceneList = computed(() => (drama.value?.scenes || []).filter(s => !s.deleted_at && !s.deletedAt))
const projectPropList = computed(() => (drama.value?.props || []).filter(p => !p.deleted_at && !p.deletedAt))
const bindableChars = computed(() => mergeAssetsById(projectVisualChars.value, visualChars.value))
const bindableScenes = computed(() => mergeAssetsById(projectSceneList.value, scenes.value))
const bindableProps = computed(() => mergeAssetsById(projectPropList.value, propItems.value))
const episodeCharacterIdSet = computed(() => new Set(chars.value.map(c => c.id)))
const episodeSceneIdSet = computed(() => new Set(scenes.value.map(s => s.id)))
const episodePropIdSet = computed(() => new Set(propItems.value.map(p => p.id)))
// 视频制作双模式：native = 逐分镜生成，comfyui = 整集工作流一次提交
const episodeVideoMode = computed(() =>
  (episode.value?.video_mode || episode.value?.videoMode) === 'comfyui' ? 'comfyui' : 'native')
const isComfyVideoMode = computed(() => episodeVideoMode.value === 'comfyui')
const isComfyConfig = cfg => String(cfg?.provider || '').toLowerCase() === 'comfyui'
const comfyConfigs = computed(() => videoConfigs.value.filter(isComfyConfig))
const nativeVideoConfigs = computed(() => videoConfigs.value.filter(cfg => !isComfyConfig(cfg)))
const videoModelConfigs = computed(() => isComfyVideoMode.value ? comfyConfigs.value : nativeVideoConfigs.value)
const lockedVideoConfigId = computed(() => isComfyVideoMode.value
  ? (episode.value?.comfyui_config_id || episode.value?.comfyuiConfigId || null)
  : (episode.value?.video_config_id || episode.value?.videoConfigId || null))
// 集视频分辨率：顶栏直接修改（持久化 episodes.resolution，生成任务按此值锁定）。
// 档位与显示统一走 utils/video-resolution（项目详情页的「新建集 / 集卡片」共用同一套口径），
// 避免同一条集在项目页显示 720p、在制作页显示 768P。
const resolutionProvider = computed(() => videoResolutionProvider(selectedVideoConfig.value?.provider))
// 分辨率档位按当前选中的视频模型生成（Seedance 2.0 mini/fast 最高 720p、H3-Highspeed 仅 768P）
const resolutionModel = computed(() => {
  const explicit = bareModelName(videoModel.value)
  if (explicit) return explicit
  return configModels(selectedVideoConfig.value)[0] || ''
})
const resolutionOptions = computed(() => videoResolutionOptions(
  resolutionProvider.value,
  episode.value?.resolution,
  t,
  resolutionModel.value,
  videoCapabilityOpts.value,
).map(option => ({ key: option.value, model: option.label })))
const episodeResolution = computed({
  get: () => {
    // 兼容历史写法（1080P / 2K / 768P 等）统一归到内部三档
    const v = episodeResolutionKey(episode.value?.resolution)
    return resolutionOptions.value.some(o => o.key === v) ? v : resolutionOptions.value[0]?.key || '720p'
  },
  set: (val) => { void changeEpisodeResolution(val) },
})
async function changeEpisodeResolution(val) {
  if (!episode.value || val === videoResolutionKey(episode.value.resolution)) return
  const prev = episode.value.resolution
  episode.value.resolution = val
  const label = resolutionOptions.value.find(o => o.key === val)?.model || val
  try {
    await episodeAPI.update(epId.value, { resolution: val })
    toast.success(t('episode.vid.resolutionSwitched', { label }))
  } catch (e) {
    episode.value.resolution = prev
    toastError(e)
  }
}
// 视频原生音频：auto/native 生成时保留模型音频，ambient 只留环境声，silent 静音便于后期 TTS。
const videoAudioModeOptions = computed(() => [
  { key: 'auto', model: t('settings.dubbing.videoAudioAuto') },
  { key: 'native', model: t('settings.dubbing.videoAudioNative') },
  { key: 'ambient', model: t('settings.dubbing.videoAudioAmbient') },
  { key: 'silent', model: t('settings.dubbing.videoAudioSilent') },
])
const episodeVideoAudioMode = computed({
  get: () => episode.value?.video_audio_mode || episode.value?.videoAudioMode || 'auto',
  set: (val) => { void changeEpisodeVideoAudioMode(val) },
})
async function changeEpisodeVideoAudioMode(val) {
  const prev = episodeVideoAudioMode.value
  if (!episode.value || val === prev) return
  episode.value.video_audio_mode = val
  const label = videoAudioModeOptions.value.find(o => o.key === val)?.model || val
  try {
    await episodeAPI.update(epId.value, { video_audio_mode: val })
    toast.success(t('episode.topbar.videoAudioSwitched', { mode: label }))
  } catch (e) {
    episode.value.video_audio_mode = prev
    toastError(e)
  }
}
// 画面比例在创建项目时固定，视频生成统一使用
const dramaAspectRatio = computed(() => drama.value?.aspect_ratio || drama.value?.aspectRatio || '16:9')

// 生成可选模型列表：配置中的模型数组（首位为配置默认）；API 可能返回数组或 JSON 字符串
function configModels(cfg) {
  const raw = cfg?.model
  if (!raw) return []
  if (Array.isArray(raw)) return raw.filter(Boolean)
  try { const m = JSON.parse(raw); return Array.isArray(m) ? m.filter(Boolean) : [m].filter(Boolean) } catch { return [raw].filter(Boolean) }
}
// 汇总该类型全部启用配置的模型（按优先级排序），选中模型时连同所属配置一起调用
// 选中值使用 'provider/model#configId' 复合键：同名模型可能来自不同配置（本地 shim 与云端官方），必须区分
function collectModelOptions(cfgs) {
  const seen = new Set()
  const out = []
  const sorted = [...cfgs].filter(c => c.is_active).sort((a, b) => (b.priority || 0) - (a.priority || 0))
  for (const c of sorted) {
    for (const m of configModels(c)) {
      const key = `${c.provider}/${m}#${c.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, model: m, provider: c.provider, configId: c.id, configName: c.name || c.provider })
    }
  }
  return out
}
// 复合键 → 裸模型名（后端适配器按厂商校验模型名，不能带 provider 前缀与配置后缀）
function bareModelName(key) {
  if (!key) return ''
  const base = key.split('#')[0]
  const i = base.indexOf('/')
  return i >= 0 ? base.slice(i + 1) : base
}
// 精确匹配优先；旧版存的是 'provider/model' 或裸模型名，按模型名回落到锁定/最高优先级配置
function findModelOption(options, key) {
  if (!key) return null
  const exact = options.find(o => o.key === key)
  if (exact) return exact
  const legacy = key.split('#')[0]
  const bare = bareModelName(key)
  const candidates = options.filter(o => o.model === bare || `${o.provider}/${o.model}` === legacy)
  return candidates[0] || null
}
function ownerConfigId(options, key) {
  return findModelOption(options, key)?.configId || undefined
}
function hasMultiConfigs(options) {
  return new Set(options.map(o => o.configId)).size > 1
}
const textModelOptions = computed(() => collectModelOptions(textConfigs.value))
const imageModelOptions = computed(() => collectModelOptions(imageConfigs.value))
const videoModelOptions = computed(() => collectModelOptions(videoModelConfigs.value))
// 未显式选择时展示集锁定配置的首个模型，而不是全部配置里优先级最高的那个
const defaultVideoModelLabel = computed(() => {
  const locked = videoModelConfigs.value.find(c => c.id === Number(lockedVideoConfigId.value) && c.is_active)
  const model = configModels(locked)[0] || videoModelOptions.value[0]?.model || ''
  return t('episode.model.defaultWith', { model })
})
const selectedVideoConfig = computed(() => {
  const selected = findModelOption(videoModelOptions.value, videoModel.value)
  if (selected) return videoModelConfigs.value.find(config => config.id === selected.configId)
  const locked = videoModelConfigs.value.find(config => config.id === lockedVideoConfigId.value && config.is_active)
  if (locked) return locked
  return [...videoModelConfigs.value]
    .filter(config => config.is_active)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]
})
// 本地 H3 / 自建网关可渲染 480P；云端同模型仍只认 768P/2K
const videoLocalShim = computed(() => isLocalH3Config(selectedVideoConfig.value))
const videoCapabilityOpts = computed(() => ({ localShim: videoLocalShim.value }))
const isWan3Video = computed(() => selectedVideoConfig.value?.provider === 'aliyun'
  || bareModelName(videoModel.value).startsWith('wan3.0-video'))

// 切换视频模型后旧分辨率可能超出新模型能力（如 H3 的 1080p → H3-Highspeed 仅 768P）：
// 自动降到新模型支持的档位并持久化，避免提交任务时才被适配器拒绝。
// 只监听模型与集加载，不监听 resolution 本身，用户手动改档位不会被回弹。
watch([resolutionProvider, resolutionModel, () => episode.value?.id], () => {
  if (!episode.value) return
  const tier = videoResolutionKey(episode.value.resolution)
  const capability = videoModelCapabilities(resolutionProvider.value, resolutionModel.value, videoCapabilityOpts.value)
  if (tier && capability.resolutions.includes(tier)) return
  const fallback = capability.resolutions.includes('720p')
    ? '720p'
    : capability.resolutions[capability.resolutions.length - 1]
  if (fallback) void changeEpisodeResolution(fallback)
})

// 参考图上限（Wan 3.0 官方 10 张，其他模型 9 张），绑定素材收集与 @名字 映射统一读取
const refImageLimit = computed(() => isWan3Video.value ? 10 : 9)

// 本次生成的生效配置（模型/分辨率/时长），用于右侧小结与批量确认弹窗
const effectiveVideoModelLabel = computed(() => resolutionModel.value)
const episodeResolutionLabel = computed(() =>
  resolutionOptions.value.find(o => o.key === episodeResolution.value)?.model || episodeResolution.value)
// 短档位标签（480p / 768P / 2K 等厂商原生档位），用于底部生效配置小结
const episodeResolutionShort = computed(() =>
  videoResolutionVendor(resolutionProvider.value, episodeResolution.value, resolutionModel.value, videoCapabilityOpts.value))
const effectiveVideoDuration = computed(() => Number(selectedSb.value?.duration || 10))
const batchVideoTotalDuration = computed(() =>
  batchVideoConfirm.value.targets.reduce((sum, sb) => sum + (Number(sb.duration) || 5), 0))

function openBatchVideoConfirm(pool) {
  const targets = pool.filter(s => !isPendingVideo(s.id))
  if (!targets.length) { toast.info(t('episode.vid.noneToGenerate')); return }
  batchVideoConfirm.value = { open: true, targets }
}
function batchVideos() {
  // 选择模式且有勾选 → 仅所选（允许重出已完成镜头）；否则全部未完成（待生成+失败）
  const useSelection = videoSelectMode.value && selectedVideoSbIds.value.length
  const pool = useSelection
    ? sbs.value.filter(s => selectedVideoSbIds.value.includes(s.id))
    : sbs.value.filter(s => !hasVid(s))
  openBatchVideoConfirm(pool)
}
async function retryFailedVideos() {
  await Promise.allSettled(sbs.value.filter(sb => canRecoverVideo(sb.id)).map(recoverVideo))
}
function confirmBatchVideos() {
  const targets = [...batchVideoConfirm.value.targets]
  batchVideoConfirm.value = { open: false, targets: [] }
  if (!targets.length) return
  const ids = targets.map(s => s.id)
  targets.forEach(sb => genVid(sb, { silent: true }))
  toast.success(t('episode.vid.batchStarted', { n: ids.length }))
  watchAsyncResult(() => ids.every(id => {
    const target = sbs.value.find(s => s.id === id)
    const done = !!getVideoUrl(target)
    if (done) pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== id)
    return done
  }), 80, 4000)
  if (videoSelectMode.value) toggleVideoSelectMode()
}

// 配置变化后校验持久化的模型是否仍存在（配置被删/模型被移除时回退默认，避免把失效模型传给后端）
function pruneStaleModel(modelRef, optionsRef) {
  watch(optionsRef, opts => {
    if (!modelRef.value || !opts.length) return
    if (opts.some(o => o.key === modelRef.value)) return
    // 旧版本地存储是裸模型名或 'provider/model'：能对上则升级为带配置的复合键，对不上回退默认
    const legacy = opts.filter(o => o.model === modelRef.value || `${o.provider}/${o.model}` === modelRef.value)
    modelRef.value = legacy.length ? legacy[0].key : ''
  }, { immediate: true })
}
pruneStaleModel(chatModel, textModelOptions)
pruneStaleModel(imageModel, imageModelOptions)
// 视频模型不走通用清理：失效选项由 syncVideoModelWithEpisode 静默回退，避免触发配置写回
const textModelMultiCfg = computed(() => hasMultiConfigs(textModelOptions.value))
const imageModelMultiCfg = computed(() => hasMultiConfigs(imageModelOptions.value))
const videoModelMultiCfg = computed(() => hasMultiConfigs(videoModelOptions.value))

// ===== 顶栏视频模型 ↔ 集锁定配置 =====
// 视频生成按集的 video_config_id 锁定服务配置：顶栏切换写回该字段，
// 刷新或切集时再按字段恢复（配置内具体模型按集记忆），避免全局 localStorage 串到其他集。
const videoConfigReady = ref(false)
let videoModelSilent = false
let videoConfigWritePending = 0
let confirmedVideoConfigId = null
let videoConfigWriteSeq = 0
let videoConfigWriteQueue = Promise.resolve()

function episodeVideoModelStoreKey() {
  return `huobao:model:video:episode:${episode.value?.id || 0}`
}
function readEpisodeVideoModel() {
  try { return localStorage.getItem(episodeVideoModelStoreKey()) || '' } catch { return '' }
}
function setVideoModelQuietly(key) {
  videoModelSilent = true
  videoModel.value = key
  videoModelSilent = false
}

function syncVideoModelWithEpisode() {
  if (!episode.value || !videoModelOptions.value.length) return
  // 写回未完成时不要用旧锁定值把刚选的模型拉回去
  if (videoConfigWritePending > 0) return
  const lockedId = Number(lockedVideoConfigId.value) || 0
  const selected = findModelOption(videoModelOptions.value, videoModel.value)
  let target = null
  if (lockedId) {
    const stored = findModelOption(videoModelOptions.value, readEpisodeVideoModel())
    target = selected?.configId === lockedId
      ? selected
      : stored?.configId === lockedId
        ? stored
        : videoModelOptions.value.find(o => o.configId === lockedId) || null
  } else if (!videoConfigReady.value) {
    target = selected || findModelOption(videoModelOptions.value, readEpisodeVideoModel())
  }
  if (target && target.key !== videoModel.value) setVideoModelQuietly(target.key)
  else if (!target && videoModel.value && !selected) setVideoModelQuietly('')
  confirmedVideoConfigId = lockedId || null
  videoConfigReady.value = true
}
watch([videoModelOptions, lockedVideoConfigId, () => episode.value?.id], syncVideoModelWithEpisode)

// 配置内具体模型按集记忆；配置本身仍以集锁定为准
watch(videoModel, key => {
  if (!videoConfigReady.value) return
  try {
    if (key) localStorage.setItem(episodeVideoModelStoreKey(), key)
    else localStorage.removeItem(episodeVideoModelStoreKey())
  } catch { /* 静默 */ }
})

// 顶栏切换模型时把所属配置写回集：串行执行，只落最后一次选择；失败回滚选择与锁定值。
watch(videoModel, (key, prevKey) => {
  if (videoModelSilent || !videoConfigReady.value || !episode.value?.id || !key) return
  const configId = ownerConfigId(videoModelOptions.value, key)
  if (!configId) return
  const seq = ++videoConfigWriteSeq
  videoConfigWritePending++
  videoConfigWriteQueue = videoConfigWriteQueue.catch(() => {}).then(async () => {
    try {
      if (seq !== videoConfigWriteSeq) return
      const prevLocked = confirmedVideoConfigId ?? (Number(lockedVideoConfigId.value) || null)
      const targetConfig = videoConfigs.value.find(config => config.id === configId)
      const comfyTarget = isComfyConfig(targetConfig)
      // ComfyUI 配置单独写入 comfyui_config_id，原生/云端仍写 video_config_id
      await episodeAPI.update(epId.value, comfyTarget ? { comfyui_config_id: configId } : { video_config_id: configId })
      if (seq !== videoConfigWriteSeq) return
      if (episode.value) {
        if (comfyTarget) episode.value.comfyui_config_id = configId
        else episode.value.video_config_id = configId
      }
      confirmedVideoConfigId = configId
      toast.success(t('episode.topbar.videoConfigSwitched', { name: bareModelName(key) }))
      if (comfyTarget) {
        void loadComfyPreview(configId)
        if (isComfyVideoMode.value) void loadComfyUiSession(configId)
      }
    } catch (e) {
      if (seq !== videoConfigWriteSeq) return
      setVideoModelQuietly(prevKey)
      if (episode.value) {
        if (isComfyConfig(videoConfigs.value.find(config => config.id === configId))) episode.value.comfyui_config_id = prevLocked
        else episode.value.video_config_id = prevLocked
      }
      toastError(e)
    } finally {
      videoConfigWritePending--
    }
  })
}, { flush: 'sync' })

// ===== 视频制作双模式：原生逐镜头 / ComfyUI 整集工作流 =====
const comfyPreview = ref(null)
const comfyPreviewLoading = ref(false)
const comfyPreviewError = ref('')
const comfyRunning = ref(false)
const comfyUiUrl = ref('')
const comfyUiLoading = ref(false)
const comfyUiError = ref('')
const comfyUiExpiresAt = ref(null)
const comfyUiGateway = ref(false)
const comfyUiFrameKey = ref(0)
let comfyUiRequestSeq = 0
let comfyPollSeq = 0

const comfyConfigName = computed(() => {
  const id = Number(comfyPreview.value?.config?.id || selectedVideoConfig.value?.id || 0)
  return videoConfigs.value.find(config => config.id === id)?.name || 'ComfyUI'
})
const comfyPendingTaskId = computed(() => {
  const task = genTasks.value.find(t => t.type === 'video' && t.status === 'processing' && isEpisodeComfyTask(t))
  return task?.id || null
})

const comfyPreviewConfigId = computed(() => {
  const selected = findModelOption(videoModelOptions.value, videoModel.value)
  return selected?.configId || (isComfyVideoMode.value ? Number(episode.value?.comfyui_config_id) || undefined : undefined)
})

async function loadComfyPreview(configId) {
  if (!epId.value || !isComfyVideoMode.value) return
  comfyPreviewLoading.value = true
  comfyPreviewError.value = ''
  try {
    comfyPreview.value = await episodeAPI.comfyWorkflow(epId.value, configId || comfyPreviewConfigId.value)
  } catch (e) {
    comfyPreview.value = null
    comfyPreviewError.value = e.message || t('episode.comfy.previewFailed')
  } finally {
    comfyPreviewLoading.value = false
  }
}

async function loadComfyUiSession(configId) {
  if (!epId.value || !isComfyVideoMode.value) return
  const seq = ++comfyUiRequestSeq
  comfyUiLoading.value = true
  comfyUiError.value = ''
  try {
    const res = await episodeAPI.comfyUiSession(epId.value, configId || comfyPreviewConfigId.value)
    if (seq !== comfyUiRequestSeq) return
    const url = String(res?.url || '').trim()
    if (!url) throw new Error(t('episode.comfy.monitorFailed'))
    comfyUiUrl.value = url
    comfyUiExpiresAt.value = Number(res?.expiresAt || res?.expires_at) || null
    comfyUiGateway.value = res?.gateway === true
    comfyUiFrameKey.value++
  } catch (e) {
    if (seq !== comfyUiRequestSeq) return
    comfyUiUrl.value = ''
    comfyUiExpiresAt.value = null
    comfyUiError.value = e.message || t('episode.comfy.monitorFailed')
  } finally {
    if (seq === comfyUiRequestSeq) comfyUiLoading.value = false
  }
}

function resetComfyUiSession() {
  comfyUiRequestSeq++
  comfyUiUrl.value = ''
  comfyUiError.value = ''
  comfyUiLoading.value = false
  comfyUiExpiresAt.value = null
  comfyUiGateway.value = false
}

async function reloadComfyUi() {
  await loadComfyUiSession()
}

function openComfyUI() {
  if (!comfyUiUrl.value) {
    void loadComfyUiSession()
    return
  }
  window.open(comfyUiUrl.value, '_blank', 'noopener,noreferrer')
}

function goComfySettings() {
  navigateTo({ path: '/settings', query: { tab: 'ai' } })
}

async function changeEpisodeVideoMode(mode) {
  if (!episode.value || mode === episodeVideoMode.value) return
  const prev = episodeVideoMode.value
  episode.value.video_mode = mode
  try {
    await episodeAPI.update(epId.value, { video_mode: mode })
    if (mode === 'comfyui') {
      const active = [...comfyConfigs.value]
        .filter(config => config.is_active)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      const fallback = active.find(config => config.id === Number(episode.value.comfyui_config_id)) || active[0]
      if (fallback && Number(episode.value.comfyui_config_id) !== fallback.id) {
        await episodeAPI.update(epId.value, { comfyui_config_id: fallback.id })
        episode.value.comfyui_config_id = fallback.id
      }
      if (fallback) {
        const option = videoModelOptions.value.find(o => o.configId === fallback.id)
        if (option && videoModel.value !== option.key) setVideoModelQuietly(option.key)
      }
      await loadComfyPreview(fallback?.id)
      void loadComfyUiSession(fallback?.id)
      toast.success(t('episode.comfy.modeSwitchedComfy'))
    } else {
      const locked = nativeVideoConfigs.value.find(config => config.id === Number(episode.value.video_config_id) && config.is_active)
      const fallback = locked || [...nativeVideoConfigs.value]
        .filter(config => config.is_active)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]
      if (fallback) {
        const option = videoModelOptions.value.find(o => o.configId === fallback.id)
        if (option && videoModel.value !== option.key) setVideoModelQuietly(option.key)
      }
      comfyPreview.value = null
      comfyPreviewError.value = ''
      resetComfyUiSession()
      toast.success(t('episode.comfy.modeSwitchedNative'))
    }
  } catch (e) {
    episode.value.video_mode = prev
    toastError(e)
  }
}

async function runComfyEpisode() {
  if (comfyRunning.value || !epId.value) return
  const segments = comfyPreview.value?.timeline?.segments?.length || sbs.value.length
  if (!window.confirm(t('episode.comfy.runConfirm', { n: segments }))) return
  comfyRunning.value = true
  try {
    const res = await episodeAPI.comfyRun(epId.value, { configId: comfyPreviewConfigId.value })
    toast.success(t('episode.comfy.runStarted', { n: res?.segmentCount ?? segments }))
    await loadGenTasks()
    void pollComfyEpisode(res?.taskId)
  } catch (e) {
    toastError(e, { fallback: 'episode.comfy.runFailed' })
  } finally {
    comfyRunning.value = false
  }
}

async function pollComfyEpisode(taskId) {
  if (!taskId) return
  const seq = ++comfyPollSeq
  const episodeId = epId.value
  for (let i = 0; i < 300; i++) {
    await sleep(4000)
    if (seq !== comfyPollSeq || episodeId !== epId.value) return
    try {
      const res = await taskAPI.get(taskId)
      if (seq !== comfyPollSeq || episodeId !== epId.value) return
      if (res?.status === 'completed') {
        toast.success(t('episode.comfy.runDone'))
        await refresh()
        return
      }
      if (res?.status === 'failed') {
        toastError(res?.error_msg || res?.errorMsg, { fallback: 'episode.comfy.runFailed' })
        await loadGenTasks()
        return
      }
    } catch { /* 下一轮继续 */ }
  }
  if (seq !== comfyPollSeq || episodeId !== epId.value) return
  await loadGenTasks()
}

// Production step helpers
// ========== 任务列表面板 ==========
async function loadGenTasks() {
  if (!epId.value) return
  try {
    const data = await taskAPI.listByEpisode(epId.value)
    genTasks.value = data?.tasks || []
    genMerges.value = data?.merges || []

    // 生成中/失败状态只存在内存里,页面刷新后丢失;从 sys_task 记录按分镜恢复,
    // 否则已失败的镜头刷新后会退化成"待生成"
    const videoTasks = genTasks.value.filter(t => t.type === 'video' && t.storyboard_id)
    // 每个分镜只取最新一条任务(created_at 降序、id 兜底),旧任务不干预当前状态
    const latestBySb = new Map()
    for (const t of videoTasks) {
      const prev = latestBySb.get(t.storyboard_id)
      if (!prev
        || String(t.created_at || '') > String(prev.created_at || '')
        || (String(t.created_at || '') === String(prev.created_at || '') && t.id > prev.id)) {
        latestBySb.set(t.storyboard_id, t)
      }
    }
    // pending/failed 全量重建而非与现有值并集——否则刷新恢复的"生成中"在任务失败后
    // 永不消退(videoTaskState 中 pending 优先于 failed,重试按钮还被禁用)
    const pending = new Set()
    const failed = {}
    for (const [sbId, t] of latestBySb) {
      // 分镜已有视频(失败后重试成功)时不再报历史错误
      if (hasVid(sbs.value.find(s => s.id === sbId))) continue
      if (t.status === 'processing') pending.add(sbId)
      else if (t.status === 'failed') failed[sbId] = t.error_msg || 'Task failed'
    }
    // 刚点击提交、任务记录尚未加载出来的本地状态保留,避免状态闪退
    for (const id of pendingVideoIds.value) if (!latestBySb.has(id)) pending.add(id)
    for (const id of Object.keys(failedVideoMessages.value)) {
      if (!latestBySb.has(Number(id))) failed[id] = failedVideoMessages.value[id]
    }
    pendingVideoIds.value = [...pending]
    failedVideoMessages.value = failed
  } catch { /* 静默失败,不打断其他刷新 */ }
}

function stopGenTasksPolling() {
  if (genTasksTimer) { clearInterval(genTasksTimer); genTasksTimer = null }
}

const genTaskActiveCount = computed(() =>
  genTasks.value.filter(t => t.status === 'processing').length +
  genMerges.value.filter(m => m.status === 'processing' || m.status === 'pending').length
)
const genTaskDoneCount = computed(() =>
  genTasks.value.filter(t => t.status === 'completed').length +
  genMerges.value.filter(m => m.status === 'completed').length
)
const genTaskFailedCount = computed(() =>
  genTasks.value.filter(t => t.status === 'failed').length +
  genMerges.value.filter(m => m.status === 'failed').length
)
// 清空范围只含 sys_task 的已完成/失败记录；成片版本与进行中任务保留
const genTaskClearableCount = computed(() =>
  genTasks.value.filter(t => t.status === 'completed' || t.status === 'failed').length
)

async function confirmClearGenTasks() {
  if (!epId.value || clearTasks.value.loading) return
  clearTasks.value.loading = true
  try {
    const result = await taskAPI.clearByEpisode(epId.value)
    clearTasks.value.open = false
    failedVideoMessages.value = {}
    await loadGenTasks()
    toast.success(t('episode.tasks.cleared', { n: result?.deleted ?? 0 }))
  } catch (err) {
    toastError(err)
  } finally {
    clearTasks.value.loading = false
  }
}

// 整集 ComfyUI 任务的 params 带 comfyTimeline；用于任务抽屉识别与重复提交提示
function isEpisodeComfyTask(task) {
  const raw = task?.params
  if (!raw) return false
  try { return !!JSON.parse(raw).comfyTimeline } catch { return false }
}

function genTaskTargetLabel(task) {
  if (task.type === 'video' && isEpisodeComfyTask(task)) return t('episode.tasks.wholeEpisode')
  if (task.transition_id) {
    const boundary = transitionBoundaries.value.find(b => b.id === task.transition_id)
    return boundary
      ? t('episode.tasks.transitionPair', { from: boundary.from_number, to: boundary.to_number })
      : t('episode.tasks.transitionShort', { id: task.transition_id })
  }
  if (task.storyboard_id) {
    const sb = sbs.value.find(x => x.id === task.storyboard_id)
    return t('episode.tasks.sbN', { n: sb?.storyboard_number ?? sb?.storyboardNumber ?? task.storyboard_id })
  }
  if (task.character_id) {
    const c = chars.value.find(x => x.id === task.character_id)
    return `${t('common.role')} · ${c?.name || task.character_id}`
  }
  if (task.scene_id) {
    const s = scenes.value.find(x => x.id === task.scene_id)
    return `${t('common.scene')} · ${s?.location || task.scene_id}`
  }
  if (task.prop_id) {
    const p = propItems.value.find(x => x.id === task.prop_id)
    return `${t('common.prop')} · ${p?.name || task.prop_id}`
  }
  return t('episode.tasks.generic')
}

// 统一行结构：image / video / merge 三类合并按时间倒序
const genTaskRows = computed(() => {
  const taskRows = genTasks.value.map(t => ({
    key: `task-${t.id}`,
    kind: t.type, // image | video
    id: t.id,
    targetLabel: genTaskTargetLabel(t),
    provider: t.provider || '',
    model: t.model || '',
    status: t.status || 'processing',
    errorMsg: t.error_msg || '',
    storyboardId: t.storyboard_id,
    transitionId: t.transition_id || null,
    recoverable: t.type === 'video' && t.error_code !== 'generation_failed' && !!(t.task_id || t.result_url),
    previewUrl: t.local_path || t.result_url || '',
    prompt: t.prompt || '',
    createdAt: t.created_at || '',
    completedAt: t.completed_at || '',
  }))
  const mergeRows = genMerges.value.map(m => ({
    key: `merge-${m.id}`,
    kind: 'merge',
    id: m.id,
    targetLabel: t('episode.tasks.fullMerge'),
    provider: m.provider || 'ffmpeg',
    model: m.model || '',
    status: m.status || 'pending',
    errorMsg: m.error_msg || '',
    previewUrl: m.merged_url || '',
    prompt: '',
    createdAt: m.created_at || '',
    completedAt: m.completed_at || '',
  }))
  return [...taskRows, ...mergeRows].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
})

function genTaskKindLabel(kind, transitionId = null) {
  if (transitionId) return t('episode.tasks.transitionKind')
  return kind === 'image' ? t('common.serviceType.image') : kind === 'video' ? t('common.serviceType.video') : t('episode.tasks.mergeKind')
}

function genTaskStatusLabel(status) {
  if (status === 'completed') return t('episode.status.done')
  if (status === 'failed') return t('episode.status.failed')
  return t('episode.status.generating')
}

// 映射到现有 video-task-status 的样式类:is-done / is-pending / is-failed
function genTaskStateClass(status) {
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  return 'pending'
}

// local_path 为站内相对路径补 '/',远端 result_url 原样使用
function genTaskPreviewSrc(url) {
  if (!url) return ''
  return /^https?:\/\//.test(url) ? url : '/' + url
}

function genTaskDuration(row) {
  if (!row.createdAt || !row.completedAt) return ''
  const ms = new Date(row.completedAt).getTime() - new Date(row.createdAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return ''
  return ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`
}

// 后端任务在刷新/重启后仍可能运行，工作台持续同步，不依赖抽屉是否打开。
let refreshingTasks = false
watch(genTaskActiveCount, active => {
  stopGenTasksPolling()
  if (active > 0) genTasksTimer = setInterval(async () => {
    if (refreshingTasks) return
    refreshingTasks = true
    try { await refresh() } finally { refreshingTasks = false }
  }, 4000)
})

const productionBlockMessage = computed(() => {
  if (!scriptContent.value) return t('episode.prod.scriptFirst')
  return ''
})
const productionBlockActionLabel = computed(() => {
  if (!scriptContent.value) return t('episode.export.gotoScript')
  return t('episode.prod.goBack')
})
function goProductionBlockTarget() {
  if (!scriptContent.value) {
    panel.value = 'script'
    scriptStep.value = rawContent.value ? 1 : 0
    return
  }
  panel.value = 'production'
  prodTab.value = 'assets'
}
const stepLabels = computed(() => [t('episode.script.raw'), t('episode.script.rewrite')])

const charImgCount = computed(() => visualChars.value.filter(c => c.image_url || c.imageUrl).length)
const sceneImgCount = computed(() => scenes.value.filter(s => s.image_url || s.imageUrl).length)
const propImgCount = computed(() => propItems.value.filter(p => p.image_url || p.imageUrl).length)
const shotVidCount = computed(() => sbs.value.filter(s => s.video_url || s.videoUrl).length)
const visualCharTotal = computed(() => visualChars.value.length)
const pendingCharacterImageCount = computed(() => Math.max(visualCharTotal.value - charImgCount.value, 0))
const pendingSceneImageCount = computed(() => Math.max(scenes.value.length - sceneImgCount.value, 0))
const pendingAssetImageCount = computed(() => pendingCharacterImageCount.value + pendingSceneImageCount.value)
const assetTotalCount = computed(() => visualCharTotal.value + scenes.value.length + propItems.value.length)
const assetReadyCount = computed(() => charImgCount.value + sceneImgCount.value + propImgCount.value)

const prodTabDefs = computed(() => {
  const defs = [
    { id: 'assets', label: t('episode.prod.assets'), icon: FolderKanban, badge: assetTotalCount.value ? `${assetReadyCount.value}/${assetTotalCount.value}` : '' },
    { id: 'videos', label: t('episode.prod.videos'), icon: Clapperboard, badge: sbs.value.length ? `${shotVidCount.value}/${sbs.value.length}` : '' },
  ]
  if (directorMode.value !== 'off') {
    defs.push({ id: 'director', label: t('director.tab.label'), icon: Compass, badge: '' })
  }
  return defs
})

const mainStageDefs = computed(() => ([
  { id: 'script', label: t('episode.stage.script'), desc: t('episode.stage.scriptDesc'), icon: FileText },
  { id: 'assets', label: t('episode.prod.assets'), desc: t('episode.stage.assetsDesc'), icon: FolderKanban },
  { id: 'videos', label: t('episode.stage.videos'), desc: t('episode.stage.videosDesc'), icon: Clapperboard },
  { id: 'dubbing', label: t('episode.stage.dubbing'), desc: t('episode.stage.dubbingDesc'), icon: Mic },
  { id: 'export', label: t('episode.stage.export'), desc: t('episode.stage.exportDesc'), icon: Download },
]))

const sidebarSections = computed(() => ([
  {
    id: 'script',
    label: t('episode.stage.script'),
    items: [
      { key: 'script:raw', label: t('episode.script.raw'), desc: '', icon: FileText },
      { key: 'script:rewrite', label: t('episode.script.rewrite'), desc: '', icon: FileText },
    ],
  },
  {
    id: 'production',
    label: t('episode.stage.production'),
    items: [
      { key: 'prod:assets', label: t('episode.prod.assets'), desc: '', icon: Users },
      { key: 'prod:videos', label: t('episode.prod.videos'), desc: '', icon: Clapperboard },
      ...(directorMode.value !== 'off'
        ? [{ key: 'prod:director', label: t('director.tab.label'), desc: '', icon: Compass }]
        : []),
    ],
  },
  {
    id: 'dubbing',
    label: t('episode.stage.dubbing'),
    items: [
      { key: 'dub:lines', label: t('workbench.stepLines'), desc: '', icon: ListTodo },
      { key: 'dub:voices', label: t('workbench.stepVoices'), desc: '', icon: Mic },
      { key: 'dub:generate', label: t('workbench.stepGenerate'), desc: '', icon: AudioLines },
      { key: 'dub:preview', label: t('workbench.stepPreview'), desc: '', icon: SlidersHorizontal },
      { key: 'dub:export', label: t('workbench.stepExport'), desc: '', icon: Download },
    ],
  },
  {
    id: 'export',
    label: t('episode.stage.export'),
    items: [
      { key: 'export:merge', label: t('episode.stage.mergeExport'), desc: '', icon: Download },
    ],
  },
]))

// 大环节状态:pending(未开始)/ active(进行中)/ done(已完成)/ none(不显示状态,导出用)
// 进行中 = 环节内有任意进度但未全部完成,或当前正处于该环节
function sectionState(sectionId) {
  if (sectionId === 'export') return 'none'
  if (sectionId === 'dubbing') {
    if (mainStageDone('dubbing')) return 'done'
    const hasProgress = !!dubSummary.value?.total
      || ['running', 'failed', 'stopped', 'done'].includes(episode.value?.dub_status)
      || panel.value === 'dubbing'
    return hasProgress ? 'active' : 'pending'
  }
  const done = sectionId === 'script'
    ? mainStageDone('script')
    : mainStageDone('assets') && mainStageDone('videos')
  if (done) return 'done'

  const hasProgress = sectionId === 'script'
    ? !!(rawContent.value || scriptContent.value)
    : !!(chars.value.length || scenes.value.length || propItems.value.length || sbs.value.length || shotVidCount.value)
  const isCurrent = sectionId === 'script'
    ? panel.value === 'script'
    : panel.value === 'production'
  return (hasProgress || isCurrent) ? 'active' : 'pending'
}

const activeMainStage = computed(() => {
  if (panel.value === 'export') return 'export'
  if (panel.value === 'dubbing') return 'dubbing'
  if (panel.value === 'production') {
    return prodTab.value === 'assets' ? 'assets' : 'videos'
  }
  return 'script'
})

function mainStageDone(stageId) {
  if (stageId === 'script') return !!scriptContent.value
  if (stageId === 'assets') return assetTotalCount.value > 0 && assetReadyCount.value === assetTotalCount.value
  if (stageId === 'videos') {
    return !!sbs.value.length && shotVidCount.value === sbs.value.length
  }
  if (stageId === 'dubbing') {
    return Boolean(dubSummary.value?.hasOutput) || episode.value?.dub_status === 'done'
  }
  if (stageId === 'export') return exportDone.value
  return false
}

function goMainStage(stageId) {
  if (stageId === 'script') {
    panel.value = 'script'
    scriptStep.value = Math.min(scriptStep.value, 1)
    return
  }
  if (stageId === 'assets') {
    panel.value = 'production'
    prodTab.value = 'assets'
    return
  }
  if (stageId === 'videos') {
    panel.value = 'production'
    prodTab.value = 'videos'
    return
  }
  if (stageId === 'dubbing') {
    panel.value = 'dubbing'
    return
  }
  panel.value = 'export'
}

const activeSubStepKey = computed(() => {
  if (panel.value === 'script') {
    if (scriptStep.value === 0) return 'script:raw'
    return 'script:rewrite'
  }
  if (panel.value === 'production') return `prod:${prodTab.value}`
  if (panel.value === 'dubbing') return `dub:${DUB_STEP_KEYS[dubStep.value] || 'lines'}`
  return 'export:merge'
})

// 步骤跑马灯：五段主流程（剧本 → 资产 → 视频 → 配音 → 导出），段点击跳转、当前段流动光效
const mainProgressSteps = computed(() => [
  { id: 'script', label: t('episode.stage.script') },
  { id: 'assets', label: t('episode.prod.assets') },
  { id: 'videos', label: t('episode.stage.videos') },
  { id: 'dubbing', label: t('episode.stage.dubbing') },
  { id: 'export', label: t('episode.stage.export') },
])
const currentMainIdx = computed(() => {
  const i = mainProgressSteps.value.findIndex(s => s.id === activeMainStage.value)
  return i < 0 ? 0 : i
})

function goSubStep(key) {
  if (key.startsWith('script:')) {
    panel.value = 'script'
    const stepMap = {
      'script:raw': 0,
      'script:rewrite': 1,
    }
    scriptStep.value = stepMap[key] ?? 0
    return
  }
  if (key.startsWith('prod:')) {
    panel.value = 'production'
    prodTab.value = key.replace('prod:', '')
    return
  }
  if (key.startsWith('dub:')) {
    panel.value = 'dubbing'
    const step = DUB_STEP_KEYS.indexOf(key.replace('dub:', ''))
    dubStep.value = step >= 0 ? step : 0
    return
  }
  panel.value = 'export'
}

const pipelineTotal = 2
const pipelineProgress = computed(() =>
  ['script', 'production'].filter(id => sectionState(id) === 'done').length
)

const currentStageLabel = computed(() => {
  if (panel.value === 'script') return t('episode.stage.scriptStage', { step: stepLabels.value[scriptStep.value] })
  if (panel.value === 'production') return t('episode.stage.prodStage', { step: prodTabDefs.value[prodTabIdx.value]?.label || t('episode.stage.production') })
  if (panel.value === 'dubbing') return t('episode.stage.dubStage', { step: dubStageLabel.value })
  return exportDone.value ? t('episode.stage.exportDone') : t('episode.stage.exportWaiting')
})

const dubStageLabel = computed(() => {
  const labels = [
    t('workbench.stepLines'),
    t('workbench.stepVoices'),
    t('workbench.stepGenerate'),
    t('workbench.stepPreview'),
    t('workbench.stepExport'),
  ]
  return labels[dubStep.value] || labels[0]
})

const currentMainStageLabel = computed(() => {
  const current = mainStageDefs.value.find(stage => stage.id === activeMainStage.value)
  return current?.label || t('episode.stage.workbench')
})

const currentSubStageLabel = computed(() => currentStageLabel.value)

const totalDuration = computed(() => sbs.value.reduce((s, sb) => s + (sb.duration || 10), 0))
const transitionOptions = computed(() => [
  { label: t('episode.sb.transitionCut'), value: 'cut' },
  { label: t('episode.sb.transitionFade'), value: 'fade' },
  { label: t('episode.sb.transitionDissolve'), value: 'dissolve' },
  { label: t('episode.sb.transitionWipe'), value: 'wipe' },
])
const selectedSb = ref(null)
const selectedVideoTaskNumber = computed(() => {
  const index = videoTaskRows.value.findIndex(task => String(task.id) === String(selectedSb.value?.id))
  return index >= 0 ? index + 1 : 0
})

// 同一分镜的更新串行发送并合并；失败重试耗尽后按服务端数据回滚界面
const {
  queue: queueStoryboardUpdate,
  hasPending: hasPendingStoryboardUpdates,
  flushPending: flushPendingStoryboardUpdates,
} = createStoryboardUpdateQueue({
  update: (id, payload) => storyboardAPI.update(id, payload),
  onError: e => toastError(e, { fallback: 'episode.sb.saveFailed' }),
  onRollback: resyncStoryboards,
})
async function resyncStoryboards() {
  const ep = episode.value
  if (!ep?.id) return
  try {
    sbs.value = await episodeAPI.storyboards(ep.id)
    const currentId = selectedSb.value?.id
    selectedSb.value = sbs.value.find(sb => sb.id === currentId) || sbs.value[0] || null
    try { chars.value = await episodeAPI.characters(ep.id) } catch {}
    try { scenes.value = await episodeAPI.scenes(ep.id) } catch {}
    try { propItems.value = await episodeAPI.props(ep.id) } catch {}
  } catch (error) {
    console.error('Failed to resync storyboards', error)
  }
}
function warnPendingStoryboardUpdates(event) {
  if (!hasPendingStoryboardUpdates()) return
  event.preventDefault()
  event.returnValue = ''
}

function updateField(sb, field, value) {
  const current = sb[field] ?? sb[toCamel(field)]
  if (current === value) return
  sb[field] = value
  const camelField = toCamel(field)
  if (camelField !== field) sb[camelField] = value
  queueStoryboardUpdate(sb.id, { [field]: value })
}

function toCamel(field) {
  return field.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function getStoryboardCharacterIds(sb) {
  return sb?.character_ids || sb?.characterIds || []
}

function getStoryboardCharacters(sb) {
  const ids = getStoryboardCharacterIds(sb)
  return bindableChars.value.filter(char => ids.includes(char.id))
}

function getStoryboardScene(sb) {
  const sceneId = sb?.scene_id || sb?.sceneId
  if (!sceneId) return null
  return bindableScenes.value.find(s => s.id === sceneId) || null
}

function isStoryboardCharacterSelected(sb, charId) {
  return getStoryboardCharacterIds(sb).includes(charId)
}

function toggleStoryboardCharacter(sb, charId) {
  const currentIds = getStoryboardCharacterIds(sb)
  const nextIds = currentIds.includes(charId)
    ? currentIds.filter(id => id !== charId)
    : [...currentIds, charId]
  updateField(sb, 'character_ids', nextIds)
}

function getStoryboardPropIds(sb) {
  return sb?.prop_ids || sb?.propIds || []
}

function getStoryboardProps(sb) {
  const ids = getStoryboardPropIds(sb)
  return bindableProps.value.filter(p => ids.includes(p.id))
}

function isStoryboardPropSelected(sb, propId) {
  return getStoryboardPropIds(sb).includes(propId)
}

function toggleStoryboardProp(sb, propId) {
  const currentIds = getStoryboardPropIds(sb)
  const nextIds = currentIds.includes(propId)
    ? currentIds.filter(id => id !== propId)
    : [...currentIds, propId]
  updateField(sb, 'prop_ids', nextIds)
}

function getSceneName(sb) {
  const scene = getStoryboardScene(sb)
  if (!scene) return ''
  return `${scene.location} · ${scene.time || t('episode.asset.noTime')}`
}

const sceneOptions = computed(() => [
  { label: t('episode.sb.unboundScene'), value: '' },
  ...scenes.value.map(s => ({ label: `${s.location} · ${s.time || t('episode.asset.noTime')}`, value: s.id })),
])


function sceneShotCount(sceneId) {
  return sbs.value.filter(sb => String(sb?.scene_id || sb?.sceneId || '') === String(sceneId)).length
}

watch(rawContent, v => { localRaw.value = v }, { immediate: true })
watch(scriptContent, v => { localScript.value = v }, { immediate: true })

async function refresh() {
  try {
    drama.value = await dramaAPI.get(dramaId)
    const ep = drama.value.episodes?.find(e => (e.episode_number || e.episodeNumber) === episodeNumber)
    if (ep) {
      episode.value = ep
      try { chars.value = await episodeAPI.characters(ep.id) } catch { chars.value = [] }
      try { scenes.value = await episodeAPI.scenes(ep.id) } catch { scenes.value = [] }
      try { propItems.value = await episodeAPI.props(ep.id) } catch { propItems.value = [] }
      sbs.value = await episodeAPI.storyboards(ep.id)
      selectedVideoSbIds.value = selectedVideoSbIds.value.filter(id => sbs.value.some(sb => sb.id === id))
      if (sbs.value.length) {
        const currentSelectedId = selectedSb.value?.id
        selectedSb.value = sbs.value.find(sb => sb.id === currentSelectedId) || sbs.value[0]
      } else {
        selectedSb.value = null
      }

      const epHasContent = !!(episode.value?.content)
      const epHasScript = !!(episode.value?.script_content || episode.value?.scriptContent)

      if (panelRestored) {
        // 已恢复到上次所在步骤，跳过自动重置（仅首次加载生效）
        panelRestored = false
      } else if (epHasScript || epHasContent) scriptStep.value = 1
      else scriptStep.value = 0
    }
  } catch (e) {
    toastError(e)
  }
  try { mergeData.value = await mergeAPI.status(epId.value) } catch {}
  await Promise.all([loadGenTasks(), loadExportMerges()])
}

function saveRaw() { episodeAPI.update(epId.value, { content: localRaw.value }); episode.value.content = localRaw.value }
function saveScr() { episodeAPI.update(epId.value, { script_content: localScript.value }); episode.value.script_content = localScript.value }
// 发给 Agent 的 message 是功能性提示词而非 UI 文案：产出语言由后端全局「内容语言」指令控制，
// 这里保持中文不随界面语言变化
// 流水线任务规则（设置 → 流程规则 可编辑）：手动改写/拆分与全自动流程共用同一份文本
const pipelineRules = ref({})
const DEFAULT_REWRITE_RULE = '请读取剧本并改写为格式化剧本，然后保存'
const DEFAULT_BREAKDOWN_RULE = `请基于当前集剧本拆分分镜，并为每个分镜段落同时生成 video_prompt（视频生成提示词）。
本次视频模型：{{videoModel}}，请按该模型的特性与时长限制生成 video_prompt。

项目已有角色：{{characters}}
项目已有场景：{{scenes}}
项目已有道具：{{props}}

绑定要求：
- 每个镜头必须根据剧本内容，从上述项目已有角色中选出出场的角色绑定 character_ids（ID 必须来自上述列表；有角色出场就必须绑定，不要遗漏）
- 每个镜头尽量匹配上述已有场景填写 scene_id（ID 必须来自上述列表），不要凭空创造新场景
- 每个镜头出现关键道具（被使用、交接、特写或在画面中明显可见）时，从上述项目已有道具中绑定 prop_ids（ID 必须来自上述列表）；没有道具出现可传空数组
- 上述素材可能来自同项目其他剧集，可直接复用；保存时会自动关联到当前集
- 只有纯环境空镜头才可以不绑定角色`

async function loadPipelineRules() {
  try {
    const list = await pipelineRuleAPI.list()
    pipelineRules.value = Object.fromEntries((list || []).map(rule => [rule.key, rule.rule]))
  } catch { /* 接口不可用时用内置兜底文案 */ }
}
function renderPipelineRule(key, vars = {}, fallback = '') {
  const template = String(pipelineRules.value?.[key] || fallback || '')
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, name) => {
    const value = vars[name]
    return value === undefined || value === null ? match : String(value)
  })
}

function doRewrite() { saveRaw(); runAgent('script_rewriter', renderPipelineRule('rewrite', {}, DEFAULT_REWRITE_RULE), dramaId, epId.value, refresh, chatModelOverride(), chatConfigId()) }
function skipRewrite() {
  const raw = (localRaw.value || rawContent.value || '').trim()
  if (!raw) {
    toast.warning(t('episode.script.rawRequired'))
    return
  }
  localScript.value = raw
  saveScr()
  toast.success(t('episode.script.skipDone'))
  panel.value = 'production'
  prodTab.value = 'assets'
}
// 资产提取：按类型独立的异步任务（后端任务表驱动），三类可并行；前端轮询状态直到完成
// label 渲染时求值（语言切换即时生效），key 为逻辑值
const EXTRACT_TARGETS = computed(() => [
  { key: 'characters', label: t('common.role') },
  { key: 'scenes', label: t('common.scene') },
  { key: 'props', label: t('common.prop') },
])
const extractingTargets = ref([])
const extractingLabels = computed(() => EXTRACT_TARGETS.value.filter(x => extractingTargets.value.includes(x.key)).map(x => x.label).join(t('common.listJoin')))
function isExtracting(target) { return extractingTargets.value.includes(target) }

function doExtract(target) {
  if (isExtracting(target) || !epId.value) return
  saveScr()
  extractingTargets.value.push(target)
  episodeAPI.extract(epId.value, target, chatModelOverride(), chatConfigId())
    .then(() => pollExtractStatus(target))
    .catch(e => {
      extractingTargets.value = extractingTargets.value.filter(x => x !== target)
      toastError(e)
    })
}
function doExtractAll() { EXTRACT_TARGETS.value.forEach(x => doExtract(x.key)) }

function pollExtractStatus(target, attempts = 150) {
  const label = EXTRACT_TARGETS.value.find(x => x.key === target)?.label || target
  const tick = async (left) => {
    try {
      const st = await episodeAPI.extractStatus(epId.value)
      const task = st?.[target]
      if (task && task.status !== 'running') {
        extractingTargets.value = extractingTargets.value.filter(x => x !== target)
        if (task.status === 'done') {
          toast.success(t('episode.extract.done', { type: label }))
          await refresh()
        } else {
          toastError(task.error, { fallback: 'episode.extract.failed' })
        }
        return
      }
    } catch {}
    if (left > 0) setTimeout(() => tick(left - 1), 2500)
    else extractingTargets.value = extractingTargets.value.filter(x => x !== target)
  }
  setTimeout(() => tick(attempts), 2500)
}

/** 页面加载后恢复仍在运行的提取任务状态（刷新页面不丢进度展示） */
async function syncExtractStatus() {
  if (!epId.value) return
  try {
    const st = await episodeAPI.extractStatus(epId.value)
    for (const x of EXTRACT_TARGETS.value) {
      if (st?.[x.key]?.status === 'running' && !isExtracting(x.key)) {
        extractingTargets.value.push(x.key)
        pollExtractStatus(x.key)
      }
    }
  } catch {}
  try {
    const vp = await episodeAPI.videoPromptsStatus(epId.value)
    if (vp?.status === 'running' && !videoPromptBatch.value.running) {
      videoPromptBatch.value = { running: true, total: vp.total || 0, completed: vp.completed || 0 }
      pollVideoPromptBatch()
    }
  } catch {}
}

// ─── 批量视频提示词：后端异步逐分镜生成，前端轮询进度 ──────────
const videoPromptBatch = ref({ running: false, total: 0, completed: 0 })
// 单个视频提示词生成：按分镜 ID 跟踪，允许不同分镜并行生成（不走全局 rn 锁）
const videoPromptGeneratingIds = ref([])
// 视频制作页多选快捷操作：全选 / 仅选未生成视频（勾选集与批量视频共用 selectedVideoSbIds）
function toggleSelectAllVideos() {
  selectedVideoSbIds.value = selectedVideoSbIds.value.length === sbs.value.length ? [] : sbs.value.map(sb => sb.id)
}
function selectMissingVideos() {
  selectedVideoSbIds.value = sbs.value.filter(sb => !hasVid(sb)).map(sb => sb.id)
}

async function batchVideoPrompts() {
  if (videoPromptBatch.value.running || !epId.value) return
  if (!sbs.value.length) { toast.warning(t('episode.sb.breakFirst')); return }
  // 选择模式下有勾选 → 仅补齐所选；否则全量补齐缺失
  const ids = (videoSelectMode.value && selectedVideoSbIds.value.length) ? [...selectedVideoSbIds.value] : undefined
  try {
    const res = await episodeAPI.generateVideoPrompts(epId.value, chatModelOverride(), chatConfigId(), ids)
    if (!res?.total) {
      if (res?.already_running) {
        videoPromptBatch.value = { running: true, total: 0, completed: 0 }
        pollVideoPromptBatch()
      } else toast.info(ids ? t('episode.sb.selectedMissing') : t('episode.sb.allHavePrompts'))
      return
    }
    videoPromptBatch.value = { running: true, total: res.total, completed: 0 }
    toast.info(t('episode.sb.batchStarted', { n: res.total }))
    pollVideoPromptBatch()
  } catch (e) {
    toastError(e)
  }
}

function pollVideoPromptBatch(attempts = 240) {
  const tick = async (left) => {
    try {
      const st = await episodeAPI.videoPromptsStatus(epId.value)
      if (st && st.status !== 'running') {
        videoPromptBatch.value = { running: false, total: 0, completed: 0 }
        await refresh()
        if (st.status === 'done') {
          toast.success(st.failed ? t('episode.sb.batchDoneFailed', { n: st.failed }) : t('episode.sb.batchDone'))
        } else {
          toastError(st.error, { fallback: 'episode.sb.batchFailed' })
        }
        return
      }
      if (st) {
        const prev = videoPromptBatch.value.completed
        videoPromptBatch.value = { running: true, total: st.total || 0, completed: st.completed || 0 }
        if ((st.completed || 0) !== prev) await refresh() // 每完成一条刷新，提示词逐步出现
      }
    } catch {}
    if (left > 0) setTimeout(() => tick(left - 1), 2500)
    else videoPromptBatch.value = { running: false, total: 0, completed: 0 }
  }
  setTimeout(() => tick(attempts), 2500)
}
function doBreakdown() {
  const charList = bindableChars.value.length
    ? bindableChars.value.map(c => `${c.name}(ID:${c.id})`).join('、')
    : '（项目还没有角色）'
  const sceneList = bindableScenes.value.length
    ? bindableScenes.value.map(s => `${s.location} · ${s.time || '未设时间'}(ID:${s.id})`).join('、')
    : '（项目还没有场景）'
  const propList = bindableProps.value.length
    ? bindableProps.value.map(p => `${p.name}(ID:${p.id})`).join('、')
    : '（项目还没有道具）'
  runAgent('storyboard_breaker', renderPipelineRule('storyboards', {
    videoModel: effectiveVideoModelLabel.value,
    characters: charList,
    scenes: sceneList,
    props: propList,
  }, DEFAULT_BREAKDOWN_RULE), dramaId, epId.value, onBreakdownDone, chatModelOverride(), chatConfigId(), (ok) => {
    if (!ok) void refresh()
  })
}

/** 拆分完成后刷新并自动补齐缺失的视频提示词（兜住 Agent 漏写/截断） */
async function onBreakdownDone() {
  await refresh()
  const missing = sbs.value.filter(sb => !(sb.video_prompt || sb.videoPrompt || '').trim())
  if (missing.length) batchVideoPrompts()
}

// 按需为单个分镜生成视频提示词：由 prompt_generator 读取分镜字段生成并保存到 video_prompt
async function genVideoPrompt(sb) {
  if (!sb || videoPromptGeneratingIds.value.includes(sb.id)) return
  const idx = sbs.value.indexOf(sb) + 1
  const cfg = selectedVideoConfig.value
  const label = cfg ? `${cfg.name} (${cfg.provider})` : '默认'
  const charNames = getStoryboardCharacters(sb).map(c => c.name).join('、') || '无'
  const propNames = getStoryboardProps(sb).map(p => p.name).join('、') || '无'
  videoPromptGeneratingIds.value.push(sb.id)
  try {
    await api.post(`/agent/prompt_generator/chat`, {
      message: `请为分镜 #${idx}(ID:${sb.id})生成视频提示词(video_prompt)。视频模型:${label},请根据该模型的特性和时长限制生成。

该分镜信息:时长 ${sb.duration || 10}s;场景:${getSceneName(sb) || '未绑定'};角色:${charNames};道具:${propNames}。

请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围及时长,据此生成 video_prompt(按 3 秒分段换行、用 @角色名/@场景名/@道具名 引用参考素材；段落内允许多镜头切镜,但不跨场景,切镜点对齐 description 的【镜头N】结构),然后调用 update_storyboard 保存到分镜 ID:${sb.id}。只更新 video_prompt 字段,不要改动其他字段,不要重新拆分整集。`,
      drama_id: dramaId,
      episode_id: epId.value,
      model: chatModelOverride() || undefined,
      config_id: chatConfigId() || undefined,
    })
    toast.success(t('episode.sb.promptGenerated', { n: idx }))
    await refresh()
  } catch (e) {
    toastError(e)
  } finally {
    videoPromptGeneratingIds.value = videoPromptGeneratingIds.value.filter(id => id !== sb.id)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function watchAsyncResult(check, attempts = 24, delay = 2500, onTimeout = null) {
  void (async () => {
    for (let i = 0; i < attempts; i++) {
      await sleep(delay)
      await refresh()
      if (check()) return
    }
    // 轮询到期也必须收尾：清掉 pending，避免按钮永久停在“生成中”
    await refresh()
    onTimeout?.()
  })()
}

async function genCharImg(id) {
  try {
    if (!isPendingCharImage(id)) pendingCharImageIds.value.push(id)
    const char = chars.value.find(c => c.id === id)
    if (char && !(char.final_prompt || char.finalPrompt)) {
      toast.info(t('episode.asset.generatingPrompt'))
      try {
        await ensureAssetPrompt('character', id)
      } catch {} // 提示词生成失败不阻断：后端生图前会再兜底生成或回退本地拼接
    }
    await characterAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId(), assetRefs(char))
    toast.success(t('episode.image.generatingChar'))
    await refresh()
    watchAsyncResult(() => {
      const char = chars.value.find(c => c.id === id)
      const done = !!(char?.image_url || char?.imageUrl)
      if (done) pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
      return done
    }, 48, 2500, () => {
      pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
      toast.warning(t('episode.image.genTimeout'))
    })
  } catch (e) {
    pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
    toastError(e)
  }
}
function batchCharImages() {
  const ids = visualChars.value.filter(c => !(c.image_url || c.imageUrl)).map(c => c.id)
  if (!ids.length) { toast.info(t('episode.image.allCharsDone')); return }
  pendingCharImageIds.value = [...new Set([...pendingCharImageIds.value, ...ids])]
  characterAPI.batchImages(ids, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId()).then(async () => {
    toast.success(t('episode.image.batchGeneratingChar'))
    await refresh()
    watchAsyncResult(() => ids.every(id => {
      const char = chars.value.find(c => c.id === id)
      const done = !!(char?.image_url || char?.imageUrl)
      if (done) pendingCharImageIds.value = pendingCharImageIds.value.filter(item => item !== id)
      return done
    }), 72, 2500, () => {
      pendingCharImageIds.value = pendingCharImageIds.value.filter(item => !ids.includes(item))
      toast.warning(t('episode.image.genTimeout'))
    })
  }).catch(e => {
    pendingCharImageIds.value = pendingCharImageIds.value.filter(item => !ids.includes(item))
    toastError(e)
  })
}
async function genSceneImg(id) {
  try {
    if (!isPendingSceneImage(id)) pendingSceneImageIds.value.push(id)
    const scene = scenes.value.find(s => s.id === id)
    if (scene && !(scene.final_prompt || scene.finalPrompt)) {
      toast.info(t('episode.asset.generatingPrompt'))
      try {
        await ensureAssetPrompt('scene', id)
      } catch {} // 提示词生成失败不阻断：后端生图前会再兜底生成或回退本地拼接
    }
    await sceneAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId(), assetRefs(scene))
    toast.success(t('episode.image.generatingScene'))
    await refresh()
    watchAsyncResult(() => {
      const scene = scenes.value.find(s => s.id === id)
      const done = !!(scene?.image_url || scene?.imageUrl)
      if (done) pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== id)
      return done
    }, 48, 2500, () => {
      pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== id)
      toast.warning(t('episode.image.genTimeout'))
    })
  } catch (e) {
    pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== id)
    toastError(e)
  }
}
function isPendingPropImage(id) {
  return pendingPropImageIds.value.includes(id)
}
async function genPropImg(id) {
  try {
    if (!isPendingPropImage(id)) pendingPropImageIds.value.push(id)
    const prop = propItems.value.find(p => p.id === id)
    if (prop && !(prop.final_prompt || prop.finalPrompt)) {
      toast.info(t('episode.asset.generatingPrompt'))
      try {
        await ensureAssetPrompt('prop', id)
      } catch {} // 提示词生成失败不阻断：后端生图前会再兜底生成或回退本地拼接
    }
    await propAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId(), assetRefs(prop))
    toast.success(t('episode.image.generatingProp'))
    await refresh()
    watchAsyncResult(() => {
      const prop = propItems.value.find(p => p.id === id)
      const done = !!(prop?.image_url || prop?.imageUrl)
      if (done) pendingPropImageIds.value = pendingPropImageIds.value.filter(item => item !== id)
      return done
    }, 48, 2500, () => {
      pendingPropImageIds.value = pendingPropImageIds.value.filter(item => item !== id)
      toast.warning(t('episode.image.genTimeout'))
    })
  } catch (e) {
    pendingPropImageIds.value = pendingPropImageIds.value.filter(item => item !== id)
    toastError(e)
  }
}
function batchSceneImages() {
  const ids = scenes.value.filter(s => !(s.image_url || s.imageUrl)).map(s => s.id)
  if (!ids.length) { toast.info(t('episode.image.allScenesDone')); return }
  pendingSceneImageIds.value = [...new Set([...pendingSceneImageIds.value, ...ids])]
  ids.forEach(id => { sceneAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId()).then(() => refresh()).catch(e => toastError(e)) })
  toast.success(t('episode.image.batchGeneratingScene'))
  watchAsyncResult(() => ids.every(id => {
    const scene = scenes.value.find(s => s.id === id)
    const done = !!(scene?.image_url || scene?.imageUrl)
    if (done) pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => item !== id)
    return done
  }), 72, 2500, () => {
    pendingSceneImageIds.value = pendingSceneImageIds.value.filter(item => !ids.includes(item))
    toast.warning(t('episode.image.genTimeout'))
  })
}
function batchPropImages() {
  const ids = propItems.value.filter(p => !(p.image_url || p.imageUrl)).map(p => p.id)
  if (!ids.length) { toast.info(t('episode.image.allPropsDone')); return }
  pendingPropImageIds.value = [...new Set([...pendingPropImageIds.value, ...ids])]
  ids.forEach(id => { propAPI.generateImage(id, epId.value, bareModelName(imageModel.value) || undefined, ownerConfigId(imageModelOptions.value, imageModel.value), chatModelOverride(), chatConfigId()).then(() => refresh()).catch(e => toastError(e)) })
  toast.success(t('episode.image.batchGeneratingProp'))
  watchAsyncResult(() => ids.every(id => {
    const prop = propItems.value.find(p => p.id === id)
    const done = !!(prop?.image_url || prop?.imageUrl)
    if (done) pendingPropImageIds.value = pendingPropImageIds.value.filter(item => item !== id)
    return done
  }), 72, 2500, () => {
    pendingPropImageIds.value = pendingPropImageIds.value.filter(item => !ids.includes(item))
    toast.warning(t('episode.image.genTimeout'))
  })
}
function getVideoUrl(s) { return s?.video_url || s?.videoUrl || s?.composed_video_url || s?.composedVideoUrl || null }
function hasVid(s) { return !!getVideoUrl(s) }

// ===== 分镜视频历史（一个分镜可能生成多个视频,sys_task 留存全部记录）=====
const sbVideoHistory = ref([])
const previewVideoUrl = ref('') // 空表示当前分镜；历史视频可以是本地路径或远程 URL
const playerLoadFailed = ref(false)
function videoSourceUrl(value) {
  if (!value) return ''
  return /^https?:\/\//i.test(value) ? value : '/' + value.replace(/^\/+/, '')
}
// 未保存完成的新结果先在线播放；下载完成后 refresh 回写的本地视频自动接替。
// 不把临时签名 URL 写入分镜主视频，避免影响本地拼接导出。
const playerVideoUrl = computed(() => {
  if (previewVideoUrl.value) return videoSourceUrl(previewVideoUrl.value)
  const task = latestVideoTask(selectedSb.value?.id)
  const pendingResult = task && task.status !== 'completed' ? taskVideoPath(task) : ''
  return videoSourceUrl(pendingResult || getVideoUrl(selectedSb.value))
})
const playerIsRemote = computed(() => /^https?:\/\//i.test(playerVideoUrl.value))
watch(playerVideoUrl, () => { playerLoadFailed.value = false })

// 注意:/tasks 返回原始行(camelCase),/episodes/:id/generation-tasks 返回 snake_case,两种命名都兼容
function taskVideoPath(t) { return t?.local_path || t?.localPath || t?.result_url || t?.resultUrl || '' }
function taskCreatedAt(t) { return t?.created_at || t?.createdAt || '' }
function isCurrentVideo(t) { const p = taskVideoPath(t); return !!p && p === getVideoUrl(selectedSb.value) }

async function loadSbVideoHistory() {
  previewVideoUrl.value = ''
  if (!selectedSb.value?.id) { sbVideoHistory.value = []; return }
  try {
    const rows = await taskAPI.list({ type: 'video', storyboard_id: selectedSb.value.id })
    sbVideoHistory.value = (Array.isArray(rows) ? rows : [])
      .filter(t => t.status === 'completed' && taskVideoPath(t))
      .sort((a, b) => taskCreatedAt(b).localeCompare(taskCreatedAt(a)))
  } catch { sbVideoHistory.value = [] }
}

watch(() => [selectedSb.value?.id, getVideoUrl(selectedSb.value)], () => { loadSbVideoHistory() })

function previewHistoryVideo(t) {
  previewVideoUrl.value = isCurrentVideo(t) ? '' : taskVideoPath(t)
}

async function setAsMainVideo() {
  const sb = selectedSb.value
  if (!sb || !previewVideoUrl.value || playerIsRemote.value) return
  try {
    await storyboardAPI.update(sb.id, { video_url: previewVideoUrl.value })
    sb.video_url = previewVideoUrl.value
    sb.videoUrl = previewVideoUrl.value
    toast.success(t('episode.vid.setMainDone'))
  } catch (e) { toastError(e, { fallback: 'episode.vid.setMainFailed' }) }
}

async function removeHistoryVideo(t) {
  try {
    await taskAPI.del(t.id)
    sbVideoHistory.value = sbVideoHistory.value.filter(x => x.id !== t.id)
    if (previewVideoUrl.value === taskVideoPath(t)) previewVideoUrl.value = ''
    toast.success(t('episode.vid.historyDeleted'))
  } catch (e) { toastError(e, { fallback: 'common.deleteFailed' }) }
}

function formatHistoryTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function getShotReferenceImages(sb) {
  const refs = []
  const pushRef = (value) => {
    if (!value || refs.includes(value) || refs.length >= refImageLimit.value) return
    refs.push(value)
  }
  const scene = getStoryboardScene(sb)
  pushRef(scene?.image_url || scene?.imageUrl)
  for (const char of getStoryboardCharacters(sb)) {
    pushRef(char?.image_url || char?.imageUrl)
  }
  for (const prop of getStoryboardProps(sb)) {
    pushRef(prop?.image_url || prop?.imageUrl)
  }
  return refs
}

// 右侧参考素材面板：本集全部可绑定素材（场景单选、角色/道具多选），bound 标记是否已绑定
// kind 为英文 code（逻辑值）；typeLabel 为显示名（渲染时求值）
function shotBindableAssets(sb) {
  const out = []
  for (const char of bindableChars.value) {
    const imageUrl = char.image_url || char.imageUrl || ''
    out.push({
      key: `character-${char.id}`,
      id: char.id,
      kind: 'character',
      typeLabel: t('common.role'),
      name: char.name || t('episode.asset.unnamedChar'),
      meta: char.role || t('episode.asset.charPortrait'),
      imageUrl,
      ready: !!imageUrl,
      linked: episodeCharacterIdSet.value.has(char.id),
      bound: getStoryboardCharacterIds(sb).includes(char.id),
    })
  }
  for (const scene of bindableScenes.value) {
    const imageUrl = scene.image_url || scene.imageUrl || ''
    out.push({
      key: `scene-${scene.id}`,
      id: scene.id,
      kind: 'scene',
      typeLabel: t('common.scene'),
      name: `${scene.location} · ${scene.time || t('episode.asset.noTime')}`,
      meta: scene.time || t('episode.asset.sceneImage'),
      imageUrl,
      ready: !!imageUrl,
      linked: episodeSceneIdSet.value.has(scene.id),
      bound: (sb?.scene_id || sb?.sceneId) === scene.id,
    })
  }
  for (const prop of bindableProps.value) {
    const imageUrl = prop.image_url || prop.imageUrl || ''
    out.push({
      key: `prop-${prop.id}`,
      id: prop.id,
      kind: 'prop',
      typeLabel: t('common.prop'),
      name: prop.name || t('episode.asset.unnamedProp'),
      meta: prop.type || t('episode.asset.propSingleImage'),
      imageUrl,
      ready: !!imageUrl,
      linked: episodePropIdSet.value.has(prop.id),
      bound: getStoryboardPropIds(sb).includes(prop.id),
    })
  }
  // 固定顺序（角色→场景→道具，按资产原顺序）：点击绑定/解绑不重排，避免跳动
  return out
}

// 右侧参考素材面板渲染用：当前分镜可绑定的全部素材
const refBindableAssets = computed(() => {
  const sb = selectedSb.value
  return sb ? shotBindableAssets(sb) : []
})

// 右栏「绑定参考图」：当前分镜已绑定素材（生成时作为参考图提交），按分组顺序平铺展示
const boundRefAssets = computed(() => refBindableAssets.value.filter(a => a.bound))

// 参考面板分组顺序（kind code 驱动，label 渲染时求值）
const REF_KINDS = computed(() => ([
  { kind: 'character', label: t('common.role'), hint: t('episode.ref.multiSelect') },
  { kind: 'scene', label: t('common.scene'), hint: t('episode.ref.singleSelect') },
  { kind: 'prop', label: t('common.prop'), hint: t('episode.ref.multiSelect') },
]))

// 绑定其他剧集素材时，同步补进本集资产列表；后端保存分镜时会自动补 episode 关联
function linkBoundAssetToEpisode(asset) {
  if (asset.linked) return
  const target = asset.kind === 'character' ? chars.value : asset.kind === 'scene' ? scenes.value : propItems.value
  if (target.some(item => item.id === asset.id)) return
  const source = asset.kind === 'character' ? bindableChars.value : asset.kind === 'scene' ? bindableScenes.value : bindableProps.value
  const raw = source.find(item => item.id === asset.id)
  if (raw) target.push(raw)
}

// 右侧面板切换绑定：场景单选（切换/解绑），角色/道具多选（kind code 判断，不依赖显示文案）
function toggleShotBind(sb, asset) {
  if (!asset.bound) linkBoundAssetToEpisode(asset)
  if (asset.kind === 'scene') {
    const current = sb?.scene_id || sb?.sceneId
    updateField(sb, 'scene_id', current === asset.id ? null : asset.id)
    return
  }
  if (asset.kind === 'character') {
    toggleStoryboardCharacter(sb, asset.id)
    return
  }
  toggleStoryboardProp(sb, asset.id)
}

// 视频提示词 @ 引用候选：仅当前分镜已绑定的角色与道具（按名字引用）、场景（按地点引用），展示顺序：角色 → 场景 → 道具
// kind 为逻辑值（MentionTextarea 按 kind 着色/选图标），group 为显示文案
const mentionOptions = computed(() => {
  const sb = selectedSb.value
  if (!sb) return []
  const scene = getStoryboardScene(sb)
  return [
    ...getStoryboardCharacters(sb).map(c => ({
      label: c.name,
      value: c.name,
      kind: 'character',
      group: t('common.role'),
      image: thumbOf(assetImageSrc(c)),
    })),
    ...getStoryboardCharacters(sb).filter(c => c.voice_audio_url || c.voiceAudioUrl).map(c => ({
      label: c.name,
      value: c.name,
      aliases: [`${c.name}音色`],
      trigger: '#',
      kind: 'voice',
      group: t('characterVoice.title'),
    })),
    ...(scene ? [{
      label: `${scene.location} · ${scene.time || t('episode.asset.noTime')}`,
      value: scene.location,
      kind: 'scene',
      group: t('common.scene'),
      image: thumbOf(assetImageSrc(scene)),
    }] : []),
    ...getStoryboardProps(sb).map(p => ({
      label: p.name,
      value: p.name,
      kind: 'prop',
      group: t('common.prop'),
      image: thumbOf(assetImageSrc(p)),
    })),
  ]
})

// 按参考图顺序（场景图在前、角色图居中、道具图在后）为 @名字 建立索引映射，供视频提示词引用替换
function getShotReferenceIndexMap(sb) {
  const ordered = []
  const seen = new Set()
  const push = (name, url) => {
    if (!url || seen.has(url) || ordered.length >= refImageLimit.value) return
    seen.add(url)
    ordered.push({ name, imageUrl: url })
  }
  const scene = getStoryboardScene(sb)
  push(scene?.location || '', scene?.image_url || scene?.imageUrl)
  for (const char of getStoryboardCharacters(sb)) {
    push(char.name || '', char?.image_url || char?.imageUrl)
  }
  for (const prop of getStoryboardProps(sb)) {
    push(prop.name || '', prop?.image_url || prop?.imageUrl)
  }
  const nameToIndex = {}
  ordered.forEach((a, i) => { if (a.name && !(a.name in nameToIndex)) nameToIndex[a.name] = i + 1 })
  return nameToIndex
}

// 将视频提示词里的 @名字 替换为 @图片N名字（N 为参考图序号，1 起），生成时使用
function resolveVideoPromptRefs(sb) {
  const prompt = sb.video_prompt || sb.videoPrompt || ''
  const map = getShotReferenceIndexMap(sb)
  const names = Object.keys(map).sort((a, b) => b.length - a.length)
  if (!names.length) return prompt
  return prompt.replace(/@([^\s@#]+)/g, (m, raw) => {
    for (const name of names) {
      if (raw.startsWith(name)) {
        return `@图片${map[name]}${name}${raw.slice(name.length)}`
      }
    }
    return m
  })
}

// 分镜时长（视频生成参数区直接编辑并保存到分镜）：
// 统一限制 2-30s，列表/批量/单次生成统一读取该值；超出厂商支持范围由后端适配器收敛
function onVideoDurationChange(e) {
  const sb = selectedSb.value
  if (!sb) return
  const min = 2
  const max = 30
  let v = Math.round(Number(e.target.value))
  if (!Number.isFinite(v)) v = Number(sb.duration || 10)
  v = Math.min(max, Math.max(min, v))
  e.target.value = v
  updateField(sb, 'duration', v)
}

function pickFile(accept, cb) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.onchange = () => { const f = input.files?.[0]; if (f) cb(f) }
  input.click()
}

function pickFiles(accept, cb) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.multiple = true
  input.onchange = () => {
    const files = Array.from(input.files || [])
    if (files.length) cb(files)
  }
  input.click()
}

// ===== 资产参考图（生成条件图：参与生成，但不替换资产成图）=====
const MAX_ASSET_REFS = 6

function parseAssetRefs(value) {
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

function assetRefs(item) {
  return parseAssetRefs(item?.reference_images ?? item?.referenceImages)
}

function assetRefSrc(value) {
  const raw = String(value || '')
  if (!raw) return ''
  // data URL 不能被当成站内相对路径再拼一次 /
  if (/^(https?:\/\/|data:)/i.test(raw) || raw.startsWith('/')) return raw
  return `/${raw}`
}

const uploadingRefKeys = ref([])
function isUploadingAssetRef(kind, id) {
  return uploadingRefKeys.value.includes(`${kind}:${id}`)
}

async function persistAssetRefs(type, item, next) {
  const payload = { reference_images: next }
  if (type === 'character') await characterAPI.update(item.id, payload)
  else if (type === 'scene') await sceneAPI.update(item.id, payload)
  else await propAPI.update(item.id, payload)
  const stored = next.length ? JSON.stringify(next) : null
  const apply = (target) => {
    if (!target) return
    target.reference_images = stored
    target.referenceImages = stored
  }
  apply(item)
  const list = type === 'character' ? chars.value : type === 'scene' ? scenes.value : propItems.value
  apply(list.find(entry => entry.id === item.id))
}

function addAssetReferences(type, item) {
  if (!item?.id) return
  const key = `${type}:${item.id}`
  const existing = assetRefs(item)
  const room = MAX_ASSET_REFS - existing.length
  if (room <= 0) {
    toast.info(t('episode.asset.refLimit'))
    return
  }
  pickFiles('image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp', async (files) => {
    if (uploadingRefKeys.value.includes(key)) return
    uploadingRefKeys.value.push(key)
    try {
      const uploaded = []
      for (const file of files.slice(0, room)) {
        try {
          const res = await uploadAPI.image(file, dramaId)
          uploaded.push(res.path)
        } catch (error) {
          toastError(error)
        }
      }
      if (!uploaded.length) return
      await persistAssetRefs(type, item, [...existing, ...uploaded])
      toast.success(t('episode.asset.refAdded'))
    } catch (error) {
      toastError(error)
    } finally {
      uploadingRefKeys.value = uploadingRefKeys.value.filter(entry => entry !== key)
    }
  })
}

async function removeAssetReference(type, item, index) {
  if (!item?.id) return
  const next = assetRefs(item).filter((_, i) => i !== index)
  try {
    await persistAssetRefs(type, item, next)
    toast.success(t('episode.asset.refRemoved'))
  } catch (error) {
    toastError(error)
  }
}

// ===== 资产图片手动上传（角色形象 / 场景图 / 道具图）=====
// 上传类型显示名渲染时求值
const assetUploadLabelMap = computed(() => ({
  character: t('episode.asset.charPortrait'),
  scene: t('episode.asset.sceneImage'),
  prop: t('episode.asset.propImage'),
}))
const uploadingAssetKeys = ref([])
function isUploadingAsset(kind, id) { return uploadingAssetKeys.value.includes(`${kind}:${id}`) }
function uploadAssetImage(kind, id) {
  pickFile('image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp', async (file) => {
    const key = `${kind}:${id}`
    if (!uploadingAssetKeys.value.includes(key)) uploadingAssetKeys.value.push(key)
    try {
      const res = await uploadAPI.image(file, dramaId)
      // 与生图回写保持一致：存相对路径（static/...），前端展示时补前导斜杠
      const payload = { image_url: res.path, local_path: res.path }
      if (kind === 'character') await characterAPI.update(id, payload)
      else if (kind === 'scene') await sceneAPI.update(id, payload)
      else await propAPI.update(id, payload)
      toast.success(t('episode.upload.assetDone', { type: assetUploadLabelMap.value[kind] || '' }))
      await refresh()
    } catch (e) {
      toastError(e)
    } finally {
      uploadingAssetKeys.value = uploadingAssetKeys.value.filter(k => k !== key)
    }
  })
}

async function genVid(sb, opts = {}) {
  if (isComfyVideoMode.value) {
    if (!opts.silent) toast.warning(t('episode.comfy.nativeOnly'))
    return
  }
  if (!opts.forceNew && canRecoverVideo(sb.id)) return recoverVideo(sb)
  const latest = latestVideoTask(sb.id)
  const forceNew = opts.forceNew || latest?.status === 'failed'
  if (forceNew && !window.confirm(t('episode.recovery.confirmNew'))) return
  const referenceImages = getShotReferenceImages(sb)
  const audioMode = episodeVideoAudioMode.value
  // 分镜若已生成首/尾帧则走 fl2v；尾帧必须与首帧成对，避免后端拒绝
  const firstFrameImage = sb.first_frame_image || sb.firstFrameImage
  const lastFrameImage = sb.last_frame_image || sb.lastFrameImage
  // 参考素材完全来自分镜绑定的角色/场景/道具图片
  const params = {
    storyboard_id: sb.id,
    drama_id: dramaId,
    prompt: resolveVideoPromptRefs(sb),
    duration: Number(sb.duration || 10),
    aspect_ratio: dramaAspectRatio.value,
    generate_audio: audioMode !== 'ambient' && audioMode !== 'silent',
    audio_mode: audioMode === 'ambient' || audioMode === 'silent' ? audioMode : 'native',
    model: bareModelName(videoModel.value) || undefined,
    config_id: ownerConfigId(videoModelOptions.value, videoModel.value),
    reference_image_urls: referenceImages,
  }
  if (firstFrameImage) params.first_frame_url = firstFrameImage
  if (firstFrameImage && lastFrameImage) params.last_frame_url = lastFrameImage
  if (!params.prompt && !referenceImages.length) {
    toast.error(t('episode.vid.needRefOrPrompt'))
    return
  }
  try {
    delete failedVideoMessages.value[sb.id]
    if (!isPendingVideo(sb.id)) pendingVideoIds.value.push(sb.id)
    const generation = await taskAPI.generate({ type: 'video', ...params, force_new: !!forceNew })
    if (!opts.silent) toast.success(t('episode.vid.generating'))
    await refresh()
    pollVideoGeneration(generation?.id, sb.id)
  } catch (e) {
    pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== sb.id)
    failedVideoMessages.value = {
      ...failedVideoMessages.value,
      [sb.id]: e.message || t('episode.vid.genFailed'),
    }
    toastError(e, { fallback: 'episode.vid.genFailed' })
  }
}
async function pollVideoGeneration(generationId, storyboardId) {
  if (!generationId) {
    watchAsyncResult(() => {
      const target = sbs.value.find(s => s.id === storyboardId)
      const done = !!(target?.video_url || target?.videoUrl)
      if (done) pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
      return done
    }, 60, 4000)
    return
  }
  for (let i = 0; i < 120; i++) {
    await sleep(4000)
    try {
      const res = await taskAPI.get(generationId)
      await refresh()
      if (res?.status === 'completed') {
        pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
        delete failedVideoMessages.value[storyboardId]
        toast.success(t('episode.vid.genDone'))
        return
      }
      if (res?.status === 'failed') {
        pendingVideoIds.value = pendingVideoIds.value.filter(item => item !== storyboardId)
        const errMsg = res?.error_msg || res?.errorMsg || t('episode.vid.genFailed')
        failedVideoMessages.value = {
          ...failedVideoMessages.value,
          [storyboardId]: errMsg,
        }
        toastError(errMsg, { fallback: 'episode.vid.genFailed' })
        return
      }
    } catch {}
  }
  // 页面等待结束不代表上游失败；后续由任务列表轮询继续跟踪。
  await loadGenTasks()
}
function mergeDownloadName(m) {
  const base = String(m?.title || '').replace(/[\\/:*?"<>|]+/g, '_').trim()
  return `${base || t('episode.export.untitled')}.mp4`
}
const transitionBoundaries = computed(() => transitionState.value.boundaries || [])
function summarizeTransitionBoundaries(boundaries) {
  const summary = {
    total: boundaries.length, ready: 0, missing: 0, pending: 0, processing: 0, failed: 0, skipped: 0,
  }
  for (const item of boundaries) {
    if (item.status === 'completed' && !item.stale && item.video_url) summary.ready++
    else if (item.status === 'skipped') summary.skipped++
    else if (item.status === 'failed') summary.failed++
    else if (item.status === 'processing') summary.processing++
    else if (item.status === 'pending') summary.pending++
    else summary.missing++
  }
  return summary
}
const transitionBoundaryIndex = computed(() => {
  const index = new Map()
  for (const boundary of transitionBoundaries.value) {
    index.set(transitionPromptKey(boundary), boundary)
  }
  return index
})
function storyboardNumberOf(sb) {
  const value = Number(sb?.storyboard_number ?? sb?.storyboardNumber)
  return Number.isFinite(value) && value > 0 ? value : 0
}
function transitionBoundaryForPair(fromId, toId) {
  const existing = transitionBoundaryIndex.value.get(`${fromId}-${toId}`)
  if (existing) return existing
  const from = sbs.value.find(sb => sb.id === fromId)
  const to = sbs.value.find(sb => sb.id === toId)
  return {
    id: null,
    index: 0,
    from_storyboard_id: fromId,
    to_storyboard_id: toId,
    from_number: storyboardNumberOf(from) || '?',
    to_number: storyboardNumberOf(to) || '?',
    status: 'missing',
    enabled: true,
    stale: false,
    supported: transitionSupported.value,
    prompt: null,
    prompt_source: null,
    video_url: null,
    first_frame_url: null,
    last_frame_url: null,
    duration_requested: null,
    duration_effective: null,
    duration_actual: null,
    audio_mode: null,
    provider: null,
    model: null,
    sys_task_id: null,
    error_msg: null,
    completed_at: null,
  }
}
/** 按勾选镜头的相邻顺序取断点；跨镜勾选时也要能对齐历史片段。 */
function transitionBoundariesFor(ids) {
  const wanted = new Set(ids || [])
  const ordered = sbs.value
    .filter(sb => wanted.has(sb.id) && hasVid(sb))
    .sort((a, b) => storyboardNumberOf(a) - storyboardNumberOf(b) || a.id - b.id)
  const boundaries = []
  for (let i = 1; i < ordered.length; i++) {
    boundaries.push(transitionBoundaryForPair(ordered[i - 1].id, ordered[i].id))
  }
  return boundaries
}
const exportTransitionBoundaries = computed(() => transitionBoundariesFor(exportSelectedReadyIds.value))
const transitionSummary = computed(() => summarizeTransitionBoundaries(exportTransitionBoundaries.value))
const allTransitionSummary = computed(() => summarizeTransitionBoundaries(transitionBoundaries.value))
const transitionProvider = computed(() => transitionState.value.provider)
const transitionBusy = computed(() =>
  (allTransitionSummary.value.pending || 0) + (allTransitionSummary.value.processing || 0) > 0)
const transitionSupported = computed(() => transitionProvider.value?.first_last_frame === true)
const mergeDialogBoundaries = computed(() => transitionBoundariesFor(mergeDialog.value.ids))
const mergeDialogReadyCount = computed(() =>
  mergeDialogBoundaries.value.filter(b => b.status === 'completed' && !b.stale).length)
const mergeDialogSelectedCount = computed(() => selectedBoundaryPayload().length)
const transitionCards = computed(() =>
  transitionBoundaries.value
    .filter(b => b.id != null)
    .sort((a, b) => (Number(a.from_number) || 0) - (Number(b.from_number) || 0)
      || (Number(a.to_number) || 0) - (Number(b.to_number) || 0)))
const transitionDetailBoundary = computed(() => {
  if (!transitionDetail.value.open) return null
  return transitionBoundaries.value.find(b => b.id === transitionDetail.value.id) || null
})
const transitionDeleteBoundary = computed(() =>
  transitionBoundaries.value.find(b => b.id === transitionDelete.value.id) || null)
const transitionDeletePair = computed(() =>
  transitionDeleteBoundary.value ? transitionPairLabel(transitionDeleteBoundary.value) : '')

function transitionPairLabel(boundary) {
  return t('episode.export.aiTransition.pair', {
    from: boundary?.from_number ?? '?',
    to: boundary?.to_number ?? '?',
  })
}
function transitionStatusLabel(boundary) {
  if (boundary?.status === 'completed' && boundary?.stale) return t('episode.export.aiTransition.status.stale')
  return t(`episode.export.aiTransition.status.${boundary?.status || 'missing'}`)
}
function transitionStatusClass(boundary) {
  if (boundary?.status === 'completed' && !boundary?.stale) return 'ok'
  if (boundary?.stale || boundary?.status === 'failed') return 'failed'
  if (boundary?.status === 'processing' || boundary?.status === 'pending') return 'pending'
  return 'idle'
}
function isMergeBoundarySelected(boundary) {
  return mergeDialog.value.selectedBoundaries.includes(transitionPromptKey(boundary))
}
function toggleMergeBoundary(boundary) {
  const key = transitionPromptKey(boundary)
  const selected = new Set(mergeDialog.value.selectedBoundaries)
  if (selected.has(key)) selected.delete(key)
  else selected.add(key)
  mergeDialog.value = {
    ...mergeDialog.value,
    selectedBoundaries: [...selected],
    boundariesTouched: true,
  }
}
function selectedBoundaryPayload() {
  if (!mergeDialog.value.open) return []
  return mergeDialogBoundaries.value
    .filter(item => isMergeBoundarySelected(item))
    .map(item => ({
      from_storyboard_id: item.from_storyboard_id,
      to_storyboard_id: item.to_storyboard_id,
    }))
}
function openTransitionDetail(boundary) {
  if (!boundary?.id) return
  transitionDetail.value = { open: true, id: boundary.id }
  const key = transitionPromptKey(boundary)
  if (!(key in transitionPromptDrafts.value) || !transitionPromptDirty.value[key]) {
    transitionPromptDrafts.value = {
      ...transitionPromptDrafts.value,
      [key]: String(boundary.prompt || ''),
    }
  }
}
function closeTransitionDetail() {
  transitionDetail.value = { open: false, id: null }
}
function askDeleteTransition(boundary) {
  if (!boundary?.id) return
  transitionDelete.value = { open: true, loading: false, id: boundary.id }
}
async function confirmDeleteTransition() {
  const id = transitionDelete.value.id
  if (!id) return
  transitionDelete.value = { ...transitionDelete.value, loading: true }
  try {
    await transitionAPI.del(id)
    toast.success(t('episode.export.aiTransition.deleted'))
    transitionDelete.value = { open: false, loading: false, id: null }
    if (transitionDetail.value.id === id) closeTransitionDetail()
    await loadTransitions()
  } catch (e) {
    toastError(e, { fallback: 'episode.export.aiTransition.deleteFailed' })
    transitionDelete.value = { ...transitionDelete.value, loading: false }
  }
}
function openTransitionPreview(boundary) {
  if (!boundary?.video_url) return
  previewShot.value = {
    id: `transition-${boundary.id}`,
    video_url: boundary.video_url,
    duration: Number(boundary.duration_actual) || null,
    previewLabel: t('episode.export.aiTransition.previewTitle', {
      from: boundary.from_number,
      to: boundary.to_number,
    }),
    downloadName: `transition-S${boundary.from_number}-S${boundary.to_number}.mp4`,
  }
}
function transitionDurationLabel(boundary) {
  const actual = Number(boundary?.duration_actual)
  if (Number.isFinite(actual) && actual > 0) return `${actual.toFixed(2)}s`
  const effective = Number(boundary?.duration_effective)
  if (Number.isFinite(effective) && effective > 0) {
    return t('episode.export.aiTransition.effectiveDuration', { dur: effective })
  }
  return ''
}
function stopTransitionPolling() {
  if (transitionTimer) { clearInterval(transitionTimer); transitionTimer = null }
}
function applyTransitionData(data) {
  transitionState.value = {
    loading: false,
    boundaries: data?.boundaries || [],
    provider: data?.provider || null,
  }
  syncTransitionPromptDrafts()
}
async function loadTransitions() {
  if (!epId.value) return
  const seq = ++transitionRequestSeq
  try {
    const data = await transitionAPI.list(epId.value)
    if (seq !== transitionRequestSeq) return
    applyTransitionData(data)
    scheduleTransitionPoll(seq)
  } catch (e) {
    if (seq !== transitionRequestSeq) return
    transitionState.value = { ...transitionState.value, loading: false }
    toastError(e, { fallback: 'episode.export.aiTransition.loadFailed' })
  }
}
function scheduleTransitionPoll(seq) {
  stopTransitionPolling()
  if (!transitionBusy.value) return
  // 离开导出页后旧轮询不再复活
  if (panel.value !== 'export') return
  transitionTimer = setInterval(async () => {
    if (seq !== transitionRequestSeq) { stopTransitionPolling(); return }
    try {
      const data = await transitionAPI.list(epId.value)
      if (seq !== transitionRequestSeq) return
      applyTransitionData(data)
      if (!transitionBusy.value) stopTransitionPolling()
    } catch { /* 下一轮继续 */ }
  }, 3000)
}
function transitionTargetCount(ids, boundaries = null) {
  const selected = boundaries
    ? new Set(boundaries.map(item => `${item.from_storyboard_id}-${item.to_storyboard_id}`))
    : null
  return transitionBoundariesFor(ids).filter(b =>
    (!selected || selected.has(transitionPromptKey(b)))
    && (b.status === 'missing' || b.status === 'failed' || (b.status === 'completed' && b.stale)))
    .length
}
async function prepareTransitionsFor(ids, options = {}) {
  if (transitionPreparing.value || !epId.value) return
  if (!transitionSupported.value) {
    toast.error(t('episode.export.aiTransition.unsupported'))
    return
  }
  const boundaries = Array.isArray(options.boundaries) ? options.boundaries : null
  if (boundaries && boundaries.length === 0) {
    toast.warning(t('episode.export.aiTransition.needBoundary'))
    return
  }
  const targets = transitionTargetCount(ids, boundaries)
  if (targets > 0 && !window.confirm(t('episode.export.aiTransition.costHint', { n: targets }))) return
  transitionPreparing.value = true
  try {
    const result = await transitionAPI.prepare(epId.value, {
      storyboard_ids: ids,
      mode: 'missing',
      duration: options.duration || 3,
      audio_mode: options.audioMode || 'ambient',
      ...(boundaries ? { boundaries } : {}),
      ...transitionTextModelPayload(),
    })
    await loadTransitions()
    const failedCount = Number(result?.failed || 0)
    const createdCount = Number(result?.created || 0)
    if (failedCount > 0) {
      const message = String(result?.failures?.[0]?.message || t('episode.export.aiTransition.actionFailed'))
      if (createdCount === 0) toast.error(message)
      else toast.warning(t('episode.export.aiTransition.partialFailed', { n: failedCount, message }))
    } else {
      toast.success(t('episode.export.aiTransition.prepared'))
    }
  } catch (e) {
    toastError(e, { fallback: 'episode.export.aiTransition.actionFailed' })
  } finally {
    transitionPreparing.value = false
  }
}
async function generateMissingTransitions() {
  const ids = mergeDialog.value.open ? mergeDialog.value.ids : exportSelectedReadyIds.value
  const boundaries = mergeDialog.value.open ? selectedBoundaryPayload() : null
  await prepareTransitionsFor(ids, {
    duration: mergeDialog.value.duration,
    audioMode: mergeDialog.value.audioMode,
    boundaries,
  })
}
async function retryTransitionItem(boundary) {
  if (!boundary?.id || transitionPreparing.value) return
  transitionPreparing.value = true
  try {
    await transitionAPI.retry(boundary.id, transitionTextModelPayload())
    toast.success(t('episode.export.aiTransition.retried'))
    await loadTransitions()
  } catch (e) {
    toastError(e, { fallback: 'episode.export.aiTransition.actionFailed' })
  } finally {
    transitionPreparing.value = false
  }
}
async function skipTransitionItem(boundary) {
  if (!boundary?.id || transitionPreparing.value) return
  transitionPreparing.value = true
  try {
    await transitionAPI.skip(boundary.id)
    toast.success(t('episode.export.aiTransition.skippedToast'))
    await loadTransitions()
  } catch (e) {
    toastError(e, { fallback: 'episode.export.aiTransition.actionFailed' })
  } finally {
    transitionPreparing.value = false
  }
}
function transitionPromptKey(boundary) {
  return `${boundary?.from_storyboard_id}-${boundary?.to_storyboard_id}`
}
function toggleTransitionPrompt(boundary) {
  const key = transitionPromptKey(boundary)
  if (transitionPromptOpen.value[key]) {
    transitionPromptOpen.value = { ...transitionPromptOpen.value, [key]: false }
    return
  }
  if (!(key in transitionPromptDrafts.value) || !transitionPromptDirty.value[key]) {
    transitionPromptDrafts.value = {
      ...transitionPromptDrafts.value,
      [key]: String(boundary?.prompt || ''),
    }
  }
  transitionPromptOpen.value = { ...transitionPromptOpen.value, [key]: true }
}
function syncTransitionPromptDrafts() {
  const next = { ...transitionPromptDrafts.value }
  const detailKey = transitionDetailBoundary.value
    ? transitionPromptKey(transitionDetailBoundary.value)
    : ''
  for (const boundary of transitionBoundaries.value) {
    const key = transitionPromptKey(boundary)
    if ((transitionPromptOpen.value[key] || key === detailKey) && !transitionPromptDirty.value[key]) {
      next[key] = String(boundary?.prompt || '')
    }
  }
  transitionPromptDrafts.value = next
}
function markTransitionPromptDirty(boundary) {
  const key = transitionPromptKey(boundary)
  transitionPromptDirty.value = { ...transitionPromptDirty.value, [key]: true }
  if (transitionPromptAnalyzed.value[key]) {
    const next = { ...transitionPromptAnalyzed.value }
    delete next[key]
    transitionPromptAnalyzed.value = next
  }
}
function markTransitionPromptClean(boundary) {
  const key = transitionPromptKey(boundary)
  const dirty = { ...transitionPromptDirty.value }
  delete dirty[key]
  transitionPromptDirty.value = dirty
  const analyzed = { ...transitionPromptAnalyzed.value }
  delete analyzed[key]
  transitionPromptAnalyzed.value = analyzed
}
function transitionPromptEffectiveSource(boundary) {
  const key = transitionPromptKey(boundary)
  if (key && transitionPromptAnalyzed.value[key]) return 'ai'
  return boundary?.prompt_source || null
}
function transitionPromptSourceLabel(boundary) {
  const source = transitionPromptEffectiveSource(boundary)
  if (source === 'ai' || source === 'fallback' || source === 'manual') {
    return t(`episode.export.aiTransition.prompt.source.${source}`)
  }
  return t('episode.export.aiTransition.prompt.source.none')
}
function transitionPromptSourceClass(boundary) {
  return `source-${transitionPromptEffectiveSource(boundary) || 'none'}`
}
function transitionTextModelPayload() {
  const configId = chatConfigId()
  const model = chatModelOverride()
  return {
    ...(configId ? { text_config_id: configId } : {}),
    ...(model ? { text_model: model } : {}),
  }
}
function setTransitionPromptBusy(key, value) {
  transitionPromptBusy.value = { ...transitionPromptBusy.value, [key]: value }
}
function transitionPromptDraftOf(boundary) {
  return String(transitionPromptDrafts.value[transitionPromptKey(boundary)] ?? '').trim()
}
async function analyzeTransitionItem(boundary) {
  const key = transitionPromptKey(boundary)
  if (!boundary?.id || transitionPromptBusy.value[key]) return
  const draftAtStart = transitionPromptDraftOf(boundary)
  setTransitionPromptBusy(key, true)
  try {
    const result = await transitionAPI.analyze(boundary.id, transitionTextModelPayload())
    if (transitionPromptDraftOf(boundary) !== draftAtStart) {
      toast.warning(t('episode.export.aiTransition.prompt.draftKept'))
      return
    }
    transitionPromptDrafts.value = { ...transitionPromptDrafts.value, [key]: String(result?.prompt || '') }
    transitionPromptDirty.value = { ...transitionPromptDirty.value, [key]: true }
    transitionPromptAnalyzed.value = { ...transitionPromptAnalyzed.value, [key]: true }
    toast.success(t('episode.export.aiTransition.prompt.analyzeDone'))
  } catch (e) {
    toastError(e, { fallback: 'episode.export.aiTransition.actionFailed' })
  } finally {
    setTransitionPromptBusy(key, false)
  }
}
async function saveTransitionPromptItem(boundary) {
  const key = transitionPromptKey(boundary)
  if (!boundary?.id || transitionPromptBusy.value[key]) return
  const prompt = transitionPromptDraftOf(boundary)
  if (!prompt) {
    toast.error(t('episode.export.aiTransition.prompt.empty'))
    return
  }
  setTransitionPromptBusy(key, true)
  try {
    await transitionAPI.savePrompt(boundary.id, prompt)
    if (transitionPromptDraftOf(boundary) === prompt) markTransitionPromptClean(boundary)
    toast.success(t('episode.export.aiTransition.prompt.saved'))
    await loadTransitions()
  } catch (e) {
    toastError(e, { fallback: 'episode.export.aiTransition.actionFailed' })
  } finally {
    setTransitionPromptBusy(key, false)
  }
}
async function regenerateTransitionWithPrompt(boundary) {
  const key = transitionPromptKey(boundary)
  if (!boundary?.id || transitionPromptBusy.value[key]) return
  const prompt = transitionPromptDraftOf(boundary)
  if (!prompt) {
    toast.error(t('episode.export.aiTransition.prompt.empty'))
    return
  }
  setTransitionPromptBusy(key, true)
  try {
    await transitionAPI.retry(boundary.id, { prompt, ...transitionTextModelPayload() })
    if (transitionPromptDraftOf(boundary) === prompt) markTransitionPromptClean(boundary)
    toast.success(t('episode.export.aiTransition.retried'))
    await loadTransitions()
  } catch (e) {
    toastError(e, { fallback: 'episode.export.aiTransition.actionFailed' })
  } finally {
    setTransitionPromptBusy(key, false)
  }
}

function openMergeDialog() {
  if (!exportSelectedReadyIds.value.length) {
    toast.error(t('episode.export.selectFirst'))
    return
  }
  const ids = [...exportSelectedReadyIds.value]
  mergeDialog.value = {
    open: true,
    ids,
    title: t('episode.export.defaultTitle', { n: episodeNumber }),
    useAiTransitions: transitionSummary.value.ready > 0,
    useAiTransitionsTouched: false,
    selectedBoundaries: transitionBoundariesFor(ids).map(transitionPromptKey),
    boundariesTouched: false,
    duration: 3,
    audioMode: 'ambient',
  }
  void loadTransitions().then(() => {
    if (!mergeDialog.value.boundariesTouched) {
      mergeDialog.value.selectedBoundaries = mergeDialogBoundaries.value.map(transitionPromptKey)
    }
    if (mergeDialog.value.useAiTransitionsTouched) return
    mergeDialog.value.useAiTransitions = transitionSupported.value && mergeDialogReadyCount.value > 0
  })
}
function confirmMerge() {
  const ids = [...mergeDialog.value.ids]
  const title = mergeDialog.value.title.trim()
  const useAiTransitions = mergeDialog.value.useAiTransitions && transitionSupported.value
  mergeDialog.value.open = false
  void doMerge(ids, title, useAiTransitions)
}
async function doMerge(ids, title, useAiTransitions = false) {
  const storyboardIds = Array.isArray(ids) ? ids : undefined
  if (storyboardIds && !storyboardIds.length) {
    toast.error(t('episode.export.selectFirst'))
    return
  }
  try {
    await mergeAPI.merge(epId.value, storyboardIds, title, useAiTransitions)
    toast.success(t('episode.export.mergingToast'))
  } catch (e) {
    toastError(e, { fallback: 'episode.export.mergeFailed' })
    return
  }
  const poll = setInterval(async () => {
    try { mergeData.value = await mergeAPI.status(epId.value) } catch {}
    if (mergeData.value?.status === 'completed' || mergeData.value?.status === 'failed') {
      clearInterval(poll)
      if (mergeData.value.status === 'completed') {
        toast.success(t('episode.export.mergeDone'))
        loadExportMerges()
      } else {
        toastError(mergeData.value?.error_msg || mergeData.value?.errorMsg, { fallback: 'episode.export.mergeFailed' })
      }
    }
  }, 3000)
}
async function deleteMerge(m) {
  if (!m?.id) return
  if (!window.confirm(t('episode.export.deleteConfirm', { title: m.title || t('episode.export.untitled') }))) return
  try {
    await mergeAPI.del(m.id)
    if (activeMerge.value?.id === m.id) activeMerge.value = null
    toast.success(t('episode.export.deleted'))
    await loadExportMerges()
  } catch (e) {
    toastError(e, { fallback: 'episode.export.deleteFailed' })
  }
}
async function loadConfigs() {
  try {
    const [imgCfgs, vidCfgs, txtCfgs] = await Promise.all([
      aiConfigAPI.list('image'),
      aiConfigAPI.list('video'),
      aiConfigAPI.list('text'),
    ])
    imageConfigs.value = imgCfgs || []
    videoConfigs.value = vidCfgs || []
    textConfigs.value = txtCfgs || []
  } catch (e) { console.error('Failed to load AI configs', e) }
}

watch(panel, (current) => {
  if (current !== 'export') {
    transitionRequestSeq++
    stopTransitionPolling()
    return
  }
  void loadTransitions()
}, { immediate: true })

onMounted(async () => {
  await refresh()
  loadConfigs()
  syncExtractStatus()
  loadPipelineRules()
  loadDubbingEnabled()
  loadDirectorMode()
  if (isComfyVideoMode.value) {
    void loadComfyPreview()
    void loadComfyUiSession()
  }
})

// ===== 应用内引导（工作台）：沿左侧进度栏走 6 步流水线 =====
const EPISODE_TOUR = [
  { element: '.studio-topbar-main', titleKey: 'tour.episode.topbar.title', descKey: 'tour.episode.topbar.desc', popoverSide: 'bottom' },
  { element: '.pipe-section:nth-of-type(1)', titleKey: 'tour.episode.script.title', descKey: 'tour.episode.script.desc', popoverSide: 'right' },
  { element: '.pipe-section:nth-of-type(2)', titleKey: 'tour.episode.assets.title', descKey: 'tour.episode.assets.desc', popoverSide: 'right' },
  { element: '.pipe-section:nth-of-type(2) .pipe-item:last-child', titleKey: 'tour.episode.videos.title', descKey: 'tour.episode.videos.desc', popoverSide: 'right' },
  { element: '.studio-actions .tour-help-btn', titleKey: 'tour.episode.help.title', descKey: 'tour.episode.help.desc', popoverSide: 'bottom', popoverAlign: 'end' },
]
onMounted(() => setTimeout(() => autoTour('episode', EPISODE_TOUR, t), 900))
</script>

<style scoped>
.voice-reference-hint {
  margin: 8px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-2);
}
/* ===== Studio Layout ===== */
.studio {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  padding: 8px;
  gap: 8px;
  background: var(--surface-base);
  /* 选中态:中性反色(浅色近黑/深色近白),与进行中(蓝脉冲)/已完成(绿勾)区分,
     遵循「颜色只承担状态指示」——选中不是状态,保持无色 */
  --sel: var(--text-0);
  --sel-bg: var(--bg-active);
  --sel-text: var(--text-0);
  --sel-glow: var(--bg-hover);
}

.episode-topbar.studio-topbar {
  flex-shrink: 0;
  background: var(--surface-soft);
}
.episode-topbar :deep(.studio-topbar-left) { flex: 0 1 auto; }
.episode-topbar :deep(.studio-topbar-center) { flex: 1 1 auto; min-width: 0; justify-content: center; }
.episode-topbar :deep(.studio-topbar-right) { flex: 0 0 auto; }

.studio-topbar-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.sidebar,
.main {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
}

/* 用更高特异性压过后面的 .back-btn{height:40px}，保持顶栏紧凑 */
.studio-topbar .topbar-back {
  width: auto;
  min-width: 0;
  height: var(--control-sm);
  padding: 0 10px;
  gap: 6px;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-1);
  font-size: var(--text-meta);
  font-weight: 600;
  white-space: nowrap;
}
.studio-topbar .topbar-back:hover {
  background: var(--bg-hover);
  color: var(--text-0);
}
.studio-topbar .topbar-back:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.studio-identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
}

.studio-title {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-strong);
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: -0.02em;
}

.studio-episode-chip {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-bg);
  color: var(--accent-text-strong);
  font-size: var(--text-micro);
  font-weight: 700;
  white-space: nowrap;
}

.studio-meta-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  min-width: 0;
}

.studio-meta-pill {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-bg);
  color: var(--accent-text-strong);
  font-size: var(--text-micro);
  font-weight: 600;
  white-space: nowrap;
}

.studio-meta-pill.is-stage {
  background: var(--accent-bg);
  color: var(--accent-text-strong);
}
.studio-meta-pill.is-progress {
  background: var(--success-bg);
  color: var(--success);
}
.studio-meta-inline {
  font-size: var(--text-meta);
  color: var(--text-2);
  font-weight: 600;
  white-space: nowrap;
}

.studio-model-picks {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.studio-model-picks::-webkit-scrollbar { display: none; }
.studio-model-picks > * { flex: 0 0 auto; }

.studio-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
}
.studio-topbar .btn {
  height: var(--control-sm);
  padding: 0 10px;
  font-size: var(--text-meta);
  white-space: nowrap;
}
.studio-topbar .btn-icon {
  width: var(--control-sm);
  padding: 0;
}

@media (max-width: 1360px) {
  .studio-meta-inline { display: none; }
}

.studio-body {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);  /* 列宽跟随侧栏实际宽度（收起时 46px） */
  gap: 8px;
  min-height: 0;
  flex: 1;
}

/* ===== Sidebar ===== */
.sidebar {
  width: 208px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  border-radius: var(--radius);
}
.back-btn {
  min-width: 40px; width: auto; height: 40px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  gap: 6px;
  padding: 0 12px;
  border: none; border-radius: var(--radius-pill);
  background: var(--overlay-track); color: var(--text-1);
  cursor: pointer; transition: all 0.18s var(--ease-out);
  font-size: 12px;
  font-weight: 650;
  line-height: 1;
}
.back-btn:hover {
  background: var(--bg-active);
  color: var(--text-0);
}
.back-btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

/* Pipeline Nav */
.pipeline { flex: 1; overflow-y: auto; padding: 12px 10px 8px; display: flex; flex-direction: column; gap: 8px; }
.pipe-section { display: flex; flex-direction: column; gap: 2px; }
.pipe-section-label {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 700; color: var(--text-2);
  text-transform: uppercase; letter-spacing: 0.06em;
  padding: 0 7px 2px;
}
/* 分组标题保持中性灰,状态色只在左侧小指示器上 */
.pipe-section-state {
  width: 13px; height: 13px; border-radius: 999px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
}
.pipe-section.is-done .pipe-section-state {
  background: var(--success-bg); color: var(--success);
  border: 1px solid var(--success-bg);
}
.pipe-section-dot {
  width: 5px; height: 5px; border-radius: 999px;
  background: var(--text-3); opacity: 0.55;
}
.pipe-section-pulse {
  width: 6px; height: 6px; border-radius: 999px;
  background: var(--accent);
  animation: pipeSectionPulse 1.6s var(--ease-out) infinite;
}
@keyframes pipeSectionPulse {
  0% { box-shadow: 0 0 0 0 var(--accent-glow); }
  70% { box-shadow: 0 0 0 5px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.pipe-section-tag {
  font-size: 11px; font-weight: 600; letter-spacing: 0.03em;
  color: var(--text-2); background: var(--bg-2);
  border-radius: 999px; padding: 1px 5px;
  text-transform: none;
}
/* 子步骤进行中:与大环节同步的脉冲点 */
.pipe-item.doing { color: var(--text-1); }
.pipe-item.doing .pipe-icon {
  background: var(--accent-bg);
  border-color: var(--accent-glow);
}
.pipe-item-pulse {
  width: 6px; height: 6px; border-radius: 999px;
  background: var(--accent);
  animation: pipeSectionPulse 1.6s var(--ease-out) infinite;
}
.pipe-item {
  position: relative;
  display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius);
  font-size: 13.5px; font-weight: 600;
  background: transparent; border: 1px solid transparent; color: var(--text-2); cursor: pointer;
  transition: all 0.18s var(--ease-out); width: 100%; text-align: left;
}
.pipe-item:hover {
  background: var(--bg-hover);
  border-color: transparent;
  color: var(--text-0);
}
.pipe-item.active {
  background: var(--sel-bg);
  color: var(--sel-text);
  border-color: transparent;
  box-shadow: none;
}
/* ChatFire 签名：激活步骤左侧 3px 品牌色圆角指示条 */
.pipe-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 9px;
  bottom: 9px;
  width: 3px;
  border-radius: 999px;
  background: var(--accent);
}
.pipe-item:focus-visible {
  outline: none;
  border-color: var(--action-primary);
  box-shadow: var(--focus-ring), var(--button-shadow);
}
.pipe-item.done { color: var(--text-2); }
.pipe-item-sub {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  padding: var(--row-pad-y) 8px;
  position: relative;
  min-height: var(--row-h);
}

.pipe-item-sub:not(:last-child)::after {
  content: '';
  position: absolute;
  left: 15px;
  top: 23px;
  bottom: -6px;
  width: 1px;
  background: var(--border);
}

.pipe-icon {
  width: 16px; height: 16px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-2); border: 1px solid var(--border);
  color: var(--text-3); flex-shrink: 0; transition: all 0.15s;
  position: relative;
  z-index: 1;
}
.pipe-item.active .pipe-icon { background: var(--sel); border-color: var(--sel); color: var(--surface-raised); }
.pipe-item.done .pipe-icon { background: var(--success-bg); border-color: var(--success-bg); color: var(--success); }
.pipe-item.active.done .pipe-icon { background: var(--sel); border-color: var(--sel); color: var(--surface-raised); }
.icon-active { background: var(--sel) !important; border-color: var(--sel) !important; color: var(--surface-raised) !important; }
.icon-done { background: var(--success-bg) !important; border-color: var(--success-bg) !important; color: var(--success) !important; }
.pipe-item.active.done .icon-done { background: var(--sel) !important; border-color: var(--sel) !important; color: var(--surface-raised) !important; }

.pipe-label { flex: 1; font-size: 12px; }
.pipe-copy { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pipe-sub {
  display: none;
  font-size: 11px;
  line-height: 1.35;
  color: var(--text-2);
  font-weight: 500;
}
.pipe-badge {
  font-size: 11px; font-weight: 700; padding: 1px 5px;
  border-radius: 99px; background: var(--bg-3); color: var(--text-2);
  font-family: var(--font-mono);
}
.pipe-badge.badge-done { background: var(--success-bg); color: var(--success); }
.pipe-spinner { width: 10px; height: 10px; border: 1.5px solid var(--accent-bg); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }

/* Sidebar Bottom */
.sidebar-bottom {
  padding: 9px 10px 10px;
  border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 7px;
  flex-shrink: 0;
  background: var(--surface-soft);
}
/* 收起/展开按钮 */
.sidebar-toggle {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  width: 100%; min-height: 22px;
  border: none; border-radius: 6px;
  background: transparent; color: var(--text-3);
  font: 600 11px var(--font-body);
  cursor: pointer; transition: background 0.14s, color 0.14s;
}
.sidebar-toggle:hover { background: var(--bg-hover); color: var(--text-0); }
.sidebar-toggle-icon { transition: transform 0.22s var(--ease-out); flex-shrink: 0; }
.sidebar.collapsed .sidebar-toggle-icon { transform: rotate(180deg); }

/* ===== 收起态：窄图标栏 ===== */
.sidebar { transition: width 0.22s var(--ease-out); }
.sidebar.collapsed { width: 46px; }
.sidebar.collapsed .pipeline { padding: 12px 5px 8px; gap: 10px; }
.sidebar.collapsed .pipe-section-label { justify-content: center; padding: 0 0 2px; }
.sidebar.collapsed .pipe-section-label > span:not(.pipe-section-state) { display: none; }
.sidebar.collapsed .pipe-item {
  grid-template-columns: auto; justify-content: center;
  padding: 6px 0; min-height: 0;
}
.sidebar.collapsed .pipe-item .pipe-copy { display: none; }
.sidebar.collapsed .pipe-item-sub:not(:last-child)::after { display: none; }
.sidebar.collapsed .pipe-icon { width: 22px; height: 22px; }
/* 收起态：进行中步骤的角标脉冲点 */
.pipe-mini-pulse {
  position: absolute; top: -3px; right: -3px;
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--accent);
  border: 1.5px solid var(--surface-raised);
  animation: pipeSectionPulse 1.6s var(--ease-out) infinite;
}
.sidebar.collapsed .sidebar-progress { display: none; }
.sidebar.collapsed .sidebar-bottom { padding: 9px 6px 10px; align-items: center; }
.sidebar.collapsed .refresh-btn { width: 28px; min-height: 28px; padding: 0; font-size: 0; gap: 0; }
/* 步骤跑马灯：四段主流程进度条，当前段流动光效 */
.sidebar-progress {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 2px 2px 4px;
}
.sidebar-progress-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.sidebar-progress-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-1);
}
.sidebar-progress-count {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
}
.sidebar-progress-track {
  display: flex;
  gap: 4px;
}
.sidebar-progress-seg {
  position: relative;
  flex: 1;
  height: 5px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--overlay-track);
  cursor: pointer;
  overflow: hidden;
  transition: background 0.2s var(--ease-out), transform 0.15s var(--ease-out);
}
.sidebar-progress-seg:hover { transform: scaleY(1.6); }
.sidebar-progress-seg:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.sidebar-progress-seg.done { background: var(--success); }
.sidebar-progress-seg.current { background: var(--accent-bg); }
/* 跑马灯流动光：当前段内的渐变高光持续滑动 */
.sidebar-progress-seg.current .sidebar-progress-seg-fill {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg,
    var(--accent) 0%,
    color-mix(in srgb, var(--accent) 30%, #fff 70%) 50%,
    var(--accent) 100%);
  background-size: 220% 100%;
  animation: seg-marquee 1.5s linear infinite;
}
.sidebar-progress-seg:not(.current) .sidebar-progress-seg-fill { display: none; }
@keyframes seg-marquee {
  from { background-position: 220% 0; }
  to { background-position: -220% 0; }
}
.sidebar-progress-labels {
  display: flex;
  gap: 4px;
}
.sidebar-progress-labels span {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-size: 11px;
  color: var(--text-2);
}
.sidebar-progress-labels span.done { color: var(--success); }
.sidebar-progress-labels span.on {
  color: var(--accent-text);
  font-weight: 700;
}
.refresh-btn {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 28px;
  padding: 0 10px; font-size: 12.5px; font-weight: 650; color: var(--button-text);
  background: var(--button-bg); border: 1px solid var(--button-border); border-radius: var(--button-radius);
  cursor: pointer; transition: all 0.18s var(--ease-out);
  box-shadow: var(--button-shadow);
}
.refresh-btn:hover {
  background: var(--button-bg-hover);
  border-color: var(--button-border-hover);
  color: var(--button-text-hover);
  box-shadow: var(--button-shadow-hover);
}
.refresh-btn:focus-visible {
  outline: none;
  border-color: var(--action-primary);
  box-shadow: var(--focus-ring), var(--button-shadow-hover);
}

/* ===== Main Content ===== */
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; min-height: 0; border-radius: var(--radius); }
.content-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; min-height: 0; }
.director-pane { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.stage-subnav {
  align-self: flex-start;
  margin: 4px 12px 0;
  max-width: calc(100% - 24px);
  overflow-x: auto;
  flex-shrink: 0;
}
.stage-subnav-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  /* 压过全局 .seg-item{padding:7px 16px}，收紧子导航高度 */
  padding: 4px 13px;
  font-size: 12px;
}
.stage-subnav-item.active {
  background: var(--seg-active-bg);
  color: var(--text-0);
  box-shadow: 0 1px 4px rgba(0,0,0,0.12);
}
.stage-subnav-item.done {
  color: var(--text-1);
}
.stage-subnav-item.active.done {
  color: var(--text-0);
}
.stage-subnav-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--success);
}

/* Toolbar */
.step-toolbar {
  display: flex; align-items: center; gap: 10px;
  min-height: 44px;
  padding: 8px 12px; border-bottom: 1px solid var(--border);
  background: var(--surface-raised); flex-shrink: 0;
}
.prod-toolbar { background: var(--surface-raised); }
.toolbar-left { display: flex; align-items: center; gap: 8px; flex: 1; }
.toolbar-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.step-indicator { display: flex; align-items: center; gap: 8px; }
.step-num {
  width: 26px; height: 26px; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--accent-bg);
  font-family: var(--font-mono); font-size: 12px; font-weight: 800; color: var(--accent-text); letter-spacing: 0.05em;
}
.step-name { font-size: 13.5px; font-weight: 700; color: var(--text-1); font-family: var(--font-display); }
.char-count { font-size: 11px; color: var(--text-2); font-family: var(--font-mono); }

/* Editor Area */
.step-editor { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.fill-textarea {
  flex: 1; border: none; border-radius: 0; padding: 26px 28px;
  font-size: 13.5px; line-height: 1.9; resize: none; outline: none;
  font-family: var(--font-body); background: var(--bg-input); color: var(--text-0);
}
.fill-textarea:focus-visible { box-shadow: var(--focus-ring); }

/* Step Empty State */
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
.step-empty-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: center; }

/* Step Loading */
.step-loading {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; gap: 12px;
}
.loading-text { font-size: 13px; color: var(--text-2); }

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
/* 视频列表选择模式快捷操作：复用分段芯片样式，去掉顶部虚线分隔 */
.video-quick-actions { margin: 0 12px 10px; padding-top: 0; border-top: none; }
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
  color: var(--text-2);
  letter-spacing: 0.02em;
  padding: 0 2px;
}
.storyboard-ref-scope-hint {
  margin: 2px 0 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-2);
}
.storyboard-ref-scope {
  display: inline-block;
  margin-left: 5px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--surface-outline);
  color: var(--text-2);
  font-size: 11px;
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
  font-size: 11px;
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
  padding: var(--row-pad-y) 7px;
  min-height: var(--row-h);
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
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
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
  font-size: 11px;
  color: var(--text-2);
}
.storyboard-ref-state.is-ready { color: var(--success); }
.storyboard-ref-meta {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.storyboard-ref-empty {
  padding: 14px 10px;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
  border: 1px dashed var(--surface-outline);
  border-radius: var(--radius);
}
.detail-panel { flex: 1; display: flex; flex-direction: column; overflow-y: auto; min-width: 0; }
.detail-head { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.detail-head-copy { display: flex; flex-direction: column; gap: 2px; }
.detail-head-title { font-size: 14px; font-weight: 700; color: var(--text-0); }
.detail-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
.detail-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(220px, 0.9fr);
  gap: 12px;
  padding: 12px;
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  border: 1px solid var(--border);
}
.detail-hero-copy { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.detail-hero-label {
  font-size: 10px; font-weight: 700; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--text-3);
}
.detail-hero-text { font-size: 13px; color: var(--text-1); line-height: 1.7; }
.detail-status-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.detail-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  border: 1px solid var(--border);
}
.detail-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.detail-section-title { font-size: 12px; font-weight: 700; color: var(--text-0); }
.detail-section-copy { font-size: 11px; color: var(--text-2); }

/* Field */
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 500; color: var(--text-1); }
.field-row { display: flex; gap: 12px; }
.field-grid { display: grid; gap: 12px; }
.field-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.field-grid-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.locked-config {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--surface-muted);
  border: 1px solid var(--surface-outline);
  color: var(--text-1);
  font-size: 11px;
  font-weight: 600;
}
.locked-config-banner {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-2);
}

/* Production tabs */
.prod-tabs { display: flex; gap: 4px; background: var(--bg-2); border-radius: var(--radius); padding: 2px; }
.prod-tab {
  display: flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 10px; font-size: 11px;
  border: 1px solid transparent; background: transparent; color: var(--text-2); cursor: pointer;
  border-radius: calc(var(--radius) - 2px); transition: all 0.18s var(--ease-out); font-weight: 650;
  line-height: 1;
}
.prod-tab:hover { color: var(--text-0); background: var(--button-bg); border-color: var(--button-border); }
.prod-tab.active { background: var(--accent-bg); color: var(--accent-text); font-weight: 650; border-color: var(--accent-glow); box-shadow: none; }
.prod-tab:focus-visible {
  outline: none;
  border-color: var(--action-primary);
  box-shadow: var(--focus-ring), var(--button-shadow);
}
.prod-tab-badge { font-size: 10px; font-family: var(--font-mono); padding: 0 4px; background: var(--bg-3); border-radius: 99px; }
.prod-tab.active .prod-tab-badge { background: var(--accent-bg); color: var(--accent-text); }

/* 视频制作模式切换：原生逐镜头 / ComfyUI 整集工作流 */
.video-mode-tabs {
  display: inline-flex; gap: 2px; padding: 2px; flex-shrink: 0;
  background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius);
}
.video-mode-tab {
  min-height: 22px; padding: 0 9px; font-size: 11px; font-weight: 600; line-height: 1;
  border: 1px solid transparent; border-radius: calc(var(--radius) - 2px);
  background: transparent; color: var(--text-3); cursor: pointer;
  transition: all 0.18s var(--ease-out);
}
.video-mode-tab:hover { color: var(--text-0); background: var(--bg-hover); }
.video-mode-tab.active {
  background: var(--surface-raised); color: var(--text-0);
  border-color: var(--border); box-shadow: var(--shadow-card);
}
.video-mode-tab:focus-visible {
  outline: none;
  border-color: var(--action-primary);
  box-shadow: var(--focus-ring);
}

/* ComfyUI 监控舞台：右侧嵌入官方工作流页面，网关校验路径票据 */
.comfy-embed-stage {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--surface-outline);
  background: var(--surface-muted);
  overflow: hidden;
}
.comfy-embed-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--surface-outline);
  background: var(--surface-raised);
}
.comfy-embed-heading { min-width: 0; }
.comfy-embed-title { font-size: 12.5px; font-weight: 800; color: var(--text-0); }
.comfy-embed-sub { margin-top: 2px; font-size: 10.5px; color: var(--text-3); }
.comfy-embed-metrics { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.comfy-embed-metrics span {
  display: inline-flex; align-items: baseline; gap: 2px;
  padding: 3px 7px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--bg-2); color: var(--text-3); font-size: 10px; white-space: nowrap;
}
.comfy-embed-metrics b { color: var(--text-0); font-size: 11px; font-weight: 700; }
.comfy-embed-live {
  display: inline-flex; align-items: center; gap: 5px; margin-left: auto;
  padding: 3px 8px; border: 1px solid var(--surface-outline); border-radius: 999px;
  background: var(--overlay-track); color: var(--text-2); font-size: 10.5px; font-weight: 700; white-space: nowrap;
}
.comfy-embed-live.running { color: var(--accent-text); border-color: var(--accent-glow); background: var(--accent-bg); }
.comfy-embed-live.running .dot { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
.comfy-embed-actions { display: flex; align-items: center; gap: 6px; }
.comfy-embed-notice {
  display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px;
  padding: 6px 12px; border-bottom: 1px solid var(--surface-outline);
  background: var(--bg-2); color: var(--text-2); font-size: 10.5px; line-height: 1.5;
}
.comfy-embed-notice.is-warning { border-left: 2px solid var(--warning, #d97706); }
.comfy-embed-body { flex: 1; min-height: 0; display: flex; background: #1b1b1b; }
.comfy-embed-state {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; padding: 24px; color: var(--text-3); font-size: 12px; text-align: center;
}
.comfy-embed-state.is-error { color: var(--text-2); }
.comfy-embed-state-actions { display: flex; gap: 6px; }
.comfy-embed-frame {
  flex: 1; width: 100%; height: 100%; min-height: 0;
  border: 0; background: #1b1b1b; display: block;
}
.comfy-embed-foot {
  flex: none; padding: 5px 12px; border-top: 1px solid var(--surface-outline);
  background: var(--surface-raised); color: var(--text-3); font-size: 10px; line-height: 1.4;
}
/* 左侧任务列表底部常驻操作：修改切回原生逐镜，提交直接提交整集工作流 */
.video-task-footer {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px 12px;
  border-top: 1px solid var(--surface-outline);
  background: var(--surface-raised);
}
.video-task-footer-status {
  display: flex; align-items: center; gap: 6px;
  font-size: 10.5px; color: var(--text-2);
}
.video-task-footer-actions { display: flex; gap: 6px; }
.video-task-footer-actions .btn { flex: 1; justify-content: center; min-height: 28px; }

/* Production content */
.prod-content { flex: 1; overflow-y: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.prod-section-bar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }

/* 资产栏动作：提取（虚线中性）与批量生成（强调色）视觉分组 */
.asset-bar-actions { align-items: center; }
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
  color: var(--text-2);
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

/* 分镜勾选：选择后批量生成视频提示词 */
.shot-check {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 4px;
  border: 1.5px solid var(--surface-outline-strong);
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--on-accent);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.shot-check:hover { border-color: var(--accent); }
.shot-check.on { background: var(--accent); border-color: var(--accent); }
.shot-quick-btn {
  border: none;
  background: transparent;
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
  white-space: nowrap;
}
.shot-quick-btn:hover { text-decoration: underline; }
/* 多选模式：头部快捷操作独立一行，分段芯片样式 */
.shot-quick-actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--surface-outline);
}
.shot-quick-actions .shot-quick-btn {
  flex: 1;
  padding: 5px 0;
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--text-2);
  text-align: center;
  transition: background 0.15s, color 0.15s;
}
.shot-quick-actions .shot-quick-btn:hover {
  background: var(--accent-bg);
  color: var(--accent-text);
  text-decoration: none;
}

/* 新增资产弹窗 */
.asset-create-dialog { width: 480px; max-width: calc(100vw - 48px); }
.asset-create-body { display: flex; flex-direction: column; gap: 10px; }

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
  color: var(--text-2);
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
  box-shadow: var(--focus-ring), var(--shadow-panel);
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
  color: var(--text-2);
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
  font-size: 11px;
  line-height: 1.5;
}
.afp-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text-2);
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
  color: var(--text-2);
  font-size: 11px;
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
  font-size: 11px;
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
.asset-cover-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-2); }
.asset-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px 8px;
  min-width: 0;
}
.asset-name {
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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

/* Frame grid */
.frame-grid { display: flex; flex-direction: column; gap: 8px; }
.frame-row {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 14px; cursor: pointer;
  border-radius: var(--radius-lg);
  transition: all 0.15s;
  border: 1.5px solid transparent;
}
.frame-row:hover { background: var(--bg-0); border-color: var(--border); }
.frame-row.active {
  background: var(--bg-0);
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
.frame-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.frame-top { display: flex; align-items: center; gap: 8px; }
.frame-num {
  font-size: 13px; font-family: var(--font-mono); font-weight: 800;
  color: var(--accent);
}
.frame-badge {
  font-size: 11px; font-weight: 600; padding: 2px 8px;
  border-radius: 20px;
  background: var(--accent-bg); color: var(--accent);
  border: 1px solid var(--accent-glow);
  white-space: nowrap;
}
.frame-desc {
  font-size: 12px; line-height: 1.5; color: var(--text-1);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.frame-meta { display: flex; align-items: center; gap: 6px; }
.frame-thumbs { display: flex; gap: 8px; flex-shrink: 0; }
.frame-thumb-wrap { display: flex; flex-direction: column; gap: 3px; align-items: center; }
.frame-thumb-label { font-size: 10px; font-weight: 600; color: var(--text-3); }
.frame-thumb {
  position: relative; width: 130px; aspect-ratio: 16/9;
  border-radius: 6px; overflow: hidden;
  background: var(--bg-2); cursor: pointer;
  transition: all 0.15s; border: 1.5px solid var(--border);
}
.frame-thumb:hover { border-color: var(--accent); box-shadow: 0 2px 8px rgba(0,0,0,0.2); }
.frame-thumb img { width: 100%; height: 100%; object-fit: cover; }
.frame-thumb-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.frame-re {
  position: absolute; top: 3px; right: 3px; width: 18px; height: 18px;
  border-radius: 50%; background: rgba(0,0,0,0.5); color: #fff;
  display: none; align-items: center; justify-content: center;
}
.frame-thumb:hover .frame-re { display: flex; }
.frame-scroll { flex: 1; overflow-y: auto; padding: 10px 12px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--bg-3); flex-shrink: 0; }
.dot.ok { background: var(--success); }
.dot.pending {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

/* Video tasks */
.video-task-workbench {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(460px, 55%);
  overflow: hidden;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
}
.video-task-workbench.has-player {
  grid-template-columns: var(--vleft, 236px) minmax(0, 1fr);
}
.video-task-side {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) var(--vright, 340px);
  border-left: 1px solid var(--border);
  background: var(--surface-muted);
}
/* 三栏拖拽分隔条：透明热区覆盖分界，悬停/拖动时亮起 */
.video-col-divider {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 9px;
  z-index: 6;
  cursor: col-resize;
  touch-action: none;
}
.video-col-divider.is-left { left: calc(var(--vleft, 236px) - 4px); }
.video-col-divider.is-right { right: calc(var(--vright, 340px) - 4px); }
.video-col-divider::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 1px;
  background: transparent;
  transition: background 0.15s, box-shadow 0.15s;
}
.video-col-divider:hover::after,
.video-col-divider:active::after {
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent-glow);
}
:global(body.is-video-col-dragging) { cursor: col-resize; user-select: none; }
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
.video-main-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.video-remote-source {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  font-size: 12px;
  color: var(--text-2);
}
.video-remote-source a { max-width: 100%; overflow-wrap: anywhere; color: var(--accent); }

.video-player-history {
  min-height: 0;
  padding: 8px 12px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-raised);
}
.video-player-history-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 7px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-2);
}
.video-player-history-count {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--overlay-track);
  color: var(--text-3);
  font-size: 10px;
  font-weight: 750;
}
.video-player-history-list {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding-bottom: 2px;
}
.video-history-item {
  position: relative;
  flex: 0 0 auto;
  width: 96px;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1.5px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--media-surface);
  cursor: pointer;
  transition: border-color 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out);
}
.video-history-item:hover { border-color: var(--border-strong); }
.video-history-item video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.video-history-item.current {
  border-color: var(--accent);
}
.video-history-item.viewing {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
.video-history-time {
  position: absolute;
  left: 4px;
  bottom: 4px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(0,0,0,0.6);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 9px;
}
.video-history-badge {
  position: absolute;
  right: 4px;
  top: 4px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 9px;
  font-weight: 700;
}
.video-history-del {
  position: absolute;
  right: 3px;
  top: 3px;
  width: 16px;
  height: 16px;
  display: none;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: rgba(0,0,0,0.62);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.video-history-item:hover .video-history-del { display: flex; }
.video-task-player {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--border);
  background: var(--surface-raised);
}
.video-player-head {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--surface-outline);
}
.video-player-head-info {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.video-player-title { color: var(--text-0); font-size: 13px; font-weight: 700; white-space: nowrap; }
.video-player-sub { color: var(--text-3); font-size: 11px; white-space: nowrap; }
.video-player-stage {
  flex: none;
  aspect-ratio: 16 / 9;
  max-height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--media-surface);
}
.video-player-video {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
}
/* 空态：保留 16:9 播放框，内容居中（图标 + 文案 + 生成按钮） */
.video-player-empty {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 6px;
  padding: 14px 16px;
  color: var(--text-3);
}
.video-player-empty-copy { display: flex; flex-direction: column; align-items: center; }
.video-player-empty-title { color: var(--text-1); font-size: 12.5px; font-weight: 700; }
.video-player-empty-desc { margin-top: 2px; font-size: 11px; line-height: 1.5; }
.video-player-empty-action { flex-shrink: 0; margin-top: 4px; }
.video-task-list {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border: 0;
  border-radius: 0;
  background: var(--surface-raised);
}
.video-task-head {
  min-height: 48px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--surface-outline);
}
.video-task-title {
  font-size: 13px;
  line-height: 1.2;
  font-weight: 850;
  color: var(--text-0);
}
.video-task-meta {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--text-3);
}
.video-task-metrics {
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}
.video-task-metric,
.video-task-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 22px;
  padding: 0 8px;
  border: 1px solid var(--surface-outline);
  border-radius: 999px;
  background: var(--overlay-track);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 750;
  white-space: nowrap;
}
.video-task-metric.is-done,
.video-task-status.is-done {
  color: var(--success);
  border-color: var(--success-bg);
  background: var(--success-bg);
}
.video-task-metric.is-pending,
.video-task-status.is-pending,
.video-task-status.is-ready {
  color: var(--accent-text);
  border-color: var(--accent-glow);
  background: var(--accent-bg);
}
.video-task-metric.is-failed,
.video-task-status.is-failed,
.video-task-status.is-blocked {
  color: var(--warning);
  border-color: var(--warning-bg);
  background: var(--warning-bg);
}
.video-task-table {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
/* 统计徽章兼作筛选器 */
button.video-task-metric { cursor: pointer; font-family: inherit; transition: box-shadow 0.15s; }
button.video-task-metric:hover { box-shadow: 0 0 0 2px var(--sel-glow); }
button.video-task-metric.on { box-shadow: 0 0 0 2px var(--accent); }
/* 批量视频：选择模式 */
.btn.is-on { border-color: var(--accent); color: var(--accent-text); background: var(--accent-bg); }
.video-retry-failed { color: var(--warning); border-color: var(--warning-bg); }
.video-task-row.is-selected { background: var(--sel-bg); box-shadow: inset 0 0 0 1.5px var(--sel); }
.video-task-check {
  position: absolute;
  top: 5px;
  right: 5px;
  z-index: 2;
  background: rgba(0,0,0,0.45);
  border-color: rgba(255,255,255,0.55);
}
.video-task-check.on { background: var(--accent); border-color: var(--accent); }
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
/* 审核失败引导 */
.video-task-error-hint {
  margin-top: 3px;
  color: var(--accent-text);
  font-weight: 600;
}
/* 批量生成确认弹窗 */
.batch-video-dialog { width: 420px; max-width: calc(100vw - 48px); }
.batch-video-body { display: flex; flex-direction: column; gap: 10px; }
.batch-video-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  color: var(--text-2);
  padding: 8px 12px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--bg-input);
}
.batch-video-row strong { color: var(--text-0); font-weight: 600; }
.batch-video-note { margin: 4px 0 0; font-size: 11px; color: var(--text-3); line-height: 1.6; }
.video-task-row {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-top: 1px solid var(--surface-outline);
  transition: background 0.16s var(--ease-out), border-color 0.16s var(--ease-out);
  cursor: pointer;
}
.video-task-row:first-child {
  border-top: 0;
}
.video-task-row:hover,
.video-task-row.is-pending {
  background: var(--bg-hover);
}
.video-task-row.is-failed {
  background: var(--error-bg);
}
.video-task-row.active {
  background: var(--sel-bg);
  box-shadow: inset 0 0 0 1.5px var(--sel), 0 0 0 3px var(--sel-glow);
}
.video-task-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.video-task-preview {
  position: relative;
  width: 56px;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
}
.video-task-preview video,
.video-task-preview img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.video-task-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.video-task-index {
  position: absolute;
  left: 3px;
  top: 3px;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(0,0,0,0.56);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 800;
}
.video-task-main {
  min-width: 0;
}
.video-task-line {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.video-task-name {
  min-width: 0;
  font-size: 12px;
  line-height: 1.35;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.video-task-meta-line {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-3);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
}
.video-task-loc {
  color: var(--text-2);
}
.video-task-sep { color: var(--text-3); opacity: 0.5; }
.video-task-error {
  margin-top: 5px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--error);
}
.video-task-error-hint {
  margin-top: 3px;
  color: var(--accent-text, var(--accent));
  font-weight: 600;
}
.video-task-status {
  justify-self: end;
  align-self: center;
}
/* 行内紧凑状态（窄列表用）：小圆点 + 文字 */
.video-task-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-3);
  white-space: nowrap;
}
.video-task-state.is-done { color: var(--success); }
.video-task-state.is-pending { color: var(--accent-text); }
.video-task-state.is-failed { color: var(--warning); }
.video-task-action {
  justify-self: end;
  align-self: center;
  min-width: 0;
  width: 24px;
  height: 24px;
  padding: 0;
}
.video-task-inspector {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--surface-muted);
}
.video-task-inspector .video-task-player,
.video-task-inspector .video-player-history {
  flex: none;
}
.video-inspector-head {
  min-height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--surface-outline);
}
.video-inspector-title { color: var(--text-0); font-size: 14px; font-weight: 700; }
.video-inspector-sub { margin-top: 2px; color: var(--text-3); font-size: 11px; }
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
.video-inspector-params { display: grid; gap: 8px; }
.video-inspector-params div { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
.video-inspector-params dt { color: var(--text-3); }
.video-inspector-params dd { margin: 0; color: var(--text-1); text-align: right; }
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
.video-param-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; white-space: nowrap; }
.video-param-name { color: var(--text-1); font-weight: 600; flex-shrink: 0; }
.video-param-value { color: var(--text-1); text-align: right; font-size: 11px; }
.video-param-control { display: inline-flex; align-items: center; gap: 6px; }
.video-param-unit { font-size: 11px; color: var(--text-2); }
.video-duration-input { width: 56px; height: 24px; padding: 2px 6px; font-size: 12px; font-weight: 700; font-family: var(--font-mono); text-align: center; }

/* Prod grid */
.prod-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.prod-card {
  display: flex; flex-direction: column; overflow: hidden;
  transition: transform 0.18s var(--ease-out), box-shadow 0.18s var(--ease-out), border-color 0.18s var(--ease-out);
  border-radius: 20px;
  background: var(--surface-raised);
  border: 1px solid var(--surface-outline);
}
.prod-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.prod-cover { position: relative; aspect-ratio: 16/9; background: var(--bg-2); overflow: hidden; }
.prod-cover img { width: 100%; height: 100%; object-fit: cover; }
.prod-video { width: 100%; height: 100%; object-fit: cover; background: #000; display: block; }
.prod-cover-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.prod-idx {
  position: absolute; top: 5px; left: 5px; font-size: 10px; font-weight: 700;
  font-family: var(--font-mono); background: rgba(0,0,0,0.5); color: #fff; padding: 1px 5px; border-radius: 3px;
}
.prod-overlay-badge {
  position: absolute; bottom: 5px; right: 5px; font-size: 10px; font-weight: 600;
  background: var(--success); color: var(--on-accent); padding: 1px 5px; border-radius: 3px;
}
.prod-info { padding: 10px 12px 8px; }
.prod-desc { font-size: 12px; line-height: 1.4; }
.prod-meta-line { margin-top: 5px; font-size: 10px; color: var(--text-3); }
.prod-dots { display: flex; align-items: center; gap: 4px; margin-top: 5px; color: var(--text-3); }
.prod-error {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--error);
}
.prod-actions { display: flex; gap: 6px; padding: 8px 10px 10px; border-top: 1px solid var(--surface-outline); }
.prod-actions .btn { flex: 1; justify-content: center; }

/* Asset detail dialog */
.asset-detail-overlay {
  z-index: 118;
  padding: 28px;
}
.asset-detail-dialog {
  width: min(880px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
}
.asset-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: var(--sp-4) var(--sp-6);
  border-bottom: 1px solid var(--border);
}
.asset-detail-title-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.asset-detail-kicker {
  color: var(--text-2);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.asset-detail-title {
  margin: 0;
  color: var(--text-0);
  font-size: 17px;
  line-height: 1.2;
  font-family: var(--font-display);
}
.asset-detail-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.asset-detail-body {
  min-height: 0;
  overflow: auto;
  padding: var(--sp-6);
}
.asset-detail-shell {
  display: grid;
  grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.asset-detail-preview-panel,
.asset-detail-editor-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.asset-detail-preview-panel {
  position: sticky;
  top: 0;
}
.asset-detail-section-title {
  min-height: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: var(--text-1);
  font-size: 12px;
  font-weight: 820;
  letter-spacing: 0.02em;
}
.asset-detail-section-title .dim {
  font-size: 11px;
  font-weight: 560;
  letter-spacing: 0;
  text-align: right;
}
.asset-detail-state {
  min-height: 20px;
  display: inline-flex;
  align-items: center;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--overlay-track);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 760;
  white-space: nowrap;
}
.asset-detail-state.is-ready {
  color: var(--success);
  background: var(--success-bg);
}
.asset-detail-media-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  display: block;
  padding: 0;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--bg-2);
  color: var(--text-3);
  overflow: hidden;
  cursor: zoom-in;
}
.asset-detail-media-frame:disabled {
  cursor: default;
  opacity: 1;
}
.asset-detail-media-frame:focus-visible {
  outline: none;
  border-color: var(--action-primary);
  box-shadow: var(--focus-ring);
}
.asset-detail-media-frame img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.asset-detail-media-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.asset-detail-desc {
  margin: 0;
  color: var(--text-1);
  font-size: 13.5px;
  line-height: 1.7;
}
.asset-detail-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.asset-detail-field {
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--surface-muted);
}
.asset-detail-field span,
.asset-detail-edit-field span,
.asset-detail-text-block span,
.asset-detail-shot-head {
  display: block;
  color: var(--text-2);
  font-size: 11px;
  font-weight: 780;
  letter-spacing: 0.04em;
}
.asset-detail-field strong {
  display: block;
  margin-top: 5px;
  min-width: 0;
  overflow: hidden;
  color: var(--text-0);
  font-size: 12px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-detail-text-block {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.asset-detail-edit-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.asset-detail-edit-grid--character,
.asset-detail-edit-grid--scene {
  grid-template-columns: 1fr;
}
.asset-detail-edit-field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.asset-detail-textarea {
  min-height: 138px;
  resize: vertical;
}
.asset-detail-edit-grid--character .asset-detail-textarea,
.asset-detail-edit-grid--scene .asset-detail-textarea {
  min-height: 164px;
}
.asset-detail-meta-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
/* 资产参考图：生成条件图，不替换资产成图 */
.asset-ref-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.asset-ref-list { display: flex; flex-wrap: wrap; gap: 6px; }
.asset-ref-item {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: var(--radius);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-hover);
}
.asset-ref-item img { width: 100%; height: 100%; object-fit: cover; display: block; cursor: zoom-in; }
.asset-ref-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 15px;
  height: 15px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.58);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.asset-ref-remove:hover { background: rgba(0, 0, 0, 0.8); }
.asset-ref-add {
  width: 56px;
  height: 56px;
  padding: 0;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: color 0.16s var(--ease-out), border-color 0.16s var(--ease-out);
}
.asset-ref-add:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.asset-ref-add:disabled { cursor: progress; }
.asset-ref-spinner {
  width: 12px;
  height: 12px;
  border: 1.6px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: asset-ref-spin 0.7s linear infinite;
}
@keyframes asset-ref-spin { to { transform: rotate(360deg); } }
.asset-ref-hint { margin: 0; color: var(--text-2); font-size: 11px; line-height: 1.5; }
/* 角色音色：全宽横跨预览与编辑两栏，避免挤在窄预览列里 */
.asset-detail-voice-row {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--surface-outline);
  padding-top: 14px;
  margin-top: 14px;
}
.asset-detail-voice-row :deep(.character-voice) { margin-top: 0; padding-top: 0; }
.asset-ref-chip {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 6px;
  white-space: nowrap;
}
.tag-ref { color: var(--accent-text); background: var(--accent-bg); border-color: transparent; }
.asset-detail-meta-item {
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--surface-muted);
}
.asset-detail-meta-item span {
  display: block;
  color: var(--text-2);
  font-size: 11px;
  font-weight: 780;
  letter-spacing: 0.04em;
}
.asset-detail-meta-item strong {
  display: block;
  margin-top: 4px;
  min-width: 0;
  color: var(--text-0);
  font-size: 12px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-detail-text-block > div,
.asset-detail-shot-list {
  padding: 10px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--surface-muted);
}
.asset-detail-text-block p {
  margin: 5px 0 0;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.55;
}
.asset-detail-shot-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.asset-detail-shot-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.asset-detail-shot-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  color: var(--text-2);
  font-size: 11px;
}
.asset-detail-shot-row strong {
  min-width: 0;
  overflow: hidden;
  color: var(--text-1);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-detail-shot-row small,
.asset-detail-empty {
  color: var(--text-2);
  font-size: 11px;
}
.asset-detail-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: var(--sp-4) var(--sp-6);
  border-top: 1px solid var(--border);
}
.asset-detail-secondary-actions,
.asset-detail-primary-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.asset-detail-prompt-panel {
  min-width: 0;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--surface-outline);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.asset-detail-prompt-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.asset-detail-copy-btn {
  gap: 5px;
}
.asset-detail-prompt-textarea {
  min-height: 96px;
  max-height: 260px;
  overflow: auto;
  padding: 12px 14px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--surface-muted);
  color: var(--text-1);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  resize: vertical;
  width: 100%;
}
.asset-detail-prompt-hint {
  margin: 0;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.5;
}
.asset-detail-readonly-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.asset-detail-readonly {
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--surface-muted);
}
.asset-detail-readonly span {
  display: block;
  color: var(--text-2);
  font-size: 11px;
  font-weight: 780;
  letter-spacing: 0.04em;
}
.asset-detail-readonly p {
  margin: 6px 0 0;
  color: var(--text-1);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
.asset-detail-readonly p.dim {
  color: var(--text-3);
}

/* Image viewer */
.image-viewer-overlay {
  z-index: 120;
  padding: 28px;
}
.image-viewer-dialog {
  width: min(1100px, calc(100vw - 56px));
  max-height: calc(100vh - 56px);
  background: var(--header-bg);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
}
.image-viewer-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--surface-outline);
}
.image-viewer-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  font-family: var(--font-display);
}
.image-viewer-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  overflow: auto;
  min-height: 0;
}
.image-viewer-img {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 140px);
  border-radius: 18px;
  box-shadow: var(--shadow-xl);
  background: var(--surface-muted);
}

/* Export */
.export-split { flex: 1; display: flex; min-height: 0; }
.export-main { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; align-items: stretch; gap: 18px; padding: 16px 20px 24px; }
.export-section { display: flex; flex-direction: column; min-height: 0; }
.export-section-grow { flex: 1; }
.export-section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.export-section-title { font-size: 13px; font-weight: 800; color: var(--text-0); }
.export-merge-strip { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 4px; }
.merge-card {
  flex: 0 0 auto;
  width: 260px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: var(--radius);
  background: var(--surface-raised);
  border: 1px solid var(--border);
}
.merge-card video {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 6px;
  background: var(--media-surface);
  display: block;
}
.merge-card-pending {
  width: 100%;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 12px;
  border-radius: 6px;
  background: var(--surface-muted);
  color: var(--text-3);
  font-size: 11px;
  text-align: center;
}
.merge-card-pending.is-failed { color: var(--error); background: var(--error-bg); }
.merge-card-title { font-size: 12px; font-weight: 600; color: var(--text-1); padding: 6px 2px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.merge-card-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-3); min-width: 0; }
.merge-card-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.merge-card-actions .btn { padding: 3px 8px; }
.merge-card-actions .merge-card-del { margin-left: auto; color: var(--text-3); }
.merge-card-actions .merge-card-del:hover { color: var(--error); }
.merge-card.playable { cursor: pointer; }
.merge-card.playable:hover { border-color: var(--border-strong); box-shadow: var(--shadow-card); }
.merge-card-thumb { position: relative; }
.merge-card-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: rgba(0,0,0,0.28);
  color: #fff;
  opacity: 0;
  transition: opacity 0.15s var(--ease-out);
  pointer-events: none;
}
.merge-card.playable:hover .merge-card-play { opacity: 1; }
.merge-viewer-dialog { width: min(1080px, calc(100vw - 56px)); }
.merge-viewer-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
  min-height: 0;
}
.merge-viewer-video {
  width: 100%;
  max-height: calc(100vh - 220px);
  border-radius: var(--radius);
  background: #000;
  display: block;
}
.export-merge-empty {
  padding: 14px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
}
.export-grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  align-content: start;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.exp-card { display: flex; flex-direction: column; align-items: stretch; gap: 6px; padding: 8px; border-radius: var(--radius); background: var(--surface-raised); border: 1px solid var(--border); }
.exp-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-card); }
.exp-card.playable { cursor: pointer; }
.exp-card.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-glow); }
.exp-check {
  position: absolute;
  right: 6px;
  top: 6px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,0.9);
  background: rgba(0,0,0,0.35);
  color: #fff;
}
.exp-check.on { background: var(--accent); border-color: var(--accent); }
.exp-thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--surface-outline);
  border-radius: 6px;
  background: var(--media-surface);
}
.exp-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.exp-thumb-empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-3); }
.exp-thumb-index {
  position: absolute;
  left: 5px;
  top: 5px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(0,0,0,0.56);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 800;
}
.exp-thumb-duration {
  position: absolute;
  right: 5px;
  bottom: 5px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(0,0,0,0.6);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 9px;
}
/* 镜头预览：悬停浮现的居中播放钮，点击打开预览弹窗（不影响卡片勾选） */
.exp-play {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%) scale(0.9);
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(0,0,0,0.62);
  color: #fff;
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.15s, background 0.15s;
}
.exp-card:hover .exp-play { opacity: 1; transform: translate(-50%, -50%) scale(1); }
.exp-play:hover { background: var(--accent); }
/* 导出完成手动标记按钮 */
.export-done-btn.on {
  background: var(--success-bg, var(--accent-bg));
  color: var(--success, var(--accent-text));
  border-color: transparent;
  font-weight: 600;
}
.exp-row-line { display: flex; align-items: center; gap: 8px; min-width: 0; }

/* Shared */
.dim { color: var(--text-3); }

@media (max-width: 1080px) {
  .studio-body {
    grid-template-columns: 1fr;
  }

  .video-task-workbench.has-player {
    grid-template-columns: var(--vleft, 208px) minmax(0, 1fr);
  }

  .video-task-side {
    grid-template-columns: minmax(0, 1fr) var(--vright, 260px);
  }

  .video-main-grid {
    grid-template-columns: 1fr;
  }

  .split-layout,
  .export-split {
    flex-direction: column;
  }

  .sb-scene-select { max-width: none; flex: 1; }

  .detail-panel {
    min-height: 420px;
  }

  .field-grid-4 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .character-asset-grid {
    grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  }

  .video-task-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .video-task-metrics {
    width: 100%;
    margin-left: 0;
    justify-content: flex-start;
  }

  .video-task-row {
    grid-template-columns: 56px minmax(0, 1fr);
  }

  .video-task-action {
    justify-self: start;
  }

  .image-viewer-overlay {
    padding: 16px;
  }

  .image-viewer-dialog {
    width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
  }

  .asset-detail-overlay {
    padding: 16px;
  }

  .asset-detail-dialog {
    width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
  }

  .asset-detail-shell {
    grid-template-columns: 1fr;
  }

  .asset-detail-preview-panel {
    position: static;
  }

  .asset-detail-grid,
  .asset-detail-edit-grid,
  .asset-detail-text-block {
    grid-template-columns: 1fr;
  }

}

/* ===== 任务列表面板 ===== */
.gen-task-row {
  grid-template-columns: 84px minmax(0, 1fr) auto;
  cursor: default;
}
.gen-task-row .video-task-preview img {
  cursor: zoom-in;
}

/* 任务触发按钮(顶栏) */
.task-drawer-trigger {
  position: relative;
}
.task-drawer-badge {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--action-primary-text);
  font-size: 10px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

/* 右侧抽屉 */
.task-drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 118;
  display: flex;
  justify-content: flex-end;
  background: var(--scrim);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  animation: fadeIn 0.18s var(--ease-out);
}
.task-drawer {
  width: min(560px, 100vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--panel-bg);
  border-left: 1px solid var(--panel-border);
  box-shadow: var(--shadow-xl);
  animation: taskDrawerIn 0.22s var(--ease-out);
}
@keyframes taskDrawerIn {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.task-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--surface-outline);
}
.task-drawer-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.task-drawer-metrics {
  padding: 10px 16px;
  border-bottom: 1px solid var(--surface-outline);
}
.task-drawer-body {
  flex: 1;
  overflow-y: auto;
}
.task-drawer-empty {
  flex: 1;
  justify-content: center;
}

@media (max-width: 860px) {
  .studio {
    padding: 8px;
    gap: 8px;
  }

  .studio-topbar-main {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .episode-topbar.studio-topbar {
    height: auto;
    min-height: var(--topbar-h);
    flex-wrap: wrap;
    padding: 6px var(--topbar-pad-x);
    row-gap: 6px;
  }
  .episode-topbar :deep(.studio-topbar-left) { flex: 1 1 auto; }
  .episode-topbar :deep(.studio-topbar-center) {
    flex: 1 1 100%;
    order: 3;
    justify-content: flex-start;
  }
  .episode-topbar :deep(.studio-topbar-right) { flex: 0 1 auto; }

  .sidebar {
    max-height: 340px;
  }

  .studio-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .toolbar-right,
  .export-bar {
    flex-wrap: wrap;
  }

  .asset-grid,
  .character-asset-grid,
  .prod-grid {
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

  .video-task-workbench {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }

  /* 窄屏纵向堆叠后无栏间分界，隐藏拖拽分隔条 */
  .video-col-divider { display: none; }

  .video-task-inspector {
    border-top: 1px solid var(--surface-outline);
    border-left: 0;
  }

  .video-task-side {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--surface-outline);
    border-left: 0;
  }

  /* 窄屏：ComfyUI 监控页纵向堆叠，保留可操作的页面高度 */
  .comfy-embed-stage {
    min-height: 72vh;
    border-top: 1px solid var(--surface-outline);
    border-left: 0;
  }

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

  .video-task-side .video-task-inspector {
    flex: none; /* 窄屏下由外层 workbench 整体滚动，检查器按内容撑开，不参与 flex 收缩 */
    border-top: 0;
    display: flex;
    flex-direction: column;
    overflow: visible;
  }

  .video-inspector-body {
    overflow: visible;
  }

  .video-task-player {
    flex: none; /* 禁止收缩：否则 stage 的 min-height 会使其溢出播放器并遮挡下方检查器 */
  }

  .video-player-stage {
    flex: none;
    max-height: 220px;
  }

  .frame-row {
    flex-direction: column;
    align-items: stretch;
  }

  .detail-hero {
    grid-template-columns: 1fr;
  }

  .field-grid-2,
  .field-grid-4 {
    grid-template-columns: 1fr;
  }

  .frame-thumbs {
    width: 100%;
  }

  .frame-thumb {
    width: 100%;
  }

}

/* ===== AI 过渡片段（导出页 + 拼接弹窗） ===== */
.ai-transition-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 4px;
  padding: 2px 4px 2px 10px;
  border: 1px solid var(--surface-outline);
  border-radius: 999px;
  background: var(--bg-hover);
  font-size: 11px;
  color: var(--text-1);
  white-space: nowrap;
}
.ai-transition-chip.unsupported { opacity: 0.65; }
.ai-transition-chip-state { display: inline-flex; align-items: center; gap: 4px; color: var(--text-2); }
.ai-transition-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--surface-outline);
}
.ai-transition-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-1);
  cursor: pointer;
}
.ai-transition-toggle input { accent-color: var(--accent); }
.ai-transition-pick { display: flex; align-items: center; }
.ai-transition-pick input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}
.ai-transition-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 320px;
  overflow: auto;
}
.ai-transition-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 5px 7px;
  border: 1px solid var(--surface-outline);
  border-radius: 6px;
  background: var(--bg-hover);
  font-size: 11px;
}
.ai-transition-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ai-transition-pair { min-width: 104px; color: var(--text-1); }
.ai-transition-status {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--surface-outline);
  color: var(--text-2);
}
.ai-transition-status.ok { color: var(--success); }
.ai-transition-status.failed { color: var(--error); }
.ai-transition-status.pending { color: var(--accent); }
.ai-transition-duration { white-space: nowrap; }
.ai-transition-actions { display: flex; gap: 4px; margin-left: auto; }
.ai-transition-prompt {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--surface-outline);
}
.ai-transition-prompt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ai-transition-prompt-source {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--surface-outline);
  color: var(--text-2);
  font-size: 11px;
}
.ai-transition-prompt-source.source-ai { color: var(--success); }
.ai-transition-prompt-source.source-fallback { color: var(--accent); }
.ai-transition-prompt-source.source-manual { color: var(--text-1); }
.ai-transition-prompt-input {
  width: 100%;
  min-height: 58px;
  resize: vertical;
  font-size: 11px;
  line-height: 1.5;
}
.ai-transition-prompt-actions { display: flex; justify-content: flex-end; gap: 6px; }
.ai-transition-prompt-note { margin: 0; color: var(--text-2); font-size: 11px; line-height: 1.4; }
.merge-title-dialog { width: min(760px, calc(100vw - 48px)); }
.ai-transition-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
}
.ai-transition-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s var(--ease-out), box-shadow 0.15s var(--ease-out);
}
.ai-transition-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-card);
}
.ai-transition-card-thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: 6px;
  overflow: hidden;
  background: var(--media-surface);
}
.ai-transition-card-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ai-transition-card-thumb .ai-transition-status {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);
}
.ai-transition-card-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--text-3);
}
.ai-transition-card-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.22);
  color: #fff;
  opacity: 0;
  transition: opacity 0.15s var(--ease-out);
}
.ai-transition-card:hover .ai-transition-card-play { opacity: 1; }
.ai-transition-card-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  font-size: 11px;
  color: var(--text-1);
}
.transition-detail-dialog { width: min(640px, calc(100vw - 48px)); }
.transition-detail-meta { font-size: var(--text-micro); }
.dialog-hint {
  color: var(--text-2);
  font-size: var(--text-meta);
  line-height: 1.4;
}
.transition-detail-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.transition-detail-video {
  border-radius: 8px;
  overflow: hidden;
  background: #000;
}
.transition-detail-video video {
  display: block;
  width: 100%;
  max-height: 46vh;
  background: #000;
}
.transition-detail-error {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--error-bg);
  color: var(--error);
  font-size: 12px;
}
.transition-detail-frames { display: flex; gap: 10px; }
.transition-detail-frame {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--surface-outline);
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--text-2);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: border-color 0.15s var(--ease-out);
}
.transition-detail-frame:hover { border-color: var(--border-strong); }
.transition-detail-frame img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: 5px;
  background: var(--media-surface);
}
.transition-detail-prompt {
  padding: 10px;
  border: 1px solid var(--surface-outline);
  border-radius: 8px;
}
.transition-detail-delete { color: var(--error); }
.transition-detail-delete:hover:not(:disabled) { background: var(--error-bg); }
.ai-transition-pickers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
</style>
