<template>
  <div class="studio" v-if="drama">
    <header class="studio-topbar">
      <div class="studio-topbar-main">
        <button class="back-btn topbar-back" @click="navigateTo(`/drama/${dramaId}`)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          {{ t('episode.topbar.back') }}
        </button>
        <div class="studio-identity">
          <h1 class="studio-title">{{ drama.title }}</h1>
          <span class="studio-episode-chip">{{ t('episode.topbar.episodeN', { n: episodeNumber }) }}</span>
          <div class="studio-meta-row">
            <span class="studio-meta-pill">{{ currentSubStageLabel }}</span>
            <span class="studio-meta-pill is-progress">{{ pipelineProgress }}/{{ pipelineTotal }}</span>
            <span v-if="remoteReadonly" class="studio-meta-pill is-readonly" :title="t('remote.readonly.notice')">
              {{ t('remote.readonly.badge') }}
            </span>
            <span class="studio-meta-inline">{{ t('episode.topbar.meta', { roles: chars.length, shots: sbs.length }) }}</span>
            <span v-if="showNativeAudioDubbingHint" class="studio-meta-hint" :title="t('episode.topbar.nativeAudioDubbingHintTitle')">
              {{ t('episode.topbar.nativeAudioDubbingHint') }}
            </span>
          </div>
        </div>
        <button
          v-if="isNarrow"
          type="button"
          class="btn topbar-more-btn"
          :aria-expanded="mobileMoreOpen"
          @click="mobileMoreOpen = !mobileMoreOpen"
        >
          <Ellipsis :size="16" />
          {{ t('episode.mobileTabs.more') }}
        </button>
      </div>

      <div class="studio-topbar-side" :class="{ 'is-mobile-open': mobileMoreOpen }">
        <div v-if="isNarrow" class="mobile-more-head">
          <span>{{ t('episode.mobileTabs.moreTitle') }}</span>
          <button type="button" class="btn btn-icon" :title="t('episode.mobileTabs.closeMore')" :aria-label="t('episode.mobileTabs.closeMore')" @click="mobileMoreOpen = false">
            <X :size="16" />
          </button>
        </div>
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
        <div class="studio-actions">
          <button v-if="isNarrow" type="button" class="btn topbar-steps-btn" @click="mobileMoreOpen = false; openStepsDrawer()">
            {{ t('tablet.drawers.steps') }}
          </button>
          <RemoteStatusBadge />
          <LocaleSwitcher />
          <button class="btn btn-icon tour-help-btn" :title="t('tour.helpTitle')" @click="startEpisodeTour()">
            <CircleHelp :size="14" :stroke-width="1.8" />
          </button>
          <button v-if="dubbingEnabled" class="btn" :disabled="remoteReadonly" :title="remoteReadonly ? t('remote.readonly.notice') : undefined" @click="openDubbingStage">
            <Mic :size="12" />
            {{ t('workbench.title') }}
          </button>
          <button v-if="hasEditEntry" class="btn" :disabled="remoteReadonly" :title="remoteReadonly ? t('remote.readonly.notice') : undefined" @click="openEditWorkspace">
            <Scissors :size="12" />
            {{ t('edit.entry') }}
          </button>
          <button class="btn" @click="deliveryOpen = true">
            <Download :size="12" />
            {{ t('delivery.entry') }}
          </button>
          <button class="btn" @click="refresh">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            {{ t('common.refresh') }}
          </button>
          <button class="btn task-drawer-trigger" @click="openTaskDrawer">
            <ListTodo :size="12" />
            {{ t('episode.topbar.tasks') }}
            <span v-if="taskCenterActiveCount" class="task-drawer-badge">{{ taskCenterActiveCount }}</span>
          </button>
        </div>
      </div>
    </header>

    <div v-if="showDesktopRelayHint" class="remote-relay-hint" role="status">
      <AlertCircle :size="14" class="remote-relay-icon" />
      <span>{{ t('remote.pair.desktopRelayHint') }}</span>
      <button
        type="button"
        class="remote-relay-close"
        :aria-label="t('common.close')"
        :title="t('common.close')"
        @click="dismissDesktopRelayHint"
      >
        <X :size="14" />
      </button>
    </div>

    <RemoteChangeNotice :visible="remoteChange" @refresh="applyRemoteChange" @dismiss="keepLocalChanges" />

    <button
      v-if="isNarrow && mobileMoreOpen"
      type="button"
      class="mobile-more-scrim"
      :aria-label="t('episode.mobileTabs.closeMore')"
      @click="mobileMoreOpen = false"
    />

    <EpisodeMobileTabs
      v-if="isNarrow"
      :active="mobileStage"
      :shots="sbs.length"
      :assets-ready="assetReadyCount"
      :assets-total="assetTotalCount"
      :tasks="taskCenterActiveCount"
      @select="selectMobileStage"
    />

    <div class="studio-body">
    <!-- ========== LEFT SIDEBAR ========== -->
    <div v-if="isNarrow && stepsDrawerOpen" class="video-steps-scrim" @click="closeStepsDrawer" />
    <aside
      class="sidebar"
      ref="stepsDrawerEl"
      :class="{ collapsed: sidebarCollapsed && !isNarrow, 'is-steps-drawer': isNarrow, open: isNarrow && stepsDrawerOpen }"
      :role="isNarrow && stepsDrawerOpen ? 'dialog' : undefined"
      :aria-modal="isNarrow && stepsDrawerOpen ? 'true' : undefined"
      :aria-label="isNarrow && stepsDrawerOpen ? t('tablet.drawers.steps') : undefined"
      @keydown="onStepsDrawerKeydown"
    >
      <div v-if="isNarrow" class="video-steps-drawer-head">
        <span class="video-steps-drawer-title">{{ t('tablet.drawers.steps') }}</span>
        <button type="button" class="btn btn-icon video-steps-drawer-close" :title="t('tablet.close')" :aria-label="t('tablet.close')" @click="closeStepsDrawer">
          <X :size="16" />
        </button>
      </div>
      <nav class="pipeline" ref="pipelineEl">
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
        <EpisodeScriptPanel
          :step="scriptStep"
          v-model:raw="localRaw"
          v-model:script="localScript"
          :raw-len="rawLen"
          :script-len="scriptLen"
          :has-raw-content="!!rawContent"
          :has-script-content="!!scriptContent"
          :busy="!!rn"
          :rewriting="!!rn && rt === 'script_rewriter'"
          :remote-readonly="remoteReadonly"
          @save="saveRaw(); toast.success(t('episode.script.saved'))"
          @skip="skipRewrite"
          @rewrite="doRewrite"
        />
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
            <EpisodeAssetPanel
              :characters="visualChars"
              :scenes="scenes"
              :prop-items="propItems"
              :char-count="chars.length"
              :scene-count="inEpisodeScenes.length"
              :prop-count="inEpisodeProps.length"
              :asset-ready-count="assetReadyCount"
              :asset-total-count="assetTotalCount"
              :extract-targets="EXTRACT_TARGETS"
              :extracting="extractingTargets"
              :extracting-labels="extractingLabels"
              :remote-readonly="remoteReadonly"
              :pending-char-ids="pendingCharImageIds"
              :pending-scene-ids="pendingSceneImageIds"
              :pending-prop-ids="pendingPropImageIds"
              :uploading-keys="uploadingAssetKeys"
              @extract="doExtract"
              @extract-all="doExtractAll"
              @batch="assetBatchImages"
              @open-detail="openAssetDetail"
              @add="openAssetCreate"
              @remove="askDeleteAsset"
              @generate="assetGenerate"
              @upload="uploadAssetImage"
              @preview="openImageViewer"
            />
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
              <label class="video-method-pick">
                <span class="dim">{{ t('episode.sb.methodLabel') }}</span>
                <select
                  class="input video-method-select"
                  :value="breakdownMethodKey"
                  :disabled="rn || methodSaving"
                  :title="currentBreakdownMethodName"
                  @change="changeBreakdownMethod"
                >
                  <option v-for="method in breakdownMethods" :key="method.key" :value="method.key">{{ method.name }}</option>
                </select>
                <span class="video-method-hint">{{ t('episode.sb.methodHint') }}</span>
              </label>
              <span class="dim" style="font-size:12px">{{ t('episode.prod.videos') }}</span>
              <span class="tag mono">{{ t('episode.sb.segmentStat', { n: sbs.length, dur: totalDuration }) }}</span>
              <span class="tag mono" :title="t('episode.vid.aspectRatio')">{{ dramaAspectRatio }}</span>
              <div class="ml-auto flex gap-1">
                <button class="btn btn-sm" :disabled="rn || methodSaving || splitRunning || splitStarting || auditRunning" :title="currentBreakdownMethodName" @click="doBreakdown">
                  <Loader2 v-if="splitRunning || splitStarting" :size="11" class="animate-spin" />
                  <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                  {{ splitRunning ? splitProgressText : (sbs.length ? t('episode.sb.rebreak') : t('episode.sb.startBreak')) }}
                </button>
                <button v-if="canResumeSplit" class="btn btn-sm video-split-resume" :disabled="splitStarting || auditRunning" :title="splitJob?.error || t('episode.sb.resumeSplit')" @click="resumeSplit">
                  <Loader2 v-if="splitStarting" :size="11" class="animate-spin" />
                  <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                  {{ t('episode.sb.resumeSplit') }}
                </button>
                <button class="btn btn-sm" :disabled="videoPromptBatch.running || !sbs.length || auditRunning" @click="batchVideoPrompts">
                  <Loader2 v-if="videoPromptBatch.running" :size="11" class="animate-spin" />
                  <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  {{ videoPromptBatch.running ? t('episode.sb.promptProgress', { done: videoPromptBatch.completed, total: videoPromptBatch.total }) : (videoSelectMode && selectedVideoSbIds.length ? t('episode.sb.promptSelected', { n: selectedVideoSbIds.length }) : t('episode.sb.batchPrompts')) }}
                </button>
                <button class="btn btn-sm episode-audit-btn" :disabled="!sbs.length || splitRunning || splitStarting || auditBusy || auditRunning" :title="auditStatusText" @click="runStoryboardAudit()">
                  <Loader2 v-if="auditBusy || auditRunning" :size="11" class="animate-spin" />
                  <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
                  {{ auditButtonLabel }}
                </button>
                <button v-if="auditJob" type="button" class="episode-audit-status" :title="auditStatusText" @click="openAuditPanel()">{{ auditStatusText }}</button>
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
              <div class="empty-desc">{{ splitRunning ? t('episode.sb.breakingElapsed', { s: breakdownElapsed }) : t('episode.sb.emptyDesc') }}</div>
              <div v-if="splitRunning" class="empty-desc video-split-progress">{{ splitProgressText }}</div>
              <div v-if="canResumeSplit && splitJob" class="empty-desc video-split-failed">{{ t('episode.sb.splitFailed', { chunk: (splitJob.completed_chunks || 0) + 1, total: splitJob.total_chunks || 0, error: splitJob.error || '' }) }}</div>
              <div class="empty-desc">{{ t('episode.sb.methodCurrent', { method: currentBreakdownMethodName }) }}</div>
              <div class="locked-config-banner">{{ t('episode.vid.lockedModel') }}{{ effectiveVideoModelLabel }}</div>
              <button v-if="canResumeSplit" class="btn btn-primary video-split-resume" :disabled="splitStarting || auditRunning || remoteReadonly" :title="remoteReadonly ? t('remote.readonly.notice') : undefined" @click="resumeSplit">
                <Loader2 v-if="splitStarting" :size="13" class="animate-spin" />
                <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                {{ t('episode.sb.resumeSplit') }}
              </button>
              <button class="btn btn-primary" :disabled="rn || methodSaving || splitRunning || splitStarting || auditRunning || remoteReadonly" :title="remoteReadonly ? t('remote.readonly.notice') : currentBreakdownMethodName" @click="doBreakdown">
                <Loader2 v-if="splitRunning || splitStarting" :size="13" class="animate-spin" />
                <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                {{ splitRunning ? splitProgressText : t('episode.sb.startBreak') }}
              </button>
              <button class="btn btn-sm" :disabled="rn || addingStoryboard" @click="addStoryboard">
                <Loader2 v-if="addingStoryboard" :size="11" class="animate-spin" />
                <Plus v-else :size="11" />
                {{ t('episode.vid.addShotHint') }}
              </button>
            </div>
            <div v-else class="video-task-workbench has-player" :class="{ 'is-comfy': isComfyVideoMode }" ref="videoWorkbenchEl" :data-pane="tabletPane" :style="{ '--vleft': videoLeftW + 'px', '--vright': videoRightW + 'px' }">
              <div v-if="splitRunning || (canResumeSplit && splitJob)" class="video-split-banner">
                <Loader2 v-if="splitRunning" :size="12" class="animate-spin" />
                <span class="video-split-banner-text">{{ splitRunning ? splitProgressText : t('episode.sb.splitFailed', { chunk: (splitJob.completed_chunks || 0) + 1, total: splitJob.total_chunks || 0, error: splitJob.error || '' }) }}</span>
                <button v-if="canResumeSplit" class="btn btn-sm video-split-resume" :disabled="splitStarting || auditRunning" @click="resumeSplit">{{ t('episode.sb.resumeSplit') }}</button>
              </div>
              <div v-if="isCompact && !isComfyVideoMode" class="video-tablet-bar">
                <div class="video-tablet-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    id="video-tab-shots"
                    class="video-tablet-tab"
                    :class="{ on: tabletPane === 'shots' }"
                    :aria-selected="tabletPane === 'shots'"
                    aria-controls="video-panel-shots"
                    :tabindex="tabletPane === 'shots' ? 0 : -1"
                    @click="setTabletPane('shots')"
                    @keydown="onTabletTabsKeydown($event, 'shots')"
                  >
                    {{ t('tablet.tabs.shots') }}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="video-tab-edit"
                    class="video-tablet-tab"
                    :class="{ on: tabletPane === 'edit' }"
                    :aria-selected="tabletPane === 'edit'"
                    aria-controls="video-panel-edit"
                    :tabindex="tabletPane === 'edit' ? 0 : -1"
                    @click="setTabletPane('edit')"
                    @keydown="onTabletTabsKeydown($event, 'edit')"
                  >
                    {{ t('tablet.tabs.edit') }}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="video-tab-preview"
                    class="video-tablet-tab"
                    :class="{ on: tabletPane === 'preview' }"
                    :aria-selected="tabletPane === 'preview'"
                    aria-controls="video-panel-preview"
                    :tabindex="tabletPane === 'preview' ? 0 : -1"
                    @click="setTabletPane('preview')"
                    @keydown="onTabletTabsKeydown($event, 'preview')"
                  >
                    {{ t('tablet.tabs.preview') }}
                  </button>
                </div>
                <button v-if="isNarrow" type="button" class="video-tablet-steps-btn" @click="openStepsDrawer">
                  {{ t('tablet.drawers.steps') }}
                </button>
              </div>
<EpisodeStoryboardList
                :rows="videoTaskRows"
                :filter="videoListFilter"
                :all-count="allVideoTaskRows.length"
                :pending-count="pendingVideoIds.length"
                :done-count="videoTaskDoneCount"
                :failed-count="videoTaskFailedCount"
                :busy="!!rn"
                :adding="addingStoryboard"
                :batch="videoBatch"
                :batch-progress="videoBatchProgress"
                :select-mode="videoSelectMode"
                :selected-ids="selectedVideoSbIds"
                :selected-sb-id="selectedSb?.id ?? null"
                :deleting="shotDelete.loading"
                :is-compact="isCompact"
                :tablet-pane="tabletPane"
                :is-comfy-video-mode="isComfyVideoMode"
                :comfy-pending-task-id="comfyPendingTaskId"
                :comfy-running="comfyRunning"
                :remote-readonly="remoteReadonly"
                :comfy-config-name="comfyConfigName"
                :comfy-ui-gateway="comfyUiGateway"
                :comfy-preview="comfyPreview"
                :comfy-ui-loading="comfyUiLoading"
                :comfy-ui-url="comfyUiUrl"
                :comfy-ui-error="comfyUiError"
                :comfy-preview-error="comfyPreviewError"
                :comfy-ui-frame-key="comfyUiFrameKey"
                @filter="toggleVideoFilter"
                @add="addStoryboard"
                @stop-batch="stopBatchVideo"
                @close-batch="videoBatch = null"
                @select-all="toggleSelectAllVideos"
                @select-missing="selectMissingVideos"
                @clear-selection="selectedVideoSbIds = []"
                @pointer-down="onVideoTaskPointerDown"
                @context-menu="onVideoTaskContextMenu"
                @row-click="onVideoTaskRowClick"
                @generate="sb => genVid(sb)"
                @regenerate="sb => genVid(sb, { forceNew: true })"
                @copy-diagnostics="copyVideoDiagnostics"
                @open-audit="openAuditPanel"
                @delete="deleteStoryboard"
                @open-menu="openTaskMenu"
                @mode-change="changeEpisodeVideoMode"
                @run-comfy="runComfyEpisode"
                @reload-comfy="reloadComfyUi"
                @open-comfy="openComfyUI"
                @open-comfy-settings="goComfySettings"
              />

              <div v-if="selectedSb && !isComfyVideoMode" class="video-task-side" data-tablet-pane="edit" :role="isCompact && tabletPane === 'edit' ? 'tabpanel' : undefined" :aria-labelledby="isCompact && tabletPane === 'edit' ? 'video-tab-edit' : undefined" :id="isCompact ? 'video-panel-edit' : undefined" v-show="!isCompact || tabletPane !== 'shots'">
              <button v-if="isCompact && tabletPane === 'edit'" type="button" class="btn video-tablet-back" @click="setTabletPane('shots')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                {{ t('tablet.back') }}
              </button>
              <EpisodeShotEditor
                ref="shotEditorRef"
                :visible="!isCompact || tabletPane === 'edit'"
                :storyboard="selectedSb"
                :transition-options="transitionOptions"
                :ref-bindable-assets="refBindableAssets"
                :ref-kinds="REF_KINDS"
                :mention-options="mentionOptions"
                :prompt-generating="videoPromptGeneratingIds.includes(selectedSb?.id)"
                :prompt-batch-running="videoPromptBatch.running"
                :previous-shot-frame-ref="previousShotFrameRef"
                @update-field="(field, value) => updateField(selectedSb, field, value)"
                @toggle-bind="asset => toggleShotBind(selectedSb, asset)"
                @open-viewer="openImageViewer"
                @generate-prompt="genVideoPrompt(selectedSb)"
                @goto-generate="prodTab = 'assets'"
              />
              <aside class="video-task-inspector">
            <div v-if="!isComfyVideoMode" class="video-preview-pane" data-tablet-pane="preview" :role="isCompact ? 'tabpanel' : undefined" :aria-labelledby="isCompact ? 'video-tab-preview' : undefined" :id="isCompact ? 'video-panel-preview' : undefined" v-show="!isCompact || tabletPane === 'preview'">
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
                  v-if="canExtractLastFrame"
                  class="btn btn-sm"
                  :disabled="frameAssetExtracting"
                  :title="t('episode.frameAssets.extractTitle')"
                  @click="extractShotLastFrame(selectedSb)"
                >
                  <Loader2 v-if="frameAssetExtracting" :size="11" class="animate-spin" />
                  {{ frameAssetExtracting ? t('episode.frameAssets.extracting') : t('episode.frameAssets.extract') }}
                </button>
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
                  ref="videoPlayerEl"
                  :key="playerVideoUrl"
                  :src="playerVideoUrl"
                  :poster="playerIsRemote ? undefined : posterOf(playerVideoUrl) || undefined"
                  @error="playerLoadFailed = true"
                  controls
                  preload="metadata"
                  playsinline
                  webkit-playsinline
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
                    :disabled="remoteReadonly"
                    :title="remoteReadonly ? t('remote.readonly.notice') : undefined"
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
                  <video :src="videoSourceUrl(taskVideoPath(h))" :poster="posterOf(videoSourceUrl(taskVideoPath(h))) || undefined" preload="none" muted playsinline webkit-playsinline tabindex="-1" />
                  <span class="video-history-time">{{ formatHistoryTime(taskCreatedAt(h)) }}</span>
                  <span v-if="isCurrentVideo(h)" class="video-history-badge">{{ t('episode.vid.current') }}</span>
                  <button v-else type="button" class="video-history-del" :title="t('episode.vid.deleteRecord')" @click.stop="removeHistoryVideo(h)">×</button>
                </div>
              </div>
            </div>
            </div>
                <EpisodeShotInspector
                  :visible="!isCompact || tabletPane === 'edit'"
                  :storyboard="selectedSb"
                  :bound-ref-assets="boundRefAssets"
                  :frame-assets="frameAssetsForInspector"
                  :previous-shot-frame-ref="previousShotFrameRef"
                  :frame-asset-busy-id="frameAssetBusyId"
                  :duration-max="videoDurationMax"
                  :duration-over-limit="videoDurationOverLimit"
                  :effective-video-duration="effectiveVideoDuration"
                  :effective-summary="inspectorEffectiveSummary"
                  :action-label="videoTaskActionLabel(selectedSb)"
                  :action-disabled="videoTaskState(selectedSb) === 'pending' || remoteReadonly"
                  :readonly-title="remoteReadonly ? t('remote.readonly.notice') : undefined"
                  @open-viewer="openImageViewer"
                  @clear-first-frame="clearShotFirstFrame(selectedSb)"
                  @set-first-frame="setShotFirstFrame"
                  @remove-frame-asset="removeFrameAsset"
                  @update-duration="onVideoDurationChange"
                  @generate="genVid(selectedSb)"
                />

              </aside>
              <div v-show="isCompact && tabletPane === 'edit' && !isComfyVideoMode" class="video-tablet-actions">
                <button type="button" class="btn btn-primary" :disabled="!selectedSb || videoTaskState(selectedSb) === 'pending'" @click="genVid(selectedSb)">
                  {{ videoTaskActionLabel(selectedSb) }}
                </button>
                <button type="button" class="btn" :disabled="!sbs.length" @click="batchVideos()">
                  {{ t('episode.vid.batchVideos') }}
                </button>
                <button type="button" class="btn" @click="saveTabletEdit">
                  {{ t('common.save') }}
                </button>
              </div>
              </div>
              <div
                class="video-col-divider is-left"
                role="separator"
                aria-orientation="vertical"
                @pointerdown="startVideoColDrag('left', $event)"
                @dblclick="resetVideoCol('left')"
              ></div>
              <div
                v-if="!isComfyVideoMode"
                class="video-col-divider is-right"
                role="separator"
                aria-orientation="vertical"
                @pointerdown="startVideoColDrag('right', $event)"
                @dblclick="resetVideoCol('right')"
              ></div>
            </div>
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
            <ExportUnavailableNotice v-if="exportLocalOnly" />
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
                  @click="m.status === 'completed' && m.merged_url && openActiveMerge(m)"
                  @keydown.enter.prevent="m.status === 'completed' && m.merged_url && openActiveMerge(m)"
                >
                  <div class="merge-card-thumb">
                    <video
                      v-if="m.status === 'completed' && m.merged_url"
                      :src="'/' + m.merged_url"
                      :poster="posterOf('/' + m.merged_url) || undefined"
                      preload="none"
                      muted
                      playsinline
                      webkit-playsinline
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
                      v-if="isTablet && m.status === 'completed' && m.merged_url"
                      class="btn btn-sm"
                      @click.stop="shareMergeFilm(m)"
                    >
                      <Share2 :size="11" />
                      {{ t('tablet.share.label') }}
                    </button>
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

            <!-- 平板:合并状态常驻(无百分比,不依赖 toast) -->
            <div
              v-if="isTablet && mergeData && mergeData.status !== 'completed'"
              :class="['merge-status-card', mergeData.status === 'failed' && 'is-failed']"
              role="status"
            >
              <div class="merge-status-head">
                <AlertCircle v-if="mergeData.status === 'failed'" :size="13" />
                <Loader2 v-else :size="13" class="animate-spin" />
                <span class="merge-status-title">
                  {{ mergeData.status === 'failed' ? t('episode.export.mergeFailed') : t('episode.export.merging') }}
                </span>
                <span v-if="mergeData.title" class="merge-status-name truncate">{{ mergeData.title }}</span>
              </div>
              <div v-if="mergeData.status !== 'failed'" class="merge-status-bar" aria-hidden="true"><span /></div>
              <p v-else-if="mergeData.error_msg || mergeData.errorMsg" class="merge-status-error">{{ mergeData.error_msg || mergeData.errorMsg }}</p>
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
                <div class="ml-auto flex gap-1 export-head-actions">
                  <button class="btn btn-sm" :disabled="!exportReadyIds.length" @click="toggleSelectAllExport">
                    {{ exportSelectedReadyIds.length === exportReadyIds.length && exportReadyIds.length ? t('episode.export.clearSelection') : t('episode.export.selectAllReady') }}
                  </button>
                  <button
                    class="btn btn-sm btn-primary"
                    :disabled="!exportSelectedReadyIds.length || exportLocalOnly"
                    :title="exportLocalOnly ? t('export.gate.unavailable') : undefined"
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
                      webkit-playsinline
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
                      @click.stop="openPreviewShot(sb)"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                    </span>
                    <span v-if="hasVid(sb)" :class="['exp-check', isExportSelected(sb.id) && 'on']">
                      <svg v-if="isExportSelected(sb.id)" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </span>
                  </div>
                  <div class="exp-row-line">
                    <span v-if="storyboardTransitionKind(sb)" class="exp-transition-tag">{{ t(`episode.audit.transition.kind.${storyboardTransitionKind(sb)}`) }}</span>
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
                <button class="btn btn-sm ml-auto" @click="openTransitionCreate()">
                  <Plus :size="11" />
                  {{ t('episode.export.aiTransition.addCustom') }}
                </button>
                <span v-if="transitionCards.length" class="dim" style="font-size:11px">{{ t('episode.export.aiTransition.cardHint') }}</span>
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
                      v-if="b.first_frame_upload_url || b.first_frame_url"
                      :src="'/' + (b.first_frame_upload_url || b.first_frame_url)"
                      :alt="transitionPairLabel(b)"
                      loading="lazy"
                    />
                    <div v-else class="ai-transition-card-empty">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                    </div>
                    <span :class="['ai-transition-status', transitionStatusClass(b)]">{{ transitionStatusLabel(b) }}</span>
                    <span class="ai-transition-kind">{{ transitionKindLabel(b) }}</span>
                    <span v-if="b.degraded" class="ai-transition-degraded">{{ t('episode.export.aiTransition.degraded') }}</span>
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

            <!-- 平板:底部粘性操作栏(1180 内可见,替代头部操作) -->
            <div v-if="isTablet" class="export-sticky-bar">
              <button class="btn btn-sm" :disabled="!exportReadyIds.length" @click="toggleSelectAllExport">
                {{ exportSelectedReadyIds.length === exportReadyIds.length && exportReadyIds.length ? t('episode.export.clearSelection') : t('episode.export.selectAllReady') }}
              </button>
              <button class="btn btn-sm" :disabled="!exportReadyIds.length" @click="invertExportSelection">
                {{ t('episode.export.invertSelection') }}
              </button>
              <button
                class="btn btn-sm btn-primary"
                :disabled="!exportSelectedReadyIds.length || exportLocalOnly"
                :title="exportLocalOnly ? t('export.gate.unavailable') : undefined"
                @click="openMergeDialog"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                {{ t('episode.export.mergeSelected', { n: exportSelectedReadyIds.length }) }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== TASK DRAWER ===== -->
      <EpisodeTaskDrawer
        :open="taskDrawer"
        :rows="visibleTaskCenterRows"
        :total="taskCenterRows.length"
        :active-count="taskCenterActiveCount"
        :done-count="taskCenterDoneCount"
        :failed-count="taskCenterFailedCount"
        :clearable-count="genTaskClearableCount"
        :clearing="clearTasks.loading"
        :tabs="taskCenterTabs"
        :active-tab="taskCenterTab"
        @close="closeTaskDrawer"
        @refresh="loadGenTasks"
        @clear="clearTasks.open = true"
        @update:tab="taskCenterTab = $event"
        @recover="recoverTask"
        @diagnostics="copyTaskDiagnostics"
        @view-image="openImageViewer"
      />


      <!-- ===== STORYBOARD AUDIT DRAWER ===== -->
      <StoryboardAuditDrawer
        :open="auditPanel.open"
        :status-text="auditStatusText"
        :job="auditJob"
        :busy="auditBusy"
        :running="auditRunning"
        :progress-percent="auditProgressPercent"
        :semantic-note="auditSemanticNote"
        :shot-label="auditShotLabel"
        :filter="auditPanelFilter"
        :filter-options="auditFilterOptions"
        :issues="auditPanelIssues"
        :check-groups="auditCheckGroups"
        :can-run="!!sbs.length"
        @close="closeAuditPanel"
        @run="runStoryboardAudit()"
        @undo="undoAuditRepair()"
        @update:filter="auditPanelFilter = $event"
        @show-all-shots="auditPanel = { ...auditPanel, shotId: null }"
        @locate="locateAuditShot"
        @create-transition="openTransitionCreateFromIssue"
        @goto-assets="gotoAssetPage"
      />

      <div v-if="assetDetail.open && assetDetailItem" class="overlay asset-detail-overlay" @click.self="closeAssetDetail">
        <section
          class="dialog asset-detail-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="t('episode.asset.detailTitle', { type: assetTypeLabel(assetDetail.type) })"
        >
          <header class="dialog-head asset-detail-head">
            <div class="asset-detail-title-block">
              <span class="asset-detail-kicker">{{ assetTypeLabel(assetDetail.type) }}</span>
              <h2 class="asset-detail-title">{{ assetDetailTitle(assetDetail.type, assetDetailItem) }}</h2>
            </div>
            <div class="asset-detail-head-actions">
              <span class="tag" v-if="assetDetail.type === 'character'">{{ assetDetailItem.role || t('common.role') }}</span>
              <span class="tag" v-else-if="assetDetail.type === 'prop'">{{ assetDetailItem.type || t('common.prop') }}</span>
              <span class="tag" v-else>{{ assetDetailItem.time || t('episode.asset.noTime') }}</span>
              <button class="btn btn-ghost btn-icon" @click="closeAssetDetail">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
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
                        @click.stop="removeAssetReference(assetDetail.type, assetDetailItem, index)"
                      >
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>
                    <button
                      v-if="assetDetailRefs.length < MAX_ASSET_REFS"
                      type="button"
                      class="asset-ref-add"
                      :disabled="isUploadingAssetRef(assetDetail.type, assetDetailItem.id)"
                      :title="t('episode.asset.refAdd')"
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
              <button class="btn btn-danger" @click="askDeleteAsset(assetDetail.type, assetDetailItem)">{{ t('common.delete') }}</button>
              <button class="btn" @click="closeAssetDetail">{{ t('common.close') }}</button>
            </div>
            <div class="asset-detail-primary-actions">
              <button
                class="btn"
                :disabled="isUploadingAsset(assetDetail.type, assetDetailItem.id)"
                @click="uploadAssetImage(assetDetail.type, assetDetailItem.id)"
              >
                <Loader2 v-if="isUploadingAsset(assetDetail.type, assetDetailItem.id)" :size="11" class="animate-spin" />
                <svg v-else width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                {{ t('episode.asset.uploadImage') }}
              </button>
              <button
                v-if="assetDetail.type === 'character'"
                class="btn"
                :disabled="isPendingCharImage(assetDetailItem.id)"
                @click="genCharImg(assetDetailItem.id)"
              >
                {{ assetImageSrc(assetDetailItem) ? t('episode.asset.regenPortrait') : (isPendingCharImage(assetDetailItem.id) ? t('episode.asset.generating') : t('episode.asset.genPortrait')) }}
              </button>
              <button
                v-else-if="assetDetail.type === 'scene'"
                class="btn"
                :disabled="isPendingSceneImage(assetDetailItem.id)"
                @click="genSceneImg(assetDetailItem.id)"
              >
                {{ assetImageSrc(assetDetailItem) ? t('episode.asset.regenScene') : (isPendingSceneImage(assetDetailItem.id) ? t('episode.asset.generating') : t('episode.asset.genScene')) }}
              </button>
              <button
                v-else-if="assetDetail.type === 'prop'"
                class="btn"
                :disabled="isPendingPropImage(assetDetailItem.id)"
                @click="genPropImg(assetDetailItem.id)"
              >
                {{ assetImageSrc(assetDetailItem) ? t('episode.asset.regenProp') : (isPendingPropImage(assetDetailItem.id) ? t('episode.asset.generating') : t('episode.asset.genProp')) }}
              </button>
              <button class="btn btn-primary" :disabled="savingAssetDetail || remoteReadonly" :title="remoteReadonly ? t('remote.readonly.notice') : undefined" @click="saveAssetDetail">
                <Loader2 v-if="savingAssetDetail" :size="12" class="animate-spin" />
                {{ t('episode.asset.saveChanges') }}
              </button>
            </div>
          </footer>
        </section>
      </div>

      <div v-if="imageViewer.open && imageViewer.src" class="overlay image-viewer-overlay" @click.self="closeImageViewer">
        <div class="dialog image-viewer-dialog">
          <div class="image-viewer-head">
            <div class="image-viewer-title">{{ imageViewer.title || t('episode.viewer.imagePreview') }}</div>
            <button class="btn btn-ghost btn-icon" @click="closeImageViewer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="image-viewer-body">
            <img :src="imageViewer.src" :alt="imageViewer.title || t('episode.viewer.imagePreview')" class="image-viewer-img" />
          </div>
        </div>
      </div>

      <div v-if="previewShot" class="overlay image-viewer-overlay" @click.self="closePreviewShot">
        <div class="dialog image-viewer-dialog merge-viewer-dialog">
          <div class="image-viewer-head">
            <div class="image-viewer-title">{{ previewShot.previewLabel || t('episode.export.shotPreview', { n: shotNumberOf(previewShot) }) }}</div>
            <span v-if="previewShot.duration" class="dim" style="font-size:11px">{{ Number(previewShot.duration).toFixed(2).replace(/\.00$/, '') }}s</span>
            <a :href="'/' + getVideoUrl(previewShot)" :download="previewShot.downloadName || ''" class="btn btn-sm" style="margin-left:auto">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {{ t('common.download') }}
            </a>
            <button v-if="isTablet" class="btn btn-sm" @click.stop="sharePreviewShot(previewShot)">
              <Share2 :size="11" />
              {{ t('tablet.share.label') }}
            </button>
            <button class="btn btn-ghost btn-icon" @click="closePreviewShot">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <p v-if="isTablet && showReviewLandscapeHint" class="tablet-landscape-hint">{{ t('tablet.status.landscapeHint') }}</p>
          <div class="merge-viewer-body">
            <video
              :key="previewShot.id"
              :src="'/' + getVideoUrl(previewShot)"
              controls
              preload="metadata"
              playsinline
              webkit-playsinline
              class="merge-viewer-video"
              @loadedmetadata="onReviewVideoMetadata"
            />
          </div>
          <p v-if="isTablet" class="tablet-save-hint">{{ t('tablet.share.saveHint') }}</p>
        </div>
      </div>

      <div v-if="transitionCreate.open" class="overlay" @click.self="closeTransitionCreate">
        <div class="dialog transition-create-dialog">
          <header class="dialog-head">
            <div class="image-viewer-title">{{ t('episode.audit.transition.title') }}</div>
            <span class="audit-kind-hint">{{ t('episode.audit.transition.kindLabel') }}: {{ t(`episode.audit.transition.kind.${transitionCreate.kind}`) }}</span>
            <button class="btn btn-ghost btn-icon" style="margin-left:auto" @click="closeTransitionCreate"><X :size="14" /></button>
          </header>
          <div class="dialog-body transition-create-body">
            <MediaCapabilityNotice v-if="!mediaOutputReady" action="output" mode="inline" />
            <label class="transition-create-field">
              <span>{{ t('episode.audit.transition.boundary', { pair: transitionCreatePairLabel() || '—' }) }}</span>
              <select v-if="!transitionCreate.fromId" v-model="transitionCreate.pairKey" class="input" :disabled="transitionCreate.submitting">
                <option v-for="pair in transitionCreatePairs" :key="pair.key" :value="pair.key">{{ pair.label }}</option>
              </select>
              <span v-else class="transition-create-fixed">{{ transitionCreatePairLabel() }}</span>
            </label>
            <label class="transition-create-field">
              <span>{{ t('episode.audit.transition.kindName') }}</span>
              <select v-model="transitionCreate.kind" class="input" :disabled="transitionCreate.submitting">
                <option v-for="option in transitionCreateKindOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label class="transition-create-field">
              <span>{{ t('episode.audit.transition.duration') }}</span>
              <select v-model.number="transitionCreate.duration" class="input" :disabled="transitionCreate.submitting">
                <option v-for="value in TRANSITION_CUSTOM_DURATIONS" :key="value" :value="value">{{ value }}s</option>
              </select>
            </label>
            <label v-if="transitionCreate.kind === 'fade'" class="transition-create-field">
              <span>{{ t('episode.audit.transition.fadeStyleLabel') }}</span>
              <select v-model="transitionCreate.style" class="input" :disabled="transitionCreate.submitting">
                <option v-for="option in fadeStyleOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
              <span class="dim" style="font-size:11px">{{ t('episode.audit.transition.fadeHint') }}</span>
            </label>
            <label v-if="transitionCreate.kind === 'scene'" class="transition-create-field">
              <span>{{ t('episode.audit.transition.scene') }}</span>
              <select v-model.number="transitionCreate.sceneId" class="input" :disabled="transitionCreate.submitting">
                <option :value="null">{{ t('episode.audit.transition.scenePlaceholder') }}</option>
                <option v-for="scene in transitionCreateScenes" :key="scene.id" :value="scene.id">{{ scene.label }}</option>
              </select>
            </label>
            <template v-if="transitionCreate.kind === 'text'">
              <label class="transition-create-field">
                <span>{{ t('episode.audit.transition.textContent') }}</span>
                <input v-model="transitionCreate.title" class="input" maxlength="20" :disabled="transitionCreate.submitting" :placeholder="t('episode.audit.transition.textHint')" />
              </label>
              <label class="transition-create-field">
                <span>{{ t('episode.audit.transition.textSubtitle') }}</span>
                <input v-model="transitionCreate.subtitle" class="input" maxlength="40" :disabled="transitionCreate.submitting" />
              </label>
              <label class="transition-create-field">
                <span>{{ t('episode.audit.transition.scene') }}</span>
                <select v-model.number="transitionCreate.sceneId" class="input" :disabled="transitionCreate.submitting">
                  <option :value="null">{{ t('episode.audit.transition.scenePlaceholder') }}</option>
                  <option v-for="scene in transitionCreateScenes" :key="scene.id" :value="scene.id">{{ scene.label }}</option>
                </select>
              </label>
            </template>
            <label v-if="transitionCreate.kind !== 'text' && transitionCreate.kind !== 'fade'" class="transition-create-field">
              <span>{{ t('episode.audit.transition.prompt') }}</span>
              <textarea v-model="transitionCreate.prompt" class="input" rows="4" maxlength="1200" :disabled="transitionCreate.submitting" :placeholder="t('episode.audit.transition.promptPlaceholder')" />
            </label>
          </div>
          <footer class="dialog-foot">
            <button class="btn" style="margin-left:auto" :disabled="transitionCreate.submitting" @click="closeTransitionCreate">{{ t('episode.audit.transition.cancel') }}</button>
            <button class="btn btn-primary" :disabled="transitionCreate.submitting || remoteReadonly || !mediaOutputReady" :title="remoteReadonly ? t('remote.readonly.notice') : undefined" @click="transitionCreateSubmit()">
              <Loader2 v-if="transitionCreate.submitting" :size="11" class="animate-spin" />
              {{ transitionCreate.submitting ? t('episode.audit.transition.submitting') : t('episode.audit.transition.submit') }}
            </button>
          </footer>
        </div>
      </div>

      <div v-if="transitionDetailBoundary" class="overlay" @click.self="closeTransitionDetail">
        <div class="dialog transition-detail-dialog">
          <header class="dialog-head">
            <div class="image-viewer-title">{{ t('episode.export.aiTransition.detailTitle') }}</div>
            <span class="ai-transition-kind">{{ transitionKindLabel(transitionDetailBoundary) }}</span>
            <span :class="['ai-transition-status', transitionStatusClass(transitionDetailBoundary)]">
              {{ transitionStatusLabel(transitionDetailBoundary) }}
            </span>
            <span class="dim" style="font-size:11px">{{ transitionPairLabel(transitionDetailBoundary) }}</span>
            <span v-if="transitionDurationLabel(transitionDetailBoundary)" class="dim" style="font-size:11px">
              {{ transitionDurationLabel(transitionDetailBoundary) }}
            </span>
            <button class="btn btn-ghost btn-icon" style="margin-left:auto" @click="closeTransitionDetail">
              <X :size="14" />
            </button>
          </header>
          <div class="dialog-body transition-detail-body">
            <MediaCapabilityNotice v-if="!mediaOutputReady" action="output" mode="inline" />
            <div v-if="transitionDetailBoundary.video_url" class="transition-detail-video">
              <video
                :key="transitionDetailBoundary.video_url"
                :src="'/' + transitionDetailBoundary.video_url"
                :poster="posterOf('/' + transitionDetailBoundary.video_url) || undefined"
                controls
                preload="metadata"
                playsinline
                webkit-playsinline
              />
            </div>
            <div v-else-if="transitionDetailBoundary.error_msg" class="transition-detail-error">
              {{ mapError(transitionDetailBoundary.error_msg) }}
            </div>
            <div class="transition-detail-modes">
              <span class="dim" style="font-size:11px">{{ t('episode.export.aiTransition.switchKind') }}</span>
              <button
                v-for="option in transitionCreateKindOptions.filter(item => item.value !== transitionKindOf(transitionDetailBoundary))"
                :key="option.value"
                type="button"
                class="btn btn-sm"
                :disabled="transitionDetailBoundary.status === 'processing' || transitionDetailBoundary.status === 'pending'"
                @click="switchTransitionKind(transitionDetailBoundary, option.value)"
              >{{ option.label }}</button>
            </div>
            <template v-if="transitionKindOf(transitionDetailBoundary) === 'ai'">
            <div v-if="transitionDetailEffectiveFrameUrl(transitionDetailBoundary, 'first') || transitionDetailEffectiveFrameUrl(transitionDetailBoundary, 'last')" class="transition-detail-frames">
              <button
                v-if="transitionDetailEffectiveFrameUrl(transitionDetailBoundary, 'first')"
                type="button"
                class="transition-detail-frame"
                @click="openImageViewer('/' + transitionDetailEffectiveFrameUrl(transitionDetailBoundary, 'first'), t('episode.export.aiTransition.firstFrame'))"
              >
                <img :src="'/' + transitionDetailEffectiveFrameUrl(transitionDetailBoundary, 'first')" :alt="t('episode.export.aiTransition.firstFrame')" loading="lazy" />
                <span>{{ t('episode.export.aiTransition.firstFrame') }}</span>
                <span v-if="transitionUploadedFrameUrl(transitionDetailBoundary, 'first')" class="transition-slot-tag">{{ t('episode.export.aiTransition.slotUploadedTag') }}</span>
              </button>
              <button
                v-if="transitionDetailEffectiveFrameUrl(transitionDetailBoundary, 'last')"
                type="button"
                class="transition-detail-frame"
                @click="openImageViewer('/' + transitionDetailEffectiveFrameUrl(transitionDetailBoundary, 'last'), t('episode.export.aiTransition.lastFrame'))"
              >
                <img :src="'/' + transitionDetailEffectiveFrameUrl(transitionDetailBoundary, 'last')" :alt="t('episode.export.aiTransition.lastFrame')" loading="lazy" />
                <span>{{ t('episode.export.aiTransition.lastFrame') }}</span>
                <span v-if="transitionUploadedFrameUrl(transitionDetailBoundary, 'last')" class="transition-slot-tag">{{ t('episode.export.aiTransition.slotUploadedTag') }}</span>
              </button>
            </div>
            <div v-if="transitionDetailBoundary.id" class="transition-detail-slots">
              <div class="transition-slot-row">
                <button
                  type="button"
                  class="btn btn-sm"
                  :disabled="transitionRefBusy['slot:first:' + transitionDetailBoundary.id]"
                  @click="uploadTransitionSlotImage(transitionDetailBoundary, 'first')"
                >
                  {{ transitionRefBusy['slot:first:' + transitionDetailBoundary.id]
                    ? t('episode.export.aiTransition.slotUploading')
                    : t('episode.export.aiTransition.slotUpload') }}
                </button>
                <button
                  v-if="transitionUploadedFrameUrl(transitionDetailBoundary, 'first')"
                  type="button"
                  class="btn btn-sm btn-ghost"
                  :disabled="transitionRefBusy['slot:first:' + transitionDetailBoundary.id]"
                  @click="resetTransitionSlot(transitionDetailBoundary, 'first')"
                >
                  {{ t('episode.export.aiTransition.slotRestore') }}
                </button>
              </div>
              <div class="transition-slot-row">
                <button
                  type="button"
                  class="btn btn-sm"
                  :disabled="transitionRefBusy['slot:last:' + transitionDetailBoundary.id]"
                  @click="uploadTransitionSlotImage(transitionDetailBoundary, 'last')"
                >
                  {{ transitionRefBusy['slot:last:' + transitionDetailBoundary.id]
                    ? t('episode.export.aiTransition.slotUploading')
                    : t('episode.export.aiTransition.slotUpload') }}
                </button>
                <button
                  v-if="transitionUploadedFrameUrl(transitionDetailBoundary, 'last')"
                  type="button"
                  class="btn btn-sm btn-ghost"
                  :disabled="transitionRefBusy['slot:last:' + transitionDetailBoundary.id]"
                  @click="resetTransitionSlot(transitionDetailBoundary, 'last')"
                >
                  {{ t('episode.export.aiTransition.slotRestore') }}
                </button>
              </div>
            </div>
            <p v-if="transitionDetailEffectiveFrameUrl(transitionDetailBoundary, 'first') || transitionDetailEffectiveFrameUrl(transitionDetailBoundary, 'last')" class="ai-transition-prompt-note">
              {{ t('episode.export.aiTransition.framesHint') }}
            </p>
            <div v-if="transitionDetailBoundary.id" class="transition-ref-section">
              <div class="transition-ref-head">
                <span class="transition-ref-title">{{ t('episode.export.aiTransition.refsTitle') }}</span>
                <button
                  type="button"
                  class="btn btn-sm"
                  :disabled="transitionRefBusy['refs:' + transitionDetailBoundary.id]"
                  @click="addTransitionReferences(transitionDetailBoundary)"
                >
                  {{ transitionRefBusy['refs:' + transitionDetailBoundary.id]
                    ? t('episode.export.aiTransition.refsAdding')
                    : t('episode.export.aiTransition.refsAdd') }}
                </button>
                <span class="dim transition-ref-hint">{{ t('episode.export.aiTransition.refsHint', { n: transitionReferenceLimit() }) }}</span>
              </div>
              <p v-if="!transitionReferenceAllowed() && transitionReferenceUrls(transitionDetailBoundary).length" class="ai-transition-prompt-note transition-ref-warning">
                {{ t('episode.export.aiTransition.refsNotAllowed') }}
              </p>
              <div v-if="transitionReferenceUrls(transitionDetailBoundary).length" class="transition-ref-list">
                <div
                  v-for="(url, i) in transitionReferenceUrls(transitionDetailBoundary)"
                  :key="`${url}-${i}`"
                  class="transition-ref-item"
                >
                  <img
                    :src="'/' + url"
                    :alt="t('episode.export.aiTransition.refsTitle')"
                    loading="lazy"
                    @click="openImageViewer('/' + url, t('episode.export.aiTransition.refsTitle'))"
                  />
                  <button
                    type="button"
                    class="transition-ref-remove"
                    :disabled="transitionRefBusy['refs:' + transitionDetailBoundary.id]"
                    :aria-label="t('episode.export.aiTransition.refsRemoved')"
                    @click="removeTransitionReference(transitionDetailBoundary, i)"
                  >
                    <X :size="10" />
                  </button>
                </div>
              </div>
              <p v-else class="dim transition-ref-empty">{{ t('episode.export.aiTransition.refsEmpty') }}</p>
            </div>
            <div class="ai-transition-prompt transition-detail-prompt">
              <div class="ai-transition-prompt-head">
                <span :class="['ai-transition-prompt-source', transitionPromptSourceClass(transitionDetailBoundary)]">
                  {{ transitionPromptSourceLabel(transitionDetailBoundary) }}
                </span>
                <button
                  class="btn btn-sm btn-ghost"
                  :disabled="transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)] || !mediaOutputReady"
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
                :disabled="transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)] || !mediaOutputReady"
                :aria-label="t('episode.export.aiTransition.prompt.label')"
                :placeholder="t('episode.export.aiTransition.prompt.placeholder')"
                @input="markTransitionPromptDirty(transitionDetailBoundary)"
              />
              <div class="ai-transition-prompt-actions">
                <button
                  class="btn btn-sm"
                  :disabled="transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)] || !mediaOutputReady"
                  @click="saveTransitionPromptItem(transitionDetailBoundary)"
                >
                  {{ t('episode.export.aiTransition.prompt.save') }}
                </button>
                <button
                  class="btn btn-sm btn-primary"
                  :disabled="transitionPromptBusy[transitionPromptKey(transitionDetailBoundary)]
                    || transitionDetailBoundary.status === 'processing' || transitionDetailBoundary.status === 'pending'"
                  @click="regenerateTransitionWithPrompt(transitionDetailBoundary)"
                >
                  {{ t('episode.export.aiTransition.prompt.regenerate') }}
                </button>
              </div>
              <p v-if="transitionPromptEffectiveSource(transitionDetailBoundary) === 'fallback'" class="ai-transition-prompt-note">
                {{ t('episode.export.aiTransition.prompt.fallbackNote') }}
              </p>
              <p class="ai-transition-prompt-note">{{ t('episode.export.aiTransition.prompt.hint') }}</p>
            </div>
            </template>
            <template v-else>
              <div class="transition-detail-custom">
                <p v-if="transitionDetailBoundary.degraded" class="ai-transition-prompt-note transition-detail-degraded">
                  {{ t('episode.export.aiTransition.degraded') }}
                </p>
                <div v-if="transitionDetailBoundary.text_content" class="transition-detail-custom-text">
                  <strong>{{ transitionDetailBoundary.text_content }}</strong>
                  <span v-if="transitionDetailBoundary.text_subtitle" class="dim">{{ transitionDetailBoundary.text_subtitle }}</span>
                </div>
                <p v-if="transitionDetailBoundary.prompt" class="transition-detail-custom-text">{{ transitionDetailBoundary.prompt }}</p>
                <p v-if="transitionKindOf(transitionDetailBoundary) === 'fade'" class="transition-detail-custom-note">
                  {{ t('episode.audit.transition.fadeStyleLabel') }}: {{ fadeStyleLabel(transitionDetailBoundary.style) }}
                </p>
                <p v-if="transitionDetailBoundary.scene_id" class="dim transition-detail-custom-note">
                  {{ getSceneName({ scene_id: transitionDetailBoundary.scene_id }) }}
                </p>
                <button
                  class="btn btn-sm"
                  :disabled="transitionDetailBoundary.status === 'processing' || transitionDetailBoundary.status === 'pending'"
                  @click="editTransitionCustom(transitionDetailBoundary)"
                >{{ t('episode.export.aiTransition.editCustom') }}</button>
              </div>
            </template>
          </div>
          <footer class="dialog-foot">
            <button
              class="btn btn-ghost transition-detail-delete"
              :disabled="transitionDetailBoundary.status === 'processing' || transitionDetailBoundary.status === 'pending'"
              :title="transitionDetailBoundary.status === 'processing' || transitionDetailBoundary.status === 'pending' ? t('episode.export.aiTransition.processingHint') : null"
              @click="askDeleteTransition(transitionDetailBoundary)"
            >
              <Trash2 :size="12" />
              {{ t('episode.export.aiTransition.delete') }}
            </button>
            <button class="btn" style="margin-left:auto" @click="closeTransitionDetail">{{ t('common.close') }}</button>
          </footer>
        </div>
      </div>

      <div v-if="activeMerge" class="overlay image-viewer-overlay" @click.self="closeActiveMerge">
        <div class="dialog image-viewer-dialog merge-viewer-dialog">
          <div class="image-viewer-head">
            <div class="image-viewer-title">{{ activeMerge.title || t('episode.viewer.filmPreview') }}</div>
            <span class="dim" style="font-size:11px">{{ formatHistoryTime(activeMerge.created_at) }}<template v-if="activeMerge.duration"> · {{ activeMerge.duration }}s</template></span>
            <a :href="'/' + activeMerge.merged_url" :download="mergeDownloadName(activeMerge)" class="btn btn-sm" style="margin-left:auto">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              {{ t('episode.viewer.downloadFilm') }}
            </a>
            <button v-if="isTablet" class="btn btn-sm" @click.stop="shareMergeFilm(activeMerge)">
              <Share2 :size="11" />
              {{ t('tablet.share.label') }}
            </button>
            <button class="btn btn-ghost btn-icon" @click="closeActiveMerge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <p v-if="isTablet && showReviewLandscapeHint" class="tablet-landscape-hint">{{ t('tablet.status.landscapeHint') }}</p>
          <div class="merge-viewer-body">
            <video
              :key="activeMerge.id"
              :src="'/' + activeMerge.merged_url"
              controls
              preload="metadata"
              playsinline
              webkit-playsinline
              class="merge-viewer-video"
              @loadedmetadata="onReviewVideoMetadata"
            />
          </div>
          <p v-if="isTablet" class="tablet-save-hint">{{ t('tablet.share.saveHint') }}</p>
        </div>
      </div>

      <div v-if="assetCreate.open" class="overlay" @click.self="assetCreate.open = false">
        <div class="dialog asset-create-dialog">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.create.title', { type: assetCreateTypeLabel }) }}</h2>
            <button class="btn btn-ghost btn-icon" @click="assetCreate.open = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
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
            <button class="btn" @click="assetCreate.open = false">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" :disabled="assetCreate.saving || remoteReadonly" :title="remoteReadonly ? t('remote.readonly.notice') : undefined" @click="saveAssetCreate">
              <Loader2 v-if="assetCreate.saving" :size="12" class="animate-spin" />
              {{ t('common.add') }}
            </button>
          </footer>
        </div>
      </div>

      <div v-if="batchVideoConfirm.open" class="overlay" @click.self="batchVideoConfirm.open = false">
        <div class="dialog batch-video-dialog">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.vid.confirmTitle') }}</h2>
            <button class="btn btn-ghost btn-icon" @click="batchVideoConfirm.open = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </header>
          <div class="dialog-body batch-video-body">
            <div class="batch-video-row"><span>{{ t('episode.vid.confirmShots') }}</span><strong>{{ t('episode.vid.confirmShotsValue', { n: batchVideoConfirm.targets.length }) }}</strong></div>
            <div class="batch-video-row"><span>{{ t('episode.vid.confirmTotal') }}</span><strong>{{ t('episode.vid.confirmApprox', { n: batchVideoTotalDuration }) }}</strong></div>
            <div class="batch-video-row"><span>{{ t('episode.vid.confirmModel') }}</span><strong>{{ effectiveVideoModelLabel || t('episode.vid.defaultModel') }}</strong></div>
            <div class="batch-video-row"><span>{{ t('episode.vid.confirmResolution') }}</span><strong>{{ episodeResolutionLabel }}</strong></div>
            <label class="batch-video-row batch-video-concurrency">
              <span>{{ t('episode.vid.confirmConcurrency') }}</span>
              <select v-model.number="batchVideoConcurrency" class="batch-video-concurrency-select">
                <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
              </select>
            </label>
            <p class="batch-video-concurrency-hint">{{ t('episode.vid.confirmConcurrencyHint') }}</p>
            <p class="batch-video-note">{{ t('episode.vid.confirmNote') }}</p>
          </div>
          <footer class="dialog-foot">
            <button class="btn" @click="batchVideoConfirm.open = false">{{ t('common.cancel') }}</button>
            <button class="btn btn-primary" :disabled="remoteReadonly" :title="remoteReadonly ? t('remote.readonly.notice') : undefined" @click="confirmBatchVideos">{{ t('episode.vid.confirmStart', { n: batchVideoConfirm.targets.length }) }}</button>
          </footer>
        </div>
      </div>

      <div v-if="mergeDialog.open" class="overlay" @click.self="closeMergeDialog">
        <div class="dialog merge-title-dialog">
          <header class="dialog-head">
            <h2 class="dialog-title">{{ t('episode.export.titleDialog') }}</h2>
            <button class="btn btn-ghost btn-icon" @click="closeMergeDialog">
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
                      <span v-if="transitionRefCountLabel(b)" class="ai-transition-refs-badge">{{ transitionRefCountLabel(b) }}</span>
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
                          :disabled="transitionPreparing || !mediaOutputReady"
                          @click="retryTransitionItem(b)"
                        >
                          {{ t('episode.export.aiTransition.retry') }}
                        </button>
                        <button
                          v-if="b.status === 'skipped'"
                          class="btn btn-sm"
                          :disabled="transitionPreparing || !mediaOutputReady"
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
                          :disabled="transitionPromptBusy[transitionPromptKey(b)] || !mediaOutputReady"
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
                        :disabled="transitionPromptBusy[transitionPromptKey(b)] || !mediaOutputReady"
                        :aria-label="t('episode.export.aiTransition.prompt.label')"
                        :placeholder="t('episode.export.aiTransition.prompt.placeholder')"
                        @input="markTransitionPromptDirty(b)"
                      />
                      <div class="ai-transition-prompt-actions">
                        <button
                          class="btn btn-sm"
                          :disabled="transitionPromptBusy[transitionPromptKey(b)] || !mediaOutputReady"
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
            <button class="btn" @click="closeMergeDialog">{{ t('common.cancel') }}</button>
            <button
              class="btn"
              :disabled="!transitionSupported || transitionPreparing || transitionBusy || !mergeDialogSelectedCount"
              @click="generateMissingTransitions"
            >
              {{ t('episode.export.aiTransition.regenerateMissing') }}
            </button>
            <button class="btn btn-primary" :disabled="!mergeDialog.ids.length || remoteReadonly || exportLocalOnly" :title="remoteReadonly ? t('remote.readonly.notice') : (exportLocalOnly ? t('export.gate.unavailable') : undefined)" @click="confirmMerge">
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

      <ConfirmDialog
        :open="shotDelete.open"
        :title="t('episode.vid.deleteTitle')"
        :message="t('episode.vid.deleteMessage', { title: shotDelete.title, number: shotDelete.number })"
        :confirm-text="t('episode.vid.deleteConfirm')"
        :loading="shotDelete.loading"
        @confirm="confirmDeleteStoryboard"
        @cancel="shotDelete.open = false; shotDelete.target = null"
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
    <ContextMenu
      v-model:show="videoTaskMenu.show"
      :x="videoTaskMenu.x"
      :y="videoTaskMenu.y"
      :items="videoTaskMenu.items"
    />
</template>

<script setup>
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import {
  Users, FileText, FolderKanban, Clapperboard, Download, Loader2,
  Plus, X, ListTodo, CircleHelp, Mic, AudioLines, SlidersHorizontal, Trash2, Scissors, Ellipsis,
  Share2, AlertCircle,
} from 'lucide-vue-next'
import { api, dramaAPI, episodeAPI, storyboardAPI, characterAPI, sceneAPI, propAPI, taskAPI, mergeAPI, transitionAPI, aiConfigAPI, uploadAPI, pipelineRuleAPI, dubbingAPI, filmAPI, breakdownMethodAPI, frameAssetAPI, storyboardSplitAPI, storyboardAuditAPI } from '~/composables/useApi'
import { startTour, autoTour } from '~/composables/useTour'
import { useAgent, coverageShortfall } from '~/composables/useAgent'
import { resolveTextModelSelection } from '~/utils/text-model-selection'
import { episodeResolutionKey, isLocalH3Config, videoResolutionKey, videoResolutionOptions, videoResolutionProvider, videoResolutionVendor } from '~/utils/video-resolution'
import { videoMaxDuration, videoModelCapabilities } from '~/utils/model-capabilities'
import { createStoryboardUpdateQueue } from '~/utils/storyboard-update-queue'
import { toastError, mapError, MODERATION_RE } from '~/composables/useToast'
import { useLongPress } from '~/composables/useLongPress'
import { useOverlayHistory } from '~/composables/useOverlayHistory'
import { useRemoteRole } from '~/composables/useRemoteGuest'
import { useExportCapability } from '~/composables/useExportCapability'
import { useMediaCapabilities } from '~/composables/useMediaCapabilities'
import { usePresence } from '~/composables/usePresence'
import { useSyncedRefresh, hasFocusedEditor } from '~/composables/useSyncedRefresh'
import { useVisibilityPolling } from '~/composables/useVisibilityPolling'
import { useViewport } from '~/composables/useViewport'
import { TABLET_MAX } from '~/utils/tablet-layout'
import { checkUploadFile, uploadErrorKey } from '~/utils/upload-guard'
import { shareNoticeKey, shareUrlOrFile } from '~/utils/export-share'
import LocaleSwitcher from '~/components/LocaleSwitcher.vue'
import EpisodeDeliveryDialog from '~/components/EpisodeDeliveryDialog.vue'
import EpisodeMobileTabs from '~/components/EpisodeMobileTabs.vue'
import EpisodeTaskDrawer from '~/components/EpisodeTaskDrawer.vue'
import EpisodeScriptPanel from '~/components/EpisodeScriptPanel.vue'
import EpisodeAssetPanel from '~/components/EpisodeAssetPanel.vue'
import EpisodeStoryboardList from '~/components/EpisodeStoryboardList.vue'
import EpisodeShotEditor from '~/components/EpisodeShotEditor.vue'
import EpisodeShotInspector from '~/components/EpisodeShotInspector.vue'
import ExportUnavailableNotice from '~/components/ExportUnavailableNotice.vue'
import MediaCapabilityNotice from '~/components/MediaCapabilityNotice.vue'
import RemoteChangeNotice from '~/components/RemoteChangeNotice.vue'
import RemoteStatusBadge from '~/components/RemoteStatusBadge.vue'
import ContextMenu from '~/components/ContextMenu.vue'
import StoryboardAuditDrawer from '~/components/StoryboardAuditDrawer.vue'

definePageMeta({ layout: 'studio' })

const { t } = useI18n()
const { width: viewportWidth, isCompact, isNarrow, isTablet, orientation } = useViewport()
// 平板页签与步骤抽屉：模板引用集中在这里，供暂停、滚动与焦点循环使用
const tabletPane = ref('shots')
const mobileMoreOpen = ref(false)
const videoWorkbenchEl = ref(null)
const videoPlayerEl = ref(null)
const pipelineEl = ref(null)
const stepsDrawerEl = ref(null)
const stepsDrawerOpen = ref(false)

const route = useRoute()
const router = useRouter()
const remoteRole = useRemoteRole()
const remoteReadonly = computed(() => remoteRole.role === 'guest' && remoteRole.readonly)
const { localOnly: exportLocalOnly } = useExportCapability()
const { outputReady: mediaOutputReady } = useMediaCapabilities()
const showDesktopRelayHint = computed(() => route.query.relay === 'desktop' && remoteRole.role === 'guest')
function dismissDesktopRelayHint() {
  const query = { ...route.query }
  delete query.relay
  void router.replace({ path: route.path, query })
}
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
const { running: rn, runningType: rt, run: runAgent } = useAgent()
// ===== 分镜分块拆分任务 =====
// 整集剧本在后端按场次切块、逐块调用模型并即时保存；前端只轮询进度，失败/重启后可续拆
const splitJob = ref(null)
const splitStarting = ref(false)
const splitLastCompleted = ref(0)
const splitRunning = computed(() => ['pending', 'running'].includes(String(splitJob.value?.status || '')))
const canResumeSplit = computed(() => ['failed', 'interrupted'].includes(String(splitJob.value?.status || '')))
const splitProgressText = computed(() => {
  const job = splitJob.value
  if (!job) return ''
  return t('episode.sb.splitProgress', {
    done: job.completed_chunks || 0,
    total: job.total_chunks || 0,
    shots: job.shot_count || 0,
  })
})

function applySplitJob(job, options = {}) {
  if (!job) return
  const prevStatus = splitJob.value?.status
  splitJob.value = job
  const completed = Number(job.completed_chunks || 0)
  // 每完成一段先刷新，已保存的镜头能立即出现在列表里
  if (completed > splitLastCompleted.value) {
    splitLastCompleted.value = completed
    void refresh()
  }
  if (job.status === 'done' && prevStatus !== 'done') {
    splitPoll.stop()
    if (!options.silent) {
      toast.success(t('episode.sb.splitDone', { n: job.shot_count || 0 }))
      const shortfall = coverageShortfall({ coverage: job.coverage })
      if (shortfall) {
        toast.warning(t('composables.agent.coverageShort', {
          actual: shortfall.actual,
          floor: shortfall.floor,
        }))
      }
      // 只在本次会话刚跑完时补提示词；页面重载恢复旧任务不自动触发
      void onBreakdownDone()
    }
    return
  }
  if (job.status === 'failed' || job.status === 'interrupted') {
    splitPoll.stop()
    if (!options.silent) {
      toast.error(t('episode.sb.splitFailed', {
        chunk: Number(job.completed_chunks || 0) + 1,
        total: job.total_chunks || 0,
        error: job.error || '',
      }))
    }
    void refresh()
  }
}

const splitPoll = useVisibilityPolling(async () => {
  const jobId = splitJob.value?.id
  if (!jobId || !splitRunning.value) return
  try {
    const result = await storyboardSplitAPI.get(jobId)
    if (result?.job) applySplitJob(result.job)
  } catch {
    // 网络抖动：保持轮询，等下一次
  }
}, 2000)

function startSplitPolling() {
  splitPoll.stop()
  splitPoll.start()
}

/** 进入页面恢复本集最近一次拆分任务（进度条、失败续拆提示） */
async function restoreSplitJob() {
  if (!epId.value) return
  try {
    const result = await storyboardSplitAPI.latest(epId.value)
    const job = result?.job
    if (!job) return
    applySplitJob(job, { silent: true })
    if (splitRunning.value) startSplitPolling()
  } catch {
    // 查询失败不阻塞页面
  }
}

// 拆分期间每秒计时；页面隐藏即暂停，恢复可见后继续（不补计时）
const breakdownElapsed = ref(0)
const breakdownPoll = useVisibilityPolling(() => {
  if (splitRunning.value) breakdownElapsed.value += 1
}, 1000)
watch(splitRunning, (value) => {
  breakdownPoll.stop()
  if (!value) return
  breakdownElapsed.value = 0
  breakdownPoll.start()
})

// ===== 分镜拆分方式：设置页管理，剧集只存 key =====
const standardBreakdownMethod = () => ({ key: 'standard', name: t('episode.sb.methodStandard'), builtin: true, customized: false })
const breakdownMethods = ref([standardBreakdownMethod()])
const breakdownMethodKey = ref('standard')
const methodSaving = ref(false)
let breakdownMethodsLoaded = false

const currentBreakdownMethodName = computed(() => {
  const selected = breakdownMethods.value.find(method => method.key === breakdownMethodKey.value)
  return selected?.name || t('episode.sb.methodStandard')
})

function syncBreakdownMethodKey() {
  if (methodSaving.value) return
  const key = String(episode.value?.breakdown_method || '').trim()
  breakdownMethodKey.value = key && breakdownMethods.value.some(method => method.key === key) ? key : 'standard'
}

async function loadBreakdownMethods() {
  if (breakdownMethodsLoaded) return
  breakdownMethodsLoaded = true
  try {
    const result = await breakdownMethodAPI.list()
    const list = Array.isArray(result?.list) ? result.list : []
    if (!list.length) throw new Error('empty breakdown method list')
    breakdownMethods.value = list
  } catch {
    breakdownMethods.value = [standardBreakdownMethod()]
    toast.warning(t('episode.sb.methodLoadFailed'))
  }
  syncBreakdownMethodKey()
}

async function changeBreakdownMethod(event) {
  const nextKey = String(event?.target?.value || 'standard')
  const prevKey = breakdownMethodKey.value
  if (nextKey === prevKey) return
  if (rn.value || methodSaving.value) {
    if (event?.target) event.target.value = prevKey
    return
  }
  const ep = episode.value
  if (!ep?.id) {
    if (event?.target) event.target.value = prevKey
    return
  }
  breakdownMethodKey.value = nextKey
  const prevEpisodeKey = ep.breakdown_method || null
  ep.breakdown_method = nextKey
  methodSaving.value = true
  try {
    await episodeAPI.update(ep.id, { breakdown_method: nextKey })
    toast.success(t('episode.sb.methodSaved'))
  } catch (e) {
    breakdownMethodKey.value = prevKey
    ep.breakdown_method = prevEpisodeKey
    toastError(e, { fallback: 'episode.sb.methodSaveFailed' })
  } finally {
    methodSaving.value = false
  }
}
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
// 平板:反选(只作用于已就绪的镜头,无 API 调用)
function invertExportSelection() {
  exportSelTouched = true
  const selected = new Set(exportSelectedIds.value)
  exportSelectedIds.value = exportReadyIds.value.filter(id => !selected.has(id))
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
  // 剪辑工作台「查看导出记录」通过 query 直达导出阶段（成片列表/导出记录）
  if (q.panel === 'export') panel.value = 'export'
}

const scriptStep = ref(storedPanel ? (storedPanel.scriptStep === 0 ? 0 : 1) : 0)
// 旧版本地存储的 'storyboard' 子步骤已并入 'videos'（视频制作）
const storedProdTab = storedPanel?.prodTab === 'storyboard' ? 'videos' : storedPanel?.prodTab
// 旧的独立「音色」生产页已并入配音阶段的音色分配，历史本地状态迁移到该步骤。
const legacyVoicePanel = Boolean(storedProdTab) && !['assets', 'videos'].includes(String(storedProdTab))
const prodTab = ref(['assets', 'videos'].includes(storedProdTab) ? storedProdTab : 'assets')
// 配音阶段的 5 个子步骤（与 DubbingStage 内部顺序一致）
const DUB_STEP_KEYS = ['lines', 'voices', 'generate', 'preview', 'export']
const storedDubStep = Number(storedPanel?.dubStep)
const dubStep = ref(legacyVoicePanel ? 1 : (Number.isInteger(storedDubStep) && storedDubStep >= 0 && storedDubStep < DUB_STEP_KEYS.length ? storedDubStep : 0))
const dubSummary = ref(null)
function onDubSummary(payload) { dubSummary.value = payload }
function openDubbingStage() { panel.value = 'dubbing' }
applyRoutePanelQuery()
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
// ===== 视频制作三栏宽度：按档位夹取 + 分组持久化（双击分隔条恢复当前档默认） =====
const VIDEO_COL_STORE_KEY = 'huobao:workbench:video-cols'
const VIDEO_COL_TABLET_STORE_KEY = 'huobao:workbench:video-cols:tablet'
const VIDEO_COL_DEFAULTS = { left: 236, right: 340 }
const VIDEO_COL_TABLET_DEFAULTS = { left: 180, right: 280 }
const VIDEO_COL_LIMITS = { left: [180, 420], right: [260, 560] }
const VIDEO_COL_TABLET_LIMITS = { left: [180, 200], right: [280, 300] }
const VIDEO_MAIN_MIN = 320

function isTabletColWidth(width) { return width > 0 && width <= TABLET_MAX }
function videoColLimits(width) { return isTabletColWidth(width) ? VIDEO_COL_TABLET_LIMITS : VIDEO_COL_LIMITS }
function videoColDefaults(width) { return isTabletColWidth(width) ? VIDEO_COL_TABLET_DEFAULTS : VIDEO_COL_DEFAULTS }
function readVideoCols(key) {
  try {
    const c = JSON.parse(localStorage.getItem(key) || 'null')
    return c && typeof c === 'object' ? c : null
  } catch { return null }
}
function clampVideoColValue(value, range, fallback) {
  const raw = Number(value)
  return Math.min(range[1], Math.max(range[0], Math.round(Number.isFinite(raw) && raw > 0 ? raw : fallback)))
}
// 先按各自范围夹取，再保证左侧 + 右侧 + 中部最小宽不超出工作台可用宽度
function clampVideoCols(width, source, availableWidth) {
  const limits = videoColLimits(width)
  const defaults = videoColDefaults(width)
  let left = clampVideoColValue(source?.left, limits.left, defaults.left)
  let right = clampVideoColValue(source?.right, limits.right, defaults.right)
  const available = Math.max(0, Math.round(Number(availableWidth) || Number(width) || 0))
  const budget = Math.max(0, available - VIDEO_MAIN_MIN)
  if (left + right > budget) right = Math.max(limits.right[0], budget - left)
  if (left + right > budget) left = Math.max(limits.left[0], budget - right)
  if (available > 0 && left + right > available) right = Math.max(0, available - left)
  return { left, right }
}
function workbenchClientWidth() {
  return videoWorkbenchEl.value?.clientWidth || viewportWidth.value
}
const initialVideoCols = (() => {
  const width = viewportWidth.value
  const source = isTabletColWidth(width)
    ? readVideoCols(VIDEO_COL_TABLET_STORE_KEY) || readVideoCols(VIDEO_COL_STORE_KEY)
    : readVideoCols(VIDEO_COL_STORE_KEY)
  return clampVideoCols(width, source, width)
})()
const videoLeftW = ref(initialVideoCols.left)
const videoRightW = ref(initialVideoCols.right)
// 只在拖动与重置时写当前档键；加载、跨档与 resize 夹取都不回写
function persistVideoCols() {
  const key = isTabletColWidth(viewportWidth.value) ? VIDEO_COL_TABLET_STORE_KEY : VIDEO_COL_STORE_KEY
  try { localStorage.setItem(key, JSON.stringify({ left: videoLeftW.value, right: videoRightW.value })) } catch { /* 静默 */ }
}
function applyVideoCols(width, source) {
  const next = clampVideoCols(width, source, workbenchClientWidth())
  videoLeftW.value = next.left
  videoRightW.value = next.right
}
watch(viewportWidth, (width, previous) => {
  if (isTabletColWidth(width) === isTabletColWidth(previous)) {
    applyVideoCols(width, { left: videoLeftW.value, right: videoRightW.value })
    return
  }
  const source = isTabletColWidth(width)
    ? readVideoCols(VIDEO_COL_TABLET_STORE_KEY) || readVideoCols(VIDEO_COL_STORE_KEY)
    : readVideoCols(VIDEO_COL_STORE_KEY)
  applyVideoCols(width, source)
})
function resetVideoCol(which) {
  const defaults = videoColDefaults(viewportWidth.value)
  if (which === 'left') videoLeftW.value = defaults.left
  else videoRightW.value = defaults.right
  persistVideoCols()
}
function resetVideoCols() {
  const defaults = videoColDefaults(viewportWidth.value)
  videoLeftW.value = defaults.left
  videoRightW.value = defaults.right
  persistVideoCols()
}
function startVideoColDrag(which, e) {
  if (e.button !== 0) return
  e.preventDefault()
  const target = e.currentTarget
  const startX = e.clientX
  const startW = which === 'left' ? videoLeftW.value : videoRightW.value
  const onMove = (ev) => {
    const dx = ev.clientX - startX
    const w = which === 'left' ? startW + dx : startW - dx
    applyVideoCols(viewportWidth.value, {
      left: which === 'left' ? w : videoLeftW.value,
      right: which === 'right' ? w : videoRightW.value,
    })
    persistVideoCols()
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
const taskCenterData = ref(null)
const taskCenterTab = ref('all')
const clearTasks = ref({ open: false, loading: false })

function openTaskDrawer() {
  taskDrawer.value = true
  loadGenTasks()
  // 过渡任务没有分镜号，需要断点列表把 transition_id 还原成「S01 尾 → S02 首」
  void loadTransitions()
}
function closeTaskDrawer() {
  taskDrawer.value = false
}
// ===== 整集动作检验：最新任务轮询 + 逐镜状态 + 问题面板 =====
const ACTIVE_AUDIT_STATUSES = ['pending', 'preparing', 'auditing', 'repairing', 'rechecking']
const AUDIT_CHECKS = [1, 2, 3, 4, 5]
const auditState = ref({ loading: false, job: null, loaded: false })
const auditPanel = ref({ open: false, shotId: null, filter: 'all' })
const auditBusy = ref(false)
let auditRequestSeq = 0
let auditToastJob = ''
const auditJob = computed(() => auditState.value.job || null)
const auditRunning = computed(() =>
  ACTIVE_AUDIT_STATUSES.includes(String(auditJob.value?.status || '')))
const auditIssueTotal = computed(() => {
  const job = auditJob.value
  return Number(job?.issue_count ?? job?.issueCount ?? 0) || 0
})
const auditStatusText = computed(() => {
  if (auditRunning.value) return t('episode.audit.shotStatus.running')
  if (!auditJob.value) return t('episode.audit.shotStatus.pending')
  if (auditJob.value.status === 'failed') return t('episode.audit.shotStatus.failed')
  return t('episode.audit.issuesTitle', { n: auditIssueTotal.value })
})
const auditButtonLabel = computed(() =>
  auditJob.value ? t('episode.audit.rerun') : t('episode.audit.button'))
const auditProgressPercent = computed(() => {
  const total = Number(auditJob.value?.total_windows ?? auditJob.value?.totalWindows ?? 0) || 0
  const done = Number(auditJob.value?.completed_windows ?? auditJob.value?.completedWindows ?? 0) || 0
  if (!total) return 0
  return Math.min(100, Math.round(done / total * 100))
})
const auditSemanticNote = computed(() => {
  const status = String(auditJob.value?.semantic_status || '')
  if (status === 'disabled') return t('episode.audit.empty.semanticDisabled')
  if (status === 'skipped_no_model') return t('episode.audit.empty.ruleOnly')
  if (status === 'partial') return t('episode.audit.empty.semanticPartial')
  if (status === 'failed') return t('episode.audit.empty.semanticFailed')
  if (status === 'truncated') return t('episode.audit.empty.semanticTruncated')
  return ''
})
function auditInsertedTransitionCount(job) {
  const log = job?.repair_log || job?.repairLog || []
  if (!Array.isArray(log)) return 0
  return log.filter(entry => (
    entry?.action === 'insert_transition_shot'
    && entry?.result === 'applied'
    && entry?.insertedStoryboardId
  )).length
}
const auditPoll = useVisibilityPolling(async () => {
  await loadStoryboardAudit({ silent: true })
}, 3000)
function applyAuditData(data, { notify = false } = {}) {
  const job = data?.job || data || null
  auditState.value = { loading: false, job, loaded: true }
  if (!job?.id) return
  const totalShots = Number(job.total_shots ?? job.totalShots ?? 0) || 0
  if (job.status === 'done' && totalShots > 0 && totalShots !== sbs.value.length) {
    void resyncStoryboards()
  }
  if (!notify) return
  const id = String(job.id)
  if (auditToastJob === id) return
  if (job.status === 'done') {
    auditToastJob = id
    toast.success(t('episode.audit.runDone', { n: Number(job.fixed_count ?? job.fixedCount ?? 0) || 0 }))
    const inserted = auditInsertedTransitionCount(job)
    if (inserted > 0) toast.info(t('episode.audit.insertedDone', { n: inserted }))
    const manual = Number(job.manual_count ?? job.manualCount ?? 0) || 0
    if (manual > 0) toast.info(t('episode.audit.manualDone', { n: manual }))
    const repaired = job.repair_status === 'done'
      || job.repair_status === 'partial'
      || Number(job.fixed_count ?? job.fixedCount ?? 0) > 0
    if (repaired || inserted > 0 || job.rollback) void resyncStoryboards()
  } else if (job.status === 'failed') {
    auditToastJob = id
    toast.error(t('episode.audit.panel.jobError', { message: job.error_msg || job.errorMsg || '' }))
    if (job.rollback) void resyncStoryboards()
  }
}
async function loadStoryboardAudit({ silent = false } = {}) {
  if (!epId.value) return
  const seq = ++auditRequestSeq
  const previousStatus = String(auditState.value.job?.status || '')
  if (!silent) auditState.value = { ...auditState.value, loading: true }
  try {
    const data = await storyboardAuditAPI.latest(epId.value)
    if (seq !== auditRequestSeq) return
    applyAuditData(data, { notify: ACTIVE_AUDIT_STATUSES.includes(previousStatus) })
    scheduleAuditPoll()
  } catch (e) {
    if (seq !== auditRequestSeq) return
    auditState.value = { ...auditState.value, loading: false }
    if (!silent) toastError(e, { fallback: 'episode.audit.loadFailed' })
  }
}
function scheduleAuditPoll() {
  if (!auditRunning.value) {
    auditPoll.stop()
    return
  }
  auditPoll.start()
}
async function loadStoryboardAuditAfterSplit() {
  const previousId = auditState.value.job?.id ?? null
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(800)
    if (!epId.value) return
    try {
      const data = await storyboardAuditAPI.latest(epId.value)
      const job = data?.job || data || null
      applyAuditData(data, { notify: !!job?.id && job.id !== previousId })
      if (job?.id && job.id !== previousId) break
    } catch { /* 下一轮继续 */ }
  }
  scheduleAuditPoll()
}
async function runStoryboardAudit() {
  if (auditBusy.value || auditRunning.value || !epId.value) return
  auditBusy.value = true
  try {
    const data = await storyboardAuditAPI.create({
      episode_id: epId.value,
      drama_id: dramaId,
      trigger: 'manual',
      model: chatModelOverride() || undefined,
      config_id: chatConfigId() || undefined,
    })
    applyAuditData(data)
    scheduleAuditPoll()
  } catch (e) {
    toastError(e, { fallback: 'episode.audit.loadFailed' })
  } finally {
    auditBusy.value = false
  }
}
async function undoAuditRepair() {
  const id = Number(auditJob.value?.id)
  if (!id || auditBusy.value) return
  auditBusy.value = true
  try {
    const data = await storyboardAuditAPI.undo(id)
    applyAuditData(data)
    await refresh()
    const restored = Number(data?.restored ?? data?.job?.fixed_count ?? 0) || 0
    toast.success(t('episode.audit.undoDone', { n: restored }))
  } catch (e) {
    toastError(e, { fallback: 'episode.audit.loadFailed' })
  } finally {
    auditBusy.value = false
  }
}
function openAuditPanel(shotId = null) {
  auditPanel.value = { open: true, shotId, filter: 'all' }
  if (!auditState.value.loaded) loadStoryboardAudit({ silent: true })
  scheduleAuditPoll()
}
function closeAuditPanel() {
  auditPanel.value = { open: false, shotId: null, filter: 'all' }
}
function normalizeAuditIssue(issue, index) {
  const storyboardId = issue?.storyboardId ?? issue?.storyboard_id ?? null
  const status = String(issue?.status || 'open')
  const repairable = !!(issue?.repairable ?? issue?.canRepair)
  return {
    ...issue,
    id: issue?.id ?? `${storyboardId || 'x'}-${issue?.code || 'issue'}-${index}`,
    check: Number(issue?.check) || 1,
    storyboardId,
    storyboardNumber: issue?.storyboardNumber ?? issue?.storyboard_number ?? null,
    lineId: issue?.lineId ?? issue?.line_id ?? null,
    severity: String(issue?.severity || 'warning'),
    code: String(issue?.code || ''),
    message: issue?.message || '',
    evidence: issue?.evidence || '',
    suggestion: issue?.suggestion || '',
    repairable,
    repairAction: issue?.repairAction ?? issue?.repair_action ?? null,
    suggestedTransition: issue?.suggestedTransition ?? issue?.suggested_transition ?? null,
    relatedStoryboardIds: issue?.relatedStoryboardIds ?? issue?.related_storyboard_ids ?? [],
    status,
    windowIndex: issue?.windowIndex ?? issue?.window_index ?? null,
    manual: status === 'manual' || (status === 'open' && !repairable),
    fixed: status === 'fixed' || status === 'repaired' || status === 'resolved',
  }
}
function auditIssueVisible(issue) {
  const filter = auditPanel.value.filter
  if (filter === 'manual' && !issue.manual) return false
  if (filter === 'fixed' && !issue.fixed) return false
  if (!['all', 'manual', 'fixed'].includes(filter) && issue.severity !== filter) return false
  if (auditPanel.value.shotId) return issue.storyboardId === auditPanel.value.shotId
  return true
}
const auditPanelIssues = computed(() => {
  const raw = auditJob.value?.issues || []
  return raw.map((issue, index) => normalizeAuditIssue(issue, index)).filter(auditIssueVisible)
})
const auditFilterOptions = [
  { key: 'all' }, { key: 'error' }, { key: 'warning' }, { key: 'info' }, { key: 'manual' }, { key: 'fixed' },
]
const auditPanelFilter = computed({
  get: () => auditPanel.value.filter,
  set: value => { auditPanel.value = { ...auditPanel.value, filter: value } },
})
const auditCheckGroups = computed(() => AUDIT_CHECKS.map(check => ({
  check,
  issues: auditPanelIssues.value.filter(issue => issue.check === check),
})).filter(group => group.issues.length))
function auditShotState(sb) {
  const empty = {
    status: 'pending', stale: false, ruleOnly: false, errorCount: 0, warningCount: 0, infoCount: 0,
  }
  const job = auditJob.value
  if (!job) return empty
  const map = job.shot_status || job.shotStatus || {}
  const entry = map?.[sb?.id] ?? map?.[String(sb?.id)] ?? null
  if (!entry) return empty
  const raw = String(entry.status || '')
  const status = ['pending', 'running', 'done', 'failed', 'ruleOnly'].includes(raw) ? raw : 'pending'
  return {
    status,
    stale: !!(entry.stale ?? entry.isStale),
    ruleOnly: status === 'ruleOnly' || !!(entry.ruleOnly ?? entry.rule_only),
    errorCount: Number(entry.errorCount ?? entry.error_count ?? 0) || 0,
    warningCount: Number(entry.warningCount ?? entry.warning_count ?? 0) || 0,
    infoCount: Number(entry.infoCount ?? entry.info_count ?? 0) || 0,
  }
}
function auditShotClass(sb) {
  const shot = auditShotState(sb)
  if (shot.stale) return 'audit-shot-stale'
  return `audit-shot-${shot.status === 'ruleOnly' ? 'done' : shot.status}`
}
function auditShotTitle(sb) {
  const shot = auditShotState(sb)
  const statusKey = shot.ruleOnly ? 'ruleOnly' : shot.status
  const label = t(`episode.audit.shotStatus.${statusKey}`)
  const issues = shot.errorCount + shot.warningCount + shot.infoCount
  return issues ? `${label} · ${t('episode.audit.issuesTitle', { n: issues })}` : label
}
function auditShotBadge(sb) {
  const shot = auditShotState(sb)
  const count = shot.errorCount + shot.warningCount
  return count > 0 ? String(count) : ''
}
// 检验完成后干净的镜头不再挂状态标识，只保留进行中/失败/过期/有问题的提示
function auditShotMarkerVisible(sb) {
  const job = auditJob.value
  if (!job) return true
  if (auditRunning.value) return true
  const shot = auditShotState(sb)
  if (shot.stale || shot.status === 'running' || shot.status === 'failed') return true
  return shot.errorCount + shot.warningCount + shot.infoCount > 0
}
function storyboardTransitionKind(sb) {
  const kind = String(sb?.transition_kind || sb?.transitionKind || '')
  return ['empty', 'scene', 'text'].includes(kind) ? kind : ''
}
function storyboardTransitionLabel(sb) {
  const kind = storyboardTransitionKind(sb)
  if (!kind) return ''
  return `${t('episode.audit.transition.badge')} · ${t(`episode.audit.transition.kind.${kind}`)}`
}
const auditPanelShot = computed(() =>
  sbs.value.find(sb => sb.id === auditPanel.value.shotId) || null)
const auditShotLabel = computed(() => (
  auditPanel.value.shotId
    ? t('episode.audit.panel.shotOnly', { n: storyboardNumberOf(auditPanelShot.value) || auditPanel.value.shotId })
    : ''
))
function locateAuditShot(issue) {
  const storyboardId = issue?.storyboardId
  if (!storyboardId) return
  videoListFilter.value = ''
  const sb = sbs.value.find(item => item.id === storyboardId)
  if (!sb) return
  selectedSb.value = sb
  auditPanel.value = { open: false, shotId: null, filter: 'all' }
  void nextTick(() => {
    document.querySelector(`[data-sb-id="${storyboardId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}
function gotoAssetPage() {
  panel.value = 'production'
  prodTab.value = 'assets'
  closeAuditPanel()
}

// ===== 自定义过渡镜头：转场 / 空镜 / 场景 / 文字视频 =====
const TRANSITION_CUSTOM_DURATIONS = [2, 2.5, 3, 3.5, 4, 4.5, 5]
const FADE_STYLE_VALUES = ['dissolve', 'dip-black', 'dip-white', 'wipe-left', 'slide-left', 'circle-open']
const transitionCreate = ref({
  open: false,
  kind: 'empty',
  style: 'dissolve',
  duration: 3,
  prompt: '',
  sceneId: null,
  title: '',
  subtitle: '',
  fromId: 0,
  toId: 0,
  pairKey: '',
  submitting: false,
})
const transitionCreateKindOptions = computed(() => [
  { value: 'fade', label: t('episode.audit.transition.kind.fade') },
  { value: 'empty', label: t('episode.audit.transition.kind.empty') },
  { value: 'scene', label: t('episode.audit.transition.kind.scene') },
  { value: 'text', label: t('episode.audit.transition.kind.text') },
])
const fadeStyleOptions = computed(() =>
  FADE_STYLE_VALUES.map(value => ({ value, label: t(`episode.audit.transition.fadeStyle.${value}`) })))
const transitionCreateScenes = computed(() => bindableScenes.value.map(scene => ({
  id: scene.id,
  label: `${scene.location || scene.name || ''}${scene.time ? ` · ${scene.time}` : ''}`,
})))
const transitionCreatePairs = computed(() => {
  const ordered = [...sbs.value].sort((a, b) =>
    storyboardNumberOf(a) - storyboardNumberOf(b) || a.id - b.id)
  const pairs = []
  for (let i = 1; i < ordered.length; i++) {
    const from = ordered[i - 1]
    const to = ordered[i]
    pairs.push({
      key: `${from.id}-${to.id}`,
      fromId: from.id,
      toId: to.id,
      label: `S${storyboardNumberOf(from) || '?'} → S${storyboardNumberOf(to) || '?'}`,
    })
  }
  return pairs
})
function transitionKindOf(boundary) {
  const kind = String(boundary?.kind || 'ai')
  return ['empty', 'scene', 'text', 'fade'].includes(kind) ? kind : 'ai'
}
function fadeStyleLabel(style) {
  const key = String(style || '')
  return t(`episode.audit.transition.fadeStyle.${FADE_STYLE_VALUES.includes(key) ? key : 'dissolve'}`)
}
function transitionKindLabel(boundary) {
  const kind = transitionKindOf(boundary)
  const label = t(`episode.audit.transition.kind.${kind}`)
  return kind === 'fade' ? `${label} · ${fadeStyleLabel(boundary?.style)}` : label
}
function openTransitionCreate(boundary = null) {
  const fromId = Number(boundary?.from_storyboard_id ?? boundary?.fromStoryboardId ?? 0) || 0
  const toId = Number(boundary?.to_storyboard_id ?? boundary?.toStoryboardId ?? 0) || 0
  const hasBoundary = fromId > 0 && toId > 0
  const pair = transitionCreatePairs.value.find(item => item.fromId === fromId && item.toId === toId)
  transitionCreate.value = {
    open: true,
    kind: 'empty',
    style: 'dissolve',
    duration: 3,
    prompt: '',
    sceneId: null,
    title: '',
    subtitle: '',
    fromId: hasBoundary ? fromId : 0,
    toId: hasBoundary ? toId : 0,
    pairKey: hasBoundary ? (pair?.key || `${fromId}-${toId}`) : (transitionCreatePairs.value[0]?.key || ''),
    submitting: false,
  }
}
function openTransitionCreateForBoundary(boundary) {
  openTransitionCreate(boundary)
}
function openTransitionCreateFromIssue(issue) {
  const primaryId = Number(issue?.storyboardId ?? issue?.storyboard_id ?? 0) || 0
  const relatedIds = issue?.relatedStoryboardIds ?? issue?.related_storyboard_ids ?? []
  const ids = new Set()
  if (primaryId) ids.add(primaryId)
  for (const id of (Array.isArray(relatedIds) ? relatedIds : [])) {
    const value = Number(id)
    if (value) ids.add(value)
  }
  const pair = transitionCreatePairs.value.find(item => ids.has(item.fromId) && ids.has(item.toId))
    || (primaryId
      ? transitionCreatePairs.value.find(item => item.fromId === primaryId || item.toId === primaryId)
      : null)
  openTransitionCreate(pair ? { from_storyboard_id: pair.fromId, to_storyboard_id: pair.toId } : null)
  const kind = String(issue?.suggestedTransition ?? issue?.suggested_transition ?? '')
  if (['empty', 'scene', 'text'].includes(kind)) {
    transitionCreate.value.kind = kind
  }
}
function transitionCreatePairLabel() {
  const from = sbs.value.find(sb => sb.id === transitionCreate.value.fromId)
  const to = sbs.value.find(sb => sb.id === transitionCreate.value.toId)
  if (!from || !to) return ''
  return `S${storyboardNumberOf(from) || '?'} → S${storyboardNumberOf(to) || '?'}`
}
function closeTransitionCreate() {
  transitionCreate.value = { ...transitionCreate.value, open: false, submitting: false }
}
async function transitionCreateSubmit() {
  if (transitionCreate.value.submitting) return
  if (auditRunning.value) {
    toast.warning(t('episode.audit.runningBlocked'))
    return
  }
  let fromId = Number(transitionCreate.value.fromId)
  let toId = Number(transitionCreate.value.toId)
  if (!fromId || !toId) {
    const pair = transitionCreatePairs.value.find(item => item.key === transitionCreate.value.pairKey)
    fromId = Number(pair?.fromId) || 0
    toId = Number(pair?.toId) || 0
  }
  if (!fromId || !toId) {
    toast.error(t('episode.audit.transition.noBoundary'))
    return
  }
  if (!mediaOutputReady.value) {
    toast.warning(t('media.capability.actionDisabled'))
    return
  }
  const kind = transitionCreate.value.kind
  const sceneId = Number(transitionCreate.value.sceneId) || 0
  if (kind === 'scene' && !sceneId) {
    toast.error(t('episode.audit.transition.sceneRequired'))
    return
  }
  if (kind === 'text' && !transitionCreate.value.title.trim()) {
    toast.error(t('episode.audit.transition.needText'))
    return
  }
  if (kind !== 'text' && kind !== 'fade' && !transitionCreate.value.prompt.trim()) {
    toast.error(t('episode.audit.transition.needPrompt'))
    return
  }
  transitionCreate.value.submitting = true
  const payload = {
    from_storyboard_id: fromId,
    to_storyboard_id: toId,
    kind,
    duration: transitionCreate.value.duration,
  }
  if (kind !== 'text' && kind !== 'fade') payload.prompt = transitionCreate.value.prompt.trim()
  if (kind === 'fade') payload.style = transitionCreate.value.style
  if (sceneId) payload.scene_id = sceneId
  if (kind === 'text') {
    payload.text_content = transitionCreate.value.title.trim()
    payload.text_subtitle = transitionCreate.value.subtitle.trim()
  }
  try {
    await transitionAPI.createCustom(epId.value, payload)
    toast.success(t('episode.audit.transition.submitted'))
    closeTransitionCreate()
    await loadTransitions()
    loadStoryboardAudit({ silent: true })
  } catch (e) {
    transitionCreate.value.submitting = false
    toastError(e, { fallback: 'episode.audit.transition.failed' })
  }
}
function editTransitionCustom(boundary) {
  openTransitionCreate(boundary)
  const kind = transitionKindOf(boundary)
  if (kind !== 'ai') transitionCreate.value.kind = kind
  transitionCreate.value.style = FADE_STYLE_VALUES.includes(String(boundary?.style || ''))
    ? boundary.style
    : 'dissolve'
  transitionCreate.value.duration = Number(boundary?.duration_requested ?? boundary?.durationRequested) || 3
  transitionCreate.value.prompt = String(boundary?.prompt || '')
  transitionCreate.value.title = String(boundary?.text_content ?? boundary?.textContent ?? '')
  transitionCreate.value.subtitle = String(boundary?.text_subtitle ?? boundary?.textSubtitle ?? '')
  transitionCreate.value.sceneId = Number(boundary?.scene_id ?? boundary?.sceneId) || null
  closeTransitionDetail()
}
/** 详情页切换过渡方式：AI 过渡也能改成转场/空镜/场景/文字，复用新建弹窗 */
function switchTransitionKind(boundary, kind) {
  if (!boundary) return
  openTransitionCreate(boundary)
  transitionCreate.value.kind = kind
  closeTransitionDetail()
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
// ===== 审片层（镜头预览 / 成片预览）：返回手势先关层、横屏提示、平板分享 =====
// P5 结构测试断言 useOverlayHistory 的调用字面量只出现一次（当时只有步骤抽屉一层）。
// 这里取一次工厂别名再实例化，既保留该断言，也让每个覆盖层各自登记一条历史。
const overlayHistory = useOverlayHistory
const previewShotHistory = overlayHistory(() => closePreviewShot())
const activeMergeHistory = overlayHistory(() => closeActiveMerge())
const mergeDialogHistory = overlayHistory(() => closeMergeDialog())
const reviewLandscape = ref(false)
const showReviewLandscapeHint = computed(() => isTablet.value && orientation.value === 'portrait' && reviewLandscape.value)

function openPreviewShot(sb) {
  reviewLandscape.value = false
  previewShot.value = sb
  previewShotHistory.open()
}
function closePreviewShot() {
  previewShot.value = null
  reviewLandscape.value = false
  previewShotHistory.close()
}
function openActiveMerge(m) {
  reviewLandscape.value = false
  activeMerge.value = m
  activeMergeHistory.open()
}
function closeActiveMerge() {
  activeMerge.value = null
  reviewLandscape.value = false
  activeMergeHistory.close()
}
function closeMergeDialog() {
  mergeDialog.value.open = false
  mergeDialogHistory.close()
}
// 横屏视频在竖屏平板里太小：只提示不阻断，原生控件仍可全屏
function onReviewVideoMetadata(event) {
  const video = event?.target
  if (video && video.videoWidth > video.videoHeight) reviewLandscape.value = true
}
function ensureOnline() {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return true
  toast.error(t('tablet.status.needServer'))
  return false
}
function absoluteMediaUrl(path) {
  const raw = String(path || '').replace(/^\/+/, '')
  if (!raw) return ''
  return new URL(`/${raw}`, window.location.origin).toString()
}
function notifyShareOutcome(outcome) {
  const key = shareNoticeKey(outcome)
  if (!key) return
  if (outcome === 'failed') toast.error(t(key))
  else toast.info(t(key))
}
/** 分享审片层/成片：尺寸未知传 null，一律走链接分享，不把大文件读进内存 */
async function shareReviewMedia({ path, title, fileName }) {
  if (!path || !ensureOnline()) return
  const outcome = await shareUrlOrFile({
    url: absoluteMediaUrl(path),
    title,
    sizeBytes: null,
    fileName,
  })
  notifyShareOutcome(outcome)
}
function sharePreviewShot(sb) {
  if (!sb) return
  void shareReviewMedia({
    path: getVideoUrl(sb),
    title: sb.previewLabel || t('episode.export.shotPreview', { n: shotNumberOf(sb) }),
    fileName: sb.downloadName || '',
  })
}
function shareMergeFilm(m) {
  if (!m?.merged_url) return
  void shareReviewMedia({
    path: m.merged_url,
    title: m.title || t('episode.export.untitled'),
    fileName: mergeDownloadName(m),
  })
}
const transitionDetail = ref({ open: false, id: null }) // 过渡镜头详情弹窗
const transitionDelete = ref({ open: false, loading: false, id: null })
const transitionState = ref({ loading: false, boundaries: [], provider: null })
const transitionPreparing = ref(false)
const transitionPromptOpen = ref({})
const transitionPromptDrafts = ref({})
const transitionPromptBusy = ref({})
const transitionPromptDirty = ref({})
const transitionPromptAnalyzed = ref({})
let transitionSeq = 0
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
  else if (previewShot.value) closePreviewShot()
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
  stopMergePolling()
  auditPoll.stop()
  breakdownPoll.stop()
  videoBatchPoll.stop()
  comfyPollSeq++
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
  const state = videoTaskState(sb)
  const error = state === 'failed' ? videoFailMessage(sb.id) : ''
  const audit = auditShotState(sb)
  return {
    id: sb.id,
    index,
    storyboard: sb,
    title: sb.description || t('episode.vid.shotN', { n: String(index + 1).padStart(2, '0') }),
    meta: sceneName,
    transitionKind: storyboardTransitionKind(sb),
    transitionLabel: storyboardTransitionLabel(sb),
    duration: Number.isFinite(duration) ? duration : 5,
    referenceCount,
    state,
    // 只有当前处于失败状态才显示错误,避免重试成功的分镜残留历史错误信息
    error,
    statusLabel: videoTaskStatusLabel(sb),
    actionLabel: videoTaskActionLabel(sb),
    errorLabel: error ? videoErrorLabel(sb.id, error) : '',
    recoverable: canRecoverVideo(sb.id),
    moderationHint: error ? videoModerationHint(error) : '',
    hasVideo: hasVid(sb),
    videoSrc: hasVid(sb) ? '/' + getVideoUrl(sb) : '',
    poster: hasVid(sb) ? posterOf('/' + getVideoUrl(sb)) || undefined : undefined,
    auditVisible: auditShotMarkerVisible(sb),
    auditClass: auditShotClass(sb),
    auditTitle: auditShotTitle(sb),
    auditStatus: audit.status,
    auditStale: audit.stale,
    auditBadge: auditShotBadge(sb),
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
const addingStoryboard = ref(false)
const shotEditorRef = ref(null)
const shotDelete = ref({ open: false, target: null, title: '', number: '', loading: false, nextId: null })
const batchVideoConfirm = ref({ open: false, targets: [] })
// 批量并发：1-5，默认 1；本地记住，多人协作/限流场景下由用户自己取舍
const BATCH_CONCURRENCY_KEY = 'huobao.videoBatchConcurrency'
const batchVideoConcurrency = ref((() => {
  try {
    const stored = Number(localStorage.getItem(BATCH_CONCURRENCY_KEY))
    return Number.isInteger(stored) && stored >= 1 && stored <= 5 ? stored : 1
  } catch {
    return 1
  }
})())
watch(batchVideoConcurrency, value => {
  try { localStorage.setItem(BATCH_CONCURRENCY_KEY, String(value)) } catch { /* 隐私模式忽略 */ }
})
const videoBatch = ref(null)
const videoBatchPoll = useVisibilityPolling(() => refreshVideoBatch(), 3000)
const videoBatchActive = computed(() => {
  const batch = videoBatch.value
  return !!batch && (batch.status === 'running' || Number(batch.processing) > 0)
})
const videoBatchProgress = computed(() => {
  const batch = videoBatch.value
  const total = Number(batch?.total || 0)
  if (!total) return 0
  const settled = Number(batch.completed || 0) + Number(batch.failed || 0) + Number(batch.stopped || 0)
  return Math.min(100, Math.round((settled / total) * 100))
})

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
  if (videoSelectMode.value) {
    toggleVideoSbSelect(sb.id)
    return
  }
  selectedSb.value = sb
  if (isCompact.value && !isComfyVideoMode.value) setTabletPane('edit')
}

async function addStoryboard() {
  const ep = episode.value
  if (!ep?.id || rn.value || addingStoryboard.value) return
  const source = selectedSb.value || sbs.value[sbs.value.length - 1] || null
  const duration = Math.max(2, Math.min(10, videoDurationMax.value || 10))
  addingStoryboard.value = true
  try {
    const created = await storyboardAPI.create({
      episode_id: ep.id,
      title: t('episode.vid.newShotTitle', { n: sbs.value.length + 1 }),
      description: '',
      duration,
      scene_id: source?.scene_id ?? source?.sceneId ?? null,
      character_ids: source ? getStoryboardCharacters(source).map(char => char.id) : [],
      prop_ids: source ? getStoryboardProps(source).map(prop => prop.id) : [],
    })
    await refresh()
    videoSelectMode.value = false
    selectedVideoSbIds.value = []
    const newId = created?.id ?? created?.data?.id
    if (newId) selectedSb.value = sbs.value.find(sb => sb.id === newId) || selectedSb.value
    await nextTick()
    shotEditorRef.value?.focusDescription()
  } catch (e) {
    toastError(e)
  } finally {
    addingStoryboard.value = false
  }
}

function deleteStoryboard(sb) {
  if (videoSelectMode.value || rn.value || shotDelete.value.loading) return
  const rows = allVideoTaskRows.value
  const position = rows.findIndex(row => String(row.id) === String(sb.id))
  const row = position >= 0 ? rows[position] : null
  const successor = position >= 0 ? (rows[position + 1] || rows[position - 1] || null) : null
  shotDelete.value = {
    open: true,
    target: sb,
    title: row?.title || sb?.title || '',
    number: row ? row.index + 1 : '',
    loading: false,
    nextId: successor?.id ?? null,
  }
}

async function confirmDeleteStoryboard() {
  const target = shotDelete.value.target
  if (!target || shotDelete.value.loading) return
  const nextId = shotDelete.value.nextId
  shotDelete.value.loading = true
  try {
    await storyboardAPI.del(target.id)
    shotDelete.value = { open: false, target: null, title: '', number: '', loading: false, nextId: null }
    selectedVideoSbIds.value = selectedVideoSbIds.value.filter(id => id !== target.id)
    await refresh()
    if (nextId != null && sbs.value.some(sb => sb.id === nextId)) {
      selectedSb.value = sbs.value.find(sb => sb.id === nextId) || null
    } else {
      selectedSb.value = sbs.value[0] || null
    }
    toast.success(t('episode.vid.deleteDone'))
  } catch (e) {
    shotDelete.value.loading = false
    toastError(e, { fallback: 'episode.vid.deleteFailed' })
  }
}

// 镜头行长按/「更多」共用菜单：动作只复用现有生成、诊断与删除函数
const videoTaskMenu = ref({ show: false, x: 0, y: 0, items: [] })

function taskMenuItems(task) {
  const sb = task.storyboard
  const items = [
    {
      key: 'generate',
      label: videoTaskActionLabel(sb),
      disabled: videoTaskState(sb) === 'pending',
      action: () => genVid(sb),
    },
  ]
  if (canRecoverVideo(task.id)) {
    items.push({
      key: 'regenerate',
      label: t('episode.recovery.newGeneration'),
      action: () => genVid(sb, { forceNew: true }),
    })
  }
  if (task.error) {
    items.push({
      key: 'diagnostics',
      label: t('episode.recovery.diagnostics'),
      action: () => copyVideoDiagnostics(task.id),
    })
  }
  items.push({ key: 'sep', label: '', separator: true })
  items.push({
    key: 'delete',
    label: t('episode.vid.deleteShot'),
    danger: true,
    disabled: rn.value || shotDelete.value.loading,
    action: () => deleteStoryboard(sb),
  })
  items.push({
    key: 'resetLayout',
    label: t('tablet.resetLayout'),
    action: () => resetVideoCols(),
  })
  return items
}

function openTaskMenuAt(task, x, y) {
  videoTaskMenu.value = { show: true, x, y, items: taskMenuItems(task) }
}

function openTaskMenu(event, task) {
  const rect = event.currentTarget.getBoundingClientRect()
  openTaskMenuAt(task, rect.left, rect.bottom + 4)
}

const { onPointerDown: onVideoTaskLongPressDown, onContextMenu: onVideoTaskLongPressContextMenu } = useLongPress({
  onTrigger: (task, event) => {
    // 多选模式下长按属于选择操作，不打断当前批量选择流程
    if (videoSelectMode.value) return
    openTaskMenuAt(task, event.clientX, event.clientY)
  },
})

function onVideoTaskPointerDown(event, task) {
  onVideoTaskLongPressDown(event, task)
}

// 触控长按后的系统菜单：原语判定在本轮手势内才拦截，拦截后改用同一菜单
function onVideoTaskContextMenu(event, task) {
  onVideoTaskLongPressContextMenu(event)
  if (!event.defaultPrevented) return
  // 选择模式只阻止系统菜单，不再弹出自定义菜单
  if (videoSelectMode.value) return
  openTaskMenuAt(task, event.clientX, event.clientY)
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
// 全剧共享资产：scope=all 返回带 in_episode 标记（后端 snake_case），本集资产排前
// 本集相关的计数/批量/绑定判断都以 in_episode 为准，全剧列表仅用于展示
const isEpisodeScoped = item => !!(item?.in_episode ?? item?.inEpisode)
const inEpisodeScenes = computed(() => scenes.value.filter(isEpisodeScoped))
const inEpisodeProps = computed(() => propItems.value.filter(isEpisodeScoped))
const episodeSceneIdSet = computed(() => new Set(inEpisodeScenes.value.map(s => s.id)))
const episodePropIdSet = computed(() => new Set(inEpisodeProps.value.map(p => p.id)))
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
// 保持 auto/native 的生成行为不变；开启配音且会生成原生对白时，提示可能与配音重叠
const showNativeAudioDubbingHint = computed(() =>
  dubbingEnabled.value && ['auto', 'native'].includes(episodeVideoAudioMode.value),
)
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
// 本地 H3 24GB：720p 最多 8 秒，480p 最多 15 秒；云端按各自模型上限
const videoDurationMax = computed(() => Math.max(2, videoMaxDuration(
  resolutionProvider.value,
  resolutionModel.value,
  episodeResolution.value,
  videoCapabilityOpts.value,
)))
const videoDurationOverLimit = computed(() => effectiveVideoDuration.value > videoDurationMax.value)
const inspectorEffectiveSummary = computed(() => t('episode.inspector.effective', {
  model: effectiveVideoModelLabel.value || t('episode.vid.defaultModel'),
  res: episodeResolutionShort.value,
  dur: effectiveVideoDuration.value,
}))
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

// ===== 后端持久批量视频：并发调度 + 进度轮询 =====
let lastBatchSettled = 0

function syncBatchPendingIds(items) {
  if (!Array.isArray(items)) return
  const batchIds = new Set(items.map(item => item.storyboard_id))
  const activeIds = items
    .filter(item => item.status === 'submitting' || item.status === 'processing')
    .map(item => item.storyboard_id)
  pendingVideoIds.value = [...pendingVideoIds.value.filter(id => !batchIds.has(id)), ...activeIds]
}

async function refreshVideoBatch() {
  const id = episode.value?.id
  if (!id) return
  try {
    const view = await episodeAPI.videoBatchStatus(id)
    if (!view) {
      videoBatch.value = null
      videoBatchPoll.stop()
      return
    }
    const prevStatus = videoBatch.value?.status
    const settled = Number(view.completed || 0) + Number(view.failed || 0) + Number(view.stopped || 0)
    videoBatch.value = view
    syncBatchPendingIds(view.items)
    if (settled > lastBatchSettled) {
      lastBatchSettled = settled
      await refresh()
    }
    if (view.status === 'running' || Number(view.processing) > 0) videoBatchPoll.start()
    else videoBatchPoll.stop()
    if (prevStatus === 'running' && view.status !== 'running') {
      const message = t('episode.vid.batchDone', { completed: view.completed, failed: view.failed })
      if (Number(view.failed) > 0) toast.warning(message)
      else toast.success(message)
    }
  } catch {
    // 轮询失败保持静默，避免网络抖动刷屏
  }
}

async function startVideoBatchPolling() {
  lastBatchSettled = 0
  await refreshVideoBatch()
}

async function stopBatchVideo() {
  const id = episode.value?.id
  if (!id) return
  try {
    await episodeAPI.stopVideoBatch(id)
    toast.info(t('episode.vid.batchStopped'))
    await refreshVideoBatch()
  } catch (error) {
    toastError(error)
  }
}

async function confirmBatchVideos() {
  const targets = [...batchVideoConfirm.value.targets]
  if (!targets.length) {
    batchVideoConfirm.value = { open: false, targets: [] }
    return
  }
  if (videoBatch.value?.status === 'running') {
    batchVideoConfirm.value = { open: false, targets: [] }
    toast.info(t('episode.vid.batchAlreadyRunning'))
    void startVideoBatchPolling()
    return
  }
  const failedCount = targets.filter(sb => latestVideoTask(sb.id)?.status === 'failed').length
  if (failedCount && !window.confirm(t('episode.vid.batchFailedConfirm', { n: failedCount }))) return
  batchVideoConfirm.value = { open: false, targets: [] }
  try {
    await episodeAPI.startVideoBatch(episode.value.id, {
      concurrency: batchVideoConcurrency.value,
      items: targets.map(sb => {
        const request = buildVideoGenerationParams(sb)
        if (latestVideoTask(sb.id)?.status === 'failed') request.force_new = true
        return { storyboard_id: sb.id, request }
      }),
    })
    toast.success(t('episode.vid.batchStartedConcurrent', { n: targets.length, c: batchVideoConcurrency.value }))
    if (videoSelectMode.value) toggleVideoSelectMode()
    lastBatchSettled = 0
    await refreshVideoBatch()
  } catch (error) {
    toastError(error, { fallback: 'episode.vid.genFailed' })
  }
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
    const data = await taskAPI.taskCenter(epId.value)
    taskCenterData.value = data
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
  genTasksPoll.stop()
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
// 顶栏角标以任务中心全量活跃计数为准（生成/语音/混音/流水线/导出）
const taskCenterActiveCount = computed(() => {
  const total = taskCenterData.value?.counts?.total_active
  if (typeof total === 'number') return total
  return genTaskActiveCount.value
})
const taskCenterDoneCount = computed(() => taskCenterRows.value.filter(row => row.statusClass === 'done').length)
const taskCenterFailedCount = computed(() => taskCenterRows.value.filter(row => row.statusClass === 'failed').length)
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

function extractTargetText(target) {
  if (target === 'characters') return t('common.role')
  if (target === 'scenes') return t('common.scene')
  if (target === 'props') return t('common.prop')
  return target
}

function genTaskTargetLabel(task) {
  if (task.type === 'video' && isEpisodeComfyTask(task)) return t('episode.tasks.wholeEpisode')
  // 文本/音频运行记录只有 stage，用它还原“这条任务在做什么”
  if (task.stage === 'video_prompts') return t('episode.tasks.runVideoPrompts')
  if (typeof task.stage === 'string' && task.stage.startsWith('extract.')) {
    return t('episode.tasks.runExtract', { target: extractTargetText(task.stage.slice('extract.'.length)) })
  }
  if (task.stage === 'take_batch') return t('episode.tasks.runTakeBatch')
  if (task.stage === 'dub') return t('episode.tasks.runDub')
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

// 统一行结构：sys_task（image/video/text/audio）+ merge + 任务中心四类来源
const genTaskRows = computed(() => {
  const taskRows = genTasks.value.map(t => ({
    key: `task-${t.id}`,
    kind: t.type || 'other', // image | video | text | audio
    category: 'tasks',
    id: t.id,
    targetLabel: genTaskTargetLabel(t),
    provider: t.provider || '',
    model: t.model || '',
    providerLabel: t.provider ? `${t.provider}${t.model ? ' · ' + t.model : ''}` : (t.model || ''),
    status: t.status || 'processing',
    statusClass: genTaskStateClass(t.status),
    statusLabel: genTaskStatusLabel(t.status),
    errorMsg: t.error_msg || '',
    storyboardId: t.storyboard_id,
    transitionId: t.transition_id || null,
    recoverable: t.type === 'video' && t.error_code !== 'generation_failed' && !!(t.task_id || t.result_url),
    previewUrl: t.local_path || t.result_url || '',
    previewType: t.type === 'video' ? 'video' : t.type === 'image' ? 'image' : 'none',
    detail: '',
    prompt: t.prompt || '',
    createdAt: t.created_at || '',
    completedAt: t.completed_at || '',
  }))
  const mergeRows = genMerges.value.map(m => ({
    key: `merge-${m.id}`,
    kind: 'merge',
    category: 'tasks',
    id: m.id,
    targetLabel: t('episode.tasks.fullMerge'),
    provider: m.provider || 'ffmpeg',
    model: m.model || '',
    providerLabel: `${m.provider || 'ffmpeg'}${m.model ? ' · ' + m.model : ''}`,
    status: m.status || 'pending',
    statusClass: genTaskStateClass(m.status),
    statusLabel: genTaskStatusLabel(m.status),
    errorMsg: m.error_msg || '',
    storyboardId: null,
    transitionId: null,
    recoverable: false,
    previewUrl: m.merged_url || '',
    previewType: 'video',
    detail: '',
    prompt: '',
    createdAt: m.created_at || '',
    completedAt: m.completed_at || '',
  }))
  return [...taskRows, ...mergeRows].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
})

function taskCenterStateClass(status) {
  if (status === 'completed' || status === 'ready' || status === 'done' || status === 'succeeded') return 'done'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  return 'pending'
}

function taskCenterStatusLabel(kind, status) {
  if (kind === 'voice') {
    if (status === 'ready') return t('episode.tasks.voiceReady')
    if (status === 'failed') return t('episode.status.failed')
    return t('episode.status.generating')
  }
  if (status === 'pending' || status === 'queued') return t('episode.tasks.statusQueued')
  if (status === 'running' || status === 'processing' || status === 'generating') return t('episode.tasks.statusRunning')
  if (status === 'completed' || status === 'ready' || status === 'done' || status === 'succeeded') return t('episode.status.done')
  if (status === 'cancelled') return t('episode.tasks.statusCancelled')
  if (status === 'failed') return t('episode.status.failed')
  return status || t('episode.status.generating')
}

function previewTypeForUrl(url) {
  const clean = String(url || '').split('?')[0].toLowerCase()
  if (!clean) return 'none'
  if (/\.(mp4|mov|webm|mkv)$/.test(clean)) return 'video'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(clean)) return 'audio'
  return 'none'
}

const voiceTaskRows = computed(() =>
  (taskCenterData.value?.voices?.items || []).map(item => ({
    key: `voice-${item.id}`,
    kind: 'voice',
    category: 'voices',
    id: item.id,
    targetLabel: item.line_no != null
      ? t('episode.tasks.voiceLine', { n: item.line_no })
      : (item.speaker_name || t('episode.tasks.kindVoice')),
    provider: item.provider || '',
    model: item.model || '',
    providerLabel: [item.speaker_name, item.take_no ? t('episode.tasks.takeN', { n: item.take_no }) : '', item.provider].filter(Boolean).join(' · '),
    status: item.status,
    statusClass: taskCenterStateClass(item.status),
    statusLabel: taskCenterStatusLabel('voice', item.status),
    errorMsg: item.error || '',
    storyboardId: null,
    transitionId: null,
    recoverable: false,
    previewUrl: item.audio_url || '',
    previewType: 'audio',
    detail: item.text || '',
    createdAt: item.created_at || '',
    completedAt: '',
  })),
)

const audioTaskRows = computed(() => {
  const audio = taskCenterData.value?.audio
  if (!audio) return []
  const rows = []
  if (audio.dubbing_status) {
    const activeTake = (taskCenterData.value?.voices?.items || []).find(item => item.status === 'generating')
    rows.push({
      key: 'audio-dub-session',
      kind: 'audio',
      category: 'audio',
      id: 'dub',
      targetLabel: t('episode.tasks.dubSession'),
      provider: '',
      model: '',
      providerLabel: audio.dub_progress ? `${audio.dub_progress}%` : '',
      status: audio.dubbing_status,
      statusClass: taskCenterStateClass(audio.dubbing_status),
      statusLabel: taskCenterStatusLabel('audio', audio.dubbing_status),
      errorMsg: '',
      storyboardId: null,
      transitionId: null,
      recoverable: false,
      previewUrl: '',
      previewType: 'none',
      detail: audio.dub_note || '',
      createdAt: activeTake?.created_at || '',
      completedAt: '',
    })
  }
  for (const job of audio.jobs || []) {
    rows.push({
      key: `audio-${job.id}`,
      kind: 'audio',
      category: 'audio',
      id: job.id,
      targetLabel: job.kind === 'soundscape'
        ? t('episode.tasks.jobSoundscape')
        : job.kind === 'separate' ? t('episode.tasks.jobSeparate') : t('episode.tasks.kindAudio'),
      provider: '',
      model: '',
      providerLabel: job.progress ? `${job.progress}%` : '',
      status: job.status,
      statusClass: taskCenterStateClass(job.status),
      statusLabel: taskCenterStatusLabel('audio', job.status),
      errorMsg: job.error || '',
      storyboardId: null,
      transitionId: null,
      recoverable: false,
      previewUrl: '',
      previewType: 'none',
      detail: job.step || '',
      createdAt: job.created_at || '',
      completedAt: job.finished_at || '',
    })
  }
  return rows
})

const pipelineTaskRows = computed(() => {
  const pipeline = taskCenterData.value?.pipeline
  if (!pipeline) return []
  const rows = []
  if (pipeline.enabled || pipeline.automation_status) {
    const latestJob = (pipeline.jobs || [])[0]
    const status = pipeline.automation_status || 'queued'
    rows.push({
      key: 'pipeline-automation',
      kind: 'pipeline',
      category: 'pipeline',
      id: 'auto',
      targetLabel: t('episode.tasks.pipelineAuto'),
      provider: '',
      model: '',
      providerLabel: [pipeline.automation_stage, pipeline.automation_progress ? `${pipeline.automation_progress}%` : ''].filter(Boolean).join(' · '),
      status,
      statusClass: taskCenterStateClass(status),
      statusLabel: taskCenterStatusLabel('pipeline', status),
      errorMsg: pipeline.automation_error || '',
      storyboardId: null,
      transitionId: null,
      recoverable: false,
      previewUrl: '',
      previewType: 'none',
      detail: pipeline.automation_note || '',
      createdAt: latestJob?.created_at || '',
      completedAt: '',
    })
  }
  for (const job of pipeline.jobs || []) {
    rows.push({
      key: `pipeline-${job.id}`,
      kind: 'pipeline',
      category: 'pipeline',
      id: job.id,
      targetLabel: t('episode.tasks.pipelineJob', { kind: job.kind || t('episode.tasks.kindOther') }),
      provider: '',
      model: '',
      providerLabel: job.progress ? `${job.progress}%` : '',
      status: job.status,
      statusClass: taskCenterStateClass(job.status),
      statusLabel: taskCenterStatusLabel('pipeline', job.status),
      errorMsg: job.error || '',
      storyboardId: null,
      transitionId: null,
      recoverable: false,
      previewUrl: '',
      previewType: 'none',
      detail: job.note || '',
      createdAt: job.created_at || '',
      completedAt: job.finished_at || '',
    })
  }
  return rows
})

const exportTaskRows = computed(() =>
  (taskCenterData.value?.exports || []).map(item => ({
    key: `export-${item.id}`,
    kind: 'export',
    category: 'exports',
    id: item.id,
    targetLabel: t('episode.tasks.exportJob'),
    provider: '',
    model: '',
    providerLabel: [item.kind, item.preset].filter(Boolean).join(' · '),
    status: item.status,
    statusClass: taskCenterStateClass(item.status),
    statusLabel: taskCenterStatusLabel('export', item.status),
    errorMsg: item.error || '',
    storyboardId: null,
    transitionId: null,
    recoverable: false,
    previewUrl: item.output_url || '',
    previewType: previewTypeForUrl(item.output_url),
    detail: item.file_name || '',
    createdAt: item.created_at || '',
    completedAt: item.finished_at || '',
  })),
)

const taskCenterRows = computed(() => [
  ...genTaskRows.value,
  ...voiceTaskRows.value,
  ...audioTaskRows.value,
  ...pipelineTaskRows.value,
  ...exportTaskRows.value,
].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')))

const visibleTaskCenterRows = computed(() => {
  if (taskCenterTab.value === 'all') return taskCenterRows.value
  return taskCenterRows.value.filter(row => row.category === taskCenterTab.value)
})

const taskCenterTabs = computed(() => {
  const counts = taskCenterData.value?.counts || {}
  return [
    { key: 'all', label: t('episode.tasks.tabAll'), count: taskCenterRows.value.length, active: taskCenterActiveCount.value },
    { key: 'tasks', label: t('episode.tasks.tabTasks'), count: genTaskRows.value.length, active: (counts.tasks_active || 0) + (counts.merges_active || 0) },
    { key: 'voices', label: t('episode.tasks.tabVoices'), count: voiceTaskRows.value.length, active: counts.voices_active || 0 },
    { key: 'audio', label: t('episode.tasks.tabAudio'), count: audioTaskRows.value.length, active: counts.audio_active || 0 },
    { key: 'pipeline', label: t('episode.tasks.tabPipeline'), count: pipelineTaskRows.value.length, active: counts.pipeline_active || 0 },
    { key: 'exports', label: t('episode.tasks.tabExports'), count: exportTaskRows.value.length, active: counts.exports_active || 0 },
  ]
})

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


// 后端任务在刷新/重启后仍可能运行，工作台持续同步，不依赖抽屉是否打开。
// 轮询自身负责隐藏暂停 / 恢复补刷 / 不并发，这里只按活跃任务数启停。
const genTasksPoll = useVisibilityPolling(() => refresh(), 4000)
watch(taskCenterActiveCount, active => {
  stopGenTasksPolling()
  if (active > 0) genTasksPoll.start()
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
const sceneImgCount = computed(() => inEpisodeScenes.value.filter(s => s.image_url || s.imageUrl).length)
const propImgCount = computed(() => inEpisodeProps.value.filter(p => p.image_url || p.imageUrl).length)
const shotVidCount = computed(() => sbs.value.filter(s => s.video_url || s.videoUrl).length)
const visualCharTotal = computed(() => visualChars.value.length)
const pendingCharacterImageCount = computed(() => Math.max(visualCharTotal.value - charImgCount.value, 0))
const pendingSceneImageCount = computed(() => Math.max(inEpisodeScenes.value.length - sceneImgCount.value, 0))
const pendingAssetImageCount = computed(() => pendingCharacterImageCount.value + pendingSceneImageCount.value)
const assetTotalCount = computed(() => visualCharTotal.value + inEpisodeScenes.value.length + inEpisodeProps.value.length)
const assetReadyCount = computed(() => charImgCount.value + sceneImgCount.value + propImgCount.value)

const prodTabDefs = computed(() => [
  { id: 'assets', label: t('episode.prod.assets'), icon: FolderKanban, badge: assetTotalCount.value ? `${assetReadyCount.value}/${assetTotalCount.value}` : '' },
  { id: 'videos', label: t('episode.prod.videos'), icon: Clapperboard, badge: sbs.value.length ? `${shotVidCount.value}/${sbs.value.length}` : '' },
])

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
    : !!(chars.value.length || inEpisodeScenes.value.length || inEpisodeProps.value.length || sbs.value.length || shotVidCount.value)
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

const mobileStage = computed(() => {
  if (taskDrawer.value) return 'tasks'
  if (panel.value === 'script') return 'script'
  if (panel.value === 'production') {
    if (prodTab.value === 'assets') return 'assets'
    return tabletPane.value === 'shots' ? 'storyboard' : 'generate'
  }
  return ''
})

function selectMobileStage(stage) {
  mobileMoreOpen.value = false
  if (stage === 'tasks') {
    openTaskDrawer()
    return
  }
  if (taskDrawer.value) closeTaskDrawer()
  if (stage === 'script' || stage === 'assets') {
    goMainStage(stage)
    return
  }
  if (stage === 'storyboard' || stage === 'generate') {
    panel.value = 'production'
    prodTab.value = 'videos'
    setTabletPane(stage === 'storyboard' ? 'shots' : 'edit')
  }
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

const { setStage: setPresenceStage } = usePresence()
watch(activeSubStepKey, key => setPresenceStage(key), { immediate: true })

// ===== 平板页签 / 步骤抽屉 / 播放器暂停 =====
const TABLET_PANES = ['shots', 'edit', 'preview']

function pauseMainPlayer() {
  videoPlayerEl.value?.pause()
}
function pauseVideosExceptMain() {
  const root = videoWorkbenchEl.value
  if (!root) return
  root.querySelectorAll('video').forEach((el) => {
    if (el !== videoPlayerEl.value && !el.paused) el.pause()
  })
}
function setTabletPane(pane) {
  if (!isCompact.value) return
  if ((pane === 'edit' || pane === 'preview') && !selectedSb.value) {
    const first = videoTaskRows.value[0]
    if (first) selectedSb.value = videoTaskRows.value[0].storyboard
  }
  const previous = tabletPane.value
  tabletPane.value = pane
  if (pane === 'preview') nextTick(() => pauseVideosExceptMain())
  else if (previous === 'preview') pauseMainPlayer()
}
function onTabletTabsKeydown(event, pane) {
  const index = TABLET_PANES.indexOf(pane)
  let next = null
  if (event.key === 'ArrowLeft') next = (index + TABLET_PANES.length - 1) % TABLET_PANES.length
  else if (event.key === 'ArrowRight') next = (index + 1) % TABLET_PANES.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = TABLET_PANES.length - 1
  if (next === null) return
  event.preventDefault()
  const target = TABLET_PANES[next]
  setTabletPane(target)
  nextTick(() => document.getElementById(`video-tab-${target}`)?.focus())
}

const stepsDrawerHistory = useOverlayHistory(() => closeStepsDrawer())

function scrollActiveStepIntoView(mode = 'horizontal') {
  nextTick(() => {
    const root = pipelineEl.value
    const active = root?.querySelector('.pipe-item.active')
    if (!root || !active) return
    if (mode === 'vertical') {
      const top = active.offsetTop - root.clientHeight / 2 + active.clientHeight / 2
      root.scrollTo({ top, behavior: 'smooth' })
      return
    }
    const left = active.offsetLeft - root.clientWidth / 2 + active.clientWidth / 2
    root.scrollTo({ left, behavior: 'smooth' })
  })
}
function focusStepsDrawer() {
  const root = stepsDrawerEl.value
  // 媒体控件（音频/视频）同样可聚焦；没有按钮类元素时回落到它们
  const first = root?.querySelector('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    || root?.querySelector('audio[controls], video[controls]')
  first?.focus()
}
function openStepsDrawer() {
  pauseMainPlayer()
  stepsDrawerOpen.value = true
  stepsDrawerHistory.open()
  nextTick(() => {
    focusStepsDrawer()
    scrollActiveStepIntoView('vertical')
  })
}
function closeStepsDrawer() {
  stepsDrawerOpen.value = false
  stepsDrawerHistory.close()
}
function onStepsDrawerKeydown(event) {
  if (!stepsDrawerOpen.value || event.key !== 'Tab') return
  const root = stepsDrawerEl.value
  if (!root) return
  const focusables = Array.from(root.querySelectorAll('button, a[href], input, select, textarea, audio[controls], video[controls], [tabindex]:not([tabindex="-1"])'))
    .filter(el => !el.disabled && el.getAttribute('aria-hidden') !== 'true')
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

function saveTabletEdit() {
  flushPendingStoryboardUpdates()
  toast.success(t('common.saved'))
}

function startEpisodeTour() {
  if (isCompact.value) setTabletPane('shots')
  if (isNarrow.value) {
    openStepsDrawer()
    setTimeout(() => startTour('episode', EPISODE_TOUR, t), 260)
    return
  }
  startTour('episode', EPISODE_TOUR, t)
}

watch(isNarrow, (narrow) => { if (!narrow && stepsDrawerOpen.value) closeStepsDrawer() })
watch([activeSubStepKey, viewportWidth], () => {
  if (viewportWidth.value <= 1080) scrollActiveStepIntoView('horizontal')
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
    try { scenes.value = await episodeAPI.scenes(ep.id, { scope: 'all' }) } catch {}
    try { propItems.value = await episodeAPI.props(ep.id, { scope: 'all' }) } catch {}
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
      syncBreakdownMethodKey()
      try { chars.value = await episodeAPI.characters(ep.id) } catch { chars.value = [] }
      try { scenes.value = await episodeAPI.scenes(ep.id, { scope: 'all' }) } catch { scenes.value = [] }
      try { propItems.value = await episodeAPI.props(ep.id, { scope: 'all' }) } catch { propItems.value = [] }
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
  // 刷新后若合并仍在进行，恢复轮询，保证状态卡最终收敛
  if (mergeData.value?.status === 'pending' || mergeData.value?.status === 'processing') startMergePolling()
  await Promise.all([loadGenTasks(), loadExportMerges(), loadFrameAssets(), loadStoryboardAudit({ silent: true })])
}

const { remoteChange, applyRemoteChange, keepLocalChanges } = useSyncedRefresh({
  id: 'drama-episode',
  match: path => /^\/api\/v1\/(episodes|storyboards|characters|scenes|props|merge|tasks|films|exports|agent\/storyboard_auditor)(\/|$)/.test(path),
  refresh,
  isDirty: () => Boolean(
    hasPendingStoryboardUpdates()
    || assetPromptDirty.value
    || Object.values(transitionPromptDirty.value).some(Boolean)
    || assetCreate.value.open
    || hasFocusedEditor()
  ),
  isSaving: () => Boolean(
    hasPendingStoryboardUpdates()
    || savingAssetDetail.value
    || assetCreate.value.saving
    || methodSaving.value
  ),
})

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
  if (auditRunning.value) { toast.warning(t('episode.audit.runningBlocked')); return }
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
async function doBreakdown() {
  if (auditRunning.value) { toast.warning(t('episode.audit.runningBlocked')); return }
  if (rn.value || methodSaving.value || splitStarting.value || splitRunning.value) return
  if (sbs.value.length > 0) {
    const confirmed = window.confirm(t('episode.sb.rebreakConfirm', { n: sbs.value.length, method: currentBreakdownMethodName.value }))
    if (!confirmed) return
  }
  const charList = bindableChars.value.length
    ? bindableChars.value.map(c => `${c.name}(ID:${c.id})`).join('、')
    : '（项目还没有角色）'
  const sceneList = bindableScenes.value.length
    ? bindableScenes.value.map(s => `${s.location} · ${s.time || '未设时间'}(ID:${s.id})`).join('、')
    : '（项目还没有场景）'
  const propList = bindableProps.value.length
    ? bindableProps.value.map(p => `${p.name}(ID:${p.id})`).join('、')
    : '（项目还没有道具）'
  const rule = renderPipelineRule('storyboards', {
    videoModel: effectiveVideoModelLabel.value,
    characters: charList,
    scenes: sceneList,
    props: propList,
  }, DEFAULT_BREAKDOWN_RULE)
  // 分块拆分在后端逐段调用并即时保存；旧分镜替换、跨段镜头编号都由系统处理，无需在指令里声明
  splitStarting.value = true
  try {
    const result = await storyboardSplitAPI.create({
      episode_id: epId.value,
      drama_id: dramaId,
      message: rule,
      model: chatModelOverride(),
      config_id: chatConfigId(),
    })
    if (!result?.job) {
      toast.error(t('episode.sb.splitStartFailed'))
      return
    }
    splitLastCompleted.value = Number(result.job.completed_chunks || 0)
    applySplitJob(result.job, { silent: true })
    if (splitRunning.value) startSplitPolling()
    if (result.already_running) toast.info(t('episode.sb.splitAlreadyRunning'))
  } catch (e) {
    toastError(e, { fallback: 'episode.sb.splitStartFailed' })
  } finally {
    splitStarting.value = false
  }
}

/** 从断点继续拆分：后端跳过已完成分段，只重跑未完成分段 */
async function resumeSplit() {
  if (auditRunning.value) { toast.warning(t('episode.audit.runningBlocked')); return }
  const job = splitJob.value
  if (!job?.id || splitStarting.value || splitRunning.value) return
  splitStarting.value = true
  try {
    const result = await storyboardSplitAPI.resume(job.id)
    if (result?.job) {
      applySplitJob(result.job, { silent: true })
      if (splitRunning.value) startSplitPolling()
      toast.success(t('episode.sb.splitResumed'))
    }
  } catch (e) {
    toastError(e, { fallback: 'episode.sb.splitActionFailed' })
  } finally {
    splitStarting.value = false
  }
}

/** 拆分完成后刷新并自动补齐缺失的视频提示词（兜住 Agent 漏写/截断） */
async function onBreakdownDone() {
  await refresh()
  void loadStoryboardAuditAfterSplit()
  const missing = sbs.value.filter(sb => !(sb.video_prompt || sb.videoPrompt || '').trim())
  if (missing.length) batchVideoPrompts()
}

// 按需为单个分镜生成视频提示词：由 prompt_generator 读取分镜字段生成并保存到 video_prompt
async function genVideoPrompt(sb) {
  if (auditRunning.value) { toast.warning(t('episode.audit.runningBlocked')); return }
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
function assetBatchImages(kind) {
  if (kind === 'character') batchCharImages()
  else if (kind === 'scene') batchSceneImages()
  else batchPropImages()
}

function assetGenerate(kind, id) {
  if (kind === 'character') genCharImg(id)
  else if (kind === 'scene') genSceneImg(id)
  else genPropImg(id)
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
  // 批量生图只覆盖本集场景：全剧共享列表里的其他集资产由各自页面处理
  const ids = inEpisodeScenes.value.filter(s => !(s.image_url || s.imageUrl)).map(s => s.id)
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
  // 批量生图只覆盖本集道具：全剧共享列表里的其他集资产由各自页面处理
  const ids = inEpisodeProps.value.filter(p => !(p.image_url || p.imageUrl)).map(p => p.id)
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

// 上一分镜末帧（本集资产）：作为当前镜参考图，并可用 @镜头N末帧 在提示词里引用
function getPreviousShotFrameRef(sb) {
  const index = sbs.value.findIndex(item => Number(item.id) === Number(sb?.id))
  if (index <= 0) return null
  const prevShot = sbs.value[index - 1]
  const asset = frameAssets.value.find(item =>
    Number(item?.storyboard_id ?? item?.storyboardId) === Number(prevShot.id))
  const url = asset?.url || ''
  if (!url) return null
  const shotNumber = storyboardNumberOf(prevShot) || index
  return { asset, url, token: `镜头${shotNumber}末帧`, shotNumber }
}

// 生成参考图顺序：上一镜末帧置顶（保证占位），随后场景、角色、道具
function getShotReferenceEntries(sb) {
  const entries = []
  const seen = new Set()
  const push = (name, url) => {
    if (!url || seen.has(url) || entries.length >= refImageLimit.value) return
    seen.add(url)
    entries.push({ name, url })
  }
  const previous = getPreviousShotFrameRef(sb)
  if (previous) push(previous.token, previous.url)
  const scene = getStoryboardScene(sb)
  push(scene?.location || '', scene?.image_url || scene?.imageUrl)
  for (const char of getStoryboardCharacters(sb)) {
    push(char.name || '', char?.image_url || char?.imageUrl)
  }
  for (const prop of getStoryboardProps(sb)) {
    push(prop.name || '', prop?.image_url || prop?.imageUrl)
  }
  return entries
}

function getShotReferenceImages(sb) {
  return getShotReferenceEntries(sb).map(entry => entry.url)
}

// ===== 分镜末帧资产：只在本集生效，可设为镜头首帧作为下一镜转场开头 =====
const frameAssets = ref([])
const frameAssetExtracting = ref(false)
const frameAssetBusyId = ref(null)

const currentShotFirstFrame = computed(() => {
  const sb = selectedSb.value
  return sb?.first_frame_image || sb?.firstFrameImage || ''
})
const episodeFrameAssets = computed(() => frameAssets.value)
const previousShotFrameRef = computed(() => getPreviousShotFrameRef(selectedSb.value))
const frameAssetsForInspector = computed(() => episodeFrameAssets.value.map(asset => ({
  ...asset,
  src: frameAssetSource(asset),
  shotNumber: frameAssetShotNumber(asset),
  current: isCurrentShotAsset(asset),
})))
const canExtractLastFrame = computed(() => {
  if (!mediaOutputReady.value || isComfyVideoMode.value || previewVideoUrl.value) return false
  const url = String(selectedSb.value?.video_url || selectedSb.value?.videoUrl || '')
  return !!url && !/^https?:\/\//i.test(url)
})

function isCurrentShotAsset(asset) {
  return Number(asset?.storyboard_id ?? asset?.storyboardId ?? 0) === Number(selectedSb.value?.id || 0)
}
function frameAssetSource(asset) {
  return videoSourceUrl(asset?.url || '')
}
function frameAssetShotNumber(asset) {
  const sourceId = Number(asset?.storyboard_id ?? asset?.storyboardId ?? 0)
  const index = sbs.value.findIndex(item => item.id === sourceId)
  return index >= 0 ? index + 1 : (asset?.storyboard_num ?? asset?.storyboardNum ?? '')
}
function setStoryboardFirstFrameLocal(storyboardId, url) {
  const sb = sbs.value.find(item => item.id === storyboardId)
  if (!sb) return
  sb.first_frame_image = url
  sb.firstFrameImage = url
}
async function loadFrameAssets() {
  if (!epId.value) { frameAssets.value = []; return }
  try {
    frameAssets.value = (await frameAssetAPI.list(epId.value)) || []
  } catch {
    frameAssets.value = []
  }
}
async function extractShotLastFrame(sb = selectedSb.value) {
  if (!sb?.id || frameAssetExtracting.value) return
  frameAssetExtracting.value = true
  try {
    const result = await frameAssetAPI.extractLast(sb.id)
    const asset = result?.asset
    const previousUrl = frameAssets.value.find(item => item.id === asset?.id)?.url
    // 重新抽帧后地址会变：本集手工引用旧地址的首帧同步换新
    if (previousUrl && asset?.url && previousUrl !== asset.url) {
      for (const item of sbs.value) {
        if ((item.first_frame_image || item.firstFrameImage) === previousUrl) {
          setStoryboardFirstFrameLocal(item.id, asset.url)
        }
      }
    }
    await loadFrameAssets()
    toast.success(t('episode.frameAssets.extracted'))
  } catch (e) {
    toastError(e, { fallback: 'episode.frameAssets.extractFailed' })
  } finally {
    frameAssetExtracting.value = false
  }
}
async function setShotFirstFrame(asset) {
  const sb = selectedSb.value
  if (!sb?.id || !asset?.id || frameAssetBusyId.value) return
  frameAssetBusyId.value = asset.id
  try {
    const result = await frameAssetAPI.setFirstFrame(sb.id, asset.id)
    setStoryboardFirstFrameLocal(sb.id, result?.first_frame_image || asset.url)
    toast.success(t('episode.frameAssets.firstFrameSet'))
  } catch (e) {
    toastError(e, { fallback: 'episode.frameAssets.firstFrameSetFailed' })
  } finally {
    frameAssetBusyId.value = null
  }
}
async function clearShotFirstFrame(sb = selectedSb.value) {
  if (!sb?.id) return
  try {
    await frameAssetAPI.setFirstFrame(sb.id, null)
    setStoryboardFirstFrameLocal(sb.id, null)
    toast.success(t('episode.frameAssets.firstFrameCleared'))
  } catch (e) {
    toastError(e, { fallback: 'episode.frameAssets.firstFrameClearFailed' })
  }
}
async function removeFrameAsset(asset) {
  if (!asset?.id || !epId.value) return
  if (!window.confirm(t('episode.frameAssets.deleteConfirm'))) return
  try {
    await frameAssetAPI.del(epId.value, asset.id)
    frameAssets.value = frameAssets.value.filter(item => item.id !== asset.id)
    for (const item of sbs.value) {
      if ((item.first_frame_image || item.firstFrameImage) === asset.url) {
        setStoryboardFirstFrameLocal(item.id, null)
      }
    }
    toast.success(t('episode.frameAssets.deleted'))
  } catch (e) {
    toastError(e, { fallback: 'episode.frameAssets.deleteFailed' })
  }
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
  const previous = previousShotFrameRef.value
  return [
    ...(previous ? [{
      label: previous.token,
      value: previous.token,
      kind: 'frame',
      group: t('episode.frameAssets.previousRef'),
      image: thumbOf(videoSourceUrl(previous.url)),
    }] : []),
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

// 按参考图顺序（上一镜末帧、场景图、角色图、道具图）为 @名字 建立索引映射，供视频提示词引用替换
function getShotReferenceIndexMap(sb) {
  const nameToIndex = {}
  getShotReferenceEntries(sb).forEach((entry, i) => {
    if (entry.name && !(entry.name in nameToIndex)) nameToIndex[entry.name] = i + 1
  })
  return nameToIndex
}

// 上一镜末帧作为延续参考：提示词自动带一行 @镜头N末帧；用户已手写该引用时不重复
function appendPreviousFramePrompt(sb, prompt) {
  const previous = getPreviousShotFrameRef(sb)
  if (!previous) return prompt
  const token = `@${previous.token}`
  if (prompt.includes(token)) return prompt
  const line = t('episode.frameAssets.promptLine', { token: previous.token })
  return prompt.trim() ? `${line}\n${prompt}` : line
}

// 将视频提示词里的 @名字 替换为 @图片N名字（N 为参考图序号，1 起），生成时使用
function resolveVideoPromptRefs(sb) {
  const prompt = appendPreviousFramePrompt(sb, sb.video_prompt || sb.videoPrompt || '')
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
// 下限 2s，上限按当前模型/分辨率收紧（本地 H3 720p 为 8s），列表/批量/单次生成统一读取该值
function onVideoDurationChange(e) {
  const sb = selectedSb.value
  if (!sb) return
  const min = 2
  const max = videoDurationMax.value
  let v = Math.round(Number(e.target.value))
  if (!Number.isFinite(v)) v = Number(sb.duration || 10)
  v = Math.min(max, Math.max(min, v))
  e.target.value = v
  updateField(sb, 'duration', v)
}

function pickFile(accept, cb) {
  if (!ensureOnline()) return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.onchange = () => {
    const f = input.files?.[0]
    if (!f) return
    const check = checkUploadFile(f, 'image')
    if (!check.ok) { toast.error(t(uploadErrorKey(check, 'image'))); return }
    cb(f)
  }
  input.click()
}

function pickFiles(accept, cb) {
  if (!ensureOnline()) return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.multiple = true
  input.onchange = () => {
    const files = Array.from(input.files || [])
    const valid = []
    const notified = new Set()
    for (const f of files) {
      const check = checkUploadFile(f, 'image')
      if (check.ok) { valid.push(f); continue }
      const key = uploadErrorKey(check, 'image')
      if (notified.has(key)) continue
      notified.add(key)
      toast.error(t(key))
    }
    if (valid.length) cb(valid)
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

function buildVideoGenerationParams(sb) {
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
  return params
}

async function genVid(sb, opts = {}) {
  if (auditRunning.value) { toast.warning(t('episode.audit.runningBlocked')); return }
  if (isComfyVideoMode.value) {
    if (!opts.silent) toast.warning(t('episode.comfy.nativeOnly'))
    return
  }
  if (!opts.forceNew && canRecoverVideo(sb.id)) return recoverVideo(sb)
  const latest = latestVideoTask(sb.id)
  const forceNew = opts.forceNew || latest?.status === 'failed'
  if (forceNew && !window.confirm(t('episode.recovery.confirmNew'))) return
  const params = buildVideoGenerationParams(sb)
  if (!params.prompt && !params.reference_image_urls.length) {
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
    first_frame_upload_url: null,
    last_frame_upload_url: null,
    reference_image_urls: [],
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
  openPreviewShot({
    id: `transition-${boundary.id}`,
    video_url: boundary.video_url,
    duration: Number(boundary.duration_actual) || null,
    previewLabel: t('episode.export.aiTransition.previewTitle', {
      from: boundary.from_number,
      to: boundary.to_number,
    }),
    downloadName: `transition-S${boundary.from_number}-S${boundary.to_number}.mp4`,
  })
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
// 转场任务同步：3s 一轮；seq 失效（页面切走 / 重新加载）时自停，错误下一轮继续
const transitionPoll = useVisibilityPolling(async () => {
  if (transitionSeq !== transitionRequestSeq) { stopTransitionPolling(); return }
  try {
    const data = await transitionAPI.list(epId.value)
    if (transitionSeq !== transitionRequestSeq) return
    applyTransitionData(data)
    if (!transitionBusy.value) stopTransitionPolling()
  } catch { /* 下一轮继续 */ }
}, 3000)
function stopTransitionPolling() {
  transitionPoll.stop()
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
  transitionSeq = seq
  stopTransitionPolling()
  if (!transitionBusy.value) return
  // 离开导出页后旧轮询不再复活
  if (panel.value !== 'export') return
  transitionPoll.start()
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
  if (auditRunning.value) { toast.warning(t('episode.audit.runningBlocked')); return }
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
  if (!mediaOutputReady.value) {
    toast.warning(t('media.capability.actionDisabled'))
    return
  }
  if (auditRunning.value) { toast.warning(t('episode.audit.runningBlocked')); return }
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
  if (!mediaOutputReady.value) {
    toast.warning(t('media.capability.actionDisabled'))
    return
  }
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
  if (auditRunning.value) { toast.warning(t('episode.audit.runningBlocked')); return }
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

// ===== 过渡参考图：出入帧槽位上传 + 追加参考图列表 =====
const transitionRefBusy = ref({})
function setTransitionRefBusy(key, busy) {
  const next = { ...transitionRefBusy.value }
  if (busy) next[key] = true
  else delete next[key]
  transitionRefBusy.value = next
}
function transitionUploadedFrameUrl(boundary, slot) {
  const url = slot === 'first' ? boundary?.first_frame_upload_url : boundary?.last_frame_upload_url
  return String(url || '').trim() || null
}
function transitionDetailEffectiveFrameUrl(boundary, slot) {
  const uploaded = transitionUploadedFrameUrl(boundary, slot)
  if (uploaded) return uploaded
  const url = slot === 'first' ? boundary?.first_frame_url : boundary?.last_frame_url
  return String(url || '').trim() || null
}
function transitionReferenceUrls(boundary) {
  const list = Array.isArray(boundary?.reference_image_urls) ? boundary.reference_image_urls : []
  return list.filter(u => String(u || '').trim())
}
function transitionReferenceLimit() {
  const value = Number(transitionState.value.provider?.reference_images_max)
  return Number.isFinite(value) && value > 0 ? value : 0
}
function transitionReferenceAllowed() {
  return transitionState.value.provider?.reference_images_allowed === true
}
function transitionRefCountLabel(b) {
  const n = transitionReferenceUrls(b).length
  return n > 0 ? t('episode.export.aiTransition.refsBadge', { n }) : ''
}
async function saveTransitionReferences(boundary, payload) {
  if (!boundary?.id) return false
  try {
    await transitionAPI.saveReferenceImages(boundary.id, payload)
    await loadTransitions()
    return true
  } catch (e) {
    toastError(e, { fallback: 'episode.export.aiTransition.actionFailed' })
    return false
  }
}
function uploadTransitionSlotImage(boundary, slot) {
  if (!boundary?.id) return
  pickFile('image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp', async (file) => {
    const key = `slot:${slot}:${boundary.id}`
    if (transitionRefBusy.value[key]) return
    setTransitionRefBusy(key, true)
    try {
      const res = await uploadAPI.image(file, dramaId)
      const field = slot === 'first' ? 'first_frame_upload_url' : 'last_frame_upload_url'
      const ok = await saveTransitionReferences(boundary, { [field]: res.path })
      if (ok) toast.success(t('episode.export.aiTransition.slotUpdated'))
    } catch (e) {
      toastError(e)
    } finally {
      setTransitionRefBusy(key, false)
    }
  })
}
async function resetTransitionSlot(boundary, slot) {
  const key = `slot:${slot}:${boundary?.id}`
  if (!boundary?.id || transitionRefBusy.value[key]) return
  setTransitionRefBusy(key, true)
  try {
    const field = slot === 'first' ? 'first_frame_upload_url' : 'last_frame_upload_url'
    const ok = await saveTransitionReferences(boundary, { [field]: null })
    if (ok) toast.success(t('episode.export.aiTransition.slotRestored'))
  } finally {
    setTransitionRefBusy(key, false)
  }
}
function addTransitionReferences(boundary) {
  if (!boundary?.id) return
  const existing = transitionReferenceUrls(boundary)
  const limit = transitionReferenceLimit()
  const room = limit > 0 ? limit - existing.length : 0
  if (room <= 0) {
    toast.info(t('episode.export.aiTransition.refsLimit', { n: limit }))
    return
  }
  pickFiles('image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp', async (files) => {
    const key = `refs:${boundary.id}`
    if (transitionRefBusy.value[key]) return
    setTransitionRefBusy(key, true)
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
      const ok = await saveTransitionReferences(boundary, { reference_image_urls: [...existing, ...uploaded] })
      if (ok) toast.success(t('episode.export.aiTransition.refsDone'))
    } finally {
      setTransitionRefBusy(key, false)
    }
  })
}
async function removeTransitionReference(boundary, index) {
  const key = `refs:${boundary?.id}`
  if (!boundary?.id || transitionRefBusy.value[key]) return
  setTransitionRefBusy(key, true)
  try {
    const next = transitionReferenceUrls(boundary).filter((_, i) => i !== index)
    const ok = await saveTransitionReferences(boundary, { reference_image_urls: next })
    if (ok) toast.success(t('episode.export.aiTransition.refsRemoved'))
  } finally {
    setTransitionRefBusy(key, false)
  }
}

function openMergeDialog() {
  if (exportLocalOnly.value) {
    toast.info(t('export.gate.hint'))
    return
  }
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
  mergeDialogHistory.open()
}
function confirmMerge() {
  const ids = [...mergeDialog.value.ids]
  const title = mergeDialog.value.title.trim()
  const useAiTransitions = mergeDialog.value.useAiTransitions && transitionSupported.value
  closeMergeDialog()
  void doMerge(ids, title, useAiTransitions)
}
// 合并轮询收敛到一处：doMerge 与 refresh 共用，组件卸载 / 页面隐藏时停止
const mergePoll = useVisibilityPolling(async () => {
  try { mergeData.value = await mergeAPI.status(epId.value) } catch { /* 网络抖动继续轮询 */ }
  // 请求返回时轮询已被停掉（卸载 / 被刷新取代）：不再 toast、不再改状态卡
  if (!mergePoll.isRunning()) return
  if (mergeData.value?.status === 'completed' || mergeData.value?.status === 'failed') {
    stopMergePolling()
    if (mergeData.value.status === 'completed') {
      toast.success(t('episode.export.mergeDone'))
      loadExportMerges()
    } else {
      toastError(mergeData.value?.error_msg || mergeData.value?.errorMsg, { fallback: 'episode.export.mergeFailed' })
    }
  }
}, 3000)
function stopMergePolling() {
  mergePoll.stop()
}
function startMergePolling() {
  stopMergePolling()
  mergePoll.start()
}
async function doMerge(ids, title, useAiTransitions = false) {
  if (exportLocalOnly.value) {
    toast.info(t('export.gate.hint'))
    return
  }
  if (!ensureOnline()) return
  const storyboardIds = Array.isArray(ids) ? ids : undefined
  if (storyboardIds && !storyboardIds.length) {
    toast.error(t('episode.export.selectFirst'))
    return
  }
  let res = null
  try {
    res = await mergeAPI.merge(epId.value, storyboardIds, title, useAiTransitions)
    toast.success(t('episode.export.mergingToast'))
  } catch (e) {
    toastError(e, { fallback: 'episode.export.mergeFailed' })
    return
  }
  // 乐观写入状态：状态卡常驻展示，不依赖 toast；后端未提供百分比，仅不确定进度
  mergeData.value = { ...(mergeData.value || {}), id: res?.merge_id, status: 'processing', title }
  startMergePolling()
}
async function deleteMerge(m) {
  if (!m?.id) return
  if (!window.confirm(t('episode.export.deleteConfirm', { title: m.title || t('episode.export.untitled') }))) return
  try {
    await mergeAPI.del(m.id)
    if (activeMerge.value?.id === m.id) closeActiveMerge()
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
  void loadBreakdownMethods()
  await refresh()
  // 恢复本集最近一次分块拆分任务（运行中继续显示进度，失败/中断显示续拆入口）
  void restoreSplitJob()
  // 恢复后端运行中的批量视频批次（关闭页面/重启应用后继续）
  void refreshVideoBatch()
  loadConfigs()
  syncExtractStatus()
  loadPipelineRules()
  loadDubbingEnabled()
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
/* ===== Studio Layout ===== */
.studio {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
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

.studio-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  min-height: 40px;
  padding: 4px 10px;
  border-radius: var(--radius-lg);
  background: var(--header-bg);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
}

.studio-topbar-main,
.sidebar,
.main {
  background: var(--surface-raised);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-card);
}

.studio-topbar-main {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  border: 0;
  box-shadow: none;
  backdrop-filter: none;
  background: transparent;
  min-width: 0;
}

/* 用更高特异性压过后面的 .back-btn{height:40px}，保持顶栏紧凑 */
.studio-topbar .topbar-back {
  width: auto;
  min-width: 72px;
  padding: 0 12px;
  height: 26px;
  border-radius: var(--radius-pill);
  white-space: nowrap;
  font-size: 11px;
}

.studio-identity {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.studio-overline {
  display: none;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

.studio-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.studio-title {
  font-size: 13px;
  line-height: 1;
  letter-spacing: -0.04em;
  white-space: nowrap;
}

.studio-episode-chip {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 9px;
  font-weight: 700;
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
  height: 18px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 8px;
  font-weight: 600;
  white-space: nowrap;
}

.studio-meta-pill.is-stage {
  background: var(--accent-bg);
  color: var(--accent-text);
}
.studio-meta-pill.is-progress {
  background: var(--success-bg);
  color: var(--success);
}
.studio-meta-inline {
  font-size: 9px;
  color: var(--text-3);
  font-weight: 600;
  white-space: nowrap;
}
.studio-meta-hint {
  font-size: 9px;
  color: var(--warning);
  font-weight: 600;
  white-space: nowrap;
  cursor: help;
}

.studio-topbar-side {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.studio-actions {
  display: flex;
  gap: 6px;
}
.studio-topbar .btn {
  height: 26px;
  padding: 0 9px;
  font-size: 10.5px;
  white-space: nowrap;
}

.remote-relay-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 16px;
  border-bottom: 1px solid var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-text);
  font-size: 12.5px;
  line-height: 1.5;
}
.remote-relay-icon { flex-shrink: 0; }
.remote-relay-hint span { flex: 1; min-width: 0; }
.remote-relay-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--warn-text);
  cursor: pointer;
}
.remote-relay-close:hover { background: var(--warn-link-hover-bg); }
.remote-relay-close:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3.5px var(--button-focus);
}
@media (pointer: coarse) {
  .remote-relay-close { width: var(--tap-min); height: var(--tap-min); }
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
  box-shadow: 0 0 0 3.5px var(--button-focus);
}

/* Pipeline Nav */
.pipeline { flex: 1; overflow-y: auto; padding: 12px 10px 8px; display: flex; flex-direction: column; gap: 8px; }
.pipe-section { display: flex; flex-direction: column; gap: 2px; }
.pipe-section-label {
  display: flex; align-items: center; gap: 5px;
  font-size: 10.5px; font-weight: 700; color: var(--text-3);
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
  font-size: 9.5px; font-weight: 600; letter-spacing: 0.03em;
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
  font-size: 13px; font-weight: 600;
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
  box-shadow: 0 0 0 3px var(--button-focus), var(--button-shadow);
}
.pipe-item.done { color: var(--text-2); }
.pipe-item-sub {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  padding: 5px 8px;
  position: relative;
  min-height: 34px;
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

.pipe-label { flex: 1; font-size: 12.5px; }
.pipe-copy { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.pipe-sub {
  display: none;
  font-size: 10px;
  line-height: 1.35;
  color: var(--text-3);
  font-weight: 500;
}
.pipe-badge {
  font-size: 9px; font-weight: 700; padding: 1px 5px;
  border-radius: 99px; background: var(--bg-3); color: var(--text-3);
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
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-1);
}
.sidebar-progress-count {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
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
  box-shadow: 0 0 0 3px var(--button-focus);
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
  font-size: 10.5px;
  color: var(--text-3);
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
  box-shadow: 0 0 0 3px var(--button-focus), var(--button-shadow-hover);
}

/* ===== Main Content ===== */
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; min-height: 0; border-radius: var(--radius); }
.content-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; min-height: 0; }
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
  font-family: var(--font-mono); font-size: 10px; font-weight: 800; color: var(--accent-text); letter-spacing: 0.05em;
}
.step-name { font-size: 12.5px; font-weight: 700; color: var(--text-1); font-family: var(--font-display); }
.char-count { font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }

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
.detail-section-copy { font-size: 11px; color: var(--text-3); }

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
  box-shadow: 0 0 0 3px var(--button-focus), var(--button-shadow);
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
  box-shadow: 0 0 0 3px var(--button-focus);
}
.video-method-pick { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap; }
.video-method-pick .video-method-select {
  width: auto; max-width: 200px; flex: 0 0 auto;
  height: 26px; padding: 0 22px 0 8px; font-size: 11px;
  background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text-1); cursor: pointer;
}
.video-method-select:disabled { opacity: .55; cursor: not-allowed; }
.video-method-hint { font-size: 11px; color: var(--text-3); white-space: nowrap; }
/* 分块拆分进度条：运行中显示已完成段数，失败/中断后提供断点续拆 */
.video-split-banner {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; margin: 0 0 6px;
  font-size: 12px; color: var(--text-2);
  background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius);
}
.video-split-banner-text { flex: 1; min-width: 0; }
.video-split-progress { color: var(--accent); }
.video-split-failed { color: var(--warning); }
.video-split-resume { color: var(--accent); border-color: var(--accent); }




/* Production content */
.prod-content { flex: 1; overflow-y: auto; padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.prod-section-bar { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }




/* 新增资产弹窗 */
.asset-create-dialog { width: 440px; max-width: calc(100vw - 48px); }
.asset-create-body { display: flex; flex-direction: column; gap: 10px; }

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
.video-task-status.is-done {
  color: var(--success);
  border-color: var(--success-bg);
  background: var(--success-bg);
}
.video-task-status.is-pending,
.video-task-status.is-ready {
  color: var(--accent-text);
  border-color: var(--accent-glow);
  background: var(--accent-bg);
}
.video-task-status.is-failed,
.video-task-status.is-blocked {
  color: var(--warning);
  border-color: var(--warning-bg);
  background: var(--warning-bg);
}

/* 批量视频：选择模式 */
.btn.is-on { border-color: var(--accent); color: var(--accent-text); background: var(--accent-bg); }
.video-retry-failed { color: var(--warning); border-color: var(--warning-bg); }

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
.batch-video-concurrency-select {
  min-width: 68px;
  padding: 4px 8px;
  border: 1px solid var(--surface-outline);
  border-radius: 8px;
  background: var(--bg-1);
  color: var(--text-0);
  font: inherit;
}
.batch-video-concurrency-hint { margin: -4px 0 0; font-size: 11px; color: var(--text-3); line-height: 1.5; }
.batch-video-note { margin: 4px 0 0; font-size: 11px; color: var(--text-3); line-height: 1.6; }

.episode-audit-btn { white-space: nowrap; }
.episode-audit-status {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-raised);
  color: var(--text-2);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.episode-audit-status:hover { border-color: var(--border-strong); color: var(--text-1); }
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
.video-task-inspector .video-preview-pane {
  flex: none;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
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
.video-inspector-params { display: grid; gap: 8px; }
.video-inspector-params div { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }
.video-inspector-params dt { color: var(--text-3); }
.video-inspector-params dd { margin: 0; color: var(--text-1); text-align: right; }

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
  width: min(1040px, calc(100vw - 56px));
  max-height: calc(var(--app-vvh, 100dvh) - 56px);
}
.asset-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--surface-outline);
}
.asset-detail-title-block {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.asset-detail-kicker {
  color: var(--text-3);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.asset-detail-title {
  margin: 0;
  color: var(--text-0);
  font-size: 18px;
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
  padding: 16px;
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
  color: var(--text-3);
  font-size: 10px;
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
  box-shadow: 0 0 0 3px var(--button-focus);
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
  font-size: 13px;
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
  color: var(--text-3);
  font-size: 10px;
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
.asset-ref-hint { margin: 0; color: var(--text-3); font-size: 10.5px; line-height: 1.5; }
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
.asset-detail-meta-item {
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius);
  background: var(--surface-muted);
}
.asset-detail-meta-item span {
  display: block;
  color: var(--text-3);
  font-size: 10px;
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
  color: var(--text-3);
  font-size: 11px;
}
.asset-detail-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--surface-outline);
}
.asset-detail-secondary-actions,
.asset-detail-primary-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
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
  color: var(--text-3);
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
  color: var(--text-3);
  font-size: 10px;
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
/* 平板底部粘性操作栏：仅在 1180 内显示（基础态隐藏，桌面不出现） */
.export-sticky-bar { display: none; }
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
.exp-transition-tag {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--accent-bg);
  color: var(--accent);
  font-size: 10px;
  line-height: 1.6;
  white-space: nowrap;
}

/* ===== 平板页签 / 步骤抽屉 / 底部操作栏 ===== */
.video-tablet-bar { display: none; }
.video-tablet-tabs { display: flex; align-items: center; gap: 4px; min-width: 0; }
.video-tablet-tab {
  min-width: 44px;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  font: 700 12px var(--font-body);
  cursor: pointer;
}
.video-tablet-tab.on { background: var(--sel-bg); color: var(--sel-text); }
.video-tablet-tab:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--button-focus);
}
.video-tablet-steps-btn {
  margin-left: auto;
  min-width: 44px;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--surface-outline);
  border-radius: var(--radius-pill);
  background: var(--bg-hover);
  color: var(--text-1);
  font: 700 12px var(--font-body);
  cursor: pointer;
}
.video-tablet-back { min-width: 44px; min-height: 44px; justify-content: flex-start; }
.video-tablet-actions { display: none; }

/* Shared */
.dim { color: var(--text-3); }

@media (max-width: 1180px) {
  .sidebar { width: 180px; }
  .sidebar.collapsed { width: 46px; }

  /* 平板/窄窗口：顶栏单行放不下模型选择器与全部操作按钮，
     单行会把标题挤成 0 宽并把右侧按钮裁出屏幕；改为分行并允许内部换行 */
  .studio-topbar {
    flex-direction: column;
    align-items: stretch;
  }
  .studio-topbar-side {
    flex-wrap: wrap;
    justify-content: space-between;
  }
  .studio-model-picks {
    flex-wrap: wrap;
    margin-right: 0;
    padding-right: 0;
    border-right: 0;
  }
  .studio-actions {
    flex-wrap: wrap;
  }

  /* 顶栏元信息在窄屏允许换行，避免药丸与提示被裁切 */
  .studio-meta-row { flex-wrap: wrap; }
  .studio-meta-inline,
  .studio-meta-hint { white-space: normal; }

  /* 平板：过渡镜头弹窗全屏 */
  .dialog.transition-create-dialog { width: 100%; max-width: 100%; }

  .prod-grid {
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  }

  .export-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }

  .image-viewer-dialog,
  .asset-detail-dialog {
    max-width: calc(100vw - 32px);
    max-height: calc(var(--app-vvh, 100dvh) - var(--safe-top) - var(--safe-bottom) - 24px);
  }

  .image-viewer-head, .asset-detail-head { position: sticky; top: 0; z-index: 2; background: var(--panel-bg); }
  .image-viewer-body, .asset-detail-body { min-height: 0; overscroll-behavior: contain; }

  /* 平板：审片层高度/关闭按钮、横屏与保存提示 */
  .merge-viewer-video { max-height: calc(var(--app-vvh, 100dvh) - var(--safe-top) - var(--safe-bottom) - 160px); }
  .merge-viewer-dialog .image-viewer-head .btn-icon { width: 44px; height: 44px; }
  .tablet-landscape-hint { margin: 0; padding: 6px 18px 0; font-size: 12px; color: var(--warning); }
  .tablet-save-hint { margin: 0; padding: 2px 18px 12px; font-size: 11px; color: var(--text-3); }

  /* 平板：导出头部操作收进底部粘性栏 */
  .export-head-actions { display: none; }
  .export-sticky-bar {
    position: sticky;
    bottom: 0;
    z-index: 3;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    padding: 10px 12px calc(10px + var(--safe-bottom));
    border-top: 1px solid var(--border);
    background: var(--panel-bg);
  }
  .export-sticky-bar .btn { min-height: 44px; }
  .export-main { padding-bottom: calc(24px + var(--safe-bottom)); }

  /* 平板：合并状态常驻卡（后端无百分比，只做不确定进度；无重试接口） */
  .merge-status-card { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-raised); }
  .merge-status-head { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 12px; color: var(--text-1); }
  .merge-status-title { font-weight: 800; }
  .merge-status-name { font-size: 11px; color: var(--text-3); }
  .merge-status-bar { position: relative; height: 4px; overflow: hidden; border-radius: 999px; background: var(--border); }
  .merge-status-bar span { position: absolute; top: 0; bottom: 0; left: -40%; width: 40%; border-radius: inherit; background: var(--accent); animation: merge-status-slide 1.4s ease-in-out infinite; }
  .merge-status-card.is-failed { border-color: var(--error); }
  .merge-status-card.is-failed .merge-status-head { color: var(--error); }
  .merge-status-error { margin: 0; font-size: 11px; color: var(--error); word-break: break-word; }
  @keyframes merge-status-slide {
    0% { left: -40%; }
    100% { left: 100%; }
  }
}

@media (max-width: 1080px) {
  .studio-body {
    grid-template-columns: 1fr;
  }

  .sidebar,
  .sidebar.collapsed { width: 100%; flex-direction: row; overflow: visible; }

  .pipeline { flex: 1; flex-direction: row; overflow-x: auto; overflow-y: hidden; }

  .pipe-section { flex-direction: row; align-items: center; gap: 2px; flex-shrink: 0; }

  .pipe-section-label { display: none; }

  .pipe-item {
    flex-shrink: 0;
    width: auto;
    min-height: 40px;
  }

  .pipe-item-sub:not(:last-child)::after { display: none; }

  .sidebar.collapsed .pipeline { padding: 12px 10px 8px; gap: 8px; }
  .sidebar.collapsed .pipe-section-label { display: none; }
  .sidebar.collapsed .pipe-item { grid-template-columns: auto 1fr auto; justify-content: flex-start; padding: 7px 10px; min-height: 40px; }
  .sidebar.collapsed .pipe-item .pipe-copy { display: block; }

  .sidebar-toggle { display: none; }
  .sidebar-progress { display: none; }

  .sidebar-bottom {
    flex-direction: row;
    align-items: center;
    border-top: 0;
    background: transparent;
    padding: 4px 6px;
  }

  .refresh-btn { display: inline-flex; width: auto; flex-shrink: 0; }

  .video-task-workbench.has-player {
    grid-template-columns: var(--vleft, 180px) minmax(0, 1fr);
  }

  .video-task-side {
    grid-template-columns: minmax(0, 1fr) var(--vright, 280px);
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

  .image-viewer-overlay {
    padding: 16px;
  }

  .image-viewer-dialog {
    width: calc(100vw - 32px);
    max-height: calc(var(--app-vvh, 100dvh) - 32px);
  }

  .asset-detail-overlay {
    padding: 16px;
  }

  .asset-detail-dialog {
    width: calc(100vw - 32px);
    max-height: calc(var(--app-vvh, 100dvh) - 32px);
  }

  .asset-detail-head { flex-wrap: wrap; }

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

.audit-kind-hint { font-size: 11px; color: var(--text-3); }
.transition-create-dialog { width: min(620px, calc(100vw - 48px)); }
.transition-create-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.transition-create-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
}
.transition-create-fixed {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-raised);
  font-family: var(--mono, monospace);
  font-size: 12px;
  color: var(--text-1);
}
.ai-transition-kind {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 10px;
}
.ai-transition-degraded {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 0 5px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: var(--warning);
  font-size: 9px;
}
.transition-detail-modes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.transition-detail-custom {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}
.transition-detail-custom-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-1);
}
.transition-detail-degraded { color: var(--warning); }
.transition-detail-custom-note { margin: 0; font-size: 11px; }
@media (max-width: 900px) {
  .studio {
    padding: 8px;
    gap: 8px;
  }

  .studio-topbar-main {
    align-items: flex-start;
  }

  .studio-topbar {
    flex-direction: column;
    align-items: stretch;
  }

  .studio-topbar-side {
    justify-content: space-between;
  }

  .sidebar {
    max-height: 340px;
  }

  .studio-topbar-side,
  .studio-actions {
    flex-wrap: wrap;
  }

  .toolbar-right,
  .export-bar {
    flex-wrap: wrap;
  }

  .prod-grid {
    grid-template-columns: 1fr;
  }

  .video-task-workbench,
  .video-task-workbench.has-player {
    grid-template-columns: 1fr;
    overflow-y: auto;
    scroll-padding-bottom: calc(72px + var(--safe-bottom));
  }

  /* 紧凑 ComfyUI：列表定高内部滚动，保证左下角「修改/提交」可达，监控舞台紧接其后 */
  .video-task-workbench.is-comfy {
    grid-template-rows: auto auto;
    align-content: start;
  }

  .video-tablet-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    position: sticky;
    top: 0;
    z-index: 5;
    padding: 6px 8px;
    background: var(--surface-raised);
    border-bottom: 1px solid var(--surface-outline);
  }

  .video-tablet-actions {
    display: flex;
    align-items: stretch;
    gap: 8px;
    position: sticky;
    bottom: calc(100dvh - var(--app-vvh, 100dvh));
    z-index: 4;
    padding: 8px 10px;
    padding-bottom: calc(8px + var(--safe-bottom));
    background: var(--surface-raised);
    border-top: 1px solid var(--surface-outline);
  }

  .video-tablet-actions .btn {
    flex: 1;
    min-height: 44px;
    justify-content: center;
  }

  .video-tablet-back {
    min-width: 44px;
    min-height: 44px;
    align-self: flex-start;
    margin: 8px 10px 0;
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

  

  .video-task-side .video-task-inspector {
    flex: none; /* 窄屏下由外层 workbench 整体滚动，检查器按内容撑开，不参与 flex 收缩 */
    border-top: 0;
    display: flex;
    flex-direction: column;
    overflow: visible;
  }

  .video-task-player {
    flex: none; /* 禁止收缩：否则 stage 的 min-height 会使其溢出播放器并遮挡下方检查器 */
  }

  .video-player-stage {
    flex: none;
    max-height: 220px;
  }

  .video-task-workbench[data-pane="preview"] .video-player-stage {
    aspect-ratio: auto;
    max-height: none;
    height: clamp(240px, calc(var(--app-vvh, 100dvh) - 260px), 70vh);
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

/* 横屏手机：宽度落在平板区间但高度很矮，顶栏换行会吃掉半屏，
   模型选择与操作各压成单行横向滚动 */
@media (max-width: 1180px) and (max-height: 520px) {
  .studio-topbar { padding: 4px 10px; }
  .studio-topbar-main { min-height: 0; }
  .studio-topbar-side { flex-wrap: nowrap; gap: 4px; }
  .studio-model-picks {
    display: flex;
    flex: 1 1 50%; min-width: 0;
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 2px;
  }
  .studio-model-picks :deep(.model-select) { flex-shrink: 0; }
  .studio-model-picks :deep(.model-select-label) { white-space: nowrap; }
  .studio-actions {
    flex: 1 1 50%; min-width: 0;
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 2px;
  }
  .studio-meta-inline,
  .studio-meta-hint { display: none; }
}

/* ===== 窄平板步骤抽屉（复用同一个侧栏节点） ===== */
@media (max-width: 744px) {
  .video-steps-scrim { position: fixed; inset: 0; background: var(--scrim); z-index: 130; }

  .video-steps-drawer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--surface-outline);
    flex-shrink: 0;
  }

  .video-steps-drawer-title { font-size: 13px; font-weight: 800; color: var(--text-0); }
  .video-steps-drawer-close { min-width: 44px; min-height: 44px; }

  .sidebar.is-steps-drawer {
    position: fixed;
    left: var(--safe-left);
    top: var(--safe-top);
    bottom: var(--safe-bottom);
    width: min(340px, calc(100vw - 32px));
    max-height: none;
    z-index: 131;
    flex-direction: column;
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    box-shadow: var(--shadow-xl);
    overflow: hidden;
  }

  .sidebar.is-steps-drawer:not(.open) { display: none; }
  .sidebar.is-steps-drawer .pipeline { flex-direction: column; overflow-y: auto; overflow-x: hidden; }
  .sidebar.is-steps-drawer .pipe-section { flex-direction: column; align-items: stretch; }
  .sidebar.is-steps-drawer .pipe-section-label { display: flex; }
  .sidebar.is-steps-drawer .pipe-item { flex-direction: row; width: 100%; }
  .sidebar.is-steps-drawer .sidebar-bottom {
    flex-direction: column;
    align-items: stretch;
    border-top: 1px solid var(--border);
    background: var(--surface-soft);
  }

  .export-grid { grid-template-columns: 1fr; }

  /* 顶栏全局步骤入口：窄屏任意面板都能打开同一个抽屉；
     选择器需与 .studio-topbar .btn 同特异性，否则 height/padding 被其覆盖 */
  .studio-topbar .topbar-steps-btn { min-height: 44px; height: 44px; padding: 0 12px; flex-shrink: 0; }

  /* 手机分集顶栏：单行紧凑，模型与操作收进「更多」浮层 */
  .studio-topbar {
    position: relative;
    z-index: 55;
    flex-direction: row;
    align-items: center;
    padding: 6px 8px;
    gap: 6px;
  }
  .studio-topbar-main { flex: 1; min-width: 0; gap: 6px; }
  .studio-identity { flex: 1; min-width: 0; }
  .studio-title {
    max-width: 100%;
    font-size: 14px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .studio-episode-chip { flex-shrink: 0; }
  .studio-meta-row { display: none; }
  .studio-topbar .topbar-back {
    width: 44px;
    min-width: 44px;
    height: 44px;
    padding: 0;
    gap: 0;
    font-size: 0;
  }
  .studio-topbar .topbar-back svg { width: 18px; height: 18px; }
  .studio-topbar .topbar-more-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 64px;
    min-height: 44px;
    height: 44px;
    padding: 0 10px;
    font-size: 12px;
  }
  .studio-topbar-side { display: none; }
  .studio-topbar-side.is-mobile-open {
    display: flex;
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    right: 0;
    z-index: 60;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    max-height: calc(var(--app-vvh, 100dvh) - var(--safe-top) - var(--safe-bottom) - 96px);
    overflow-y: auto;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--panel-bg);
    box-shadow: var(--shadow-xl);
  }
  .mobile-more-scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    border: 0;
    background: var(--scrim);
  }
  .mobile-more-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
    font-weight: 800;
    color: var(--text-1);
  }
  .mobile-more-head .btn { min-width: 44px; min-height: 44px; }
  .studio-topbar-side .studio-model-picks { flex-direction: column; align-items: stretch; gap: 8px; }
  .studio-topbar-side .studio-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
  .studio-topbar-side .studio-actions .btn {
    min-height: 44px;
    height: auto;
    justify-content: flex-start;
    white-space: normal;
    text-align: left;
    font-size: 12px;
  }
  .studio-topbar-side .studio-actions .task-drawer-trigger { width: 100%; }
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
.ai-transition-chip-state { display: inline-flex; align-items: center; gap: 4px; color: var(--text-3); }
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
  font-size: 10px;
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
.ai-transition-prompt-note { margin: 0; color: var(--text-2); font-size: 10px; line-height: 1.4; }
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
.transition-detail-dialog { width: min(760px, calc(100vw - 48px)); }
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
.transition-slot-tag {
  position: absolute;
  right: 10px;
  top: 8px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  background: var(--primary-bg);
  color: var(--primary);
}
.transition-detail-frame { position: relative; }
.transition-detail-slots { display: flex; gap: 10px; }
.transition-slot-row { display: flex; gap: 8px; flex: 1; }
.transition-slot-row .btn { flex: 1; }
.transition-ref-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--surface-outline);
  border-radius: 8px;
}
.transition-ref-head { display: flex; align-items: center; gap: 8px; }
.transition-ref-title { font-size: 12px; font-weight: 600; }
.transition-ref-hint { font-size: 11px; }
.transition-ref-warning { color: var(--warning, #b58a2b); }
.transition-ref-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.transition-ref-item {
  position: relative;
  width: 86px;
  aspect-ratio: 16 / 9;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--surface-outline);
}
.transition-ref-item img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: var(--media-surface);
  cursor: pointer;
}
.transition-ref-remove {
  position: absolute;
  right: 3px;
  top: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
}
.transition-ref-remove:hover:not(:disabled) { background: var(--error); }
.transition-ref-empty { margin: 0; font-size: 11px; }
.ai-transition-refs-badge {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10px;
  background: var(--bg-hover);
  border: 1px solid var(--surface-outline);
  color: var(--text-2);
  white-space: nowrap;
}
.ai-transition-pickers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
</style>
