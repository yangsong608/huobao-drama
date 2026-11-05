# 配音工作台阶段 0/1 实施计划（基础设施 + 台词本）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 在不破坏现有配音/合片链路的前提下，建立 Take/墓碑/素材/总线路由所需的表结构，并把「台词本」升级为可新增、软删除、恢复、排序、重抽增量合并的独立阶段。

**Architecture:** SQLite 启动时幂等建表与补列；`storyboard_lines` 通过一次性重建把 `storyboard_id` 改为可空并补齐锚点/排序/修订字段。新增纯服务层（`line-workbench`、`dialogue-merge`）承载业务规则，路由只做参数校验；前端 `LineList` 增加 `script/voice/generate` 三种模式，台词本阶段只保留文本与结构操作。

**Tech Stack:** Hono、Drizzle ORM、better-sqlite3、Node test runner、Nuxt 3/Vue 3。

**Spec:** `docs/V3-配音工作台详细设计.md`（第 5 章、10.1–10.3、11.1、14）

## Global Constraints

- 不改变视频生成、剧本创作、ComfyUI 工作流；V3-G5、端口 5679/3013、`TEMPLATE_VERSION=6`、MCP 61 项保持不变。
- 不提交、不构建/打包/安装/重启，除非用户明确要求。
- 旧接口 `POST /episodes/:id/lines/extract` 必须继续可用（内部走新合并逻辑）。
- 锁定行删除被拒绝；手工行与锁定行重抽时永久保留；删除只软删。
- 文本/音色变更不立即清空音频，只标 `audio_stale=1` 并保留旧 Take。
- 所有新文案进入 zh/en/ja/ko 四语言文件。

---

### Task 1: 扩展 SQLite 表结构

**Files:**
- Modify: `backend/src/db/sqlite-schema.ts`
- Modify: `backend/src/db/schema.ts`
- Test: `backend/tests/dubbing-schema.test.ts`

**Interfaces:**
- Produces: `line_takes`、`voice_samples`、`line_tombstones`、`episode_audio_assets`、`audio_buses`、`mix_revisions`、`episode_exports`、`dubbing_jobs` 表；`storyboard_lines` 新列 `anchor_type/sort_order/origin_key/text_revision/audio_stale/active_take_id/deleted_at/direction`，`storyboard_id` 可空。

- [x] 写失败测试：初始化临时库后断言 `PRAGMA table_info(storyboard_lines)` 中 `storyboard_id.notnull=0`、新列存在、8 张新表存在。
- [x] 运行 `npx tsx --test tests/dubbing-schema.test.ts`，确认失败。
- [x] 在 `sqlite-schema.ts` 增加新表 DDL；检测旧表 `storyboard_id` 仍为 NOT NULL 时执行「建新表→复制→删旧→改名→重建索引」，前后处理 `foreign_keys` 并执行 `foreign_key_check`。
- [x] 在 `schema.ts` 增加对应 Drizzle 定义，`storyboardId` 改为可空。
- [x] 运行测试通过，并跑 `npm run build` 确认类型。

### Task 2: 台词服务（新增/编辑/软删/恢复/排序）

**Files:**
- Create: `backend/src/services/line-workbench.ts`
- Test: `backend/tests/line-workbench.test.ts`

**Interfaces:**
- Produces:
  - `addLine(episodeId: number, input: AddLineInput): StoryboardLineRow`
  - `updateLine(id: number, patch: UpdateLinePatch): StoryboardLineRow`
  - `softDeleteLine(id: number): { deleted: true }`
  - `restoreLine(id: number): StoryboardLineRow`
  - `reorderLines(episodeId: number, orderedIds: number[]): { updated: number }`
  - `computeOriginKey(storyboardId: number | null, text: string, speakerKey: string, occurrence: number): string`

- [x] 写失败测试：新增镜头内台词、绝对锚点台词；编辑文本后 `audioUrl` 保留且 `audioStale=true`、`textRevision+1`、`source='manual'`；删除后列表不可见、恢复可见；锁定行删除抛错；排序后 `sortOrder` 生效。
- [x] 运行测试确认失败（模块不存在）。
- [x] 实现服务；文本用 `toSpeakText` 同步 `speakText/subtitleText`；任何编辑写 `source='manual'`。
- [x] 运行测试通过。

### Task 3: 重抽预览与增量合并

**Files:**
- Create: `backend/src/services/dialogue-merge.ts`
- Modify: `backend/src/services/dialogue-extract.ts`
- Test: `backend/tests/dialogue-merge.test.ts`

**Interfaces:**
- Produces:
  - `planEpisodeMerge(episodeId: number, options?: { force?: boolean; storyboardIds?: number[] }): MergePlan`
  - `applyEpisodeMerge(episodeId: number, plan: MergePlan, decisions?: MergeDecision[]): MergeResult`
  - `extractEpisodeLines(episodeId, options)` 保持旧签名，内部调用 plan+apply。

**MergePlan 结构：** `{ groups: { storyboardId, storyboardNumber, added[], updated[], removed[], kept[] }[], summary }`。

- [x] 写失败测试：首次抽取生成自动行；文本变化重抽为 `updated` 且旧 `audioUrl` 保留、`audioStale=true`；手动行保留；已删除自动行因墓碑不复活；未匹配旧自动行标 `stale` 而非删除。
- [x] 运行测试确认失败。
- [x] 实现两轮匹配：`origin_key` 精确匹配 → 同镜头 `sortOrder` + 说话人位置兜底；重复台词按组内顺序配对。
- [x] 运行测试通过。

### Task 4: 台词路由

**Files:**
- Modify: `backend/src/routes/lines.ts`
- Modify: `backend/src/index.ts`（如需挂载）
- Test: `backend/tests/lines-routes.test.ts`

**Interfaces:**
- Produces API：`GET/POST /episodes/:id/lines`、`PUT/DELETE /lines/:id`、`POST /lines/:id/restore`、`POST /episodes/:id/lines/reorder`、`POST /episodes/:id/lines/extract/preview`、`POST /episodes/:id/lines/extract/apply`。

- [x] 写失败测试：用 Hono `app.request` 覆盖新增、编辑、删除、恢复、排序、预览/应用。
- [x] 运行测试确认失败。
- [x] 实现路由；`GET` 默认过滤 `deleted_at`，`include_deleted=1` 可查；旧 `/extract` 兼容。
- [x] 运行测试通过。

### Task 5: 前端台词本模式

**Files:**
- Modify: `frontend/app/components/LineList.vue`
- Modify: `frontend/app/components/DubbingStage.vue`
- Modify: `frontend/app/composables/useDubbingSession.ts`
- Modify: `frontend/app/composables/useApi.ts`
- Create: `frontend/app/components/LineEditorDialog.vue`
- Modify: `frontend/app/locales/zh.json`、`en.json`、`ja.json`、`ko.json`

**Interfaces:**
- `LineList` 新 prop `mode: 'script' | 'voice' | 'generate'`；script 模式显示只读音色 chip、删除/上移/下移/锁定；voice 模式显示音色下拉；generate 模式显示播放/重生成。
- `dubbingAPI` 增加 `addLine/restoreLine/reorderLines/extractPreview/extractApply`。

- [x] 把现有完整行操作包在 `mode` 分支中，保留默认 `voice` 兼容抽屉。
- [x] 台词本阶段增加「新增台词」按钮与弹窗（文本、类型、说话人、镜头/绝对时间、插入位置）。
- [x] 删除使用软删 + Toast 撤销；排序用上移/下移并调用 reorder。
- [x] 阶段 2 增加逐句改派列表；阶段 3 改为 generate 模式（文本/音色只读）。
- [x] 四语言补 key，运行 `npm run build`（frontend）确认通过。

### Task 6: 全量验证

- [x] 后端 `npm test` 全量通过；`npm run build` 通过。
- [x] 前端 `npm run build` 通过。
- [x] 手工冒烟：新增 2 句（镜头/绝对各一）、编辑文本、删除撤销、排序、重抽预览应用。
- [x] 更新执行日志，不提交。
