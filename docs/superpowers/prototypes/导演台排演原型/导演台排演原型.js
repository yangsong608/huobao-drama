(() => {
  'use strict';

  /* ===== 常量 ===== */
  const PX = 56;
  const WORLD_W = 616;
  const WORLD_H = 437;
  const STORAGE_KEY = 'huobao.director.prototype.v1';
  const FIELD_KEYS = ['shotType', 'angle', 'movement', 'duration'];
  const FIELD_LABELS = { shotType: '景别', angle: '角度', movement: '运动', duration: '时长' };
  const SHOT_TYPES = ['远景', '全景', '中景', '近景', '特写'];
  const ANGLES = ['平视', '俯视', '仰视', '侧拍'];
  const MOVEMENTS = ['固定', '缓慢推进', '横移', '跟随'];
  const CHARACTERS = {
    c1: { id: 'c1', name: '林小雨', initial: '林', color: '#f0a184', deep: '#b96f58' },
    c2: { id: 'c2', name: '周砚', initial: '周', color: '#8fb7f0', deep: '#5b80ad' },
  };
  const ROOM = { x0: 0.7, z0: 0.7, x1: 10.2, z1: 7.0 };
  const SCENE = {
    room: ROOM,
    window: { x0: 3.0, x1: 5.2, z: ROOM.z0 },
    door: { x0: 7.5, x1: 8.7, z: ROOM.z1 },
    desk: { x: 4.6, z: 1.45, w: 1.8, d: 0.9, h: 0.75 },
    chair: { x: 4.95, z: 2.35, w: 0.6, d: 0.55, h: 0.9 },
    shelf: { x: 9.5, z: 1.9, w: 0.5, d: 2.0, h: 2.2 },
    sofa: { x: 1.45, z: 4.2, w: 1.0, d: 2.0, h: 0.8 },
    rug: { x: 5.2, z: 3.5, w: 4.4, d: 2.6 },
    lamp: { x: 5.15, z: 1.25 },
  };

  /* ===== 数据 ===== */
  function yawTo(a, b) {
    return norm360(Math.atan2(b.x - a.x, -(b.z - a.z)) * 180 / Math.PI);
  }

  function makeShot(cfg) {
    const path = cfg.path.map(([x, z]) => ({ x, z }));
    const first = path[0];
    return {
      id: cfg.id,
      number: cfg.number,
      scene: '场景 3 · 老宅书房',
      duration: cfg.duration,
      hasVideo: !!cfg.hasVideo,
      stale: false,
      planDirty: false,
      camera: {
        shotType: cfg.shotType,
        angle: cfg.angle,
        movement: cfg.movement,
        lens: cfg.lens,
        height: cfg.height,
        x: first.x,
        z: first.z,
        yaw: yawTo(first, { x: cfg.look[0], z: cfg.look[1] }),
      },
      blocking: cfg.blocking.map(([id, x, z, rotation]) => ({ id, x, z, rotation })),
      subshots: cfg.subshots.map(([description, duration]) => ({ description, duration })),
      path,
      originalSubshotCount: cfg.subshots.length,
      base: {
        shotType: cfg.shotType,
        angle: cfg.angle,
        movement: cfg.movement,
        duration: cfg.duration,
        subshots: cfg.subshots.map(([description]) => description),
      },
      promptAppended: false,
      subshotsSyncedAt: null,
      appliedAt: null,
    };
  }

  const DEFAULT_SHOTS = [
    makeShot({
      id: 301, number: 1, duration: 12.25, hasVideo: true,
      shotType: '中景', angle: '平视', movement: '缓慢推进', lens: 35, height: 1.55,
      look: [5.4, 2.9],
      path: [[2.6, 4.6], [3.25, 4.0], [3.85, 3.45]],
      blocking: [['c1', 5.2, 2.9, 195], ['c2', 6.8, 3.5, 248]],
      subshots: [
        ['林小雨推门进来，停在门口，雨声压进屋里。', 4.5],
        ['她看向桌上的旧信，脚步停住。', 3.75],
        ['特写：指尖碰到信封边缘。', 4.0],
      ],
    }),
    makeShot({
      id: 302, number: 2, duration: 9.75, hasVideo: true,
      shotType: '近景', angle: '平视', movement: '固定', lens: 50, height: 1.5,
      look: [5.15, 2.95],
      path: [[4.2, 4.4], [4.25, 4.35], [4.3, 4.3]],
      blocking: [['c1', 5.15, 2.95, 190], ['c2', 6.2, 2.4, 240]],
      subshots: [
        ['林小雨抬眼，视线越过桌面。', 3.0],
        ['周砚在背景里合上伞，没有出声。', 3.5],
        ['她低声问：“信是谁送来的？”', 3.25],
      ],
    }),
    makeShot({
      id: 303, number: 3, duration: 12, hasVideo: false,
      shotType: '全景', angle: '俯视', movement: '横移', lens: 24, height: 2.2,
      look: [5.4, 3.2],
      path: [[1.5, 5.8], [2.0, 5.4], [2.4, 5.0]],
      blocking: [['c1', 5.4, 3.2, 180], ['c2', 6.4, 2.7, 235]],
      subshots: [
        ['俯拍：两人隔着书桌站定，门口的水痕还在延伸。', 3.0],
        ['林小雨绕过桌角，周砚没有动。', 5.0],
        ['窗外一道闪电，屋内短暂发白。', 4.0],
      ],
    }),
    makeShot({
      id: 304, number: 4, duration: 8.5, hasVideo: true,
      shotType: '特写', angle: '平视', movement: '固定', lens: 85, height: 1.45,
      look: [5.2, 2.9],
      path: [[4.4, 3.8], [4.42, 3.78]],
      blocking: [['c1', 5.2, 2.9, 185], ['c2', 6.5, 2.2, 240]],
      subshots: [
        ['旧信封上的火漆印已经裂开。', 4.25],
        ['林小雨的拇指擦过收信人名字。', 4.25],
      ],
    }),
    makeShot({
      id: 305, number: 5, duration: 14, hasVideo: false,
      shotType: '中景', angle: '侧拍', movement: '跟随', lens: 40, height: 1.6,
      look: [5.6, 3.2],
      path: [[3.0, 5.2], [3.8, 4.6], [4.5, 4.0], [5.0, 3.6]],
      blocking: [['c1', 5.5, 3.2, 200], ['c2', 6.4, 2.6, 250]],
      subshots: [
        ['侧跟：林小雨从书架前走过，手指掠过书脊。', 3.5],
        ['她停在窗前，雨幕把她的侧脸切成两半。', 3.5],
        ['周砚入画，站在她身后半步。', 3.5],
        ['两人的影子在地板上重叠。', 3.5],
      ],
    }),
    makeShot({
      id: 306, number: 6, duration: 11, hasVideo: true,
      shotType: '远景', angle: '俯视', movement: '缓慢推进', lens: 28, height: 2.4,
      look: [5.2, 3.0],
      path: [[1.0, 1.2], [1.6, 1.8], [2.2, 2.4]],
      blocking: [['c1', 5.2, 3.0, 180], ['c2', 6.2, 2.5, 235]],
      subshots: [
        ['大远景：整间书房被一盏台灯照亮。', 5.0],
        ['镜头缓慢越过沙发，靠近书桌。', 3.0],
        ['门口出现第三个人的影子。', 3.0],
      ],
    }),
    makeShot({
      id: 307, number: 7, duration: 10.5, hasVideo: false,
      shotType: '近景', angle: '仰视', movement: '固定', lens: 65, height: 0.9,
      look: [5.9, 2.7],
      path: [[6.6, 4.7], [6.62, 4.68]],
      blocking: [['c1', 5.9, 2.7, 10], ['c2', 6.6, 2.3, 230]],
      subshots: [
        ['仰拍：周砚低头看着林小雨，喉结动了一下。', 5.25],
        ['他伸手，又停在半空。', 5.25],
      ],
    }),
    makeShot({
      id: 308, number: 8, duration: 13, hasVideo: true,
      shotType: '中景', angle: '平视', movement: '横移', lens: 45, height: 1.55,
      look: [5.4, 3.0],
      path: [[7.0, 2.0], [6.6, 2.6], [6.2, 3.2]],
      blocking: [['c1', 5.5, 3.0, 190], ['c2', 6.3, 2.4, 245]],
      subshots: [
        ['横移：从书架移动到两人之间。', 4.0],
        ['林小雨把信推回桌面中央。', 4.5],
        ['周砚按住信纸，指节发白。', 4.5],
      ],
    }),
    makeShot({
      id: 309, number: 9, duration: 9.25, hasVideo: false,
      shotType: '特写', angle: '平视', movement: '缓慢推进', lens: 90, height: 1.4,
      look: [6.1, 2.7],
      path: [[5.9, 4.0], [5.95, 3.9]],
      blocking: [['c1', 6.1, 2.7, 5], ['c2', 6.6, 2.3, 228]],
      subshots: [
        ['两人的手同时按在信上。', 4.5],
        ['林小雨先松开，指尖退后半寸。', 4.75],
      ],
    }),
  ];

  /* ===== 状态 ===== */
  const state = {
    view: '2d',
    selectedShot: 0,
    selectedEntity: null,
    activeSubshot: -1,
    zoom: 1,
    pan: { x: 0, y: 0 },
    shots: [],
    savedSnapshot: [],
    version: 1,
    savedAt: 0,
    saving: false,
    loaded3d: false,
    loading3d: false,
    cameraPov: false,
    pendingPov: false,
    orbit: { az: 0.75, el: 0.55, dist: 13 },
    apply: {
      selected: new Set(),
      fields: { shotType: true, angle: true, movement: true, duration: true },
      appendPrompt: false,
      syncSubshots: false,
    },
    writeFields: { shotType: true, angle: true, movement: true, duration: true },
    viewToastTimer: 0,
    toastTimer: 0,
    resetArmed: false,
    resetTimer: 0,
    drag: null,
    panDrag: null,
    canvasW: 0,
    canvasH: 0,
  };

  /* ===== 小工具 ===== */
  const $ = (id) => document.getElementById(id);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  function norm360(v) {
    return ((v % 360) + 360) % 360;
  }
  const round2 = (v) => Math.round(v * 100) / 100;
  const deepClone = (obj) => JSON.parse(JSON.stringify(obj));
  const pad2 = (n) => String(n).padStart(2, '0');

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  function fmtSec(v) {
    const n = round2(Number(v) || 0);
    return `${String(n).replace(/\.?0+$/, '') || '0'}s`;
  }

  function fmtClock(sec) {
    const total = Math.round(Number(sec) || 0);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${pad2(s)}`;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (err) {
      return '';
    }
  }

  function dirFromYaw(yaw) {
    const rad = yaw * Math.PI / 180;
    return { x: Math.sin(rad), z: -Math.cos(rad) };
  }

  function compass(yaw) {
    const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    return dirs[Math.round(norm360(yaw) / 45) % 8];
  }

  function actorMeta(id) {
    return CHARACTERS[id] || { id, name: id, initial: '?', color: '#94a3b8', deep: '#475569' };
  }

  function selectedShot() {
    return state.shots[state.selectedShot];
  }

  function currentFieldValue(shot, key) {
    return key === 'duration' ? shot.duration : shot.camera[key];
  }

  function diffFields(shot) {
    const diff = {};
    FIELD_KEYS.forEach((key) => {
      const before = shot.base[key];
      const after = currentFieldValue(shot, key);
      const changed = key === 'duration'
        ? Math.abs(Number(before) - Number(after)) > 0.001
        : String(before) !== String(after);
      if (changed) diff[key] = { label: FIELD_LABELS[key], before, after };
    });
    return diff;
  }

  function subshotTotal(shot) {
    return round2(shot.subshots.reduce((sum, item) => sum + Number(item.duration || 0), 0));
  }

  function subshotValid(shot) {
    return Math.abs(subshotTotal(shot) - Number(shot.duration)) <= 0.2001;
  }

  function canSyncSubshots(shot) {
    return shot.subshots.length === shot.originalSubshotCount;
  }

  function fmtFieldValue(key, value) {
    return key === 'duration' ? fmtSec(value) : String(value);
  }

  function totalDuration() {
    return state.shots.reduce((sum, shot) => sum + Number(shot.duration || 0), 0);
  }

  function isTypingTarget(target) {
    return !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
  }

  /* ===== DOM ===== */
  const el = {
    shotList: $('shotList'),
    shotCount: $('shotCount'),
    totalDuration: $('totalDuration'),
    readyCount: $('readyCount'),
    pendingCount: $('pendingCount'),
    stripTrack: $('stripTrack'),
    stripSummary: $('stripSummary'),
    stageTitle: $('stageTitle'),
    sceneChip: $('sceneChip'),
    tools2d: $('tools2d'),
    tools3d: $('tools3d'),
    stage2d: $('stage2d'),
    stage3d: $('stage3d'),
    stageViewport: $('stageViewport'),
    world: $('world'),
    worldOverlay: $('worldOverlay'),
    floorSvg: $('floorSvg'),
    pathHandles: $('pathHandles'),
    actorHandles: $('actorHandles'),
    cameraHandle: $('cameraHandle'),
    camTag: $('camTag'),
    zoomLabel: $('zoomLabel'),
    pipFrame: $('pipFrame'),
    pipMeta: $('pipMeta'),
    pipShot: $('pipShot'),
    pipActors: $('pipActors'),
    pipEmpty: $('pipEmpty'),
    pip3dBtn: $('pip3dBtn'),
    inspector: $('inspector'),
    saveState: $('saveState'),
    saveText: $('saveText'),
    saveBtn: $('saveBtn'),
    applyBtn: $('applyBtn'),
    applyCount: $('applyCount'),
    moreBtn: $('moreBtn'),
    moreMenu: $('moreMenu'),
    viewToast: $('viewToast'),
    toast: $('toast'),
    toastText: $('toastText'),
    toastIcon: $('toastIcon'),
    applyDialog: $('applyDialog'),
    applyBody: $('applyBody'),
    applyNote: $('applyNote'),
    applyConfirmBtn: $('applyConfirmBtn'),
    applyCloseBtn: $('applyCloseBtn'),
    applyCancelBtn: $('applyCancelBtn'),
    canvas3d: $('canvas3d'),
    povOverlay: $('povOverlay'),
    povBtn: $('povBtn'),
    povLens: $('povLens'),
    povShot: $('povShot'),
    hint3d: $('hint3d'),
    loading3d: $('loading3d'),
    zoomInBtn: $('zoomInBtn'),
    zoomOutBtn: $('zoomOutBtn'),
    zoomFitBtn: $('zoomFitBtn'),
    backBtn: $('backBtn'),
  };

  /* ===== 度量 ===== */
  const FLOOR = {
    x0: ROOM.x0 * PX,
    z0: ROOM.z0 * PX,
    x1: ROOM.x1 * PX,
    z1: ROOM.z1 * PX,
  };
  FLOOR.w = FLOOR.x1 - FLOOR.x0;
  FLOOR.h = FLOOR.z1 - FLOOR.z0;

  let svgGhostLayer = null;
  let svgPathLayer = null;
  let svgFrustumLayer = null;

  function optionList(options, current) {
    return options.map((item) => `<option value="${esc(item)}"${item === current ? ' selected' : ''}>${esc(item)}</option>`).join('');
  }

  function statusOf(shot) {
    if (shot.stale) return { text: '需重新生成', cls: 'is-stale' };
    if (shot.hasVideo) return { text: '已生成', cls: 'is-ready' };
    return { text: '未生成', cls: '' };
  }

  function subshotChanged(shot) {
    const base = shot.base.subshots || [];
    if (base.length !== shot.subshots.length) return true;
    return shot.subshots.some((item, index) => item.description !== base[index]);
  }

  function shotHasWriteChange(shot) {
    if (Object.keys(diffFields(shot)).length > 0) return true;
    return canSyncSubshots(shot) && subshotChanged(shot);
  }

  function serializeShots() {
    return state.shots.map((shot) => ({
      id: shot.id,
      number: shot.number,
      scene: shot.scene,
      duration: shot.duration,
      hasVideo: shot.hasVideo,
      stale: shot.stale,
      camera: { ...shot.camera },
      blocking: shot.blocking.map((actor) => ({ ...actor })),
      subshots: shot.subshots.map((item) => ({ ...item })),
      path: shot.path.map((point) => ({ ...point })),
      originalSubshotCount: shot.originalSubshotCount,
      base: { ...shot.base, subshots: [...(shot.base.subshots || [])] },
      promptAppended: !!shot.promptAppended,
      subshotsSyncedAt: shot.subshotsSyncedAt || null,
      appliedAt: shot.appliedAt || null,
    }));
  }

  function isDirty() {
    return JSON.stringify(serializeShots()) !== JSON.stringify(state.savedSnapshot);
  }

  /* ===== 俯视平面图 ===== */
  function buildFloorSvg() {
    const f = FLOOR;
    const desk = SCENE.desk;
    const chair = SCENE.chair;
    const shelf = SCENE.shelf;
    const sofa = SCENE.sofa;
    const rug = SCENE.rug;
    const win = SCENE.window;
    const door = SCENE.door;
    const deskX = (desk.x - desk.w / 2) * PX;
    const deskY = (desk.z - desk.d / 2) * PX;
    const deskW = desk.w * PX;
    const deskH = desk.d * PX;
    const chairX = (chair.x - chair.w / 2) * PX;
    const chairY = (chair.z - chair.d / 2) * PX;
    const chairW = chair.w * PX;
    const chairH = chair.d * PX;
    const shelfX = (shelf.x - shelf.w / 2) * PX;
    const shelfY = (shelf.z - shelf.d / 2) * PX;
    const shelfW = shelf.w * PX;
    const shelfH = shelf.d * PX;
    const sofaX = (sofa.x - sofa.w / 2) * PX;
    const sofaY = (sofa.z - sofa.d / 2) * PX;
    const sofaW = sofa.w * PX;
    const sofaH = sofa.d * PX;
    const rugX = (rug.x - rug.w / 2) * PX;
    const rugY = (rug.z - rug.d / 2) * PX;
    const rugW = rug.w * PX;
    const rugH = rug.d * PX;
    const winX = win.x0 * PX;
    const winW = (win.x1 - win.x0) * PX;
    const winY = win.z * PX;
    const doorX = door.x0 * PX;
    const doorW = (door.x1 - door.x0) * PX;
    const doorY = door.z * PX;
    const wall = 8;
    const meterLines = [];

    for (let m = Math.ceil(ROOM.x0); m <= Math.floor(ROOM.x1); m += 1) {
      const x = m * PX;
      const major = m % 5 === 0;
      meterLines.push(`<line x1="${x}" y1="${f.z0}" x2="${x}" y2="${f.z1}" stroke="rgba(148,163,184,${major ? 0.12 : 0.055})" stroke-width="1"/>`);
      if (m % 2 === 0) {
        meterLines.push(`<text class="ruler-text" x="${x}" y="${f.z0 - 8}" text-anchor="middle">${m}m</text>`);
      }
    }
    for (let m = Math.ceil(ROOM.z0); m <= Math.floor(ROOM.z1); m += 1) {
      const y = m * PX;
      const major = m % 5 === 0;
      meterLines.push(`<line x1="${f.x0}" y1="${y}" x2="${f.x1}" y2="${y}" stroke="rgba(148,163,184,${major ? 0.12 : 0.055})" stroke-width="1"/>`);
      if (m % 2 === 0) {
        meterLines.push(`<text class="ruler-text" x="${f.x0 - 9}" y="${y + 3}" text-anchor="end">${m}m</text>`);
      }
    }

    const books = [];
    for (let i = 0; i < 5; i += 1) {
      const bw = 4 + (i % 3);
      const bh = 16 + (i * 5) % 13;
      books.push(`<rect x="${shelfX + 6 + i * 7}" y="${shelfY + shelfH - 7 - bh}" width="${bw}" height="${bh}" rx="1" fill="rgba(${i % 2 ? '125,211,252' : '255,176,118'},0.55)"/>`);
    }

    const deskLabelX = desk.x * PX + 26;
    const deskLabelY = desk.z * PX + 5;

    return `
      <defs>
        <linearGradient id="floorGrad" x1="0" y1="0" x2="0.42" y2="1">
          <stop offset="0" stop-color="#1b2634"/>
          <stop offset="0.55" stop-color="#151e2a"/>
          <stop offset="1" stop-color="#101721"/>
        </linearGradient>
        <linearGradient id="woodGrad" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stop-color="#4a3a2c"/>
          <stop offset="1" stop-color="#2a211a"/>
        </linearGradient>
        <radialGradient id="lampGlow">
          <stop offset="0" stop-color="rgba(255,196,142,0.42)"/>
          <stop offset="0.45" stop-color="rgba(255,176,118,0.14)"/>
          <stop offset="1" stop-color="rgba(255,176,118,0)"/>
        </radialGradient>
        <clipPath id="roomClip"><rect x="${f.x0}" y="${f.z0}" width="${f.w}" height="${f.h}" rx="3"/></clipPath>
      </defs>

      <rect x="${f.x0}" y="${f.z0}" width="${f.w}" height="${f.h}" rx="3" fill="url(#floorGrad)"/>
      <g clip-path="url(#roomClip)">${meterLines.join('')}</g>

      <rect x="${rugX}" y="${rugY}" width="${rugW}" height="${rugH}" rx="10" fill="#211c19" stroke="#3b2f26" stroke-width="1.2"/>
      <rect x="${rugX + 9}" y="${rugY + 9}" width="${rugW - 18}" height="${rugH - 18}" rx="6" fill="none" stroke="rgba(255,176,118,0.13)" stroke-dasharray="5 6"/>
      <path d="M ${rugX + 14} ${rugY + 18} L ${rugX + rugW / 2} ${rugY + rugH / 2} L ${rugX + rugW - 14} ${rugY + 18}M ${rugX + 14} ${rugY + rugH - 18} L ${rugX + rugW / 2} ${rugY + rugH / 2} L ${rugX + rugW - 14} ${rugY + rugH - 18}" fill="none" stroke="rgba(255,176,118,0.06)" stroke-width="1"/>

      <rect x="${sofaX + 4}" y="${sofaY + 5}" width="${sofaW}" height="${sofaH}" rx="5" fill="rgba(0,0,0,0.28)"/>
      <rect x="${sofaX}" y="${sofaY}" width="${sofaW}" height="${sofaH}" rx="5" fill="#263342" stroke="#3c4c60" stroke-width="1"/>
      <rect x="${sofaX + 2}" y="${sofaY + 4}" width="10" height="${sofaH - 8}" rx="3" fill="#1c2733"/>
      ${[0, 1].map((i) => `<rect x="${sofaX + 15}" y="${sofaY + 8 + i * (sofaH - 16) / 2 + 2}" width="${sofaW - 21}" height="${(sofaH - 22) / 2}" rx="3" fill="rgba(125,211,252,0.08)" stroke="rgba(148,163,184,0.14)"/>`).join('')}

      <rect x="${deskX + 4}" y="${deskY + 5}" width="${deskW}" height="${deskH}" rx="3" fill="rgba(0,0,0,0.3)"/>
      <rect x="${deskX}" y="${deskY}" width="${deskW}" height="${deskH}" rx="3" fill="url(#woodGrad)" stroke="rgba(255,176,118,0.22)" stroke-width="1"/>
      <rect x="${deskX + 5}" y="${deskY + 5}" width="${deskW - 10}" height="${deskH - 10}" rx="2" fill="none" stroke="rgba(255,255,255,0.06)"/>
      <path d="M ${deskX + deskW - 34} ${deskY + 8} v ${deskH - 16}" stroke="rgba(255,176,118,0.18)" stroke-width="1"/>
      <g transform="rotate(-8 ${deskX + deskW * 0.44} ${deskY + deskH * 0.52})">
        <rect x="${deskX + deskW * 0.3}" y="${deskY + deskH * 0.34}" width="${PX * 0.45}" height="${PX * 0.3}" rx="2" fill="#d9c8a5" opacity="0.82" stroke="rgba(90,72,50,0.5)"/>
        <path d="M ${deskX + deskW * 0.3} ${deskY + deskH * 0.34} l ${PX * 0.225} ${PX * 0.16} l ${PX * 0.225} -${PX * 0.16}" fill="none" stroke="rgba(90,72,50,0.45)" stroke-width="1"/>
        <circle cx="${deskX + deskW * 0.525}" cy="${deskY + deskH * 0.49}" r="3.2" fill="#a63a32"/>
      </g>
      <circle cx="${SCENE.lamp.x * PX}" cy="${SCENE.lamp.z * PX}" r="${PX * 0.9}" fill="url(#lampGlow)"/>
      <circle cx="${SCENE.lamp.x * PX}" cy="${SCENE.lamp.z * PX}" r="6.5" fill="#ffcf9e" stroke="rgba(255,236,210,0.7)" stroke-width="1"/>
      <circle cx="${SCENE.lamp.x * PX}" cy="${SCENE.lamp.z * PX}" r="2.4" fill="#fff4e2"/>

      <rect x="${chairX}" y="${chairY}" width="${chairW}" height="${chairH}" rx="3" fill="#2b3038" stroke="#454d59" stroke-width="1"/>
      <rect x="${chairX + 3}" y="${chairY + 3}" width="${chairW - 6}" height="${chairH - 10}" rx="2" fill="#20262e"/>
      <rect x="${chairX + 2}" y="${chairY + chairH - 6}" width="${chairW - 4}" height="4" rx="2" fill="#3a424e"/>

      <rect x="${shelfX}" y="${shelfY}" width="${shelfW}" height="${shelfH}" rx="2" fill="#2f261f" stroke="#4c3b2d" stroke-width="1"/>
      <line x1="${shelfX + shelfW / 2}" y1="${shelfY + 3}" x2="${shelfX + shelfW / 2}" y2="${shelfY + shelfH - 3}" stroke="rgba(255,255,255,0.07)"/>
      ${books.join('')}

      <text class="furniture-label" x="${deskLabelX}" y="${deskLabelY}" text-anchor="middle">书桌</text>
      <text class="furniture-label" x="${sofaX + sofaW / 2}" y="${sofaY + sofaH + 15}" text-anchor="middle">沙发</text>
      <text class="furniture-label" x="${shelfX + shelfW / 2}" y="${shelfY + shelfH + 14}" text-anchor="middle">书架</text>

      <g stroke="#3a4758" stroke-width="${wall}" stroke-linecap="square">
        <line x1="${f.x0}" y1="${f.z0}" x2="${winX}" y2="${f.z0}"/>
        <line x1="${winX + winW}" y1="${f.z0}" x2="${f.x1}" y2="${f.z0}"/>
        <line x1="${f.x0}" y1="${f.z1}" x2="${doorX}" y2="${f.z1}"/>
        <line x1="${doorX + doorW}" y1="${f.z1}" x2="${f.x1}" y2="${f.z1}"/>
        <line x1="${f.x0}" y1="${f.z0}" x2="${f.x0}" y2="${f.z1}"/>
        <line x1="${f.x1}" y1="${f.z0}" x2="${f.x1}" y2="${f.z1}"/>
      </g>
      <g stroke="rgba(255,255,255,0.09)" stroke-width="1.4">
        <line x1="${f.x0 + 5}" y1="${f.z0 + 5}" x2="${winX}" y2="${f.z0 + 5}"/>
        <line x1="${winX + winW}" y1="${f.z0 + 5}" x2="${f.x1 - 5}" y2="${f.z0 + 5}"/>
        <line x1="${f.x0 + 5}" y1="${f.z0 + 5}" x2="${f.x0 + 5}" y2="${f.z1 - 5}"/>
        <line x1="${f.x1 - 5}" y1="${f.z0 + 5}" x2="${f.x1 - 5}" y2="${f.z1 - 5}"/>
      </g>

      <rect x="${winX}" y="${winY - 4}" width="${winW}" height="8" fill="rgba(125,211,252,0.28)" stroke="rgba(125,211,252,0.72)" stroke-width="1"/>
      <line x1="${winX + winW / 3}" y1="${winY - 4}" x2="${winX + winW / 3}" y2="${winY + 4}" stroke="rgba(8,16,24,0.65)"/>
      <line x1="${winX + winW * 2 / 3}" y1="${winY - 4}" x2="${winX + winW * 2 / 3}" y2="${winY + 4}" stroke="rgba(8,16,24,0.65)"/>

      <path d="M ${doorX} ${doorY} A ${doorW} ${doorW} 0 0 1 ${doorX + doorW} ${doorY - doorW}" fill="none" stroke="rgba(255,176,118,0.34)" stroke-width="1.2" stroke-dasharray="4 5"/>
      <line x1="${doorX + doorW}" y1="${doorY}" x2="${doorX + doorW}" y2="${doorY - doorW}" stroke="rgba(255,176,118,0.8)" stroke-width="2.2" stroke-linecap="round"/>
      <circle cx="${doorX + doorW}" cy="${doorY}" r="2.6" fill="rgba(255,176,118,0.9)"/>

      <text class="room-label" x="${f.x0 + 16}" y="${f.z0 + 24}">老宅书房</text>
      <text class="ruler-text" x="${f.x0 + 16}" y="${f.z0 + 39}" fill="rgba(148,163,184,0.4)">场景 3 · 9.5m × 6.3m</text>

      <g transform="translate(${f.x1 + 18} ${f.z0 + 4})">
        <circle r="14" fill="rgba(8,12,18,0.5)" stroke="rgba(148,163,184,0.2)"/>
        <path d="M0 -9 L4 5 L0 2 L-4 5 Z" fill="rgba(255,176,118,0.9)"/>
        <text class="ruler-text" x="0" y="-16" text-anchor="middle" fill="rgba(255,176,118,0.8)">北</text>
      </g>

      <g transform="translate(${f.x0 + 4} ${f.z1 + 28})">
        <line x1="0" y1="0" x2="${PX}" y2="0" stroke="rgba(226,232,240,0.5)" stroke-width="1.5"/>
        <line x1="0" y1="-4" x2="0" y2="4" stroke="rgba(226,232,240,0.5)" stroke-width="1.5"/>
        <line x1="${PX}" y1="-4" x2="${PX}" y2="4" stroke="rgba(226,232,240,0.5)" stroke-width="1.5"/>
        <text class="ruler-text" x="${PX / 2}" y="-7" text-anchor="middle">1 m</text>
      </g>

      <g id="ghostPathLayer" clip-path="url(#roomClip)"></g>
      <g id="pathLayer" clip-path="url(#roomClip)"></g>
      <g id="frustumLayer" clip-path="url(#roomClip)"></g>
    `;
  }

  /* ===== 2D 排演 ===== */
  function actorHandlesHtml(shot) {
    return shot.blocking.map((actor, index) => {
      const meta = actorMeta(actor.id);
      const active = state.selectedEntity === `actor:${actor.id}`;
      return `
        <button class="actor${active ? ' is-selected' : ''}" type="button" data-drag="actor" data-index="${index}" data-id="${actor.id}"
          style="left:${actor.x * PX}px;top:${actor.z * PX}px;--actor-color:${meta.color};--actor-color-deep:${meta.deep}"
          aria-label="${esc(meta.name)}站位，拖动调整">
          <span class="actor-facing" style="--facing:${actor.rotation}deg"></span>
          <span class="actor-disc">${esc(meta.initial)}</span>
          <span class="actor-name">${esc(meta.name)} · ${Math.round(actor.rotation)}°</span>
        </button>`;
    }).join('');
  }

  function waypointHandlesHtml(shot) {
    return shot.path.map((point, index) => `
      <button class="wp${index === state.activeSubshot ? ' is-active' : ''}" type="button" data-drag="waypoint" data-index="${index}"
        style="left:${point.x * PX}px;top:${point.z * PX}px" title="子镜头 ${index + 1} 的机位点">${index + 1}</button>`).join('');
  }

  function updatePathSvg() {
    if (!svgGhostLayer || !svgPathLayer || !svgFrustumLayer) return;
    const shot = selectedShot();
    if (!shot) return;

    svgGhostLayer.innerHTML = state.shots.map((item, index) => {
      if (index === state.selectedShot) return '';
      return `<g opacity="0.5">
        <circle cx="${item.camera.x * PX}" cy="${item.camera.z * PX}" r="8" fill="rgba(125,211,252,0.06)" stroke="rgba(125,211,252,0.32)" stroke-dasharray="2 3"/>
        <text x="${item.camera.x * PX}" y="${item.camera.z * PX + 3}" text-anchor="middle" font-size="8.5" font-family="ui-monospace, monospace" fill="rgba(125,211,252,0.7)">${item.number}</text>
      </g>`;
    }).join('');

    const points = shot.path.map((point) => `${point.x * PX},${point.z * PX}`).join(' ');
    const active = Math.max(0, state.activeSubshot);
    const next = shot.path[active + 1];
    let activeLeg = '';
    if (next) {
      const from = shot.path[active];
      activeLeg = `<line x1="${from.x * PX}" y1="${from.z * PX}" x2="${next.x * PX}" y2="${next.z * PX}" stroke="rgba(255,176,118,0.92)" stroke-width="2.8" stroke-linecap="round"/>`;
    }

    svgPathLayer.innerHTML = `
      <polyline points="${points}" class="path-glow"/>
      <polyline points="${points}" class="path-line"/>
      ${activeLeg}
    `;

    const cam = shot.camera;
    const hfov = 2 * Math.atan(18 / Math.max(12, cam.lens));
    const len = 4.8 * PX;
    const cx = cam.x * PX;
    const cy = cam.z * PX;
    const yaw = cam.yaw * Math.PI / 180;
    const baseAngle = Math.atan2(-Math.cos(yaw), Math.sin(yaw));
    const a1 = baseAngle - hfov / 2;
    const a2 = baseAngle + hfov / 2;
    const p1 = { x: cx + Math.cos(a1) * len, y: cy + Math.sin(a1) * len };
    const p2 = { x: cx + Math.cos(a2) * len, y: cy + Math.sin(a2) * len };
    const mid = { x: cx + Math.cos(baseAngle) * len, y: cy + Math.sin(baseAngle) * len };

    svgFrustumLayer.innerHTML = `
      <path d="M ${cx} ${cy} L ${p1.x} ${p1.y} A ${len} ${len} 0 0 1 ${p2.x} ${p2.y} Z" class="frustum"/>
      <path d="M ${p1.x} ${p1.y} A ${len} ${len} 0 0 1 ${p2.x} ${p2.y}" fill="none" stroke="rgba(255,176,118,0.25)" stroke-width="1" stroke-dasharray="3 5"/>
      <line x1="${cx}" y1="${cy}" x2="${mid.x}" y2="${mid.y}" class="frustum-sight"/>
    `;
  }

  function updateCameraHandle() {
    const shot = selectedShot();
    if (!shot) return;
    const cam = shot.camera;
    el.cameraHandle.style.left = `${cam.x * PX}px`;
    el.cameraHandle.style.top = `${cam.z * PX}px`;
    el.cameraHandle.classList.toggle('is-selected', state.selectedEntity === 'camera');
    const body = el.cameraHandle.querySelector('.cam-body');
    if (body) body.style.transform = `rotate(${cam.yaw}deg)`;
    el.camTag.textContent = `CAM ${pad2(shot.number)} · ${cam.lens}mm`;
    el.cameraHandle.title = `摄影机 · 高 ${round2(cam.height)}m · ${compass(cam.yaw)} ${Math.round(norm360(cam.yaw))}°`;
  }

  function updateSelectionClasses() {
    el.actorHandles.querySelectorAll('.actor').forEach((node) => {
      const id = node.dataset.id;
      node.classList.toggle('is-selected', state.selectedEntity === `actor:${id}`);
    });
    el.pathHandles.querySelectorAll('.wp').forEach((node) => {
      node.classList.toggle('is-active', Number(node.dataset.index) === state.activeSubshot);
    });
    el.cameraHandle.classList.toggle('is-selected', state.selectedEntity === 'camera');
  }

  function renderStage2D() {
    const shot = selectedShot();
    if (!shot) return;
    el.actorHandles.innerHTML = actorHandlesHtml(shot);
    el.pathHandles.innerHTML = waypointHandlesHtml(shot);
    updateCameraHandle();
    updatePathSvg();
    updateSelectionClasses();
    renderPip();
    syncZoomLabel();
    updateWorldTransform();
  }

  function update2dDynamic() {
    const shot = selectedShot();
    if (!shot) return;
    el.actorHandles.querySelectorAll('.actor').forEach((node) => {
      const index = Number(node.dataset.index);
      const actor = shot.blocking[index];
      if (!actor) return;
      node.style.left = `${actor.x * PX}px`;
      node.style.top = `${actor.z * PX}px`;
      node.querySelector('.actor-facing').style.setProperty('--facing', `${actor.rotation}deg`);
      node.querySelector('.actor-name').textContent = `${actorMeta(actor.id).name} · ${Math.round(actor.rotation)}°`;
    });
    el.pathHandles.querySelectorAll('.wp').forEach((node) => {
      const index = Number(node.dataset.index);
      const point = shot.path[index];
      if (!point) return;
      node.style.left = `${point.x * PX}px`;
      node.style.top = `${point.z * PX}px`;
    });
    updateCameraHandle();
    updatePathSvg();
    renderPip();
    updateLiveInspectorValues();
    if (state.view === '3d') schedule3d();
  }

  function syncZoomLabel() {
    el.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
    el.world.style.setProperty('--inv', String(1 / state.zoom));
  }

  function updateWorldTransform() {
    el.world.style.transform = `translate(-50%, -50%) translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
    syncZoomLabel();
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = el.stageViewport.getBoundingClientRect();
    const next = clamp(state.zoom * factor, 0.55, 2);
    if (Math.abs(next - state.zoom) < 0.0005) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    state.pan.x = state.pan.x + (clientX - cx - state.pan.x) * (1 - next / state.zoom);
    state.pan.y = state.pan.y + (clientY - cy - state.pan.y) * (1 - next / state.zoom);
    state.zoom = next;
    updateWorldTransform();
  }

  function fitStage() {
    const rect = el.stageViewport.getBoundingClientRect();
    const fit = clamp(Math.min((rect.width - 96) / 616, (rect.height - 110) / 437, 1.35), 0.55, 1.35);
    state.zoom = fit;
    state.pan.x = 0;
    state.pan.y = 0;
    updateWorldTransform();
    showViewToast(`已适应窗口 · ${Math.round(fit * 100)}%`);
  }

  /* ===== 镜头列表与镜头条 ===== */
  function renderStats() {
    const ready = state.shots.filter((shot) => shot.hasVideo).length;
    el.shotCount.textContent = String(state.shots.length);
    el.totalDuration.textContent = fmtClock(totalDuration());
    el.readyCount.textContent = String(ready);
    el.pendingCount.textContent = String(state.shots.length - ready);
    el.stripSummary.textContent = `${state.shots.length} 镜 · ${fmtClock(totalDuration())}`;
  }

  function renderShotList() {
    const html = state.shots.map((shot, index) => {
      const status = statusOf(shot);
      const active = index === state.selectedShot;
      const changed = shotHasWriteChange(shot);
      const first = shot.subshots[0] ? shot.subshots[0].description.slice(0, 15) : '暂无子镜头';
      return `
        <button class="shot-row${active ? ' is-active' : ''}${changed ? ' has-dirty' : ''}" type="button" data-shot="${index}" aria-current="${active ? 'true' : 'false'}">
          <span class="shot-thumb"><i class="th-glow"></i><i class="th-a"></i><i class="th-b"></i></span>
          <span class="shot-main">
            <span class="shot-line"><b>镜 ${pad2(shot.number)}</b><span class="shot-status ${status.cls}">${status.text}</span></span>
            <span class="shot-sub">${shot.subshots.length} 子镜 · ${esc(first)}</span>
          </span>
          <span class="shot-dur">${fmtSec(shot.duration)}</span>
          ${changed ? '<i class="dirty-dot" title="有未写回分镜的改动"></i>' : ''}
        </button>`;
    }).join('');
    el.shotList.innerHTML = html;
    if (state.view === '2d') scrollSelectedRow();
  }

  function renderStrip() {
    const html = state.shots.map((shot, index) => {
      const status = statusOf(shot);
      const changed = shotHasWriteChange(shot);
      return `
        <button class="strip-card${index === state.selectedShot ? ' is-active' : ''}" type="button" data-strip="${index}">
          <span class="strip-thumb"></span>
          <span class="strip-meta"><b>镜 ${pad2(shot.number)}</b><span>${fmtSec(shot.duration)}</span></span>
          <span class="strip-status ${status.cls}">${status.text}</span>
          ${changed ? '<i class="dirty-dot" title="有未写回分镜的改动"></i>' : ''}
        </button>`;
    }).join('');
    el.stripTrack.innerHTML = html;
  }

  function scrollSelectedRow() {
    requestAnimationFrame(() => {
      const active = el.shotList.querySelector('.shot-row.is-active');
      if (active) active.scrollIntoView({ block: 'nearest' });
      const card = el.stripTrack.querySelector('.strip-card.is-active');
      if (card) card.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
  }

  function selectShot(index, silent) {
    const next = clamp(index, 0, state.shots.length - 1);
    if (next !== state.selectedShot) {
      state.selectedShot = next;
      state.activeSubshot = 0;
      state.selectedEntity = 'camera';
    }
    renderShotList();
    renderStrip();
    renderStats();
    renderStage2D();
    renderInspector();
    updateApplyBadge();
    if (state.view === '3d') {
      schedule3d();
      updatePovUi();
      if (!silent && state.cameraPov) showViewToast(`机位视角已跟随镜 ${pad2(selectedShot().number)}`);
    }
  }

  function setActiveSubshot(index) {
    const shot = selectedShot();
    const point = shot.path[index];
    if (!point) return;
    state.activeSubshot = index;
    state.selectedEntity = 'waypoint';
    shot.camera.x = point.x;
    shot.camera.z = point.z;
    update2dDynamic();
    updateSelectionClasses();
    renderInspector();
    if (state.view === '3d') {
      updatePovUi();
      schedule3d();
    }
  }

  /* ===== 机位预览 ===== */
  function renderPip() {
    const shot = selectedShot();
    if (!shot) return;
    el.pipMeta.textContent = `${shot.camera.lens}mm · ${shot.camera.shotType}`;
    el.pipShot.textContent = `镜 ${pad2(shot.number)} · ${fmtSec(shot.duration)}`;

    const frameW = el.pipFrame.clientWidth || 216;
    const frameH = el.pipFrame.clientHeight || 114;
    const lens = Math.max(12, Number(shot.camera.lens) || 35);
    const hfov = 2 * Math.atan(18 / lens);
    const vfov = 2 * Math.atan(12 / lens);
    const fx = (frameW / 2) / Math.tan(hfov / 2);
    const fy = (frameH / 2) / Math.tan(vfov / 2);
    const yaw = shot.camera.yaw * Math.PI / 180;
    const forward = { x: Math.sin(yaw), z: -Math.cos(yaw) };
    const right = { x: Math.cos(yaw), z: Math.sin(yaw) };
    const horizon = frameH * 0.46;
    let html = '';
    let shown = 0;

    shot.blocking.forEach((actor) => {
      const dx = actor.x - shot.camera.x;
      const dz = actor.z - shot.camera.z;
      const zc = dx * forward.x + dz * forward.z;
      const xc = dx * right.x + dz * right.z;
      if (zc < 0.28) return;
      const sx = frameW / 2 + (xc / zc) * fx;
      const baseY = horizon + (fy * shot.camera.height) / zc;
      const heightPx = (fy * 1.7) / zc;
      const headY = baseY - heightPx;
      if (sx < -28 || sx > frameW + 28 || headY > frameH + 20 || baseY < -16) return;
      shown += 1;
      const size = clamp(heightPx * 0.2, 6, 30);
      const top = clamp(headY + Math.min(18, heightPx * 0.16), 4, frameH - 10);
      const meta = actorMeta(actor.id);
      html += `<span class="pip-actor" style="left:${round2(sx)}px;top:${round2(top)}px;--actor-color:${meta.color};--size:${round2(size)}px"><i></i><b>${esc(meta.name)}</b></span>`;
    });

    el.pipActors.innerHTML = html;
    el.pipEmpty.hidden = shown > 0;
  }

  /* ===== 检查器 ===== */
  function num(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function captureInspectorState() {
    const active = document.activeElement;
    const focus = active && el.inspector.contains(active) && active.dataset ? {
      role: active.dataset.role || '',
      key: active.dataset.key || '',
      index: active.dataset.index || '',
      id: active.dataset.id || '',
      action: active.dataset.action || '',
    } : null;
    const scrollNode = el.inspector.querySelector('.insp-scroll');
    const open = {};
    el.inspector.querySelectorAll('details[data-section]').forEach((node) => {
      open[node.dataset.section] = node.open;
    });
    return { focus, scroll: scrollNode ? scrollNode.scrollTop : 0, open };
  }

  function focusSelector(desc) {
    const parts = [];
    ['role', 'key', 'id', 'index', 'action'].forEach((field) => {
      if (desc[field]) parts.push(`[data-${field}="${desc[field]}"]`);
    });
    return parts.join('');
  }

  function restoreInspectorState(ctx) {
    const scrollNode = el.inspector.querySelector('.insp-scroll');
    if (scrollNode) scrollNode.scrollTop = ctx.scroll;
    if (!ctx.focus) return;
    const selector = focusSelector(ctx.focus);
    if (!selector) return;
    const node = el.inspector.querySelector(selector);
    if (node && typeof node.focus === 'function') node.focus({ preventScroll: true });
  }

  function inspectorHtml(shot, openState) {
    const status = statusOf(shot);
    const diff = diffFields(shot);
    const diffKeys = Object.keys(diff);
    const total = subshotTotal(shot);
    const valid = subshotValid(shot);
    const totalRatio = clamp(total / Math.max(0.1, shot.duration), 0, 1);
    const syncable = canSyncSubshots(shot);
    const syncChanged = syncable && subshotChanged(shot);
    const canApply = valid && (diffKeys.length > 0 || syncChanged);
    const openAttr = (key) => (openState[key] === false ? '' : ' open');
    const statusChip = status.cls === 'is-ready' ? 'is-ok' : status.cls === 'is-stale' ? 'is-warn' : 'is-muted';

    const warnings = [];
    if (!valid) {
      const gap = round2(Math.abs(total - shot.duration));
      warnings.push(`<div class="warning-card"><b>子镜头时长不匹配。</b>合计 ${fmtSec(total)}，镜头 ${fmtSec(shot.duration)}，相差 ${fmtSec(gap)}；调整到 ±0.2s 内才能写回。</div>`);
    }
    if (shot.stale) {
      warnings.push('<div class="warning-card"><b>该镜头已生成视频。</b>写回后标记为需重新生成；旧视频与现有任务不会被删除。</div>');
    }

    const diffRows = FIELD_KEYS.map((key) => {
      const changed = !!diff[key];
      const before = fmtFieldValue(key, shot.base[key]);
      const after = fmtFieldValue(key, currentFieldValue(shot, key));
      return `<div class="diff-row">
        <span class="diff-label">${FIELD_LABELS[key]}<span class="diff-chip${changed ? ' is-changed' : ''}">${changed ? '已改' : '未改'}</span></span>
        <span class="diff-value">${changed ? `<b>${esc(before)}</b> → ${esc(after)}` : esc(after)}</span>
      </div>`;
    }).join('');

    const actors = shot.blocking.map((actor) => {
      const meta = actorMeta(actor.id);
      const active = state.selectedEntity === `actor:${actor.id}`;
      return `<div class="actor-row${active ? ' is-active' : ''}" data-actor-row="${actor.id}">
        <div class="actor-row-head">
          <span class="actor-avatar" style="--actor-color:${meta.color};--actor-color-deep:${meta.deep}">${esc(meta.initial)}</span>
          <b>${esc(meta.name)}</b>
          <small>${round2(actor.x)}, ${round2(actor.z)}</small>
          <button class="actor-locate" type="button" data-locate="${actor.id}" title="在俯视图中选中" aria-label="在俯视图中选中${esc(meta.name)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
          </button>
        </div>
        <div class="actor-inputs">
          <label class="field"><span>X</span><input type="number" step="0.05" data-role="actor" data-id="${actor.id}" data-key="x" value="${round2(actor.x)}"></label>
          <label class="field"><span>Z</span><input type="number" step="0.05" data-role="actor" data-id="${actor.id}" data-key="z" value="${round2(actor.z)}"></label>
          <label class="field"><span>朝向</span><input type="number" step="5" min="0" max="359" data-role="actor" data-id="${actor.id}" data-key="rotation" value="${Math.round(actor.rotation)}"></label>
        </div>
      </div>`;
    }).join('');

    const subshots = shot.subshots.map((item, index) => `
      <div class="subshot-row${index === state.activeSubshot ? ' is-active' : ''}" data-subshot-row="${index}">
        <span class="ss-no">${index + 1}</span>
        <input class="ss-desc" type="text" data-role="sub-desc" data-index="${index}" value="${esc(item.description)}" aria-label="子镜头 ${index + 1} 描述">
        <input class="ss-dur" type="number" step="0.25" min="0.25" max="${shot.duration}" data-role="sub-dur" data-index="${index}" value="${round2(item.duration)}" aria-label="子镜头 ${index + 1} 时长">
        <button class="ss-del" type="button" data-action="del-subshot" data-index="${index}" title="删除子镜头" aria-label="删除子镜头" ${shot.subshots.length <= 2 ? 'disabled' : ''}>×</button>
      </div>`).join('');

    const appliedBits = [];
    if (shot.promptAppended) appliedBits.push('已追加机位提示');
    if (shot.subshotsSyncedAt) appliedBits.push('已同步子镜头描述');

    return `
      <div class="insp-head">
        <div>
          <span class="insp-kicker">镜 ${pad2(shot.number)} · ${fmtSec(shot.duration)} · ${shot.subshots.length} 子镜</span>
          <strong>${esc(shot.scene)}</strong>
        </div>
        <span class="chip ${statusChip}">${status.text}</span>
      </div>
      <div class="insp-scroll">
        ${warnings.join('')}

        <details class="insp-section" data-section="camera"${openAttr('camera')}>
          <summary>机位 <span class="section-meta">${esc(shot.camera.shotType)} · ${shot.camera.lens}mm · ${compass(shot.camera.yaw)}</span></summary>
          <div class="section-body">
            <div class="field-grid two">
              <label class="field"><span>景别</span><select data-role="camera" data-key="shotType">${optionList(SHOT_TYPES, shot.camera.shotType)}</select></label>
              <label class="field"><span>角度</span><select data-role="camera" data-key="angle">${optionList(ANGLES, shot.camera.angle)}</select></label>
            </div>
            <div class="field-grid two">
              <label class="field"><span>运动</span><select data-role="camera" data-key="movement">${optionList(MOVEMENTS, shot.camera.movement)}</select></label>
              <label class="field"><span>镜头时长 <b>${fmtSec(shot.duration)}</b></span><input type="number" step="0.25" min="8" max="15" data-role="duration" value="${round2(shot.duration)}"></label>
            </div>
            <label class="field"><span>焦距 <b>${shot.camera.lens}mm</b></span><input type="range" min="12" max="135" step="1" data-role="lens" value="${shot.camera.lens}"></label>
            <label class="field"><span>朝向 <b>${compass(shot.camera.yaw)} · ${Math.round(norm360(shot.camera.yaw))}°</b></span><input type="range" min="0" max="359" step="1" data-role="yaw" value="${Math.round(norm360(shot.camera.yaw))}"></label>
            <div class="field-grid two">
              <label class="field"><span>机位高度</span><input type="number" step="0.05" min="0.4" max="3.2" data-role="camera" data-key="height" value="${round2(shot.camera.height)}"></label>
              <label class="field"><span>朝向角度</span><input type="number" step="5" min="0" max="359" data-role="camera" data-key="yaw" value="${Math.round(norm360(shot.camera.yaw))}"></label>
            </div>
            <div class="field-grid two">
              <label class="field"><span>机位 X</span><input type="number" step="0.05" data-role="camera" data-key="x" value="${round2(shot.camera.x)}"></label>
              <label class="field"><span>机位 Z</span><input type="number" step="0.05" data-role="camera" data-key="z" value="${round2(shot.camera.z)}"></label>
            </div>
            <p class="hint-line">拖动俯视图中的摄影机或编号路径点，会同步机位坐标；当前高亮路径点对应子镜头 ${state.activeSubshot + 1}。</p>
          </div>
        </details>

        <details class="insp-section" data-section="blocking"${openAttr('blocking')}>
          <summary>人物站位 <span class="section-meta">${shot.blocking.length} 人 · 可拖拽</span></summary>
          <div class="section-body">
            ${actors || '<p class="hint-line">本集还没有关联人物。</p>'}
          </div>
        </details>

        <details class="insp-section" data-section="subshots"${openAttr('subshots')}>
          <summary>子镜头 <span class="section-meta">${fmtSec(total)} / ${fmtSec(shot.duration)}</span></summary>
          <div class="section-body">
            <div class="subshot-toolbar">
              <button class="subshot-add" type="button" data-action="add-subshot" ${shot.subshots.length >= 4 ? 'disabled' : ''}>+ 添加子镜头</button>
            </div>
            <div class="subshot-list">${subshots}</div>
            <div class="subshot-total">
              <div class="total-line"><span>子镜头合计</span><b>${fmtSec(total)} / ${fmtSec(shot.duration)}</b></div>
              <div class="total-bar${valid ? '' : ' is-warn'}${total > shot.duration + 0.2 ? ' is-over' : ''}"><i style="width:${round2(totalRatio * 100)}%"></i></div>
              <p class="hint-line${valid ? '' : ' is-warn'}">${valid ? '总时长与镜头时长匹配（±0.2s）。' : `相差 ${fmtSec(round2(Math.abs(total - shot.duration)))}，暂不能写回。`}</p>
            </div>
            <p class="hint-line">子镜头是镜头内的切点，不单独生成视频；只有数量与原文【镜头N】一致时才允许同步描述。</p>
          </div>
        </details>

        <details class="insp-section" data-section="writeback"${openAttr('writeback')}>
          <summary>写回分镜 <span class="section-meta">${diffKeys.length ? `${diffKeys.length} 项字段改动` : '暂无字段改动'}</span></summary>
          <div class="section-body">
            <div class="diff-list">${diffRows}</div>
            <div class="field-grid two">
              ${FIELD_KEYS.map((key) => `<label class="check-line"><input type="checkbox" data-role="write-field" data-key="${key}" ${state.writeFields[key] ? 'checked' : ''}>${FIELD_LABELS[key]}</label>`).join('')}
            </div>
            <label class="check-line"><input type="checkbox" data-role="append-prompt" ${state.apply.appendPrompt ? 'checked' : ''}>向视频提示词追加机位描述</label>
            <p class="hint-line">固定添加【机位】标记；重复应用不会重复追加。${shot.promptAppended ? '本镜已追加过。' : ''}</p>
            <label class="check-line${syncable ? '' : ' is-disabled'}"><input type="checkbox" data-role="sync-subshots" ${state.apply.syncSubshots ? 'checked' : ''} ${syncable ? '' : 'disabled'}>同步子镜头描述到分镜</label>
            <p class="hint-line">${syncable ? '仅在子镜头数量与原文【镜头N】一致时可同步。' : `当前 ${shot.subshots.length} 段，原文 ${shot.originalSubshotCount} 段；数量不一致，已禁用。`}</p>
            ${shot.appliedAt ? `<p class="hint-line">上次写回 ${fmtTime(shot.appliedAt)}${appliedBits.length ? ` · ${appliedBits.join(' · ')}` : ''}</p>` : ''}
            <div class="insp-actions">
              <button type="button" data-action="apply" ${canApply ? '' : 'disabled'}>${valid ? '应用到分镜…' : '子镜头时长不匹配，暂不能应用'}</button>
              <button type="button" data-action="reset-shot" ${(diffKeys.length || subshotChanged(shot)) ? '' : 'disabled'}>撤销未写回改动</button>
            </div>
          </div>
        </details>
      </div>`;
  }

  function renderInspector() {
    const shot = selectedShot();
    if (!shot) return;
    const ctx = captureInspectorState();
    el.inspector.innerHTML = inspectorHtml(shot, ctx.open);
    restoreInspectorState(ctx);
  }

  function updateLiveInspectorValues() {
    const shot = selectedShot();
    if (!shot) return;
    const setValue = (selector, value) => {
      const node = el.inspector.querySelector(selector);
      if (node && document.activeElement !== node) node.value = value;
    };
    setValue('[data-role="camera"][data-key="x"]', round2(shot.camera.x));
    setValue('[data-role="camera"][data-key="z"]', round2(shot.camera.z));
    shot.blocking.forEach((actor) => {
      setValue(`[data-role="actor"][data-id="${actor.id}"][data-key="x"]`, round2(actor.x));
      setValue(`[data-role="actor"][data-id="${actor.id}"][data-key="z"]`, round2(actor.z));
    });
  }

  function selectActor(id, withToast) {
    state.selectedEntity = `actor:${id}`;
    updateSelectionClasses();
    renderInspector();
    if (withToast) showToast(`已选中 ${actorMeta(id).name}`, 'ok');
  }

  function commitInspectorChange() {
    renderShotList();
    renderStrip();
    renderStats();
    renderInspector();
    renderStage2D();
    updateApplyBadge();
    markChanged({ render: false });
    if (state.view === '3d') schedule3d();
  }

  function onInspectorInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const shot = selectedShot();
    if (!shot) return;
    const role = target.dataset.role;

    if (role === 'lens') {
      shot.camera.lens = clamp(Math.round(num(target.value, shot.camera.lens)), 12, 135);
      const readout = target.closest('.field')?.querySelector('b');
      if (readout) readout.textContent = `${shot.camera.lens}mm`;
      updateCameraHandle();
      updatePathSvg();
      renderPip();
      markChanged({ render: false });
      if (state.view === '3d') schedule3d();
      return;
    }

    if (role === 'yaw') {
      shot.camera.yaw = norm360(Math.round(num(target.value, shot.camera.yaw)));
      const readout = target.closest('.field')?.querySelector('b');
      if (readout) readout.textContent = `${compass(shot.camera.yaw)} · ${Math.round(shot.camera.yaw)}°`;
      updateCameraHandle();
      updatePathSvg();
      renderPip();
      markChanged({ render: false });
      if (state.view === '3d') schedule3d();
    }
  }

  function onInspectorChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const shot = selectedShot();
    if (!shot) return;
    const role = target.dataset.role;

    if (role === 'camera' && target instanceof HTMLSelectElement) {
      const key = target.dataset.key;
      if (key && SHOT_TYPES.concat(ANGLES, MOVEMENTS).includes(target.value)) {
        shot.camera[key] = target.value;
        commitInspectorChange();
      }
      return;
    }

    if (role === 'duration' && target instanceof HTMLInputElement) {
      const value = clamp(num(target.value, shot.duration), 8, 15);
      shot.duration = round2(value);
      commitInspectorChange();
      return;
    }

    if ((role === 'lens' || role === 'yaw') && target instanceof HTMLInputElement) {
      if (role === 'lens') shot.camera.lens = clamp(Math.round(num(target.value, shot.camera.lens)), 12, 135);
      if (role === 'yaw') shot.camera.yaw = norm360(Math.round(num(target.value, shot.camera.yaw)));
      commitInspectorChange();
      return;
    }

    if (role === 'camera' && target instanceof HTMLInputElement) {
      const key = target.dataset.key;
      if (key === 'height') shot.camera.height = clamp(num(target.value, shot.camera.height), 0.4, 3.2);
      if (key === 'x') {
        shot.camera.x = clamp(num(target.value, shot.camera.x), ROOM.x0 + 0.2, ROOM.x1 - 0.2);
        if (shot.path[state.activeSubshot]) shot.path[state.activeSubshot].x = shot.camera.x;
      }
      if (key === 'z') {
        shot.camera.z = clamp(num(target.value, shot.camera.z), ROOM.z0 + 0.2, ROOM.z1 - 0.2);
        if (shot.path[state.activeSubshot]) shot.path[state.activeSubshot].z = shot.camera.z;
      }
      if (key === 'yaw') shot.camera.yaw = norm360(Math.round(num(target.value, shot.camera.yaw)));
      commitInspectorChange();
      return;
    }

    if (role === 'actor' && target instanceof HTMLInputElement) {
      const actor = shot.blocking.find((item) => item.id === target.dataset.id);
      if (!actor) return;
      const key = target.dataset.key;
      if (key === 'x') actor.x = clamp(num(target.value, actor.x), ROOM.x0 + 0.2, ROOM.x1 - 0.2);
      if (key === 'z') actor.z = clamp(num(target.value, actor.z), ROOM.z0 + 0.2, ROOM.z1 - 0.2);
      if (key === 'rotation') actor.rotation = norm360(Math.round(num(target.value, actor.rotation)));
      state.selectedEntity = `actor:${actor.id}`;
      commitInspectorChange();
      return;
    }

    if (role === 'sub-desc' && target instanceof HTMLInputElement) {
      const index = Number(target.dataset.index);
      if (shot.subshots[index]) shot.subshots[index].description = target.value;
      commitInspectorChange();
      return;
    }

    if (role === 'sub-dur' && target instanceof HTMLInputElement) {
      const index = Number(target.dataset.index);
      if (shot.subshots[index]) shot.subshots[index].duration = round2(clamp(num(target.value, shot.subshots[index].duration), 0.25, shot.duration));
      state.activeSubshot = index;
      commitInspectorChange();
      return;
    }

    if (role === 'write-field' && target instanceof HTMLInputElement) {
      state.writeFields[target.dataset.key] = target.checked;
      return;
    }

    if (role === 'append-prompt' && target instanceof HTMLInputElement) {
      state.apply.appendPrompt = target.checked;
      return;
    }

    if (role === 'sync-subshots' && target instanceof HTMLInputElement) {
      state.apply.syncSubshots = target.checked;
    }
  }

  function addSubshot() {
    const shot = selectedShot();
    if (!shot || shot.subshots.length >= 4) return;
    const remaining = round2(shot.duration - subshotTotal(shot));
    const duration = remaining >= 0.5 ? remaining : 1.5;
    shot.subshots.push({ description: '新子镜头：补充动作或反应。', duration });
    const last = shot.path[shot.path.length - 1] || { x: shot.camera.x, z: shot.camera.z };
    const dir = dirFromYaw(shot.camera.yaw);
    shot.path.push({
      x: clamp(round2(last.x + dir.x * 0.35), ROOM.x0 + 0.25, ROOM.x1 - 0.25),
      z: clamp(round2(last.z + dir.z * 0.35), ROOM.z0 + 0.25, ROOM.z1 - 0.25),
    });
    state.activeSubshot = shot.subshots.length - 1;
    state.selectedEntity = 'waypoint';
    shot.camera.x = shot.path[state.activeSubshot].x;
    shot.camera.z = shot.path[state.activeSubshot].z;
    commitInspectorChange();
    showToast('已添加子镜头，总时长偏出 ±0.2s 时无法写回', 'ok');
  }

  function deleteSubshot(index) {
    const shot = selectedShot();
    if (!shot || shot.subshots.length <= 2) return;
    shot.subshots.splice(index, 1);
    if (shot.path[index]) shot.path.splice(index, 1);
    state.activeSubshot = clamp(Math.min(state.activeSubshot, shot.subshots.length - 1), 0, shot.subshots.length - 1);
    if (shot.path[state.activeSubshot]) {
      shot.camera.x = shot.path[state.activeSubshot].x;
      shot.camera.z = shot.path[state.activeSubshot].z;
    }
    commitInspectorChange();
    showToast('已删除子镜头，记得对齐总时长', 'warn');
  }

  function resetShotChanges() {
    const shot = selectedShot();
    if (!shot) return;
    FIELD_KEYS.forEach((key) => {
      if (key === 'duration') shot.duration = shot.base.duration;
      else shot.camera[key] = shot.base[key];
    });
    if ((shot.base.subshots || []).length === shot.subshots.length) {
      shot.subshots.forEach((item, index) => {
        item.description = shot.base.subshots[index];
      });
    }
    state.selectedEntity = 'camera';
    commitInspectorChange();
    showToast('已恢复为上次写回的值，站位与机位保持不动', 'ok');
  }

  function onInspectorClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const actionNode = target.closest('[data-action]');
    if (actionNode) {
      const action = actionNode.dataset.action;
      if (action === 'add-subshot') addSubshot();
      if (action === 'del-subshot') deleteSubshot(Number(actionNode.dataset.index));
      if (action === 'apply') openApplyDialog();
      if (action === 'reset-shot') resetShotChanges();
      return;
    }

    const locate = target.closest('[data-locate]');
    if (locate) {
      selectActor(locate.dataset.locate, true);
      return;
    }

    if (target.closest('input, select, button')) return;

    const subshotRow = target.closest('[data-subshot-row]');
    if (subshotRow) {
      setActiveSubshot(Number(subshotRow.dataset.subshotRow));
      return;
    }

    const actorRow = target.closest('[data-actor-row]');
    if (actorRow) selectActor(actorRow.dataset.actorRow, false);
  }

  /* ===== 保存与提示 ===== */
  let autosaveTimer = 0;

  function showToast(text, tone = 'ok') {
    el.toast.classList.remove('is-ok', 'is-warn', 'is-danger');
    if (tone !== 'ok') el.toast.classList.add(`is-${tone}`);
    el.toastText.textContent = text;
    el.toast.classList.add('is-show');
    clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => el.toast.classList.remove('is-show'), 3000);
  }

  function showViewToast(text) {
    el.viewToast.textContent = text;
    el.viewToast.classList.add('is-show');
    clearTimeout(state.viewToastTimer);
    state.viewToastTimer = window.setTimeout(() => el.viewToast.classList.remove('is-show'), 1800);
  }

  function updateSaveUi() {
    el.saveState.classList.remove('is-saved', 'is-dirty', 'is-saving');
    if (state.saving) {
      el.saveState.classList.add('is-saving');
      el.saveText.textContent = '保存中…';
      el.saveBtn.disabled = true;
      return;
    }
    el.saveBtn.disabled = false;
    if (isDirty()) {
      el.saveState.classList.add('is-dirty');
      el.saveText.textContent = '未保存';
      el.saveState.title = '改动仅存在于当前浏览器，尚未写入本地计划';
    } else {
      el.saveState.classList.add('is-saved');
      el.saveText.textContent = state.savedAt ? `已保存 · ${fmtTime(state.savedAt)}` : '已保存';
      el.saveState.title = `导演计划版本 ${state.version} · 浏览器本地存储`;
    }
  }

  function updateApplyBadge() {
    const count = state.shots.filter(shotHasWriteChange).length;
    el.applyCount.hidden = count === 0;
    el.applyCount.textContent = String(count);
    el.applyBtn.title = count
      ? `${count} 个镜头有可写回的分镜字段改动`
      : '打开写回检查；当前没有字段改动';
  }

  function writeStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: state.version,
        savedAt: state.savedAt,
        ui: { selectedShot: state.selectedShot },
        shots: serializeShots(),
      }));
      return true;
    } catch (err) {
      showToast('浏览器本地存储不可用，改动仅保留在本次会话', 'danger');
      return false;
    }
  }

  function persistNow(silent) {
    clearTimeout(autosaveTimer);
    state.savedSnapshot = serializeShots();
    state.version += 1;
    state.savedAt = Date.now();
    const ok = writeStorage();
    state.saving = false;
    updateSaveUi();
    if (!silent) showToast(ok ? '导演计划已保存' : '保存失败，仅保留在内存中', ok ? 'ok' : 'danger');
    return ok;
  }

  function savePlan(options = {}) {
    const silent = !!options.silent;
    if (state.saving) return;
    if (!options.force && !isDirty()) {
      if (!silent) showToast('没有新的改动需要保存', 'ok');
      updateSaveUi();
      return;
    }
    clearTimeout(autosaveTimer);
    state.saving = true;
    updateSaveUi();
    window.setTimeout(() => {
      const ok = persistNow(true);
      if (!silent) showToast(ok ? '导演计划已保存' : '保存失败，仅保留在内存中', ok ? 'ok' : 'danger');
    }, silent ? 120 : 320);
  }

  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      if (isDirty() && !state.saving) savePlan({ silent: true });
    }, 3200);
  }

  function markChanged(options = {}) {
    updateSaveUi();
    updateApplyBadge();
    scheduleAutosave();
    if (options.render) {
      renderShotList();
      renderStrip();
      renderStats();
    }
    if (state.view === '3d') schedule3d();
  }

  /* ===== 应用到分镜 ===== */
  function applyStats() {
    const selectedShots = state.shots.filter((shot) => state.apply.selected.has(shot.id));
    const rows = [];
    selectedShots.forEach((shot) => {
      const diff = diffFields(shot);
      FIELD_KEYS.forEach((key) => {
        if (state.apply.fields[key] && diff[key]) rows.push({ shot, key, ...diff[key] });
      });
    });
    const invalidShots = selectedShots.filter((shot) => !subshotValid(shot));
    const syncBlocked = selectedShots.some((shot) => !canSyncSubshots(shot));
    const syncShots = state.apply.syncSubshots && !syncBlocked
      ? selectedShots.filter((shot) => canSyncSubshots(shot) && subshotChanged(shot))
      : [];
    const appendShots = state.apply.appendPrompt
      ? selectedShots.filter((shot) => !shot.promptAppended)
      : [];
    const staleShots = selectedShots.filter((shot) => shot.hasVideo);
    return {
      selectedShots,
      rows,
      invalidShots,
      syncBlocked,
      syncShots,
      appendShots,
      staleShots,
      hasPreview: rows.length > 0 || syncShots.length > 0 || appendShots.length > 0,
    };
  }

  function renderApplyDialog() {
    const stats = applyStats();
    const selectedCount = stats.selectedShots.length;
    const confirmDisabled = !selectedCount || stats.invalidShots.length > 0 || !stats.hasPreview;

    const shotButtons = state.shots.map((shot) => {
      const selected = state.apply.selected.has(shot.id);
      const diff = diffFields(shot);
      const changed = Object.keys(diff).length > 0 || (canSyncSubshots(shot) && subshotChanged(shot));
      const invalid = !subshotValid(shot);
      const statusText = invalid ? '时长不匹配' : changed ? '有改动' : shot.hasVideo ? '已生成' : '未生成';
      const warn = invalid || shot.stale;
      return `<button class="apply-shot${selected ? ' is-selected' : ''}" type="button" data-apply-shot="${shot.id}" aria-pressed="${selected}" title="${invalid ? '子镜头总时长与镜头时长不匹配，需先调整' : ''}">
        <span class="apply-check${selected ? ' is-on' : ''}"></span>
        <b>镜 ${pad2(shot.number)}</b>
        <small class="${warn ? 'is-warn' : ''}">${statusText}</small>
      </button>`;
    }).join('');

    const previewRows = [];
    stats.rows.forEach((row) => {
      previewRows.push(`<tr>
        <td>镜 ${pad2(row.shot.number)}</td>
        <td>${row.label}</td>
        <td class="before">${esc(fmtFieldValue(row.key, row.before))}</td>
        <td class="after">${esc(fmtFieldValue(row.key, row.after))}</td>
      </tr>`);
    });
    stats.syncShots.forEach((shot) => {
      previewRows.push(`<tr>
        <td>镜 ${pad2(shot.number)}</td>
        <td>子镜头描述</td>
        <td class="before">原文 ${shot.originalSubshotCount} 段</td>
        <td class="after">同步 ${shot.subshots.length} 段</td>
      </tr>`);
    });
    stats.appendShots.forEach((shot) => {
      previewRows.push(`<tr>
        <td>镜 ${pad2(shot.number)}</td>
        <td>视频提示词</td>
        <td class="before">保持不变</td>
        <td class="after">追加【机位】</td>
      </tr>`);
    });

    const warnings = [];
    if (stats.invalidShots.length) {
      warnings.push(`<div class="apply-warn"><b>${stats.invalidShots.length} 个选中镜头时长不匹配。</b>取消选择这些镜头，或在检查器里把子镜头总时长调回 ±0.2s 内。</div>`);
    }
    if (stats.staleShots.length) {
      warnings.push(`<div class="apply-warn">其中 <b>${stats.staleShots.length}</b> 个镜头已生成视频；写回后会标记“需重新生成”，不会自动排队，也不会删除旧视频。</div>`);
    }
    if (!stats.hasPreview && selectedCount) {
      warnings.push('<div class="apply-warn">当前勾选的字段与镜头没有可写回的变化。换一个字段，或调整机位/时长后再试。</div>');
    }

    el.applyBody.innerHTML = `
      <div class="dlg-section">
        <div class="dlg-section-title">
          <h3>选择镜头</h3>
          <span>${selectedCount} / ${state.shots.length} 已选 · 只写回勾选字段</span>
        </div>
        <div class="apply-shots">${shotButtons}</div>
        <div class="apply-actions">
          <button class="link-btn" type="button" data-apply-all>全选可应用</button>
          <button class="link-btn" type="button" data-apply-none>清空选择</button>
        </div>
      </div>

      <div class="dlg-section">
        <div class="dlg-section-title"><h3>写回字段</h3><span>白名单之外一律不写</span></div>
        <div class="apply-fields">
          ${FIELD_KEYS.map((key) => `<label class="check-line"><input type="checkbox" data-apply-field="${key}" ${state.apply.fields[key] ? 'checked' : ''}>${FIELD_LABELS[key]}</label>`).join('')}
        </div>
      </div>

      <div class="dlg-section">
        <div class="dlg-section-title"><h3>附加选项</h3><span>默认关闭</span></div>
        <label class="option-line">
          <input type="checkbox" data-apply-option="append" ${state.apply.appendPrompt ? 'checked' : ''}>
          <span>向视频提示词追加机位描述<small>固定【机位】标记，已追加过的镜头会跳过，重复应用不重复追加。</small></span>
        </label>
        <label class="option-line${stats.syncBlocked ? ' is-disabled' : ''}">
          <input type="checkbox" data-apply-option="sync" ${state.apply.syncSubshots && !stats.syncBlocked ? 'checked' : ''} ${stats.syncBlocked ? 'disabled' : ''}>
          <span>同步子镜头描述到分镜<small>${stats.syncBlocked ? '选中镜头与原文【镜头N】数量不一致，取消对应镜头后才能同步。' : '只替换对应【镜头N】文本，不改变子镜头数量。'}</small></span>
        </label>
      </div>

      <div class="dlg-section">
        <div class="dlg-section-title"><h3>写回预览</h3><span>${previewRows.length ? `${previewRows.length} 项变更` : '没有变更'}</span></div>
        ${previewRows.length
          ? `<div class="preview-wrap"><table class="preview-table"><thead><tr><th>镜头</th><th>字段</th><th>当前</th><th>写回后</th></tr></thead><tbody>${previewRows.join('')}</tbody></table></div>`
          : '<div class="apply-empty">勾选有改动的镜头和字段后，这里会列出写回前后的值。</div>'}
      </div>
      ${warnings.join('')}
    `;

    el.applyConfirmBtn.disabled = confirmDisabled;
    el.applyConfirmBtn.textContent = confirmDisabled
      ? '没有可写回的改动'
      : `应用到 ${selectedCount} 个镜头`;
    el.applyNote.textContent = '写回前会保存导演计划；只更新分镜字段，不触发视频生成。';
  }

  function openApplyDialog() {
    const changed = state.shots.filter((shot) => shotHasWriteChange(shot) && subshotValid(shot));
    state.apply.selected = new Set(changed.map((shot) => shot.id));
    state.apply.fields = { ...state.writeFields };
    state.apply.appendPrompt = false;
    state.apply.syncSubshots = false;
    renderApplyDialog();
    if (!el.applyDialog.open) el.applyDialog.showModal();
  }

  function closeApplyDialog() {
    if (el.applyDialog.open) el.applyDialog.close();
  }

  function applyChanges() {
    const stats = applyStats();
    if (stats.invalidShots.length) {
      showToast('有镜头时长不匹配，取消选择后再应用', 'warn');
      return;
    }
    if (!stats.selectedShots.length || !stats.hasPreview) {
      showToast('没有可写回的改动', 'warn');
      return;
    }

    const applied = [];
    const stale = [];
    let appended = 0;
    let synced = 0;

    stats.selectedShots.forEach((shot) => {
      let touched = false;
      const diff = diffFields(shot);
      FIELD_KEYS.forEach((key) => {
        if (state.apply.fields[key] && diff[key]) {
          shot.base[key] = currentFieldValue(shot, key);
          touched = true;
        }
      });
      if (state.apply.appendPrompt && !shot.promptAppended) {
        shot.promptAppended = true;
        touched = true;
        appended += 1;
      }
      if (state.apply.syncSubshots && canSyncSubshots(shot) && subshotChanged(shot)) {
        shot.base.subshots = shot.subshots.map((item) => item.description);
        shot.subshotsSyncedAt = Date.now();
        touched = true;
        synced += 1;
      }
      if (touched) {
        shot.appliedAt = Date.now();
        if (shot.hasVideo) {
          shot.stale = true;
          stale.push(shot.number);
        }
        applied.push(shot.number);
      }
    });

    state.writeFields = { ...state.apply.fields };
    state.apply.appendPrompt = false;
    state.apply.syncSubshots = false;
    closeApplyDialog();
    persistNow(true);
    renderShotList();
    renderStrip();
    renderStage2D();
    renderInspector();
    updateApplyBadge();
    updateSaveUi();
    if (state.view === '3d') schedule3d();

    if (!applied.length) {
      showToast('没有写回任何字段', 'warn');
      return;
    }
    const extra = [];
    if (stale.length) extra.push(`${stale.length} 个需重新生成`);
    if (appended) extra.push(`追加机位 ${appended} 条`);
    if (synced) extra.push(`同步子镜头 ${synced} 镜`);
    showToast(`已写回 ${applied.length} 个镜头${extra.length ? ` · ${extra.join(' · ')}` : ''}`, stale.length ? 'warn' : 'ok');
  }

  /* ===== 视图切换 ===== */
  function updatePovUi() {
    const active = state.view === '3d' && state.cameraPov;
    el.povOverlay.hidden = !active;
    el.stage3d.classList.toggle('is-pov', active);
    el.povBtn.textContent = active ? '回到自由视角' : '切到机位';
    el.hint3d.textContent = active ? '机位视角 · 方向键微调朝向 · Esc 退出' : '拖拽环绕 · 滚轮缩放 · 双击复位';
    const shot = selectedShot();
    if (shot) {
      el.povLens.textContent = `${shot.camera.lens}mm · ${shot.camera.shotType}`;
      el.povShot.textContent = `镜 ${pad2(shot.number)} · ${fmtSec(shot.duration)} · ${compass(shot.camera.yaw)}`;
    }
  }

  function ensure3d() {
    if (state.loaded3d) {
      resize3d();
      schedule3d();
      return;
    }
    if (state.loading3d) return;
    state.loading3d = true;
    el.loading3d.hidden = false;
    window.setTimeout(() => {
      state.loading3d = false;
      el.loading3d.hidden = true;
      if (!ctx3d) {
        try {
          ctx3d = el.canvas3d.getContext('2d');
        } catch (err) {
          ctx3d = null;
        }
        if (!ctx3d) {
          setView('2d', { silent: true });
          showToast('当前浏览器无法创建 3D 画布，已回退到 2D 俯视', 'danger');
          return;
        }
      }
      state.loaded3d = true;
      resize3d();
      if (state.view === '3d') schedule3d();
    }, 480);
  }

  function setView(view, options = {}) {
    if (view !== '2d' && view !== '3d') return;
    const changed = state.view !== view;
    state.view = view;
    document.querySelectorAll('.seg-btn').forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    el.stage2d.hidden = view !== '2d';
    el.stage3d.hidden = view !== '3d';
    el.tools2d.hidden = view !== '2d';
    el.tools3d.hidden = view !== '3d';
    el.stageTitle.textContent = view === '2d' ? '2D 俯视排演' : '3D 机位预演';
    el.sceneChip.textContent = view === '2d' ? '场景底图 · 示意' : '代理场景 · 当前镜头';

    if (view === '3d') {
      ensure3d();
      updatePovUi();
      if (changed && !options.silent) showViewToast('已切到 3D 机位预演 · 选中镜头与修改已保留');
    } else {
      updatePovUi();
      renderStage2D();
      if (changed && !options.silent) showViewToast('已切到 2D 俯视排演 · 修改已保留');
    }
  }

  function setCameraPov(active) {
    state.cameraPov = !!active;
    if (state.cameraPov) {
      if (state.view !== '3d') setView('3d', { silent: true });
      else ensure3d();
      updatePovUi();
      schedule3d();
      const shot = selectedShot();
      showViewToast(`已切到机位视角 · 按 ${shot.camera.lens}mm 镜头计算画框`);
    } else {
      updatePovUi();
      schedule3d();
      showViewToast('已回到自由环绕视角');
    }
  }

  function resetOrbit() {
    state.orbit = { az: 0.75, el: 0.55, dist: 13 };
    schedule3d();
  }

  /* ===== 3D 代理预演 ===== */
  let ctx3d = null;
  let canvasDpr = 1;
  let frameRequested = 0;
  const NEAR = 0.08;
  const V3 = {
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
    mul: (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k }),
    dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
    cross: (a, b) => ({
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    }),
  };

  function vLen(v) {
    return Math.hypot(v.x, v.y, v.z);
  }

  function vNorm(v) {
    const len = vLen(v) || 1;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  }

  function vDist2(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  }

  function shadeColor(hex, amount) {
    const raw = hex.replace('#', '');
    const value = raw.length === 3 ? raw.split('').map((ch) => ch + ch).join('') : raw;
    const numValue = parseInt(value, 16);
    const r = clamp(((numValue >> 16) & 255) + amount, 0, 255);
    const g = clamp(((numValue >> 8) & 255) + amount, 0, 255);
    const b = clamp((numValue & 255) + amount, 0, 255);
    return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
  }

  function resize3d() {
    if (!ctx3d) return;
    const rect = el.canvas3d.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    state.canvasW = width;
    state.canvasH = height;
    canvasDpr = Math.min(window.devicePixelRatio || 1, 2);
    const bufferW = Math.round(width * canvasDpr);
    const bufferH = Math.round(height * canvasDpr);
    if (el.canvas3d.width !== bufferW || el.canvas3d.height !== bufferH) {
      el.canvas3d.width = bufferW;
      el.canvas3d.height = bufferH;
    }
  }

  function schedule3d() {
    if (state.view !== '3d' || !state.loaded3d || !ctx3d) return;
    if (frameRequested) return;
    frameRequested = requestAnimationFrame(() => {
      frameRequested = 0;
      render3d();
    });
  }

  function makeView3d() {
    const shot = selectedShot();
    const W = Math.max(1, state.canvasW);
    const H = Math.max(1, state.canvasH);
    let eye;
    let target;
    let fov;

    if (state.cameraPov) {
      const cam = shot.camera;
      eye = { x: cam.x, y: cam.height, z: cam.z };
      const dir = dirFromYaw(cam.yaw);
      const pitch = { 平视: 0, 俯视: -0.16, 仰视: 0.14, 侧拍: 0.015 }[cam.angle] || 0;
      target = { x: eye.x + dir.x, y: eye.y + Math.tan(pitch), z: eye.z + dir.z };
      fov = 2 * Math.atan(12 / Math.max(12, cam.lens));
    } else {
      const { az, el: elevation, dist } = state.orbit;
      target = { x: 5.35, y: 0.98, z: 3.55 };
      eye = {
        x: target.x + dist * Math.sin(az) * Math.cos(elevation),
        y: target.y + dist * Math.sin(elevation),
        z: target.z + dist * Math.cos(az) * Math.cos(elevation),
      };
      fov = 42 * Math.PI / 180;
    }

    const fwd = vNorm(V3.sub(target, eye));
    let right = V3.cross(fwd, { x: 0, y: 1, z: 0 });
    right = vLen(right) < 0.0001 ? { x: 1, y: 0, z: 0 } : vNorm(right);
    const up = vNorm(V3.cross(right, fwd));
    return {
      eye,
      fwd,
      right,
      up,
      focal: (H / 2) / Math.tan(fov / 2),
      W,
      H,
      shot,
      pov: state.cameraPov,
    };
  }

  function toCam(view, point) {
    const d = V3.sub(point, view.eye);
    return {
      x: V3.dot(d, view.right),
      y: V3.dot(d, view.up),
      z: V3.dot(d, view.fwd),
    };
  }

  function screenOfCam(view, camPoint) {
    return {
      x: view.W / 2 + (camPoint.x / camPoint.z) * view.focal,
      y: view.H / 2 - (camPoint.y / camPoint.z) * view.focal,
      z: camPoint.z,
      scale: view.focal / camPoint.z,
    };
  }

  function projectPoint3d(view, point) {
    const camPoint = toCam(view, point);
    if (camPoint.z < NEAR) return null;
    return screenOfCam(view, camPoint);
  }

  function nearIntersect(a, b) {
    const t = (NEAR - a.z) / (b.z - a.z);
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: NEAR,
    };
  }

  function clipPoly3d(view, points) {
    const camPoints = points.map((point) => toCam(view, point));
    const clipped = [];
    for (let i = 0; i < camPoints.length; i += 1) {
      const current = camPoints[i];
      const previous = camPoints[(i + camPoints.length - 1) % camPoints.length];
      const currentIn = current.z >= NEAR;
      const previousIn = previous.z >= NEAR;
      if (currentIn) {
        if (!previousIn) clipped.push(nearIntersect(previous, current));
        clipped.push(current);
      } else if (previousIn) {
        clipped.push(nearIntersect(previous, current));
      }
    }
    return clipped.map((point) => screenOfCam(view, point));
  }

  function drawPoly3d(view, points, fill, stroke, lineWidth = 1, dash = null) {
    const screenPoints = clipPoly3d(view, points);
    if (screenPoints.length < 3) return;
    ctx3d.save();
    ctx3d.beginPath();
    screenPoints.forEach((point, index) => {
      if (index === 0) ctx3d.moveTo(point.x, point.y);
      else ctx3d.lineTo(point.x, point.y);
    });
    ctx3d.closePath();
    if (fill) {
      ctx3d.fillStyle = fill;
      ctx3d.fill();
    }
    if (stroke) {
      ctx3d.strokeStyle = stroke;
      ctx3d.lineWidth = lineWidth;
      if (dash) ctx3d.setLineDash(dash);
      ctx3d.stroke();
    }
    ctx3d.restore();
  }

  function drawSeg3d(view, a, b, color, width = 1, dash = null) {
    let camA = toCam(view, a);
    let camB = toCam(view, b);
    if (camA.z < NEAR && camB.z < NEAR) return;
    if (camA.z < NEAR) camA = nearIntersect(camA, camB);
    else if (camB.z < NEAR) camB = nearIntersect(camB, camA);
    const A = screenOfCam(view, camA);
    const B = screenOfCam(view, camB);
    ctx3d.save();
    ctx3d.strokeStyle = color;
    ctx3d.lineWidth = width;
    if (dash) ctx3d.setLineDash(dash);
    ctx3d.beginPath();
    ctx3d.moveTo(A.x, A.y);
    ctx3d.lineTo(B.x, B.y);
    ctx3d.stroke();
    ctx3d.restore();
  }

  function roundRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function screenLabel(view, x, y, text, color = 'rgba(226,232,240,0.6)', bg = 'rgba(8,12,18,0.55)', font = '10px') {
    ctx3d.save();
    ctx3d.font = `600 ${font} -apple-system, "PingFang SC", sans-serif`;
    const width = ctx3d.measureText(text).width;
    const height = 15;
    roundRectPath(ctx3d, x - width / 2 - 5, y - height + 3, width + 10, height, 7);
    ctx3d.fillStyle = bg;
    ctx3d.fill();
    ctx3d.fillStyle = color;
    ctx3d.textAlign = 'center';
    ctx3d.textBaseline = 'middle';
    ctx3d.fillText(text, x, y - 4);
    ctx3d.restore();
  }

  function floorQuad(x0, z0, x1, z1, y) {
    return [
      { x: x0, y, z: z0 },
      { x: x1, y, z: z0 },
      { x: x1, y, z: z1 },
      { x: x0, y, z: z1 },
    ];
  }

  function drawBox3d(view, box, colors, label) {
    const { x0, z0, x1, z1, y0, y1 } = box;
    const shadow = floorQuad(x0 - 0.04, z0 - 0.04, x1 + 0.04, z1 + 0.04, 0.004);
    drawPoly3d(view, shadow, 'rgba(0,0,0,0.24)', null);

    const faces = [];
    const addFace = (points, fill) => {
      const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      const cz = points.reduce((sum, point) => sum + point.z, 0) / points.length;
      faces.push({ points, fill, distance: vDist2(view.eye, { x: cx, y: cy, z: cz }) });
    };

    if (view.eye.y > y1) {
      addFace([
        { x: x0, y: y1, z: z0 },
        { x: x1, y: y1, z: z0 },
        { x: x1, y: y1, z: z1 },
        { x: x0, y: y1, z: z1 },
      ], colors.top);
    }
    if (view.eye.z < z0) {
      addFace([
        { x: x0, y: y0, z: z0 },
        { x: x1, y: y0, z: z0 },
        { x: x1, y: y1, z: z0 },
        { x: x0, y: y1, z: z0 },
      ], shadeColor(colors.side, -14));
    }
    if (view.eye.z > z1) {
      addFace([
        { x: x1, y: y0, z: z1 },
        { x: x0, y: y0, z: z1 },
        { x: x0, y: y1, z: z1 },
        { x: x1, y: y1, z: z1 },
      ], colors.side);
    }
    if (view.eye.x < x0) {
      addFace([
        { x: x0, y: y0, z: z1 },
        { x: x0, y: y0, z: z0 },
        { x: x0, y: y1, z: z0 },
        { x: x0, y: y1, z: z1 },
      ], shadeColor(colors.side, -8));
    }
    if (view.eye.x > x1) {
      addFace([
        { x: x1, y: y0, z: z0 },
        { x: x1, y: y0, z: z1 },
        { x: x1, y: y1, z: z1 },
        { x: x1, y: y1, z: z0 },
      ], shadeColor(colors.side, -20));
    }

    faces.sort((a, b) => b.distance - a.distance);
    faces.forEach((face) => drawPoly3d(view, face.points, face.fill, colors.edge || 'rgba(255,255,255,0.06)', 1));

    if (label) {
      const anchor = projectPoint3d(view, { x: (x0 + x1) / 2, y: y1 + 0.06, z: (z0 + z1) / 2 });
      if (anchor) screenLabel(view, anchor.x, anchor.y - 5, label, 'rgba(226,232,240,0.38)', 'rgba(8,12,18,0.32)', '9.5px');
    }
  }

  function drawWalls3d(view) {
    const pov = view.pov;
    const northWest = [
      { x: ROOM.x0, y: 0, z: ROOM.z0 },
      { x: ROOM.x1, y: 0, z: ROOM.z0 },
      { x: ROOM.x1, y: 2.7, z: ROOM.z0 },
      { x: ROOM.x0, y: 2.7, z: ROOM.z0 },
    ];
    const westWall = [
      { x: ROOM.x0, y: 0, z: ROOM.z0 },
      { x: ROOM.x0, y: 0, z: ROOM.z1 },
      { x: ROOM.x0, y: 2.7, z: ROOM.z1 },
      { x: ROOM.x0, y: 2.7, z: ROOM.z0 },
    ];
    drawPoly3d(view, northWest, pov ? 'rgba(33,44,60,0.98)' : 'rgba(22,32,46,0.46)', 'rgba(148,163,184,0.24)', 1);
    drawPoly3d(view, westWall, pov ? 'rgba(25,35,48,0.98)' : 'rgba(18,27,39,0.41)', 'rgba(148,163,184,0.2)', 1);

    if (pov) {
      drawPoly3d(view, [
        { x: ROOM.x0, y: 2.7, z: ROOM.z0 },
        { x: ROOM.x1, y: 2.7, z: ROOM.z0 },
        { x: ROOM.x1, y: 2.7, z: ROOM.z1 },
        { x: ROOM.x0, y: 2.7, z: ROOM.z1 },
      ], 'rgba(10,15,22,0.97)', 'rgba(148,163,184,0.14)', 1);
    }

    drawPoly3d(view, [
      { x: ROOM.x0, y: 0, z: ROOM.z0 },
      { x: ROOM.x1, y: 0, z: ROOM.z0 },
      { x: ROOM.x1, y: 0.92, z: ROOM.z0 },
      { x: ROOM.x0, y: 0.92, z: ROOM.z0 },
    ], pov ? 'rgba(24,34,47,0.96)' : 'rgba(16,24,35,0.38)', 'rgba(148,163,184,0.14)', 1);
    drawSeg3d(view, { x: ROOM.x0, y: 0.92, z: ROOM.z0 }, { x: ROOM.x1, y: 0.92, z: ROOM.z0 }, 'rgba(148,163,184,0.3)', 1.2);
    drawSeg3d(view, { x: ROOM.x0, y: 0.12, z: ROOM.z0 }, { x: ROOM.x1, y: 0.12, z: ROOM.z0 }, 'rgba(148,163,184,0.14)', 1);
    for (let gx = ROOM.x0 + 1.15; gx < ROOM.x1 - 0.2; gx += 1.15) {
      drawSeg3d(view, { x: gx, y: 0.12, z: ROOM.z0 + 0.004 }, { x: gx, y: 0.92, z: ROOM.z0 + 0.004 }, 'rgba(148,163,184,0.08)', 1);
    }

    const win = SCENE.window;
    const windowPanel = [
      { x: win.x0, y: 0.9, z: win.z + 0.004 },
      { x: win.x1, y: 0.9, z: win.z + 0.004 },
      { x: win.x1, y: 2.1, z: win.z + 0.004 },
      { x: win.x0, y: 2.1, z: win.z + 0.004 },
    ];
    drawPoly3d(view, windowPanel, 'rgba(125,211,252,0.2)', 'rgba(125,211,252,0.58)', 1.2);
    const winMidX = (win.x0 + win.x1) / 2;
    drawSeg3d(view, { x: winMidX, y: 0.9, z: win.z + 0.006 }, { x: winMidX, y: 2.1, z: win.z + 0.006 }, 'rgba(125,211,252,0.4)', 1);
    drawSeg3d(view, { x: win.x0, y: 1.5, z: win.z + 0.006 }, { x: win.x1, y: 1.5, z: win.z + 0.006 }, 'rgba(125,211,252,0.34)', 1);
    const winCenter = projectPoint3d(view, { x: winMidX, y: 1.55, z: win.z + 0.02 });
    if (winCenter) {
      ctx3d.save();
      ctx3d.globalCompositeOperation = 'lighter';
      const radius = clamp(winCenter.scale * 1.8, 18, 120);
      const glow = ctx3d.createRadialGradient(winCenter.x, winCenter.y, 0, winCenter.x, winCenter.y, radius);
      glow.addColorStop(0, 'rgba(125,211,252,0.14)');
      glow.addColorStop(1, 'rgba(125,211,252,0)');
      ctx3d.fillStyle = glow;
      ctx3d.beginPath();
      ctx3d.arc(winCenter.x, winCenter.y, radius, 0, Math.PI * 2);
      ctx3d.fill();
      ctx3d.restore();
    }

    const door = SCENE.door;
    const hinge = { x: door.x1, z: door.z1 };
    const leafEnd = { x: door.x1, z: door.z1 - (door.x1 - door.x0) };
    const doorLeaf = [
      { x: hinge.x, y: 0, z: hinge.z },
      { x: leafEnd.x, y: 0, z: leafEnd.z },
      { x: leafEnd.x, y: 2.05, z: leafEnd.z },
      { x: hinge.x, y: 2.05, z: hinge.z },
    ];
    drawPoly3d(view, doorLeaf, 'rgba(94,69,48,0.62)', 'rgba(255,176,118,0.22)', 1);
    drawSeg3d(view, { x: door.x0, y: 0, z: door.z1 }, { x: door.x0, y: 2.2, z: door.z1 }, 'rgba(148,163,184,0.28)', 1.2);
    drawSeg3d(view, { x: door.x1, y: 0, z: door.z1 }, { x: door.x1, y: 2.2, z: door.z1 }, 'rgba(148,163,184,0.28)', 1.2);
    drawSeg3d(view, { x: door.x0, y: 2.2, z: door.z1 }, { x: door.x1, y: 2.2, z: door.z1 }, 'rgba(148,163,184,0.24)', 1);
    for (let i = 0; i <= 8; i += 1) {
      const angle = (i / 8) * Math.PI / 2;
      const p = {
        x: hinge.x - Math.cos(angle) * (door.x1 - door.x0),
        y: 0.016,
        z: hinge.z - Math.sin(angle) * (door.x1 - door.x0),
      };
      const nextAngle = ((i + 1) / 8) * Math.PI / 2;
      if (i < 8) {
        const q = {
          x: hinge.x - Math.cos(nextAngle) * (door.x1 - door.x0),
          y: 0.016,
          z: hinge.z - Math.sin(nextAngle) * (door.x1 - door.x0),
        };
        drawSeg3d(view, p, q, 'rgba(255,176,118,0.24)', 1, [3, 4]);
      }
    }

    const lineColor = 'rgba(148,163,184,0.16)';
    drawSeg3d(view, { x: ROOM.x0, y: 2.7, z: ROOM.z0 }, { x: ROOM.x1, y: 2.7, z: ROOM.z0 }, lineColor, 1.2);
    drawSeg3d(view, { x: ROOM.x0, y: 2.7, z: ROOM.z0 }, { x: ROOM.x0, y: 2.7, z: ROOM.z1 }, lineColor, 1.2);
    drawSeg3d(view, { x: ROOM.x1, y: 0, z: ROOM.z0 }, { x: ROOM.x1, y: 0, z: ROOM.z1 }, 'rgba(148,163,184,0.24)', 1.2);
    drawSeg3d(view, { x: ROOM.x1, y: 2.7, z: ROOM.z0 }, { x: ROOM.x1, y: 2.7, z: ROOM.z1 }, 'rgba(148,163,184,0.1)', 1);
    drawSeg3d(view, { x: ROOM.x0, y: 0, z: ROOM.z1 }, { x: ROOM.x1, y: 0, z: ROOM.z1 }, 'rgba(148,163,184,0.24)', 1.2);
    drawSeg3d(view, { x: ROOM.x0, y: 0, z: ROOM.z0 }, { x: ROOM.x0, y: 0, z: ROOM.z1 }, 'rgba(148,163,184,0.16)', 1);
  }

  function drawCharacter3d(view, actor) {
    const meta = actorMeta(actor.id);
    const base = projectPoint3d(view, { x: actor.x, y: 0, z: actor.z });
    const top = projectPoint3d(view, { x: actor.x, y: 1.72, z: actor.z });
    if (!base || !top) return;
    const height = base.y - top.y;
    if (height < 6) return;

    const shadowPoints = [];
    for (let i = 0; i < 16; i += 1) {
      const angle = (i / 16) * Math.PI * 2;
      shadowPoints.push({
        x: actor.x + Math.cos(angle) * 0.32,
        y: 0.012,
        z: actor.z + Math.sin(angle) * 0.24,
      });
    }
    drawPoly3d(view, shadowPoints, 'rgba(0,0,0,0.3)', null);

    const selected = state.selectedEntity === `actor:${actor.id}`;
    if (height < 22) {
      const width = clamp(height * 0.36, 5, 18);
      const headRadius = clamp(width * 0.24, 2, 5);
      ctx3d.save();
      ctx3d.fillStyle = meta.color;
      ctx3d.strokeStyle = selected ? 'rgba(255,176,118,0.95)' : 'rgba(255,255,255,0.3)';
      ctx3d.lineWidth = 1;
      roundRectPath(ctx3d, base.x - width / 2, top.y + headRadius * 1.7, width, Math.max(3, height - headRadius * 1.7), width / 2);
      ctx3d.fill();
      ctx3d.stroke();
      ctx3d.beginPath();
      ctx3d.arc(base.x, top.y + headRadius, headRadius, 0, Math.PI * 2);
      ctx3d.fill();
      ctx3d.stroke();
      ctx3d.restore();
      screenLabel(view, base.x, Math.min(view.H - 8, base.y + 12), meta.name, selected ? '#ffb076' : 'rgba(226,232,240,0.72)', 'rgba(8,12,18,0.62)', '9px');
      return;
    }

    const px = height / 1.72;
    const yOf = (meter) => base.y - meter * px;
    const shoulderW = Math.max(7, 0.46 * px);
    const hipW = Math.max(5, 0.31 * px);
    const legW = Math.max(2.5, 0.125 * px);
    const armW = Math.max(2, 0.095 * px);
    const headW = Math.max(4, 0.19 * px);
    const headH = Math.max(5, 0.23 * px);
    const legGap = Math.max(1.5, 0.035 * px);
    const shoulderY = yOf(1.4);
    const chestY = yOf(1.2);
    const hipY = yOf(0.92);
    const waistY = yOf(1.02);
    const footY = yOf(0.04);
    const handY = yOf(0.98);
    const neckY = yOf(1.48);
    const headCenterY = yOf(1.6);

    const gradient = ctx3d.createLinearGradient(0, top.y, 0, base.y);
    gradient.addColorStop(0, shadeColor(meta.deep, 18));
    gradient.addColorStop(1, shadeColor(meta.deep, -24));

    ctx3d.save();
    if (selected) {
      ctx3d.shadowColor = 'rgba(255,176,118,0.7)';
      ctx3d.shadowBlur = 18;
    }
    ctx3d.fillStyle = gradient;
    ctx3d.strokeStyle = selected ? 'rgba(255,176,118,0.9)' : 'rgba(255,255,255,0.22)';
    ctx3d.lineWidth = selected ? 1.8 : 1;
    ctx3d.lineJoin = 'round';

    [-1, 1].forEach((side) => {
      const cx = base.x + side * (legW + legGap) / 2;
      roundRectPath(ctx3d, cx - legW / 2, hipY, legW, Math.max(2, footY - hipY), legW / 2);
      ctx3d.fill();
      ctx3d.stroke();
    });

    [-1, 1].forEach((side) => {
      const cx = base.x + side * (shoulderW / 2 - armW * 0.34);
      roundRectPath(ctx3d, cx - armW / 2, shoulderY - armW * 0.3, armW, Math.max(3, handY - shoulderY), armW / 2);
      ctx3d.fill();
      ctx3d.stroke();
    });

    ctx3d.fillStyle = shadeColor(meta.color, 12);
    roundRectPath(ctx3d, base.x - 0.05 * px, neckY, Math.max(2, 0.1 * px), Math.max(2, shoulderY - neckY + 0.06 * px), Math.max(1, 0.05 * px));
    ctx3d.fill();

    ctx3d.fillStyle = gradient;
    ctx3d.beginPath();
    ctx3d.moveTo(base.x - shoulderW / 2, shoulderY);
    ctx3d.lineTo(base.x - shoulderW * 0.44, chestY);
    ctx3d.lineTo(base.x - hipW * 0.5, waistY);
    ctx3d.lineTo(base.x - hipW * 0.46, hipY);
    ctx3d.lineTo(base.x + hipW * 0.46, hipY);
    ctx3d.lineTo(base.x + hipW * 0.5, waistY);
    ctx3d.lineTo(base.x + shoulderW * 0.44, chestY);
    ctx3d.lineTo(base.x + shoulderW / 2, shoulderY);
    ctx3d.closePath();
    ctx3d.fill();
    ctx3d.stroke();

    ctx3d.fillStyle = shadeColor(meta.color, 16);
    ctx3d.beginPath();
    ctx3d.ellipse(base.x, headCenterY, headW / 2, headH / 2, 0, 0, Math.PI * 2);
    ctx3d.fill();
    ctx3d.stroke();

    ctx3d.fillStyle = shadeColor(meta.deep, -18);
    ctx3d.beginPath();
    ctx3d.ellipse(base.x, headCenterY - headH * 0.08, headW * 0.52, headH * 0.4, 0, Math.PI, Math.PI * 2);
    ctx3d.fill();
    ctx3d.restore();

    if (headW >= 9 && headW <= 26) {
      ctx3d.save();
      ctx3d.fillStyle = 'rgba(21,27,36,0.92)';
      ctx3d.font = `700 ${clamp(headW * 0.52, 7, 14)}px -apple-system, "PingFang SC", sans-serif`;
      ctx3d.textAlign = 'center';
      ctx3d.textBaseline = 'middle';
      ctx3d.fillText(meta.initial, base.x, headCenterY + 0.5);
      ctx3d.restore();
    }

    const front = { x: Math.sin(actor.rotation * Math.PI / 180), z: -Math.cos(actor.rotation * Math.PI / 180) };
    const screenDir = V3.dot(front, view.right);
    if (Math.abs(screenDir) > 0.18 && height > 40) {
      const dir = Math.sign(screenDir);
      const cueX = base.x + dir * hipW * 0.2;
      const size = clamp(px * 0.035, 3, 8);
      ctx3d.save();
      ctx3d.fillStyle = 'rgba(10,14,20,0.55)';
      ctx3d.beginPath();
      ctx3d.moveTo(cueX + dir * size * 1.3, chestY + (hipY - chestY) * 0.22);
      ctx3d.lineTo(cueX - dir * size * 0.7, chestY + (hipY - chestY) * 0.1);
      ctx3d.lineTo(cueX - dir * size * 0.7, chestY + (hipY - chestY) * 0.34);
      ctx3d.closePath();
      ctx3d.fill();
      ctx3d.restore();
    }

    const nameY = base.y > view.H - 14 ? Math.max(12, top.y - 12) : Math.min(view.H - 8, base.y + 14);
    screenLabel(view, base.x, nameY, meta.name, selected ? '#ffb076' : 'rgba(226,232,240,0.78)', 'rgba(8,12,18,0.68)', '10px');
  }

  function drawDesk3d(view) {
    const desk = SCENE.desk;
    drawBox3d(view, {
      x0: desk.x - desk.w / 2,
      z0: desk.z - desk.d / 2,
      x1: desk.x + desk.w / 2,
      z1: desk.z + desk.d / 2,
      y0: 0,
      y1: desk.h,
    }, { top: '#4a3a2c', side: '#2b2118', edge: 'rgba(255,176,118,0.14)' }, '书桌');

    const envelope = floorQuad(4.08, 1.28, 4.55, 1.56, desk.h + 0.012);
    drawPoly3d(view, envelope, 'rgba(217,200,165,0.9)', 'rgba(90,72,50,0.5)', 1);
    const wax = projectPoint3d(view, { x: 4.31, y: desk.h + 0.014, z: 1.42 });
    if (wax) {
      ctx3d.save();
      ctx3d.fillStyle = '#a63a32';
      ctx3d.beginPath();
      ctx3d.arc(wax.x, wax.y, clamp(wax.scale * 0.035, 2, 5), 0, Math.PI * 2);
      ctx3d.fill();
      ctx3d.restore();
    }

    const lampX = SCENE.lamp.x;
    const lampZ = SCENE.lamp.z;
    drawSeg3d(view, { x: lampX, y: desk.h, z: lampZ }, { x: lampX, y: 1.28, z: lampZ }, 'rgba(255,198,146,0.75)', 2);
    drawPoly3d(view, [
      { x: lampX - 0.15, y: 1.28, z: lampZ - 0.15 },
      { x: lampX + 0.15, y: 1.28, z: lampZ - 0.15 },
      { x: lampX + 0.15, y: 1.28, z: lampZ + 0.15 },
      { x: lampX - 0.15, y: 1.28, z: lampZ + 0.15 },
    ], 'rgba(232,176,122,0.55)', 'rgba(255,214,170,0.6)', 1);
    const lampTop = projectPoint3d(view, { x: lampX, y: 1.34, z: lampZ });
    if (lampTop) {
      ctx3d.save();
      ctx3d.globalCompositeOperation = 'lighter';
      const radius = clamp(lampTop.scale * 0.62, 10, 90);
      const glow = ctx3d.createRadialGradient(lampTop.x, lampTop.y, 0, lampTop.x, lampTop.y, radius);
      glow.addColorStop(0, 'rgba(255,214,170,0.65)');
      glow.addColorStop(0.28, 'rgba(255,176,118,0.24)');
      glow.addColorStop(1, 'rgba(255,176,118,0)');
      ctx3d.fillStyle = glow;
      ctx3d.beginPath();
      ctx3d.arc(lampTop.x, lampTop.y, radius, 0, Math.PI * 2);
      ctx3d.fill();
      ctx3d.restore();
    }

    const chair = SCENE.chair;
    drawBox3d(view, {
      x0: chair.x - chair.w / 2,
      z0: chair.z - chair.d / 2,
      x1: chair.x + chair.w / 2,
      z1: chair.z + chair.d / 2,
      y0: 0,
      y1: 0.45,
    }, { top: '#343b45', side: '#222831', edge: 'rgba(255,255,255,0.06)' });
    drawBox3d(view, {
      x0: chair.x - chair.w / 2,
      z0: chair.z + chair.d / 2 - 0.08,
      x1: chair.x + chair.w / 2,
      z1: chair.z + chair.d / 2,
      y0: 0.45,
      y1: 0.95,
    }, { top: '#3a424e', side: '#262d36', edge: 'rgba(255,255,255,0.06)' });
  }

  function drawShelf3d(view) {
    const shelf = SCENE.shelf;
    const x0 = shelf.x - shelf.w / 2;
    const z0 = shelf.z - shelf.d / 2;
    const x1 = shelf.x + shelf.w / 2;
    const z1 = shelf.z + shelf.d / 2;
    drawBox3d(view, { x0, z0, x1, z1, y0: 0, y1: shelf.h }, { top: '#33291f', side: '#231b15', edge: 'rgba(255,176,118,0.1)' }, '书架');

    if (view.eye.z > z1) {
      for (let i = 0; i < 6; i += 1) {
        const bx0 = x0 + 0.05 + i * 0.068;
        const height = 0.26 + (i % 3) * 0.09;
        drawPoly3d(view, [
          { x: bx0, y: 0.45, z: z1 + 0.006 },
          { x: bx0 + 0.045, y: 0.45, z: z1 + 0.006 },
          { x: bx0 + 0.045, y: 0.45 + height, z: z1 + 0.006 },
          { x: bx0, y: 0.45 + height, z: z1 + 0.006 },
        ], i % 2 ? 'rgba(125,211,252,0.45)' : 'rgba(255,176,118,0.45)', null);
      }
      [0.55, 0.95, 1.35, 1.75].forEach((y) => {
        drawSeg3d(view, { x: x0 + 0.03, y, z: z1 + 0.007 }, { x: x1 - 0.03, y, z: z1 + 0.007 }, 'rgba(255,255,255,0.08)', 1);
      });
    }
  }

  function drawSofa3d(view) {
    const sofa = SCENE.sofa;
    const x0 = sofa.x - sofa.w / 2;
    const z0 = sofa.z - sofa.d / 2;
    const x1 = sofa.x + sofa.w / 2;
    const z1 = sofa.z + sofa.d / 2;
    drawBox3d(view, { x0, z0, x1, z1, y0: 0, y1: 0.42 }, { top: '#2c3a4a', side: '#1d2833', edge: 'rgba(125,211,252,0.08)' }, '沙发');
    drawBox3d(view, { x0, z0, x1: x0 + 0.22, z1, y0: 0.42, y1: 0.9 }, { top: '#31455a', side: '#1f2c39', edge: 'rgba(255,255,255,0.06)' });
    const midZ = (z0 + z1) / 2;
    drawBox3d(view, { x0: x0 + 0.22, z0: z0 + 0.05, x1: x1 - 0.05, z1: midZ - 0.03, y0: 0.42, y1: 0.56 }, { top: '#344a60', side: '#25364a', edge: 'rgba(255,255,255,0.06)' });
    drawBox3d(view, { x0: x0 + 0.22, z0: midZ + 0.03, x1: x1 - 0.05, z1: z1 - 0.05, y0: 0.42, y1: 0.56 }, { top: '#33485e', side: '#243548', edge: 'rgba(255,255,255,0.06)' });
  }

  function drawPath3d(view) {
    const shot = selectedShot();
    state.shots.forEach((item, index) => {
      if (index === state.selectedShot) return;
      const point = projectPoint3d(view, { x: item.camera.x, y: 0.03, z: item.camera.z });
      if (!point) return;
      ctx3d.save();
      ctx3d.strokeStyle = 'rgba(125,211,252,0.3)';
      ctx3d.lineWidth = 1;
      ctx3d.setLineDash([2, 3]);
      ctx3d.beginPath();
      ctx3d.arc(point.x, point.y, 7, 0, Math.PI * 2);
      ctx3d.stroke();
      ctx3d.setLineDash([]);
      ctx3d.fillStyle = 'rgba(125,211,252,0.58)';
      ctx3d.font = '8.5px ui-monospace, monospace';
      ctx3d.textAlign = 'center';
      ctx3d.textBaseline = 'middle';
      ctx3d.fillText(String(item.number), point.x, point.y + 0.5);
      ctx3d.restore();
    });

    for (let i = 0; i < shot.path.length; i += 1) {
      const point = shot.path[i];
      const next = shot.path[i + 1];
      if (next) {
        const active = i === state.activeSubshot;
        drawSeg3d(view, { x: point.x, y: 0.024, z: point.z }, { x: next.x, y: 0.024, z: next.z }, active ? 'rgba(255,176,118,0.92)' : 'rgba(125,211,252,0.34)', active ? 2.4 : 1.2, active ? null : [5, 5]);
      }
      const screenPoint = projectPoint3d(view, { x: point.x, y: 0.03, z: point.z });
      if (!screenPoint) continue;
      const active = i === state.activeSubshot;
      ctx3d.save();
      ctx3d.beginPath();
      ctx3d.arc(screenPoint.x, screenPoint.y, 7.5, 0, Math.PI * 2);
      ctx3d.fillStyle = active ? '#ffb076' : 'rgba(11,24,34,0.92)';
      ctx3d.fill();
      ctx3d.strokeStyle = active ? '#ffcf9e' : 'rgba(125,211,252,0.7)';
      ctx3d.lineWidth = 1;
      ctx3d.stroke();
      ctx3d.fillStyle = active ? '#2a1503' : 'rgba(186,230,253,0.85)';
      ctx3d.font = '600 8.5px ui-monospace, monospace';
      ctx3d.textAlign = 'center';
      ctx3d.textBaseline = 'middle';
      ctx3d.fillText(String(i + 1), screenPoint.x, screenPoint.y + 0.5);
      ctx3d.restore();
    }
  }

  function drawCameraRig3d(view) {
    const shot = selectedShot();
    const cam = shot.camera;
    const base = { x: cam.x, y: 0, z: cam.z };
    const head = { x: cam.x, y: cam.height, z: cam.z };
    const dir = dirFromYaw(cam.yaw);
    const right = { x: -dir.z, y: 0, z: dir.x };

    [-0.22, 0.02, 0.22].forEach((offset, index) => {
      const foot = {
        x: cam.x + right.x * offset + dir.x * (index === 1 ? -0.18 : 0.16),
        y: 0.02,
        z: cam.z + right.z * offset + dir.z * (index === 1 ? -0.18 : 0.16),
      };
      drawSeg3d(view, foot, head, 'rgba(255,176,118,0.36)', 1.2);
    });
    drawSeg3d(view, base, head, 'rgba(255,176,118,0.24)', 1);

    const hFov = 2 * Math.atan(18 / Math.max(12, cam.lens));
    const vFov = 2 * Math.atan(12 / Math.max(12, cam.lens));
    const distance = 4.8;
    const tanH = Math.tan(hFov / 2) * distance;
    const tanV = Math.tan(vFov / 2) * distance;
    const center = {
      x: head.x + dir.x * distance,
      y: head.y,
      z: head.z + dir.z * distance,
    };
    const corner = (hx, vy) => ({
      x: center.x + right.x * hx,
      y: center.y + vy,
      z: center.z + right.z * hx,
    });
    const corners = [corner(-tanH, tanV), corner(tanH, tanV), corner(tanH, -tanV), corner(-tanH, -tanV)];
    drawPoly3d(view, corners, 'rgba(255,176,118,0.045)', 'rgba(255,176,118,0.42)', 1, [5, 5]);
    corners.forEach((item) => drawSeg3d(view, head, item, 'rgba(255,176,118,0.2)', 1, [4, 5]));
    drawSeg3d(view, head, center, 'rgba(255,176,118,0.35)', 1, [3, 5]);

    const camPoint = projectPoint3d(view, head);
    if (!camPoint) return;
    const boxW = clamp(camPoint.scale * 0.32, 16, 38);
    const boxH = boxW * 0.62;
    ctx3d.save();
    roundRectPath(ctx3d, camPoint.x - boxW / 2, camPoint.y - boxH / 2, boxW, boxH, 4);
    ctx3d.fillStyle = 'rgba(21,29,40,0.96)';
    ctx3d.fill();
    ctx3d.strokeStyle = 'rgba(255,176,118,0.86)';
    ctx3d.lineWidth = 1.3;
    ctx3d.stroke();
    ctx3d.fillStyle = 'rgba(255,176,118,0.9)';
    ctx3d.beginPath();
    ctx3d.arc(camPoint.x, camPoint.y - boxH * 0.12, Math.max(2, boxW * 0.09), 0, Math.PI * 2);
    ctx3d.fill();
    ctx3d.restore();
    const tagPoint = projectPoint3d(view, { x: head.x, y: head.y + 0.34, z: head.z });
    if (tagPoint) screenLabel(view, tagPoint.x, tagPoint.y, `CAM ${pad2(shot.number)}`, '#ffb076', 'rgba(42,24,10,0.9)', '9.5px');
  }

  function render3d() {
    if (!ctx3d || !state.loaded3d) return;
    resize3d();
    const view = makeView3d();
    const { W, H, shot } = view;
    ctx3d.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
    ctx3d.clearRect(0, 0, W, H);

    const bg = ctx3d.createRadialGradient(W * 0.52, H * 0.22, 0, W * 0.52, H * 0.22, Math.max(W, H) * 0.9);
    bg.addColorStop(0, '#172333');
    bg.addColorStop(0.52, '#0b111a');
    bg.addColorStop(1, '#05070b');
    ctx3d.fillStyle = bg;
    ctx3d.fillRect(0, 0, W, H);

    drawPoly3d(view, floorQuad(-2.5, -2.5, 13, 10, -0.03), 'rgba(8,12,18,0.72)', null);
    drawPoly3d(view, floorQuad(ROOM.x0, ROOM.z0, ROOM.x1, ROOM.z1, 0), 'rgba(18,28,40,0.92)', 'rgba(148,163,184,0.26)', 1.2);

    for (let m = Math.ceil(ROOM.x0); m <= Math.floor(ROOM.x1); m += 1) {
      const major = m % 5 === 0;
      drawSeg3d(view, { x: m, y: 0.003, z: ROOM.z0 }, { x: m, y: 0.003, z: ROOM.z1 }, major ? 'rgba(148,163,184,0.14)' : 'rgba(148,163,184,0.06)', 1);
    }
    for (let m = Math.ceil(ROOM.z0); m <= Math.floor(ROOM.z1); m += 1) {
      const major = m % 5 === 0;
      drawSeg3d(view, { x: ROOM.x0, y: 0.003, z: m }, { x: ROOM.x1, y: 0.003, z: m }, major ? 'rgba(148,163,184,0.14)' : 'rgba(148,163,184,0.06)', 1);
    }

    const rug = SCENE.rug;
    drawPoly3d(view, floorQuad(rug.x - rug.w / 2, rug.z - rug.d / 2, rug.x + rug.w / 2, rug.z + rug.d / 2, 0.007), 'rgba(39,31,27,0.9)', 'rgba(255,176,118,0.16)', 1);
    drawPoly3d(view, floorQuad(rug.x - rug.w / 2 + 0.14, rug.z - rug.d / 2 + 0.14, rug.x + rug.w / 2 - 0.14, rug.z + rug.d / 2 - 0.14, 0.009), null, 'rgba(255,176,118,0.1)', 1, [4, 5]);
    drawPoly3d(view, floorQuad(SCENE.window.x0, SCENE.window.z + 0.1, SCENE.window.x1, 2.8, 0.008), 'rgba(125,211,252,0.028)', null);

    drawWalls3d(view);
    if (!view.pov) drawPath3d(view);

    const items = [];
    items.push({ d: vDist2(view.eye, { x: SCENE.desk.x, y: 0.5, z: SCENE.desk.z }), draw: () => drawDesk3d(view) });
    items.push({ d: vDist2(view.eye, { x: SCENE.shelf.x, y: 1.0, z: SCENE.shelf.z }), draw: () => drawShelf3d(view) });
    items.push({ d: vDist2(view.eye, { x: SCENE.sofa.x, y: 0.5, z: SCENE.sofa.z }), draw: () => drawSofa3d(view) });
    shot.blocking.forEach((actor) => {
      items.push({ d: vDist2(view.eye, { x: actor.x, y: 0.9, z: actor.z }), draw: () => drawCharacter3d(view, actor) });
    });
    items.sort((a, b) => b.d - a.d);
    items.forEach((item) => item.draw());

    if (!view.pov) drawCameraRig3d(view);

    const vignette = ctx3d.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.36, W / 2, H / 2, Math.max(W, H) * 0.78);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.4)');
    ctx3d.fillStyle = vignette;
    ctx3d.fillRect(0, 0, W, H);
  }

  /* ===== 2D 拖拽 / 平移 / 缩放 ===== */
  function stagePoint(event) {
    const rect = el.stageViewport.getBoundingClientRect();
    const cx = rect.left + rect.width / 2 + state.pan.x;
    const cy = rect.top + rect.height / 2 + state.pan.y;
    return {
      x: (event.clientX - cx) / state.zoom + WORLD_W / 2,
      y: (event.clientY - cy) / state.zoom + WORLD_H / 2,
    };
  }

  function clampRoom(value, axis) {
    const min = axis === 'x' ? ROOM.x0 + 0.2 : ROOM.z0 + 0.2;
    const max = axis === 'x' ? ROOM.x1 - 0.2 : ROOM.z1 - 0.2;
    return round2(clamp(value, min, max));
  }

  function selectCameraEntity() {
    state.selectedEntity = 'camera';
    updateSelectionClasses();
    renderInspector();
  }

  function onStagePointerDown(event) {
    if (event.button !== 0) return;
    if (event.target.closest('.pip')) return;
    const handle = event.target.closest('[data-drag]');
    const shot = selectedShot();
    if (!shot) return;

    if (handle) {
      const type = handle.dataset.drag;
      event.preventDefault();
      if (type === 'actor') {
        const index = Number(handle.dataset.index);
        const actor = shot.blocking[index];
        if (!actor) return;
        selectActor(actor.id, false);
        state.drag = {
          type, pointerId: event.pointerId, index, node: handle,
          startX: event.clientX, startY: event.clientY,
          startPoint: { x: actor.x, z: actor.z }, moved: false, marked: false,
        };
      } else if (type === 'camera') {
        selectCameraEntity();
        state.drag = {
          type, pointerId: event.pointerId, node: handle,
          startX: event.clientX, startY: event.clientY,
          startPoint: { x: shot.camera.x, z: shot.camera.z }, moved: false, marked: false,
        };
        handle.focus({ preventScroll: true });
      } else if (type === 'waypoint') {
        const index = Number(handle.dataset.index);
        const point = shot.path[index];
        if (!point) return;
        setActiveSubshot(index);
        state.drag = {
          type, pointerId: event.pointerId, index, node: handle,
          startX: event.clientX, startY: event.clientY,
          startPoint: { x: point.x, z: point.z }, moved: false, marked: false,
        };
      }
      el.world.classList.add('is-dragging');
      el.stage2d.classList.add('is-dragging');
      try { el.stage2d.setPointerCapture(event.pointerId); } catch (err) { /* noop */ }
      return;
    }

    state.panDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: state.pan.x,
      panY: state.pan.y,
      moved: false,
    };
    el.stage2d.classList.add('is-panning');
    try { el.stage2d.setPointerCapture(event.pointerId); } catch (err) { /* noop */ }
  }

  function onWindowPointerMove(event) {
    if (state.drag) {
      const drag = state.drag;
      if (drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 2.5) return;
      drag.moved = true;

      const shot = selectedShot();
      if (!shot) return;
      const point = stagePoint(event);
      const px = clampRoom(point.x / PX, 'x');
      const pz = clampRoom(point.y / PX, 'z');

      if (drag.type === 'actor') {
        const actor = shot.blocking[drag.index];
        if (!actor) return;
        actor.x = px;
        actor.z = pz;
        if (drag.node) {
          drag.node.style.left = `${actor.x * PX}px`;
          drag.node.style.top = `${actor.z * PX}px`;
        }
        renderPip();
        updateLiveInspectorValues();
        if (state.view === '3d') schedule3d();
      } else if (drag.type === 'camera') {
        shot.camera.x = px;
        shot.camera.z = pz;
        if (shot.path[state.activeSubshot]) {
          shot.path[state.activeSubshot].x = px;
          shot.path[state.activeSubshot].z = pz;
        }
        update2dDynamic();
      } else if (drag.type === 'waypoint') {
        const pathPoint = shot.path[drag.index];
        if (!pathPoint) return;
        pathPoint.x = px;
        pathPoint.z = pz;
        if (drag.index === state.activeSubshot) {
          shot.camera.x = px;
          shot.camera.z = pz;
        }
        update2dDynamic();
      }

      if (!drag.marked) {
        drag.marked = true;
        markChanged({ render: false });
      }
      return;
    }

    if (state.panDrag) {
      const pan = state.panDrag;
      if (pan.pointerId !== event.pointerId) return;
      if (!pan.moved && Math.hypot(event.clientX - pan.startX, event.clientY - pan.startY) < 2.5) return;
      pan.moved = true;
      state.pan.x = pan.panX + (event.clientX - pan.startX);
      state.pan.y = pan.panY + (event.clientY - pan.startY);
      updateWorldTransform();
    }
  }

  function onWindowPointerUp(event) {
    if (state.drag && state.drag.pointerId === event.pointerId) {
      const drag = state.drag;
      state.drag = null;
      el.world.classList.remove('is-dragging');
      el.stage2d.classList.remove('is-dragging');
      try { el.stage2d.releasePointerCapture(event.pointerId); } catch (err) { /* noop */ }
      if (drag.moved) {
        renderShotList();
        renderStrip();
        renderStats();
        renderStage2D();
        renderInspector();
        updateApplyBadge();
        markChanged({ render: false });
      }
      return;
    }

    if (state.panDrag && state.panDrag.pointerId === event.pointerId) {
      state.panDrag = null;
      el.stage2d.classList.remove('is-panning');
      try { el.stage2d.releasePointerCapture(event.pointerId); } catch (err) { /* noop */ }
    }
  }

  function onStageWheel(event) {
    if (event.target.closest('.pip')) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0016);
    zoomAt(event.clientX, event.clientY, factor);
  }

  function onStageDoubleClick(event) {
    if (event.target.closest('[data-drag], .pip')) return;
    state.zoom = 1;
    state.pan = { x: 0, y: 0 };
    updateWorldTransform();
    showViewToast('已复位俯视图 · 100%');
  }

  function nudgeSelected(dx, dz) {
    const shot = selectedShot();
    if (!shot) return false;
    const entity = state.selectedEntity || 'camera';
    if (entity === 'camera') {
      shot.camera.x = clampRoom(shot.camera.x + dx, 'x');
      shot.camera.z = clampRoom(shot.camera.z + dz, 'z');
      const pathPoint = shot.path[state.activeSubshot];
      if (pathPoint) {
        pathPoint.x = shot.camera.x;
        pathPoint.z = shot.camera.z;
      }
    } else if (entity === 'waypoint') {
      const pathPoint = shot.path[state.activeSubshot];
      if (!pathPoint) return false;
      pathPoint.x = clampRoom(pathPoint.x + dx, 'x');
      pathPoint.z = clampRoom(pathPoint.z + dz, 'z');
      shot.camera.x = pathPoint.x;
      shot.camera.z = pathPoint.z;
    } else if (entity.startsWith('actor:')) {
      const actor = shot.blocking.find((item) => item.id === entity.slice(6));
      if (!actor) return false;
      actor.x = clampRoom(actor.x + dx, 'x');
      actor.z = clampRoom(actor.z + dz, 'z');
    } else {
      return false;
    }
    commitInspectorChange();
    return true;
  }

  /* ===== 3D 环绕 / 机位 ===== */
  function onCanvasPointerDown(event) {
    if (event.button !== 0 || state.cameraPov) return;
    event.preventDefault();
    state.drag = {
      type: 'orbit',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      az: state.orbit.az,
      el: state.orbit.el,
    };
    try { el.canvas3d.setPointerCapture(event.pointerId); } catch (err) { /* noop */ }
  }

  function onCanvasPointerMove(event) {
    if (!state.drag || state.drag.type !== 'orbit' || state.drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.drag.startX;
    const dy = event.clientY - state.drag.startY;
    state.orbit.az = state.drag.az - dx * 0.006;
    state.orbit.el = clamp(state.drag.el + dy * 0.004, 0.12, 1.42);
    schedule3d();
  }

  function onCanvasPointerUp(event) {
    if (!state.drag || state.drag.type !== 'orbit' || state.drag.pointerId !== event.pointerId) return;
    state.drag = null;
    try { el.canvas3d.releasePointerCapture(event.pointerId); } catch (err) { /* noop */ }
  }

  function onCanvasWheel(event) {
    event.preventDefault();
    if (state.cameraPov) return;
    state.orbit.dist = clamp(state.orbit.dist * Math.exp(event.deltaY * 0.0012), 4.6, 22);
    schedule3d();
  }

  function onCanvasDoubleClick() {
    if (state.cameraPov) {
      setCameraPov(false);
      return;
    }
    resetOrbit();
    showViewToast('3D 环绕已复位');
  }

  /* ===== 键盘 ===== */
  function onKeyDown(event) {
    if (event.key === 'Escape') {
      if (el.applyDialog.open) return;
      if (state.cameraPov) { setCameraPov(false); return; }
      if (!el.moreMenu.hidden) { setMoreMenu(false); return; }
      return;
    }

    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      savePlan();
      return;
    }
    if (isTypingTarget(event.target) || el.applyDialog.open) return;

    if (event.key === '1' || event.key === '2') {
      setView(event.key === '1' ? '2d' : '3d');
      return;
    }

    if (state.view === '3d') {
      if (event.key === '0') {
        if (state.cameraPov) setCameraPov(false);
        else resetOrbit();
        return;
      }
      if (state.cameraPov) {
        const delta = event.key === 'ArrowLeft' ? -2 : event.key === 'ArrowRight' ? 2 : 0;
        if (!delta) return;
        const shot = selectedShot();
        if (shot) {
          shot.camera.yaw = norm360(shot.camera.yaw + delta);
          commitInspectorChange();
          updatePovUi();
        }
        event.preventDefault();
        return;
      }
      const step = event.shiftKey ? 0.035 : 0.1;
      if (event.key === 'ArrowLeft') { state.orbit.az += step; schedule3d(); event.preventDefault(); }
      else if (event.key === 'ArrowRight') { state.orbit.az -= step; schedule3d(); event.preventDefault(); }
      else if (event.key === 'ArrowUp') { state.orbit.el = clamp(state.orbit.el + step, 0.12, 1.42); schedule3d(); event.preventDefault(); }
      else if (event.key === 'ArrowDown') { state.orbit.el = clamp(state.orbit.el - step, 0.12, 1.42); schedule3d(); event.preventDefault(); }
      return;
    }

    let dx = 0;
    let dz = 0;
    const step = event.shiftKey ? 0.02 : 0.1;
    if (event.key === 'ArrowLeft') dx = -step;
    if (event.key === 'ArrowRight') dx = step;
    if (event.key === 'ArrowUp') dz = -step;
    if (event.key === 'ArrowDown') dz = step;
    if ((dx || dz) && nudgeSelected(dx, dz)) event.preventDefault();
  }

  /* ===== 菜单 / 顶栏 ===== */
  function disarmReset() {
    state.resetArmed = false;
    clearTimeout(state.resetTimer);
    const item = el.moreMenu.querySelector('[data-action="reset-prototype"]');
    if (item) {
      item.classList.remove('is-armed');
      item.textContent = '重置原型数据';
    }
  }

  function setMoreMenu(open) {
    el.moreMenu.hidden = !open;
    el.moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) disarmReset();
  }

  function onMoreMenuClick(event) {
    const item = event.target.closest('[data-action]');
    if (!item) return;
    if (item.dataset.action !== 'reset-prototype') return;
    if (!state.resetArmed) {
      state.resetArmed = true;
      item.classList.add('is-armed');
      item.textContent = '再次点击确认重置';
      clearTimeout(state.resetTimer);
      state.resetTimer = window.setTimeout(() => disarmReset(), 3200);
      return;
    }
    disarmReset();
    setMoreMenu(false);
    resetPrototype();
  }

  function onDocumentClick(event) {
    if (el.moreMenu.hidden) return;
    if (event.target.closest('#moreMenu, #moreBtn')) return;
    setMoreMenu(false);
  }

  function zoomCenter(factor) {
    const rect = el.stageViewport.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  /* ===== 应用到分镜弹窗事件 ===== */
  function onApplyBodyClick(event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.closest('[data-apply-all]')) {
      state.apply.selected = new Set(state.shots.filter((shot) => subshotValid(shot)).map((shot) => shot.id));
      renderApplyDialog();
      return;
    }
    if (target.closest('[data-apply-none]')) {
      state.apply.selected.clear();
      renderApplyDialog();
      return;
    }
    const shotButton = target.closest('[data-apply-shot]');
    if (shotButton) {
      const id = Number(shotButton.dataset.applyShot);
      if (state.apply.selected.has(id)) state.apply.selected.delete(id);
      else state.apply.selected.add(id);
      renderApplyDialog();
    }
  }

  function onApplyBodyChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.applyField) {
      state.apply.fields[target.dataset.applyField] = target.checked;
      renderApplyDialog();
      return;
    }
    if (target.dataset.applyOption === 'append') {
      state.apply.appendPrompt = target.checked;
      renderApplyDialog();
      return;
    }
    if (target.dataset.applyOption === 'sync') {
      state.apply.syncSubshots = target.checked;
      renderApplyDialog();
    }
  }

  /* ===== 数据水合 / 重置 ===== */
  function clampNum(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(parsed, min, max);
  }

  function normalizeShot(raw, index) {
    const fallback = DEFAULT_SHOTS[index] || DEFAULT_SHOTS[DEFAULT_SHOTS.length - 1];
    const source = raw && typeof raw === 'object' ? raw : {};
    const camSource = source.camera && typeof source.camera === 'object' ? source.camera : {};
    const duration = round2(clampNum(source.duration, 8, 15, fallback.duration));
    const camera = {
      shotType: SHOT_TYPES.includes(camSource.shotType) ? camSource.shotType : fallback.camera.shotType,
      angle: ANGLES.includes(camSource.angle) ? camSource.angle : fallback.camera.angle,
      movement: MOVEMENTS.includes(camSource.movement) ? camSource.movement : fallback.camera.movement,
      lens: Math.round(clampNum(camSource.lens, 12, 135, fallback.camera.lens)),
      height: round2(clampNum(camSource.height, 0.4, 3.2, fallback.camera.height)),
      x: round2(clampNum(camSource.x, ROOM.x0 + 0.2, ROOM.x1 - 0.2, fallback.camera.x)),
      z: round2(clampNum(camSource.z, ROOM.z0 + 0.2, ROOM.z1 - 0.2, fallback.camera.z)),
      yaw: Math.round(norm360(clampNum(camSource.yaw, 0, 359, fallback.camera.yaw))),
    };

    const blocking = Array.isArray(source.blocking) && source.blocking.length
      ? source.blocking.slice(0, 8).map((item, actorIndex) => {
          const base = fallback.blocking[actorIndex] || fallback.blocking[0];
          const id = item && CHARACTERS[item.id] ? item.id : base.id;
          return {
            id,
            x: round2(clampNum(item && item.x, ROOM.x0 + 0.2, ROOM.x1 - 0.2, base.x)),
            z: round2(clampNum(item && item.z, ROOM.z0 + 0.2, ROOM.z1 - 0.2, base.z)),
            rotation: Math.round(norm360(clampNum(item && item.rotation, 0, 359, base.rotation))),
          };
        })
      : deepClone(fallback.blocking);

    const subshotSource = Array.isArray(source.subshots) && source.subshots.length ? source.subshots : fallback.subshots;
    const subshots = subshotSource.slice(0, 6).map((item, subIndex) => {
      const base = fallback.subshots[subIndex] || fallback.subshots[0];
      const description = String(item && item.description != null ? item.description : base.description).slice(0, 160);
      return {
        description: description || base.description,
        duration: round2(clampNum(item && item.duration, 0.25, 15, base.duration)),
      };
    });

    const pathSource = Array.isArray(source.path) && source.path.length ? source.path : fallback.path;
    const path = pathSource.slice(0, 8).map((point) => ({
      x: round2(clampNum(point && point.x, ROOM.x0 + 0.2, ROOM.x1 - 0.2, camera.x)),
      z: round2(clampNum(point && point.z, ROOM.z0 + 0.2, ROOM.z1 - 0.2, camera.z)),
    }));
    while (path.length < subshots.length) path.push({ x: camera.x, z: camera.z });
    if (path.length > subshots.length) path.length = subshots.length;

    const baseSource = source.base && typeof source.base === 'object' ? source.base : {};
    const baseSubshots = subshots.map((item, subIndex) => {
      const value = Array.isArray(baseSource.subshots) ? baseSource.subshots[subIndex] : null;
      return value != null ? String(value).slice(0, 160) : item.description;
    });
    const base = {
      shotType: SHOT_TYPES.includes(baseSource.shotType) ? baseSource.shotType : camera.shotType,
      angle: ANGLES.includes(baseSource.angle) ? baseSource.angle : camera.angle,
      movement: MOVEMENTS.includes(baseSource.movement) ? baseSource.movement : camera.movement,
      duration: round2(clampNum(baseSource.duration, 8, 15, duration)),
      subshots: baseSubshots,
    };

    const id = Number(source.id);
    return {
      id: Number.isFinite(id) ? id : fallback.id + index,
      number: Math.max(1, Math.round(clampNum(source.number, 1, 999, fallback.number))),
      scene: String(source.scene || fallback.scene).slice(0, 60),
      duration,
      hasVideo: !!source.hasVideo,
      stale: !!source.stale,
      camera,
      blocking,
      subshots,
      path,
      originalSubshotCount: Math.max(2, Math.round(clampNum(source.originalSubshotCount, 2, 6, subshots.length))),
      base,
      promptAppended: !!source.promptAppended,
      subshotsSyncedAt: Number(source.subshotsSyncedAt) || null,
      appliedAt: Number(source.appliedAt) || null,
    };
  }

  function hydrateShots() {
    let parsed = null;
    try {
      parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (err) {
      parsed = null;
    }
    const saved = parsed && Array.isArray(parsed.shots) && parsed.shots.length
      ? parsed.shots.slice(0, 30)
      : null;
    state.shots = saved ? saved.map((shot, index) => normalizeShot(shot, index)) : deepClone(DEFAULT_SHOTS);
    state.version = Math.max(1, Math.round(num(parsed && parsed.version, 1)));
    state.savedAt = Math.max(0, Math.round(num(parsed && parsed.savedAt, 0)));
    state.savedSnapshot = serializeShots();
    const savedIndex = parsed && parsed.ui ? Math.round(num(parsed.ui.selectedShot, 0)) : 0;
    state.selectedShot = clamp(savedIndex, 0, state.shots.length - 1);
    state.activeSubshot = 0;
    state.selectedEntity = 'camera';
  }

  function resetPrototype() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (err) { /* noop */ }
    state.shots = deepClone(DEFAULT_SHOTS);
    state.selectedShot = 0;
    state.activeSubshot = 0;
    state.selectedEntity = 'camera';
    state.zoom = 1;
    state.pan = { x: 0, y: 0 };
    state.cameraPov = false;
    state.apply.selected = new Set();
    state.apply.fields = { ...state.writeFields };
    state.apply.appendPrompt = false;
    state.apply.syncSubshots = false;
    state.savedSnapshot = serializeShots();
    state.version = 1;
    state.savedAt = 0;
    closeApplyDialog();
    renderAll();
    updateSaveUi();
    showToast('已重置原型数据', 'ok');
  }

  /* ===== 初始化 ===== */
  function renderAll() {
    renderStats();
    renderShotList();
    renderStrip();
    renderStage2D();
    renderInspector();
    updateApplyBadge();
    updateSaveUi();
    updatePovUi();
    if (state.view === '3d') schedule3d();
  }

  let resizeTimer = 0;
  function onWindowResize() {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (state.view === '2d') {
        renderPip();
        updateWorldTransform();
      } else {
        resize3d();
        schedule3d();
      }
    }, 110);
  }

  function bindStaticEvents() {
    document.querySelectorAll('.seg-btn').forEach((button) => {
      button.addEventListener('click', () => setView(button.dataset.view));
    });
    el.zoomInBtn.addEventListener('click', () => zoomCenter(1.15));
    el.zoomOutBtn.addEventListener('click', () => zoomCenter(0.87));
    el.zoomFitBtn.addEventListener('click', fitStage);
    el.saveBtn.addEventListener('click', () => savePlan());
    el.applyBtn.addEventListener('click', openApplyDialog);
    el.moreBtn.addEventListener('click', () => setMoreMenu(el.moreMenu.hidden));
    el.moreMenu.addEventListener('click', onMoreMenuClick);
    el.backBtn.addEventListener('click', () => showToast('原型模式：不连接分集列表', 'ok'));
    el.pip3dBtn.addEventListener('click', () => {
      setView('3d', { silent: true });
      setCameraPov(true);
    });
    el.povBtn.addEventListener('click', () => setCameraPov(!state.cameraPov));

    el.shotList.addEventListener('click', (event) => {
      const row = event.target.closest('[data-shot]');
      if (row) selectShot(Number(row.dataset.shot));
    });
    el.stripTrack.addEventListener('click', (event) => {
      const card = event.target.closest('[data-strip]');
      if (card) selectShot(Number(card.dataset.strip));
    });

    el.inspector.addEventListener('input', onInspectorInput);
    el.inspector.addEventListener('change', onInspectorChange);
    el.inspector.addEventListener('click', onInspectorClick);

    el.applyBody.addEventListener('click', onApplyBodyClick);
    el.applyBody.addEventListener('change', onApplyBodyChange);
    el.applyConfirmBtn.addEventListener('click', applyChanges);
    el.applyCloseBtn.addEventListener('click', closeApplyDialog);
    el.applyCancelBtn.addEventListener('click', closeApplyDialog);
    el.applyDialog.addEventListener('click', (event) => {
      if (event.target === el.applyDialog) closeApplyDialog();
    });

    el.stage2d.addEventListener('pointerdown', onStagePointerDown);
    el.stage2d.addEventListener('wheel', onStageWheel, { passive: false });
    el.stage2d.addEventListener('dblclick', onStageDoubleClick);
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);

    el.canvas3d.addEventListener('pointerdown', onCanvasPointerDown);
    el.canvas3d.addEventListener('pointermove', onCanvasPointerMove);
    el.canvas3d.addEventListener('pointerup', onCanvasPointerUp);
    el.canvas3d.addEventListener('pointercancel', onCanvasPointerUp);
    el.canvas3d.addEventListener('wheel', onCanvasWheel, { passive: false });
    el.canvas3d.addEventListener('dblclick', onCanvasDoubleClick);

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onDocumentClick);
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('beforeunload', () => {
      if (isDirty()) persistNow(true);
    });
  }

  function init() {
    hydrateShots();
    el.floorSvg.innerHTML = buildFloorSvg();
    svgGhostLayer = $('ghostPathLayer');
    svgPathLayer = $('pathLayer');
    svgFrustumLayer = $('frustumLayer');
    bindStaticEvents();
    const params = new URLSearchParams(window.location.search);
    const initialView = params.get('view') === '3d' ? '3d' : '2d';
    state.cameraPov = initialView === '3d' && params.get('pov') === '1';
    setView(initialView, { silent: true });
    renderAll();
    setMoreMenu(false);
    window.requestAnimationFrame(() => {
      renderPip();
      scrollSelectedRow();
    });
  }

  init();
})();
