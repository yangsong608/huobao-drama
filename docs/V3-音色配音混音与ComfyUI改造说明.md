# V3 音色、配音、混音与 ComfyUI 双模式改造说明

- 日期：2026-11-04
- 状态：A/B/C 已完成并验证；D 待实施
- 依据：11-04 需求 + 当前代码审计（行号为改动前基线）

## 一、结论摘要

| 顺序 | 模块 | 问题定性 | 目标 |
|---|---|---|---|
| A | 静音原声 | P0 缺陷 | 选择「静音原声」后成片必须真正无原声；剧集静音模式对配音/合片全程生效 |
| B | 音色分配 | 能力已有、入口与资产化不足 | 音色提示词卡片化、可编辑、可复用、可逐句分配 |
| C | 混音 | 固定三轨、不可视化编辑 | 环境声/音效轨、多音色语音轨、时间段合成与试听 |
| D | ComfyUI | 仅有单任务占位符替换 | 原生/工作流双模式、整集 timeline 映射、下载后进入拼接导出 |

依赖关系：A 独立；B 的逐句音色是 C 多语音轨的基础；C 的轨道模型为 D 的整集工作流提供干净的音频输入；D 最后做，避免与 A/B/C 的素材、分镜数据反复返工。

---

## 二、现状与根因

### 2.1 音色分配

**当前分配链路**

1. 台词行显式 `voice_id`（`storyboard_lines.voice_id`）。
2. 否则取角色当前激活音色（`character_voices.is_active`）。
3. 旁白行回落到 `dramas.narrator_voice_id`。
   - `backend/src/services/voice-profile.ts:272-298`（`resolveVoiceForLine`）
   - 激活写回：`backend/src/services/voice-profile.ts:153-177`
4. 台词更新接口已支持 `voice_id`：`backend/src/routes/lines.ts:121,141`。

**音色提示词生成链路**

- `voice_designer` 的默认规则要求 LLM 输出 `voice_prompt`（中文 60–120 字）、`design_instruct`（英文 VoiceDesign）、`sample_text`、情绪、语速：
  `backend/src/services/voice-design.ts:58-82`
- 无 LLM 时按角色文本推断性别/年龄生成模板：`backend/src/services/voice-design.ts:90-106`
- 批量生成：`generateVoiceProfiles`（183-235）；落库/激活：`applyVoiceProfiles`（273-401）
- 已有激活音色时跳过并复用：`voice-design.ts:342-346`；首个档案自动激活。

**已有 UI**

- 角色音色面板：`frontend/app/components/VoiceProfilePanel.vue`，提示词与英文指令藏在「高级」折叠区（74-105），可编辑但不可见。
- 配音工作台音色卡片：`frontend/app/components/DubbingStage.vue:128-220`，只显示名称/状态/试听/重新生成；不能切换版本、看不到提示词、不能复制给其他角色。
- 台词列表：`frontend/app/components/LineList.vue` 无逐句音色选择。

**结论**

- 有提示词生成，但没有像资产制作那样「卡片即资产」：提示词不可见、不可复制、不可跨角色复用。
- 复用只发生在「同一角色已有激活版本」；没有项目级音色池。
- 逐句分配后端已具备，前端缺入口。

### 2.2 静音原声（P0）

用户选择的是配音工作台的「静音原声」，对应 `originalAudio='mute'`（`frontend/app/locales/zh.json:1404`）。

**根因 1：mute 不是 0**

`backend/src/services/audio-mix.ts:205`：

```ts
const bedVolume = options.originalAudio === 'mute' ? 0.03 : ...
```

−30 dB 只是「很小」，不是静音；后续 `amix` 与 `loudnorm`（225-230）会把残余原声重新抬起来。

**根因 2：剧集静音模式没有传入配音**

- 配音混音的原声策略来自请求或应用默认值 `duck`：`backend/src/routes/dubbing.ts:44`、`backend/src/services/dubbing.ts:414`。
- 剧集 `video_audio_mode='silent'` 只影响视频生成（`frontend/app/views/drama/episode.vue:3941-3953`），没有映射到 `originalAudio='mute'`。

**根因 3：合片/缓存不感知音频模式**

- 普通合片固定保留音轨并做逐段 loudnorm：`backend/src/services/ffmpeg-merge.ts:282-320`，最终 concat 仍带 `-c:a aac`（151-160）。
- 混音缓存 `sourceHash` 只含 `originalAudio` 等选项：`backend/src/services/dubbing.ts:348-366`；剧集模式变化不会触发重算。
- `ensureMergedVideo` 只看时长是否一致：`backend/src/services/dubbing.ts:139-167`，模式切换后仍复用旧成片。

**根因 4：云端模型可能忽略音频开关**

- MiniMax 适配器把 `audio_mode` 作为扩展字段发送：`backend/src/services/adapters/minimax-video.ts:140-142`，但厂商若不支持则仍返回带原声的视频。
- 本地 shim 的 silent 已做到「不接 audio 输入」：`local-h3/scripts/shim.py:151-181,527-530`；云端没有等价的强制保证。

### 2.3 混音

- 固定输入：视频原声、对话轨、可选 BGM：`backend/src/services/audio-mix.ts:284-296`。
- 对话轨把所有台词按 `adelay` 拼成一条：`audio-mix.ts:146-201`。
- 音量 → sidechain → BGM ducking → `amix weights=1 0.9 1.35` → `alimiter + loudnorm`：`audio-mix.ts:203-232`。
- BGM 仅本地曲库单曲循环：`backend/src/routes/bgm.ts:17-60`。
- 时码由分镜时长自动排布，`atempo ≤ 1.12`：`backend/src/services/timeline.ts:41-58,81-194`。
- 预览只支持整片播放与字幕定位：`frontend/app/components/SubtitlePreview.vue:4-30,85-94`。

**缺口**

- 没有环境声/音效轨；没有多轨独立音量、静音、独奏。
- 没有轨道时间段编辑（起止时间、淡入淡出、循环）。
- 没有「指定时间段合成/试听」。
- 没有「输入文本 + 选音色 → 生成一条额外语音轨」。
- 逐句音色虽然后端支持，但整条对话轨混在一起，无法按角色单独调音。

### 2.4 本地 ComfyUI

**现状**

- 适配器只做 API 格式工作流的 `__TOKEN__` 替换：`backend/src/services/adapters/comfyui.ts:49-88`；视频 token 见 `comfyui-video.ts:42-88`。
- 一次任务提交一条工作流，输出经 `/history` 提取 `/view` URL：`comfyui.ts:148-213`。
- 设置页只有一个工作流文本框与输出节点配置：`frontend/app/pages/settings.vue:1200-1240`。
- E12 是实验脚本/图，不在应用链路内：
  - `local-h3/experiments/README.md:37,48-51`
  - `local-h3/workflows/scripts/hb_e12.py:22-83`
  - `local-h3/workflows/graphs/02_single_timeline_3seg_8step_1024x576.json`
- 本地 shim 仍是固定单段图：`local-h3/scripts/shim.py:493-548`。
- 视频制作只有「资产 / 视频」两个 tab：`frontend/app/views/drama/episode.vue:1719-1721,2823-2826`。

**缺口**

- 没有「原生模式 / ComfyUI 工作流模式」切换。
- 没有整集 `segments[] / timeline_data` 映射：分镜、参考图、提示词、时长、音频策略都无法批量进工作流。
- 没有工作流模板库与字段绑定配置。
- 没有 ComfyUI 页面入口、执行进度、产物下载到本地拼接/导出。
- 右侧重绘面板仍是单镜生成表单，不能显示工作流。

---

## 三、总体设计原则

1. **剧集音频模式是最终权威**：`episodes.video_audio_mode` 决定生成与成片原声；配音工作台的手动原声策略只在非 silent 时生效。
2. **生成音频与成片原声分开命名**：生成阶段叫「生成音轨策略」，混音阶段叫「成片原声策略」，避免同一个「静音」出现两种含义。
3. **向后兼容**：未设置新字段时保持现有行为；`auto` 仍按 `native` 处理。
4. **可验证**：每条改动先写失败测试，再实现；ffmpeg 产物用 ffprobe 断言流与响度，不只测字符串。
5. **不改变项目不变量**：端口 5679/3013 不动；MCP 工具数保持 61；`TEMPLATE_VERSION` 保持 6；V3-G5 不标记通过；未获指示不构建/安装/重启应用。

---

## 四、Phase A：静音原声与合片失效（P0）

### A1. 混音图真正静音

- `buildMixGraph`：`mute` 时床音轨改为 `volume=0`，不再进入 sidechain；保留 `[bed]` 参与 `amix` 以维持滤镜图结构。
- 断言：输出图中出现 `volume=0`，不出现 `volume=0.03`。
- 保留 `loudnorm`：床为数字零时不会产生原声；有台词时仍按目标响度归一。

### A2. 剧集 silent 强制覆盖配音原声

- `dubbing` 启动时读取剧集 `video_audio_mode`：
  - `silent` → 强制 `originalAudio='mute'`，忽略请求/默认值；
  - `native` / `ambient` / `auto` → 维持现有 `keep/duck/mute` 选择。
- `sourceHash` 增加 `audioMode`，模式变化必须导致重新混音。
- 前端配音混音卡片显示「跟随剧集：静音（不可改）」，并禁用下拉，避免用户以为可改。

### A3. 合片与导出遵守 silent

- `mergeEpisodeVideos` 读取剧集模式；`silent` 时：
  - 逐段统一画布，但输出不带音轨（`-an`，只保留视频流）；
  - 不走 `acrossfade` / 逐段 loudnorm。
- 普通合片记录写 `sourceHash`（镜头列表 + 时长 + 音频模式）；`ensureMergedVideo` 比对当前模式的 hash，不一致则重新合片。
- 已有成片不清除，只在新合片/导出时替换，避免破坏历史产物。

### A4. 云端 silent 产物兜底去音轨

- 视频任务下载完成后，若任务参数 `audioMode === 'silent'` 且文件有音频流：
  - 用 ffmpeg `-c:v copy -an` 生成临时文件并原子替换；
  - 失败则任务标记 `delivery_failed`，不静默吞掉。
- 本地 shim 已是无音轨输出，此步骤幂等。

### A5. UI 语义与生效提示

- 剧集顶栏「生成音轨策略」保持不变；切换后提示「对后续生成/合片/混音生效」。
- 配音工作台原声下拉在 silent 下锁定并显示来源。
- 四语言文案同步。

### A6. 验收

- 单元：`buildMixGraph` mute 图为 `volume=0`。
- 集成：带正弦波原声的视频 + 静音混音 → 输出音轨 RMS 为 0（或低于数字噪声阈值）。
- 合片：silent 模式合片产物 ffprobe 无 audio stream。
- 缓存：切换 `auto ↔ silent` 后 `sourceHash` 变化，触发重新合片/混音。
- 云任务：模拟带音轨下载 → silent 任务产物无 audio stream。

---

## 五、Phase B：音色资产化

### B1. 新增「音色」资产 tab

- 视频制作区新增 tab：`资产 | 音色 | 视频`（顺序可按现有信息架构微调），复用 `prodTabDefs`。
- 卡片即音色资产，每张卡显示：
  - 角色/旁白、音色名、激活状态、`gender/age_range/emotion/speed`；
  - `voice_prompt` 中文提示词（默认展开，可编辑）；
  - `design_instruct` 英文指令（折叠）；
  - 试听按钮、状态、失败原因、最近使用；
  - 操作：生成/重新生成、设为当前、复制给其他角色、删除。
- 旁白单独一组卡片，与角色卡同构。

### B2. 提示词生成与编辑前置

- 「AI 生成音色提示词」成为卡片主动作，不再藏在高级折叠。
- 编辑 `voice_prompt` / `design_instruct` 后保存到 `character_voices`，重新试听即生效。
- 批量生成保留，但逐角色展示生成结果与失败原因。

### B3. 复用池

- 不做跨项目全局市场，先做**项目级复用**：
  - `POST /voices/:id/clone`，参数 `character_id | scope=narrator`；
  - 复制 `voice_prompt / design_instruct / external_voice_id / ref_audio_url / gender / age_range / speed / emotion`，生成新版本并可选激活；
  - 源音色与目标音色各自独立版本，互不影响。
- 卡片上提供「复制给…」选择器，满足「复用资产制作中已经生成的音色」。

### B4. 逐句音色分配

- `LineList` 每行增加音色下拉：
  - 选项：`自动（角色当前音色）`、该角色全部版本、旁白音色、项目其他音色（标记来源角色）；
  - 写入 `storyboard_lines.voice_id`，复用现有 `PUT /lines/:id`。
- 批量操作：选中多行 → 统一分配音色。
- 显示提示：所选音色不属于该行角色时标黄，但允许使用（反串/特殊效果）。

### B5. 验收

- 角色卡可见提示词并保存成功。
- 复制音色到另一角色后，新角色可试听且不改变源角色。
- 逐句选择音色后合成，产物音色与目标一致（人工试听 + 任务参数断言）。
- 无音色/失败状态有明确入口与错误信息。

---

## 六、Phase C：多轨混音与时间段合成

### C1. 数据模型

新增两张表（SQLite 迁移，保持旧数据可读）：

`episode_audio_tracks`

| 字段 | 说明 |
|---|---|
| id / episode_id / drama_id | 归属 |
| kind | `bgm` / `ambience` / `sfx` / `voice` |
| name | 轨道名 |
| volume | 0–2 |
| muted / solo | 开关 |
| ducking | 是否被台词侧链压低 |
| loop | 是否循环 |
| order | 显示顺序 |
| created_at / updated_at | 时间 |

`episode_audio_clips`

| 字段 | 说明 |
|---|---|
| id / track_id / episode_id | 归属 |
| start_ms / end_ms | 在成片中的时间段 |
| source_start_ms | 素材内起点 |
| fade_in_ms / fade_out_ms | 淡入淡出 |
| source_url | 素材地址 |
| text / voice_id / audio_url / status | `voice` 轨的生成信息 |
| line_id | 可选，绑定台词行 |

台词时间覆盖：`storyboard_lines` 增加可空 `voice_start_ms / voice_duration_ms`；未设置时继续按现有分镜时长自动排布。

### C2. 后端混音引擎

- 将 `buildMixGraph` 泛化为 N 轨：
  - 输入 0 视频床（silent 时为数字零或省略）；
  - 输入 1 对话轨；
  - 输入 2..N 为各音频轨，按 `atrim + adelay + volume + afade` 排布；
  - 循环轨先用 `aloop`/临时文件裁到目标时长，避免 ffmpeg 等 EOF；
  - 每轨可按 `ducking` 决定是否进入 sidechain；
  - `amix` 权重按轨道音量计算，最后 `alimiter + loudnorm`。
- 兼容旧调用：无新轨时生成与当前完全一致的图。

### C3. 时间段合成与试听

- 每段 clip 可拖拽/输入 `start_ms/end_ms`，支持吸附到台词 cue。
- 新增范围试听：
  - 前端用多 `<audio>`/WebAudio 按轨道同步播放，支持 solo/mute/音量；
  - 后端 `POST /episodes/:id/audio/preview` 按范围渲染一段临时 mp3/wav，保证与最终混音一致（用于精调）。
- 最终「混音导出」使用同一套轨道数据，避免试听与成片不一致。

### C4. 背景声/环境声来源

- 第一版来源：
  - 本地素材上传（音频文件）；
  - BGM/环境声曲库（按 `ambience` 分类）；
  - 从视频原声截取（可选，后续）。
- 明确边界：当前没有「文本生成环境声」的音频生成模型，第一版不做假接口；若后续接入音效生成服务，只需新增一个 `source_url` 生产者。

### C5. 多音色语音轨

- 「新增语音轨」对话框：输入文本、选择音色（项目音色池）、时间段、情绪/语速。
- 调用现有 TTS 合成到项目音频目录，写入 `episode_audio_clips`，状态 `pending → ready/failed`。
- 支持同一时间段多条语音轨，按轨道音量混音；台词轨仍可逐句分配音色。

### C6. 验收

- 新增环境声轨后，最终成片包含该轨；solo 时只听该轨。
- 10–20 秒范围试听与最终导出该范围一致（时长误差 < 100ms）。
- 两条语音轨 + 台词 + BGM + 原声床可同时混音，无削波（alimiter 生效）。
- 旧项目无新轨时混音结果与改造前一致（回归）。

---

## 七、Phase D：ComfyUI 原生/工作流双模式

### D1. 模式与入口

- `episodes` 增加：
  - `video_mode`：`native | comfyui`，默认 `native`；
  - `comfyui_config_id`：可空，ComfyUI 视频配置；
  - `comfyui_workflow_json`：可空，本集工作流快照。
- 视频制作区新增模式 tab：`原生工作流 | ComfyUI 工作流`。
  - 原生：保持一镜一次生成。
  - ComfyUI：选择配置、加载工作流、整集提交。
- 顶部视频模型选择在 ComfyUI 模式下切换为 ComfyUI 配置选择，继续写回 `video_config_id` 或 `comfyui_config_id`（二选一，按模式）。

### D2. 工作流模板与映射

- 设置页 ComfyUI 配置增加 `timeline_mapping`（JSON）：
  - `mode: "placeholder"`：兼容现有 `__TOKEN__` 单任务模式；
  - `mode: "timeline"`：整集时间线模式。
- `timeline` 映射字段：
  - `node` / `input`：写 `timeline_data` 的节点与输入名（E12 为 `6 / timeline_data`）；
  - `fps` / `width` / `height` / `steps` 等图参数；
  - `segmentTemplate`：每段如何取 `prompt / negativePrompt / frames / refs`；
  - `output`：SaveVideo 节点与产物类型。
- 提供 E12 等价的默认模板（MiniMaxH3 单 timeline 多段），用户可粘贴自己的 API 格式工作流并绑定节点。

### D3. 分镜 → 工作流映射

- 保留分镜拆分；每个分镜生成一个 segment：
  - `prompt`：复用本地 H3 提示词编译器（英文、去字幕风格词）；
  - `frames`：`duration * fps`，对齐帧网格；
  - `refs`：角色/场景/道具参考图上传到 ComfyUI，按 `<Picture N>` 规则编号；
  - `negativePrompt`、`seed`、分辨率、宽高比、音频策略进入图参数；
  - `start` 累计，生成完整 `timeline_data`。
- 右侧重绘面板在 ComfyUI 模式下改为：
  - 工作流只读视图（节点/连接/关键输入）；
  - 当前分镜在 timeline 中的 segment 高亮；
  - 「打开 ComfyUI」入口；
  - 「按工作流重跑整集」按钮。
- 分镜列表、增删改、排序仍可用；修改后重新生成映射。

### D4. 提交、轮询、下载、拼接

- 新增 `POST /episodes/:id/comfyui/run`：
  - 构建并校验工作流 → `/prompt` 提交；
  - 记录 `sys_task` / 作业状态，复用任务抽屉进度；
  - 轮询 `/history`，失败时回传节点级错误；
  - 下载 `/view` 产物到项目 `videos/comfyui` 目录；
  - 若工作流输出整集单文件：登记为成片候选，进入导出列表；
  - 若输出多段：按 segment 顺序 ffmpeg 拼接后登记，复用 Phase A 的 silent 规则。
- 任务清理、恢复、失败重试沿用现有生成任务机制。

### D5. ComfyUI 页面

- 桌面端新增独立窗口加载配置的 ComfyUI 地址（Electron `BrowserWindow`），不把外部页面塞进主应用 DOM，避免破坏路由与安全边界。
- Web 端使用新标签页打开。
- 第一版只做「查看/编辑工作流 + 应用内提交已配置模板」；ComfyUI 页面内改动回写应用工作流快照作为后续增强，不在本轮承诺双向同步。

### D6. 原生模式优化

- 以 E12 结论优化本地 shim 单镜图：
  - 8 步 turbo、24fps 帧网格、默认 1024×576（按项目比例）；
  - 角色卡参考图 + `<Picture N>` 点名，避免多人同脸；
  - 英文提示词、负面词，中文正文不进提示词，减少烧字幕；
  - 音频指令按 `native/ambient/silent` 覆盖；
  - 首帧/尾帧与上一镜连续性保持现有能力。
- 每镜仍单次提交；不改变原生模式的交互。

### D7. 验收

- 切换 ComfyUI 模式后，分镜仍可拆分/排序/编辑。
- 整集提交生成一份 `timeline_data`，segment 数 = 分镜数，提示词/参考图/时长与界面一致。
- 工作流执行成功 → 产物下载到本地 → 出现在拼接/导出列表。
- 节点错误在任务抽屉可读，不泄露密钥/公网地址。
- 切回原生模式，原有一镜一次生成不受影响。

---

## 八、实施顺序与门禁

| 阶段 | 交付 | 必须通过 |
|---|---|---|
| A | mute=0、silent 贯通、合片去音轨、缓存失效、云产物兜底 | 后端单测 + ffprobe 集成 + 前端结构测试 |
| B | 音色 tab、卡片、提示词、复制池、逐句音色 | 后端路由测试 + 前端结构测试 + 四语言键 |
| C | 轨道表、N 轨混音、时间轴编辑、范围试听、语音轨 | 混音集成测试 + 前端交互冒烟 |
| D | 模式 tab、timeline 映射、整集执行、下载/拼接、ComfyUI 窗口 | 适配器单测 + 映射快照测试 + 端到端执行 |

每阶段完成后：

1. 运行后端测试（Node 22.16.0，隔离 `SQLITE_PATH`）。
2. 运行前端测试/结构测试（Node 24.21.0）。
3. 更新 `docs/V3-执行日志.md` 与 `docs/v3-state.json`。
4. 不自动构建/安装；需要桌面包时另行确认。

---

## 九、风险与回滚

| 风险 | 处理 |
|---|---|
| 混音图重构影响旧成片 | 保留旧路径；新增轨道为空时走原图；全量回归 |
| silent 去音轨导致部分播放器异常 | 输出仍为 mp4 视频流；ffprobe 校验；保留历史产物 |
| 工作流任意节点/自定义节点不可用 | 提交前静态校验 + 节点错误原文回传；不自动重试未知副作用 |
| 整集生成耗时长/超时 | 复用任务轮询；下载超时与重试；不阻塞主进程 |
| 分镜映射与用户自定义图不匹配 | 映射配置显式节点/输入；提供 E12 默认模板；错误指出缺失绑定 |
| 音色复制造成版权/误用 | 仅项目内复制；保留源音色标识；不引入外部市场 |

---

## 十、明确不做（本轮）

- 不标记 V3-G5 通过；不改变 61 个 MCP 工具；不改 `TEMPLATE_VERSION=6`；不动 5679/3013 端口。
- 不自动构建、安装、重启桌面应用。
- 不引入云端「文本生成环境声/音效」模型；第一版只做素材库、上传与语音合成轨。
- 不做 ComfyUI 页面与应用的实时双向工作流同步（第一版为打开页面 + 应用内模板执行）。
- 不做跨项目音色市场与账号体系。

---

## 十一、实施与验证（A/B/C/D 已完成，2026-11-04）

### 11.1 Phase A：静音原声

- `backend/src/services/audio-mix.ts`：`mute` 时床音轨 `volume=0`，且与 `keep` 一样跳过 sidechain，仅保留 `amix` 结构；`loudnorm` 保留。
- `backend/src/services/video-audio.ts`：新增 `resolveDubbingOriginalAudio`，剧集 `video_audio_mode=silent` 时强制 `mute`，优先于请求与设置默认值。
- `backend/src/services/dubbing.ts`：
  - 配音启动读取剧集音频模式，`sourceHash` 增加 `audioMode`、台词时间覆盖与音轨签名；
  - `ensureMergedVideo` 用 `computeMergeSourceHash(镜头, audioMode)` 比对缓存，模式或镜头变化即重新合片。
- `backend/src/services/merge-plan.ts`：新增 `computeMergeSourceHash`。
- `backend/src/services/ffmpeg-merge.ts`：`silent` 走独立合片路径 `mergeSilentVideos`，`-an` 只输出视频流、不做逐段 loudnorm / acrossfade；合片记录写 `sourceHash` 与 `mixOptions.audioMode`。
- `backend/src/services/generation.ts` + `backend/src/utils/video-audio-track.ts`：云端视频落盘后若任务为 `silent` 且存在音频流，用 ffmpeg `-c:v copy -an` 临时文件原子替换。
- 前端：`DubbingStage.vue` 在剧集 silent 时锁定原声下拉与 ducking 滑杆并显示来源提示；补充四语言 `workbench.originalAudioSilentLocked`。
- 测试：`audio-mix.test.ts`（mute 图为 `volume=0`）、`video-audio-mode.test.ts`（silent 覆盖）、`video-silent-audio.test.ts`（合片/产物去音轨与缓存失效）、`silent-audio-lock-structure.test.mjs`（前端锁定）。

### 11.2 Phase B：音色资产化

- `backend/src/services/voice-profile.ts`：新增 `cloneVoice`，仅在同一项目内复制音色字段并生成独立新版本，默认激活目标角色/旁白，不改源音色。
- `backend/src/routes/voices.ts`：新增 `POST /voices/:id/clone`（`character_id | scope=narrator`、`activate`、`name`）。
- `backend/src/routes/lines.ts`：`voice_id` 校验存在且同项目；文本或音色变化即清空旧合成并置 `pending`；支持 `voice_start_ms` / `voice_duration_ms`。
- 前端：
  - 新增 `VoiceAssetGrid.vue` / `VoiceAssetFields.vue`：角色/旁白分组卡片，展示并编辑 `voice_prompt`、`design_instruct`，支持版本切换、试听、激活、复制给其他角色/旁白、批量生成。
  - `episode.vue` 制作区 tab 改为 `资产 | 音色 | 视频`。
  - `LineList.vue` 每行音色下拉（自动/本角色/旁白/项目其他音色），跨角色标黄提示。
  - `DubbingStage.vue` 增加选中台词批量分配音色；`useDubbingSession.ts` 暴露 `allVoiceOptions` 与 `assignVoiceToLines`。
- 测试：`voice-reuse-line-assignment.test.ts`（复制隔离、逐句/批量分配、跨角色校验）、`voice-asset-cards-structure.test.mjs`（卡片、字段、tab 与四语言键）。

### 11.3 Phase C：多轨混音与时间段合成

- 数据模型：新增 `episode_audio_tracks`、`episode_audio_clips`，台词表增加可空 `voice_start_ms` / `voice_duration_ms`；旧库自动补列。
- 后端：
  - `backend/src/services/audio-tracks.ts`：轨道/片段 CRUD、solo/mute 语义、项目内 `source_url` 校验、`createVoiceClip` 调用现有 TTS 落库、`collectMixTracks` 输出签名。
  - `backend/src/services/audio-mix.ts`：`buildExtraTrackAudio` 逐片段 `atrim + afade` 渲染、循环轨 `-stream_loop -1`、整轨 `adelay/apad` 拼装；新增 `buildMixGraphWithTracks`（原声床 + 对话 + BGM + N 条附加轨，`amix normalize=0` → `alimiter` → `loudnorm`）；新增范围渲染。
  - `backend/src/services/dubbing.ts`：混音接入轨道签名；新增 `renderRangePreview`（只出音频、按时间段裁切、对话轨缓存、保留最近 3 份）。
  - `backend/src/routes/audio-tracks.ts`：`/episodes/:id/audio/tracks|clips|voice-clips|preview|summary`。
  - `backend/src/services/timeline.ts`：手动起点不再被 atempo 压缩；手动台词溢出按整集片尾计算；末句裁切改用对象身份判断。
- 前端：
  - 新增 `AudioMixBoard.vue`：轨道头（类型/名称/音量/M/S/Duck/Loop/删除）、片段条（位置/宽度/选择/试听）、片段编辑（起止/淡入淡出/删除）、BGM 曲库添加、语音轨生成、时间段试听。
  - `useApi.ts` 新增 `EpisodeAudioTrack` / `EpisodeAudioClip` / `audioTrackAPI`；`useDubbingSession.ts` 暴露 `timelineTotalMs`；`DubbingStage.vue` 在预览与混音卡片下方挂载音轨板。
- 测试：`audio-tracks.test.ts`（路由/服务/混音图/试听/签名）、`audio-mix.test.ts` 扩展 N 轨图、`timeline.test.ts` 修正手动排布语义、`audio-tracks-structure.test.mjs`（前端接线与四语言键）。

### 11.4 Phase D：ComfyUI 原生/工作流双模式

- 数据层：`episodes` 新增 `video_mode`、`comfyui_config_id`、`comfyui_workflow_json`；`GET/POST/PUT /episodes` 全量透传，旧库自动补列。
- 映射层（`backend/src/services/comfyui-timeline.ts`）：
  - `readComfyTimelineMapping` 读取配置 `settings.timeline_mapping`，仅 `mode=timeline` 启用；支持 node/input/fps/width/height/steps/ref_max_size/negative_prompt/task_type/timeline_mode/frame_grid/segment_template/output，缺省回退 E12（节点 6 / timeline_data、24fps、1024×576、8 steps、17n+5）；
  - 分镜 → segment：refs 按场景 → 角色 → 道具去重排序（最多 6 张），`@角色名` 重写为 `<Picture N>`，提示词走本地 H3 编译器；帧数按 17n+5 对齐，start 累加；
  - `materializeComfyTimelineData` 生成 version 4 的 `timeline_data`，兼容 segment 字段重命名。
- 执行层（`backend/src/services/comfyui-episode.ts`）：
  - 配置解析顺序：显式 `config_id` → 集 `comfyui_config_id` → 集 `video_config_id`（仅 ComfyUI）→ 最高优先级启用 ComfyUI 配置；工作流优先本集快照，未保存跟随配置；
  - 预览只做确定性编译，不调用翻译模型，秒开并提前校验节点结构；
  - 提交前拒绝同集重复的整集任务；参考图上传到 ComfyUI 后写入真实文件名；执行结果沿用视频任务轮询；
  - 多文件输出按 segment 顺序拼接，成片登记到 `video_merges.kind='comfyui'`，进入导出列表；恢复逻辑从持久化 `resultUrls` 继续，不重复提交。
- 路由：新增 `GET /episodes/:id/comfyui/workflow`、`POST /episodes/:id/comfyui/run`；`GET /episodes/:id/generation-tasks` 能识别整集任务。
- 前端：
  - 制作区新增 `原生逐镜 | ComfyUI 工作流` tab，模式写入 `episodes.video_mode`；
  - 顶部视频模型选择按模式过滤配置：ComfyUI 模式只列 ComfyUI 配置，写 `comfyui_config_id`；原生模式只列非 ComfyUI 配置，写 `video_config_id`；分辨率选择在 ComfyUI 模式隐藏；
  - ComfyUI 模式下隐藏逐镜播放器、历史、批量与重试；右侧改为工作流面板：节点数、配置名、分段/帧数/时长/分辨率、时间线与输出节点、映射来源、分镜 segment 列表（点击联动选中分镜）、警告、「打开 ComfyUI / 提交整集」；
  - 整集任务在任务抽屉标记「整集生成」；逐镜生成入口在 ComfyUI 模式给出提示并拦截。
- 原生模式：保持一镜一次生成与现有本地 H3 链路（8 步、17n+5、英文提示词、参考图排序、音频指令），本轮未改变逐镜交互；ComfyUI 模式仅新增整集路径。
- 与设计的偏差：ComfyUI 页面未新建 Electron `BrowserWindow`，改为 `window.open`，由桌面端现有外链拦截转 `shell.openExternal` 用系统浏览器打开；仍不把外部页面嵌入主应用 DOM。
- 测试：`comfyui-timeline.test.ts` 5/5、`comfyui-episode.test.ts` 8/8、`provider-media-adapters.test.ts` 10/10、`episode-comfy-mode-structure.test.mjs` 6/6（前端）；原视频配置结构测试已更新为双模式契约。

### 11.5 验证结果

- 后端（Node 22.16.0）：`npm test` **466/466**；`npm run test:structure` **61/61**；`npm run typecheck` 通过；`npm run drift` **123 PASS / 0 WARN / 0 FAIL**。
- 前端（Node 24.21.0）：`node --test tests/*.test.mjs` **190/190**；修改的 SFC 通过 `@vue/compiler-sfc` 解析/编译校验。
- 已执行 `nuxt generate`（Node 24.21.0）与 `desktop npm run dist`，均退出码 0；arm64 dmg 174,214,137 bytes，已安装 `/Applications/HuobaoDrama.app`（4.0.10、`TEMPLATE_VERSION=6`），按用户要求安装后未启动。
- 约束保持：MCP 61、`TEMPLATE_VERSION=6`、端口 5679/3013 未动、V3-G5 仍 pending。
- 已知边界：范围试听与最终导出共用同一混音图，但尚未做「试听 vs 成片」波形级自动化比对；环境声/音效仅支持上传与曲库，不接文本生成音效。
