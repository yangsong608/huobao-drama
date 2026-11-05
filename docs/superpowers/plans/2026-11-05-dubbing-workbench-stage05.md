# 配音工作台阶段 5（合成导出）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 MixPlan 为唯一输入，交付混音 WAV、分轨 ZIP 与视频成片（软/烧录/无字幕、横竖屏预设），并提供可复用、可取消、可重试、可回看/删除/设为当前的导出记录。

**Architecture:** 后端新增 `export-presets`（预设/命名）、`export-zip`（ZIP 写入）、`export-validation`（ffprobe/响度校验）、`export-render`（视频封装/分轨/响度校正）与 `export-service`（记录、状态机、复用键、三套流水线）；现有 `runDubbing` 的最终混音封装改为调用 `export-service`。前端在现有第 5 步内用 `ExportStage` 替换旧的开始配音面板，新增 `useExportSession` 轮询状态，不增加并行页面。

**Tech Stack:** Hono + Drizzle/better-sqlite3 + FFmpeg/ffprobe（`backend/src/utils/ffmpeg.ts`）+ Node `zlib`/`fs`；Nuxt 3/Vue 3；Node test runner。

**Spec:** `docs/V3-配音工作台详细设计.md` 第 9 章

## Global Constraints

- TTS 服务、协议、适配器不改；导出只消费已生成的 Take、台词与 MixPlan。
- 不新增与现有“合成导出”并行的页面/标签；第 5 步内替换内容。
- 所有导出文件写入项目存储 `episodes/<episodeId>/exports/<exportId>/`，路径必须经 `getAbsolutePath`/项目存储解析。
- 当前成片只允许视频导出设置；音频/分轨导出不改 `episodes.video_url`。
- 未提交 git；阶段末只做验证，不自动提交。
- 不进行打包/安装/重启；验证只跑测试、构建与只读浏览器冒烟。

---

### Task 1: 闭合 MixPlan 的原声总床与本集 BGM

**Files:**
- Modify: `backend/src/services/mix-plan.ts`
- Modify: `backend/tests/mix-plan.test.ts`

**Interfaces:**
- Produces:
  - `compileMixPlan()` 额外生成两条虚拟轨（顺序在虚拟对白轨之后、数据库轨之前）：
    - `role:'original', name:'原声总床', busId:'original', virtual:true`，仅当本集没有用户 `original/ambience` 轨且存在可读的最近一次非 `mix` 合片时生成；
    - `role:'bgm', name:'配乐', busId:'bgm', virtual:true`，仅当本集没有用户 `bgm` 轨且存在可读的 `episode.bgmUrl || drama.bgmUrl` 时生成；`loop:true`，片段 `fadeOutMs:2000`。
  - 虚拟轨 `id:null`，片段 `id:null`，不写库；`plan.durationMs` 取时间轴、合片时长与片段最大结束的较大值。

- [x] **Step 1: 写失败测试**（`backend/tests/mix-plan.test.ts`）
  - 在 fixture 中插入一条 `videoMerges(status:'completed', kind:'concat', mergedUrl: shotUrl)`，并给 drama 设置 `bgmUrl: toneUrl`；删除现有用户 `bgm` 轨或新建一集无 BGM 轨的 episode 分别验证“有用户轨时不生成虚拟 BGM”。
  - 断言：
    - `compileMixPlan` 返回 `原声总床` 虚拟轨，片段 `startMs:0`、`endMs:2000`、`audioUrl:shotUrl`、`usable:true`；
    - 返回 `配乐` 虚拟轨，`loop:true`、`fadeOutMs:2000`；
    - 用户已有 `bgm` 轨时不再生成虚拟 `配乐`；
    - 空集仍只有一条虚拟对白轨。
- [x] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/mix-plan.test.ts`
Expected: FAIL，找不到 `原声总床` / `配乐`。

- [x] **Step 3: 实现**
  - 新增 `latestMergeBed(episodeId)`：读 `videoMerges` 中 `status='completed' && mergedUrl && kind !== 'mix'` 的最新一行，文件存在才返回 `{url,durationMs}`（时长用 `probeDurationMs`，失败则用 `row.duration*1000`）。
  - 新增 `buildVirtualBedTrack(...)` 与 `buildVirtualBgmTrack(...)`，复用 `clipSource` 判断可用性；不可读则不生成。
  - `tracks.unshift(dialogue)` 后按 `dialogue、original bed、bgm bed、数据库轨` 重组，`sortOrder` 分别 `-1/-2/-3`。
  - 生成虚拟轨后统一执行 solo/effectiveMuted 派生。
- [x] **Step 4: 运行测试通过**

Run: 同上
Expected: PASS。

- [ ] **Step 5: Commit**（仅本地，等待用户明确要求后再提交）。

### Task 2: 导出预设与文件命名

**Files:**
- Create: `backend/src/services/export-presets.ts`
- Create: `backend/tests/export-presets.test.ts`

**Interfaces:**
- Produces:
  - `type ExportKind = 'mix' | 'video' | 'stems'`
  - `type ExportPresetKey = 'vertical-hd' | 'horizontal-hd' | 'vertical-high' | 'audio-wav' | 'stems'`
  - `type ExportSubtitleMode = 'soft' | 'burn' | 'none'`
  - `EXPORT_PRESETS: Record<ExportPresetKey, ExportPreset>`
  - `resolveExportPreset(input: { preset?: string; kind?: string; aspect?: string }): ExportPreset`
  - `normalizeSubtitleMode(raw: unknown, preset: ExportPreset): ExportSubtitleMode`
  - `buildExportFilename(input: { episodeNumber; title; preset; at? }): string`
- 预设值：竖屏高清 `1080×1920 / 8–12Mbps / AAC192k`；横屏高清 `1920×1080 / 8–12Mbps / AAC192k`；竖屏高码 `1080×1920 / 12–16Mbps / AAC256k`；仅音频 `WAV 48k/24bit`；分轨 `WAV ZIP`。

- [x] **Step 1: 写失败测试**
  - `resolveExportPreset({ aspect:'9:16' })` → `vertical-hd`；`{ aspect:'16:9' }` → `horizontal-hd`；`kind:'mix'` → `audio-wav`；`kind:'stems'` → `stems`；非法 preset 抛 `ExportPresetError`。
  - `normalizeSubtitleMode('burn', verticalPreset)` → `burn`；`vertical-high` 只允许 `soft/none`（传 `burn` 退化为 `soft`）；音频预设恒为 `none`。
  - `buildExportFilename` 输出 `EP001_雨夜_竖屏高清_20261105-1520.mp4`，标题含 `/ : * ? " < > |` 时替换为 `_`，整体 basename 截断到 80 字。
- [x] **Step 2: 运行测试确认失败**

Run: `cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/export-presets.test.ts`

- [x] **Step 3: 实现**
  - `EXPORT_PRESETS` 带 `labelKey`、`width/height`、`maxrateKbps/bufsizeKbps`、`audioBitrateKbps`、`extension`、`kind`、`subtitleModes`。
  - `buildExportFilename` 使用本地时间 `yyyyMMdd-HHmm`；扩展名由预设决定；中文/字母/数字保留，其余替换 `_`，压缩连续 `_`。
- [x] **Step 4: 运行测试通过**。
- [ ] **Step 5: Commit**（仅本地）。

### Task 3: 分轨 ZIP 写入

**Files:**
- Create: `backend/src/services/export-zip.ts`
- Create: `backend/tests/export-zip.test.ts`

**Interfaces:**
- Produces:
  - `crc32(data: Buffer): number`
  - `createZip(entries: { name: string; data: Buffer }[]): Buffer`
  - `writeZip(file: string, entries): number`（返回字节数）

- [x] **Step 1: 写失败测试**
  - `crc32(Buffer.from('123456789'))` → `0xCBF43926`。
  - 写入两个文件后用系统 `unzip -l` 列出条目与大小；`unzip -p` 读回内容与原始 Buffer 一致。
- [x] **Step 2: 运行测试确认失败**。
- [x] **Step 3: 实现**
  - 本地文件头（`0x04034b50`）+ central directory（`0x02014b50`）+ EOCD（`0x06054b50`）。
  - 文件名 UTF-8，通用标志位 `0x0800`；使用 `zlib.deflateRawSync` 压缩，压缩后不小于原大小时改用 store。
  - DOS 时间固定取当前本地时间；单文件 > 4GB 抛明确错误。
- [x] **Step 4: 运行测试通过**。
- [ ] **Step 5: Commit**（仅本地）。

### Task 4: 导出校验与响度测量

**Files:**
- Create: `backend/src/services/export-validation.ts`
- Create: `backend/tests/export-validation.test.ts`

**Interfaces:**
- Produces:
  - `probeMedia(file: string): Promise<MediaProbe>`
  - `measureLoudness(file: string): Promise<LoudnessReport>`
  - `validateExport(file: string, expected: ExportExpectation): Promise<ExportValidation>`
- `MediaProbe`: `{ durationMs; sizeBytes; video: {codec,width,height}|null; audio: {codec,sampleRate,channels}|null; subtitleStreams }`
- `LoudnessReport`: `{ lufs; truePeak; lra }`
- `ExportExpectation`: `{ kind; durationMs?; width?; height?; requireSubtitleStream?; targetLufs?; maxTruePeak? }`
- `ExportValidation`: `{ ok; errors: string[]; warnings: string[]; probe; loudness }`

- [x] **Step 1: 写失败测试**
  - 生成 2 秒 1080×1920 测试视频 + 48k 立体声 AAC + mov_text 字幕；`validateExport` 返回 `ok:true`、无 errors。
  - 时长差 300ms 时 errors 含“时长”；缺少音频流时 errors 含“音频流”；软字幕模式缺字幕流时 errors 含“字幕流”。
  - 响度偏差 >0.5 LU 或 true peak > -1.0 dBTP 进入 warnings，不改变 `ok`。
- [x] **Step 2: 运行测试确认失败**。
- [x] **Step 3: 实现**
  - `probeMedia` 用 `ffmpeg.ffprobe`（`format.duration`、`streams`）。
  - `measureLoudness` 用 ffprobe 路径同级 ffmpeg spawn：`-af loudnorm=I=-16:TP=-1.5:print_format=json -f null -`，解析最后一段 JSON 的 `input_i/input_tp/input_lra`。
  - `validateExport` 规则按设计 9.6：文件存在/大小、流、时长 ±100ms、48k/声道、字幕流、LUFS ±0.5、TP ≤ -1.0。
- [x] **Step 4: 运行测试通过**。
- [ ] **Step 5: Commit**（仅本地）。

### Task 5: 混音渲染扩展（24bit、分轨、取消、真实峰值）

**Files:**
- Modify: `backend/src/services/mix-render.ts`
- Modify: `backend/tests/mix-render.test.ts`

**Interfaces:**
- Produces:
  - `MixRenderOptions` 增加 `codec?: 'pcm_s16le'|'pcm_s24le'|'aac'`、`bitrateKbps?: number`、`onlyBus?: MixBusKey`、`onProgress?: (percent:number)=>void`、`signal?: AbortSignal`
  - `buildMixFilterGraph(plan, range?, options?: { onlyBus?: MixBusKey })`
- 规则：
  - 主输出限制器改为按 `limiterCeiling` 计算 `alimiter=limit=<linear>:level=false`，保证 true peak 可达标；
  - `onlyBus` 时只输出该总线（对 `original/bgm` 仍应用 dialogue sidechain），跳过 master/loudnorm；
  - `renderMixAudio` 支持 `onProgress` 与取消；取消后抛 `MixRenderError('已取消')`。

- [x] **Step 1: 写失败测试**
  - `buildMixFilterGraph(plan, {}, { onlyBus:'bgm' })` 图含 `sidechaincompress`、不含 `loudnorm`，输出标签 `[out]`。
  - `renderMixAudio(..., { format:'wav', codec:'pcm_s24le' })` 生成文件 ffprobe 为 `pcm_s24le`。
  - 启动渲染后 `AbortController.abort()`，Promise reject `/已取消/`。
- [x] **Step 2: 运行测试确认失败**。
- [x] **Step 3: 实现**
  - 把 sidechain 与 master 逻辑拆成“总线输出 → 可选 ducking → 目标输出”；完整混音仍走 master。
  - fluent-ffmpeg `progress` 事件回调；`signal` 监听后 `cmd.kill('SIGTERM')`，按 `signal.aborted` 归一化错误。
- [x] **Step 4: 运行测试通过**。
- [ ] **Step 5: Commit**（仅本地）。

### Task 6: 导出服务（记录、检查、三套流水线、复用/取消/重试）

**Files:**
- Create: `backend/src/services/export-render.ts`
- Create: `backend/src/services/export-service.ts`
- Create: `backend/tests/export-service.test.ts`
- Modify: `backend/src/services/dubbing.ts`（`runDubbing` 最终封装改调 `export-service`）

**Interfaces:**
- `export-render.ts`：
  - `renderExportVideo(input: { videoPath; mixPath; durationMs; preset; subtitleMode; srtPath?; assPath?; outputPath; signal?; onProgress? }): Promise<{ durationMs }>`
  - `renderBusStems(plan, dir, hooks): Promise<{ bus: MixBusKey; file: string }[]>`
  - `correctLoudness(file, deltaDb, truePeak): Promise<void>`
  - `estimateExportBytes(kind, durationMs, preset): number`
- `export-service.ts`：
  - `getExportChecks(episodeId): Promise<ExportChecks>`
  - `startEpisodeExport(episodeId, input): Promise<{ record; reused }>`
  - `getExport(id)` / `listExports(episodeId)` / `cancelExport(id)` / `retryExport(id)` / `setCurrentExport(id)` / `deleteExport(id)`
  - `resetExportRuntime(): void`
- `ExportError` 带 `status: 400|404|409|507`；取消抛 `ExportCancelledError`。
- 复用键：`kind + preset + planHash + sourceVideoHash + subtitleHash + paramsJson`。

- [x] **Step 1: 写失败测试**（真实 FFmpeg 小样）
  - 构造 drama/episode/镜头/台词/Take/合片（用 `ffmpeg` 生成 2 秒视频）；`getExportChecks` 返回 lines/video/mix/subtitles/ffmpeg 检查项。
  - `startEpisodeExport(kind:'mix')` 完成后记录 `completed`、WAV 24bit、`durationMs≈2000`、`lufs` 非空、文件存在；同参数再次启动返回 `reused:true` 且不新增记录。
  - `kind:'video'` 三种字幕模式各导出一次；软字幕 ffprobe 有字幕流；烧录/无字幕无字幕流；`set_current:true` 后 `episodes.videoUrl` 指向成片。
  - `kind:'stems'` 产出 ZIP，`unzip -l` 含至少 `dialogue.wav` 与 `original.wav`；完成后临时 WAV 被清理。
  - 取消：启动长任务后 `cancelExport`，记录 `cancelled`、无残留输出。
  - 重试：把记录标 `failed` 后 `retryExport` 成功并回到 `completed`。
  - 删除当前成片：软删记录、`episodes.videoUrl` 回退到上一条当前视频或保留。
- [x] **Step 2: 运行测试确认失败**。
- [x] **Step 3: 实现**
  - 记录状态：`pending → running → completed|failed|cancelled`；模块加载时把遗留 `running` 标 `failed`（“服务重启，任务已中断”）。
  - 进度：编译/校验 0–5、渲染 5–65、响度 65–75、封装 75–92、校验入库 92–100。
  - 视频：`ensureMergedVideo` → 生成 MixPlan 混音 WAV（24bit）→ 响度校正 → `renderExportVideo`（scale+pad、H.264、AAC、`+faststart`、`-t`）→ 校验 → 设当前。
  - 混音：`renderMixAudio` 24bit WAV → 响度校正 → 校验。
  - 分轨：按非 master 总线逐条 `onlyBus` 渲染 24bit WAV → ZIP → 校验后清理临时 WAV。
  - 磁盘前置检查用 `fs.statfsSync`；不可用时跳过。
  - `runDubbing`：保留合片与逐句合成，删除旧的 `buildDialogueTrack/mixEpisodeAudio` 封装段，改为 `startEpisodeExport(kind:'video', preset=aspect==='9:16'?'vertical-hd':'horizontal-hd', subtitle_mode, set_current:true)` 并轮询到终态；`stopDubbing` 取消该导出。
- [x] **Step 4: 运行测试通过**。
- [ ] **Step 5: Commit**（仅本地）。

### Task 7: 导出路由与挂载

**Files:**
- Create: `backend/src/routes/exports.ts`
- Create: `backend/tests/export-routes.test.ts`
- Modify: `backend/src/index.ts`

**Interfaces:**
- Routes：
  - `GET /episodes/:id/export-checks`
  - `POST /episodes/:id/exports` body `{ kind?, preset?, subtitle_mode?, set_current? }`
  - `GET /episodes/:id/exports`
  - `GET /exports/:id`
  - `POST /exports/:id/cancel`
  - `POST /exports/:id/retry`
  - `POST /exports/:id/current`
  - `DELETE /exports/:id`
- 挂载：`api.route('/', exports)` 放在 `mix` 之后。

- [x] **Step 1: 写失败测试**
  - 空集 `GET /episodes/:id/exports` 返回 `{items:[]}`；`POST` 非法 preset 返回 400；不存在的导出返回 404；跨集设置当前返回 400。
  - `GET /episodes/:id/export-checks` 返回 checks 结构。
- [x] **Step 2: 运行测试确认失败**。
- [x] **Step 3: 实现错误映射**：`ExportError` 按 status；未知错误 500。
- [x] **Step 4: 运行定向测试与 `npm test`**。
- [ ] **Step 5: Commit**（仅本地）。

### Task 8: 前端 API 与 `useExportSession`

**Files:**
- Modify: `frontend/app/composables/useApi.ts`
- Create: `frontend/app/composables/useExportSession.ts`
- Create: `frontend/tests/export-stage-structure.test.mjs`

**Interfaces:**
- `exportAPI`：`checks`, `start`, `list`, `get`, `cancel`, `retry`, `setCurrent`, `remove`。
- `useExportSession({ episodeId, dramaId, onChanged })` 返回：
  - `checks, exports, active, loading, error`
  - `preset, subtitleMode, setPreset, setSubtitleMode`
  - `start(kind)`, `cancel(id)`, `retry(id)`, `setCurrent(id)`, `remove(id)`, `refresh`, `startPolling`, `stopPolling`
- 轮询：任一记录 `pending/running` 时 1.5s 刷新；组件卸载停止。

- [x] **Step 1:** 写 `useApi` 类型与方法（严格对齐后端 snake_case）。
- [x] **Step 2:** 实现 `useExportSession`。
- [x] **Step 3:** 结构测试断言：组件引用 `exportAPI`、有预设/字幕模式/三个导出按钮、无 `startDub`/`stopDub`/文本编辑框。
- [x] **Step 4:** 前端 `npm run build` 通过。

### Task 9: 阶段 5 UI（ExportStage）与第 5 步接入

**Files:**
- Create: `frontend/app/components/ExportStage.vue`
- Modify: `frontend/app/components/DubbingStage.vue`
- Modify: `frontend/tests/export-stage-structure.test.mjs`

**Interfaces:**
- `ExportStage` props `{ episodeId, dramaId }`；emits `go-stage(stage: string)`、`changed(hasOutput: boolean)`。
- 布局：左侧导出检查 + 预设/字幕模式 + 三个导出按钮 + 进度/取消/重试 + 输出卡；右侧导出记录（时间、预设、时长、大小、响度、状态、播放、设为当前、删除）。
- 检查项失败显示「去处理」按钮：台词→`lines`，语音→`generate`，混音→`preview`。
- 不出现任何编辑控件（不改台词、不生成语音、不调轨道）。
- `DubbingStage` 第 5 步整体替换为 `<ExportStage :episode-id="episodeId" :drama-id="dramaId" @go-stage="goStep" @changed="exportDone = $event" />`；`stepDone(4)` 使用 `exportDone`。

- [x] **Step 1:** 实现检查/历史/进度 UI 与响应式布局。
- [x] **Step 2:** 接入第 5 步并删除旧 `startDub` 面板（`startDub/stopDub` 仍保留给 composable/自动化，不在 UI 出现）。
- [x] **Step 3:** 结构测试通过；浏览器只读冒烟第 5 步。

### Task 10: 四语言文案、测试与执行日志

**Files:**
- Modify: `frontend/app/locales/{zh,en,ja,ko}.json`（新增 `export.*` 约 55 key）
- Modify: `docs/V3-执行日志.md`
- Modify: 本计划勾选

- [x] **Step 1:** 四语言 `export.*` 文案与 JSON 校验。
- [x] **Step 2:** 定向测试：`export-presets/zip/validation/service/routes/mix-plan/mix-render` 全部通过。
- [x] **Step 3:** 后端 `npm test`、`npm run build`、`npm run test:structure`、`npm run drift`；前端 `npm run build`。
- [x] **Step 4:** 浏览器只读冒烟：第 5 步显示检查项/预设/历史；不触发真实导出与 TTS；停止 dev server。
- [x] **Step 5:** 执行日志追加阶段 5 落地记录并勾选计划。

---

## Self-Review

- 覆盖设计 9.1–9.10：两种产物、五套预设、三套流水线、进度、记录/复用/当前/删除/取消/重试、校验、命名与清理、UI、API、验收。
- 闭合阶段 4 遗留：合片原声总床与本集 BGM 进入 MixPlan，试听/混音/视频共用同一渲染。
- 未改 TTS；第 5 步替换而非新增并行入口；导出失败不设当前；分轨临时文件完成后清理。
- `runDubbing` 的最终封装迁移到 `export-service`，`/dub` 契约与自动化/队列调用保持不变。

---

## 执行结果（2026-11-05）

- Task 1–10 的实施与验证步骤全部完成；Task 1–7 的「Commit」步骤按用户要求未执行，改动保持未提交。
- 全量验证：后端 `npm test` 703/703、`npm run build`、`npm run test:structure` 61/61、`npm run drift` 123 PASS / 0 FAIL；前端 `npm run build` 与全部前端测试 237/237；浏览器只读冒烟通过。
- 阶段 5 完成后，配音工作台五阶段（台词、音色、生成、混音、导出）全部落地；V3-G5 验收仍待用户执行。
- 2026-11-05 独立审查后修复：无声/无音轨合片不再作为原声床、同集并发启动 409、先合片后编译计划、字幕设置进入复用键、非当前导出不覆盖字幕、运行中禁止删除、pending 恢复、取消贯穿合片/响度/校验、导出检查就绪语义、前端卸载守卫与剧集切换收口、`vertical-high` 硬字幕降级、复用提示与混音下载；定向 29/29 + 结构 6/6，全量后端 710/710、前端 238/238、typecheck/build/structure/drift 全部通过。
- 2026-11-05 已提交 `466daf7`，并完成 macOS 双架构 dmg/zip 打包；arm64 安装到 `/Applications/HuobaoDrama.app`（4.0.10，未启动）。
