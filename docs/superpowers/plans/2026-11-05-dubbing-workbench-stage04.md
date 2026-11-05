# 配音工作台阶段 4（原声分离与多轨混音）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从成片原声抽离人物声/背景，生成可编辑的多轨时间线，编辑结果落为 MixPlan，范围试听与最终混音使用同一套渲染。

**Architecture:** 后端新增 `audio-engine`（HTTP sidecar + 本机 FFmpeg 基础分离兜底）、`audio-separation`（任务/素材/自动建轨）、`audio-peaks`、`mix-plan`、`mix-render` 与 `/mix` 路由；前端在现有配音阶段第 4 步内用 `MixStage` 替换旧的简单轨道列表，Canvas 时间线与右侧检查器共用一份 `useMixStage` 状态。所有编辑写 `episode_audio_tracks/clips`，`MixPlan` 只做编译快照。

**Tech Stack:** Hono + Drizzle/better-sqlite3 + FFmpeg（`backend/src/utils/ffmpeg.ts`）+ Node test runner；Nuxt 3/Vue 3 + Canvas + WebAudio；音频引擎默认 `audio-separator`/Demucs HTTP sidecar，未安装时提供明确标注的 FFmpeg 基础分离。

**Spec:** `docs/V3-配音工作台详细设计.md` 第 8 章

## Global Constraints

- TTS 服务、协议、适配器不改；本阶段只读 Take 音频与台词。
- 不新增与现有“预览与混音”并行的页面/标签；第 4 步内替换内容。
- 不静默下载模型；引擎不可用时返回明确状态，UI 显示原因。
- 所有文件路径必须经 `getAbsolutePath`/项目存储解析，拒绝 `..` 与白名单外路径。
- 未提交 git；每次任务结束只跑定向测试，阶段末再跑全量。

---

### Task 1: 音频引擎适配与健康检查

**Files:**
- Create: `backend/src/services/audio-engine.ts`
- Create: `backend/tests/audio-engine.test.ts`
- Modify: `backend/src/utils/ffmpeg.ts`（如需导出 spawn 执行器则复用现有 `ffmpeg()`）

**Interfaces:**
- Produces:
  - `type SeparationEngine = 'uvr' | 'demucs' | 'basic'`
  - `getAudioEngineHealth(): Promise<AudioEngineHealth>`
  - `runSeparation(input: SeparationInput, hooks: SeparationHooks): Promise<SeparationOutput>`
  - `buildBasicSeparationFilters(): { vocals: string; instrumental: string }`
- `SeparationInput`: `{ sourcePath, engine, model, outputDir, durationMs? }`
- `SeparationOutput`: `{ stems: { kind: 'vocals'|'instrumental'|'drums'|'bass'|'other'; path; durationMs; sampleRate; channels }[]; engine; model; confidence?: number|null }`

- [x] **Step 1: 写失败测试**：无 `AUDIO_ENGINE_URL` 时 health 返回 `mode:'basic'`、`engines:['basic']`、`available:true`（FFmpeg 可用时）；`buildBasicSeparationFilters()` 同时包含 `pan=stereo` 的中置提取与中置消除表达式；`runSeparation` 收到 `engine:'uvr'` 且无 URL 时抛 `AudioEngineError`（`code:'engine_unavailable'`）。
- [x] **Step 2: 运行测试确认失败**（模块不存在）。
- [x] **Step 3: 实现**：
  - env：`AUDIO_ENGINE_URL`、`AUDIO_ENGINE_TOKEN`、`AUDIO_ENGINE_TIMEOUT_MS`（默认 1800000）。
  - HTTP：POST `${url}/v1/separate`，Bearer token；轮询 `${url}/v1/jobs/:id`（1s），进度回调；`cancel` 调 `/cancel`；白名单校验返回路径位于 `outputDir` 下且文件存在。
  - basic：`ffmpeg -i source -filter_complex` 分别输出 `vocals.wav`（`pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1`）与 `instrumental.wav`（`pan=stereo|c0=0.5*c0-0.5*c1|c1=0.5*c1-0.5*c0`），`-ar 48000 -ac 2`；用 `probeDurationMs` 填元数据；`confidence:null`。
  - 单声道源：basic 直接抛 `AudioEngineError('基础分离需要立体声原声', 'mono_source')`。
- [x] **Step 4: 运行测试通过**。
- [ ] **Step 5: Commit**（仅本地，等待用户明确要求后再提交）。

### Task 2: 分离任务、素材入库与自动建轨

**Files:**
- Create: `backend/src/services/audio-separation.ts`
- Create: `backend/tests/audio-separation.test.ts`
- Modify: `backend/src/db/sqlite-schema.ts`（仅当缺 `episode_audio_assets` 唯一/索引时补索引）
- Reuse: `backend/src/services/dubbing.ts#ensureMergedVideo`

**Interfaces:**
- Consumes: Task 1 `runSeparation`
- Produces:
  - `startEpisodeSeparation(episodeId, dramaId, options): Promise<{ jobId, status, reused }>`
  - `getSeparationStatus(episodeId): SeparationStatus`
  - `cancelEpisodeSeparation(episodeId): boolean`
  - `listEpisodeAssets(episodeId)`
  - `deleteEpisodeAsset(episodeId, assetId)`
  - `autoCreateStemTracks(episodeId, assetIds): { tracks, clips }`
- `options`: `{ engine?: 'uvr'|'demucs'|'basic'; model?: string; diarization?: boolean; force?: boolean }`

- [x] **Step 1: 写失败测试**：fake runner 返回两个 wav；`startEpisodeSeparation` 写 `dubbing_jobs`、素材 `vocals/instrumental/original`、轨道 `A1 原声对白/A2 原声背景/A3 人物声` 与三条全片片段；同 `source_hash+engine+model` 再次调用返回 `reused:true` 且不新增素材；`force:true` 创建新素材。
- [x] **Step 2: 运行测试确认失败**。
- [x] **Step 3: 实现**：
  - `ensureMergedVideo` 取合片路径与时长；无合片直接抛明确错误。
  - `source_hash = sha256(文件内容)`（流式）；缓存 key = `source_hash + engine + model + diarization`。
  - 任务写 `dubbing_jobs(kind='separate')`，内存 Map 保存进度；`getSeparationStatus` 优先内存，服务重启后把 running 标记 failed（`note` 提示重试）。
  - 成功：素材写入 `episode_audio_assets`（`source_hash/url/duration/engine/model/license/status='ready'`），原声也写一条 `kind='original'`（file 直接指向合片，`url=mergedUrl`）。
  - 自动建轨：`role` 分别 `original/ambience/dialogue`，`stemAssetId` 绑定；`original` 默认 `muted=true`，`dialogue` 默认 `muted=true`（避免与新配音重复），`ambience` 默认 `ducking=true`；片段铺满全片，`fadeInMs=80/fadeOutMs=120`。
  - 删除素材只软删素材与关联轨道/片段，不删 Take。
- [x] **Step 4: 运行测试通过**。
- [ ] **Step 5: Commit**（仅本地）。

### Task 3: 波形 peaks 服务

**Files:**
- Create: `backend/src/services/audio-peaks.ts`
- Create: `backend/tests/audio-peaks.test.ts`
- Create: `backend/src/routes/audio-peaks.ts`
- Modify: `backend/src/index.ts`（挂载路由）

**Interfaces:**
- Produces:
  - `computePeaksFromPcm(samples: Int16Array, sampleRate: number): PeaksPayload`
  - `getPeaksForAsset(episodeId, assetId): Promise<PeaksPayload>`
  - `getPeaksForSource(episodeId, source: 'asset'|'take'|'sample', id): Promise<PeaksPayload>`
- `PeaksPayload`: `{ assetId?: number; takeId?: number; sampleId?: number; sampleRate: 8000; durationMs; levels: { spp: 128|512|2048|8192; peaks: [number, number][] }[] }`

- [x] **Step 1: 写失败测试**：`computePeaksFromPcm` 对 `[0,16384,-32768,32767]` 生成 4 个桶且 min/max 归一化正确；每层桶数符合 `ceil(samples/spp)`；空输入返回空 levels。
- [x] **Step 2: 运行测试确认失败**。
- [x] **Step 3: 实现**：FFmpeg `-i file -ac 1 -ar 8000 -f s16le -` 读入 Buffer → Int16Array；缓存 `storage/projects/<dramaId>/audio/peaks/<sha1(file+mtime+size)>.json`；API `GET /episodes/:id/audio/peaks?asset_id=|take_id=|sample_id=` 三选一，非法返回 400，越权 404。
- [x] **Step 4: 运行测试通过**。
- [ ] **Step 5: Commit**（仅本地）。

### Task 4: MixPlan 编译、总线与版本

**Files:**
- Create: `backend/src/services/mix-plan.ts`
- Create: `backend/tests/mix-plan.test.ts`
- Modify: `backend/src/services/audio-tracks.ts`（补 `role/pan/busId/locked/hidden/color/height/stemAssetId` 的读写与 `collectMixPlanTracks`）
- Modify: `backend/src/routes/audio-tracks.ts`（补角色与总线字段透传）

**Interfaces:**
- Produces:
  - `ensureDefaultBuses(episodeId): BusRow[]`（`dialogue/original/sfx/bgm/master`）
  - `compileMixPlan(episodeId, dramaId): Promise<MixPlan>`
  - `hashMixPlan(plan): string`
  - `createMixRevision(episodeId, note?): MixRevision`
  - `listMixRevisions(episodeId)` / `restoreMixRevision(episodeId, revisionId)`
- `MixPlan` 按设计 8.5；`virtualDialogue` 从 `previewTimeline` + 激活 Take 生成，plan 中 `id:null, role:'voice', virtual:true`，不写库。

- [x] **Step 1: 写失败测试**：无轨道时仍生成 dialogue 虚拟轨与 4 条总线；solo 任一条后其余轨 `effectiveMuted=true` 且 `muted` 原值不变；缺失片段标 `unusable` 不中断；同内容 plan hash 稳定、改音量后变化；revision 创建/恢复 `is_current` 唯一。
- [x] **Step 2: 运行测试确认失败**。
- [x] **Step 3: 实现**：`ensureDefaultBuses` 幂等插入；`compileMixPlan` 读 `episode_audio_tracks/clips`、`episode_audio_assets`、`previewTimeline`；`role` 缺省由 `kind` 映射（`ambience→ambience` 等）；总线分配 `dialogue/voice→dialogue`、`original→original`、`sfx→sfx`、`bgm→bgm`、其余→`sfx`；`durationMs` 取合片时长/时间轴/片段最大结束；`planHash` 对规范化 JSON 做 sha256。
  - 保存：`PUT /episodes/:id/mix` 接收 `{buses,tracks,clips}`，事务内更新并返回新 plan；`POST /mix/revisions` 快照；恢复时写回 tracks/clips/buses 并置 current。
- [x] **Step 4: 运行测试通过**。
- [ ] **Step 5: Commit**（仅本地）。

### Task 5: 混音渲染（范围试听 + 音频导出）

**Files:**
- Create: `backend/src/services/mix-render.ts`
- Create: `backend/tests/mix-render.test.ts`
- Reuse: `backend/src/services/audio-mix.ts` 的 `probeDurationMs`、`execFfmpeg` 模式

**Interfaces:**
- Produces:
  - `buildMixFilterGraph(plan, range?): { inputs: string[]; graph: string; outputDurationSec: number }`
  - `renderMixAudio(plan, options: { startMs?; endMs?; outputPath; format: 'm4a'|'wav' }): Promise<{ url; startMs; endMs; durationMs }>`
- 规则：片段 `atrim→asetpts→volume→pan→afade→adelay`；轨道 `amix normalize=0`；总线音量；ducking 总线用 dialogue 作 sidechain；最后 `loudnorm→alimiter`；范围试听只输出该段。

- [x] **Step 1: 写失败测试**：`buildMixFilterGraph` 包含每条片段的 `atrim/adelay`、轨道 `amix`、`loudnorm`、`alimiter`；范围模式包含起止裁剪；渲染 2 秒正弦片段（FFmpeg 实际执行）输出时长差 ≤100ms 且 `loudnorm` 后 LUFS 与目标偏差 ≤1 LU（用 `ffmpeg -af ebur128` 或 `volumedetect` 容忍）。
- [x] **Step 2: 运行测试确认失败**。
- [x] **Step 3: 实现**：拼输入去重（同文件只入一次）；filter_complex 标签稳定；无可用片段时报 `没有可渲染的音频片段`；输出写项目 `audio/mix/`，`keepLatestFiles` 清理旧预览。
- [x] **Step 4: 运行测试通过**。
- [ ] **Step 5: Commit**（仅本地）。

### Task 6: `/mix` 路由与分离接口

**Files:**
- Create: `backend/src/routes/mix.ts`
- Create: `backend/tests/mix-routes.test.ts`
- Modify: `backend/src/index.ts`

**Interfaces:**
- Routes（设计 8.12）：
  - `POST /episodes/:id/audio/separate`、`GET /episodes/:id/audio/separate/status`、`GET/DELETE /episodes/:id/audio/assets`、`POST /audio/assets/:assetId/tracks`
  - `GET/PUT /episodes/:id/mix`、`GET/PUT /episodes/:id/mix/buses`
  - `POST/GET /episodes/:id/mix/revisions`、`POST /episodes/:id/mix/revisions/:rid/restore`
  - `POST /episodes/:id/mix/preview`、`POST /episodes/:id/mix/render`
  - peaks 路由由 Task 3 提供

- [x] **Step 1: 写失败测试**：空集 `GET /mix` 返回 4 总线 + 空轨道；`PUT /mix` 越权/非法片段返回 400；`POST /separate` 无合片返回 400 且带明确 message；`POST /mix/preview` 范围过短返回 400；`GET /audio/assets` 只返回本集未删除素材。
- [x] **Step 2: 运行测试确认失败**。
- [x] **Step 3: 实现路由与错误映射**（`AudioEngineError` 503、业务 400、不存在 404），挂载到 `/api/v1`。
- [x] **Step 4: 运行定向测试与后端 `npm test`，确认无回归**。
- [ ] **Step 5: Commit**（仅本地）。

### Task 7: 前端 API 与 `useMixStage`

**Files:**
- Modify: `frontend/app/composables/useApi.ts`
- Create: `frontend/app/composables/useMixStage.ts`
- Modify: `frontend/app/composables/useDubbingSession.ts`（暴露 mix 所需 episode/drama）

**Interfaces:**
- `mixAPI`: `separate`, `separationStatus`, `assets`, `removeAsset`, `autoTracks`, `getPlan`, `savePlan`, `saveBuses`, `revisions`, `saveRevision`, `restoreRevision`, `preview`, `render`, `peaks`
- `useMixStage({ episodeId, dramaId })` 返回 `plan, tracks, buses, assets, selectedClip, playheadMs, zoom, snap, undo/redo, load, save, addTrack, updateTrack, removeTrack, createClip, updateClip, splitClip, moveClip, trimClip, runSeparation, previewRange, saveRevision`
- Undo 栈 50 步；`plan` 变化 300ms 防抖保存；solo 派生不写回 `muted`。

- [x] **Step 1:** 写 `useApi` 类型与方法（严格对齐后端 snake_case）。
- [x] **Step 2:** `useMixStage` 管理计划、选中、播放头、缩放、吸附、撤销/重做、范围试听与分离轮询（1s）。
- [x] **Step 3:** 前端 `npm run build` 通过。

### Task 8: 阶段 4 UI（MixStage + Canvas 时间线）

**Files:**
- Create: `frontend/app/components/MixStage.vue`
- Create: `frontend/app/components/MixTimeline.vue`
- Create: `frontend/app/components/MixTrackHead.vue`
- Create: `frontend/app/components/MixClipInspector.vue`
- Modify: `frontend/app/components/DubbingStage.vue`（第 4 步改用 `MixStage`，保留现有 BGM 快捷控制）
- Delete/Retire: `frontend/app/components/AudioMixBoard.vue`（确认无其他引用后删除）

**Interfaces:**
- `MixStage` props `{ episodeId, dramaId, durationMs }`；无其他页面入口。
- 顶栏：抽离原声、重新分离、缩放、吸附、撤销/重做、保存版本。
- 工作区：288px 轨道头 + Canvas 时间线 + 316px 检查器；底部传输条（范围、循环、主音量、峰值/LUFS、试听）。
- Canvas：标尺、轨道、片段、波形 peaks、播放头；拖拽移动/裁剪、点击选中、双击定位台词、滚轮缩放/水平滚动；快捷键 `Space/S/Delete/M/Cmd+Z/Shift+Cmd+Z`。
- 检查器：片段属性、时间裁剪、增益/声像、淡入淡出/曲线、跟随 Take、所属轨道/总线、定位台词、重新生成（跳转生成阶段）。
- 分离状态：引擎、进度、失败原因、重试；未安装时显示“基础分离”与质量提示，不静默下载模型。

- [x] **Step 1:** 搭建布局与轨道头（名称/颜色/锁定/隐藏/音量/声像/M/S/Duck/Loop/电平）。
- [x] **Step 2:** Canvas 标尺/轨道/片段/波形绘制与缩放、吸附、拖拽、裁剪。
- [x] **Step 3:** 选中片段检查器与分割/复制/删除/静音、撤销重做。
- [x] **Step 4:** 抽离原声与轮询、范围试听（`<audio>` 播放服务端预览）、保存版本。
- [x] **Step 5:** 响应式与空态；不出现生成语音/改台词/导出成片按钮。

### Task 9: 四语言文案、冒烟与全量验证

**Files:**
- Modify: `frontend/app/locales/{zh,en,ja,ko}.json`（新增 `mix.*` 约 45 key）
- Modify: `docs/V3-执行日志.md`
- Modify: 本计划勾选

- [x] **Step 1:** 四语言 `mix.*` 文案与 JSON 校验。
- [x] **Step 2:** 定向测试：`npm test` 中新增 5 个测试文件全部通过。
- [x] **Step 3:** 后端 `npm test`、`npm run build`、`npm run test:structure`、`npm run drift`；前端 `npm run build`。
- [x] **Step 4:** 浏览器只读冒烟：打开第 4 步，轨道/时间线/检查器渲染；无合片时抽离按钮给出明确提示；不触发真实分离与 TTS；停止 dev server。
- [x] **Step 5:** 执行日志追加阶段 4 落地记录并勾选计划。

---

## Self-Review

- 覆盖设计 8.2–8.12：引擎、素材、自动建轨、MixPlan、时间线交互、试听、响度/ducking、生命周期、API 均有任务。
- 未改 TTS 协议；未新增并行页面；引擎不可用时明确报错，不静默下载模型。
- 基础分离仅作为无 UVR/Demucs 时的显式降级，UI 与素材记录 engine/model，可追溯。

---

## 执行结果（2026-11-05）

- Task 1–9 的实施与验证步骤全部完成；Task 1–6 的「Commit」步骤按用户要求未执行，改动保持未提交。
- 验证：阶段 4 定向 32/32；后端全量 674/674；后端 build 通过；structure 61/61；drift 123 PASS / 0 WARN / 0 FAIL；前端 build 通过；混音结构测试 10/10；四语言 `mix.*` 150 key 对齐。
- 浏览器只读冒烟：8-2 第 4 步渲染对白虚拟轨、10 个 Take 片段、波形与检查器；8-3 无合片时抽离原声返回明确错误，未创建任务或素材，未触发真实分离与 TTS，dev server 已停止。
- 记录见 `docs/V3-执行日志.md`「配音工作台阶段 4 落地（2026-11-05）」。
