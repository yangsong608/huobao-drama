<template>
  <div class="settings-page" :class="{ 'is-dialog-open': settingsDialogOpen }">
    <div class="settings-layout">
      <aside class="settings-nav" ref="navRef">
        <div
          class="nav-group"
          role="tablist"
          :aria-orientation="isCompact ? 'horizontal' : 'vertical'"
          :aria-label="t('settings.groupBase')"
        >
          <div class="nav-group-label" aria-hidden="true">{{ t('settings.groupBase') }}</div>
          <button
            v-for="nt in baseTabs"
            :id="`settings-tab-${nt.id}`"
            :key="nt.id"
            type="button"
            role="tab"
            :aria-selected="tab === nt.id"
            :aria-controls="`settings-panel-${nt.id}`"
            :tabindex="tab === nt.id ? 0 : -1"
            :class="['nav-item', { active: tab === nt.id }]"
            @click="tab = nt.id"
            @keydown="onSettingsTabKeydown($event, nt.id)"
          >
            <component :is="nt.icon" :size="14" />
            {{ nt.label }}
          </button>
        </div>
      </aside>

      <div class="settings-content" :inert="remoteReadonly || null">
        <div v-if="remoteReadonly" class="settings-readonly-banner" role="status">
          <ShieldCheck :size="14" />
          <span>{{ t('remote.readonly.notice') }}</span>
        </div>

        <!-- ===== 本机与连接（应用模式 / 访客） ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-device" aria-labelledby="settings-tab-device" tabindex="0" :hidden="tab !== 'device'">
        <div v-if="tab === 'device'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.device.title') }}</h2>
            <p class="settings-desc">{{ t('settings.device.desc') }}</p>
          </div>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.device.connection.title') }}</span>
                <div class="svc-group-sub">{{ deviceConnected ? t('settings.device.connection.guestDesc', { name: deviceHostName }) : t('settings.device.connection.localDesc') }}</div>
              </div>
              <span class="tag device-state" :class="{ 'tag-accent': !deviceConnected }">{{ deviceConnected ? t('settings.device.connection.guestBadge') : t('settings.device.connection.localBadge') }}</span>
            </div>
            <div class="config-row">
              <div class="provider-badge" style="background:var(--accent-bg);color:var(--accent)"><Smartphone :size="15" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ deviceConnected ? deviceHostName : t('settings.device.connection.localName') }}</span></div>
                <div class="config-sub">{{ deviceConnected ? t('settings.device.connection.expires', { time: deviceExpiryLabel }) : t('settings.device.connection.localNote') }}</div>
              </div>
              <div class="device-actions">
                <button v-if="!deviceConnected" class="btn btn-primary btn-sm" :disabled="!appBridge" @click="connectToComputer">
                  <QrCode :size="13" />
                  {{ t('settings.device.connection.connect') }}
                </button>
                <template v-else>
                  <button class="btn btn-sm" :disabled="!appBridge" @click="returnToLocalDevice">
                    {{ t('settings.device.connection.backToLocal') }}
                  </button>
                  <button class="btn btn-sm" @click="deviceDisconnectConfirm = true">
                    {{ t('settings.device.connection.disconnect') }}
                  </button>
                </template>
              </div>
            </div>
            <p class="config-empty">{{ t('settings.device.connection.hint') }}</p>
          </section>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.device.sync.title') }}</span>
                <div class="svc-group-sub">{{ t('settings.device.sync.desc') }}</div>
              </div>
              <button class="btn btn-sm ml-auto" disabled>{{ t('settings.device.sync.action') }}</button>
            </div>
            <p class="config-empty">{{ t('settings.device.sync.notReady') }}</p>
          </section>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.device.storage.title') }}</span>
                <div class="svc-group-sub">{{ t('settings.device.storage.desc') }}</div>
              </div>
              <button class="btn btn-sm ml-auto" @click="tab = 'storage'">
                <HardDrive :size="13" />
                {{ t('settings.device.storage.open') }}
              </button>
            </div>
          </section>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.device.logs.title') }}</span>
                <div class="svc-group-sub">{{ t('settings.device.logs.desc') }}</div>
              </div>
              <button class="btn btn-sm ml-auto" :disabled="deviceLogsBusy || !appBridge" @click="exportDeviceLogs">
                <Loader2 v-if="deviceLogsBusy" :size="13" class="animate-spin" />
                <FileText v-else :size="13" />
                {{ deviceLogsBusy ? t('settings.device.logs.exporting') : t('settings.device.logs.export') }}
              </button>
            </div>
          </section>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.device.version.title') }}</span>
                <div class="svc-group-sub">{{ t('settings.device.version.runtimeNote') }}</div>
              </div>
            </div>
            <div class="config-row">
              <div class="provider-badge" style="background:var(--accent-bg);color:var(--accent)"><RefreshCw :size="15" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ t('settings.device.version.app') }}</span></div>
                <div class="config-sub mono">{{ deviceVersion || t('settings.device.version.unknown') }}</div>
              </div>
            </div>
          </section>

          <ConfirmDialog
            :open="deviceDisconnectConfirm"
            :title="t('settings.device.connection.disconnectTitle')"
            :message="t('settings.device.connection.disconnectMessage')"
            :confirm-text="t('settings.device.connection.disconnectConfirm')"
            :loading-text="t('settings.device.connection.disconnecting')"
            :loading="deviceDisconnecting"
            @confirm="confirmDisconnectDevice"
            @cancel="deviceDisconnectConfirm = false"
          />
        </div>
        </div>

        <!-- ===== 通用（内容语言） ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" tabindex="0" :hidden="tab !== 'general'">
        <div v-if="tab === 'general'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.general.title') }}</h2>
            <p class="settings-desc">{{ t('settings.general.desc') }}</p>
          </div>
          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.general.contentLanguage') }}</span>
                <div class="svc-group-sub">{{ t('settings.general.contentLanguageSub') }}</div>
              </div>
            </div>
            <div class="config-row">
              <div class="provider-badge" style="background:var(--accent-bg);color:var(--accent)"><Languages :size="15" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ t('settings.general.languageLabel') }}</span></div>
                <div class="config-sub">{{ t('settings.general.languageNote') }}</div>
              </div>
              <div class="lang-picker">
                <button
                  v-for="l in contentLangOptions"
                  :key="l.value"
                  type="button"
                  :class="['lang-option', { on: contentLanguage === l.value }]"
                  @click="setContentLanguage(l.value)"
                >{{ l.label }}</button>
              </div>
            </div>
            <p class="config-empty">{{ t('settings.general.languageHint') }}</p>
          </section>

          <!-- 外观主题 -->
          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.general.appearance') }}</span>
                <div class="svc-group-sub">{{ t('settings.general.appearanceSub') }}</div>
              </div>
            </div>
            <div class="config-row">
              <div class="provider-badge" style="background:var(--accent-bg);color:var(--accent)"><SunMoon :size="15" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ t('settings.general.appearanceLabel') }}</span></div>
                <div class="config-sub">{{ t('settings.general.appearanceNote') }}</div>
              </div>
              <div class="lang-picker">
                <button
                  v-for="o in themeOptions"
                  :key="o.value"
                  type="button"
                  :class="['lang-option', { on: themeMode === o.value }]"
                  @click="setThemeMode(o.value)"
                >{{ o.label }}</button>
              </div>
            </div>
          </section>

          <!-- 媒体工具（FFmpeg）：仅主机可见 -->
          <section v-if="!isGuest" class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.general.mediaTitle') }}</span>
                <div class="svc-group-sub">{{ t('settings.general.mediaSub') }}</div>
              </div>
              <button v-if="desktopBridge" class="btn btn-sm ml-auto" :disabled="mediaSaving" @click="pickFfmpegDir">
                <HardDrive :size="13" /> {{ t('settings.general.mediaChoose') }}
              </button>
            </div>
            <div class="config-row">
              <div class="provider-badge" style="background:var(--accent-bg);color:var(--accent)"><HardDrive :size="15" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ t('settings.general.ffmpegDir') }}</span></div>
                <div class="config-sub">{{ t('settings.general.ffmpegDirNote') }}</div>
              </div>
              <div class="media-dir-actions">
                <input
                  v-model="mediaFfmpegDir"
                  class="input mono media-dir-input"
                  type="text"
                  spellcheck="false"
                  :placeholder="t('settings.general.ffmpegDirPlaceholder')"
                />
                <button class="btn btn-primary btn-sm" :disabled="mediaSaving" @click="saveMediaSettings">
                  <Loader2 v-if="mediaSaving" :size="13" class="animate-spin" />
                  {{ t('settings.general.mediaSave') }}
                </button>
                <button class="btn btn-sm" :disabled="mediaSaving" @click="restoreMediaAuto">{{ t('settings.general.mediaAuto') }}</button>
              </div>
            </div>
            <MediaCapabilityNotice action="output" />
            <template v-if="mediaStatus">
              <div class="config-row">
                <div class="provider-badge style-badge"><HardDrive :size="15" /></div>
                <div class="config-main">
                  <div class="config-line">
                    <span class="config-name mono">ffmpeg</span>
                    <span class="tag" :class="{ 'tag-accent': mediaStatus.ffmpeg.available }">{{ mediaStatus.ffmpeg.available ? t('settings.general.mediaAvailable') : t('settings.general.mediaUnavailableTag') }}</span>
                    <span class="tag">{{ t(MEDIA_SOURCE_LABELS[mediaStatus.ffmpeg.source] || 'settings.general.mediaSourceNone') }}</span>
                  </div>
                  <div class="config-sub mono truncate">{{ mediaStatus.ffmpeg.path || '—' }}</div>
                  <div v-if="mediaStatus.ffmpeg.version" class="config-sub mono truncate">{{ mediaStatus.ffmpeg.version }}</div>
                </div>
              </div>
              <div class="config-row">
                <div class="provider-badge style-badge"><HardDrive :size="15" /></div>
                <div class="config-main">
                  <div class="config-line">
                    <span class="config-name mono">ffprobe</span>
                    <span class="tag" :class="{ 'tag-accent': mediaStatus.ffprobe.available }">{{ mediaStatus.ffprobe.available ? t('settings.general.mediaAvailable') : t('settings.general.mediaUnavailableTag') }}</span>
                    <span class="tag">{{ t(MEDIA_SOURCE_LABELS[mediaStatus.ffprobe.source] || 'settings.general.mediaSourceNone') }}</span>
                  </div>
                  <div class="config-sub mono truncate">{{ mediaStatus.ffprobe.path || '—' }}</div>
                  <div v-if="mediaStatus.ffprobe.version" class="config-sub mono truncate">{{ mediaStatus.ffprobe.version }}</div>
                </div>
              </div>
            </template>
            <p class="config-empty">{{ t('settings.general.ffmpegDirHint') }}</p>
          </section>
        </div>
        </div>

        <!-- ===== 跨端接力（仅主机） ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-remote" aria-labelledby="settings-tab-remote" tabindex="0" :hidden="tab !== 'remote'">
        <div v-if="tab === 'remote'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.remote.title') }}</h2>
            <p class="settings-desc">{{ t('settings.remote.desc') }}</p>
          </div>

          <section class="card svc-group remote-card">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('remote.dialog.title') }}</span>
                <div class="svc-group-sub">{{ remoteStatusLabel }}</div>
              </div>
              <div class="remote-tab-actions">
                <span class="tag" :class="remoteRunning ? 'tag-success' : ''">
                  {{ remoteRunning ? t('remote.dialog.status.running') : t('remote.dialog.status.disabled') }}
                </span>
                <button
                  v-if="remoteRunning"
                  type="button"
                  class="btn btn-sm"
                  :disabled="remoteState.disabling"
                  @click="remoteDisableConfirm = true"
                >{{ t('remote.dialog.disable') }}</button>
                <button
                  v-else
                  type="button"
                  class="btn btn-primary btn-sm"
                  :disabled="remoteState.enabling"
                  @click="enableRemoteTab"
                >{{ t('remote.dialog.enable') }}</button>
                <button type="button" class="btn btn-sm" :disabled="!remoteRunning" @click="openRemoteDialog">
                  {{ t('settings.remote.openDialog') }}
                </button>
              </div>
            </div>
            <p class="config-empty">{{ t('settings.remote.hint') }}</p>
            <p v-if="remoteState.actionError" class="remote-tab-error" role="alert">
              <TriangleAlert :size="14" />
              <span>{{ remoteErrorMessage(remoteState.actionError) }}</span>
            </p>
          </section>

          <section class="card svc-group remote-card">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('remote.dialog.settings') }}</span>
                <div class="svc-group-sub">{{ t('settings.remote.settingsHint') }}</div>
              </div>
              <button class="btn btn-primary btn-sm ml-auto" :disabled="remoteState.saving" @click="saveRemoteTabSettings">
                <Loader2 v-if="remoteState.saving" :size="13" class="animate-spin" />
                {{ t('remote.dialog.save') }}
              </button>
            </div>
            <div class="remote-settings-grid">
              <label class="field">
                <span class="field-label">{{ t('remote.dialog.deviceName') }}</span>
                <input v-model="remoteForm.deviceName" class="input" maxlength="40" :placeholder="t('remote.dialog.deviceNamePlaceholder')" />
              </label>
              <label class="field">
                <span class="field-label">{{ t('remote.dialog.port') }}</span>
                <input v-model.number="remoteForm.port" class="input" type="number" inputmode="numeric" min="1024" max="65535" :disabled="remoteRunning" />
                <span v-if="remoteRunning" class="field-hint">{{ t('remote.dialog.portLocked') }}</span>
              </label>
              <label class="field">
                <span class="field-label">{{ t('remote.dialog.sessionDays') }}</span>
                <select v-model.number="remoteForm.sessionDays" class="input">
                  <option v-for="days in remoteSessionDayOptions" :key="days" :value="days">
                    {{ t('remote.dialog.days', { n: days }) }}
                  </option>
                </select>
              </label>
              <label class="field">
                <span class="field-label">{{ t('remote.dialog.bindAddress') }}</span>
                <select v-model="remoteForm.bindAddress" class="input" :disabled="remoteRunning || !remoteAddressOptions.length">
                  <option v-if="!remoteAddressOptions.length" value="">{{ t('remote.dialog.noAddress') }}</option>
                  <option v-for="address in remoteAddressOptions" :key="address" :value="address">{{ address }}</option>
                </select>
                <span class="field-hint">{{ remoteRunning ? t('remote.dialog.bindLocked') : t('remote.dialog.bindHint') }}</span>
              </label>
            </div>
          </section>

          <section class="card svc-group remote-card">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.remote.devicesTitle') }}</span>
              </div>
              <div class="remote-tab-actions">
                <span class="tag">{{ t('remote.dialog.deviceCount', { n: remoteDevices.length }) }}</span>
                <button
                  type="button"
                  class="btn btn-sm"
                  :disabled="!remoteRevokeAllCount"
                  @click="remoteRevokeAllConfirm = true"
                >{{ t('remote.dialog.revokeAll') }}</button>
              </div>
            </div>
            <RemoteDeviceList
              :devices="remoteDevices"
              :presence="presenceState.entries"
              @revoke="askRemoteRevoke"
              @relay="relayRemoteDevice"
            />
          </section>
        </div>
        </div>

        <!-- ===== AI 服务配置 ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-ai" aria-labelledby="settings-tab-ai" tabindex="0" :hidden="tab !== 'ai'">
        <div v-if="tab === 'ai'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.ai.title') }}</h2>
            <p class="settings-desc">{{ t('settings.ai.desc') }}</p>
          </div>
          <section class="card quick-card">
            <div class="quick-card-head">
              <div class="setup-title">{{ t('settings.ai.quickTitle') }}</div>
              <span class="tag tag-accent">{{ t('settings.ai.recommended') }}</span>
            </div>
            <p class="setup-desc">
              {{ t('settings.ai.quickDesc') }}
              <a class="huobao-site-link" :href="huobaoSiteUrl" target="_blank" rel="noopener noreferrer">
                {{ t('settings.ai.getKey') }}
                <ExternalLink :size="12" :stroke-width="1.8" />
              </a>
            </p>
            <div class="huobao-quick-row">
              <input v-model="huobaoApiKey" class="input" type="password" placeholder="Huobao API Key" />
              <div class="lang-picker">
                <button
                  type="button"
                  :class="['lang-option', { on: huobaoRegion === 'cn' }]"
                  @click="huobaoRegion = 'cn'"
                >{{ t('settings.ai.regionCn') }}</button>
                <button
                  type="button"
                  :class="['lang-option', { on: huobaoRegion === 'com' }]"
                  @click="huobaoRegion = 'com'"
                >{{ t('settings.ai.regionCom') }}</button>
              </div>
              <button class="btn btn-primary" :disabled="huobaoSaving" @click="applyHuobaoQuickConfig">
                <Loader2 v-if="huobaoSaving" :size="13" class="animate-spin" />
                <Sparkles v-else :size="13" />
                {{ t('settings.ai.applyQuick') }}
              </button>
            </div>
            <div class="huobao-quick-models">
              <div v-for="q in huobaoQuickConfigs" :key="q.name" class="hqm-row">
                <span class="hqm-label">{{ serviceMeta[q.service_type].label }}</span>
                <span class="hqm-provider">
                  <img v-if="providerIconUrl(q.provider)" :src="providerIconUrl(q.provider)" class="hqm-provider-icon" alt="" />
                  {{ q.provider }}
                </span>
                <span class="hqm-models mono">
                  <span v-for="(m, i) in q.model" :key="m" :class="['hqm-model', { 'is-default': i === 0 }]">
                    {{ m }}<em v-if="i === 0">{{ t('common.default') }}</em>
                  </span>
                </span>
              </div>
            </div>
          </section>
          <section class="card setup-panel">
            <div class="setup-panel-head compact">
              <div>
                <div class="setup-title">{{ t('settings.ai.manualTitle') }}</div>
                <div class="setup-desc">{{ t('settings.ai.manualDesc') }}</div>
              </div>
            </div>
            <div class="template-row">
              <button
                v-for="st in serviceTypes"
                :key="st.type"
                class="template-type-chip"
                @click="startAddCfg(st.type)"
              >
                {{ st.label }}
              </button>
            </div>
          </section>
          <div class="settings-table-scroll">
          <div class="sections">
            <section v-for="st in serviceTypes" :key="st.type" class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ st.label }}</span>
                  <div class="svc-group-sub">{{ serviceMeta[st.type].desc }}</div>
                </div>
                <span v-if="countActive(st.type)" class="tag tag-accent">{{ t('settings.ai.activeCount', { n: countActive(st.type) }) }}</span>
                <button class="btn btn-ghost btn-sm ml-auto" @click="startAddCfg(st.type)"><Plus :size="13" /> {{ t('common.add') }}</button>
              </div>
              <div v-for="c in byType(st.type)" :key="c.id" class="config-row">
                <div class="provider-badge" :class="{ 'has-icon': !!providerIconUrl(c.provider) }" :data-provider="c.provider">
                  <img v-if="providerIconUrl(c.provider)" class="provider-badge-icon" :src="providerIconUrl(c.provider)" alt="" />
                  <template v-else>{{ c.provider.slice(0, 1).toUpperCase() }}</template>
                </div>
                <div class="config-main">
                  <div class="config-line">
                    <span class="config-name">{{ c.name || `${c.provider}-${c.service_type}` }}</span>
                    <span :class="['tag', c.api_key ? 'tag-success' : 'tag-error']">{{ c.api_key ? t('settings.ai.hasKey') : t('settings.ai.noKey') }}</span>
                    <span v-if="!c.is_active" class="tag">{{ t('settings.common.disabled') }}</span>
                  </div>
                  <div class="config-models">
                    <button
                      v-for="m in c.model" :key="m" type="button"
                      :class="['cfg-model-chip mono', { 'is-default': isDefaultModel(st.type, c, m) }]"
                      :title="isDefaultModel(st.type, c, m) ? t('settings.ai.currentDefault') : t('settings.ai.setDefault')"
                      @click="setDefaultModel(st.type, c, m)"
                    >
                      <Star v-if="isDefaultModel(st.type, c, m)" :size="9" class="cfg-model-star" />
                      {{ m }}
                    </button>
                  </div>
                  <div class="config-sub mono truncate">{{ c.base_url || t('settings.ai.noBaseUrl') }}</div>
                </div>
                <button class="btn btn-ghost btn-sm" @click="testExistingCfg(c)">{{ t('settings.ai.test') }}</button>
                <label class="config-switch">
                  <input type="checkbox" class="sr-only" :checked="c.is_active" @change="toggleCfg(c)">
                  <span class="switch" :class="{ on: c.is_active }"></span>
                </label>
                <button class="btn btn-ghost btn-icon btn-sm" @click="startEditCfg(c)"><Pencil :size="13" /></button>
                <button class="btn btn-danger btn-icon btn-sm" @click="delCfg(c.id)"><Trash2 :size="13" /></button>
              </div>
              <p v-if="!byType(st.type).length" class="config-empty">{{ t('settings.common.empty') }}</p>
            </section>
          </div>
          </div>
        </div>
        </div>

        <!-- ===== 配音默认 ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-dubbing" aria-labelledby="settings-tab-dubbing" tabindex="0" :hidden="tab !== 'dubbing'">
        <div v-if="tab === 'dubbing'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.dubbing.title') }}</h2>
            <p class="settings-desc">{{ t('settings.dubbing.desc') }}</p>
          </div>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.dubbing.serviceTitle') }}</span>
                <div class="svc-group-sub">{{ t('settings.dubbing.serviceSub') }}</div>
              </div>
              <button class="btn btn-primary btn-sm ml-auto" @click="tab = 'ai'">{{ t('settings.dubbing.manage') }}</button>
            </div>
            <div v-if="activeAudioCfgs.length" class="config-row">
              <div class="provider-badge" style="background:var(--accent-bg);color:var(--accent)"><Mic :size="15" /></div>
              <div class="config-main">
                <div class="config-line">
                  <span class="config-name">{{ defaultAudioCfg?.name || t('common.serviceType.audio') }}</span>
                  <span class="tag tag-success">{{ t('settings.dubbing.serviceActive', { n: activeAudioCfgs.length }) }}</span>
                </div>
                <div class="config-sub mono truncate">{{ defaultAudioCfg?.base_url || '—' }}</div>
                <div class="config-sub mono truncate">{{ defaultAudioModel || '—' }}</div>
              </div>
              <label class="config-switch" :title="t('settings.dubbing.enable')">
                <input type="checkbox" class="sr-only" :checked="dubbingEnabled" @change="toggleDubbing">
                <span class="switch" :class="{ on: dubbingEnabled }"></span>
              </label>
            </div>
            <div v-else class="config-row">
              <div class="provider-badge" style="background:var(--accent-bg);color:var(--accent)"><Mic :size="15" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ t('settings.dubbing.serviceNone') }}</span></div>
                <div class="config-sub">{{ t('settings.dubbing.serviceNoneHint') }}</div>
              </div>
              <button class="btn btn-sm" @click="tab = 'ai'">{{ t('settings.dubbing.configure') }}</button>
            </div>
            <p class="config-empty">{{ t('settings.dubbing.enableHint') }}</p>
          </section>

          <template v-if="dubbingDefaults">
            <section class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.dubbing.voiceTitle') }}</span>
                  <div class="svc-group-sub">{{ t('settings.dubbing.voiceSub') }}</div>
                </div>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.autoPrompt') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.autoPromptDesc') }}</div>
                </div>
                <label class="config-switch">
                  <input type="checkbox" class="sr-only" :checked="dubbingDefaults.autoPromptVoices" @change="saveDubbing({ autoPromptVoices: $event.target.checked })">
                  <span class="switch" :class="{ on: dubbingDefaults.autoPromptVoices }"></span>
                </label>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.autoPreview') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.autoPreviewDesc') }}</div>
                </div>
                <label class="config-switch">
                  <input type="checkbox" class="sr-only" :checked="dubbingDefaults.autoPreviewVoices" @change="saveDubbing({ autoPreviewVoices: $event.target.checked })">
                  <span class="switch" :class="{ on: dubbingDefaults.autoPreviewVoices }"></span>
                </label>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.autoDubNew') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.autoDubNewDesc') }}</div>
                </div>
                <label class="config-switch">
                  <input type="checkbox" class="sr-only" :checked="dubbingDefaults.autoDubForNewEpisodes" @change="saveDubbing({ autoDubForNewEpisodes: $event.target.checked })">
                  <span class="switch" :class="{ on: dubbingDefaults.autoDubForNewEpisodes }"></span>
                </label>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.videoAudio') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.videoAudioDesc') }}</div>
                </div>
                <div class="dub-select">
                  <BaseSelect
                    :model-value="dubbingDefaults.videoAudioModeForNewEpisodes"
                    :options="videoAudioModeOptions"
                    :searchable="false"
                    @update:model-value="saveDubbing({ videoAudioModeForNewEpisodes: $event })"
                  />
                </div>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.language') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.languageHint') }}</div>
                </div>
                <div class="lang-picker">
                  <button
                    v-for="l in voiceLanguageOptions"
                    :key="l.value"
                    type="button"
                    :class="['lang-option', { on: dubbingDefaults.voiceLanguage === l.value }]"
                    @click="saveDubbing({ voiceLanguage: l.value })"
                  >{{ l.label }}</button>
                </div>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.speed') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.speedHint') }}</div>
                </div>
                <input
                  class="dub-range"
                  type="range"
                  min="0.5"
                  max="1.5"
                  step="0.05"
                  :value="dubbingDefaults.voiceSpeed"
                  :disabled="dubbingSaving"
                  @change="saveDubbing({ voiceSpeed: Number($event.target.value) })"
                >
                <span class="dub-value mono">{{ Number(dubbingDefaults.voiceSpeed).toFixed(2) }}×</span>
              </div>
            </section>

            <section class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.dubbing.mixTitle') }}</span>
                  <div class="svc-group-sub">{{ t('settings.dubbing.mixSub') }}</div>
                </div>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.originalAudio') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.originalAudioHint') }}</div>
                </div>
                <div class="lang-picker">
                  <button
                    v-for="o in originalAudioOptions"
                    :key="o.value"
                    type="button"
                    :class="['lang-option', { on: dubbingDefaults.originalAudio === o.value }]"
                    @click="saveDubbing({ originalAudio: o.value })"
                  >{{ o.label }}</button>
                </div>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.ducking') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.duckingHint') }}</div>
                </div>
                <input
                  class="dub-range"
                  type="range"
                  min="1"
                  max="20"
                  step="1"
                  :value="dubbingDefaults.duckingRatio"
                  :disabled="dubbingSaving"
                  @change="saveDubbing({ duckingRatio: Number($event.target.value) })"
                >
                <span class="dub-value mono">{{ dubbingDefaults.duckingRatio }}</span>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.targetLufs') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.targetLufsHint') }}</div>
                </div>
                <input
                  class="input dub-number"
                  type="number"
                  min="-30"
                  max="-8"
                  step="1"
                  :value="dubbingDefaults.targetLufs"
                  :disabled="dubbingSaving"
                  @change="saveNumber('targetLufs', $event, -30, -8)"
                >
                <span class="dub-unit">LUFS</span>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.bgmVolume') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.bgmVolumeHint') }}</div>
                </div>
                <input
                  class="dub-range"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  :value="Math.round(dubbingDefaults.bgmVolume * 100)"
                  :disabled="dubbingSaving"
                  @change="saveDubbing({ bgmVolume: Number($event.target.value) / 100 })"
                >
                <span class="dub-value mono">{{ Math.round(dubbingDefaults.bgmVolume * 100) }}%</span>
              </div>
            </section>

            <section class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.dubbing.subtitleTitle') }}</span>
                  <div class="svc-group-sub">{{ t('settings.dubbing.subtitleSub') }}</div>
                </div>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.subtitleMode') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.subtitleModeHint') }}</div>
                </div>
                <div class="lang-picker">
                  <button
                    v-for="o in subtitleModeOptions"
                    :key="o.value"
                    type="button"
                    :class="['lang-option', { on: dubbingDefaults.subtitleMode === o.value }]"
                    @click="saveDubbing({ subtitleMode: o.value })"
                  >{{ o.label }}</button>
                </div>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.fontSize') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.fontSizeHint') }}</div>
                </div>
                <input
                  class="input dub-number"
                  type="number"
                  min="16"
                  max="120"
                  step="1"
                  :value="dubbingDefaults.subtitleFontSize ?? ''"
                  :placeholder="t('settings.dubbing.auto')"
                  :disabled="dubbingSaving"
                  @change="saveNumber('subtitleFontSize', $event, 16, 120, true)"
                >
                <span class="dub-unit">px</span>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.margin') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.marginHint') }}</div>
                </div>
                <input
                  class="input dub-number"
                  type="number"
                  min="0"
                  max="600"
                  step="1"
                  :value="dubbingDefaults.subtitleMargin ?? ''"
                  :placeholder="t('settings.dubbing.auto')"
                  :disabled="dubbingSaving"
                  @change="saveNumber('subtitleMargin', $event, 0, 600, true)"
                >
                <span class="dub-unit">px</span>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.dubbing.narratorPrefix') }}</span></div>
                  <div class="config-sub">{{ t('settings.dubbing.narratorPrefixDesc') }}</div>
                </div>
                <label class="config-switch">
                  <input type="checkbox" class="sr-only" :checked="dubbingDefaults.narratorPrefix" @change="saveDubbing({ narratorPrefix: $event.target.checked })">
                  <span class="switch" :class="{ on: dubbingDefaults.narratorPrefix }"></span>
                </label>
              </div>
            </section>
          </template>
          <p v-else class="config-empty">{{ t('common.loading') }}</p>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.dubbing.queueTitle') }}</span>
                <div class="svc-group-sub">{{ t('settings.dubbing.queueSub') }}</div>
              </div>
              <button class="btn btn-sm ml-auto" @click="tab = 'queue'">{{ t('settings.dubbing.queueOpen') }}</button>
            </div>
          </section>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.dubbing.bgmTitle') }}</span>
                <div class="svc-group-sub">{{ t('settings.dubbing.bgmSub', { n: bgmItems.length }) }}</div>
              </div>
              <button class="btn btn-sm ml-auto" :disabled="bgmLoading" @click="loadDubbingBgm">
                <RefreshCw :size="12" :class="{ 'animate-spin': bgmLoading }" /> {{ t('common.refresh') }}
              </button>
            </div>
            <div class="config-row">
              <div class="provider-badge style-badge"><Music :size="15" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ t('settings.dubbing.bgmDir') }}</span></div>
                <div class="config-sub mono truncate">{{ bgmDir || '—' }}</div>
                <div class="config-sub">{{ t('settings.dubbing.bgmHint') }}</div>
              </div>
            </div>
            <div v-for="item in bgmItems" :key="item.name" class="config-row">
              <div class="provider-badge style-badge"><Music :size="14" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ item.name }}</span></div>
                <div class="config-sub mono">{{ formatBytes(item.size) }}</div>
              </div>
              <button class="btn btn-danger btn-icon btn-sm" :title="t('common.delete')" @click="bgmToDelete = item"><Trash2 :size="13" /></button>
            </div>
            <p v-if="!bgmItems.length" class="config-empty">{{ t('settings.dubbing.bgmEmpty') }}</p>
          </section>
        </div>
        </div>

        <!-- ===== 小说生成 ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-novel" aria-labelledby="settings-tab-novel" tabindex="0" :hidden="tab !== 'novel'">
        <div v-if="tab === 'novel'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.novel.title') }}</h2>
            <p class="settings-desc">{{ t('settings.novel.desc') }}</p>
          </div>

          <template v-if="novelSettings">
            <section class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.novel.textConfigTitle') }}</span>
                </div>
              </div>
              <div class="config-row">
                <div class="provider-badge" style="background:var(--accent-bg);color:var(--accent)"><BookOpen :size="15" /></div>
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.novel.textConfig') }}</span></div>
                  <div class="config-sub">{{ t('settings.novel.textConfigHint') }}</div>
                </div>
                <div class="novel-select">
                  <BaseSelect
                    :model-value="novelSettings.textConfigId || 0"
                    :options="novelTextCfgOptions"
                    :placeholder="t('settings.novel.followDefault')"
                    @update:model-value="saveNovel({ textConfigId: Number($event) || 0 })"
                  />
                </div>
              </div>
            </section>

            <section class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.novel.stageTitle') }}</span>
                  <div class="svc-group-sub">{{ t('settings.novel.stageHint') }}</div>
                </div>
              </div>
              <div v-for="stage in NOVEL_STAGE_KEYS" :key="stage" class="config-row novel-stage-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t(`settings.novel.stage.${stage}`) }}</span></div>
                </div>
                <div class="novel-select">
                  <BaseSelect
                    :model-value="novelSettings.stageModels?.[stage] || 0"
                    :options="novelStageCfgOptions"
                    :placeholder="t('settings.novel.followDefault')"
                    @update:model-value="saveNovelStage(stage, $event)"
                  />
                </div>
              </div>
            </section>

            <section class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.novel.generationTitle') }}</span>
                </div>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.novel.temperature') }}</span></div>
                  <div class="config-sub">{{ t('settings.novel.temperatureHint') }}</div>
                </div>
                <input
                  class="dub-range"
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  :value="novelSettings.temperature"
                  :disabled="novelSaving"
                  @change="saveNovel({ temperature: Number($event.target.value) })"
                >
                <span class="dub-value mono">{{ Number(novelSettings.temperature).toFixed(2) }}</span>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.novel.autosave') }}</span></div>
                  <div class="config-sub">{{ t('settings.novel.autosaveHint') }}</div>
                </div>
                <input
                  class="dub-range"
                  type="range"
                  min="300"
                  max="10000"
                  step="100"
                  :value="novelSettings.autosaveMs"
                  :disabled="novelSaving"
                  @change="saveNovel({ autosaveMs: Number($event.target.value) })"
                >
                <span class="dub-value mono">{{ novelSettings.autosaveMs }}ms</span>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.novel.aspectRatio') }}</span></div>
                  <div class="config-sub">{{ t('settings.novel.aspectRatioHint') }}</div>
                </div>
                <div class="lang-picker">
                  <button
                    v-for="ratio in ['16:9', '9:16']"
                    :key="ratio"
                    type="button"
                    :class="['lang-option', { on: novelSettings.defaultAspectRatio === ratio }]"
                    @click="saveNovel({ defaultAspectRatio: ratio })"
                  >{{ ratio }}</button>
                </div>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.novel.importWords') }}</span></div>
                  <div class="config-sub">{{ t('settings.novel.importWordsHint') }}</div>
                </div>
                <input
                  class="input novel-number"
                  type="number"
                  min="600"
                  max="5000"
                  step="100"
                  :value="novelSettings.importTargetWords"
                  :placeholder="String(NOVEL_IMPORT_WORDS_DEFAULT)"
                  :disabled="novelSaving"
                  @change="saveNovelImportWords($event)"
                >
                <span class="dub-unit">{{ t('novels.detail.wordUnit') }}</span>
              </div>
            </section>

            <section class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.novel.writingStyleTitle') }}</span>
                  <div class="svc-group-sub">{{ t('settings.novel.writingStyleHint') }}</div>
                </div>
                <button class="btn btn-ghost btn-sm ml-auto" @click="addWritingStyle">
                  <Plus :size="13" /> {{ t('settings.novel.writingStyleAdd') }}
                </button>
              </div>

              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.novel.writingStyleDefault') }}</span></div>
                  <div class="config-sub">{{ t('settings.novel.writingStyleDefaultHint') }}</div>
                </div>
                <div class="novel-select">
                  <BaseSelect
                    :model-value="novelSettings.defaultWritingStyleKey || ''"
                    :options="writingStyleSelectOptions"
                    :searchable="false"
                    @update:model-value="saveNovel({ defaultWritingStyleKey: $event })"
                  />
                </div>
              </div>

              <div v-for="(style, index) in novelSettings.writingStyles" :key="style.key" class="writing-style-row">
                <div class="writing-style-head">
                  <input
                    class="input writing-style-name"
                    :value="style.name"
                    maxlength="80"
                    :aria-label="t('settings.novel.writingStyleName')"
                    @change="updateWritingStyle(index, { name: $event.target.value })"
                  >
                  <span class="tag mono">{{ style.key }}</span>
                  <button class="btn btn-danger btn-icon btn-sm" :aria-label="t('common.delete')" @click="removeWritingStyle(index)">
                    <Trash2 :size="13" />
                  </button>
                </div>
                <textarea
                  class="textarea writing-style-prompt"
                  rows="3"
                  maxlength="2000"
                  :value="style.prompt"
                  :aria-label="t('settings.novel.writingStylePrompt')"
                  @change="updateWritingStyle(index, { prompt: $event.target.value })"
                />
              </div>
              <p v-if="!novelSettings.writingStyles?.length" class="config-empty">{{ t('settings.novel.writingStyleEmpty') }}</p>
            </section>
          </template>
          <p v-else class="config-empty">{{ t('common.loading') }}</p>
        </div>
        </div>

        <!-- ===== 风格预设 ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-styles" aria-labelledby="settings-tab-styles" tabindex="0" :hidden="tab !== 'styles'">
        <div v-if="tab === 'styles'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.styles.title') }}</h2>
            <p class="settings-desc">{{ t('settings.styles.desc') }}</p>
          </div>
          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.styles.allTitle') }}</span>
                <div class="svc-group-sub">{{ t('settings.styles.count', { active: stylePresets.filter(p => p.is_active).length, total: stylePresets.length }) }}</div>
              </div>
              <button class="btn btn-ghost btn-sm ml-auto" @click="startStyleFromImages"><Sparkles :size="13" /> {{ t('settings.styles.fromImages') }}</button>
              <button class="btn btn-ghost btn-sm" @click="startAddStyle"><Plus :size="13" /> {{ t('common.add') }}</button>
            </div>
            <div v-for="p in stylePresets" :key="p.id" class="config-row">
              <div class="provider-badge style-badge"><Palette :size="15" /></div>
              <div class="config-main">
                <div class="config-line">
                  <span class="config-name">{{ p.name }}</span>
                  <span class="tag mono">{{ p.value }}</span>
                  <span v-if="!p.is_active" class="tag">{{ t('settings.common.disabled') }}</span>
                </div>
                <div class="config-sub mono truncate">{{ p.prompt }}</div>
                <div v-if="p.description" class="config-sub truncate">{{ p.description }}</div>
              </div>
              <label class="config-switch">
                <input type="checkbox" class="sr-only" :checked="p.is_active" @change="toggleStyle(p)">
                <span class="switch" :class="{ on: p.is_active }"></span>
              </label>
              <button class="btn btn-ghost btn-icon btn-sm" @click="startEditStyle(p)"><Pencil :size="13" /></button>
              <button class="btn btn-danger btn-icon btn-sm" @click="styleToDelete = p"><Trash2 :size="13" /></button>
            </div>
            <p v-if="!stylePresets.length" class="config-empty">{{ t('settings.styles.empty') }}</p>
          </section>
        </div>
        </div>

        <!-- ===== 流程规则（AI 改写 / 资产提取 / 分镜拆分 / 视频提示词） ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-rules" aria-labelledby="settings-tab-rules" tabindex="0" :hidden="tab !== 'rules'">
        <div v-if="tab === 'rules'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.rules.title') }}</h2>
            <p class="settings-desc">{{ t('settings.rules.desc') }}</p>
          </div>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.rules.taskTitle') }}</span>
                <div class="svc-group-sub">{{ t('settings.rules.taskSub') }}</div>
              </div>
            </div>

            <div v-for="r in pipelineRules" :key="r.key" class="rule-item">
              <div class="rule-head">
                <span class="rule-name">{{ t(`settings.rules.key.${ruleI18nKey(r.key)}`) }}</span>
                <span class="tag" :class="{ 'tag-success': !r.is_default }">{{ r.is_default ? t('common.default') : t('settings.common.custom') }}</span>
                <span v-if="RULE_PLACEHOLDERS[r.key]" class="rule-ph mono">{{ RULE_PLACEHOLDERS[r.key] }}</span>
                <button class="btn btn-ghost btn-sm ml-auto" :disabled="ruleSavingKey === r.key" @click="resetPipelineRuleItem(r)">
                  {{ t('settings.agents.reset') }}
                </button>
                <button class="btn btn-primary btn-sm" :disabled="ruleSavingKey === r.key" @click="savePipelineRuleItem(r)">
                  <Loader2 v-if="ruleSavingKey === r.key" :size="12" class="animate-spin" />
                  {{ t('common.save') }}
                </button>
              </div>
              <textarea
                v-model="r.rule"
                class="textarea rule-input"
                maxlength="12000"
                :rows="r.key === 'rewrite' ? 3 : (r.key.startsWith('extract') ? 5 : 10)"
              />
            </div>
            <p v-if="!pipelineRules.length" class="config-empty">{{ t('common.loading') }}</p>
          </section>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.rules.agentTitle') }}</span>
                <div class="svc-group-sub">{{ t('settings.rules.agentSub') }}</div>
              </div>
              <button class="btn btn-sm ml-auto" @click="tab = 'agents'">{{ t('settings.rules.agentOpen') }}</button>
            </div>
            <p class="config-empty">{{ t('settings.rules.agentHint') }}</p>
          </section>
        </div>
        </div>

        <!-- ===== 分镜拆分方案 ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-breakdown" aria-labelledby="settings-tab-breakdown" tabindex="0" :hidden="tab !== 'breakdown'">
        <div v-if="tab === 'breakdown'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.breakdown.title') }}</h2>
            <p class="settings-desc">{{ t('settings.breakdown.subtitle') }}</p>
          </div>

          <div class="breakdown-layout">
            <section class="card svc-group breakdown-list-card">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.breakdown.title') }}</span>
                  <div class="svc-group-sub">{{ t('settings.breakdown.methodCount', { count: breakdownMethods.length }) }}</div>
                </div>
                <button class="btn btn-primary btn-sm ml-auto" @click="newBreakdownMethod">
                  <Plus :size="13" /> {{ t('settings.breakdown.new') }}
                </button>
              </div>
              <div
                v-for="m in breakdownMethods"
                :key="m.key"
                :class="['breakdown-item', { active: m.key === breakdownEditingKey }]"
                role="button"
                tabindex="0"
                @click="selectBreakdownMethod(m)"
                @keydown.enter.prevent="selectBreakdownMethod(m)"
              >
                <div class="config-line">
                  <span class="config-name">{{ m.name }}</span>
                  <span class="tag" :class="{ 'tag-success': m.builtin }">{{ m.builtin ? t('settings.breakdown.builtin') : t('settings.breakdown.custom') }}</span>
                  <span v-if="m.customized" class="tag tag-accent">{{ t('settings.breakdown.customized') }}</span>
                </div>
                <div class="config-sub truncate">{{ m.description || '—' }}</div>
                <div class="config-sub">{{ t('settings.breakdown.usage', { count: m.usage_count }) }}</div>
              </div>
              <p v-if="breakdownLoading && !breakdownMethods.length" class="config-empty">
                <Loader2 :size="14" class="animate-spin" /> {{ t('common.loading') }}
              </p>
              <p v-else-if="breakdownLoadFailed" class="config-empty">{{ t('settings.breakdown.loadFailed') }}</p>
              <p v-else-if="!breakdownMethods.length" class="config-empty">{{ t('settings.breakdown.empty') }}</p>
            </section>

            <section class="card svc-group breakdown-editor-card">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ currentBreakdownMethod?.name || t('settings.breakdown.new') }}</span>
                  <div v-if="currentBreakdownMethod" class="svc-group-sub">
                    {{ currentBreakdownMethod.builtin ? t('settings.breakdown.builtin') : t('settings.breakdown.custom') }}
                    · {{ t('settings.breakdown.usage', { count: currentBreakdownMethod.usage_count }) }}
                  </div>
                </div>
                <span v-if="breakdownDirty" class="tag tag-accent ml-auto">{{ t('settings.breakdown.unsavedTag') }}</span>
              </div>

              <label class="field">
                <span class="field-label">{{ t('settings.breakdown.name') }} <span class="dim">{{ breakdownDraft.name.length }} / 60</span></span>
                <input v-model="breakdownDraft.name" class="input" maxlength="60" :placeholder="t('settings.breakdown.name')" />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settings.breakdown.description') }}</span>
                <textarea v-model="breakdownDraft.description" class="textarea" rows="2" maxlength="500" />
              </label>
              <label class="field">
                <span class="field-label">{{ t('settings.breakdown.prompt') }} <span class="dim">{{ breakdownDraft.prompt.length }} / 20000</span></span>
                <textarea v-model="breakdownDraft.prompt" class="textarea" rows="8" maxlength="20000" :placeholder="t('settings.breakdown.promptHint')" />
                <span class="field-hint">{{ t('settings.breakdown.promptHint') }}</span>
              </label>
              <label class="field">
                <span class="field-label">{{ t('settings.breakdown.skill') }} <span class="dim">{{ breakdownDraft.skill.length }} / 40000</span></span>
                <textarea v-model="breakdownDraft.skill" class="textarea" rows="10" maxlength="40000" :placeholder="t('settings.breakdown.skillHint')" />
                <span class="field-hint">{{ t('settings.breakdown.skillHint') }}</span>
              </label>

              <p v-if="bothBreakdownTextsEmpty" class="breakdown-empty-hint">{{ t('settings.breakdown.bothEmptyHint') }}</p>

              <div class="breakdown-actions">
                <button class="btn btn-primary" :disabled="breakdownSaving || !breakdownDraft.name.trim()" @click="saveBreakdownMethod">
                  <Loader2 v-if="breakdownSaving" :size="13" class="animate-spin" />
                  {{ breakdownSaving ? t('settings.breakdown.saving') : t('settings.breakdown.save') }}
                </button>
                <button class="btn" :disabled="!breakdownEditingKey || breakdownSaving" @click="duplicateBreakdownMethod">{{ t('settings.breakdown.duplicate') }}</button>
                <button v-if="currentBreakdownMethod?.builtin" class="btn btn-ghost" :disabled="breakdownSaving" @click="resetBreakdownMethod">{{ t('settings.breakdown.reset') }}</button>
                <button v-if="currentBreakdownMethod && !currentBreakdownMethod.builtin" class="btn btn-danger" :disabled="breakdownSaving" @click="breakdownToDelete = currentBreakdownMethod">{{ t('settings.breakdown.delete') }}</button>
              </div>
            </section>
          </div>
        </div>
        </div>

        <!-- ===== 分镜检验 ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-audit" aria-labelledby="settings-tab-audit" tabindex="0" :hidden="tab !== 'audit'">
        <div v-if="tab === 'audit'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.audit.title') }}</h2>
            <p class="settings-desc">{{ t('settings.audit.subtitle') }}</p>
          </div>

          <p v-if="auditPolicyLoading && !auditPolicy" class="config-empty">{{ t('common.loading') }}</p>
          <p v-else-if="auditPolicyLoadFailed" class="config-empty">{{ t('settings.audit.loadFailed') }}</p>
          <template v-else-if="auditPolicy">
            <section class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.audit.checks') }}</span>
                  <div class="svc-group-sub">{{ t('settings.audit.checksHint') }}</div>
                </div>
              </div>
              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.audit.check.shot') }}</span></div>
                </div>
                <label class="config-switch">
                  <input v-model="auditPolicy.checks.shot" type="checkbox" class="sr-only">
                  <span class="switch" :class="{ on: auditPolicy.checks.shot }"></span>
                </label>
              </div>
              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.audit.check.continuity') }}</span></div>
                </div>
                <label class="config-switch">
                  <input v-model="auditPolicy.checks.continuity" type="checkbox" class="sr-only">
                  <span class="switch" :class="{ on: auditPolicy.checks.continuity }"></span>
                </label>
              </div>
              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.audit.check.silent') }}</span></div>
                </div>
                <label class="config-switch">
                  <input v-model="auditPolicy.checks.silent" type="checkbox" class="sr-only">
                  <span class="switch" :class="{ on: auditPolicy.checks.silent }"></span>
                </label>
              </div>
              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.audit.check.lineDuration') }}</span></div>
                </div>
                <label class="config-switch">
                  <input v-model="auditPolicy.checks.lineDuration" type="checkbox" class="sr-only">
                  <span class="switch" :class="{ on: auditPolicy.checks.lineDuration }"></span>
                </label>
              </div>
              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.audit.check.assets') }}</span></div>
                </div>
                <label class="config-switch">
                  <input v-model="auditPolicy.checks.assets" type="checkbox" class="sr-only">
                  <span class="switch" :class="{ on: auditPolicy.checks.assets }"></span>
                </label>
              </div>
            </section>

            <section class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.audit.thresholds') }}</span>
                  <div class="svc-group-sub">{{ t('settings.audit.thresholdHint') }}</div>
                </div>
              </div>
              <div class="field-row">
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.threshold.charsPerSecond') }}</span>
                  <input v-model.number="auditPolicy.thresholds.charsPerSecond" class="input" type="number" min="1" max="12" step="0.5">
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.threshold.lineBreathSeconds') }}</span>
                  <input v-model.number="auditPolicy.thresholds.lineBreathSeconds" class="input" type="number" min="0" max="3" step="0.5">
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.threshold.lineRequiredMaxSeconds') }}</span>
                  <input v-model.number="auditPolicy.thresholds.lineRequiredMaxSeconds" class="input" type="number" min="3" max="30" step="1">
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.threshold.silentCharacterWarnSeconds') }}</span>
                  <input v-model.number="auditPolicy.thresholds.silentCharacterWarnSeconds" class="input" type="number" min="2" max="120" step="1">
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.threshold.silentCharacterErrorSeconds') }}</span>
                  <input v-model.number="auditPolicy.thresholds.silentCharacterErrorSeconds" class="input" type="number" min="2" max="120" step="1">
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.threshold.emptyShotWarnSeconds') }}</span>
                  <input v-model.number="auditPolicy.thresholds.emptyShotWarnSeconds" class="input" type="number" min="1" max="120" step="1">
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.threshold.promptSegmentMaxChars') }}</span>
                  <input v-model.number="auditPolicy.thresholds.promptSegmentMaxChars" class="input" type="number" min="4" max="40" step="1">
                </label>
              </div>
            </section>

            <section class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.audit.semantic') }}</span>
                  <div class="svc-group-sub">{{ t('settings.audit.semanticHint') }}</div>
                </div>
                <label class="config-switch">
                  <input v-model="auditPolicy.semantic.enabled" type="checkbox" class="sr-only">
                  <span class="switch" :class="{ on: auditPolicy.semantic.enabled }"></span>
                </label>
              </div>
              <div class="field-row">
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.semanticLabel.windowSize') }}</span>
                  <input v-model.number="auditPolicy.semantic.windowSize" class="input" type="number" min="4" max="40" step="1">
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.semanticLabel.windowStep') }}</span>
                  <input v-model.number="auditPolicy.semantic.windowStep" class="input" type="number" min="1" max="40" step="1">
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.semanticLabel.maxWindows') }}</span>
                  <input v-model.number="auditPolicy.semantic.maxWindows" class="input" type="number" min="1" max="60" step="1">
                </label>
              </div>
            </section>

            <section class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.audit.autoRepair') }}</span>
                  <div class="svc-group-sub">{{ t('settings.audit.autoRepairHint') }}</div>
                </div>
                <label class="config-switch">
                  <input v-model="auditPolicy.autoRepair.enabled" type="checkbox" class="sr-only">
                  <span class="switch" :class="{ on: auditPolicy.autoRepair.enabled }"></span>
                </label>
              </div>
              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.audit.repairLabel.semanticFix') }}</span></div>
                </div>
                <label class="config-switch">
                  <input v-model="auditPolicy.autoRepair.semanticFix" type="checkbox" class="sr-only">
                  <span class="switch" :class="{ on: auditPolicy.autoRepair.semanticFix }"></span>
                </label>
              </div>
              <div class="config-row">
                <div class="config-main">
                  <div class="config-line"><span class="config-name">{{ t('settings.audit.repairLabel.autoInsertTransition') }}</span></div>
                </div>
                <label class="config-switch">
                  <input v-model="auditPolicy.autoRepair.autoInsertTransition" type="checkbox" class="sr-only">
                  <span class="switch" :class="{ on: auditPolicy.autoRepair.autoInsertTransition }"></span>
                </label>
              </div>
              <div class="field-row">
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.repairLabel.maxInsertedTransitions') }}</span>
                  <input v-model.number="auditPolicy.autoRepair.maxInsertedTransitions" class="input" type="number" min="1" max="10" step="1">
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.repairLabel.maxActions') }}</span>
                  <input v-model.number="auditPolicy.autoRepair.maxActions" class="input" type="number" min="1" max="100" step="1">
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.audit.repairLabel.maxActionsPerShot') }}</span>
                  <input v-model.number="auditPolicy.autoRepair.maxActionsPerShot" class="input" type="number" min="1" max="10" step="1">
                </label>
              </div>
            </section>

            <section class="card svc-group">
              <div class="svc-group-head">
                <div class="svc-group-heading">
                  <span class="svc-group-title">{{ t('settings.audit.promptTitle') }}</span>
                  <div class="svc-group-sub">{{ t('settings.audit.promptDesc') }}</div>
                </div>
                <button class="btn btn-sm ml-auto" @click="openAuditorAgent">{{ t('settings.audit.promptOpen') }}</button>
              </div>
            </section>

            <div class="breakdown-actions">
              <button class="btn btn-primary" :disabled="auditPolicySaving" @click="saveAuditPolicy">
                <Loader2 v-if="auditPolicySaving" :size="13" class="animate-spin" />
                {{ auditPolicySaving ? t('settings.audit.saving') : t('settings.audit.save') }}
              </button>
              <span v-if="auditPolicySaved" class="tag tag-success"><Check :size="10" /> {{ t('common.saved') }}</span>
            </div>
          </template>
        </div>
        </div>

        <!-- ===== 任务队列 ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-queue" aria-labelledby="settings-tab-queue" tabindex="0" :hidden="tab !== 'queue'">
        <div v-if="tab === 'queue'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.queue.title') }}</h2>
            <p class="settings-desc">{{ t('settings.queue.desc') }}</p>
          </div>
          <QueuePanel />
        </div>
        </div>

        <!-- ===== 存储位置 ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-storage" aria-labelledby="settings-tab-storage" tabindex="0" :hidden="tab !== 'storage'">
        <div v-if="tab === 'storage'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.storage.title') }}</h2>
            <p class="settings-desc">{{ t('settings.storage.desc') }}</p>
          </div>
          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.storage.currentDir') }}</span>
                <div v-if="storageInfo?.computedAt" class="svc-group-sub">{{ t('settings.storage.computedAt', { time: new Date(storageInfo.computedAt).toLocaleString() }) }}</div>
              </div>
              <button v-if="isDesktopMode" class="btn btn-primary btn-sm ml-auto" :disabled="migrating" @click="pickTarget">
                <HardDrive :size="13" /> {{ t('settings.storage.changeLocation') }}
              </button>
            </div>
            <div class="config-row">
              <div class="provider-badge style-badge"><HardDrive :size="15" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ t('settings.storage.dataDir') }}</span><span class="tag mono">{{ storageModeLabel }}</span></div>
                <div class="config-sub mono truncate">{{ storageInfo?.dataDir || t('common.loading') }}</div>
                <div class="config-sub mono truncate">{{ storageInfo?.sqlitePath || '' }}</div>
              </div>
            </div>
            <div v-if="storageInfo?.usage" class="config-row">
              <div class="provider-badge style-badge"><Database :size="15" /></div>
              <div class="config-main">
                <div class="config-line">
                  <span class="config-name">{{ t('settings.storage.totalUsage', { size: formatBytes(displayTotalBytes) }) }}</span>
                  <span v-if="storageInfo.usageStale" class="tag">{{ t('settings.storage.counting') }}</span>
                </div>
                <div class="storage-breakdown">
                  <span class="tag mono">{{ t('settings.storage.breakdown.db') }} {{ formatBytes(storageInfo.usage.db) }}</span>
                  <span class="tag mono">{{ t('settings.storage.breakdown.images') }} {{ formatBytes(storageInfo.usage.images) }}</span>
                  <span class="tag mono">{{ t('settings.storage.breakdown.videos') }} {{ formatBytes(storageInfo.usage.videos) }}</span>
                  <span class="tag mono">{{ t('settings.storage.breakdown.merged') }} {{ formatBytes(storageInfo.usage.merged) }}</span>
                  <span class="tag mono">{{ t('settings.storage.breakdown.uploads') }} {{ formatBytes(storageInfo.usage.uploads) }}</span>
                  <span v-if="storageInfo.usage.temp" class="tag mono">{{ t('settings.storage.breakdown.temp') }} {{ formatBytes(storageInfo.usage.temp) }}</span>
                  <span v-if="storageInfo.usage.backups" class="tag mono">{{ t('settings.storage.breakdown.backups') }} {{ formatBytes(storageInfo.usage.backups) }}</span>
                  <span v-if="storageInfo.usage.sync" class="tag mono">{{ t('settings.storage.breakdown.sync') }} {{ formatBytes(storageInfo.usage.sync) }}</span>
                  <span v-if="storageInfo.usage.other" class="tag mono">{{ t('settings.storage.breakdown.other') }} {{ formatBytes(storageInfo.usage.other) }}</span>
                  <template v-if="isAppStorage && storageInfo.app">
                    <span class="tag mono">{{ t('settings.storage.breakdown.runtime') }} {{ formatBytes(storageInfo.app.runtimeBytes) }}</span>
                    <span class="tag mono">{{ t('settings.storage.breakdown.logs') }} {{ formatBytes(storageInfo.app.logsBytes) }}</span>
                    <span class="tag mono">{{ t('settings.storage.breakdown.cache') }} {{ formatBytes(storageInfo.app.cacheBytes) }}</span>
                  </template>
                </div>
                <div v-if="storageInfo.freeBytes != null" class="config-sub">{{ t('settings.storage.diskFree', { size: formatBytes(storageInfo.freeBytes) }) }}</div>
              </div>
            </div>
            <p v-if="storageInfo?.storage?.level === 'warn'" class="field-hint storage-warn">{{ t('settings.storage.warn', { size: formatBytes(storageInfo.storage.warnBytes) }) }}</p>
            <p v-else-if="storageInfo?.storage?.level === 'blocked'" class="field-hint storage-blocked">{{ t('settings.storage.blocked', { size: formatBytes(storageInfo.storage.blockBytes) }) }}</p>
            <p class="config-empty">{{ t('settings.storage.note') }}</p>
            <p v-if="!isDesktopMode && !isAppStorage" class="config-empty">{{ t('settings.storage.serverNote') }}</p>
            <p v-if="isAppStorage" class="config-empty">{{ t('settings.storage.appNote') }}</p>
            <p v-if="isAppStorage" class="config-empty">{{ t('settings.storage.appUninstall') }}</p>
          </section>

          <section v-if="isAppStorage" class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.storage.backups.title') }}</span>
                <div class="svc-group-sub">{{ t('settings.storage.backups.desc', { count: backupInfo?.maxBackups || 3 }) }}</div>
              </div>
              <button class="btn btn-primary btn-sm ml-auto" :disabled="backupBusy" @click="createBackup">
                <Loader2 v-if="backupBusy" :size="13" class="animate-spin" />
                <Database v-else :size="13" />
                {{ t('settings.storage.backups.create') }}
              </button>
            </div>
            <p v-if="backupInfo?.pendingRestore" class="field-hint storage-warn">
              {{ t('settings.storage.backups.pending', { name: backupInfo.pendingRestore.name }) }}
            </p>
            <p v-if="backupInfo?.lastRestore" class="field-hint" :class="backupInfo.lastRestore.ok ? '' : 'migrate-warn'">
              {{ backupInfo.lastRestore.ok
                ? t('settings.storage.backups.lastRestoreOk', { name: backupInfo.lastRestore.name, time: new Date(backupInfo.lastRestore.restoredAt).toLocaleString() })
                : t('settings.storage.backups.lastRestoreFailed', { name: backupInfo.lastRestore.name, error: backupInfo.lastRestore.error || '' }) }}
            </p>
            <p v-if="!backupInfo?.backups?.length" class="config-empty">{{ t('settings.storage.backups.empty') }}</p>
            <div v-for="item in backupInfo?.backups || []" :key="item.name" class="backup-row">
              <div class="config-main">
                <div class="config-line">
                  <span class="config-name mono">{{ item.name }}</span>
                  <span class="tag">{{ backupReasonLabel(item.reason) }}</span>
                </div>
                <div class="config-sub">{{ new Date(item.createdAt).toLocaleString() }} · {{ formatBytes(item.sizeBytes) }}</div>
                <div class="config-sub mono truncate">{{ item.sha256 }}</div>
              </div>
              <div class="backup-actions">
                <a class="btn btn-sm" :href="backupDownloadUrl(item.name)" :download="item.name">{{ t('settings.storage.backups.download') }}</a>
                <button class="btn btn-sm" :disabled="backupBusy || !!backupInfo?.pendingRestore" @click="askRestore(item)">{{ t('settings.storage.backups.restore') }}</button>
                <button class="btn btn-sm" :disabled="backupBusy || backupInfo?.pendingRestore?.name === item.name" @click="askDeleteBackup(item)">{{ t('settings.storage.backups.delete') }}</button>
              </div>
            </div>
          </section>
        </div>
        </div>

        <!-- ===== MCP 服务 ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-mcp" aria-labelledby="settings-tab-mcp" tabindex="0" :hidden="tab !== 'mcp'">
        <div v-if="tab === 'mcp'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.mcp.title') }}</h2>
            <p class="settings-desc">{{ t('settings.mcp.desc') }}</p>
          </div>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.mcp.service') }}</span>
                <div class="svc-group-sub">
                  {{ mcpStatus.running ? t('settings.mcp.running', { port: mcpStatus.port }) : t('settings.mcp.stopped') }}
                </div>
              </div>
              <label class="config-switch ml-auto">
                <input type="checkbox" class="sr-only" :checked="mcpStatus.enabled" :disabled="mcpBusy" @change="toggleMcp">
                <span class="switch" :class="{ on: mcpStatus.enabled }"></span>
              </label>
            </div>

            <div class="config-row">
              <div class="provider-badge" style="background:var(--accent-bg);color:var(--accent)"><Plug :size="15" /></div>
              <div class="config-main">
                <div class="config-line">
                  <span class="config-name">{{ t('settings.mcp.endpoint') }}</span>
                  <span class="tag mono">{{ mcpStatus.running ? t('settings.mcp.on') : t('settings.mcp.off') }}</span>
                </div>
                <div class="config-sub mono truncate">{{ mcpStatus.url }}</div>
              </div>
              <input
                v-model.number="mcpPort"
                class="input mcp-port-input"
                type="number"
                min="1024"
                max="65535"
                :disabled="mcpBusy"
                @change="saveMcpPort"
              >
            </div>

            <div class="config-row">
              <div class="provider-badge" style="background:var(--accent-bg);color:var(--accent)"><KeyRound :size="15" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ t('settings.mcp.token') }}</span></div>
                <div class="config-sub mono truncate">{{ mcpStatus.token || t('settings.mcp.noToken') }}</div>
                <div class="config-sub">{{ t('settings.mcp.tokenHint') }}</div>
              </div>
              <button class="btn btn-sm" :disabled="mcpBusy || !mcpStatus.token" @click="copyMcpToken"><Copy :size="12" /> {{ t('settings.mcp.copy') }}</button>
              <button class="btn btn-sm" :disabled="mcpBusy" @click="rotateMcpToken">{{ t('settings.mcp.regenerate') }}</button>
            </div>

            <p v-if="mcpStatus.error" class="config-empty mcp-error">{{ t('settings.mcp.error', { msg: mcpStatus.error }) }}</p>
            <p v-else class="config-empty">{{ t('settings.mcp.hint') }}</p>
          </section>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.mcp.clientConfig') }}</span>
                <div class="svc-group-sub">{{ t('settings.mcp.clientConfigSub', { n: mcpStatus.tool_count || 0 }) }}</div>
              </div>
              <button class="btn btn-sm ml-auto" :disabled="!mcpStatus.token" @click="copyMcpConfig"><Copy :size="12" /> {{ t('settings.mcp.copyConfig') }}</button>
            </div>
            <pre class="mcp-snippet">{{ mcpConfigText }}</pre>
            <p class="config-empty">{{ t('settings.mcp.security') }}</p>
          </section>

          <section class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.mcp.toolsTitle') }}</span>
              </div>
            </div>
            <div class="settings-table-scroll">
            <div class="storage-breakdown">
              <span v-for="name in (mcpStatus.tools || [])" :key="name" class="tag mono">{{ name }}</span>
            </div>
            </div>
          </section>
        </div>
        </div>

        <!-- ===== 关于更新 ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-about" aria-labelledby="settings-tab-about" tabindex="0" :hidden="tab !== 'about'">
        <div v-if="tab === 'about'" class="settings-scroll">
          <div class="settings-head">
            <h2 class="settings-title">{{ t('settings.about.title') }}</h2>
            <p class="settings-desc">{{ isAppMode ? t('settings.about.appDesc') : t('settings.about.desc') }}</p>
          </div>
          <section v-if="!isGuest && !isAppMode" class="card svc-group">
            <div class="svc-group-head">
              <div class="svc-group-heading">
                <span class="svc-group-title">{{ t('settings.about.currentVersion', { v: updateState?.currentVersion || '…' }) }}</span>
                <div v-if="updateState?.latestVersion" class="svc-group-sub">{{ t('settings.about.latestVersion', { v: updateState.latestVersion }) }}</div>
              </div>
              <button class="btn btn-primary btn-sm ml-auto" :disabled="updateChecking" @click="checkUpdate">
                <Loader2 v-if="updateChecking" :size="13" class="animate-spin" />
                <RefreshCw v-else :size="13" />
                {{ t('settings.about.check') }}
              </button>
            </div>

            <div v-if="updateState?.status === 'up-to-date'" class="config-row">
              <div class="provider-badge style-badge"><Check :size="15" /></div>
              <div class="config-main"><div class="config-line"><span class="config-name">{{ t('settings.about.upToDate') }}</span></div></div>
            </div>
            <div v-else-if="updateState?.status === 'available' || updateState?.status === 'downloading'" class="config-row">
              <div class="provider-badge style-badge"><Sparkles :size="15" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ t('settings.about.found', { v: updateState.latestVersion }) }}</span></div>
                <div v-if="updateState.notes" class="config-sub">{{ updateState.notes }}</div>
                <div v-if="updateState.status === 'downloading' || updateDownloading" class="update-bar">
                  <div class="update-bar-fill" :style="{ width: `${updateProgress}%` }"></div>
                </div>
                <!-- 服务器手动模式：无 Watchtower，给出更新命令 -->
                <div v-if="!desktopBridge && serverUpdateMode === 'manual'" class="config-sub">
                  {{ t('settings.about.serverManualHint') }} <span class="mono">docker compose pull && docker compose up -d</span>
                </div>
              </div>
              <!-- 桌面版：下载更新包 -->
              <button v-if="desktopBridge" class="btn btn-primary btn-sm" :disabled="updateDownloading" @click="downloadUpdate">
                <Loader2 v-if="updateDownloading" :size="13" class="animate-spin" />
                <Download v-else :size="13" />
                {{ updateDownloading ? t('settings.about.downloading', { p: updateProgress }) : t('settings.about.download') }}
              </button>
              <!-- 服务器 + Watchtower：一键触发拉镜像重建 -->
              <button v-else-if="serverUpdateMode === 'watchtower'" class="btn btn-primary btn-sm" :disabled="updateApplying" @click="applyUpdate">
                <Loader2 v-if="updateApplying" :size="13" class="animate-spin" />
                <Download v-else :size="13" />
                {{ t('settings.about.serverApply') }}
              </button>
            </div>
            <div v-else-if="updateState?.status === 'downloaded'" class="config-row">
              <div class="provider-badge style-badge"><Download :size="15" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ t('settings.about.ready') }}</span></div>
                <div class="config-sub">{{ t('settings.about.readyDesc') }}</div>
              </div>
              <button class="btn btn-primary btn-sm" :disabled="updateApplying" @click="applyUpdate">
                <Loader2 v-if="updateApplying" :size="13" class="animate-spin" />
                {{ t('settings.about.restartInstall') }}
              </button>
            </div>
            <div v-else-if="updateState?.status === 'error'" class="config-row">
              <div class="provider-badge style-badge"><RefreshCw :size="15" /></div>
              <div class="config-main">
                <div class="config-line"><span class="config-name">{{ t('settings.about.checkFailed') }}</span></div>
                <div class="config-sub">{{ updateState.error }}</div>
              </div>
              <button class="btn btn-ghost btn-sm" @click="checkUpdate">{{ t('settings.about.retry') }}</button>
            </div>
            <p v-else class="config-empty">{{ t('settings.about.empty') }}</p>
          </section>
          <p v-if="isAppMode" class="config-empty">{{ t('settings.about.appNote') }}</p>
          <p v-else-if="desktopBridge" class="config-empty">{{ t('settings.about.note') }}</p>
          <p v-else class="config-empty">{{ t('settings.about.serverNote') }}</p>
        </div>
        </div>

        <!-- ===== Agent 配置（左侧 tab 切换，Prompt 与 Skills 整合在同一 Agent 下） ===== -->
        <div class="settings-tabpanel" role="tabpanel" id="settings-panel-agents" aria-labelledby="settings-tab-agents" tabindex="0" :hidden="tab !== 'agents'">
        <div v-if="tab === 'agents'" class="skills-layout">
          <!-- Agent 左侧 tab 列表 -->
          <aside class="skills-agent-list">
            <div class="skills-agent-title">{{ t('settings.skills.agentList') }}</div>
            <button
              v-for="a in agentDefs"
              :key="a.type"
              :class="['skills-agent-item', { active: selectedAgent === a.type }]"
              @click="selectAgent(a.type)"
            >
              <span class="agent-type-badge">{{ a.icon }}</span>
              <span class="skills-agent-label">{{ a.label }}</span>
              <span v-if="agentSkillCount(a.type) > 0" class="skill-count-badge">{{ agentSkillCount(a.type) }}</span>
            </button>
          </aside>

          <!-- 右侧主区域 -->
          <div class="settings-scroll skills-main">
            <div class="settings-head skills-head">
              <span class="agent-type-badge skills-head-badge">{{ selectedAgentIcon }}</span>
              <div class="skills-head-copy">
                <h2 class="settings-title">{{ selectedAgentLabel }}</h2>
                <div class="dim" style="font-size:12px;margin-top:2px;display:flex;align-items:center;gap:6px">
                  {{ selectedAgentType }}
                  <span v-if="getAgentCfg(selectedAgent) && !getAgentCfg(selectedAgent).is_default" class="tag tag-success">{{ t('settings.common.custom') }}</span>
                  <span v-else class="tag">{{ t('common.default') }}</span>
                </div>
              </div>
              <button v-if="agentPane === 'skills'" class="btn btn-primary btn-sm ml-auto" @click="startAddSkill">
                <Plus :size="13" /> {{ t('settings.skills.add') }}
              </button>
            </div>

            <!-- Prompt 面板（子 tab 作为卡片头，与卡片同宽对齐） -->
            <div v-if="agentPane === 'prompt'" class="card agent-card">
              <div class="agent-pane-tabs">
                <div class="agent-pane-tabs-nav">
                  <button :class="['agent-pane-tab', { active: agentPane === 'prompt' }]" @click="agentPane = 'prompt'">System Prompt</button>
                  <button :class="['agent-pane-tab', { active: agentPane === 'skills' }]" @click="agentPane = 'skills'">
                    Skills<template v-if="agentSkillCount(selectedAgent) > 0"> ({{ agentSkillCount(selectedAgent) }})</template>
                  </button>
                </div>
                <span class="agent-lang-follow dim">
                  {{ t('settings.agents.followContentLang', { lang: contentLangLabel }) }}
                </span>
              </div>
              <div class="agent-card-body">
                <label class="field">
                  <span class="field-label">System Prompt <span class="dim">({{ t('settings.agents.promptHint', { file: promptFileName }) }})</span>
                    <span v-if="agentPromptFallback" class="tag agent-fallback-tag">{{ t('settings.agents.langFallback') }}</span>
                  </span>
                  <textarea v-model="agentForm.system_prompt" class="textarea agent-prompt-input" rows="16" :placeholder="t('settings.agents.promptPlaceholder')" />
                </label>
                <div class="agent-card-foot">
                  <button class="btn btn-ghost btn-sm" @click="resetAgentPrompt(selectedAgent)">{{ t('settings.agents.reset') }}</button>
                  <span v-if="agentSaved === selectedAgent" class="tag tag-success" style="margin-left:8px">
                    <Check :size="10" /> {{ t('common.saved') }}
                  </span>
                  <button class="btn btn-primary btn-sm ml-auto" :disabled="agentSaving" @click="saveAgentCfg(selectedAgent)">
                    <Loader2 v-if="agentSaving" :size="12" class="animate-spin" />
                    {{ t('common.save') }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Skills 面板（子 tab 同为卡片头） -->
            <template v-else>
              <div class="agent-pane-tabs-wrap card">
                <div class="agent-pane-tabs">
                  <div class="agent-pane-tabs-nav">
                    <button :class="['agent-pane-tab', { active: agentPane === 'prompt' }]" @click="agentPane = 'prompt'">System Prompt</button>
                    <button :class="['agent-pane-tab', { active: agentPane === 'skills' }]" @click="agentPane = 'skills'">
                      Skills<template v-if="agentSkillCount(selectedAgent) > 0"> ({{ agentSkillCount(selectedAgent) }})</template>
                    </button>
                  </div>
                  <span class="agent-lang-follow dim">
                    {{ t('settings.agents.followContentLang', { lang: contentLangLabel }) }}
                  </span>
                </div>
              </div>
              <p class="settings-desc" style="margin-top:0">{{ t('settings.skills.desc') }}</p>

              <!-- 无 skill 提示 -->
              <div v-if="!currentSkills.length" class="card skills-empty">
                <div class="skills-empty-icon">
                  <FileText :size="24" />
                </div>
                <div class="skills-empty-title">{{ t('settings.skills.emptyTitle') }}</div>
                <div class="skills-empty-desc">{{ t('settings.skills.emptyDesc') }}</div>
              </div>

              <!-- Skill 列表 -->
              <div class="settings-table-scroll" v-else>
              <div class="skill-list">
                <div v-for="s in currentSkills" :key="s.id" class="card skill-card">
                  <div class="skill-card-head" @click="toggleSkillEdit(s.id)">
                    <FileText :size="14" style="color:var(--accent);flex-shrink:0" />
                    <div style="flex:1;min-width:0">
                      <div style="font-weight:600;font-size:13px">{{ s.name }}</div>
                      <div class="dim" style="font-size:11px">{{ s.description }}</div>
                    </div>
                    <button class="btn btn-danger btn-icon btn-sm" style="margin-right:4px" @click.stop="skillToDelete = s.id">
                      <Trash2 :size="13" />
                    </button>
                    <ChevronDown :size="14" :style="{ transform: editingSkill === s.id ? 'rotate(180deg)' : '', transition: '0.2s' }" />
                  </div>
                  <div v-if="editingSkill === s.id" class="skill-card-body">
                    <textarea
                      v-model="skillContent"
                      class="textarea mono skill-content-input"
                      rows="20"
                      style="font-size:12px;line-height:1.6"
                      :placeholder="t('settings.skills.contentPlaceholder')"
                    />
                    <div class="skill-card-foot">
                      <span class="dim" style="font-size:11px">skills/{{ s.id }}/{{ skillFileName }}</span>
                      <span v-if="skillContentFallback" class="tag agent-fallback-tag">{{ t('settings.agents.langFallback') }}</span>
                      <span v-if="skillSaved === s.id" class="tag tag-success" style="margin-left:8px">
                        <Check :size="10" /> {{ t('common.saved') }}
                      </span>
                      <button class="btn btn-primary btn-sm ml-auto" :disabled="skillSaving" @click="saveSkill(s.id)">
                        <Loader2 v-if="skillSaving" :size="12" class="animate-spin" />
                        {{ t('common.save') }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              </div>
            </template>
          </div>
        </div>
      </div>
      </div>
    </div>

    <!-- AI Config Dialog -->
    <div v-if="cfgDialog" class="overlay" @click.self="cfgDialog = false">
      <form class="dialog config-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-cfg-title" @submit.prevent="saveCfg" @keydown="onSettingsDialogKeydown">
        <div class="dialog-head">
          <div>
            <div class="dialog-title" id="settings-cfg-title">{{ cfgEditId ? t('settings.cfg.editTitle') : t('settings.cfg.addTitle', { type: serviceMeta[cfgForm.service_type].label }) }}</div>
            <div class="dialog-sub">{{ t('settings.cfg.sub') }}</div>
          </div>
          <span class="tag tag-accent ml-auto">{{ serviceMeta[cfgForm.service_type].label }}</span>
        </div>
        <div class="dialog-body config-dialog-body">
          <div class="preset-picker">
            <button
              v-for="preset in presetsByType(cfgForm.service_type)"
              :key="`${cfgForm.service_type}-${preset.provider}`"
              type="button"
              class="preset-pill"
              @click="applyProviderPreset(cfgForm.service_type, preset.provider)"
            >
              {{ preset.label }}
            </button>
          </div>
          <label class="field">
            <span class="field-label">{{ t('settings.cfg.name') }}</span>
            <input v-model="cfgForm.name" class="input" :placeholder="t('settings.cfg.namePlaceholder')" />
          </label>
          <label class="field"><span class="field-label">{{ t('settings.cfg.provider') }}</span>
            <BaseSelect v-model="cfgForm.provider" :options="providerSelectOptions" :placeholder="t('settings.cfg.providerPlaceholder')" searchable />
          </label>
          <label class="field">
            <span class="field-label">{{ t('settings.cfg.priority') }}</span>
            <input v-model.number="cfgForm.priority" class="input" type="number" min="0" max="999" />
            <span class="field-hint">{{ t('settings.cfg.priorityHint') }}</span>
          </label>
          <label class="field"><span class="field-label">API Key</span><input v-model="cfgForm.api_key" class="input" type="password" placeholder="sk-..." /></label>
          <label class="field"><span class="field-label">Base URL</span><input v-model="cfgForm.base_url" class="input" placeholder="https://..." /></label>
          <div class="field">
            <span class="field-label">{{ t('settings.cfg.models') }}</span>
            <div v-if="cfgForm.models.length" class="model-chips">
              <span
                v-for="(m, i) in cfgForm.models" :key="`${m}-${i}`"
                :class="['model-chip', { 'is-default': i === 0 }]"
                :title="t('settings.cfg.modelChipHint')"
                @click="pinModelTop(i)"
              >
                {{ m }}<em v-if="i === 0">{{ t('common.default') }}</em>
                <button type="button" class="model-chip-x" :title="t('common.delete')" @click.stop="removeModel(i)"><X :size="11" /></button>
              </span>
            </div>
            <div class="model-add-row">
              <input
                v-model="modelInput" class="input" :placeholder="t('settings.cfg.modelPlaceholder')"
                @keydown.enter.prevent="addModel"
                @paste="onModelPaste"
              />
              <button type="button" class="btn btn-sm" :disabled="!modelInput.trim()" @click="addModel">{{ t('common.add') }}</button>
            </div>
            <span class="field-hint">{{ t('settings.cfg.modelsHint') }}</span>
          </div>
          <template v-if="cfgForm.service_type === 'audio-gen' && cfgForm.provider === 'comfyui'">
            <section class="cfg-settings">
              <div class="cfg-settings-head">{{ t('settings.cfg.providerSettings') }}</div>
              <div class="field">
                <span class="field-label">{{ t('settings.cfg.comfyMode') }}</span>
                <div class="comfy-mode-switch">
                  <button type="button" :class="['comfy-mode-pill', { 'is-active': cfgComfyMode === 'gateway' }]" @click="cfgComfyMode = 'gateway'">{{ t('settings.cfg.comfyModeGateway') }}</button>
                  <button type="button" :class="['comfy-mode-pill', { 'is-active': cfgComfyMode === 'direct' }]" @click="cfgComfyMode = 'direct'">{{ t('settings.cfg.comfyModeDirect') }}</button>
                </div>
                <span class="field-hint">{{ t('settings.cfg.comfyModeHint') }}</span>
              </div>
              <template v-if="cfgComfyMode === 'gateway'">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.gatewayWorkflow') }} <span class="required">*</span></span>
                  <div class="gateway-workflow-row">
                    <BaseSelect v-model="cfgForm.provider_settings.workflow_slug" :options="gatewayWorkflowOptions" :placeholder="t('settings.cfg.gatewayWorkflowPlaceholder')" searchable />
                    <button type="button" class="btn btn-sm" :disabled="gwLoading" @click="loadGatewayWorkflows">
                      <Loader2 v-if="gwLoading" :size="12" class="animate-spin" />
                      {{ t('settings.cfg.gatewayLoadWorkflows') }}
                    </button>
                  </div>
                  <span v-if="gwError" class="field-hint gw-error">{{ gwError }}</span>
                  <span class="field-hint">{{ t('settings.cfg.gatewayWorkflowHint') }}</span>
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.gatewayAdminUrl') }}</span>
                  <div class="gateway-workflow-row">
                    <input v-model="gatewayAdminUrl" class="input mono" :placeholder="t('settings.cfg.gatewayAdminUrlPlaceholder')" />
                    <button type="button" class="btn btn-sm" @click="openGatewayAdmin">{{ t('settings.cfg.gatewayAdminOpen') }}</button>
                    <button type="button" class="btn btn-sm" @click="copyGatewayAdminUrl">{{ t('settings.cfg.gatewayAdminCopy') }}</button>
                  </div>
                  <span class="field-hint">{{ t('settings.cfg.gatewayAdminHint') }}</span>
                </label>
              </template>
              <template v-else>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.comfyWorkflow') }} <span class="required">*</span></span>
                  <textarea
                    v-model="cfgForm.provider_settings.workflow"
                    class="textarea mono cfg-workflow"
                    rows="8"
                    :placeholder="t('settings.cfg.comfyWorkflowPlaceholder')"
                  ></textarea>
                  <span class="field-hint">{{ t('settings.cfg.audioWorkflowHint') }}</span>
                </label>
                <div class="cfg-setting-grid">
                  <label class="field">
                    <span class="field-label">{{ t('settings.cfg.outputNode') }}</span>
                    <input v-model="cfgForm.provider_settings.output_node" class="input mono" placeholder="9" />
                  </label>
                  <label class="field">
                    <span class="field-label">{{ t('settings.cfg.outputKey') }}</span>
                    <input v-model="cfgForm.provider_settings.output_key" class="input mono" placeholder="audio" />
                  </label>
                </div>
                <span class="field-hint">{{ t('settings.cfg.audioOutputNodeHint') }}</span>
              </template>
              <label class="field">
                <span class="field-label">{{ t('settings.cfg.negativePrompt') }}</span>
                <input v-model="cfgForm.provider_settings.negative_prompt" class="input" :placeholder="t('settings.cfg.negativePromptPlaceholder')" />
              </label>
              <div class="cfg-setting-grid">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.seed') }}</span>
                  <input v-model="cfgForm.provider_settings.seed" class="input" type="number" step="1" :placeholder="t('settings.cfg.seedPlaceholder')" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.audioTimeout') }}</span>
                  <input v-model="cfgForm.provider_settings.timeout_ms" class="input" type="number" min="1000" step="1000" placeholder="600000" />
                </label>
              </div>
              <label class="field cfg-check">
                <input v-model="cfgForm.provider_settings.normalize_loudness" type="checkbox" />
                <span>{{ t('settings.cfg.audioNormalize') }}</span>
              </label>
              <span class="field-hint">{{ t('settings.cfg.audioNormalizeHint') }}</span>
              <label class="field">
                <span class="field-label">{{ t('settings.cfg.modelLicense') }}</span>
                <input v-model="cfgForm.provider_settings.model_license" class="input mono" placeholder="stability-ai-community" />
                <span class="field-hint">{{ t('settings.cfg.modelLicenseHint') }}</span>
              </label>
              <span class="field-hint">{{ t('settings.cfg.audioTimeoutHint') }}</span>
            </section>
          </template>
          <template v-else-if="cfgForm.provider === 'comfyui' && (cfgForm.service_type === 'image' || cfgForm.service_type === 'video')">
            <section class="cfg-settings">
              <div class="cfg-settings-head">{{ t('settings.cfg.providerSettings') }}</div>
              <div class="field">
                <span class="field-label">{{ t('settings.cfg.comfyMode') }}</span>
                <div class="comfy-mode-switch">
                  <button type="button" :class="['comfy-mode-pill', { 'is-active': cfgComfyMode === 'gateway' }]" @click="cfgComfyMode = 'gateway'">{{ t('settings.cfg.comfyModeGateway') }}</button>
                  <button type="button" :class="['comfy-mode-pill', { 'is-active': cfgComfyMode === 'direct' }]" @click="cfgComfyMode = 'direct'">{{ t('settings.cfg.comfyModeDirect') }}</button>
                </div>
                <span class="field-hint">{{ t('settings.cfg.comfyModeHint') }}</span>
              </div>
              <template v-if="cfgComfyMode === 'gateway'">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.gatewayWorkflow') }} <span class="required">*</span></span>
                  <div class="gateway-workflow-row">
                    <BaseSelect v-model="cfgForm.provider_settings.workflow_slug" :options="gatewayWorkflowOptions" :placeholder="t('settings.cfg.gatewayWorkflowPlaceholder')" searchable />
                    <button type="button" class="btn btn-sm" :disabled="gwLoading" @click="loadGatewayWorkflows">
                      <Loader2 v-if="gwLoading" :size="12" class="animate-spin" />
                      {{ t('settings.cfg.gatewayLoadWorkflows') }}
                    </button>
                  </div>
                  <span v-if="gwError" class="field-hint gw-error">{{ gwError }}</span>
                  <span class="field-hint">{{ t('settings.cfg.gatewayWorkflowHint') }}</span>
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.gatewayAdminUrl') }}</span>
                  <div class="gateway-workflow-row">
                    <input v-model="gatewayAdminUrl" class="input mono" :placeholder="t('settings.cfg.gatewayAdminUrlPlaceholder')" />
                    <button type="button" class="btn btn-sm" @click="openGatewayAdmin">{{ t('settings.cfg.gatewayAdminOpen') }}</button>
                    <button type="button" class="btn btn-sm" @click="copyGatewayAdminUrl">{{ t('settings.cfg.gatewayAdminCopy') }}</button>
                  </div>
                  <span class="field-hint">{{ t('settings.cfg.gatewayAdminHint') }}</span>
                </label>
              </template>
              <template v-else>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.comfyWorkflow') }} <span class="required">*</span></span>
                  <textarea
                    v-model="cfgForm.provider_settings.workflow"
                    class="textarea mono cfg-workflow"
                    rows="8"
                    :placeholder="t('settings.cfg.comfyWorkflowPlaceholder')"
                  ></textarea>
                  <span class="field-hint">{{ t('settings.cfg.comfyWorkflowHint') }}</span>
                </label>
                <div class="cfg-setting-grid">
                  <label class="field">
                    <span class="field-label">{{ t('settings.cfg.outputNode') }}</span>
                    <input v-model="cfgForm.provider_settings.output_node" class="input mono" placeholder="9" />
                  </label>
                  <label class="field">
                    <span class="field-label">{{ t('settings.cfg.outputKey') }}</span>
                    <input v-model="cfgForm.provider_settings.output_key" class="input mono" placeholder="images" />
                  </label>
                </div>
                <span class="field-hint">{{ t('settings.cfg.outputNodeHint') }}</span>
              </template>
              <label class="field">
                <span class="field-label">{{ t('settings.cfg.negativePrompt') }}</span>
                <input v-model="cfgForm.provider_settings.negative_prompt" class="input" :placeholder="t('settings.cfg.negativePromptPlaceholder')" />
              </label>
              <div class="cfg-setting-grid">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.seed') }}</span>
                  <input v-model="cfgForm.provider_settings.seed" class="input" type="number" step="1" :placeholder="t('settings.cfg.seedPlaceholder')" />
                </label>
                <label v-if="cfgForm.service_type === 'video'" class="field">
                  <span class="field-label">{{ t('settings.cfg.fps') }}</span>
                  <input v-model="cfgForm.provider_settings.fps" class="input" type="number" min="1" max="120" step="1" placeholder="16" />
                </label>
              </div>
            </section>
          </template>
          <template v-else-if="cfgForm.service_type === 'video' && cfgForm.provider === 'minimax'">
            <section class="cfg-settings">
              <div class="cfg-settings-head">{{ t('settings.cfg.providerSettings') }}</div>
              <label class="field">
                <span class="field-label">{{ t('settings.cfg.h3Quality') }}</span>
                <BaseSelect v-model="cfgForm.provider_settings.quality" :options="h3QualityOptions" />
                <span class="field-hint">{{ t('settings.cfg.h3QualityHint') }}</span>
              </label>
              <label class="field cfg-check">
                <input v-model="cfgForm.provider_settings.h3_gateway" type="checkbox" />
                <span>{{ t('settings.cfg.h3Gateway') }}</span>
              </label>
              <span class="field-hint">{{ t('settings.cfg.h3GatewayHint') }}</span>
              <div class="cfg-setting-grid">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.negativePrompt') }}</span>
                  <input v-model="cfgForm.provider_settings.negative_prompt" class="input" :placeholder="t('settings.cfg.negativePromptPlaceholder')" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.seed') }}</span>
                  <input v-model="cfgForm.provider_settings.seed" class="input" type="number" step="1" :placeholder="t('settings.cfg.seedPlaceholder')" />
                </label>
              </div>
              <span class="field-hint">{{ t('settings.cfg.h3LocalOnlyHint') }}</span>
            </section>
          </template>
          <template v-else-if="cfgForm.service_type === 'image' && (cfgForm.provider === 'volcengine' || cfgForm.provider === 'aliyun')">
            <section class="cfg-settings">
              <div class="cfg-settings-head">{{ t('settings.cfg.providerSettings') }}</div>
              <div v-if="cfgForm.provider === 'volcengine'" class="cfg-setting-grid">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.outputFormat') }}</span>
                  <BaseSelect v-model="cfgForm.provider_settings.output_format" :options="imageFormatOptions" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.responseFormat') }}</span>
                  <BaseSelect v-model="cfgForm.provider_settings.response_format" :options="responseFormatOptions" />
                </label>
              </div>
              <label class="field">
                <span class="field-label">{{ t('settings.cfg.negativePrompt') }}</span>
                <input v-model="cfgForm.provider_settings.negative_prompt" class="input" :placeholder="t('settings.cfg.negativePromptPlaceholder')" />
              </label>
              <div class="cfg-setting-grid">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.seed') }}</span>
                  <input v-model="cfgForm.provider_settings.seed" class="input" type="number" step="1" :placeholder="t('settings.cfg.seedPlaceholder')" />
                </label>
                <label class="field cfg-check">
                  <input v-model="cfgForm.provider_settings.watermark" type="checkbox" />
                  <span>{{ t('settings.cfg.watermark') }}</span>
                </label>
              </div>
              <label v-if="cfgForm.provider === 'aliyun'" class="field cfg-check">
                <input v-model="cfgForm.provider_settings.prompt_extend" type="checkbox" />
                <span>{{ t('settings.cfg.promptExtend') }}</span>
              </label>
            </section>
          </template>
          <template v-else-if="cfgForm.service_type === 'audio' && cfgForm.provider !== 'qwen3-tts'">
            <section class="cfg-settings">
              <div class="cfg-settings-head">{{ t('settings.cfg.voiceSettings') }}</div>
              <label class="field">
                <span class="field-label">{{ t('settings.cfg.defaultVoice') }}</span>
                <input v-model="cfgForm.provider_settings.defaultVoiceId" class="input mono" placeholder="longxiaochun_v2" />
                <span class="field-hint">{{ t('settings.cfg.defaultVoiceHint') }}</span>
              </label>
              <div v-if="cfgForm.provider === 'volcengine'" class="cfg-setting-grid">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.resourceId') }}</span>
                  <input v-model="cfgForm.provider_settings.resourceId" class="input mono" placeholder="seed-tts-2.0" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.uid') }}</span>
                  <input v-model="cfgForm.provider_settings.uid" class="input mono" placeholder="huobao-drama" />
                </label>
              </div>
              <div v-if="cfgForm.provider === 'volcengine'" class="cfg-setting-grid">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.appId') }}</span>
                  <input v-model="cfgForm.provider_settings.appId" class="input mono" placeholder="1234567890" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.accessKey') }}</span>
                  <input v-model="cfgForm.provider_settings.accessKey" class="input mono" type="password" placeholder="Access Token" />
                </label>
              </div>
              <div class="cfg-setting-grid">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.audioFormat') }}</span>
                  <BaseSelect v-model="cfgForm.provider_settings.format" :options="audioFormatOptions" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.sampleRate') }}</span>
                  <input v-model="cfgForm.provider_settings.sampleRate" class="input" type="number" min="8000" step="1000" placeholder="24000" />
                </label>
              </div>
              <label class="field">
                <span class="field-label">{{ t('settings.cfg.emotion') }}</span>
                <input v-model="cfgForm.provider_settings.emotion" class="input" :placeholder="t('settings.cfg.emotionPlaceholder')" />
              </label>
              <span class="field-hint">{{ t('settings.cfg.resourceIdHint') }}</span>
              <span v-if="cfgForm.provider === 'volcengine'" class="field-hint">{{ t('settings.cfg.legacyAuthHint') }}</span>
            </section>
          </template>
          <template v-else-if="cfgForm.service_type === 'audio' && cfgForm.provider === 'qwen3-tts'">
            <section class="cfg-settings">
              <div class="cfg-settings-head">{{ t('settings.cfg.voiceSettings') }}</div>
              <div class="cfg-setting-grid">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.ttsTimeout') }}</span>
                  <input v-model="cfgForm.provider_settings.timeoutMs" class="input" type="number" min="1000" step="1000" placeholder="650000" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.ttsConcurrency') }}</span>
                  <input v-model="cfgForm.provider_settings.concurrency" class="input" type="number" min="1" max="8" step="1" placeholder="1" />
                </label>
              </div>
              <div class="cfg-setting-grid">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.ttsMaxInputChars') }}</span>
                  <input v-model="cfgForm.provider_settings.maxInputChars" class="input" type="number" min="1" step="1" placeholder="500" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.ttsMaxNewTokens') }}</span>
                  <input v-model="cfgForm.provider_settings.maxNewTokens" class="input" type="number" min="64" max="2048" step="1" placeholder="2048" />
                </label>
              </div>
              <label class="field">
                <span class="field-label">{{ t('settings.cfg.seed') }}</span>
                <input v-model="cfgForm.provider_settings.seed" class="input" type="number" step="1" placeholder="42" />
                <span class="field-hint">{{ t('settings.cfg.ttsSeedHint') }}</span>
              </label>
              <span class="field-hint">{{ t('settings.cfg.ttsTimeoutHint') }}</span>
              <span class="field-hint">{{ t('settings.cfg.ttsConcurrencyHint') }}</span>
              <span class="field-hint">{{ t('settings.cfg.ttsMaxInputCharsHint') }}</span>
              <span class="field-hint">{{ t('settings.cfg.ttsMaxNewTokensHint') }}</span>
              <span class="field-hint">{{ t('settings.cfg.qwen191Hint') }}</span>
            </section>
          </template>
          <label v-if="cfgForm.service_type === 'text'" class="field">
            <span class="field-label">Temperature <span class="dim">({{ t('settings.cfg.tempHint') }})</span></span>
            <input v-model="cfgForm.temperature" class="input" type="number" step="0.1" min="0" max="2" :placeholder="t('settings.cfg.tempPlaceholder')" />
            <span class="field-hint">{{ t('settings.cfg.tempNote') }}</span>
          </label>
          <div v-if="cfgTestResult" class="test-result" :class="{ ok: cfgTestResult.reachable, bad: !cfgTestResult.reachable }">
            <div class="test-result-head">
              <span class="tag" :class="cfgTestResult.reachable ? 'tag-success' : 'tag-error'">{{ cfgTestResult.status || 'ERROR' }}</span>
              <span>{{ cfgTestResult.message }}</span>
            </div>
            <div class="mono test-result-url">{{ cfgTestResult.method }} {{ cfgTestResult.url }}</div>
            <div v-if="cfgTestResult.response_preview" class="mono test-result-preview">{{ cfgTestResult.response_preview }}</div>
          </div>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn btn-ghost test-draft-btn" :disabled="cfgTesting" @click="testDraftCfg">
            <Loader2 v-if="cfgTesting" :size="12" class="animate-spin" />
            <span v-else>{{ t('settings.cfg.test') }}</span>
          </button>
          <button type="button" class="btn" @click="cfgDialog = false">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn btn-primary">{{ t('common.save') }}</button>
        </div>
      </form>
    </div>

    <!-- Add Skill Dialog -->
    <div v-if="addSkillDialog" class="overlay" @click.self="addSkillDialog = false">
      <form class="dialog skill-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-skill-title" @submit.prevent="confirmAddSkill" @keydown="onSettingsDialogKeydown">
        <div class="dialog-head">
          <div class="dialog-title" id="settings-skill-title">{{ t('settings.skills.addTitle', { agent: selectedAgentLabel }) }}</div>
        </div>
        <div class="dialog-body skill-dialog-body">
          <label class="field">
            <span class="field-label">{{ t('settings.skills.dirName') }} <span class="dim">({{ t('settings.skills.dirNameHint') }})</span></span>
            <input v-model="newSkillForm.id" class="input" :placeholder="t('settings.skills.dirNamePlaceholder')" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('settings.skills.name') }}</span>
            <input v-model="newSkillForm.name" class="input" :placeholder="t('settings.skills.namePlaceholder')" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('settings.skills.description') }}</span>
            <input v-model="newSkillForm.description" class="input" :placeholder="t('settings.skills.descPlaceholder')" />
          </label>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" @click="addSkillDialog = false">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="!newSkillForm.id">{{ t('settings.skills.create') }}</button>
        </div>
      </form>
    </div>

    <!-- Style Preset Dialog -->
    <div v-if="styleDialog" class="overlay" @click.self="styleDialog = false">
      <form class="dialog config-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-style-title" @submit.prevent="saveStyle" @keydown="onSettingsDialogKeydown">
        <div class="dialog-head">
          <div>
            <div class="dialog-title" id="settings-style-title">{{ styleEditId ? t('settings.styleDialog.editTitle') : t('settings.styleDialog.addTitle') }}</div>
            <div class="dialog-sub">{{ t('settings.styleDialog.sub') }}</div>
          </div>
          <span class="tag tag-accent ml-auto"><Palette :size="12" /> {{ t('settings.styleDialog.tag') }}</span>
        </div>
        <div class="dialog-body config-dialog-body">
          <label class="field">
            <span class="field-label">{{ t('settings.styleDialog.name') }} <span class="required">*</span></span>
            <input v-model="styleForm.name" class="input" :placeholder="t('settings.styleDialog.namePlaceholder')" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('settings.styleDialog.key') }} <span class="required">*</span></span>
            <input v-model="styleForm.value" class="input mono" :placeholder="t('settings.styleDialog.keyPlaceholder')" :disabled="!!styleEditId" />
            <span class="field-hint">{{ t('settings.styleDialog.keyHint') }}</span>
          </label>
          <label class="field">
            <span class="field-label">{{ t('settings.styleDialog.prompt') }} <span class="required">*</span></span>
            <textarea v-model="styleForm.prompt" class="textarea" rows="3" :placeholder="t('settings.styleDialog.promptPlaceholder')"></textarea>
          </label>
          <label class="field">
            <span class="field-label">{{ t('settings.styleDialog.description') }}</span>
            <input v-model="styleForm.description" class="input" :placeholder="t('settings.styleDialog.descPlaceholder')" />
          </label>
          <label class="field">
            <span class="field-label">{{ t('settings.styleDialog.sort') }}</span>
            <input v-model.number="styleForm.sort_order" class="input" type="number" min="0" max="999" />
          </label>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" @click="styleDialog = false">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn btn-primary">{{ t('common.save') }}</button>
        </div>
      </form>
    </div>
    <!-- 从参考图生成风格 -->
    <div v-if="styleRefDialog" class="overlay" @click.self="styleRefDialog = false">
      <div class="dialog config-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-style-ref-title" @keydown="onSettingsDialogKeydown">
        <div class="dialog-head">
          <div>
            <div class="dialog-title" id="settings-style-ref-title">{{ t('settings.styleRef.title') }}</div>
            <div class="dialog-sub">{{ t('settings.styleRef.sub') }}</div>
          </div>
          <span class="tag tag-accent ml-auto"><Sparkles :size="12" /> {{ t('settings.styleRef.tag') }}</span>
        </div>
        <div class="dialog-body config-dialog-body">
          <div class="style-ref-grid">
            <div v-for="(item, index) in styleRefImages" :key="item.path" class="style-ref-item">
              <img :src="item.url" alt="" />
              <button type="button" class="style-ref-remove" @click="removeStyleRefImage(index)"><X :size="10" /></button>
            </div>
            <button
              v-if="styleRefImages.length < 4"
              type="button"
              class="style-ref-add"
              :disabled="styleRefUploading"
              @click="pickStyleRefImages"
            >
              <Loader2 v-if="styleRefUploading" :size="15" class="animate-spin" />
              <Plus v-else :size="16" />
            </button>
          </div>
          <label v-if="styleRefTextOptions.length" class="field">
            <span class="field-label">{{ t('settings.styleRef.model') }}</span>
            <BaseSelect v-model="styleRefConfigId" :options="styleRefTextOptions" :placeholder="t('settings.styleRef.modelPlaceholder')" />
          </label>
          <p class="field-hint">{{ t('settings.styleRef.hint') }}</p>
        </div>
        <div class="dialog-foot">
          <button class="btn" @click="styleRefDialog = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" :disabled="styleRefAnalyzing || !styleRefImages.length" @click="analyzeStyleImages">
            <Loader2 v-if="styleRefAnalyzing" :size="12" class="animate-spin" />
            {{ styleRefAnalyzing ? t('settings.styleRef.analyzing') : t('settings.styleRef.analyze') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 迁移确认（自建 dialog：ConfirmDialog 的删除语义/Enter 快捷键不合此处） -->
    <div v-if="migrateDialog" class="overlay" @click.self="!migrating && (migrateDialog = false)">
      <form class="dialog migrate-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-migrate-title" @submit.prevent="startMigrate" @keydown="onSettingsDialogKeydown">
        <div class="dialog-head"><span class="dialog-title" id="settings-migrate-title">{{ t('settings.migrate.title') }}</span></div>
        <div class="dialog-body">
          <div class="field">
            <span class="field-label">{{ t('settings.migrate.newDir') }}</span>
            <div class="input mono" style="word-break: break-all">{{ migrateTarget }}</div>
          </div>
          <div class="field">
            <span class="field-label">{{ t('settings.migrate.dataToMove') }}</span>
            <div class="field-hint">
              {{ t('settings.migrate.sizeNote', { size: formatBytes(storageInfo?.usage?.total || 0) }) }}<template v-if="migrateTargetFree != null">{{ t('settings.migrate.freeNote', { size: formatBytes(migrateTargetFree) }) }}</template>
            </div>
          </div>
          <label class="field" style="display:flex; align-items:center; gap:8px; cursor:pointer">
            <input v-model="migrateFiles" type="checkbox" :disabled="migrating" />
            <span class="field-label" style="margin:0">{{ t('settings.migrate.moveFiles') }}</span>
          </label>
          <p v-if="!migrateFiles" class="field-hint migrate-warn">{{ t('settings.migrate.emptyWarn') }}</p>
          <p class="field-hint">{{ t('settings.migrate.note') }}</p>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" :disabled="migrating" @click="migrateDialog = false">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn btn-primary" :disabled="migrating">
            <Loader2 v-if="migrating" :size="12" class="animate-spin" />
            {{ t('settings.migrate.start') }}
          </button>
        </div>
      </form>
    </div>
    <ConfirmDialog
      :open="!!restoreTarget"
      :title="t('settings.storage.backups.restoreTitle')"
      :message="t('settings.storage.backups.restoreMessage', { name: restoreTarget?.name || '' })"
      :confirm-text="t('settings.storage.backups.restoreConfirm')"
      :loading-text="t('settings.storage.backups.restoring')"
      :loading="backupBusy"
      @cancel="restoreTarget = null"
      @confirm="confirmRestore"
    />
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="t('settings.storage.backups.deleteTitle')"
      :message="t('settings.storage.backups.deleteMessage', { name: deleteTarget?.name || '' })"
      :confirm-text="t('common.delete')"
      :loading-text="t('common.deleteLoading')"
      :loading="backupBusy"
      @cancel="deleteTarget = null"
      @confirm="confirmDeleteBackup"
    />
    <RemoteAccessDialog :open="remoteDialogOpen" :next="route.fullPath" @close="closeRemoteDialog" />
    <ConfirmDialog
      :open="!!remoteRevokeDevice"
      :title="t('remote.confirm.revokeTitle')"
      :message="t('remote.confirm.revokeMessage', { name: remoteRevokeDevice?.name || '' })"
      :loading="remoteRevokeLoading"
      @confirm="confirmRemoteRevoke"
      @cancel="remoteRevokeDevice = null"
    />
    <ConfirmDialog
      :open="remoteDisableConfirm"
      :title="t('remote.confirm.disableTitle')"
      :message="t('remote.confirm.disableMessage')"
      :loading="remoteState.disabling"
      @confirm="confirmRemoteDisable"
      @cancel="remoteDisableConfirm = false"
    />
    <ConfirmDialog
      :open="remoteRevokeAllConfirm"
      :title="t('remote.confirm.revokeAllTitle')"
      :message="t('remote.confirm.revokeAllMessage', { n: remoteRevokeAllCount })"
      :loading="remoteRevokeAllLoading"
      @confirm="confirmRemoteRevokeAll"
      @cancel="remoteRevokeAllConfirm = false"
    />
    <ConfirmDialog
      :open="!!styleToDelete"
      :title="t('settings.styleDelete.title')"
      :message="t('settings.styleDelete.message', { name: styleToDelete?.name })"
      :loading="deletingStyle"
      @confirm="confirmDelStyle"
      @cancel="styleToDelete = null"
    />
    <ConfirmDialog
      :open="!!skillToDelete"
      :title="t('settings.skillDelete.title')"
      :message="t('settings.skillDelete.message', { id: skillToDelete })"
      :loading="deletingSkill"
      @confirm="confirmDelSkill"
      @cancel="skillToDelete = null"
    />
    <ConfirmDialog
      :open="!!bgmToDelete"
      :title="t('settings.dubbing.bgmDeleteTitle')"
      :message="t('settings.dubbing.bgmDeleteMessage', { name: bgmToDelete?.name })"
      :loading="bgmDeleting"
      @confirm="confirmDeleteBgm"
      @cancel="bgmToDelete = null"
    />
    <ConfirmDialog
      :open="!!breakdownToDelete"
      :title="t('settings.breakdown.deleteTitle')"
      :message="`${t('settings.breakdown.deleteMessage', { name: breakdownToDelete?.name })} ${t('settings.breakdown.deleteUsage', { count: breakdownToDelete?.usage_count || 0 })}`"
      :loading="breakdownDeleting"
      @confirm="confirmDeleteBreakdownMethod"
      @cancel="breakdownToDelete = null"
    />
  </div>
</template>

<script setup>
import { Plus, Pencil, Trash2, FileText, ChevronDown, Check, Loader2, Bot, Cpu, Sparkles, Palette, ExternalLink, Star, HardDrive, Database, RefreshCw, Download, Languages, SunMoon, X, Plug, KeyRound, Copy, ListOrdered, Mic, Music, BookOpen, Layers, ShieldCheck, MonitorSmartphone, TriangleAlert, Smartphone, QrCode } from 'lucide-vue-next'
import BaseSelect from '~/components/BaseSelect.vue'
import QueuePanel from '~/components/QueuePanel.vue'
import RemoteAccessDialog from '~/components/RemoteAccessDialog.vue'
import RemoteDeviceList from '~/components/RemoteDeviceList.vue'
import { toast } from 'vue-sonner'
import { toastError } from '~/composables/useToast'
import { useI18n } from 'vue-i18n'
import { aiConfigAPI, promptAPI, skillsAPI, storageAPI, backupAPI, stylePresetAPI, settingsAPI, serverUpdateAPI, mcpAPI, uploadAPI, pipelineRuleAPI, breakdownMethodAPI, dubbingAPI, bgmAPI, api } from '~/composables/useApi'
import { useRemoteRole, remoteErrorMessage, logoutRemoteSession } from '~/composables/useRemoteGuest'
import { useRemotePairing } from '~/composables/useRemotePairing'
import { presenceState, refreshPresenceEntries, safePresenceRelayPath } from '~/composables/usePresence'
import { useDesktopBridge } from '~/composables/useDesktopBridge'
import { isAppClient, useAppBridge } from '~/composables/useAppBridge'
import MediaCapabilityNotice from '~/components/MediaCapabilityNotice.vue'
import { useMediaCapabilities } from '~/composables/useMediaCapabilities'
import { useMigrateState } from '~/composables/useMigrateState'
import { useTheme } from '~/composables/useTheme'
import { useViewport } from '~/composables/useViewport'
import { useOverlayHistory } from '~/composables/useOverlayHistory'
import { useVisibilityPolling } from '~/composables/useVisibilityPolling'
import { providerIconUrl } from '~/composables/useProviderIcon'
import { startTour, autoTour } from '~/composables/useTour'
import { confirmUnifiedLanguage } from '~/composables/useUnifiedLanguage'

const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()

const remoteRole = useRemoteRole()
const isGuest = computed(() => remoteRole.role === 'guest')
const remoteReadonly = computed(() => remoteRole.role === 'guest' && remoteRole.readonly)
const isAppMode = isAppClient()
const GUEST_HIDDEN_TABS = new Set(['ai', 'storage', 'mcp', 'agents', 'remote'])
const APP_HIDDEN_TABS = new Set(['remote', 'mcp'])

function tabAllowed(id) {
  if (id === 'device') return isAppMode || isGuest.value
  if (isGuest.value && GUEST_HIDDEN_TABS.has(id)) return false
  if (isAppMode && APP_HIDDEN_TABS.has(id)) return false
  return true
}

const SETTINGS_TABS = ['device', 'ai', 'dubbing', 'novel', 'general', 'remote', 'styles', 'rules', 'breakdown', 'audit', 'agents', 'queue', 'storage', 'mcp', 'about']
const requestedTab = typeof route.query.tab === 'string' ? route.query.tab : ''
const showBrandImage = ref(true)
function initialTab() {
  if (SETTINGS_TABS.includes(requestedTab) && tabAllowed(requestedTab)) return requestedTab
  if (isAppMode) return 'device'
  return isGuest.value ? 'dubbing' : 'ai'
}
const tab = ref(initialTab())
watch(tab, (value) => {
  if (route.query.tab !== value) router.replace({ query: { ...route.query, tab: value } })
  if (value === 'device') void loadDeviceInfo()
})
watch(() => route.query.tab, (value) => {
  const next = typeof value === 'string' ? value : ''
  if (SETTINGS_TABS.includes(next) && tabAllowed(next) && next !== tab.value) tab.value = next
})
const baseTabs = computed(() => {
  const tabs = [
    { id: 'device', label: t('settings.tabs.device'), icon: Smartphone },
    { id: 'ai', label: t('settings.tabs.ai'), icon: Cpu },
    { id: 'dubbing', label: t('settings.tabs.dubbing'), icon: Mic },
    { id: 'novel', label: t('settings.tabs.novel'), icon: BookOpen },
    { id: 'general', label: t('settings.tabs.general'), icon: Languages },
    { id: 'remote', label: t('settings.tabs.remote'), icon: MonitorSmartphone },
    { id: 'styles', label: t('settings.tabs.styles'), icon: Palette },
    { id: 'rules', label: t('settings.tabs.rules'), icon: FileText },
    { id: 'breakdown', label: t('settings.tabs.breakdown'), icon: Layers },
    { id: 'audit', label: t('settings.tabs.audit'), icon: ShieldCheck },
    { id: 'agents', label: t('settings.tabs.agents'), icon: Bot },
    { id: 'queue', label: t('settings.tabs.queue'), icon: ListOrdered },
    { id: 'storage', label: t('settings.tabs.storage'), icon: HardDrive },
    { id: 'mcp', label: t('settings.tabs.mcp'), icon: Plug },
    { id: 'about', label: t('settings.tabs.about'), icon: RefreshCw },
  ]
  return tabs.filter(item => tabAllowed(item.id))
})
// 深链或角色变化后回到第一个可见页签，URL 不保留隐藏页签
watch([() => remoteRole.ready, isGuest], () => {
  if (!remoteRole.ready) return
  if (baseTabs.value.some(item => item.id === tab.value)) return
  tab.value = baseTabs.value[0]?.id || 'general'
}, { immediate: true })

// ===== 本机与连接（应用模式 / 访客） =====
const deviceConnected = computed(() => remoteRole.role === 'guest' && remoteRole.paired)
const deviceHostName = computed(() => remoteRole.serverName || t('settings.device.connection.unknownHost'))
const deviceExpiryLabel = computed(() => remoteRole.expiresAt ? new Date(remoteRole.expiresAt).toLocaleString() : '—')
const deviceDisconnectConfirm = ref(false)
const deviceDisconnecting = ref(false)
const deviceLogsBusy = ref(false)
const deviceVersion = ref('')

async function loadDeviceInfo() {
  if (!isAppMode || deviceVersion.value) return
  try {
    const health = await api.get('/health')
    deviceVersion.value = health?.version || ''
  } catch { /* 版本读取失败不阻塞连接分区 */ }
}

function connectToComputer() {
  if (!appBridge) {
    toast.warning(t('settings.device.connection.scanUnavailable'))
    return
  }
  appBridge.openScanner()
}

function returnToLocalDevice() {
  if (!appBridge) {
    toast.warning(t('settings.device.connection.localUnavailable'))
    return
  }
  appBridge.backToLocal()
}

async function confirmDisconnectDevice() {
  if (deviceDisconnecting.value) return
  deviceDisconnecting.value = true
  try {
    await logoutRemoteSession()
    deviceDisconnectConfirm.value = false
    if (appBridge) appBridge.backToLocal()
    else await router.push('/pair')
  } catch (e) {
    toastError(e, { fallback: 'settings.device.connection.disconnectFailed' })
  } finally {
    deviceDisconnecting.value = false
  }
}

async function exportDeviceLogs() {
  if (deviceLogsBusy.value) return
  if (!appBridge?.exportLogs) {
    toast.warning(t('settings.device.logs.unavailable'))
    return
  }
  deviceLogsBusy.value = true
  try {
    const result = await appBridge.exportLogs()
    if (result?.ok) toast.success(t('settings.device.logs.exported'))
    else toast.error(result?.error || t('settings.device.logs.failed'))
  } catch (e) {
    toastError(e, { fallback: 'settings.device.logs.failed' })
  } finally {
    deviceLogsBusy.value = false
  }
}

// ===== 手机接力（仅主机可见） =====
const {
  state: remoteState,
  refreshStatus: refreshRemoteStatus,
  enableBridge: enableRemoteBridge,
  disableBridge: disableRemoteBridge,
  updateSettings: updateRemoteSettings,
  revokeDevice: revokeRemoteDevice,
  revokeAllDevices: revokeAllRemoteDevices,
} = useRemotePairing()

const remoteForm = reactive({ deviceName: '', port: 5680, sessionDays: 30, bindAddress: '' })
const remoteDialogOpen = ref(false)
const remoteDisableConfirm = ref(false)
const remoteRevokeDevice = ref(null)
const remoteRevokeLoading = ref(false)
const remoteRevokeAllConfirm = ref(false)
const remoteRevokeAllLoading = ref(false)
const remoteSessionDayOptions = [7, 30, 90]

const remoteRunning = computed(() => remoteState.status?.running === true)
const remoteDevices = computed(() => remoteState.status?.devices ?? [])
const remoteRevokeAllCount = computed(() => remoteDevices.value.filter(device => device.status === 'active').length)
const remoteStatusKey = computed(() => {
  if (!remoteState.ready && !remoteState.status) return 'loading'
  if (remoteState.enabling) return 'enabling'
  if (remoteState.disabling) return 'disabling'
  if (remoteState.status?.state === 'error') return 'error'
  return remoteRunning.value ? 'running' : 'disabled'
})
const remoteStatusLabel = computed(() => t(`remote.dialog.status.${remoteStatusKey.value}`))
const remoteAddressOptions = computed(() => {
  const list = [...(remoteState.status?.addresses ?? [])]
  const current = remoteForm.bindAddress || remoteState.status?.bindAddress || ''
  if (current && !list.includes(current)) list.unshift(current)
  return list
})

function syncRemoteForm() {
  const current = remoteState.status
  if (!current) return
  remoteForm.deviceName = current.deviceName
  remoteForm.port = current.port
  remoteForm.sessionDays = current.sessionDays
  remoteForm.bindAddress = current.bindAddress || current.addresses[0] || ''
}

function notifyRemoteError() {
  if (!remoteState.actionError) return
  toast.error(remoteErrorMessage(remoteState.actionError))
}

async function loadRemoteTab() {
  if (isGuest.value || isAppMode) return
  await refreshRemoteStatus()
  if (isGuest.value) return
  syncRemoteForm()
  void refreshPresenceEntries()
}

async function enableRemoteTab() {
  const address = remoteForm.bindAddress || remoteState.status?.addresses[0] || ''
  const ok = await enableRemoteBridge(address || undefined)
  if (!ok) {
    notifyRemoteError()
    return
  }
  syncRemoteForm()
  toast.success(t('remote.dialog.actionDone'))
}

function openRemoteDialog() {
  remoteDialogOpen.value = true
}

function closeRemoteDialog() {
  remoteDialogOpen.value = false
  void loadRemoteTab()
}

async function saveRemoteTabSettings() {
  const deviceName = remoteForm.deviceName.trim()
  if (!deviceName) {
    toast.error(t('remote.dialog.deviceNameRequired'))
    return
  }
  const ok = await updateRemoteSettings({
    deviceName,
    port: Number(remoteForm.port),
    sessionDays: remoteForm.sessionDays,
  })
  if (!ok) {
    notifyRemoteError()
    return
  }
  syncRemoteForm()
  toast.success(t('remote.dialog.saved'))
}

function askRemoteRevoke(device) {
  remoteRevokeDevice.value = device
}

async function confirmRemoteRevoke() {
  const device = remoteRevokeDevice.value
  if (!device || remoteRevokeLoading.value) return
  remoteRevokeLoading.value = true
  try {
    const ok = await revokeRemoteDevice(device.id)
    if (ok) toast.success(t('remote.dialog.actionDone'))
    else notifyRemoteError()
  } finally {
    remoteRevokeLoading.value = false
    remoteRevokeDevice.value = null
  }
}

async function confirmRemoteRevokeAll() {
  if (remoteRevokeAllLoading.value) return
  remoteRevokeAllLoading.value = true
  try {
    const ok = await revokeAllRemoteDevices()
    if (ok) toast.success(t('remote.dialog.actionDone'))
    else notifyRemoteError()
  } finally {
    remoteRevokeAllLoading.value = false
    remoteRevokeAllConfirm.value = false
  }
}

async function confirmRemoteDisable() {
  const ok = await disableRemoteBridge()
  remoteDisableConfirm.value = false
  if (ok) toast.success(t('remote.dialog.actionDone'))
  else notifyRemoteError()
}

/** 反向接力：电脑端跳到手机当前所在页面；只接受站内路径 */
function relayRemoteDevice(path) {
  const safe = safePresenceRelayPath(path)
  if (!safe) {
    toast.error(t('remote.errors.badPath'))
    return
  }
  void router.push(safe)
}

// ===== MCP 服务 =====
const mcpStatus = ref({ enabled: false, running: false, port: 5780, url: '', token: '', tool_count: 0, tools: [], error: null })
const mcpPort = ref(5780)
const mcpBusy = ref(false)

const mcpConfigText = computed(() => JSON.stringify({
  mcpServers: {
    'huobao-drama': {
      type: 'http',
      url: mcpStatus.value.url || 'http://127.0.0.1:5780/mcp',
      headers: { Authorization: `Bearer ${mcpStatus.value.token || '<token>'}` },
    },
  },
}, null, 2))

async function loadMcp() {
  try {
    const s = await mcpAPI.status()
    if (s) {
      mcpStatus.value = s
      mcpPort.value = s.port || 5780
    }
  } catch (e) {
    toastError(e)
  }
}

async function applyMcp(patch) {
  mcpBusy.value = true
  try {
    const s = await mcpAPI.update(patch)
    if (s) {
      mcpStatus.value = s
      mcpPort.value = s.port || 5780
    }
    toast.success(t('settings.mcp.saved'))
  } catch (e) {
    toastError(e)
    await loadMcp()
  } finally {
    mcpBusy.value = false
  }
}

function toggleMcp(event) {
  applyMcp({ enabled: Boolean(event?.target?.checked) })
}

function saveMcpPort() {
  const port = Number(mcpPort.value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    toast.error(t('settings.mcp.badPort'))
    mcpPort.value = mcpStatus.value.port || 5780
    return
  }
  if (port === mcpStatus.value.port) return
  applyMcp({ port })
}

async function rotateMcpToken() {
  mcpBusy.value = true
  try {
    const s = await mcpAPI.rotateToken()
    if (s) mcpStatus.value = s
    toast.success(t('settings.mcp.regenerated'))
  } catch (e) {
    toastError(e)
  } finally {
    mcpBusy.value = false
  }
}

async function copyText(text, messageKey) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t(messageKey))
  } catch {
    toast.error(t('settings.mcp.copyFailed'))
  }
}

function copyMcpToken() {
  if (!mcpStatus.value.token) return
  copyText(mcpStatus.value.token, 'settings.mcp.copied')
}

function copyMcpConfig() {
  copyText(mcpConfigText.value, 'settings.mcp.copied')
}

// ===== AI Service Configs =====
const cfgs = ref([])
const cfgDialog = ref(false)
const cfgEditId = ref(null)
const cfgTesting = ref(false)
const cfgTestResult = ref(null)
const huobaoApiKey = ref('')
const huobaoSaving = ref(false)
// 火宝节点选择：默认跟随界面语言（中文→国内 .cn，其他→国外 .com），一键配置与取 Key 链接共用
const huobaoRegion = ref(locale.value?.startsWith('zh') ? 'cn' : 'com')
const huobaoSiteUrl = computed(() => `https://api.firemux.${huobaoRegion.value}`)
const cfgForm = reactive({
  name: '', provider: '', api_key: '', base_url: '', models: [], service_type: 'text', priority: 0, temperature: '',
  provider_settings: emptyProviderSettings(),
})
const cfgOriginalSettings = ref({})
// ComfyUI 连接方式：网关（推荐，工作流保存在网关管理端）或直连（旧版工作流 JSON）
const cfgComfyMode = ref('gateway')
const gwWorkflows = ref([])
const gwLoading = ref(false)
const gwError = ref('')
// 管理端网页地址只存本机 localStorage（不入库）：管理端仅服务器 127.0.0.1:8193 可达，需 SSH 隧道
const gatewayAdminUrl = ref(localStorage.getItem('huobao.gatewayAdminUrl') || '')
watch(gatewayAdminUrl, (value) => {
  localStorage.setItem('huobao.gatewayAdminUrl', value)
})
function openGatewayAdmin() {
  const url = gatewayAdminUrl.value.trim()
  if (!url) {
    toast.warning(t('settings.cfg.gatewayAdminUrlRequired'))
    return
  }
  window.open(url, '_blank', 'noopener')
}
function copyGatewayAdminUrl() {
  if (!gatewayAdminUrl.value.trim()) {
    toast.warning(t('settings.cfg.gatewayAdminUrlRequired'))
    return
  }
  copyText(gatewayAdminUrl.value.trim(), 'settings.cfg.gatewayAdminCopied')
}
const gatewayWorkflowOptions = computed(() => gwWorkflows.value.map(item => ({
  label: item.name ? `${item.name} · ${item.slug}` : item.slug,
  value: item.slug,
})))
async function loadGatewayWorkflows(options = {}) {
  const baseUrl = String(cfgForm.base_url || '').trim()
  if (!baseUrl) {
    if (!options?.quiet) toast.warning(t('settings.cfg.gatewayUrlRequired'))
    return
  }
  gwLoading.value = true
  gwError.value = ''
  try {
    const kind = cfgForm.service_type === 'audio-gen' ? 'audio' : cfgForm.service_type
    const result = await aiConfigAPI.comfyWorkflows({ base_url: baseUrl, api_key: cfgForm.api_key, kind })
    const workflows = Array.isArray(result) ? result : (Array.isArray(result?.workflows) ? result.workflows : [])
    gwWorkflows.value = workflows
    if (!gwWorkflows.value.length) {
      gwError.value = t('settings.cfg.gatewayWorkflowsEmpty')
      return
    }
    const current = cfgForm.provider_settings.workflow_slug
    if (!current || !gwWorkflows.value.some(item => item.slug === current)) {
      cfgForm.provider_settings.workflow_slug = gwWorkflows.value[0].slug
    }
  } catch (error) {
    gwError.value = error?.message || t('settings.cfg.gatewayWorkflowsFailed')
    if (!options?.quiet) toastError(error)
  } finally {
    gwLoading.value = false
  }
}
/** 表单可编辑的 provider 专属字段；保存时只覆盖这些键，保留后端写入的其它字段 */
const CFG_SETTING_KEYS = computed(() => {
  const type = cfgForm.service_type
  const provider = cfgForm.provider
  if (type === 'audio') {
    if (provider === 'qwen3-tts') return ['timeoutMs', 'concurrency', 'maxInputChars', 'seed', 'maxNewTokens']
    if (provider === 'volcengine') return ['defaultVoiceId', 'resourceId', 'uid', 'appId', 'accessKey', 'format', 'sampleRate', 'emotion']
    return ['defaultVoiceId', 'format', 'sampleRate', 'emotion']
  }
  if (type === 'audio-gen') {
    if (provider === 'comfyui' && cfgComfyMode.value === 'gateway') {
      return ['workflow_slug', 'negative_prompt', 'seed', 'timeout_ms', 'normalize_loudness', 'model_license']
    }
    return ['workflow', 'output_node', 'output_key', 'negative_prompt', 'seed', 'timeout_ms', 'normalize_loudness', 'model_license']
  }
  if (provider === 'comfyui') {
    if (cfgComfyMode.value === 'gateway') {
      return type === 'video'
        ? ['workflow_slug', 'negative_prompt', 'seed', 'fps', 'client_id']
        : ['workflow_slug', 'negative_prompt', 'seed']
    }
    return type === 'video'
      ? ['workflow', 'output_node', 'output_key', 'negative_prompt', 'seed', 'fps', 'client_id']
      : ['workflow', 'output_node', 'output_key', 'negative_prompt', 'seed']
  }
  if (type === 'image' && provider === 'aliyun') return ['prompt_extend', 'watermark', 'negative_prompt', 'seed']
  if (type === 'image' && provider === 'volcengine') return ['output_format', 'response_format', 'watermark', 'seed']
  if (type === 'video' && provider === 'minimax') return ['quality', 'negative_prompt', 'seed', 'h3_gateway']
  return []
})
// 模型标签编辑器：首位即默认模型；输入框支持回车添加、逗号/换行批量粘贴
const modelInput = ref('')
function addModel() {
  const names = modelInput.value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean)
  for (const n of names) if (!cfgForm.models.includes(n)) cfgForm.models.push(n)
  modelInput.value = ''
}
function onModelPaste(e) {
  const text = e.clipboardData?.getData('text') || ''
  if (!/[,，\n]/.test(text)) return // 单模型走默认粘贴
  e.preventDefault()
  for (const n of text.split(/[,，\n]/).map(s => s.trim()).filter(Boolean)) {
    if (!cfgForm.models.includes(n)) cfgForm.models.push(n)
  }
}
function removeModel(i) { cfgForm.models.splice(i, 1) }
function pinModelTop(i) {
  if (i <= 0) return
  const [m] = cfgForm.models.splice(i, 1)
  cfgForm.models.unshift(m)
}
// 服务类型 label/desc 渲染时求值（语言切换即时生效），type 为逻辑值
const serviceTypes = computed(() => [
  { type: 'text', label: t('common.serviceType.text') },
  { type: 'image', label: t('common.serviceType.image') },
  { type: 'video', label: t('common.serviceType.video') },
  { type: 'audio', label: t('common.serviceType.audio') },
  { type: 'audio-gen', label: t('common.serviceType.audioGen') },
])
const providers = ['gemini', 'openai', 'volcengine', 'minimax', 'aliyun', 'qwen3-tts', 'openai-compatible', 'comfyui']
const providerSelectOptions = computed(() => providers.map(p => ({ label: p, value: p })))
const imageFormatOptions = [
  { label: 'JPEG', value: 'jpeg' },
  { label: 'PNG', value: 'png' },
]
const responseFormatOptions = [
  { label: 'URL', value: 'url' },
  { label: 'Base64', value: 'b64_json' },
]
const h3QualityOptions = computed(() => [
  { label: t('settings.cfg.h3QualityPreview'), value: 'preview' },
  { label: t('settings.cfg.h3QualityFinal'), value: 'final' },
])
const audioFormatOptions = [
  { label: 'WAV', value: 'wav' },
  { label: 'MP3', value: 'mp3' },
]
const serviceMeta = computed(() => ({
  text: { label: t('common.serviceType.text'), desc: t('settings.ai.meta.text') },
  image: { label: t('common.serviceType.image'), desc: t('settings.ai.meta.image') },
  video: { label: t('common.serviceType.video'), desc: t('settings.ai.meta.video') },
  audio: { label: t('common.serviceType.audio'), desc: t('settings.ai.meta.audio') },
  'audio-gen': { label: t('common.serviceType.audioGen'), desc: t('settings.ai.meta.audioGen') },
}))
function emptyProviderSettings() {
  return {
    // 云语音 / OpenAI 兼容语音
    defaultVoiceId: '',
    resourceId: 'seed-tts-2.0',
    uid: 'huobao-drama',
    appId: '',
    accessKey: '',
    format: 'wav',
    sampleRate: 24000,
    emotion: '',
    // Qwen3-TTS 本地服务（含 191 节点）
    timeoutMs: '',
    concurrency: '',
    maxInputChars: '',
    maxNewTokens: '',
    // ComfyUI 本地工作流
    workflow: '',
    workflow_slug: '',
    output_node: '',
    output_key: '',
    negative_prompt: '',
    seed: '',
    fps: '',
    client_id: 'huobao-drama',
    // ComfyUI 音频生成
    timeout_ms: '',
    normalize_loudness: true,
    model_license: '',
    // 图片厂商参数
    prompt_extend: true,
    watermark: false,
    output_format: 'jpeg',
    response_format: 'url',
    // 本地 H3 质量档 / 自建网关标识
    quality: 'preview',
    h3_gateway: false,
  }
}

/** 保存时收集 provider 专属设置：先保留未知键，再覆盖当前表单管理的键 */
function collectProviderSettings() {
  const outgoing = { ...cfgOriginalSettings.value }
  const form = cfgForm.provider_settings || {}
  for (const key of CFG_SETTING_KEYS.value) delete outgoing[key]
  // 切换连接方式时清掉另一模式的遗留键，避免网关配置残留旧 JSON / 直连配置残留 slug
  if (cfgForm.provider === 'comfyui' && ['image', 'video', 'audio-gen'].includes(cfgForm.service_type)) {
    const staleKeys = cfgComfyMode.value === 'gateway'
      ? ['workflow', 'output_node', 'output_key']
      : ['workflow_slug']
    for (const key of staleKeys) delete outgoing[key]
    if (cfgComfyMode.value === 'gateway' && !String(form.workflow_slug || '').trim()) {
      throw new Error(t('settings.cfg.gatewayWorkflowRequired'))
    }
  }
  for (const key of CFG_SETTING_KEYS.value) {
    const value = form[key]
    if (typeof value === 'boolean') {
      outgoing[key] = value
      continue
    }
    if (['seed', 'fps', 'sampleRate', 'timeoutMs', 'concurrency', 'maxInputChars', 'maxNewTokens', 'timeout_ms'].includes(key)) {
      if (value === '' || value === null || value === undefined) continue
      const n = Number(value)
      if (!Number.isFinite(n)) throw new Error(t('settings.cfg.numberInvalid'))
      if (key === 'seed' && !Number.isInteger(n)) throw new Error(t('settings.cfg.seedInvalid'))
      if (key === 'fps' && n <= 0) throw new Error(t('settings.cfg.fpsInvalid'))
      if (key === 'sampleRate' && (!Number.isInteger(n) || n <= 0)) throw new Error(t('settings.cfg.sampleRateInvalid'))
      if (key === 'timeoutMs' && (!Number.isInteger(n) || n <= 0)) throw new Error(t('settings.cfg.numberInvalid'))
      if (key === 'concurrency' && (!Number.isInteger(n) || n < 1 || n > 8)) throw new Error(t('settings.cfg.numberInvalid'))
      if (key === 'maxInputChars' && (!Number.isInteger(n) || n <= 0)) throw new Error(t('settings.cfg.numberInvalid'))
      if (key === 'maxNewTokens' && (!Number.isInteger(n) || n < 64 || n > 2048)) throw new Error(t('settings.cfg.numberInvalid'))
      if (key === 'timeout_ms' && (!Number.isInteger(n) || n <= 0)) throw new Error(t('settings.cfg.numberInvalid'))
      outgoing[key] = n
      continue
    }
    if (key === 'workflow') {
      const text = String(value ?? '').trim()
      if (!text) throw new Error(t('settings.cfg.workflowRequired'))
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(t('settings.cfg.workflowInvalid'))
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(t('settings.cfg.workflowInvalid'))
      }
      outgoing[key] = text
      continue
    }
    if (typeof value === 'string' && value.trim()) outgoing[key] = value.trim()
  }
  return outgoing
}

const providerPresets = {
  text: {
    gemini: { label: 'Gemini 官方', baseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'] },
    openai: { label: 'OpenAI 官方', baseUrl: 'https://api.openai.com', models: ['deepseek-v4-pro', 'gpt-5.6-terra'] },
  },
  image: {
    gemini: { label: 'Gemini 官方', baseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-3-pro-image', 'gemini-3.1-flash-image'] },
    openai: { label: 'OpenAI 官方', baseUrl: 'https://api.openai.com', models: ['gpt-image-2'] },
    volcengine: { label: '火山方舟 Seedream', baseUrl: 'https://ark.cn-beijing.volces.com', models: ['doubao-seedream-4-0-250828', 'doubao-seedream-3-0-t2i-250415'] },
    aliyun: { label: '阿里云百炼 Qwen-Image', baseUrl: 'https://dashscope.aliyuncs.com', models: ['qwen-image', 'qwen-image-edit', 'wan2.5-t2i-preview'] },
    comfyui: { label: 'ComfyUI 本地工作流', baseUrl: 'http://127.0.0.1:8188', models: ['comfyui-image'] },
  },
  video: {
    aliyun: { label: '阿里云百炼 Wan', baseUrl: 'https://dashscope.aliyuncs.com', models: ['wan3.0-video', 'wan3.0-video-prime', 'wan2.5-t2v-preview', 'wan2.2-t2v-plus', 'wan2.2-i2v-plus'] },
    volcengine: { label: '火山方舟 Seedance', baseUrl: 'https://ark.cn-beijing.volces.com', models: ['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-260128', 'doubao-seedance-1-0-pro-250528', 'doubao-seedance-1-0-lite-t2v-250428', 'doubao-seedance-1-0-lite-i2v-250428'] },
    minimax: { label: 'MiniMax H3 官方', baseUrl: 'https://api.minimaxi.com', models: ['MiniMax-H3'] },
    comfyui: { label: 'ComfyUI 本地工作流', baseUrl: 'http://127.0.0.1:8188', models: ['comfyui-video'] },
  },
  // 云语音与本地 OpenAI 兼容语音；音色 ID 在音色档案或配置默认音色里填写
  audio: {
    'qwen3-tts': { label: 'Qwen3-TTS 本地服务', baseUrl: 'http://127.0.0.1:18190', models: ['qwen3-tts-customvoice', 'qwen3-tts-voicedesign', 'qwen3-tts-base', 'Qwen3-TTS-12Hz-1.7B-VoiceDesign', 'Qwen3-TTS-12Hz-1.7B-Base', 'Qwen3-TTS-12Hz-0.6B-Base'] },
    aliyun: { label: '阿里云百炼语音', baseUrl: 'https://dashscope.aliyuncs.com', models: ['cosyvoice-v2', 'qwen-tts'] },
    volcengine: { label: '豆包语音合成 v3', baseUrl: 'https://openspeech.bytedance.com', models: ['seed-tts-2.0'] },
    'openai-compatible': { label: '本地 OpenAI 兼容语音', baseUrl: 'http://127.0.0.1:8000', models: ['tts-1'] },
  },
  'audio-gen': {
    comfyui: { label: 'ComfyUI 本地音频工作流', baseUrl: 'http://127.0.0.1:8188', models: ['stable-audio-open-1.0'] },
  },
}
const huobaoQuickConfigs = computed(() => {
  const base = huobaoSiteUrl.value
  return [
    { service_type: 'text', provider: 'gemini', name: '火宝文本服务 · Gemini', base_url: base, model: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview'], priority: 101 },
    { service_type: 'text', provider: 'openai', name: '火宝文本服务 · OpenAI', base_url: base, model: ['deepseek-v4-pro', 'deepseek-v4-flash', 'gpt-5.6-terra'], priority: 100 },
    { service_type: 'image', provider: 'openai', name: '火宝图片服务 · OpenAI', base_url: base, model: ['gpt-image-2'], priority: 99 },
    { service_type: 'image', provider: 'gemini', name: '火宝图片服务 · Gemini', base_url: base, model: ['gemini-3-pro-image', 'gemini-3.1-flash-image'], priority: 97 },
    { service_type: 'video', provider: 'aliyun', name: '火宝视频服务 · Wan 3.0', base_url: `${base}/qwen`, model: ['wan3.0-video', 'wan3.0-video-prime'], priority: 97 },
    { service_type: 'video', provider: 'volcengine', name: '火宝视频服务 · Seedance', base_url: `${base}/volcengine`, model: ['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-260128'], priority: 96 },
    { service_type: 'video', provider: 'minimax', name: '火宝视频服务 · MiniMax', base_url: `${base}/minimax`, model: ['MiniMax-H3'], priority: 98 },
  ]
})

function byType(t) { return cfgs.value.filter(c => c.service_type === t) }
function countActive(t) { return byType(t).filter(c => c.is_active).length }
function fmtModel(m) { return Array.isArray(m) ? m.join(', ') : m || '—' }
function presetsByType(type) {
  const group = providerPresets[type] || {}
  return Object.entries(group).map(([provider, preset]) => ({ provider, ...preset }))
}
function applyProviderPreset(type, provider) {
  const preset = providerPresets[type]?.[provider]
  if (!preset) return
  const providerChanged = cfgForm.provider !== provider
  cfgForm.provider = provider
  cfgForm.base_url = preset.baseUrl
  cfgForm.models = [...preset.models]
  if (providerChanged) cfgForm.provider_settings = emptyProviderSettings()
  if (provider === 'comfyui') {
    cfgComfyMode.value = 'gateway'
    gwWorkflows.value = []
    gwError.value = ''
  }
  // 配置名持久化进 DB：用 provider 英文 + 服务类型英文标识拼，不随界面语言漂移
  cfgForm.name = `${preset.label}-${type}`
}

async function loadCfgs() { try { cfgs.value = await aiConfigAPI.list() } catch (e) { toastError(e) } }

// ===== 默认模型选择 =====
// 默认解析规则与工作台/后端一致：启用配置中优先级最高者的模型列表首位
function defaultModelOf(type) {
  const active = cfgs.value.filter(c => c.service_type === type && c.is_active)
  if (!active.length) return null
  const top = [...active].sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]
  const first = Array.isArray(top.model) ? top.model[0] : null
  return first ? { configId: top.id, model: first } : null
}
function isDefaultModel(type, c, m) {
  const d = defaultModelOf(type)
  return !!d && d.configId === c.id && d.model === m
}
const defaultSaving = ref(false)
async function setDefaultModel(type, c, m) {
  if (defaultSaving.value || isDefaultModel(type, c, m)) return
  defaultSaving.value = true
  try {
    const models = [m, ...(Array.isArray(c.model) ? c.model : []).filter(x => x !== m)]
    const maxPriority = Math.max(0, ...cfgs.value.filter(x => x.service_type === type).map(x => x.priority || 0))
    const payload = { model: models }
    if ((c.priority || 0) < maxPriority) payload.priority = maxPriority + 1
    if (!c.is_active) payload.is_active = true // 停用配置无法成为默认,选择即启用
    await aiConfigAPI.update(c.id, payload)
    toast.success(t('settings.ai.defaultModelSwitched', { type: serviceMeta.value[type].label, model: m }))
    await loadCfgs()
  } catch (e) {
    toastError(e)
  } finally {
    defaultSaving.value = false
  }
}
async function toggleCfg(c) { await aiConfigAPI.update(c.id, { is_active: !c.is_active }); loadCfgs() }
async function delCfg(id) { await aiConfigAPI.del(id); toast.success(t('index.deleted')); loadCfgs() }
async function applyHuobaoQuickConfig() {
  const apiKey = huobaoApiKey.value.trim()
  if (!apiKey) { toast.warning(t('settings.ai.apiKeyRequired')); return }
  huobaoSaving.value = true
  try {
    for (const preset of huobaoQuickConfigs.value) {
      const payload = { ...preset, api_key: apiKey }
      const existing = cfgs.value.find(c => c.name === preset.name || (c.service_type === preset.service_type && c.provider === preset.provider && c.base_url === preset.base_url))
      if (existing) await aiConfigAPI.update(existing.id, payload)
      else await aiConfigAPI.create(payload)
    }
    toast.success(t('settings.ai.quickApplied'))
    huobaoApiKey.value = ''
    await loadCfgs()
  } catch (e) {
    toastError(e)
  } finally {
    huobaoSaving.value = false
  }
}
function startAddCfg(t) {
  cfgEditId.value = null
  cfgTestResult.value = null
  cfgOriginalSettings.value = {}
  cfgComfyMode.value = 'gateway'
  gwWorkflows.value = []
  gwError.value = ''
  Object.assign(cfgForm, {
    name: '', provider: '', api_key: '', base_url: '', models: [], service_type: t, priority: 0, temperature: '',
    provider_settings: emptyProviderSettings(),
  })
  const firstPreset = presetsByType(t)[0]
  if (firstPreset) applyProviderPreset(t, firstPreset.provider)
  cfgDialog.value = true
}
function startEditCfg(c) {
  cfgEditId.value = c.id
  cfgTestResult.value = null
  const raw = c.provider_settings && typeof c.provider_settings === 'object' ? c.provider_settings : {}
  cfgOriginalSettings.value = { ...raw }
  cfgComfyMode.value = raw.workflow_slug ? 'gateway' : 'direct'
  gwWorkflows.value = []
  gwError.value = ''
  const merged = { ...emptyProviderSettings(), ...raw }
  if (merged.workflow && typeof merged.workflow === 'object') {
    merged.workflow = JSON.stringify(merged.workflow, null, 2)
  }
  Object.assign(cfgForm, {
    name: c.name || '',
    provider: c.provider,
    api_key: c.api_key || '',
    base_url: c.base_url || '',
    models: Array.isArray(c.model) ? [...c.model] : String(c.model || '').split(',').map(s => s.trim()).filter(Boolean),
    service_type: c.service_type,
    priority: c.priority ?? 0,
    temperature: c.temperature ?? '',
    provider_settings: merged,
  })
  cfgDialog.value = true
  // 编辑网关配置时自动拉取工作流名称，避免用户不知道可选项
  if (c.provider === 'comfyui' && cfgComfyMode.value === 'gateway' && cfgForm.base_url) {
    void loadGatewayWorkflows({ quiet: true })
  }
}
async function testCfgPayload(payload) {
  cfgTesting.value = true
  try {
    cfgTestResult.value = await aiConfigAPI.test(payload)
    if (cfgTestResult.value.reachable) toast.success(t('settings.cfg.reachable'))
    else toast.warning(t('settings.cfg.unreachable'))
  } catch (e) {
    toastError(e)
  } finally {
    cfgTesting.value = false
  }
}
function draftProviderSettings() {
  try {
    return collectProviderSettings()
  } catch {
    // 测试探针不校验工作流等必填项：仅验证端点与鉴权
    return { ...cfgOriginalSettings.value, ...(cfgForm.provider_settings || {}) }
  }
}
async function testDraftCfg() {
  await testCfgPayload({
    service_type: cfgForm.service_type,
    provider: cfgForm.provider,
    api_key: cfgForm.api_key,
    base_url: cfgForm.base_url,
    model: [...cfgForm.models],
    provider_settings: draftProviderSettings(),
  })
}
async function testExistingCfg(c) {
  startEditCfg(c)
  await testCfgPayload({
    service_type: c.service_type,
    provider: c.provider,
    api_key: c.api_key || '',
    base_url: c.base_url || '',
    model: Array.isArray(c.model) ? c.model : [],
    provider_settings: draftProviderSettings(),
  })
}
async function saveCfg() {
  if (!cfgForm.provider) { toast.warning(t('settings.cfg.providerRequired')); return }
  const models = [...cfgForm.models]
  const temperature = cfgForm.temperature === '' || cfgForm.temperature === null ? null : Number(cfgForm.temperature)
  if (temperature !== null && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    toast.warning(t('settings.cfg.tempInvalid')); return
  }
  let providerSettings
  try {
    providerSettings = collectProviderSettings()
  } catch (error) {
    toast.warning(error.message || t('settings.cfg.providerSettingsInvalid')); return
  }
  try {
    if (cfgEditId.value) await aiConfigAPI.update(cfgEditId.value, { name: cfgForm.name, provider: cfgForm.provider, api_key: cfgForm.api_key, base_url: cfgForm.base_url, model: models, priority: cfgForm.priority, temperature, provider_settings: providerSettings })
    else await aiConfigAPI.create({ service_type: cfgForm.service_type, provider: cfgForm.provider, name: cfgForm.name || `${cfgForm.provider}-${cfgForm.service_type}`, api_key: cfgForm.api_key, base_url: cfgForm.base_url, model: models, priority: cfgForm.priority, temperature, provider_settings: providerSettings })
    cfgDialog.value = false; toast.success(t('common.saved')); loadCfgs()
  } catch (e) { toastError(e) }
}

// ===== Agent Configs =====
const agentCfgs = ref([])
const agentPane = ref('prompt')   // 右侧子 tab：prompt | skills
const agentSaving = ref(false)
const agentSaved = ref(null)
const agentForm = reactive({ system_prompt: '' })

const agentDefs = computed(() => [
  { type: 'script_rewriter', label: t('settings.agents.scriptRewriter'), icon: '📝' },
  { type: 'extractor', label: t('settings.agents.extractor'), icon: '🔍' },
  { type: 'storyboard_breaker', label: t('settings.agents.storyboardBreaker'), icon: '🎬' },
  { type: 'prompt_generator', label: t('settings.agents.promptGenerator'), icon: '🖼' },
  { type: 'storyboard_auditor', label: t('settings.agents.storyboardAuditor'), icon: '🛡' },
])

function getAgentCfg(type) {
  return agentCfgs.value.find(a => a.agent_type === type)
}


async function loadAgents() {
  try { agentCfgs.value = await promptAPI.list() }
  catch (e) { toastError(e) }
}

async function loadAgentPrompt(type) {
  try {
    const cfg = await promptAPI.get(type, editLang.value)
    if (selectedAgent.value === type) {
      agentForm.system_prompt = cfg.system_prompt || ''
      agentPromptFallback.value = editLang.value !== 'zh' && !!cfg.is_default
    }
    agentSaved.value = null
  } catch (e) { toastError(e) }
}

async function resetAgentPrompt(type) {
  try {
    await promptAPI.reset(type, editLang.value)
    await loadAgents()
    const cfg = await promptAPI.get(type, editLang.value)
    agentForm.system_prompt = cfg.system_prompt || ''
    agentPromptFallback.value = editLang.value !== 'zh' && !!cfg.is_default
    toast.success(t('settings.agents.promptReset'))
  } catch (e) { toastError(e) }
}

async function saveAgentCfg(type) {
  agentSaving.value = true
  agentSaved.value = null
  try {
    await promptAPI.update(type, {
      name: agentDefs.value.find(a => a.type === type)?.label || type,
      system_prompt: agentForm.system_prompt,
    }, editLang.value)
    await loadAgents()
    agentPromptFallback.value = false
    agentSaved.value = type
    toast.success(t('settings.agents.saved', { agent: agentDefs.value.find(a => a.type === type)?.label }))
    setTimeout(() => { if (agentSaved.value === type) agentSaved.value = null }, 3000)
  } catch (e) {
    toastError(e)
  } finally {
    agentSaving.value = false
  }
}

// ===== Skills =====
const selectedAgent = ref('script_rewriter')
const allSkills = ref([])   // { id, name, description }[]
const editingSkill = ref(null)
const skillContent = ref('')
const skillSaving = ref(false)
const skillSaved = ref(null)
const addSkillDialog = ref(false)
const newSkillForm = reactive({ id: '', name: '', description: '' })

const selectedAgentType = computed(() => selectedAgent.value)
const selectedAgentLabel = computed(() => agentDefs.value.find(a => a.type === selectedAgent.value)?.label || '')
const selectedAgentIcon = computed(() => agentDefs.value.find(a => a.type === selectedAgent.value)?.icon || '')

// ===== 通用：AI 内容语言（全局设置，与界面语言相互独立） =====
const contentLanguage = ref('zh')
const contentLangOptions = [
  { value: 'zh', label: '中文', shortLabel: '中文' },
  { value: 'en', label: 'English', shortLabel: 'EN' },
  { value: 'ja', label: '日本語', shortLabel: '日本語' },
  { value: 'ko', label: '한국어', shortLabel: '한국어' },
]
// ===== Agent 配置：prompt/skill 编辑的语言版本（只读跟随内容语言） =====
const agentPromptFallback = ref(false)   // 当前语言无独立 prompt 文件，展示的是回退内容
const skillContentFallback = ref(false)  // 同上，skill 编辑器
const promptFileName = computed(() => `workspace/prompts/${selectedAgent.value}${editLang.value !== 'zh' ? `.${editLang.value}` : ''}.md`)
const skillFileName = computed(() => `SKILL${editLang.value !== 'zh' ? `.${editLang.value}` : ''}.md`)

// Agent 编辑语言 = 全局内容语言的只读镜像（改语言请到「通用」页）
const editLang = computed(() => contentLanguage.value)
const contentLangLabel = computed(() =>
  contentLangOptions.find(l => l.value === contentLanguage.value)?.label || contentLanguage.value)

// 内容语言变化时同步刷新 Agent 面板（提示词、Skill 列表与展开内容）
// 内容语言切换后整页刷新（setUnifiedLanguage），无需局部 watch 同步
// ===== 通用：外观主题（localStorage 持久化，即时生效） =====
const { themeMode, setThemeMode } = useTheme()
const themeOptions = computed(() => [
  { value: 'light', label: t('settings.general.appearanceLight') },
  { value: 'dark', label: t('settings.general.appearanceDark') },
  { value: 'system', label: t('settings.general.appearanceSystem') },
])

async function loadContentLanguage() {
  try {
    const lang = (await settingsAPI.contentLanguage())?.language || 'zh'
    contentLanguage.value = lang
  } catch { /* 保持默认 */ }
}
async function setContentLanguage(lang) {
  if (contentLanguage.value === lang) return
  // UI 语言 = AI 内容语言：确认弹窗 → 统一切换 → 刷新（顶栏 LocaleSwitcher 同一入口）
  await confirmUnifiedLanguage(lang)
}
onMounted(loadContentLanguage)

// ===== 配音默认（设置页「配音」） =====
const dubbingDefaults = ref(null)
const dubbingEnabled = ref(false)
const dubbingSaving = ref(false)
const bgmItems = ref([])
const bgmDir = ref('')
const bgmLoading = ref(false)
const bgmDeleting = ref(false)
const bgmToDelete = ref(null)

const activeAudioCfgs = computed(() => cfgs.value.filter(c => c.service_type === 'audio' && c.is_active))
const defaultAudioCfg = computed(() =>
  [...activeAudioCfgs.value].sort((a, b) => (b.priority || 0) - (a.priority || 0))[0] || null)
const defaultAudioModel = computed(() => {
  const model = defaultAudioCfg.value?.model
  return Array.isArray(model) ? model[0] : (model || '')
})
const voiceLanguageOptions = computed(() => [
  { label: t('settings.dubbing.languageAuto'), value: '' },
  { label: '中文', value: 'zh' },
  { label: 'English', value: 'en' },
  { label: '日本語', value: 'ja' },
  { label: '한국어', value: 'ko' },
])
const videoAudioModeOptions = computed(() => [
  { label: t('settings.dubbing.videoAudioAuto'), value: 'auto' },
  { label: t('settings.dubbing.videoAudioNative'), value: 'native' },
  { label: t('settings.dubbing.videoAudioAmbient'), value: 'ambient' },
  { label: t('settings.dubbing.videoAudioSilent'), value: 'silent' },
])
const originalAudioOptions = computed(() => [
  { label: t('workbench.duck'), value: 'duck' },
  { label: t('workbench.keep'), value: 'keep' },
  { label: t('workbench.mute'), value: 'mute' },
])
const subtitleModeOptions = computed(() => [
  { label: t('workbench.soft'), value: 'soft' },
  { label: t('workbench.burn'), value: 'burn' },
  { label: t('workbench.none'), value: 'none' },
])

async function loadDubbing() {
  try {
    const [res, status] = await Promise.all([
      settingsAPI.dubbing(),
      dubbingAPI.status().catch(() => null),
    ])
    dubbingDefaults.value = res.defaults
    dubbingEnabled.value = Boolean(status?.enabled)
    await loadDubbingBgm()
  } catch (e) {
    toastError(e)
  }
}

async function loadDubbingBgm() {
  bgmLoading.value = true
  try {
    const res = await bgmAPI.list()
    bgmItems.value = res?.items || []
    bgmDir.value = res?.dir || ''
  } catch (e) {
    toastError(e)
  } finally {
    bgmLoading.value = false
  }
}

async function saveDubbing(patch) {
  if (dubbingSaving.value) return
  dubbingSaving.value = true
  try {
    const res = await settingsAPI.saveDubbing(patch)
    dubbingDefaults.value = res.defaults
    toast.success(t('settings.dubbing.saved'))
  } catch (e) {
    toastError(e)
    await loadDubbing()
  } finally {
    dubbingSaving.value = false
  }
}

function saveNumber(field, event, min, max, nullable = false) {
  const raw = event.target.value
  if (nullable && String(raw).trim() === '') {
    saveDubbing({ [field]: null })
    return
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  saveDubbing({ [field]: Math.max(min, Math.min(max, Math.round(n))) })
}

async function toggleDubbing(event) {
  const enabled = Boolean(event.target.checked)
  try {
    await dubbingAPI.setEnabled(enabled)
    dubbingEnabled.value = enabled
    toast.success(t('common.saved'))
  } catch (e) {
    event.target.checked = !enabled
    toastError(e)
  }
}

// ===== 小说生成设置（设置页「小说」） =====
const NOVEL_STAGE_KEYS = ['architecture', 'blueprint', 'chapter', 'finalize', 'enrich', 'compass']
const NOVEL_IMPORT_WORDS_DEFAULT = 1200
const novelSettings = ref(null)
const novelSaving = ref(false)
let novelPendingPatch = null

const novelTextCfgOptions = computed(() => {
  const list = cfgs.value.filter(c => c.service_type === 'text' && c.is_active)
  return [
    { label: t('settings.novel.followDefault'), value: 0 },
    ...list.map(c => ({ label: c.name || `#${c.id}`, value: c.id })),
  ]
})
const novelStageCfgOptions = computed(() =>
  cfgs.value
    .filter(c => c.service_type === 'text' && c.is_active)
    .map(c => ({ label: c.name || `#${c.id}`, value: c.id })),
)

async function loadNovel() {
  try {
    const res = await settingsAPI.novel()
    novelSettings.value = res.settings
  } catch (e) {
    toastError(e)
  }
}

watch(tab, (value) => {
  if (value === 'novel' && !novelSettings.value) loadNovel()
})

async function saveNovel(patch) {
  if (novelSaving.value) {
    novelPendingPatch = { ...(novelPendingPatch || {}), ...patch }
    return
  }
  novelSaving.value = true
  try {
    const res = await settingsAPI.saveNovel(patch)
    novelSettings.value = res.settings
    toast.success(t('settings.novel.saved'))
  } catch (e) {
    toastError(e)
    await loadNovel()
  } finally {
    novelSaving.value = false
    if (novelPendingPatch) {
      const next = novelPendingPatch
      novelPendingPatch = null
      void saveNovel(next)
    }
  }
}

function saveNovelStage(stage, value) {
  const id = Number(value) || 0
  if (!id) return
  saveNovel({ stageModels: { ...(novelSettings.value?.stageModels || {}), [stage]: id } })
}

function saveNovelImportWords(event) {
  const n = Number(event.target.value)
  if (!Number.isFinite(n)) return
  saveNovel({ importTargetWords: Math.max(600, Math.min(5000, Math.round(n))) })
}

const writingStyleSelectOptions = computed(() => [
  { label: t('settings.novel.writingStyleNone'), value: '' },
  ...((novelSettings.value?.writingStyles || []).map(style => ({ label: style.name, value: style.key }))),
])

function addWritingStyle() {
  const current = novelSettings.value?.writingStyles || []
  const key = `custom-${Date.now().toString(36)}`
  const next = [
    ...current,
    {
      key,
      name: t('settings.novel.writingStyleNewName'),
      prompt: t('settings.novel.writingStyleNewPrompt'),
    },
  ]
  saveNovel({ writingStyles: next })
}

function updateWritingStyle(index, patch) {
  const current = novelSettings.value?.writingStyles || []
  if (!current[index]) return
  // 空提示词的文风会被后端过滤，等用户重新填写后再保存
  if ('prompt' in patch && !String(patch.prompt || '').trim()) return
  const next = current.map((style, i) => (i === index ? { ...style, ...patch } : style))
  saveNovel({ writingStyles: next })
}

function removeWritingStyle(index) {
  const current = novelSettings.value?.writingStyles || []
  if (!current[index]) return
  saveNovel({ writingStyles: current.filter((_, i) => i !== index) })
}

async function confirmDeleteBgm() {
  if (!bgmToDelete.value) return
  bgmDeleting.value = true
  try {
    await bgmAPI.remove(bgmToDelete.value.name)
    bgmToDelete.value = null
    await loadDubbingBgm()
    toast.success(t('settings.dubbing.bgmDeleted'))
  } catch (e) {
    toastError(e)
  } finally {
    bgmDeleting.value = false
  }
}

// agent type 用下划线（script_rewriter），skill 目录按 Mastra 规范用连字符（script-rewriter）
const skillDirOf = (type) => type.replace(/_/g, '-')
const skillBelongsTo = (skillId, type) => {
  const dir = skillDirOf(type)
  return skillId === dir || skillId.startsWith(dir + '/')
}

function agentSkillCount(type) {
  return allSkills.value.filter(s => skillBelongsTo(s.id, type)).length
}

const currentSkills = computed(() =>
  allSkills.value.filter(s => skillBelongsTo(s.id, selectedAgent.value))
)

async function loadAllSkills() {
  try { allSkills.value = await skillsAPI.list(editLang.value) }
  catch (e) { toastError(e) }
}

async function selectAgent(type) {
  if (selectedAgent.value !== type) {
    selectedAgent.value = type
    editingSkill.value = null
  }
  await loadAgentPrompt(type)
}

function startAddSkill() {
  newSkillForm.id = ''
  newSkillForm.name = ''
  newSkillForm.description = ''
  addSkillDialog.value = true
}

async function confirmAddSkill() {
  if (!newSkillForm.id) return
  const skillId = `${skillDirOf(selectedAgent.value)}/${newSkillForm.id}`
  try {
    await skillsAPI.create({ id: skillId, name: newSkillForm.name, description: newSkillForm.description })
    addSkillDialog.value = false
    await loadAllSkills()
    toast.success(t('settings.skills.created'))
  } catch (e) {
    toastError(e)
  }
}

const skillToDelete = ref(null)
const deletingSkill = ref(false)

async function confirmDelSkill() {
  const id = skillToDelete.value
  if (!id) return
  try {
    deletingSkill.value = true
    await skillsAPI.del(id)
    if (editingSkill.value === id) editingSkill.value = null
    await loadAllSkills()
    skillToDelete.value = null
    toast.success(t('index.deleted'))
  } catch (e) {
    toastError(e)
  } finally {
    deletingSkill.value = false
  }
}

async function toggleSkillEdit(id) {
  if (editingSkill.value === id) { editingSkill.value = null; return }
  try {
    const res = await skillsAPI.get(id, editLang.value)
    skillContent.value = res.content
    skillContentFallback.value = editLang.value !== 'zh' && !!res.is_default
    skillSaved.value = null
    editingSkill.value = id
  } catch (e) { toastError(e) }
}

async function saveSkill(id) {
  skillSaving.value = true
  skillSaved.value = null
  try {
    await skillsAPI.update(id, skillContent.value, editLang.value)
    await loadAllSkills()
    skillContentFallback.value = false
    skillSaved.value = id
    toast.success(t('common.saved'))
    setTimeout(() => { if (skillSaved.value === id) skillSaved.value = null }, 3000)
  } catch (e) {
    toastError(e)
  } finally {
    skillSaving.value = false
  }
}

// ===== Style Presets =====
const stylePresets = ref([])
const styleDialog = ref(false)
const styleEditId = ref(null)
const styleForm = reactive({ name: '', value: '', prompt: '', description: '', sort_order: 0 })

async function loadStylePresets() {
  try { stylePresets.value = await stylePresetAPI.list(true) } catch (e) { toastError(e) }
}

async function toggleStyle(p) {
  try {
    await stylePresetAPI.update(p.id, { is_active: !p.is_active })
    loadStylePresets()
  } catch (e) { toastError(e) }
}

const styleToDelete = ref(null)
const deletingStyle = ref(false)

async function confirmDelStyle() {
  const p = styleToDelete.value
  if (!p) return
  try {
    deletingStyle.value = true
    await stylePresetAPI.del(p.id)
    styleToDelete.value = null
    toast.success(t('index.deleted'))
    loadStylePresets()
  } catch (e) {
    toastError(e)
  } finally {
    deletingStyle.value = false
  }
}

function startAddStyle() {
  styleEditId.value = null
  Object.assign(styleForm, {
    name: '', value: '', prompt: '', description: '',
    sort_order: (stylePresets.value.at(-1)?.sort_order ?? 0) + 1,
  })
  styleDialog.value = true
}

function startEditStyle(p) {
  styleEditId.value = p.id
  Object.assign(styleForm, {
    name: p.name,
    value: p.value,
    prompt: p.prompt,
    description: p.description || '',
    sort_order: p.sort_order ?? 0,
  })
  styleDialog.value = true
}

async function saveStyle() {
  if (!styleForm.name?.trim() || !styleForm.prompt?.trim() || (!styleEditId.value && !styleForm.value?.trim())) {
    toast.warning(t('settings.styleDialog.required'))
    return
  }
  try {
    if (styleEditId.value) {
      await stylePresetAPI.update(styleEditId.value, {
        name: styleForm.name,
        prompt: styleForm.prompt,
        description: styleForm.description,
        sort_order: styleForm.sort_order,
      })
    } else {
      await stylePresetAPI.create({ ...styleForm })
    }
    styleDialog.value = false
    toast.success(t('common.saved'))
    loadStylePresets()
  } catch (e) { toastError(e) }
}

// ===== 从参考图生成风格 =====
const styleRefDialog = ref(false)
const styleRefImages = ref([])
const styleRefUploading = ref(false)
const styleRefAnalyzing = ref(false)
const styleRefConfigId = ref(null)
const styleRefTextOptions = computed(() => cfgs.value
  .filter(c => c.service_type === 'text' && c.is_active)
  .map(c => ({ label: `${c.name}${c.model?.[0] ? ` · ${c.model[0]}` : ''}`, value: c.id })))

function startStyleFromImages() {
  styleRefImages.value = []
  styleRefConfigId.value = null
  styleRefDialog.value = true
}

function pickStyleRefImages() {
  if (styleRefUploading.value) return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp'
  input.multiple = true
  input.onchange = async () => {
    const files = Array.from(input.files || []).slice(0, 4 - styleRefImages.value.length)
    if (!files.length) return
    styleRefUploading.value = true
    try {
      for (const file of files) {
        try {
          const res = await uploadAPI.image(file)
          styleRefImages.value.push({ path: res.path, url: res.url })
        } catch (error) { toastError(error) }
      }
    } finally {
      styleRefUploading.value = false
    }
  }
  input.click()
}

function removeStyleRefImage(index) { styleRefImages.value.splice(index, 1) }

async function analyzeStyleImages() {
  if (styleRefAnalyzing.value || !styleRefImages.value.length) return
  styleRefAnalyzing.value = true
  try {
    const res = await stylePresetAPI.analyze({
      images: styleRefImages.value.map(item => item.path),
      config_id: styleRefConfigId.value ? Number(styleRefConfigId.value) : undefined,
      language: locale.value,
    })
    toast.success(t('settings.styleRef.done', { name: res?.preset?.name || '' }))
    styleRefDialog.value = false
    await loadStylePresets()
  } catch (error) {
    toastError(error, { fallback: 'settings.styleRef.failed' })
  } finally {
    styleRefAnalyzing.value = false
  }
}

// ===== 流程规则（AI 改写 / 资产提取 / 分镜拆分 / 视频提示词） =====
const pipelineRules = ref([])
const ruleSavingKey = ref('')
const RULE_PLACEHOLDERS = {
  storyboards: '{{videoModel}} {{characters}} {{scenes}} {{props}}',
  'video_prompts': '{{shotNumber}} {{storyboardId}} {{videoModel}}',
}
function ruleI18nKey(key) {
  if (key === 'rewrite') return 'rewrite'
  if (key === 'storyboards') return 'storyboards'
  if (key === 'video_prompts') return 'videoPrompts'
  if (key === 'extract.characters') return 'extractCharacters'
  if (key === 'extract.scenes') return 'extractScenes'
  if (key === 'extract.props') return 'extractProps'
  return 'rewrite'
}
async function loadPipelineRules() {
  try {
    pipelineRules.value = await pipelineRuleAPI.list()
  } catch (e) { toastError(e) }
}
async function savePipelineRuleItem(rule) {
  if (ruleSavingKey.value) return
  ruleSavingKey.value = rule.key
  try {
    const res = await pipelineRuleAPI.save(rule.key, rule.rule)
    rule.rule = res?.rule ?? rule.rule
    rule.is_default = Boolean(res?.is_default)
    toast.success(t('common.saved'))
  } catch (e) { toastError(e) } finally { ruleSavingKey.value = '' }
}
async function resetPipelineRuleItem(rule) {
  try {
    const res = await pipelineRuleAPI.reset(rule.key)
    rule.rule = res?.rule ?? rule.rule
    rule.is_default = true
  } catch (e) { toastError(e) }
}

// ===== 分镜拆分方案 =====
const breakdownMethods = ref([])
const breakdownLoading = ref(false)
const breakdownSaving = ref(false)
const breakdownDeleting = ref(false)
const breakdownLoadFailed = ref(false)
const breakdownEditingKey = ref('')
const breakdownToDelete = ref(null)
const BREAKDOWN_TEXT_FIELDS = ['name', 'description', 'prompt', 'skill']
function emptyBreakdownDraft() {
  return { key: '', name: '', description: '', prompt: '', skill: '' }
}
const breakdownDraft = ref(emptyBreakdownDraft())
const breakdownOriginal = ref(emptyBreakdownDraft())
const breakdownDirty = computed(() =>
  BREAKDOWN_TEXT_FIELDS.some(field => (breakdownDraft.value[field] || '') !== (breakdownOriginal.value[field] || '')),
)
const currentBreakdownMethod = computed(() =>
  breakdownMethods.value.find(item => item.key === breakdownEditingKey.value) || null,
)
const bothBreakdownTextsEmpty = computed(() =>
  !breakdownDraft.value.prompt.trim() && !breakdownDraft.value.skill.trim(),
)

function applyBreakdownMethod(method) {
  const next = {
    key: method?.key || '',
    name: method?.name || '',
    description: method?.description || '',
    prompt: method?.prompt || '',
    skill: method?.skill || '',
  }
  breakdownEditingKey.value = next.key
  breakdownDraft.value = next
  breakdownOriginal.value = { ...next }
}

async function loadBreakdownMethodDetail(key) {
  const method = await breakdownMethodAPI.get(key)
  applyBreakdownMethod(method)
}

async function loadBreakdownMethods(preferredKey = '') {
  breakdownLoading.value = true
  breakdownLoadFailed.value = false
  try {
    const data = await breakdownMethodAPI.list()
    breakdownMethods.value = Array.isArray(data?.list) ? data.list : []
    const target = [preferredKey, breakdownEditingKey.value, breakdownMethods.value[0]?.key]
      .find(key => key && breakdownMethods.value.some(item => item.key === key))
    if (target) {
      await loadBreakdownMethodDetail(target)
    } else {
      applyBreakdownMethod(null)
    }
  } catch (e) {
    breakdownLoadFailed.value = true
    toastError(e, { fallback: 'settings.breakdown.loadFailed' })
  } finally {
    breakdownLoading.value = false
  }
}

async function selectBreakdownMethod(method) {
  if (!method || method.key === breakdownEditingKey.value) return
  if (breakdownDirty.value && !window.confirm(t('settings.breakdown.unsaved'))) return
  try {
    await loadBreakdownMethodDetail(method.key)
  } catch (e) { toastError(e) }
}

function newBreakdownMethod() {
  if (breakdownDirty.value && !window.confirm(t('settings.breakdown.unsaved'))) return
  applyBreakdownMethod(null)
}

async function saveBreakdownMethod() {
  if (breakdownSaving.value) return
  const name = breakdownDraft.value.name.trim()
  if (!name) return
  breakdownSaving.value = true
  try {
    const payload = {
      name,
      description: breakdownDraft.value.description,
      prompt: breakdownDraft.value.prompt,
      skill: breakdownDraft.value.skill,
    }
    const saved = breakdownDraft.value.key
      ? await breakdownMethodAPI.update(breakdownDraft.value.key, payload)
      : await breakdownMethodAPI.create(payload)
    toast.success(t('settings.breakdown.saved'))
    await loadBreakdownMethods(saved?.key || breakdownDraft.value.key)
  } catch (e) {
    toastError(e)
  } finally {
    breakdownSaving.value = false
  }
}

async function resetBreakdownMethod() {
  const key = breakdownEditingKey.value
  if (!key) return
  if (!window.confirm(t('settings.breakdown.resetConfirm'))) return
  try {
    await breakdownMethodAPI.reset(key)
    await loadBreakdownMethods(key)
  } catch (e) { toastError(e) }
}

async function duplicateBreakdownMethod() {
  const key = breakdownEditingKey.value
  if (!key) return
  try {
    const copy = await breakdownMethodAPI.duplicate(key)
    await loadBreakdownMethods(copy?.key || key)
  } catch (e) { toastError(e) }
}

async function confirmDeleteBreakdownMethod() {
  const target = breakdownToDelete.value
  if (!target || breakdownDeleting.value) return
  breakdownDeleting.value = true
  try {
    await breakdownMethodAPI.del(target.key)
    breakdownToDelete.value = null
    toast.success(t('index.deleted'))
    await loadBreakdownMethods('standard')
  } catch (e) {
    toastError(e)
  } finally {
    breakdownDeleting.value = false
  }
}

// ===== 分镜检验策略 =====
const auditPolicy = ref(null)
const auditPolicyLoading = ref(false)
const auditPolicySaving = ref(false)
const auditPolicySaved = ref(false)
const auditPolicyLoadFailed = ref(false)
let auditSavedTimer = null

function applyAuditPolicy(policy) {
  auditPolicy.value = JSON.parse(JSON.stringify(policy))
}

async function loadAuditPolicy() {
  if (auditPolicyLoading.value) return
  auditPolicyLoading.value = true
  auditPolicyLoadFailed.value = false
  try {
    const res = await settingsAPI.storyboardAudit()
    if (res?.policy) applyAuditPolicy(res.policy)
  } catch (e) {
    auditPolicyLoadFailed.value = true
    toastError(e)
  } finally {
    auditPolicyLoading.value = false
  }
}

async function saveAuditPolicy() {
  if (!auditPolicy.value || auditPolicySaving.value) return
  auditPolicySaving.value = true
  auditPolicySaved.value = false
  try {
    const res = await settingsAPI.saveStoryboardAudit(auditPolicy.value)
    if (res?.policy) applyAuditPolicy(res.policy)
    auditPolicySaved.value = true
    toast.success(t('settings.audit.saved'))
    if (auditSavedTimer) clearTimeout(auditSavedTimer)
    auditSavedTimer = setTimeout(() => { auditPolicySaved.value = false }, 3000)
  } catch (e) {
    toastError(e)
  } finally {
    auditPolicySaving.value = false
  }
}

function openAuditorAgent() {
  agentPane.value = 'prompt'
  tab.value = 'agents'
  void selectAgent('storyboard_auditor')
}

onMounted(() => {
  loadStylePresets()
  loadPipelineRules()
  if (tab.value === 'device') void loadDeviceInfo()
  if (tab.value === 'dubbing') loadDubbing()
  if (tab.value === 'novel') loadNovel()
  if (tab.value === 'breakdown') loadBreakdownMethods()
  if (tab.value === 'audit') loadAuditPolicy()
  if (tab.value === 'storage' && !isGuest.value) loadStorage()
})

// 主机级设置等角色明确后再加载；访客不发起这些请求
let hostSettingsLoaded = false
function loadHostSettingsOnce() {
  if (hostSettingsLoaded) return
  hostSettingsLoaded = true
  loadCfgs()
  loadAgents()
  loadAllSkills()
  loadAgentPrompt(selectedAgent.value)
  if (!isAppMode) loadMcp()
  loadMediaSettings()
  if (tab.value === 'remote') void loadRemoteTab()
}
watch([() => remoteRole.ready, isGuest], ([ready]) => {
  if (!ready || isGuest.value) return
  loadHostSettingsOnce()
  if (tab.value === 'storage') loadStorage()
  if (tab.value === 'about' && !isAppMode) refreshUpdateState()
}, { immediate: true })

// ===== 应用内引导（设置页）：快捷配置 + 手动模板两步 =====
const SETTINGS_TOUR = [
  { element: '.quick-card', titleKey: 'tour.settings.quick.title', descKey: 'tour.settings.quick.desc', popoverSide: 'bottom' },
  { element: '.nav-item:has(.lucide-cpu), .nav-item:nth-of-type(1)', titleKey: 'tour.settings.nav.title', descKey: 'tour.settings.nav.desc', popoverSide: 'right' },
]
onMounted(() => setTimeout(() => autoTour('settings', SETTINGS_TOUR, t), 800))
function replaySettingsTour() { startTour('settings', SETTINGS_TOUR, t) }

// ===== 存储位置 =====
const desktopBridge = useDesktopBridge()
const { begin: beginMigrate, update: updateMigrate, end: endMigrate } = useMigrateState()

const storageInfo = ref(null)
const migrateDialog = ref(false)
const migrateTarget = ref('')
const migrateTargetFree = ref(null)
const migrateFiles = ref(true)
const migrating = ref(false)

const isDesktopMode = computed(() => storageInfo.value?.mode === 'desktop' && !!desktopBridge)
const appBridge = useAppBridge()
const isAppStorage = computed(() => storageInfo.value?.mode === 'app')
const storageModeLabel = computed(() => {
  const mode = storageInfo.value?.mode
  if (mode === 'app') return t('settings.storage.appMode')
  if (mode === 'desktop') return t('settings.storage.desktopMode')
  return t('settings.storage.serverMode')
})
const displayTotalBytes = computed(() => {
  const info = storageInfo.value
  if (!info) return 0
  if (info.mode === 'app' && info.app) return info.app.totalBytes || info.usage?.total || 0
  return info.usage?.total || 0
})
const backupInfo = ref(null)
const backupBusy = ref(false)
const restoreTarget = ref(null)
const deleteTarget = ref(null)

// 存储占用 2s 轮询至新鲜（后端 stale-while-revalidate）；隐藏暂停、卸载必停
const usagePoll = useVisibilityPolling(async () => {
  try {
    storageInfo.value = await storageAPI.info()
    if (storageInfo.value?.usage && !storageInfo.value?.usageStale) usagePoll.stop()
  } catch { /* 轮询错误静默 */ }
}, 2000)

function stopUsagePoll() {
  usagePoll.stop()
}

async function loadStorage() {
  try {
    storageInfo.value = await storageAPI.info()
    // 占用为空或统计已过期时轮询至新鲜
    stopUsagePoll()
    if (storageInfo.value?.usageStale || !storageInfo.value?.usage) usagePoll.start()
    if (storageInfo.value?.mode === 'app') await loadBackups()
  } catch (e) { toastError(e, { fallback: 'settings.storage.loadFailed' }) }
}

async function loadBackups() {
  try {
    backupInfo.value = await backupAPI.list()
  } catch (e) {
    toastError(e, { fallback: 'settings.storage.backups.loadFailed' })
  }
}

function backupReasonLabel(reason) {
  const known = ['first-start', 'upgrade', 'pre-sync', 'pre-restore', 'manual']
  return t(`settings.storage.backups.reasons.${known.includes(reason) ? reason : 'manual'}`)
}

function backupDownloadUrl(name) {
  return backupAPI.downloadUrl(name)
}

async function createBackup() {
  if (backupBusy.value) return
  backupBusy.value = true
  try {
    await backupAPI.create()
    toast.success(t('settings.storage.backups.created'))
    await loadStorage()
  } catch (e) {
    toastError(e, { fallback: 'settings.storage.backups.createFailed' })
  } finally {
    backupBusy.value = false
  }
}

function askRestore(item) {
  if (backupBusy.value) return
  restoreTarget.value = item
}

async function confirmRestore() {
  const target = restoreTarget.value
  if (!target || backupBusy.value) return
  if (!appBridge?.restartBackend) {
    toast.error(t('settings.storage.backups.restoreBridgeMissing'))
    return
  }
  backupBusy.value = true
  try {
    await backupAPI.restore(target.name)
    const accepted = appBridge.restartBackend()
    restoreTarget.value = null
    if (!accepted) {
      toast.error(t('settings.storage.backups.restartFailed'))
      return
    }
    // 壳进入重启遮罩；恢复完成后自动重载本页，无需前端轮询
    toast.success(t('settings.storage.backups.restoreStarted'))
  } catch (e) {
    toastError(e, { fallback: 'settings.storage.backups.restoreFailed' })
  } finally {
    backupBusy.value = false
  }
}

function askDeleteBackup(item) {
  if (backupBusy.value) return
  deleteTarget.value = item
}

async function confirmDeleteBackup() {
  const target = deleteTarget.value
  if (!target || backupBusy.value) return
  backupBusy.value = true
  try {
    await backupAPI.del(target.name)
    deleteTarget.value = null
    toast.success(t('settings.storage.backups.deleted'))
    await loadStorage()
  } catch (e) {
    toastError(e, { fallback: 'settings.storage.backups.deleteFailed' })
  } finally {
    backupBusy.value = false
  }
}

watch(tab, (active) => {
  if (active === 'dubbing') loadDubbing()
  if (active !== 'storage') stopUsagePoll()
  if (!remoteRole.ready) return
  if (active === 'storage' && !isGuest.value) loadStorage()
  if (active === 'general' && !isGuest.value) loadMediaSettings()
  if (active === 'remote' && !isGuest.value) loadRemoteTab()
})

async function pickTarget() {
  if (!desktopBridge) return
  const res = await desktopBridge.pickDirectory()
  if (res.canceled) return
  if (!res.ok || !res.path) { toastError(res.error, { fallback: 'settings.migrate.pickFailed' }); return }
  migrateTarget.value = res.path
  migrateTargetFree.value = res.freeBytes ?? null
  migrateFiles.value = true
  migrateDialog.value = true
}

async function startMigrate() {
  if (!desktopBridge || !migrateTarget.value) return
  migrating.value = true
  beginMigrate()
  try {
    await desktopBridge.startMigration({ targetDir: migrateTarget.value, migrateFiles: migrateFiles.value })
    // 成功的完成提示与页面刷新由全局进度订阅（app.vue）处理
  } catch (e) {
    endMigrate()
    toastError(e, { fallback: 'settings.migrate.failed' })
  } finally {
    migrating.value = false
    migrateDialog.value = false
    stopUsagePoll()
  }
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

// ===== 媒体工具（FFmpeg 目录） =====
const MEDIA_SOURCE_LABELS = {
  custom: 'settings.general.mediaSourceCustom',
  env: 'settings.general.mediaSourceEnv',
  static: 'settings.general.mediaSourceStatic',
  path: 'settings.general.mediaSourcePath',
  none: 'settings.general.mediaSourceNone',
}

const mediaFfmpegDir = ref('')
const mediaStatus = ref(null)
const mediaSaving = ref(false)
const mediaCaps = useMediaCapabilities()

function applyMediaPayload(payload) {
  mediaFfmpegDir.value = payload?.settings?.ffmpegDir || ''
  mediaStatus.value = payload?.status || null
}

async function loadMediaSettings() {
  try {
    applyMediaPayload(await settingsAPI.media())
  } catch (e) {
    toastError(e, { fallback: 'settings.general.mediaLoadFailed' })
  }
}

async function saveMediaSettings() {
  if (mediaSaving.value) return
  mediaSaving.value = true
  try {
    applyMediaPayload(await settingsAPI.saveMedia(mediaFfmpegDir.value.trim()))
    void mediaCaps.refresh()
    if (mediaStatus.value?.ffmpeg?.available && mediaStatus.value?.ffprobe?.available) {
      toast.success(t('settings.general.mediaSaved'))
    } else {
      toast.warning(t('settings.general.mediaUnavailable'))
    }
  } catch (e) {
    toastError(e, { fallback: 'settings.general.mediaSaveFailed' })
  } finally {
    mediaSaving.value = false
  }
}

async function restoreMediaAuto() {
  if (mediaSaving.value) return
  mediaFfmpegDir.value = ''
  await saveMediaSettings()
}

async function pickFfmpegDir() {
  if (!desktopBridge) return
  const res = await desktopBridge.pickDirectory()
  if (res.canceled) return
  if (!res.ok || !res.path) {
    toastError(res.error, { fallback: 'settings.general.mediaPickFailed' })
    return
  }
  mediaFfmpegDir.value = res.path
}

// ===== 应用内更新（桌面版走 Electron 桥；服务器/Docker 走后端 server-update 路由） =====
const updateState = ref(null)
const updateChecking = ref(false)
const updateDownloading = ref(false)
const updateProgress = ref(0)
const updateApplying = ref(false)
const serverUpdateMode = ref('manual') // 'watchtower' | 'manual'，仅服务器模式有意义

async function refreshUpdateState() {
  if (isAppMode) return
  try {
    if (desktopBridge) {
      updateState.value = await desktopBridge.getUpdateState()
    } else {
      const s = await serverUpdateAPI.state()
      serverUpdateMode.value = s.updateMode || 'manual'
      updateState.value = s
    }
  } catch { /* 静默 */ }
}

async function checkUpdate() {
  updateChecking.value = true
  try {
    if (desktopBridge) {
      updateState.value = await desktopBridge.checkUpdate()
    } else {
      const s = await serverUpdateAPI.check()
      serverUpdateMode.value = s.updateMode || 'manual'
      updateState.value = s
    }
    if (updateState.value?.status === 'up-to-date') toast.success(t('settings.about.upToDate'))
  } catch (e) {
    toastError(e, { fallback: 'settings.about.checkFailedToast' })
    refreshUpdateState()
  } finally { updateChecking.value = false }
}

async function downloadUpdate() {
  if (!desktopBridge) return
  updateDownloading.value = true
  updateProgress.value = 0
  const unProgress = desktopBridge.onUpdateProgress((p) => { updateProgress.value = p })
  try {
    updateState.value = await desktopBridge.downloadUpdate()
    toast.success(t('settings.about.downloadDone'))
  } catch (e) {
    toastError(e, { fallback: 'settings.about.downloadFailed' })
    refreshUpdateState()
  } finally {
    unProgress()
    updateDownloading.value = false
  }
}

async function applyUpdate() {
  updateApplying.value = true
  try {
    if (desktopBridge) {
      await desktopBridge.applyUpdate()
      // 成功路径：应用退出并由更新后的版本接管，不会走到这里
    } else {
      await serverUpdateAPI.apply()
      // Watchtower 异步拉镜像重建容器，本进程随后被替换
      toast.success(t('settings.about.serverApplyStarted'), { duration: 8000 })
      updateApplying.value = false
    }
  } catch (e) {
    updateApplying.value = false
    toastError(e, { fallback: desktopBridge ? 'settings.about.installFailed' : 'settings.about.serverApplyFailed' })
    refreshUpdateState()  // 桌面端 apply 失败会把具体原因写进 updateState.error，刷新显示在错误行
  }
}

watch(tab, (t) => {
  if (t === 'about' && remoteRole.ready && !isGuest.value) refreshUpdateState()
  if (t === 'rules') loadPipelineRules()
  if (t === 'breakdown') loadBreakdownMethods()
  if (t === 'audit') loadAuditPolicy()
  // 进入 Agent 页总是按当前内容语言重载（幂等）：兜住「先切语言、后进 Agent」的时序
  if (t === 'agents' && remoteRole.ready && !isGuest.value) {
    loadAgentPrompt(selectedAgent.value)
    loadAllSkills()
  }
})

// ===== 平板：页签 roving tabindex + 本地弹窗返回层/焦点陷阱 =====
const { isCompact } = useViewport()
const navRef = ref(null)

const settingsDialogOpen = computed(() => Boolean(
  cfgDialog.value || addSkillDialog.value || styleDialog.value || styleRefDialog.value || migrateDialog.value,
))

function closeSettingsDialogs() {
  cfgDialog.value = false
  addSkillDialog.value = false
  styleDialog.value = false
  styleRefDialog.value = false
  // 迁移进行中不允许被返回键/关闭打断
  if (!migrating.value) migrateDialog.value = false
}

const settingsOverlay = useOverlayHistory(closeSettingsDialogs)

watch(settingsDialogOpen, (open) => {
  if (open) {
    settingsOverlay.open()
    nextTick(focusFirstDialogControl)
  } else {
    settingsOverlay.close()
  }
})

function dialogFocusables(root) {
  if (!root) return []
  // settings.vue 为纯 JS script setup：TS 泛型会被当作比较运算，用 JSDoc 显式标注为 HTMLElement
  /** @type {NodeListOf<HTMLElement>} */
  const nodes = root.querySelectorAll('button, a[href], input, select, textarea, audio[controls], video[controls], [tabindex]:not([tabindex="-1"])')
  return Array.from(nodes)
    .filter(el => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && el.offsetParent !== null)
}

function focusFirstDialogControl() {
  const dialog = document.querySelector('.settings-page .overlay .dialog')
  dialogFocusables(dialog)[0]?.focus()
}

function onSettingsDialogKeydown(event) {
  if (event.key !== 'Tab') return
  const focusables = dialogFocusables(event.currentTarget)
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

function onSettingsTabKeydown(event, id) {
  const handled = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']
  if (!handled.includes(event.key)) return
  const items = baseTabs.value
  const index = items.findIndex(item => item.id === id)
  if (index < 0) return
  let next = index
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % items.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
  else if (event.key === 'Home') next = 0
  else next = items.length - 1
  event.preventDefault()
  const nextId = items[next].id
  tab.value = nextId
  nextTick(() => document.getElementById(`settings-tab-${nextId}`)?.focus())
}

function scrollActiveTabIntoView() {
  if (!isCompact.value) return
  void nextTick(() => {
    const active = navRef.value?.querySelector('.nav-item.active')
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  })
}

watch(tab, scrollActiveTabIntoView, { immediate: true })

onBeforeUnmount(stopUsagePoll)
</script>

<style scoped>
/* ===== 流程规则 ===== */
.rule-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.rule-item:first-of-type { border-top: none; }
.rule-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rule-name { font-size: 13px; font-weight: 600; color: var(--text-0); }
.rule-ph { font-size: 10.5px; color: var(--text-2); background: var(--overlay-track); padding: 1px 6px; border-radius: 5px; }
.rule-input { font-size: 12px; line-height: 1.6; }

/* ===== 风格参考图 ===== */
.style-ref-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.style-ref-item { position: relative; width: 84px; height: 84px; border-radius: var(--radius); overflow: hidden; border: 1px solid var(--border); }
.style-ref-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
.style-ref-remove {
  position: absolute; top: 3px; right: 3px;
  display: flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; border-radius: 50%;
  border: none; cursor: pointer;
  background: rgba(0, 0, 0, 0.55); color: #fff;
}
.style-ref-add {
  width: 84px; height: 84px;
  display: flex; align-items: center; justify-content: center;
  border: 1px dashed var(--border-strong); border-radius: var(--radius);
  background: var(--bg-input); color: var(--text-2); cursor: pointer;
}
.style-ref-add:hover { border-color: var(--accent); color: var(--accent); }

/* ===== MCP ===== */
.mcp-port-input {
  width: 96px;
  flex-shrink: 0;
  text-align: center;
}
.mcp-snippet {
  margin: 10px 0 0;
  padding: 12px 14px;
  border-radius: var(--border-radius-md, 8px);
  background: var(--surface-muted, rgba(127, 127, 127, 0.08));
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.18));
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary);
}
.mcp-error { color: var(--danger, #e5484d); }

.settings-page { display: flex; flex-direction: column; height: 100%; background: var(--bg-base); }

.settings-layout { display: flex; flex: 1; min-height: 0; }

.settings-nav {
  width: 220px; flex-shrink: 0; padding: 16px 12px 16px; border-right: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 14px;
  overflow-y: auto; min-height: 0; overscroll-behavior: contain;
}
.nav-group { display: flex; flex-direction: column; gap: 2px; }
.nav-group-label {
  font-size: 11px; font-weight: 650; color: var(--text-3);
  letter-spacing: 0.06em; padding: 8px 12px 4px;
}
.nav-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; font-size: 13px; font-weight: 550;
  border: none; border-radius: var(--radius); background: transparent; color: var(--text-1);
  cursor: pointer; transition: all 0.16s var(--ease-out); text-align: left; width: 100%;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text-0); }
.nav-item.active { background: var(--accent-bg); color: var(--accent-text); font-weight: 650; }
.nav-item:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }

.settings-content { flex: 1; min-width: 0; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
/* 14 个常驻 tabpanel 只靠 hidden 切换可见性，不设 display 覆盖 */
.settings-tabpanel { height: 100%; min-height: 0; }
.settings-content > .settings-tabpanel { flex: 1 1 auto; height: auto; }
.settings-readonly-banner {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: 8px;
  width: calc(100% - 56px); max-width: 1080px;
  margin: 12px auto 0; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--warning-bg); color: var(--warning);
  font-size: 12.5px; line-height: 1.4;
}

/* ===== 手机接力 ===== */
.remote-card .svc-group-head { flex-wrap: wrap; }
.remote-tab-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.remote-tab-actions .btn { min-height: 36px; }
.remote-settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px 16px;
  padding: 12px 20px;
}
.remote-tab-error { display: flex; align-items: center; gap: 8px; margin: 8px 0 0; color: var(--error); font-size: 12px; }
.settings-scroll { height: 100%; overflow-y: auto; padding: 20px 28px 48px; animation: fadeUp 0.3s var(--ease-out); }
/* 各分组卡片之间的间距（通用页内容语言/外观等） */
.settings-scroll > .card + .card { margin-top: 14px; }
/* 宽屏下内容列限宽居中，两侧留出呼吸空间 */
.settings-scroll > * { max-width: 1080px; margin-left: auto; margin-right: auto; }
.settings-head { margin-bottom: 20px; }
.settings-title { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; }
.settings-desc { font-size: 13px; color: var(--text-2); margin-top: 6px; }

/* 火宝快捷配置 */
.quick-card {
  padding: 20px;
  margin-bottom: 16px;
  border: 1.5px solid var(--accent);
}
.quick-card:hover { border-color: var(--accent); }
.quick-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.setup-title { font-size: 15px; font-weight: 700; color: var(--text-0); }
.setup-desc { font-size: 12.5px; color: var(--text-2); margin-bottom: 14px; }
.huobao-site-link {
  display: inline-flex; align-items: center; gap: 3px;
  margin-left: 6px;
  color: var(--accent); text-decoration: none;
  font-weight: 600; white-space: nowrap;
}
.huobao-site-link:hover { text-decoration: underline; }
.huobao-quick-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 10px;
  align-items: center;
}
.huobao-quick-models {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.hqm-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 11px;
  line-height: 1.6;
}
.hqm-label {
  flex-shrink: 0;
  width: 28px;
  font-weight: 600;
  color: var(--text-2);
}
.hqm-provider {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent-bg);
  color: var(--accent);
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.hqm-provider-icon { width: 11px; height: 11px; object-fit: contain; border-radius: 2px; }
.hqm-models {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  color: var(--text-3);
}
.hqm-model.is-default { color: var(--text-1); font-weight: 600; }
.hqm-model em {
  font-style: normal;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-text);
  background: var(--accent-bg);
}

/* 模型标签编辑器（配置弹窗） */
.model-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.model-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg-2);
  cursor: pointer;
  user-select: none;
  transition: border-color .15s, color .15s;
}
.model-chip:hover { border-color: var(--accent); color: var(--text-1); }
.model-chip.is-default { color: var(--text-1); font-weight: 600; border-color: var(--accent); }
.model-chip em {
  font-style: normal;
  padding: 0 5px;
  border-radius: 5px;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-text);
  background: var(--accent-bg);
}
.model-chip-x {
  display: inline-flex;
  align-items: center;
  padding: 1px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.model-chip-x:hover { color: var(--error); background: var(--bg-3); }
.model-add-row { display: flex; gap: 8px; }
.model-add-row .input { flex: 1; }

/* 手动模板 */
.setup-panel { padding: 18px 20px; margin-bottom: 16px; }
.setup-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.setup-panel-head.compact { margin-bottom: 12px; }
.template-row { display: flex; flex-wrap: wrap; gap: 8px; }
.template-type-chip {
  min-height: var(--button-height-sm);
  padding: 0 14px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--button-bg);
  color: var(--text-1);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition: all 0.16s var(--ease-out);
}
.template-type-chip:hover { background: var(--button-bg-hover); color: var(--text-0); }
.template-type-chip:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }

/* ===== 内容语言选择器（通用 tab） ===== */
.lang-picker { display: flex; gap: 2px; padding: 3px; border-radius: var(--radius-pill); background: var(--overlay-track); }
.lang-option {
  min-height: 30px;
  padding: 0 14px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition: all 0.16s var(--ease-out);
  white-space: nowrap;
}
.lang-option:hover { color: var(--text-0); }
.lang-option.on { background: var(--seg-active-bg); color: var(--text-0); box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
.lang-option:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }

/* ===== FFmpeg 目录（通用 tab） ===== */
.media-dir-actions { display: flex; align-items: center; gap: 8px; flex: 1 1 360px; min-width: 0; }
.media-dir-input { flex: 1; min-width: 0; }

/* 按服务类型分组的配置卡 */
.sections { display: flex; flex-direction: column; gap: 16px; }
.svc-group { overflow: hidden; }
.svc-group-head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}
.svc-group-heading { min-width: 0; }
.svc-group-title { font-size: 14px; font-weight: 700; color: var(--text-0); }
.svc-group-sub { font-size: 11.5px; color: var(--text-3); margin-top: 2px; }
.config-row { display: flex; align-items: center; gap: 12px; padding: 12px 20px; }
.config-row + .config-row { border-top: 1px solid var(--border); }
.provider-badge {
  width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 14px; color: var(--on-accent);
  background: var(--accent);
  box-shadow: 0 1px 4px rgba(0,0,0,0.12);
}
.provider-badge[data-provider="openai"] { background: #10a37f; }
.provider-badge[data-provider="gemini"] { background: #4285f4; }
.provider-badge[data-provider="volcengine"] { background: #ff5c39; }
/* 有厂商图标时用中性底，彩色图标直接展示 */
.provider-badge.has-icon { background: var(--bg-2); }
.provider-badge-icon { width: 20px; height: 20px; object-fit: contain; }
.config-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.config-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.config-name { font-size: 13.5px; font-weight: 650; color: var(--text-0); }
.config-sub { font-size: 11.5px; color: var(--text-3); }
.config-models { display: flex; flex-wrap: wrap; gap: 4px; margin: 3px 0; }
.cfg-model-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-2);
  font-size: 10.5px;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.cfg-model-chip:hover { border-color: var(--accent); color: var(--accent); }
.cfg-model-chip.is-default {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 600;
  cursor: default;
}
.cfg-model-star { fill: currentColor; }
.config-empty { font-size: 12px; color: var(--text-3); padding: 14px 20px; }
.config-switch { display: inline-flex; flex-shrink: 0; cursor: pointer; }
.config-switch input:focus-visible + .switch { box-shadow: 0 0 0 3.5px var(--button-focus); }
.btn-icon.btn-sm { width: 30px; min-width: 30px; height: 30px; min-height: 30px; }

/* Agent */
.agent-card { overflow: hidden; }
.agent-type-badge {
  width: 36px; height: 36px; border-radius: 10px;
  background: var(--accent-bg); color: var(--accent-text);
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; flex-shrink: 0;
}
.agent-card-body { padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 12px; }
/* tab 头在上，body 不再需要顶边框（头自带 border-bottom） */
.agent-card-foot { display: flex; align-items: center; gap: 8px; padding-top: 4px; }

/* Agent 右侧子 tab（System Prompt / Skills）：作为卡片头，与卡片同宽，不再单独悬浮 */
.agent-pane-tabs {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}
.agent-pane-tabs-wrap .agent-pane-tabs { border-bottom: 1px solid var(--border); }
.agent-pane-tabs-wrap { padding: 0; margin-bottom: 14px; overflow: hidden; }
.agent-pane-tabs-nav {
  display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; padding: 3px;
  background: var(--bg-1); border: 1px solid var(--border); border-radius: 10px;
}
.agent-pane-tab {
  padding: 5px 18px; border: none; border-radius: 7px;
  background: transparent; color: var(--text-2);
  font: 600 12px var(--font-body); cursor: pointer;
  white-space: nowrap; text-align: center;
  transition: background 0.15s, color 0.15s;
}
.agent-pane-tab:hover { color: var(--text-0); }
.agent-pane-tab.active { background: var(--accent-bg); color: var(--accent-text); }

/* Agent 编辑语言跟随提示（卡片头右侧只读说明，切换请到「通用」页） */
.agent-lang-follow { font-size: 11px; }

/* 「跟随中文」回退提示 */
.agent-fallback-tag {
  margin-left: 6px;
  background: var(--bg-2); color: var(--text-3);
  font-size: 10px; font-weight: 500;
}

/* 编辑器尽量占满剩余视口高度，仍可手动拖拽 */
.agent-prompt-input { min-height: max(320px, calc(100vh - 340px)); resize: vertical; }
.skill-content-input { min-height: max(300px, calc(100vh - 420px)); resize: vertical; }

/* Skills 布局 */
.skills-layout { display: flex; height: 100%; overflow: hidden; }
.skills-agent-list {
  width: 210px; flex-shrink: 0; border-right: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 4px;
  overflow-y: auto; padding: 20px 10px 16px;  /* 顶 padding 与右侧标题行起点对齐 */
}
.skills-agent-title {
  font-size: 11px; font-weight: 650; letter-spacing: 0.06em;
  color: var(--text-3); padding: 8px 10px 4px;
}
.skills-agent-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; font-size: 13px; font-weight: 550; cursor: pointer;
  border: none; border-radius: var(--radius); background: transparent; color: var(--text-1);
  transition: all 0.16s var(--ease-out); width: 100%; text-align: left;
}
.skills-agent-item:hover { background: var(--bg-hover); color: var(--text-0); }
.skills-agent-item.active { background: var(--accent-bg); color: var(--accent-text); font-weight: 650; }
.skills-agent-item:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }
.skills-agent-item .agent-type-badge { width: 26px; height: 26px; border-radius: 8px; font-size: 13px; }
.skills-agent-label { flex: 1; min-width: 0; }
.skill-count-badge {
  font-size: 10px; font-weight: 700; font-family: var(--font-mono);
  background: var(--bg-active); color: var(--text-2);
  padding: 1px 6px; border-radius: 99px;
}
.skills-agent-item.active .skill-count-badge { background: var(--accent-bg); color: var(--accent-text); }
.skills-main { flex: 1; min-width: 0; }
.skills-head {
  display: flex;
  align-items: flex-start;   /* 以标题块顶部为基线，徽章/按钮对齐标题第一行 */
  gap: 12px;
}
.skills-head .settings-title { line-height: 26px; }
.skills-head .btn { margin-top: -2px; }  /* 视觉上与标题第一行居中（按钮比标题行高） */
.skills-head-badge { width: 32px; height: 32px; font-size: 16px; }
.skills-head-copy { min-width: 0; }
.skills-empty { padding: 48px 24px; text-align: center; }
.skills-empty-icon {
  width: 56px; height: 56px; border-radius: 16px; margin: 0 auto 12px;
  background: var(--accent-bg); color: var(--accent-text);
  display: flex; align-items: center; justify-content: center;
}
.skills-empty-title { font-size: 14px; font-weight: 650; color: var(--text-0); }
.skills-empty-desc { font-size: 12px; color: var(--text-3); margin-top: 4px; }

/* Skill */
.skill-list { display: flex; flex-direction: column; gap: 10px; }
.skill-card { overflow: hidden; }
.skill-card-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; cursor: pointer; transition: background 0.15s; }
.skill-card-head:hover { background: var(--bg-hover); }
.skill-card-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--border); }
.skill-card-foot { display: flex; align-items: center; gap: 8px; }

/* Shared */
.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 12px; font-weight: 550; color: var(--text-1); }
.field-hint { font-size: 11px; color: var(--text-3); margin-top: 2px; }
.required { color: var(--error); }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

/* Dialogs */
.config-dialog { width: min(720px, calc(100vw - 40px)); }
.config-dialog-body { display: flex; flex-direction: column; gap: 14px; }
.cfg-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-0);
}
.cfg-settings-head { font-size: 12px; font-weight: 600; color: var(--text-1); }
.comfy-mode-switch { display: inline-flex; gap: 4px; padding: 3px; border-radius: var(--radius-pill); background: var(--bg-1); width: fit-content; }
.comfy-mode-pill {
  min-height: var(--button-height-sm);
  padding: 0 14px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.16s var(--ease-out);
}
.comfy-mode-pill:hover { color: var(--text-0); }
.comfy-mode-pill.is-active { background: var(--accent); color: #fff; }
.gateway-workflow-row { display: flex; gap: 8px; align-items: center; }
.gateway-workflow-row > :first-child { flex: 1; min-width: 0; }
.gw-error { color: var(--error); }
.cfg-setting-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.cfg-workflow { min-height: 160px; resize: vertical; font-size: 11px; line-height: 1.5; }
.cfg-check { flex-direction: row; align-items: center; gap: 8px; font-size: 12px; color: var(--text-1); }
.cfg-check input { width: 15px; height: 15px; accent-color: var(--accent); }
.skill-dialog { width: 440px; }
.skill-dialog-body { display: flex; flex-direction: column; gap: 12px; }
.dialog-sub { margin-top: 4px; font-size: 12px; color: var(--text-2); }
.test-draft-btn { margin-right: auto; }
.preset-picker { display: flex; flex-wrap: wrap; gap: 8px; }
.preset-pill {
  min-height: var(--button-height-sm);
  padding: 0 14px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--button-bg);
  color: var(--text-1);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition: all 0.16s var(--ease-out);
}
.preset-pill:hover { background: var(--button-bg-hover); color: var(--text-0); }
.preset-pill:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }
.test-result {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-radius: var(--radius-lg);
  padding: 12px 14px;
  border: 1px solid var(--border);
  background: var(--bg-0);
}
.test-result.ok { border-color: var(--success); background: var(--success-bg); }
.test-result.bad { border-color: var(--error); background: var(--error-bg); }
.test-result-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-1);
}
.test-result-url,
.test-result-preview {
  font-size: 11px;
  color: var(--text-2);
  word-break: break-all;
}

/* 存储位置 */
.device-state {
  flex: none;
  align-self: flex-start;
  white-space: nowrap;
}
.device-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}
.device-actions .btn {
  min-height: 36px;
}
.storage-breakdown {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
.migrate-warn {
  color: var(--error);
}
.migrate-dialog {
  width: min(560px, calc(100vw - 32px));
}
.storage-warn {
  color: var(--warning);
}
.storage-blocked {
  color: var(--error);
}
.backup-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
}
.backup-row + .backup-row {
  border-top: 1px solid var(--border);
}
.backup-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 6px;
}
.update-bar {
  width: 220px;
  height: 5px;
  border-radius: 3px;
  background: var(--overlay-track);
  overflow: hidden;
  margin-top: 6px;
}
.update-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.2s ease;
}

/* 配音默认 */
.dub-range { width: 150px; accent-color: var(--accent); }
.dub-select { width: 180px; flex: none; }
.novel-number { width: 110px; }
.novel-select { width: 210px; flex: none; }
.writing-style-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.writing-style-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.writing-style-name { width: 220px; flex: none; }
.writing-style-prompt { width: 100%; resize: vertical; font-size: 12px; line-height: 1.6; }
.novel-stage-row .config-name { white-space: nowrap; }
.dub-number { width: 90px; text-align: right; }
.dub-value { min-width: 48px; text-align: right; font-size: 12px; color: var(--text-2); }
.dub-unit { font-size: 11px; color: var(--text-3); }

/* ===== 分镜拆分方案 ===== */
.breakdown-layout {
  display: grid;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.breakdown-list-card,
.breakdown-editor-card { margin-top: 0 !important; }
.breakdown-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.breakdown-item:first-of-type { margin-top: 0; }
.breakdown-item:hover { border-color: var(--accent); }
.breakdown-item.active { border-color: var(--accent); background: var(--accent-bg); }
.breakdown-editor-card .field { margin-top: 14px; }
.breakdown-empty-hint {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--accent-bg);
  color: var(--accent);
  font-size: 12px;
}
.breakdown-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
@media (max-width: 1180px) {
  .settings-nav { width: 180px; }
  .settings-page.is-dialog-open .settings-scroll { overflow: hidden; }
}
@media (max-width: 900px) {
  .settings-layout { flex-direction: column; }
  .settings-nav {
    width: auto; flex-direction: row; align-items: center; gap: 6px;
    overflow-x: auto; -webkit-overflow-scrolling: touch;
    padding: 8px 10px calc(8px + var(--safe-bottom, 0px));
    border-right: none; border-bottom: 1px solid var(--border);
  }
  .nav-group { flex-direction: row; align-items: center; gap: 4px; }
  .nav-group-label { display: none; }
  .nav-item { width: auto; flex: 0 0 auto; min-height: var(--tap-min, 44px); white-space: nowrap; }
  .settings-content, .settings-tabpanel { min-height: 0; }
  .settings-scroll { padding: 16px; }
  .settings-readonly-banner { width: calc(100% - 32px); }
  .remote-tab-actions { width: 100%; justify-content: flex-start; }
  .remote-tab-actions .btn { min-height: var(--tap-min, 44px); }
  .device-actions { width: 100%; justify-content: flex-start; }
  .device-actions .btn { min-height: var(--tap-min, 44px); }
  .remote-settings-grid { grid-template-columns: 1fr; padding: 12px 16px; }
  .field-row, .cfg-setting-grid, .huobao-quick-row, .breakdown-layout { grid-template-columns: 1fr; }
  .config-row { flex-wrap: wrap; }
  .media-dir-actions { flex: 1 1 100%; }
  .skills-layout { flex-direction: column; overflow: hidden; height: 100%; }
  .skills-agent-list {
    flex: 0 0 auto;
    width: auto; flex-direction: row; overflow-x: auto;
    border-right: none; border-bottom: 1px solid var(--border); padding: 8px 10px;
  }
  .skills-main { flex: 1; min-height: 0; height: auto; }
  .settings-table-scroll { overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; }
  .config-dialog, .skill-dialog {
    width: calc(100vw - 32px);
    max-height: calc(var(--app-vvh, 100dvh) - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 24px);
  }
  .breakdown-layout { grid-template-columns: 1fr; }
}
/* 窄横屏（如 915×412）：竖向页签高度不足，改为顶部横向页签 */
@media (max-width: 1080px) and (max-height: 600px) {
  .settings-layout { flex-direction: column; }
  .settings-nav {
    width: auto; flex-direction: row; align-items: center; gap: 6px;
    overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch;
    padding: 8px 10px calc(8px + var(--safe-bottom, 0px));
    border-right: none; border-bottom: 1px solid var(--border);
  }
  .nav-group { flex-direction: row; align-items: center; gap: 4px; }
  .nav-group-label { display: none; }
  .nav-item { width: auto; flex: 0 0 auto; min-height: var(--tap-min, 44px); white-space: nowrap; }
  .settings-content, .settings-tabpanel { min-height: 0; }
}

/* 粗指针：复合选择器的 scoped 特异性高于全局兜底，需在本页补足命中区 */
@media (hover: none) and (pointer: coarse) {
  .btn-icon.btn-sm { min-width: var(--tap-min); min-height: var(--tap-min); }
}
</style>
