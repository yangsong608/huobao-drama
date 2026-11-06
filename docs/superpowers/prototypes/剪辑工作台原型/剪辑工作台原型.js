(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const FPS = 25;
  const STORE_KEY = 'huobao.edit.prototype.v1';
  const PX_PER_MS = 0.024;
  const PARAMS = new URLSearchParams(location.search);

  const MEDIA = [
    { id: 'sb1', no: '01', name: '雨夜巷口', desc: '全景 · 雨夜 · 08.6s', dur: 12250, scene: 'alley', a: '#1d3446', b: '#070c12' },
    { id: 'sb2', no: '02', name: '门廊对峙', desc: '中景 · 门廊 · 07.8s', dur: 11200, scene: 'door', a: '#3a2a1d', b: '#0d0906' },
    { id: 'sb3', no: '03', name: '周砚特写', desc: '特写 · 人物 · 06.4s', dur: 9600, scene: 'closeup', a: '#2c2a33', b: '#0a0a0f' },
    { id: 'sb4', no: '04', name: '雨幕远景', desc: '远景 · 雨幕 · 06.7s', dur: 8400, scene: 'wide', a: '#172b36', b: '#060b10' },
    { id: 'sb5', no: '05', name: '信纸特写', desc: '特写 · 道具 · 05.2s', dur: 7600, scene: 'letter', a: '#3b3220', b: '#0d0a05' },
    { id: 'sb6', no: '06', name: '雨停天光', desc: '全景 · 清晨 · 06.6s', dur: 9100, scene: 'rainstop', a: '#26333d', b: '#0a1015' }
  ];

  const LINES = [
    { id: 'ln1', speaker: '旁白', text: '雨下得比往年都急。', cueId: 'q1' },
    { id: 'ln2', speaker: '周砚', text: '巷口那盏灯，三年前就该换了。', cueId: 'q2' },
    { id: 'ln3', speaker: '沈疏', text: '你还敢来？', cueId: 'q3' },
    { id: 'ln4', speaker: '周砚', text: '我带来了他留下的东西。', cueId: 'q4' },
    { id: 'ln5', speaker: '沈疏', text: '有些债，总得有人还。', cueId: 'q5' }
  ];

  const DEFAULT_FORM = { preset: 'auto', subtitle: 'soft', audio: 'auto', setCurrent: true };

  const fmt2 = pad2;
  const mediaById = (id) => MEDIA.find((m) => m.id === id) || MEDIA[0];
  const lineById = (id) => LINES.find((l) => l.id === id) || null;
  const cueById = (id) => state.cues.find((c) => c.id === id) || null;
  const clipById = (id) => state.clips.find((c) => c.id === id) || null;

  function tc(ms) {
    const total = Math.max(0, Math.round(ms || 0));
    const f = Math.floor((total % 1000) / 1000 * FPS);
    const s = Math.floor(total / 1000) % 60;
    const m = Math.floor(total / 60000) % 60;
    const h = Math.floor(total / 3600000);
    return `${fmt2(h)}:${fmt2(m)}:${fmt2(s)}:${fmt2(f)}`;
  }

  function tcShort(ms) {
    const total = Math.max(0, Math.round(ms || 0));
    const s = Math.floor(total / 1000) % 60;
    const m = Math.floor(total / 60000);
    return `${fmt2(m)}:${fmt2(s)}`;
  }

  function clockNow() {
    const d = new Date();
    return `今天 ${fmt2(d.getHours())}:${fmt2(d.getMinutes())}`;
  }

  function hashStr(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 9999).toString(36)}`;
  }

  function clipSourceDur(c) { return Math.max(300, c.out - c.in); }
  function clipTimelineDur(c) {
    if (c.ghost) return c.ghostDur || 1600;
    return Math.max(200, Math.round(clipSourceDur(c) / (c.speed || 1)));
  }

  function computeLayout() {
    let t = 0;
    const rows = [];
    state.clips.forEach((c) => {
      const dur = clipTimelineDur(c);
      rows.push({ clip: c, start: t, end: t + dur, dur });
      t += dur + (c.gap || 0);
    });
    return { rows, total: Math.max(0, t) };
  }

  function layoutTotal() { return computeLayout().total; }

  function rowAt(ms) {
    const { rows } = computeLayout();
    for (let i = 0; i < rows.length; i += 1) {
      if (ms >= rows[i].start && ms < rows[i].end && !rows[i].clip.ghost) return rows[i];
    }
    return null;
  }

  function activeCueAt(ms) {
    let best = null;
    state.cues.forEach((c) => {
      if (ms >= c.start && ms < c.end) {
        if (!best || c.start >= best.start) best = c;
      }
    });
    return best;
  }

  function currentCue() {
    return state.selected.type === 'cue' ? cueById(state.selected.id) : null;
  }

  function currentClip() {
    return state.selected.type === 'clip' ? clipById(state.selected.id) : null;
  }

  function buildDefaultData() {
    const clips = [
      { id: 'c1', sourceId: 'sb1', in: 1200, out: 9800, speed: 1, gap: 0, fadeIn: 300, fadeOut: 200, volume: 1, transitionIn: { type: 'none', duration: 0 } },
      { id: 'c2', sourceId: 'sb2', in: 0, out: 8600, speed: 1.1, gap: 0, fadeIn: 0, fadeOut: 0, volume: 1, transitionIn: { type: 'dissolve', duration: 400 } },
      { id: 'c3', sourceId: 'sb3', in: 800, out: 7200, speed: 1, gap: 0, fadeIn: 0, fadeOut: 0, volume: 1, transitionIn: { type: 'dissolve', duration: 600 } },
      { id: 'c4', sourceId: 'sb4', in: 400, out: 6400, speed: 0.9, gap: 500, fadeIn: 300, fadeOut: 300, volume: 0.9, transitionIn: { type: 'none', duration: 0 } }
    ];
    const cues = [
      { id: 'q1', lineId: 'ln1', start: 800, end: 3200, style: 'normal', text: '雨下得比往年都急。' },
      { id: 'q2', lineId: 'ln2', start: 4200, end: 6800, style: 'normal', text: '巷口那盏灯，三年前就该换了。' },
      { id: 'q3', lineId: 'ln3', start: 9000, end: 11800, style: 'outline', text: '你还敢来？' },
      { id: 'q4', lineId: 'ln4', start: 15900, end: 18600, style: 'normal', text: '我带来了他留下的东西。' },
      { id: 'q5', lineId: 'ln5', start: 23200, end: 26200, style: 'box', text: '有些债，总得有人还。' }
    ];
    const markers = [
      { id: 'm1', at: 0, label: '开场' },
      { id: 'm2', at: 8600, label: '对峙' },
      { id: 'm3', at: 21800, label: '转折' },
      { id: 'm4', at: 28600, label: '收尾' }
    ];
    const total = 29985;
    const data = {
      schema: 1,
      meta: { drama: '长夜将至', episode: 'EP.03', epName: '雨夜来客', width: 1920, height: 1080, fps: 25 },
      clips,
      cues,
      markers,
      mix: { state: 'aligned', rev: 7, time: '今天 14:12', duration: total, hash: 'e7c1a2f0', reason: null },
      currentVersion: 5,
      versions: [],
      exports: [
        {
          id: 'ex_seed', filename: '长夜将至_EP03_剪辑版_横屏高清_v4.mp4',
          path: '/exports/长夜将至/EP03/长夜将至_EP03_剪辑版_横屏高清_v4.mp4',
          preset: 'horizontal-hd', subtitle: 'soft', audio: 'mix', duration: 22818, size: 26.9,
          status: 'completed', current: true, version: 4, createdAt: '今天 13:58', key: 'seed-v4', reused: false
        }
      ],
      form: clone(DEFAULT_FORM),
      mode: 'on',
      exportEnabled: true,
      mediaCollapsed: false,
      mediaTab: 'storyboards',
      search: '',
      snap: true,
      zoom: 1,
      markerBar: true,
      playhead: 1600
    };
    const v5 = { v: 5, note: '当前剪辑 · 4 个片段', at: '今天 14:20', clips: clone(clips), cues: clone(cues), markers: clone(markers) };
    const v4 = { v: 4, note: '粗剪 · 3 个片段', at: '今天 13:52', clips: clone(clips.slice(0, 3)), cues: clone(cues.slice(0, 4)), markers: clone(markers.slice(0, 3)) };
    const v3 = {
      v: 3, note: '初版 · 2 个片段', at: '今天 13:20',
      clips: clone(clips.slice(0, 2).map((c, i) => ({ ...c, id: `old${i}`, transitionIn: { type: 'none', duration: 0 }, gap: 0 }))),
      cues: clone(cues.slice(0, 2)), markers: clone(markers.slice(0, 2))
    };
    data.versions = [v5, v4, v3];
    return data;
  }

  let state = null;
  let history = [];
  let redoStack = [];
  let lastHistoryAt = 0;
  let lastHistoryKey = '';
  let autosaveTimer = null;
  let jobTimer = null;
  let stageMetrics = { pxPerMs: PX_PER_MS, width: 900, total: 0 };
  let preview = { canvas: null, ctx: null, w: 0, h: 0, dpr: 1 };
  let drag = null;
  let toastSeq = 0;
  let offReason = 'off';
  let armedReset = false;
  let armedOff = false;

  const els = {};

  function cacheEls() {
    const ids = [
      'app', 'workspace', 'backBtn', 'episodeBtn', 'modeChip', 'modeChipText', 'mixChip', 'mixChipText',
      'undoBtn', 'redoBtn', 'saveBtn', 'saveText', 'suggestBtn', 'roughBtn', 'versionsBtn', 'versionBadge',
      'mediaToggleBtn', 'shortcutsBtn', 'moreBtn', 'exportBtn', 'exportBtnText', 'exportStrip', 'exportStripPhase',
      'exportStripFill', 'exportStripPct', 'exportStripOpen', 'exportStripCancel', 'recoveryBar', 'recoverySaveBtn',
      'recoveryDiscardBtn', 'readonlyBar', 'readonlyReasonBtn', 'mediaPanel', 'collapseMediaBtn', 'mediaSearch',
      'mediaList', 'mediaFootText', 'addAllBtn', 'previewTitle', 'previewRes', 'previewBody', 'previewScreen',
      'previewCanvas', 'previewSubtitle', 'hudClip', 'hudTc', 'hudSource', 'previewEmpty', 'tcNow', 'tcTotal',
      'homeBtn', 'prevCutBtn', 'playBtn', 'nextCutBtn', 'endBtn', 'markerAddBtn', 'prevMarkerBtn', 'nextMarkerBtn',
      'activeClipLabel', 'clipCount', 'timelineDuration', 'snapBtn', 'zoomOutBtn', 'zoomLabel', 'zoomInBtn',
      'splitBtn', 'markerListBtn', 'timelineScroll', 'timelineStage', 'ruler', 'videoTrack', 'subtitleTrack',
      'audioTrack', 'waveCanvas', 'audioLabel', 'transitionLayer', 'markerLayer', 'playhead', 'snapLine',
      'timelineEmpty', 'markerBar', 'inspector', 'statusDot', 'statusSave', 'statusProject', 'statusMix',
      'statusSelection', 'statusHelpBtn', 'contextMenu', 'mixPopover', 'mixPopTitle', 'mixPopChip', 'mixPopDesc',
      'mixPopRev', 'mixPopTime', 'mixPopDuration', 'mixPopHash', 'mixPopNote', 'mixGotoBtn', 'mixRegenBtn',
      'moreMenu', 'chkReadonly', 'chkExport', 'chkOff', 'chkMixAligned', 'chkMixStale', 'chkMixMissing',
      'resetMenuText', 'exportDialog', 'exportCloseBtn', 'exportFormView', 'exportRunningView', 'exportDoneView',
      'presetOptions', 'presetAutoRes', 'subtitleOptions', 'audioOptions', 'audioAutoHint', 'mixOptionHint',
      'audioWarning', 'exportDuration', 'exportSize', 'exportFilename', 'setCurrentToggle', 'recentExports',
      'exportFormHint', 'exportCancelBtn', 'exportStartBtn', 'runningRing', 'runningPct', 'runningEyebrow',
      'runningTitle', 'runningPhase', 'runningFill', 'runningPhases', 'runningElapsed', 'runningTarget',
      'runningCollapseBtn', 'runningCancelBtn', 'doneEyebrow', 'doneTitle', 'doneDesc', 'doneStats', 'doneNote',
      'doneHint', 'doneCopyBtn', 'doneDeliveryBtn', 'doneOpenBtn', 'versionsMask', 'versionsDrawer',
      'versionsCloseBtn', 'versionsList', 'versionsFootHint', 'createVersionBtn', 'deliveryMask',
      'deliveryDrawer', 'deliveryCloseBtn', 'deliveryList', 'deliveryFootHint', 'deliveryBackBtn',
      'shortcutsDialog', 'shortcutsCloseBtn', 'aboutDialog', 'aboutCloseBtn', 'offOverlay', 'offReasonBtn',
      'offRestoreBtn', 'toastStack', 'tabCountSb', 'tabCountLine'
    ];
    ids.forEach((id) => { els[id] = document.getElementById(id); });
    const tabs = $$('.media-tabs button');
    els.tabs = tabs;
  }

  function toast(text, kind = 'info', ms = 2600) {
    const iconMap = { ok: 'i-check', warn: 'i-alert', danger: 'i-alert', accent: 'i-download', info: 'i-spark' };
    const node = document.createElement('div');
    node.className = `toast is-${kind}`;
    node.dataset.id = String(++toastSeq);
    node.innerHTML = `<svg class="icon"><use href="#${iconMap[kind] || 'i-spark'}"/></svg><span></span>`;
    $('span', node).textContent = text;
    els.toastStack.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 190);
    }, ms);
  }

  function canEdit(showToast = true) {
    if (state.mode === 'off') return false;
    if (state.mode === 'readonly') {
      if (showToast) toast('只读模式：不能修改剪辑计划', 'warn');
      return false;
    }
    return true;
  }

  function pushHistory(key = '') {
    const now = Date.now();
    if (key && key === lastHistoryKey && now - lastHistoryAt < 550) return;
    lastHistoryAt = now;
    lastHistoryKey = key;
    history.push({
      clips: clone(state.clips),
      cues: clone(state.cues),
      markers: clone(state.markers),
      mix: clone(state.mix),
      selected: clone(state.selected),
      currentVersion: state.currentVersion
    });
    if (history.length > 60) history.shift();
    redoStack = [];
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    els.undoBtn.disabled = history.length === 0 || state.mode !== 'on';
    els.redoBtn.disabled = redoStack.length === 0 || state.mode !== 'on';
  }

  function markDirty(reason = 'edit') {
    state.dirty = true;
    state.lastEdit = reason;
    updateSaveState();
    scheduleAutosave();
  }

  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      if (!state.dirty) return;
      persist();
      state.dirty = false;
      updateSaveState(true);
    }, 1800);
  }

  function updateSaveState(auto = false) {
    if (state.dirty) {
      els.saveBtn.className = 'save-pill is-pending';
      els.saveText.textContent = '未保存';
      els.statusDot.className = 'status-dot is-pending';
      els.statusSave.textContent = '草稿有修改';
    } else {
      els.saveBtn.className = 'save-pill is-saved';
      els.saveText.textContent = auto ? '已自动保存' : '已保存';
      els.statusDot.className = 'status-dot';
      els.statusSave.textContent = auto ? '草稿已自动保存' : '草稿已保存';
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ data: state, savedAt: Date.now() }));
    } catch (err) {
      /* storage may be unavailable on file:// in some browsers */
    }
  }

  function loadState() {
    if (PARAMS.get('fresh') === '1') {
      try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
    }
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    } catch (err) {
      stored = null;
    }
    if (stored && stored.data && Array.isArray(stored.data.clips)) {
      const base = buildDefaultData();
      state = Object.assign(base, stored.data);
      state.form = Object.assign(clone(DEFAULT_FORM), stored.data.form || {});
      state.selected = { type: 'none', id: null };
      state.playing = false;
      state.dirty = false;
      state.job = stored.data.job || null;
      if (!state.meta) state.meta = base.meta;
      if (!Array.isArray(state.exports)) state.exports = base.exports;
      if (!Array.isArray(state.versions) || !state.versions.length) state.versions = base.versions;
      if (!state.mix) state.mix = base.mix;
    } else {
      state = buildDefaultData();
      state.selected = { type: 'none', id: null };
      state.playing = false;
      state.dirty = false;
      state.job = null;
    }
    if (!state.mix.reason) state.mix.reason = state.mix.state === 'stale' ? 'timing_changed' : null;
    if (state.mode === 'off') state.mode = 'off';
  }

  function saveNow(explicit = true) {
    clearTimeout(autosaveTimer);
    persist();
    state.dirty = false;
    updateSaveState(!explicit);
    if (explicit) toast('草稿已保存', 'ok');
  }

  function undo() {
    if (!history.length || state.mode !== 'on') return;
    clearTimeout(autosaveTimer);
    redoStack.push({
      clips: clone(state.clips), cues: clone(state.cues), markers: clone(state.markers),
      mix: clone(state.mix), selected: clone(state.selected), currentVersion: state.currentVersion
    });
    const snap = history.pop();
    restoreSnapshot(snap);
    state.dirty = true;
    persist();
    updateSaveState();
    renderAll();
    updateHistoryButtons();
    toast('已撤销', 'info', 1400);
  }

  function redo() {
    if (!redoStack.length || state.mode !== 'on') return;
    history.push({
      clips: clone(state.clips), cues: clone(state.cues), markers: clone(state.markers),
      mix: clone(state.mix), selected: clone(state.selected), currentVersion: state.currentVersion
    });
    const snap = redoStack.pop();
    restoreSnapshot(snap);
    state.dirty = true;
    persist();
    updateSaveState();
    renderAll();
    updateHistoryButtons();
    toast('已重做', 'info', 1400);
  }

  function restoreSnapshot(snap) {
    state.clips = clone(snap.clips);
    state.cues = clone(snap.cues);
    state.markers = clone(snap.markers);
    state.mix = clone(snap.mix);
    state.selected = snap.selected && (snap.selected.type === 'none' || (snap.selected.type === 'clip' ? clipById(snap.selected.id) : cueById(snap.selected.id)))
      ? clone(snap.selected) : { type: 'none', id: null };
    if (snap.currentVersion) state.currentVersion = snap.currentVersion;
    state.playhead = Math.min(state.playhead, layoutTotal());
  }

  function invalidateMix(reason = 'timing_changed') {
    if (state.mix.state === 'aligned') {
      state.mix.state = 'stale';
      state.mix.reason = reason;
    } else if (state.mix.state === 'stale' && !state.mix.reason) {
      state.mix.reason = reason;
    }
  }

  function resolveAudio(choice) {
    if (choice === 'auto') return state.mix.state === 'aligned' ? 'mix' : 'clip';
    return choice;
  }

  function planSignature() {
    return state.clips.map((c) => [c.id, c.sourceId, c.in, c.out, c.speed, c.gap, c.ghost ? 1 : 0].join(':')).join('|')
      + '#' + state.cues.map((c) => [c.start, c.end, c.text, c.style].join(':')).join('|')
      + '#' + state.currentVersion;
  }

  function buildExportKey(preset, subtitle, audio) {
    return hashStr([planSignature(), preset, subtitle, audio, state.mix.state, state.mix.rev].join('__'));
  }

  function setPreviewSize() {
    if (!els.previewBody || !els.previewScreen) return;
    const rect = els.previewBody.getBoundingClientRect();
    const availW = Math.max(240, rect.width - 20);
    const availH = Math.max(140, rect.height - 16);
    let w = availW;
    let h = (w * 9) / 16;
    if (h > availH) {
      h = availH;
      w = (h * 16) / 9;
    }
    w = Math.floor(w);
    h = Math.floor(h);
    els.previewScreen.style.width = `${w}px`;
    els.previewScreen.style.height = `${h}px`;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    els.previewCanvas.width = Math.round(w * dpr);
    els.previewCanvas.height = Math.round(h * dpr);
    preview.canvas = els.previewCanvas;
    preview.ctx = els.previewCanvas.getContext('2d');
    preview.w = w;
    preview.h = h;
    preview.dpr = dpr;
    drawPreview();
  }

  function rand(n) {
    const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  function rain(ctx, W, H, t, count, alpha, speed) {
    ctx.save();
    ctx.strokeStyle = `rgba(190, 220, 255, ${alpha})`;
    ctx.lineWidth = 1;
    for (let i = 0; i < count; i += 1) {
      const seed = i + 1;
      const sp = 0.45 + rand(seed * 3.7) * 0.9;
      const x = (rand(seed * 1.7) * (W + 120) + t * speed * sp * 34) % (W + 120) - 60;
      const y = (rand(seed * 2.3) * (H + 160) + t * speed * sp * 260) % (H + 160) - 80;
      const len = 10 + rand(seed * 5.1) * 26;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len * 0.18, y + len);
      ctx.stroke();
    }
    ctx.restore();
  }

  function vignette(ctx, W, H, strength = 0.55) {
    const g = ctx.createRadialGradient(W * 0.5, H * 0.46, Math.min(W, H) * 0.25, W * 0.5, H * 0.5, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawFigure(ctx, x, groundY, height, color, umbrella, lean = 0) {
    const headR = height * 0.085;
    const headY = groundY - height + headR;
    ctx.save();
    ctx.translate(x, 0);
    ctx.rotate(lean);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, headY, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-height * 0.085, headY + headR * 0.6);
    ctx.quadraticCurveTo(-height * 0.13, groundY - height * 0.36, -height * 0.09, groundY - height * 0.06);
    ctx.lineTo(-height * 0.025, groundY - height * 0.06);
    ctx.lineTo(-height * 0.012, groundY - height * 0.42);
    ctx.lineTo(height * 0.03, groundY - height * 0.42);
    ctx.lineTo(height * 0.05, groundY - height * 0.06);
    ctx.lineTo(height * 0.115, groundY - height * 0.06);
    ctx.quadraticCurveTo(height * 0.12, groundY - height * 0.4, height * 0.085, headY + headR * 0.6);
    ctx.closePath();
    ctx.fill();
    if (umbrella) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, height * 0.012);
      ctx.beginPath();
      ctx.moveTo(0, groundY - height * 0.98);
      ctx.lineTo(height * 0.06, groundY - height * 0.48);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(height * 0.02, groundY - height * 0.94, height * 0.24, Math.PI, 0);
      ctx.fillStyle = 'rgba(8, 13, 20, 0.9)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 176, 118, 0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSceneAlley(ctx, W, H, p, t) {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0a1724');
    sky.addColorStop(0.55, '#0b1520');
    sky.addColorStop(1, '#05090d');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    const pan = -p * W * 0.018;
    ctx.save();
    ctx.translate(pan, 0);
    // distant buildings
    for (let i = 0; i < 7; i += 1) {
      const bw = W * (0.11 + rand(i + 3) * 0.1);
      const bx = W * 0.02 + i * W * 0.13;
      const bh = H * (0.22 + rand(i + 8) * 0.25);
      ctx.fillStyle = i % 2 ? 'rgba(13, 23, 33, 0.95)' : 'rgba(9, 17, 26, 0.95)';
      ctx.fillRect(bx, H * 0.52 - bh, bw, bh + H * 0.2);
      for (let w = 0; w < 6; w += 1) {
        if (rand(i * 9 + w * 3.1) > 0.68) {
          ctx.fillStyle = `rgba(255, 190, 120, ${0.12 + rand(i + w) * 0.2})`;
          ctx.fillRect(bx + bw * (0.16 + (w % 3) * 0.27), H * 0.52 - bh + H * 0.04 + Math.floor(w / 3) * H * 0.08, bw * 0.1, H * 0.024);
        }
      }
    }
    // wet ground
    const ground = ctx.createLinearGradient(0, H * 0.6, 0, H);
    ground.addColorStop(0, '#0a1219');
    ground.addColorStop(1, '#03070b');
    ctx.fillStyle = ground;
    ctx.fillRect(0, H * 0.6, W, H * 0.4);
    // lamp
    const lampX = W * 0.76;
    const lampY = H * 0.27;
    const glow = ctx.createRadialGradient(lampX, lampY, 0, lampX, lampY, H * 0.34);
    glow.addColorStop(0, 'rgba(255, 186, 120, 0.5)');
    glow.addColorStop(0.22, 'rgba(255, 166, 92, 0.16)');
    glow.addColorStop(1, 'rgba(255, 166, 92, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(lampX - H * 0.4, lampY - H * 0.4, H * 0.8, H * 0.8);
    ctx.strokeStyle = 'rgba(170, 190, 205, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lampX, H * 0.6);
    ctx.lineTo(lampX, lampY + H * 0.02);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 214, 160, 0.95)';
    ctx.beginPath();
    ctx.arc(lampX, lampY, Math.max(3, H * 0.012), 0, Math.PI * 2);
    ctx.fill();
    // reflection
    const refl = ctx.createLinearGradient(0, H * 0.62, 0, H);
    refl.addColorStop(0, 'rgba(255, 170, 100, 0.2)');
    refl.addColorStop(1, 'rgba(255, 170, 100, 0)');
    ctx.fillStyle = refl;
    ctx.fillRect(lampX - W * 0.035, H * 0.62, W * 0.07, H * 0.36);
    drawFigure(ctx, W * 0.38, H * 0.86, H * 0.52, 'rgba(4, 8, 12, 0.96)', true, -0.015);
    ctx.restore();
    rain(ctx, W, H, t, 150, 0.16, 1);
    vignette(ctx, W, H, 0.58);
  }

  function drawSceneDoor(ctx, W, H, p, t) {
    const wall = ctx.createLinearGradient(0, 0, W, H);
    wall.addColorStop(0, '#191410');
    wall.addColorStop(0.6, '#0d0c0c');
    wall.addColorStop(1, '#07090c');
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, W, H);
    const push = 1 + p * 0.03;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(push, push);
    ctx.translate(-W / 2, -H / 2);
    // doorway
    const dx = W * 0.14;
    const dw = W * 0.3;
    const dy = H * 0.12;
    const dh = H * 0.76;
    ctx.fillStyle = '#05070a';
    ctx.fillRect(dx - 8, dy - 8, dw + 16, dh + 16);
    const doorGlow = ctx.createLinearGradient(dx, dy, dx + dw, dy + dh);
    doorGlow.addColorStop(0, 'rgba(255, 186, 110, 0.7)');
    doorGlow.addColorStop(0.55, 'rgba(166, 96, 48, 0.34)');
    doorGlow.addColorStop(1, 'rgba(20, 16, 14, 0.1)');
    ctx.fillStyle = doorGlow;
    ctx.fillRect(dx, dy, dw, dh);
    // doorframe
    ctx.strokeStyle = 'rgba(120, 96, 70, 0.5)';
    ctx.lineWidth = Math.max(2, W * 0.004);
    ctx.strokeRect(dx, dy, dw, dh);
    // rain outside sliver
    ctx.save();
    ctx.beginPath();
    ctx.rect(dx, dy, dw, dh);
    ctx.clip();
    rain(ctx, W, H, t, 40, 0.09, 0.5);
    ctx.restore();
    // figures
    drawFigure(ctx, W * 0.31, H * 0.9, H * 0.6, 'rgba(5, 7, 10, 0.96)', false, 0.01);
    drawFigure(ctx, W * 0.68, H * 0.9, H * 0.58, 'rgba(12, 9, 7, 0.95)', false, -0.008);
    // warm rim light on right figure
    ctx.fillStyle = 'rgba(255, 177, 105, 0.13)';
    ctx.fillRect(W * 0.6, H * 0.3, W * 0.18, H * 0.6);
    ctx.restore();
    vignette(ctx, W, H, 0.62);
  }

  function drawSceneCloseup(ctx, W, H, p, t) {
    const bg = ctx.createRadialGradient(W * 0.58, H * 0.4, H * 0.05, W * 0.5, H * 0.5, H * 0.9);
    bg.addColorStop(0, '#282a31');
    bg.addColorStop(0.45, '#12141a');
    bg.addColorStop(1, '#06080b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const scale = 1 + p * 0.05;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(scale, scale);
    ctx.translate(-W / 2, -H / 2);
    // face
    ctx.fillStyle = 'rgba(15, 15, 18, 0.98)';
    ctx.beginPath();
    ctx.ellipse(W * 0.47, H * 0.46, W * 0.155, H * 0.27, -0.06, 0, Math.PI * 2);
    ctx.fill();
    // hair
    ctx.fillStyle = 'rgba(6, 6, 8, 1)';
    ctx.beginPath();
    ctx.ellipse(W * 0.46, H * 0.3, W * 0.16, H * 0.13, -0.05, Math.PI * 0.9, Math.PI * 2.05);
    ctx.fill();
    // neck + shoulder
    ctx.fillStyle = 'rgba(10, 10, 13, 1)';
    ctx.beginPath();
    ctx.moveTo(W * 0.38, H * 0.6);
    ctx.lineTo(W * 0.34, H * 1.02);
    ctx.lineTo(W * 0.78, H * 1.02);
    ctx.lineTo(W * 0.58, H * 0.6);
    ctx.closePath();
    ctx.fill();
    // rim light
    ctx.strokeStyle = 'rgba(255, 178, 110, 0.55)';
    ctx.lineWidth = Math.max(2, W * 0.005);
    ctx.beginPath();
    ctx.ellipse(W * 0.5, H * 0.44, W * 0.15, H * 0.26, -0.06, -Math.PI * 0.35, Math.PI * 0.28);
    ctx.stroke();
    // eye highlight
    ctx.fillStyle = 'rgba(230, 235, 240, 0.4)';
    ctx.beginPath();
    ctx.ellipse(W * 0.51, H * 0.42, W * 0.012, H * 0.006, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // bokeh
    for (let i = 0; i < 16; i += 1) {
      const x = W * (0.08 + rand(i + 21) * 0.84);
      const y = H * (0.08 + rand(i + 41) * 0.7);
      const r = H * (0.006 + rand(i + 5) * 0.018);
      ctx.fillStyle = `rgba(255, 190, 130, ${0.02 + rand(i + 9) * 0.06})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    rain(ctx, W, H, t, 55, 0.08, 0.7);
    vignette(ctx, W, H, 0.7);
  }

  function drawSceneWide(ctx, W, H, p, t) {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0d1b27');
    sky.addColorStop(0.55, '#0a141d');
    sky.addColorStop(1, '#04080c');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    // distant light
    const glow = ctx.createRadialGradient(W * 0.66, H * 0.42, 0, W * 0.66, H * 0.42, W * 0.3);
    glow.addColorStop(0, 'rgba(120, 170, 200, 0.1)');
    glow.addColorStop(1, 'rgba(120, 170, 200, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    // rooftops
    for (let layer = 0; layer < 3; layer += 1) {
      ctx.fillStyle = ['rgba(10, 18, 26, 0.92)', 'rgba(7, 13, 20, 0.96)', 'rgba(4, 8, 12, 1)'][layer];
      ctx.beginPath();
      ctx.moveTo(0, H);
      const baseY = H * (0.62 + layer * 0.1);
      for (let i = 0; i <= 10; i += 1) {
        const x = (W / 10) * i;
        const y = baseY - rand(layer * 20 + i) * H * 0.06;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
    // window
    ctx.fillStyle = 'rgba(255, 186, 116, 0.5)';
    ctx.fillRect(W * 0.23, H * 0.58, W * 0.014, H * 0.024);
    ctx.fillStyle = 'rgba(255, 186, 116, 0.09)';
    ctx.fillRect(W * 0.2, H * 0.56, W * 0.075, H * 0.07);
    rain(ctx, W, H, t, 210, 0.13, 1.25);
    vignette(ctx, W, H, 0.6);
  }

  function drawSceneLetter(ctx, W, H, p, t) {
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#2b2115');
    bg.addColorStop(0.5, '#181209');
    bg.addColorStop(1, '#080604');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    // lamp glow
    const glow = ctx.createRadialGradient(W * 0.2, H * 0.12, 0, W * 0.2, H * 0.12, H * 0.8);
    glow.addColorStop(0, 'rgba(255, 186, 108, 0.4)');
    glow.addColorStop(0.4, 'rgba(255, 160, 80, 0.1)');
    glow.addColorStop(1, 'rgba(255, 160, 80, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    const zoom = 1 + p * 0.035;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-W / 2, -H / 2);
    // table
    ctx.fillStyle = '#120c07';
    ctx.fillRect(0, H * 0.62, W, H * 0.38);
    // paper
    ctx.save();
    ctx.translate(W * 0.5, H * 0.55);
    ctx.rotate(-0.04);
    ctx.fillStyle = '#d8c9a8';
    ctx.fillRect(-W * 0.21, -H * 0.18, W * 0.42, H * 0.36);
    ctx.fillStyle = 'rgba(72, 54, 34, 0.55)';
    for (let i = 0; i < 7; i += 1) {
      ctx.fillRect(-W * 0.17, -H * 0.13 + i * H * 0.037, W * (0.22 + rand(i + 3) * 0.16), H * 0.008);
    }
    ctx.restore();
    // hands
    ctx.fillStyle = 'rgba(42, 28, 18, 0.98)';
    ctx.beginPath();
    ctx.ellipse(W * 0.26, H * 0.6, W * 0.07, H * 0.1, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(W * 0.74, H * 0.62, W * 0.07, H * 0.1, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    vignette(ctx, W, H, 0.65);
  }

  function drawSceneRainstop(ctx, W, H, p, t) {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#33404b');
    sky.addColorStop(0.42, '#6b6253');
    sky.addColorStop(0.62, '#2c343b');
    sky.addColorStop(1, '#080c10');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    // dawn glow
    const sun = ctx.createRadialGradient(W * 0.52, H * 0.48, 0, W * 0.52, H * 0.48, W * 0.4);
    sun.addColorStop(0, 'rgba(255, 205, 140, 0.55)');
    sun.addColorStop(0.25, 'rgba(255, 174, 100, 0.22)');
    sun.addColorStop(1, 'rgba(255, 174, 100, 0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, W, H);
    // rooftops
    for (let layer = 0; layer < 3; layer += 1) {
      ctx.fillStyle = ['rgba(22, 27, 30, 0.85)', 'rgba(13, 17, 20, 0.94)', 'rgba(6, 9, 11, 1)'][layer];
      ctx.beginPath();
      ctx.moveTo(0, H);
      const baseY = H * (0.64 + layer * 0.09);
      for (let i = 0; i <= 9; i += 1) {
        ctx.lineTo((W / 9) * i, baseY - rand(layer * 13 + i) * H * 0.05);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
    // fading rain
    rain(ctx, W, H, t, Math.round(60 * (1 - p * 0.7)), 0.07 * (1 - p * 0.6), 0.45);
    // birds
    ctx.strokeStyle = 'rgba(20, 24, 26, 0.7)';
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 5; i += 1) {
      const bx = W * (0.6 + i * 0.035) + Math.sin(t * 0.4 + i) * W * 0.008;
      const by = H * (0.24 + i * 0.018);
      ctx.beginPath();
      ctx.moveTo(bx - 5, by);
      ctx.quadraticCurveTo(bx - 2, by - 4, bx, by);
      ctx.quadraticCurveTo(bx + 2, by - 4, bx + 5, by);
      ctx.stroke();
    }
    vignette(ctx, W, H, 0.5);
  }

  function drawPreview() {
    const ctx = preview.ctx;
    const W = preview.w;
    const H = preview.h;
    if (!ctx || !W || !H) return;
    ctx.setTransform(preview.dpr, 0, 0, preview.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const row = rowAt(state.playhead);
    const { total } = computeLayout();
    if (!row || !total) {
      ctx.fillStyle = '#05080c';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(226, 232, 240, 0.2)';
      ctx.font = `${Math.max(11, H * 0.028)}px -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(state.clips.length ? '片段间隙' : '时间线为空', W / 2, H / 2);
      return;
    }
    const media = mediaById(row.clip.sourceId);
    const local = clamp((state.playhead - row.start) / Math.max(1, row.dur), 0, 1);
    const t = state.playhead / 1000;
    const scene = media.scene;
    if (scene === 'alley') drawSceneAlley(ctx, W, H, local, t);
    else if (scene === 'door') drawSceneDoor(ctx, W, H, local, t);
    else if (scene === 'closeup') drawSceneCloseup(ctx, W, H, local, t);
    else if (scene === 'wide') drawSceneWide(ctx, W, H, local, t);
    else if (scene === 'letter') drawSceneLetter(ctx, W, H, local, t);
    else drawSceneRainstop(ctx, W, H, local, t);

    // fade in/out simulation
    let fadeAlpha = 0;
    if (row.clip.fadeIn && state.playhead - row.start < row.clip.fadeIn) {
      fadeAlpha = 1 - (state.playhead - row.start) / row.clip.fadeIn;
    }
    if (row.clip.fadeOut && row.end - state.playhead < row.clip.fadeOut) {
      fadeAlpha = Math.max(fadeAlpha, 1 - (row.end - state.playhead) / row.clip.fadeOut);
    }
    if (fadeAlpha > 0) {
      ctx.fillStyle = `rgba(0,0,0,${clamp(fadeAlpha, 0, 0.92)})`;
      ctx.fillRect(0, 0, W, H);
    }
    // subtle film grain
    ctx.fillStyle = 'rgba(255,255,255,0.014)';
    for (let i = 0; i < 18; i += 1) {
      ctx.fillRect(rand(i + state.playhead * 0.0001) * W, rand(i + 9.1) * H, 1, 1);
    }
  }

  function updatePreviewHud() {
    const total = layoutTotal();
    const row = rowAt(state.playhead);
    const cue = activeCueAt(state.playhead);
    els.tcNow.textContent = tc(state.playhead);
    els.tcTotal.textContent = tc(total);
    els.timelineDuration.textContent = tc(total);
    els.playhead.style.left = `${state.playhead * stageMetrics.pxPerMs}px`;
    if (row) {
      const media = mediaById(row.clip.sourceId);
      const src = row.clip.in + (state.playhead - row.start) * (row.clip.speed || 1);
      els.hudClip.textContent = `分镜 ${media.no}`;
      els.hudTc.textContent = tc(state.playhead);
      els.hudSource.textContent = `源 ${tc(src)}`;
      els.previewTitle.textContent = `分镜 ${media.no} · ${media.name}`;
      els.activeClipLabel.textContent = `分镜 ${media.no} · ${media.name}`;
      els.previewEmpty.hidden = true;
    } else {
      els.hudClip.textContent = '空隙';
      els.hudTc.textContent = tc(state.playhead);
      els.hudSource.textContent = '无画面';
      els.previewTitle.textContent = state.clips.length ? '空隙 · 无画面' : '节目监视器';
      els.activeClipLabel.textContent = state.clips.length ? '空隙' : '未选择片段';
      els.previewEmpty.hidden = state.clips.length > 0;
    }
    if (cue) {
      els.previewSubtitle.hidden = false;
      els.previewSubtitle.textContent = cue.text;
      els.previewSubtitle.className = `preview-subtitle${cue.style === 'outline' ? ' is-outline' : cue.style === 'box' ? ' is-box' : ''}`;
    } else {
      els.previewSubtitle.hidden = true;
    }
    els.playBtn.querySelector('.icon-play').hidden = state.playing;
    els.playBtn.querySelector('.icon-pause').hidden = !state.playing;
    els.playBtn.setAttribute('aria-label', state.playing ? '暂停' : '播放');
    els.statusSelection.textContent = selectionLabel();
  }

  function selectionLabel() {
    if (state.selected.type === 'clip') {
      const c = clipById(state.selected.id);
      if (!c) return '未选择';
      if (c.ghost) return '已选：空隙';
      const m = mediaById(c.sourceId);
      return `已选：分镜 ${m.no} · ${m.name}`;
    }
    if (state.selected.type === 'cue') {
      const c = cueById(state.selected.id);
      return c ? `已选：字幕「${c.text.slice(0, 12)}${c.text.length > 12 ? '…' : ''}」` : '未选择';
    }
    return '未选择';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function icon(name, cls = 'icon') {
    return `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
  }

  function usedCount() {
    const set = new Set(state.clips.filter((c) => !c.ghost).map((c) => c.sourceId));
    return set.size;
  }

  function renderAll() {
    renderMode();
    renderMedia();
    renderTimeline();
    renderInspector();
    renderMixUI();
    renderMarkerBar();
    renderStatus();
    renderMoreMenu();
    updateSaveState();
    updateHistoryButtons();
  }

  function renderMode() {
    const readonly = state.mode === 'readonly';
    const off = state.mode === 'off';
    els.modeChip.className = `chip chip-mode ${off ? 'is-off' : readonly ? 'is-readonly' : 'is-on'}`;
    els.modeChipText.textContent = off ? '剪辑已关闭' : readonly ? '只读模式' : '剪辑开启';
    els.readonlyBar.hidden = !readonly;
    els.offOverlay.hidden = !off;
    els.recoveryBar.hidden = !state.recovery;
    els.workspace.classList.toggle('media-collapsed', !!state.mediaCollapsed);
    els.splitBtn.disabled = state.mode !== 'on';
    els.suggestBtn.disabled = state.mode !== 'on';
    els.roughBtn.disabled = state.mode !== 'on';
    els.markerAddBtn.disabled = state.mode !== 'on';
    els.addAllBtn.disabled = state.mode !== 'on';
    const exportBlocked = !state.exportEnabled || off;
    els.exportBtn.classList.toggle('is-blocked', exportBlocked);
    const running = state.job && state.job.status === 'running';
    els.exportBtn.classList.toggle('is-running', !!running);
    els.exportBtnText.textContent = running ? `导出中 ${Math.round(state.job.progress || 0)}%` : '导出';
    els.versionBadge.textContent = `v${state.currentVersion}`;
    updateHistoryButtons();
  }

  function renderMedia() {
    els.tabs.forEach((tab) => {
      const active = tab.dataset.tab === state.mediaTab;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    els.tabCountSb.textContent = String(MEDIA.length);
    els.tabCountLine.textContent = String(LINES.length);
    if (state.mediaTab === 'storyboards') {
      els.mediaFootText.textContent = `${usedCount()} / ${MEDIA.length} 已使用`;
      els.addAllBtn.hidden = false;
    } else if (state.mediaTab === 'lines') {
      const placed = LINES.filter((l) => state.cues.some((c) => c.lineId === l.id)).length;
      els.mediaFootText.textContent = `${placed} / ${LINES.length} 条已排入`;
      els.addAllBtn.hidden = true;
    } else {
      els.mediaFootText.textContent = state.mix.state === 'missing' ? '尚未生成混音' : `混音 v${state.mix.rev}`;
      els.addAllBtn.hidden = true;
    }
    const q = state.search.trim().toLowerCase();
    const html = [];
    if (state.mediaTab === 'storyboards') {
      MEDIA.forEach((m) => {
        const used = state.clips.some((c) => !c.ghost && c.sourceId === m.id);
        if (q && !`${m.no} ${m.name} ${m.desc}`.toLowerCase().includes(q)) return;
        const gradient = `--thumb-a:${m.a};--thumb-b:${m.b}`;
        html.push(`
          <button class="media-item ${used ? 'is-used' : ''}" data-media="${m.id}" title="点击加入时间线">
            <span class="media-thumb" style="${gradient}">
              <span class="thumb-no">${m.no}</span>
              ${used ? '<span class="thumb-dot"></span>' : ''}
            </span>
            <span class="media-info"><b>${esc(m.name)}</b><small>${esc(m.desc)}</small></span>
            ${used ? '<span class="used-tag">已用</span>' : `<span class="media-add">${icon('plus', 'icon icon-sm')}</span>`}
          </button>`);
      });
      if (!html.length) html.push('<div class="media-empty">没有匹配分镜<br>试试清空搜索</div>');
    } else if (state.mediaTab === 'lines') {
      LINES.forEach((l) => {
        const cue = state.cues.find((c) => c.lineId === l.id) || null;
        const text = cue ? cue.text : l.text;
        if (q && !`${l.speaker} ${text}`.toLowerCase().includes(q)) return;
        const active = state.selected.type === 'cue' && cue && state.selected.id === cue.id;
        html.push(`
          <button class="line-item ${active ? 'is-active' : ''}" data-line="${l.id}">
            <span class="line-avatar">${esc(l.speaker.slice(0, 1))}</span>
            <span class="line-body">
              <header><b>${esc(l.speaker)}</b><span>${cue ? tcShort(cue.start) : '未排入'}</span></header>
              <p>${esc(text)}</p>
              <small>${cue ? `${tc(cue.start)} → ${tc(cue.end)}` : '尚未加入时间线'}</small>
            </span>
            <span class="line-play">${icon('play', 'icon icon-sm')}</span>
          </button>`);
      });
      if (!html.length) html.push('<div class="media-empty">没有匹配台词</div>');
      if (!state.clips.length) html.push('<div class="media-hint">时间线为空：先加入分镜，再把台词排成字幕。</div>');
    } else {
      const mix = state.mix;
      const chipClass = mix.state === 'aligned' ? 'is-aligned' : mix.state === 'stale' ? 'is-stale' : 'is-missing';
      html.push(`
        <div class="mix-card">
          <header>
            <b>当前混音</b>
            <span class="chip chip-mix ${chipClass}"><span class="chip-dot"></span>${mix.state === 'aligned' ? '已对齐' : mix.state === 'stale' ? '已过期' : '未生成'}</span>
          </header>
          <canvas class="mix-wave" data-wave="mix"></canvas>
          <dl>
            <div><dt>版本</dt><dd class="mono">${mix.state === 'missing' ? '—' : `v${mix.rev}`}</dd></div>
            <div><dt>时长</dt><dd class="mono">${mix.state === 'missing' ? '—' : tc(mix.duration || layoutTotal())}</dd></div>
            <div><dt>生成</dt><dd>${mix.state === 'missing' ? '—' : esc(mix.time)}</dd></div>
            <div><dt>对齐</dt><dd class="mono">${mix.state === 'missing' ? '—' : esc(mix.hash)}</dd></div>
          </dl>
          <div class="mix-actions">
            <button class="btn ghost sm" data-mix-act="goto">${icon('music')}混音台</button>
            <button class="btn primary sm" data-mix-act="regen">${icon('refresh')}${mix.state === 'missing' ? '生成' : '重新生成'}</button>
          </div>
        </div>
        <div class="media-hint">${mix.state === 'aligned' ? '混音与当前剪辑时间轴一致，导出默认使用混音。' : mix.state === 'stale' ? '剪辑时间已修改，混音过期；导出前建议重新生成。' : '本集还没有混音，导出会回退到剪辑原声。'}</div>
        <div class="media-hint">双击时间线空白处可以快速加字幕；右键片段查看更多操作。</div>`);
    }
    els.mediaList.innerHTML = html.join('');
    const mixWave = $('[data-wave="mix"]', els.mediaList);
    if (mixWave) drawMixCardWave(mixWave);
  }

  function drawMixCardWave(canvas) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(120, rect.width);
    const h = Math.max(30, rect.height || 44);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(74, 222, 128, 0.75)');
    grad.addColorStop(1, 'rgba(74, 222, 128, 0.22)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1;
    const bars = Math.floor(w / 2.2);
    for (let i = 0; i < bars; i += 1) {
      const env = 0.25 + rand(i * 2.7) * 0.55 + Math.sin(i * 0.35) * 0.16;
      const amp = Math.max(1, env * (h * 0.42));
      const x = (i / bars) * w;
      ctx.beginPath();
      ctx.moveTo(x, h / 2 - amp);
      ctx.lineTo(x, h / 2 + amp);
      ctx.stroke();
    }
  }

  function pickRulerStep(pxPerMs) {
    const candidates = [250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000];
    for (let i = 0; i < candidates.length; i += 1) {
      if (candidates[i] * pxPerMs >= 62) return candidates[i];
    }
    return 120000;
  }

  function renderRuler(pxPerMs, width) {
    const step = pickRulerStep(pxPerMs);
    const minor = step / 5;
    const total = stageMetrics.total;
    const frag = document.createDocumentFragment();
    const maxMs = Math.max(total + 3000, width / pxPerMs);
    for (let t = 0; t <= maxMs; t += minor) {
      const tick = document.createElement('div');
      tick.className = `ruler-tick${Math.abs(t % step) < 1 ? ' is-major' : ''}`;
      tick.style.left = `${t * pxPerMs}px`;
      frag.appendChild(tick);
    }
    for (let t = 0; t <= maxMs; t += step) {
      const label = document.createElement('div');
      label.className = 'ruler-label';
      label.style.left = `${t * pxPerMs}px`;
      label.textContent = tcShort(t);
      frag.appendChild(label);
    }
    els.ruler.innerHTML = '';
    els.ruler.appendChild(frag);
  }

  function renderTimeline() {
    const { rows, total } = computeLayout();
    stageMetrics.total = total;
    const pxPerMs = PX_PER_MS * state.zoom;
    const scrollW = els.timelineScroll.clientWidth || 820;
    const width = Math.max(Math.ceil((total + 3000) * pxPerMs), scrollW - 2);
    stageMetrics = { pxPerMs, width, total };
    els.timelineStage.style.width = `${width}px`;
    els.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    els.clipCount.textContent = `${state.clips.filter((c) => !c.ghost).length} 个片段`;
    els.timelineEmpty.hidden = state.clips.length > 0;
    els.audioLabel.textContent = state.mix.state === 'aligned'
      ? `混音 v${state.mix.rev} · 已对齐`
      : state.mix.state === 'stale' ? `混音 v${state.mix.rev} · 已过期` : '未生成混音 · 使用剪辑原声';

    renderRuler(pxPerMs, width);

    const videoFrag = document.createDocumentFragment();
    rows.forEach((row, index) => {
      const c = row.clip;
      const media = mediaById(c.sourceId);
      const left = row.start * pxPerMs;
      const w = Math.max(12, row.dur * pxPerMs);
      const node = document.createElement('div');
      node.className = `clip${state.selected.type === 'clip' && state.selected.id === c.id ? ' is-selected' : ''}${c.ghost ? ' is-gap' : ''}`;
      node.dataset.clip = c.id;
      node.style.left = `${left}px`;
      node.style.width = `${w}px`;
      node.style.setProperty('--clip-a', media.a);
      node.style.setProperty('--clip-b', media.b);
      node.setAttribute('role', 'button');
      node.tabIndex = 0;
      node.title = c.ghost ? '空隙（无画面）' : `${media.name} · ${media.desc}`;
      if (c.ghost) {
        node.innerHTML = `
          <div class="clip-label">空隙</div>
          <div class="clip-sub">无画面 · ${(clipTimelineDur(c) / 1000).toFixed(1)}s</div>
          <div class="clip-time">${tcShort(row.start)} → ${tcShort(row.end)}</div>
          <div class="clip-tools"><button class="clip-tool" data-clip-act="delete" title="删除空隙">${icon('trash', 'icon')}</button></div>`;
      } else {
        node.innerHTML = `
          <div class="clip-label">${media.no} · ${esc(media.name)}</div>
          <div class="clip-sub">${(c.speed || 1).toFixed(2)}× · ${c.transitionIn && c.transitionIn.type !== 'none' ? '叠化' : '硬切'}</div>
          <div class="clip-time">${tcShort(row.start)} → ${tcShort(row.end)} · 源 ${tcShort(c.in)}</div>
          <div class="clip-tools">
            <button class="clip-tool" data-clip-act="duplicate" title="复制片段">${icon('copy', 'icon')}</button>
            <button class="clip-tool" data-clip-act="delete" title="波纹删除">${icon('trash', 'icon')}</button>
          </div>
          <span class="trim is-start" data-trim="start"></span>
          <span class="trim is-end" data-trim="end"></span>`;
      }
      if (index === 0) node.style.borderTopLeftRadius = '6px';
      videoFrag.appendChild(node);
    });
    els.videoTrack.innerHTML = '';
    els.videoTrack.appendChild(videoFrag);

    const subFrag = document.createDocumentFragment();
    state.cues.forEach((cue) => {
      if (cue.start >= total + 3000) return;
      const node = document.createElement('div');
      node.className = `cue${cue.style === 'outline' ? ' is-outline' : cue.style === 'box' ? ' is-box' : ''}${state.selected.type === 'cue' && state.selected.id === cue.id ? ' is-selected' : ''}`;
      node.dataset.cue = cue.id;
      node.style.left = `${cue.start * pxPerMs}px`;
      node.style.width = `${Math.max(8, (cue.end - cue.start) * pxPerMs)}px`;
      node.title = `${tc(cue.start)} → ${tc(cue.end)} · ${cue.text}`;
      node.innerHTML = `<span>${esc(cue.text)}</span><span class="cue-handle is-start" data-cue-trim="start"></span><span class="cue-handle is-end" data-cue-trim="end"></span>`;
      subFrag.appendChild(node);
    });
    els.subtitleTrack.innerHTML = '';
    els.subtitleTrack.appendChild(subFrag);

    const transFrag = document.createDocumentFragment();
    rows.forEach((row) => {
      const tr = row.clip.transitionIn;
      if (!tr || tr.type === 'none') return;
      const node = document.createElement('div');
      node.className = 'transition';
      node.style.left = `${row.start * pxPerMs}px`;
      node.innerHTML = `<span>${tr.type === 'dissolve' ? '叠化' : '淡入'} ${(tr.duration / 1000).toFixed(1)}s</span><button data-transition-remove="${row.clip.id}" title="移除转场">×</button>`;
      transFrag.appendChild(node);
    });
    els.transitionLayer.innerHTML = '';
    els.transitionLayer.appendChild(transFrag);

    const markerFrag = document.createDocumentFragment();
    state.markers.forEach((m) => {
      const node = document.createElement('button');
      node.className = 'marker';
      node.style.left = `${m.at * pxPerMs}px`;
      node.dataset.marker = m.id;
      node.title = `${m.label || '标记'} · ${tc(m.at)}`;
      node.innerHTML = icon('flag');
      markerFrag.appendChild(node);
    });
    els.markerLayer.innerHTML = '';
    els.markerLayer.appendChild(markerFrag);

    els.playhead.style.left = `${state.playhead * pxPerMs}px`;
    drawTimelineWave(pxPerMs, width, rows);
    updatePreviewHud();
    drawPreview();
    renderMixUI();
    renderMarkerBar();
    renderStatus();
    if (state.job) renderJobStrip();
  }

  function drawTimelineWave(pxPerMs, width, rows) {
    const canvas = els.waveCanvas;
    const h = 26;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    const total = stageMetrics.total || 1;
    const mix = state.mix.state;
    ctx.strokeStyle = mix === 'missing' ? 'rgba(148, 163, 184, 0.36)' : mix === 'stale' ? 'rgba(251, 191, 36, 0.5)' : 'rgba(74, 222, 128, 0.55)';
    ctx.lineWidth = 1;
    const bars = Math.floor(width / 2);
    for (let i = 0; i < bars; i += 1) {
      const at = (i / bars) * width / pxPerMs;
      const inClip = rows.some((r) => at >= r.start && at < r.end && !r.clip.ghost);
      const env = inClip ? 0.2 + rand(i * 1.9) * 0.7 + Math.sin(i * 0.22) * 0.12 : 0.05;
      const amp = Math.max(0.6, env * 9);
      const x = i * 2;
      ctx.beginPath();
      ctx.moveTo(x, h / 2 - amp);
      ctx.lineTo(x, h / 2 + amp);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(7, 11, 17, 0.55)';
    const endX = Math.min(width, total * pxPerMs);
    ctx.fillRect(endX, 0, width - endX, h);
  }

  function renderMarkerBar() {
    els.markerBar.classList.toggle('is-hidden', !state.markerBar);
    els.markerListBtn.classList.toggle('is-on', state.markerBar);
    els.markerListBtn.setAttribute('aria-pressed', String(state.markerBar));
    if (!state.markerBar) return;
    if (!state.markers.length) {
      els.markerBar.innerHTML = '<span class="marker-bar-empty">还没有标记，按 M 在播放头添加</span>';
      return;
    }
    els.markerBar.innerHTML = state.markers.slice().sort((a, b) => a.at - b.at).map((m) => `
      <span class="marker-chip" data-marker-jump="${m.id}" role="button" tabindex="0" style="cursor:pointer" title="跳到 ${tc(m.at)}">
        ${icon('flag', 'icon icon-sm')}
        <span>${esc(m.label || '标记')}</span>
        <span class="mono">${tcShort(m.at)}</span>
        <button data-marker-del="${m.id}" title="删除标记">×</button>
      </span>`).join('');
  }

  function renderMixUI() {
    const mix = state.mix;
    const cls = mix.state === 'aligned' ? 'is-aligned' : mix.state === 'stale' ? 'is-stale' : 'is-missing';
    els.mixChip.className = `chip chip-mix ${cls}`;
    els.mixChipText.textContent = mix.state === 'aligned' ? '混音已对齐' : mix.state === 'stale' ? '混音已过期' : '无混音';
    const reasonText = {
      timing_changed: '剪辑时间轴已修改，混音与画面对应关系不再一致。',
      dialogue_changed: '台词或字幕内容已修改，混音中的对白需要重新生成。',
      legacy_mix: '混音生成于旧版剪辑计划，时间基准可能不一致。',
      missing: '本集还没有生成混音，导出会自动回退到剪辑原声。'
    };
    const desc = mix.state === 'aligned'
      ? '剪辑时间与混音版本一致，导出时默认使用当前混音。'
      : mix.state === 'stale' ? (reasonText[mix.reason] || reasonText.timing_changed)
        : reasonText.missing;
    els.mixPopTitle.textContent = mix.state === 'aligned' ? '混音已对齐' : mix.state === 'stale' ? '混音已过期' : '尚未生成混音';
    els.mixPopChip.className = `chip chip-mix ${cls}`;
    els.mixPopChip.innerHTML = `<span class="chip-dot"></span><span>${mix.state}</span>`;
    els.mixPopDesc.textContent = desc;
    els.mixPopRev.textContent = mix.state === 'missing' ? '—' : `v${mix.rev}`;
    els.mixPopTime.textContent = mix.state === 'missing' ? '—' : mix.time;
    els.mixPopDuration.textContent = mix.state === 'missing' ? '—' : tc(mix.duration || layoutTotal());
    els.mixPopHash.textContent = mix.state === 'missing' ? '—' : mix.hash;
    els.mixPopNote.hidden = mix.state === 'aligned';
    els.mixPopNote.textContent = desc;
    els.mixRegenBtn.innerHTML = mix.state === 'missing'
      ? `${icon('refresh')}生成混音` : `${icon('refresh')}重新生成混音`;
    els.audioLabel.textContent = mix.state === 'aligned'
      ? `混音 v${mix.rev} · 已对齐`
      : mix.state === 'stale' ? `混音 v${mix.rev} · 已过期` : '未生成混音 · 使用剪辑原声';
    const audioLabelColor = mix.state === 'aligned' ? 'var(--success)' : mix.state === 'stale' ? 'var(--warning)' : 'var(--text-3)';
    els.audioLabel.style.color = audioLabelColor;
  }

  function renderStatus() {
    const total = layoutTotal();
    els.statusProject.textContent = `${state.meta.width}×${state.meta.height} · ${state.meta.fps} fps · 16:9`;
    els.statusMix.textContent = state.mix.state === 'aligned'
      ? `混音 v${state.mix.rev} 已对齐`
      : state.mix.state === 'stale' ? `混音 v${state.mix.rev} 已过期` : '未生成混音';
    els.statusSelection.textContent = selectionLabel();
    els.tcTotal.textContent = tc(total);
    els.previewRes.textContent = `${state.meta.width}×${state.meta.height}`;
    els.exportDuration.textContent = tc(total);
    if (state.exportRunning) {
      els.statusMix.textContent = `正在导出 ${Math.round(state.exportRunning.progress || 0)}%`;
    }
  }

  function renderMoreMenu() {
    setCheck(els.chkReadonly, state.mode === 'readonly');
    setCheck(els.chkExport, state.exportEnabled);
    setCheck(els.chkOff, state.mode === 'off');
    setCheck(els.chkMixAligned, state.mix.state === 'aligned');
    setCheck(els.chkMixStale, state.mix.state === 'stale');
    setCheck(els.chkMixMissing, state.mix.state === 'missing');
  }

  function setCheck(node, on) {
    if (!node) return;
    node.innerHTML = on ? icon('check', 'icon') : '';
  }

  function clipRow(c) {
    const { rows } = computeLayout();
    return rows.find((r) => r.clip.id === c.id) || null;
  }

  function renderInspector() {
    if (state.selected.type === 'cue') {
      const cue = cueById(state.selected.id);
      if (cue) { els.inspector.innerHTML = cueInspectorHtml(cue); return; }
    }
    if (state.selected.type === 'clip') {
      const clip = clipById(state.selected.id);
      if (clip) { els.inspector.innerHTML = clipInspectorHtml(clip); return; }
    }
    els.inspector.innerHTML = projectInspectorHtml();
  }

  function cueInspectorHtml(cue) {
    const disabled = state.mode !== 'on' ? 'disabled' : '';
    const line = lineById(cue.lineId);
    return `
      <div class="insp-hero" style="--hero-a:#3a3120;--hero-b:#0c0b07">
        <div class="hero-row"><span class="eyebrow">字幕检查器</span><span class="badge-soft">${cue.style === 'box' ? '底色' : cue.style === 'outline' ? '描边' : '常规'}</span></div>
        <h3>${esc(cue.text.slice(0, 22))}${cue.text.length > 22 ? '…' : ''}</h3>
        <p>${line ? esc(line.speaker) : '手动字幕'} · ${tcShort(cue.start)} → ${tcShort(cue.end)}</p>
      </div>
      <section class="insp-section">
        <h4>${icon('type', 'icon icon-sm')}字幕文本</h4>
        <label class="insp-field">
          <span>文本内容 <b>${cue.text.length} 字</b></span>
          <textarea data-field="cueText" ${disabled}>${esc(cue.text)}</textarea>
        </label>
        <div class="subtitle-preview"><span class="${cue.style === 'outline' ? 'is-outline' : cue.style === 'box' ? 'is-box' : ''}">${esc(cue.text)}</span></div>
      </section>
      <section class="insp-section">
        <h4>${icon('clock', 'icon icon-sm')}时间</h4>
        <div class="insp-grid">
          <label class="insp-field"><span>入点（秒）</span><input type="number" min="0" step="0.1" value="${(cue.start / 1000).toFixed(2)}" data-field="cueStart" ${disabled}></label>
          <label class="insp-field"><span>出点（秒）</span><input type="number" min="0" step="0.1" value="${(cue.end / 1000).toFixed(2)}" data-field="cueEnd" ${disabled}></label>
        </div>
        <div class="insp-btn-row">
          <button data-act="cue-align-start" ${disabled}>起点对齐播放头</button>
          <button data-act="cue-align-end" ${disabled}>终点对齐播放头</button>
        </div>
        <p class="insp-note">字幕只影响文字层，不会让混音过期。拖动字幕块可整体移动。</p>
      </section>
      <section class="insp-section">
        <h4>${icon('brush', 'icon icon-sm')}样式</h4>
        <div class="seg-mini">
          <button data-cue-style="normal" class="${cue.style === 'normal' ? 'is-active' : ''}" ${disabled}>常规</button>
          <button data-cue-style="outline" class="${cue.style === 'outline' ? 'is-active' : ''}" ${disabled}>描边</button>
          <button data-cue-style="box" class="${cue.style === 'box' ? 'is-active' : ''}" ${disabled}>底色</button>
        </div>
        <div class="insp-btn-row" style="margin-top:8px">
          <button data-act="cue-apply-all" ${disabled}>样式应用到全部字幕</button>
        </div>
      </section>
      <section class="insp-section">
        <h4>${icon('flag', 'icon icon-sm')}标记与操作</h4>
        <div class="insp-btn-row">
          <button data-act="cue-marker" ${disabled}>在入点加标记</button>
          <button data-act="cue-split-lines" ${disabled}>按句拆成两条</button>
        </div>
        <div class="insp-actions" style="margin-top:8px">
          <button class="btn danger sm" data-act="cue-delete" ${disabled}>${icon('trash')}删除字幕</button>
        </div>
      </section>`;
  }

  function clipInspectorHtml(clip) {
    const disabled = state.mode !== 'on' ? 'disabled' : '';
    const media = mediaById(clip.sourceId);
    const row = clipRow(clip);
    const start = row ? row.start : 0;
    const dur = clipTimelineDur(clip);
    const maxOut = Math.max(media.dur, clip.out);
    if (clip.ghost) {
      return `
        <div class="insp-hero" style="--hero-a:#22303c;--hero-b:#0a1016">
          <span class="eyebrow">空隙</span>
          <h3>无画面空隙</h3>
          <p>${tcShort(start)} → ${tcShort(start + dur)} · ${(dur / 1000).toFixed(1)} 秒</p>
        </div>
        <section class="insp-section">
          <h4>${icon('clock', 'icon icon-sm')}空隙信息</h4>
          <p class="insp-note">空隙会出现在成片中，作为黑场与静音。删除后后续片段会前移（波纹删除）。</p>
          <div class="insp-actions" style="margin-top:8px">
            <button class="btn danger sm" data-act="clip-delete" ${disabled}>${icon('trash')}删除空隙</button>
          </div>
        </section>`;
    }
    const trans = clip.transitionIn || { type: 'none', duration: 0 };
    return `
      <div class="insp-hero" style="--hero-a:${media.a};--hero-b:${media.b}">
        <div class="hero-row"><span class="eyebrow">片段检查器</span><span class="badge-soft">${media.no}</span></div>
        <h3>${esc(media.name)}</h3>
        <p>${esc(media.desc)} · ${tcShort(start)} → ${tcShort(start + dur)}</p>
      </div>
      <section class="insp-section">
        <h4>${icon('film', 'icon icon-sm')}素材</h4>
        <div class="insp-grid">
          <div><dt>源分镜</dt><dd>分镜 ${media.no}</dd></div>
          <div><dt>源时长</dt><dd class="mono">${tc(media.dur)}</dd></div>
          <div><dt>时间线位置</dt><dd class="mono">${tcShort(start)}</dd></div>
          <div><dt>片段时长</dt><dd class="mono">${(dur / 1000).toFixed(2)}s</dd></div>
        </div>
      </section>
      <section class="insp-section">
        <h4>${icon('scissors', 'icon icon-sm')}修剪与速度</h4>
        <div class="insp-grid">
          <label class="insp-field"><span>入点（秒）</span><input type="number" min="0" max="${Math.floor(maxOut / 1000)}" step="0.1" value="${(clip.in / 1000).toFixed(2)}" data-field="clipIn" ${disabled}></label>
          <label class="insp-field"><span>出点（秒）</span><input type="number" min="0" max="${Math.floor(maxOut / 1000)}" step="0.1" value="${(clip.out / 1000).toFixed(2)}" data-field="clipOut" ${disabled}></label>
        </div>
        <label class="insp-field">
          <span>速度 <b>${(clip.speed || 1).toFixed(2)}×</b></span>
          <div class="range-row"><input type="range" min="0.5" max="2" step="0.05" value="${clip.speed || 1}" data-field="clipSpeed" ${disabled}><b>${(clip.speed || 1).toFixed(2)}×</b></div>
        </label>
        <label class="insp-field">
          <span>尾部空隙 <b>${((clip.gap || 0) / 1000).toFixed(1)}s</b></span>
          <div class="range-row"><input type="range" min="0" max="2000" step="100" value="${clip.gap || 0}" data-field="clipGap" ${disabled}><b>${((clip.gap || 0) / 1000).toFixed(1)}s</b></div>
        </label>
        <p class="insp-note">修改入出点、速度或空隙会让混音过期，导出前需要重新生成混音。</p>
      </section>
      <section class="insp-section">
        <h4>${icon('wand', 'icon icon-sm')}转场与淡入淡出</h4>
        <label class="insp-field">
          <span>入场转场</span>
          <select data-field="clipTransition" ${disabled}>
            <option value="none" ${trans.type === 'none' ? 'selected' : ''}>硬切</option>
            <option value="dissolve" ${trans.type === 'dissolve' ? 'selected' : ''}>叠化</option>
            <option value="fade" ${trans.type === 'fade' ? 'selected' : ''}>淡入</option>
          </select>
        </label>
        <div class="insp-grid">
          <label class="insp-field"><span>淡入（秒）</span><input type="number" min="0" max="2" step="0.1" value="${((clip.fadeIn || 0) / 1000).toFixed(1)}" data-field="clipFadeIn" ${disabled}></label>
          <label class="insp-field"><span>淡出（秒）</span><input type="number" min="0" max="2" step="0.1" value="${((clip.fadeOut || 0) / 1000).toFixed(1)}" data-field="clipFadeOut" ${disabled}></label>
        </div>
        <label class="insp-field">
          <span>片段音量 <b>${Math.round((clip.volume || 1) * 100)}%</b></span>
          <div class="range-row"><input type="range" min="0" max="1.5" step="0.05" value="${clip.volume || 1}" data-field="clipVolume" ${disabled}><b>${Math.round((clip.volume || 1) * 100)}%</b></div>
        </label>
      </section>
      <section class="insp-section">
        <h4>${icon('layers', 'icon icon-sm')}片段操作</h4>
        <div class="insp-btn-row">
          <button data-act="clip-split" ${disabled}>在播放头分割</button>
          <button data-act="clip-duplicate" ${disabled}>复制</button>
          <button data-act="clip-ripple" ${disabled}>波纹删除</button>
          <button data-act="clip-gap" ${disabled}>删除并留空</button>
        </div>
      </section>
      <section class="insp-section">
        <h4>${icon('spark', 'icon icon-sm')}交付信息</h4>
        <div class="insp-grid">
          <div><dt>源区间</dt><dd class="mono">${tcShort(clip.in)} → ${tcShort(clip.out)}</dd></div>
          <div><dt>片段哈希</dt><dd class="mono">${hashStr(`${clip.id}${clip.sourceId}${clip.in}${clip.out}${clip.speed}`)}</dd></div>
          <div><dt>画面分辨率</dt><dd class="mono">${state.meta.width}×${state.meta.height}</dd></div>
          <div><dt>帧率</dt><dd class="mono">${state.meta.fps} fps</dd></div>
        </div>
      </section>`;
  }

  function projectInspectorHtml() {
    const total = layoutTotal();
    return `
      <div class="insp-hero" style="--hero-a:#26313d;--hero-b:#0a0f15">
        <span class="eyebrow">剧集概览</span>
        <h3>${esc(state.meta.drama)} · ${esc(state.meta.episode)}</h3>
        <p>${esc(state.meta.epName)} · ${tc(total)} · ${state.clips.filter((c) => !c.ghost).length} 个片段</p>
      </div>
      <section class="insp-section">
        <div class="insp-empty" style="border:0;padding:6px 0 10px">
          ${icon('film', 'icon icon-xl')}
          <b>未选择片段或字幕</b>
          <p>点击时间线片段、字幕块，或左侧素材，查看并调整参数。</p>
        </div>
        <div class="insp-grid">
          <div><dt>画幅</dt><dd class="mono">${state.meta.width}×${state.meta.height}</dd></div>
          <div><dt>帧率</dt><dd class="mono">${state.meta.fps} fps</dd></div>
          <div><dt>片段</dt><dd class="mono">${state.clips.length}</dd></div>
          <div><dt>字幕</dt><dd class="mono">${state.cues.length}</dd></div>
          <div><dt>标记</dt><dd class="mono">${state.markers.length}</dd></div>
          <div><dt>版本</dt><dd class="mono">v${state.currentVersion}</dd></div>
        </div>
      </section>
      <section class="insp-section">
        <h4>${icon('music', 'icon icon-sm')}混音</h4>
        <div class="insp-grid">
          <div><dt>状态</dt><dd>${state.mix.state === 'aligned' ? '已对齐' : state.mix.state === 'stale' ? '已过期' : '未生成'}</dd></div>
          <div><dt>版本</dt><dd class="mono">${state.mix.state === 'missing' ? '—' : `v${state.mix.rev}`}</dd></div>
        </div>
        <p class="insp-note">导出音频自动：${state.mix.state === 'aligned' ? '使用当前混音' : '回退到剪辑原声'}。</p>
      </section>
      <section class="insp-section">
        <h4>${icon('download', 'icon icon-sm')}交付</h4>
        <p class="insp-note">导出会把成片写入交付中心，复用现有 episode_exports 记录。同计划同参数再次导出会命中复用。</p>
        <div class="insp-actions" style="margin-top:8px">
          <button class="btn primary sm" data-act="open-export" ${!state.exportEnabled || state.mode === 'off' ? 'disabled' : ''}>${icon('download')}导出成片</button>
        </div>
        <button class="insp-link" style="margin-top:6px" data-act="open-versions">查看版本历史</button>
        <button class="insp-link" style="margin-top:5px" data-act="open-delivery">打开交付中心</button>
      </section>
      <section class="insp-section">
        <h4>${icon('keyboard', 'icon icon-sm')}常用操作</h4>
        <p class="insp-note">空格播放 · S 分割 · M 标记 · ⌫ 删除 · ⌘Z 撤销 · ⌘S 保存 · ⌘E 导出</p>
      </section>`;
  }

  function syncPlayhead() {
    const px = stageMetrics.pxPerMs;
    els.playhead.style.left = `${state.playhead * px}px`;
    const total = layoutTotal();
    els.tcNow.textContent = tc(state.playhead);
    els.tcTotal.textContent = tc(total);
    const row = rowAt(state.playhead);
    const cue = activeCueAt(state.playhead);
    if (row) {
      const media = mediaById(row.clip.sourceId);
      const src = row.clip.in + (state.playhead - row.start) * (row.clip.speed || 1);
      els.hudClip.textContent = `分镜 ${media.no}`;
      els.hudTc.textContent = tc(state.playhead);
      els.hudSource.textContent = `源 ${tc(src)}`;
      els.previewTitle.textContent = `分镜 ${media.no} · ${media.name}`;
      els.activeClipLabel.textContent = `分镜 ${media.no} · ${media.name}`;
      els.previewEmpty.hidden = true;
    } else {
      els.hudClip.textContent = '空隙';
      els.hudTc.textContent = tc(state.playhead);
      els.hudSource.textContent = '无画面';
      els.previewTitle.textContent = state.clips.length ? '空隙 · 无画面' : '节目监视器';
      els.activeClipLabel.textContent = state.clips.length ? '空隙' : '未选择片段';
      els.previewEmpty.hidden = state.clips.length > 0;
    }
    if (cue) {
      els.previewSubtitle.hidden = false;
      els.previewSubtitle.textContent = cue.text;
      els.previewSubtitle.className = `preview-subtitle${cue.style === 'outline' ? ' is-outline' : cue.style === 'box' ? ' is-box' : ''}`;
    } else {
      els.previewSubtitle.hidden = true;
    }
    drawPreview();
    const scroll = els.timelineScroll;
    const x = state.playhead * px;
    if (state.playing) {
      if (x < scroll.scrollLeft + 30 || x > scroll.scrollLeft + scroll.clientWidth - 40) {
        scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * 0.35);
      }
    }
  }

  function seek(ms, snapEnabled = false) {
    const total = layoutTotal();
    let next = clamp(ms, 0, total);
    if (snapEnabled) {
      const snapped = snapPosition(next);
      next = snapped.ms;
      if (snapped.hit !== null) showSnapLine(snapped.hit);
    }
    state.playhead = next;
    syncPlayhead();
  }

  function snapPosition(ms) {
    if (!state.snap) return { ms, hit: null };
    const tol = 8 / stageMetrics.pxPerMs;
    const total = layoutTotal();
    const { rows } = computeLayout();
    const points = [0, total];
    rows.forEach((r) => { points.push(r.start, r.end); });
    state.markers.forEach((m) => points.push(m.at));
    points.push(state.playhead);
    let best = null;
    points.forEach((p) => {
      const d = Math.abs(p - ms);
      if (d <= tol && (!best || d < best.d)) best = { d, p };
    });
    return best ? { ms: best.p, hit: best.p } : { ms, hit: null };
  }

  function showSnapLine(at) {
    if (at === null) {
      els.snapLine.hidden = true;
      return;
    }
    els.snapLine.hidden = false;
    els.snapLine.style.left = `${at * stageMetrics.pxPerMs}px`;
  }

  function hideSnapLine() {
    els.snapLine.hidden = true;
  }

  let rafId = null;
  let lastTick = 0;

  function togglePlay() {
    if (state.playing) { pause(); return; }
    if (state.mode === 'off') return;
    if (!state.clips.length) { toast('时间线为空，先加入分镜', 'warn'); return; }
    if (state.playhead >= layoutTotal() - 10) state.playhead = 0;
    state.playing = true;
    lastTick = performance.now();
    updatePlayButton();
    rafId = requestAnimationFrame(tickPlayback);
  }

  function pause() {
    state.playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    updatePlayButton();
    syncPlayhead();
  }

  function tickPlayback(now) {
    if (!state.playing) return;
    const dt = Math.min(140, now - lastTick);
    lastTick = now;
    const total = layoutTotal();
    state.playhead += dt;
    if (state.playhead >= total) {
      state.playhead = total;
      pause();
      return;
    }
    syncPlayhead();
    rafId = requestAnimationFrame(tickPlayback);
  }

  function updatePlayButton() {
    els.playBtn.querySelector('.icon-play').hidden = state.playing;
    els.playBtn.querySelector('.icon-pause').hidden = !state.playing;
    els.playBtn.setAttribute('aria-label', state.playing ? '暂停' : '播放');
  }

  function select(type, id, seekTo = null) {
    state.selected = { type, id };
    if (seekTo !== null) state.playhead = clamp(seekTo, 0, layoutTotal());
    renderTimeline();
    renderMedia();
    renderInspector();
    if (seekTo !== null) syncPlayhead();
  }

  function deselect() {
    state.selected = { type: 'none', id: null };
    renderTimeline();
    renderMedia();
    renderInspector();
  }

  function cutPoints() {
    const total = layoutTotal();
    const pts = [0, total];
    const { rows } = computeLayout();
    rows.forEach((r) => { pts.push(r.start, r.end); });
    return Array.from(new Set(pts.map((p) => Math.round(p)))).sort((a, b) => a - b);
  }

  function jumpCut(dir) {
    const pts = cutPoints();
    const now = state.playhead;
    if (dir > 0) {
      const next = pts.find((p) => p > now + 20);
      if (next !== undefined) seek(next);
    } else {
      const prev = pts.slice().reverse().find((p) => p < now - 20);
      if (prev !== undefined) seek(prev);
    }
  }

  function jumpMarker(dir) {
    const sorted = state.markers.slice().sort((a, b) => a.at - b.at);
    if (!sorted.length) { toast('还没有标记，按 M 添加', 'warn'); return; }
    const now = state.playhead;
    if (dir > 0) {
      const next = sorted.find((m) => m.at > now + 30) || sorted[0];
      seek(next.at);
    } else {
      const prev = sorted.slice().reverse().find((m) => m.at < now - 30) || sorted[sorted.length - 1];
      seek(prev.at);
    }
  }

  function addMarker(at = state.playhead, label) {
    if (!canEdit()) return;
    const exists = state.markers.find((m) => Math.abs(m.at - at) < 180);
    if (exists) { toast('该位置已经有标记', 'warn'); return; }
    pushHistory('marker-add');
    state.markers.push({ id: uid('m'), at: Math.round(at), label: label || `标记 ${state.markers.length + 1}` });
    state.markers.sort((a, b) => a.at - b.at);
    markDirty('marker');
    persist();
    renderTimeline();
    renderMarkerBar();
    renderInspector();
    toast('已添加标记', 'ok', 1400);
  }

  function removeMarker(id) {
    if (!canEdit()) return;
    const m = state.markers.find((x) => x.id === id);
    if (!m) return;
    pushHistory('marker-del');
    state.markers = state.markers.filter((x) => x.id !== id);
    markDirty('marker');
    renderTimeline();
    renderMarkerBar();
    renderInspector();
    toast('已删除标记', 'info', 1400);
  }

  function addCueAt(at, lineId, text) {
    if (!canEdit()) return null;
    const total = layoutTotal();
    const start = clamp(at, 0, Math.max(0, total - 500));
    const line = lineId ? lineById(lineId) : null;
    const body = text || (line ? line.text : '新字幕');
    const dur = clamp(body.length * 220, 1600, 4200);
    const cue = {
      id: uid('q'), lineId: lineId || null, start: Math.round(start),
      end: Math.round(clamp(start + dur, 0, Math.max(total, start + dur))),
      style: 'normal', text: body
    };
    pushHistory('cue-add');
    state.cues.push(cue);
    state.cues.sort((a, b) => a.start - b.start);
    markDirty('cue');
    select('cue', cue.id, cue.start);
    persist();
    toast(line ? `已加入台词：${line.speaker}` : '已添加字幕', 'ok', 1700);
    return cue;
  }

  function addMediaToTimeline(mediaId) {
    if (!canEdit()) return;
    const media = mediaById(mediaId);
    const exists = state.clips.find((c) => !c.ghost && c.sourceId === mediaId);
    if (exists) {
      const row = clipRow(exists);
      select('clip', exists.id, row ? row.start : null);
      toast('该分镜已在时间线', 'info', 1500);
      return;
    }
    pushHistory('media-add');
    const clip = {
      id: uid('c'), sourceId: mediaId, in: 200, out: Math.min(media.dur, 8400),
      speed: 1, gap: 0, fadeIn: 0, fadeOut: 0, volume: 1,
      transitionIn: { type: state.clips.length ? 'dissolve' : 'none', duration: state.clips.length ? 400 : 0 }
    };
    state.clips.push(clip);
    invalidateMix('timing_changed');
    markDirty('media');
    const row = clipRow(clip);
    select('clip', clip.id, row ? row.start : 0);
    persist();
    toast(`已加入：分镜 ${media.no} · ${media.name}`, 'ok', 1700);
  }

  function addAllMedia() {
    if (!canEdit()) return;
    const unused = MEDIA.filter((m) => !state.clips.some((c) => !c.ghost && c.sourceId === m.id));
    if (!unused.length) { toast('素材已全部加入时间线', 'info'); return; }
    pushHistory('media-add-all');
    unused.forEach((m) => {
      state.clips.push({
        id: uid('c'), sourceId: m.id, in: 200, out: Math.min(m.dur, 8400), speed: 1, gap: 0,
        fadeIn: 0, fadeOut: 0, volume: 1,
        transitionIn: { type: state.clips.length ? 'dissolve' : 'none', duration: state.clips.length ? 400 : 0 }
      });
    });
    invalidateMix('timing_changed');
    markDirty('media');
    persist();
    renderAll();
    toast(`已加入 ${unused.length} 个分镜`, 'ok');
  }

  function roughCut() {
    if (!canEdit()) return;
    pushHistory('rough-cut');
    state.clips = MEDIA.map((m, i) => ({
      id: uid('c'), sourceId: m.id, in: 300, out: Math.min(m.dur, 6200), speed: 1,
      gap: i === MEDIA.length - 1 ? 400 : 0, fadeIn: i === 0 ? 300 : 0, fadeOut: i === MEDIA.length - 1 ? 400 : 0,
      volume: 1, transitionIn: { type: i ? 'dissolve' : 'none', duration: i ? 400 : 0 }
    }));
    state.playhead = 0;
    state.selected = { type: 'none', id: null };
    invalidateMix('timing_changed');
    markDirty('rough');
    persist();
    renderAll();
    toast('粗剪已生成：6 个分镜，可继续调整', 'ok', 2200);
  }

  function suggestSubtitle() {
    if (!canEdit()) return;
    const total = layoutTotal();
    if (!total) { toast('先加入分镜，再生成字幕建议', 'warn'); return; }
    const unusedLine = LINES.find((l) => !state.cues.some((c) => c.lineId === l.id));
    if (!unusedLine) { toast('所有台词都已排入时间线', 'info'); return; }
    const cue = addCueAt(state.playhead, unusedLine.id, unusedLine.text);
    if (cue) toast(`已添加字幕建议：${unusedLine.speaker}「${unusedLine.text}」`, 'ok', 2400);
  }

  function splitAtPlayhead() {
    if (!canEdit()) return;
    const row = rowAt(state.playhead);
    if (!row) { toast('播放头不在任何片段上', 'warn'); return; }
    const c = row.clip;
    const offset = state.playhead - row.start;
    if (offset < 250 || row.end - state.playhead < 250) {
      toast('距离片段边缘太近，无法分割', 'warn');
      return;
    }
    pushHistory('split');
    const idx = state.clips.findIndex((x) => x.id === c.id);
    const sourceCut = Math.round(c.in + offset * (c.speed || 1));
    const right = {
      ...clone(c), id: uid('c'), in: sourceCut, gap: c.gap || 0, fadeIn: 0,
      transitionIn: { type: 'none', duration: 0 }
    };
    const left = { ...clone(c), out: sourceCut, gap: 0, fadeOut: 0 };
    state.clips.splice(idx, 1, left, right);
    invalidateMix('timing_changed');
    markDirty('split');
    select('clip', right.id, state.playhead);
    persist();
    toast('已在播放头分割片段', 'ok', 1600);
  }

  function deleteSelected() {
    if (!canEdit()) return;
    if (state.selected.type === 'cue') {
      deleteCue(state.selected.id);
      return;
    }
    if (state.selected.type === 'clip') {
      deleteClip(state.selected.id, true);
      return;
    }
    toast('请先选择片段或字幕', 'info', 1500);
  }

  function deleteCue(id) {
    if (!canEdit()) return;
    const cue = cueById(id);
    if (!cue) return;
    pushHistory('cue-del');
    state.cues = state.cues.filter((c) => c.id !== id);
    if (state.selected.type === 'cue' && state.selected.id === id) state.selected = { type: 'none', id: null };
    markDirty('cue');
    persist();
    renderAll();
    toast('已删除字幕', 'info', 1500);
  }

  function deleteClip(id, ripple) {
    if (!canEdit()) return;
    const clip = clipById(id);
    if (!clip) return;
    pushHistory('clip-del');
    if (ripple || clip.ghost) {
      state.clips = state.clips.filter((c) => c.id !== id);
    } else {
      clip.ghost = true;
      clip.ghostDur = clipTimelineDur(clip);
    }
    if (state.selected.type === 'clip' && state.selected.id === id) state.selected = { type: 'none', id: null };
    state.playhead = Math.min(state.playhead, layoutTotal());
    invalidateMix('timing_changed');
    markDirty('clip');
    persist();
    renderAll();
    toast(ripple ? '已波纹删除片段' : '已留空删除片段', 'info', 1600);
  }

  function duplicateClip(id) {
    if (!canEdit()) return;
    const clip = clipById(id);
    if (!clip) return;
    const idx = state.clips.findIndex((c) => c.id === id);
    pushHistory('clip-dup');
    const copy = { ...clone(clip), id: uid('c'), transitionIn: { type: 'none', duration: 0 }, gap: 0 };
    state.clips.splice(idx + 1, 0, copy);
    invalidateMix('timing_changed');
    markDirty('clip');
    select('clip', copy.id);
    persist();
    toast('已复制片段', 'ok', 1500);
  }

  function cueSplitLines(id) {
    if (!canEdit()) return;
    const cue = cueById(id);
    if (!cue) return;
    const text = cue.text;
    let cut = -1;
    const marks = ['，', '。', '！', '？', ',', '.', '!', '?', '；', ';'];
    for (let i = Math.floor(text.length * 0.25); i < text.length - 2; i += 1) {
      if (marks.includes(text[i])) { cut = i + 1; break; }
    }
    if (cut < 0) {
      cut = Math.max(1, Math.floor(text.length / 2));
    }
    const first = text.slice(0, cut).trim();
    const second = text.slice(cut).trim();
    if (!first || !second) { toast('这段字幕无法拆分', 'warn'); return; }
    pushHistory('cue-split');
    const mid = Math.round((cue.start + cue.end) / 2);
    cue.text = first;
    cue.end = mid - 80;
    cue.lineId = null;
    const next = { id: uid('q'), lineId: null, start: mid + 80, end: Math.max(mid + 700, cue.end + 700), style: cue.style, text: second };
    state.cues.push(next);
    state.cues.sort((a, b) => a.start - b.start);
    markDirty('cue');
    select('cue', next.id, next.start);
    persist();
    toast('已按句拆成两条字幕', 'ok');
  }

  function regenerateMix() {
    if (!canEdit()) return;
    pushHistory('mix-regen');
    els.mixRegenBtn.disabled = true;
    els.mixRegenBtn.classList.add('is-pulsing');
    toast('正在按当前剪辑时间生成混音…', 'accent', 1600);
    setTimeout(() => {
      const rev = (state.mix.rev || 0) + 1;
      state.mix = {
        state: 'aligned', rev, time: clockNow(), duration: layoutTotal(),
        hash: hashStr(`mix-${rev}-${layoutTotal()}-${Date.now()}`), reason: null
      };
      markDirty('mix');
      persist();
      renderAll();
      toast(`混音 v${rev} 已生成并对齐`, 'ok');
    }, 1100);
  }

  function startClipDrag(e, clipId) {
    if (!canEdit()) return;
    const clip = clipById(clipId);
    if (!clip) return;
    const rect = els.timelineStage.getBoundingClientRect();
    drag = {
      type: 'clip', id: clipId, startX: e.clientX, moved: false,
      clickAt: clamp((e.clientX - rect.left) / stageMetrics.pxPerMs, 0, layoutTotal())
    };
    select('clip', clipId);
    e.preventDefault();
  }

  function startClipTrim(e, clipId, side) {
    if (!canEdit()) return;
    const clip = clipById(clipId);
    if (!clip || clip.ghost) return;
    drag = {
      type: 'trimClip', id: clipId, side, startX: e.clientX, moved: false,
      in0: clip.in, out0: clip.out, changed: false, historyPushed: false
    };
    select('clip', clipId);
    e.preventDefault();
    e.stopPropagation();
  }

  function startCueDrag(e, cueId) {
    if (!canEdit()) return;
    const cue = cueById(cueId);
    if (!cue) return;
    drag = {
      type: 'cue', id: cueId, startX: e.clientX, moved: false,
      s0: cue.start, e0: cue.end, changed: false, historyPushed: false
    };
    select('cue', cueId);
    e.preventDefault();
    e.stopPropagation();
  }

  function startCueTrim(e, cueId, side) {
    if (!canEdit()) return;
    const cue = cueById(cueId);
    if (!cue) return;
    drag = {
      type: 'trimCue', id: cueId, side, startX: e.clientX, moved: false,
      s0: cue.start, e0: cue.end, changed: false, historyPushed: false
    };
    select('cue', cueId);
    e.preventDefault();
    e.stopPropagation();
  }

  function startScrub(e) {
    const rect = els.timelineStage.getBoundingClientRect();
    drag = { type: 'scrub', startX: e.clientX, moved: false };
    seek((e.clientX - rect.left) / stageMetrics.pxPerMs, true);
    e.preventDefault();
  }

  function onStagePointerDown(e) {
    if (e.button !== 0) return;
    if (state.mode === 'off') return;
    const trim = e.target.closest('[data-trim]');
    if (trim) {
      const clipNode = trim.closest('[data-clip]');
      if (clipNode) startClipTrim(e, clipNode.dataset.clip, trim.dataset.trim);
      return;
    }
    const cueHandle = e.target.closest('[data-cue-trim]');
    if (cueHandle) {
      const cueNode = cueHandle.closest('[data-cue]');
      if (cueNode) startCueTrim(e, cueNode.dataset.cue, cueHandle.dataset.cueTrim);
      return;
    }
    const clipAct = e.target.closest('[data-clip-act]');
    if (clipAct) {
      const clipNode = clipAct.closest('[data-clip]');
      if (clipNode) {
        e.preventDefault();
        e.stopPropagation();
        const act = clipAct.dataset.clipAct;
        if (act === 'delete') deleteClip(clipNode.dataset.clip, true);
        if (act === 'duplicate') duplicateClip(clipNode.dataset.clip);
      }
      return;
    }
    const clipNode = e.target.closest('[data-clip]');
    if (clipNode) {
      startClipDrag(e, clipNode.dataset.clip);
      return;
    }
    const cueNode = e.target.closest('[data-cue]');
    if (cueNode) {
      startCueDrag(e, cueNode.dataset.cue);
      return;
    }
    const markerNode = e.target.closest('[data-marker]');
    if (markerNode) {
      const m = state.markers.find((x) => x.id === markerNode.dataset.marker);
      if (m) seek(m.at);
      e.preventDefault();
      return;
    }
    const transRemove = e.target.closest('[data-transition-remove]');
    if (transRemove) {
      if (!canEdit()) return;
      const clip = clipById(transRemove.dataset.transitionRemove);
      if (clip) {
        pushHistory('trans-del');
        clip.transitionIn = { type: 'none', duration: 0 };
        markDirty('transition');
        renderAll();
        toast('已移除转场', 'info', 1400);
      }
      return;
    }
    const transition = e.target.closest('.transition');
    if (transition) return;
    if (e.target.closest('.ruler')) {
      startScrub(e);
      return;
    }
    if (e.target === els.videoTrack || e.target === els.subtitleTrack || e.target === els.timelineStage) {
      const rect = els.timelineStage.getBoundingClientRect();
      seek((e.clientX - rect.left) / stageMetrics.pxPerMs, true);
      deselect();
    }
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (drag.type === 'scrub') {
      const rect = els.timelineStage.getBoundingClientRect();
      const ms = clamp((e.clientX - rect.left) / stageMetrics.pxPerMs, 0, layoutTotal());
      seek(ms, true);
      drag.moved = true;
      return;
    }
    const dx = e.clientX - drag.startX;
    if (Math.abs(dx) > 4) drag.moved = true;
    if (!drag.moved) return;
    const px = stageMetrics.pxPerMs;
    const total = layoutTotal();

    if (drag.type === 'clip') {
      const clip = clipById(drag.id);
      const node = $(`[data-clip="${drag.id}"]`);
      if (!clip || !node) return;
      node.classList.add('is-dragging');
      node.style.transform = `translateX(${dx}px)`;
      const rect = els.timelineStage.getBoundingClientRect();
      const at = clamp((e.clientX - rect.left) / px, 0, total);
      const snapped = snapPosition(at);
      showSnapLine(snapped.hit);
      drag.dropIndex = computeDropIndex(at, drag.id);
      return;
    }

    if (drag.type === 'trimClip') {
      const clip = clipById(drag.id);
      if (!clip) return;
      if (!drag.historyPushed) {
        pushHistory('clip-trim');
        drag.historyPushed = true;
      }
      const delta = dx / px;
      const speed = clip.speed || 1;
      if (drag.side === 'start') {
        let nextIn = clamp(drag.in0 + delta * speed, 0, drag.out0 - 300 * speed);
        const row = clipRow(clip);
        const startMs = row ? row.start + (nextIn - drag.in0) / speed : 0;
        const snapped = snapPosition(startMs);
        if (snapped.hit !== null) {
          nextIn = clamp(drag.in0 + (snapped.ms - startMs) * speed + (nextIn - drag.in0), 0, drag.out0 - 300 * speed);
          showSnapLine(snapped.hit);
        } else hideSnapLine();
        clip.in = Math.round(nextIn);
      } else {
        let nextOut = clamp(drag.out0 + delta * speed, drag.in0 + 300 * speed, mediaById(clip.sourceId).dur);
        const row = clipRow(clip);
        const endMs = row ? row.end + (nextOut - drag.out0) / speed : 0;
        const snapped = snapPosition(endMs);
        if (snapped.hit !== null) {
          nextOut = clamp(drag.out0 + (snapped.ms - endMs) * speed + (nextOut - drag.out0), drag.in0 + 300 * speed, mediaById(clip.sourceId).dur);
          showSnapLine(snapped.hit);
        } else hideSnapLine();
        clip.out = Math.round(nextOut);
      }
      drag.changed = true;
      renderTimeline();
      return;
    }

    if (drag.type === 'cue' || drag.type === 'trimCue') {
      const cue = cueById(drag.id);
      if (!cue) return;
      if (!drag.historyPushed) {
        pushHistory(drag.type === 'cue' ? 'cue-move' : 'cue-trim');
        drag.historyPushed = true;
      }
      const delta = dx / px;
      if (drag.type === 'cue') {
        let nextStart = clamp(drag.s0 + delta, 0, Math.max(0, total - (drag.e0 - drag.s0)));
        const snapped = snapPosition(nextStart);
        if (snapped.hit !== null) {
          nextStart = clamp(snapped.ms, 0, Math.max(0, total - (drag.e0 - drag.s0)));
          showSnapLine(snapped.hit);
        } else hideSnapLine();
        cue.start = Math.round(nextStart);
        cue.end = Math.round(nextStart + (drag.e0 - drag.s0));
      } else if (drag.side === 'start') {
        let nextStart = clamp(drag.s0 + delta, 0, drag.e0 - 300);
        const snapped = snapPosition(nextStart);
        if (snapped.hit !== null) nextStart = clamp(snapped.ms, 0, drag.e0 - 300);
        cue.start = Math.round(nextStart);
      } else {
        let nextEnd = clamp(drag.e0 + delta, drag.s0 + 300, Math.max(total, drag.s0 + 700));
        const snapped = snapPosition(nextEnd);
        if (snapped.hit !== null) nextEnd = clamp(snapped.ms, drag.s0 + 300, Math.max(total, drag.s0 + 700));
        cue.end = Math.round(nextEnd);
      }
      drag.changed = true;
      state.cues.sort((a, b) => a.start - b.start);
      renderTimeline();
      return;
    }
  }

  function computeDropIndex(at, movingId) {
    const { rows } = computeLayout();
    const others = state.clips.filter((c) => c.id !== movingId);
    let index = others.length;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].clip.id === movingId) continue;
      if (at < (rows[i].start + rows[i].end) / 2) {
        index = others.findIndex((c) => c.id === rows[i].clip.id);
        if (index < 0) index = others.length;
        return index;
      }
    }
    return index;
  }

  function onPointerUp() {
    if (!drag) return;
    hideSnapLine();
    const d = drag;
    drag = null;
    if (d.type === 'clip') {
      if (!d.moved) {
        seek(d.clickAt);
        return;
      }
      const node = $(`[data-clip="${d.id}"]`);
      if (node) {
        node.classList.remove('is-dragging');
        node.style.transform = '';
      }
      const from = state.clips.findIndex((c) => c.id === d.id);
      if (from < 0) return;
      const clip = state.clips[from];
      const target = d.dropIndex === undefined ? from : d.dropIndex;
      const without = state.clips.filter((c) => c.id !== d.id);
      const clampedTarget = clamp(target, 0, without.length);
      without.splice(clampedTarget, 0, clip);
      const changed = without.findIndex((c) => c.id === d.id) !== from;
      if (changed) {
        pushHistory('clip-reorder');
        state.clips = without;
        invalidateMix('timing_changed');
        markDirty('reorder');
        persist();
        renderAll();
        toast('已调整片段顺序', 'ok', 1600);
      } else {
        renderTimeline();
      }
      return;
    }
    if (d.type === 'trimClip' && d.changed) {
      invalidateMix('timing_changed');
      markDirty('trim');
      persist();
      renderAll();
      toast('已修剪片段，混音需要重新生成', 'warn', 1900);
      return;
    }
    if (d.type === 'cue' || (d.type === 'trimCue' && d.changed)) {
      markDirty('cue');
      persist();
      renderTimeline();
      renderInspector();
      return;
    }
    if (d.type === 'trimCue') {
      renderTimeline();
    }
  }

  function onInspectorClick(e) {
    const styleBtn = e.target.closest('[data-cue-style]');
    if (styleBtn) {
      const cue = currentCue();
      if (!cue) return;
      if (!canEdit()) return;
      pushHistory('cue-style');
      cue.style = styleBtn.dataset.cueStyle;
      markDirty('cue');
      persist();
      renderTimeline();
      renderInspector();
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'open-export') { openExportDialog(); return; }
    if (act === 'open-versions') { openVersions(); return; }
    if (act === 'open-delivery') { openDelivery(); return; }
    if (act === 'clip-split') { splitAtPlayhead(); return; }
    if (act === 'clip-duplicate') { if (currentClip()) duplicateClip(currentClip().id); return; }
    if (act === 'clip-ripple') { if (currentClip()) deleteClip(currentClip().id, true); return; }
    if (act === 'clip-gap') { if (currentClip()) deleteClip(currentClip().id, false); return; }
    if (act === 'clip-delete') { if (currentClip()) deleteClip(currentClip().id, true); return; }
    if (act === 'cue-delete') { if (currentCue()) deleteCue(currentCue().id); return; }
    if (act === 'cue-align-start') {
      const cue = currentCue();
      if (!cue || !canEdit()) return;
      pushHistory('cue-align');
      cue.end = Math.round(Math.max(state.playhead + 300, state.playhead + (cue.end - cue.start)));
      cue.start = Math.round(state.playhead);
      markDirty('cue');
      seek(cue.start);
      renderTimeline();
      renderInspector();
      return;
    }
    if (act === 'cue-align-end') {
      const cue = currentCue();
      if (!cue || !canEdit()) return;
      pushHistory('cue-align');
      cue.end = Math.round(Math.max(state.playhead, cue.start + 300));
      markDirty('cue');
      seek(cue.end);
      renderTimeline();
      renderInspector();
      return;
    }
    if (act === 'cue-apply-all') {
      const cue = currentCue();
      if (!cue || !canEdit()) return;
      pushHistory('cue-apply-all');
      state.cues.forEach((c) => { c.style = cue.style; });
      markDirty('cue');
      persist();
      renderTimeline();
      renderInspector();
      toast('已将样式应用到全部字幕', 'ok', 1600);
      return;
    }
    if (act === 'cue-marker') {
      const cue = currentCue();
      if (cue) addMarker(cue.start, `字幕 · ${cue.text.slice(0, 6)}`);
      return;
    }
    if (act === 'cue-split-lines') {
      if (currentCue()) cueSplitLines(currentCue().id);
    }
  }

  function onInspectorInput(e) {
    const el = e.target.closest('[data-field]');
    if (!el || el.disabled) return;
    const field = el.dataset.field;
    const cue = currentCue();
    const clip = currentClip();
    if (field === 'cueText' && cue) {
      if (!canEdit()) return;
      cue.text = el.value;
      const preview = $('.subtitle-preview span', els.inspector);
      if (preview) preview.textContent = cue.text;
      const count = $('.insp-field > span b', els.inspector);
      if (count && count.textContent.includes('字')) count.textContent = `${cue.text.length} 字`;
      markDirty('cue');
      renderTimeline();
      return;
    }
    if (!clip) return;
    if (field === 'clipSpeed') {
      if (!canEdit()) return;
      pushHistory(`clipSpeed-${clip.id}`);
      clip.speed = Number(el.value);
      const b = el.parentElement.querySelector('b');
      if (b) b.textContent = `${clip.speed.toFixed(2)}×`;
      invalidateMix('timing_changed');
      markDirty('speed');
      renderTimeline();
      return;
    }
    if (field === 'clipGap') {
      if (!canEdit()) return;
      pushHistory(`clipGap-${clip.id}`);
      clip.gap = Number(el.value);
      const b = el.parentElement.querySelector('b');
      if (b) b.textContent = `${(clip.gap / 1000).toFixed(1)}s`;
      invalidateMix('timing_changed');
      markDirty('gap');
      renderTimeline();
      return;
    }
    if (field === 'clipVolume') {
      if (!canEdit()) return;
      pushHistory(`clipVolume-${clip.id}`);
      clip.volume = Number(el.value);
      const b = el.parentElement.querySelector('b');
      if (b) b.textContent = `${Math.round(clip.volume * 100)}%`;
      markDirty('volume');
      return;
    }
  }

  function onInspectorChange(e) {
    const el = e.target.closest('[data-field]');
    if (!el || el.disabled) return;
    const field = el.dataset.field;
    const cue = currentCue();
    const clip = currentClip();
    if (cue) {
      if (field === 'cueStart' || field === 'cueEnd') {
        if (!canEdit()) return;
        const ms = Math.round(Number(el.value) * 1000);
        if (!Number.isFinite(ms)) { renderInspector(); return; }
        pushHistory('cue-time');
        if (field === 'cueStart') cue.start = clamp(ms, 0, cue.end - 300);
        else cue.end = clamp(ms, cue.start + 300, Math.max(layoutTotal(), cue.start + 700));
        state.cues.sort((a, b) => a.start - b.start);
        markDirty('cue');
        persist();
        renderTimeline();
        renderInspector();
        return;
      }
      if (field === 'cueText') {
        markDirty('cue');
        persist();
        renderTimeline();
        return;
      }
    }
    if (!clip) return;
    if (field === 'clipIn' || field === 'clipOut') {
      if (!canEdit()) return;
      const ms = Math.round(Number(el.value) * 1000);
      if (!Number.isFinite(ms)) { renderInspector(); return; }
      pushHistory('clip-trim');
      const sourceMax = mediaById(clip.sourceId).dur;
      if (field === 'clipIn') clip.in = clamp(ms, 0, clip.out - 300);
      else clip.out = clamp(ms, clip.in + 300, sourceMax);
      invalidateMix('timing_changed');
      markDirty('trim');
      persist();
      renderAll();
      toast('已修剪片段，混音需要重新生成', 'warn', 1800);
      return;
    }
    if (field === 'clipFadeIn') {
      if (!canEdit()) return;
      pushHistory('fade');
      clip.fadeIn = clamp(Math.round(Number(el.value) * 1000), 0, 2000);
      markDirty('fade');
      renderTimeline();
      return;
    }
    if (field === 'clipFadeOut') {
      if (!canEdit()) return;
      pushHistory('fade');
      clip.fadeOut = clamp(Math.round(Number(el.value) * 1000), 0, 2000);
      markDirty('fade');
      renderTimeline();
      return;
    }
    if (field === 'clipTransition') {
      if (!canEdit()) return;
      pushHistory('transition');
      clip.transitionIn = el.value === 'none' ? { type: 'none', duration: 0 } : { type: el.value, duration: 400 };
      markDirty('transition');
      persist();
      renderTimeline();
      return;
    }
  }

  function positionPopover(node, anchor, width) {
    const rect = anchor.getBoundingClientRect();
    node.hidden = false;
    const w = width || node.offsetWidth;
    const h = node.offsetHeight;
    let left = Math.min(rect.left, window.innerWidth - w - 10);
    left = Math.max(10, left);
    let top = rect.bottom + 7;
    if (top + h > window.innerHeight - 10) top = Math.max(10, rect.top - h - 7);
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
  }

  function openMixPopover() {
    closeContextMenu();
    closeMoreMenu();
    positionPopover(els.mixPopover, els.mixChip, 300);
  }

  function closeMixPopover() {
    els.mixPopover.hidden = true;
  }

  function openMoreMenu() {
    closeContextMenu();
    closeMixPopover();
    positionPopover(els.moreMenu, els.moreBtn, 238);
    els.moreBtn.setAttribute('aria-expanded', 'true');
  }

  function closeMoreMenu() {
    els.moreMenu.hidden = true;
    els.moreBtn.setAttribute('aria-expanded', 'false');
    armedReset = false;
    armedOff = false;
    els.resetMenuText.textContent = '重置原型数据';
  }

  function closeContextMenu() {
    els.contextMenu.hidden = true;
  }

  function openContextMenu(e) {
    if (state.mode === 'off') return;
    e.preventDefault();
    const target = e.target;
    const clipNode = target.closest('[data-clip]');
    const cueNode = target.closest('[data-cue]');
    const markerNode = target.closest('[data-marker]');
    let ctx = { type: 'empty', id: null };
    if (clipNode) ctx = { type: 'clip', id: clipNode.dataset.clip };
    else if (cueNode) ctx = { type: 'cue', id: cueNode.dataset.cue };
    else if (markerNode) ctx = { type: 'marker', id: markerNode.dataset.marker };
    const disabled = state.mode !== 'on' ? 'disabled' : '';
    let html = '';
    if (ctx.type === 'clip') {
      const clip = clipById(ctx.id);
      if (!clip) return;
      const row = clipRow(clip);
      const media = mediaById(clip.sourceId);
      const canSplit = row && state.playhead > row.start + 250 && state.playhead < row.end - 250;
      const hasTrans = clip.transitionIn && clip.transitionIn.type !== 'none';
      html += `<div class="ctx-title">${clip.ghost ? '空隙' : `分镜 ${media.no} · ${esc(media.name)}`}</div>`;
      if (!clip.ghost) {
        html += `<button class="ctx-item" data-ctx-act="split" ${canSplit ? '' : 'disabled'}>${icon('scissors')}<span>在播放头分割</span><kbd>S</kbd></button>`;
        html += `<button class="ctx-item" data-ctx-act="duplicate" ${disabled}>${icon('copy')}<span>复制片段</span></button>`;
      }
      html += `<button class="ctx-item is-danger" data-ctx-act="ripple" ${disabled}>${icon('trash')}<span>波纹删除</span><kbd>⌫</kbd></button>`;
      if (!clip.ghost) {
        html += `<button class="ctx-item" data-ctx-act="leave-gap" ${disabled}>${icon('panel-left')}<span>删除并留空</span></button>`;
        html += `<div class="ctx-sep"></div>`;
        if (hasTrans) {
          html += `<button class="ctx-item" data-ctx-act="remove-transition" ${disabled}>${icon('wand')}<span>移除入场转场</span></button>`;
        } else {
          html += `<button class="ctx-item" data-ctx-act="add-dissolve" ${disabled}>${icon('wand')}<span>添加 0.4s 叠化</span></button>`;
        }
        html += `<button class="ctx-item" data-ctx-act="inspect-clip">${icon('layers')}<span>在检查器中查看</span></button>`;
      }
    } else if (ctx.type === 'cue') {
      html += `<div class="ctx-title">字幕</div>`;
      html += `<button class="ctx-item" data-ctx-act="cue-inspect">${icon('type')}<span>编辑字幕</span></button>`;
      html += `<button class="ctx-item" data-ctx-act="cue-align" ${disabled}>${icon('clock')}<span>起点对齐播放头</span></button>`;
      html += `<div class="ctx-sep"></div>`;
      html += `<button class="ctx-item is-danger" data-ctx-act="cue-delete" ${disabled}>${icon('trash')}<span>删除字幕</span><kbd>⌫</kbd></button>`;
    } else if (ctx.type === 'marker') {
      const m = state.markers.find((x) => x.id === ctx.id);
      html += `<div class="ctx-title">${m ? esc(m.label || '标记') : '标记'}</div>`;
      html += `<button class="ctx-item" data-ctx-act="marker-jump">${icon('arrow-right')}<span>跳到标记</span></button>`;
      html += `<button class="ctx-item is-danger" data-ctx-act="marker-delete" ${disabled}>${icon('trash')}<span>删除标记</span></button>`;
    } else {
      html += `<div class="ctx-title">时间线</div>`;
      html += `<button class="ctx-item" data-ctx-act="add-cue" ${disabled}>${icon('captions')}<span>在播放头添加字幕</span></button>`;
      html += `<button class="ctx-item" data-ctx-act="add-marker" ${disabled}>${icon('flag')}<span>在播放头添加标记</span><kbd>M</kbd></button>`;
      html += `<div class="ctx-sep"></div>`;
      html += `<button class="ctx-item" data-ctx-act="add-all" ${disabled}>${icon('plus')}<span>全部素材加入时间线</span></button>`;
      html += `<button class="ctx-item" data-ctx-act="rough" ${disabled}>${icon('wand')}<span>运行粗剪</span></button>`;
      html += `<div class="ctx-sep"></div>`;
      html += `<button class="ctx-item" data-ctx-act="deselect"><span>取消选择</span></button>`;
    }
    els.contextMenu.innerHTML = html;
    els.contextMenu.dataset.type = ctx.type;
    els.contextMenu.dataset.id = ctx.id || '';
    els.contextMenu.hidden = false;
    const rect = els.contextMenu.getBoundingClientRect();
    let x = e.clientX;
    let y = e.clientY;
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    els.contextMenu.style.left = `${Math.max(8, x)}px`;
    els.contextMenu.style.top = `${Math.max(8, y)}px`;
  }

  function onContextAction(e) {
    const btn = e.target.closest('[data-ctx-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.ctxAct;
    const type = els.contextMenu.dataset.type;
    const id = els.contextMenu.dataset.id;
    closeContextMenu();
    if (act === 'add-cue') { addCueAt(state.playhead); return; }
    if (act === 'add-marker') { addMarker(); return; }
    if (act === 'add-all') { addAllMedia(); return; }
    if (act === 'rough') { roughCut(); return; }
    if (act === 'deselect') { deselect(); return; }
    if (type === 'clip') {
      const clip = clipById(id);
      if (!clip) return;
      if (act === 'split') splitAtPlayhead();
      if (act === 'duplicate') duplicateClip(id);
      if (act === 'ripple') deleteClip(id, true);
      if (act === 'leave-gap') deleteClip(id, false);
      if (act === 'add-dissolve') {
        if (!canEdit()) return;
        pushHistory('transition');
        clip.transitionIn = { type: 'dissolve', duration: 400 };
        markDirty('transition');
        persist();
        renderTimeline();
        toast('已添加 0.4s 叠化', 'ok', 1500);
      }
      if (act === 'remove-transition') {
        if (!canEdit()) return;
        pushHistory('transition');
        clip.transitionIn = { type: 'none', duration: 0 };
        markDirty('transition');
        persist();
        renderTimeline();
        toast('已移除转场', 'info', 1500);
      }
      if (act === 'inspect-clip') select('clip', id);
      return;
    }
    if (type === 'cue') {
      const cue = cueById(id);
      if (!cue) return;
      if (act === 'cue-inspect') {
        select('cue', id, cue.start);
        setTimeout(() => { const ta = $('[data-field="cueText"]', els.inspector); if (ta) ta.focus(); }, 30);
      }
      if (act === 'cue-align') {
        if (!canEdit()) return;
        pushHistory('cue-align');
        const dur = cue.end - cue.start;
        cue.start = Math.round(state.playhead);
        cue.end = Math.round(state.playhead + dur);
        markDirty('cue');
        persist();
        renderTimeline();
        renderInspector();
        toast('字幕已对齐播放头', 'ok', 1500);
      }
      if (act === 'cue-delete') deleteCue(id);
      return;
    }
    if (type === 'marker') {
      const m = state.markers.find((x) => x.id === id);
      if (!m) return;
      if (act === 'marker-jump') seek(m.at);
      if (act === 'marker-delete') removeMarker(id);
    }
  }

  function setMode(mode) {
    state.mode = mode;
    if (mode === 'off' || mode === 'readonly') {
      pause();
      closeMoreMenu();
      closeMixPopover();
    }
    if (mode === 'off') {
      state.exportEnabled = false;
    } else {
      state.exportEnabled = true;
    }
    renderAll();
    persist();
    if (mode === 'readonly') toast('已切换为只读模式：可以预览和导出', 'warn', 2200);
    else if (mode === 'on') toast('剪辑工作台已开启', 'ok', 1800);
    else toast('剪辑工作台已关闭（403）', 'danger', 2200);
  }

  function toggleSnap() {
    state.snap = !state.snap;
    els.snapBtn.classList.toggle('is-on', state.snap);
    els.snapBtn.setAttribute('aria-pressed', String(state.snap));
    toast(state.snap ? '磁吸已开启' : '磁吸已关闭', 'info', 1200);
  }

  function zoomTo(z) {
    const next = clamp(Math.round(z * 100) / 100, 0.4, 4);
    if (next === state.zoom) return;
    state.zoom = next;
    renderTimeline();
    requestAnimationFrame(() => {
      els.timelineScroll.scrollLeft = Math.max(0, state.playhead * stageMetrics.pxPerMs - els.timelineScroll.clientWidth / 2);
    });
  }

  function toggleMarkerBar() {
    state.markerBar = !state.markerBar;
    renderMarkerBar();
  }

  function openShortcuts() {
    if (!els.shortcutsDialog.open) els.shortcutsDialog.showModal();
  }

  function openAbout() {
    closeMoreMenu();
    if (!els.aboutDialog.open) els.aboutDialog.showModal();
  }

  function renderVersions() {
    const list = state.versions.slice().sort((a, b) => b.v - a.v);
    if (!list.length) {
      els.versionsList.innerHTML = '<div class="delivery-empty">还没有保存过版本</div>';
      return;
    }
    els.versionsList.innerHTML = list.map((v) => `
      <div class="version-row ${v.v === state.currentVersion ? 'is-current' : ''}">
        <header>
          <b>v${v.v}</b>
          ${v.v === state.currentVersion ? '<span class="badge">当前</span>' : ''}
        </header>
        <p>${esc(v.note || '剪辑版本')}</p>
        <div class="version-meta"><span>${esc(v.at || '')}</span><span>${v.clips ? v.clips.length : 0} 片段 · ${v.cues ? v.cues.length : 0} 字幕</span></div>
        <div class="version-actions">
          <button class="btn ghost sm" data-version-restore="${v.v}" ${state.mode !== 'on' ? 'disabled' : ''}>恢复此版本</button>
        </div>
      </div>`).join('');
    els.versionsFootHint.textContent = `当前 v${state.currentVersion} · ${state.clips.filter((c) => !c.ghost).length} 个片段 · ${state.cues.length} 条字幕`;
  }

  function openVersions() {
    closeContextMenu();
    renderVersions();
    els.versionsMask.hidden = false;
  }

  function closeVersions() {
    els.versionsMask.hidden = true;
  }

  function restoreVersion(v) {
    if (!canEdit()) return;
    const version = state.versions.find((x) => x.v === v);
    if (!version) return;
    pushHistory('version-restore');
    state.clips = clone(version.clips || []);
    state.cues = clone(version.cues || []);
    state.markers = clone(version.markers || []);
    state.currentVersion = version.v;
    state.selected = { type: 'none', id: null };
    state.playhead = 0;
    invalidateMix('timing_changed');
    markDirty('version');
    persist();
    closeVersions();
    renderAll();
    toast(`已恢复到 v${version.v}，可撤销`, 'ok', 2400);
  }

  function createVersion() {
    if (!canEdit()) return;
    const n = Math.max(...state.versions.map((v) => v.v), state.currentVersion) + 1;
    state.versions.push({
      v: n, note: '手动保存的剪辑版本', at: clockNow(),
      clips: clone(state.clips), cues: clone(state.cues), markers: clone(state.markers)
    });
    state.currentVersion = n;
    markDirty('version');
    persist();
    renderVersions();
    renderMode();
    renderInspector();
    toast(`已保存为新版本 v${n}`, 'ok');
  }

  function renderDelivery() {
    const list = state.exports.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!list.length) {
      els.deliveryList.innerHTML = `<div class="delivery-empty">${icon('film', 'icon icon-xl')}<b>还没有剪辑成片</b><span>点击右上角「导出」生成第一条成片。</span></div>`;
    } else {
      els.deliveryList.innerHTML = list.map((x) => `
        <div class="delivery-card ${x.current ? 'is-current' : ''}">
          <header>
            <b>${esc(x.filename)}</b>
            ${x.current ? '<span class="status-pill is-completed">当前</span>' : ''}
            <span class="status-pill is-${x.status}">${statusLabel(x.status)}</span>
          </header>
          <p>${x.reused ? '复用现有成片' : `渲染完成 · v${x.version}`} · ${tc(x.duration)} · ${x.size.toFixed(1)} MB</p>
          <div class="delivery-path">${esc(x.path)}</div>
          <div class="delivery-actions">
            ${x.status === 'completed' && !x.current ? `<button class="btn ghost sm" data-delivery-act="current" data-id="${x.id}">设为当前</button>` : ''}
            ${x.status !== 'completed' ? `<button class="btn ghost sm" data-delivery-act="retry" data-id="${x.id}">重试</button>` : ''}
            ${x.status === 'completed' ? `<button class="btn ghost sm" data-delivery-act="open" data-id="${x.id}">打开</button>` : ''}
            <button class="btn ghost sm" data-delivery-act="delete" data-id="${x.id}">删除</button>
          </div>
        </div>`).join('');
    }
    els.deliveryFootHint.textContent = `本集共 ${state.exports.length} 条剪辑成片 · 复用 episode_exports`;
  }

  function statusLabel(status) {
    return status === 'completed' ? '已完成' : status === 'running' ? '导出中' : status === 'cancelled' ? '已取消' : '失败';
  }

  function openDelivery() {
    closeContextMenu();
    renderDelivery();
    els.deliveryMask.hidden = false;
  }

  function closeDelivery() {
    els.deliveryMask.hidden = true;
  }

  function onDeliveryAction(e) {
    const btn = e.target.closest('[data-delivery-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.deliveryAct;
    const rec = state.exports.find((x) => x.id === id);
    if (!rec) return;
    if (act === 'current') {
      state.exports.forEach((x) => { x.current = false; });
      rec.current = true;
      markDirty('export');
      persist();
      renderDelivery();
      renderRecentExports();
      toast('已设为当前成片', 'ok', 1600);
    }
    if (act === 'open') {
      toast('原型不会打开真实文件；正式版支持预览与下载', 'info', 2600);
    }
    if (act === 'retry') {
      closeDelivery();
      state.form = {
        preset: rec.preset || 'auto', subtitle: rec.subtitle || 'soft',
        audio: rec.audio || 'auto', setCurrent: true
      };
      openExportDialog();
      toast('已带入上次参数，可直接重新导出', 'accent', 2200);
    }
    if (act === 'delete') {
      state.exports = state.exports.filter((x) => x.id !== id);
      persist();
      renderDelivery();
      renderRecentExports();
      toast('已删除成片记录', 'info', 1600);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      closeContextMenu();
      closeMixPopover();
      closeMoreMenu();
      if (!els.versionsMask.hidden) { closeVersions(); return; }
      if (!els.deliveryMask.hidden) { closeDelivery(); return; }
      if (!els.contextMenu.hidden || !els.mixPopover.hidden || !els.moreMenu.hidden) return;
      if (state.selected.type !== 'none') { deselect(); return; }
      return;
    }
    if (els.offOverlay.hidden === false) return;
    if (document.querySelector('dialog[open]')) return;
    if (!els.versionsMask.hidden || !els.deliveryMask.hidden) return;
    const typing = e.target && e.target.matches && e.target.matches('input, textarea, select, [contenteditable="true"]');
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (state.mode !== 'off') saveNow(true);
      return;
    }
    if (meta && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      if (state.exportEnabled && state.mode !== 'off') openExportDialog();
      else toast('当前配置不允许导出', 'warn');
      return;
    }
    if (meta && e.key.toLowerCase() === 'z') {
      if (typing) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if (meta && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      els.mediaSearch.focus();
      return;
    }
    if (typing) return;
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.shiftKey ? 1000 : 1000 / FPS;
      seek(state.playhead + (e.key === 'ArrowLeft' ? -step : step));
      return;
    }
    if (e.key === 'Home') { e.preventDefault(); seek(0); return; }
    if (e.key === 'End') { e.preventDefault(); seek(layoutTotal()); return; }
    if (e.key.toLowerCase() === 's') { e.preventDefault(); splitAtPlayhead(); return; }
    if (e.key.toLowerCase() === 'm') { e.preventDefault(); addMarker(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); deleteSelected(); return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(state.zoom * 1.25); return; }
    if (e.key === '-') { e.preventDefault(); zoomTo(state.zoom / 1.25); return; }
  }

  function onTimelineDoubleClick(e) {
    if (state.mode !== 'on') return;
    if (e.target.closest('[data-clip]') || e.target.closest('[data-cue]') || e.target.closest('.ruler')) return;
    const rect = els.timelineStage.getBoundingClientRect();
    const at = clamp((e.clientX - rect.left) / stageMetrics.pxPerMs, 0, layoutTotal());
    seek(at);
    addCueAt(at);
  }

  function bindEvents() {
    els.timelineStage.addEventListener('pointerdown', onStagePointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    els.timelineStage.addEventListener('contextmenu', openContextMenu);
    els.timelineStage.addEventListener('dblclick', onTimelineDoubleClick);
    els.contextMenu.addEventListener('click', onContextAction);
    els.inspector.addEventListener('click', onInspectorClick);
    els.inspector.addEventListener('input', onInspectorInput);
    els.inspector.addEventListener('change', onInspectorChange);

    els.mediaList.addEventListener('click', (e) => {
      const add = e.target.closest('[data-media]');
      if (add) { addMediaToTimeline(add.dataset.media); return; }
      const line = e.target.closest('[data-line]');
      if (line) {
        const l = lineById(line.dataset.line);
        if (!l) return;
        const cue = state.cues.find((c) => c.lineId === l.id) || null;
        if (cue) { select('cue', cue.id, cue.start); return; }
        if (!canEdit()) return;
        addCueAt(state.playhead, l.id, l.text);
        return;
      }
      const mixAct = e.target.closest('[data-mix-act]');
      if (mixAct) {
        if (mixAct.dataset.mixAct === 'regen') regenerateMix();
        else toast('正式版会跳转到混音工作台；原型保持当前页', 'info', 2400);
      }
    });
    els.mediaList.addEventListener('change', () => {});
    els.mediaSearch.addEventListener('input', () => {
      state.search = els.mediaSearch.value;
      renderMedia();
    });
    els.tabs.forEach((tab) => {
      tab.addEventListener('click', () => { state.mediaTab = tab.dataset.tab; renderMedia(); });
    });

    els.playBtn.addEventListener('click', togglePlay);
    els.homeBtn.addEventListener('click', () => seek(0));
    els.endBtn.addEventListener('click', () => seek(layoutTotal()));
    els.prevCutBtn.addEventListener('click', () => jumpCut(-1));
    els.nextCutBtn.addEventListener('click', () => jumpCut(1));
    els.prevMarkerBtn.addEventListener('click', () => jumpMarker(-1));
    els.nextMarkerBtn.addEventListener('click', () => jumpMarker(1));
    els.markerAddBtn.addEventListener('click', () => addMarker());
    els.markerListBtn.addEventListener('click', toggleMarkerBar);
    els.markerBar.addEventListener('click', (e) => {
      const del = e.target.closest('[data-marker-del]');
      if (del) { e.stopPropagation(); removeMarker(del.dataset.markerDel); return; }
      const jump = e.target.closest('[data-marker-jump]');
      if (jump) {
        const m = state.markers.find((x) => x.id === jump.dataset.markerJump);
        if (m) seek(m.at);
      }
    });

    els.undoBtn.addEventListener('click', undo);
    els.redoBtn.addEventListener('click', redo);
    els.saveBtn.addEventListener('click', () => { if (state.mode !== 'off') saveNow(true); });
    els.suggestBtn.addEventListener('click', suggestSubtitle);
    els.roughBtn.addEventListener('click', roughCut);
    els.versionsBtn.addEventListener('click', openVersions);
    els.exportBtn.addEventListener('click', () => {
      if (!state.exportEnabled || state.mode === 'off') { toast('导出已在设置中关闭', 'warn'); return; }
      openExportDialog();
    });
    els.mediaToggleBtn.addEventListener('click', () => {
      state.mediaCollapsed = !state.mediaCollapsed;
      els.workspace.classList.toggle('media-collapsed', state.mediaCollapsed);
      setTimeout(setPreviewSize, 190);
    });
    els.collapseMediaBtn.addEventListener('click', () => {
      state.mediaCollapsed = true;
      els.workspace.classList.add('media-collapsed');
      setTimeout(setPreviewSize, 190);
    });
    els.addAllBtn.addEventListener('click', addAllMedia);
    els.shortcutsBtn.addEventListener('click', openShortcuts);
    els.statusHelpBtn.addEventListener('click', openShortcuts);
    els.moreBtn.addEventListener('click', () => {
      if (els.moreMenu.hidden) openMoreMenu(); else closeMoreMenu();
    });
    els.backBtn.addEventListener('click', () => toast('原型不离开页面；正式版会返回剧集详情', 'info', 2400));
    els.episodeBtn.addEventListener('click', () => toast('当前剧集：EP.03 雨夜来客', 'info', 1800));
    els.modeChip.addEventListener('click', () => toast(state.mode === 'readonly' ? '只读模式：可预览、播放和导出' : state.mode === 'off' ? '剪辑已关闭：所有修改返回 403' : '剪辑已开启，可以修改剪辑计划', 'info', 2200));
    els.mixChip.addEventListener('click', () => {
      if (els.mixPopover.hidden) openMixPopover(); else closeMixPopover();
    });
    els.mixGotoBtn.addEventListener('click', () => {
      closeMixPopover();
      toast('正式版会打开混音工作台；原型保持当前页', 'info', 2400);
    });
    els.mixRegenBtn.addEventListener('click', () => { closeMixPopover(); regenerateMix(); });

    els.snapBtn.addEventListener('click', toggleSnap);
    els.zoomOutBtn.addEventListener('click', () => zoomTo(state.zoom / 1.25));
    els.zoomInBtn.addEventListener('click', () => zoomTo(state.zoom * 1.25));
    els.splitBtn.addEventListener('click', splitAtPlayhead);

    els.moreMenu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-more]');
      if (!item) return;
      const act = item.dataset.more;
      if (act === 'readonly') { closeMoreMenu(); setMode(state.mode === 'readonly' ? 'on' : 'readonly'); return; }
      if (act === 'export-enabled') {
        state.exportEnabled = !state.exportEnabled;
        renderMode();
        renderMoreMenu();
        persist();
        toast(state.exportEnabled ? '已允许导出' : '已关闭导出', state.exportEnabled ? 'ok' : 'warn', 1600);
        return;
      }
      if (act === 'off') {
        if (!armedOff) {
          armedOff = true;
          item.classList.add('is-armed');
          item.querySelector('span').textContent = '再次点击确认关闭';
          return;
        }
        closeMoreMenu();
        setMode('off');
        return;
      }
      if (act === 'mix-aligned') {
        state.mix.state = 'aligned';
        state.mix.reason = null;
        state.mix.duration = layoutTotal();
        if (!state.mix.rev) state.mix.rev = 1;
        markDirty('mix');
        persist();
        closeMoreMenu();
        renderAll();
        toast('演示：混音已对齐', 'ok', 1600);
        return;
      }
      if (act === 'mix-stale') {
        state.mix.state = 'stale';
        state.mix.reason = 'timing_changed';
        markDirty('mix');
        persist();
        closeMoreMenu();
        renderAll();
        toast('演示：混音已过期', 'warn', 1600);
        return;
      }
      if (act === 'mix-missing') {
        state.mix.state = 'missing';
        state.mix.reason = 'missing';
        markDirty('mix');
        persist();
        closeMoreMenu();
        renderAll();
        toast('演示：未生成混音，导出会回退原声', 'warn', 2000);
        return;
      }
      if (act === 'about') { closeMoreMenu(); openAbout(); return; }
      if (act === 'reset') {
        if (!armedReset) {
          armedReset = true;
          item.classList.add('is-armed');
          els.resetMenuText.textContent = '再次点击确认重置';
          return;
        }
        try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ }
        location.replace(`${location.pathname}?fresh=1`);
      }
    });

    els.exportStripOpen.addEventListener('click', () => {
      if (state.job) openExportDialog();
    });
    els.exportStripCancel.addEventListener('click', () => cancelExport());

    els.recoverySaveBtn.addEventListener('click', () => {
      state.recovery = false;
      saveNow(true);
      renderMode();
      toast('草稿已保存', 'ok');
    });
    els.recoveryDiscardBtn.addEventListener('click', () => {
      const version = state.versions.find((v) => v.v === state.currentVersion) || state.versions[0];
      if (version) {
        state.clips = clone(version.clips || []);
        state.cues = clone(version.cues || []);
        state.markers = clone(version.markers || []);
      }
      state.recovery = false;
      markDirty('discard');
      persist();
      renderAll();
      toast('已丢弃未保存修改，恢复到最近版本', 'info', 2200);
    });
    els.readonlyReasonBtn.addEventListener('click', () => {
      toast('只读模式来自 /settings/edit 的 readonly 配置；导出与播放仍然可用。', 'info', 3000);
    });

    els.offReasonBtn.addEventListener('click', () => {
      toast('/settings/edit 中 mode=off 时，剪辑与导出接口返回 403；不会写入成片记录。', 'warn', 3200);
    });
    els.offRestoreBtn.addEventListener('click', () => setMode('on'));

    els.versionsCloseBtn.addEventListener('click', closeVersions);
    els.versionsMask.addEventListener('pointerdown', (e) => { if (e.target === els.versionsMask) closeVersions(); });
    els.versionsList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-version-restore]');
      if (!btn || btn.disabled) return;
      if (btn.dataset.armed === '1') {
        restoreVersion(Number(btn.dataset.versionRestore));
        return;
      }
      btn.dataset.armed = '1';
      btn.textContent = '再次点击确认恢复';
      setTimeout(() => {
        if (btn.isConnected) {
          btn.dataset.armed = '0';
          btn.textContent = '恢复此版本';
        }
      }, 2600);
    });
    els.createVersionBtn.addEventListener('click', createVersion);

    els.deliveryCloseBtn.addEventListener('click', closeDelivery);
    els.deliveryBackBtn.addEventListener('click', closeDelivery);
    els.deliveryMask.addEventListener('pointerdown', (e) => { if (e.target === els.deliveryMask) closeDelivery(); });
    els.deliveryList.addEventListener('click', onDeliveryAction);

    els.shortcutsCloseBtn.addEventListener('click', () => els.shortcutsDialog.close());
    els.aboutCloseBtn.addEventListener('click', () => els.aboutDialog.close());
    els.exportCloseBtn.addEventListener('click', () => closeExportDialog());

    document.addEventListener('pointerdown', (e) => {
      if (!els.contextMenu.hidden && !els.contextMenu.contains(e.target)) closeContextMenu();
      if (!els.mixPopover.hidden && !els.mixPopover.contains(e.target) && !els.mixChip.contains(e.target)) closeMixPopover();
      if (!els.moreMenu.hidden && !els.moreMenu.contains(e.target) && !els.moreBtn.contains(e.target)) closeMoreMenu();
    });
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('beforeunload', () => {
      if (state.dirty) persist();
    });

    const ro = new ResizeObserver(() => {
      if (state.mode === 'off') return;
      setPreviewSize();
    });
    ro.observe(els.previewBody);
    window.addEventListener('resize', () => {
      setPreviewSize();
      renderTimeline();
    });
    els.timelineScroll.addEventListener('scroll', () => {
      if (els.mixPopover.hidden) return;
    });
  }

  const PHASES = [
    { p: 5, label: '校验剪辑计划与权限' },
    { p: 28, label: '统一画幅、帧率与时基' },
    { p: 52, label: '渲染片段并拼接画面' },
    { p: 70, label: '混合对白、音乐与音效' },
    { p: 91, label: '封装字幕与元数据' },
    { p: 100, label: '校验输出文件' }
  ];

  const PRESET_LABEL = { auto: '自动', 'vertical-hd': '竖屏高清', 'horizontal-hd': '横屏高清' };
  const SUBTITLE_LABEL = { soft: '软字幕', burn: '烧录字幕', none: '无字幕' };
  const AUDIO_LABEL = { auto: '自动', mix: '当前混音', clip: '剪辑原声', silent: '静音' };

  function resolvedPreset() {
    if (state.form.preset === 'auto') return state.meta.width >= state.meta.height ? 'horizontal-hd' : 'vertical-hd';
    return state.form.preset;
  }

  function presetResolution(preset) {
    return preset === 'vertical-hd' ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 };
  }

  function presetMbPerSec(preset) {
    return preset === 'vertical-hd' ? 8.2 : 9.4;
  }

  function estimateSize(durationMs, preset) {
    return Math.max(0.6, (durationMs / 1000) * presetMbPerSec(preset) / 8);
  }

  function exportFilename(preset, subtitle) {
    const suffix = subtitle === 'burn' ? '_硬字幕' : subtitle === 'none' ? '_无字幕' : '';
    return `${state.meta.drama}_${state.meta.episode}_剪辑版_${PRESET_LABEL[preset]}${suffix}_v${state.currentVersion}.mp4`;
  }

  function audioInfo() {
    const f = state.form;
    const resolved = resolveAudio(f.audio);
    let warning = '';
    let error = '';
    if (f.audio === 'mix' && state.mix.state === 'missing') {
      error = '当前没有可用混音，请选择「自动」「剪辑原声」或先生成混音。';
    } else if (f.audio === 'mix' && state.mix.state === 'stale') {
      warning = '当前混音已过期，导出会使用旧混音；建议先重新生成混音。';
    } else if (f.audio === 'auto' && state.mix.state === 'stale') {
      warning = '混音已过期，自动模式会回退到剪辑原声。';
    } else if (f.audio === 'auto' && state.mix.state === 'missing') {
      warning = '尚未生成混音，自动模式会使用剪辑原声。';
    }
    return { resolved, warning, error };
  }

  function renderExportForm() {
    const f = state.form;
    const preset = resolvedPreset();
    const res = presetResolution(preset);
    const duration = layoutTotal();
    const size = estimateSize(duration, preset);
    const info = audioInfo();
    $$('#presetOptions .option-card').forEach((b) => b.classList.toggle('is-active', b.dataset.preset === f.preset));
    $$('#subtitleOptions button').forEach((b) => b.classList.toggle('is-active', b.dataset.subtitle === f.subtitle));
    $$('#audioOptions button').forEach((b) => b.classList.toggle('is-active', b.dataset.audio === f.audio));
    els.presetAutoRes.textContent = `横屏 ${state.meta.width}×${state.meta.height}`.replace('横屏', state.meta.width >= state.meta.height ? '横屏' : '竖屏');
    const mixOption = $('#audioOptions [data-audio="mix"] small');
    if (mixOption) {
      mixOption.textContent = state.mix.state === 'missing'
        ? '尚无可用的混音'
        : `混音 v${state.mix.rev} · ${state.mix.state === 'aligned' ? '已对齐' : '已过期'}`;
    }
    const autoHint = els.audioAutoHint;
    if (f.audio === 'auto') {
      autoHint.textContent = info.resolved === 'mix' ? '自动：使用已对齐的混音' : '自动：混音不可用，使用剪辑原声';
    } else {
      autoHint.textContent = `已选：${AUDIO_LABEL[f.audio]}`;
    }
    if (info.error || info.warning) {
      els.audioWarning.hidden = false;
      els.audioWarning.classList.toggle('is-danger', !!info.error);
      const span = $('span', els.audioWarning);
      if (span) span.textContent = info.error || info.warning;
    } else {
      els.audioWarning.hidden = true;
    }
    els.exportDuration.textContent = tc(duration);
    els.exportSize.textContent = `约 ${size.toFixed(1)} MB`;
    els.exportFilename.textContent = exportFilename(preset, f.subtitle);
    els.setCurrentToggle.checked = !!f.setCurrent;
    const key = buildExportKey(preset, f.subtitle, info.resolved);
    const reuse = state.exports.find((x) => x.status === 'completed' && !x.reused && x.key === key);
    const audioText = info.resolved === 'mix' ? `混音 v${state.mix.rev}` : info.resolved === 'clip' ? '剪辑原声' : '静音';
    els.exportFormHint.textContent = reuse
      ? `将命中复用：${reuse.filename}`
      : `将渲染 ${state.clips.filter((c) => !c.ghost).length} 个片段 · ${state.cues.length} 条字幕 · ${audioText}`;
    els.exportStartBtn.disabled = !!info.error;
    els.exportStartBtn.innerHTML = `${icon('download')}<span>${reuse ? '复用并导出' : '开始导出'}</span>`;
    els.exportStartBtn.dataset.reuse = reuse ? reuse.id : '';
    renderRecentExports();
  }

  function renderRecentExports() {
    const list = state.exports.filter((x) => x.status === 'completed' || x.status === 'cancelled').slice(0, 3);
    if (!list.length) {
      els.recentExports.innerHTML = '<h4>最近导出</h4><div class="recent-empty">还没有导出记录</div>';
      return;
    }
    els.recentExports.innerHTML = `<h4>最近导出</h4>${list.map((x) => `
      <button class="recent-export-row" style="width:100%;text-align:left" data-recent-open="${x.id}">
        ${icon('film')}
        <span class="recent-export-info">
          <b>${esc(x.filename)}</b>
          <small>${esc(x.createdAt)} · ${tc(x.duration)} · ${x.size.toFixed(1)} MB${x.current ? ' · 当前成片' : ''}</small>
        </span>
        <span class="status-pill is-${x.status}">${statusLabel(x.status)}</span>
      </button>`).join('')}`;
  }

  function showExportView(view) {
    els.exportFormView.hidden = view !== 'form';
    els.exportRunningView.hidden = view !== 'running';
    els.exportDoneView.hidden = view !== 'done';
  }

  function openExportDialog() {
    closeContextMenu();
    if (state.job && state.job.status === 'running') {
      renderRunning(state.job);
      showExportView('running');
      renderJobStrip();
    } else {
      state.job = null;
      renderExportForm();
      showExportView('form');
    }
    if (!els.exportDialog.open) els.exportDialog.showModal();
  }

  function closeExportDialog() {
    if (els.exportDialog.open) els.exportDialog.close();
  }

  function currentPhaseIndex(progress) {
    for (let i = 0; i < PHASES.length; i += 1) {
      if (progress < PHASES[i].p) return i;
    }
    return PHASES.length - 1;
  }

  function renderRunning(job) {
    if (!job) return;
    const pct = clamp(job.progress || 0, 0, 100);
    const idx = currentPhaseIndex(pct);
    const phase = PHASES[Math.min(idx, PHASES.length - 1)];
    els.runningRing.style.setProperty('--pct', pct.toFixed(1));
    els.runningPct.textContent = `${Math.round(pct)}%`;
    els.runningEyebrow.textContent = job.reuseId ? '复用成片' : '正在渲染';
    els.runningTitle.textContent = job.reuseId ? '正在复用已有成片' : '正在导出成片';
    els.runningPhase.textContent = job.reuseId
      ? '校验参数并读取已有成片…'
      : `${phase.label}…`;
    els.runningFill.style.width = `${pct}%`;
    els.runningPhases.innerHTML = PHASES.map((p, i) => {
      const prev = i === 0 ? 0 : PHASES[i - 1].p;
      const done = pct >= p.p;
      const current = i === idx && !done;
      const localPct = done ? 100 : current ? clamp(((pct - prev) / (p.p - prev)) * 100, 0, 100) : 0;
      return `<div class="phase-row ${done ? 'is-done' : current ? 'is-current' : ''}">
        <span class="phase-dot">${done ? icon('check', 'icon') : ''}</span>
        <span>${p.label}</span>
        <span class="phase-pct">${done ? '100%' : current ? `${Math.round(localPct)}%` : ''}</span>
      </div>`;
    }).join('');
    const elapsed = Math.max(0, (Date.now() - job.startedAt) / 1000);
    els.runningElapsed.textContent = `已用时 ${elapsed.toFixed(1)}s`;
    const res = presetResolution(job.preset);
    els.runningTarget.textContent = `输出 ${res.w}×${res.h} · ${SUBTITLE_LABEL[job.subtitle]} · ${job.audio === 'mix' ? '混音' : job.audio === 'clip' ? '剪辑原声' : '静音'}`;
  }

  function renderJobStrip() {
    const job = state.job;
    const running = job && job.status === 'running';
    els.exportStrip.hidden = !running;
    if (!running) {
      els.exportStripPhase.textContent = '正在导出成片';
      els.exportStripFill.style.width = '0%';
      els.exportStripPct.textContent = '0%';
      return;
    }
    const pct = clamp(job.progress || 0, 0, 100);
    const idx = currentPhaseIndex(pct);
    const phase = PHASES[Math.min(idx, PHASES.length - 1)];
    els.exportStripPhase.textContent = job.reuseId ? '正在复用已有成片' : `正在导出 · ${phase.label}`;
    els.exportStripFill.style.width = `${pct}%`;
    els.exportStripPct.textContent = `${Math.round(pct)}%`;
  }

  function bindExportEvents() {
    els.presetOptions.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-preset]');
      if (!btn) return;
      state.form.preset = btn.dataset.preset;
      renderExportForm();
    });
    els.subtitleOptions.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-subtitle]');
      if (!btn) return;
      state.form.subtitle = btn.dataset.subtitle;
      renderExportForm();
    });
    els.audioOptions.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-audio]');
      if (!btn) return;
      state.form.audio = btn.dataset.audio;
      renderExportForm();
    });
    els.setCurrentToggle.addEventListener('change', () => {
      state.form.setCurrent = els.setCurrentToggle.checked;
    });
    els.exportStartBtn.addEventListener('click', () => startExport());
    els.exportCancelBtn.addEventListener('click', closeExportDialog);
    els.runningCollapseBtn.addEventListener('click', closeExportDialog);
    els.runningCancelBtn.addEventListener('click', cancelExport);
    els.recentExports.addEventListener('click', (e) => {
      const row = e.target.closest('[data-recent-open]');
      if (!row) return;
      closeExportDialog();
      openDelivery();
    });
    els.doneDeliveryBtn.addEventListener('click', () => {
      closeExportDialog();
      openDelivery();
    });
    els.doneOpenBtn.addEventListener('click', () => {
      toast('原型不会打开真实文件；正式版会打开成片预览', 'info', 2800);
    });
    els.doneCopyBtn.addEventListener('click', () => {
      const rec = state.exports.find((x) => x.id === doneRecordId);
      if (!rec) return;
      copyText(rec.path);
    });
  }

  let doneRecordId = null;

  function copyText(text) {
    const done = () => toast('已复制成片路径', 'ok', 1600);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (err) { toast('复制失败，请手动选择路径', 'warn'); }
    ta.remove();
  }

  function startExport(opts = {}) {
    if (!state.exportEnabled || state.mode === 'off') { toast('导出已在设置中关闭', 'warn'); return; }
    if (state.mode === 'readonly' && !state.exportEnabled) return;
    if (!state.clips.length) { toast('时间线为空，无法导出', 'warn'); return; }
    const info = audioInfo();
    if (info.error) { toast(info.error, 'warn'); return; }
    const preset = resolvedPreset();
    const subtitle = state.form.subtitle;
    const audio = info.resolved;
    const duration = layoutTotal();
    const size = estimateSize(duration, preset);
    const filename = exportFilename(preset, subtitle);
    const key = buildExportKey(preset, subtitle, audio);
    const reuse = state.exports.find((x) => x.status === 'completed' && !x.reused && x.key === key);
    const job = {
      status: 'running',
      startedAt: Date.now() - (opts.demoElapsed || 0),
      progress: 0,
      form: clone(state.form),
      preset,
      subtitle,
      audio,
      key,
      duration,
      size,
      filename,
      reuseId: reuse ? reuse.id : '',
      reuseName: reuse ? reuse.filename : ''
    };
    state.job = job;
    persist();
    renderMode();
    renderRunning(job);
    renderJobStrip();
    showExportView('running');
    if (!els.exportDialog.open) els.exportDialog.showModal();
    startJobTimer(job);
  }

  function startJobTimer(job) {
    clearInterval(jobTimer);
    const totalMs = job.reuseId ? 900 : 7500;
    const tick = () => {
      if (!state.job || state.job !== job || job.status !== 'running') { clearInterval(jobTimer); return; }
      const elapsed = Date.now() - job.startedAt;
      job.progress = clamp((elapsed / totalMs) * 100, 0, 100);
      if (job.progress >= 100) {
        finishExport(job);
        return;
      }
      renderRunning(job);
      renderJobStrip();
      renderMode();
      renderStatus();
    };
    renderRunning(job);
    renderJobStrip();
    jobTimer = setInterval(tick, 90);
    tick();
  }

  function finishExport(job) {
    clearInterval(jobTimer);
    jobTimer = null;
    job.progress = 100;
    job.status = 'completed';
    job.finishedAt = Date.now();
    const form = job.form || state.form;
    let rec = null;
    if (job.reuseId) {
      rec = state.exports.find((x) => x.id === job.reuseId);
      if (rec) {
        if (form.setCurrent) {
          state.exports.forEach((x) => { x.current = false; });
          rec.current = true;
        }
      }
    }
    if (!rec) {
      if (form.setCurrent) state.exports.forEach((x) => { x.current = false; });
      rec = {
        id: uid('ex'),
        filename: job.filename,
        path: `/exports/${state.meta.drama}/${state.meta.episode}/${job.filename}`,
        preset: job.preset,
        subtitle: job.subtitle,
        audio: job.audio,
        duration: job.duration,
        size: job.size,
        status: 'completed',
        current: !!form.setCurrent,
        version: state.currentVersion,
        createdAt: clockNow(),
        key: job.key,
        reused: false
      };
      state.exports.unshift(rec);
    }
    job.recordId = rec.id;
    state.job = job;
    doneRecordId = rec.id;
    persist();
    renderJobStrip();
    renderMode();
    renderStatus();
    renderRecentExports();
    renderDelivery();
    showDone(rec, job);
    toast(job.reuseId ? '已复用上次导出的成片' : '导出完成，成片已进入交付中心', 'ok', 2800);
  }

  function showDone(rec, job) {
    doneRecordId = rec.id;
    els.doneEyebrow.textContent = job.reuseId ? '命中复用' : '导出完成';
    els.doneTitle.textContent = job.reuseId ? '已复用上次导出的成片' : '成片已进入交付中心';
    els.doneDesc.textContent = rec.filename;
    const elapsed = job.finishedAt ? (job.finishedAt - job.startedAt) / 1000 : 0;
    els.doneStats.innerHTML = `
      <div><dt>时长</dt><dd>${tc(rec.duration)}</dd></div>
      <div><dt>大小</dt><dd>${rec.size.toFixed(1)} MB</dd></div>
      <div><dt>${job.reuseId ? '复用耗时' : '导出耗时'}</dt><dd>${elapsed.toFixed(1)}s</dd></div>`;
    const notePieces = [];
    if (rec.current) notePieces.push('已设为当前成片。');
    if (!job.reuseId) notePieces.push(`导出键 ${job.key.slice(0, 8)}`);
    if (job.audio !== 'mix') notePieces.push('音频使用剪辑原声。');
    els.doneNote.hidden = !notePieces.length;
    els.doneNote.textContent = notePieces.join(' ');
    els.doneHint.textContent = job.reuseId ? '复用不会重复写入成片记录。' : '可在交付中心继续设为当前、重试或删除。';
    showExportView('done');
    renderJobStrip();
  }

  function cancelExport() {
    const job = state.job;
    if (!job || job.status !== 'running') return;
    clearInterval(jobTimer);
    jobTimer = null;
    job.status = 'cancelled';
    job.cancelledAt = Date.now();
    if (!job.reuseId) {
      const rec = {
        id: uid('ex'), filename: job.filename,
        path: `/exports/${state.meta.drama}/${state.meta.episode}/${job.filename}`,
        preset: job.preset, subtitle: job.subtitle, audio: job.audio,
        duration: job.duration, size: Math.max(0.2, job.size * (job.progress / 100)),
        status: 'cancelled', current: false, version: state.currentVersion,
        createdAt: clockNow(), key: job.key, reused: false
      };
      state.exports.unshift(rec);
    }
    state.job = null;
    persist();
    closeExportDialog();
    renderMode();
    renderJobStrip();
    renderStatus();
    renderRecentExports();
    renderDelivery();
    toast('导出已取消，未写入当前成片', 'warn', 2400);
  }

  function applyDemo() {
    const demo = PARAMS.get('demo');
    if (!demo) return;
    if (demo === 'subtitle') {
      const cue = state.cues[1] || state.cues[0];
      if (cue) select('cue', cue.id, 5000);
      return;
    }
    if (demo === 'export') {
      openExportDialog();
      return;
    }
    if (demo === 'progress') {
      state.form = { preset: 'auto', subtitle: 'soft', audio: 'auto', setCurrent: true };
      renderAll();
      startExport({ demoElapsed: 3100 });
      return;
    }
    if (demo === 'delivery') {
      openDelivery();
      return;
    }
    if (demo === 'versions') {
      openVersions();
      return;
    }
    if (demo === 'readonly') {
      state.mode = 'readonly';
      renderAll();
      persist();
      return;
    }
    if (demo === 'off') {
      state.mode = 'off';
      state.exportEnabled = false;
      renderAll();
      persist();
      return;
    }
    if (demo === 'recovery') {
      state.recovery = true;
      renderMode();
      return;
    }
    if (demo === 'mixstale') {
      state.mix.state = 'stale';
      state.mix.reason = 'timing_changed';
      renderAll();
      return;
    }
    if (demo === 'done') {
      const rec = state.exports.find((x) => x.status === 'completed');
      if (!rec) return;
      els.exportDialog.showModal();
      showDone(rec, { reuseId: rec.id, startedAt: Date.now() - 900, finishedAt: Date.now(), key: rec.key, audio: rec.audio });
      return;
    }
    if (demo === 'stale') {
      state.mix.state = 'stale';
      state.mix.reason = 'timing_changed';
      state.form.audio = 'auto';
      renderAll();
      openExportDialog();
      return;
    }
  }

  function resumeJob() {
    const job = state.job;
    if (!job || job.status !== 'running') return;
    const totalMs = job.reuseId ? 900 : 7500;
    const elapsed = Date.now() - job.startedAt;
    if (elapsed >= totalMs) {
      finishExport(job);
    } else {
      startJobTimer(job);
      renderJobStrip();
      renderMode();
    }
  }

  function init() {
    cacheEls();
    loadState();
    bindEvents();
    bindExportEvents();
    setPreviewSize();
    renderAll();
    renderRecentExports();
    updatePlayButton();
    resumeJob();
    applyDemo();
    setTimeout(() => {
      setPreviewSize();
      renderTimeline();
    }, 60);
  }

  init();
})();
