# 成片中心与混音 / 剪辑工作台重构设计

- 日期：2026-11-06
- 状态：待评审
- 适用版本：V3 剪辑与混音工作台
- 关联代码：
  - `backend/src/services/mix-plan.ts`
  - `backend/src/services/export-service.ts`
  - `backend/src/services/edit-bootstrap.ts`
  - `backend/src/services/edit-service.ts`
  - `backend/src/services/edit-plan.ts`
  - `backend/src/routes/merge.ts`
  - `backend/src/routes/dubbing.ts`
  - `frontend/app/views/drama/episode.vue`
  - `frontend/app/components/MixStage.vue`
  - `frontend/app/components/MixClipInspector.vue`
  - `frontend/app/components/DubbingStage.vue`
  - `frontend/app/components/edit/EditWorkbench.vue`
  - `frontend/app/components/edit/EditMediaLibrary.vue`
  - `frontend/app/components/edit/EditTimeline.vue`
  - `frontend/app/components/edit/EditClipInspector.vue`
- 取代关系：
  - 本设计取代《V3-剪辑工作台技术架构设计》ADR-05 中「最终成片导出唯一归属剪辑页」的结论；
  - 本设计取代 ADR-12 中「`episode_exports` 同时承担导出任务与成片目录」的结论；
  - 本设计扩展《2026-11-06-edit-workbench-s2-timeline-editing.md》的 S2 边界，新增帧级操作、右键菜单、字幕样式与服务端剪辑导出；S2 中「不做服务端渲染导出」的限制不再适用于本设计。

---

## 1. 背景与问题

当前工作台已经具备拼接、配音、混音、剪辑四条链路，但用户在真实使用中遇到七个直接阻塞：

| # | 用户问题 | 根因 |
| --- | --- | --- |
| 1 | 「预览与混音」不能选择「拼接导出」里的成片，导出也不回到成片列表 | 混音源固定取最近一次非混音合片或 `episode.video_url`；混音视频导出只写 `episode_exports`，不写 `video_merges` |
| 2 | 「剪辑工作台」也不能选择成片，导出不回成片列表 | 剪辑 bootstrap 按分镜铺轨；剪辑没有服务端导出流水线 |
| 3 | 混音属性面板充斥专业名词，小白看不懂 | 检查器按「片段 → 轨道 → 素材 → 总线」技术结构排列，增益、声像、总线、LUFS 直接暴露 |
| 4 | 混音设置里找不到「生成背景声」；「分离素材」挡住设置且不知道用途 | 生成入口只在顶栏和空态；分离素材卡片排在设置之前，且没有用途说明 |
| 5 | 剪辑只支持快捷键，不会用 | 没有右键菜单，没有可见的帧操作按钮 |
| 6 | 剪辑左侧是分镜列表而不是成片列表；删除/复制帧、插入图片、拉长都不生效 | 一个剪辑工程绑定一集而不是一部成片；没有帧级命令；没有图片素材；没有渲染器 |
| 7 | 字幕只能改文字和时间，不能改字体、样式、位置 | `EditSubtitleCue.style` 只有三个预设字符串，没有逐条外观覆盖 |

同时存在两个数据模型层面的结构问题：

1. **两套记录系统**：`video_merges` 是「拼接导出」页的成片列表；`episode_exports` 是渲染任务记录。混音和剪辑的导出结果只进后者，所以用户看不到。
2. **写入方分散**：`episodes.video_url` 目前由拼接、配音、导出、删除回退等多处写入，没有唯一的「当前成片」指针，容易竞态。

---

## 2. 目标与非目标

### 2.1 目标

1. 建立统一的**成片中心**：一集的所有可播放视频版本都出现在同一列表；拼接、混音、剪辑都从这里选源、向这里产出。
2. 混音工作台：
   - 可选择任意成片作为声音底片；
   - 面板按「整集设置 → 当前选中 → 可选素材 → 高级」重排；
   - 所有面向用户的文案去掉非必要专业词；
   - 「生成背景声」进入整集设置；
   - 「分离素材」改为可选的声音素材库，并明确说明用途；
   - 视频导出回写成片，音频/分轨导出仍只进导出历史。
3. 剪辑工作台：
   - 以成片为工程单位，左侧主列表是成片；
   - 提供右键菜单和不依赖快捷键的可见操作；
   - 支持帧级删除、复制当前帧、插入图片、拉长；
   - 支持字幕文本、时间、字体、样式、描边、背景、对齐、屏幕位置编辑；
   - 提供范围明确、结果可验证的服务端渲染导出。
4. 所有产出非破坏：每次导出新增一个成片版本，不覆盖旧成片；「设为当前成片」才改变剧集当前成片指针。
5. 保持现有端口、开关、TTS、ComfyUI 网关与其他工作流不变。

### 2.2 非目标

- 不做多视频轨自由叠加、画中画、蒙版、关键帧、调色曲线、跟踪；
- 不做转场实时预览与转场导出（本设计导出只支持硬切；旧计划里的转场字段保留但不承诺导出）；
- 不做滤镜 UI 与滤镜导出（计划字段保留，导出时给出「暂不支持」警告）；
- 不做云端协作、多人实时编辑、发布分发；
- 不做字幕 OCR、语音识别自动打轴、字幕回写台词本；
- 不替换 TTS 与 ComfyUI 音频生成链路；
- 不引入新的专业 NLE 内核；
- 不做 4K/60fps 导出；
- 不修改用户已有模型、服务、端口或密钥配置。

---

## 3. 术语与三层模型

| 术语 | 定义 | 存储 |
| --- | --- | --- |
| 成片 Film | 一个可播放的视频版本，带标题、时长、来源、字幕外挂文件 | `video_merges` |
| 成片中心 Film Hub | 一集成片的统一列表与操作（预览、设为当前、删除、选为混音/剪辑源） | 由 `video_merges` 派生 |
| 渲染任务 Render Job | 一次导出请求的执行记录：状态、进度、参数、产物、错误 | `episode_exports` |
| 剪辑工程 Edit Project | 针对某一部源成片的剪辑时间线、草稿与版本集合 | `edit_projects` + `episode_edit_drafts` + `edit_revisions` |
| 源成片 Source Film | 混音或剪辑所基于的成片 | `source_merge_id` |
| 当前成片 Current Film | 剧集对外展示、配音页和旧入口读取的成片 | `episodes.current_film_id`（权威）+ `episodes.video_url/subtitle_url`（兼容镜像） |

> 列名约定：`source_film_id` 与 `source_merge_id` 都指向 `video_merges.id`。`source_film_id` 用于混音请求、混音版本与导出参数；`source_merge_id` 用于成片行、剪辑工程与导出记录。

三层职责：

```text
video_merges（成片目录，持久资产）
      ▲ 投影（成功后新增一行）
episode_exports（渲染任务，过程记录）
      ▲ 引用
edit_projects（剪辑工程，按源成片隔离）
```

**唯一规则：**

- 成片只由 `video_merges` 表达；`episode_exports` 不再被任何页面当作成片列表读取。
- 渲染任务成功后才投影成片；失败、取消、纯音频导出不投影。
- 成片不可变：不覆盖 `merged_url`，只新增行；删除是软删除。
- 当前成片只有一个写入口：`POST /episodes/:id/films/:filmId/current`。

---

## 4. 成片中心

### 4.1 成片来源与类型

| `kind` | 含义 | `origin` | 是否进成片列表 | 说明 |
| --- | --- | --- | --- | --- |
| `concat` | 拼接成片 | `concat` 或 `legacy` | 是 | 手动拼接或自动生成的纯画面/原声合片 |
| `mix` | 混音成片 | `export` 或 `legacy` | 是 | 混音页导出的视频；旧配音链路产生的混音合片标 `legacy` |
| `edit` | 剪辑成片 | `export` 或 `legacy` | 是 | 剪辑页导出的视频 |
| `import` | 导入成片 | `import` 或 `legacy` | 是 | 预留；本期不提供导入入口 |
| `stems` / 音频导出 | — | — | 否 | 仍只记录在 `episode_exports` |

历史数据归并：

- 现有 `video_merges` 中 `kind='comfyui'`、`kind='motion'` 或 `kind IS NULL` 的行迁移为 `kind='concat'`，显示为拼接成片；已经是 `mix` / `edit` / `import` 的行保持原 kind；
- 所有迁移前已存在的行统一写 `origin='legacy'`；只有迁移后新建的行写 `concat` / `export` / `import`；
- 不合并、不删除任何历史行；
- 迁移只做一次，以 `kind` 与 `origin` 是否已回填作为幂等判断。

展示文案：

- `concat` → 拼接成片
- `mix` → 混音成片
- `edit` → 剪辑成片
- `origin=legacy` 的 `mix` → 历史混音成片

### 4.2 数据模型变更

#### `video_merges` 新增列

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `origin` | TEXT | `concat` / `export` / `import` / `legacy`；默认 `legacy` |
| `source_merge_id` | INTEGER | 混音/剪辑的源成片 |
| `export_id` | INTEGER | 产生该成片的渲染任务；拼接成片为空 |
| `edit_revision_id` | INTEGER | 剪辑导出时的版本快照 |
| `mix_revision_id` | INTEGER | 混音导出时的版本快照 |
| `plan_hash` | TEXT | 剪辑/混音计划哈希，便于追溯（2026-11-07 实施裁定：`planHashOf.subtitleRows` 的字幕哈希行包含逐条 `cue.appearance ?? null`——否则 cue 级外观编辑会产生陈旧哈希，已由 `edit-hashes.test.ts` 锁定） |
| `subtitle_burned` | INTEGER | 画面是否已烧录字幕；0/1，默认 0 |

唯一性：

- `export_id` 非空时唯一（一部渲染任务最多投影一部成片）；
- 软删除行不参与唯一冲突判断，通过部分索引实现。

`video_merges.duration` 现有单位是**秒**，不是毫秒；成片 API 的 `duration_ms` 由 `duration × 1000` 得出，历史空值返回 0 并标记 `duration_unknown=true`。

#### `episodes` 新增列

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `current_film_id` | INTEGER | 当前成片指针，权威字段 |
| `mix_source_merge_id` | INTEGER | 混音页上次选择的源成片 |
| `edit_project_id` | INTEGER | 剪辑页上次打开的工程 |

`current_film_id` 迁移时按 `episodes.video_url = video_merges.merged_url` 回填；同一 URL 有多行时取最新一条未删除成片；匹配不到则置空，不猜测。

#### `episode_exports` 新增列

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `source_merge_id` | INTEGER | 本次渲染使用的源成片 |
| `film_id` | INTEGER | 成功后投影出的成片 |
| `project_id` | INTEGER | 剪辑导出所属工程 |

#### `mix_revisions` 新增列

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `source_film_id` | INTEGER | 该混音版本使用的源成片；旧版本为空 |

#### `edit_projects` 新表

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK | |
| `episode_id` | INTEGER NOT NULL | |
| `drama_id` | INTEGER NOT NULL | |
| `source_merge_id` | INTEGER | 源成片；旧工程为空 |
| `source_url` | TEXT | 源成片地址；旧工程可为空 |
| `source_fingerprint` | TEXT | 源文件指纹 |
| `title` | TEXT NOT NULL | 默认取源成片标题 |
| `status` | TEXT | `active` / `deleted`，默认 `active` |
| `created_at` / `updated_at` / `deleted_at` | TEXT | |

唯一性：

- `(episode_id, source_merge_id)` 在未删除且 `source_merge_id` 非空的记录中唯一；
- `(episode_id)` 在未删除且 `source_merge_id IS NULL` 的旧工程中唯一；
- 两个条件都用部分索引实现。

#### 现有剪辑表增加 `project_id`

- `episode_edit_drafts.project_id`：每个工程最多一份草稿；
- `edit_revisions.project_id`：版本按工程隔离；
- `edit_renders.project_id`：渲染缓存按工程隔离；
- `episode_exports.project_id`：导出记录按工程追溯。

新增列先允许为空，迁移回填后再要求新写入必须带 `project_id`。

索引迁移（必须与列迁移同一事务）：

- 删除 `idx_edit_drafts_episode`（`episode_edit_drafts(episode_id)` 唯一），否则一集只能有一份草稿；
- 新建 `idx_edit_drafts_project`：`episode_edit_drafts(project_id)` 唯一；
- 删除 `idx_edit_revisions_no`，新建 `idx_edit_revisions_project_no`：`edit_revisions(project_id, revision_no)` 唯一；
- 删除 `idx_edit_revisions_current`，新建 `idx_edit_revisions_project_current`：`edit_revisions(project_id, is_current)`；
- 删除 `idx_edit_renders_cache_key`，新建 `idx_edit_renders_project_cache`：`edit_renders(project_id, kind, cache_key)` 唯一，`WHERE project_id IS NOT NULL AND cache_key IS NOT NULL`；
- 以上旧索引名来自 `backend/src/db/sqlite-schema.ts`，必须按实际库内索引名幂等删除。

迁移规则：

1. 为每一集已有草稿或版本的剧集创建一个 `source_merge_id = NULL` 的旧工程，`source_url` 取当时的 `episodes.video_url` 或第一个分镜视频；
2. 把该集现有草稿、版本、渲染记录回填到旧工程；
3. 新打开的成片各自创建独立工程；
4. 不回写、不删除任何旧版本内容。

### 4.3 成片投影规则

视频渲染任务成功后，在同一个事务中：

1. 若 `episode_exports.film_id` 已存在，直接返回该成片（幂等）；
2. 插入 `video_merges`：
   - `kind`：混音导出为 `mix`，剪辑导出为 `edit`；
   - `origin='export'`；
   - `status='completed'`；
   - `merged_url` = 导出产物；
   - `duration` = 校验后的时长（秒，四舍五入；列单位沿用现有秒）；
   - `subtitle_burned`：字幕模式为 `burn` 时为 1，其余为 0；
   - `subtitle_url`：软字幕为外挂 SRT；混音 `copy` 模式复制源成片外挂字幕；`burn` / `none` 为 `NULL`，避免播放器重复叠加；
   - `source_merge_id` / `export_id` / `edit_revision_id` / `mix_revision_id` / `plan_hash` 来自任务；
   - 标题默认 `第 N 集 混音成片（YYYY-MM-DD HH:mm）` / `第 N 集 剪辑成片（…）`；
3. 更新 `episode_exports.film_id`；
4. 若任务 `set_current=true`，调用同一个「设为当前成片」内部函数，更新 `episodes.current_film_id/video_url/subtitle_url`。

投影类型归属：现有 `kind='video'` 视频导出（混音页与配音页入口）统一投影为 `kind='mix'`；只有剪辑页新导出端点投影为 `kind='edit'`。这样旧的配音页视频导出也会进入成片中心，不需要单独维护第二套列表。

拼接成片不经过导出投影：现有合片流程（`ffmpeg-merge`、`generation`、`motion-post`）仍直接写入 `video_merges`，新行显式写 `kind='concat'`、`origin='concat'`；完成时只能通过 `setCurrentFilm` 或「仅当 `current_film_id IS NULL`」的 bootstrap 更新当前指针，不得直接写 `episodes.video_url`。

失败处理：

- 投影失败不回滚已成功的视频文件；导出记录状态仍为成功，但 `film_id` 为空，界面提示「成片入库失败，可重试」；
- 提供内部幂等修复接口 `POST /episodes/:id/exports/:exportId/project-film`，只允许对已完成且产物存在的视频导出重试；
- 不提供批量历史回填；旧 `episode_exports` 视频记录不自动变成成片，避免一次迁移生成大量重复版本。

### 4.4 当前成片指针

- 权威字段：`episodes.current_film_id`；
- 兼容镜像：`episodes.video_url`、`episodes.subtitle_url`；
- 唯一写入口：`setCurrentFilm(episodeId, filmId)`；
- 拼接完成时，仅当 `current_film_id IS NULL` 才通过内部调用建立初始当前成片；已有当前成片不抢占；
- 其他模块只读，不再直接更新 `episodes.video_url`：
  - `setCurrentExport` 改为通过所属成片调用 `setCurrentFilm`；
  - 旧 `POST /episodes/:id/video-version` 保留为兼容别名，内部调用同一函数；
  - 删除当前成片返回 `409 FILM_IS_CURRENT`，要求先切换；
  - 删除非当前成片只软删除，不影响剧集指针；
  - 删除成片时，若存在指向它的未删除剪辑工程，同事务软删除该工程；仅当 `episodes.edit_project_id` 正指向该工程时清空它；草稿与版本保留，但不再从界面打开。

### 4.5 成片列表 API

#### `GET /episodes/:id/films?limit=50`

```ts
{
  episode_id: number
  current_film_id: number | null
  films: Array<{
    id: number
    title: string
    kind: 'concat' | 'mix' | 'edit' | 'import'
    origin: 'concat' | 'export' | 'import' | 'legacy'
    url: string
    subtitle_url: string | null
    duration_ms: number
    duration_unknown: boolean
    created_at: string
    is_current: boolean
    source_merge_id: number | null
    export_id: number | null
    edit_revision_id: number | null
    mix_revision_id: number | null
    edit_project_id: number | null
  }>
}
```

规则：

- 只返回 `status='completed'`、`merged_url` 非空、未软删除的成片；
- 默认按创建时间倒序，最多 50 条；
- `edit_project_id` 用于前端显示「已剪辑」并直接恢复工程；
- 不在此接口做音频流探测，避免列表变慢；音频状态在 `GET /films/:filmId` 中返回。

#### `GET /films/:filmId`

返回单个成片详情，额外包含：

```ts
{
  has_audio: boolean
  width: number | null
  height: number | null
  subtitle_burned: boolean
  subtitle_cues: number | null
  edit_project: { id: number; updated_at: string } | null
}
```

#### `POST /episodes/:id/films/:filmId/current`

```ts
// body 无
{ current_film_id: number, video_url: string, subtitle_url: string | null }
```

- 成片必须是 `completed` 且文件可读；不可读返回 `422 FILM_UNREADABLE`；
- 这是 `episodes.video_url/subtitle_url` 的唯一写路径。

#### `DELETE /films/:filmId`

- 非当前：软删除，返回 `{ deleted: true, deleted_project_id: number | null }`；
- 若存在指向该成片的剪辑工程，同事务软删除工程并返回其 id；
- 当前：`409 FILM_IS_CURRENT`，文案「这是当前成片，请先把其他成片设为当前」。

#### `PATCH /films/:filmId`

```ts
{ title: string } // 1–80 字
```

只允许改标题，不允许改文件与来源。

### 4.6 共享成片选择器

新增前端组件 `FilmPicker.vue`，三处复用：

> （2026-11-07 实施裁定：`FilmPicker.vue` 组件本体在混音工作台复用；拼接导出页按本表「现有卡片列表保持」保留自有卡片并新增「设为当前/在混音中打开/在剪辑中打开」动作；剪辑页左侧为成片列表组件。三处共享同一数据源 `filmAPI.list`（`GET /episodes/:id/films`），类型徽标、`当前`/`已剪辑` 徽标与右键动作口径一致。）

| 使用位置 | 形态 | 行为 |
| --- | --- | --- |
| 拼接导出页 | 现有卡片列表保持 | 增加「设为当前」「在混音中打开」「在剪辑中打开」 |
| 混音工作台 | 顶栏按钮 + 弹层 | 选择后重新编译混音计划 |
| 剪辑工作台 | 左侧主标签「成片」 | 选择后打开/创建该成片的剪辑工程 |

选择器卡片统一展示：

- 缩略图或首帧（无缩略图时用类型图标）；
- 标题；
- 类型徽标（拼接 / 混音 / 剪辑 / 导入）；
- 时长；
- 创建时间；
- `当前` 徽标；
- `已剪辑` 徽标（有工程时）；
- 右键菜单：打开剪辑、预览、设为当前、在混音中打开、重命名、查看导出记录（有 `export_id` 时）、删除（当前禁用；删除会级联软删除该成片的剪辑工程，需二次确认）。

---

## 5. 混音工作台

### 5.1 源成片选择

#### 默认规则

1. 若 `episodes.mix_source_merge_id` 指向的成片仍有效（未删除且 `completed`），使用它；
2. 否则优先当前成片，但仅当它是 `concat`；
3. 否则取最新一部 `concat` 成片；
4. 否则取最新一部非 `concat` 成片（含 `mix` / `edit` / `import`），显示「该成片已含配音/字幕，混音可能重复」警告；
5. 一部成片都没有时返回 `MIX_SOURCE_MISSING`，提示先去拼接导出生成成片，不自动静默创建。

> 第 4 步保证只有混音成片、没有拼接成片的剧集仍可继续混音；不因为缺少 `concat` 而把已有成片锁死。

#### 源类型与默认声音开关

| 源类型 | 原声床 | 虚拟对白轨 | 虚拟 BGM 轨 | 字幕 |
| --- | --- | --- | --- | --- |
| `concat` | 使用源成片音轨 | 默认开启 | 默认开启 | 源成片通常无字幕 |
| `mix` | 使用源成片音轨（已含对白） | **默认关闭** | **默认关闭** | 只复制外挂字幕，不重新烧录 |
| `edit` | 使用源成片音轨（已含剪辑后声音） | **默认关闭** | **默认关闭** | 只复制外挂字幕，不重新烧录 |
| 无音轨成片 | 无原声床，显示警告 | 默认开启 | 默认开启 | — |

选择非 `concat` 源时，顶栏和设置卡常驻提示：

> 这部成片已经包含配音或配乐。为避免人声重复，对白和配乐轨已默认关闭。需要单独调整人声时，请先用「提取声音素材」。

用户显式重新开启虚拟对白/BGM 时，二次确认，不阻止。

#### 持久化

- 当前选择写入 `episodes.mix_source_merge_id`；
- 混音版本 `mix_revisions.source_film_id` 记录该版本使用的源成片；
- `MixPlan.source` 记录源成片快照：

```ts
interface MixPlanSource {
  filmId: number
  kind: 'concat' | 'mix' | 'edit' | 'import'
  url: string
  durationMs: number
  hasAudio: boolean
  containsDialogue: boolean
  containsBgm: boolean
}
```

旧版本计划没有 `source` 时，读取时按旧逻辑推导，不批量重写。

### 5.2 混音页布局

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← 剧集   第 3 集 · 标题    源成片：第 3 集 拼接成片 ▾    已保存    导出        │
├───────────────────────────────────────────────┬──────────────────────────────┤
│ 预览（一个播放器、一个主时钟）                  │ 声音设置（默认展开）          │
│                                               │ 1. 这一集怎么听              │
│                                               │ 2. 当前选中                  │
│                                               │ 3. 声音素材库（可选，折叠）   │
├───────────────────────────────────────────────┤ 4. 高级（折叠）              │
│ 多轨时间线                                     │                              │
└───────────────────────────────────────────────┴──────────────────────────────┘
```

### 5.3 属性面板重排与小白文案

检查器顺序固定为：

1. **这一集怎么听**（整集设置，默认展开）
   - 源成片（只读显示 + 「更换」按钮）；
   - 三个大开关：`保留原声` / `使用配音对白` / `播放背景音乐`；
   - 每个开关下只显示一个「音量」滑杆；
   - 「生成背景声」按钮；
   - 「导出前检查」摘要。
2. **当前选中**（片段或轨道，默认展开）
   - 片段：名称、开始/结束、时长、音量、左右声道、开始渐强、结束渐弱、渐变方式；
   - 轨道：名称、用途、音量、左右声道、静音、只听这条、说话时自动降低背景音。
3. **声音素材库（可选）**（默认折叠）
   - 说明 + 「提取声音素材」按钮 + 素材列表 + 「放入时间线」。
4. **高级**（默认折叠）
   - 声音分组（对白/原声/音效/配乐/总输出）；
   - 整体响度、峰值限制；
   - 混音版本历史。
5. **添加轨道**（默认折叠，放在最后）。

文案对照：

| 旧文案 | 新文案 | 补充 |
| --- | --- | --- |
| 增益 / Gain | 音量 | 数值后保留 `dB` |
| 声像 / Pan | 左右声道 | 左 100 / 居中 / 右 100 |
| 淡入 / 淡出 | 开始渐强 / 结束渐弱 | |
| 曲线 / Curve | 渐变方式 | 柔和 / 线性 / 快速 |
| 总线 / Bus | 声音分组 | 对白、原声、音效、配乐、总输出 |
| 自动压低 / Ducking | 说话时自动降低背景音 | |
| Solo | 只听这条 | |
| Mute | 静音 | |
| LUFS / dBTP | 整体响度 / 峰值限制 | 只在高级显示 |
| 分离素材 / Stems | 从原声中提取的声音素材 | 见 5.5 |
| 混音路由 | 声音去向 | 只在高级显示 |

规则：

- 同一屏不同时出现「增益」和「音量」两种叫法；
- 专业数值不删除，但降级到高级区或数值后缀；
- 所有开关都带一句结果说明，不用只有术语的标签。

### 5.4 背景声生成入口

位置：整集设置卡片，第一屏可见，位于三个声音开关之后。

按钮：`生成背景声 / 环境声`

说明文案：

> 根据本集剧情和分镜，自动生成环境声、场景音效和群众声，放到新的声音轨道。不会覆盖你已有的声音，也不会改变画面。

规则：

- 需要已选择源成片且时长大于 0；
- 打开现有 `SoundscapeDialog`，不重做生成链路；
- 生成中显示进度条与取消按钮；
- 完成后 toast：「已生成 N 条背景声轨道」+「试听」+「撤销本次生成」；
- 生成期间只锁定生成相关操作，不锁音量、试听、保存；
- 分离任务运行时不阻止背景声入口（两者独立）；只有资源冲突时提示排队。

### 5.5 「分离素材」改为声音素材库

原「分离素材」不是混音设置，而是 UVR 提取出的人声/伴奏/环境声资产库。新设计：

- 位置：整集设置之后的「声音素材库（可选）」折叠卡；
- 默认折叠，不遮挡设置；
- 说明文案：

> 从原声中提取人声、伴奏等声音素材，方便单独调整或替换。提取不会自动改变当前混音；需要使用时，把素材放入时间线。

- 按钮：`提取声音素材`；
- 运行中：卡片内显示一行进度 + 取消，不再用整块卡片顶到最上面；
- 完成后：列出素材（类型、时长、来源），每项可试听、放入时间线、删除；
- 失败：卡片内显示原因与重试，不影响其他设置。

### 5.6 混音导出与回写

导出对话框：

| 字段 | 说明 |
| --- | --- |
| 源成片 | 只读，显示当前源 |
| 导出类型 | 视频成片 / 仅音频 / 分轨 ZIP |
| 视频预设 | 竖屏高清 / 横屏高清 / 跟随源成片 |
| 字幕 | 不添加 / 复制源成片外挂字幕（默认） |
| 标题 | 默认「第 N 集 混音成片（时间）」 |
| 设为当前成片 | 默认关闭 |

规则：

- 视频导出成功后新增一部 `kind='mix'` 成片，出现在成片中心；
- 不覆盖源成片；
- 音频和分轨导出不新增成片；
- 字幕模式只接受 `none` / `copy`：`copy` 不重新生成字幕，源成片有外挂 `subtitle_url` 时复制给新成片，没有则为空；
- 混音页不再提供硬字幕烧录，字幕由剪辑页负责；避免「混音烧一遍、剪辑再烧一遍」；
- 视频时长以源成片为准：
  - 混音计划比源成片长：导出前提示「超出部分将被截掉」，允许继续；
  - 混音计划比源成片短：音频补静音到源成片时长；
  - 源成片不可读：阻止导出；
- 导出完成后 toast：「已生成混音成片」+「查看成片」+「继续混音」。

### 5.7 混音 API 变更

| 方法 | 路径 | 变更 |
| --- | --- | --- |
| GET | `/episodes/:id/mix?source_film_id=` | 返回 `source_film` 与 `source_warnings` |
| PUT | `/episodes/:id/mix/source` | body `{ film_id }`，持久化并重新编译 |
| POST | `/episodes/:id/mix/revisions` | 写入 `source_film_id` |
| POST | `/episodes/:id/exports` | 视频导出增加 `source_film_id`、`project_id?`；字幕模式只接受 `none/copy`（`copy` 为新增模式，只复制源成片外挂字幕） |
| GET | `/episodes/:id/exports` | 返回 `film_id`，前端可跳转成片 |

> 导出前检查 `GET /episodes/:id/export-checks`（2026-11-07 实施裁定）：剧集没有任何成片时返回 **200 + 空检查**（`mixReady/videoReady/stemsReady=false`，混音与视频检查项文案「请先在拼接导出生成一部成片」），不返回 4xx/5xx——前端 `refresh()` 以 `Promise.all([checks, list])` 拉取，checks 报错会使整个导出面板不可渲染；lines/ffmpeg/disk 检查保留。

`compileMixPlan(episodeId, dramaId, { sourceFilmId? })`：

- 解析源成片并校验可读；
- 以源成片时长作为计划目标时长；
- 非 `concat` 源默认关闭虚拟对白/BGM；
- 源成片无音轨时不创建原声床，加 `MIX_SOURCE_NO_AUDIO` 警告；
- 源成片不可读时抛出 `MIX_SOURCE_UNREADABLE`。

---

## 6. 剪辑工作台

### 6.1 工程模型：一部成片一个工程

- 进入剪辑页的成片解析顺序：URL `?film=` → `episodes.edit_project_id` 对应的未删除工程 → `episodes.current_film_id` → 本集最新一部可用成片；
- 一集没有任何可用成片时显示空态「本集还没有成片。先去『拼接导出』生成一版拼接成片」，不自动创建空工程、不生成占位成片（2026-11-07 实施核对：后端状态以 `reason: 'NO_FILM'` 标记空态；readonly 模式只读、绝不落库）；
- 一部源成片对应一个剪辑工程；
- 同一部成片重复打开恢复原工程；
- 不同成片互不覆盖；
- 导出的剪辑成片是一部新成片，原工程仍绑定源成片；用户可「继续剪辑新成片」，系统为新成片创建新工程。

工程创建（源为普通成片）：

- 生成单个片段，`source.kind='merge'`、`source.id=filmId`、`source.url=film.url`、`sourceInMs=0`、`sourceOutMs=film.duration_ms`；
- 字幕：
  1. 成片有外挂 `.srt` 且 `subtitle_burned=false`：解析并导入为 `source='import'` 的 cue；
  2. 成片 `subtitle_burned=true`：不导入字幕，显示常驻提示「这部成片已包含烧录字幕，新增字幕会叠加，请确认后再添加」；
  3. 没有外挂字幕且未烧录：字幕轨为空，提示「可手动添加字幕，或去配音页生成台词」；不按台词本自动生成，避免时间轴与成片错位（2026-11-07 实施核对：该提示以 warning 级 `SUBTITLE_EMPTY` 下发，不阻断计划构建）；
  4. 不覆盖已有工程。
- 无转场；
- 工程画幅默认取成片宽高比，帧率取成片帧率，兜底 30；
- 若源成片是 `mix` 且没有外挂字幕，提示「历史混音成片可能已烧录字幕，叠加字幕前请确认」。

旧工程兼容：

- 旧的分镜铺轨工程仍可打开；
- 顶部显示「旧版工程（按分镜生成）」；
- 可另存为新版本，不强制迁移。

### 6.2 左侧面板

左侧主区域固定为成片列表，不再切换成「分镜 / 素材」标签：

1. **成片（唯一主列表）**
   - 成片卡片列表（同 4.6）；
   - 顶部按钮：「新建拼接成片」（跳转拼接导出）、「刷新」；
   - 选中卡片打开/恢复工程；
   - 右键菜单：打开剪辑、预览、设为当前、在混音中打开、重命名、查看导出记录、删除（当前禁用）。
2. **图片选择器（顶栏按钮打开的弹窗，不占左侧主列表）**
   - 本集分镜图、角色/场景图、已上传图片；
   - 点击「插入到播放头」；
   - 「上传图片」按钮（PNG/JPG/WebP，≤20MB，≤4096px）。
3. **字幕列表（工具栏按钮打开的抽屉，不占左侧主列表）**
   - 当前工程的字幕列表：时间、文本、角色、跟随状态；
   - 点击定位并选中；
   - 支持搜索。

规则：

- 左侧主列表必须是成片，不是分镜；
- 分镜视频、Take 不作为剪辑素材入口；需要调整镜头顺序或替换镜头时，回拼接导出生成新成片；
- 图片素材可来自分镜图，但只作为静止播放帧，不携带分镜视频；
- 切换成片时，当前工程先自动保存草稿；保存失败则阻止切换并提示；
- 切换不会删除任何工程。

### 6.3 帧模型

- 工程帧率 `fps` 为整数（24/25/30，兜底 30）；
- 一帧时长 `frameMs = 1000 / fps`；
- 所有片段边界、播放头、字幕入出点、帧操作都吸附到帧网格；
- 时间显示：`mm:ss:ff`（分:秒:帧），悬停显示毫秒；
- 播放头逐帧步进使用整数帧号，避免累计误差；
- 片段最短 3 帧（视频），图片/定格最短 1 帧；
- 帧操作只改计划，不改源文件，全部可撤销。

### 6.4 帧级操作

所有插入操作在播放头位于片段边界时直接在边界插入，不创建空片段；分割只在播放头严格位于片段内部时发生。

#### 删除这一帧

语义：删除播放头所在的 1 帧，后面的内容整体前移 1 帧（波纹删除）。

规则：

- 播放头吸附到帧起点；
- 若在片段中间：在帧起点和帧终点各分割一次，删除中间 1 帧，后续片段自动前移；
- 若在片段开头/结尾：直接调整 `sourceInMs` / `sourceOutMs` 1 帧；
- 图片/定格片段：时长减少 1 帧；
- 若删除后任一片段低于最短帧数，拒绝并提示「片段太短，无法删除这一帧」；
- 字幕：
  - 跟随片段的 cue 随片段一起移动；
  - 固定时间的 cue 不动；若与变化区域重叠，显示警告并提供「整体平移字幕」；
- 操作入口：
  - 右键菜单「删除这一帧」；
  - 顶部「帧操作」下拉；
  - 快捷键（保留，不强制）。

#### 复制这一帧（定格）

语义：把播放头当前画面复制成一张静止图片，插入到当前帧之后，默认 1 秒，可调 1 帧–10 秒。

流程：

1. 前端请求 `POST /episodes/:id/edit/frames`，传 `project_id`、`clip_id`、`offset_ms`；
2. 后端用 FFmpeg 从源片段抽取 PNG，存入 `edit/frames/`，按源指纹+时间哈希缓存；
3. 返回图片 URL、宽高、指纹；
4. 前端在播放头处分割片段（若在中间），插入一个 `kind='image'` 的片段；
5. 后续片段自动后移；
6. 图片/定格片段的声音为静音；
7. 用户可在检查器改时长、删除、替换；
8. 若播放头落在图片/定格片段内，直接复制该片段使用的图片，不调用抽帧接口。

#### 插入图片作为播放帧

- 来源：图片库、上传图片、当前帧抽取结果；
- 插入到播放头；若在片段中间先分割；
- 默认 3 秒，可在检查器改 1 帧–30 秒（2026-11-07 实施裁定：图片片段最短时长按 6.3 的 1 帧执行，`insertClip` / `trimClipStart` / `trimClipEnd` / `splitClip` 预检均按片段类型区分下限，视频片段维持 3 帧）；
- 按工程画幅「适应」显示，黑边填充；不提供画中画；
- 图片片段可拉长、缩短、删除、复制；
- 导出时图片按帧率循环为视频帧。

#### 拉长时间

| 片段类型 | 行为 |
| --- | --- |
| 插入的图片片段 | 拖动右边缘或输入时长，范围 1 帧–30 秒（2026-11-07 实施裁定：下限由 0.1 秒收紧语义为 1 帧，见 6.3） |
| 复制帧/定格片段 | 拖动右边缘或输入时长，范围 1 帧–10 秒 |
| 视频拉长产生的冻结尾 | 按拖拽时长生成，最长 10 分钟 |
| 视频，未超过源时长 | 正常裁剪出点 |
| 视频，超过源时长 | 拖拽时提示「超出部分将定格最后一帧」；松手后自动追加一个由最后一帧生成的图片片段，音频为静音 |
| 视频，向左拉长 | 受源入点限制，到 0 为止 |

规则：

- 拉长视频本身不改变速度；需要变速用检查器「速度」；
- 定格追加产生新的图片片段，原视频片段不被破坏；
- 帧吸附。

### 6.5 图片上传与素材

- `POST /episodes/:id/edit/assets/images`（multipart）：
  - 允许 `image/png`、`image/jpeg`、`image/webp`；
  - 单文件 ≤20MB，解码后 ≤4096×4096；
  - 存入 `storage/projects/<dramaId>/edit/assets/`；
  - 返回 `{ url, width, height, fingerprint }`；
  - 同一指纹去重，不重复落盘；
- 本集分镜图、角色图、场景图通过 `GET /episodes/:id/edit/media?project_id=` 返回；
- 删除图片素材只删除未被任何版本引用的文件；被引用时提示先移除片段。

### 6.6 字幕编辑

#### 数据模型

保留 `style` 预设字段，新增逐条外观：

```ts
type EditSubtitleStyle = 'default' | 'outline' | 'box' | 'custom'

interface EditSubtitleAppearance {
  fontFamily: string
  fontSize: number        // 12–120；以工程高度为基准的像素字号，1080p 建议 42–72
  color: string           // #RRGGBB
  strokeColor: string
  strokeWidth: number     // 0–8
  backgroundColor: string | null
  backgroundOpacity: number // 0–100
  align: 'left' | 'center' | 'right'
  xPct: number            // 0–100，文本块锚点横坐标
  yPct: number            // 0–100，文本块锚点纵坐标
}

interface EditSubtitleCue {
  // 现有字段不变
  style: EditSubtitleStyle
  appearance?: EditSubtitleAppearance // 不填则继承工程默认
}
```

工程默认：

```ts
interface EditProjectSettings {
  // 现有字段不变
  subtitleAppearance: EditSubtitleAppearance
  subtitleSafeAreaPct: number // 默认 8
}
```

默认值：

| 预设 | 字体 | 字号 | 颜色 | 描边 | 背景 | 位置 |
| --- | --- | --- | --- | --- | --- | --- |
| default | PingFang SC | 48 | #FFFFFF | 黑 2px | 无 | 底部居中 (50, 85) |
| outline | PingFang SC | 48 | #FFFFFF | 黑 4px | 无 | 底部居中 (50, 85) |
| box | PingFang SC | 46 | #FFFFFF | 无 | #000000 60% | 底部居中 (50, 85) |
| custom | 继承工程默认 | 继承 | 继承 | 继承 | 继承 | 继承 |

位置约定：

- `xPct/yPct` 是文本块锚点相对工程画面的百分比，`(50, 85)` 表示水平居中、底部上方；
- ASS 按对齐方式映射 `\an`：左/中/右 × 顶/中/底 = `\an1–9`，再用 `\pos(xPct%×宽, yPct%×高)` 定位；
- 预览与导出的位置换算使用同一套锚点规则。

兼容：

- 旧计划没有 `appearance` 时，按 `style` 预设生成默认外观；
- 旧计划没有 `subtitleAppearance` 时，按 `defaultSubtitleStyle` 生成工程默认；
- 归一化不拒绝旧计划。

#### 检查器「字幕」页

选中字幕 cue 后显示：

1. **文字**：多行文本框；实时预览；
2. **时间**：
   - 开始 / 结束，格式 `mm:ss.mmm`；
   - `−1 帧` / `+1 帧` 按钮；
   - 「开始对齐播放头」「结束对齐播放头」；
   - 「跟随这个片段」开关；开启后拖动片段时字幕跟随；
3. **样式**：
   - 字体（下拉，白名单）；
   - 字号（滑杆 + 数值，12–120 px）；
   - 文字颜色；
   - 描边颜色 + 粗细；
   - 背景颜色 + 透明度；
   - 对齐：左 / 中 / 右；
4. **位置**：
   - 预设：顶部 / 中间 / 底部；
   - 九宫格快捷位置；
   - 自定义 X / Y 滑杆；
   - 「显示安全区」开关；
   - 越界警告，不阻止导出；
5. **批量**：
   - 「应用到全部字幕」；
   - 「设为新字幕默认」（更新工程默认，不影响已有 cue 的显式外观）；
6. **操作**：删除、在播放头分割、与下一条合并。

字体白名单：

- `PingFang SC`、`Hiragino Sans GB`、`Microsoft YaHei`、`Noto Sans CJK SC`、`Source Han Sans SC`、`SimHei`、`KaiTi`、`Songti SC`、`Arial`、`Georgia`；
- 导出时按平台可用性回退：`PingFang SC` → `Noto Sans CJK SC` → `sans-serif`；
- 不支持字体上传；字体缺失时导出检查给出警告，不阻止导出。

#### 预览

- 字幕以 HTML 覆盖层渲染在视频/图片上方；
- 外观按工程分辨率换算到预览容器；
- 字体渲染与 FFmpeg/libass 存在细微差异，UI 标注「预览近似，导出以成片为准」；
- 安全区按 `subtitleSafeAreaPct` 显示虚线框；
- 位置越界时边框变黄，不阻止。

#### 导出

- 字幕模式：硬字幕（默认）/ 软字幕 / 无；
- 硬字幕使用 ASS：逐条 cue 生成 `\pos`、字号、颜色、描边、背景、对齐；
- 软字幕写入 MP4 的 `mov_text` 轨道，同时输出外挂 SRT；
- 三种模式的文件与字段：

| 模式 | 视频内字幕 | 外挂文件 | `subtitle_burned` | 成片 `subtitle_url` |
| --- | --- | --- | --- | --- |
| 硬字幕 | 烧录 ASS | 同时保存 `.ass` 与 `.srt` 供下载/追溯 | 1 | `NULL` |
| 软字幕 | `mov_text` 轨道 | `.srt` | 0 | 外挂 SRT |
| 无 | 无 | 无 | 0 | `NULL` |

- 硬字幕成片的 `subtitle_url` 必须为空，防止播放器再次叠加已烧录字幕；
- 字幕样式优先级：cue `appearance` > 预设默认（`style` 非 `custom` 时直接取预设外观）> 工程默认（仅 `custom` 继承工程 `subtitleAppearance`）（2026-11-07 实施裁定：`resolveSubtitleAppearance` 按「预设优先于工程默认」实现（`edit-subtitle-ass.ts`），与本文原稿「工程默认 > 预设默认」不一致，按实现回写，已有测试锁定）；
- 不修改台词本；不提供「同步回台词本」。

### 6.7 右键菜单

新增通用 `ContextMenu.vue`：

- Teleport 到 body；
- 键盘可操作：↑↓ 选择、Enter 执行、Esc 关闭；
- 点击外部、滚动、窗口尺寸变化关闭；
- 菜单项支持图标、快捷键提示、禁用原因、危险色、分隔线；
- 所有菜单项都必须有对应的可见按钮或检查器入口，右键不是唯一路径。

#### 视频片段

| 菜单项 | 行为 |
| --- | --- |
| 播放这一段 | 从片段起点播放 |
| 分割 | 在播放头分割（吸附帧） |
| 删除这一帧 | 6.4 |
| 复制这一帧 | 6.4 |
| 删除片段（波纹） | 删除整个片段，后面内容前移 |
| 删除并留空 | 删除内容，保留空档 |
| 复制片段 | 在片段后插入一份相同入出点的副本 |
| 插入图片 | 打开图片选择器 |
| 拉长 1 秒（超出自动定格） | 追加 1 秒；源不够时生成定格图片片段 |
| 速度 | 0.5× / 1× / 1.5× / 2× |
| 调整这段的声音 | 跳转混音页；剪辑页不提供音量/左右声道编辑 |
| 适配 | 适应 / 填充 |
| 重置旋转/翻转 | 恢复 0°、未翻转 |
| 定位源成片 | 打开源成片预览 |
| 属性 | 选中并在检查器显示 |

#### 字幕

| 菜单项 | 行为 |
| --- | --- |
| 编辑文本 | 聚焦文本框 |
| 编辑样式 | 打开字幕样式页 |
| 编辑时间 | 打开开始/结束时间编辑 |
| 开始对齐播放头 / 结束对齐播放头 | 把对应时间吸附到播放头 |
| 跟随片段 / 固定时间 | 切换 |
| 删除字幕 | |
| 定位台词 | 跳转配音台词本；仅有关联台词的 cue（旧工程）可用 |

#### 时间线空白

| 菜单项 | 行为 |
| --- | --- |
| 在这里插入图片 | 打开图片选择器 |
| 全选 | 选中全部片段 |
| 适配全部 | 所有片段设为适应 |
| 关闭所有空档 | 波纹闭合全部空档 |

#### 转场

本轮不提供转场菜单。旧计划若存在转场字段，时间线按硬切显示，导出按硬切并提示；不提供新增、删除或修改转场的入口。

#### 成片卡片

| 菜单项 | 行为 |
| --- | --- |
| 打开剪辑 | |
| 预览 | |
| 设为当前成片 | 当前项禁用 |
| 在混音中打开 | |
| 重命名 | 1–80 字 |
| 查看导出记录 | 有 `export_id` 时可用 |
| 删除 | 当前成片禁用；删除会级联软删除该成片的剪辑工程，需二次确认 |

### 6.8 时间线可见操作

为避免依赖右键和快捷键，在时间线工具栏增加：

- 「帧操作」下拉：删除这一帧、复制这一帧、插入图片、拉长 1 秒；
- 「字幕」按钮：新建字幕、显示/隐藏字幕轨、打开字幕列表；
- 「分割」按钮；
- 「删除」按钮；
- 「适应画幅」按钮；
- 所有按钮显示中文名称，快捷键只作为副提示。

### 6.9 预览与播放时钟

- 预览区内部可使用 2–3 个 `<video>` 组成的预加载池，但同一时刻只有一个可见画面，不向用户暴露多个播放器；
- 视频片段用 `<video>` 播放源片段的 `sourceIn + offset`；
- 图片/定格片段用 `<img>`；
- 空档显示黑场；
- 片段切换为硬切；
- 字幕使用 HTML 覆盖层；
- 播放头、时间线、字幕、检查器共享一个时钟；
- 转场仍按硬切预览，并标注「导出仅支持硬切」；
- 不支持逐帧精确预览渲染；导出前可查看渲染检查报告。

主时钟契约：

| 场景 | 主时钟 | 同步方式 | 漂移阈值 | 回退顺序 |
| --- | --- | --- | --- | --- |
| 有可用混音或源成片原声 | WebAudio | 视频定期 seek 到音频位置 | 120ms | 混音 → 源成片原声 → 静音 |
| 无音频 / WebAudio 不可用 | 当前视频 | 播放头跟随视频；切片段时更新 | 原生 | 静音预览 |
| 暂停拖动 | 播放头 | 视频 seek 到对应帧 | — | — |

- 回退时必须显示横幅：`混音需更新，当前播放原声参考` 或 `暂无可用音频，仅静音预览`，不静默播放错误声音；
- 120ms 是剪辑页阈值；混音页沿用现行 320ms，二者是场景差异，不共享播放器实现。

### 6.10 剪辑导出

新增服务 `edit-export-service.ts`，并接入 `episode_exports`。

#### 输入

```ts
{
  project_id: number
  preset: string
  subtitle_mode: 'burn' | 'soft' | 'none' // 默认 burn
  set_current: boolean
  title?: string
  base_version: number
}
```

#### 流程

1. 校验工程存在、源成片可读、计划合法；`base_version` 必须等于当前草稿版本，否则返回 `409 EDIT_VERSION_CONFLICT`，不创建导出任务；
2. 同一工程已有导出任务时返回 `409 EXPORT_ALREADY_RUNNING`，不创建版本或任务；
3. 若草稿不是版本，自动创建里程碑版本；
4. 生成字幕文件：`burn` 生成 ASS + SRT，`soft` 生成 SRT，`none` 不生成；
5. 逐片段渲染：
   - 视频：`trim` + `setpts`（速度）+ `fps` + `scale/pad`（适应/填充）+ 旋转/翻转 + 淡入淡出；
   - 图片：循环为视频帧，按时长截断；
   - 空档：黑场 + 静音；
   - 音频：源片段音频按相同入出点裁剪，速度用 `atempo`，淡入淡出用 `afade`；图片/空档静音；
   - 拼接：`concat` 滤镜；
   - 字幕：`burn` 烧录 ASS；`soft` 写入 `mov_text`；`none` 不写；
6. 输出 H.264/AAC、yuv420p、faststart；全片无声时也保留一条静音 AAC 轨，保证播放器兼容；
7. 校验：时长误差 ≤1 帧、视频流存在、音频流存在、字幕条目数一致；
8. 写入导出记录（含 `source_merge_id`、`project_id`、`edit_revision_id`）；
9. 投影成片：`subtitle_burned` 与 `subtitle_url` 按 6.6 的三种模式写入；
10. 若 `set_current`，调用 `setCurrentFilm` 更新当前成片。

> 启动恢复（2026-11-07 实施裁定）：剪辑导出服务模块加载时执行 `recoverInterruptedEditExports()`，将 `kind='edit'` 的 `rendering` 行置为 `failed`（文案「服务重启，任务已中断」并写 `finished_at`），避免工程导出通道被孤儿任务永久死锁；语义与既有拼接导出恢复一致。

#### 支持范围

| 能力 | 导出支持 | 说明 |
| --- | --- | --- |
| 硬切 | 是 | |
| 片段顺序、波纹删除 | 是 | |
| 裁剪、分割、变速 0.5–2× | 是 | |
| 图片片段、定格帧 | 是 | |
| 空档黑场 | 是 | |
| 适应 / 填充 | 是 | |
| 旋转 0/90/180/270、水平/垂直翻转 | 是 | |
| 片段淡入淡出 | 是 | |
| 字幕硬/软/无 | 是 | |
| 叠化/白场/推拉/模糊转场 | 否 | 按硬切导出并警告 |
| 滤镜预设 | 否 | 警告「滤镜暂不支持导出」 |
| 缩放 x/y 位移 | 否 | 警告「位置变换暂不支持导出」 |
| 画中画/叠加轨 | 否 | 计划字段保留，导出忽略并警告 |
| 关键帧 | 否 | |

导出前检查必须列出所有降级项，用户确认后才能开始。不得静默忽略。

#### 标题与命名

- 默认标题：`第 N 集 剪辑成片（YYYY-MM-DD HH:mm）`；
- 文件：`第N集-剪辑-v{revisionNo}.mp4`；
- 成片 `kind='edit'`，`origin='export'`，`source_merge_id` = 源成片。

### 6.11 剪辑 API 变更

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/episodes/:id/edit?project_id=` | 读取工程状态；不传时按 6.1 的成片解析顺序取工程或成片（2026-11-07 实施裁定：`on` 模式下解析不到工程时自动为最新成片打开/创建工程并持久化初始草稿（v1，幂等，可复用并发首读已落库的版本）；`readonly` 模式只返回临时成片计划，绝不落库、不建工程） |
| GET | `/episodes/:id/edit/projects` | 列出本集成片对应的工程 |
| POST | `/episodes/:id/edit/projects` | body `{ film_id }`；查找或创建工程 |
| PUT | `/episodes/:id/edit/draft` | body 增加 `project_id` |
| POST | `/episodes/:id/edit/revisions` | body 增加 `project_id` |
| GET | `/episodes/:id/edit/revisions?project_id=` | 按工程过滤 |
| POST | `/episodes/:id/edit/frames` | 抽帧，body `{ project_id, clip_id, offset_ms }` |
| POST | `/episodes/:id/edit/assets/images` | 上传图片 |
| GET | `/episodes/:id/edit/media?project_id=` | 增加图片素材与工程信息 |
| POST | `/episodes/:id/edit/render` | 启动剪辑导出，body 见 6.10 |
| GET | `/episodes/:id/edit/render/:exportId` | 查询进度与结果 |

所有写接口在 `edit_workspace != 'on'` 时返回 `403 EDIT_READONLY` / `403 EDIT_WORKSPACE_OFF`；读接口仍可用。

---

## 7. 交互验收清单

| 用户诉求 | 验收动作 | 通过标准 |
| --- | --- | --- |
| 1. 混音选择成片并回写成片 | 在混音页点「源成片」→ 选择拼接成片 → 混音 → 导出视频 | 源成片切换成功；导出后成片中心出现新的混音成片 |
| 2. 剪辑选择成片并回写成片 | 在剪辑页左侧成片列表选择一部 → 编辑 → 导出 | 打开对应工程；导出后成片中心出现新的剪辑成片 |
| 3. 属性面板小白化 | 打开混音页 | 首屏是「这一集怎么听」；不出现未解释的「增益/声像/总线/LUFS」；所有术语有中文解释 |
| 4. 背景声与分离素材 | 混音页第一屏 | 可见「生成背景声/环境声」；「声音素材库」折叠且有用途说明；分离运行不遮挡设置 |
| 5. 右键菜单 | 右键片段、字幕、空白、成片卡片 | 菜单出现且可点击；不用快捷键也能完成分割/删除/复制帧/插入图片/拉长 |
| 6. 成片列表与帧操作 | 剪辑页左侧 | 左侧主列表是成片；删除这一帧后总时长少 1 帧；复制帧后多 1 秒；插入图片默认 3 秒；拉长视频出现定格尾部 |
| 7. 字幕样式与时间 | 选中字幕 | 可改文本、开始/结束、字体、字号、颜色、描边、背景、对齐、位置；预览同步；导出后样式一致 |

---

## 8. 错误码

| 场景 | HTTP | code | 文案 |
| --- | --- | --- | --- |
| 成片不存在 | 404 | `FILM_NOT_FOUND` | 成片不存在或已删除 |
| 成片文件不可读 | 422 | `FILM_UNREADABLE` | 成片文件无法读取，请重新生成 |
| 删除当前成片 | 409 | `FILM_IS_CURRENT` | 这是当前成片，请先把其他成片设为当前 |
| 混音没有源成片 | 400 | `MIX_SOURCE_MISSING` | 请先在拼接导出生成一部成片 |
| 混音源无音轨 | 200 + warning | `MIX_SOURCE_NO_AUDIO` | 这部成片没有声音，你仍可以添加配音或背景声 |
| 混音源不可读 | 422 | `MIX_SOURCE_UNREADABLE` | 源成片文件无法读取 |
| 轨道超出源成片时长 | 200 + warning | `MIX_TRACKS_EXCEED_FILM` | 超出部分导出时会被截掉 |
| 剪辑工程不存在 | 404 | `EDIT_PROJECT_NOT_FOUND` | 剪辑工程不存在 |
| 剪辑草稿版本冲突 | 409 | `EDIT_VERSION_CONFLICT` | 这一集已在另一个窗口被修改，请重新加载或另存副本 |
| 源成片已有工程 | 200 | — | 返回已有工程，不重复创建 |
| 帧操作后片段过短 | 400 | `EDIT_CLIP_TOO_SHORT` | 片段太短，无法执行这个操作 |
| 抽帧失败 | 500 | `EDIT_FRAME_EXTRACT_FAILED` | 无法复制这一帧，请重试 |
| 图片格式不支持 | 400 | `EDIT_IMAGE_TYPE` | 只支持 PNG、JPG、WebP |
| 图片过大 | 400 | `EDIT_IMAGE_TOO_LARGE` | 图片不能超过 20MB 或 4096×4096 |
| 导出降级未确认 | 400 | `EDIT_EXPORT_DEGRADED` | 导出会忽略部分效果，请确认后继续 |
| 导出任务冲突 | 409 | `EXPORT_ALREADY_RUNNING` | 这个剪辑工程已有导出任务在运行 |
| 成片投影失败 | 500 | `FILM_PROJECTION_FAILED` | 成片入库失败，可重试 |

---

## 9. 测试与验收

### 9.1 后端单元测试

- 成片投影：幂等、唯一索引、当前指针、删除当前拒绝、标题更新；
- 成片迁移：`kind` 为 `comfyui` / `motion` / 空值归并为 `concat`，历史行 `origin='legacy'`，不丢行；迁移可重复执行且幂等；
- 索引迁移：旧的 episode 级唯一索引删除后，同一集可保存多份工程草稿与版本；
- `current_film_id` 回填：URL 匹配、同 URL 多行取最新、匹配不到置空；
- 混音源：
  - 默认选择顺序（无 concat 时回退到最新非 concat 成片）；
  - 非 concat 源默认关闭虚拟对白/BGM；
  - 源无音轨/不可读；
  - 计划时长以源成片为准；
- 剪辑工程：
  - 同一成片重复打开返回同一工程；
  - 不同成片隔离草稿与版本；
  - 同一集两份草稿并存，互不覆盖；
  - 旧工程回填，旧草稿归入 `source_merge_id IS NULL` 的工程；
- 帧命令：
  - 1 帧 = `1000/fps`；
  - 删除中间帧、开头帧、结尾帧；
  - 播放头在片段边界时插入不产生空片段；
  - 最短片段保护；
  - 复制帧插入 1 秒图片；
  - 插入图片默认 3 秒、范围 1 帧–30 秒；
  - 拉长视频追加定格；
  - 字幕跟随/固定；
- 字幕：
  - 旧计划兼容；
  - 外观默认值；
  - 逐条覆盖优先级；
  - ASS 位置/字号/颜色/描边/背景；
  - 字体回退；
- 渲染：
  - 短样片渲染，断言时长、视频流、音频流；
  - 硬字幕烧录与软字幕；
  - 硬字幕投影 `subtitle_burned=1` 且 `subtitle_url=null`；软字幕投影 `subtitle_url` 指向 SRT；
  - 取消、失败、降级警告。

### 9.2 前端测试

- 成片选择器在三处的一致性；
- 混音检查器顺序与文案；
- 背景声入口可用性与进度；
- 分离卡折叠与不遮挡设置；
- 右键菜单项与命令映射；
- 字幕检查器修改计划；
- 帧操作按钮与右键结果一致；
- 播放时钟：120ms 漂移纠偏、音频回退横幅、无音频静音预览；
- 切换成片时自动保存与失败阻止。

### 9.3 真实端到端验收

1. 准备一集有分镜视频的测试数据；
2. 在「拼接导出」生成一部拼接成片；
3. 进入混音，选择该成片，确认源显示正确；
4. 生成背景声，确认新轨道出现且可试听；
5. 导出视频，确认成片中心出现「混音成片」；
6. 在剪辑中打开该混音成片，确认左侧是成片列表、时间线只有一个源片段；
7. 删除 1 帧，断言时长减少 `1000/fps`；
8. 复制 1 帧，断言时长增加 1 秒且出现图片片段；
9. 上传一张图片插入，断言片段出现且默认 3 秒；
10. 拉长视频超过源时长，断言出现定格尾部；
11. 修改字幕文本、字体、字号、颜色、描边、位置、时间；
12. 导出剪辑成片（硬字幕），确认成片中心出现「剪辑成片」，字幕样式正确，`subtitle_burned=1` 且 `subtitle_url` 为空；
13. 设为当前成片，确认剧集 `current_film_id` 与 `video_url` 同步；
14. 截图留证：成片列表、混音首屏、右键菜单、字幕检查器、导出结果；
15. 回归：配音、TTS、ComfyUI 网关、其他工作流不受影响。

---

## 10. 分阶段实施

### 阶段 A：成片中心地基

- 数据列、`edit_projects`、迁移与回填；
- 成片投影、当前指针、成片 API；
- 共享 `FilmPicker`；
- 旧 `video-version` 兼容。

**完成标准：** 现有拼接成片列表不回归；API 测试通过；无页面行为变化。

### 阶段 B：混音接入

- 源成片选择与持久化；
- `compileMixPlan` 源感知；
- 混音检查器重排与文案；
- 背景声入口、分离素材卡；
- 混音视频导出投影成片；
- 字幕策略改为 `none/copy`。

**完成标准：** 混音可选源、可生成背景声、可回写成片；旧混音导出不回归。

### 阶段 C：剪辑工程与字幕

- 成片工程创建/恢复；
- 左侧成片列表；
- 右键菜单与可见工具栏；
- 字幕模型扩展、检查器、预览、ASS 生成；
- 旧工程兼容。

**完成标准：** 打开成片即可剪辑；字幕样式与时间可编辑；不依赖快捷键。

### 阶段 D：帧级操作与导出

- 抽帧、图片上传、图片素材；
- 删除帧、复制帧、插入图片、拉长；
- 剪辑渲染器、导出检查、降级提示；
- 导出投影成片。

**完成标准：** 帧操作真实改变成片；导出成片可播放、时长正确、字幕正确。

### 阶段 E：验收与收口

- 全量测试、真实 E2E、截图；
- 文档、执行日志；
- 旧入口文案与跳转；
- 构建与安装需单独批准。

---

## 11. 风险与取舍

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 剪辑渲染器范围扩大 | 工期与稳定性 | 只支持硬切、图片、裁剪、变速、基础字幕；转场/滤镜/画中画明确降级并提示 |
| 帧级操作导致音画不同步 | 成片错位 | 视频与音频使用同一入出点与速度；导出校验时长；E2E 断言 |
| 混音选择已混音成片导致人声重复 | 听感错误 | 非 concat 源默认关闭虚拟对白/BGM；常驻警告；提取素材可分轨 |
| 多工程增加数据复杂度 | 迁移与查询复杂 | 一部成片一个工程，唯一索引；旧工程回填；草稿/版本按工程隔离 |
| 成片列表增长 | 页面变慢、选择困难 | 默认 50 条、按时间倒序、当前/已剪辑徽标；后续加分页与筛选 |
| 字体跨平台差异 | 导出样式与预览不一致 | 白名单、平台回退、导出前检查提示；不承诺像素级一致 |
| 投影失败 | 用户看不到成片 | 幂等修复接口；导出记录保留；界面明确提示 |
| 历史混音成片已烧字幕 | 再编辑字幕叠加 | 新混音导出不烧字幕；历史成片提示风险 |
| 图片/抽帧占用磁盘 | 存储增长 | 指纹去重、未被引用清理、上传大小限制 |

---

## 12. ADR 修订

### 12.1 ADR-05 新结论

**标题：成片统一进入成片中心，混音与剪辑都可产出成片**

- `video_merges` 是唯一成片目录；
- 拼接、混音视频导出、剪辑视频导出都产出成片；
- 混音页仍只负责声音，但可以把混音结果封装成一部新成片；
- 剪辑页负责画面、字幕与最终交付；
- 音频/分轨导出只进 `episode_exports`，不成片；
- `episodes.current_film_id` 是唯一当前成片指针，`video_url/subtitle_url` 是兼容镜像；
- 只有「设为当前成片」及其内部调用可以更新指针；
- 所有导出非破坏，不覆盖旧成片。

### 12.2 ADR-12 新结论

**标题：导出任务与成片分离，`episode_exports` 不再当成片目录**

- `episode_exports` 只承担渲染任务：状态、进度、参数、产物、错误、版本快照；
- `video_merges` 承担成片目录：可播放版本、标题、时长、来源、字幕；
- 视频任务成功后以事务投影成片，`export_id` 唯一，幂等；
- 音频/分轨任务不投影；
- 每个成片记录 `source_merge_id`、`export_id`、`edit_revision_id`、`mix_revision_id`、`plan_hash`，可追溯；
- 旧导出记录不批量投影，避免生成重复历史版本。

### 12.3 连带修订

- `docs/V3-剪辑工作台技术架构设计.md`：
  - ADR-05、ADR-12 正文；
  - 一页结论、实体关系图、数据库设计、导出服务、API 一览、混音工作台改造；
- `docs/V3-剪辑工作台产品设计.md`：
  - 一页结论第 5 条；
  - 入口与职责去重表；
  - 布局与素材库；
  - 字幕样式与右键菜单；
  - 导出与交付；
- `docs/V3-配音工作台详细设计.md`：
  - 第 8 章混音源选择、检查器顺序、背景声入口、成片回写；
- `docs/superpowers/plans/2026-11-06-edit-workbench-m1-foundation.md`：
  - 顶部增加「本计划的索引与工程模型已由新设计取代」说明，不重写历史任务；
- `docs/superpowers/plans/2026-11-06-edit-workbench-s2-timeline-editing.md`：
  - 顶部增加「本计划的范围限制已由新设计扩展」说明，不重写历史任务。

---

## 13. 明确不做

- 不做多视频轨、画中画、蒙版、关键帧、调色曲线；
- 不做转场导出（硬切除外）；
- 不做滤镜导出；
- 不做字幕 OCR、语音识别打轴、字幕回写台词本；
- 不做成片导入上传；
- 不做云端渲染、协作、发布；
- 不做 4K/60fps；
- 不修改 TTS、ComfyUI 网关、端口、MCP 数量、模板版本。
