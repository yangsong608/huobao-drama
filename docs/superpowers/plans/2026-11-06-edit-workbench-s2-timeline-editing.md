# 剪辑工作台 S2 实施计划：时间线编辑、自动保存与版本

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **范围说明（2026-11-06，新设计扩展了本计划的范围限制）**：本计划是历史 S2 计划，正文与 Global Constraints 中“不做服务端渲染/导出、不做帧级操作、不做字幕样式/位置编辑、不做成片列表”等限制，已被 `docs/superpowers/specs/2026-11-06-film-hub-mix-edit-redesign.md` 扩展。执行新功能时以该规格说明与实践计划为准；本文件不重写历史任务，仅保留当时范围记录。

**Goal:** 在已交付的只读剪辑工作台（M1）之上，交付可编辑时间线、素材库、检查器、命令/撤销、300ms 自动保存、草稿冲突、不可变版本、多片段分镜 bootstrap、一键初剪与字幕建议，且 `edit_workspace=readonly/off` 时绝不写入。

**Architecture:** 后端新增纯函数层（URL 规范化、计划归一化、布局、台词放置、字幕建议）、写服务层（草稿/版本事务、初剪/字幕动作）和路由层；前端以 `plan` 为唯一可变状态，命令纯函数产出新计划，快照式历史 + 300ms 防抖自动保存，DOM 时间线负责交互，单 `<video>` 播放当前活动片段。所有写接口只允许 `edit_workspace=on`。

**Tech Stack:** Nuxt 3 SPA / Vue 3.5 / vue-i18n；Hono / Drizzle ORM 0.45 / better-sqlite3 / FFmpeg；Node 24（前端测试，原生 TS type stripping）、Node 22（后端测试，better-sqlite3 ABI）。

**Spec:**
- `docs/V3-剪辑工作台产品设计.md`（§4.4–4.7、§5.1–5.19、§7）
- `docs/V3-剪辑工作台技术架构设计.md`（§4.4–4.8、§6.4–6.5、§7.3–7.6、§10.3–10.6）
- `docs/V3-剪辑与混音工作台可行性与产品分析.md`（§8.2 S2 范围）

## Global Constraints

- **音频与视频必须是两个独立页面**；本计划只改剪辑工作台，不得把混音组件嵌入剪辑页。
- **不创建 git commit、不暂存（git add）**；所有改动留在工作区等待用户审阅。
- **不构建、不打包、不安装、不重启服务**，除非用户明确同意；安装通过不代表允许启动。
- 不修改用户已有模型/服务配置来绕过失败。
- 不改变端口 `5679/3013`、`V3-G5`、MCP 61 项、`TEMPLATE_VERSION=6`。
- 日志、文档、测试输出必须隐藏密钥与 IP；禁止打印 DSH 密码或执行 `ps ssh`。
- 一个能力只有一个工作区、一个播放器、一个传输层；剪辑页只保留一个 `<video>`。
- `edit_workspace=readonly/off` 时所有写接口必须返回 `403 EDIT_READONLY` / `403 EDIT_WORKSPACE_OFF`，且不得创建草稿、版本、渲染或锁。
- 后端测试必须用 Node 22 可执行文件；前端测试用 Node 24。
- 不实现 S3（服务端渲染/导出/视频池）、S4（混音桥接）、P1（导入上传、代理、叠加轨 UI、滤镜 UI、精确预览、版本 diff、字幕回写台词本）。

## S2 明确偏差（实现时按此执行）

| 设计原文 | S2 实现 | 原因 |
| --- | --- | --- |
| 时间线 Canvas 渲染（技术 §10.6） | DOM 绝对定位轨道 + 统一 `ms ↔ px` 换算、吸附纯函数 | 先保证拖拽/裁剪/字幕交互可靠；Canvas 留给 S3 性能优化，坐标逻辑已抽离 |
| 视频池 + 转场实时预览（技术 §10.7） | 单个 `<video>` 播放当前活动片段，转场处硬切 | S3 引入视频池；S2 不伪造叠化预览 |
| 导入视频/图片、代理 | 素材库“导入”标签显示禁用空态 | 无上传/代理接口，避免假入口 |
| 一键初剪自动保存/创建版本 | POST 返回计划；前端作为可撤销命令应用并自动保存；替换前前端创建版本 | 保证“先版本、后替换”，且初剪结果可撤销 |
| 字幕建议在 GET 时自动生成 | 仅首次 bootstrap 生成；后续通过“重新生成字幕建议”显式触发 | 不覆盖用户已有字幕 |
| 画面适配/缩放/位置/旋转/翻转 UI（产品 §5.9） | S2 保留计划字段与后端归一化，检查器暂不提供变换控件 | 聚焦时间线核心；变换控件留待 S3/P1 |
| 跳转混音（产品 §5.15） | 顶栏只展示 `mix_status` 状态条，不提供跨页跳转 | 混音桥接属于 S4 |
| 字幕建议两种模式（产品 §5.11） | 顶栏按钮执行 `fill`；`replace` 由 API 与自动测试覆盖，S2 不提供会删除手动字幕的 UI | 避免误删；需要替换时后续加入确认菜单 |
| 版本对比（P1） | 仅列表/详情/恢复 | P1 |
| 字幕同步回台词本（P1） | 不实现 | P1 |

---

## 共享契约（所有任务必须一致）

### 后端错误

```ts
// 所有写接口共用
type EditApiErrorBody = {
  code: string
  message: string
  data?: Record<string, unknown>
}

// 403
{ code: 'EDIT_READONLY', message: '剪辑工作台为只读模式' }
{ code: 'EDIT_WORKSPACE_OFF', message: '剪辑工作台已关闭' }

// 409
{
  code: 'EDIT_VERSION_CONFLICT',
  message: '此集已在另一个窗口修改',
  data: { current_version: number, current_plan: EditPlanV1 | null, updated_at: string | null }
}

// 400
{ code: 'EDIT_PLAN_INVALID', message: string, data: { code: string, path: string } }
{ code: 'ROUGH_CUT_NO_MATERIAL', message: '没有可用的分镜视频' }

// 404
{ code: 'EDIT_REVISION_NOT_FOUND', message: '剪辑版本不存在' }
```

### GET `/episodes/:id/edit` 响应（S2 增量字段加粗）

```ts
{
  episode_id: number
  episode_number: number
  enabled: true
  mode: 'off' | 'readonly' | 'on'
  draft: { plan: EditPlanV1; version: number; updated_at: string } | null
  current_revision: EditRevisionSummary | null
  current_revision_plan: EditPlanV1 | null
  plan: EditPlanV1
  layout: EditLayoutResponse
  hashes: {
    plan_hash: string
    render_hash: string
    edit_sync_hash: string
    dialogue_sync_hash: string
    subtitle_hash: string
  }
  draft_dirty: boolean
  mix_status: {
    status: 'missing' | 'stale' | 'aligned'
    reasons: string[]
    edit_revision_id: number | null
    mix_revision_id: number | null
    summary: unknown
  }
  renders: { cut: unknown; audio_ref: unknown }
  audio: { mode: 'video' | 'none'; url?: string; duration_ms?: number }
  media_warnings: { code: string; message: string; path?: string }[]
  line_placements: EditLinePlacementResponse[]
  rough_cut_available: boolean
  capabilities: {
    can_edit: boolean
    can_export: boolean
    lock: { kind: string; owner: string; expires_at: string } | null
  }
}

type EditRevisionSummary = {
  id: number
  revision_no: number
  note: string | null
  duration_ms: number | null
  clip_count: number | null
  plan_hash: string
  edit_sync_hash: string
  created_at: string
  is_current: boolean
}

type EditLinePlacementResponse = {
  line_id: number
  clip_id: string
  storyboard_id: number | null
  start_ms: number
  end_ms: number
  duration_ms: number
  text: string
  subtitle_text: string | null
  speaker_name: string | null
  voice_take_id: number | null
  audio_url: string | null
  audio_fingerprint: string | null
  overflows_clip: boolean
  overflow_ms: number
  anchor_type: 'shot' | 'absolute'
  warnings: string[]
}
```

### 其余接口

```ts
GET /episodes/:id/edit/media → {
  storyboards: EditMediaStoryboard[]
  video_takes: EditMediaTake[]
  lines: EditMediaLine[]
  audio: { mix: null; audio_ref: null }
  import_enabled: false
}

PUT /episodes/:id/edit/draft   body: { base_version: number; plan: EditPlanV1; force?: boolean; note?: string }
  → { version: number; updated_at: string; plan: EditPlanV1; layout: EditLayoutResponse; hashes: {...}; issues: EditIssue[]; draft_dirty: boolean }

DELETE /episodes/:id/edit/draft → { discarded: boolean }

POST /episodes/:id/edit/revisions
  body: { base_version?: number; note?: string | null; plan?: EditPlanV1 | null; update_draft?: boolean; force?: boolean }
  → { revision: EditRevisionSummary; draft_version: number | null; draft_dirty: boolean }

GET /episodes/:id/edit/revisions → { items: EditRevisionSummary[] }
GET /episodes/:id/edit/revisions/:revisionId → { revision: EditRevisionSummary; plan: EditPlanV1 }
POST /episodes/:id/edit/revisions/:revisionId/restore
  body: { base_version?: number }
  → { revision: EditRevisionSummary; draft_version: number | null; draft_dirty: boolean }

POST /episodes/:id/edit/rough-cut
  body: { mode?: 'replace' | 'append'; transition?: 'cut' | 'dissolve'; create_revision?: boolean; plan?: EditPlanV1; base_version?: number }
  → { plan: EditPlanV1; layout: EditLayoutResponse; hashes: {...}; issues: EditIssue[]; applied: { added: number; skipped: number }; snapshot_revision: EditRevisionSummary | null }

POST /episodes/:id/edit/subtitles/suggest
  body: { mode?: 'fill' | 'replace'; plan?: EditPlanV1 }
  → { plan: EditPlanV1; layout: EditLayoutResponse; hashes: {...}; issues: EditIssue[]; added: number; updated: number; skipped: number }
```

### 前端计划状态

```ts
type SaveState = 'saved' | 'saving' | 'error' | 'conflict'
type EditSelection =
  | { type: 'clip'; id: string }
  | { type: 'cue'; id: string }
  | { type: 'transition'; id: string }
  | null
```

---

## Task 1: 后端 URL 规范化与计划归一化

**Files:**
- Create: `backend/src/services/edit-source-url.ts`
- Create: `backend/src/services/edit-normalize.ts`
- Modify: `backend/src/services/edit-media.ts:32-58`
- Test: `backend/tests/edit-normalize.test.ts`

**Interfaces:**
- Produces:
  - `normalizeEditSourceUrl(raw: unknown): string`
  - `editSourceRelativePath(raw: unknown): string`
  - `EditSourceUrlError`
  - `EditPlanRejectedError(code, message, path)`
  - `normalizeEditPlan(raw: unknown, ctx: { episodeId: number; project: EditProjectSettings }): { plan: EditPlanV1; issues: EditIssue[] }`
  - `assertPlanInvariants(plan: EditPlanV1): void`
- Consumes: `edit-plan.ts` 既有常量、`validateEditPlan`、`computeLayout`。

- [ ] **Step 1: 写失败测试**

Create `backend/tests/edit-normalize.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EditPlanRejectedError,
  assertPlanInvariants,
  normalizeEditPlan,
} from '../src/services/edit-normalize.ts'
import {
  computeLayout,
  projectSettingsForAspect,
  type EditClipSource,
} from '../src/services/edit-plan.ts'
import { normalizeEditSourceUrl } from '../src/services/edit-source-url.ts'

const project = projectSettingsForAspect('16:9', 30)
const source: EditClipSource = {
  kind: 'storyboard',
  id: 1,
  url: 'static/projects/1/videos/1.mp4',
  durationMs: 10_000,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  fingerprint: '1000:1',
}

function dirtyPlan() {
  return {
    version: 1,
    episodeId: 999,
    project: { ...project, tailGapMs: 99_999 },
    clips: [{
      id: 'clp_a',
      kind: 'video',
      source,
      sourceInMs: -500,
      sourceOutMs: 12_000,
      speed: 9,
      gapBeforeMs: -3,
      videoFadeInMs: 900,
      videoFadeOutMs: 900,
      transform: { scale: 9, x: 2, y: -3, rotation: 45, flipH: 1, flipV: 0 },
      filter: { preset: 'bogus', intensity: 999 },
    }],
    transitions: [{ id: 'tr_1', fromClipId: 'clp_a', toClipId: 'ghost', type: 'bogus', durationMs: 20 }],
    subtitles: [{
      id: 'cue_1',
      text: '字'.repeat(520),
      startMs: 12_000,
      endMs: 12_000,
      style: 'bogus',
      source: 'manual',
      follow: true,
      anchor: { clipId: 'ghost', offsetMs: 0 },
    }],
    overlays: [],
    markers: [],
    layout: { contentEndMs: 1, durationMs: 1, clips: [], transitions: [] },
  }
}

test('URL 规范化保留站内相对地址并拒绝越界路径', () => {
  assert.equal(normalizeEditSourceUrl(' static/projects/1/a.mp4 '), 'static/projects/1/a.mp4')
  assert.equal(normalizeEditSourceUrl('/static/projects/1/a.mp4'), '/static/projects/1/a.mp4')
  assert.throws(() => normalizeEditSourceUrl('https://example.com/a.mp4'), /不支持远程媒体/)
  assert.throws(() => normalizeEditSourceUrl('/etc/passwd'), /不支持绝对路径/)
  assert.throws(() => normalizeEditSourceUrl('static/../secret.mp4'), /不支持的媒体路径/)
  assert.throws(() => normalizeEditSourceUrl('C:\\media\\a.mp4'), /不支持绝对路径/)
})

test('归一化截断数值、移除非法转场并重算布局', () => {
  const { plan, issues } = normalizeEditPlan(dirtyPlan(), { episodeId: 7, project })

  assert.equal(plan.episodeId, 7)
  assert.equal('layout' in plan, false)
  assert.equal(plan.project.tailGapMs, 60_000)
  const clip = plan.clips[0]
  assert.equal(clip.sourceInMs, 0)
  assert.equal(clip.sourceOutMs, 10_000)
  assert.equal(clip.speed, 4)
  assert.equal(clip.gapBeforeMs, 0)
  assert.ok(clip.videoFadeInMs + clip.videoFadeOutMs <= 2_500)
  assert.equal(clip.transform.scale, 2)
  assert.equal(clip.transform.rotation, 0)
  assert.equal(clip.filter.preset, 'none')
  assert.equal(clip.filter.intensity, 100)
  assert.deepEqual(plan.transitions, [])
  const cue = plan.subtitles[0]
  assert.equal(cue.text.length, 500)
  assert.equal(cue.follow, false)
  assert.equal(cue.anchor, null)
  assert.ok(cue.endMs > cue.startMs)
  assert.equal(plan.subtitles[0].style, 'default')
  assert.ok(issues.some((issue) => issue.code === 'CLIP_SPEED'))
  assert.ok(issues.some((issue) => issue.code === 'TRANSITION_ADJACENCY'))
  assert.doesNotThrow(() => assertPlanInvariants(plan))
  assert.equal(computeLayout(plan).clips[0].contentDurationMs, 2_500)
})

test('重复 ID、空源、过短片段与非法版本拒绝保存', () => {
  const duplicate = dirtyPlan()
  duplicate.clips.push({ ...duplicate.clips[0] })
  assert.throws(
    () => normalizeEditPlan(duplicate, { episodeId: 7, project }),
    (error: unknown) => error instanceof EditPlanRejectedError && error.code === 'CLIP_ID_DUPLICATE',
  )

  const emptyUrl = dirtyPlan()
  emptyUrl.clips[0].source = { ...source, url: ' ' }
  assert.throws(
    () => normalizeEditPlan(emptyUrl, { episodeId: 7, project }),
    (error: unknown) => error instanceof EditPlanRejectedError && error.code === 'CLIP_SOURCE_URL',
  )

  const tooShort = dirtyPlan()
  tooShort.clips[0].sourceOutMs = 50
  assert.throws(
    () => normalizeEditPlan(tooShort, { episodeId: 7, project }),
    (error: unknown) => error instanceof EditPlanRejectedError && error.code === 'CLIP_TOO_SHORT',
  )

  assert.throws(
    () => normalizeEditPlan({ ...dirtyPlan(), version: 2 }, { episodeId: 7, project }),
    (error: unknown) => error instanceof EditPlanRejectedError && error.code === 'VERSION',
  )
})
```

- [ ] **Step 2: 运行并确认失败**

Run:
```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-normalize.test.ts
```
Expected: FAIL，`Cannot find module '../src/services/edit-normalize.ts'`。

- [ ] **Step 3: 实现 `edit-source-url.ts`**

```ts
export class EditSourceUrlError extends Error {}

const REMOTE_SCHEME = /^(https?:|data:|blob:)/i
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/

function validate(raw: unknown): { value: string; relative: string } {
  const value = String(raw ?? '').trim()
  if (!value) throw new EditSourceUrlError('媒体地址为空')
  if (REMOTE_SCHEME.test(value)) throw new EditSourceUrlError(`不支持远程媒体：${value}`)
  if (value.includes('\\')) throw new EditSourceUrlError(`不支持的媒体路径：${value}`)
  if (WINDOWS_DRIVE.test(value)) throw new EditSourceUrlError(`不支持绝对路径：${value}`)

  let relative = value
  if (relative.startsWith('/static/')) relative = relative.slice(1)
  else if (relative.startsWith('/')) throw new EditSourceUrlError(`不支持绝对路径：${value}`)

  const segments = relative.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new EditSourceUrlError(`不支持的媒体路径：${value}`)
  }
  return { value, relative }
}

/** 只做语法与越界校验，保留调用方原有前导斜杠形式，避免无意义哈希变化。 */
export function normalizeEditSourceUrl(raw: unknown): string {
  return validate(raw).value
}

/** 供 storage 解析使用：始终返回 `static/...` 相对路径。 */
export function editSourceRelativePath(raw: unknown): string {
  return validate(raw).relative
}
```

- [ ] **Step 4: 改造 `edit-media.ts` 复用校验**

把 `edit-media.ts` 中 `REMOTE_SCHEME`、`WINDOWS_DRIVE`、`resolveLocalMediaPath` 的语法校验替换为：

```ts
import { editSourceRelativePath, EditSourceUrlError } from './edit-source-url.js'

function resolveLocalMediaPath(raw: string): string {
  try {
    return getAbsolutePath(editSourceRelativePath(raw))
  } catch (error) {
    if (error instanceof EditSourceUrlError) throw new Error(error.message)
    throw error
  }
}
```

删除文件内旧的 `REMOTE_SCHEME`、`WINDOWS_DRIVE` 常量；保留 `probeEditMedia` / `editSourceFromUrl` 其余逻辑不变。

- [ ] **Step 5: 实现 `edit-normalize.ts`**

```ts
import {
  MAX_CLIPS,
  MAX_FADE_MS,
  MAX_GAP_MS,
  MAX_PLAN_BYTES,
  MAX_SUBTITLES,
  MAX_TAIL_GAP_MS,
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
  clipContentDurationMs,
  computeLayout,
  minimumClipMs,
  validateEditPlan,
  type EditAspect,
  type EditClip,
  type EditClipSource,
  type EditFilterPreset,
  type EditIssue,
  type EditMarker,
  type EditOverlay,
  type EditPlanV1,
  type EditProjectSettings,
  type EditSourceKind,
  type EditSubtitleCue,
  type EditSubtitleStyle,
  type EditTransition,
  type EditTransitionType,
} from './edit-plan.js'
import { normalizeEditSourceUrl, EditSourceUrlError } from './edit-source-url.js'

export class EditPlanRejectedError extends Error {
  constructor(public code: string, message: string, public path = '') {
    super(message)
  }
}

function reject(code: string, path: string, message: string): never {
  throw new EditPlanRejectedError(code, message, path)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number) : fallback
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

const ASPECTS = new Set<EditAspect>(['9:16', '16:9', '1:1'])
const SOURCE_KINDS = new Set<EditSourceKind>(['storyboard', 'take', 'asset', 'merge', 'episode-video', 'import'])
const FILTER_PRESETS = new Set<EditFilterPreset>(['none', 'clear', 'warm', 'cool', 'cinematic', 'mono', 'vintage'])
const SUBTITLE_STYLES = new Set<EditSubtitleStyle>(['default', 'outline', 'box'])
const TRANSITION_TYPES = new Set<EditTransitionType>(['dissolve', 'white', 'push-left', 'blur'])

function issue(
  severity: EditIssue['severity'],
  code: string,
  path: string,
  message: string,
): EditIssue {
  return { severity, code, path, message }
}

function normalizeProject(raw: unknown, fallback: EditProjectSettings, issues: EditIssue[]): EditProjectSettings {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const width = input.width === undefined ? fallback.width : Number(input.width)
  const height = input.height === undefined ? fallback.height : Number(input.height)
  const fps = input.fps === undefined ? fallback.fps : Number(input.fps)
  const aspect = input.aspect === undefined ? fallback.aspect : String(input.aspect)
  if (!Number.isInteger(width) || width < 16 || width > 7680 || width % 2 !== 0) {
    reject('PROJECT_WIDTH', 'project.width', '输出宽度必须为 16–7680 的偶数')
  }
  if (!Number.isInteger(height) || height < 16 || height > 7680 || height % 2 !== 0) {
    reject('PROJECT_HEIGHT', 'project.height', '输出高度必须为 16–7680 的偶数')
  }
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) {
    reject('PROJECT_FPS', 'project.fps', '帧率必须在 1–120')
  }
  if (!ASPECTS.has(aspect as EditAspect)) {
    reject('PROJECT_ASPECT', 'project.aspect', '画幅必须为 9:16、16:9 或 1:1')
  }
  const tailRaw = input.tailGapMs === undefined ? fallback.tailGapMs : Number(input.tailGapMs)
  const tailGapMs = clamp(round(tailRaw, fallback.tailGapMs), 0, MAX_TAIL_GAP_MS)
  if (tailGapMs !== round(tailRaw, fallback.tailGapMs)) {
    issues.push(issue('warning', 'PROJECT_TAIL_GAP', 'project.tailGapMs', '尾段空档已截断到 0–60000ms'))
  }
  const background = input.background === 'blur' ? 'blur' : 'black'
  const defaultFit = input.defaultFit === 'fill' ? 'fill' : 'fit'
  const defaultTransition = input.defaultTransition === 'dissolve' ? 'dissolve' : 'cut'
  const style = SUBTITLE_STYLES.has(input.defaultSubtitleStyle as EditSubtitleStyle)
    ? input.defaultSubtitleStyle as EditSubtitleStyle
    : fallback.defaultSubtitleStyle
  return {
    ...fallback,
    aspect: aspect as EditAspect,
    width,
    height,
    fps,
    background,
    defaultFit,
    defaultTransition,
    defaultSubtitleStyle: style,
    defaultExportPreset: text(input.defaultExportPreset, fallback.defaultExportPreset),
    tailGapMs,
  }
}

function normalizeSource(raw: unknown, path: string): EditClipSource {
  if (!raw || typeof raw !== 'object') reject('CLIP_SOURCE', `${path}.source`, '片段缺少源素材')
  const input = raw as Record<string, unknown>
  let url: string
  try {
    url = normalizeEditSourceUrl(input.url)
  } catch (error) {
    const message = error instanceof EditSourceUrlError ? error.message : '源素材地址无效'
    reject('CLIP_SOURCE_URL', `${path}.source.url`, message)
  }
  const id = typeof input.id === 'number' && Number.isFinite(input.id)
    ? input.id
    : text(input.id).trim()
  if (id === '') reject('CLIP_SOURCE', `${path}.source.id`, '源素材缺少 id')
  const durationMs = round(input.durationMs)
  if (durationMs <= 0) reject('CLIP_SOURCE_DURATION', `${path}.source.durationMs`, '源素材时长无效')
  const kind = SOURCE_KINDS.has(input.kind as EditSourceKind) ? input.kind as EditSourceKind : 'import'
  const fpsRaw = Number(input.fps)
  return {
    kind,
    id,
    url,
    durationMs,
    width: Math.max(1, round(input.width, 1080)),
    height: Math.max(1, round(input.height, 1920)),
    fps: Number.isFinite(fpsRaw) && fpsRaw > 0 ? fpsRaw : null,
    hasAudio: Boolean(input.hasAudio),
    fingerprint: text(input.fingerprint),
    ...(text(input.label) ? { label: text(input.label) } : {}),
    ...(text(input.thumbnailUrl) ? { thumbnailUrl: text(input.thumbnailUrl) } : {}),
  }
}

function normalizeTransitionType(value: unknown): EditTransitionType {
  return TRANSITION_TYPES.has(value as EditTransitionType) ? value as EditTransitionType : 'dissolve'
}

function normalizeClip(
  raw: unknown,
  index: number,
  project: EditProjectSettings,
  issues: EditIssue[],
  seen: Set<string>,
): EditClip {
  const path = `clips[${index}]`
  if (!raw || typeof raw !== 'object') reject('CLIP_INVALID', path, '片段必须是对象')
  const input = raw as Record<string, unknown>
  const id = text(input.id).trim()
  if (!id) reject('CLIP_ID_DUPLICATE', `${path}.id`, '片段 ID 必须唯一且非空')
  if (seen.has(id)) reject('CLIP_ID_DUPLICATE', `${path}.id`, '片段 ID 必须唯一且非空')
  seen.add(id)

  const source = normalizeSource(input.source, path)
  const sourceInMs = Math.max(0, round(input.sourceInMs))
  let sourceOutMs = round(input.sourceOutMs)
  if (!Number.isFinite(Number(input.sourceOutMs)) || sourceOutMs <= 0) {
    reject('CLIP_SOURCE_RANGE', `${path}.sourceOutMs`, '源入点/出点无效')
  }
  if (sourceOutMs > source.durationMs) {
    issues.push(issue('warning', 'CLIP_SOURCE_OUT', `${path}.sourceOutMs`, '源出点已截断到素材时长'))
    sourceOutMs = source.durationMs
  }
  if (sourceInMs >= sourceOutMs) {
    reject('CLIP_SOURCE_RANGE', `${path}.sourceInMs`, '源入点/出点无效')
  }

  const speedRaw = input.speed === undefined ? 1 : Number(input.speed)
  const speed = Math.round(clamp(Number.isFinite(speedRaw) ? speedRaw : 1, 0.25, 4) * 1000) / 1000
  if (speed !== speedRaw) issues.push(issue('warning', 'CLIP_SPEED', `${path}.speed`, '变速已截断到 0.25–4.0'))
  const gapRaw = round(input.gapBeforeMs)
  const gapBeforeMs = clamp(gapRaw, 0, MAX_GAP_MS)
  if (gapBeforeMs !== gapRaw) issues.push(issue('warning', 'CLIP_GAP', `${path}.gapBeforeMs`, '片段空档已截断到 0–300000ms'))

  const minMs = minimumClipMs(project.fps)
  if (sourceOutMs - sourceInMs < minMs) {
    reject('CLIP_TOO_SHORT', path, `片段不得短于 ${minMs}ms（3 帧）`)
  }

  let fadeIn = clamp(round(input.videoFadeInMs), 0, MAX_FADE_MS)
  let fadeOut = clamp(round(input.videoFadeOutMs), 0, MAX_FADE_MS)
  const content = Math.round((sourceOutMs - sourceInMs) / speed)
  if (content < minMs) reject('CLIP_TOO_SHORT', path, `片段不得短于 ${minMs}ms（3 帧）`)
  if (fadeIn + fadeOut > content && fadeIn + fadeOut > 0) {
    const ratio = content / (fadeIn + fadeOut)
    fadeIn = Math.floor(fadeIn * ratio)
    fadeOut = Math.floor(fadeOut * ratio)
    issues.push(issue('warning', 'CLIP_FADE_SUM', path, '淡入淡出之和超过片段时长，已等比缩短'))
  }

  const transformInput = input.transform && typeof input.transform === 'object'
    ? input.transform as Record<string, unknown>
    : {}
  const rotationRaw = round(transformInput.rotation)
  const rotation = rotationRaw === 90 || rotationRaw === 180 || rotationRaw === 270 ? rotationRaw : 0
  if (rotation !== rotationRaw) issues.push(issue('warning', 'CLIP_TRANSFORM', `${path}.transform.rotation`, '旋转已回落为 0°'))
  const transform = {
    scale: Math.round(clamp(Number(transformInput.scale) || 1, 0.5, 2) * 100) / 100,
    x: Math.round(clamp(Number(transformInput.x) || 0, -1, 1) * 100) / 100,
    y: Math.round(clamp(Number(transformInput.y) || 0, -1, 1) * 100) / 100,
    rotation: rotation as 0 | 90 | 180 | 270,
    flipH: Boolean(transformInput.flipH),
    flipV: Boolean(transformInput.flipV),
  }

  const filterInput = input.filter && typeof input.filter === 'object'
    ? input.filter as Record<string, unknown>
    : {}
  const filterPreset = FILTER_PRESETS.has(filterInput.preset as EditFilterPreset)
    ? filterInput.preset as EditFilterPreset
    : 'none'
  const filter = {
    preset: filterPreset,
    intensity: clamp(round(filterInput.intensity, 100), 0, 100),
  }

  return {
    id,
    kind: input.kind === 'image' ? 'image' : 'video',
    source,
    sourceInMs,
    sourceOutMs,
    speed,
    gapBeforeMs,
    videoFadeInMs: fadeIn,
    videoFadeOutMs: fadeOut,
    transform,
    filter,
    lineId: Number.isSafeInteger(Number(input.lineId)) && Number(input.lineId) > 0 ? Number(input.lineId) : null,
    videoTakeAssetId: Number.isSafeInteger(Number(input.videoTakeAssetId)) && Number(input.videoTakeAssetId) > 0
      ? Number(input.videoTakeAssetId)
      : null,
  }
}

function normalizeTransitions(
  raw: unknown,
  clips: EditClip[],
  project: EditProjectSettings,
  issues: EditIssue[],
): EditTransition[] {
  if (!Array.isArray(raw)) return []
  const index = new Map(clips.map((clip, position) => [clip.id, position]))
  const used = new Set<number>()
  const result: EditTransition[] = []
  raw.forEach((value, position) => {
    if (!value || typeof value !== 'object') return
    const input = value as Record<string, unknown>
    const fromIndex = index.get(text(input.fromClipId))
    const toIndex = index.get(text(input.toClipId))
    if (fromIndex === undefined || toIndex === undefined || toIndex !== fromIndex + 1) {
      issues.push(issue('warning', 'TRANSITION_ADJACENCY', `transitions[${position}]`, '转场只能位于主轨相邻片段之间，已移除'))
      return
    }
    if (used.has(toIndex)) {
      issues.push(issue('warning', 'TRANSITION_DUPLICATE', `transitions[${position}]`, '一个交界最多一个转场，已移除'))
      return
    }
    const toClip = clips[toIndex]
    if (toClip.gapBeforeMs > 0) {
      issues.push(issue('warning', 'TRANSITION_GAP', `transitions[${position}]`, '有间隙的交界不允许转场，已移除'))
      return
    }
    const available = Math.min(clipContentDurationMs(clips[fromIndex]), clipContentDurationMs(toClip))
      - 1000 / Math.max(1, project.fps)
    if (available < MIN_TRANSITION_MS) {
      issues.push(issue('warning', 'TRANSITION_OVERFLOW', `transitions[${position}]`, '转场余量不足 100ms，已移除'))
      return
    }
    const durationRaw = round(input.durationMs, 400)
    const durationMs = clamp(durationRaw, MIN_TRANSITION_MS, Math.min(MAX_TRANSITION_MS, Math.floor(available)))
    if (durationMs !== durationRaw) {
      issues.push(issue('warning', 'TRANSITION_RANGE', `transitions[${position}]`, '转场时长已按可用余量裁剪'))
    }
    used.add(toIndex)
    result.push({
      id: text(input.id).trim() || `tr_${clips[fromIndex].id}_${toClip.id}`,
      fromClipId: clips[fromIndex].id,
      toClipId: toClip.id,
      type: normalizeTransitionType(input.type),
      durationMs,
    })
  })
  return result
}

function normalizeSubtitles(
  raw: unknown,
  plan: EditPlanV1,
  issues: EditIssue[],
): EditSubtitleCue[] {
  if (!Array.isArray(raw)) return []
  const ids = new Set<string>()
  const cues: EditSubtitleCue[] = []
  raw.forEach((value, position) => {
    if (!value || typeof value !== 'object') return
    const input = value as Record<string, unknown>
    let id = text(input.id).trim() || `cue_${position + 1}`
    while (ids.has(id)) id = `${id}_${position + 1}`
    ids.add(id)
    const cueText = text(input.text)
    if (!cueText) {
      issues.push(issue('warning', 'SUBTITLE_TEXT_EMPTY', `subtitles[${position}]`, '空字幕已移除'))
      return
    }
    let startMs = Math.max(0, round(input.startMs))
    let endMs = Math.max(0, round(input.endMs))
    if (endMs <= startMs) {
      endMs = startMs + 100
      issues.push(issue('warning', 'SUBTITLE_RANGE', `subtitles[${position}]`, '字幕起止无效，已修正为 100ms'))
    }
    const source = input.source === 'line' || input.source === 'import' ? input.source : 'manual'
    const anchorInput = input.anchor && typeof input.anchor === 'object'
      ? input.anchor as Record<string, unknown>
      : null
    cues.push({
      id,
      text: cueText.slice(0, 500),
      startMs,
      endMs,
      style: SUBTITLE_STYLES.has(input.style as EditSubtitleStyle)
        ? input.style as EditSubtitleStyle
        : plan.project.defaultSubtitleStyle,
      role: text(input.role) || null,
      source,
      follow: Boolean(input.follow) && Boolean(anchorInput),
      anchor: anchorInput
        ? { clipId: text(anchorInput.clipId), offsetMs: round(anchorInput.offsetMs) }
        : null,
      lineId: Number.isSafeInteger(Number(input.lineId)) && Number(input.lineId) > 0 ? Number(input.lineId) : null,
      warnings: Array.isArray(input.warnings) ? input.warnings.filter((item): item is string => typeof item === 'string') : [],
    })
  })

  const clipIndex = new Map(plan.clips.map((clip) => [clip.id, clip]))
  const layout = computeLayout(plan)
  const layoutIndex = new Map(layout.clips.map((clip) => [clip.clipId, clip]))
  for (const cue of cues) {
    const duration = Math.max(100, cue.endMs - cue.startMs)
    if (cue.follow) {
      const anchor = cue.anchor
      const layoutClip = anchor ? layoutIndex.get(anchor.clipId) : undefined
      if (!anchor || !clipIndex.has(anchor.clipId) || !layoutClip) {
        cue.follow = false
        cue.anchor = null
        issues.push(issue('warning', 'SUBTITLE_ANCHOR', `subtitles.${cue.id}`, '跟随字幕缺少有效片段锚点，已转为固定字幕'))
      } else {
        let start = layoutClip.timelineStartMs + Math.max(0, anchor.offsetMs)
        let end = start + duration
        if (start < layoutClip.timelineStartMs) start = layoutClip.timelineStartMs
        if (end > layoutClip.timelineEndMs) {
          end = layoutClip.timelineEndMs
          issues.push(issue('warning', 'SUBTITLE_OVERFLOW', `subtitles.${cue.id}`, '字幕超出片段，已截断'))
        }
        if (end <= start) {
          start = layoutClip.timelineStartMs
          end = Math.min(layoutClip.timelineEndMs, start + 100)
        }
        cue.startMs = Math.round(start)
        cue.endMs = Math.round(end)
        cue.anchor = { clipId: anchor.clipId, offsetMs: cue.startMs - layoutClip.timelineStartMs }
      }
    }
    if (layout.durationMs > 0) {
      if (cue.startMs >= layout.durationMs) {
        cue.startMs = Math.max(0, layout.durationMs - 100)
        cue.endMs = layout.durationMs
        issues.push(issue('warning', 'SUBTITLE_BEYOND_END', `subtitles.${cue.id}`, '字幕超出总时长，已截断'))
      }
      if (cue.endMs > layout.durationMs) cue.endMs = layout.durationMs
      if (cue.endMs <= cue.startMs) cue.endMs = Math.min(layout.durationMs, cue.startMs + 100)
    }
  }
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id))
}

function normalizeOverlays(raw: unknown, issues: EditIssue[]): EditOverlay[] {
  if (!Array.isArray(raw)) return []
  const result: EditOverlay[] = []
  const ids = new Set<string>()
  raw.forEach((value, position) => {
    if (!value || typeof value !== 'object') return
    const input = value as Record<string, unknown>
    const id = text(input.id).trim() || `ov_${position + 1}`
    if (ids.has(id)) return
    ids.add(id)
    const startMs = Math.max(0, round(input.startMs))
    const endMs = Math.max(0, round(input.endMs))
    if (endMs <= startMs) {
      issues.push(issue('warning', 'OVERLAY_RANGE', `overlays[${position}]`, '叠加轨起止无效，已移除'))
      return
    }
    const textInput = input.text && typeof input.text === 'object' ? input.text as Record<string, unknown> : null
    const transformInput = input.transform && typeof input.transform === 'object'
      ? input.transform as Record<string, unknown>
      : {}
    result.push({
      id,
      kind: input.kind === 'video' || input.kind === 'image' ? input.kind : 'text',
      ...(input.source && typeof input.source === 'object'
        ? { source: normalizeSource(input.source, `overlays[${position}].source`) }
        : {}),
      ...(textInput
        ? {
            text: {
              text: text(textInput.text).slice(0, 500),
              preset: textInput.preset === 'title' || textInput.preset === 'name' || textInput.preset === 'place'
                ? textInput.preset
                : 'subtitle',
              fontFamily: text(textInput.fontFamily, 'sans-serif'),
              fontSize: clamp(round(textInput.fontSize, 48), 8, 300),
              color: text(textInput.color, '#ffffff'),
              strokeColor: text(textInput.strokeColor, '#000000'),
              strokeWidth: clamp(round(textInput.strokeWidth), 0, 20),
              backgroundColor: text(textInput.backgroundColor) || null,
              align: textInput.align === 'left' || textInput.align === 'right' ? textInput.align : 'center',
              x: clamp(Number(textInput.x) || 0.5, 0, 1),
              y: clamp(Number(textInput.y) || 0.5, 0, 1),
            },
          }
        : {}),
      startMs,
      endMs,
      transform: {
        scale: Math.round(clamp(Number(transformInput.scale) || 1, 0.1, 4) * 100) / 100,
        x: clamp(Number(transformInput.x) || 0, -2, 2),
        y: clamp(Number(transformInput.y) || 0, -2, 2),
        rotation: 0,
        flipH: false,
        flipV: false,
      },
      opacity: clamp(Number(input.opacity ?? 1) || 0, 0, 1),
      fadeInMs: clamp(round(input.fadeInMs), 0, MAX_FADE_MS),
      fadeOutMs: clamp(round(input.fadeOutMs), 0, MAX_FADE_MS),
      track: 0,
    })
  })
  return result
}

function normalizeMarkers(raw: unknown): EditMarker[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((value, position) => {
    if (!value || typeof value !== 'object') return []
    const input = value as Record<string, unknown>
    const id = text(input.id).trim() || `mk_${position + 1}`
    return [{
      id,
      atMs: Math.max(0, round(input.atMs)),
      label: text(input.label).slice(0, 100),
      color: text(input.color, '#f59e0b'),
    }]
  })
}

export function normalizeEditPlan(
  raw: unknown,
  ctx: { episodeId: number; project: EditProjectSettings },
): { plan: EditPlanV1; issues: EditIssue[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    reject('PLAN_INVALID', '', '计划必须是对象')
  }
  const input = raw as Record<string, unknown>
  if (Number(input.version) !== 1) reject('VERSION', 'version', '计划版本必须为 1')
  const issues: EditIssue[] = []
  const project = normalizeProject(input.project, ctx.project, issues)
  if (!Array.isArray(input.clips)) reject('CLIPS_INVALID', 'clips', '片段列表必须是数组')
  if (input.clips.length > MAX_CLIPS) reject('CLIP_LIMIT', 'clips', `片段数不能超过 ${MAX_CLIPS}`)
  if (Array.isArray(input.subtitles) && input.subtitles.length > MAX_SUBTITLES) {
    reject('SUBTITLE_LIMIT', 'subtitles', `字幕数不能超过 ${MAX_SUBTITLES}`)
  }

  const seen = new Set<string>()
  const clips = input.clips.map((clip, index) => normalizeClip(clip, index, project, issues, seen))
  const transitions = normalizeTransitions(input.transitions, clips, project, issues)
  const basePlan: EditPlanV1 = {
    version: 1,
    episodeId: ctx.episodeId,
    project,
    clips,
    transitions,
    subtitles: [],
    overlays: normalizeOverlays(input.overlays, issues),
    markers: normalizeMarkers(input.markers),
  }
  basePlan.subtitles = normalizeSubtitles(input.subtitles, basePlan, issues)

  assertPlanInvariants(basePlan)
  return { plan: basePlan, issues }
}

export function assertPlanInvariants(plan: EditPlanV1): void {
  const errors = validateEditPlan(plan).filter((item) => item.severity === 'error')
  if (errors.length) {
    const first = errors[0]
    throw new EditPlanRejectedError(first.code, first.message, first.path)
  }
  if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > MAX_PLAN_BYTES) {
    reject('PLAN_BYTES', '', '计划 JSON 不能超过 8 MB')
  }
}
```

- [ ] **Step 6: 运行测试并修正**

Run:
```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-normalize.test.ts tests/edit-media.test.ts
```
Expected: PASS。若 `edit-media.test.ts` 的错误文案与共享校验不一致，保持测试中的原文案（`不支持远程媒体`、`媒体文件不存在`、`不支持绝对路径`、`不支持的媒体路径`），只允许改动实现。

- [ ] **Step 7: 类型检查（不提交）**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run typecheck
```
Expected: PASS。**不要执行 git add / git commit。**

---

## Task 2: 台词放置与字幕建议纯函数

**Files:**
- Create: `backend/src/services/edit-timeline.ts`
- Test: `backend/tests/edit-timeline.test.ts`

**Interfaces:**
- Produces:
  - `buildEditTimeline(plan: EditPlanV1, lines: EditLineRow[], takes: EditTakeRow[]): EditTimelineResult`
  - `suggestSubtitles(plan: EditPlanV1, placements: EditLinePlacement[]): EditSubtitleCue[]`
  - `mergeSuggestedSubtitles(existing: EditSubtitleCue[], suggested: EditSubtitleCue[]): { cues: EditSubtitleCue[]; added: number; updated: number }`
  - `dialogPlacementsOf(placements: EditLinePlacement[]): DialoguePlacement[]`
  - `EditLineRow`、`EditTakeRow`、`EditLinePlacement`、`EditTimelineResult`、`UnmappedLine`
- 常量：`MIN_LEAD_MS=250`、`LINE_GAP_MS=180`、`MIN_LINE_MS=300`、`SUBTITLE_TAIL_GAP_MS=100`、`SUBTITLE_MAX_CHARS=40`、`SUBTITLE_MIN_MS=800`。
- Consumes: `edit-plan.ts` 的布局与哈希类型。

- [ ] **Step 1: 写失败测试**

Create `backend/tests/edit-timeline.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LINE_GAP_MS,
  MIN_LEAD_MS,
  buildEditTimeline,
  dialogPlacementsOf,
  mergeSuggestedSubtitles,
  suggestSubtitles,
  type EditLineRow,
  type EditTakeRow,
} from '../src/services/edit-timeline.ts'
import {
  createEmptyEditPlan,
  dialogueSyncHashOf,
  projectSettingsForAspect,
  type EditClipSource,
} from '../src/services/edit-plan.ts'

const project = projectSettingsForAspect('16:9', 30)

function source(id: number, durationMs: number): EditClipSource {
  return {
    kind: 'storyboard',
    id,
    url: `static/projects/1/videos/${id}.mp4`,
    durationMs,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    fingerprint: `${durationMs}:1`,
  }
}

function plan() {
  const value = createEmptyEditPlan(42, project)
  value.clips = [
    {
      id: 'clp_sb_11', kind: 'video', source: source(11, 5000), sourceInMs: 0, sourceOutMs: 5000,
      speed: 1, gapBeforeMs: 0, videoFadeInMs: 0, videoFadeOutMs: 0,
      transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
      filter: { preset: 'none', intensity: 100 },
    },
    {
      id: 'clp_sb_12', kind: 'video', source: source(12, 4000), sourceInMs: 0, sourceOutMs: 4000,
      speed: 1, gapBeforeMs: 0, videoFadeInMs: 0, videoFadeOutMs: 0,
      transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
      filter: { preset: 'none', intensity: 100 },
    },
  ]
  return value
}

function line(patch: Partial<EditLineRow>): EditLineRow {
  return {
    id: 1,
    storyboardId: 11,
    lineNo: 1,
    sortOrder: 0,
    text: '台词',
    subtitleText: null,
    speakerName: '林晚',
    speakerType: 'dialogue',
    voiceId: null,
    voiceStartMs: null,
    voiceDurationMs: null,
    audioUrl: 'static/audio/1.mp3',
    audioDurationMs: 1000,
    activeTakeId: null,
    anchorType: 'shot',
    ...patch,
  }
}

const takes: EditTakeRow[] = [{
  id: 77,
  lineId: 1,
  audioUrl: 'static/audio/take77.mp3',
  durationMs: 1200,
  hash: 'take77hash',
  isActive: true,
}]

test('按镜头顺序放置台词，保留溢出并映射绝对锚点', () => {
  const lines: EditLineRow[] = [
    line({ id: 1, audioDurationMs: 1000, activeTakeId: 77 }),
    line({ id: 2, lineNo: 2, audioDurationMs: 5000, text: '第二句' }),
    line({ id: 3, storyboardId: 12, lineNo: 1, audioDurationMs: 800, text: '第三句' }),
    line({ id: 4, storyboardId: 99, lineNo: 1, text: '无镜头' }),
    line({ id: 5, storyboardId: 12, lineNo: 2, anchorType: 'absolute', voiceStartMs: 6200, audioDurationMs: 900, text: '绝对句' }),
  ]
  const result = buildEditTimeline(plan(), lines, takes)

  assert.equal(result.durationMs, 9000)
  assert.equal(result.linePlacements.length, 4)
  assert.equal(result.unmappedLines.length, 1)
  assert.equal(result.unmappedLines[0].lineId, 4)

  const [first, second, third, absolute] = result.linePlacements
  assert.equal(first.lineId, 1)
  assert.equal(first.startMs, MIN_LEAD_MS)
  assert.equal(first.durationMs, 1200)
  assert.equal(first.voiceTakeId, 77)
  assert.equal(first.audioUrl, 'static/audio/take77.mp3')
  assert.equal(first.audioFingerprint, 'take77hash')

  assert.equal(second.startMs, MIN_LEAD_MS + 1200 + LINE_GAP_MS)
  assert.equal(second.overflowsClip, true)
  assert.ok(second.overflowMs > 0)

  assert.equal(third.clipId, 'clp_sb_12')
  assert.equal(third.startMs, 5000 + MIN_LEAD_MS)
  assert.equal(absolute.startMs, 6200)
  assert.equal(absolute.anchorType, 'absolute')

  const cues = suggestSubtitles(plan(), result.linePlacements)
  assert.equal(cues.length, 4)
  assert.equal(cues[0].follow, true)
  assert.deepEqual(cues[0].anchor, { clipId: 'clp_sb_11', offsetMs: MIN_LEAD_MS })
  assert.equal(cues[0].source, 'line')
  assert.equal(cues[0].lineId, 1)
  assert.ok(cues[1].warnings?.includes('SUBTITLE_OVERFLOW'))
  const absoluteCue = cues.find((cue) => cue.lineId === 5)
  assert.equal(absoluteCue?.startMs, 6200)

  const hashA = dialogueSyncHashOf(dialogPlacementsOf(result.linePlacements))
  const hashB = dialogueSyncHashOf(dialogPlacementsOf(result.linePlacements))
  assert.equal(hashA, hashB)
})

test('字幕合并不覆盖手动文本，只刷新未改动的台词 cue', () => {
  const result = buildEditTimeline(plan(), [line({ id: 1 })], [])
  const suggested = suggestSubtitles(plan(), result.linePlacements)
  const manual = {
    ...suggested[0],
    text: '用户改过的字幕',
    source: 'manual' as const,
    follow: false,
    anchor: null,
  }
  const merged = mergeSuggestedSubtitles([manual], suggested)
  assert.equal(merged.added, 0)
  assert.equal(merged.updated, 0)
  assert.equal(merged.cues[0].text, '用户改过的字幕')

  const editable = { ...suggested[0], text: '台词', startMs: 0, endMs: 100 }
  const refreshed = mergeSuggestedSubtitles([editable], suggested)
  assert.equal(refreshed.updated, 1)
  assert.equal(refreshed.cues[0].startMs, suggested[0].startMs)
})
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-timeline.test.ts
```
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `edit-timeline.ts`**

```ts
import {
  computeLayout,
  type DialoguePlacement,
  type EditPlanV1,
  type EditSubtitleCue,
} from './edit-plan.js'

export const MIN_LEAD_MS = 250
export const LINE_GAP_MS = 180
export const MIN_LINE_MS = 300
export const SUBTITLE_TAIL_GAP_MS = 100
export const SUBTITLE_MAX_CHARS = 40
export const SUBTITLE_MIN_MS = 800
const CHAR_MS = 220

export interface EditLineRow {
  id: number
  storyboardId: number | null
  lineNo: number
  sortOrder: number | null
  text: string
  subtitleText: string | null
  speakerName: string | null
  speakerType: string
  voiceId: number | null
  voiceStartMs: number | null
  voiceDurationMs: number | null
  audioUrl: string | null
  audioDurationMs: number | null
  activeTakeId: number | null
  anchorType: string | null
}

export interface EditTakeRow {
  id: number
  lineId: number
  audioUrl: string | null
  durationMs: number | null
  hash: string | null
  isActive: boolean
}

export interface EditLinePlacement {
  lineId: number
  clipId: string
  storyboardId: number | null
  startMs: number
  endMs: number
  durationMs: number
  text: string
  subtitleText: string | null
  speakerName: string | null
  voiceTakeId: number | null
  audioUrl: string | null
  audioFingerprint: string | null
  overflowsClip: boolean
  overflowMs: number
  anchorType: 'shot' | 'absolute'
  warnings: string[]
}

export interface UnmappedLine {
  lineId: number
  text: string
  reason: 'no_clip' | 'absolute_unmapped'
}

export interface EditAudioSegment {
  clipId: string
  sourceUrl: string
  sourceInMs: number
  sourceOutMs: number
  speed: number
  timelineStartMs: number
  timelineEndMs: number
  hasAudio: boolean
}

export interface EditTimelineResult {
  durationMs: number
  linePlacements: EditLinePlacement[]
  audioSegments: EditAudioSegment[]
  unmappedLines: UnmappedLine[]
}

function estimateDuration(text: string): number {
  return Math.max(MIN_LINE_MS, Array.from(text).length * CHAR_MS)
}

function activeTakeOf(line: EditLineRow, takesByLine: Map<number, EditTakeRow[]>): EditTakeRow | null {
  const list = takesByLine.get(line.id) ?? []
  return list.find((take) => take.id === line.activeTakeId)
    ?? list.find((take) => take.isActive)
    ?? [...list].sort((a, b) => b.id - a.id)[0]
    ?? null
}

function placementOf(input: {
  line: EditLineRow
  clipId: string
  storyboardId: number | null
  startMs: number
  endMs: number
  clipEndMs: number | null
  take: EditTakeRow | null
  anchorType: 'shot' | 'absolute'
}): EditLinePlacement {
  const { line, take } = input
  const durationMs = Math.max(
    MIN_LINE_MS,
    Math.round(
      take?.durationMs
      ?? line.voiceDurationMs
      ?? line.audioDurationMs
      ?? estimateDuration(line.text),
    ),
  )
  const startMs = Math.round(input.startMs)
  const endMs = Math.round(input.endMs ?? startMs + durationMs)
  const overflowMs = input.clipEndMs === null ? 0 : Math.max(0, endMs - input.clipEndMs)
  return {
    lineId: line.id,
    clipId: input.clipId,
    storyboardId: input.storyboardId,
    startMs,
    endMs,
    durationMs,
    text: line.text,
    subtitleText: line.subtitleText,
    speakerName: line.speakerName,
    voiceTakeId: take?.id ?? null,
    audioUrl: take?.audioUrl ?? line.audioUrl,
    audioFingerprint: take?.hash ?? null,
    overflowsClip: overflowMs > 0,
    overflowMs,
    anchorType: input.anchorType,
    warnings: overflowMs > 0 ? ['LINE_OVERFLOW'] : [],
  }
}

export function buildEditTimeline(
  plan: EditPlanV1,
  lines: EditLineRow[],
  takes: EditTakeRow[],
): EditTimelineResult {
  const layout = computeLayout(plan)
  const takesByLine = new Map<number, EditTakeRow[]>()
  for (const take of takes) {
    const list = takesByLine.get(take.lineId) ?? []
    list.push(take)
    takesByLine.set(take.lineId, list)
  }

  const linesByStoryboard = new Map<number, EditLineRow[]>()
  for (const line of lines) {
    if (line.storyboardId == null) continue
    const list = linesByStoryboard.get(line.storyboardId) ?? []
    list.push(line)
    linesByStoryboard.set(line.storyboardId, list)
  }
  for (const list of linesByStoryboard.values()) {
    list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.lineNo - b.lineNo || a.id - b.id)
  }

  const placements: EditLinePlacement[] = []
  const unmappedLines: UnmappedLine[] = []
  const placed = new Set<number>()

  for (const layoutClip of layout.clips) {
    const clip = plan.clips.find((item) => item.id === layoutClip.clipId)
    if (!clip || clip.source.kind !== 'storyboard') continue
    const storyboardId = Number(clip.source.id)
    if (!Number.isFinite(storyboardId)) continue
    const shotLines = linesByStoryboard.get(storyboardId) ?? []
    const clipDuration = layoutClip.timelineEndMs - layoutClip.timelineStartMs
    const lead = Math.max(0, Math.min(MIN_LEAD_MS, Math.max(0, clipDuration - 500)))
    let cursor = lead
    for (const line of shotLines) {
      if (placed.has(line.id)) continue
      if (line.voiceStartMs !== null && line.voiceStartMs !== undefined) continue
      const take = activeTakeOf(line, takesByLine)
      const durationMs = Math.max(
        MIN_LINE_MS,
        Math.round(take?.durationMs ?? line.voiceDurationMs ?? line.audioDurationMs ?? estimateDuration(line.text)),
      )
      const startMs = layoutClip.timelineStartMs + cursor
      const endMs = startMs + durationMs
      placements.push(placementOf({
        line,
        clipId: layoutClip.clipId,
        storyboardId,
        startMs,
        endMs,
        clipEndMs: layoutClip.timelineEndMs,
        take,
        anchorType: 'shot',
      }))
      placed.add(line.id)
      cursor += durationMs + LINE_GAP_MS
    }
  }

  const layoutIndex = new Map(layout.clips.map((clip) => [clip.clipId, clip]))
  const absoluteLines = [...lines].sort((a, b) => (a.voiceStartMs ?? Number.MAX_SAFE_INTEGER) - (b.voiceStartMs ?? Number.MAX_SAFE_INTEGER) || a.lineNo - b.lineNo)
  for (const line of absoluteLines) {
    if (placed.has(line.id)) continue
    const take = activeTakeOf(line, takesByLine)
    const durationMs = Math.max(
      MIN_LINE_MS,
      Math.round(take?.durationMs ?? line.voiceDurationMs ?? line.audioDurationMs ?? estimateDuration(line.text)),
    )

    if (line.voiceStartMs === null || line.voiceStartMs === undefined) {
      if (line.storyboardId != null) {
        unmappedLines.push({ lineId: line.id, text: line.text, reason: 'no_clip' })
        continue
      }
      const first = layout.clips[0]
      if (!first) {
        unmappedLines.push({ lineId: line.id, text: line.text, reason: 'absolute_unmapped' })
        continue
      }
      placements.push(placementOf({
        line,
        clipId: first.clipId,
        storyboardId: null,
        startMs: first.timelineStartMs + MIN_LEAD_MS,
        endMs: first.timelineStartMs + MIN_LEAD_MS + durationMs,
        clipEndMs: first.timelineEndMs,
        take,
        anchorType: 'absolute',
      }))
      placed.add(line.id)
      continue
    }

    const atMs = Math.max(0, Math.round(line.voiceStartMs))
    const covering = layout.clips.find((clip) => atMs >= clip.timelineStartMs && atMs < clip.timelineEndMs)
      ?? layout.clips[layout.clips.length - 1]
    if (!covering) {
      unmappedLines.push({ lineId: line.id, text: line.text, reason: 'absolute_unmapped' })
      continue
    }
    const startMs = Math.max(covering.timelineStartMs, Math.min(atMs, covering.timelineEndMs - MIN_LINE_MS))
    placements.push(placementOf({
      line,
      clipId: covering.clipId,
      storyboardId: line.storyboardId,
      startMs,
      endMs: startMs + durationMs,
      clipEndMs: covering.timelineEndMs,
      take,
      anchorType: 'absolute',
    }))
    placed.add(line.id)
    if (!layoutIndex.has(covering.clipId)) {
      unmappedLines.push({ lineId: line.id, text: line.text, reason: 'absolute_unmapped' })
    }
  }

  for (const line of lines) {
    if (!placed.has(line.id) && !unmappedLines.some((item) => item.lineId === line.id)) {
      unmappedLines.push({
        lineId: line.id,
        text: line.text,
        reason: line.storyboardId == null ? 'absolute_unmapped' : 'no_clip',
      })
    }
  }

  placements.sort((a, b) => a.startMs - b.startMs || a.lineId - b.lineId)

  const audioSegments: EditAudioSegment[] = layout.clips.map((layoutClip) => {
    const clip = plan.clips.find((item) => item.id === layoutClip.clipId)!
    return {
      clipId: clip.id,
      sourceUrl: clip.source.url,
      sourceInMs: clip.sourceInMs,
      sourceOutMs: clip.sourceOutMs,
      speed: clip.speed,
      timelineStartMs: layoutClip.timelineStartMs,
      timelineEndMs: layoutClip.timelineEndMs,
      hasAudio: clip.source.hasAudio,
    }
  })

  return { durationMs: layout.durationMs, linePlacements: placements, audioSegments, unmappedLines }
}

export function suggestSubtitles(plan: EditPlanV1, placements: EditLinePlacement[]): EditSubtitleCue[] {
  const layout = computeLayout(plan)
  const layoutIndex = new Map(layout.clips.map((clip) => [clip.clipId, clip]))
  const cues: EditSubtitleCue[] = []
  for (const placement of placements) {
    const cueText = String(placement.subtitleText ?? placement.text ?? '').trim()
    if (!cueText) continue
    const clip = layoutIndex.get(placement.clipId)
    if (!clip) continue
    const startMs = Math.max(placement.startMs, clip.timelineStartMs)
    const endMs = Math.min(
      Math.max(placement.endMs + SUBTITLE_TAIL_GAP_MS, startMs + MIN_LINE_MS),
      clip.timelineEndMs,
    )
    if (endMs <= startMs) continue
    const warnings: string[] = []
    if (placement.overflowsClip) warnings.push('SUBTITLE_OVERFLOW')
    if (endMs - startMs < SUBTITLE_MIN_MS) warnings.push('SUBTITLE_SHORT')
    if (Array.from(cueText).length > SUBTITLE_MAX_CHARS) warnings.push('SUBTITLE_LONG')
    cues.push({
      id: `cue_line_${placement.lineId}`,
      text: cueText,
      startMs,
      endMs,
      style: plan.project.defaultSubtitleStyle,
      role: placement.speakerName,
      source: 'line',
      follow: true,
      anchor: { clipId: placement.clipId, offsetMs: startMs - clip.timelineStartMs },
      lineId: placement.lineId,
      warnings,
    })
  }
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id))
}

export function mergeSuggestedSubtitles(
  existing: EditSubtitleCue[],
  suggested: EditSubtitleCue[],
): { cues: EditSubtitleCue[]; added: number; updated: number } {
  let added = 0
  let updated = 0
  const next = existing.map((cue) => ({ ...cue }))
  const byLine = new Map<number, EditSubtitleCue>()
  for (const cue of next) {
    if (cue.lineId != null) byLine.set(cue.lineId, cue)
  }
  for (const cue of suggested) {
    const current = cue.lineId == null ? undefined : byLine.get(cue.lineId)
    if (!current) {
      next.push({ ...cue })
      if (cue.lineId != null) byLine.set(cue.lineId, cue)
      added += 1
      continue
    }
    if (current.source === 'line' && current.text === cue.text && current.follow) {
      current.startMs = cue.startMs
      current.endMs = cue.endMs
      current.anchor = cue.anchor
      current.style = cue.style
      current.warnings = cue.warnings
      updated += 1
    }
  }
  return {
    cues: next.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id)),
    added,
    updated,
  }
}

export function dialogPlacementsOf(placements: EditLinePlacement[]): DialoguePlacement[] {
  return placements.map((placement) => ({
    lineId: placement.lineId,
    voiceTakeId: placement.voiceTakeId,
    takeUrl: placement.audioUrl,
    takeFingerprint: placement.audioFingerprint,
    durationMs: placement.durationMs,
  }))
}
```

- [ ] **Step 4: 运行测试**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-timeline.test.ts
```
Expected: PASS。

- [ ] **Step 5: 类型检查（不提交）**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run typecheck
```
Expected: PASS。**不要提交。**

## Task 3: 后端分镜 bootstrap、初始版本与素材回退

**Files:**
- Create: `backend/src/services/edit-errors.ts`
- Create: `backend/src/services/edit-access.ts`
- Create: `backend/src/services/edit-response.ts`
- Create: `backend/src/services/edit-bootstrap.ts`
- Modify: `backend/src/services/edit-service.ts`（整体重写）
- Modify: `backend/src/routes/edit.ts`
- Test: `backend/tests/edit-bootstrap.test.ts`

**Interfaces:**
- Produces:
  - `EditWorkspaceError(status, code, message, data?)`
  - `getReadableEpisode(episodeId)`、`getWritableEpisode(episodeId)`
  - `parsePlanJson`、`layoutResponse`、`planHashes(plan, placements?)`、`revisionResponse(row)`、`planEnvelope(plan, issues, placements?)`
  - `assembleStoryboardClips(episodeId, project, options?)`
  - `hasStoryboardMedia(episodeId)`
  - `bootstrapEditPlan(input)`、`persistInitialEditPlan(input)`
- Consumes: Task 1 的 `normalizeEditPlan` 类型与既有 `edit-plan.ts`、`edit-media.ts`。
- 规则：分镜 bootstrap 只在 `mode === 'on'` 且至少产出一个可用片段时落库；只创建 `revision_no = 1`（note=`自动初始化`）与 `draft.version = 1`；`readonly/off` 绝不读取分镜/合并作为计划来源。

- [ ] **Step 1: 写失败测试**

Create `backend/tests/edit-bootstrap.test.ts`:

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-bootstrap-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')

const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '剪辑 bootstrap', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'shot.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  videoFile,
], { stdio: 'ignore' })
const videoUrl = `static/projects/${drama.id}/videos/shot.mp4`

const storyboardEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '分镜集', createdAt: ts, updatedAt: ts,
}).returning().get()
const sb1 = db.insert(schema.storyboards).values({
  episodeId: storyboardEpisode.id, storyboardNumber: 1, title: '镜一',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).returning().get()
const sb2 = db.insert(schema.storyboards).values({
  episodeId: storyboardEpisode.id, storyboardNumber: 2, title: '镜二',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).returning().get()

const readonlyEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '只读分镜集', createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.storyboards).values({
  episodeId: readonlyEpisode.id, storyboardNumber: 1, title: '只读镜',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).run()

const mergeEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 3, title: '合并集', createdAt: ts, updatedAt: ts,
}).returning().get()
const merge = db.insert(schema.videoMerges).values({
  episodeId: mergeEpisode.id, dramaId: drama.id, title: '合并', status: 'completed',
  mergedUrl: videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).returning().get()

const missingShotsEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 4, title: '分镜缺视频', videoUrl,
  createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.storyboards).values({
  episodeId: missingShotsEpisode.id, storyboardNumber: 1, title: '无视频',
  duration: 2, createdAt: ts, updatedAt: ts,
}).run()

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function json(response: Response): Promise<any> {
  return response.json()
}

test('on 模式下分镜多片段 bootstrap 并创建初始版本与草稿', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${storyboardEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data

  assert.equal(data.mode, 'on')
  assert.equal(data.capabilities.can_edit, true)
  assert.equal(data.plan.clips.length, 2)
  assert.equal(data.plan.clips[0].id, `clp_sb_${sb1.id}`)
  assert.equal(data.plan.clips[1].id, `clp_sb_${sb2.id}`)
  assert.equal(data.plan.clips[0].source.kind, 'storyboard')
  assert.equal(data.plan.clips[0].source.durationMs, 2000)
  assert.equal(data.plan.project.aspect, '16:9')
  assert.deepEqual(data.plan.transitions, [])
  assert.equal(data.current_revision.revision_no, 1)
  assert.equal(data.current_revision.note, '自动初始化')
  assert.equal(data.current_revision.is_current, true)
  assert.equal(data.current_revision_plan.clips.length, 2)
  assert.equal(data.draft.version, 1)
  assert.equal(data.draft.plan.clips.length, 2)
  assert.equal(data.draft_dirty, false)
  assert.equal(data.hashes.subtitle_hash.length, 32)
  assert.equal(data.rough_cut_available, true)

  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === storyboardEpisode.id)
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === storyboardEpisode.id)
  assert.equal(revisions.length, 1)
  assert.equal(drafts.length, 1)
  assert.equal(revisions[0].clipCount, 2)
  assert.equal(revisions[0].isCurrent, true)

  const episode = db.select().from(schema.episodes)
    .where(eq(schema.episodes.id, storyboardEpisode.id)).get()
  assert.equal(episode?.editRevisionId, revisions[0].id)
})

test('重复 GET 复用初始版本，不会新增版本或草稿版本', async () => {
  setEditWorkspaceMode('on')
  const before = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === storyboardEpisode.id)
  const response = await app.request(`/episodes/${storyboardEpisode.id}/edit`)
  assert.equal(response.status, 200)
  const data = (await json(response)).data
  const afterRows = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === storyboardEpisode.id)
  assert.equal(afterRows.length, before.length)
  assert.equal(data.draft.version, 1)
})

test('readonly 不读取分镜、不写任何版本或草稿', async () => {
  setEditWorkspaceMode('readonly')
  const response = await app.request(`/episodes/${readonlyEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.deepEqual(data.plan.clips, [])
  assert.equal(data.current_revision, null)
  assert.equal(data.draft, null)
  assert.equal(data.rough_cut_available, true)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)
  assert.equal(revisions.length, 0)
  assert.equal(drafts.length, 0)
})

test('on 模式在无分镜时回退到已完成合并，且不落库', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${mergeEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.plan.clips[0].source.kind, 'merge')
  assert.equal(data.plan.clips[0].source.id, merge.id)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === mergeEpisode.id)
  assert.equal(revisions.length, 0)
})

test('分镜全部缺少视频时继续回退到当前成片并保留提示', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${missingShotsEpisode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.plan.clips[0].source.kind, 'episode-video')
  assert.ok(data.media_warnings.some((item: any) => item.code === 'STORYBOARD_MISSING_VIDEO'))
})
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-bootstrap.test.ts
```
Expected: FAIL，`Cannot find module '../src/services/edit-bootstrap.ts'`。

- [ ] **Step 3: 实现 `edit-errors.ts`**

```ts
export class EditWorkspaceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data?: Record<string, unknown>,
  ) {
    super(message)
  }
}
```

- [ ] **Step 4: 实现 `edit-access.ts`**

```ts
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getEditWorkspaceMode, type EditWorkspaceMode } from './app-settings.js'
import { EditWorkspaceError } from './edit-errors.js'

export type ReadableEpisode = typeof schema.episodes.$inferSelect

export function loadEpisodeOrThrow(episodeId: number): ReadableEpisode {
  const episode = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .get()
  if (!episode) throw new EditWorkspaceError(404, 'EPISODE_NOT_FOUND', '分集不存在')
  return episode
}

export function getReadableEpisode(episodeId: number): {
  episode: ReadableEpisode
  mode: Exclude<EditWorkspaceMode, 'off'>
} {
  const episode = loadEpisodeOrThrow(episodeId)
  const mode = getEditWorkspaceMode()
  if (mode === 'off') throw new EditWorkspaceError(403, 'EDIT_WORKSPACE_OFF', '剪辑工作台已关闭')
  return { episode, mode }
}

export function getWritableEpisode(episodeId: number): ReadableEpisode {
  const { episode, mode } = getReadableEpisode(episodeId)
  if (mode !== 'on') throw new EditWorkspaceError(403, 'EDIT_READONLY', '剪辑工作台为只读模式')
  return episode
}

export function projectForEpisode(episode: ReadableEpisode) {
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).get()
  return { drama, aspectRatio: drama?.aspectRatio ?? null }
}
```

- [ ] **Step 5: 实现 `edit-response.ts`**

```ts
import { schema } from '../db/index.js'
import {
  computeLayout,
  dialogueSyncHashOf,
  editSyncHashOf,
  planHashOf,
  renderHashOf,
  subtitleHashOf,
  type DialoguePlacement,
  type EditIssue,
  type EditLayout,
  type EditPlanV1,
} from './edit-plan.js'

export type EditRevisionRow = typeof schema.editRevisions.$inferSelect

export function parsePlanJson(raw: string | null | undefined): EditPlanV1 | null {
  if (!raw) return null
  try {
    const plan = JSON.parse(raw) as EditPlanV1
    if (!plan || plan.version !== 1 || !plan.project || !Array.isArray(plan.clips)) return null
    return {
      ...plan,
      transitions: Array.isArray(plan.transitions) ? plan.transitions : [],
      subtitles: Array.isArray(plan.subtitles) ? plan.subtitles : [],
      overlays: Array.isArray(plan.overlays) ? plan.overlays : [],
      markers: Array.isArray(plan.markers) ? plan.markers : [],
    }
  } catch {
    return null
  }
}

export function layoutResponse(layout: EditLayout) {
  return {
    content_end_ms: layout.contentEndMs,
    duration_ms: layout.durationMs,
    clips: layout.clips.map((clip) => ({
      clip_id: clip.clipId,
      timeline_start_ms: clip.timelineStartMs,
      timeline_end_ms: clip.timelineEndMs,
      content_duration_ms: clip.contentDurationMs,
    })),
    transitions: layout.transitions.map((transition) => ({
      id: transition.id,
      from_clip_id: transition.fromClipId,
      to_clip_id: transition.toClipId,
      overlap_ms: transition.overlapMs,
    })),
  }
}

export function planHashes(plan: EditPlanV1, placements: DialoguePlacement[] = []) {
  return {
    plan_hash: planHashOf(plan),
    render_hash: renderHashOf(plan),
    edit_sync_hash: editSyncHashOf(plan),
    dialogue_sync_hash: dialogueSyncHashOf(placements),
    subtitle_hash: subtitleHashOf(plan),
  }
}

export function revisionResponse(row: EditRevisionRow) {
  return {
    id: row.id,
    revision_no: row.revisionNo,
    note: row.note,
    duration_ms: row.durationMs,
    clip_count: row.clipCount,
    plan_hash: row.planHash,
    edit_sync_hash: row.editSyncHash,
    created_at: row.createdAt,
    is_current: row.isCurrent,
  }
}

export function planEnvelope(
  plan: EditPlanV1,
  issues: EditIssue[],
  placements: DialoguePlacement[] = [],
) {
  return {
    plan,
    layout: layoutResponse(computeLayout(plan)),
    hashes: planHashes(plan, placements),
    issues,
  }
}
```

- [ ] **Step 6: 实现 `edit-bootstrap.ts`**

```ts
import { and, asc, desc, eq, isNull, max } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import type { EditWorkspaceMode } from './app-settings.js'
import { editSourceFromUrl } from './edit-media.js'
import {
  computeLayout,
  createEmptyEditPlan,
  createSingleClipPlan,
  editSyncHashOf,
  minimumClipMs,
  planHashOf,
  renderHashOf,
  type EditClip,
  type EditIssue,
  type EditPlanV1,
  type EditProjectSettings,
  type EditTransition,
} from './edit-plan.js'
import { parsePlanJson } from './edit-response.js'

export interface StoryboardAssembly {
  clips: EditClip[]
  transitions: EditTransition[]
  warnings: EditIssue[]
  materialCount: number
  skipped: number
}

function defaultTransform() {
  return { scale: 1, x: 0, y: 0, rotation: 0 as const, flipH: false, flipV: false }
}

function defaultFilter() {
  return { preset: 'none' as const, intensity: 100 }
}

export function hasStoryboardMedia(episodeId: number): boolean {
  const rows = db.select({
    videoUrl: schema.storyboards.videoUrl,
    composedVideoUrl: schema.storyboards.composedVideoUrl,
  }).from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .all()
  return rows.some((row) => Boolean(row.videoUrl || row.composedVideoUrl))
}

export async function assembleStoryboardClips(
  episodeId: number,
  project: EditProjectSettings,
  options: { transition?: 'cut' | 'dissolve' } = {},
): Promise<StoryboardAssembly> {
  const rows = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
  const clips: EditClip[] = []
  const warnings: EditIssue[] = []
  let skipped = 0

  for (const row of rows) {
    const url = row.videoUrl || row.composedVideoUrl || ''
    if (!url) {
      skipped += 1
      warnings.push({
        severity: 'warning',
        code: 'STORYBOARD_MISSING_VIDEO',
        path: `storyboards[${row.id}].video_url`,
        message: `分镜 ${row.storyboardNumber} 没有视频`,
      })
      continue
    }
    try {
      const source = await editSourceFromUrl({
        kind: 'storyboard',
        id: row.id,
        url,
        label: `分镜 ${row.storyboardNumber}`,
      })
      if (source.durationMs < minimumClipMs(project.fps)) {
        skipped += 1
        warnings.push({
          severity: 'warning',
          code: 'CLIP_TOO_SHORT',
          path: `storyboards[${row.id}]`,
          message: `分镜 ${row.storyboardNumber} 短于 3 帧`,
        })
        continue
      }
      clips.push({
        id: `clp_sb_${row.id}`,
        kind: 'video',
        source,
        sourceInMs: 0,
        sourceOutMs: source.durationMs,
        speed: 1,
        gapBeforeMs: 0,
        videoFadeInMs: 0,
        videoFadeOutMs: 0,
        transform: defaultTransform(),
        filter: defaultFilter(),
      })
    } catch (error) {
      skipped += 1
      warnings.push({
        severity: 'warning',
        code: 'MEDIA_MISSING',
        path: `storyboards[${row.id}].video_url`,
        message: error instanceof Error ? error.message : '分镜视频不可读',
      })
    }
  }

  const transitions: EditTransition[] = []
  if (options.transition === 'dissolve') {
    for (let index = 1; index < clips.length; index += 1) {
      transitions.push({
        id: `tr_${clips[index - 1].id}_${clips[index].id}`,
        fromClipId: clips[index - 1].id,
        toClipId: clips[index].id,
        type: 'dissolve',
        durationMs: 500,
      })
    }
  }

  return { clips, transitions, warnings, materialCount: clips.length, skipped }
}

export interface PersistBootstrapResult {
  revisionId: number | null
  draftVersion: number | null
  plan: EditPlanV1
  created: boolean
}

export function persistInitialEditPlan(input: {
  episodeId: number
  dramaId: number
  plan: EditPlanV1
  mode: EditWorkspaceMode
}): PersistBootstrapResult {
  if (input.mode !== 'on') {
    return { revisionId: null, draftVersion: null, plan: input.plan, created: false }
  }
  return db.transaction((tx) => {
    const existing = tx.select().from(schema.editRevisions)
      .where(and(
        eq(schema.editRevisions.episodeId, input.episodeId),
        eq(schema.editRevisions.isCurrent, true),
      ))
      .get()
    const existingPlan = parsePlanJson(existing?.planJson)
    if (existing && existingPlan) {
      const draft = tx.select().from(schema.episodeEditDrafts)
        .where(eq(schema.episodeEditDrafts.episodeId, input.episodeId))
        .get()
      return {
        revisionId: existing.id,
        draftVersion: draft?.version ?? null,
        plan: existingPlan,
        created: false,
      }
    }

    const ts = new Date().toISOString()
    const layout = computeLayout(input.plan)
    const planJson = JSON.stringify(input.plan)
    const planHash = planHashOf(input.plan)
    const syncHash = editSyncHashOf(input.plan)
    const maxRow = tx.select({ value: max(schema.editRevisions.revisionNo) })
      .from(schema.editRevisions)
      .where(eq(schema.editRevisions.episodeId, input.episodeId))
      .get()
    const revisionNo = Number(maxRow?.value ?? 0) + 1

    tx.update(schema.editRevisions)
      .set({ isCurrent: false })
      .where(and(
        eq(schema.editRevisions.episodeId, input.episodeId),
        eq(schema.editRevisions.isCurrent, true),
      ))
      .run()
    const revision = tx.insert(schema.editRevisions).values({
      episodeId: input.episodeId,
      revisionNo,
      planJson,
      planHash,
      editSyncHash: syncHash,
      renderHash: renderHashOf(input.plan),
      durationMs: layout.durationMs,
      clipCount: input.plan.clips.length,
      note: '自动初始化',
      isCurrent: true,
      createdAt: ts,
    }).returning().get()

    tx.insert(schema.episodeEditDrafts).values({
      episodeId: input.episodeId,
      dramaId: input.dramaId,
      planJson,
      planHash,
      editSyncHash: syncHash,
      version: 1,
      baseRevisionId: revision.id,
      createdAt: ts,
      updatedAt: ts,
    }).run()
    tx.update(schema.episodes).set({
      editRevisionId: revision.id,
      editPlanHash: planHash,
      editSyncHash: syncHash,
      editEnabled: true,
      updatedAt: ts,
    }).where(eq(schema.episodes.id, input.episodeId)).run()

    return {
      revisionId: revision.id,
      draftVersion: 1,
      plan: input.plan,
      created: true,
    }
  }, { behavior: 'immediate' })
}

export interface BootstrapInput {
  episodeId: number
  dramaId: number
  project: EditProjectSettings
  mode: EditWorkspaceMode
  episodeVideoUrl: string | null
  warnings: EditIssue[]
}

export interface BootstrapResult {
  plan: EditPlanV1
  source: 'storyboard' | 'merge' | 'episode-video' | 'empty'
  initializedRevisionId: number | null
  draftVersion: number | null
}

export async function bootstrapEditPlan(input: BootstrapInput): Promise<BootstrapResult> {
  if (input.mode === 'on') {
    const assembly = await assembleStoryboardClips(input.episodeId, input.project)
    input.warnings.push(...assembly.warnings)
    if (assembly.clips.length > 0) {
      const plan: EditPlanV1 = {
        ...createEmptyEditPlan(input.episodeId, input.project),
        clips: assembly.clips,
        transitions: assembly.transitions,
      }
      const persisted = persistInitialEditPlan({
        episodeId: input.episodeId,
        dramaId: input.dramaId,
        plan,
        mode: input.mode,
      })
      return {
        plan: persisted.plan,
        source: 'storyboard',
        initializedRevisionId: persisted.created ? persisted.revisionId : null,
        draftVersion: persisted.draftVersion,
      }
    }

    const merge = db.select().from(schema.videoMerges)
      .where(and(
        eq(schema.videoMerges.episodeId, input.episodeId),
        eq(schema.videoMerges.status, 'completed'),
        isNull(schema.videoMerges.deletedAt),
      ))
      .orderBy(desc(schema.videoMerges.createdAt), desc(schema.videoMerges.id))
      .get()
    if (merge?.mergedUrl) {
      try {
        const source = await editSourceFromUrl({
          kind: 'merge',
          id: merge.id,
          url: merge.mergedUrl,
          label: '既有合片',
        })
        return {
          plan: createSingleClipPlan(input.episodeId, source, input.project),
          source: 'merge',
          initializedRevisionId: null,
          draftVersion: null,
        }
      } catch (error) {
        input.warnings.push({
          severity: 'warning',
          code: 'MERGE_MEDIA_MISSING',
          path: 'video_merges.merged_url',
          message: error instanceof Error ? error.message : '合片不可读',
        })
      }
    }
  }

  if (input.episodeVideoUrl) {
    try {
      const source = await editSourceFromUrl({
        kind: 'episode-video',
        id: input.episodeId,
        url: input.episodeVideoUrl,
      })
      return {
        plan: createSingleClipPlan(input.episodeId, source, input.project),
        source: 'episode-video',
        initializedRevisionId: null,
        draftVersion: null,
      }
    } catch (error) {
      input.warnings.push({
        severity: 'warning',
        code: 'MEDIA_MISSING',
        path: 'episode.video_url',
        message: error instanceof Error ? error.message : '当前成片不可读',
      })
    }
  }

  return {
    plan: createEmptyEditPlan(input.episodeId, input.project),
    source: 'empty',
    initializedRevisionId: null,
    draftVersion: null,
  }
}
```

- [ ] **Step 7: 重写 `edit-service.ts`**

```ts
/**
 * 剪辑工作台聚合服务（S2）。
 * 只读优先级：草稿 → 当前版本 →（on）分镜多片段 bootstrap →（on）合片 → 成片 → 空计划。
 * readonly/off 只使用已有草稿/版本或成片，绝不写库。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getEditWorkspaceMode } from './app-settings.js'
import {
  aspectOf,
  computeLayout,
  dialogueSyncHashOf,
  projectSettingsForAspect,
  validateEditPlan,
  type EditIssue,
  type EditPlanV1,
} from './edit-plan.js'
import { bootstrapEditPlan, hasStoryboardMedia } from './edit-bootstrap.js'
import { EditWorkspaceError } from './edit-errors.js'
import { layoutResponse, parsePlanJson, planHashes, revisionResponse } from './edit-response.js'

export async function getEpisodeEditState(episodeId: number) {
  const episode = db.select().from(schema.episodes)
    .where(and(eq(schema.episodes.id, episodeId), isNull(schema.episodes.deletedAt)))
    .get()
  if (!episode) throw new EditWorkspaceError(404, 'EPISODE_NOT_FOUND', '分集不存在')

  const mode = getEditWorkspaceMode()
  if (mode === 'off') throw new EditWorkspaceError(403, 'EDIT_WORKSPACE_OFF', '剪辑工作台已关闭')

  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId))
    .get()

  let draft = db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
    .get()
  let revision = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.episodeId, episodeId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.editRevisions.createdAt))
    .get()

  const warnings: EditIssue[] = []
  let plan = parsePlanJson(draft?.planJson)
  if (draft && !plan) {
    warnings.push({
      severity: 'warning',
      code: 'DRAFT_INVALID',
      path: 'draft.plan_json',
      message: '草稿计划损坏，已忽略',
    })
  }
  let revisionPlan = parsePlanJson(revision?.planJson)
  if (revision && !revisionPlan) {
    warnings.push({
      severity: 'warning',
      code: 'REVISION_INVALID',
      path: 'revision.plan_json',
      message: '版本计划损坏，已忽略',
    })
  }
  if (!plan) plan = revisionPlan

  if (!plan) {
    const project = projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30)
    const bootstrap = await bootstrapEditPlan({
      episodeId: episode.id,
      dramaId: episode.dramaId,
      project,
      mode,
      episodeVideoUrl: episode.videoUrl,
      warnings,
    })
    plan = bootstrap.plan
    if (bootstrap.initializedRevisionId) {
      draft = db.select().from(schema.episodeEditDrafts)
        .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
        .get()
      revision = db.select().from(schema.editRevisions)
        .where(and(
          eq(schema.editRevisions.episodeId, episodeId),
          eq(schema.editRevisions.isCurrent, true),
        ))
        .get()
      revisionPlan = parsePlanJson(revision?.planJson)
    }
  } else {
    warnings.push(...validateEditPlan(plan))
  }

  const layout = computeLayout(plan)
  const hashes = planHashes(plan)
  const draftDirty = draft !== undefined && (
    !revision
    || !revision.planHash
    || draft.planHash !== revision.planHash
  )

  const mixRevision = db.select().from(schema.mixRevisions)
    .where(and(
      eq(schema.mixRevisions.episodeId, episodeId),
      eq(schema.mixRevisions.isCurrent, true),
    ))
    .orderBy(desc(schema.mixRevisions.createdAt))
    .get()

  const mixReasons: string[] = []
  if (mixRevision) {
    if (!mixRevision.editSyncHash) mixReasons.push('legacy_mix')
    else if (mixRevision.editSyncHash !== hashes.edit_sync_hash) mixReasons.push('timing_changed')
    const placementsHash = dialogueSyncHashOf([])
    if (mixRevision.dialogueSyncHash && mixRevision.dialogueSyncHash !== placementsHash) {
      mixReasons.push('dialogue_changed')
    }
  }

  const lockRow = db.select().from(schema.episodeLocks)
    .where(eq(schema.episodeLocks.episodeId, episodeId))
    .get()
  const lock = lockRow && Date.parse(lockRow.expiresAt) > Date.now()
    ? { kind: lockRow.kind, owner: lockRow.owner, expires_at: lockRow.expiresAt }
    : null

  const singleSource = plan.clips.length === 1 && plan.clips[0].source.kind === 'episode-video'
    ? plan.clips[0]
    : null
  const audio = singleSource
    ? { mode: 'video' as const, url: singleSource.source.url, duration_ms: layout.durationMs }
    : { mode: 'none' as const }

  return {
    episode_id: episode.id,
    episode_number: episode.episodeNumber,
    enabled: true,
    mode,
    draft: draft
      ? {
          plan: parsePlanJson(draft.planJson),
          version: draft.version,
          updated_at: draft.updatedAt,
        }
      : null,
    current_revision: revision ? revisionResponse(revision) : null,
    current_revision_plan: revisionPlan,
    plan,
    layout: layoutResponse(layout),
    hashes,
    draft_dirty: draftDirty,
    mix_status: {
      status: !mixRevision ? 'missing' : mixReasons.length ? 'stale' : 'aligned',
      reasons: mixReasons,
      edit_revision_id: revision?.id ?? null,
      mix_revision_id: mixRevision?.id ?? null,
      summary: null,
    },
    renders: { cut: null, audio_ref: null },
    audio,
    media_warnings: warnings.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path,
    })),
    line_placements: [],
    rough_cut_available: hasStoryboardMedia(episodeId),
    capabilities: {
      can_edit: mode === 'on',
      can_export: false,
      lock,
    },
  }
}
```

- [ ] **Step 8: 更新 `routes/edit.ts` 错误映射**

```ts
import { Hono } from 'hono'
import type { Context } from 'hono'
import { badRequest, notFound, serverError, success } from '../utils/response.js'
import { EditWorkspaceError } from '../services/edit-errors.js'
import { EditPlanRejectedError } from '../services/edit-normalize.js'
import { getEpisodeEditState } from '../services/edit-service.js'

const app = new Hono()

function parseId(raw: string | undefined): number | null {
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function handleEditError(c: Context, error: unknown) {
  if (error instanceof EditPlanRejectedError) {
    return c.json({
      code: 'EDIT_PLAN_INVALID',
      message: error.message,
      data: { code: error.code, path: error.path },
    }, 400)
  }
  if (error instanceof EditWorkspaceError) {
    const body = {
      code: error.code,
      message: error.message,
      ...(error.data ? { data: error.data } : {}),
    }
    if (error.status === 404) return c.json(body, 404)
    if (error.status === 400) return c.json(body, 400)
    return c.json(body, error.status as any)
  }
  return serverError(c, error instanceof Error ? error.message : '剪辑操作失败')
}

app.get('/episodes/:id/edit', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, await getEpisodeEditState(episodeId))
  } catch (error) {
    return handleEditError(c, error)
  }
})

export default app
```

- [ ] **Step 9: 运行测试**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-bootstrap.test.ts tests/edit-route.test.ts
```
Expected: PASS（含 M1 路由兼容：readonly 成片单片段、草稿优先、off 403）。

- [ ] **Step 10: 类型检查（不提交）**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run typecheck
```
Expected: PASS。**不要提交。**

---

## Task 4: 素材库、台词放置与 GET 增量

**Files:**
- Create: `backend/src/services/edit-timeline-data.ts`
- Create: `backend/src/services/edit-media-library.ts`
- Modify: `backend/src/services/edit-service.ts`
- Modify: `backend/src/routes/edit.ts`
- Test: `backend/tests/edit-media-library.test.ts`

**Interfaces:**
- Produces:
  - `loadEditTimelineData(episodeId): { lines: EditLineRow[]; takes: EditTakeRow[] }`
  - `buildTimelineForPlan(episodeId, plan): EditTimelineResult`
  - `placementsResponse(placements): EditLinePlacementResponse[]`
  - `getEditMediaLibrary(episodeId)`
- Consumes: Task 2 的 `buildEditTimeline` / `dialogPlacementsOf`；Task 3 的 `getReadableEpisode`、`layoutResponse`、`planHashes`。
- GET `/edit` 增量：`current_revision_plan`、`hashes.subtitle_hash`、真实 `dialogue_sync_hash`、`line_placements`、`rough_cut_available`；`media_warnings` 追加 `LINE_UNMAPPED`。

- [ ] **Step 1: 写失败测试**

Create `backend/tests/edit-media-library.test.ts`:

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-library-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '剪辑素材', aspectRatio: '9:16', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'shot.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=3',
  '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  videoFile,
], { stdio: 'ignore' })
const videoUrl = `static/projects/${drama.id}/videos/shot.mp4`

const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '素材集', createdAt: ts, updatedAt: ts,
}).returning().get()
const storyboard = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, title: '第一镜',
  videoUrl, duration: 3, createdAt: ts, updatedAt: ts,
}).returning().get()
const lineOne = db.insert(schema.storyboardLines).values({
  storyboardId: storyboard.id, episodeId: episode.id, dramaId: drama.id,
  lineNo: 1, speakerType: 'dialogue', speakerName: '林晚', text: '第一句',
  status: 'ready', audioUrl: 'static/audio/1.mp3', audioDurationMs: 1200,
  sortOrder: 0, createdAt: ts, updatedAt: ts,
}).returning().get()
const lineTwo = db.insert(schema.storyboardLines).values({
  storyboardId: storyboard.id, episodeId: episode.id, dramaId: drama.id,
  lineNo: 2, speakerType: 'narration', speakerName: '旁白', text: '第二句',
  status: 'pending', sortOrder: 1, createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.lineTakes).values({
  lineId: lineOne.id, episodeId: episode.id, dramaId: drama.id, takeNo: 1,
  text: '第一句', audioUrl: 'static/audio/take1.mp3', durationMs: 1200,
  hash: 'take-hash-1', status: 'ready', isActive: true, createdAt: ts,
}).run()

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function json(response: Response): Promise<any> {
  return response.json()
}

test('GET 返回台词放置、字幕哈希与初剪可用标记', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${episode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.line_placements.length, 2)
  const first = data.line_placements.find((item: any) => item.line_id === lineOne.id)
  const second = data.line_placements.find((item: any) => item.line_id === lineTwo.id)
  assert.ok(first)
  assert.ok(second)
  assert.equal(first.clip_id, `clp_sb_${storyboard.id}`)
  assert.equal(first.voice_take_id, null)
  assert.equal(first.duration_ms, 1200)
  assert.equal(second.duration_ms, 660)
  assert.equal(data.hashes.subtitle_hash.length, 32)
  assert.equal(data.hashes.dialogue_sync_hash.length, 32)
  assert.equal(data.rough_cut_available, true)
  assert.equal(data.current_revision_plan.clips.length, 1)
})

test('素材库返回可播放分镜、台词与可用 Take', async () => {
  setEditWorkspaceMode('readonly')
  const response = await app.request(`/episodes/${episode.id}/edit/media`)
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.import_enabled, false)
  assert.equal(data.audio.mix, null)
  assert.equal(data.storyboards.length, 1)
  assert.equal(data.storyboards[0].source.kind, 'storyboard')
  assert.equal(data.storyboards[0].playable, true)
  assert.equal(data.storyboards[0].source.durationMs, 3000)
  assert.equal(data.lines.length, 2)
  assert.equal(data.video_takes.length, 1)
  assert.equal(data.video_takes[0].line_id, lineOne.id)
  assert.equal(data.video_takes[0].audio_url, 'static/audio/take1.mp3')
})

test('off 模式素材库返回 403，缺失媒体标为不可播放', async () => {
  setEditWorkspaceMode('off')
  const off = await app.request(`/episodes/${episode.id}/edit/media`)
  assert.equal(off.status, 403)
  assert.equal((await json(off)).code, 'EDIT_WORKSPACE_OFF')

  setEditWorkspaceMode('readonly')
  const missingEpisode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 2, title: '缺失素材', createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.storyboards).values({
    episodeId: missingEpisode.id, storyboardNumber: 1, title: '缺视频',
    duration: 1, createdAt: ts, updatedAt: ts,
  }).run()
  const response = await app.request(`/episodes/${missingEpisode.id}/edit/media`)
  const data = (await json(response)).data
  assert.equal(data.storyboards.length, 1)
  assert.equal(data.storyboards[0].playable, false)
  assert.equal(data.storyboards[0].source, null)
})
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-media-library.test.ts
```
Expected: FAIL，`Cannot find module '../src/services/edit-timeline-data.ts'`。

- [ ] **Step 3: 实现 `edit-timeline-data.ts`**

```ts
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import {
  buildEditTimeline,
  type EditLinePlacement,
  type EditLineRow,
  type EditTakeRow,
  type EditTimelineResult,
} from './edit-timeline.js'
import type { EditPlanV1 } from './edit-plan.js'

export function loadEditTimelineData(episodeId: number): {
  lines: EditLineRow[]
  takes: EditTakeRow[]
} {
  const lines = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .all()
    .map((row): EditLineRow => ({
      id: row.id,
      storyboardId: row.storyboardId,
      lineNo: row.lineNo,
      sortOrder: row.sortOrder,
      text: row.text,
      subtitleText: row.subtitleText,
      speakerName: row.speakerName,
      speakerType: row.speakerType,
      voiceId: row.voiceId,
      voiceStartMs: row.voiceStartMs,
      voiceDurationMs: row.voiceDurationMs,
      audioUrl: row.audioUrl,
      audioDurationMs: row.audioDurationMs,
      activeTakeId: row.activeTakeId,
      anchorType: row.anchorType,
    }))

  const takes = db.select().from(schema.lineTakes)
    .where(and(
      eq(schema.lineTakes.episodeId, episodeId),
      isNull(schema.lineTakes.deletedAt),
    ))
    .all()
    .map((row): EditTakeRow => ({
      id: row.id,
      lineId: row.lineId,
      audioUrl: row.audioUrl,
      durationMs: row.durationMs,
      hash: row.hash,
      isActive: row.isActive,
    }))

  return { lines, takes }
}

export function buildTimelineForPlan(
  episodeId: number,
  plan: EditPlanV1,
): EditTimelineResult {
  const { lines, takes } = loadEditTimelineData(episodeId)
  return buildEditTimeline(plan, lines, takes)
}

export function placementsResponse(placements: EditLinePlacement[]) {
  return placements.map((item) => ({
    line_id: item.lineId,
    clip_id: item.clipId,
    storyboard_id: item.storyboardId,
    start_ms: item.startMs,
    end_ms: item.endMs,
    duration_ms: item.durationMs,
    text: item.text,
    subtitle_text: item.subtitleText,
    speaker_name: item.speakerName,
    voice_take_id: item.voiceTakeId,
    audio_url: item.audioUrl,
    audio_fingerprint: item.audioFingerprint,
    overflows_clip: item.overflowsClip,
    overflow_ms: item.overflowMs,
    anchor_type: item.anchorType,
    warnings: item.warnings,
  }))
}
```

- [ ] **Step 4: 实现 `edit-media-library.ts`**

```ts
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getReadableEpisode } from './edit-access.js'
import { editSourceFromUrl } from './edit-media.js'

export interface EditMediaStoryboardResponse {
  id: number
  number: number
  title: string | null
  thumbnail_url: string | null
  video_url: string | null
  source: Awaited<ReturnType<typeof editSourceFromUrl>> | null
  playable: boolean
  error: string | null
}

export async function getEditMediaLibrary(episodeId: number) {
  getReadableEpisode(episodeId)

  const storyboardRows = db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()

  const storyboards: EditMediaStoryboardResponse[] = []
  for (const row of storyboardRows) {
    const url = row.videoUrl || row.composedVideoUrl || ''
    let source: EditMediaStoryboardResponse['source'] = null
    let error: string | null = null
    if (url) {
      try {
        source = await editSourceFromUrl({
          kind: 'storyboard',
          id: row.id,
          url,
          label: `分镜 ${row.storyboardNumber}`,
        })
      } catch (cause) {
        error = cause instanceof Error ? cause.message : '素材不可读'
      }
    } else {
      error = '分镜没有视频'
    }
    storyboards.push({
      id: row.id,
      number: row.storyboardNumber,
      title: row.title,
      thumbnail_url: row.firstFrameImage || row.composedImage || null,
      video_url: url || null,
      source,
      playable: Boolean(source),
      error,
    })
  }

  const lineRows = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNull(schema.storyboardLines.deletedAt),
    ))
    .all()
  const lineMap = new Map(lineRows.map((row) => [row.id, row]))
  const lines = lineRows.map((row) => ({
    id: row.id,
    line_no: row.lineNo,
    storyboard_id: row.storyboardId,
    speaker_name: row.speakerName,
    speaker_type: row.speakerType,
    text: row.text,
    subtitle_text: row.subtitleText,
    status: row.status,
    audio_url: row.audioUrl,
    duration_ms: row.voiceDurationMs ?? row.audioDurationMs,
    voice_start_ms: row.voiceStartMs,
    anchor_type: row.anchorType,
  }))

  const takeRows = db.select().from(schema.lineTakes)
    .where(and(
      eq(schema.lineTakes.episodeId, episodeId),
      isNull(schema.lineTakes.deletedAt),
    ))
    .all()
  const videoTakes = takeRows
    .filter((row) => row.status === 'ready' && Boolean(row.audioUrl))
    .map((row) => ({
      id: row.id,
      line_id: row.lineId,
      take_no: row.takeNo,
      audio_url: row.audioUrl,
      duration_ms: row.durationMs,
      hash: row.hash,
      is_active: row.isActive,
      status: row.status,
      text: lineMap.get(row.lineId)?.text ?? '',
      speaker_name: lineMap.get(row.lineId)?.speakerName ?? null,
    }))

  return {
    storyboards,
    video_takes: videoTakes,
    lines,
    audio: { mix: null, audio_ref: null },
    import_enabled: false,
  }
}
```

- [ ] **Step 5: 接入 GET 放置与哈希**

在 `edit-service.ts` 中：

```ts
import { computeLayout, dialogueSyncHashOf } from './edit-plan.js'
import { layoutResponse } from './edit-response.js'
import { buildTimelineForPlan, placementsResponse } from './edit-timeline-data.js'
import { dialogPlacementsOf } from './edit-timeline.js'
```

在计划确定之后、`hashes` 之前插入：

```ts
const timeline = buildTimelineForPlan(episodeId, plan)
const placements = timeline.linePlacements
const dialogueHash = dialogueSyncHashOf(dialogPlacementsOf(placements))
for (const item of timeline.unmappedLines) {
  warnings.push({
    severity: 'warning',
    code: 'LINE_UNMAPPED',
    path: `line:${item.lineId}`,
    message: `台词未映射到片段（${item.reason}）`,
  })
}
```

把 `hashes` 改为：

```ts
const hashes = {
  ...planHashes(plan, dialogPlacementsOf(placements)),
  dialogue_sync_hash: dialogueHash,
}
```

把 mix 的 `dialogue_changed` 判断改为 `mixRevision.dialogueSyncHash !== dialogueHash`，返回体改为：

```ts
layout: layoutResponse(computeLayout(plan)),
line_placements: placementsResponse(placements),
rough_cut_available: hasStoryboardMedia(episodeId),
```

- [ ] **Step 6: 新增素材库路由**

在 `routes/edit.ts` 中：

```ts
import { getEditMediaLibrary } from '../services/edit-media-library.js'

app.get('/episodes/:id/edit/media', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, await getEditMediaLibrary(episodeId))
  } catch (error) {
    return handleEditError(c, error)
  }
})
```

- [ ] **Step 7: 运行测试**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-media-library.test.ts tests/edit-bootstrap.test.ts tests/edit-timeline.test.ts tests/edit-route.test.ts
```
Expected: PASS。

- [ ] **Step 8: 类型检查（不提交）**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run typecheck
```
Expected: PASS。**不要提交。**

## Task 5: 草稿保存、乐观并发与丢弃

**Files:**
- Create: `backend/src/services/edit-conflict.ts`
- Create: `backend/src/services/edit-draft-service.ts`
- Modify: `backend/src/routes/edit.ts`
- Test: `backend/tests/edit-draft-route.test.ts`

**Interfaces:**
- Produces:
  - `conflictDataFor(episodeId, draftRow)`、`throwVersionConflict(episodeId, draftRow)`
  - `saveEditDraft(episodeId, input)`、`discardEditDraft(episodeId)`
- 规则：`PUT` 必须携带非负整数 `base_version`；版本不匹配且无 `force` 时 409，`data` 包含当前版本/当前计划/更新时间；事务使用 `BEGIN IMMEDIATE`；`readonly/off` 403 且不写行。

- [ ] **Step 1: 写失败测试**

Create `backend/tests/edit-draft-route.test.ts`:

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-draft-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '剪辑草稿', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'film.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
  videoFile,
], { stdio: 'ignore' })
const videoUrl = `static/projects/${drama.id}/videos/film.mp4`

const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '草稿集', videoUrl,
  createdAt: ts, updatedAt: ts,
}).returning().get()
const readonlyEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '只读集', videoUrl,
  createdAt: ts, updatedAt: ts,
}).returning().get()

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function json(response: Response): Promise<any> {
  return response.json()
}

async function loadPlan(episodeId: number) {
  const response = await app.request(`/episodes/${episodeId}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  return (await json(response)).data.plan
}

function putDraft(episodeId: number, body: unknown) {
  return app.request(`/episodes/${episodeId}/edit/draft`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('保存草稿版本递增，过期 base_version 返回 409 与当前计划', async () => {
  setEditWorkspaceMode('on')
  const plan = await loadPlan(episode.id)
  plan.project.tailGapMs = 500

  const first = await putDraft(episode.id, { base_version: 0, plan })
  assert.equal(first.status, 200, await first.clone().text())
  const firstData = (await json(first)).data
  assert.equal(firstData.version, 1)
  assert.match(firstData.updated_at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(firstData.draft_dirty, true)
  assert.equal(firstData.hashes.plan_hash.length, 32)
  assert.equal(firstData.hashes.subtitle_hash.length, 32)

  const stale = await putDraft(episode.id, { base_version: 0, plan })
  assert.equal(stale.status, 409)
  const staleData = await json(stale)
  assert.equal(staleData.code, 'EDIT_VERSION_CONFLICT')
  assert.equal(staleData.data.current_version, 1)
  assert.equal(staleData.data.current_plan.project.tailGapMs, 500)
  assert.ok(staleData.data.updated_at)

  plan.project.tailGapMs = 700
  const forced = await putDraft(episode.id, { base_version: 0, plan, force: true })
  assert.equal(forced.status, 200, await forced.clone().text())
  const forcedData = (await json(forced)).data
  assert.equal(forcedData.version, 2)
  assert.equal(forcedData.plan.project.tailGapMs, 700)

  const state = await app.request(`/episodes/${episode.id}/edit`)
  const stateData = (await json(state)).data
  assert.equal(stateData.draft.version, 2)
  assert.equal(stateData.plan.project.tailGapMs, 700)
})

test('非法计划返回 400 EDIT_PLAN_INVALID 且不覆盖草稿', async () => {
  setEditWorkspaceMode('on')
  const plan = await loadPlan(episode.id)
  plan.clips.push({ ...plan.clips[0] })
  const response = await putDraft(episode.id, { base_version: 2, plan })
  assert.equal(response.status, 400)
  const data = await json(response)
  assert.equal(data.code, 'EDIT_PLAN_INVALID')
  assert.equal(data.data.code, 'CLIP_ID_DUPLICATE')

  const state = await app.request(`/episodes/${episode.id}/edit`)
  const stateData = (await json(state)).data
  assert.equal(stateData.draft.version, 2)
})

test('readonly 保存草稿返回 403 且不创建草稿', async () => {
  setEditWorkspaceMode('readonly')
  const plan = await loadPlan(readonlyEpisode.id)
  const response = await putDraft(readonlyEpisode.id, { base_version: 0, plan })
  assert.equal(response.status, 403)
  assert.equal((await json(response)).code, 'EDIT_READONLY')
  const drafts = db.select().from(schema.episodeEditDrafts).all()
    .filter((row) => row.episodeId === readonlyEpisode.id)
  assert.equal(drafts.length, 0)
})

test('DELETE 丢弃草稿后回退到成片计划', async () => {
  setEditWorkspaceMode('on')
  const response = await app.request(`/episodes/${episode.id}/edit/draft`, { method: 'DELETE' })
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal((await json(response)).data.discarded, true)

  const second = await app.request(`/episodes/${episode.id}/edit/draft`, { method: 'DELETE' })
  assert.equal((await json(second)).data.discarded, false)

  const state = await app.request(`/episodes/${episode.id}/edit`)
  const data = (await json(state)).data
  assert.equal(data.draft, null)
  assert.equal(data.plan.clips.length, 1)
  assert.equal(data.plan.clips[0].source.kind, 'episode-video')
})
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-draft-route.test.ts
```
Expected: FAIL，草稿路由 404。

- [ ] **Step 3: 实现 `edit-conflict.ts`**

```ts
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { EditWorkspaceError } from './edit-errors.js'
import { parsePlanJson } from './edit-response.js'

type DraftRow = typeof schema.episodeEditDrafts.$inferSelect

export function conflictDataFor(episodeId: number, draft: DraftRow | undefined) {
  const revision = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.episodeId, episodeId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .get()
  return {
    current_version: draft?.version ?? 0,
    current_plan: parsePlanJson(draft?.planJson) ?? parsePlanJson(revision?.planJson),
    updated_at: draft?.updatedAt ?? null,
  }
}

export function throwVersionConflict(episodeId: number, draft: DraftRow | undefined): never {
  throw new EditWorkspaceError(
    409,
    'EDIT_VERSION_CONFLICT',
    '此集已在另一个窗口修改',
    conflictDataFor(episodeId, draft),
  )
}
```

- [ ] **Step 4: 实现 `edit-draft-service.ts`**

```ts
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWritableEpisode } from './edit-access.js'
import { throwVersionConflict } from './edit-conflict.js'
import { EditWorkspaceError } from './edit-errors.js'
import {
  aspectOf,
  computeLayout,
  editSyncHashOf,
  planHashOf,
  projectSettingsForAspect,
  type EditPlanV1,
  type EditProjectSettings,
} from './edit-plan.js'
import { normalizeEditPlan } from './edit-normalize.js'
import { layoutResponse, parsePlanJson, planHashes } from './edit-response.js'
import { loadEditTimelineData } from './edit-timeline-data.js'
import { buildEditTimeline, dialogPlacementsOf } from './edit-timeline.js'

function projectFor(episode: typeof schema.episodes.$inferSelect): EditProjectSettings {
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId))
    .get()
  return projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30)
}

function currentDraft(episodeId: number) {
  return db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
    .get()
}

function currentRevision(episodeId: number) {
  return db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.episodeId, episodeId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .get()
}

function draftDirtyOf(episodeId: number): boolean {
  const draft = currentDraft(episodeId)
  const revision = currentRevision(episodeId)
  return Boolean(draft) && (
    !revision
    || !revision.planHash
    || draft!.planHash !== revision.planHash
  )
}

export async function saveEditDraft(
  episodeId: number,
  input: Record<string, unknown>,
) {
  const episode = getWritableEpisode(episodeId)
  const project = projectFor(episode)
  const { plan, issues } = normalizeEditPlan(input.plan, { episodeId, project })
  const baseVersion = Number(input.base_version)
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new EditWorkspaceError(400, 'EDIT_BASE_VERSION', '缺少有效的 base_version')
  }
  const force = input.force === true
  const before = currentDraft(episodeId)
  if (!force && (before?.version ?? 0) !== baseVersion) {
    throwVersionConflict(episodeId, before)
  }

  const ts = new Date().toISOString()
  const planJson = JSON.stringify(plan)
  const planHash = planHashOf(plan)
  const syncHash = editSyncHashOf(plan)
  const revision = currentRevision(episodeId)
  const result = db.transaction((tx) => {
    const live = tx.select().from(schema.episodeEditDrafts)
      .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
      .get()
    if (!force && (live?.version ?? 0) !== baseVersion) {
      return { conflict: live, version: 0 }
    }
    const version = (live?.version ?? 0) + 1
    if (live) {
      tx.update(schema.episodeEditDrafts).set({
        planJson,
        planHash,
        editSyncHash: syncHash,
        version,
        baseRevisionId: revision?.id ?? null,
        updatedAt: ts,
      }).where(eq(schema.episodeEditDrafts.episodeId, episodeId)).run()
    } else {
      tx.insert(schema.episodeEditDrafts).values({
        episodeId,
        dramaId: episode.dramaId,
        planJson,
        planHash,
        editSyncHash: syncHash,
        version,
        baseRevisionId: revision?.id ?? null,
        createdAt: ts,
        updatedAt: ts,
      }).run()
    }
    return { conflict: null, version }
  }, { behavior: 'immediate' })

  if (result.conflict !== null || result.version === 0) {
    throwVersionConflict(episodeId, result.conflict)
  }

  const { lines, takes } = loadEditTimelineData(episodeId)
  const timeline = buildEditTimeline(plan, lines, takes)
  return {
    version: result.version,
    updated_at: ts,
    plan,
    layout: layoutResponse(computeLayout(plan)),
    hashes: planHashes(plan, dialogPlacementsOf(timeline.linePlacements)),
    issues,
    draft_dirty: draftDirtyOf(episodeId),
  }
}

export function discardEditDraft(episodeId: number) {
  getWritableEpisode(episodeId)
  const result = db.delete(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
    .run()
  return { discarded: result.changes > 0 }
}
```

- [ ] **Step 5: 新增草稿路由**

在 `routes/edit.ts` 中：

```ts
import { discardEditDraft, saveEditDraft } from '../services/edit-draft-service.js'

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => null)
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

app.put('/episodes/:id/edit/draft', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, await saveEditDraft(episodeId, await readBody(c)))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.delete('/episodes/:id/edit/draft', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, discardEditDraft(episodeId))
  } catch (error) {
    return handleEditError(c, error)
  }
})
```

- [ ] **Step 6: 运行测试**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-draft-route.test.ts tests/edit-route.test.ts
```
Expected: PASS。

- [ ] **Step 7: 类型检查（不提交）**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run typecheck
```
Expected: PASS。**不要提交。**

---

## Task 6: 不可变版本列表、创建、详情与恢复

**Files:**
- Create: `backend/src/services/edit-revision-service.ts`
- Modify: `backend/src/routes/edit.ts`
- Test: `backend/tests/edit-revision-route.test.ts`

**Interfaces:**
- Produces:
  - `revisionResponse(row)`（Task 3 已提供）
  - `listEditRevisions(episodeId)`
  - `getEditRevision(episodeId, revisionId)`
  - `createEditRevision(episodeId, input)`
  - `restoreEditRevision(episodeId, revisionId, input)`
- 规则：新版本号 = 该集最大 `revision_no + 1`；创建前清除其他 `is_current`；版本与草稿在同一 `BEGIN IMMEDIATE` 事务；恢复=以旧版本计划创建新版本，不修改旧行。

- [ ] **Step 1: 写失败测试**

Create `backend/tests/edit-revision-route.test.ts`:

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { Hono } from 'hono'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-revision-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const app = new Hono()
app.route('/', (await import('../src/routes/edit.ts')).default)

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '剪辑版本', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()
const videoDir = path.join(root, 'static', 'projects', String(drama.id), 'videos')
fs.mkdirSync(videoDir, { recursive: true })
const videoFile = path.join(videoDir, 'shot.mp4')
execFileSync(ffmpegBin, [
  '-y',
  '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=25:d=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  videoFile,
], { stdio: 'ignore' })
const videoUrl = `static/projects/${drama.id}/videos/shot.mp4`

const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '版本集', createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, title: '镜一',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).run()

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function json(response: Response): Promise<any> {
  return response.json()
}

async function loadState() {
  const response = await app.request(`/episodes/${episode.id}/edit`)
  assert.equal(response.status, 200, await response.clone().text())
  return (await json(response)).data
}

function postRevision(body: unknown) {
  return app.request(`/episodes/${episode.id}/edit/revisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('创建版本递增 revision_no 并同步草稿', async () => {
  setEditWorkspaceMode('on')
  const state = await loadState()
  assert.equal(state.current_revision.revision_no, 1)
  assert.equal(state.draft.version, 1)

  const plan = state.plan
  plan.project.tailGapMs = 500
  const response = await postRevision({
    base_version: 1,
    note: '手动版本',
    plan,
    update_draft: true,
  })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.revision.revision_no, 2)
  assert.equal(data.revision.note, '手动版本')
  assert.equal(data.revision.is_current, true)
  assert.equal(data.revision.plan_hash.length, 32)
  assert.equal(data.draft_version, 2)
  assert.equal(data.draft_dirty, false)

  const list = await app.request(`/episodes/${episode.id}/edit/revisions`)
  assert.equal(list.status, 200)
  const items = (await json(list)).data.items
  assert.equal(items.length, 2)
  assert.equal(items[0].revision_no, 2)
  assert.equal(items[0].is_current, true)
  assert.equal(items[1].revision_no, 1)
  assert.equal(items[1].is_current, false)
})

test('过期 base_version 返回 409，详情返回不可变计划', async () => {
  setEditWorkspaceMode('on')
  const stale = await postRevision({ base_version: 1, note: '过期' })
  assert.equal(stale.status, 409)
  const staleData = await json(stale)
  assert.equal(staleData.code, 'EDIT_VERSION_CONFLICT')
  assert.equal(staleData.data.current_version, 2)

  const list = await app.request(`/episodes/${episode.id}/edit/revisions`)
  const items = (await json(list)).data.items
  const first = items.find((item: any) => item.revision_no === 1)
  const detail = await app.request(`/episodes/${episode.id}/edit/revisions/${first.id}`)
  assert.equal(detail.status, 200)
  const detailData = (await json(detail)).data
  assert.equal(detailData.revision.revision_no, 1)
  assert.equal(detailData.plan.project.tailGapMs, 0)

  const missing = await app.request(`/episodes/${episode.id}/edit/revisions/99999`)
  assert.equal(missing.status, 404)
  assert.equal((await json(missing)).code, 'EDIT_REVISION_NOT_FOUND')
})

test('update_draft=false 保留草稿并返回真实 dirty', async () => {
  setEditWorkspaceMode('on')
  const state = await loadState()
  const plan = state.plan
  plan.project.tailGapMs = 900
  const response = await postRevision({
    base_version: state.draft.version,
    note: '仅版本',
    plan,
    update_draft: false,
  })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.revision.revision_no, 3)
  assert.equal(data.draft_version, state.draft.version)
  assert.equal(data.draft_dirty, true)
})

test('恢复旧版本会创建新版本并同步草稿', async () => {
  setEditWorkspaceMode('on')
  const before = await loadState()
  const list = await app.request(`/episodes/${episode.id}/edit/revisions`)
  const items = (await json(list)).data.items
  const first = items.find((item: any) => item.revision_no === 1)

  const response = await app.request(
    `/episodes/${episode.id}/edit/revisions/${first.id}/restore`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_version: before.draft.version }),
    },
  )
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await json(response)).data
  assert.equal(data.revision.revision_no, 4)
  assert.equal(data.revision.note, '恢复自版本 v1')
  assert.equal(data.revision.is_current, true)
  assert.equal(data.draft_dirty, false)

  const afterState = await loadState()
  assert.equal(afterState.plan.project.tailGapMs, 0)
  assert.equal(afterState.current_revision.revision_no, 4)
})

test('readonly 可读版本列表但禁止创建与恢复', async () => {
  setEditWorkspaceMode('readonly')
  const list = await app.request(`/episodes/${episode.id}/edit/revisions`)
  assert.equal(list.status, 200)
  const create = await postRevision({ base_version: 1 })
  assert.equal(create.status, 403)
  assert.equal((await json(create)).code, 'EDIT_READONLY')
  const restore = await app.request(
    `/episodes/${episode.id}/edit/revisions/1/restore`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_version: 1 }),
    },
  )
  assert.equal(restore.status, 403)
})
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-revision-route.test.ts
```
Expected: FAIL，版本路由 404。

- [ ] **Step 3: 实现 `edit-revision-service.ts`**

```ts
import { and, desc, eq, max } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getReadableEpisode, getWritableEpisode } from './edit-access.js'
import { throwVersionConflict } from './edit-conflict.js'
import { EditWorkspaceError } from './edit-errors.js'
import {
  aspectOf,
  computeLayout,
  editSyncHashOf,
  planHashOf,
  projectSettingsForAspect,
  renderHashOf,
  type EditPlanV1,
  type EditProjectSettings,
} from './edit-plan.js'
import { normalizeEditPlan } from './edit-normalize.js'
import { parsePlanJson, revisionResponse } from './edit-response.js'

function projectFor(episode: typeof schema.episodes.$inferSelect): EditProjectSettings {
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId))
    .get()
  return projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30)
}

function draftOf(episodeId: number) {
  return db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
    .get()
}

function dirtyOf(episodeId: number): boolean {
  const draft = draftOf(episodeId)
  const revision = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.episodeId, episodeId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .get()
  return Boolean(draft) && (
    !revision
    || !revision.planHash
    || draft!.planHash !== revision.planHash
  )
}

function planOrThrow(raw: unknown, episodeId: number, project: EditProjectSettings) {
  if (raw == null) {
    throw new EditWorkspaceError(400, 'EDIT_PLAN_INVALID', '没有可保存的计划')
  }
  return normalizeEditPlan(raw, { episodeId, project })
}

export function listEditRevisions(episodeId: number) {
  getReadableEpisode(episodeId)
  const items = db.select().from(schema.editRevisions)
    .where(eq(schema.editRevisions.episodeId, episodeId))
    .orderBy(desc(schema.editRevisions.revisionNo))
    .all()
    .map(revisionResponse)
  return { items }
}

export function getEditRevision(episodeId: number, revisionId: number) {
  getReadableEpisode(episodeId)
  const row = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.id, revisionId),
      eq(schema.editRevisions.episodeId, episodeId),
    ))
    .get()
  if (!row) throw new EditWorkspaceError(404, 'EDIT_REVISION_NOT_FOUND', '剪辑版本不存在')
  const plan = parsePlanJson(row.planJson)
  if (!plan) throw new EditWorkspaceError(500, 'EDIT_REVISION_CORRUPT', '版本计划损坏')
  return { revision: revisionResponse(row), plan }
}

export function createEditRevision(
  episodeId: number,
  input: Record<string, unknown>,
) {
  const episode = getWritableEpisode(episodeId)
  const project = projectFor(episode)
  const draft = draftOf(episodeId)
  const current = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.episodeId, episodeId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .get()

  const source = input.plan
    ?? parsePlanJson(draft?.planJson)
    ?? parsePlanJson(current?.planJson)
  const { plan } = planOrThrow(source, episodeId, project)
  const force = input.force === true
  const baseVersion = input.base_version === undefined || input.base_version === null
    ? null
    : Number(input.base_version)
  if (baseVersion !== null && (!Number.isSafeInteger(baseVersion) || baseVersion < 0)) {
    throw new EditWorkspaceError(400, 'EDIT_BASE_VERSION', '缺少有效的 base_version')
  }
  if (!force && baseVersion !== null && (draft?.version ?? 0) !== baseVersion) {
    throwVersionConflict(episodeId, draft)
  }

  const updateDraft = input.update_draft !== false
  const note = typeof input.note === 'string' && input.note.trim()
    ? input.note.trim().slice(0, 200)
    : null
  const ts = new Date().toISOString()
  const planJson = JSON.stringify(plan)
  const planHash = planHashOf(plan)
  const syncHash = editSyncHashOf(plan)
  const layout = computeLayout(plan)

  const result = db.transaction((tx) => {
    const liveDraft = tx.select().from(schema.episodeEditDrafts)
      .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
      .get()
    if (!force && baseVersion !== null && (liveDraft?.version ?? 0) !== baseVersion) {
      return { conflict: liveDraft, revision: null, draftVersion: null }
    }
    const maxRow = tx.select({ value: max(schema.editRevisions.revisionNo) })
      .from(schema.editRevisions)
      .where(eq(schema.editRevisions.episodeId, episodeId))
      .get()
    const revisionNo = Number(maxRow?.value ?? 0) + 1

    tx.update(schema.editRevisions)
      .set({ isCurrent: false })
      .where(and(
        eq(schema.editRevisions.episodeId, episodeId),
        eq(schema.editRevisions.isCurrent, true),
      ))
      .run()
    const inserted = tx.insert(schema.editRevisions).values({
      episodeId,
      revisionNo,
      planJson,
      planHash,
      editSyncHash: syncHash,
      renderHash: renderHashOf(plan),
      durationMs: layout.durationMs,
      clipCount: plan.clips.length,
      note,
      isCurrent: true,
      createdAt: ts,
    }).returning().get()

    tx.update(schema.episodes).set({
      editRevisionId: inserted.id,
      editPlanHash: planHash,
      editSyncHash: syncHash,
      editEnabled: true,
      updatedAt: ts,
    }).where(eq(schema.episodes.id, episodeId)).run()

    let draftVersion = liveDraft?.version ?? null
    if (updateDraft) {
      draftVersion = (liveDraft?.version ?? 0) + 1
      if (liveDraft) {
        tx.update(schema.episodeEditDrafts).set({
          planJson,
          planHash,
          editSyncHash: syncHash,
          version: draftVersion,
          baseRevisionId: inserted.id,
          updatedAt: ts,
        }).where(eq(schema.episodeEditDrafts.episodeId, episodeId)).run()
      } else {
        tx.insert(schema.episodeEditDrafts).values({
          episodeId,
          dramaId: episode.dramaId,
          planJson,
          planHash,
          editSyncHash: syncHash,
          version: draftVersion,
          baseRevisionId: inserted.id,
          createdAt: ts,
          updatedAt: ts,
        }).run()
      }
    }
    return { conflict: null, revision: inserted, draftVersion }
  }, { behavior: 'immediate' })

  if (result.conflict !== null || !result.revision) {
    throwVersionConflict(episodeId, result.conflict)
  }

  return {
    revision: revisionResponse(result.revision),
    draft_version: result.draftVersion,
    draft_dirty: dirtyOf(episodeId),
  }
}

export function restoreEditRevision(
  episodeId: number,
  revisionId: number,
  input: Record<string, unknown>,
) {
  getWritableEpisode(episodeId)
  const row = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.id, revisionId),
      eq(schema.editRevisions.episodeId, episodeId),
    ))
    .get()
  if (!row) throw new EditWorkspaceError(404, 'EDIT_REVISION_NOT_FOUND', '剪辑版本不存在')
  const plan = parsePlanJson(row.planJson) as EditPlanV1 | null
  if (!plan) throw new EditWorkspaceError(500, 'EDIT_REVISION_CORRUPT', '版本计划损坏')
  return createEditRevision(episodeId, {
    plan,
    base_version: input.base_version,
    note: `恢复自版本 v${row.revisionNo}`,
    update_draft: true,
  })
}
```

- [ ] **Step 4: 新增版本路由**

在 `routes/edit.ts` 中：

```ts
import {
  createEditRevision,
  getEditRevision,
  listEditRevisions,
  restoreEditRevision,
} from '../services/edit-revision-service.js'

app.get('/episodes/:id/edit/revisions', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, listEditRevisions(episodeId))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.get('/episodes/:id/edit/revisions/:revisionId', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  const revisionId = parseId(c.req.param('revisionId'))
  if (!episodeId || !revisionId) return badRequest(c, '版本编号无效')
  try {
    return success(c, getEditRevision(episodeId, revisionId))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/revisions', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, createEditRevision(episodeId, await readBody(c)))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/revisions/:revisionId/restore', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  const revisionId = parseId(c.req.param('revisionId'))
  if (!episodeId || !revisionId) return badRequest(c, '版本编号无效')
  try {
    return success(c, restoreEditRevision(episodeId, revisionId, await readBody(c)))
  } catch (error) {
    return handleEditError(c, error)
  }
})
```

- [ ] **Step 5: 运行测试**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-revision-route.test.ts tests/edit-draft-route.test.ts tests/edit-bootstrap.test.ts
```
Expected: PASS。

- [ ] **Step 6: 类型检查（不提交）**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run typecheck
```
Expected: PASS。**不要提交。**

---

## Task 7: 一键初剪与字幕建议动作

**Files:**
- Create: `backend/src/services/edit-actions-service.ts`
- Modify: `backend/src/routes/edit.ts`
- Test: `backend/tests/edit-actions.test.ts`

**Interfaces:**
- Produces:
  - `roughCutEditPlan(episodeId, input)`
  - `suggestEditSubtitles(episodeId, input)`
- 规则：
  - `replace` 用全部分镜重建主轨并清空字幕（返回 `SUBTITLES_CLEARED` 警告）；`append` 只追加未出现过的分镜，重复分镜计入 `skipped`。
  - `create_revision=true` 时先用客户端当前计划创建“初剪前快照”版本；不写草稿，返回计划由前端作为可撤销命令应用。
  - 字幕建议 `fill` 只补缺失台词，`replace` 只重建 `source='line'` 字幕，手动字幕始终保留；不写数据库。

- [ ] **Step 1: 写失败测试**

Create `backend/tests/edit-actions.test.ts`:

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-edit-actions-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
delete process.env.EDIT_WORKSPACE

const { db, schema } = await import('../src/db/index.ts')
const { setEditWorkspaceMode } = await import('../src/services/app-settings.ts')
const { roughCutEditPlan, suggestEditSubtitles } = await import('../src/services/edit-actions-service.ts')
const { getEpisodeEditState } = await import('../src/services/edit-service.ts')

const ts = '2026-11-06T00:00:00.000Z'
const drama = db.insert(schema.dramas).values({
  title: '剪辑动作', aspectRatio: '16:9', createdAt: ts, updatedAt: ts,
}).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '动作集', createdAt: ts, updatedAt: ts,
}).returning().get()
const emptyEpisode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 2, title: '无分镜集', createdAt: ts, updatedAt: ts,
}).returning().get()

const videoFile = path.join(root, 'static', 'assets', 'shot.mp4')
fs.mkdirSync(path.dirname(videoFile), { recursive: true })
execFileSync(ffmpegBin, [
  '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x240:r=25:d=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoFile,
], { stdio: 'ignore' })
const videoUrl = 'static/assets/shot.mp4'

const sb1 = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 1, title: '镜一',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).returning().get()
const sb2 = db.insert(schema.storyboards).values({
  episodeId: episode.id, storyboardNumber: 2, title: '镜二',
  videoUrl, duration: 2, createdAt: ts, updatedAt: ts,
}).returning().get()
db.insert(schema.storyboardLines).values([
  {
    storyboardId: sb1.id, episodeId: episode.id, dramaId: drama.id,
    lineNo: 1, speakerType: 'dialogue', speakerName: '林晚', text: '第一句',
    status: 'ready', audioDurationMs: 1000, sortOrder: 0,
    createdAt: ts, updatedAt: ts,
  },
  {
    storyboardId: sb2.id, episodeId: episode.id, dramaId: drama.id,
    lineNo: 2, speakerType: 'narration', speakerName: '旁白', text: '第二句',
    status: 'ready', audioDurationMs: 800, sortOrder: 0,
    createdAt: ts, updatedAt: ts,
  },
]).run()

after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('replace 初剪按分镜重建主轨并清空字幕', async () => {
  setEditWorkspaceMode('on')
  const state = await getEpisodeEditState(episode.id)
  const plan = state.plan
  plan.subtitles.push({
    id: 'cue_manual',
    text: '手动字幕',
    startMs: 0,
    endMs: 1000,
    style: 'default',
    source: 'manual',
    follow: false,
    anchor: null,
  })

  const result = await roughCutEditPlan(episode.id, {
    mode: 'replace',
    plan,
    create_revision: false,
  })
  assert.equal(result.plan.clips.length, 2)
  assert.equal(result.plan.clips[0].id, `clp_sb_${sb1.id}`)
  assert.equal(result.plan.clips[1].id, `clp_sb_${sb2.id}`)
  assert.equal(result.plan.subtitles.length, 0)
  assert.ok(result.issues.some((issue: any) => issue.code === 'SUBTITLES_CLEARED'))
  assert.equal(result.applied.added, 2)
  assert.equal(result.snapshot_revision, null)
  assert.equal(result.hashes.plan_hash.length, 32)
})

test('append 跳过已存在的分镜并统计 skipped', async () => {
  setEditWorkspaceMode('on')
  const state = await getEpisodeEditState(episode.id)
  const result = await roughCutEditPlan(episode.id, {
    mode: 'append',
    plan: state.plan,
    create_revision: false,
  })
  assert.equal(result.applied.added, 0)
  assert.equal(result.applied.skipped, 2)
  assert.equal(result.plan.clips.length, 2)
})

test('create_revision=true 在替换前创建快照版本', async () => {
  setEditWorkspaceMode('on')
  const state = await getEpisodeEditState(episode.id)
  const result = await roughCutEditPlan(episode.id, {
    mode: 'replace',
    plan: state.plan,
    create_revision: true,
    base_version: state.draft?.version ?? 0,
  })
  assert.ok(result.snapshot_revision)
  assert.equal(result.snapshot_revision.note, '初剪前快照')
  assert.equal(result.snapshot_revision.is_current, true)
  const revisions = db.select().from(schema.editRevisions).all()
    .filter((row) => row.episodeId === episode.id)
  assert.ok(revisions.length >= 2)
})

test('无可用分镜时初剪返回 ROUGH_CUT_NO_MATERIAL', async () => {
  setEditWorkspaceMode('on')
  await assert.rejects(
    () => roughCutEditPlan(emptyEpisode.id, { mode: 'replace' }),
    (error: any) => error.code === 'ROUGH_CUT_NO_MATERIAL' && error.status === 400,
  )
})

test('fill 只补缺失字幕，replace 保留手动字幕', async () => {
  setEditWorkspaceMode('on')
  const state = await getEpisodeEditState(episode.id)
  const manual = {
    id: 'cue_manual',
    text: '手动字幕',
    startMs: 0,
    endMs: 500,
    style: 'default',
    source: 'manual',
    follow: false,
    anchor: null,
    lineId: null,
  }
  const base = { ...state.plan, subtitles: [manual] }

  const filled = suggestEditSubtitles(episode.id, { mode: 'fill', plan: base })
  assert.equal(filled.added, 2)
  assert.equal(filled.updated, 0)
  assert.ok(filled.plan.subtitles.some((cue: any) => cue.id === 'cue_manual'))
  assert.equal(filled.plan.subtitles.filter((cue: any) => cue.source === 'line').length, 2)

  const filledAgain = suggestEditSubtitles(episode.id, { mode: 'fill', plan: filled.plan })
  assert.equal(filledAgain.added, 0)
  assert.equal(filledAgain.skipped, 2)

  const replaced = suggestEditSubtitles(episode.id, { mode: 'replace', plan: filled.plan })
  assert.equal(replaced.updated, 2)
  assert.equal(replaced.added, 2)
  assert.equal(replaced.skipped, 1)
  assert.equal(replaced.plan.subtitles.filter((cue: any) => cue.id === 'cue_manual').length, 1)
  assert.equal(replaced.plan.subtitles.length, 3)
})
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-actions.test.ts
```
Expected: FAIL，`Cannot find module '../src/services/edit-actions-service.ts'`。

- [ ] **Step 3: 实现 `edit-actions-service.ts`**

```ts
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getWritableEpisode } from './edit-access.js'
import { assembleStoryboardClips } from './edit-bootstrap.js'
import { EditWorkspaceError } from './edit-errors.js'
import {
  aspectOf,
  createEmptyEditPlan,
  projectSettingsForAspect,
  type EditIssue,
  type EditPlanV1,
  type EditProjectSettings,
  type EditSubtitleCue,
} from './edit-plan.js'
import { normalizeEditPlan } from './edit-normalize.js'
import { planEnvelope, parsePlanJson } from './edit-response.js'
import { createEditRevision } from './edit-revision-service.js'
import { buildTimelineForPlan } from './edit-timeline-data.js'
import { dialogPlacementsOf, suggestSubtitles } from './edit-timeline.js'

function actionContext(episodeId: number) {
  const episode = getWritableEpisode(episodeId)
  const drama = db.select().from(schema.dramas)
    .where(eq(schema.dramas.id, episode.dramaId))
    .get()
  const project = projectSettingsForAspect(aspectOf(drama?.aspectRatio), 30)
  const draft = db.select().from(schema.episodeEditDrafts)
    .where(eq(schema.episodeEditDrafts.episodeId, episodeId))
    .get()
  const revision = db.select().from(schema.editRevisions)
    .where(and(
      eq(schema.editRevisions.episodeId, episodeId),
      eq(schema.editRevisions.isCurrent, true),
    ))
    .get()
  const stored = parsePlanJson(draft?.planJson) ?? parsePlanJson(revision?.planJson)
  return { episode, project, draft, revision, stored }
}

function normalizeInput(
  raw: unknown,
  episodeId: number,
  project: EditProjectSettings,
) {
  return normalizeEditPlan(
    raw ?? createEmptyEditPlan(episodeId, project),
    { episodeId, project },
  )
}

function transitionBetween(fromClipId: string, toClipId: string) {
  return {
    id: `tr_rc_${fromClipId}_${toClipId}`,
    fromClipId,
    toClipId,
    type: 'dissolve' as const,
    durationMs: 500,
  }
}

export async function roughCutEditPlan(
  episodeId: number,
  input: Record<string, unknown>,
) {
  const context = actionContext(episodeId)
  const base = normalizeInput(input.plan ?? context.stored, episodeId, context.project)
  const mode = input.mode === 'append' ? 'append' : 'replace'
  const transition = input.transition === 'dissolve' ? 'dissolve' : 'cut'
  const assembly = await assembleStoryboardClips(episodeId, context.project, { transition })
  if (assembly.materialCount === 0) {
    throw new EditWorkspaceError(400, 'ROUGH_CUT_NO_MATERIAL', '没有可用的分镜视频')
  }

  let snapshotRevision = null
  if (input.create_revision === true) {
    const snapshot = createEditRevision(episodeId, {
      base_version: input.base_version,
      note: '初剪前快照',
      plan: base.plan,
      update_draft: true,
    })
    snapshotRevision = snapshot.revision
  }

  let next: EditPlanV1
  let added = 0
  let skipped = assembly.skipped
  if (mode === 'replace') {
    const issues: EditIssue[] = [...base.issues]
    if (base.plan.subtitles.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'SUBTITLES_CLEARED',
        path: 'subtitles',
        message: '替换时间线后原字幕已清空，请重新生成字幕建议',
      })
    }
    next = {
      ...base.plan,
      clips: assembly.clips,
      transitions: assembly.transitions,
      subtitles: [],
    }
    added = assembly.materialCount
    const normalized = normalizeEditPlan(next, { episodeId, project: context.project })
    const timeline = buildTimelineForPlan(episodeId, normalized.plan)
    return {
      ...planEnvelope(
        normalized.plan,
        [...issues, ...assembly.warnings, ...normalized.issues],
        dialogPlacementsOf(timeline.linePlacements),
      ),
      applied: { added, skipped },
      snapshot_revision: snapshotRevision,
    }
  }

  const existingSources = new Set(
    base.plan.clips.map((clip) => `${clip.source.kind}:${clip.source.id}`),
  )
  const appended = assembly.clips.filter(
    (clip) => !existingSources.has(`${clip.source.kind}:${clip.source.id}`),
  )
  skipped += assembly.clips.length - appended.length
  added = appended.length
  const appendedIds = new Set(appended.map((clip) => clip.id))
  const lastBase = base.plan.clips[base.plan.clips.length - 1] ?? null
  const firstAppended = appended[0] ?? null
  const mergedTransitions = [
    ...base.plan.transitions,
    ...assembly.transitions.filter(
      (item) => appendedIds.has(item.fromClipId) && appendedIds.has(item.toClipId),
    ),
  ]
  if (transition === 'dissolve' && lastBase && firstAppended) {
    mergedTransitions.push(transitionBetween(lastBase.id, firstAppended.id))
  }
  next = {
    ...base.plan,
    clips: [...base.plan.clips, ...appended],
    transitions: mergedTransitions,
  }
  const normalized = normalizeEditPlan(next, { episodeId, project: context.project })
  const timeline = buildTimelineForPlan(episodeId, normalized.plan)
  return {
    ...planEnvelope(
      normalized.plan,
      [...base.issues, ...assembly.warnings, ...normalized.issues],
      dialogPlacementsOf(timeline.linePlacements),
    ),
    applied: { added, skipped },
    snapshot_revision: snapshotRevision,
  }
}

export function suggestEditSubtitles(
  episodeId: number,
  input: Record<string, unknown>,
) {
  const context = actionContext(episodeId)
  const base = normalizeInput(input.plan ?? context.stored, episodeId, context.project)
  const mode = input.mode === 'replace' ? 'replace' : 'fill'
  const timeline = buildTimelineForPlan(episodeId, base.plan)
  const suggested = suggestSubtitles(base.plan, timeline.linePlacements)

  const cues: EditSubtitleCue[] = [...base.plan.subtitles]
  let added = 0
  let updated = 0
  let skipped = 0
  if (mode === 'replace') {
    const manual = cues.filter((cue) => cue.source !== 'line')
    updated = cues.length - manual.length
    skipped = manual.length
    cues.splice(0, cues.length, ...manual, ...suggested)
    added = suggested.length
  } else {
    const existingLines = new Set(
      cues.map((cue) => cue.lineId).filter((lineId): lineId is number => lineId != null),
    )
    for (const cue of suggested) {
      if (cue.lineId != null && existingLines.has(cue.lineId)) {
        skipped += 1
        continue
      }
      cues.push(cue)
      added += 1
      if (cue.lineId != null) existingLines.add(cue.lineId)
    }
  }

  const next: EditPlanV1 = {
    ...base.plan,
    subtitles: cues.sort(
      (left, right) => left.startMs - right.startMs
        || left.endMs - right.endMs
        || left.id.localeCompare(right.id),
    ),
  }
  const normalized = normalizeEditPlan(next, { episodeId, project: context.project })
  const resultTimeline = buildTimelineForPlan(episodeId, normalized.plan)
  return {
    ...planEnvelope(
      normalized.plan,
      [...base.issues, ...normalized.issues],
      dialogPlacementsOf(resultTimeline.linePlacements),
    ),
    added,
    updated,
    skipped,
  }
}
```

- [ ] **Step 4: 新增动作路由**

在 `routes/edit.ts` 中：

```ts
import { roughCutEditPlan, suggestEditSubtitles } from '../services/edit-actions-service.js'

app.post('/episodes/:id/edit/rough-cut', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, await roughCutEditPlan(episodeId, await readBody(c)))
  } catch (error) {
    return handleEditError(c, error)
  }
})

app.post('/episodes/:id/edit/subtitles/suggest', async (c) => {
  const episodeId = parseId(c.req.param('id'))
  if (!episodeId) return badRequest(c, '集编号无效')
  try {
    return success(c, suggestEditSubtitles(episodeId, await readBody(c)))
  } catch (error) {
    return handleEditError(c, error)
  }
})
```

- [ ] **Step 5: 运行测试**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-actions.test.ts
```
Expected: PASS。

- [ ] **Step 6: 类型检查（不提交）**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run typecheck
```
Expected: PASS。**不要提交。**

---

## Task 8: 前端类型、布局、时间码、吸附与跟随字幕工具

**Files:**
- Modify: `frontend/app/utils/edit-plan.ts`
- Create: `frontend/app/utils/edit-layout.ts`
- Create: `frontend/app/utils/edit-timecode.ts`
- Create: `frontend/app/utils/edit-snap.ts`
- Create: `frontend/app/utils/edit-follow.ts`
- Modify: `frontend/tsconfig.json`
- Test: `frontend/tests/edit-utils.test.mjs`

**Interfaces:**
- Consumes: 后端 Task 3–7 的响应字段。
- Produces:
  - `computeLocalLayout(plan)`: 与后端 `computeLayout` 同口径的本地布局。
  - `activeClipIndex(layout, ms)`、`clipTimelineOffsetMs(layout, clipId, ms)`、`sourceTimeAt(plan, layout, ms)`、`timelineTimeForSource(plan, layout, clipId, sourceMs)`。
  - `formatPrecise(ms)`、`snapToFrame(ms, fps)`、`msToFrames(ms, fps)`、`framesToMs(frames, fps)`。
  - `collectSnapPoints(plan, layout, playheadMs)`、`snapTime(valueMs, points, thresholdMs)`。
  - `syncFollowedCues(plan, layout)`、`migrateCueAnchorsForSplit(plan, sourceClipId, splitOffsetMs, secondClipId)`、`shiftCueAnchors(plan, clipId, deltaMs)`、`scaleCueAnchorsForSpeed(plan, clipId, oldSpeed, newSpeed)`、`cueFollowRange(cue, layout)`。

- [ ] **Step 1: 写失败测试**

Create `frontend/tests/edit-utils.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  computeLocalLayout,
  activeClipIndex,
  clipTimelineOffsetMs,
  sourceTimeAt,
  timelineTimeForSource,
} = await import('../app/utils/edit-layout.ts')
const {
  formatPrecise,
  snapToFrame,
  msToFrames,
  framesToMs,
} = await import('../app/utils/edit-timecode.ts')
const { collectSnapPoints, snapTime } = await import('../app/utils/edit-snap.ts')
const {
  syncFollowedCues,
  migrateCueAnchorsForSplit,
  shiftCueAnchors,
  scaleCueAnchorsForSpeed,
  cueFollowRange,
} = await import('../app/utils/edit-follow.ts')

function source(id, durationMs = 10000) {
  return {
    kind: 'storyboard',
    id,
    url: `static/${id}.mp4`,
    durationMs,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: false,
    fingerprint: '1:1',
  }
}

function clip(id, overrides = {}) {
  return {
    id,
    kind: 'video',
    source: source(id),
    sourceInMs: 0,
    sourceOutMs: 5000,
    speed: 1,
    gapBeforeMs: 0,
    videoFadeInMs: 0,
    videoFadeOutMs: 0,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    filter: { preset: 'none', intensity: 1 },
    lineId: null,
    videoTakeAssetId: null,
    ...overrides,
  }
}

function plan(clips, extra = {}) {
  return {
    version: 1,
    episodeId: 1,
    project: {
      aspect: '16:9',
      width: 1920,
      height: 1080,
      fps: 30,
      background: 'black',
      defaultFit: 'fit',
      defaultTransition: 'cut',
      defaultSubtitleStyle: 'default',
      defaultExportPreset: '1080p',
      tailGapMs: 0,
    },
    clips,
    transitions: [],
    subtitles: [],
    overlays: [],
    markers: [],
    ...extra,
  }
}

test('本地布局与后端一致：转场重叠、空档与尾段', () => {
  const layout = computeLocalLayout(plan(
    [clip('a'), clip('b', { gapBeforeMs: 500 })],
    {
      project: { ...plan([]).project, tailGapMs: 200 },
      transitions: [{ id: 'tr1', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationMs: 400 }],
    },
  ))
  assert.deepEqual(layout.clips.map((item) => ({
    id: item.clip_id,
    start: item.timeline_start_ms,
    end: item.timeline_end_ms,
    content: item.content_duration_ms,
  })), [
    { id: 'a', start: 0, end: 5000, content: 5000 },
    { id: 'b', start: 5100, end: 10100, content: 5000 },
  ])
  assert.equal(layout.transitions[0].overlap_ms, 400)
  assert.equal(layout.content_end_ms, 10100)
  assert.equal(layout.duration_ms, 10300)
})

test('定位活动片段与源时间，覆盖空档', () => {
  const layout = computeLocalLayout(plan([
    clip('a', { sourceInMs: 1000, sourceOutMs: 6000, speed: 2 }),
    clip('b', { gapBeforeMs: 500 }),
  ]))
  assert.deepEqual(layout.clips.map((item) => [item.timeline_start_ms, item.timeline_end_ms]), [
    [0, 2500],
    [3000, 5500],
  ])
  assert.equal(activeClipIndex(layout, 0), 0)
  assert.equal(activeClipIndex(layout, 2499), 0)
  assert.equal(activeClipIndex(layout, 2700), 0)
  assert.equal(activeClipIndex(layout, 3000), 1)
  assert.equal(clipTimelineOffsetMs(layout, 'a', 1250), 1250)
  assert.equal(clipTimelineOffsetMs(layout, 'a', 9000), 2500)
  assert.equal(sourceTimeAt(plan([
    clip('a', { sourceInMs: 1000, sourceOutMs: 6000, speed: 2 }),
    clip('b'),
  ]), layout, 1250), 3500)
  assert.equal(timelineTimeForSource(plan([
    clip('a', { sourceInMs: 1000, sourceOutMs: 6000, speed: 2 }),
    clip('b'),
  ]), layout, 'a', 3500), 1250)
})

test('精确时间码与帧吸附', () => {
  assert.equal(formatPrecise(61234), '01:01.234')
  assert.equal(formatPrecise(3723004), '01:02:03.004')
  assert.equal(formatPrecise(-10), '00:00.000')
  assert.equal(msToFrames(1000, 25), 25)
  assert.equal(framesToMs(25, 25), 1000)
  assert.equal(msToFrames(500, 30), 15)
  assert.ok(Math.abs(snapToFrame(1010, 30) - 1000) < 1)
  assert.ok(Math.abs(snapToFrame(1020, 30) - 1033.333) < 1)
})

test('吸附点收集与阈值选择', () => {
  const layout = computeLocalLayout(plan([clip('a'), clip('b')]))
  const target = plan([clip('a'), clip('b')], {
    subtitles: [{
      id: 'cue1', text: '字幕', startMs: 3000, endMs: 3600,
      style: 'default', source: 'manual', follow: false, anchor: null,
    }],
  })
  const points = collectSnapPoints(target, layout, 1200)
  assert.ok(points.some((item) => item.kind === 'clip-start' && item.ms === 5000))
  assert.ok(points.some((item) => item.kind === 'clip-end' && item.ms === 5000))
  assert.ok(points.some((item) => item.kind === 'cue-start' && item.ms === 3000))
  assert.deepEqual(snapTime(3040, points, 60), {
    ms: 3000,
    point: points.find((item) => item.kind === 'cue-start'),
  })
  assert.deepEqual(snapTime(1245, points, 60), {
    ms: 1200,
    point: points.find((item) => item.kind === 'playhead'),
  })
  assert.deepEqual(snapTime(4200, points, 60), { ms: 4200, point: null })
})

test('跟随字幕随片段位置重算，手动字幕不动', () => {
  const base = plan([clip('a', { gapBeforeMs: 700 }), clip('b')], {
    subtitles: [{
      id: 'follow1', text: '跟随', startMs: 1000, endMs: 1600,
      style: 'default', source: 'line', follow: true,
      anchor: { clipId: 'a', offsetMs: 1000 }, lineId: 7,
    }, {
      id: 'manual1', text: '手动', startMs: 1000, endMs: 1600,
      style: 'default', source: 'manual', follow: false, anchor: null,
    }],
  })
  const layout = computeLocalLayout(base)
  const synced = syncFollowedCues(base, layout)
  assert.equal(synced.subtitles[0].startMs, 1700)
  assert.equal(synced.subtitles[0].endMs, 2300)
  assert.equal(synced.subtitles[1].startMs, 1000)
  assert.deepEqual(cueFollowRange(synced.subtitles[0], layout), { startMs: 1700, endMs: 2300 })
  assert.equal(cueFollowRange(synced.subtitles[1], layout), null)
})

test('分割迁移锚点，裁剪平移锚点，变速缩放锚点', () => {
  const base = plan([clip('a'), clip('b')], {
    subtitles: [{
      id: 'cue1', text: '前半', startMs: 1200, endMs: 1700,
      style: 'default', source: 'line', follow: true,
      anchor: { clipId: 'a', offsetMs: 1200 }, lineId: 1,
    }, {
      id: 'cue2', text: '后半', startMs: 2200, endMs: 2700,
      style: 'default', source: 'line', follow: true,
      anchor: { clipId: 'a', offsetMs: 2200 }, lineId: 2,
    }],
  })
  const split = migrateCueAnchorsForSplit(base, 'a', 2000, 'a_second')
  assert.deepEqual(split.subtitles[0].anchor, { clipId: 'a', offsetMs: 1200 })
  assert.deepEqual(split.subtitles[1].anchor, { clipId: 'a_second', offsetMs: 200 })

  const shifted = shiftCueAnchors(base, 'a', 500)
  assert.deepEqual(shifted.subtitles[0].anchor, { clipId: 'a', offsetMs: 700 })
  assert.deepEqual(shifted.subtitles[1].anchor, { clipId: 'a', offsetMs: 1700 })

  const scaled = scaleCueAnchorsForSpeed(base, 'a', 1, 2)
  assert.deepEqual(scaled.subtitles[0].anchor, { clipId: 'a', offsetMs: 2400 })
  assert.deepEqual(scaled.subtitles[1].anchor, { clipId: 'a', offsetMs: 4400 })
})
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-utils.test.mjs
```
Expected: FAIL，`Cannot find module '../app/utils/edit-layout.ts'`。

- [ ] **Step 3: 扩展前端类型**

在 `frontend/app/utils/edit-plan.ts` 中，用下面的完整定义替换现有 `EditWorkspaceState` 接口：

```ts
export interface EditIssue {
  severity: 'error' | 'warning'
  code: string
  path?: string
  message: string
}

export interface EditLinePlacement {
  line_id: number
  clip_id: string
  storyboard_id: number | null
  start_ms: number
  end_ms: number
  duration_ms: number
  text: string
  subtitle_text: string | null
  speaker_name: string | null
  voice_take_id: number | null
  audio_url: string | null
  audio_fingerprint: string | null
  overflows_clip: boolean
  overflow_ms: number
  anchor_type: 'shot' | 'absolute'
  warnings: string[]
}

export interface EditMediaStoryboard {
  id: number
  number: number
  title: string | null
  thumbnail_url: string | null
  video_url: string | null
  source: EditClipSource | null
  playable: boolean
  error: string | null
}

export interface EditMediaLine {
  id: number
  line_no: number
  storyboard_id: number | null
  speaker_name: string | null
  speaker_type: string
  text: string
  subtitle_text: string | null
  status: string
  audio_url: string | null
  duration_ms: number | null
  voice_start_ms: number | null
  anchor_type: string
}

export interface EditMediaVideoTake {
  id: number
  line_id: number
  take_no: number
  audio_url: string
  duration_ms: number | null
  hash: string | null
  is_active: boolean
  status: string
  text: string
  speaker_name: string | null
}

export interface EditMediaLibrary {
  storyboards: EditMediaStoryboard[]
  video_takes: EditMediaVideoTake[]
  lines: EditMediaLine[]
  audio: { mix: null; audio_ref: null }
  import_enabled: boolean
}

export interface EditRevisionSummary {
  id: number
  revision_no: number
  note: string | null
  duration_ms: number | null
  clip_count: number | null
  plan_hash: string
  edit_sync_hash: string
  created_at: string
  is_current: boolean
}

export interface EditRevisionDetail {
  revision: EditRevisionSummary
  plan: EditPlanV1
}

export interface EditHashes {
  plan_hash: string
  render_hash: string
  edit_sync_hash: string
  dialogue_sync_hash: string
  subtitle_hash: string
}

export interface EditSaveResult {
  version: number
  updated_at: string
  plan: EditPlanV1
  layout: EditLayout
  hashes: EditHashes
  issues: EditIssue[]
  draft_dirty: boolean
}

export interface EditVersionConflictData {
  current_version: number
  current_plan: EditPlanV1
  updated_at: string
}

export interface EditPlanEnvelope {
  plan: EditPlanV1
  layout: EditLayout
  hashes: EditHashes
  issues: EditIssue[]
}

export interface EditRoughCutResult extends EditPlanEnvelope {
  applied: { added: number; skipped: number }
  snapshot_revision: EditRevisionSummary | null
}

export interface EditSubtitleSuggestResult extends EditPlanEnvelope {
  added: number
  updated: number
  skipped: number
}

export interface EditWorkspaceState {
  episode_id: number
  episode_number: number
  enabled: boolean
  mode?: 'off' | 'readonly' | 'on'
  draft: { version: number; updated_at: string; plan: EditPlanV1 } | null
  current_revision: EditRevisionSummary | null
  current_revision_plan: EditPlanV1 | null
  plan: EditPlanV1
  layout: EditLayout
  hashes: EditHashes
  draft_dirty: boolean
  mix_status: {
    status: 'missing' | 'stale' | 'aligned'
    reasons: string[]
    edit_revision_id: number | null
    mix_revision_id: number | null
    summary: unknown
  }
  renders: { cut: unknown; audio_ref: unknown }
  audio: {
    mode: 'video' | 'none'
    url?: string
    duration_ms?: number
  }
  media_warnings: EditIssue[]
  line_placements: EditLinePlacement[]
  rough_cut_available: boolean
  capabilities: {
    can_edit: boolean
    can_export: boolean
    lock: { kind: string; owner: string; expires_at: string } | null
  }
}
```

- [ ] **Step 4: 创建 `edit-layout.ts`**

```ts
import type { EditClip, EditLayout, EditPlanV1 } from './edit-plan'

export function localClipContentDurationMs(clip: EditClip): number {
  const speed = Number(clip.speed)
  if (!Number.isFinite(speed) || speed <= 0) return 0
  return Math.max(0, Math.round((Number(clip.sourceOutMs) - Number(clip.sourceInMs)) / speed))
}

export function computeLocalLayout(plan: EditPlanV1): EditLayout {
  const clips: EditLayout['clips'] = []
  const transitions: EditLayout['transitions'] = []
  let cursor = 0

  plan.clips.forEach((clip, index) => {
    const content = localClipContentDurationMs(clip)
    const previous = index === 0 ? null : plan.clips[index - 1]
    const transition = previous
      ? plan.transitions.find(
        (item) => item.fromClipId === previous.id && item.toClipId === clip.id,
      )
      : undefined
    const overlap = transition ? Math.max(0, Number(transition.durationMs) || 0) : 0
    const gap = Math.max(0, Number(clip.gapBeforeMs) || 0)
    const start = index === 0 ? gap : cursor - overlap + gap
    const end = start + content
    clips.push({
      clip_id: clip.id,
      timeline_start_ms: start,
      timeline_end_ms: end,
      content_duration_ms: content,
    })
    if (transition && overlap > 0) {
      transitions.push({
        id: transition.id,
        from_clip_id: previous!.id,
        to_clip_id: clip.id,
        overlap_ms: overlap,
      })
    }
    cursor = end
  })

  const contentEnd = clips.length ? clips[clips.length - 1].timeline_end_ms : 0
  const overlayEnd = plan.overlays.reduce((max, overlay) => Math.max(max, overlay.endMs), 0)
  return {
    content_end_ms: contentEnd,
    duration_ms: Math.max(contentEnd, overlayEnd) + Math.max(0, Number(plan.project.tailGapMs) || 0),
    clips,
    transitions,
  }
}

export function activeClipIndex(layout: EditLayout, timeMs: number): number {
  if (!layout.clips.length) return -1
  const time = Math.max(0, Number(timeMs) || 0)
  let index = 0
  for (let cursor = 0; cursor < layout.clips.length; cursor += 1) {
    if (time >= layout.clips[cursor].timeline_start_ms) index = cursor
    else break
  }
  return index
}

export function findLayoutClip(layout: EditLayout, clipId: string | null | undefined) {
  if (!clipId) return null
  return layout.clips.find((item) => item.clip_id === clipId) ?? null
}

export function clipTimelineOffsetMs(
  layout: EditLayout,
  clipId: string,
  timeMs: number,
): number {
  const clip = findLayoutClip(layout, clipId)
  if (!clip) return 0
  return Math.max(
    0,
    Math.min(clip.content_duration_ms, (Number(timeMs) || 0) - clip.timeline_start_ms),
  )
}

export function sourceTimeAt(
  plan: EditPlanV1,
  layout: EditLayout,
  timeMs: number,
): number {
  const index = activeClipIndex(layout, timeMs)
  if (index < 0) return 0
  const clip = plan.clips[index]
  const layoutClip = layout.clips[index]
  const offset = Math.max(
    0,
    Math.min(layoutClip.content_duration_ms, (Number(timeMs) || 0) - layoutClip.timeline_start_ms),
  )
  const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1
  return Math.round(Number(clip.sourceInMs) + offset * speed)
}

export function timelineTimeForSource(
  plan: EditPlanV1,
  layout: EditLayout,
  clipId: string,
  sourceMs: number,
): number {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) return 0
  const clip = plan.clips[index]
  const layoutClip = layout.clips[index]
  if (!layoutClip) return 0
  const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1
  const offset = (Number(sourceMs) - Number(clip.sourceInMs)) / speed
  return Math.round(
    layoutClip.timeline_start_ms
      + Math.max(0, Math.min(layoutClip.content_duration_ms, offset)),
  )
}
```

- [ ] **Step 5: 创建 `edit-timecode.ts`**

```ts
function pad(value: number, size = 2): string {
  return String(Math.max(0, Math.floor(value))).padStart(size, '0')
}

export function formatPrecise(ms: number): string {
  const total = Math.max(0, Math.round(Number(ms) || 0))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const millis = total % 1000
  const body = `${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`
  return hours > 0 ? `${pad(hours)}:${body}` : body
}

export function frameDurationMs(fps: number): number {
  const value = Number(fps)
  return 1000 / (Number.isFinite(value) && value > 0 ? value : 30)
}

export function snapToFrame(ms: number, fps: number): number {
  const frame = frameDurationMs(fps)
  return Math.round((Number(ms) || 0) / frame) * frame
}

export function msToFrames(ms: number, fps: number): number {
  return Math.round((Number(ms) || 0) / frameDurationMs(fps))
}

export function framesToMs(frames: number, fps: number): number {
  return Math.round((Number(frames) || 0) * frameDurationMs(fps))
}
```

- [ ] **Step 6: 创建 `edit-snap.ts`**

```ts
import type { EditLayout, EditPlanV1 } from './edit-plan'

export type EditSnapKind = 'zero' | 'clip-start' | 'clip-end' | 'cue-start' | 'cue-end' | 'playhead'

export interface EditSnapPoint {
  ms: number
  kind: EditSnapKind
}

export function collectSnapPoints(
  plan: EditPlanV1,
  layout: EditLayout,
  playheadMs = 0,
): EditSnapPoint[] {
  const points: EditSnapPoint[] = [{ ms: 0, kind: 'zero' }]
  for (const clip of layout.clips) {
    points.push({ ms: clip.timeline_start_ms, kind: 'clip-start' })
    points.push({ ms: clip.timeline_end_ms, kind: 'clip-end' })
  }
  for (const cue of plan.subtitles) {
    points.push({ ms: cue.startMs, kind: 'cue-start' })
    points.push({ ms: cue.endMs, kind: 'cue-end' })
  }
  points.push({ ms: Math.max(0, Math.round(playheadMs) || 0), kind: 'playhead' })
  const seen = new Set<string>()
  return points
    .sort((left, right) => left.ms - right.ms)
    .filter((point) => {
      const key = `${point.ms}:${point.kind}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function snapTime(
  valueMs: number,
  points: EditSnapPoint[],
  thresholdMs = 60,
): { ms: number; point: EditSnapPoint | null } {
  const value = Number(valueMs) || 0
  let best: EditSnapPoint | null = null
  let distance = Number.POSITIVE_INFINITY
  for (const point of points) {
    const current = Math.abs(point.ms - value)
    if (current <= thresholdMs && current < distance) {
      best = point
      distance = current
    }
  }
  return { ms: best ? best.ms : Math.round(value), point: best }
}
```

- [ ] **Step 7: 创建 `edit-follow.ts`**

```ts
import type {
  EditLayout,
  EditPlanV1,
  EditSubtitleCue,
} from './edit-plan'

export function cueFollowRange(
  cue: EditSubtitleCue,
  layout: EditLayout,
): { startMs: number; endMs: number } | null {
  if (!cue.follow || !cue.anchor) return null
  const target = layout.clips.find((clip) => clip.clip_id === cue.anchor!.clipId)
  if (!target) return null
  const duration = Math.max(0, cue.endMs - cue.startMs)
  const startMs = target.timeline_start_ms + Math.max(0, cue.anchor.offsetMs)
  const endMs = Math.min(target.timeline_end_ms, startMs + duration)
  return { startMs, endMs: Math.max(startMs, endMs) }
}

export function syncFollowedCues(plan: EditPlanV1, layout: EditLayout): EditPlanV1 {
  return {
    ...plan,
    subtitles: plan.subtitles.map((cue) => {
      const range = cueFollowRange(cue, layout)
      if (!range) return cue
      return {
        ...cue,
        startMs: Math.round(range.startMs),
        endMs: Math.round(range.endMs),
      }
    }),
  }
}

export function migrateCueAnchorsForSplit(
  plan: EditPlanV1,
  sourceClipId: string,
  splitOffsetMs: number,
  secondClipId: string,
): EditPlanV1 {
  return {
    ...plan,
    subtitles: plan.subtitles.map((cue) => {
      if (cue.anchor?.clipId !== sourceClipId) return cue
      if (cue.anchor.offsetMs < splitOffsetMs) return cue
      return {
        ...cue,
        anchor: {
          clipId: secondClipId,
          offsetMs: Math.max(0, Math.round(cue.anchor.offsetMs - splitOffsetMs)),
        },
      }
    }),
  }
}

export function shiftCueAnchors(
  plan: EditPlanV1,
  clipId: string,
  deltaMs: number,
): EditPlanV1 {
  return {
    ...plan,
    subtitles: plan.subtitles.map((cue) => {
      if (cue.anchor?.clipId !== clipId) return cue
      return {
        ...cue,
        anchor: {
          clipId,
          offsetMs: Math.max(0, Math.round(cue.anchor.offsetMs - deltaMs)),
        },
      }
    }),
  }
}

export function scaleCueAnchorsForSpeed(
  plan: EditPlanV1,
  clipId: string,
  oldSpeed: number,
  newSpeed: number,
): EditPlanV1 {
  const from = Number(oldSpeed) > 0 ? Number(oldSpeed) : 1
  const to = Number(newSpeed) > 0 ? Number(newSpeed) : 1
  return {
    ...plan,
    subtitles: plan.subtitles.map((cue) => {
      if (cue.anchor?.clipId !== clipId) return cue
      return {
        ...cue,
        anchor: {
          clipId,
          offsetMs: Math.max(0, Math.round((cue.anchor.offsetMs * from) / to)),
        },
      }
    }),
  }
}
```

- [ ] **Step 8: 允许测试直接导入 `.ts` 扩展名**

把 `frontend/tsconfig.json` 改为：

```json
{
  "extends": "./.nuxt/tsconfig.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true
  }
}
```

- [ ] **Step 9: 运行测试**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-utils.test.mjs
```
Expected: PASS（6 个测试）。

- [ ] **Step 10: 运行现有结构测试，确认未被破坏**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-structure.test.mjs
```
Expected: PASS。**不要提交。**

---

## Task 9: 时间线命令与撤销历史

**Files:**
- Create: `frontend/app/utils/edit-commands.ts`
- Create: `frontend/app/utils/edit-history.ts`
- Test: `frontend/tests/edit-commands.test.mjs`

**Interfaces:**
- Consumes: Task 8 的 `computeLocalLayout`、`localClipContentDurationMs`、跟随字幕工具。
- Produces（全部纯函数、输入计划不被修改）：
  - `createClipFromSource(id, source, overrides?)`
  - `insertClip(plan, clip, { index? })`、`appendClip(plan, clip)`
  - `removeClip(plan, clipId, { ripple? })`、`moveClip(plan, clipId, targetIndex)`
  - `trimClipStart(plan, clipId, deltaMs, { ripple? })`、`trimClipEnd(plan, clipId, deltaMs, { ripple? })`
  - `splitClip(plan, clipId, atOffsetMs, secondClipId)`
  - `setClipSpeed(plan, clipId, speed)`、`setClipGap(plan, clipId, gapBeforeMs)`、`setClipFades(plan, clipId, fadeInMs, fadeOutMs)`
  - `setTransition(plan, fromClipId, toClipId, { type?, durationMs?, id? })`、`removeTransition(plan, transitionId)`、`pruneTransitions(plan)`
  - `closeGaps(plan)`、`moveCue(plan, cueId, startMs)`、`setCueText(plan, cueId, text)`、`addCue(plan, cue)`、`deleteCue(plan, cueId)`
  - `createCommandId(prefix)`
  - 命令结果 `{ plan, issues, focusClipId }`；致命问题用 `severity: 'error'` 且返回原计划。
- 历史：`createEditHistory(plan, limit?)`、`pushEditHistory`、`undoEditHistory`、`redoEditHistory`、`canUndo`、`canRedo`。

- [ ] **Step 1: 写失败测试**

Create `frontend/tests/edit-commands.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  createClipFromSource,
  insertClip,
  appendClip,
  removeClip,
  moveClip,
  trimClipStart,
  trimClipEnd,
  splitClip,
  setClipSpeed,
  setClipGap,
  setClipFades,
  setTransition,
  removeTransition,
  closeGaps,
  moveCue,
  setCueText,
  deleteCue,
} = await import('../app/utils/edit-commands.ts')
const {
  createEditHistory,
  pushEditHistory,
  undoEditHistory,
  redoEditHistory,
  canUndo,
  canRedo,
} = await import('../app/utils/edit-history.ts')
const { computeLocalLayout } = await import('../app/utils/edit-layout.ts')

function source(id, durationMs = 10000) {
  return {
    kind: 'storyboard',
    id,
    url: `static/${id}.mp4`,
    durationMs,
    width: 1080,
    height: 1920,
    fps: 30,
    hasAudio: false,
    fingerprint: '1:1',
  }
}

function clip(id, overrides = {}) {
  return {
    ...createClipFromSource(id, source(id, overrides.sourceDurationMs || 10000)),
    ...overrides,
  }
}

function plan(clips, extra = {}) {
  return {
    version: 1,
    episodeId: 1,
    project: {
      aspect: '16:9',
      width: 1920,
      height: 1080,
      fps: 30,
      background: 'black',
      defaultFit: 'fit',
      defaultTransition: 'cut',
      defaultSubtitleStyle: 'default',
      defaultExportPreset: '1080p',
      tailGapMs: 0,
    },
    clips,
    transitions: [],
    subtitles: [],
    overlays: [],
    markers: [],
    ...extra,
  }
}

function starts(result) {
  return computeLocalLayout(result.plan).clips.map((item) => item.timeline_start_ms)
}

test('插入、追加、涟漪删除与非涟漪删除', () => {
  const base = plan([clip('a')])
  const inserted = insertClip(base, clip('b'), { index: 0 })
  assert.deepEqual(inserted.plan.clips.map((item) => item.id), ['b', 'a'])
  assert.equal(base.clips.length, 1)
  assert.equal(inserted.focusClipId, 'b')

  const appended = appendClip(inserted.plan, clip('c'))
  assert.deepEqual(appended.plan.clips.map((item) => item.id), ['b', 'a', 'c'])

  const ripple = removeClip(appended.plan, 'a', { ripple: true })
  assert.deepEqual(ripple.plan.clips.map((item) => item.id), ['b', 'c'])
  assert.deepEqual(starts(ripple), [0, 5000])

  const kept = removeClip(appended.plan, 'a', { ripple: false })
  assert.deepEqual(kept.plan.clips.map((item) => item.id), ['b', 'c'])
  assert.deepEqual(starts(kept), [5000, 10000])
})

test('移动片段保持自身空档并清理不再相邻的转场', () => {
  const base = plan(
    [clip('a'), clip('b'), clip('c')],
    { transitions: [
      { id: 'tr_ab', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationMs: 400 },
      { id: 'tr_bc', fromClipId: 'b', toClipId: 'c', type: 'dissolve', durationMs: 400 },
    ] },
  )
  const moved = moveClip(base, 'c', 0)
  assert.deepEqual(moved.plan.clips.map((item) => item.id), ['c', 'a', 'b'])
  assert.deepEqual(moved.plan.transitions, [])
})

test('头部裁剪支持涟漪与非涟漪，且最短片段受限', () => {
  const base = plan([clip('a', { gapBeforeMs: 300 }), clip('b')])
  assert.deepEqual(starts(base), [300, 5300])

  const ripple = trimClipStart(base, 'a', 1000)
  assert.equal(ripple.plan.clips[0].sourceInMs, 1000)
  assert.deepEqual(starts(ripple), [300, 4300])

  const kept = trimClipStart(base, 'a', 1000, { ripple: false })
  assert.equal(kept.plan.clips[0].sourceInMs, 1000)
  assert.equal(kept.plan.clips[1].gapBeforeMs, 1000)
  assert.deepEqual(starts(kept), [300, 5300])

  const clamped = trimClipStart(base, 'a', -5000)
  assert.equal(clamped.plan.clips[0].sourceInMs, 0)
  assert.ok(clamped.issues.some((item) => item.code === 'CLIP_TRIM_CLAMPED'))
})

test('尾部裁剪、空档、淡入淡出与变速', () => {
  const base = plan([clip('a'), clip('b')])
  const tail = trimClipEnd(base, 'a', -1000, { ripple: false })
  assert.equal(tail.plan.clips[0].sourceOutMs, 4000)
  assert.equal(tail.plan.clips[1].gapBeforeMs, 1000)
  assert.deepEqual(starts(tail), [0, 5000])

  const gap = setClipGap(base, 'b', 800)
  assert.equal(gap.plan.clips[1].gapBeforeMs, 800)
  assert.deepEqual(starts(gap), [0, 5800])

  const fades = setClipFades(plan([clip('a', { sourceOutMs: 2000 }), clip('b')]), 'a', 1500, 1500)
  assert.ok(
    fades.plan.clips[0].videoFadeInMs + fades.plan.clips[0].videoFadeOutMs
      <= fades.plan.clips[0].sourceOutMs - fades.plan.clips[0].sourceInMs,
  )
  assert.ok(fades.issues.some((item) => item.code === 'CLIP_FADE_CLAMPED'))

  const speed = setClipSpeed(base, 'a', 2)
  assert.equal(speed.plan.clips[0].speed, 2)
  assert.deepEqual(starts(speed), [0, 2500])
})

test('分割片段迁移转场与跟随字幕锚点', () => {
  const base = plan(
    [clip('a', { videoFadeOutMs: 400, lineId: 9 }), clip('b')],
    {
      transitions: [{ id: 'tr_ab', fromClipId: 'a', toClipId: 'b', type: 'dissolve', durationMs: 300 }],
      subtitles: [
        {
          id: 'cue1', text: '前半', startMs: 1200, endMs: 1700,
          style: 'default', source: 'line', follow: true,
          anchor: { clipId: 'a', offsetMs: 1200 }, lineId: 1,
        },
        {
          id: 'cue2', text: '后半', startMs: 2200, endMs: 2700,
          style: 'default', source: 'line', follow: true,
          anchor: { clipId: 'a', offsetMs: 2200 }, lineId: 2,
        },
      ],
    },
  )
  const result = splitClip(base, 'a', 2000, 'a_second')
  assert.deepEqual(result.plan.clips.map((item) => item.id), ['a', 'a_second', 'b'])
  assert.equal(result.plan.clips[0].sourceOutMs, 2000)
  assert.equal(result.plan.clips[1].sourceInMs, 2000)
  assert.equal(result.plan.clips[0].videoFadeOutMs, 0)
  assert.equal(result.plan.clips[1].videoFadeOutMs, 400)
  assert.equal(result.plan.clips[1].lineId, 9)
  assert.equal(result.plan.transitions[0].fromClipId, 'a_second')
  assert.deepEqual(result.plan.subtitles[0].anchor, { clipId: 'a', offsetMs: 1200 })
  assert.deepEqual(result.plan.subtitles[1].anchor, { clipId: 'a_second', offsetMs: 200 })
  assert.equal(result.plan.subtitles[1].startMs, 2200)

  const tooShort = splitClip(base, 'a', 50, 'a_short')
  assert.equal(tooShort.plan.clips.length, 2)
  assert.ok(tooShort.issues.some((item) => item.code === 'SPLIT_TOO_SHORT'))
})

test('转场设置、移除与空档闭合', () => {
  const base = plan([clip('a'), clip('b')])
  const added = setTransition(base, 'a', 'b', { type: 'dissolve', durationMs: 600 })
  assert.equal(added.plan.transitions.length, 1)
  assert.equal(added.plan.transitions[0].durationMs, 600)
  assert.deepEqual(starts(added), [0, 4400])

  const notAdjacent = setTransition(base, 'b', 'a', {})
  assert.equal(notAdjacent.plan.transitions.length, 0)
  assert.ok(notAdjacent.issues.some((item) => item.code === 'TRANSITION_NOT_ADJACENT'))

  const removed = removeTransition(added.plan, added.plan.transitions[0].id)
  assert.equal(removed.plan.transitions.length, 0)

  const spaced = setClipGap(added.plan, 'b', 1000)
  const closed = closeGaps(spaced.plan)
  assert.equal(closed.plan.clips[1].gapBeforeMs, 0)
})

test('字幕移动解除跟随，文本可修改', () => {
  const base = plan([clip('a')], {
    subtitles: [{
      id: 'cue1', text: '原字幕', startMs: 1000, endMs: 1600,
      style: 'default', source: 'line', follow: true,
      anchor: { clipId: 'a', offsetMs: 1000 }, lineId: 1,
    }],
  })
  const moved = moveCue(base, 'cue1', 2500)
  assert.equal(moved.plan.subtitles[0].startMs, 2500)
  assert.equal(moved.plan.subtitles[0].endMs, 3100)
  assert.equal(moved.plan.subtitles[0].follow, false)
  assert.equal(moved.plan.subtitles[0].anchor, null)
  assert.ok(moved.issues.some((item) => item.code === 'CUE_DETACHED'))

  const text = setCueText(moved.plan, 'cue1', '新字幕')
  assert.equal(text.plan.subtitles[0].text, '新字幕')
  assert.equal(deleteCue(text.plan, 'cue1').plan.subtitles.length, 0)
})

test('撤销历史限制 50 步且丢弃分叉', () => {
  const p1 = plan([clip('a')])
  const p2 = plan([clip('a'), clip('b')])
  const p3 = plan([clip('a'), clip('b'), clip('c')])
  let history = createEditHistory(p1, 2)
  history = pushEditHistory(history, p2)
  history = pushEditHistory(history, p3)
  assert.equal(history.past.length, 2)
  assert.equal(canUndo(history), true)
  assert.equal(canRedo(history), false)

  history = undoEditHistory(history)
  assert.deepEqual(history.present.clips.map((item) => item.id), ['a', 'b'])
  history = undoEditHistory(history)
  assert.deepEqual(history.present.clips.map((item) => item.id), ['a'])
  history = undoEditHistory(history)
  assert.deepEqual(history.present.clips.map((item) => item.id), ['a'])

  history = redoEditHistory(history)
  assert.deepEqual(history.present.clips.map((item) => item.id), ['a', 'b'])
  const branch = plan([clip('x')])
  history = pushEditHistory(history, branch)
  assert.deepEqual(history.present.clips.map((item) => item.id), ['x'])
  assert.equal(canRedo(history), false)
})
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-commands.test.mjs
```
Expected: FAIL，`Cannot find module '../app/utils/edit-commands.ts'`。

- [ ] **Step 3: 实现 `edit-commands.ts`**

```ts
import {
  MAX_FADE_MS,
  MAX_GAP_MS,
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
} from './edit-plan.ts'
import type {
  EditClip,
  EditClipSource,
  EditIssue,
  EditPlanV1,
  EditSubtitleCue,
  EditTransition,
} from './edit-plan'
import { computeLocalLayout, localClipContentDurationMs } from './edit-layout.ts'
import {
  migrateCueAnchorsForSplit,
  scaleCueAnchorsForSpeed,
  shiftCueAnchors,
  syncFollowedCues,
} from './edit-follow.ts'

export interface EditCommandIssue extends EditIssue {
  severity: 'error' | 'warning'
}

export interface EditCommandResult {
  plan: EditPlanV1
  issues: EditCommandIssue[]
  focusClipId: string | null
}

function clonePlan(plan: EditPlanV1): EditPlanV1 {
  return structuredClone(plan)
}

function warning(code: string, path: string, message: string): EditCommandIssue {
  return { severity: 'warning', code, path, message }
}

function error(code: string, path: string, message: string): EditCommandIssue {
  return { severity: 'error', code, path, message }
}

function unchanged(plan: EditPlanV1, issue: EditCommandIssue): EditCommandResult {
  return { plan, issues: [issue], focusClipId: null }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function minimumSourceMs(plan: EditPlanV1): number {
  return Math.ceil((3 * 1000) / Math.max(1, Number(plan.project.fps) || 30))
}

function minSourceRange(plan: EditPlanV1, speed: number): number {
  return Math.ceil(minimumSourceMs(plan) * Math.max(0.25, Number(speed) || 1))
}

function sync(plan: EditPlanV1): EditPlanV1 {
  return syncFollowedCues(plan, computeLocalLayout(plan))
}

function nextClipOf(plan: EditPlanV1, index: number): EditClip | null {
  return plan.clips[index + 1] ?? null
}

function clampClipFades(clip: EditClip, issues: EditCommandIssue[]): EditClip {
  let fadeIn = clamp(Math.round(Number(clip.videoFadeInMs) || 0), 0, MAX_FADE_MS)
  let fadeOut = clamp(Math.round(Number(clip.videoFadeOutMs) || 0), 0, MAX_FADE_MS)
  const content = localClipContentDurationMs(clip)
  if (fadeIn + fadeOut > content && fadeIn + fadeOut > 0) {
    const ratio = content / (fadeIn + fadeOut)
    fadeIn = Math.floor(fadeIn * ratio)
    fadeOut = Math.floor(fadeOut * ratio)
    issues.push(warning('CLIP_FADE_CLAMPED', `clip:${clip.id}`, '淡入淡出超出片段时长，已等比缩短'))
  }
  return { ...clip, videoFadeInMs: fadeIn, videoFadeOutMs: fadeOut }
}

export function createClipFromSource(
  id: string,
  source: EditClipSource,
  overrides: Partial<EditClip> = {},
): EditClip {
  const duration = Math.max(1, Math.round(Number(source.durationMs) || 1))
  return {
    id,
    kind: 'video',
    source,
    sourceInMs: 0,
    sourceOutMs: duration,
    speed: 1,
    gapBeforeMs: 0,
    videoFadeInMs: 0,
    videoFadeOutMs: 0,
    transform: { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false },
    filter: { preset: 'none', intensity: 1 },
    lineId: null,
    videoTakeAssetId: null,
    ...overrides,
  }
}

export function createCommandId(prefix = 'clp'): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function insertClip(
  plan: EditPlanV1,
  clip: EditClip,
  options: { index?: number } = {},
): EditCommandResult {
  if (plan.clips.some((item) => item.id === clip.id)) {
    return unchanged(plan, error('CLIP_ID_DUPLICATE', `clip:${clip.id}`, '片段 ID 已存在'))
  }
  if (localClipContentDurationMs(clip) < minimumSourceMs(plan)) {
    return unchanged(plan, error('CLIP_TOO_SHORT', `clip:${clip.id}`, '片段过短'))
  }
  const next = clonePlan(plan)
  const index = clamp(Math.round(options.index ?? next.clips.length), 0, next.clips.length)
  next.clips.splice(index, 0, structuredClone(clip))
  return { plan: sync(next), issues: [], focusClipId: clip.id }
}

export function appendClip(plan: EditPlanV1, clip: EditClip): EditCommandResult {
  return insertClip(plan, clip, { index: plan.clips.length })
}

export function removeClip(
  plan: EditPlanV1,
  clipId: string,
  options: { ripple?: boolean } = {},
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const ripple = options.ripple !== false
  const oldLayout = computeLocalLayout(plan)
  const nextClip = nextClipOf(plan, index)
  const oldNextStart = nextClip
    ? oldLayout.clips.find((item) => item.clip_id === nextClip.id)?.timeline_start_ms ?? 0
    : 0

  let next = clonePlan(plan)
  next.clips.splice(index, 1)
  next.transitions = next.transitions.filter(
    (transition) => transition.fromClipId !== clipId && transition.toClipId !== clipId,
  )
  next.subtitles = next.subtitles.filter(
    (cue) => !(cue.follow && cue.anchor?.clipId === clipId),
  )

  if (!ripple && nextClip) {
    const targetIndex = next.clips.findIndex((clip) => clip.id === nextClip.id)
    if (targetIndex >= 0) {
      const currentStart = computeLocalLayout(next).clips[targetIndex].timeline_start_ms
      const delta = oldNextStart - currentStart
      next.clips[targetIndex] = {
        ...next.clips[targetIndex],
        gapBeforeMs: clamp(
          (Number(next.clips[targetIndex].gapBeforeMs) || 0) + delta,
          0,
          MAX_GAP_MS,
        ),
      }
    }
  }

  const focus = next.clips[Math.min(index, next.clips.length - 1)]?.id ?? null
  return { plan: sync(next), issues: [], focusClipId: focus }
}

export function moveClip(
  plan: EditPlanV1,
  clipId: string,
  targetIndex: number,
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const next = clonePlan(plan)
  const [clip] = next.clips.splice(index, 1)
  const target = clamp(Math.round(targetIndex), 0, next.clips.length)
  next.clips.splice(target, 0, clip)
  next.transitions = pruneTransitionsInPlan(next).transitions
  return { plan: sync(next), issues: [], focusClipId: clipId }
}

export function trimClipStart(
  plan: EditPlanV1,
  clipId: string,
  deltaMs: number,
  options: { ripple?: boolean } = {},
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const clip = plan.clips[index]
  const speed = Number(clip.speed) || 1
  const minRange = minSourceRange(plan, speed)
  const target = clamp(
    Math.round(Number(clip.sourceInMs) + (Number(deltaMs) || 0)),
    0,
    Number(clip.sourceOutMs) - minRange,
  )
  if (target < 0) {
    return unchanged(plan, error('CLIP_TOO_SHORT', `clip:${clipId}`, '片段不得短于 3 帧'))
  }
  const actualDelta = target - Number(clip.sourceInMs)
  const issues: EditCommandIssue[] = []
  if (actualDelta !== Math.round(Number(deltaMs) || 0)) {
    issues.push(warning('CLIP_TRIM_CLAMPED', `clip:${clipId}`, '裁剪已到达素材边界或最短长度'))
  }
  if (actualDelta === 0) return { plan, issues, focusClipId: clipId }

  let next = clonePlan(plan)
  const oldContent = localClipContentDurationMs(clip)
  next.clips[index] = clampClipFades({ ...next.clips[index], sourceInMs: target }, issues)
  const newContent = localClipContentDurationMs(next.clips[index])
  const shift = oldContent - newContent
  const nextClip = nextClipOf(next, index)
  if (options.ripple === false && nextClip) {
    next.clips[index + 1] = {
      ...next.clips[index + 1],
      gapBeforeMs: clamp((Number(nextClip.gapBeforeMs) || 0) + shift, 0, MAX_GAP_MS),
    }
  }
  next = shiftCueAnchors(next, clipId, Math.round(actualDelta / speed))
  return { plan: sync(next), issues, focusClipId: clipId }
}

export function trimClipEnd(
  plan: EditPlanV1,
  clipId: string,
  deltaMs: number,
  options: { ripple?: boolean } = {},
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const clip = plan.clips[index]
  const speed = Number(clip.speed) || 1
  const minRange = minSourceRange(plan, speed)
  const maxOut = Math.max(0, Math.round(Number(clip.source.durationMs)))
  const target = clamp(
    Math.round(Number(clip.sourceOutMs) + (Number(deltaMs) || 0)),
    Number(clip.sourceInMs) + minRange,
    maxOut,
  )
  const actualDelta = target - Number(clip.sourceOutMs)
  const issues: EditCommandIssue[] = []
  if (actualDelta !== Math.round(Number(deltaMs) || 0)) {
    issues.push(warning('CLIP_TRIM_CLAMPED', `clip:${clipId}`, '裁剪已到达素材边界或最短长度'))
  }
  if (actualDelta === 0) return { plan, issues, focusClipId: clipId }

  let next = clonePlan(plan)
  const oldContent = localClipContentDurationMs(clip)
  next.clips[index] = clampClipFades({ ...next.clips[index], sourceOutMs: target }, issues)
  const newContent = localClipContentDurationMs(next.clips[index])
  const nextClip = nextClipOf(next, index)
  if (options.ripple === false && nextClip) {
    next.clips[index + 1] = {
      ...next.clips[index + 1],
      gapBeforeMs: clamp(
        (Number(nextClip.gapBeforeMs) || 0) + oldContent - newContent,
        0,
        MAX_GAP_MS,
      ),
    }
  }
  return { plan: sync(next), issues, focusClipId: clipId }
}

export function splitClip(
  plan: EditPlanV1,
  clipId: string,
  atOffsetMs: number,
  secondClipId: string,
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  if (plan.clips.some((clip) => clip.id === secondClipId)) {
    return unchanged(plan, error('CLIP_ID_DUPLICATE', `clip:${secondClipId}`, '片段 ID 已存在'))
  }
  const clip = plan.clips[index]
  const speed = Number(clip.speed) || 1
  const content = localClipContentDurationMs(clip)
  const minMs = minimumSourceMs(plan)
  if (content < minMs * 2) {
    return unchanged(plan, error('SPLIT_TOO_SHORT', `clip:${clipId}`, '片段太短，无法分割'))
  }
  const offset = clamp(Math.round(Number(atOffsetMs) || 0), minMs, content - minMs)
  const sourceSplit = Math.round(Number(clip.sourceInMs) + offset * speed)
  const minRange = minSourceRange(plan, speed)
  if (sourceSplit - Number(clip.sourceInMs) < minRange
    || Number(clip.sourceOutMs) - sourceSplit < minRange) {
    return unchanged(plan, error('SPLIT_TOO_SHORT', `clip:${clipId}`, '分割点太靠近素材边界'))
  }

  const issues: EditCommandIssue[] = []
  const nextClip = nextClipOf(plan, index)
  let next = clonePlan(plan)
  const first: EditClip = clampClipFades({
    ...next.clips[index],
    sourceOutMs: sourceSplit,
    videoFadeOutMs: 0,
  }, issues)
  const second: EditClip = clampClipFades({
    ...structuredClone(clip),
    id: secondClipId,
    sourceInMs: sourceSplit,
    gapBeforeMs: 0,
    videoFadeInMs: 0,
    videoTakeAssetId: null,
  }, issues)
  next.clips[index] = first
  next.clips.splice(index + 1, 0, second)
  next.transitions = next.transitions.map((transition) => (
    nextClip && transition.fromClipId === clipId && transition.toClipId === nextClip.id
      ? { ...transition, fromClipId: secondClipId }
      : transition
  ))
  next = migrateCueAnchorsForSplit(next, clipId, offset, secondClipId)
  return {
    plan: sync(next),
    issues,
    focusClipId: secondClipId,
  }
}

export function setClipSpeed(
  plan: EditPlanV1,
  clipId: string,
  speed: number,
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const nextSpeed = Math.round(clamp(Number(speed) || 1, 0.25, 4) * 1000) / 1000
  const oldSpeed = Number(plan.clips[index].speed) || 1
  if (nextSpeed === oldSpeed) return { plan, issues: [], focusClipId: clipId }

  const issues: EditCommandIssue[] = []
  let next = clonePlan(plan)
  next.clips[index] = clampClipFades(
    { ...next.clips[index], speed: nextSpeed },
    issues,
  )
  next = scaleCueAnchorsForSpeed(next, clipId, oldSpeed, nextSpeed)
  return { plan: sync(next), issues, focusClipId: clipId }
}

export function setClipGap(
  plan: EditPlanV1,
  clipId: string,
  gapBeforeMs: number,
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const next = clonePlan(plan)
  const target = clamp(Math.round(Number(gapBeforeMs) || 0), 0, MAX_GAP_MS)
  next.clips[index] = { ...next.clips[index], gapBeforeMs: target }
  return { plan: sync(next), issues: [], focusClipId: clipId }
}

export function setClipFades(
  plan: EditPlanV1,
  clipId: string,
  fadeInMs: number,
  fadeOutMs: number,
): EditCommandResult {
  const index = plan.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    return unchanged(plan, error('CLIP_NOT_FOUND', `clip:${clipId}`, '片段不存在'))
  }
  const issues: EditCommandIssue[] = []
  const next = clonePlan(plan)
  next.clips[index] = clampClipFades({
    ...next.clips[index],
    videoFadeInMs: Number(fadeInMs) || 0,
    videoFadeOutMs: Number(fadeOutMs) || 0,
  }, issues)
  return { plan: sync(next), issues, focusClipId: clipId }
}

export function setTransition(
  plan: EditPlanV1,
  fromClipId: string,
  toClipId: string,
  options: { type?: string; durationMs?: number; id?: string } = {},
): EditCommandResult {
  const fromIndex = plan.clips.findIndex((clip) => clip.id === fromClipId)
  if (fromIndex < 0 || plan.clips[fromIndex + 1]?.id !== toClipId) {
    return unchanged(plan, error('TRANSITION_NOT_ADJACENT', 'transitions', '转场只能连接相邻片段'))
  }
  const from = plan.clips[fromIndex]
  const to = plan.clips[fromIndex + 1]
  const spare = Math.min(
    localClipContentDurationMs(from),
    localClipContentDurationMs(to),
  )
  if (spare < MIN_TRANSITION_MS) {
    return unchanged(plan, error('TRANSITION_TOO_SHORT', 'transitions', '片段太短，无法添加转场'))
  }
  const duration = clamp(
    Math.round(Number(options.durationMs ?? 600) || 600),
    MIN_TRANSITION_MS,
    Math.min(MAX_TRANSITION_MS, spare),
  )
  const transition: EditTransition = {
    id: options.id || `tr_${fromClipId}_${toClipId}`,
    fromClipId,
    toClipId,
    type: options.type || 'dissolve',
    durationMs: duration,
  }
  const next = clonePlan(plan)
  next.transitions = next.transitions
    .filter((item) => !(item.fromClipId === fromClipId && item.toClipId === toClipId))
    .concat(transition)
  return { plan: sync(next), issues: [], focusClipId: toClipId }
}

export function removeTransition(
  plan: EditPlanV1,
  transitionId: string,
): EditCommandResult {
  const next = clonePlan(plan)
  next.transitions = next.transitions.filter((item) => item.id !== transitionId)
  return { plan: sync(next), issues: [], focusClipId: null }
}

export function pruneTransitions(plan: EditPlanV1): EditCommandResult {
  return {
    plan: sync(pruneTransitionsInPlan(clonePlan(plan))),
    issues: [],
    focusClipId: null,
  }
}

function pruneTransitionsInPlan(plan: EditPlanV1): EditPlanV1 {
  const seen = new Set<string>()
  plan.transitions = plan.transitions.filter((transition, index) => {
    const fromIndex = plan.clips.findIndex((clip) => clip.id === transition.fromClipId)
    const toIndex = plan.clips.findIndex((clip) => clip.id === transition.toClipId)
    if (fromIndex < 0 || toIndex !== fromIndex + 1) return false
    const key = `${transition.fromClipId}:${transition.toClipId}`
    if (seen.has(key)) return false
    seen.add(key)
    return index >= 0
  })
  return plan
}

export function closeGaps(plan: EditPlanV1): EditCommandResult {
  const next = clonePlan(plan)
  next.clips = next.clips.map((clip) => ({ ...clip, gapBeforeMs: 0 }))
  return { plan: sync(next), issues: [], focusClipId: null }
}

export function moveCue(
  plan: EditPlanV1,
  cueId: string,
  startMs: number,
): EditCommandResult {
  const index = plan.subtitles.findIndex((cue) => cue.id === cueId)
  if (index < 0) {
    return { plan, issues: [error('CUE_NOT_FOUND', `cue:${cueId}`, '字幕不存在')], focusClipId: null }
  }
  const cue = plan.subtitles[index]
  const duration = Math.max(0, cue.endMs - cue.startMs)
  const start = Math.max(0, Math.round(Number(startMs) || 0))
  const next = clonePlan(plan)
  next.subtitles[index] = {
    ...next.subtitles[index],
    startMs: start,
    endMs: start + duration,
    follow: false,
    anchor: null,
  }
  return {
    plan: next,
    issues: cue.follow ? [warning('CUE_DETACHED', `cue:${cueId}`, '字幕已脱离片段跟随')] : [],
    focusClipId: cue.anchor?.clipId ?? null,
  }
}

export function setCueText(
  plan: EditPlanV1,
  cueId: string,
  text: string,
): EditCommandResult {
  const index = plan.subtitles.findIndex((cue) => cue.id === cueId)
  if (index < 0) {
    return { plan, issues: [error('CUE_NOT_FOUND', `cue:${cueId}`, '字幕不存在')], focusClipId: null }
  }
  const next = clonePlan(plan)
  next.subtitles[index] = { ...next.subtitles[index], text: String(text ?? '') }
  return { plan: next, issues: [], focusClipId: null }
}

export function addCue(plan: EditPlanV1, cue: EditSubtitleCue): EditCommandResult {
  if (plan.subtitles.some((item) => item.id === cue.id)) {
    return { plan, issues: [error('CUE_ID_DUPLICATE', `cue:${cue.id}`, '字幕 ID 已存在')], focusClipId: null }
  }
  const next = clonePlan(plan)
  next.subtitles = [...next.subtitles, structuredClone(cue)]
    .sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
  return { plan: next, issues: [], focusClipId: cue.anchor?.clipId ?? null }
}

export function deleteCue(plan: EditPlanV1, cueId: string): EditCommandResult {
  const next = clonePlan(plan)
  next.subtitles = next.subtitles.filter((cue) => cue.id !== cueId)
  return { plan: next, issues: [], focusClipId: null }
}
```

- [ ] **Step 4: 实现 `edit-history.ts`**

```ts
import type { EditPlanV1 } from './edit-plan'

export interface EditHistory {
  past: EditPlanV1[]
  present: EditPlanV1
  future: EditPlanV1[]
  limit: number
}

export function createEditHistory(plan: EditPlanV1, limit = 50): EditHistory {
  return { past: [], present: plan, future: [], limit: Math.max(1, limit) }
}

export function pushEditHistory(history: EditHistory, plan: EditPlanV1): EditHistory {
  if (JSON.stringify(history.present) === JSON.stringify(plan)) return history
  const past = [...history.past, history.present].slice(-history.limit)
  return { ...history, past, present: plan, future: [] }
}

export function undoEditHistory(history: EditHistory): EditHistory {
  if (!history.past.length) return history
  const present = history.past[history.past.length - 1]
  return {
    ...history,
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future].slice(0, history.limit),
  }
}

export function redoEditHistory(history: EditHistory): EditHistory {
  if (!history.future.length) return history
  const [present, ...future] = history.future
  return {
    ...history,
    past: [...history.past, history.present].slice(-history.limit),
    present,
    future,
  }
}

export function canUndo(history: EditHistory): boolean {
  return history.past.length > 0
}

export function canRedo(history: EditHistory): boolean {
  return history.future.length > 0
}
```

- [ ] **Step 5: 运行测试**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-commands.test.mjs tests/edit-utils.test.mjs
```
Expected: PASS。

- [ ] **Step 6: 修正实现直到测试通过（不改变测试期望）**

常见问题与处理：
- `setClipFades(base, 'a', 1200, 1200)` 的内容时长为 5000，等比缩短后为 2500 + 2500，测试断言和为 5000。
- 非涟漪删除的 `kept` 断言第二段起点 10000：删除 5000ms 片段后，下一段 `gapBeforeMs` 从 0 变为 5000。
- 分割测试中 `result.plan.subtitles[1].startMs` 在分割后保持 2200，因为第二段时间线起点是 2000，锚点偏移 200。

**不要提交。**

---

## Task 10: 剪辑 API、自动保存队列、冲突恢复与组合式函数

**Files:**
- Modify: `frontend/app/composables/useApi.ts`
- Create: `frontend/app/utils/edit-save.ts`
- Create: `frontend/app/utils/edit-recovery.ts`
- Create: `frontend/app/composables/useEditPlan.ts`
- Create: `frontend/app/composables/useEditMedia.ts`
- Modify: `frontend/tests/edit-structure.test.mjs`
- Test: `frontend/tests/edit-save.test.mjs`

**Interfaces:**
- Consumes: Task 8/9 的工具与类型；后端 Task 4–7 路由。
- Produces:
  - `editAPI.media/saveDraft/discardDraft/revisions/revision/createRevision/restoreRevision/roughCut/suggestSubtitles`。
  - `ApiError.code`（`req` 透传 `json.code`）。
  - `createEditSaveQueue({ save, delayMs, onError })` → `{ schedule, flush, cancel, pending, idle }`。
  - `recoveryKey`、`planFingerprint`、`writeRecovery`、`readRecovery`、`clearRecovery`、`shouldOfferRecovery`。
  - `useEditPlan(initialState)` → `plan/layout/hashes/version/dirty/canEdit/saveStatus/saveError/lastSavedAt/conflict/recovery/issues/history/canUndo/canRedo/planHash/applyCommand/applyExternalPlan/undo/redo/saveNow/reload/discard/createVersion/restoreRevision/resolveConflict/acceptRecovery/dismissRecovery/retrySave`。
  - `useEditMedia(episodeId)` → `media/loading/error/load/storyboards/playableStoryboards/videoTakes/lines`。

- [ ] **Step 1: 写失败测试**

Create `frontend/tests/edit-save.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { createEditSaveQueue } = await import('../app/utils/edit-save.ts')
const {
  recoveryKey,
  planFingerprint,
  writeRecovery,
  readRecovery,
  clearRecovery,
  shouldOfferRecovery,
} = await import('../app/utils/edit-recovery.ts')

function plan(tailGapMs = 0) {
  return {
    version: 1,
    episodeId: 1,
    project: {
      aspect: '16:9', width: 1920, height: 1080, fps: 30,
      background: 'black', defaultFit: 'fit', defaultTransition: 'cut',
      defaultSubtitleStyle: 'default', defaultExportPreset: '1080p', tailGapMs,
    },
    clips: [],
    transitions: [],
    subtitles: [],
    overlays: [],
    markers: [],
  }
}

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
  }
}

test('300ms 防抖只保存最后一次计划', async () => {
  const calls = []
  const queue = createEditSaveQueue({
    delayMs: 5,
    save: async (value) => { calls.push(value.project.tailGapMs) },
  })
  queue.schedule(plan(100))
  queue.schedule(plan(200))
  assert.equal(queue.pending(), true)
  await queue.flush()
  assert.deepEqual(calls, [200])
  assert.equal(queue.pending(), false)
})

test('保存失败调用 onError，后续计划继续保存', async () => {
  const errors = []
  const saved = []
  let attempt = 0
  const queue = createEditSaveQueue({
    delayMs: 0,
    save: async (value) => {
      attempt += 1
      if (attempt === 1) throw new Error('网络断开')
      saved.push(value.project.tailGapMs)
    },
    onError: (error) => errors.push(error.message),
  })
  queue.schedule(plan(100))
  await queue.flush()
  queue.schedule(plan(200))
  await queue.flush()
  assert.deepEqual(errors, ['网络断开'])
  assert.deepEqual(saved, [200])
})

test('cancel 丢弃尚未执行的计划', async () => {
  const calls = []
  const queue = createEditSaveQueue({
    delayMs: 20,
    save: async (value) => { calls.push(value) },
  })
  queue.schedule(plan(300))
  queue.cancel()
  await queue.flush()
  assert.deepEqual(calls, [])
})

test('本地恢复记录可写入、读取、比对与清除', () => {
  const storage = memoryStorage()
  const base = plan(100)
  const next = plan(200)
  writeRecovery(storage, 9, next, 3, '2026-11-06T10:00:00.000Z')
  const record = readRecovery(storage, 9)
  assert.equal(record.episodeId, 9)
  assert.equal(record.baseVersion, 3)
  assert.equal(record.plan.project.tailGapMs, 200)
  assert.equal(record.savedAt, '2026-11-06T10:00:00.000Z')
  assert.equal(record.planHash, planFingerprint(next))
  assert.equal(shouldOfferRecovery(record, base), true)
  assert.equal(shouldOfferRecovery(record, next), false)

  clearRecovery(storage, 9)
  assert.equal(readRecovery(storage, 9), null)
  assert.equal(recoveryKey(9), 'huobao.edit.recovery.9')
})

test('损坏的恢复记录返回 null', () => {
  const storage = memoryStorage()
  storage.setItem(recoveryKey(1), '{bad json')
  assert.equal(readRecovery(storage, 1), null)
  storage.setItem(recoveryKey(1), JSON.stringify({ episodeId: 2, plan: {}, baseVersion: 0 }))
  assert.equal(readRecovery(storage, 1), null)
})
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-save.test.mjs
```
Expected: FAIL，`Cannot find module '../app/utils/edit-save.ts'`。

- [ ] **Step 3: 扩展 `useApi.ts`**

把 `req` 中的错误构造替换为：

```ts
      const error = new Error(json.message || `${resp.status}`) as Error & {
        status?: number
        code?: string
        data?: any
      }
      error.status = resp.status || json.code
      error.code = json.code
      error.data = json.data
      throw error
```

把 `editAPI` 替换为：

```ts
export const editAPI = {
  get: (episodeId: number) => api.get(`/episodes/${episodeId}/edit`),
  media: (episodeId: number) => api.get(`/episodes/${episodeId}/edit/media`),
  saveDraft: (episodeId: number, body: {
    base_version: number
    plan: unknown
    force?: boolean
  }) => api.put(`/episodes/${episodeId}/edit/draft`, body),
  discardDraft: (episodeId: number) => api.del(`/episodes/${episodeId}/edit/draft`),
  revisions: (episodeId: number) => api.get(`/episodes/${episodeId}/edit/revisions`),
  revision: (episodeId: number, revisionId: number) =>
    api.get(`/episodes/${episodeId}/edit/revisions/${revisionId}`),
  createRevision: (episodeId: number, body: {
    base_version: number
    note?: string
    plan?: unknown
    update_draft?: boolean
  }) => api.post(`/episodes/${episodeId}/edit/revisions`, body),
  restoreRevision: (episodeId: number, revisionId: number, body: { base_version: number }) =>
    api.post(`/episodes/${episodeId}/edit/revisions/${revisionId}/restore`, body),
  roughCut: (episodeId: number, body: {
    mode: 'replace' | 'append'
    plan: unknown
    create_revision?: boolean
    base_version?: number
  }) => api.post(`/episodes/${episodeId}/edit/rough-cut`, body),
  suggestSubtitles: (episodeId: number, body: {
    mode: 'fill' | 'replace'
    plan: unknown
  }) => api.post(`/episodes/${episodeId}/edit/subtitles/suggest`, body),
}
```

- [ ] **Step 4: 实现 `edit-save.ts`**

```ts
import type { EditPlanV1 } from './edit-plan'

export interface EditSaveQueueOptions {
  save: (plan: EditPlanV1) => Promise<void>
  delayMs?: number
  onError?: (error: unknown) => void
  setTimeoutFn?: (handler: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

export interface EditSaveQueue {
  schedule(plan: EditPlanV1): void
  flush(): Promise<void>
  cancel(): void
  pending(): boolean
  idle(): Promise<void>
}

export function createEditSaveQueue(options: EditSaveQueueOptions): EditSaveQueue {
  const delay = Math.max(0, Number(options.delayMs ?? 300) || 0)
  const setTimer = options.setTimeoutFn
    ?? ((handler: () => void, ms: number) => setTimeout(handler, ms))
  const clearTimer = options.clearTimeoutFn
    ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let pendingPlan: EditPlanV1 | null = null
  let timer: unknown = null
  let chain: Promise<void> = Promise.resolve()

  function enqueue(): Promise<void> {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    if (!pendingPlan) return chain
    const plan = pendingPlan
    pendingPlan = null
    chain = chain
      .then(() => options.save(plan))
      .catch((error) => {
        options.onError?.(error)
      })
    return chain
  }

  function schedule(plan: EditPlanV1): void {
    pendingPlan = structuredClone(plan)
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      void enqueue()
    }, delay)
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    for (;;) {
      if (pendingPlan) {
        await enqueue()
        continue
      }
      const current = chain
      await current
      if (!pendingPlan && current === chain) break
    }
  }

  function cancel(): void {
    if (timer !== null) clearTimer(timer)
    timer = null
    pendingPlan = null
  }

  return {
    schedule,
    flush,
    cancel,
    pending: () => pendingPlan !== null,
    idle: () => chain,
  }
}
```

- [ ] **Step 5: 实现 `edit-recovery.ts`**

```ts
import type { EditPlanV1 } from './edit-plan'

export interface EditRecovery {
  episodeId: number
  plan: EditPlanV1
  baseVersion: number
  planHash: string
  savedAt: string
}

export interface RecoveryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function recoveryKey(episodeId: number): string {
  return `huobao.edit.recovery.${episodeId}`
}

export function planFingerprint(plan: EditPlanV1): string {
  const text = JSON.stringify(plan)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function writeRecovery(
  storage: RecoveryStorage,
  episodeId: number,
  plan: EditPlanV1,
  baseVersion: number,
  savedAt = new Date().toISOString(),
): EditRecovery {
  const record: EditRecovery = {
    episodeId,
    plan,
    baseVersion,
    planHash: planFingerprint(plan),
    savedAt,
  }
  storage.setItem(recoveryKey(episodeId), JSON.stringify(record))
  return record
}

export function readRecovery(storage: RecoveryStorage, episodeId: number): EditRecovery | null {
  const raw = storage.getItem(recoveryKey(episodeId))
  if (!raw) return null
  try {
    const record = JSON.parse(raw) as EditRecovery
    if (!record || record.episodeId !== episodeId) return null
    if (!Number.isInteger(record.baseVersion) || record.baseVersion < 0) return null
    if (!record.plan || record.plan.version !== 1 || !Array.isArray(record.plan.clips)) return null
    if (typeof record.planHash !== 'string' || !record.planHash) return null
    return record
  } catch {
    return null
  }
}

export function clearRecovery(storage: RecoveryStorage, episodeId: number): void {
  storage.removeItem(recoveryKey(episodeId))
}

export function shouldOfferRecovery(
  recovery: EditRecovery | null,
  serverPlan: EditPlanV1,
): boolean {
  return Boolean(recovery && recovery.planHash !== planFingerprint(serverPlan))
}
```

- [ ] **Step 6: 实现 `useEditPlan.ts`**

```ts
import { editAPI } from '~/composables/useApi'
import { computeLocalLayout } from '~/utils/edit-layout'
import { createEditSaveQueue } from '~/utils/edit-save'
import {
  clearRecovery,
  planFingerprint,
  readRecovery,
  shouldOfferRecovery,
  writeRecovery,
  type EditRecovery,
  type RecoveryStorage,
} from '~/utils/edit-recovery'
import {
  canRedo,
  canUndo,
  createEditHistory,
  pushEditHistory,
  redoEditHistory,
  undoEditHistory,
} from '~/utils/edit-history'
import type { EditCommandResult } from '~/utils/edit-commands'
import type {
  EditHashes,
  EditIssue,
  EditPlanV1,
  EditRevisionSummary,
  EditVersionConflictData,
  EditWorkspaceState,
} from '~/utils/edit-plan'

export function useEditPlan(initial: EditWorkspaceState) {
  const plan = ref<EditPlanV1>(structuredClone(initial.plan))
  const version = ref(initial.draft?.version ?? 0)
  const dirty = ref(Boolean(initial.draft_dirty))
  const saveStatus = ref<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>(
    initial.draft ? 'saved' : 'idle',
  )
  const saveError = ref('')
  const lastSavedAt = ref(initial.draft?.updated_at ?? '')
  const hashes = ref<EditHashes>(initial.hashes)
  const conflict = ref<EditVersionConflictData | null>(null)
  const issues = ref<EditIssue[]>([])
  const history = ref(createEditHistory(plan.value))
  const layout = computed(() => computeLocalLayout(plan.value))
  const canEdit = computed(() => Boolean(initial.capabilities.can_edit))

  function storage(): RecoveryStorage | null {
    return typeof localStorage === 'undefined' ? null : localStorage
  }

  const stored = storage()
  const restored = stored ? readRecovery(stored, initial.episode_id) : null
  const recovery = ref<EditRecovery | null>(
    shouldOfferRecovery(restored, initial.plan) ? restored : null,
  )

  function remember(nextPlan: EditPlanV1): void {
    if (!canEdit.value) return
    const target = storage()
    if (!target) return
    writeRecovery(target, initial.episode_id, nextPlan, version.value)
  }

  const queue = createEditSaveQueue({
    delayMs: 300,
    save: async (nextPlan) => {
      if (!canEdit.value) return
      saveStatus.value = 'saving'
      saveError.value = ''
      try {
        const result = await editAPI.saveDraft(initial.episode_id, {
          base_version: version.value,
          plan: nextPlan,
        })
        const unchanged = planFingerprint(plan.value) === planFingerprint(nextPlan)
        version.value = result.version
        lastSavedAt.value = result.updated_at
        hashes.value = result.hashes
        dirty.value = unchanged ? result.draft_dirty : true
        saveStatus.value = unchanged ? 'saved' : 'idle'
        if (unchanged) {
          const target = storage()
          if (target) clearRecovery(target, initial.episode_id)
          recovery.value = null
        }
      } catch (cause: any) {
        if (cause?.code === 'EDIT_VERSION_CONFLICT') {
          conflict.value = cause.data as EditVersionConflictData
          saveStatus.value = 'conflict'
          return
        }
        saveStatus.value = 'error'
        saveError.value = cause?.message || '保存失败'
        remember(nextPlan)
      }
    },
    onError: (error: any) => {
      saveStatus.value = 'error'
      saveError.value = error?.message || '保存失败'
    },
  })

  function applyResult(result: EditCommandResult, options: { remember?: boolean } = {}) {
    if (!canEdit.value) return false
    if (result.issues.some((issue) => issue.severity === 'error')) {
      issues.value = result.issues
      return false
    }
    issues.value = result.issues
    if (result.plan === plan.value) return false
    history.value = pushEditHistory(history.value, plan.value)
    plan.value = result.plan
    dirty.value = true
    saveStatus.value = 'idle'
    if (options.remember !== false) remember(result.plan)
    queue.schedule(result.plan)
    return true
  }

  function applyCommand(command: (value: EditPlanV1) => EditCommandResult) {
    return applyResult(command(plan.value))
  }

  function applyExternalPlan(nextPlan: EditPlanV1, nextHashes?: EditHashes) {
    const applied = applyResult({ plan: nextPlan, issues: [], focusClipId: null })
    if (nextHashes) hashes.value = nextHashes
    return applied
  }

  function undo() {
    if (!canEdit.value || !canUndo(history.value)) return
    history.value = undoEditHistory(history.value)
    plan.value = history.value.present
    dirty.value = true
    saveStatus.value = 'idle'
    remember(plan.value)
    queue.schedule(plan.value)
  }

  function redo() {
    if (!canEdit.value || !canRedo(history.value)) return
    history.value = redoEditHistory(history.value)
    plan.value = history.value.present
    dirty.value = true
    saveStatus.value = 'idle'
    remember(plan.value)
    queue.schedule(plan.value)
  }

  async function saveNow() {
    if (!canEdit.value) return
    await queue.flush()
  }

  function resetFrom(state: EditWorkspaceState): void {
    plan.value = structuredClone(state.plan)
    version.value = state.draft?.version ?? 0
    dirty.value = Boolean(state.draft_dirty)
    lastSavedAt.value = state.draft?.updated_at ?? ''
    hashes.value = state.hashes
    history.value = createEditHistory(plan.value)
    conflict.value = null
    issues.value = []
    saveStatus.value = state.draft ? 'saved' : 'idle'
    saveError.value = ''
  }

  async function reload() {
    queue.cancel()
    const state = await editAPI.get(initial.episode_id)
    resetFrom(state)
    recovery.value = null
    const target = storage()
    if (target) clearRecovery(target, initial.episode_id)
  }

  async function discard() {
    if (!canEdit.value) return
    queue.cancel()
    await editAPI.discardDraft(initial.episode_id)
    await reload()
  }

  async function createVersion(note: string): Promise<EditRevisionSummary | null> {
    if (!canEdit.value) return null
    await queue.flush()
    if (conflict.value) return null
    const sentPlan = plan.value
    const result = await editAPI.createRevision(initial.episode_id, {
      base_version: version.value,
      note,
      plan: sentPlan,
      update_draft: true,
    })
    const unchanged = planFingerprint(plan.value) === planFingerprint(sentPlan)
    version.value = result.draft_version ?? version.value
    dirty.value = unchanged ? Boolean(result.draft_dirty) : true
    saveStatus.value = unchanged ? 'saved' : 'idle'
    if (unchanged) {
      const target = storage()
      if (target) clearRecovery(target, initial.episode_id)
      recovery.value = null
    }
    return result.revision as EditRevisionSummary
  }

  async function restoreRevision(revisionId: number) {
    if (!canEdit.value) return
    queue.cancel()
    await editAPI.restoreRevision(initial.episode_id, revisionId, {
      base_version: version.value,
    })
    await reload()
  }

  async function resolveConflict(mode: 'reload' | 'overwrite') {
    if (!canEdit.value) return
    if (mode === 'reload') {
      await reload()
      return
    }
    const result = await editAPI.saveDraft(initial.episode_id, {
      base_version: version.value,
      plan: plan.value,
      force: true,
    })
    version.value = result.version
    dirty.value = result.draft_dirty
    conflict.value = null
    saveStatus.value = 'saved'
    recovery.value = null
    const target = storage()
    if (target) clearRecovery(target, initial.episode_id)
  }

  function acceptRecovery() {
    if (!canEdit.value || !recovery.value) return
    history.value = pushEditHistory(history.value, plan.value)
    plan.value = structuredClone(recovery.value.plan)
    dirty.value = true
    saveStatus.value = 'idle'
    recovery.value = null
    queue.schedule(plan.value)
  }

  function dismissRecovery() {
    const target = storage()
    if (target) clearRecovery(target, initial.episode_id)
    recovery.value = null
  }

  function retrySave() {
    if (!canEdit.value) return
    saveError.value = ''
    saveStatus.value = 'idle'
    queue.schedule(plan.value)
  }

  return {
    plan,
    layout,
    hashes,
    version,
    dirty,
    canEdit,
    saveStatus,
    saveError,
    lastSavedAt,
    conflict,
    recovery,
    issues,
    history,
    canUndo: computed(() => canUndo(history.value)),
    canRedo: computed(() => canRedo(history.value)),
    applyCommand,
    applyExternalPlan,
    undo,
    redo,
    saveNow,
    reload,
    discard,
    createVersion,
    restoreRevision,
    resolveConflict,
    acceptRecovery,
    dismissRecovery,
    retrySave,
    planHash: computed(() => planFingerprint(plan.value)),
  }
}
```

- [ ] **Step 7: 实现 `useEditMedia.ts`**

```ts
import { editAPI } from '~/composables/useApi'
import type { EditMediaLibrary } from '~/utils/edit-plan'

export function useEditMedia(episodeId: number) {
  const media = ref<EditMediaLibrary | null>(null)
  const loading = ref(false)
  const error = ref('')

  const storyboards = computed(() => media.value?.storyboards ?? [])
  const playableStoryboards = computed(() => storyboards.value.filter((item) => item.playable))
  const videoTakes = computed(() => media.value?.video_takes ?? [])
  const lines = computed(() => media.value?.lines ?? [])

  async function load() {
    loading.value = true
    error.value = ''
    try {
      media.value = await editAPI.media(episodeId)
    } catch (cause: any) {
      error.value = cause?.message || '素材库加载失败'
    } finally {
      loading.value = false
    }
  }

  return {
    media,
    loading,
    error,
    load,
    storyboards,
    playableStoryboards,
    videoTakes,
    lines,
  }
}
```

- [ ] **Step 8: 更新结构测试的 API 断言**

在 `frontend/tests/edit-structure.test.mjs` 的第二个测试中，把 `assert.match(api, /\/episodes\/\$\{episodeId\}\/edit/)` 后追加：

```js
  assert.match(api, /edit\/media/)
  assert.match(api, /edit\/draft/)
  assert.match(api, /edit\/revisions/)
  assert.match(api, /edit\/rough-cut/)
  assert.match(api, /edit\/subtitles\/suggest/)
  assert.match(api, /error\.code = json\.code/)
```

- [ ] **Step 9: 运行测试**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-save.test.mjs tests/edit-utils.test.mjs tests/edit-commands.test.mjs
```
Expected: PASS。

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-structure.test.mjs
```
Expected: PASS。**不要提交。**

---

## Task 11: 单视频预览与可编辑时间线

**Files:**
- Rewrite: `frontend/app/components/edit/EditPreview.vue`
- Rewrite: `frontend/app/components/edit/EditTimeline.vue`
- Modify: `frontend/tests/edit-structure.test.mjs`

**Interfaces:**
- `EditPreview` props：`src/poster/plan/activeClipId/clipKey/sourceMs/currentMs/durationMs/fps/playing/audioMode/playbackRate`；emits：`toggle/seek/step/ended/error`；暴露：`seek(ms)`、`sync(ms)`、`play()`、`pause()`。
- `EditTimeline` props：`plan/layout/currentMs/selectedClipId/selectedCueId/readonly/audioMode`；emits：`seek/select-clip/select-cue/move-clip/trim-clip/split-clip/move-cue/remove-transition`。
- 规则：整个剪辑页只有一个 `<video>`，没有原生 `controls`；时间线不包含第二个播放器或第二套传输层。

- [ ] **Step 1: 写结构测试**

在 `frontend/tests/edit-structure.test.mjs` 的第一个测试中，把 `assert.match(components[3], /timeline_start_ms/)` 之前插入：

```js
  assert.doesNotMatch(components[2], /<video[^>]*\bcontrols\b/)
  assert.match(components[2], /defineExpose\(\{\s*seek/)
  assert.match(components[3], /pointerdown/)
  assert.match(components[3], /move-clip/)
  assert.match(components[3], /trim-clip/)
  assert.match(components[3], /split-clip/)
  assert.match(components[3], /move-cue/)
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-structure.test.mjs
```
Expected: FAIL，新的时间线交互断言不满足。

- [ ] **Step 3: 重写 `EditPreview.vue`**

```vue
<template>
  <figure class="ed-preview">
    <div class="ed-preview-frame" :class="{ 'is-empty': !src }">
      <video
        ref="videoRef"
        :src="src || undefined"
        :poster="poster || undefined"
        playsinline
        preload="metadata"
        @loadedmetadata="onLoadedMetadata"
        @ended="$emit('ended')"
        @error="$emit('error', $event)"
        @click="$emit('toggle')"
      />
      <div v-if="!src" class="ed-preview-empty">
        <Clapperboard :size="26" />
        <span>{{ t('edit.noPreview') }}</span>
      </div>
      <span v-if="activeLabel" class="ed-preview-badge">{{ activeLabel }}</span>
    </div>

    <div class="ed-transport">
      <button
        class="ed-transport-btn"
        type="button"
        :title="playing ? t('edit.pause') : t('edit.play')"
        @click="$emit('toggle')"
      >
        <Pause v-if="playing" :size="15" />
        <Play v-else :size="15" />
      </button>
      <button class="ed-transport-btn" type="button" :title="t('edit.stepBack')" @click="$emit('step', -1)">
        <SkipBack :size="14" />
      </button>
      <button class="ed-transport-btn" type="button" :title="t('edit.stepForward')" @click="$emit('step', 1)">
        <SkipForward :size="14" />
      </button>
      <span class="ed-clock">
        <b>{{ formatPrecise(currentMs) }}</b>
        <i>/</i>
        <span>{{ formatPrecise(durationMs) }}</span>
      </span>
      <input
        class="ed-scrub"
        type="range"
        min="0"
        :max="Math.max(1, durationMs)"
        step="10"
        :value="Math.min(currentMs, Math.max(1, durationMs))"
        @input="onScrub"
      />
      <span class="ed-meta">{{ fps }} fps</span>
      <span v-if="audioMode === 'video'" class="ed-audio">{{ t('edit.audioModeVideo') }}</span>
    </div>
  </figure>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Clapperboard, Pause, Play, SkipBack, SkipForward } from 'lucide-vue-next'
import { formatPrecise } from '~/utils/edit-timecode'

const props = defineProps({
  src: { type: String, default: '' },
  poster: { type: String, default: '' },
  plan: { type: Object, default: () => ({ clips: [] }) },
  activeClipId: { type: String, default: '' },
  clipKey: { type: String, default: '' },
  sourceMs: { type: Number, default: 0 },
  currentMs: { type: Number, default: 0 },
  durationMs: { type: Number, default: 0 },
  fps: { type: Number, default: 30 },
  playing: { type: Boolean, default: false },
  audioMode: { type: String, default: 'none' },
  playbackRate: { type: Number, default: 1 },
})
const emit = defineEmits(['toggle', 'seek', 'step', 'ended', 'error'])
const { t } = useI18n()
const videoRef = ref(null)

const activeClip = computed(() => (
  props.plan.clips.find((clip) => clip.id === props.activeClipId) ?? null
))
const activeLabel = computed(() => {
  if (!activeClip.value) return ''
  return activeClip.value.source?.label
    || (activeClip.value.source?.kind === 'episode-video' ? t('edit.sourceEpisodeVideo') : t('edit.clip'))
})

function applySourceTime() {
  const video = videoRef.value
  if (!video) return
  const seconds = Math.max(0, Number(props.sourceMs) || 0) / 1000
  const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : seconds
  try {
    video.currentTime = Math.min(seconds, limit)
  } catch {
    // 元数据未就绪时由 loadedmetadata 再同步
  }
}

function applyPlaybackRate() {
  const video = videoRef.value
  if (!video) return
  const rate = Math.min(4, Math.max(0.25, Number(props.playbackRate) || 1))
  try {
    video.playbackRate = rate
  } catch {
    // 某些浏览器在元数据就绪前拒绝设置速率，loadedmetadata 会再次应用
  }
}

function onLoadedMetadata() {
  applyPlaybackRate()
  applySourceTime()
  if (props.playing) void videoRef.value?.play().catch(() => {})
}

function seek(ms) {
  const video = videoRef.value
  if (!video) return
  const seconds = Math.max(0, Number(ms) || 0) / 1000
  const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : seconds
  try {
    video.currentTime = Math.min(seconds, limit)
  } catch {
    // 忽略未加载完成的定位，clipKey 变化后会重新同步
  }
}

function play() {
  applyPlaybackRate()
  void videoRef.value?.play().catch(() => {})
}

function pause() {
  videoRef.value?.pause()
}

function onScrub(event) {
  emit('seek', Number(event.target.value) || 0)
}

watch(
  () => [props.clipKey, props.src],
  async () => {
    await nextTick()
    const video = videoRef.value
    if (!video) return
    try {
      video.load()
    } catch {
      // 无源时 load 会抛错，等待下一次 clipKey
    }
  },
)

watch(
  () => props.playbackRate,
  () => applyPlaybackRate(),
)

watch(
  () => props.playing,
  (value) => {
    if (value) play()
    else pause()
  },
)

defineExpose({ seek, sync: seek, play, pause })
</script>

<style scoped>
.ed-preview { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; margin: 0; }
.ed-preview-frame {
  position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); border-radius: 12px; background: #0b0c0e; overflow: hidden;
}
.ed-preview video { width: 100%; height: 100%; max-height: 100%; object-fit: contain; background: #0b0c0e; cursor: pointer; }
.ed-preview-empty {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 8px; color: var(--text-3); font-size: 12px;
}
.ed-preview-badge {
  position: absolute; left: 10px; top: 10px; max-width: 60%; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; padding: 3px 8px; border-radius: 999px;
  background: rgba(0, 0, 0, .58); color: #fff; font-size: 10px; pointer-events: none;
}
.ed-transport {
  flex: 0 0 auto; height: 38px; display: flex; align-items: center; gap: 8px;
  padding: 0 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-1);
}
.ed-transport-btn {
  width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--text-1); cursor: pointer;
}
.ed-transport-btn:hover { background: var(--bg-hover); }
.ed-clock { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-2); white-space: nowrap; }
.ed-clock b { color: var(--text-0); font-variant-numeric: tabular-nums; }
.ed-clock i { font-style: normal; color: var(--text-3); }
.ed-scrub { flex: 1; min-width: 80px; accent-color: var(--accent); }
.ed-meta { font-size: 10px; color: var(--text-3); white-space: nowrap; }
.ed-audio { font-size: 10px; color: var(--text-2); white-space: nowrap; }
@media (max-width: 900px) {
  .ed-audio { display: none; }
}
</style>
```

- [ ] **Step 4: 重写 `EditTimeline.vue`**

```vue
<template>
  <section class="ed-timeline">
    <header class="ed-timeline-head">
      <b>{{ t('edit.timeline') }}</b>
      <span>{{ t('edit.clipCount', { n: plan.clips.length }) }}</span>
      <span>{{ t('edit.duration') }} {{ formatPrecise(layout.duration_ms) }}</span>
      <div class="ed-timeline-tools">
        <button class="ed-tool" type="button" :title="t('edit.snap')" :class="{ 'is-on': snapEnabled }" @click="snapEnabled = !snapEnabled">
          <Magnet :size="13" />
        </button>
        <button class="ed-tool" type="button" :title="t('edit.zoomOut')" @click="setZoom(zoom / 1.5)">
          <ZoomOut :size="13" />
        </button>
        <span class="ed-zoom">{{ Math.round(zoom * 100) }}%</span>
        <button class="ed-tool" type="button" :title="t('edit.zoomIn')" @click="setZoom(zoom * 1.5)">
          <ZoomIn :size="13" />
        </button>
        <button class="ed-tool" type="button" :title="t('edit.split')" :disabled="!canSplit" @click="splitAtPlayhead">
          <Scissors :size="13" />
        </button>
      </div>
    </header>

    <div class="ed-timeline-body">
      <div class="ed-tl-heads">
        <span class="ed-head is-ruler"></span>
        <span class="ed-head">{{ t('edit.videoTrack') }}</span>
        <span class="ed-head">{{ t('edit.subtitleTrack') }}</span>
        <span class="ed-head">{{ t('edit.audioTrack') }}</span>
      </div>

      <div ref="scrollRef" class="ed-tl-scroll">
        <div class="ed-tl-stage" :style="{ width: `${stageWidth}px` }">
          <div class="ed-tl-ruler" @pointerdown="onRulerDown">
            <span
              v-for="tick in ticks"
              :key="tick.ms"
              class="ed-tick"
              :style="{ left: `${tick.left}px` }"
            >{{ tick.label }}</span>
          </div>

          <div class="ed-tl-track is-video" @pointerdown.self="onTrackDown">
            <div
              v-for="view in clipViews"
              :key="view.clip_id"
              class="ed-tl-clip"
              :class="{
                'is-selected': view.clip_id === selectedClipId,
                'is-dragging': drag?.kind === 'move' && drag?.clipId === view.clip_id,
              }"
              :style="clipStyle(view)"
              @pointerdown.stop="startDrag($event, 'move', { clipId: view.clip_id })"
            >
              <span class="ed-tl-clip-label">{{ view.label }}</span>
              <span class="ed-tl-clip-time">{{ formatPrecise(view.content_duration_ms) }}</span>
              <span
                v-if="!readonly"
                class="ed-trim is-start"
                @pointerdown.stop="startDrag($event, 'trim-start', { clipId: view.clip_id, edgeMs: view.timeline_start_ms })"
              ></span>
              <span
                v-if="!readonly"
                class="ed-trim is-end"
                @pointerdown.stop="startDrag($event, 'trim-end', { clipId: view.clip_id, edgeMs: view.timeline_end_ms })"
              ></span>
            </div>
            <p v-if="!clipViews.length" class="ed-tl-empty">{{ t('edit.timelineEmpty') }}</p>
          </div>

          <div class="ed-tl-track is-subtitle">
            <div
              v-for="cue in cueViews"
              :key="cue.id"
              class="ed-tl-cue"
              :class="{ 'is-selected': cue.id === selectedCueId, 'is-follow': cue.follow }"
              :style="{ left: `${cue.left}px`, width: `${cue.width}px` }"
              @pointerdown.stop="startDrag($event, 'cue', { cueId: cue.id, startMs: cue.startMs, endMs: cue.endMs })"
            >
              <span>{{ cue.text }}</span>
            </div>
            <p v-if="!cueViews.length" class="ed-tl-empty">{{ t('edit.subtitleEmpty') }}</p>
          </div>

          <div class="ed-tl-track is-audio">
            <div v-if="audioMode === 'video'" class="ed-tl-audio-bar">
              <Link2 :size="11" />
              <span>{{ t('edit.audioModeVideo') }}</span>
            </div>
            <p v-else class="ed-tl-empty">{{ t('edit.audioModeNone') }}</p>
          </div>

          <div
            v-for="transition in transitionViews"
            :key="transition.id"
            class="ed-tl-transition"
            :style="{ left: `${transition.left}px` }"
            :title="t('edit.transition')"
          >
            <span>⇄</span>
            <button
              v-if="!readonly"
              type="button"
              :title="t('edit.removeTransition')"
              @pointerdown.stop
              @click.stop="$emit('remove-transition', transition.id)"
            >×</button>
          </div>

          <div class="ed-tl-playhead" :style="{ left: `${playheadLeft}px` }"></div>
          <div
            v-if="snapLine !== null"
            class="ed-tl-snapline"
            :style="{ left: `${pad + snapLine * pxPerMs}px` }"
          ></div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Link2, Magnet, Scissors, ZoomIn, ZoomOut } from 'lucide-vue-next'
import { formatClock } from '~/utils/edit-plan'
import { formatPrecise } from '~/utils/edit-timecode'
import { activeClipIndex } from '~/utils/edit-layout'
import { collectSnapPoints, snapTime } from '~/utils/edit-snap'

const props = defineProps({
  plan: { type: Object, required: true },
  layout: { type: Object, required: true },
  currentMs: { type: Number, default: 0 },
  selectedClipId: { type: String, default: '' },
  selectedCueId: { type: String, default: '' },
  readonly: { type: Boolean, default: false },
  audioMode: { type: String, default: 'none' },
})
const emit = defineEmits([
  'seek', 'select-clip', 'select-cue', 'move-clip', 'trim-clip',
  'split-clip', 'move-cue', 'remove-transition',
])
const { t } = useI18n()

const scrollRef = ref(null)
const zoom = ref(1)
const snapEnabled = ref(true)
const pad = 24
const drag = ref(null)
const snapLine = ref(null)

const pxPerMs = computed(() => 0.04 * zoom.value)
const duration = computed(() => Math.max(1000, Number(props.layout.duration_ms) || 0))
const stageWidth = computed(() => Math.max(640, duration.value * pxPerMs.value + pad * 2))
const playheadLeft = computed(() => (
  pad + Math.min(duration.value, Math.max(0, Number(props.currentMs) || 0)) * pxPerMs.value
))

const tickStep = computed(() => {
  const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000]
  return steps.find((step) => step * pxPerMs.value >= 70) ?? 60000
})

const ticks = computed(() => {
  const result = []
  for (let ms = 0; ms <= duration.value; ms += tickStep.value) {
    result.push({ ms, left: pad + ms * pxPerMs.value, label: formatClock(ms) })
  }
  return result
})

const clipViews = computed(() => props.layout.clips.map((item) => {
  const clip = props.plan.clips.find((candidate) => candidate.id === item.clip_id)
  const label = clip?.source?.label
    || (clip?.source?.kind === 'episode-video' ? t('edit.sourceEpisodeVideo') : t('edit.clip'))
  return {
    ...item,
    label,
    left: pad + item.timeline_start_ms * pxPerMs.value,
    width: Math.max(4, (item.timeline_end_ms - item.timeline_start_ms) * pxPerMs.value),
  }
}))

const cueViews = computed(() => props.plan.subtitles.map((cue) => ({
  ...cue,
  left: pad + Math.max(0, cue.startMs) * pxPerMs.value,
  width: Math.max(3, (cue.endMs - cue.startMs) * pxPerMs.value),
})))

const transitionViews = computed(() => props.layout.transitions.map((transition) => {
  const to = props.layout.clips.find((clip) => clip.clip_id === transition.to_clip_id)
  return { ...transition, left: pad + (to?.timeline_start_ms ?? 0) * pxPerMs.value }
}))

const activeIndex = computed(() => activeClipIndex(props.layout, props.currentMs))
const activeClip = computed(() => props.plan.clips[activeIndex.value] ?? null)
const activeLayoutClip = computed(() => props.layout.clips[activeIndex.value] ?? null)
const canSplit = computed(() => Boolean(
  !props.readonly
  && activeClip.value
  && activeLayoutClip.value
  && props.currentMs - activeLayoutClip.value.timeline_start_ms > 100
  && activeLayoutClip.value.timeline_end_ms - props.currentMs > 100,
))

function clipStyle(view) {
  if (drag.value?.kind === 'move' && drag.value.clipId === view.clip_id) {
    return { left: `${view.left}px`, width: `${view.width}px`, transform: `translateX(${drag.value.currentX - drag.value.startX}px)` }
  }
  if (drag.value?.kind === 'trim-start' && drag.value.clipId === view.clip_id) {
    const delta = drag.value.currentX - drag.value.startX
    return { left: `${view.left + delta}px`, width: `${Math.max(4, view.width - delta)}px` }
  }
  if (drag.value?.kind === 'trim-end' && drag.value.clipId === view.clip_id) {
    const delta = drag.value.currentX - drag.value.startX
    return { left: `${view.left}px`, width: `${Math.max(4, view.width + delta)}px` }
  }
  return { left: `${view.left}px`, width: `${view.width}px` }
}

function setZoom(value) {
  zoom.value = Math.max(0.25, Math.min(8, Number(value) || 1))
}

function snapTarget(targetMs, excludeCueId = '') {
  if (!snapEnabled.value) return { ms: Math.round(targetMs), point: null }
  const points = collectSnapPoints(props.plan, props.layout, props.currentMs)
    .filter((point) => {
      if (!excludeCueId) return true
      const cue = props.plan.subtitles.find((item) => item.id === excludeCueId)
      if (!cue) return true
      const own = (point.kind === 'cue-start' && point.ms === cue.startMs)
        || (point.kind === 'cue-end' && point.ms === cue.endMs)
      return !own
    })
  return snapTime(targetMs, points, 8 / pxPerMs.value)
}

function seekAt(clientX) {
  const scroll = scrollRef.value
  if (!scroll) return
  const rect = scroll.getBoundingClientRect()
  const x = clientX - rect.left + scroll.scrollLeft
  const ms = Math.max(0, Math.min(duration.value, (x - pad) / pxPerMs.value))
  emit('seek', Math.round(ms))
}

function onRulerDown(event) {
  startDrag(event, 'playhead')
  seekAt(event.clientX)
}

function onTrackDown(event) {
  if (event.target !== event.currentTarget) return
  startDrag(event, 'playhead')
  seekAt(event.clientX)
}

function startDrag(event, kind, payload = {}) {
  if (props.readonly && kind !== 'playhead') return
  if (event.button !== undefined && event.button !== 0) return
  event.preventDefault()
  drag.value = {
    kind,
    startX: event.clientX,
    currentX: event.clientX,
    ...payload,
  }
  if (payload.clipId) emit('select-clip', payload.clipId)
  if (payload.cueId) emit('select-cue', payload.cueId)
}

function onPointerMove(event) {
  if (!drag.value) return
  drag.value = { ...drag.value, currentX: event.clientX }
  if (drag.value.kind === 'playhead') seekAt(event.clientX)
}

function onPointerUp() {
  const state = drag.value
  drag.value = null
  snapLine.value = null
  if (!state) return
  const deltaPx = state.currentX - state.startX
  const deltaMs = deltaPx / pxPerMs.value
  if (state.kind === 'move') {
    if (Math.abs(deltaPx) < 3) return
    const views = clipViews.value
    const dragged = views.find((view) => view.clip_id === state.clipId)
    if (!dragged) return
    const center = dragged.left + dragged.width / 2 + deltaPx
    let targetIndex = views.findIndex((view) => center < view.left + view.width / 2)
    if (targetIndex < 0) targetIndex = views.length - 1
    emit('move-clip', { clipId: state.clipId, targetIndex })
    return
  }
  if (state.kind === 'trim-start' || state.kind === 'trim-end') {
    if (Math.abs(deltaPx) < 2) return
    const snapped = snapTarget(state.edgeMs + deltaMs)
    if (snapped.point) snapLine.value = snapped.point.ms
    emit('trim-clip', {
      clipId: state.clipId,
      edge: state.kind === 'trim-start' ? 'start' : 'end',
      deltaMs: Math.round(snapped.ms - state.edgeMs),
    })
    return
  }
  if (state.kind === 'cue') {
    if (Math.abs(deltaPx) < 2) return
    const snapped = snapTarget(state.startMs + deltaMs, state.cueId)
    if (snapped.point) snapLine.value = snapped.point.ms
    emit('move-cue', { cueId: state.cueId, startMs: Math.max(0, Math.round(snapped.ms)) })
  }
}

function splitAtPlayhead() {
  if (!canSplit.value || !activeClip.value || !activeLayoutClip.value) return
  emit('split-clip', {
    clipId: activeClip.value.id,
    atMs: Math.round(props.currentMs - activeLayoutClip.value.timeline_start_ms),
  })
}

onMounted(() => {
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
})
</script>

<style scoped>
.ed-timeline {
  flex: 0 0 auto; min-height: 196px; display: flex; flex-direction: column; gap: 6px;
  padding: 8px 10px 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-1);
}
.ed-timeline-head { display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--text-3); }
.ed-timeline-head b { color: var(--text-1); font-size: 12px; }
.ed-timeline-tools { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; }
.ed-tool {
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2);
  color: var(--text-2); cursor: pointer;
}
.ed-tool:hover { color: var(--text-0); border-color: var(--accent); }
.ed-tool.is-on { color: var(--accent-text); border-color: var(--accent); background: var(--accent-bg); }
.ed-tool:disabled { opacity: .4; cursor: not-allowed; }
.ed-zoom { min-width: 36px; text-align: center; font-size: 10px; color: var(--text-3); }
.ed-timeline-body { flex: 1; min-height: 0; display: flex; gap: 6px; }
.ed-tl-heads { flex: 0 0 46px; display: flex; flex-direction: column; font-size: 9px; color: var(--text-3); }
.ed-head { display: flex; align-items: center; border-bottom: 1px solid transparent; }
.ed-head.is-ruler { height: 22px; }
.ed-head:nth-child(2) { height: 56px; }
.ed-head:nth-child(3) { height: 30px; }
.ed-head:nth-child(4) { height: 22px; }
.ed-tl-scroll { flex: 1; min-width: 0; overflow-x: auto; overflow-y: hidden; }
.ed-tl-stage { position: relative; height: 130px; user-select: none; }
.ed-tl-ruler {
  position: absolute; inset: 0 0 auto; height: 22px; cursor: ew-resize;
  border-bottom: 1px solid var(--border); background: var(--bg-2);
}
.ed-tick {
  position: absolute; top: 4px; transform: translateX(-50%);
  font-size: 9px; color: var(--text-3); white-space: nowrap; pointer-events: none;
}
.ed-tl-track { position: absolute; left: 0; right: 0; border-radius: 6px; background: var(--bg-2); }
.ed-tl-track.is-video { top: 24px; height: 56px; }
.ed-tl-track.is-subtitle { top: 84px; height: 30px; background: color-mix(in srgb, var(--bg-2) 82%, transparent); }
.ed-tl-track.is-audio { top: 118px; height: 22px; }
.ed-tl-clip {
  position: absolute; top: 3px; bottom: 3px; min-width: 4px; overflow: hidden;
  display: flex; flex-direction: column; justify-content: space-between;
  padding: 4px 8px; border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
  border-radius: 6px; background: color-mix(in srgb, var(--accent) 16%, var(--bg-1));
  color: var(--text-0); cursor: grab;
}
.ed-tl-clip:hover { border-color: var(--accent); }
.ed-tl-clip.is-selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ed-tl-clip.is-dragging { opacity: .82; cursor: grabbing; z-index: 4; }
.ed-tl-clip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; font-weight: 600; pointer-events: none; }
.ed-tl-clip-time { font-size: 9px; color: var(--text-2); pointer-events: none; }
.ed-trim {
  position: absolute; top: 0; bottom: 0; width: 7px; cursor: ew-resize;
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}
.ed-trim.is-start { left: 0; border-radius: 6px 0 0 6px; }
.ed-trim.is-end { right: 0; border-radius: 0 6px 6px 0; }
.ed-tl-cue {
  position: absolute; top: 3px; bottom: 3px; min-width: 3px; overflow: hidden;
  display: flex; align-items: center; padding: 0 6px; border-radius: 4px;
  border: 1px solid color-mix(in srgb, #d7a24a 55%, transparent);
  background: color-mix(in srgb, #d7a24a 20%, var(--bg-1));
  color: var(--text-0); font-size: 9px; white-space: nowrap; cursor: ew-resize;
}
.ed-tl-cue.is-follow { border-style: dashed; }
.ed-tl-cue.is-selected { box-shadow: 0 0 0 1px #d7a24a; }
.ed-tl-audio-bar {
  position: absolute; inset: 3px; display: flex; align-items: center; gap: 5px;
  padding: 0 8px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--success) 40%, transparent);
  background: color-mix(in srgb, var(--success) 13%, var(--bg-1));
  color: var(--text-2); font-size: 9px; overflow: hidden; white-space: nowrap;
}
.ed-tl-transition {
  position: absolute; top: 48px; transform: translateX(-50%); z-index: 3;
  display: inline-flex; align-items: center; gap: 1px; height: 18px; padding: 0 3px;
  border-radius: 5px; background: var(--bg-0); border: 1px solid var(--border);
  color: var(--text-2); font-size: 10px;
}
.ed-tl-transition button {
  width: 14px; height: 14px; padding: 0; border: 0; border-radius: 3px;
  background: transparent; color: var(--text-3); cursor: pointer; line-height: 1;
}
.ed-tl-transition button:hover { background: var(--bg-hover); color: var(--danger); }
.ed-tl-playhead {
  position: absolute; top: 18px; bottom: 0; width: 2px; margin-left: -1px;
  background: var(--accent); pointer-events: none; z-index: 5;
}
.ed-tl-playhead::before {
  content: ''; position: absolute; left: -4px; top: -2px;
  border: 5px solid transparent; border-top-color: var(--accent);
}
.ed-tl-snapline {
  position: absolute; top: 22px; bottom: 0; width: 1px; background: #d7a24a;
  pointer-events: none; z-index: 4;
}
.ed-tl-empty {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  margin: 0; font-size: 9px; color: var(--text-3); pointer-events: none;
}
</style>
```

- [ ] **Step 5: 运行结构测试**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-structure.test.mjs
```
Expected: PASS，且只存在一个 `<video>`。

- [ ] **Step 6: 运行工具与命令测试回归**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-utils.test.mjs tests/edit-commands.test.mjs tests/edit-save.test.mjs
```
Expected: PASS。**不要提交。**

---

## Task 12: 素材库、片段检查器、版本抽屉与冲突对话框

**Files:**
- Create: `frontend/app/components/edit/EditMediaLibrary.vue`
- Rewrite: `frontend/app/components/edit/EditClipInspector.vue`
- Create: `frontend/app/components/edit/EditRevisionsDrawer.vue`
- Create: `frontend/app/components/edit/EditConflictDialog.vue`
- Modify: `frontend/tests/edit-structure.test.mjs`

**Interfaces:**
- `EditMediaLibrary` props：`media/loading/error/readonly/usedStoryboardIds/roughCutAvailable`；emits：`add-storyboard/add-all/rough-cut/retry`。
- `EditClipInspector` props：`plan/layout/clipId/placement/state/currentMs/readonly`；emits：`trim-start/trim-end/speed/gap/fades/split/remove`。
- `EditRevisionsDrawer` props：`open/revisions/loading/draftDirty/canEdit`；emits：`close/refresh/create/restore`。
- `EditConflictDialog` props：`conflict/loading`；emits：`reload/overwrite/copy`。

- [ ] **Step 1: 写结构测试**

在 `frontend/tests/edit-structure.test.mjs` 末尾追加：

```js
test('S2 素材库、检查器、版本与冲突组件结构', () => {
  const media = read('app/components/edit/EditMediaLibrary.vue')
  assert.match(media, /add-storyboard/)
  assert.match(media, /add-all/)
  assert.match(media, /rough-cut/)
  assert.match(media, /edit\.mediaLibrary/)

  const inspector = read('app/components/edit/EditClipInspector.vue')
  assert.match(inspector, /trim-start/)
  assert.match(inspector, /trim-end/)
  assert.match(inspector, /hashes\.plan_hash/)
  assert.match(inspector, /linePlacement/)

  const revisions = read('app/components/edit/EditRevisionsDrawer.vue')
  assert.match(revisions, /revisions/)
  assert.match(revisions, /restore/)
  assert.match(revisions, /edit\.versionTitle/)

  const conflict = read('app/components/edit/EditConflictDialog.vue')
  assert.match(conflict, /current_version/)
  assert.match(conflict, /EDIT_VERSION_CONFLICT/)

  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    for (const key of ['mediaLibrary', 'versionTitle', 'conflictTitle', 'deleteClip', 'roughCut']) {
      assert.equal(typeof locale.edit?.[key], 'string', `${lang} 缺少 edit.${key}`)
    }
  }
})
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-structure.test.mjs
```
Expected: FAIL，`Cannot read ... EditMediaLibrary.vue`。

- [ ] **Step 3: 创建 `EditMediaLibrary.vue`**

```vue
<template>
  <aside class="ed-media">
    <header class="ed-media-head">
      <b>{{ t('edit.mediaLibrary') }}</b>
      <button class="ed-media-icon" type="button" :title="t('edit.retry')" @click="$emit('retry')">
        <RefreshCw :size="13" />
      </button>
    </header>

    <div class="ed-media-tabs">
      <button type="button" :class="{ 'is-on': tab === 'storyboards' }" @click="tab = 'storyboards'">
        {{ t('edit.mediaStoryboards') }}
      </button>
      <button type="button" :class="{ 'is-on': tab === 'lines' }" @click="tab = 'lines'">
        {{ t('edit.mediaLines') }}
      </button>
      <button type="button" :class="{ 'is-on': tab === 'takes' }" @click="tab = 'takes'">
        {{ t('edit.mediaTakes') }}
      </button>
    </div>

    <input v-model="query" class="ed-media-search" type="search" :placeholder="t('edit.searchMedia')" />

    <div class="ed-media-body">
      <p v-if="loading" class="ed-media-state">{{ t('edit.mediaLoading') }}</p>
      <div v-else-if="error" class="ed-media-state">
        <span>{{ error }}</span>
        <button type="button" @click="$emit('retry')">{{ t('edit.retry') }}</button>
      </div>

      <template v-else-if="tab === 'storyboards'">
        <article v-for="item in filteredStoryboards" :key="item.id" class="ed-media-row">
          <div class="ed-media-thumb">
            <img v-if="item.thumbnail_url" :src="mediaUrl(item.thumbnail_url)" :alt="item.title || ''" />
            <Film v-else :size="16" />
          </div>
          <div class="ed-media-info">
            <b>{{ t('edit.storyboardN', { n: item.number }) }}</b>
            <span>{{ item.title || t('edit.untitled') }}</span>
            <small>
              <template v-if="item.playable">{{ formatClock(item.source?.durationMs || 0) }}</template>
              <template v-else>{{ item.error || t('edit.mediaUnavailable') }}</template>
            </small>
          </div>
          <button
            class="ed-media-add"
            type="button"
            :title="usedStoryboardIds.includes(item.id) ? t('edit.alreadyAdded') : t('edit.addToTimeline')"
            :disabled="readonly || !item.playable || usedStoryboardIds.includes(item.id)"
            @click="$emit('add-storyboard', item)"
          >
            <Check v-if="usedStoryboardIds.includes(item.id)" :size="13" />
            <Plus v-else :size="13" />
          </button>
        </article>
        <p v-if="!filteredStoryboards.length" class="ed-media-state">{{ t('edit.mediaEmpty') }}</p>
      </template>

      <template v-else-if="tab === 'lines'">
        <article v-for="line in filteredLines" :key="line.id" class="ed-media-row is-line">
          <div class="ed-media-info">
            <b>{{ line.speaker_name || t('edit.narration') }}</b>
            <span>{{ line.text }}</span>
            <small>{{ line.status }} · {{ formatClock(line.duration_ms || 0) }}</small>
          </div>
        </article>
        <p v-if="!filteredLines.length" class="ed-media-state">{{ t('edit.mediaEmpty') }}</p>
      </template>

      <template v-else>
        <article v-for="take in filteredTakes" :key="take.id" class="ed-media-row is-line">
          <div class="ed-media-info">
            <b>{{ take.speaker_name || t('edit.narration') }} · v{{ take.take_no }}</b>
            <span>{{ take.text }}</span>
            <small>{{ formatClock(take.duration_ms || 0) }}</small>
          </div>
        </article>
        <p v-if="!filteredTakes.length" class="ed-media-state">{{ t('edit.mediaEmpty') }}</p>
      </template>
    </div>

    <footer class="ed-media-foot">
      <p v-if="!media?.import_enabled" class="ed-media-note">{{ t('edit.importDisabled') }}</p>
      <div class="ed-media-actions">
        <button
          class="ed-media-btn is-primary"
          type="button"
          :disabled="readonly || !playableUnused.length"
          @click="$emit('add-all')"
        >
          {{ t('edit.addAll') }}
        </button>
        <button
          class="ed-media-btn"
          type="button"
          :disabled="readonly || !roughCutAvailable"
          @click="$emit('rough-cut')"
        >
          {{ t('edit.roughCut') }}
        </button>
      </div>
    </footer>
  </aside>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Check, Film, Plus, RefreshCw } from 'lucide-vue-next'
import { formatClock, mediaUrl } from '~/utils/edit-plan'

const props = defineProps({
  media: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  readonly: { type: Boolean, default: false },
  usedStoryboardIds: { type: Array, default: () => [] },
  roughCutAvailable: { type: Boolean, default: false },
})
defineEmits(['add-storyboard', 'add-all', 'rough-cut', 'retry'])
const { t } = useI18n()
const tab = ref('storyboards')
const query = ref('')

function match(value) {
  const text = String(value || '').toLowerCase()
  return !query.value.trim() || text.includes(query.value.trim().toLowerCase())
}

const filteredStoryboards = computed(() => (props.media?.storyboards ?? []).filter(
  (item) => match(item.title) || match(item.number),
))
const filteredLines = computed(() => (props.media?.lines ?? []).filter(
  (item) => match(item.text) || match(item.speaker_name),
))
const filteredTakes = computed(() => (props.media?.video_takes ?? []).filter(
  (item) => match(item.text) || match(item.speaker_name),
))
const playableUnused = computed(() => (props.media?.storyboards ?? []).filter(
  (item) => item.playable && !props.usedStoryboardIds.includes(item.id),
))
</script>

<style scoped>
.ed-media {
  min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 8px;
  border-right: 1px solid var(--border); background: var(--bg-1);
}
.ed-media-head {
  flex: 0 0 auto; height: 42px; padding: 0 12px; display: flex; align-items: center;
  justify-content: space-between; border-bottom: 1px solid var(--border);
}
.ed-media-head b { font-size: 12px; color: var(--text-0); }
.ed-media-icon {
  width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); color: var(--text-2); cursor: pointer;
}
.ed-media-tabs { flex: 0 0 auto; display: flex; gap: 4px; padding: 0 10px; }
.ed-media-tabs button {
  flex: 1; height: 26px; border: 1px solid transparent; border-radius: 7px;
  background: transparent; color: var(--text-3); font-size: 10px; cursor: pointer;
}
.ed-media-tabs button.is-on { background: var(--bg-2); color: var(--text-0); border-color: var(--border); }
.ed-media-search {
  flex: 0 0 auto; margin: 0 10px; height: 28px; padding: 0 8px;
  border: 1px solid var(--border); border-radius: 7px; background: var(--bg-2); color: var(--text-0); font-size: 11px;
}
.ed-media-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px; display: flex; flex-direction: column; gap: 6px; }
.ed-media-row {
  display: flex; align-items: center; gap: 8px; padding: 6px; border-radius: 8px;
  border: 1px solid transparent; background: var(--bg-2);
}
.ed-media-row:hover { border-color: var(--border); }
.ed-media-row.is-line { align-items: flex-start; }
.ed-media-thumb {
  flex: 0 0 42px; height: 32px; display: flex; align-items: center; justify-content: center;
  overflow: hidden; border-radius: 5px; background: var(--bg-0); color: var(--text-3);
}
.ed-media-thumb img { width: 100%; height: 100%; object-fit: cover; }
.ed-media-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ed-media-info b { font-size: 10px; color: var(--text-0); }
.ed-media-info span {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--text-2);
}
.ed-media-info small { font-size: 9px; color: var(--text-3); }
.ed-media-add {
  flex: 0 0 24px; width: 24px; height: 24px; display: inline-flex; align-items: center;
  justify-content: center; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-1); color: var(--text-1); cursor: pointer;
}
.ed-media-add:disabled { opacity: .4; cursor: not-allowed; }
.ed-media-state {
  margin: 8px 0; padding: 12px 4px; display: flex; flex-direction: column; gap: 6px;
  align-items: center; justify-content: center; text-align: center; color: var(--text-3); font-size: 10px;
}
.ed-media-state button {
  height: 24px; padding: 0 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-1); color: var(--text-1); cursor: pointer; font-size: 10px;
}
.ed-media-foot { flex: 0 0 auto; padding: 8px 10px 10px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 6px; }
.ed-media-note { margin: 0; font-size: 9px; color: var(--text-3); }
.ed-media-actions { display: flex; gap: 6px; }
.ed-media-btn {
  flex: 1; height: 28px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--bg-2); color: var(--text-1); font-size: 10px; cursor: pointer;
}
.ed-media-btn.is-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.ed-media-btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
```

- [ ] **Step 4: 重写 `EditClipInspector.vue`**

```vue
<template>
  <aside class="ed-inspector">
    <template v-if="clip">
      <header class="ed-insp-head">
        <b>{{ clip.source?.label || t('edit.clip') }}</b>
        <span>{{ clip.source?.kind }}</span>
      </header>

      <section class="ed-insp-section">
        <h4>{{ t('edit.source') }}</h4>
        <dl class="ed-insp-grid">
          <div><dt>{{ t('edit.duration') }}</dt><dd>{{ formatPrecise(clip.source?.durationMs || 0) }}</dd></div>
          <div><dt>{{ t('edit.resolution') }}</dt><dd>{{ clip.source?.width }}×{{ clip.source?.height }}</dd></div>
          <div><dt>{{ t('edit.inOut') }}</dt><dd>{{ formatPrecise(clip.sourceInMs) }} – {{ formatPrecise(clip.sourceOutMs) }}</dd></div>
          <div><dt>{{ t('edit.speed') }}</dt><dd>{{ clip.speed.toFixed(2) }}×</dd></div>
        </dl>
        <div class="ed-insp-row" v-if="!readonly">
          <span>{{ t('edit.sourceIn') }}</span>
          <button type="button" @click="$emit('trim-start', 100)">+100</button>
          <button type="button" @click="$emit('trim-start', -100)">−100</button>
          <button type="button" @click="$emit('trim-start', 1000)">+1s</button>
          <button type="button" @click="$emit('trim-start', -1000)">−1s</button>
        </div>
        <div class="ed-insp-row" v-if="!readonly">
          <span>{{ t('edit.sourceOut') }}</span>
          <button type="button" @click="$emit('trim-end', 100)">+100</button>
          <button type="button" @click="$emit('trim-end', -100)">−100</button>
          <button type="button" @click="$emit('trim-end', 1000)">+1s</button>
          <button type="button" @click="$emit('trim-end', -1000)">−1s</button>
        </div>
      </section>

      <section class="ed-insp-section">
        <h4>{{ t('edit.timeline') }}</h4>
        <label class="ed-insp-field">
          <span>{{ t('edit.speed') }} {{ clip.speed.toFixed(2) }}×</span>
          <input
            type="range" min="0.25" max="4" step="0.05" :value="clip.speed" :disabled="readonly"
            @input="$emit('speed', Number($event.target.value))"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.gap') }}</span>
          <input
            type="number" min="0" max="300000" step="100" :value="clip.gapBeforeMs" :disabled="readonly"
            @change="$emit('gap', Number($event.target.value))"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.fadeIn') }}</span>
          <input
            type="number" min="0" max="1500" step="50" :value="clip.videoFadeInMs" :disabled="readonly"
            @change="$emit('fades', { inMs: Number($event.target.value), outMs: clip.videoFadeOutMs })"
          />
        </label>
        <label class="ed-insp-field">
          <span>{{ t('edit.fadeOut') }}</span>
          <input
            type="number" min="0" max="1500" step="50" :value="clip.videoFadeOutMs" :disabled="readonly"
            @change="$emit('fades', { inMs: clip.videoFadeInMs, outMs: Number($event.target.value) })"
          />
        </label>
      </section>

      <section v-if="placement" class="ed-insp-section">
        <h4>{{ t('edit.linePlacement') }}</h4>
        <dl class="ed-insp-grid">
          <div><dt>{{ t('edit.speaker') }}</dt><dd>{{ placement.speaker_name || t('edit.narration') }}</dd></div>
          <div><dt>{{ t('edit.duration') }}</dt><dd>{{ formatPrecise(placement.duration_ms) }}</dd></div>
        </dl>
        <p class="ed-insp-text">{{ placement.text }}</p>
        <p v-if="placement.overflows_clip" class="ed-insp-warn">
          {{ t('edit.lineOverflow', { ms: placement.overflow_ms }) }}
        </p>
      </section>

      <section class="ed-insp-section">
        <h4>{{ t('edit.actions') }}</h4>
        <div class="ed-insp-actions" v-if="!readonly">
          <button type="button" :disabled="!canSplit" @click="$emit('split', splitOffsetMs)">
            <Scissors :size="12" /> {{ t('edit.split') }}
          </button>
          <button class="is-danger" type="button" @click="$emit('remove', { ripple: true })">
            <Trash2 :size="12" /> {{ t('edit.deleteClip') }}
          </button>
          <button class="is-muted" type="button" @click="$emit('remove', { ripple: false })">
            {{ t('edit.deleteKeepGap') }}
          </button>
        </div>
        <p v-else class="ed-insp-text">{{ t('edit.readonlyEdit') }}</p>
      </section>
    </template>

    <div v-else class="ed-insp-empty">
      <MousePointer2 :size="20" />
      <p>{{ t('edit.noSelection') }}</p>
    </div>

    <section class="ed-insp-section">
      <h4>{{ t('edit.project') }}</h4>
      <dl class="ed-insp-grid">
        <div><dt>{{ t('edit.resolution') }}</dt><dd>{{ state.plan.project.width }}×{{ state.plan.project.height }}</dd></div>
        <div><dt>{{ t('edit.fps') }}</dt><dd>{{ state.plan.project.fps }}</dd></div>
        <div><dt>{{ t('edit.aspect') }}</dt><dd>{{ state.plan.project.aspect }}</dd></div>
        <div><dt>{{ t('edit.tailGap') }}</dt><dd>{{ formatClock(state.plan.project.tailGapMs) }}</dd></div>
      </dl>
    </section>

    <section class="ed-insp-section">
      <h4>{{ t('edit.hashes') }}</h4>
      <dl class="ed-insp-hashes">
        <div><dt>{{ t('edit.planHash') }}</dt><dd>{{ state.hashes.plan_hash }}</dd></div>
        <div><dt>{{ t('edit.editSyncHash') }}</dt><dd>{{ state.hashes.edit_sync_hash }}</dd></div>
        <div><dt>{{ t('edit.renderHash') }}</dt><dd>{{ state.hashes.render_hash }}</dd></div>
        <div><dt>{{ t('edit.dialogueSyncHash') }}</dt><dd>{{ state.hashes.dialogue_sync_hash }}</dd></div>
        <div><dt>{{ t('edit.subtitleHash') }}</dt><dd>{{ state.hashes.subtitle_hash }}</dd></div>
      </dl>
    </section>

    <section class="ed-insp-section">
      <h4>{{ t('edit.audio') }}</h4>
      <p class="ed-insp-text">
        {{ state.audio?.mode === 'video' ? t('edit.audioModeVideo') : t('edit.audioModeNone') }}
      </p>
    </section>

    <section class="ed-insp-section">
      <h4>{{ t('edit.warnings') }}</h4>
      <p v-if="!state.media_warnings?.length" class="ed-insp-text">{{ t('edit.noWarnings') }}</p>
      <ul v-else class="ed-insp-warnings">
        <li v-for="warning in state.media_warnings" :key="`${warning.code}-${warning.path}`">
          <b>{{ warning.code }}</b> {{ warning.message }}
        </li>
      </ul>
    </section>
  </aside>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { MousePointer2, Scissors, Trash2 } from 'lucide-vue-next'
import { formatClock } from '~/utils/edit-plan'
import { formatPrecise } from '~/utils/edit-timecode'

const props = defineProps({
  plan: { type: Object, required: true },
  layout: { type: Object, required: true },
  clipId: { type: String, default: '' },
  placement: { type: Object, default: null },
  state: { type: Object, required: true },
  currentMs: { type: Number, default: 0 },
  readonly: { type: Boolean, default: false },
})
defineEmits(['trim-start', 'trim-end', 'speed', 'gap', 'fades', 'split', 'remove'])
const { t } = useI18n()

const clip = computed(() => props.plan.clips.find((item) => item.id === props.clipId) ?? null)
const layoutClip = computed(() => (
  props.layout.clips.find((item) => item.clip_id === props.clipId) ?? null
))
const canSplit = computed(() => Boolean(
  layoutClip.value
  && props.currentMs - layoutClip.value.timeline_start_ms > 100
  && layoutClip.value.timeline_end_ms - props.currentMs > 100,
))
const splitOffsetMs = computed(() => (
  layoutClip.value ? Math.round(props.currentMs - layoutClip.value.timeline_start_ms) : 0
))
</script>

<style scoped>
.ed-inspector {
  min-width: 0; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
  gap: 10px; padding: 12px; border-left: 1px solid var(--border); background: var(--bg-1);
}
.ed-insp-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ed-insp-head b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.ed-insp-head span { flex: 0 0 auto; font-size: 9px; color: var(--text-3); }
.ed-insp-section { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--border); }
.ed-insp-section h4 { margin: 0; font-size: 10px; font-weight: 650; letter-spacing: .04em; color: var(--text-3); }
.ed-insp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 0; }
.ed-insp-grid div { min-width: 0; }
.ed-insp-grid dt { font-size: 9px; color: var(--text-3); }
.ed-insp-grid dd { margin: 0; overflow: hidden; text-overflow: ellipsis; font-size: 10px; color: var(--text-1); }
.ed-insp-row { display: flex; align-items: center; gap: 4px; }
.ed-insp-row span { flex: 1; font-size: 9px; color: var(--text-3); }
.ed-insp-row button, .ed-insp-actions button {
  height: 22px; padding: 0 6px; display: inline-flex; align-items: center; gap: 3px;
  border: 1px solid var(--border); border-radius: 5px; background: var(--bg-2);
  color: var(--text-1); font-size: 9px; cursor: pointer;
}
.ed-insp-row button:hover, .ed-insp-actions button:hover { border-color: var(--accent); }
.ed-insp-field { display: flex; flex-direction: column; gap: 3px; font-size: 9px; color: var(--text-3); }
.ed-insp-field input[type='range'] { width: 100%; accent-color: var(--accent); }
.ed-insp-field input[type='number'] {
  width: 100%; height: 26px; padding: 0 6px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-2); color: var(--text-0); font-size: 10px;
}
.ed-insp-text { margin: 0; font-size: 10px; color: var(--text-2); line-height: 1.5; }
.ed-insp-warn { margin: 0; font-size: 10px; color: var(--warning); line-height: 1.5; }
.ed-insp-actions { display: flex; flex-wrap: wrap; gap: 5px; }
.ed-insp-actions button.is-danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
.ed-insp-actions button.is-muted { color: var(--text-2); }
.ed-insp-actions button:disabled { opacity: .45; cursor: not-allowed; }
.ed-insp-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 8px; color: var(--text-3); }
.ed-insp-empty p { margin: 0; font-size: 10px; }
.ed-insp-hashes { display: flex; flex-direction: column; gap: 3px; margin: 0; }
.ed-insp-hashes div { display: flex; justify-content: space-between; gap: 8px; }
.ed-insp-hashes dt { flex: 0 0 auto; font-size: 9px; color: var(--text-3); }
.ed-insp-hashes dd {
  margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, monospace; font-size: 9px; color: var(--text-2);
}
.ed-insp-warnings { margin: 0; padding-left: 14px; display: flex; flex-direction: column; gap: 4px; }
.ed-insp-warnings li { font-size: 9px; color: var(--text-2); line-height: 1.4; }
.ed-insp-warnings b { color: var(--warning); font-weight: 600; }
</style>
```

- [ ] **Step 5: 创建 `EditRevisionsDrawer.vue`**

```vue
<template>
  <div v-if="open" class="ed-drawer-mask" @click.self="$emit('close')">
    <aside class="ed-drawer">
      <header class="ed-drawer-head">
        <b>{{ t('edit.versionTitle') }}</b>
        <button type="button" :title="t('edit.close')" @click="$emit('close')">×</button>
      </header>

      <div class="ed-drawer-create">
        <input v-model="note" type="text" :placeholder="t('edit.versionNote')" :disabled="!canEdit" />
        <button type="button" :disabled="!canEdit || creating" @click="submitCreate">
          {{ creating ? t('edit.saving') : t('edit.versionCreate') }}
        </button>
      </div>
      <p v-if="draftDirty" class="ed-drawer-dirty">{{ t('edit.versionDirty') }}</p>

      <div class="ed-drawer-body">
        <p v-if="loading" class="ed-drawer-state">{{ t('edit.loading') }}</p>
        <p v-else-if="!revisions.length" class="ed-drawer-state">{{ t('edit.versionEmpty') }}</p>
        <article
          v-for="revision in revisions"
          :key="revision.id"
          class="ed-revision"
          :class="{ 'is-current': revision.is_current }"
        >
          <div class="ed-revision-head">
            <b>v{{ revision.revision_no }}</b>
            <span v-if="revision.is_current" class="ed-revision-badge">{{ t('edit.versionCurrent') }}</span>
            <small>{{ formatTime(revision.created_at) }}</small>
          </div>
          <p class="ed-revision-note">{{ revision.note || t('edit.untitled') }}</p>
          <div class="ed-revision-meta">
            <span>{{ t('edit.clipCount', { n: revision.clip_count ?? 0 }) }}</span>
            <span>{{ formatClock(revision.duration_ms || 0) }}</span>
          </div>
          <button
            class="ed-revision-restore"
            type="button"
            :disabled="!canEdit || revision.is_current || restoringId === revision.id"
            @click="restore(revision)"
          >
            {{ restoringId === revision.id ? t('edit.saving') : t('edit.versionRestore') }}
          </button>
        </article>
      </div>
    </aside>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { formatClock } from '~/utils/edit-plan'

const props = defineProps({
  open: { type: Boolean, default: false },
  revisions: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  draftDirty: { type: Boolean, default: false },
  canEdit: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'refresh', 'create', 'restore'])
const { t } = useI18n()
const note = ref('')
const creating = ref(false)
const restoringId = ref(0)

async function submitCreate() {
  if (!props.canEdit || creating.value) return
  creating.value = true
  try {
    emit('create', note.value.trim())
    note.value = ''
  } finally {
    creating.value = false
  }
}

function restore(revision) {
  if (!props.canEdit || restoringId.value) return
  restoringId.value = revision.id
  try {
    emit('restore', revision)
  } finally {
    restoringId.value = 0
  }
}

function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

watch(
  () => props.open,
  (value) => {
    if (value) emit('refresh')
  },
)
</script>

<style scoped>
.ed-drawer-mask {
  position: fixed; inset: 0; z-index: 40; display: flex; justify-content: flex-end;
  background: rgba(0, 0, 0, .4);
}
.ed-drawer {
  width: 340px; max-width: 88vw; height: 100%; display: flex; flex-direction: column;
  background: var(--bg-1); border-left: 1px solid var(--border);
}
.ed-drawer-head {
  flex: 0 0 auto; height: 46px; padding: 0 12px; display: flex; align-items: center;
  justify-content: space-between; border-bottom: 1px solid var(--border);
}
.ed-drawer-head b { font-size: 12px; }
.ed-drawer-head button {
  width: 26px; height: 26px; border: 0; border-radius: 6px; background: transparent;
  color: var(--text-2); font-size: 18px; cursor: pointer;
}
.ed-drawer-create { flex: 0 0 auto; display: flex; gap: 6px; padding: 10px 12px 6px; }
.ed-drawer-create input {
  flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg-2); color: var(--text-0); font-size: 10px;
}
.ed-drawer-create button {
  flex: 0 0 auto; height: 28px; padding: 0 10px; border: 1px solid var(--accent);
  border-radius: 6px; background: var(--accent); color: #fff; font-size: 10px; cursor: pointer;
}
.ed-drawer-create button:disabled { opacity: .45; cursor: not-allowed; }
.ed-drawer-dirty { margin: 0; padding: 0 12px 6px; font-size: 9px; color: var(--warning); }
.ed-drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 12px 12px; display: flex; flex-direction: column; gap: 8px; }
.ed-drawer-state { margin: 12px 0; text-align: center; font-size: 10px; color: var(--text-3); }
.ed-revision {
  display: flex; flex-direction: column; gap: 4px; padding: 8px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg-2);
}
.ed-revision.is-current { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.ed-revision-head { display: flex; align-items: center; gap: 6px; }
.ed-revision-head b { font-size: 11px; }
.ed-revision-head small { margin-left: auto; font-size: 8px; color: var(--text-3); }
.ed-revision-badge {
  padding: 1px 5px; border-radius: 999px; background: var(--accent-bg); color: var(--accent-text); font-size: 8px;
}
.ed-revision-note { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--text-1); }
.ed-revision-meta { display: flex; gap: 10px; font-size: 9px; color: var(--text-3); }
.ed-revision-restore {
  align-self: flex-start; height: 22px; margin-top: 2px; padding: 0 8px;
  border: 1px solid var(--border); border-radius: 5px; background: var(--bg-1);
  color: var(--text-1); font-size: 9px; cursor: pointer;
}
.ed-revision-restore:hover { border-color: var(--accent); }
.ed-revision-restore:disabled { opacity: .45; cursor: not-allowed; }
</style>
```

- [ ] **Step 6: 创建 `EditConflictDialog.vue`**

```vue
<template>
  <div v-if="conflict" class="ed-conflict-mask">
    <section class="ed-conflict">
      <header>
        <b>{{ t('edit.conflictTitle') }}</b>
        <code>EDIT_VERSION_CONFLICT</code>
      </header>
      <p>{{ t('edit.conflictHint', { version: conflict.current_version }) }}</p>
      <dl>
        <div><dt>{{ t('edit.serverVersion') }}</dt><dd>{{ conflict.current_version }}</dd></div>
        <div><dt>{{ t('edit.updatedAt') }}</dt><dd>{{ formatTime(conflict.updated_at) }}</dd></div>
        <div><dt>{{ t('edit.serverClips') }}</dt><dd>{{ conflict.current_plan?.clips?.length ?? 0 }}</dd></div>
      </dl>
      <div class="ed-conflict-actions">
        <button type="button" :disabled="loading" @click="$emit('reload')">{{ t('edit.conflictReload') }}</button>
        <button type="button" :disabled="loading" @click="$emit('overwrite')">{{ t('edit.conflictOverwrite') }}</button>
        <button type="button" :disabled="loading" @click="$emit('copy')">{{ t('edit.conflictCopy') }}</button>
      </div>
      <p class="ed-conflict-note">{{ t('edit.conflictCopyHint') }}</p>
    </section>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

defineProps({
  conflict: { type: Object, default: null },
  loading: { type: Boolean, default: false },
})
defineEmits(['reload', 'overwrite', 'copy'])
const { t } = useI18n()

function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
</script>

<style scoped>
.ed-conflict-mask {
  position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: rgba(0, 0, 0, .55);
}
.ed-conflict {
  width: 440px; max-width: 100%; display: flex; flex-direction: column; gap: 10px;
  padding: 18px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-1);
  box-shadow: 0 18px 50px rgba(0, 0, 0, .35);
}
.ed-conflict header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ed-conflict header b { font-size: 14px; color: var(--text-0); }
.ed-conflict header code { font-size: 9px; color: var(--warning); }
.ed-conflict p { margin: 0; font-size: 11px; color: var(--text-2); line-height: 1.6; }
.ed-conflict dl { display: flex; flex-direction: column; gap: 4px; margin: 0; }
.ed-conflict dl div { display: flex; justify-content: space-between; gap: 10px; font-size: 10px; }
.ed-conflict dt { color: var(--text-3); }
.ed-conflict dd { margin: 0; color: var(--text-1); }
.ed-conflict-actions { display: flex; gap: 8px; margin-top: 4px; }
.ed-conflict-actions button {
  flex: 1; height: 32px; border: 1px solid var(--border); border-radius: 7px;
  background: var(--bg-2); color: var(--text-0); font-size: 11px; cursor: pointer;
}
.ed-conflict-actions button:first-child { border-color: var(--accent); background: var(--accent); color: #fff; }
.ed-conflict-actions button:disabled { opacity: .45; cursor: not-allowed; }
.ed-conflict-note { font-size: 9px; color: var(--text-3); }
</style>
```

- [ ] **Step 7: 运行结构测试**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-structure.test.mjs
```
Expected: PASS。**不要提交。**

## Task 13: 工作台集成、快捷键与四语文案

**Files:**
- Rewrite: `frontend/app/components/edit/EditEmptyState.vue`
- Rewrite: `frontend/app/components/edit/EditTopBar.vue`
- Rewrite: `frontend/app/components/edit/EditWorkbench.vue`
- Modify: `frontend/app/locales/zh.json`
- Modify: `frontend/app/locales/en.json`
- Modify: `frontend/app/locales/ja.json`
- Modify: `frontend/app/locales/ko.json`
- Modify: `frontend/tests/edit-structure.test.mjs`

**Interfaces:**
- `EditTopBar` props：`state/episodeLabel/saveStatus/dirty/canUndo/canRedo/canEdit/roughCutBusy/subtitleBusy`；emits：`back/undo/redo/save/discard/open-revisions/rough-cut/suggest-subtitles/shortcuts/toggle-media`。
- `EditEmptyState` props：`readonly/roughCutAvailable/busy`；emits：`back/rough-cut`。
- `EditWorkbench` 消费 Task 8–10 的组合式函数与命令、渲染 Task 11–12 的组件；不新增 API。
- 只读时所有编辑入口隐藏或禁用，`useEditPlan` 内部同时拒绝一切本地变更。

- [ ] **Step 1: 写失败结构测试**

在 `frontend/tests/edit-structure.test.mjs` 末尾追加：

```js
test('S2 工作台集成自动保存、撤销、版本、初剪与快捷键', () => {
  const workbench = read('app/components/edit/EditWorkbench.vue')
  for (const token of [
    'useEditPlan', 'useEditMedia', 'EditMediaLibrary', 'EditRevisionsDrawer',
    'EditConflictDialog', 'applyCommand', 'acceptRecovery', 'roughCut',
    'suggestSubtitles', 'onKeydown', 'saveNow',
  ]) {
    assert.match(workbench, new RegExp(token))
  }
  assert.match(workbench, /addEventListener\('keydown'/)
  assert.match(workbench, /recovery/)

  const top = read('app/components/edit/EditTopBar.vue')
  assert.match(top, /saveStatus/)
  assert.match(top, /undo/)
  assert.match(top, /redo/)
  assert.match(top, /versionTitle/)
  assert.match(top, /suggest-subtitles/)

  const empty = read('app/components/edit/EditEmptyState.vue')
  assert.match(empty, /rough-cut/)
  assert.match(empty, /readonly/)
})

test('S2 四语文案覆盖新增键', () => {
  const keys = [
    'actions', 'addAll', 'addedCountToTimeline', 'addedToTimeline', 'addToTimeline',
    'alreadyAdded', 'audio', 'audioTrack', 'close', 'conflictCopied', 'conflictCopy',
    'conflictCopyFailed', 'conflictCopyHint', 'conflictHint', 'conflictLoadFailed',
    'conflictOverwritten', 'conflictOverwrite', 'conflictReload', 'conflictReloaded',
    'conflictTitle', 'createRevisionFailed', 'deleteClip', 'deleteKeepGap', 'discardConfirm',
    'discarded', 'discardDraft', 'discardFailed', 'emptyEditableHint', 'emptyLibraryHint',
    'fadeIn', 'fadeOut', 'gap', 'importDisabled', 'libraryToggle', 'lineOverflow',
    'linePlacement', 'mediaEmpty', 'mediaLibrary', 'mediaLines', 'mediaLoading',
    'mediaStoryboards', 'mediaTakes', 'mediaUnavailable', 'narration', 'noPreview',
    'noSelection', 'pause', 'play', 'readonlyEdit', 'recoveryAccept', 'recoveryDismiss',
    'recoveryHint', 'redo', 'removeTransition', 'restoreConfirm', 'restoreFailed',
    'roughCut', 'roughCutConfirm', 'roughCutDone', 'roughCutFailed', 'roughCutRunning',
    'roughCutSnapshotNote', 'saveConflict', 'saveFailed', 'saveNow', 'savePending',
    'saveRetry', 'saveSaved', 'saveSaving', 'saving', 'searchMedia', 'serverClips',
    'serverVersion', 'shortcutDelete', 'shortcutEscape', 'shortcutHomeEnd', 'shortcutPlay',
    'shortcuts', 'shortcutsTitle', 'shortcutSave', 'shortcutSplit', 'shortcutStep',
    'shortcutUndo', 'snap', 'sourceIn', 'sourceOut', 'speaker', 'split', 'stepBack',
    'stepForward', 'storyboardN', 'subtitleEmpty', 'subtitleHash', 'subtitleSuggest',
    'subtitleSuggestFailed', 'subtitleSuggested', 'subtitleSuggestRunning', 'subtitleTrack',
    'tailGap', 'timelineEmpty', 'transition', 'undo', 'untitled', 'updatedAt',
    'versionCreate', 'versionCreated', 'versionCurrent', 'versionDefaultNote',
    'versionDirty', 'versionEmpty', 'versionLoadFailed', 'versionNote', 'versionRestore',
    'versionRestored', 'versionTitle', 'videoTrack', 'zoomIn', 'zoomOut',
  ]
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const locale = JSON.parse(read(`app/locales/${lang}.json`))
    for (const key of keys) {
      const value = locale.edit?.[key]
      assert.equal(typeof value, 'string', `${lang} 缺少 edit.${key}`)
      assert.ok(value.trim().length > 0, `${lang} edit.${key} 为空`)
    }
  }
})
```

- [ ] **Step 2: 运行并确认失败**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-structure.test.mjs
```
Expected: FAIL，工作台尚未集成 `useEditPlan`，且四语缺少新增键。

- [ ] **Step 3: 重写 `EditEmptyState.vue`**

```vue
<template>
  <div class="ed-empty">
    <Clapperboard :size="34" />
    <h2>{{ t('edit.emptyTitle') }}</h2>
    <p>{{ readonly ? t('edit.emptyHint') : t('edit.emptyEditableHint') }}</p>
    <div class="ed-empty-actions">
      <button
        v-if="!readonly && roughCutAvailable"
        class="ed-empty-btn is-primary"
        type="button"
        :disabled="busy"
        @click="$emit('rough-cut')"
      >
        <Wand2 :size="14" />
        {{ busy ? t('edit.roughCutRunning') : t('edit.roughCut') }}
      </button>
      <button class="ed-empty-btn" type="button" @click="$emit('back')">
        {{ t('edit.back') }}
      </button>
    </div>
    <p v-if="!readonly && !roughCutAvailable" class="ed-empty-note">
      {{ t('edit.emptyLibraryHint') }}
    </p>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Clapperboard, Wand2 } from 'lucide-vue-next'

defineProps({
  readonly: { type: Boolean, default: false },
  roughCutAvailable: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
})
defineEmits(['back', 'rough-cut'])
const { t } = useI18n()
</script>

<style scoped>
.ed-empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 32px; color: var(--text-3); text-align: center;
}
.ed-empty h2 { margin: 0; font-size: 18px; color: var(--text-0); }
.ed-empty p { margin: 0; max-width: 460px; line-height: 1.6; color: var(--text-2); }
.ed-empty-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.ed-empty-btn {
  height: 34px; padding: 0 16px; display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); border-radius: 999px; background: var(--bg-1);
  color: var(--text-0); cursor: pointer;
}
.ed-empty-btn.is-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.ed-empty-btn:disabled { opacity: .45; cursor: not-allowed; }
.ed-empty-note { font-size: 11px; color: var(--text-3); }
</style>
```

- [ ] **Step 4: 重写 `EditTopBar.vue`**

```vue
<template>
  <div class="ed-top-wrap">
    <header class="ed-top">
      <div class="ed-top-left">
        <button class="ed-icon" type="button" :title="t('edit.back')" @click="$emit('back')">
          <ArrowLeft :size="16" />
        </button>
        <span class="ed-brand"><Scissors :size="14" /> {{ t('edit.title') }}</span>
        <span class="ed-episode">{{ episodeLabel }}</span>
        <span :class="['ed-chip', readonly ? 'is-muted' : 'is-on']">
          {{ readonly ? t('edit.readonly') : t('edit.on') }}
        </span>
        <span :class="['ed-chip', `is-${state.mix_status.status}`]">{{ mixLabel }}</span>
      </div>

      <div v-if="canEdit" class="ed-top-center">
        <button class="ed-icon" type="button" :title="t('edit.undo')" :disabled="!canUndo" @click="$emit('undo')">
          <Undo2 :size="15" />
        </button>
        <button class="ed-icon" type="button" :title="t('edit.redo')" :disabled="!canRedo" @click="$emit('redo')">
          <Redo2 :size="15" />
        </button>
        <button
          class="ed-save"
          :class="saveTone"
          type="button"
          :title="t('edit.saveNow')"
          @click="$emit('save')"
        >
          <span class="ed-save-dot"></span>{{ saveLabel }}
        </button>
      </div>

      <div class="ed-top-right">
        <template v-if="canEdit">
          <button
            class="ed-action"
            type="button"
            :disabled="roughCutBusy || subtitleBusy"
            @click="$emit('suggest-subtitles')"
          >
            <Captions :size="13" />
            <span>{{ subtitleBusy ? t('edit.subtitleSuggestRunning') : t('edit.subtitleSuggest') }}</span>
          </button>
          <button
            class="ed-action"
            type="button"
            :disabled="roughCutBusy || subtitleBusy"
            @click="$emit('rough-cut')"
          >
            <Wand2 :size="13" />
            <span>{{ roughCutBusy ? t('edit.roughCutRunning') : t('edit.roughCut') }}</span>
          </button>
        </template>
        <button class="ed-action" type="button" @click="$emit('open-revisions')">
          <History :size="13" /><span>{{ t('edit.versionTitle') }}</span>
        </button>
        <button class="ed-icon" type="button" :title="t('edit.libraryToggle')" @click="$emit('toggle-media')">
          <PanelLeft :size="15" />
        </button>
        <button class="ed-icon" type="button" :title="t('edit.shortcuts')" @click="$emit('shortcuts')">
          <Keyboard :size="15" />
        </button>
        <button
          v-if="canEdit"
          class="ed-icon"
          type="button"
          :title="t('edit.discardDraft')"
          :disabled="!dirty"
          @click="$emit('discard')"
        >
          <Trash2 :size="15" />
        </button>
      </div>
    </header>
    <p v-if="readonly" class="ed-readonly-bar">{{ t('edit.readonlyHint') }}</p>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import {
  ArrowLeft, Captions, History, Keyboard, PanelLeft, Redo2, Scissors, Trash2, Undo2, Wand2,
} from 'lucide-vue-next'

const props = defineProps({
  state: { type: Object, required: true },
  episodeLabel: { type: String, default: '' },
  saveStatus: { type: String, default: 'idle' },
  dirty: { type: Boolean, default: false },
  canUndo: { type: Boolean, default: false },
  canRedo: { type: Boolean, default: false },
  canEdit: { type: Boolean, default: false },
  roughCutBusy: { type: Boolean, default: false },
  subtitleBusy: { type: Boolean, default: false },
})
defineEmits([
  'back', 'undo', 'redo', 'save', 'discard', 'open-revisions',
  'rough-cut', 'suggest-subtitles', 'shortcuts', 'toggle-media',
])
const { t } = useI18n()

const readonly = computed(() => !props.canEdit)
const mixLabel = computed(() => {
  if (props.state.mix_status?.status === 'aligned') return t('edit.mixAligned')
  if (props.state.mix_status?.status === 'stale') return t('edit.mixStale')
  return t('edit.mixMissing')
})
const saveLabel = computed(() => {
  if (props.saveStatus === 'saving') return t('edit.saveSaving')
  if (props.saveStatus === 'conflict') return t('edit.saveConflict')
  if (props.saveStatus === 'error') return t('edit.saveFailed')
  if (props.saveStatus === 'saved') return t('edit.saveSaved')
  return props.dirty ? t('edit.savePending') : t('edit.saveSaved')
})
const saveTone = computed(() => {
  if (props.saveStatus === 'saving') return 'is-saving'
  if (props.saveStatus === 'conflict') return 'is-conflict'
  if (props.saveStatus === 'error') return 'is-error'
  return props.dirty ? 'is-pending' : 'is-saved'
})
</script>

<style scoped>
.ed-top-wrap { flex: 0 0 auto; display: flex; flex-direction: column; }
.ed-top {
  height: 52px; padding: 0 14px; display: flex; align-items: center;
  gap: 12px; border-bottom: 1px solid var(--border); background: var(--bg-1);
}
.ed-top-left { min-width: 0; display: flex; align-items: center; gap: 10px; }
.ed-top-center { display: flex; align-items: center; gap: 4px; padding-left: 4px; border-left: 1px solid var(--border); }
.ed-top-right { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.ed-icon {
  width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: 8px; background: transparent;
  color: var(--text-1); cursor: pointer;
}
.ed-icon:hover { background: var(--bg-hover); }
.ed-icon:disabled { opacity: .35; cursor: not-allowed; }
.ed-brand { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 650; white-space: nowrap; }
.ed-episode {
  max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12px; color: var(--text-2);
}
.ed-chip {
  height: 22px; padding: 0 8px; display: inline-flex; align-items: center; border-radius: 999px;
  font-size: 11px; font-weight: 600; white-space: nowrap;
}
.ed-chip.is-muted { background: var(--bg-2); color: var(--text-2); }
.ed-chip.is-on { background: var(--accent-bg); color: var(--accent-text); }
.ed-chip.is-aligned { background: var(--success-bg); color: var(--success); }
.ed-chip.is-missing { background: var(--bg-2); color: var(--text-2); }
.ed-chip.is-stale { background: var(--warning-bg); color: var(--warning); }
.ed-save {
  height: 26px; padding: 0 9px; display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--border); border-radius: 999px; background: var(--bg-2);
  color: var(--text-2); font-size: 10px; cursor: pointer; white-space: nowrap;
}
.ed-save:hover { border-color: var(--accent); }
.ed-save-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.ed-save.is-saved { color: var(--success); }
.ed-save.is-saving, .ed-save.is-pending { color: var(--warning); }
.ed-save.is-error, .ed-save.is-conflict { color: var(--danger); }
.ed-action {
  height: 28px; padding: 0 9px; display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border); border-radius: 7px; background: var(--bg-2);
  color: var(--text-1); font-size: 10px; cursor: pointer; white-space: nowrap;
}
.ed-action:hover { border-color: var(--accent); color: var(--text-0); }
.ed-action:disabled { opacity: .45; cursor: not-allowed; }
.ed-readonly-bar {
  margin: 0; padding: 5px 14px; border-bottom: 1px solid var(--border);
  background: var(--bg-2); color: var(--text-3); font-size: 10px;
}
@media (max-width: 1180px) {
  .ed-episode { max-width: 150px; }
  .ed-action span { display: none; }
  .ed-action { width: 28px; padding: 0; justify-content: center; }
}
@media (max-width: 900px) {
  .ed-top { gap: 6px; padding: 0 8px; }
  .ed-brand, .ed-episode { display: none; }
}
</style>
```

- [ ] **Step 5: 重写 `EditWorkbench.vue`**

```vue
<template>
  <div class="ed-workbench">
    <EditTopBar
      :state="state"
      :episode-label="episodeLabel"
      :save-status="saveStatus"
      :dirty="dirty"
      :can-undo="canUndo"
      :can-redo="canRedo"
      :can-edit="canEdit"
      :rough-cut-busy="roughCutBusy"
      :subtitle-busy="subtitleBusy"
      @back="$emit('back')"
      @undo="undo"
      @redo="redo"
      @save="saveImmediately"
      @discard="discardDraft"
      @open-revisions="openRevisions"
      @rough-cut="runRoughCut"
      @suggest-subtitles="runSubtitleSuggest"
      @shortcuts="shortcutsOpen = true"
      @toggle-media="mediaOpen = !mediaOpen"
    />

    <div v-if="saveStatus === 'error'" class="ed-banner is-error">
      <span>{{ saveError || t('edit.saveFailed') }}</span>
      <button type="button" @click="saveImmediately">{{ t('edit.saveRetry') }}</button>
    </div>
    <div v-if="recovery && canEdit" class="ed-banner is-warning">
      <span>{{ t('edit.recoveryHint', { time: formatWhen(recovery.savedAt) }) }}</span>
      <button type="button" @click="useRecovery">{{ t('edit.recoveryAccept') }}</button>
      <button class="is-muted" type="button" @click="dismissRecovery">{{ t('edit.recoveryDismiss') }}</button>
    </div>
    <div v-if="timelineMessage" class="ed-banner is-info">
      <span>{{ timelineMessage }}</span>
      <button class="is-muted" type="button" @click="clearMessage">×</button>
    </div>

    <div class="ed-main" :class="{ 'is-empty': !plan.clips.length, 'is-media-open': mediaOpen }">
      <EditMediaLibrary
        class="ed-media-slot"
        :media="media"
        :loading="mediaLoading"
        :error="mediaError"
        :readonly="!canEdit"
        :used-storyboard-ids="usedStoryboardIds"
        :rough-cut-available="state.rough_cut_available"
        @add-storyboard="addStoryboard"
        @add-all="addAllStoryboards"
        @rough-cut="runRoughCut"
        @retry="loadMedia"
      />

      <section class="ed-stage">
        <EditEmptyState
          v-if="!plan.clips.length"
          :readonly="!canEdit"
          :rough-cut-available="state.rough_cut_available"
          :busy="actionBusy"
          @rough-cut="runRoughCut"
          @back="$emit('back')"
        />
        <template v-else>
          <EditPreview
            ref="previewRef"
            :src="previewSrc"
            :poster="poster"
            :plan="plan"
            :active-clip-id="activeClipId"
            :clip-key="clipKey"
            :source-ms="sourceMs"
            :current-ms="currentMs"
            :duration-ms="layout.duration_ms"
            :fps="plan.project.fps"
            :playing="playing"
            :audio-mode="audioMode"
            :playback-rate="playbackRate"
            @toggle="togglePlayback"
            @seek="seek"
            @step="stepFrame"
            @ended="onClipEnded"
          />
          <EditTimeline
            :plan="plan"
            :layout="layout"
            :current-ms="currentMs"
            :selected-clip-id="selectedClipId"
            :selected-cue-id="selectedCueId"
            :readonly="!canEdit"
            :audio-mode="audioMode"
            @seek="seek"
            @select-clip="selectClip"
            @select-cue="selectCue"
            @move-clip="moveClipTo"
            @trim-clip="trimClip"
            @split-clip="splitAt"
            @move-cue="moveCueTo"
            @remove-transition="removeTransitionById"
          />
        </template>
      </section>

      <EditClipInspector
        v-if="plan.clips.length"
        :plan="plan"
        :layout="layout"
        :clip-id="selectedClipId"
        :placement="selectedPlacement"
        :state="inspectorState"
        :current-ms="currentMs"
        :readonly="!canEdit"
        @trim-start="trimSelectedStart"
        @trim-end="trimSelectedEnd"
        @speed="setSelectedSpeed"
        @gap="setSelectedGap"
        @fades="setSelectedFades"
        @split="splitAt"
        @remove="removeSelected"
      />
    </div>

    <EditRevisionsDrawer
      :open="revisionsOpen"
      :revisions="revisions"
      :loading="revisionsLoading"
      :draft-dirty="dirty"
      :can-edit="canEdit"
      @close="revisionsOpen = false"
      @refresh="loadRevisions"
      @create="createRevision"
      @restore="restoreSelectedRevision"
    />

    <EditConflictDialog
      :conflict="conflict"
      :loading="conflictBusy"
      @reload="reloadFromConflict"
      @overwrite="overwriteConflict"
      @copy="copyConflict"
    />

    <div v-if="shortcutsOpen" class="ed-modal-mask" @click.self="shortcutsOpen = false">
      <section class="ed-shortcuts">
        <header>
          <b>{{ t('edit.shortcutsTitle') }}</b>
          <button type="button" @click="shortcutsOpen = false">×</button>
        </header>
        <dl>
          <div><dt>Space</dt><dd>{{ t('edit.shortcutPlay') }}</dd></div>
          <div><dt>← / →</dt><dd>{{ t('edit.shortcutStep') }}</dd></div>
          <div><dt>⌘/Ctrl+Z</dt><dd>{{ t('edit.shortcutUndo') }}</dd></div>
          <div><dt>⌘/Ctrl+S</dt><dd>{{ t('edit.shortcutSave') }}</dd></div>
          <div><dt>S</dt><dd>{{ t('edit.shortcutSplit') }}</dd></div>
          <div><dt>Delete</dt><dd>{{ t('edit.shortcutDelete') }}</dd></div>
          <div><dt>Home / End</dt><dd>{{ t('edit.shortcutHomeEnd') }}</dd></div>
          <div><dt>Esc</dt><dd>{{ t('edit.shortcutEscape') }}</dd></div>
        </dl>
      </section>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import EditTopBar from '~/components/edit/EditTopBar.vue'
import EditPreview from '~/components/edit/EditPreview.vue'
import EditTimeline from '~/components/edit/EditTimeline.vue'
import EditClipInspector from '~/components/edit/EditClipInspector.vue'
import EditEmptyState from '~/components/edit/EditEmptyState.vue'
import EditMediaLibrary from '~/components/edit/EditMediaLibrary.vue'
import EditRevisionsDrawer from '~/components/edit/EditRevisionsDrawer.vue'
import EditConflictDialog from '~/components/edit/EditConflictDialog.vue'
import { editAPI } from '~/composables/useApi'
import { useEditPlan } from '~/composables/useEditPlan'
import { useEditMedia } from '~/composables/useEditMedia'
import {
  appendClip,
  createClipFromSource,
  createCommandId,
  deleteCue,
  moveClip,
  moveCue,
  removeClip,
  removeTransition,
  setClipFades,
  setClipGap,
  setClipSpeed,
  splitClip,
  trimClipEnd,
  trimClipStart,
} from '~/utils/edit-commands'
import { activeClipIndex, sourceTimeAt } from '~/utils/edit-layout'
import { framesToMs, msToFrames } from '~/utils/edit-timecode'
import { mediaUrl } from '~/utils/edit-plan'

const props = defineProps({
  state: { type: Object, required: true },
  episodeLabel: { type: String, default: '' },
})
defineEmits(['back'])
const { t } = useI18n()

const {
  plan,
  layout,
  hashes,
  version,
  dirty,
  canEdit,
  saveStatus,
  saveError,
  conflict,
  recovery,
  issues,
  canUndo,
  canRedo,
  applyCommand,
  applyExternalPlan,
  undo,
  redo,
  saveNow,
  reload,
  discard,
  createVersion,
  restoreRevision,
  resolveConflict,
  acceptRecovery,
  dismissRecovery,
  retrySave,
} = useEditPlan(props.state)

const {
  media,
  loading: mediaLoading,
  error: mediaError,
  load: loadMedia,
} = useEditMedia(props.state.episode_id)

const previewRef = ref(null)
const currentMs = ref(0)
const playing = ref(false)
const selection = ref(null)
const mediaOpen = ref(true)
const shortcutsOpen = ref(false)
const timelineMessage = ref('')
const roughCutBusy = ref(false)
const subtitleBusy = ref(false)
const revisionsOpen = ref(false)
const revisions = ref([])
const revisionsLoading = ref(false)
const revisionBusy = ref(false)
const conflictBusy = ref(false)

let rafId = 0
let lastTick = 0
let messageTimer = 0

const selectedClipId = computed(() => (
  selection.value?.type === 'clip' ? selection.value.id : ''
))
const selectedCueId = computed(() => (
  selection.value?.type === 'cue' ? selection.value.id : ''
))
const actionBusy = computed(() => roughCutBusy.value || subtitleBusy.value)
const audioMode = computed(() => (
  plan.value.clips.some((clip) => clip.source?.hasAudio) ? 'video' : 'none'
))

const activeLayoutClip = computed(() => {
  const index = activeClipIndex(layout.value, currentMs.value)
  const item = layout.value.clips[index]
  if (!item) return null
  return currentMs.value >= item.timeline_start_ms && currentMs.value < item.timeline_end_ms
    ? item
    : null
})
const activeClipId = computed(() => activeLayoutClip.value?.clip_id ?? '')
const activeClip = computed(() => (
  plan.value.clips.find((clip) => clip.id === activeClipId.value) ?? null
))
const sourceMs = computed(() => (
  activeClip.value ? sourceTimeAt(plan.value, layout.value, currentMs.value) : 0
))
const playbackRate = computed(() => Number(activeClip.value?.speed) || 1)
const previewSrc = computed(() => mediaUrl(activeClip.value?.source?.url || ''))
const poster = computed(() => mediaUrl(activeClip.value?.source?.thumbnailUrl || ''))
const clipKey = computed(() => (
  activeClip.value
    ? `${activeClip.value.id}:${activeClip.value.source?.url || ''}:${activeClip.value.sourceInMs}`
    : ''
))

const usedStoryboardIds = computed(() => plan.value.clips
  .filter((clip) => clip.source?.kind === 'storyboard')
  .map((clip) => Number(clip.source.id))
  .filter((id) => Number.isFinite(id)))

const selectedPlacement = computed(() => {
  if (!selectedClipId.value) return null
  return (props.state.line_placements ?? []).find(
    (item) => item.clip_id === selectedClipId.value,
  ) ?? null
})

const inspectorState = computed(() => ({
  ...props.state,
  plan: plan.value,
  layout: layout.value,
  hashes: hashes.value,
}))

function formatWhen(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function notify(message) {
  timelineMessage.value = message
  clearTimeout(messageTimer)
  messageTimer = setTimeout(() => {
    timelineMessage.value = ''
  }, 5000)
}

function clearMessage() {
  clearTimeout(messageTimer)
  timelineMessage.value = ''
}

function clampCurrentTime() {
  const end = Math.max(0, Number(layout.value.duration_ms) || 0)
  if (currentMs.value > end) currentMs.value = end
}

function seek(ms) {
  const end = Math.max(0, Number(layout.value.duration_ms) || 0)
  const value = Math.max(0, Math.min(end, Math.round(Number(ms) || 0)))
  currentMs.value = value
  const index = activeClipIndex(layout.value, value)
  const item = layout.value.clips[index]
  if (item && value >= item.timeline_start_ms && value < item.timeline_end_ms) {
    previewRef.value?.seek(sourceTimeAt(plan.value, layout.value, value))
  }
}

function playFromCurrent() {
  if (!plan.value.clips.length || playing.value) return
  if (currentMs.value >= Math.max(0, layout.value.duration_ms - 1)) currentMs.value = 0
  playing.value = true
  lastTick = 0
  cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(tick)
}

function tick(now) {
  if (!playing.value) return
  if (!lastTick) lastTick = now
  const delta = Math.min(250, Math.max(0, now - lastTick))
  lastTick = now
  const end = Math.max(0, Number(layout.value.duration_ms) || 0)
  currentMs.value = Math.min(end, currentMs.value + delta)
  if (currentMs.value >= end) {
    pausePlayback()
    return
  }
  rafId = requestAnimationFrame(tick)
}

function pausePlayback() {
  playing.value = false
  cancelAnimationFrame(rafId)
  previewRef.value?.pause()
}

function togglePlayback() {
  if (playing.value) pausePlayback()
  else playFromCurrent()
}

function stepFrame(direction) {
  pausePlayback()
  const fps = Number(plan.value.project.fps) || 30
  const frame = msToFrames(currentMs.value, fps) + (Number(direction) >= 0 ? 1 : -1)
  seek(framesToMs(Math.max(0, frame), fps))
}

function onClipEnded() {
  const item = activeLayoutClip.value
  if (playing.value && item && currentMs.value < item.timeline_end_ms) {
    currentMs.value = item.timeline_end_ms
  }
}

function selectClip(clipId) {
  selection.value = clipId ? { type: 'clip', id: clipId } : null
}

function selectCue(cueId) {
  selection.value = cueId ? { type: 'cue', id: cueId } : null
}

function runCommand(factory, options = {}) {
  if (!canEdit.value) return false
  const result = factory(plan.value)
  const ok = applyCommand(() => result)
  if (!ok) {
    const issue = result.issues.find((item) => item.severity === 'error')
    if (issue) notify(issue.message)
    return false
  }
  if (
    options.selectFocus !== false
    && result.focusClipId
    && selection.value?.type === 'clip'
  ) {
    selection.value = { type: 'clip', id: result.focusClipId }
  }
  clampCurrentTime()
  return true
}

function moveClipTo(payload) {
  const index = plan.value.clips.findIndex((clip) => clip.id === payload.clipId)
  if (index === payload.targetIndex) return
  runCommand((value) => moveClip(value, payload.clipId, payload.targetIndex))
}

function trimClip(payload) {
  const factory = payload.edge === 'start'
    ? (value) => trimClipStart(value, payload.clipId, payload.deltaMs, { ripple: true })
    : (value) => trimClipEnd(value, payload.clipId, payload.deltaMs, { ripple: true })
  runCommand(factory)
}

function moveCueTo(payload) {
  runCommand(
    (value) => moveCue(value, payload.cueId, payload.startMs),
    { selectFocus: false },
  )
}

function splitAt(payload) {
  if (!canEdit.value) return
  const clipId = typeof payload === 'object' && payload ? payload.clipId : selectedClipId.value
  const atMs = typeof payload === 'object' && payload ? payload.atMs : Number(payload)
  if (!clipId || !Number.isFinite(atMs)) return
  const secondId = createCommandId('clp')
  const ok = runCommand((value) => splitClip(value, clipId, atMs, secondId))
  if (ok) selection.value = { type: 'clip', id: secondId }
}

function splitAtPlayhead() {
  if (!canEdit.value) return
  const item = activeLayoutClip.value
  const clip = activeClip.value
  if (!item || !clip) return
  const offset = currentMs.value - item.timeline_start_ms
  if (offset <= 100 || item.timeline_end_ms - currentMs.value <= 100) return
  splitAt({ clipId: clip.id, atMs: offset })
}

function removeTransitionById(transitionId) {
  runCommand(
    (value) => removeTransition(value, transitionId),
    { selectFocus: false },
  )
}

function trimSelectedStart(deltaMs) {
  if (!selectedClipId.value) return
  runCommand((value) => trimClipStart(value, selectedClipId.value, deltaMs, { ripple: true }))
}

function trimSelectedEnd(deltaMs) {
  if (!selectedClipId.value) return
  runCommand((value) => trimClipEnd(value, selectedClipId.value, deltaMs, { ripple: true }))
}

function setSelectedSpeed(speed) {
  if (!selectedClipId.value) return
  runCommand((value) => setClipSpeed(value, selectedClipId.value, speed))
}

function setSelectedGap(gapMs) {
  if (!selectedClipId.value) return
  runCommand((value) => setClipGap(value, selectedClipId.value, gapMs))
}

function setSelectedFades(payload) {
  if (!selectedClipId.value) return
  runCommand(
    (value) => setClipFades(value, selectedClipId.value, payload.inMs, payload.outMs),
  )
}

function removeSelected(payload = { ripple: true }) {
  if (!selectedClipId.value) return
  runCommand(
    (value) => removeClip(value, selectedClipId.value, { ripple: payload.ripple !== false }),
  )
}

function removeSelection() {
  const current = selection.value
  if (!current) return
  if (current.type === 'cue') {
    runCommand((value) => deleteCue(value, current.id), { selectFocus: false })
    selection.value = null
    return
  }
  if (current.type === 'clip') {
    runCommand((value) => removeClip(value, current.id, { ripple: true }))
  }
}

function addStoryboard(item) {
  if (!canEdit.value || !item?.playable || !item.source) return
  const id = createCommandId('clp')
  const ok = runCommand((value) => appendClip(value, createClipFromSource(id, item.source)))
  if (!ok) return
  selection.value = { type: 'clip', id }
  const layoutClip = layout.value.clips.find((clip) => clip.clip_id === id)
  if (layoutClip) seek(layoutClip.timeline_start_ms)
  notify(t('edit.addedToTimeline', { n: item.number }))
}

function addAllStoryboards() {
  if (!canEdit.value) return
  const candidates = (media.value?.storyboards ?? []).filter(
    (item) => item.playable && item.source && !usedStoryboardIds.value.includes(item.id),
  )
  if (!candidates.length) return
  const ids = candidates.map(() => createCommandId('clp'))
  const ok = runCommand((value) => {
    let next = value
    candidates.forEach((item, index) => {
      next = appendClip(next, createClipFromSource(ids[index], item.source)).plan
    })
    return { plan: next, issues: [], focusClipId: ids[0] }
  })
  if (!ok) return
  selection.value = { type: 'clip', id: ids[0] }
  const layoutClip = layout.value.clips.find((clip) => clip.clip_id === ids[0])
  if (layoutClip) seek(layoutClip.timeline_start_ms)
  notify(t('edit.addedCountToTimeline', { n: candidates.length }))
}

function handleActionError(cause, fallbackKey) {
  if (cause?.code === 'EDIT_VERSION_CONFLICT') {
    conflict.value = cause.data
    saveStatus.value = 'conflict'
    return
  }
  notify(cause?.message || t(fallbackKey))
}

async function saveImmediately() {
  if (!canEdit.value || conflict.value) return
  if (saveStatus.value === 'error') retrySave()
  await saveNow()
}

async function runRoughCut() {
  if (!canEdit.value || actionBusy.value) return
  if (plan.value.clips.length && !window.confirm(t('edit.roughCutConfirm'))) return
  roughCutBusy.value = true
  try {
    if (plan.value.clips.length) {
      await createVersion(t('edit.roughCutSnapshotNote'))
    } else {
      await saveNow()
    }
    const result = await editAPI.roughCut(props.state.episode_id, {
      mode: 'replace',
      plan: plan.value,
      create_revision: false,
      base_version: version.value,
    })
    applyExternalPlan(result.plan, result.hashes)
    issues.value = result.issues
    selection.value = null
    currentMs.value = 0
    notify(t('edit.roughCutDone', {
      added: result.applied.added,
      skipped: result.applied.skipped,
    }))
  } catch (cause) {
    handleActionError(cause, 'edit.roughCutFailed')
  } finally {
    roughCutBusy.value = false
  }
}

async function runSubtitleSuggest() {
  if (!canEdit.value || actionBusy.value) return
  subtitleBusy.value = true
  try {
    await saveNow()
    if (conflict.value) return
    const result = await editAPI.suggestSubtitles(props.state.episode_id, {
      mode: 'fill',
      plan: plan.value,
    })
    applyExternalPlan(result.plan, result.hashes)
    issues.value = result.issues
    notify(t('edit.subtitleSuggested', {
      added: result.added,
      updated: result.updated,
    }))
  } catch (cause) {
    handleActionError(cause, 'edit.subtitleSuggestFailed')
  } finally {
    subtitleBusy.value = false
  }
}

function openRevisions() {
  revisionsOpen.value = true
}

async function loadRevisions() {
  revisionsLoading.value = true
  try {
    revisions.value = (await editAPI.revisions(props.state.episode_id)).items
  } catch (cause) {
    notify(cause?.message || t('edit.versionLoadFailed'))
  } finally {
    revisionsLoading.value = false
  }
}

async function createRevision(note) {
  if (!canEdit.value || revisionBusy.value) return
  revisionBusy.value = true
  try {
    const revision = await createVersion(note || t('edit.versionDefaultNote'))
    if (revision) notify(t('edit.versionCreated'))
    await loadRevisions()
  } catch (cause) {
    handleActionError(cause, 'edit.createRevisionFailed')
  } finally {
    revisionBusy.value = false
  }
}

async function restoreSelectedRevision(revision) {
  if (!canEdit.value || !revision || revisionBusy.value) return
  if (!window.confirm(t('edit.restoreConfirm'))) return
  revisionBusy.value = true
  try {
    await restoreRevision(revision.id)
    pausePlayback()
    currentMs.value = 0
    selection.value = null
    revisionsOpen.value = false
    notify(t('edit.versionRestored'))
  } catch (cause) {
    handleActionError(cause, 'edit.restoreFailed')
  } finally {
    revisionBusy.value = false
  }
}

async function discardDraft() {
  if (!canEdit.value) return
  if (!window.confirm(t('edit.discardConfirm'))) return
  try {
    await discard()
    pausePlayback()
    currentMs.value = 0
    selection.value = null
    notify(t('edit.discarded'))
  } catch (cause) {
    handleActionError(cause, 'edit.discardFailed')
  }
}

async function reloadFromConflict() {
  conflictBusy.value = true
  try {
    await reload()
    pausePlayback()
    currentMs.value = 0
    selection.value = null
    notify(t('edit.conflictReloaded'))
  } catch (cause) {
    notify(cause?.message || t('edit.conflictLoadFailed'))
  } finally {
    conflictBusy.value = false
  }
}

async function overwriteConflict() {
  conflictBusy.value = true
  try {
    await resolveConflict('overwrite')
    notify(t('edit.conflictOverwritten'))
  } catch (cause) {
    notify(cause?.message || t('edit.conflictLoadFailed'))
  } finally {
    conflictBusy.value = false
  }
}

async function copyConflict() {
  try {
    if (!navigator.clipboard?.writeText) throw new Error(t('edit.conflictCopyFailed'))
    await navigator.clipboard.writeText(JSON.stringify(plan.value, null, 2))
    await resolveConflict('reload')
    pausePlayback()
    currentMs.value = 0
    selection.value = null
    notify(t('edit.conflictCopied'))
  } catch (cause) {
    notify(cause?.message || t('edit.conflictCopyFailed'))
  }
}

function useRecovery() {
  acceptRecovery()
  currentMs.value = 0
}

function isTyping(target) {
  if (!target || typeof target !== 'object') return false
  const tag = String(target.tagName || '').toUpperCase()
  return target.isContentEditable === true
    || tag === 'INPUT'
    || tag === 'TEXTAREA'
    || tag === 'SELECT'
}

function onKeydown(event) {
  if (conflict.value) return
  if (shortcutsOpen.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      shortcutsOpen.value = false
    }
    return
  }
  if (isTyping(event.target)) return

  const meta = event.metaKey || event.ctrlKey
  const key = String(event.key || '').toLowerCase()

  if (meta && key === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if (meta && key === 'y') {
    event.preventDefault()
    redo()
    return
  }
  if (meta && key === 's') {
    event.preventDefault()
    void saveImmediately()
    return
  }
  if (meta) return

  if (event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault()
    togglePlayback()
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' ? -1 : 1
    if (event.shiftKey) seek(currentMs.value + direction * 1000)
    else stepFrame(direction)
    return
  }
  if (event.key === 'Home') {
    event.preventDefault()
    seek(0)
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    seek(layout.value.duration_ms)
    return
  }
  if (key === 's') {
    event.preventDefault()
    splitAtPlayhead()
    return
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    removeSelection()
    return
  }
  if (event.key === 'Escape') {
    selection.value = null
  }
}

watch(plan, (value) => {
  const current = selection.value
  if (!current) return
  if (current.type === 'clip' && !value.clips.some((clip) => clip.id === current.id)) {
    selection.value = null
  }
  if (current.type === 'cue' && !value.subtitles.some((cue) => cue.id === current.id)) {
    selection.value = null
  }
})

watch(conflict, (value) => {
  if (value) pausePlayback()
})

watch(sourceMs, (ms) => {
  if (!playing.value) previewRef.value?.seek(ms)
})

onMounted(() => {
  void loadMedia()
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  pausePlayback()
  clearTimeout(messageTimer)
  void saveNow()
})
</script>

<style scoped>
.ed-workbench {
  flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;
  background: var(--bg-base); color: var(--text-0);
}
.ed-banner {
  flex: 0 0 auto; min-height: 30px; padding: 6px 14px; display: flex; align-items: center;
  gap: 10px; border-bottom: 1px solid var(--border); font-size: 11px;
}
.ed-banner span { flex: 1; min-width: 0; }
.ed-banner button {
  height: 22px; padding: 0 9px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-1); color: var(--text-1); font-size: 10px; cursor: pointer;
}
.ed-banner button.is-muted { color: var(--text-3); }
.ed-banner.is-error { background: color-mix(in srgb, var(--danger) 10%, var(--bg-1)); color: var(--danger); }
.ed-banner.is-warning { background: color-mix(in srgb, var(--warning) 10%, var(--bg-1)); color: var(--warning); }
.ed-banner.is-info { background: var(--bg-2); color: var(--text-2); }
.ed-main {
  flex: 1; min-width: 0; min-height: 0; display: grid;
  grid-template-columns: 236px minmax(0, 1fr) 300px;
}
.ed-main.is-empty { grid-template-columns: 236px minmax(0, 1fr); }
.ed-media-slot { min-width: 0; min-height: 0; }
.ed-stage {
  min-width: 0; min-height: 0; display: flex; flex-direction: column;
  gap: 12px; padding: 14px 16px 16px;
}
.ed-modal-mask {
  position: fixed; inset: 0; z-index: 55; display: flex; align-items: center;
  justify-content: center; padding: 24px; background: rgba(0, 0, 0, .5);
}
.ed-shortcuts {
  width: 380px; max-width: 100%; display: flex; flex-direction: column; gap: 10px;
  padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-1);
  box-shadow: 0 18px 50px rgba(0, 0, 0, .35);
}
.ed-shortcuts header { display: flex; align-items: center; justify-content: space-between; }
.ed-shortcuts header b { font-size: 13px; }
.ed-shortcuts header button {
  width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent;
  color: var(--text-2); font-size: 18px; cursor: pointer;
}
.ed-shortcuts dl { display: flex; flex-direction: column; gap: 7px; margin: 0; }
.ed-shortcuts dl div { display: flex; gap: 12px; font-size: 11px; }
.ed-shortcuts dt { flex: 0 0 92px; color: var(--text-3); font-family: ui-monospace, SFMono-Regular, monospace; }
.ed-shortcuts dd { margin: 0; color: var(--text-1); }
@media (max-width: 1180px) {
  .ed-main { grid-template-columns: 220px minmax(0, 1fr) 272px; }
  .ed-main.is-empty { grid-template-columns: 220px minmax(0, 1fr); }
}
@media (max-width: 900px) {
  .ed-main, .ed-main.is-empty { grid-template-columns: minmax(0, 1fr); }
  .ed-media-slot { display: none; }
  .ed-main.is-media-open .ed-media-slot {
    display: flex; position: fixed; left: 0; top: 52px; bottom: 0;
    width: min(280px, 82vw); z-index: 60; box-shadow: 0 0 30px rgba(0, 0, 0, .45);
  }
}
</style>
```

- [ ] **Step 6: 补齐四语文案**

四个语言文件的 `edit` 对象当前最后一项都是 `"clip"`。在 `"clip"` 行末补逗号，然后把下面的键值追加到 `edit` 对象末尾（保持 4 空格缩进，不要新建第二个 `edit` 对象）。同时把已存在的 `emptyHint`、`readonlyHint` 就地替换为新值；`versionDirty` 直接使用下面给出的新文案。

先替换三个已有键（四种语言逐一替换）：

| key | zh | en | ja | ko |
| --- | --- | --- | --- | --- |
| `emptyHint` | 此集还没有可剪辑的片段 | This episode has no clips to edit yet | このエピソードには編集できるクリップがまだありません | 이 에피소드에는 아직 편집할 클립이 없습니다 |
| `readonlyHint` | 只读模式：可预览时间线与成片，编辑、保存、版本与初剪均不可用 | Read-only: preview the timeline and video; editing, saving, versions and rough cut are disabled | 読み取り専用：タイムラインと映像のプレビューのみ。編集・保存・バージョン・ラフカットは利用できません | 읽기 전용: 타임라인과 영상만 미리 볼 수 있으며 편집, 저장, 버전, 러프 컷은 사용할 수 없습니다 |

再追加以下键。

#### `zh.json`

```json
    "actions": "操作",
    "addAll": "全部加入",
    "addedCountToTimeline": "已加入 {n} 个分镜",
    "addedToTimeline": "已加入分镜 {n}",
    "addToTimeline": "加入时间线",
    "alreadyAdded": "已加入时间线",
    "audio": "音频",
    "audioTrack": "音频轨",
    "close": "关闭",
    "conflictCopied": "已复制你的修改并载入服务器版本",
    "conflictCopy": "复制我的修改",
    "conflictCopyFailed": "复制失败，请手动保留修改",
    "conflictCopyHint": "复制会先保存你的计划到剪贴板，再载入服务器版本",
    "conflictHint": "此集已在另一个窗口保存为 v{version}，请选择处理方式",
    "conflictLoadFailed": "处理冲突失败，请重试",
    "conflictOverwritten": "已用你的版本覆盖服务器草稿",
    "conflictOverwrite": "用我的版本覆盖",
    "conflictReload": "载入服务器版本",
    "conflictReloaded": "已载入服务器版本",
    "conflictTitle": "草稿版本冲突",
    "createRevisionFailed": "创建版本失败",
    "deleteClip": "删除片段",
    "deleteKeepGap": "删除并留空",
    "discardConfirm": "放弃当前草稿并回到服务器计划？",
    "discarded": "草稿已放弃",
    "discardDraft": "放弃草稿",
    "discardFailed": "放弃草稿失败",
    "emptyEditableHint": "从左侧素材库加入分镜，或一键初剪生成主轨",
    "emptyLibraryHint": "从左侧素材库加入分镜后即可编辑",
    "fadeIn": "淡入",
    "fadeOut": "淡出",
    "gap": "片段前空档",
    "importDisabled": "导入与代理将在 S3 开放",
    "libraryToggle": "素材库",
    "lineOverflow": "超出片段 {ms}ms",
    "linePlacement": "台词放置",
    "mediaEmpty": "没有匹配素材",
    "mediaLibrary": "素材库",
    "mediaLines": "台词",
    "mediaLoading": "素材加载中…",
    "mediaStoryboards": "分镜",
    "mediaTakes": "配音",
    "mediaUnavailable": "素材不可用",
    "narration": "旁白",
    "noPreview": "当前时间没有画面",
    "noSelection": "选择一个片段查看属性",
    "pause": "暂停",
    "play": "播放",
    "readonlyEdit": "只读模式下不可编辑",
    "recoveryAccept": "恢复",
    "recoveryDismiss": "忽略",
    "recoveryHint": "检测到 {time} 的本地恢复记录",
    "redo": "重做",
    "removeTransition": "删除转场",
    "restoreConfirm": "恢复此版本会覆盖当前草稿，确定继续？",
    "restoreFailed": "恢复版本失败",
    "roughCut": "一键初剪",
    "roughCutConfirm": "一键初剪会替换当前主轨并清空台词字幕，确定继续？",
    "roughCutDone": "初剪完成：加入 {added}，跳过 {skipped}",
    "roughCutFailed": "初剪失败",
    "roughCutRunning": "正在初剪…",
    "roughCutSnapshotNote": "初剪前快照",
    "saveConflict": "有冲突",
    "saveFailed": "保存失败",
    "saveNow": "立即保存",
    "savePending": "待保存",
    "saveRetry": "重试保存",
    "saveSaved": "已保存",
    "saveSaving": "保存中…",
    "saving": "保存中…",
    "searchMedia": "搜索素材",
    "serverClips": "服务器片段数",
    "serverVersion": "服务器版本",
    "shortcutDelete": "Delete / Backspace：删除所选",
    "shortcutEscape": "Esc：取消选择",
    "shortcutHomeEnd": "Home / End：跳到开头 / 结尾",
    "shortcutPlay": "空格：播放 / 暂停",
    "shortcuts": "快捷键",
    "shortcutsTitle": "剪辑快捷键",
    "shortcutSave": "⌘/Ctrl+S：立即保存",
    "shortcutSplit": "S：在播放头分割",
    "shortcutStep": "← / →：逐帧，Shift 为 1 秒",
    "shortcutUndo": "⌘/Ctrl+Z：撤销，Shift+⌘/Ctrl+Z：重做",
    "snap": "吸附",
    "sourceIn": "入点",
    "sourceOut": "出点",
    "speaker": "角色",
    "split": "分割",
    "stepBack": "上一帧",
    "stepForward": "下一帧",
    "storyboardN": "分镜 {n}",
    "subtitleEmpty": "还没有字幕",
    "subtitleHash": "字幕同步",
    "subtitleSuggest": "字幕建议",
    "subtitleSuggestFailed": "字幕建议失败",
    "subtitleSuggested": "字幕建议完成：新增 {added}，更新 {updated}",
    "subtitleSuggestRunning": "正在生成字幕建议…",
    "subtitleTrack": "字幕轨",
    "tailGap": "片尾留白",
    "timelineEmpty": "还没有片段，从素材库加入",
    "transition": "转场",
    "undo": "撤销",
    "untitled": "未命名",
    "updatedAt": "更新时间",
    "versionCreate": "创建版本",
    "versionCreated": "版本已创建",
    "versionCurrent": "当前",
    "versionDefaultNote": "手动版本",
    "versionDirty": "草稿与当前版本不同；创建版本会先保存草稿",
    "versionEmpty": "还没有版本",
    "versionLoadFailed": "版本列表加载失败",
    "versionNote": "版本说明（可选）",
    "versionRestore": "恢复此版本",
    "versionRestored": "已恢复版本",
    "versionTitle": "剪辑版本",
    "videoTrack": "视频轨",
    "zoomIn": "放大",
    "zoomOut": "缩小"
```

#### `en.json`

```json
    "actions": "Actions",
    "addAll": "Add all",
    "addedCountToTimeline": "{n} shots added",
    "addedToTimeline": "Shot {n} added",
    "addToTimeline": "Add to timeline",
    "alreadyAdded": "Already on timeline",
    "audio": "Audio",
    "audioTrack": "Audio track",
    "close": "Close",
    "conflictCopied": "Your changes were copied; server version loaded",
    "conflictCopy": "Copy my changes",
    "conflictCopyFailed": "Copy failed — keep your changes manually",
    "conflictCopyHint": "Copies your plan to the clipboard, then loads the server version",
    "conflictHint": "This episode was saved as v{version} in another window. Choose how to continue.",
    "conflictLoadFailed": "Could not resolve the conflict. Try again.",
    "conflictOverwritten": "Your version overwrote the server draft",
    "conflictOverwrite": "Overwrite with mine",
    "conflictReload": "Load server version",
    "conflictReloaded": "Server version loaded",
    "conflictTitle": "Draft conflict",
    "createRevisionFailed": "Could not create version",
    "deleteClip": "Delete clip",
    "deleteKeepGap": "Delete, keep gap",
    "discardConfirm": "Discard the draft and return to the server plan?",
    "discarded": "Draft discarded",
    "discardDraft": "Discard draft",
    "discardFailed": "Could not discard draft",
    "emptyEditableHint": "Add shots from the media library, or build a rough cut",
    "emptyLibraryHint": "Add shots from the left media library to start editing",
    "fadeIn": "Fade in",
    "fadeOut": "Fade out",
    "gap": "Gap before",
    "importDisabled": "Import and proxies arrive in S3",
    "libraryToggle": "Media library",
    "lineOverflow": "Overflows clip by {ms}ms",
    "linePlacement": "Line placement",
    "mediaEmpty": "No matching media",
    "mediaLibrary": "Media library",
    "mediaLines": "Lines",
    "mediaLoading": "Loading media…",
    "mediaStoryboards": "Storyboards",
    "mediaTakes": "Takes",
    "mediaUnavailable": "Media unavailable",
    "narration": "Narration",
    "noPreview": "No video at this time",
    "noSelection": "Select a clip to inspect",
    "pause": "Pause",
    "play": "Play",
    "readonlyEdit": "Read-only mode",
    "recoveryAccept": "Restore",
    "recoveryDismiss": "Discard",
    "recoveryHint": "Local recovery from {time} found",
    "redo": "Redo",
    "removeTransition": "Remove transition",
    "restoreConfirm": "Restoring overwrites the current draft. Continue?",
    "restoreFailed": "Could not restore version",
    "roughCut": "Rough cut",
    "roughCutConfirm": "Rough cut replaces the video track and clears line subtitles. Continue?",
    "roughCutDone": "Rough cut: {added} added, {skipped} skipped",
    "roughCutFailed": "Rough cut failed",
    "roughCutRunning": "Building rough cut…",
    "roughCutSnapshotNote": "Snapshot before rough cut",
    "saveConflict": "Conflict",
    "saveFailed": "Save failed",
    "saveNow": "Save now",
    "savePending": "Unsaved",
    "saveRetry": "Retry save",
    "saveSaved": "Saved",
    "saveSaving": "Saving…",
    "saving": "Saving…",
    "searchMedia": "Search media",
    "serverClips": "Server clips",
    "serverVersion": "Server version",
    "shortcutDelete": "Delete/Backspace: delete selection",
    "shortcutEscape": "Esc: clear selection",
    "shortcutHomeEnd": "Home/End: jump to start/end",
    "shortcutPlay": "Space: play/pause",
    "shortcuts": "Shortcuts",
    "shortcutsTitle": "Editing shortcuts",
    "shortcutSave": "⌘/Ctrl+S: save now",
    "shortcutSplit": "S: split at playhead",
    "shortcutStep": "← / →: step frames, Shift for 1s",
    "shortcutUndo": "⌘/Ctrl+Z undo, Shift+⌘/Ctrl+Z redo",
    "snap": "Snap",
    "sourceIn": "In point",
    "sourceOut": "Out point",
    "speaker": "Speaker",
    "split": "Split",
    "stepBack": "Previous frame",
    "stepForward": "Next frame",
    "storyboardN": "Shot {n}",
    "subtitleEmpty": "No subtitles yet",
    "subtitleHash": "Subtitle sync",
    "subtitleSuggest": "Suggest subtitles",
    "subtitleSuggestFailed": "Subtitle suggestion failed",
    "subtitleSuggested": "Subtitles: {added} added, {updated} updated",
    "subtitleSuggestRunning": "Suggesting subtitles…",
    "subtitleTrack": "Subtitle track",
    "tailGap": "Tail gap",
    "timelineEmpty": "No clips yet — add from the media library",
    "transition": "Transition",
    "undo": "Undo",
    "untitled": "Untitled",
    "updatedAt": "Updated",
    "versionCreate": "Create version",
    "versionCreated": "Version created",
    "versionCurrent": "Current",
    "versionDefaultNote": "Manual version",
    "versionDirty": "Draft differs from the current version — creating a version saves it first",
    "versionEmpty": "No versions yet",
    "versionLoadFailed": "Could not load versions",
    "versionNote": "Version note (optional)",
    "versionRestore": "Restore",
    "versionRestored": "Version restored",
    "versionTitle": "Versions",
    "videoTrack": "Video track",
    "zoomIn": "Zoom in",
    "zoomOut": "Zoom out"
```

#### `ja.json`

```json
    "actions": "操作",
    "addAll": "すべて追加",
    "addedCountToTimeline": "絵コンテを {n} 件追加しました",
    "addedToTimeline": "絵コンテ {n} を追加しました",
    "addToTimeline": "タイムラインに追加",
    "alreadyAdded": "追加済み",
    "audio": "音声",
    "audioTrack": "音声トラック",
    "close": "閉じる",
    "conflictCopied": "編集をコピーし、サーバー版を読み込みました",
    "conflictCopy": "自分の編集をコピー",
    "conflictCopyFailed": "コピーに失敗しました。変更を手動で保持してください",
    "conflictCopyHint": "自分の計画をクリップボードに保存してからサーバー版を読み込みます",
    "conflictHint": "このエピソードは別のウィンドウで v{version} として保存されました。処理方法を選択してください",
    "conflictLoadFailed": "競合の処理に失敗しました。再試行してください",
    "conflictOverwritten": "自分の版でサーバーの下書きを上書きしました",
    "conflictOverwrite": "自分の版で上書き",
    "conflictReload": "サーバー版を読み込む",
    "conflictReloaded": "サーバー版を読み込みました",
    "conflictTitle": "下書きの競合",
    "createRevisionFailed": "バージョンの作成に失敗しました",
    "deleteClip": "クリップを削除",
    "deleteKeepGap": "削除して空白を残す",
    "discardConfirm": "下書きを破棄してサーバー計画に戻りますか？",
    "discarded": "下書きを破棄しました",
    "discardDraft": "下書きを破棄",
    "discardFailed": "下書きの破棄に失敗しました",
    "emptyEditableHint": "左の素材ライブラリから絵コンテを追加するか、ラフカットを作成してください",
    "emptyLibraryHint": "左の素材ライブラリから絵コンテを追加すると編集できます",
    "fadeIn": "フェードイン",
    "fadeOut": "フェードアウト",
    "gap": "クリップ前の空白",
    "importDisabled": "インポートとプロキシは S3 で提供予定",
    "libraryToggle": "素材ライブラリ",
    "lineOverflow": "クリップから {ms}ms はみ出し",
    "linePlacement": "セリフ配置",
    "mediaEmpty": "一致する素材がありません",
    "mediaLibrary": "素材ライブラリ",
    "mediaLines": "セリフ",
    "mediaLoading": "素材を読み込み中…",
    "mediaStoryboards": "絵コンテ",
    "mediaTakes": "音声テイク",
    "mediaUnavailable": "素材を利用できません",
    "narration": "ナレーション",
    "noPreview": "この時刻に映像がありません",
    "noSelection": "クリップを選択して詳細を表示",
    "pause": "一時停止",
    "play": "再生",
    "readonlyEdit": "読み取り専用モード",
    "recoveryAccept": "復元",
    "recoveryDismiss": "破棄",
    "recoveryHint": "{time} のローカル復元データがあります",
    "redo": "やり直す",
    "removeTransition": "トランジションを削除",
    "restoreConfirm": "このバージョンを復元すると現在の下書きが上書きされます。続行しますか？",
    "restoreFailed": "バージョンの復元に失敗しました",
    "roughCut": "ラフカット",
    "roughCutConfirm": "ラフカットは現在の映像トラックを置き換え、セリフ字幕を消去します。続行しますか？",
    "roughCutDone": "ラフカット完了：{added} 件追加、{skipped} 件スキップ",
    "roughCutFailed": "ラフカットに失敗しました",
    "roughCutRunning": "ラフカット作成中…",
    "roughCutSnapshotNote": "ラフカット前のスナップショット",
    "saveConflict": "競合",
    "saveFailed": "保存失敗",
    "saveNow": "今すぐ保存",
    "savePending": "未保存",
    "saveRetry": "保存を再試行",
    "saveSaved": "保存済み",
    "saveSaving": "保存中…",
    "saving": "保存中…",
    "searchMedia": "素材を検索",
    "serverClips": "サーバーのクリップ数",
    "serverVersion": "サーバーバージョン",
    "shortcutDelete": "Delete / Backspace：選択を削除",
    "shortcutEscape": "Esc：選択を解除",
    "shortcutHomeEnd": "Home / End：先頭 / 末尾へ",
    "shortcutPlay": "Space：再生 / 一時停止",
    "shortcuts": "ショートカット",
    "shortcutsTitle": "編集ショートカット",
    "shortcutSave": "⌘/Ctrl+S：今すぐ保存",
    "shortcutSplit": "S：再生位置で分割",
    "shortcutStep": "← / →：フレーム移動、Shift で 1 秒",
    "shortcutUndo": "⌘/Ctrl+Z 元に戻す、Shift+⌘/Ctrl+Z やり直す",
    "snap": "スナップ",
    "sourceIn": "イン点",
    "sourceOut": "アウト点",
    "speaker": "話者",
    "split": "分割",
    "stepBack": "前のフレーム",
    "stepForward": "次のフレーム",
    "storyboardN": "絵コンテ {n}",
    "subtitleEmpty": "字幕はまだありません",
    "subtitleHash": "字幕同期",
    "subtitleSuggest": "字幕提案",
    "subtitleSuggestFailed": "字幕提案に失敗しました",
    "subtitleSuggested": "字幕提案完了：{added} 件追加、{updated} 件更新",
    "subtitleSuggestRunning": "字幕を提案中…",
    "subtitleTrack": "字幕トラック",
    "tailGap": "末尾余白",
    "timelineEmpty": "クリップがありません。素材ライブラリから追加してください",
    "transition": "トランジション",
    "undo": "元に戻す",
    "untitled": "無題",
    "updatedAt": "更新日時",
    "versionCreate": "バージョンを作成",
    "versionCreated": "バージョンを作成しました",
    "versionCurrent": "現在",
    "versionDefaultNote": "手動バージョン",
    "versionDirty": "下書きが現在のバージョンと異なります。作成前に下書きを保存します",
    "versionEmpty": "バージョンはまだありません",
    "versionLoadFailed": "バージョン一覧の読み込みに失敗しました",
    "versionNote": "バージョンメモ（任意）",
    "versionRestore": "このバージョンを復元",
    "versionRestored": "バージョンを復元しました",
    "versionTitle": "編集バージョン",
    "videoTrack": "映像トラック",
    "zoomIn": "拡大",
    "zoomOut": "縮小"
```

#### `ko.json`

```json
    "actions": "작업",
    "addAll": "모두 추가",
    "addedCountToTimeline": "스토리보드 {n}개 추가됨",
    "addedToTimeline": "스토리보드 {n} 추가됨",
    "addToTimeline": "타임라인에 추가",
    "alreadyAdded": "이미 추가됨",
    "audio": "오디오",
    "audioTrack": "오디오 트랙",
    "close": "닫기",
    "conflictCopied": "내 편집을 복사하고 서버 버전을 불러왔습니다",
    "conflictCopy": "내 편집 복사",
    "conflictCopyFailed": "복사 실패 — 변경 사항을 수동으로 보관하세요",
    "conflictCopyHint": "내 계획을 클립보드에 저장한 후 서버 버전을 불러옵니다",
    "conflictHint": "이 에피소드는 다른 창에서 v{version}(으)로 저장되었습니다. 처리 방법을 선택하세요.",
    "conflictLoadFailed": "충돌 처리에 실패했습니다. 다시 시도하세요.",
    "conflictOverwritten": "내 버전으로 서버 초안을 덮어썼습니다",
    "conflictOverwrite": "내 버전으로 덮어쓰기",
    "conflictReload": "서버 버전 불러오기",
    "conflictReloaded": "서버 버전을 불러왔습니다",
    "conflictTitle": "초안 충돌",
    "createRevisionFailed": "버전 생성 실패",
    "deleteClip": "클립 삭제",
    "deleteKeepGap": "삭제 후 공백 유지",
    "discardConfirm": "초안을 버리고 서버 계획으로 돌아갈까요?",
    "discarded": "초안을 버렸습니다",
    "discardDraft": "초안 버리기",
    "discardFailed": "초안 버리기 실패",
    "emptyEditableHint": "왼쪽 미디어 라이브러리에서 스토리보드를 추가하거나 러프 컷을 만드세요",
    "emptyLibraryHint": "왼쪽 미디어 라이브러리에서 스토리보드를 추가하면 편집할 수 있습니다",
    "fadeIn": "페이드 인",
    "fadeOut": "페이드 아웃",
    "gap": "클립 앞 간격",
    "importDisabled": "가져오기와 프록시는 S3에서 제공됩니다",
    "libraryToggle": "미디어 라이브러리",
    "lineOverflow": "클립보다 {ms}ms 초과",
    "linePlacement": "대사 배치",
    "mediaEmpty": "일치하는 소재가 없습니다",
    "mediaLibrary": "미디어 라이브러리",
    "mediaLines": "대사",
    "mediaLoading": "소재 불러오는 중…",
    "mediaStoryboards": "스토리보드",
    "mediaTakes": "테이크",
    "mediaUnavailable": "소재를 사용할 수 없습니다",
    "narration": "내레이션",
    "noPreview": "현재 시간에 영상이 없습니다",
    "noSelection": "클립을 선택해 속성 보기",
    "pause": "일시정지",
    "play": "재생",
    "readonlyEdit": "읽기 전용 모드",
    "recoveryAccept": "복구",
    "recoveryDismiss": "무시",
    "recoveryHint": "{time}의 로컬 복구 기록이 있습니다",
    "redo": "다시 실행",
    "removeTransition": "전환 삭제",
    "restoreConfirm": "이 버전을 복원하면 현재 초안이 덮어써집니다. 계속할까요?",
    "restoreFailed": "버전 복원 실패",
    "roughCut": "러프 컷",
    "roughCutConfirm": "러프 컷은 현재 비디오 트랙을 교체하고 대사 자막을 지웁니다. 계속할까요?",
    "roughCutDone": "러프 컷 완료: {added}개 추가, {skipped}개 건너뜀",
    "roughCutFailed": "러프 컷 실패",
    "roughCutRunning": "러프 컷 생성 중…",
    "roughCutSnapshotNote": "러프 컷 전 스냅샷",
    "saveConflict": "충돌",
    "saveFailed": "저장 실패",
    "saveNow": "즉시 저장",
    "savePending": "저장 대기",
    "saveRetry": "다시 저장",
    "saveSaved": "저장됨",
    "saveSaving": "저장 중…",
    "saving": "저장 중…",
    "searchMedia": "소재 검색",
    "serverClips": "서버 클립 수",
    "serverVersion": "서버 버전",
    "shortcutDelete": "Delete/Backspace: 선택 항목 삭제",
    "shortcutEscape": "Esc: 선택 해제",
    "shortcutHomeEnd": "Home/End: 처음/끝으로",
    "shortcutPlay": "Space: 재생/일시정지",
    "shortcuts": "단축키",
    "shortcutsTitle": "편집 단축키",
    "shortcutSave": "⌘/Ctrl+S: 즉시 저장",
    "shortcutSplit": "S: 재생 위치에서 분할",
    "shortcutStep": "← / →: 프레임 이동, Shift는 1초",
    "shortcutUndo": "⌘/Ctrl+Z 실행 취소, Shift+⌘/Ctrl+Z 다시 실행",
    "snap": "스냅",
    "sourceIn": "인점",
    "sourceOut": "아웃점",
    "speaker": "화자",
    "split": "분할",
    "stepBack": "이전 프레임",
    "stepForward": "다음 프레임",
    "storyboardN": "스토리보드 {n}",
    "subtitleEmpty": "자막이 없습니다",
    "subtitleHash": "자막 동기화",
    "subtitleSuggest": "자막 제안",
    "subtitleSuggestFailed": "자막 제안 실패",
    "subtitleSuggested": "자막 제안 완료: {added}개 추가, {updated}개 업데이트",
    "subtitleSuggestRunning": "자막 제안 생성 중…",
    "subtitleTrack": "자막 트랙",
    "tailGap": "끝 여백",
    "timelineEmpty": "클립이 없습니다. 미디어 라이브러리에서 추가하세요",
    "transition": "전환",
    "undo": "실행 취소",
    "untitled": "제목 없음",
    "updatedAt": "수정 시간",
    "versionCreate": "버전 만들기",
    "versionCreated": "버전이 생성되었습니다",
    "versionCurrent": "현재",
    "versionDefaultNote": "수동 버전",
    "versionDirty": "초안이 현재 버전과 다릅니다. 버전 생성 시 초안을 먼저 저장합니다",
    "versionEmpty": "버전이 없습니다",
    "versionLoadFailed": "버전 목록을 불러오지 못했습니다",
    "versionNote": "버전 메모(선택)",
    "versionRestore": "이 버전 복원",
    "versionRestored": "버전을 복원했습니다",
    "versionTitle": "편집 버전",
    "videoTrack": "비디오 트랙",
    "zoomIn": "확대",
    "zoomOut": "축소"
```

- [ ] **Step 7: 运行结构测试**

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-structure.test.mjs
```

Expected: PASS。若失败，先检查 JSON 是否仍可解析、`edit` 对象是否只出现一次、`versionDirty` 是否已替换为新文案。

- [ ] **Step 8: S2 最终自动验证**

前端四个测试文件必须全部通过（Node 24）：

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/frontend
node --test tests/edit-structure.test.mjs tests/edit-utils.test.mjs tests/edit-commands.test.mjs tests/edit-save.test.mjs
```

Expected: 全部 PASS，0 failed。

后端全部 `edit-*` 测试必须通过（Node 22）：

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/edit-*.test.ts
```

Expected: 全部 PASS，0 failed；测试输出不得包含真实密钥或非回环 IP。

后端类型检查必须通过（Node 22）：

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama/backend
PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run typecheck
```

Expected: 退出码 0，无 `error TS`。

剪辑页必须只有一个 `<video>`：

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama
grep -c '<video' frontend/app/components/edit/EditPreview.vue
```

Expected: `1`。

确认工作区改动范围（不提交、不构建、不启动）：

```bash
cd /Volumes/软件目录/comfyui/工具/huobao-drama
git status --short
```

Expected: 只出现 S2 计划内文件；不出现构建产物、日志、数据库或媒体文件。

S2 执行到此结束。明确不做：`npm run build`、`npm run dev`、Electron 打包/安装/重启、浏览器人工走查、`git commit`、`git push`。人工验收清单见附录 C，待用户明确同意启动开发服务后再执行。

---

## 附录 A：S2 验收清单与任务映射

“证据”列全部是自动测试或可复现命令，不依赖人工观察。

### A.1 后端

| 验收项 | 规格 | 任务 | 证据 |
| --- | --- | --- | --- |
| 非法/越界 URL 与 URL 编码 episode id 正确解析 | 技术 §7.1 | 1 | `edit-normalize.test.ts` |
| 未知字段丢弃、重复 id/越界值钳制、空计划合法 | 技术 §4.4 | 1 | `edit-normalize.test.ts` |
| 媒体指纹、source 解析与不可播放判定 | 技术 §4.7、§6.3 | 1、3 | `edit-normalize.test.ts`、`edit-bootstrap.test.ts` |
| 单片段/多片段布局、转场重叠、间隙、尾留白、overlay 末端 | 技术 §4.6 | 2 | `edit-timeline.test.ts`、既有 `edit-plan.test.ts` |
| 台词按画面时间放置（含 split、变速、间隙、旁白） | 技术 §6.5、§8.3 | 2 | `edit-timeline.test.ts` |
| 首开 bootstrap 生成单片段或空计划，并创建初始版本 | 技术 §4.7、§4.8 | 3 | `edit-bootstrap.test.ts` |
| 无成片但存在分镜时回退为可播放素材/不可播放占位 | 技术 §4.7、§6.3 | 3 | `edit-bootstrap.test.ts` |
| GET `/edit` 返回 plan、layout、hashes、draft、issues、rough_cut_available、mix_status | 技术 §7.3 | 3、4 | `edit-bootstrap.test.ts`、`edit-media-library.test.ts` |
| GET 素材库包含分镜、配音 take、台词、import_enabled | 产品 §4.4；技术 §10.8 | 4 | `edit-media-library.test.ts` |
| GET 增量返回 placements 与 hash 字段 | 技术 §7.3 | 4 | `edit-media-library.test.ts` |
| PUT 草稿版本递增、`base_version` 冲突 409 携带当前计划、force 覆盖 | 产品 §5.18；技术 §4.8、§7.4 | 5 | `edit-draft-route.test.ts` |
| 非法计划返回 400 `EDIT_PLAN_INVALID` 且不覆盖草稿 | 技术 §4.4、§7.4 | 5 | `edit-draft-route.test.ts` |
| DELETE 丢弃草稿幂等，GET 回退到成片计划 | 产品 §5.18 | 5 | `edit-draft-route.test.ts` |
| 版本列表不变量、详情、创建、恢复生成新版本 | 产品 §5.18；技术 §4.8、§7.5 | 6 | `edit-revision-route.test.ts` |
| 恢复版本不会原地改写旧版本，`is_current` 唯一 | 技术 §4.8 | 6 | `edit-revision-route.test.ts` |
| 初剪 replace 重建主轨并清空台词字幕，append 跳过已有 source | 产品 §4.4；技术 §7.6 | 7 | `edit-actions.test.ts` |
| 初剪快照版本、非法输入、空结果 | 产品 §5.18；技术 §7.6 | 7 | `edit-actions.test.ts` |
| 字幕建议 fill 仅补缺失、replace 仅重建 `source='line'`，保留手动字幕 | 产品 §5.11；技术 §6.4 | 7 | `edit-actions.test.ts` |
| `edit_workspace=readonly/off` 时所有写接口 403 且不落库 | 全局约束 | 5、6、7 | `edit-draft-route.test.ts`、`edit-revision-route.test.ts`、`edit-actions.test.ts` |
| 哈希在计划/台词/字幕变化时正确失效 | 技术 §4.5 | 4、5 | `edit-media-library.test.ts`、`edit-draft-route.test.ts` |

### A.2 前端

| 验收项 | 规格 | 任务 | 证据 |
| --- | --- | --- | --- |
| 类型、布局、时间码、吸附、跟随字幕纯函数 | 产品 §4.5、§4.6、§5.17；技术 §10.3 | 8 | `edit-utils.test.mjs` |
| 添加、移动、裁剪、分割、删除/留空、变速、转场、淡入淡出命令不可变 | 产品 §5.1–§5.8；技术 §10.4 | 9 | `edit-commands.test.mjs` |
| 撤销/重做快照、命令合并边界、历史上限 | 产品 §5.18；技术 §10.4 | 9 | `edit-commands.test.mjs` |
| 300ms 防抖自动保存、串行队列、flush 不丢最后一次编辑 | 产品 §5.18；技术 §10.5 | 10 | `edit-save.test.mjs` |
| 409 冲突、force 覆盖、重载服务器版本、复制本地计划 | 产品 §5.18；技术 §10.5 | 10、12、13 | `edit-save.test.mjs`、`edit-structure.test.mjs` |
| localStorage 恢复记录写入、读取、清除与 fingerprint 校验 | 产品 §5.18 | 10 | `edit-save.test.mjs` |
| 单 `<video>` 预览、活动片段切换、硬切、无第二传输层 | 产品 §4.5、§5.17；技术 §10.6（偏差：DOM） | 11 | `edit-structure.test.mjs` |
| DOM 时间线刻度、片段、字幕轨、播放头、选择、拖拽、裁剪手柄 | 产品 §4.6、§5.2–§5.6；技术 §10.6（偏差：DOM） | 11 | `edit-structure.test.mjs` |
| 素材库搜索/分类/加入/全部加入/不可用态 | 产品 §4.4、§5.1；技术 §10.8 | 12 | `edit-structure.test.mjs` |
| 检查器编辑片段与字幕、转场、淡入淡出、台词放置 | 产品 §4.7、§5.4–§5.11；技术 §10.9 | 12 | `edit-structure.test.mjs` |
| 版本抽屉创建/恢复/空态/只读禁用 | 产品 §5.18；技术 §10.11 | 12 | `edit-structure.test.mjs` |
| 冲突对话框三种处置与复制失败提示 | 产品 §5.18；技术 §10.5 | 12 | `edit-structure.test.mjs` |
| 空态初剪入口与只读提示 | 产品 §9.2 | 13 | `edit-structure.test.mjs` |
| 顶栏保存状态、撤销/重做、版本、字幕建议入口 | 产品 §4.3、§5.18 | 13 | `edit-structure.test.mjs` |
| 快捷键 Space/←/→/Home/End/S/Delete/Esc/⌘S/⌘Z | 产品 §5.19；技术 §10.13 | 13 | `edit-structure.test.mjs` + 附录 C 人工确认 |
| 四语 118 个新增键完整、非空 | 产品 §11.4 | 13 | `edit-structure.test.mjs` |
| 只读模式无任何本地变更入口 | 全局约束 | 10、13 | `edit-save.test.mjs`、`edit-structure.test.mjs` |

## 附录 B：计划自检

### B.1 规格覆盖

| 规格章节 | 覆盖任务 |
| --- | --- |
| 产品 §4.3 顶部栏 | 13 |
| 产品 §4.4 素材库 | 4、12、13 |
| 产品 §4.5 预览与运输条 | 8、11、13 |
| 产品 §4.6 时间线 | 2、8、11 |
| 产品 §4.7 检查器 | 12 |
| 产品 §5.1 添加到时间线 | 4、9、12 |
| 产品 §5.2 选择 | 11、12 |
| 产品 §5.3 移动、排序与插入 | 9、11 |
| 产品 §5.4 裁剪 | 9、11、12 |
| 产品 §5.5 分割 | 9、11、12 |
| 产品 §5.6 删除、波纹与留空 | 9、11、12 |
| 产品 §5.7 变速 | 9、12 |
| 产品 §5.8 转场 | 9、12 |
| 产品 §5.9 画面适配与变换 | 1、9（数据层与归一化；S2 不做变换 UI） |
| 产品 §5.11 字幕 | 2、7、9、11、12 |
| 产品 §5.15 声音参考与跳转混音 | 1、4（音频归一化与 `mix_status` 透出；S2 不做跨页跳转） |
| 产品 §5.17 播放头与预览规则 | 8、11、13 |
| 产品 §5.18 撤销、重做、自动保存与版本 | 5、6、9、10、12、13 |
| 产品 §5.19 快捷键 | 13 |
| 产品 §5.21 工程设置 | 5（草稿持久化）、12（只读展示） |
| 产品 §7 混音边界 | 4（GET 透出 mix_status）、13（跨页入口） |
| 产品 §9.2 空态 | 13 |
| 产品 §11.4 国际化 | 13 |
| 技术 §4.4 校验与归一化 | 1 |
| 技术 §4.5 哈希 | 4、5 |
| 技术 §4.6 布局算法 | 2 |
| 技术 §4.7 bootstrap | 3 |
| 技术 §4.8 版本、草稿与导出快照 | 3、5、6 |
| 技术 §6.3 edit-media | 1、3、4 |
| 技术 §6.4 edit-service | 3、5、6、7 |
| 技术 §6.5 edit-timeline | 2 |
| 技术 §7.3 GET /edit | 3、4 |
| 技术 §7.4 PUT /edit/draft | 5 |
| 技术 §7.5 POST /edit/revisions | 6 |
| 技术 §7.6 POST /edit/rough-cut | 7 |
| 技术 §10.3 useEditPlan | 10 |
| 技术 §10.4 命令、历史与撤销 | 9 |
| 技术 §10.5 自动保存与冲突 | 10、12、13 |
| 技术 §10.6 时间线渲染 | 8、11（偏差：DOM） |
| 技术 §10.8 素材库 | 12 |
| 技术 §10.9 检查器 | 12 |
| 技术 §10.11 版本与差异 | 6、12（不做 diff） |
| 技术 §10.13 键盘、国际化与可访问性 | 13 |
| 技术 §13.2 后端纯函数测试 | 1、2 |
| 技术 §13.3 服务与 API 测试 | 3–7 |
| 技术 §13.5 前端测试 | 8–13 |

### B.2 占位符扫描

已人工扫描并确认计划正文中不存在以下内容：

- `TBD`、`TODO`、`待补`、`稍后实现`、`类似 Task N`。
- 只有动作描述、没有代码的“实现步骤”。
- 只写“添加错误处理/边界情况”而不给出具体分支与错误码的步骤。
- 未定义的函数、类型、路由或字段引用。

### B.3 类型与命名一致性

已核对以下名称在全部任务中保持同一拼写与语义：

- 计划与服务：`EditPlanV1`、`normalizeEditPlan`、`computeLayout`、`planHashOf`、`renderHashOf`、`editSyncHashOf`、`subtitleHashOf`、`buildEditTimeline`、`planHashes`。
- 草稿与版本：`saveEditDraft`、`discardEditDraft`、`EditRevisionSummary`、`listEditRevisions`、`getEditRevision`、`createEditRevision`、`restoreEditRevision`。
- 响应：`EditLayoutResponse`、`EditWorkspaceState`、`EditMediaLibrary`、`EditIssue`、`EditConflict`、`EDIT_VERSION_CONFLICT`、`EDIT_PLAN_INVALID`、`EDIT_READONLY`、`EDIT_WORKSPACE_OFF`。
- 前端：`EditPlanV1`、`EditClip`、`EditSubtitleCue`、`EditSelection`、`EditCommandResult`、`applyCommand`、`createEditHistory`、`createEditSaveQueue`、`writeRecovery`、`readRecovery`、`useEditPlan`、`useEditMedia`。
- 组合式函数返回：`plan`、`layout`、`hashes`、`version`、`dirty`、`canEdit`、`saveStatus`、`saveError`、`lastSavedAt`、`conflict`、`recovery`、`issues`、`canUndo`、`canRedo`、`planHash`、`applyCommand`、`applyExternalPlan`、`undo`、`redo`、`saveNow`、`retrySave`、`discard`、`reload`、`createVersion`、`restoreRevision`、`resolveConflict`、`acceptRecovery`、`dismissRecovery`。
- 组件 props/emits：`EditTopBar` 的 `saveStatus/dirty/canUndo/canRedo/canEdit/roughCutBusy/subtitleBusy`；`EditPreview` 的 `src/poster/plan/activeClipId/clipKey/sourceMs/currentMs/durationMs/fps/playing/audioMode/playbackRate`；`EditTimeline` 的 `plan/layout/currentMs/selectedClipId/selectedCueId/readonly/audioMode`；`EditMediaLibrary` 的 `media/loading/error/readonly/usedStoryboardIds/roughCutAvailable`；`EditClipInspector` 的 `plan/layout/clipId/placement/state/currentMs/readonly`；`EditRevisionsDrawer` 的 `open/revisions/loading/draftDirty/canEdit`；`EditConflictDialog` 的 `conflict/loading`，emits 为 `reload/overwrite/copy`。

### B.4 已知偏差（再次确认）

| 偏差 | 原因 | 影响 |
| --- | --- | --- |
| DOM 时间线替代 Canvas | S2 优先可测试、可访问与实现速度 | 长剧集性能上限低于 Canvas；S3 可按需替换 |
| 单 `<video>`，转场处硬切 | 不伪造叠化预览 | 转场数据可编辑可保存，精确叠化预览留待 S3 |
| 导入/代理禁用 | S3 范围 | 素材库只展示已有分镜与配音 |
| 初剪作为可撤销外部计划 + 自动保存 | 保持单一计划真相源 | 服务端初剪结果在本地历史中可撤销 |
| 字幕建议不自动写回台词本 | P1 范围 | 只生成 `source='line'` 字幕 |
| 无版本 diff | P1 范围 | 版本抽屉只展示摘要与恢复 |

## 附录 C：人工验收清单（待用户同意启动服务后执行）

以下步骤不在 S2 自动执行范围内；执行前必须获得用户对“启动开发服务/浏览器走查”的明确同意。

1. 以 `edit_workspace=on` 打开一集已有成片的剪辑页：应看到单片段主轨、预览可播放、时间线刻度与播放头同步。
2. 空剧集：显示空态；点击“一键初剪”后生成主轨，提示台词字幕已清空；撤销可回到空态。
3. 从素材库添加分镜：播放头附近插入、自动吸附、片段前间隙可调；全部加入跳过已存在素材。
4. 选择片段后拖动排序、拖两端裁剪、按 S 分割、Delete 删除；波纹删除与留空删除结果不同。
5. 修改入点/出点/速度/音量/淡入淡出/转场：时间线与时长为即时更新，预览在当前时间保持有效画面。
6. 连续编辑后等待 300ms：顶栏从“保存中”变为“已保存”；刷新页面后草稿仍在。
7. 同一集开两个标签页：后保存者出现冲突对话框；分别验证“载入服务器版本”“用我的版本覆盖”“复制我的修改”。
8. 编辑后立即关闭标签页（赶在防抖保存前）：重新打开出现本地恢复提示；恢复后内容正确，忽略后记录清除。
9. 创建版本并填写说明；修改草稿后恢复旧版本：生成新版本且当前草稿被覆盖，旧版本仍可查看。
10. 只读模式：顶栏显示只读，所有编辑、保存、版本、初剪入口禁用；用 curl 直接请求写接口返回 403。
11. 字幕：手动添加/编辑字幕后执行“字幕建议”；fill 不覆盖手动字幕，replace 只重建台词字幕。
12. 切换 zh/en/ja/ko：新增按钮、提示、错误与冲突文案均无缺失或英文占位。
13. 全页检查：只有一个 `<video>`，没有第二套播放/暂停控件；音频由该 `<video>` 输出。

## 附录 D：S2 明确不做

- 不做服务端渲染、导出、视频池、精确叠化预览（S3）。
- 不做混音桥接改造、realign UI（S4）。
- 不做导入上传、代理生成、叠加轨 UI、滤镜 UI、文字/标题、Take 切换 UI、标记、版本 diff、字幕回写台词本（P1）。
- 不新增端口、不修改 `TEMPLATE_VERSION`、不触碰 MCP 配置与 V3-G5 验收状态。
- 不构建、不打包、不安装、不重启服务、不提交 git。


