# 按设定生成环境声 / 音效 / 群众声 / BGM 设计

- 日期：2026-11-06
- 状态：待评审
- 适用版本：V3 配音与混音工作台
- 关联代码：`backend/src/services/mix-plan.ts`、`backend/src/services/audio-separation.ts`、`backend/src/services/adapters/comfyui.ts`、`backend/src/routes/mix.ts`、`frontend/app/components/MixStage.vue`

## 1. 背景

混音工作台当前的「添加轨道」只创建空轨，轨道的 `ambience / sfx / crowd / bgm` 角色只是标签，不会读取剧本、场景或分镜设定，也不会生成音频。用户需要基于已有设定自动生成：

- 背景声 / 环境声：场景底噪、天气、空间氛围。
- 场景音效：分镜中描述的动作音、物体音、环境事件。
- 群众声：人群嘈杂声，或把已配音的群众台词归入独立轨道。
- BGM：整集配乐铺底（可选）。

生成结果必须直接进入混音工作台：自动建轨、按场景时间放置片段、参与试听/导出，并且不破坏原声分离、虚拟对白轨、BGM 虚拟轨等现有逻辑。

## 2. 目标与非目标

### 2.1 目标

1. 从剧集、场景、分镜、台词设定编译出可复现的声音生成计划。
2. 通过本地 ComfyUI + Stable Audio Open 生成音频，入库为 `episode_audio_assets`。
3. 自动创建四类生成轨并把片段放到正确时间点。
4. 与现有混音计划、试听、导出、版本、素材删除逻辑兼容。
5. 支持按场景、整集铺底、仅生成素材三种模式。
6. 群众声支持「嘈杂声（walla）」与「复用已配音群众台词」两种方式。
7. 失败可隔离、可取消、可重试，不因单个场景失败中断整集。

### 2.2 非目标

- 不修改 TTS 服务，不重新合成群众台词。群众台词模式只复用已有的激活 Take；缺失则跳过并警告。
- 不做音乐编曲、旋律控制、歌词生成或人声歌曲。
- 不做声音克隆、口型同步、实时流式生成。
- 不新增云端音频生成供应商，首期仅支持 ComfyUI。
- 不自动修复没有分镜或没有合片的剧集；此类剧集返回明确错误。
- 不把生成结果写进原始合片视频，仍由混音/导出链路统一混音。

## 3. 声音分类与轨道映射

| 分类 | 内容 | 轨道角色 `role` | 总线 `bus` | 默认音量 | 说明 |
|---|---|---|---|---|---|
| `ambience` | 环境声、底噪、天气、空间氛围 | `ambience` | `original` | 0.7 | 与视频原声共存，不替代原声床 |
| `sfx` | 动作音、物体音、事件音 | `sfx` | `sfx` | 0.8 | 每个场景最多一个生成项 |
| `crowd` | 人群嘈杂声或群众台词 | `crowd` | `dialogue` | 0.5 | 台词模式会从虚拟对白轨排除对应台词 |
| `bgm` | 配乐铺底 | `bgm` | `bgm` | 1.0 | 生成 BGM 轨存在时，不再叠加合片虚拟 BGM |

生成轨统一带 `origin = 'soundscape'`，用于：

- 识别自动生成轨，避免与用户手工轨混淆。
- 修正原声床判断：生成的环境声不得让合片原声床被错误关闭。
- 重跑时只重建生成轨，不碰用户轨。

## 4. 用户流程

1. 进入剧集「预览与混音」工作台，点击工具栏「生成声音」。
2. 在弹窗选择：
   - 模式：按场景 / 整集铺底 / 仅生成素材。
   - 类别：环境声、场景音效、群众声、BGM（BGM 可选）。
   - 群众声方式：嘈杂声 / 复用已配音台词。
   - 范围：全部场景或指定场景。
   - 是否覆盖已生成素材。
3. 点击「预览」查看将生成的项目数、预计时长、缺失配音的群众台词警告；可展开高级项修改单个提示词。
4. 点击「开始生成」，弹窗显示进度；期间禁用保存混音与导出。
5. 完成后自动刷新混音计划，时间线出现「环境声（AI）」「场景音效（AI）」「群众声（AI）」「配乐（AI）」轨及片段。
6. 用户可试听、调音量/声像/淡入淡出、静音、独奏；重新生成会重建对应生成轨上的片段。

## 5. 生成模式

### 5.1 按场景（默认）

- 环境声、场景音效、群众声：每个场景各一个编排项；群众声在台词模式下不生成音频，只做台词归轨。
- BGM：整集一个铺底项，不按场景切分，避免段落风格跳变。
- 场景时间范围来自合片后的绝对时间轴：该场景所有分镜的起止并集。

### 5.2 整集铺底

- 环境声、BGM：各一个生成项，覆盖整集时间轴；音频不足时片段 `loop = true`。
- 场景音效、群众声：仍按场景放置，不做整集合并。
- 适用场景：希望全片统一底噪与配乐，只让音效/群众声跟随场景。

### 5.3 仅生成素材

- 只生成并入库素材，不建轨、不建片段。
- 素材可在现有素材列表中查看和删除。
- 之后重新以「按场景」执行时，命中缓存的素材会直接复用，不重复生成。
- 群众声若选择「复用已配音台词」，该模式没有可入库素材，预览时跳过并提示；需要归轨时请使用「按场景」模式。

## 6. 总体架构

```
MixStage「生成声音」
  └─ POST /episodes/:id/audio/soundscape/preview
       └─ soundscape-compiler
            ├─ previewTimeline（绝对时间轴）
            ├─ 场景 / 分镜 / 台词设定
            └─ 文本模型（可降级为确定性模板）

  └─ POST /episodes/:id/audio/soundscape
       └─ soundscape 服务
            ├─ dubbing_jobs（kind=soundscape）记录任务
            ├─ comfyui-audio 适配器
            │    ├─ 提交工作流（占位符注入）
            │    ├─ 轮询 history
            │    ├─ 下载音频到项目目录
            │    └─ ffprobe / loudnorm
            ├─ episode_audio_assets 入库（kind=soundscape）
            └─ 自动建轨 + 片段放置
                 └─ compileMixPlan 重新编译
```

模块职责：

| 文件 | 职责 |
|---|---|
| `backend/src/services/soundscape-compiler.ts` | 时间轴切片、设定整理、提示词编译、规则降级 |
| `backend/src/services/adapters/comfyui-audio.ts` | 音频工作流注入、提交、轮询、产物提取、下载 |
| `backend/src/services/soundscape.ts` | 任务编排、缓存、进度、取消、建轨、片段放置 |
| `backend/src/routes/mix.ts` | 新增 soundscape 路由、错误映射、保存互斥 |
| `frontend/app/components/MixSoundscapeDialog.vue` | 生成参数与预览弹窗 |
| `frontend/app/components/MixStage.vue` | 入口、进度、生成轨标识 |
| `frontend/app/composables/useMixStage.ts` | 启动、轮询、取消、刷新计划 |
| `frontend/app/composables/useApi.ts` | soundscape API 封装 |
| `frontend/app/pages/settings.vue` | `audio-gen` 服务配置 |

## 7. 数据模型

### 7.1 音轨增加来源字段

`episode_audio_tracks` 增加：

```ts
origin: text('origin') // 'soundscape' | null
```

- Drizzle 定义与 SQLite `CREATE TABLE` 同步增加。
- 旧库通过现有 `trackWorkbenchColumns` 机制 `ALTER TABLE ... ADD COLUMN origin TEXT`。
- 该字段只由服务端写入；前端保存混音计划时不允许修改。
- 现有 `saveMixPlan` 更新轨时不在 `values` 中写 `origin`，因此已有值会保留；新建轨默认 `null`。

### 7.2 生成素材

复用 `episode_audio_assets`，不新建表：

- `kind = 'soundscape'`
- `engine = 'stable-audio-open'`（来自配置）
- `model / modelLicense` 来自 `audio-gen` 配置
- `sourceHash` 作为缓存键
- `metadataJson`：

```json
{
  "category": "ambience",
  "mode": "scenes",
  "sceneId": 12,
  "storyboardId": null,
  "itemId": "ambience:scene:12",
  "prompt": "English prompt",
  "negativePrompt": "English negative",
  "seconds": 45,
  "seed": 123456,
  "workflowHash": "sha256",
  "normalized": true,
  "degraded": false
}
```

`sourceHash` 计算内容：

```ts
sha256(JSON.stringify({
  episodeId,
  itemId,
  category,
  sceneId: sceneId ?? null,
  storyboardId: storyboardId ?? null,
  prompt,
  negativePrompt,
  seconds,
  seed,
  model,
  normalizeLoudness,
  workflowHash,
}))
```

- 相同哈希且 `status='ready'` 且未删除的素材直接复用。
- 提示词覆盖会改变哈希，因此覆盖生成不会误用旧素材。
- 不同剧集即使提示词相同也不共享素材，避免时间与上下文错配。
- `seed` 未在配置中固定时，不能每次随机，否则缓存永远不命中。按 `sha256(episodeId:itemId:prompt:seconds:model:workflowHash)` 取前 8 位十六进制转整数，再对 `2^31 - 1` 取模，作为该生成项的确定性种子；写入 `metadataJson.seed` 并参与 `sourceHash`。配置了 `seed` 时所有项共用该固定值。
- `normalizeLoudness` 参与哈希：切换响度归一化后不复用旧文件。

### 7.3 任务记录

复用 `dubbing_jobs`：

- `kind = 'soundscape'`
- `status`: `pending | running | completed | failed | cancelled`
- `payloadJson`: 规范化后的请求参数（模式、类别、场景、群众模式、覆盖项、配置 ID）
- `resultJson`: `{ assetIds, trackIds, clipCount, counts, warnings }`
- `step`: 面向用户的中文步骤，如「生成 环境声 · 场景 2/9」
- `progress`: 0–100

同一剧集同时只允许一个 `soundscape` 任务；内存 `active` Map 保存取消标记与当前 `prompt_id`。

## 8. AI 服务配置

### 8.1 新增服务类型

`backend/src/services/ai.ts`：

```ts
export type ServiceType = 'text' | 'image' | 'video' | 'audio' | 'audio-gen'
officialProviders['audio-gen'] = ['comfyui']
```

- TTS 仍读取 `audio` 类型，行为不变。
- `audio-gen` 只用于环境声/音效/群众声/BGM。

### 8.2 ComfyUI 配置字段

`ai_service_configs.settings` 使用与现有 ComfyUI 图片/视频一致的 snake_case 键（`backend/src/services/adapters/comfyui.ts` 的 `readComfySettings` 已按此读取）：

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `workflow` | 是 | 无 | ComfyUI API 格式工作流 JSON |
| `output_node` | 否 | 自动扫描 | 输出节点 ID |
| `output_key` | 否 | `audio` | 音频输出键，兼容 `audios` |
| `negative_prompt` | 否 | 空 | 注入 `__NEGATIVE_PROMPT__` |
| `seed` | 否 | 按生成项确定性派生 | 固定种子便于复现 |
| `timeout_ms` | 否 | 600000 | 单项最长等待时间 |
| `normalize_loudness` | 否 | true | 生成后做响度归一化 |
| `model_license` | 否 | `stability-ai-community` | 写入素材，便于追溯 |

模型名不新增 `provider_settings.model` 字段：与图片/视频一致，运行时 `AIConfig.model` 取该配置 `model` JSON 数组的首位（`backend/src/services/ai.ts:92`），即设置页模型列表的第一项，注入 `__MODEL__`。适配器扩展 `ComfyUiSettings`，增加 `timeoutMs / normalizeLoudness / modelLicense` 三个归一化字段。

工作流占位符：

- `__PROMPT__`：必填，正向提示词。
- `__NEGATIVE_PROMPT__`：负向提示词。
- `__AUDIO_SECONDS__`：目标秒数（数值型，见 10.1）。
- `__SEED__`：种子（数值型，见 10.1）。
- `__MODEL__`：模型名。

保存校验（后端为准，前端做同样校验以即时提示）：

- `backend/src/routes/aiConfigs.ts` 的 `validateProviderSettings` 增加 `provider === 'comfyui' && serviceType === 'audio-gen'` 分支：`workflow` 必填且必须是合法节点对象，序列化文本必须包含 `__PROMPT__`。
- `officialProviders['audio-gen'] = ['comfyui']`，否则 POST/PUT 配置会先被 `isOfficialProvider` 拒绝。
- 其余 ComfyUI 配置沿用现有 settings ≤ 200KB 限制。

探针复用现有 `/system_stats`，不触发音频生成。

### 8.3 设置页

- 服务类型新增「音频生成」。
- 供应商仅列出 ComfyUI。
- 复用 ComfyUI 表单区域，增加音频输出节点、输出键、模型、负向提示词、超时、响度归一化字段。
- 四种语言补充文案键。

## 9. 场景切片与提示词编译

### 9.1 前置条件

- 必须已合片，`previewTimeline(episodeId, dramaId).totalDurationMs > 0`。
- `previewTimeline` 只纳入已有 `videoUrl || composedVideoUrl`、文件存在且 `probeDurationMs > 0` 的分镜；没有可用视频的分镜不会产生时间片段，编译器跳过并写入警告。
- 至少有一个场景和分镜。
- 不满足时返回 400：
  - `请先完成合片，生成声音需要整集时间轴`
  - `当前剧集没有可用的场景或分镜`

### 9.2 时间轴切片

- `previewTimeline` 目前只返回 `cues / totalDurationMs`，没有分镜位置。需要给 `backend/src/services/timeline.ts` 的 `TimelineResult` 增加 `clips`（附加字段，不改变现有消费方）：

```ts
export interface TimelineClipPosition {
  storyboardId: number
  startMs: number
  endMs: number
  durationMs: number
}
// TimelineResult 增加：clips: TimelineClipPosition[]
```

- `buildTimeline` 内部已构建 `clipStart` 映射，直接把它转成数组返回；`previewTimeline` 无需改签名。
- 存在已完成合片时，`previewTimeline` 已把分镜片段缩放到合片总时长，`clips` 的位置与缩放结果一致。
- 编译器另查一次 `storyboards`（`episodeId`、未删除），用 `storyboards.sceneId` 把分镜归到场景；`timeline.clips` 本身不含 `sceneId`，不能只靠它归组。
- 场景范围为所属分镜范围的并集。
- `sceneId` 为空的分镜不参与场景切片。
- 没有分镜或没有时长的场景跳过，并写入警告。
- 场景内分镜按 `storyboardNumber` 排序。
- 台词通过 `previewTimeline.cues` 取得绝对时间、说话人、文本和 `lineId`。

### 9.3 生成项

```ts
type SoundscapeCategory = 'ambience' | 'sfx' | 'crowd' | 'bgm'

interface SoundscapeItem {
  itemId: string                    // ambience:scene:12 / ambience:episode / sfx:scene:12 / crowd:scene:12 / bgm:episode
  category: SoundscapeCategory
  source: 'generate' | 'lines'      // lines 仅用于群众台词模式
  sceneId: number | null
  storyboardId: number | null
  startMs: number
  endMs: number
  seconds: number
  prompt: string
  negativePrompt: string
  loop: boolean
  lineIds: number[]                 // 群众台词模式使用
  degraded: boolean                 // 是否使用了无 LLM 的模板
}
```

规则：

- `itemId` 中，按场景项使用 `scene:<sceneId>`，整集项使用 `episode`。
- `ambience`：每场景一个，覆盖场景范围；整集铺底模式下覆盖整集。
- `sfx`：每场景最多一个，合并该场景所有分镜的 `soundEffect` 描述，避免一个分镜一次生成导致数量失控。
- `crowd`：
  - `walla`：每场景一个，覆盖场景范围。
  - `lines`：不生成音频；识别该场景中的群众台词，产出 `source='lines'` 的编排项。
- `bgm`：整集一个，覆盖整集；按场景模式也不拆分。

### 9.4 群众台词识别

`storyboard_lines.speakerType` 只有 `dialogue / narration / inner`，没有 `crowd`，因此采用两层识别：

1. 文本模型在编译场景时返回 `crowdLineIds`。
2. 模型不可用或未返回时，使用确定性规则筛选：
   - 说话人名称包含：`群众、人群、众人、路人、围观、士兵们、村民们、观众、记者、学生们、宾客们`。
   - 说话人名称以「们」结尾，且该台词没有绑定具体角色（`characterId` 为空）。
   - 台词文本包含 `众人|大家|人群|全场|齐声` 等群体提示，且说话人不是旁白。

识别结果只影响群众声编排，不修改台词本身。

### 9.5 文本模型编译

- 使用当前激活的 `text` 配置与 `callTextJson`。
- 每次最多 6 个场景，分批请求，避免单次输出过大。
- 输出结构：

```json
{
  "scenes": [
    {
      "sceneId": 12,
      "ambiencePrompt": "English ambience prompt",
      "sfxPrompt": "English sfx prompt",
      "crowdPrompt": "English crowd walla prompt",
      "bgmMood": "tense, nocturnal",
      "crowdLineIds": [101, 102]
    }
  ]
}
```

- 提示词要求：
  - 只输出英文提示词。
  - 环境声：连续、无对白、无音乐、空间一致，适合循环。
  - 音效：具体动作/物体/事件，短促，不含对白。
  - 群众嘈杂声：不可辨识的人声混合，不含清晰台词。
  - BGM：模型只返回简短情绪短语 `bgmMood`，由编译器统一拼成整集 BGM 提示词：`cinematic instrumental score, {去重后的 bgmMood 列表}, no vocals, subtle, loopable`。
- 模型输出解析失败时重试一次；仍失败则使用确定性模板，并标记 `degraded=true`。

### 9.6 确定性降级模板

不依赖 LLM，保证功能可用：

- 环境声：`ambient background, {time}, {location}, continuous room tone, no dialogue, no music, seamless`
- 音效：`sound effect, {soundEffect}, Foley, short, dry, no dialogue, no music`
- 群众声：`crowd walla, indistinct chatter, background crowd, no intelligible words, no music`
- BGM：`cinematic instrumental score, {mood}, no vocals, subtle, loopable`

内置小词典把常见中文时间/天气/地点词映射为英文：

- 时间：`白天 → day`、`夜/夜晚 → night`、`黄昏 → dusk`、`清晨 → dawn`。
- 天气：`雨 → rain`、`风 → wind`、`雪 → snow`、`雷 → thunder`。
- 地点：`街/街道 → street`、`室内 → indoor`、`森林 → forest`、`海边 → seaside`、`城市 → city`、`山村 → mountain village`。

词典未命中的中文细节直接丢弃；`degraded` 项在预览中提示「未使用文本模型，提示词为通用模板」。

### 9.7 时长限制

Stable Audio Open 单次约 45–47 秒：

| 分类 | 秒数 |
|---|---|
| 环境声 | 30–45，默认 45 |
| 场景音效 | 2–10，默认 5 |
| 群众嘈杂声 | 20–45，默认 30 |
| BGM | 30–45，默认 45 |

- 整集铺底或场景长于素材时，片段 `loop=true`。
- 片段结束时间不超过场景/整集结束；音效结束时间不超过所属分镜结束。

### 9.8 提示词覆盖

预览返回每个 `itemId` 和编译后的提示词。用户可覆盖：

```ts
overrides?: Array<{
  itemId: string
  prompt?: string
  negativePrompt?: string
  seconds?: number
}>
```

- 覆盖值参与 `sourceHash`，因此与缓存素材区分。
- 覆盖提示词长度上限 2000 字符，负向提示词 1000 字符。
- 覆盖秒数按 9.7 的范围夹取。

## 10. ComfyUI 音频适配器

新增 `backend/src/services/adapters/comfyui-audio.ts`，复用 `comfyui.ts` 的 `parseComfyWorkflow / unwrapComfyHistory / comfyHeaders / joinProviderUrl / comfySeed`，并扩展 `readComfySettings` 读取新增字段。不能用共享的 `applyWorkflowPlaceholders` 直接注入秒数与种子：该函数把所有值 `String()` 化（`comfyui.ts:69-88`），Stable Audio Open 的 `seconds` 是数值输入，字符串会被 ComfyUI 拒绝或静默截断。

### 10.1 提交

占位符注入使用适配器内的 `applyAudioWorkflowPlaceholders`：

- 遍历规则与共享函数一致，但当一个字符串值整体等于 `__AUDIO_SECONDS__` 或 `__SEED__` 时，替换为数值本身，而不是字符串。
- 其余占位符（`__PROMPT__ / __NEGATIVE_PROMPT__ / __MODEL__`）保持字符串；若占位符嵌在更长的文本中，仍按字符串拼接。
- 示例：工作流 `"seconds": "__AUDIO_SECONDS__"` → `"seconds": 45`；`"text": "duration __AUDIO_SECONDS__ s"` → `"duration 45 s"`。

```
POST {baseUrl}/prompt
{
  "prompt": { ...注入后的工作流... },
  "client_id": "huobao-soundscape"
}
```

响应必须包含 `prompt_id`；`node_errors` 或 `error` 直接转为可读错误。提交前按 `timeout_ms` 建立单项超时。`seed` 由编译器传入：配置固定值，或按 7.2 的确定性规则派生，适配器不再调用会随机的 `comfySeed`。

### 10.2 轮询

```
GET {baseUrl}/history/{prompt_id}
```

- 未完成：返回 `pending`。
- `status.status_str === 'error'`：返回失败原因。
- 完成但无音频输出：返回「工作流已完成，但输出节点没有音频产物」。
- 超时：返回 504 语义错误。

### 10.3 产物提取

- 优先扫描配置的 `output_key`（归一化为 `outputKey`，默认 `audio`），同时兼容 `audios`。
- 未配置 `output_node`（归一化为 `outputNode`）时扫描所有节点。
- 识别扩展名：`wav / mp3 / flac / ogg / m4a / aac`。
- 忽略图片、视频、文本输出。

### 10.4 下载与落盘

```
GET {baseUrl}/view?filename=...&subfolder=...&type=output
```

- 只允许从已配置的 ComfyUI `baseUrl` 下载，不接受任意 URL。
- 保存目录：`static/projects/<dramaId>/audio/soundscape/`
- 文件名：`<sourceHash 前 16 位>.<ext>`，避免用户输入进入路径。
- 下载后 `ffprobe` 校验时长；失败则素材标记 `failed`。
- 响度归一化开启时，用 FFmpeg `loudnorm=I=-18:TP=-2:LRA=11` 输出最终文件；失败则保留原始文件并记录 `normalized=false`。

### 10.5 取消

- 内存取消标记在每个轮询周期检查。
- 已知 `prompt_id` 时，best-effort 调用 `POST {baseUrl}/queue`，请求体 `{ "delete": [prompt_id] }`；失败不影响取消结果。
- 取消后不再下载、不再建轨。

## 11. 任务编排

### 11.1 启动

`startSoundscape(episodeId, options)`：

1. 校验剧集、合片时间轴、场景、类别。
2. 若已有运行中的 soundscape 任务，返回 409「当前剧集正在生成声音」。
3. 编译计划（预览与启动共用同一编译函数）。
4. 应用覆盖项。
5. 写入 `dubbing_jobs`，`status='running'`，`progress=0`。
6. 后台异步执行，路由立即返回 `jobId`。
7. 生成器通过可选依赖注入，默认使用 ComfyUI 适配器，测试时可替换为假生成器。

### 11.2 单项执行

按类别顺序：环境声 → 场景音效 → 群众声 → BGM；同类按场景顺序。

对每个 `source='generate'` 的项：

1. 计算 `sourceHash`。
2. 若 `overwrite=false` 且存在同哈希可用素材：复用，`reused++`。
3. 否则调用 ComfyUI 生成、下载、校验、归一化。
4. 插入 `episode_audio_assets`，`status='ready'`。
5. 更新任务进度与 `step`。

单项失败：

- 记录警告，继续下一项。
- 全部失败时任务 `failed`；部分成功时任务 `completed` 并带 warnings。

对 `source='lines'`：

- 不生成音频。
- 查找每条台词的激活 Take；有音频则生成片段数据，无音频则警告「第 N 句群众台词尚未配音」。
- 不修改 TTS、不调用 TTS；该项仍计入 `done`，只统计警告。

### 11.3 结束

- 若模式不是 `assets-only`：确保生成轨存在，重建对应类别的生成片段。
- `resultJson` 写入素材 ID、轨道 ID、片段数、复用数、警告。
- `progress=100`，`status='completed'`。
- 完成后前端刷新 `GET /episodes/:id/mix`。

### 11.4 取消与重启

- 取消：设置标记，任务 `status='cancelled'`，保留已生成素材，不建轨。
- 服务重启：查询状态时若发现 `status='running'` 且内存无活动任务，标记失败「服务重启导致任务中断，请重新生成」，与分离任务一致。

### 11.5 并发

- 每集同时只允许一个 soundscape 任务。
- 对同一 ComfyUI 配置全局串行，避免 Stable Audio Open 并发打爆显存。
- 视频生成与音频生成共享 ComfyUI 队列；音频任务可能排队，进度文案显示「等待 ComfyUI 队列」。

## 12. 自动建轨与片段放置

### 12.1 轨道

每个类别每集一条生成轨：

| 类别 | 名称 | kind | role | bus key | 颜色 | sortOrder |
|---|---|---|---|---|---|---|
| 环境声 | 环境声（AI） | `ambience` | `ambience` | `original` | `#0ea5e9` | 现有最大 + 1 |
| 场景音效 | 场景音效（AI） | `sfx` | `sfx` | `sfx` | `#a78bfa` | + 2 |
| 群众声 | 群众声（AI） | `voice` | `crowd` | `dialogue` | `#f59e0b` | + 3 |
| 配乐 | 配乐（AI） | `bgm` | `bgm` | `bgm` | `#22c55e` | + 4 |

- 查找已有轨：`episodeId + origin='soundscape' + role`。
- 已存在则复用，保留用户调整过的音量、声像、静音、独奏等。
- 新建时音量按第 3 节默认值，`ducking=true`。
- `busId` 必须用 `ensureDefaultBuses(episodeId)` 返回的数据库 ID，不能用总线 key。
- `backend/src/services/audio-tracks.ts` 的 `AudioTrackInput` 增加可选 `origin?: string | null`，`createAudioTrack` 插入该字段；`updateAudioTrack` 忽略 `origin`，防止客户端篡改。
- `backend/src/routes/audio-tracks.ts` 的新建/更新路由不转发 `body.origin`；只有 soundscape 服务内部传 `origin='soundscape'`。

### 12.2 片段

- 环境声/群众嘈杂声/BGM：`startMs = 场景或整集起点`，`endMs = 场景或整集终点`，素材短于目标时 `loop=true`。
- 场景音效：`startMs = 场景内第一个分镜起点 + 150ms`，`endMs = min(起点 + 秒数, 分镜终点)`；不足 500ms 的片段跳过并警告。
- 群众台词：`startMs = cue.startMs`，`endMs = cue.startMs + 激活 Take 时长`；引用 `takeId / lineId / audioUrl`，不生成新素材。
- 淡入淡出：
  - 环境声/音效/群众声：`fadeInMs=300`、`fadeOutMs=300`。
  - BGM：`fadeInMs=800`、`fadeOutMs=800`。
  - 覆盖整集、起点为 0 的铺底片段不做淡入（`fadeInMs=0`）；终点等于整集终点的铺底片段不做淡出（`fadeOutMs=0`）。
- `sourceStartMs=0`、`gainDb=0`。
- 片段名：`场景 N · 环境声`、`场景 N · 音效`、`群众台词 · 说话人`、`整集配乐`。

### 12.3 幂等

- 每次重新生成时，按类别重建：该类别至少有一个生成项成功或复用时，才删除该类别生成轨上的旧片段并按编译结果重建；该类别的生成项全部失败时保留旧片段，只写入警告。
- 生成轨专属于自动生成，用户手工调整的生成片段会在重跑时重置；弹窗文案明确提示。
- 用户自建轨、分离轨、虚拟轨完全不受影响。
- `assets-only` 模式不删除、不创建任何轨道或片段。

## 13. 混音计划兼容

### 13.1 原声床判断

当前逻辑：

```ts
const hasOriginalUserTrack = tracks.some((track) => (
  track.role === 'original' || track.role === 'ambience' || track.busId === 'original'
))
```

生成的环境声轨也满足该条件，会错误关闭合片原声床。修改为：

```ts
const hasOriginalUserTrack = tracks.some((track) => (
  track.origin !== 'soundscape'
  && (track.role === 'original' || track.role === 'ambience' || track.busId === 'original')
))
```

- `MixTrack` 增加 `origin: string | null` 并随计划返回前端；虚拟轨 `origin` 为 `null`。
- 生成的环境声与原声床共存；用户可静音原声床或环境声轨。

### 13.2 虚拟对白轨排除群众台词

`buildVirtualDialogueTrack` 增加排除集合：

```ts
buildVirtualDialogueTrack(episodeId, timeline, excludedLineIds)
```

- 排除集合来自 `episode_audio_clips` 与 `episode_audio_tracks` 的连接：`origin='soundscape' && role='crowd' && lineId != null`。
- 被放入群众轨的台词不再出现在虚拟对白轨，避免重复播放。
- 删除群众轨或群众片段后，对应台词自动回到虚拟对白轨。
- 虚拟对白轨仍然只读，不写库。

### 13.3 BGM 虚拟轨

- `hasBgmUserTrack` 保持现有逻辑：存在生成 BGM 轨时不再叠加合片虚拟 BGM。
- 用户删除生成 BGM 轨后，虚拟 BGM 自动恢复。

### 13.4 保存计划

现有前端保存载荷已经包含 `assetId / takeId / lineId / audioUrl`，后端 `saveMixPlan` 会重建这些字段。本次需要：

- 更新轨道时不得覆盖 `origin`；现有 `values` 已不包含该字段，补充回归测试。
- 新建轨默认 `origin=null`，客户端无法伪造生成轨。
- 生成任务运行期间，`PUT /episodes/:id/mix` 返回 409「声音生成中，暂不能保存混音」，避免前端旧状态覆盖刚生成的片段。
- 前端在 `soundscapeRunning` 时禁用保存与导出按钮。

### 13.5 素材删除

`deleteEpisodeAsset` 当前只清理 `stemAssetId` 指向该素材的轨道，不会清理普通片段对 `assetId` 的引用。增加：

1. 删除所有 `episode_audio_clips.assetId = assetId` 的片段。
2. 若生成轨因此变空，保留空轨，方便重新生成。
3. 再软删除素材。

### 13.6 素材自动建轨排除

`autoCreateStemTracks` 不应处理 `kind='soundscape'` 的素材，避免把生成素材误当成未知分离 stem 创建 `A4 soundscape` 自定义轨。

## 14. API

统一前缀：`/api/v1/episodes/:id/audio/soundscape`

### 14.1 预览

```
POST /preview
```

请求：

```json
{
  "mode": "scenes",
  "categories": ["ambience", "sfx", "crowd"],
  "crowdMode": "walla",
  "sceneIds": [12, 13],
  "overwrite": false,
  "overrides": []
}
```

响应：

```json
{
  "code": 0,
  "data": {
    "mode": "scenes",
    "items": [
      {
        "itemId": "ambience:scene:12",
        "category": "ambience",
        "source": "generate",
        "sceneId": 12,
        "storyboardId": null,
        "startMs": 0,
        "endMs": 18000,
        "seconds": 45,
        "loop": true,
        "prompt": "ambient background, night, street, ...",
        "negativePrompt": "dialogue, music",
        "degraded": false,
        "cached": false
      }
    ],
    "warnings": [],
    "counts": { "total": 9, "generate": 9, "lines": 0, "cached": 0 },
    "estimatedSeconds": 270
  }
}
```

- 预览不调用 ComfyUI。
- 无文本模型时仍可预览，`degraded=true` 并带警告。
- `estimatedSeconds` 仅用于 UI 提示，按每项 30 秒估算。
- 预览结果按「剧集 + 规范化参数（含覆盖项、模型与工作流哈希、固定种子）哈希」在内存缓存 10 分钟；启动时参数完全一致则复用同一编译结果，保证预览提示词与实际生成一致，并避免重复 LLM 调用。覆盖项参与缓存键，因为覆盖会改变提示词、确定性种子与 `sourceHash`，不能复用未覆盖的旧计划。

### 14.2 启动

```
POST /
```

请求体同预览，可附带 `configId`；为空时使用当前激活的 `audio-gen` 配置。响应返回 `jobId / status`。

错误：

- 400：参数无效、未合片、无场景、无类别。
- 404：剧集不存在。
- 409：已有运行中的生成任务。
- 503：未配置 `audio-gen`。

### 14.3 状态

```
GET /status
```

```json
{
  "jobId": 42,
  "status": "running",
  "progress": 55,
  "step": "生成 环境声 · 场景 5/9",
  "error": null,
  "counts": { "total": 27, "done": 14, "failed": 1, "reused": 2, "clips": 0 },
  "warnings": ["场景 7 的群众台词尚未配音"]
}
```

- `status`: `idle | running | completed | failed | cancelled`
- 无任务时返回 `idle`。

### 14.4 取消

```
POST /cancel
```

- 无运行任务返回 409。
- 取消成功返回 `{ status: 'cancelled' }`。

### 14.5 现有接口调整

- `GET /episodes/:id/audio/assets`：返回的素材中包含 `kind='soundscape'` 与 `metadata`，前端可展示分类。
- `DELETE /episodes/:id/audio/assets/:assetId`：按 13.5 清理片段。
- `PUT /episodes/:id/mix`：任务运行中返回 409。

## 15. 前端

### 15.1 入口

`MixStage.vue` 工具栏增加「生成声音」按钮：

- 位置：现有「分离原声」按钮组之后。
- 无合片时禁用，提示「请先完成合片」。
- 生成中显示进度条与取消按钮，复用现有 `.mx-progress` 样式。

### 15.2 弹窗

`MixSoundscapeDialog.vue`：

- 模式分段选择：按场景 / 整集铺底 / 仅生成素材。
- 类别复选：环境声、场景音效、群众声、BGM；默认勾选前三项。
- 群众声方式：嘈杂声 / 复用已配音台词；仅勾选群众声时显示。
- 场景范围：全部 / 指定场景（多选列表，显示场景地点与时间）。
- 覆盖已生成素材：开关。
- 「预览」按钮：调用预览接口，展示项目数、预计时间、警告、可折叠的提示词列表；高级项可直接编辑单个提示词并作为 overrides 提交。
- 「开始生成」按钮：调用启动接口，关闭弹窗并进入工作台进度状态。

### 15.3 状态与刷新

`useMixStage.ts`：

- 新增 `soundscapeStatus / soundscapeRunning / soundscapePlan`。
- `startSoundscape / cancelSoundscape / previewSoundscape / pollSoundscape`。
- 轮询沿用分离任务的 `pollToken` 防卸载后复活机制。
- 完成后调用现有 `loadPlan()` 刷新轨道与片段；刷新完成前保持 `soundscapeRunning=true`，避免用户在刷新窗口内保存旧状态。
- 生成中禁用保存与导出。

### 15.4 轨道展示

- 生成轨名称后带「AI」徽标，依据 `origin === 'soundscape'` 判断。
- 生成轨可正常调音量、声像、静音、独奏、隐藏、锁定、重命名。
- 删除生成轨只删除轨道与片段，不删除素材；素材需在素材列表中单独删除。

### 15.5 设置页

`frontend/app/pages/settings.vue` 需要以下改动（现有设置页只处理 image/video 的 ComfyUI 分支）：

- 服务类型：`serviceTypes` 与 `serviceMeta` 增加 `audio-gen`，四语言补 `common.serviceType.audioGen` 与 `settings.ai.meta.audioGen`。
- 供应商预设：`providerPresets['audio-gen'] = { comfyui: { label: 'ComfyUI 本地音频工作流', baseUrl: 'http://127.0.0.1:8188', models: ['stable-audio-open-1.0'] } }`。
- 表单可见性：现有 `cfgForm.provider === 'comfyui' && (service_type === 'image' || 'video')` 的条件扩展到 `audio-gen`，并为其显示：workflow、`output_node`、`output_key`（占位符 `audio`）、`negative_prompt`、`seed`、`timeout_ms`、`normalize_loudness` 复选框、`model_license`；不显示 `fps`。
- `CFG_SETTING_KEYS`：为 `audio-gen + comfyui` 返回 `['workflow','output_node','output_key','negative_prompt','seed','timeout_ms','normalize_loudness','model_license']`，与图片/视频分支并列。
- `emptyProviderSettings()`：增加 `timeout_ms: '600000'`、`normalize_loudness: true`、`model_license: 'stability-ai-community'`。
- `collectProviderSettings()`：数值键列表加入 `timeout_ms`（正整数校验）；布尔值走现有 boolean 分支；`workflow` 已有 JSON 对象校验，追加 `cfgForm.service_type === 'audio-gen'` 时必须包含 `__PROMPT__` 的校验与文案键。
- 模型列表即 `__MODEL__` 来源：第一位为默认模型，文案提示 `stable-audio-open` 系列。
- 保存后仍走现有 POST/PUT `/ai-configs`，后端 `validateProviderSettings` 做同样的 workflow/占位符校验。

### 15.6 文案

四种语言新增键，前缀 `mix.soundscape.*`：

- `title`、`entry`、`modeScenes`、`modeEpisodeBed`、`modeAssetsOnly`
- `categoryAmbience`、`categorySfx`、`categoryCrowd`、`categoryBgm`
- `crowdWalla`、`crowdLines`、`scopeAll`、`scopeSelected`
- `overwrite`、`preview`、`start`、`cancel`、`close`
- `previewCount`、`previewEstimate`、`warnings`、`prompts`
- `running`、`completed`、`failed`、`cancelled`
- `needMerge`、`noScenes`、`noConfig`、`notConfigured`
- `degradedHint`、`linesMissingTake`、`rerunResetsClips`
- `saveBlocked`、`trackBadge`

## 16. 错误处理与降级

| 场景 | 行为 |
|---|---|
| 未配置 `audio-gen` | 启动返回 503；预览仍可看计划 |
| 文本模型不可用 | 使用确定性模板，`degraded=true` 并警告 |
| 文本模型输出非法 JSON | 重试一次，仍失败则降级 |
| ComfyUI 提交失败 | 单项失败，继续其他项；错误写入警告 |
| ComfyUI 排队超时 | 单项失败，提示「ComfyUI 等待超时」 |
| 输出无音频 | 单项失败，提示检查输出节点与输出键 |
| 下载失败 | 单项失败，不插入素材 |
| ffprobe 失败 | 单项失败，删除临时文件 |
| 单个场景无分镜 | 跳过并警告 |
| 群众台词无配音 | 跳过该句并警告，不调用 TTS |
| 全部生成项失败 | 任务 `failed`，保留已成功素材 |
| 服务重启 | 运行中任务标记失败，可重新生成 |
| 用户取消 | 保留已完成素材，不建轨 |

## 17. 安全与限制

- 单次最多 40 个场景、160 个生成项；超出返回 400。
- 提示词 2000 字符、负向提示词 1000 字符上限。
- 音频秒数夹取到 1–45 秒。
- 工作流沿用 settings ≤ 200KB 限制。
- 下载 URL 只能由配置的 ComfyUI 主机拼接，禁止用户提供任意 URL。
- 文件名由哈希生成，不拼接用户输入。
- 日志不打印 API Key、工作流全文或完整配置；只记录 `configId / itemId / promptHash / 错误摘要`。
- 生成素材占用磁盘，沿用现有素材删除接口；删除前必须清理引用片段。
- Stable Audio Open 模型许可由用户在配置中确认，素材记录 `modelLicense` 便于追溯。

## 18. 测试策略

### 18.1 后端单元测试

`backend/tests/soundscape-compiler.test.ts`：

- 合片时间轴缺失时抛 400。
- 只有存在视频文件的分镜参与切片，其余跳过并警告。
- 场景范围由分镜并集计算正确。
- 环境声/音效/群众声/BGM 项目数量与 `itemId` 正确。
- 音效合并同场景多个 `soundEffect`。
- BGM 始终整集一项。
- 时长夹取。
- 群众台词规则识别与 LLM 结果合并。
- 降级模板输出英文、`degraded=true`。
- 覆盖项改变提示词与 `sourceHash`。
- 未固定 seed 时同输入两次编译得到相同种子与 `sourceHash`。

`backend/tests/timeline.test.ts` 增补：

- `TimelineResult.clips` 返回每个分镜的 `startMs / endMs / durationMs`，累加与 `totalDurationMs` 一致。
- 传入 `totalDurationMs` 时的缩放位置正确。

`backend/tests/comfyui-audio.test.ts`：

- 占位符注入到字符串与数字输入：整串 `__AUDIO_SECONDS__ / __SEED__` 保持 number，嵌入文本时保持 string。
- 音频输出提取：`audio / audios`、扩展名过滤、指定输出节点。
- 工作流错误、节点校验错误、完成但无音频。
- 下载 URL 只使用配置主机。
- `readComfySettings` 读取 `timeout_ms / normalize_loudness / model_license`。

`backend/tests/soundscape.test.ts`：

- 用注入的假生成器跑完整任务：缓存复用、进度、结果统计。
- 单项失败不影响其他项；全部失败任务失败。
- `assets-only` 不建轨。
- 按场景模式创建四类轨与片段位置。
- 群众台词模式排除虚拟对白轨中的对应台词。
- 取消后不建轨。
- 重启恢复标记失败。
- 并发启动返回 409。
- 生成轨 `origin='soundscape'`，更新轨时不会被覆盖。

`backend/tests/ai-config-settings.test.ts` 增补：

- `audio-gen + comfyui` 缺少 workflow、workflow 非法、缺少 `__PROMPT__` 时保存返回 400。
- 合法 `audio-gen` 配置可保存并回读 `provider_settings`。

`backend/tests/mix-plan.test.ts` 增补：

- 生成环境声轨存在时，合片原声床仍然存在。
- 生成 BGM 轨存在时，虚拟 BGM 不出现。
- 保存计划后 `origin` 保留，片段 `assetId / lineId / audioUrl` 保留。
- 删除生成素材清理引用片段。

`backend/tests/soundscape-routes.test.ts`：

- 预览、启动、状态、取消。
- 未合片 400、无配置 503、运行中保存 409。

### 18.2 前端结构测试

`frontend/tests/soundscape-structure.test.mjs`：

- `MixStage.vue` 含「生成声音」入口、弹窗组件、进度条与取消。
- `MixSoundscapeDialog.vue` 含模式、类别、群众方式、预览、开始。
- `useApi.ts` 含四个 soundscape 路径。
- 四种语言均含 `mix.soundscape.*` 关键键与 `common.serviceType.audioGen`。
- `useMixStage.ts` 含轮询防复活 token。
- `settings.vue` 含 `audio-gen` 服务类型、ComfyUI 音频字段、`__PROMPT__` 校验与 `timeout_ms` 数值处理。

### 18.3 真实验证

在本地 ComfyUI（含 Stable Audio Open 工作流）上：

1. 配置 `audio-gen` 服务并通过探针。
2. 选择一部已合片剧集，预览并生成一个场景的环境声。
3. 确认素材文件存在、`ffprobe` 有时长、混音计划出现生成轨与片段。
4. 实时试听与导出各跑一次，确认原声床、对白、生成环境声同时存在。
5. 群众台词模式跑一次，确认对白轨不重复。
6. 取消与重跑各一次，确认状态与缓存行为。

真实 GPU 生成耗时依赖机器，测试记录模型、工作流、耗时与产物路径，不提交大文件。

## 19. 实施阶段

1. **数据与配置**：`origin` 字段、`audio-gen` 服务类型、ComfyUI 配置校验、设置页、四语言文案。
2. **编译与适配器**：时间轴切片、提示词编译、确定性降级、ComfyUI 音频适配器及单元测试。
3. **任务与路由**：任务编排、缓存、建轨、状态/取消/预览接口及集成测试。
4. **混音兼容**：原声床判断、群众台词排除、保存互斥、素材删除清理及回归测试。
5. **前端接入**：弹窗、入口、轮询、轨道徽标、保存/导出禁用、结构测试。
6. **真实链路验证**：ComfyUI 端到端、试听/导出、文档与执行日志。

## 20. 验收标准

1. 设置页可配置 `audio-gen` ComfyUI 服务并通过探针；工作流缺少 `__PROMPT__` 时保存被拒绝。
2. 已合片剧集可按场景生成环境声、音效、群众声；可选择 BGM。
3. 三种模式行为符合第 5 节；`assets-only` 不产生轨道与片段。
4. 生成完成后时间线自动出现对应生成轨，片段位于正确场景时间，可试听、调参、静音、独奏。
5. 生成环境声不会关闭合片原声床。
6. 群众台词模式下，被放入群众轨的台词不再出现在虚拟对白轨；删除群众片段后恢复。
7. 重新生成命中缓存时跳过重复生成；开启覆盖时重新生成。
8. 单项失败不中断整集；全部失败任务失败；取消后不建轨。
9. 生成期间保存混音返回 409，前端保存与导出按钮禁用。
10. 删除生成素材会清理引用片段，不留下不可播放的片段。
11. 后端单元/集成测试、前端结构测试、前端构建全部通过。
12. 真实 ComfyUI 链路完成一次生成、试听与导出验证。

## 21. 风险与边界

| 风险 | 影响 | 应对 |
|---|---|---|
| Stable Audio Open 单次约 45 秒 | 长场景需要循环，接缝可能可闻 | 片段 `loop=true`；首尾淡化；后续可增加交叉淡化 |
| GPU 与视频生成争用 | 音频任务排队或超时 | 全局串行、超时提示、可取消 |
| 提示词质量不稳定 | 声音与画面不匹配 | 预览可编辑提示词；重跑覆盖 |
| 无文本模型时降级 | 提示词细节丢失 | 英文模板 + 小词典；明确 `degraded` 警告 |
| 响度不一致 | 混音平衡困难 | 统一 `loudnorm -18 LUFS`，失败保留原文件并标记 |
| 群众台词重配音后片段过期 | 群众轨仍是旧音频 | 文案提示；重新执行群众声编排 |
| 生成片段被用户手工调整后重跑丢失 | 用户编辑丢失 | 弹窗明确「重跑会重建生成轨片段」 |
| 未合片剧集无法生成 | 功能不可用 | 入口禁用并提示先合片 |
| 素材磁盘增长 | 占用空间 | 素材列表删除；删除时清理片段 |
| 模型许可不明 | 商用风险 | 配置记录 `modelLicense`，由用户确认 |
