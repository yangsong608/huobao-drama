# V3 AI 过渡片段设计方案

> 目标：在现有「拼接导出」流程中，为相邻镜头生成 AI 过渡片段。过渡片段的**首帧 = 上一镜视频的尾帧**，**尾帧 = 下一镜视频的首帧**，再把过渡片段插入两个镜头之间参与合片。
>
> 本文以设计方案为主，不含完整实现代码；2026-11-05 的「视觉分析首尾帧生成提示词」增量已在 §7.3 与 §10.6–10.7 记录实现口径。验收标准与测试计划见 §13、§16。

## 0. 结论摘要

1. **不改造分镜生成语义**。过渡片段是独立产物，不能写入 `storyboards.video_url`，否则会把原镜头覆盖掉。
2. **两阶段流程**：先「生成过渡」（每个断点一条）→ 再「拼接导出」。拼接只消费已就绪的过渡片段；缺失、失败、过期的一律回退到原有的 `cut/fade/dissolve/wipe`，绝不让合片失败。
3. **新增 `video_transitions` 表**，每条记录绑定一个「上一镜 → 下一镜」断点；生成任务通过 `sys_task.transition_id` 关联。
4. **首尾帧从成片视频中抽取**，不直接拿分镜参考图，保证和最终镜头画面一致。
5. **能力按模型判断**：Wan 3.0、Seedance 2.0、Seedance 1.x i2v、MiniMax H3（云/本地）、ComfyUI 可用；Wan 2.x 当前适配器不支持尾帧。
6. **时长放宽**：默认目标 3 秒，允许 2/3/4/5 秒预设。不同厂商有最小/固定/网格时长，UI 显示「请求时长」与「有效时长」，不强制二次压缩。
7. **复用现有导出页与合片弹窗**，不新增页面、Tab 或平行面板。
8. **生成与拼接分离**：拼接请求不负责等待数分钟的生成任务；生成进度由过渡列表单独轮询，避免合片任务长时间挂起。
9. **提示词由视觉模型分析首尾帧生成**：默认把上一镜尾帧、下一镜首帧两张图交给当前文本模型（需支持视觉）分析，产出可提交的视频提示词；用户可在断点行内编辑、重新分析、按新提示词重生成。视觉分析失败时回退到 §7.3 的文字模板继续生成，并在界面标注来源。

---

## 1. 背景与目标

### 1.1 问题

现有导出页按分镜顺序直接拼接镜头视频。相邻镜头即使在同一场景，也常出现：

- 画面机位、人物姿态、光线不连续；
- 硬切造成空间跳跃；
- 用户手动设置 `fade/dissolve/wipe` 只能掩盖 120–500ms，无法补足中间过程。

### 1.2 目标

- 为每个相邻镜头断点生成一条 2–5 秒左右的过渡视频；
- 过渡视频的第一帧严格使用上一镜尾帧，最后一帧严格使用下一镜首帧；
- 过渡片段可预览、重试、跳过；
- 合片时自动插入过渡片段，并保留原有回退能力；
- 适配火宝聚合网关、豆包/火山、阿里云百炼、本地 H3 + ComfyUI；
- 复用现有 UI，不改变用户已有的分镜生成和合片习惯。

### 1.3 非目标

- 不做镜头重拍、补帧、超分辨率；
- 不做音频驱动口型；
- 不在本期内做「一键生成并自动拼接」的长任务编排（可作为后续增强）；
- 不为 Wan 2.x 增加首尾帧适配（Wan 2.2 kf2v 可作为后续专项）；
- 不修改用户已选的模型、服务配置或项目存储目录。

---

## 2. 现状与改造点

### 2.1 拼接导出

关键代码：

- 导出页：`frontend/app/views/drama/episode.vue`
  - 成片列表与镜头素材：约 1006–1145 行；
  - 合片标题弹窗：约 1639–1667 行；
  - `openMergeDialog/confirmMerge/doMerge`：约 4284–4326 行；
  - 分镜转场字段：约 664–672 行。
- 合片路由：`backend/src/routes/merge.ts:12` `POST /episodes/:id/merge`。
- 合片服务：`backend/src/services/ffmpeg-merge.ts:32` `mergeEpisodeVideos`、`:99` `doMerge`。
- 转场滤镜图：`backend/src/services/merge-plan.ts:38` `buildMergeTransitionGraph`。
- 合片缓存键：`backend/src/services/merge-plan.ts:90` `computeMergeSourceHash`。

现状：

1. 按 `storyboard_number` 排序，过滤掉没有视频的镜头，得到 `clips = [{ url, transition }]`。
2. `transition` 来自 `storyboards.transition`，支持 `cut/fade/dissolve/wipe`。
3. 有转场时走 `xfade + acrossfade`，单段转场时长 = `min(前, 后) * 20%`，并夹在 120–500ms。
4. 任一段没有音轨时，退回 `concat` 或逐段 `loudnorm`，不会走转场滤镜。
5. `video_merges.scenes` 只保存镜头 URL 数组，没有断点/过渡元数据。

### 2.2 生成任务

关键代码：

- 统一生成：`backend/src/services/generation.ts:139` `generateVideo`；
- 完成回写：`backend/src/services/generation.ts:607` `handleVideoComplete`；
- 任务表：`backend/src/db/schema.ts:263` `sysTask`；
- 参考图归一化：`backend/src/services/generation.ts:800` `normalizeVideoReferenceUrl`。

关键约束：

- `generateVideo` 以 `storyboardId` 为核心做去重和完成回写；
- `handleVideoComplete` 在 `record.storyboardId` 存在时更新 `storyboards.video_url`；
- 如果没有 `storyboardId`，完成回写不会更新任何业务表；
- 因此过渡任务如果复用 `storyboardId` 会覆盖原镜头，必须新增独立的关联字段和完成分支。

### 2.3 适配器

- 首帧/尾帧字段已经贯通：`firstFrameUrl` / `lastFrameUrl`；
- Wan 3.0 使用 `input.media[]` 的 `first_frame/last_frame`；
- Seedance 2.0 使用 `content[]` 的 `image_url` + `role`；
- MiniMax H3 使用 `content[]` 的 `image_url` + `role`；
- ComfyUI 已注入 `FIRST_FRAME` / `LAST_FRAME` / `FRAMES` / `DURATION` 占位符；
- 本地 H3 shim 已支持 `first_frame/last_frame`，帧网格为 `5 + 17k`（24fps）。

### 2.4 需要补齐的缺口

| 缺口 | 影响 | 处理 |
|---|---|---|
| 没有「上一镜尾帧 / 下一镜首帧」抽取 | 无法构造首尾帧 | 新增 `video-frames.ts` |
| `sys_task` 没有过渡关联 | 完成回写无处可写，写 storyboard 会覆盖镜头 | 新增 `transition_id` |
| 没有断点表 | 无法记录状态、时长、回退原因 | 新增 `video_transitions` |
| 合片序列只认识镜头 | 无法插入过渡片段 | 扩展 `MergeClipPlan` 与合片快照 |
| 合片转场时长固定 20% | 过渡片段两端可能被吃掉 | 支持显式 `transitionMs` |
| 合片转场要求所有片段有音轨 | 无声过渡片段会让整段退回 concat | 合片前补静音轨 |
| 能力表没有首尾帧标记 | UI 可能选到不支持尾帧的模型 | 增加 `firstLastFrame` |
| 本地 H3 适配器把时长夹到 4–15s | 无法生成 2–3s 过渡 | 增加过渡模式短时长开关 |
| 旧任务日志可能打印 data URL | 帧内容/base64 进入日志 | 日志脱敏 |

---

## 3. 厂商能力复核

### 3.1 阿里云百炼（Wan）

#### Wan 3.0（`wan3.0-video` / `wan3.0-video-prime`）

官方 API 参考确认：

- `input.media[]` 支持 `type=first_frame` 和 `type=last_frame`，各最多 1 张；
- 首帧/尾帧模式**不能**与 `reference_image/reference_video/reference_audio/file/link` 混用；
- `parameters.duration`：默认 5；无视频输入时为 **2–30 的整数**；传 `-1` 为智能时长；
- `parameters.audio`：默认 `true`，输出视频包含声音；`false` 则无音轨；
- `parameters.resolution`：`480P/720P/1080P`，默认 `1080P`；
- `parameters.ratio`：`adaptive`（默认）/`21:9`/`16:9`/`4:3`/`1:1`/`3:4`/`9:16`。

结论：**Wan 3.0 是最适合做 2–5 秒短过渡的云端模型**，时长可精确到秒，且支持输出音频。

#### Wan 2.2 kf2v（`wan2.2-kf2v-flash`）

官方模型对比确认支持首尾帧，但：

- 时长固定 5 秒；
- 无音频；
- 分辨率 480P/720P/1080P。

当前项目适配器 `backend/src/services/adapters/aliyun-wan-video.ts` 的 Wan 2.x 分支**明确拒绝尾帧**，所以本期不作为可用模型。若要支持，需要新增 kf2v 专用请求分支（`first_frame_url + last_frame_url`，固定 5s，无音频），列为后续增强。

#### 其他 Wan 2.x

- t2v 无首帧；
- i2v 仅首帧；
- 不支持尾帧。

结论：能力表标记 `firstLastFrame=false`。

### 3.2 豆包 / 火山方舟（Seedance）

#### Seedance 2.0（`doubao-seedance-2-0-*`）

官方「创建视频生成任务」文档确认：

- `content[]` 支持 `image_url` + `role=first_frame`、`role=last_frame`；
- 首尾帧模式与多模态参考素材（`reference_image/reference_video/reference_audio`）不能混用；
- 时长范围 **4–15 秒**（本项目适配器按 4–15 处理）；
- `generate_audio` 控制原生音频；官方文档默认值为 `false`，本项目适配器默认显式传 `true`（除非用户选择 silent）；
- 首尾帧模式下 `ratio` 使用 `adaptive`。

结论：可用。最小 4 秒，请求 2/3 秒时有效时长为 4 秒。

#### Seedance 2.5（`doubao-seedance-2-5-*`）

官方已公开，支持 30 秒直出。当前项目的模型能力分支只识别 `doubao-seedance-2-`，会把 2.5 当成 2.0 限制在 15 秒。过渡片段不需要超过 15 秒，本期不阻塞；建议后续补 2.5 的时长分支，避免能力表长期偏差。

#### Seedance 1.x

- t2v：不能传首尾帧；
- i2v：支持 `first_frame` + `last_frame`，时长 2–12 秒；
- 不支持参考视频/音频和原生音频。

结论：i2v 可用，t2v 不可用。

### 3.3 MiniMax H3

#### 云端 H3

- `content[]` 的 `image_url` 支持 `role=first_frame/last_frame`；
- 尾帧必须与首帧同时提供；
- 当前项目适配器时长夹在 4–15 秒；
- 原生音画同步。

结论：可用。最小 4 秒。

#### 本地 H3 shim（`local-h3/scripts/shim.py`）

- `parse_content` 已接受 `first_frame/last_frame`；
- `capabilities()` 返回 `firstLastFrame: true`；
- `FRAME_GRID = [5 + 17*k for k in range(22)]`，24fps；
- `frames_for(duration)` 把请求时长吸附到最近网格点。

对应实际时长：

| 请求 | 网格帧数 | 实际时长 |
|---|---|---|
| 2s | 56 | 2.333s |
| 3s | 73 | 3.042s |
| 4s | 107 | 4.458s |
| 5s | 124 | 5.167s |

当前后端适配器 `backend/src/services/adapters/minimax-video.ts` 的 `normalizeDuration` 对本地 shim 也夹到 4–15 秒。过渡任务必须增加 `allowShortDuration` 开关，绕过 4 秒下限；普通镜头生成不变。

结论：本地 H3 可用，且能生成 2.3 秒级短过渡，是最适合本地部署的路径。

### 3.4 ComfyUI

- 适配器 `backend/src/services/adapters/comfyui-video.ts` 已注入：
  - `FIRST_FRAME` / `IMAGE` / `IMAGE_1`；
  - `LAST_FRAME`；
  - `DURATION` / `FPS` / `FRAMES`。
- 是否真正支持首尾帧取决于用户工作流是否使用 `LAST_FRAME` 占位符。

结论：可用，但必须在提交前检查工作流占位符；没有 `LAST_FRAME` 时给出可操作的错误，不能静默按首帧生成。

### 3.5 火宝聚合网关（Firemux）

设置页快速配置将一把火宝 Key 映射为三个视频配置：

- `/qwen` → 阿里云 Wan 3.0；
- `/volcengine` → 豆包 Seedance 2.0；
- `/minimax` → MiniMax H3。

用户已确认：**火宝聚合网关中各个模型的 API 都提供首尾帧生成视频**。

实现上不需要网关专用字段：现有适配器按 `provider + model` 生成官方请求体，网关按路径转发。需要补一个**网关冒烟测试**，验证三个配置的请求体都包含首帧和尾帧角色，且响应头任务号解析正常。

### 3.6 能力矩阵

| 提供方 / 模型 | 首尾帧 | 时长 | 音频 | 本期可用 |
|---|---|---|---|---|
| 阿里云 Wan 3.0 | 支持 | 2–30 整数 / -1 | `parameters.audio`，默认 true | 是 |
| 阿里云 Wan 2.2 kf2v | 官方支持 | 固定 5s | 无 | 否（适配器未实现，后续） |
| 阿里云 Wan 2.x i2v/t2v | 仅首帧 / 无 | 5 或 10s | 无 | 否 |
| 豆包 Seedance 2.0 | 支持 | 4–15s | `generate_audio` | 是 |
| 豆包 Seedance 2.5 | 支持 | 最长 30s | 支持 | 是（本期按 15s 上限） |
| 豆包 Seedance 1.x i2v | 支持 | 2–12s | 无 | 是 |
| MiniMax H3 云端 | 支持 | 4–15s | 原生音频 | 是 |
| 本地 H3 shim | 支持 | 网格 0.21–14.79s | native/ambient/silent | 是 |
| ComfyUI | 工作流决定 | `DURATION/FRAMES` | 工作流决定 | 是（需占位符检查） |
| 火宝网关 | 三个模型均支持 | 随映射模型 | 随映射模型 | 是 |

---

## 4. 总体方案

### 4.1 用户流程

1. 用户在导出页勾选两个及以上已生成视频的镜头；
2. 点击「生成过渡」，系统按勾选顺序计算 N-1 个断点，创建过渡记录与生成任务；
3. 导出页显示每个断点的状态：缺失 / 生成中 / 已就绪 / 失败 / 已过期 / 已跳过；
4. 用户可预览、重试、跳过某个断点；
5. 用户点击「拼接所选」，弹窗中确认「使用 AI 过渡」；
6. 合片只用已就绪且未过期的过渡；缺失的断点回退到原 `transition`；
7. 合片完成后，成片记录中保存一份断点快照，说明哪些断点用了 AI 过渡、哪些回退。

### 4.2 数据流

```
分镜视频 A ──尾帧抽取──> first_frame.jpg ─┐
                                          ├─> 过渡任务 T ──> 过渡视频 T.mp4
分镜视频 B ──首帧抽取──> last_frame.jpg  ─┘

合片序列：A ──(T 的淡入)──> T ──(T 的淡出)──> B
```

### 4.3 设计原则

- **独立产物**：过渡片段不写分镜表，不改分镜视频；
- **先生成后拼接**：合片请求不等待生成任务，避免合片接口长时间挂起；
- **永远可回退**：任何过渡缺失/失败/过期都不阻断合片；
- **成本透明**：生成按钮明确显示将生成多少个断点，已完成的不重复生成；
- **能力先行**：模型不支持首尾帧时，在创建任务前拒绝，不产生无效计费；
- **复用 UI**：扩展导出页与合片弹窗，不新增平行页面；
- **可追溯**：每条过渡记录保存来源视频、帧、提示词、模型、时长、任务号；
- **可恢复**：服务重启后，已有 `task_id/result_url` 的过渡任务沿用现有恢复机制。

---

## 5. 数据模型

### 5.1 新表 `video_transitions`

```sql
CREATE TABLE IF NOT EXISTS video_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  drama_id INTEGER,
  -- 断点：from = 上一镜，to = 下一镜
  from_storyboard_id INTEGER NOT NULL,
  to_storyboard_id INTEGER NOT NULL,
  -- 生成时的来源视频快照（用于判断过期）
  from_video_url TEXT,
  to_video_url TEXT,
  -- first_frame_url = 上一镜尾帧；last_frame_url = 下一镜首帧
  first_frame_url TEXT,
  last_frame_url TEXT,
  -- 来源指纹：视频 URL + 文件大小 + mtime（含版本前缀，见 §6.2）
  source_hash TEXT,
  prompt TEXT,
  -- ai = 视觉分析生成；fallback = 文字模板回退；manual = 用户编辑锁定
  prompt_source TEXT,
  provider TEXT,
  model TEXT,
  config_id INTEGER,
  config_base_url TEXT,
  duration_requested REAL,
  duration_effective REAL,
  duration_actual REAL,
  audio_mode TEXT DEFAULT 'ambient',
  -- pending | processing | completed | failed | skipped
  status TEXT DEFAULT 'pending',
  video_url TEXT,
  sys_task_id INTEGER,
  error_msg TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_video_transitions_boundary
  ON video_transitions (episode_id, from_storyboard_id, to_storyboard_id);
CREATE INDEX IF NOT EXISTS idx_video_transitions_episode
  ON video_transitions (episode_id);
CREATE INDEX IF NOT EXISTS idx_video_transitions_status
  ON video_transitions (status);
```

状态机：

```
pending ──提交成功──> processing ──完成──> completed
   │                     │
   │                     └──失败──> failed
   └──用户跳过/模型不支持──> skipped
completed ──源视频变化──> stale（派生状态，不落库）
```

说明：

- `enabled=0` 表示用户主动跳过该断点；`status` 保留最后一次生成结果，方便恢复。
- `stale` 不存库，由 `source_hash` 与当前来源视频指纹实时比较得出。
- 同一断点只保留一条记录；重试覆盖原记录。若未来需要多版本，再增加 `take` 字段。

### 5.2 `sys_task` 扩展

新增：

```sql
ALTER TABLE sys_task ADD COLUMN transition_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_sys_task_transition_id ON sys_task (transition_id);
```

用途：

- 过渡任务 `type='video'`，`storyboard_id` 必须为 NULL；
- `transition_id` 指向 `video_transitions.id`；
- 完成/失败分支据此回写过渡表，绝不触碰分镜表；
- 任务列表可据此显示「过渡 S01→S02」。

### 5.3 `video_merges` 扩展

新增：

```sql
ALTER TABLE video_merges ADD COLUMN transitions TEXT;
```

保存合片时的断点快照：

```json
{
  "mode": "ai",
  "requested": 3,
  "used": 2,
  "boundaries": [
    {
      "from_storyboard_id": 11,
      "to_storyboard_id": 12,
      "transition_id": 5,
      "video_url": "static/projects/1/transitions/xxx.mp4",
      "duration_actual": 3.04,
      "used": true,
      "fallback": null
    },
    {
      "from_storyboard_id": 12,
      "to_storyboard_id": 13,
      "transition_id": null,
      "used": false,
      "fallback": "fade",
      "reason": "not_ready"
    }
  ]
}
```

`scenes` 仍保存镜头 URL 数组，保持历史语义；过渡信息只放 `transitions`，避免破坏已有读取方。

### 5.4 存储布局

`backend/src/services/project-storage.ts:20` 的 `PROJECT_SUBDIRS` 增加：

```ts
'transitions'
```

目录：

```
static/projects/<dramaId>/transitions/
  <transition-uuid>.mp4        # 过渡视频
  <transition-uuid>_poster.jpg # 预览封面
  frames/
    sb-<id>-first-<hash>.jpg   # 下一镜首帧
    sb-<id>-last-<hash>.jpg    # 上一镜尾帧
```

好处：

- 项目存储用量统计、项目迁移、清理逻辑自动包含过渡文件；
- 与 `videos` 分开，便于按断点清理；
- 帧文件名带来源哈希，源视频更新后不会误用旧帧。

### 5.5 Drizzle 与迁移

- `backend/src/db/schema.ts` 新增 `videoTransitions` 表映射；
- `sysTask` 增加 `transitionId`；
- `videoMerges` 增加 `transitions`；
- `backend/src/db/sqlite-schema.ts`：
  - 新增 `CREATE TABLE IF NOT EXISTS video_transitions` 与索引；
  - `taskColumns` 迁移对象增加 `transition_id: 'INTEGER'`；
  - `mergeColumns` 迁移对象增加 `transitions: 'TEXT'`；
  - 现有数据库启动时自动补表/补列，不改历史数据。

---

## 6. 帧提取

### 6.1 新增服务

`backend/src/services/video-frames.ts`：

```ts
export interface ExtractedFrame {
  relativePath: string   // static/projects/.../transitions/frames/...
  absolutePath: string
  width: number
  height: number
}

export async function extractVideoFrame(
  videoRelativePath: string,
  position: 'first' | 'last',
  options?: { dramaId?: number; maxEdge?: number },
): Promise<ExtractedFrame>
```

实现要点：

- 先用 `ffprobe` 读取时长、宽高；
- 首帧取 `0.1s`，尾帧取 `duration - 0.1s`；时长不足 0.3s 时取 0 / 最后一帧；
- 抽帧命令等价于：

```bash
ffmpeg -ss <t> -i <input> -frames:v 1 \
  -vf "scale='min(1280,iw)':-2" \
  -q:v 2 -y <output.jpg>
```

- 长边限制 1280，保持偶数尺寸，不放大；
- 输出 JPEG，质量 2；
- 失败返回可操作错误（源文件不存在、ffmpeg 不可用、抽帧结果为空）；
- 不阻断其他断点：某个断点抽帧失败时，该断点标记 `failed`，其余断点继续。

### 6.2 来源指纹

```ts
sourceHash = sha256([
  'transition-v2',
  fromVideoUrl, toVideoUrl,
  fromFileSize, fromFileMtimeMs,
  toFileSize, toFileMtimeMs,
].join('|'))
```

用途：

- 生成前判断是否可以复用已有过渡；
- 合片前判断过渡是否过期；
- 源视频 URL 不变但内容被替换时，也能通过大小/mtime 发现。

`transition-v2` 版本前缀的引入原因：早期实现把「上一镜首帧 / 下一镜尾帧」写反了，而首尾帧路径已落库、来源指纹未变，仅修正代码不会让旧片段失效。版本前缀使所有 v1 片段在升级后自动判定过期，避免错方向的过渡继续参与合片。

### 6.3 帧投递策略

帧的逻辑路径写入 `first_frame_url` / `last_frame_url`，提交时由生成链路转换：

- **本地 H3 shim / ComfyUI**：优先 data URL（本地服务可直接读取；ComfyUI 会再上传到 `/upload/image`）；
- **云端 / 火宝网关**：
  - 配置了 `PUBLIC_BASE_URL` 时优先 `https://<public>/static/...`，减少请求体；
  - 未配置时使用压缩 JPEG 的 data URL；
  - 若上游拒绝 data URL 或请求体过大，返回明确错误，提示配置 `PUBLIC_BASE_URL`。

不直接使用 `storyboards.first_frame_image/last_frame_image`；那些是分镜参考图，不等于成片视频的真实首尾帧。

### 6.4 失败与回退

| 情况 | 处理 |
|---|---|
| 源视频文件丢失 | 该断点 `failed`，提示重新生成镜头视频 |
| ffmpeg 不可用 | 整个「生成过渡」拒绝，给出与合片一致的修复指引 |
| 抽帧为空 | 该断点 `failed`；合片时回退原转场 |
| 帧文件已存在且哈希一致 | 直接复用，不重复抽帧 |

---

## 7. 过渡计划

### 7.1 断点计算

新增纯函数模块 `backend/src/services/transition-plan.ts`：

```ts
export interface TransitionBoundary {
  index: number
  fromStoryboardId: number
  toStoryboardId: number
  fromNumber: number
  toNumber: number
}

export function buildTransitionBoundaries(
  orderedStoryboards: { id: number; storyboardNumber: number }[],
): TransitionBoundary[]
```

规则：

- 输入是**合片实际使用的镜头序列**（已过滤无视频镜头、已按镜号排序、已按用户勾选过滤）；
- 相邻两项构成一个断点；
- 少于 2 个镜头时没有断点；
- 用户只选 S1、S3 时，断点是 S1→S3，而不是 S1→S2、S2→S3；
- 过渡记录保存真实的 `from_storyboard_id` / `to_storyboard_id`，不依赖镜号连续。

### 7.2 时长策略

请求时长预设：`2 / 3 / 4 / 5` 秒，默认 **3 秒**；高级设置允许逐断点覆盖（V1 可先只做全局）。

有效时长由模型能力决定，不做强制二次压缩：

| 模型 | 请求 2s | 请求 3s | 请求 4s | 请求 5s | 说明 |
|---|---|---|---|---|---|
| Wan 3.0 | 2s | 3s | 4s | 5s | 2–30 整数，精确 |
| Seedance 2.0 | 4s | 4s | 4s | 5s | 最小 4s |
| Seedance 1.x i2v | 2s | 3s | 4s | 5s | 2–12s |
| H3 云端 | 4s | 4s | 4s | 5s | 最小 4s |
| 本地 H3 | 2.333s | 3.042s | 4.458s | 5.167s | 5+17k 帧网格 |
| ComfyUI | 2s | 3s | 4s | 5s | 由 `DURATION/FRAMES` 决定，工作流可能取整 |
| Wan 2.2 kf2v | 5s | 5s | 5s | 5s | 固定 5s，本期不支持 |

实现：

```ts
export function effectiveTransitionDuration(
  provider: string,
  model: string,
  requested: number,
  options: { localShim?: boolean },
): number
```

- 返回「有效请求时长」，写入 `duration_effective`；
- 生成完成后用 `ffprobe` 读取真实时长，写入 `duration_actual`；
- UI 同时显示「请求 3s / 有效 4s / 实际 4.02s」，避免用户误解；
- **不做 setpts/atempo 变速压缩**。用户已确认时长可放宽；压缩会改变运动速度，收益低、风险高。

### 7.3 提示词

#### AI 视觉分析（默认路径，2026-11-05 增量）

过渡提示词默认不再固定套模板，而是把两张真实边界帧交给视觉模型分析：

```
图 1：上一镜视频的最后一帧（过渡起点）
图 2：下一镜视频的第一帧（过渡终点）
        │
        ▼
视觉模型（复用「设置 → AI 模型」当前文本模型，需支持图片理解）
        │
        ▼
视频提示词（可直接提交给视频模型）
```

系统提示词要求：

- 明确图 1 是上一镜结尾、图 2 是下一镜开场，只描述两帧之间的连续运动，不新增剧情；
- 说明目标时长 2–3 秒，描述镜头运动（推拉/横移/环绕/轻微手持）与转场方式；
- 保持人物、服装、场景、光线、色调连续；不同场景时做柔和视觉桥接；
- 不出现新人物、不切场景、不生成对白/旁白/字幕/画面文字；
- **只输出提示词正文**，不要解释、编号或 Markdown。

模型与解析：

- `text_config_id` / `text_model` 可由请求显式传入，缺省走 `resolveConfig` 的默认文本配置；
- 通过 `textModelSupportsVision(provider, model)` 做能力门禁，不支持视觉的模型直接报错，不会悄悄产出劣质提示词；
- 图片走现有 `loadStyleImageDataUrls` 压缩后以 data URL 发送；Gemini 用 `inline_data`，其余 OpenAI 兼容端点用 `image_url`；
- 返回内容会剥离代码围栏、`视频提示词：` / `Prompt:` 标签、加粗标记与首尾引号，并合并多余换行；空内容或过短内容报错；
- 本地 H3 额外要求英文：返回中文时视为失败，不把中文正文送进 H3。

来源与回退：

| `prompt_source` | 含义 | 何时出现 |
|---|---|---|
| `ai` | 视觉模型分析两张边界帧生成 | 默认路径，分析成功 |
| `fallback` | 沿用 §7.3 的文字模板 | 模型不支持视觉、API 失败、返回为空/过短、本地 H3 返回中文 |
| `manual` | 用户在界面编辑或填写后锁定 | 保存提示词、带 `prompt` 重试 |

- 回退不会阻断过渡生成，失败原因写入日志并在断点行内提示「本次使用文字模板」；
- `manual` 提示词在源视频变化后仍会保留并复用，除非用户重新分析或改写；本地 H3 下保存中文会被拒绝；
- 断点行内提供「分析提示词 / 保存 / 按提示词重生成」，重生成复用同一断点记录与来源指纹，不新建平行记录。

#### 云端模板（中文，回退路径）

```text
连贯的过渡镜头，连接前后两个镜头，不新增剧情。

上一镜结尾（S{fromNumber}）：{prevVisual}
下一镜开场（S{toNumber}）：{nextVisual}
连续性说明：{continuity}

画面要求：保持同一场景、人物、服装、光线和色调；镜头做平稳的推拉、横移或轻微环绕；不切场景、不出现新人物、不生成字幕或文字。
声音要求：仅保留自然环境声与轻微氛围音，无对白、无旁白、无歌声。
```

- `prevVisual` 取 `description + continuity + movement + atmosphere`；
- `nextVisual` 取 `description + continuity + movement + atmosphere`；
- 同一场景时强调连续运镜；不同场景时改为「柔和视觉桥接，避免瞬移」；
- 不直接使用 `video_prompt`，避免把旁白、台词、音频指令带进过渡；
- 对引号内容做一次清理，避免诱导模型生成对白/字幕。

#### 本地 H3 模板（英文骨架，回退路径）

```text
A short cinematic transition shot connecting the previous shot and the next shot.
The camera moves smoothly and continuously through the same space.
Keep the same characters, wardrobe, lighting, and color grade.
No new characters, no scene change, no cuts, no dialogue, no narration,
no subtitles, no on-screen text, no quoted speech.
Ambient sound only.
```

可选追加描述：

```text
Previous shot: {translatedPrevVisual}
Next shot: {translatedNextVisual}
Continuity: {translatedContinuity}
```

规则：

- 描述翻译使用现有 `translateH3Text`；
- **翻译失败时直接省略该段描述**，保留英文骨架，绝不把中文正文送进 H3（避免烧字幕）；
- 这与现有「视觉背景翻译失败则跳过」的策略一致；
- 提交前仍可走 `compileLocalH3Prompt` 做确定性清理，但英文骨架本身不应包含中文。

#### 通用参数

- `prompt_extend: false`（Wan），避免模型把过渡扩写成完整剧情；
- `watermark: false`；
- `seed: undefined`；
- 不绑定角色音色、不注入旁白/台词；
- `audio_mode` 默认 `ambient`，可在弹窗改为 `silent`；
- 片段音频请求不改变分镜的音频设置。

### 7.4 能力门禁

新增能力字段：

```ts
export interface VideoModelCapabilities {
  // ...
  firstLastFrame: boolean
}
```

判定：

| provider / model | firstLastFrame |
|---|---|
| aliyun `wan3.0-*` | true |
| aliyun `wan2.*` | false（kf2v 后续专项） |
| volcengine `doubao-seedance-2-*` | true |
| volcengine `doubao-seedance-1-*-i2v-*` | true |
| volcengine `doubao-seedance-1-*-t2v-*` | false |
| minimax `MiniMax-H3*`（云/本地） | true |
| comfyui | true（提交前检查工作流占位符） |
| 未知 provider | false |

同时修正一个已发现的元数据错误：

- `model-capabilities.ts` 中 Wan 3.0 的 `nativeAudio` 当前为 `false`，官方 `parameters.audio` 默认 `true`，应改为 `true`；
- 该修正同时影响分镜生成页的音频选项展示，需要同步前后端能力表与测试。

门禁行为：

- 模型不支持首尾帧时，「生成过渡」按钮禁用或返回 400；
- 错误信息明确说明当前模型、支持首尾帧的候选模型；
- 不创建任何生成任务，不产生费用。

---

## 8. 生成链路

### 8.1 新增服务

`backend/src/services/transition-service.ts`：

```ts
export async function prepareTransitions(params: {
  episodeId: number
  storyboardIds: number[]
  mode?: 'missing' | 'all'
  configId?: number
  model?: string
  duration?: number
  audioMode?: 'ambient' | 'silent'
}): Promise<PrepareTransitionsResult>

export async function listTransitions(params: {
  episodeId: number
  storyboardIds: number[]
}): Promise<TransitionBoundaryView[]>

export async function retryTransition(id: number): Promise<void>
export async function skipTransition(id: number): Promise<void>
```

`prepareTransitions` 流程：

1. 读取剧集、项目、分镜；校验剧集存在、镜头属于该集、按镜号排序；
2. 过滤没有视频的镜头；少于 2 个则报错；
3. 解析视频配置：
   - 显式 `configId` 优先；
   - 否则剧集 `video_config_id`；
   - 否则当前启用的视频配置；
   - 配置失效时回退，但要把最终使用的配置写进过渡记录；
4. 校验模型能力 `firstLastFrame`；
5. 计算断点；
6. 对每个断点：
   - 计算来源指纹；
   - 查找已有记录：
     - `completed` 且指纹一致且文件存在 → 复用；
     - `enabled=0` 且 `mode !== 'all'` → 跳过；
     - 指纹变化 → 视为需要重新生成；
   - 抽取首尾帧；
   - 生成提示词（本地 H3 需要翻译时异步处理）；
   - upsert `video_transitions`，状态 `pending`；
   - 调用 `generateVideo`（带 `transitionId`）；
   - 成功后更新 `video_transitions.status='processing'`、`sys_task_id`、`duration_effective`；
7. 返回每个断点的处理结果：`created/reused/failed/skipped`。

注意：

- `prepare` 只负责创建任务，不等待任务完成；前端通过 `GET transitions` 轮询状态；
- 已完成且未过期的记录不重复生成，避免重复计费；
- 失败断点保留错误信息，用户可单条重试或跳过；
- 本地 H3 的多任务由 shim/ComfyUI 自行排队；若显存不足导致失败，用户可重试，后续可增加资源队列。

### 8.2 `generateVideo` 扩展

`GenerateVideoParams` 增加：

```ts
transitionId?: number
allowShortDuration?: boolean
```

`generateVideo` 内部：

- 去重键：
  - 有 `storyboardId` → `sb-<id>`；
  - 有 `transitionId` → `tr-<id>`；
  - ComfyUI 整集 → `ep-<id>`；
- 重复检查：
  - 有 `transitionId` 时按 `transition_id` 查最新 `sys_task`；
  - `processing` 拒绝；
  - `failed` 且未 `forceNew` 拒绝；
- `createTask` 写入 `transitionId`；
- `params` 中额外保存：
  - `transitionId`；
  - `episodeId`；
  - `fromStoryboardId` / `toStoryboardId`；
  - `firstFrameUrl` / `lastFrameUrl`（逻辑路径）；
  - `durationRequested` / `durationEffective`；
  - `audioMode`；
  - `allowShortDuration`；
  - `promptKind: 'transition'`。

### 8.3 完成回写

`handleVideoComplete` 增加分支：

```ts
if (record.transitionId) {
  // 只更新 video_transitions，绝不更新 storyboards
} else if (record.storyboardId) {
  // 现有分镜回写
}
```

过渡分支：

1. 下载视频到 `static/projects/<dramaId>/transitions/transition-<id>.mp4`；
2. 静音模式强制去音轨（复用 `stripVideoAudio`）；
3. 抽海报帧；
4. 在事务中：
   - 检查同一 `transitionId` 是否有更新的任务；有则旧任务不覆盖；
   - 更新 `video_transitions.status='completed'`、`video_url`、`duration_actual`、`completed_at`、`error_msg=null`；
   - 更新 `sys_task` 状态；
5. 不创建 `video_merges`，不更新 `episodes.video_url`。

`failTask` 增加：

- 若任务有 `transition_id`，同步更新 `video_transitions.status='failed'`、`error_msg`；
- 不影响分镜表。

恢复：

- `recoverVideoTask` 已按 `sysTask` 的 `taskId/resultUrl` 工作，过渡任务自动适用；
- `resumeInterruptedTasks` 重启后恢复处理中的过渡任务；
- 恢复完成仍走上面的过渡分支。

### 8.4 本地 H3 短时长

`backend/src/services/adapters/minimax-video.ts`：

```ts
private normalizeDuration(duration?: number | null, allowShortDuration = false): number {
  const parsed = Math.round(Number(duration || 5))
  if (!Number.isFinite(parsed)) return 5
  const min = allowShortDuration ? 1 : 4
  return Math.min(15, Math.max(min, parsed))
}
```

- 只有 `params.allowShortDuration === true` 且是本地 shim 时启用；
- 普通分镜生成保持 4–15 秒；
- 实际时长由 shim 的帧网格决定，完成后用 `ffprobe` 记录；
- 云端 H3 不启用短时长。

### 8.5 ComfyUI

- 过渡任务使用普通生成路径，不用 `comfyTimeline`；
- 适配器已注入 `FIRST_FRAME`、`LAST_FRAME`、`DURATION`、`FRAMES`；
- `prepare` 阶段解析工作流 JSON，检查是否包含：
  - `FIRST_FRAME` 或 `IMAGE` 占位符；
  - `LAST_FRAME` 占位符；
- 缺失 `LAST_FRAME` 时返回：

```text
当前 ComfyUI 工作流未使用 LAST_FRAME 占位符，无法生成首尾帧过渡。
请在 LoadImage 节点上使用 {{LAST_FRAME}}，或改用 H3/云端模型。
```

- `ASPECT_RATIO` / `RESOLUTION` 使用项目宽高比与剧集分辨率，不用 `adaptive`，避免工作流节点不识别。

### 8.6 火宝网关

- 不做网关专用改造；
- 三个配置按现有适配器发送官方请求体；
- 增加冒烟测试：
  - `/qwen` + `wan3.0-video` → `input.media` 同时含 `first_frame`、`last_frame`；
  - `/volcengine` + `doubao-seedance-2-0-*` → `content` 同时含两个 `role`；
  - `/minimax` + `MiniMax-H3` → `content` 同时含两个 `role`；
- 若网关对 base64 请求体有限制，优先使用 `PUBLIC_BASE_URL` 提供的公网帧地址。

### 8.7 日志与脱敏

- 过渡参数中的帧路径可能被转换为 data URL；
- `task-logger` 在记录 payload 时，把 `data:image/...;base64,...` 替换为 `[data-url omitted]`，并对超长字符串截断；
- 不记录 base64、API Key、签名 URL；
- 记录断点、模型、时长、任务号即可。

---

## 9. 拼接集成

### 9.1 合片序列

设原镜头序列为 `A, B`，过渡片段为 `T`：

```
A (原 transition) → T (fade 200ms) → B (fade 200ms)
```

- `T` 的 `transition` 覆盖为 `fade` 或 `dissolve`；
- `B` 的 `transition` 覆盖为 `fade` 或 `dissolve`，避免 B 原来的 `cut/wipe` 破坏桥接；
- `A` 的 transition 保持不变（它相对上一镜，若有）；
- 多个断点时依次插入：`A T1 B T2 C`；
- 只在用户勾选且已就绪的断点插入；否则保持原序列。

### 9.2 合片计划扩展

`backend/src/services/merge-plan.ts`：

```ts
export interface MergeClipPlan {
  durationMs: number
  transition?: string | null
  /** 显式指定该片段相对上一片的转场时长；用于过渡片段两端 */
  transitionMs?: number
}
```

`buildMergeTransitionGraph`：

- `transitionMs` 存在时使用显式值，并夹在 120–500ms；
- 若显式值小于 120ms 或大于较短片段的一半，退化为硬切；
- 未指定时保持现有 `min(prev, curr) * 20%` 逻辑；
- 过渡片段两端默认 200ms。

`computeMergeSourceHash`：

- 哈希中包含每个片段的 `url`、`transition`、`transitionMs`；
- 过渡片段 URL 变化会自动使旧合片缓存失效。

### 9.3 音频

现有 `doMerge` 只有在**所有片段都有音轨**时才走 `xfade + acrossfade`。过渡片段可能无音轨（Wan 2.2 kf2v、部分 ComfyUI 工作流），处理方式：

1. 合片准备阶段检测过渡片段是否有音频流；
2. 无音频流时，生成一个**临时补轨文件**：

```bash
ffmpeg -i T.mp4 -f lavfi -i anullsrc=r=48000:cl=stereo \
  -shortest -c:v copy -c:a aac -b:a 192k T_with_silence.mp4
```

3. 用补轨文件参与合片；
4. 合片结束后清理临时文件；
5. `audioMode='silent'` 时仍走 `mergeSilentVideos`，不添加音轨。

音频策略：

- 过渡片段默认 `audio_mode='ambient'`；
- 云端提示词明确「仅环境声，无对白/旁白/歌声」；
- 本地 H3 用 `ambient` 指令；
- 若上游仍返回对白/旁白，合片阶段不做语音识别，只在任务结果中保留；后续可增加「过渡片段静音」重生成；
- `native` 分镜之间的过渡**不建议**生成对白，避免凭空发明角色台词；默认仍是环境声。

### 9.4 合片准备

在 `mergeEpisodeVideos` 内新增：

```ts
interface MergeOptions {
  useAiTransitions?: boolean
  transitionDuration?: number
}

async function resolveReadyTransitions(
  episodeId: number,
  storyboards: Storyboard[],
  options: MergeOptions,
): Promise<{ clips: MergeClip[]; snapshot: MergeTransitionSnapshot }>
```

规则：

- 只取 `status='completed'`、`enabled=1`；
- 来源指纹必须与当前镜头视频一致，否则视为过期；
- 过渡视频文件必须存在且能 `ffprobe`；
- 实际时长小于 0.3s 的片段不参与；
- 不满足条件的断点回退到原 `transition`；
- 返回增强后的 `clips` 和快照。

`mergeEpisodeVideos` 的变化：

1. 先得到有序、过滤后的镜头；
2. 调 `resolveReadyTransitions`；
3. 用增强后的 clips 计算 `sourceHash`；
4. 创建 `video_merges`，写入：
   - `scenes`：镜头 URL 数组（不含过渡片段）；
   - `transitions`：断点快照；
   - `mixOptions`：`{ audioMode, aiTransitions: { requested, used, fallback } }`；
5. `doMerge` 使用增强后的 clips。

### 9.5 回退

| 情况 | 回退 |
|---|---|
| 未请求 AI 过渡 | 现有逻辑完全不变 |
| 过渡缺失/生成中 | 使用原 `storyboard.transition` |
| 过渡失败/过期/文件丢失 | 使用原 `storyboard.transition`，快照记录原因 |
| 过渡片段无音轨 | 补静音轨后参与合片 |
| 转场滤镜失败 | 沿用现有 fallback：逐段 loudnorm → plain concat |
| 补轨/画布归一失败 | 该过渡片段被剔除，重新构建合片序列 |

任何回退都不能让合片失败；回退原因写入 `video_merges.transitions`，前端可展开查看。

### 9.6 画布归一

现有 `normalizeCanvasIfNeeded` 会把不同分辨率镜头补黑边到多数派画布。过渡片段也参与同一流程：

- 过渡片段通常与镜头同分辨率；
- 若不同，按同一规则补齐；
- 画布归一后再做 `xfade`，避免尺寸不一致导致花屏。

---

## 10. API 设计

路由挂载在现有 `/api/merge` 下（`backend/src/index.ts:84`），不新增顶层路由。

### 10.1 查询断点

```http
GET /api/merge/episodes/:id/transitions?storyboard_ids=11,12,13
```

响应：

```json
{
  "boundaries": [
    {
      "index": 1,
      "from_storyboard_id": 11,
      "to_storyboard_id": 12,
      "from_number": 1,
      "to_number": 2,
      "status": "completed",
      "transition_id": 5,
      "video_url": "static/projects/1/transitions/x.mp4",
      "duration_requested": 3,
      "duration_effective": 3,
      "duration_actual": 3.04,
      "provider": "aliyun",
      "model": "wan3.0-video",
      "audio_mode": "ambient",
      "stale": false,
      "supported": true,
      "error_msg": null
    }
  ],
  "summary": { "total": 3, "ready": 2, "missing": 1, "failed": 0, "processing": 0, "skipped": 0 },
  "provider": {
    "config_id": 2,
    "model": "wan3.0-video",
    "first_last_frame": true,
    "min_duration": 2,
    "max_duration": 30
  }
}
```

说明：

- 不传 `storyboard_ids` 时默认取该集全部已生成视频的镜头；
- 没有记录的断点返回 `status='missing'`，便于 UI 直接展示；
- `stale=true` 的已完成记录不参与合片。

### 10.2 生成过渡

```http
POST /api/merge/episodes/:id/transitions/prepare
```

请求：

```json
{
  "storyboard_ids": [11, 12, 13],
  "mode": "missing",
  "config_id": 2,
  "model": "wan3.0-video",
  "duration": 3,
  "audio_mode": "ambient",
  "text_config_id": 7,
  "text_model": "qwen-vl-max"
}
```

- `mode='missing'`：只生成缺失/过期/失败记录（默认）；
- `mode='all'`：强制重新生成所有断点（需前端二次确认计费）；
- `text_config_id` / `text_model` 为视觉分析提示词所用的文本模型；缺省走默认文本配置；
- 返回 `created/reused/failed/skipped` 数量与每个断点的最新状态；
- 该接口不等待生成完成。

### 10.3 重试

```http
POST /api/merge/transitions/:id/retry
```

请求体（均可选）：

```json
{
  "prompt": "用户编辑后的过渡提示词",
  "text_config_id": 7,
  "text_model": "qwen-vl-max"
}
```

- 使用原记录的 `config_id` / `model` / 时长 / 音频模式；
- 带 `prompt` 时视为用户指定提示词，写入 `prompt_source='manual'`，不再做视觉分析；
- 不带 `prompt` 时按默认路径重新分析两张边界帧；显式文本模型优先；
- 原配置已删除或地址变化时返回明确错误，要求重新选择模型；
- 同一断点已有 `processing` 任务时拒绝重试。

### 10.4 跳过

```http
POST /api/merge/transitions/:id/skip
```

- 设置 `enabled=0`，保留记录与文件；
- 合片时该断点回退原转场；
- 可再次 prepare 重新启用。

### 10.5 合片

```http
POST /api/merge/episodes/:id/merge
```

新增可选字段：

```json
{
  "storyboard_ids": [11, 12, 13],
  "title": "第 1 集成片",
  "use_ai_transitions": true
}
```

- `use_ai_transitions` 默认 `false`，保持旧行为；
- 前端在用户勾选「使用 AI 过渡」时传 `true`；
- 合片不会自动生成缺失过渡；
- 响应仍为 `{ merge_id, status: 'processing' }`；
- 成片记录通过 `GET /episodes/:id/merge` 返回 `transitions` 快照。

### 10.6 分析提示词

```http
POST /api/merge/transitions/:id/analyze
```

请求体（均可选）：

```json
{
  "text_config_id": 7,
  "text_model": "qwen-vl-max"
}
```

响应：

```json
{
  "prompt": "镜头从雨夜街角平滑推进到咖啡馆门口，雨丝与暖光自然衔接。",
  "prompt_source": "ai",
  "config_id": 7,
  "model": "qwen-vl-max"
}
```

- 复用断点已存的边界帧；来源指纹变化或帧文件缺失时重新抽帧，并回写帧路径；
- 只返回候选提示词，**不落库、不触发生成**，由用户确认后再保存或重生成；
- 模型不支持视觉、API 失败、返回为空/过短时返回 400 与可操作错误，前端保留原提示词。

### 10.7 保存提示词

```http
PUT /api/merge/transitions/:id/prompt
```

请求：

```json
{ "prompt": "用户编辑后的过渡提示词" }
```

- 去除首尾空白，空内容返回 400；
- 本地 H3 断点拒绝中文提示词；
- 写入 `prompt_source='manual'`，返回更新后的断点行（snake_case）；
- 只改提示词，不自动重新生成；重生成由 `retry` 携带 `prompt` 完成。

---

## 11. 前端设计

### 11.1 复用现有界面

不新增页面、Tab 或平行面板。改动集中在：

1. 导出页（`frontend/app/views/drama/episode.vue`）的「镜头素材」区；
2. 现有「拼接所选」弹窗。

#### 导出页摘要

在「镜头素材」区头部，现有「拼接所选」按钮旁增加：

```text
AI 过渡 2/3   [生成过渡]
```

- 只在勾选 ≥2 个已生成视频的镜头时显示/启用；
- `2/3` 为已就绪/总断点数；
- 有生成中任务时显示旋转状态；
- 点击「生成过渡」打开确认（提示将生成 N 个断点、可能产生费用），确认后调用 prepare；
- 点击摘要可滚动/展开断点列表（V1 可在弹窗内展示，不额外占版面）。

#### 合片弹窗

现有弹窗增加：

```text
[标题输入]

AI 过渡片段  [开关]
  断点列表：
    S01 尾 → S02 首   已完成 3.04s   [预览] [提示词] [重试] [跳过]
      └─ [AI 分析] 来源：AI 分析
         [提示词文本框................................]
         [保存] [按此提示词重生成]
    S02 尾 → S03 首   缺失           [生成]
  过渡时长：[2s] [3s] [4s] [5s]
  过渡声音：[环境声] [静音]
  提示：缺失的断点将使用镜头原来的转场方式。

[取消] [重新生成缺失] [开始拼接]
```

- 开关默认在「存在已就绪过渡」时打开；
- 模型不支持首尾帧时，开关禁用并显示原因；
- 断点状态色：
  - 绿色：已完成；
  - 蓝色/旋转：生成中；
  - 黄色：缺失/过期；
  - 红色：失败；
  - 灰色：已跳过；
- 「开始拼接」始终可用（允许回退）；
- 若缺失较多，按钮文案提示「将回退 N 个断点」。

### 11.2 状态与轮询

新增前端 API：

```ts
export const transitionAPI = {
  list: (episodeId: number, storyboardIds: number[]) => api.get(`/merge/episodes/${episodeId}/transitions?...`),
  prepare: (episodeId: number, body: any) => api.post(`/merge/episodes/${episodeId}/transitions/prepare`, body),
  retry: (id: number, body?: any) => api.post(`/merge/transitions/${id}/retry`, body ?? {}),
  skip: (id: number) => api.post(`/merge/transitions/${id}/skip`),
  analyze: (id: number, body?: any) => api.post(`/merge/transitions/${id}/analyze`, body ?? {}),
  savePrompt: (id: number, prompt: string) => api.put(`/merge/transitions/${id}/prompt`, { prompt }),
}
```

提示词编辑器状态：

- `transitionPromptOpen` / `transitionPromptDrafts` / `transitionPromptBusy` 以断点键 `from-to` 索引；
- 打开时从 `boundary.prompt` 初始化草稿；分析结果只覆盖草稿，不自动保存；
- 「保存」写入 `manual`；「按此提示词重生成」直接把草稿作为 `retry` 的 `prompt`；
- 分析和重生成都带当前文本模型 `text_config_id` / `text_model`；
- `processing` / `pending` 状态下禁用重生成，避免覆盖在跑任务；
- 来源徽标显示 AI 分析 / 文字模板（回退）/ 手动编辑；回退时附一行说明。

状态：

- `transitionData = ref({ boundaries: [], summary: {}, provider: null })`
- `transitionPolling`：仅当存在 `pending/processing` 时每 3 秒轮询；
- 切换勾选、进入导出阶段、打开合片弹窗时刷新；
- 组件卸载/离开导出阶段时清理定时器；
- 生成完成后自动刷新一次合片弹窗中的断点列表。

### 11.3 预览

复用现有 `previewShot` 视频弹窗：

- 传入 `{ id: 'transition-<id>', video_url, duration, previewLabel: 'S01→S02 过渡' }`；
- 扩展 `shotNumberOf`/标题逻辑，识别 `previewLabel`；
- 不新建预览组件。

### 11.4 任务抽屉

- 过渡任务会出现在剧集任务列表；需在 `getEpisodeTaskScope` 中把 `transition_id` 属于该集的 `sys_task` 纳入；
- 前端任务行显示「过渡 S01→S02」，而不是空白分镜号；
- 「清空已完成/失败任务」可以删除过渡任务记录，但不删除 `video_transitions` 和已生成视频。

### 11.5 国际化

在 `frontend/app/locales/zh.json`、`en.json` 增加：

```text
episode.export.aiTransition.title
episode.export.aiTransition.enable
episode.export.aiTransition.ready
episode.export.aiTransition.generateMissing
episode.export.aiTransition.regenerate
episode.export.aiTransition.duration
episode.export.aiTransition.audio
episode.export.aiTransition.audioAmbient
episode.export.aiTransition.audioSilent
episode.export.aiTransition.status.missing
episode.export.aiTransition.status.processing
episode.export.aiTransition.status.completed
episode.export.aiTransition.status.failed
episode.export.aiTransition.status.stale
episode.export.aiTransition.status.skipped
episode.export.aiTransition.retry
episode.export.aiTransition.skip
episode.export.aiTransition.preview
episode.export.aiTransition.unsupported
episode.export.aiTransition.effectiveDuration
episode.export.aiTransition.costHint
episode.export.aiTransition.fallbackHint
```

日文/韩文若继续维护，同步补齐；至少保证中文/英文无缺失键。

---

## 12. 异常与边界

| 场景 | 行为 |
|---|---|
| 勾选少于 2 个镜头 | 禁用生成/合片入口，提示至少两个镜头 |
| 镜头没有视频 | 不参与断点；合片时沿用现有跳过逻辑 |
| 模型不支持首尾帧 | 创建任务前拒绝，显示候选模型 |
| 配置被删除/停用 | 回退到当前启用配置；重试时若原配置失效，要求重新选择 |
| 源视频文件丢失 | 断点失败；合片回退原转场 |
| 抽帧失败 | 该断点失败；其余断点继续 |
| 过渡生成失败 | 记录错误；合片回退；支持单条重试 |
| 过渡生成中 | 合片不使用该断点，回退原转场 |
| 源视频更新 | 过渡标记过期，不参与合片；prepare 可重新生成 |
| 过渡视频无音轨 | 合片前补静音轨；silent 模式除外 |
| 过渡视频损坏/时长为 0 | 合片时剔除并回退 |
| 转场滤镜失败 | 沿用 loudnorm/concat 回退 |
| 服务重启 | 处理中任务走现有恢复；pending 过渡可在导出页重新 prepare |
| 本地 GPU 忙/显存不足 | 任务失败并显示错误；用户重试或减少断点 |
| 项目存储迁移 | `transitions` 已加入 `PROJECT_SUBDIRS`，随项目一起搬迁 |
| 旧合片记录 | `transitions` 为 NULL，前端按「无 AI 过渡」展示 |

---

## 13. 测试计划

遵循 TDD：每个行为先写失败测试，再实现。

### 13.1 纯函数测试

`backend/tests/transition-plan.test.ts`

- 3 个镜头 → 2 个断点，from/to 正确；
- 只选 S1/S3 → 1 个断点；
- 少于 2 个镜头 → 空断点；
- 时长策略表：Wan 3.0 / Seedance 2.0 / Seedance 1.x / H3 云 / 本地 H3 / ComfyUI；
- 云端提示词包含上一镜/下一镜/连续性，且包含「无对白、无字幕」；
- 本地 H3 提示词是英文骨架；描述翻译失败时不包含中文；
- 来源哈希在视频 URL/大小/mtime 变化时变化，不变时稳定；
- 能力门禁：Wan 2.x 拒绝、Wan 3.0/Seedance 2.0/本地 H3/ComfyUI 通过。

`backend/tests/transition-prompt.test.ts`

- 系统提示词明确「第一张图 = 上一镜最后一帧」「第二张图 = 下一镜第一帧」，并要求镜头运动、禁对白/字幕、只输出提示词；
- 解析器剥离代码围栏、`视频提示词：` / `Prompt:` 标签、加粗、首尾引号与多余换行；
- 空输出、过短输出报错；
- 本地 H3 拒绝中文、接受英文；
- 用户提示词包含镜号、画面描述与连续性说明。

`backend/tests/merge-plan.test.ts` 增补

- `A, T, B` 序列：T 和 B 使用 200ms 显式转场；
- 总时长 = 三段时长之和 - 两段 xfade；
- 显式转场小于 120ms → 硬切；
- `computeMergeSourceHash` 包含过渡片段 URL 和 `transitionMs`。

### 13.2 帧提取测试

`backend/tests/video-frames.test.ts`

- 帧路径命名与项目存储路径正确；
- 用 ffmpeg 生成 1 秒纯色测试视频（可用时）：
  - 首帧、尾帧都能产出 JPEG；
  - 长边不超过 1280；
  - 同一输入重复调用复用文件；
- ffmpeg 不可用时跳过集成用例，但路径/哈希用例必须运行。

### 13.3 数据库与服务测试

`backend/tests/transition-service.test.ts`

- prepare 创建 N-1 条记录与 N-1 个 `sys_task`；
- `sys_task.storyboard_id` 为 NULL，`transition_id` 正确；
- 重复 prepare 复用已完成且未过期的记录；
- `mode='all'` 强制重建；
- 源视频更新后标记过期并重建；
- 跳过 `enabled=0` 不再生成；
- 不支持模型 → 报错且不建任务；
- 源视频丢失 → 断点失败，其余断点继续；
- 视觉分析成功 → `prompt_source='ai'`，两张帧按「尾帧 → 首帧」提交；
- 视觉分析失败 → `prompt_source='fallback'`，文字模板继续生成；
- 带 `prompt` 重试 → 不重复分析，`prompt_source='manual'`；
- 源视频变化后手动提示词保留；
- `analyze` 复用已存帧、只返回候选提示词不落库；
- `saveTransitionPrompt` 去空白、拒绝空值与本地 H3 中文。

`backend/tests/transition-generation.test.ts`

- 过渡任务完成只更新 `video_transitions`，不更新 `storyboards.video_url`；
- 静音模式去除音轨；
- 失败任务同步标记过渡失败；
- 同一断点旧任务恢复不覆盖新任务；
- 实际时长写入 `duration_actual`。

`backend/tests/merge-routes.test.ts` 增补

- GET 断点列表包含 missing/ready/processing；
- prepare 路由参数校验（含非法 `text_config_id`）；
- retry/skip 路由（retry 校验 `text_config_id`）；
- `PUT /merge/transitions/:id/prompt` 写入 `manual`、空值与缺失记录报错；
- `POST /merge/transitions/:id/analyze` 校验参数与缺失文本配置；
- merge 的 `use_ai_transitions=false` 不改变旧行为；
- merge 快照写入 `transitions`。

### 13.4 适配器测试

`backend/tests/official-provider-adapters.test.mjs` 增补

- Wan 3.0 请求体同时包含 `first_frame`、`last_frame`；
- Seedance 2.0 请求体同时包含两个 `role`；
- MiniMax H3 请求体同时包含两个 `role`；
- 本地 H3 `allowShortDuration=true` 时请求 3 秒不被夹到 4 秒；
- 本地 H3 默认仍夹 4–15 秒；
- 火宝三个 baseUrl 路径的请求体与任务号解析。

`backend/tests/model-capabilities.test.ts` 增补

- `firstLastFrame` 矩阵；
- Wan 3.0 `nativeAudio=true`；
- Seedance 1.x t2v 不支持首尾帧。

### 13.5 合片集成测试

`backend/tests/merge-bridge.test.ts`（新）

- 用 ffmpeg 生成 A/B/T 三个短片段（有音轨/无音轨各一组）；
- 合并后视频时长符合预期；
- 无音轨 T 被补静音轨后仍走转场路径；
- T 损坏时被剔除，A/B 仍能合并；
- silent 模式输出无音轨。

### 13.6 前端验证

- `npm run build`（frontend）通过；
- 导出页勾选、生成过渡、轮询、重试、跳过、合片弹窗状态正确；
- 断点行内提示词编辑器复用合片弹窗，不新增页面/弹窗；
- 分析、保存、按提示词重生成均带当前文本模型；处理中禁用重生成；
- 提示词来源可见，回退有说明；
- 四语言提示词编辑器文案齐全（`frontend/tests/transition-prompt-structure.test.mjs`）；
- 不支持模型时开关禁用且文案正确；
- 预览弹窗能播放过渡片段；
- 旧数据（无 transitions）不报错。

### 13.7 手工 E2E

至少覆盖：

1. 本地 H3 shim + ComfyUI：3 个镜头、2 个断点，请求 3s，实际约 3.04s；
2. 火宝 `/qwen` Wan 3.0：请求 3s，实际 3s；
3. 火宝 `/volcengine` Seedance 2.0：请求 3s，有效 4s，UI 显示正确；
4. 一个断点故意失败：合片仍成功，快照记录回退原因；
5. 重新生成相邻镜头后：旧过渡过期，合片不使用。

---

## 14. 实施阶段

### 阶段 1：能力与基础数据

- 前后端 `model-capabilities` 增加 `firstLastFrame`；
- 修正 Wan 3.0 `nativeAudio`；
- `PROJECT_SUBDIRS` 增加 `transitions`；
- 新增 `video_transitions` 表、`sys_task.transition_id`、`video_merges.transitions`；
- 新增 `video-frames.ts`；
- 先写测试：能力矩阵、存储布局、帧路径/抽帧。

### 阶段 2：过渡计划与生成链路

- `transition-plan.ts`：断点、时长、提示词、哈希；
- `transition-service.ts`：prepare/list/retry/skip；
- `generation.ts`：`transitionId`、去重、完成/失败分支；
- `minimax-video.ts`：`allowShortDuration`；
- ComfyUI 占位符检查；
- 日志脱敏；
- 先写测试：计划纯函数、服务、完成回写、适配器。

### 阶段 3：合片集成

- `MergeClipPlan.transitionMs`；
- `resolveReadyTransitions`；
- 过渡片段插入、音频补轨、画布归一；
- `video_merges.transitions` 快照；
- 回退逻辑；
- 先写测试：merge-plan、合片集成。

### 阶段 4：API

- `/merge/episodes/:id/transitions`；
- `/merge/episodes/:id/transitions/prepare`；
- `/merge/transitions/:id/retry`；
- `/merge/transitions/:id/skip`；
- merge 的 `use_ai_transitions`；
- 任务列表纳入过渡任务；
- 先写测试：路由与参数校验。

### 阶段 5：前端与验证

- `useApi.ts` 增加 `transitionAPI`；
- 导出页摘要、合片弹窗、断点列表、预览、轮询；
- 中英文案；
- 任务抽屉过渡标签；
- 后端全量测试、前端构建、手工 E2E；
- 不执行打包/安装/重启，除非用户明确要求。

---

## 15. 风险与取舍

| 风险 | 影响 | 取舍/缓解 |
|---|---|---|
| 云端请求体过大 | data URL 导致 4xx/超时 | 压缩帧到长边 1280；优先 `PUBLIC_BASE_URL`；错误提示可操作 |
| 模型最小时长 > 请求时长 | 用户以为生成 3s 实际 4s | UI 同时显示请求/有效/实际；不强制变速压缩 |
| 过渡片段无音轨 | 合片退回 concat，丢失 AI 转场 | 合片前补静音轨；silent 模式单独处理 |
| 本地 GPU 排队 | N-1 个任务耗时较长 | prepare 不阻塞；UI 轮询；失败可重试 |
| 过渡提示词引发言语 | 过渡片段出现对白/旁白 | 提示词明确禁止；本地 H3 英文骨架；后续可加静音重生成 |
| 源视频更新 | 过渡画面不匹配 | 来源指纹检测过期，合片不使用 |
| Wan 2.x 不支持尾帧 | 旧配置无法用 | 能力门禁提示；后续补 kf2v 专项 |
| 过渡文件堆积 | 磁盘占用 | `transitions` 纳入项目用量；后续加清理任务 |
| 合片时长变化 | 用户预期总时长 | 合片结果记录断点快照；UI 不承诺固定总时长 |
| 生成失败计费 | 重试产生额外费用 | 已完成不重复生成；重试必须显式触发；提示费用 |

---

## 16. 验收标准

- [ ] 勾选 3 个已生成视频的镜头，能创建 2 条过渡记录与 2 个生成任务；
- [ ] 每条过渡的 `first_frame_url` 来自上一镜尾帧，`last_frame_url` 来自下一镜首帧；
- [ ] 默认由视觉模型分析两张边界帧生成过渡提示词，来源标记为 `ai`；
- [ ] 视觉模型不支持/调用失败/返回为空时回退文字模板，来源标记为 `fallback`，生成不中断；
- [ ] 用户可在断点行内编辑并保存提示词（`manual`），并按该提示词重新生成；
- [ ] 本地 H3 断点拒绝中文提示词，分析结果含中文时按失败回退；
- [ ] 过渡任务完成不修改任何 `storyboards.video_url`；
- [ ] 合片时过渡片段按顺序插入，输出视频包含过渡画面；
- [ ] 过渡缺失/失败/过期时合片仍成功，并记录回退原因；
- [ ] 本地 H3 请求 3 秒生成约 3.04 秒片段；Seedance 2.0 请求 3 秒有效 4 秒且 UI 显示正确；
- [ ] 模型不支持首尾帧时，创建任务前拒绝，不产生任务与费用；
- [ ] 重新生成相邻镜头后，旧过渡被判定过期，不参与合片；
- [ ] 过渡片段无音轨时，合片仍能走 `xfade + acrossfade`；
- [ ] 旧项目/旧合片记录打开导出页不报错；
- [ ] 后端全量测试通过，前端构建通过；
- [ ] 至少完成一条本地 H3 和一条火宝/云端的手工 E2E。

---

## 17. 附录

### 17.1 Wan 3.0 请求示例

```json
{
  "model": "wan3.0-video",
  "input": {
    "prompt": "连贯的过渡镜头……无对白、无字幕。",
    "media": [
      { "type": "first_frame", "url": "<上一镜尾帧>" },
      { "type": "last_frame", "url": "<下一镜首帧>" }
    ]
  },
  "parameters": {
    "resolution": "720P",
    "ratio": "adaptive",
    "duration": 3,
    "audio": true,
    "prompt_extend": false,
    "watermark": false
  }
}
```

### 17.2 Seedance 2.0 请求示例

```json
{
  "model": "doubao-seedance-2-0-mini-260615",
  "content": [
    { "type": "text", "text": "连贯的过渡镜头……" },
    { "type": "image_url", "image_url": { "url": "<上一镜尾帧>" }, "role": "first_frame" },
    { "type": "image_url", "image_url": { "url": "<下一镜首帧>" }, "role": "last_frame" }
  ],
  "generate_audio": true,
  "ratio": "adaptive",
  "duration": 4,
  "resolution": "720p",
  "watermark": false
}
```

### 17.3 MiniMax H3 请求示例

```json
{
  "model": "MiniMax-H3",
  "content": [
    { "type": "text", "text": "A short cinematic transition shot..." },
    { "type": "image_url", "image_url": { "url": "<上一镜尾帧>" }, "role": "first_frame" },
    { "type": "image_url", "image_url": { "url": "<下一镜首帧>" }, "role": "last_frame" }
  ],
  "duration": 4,
  "resolution": "768P"
}
```

本地 shim 额外字段：

```json
{
  "resolution_tier": "720p",
  "aspect_ratio": "16:9",
  "audio_mode": "ambient",
  "quality": "final"
}
```

### 17.4 涉及文件

新增：

- `backend/src/services/transition-plan.ts`
- `backend/src/services/transition-service.ts`
- `backend/src/services/transition-prompt.ts`
- `backend/src/services/video-frames.ts`
- `backend/tests/transition-plan.test.ts`
- `backend/tests/transition-prompt.test.ts`
- `backend/tests/transition-service.test.ts`
- `backend/tests/transition-generation.test.ts`
- `backend/tests/video-frames.test.ts`
- `backend/tests/merge-bridge.test.ts`
- `frontend/tests/transition-prompt-structure.test.mjs`

修改：

- `backend/src/db/schema.ts`
- `backend/src/db/sqlite-schema.ts`
- `backend/src/services/project-storage.ts`
- `backend/src/services/style-analysis.ts`
- `backend/src/services/model-capabilities.ts`
- `backend/src/services/generation.ts`
- `backend/src/services/ffmpeg-merge.ts`
- `backend/src/services/merge-plan.ts`
- `backend/src/services/adapters/minimax-video.ts`
- `backend/src/services/adapters/comfyui-video.ts`
- `backend/src/routes/merge.ts`
- `backend/src/routes/episodes.ts`
- `backend/src/utils/video-audio-track.ts`
- `backend/src/utils/task-logger.ts`
- `frontend/app/views/drama/episode.vue`
- `frontend/app/composables/useApi.ts`
- `frontend/app/utils/model-capabilities.ts`
- `frontend/app/locales/zh.json`
- `frontend/app/locales/en.json`

### 17.5 参考资料

- 阿里云百炼《万相 3.0 视频生成 API 参考》：
  <https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference>
- 阿里云百炼《万相 3.0 视频生成》：
  <https://help.aliyun.com/zh/model-studio/wan3-video-generation-guide>
- 阿里云百炼《视频生成与编辑》模型对比：
  <https://help.aliyun.com/zh/model-studio/video-generate-edit-model/>
- 火山方舟《创建视频生成任务》：
  <https://docs.volcengine.com/docs/82379/1520757>
- 火山方舟《Seedance 2.0 系列》：
  <https://docs.volcengine.com/docs/82379/2291680>
- 项目内本地 H3 shim：
  `local-h3/scripts/shim.py`（`parse_content`、`capabilities`、`frames_for`）
- 项目内火宝网关快速配置：
  `frontend/app/pages/settings.vue`（`/qwen`、`/volcengine`、`/minimax`）
