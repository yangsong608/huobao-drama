# 配音工作台阶段 3：语音生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每句台词生成可追溯、可对比、可回滚的 Take；生成时带入前后语境并把语境转换为表演参数；批量生成可筛选、可取消、可汇总。

**Architecture:** 新增 `line-context`（语境包）、`line-performance`（轻量/深度参数推导）、`line-takes`（Take 生命周期与渲染哈希）、`take-batch`（并发批量任务）。单句、批量与自动配音统一走 `generateTake`，由它负责能力裁剪、缓存、写入 `line_takes` 并同步激活音频。前端复用「生成」阶段，右侧加入 Take 检查器，不新增页面。

**Tech Stack:** Hono、Drizzle ORM/SQLite、Node test runner (`tsx --test`)、Nuxt 3/Vue 3、vue-i18n。

**Spec:** `docs/V3-配音工作台详细设计.md` 第 7 章。

## Global Constraints

- 「注意 tts 先不改」：不改 TTS 服务、协议与适配器；仅通过现有 `synthesize` 参数与 `/tts/capabilities` 裁剪。
- 上下文永不拼接进 TTS `text`；深度模式不得改写台词正文。
- 同一句最多一条 `is_active=1`；激活/删除在事务内完成。
- Take 音频复用 TTS 内容寻址文件；删除 Take 只软删记录，不删音频文件。
- 生成页不出现文本编辑、音色下拉、混音按钮。
- 不改端口 5679/3013、V3-G5、MCP 61、`TEMPLATE_VERSION=6`；不提交 git、不构建安装包。
- 后端命令使用 Node 22.16.0；测试使用隔离 `SQLITE_PATH` / `HUOBAO_DATA_DIR` / `STORAGE_PATH`，`MYSQL_AUTO_IMPORT=false`。

---

### Task 1: 语境包 `line-context.ts`

**Files:**
- Create: `backend/src/services/line-context.ts`
- Test: `backend/tests/line-context.test.ts`

**Interfaces:**
- Produces:
```ts
export type ContextMode = 'off' | 'light' | 'deep'
export interface ContextLine { speaker: string; text: string; emotion: string | null }
export interface LineContext {
  episodeId: number
  lineId: number
  mode: ContextMode
  scene: { storyboardId: number | null; shotNumber: number | null; shotSummary: string | null; durationMs: number | null }
  previous: ContextLine[]
  current: { speaker: string; text: string; emotion: string | null; direction: string | null }
  next: ContextLine[]
  arc: string | null
  pronunciation: Record<string, string>
}
export function buildLineContext(lineId: number, mode?: ContextMode): LineContext
export function contextHash(context: LineContext): string
```

- [x] **Step 1: 写失败测试**：同一镜头优先取前 2/后 2；不足时跨镜头补；`off` 返回空前后的；`contextHash` 对相同内容稳定、对文本变化敏感。
- [x] **Step 2: 运行测试确认失败**（模块不存在）。
- [x] **Step 3: 实现**：按 `storyboardId/sortOrder/lineNo/id` 读取整集未删除台词；先向同镜头两侧收集，不足再从相邻镜头补；`scene.shotSummary` 取 `storyboard.description || storyboard.videoPrompt` 截断 80 字；`arc` 取前 3 句 + 当前 + 后 1 句去重情绪；`contextHash` 用 `crypto.createHash('sha1')` 对规范化 JSON 哈希。
- [x] **Step 4: 运行测试通过**。
- [x] **Step 5: Commit**（仅本地，等待用户明确要求后再提交）。

### Task 2: 表演参数 `line-performance.ts`

**Files:**
- Create: `backend/src/services/line-performance.ts`
- Test: `backend/tests/line-performance.test.ts`

**Interfaces:**
```ts
export interface PerformanceParams {
  emotion: string | null
  speed: number
  instruct: string | null
  pause_hints: { after: string; ms: number }[]
  pronunciation: Record<string, string>
  notes: string | null
}
export interface AnalyzeLinePerformanceResult {
  context: LineContext
  params: PerformanceParams
  source: 'light' | 'deep' | 'fallback'
  error?: string
}
export async function analyzeLinePerformance(lineId: number, options?: {
  mode?: ContextMode
  overrides?: Partial<PerformanceParams>
  deps?: { callTextJson?: typeof callTextJson }
}): Promise<AnalyzeLinePerformanceResult>
```

- [x] **Step 1: 测试 light**：优先 `overrides` → `line.emotion/speed/direction` → 音色默认；`off` 不读前后句；`instruct` 不含邻句原文。
- [x] **Step 2: 测试 deep**：注入 fake `callTextJson` 返回 `{emotion,speed,instruct,pause_hints,pronunciation,notes}`，断言写入 params、source=`deep`、原文未变（重读 line.text 不变）。
- [x] **Step 3: 测试 deep 失败回退**：注入抛错函数，source=`fallback`，仍返回 light 参数，error 非空。
- [x] **Step 4: 实现**：`light` 用规则；`deep` 用 `callTextJson`，JSON 响应校验 speed 0.5–1.5、emotion/instruct 字符串、pause_hints 数组、pronunciation 对象；失败回退 light。
- [x] **Step 5: 运行测试通过**。

### Task 3: Take 生命周期 `line-takes.ts`

**Files:**
- Create: `backend/src/services/line-takes.ts`
- Test: `backend/tests/line-takes.test.ts`

**Interfaces:**
```ts
export interface GenerateTakeInput {
  lineId: number
  contextMode?: ContextMode
  overrides?: Partial<PerformanceParams> & { seed?: number | null; note?: string | null; language?: string | null }
  performance?: PerformanceParams | null
  voiceId?: number | null
  force?: boolean
  reuse?: boolean
  activate?: boolean
}
export interface GenerateTakeDeps {
  config?: AudioConfig | null
  synthesize?: typeof synthesize
  analyze?: typeof analyzeLinePerformance
  capability?: TtsCapability
}
export async function generateTake(input: GenerateTakeInput, deps?: GenerateTakeDeps): Promise<{
  take: TakeRow; line: LineRow; cached: boolean; context: LineContext; params: PerformanceParams; source: string
}>
export function listLineTakes(lineId: number): TakeRow[]
export function activateTake(takeId: number): TakeRow
export function deleteTake(takeId: number): { lineId: number; fallbackTakeId: number | null }
export function takeStatus(episodeId: number): { total: number; ready: number; pending: number; failed: number; stale: number; takes: number }
```

- [x] **Step 1: 测试**：fake `synthesize` 返回固定音频；首次生成 Take 1 并激活，再次生成 Take 2，旧 Take 保留；`speak_text` 与 `text_revision` 快照正确；`voice_fingerprint`/`context_hash`/`params_json` 写入。
- [x] **Step 2: 测试激活/删除**：激活 Take 2 后同步台词音频；删除当前 Take 自动回退上一条；删完回 `pending`。
- [x] **Step 3: 测试能力裁剪**：qwen191 时 `speed/emotion` 不进 `sent`、`ignored` 记录；云语音时 `instruct/seed` 被忽略。
- [x] **Step 4: 测试缓存复用**：`reuse=true` 且同 `renderHash` 已有 ready Take 时不新建，返回 `cached=true`；`reuse=false` 时新建 Take 2。
- [x] **Step 5: 实现**：`voiceFingerprint` = sha256(voice id/updatedAt/prompt/instruct/refAudio/refText/xVectorOnly)；`renderHash` 只含实际发送字段；生成前写 `generating`，成功写 ready，失败写 failed；无音色/无文本直接抛错并标记台词；激活在事务内切换。
- [x] **Step 6: 运行测试通过**。

### Task 4: 批量任务 `take-batch.ts`

**Files:**
- Create: `backend/src/services/take-batch.ts`
- Test: `backend/tests/take-batch.test.ts`

**Interfaces:**
```ts
export type TakeBatchFilter = 'pending' | 'failed' | 'audio_stale' | 'all'
export interface TakeBatchInput {
  lineIds?: number[] | null
  filter?: TakeBatchFilter
  contextMode?: ContextMode
  force?: boolean
  concurrency?: number
}
export interface TakeBatchJob {
  id: string; episodeId: number; status: 'running' | 'done' | 'failed' | 'cancelled'
  total: number; done: number; ok: number; failed: number; skipped: number; cached: number
  currentLineId: number | null; errors: { lineId: number; message: string }[]
  cancelRequested: boolean; startedAt: string; finishedAt: string | null
}
export function startTakeBatch(episodeId: number, input?: TakeBatchInput, deps?: { generate?: typeof generateTake; config?: AudioConfig | null }): TakeBatchJob
export function getTakeBatch(jobId: string): TakeBatchJob | null
export function cancelTakeBatch(jobId: string): boolean
export async function runTakeBatch(job: TakeBatchJob, episodeId: number, input: TakeBatchInput, deps?: ...): Promise<void>
```

- [x] **Step 1: 测试筛选**：`pending` 只取未 ready/无音频；`failed`、`audio_stale`、`all` 正确；`line_ids` 限定范围并排除已删除。
- [x] **Step 2: 测试并发/汇总**：fake generate 延迟并记录最大并发 ≤ 2；成功/失败/跳过/缓存计数正确；失败不中断。
- [x] **Step 3: 测试取消**：取消后剩余行不再生成，状态 `cancelled`。
- [x] **Step 4: 实现**：内存 Map 保存任务；worker pool 并发 2；每行调用 `generateTake({ reuse:true })`；结束写汇总；1 小时后清理旧任务。
- [x] **Step 5: 运行测试通过**。

### Task 5: 路由 `routes/takes.ts` 与旧端点收口

**Files:**
- Create: `backend/src/routes/takes.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/routes/lines.ts`
- Modify: `backend/src/services/dubbing.ts`
- Test: `backend/tests/take-routes.test.ts`

**Interfaces:**
- `POST /lines/:id/takes` → `{ take, line, cached, context, params, source }`
- `GET /lines/:id/takes` → `{ items }`
- `POST /takes/:id/activate` → take + line
- `DELETE /takes/:id` → `{ lineId, fallbackTakeId }`
- `POST / lines/:id/context/preview` → analyze result
- `POST /episodes/:id/takes/batch` → `{ job_id }`
- `GET /episodes/:id/takes/batch/:jobId` → job
- `POST /episodes/:id/takes/batch/:jobId/cancel` → job
- `GET /episodes/:id/takes/status` → counts
- 旧 `POST /lines/:id/synthesize` 与 `POST /episodes/:id/lines/synthesize` 内部改走 Take；`synthesizeEpisodeLines` 每行调用 `generateTake({ contextMode:'light', reuse:true, activate:true })`。

- [x] **Step 1: 路由测试**：用预插入 Take 测 list/activate/delete/status；`context/preview` light 不调用 LLM；批量任务在 0 行时立即 done。
- [x] **Step 2: 实现路由并挂载**。
- [x] **Step 3: 迁移旧端点/自动配音**，保持返回结构兼容。
- [x] **Step 4: 运行定向测试与后端 `npm test`**，确认旧配音测试不回归。

### Task 6: 前端 API 与状态

**Files:**
- Modify: `frontend/app/composables/useApi.ts`
- Create: `frontend/app/composables/useLineTakes.ts`
- Modify: `frontend/app/composables/useDubbingSession.ts`

**Interfaces:**
```ts
export interface LineTake { id; lineId; takeNo; text; speakText; textRevision; voiceId; voiceFingerprint;
  provider; model; configId; params: Record<string, any>; contextMode; context: LineContext | null;
  contextHash; audioUrl; durationMs; hash; status; error; isActive; createdAt }
export interface LineContextPreview { context: LineContext; params: PerformanceParams; source: string; capability: TtsCapability; ignored: string[]; error?: string }
export interface TakeBatchJob { id; status; total; done; ok; failed; skipped; cached; currentLineId; errors; cancelRequested }
```

- [x] **Step 1:** `takeAPI` 增加 `list`, `generate`, `activate`, `remove`, `previewContext`, `batch`, `batchStatus`, `cancelBatch`, `status`。
- [x] **Step 2:** `useLineTakes` 保存 `takesByLine`、`previews`、`batchJob`、`batchRunning`；动作 `loadTakes`, `previewContext`, `generate`, `activate`, `remove`, `startBatch`, `pollBatch`, `cancelBatch`；失败 toast，成功后 `onChanged`。
- [x] **Step 3:** `useDubbingSession.synthesizeLine` 改为调用 takeAPI 单句生成并 reload；`synthesizeAll` 改为批量任务并轮询；保持抽屉兼容。
- [x] **Step 4:** 前端 `npm run build` 通过。

### Task 7: 生成阶段 UI 与四语言文案

**Files:**
- Create: `frontend/app/components/TakeInspector.vue`
- Modify: `frontend/app/components/DubbingStage.vue`
- Modify: `frontend/app/components/LineList.vue`
- Modify: `frontend/app/locales/{zh,en,ja,ko}.json`

- [x] **Step 1:** 生成阶段改为左右两栏：左侧现有筛选+行列表，右侧 `TakeInspector`；行列表新增 `inspect` 事件与 `activeLineId` 高亮、`takeCounts` chip；生成模式不出现文本编辑/音色下拉。
- [x] **Step 2:** `TakeInspector` 显示语境（前 2/后 2、场景摘要、情绪走向）、模式 `off/light/deep`、参数（情绪/语速/表演指令/种子/备注）、Take 列表（序号/时长/通道/seed/模式/状态）、播放、A/B 对比、设为当前、删除；deep 模式先「分析」再可编辑参数后「生成」。
- [x] **Step 3:** 批量栏：筛选、上下文模式、强制、并发、开始/取消、进度与汇总（成功/失败/跳过/缓存命中）。
- [x] **Step 4:** 四语言 key 各补齐（`take.*`、`generate.*`），JSON 校验通过。
- [x] **Step 5:** 浏览器只读冒烟：打开生成阶段，选中台词能看到语境与历史；不点击真实合成。

### Task 8: 全量验证与执行日志

- [x] 定向测试全部通过。
- [x] 后端 `npm test` 全量通过；`npm run build`；`npm run test:structure`；`npm run drift`。
- [x] 前端 `npm run build`；四语言 JSON 校验。
- [x] 浏览器冒烟（不触发 TTS）并停止 dev server。
- [x] 执行日志追加阶段 3 落地记录；更新计划勾选。

---

## Self-Review

- 设计 7.2–7.11 的 Take、语境、参数优先级、缓存、单句/批量、对比切换、时间溢出、UI、API 均有对应任务；时间溢出（7.8）沿用现有 `overflowMs`/合片逻辑，阶段 3 只记录真实时长，不新增自动加速。
- 深度模式不改写正文；不支持字段按 `/tts/capabilities` 裁剪并记录 `ignored`。
- 阶段 3 不新增页面；所有入口复用现有生成阶段与 LineList。
