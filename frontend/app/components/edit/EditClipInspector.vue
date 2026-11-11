<template>
  <aside
    class="ed-inspector"
    :class="{ 'is-drawer': drawer }"
    :style="drawer ? { '--ed-insp-vh': `${drawerVh}dvh` } : undefined"
  >
    <!-- 抽屉模式头：拖拽手柄（仅竖屏）+ 标题 + 关闭；桌面无此 chrome -->
    <div v-if="drawer" class="ed-insp-drawer-head">
      <button
        class="ed-insp-grip"
        type="button"
        :aria-label="t('tablet.drawers.inspector')"
        @pointerdown="onGripPointerDown"
      >
        <span></span>
      </button>
      <b>{{ t('tablet.drawers.inspector') }}</b>
      <button
        class="ed-insp-close"
        type="button"
        :title="t('tablet.close')"
        :aria-label="t('tablet.close')"
        @click="$emit('close')"
      >
        <X :size="16" />
      </button>
    </div>
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
            <input inputmode="numeric" :value="formatClockMs(cue.startMs)" @change="onStartInput($event)" />
          </label>
          <label>{{ t('edit.endTime') }}
            <input inputmode="numeric" :value="formatClockMs(cue.endMs)" @change="onEndInput($event)" />
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

      <section class="ed-insp-section">
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

      <section class="ed-insp-section">
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

      <section class="ed-insp-section">
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

    <template v-else-if="overlay">
      <header class="ed-insp-head">
        <b>{{ t(overlayKindLabelKey[overlay.kind] || 'edit.overlayKindVideo') }}</b>
        <span>{{ formatPrecise(overlay.startMs) }} – {{ formatPrecise(overlay.endMs) }}</span>
      </header>

      <section class="ed-insp-section">
        <h4>{{ t('edit.overlayWindow') }}</h4>
        <div class="ed-row">
          <label>{{ t('edit.startTime') }}
            <input inputmode="numeric" :value="formatClockMs(overlay.startMs)" @change="onOverlayStartInput($event)" />
          </label>
          <label>{{ t('edit.endTime') }}
            <input inputmode="numeric" :value="formatClockMs(overlay.endMs)" @change="onOverlayEndInput($event)" />
          </label>
        </div>
        <div class="ed-row">
          <button type="button" :disabled="readonly" @click="nudgeOverlay(-1)">−1 {{ t('edit.frameUnit') }}</button>
          <button type="button" :disabled="readonly" @click="nudgeOverlay(1)">+1 {{ t('edit.frameUnit') }}</button>
          <button type="button" :disabled="readonly" @click="$emit('overlay-align-start')">{{ t('edit.alignPlayheadStart') }}</button>
          <button type="button" :disabled="readonly" @click="$emit('overlay-align-end')">{{ t('edit.alignPlayheadEnd') }}</button>
        </div>
      </section>

      <section v-if="overlay.kind !== 'text'" class="ed-insp-section">
        <h4>{{ t('edit.overlayPicture') }}</h4>
        <label class="ed-insp-field">
          <span>{{ t('edit.overlayScale') }} {{ overlay.transform.scale.toFixed(2) }}×</span>
          <input
            type="range" min="0.1" max="4" step="0.05" :value="overlay.transform.scale" :disabled="readonly"
            @change="$emit('overlay-transform', { scale: Number($event.target.value) })"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.transformX') }} {{ Math.round(overlay.transform.x * 100) }}%</span>
          <input
            type="range" min="-200" max="200" step="5" :value="Math.round(overlay.transform.x * 100)" :disabled="readonly"
            @change="$emit('overlay-transform', { x: Number($event.target.value) / 100 })"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.transformY') }} {{ Math.round(overlay.transform.y * 100) }}%</span>
          <input
            type="range" min="-200" max="200" step="5" :value="Math.round(overlay.transform.y * 100)" :disabled="readonly"
            @change="$emit('overlay-transform', { y: Number($event.target.value) / 100 })"
          />
        </label>
      </section>

      <section v-if="overlay.kind === 'text'" class="ed-insp-section">
        <h4>{{ t('edit.overlayTextStyle') }}</h4>
        <textarea
          class="ed-insp-textarea"
          rows="2"
          :value="overlay.text?.text ?? ''"
          :disabled="readonly"
          @change="$emit('overlay-text', { text: $event.target.value })"
        />
        <label class="ed-insp-field">
          <span>{{ t('edit.fontSize') }} {{ Math.round(overlay.text?.fontSize ?? 48) }}px</span>
          <input
            type="range" min="8" max="300" step="2" :value="Math.round(overlay.text?.fontSize ?? 48)" :disabled="readonly"
            @change="$emit('overlay-text', { fontSize: Number($event.target.value) })"
          />
        </label>
        <div class="ed-row">
          <label>{{ t('edit.textColor') }} <input type="color" :value="overlay.text?.color ?? '#ffffff'" :disabled="readonly" @change="$emit('overlay-text', { color: $event.target.value })" /></label>
          <label>{{ t('edit.strokeColor') }} <input type="color" :value="overlay.text?.strokeColor ?? '#000000'" :disabled="readonly" @change="$emit('overlay-text', { strokeColor: $event.target.value })" /></label>
        </div>
        <label class="ed-insp-field">
          <span>{{ t('edit.strokeWidth') }} {{ overlay.text?.strokeWidth ?? 0 }}</span>
          <input
            type="range" min="0" max="20" step="1" :value="overlay.text?.strokeWidth ?? 0" :disabled="readonly"
            @change="$emit('overlay-text', { strokeWidth: Number($event.target.value) })"
          />
        </label>
        <label class="ed-check">
          <input
            type="checkbox" :checked="Boolean(overlay.text?.backgroundColor)" :disabled="readonly"
            @change="onTextBgToggle($event.target.checked)"
          /> {{ t('edit.overlayTextBg') }}
        </label>
        <div class="ed-row" v-if="overlay.text?.backgroundColor">
          <label>{{ t('edit.backgroundColor') }} <input type="color" :value="overlay.text.backgroundColor" :disabled="readonly" @change="$emit('overlay-text', { backgroundColor: $event.target.value })" /></label>
        </div>
        <h4>{{ t('edit.overlayTextPosition') }}</h4>
        <div class="ed-nineGrid" role="radiogroup">
          <button v-for="cell in TEXT_GRID" :key="cell.key" type="button"
            :class="{ 'is-on': Math.abs((overlay.text?.x ?? 0.5) - cell.x) < 0.01 && Math.abs((overlay.text?.y ?? 0.5) - cell.y) < 0.01 }"
            :disabled="readonly"
            @click="$emit('overlay-text', { x: cell.x, y: cell.y })"
          />
        </div>
        <div class="ed-row">
          <label>X <input type="range" min="0" max="100" :value="Math.round((overlay.text?.x ?? 0.5) * 100)" :disabled="readonly" @change="$emit('overlay-text', { x: Number($event.target.value) / 100 })" /></label>
          <label>Y <input type="range" min="0" max="100" :value="Math.round((overlay.text?.y ?? 0.5) * 100)" :disabled="readonly" @change="$emit('overlay-text', { y: Number($event.target.value) / 100 })" /></label>
        </div>
      </section>

      <section class="ed-insp-section">
        <h4>{{ t('edit.overlayOpacity') }}</h4>
        <label class="ed-insp-field">
          <span>{{ t('edit.overlayOpacity') }} {{ Math.round((overlay.opacity ?? 1) * 100) }}%</span>
          <input
            type="range" min="0" max="100" step="5" :value="Math.round((overlay.opacity ?? 1) * 100)" :disabled="readonly"
            @change="$emit('overlay-opacity', Number($event.target.value) / 100)"
          />
        </label>
      </section>

      <section class="ed-insp-section">
        <h4>{{ t('edit.overlayFades') }}</h4>
        <label class="ed-insp-field">
          <span>{{ t('edit.fadeIn') }}</span>
          <input
            type="number" min="0" max="1500" step="50" :value="overlay.fadeInMs" :disabled="readonly"
            @change="$emit('overlay-fades', { inMs: Number($event.target.value), outMs: overlay.fadeOutMs })"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.fadeOut') }}</span>
          <input
            type="number" min="0" max="1500" step="50" :value="overlay.fadeOutMs" :disabled="readonly"
            @change="$emit('overlay-fades', { inMs: overlay.fadeInMs, outMs: Number($event.target.value) })"
          />
        </label>
        <p class="ed-insp-text">{{ t('edit.overlayFadeHint') }}</p>
      </section>

      <section class="ed-insp-section">
        <h4>{{ t('edit.actions') }}</h4>
        <div class="ed-insp-actions" v-if="!readonly">
          <button class="is-danger" type="button" @click="$emit('overlay-remove')">
            <Trash2 :size="12" /> {{ t('edit.overlayDelete') }}
          </button>
        </div>
        <p v-else class="ed-insp-text">{{ t('edit.readonlyEdit') }}</p>
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

      <section v-if="nextClip" class="ed-insp-section">
        <h4>{{ t('edit.transition') }}</h4>
        <div class="ed-insp-actions" role="radiogroup">
          <button
            type="button"
            :class="{ 'is-on': !boundaryTransition }"
            :disabled="readonly"
            @click="$emit('transition-remove')"
          >{{ t('edit.transitionNone') }}</button>
          <button
            v-for="option in commonTransitionOptions"
            :key="option.value"
            type="button"
            :class="{ 'is-on': boundaryTransition?.type === option.value }"
            :disabled="readonly"
            @click="$emit('transition-set', { type: option.value, durationMs: boundaryTransition?.durationMs ?? DEFAULT_TRANSITION_MS })"
          >{{ t(option.labelKey) }}</button>
          <button type="button" class="ed-insp-picker-open" :disabled="readonly" @click="$emit('open-transition-picker')">
            {{ t('edit.transitionPickerOpen') }}
          </button>
        </div>
        <label v-if="boundaryTransition" class="ed-insp-field">
          <span>{{ t('edit.transitionDuration') }} {{ boundaryTransition.durationMs }}ms</span>
          <input
            type="range" min="100" max="2000" step="50" :value="boundaryTransition.durationMs" :disabled="readonly"
            @change="$emit('transition-set', { type: boundaryTransition.type, durationMs: Number($event.target.value) })"
          />
        </label>
        <p v-if="transitionGapBlocked" class="ed-insp-warn">{{ t('edit.transitionGapHint') }}</p>
        <p v-else class="ed-insp-text">{{ t('edit.transitionPreviewNote') }}</p>
      </section>

      <section class="ed-insp-section">
        <h4>{{ t('edit.transformTitle') }}</h4>
        <div class="ed-insp-actions" v-if="!readonly">
          <button
            type="button"
            :class="{ 'is-on': clip.transform.rotation !== 0 }"
            @click="$emit('transform-set', { rotation: (clip.transform.rotation + 90) % 360 })"
          >{{ t('edit.transformRotate') }} {{ clip.transform.rotation }}°</button>
          <button
            type="button"
            :class="{ 'is-on': clip.transform.flipH }"
            @click="$emit('transform-set', { flipH: !clip.transform.flipH })"
          >{{ t('edit.transformFlipH') }}</button>
          <button
            type="button"
            :class="{ 'is-on': clip.transform.flipV }"
            @click="$emit('transform-set', { flipV: !clip.transform.flipV })"
          >{{ t('edit.transformFlipV') }}</button>
          <button
            type="button"
            class="is-muted"
            @click="$emit('transform-set', { rotation: 0, flipH: false, flipV: false, scale: 1, x: 0, y: 0 })"
          >{{ t('edit.transformReset') }}</button>
        </div>
        <label class="ed-insp-field">
          <span>{{ t('edit.transformScale') }} {{ clip.transform.scale.toFixed(2) }}×</span>
          <input
            type="range" min="0.5" max="2" step="0.05" :value="clip.transform.scale" :disabled="readonly"
            @change="$emit('transform-set', { scale: Number($event.target.value) })"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.transformX') }} {{ Math.round(clip.transform.x * 100) }}%</span>
          <input
            type="range" min="-100" max="100" step="5" :value="Math.round(clip.transform.x * 100)" :disabled="readonly"
            @change="$emit('transform-set', { x: Number($event.target.value) / 100 })"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.transformY') }} {{ Math.round(clip.transform.y * 100) }}%</span>
          <input
            type="range" min="-100" max="100" step="5" :value="Math.round(clip.transform.y * 100)" :disabled="readonly"
            @change="$emit('transform-set', { y: Number($event.target.value) / 100 })"
          />
        </label>
      </section>

      <section class="ed-insp-section">
        <h4>{{ t('edit.filterTitle') }}</h4>
        <div class="ed-insp-actions" role="radiogroup">
          <button
            v-for="option in FILTER_PRESETS"
            :key="option.value"
            type="button"
            :class="{ 'is-on': (clip.filter?.preset ?? 'none') === option.value }"
            :disabled="readonly"
            @click="$emit('filter-set', { preset: option.value, intensity: filterIntensity })"
          >{{ t(option.labelKey) }}</button>
        </div>
        <label v-if="(clip.filter?.preset ?? 'none') !== 'none'" class="ed-insp-field">
          <span>{{ t('edit.filterIntensity') }} {{ clip.filter?.intensity ?? 0 }}</span>
          <input
            type="range" min="0" max="100" step="5" :value="clip.filter?.intensity ?? 0" :disabled="readonly"
            @change="$emit('filter-set', { preset: clip.filter.preset, intensity: Number($event.target.value) })"
          />
        </label>
        <p class="ed-insp-text">{{ t('edit.previewApprox') }}</p>
      </section>

      <section class="ed-insp-section">
        <h4>{{ t('edit.audioTitle') }}</h4>
        <label class="ed-insp-field">
          <span>{{ t('edit.clipVolume') }} {{ Math.round((clip.volume ?? 1) * 100) }}%</span>
          <input
            type="range" min="0" max="200" step="5" :value="Math.round((clip.volume ?? 1) * 100)" :disabled="readonly"
            @change="$emit('volume-set', Number($event.target.value) / 100)"
          />
        </label>
        <div class="ed-insp-actions" v-if="!readonly">
          <button
            type="button"
            :class="{ 'is-on': !(clip.volume ?? 1) }"
            @click="$emit('volume-set', (clip.volume ?? 1) ? 0 : 1)"
          >{{ t('edit.mute') }}</button>
        </div>
        <label class="ed-insp-field">
          <span>{{ t('edit.audioFadeIn') }}</span>
          <input
            type="number" min="0" max="1500" step="50"
            :value="clipAudioFadeInMs" :disabled="readonly"
            @change="$emit('audio-fades', { inMs: Number($event.target.value), outMs: clipAudioFadeOutMs })"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.audioFadeOut') }}</span>
          <input
            type="number" min="0" max="1500" step="50"
            :value="clipAudioFadeOutMs" :disabled="readonly"
            @change="$emit('audio-fades', { inMs: clipAudioFadeInMs, outMs: Number($event.target.value) })"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.pitchTitle') }} {{ clipPitchSemitones > 0 ? '+' : '' }}{{ clipPitchSemitones }}</span>
          <input
            type="range" min="-12" max="12" step="1"
            :value="clipPitchSemitones" :disabled="readonly"
            @change="$emit('pitch-set', Number($event.target.value))"
          />
        </label>
        <div class="ed-insp-actions" role="radiogroup">
          <button
            v-for="option in AUDIO_EFFECT_PRESETS"
            :key="option"
            type="button"
            :class="{ 'is-on': clipAudioEffectPreset === option }"
            :disabled="readonly"
            @click="$emit('effect-set', option)"
          >{{ t(`edit.audioEffect_${option}`) }}</button>
        </div>
        <p class="ed-insp-text">{{ t('edit.audioEffectHint') }}</p>
        <p class="ed-insp-text">{{ t('edit.volumeHint') }}</p>
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
      <label class="ed-insp-field">
        <span>{{ t('edit.projectFadeIn') }}</span>
        <input
          type="number" min="0" max="3000" step="100"
          :value="Number(state.plan.project.audioFadeInMs) || 0" :disabled="readonly"
          @change="$emit('project-audio-fades', { inMs: Number($event.target.value), outMs: Number(state.plan.project.audioFadeOutMs) || 0 })"
        />
      </label>
      <label class="ed-insp-field">
        <span>{{ t('edit.projectFadeOut') }}</span>
        <input
          type="number" min="0" max="3000" step="100"
          :value="Number(state.plan.project.audioFadeOutMs) || 0" :disabled="readonly"
          @change="$emit('project-audio-fades', { inMs: Number(state.plan.project.audioFadeInMs) || 0, outMs: Number($event.target.value) })"
        />
      </label>
      <p class="ed-insp-text">{{ t('edit.projectFadeHint') }}</p>
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
import { MousePointer2, Scissors, Trash2, X } from 'lucide-vue-next'
import { formatClock, SUBTITLE_FONT_WHITELIST, AUDIO_EFFECT_PRESETS, resolveCueAppearance } from '~/utils/edit-plan'
import { formatPrecise, formatClockMs, parseClockMs, frameDurationMs } from '~/utils/edit-timecode'
import { DEFAULT_TRANSITION_MS, COMMON_TRANSITION_TYPES, transitionTypeOption } from '~/utils/edit-transition-types'
import { FILTER_PRESETS } from '~/utils/edit-filter-presets'
import { clampInspectorDrawerVh } from '~/utils/edit-panel'

const props = defineProps({
  plan: { type: Object, required: true },
  layout: { type: Object, required: true },
  clipId: { type: String, default: '' },
  placement: { type: Object, default: null },
  state: { type: Object, required: true },
  currentMs: { type: Number, default: 0 },
  readonly: { type: Boolean, default: false },
  cue: { type: Object, default: null },
  overlay: { type: Object, default: null },
  drawer: { type: Boolean, default: false },
})
const emit = defineEmits([
  'trim-start', 'trim-end', 'speed', 'gap', 'fades', 'split', 'remove',
  'cue-update', 'cue-apply-all', 'cue-set-default', 'cue-delete', 'cue-split',
  'cue-merge-next', 'cue-align-start', 'cue-align-end', 'cue-follow',
  'transition-set', 'transition-remove', 'open-transition-picker',
  'transform-set', 'filter-set', 'volume-set', 'audio-fades', 'project-audio-fades',
  'pitch-set', 'effect-set',
  'overlay-time', 'overlay-align-start', 'overlay-align-end', 'overlay-transform',
  'overlay-opacity', 'overlay-fades', 'overlay-text', 'overlay-remove',
  'close',
])
const { t } = useI18n()

const clip = computed(() => props.plan.clips.find((item) => item.id === props.clipId) ?? null)
const nextClip = computed(() => {
  const index = props.plan.clips.findIndex((item) => item.id === props.clipId)
  return index >= 0 ? props.plan.clips[index + 1] ?? null : null
})
const boundaryTransition = computed(() => {
  if (!clip.value || !nextClip.value) return null
  return props.plan.transitions.find(
    (item) => item.fromClipId === clip.value.id && item.toClipId === nextClip.value.id,
  ) ?? null
})
const transitionGapBlocked = computed(() => Number(nextClip.value?.gapBeforeMs) > 0)
const commonTransitionOptions = computed(() => (
  COMMON_TRANSITION_TYPES
    .map((value) => transitionTypeOption(value))
    .filter(Boolean)
))
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
// 选滤镜时若当前强度为 0（或未设置）给一个可见的默认强度
const filterIntensity = computed(() => {
  const value = Number(clip.value?.filter?.intensity)
  return Number.isFinite(value) && value > 0 ? value : 50
})
// 旧计划缺省音频淡入淡出时显示回退值（与导出 audioFilter 的回退口径一致）
const clipAudioFadeInMs = computed(() => Number(clip.value?.audioFadeInMs ?? clip.value?.videoFadeInMs ?? 0))
const clipAudioFadeOutMs = computed(() => Number(clip.value?.audioFadeOutMs ?? clip.value?.videoFadeOutMs ?? 0))
// 旧计划缺省音调/特效时显示 0/none（与导出 audioFilter 的缺省口径一致）
const clipPitchSemitones = computed(() => Number(clip.value?.pitchSemitones ?? 0) || 0)
const clipAudioEffectPreset = computed(() => clip.value?.audioEffect?.preset ?? 'none')

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

// ---- 叠加轨编辑（overlay 页） ----
const overlayKindLabelKey = {
  video: 'edit.overlayKindVideo',
  image: 'edit.overlayKindImage',
  text: 'edit.overlayKindText',
}
const TEXT_GRID = [
  { key: 'tl', x: 0.12, y: 0.12 }, { key: 'tc', x: 0.5, y: 0.12 }, { key: 'tr', x: 0.88, y: 0.12 },
  { key: 'ml', x: 0.12, y: 0.5 }, { key: 'mc', x: 0.5, y: 0.5 }, { key: 'mr', x: 0.88, y: 0.5 },
  { key: 'bl', x: 0.12, y: 0.85 }, { key: 'bc', x: 0.5, y: 0.85 }, { key: 'br', x: 0.88, y: 0.85 },
]

function nudgeOverlay(delta) {
  if (!props.overlay) return
  const frame = frameDurationMs(props.plan.project?.fps ?? 30)
  const shift = Math.round(frame * (Number(delta) || 0))
  emit('overlay-time', {
    startMs: Math.max(0, Math.round(props.overlay.startMs) + shift),
    endMs: Math.round(props.overlay.endMs) + shift,
  })
}

function onOverlayStartInput(event) {
  const value = parseClockMs(event.target.value)
  if (!Number.isFinite(value) || !props.overlay) {
    event.target.value = formatClockMs(props.overlay?.startMs ?? 0)
    return
  }
  emit('overlay-time', { startMs: Math.max(0, value), endMs: Math.round(props.overlay.endMs) })
}

function onOverlayEndInput(event) {
  const value = parseClockMs(event.target.value)
  if (!Number.isFinite(value) || !props.overlay) {
    event.target.value = formatClockMs(props.overlay?.endMs ?? 0)
    return
  }
  emit('overlay-time', { startMs: Math.round(props.overlay.startMs), endMs: value })
}

function onTextBgToggle(checked) {
  emit('overlay-text', { backgroundColor: checked ? '#000000' : null })
}

// ---- 抽屉模式：竖屏下拖动顶部手柄调整高度（35–80dvh） ----
const drawerVh = ref(55)
let gripPointerId = null
let gripStartY = 0
let gripStartVh = 55

function onGripPointerMove(event) {
  if (gripPointerId === null || event.pointerId !== gripPointerId) return
  const deltaVh = ((gripStartY - event.clientY) / Math.max(1, window.innerHeight)) * 100
  drawerVh.value = clampInspectorDrawerVh(gripStartVh + deltaVh)
}

function releaseGrip(event) {
  if (gripPointerId === null) return
  if (event && event.pointerId !== gripPointerId) return
  gripPointerId = null
  window.removeEventListener('pointermove', onGripPointerMove)
  window.removeEventListener('pointerup', releaseGrip)
  window.removeEventListener('pointercancel', releaseGrip)
}

function onGripPointerDown(event) {
  if (event.pointerType && event.pointerType !== 'touch') return
  gripPointerId = event.pointerId
  gripStartY = event.clientY
  gripStartVh = drawerVh.value
  if (typeof event.currentTarget.setPointerCapture === 'function') {
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  window.addEventListener('pointermove', onGripPointerMove)
  window.addEventListener('pointerup', releaseGrip)
  window.addEventListener('pointercancel', releaseGrip)
}

onBeforeUnmount(() => releaseGrip(null))
</script>

<style scoped>
.ed-inspector {
  min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
  gap: 10px; padding: 12px; border-left: 1px solid var(--border); background: var(--bg-1);
}
.ed-insp-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ed-insp-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.ed-insp-head span { flex: 0 0 auto; font-size: 9px; color: var(--text-3); }
.ed-insp-section { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
.ed-insp-section h4 { margin: 0; font-size: 10px; font-weight: 650; letter-spacing: .04em; color: var(--text-3); }
.ed-insp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 0; }
.ed-insp-grid div { min-width: 0; }
.ed-insp-grid dt { font-size: 9px; color: var(--text-3); }
.ed-insp-grid dd { margin: 0; overflow: hidden; text-overflow: ellipsis; font-size: 10px; color: var(--text-1); }
.ed-insp-row { display: flex; align-items: center; gap: 4px; }
.ed-insp-row span { flex: 1; font-size: 9px; color: var(--text-3); }
.ed-insp-row button, .ed-insp-actions button {
  height: 22px; padding: 0 6px; display: inline-flex; align-items: center; gap: 3px;
  border: 1px solid var(--border); border-radius: 5px; background: var(--bg-2);
  color: var(--text-1); font-size: 9px; cursor: pointer;
}
.ed-insp-row button:hover, .ed-insp-actions button:hover { border-color: var(--accent); }
.ed-insp-row button.is-on { border-color: var(--accent); color: var(--accent-text); background: var(--accent-bg); }
.ed-insp-row button.is-danger { color: var(--action-danger); border-color: color-mix(in srgb, var(--action-danger) 40%, var(--border)); }
.ed-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 9px; color: var(--text-3); }
.ed-row label { display: inline-flex; align-items: center; gap: 4px; }
.ed-row input[type='range'] { width: 90px; accent-color: var(--accent); }
.ed-row input[type='color'] { width: 24px; height: 20px; padding: 0; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-2); cursor: pointer; }
.ed-row input[type='text'], .ed-row input:not([type]) {
  width: 82px; height: 22px; padding: 0 5px; border: 1px solid var(--border); border-radius: 5px;
  background: var(--bg-2); color: var(--text-0); font-size: 10px; font-variant-numeric: tabular-nums;
}
.ed-row select {
  height: 24px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-2);
  color: var(--text-0); font-size: 10px;
}
.ed-check { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; color: var(--text-2); cursor: pointer; }
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
.ed-insp-field { display: flex; flex-direction: column; gap: 3px; font-size: 9px; color: var(--text-3); }
.ed-insp-field input[type='range'] { width: 100%; accent-color: var(--accent); }
.ed-insp-field input[type='number'] {
  width: 100%; height: 26px; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-2); color: var(--text-0); font-size: 10px;
}
.ed-insp-text { margin: 0; font-size: 10px; color: var(--text-2); line-height: 1.5; }
.ed-insp-warn { margin: 0; font-size: 10px; color: var(--warning); line-height: 1.5; }
.ed-insp-actions { display: flex; flex-wrap: wrap; gap: 5px; }
.ed-insp-actions button.is-on { border-color: var(--accent); color: var(--accent-text); background: var(--accent-bg); }
.ed-insp-actions button.is-danger { color: var(--action-danger); border-color: color-mix(in srgb, var(--action-danger) 40%, var(--border)); }
.ed-insp-actions button.is-muted { color: var(--text-2); }
.ed-insp-actions button:disabled { opacity: .45; cursor: not-allowed; }
.ed-insp-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 8px; color: var(--text-3); }
.ed-insp-empty p { margin: 0; font-size: 10px; }
.ed-insp-hashes { display: flex; flex-direction: column; gap: 3px; margin: 0; }
.ed-insp-hashes div { display: flex; justify-content: space-between; gap: 8px; }
.ed-insp-hashes dt { flex: 0 0 auto; font-size: 9px; color: var(--text-3); }
.ed-insp-hashes dd {
  margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 9px; color: var(--text-2);
}
.ed-insp-warnings { margin: 0; padding-left: 14px; display: flex; flex-direction: column; gap: 4px; }
.ed-insp-warnings li { font-size: 9px; color: var(--text-2); line-height: 1.4; }
.ed-insp-warnings b { color: var(--warning); font-weight: 600; }
/* 抽屉头默认不渲染（仅 drawer 模式出现） */
.ed-insp-drawer-head { display: none; }
@media (max-width: 900px), (max-width: 1000px) and (max-height: 520px) {
  /* 窄屏检查器默认隐藏，仅作为底部/右侧抽屉打开时显示 */
  .ed-inspector { display: none; }
  .ed-inspector.is-drawer {
    display: flex; position: fixed; left: 0; right: 0; bottom: 0; top: auto;
    z-index: 61; width: auto; height: var(--ed-insp-vh, 55dvh);
    max-height: calc(var(--app-vvh, 100dvh) - 12px);
    padding: 10px 12px calc(12px + env(safe-area-inset-bottom));
    border: 1px solid var(--border); border-bottom: 0;
    border-radius: 16px 16px 0 0; background: var(--bg-1);
    box-shadow: 0 -14px 36px rgb(0 0 0 / 35%); overflow-y: auto;
  }
  .ed-insp-drawer-head {
    display: flex; align-items: center; gap: 8px; flex: 0 0 auto;
    padding-bottom: 8px; border-bottom: 1px solid var(--border);
  }
  .ed-insp-drawer-head b {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 12px; color: var(--text-0);
  }
  .ed-insp-grip {
    width: 44px; height: 32px; flex: 0 0 44px; display: inline-flex;
    align-items: center; justify-content: center;
    border: 0; background: transparent; cursor: grab; touch-action: none;
  }
  .ed-insp-grip span { width: 36px; height: 4px; border-radius: 2px; background: var(--border); }
  .ed-insp-close {
    width: 44px; height: 44px; flex: 0 0 44px; display: inline-flex;
    align-items: center; justify-content: center;
    border: 0; border-radius: 8px; background: transparent; color: var(--text-1); cursor: pointer;
  }
  .ed-insp-close:hover { background: var(--bg-hover); }
  /* 横屏：贴右侧全高、无圆角；手柄无意义故隐藏 */
  .ed-inspector.is-drawer.is-landscape {
    top: 0; left: auto; right: 0; bottom: 0; width: min(360px, 60vw);
    height: auto; max-height: none; padding-bottom: 12px;
    border: 0; border-left: 1px solid var(--border); border-radius: 0;
    box-shadow: -14px 0 36px rgb(0 0 0 / 35%);
  }
  .ed-inspector.is-drawer.is-landscape .ed-insp-grip { display: none; }
}
@media (max-width: 1180px) and (hover: none) and (pointer: coarse) {
  /* 粗指针：输入/选择框 16px 防聚焦缩放，操作按钮至少 36px */
  .ed-inspector input, .ed-inspector textarea, .ed-inspector select { font-size: 16px; }
  .ed-inspector .ed-insp-row button,
  .ed-inspector .ed-insp-actions button,
  .ed-inspector .ed-insp-drawer-head button { min-height: 36px; }
}
@media (max-width: 744px) {
  /* 窄屏：信息网格与并排表单行改为单列 */
  .ed-insp-grid { grid-template-columns: minmax(0, 1fr); }
  .ed-row { flex-direction: column; align-items: stretch; }
  .ed-row input[type='range'] { width: 100%; }
}
</style>
