# 声音场景生成（Soundscape）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依据现有剧集/场景/分镜/台词设定，用本地 ComfyUI Stable Audio Open 生成环境声、场景音效、群众声与可选 BGM，并自动放入现有混音工作台的多轨时间线。

**Architecture:** 新增独立 `audio-gen` AI 服务类型（TTS 的 `audio` 类型完全不动），由 `soundscape-compiler` 把合片后的绝对时间轴与中文设定编译成英文生成项，`soundscape` 服务复用 `dubbing_jobs` 做任务编排与进度，`comfyui-audio` 适配器负责数值安全的占位符注入、提交、轮询、下载，最后按类别自动建轨/放置片段并让 `compileMixPlan` 兼容生成轨。

**Tech Stack:** Hono + Drizzle ORM + better-sqlite3；Nuxt 3 / Vue 3；ComfyUI HTTP API；FFmpeg / ffprobe / loudnorm；Node test runner（`tsx --test`、`node --test`）。

**Spec:** `docs/superpowers/specs/2026-11-06-soundscape-generation-design.md`

## Global Constraints

- **TTS 先不改**：不得修改 `audio` 服务类型、TTS 调用链、`line_takes` 生成逻辑；群众台词模式只复用已有激活 Take，绝不调用 TTS。
- **一套 UI/传输**：生成入口放在现有 `MixStage`，不新增独立页面或播放器。
- **服务端权威**：`origin` 只由服务端写；前端保存混音计划不能修改 `origin`；客户端不能伪造生成轨。
- **安全**：日志不得打印 API Key、完整工作流或完整配置；不得输出 DSH 密码、服务器 IP、`ps ssh` 结果。
- **固定端口**：ComfyUI `8188`/`8189`、H3 `8192`、TTS `18190` 不得改动；MCP 与模板不变。
- **G5 状态不变**：本计划不处理 G5。
- **不自动提交/构建/安装/启动**：每个任务只保留未提交改动；`git commit`、`npm run build`、打包、安装、重启应用都必须等用户明确批准。前端 SFC 的最终构建门禁放在 Task 15，执行前单独请求批准。
- **测试环境隔离**：后端测试先设置 `SQLITE_PATH`、`HUOBAO_DATA_DIR`、`STORAGE_PATH`、`MYSQL_AUTO_IMPORT=false`，再动态 import 业务模块。
- **文件路径**：所有代码块中的路径均相对仓库根目录 `/Volumes/软件目录/comfyui/工具/huobao-drama`。

---

## 文件地图

**新建**

| 文件 | 职责 |
|---|---|
| `backend/src/services/adapters/comfyui-audio.ts` | 音频工作流数值占位符、提交、轮询、音频产物提取、下载、取消 |
| `backend/src/services/soundscape-compiler.ts` | 时间轴切片、场景/分镜/台词整理、LLM 提示词编译、规则降级、覆盖项、种子与哈希 |
| `backend/src/services/soundscape-tracks.ts` | 四类 AI 轨的创建/复用、片段重建、淡入淡出与循环 |
| `backend/src/services/soundscape.ts` | 任务编排、素材缓存、进度、取消、重启恢复、素材落库 |
| `backend/tests/comfyui-audio.test.ts` | 适配器单元测试 |
| `backend/tests/soundscape-compiler.test.ts` | 编译器测试 |
| `backend/tests/soundscape-tracks.test.ts` | 建轨与片段测试 |
| `backend/tests/soundscape.test.ts` | 编排、缓存、取消、部分失败测试 |
| `frontend/app/components/MixSoundscapeDialog.vue` | 生成参数与预览弹窗 |
| `frontend/tests/mix-soundscape-structure.test.mjs` | 前端结构/文案门禁 |

**修改**

| 文件 | 改动 |
|---|---|
| `backend/src/db/schema.ts` | `episode_audio_tracks.origin`；`MixTrack.origin` 数据源 |
| `backend/src/db/sqlite-schema.ts` | 建表与增量列 `origin` |
| `backend/src/services/audio-tracks.ts` | `AudioTrackInput.origin`、创建时写入、更新时忽略 |
| `backend/src/services/ai.ts` | `ServiceType` 增加 `audio-gen`，`officialProviders` 增加 ComfyUI |
| `backend/src/services/adapters/comfyui.ts` | `ComfyUiSettings` 增加 `timeoutMs / normalizeLoudness / modelLicense` |
| `backend/src/routes/aiConfigs.ts` | `audio-gen + comfyui` 工作流与 `__PROMPT__` 校验 |
| `backend/src/services/timeline.ts` | `TimelineResult.clips` |
| `backend/src/services/mix-plan.ts` | `MixTrack.origin`、原声床判断、虚拟对白排除群众台词 |
| `backend/src/services/audio-separation.ts` | 删除素材清理引用片段；自动建轨跳过 `soundscape` |
| `backend/src/routes/mix.ts` | soundscape 路由、错误映射、保存互斥 |
| `frontend/app/composables/useApi.ts` | `MixTrack.origin`、soundscape 类型与 API |
| `frontend/app/composables/useMixStage.ts` | 生成状态、轮询、取消、保存/导出互斥 |
| `frontend/app/components/MixStage.vue` | 入口、弹窗、进度、AI 进度状态 |
| `frontend/app/components/MixTrackHead.vue` | 生成轨 AI 徽标 |
| `frontend/app/components/DubbingStage.vue` | 生成中禁止进入下一步 |
| `frontend/app/pages/settings.vue` | `audio-gen` 服务配置 |
| `frontend/app/locales/{zh,en,ja,ko}.json` | 四语言文案 |
| `backend/tests/{timeline,mix-plan,audio-tracks,ai-config-settings}.test.ts` | 回归与新增用例 |

---

## Task 1: 音轨来源字段 `origin`

**Files:**
- Modify: `backend/src/db/schema.ts:765-790`
- Modify: `backend/src/db/sqlite-schema.ts:444-458, 1159-1170`
- Modify: `backend/src/services/audio-tracks.ts:50-69, 205-238`
- Modify: `backend/src/services/mix-plan.ts:107-127, 276-296, 333-375, 389-430, 467-493`
- Modify: `frontend/app/composables/useApi.ts:615-635`
- Modify: `frontend/app/composables/useMixStage.ts:619-647`
- Test: `backend/tests/audio-tracks.test.ts`

**Interfaces:**
- Produces: `AudioTrackInput.origin?: string | null`；`MixTrack.origin: string | null`。
- Consumes: 无。

- [ ] **Step 1: 写失败测试**

在 `backend/tests/audio-tracks.test.ts` 末尾追加：

```ts
test('origin 只能由内部创建写入，更新接口忽略 origin', async () => {
  const { createAudioTrack, updateAudioTrack } = await import('../src/services/audio-tracks.ts')
  const created = createAudioTrack(episode.id, {
    kind: 'ambience',
    role: 'ambience',
    name: '环境声（AI）',
    origin: 'soundscape',
  })
  assert.equal(created.origin, 'soundscape')

  const updated = updateAudioTrack(episode.id, created.id, {
    name: '改名后仍是生成轨',
    origin: null,
  } as any)
  assert.equal(updated.origin, 'soundscape')
  assert.equal(updated.name, '改名后仍是生成轨')

  const userTrack = createAudioTrack(episode.id, { kind: 'sfx', name: '用户音效' })
  assert.equal(userTrack.origin, null)

  const response = await app.request(`/episodes/${episode.id}/audio/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'ambience', name: '伪造轨', origin: 'soundscape' }),
  })
  assert.equal((await body(response)).data.origin, null)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/audio-tracks.test.ts`
Expected: FAIL，`created.origin` 为 `undefined`。

- [ ] **Step 3: 最小实现**

`backend/src/db/schema.ts` 在 `sortOrder` 后增加：

```ts
  /** 服务端来源：soundscape=AI 生成轨；用户轨为空 */
  origin: text('origin'),
```

`backend/src/db/sqlite-schema.ts` 基础建表增加列：

```sql
    sort_order INTEGER DEFAULT 0,
    origin TEXT,
    created_at TEXT NOT NULL,
```

`trackWorkbenchColumns` 增加：

```ts
    origin: 'TEXT',
```

`backend/src/services/audio-tracks.ts` 的 `AudioTrackInput` 增加：

```ts
  origin?: string | null
```

`createAudioTrack` 的 insert values 增加：

```ts
    origin: input.origin === 'soundscape' ? 'soundscape' : null,
```

`updateAudioTrack` 不增加 `origin` 分支。`backend/src/routes/audio-tracks.ts` 不转发 `body.origin`。

`backend/src/services/mix-plan.ts` 的 `MixTrack` 增加：

```ts
  origin: string | null
```

三个虚拟轨对象各增加 `origin: null`；数据库轨映射增加：

```ts
      origin: row.origin ?? null,
```

`frontend/app/composables/useApi.ts` 的 `MixTrack` 增加：

```ts
  origin: string | null
```

`frontend/app/composables/useMixStage.ts` 的 `addTrack` 对象增加：

```ts
      origin: null,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --test tests/audio-tracks.test.ts`
Expected: PASS，全部用例通过。

---

## Task 2: `audio-gen` 服务类型与 ComfyUI 配置校验

**Files:**
- Modify: `backend/src/services/ai.ts:9, 42-50`
- Modify: `backend/src/services/adapters/comfyui.ts:19-47`
- Modify: `backend/src/routes/aiConfigs.ts:48-66`
- Test: `backend/tests/ai-config-settings.test.ts`

**Interfaces:**
- Produces: `ServiceType` 含 `'audio-gen'`；`ComfyUiSettings.timeoutMs / normalizeLoudness / modelLicense`。
- Consumes: 无。

- [ ] **Step 1: 写失败测试**

在 `backend/tests/ai-config-settings.test.ts` 末尾追加：

```ts
test('audio-gen 只接受 ComfyUI，且工作流必须含 __PROMPT__', async () => {
  const base = {
    service_type: 'audio-gen',
    provider: 'comfyui',
    name: '本地音频生成',
    base_url: 'http://127.0.0.1:8188',
    api_key: '',
    model: ['stable-audio-open-1.0'],
    priority: 10,
    provider_settings: {
      workflow: { '3': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '__MODEL__' } } },
      output_node: '9',
      output_key: 'audio',
      timeout_ms: 600000,
      normalize_loudness: true,
      model_license: 'stability-ai-community',
    },
  }

  const missingPrompt = await app.request('/api/v1/ai-configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(base),
  })
  assert.equal(missingPrompt.status, 400)

  const withPrompt = await app.request('/api/v1/ai-configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...base,
      provider_settings: {
        ...base.provider_settings,
        workflow: {
          '3': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '__MODEL__' } },
          '6': { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
        },
      },
    }),
  })
  assert.equal(withPrompt.status, 201, await withPrompt.clone().text())

  const badProvider = await app.request('/api/v1/ai-configs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, provider: 'openai' }),
  })
  assert.equal(badProvider.status, 400)
})
```

如果测试文件里 Hono app 变量的名字不是 `app`，按该文件现有变量名替换。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/ai-config-settings.test.ts`
Expected: FAIL，含 `__PROMPT__` 的请求仍返回 400 或 provider 校验未生效。

- [ ] **Step 3: 最小实现**

`backend/src/services/ai.ts`：

```ts
export type ServiceType = 'text' | 'image' | 'video' | 'audio' | 'audio-gen'
```

```ts
  audio: ['qwen3-tts', 'aliyun', 'volcengine', 'openai-compatible'],
  /** 环境声/音效/群众声/BGM：本地 ComfyUI 音频工作流 */
  'audio-gen': ['comfyui'],
```

`backend/src/services/adapters/comfyui.ts` 的 `ComfyUiSettings` 增加：

```ts
  timeoutMs?: number
  normalizeLoudness?: boolean
  modelLicense?: string
```

`readComfySettings` 返回值增加：

```ts
    timeoutMs: typeof settings.timeout_ms === 'number' && settings.timeout_ms > 0
      ? Math.round(settings.timeout_ms)
      : undefined,
    normalizeLoudness: typeof settings.normalize_loudness === 'boolean'
      ? settings.normalize_loudness
      : undefined,
    modelLicense: typeof settings.model_license === 'string' && settings.model_license.trim()
      ? settings.model_license.trim()
      : undefined,
```

`backend/src/routes/aiConfigs.ts` 的 `validateProviderSettings` 改为：

```ts
function validateProviderSettings(serviceType: string, provider: string, settings: Record<string, any>) {
  if (provider !== 'comfyui') return
  if (serviceType !== 'image' && serviceType !== 'video' && serviceType !== 'audio-gen') return
  const workflow = settings.workflow
  if (!workflow) throw new Error('ComfyUI 需要 workflow（API 格式工作流 JSON）')
  let serialized = ''
  if (typeof workflow === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(workflow)
    } catch {
      throw new Error('ComfyUI workflow 不是合法 JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ComfyUI workflow 必须是节点对象')
    }
    serialized = workflow
  } else {
    if (typeof workflow !== 'object' || Array.isArray(workflow)) {
      throw new Error('ComfyUI workflow 必须是节点对象')
    }
    serialized = JSON.stringify(workflow)
  }
  if (serviceType === 'audio-gen' && !serialized.includes('__PROMPT__')) {
    throw new Error('音频工作流必须包含 __PROMPT__ 占位符')
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --test tests/ai-config-settings.test.ts`
Expected: PASS。

---

## Task 3: 时间轴返回分镜位置

**Files:**
- Modify: `backend/src/services/timeline.ts:65-73, 86-96, 220`
- Test: `backend/tests/timeline.test.ts`

**Interfaces:**
- Produces: `TimelineClipPosition { storyboardId; startMs; endMs; durationMs }`；`TimelineResult.clips`。
- Consumes: 无。

- [ ] **Step 1: 写失败测试**

在 `backend/tests/timeline.test.ts` 末尾追加：

```ts
test('clips 返回每个分镜的绝对位置，累加与总时长一致', () => {
  const result = buildTimeline({
    clips: [clip(1, 2000), clip(2, 3000)],
    lines: [],
  })
  assert.deepEqual(result.clips, [
    { storyboardId: 1, startMs: 0, endMs: 2000, durationMs: 2000 },
    { storyboardId: 2, startMs: 2000, endMs: 5000, durationMs: 3000 },
  ])
  assert.equal(result.clips.reduce((sum, item) => sum + item.durationMs, 0), result.totalDurationMs)
})

test('clips 在传入更长的总时长时保持真实分镜位置', () => {
  const result = buildTimeline({
    clips: [clip(1, 2000), clip(2, 3000)],
    lines: [],
    totalDurationMs: 8000,
  })
  assert.equal(result.clips[0].startMs, 0)
  assert.equal(result.clips[1].startMs, 2000)
  assert.equal(result.clips[1].endMs, 5000)
  assert.equal(result.totalDurationMs, 8000)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/timeline.test.ts`
Expected: FAIL，`result.clips` 为 `undefined`。

- [ ] **Step 3: 最小实现**

`backend/src/services/timeline.ts` 增加接口：

```ts
export interface TimelineClipPosition {
  storyboardId: number
  startMs: number
  endMs: number
  durationMs: number
}
```

`TimelineResult` 增加：

```ts
  clips: TimelineClipPosition[]
```

`buildTimeline` 在构建 `clipStart` 的循环后增加：

```ts
  const clipPositions: TimelineClipPosition[] = clips.map((clip) => {
    const span = clipStart.get(clip.storyboardId)!
    return {
      storyboardId: clip.storyboardId,
      startMs: span.startMs,
      endMs: span.endMs,
      durationMs: span.endMs - span.startMs,
    }
  })
```

返回值改为：

```ts
  return {
    cues,
    clips: clipPositions,
    totalDurationMs,
    maxOverflowMs,
    overlapCount,
    atempoCount,
    trimmedCount,
    skippedLineIds,
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --test tests/timeline.test.ts`
Expected: PASS。

---

## Task 4: ComfyUI 音频适配器

**Files:**
- Create: `backend/src/services/adapters/comfyui-audio.ts`
- Test: `backend/tests/comfyui-audio.test.ts`

**Interfaces:**
- Consumes: `parseComfyWorkflow`、`readComfySettings`、`comfyHeaders`、`unwrapComfyHistory`、`buildComfyViewUrl`、`joinProviderUrl`。
- Produces:
  - `applyAudioWorkflowPlaceholders(workflow, values): Record<string, unknown>`
  - `extractComfyAudioOutput(result, outputNode, outputKey): { item?; error?; pending? }`
  - `runComfyAudio(input): Promise<AudioGenerateResult>`
  - `cancelComfyPrompt(config, promptId, fetchImpl?): Promise<void>`
  - `assertAudioWorkflowPrompt(workflow): void`

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/comfyui-audio.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  applyAudioWorkflowPlaceholders,
  assertAudioWorkflowPrompt,
  extractComfyAudioOutput,
  runComfyAudio,
} from '../src/services/adapters/comfyui-audio.ts'

const wavBytes = Buffer.from('RIFF0000WAVEfmt ')

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('数值占位符整串替换为数字，嵌入文本仍按字符串拼接', () => {
  const workflow = {
    '6': { inputs: { text: '__PROMPT__', seconds: '__AUDIO_SECONDS__', seed: '__SEED__' } },
    '7': { inputs: { note: 'duration __AUDIO_SECONDS__ s', negative: '__NEGATIVE_PROMPT__' } },
  }
  const result = applyAudioWorkflowPlaceholders(workflow, {
    PROMPT: 'rain on a street',
    NEGATIVE_PROMPT: 'music, dialogue',
    AUDIO_SECONDS: 45,
    SEED: 12345,
  })
  const node6 = (result['6'] as any).inputs
  assert.equal(node6.text, 'rain on a street')
  assert.equal(node6.seconds, 45)
  assert.equal(node6.seed, 12345)
  assert.equal((result['7'] as any).inputs.note, 'duration 45 s')
})

test('音频产物只认音频扩展名，兼容 audios 键', () => {
  const result = {
    outputs: {
      '9': {
        audios: [{ filename: 'a.wav', subfolder: '', type: 'output' }],
        images: [{ filename: 'a.png', subfolder: '', type: 'output' }],
      },
    },
  }
  const found = extractComfyAudioOutput(result, undefined, undefined)
  assert.equal(found.item?.filename, 'a.wav')
})

test('runComfyAudio 提交、轮询、下载并返回音频', async () => {
  const calls: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/prompt')) return jsonResponse({ prompt_id: 'p1' })
    if (url.includes('/history/p1')) {
      return jsonResponse({
        p1: {
          status: { status_str: 'success', completed: true },
          outputs: { '9': { audio: [{ filename: 'tone.wav', subfolder: '', type: 'output' }] } },
        },
      })
    }
    if (url.includes('/view?')) {
      return new Response(wavBytes, { status: 200, headers: { 'Content-Type': 'audio/wav' } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  const result = await runComfyAudio({
    config: {
      provider: 'comfyui',
      baseUrl: 'http://127.0.0.1:8188',
      apiKey: '',
      model: 'stable-audio-open-1.0',
      settings: {
        workflow: {
          '6': { inputs: { text: '__PROMPT__', seconds: '__AUDIO_SECONDS__', seed: '__SEED__' } },
        },
        output_node: '9',
        output_key: 'audio',
      },
    },
    prompt: 'rain',
    negativePrompt: 'music',
    seconds: 30,
    seed: 7,
    model: 'stable-audio-open-1.0',
    timeoutMs: 5000,
    pollIntervalMs: 1,
    fetchImpl,
  })

  assert.equal(result.extension, 'wav')
  assert.deepEqual(result.buffer, wavBytes)
  assert.ok(calls.some((url) => url.endsWith('/prompt')))
  assert.ok(calls.some((url) => url.includes('/history/p1')))
  assert.ok(calls.some((url) => url.includes('/view?')))
})

test('工作流缺少 __PROMPT__ 时拒绝生成', () => {
  assert.throws(
    () => assertAudioWorkflowPrompt({ '6': { inputs: { text: 'fixed' } } }),
    /__PROMPT__/,
  )
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/comfyui-audio.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现适配器**

创建 `backend/src/services/adapters/comfyui-audio.ts`：

```ts
/**
 * ComfyUI 音频工作流适配器（Stable Audio Open）
 *
 * 不复用 applyWorkflowPlaceholders：共享函数会把 seconds/seed 变成字符串，
 * Stable Audio Open 的数值输入会拒绝或被静默截断。
 */
import type { AIConfig } from './types'
import { joinProviderUrl } from './url'
import {
  buildComfyViewUrl,
  comfyHeaders,
  parseComfyWorkflow,
  readComfySettings,
  unwrapComfyHistory,
} from './comfyui'

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac'] as const
const AUDIO_EXT_RE = /\.(wav|mp3|flac|ogg|m4a|aac)$/i
const NUMERIC_TOKENS = new Set(['AUDIO_SECONDS', 'SEED'])

export class ComfyAudioError extends Error {
  readonly status: 400 | 504
  constructor(message: string, status: 400 | 504 = 400) {
    super(message)
    this.status = status
  }
}

export interface ComfyAudioItem {
  filename: string
  subfolder?: string
  type?: string
}

export interface AudioGenerateInput {
  config: AIConfig
  prompt: string
  negativePrompt?: string
  seconds: number
  seed: number
  model: string
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
  onPromptId?: (promptId: string) => void
  fetchImpl?: typeof fetch
}

export interface AudioGenerateResult {
  buffer: Buffer
  extension: string
  filename: string
  promptId: string
}

export function applyAudioWorkflowPlaceholders(
  workflow: Record<string, unknown>,
  values: Record<string, string | number>,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const token = value.match(/^__([A-Z0-9_]+)__$/)
      if (token && NUMERIC_TOKENS.has(token[1]) && Object.prototype.hasOwnProperty.call(values, token[1])) {
        return values[token[1]]
      }
      return value.replace(/__([A-Z0-9_]+)__/g, (raw, key: string) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : raw,
      )
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = walk(item)
      return out
    }
    return value
  }
  return walk(workflow) as Record<string, unknown>
}

export function assertAudioWorkflowPrompt(workflow: Record<string, unknown>): void {
  if (!JSON.stringify(workflow).includes('__PROMPT__')) {
    throw new ComfyAudioError('音频工作流必须包含 __PROMPT__ 占位符')
  }
}

function statusError(status: any): string {
  const messages = Array.isArray(status?.messages) ? status.messages : []
  for (const entry of messages) {
    if (Array.isArray(entry) && entry[0] === 'execution_error') {
      const detail = entry[1] || {}
      return `ComfyUI 执行失败：${detail.node_type || detail.node_id || '节点'} ${detail.exception_message || ''}`.trim()
    }
  }
  return 'ComfyUI 工作流执行失败'
}

function outputKeys(outputKey?: string): string[] {
  if (!outputKey) return ['audio', 'audios']
  return outputKey === 'audios' ? ['audios', 'audio'] : [outputKey, 'audios']
}

export function extractComfyAudioOutput(
  result: any,
  outputNode: string | undefined,
  outputKey: string | undefined,
): { item?: ComfyAudioItem; error?: string; pending?: boolean } {
  const output = result?.outputs
  if (!output || typeof output !== 'object') {
    const status = result?.status
    if (status?.status_str === 'error') return { error: statusError(status) }
    return { pending: true }
  }

  const nodeIds = outputNode ? [outputNode] : Object.keys(output)
  for (const nodeId of nodeIds) {
    const nodeOutput = output[nodeId]
    if (!nodeOutput || typeof nodeOutput !== 'object') continue
    for (const key of outputKeys(outputKey)) {
      const list = (nodeOutput as any)[key]
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (item?.filename && AUDIO_EXT_RE.test(String(item.filename))) {
          return { item }
        }
      }
    }
  }

  const status = result?.status
  if (status?.status_str === 'error') return { error: statusError(status) }
  if (status?.completed) {
    return {
      error: `ComfyUI 工作流已完成，但输出节点 ${outputNode || '(自动)'} 没有音频产物，请检查输出节点与输出键`,
    }
  }
  return { pending: true }
}

function abortError(): Error {
  const error = new Error('已取消')
  error.name = 'AbortError'
  return error
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function submitPrompt(
  config: AIConfig,
  workflow: Record<string, unknown>,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(joinProviderUrl(config.baseUrl, '', '/prompt'), {
    method: 'POST',
    headers: { ...comfyHeaders(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'huobao-soundscape' }),
    signal,
  })
  const text = await response.text()
  if (!response.ok) throw new ComfyAudioError(`ComfyUI 提交失败：HTTP ${response.status} ${text.slice(0, 300)}`)
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    throw new ComfyAudioError('ComfyUI 提交返回不是合法 JSON')
  }
  if (payload?.error) {
    throw new ComfyAudioError(`ComfyUI 提交失败：${payload.error.message || payload.error}`)
  }
  const nodeErrors = payload?.node_errors
  if (nodeErrors && typeof nodeErrors === 'object' && Object.keys(nodeErrors).length) {
    const first = Object.values(nodeErrors)[0] as any
    const detail = Array.isArray(first?.errors) ? first.errors[0]?.message : null
    throw new ComfyAudioError(`ComfyUI 节点错误：${detail || '请检查工作流参数'}`)
  }
  if (!payload?.prompt_id) throw new ComfyAudioError('ComfyUI 提交响应缺少 prompt_id')
  return String(payload.prompt_id)
}

async function downloadAudio(
  config: AIConfig,
  item: ComfyAudioItem,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; extension: string; filename: string }> {
  const response = await fetchImpl(buildComfyViewUrl(config, item), {
    headers: comfyHeaders(config),
    signal,
  })
  if (!response.ok) throw new ComfyAudioError(`ComfyUI 音频下载失败：HTTP ${response.status}`)
  const match = String(item.filename).match(AUDIO_EXT_RE)
  const extension = (match?.[1] || 'wav').toLowerCase()
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    extension,
    filename: String(item.filename),
  }
}

export async function runComfyAudio(input: AudioGenerateInput): Promise<AudioGenerateResult> {
  const settings = readComfySettings(input.config)
  const workflow = parseComfyWorkflow(input.config)
  assertAudioWorkflowPrompt(workflow)
  const fetchImpl = input.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeoutMs = input.timeoutMs ?? settings.timeoutMs ?? 600_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal

  try {
    const injected = applyAudioWorkflowPlaceholders(workflow, {
      PROMPT: input.prompt,
      NEGATIVE_PROMPT: input.negativePrompt || settings.negativePrompt || '',
      AUDIO_SECONDS: input.seconds,
      SEED: input.seed,
      MODEL: input.model,
    })
    const promptId = await submitPrompt(input.config, injected, fetchImpl, signal)
    input.onPromptId?.(promptId)

    const pollIntervalMs = input.pollIntervalMs ?? 1500
    for (;;) {
      if (signal.aborted) throw abortError()
      const response = await fetchImpl(joinProviderUrl(input.config.baseUrl, '', `/history/${promptId}`), {
        headers: comfyHeaders(input.config),
        signal,
      })
      if (!response.ok) throw new ComfyAudioError(`ComfyUI 查询失败：HTTP ${response.status}`)
      const history = unwrapComfyHistory(await response.json())
      const found = extractComfyAudioOutput(history, settings.outputNode, settings.outputKey)
      if (found.item) {
        const downloaded = await downloadAudio(input.config, found.item, fetchImpl, signal)
        return { ...downloaded, promptId }
      }
      if (found.error) throw new ComfyAudioError(found.error)
      await delay(pollIntervalMs, signal)
    }
  } catch (error: any) {
    if (controller.signal.aborted && !input.signal?.aborted) {
      throw new ComfyAudioError('ComfyUI 等待超时', 504)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function cancelComfyPrompt(
  config: AIConfig,
  promptId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(joinProviderUrl(config.baseUrl, '', '/queue'), {
      method: 'POST',
      headers: { ...comfyHeaders(config), 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(3000),
    })
  } catch {
    // best effort：队列里可能已经开始执行
  }
}

export function isAudioExtension(value: string): boolean {
  return AUDIO_EXT_RE.test(value)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --test tests/comfyui-audio.test.ts`
Expected: PASS。若 `AbortSignal.any` 当前 Node 版本不可用，把两个信号合并改成手动监听并复用 `controller`；不要改测试。

---

## Task 5: 编译器核心（请求规范化、时间轴切片、生成项、群众规则、确定性降级）

**Files:**
- Create: `backend/src/services/soundscape-compiler.ts`（本任务只实现纯函数部分）
- Test: `backend/tests/soundscape-compiler.test.ts`

**Interfaces:**
- Consumes: `TimelineClipPosition`、`TimelineCue`（Task 3）；`SceneRecord`、`StoryboardRecord`、`LineRecord` 由调用方传入，本任务不做数据库访问。
- Produces:
  - `SoundscapeError(message, status: 400 | 404 | 409 | 503)`
  - `parseSoundscapeRequest(body: unknown): SoundscapeRequest`
  - `buildSoundscapeDraft(input: BuildSoundscapeDraftInput): SoundscapeDraftPlan`
  - `clampSeconds(category, value): number`
  - `translateSoundscapeHints(values): string[]`
  - 类型 `SoundscapeCategory / SoundscapeMode / SoundscapeCrowdMode / SoundscapeOverride / SoundscapeRequest / SoundscapeDraftItem / SoundscapeDraftPlan / SceneRecord / StoryboardRecord / LineRecord / ScenePromptSet / BuildSoundscapeDraftInput`

**说明：** 场景没有 `sceneNumber` 列。本计划统一按场景查询顺序（`scenes.id` 升序）取 1-based 序号作为「场景 N」，与现有台词本展示顺序一致。`buildSoundscapeDraft` 不读数据库，调用方必须先把场景按 `id` 升序传入。

- [ ] **Step 1: 写失败测试**

```ts
/**
 * 声音场景编译器：请求规范化、场景切片、生成项、群众规则、确定性模板。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SoundscapeError,
  buildSoundscapeDraft,
  clampSeconds,
  parseSoundscapeRequest,
  translateSoundscapeHints,
  type BuildSoundscapeDraftInput,
  type LineRecord,
  type SceneRecord,
  type StoryboardRecord,
} from '../src/services/soundscape-compiler.ts'
import type { TimelineClipPosition, TimelineCue } from '../src/services/timeline.ts'

const scenes: SceneRecord[] = [
  { id: 10, location: '街道', time: '夜', prompt: '霓虹灯下的街道', finalPrompt: null },
  { id: 11, location: '森林', time: '黄昏', prompt: '潮湿的森林', finalPrompt: null },
  { id: 12, location: '室内', time: '夜', prompt: null, finalPrompt: null },
]

const storyboards: StoryboardRecord[] = [
  { id: 101, sceneId: 10, storyboardNumber: 1, location: '街道', time: '夜', atmosphere: '紧张', bgmPrompt: '低沉弦乐', soundEffect: '雨声' },
  { id: 102, sceneId: 10, storyboardNumber: 2, location: '街道', time: '夜', atmosphere: '压抑', bgmPrompt: null, soundEffect: '脚步声' },
  { id: 103, sceneId: 11, storyboardNumber: 1, location: '森林', time: '黄昏', atmosphere: '神秘', bgmPrompt: '空灵', soundEffect: null },
  { id: 104, sceneId: 11, storyboardNumber: 2, location: '森林', time: '黄昏', atmosphere: '紧张', bgmPrompt: null, soundEffect: '风声' },
  { id: 105, sceneId: 12, storyboardNumber: 1, location: '室内', time: '夜', atmosphere: null, bgmPrompt: null, soundEffect: '开门声' },
  { id: 106, sceneId: null, storyboardNumber: 1, location: null, time: null, atmosphere: null, bgmPrompt: null, soundEffect: null },
]

const clips: TimelineClipPosition[] = [
  { storyboardId: 101, startMs: 0, endMs: 5000, durationMs: 5000 },
  { storyboardId: 102, startMs: 5000, endMs: 9000, durationMs: 4000 },
  { storyboardId: 103, startMs: 9000, endMs: 12000, durationMs: 3000 },
  { storyboardId: 104, startMs: 12000, endMs: 20000, durationMs: 8000 },
]

function cue(lineId: number, shotId: number, speaker: string, text: string, kind: TimelineCue['kind'] = 'dialogue'): TimelineCue {
  return {
    lineId, shotId, startMs: shotId * 10, endMs: shotId * 10 + 800,
    subtitleStartMs: shotId * 10, subtitleEndMs: shotId * 10 + 800,
    text, speaker, kind, speed: 1, overflowMs: 0, overlap: false, trimmed: false,
    audioDurationMs: 800, audioUrl: `/audio/${lineId}.mp3`,
  }
}

const cues: TimelineCue[] = [
  cue(201, 101, '路人甲', '快看那边'),
  cue(202, 102, '张三', '你好'),
  cue(203, 103, '村民们', '欢迎回来'),
  cue(204, 104, '旁白', '众人散去'),
]

const lines: LineRecord[] = [
  { id: 201, characterId: null, speakerType: 'dialogue', lineNo: 1 },
  { id: 202, characterId: 3, speakerType: 'dialogue', lineNo: 2 },
  { id: 203, characterId: null, speakerType: 'dialogue', lineNo: 3 },
  { id: 204, characterId: null, speakerType: 'narration', lineNo: 4 },
]

function draftInput(overrides: Partial<BuildSoundscapeDraftInput> = {}): BuildSoundscapeDraftInput {
  return {
    episodeId: 1,
    mode: 'scenes',
    categories: ['ambience', 'sfx', 'crowd', 'bgm'],
    crowdMode: 'walla',
    sceneIds: [],
    totalDurationMs: 20000,
    scenes,
    storyboards,
    clips,
    cues,
    lines,
    ...overrides,
  }
}

test('缺少合片时间轴时抛 400', () => {
  assert.throws(
    () => buildSoundscapeDraft(draftInput({ totalDurationMs: 0 })),
    (error: any) => error instanceof SoundscapeError && error.status === 400 && /合片/.test(error.message),
  )
})

test('场景范围由分镜并集计算，缺少视频的分镜跳过并警告', () => {
  const plan = buildSoundscapeDraft(draftInput())
  const ambience = plan.items.filter((item) => item.category === 'ambience')
  assert.deepEqual(ambience.map((item) => [item.itemId, item.startMs, item.endMs]), [
    ['ambience:scene:10', 0, 9000],
    ['ambience:scene:11', 9000, 20000],
  ])
  const warnings = plan.warnings.join('\n')
  assert.match(warnings, /分镜 105 没有可用视频/)
  assert.match(warnings, /分镜 106 未归属场景/)
  assert.match(warnings, /场景 3 没有可用分镜/)
})

test('四类生成项数量与 itemId 正确，BGM 始终整集一项', () => {
  const plan = buildSoundscapeDraft(draftInput())
  assert.deepEqual(plan.items.map((item) => item.itemId), [
    'ambience:scene:10',
    'ambience:scene:11',
    'sfx:scene:10',
    'sfx:scene:11',
    'crowd:scene:10',
    'crowd:scene:11',
    'bgm:episode',
  ])
  assert.equal(plan.items.filter((item) => item.category === 'bgm').length, 1)
  assert.equal(plan.items.find((item) => item.category === 'bgm')!.startMs, 0)
  assert.equal(plan.items.find((item) => item.category === 'bgm')!.endMs, 20000)
})

test('音效合并同场景多个 soundEffect，且降级模板输出英文', () => {
  const plan = buildSoundscapeDraft(draftInput())
  const sfx = plan.items.find((item) => item.itemId === 'sfx:scene:10')!
  assert.match(sfx.prompt, /rain/)
  assert.match(sfx.prompt, /footsteps/)
  assert.doesNotMatch(sfx.prompt, /[\u4e00-\u9fa5]/)
  assert.equal(sfx.degraded, true)
  const ambience = plan.items.find((item) => item.itemId === 'ambience:scene:10')!
  assert.match(ambience.prompt, /^ambient background, night, street, /)
  assert.equal(ambience.seconds, 45)
  const bgm = plan.items.find((item) => item.category === 'bgm')!
  assert.match(bgm.prompt, /^cinematic instrumental score, /)
  assert.match(bgm.prompt, /no vocals, subtle, loopable$/)
})

test('整集铺底模式：环境声一项覆盖整集，长于素材时 loop', () => {
  const plan = buildSoundscapeDraft(draftInput({
    mode: 'episode-bed',
    totalDurationMs: 60000,
    categories: ['ambience'],
  }))
  assert.equal(plan.items.length, 1)
  const item = plan.items[0]
  assert.equal(item.itemId, 'ambience:episode')
  assert.equal(item.startMs, 0)
  assert.equal(item.endMs, 60000)
  assert.equal(item.seconds, 45)
  assert.equal(item.loop, true)
})

test('群众台词规则识别旁白、具体角色，并与 LLM 结果合并', () => {
  const plan = buildSoundscapeDraft(draftInput({
    categories: ['crowd'],
    crowdMode: 'lines',
  }))
  assert.deepEqual(plan.items.map((item) => [item.itemId, item.source, item.lineIds]), [
    ['crowd:scene:10', 'lines', [201]],
    ['crowd:scene:11', 'lines', [203]],
  ])
  assert.ok(plan.items.every((item) => item.seconds === 0 && item.prompt === ''))

  const merged = buildSoundscapeDraft(draftInput({
    categories: ['crowd'],
    crowdMode: 'lines',
    prompts: { 10: { crowdLineIds: [202] } },
  }))
  assert.deepEqual(merged.items.find((item) => item.sceneId === 10)!.lineIds, [201, 202])
})

test('assets-only + 群众台词模式不产生任何生成项并警告', () => {
  const plan = buildSoundscapeDraft(draftInput({
    mode: 'assets-only',
    categories: ['crowd'],
    crowdMode: 'lines',
  }))
  assert.equal(plan.items.length, 0)
  assert.match(plan.warnings.join('\n'), /仅生成素材/)
})

test('场景筛选与场景序号', () => {
  const plan = buildSoundscapeDraft(draftInput({ sceneIds: [11] }))
  assert.deepEqual(plan.items.map((item) => item.itemId), [
    'ambience:scene:11',
    'sfx:scene:11',
    'crowd:scene:11',
    'bgm:episode',
  ])
  assert.throws(
    () => buildSoundscapeDraft(draftInput({ sceneIds: [999] })),
    (error: any) => error instanceof SoundscapeError && /没有可用的场景或分镜/.test(error.message),
  )
})

test('所选场景不可用时只警告一次', () => {
  const plan = buildSoundscapeDraft(draftInput({ sceneIds: [10, 12] }))
  assert.equal(plan.warnings.filter((warning) => warning.includes('场景 3')).length, 1)
  assert.equal(new Set(plan.warnings).size, plan.warnings.length)
})

test('LLM 提示词覆盖模板，degraded=false', () => {
  const plan = buildSoundscapeDraft(draftInput({
    prompts: {
      10: {
        ambiencePrompt: 'night street ambience',
        sfxPrompt: 'rain and footsteps',
        crowdPrompt: 'crowd walla',
        bgmMood: 'tense',
      },
    },
  }))
  assert.equal(plan.items.find((item) => item.itemId === 'ambience:scene:10')!.prompt, 'night street ambience')
  assert.equal(plan.items.find((item) => item.itemId === 'ambience:scene:10')!.degraded, false)
  assert.equal(plan.items.find((item) => item.itemId === 'sfx:scene:10')!.prompt, 'rain and footsteps')
  assert.equal(plan.items.find((item) => item.itemId === 'crowd:scene:10')!.prompt, 'crowd walla')
  assert.match(plan.items.find((item) => item.category === 'bgm')!.prompt, /tense/)
  assert.equal(plan.items.find((item) => item.category === 'bgm')!.degraded, false)
})

test('时长夹取与提示词覆盖解析', () => {
  assert.equal(clampSeconds('ambience', 1), 30)
  assert.equal(clampSeconds('ambience', 99), 45)
  assert.equal(clampSeconds('sfx', 1), 2)
  assert.equal(clampSeconds('sfx', 99), 10)
  assert.equal(clampSeconds('crowd', 1), 20)
  assert.equal(clampSeconds('crowd', 99), 45)
  assert.equal(clampSeconds('bgm', 1), 30)
  assert.equal(clampSeconds('bgm', 99), 45)
  assert.deepEqual(translateSoundscapeHints(['雨夜街道']), ['night', 'rain', 'street'])

  const request = parseSoundscapeRequest({
    mode: 'episode-bed',
    categories: ['bgm', 'bgm'],
    crowdMode: 'lines',
    sceneIds: [11, 11],
    overwrite: true,
    overrides: [{ itemId: 'bgm:episode', prompt: 'custom', seconds: 99 }],
  })
  assert.deepEqual(request, {
    mode: 'episode-bed',
    categories: ['bgm'],
    crowdMode: 'lines',
    sceneIds: [11],
    overwrite: true,
    overrides: [{ itemId: 'bgm:episode', prompt: 'custom', seconds: 99 }],
    configId: undefined,
  })
})

test('请求参数非法返回 400', () => {
  assert.throws(() => parseSoundscapeRequest({ categories: [] }), (error: any) => error.status === 400)
  assert.throws(() => parseSoundscapeRequest({ mode: 'nope', categories: ['ambience'] }), /模式/)
  assert.throws(() => parseSoundscapeRequest({ categories: ['voice'] }), /类别/)
  assert.throws(() => parseSoundscapeRequest({
    categories: ['ambience'],
    overrides: [{ itemId: 'ambience:episode', prompt: 'x'.repeat(2001) }],
  }), /2000/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/soundscape-compiler.test.ts`
Expected: FAIL，`Cannot find module '../src/services/soundscape-compiler.ts'`。

- [ ] **Step 3: 写最小实现**

```ts
/**
 * 声音场景编译器（纯函数部分）
 *
 * 只做请求规范化、场景切片、生成项与确定性英文模板；
 * 文本模型编译、种子与哈希在同一个文件的 Task 6 部分追加。
 * 不访问数据库 / 网络，测试可直接构造时间轴。
 */
import type { TimelineClipPosition, TimelineCue } from './timeline.js'

export type SoundscapeCategory = 'ambience' | 'sfx' | 'crowd' | 'bgm'
export type SoundscapeMode = 'scenes' | 'episode-bed' | 'assets-only'
export type SoundscapeCrowdMode = 'walla' | 'lines'
export type SoundscapeSource = 'generate' | 'lines'

export const SOUNDSCAPE_CATEGORIES: readonly SoundscapeCategory[] = ['ambience', 'sfx', 'crowd', 'bgm']
export const SOUNDSCAPE_MODES: readonly SoundscapeMode[] = ['scenes', 'episode-bed', 'assets-only']
export const SOUNDSCAPE_CROWD_MODES: readonly SoundscapeCrowdMode[] = ['walla', 'lines']
export const MAX_SCENES = 40
export const MAX_ITEMS = 160
export const ESTIMATED_SECONDS_PER_ITEM = 30
export const DEFAULT_SECONDS: Record<SoundscapeCategory, number> = {
  ambience: 45,
  sfx: 5,
  crowd: 30,
  bgm: 45,
}
export const SECONDS_RANGE: Record<SoundscapeCategory, readonly [number, number]> = {
  ambience: [30, 45],
  sfx: [2, 10],
  crowd: [20, 45],
  bgm: [30, 45],
}
export const DEFAULT_NEGATIVE_PROMPTS: Record<SoundscapeCategory, string> = {
  ambience: 'dialogue, music, voices, intelligible speech',
  sfx: 'dialogue, music, voices',
  crowd: 'intelligible words, clear dialogue, music',
  bgm: 'vocals, lyrics, dialogue',
}

export class SoundscapeError extends Error {
  readonly status: 400 | 404 | 409 | 503
  constructor(message: string, status: 400 | 404 | 409 | 503 = 400) {
    super(message)
    this.name = 'SoundscapeError'
    this.status = status
  }
}

export interface SoundscapeOverride {
  itemId: string
  prompt?: string
  negativePrompt?: string
  seconds?: number
}

export interface SoundscapeRequest {
  mode: SoundscapeMode
  categories: SoundscapeCategory[]
  crowdMode: SoundscapeCrowdMode
  sceneIds: number[]
  overwrite: boolean
  overrides: SoundscapeOverride[]
  configId?: number
}

export interface SceneRecord {
  id: number
  location: string | null
  time: string | null
  prompt: string | null
  finalPrompt: string | null
}

export interface StoryboardRecord {
  id: number
  sceneId: number | null
  storyboardNumber: number | null
  location: string | null
  time: string | null
  atmosphere: string | null
  bgmPrompt: string | null
  soundEffect: string | null
}

export interface LineRecord {
  id: number
  characterId: number | null
  speakerType: string | null
  lineNo: number
}

export interface ScenePromptSet {
  ambiencePrompt?: string
  sfxPrompt?: string
  crowdPrompt?: string
  bgmMood?: string
  crowdLineIds?: number[]
}

export interface SoundscapeDraftItem {
  itemId: string
  category: SoundscapeCategory
  source: SoundscapeSource
  sceneId: number | null
  storyboardId: number | null
  startMs: number
  endMs: number
  seconds: number
  prompt: string
  negativePrompt: string
  loop: boolean
  lineIds: number[]
  degraded: boolean
}

export interface SoundscapeDraftPlan {
  mode: SoundscapeMode
  items: SoundscapeDraftItem[]
  warnings: string[]
}

export interface BuildSoundscapeDraftInput {
  episodeId: number
  mode: SoundscapeMode
  categories: SoundscapeCategory[]
  crowdMode: SoundscapeCrowdMode
  sceneIds: number[]
  totalDurationMs: number
  scenes: SceneRecord[]
  storyboards: StoryboardRecord[]
  clips: TimelineClipPosition[]
  cues: TimelineCue[]
  lines: LineRecord[]
  prompts?: Record<number, ScenePromptSet>
}

interface SceneSlice {
  scene: SceneRecord
  sceneLabel: number
  storyboards: Array<{ storyboard: StoryboardRecord; clip: TimelineClipPosition }>
  startMs: number
  endMs: number
}

export interface SceneSliceResolution {
  slices: SceneSlice[]
  warnings: string[]
  cuesByScene: Map<number, TimelineCue[]>
  lineById: Map<number, LineRecord>
}

const CROWD_SPEAKER_PATTERN = /群众|人群|众人|路人|围观|士兵们|村民们|观众|记者|学生们|宾客们/
const CROWD_TEXT_PATTERN = /众人|大家|人群|全场|齐声/

const TERM_MAP: Array<[RegExp, string]> = [
  [/清晨|黎明/, 'dawn'],
  [/黄昏|傍晚/, 'dusk'],
  [/夜晚|深夜|午夜|夜/, 'night'],
  [/白天|日间|正午|阳光/, 'day'],
  [/雨/, 'rain'],
  [/风/, 'wind'],
  [/雪/, 'snow'],
  [/雷/, 'thunder'],
  [/街道|街/, 'street'],
  [/室内|房间|屋里/, 'indoor'],
  [/森林|树林/, 'forest'],
  [/海边|海滩|海浪/, 'seaside'],
  [/城市|都市/, 'city'],
  [/山村|村庄|村子/, 'mountain village'],
  [/脚步/, 'footsteps'],
  [/开门|关门|门/, 'door'],
  [/枪/, 'gunshot'],
  [/爆炸/, 'explosion'],
  [/打斗|搏斗/, 'fight'],
  [/敲/, 'knock'],
  [/玻璃/, 'glass'],
  [/汽车|车/, 'car'],
  [/鸟/, 'birds'],
  [/虫/, 'insects'],
  [/火/, 'fire'],
  [/水/, 'water'],
  [/钟/, 'bell'],
  [/掌声/, 'applause'],
]

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export function clampSeconds(category: SoundscapeCategory, value: number): number {
  const [min, max] = SECONDS_RANGE[category]
  if (!Number.isFinite(value)) return DEFAULT_SECONDS[category]
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function translateSoundscapeHints(values: Array<string | null | undefined>): string[] {
  const text = values.filter(Boolean).join(' ')
  if (!text) return []
  const hits: string[] = []
  for (const [pattern, english] of TERM_MAP) {
    if (pattern.test(text) && !hits.includes(english)) hits.push(english)
  }
  return hits
}

export function fallbackAmbiencePrompt(hints: string[]): string {
  const parts = ['ambient background', ...hints, 'continuous room tone', 'no dialogue', 'no music', 'seamless']
  return parts.filter(Boolean).join(', ')
}

export function fallbackSfxPrompt(hints: string[]): string {
  const parts = ['sound effect', ...hints, 'Foley', 'short', 'dry', 'no dialogue', 'no music']
  return parts.filter(Boolean).join(', ')
}

export function fallbackCrowdPrompt(): string {
  return 'crowd walla, indistinct chatter, background crowd, no intelligible words, no music'
}

export function fallbackBgmPrompt(moods: string[]): string {
  const parts = ['cinematic instrumental score', ...(moods.length ? moods : ['ambient underscore']), 'no vocals', 'subtle', 'loopable']
  return parts.filter(Boolean).join(', ')
}

function parseOverride(value: unknown): SoundscapeOverride {
  if (!value || typeof value !== 'object') throw new SoundscapeError('提示词覆盖无效')
  const raw = value as Record<string, unknown>
  const itemId = asString(raw.itemId).trim()
  if (!itemId) throw new SoundscapeError('提示词覆盖缺少生成项')
  const prompt = raw.prompt == null ? undefined : asString(raw.prompt).trim()
  const negativePrompt = raw.negativePrompt == null ? undefined : asString(raw.negativePrompt).trim()
  const seconds = raw.seconds == null ? undefined : Number(raw.seconds)
  if (prompt && prompt.length > 2000) throw new SoundscapeError('提示词长度不能超过 2000 字符')
  if (negativePrompt && negativePrompt.length > 1000) throw new SoundscapeError('负向提示词长度不能超过 1000 字符')
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
    throw new SoundscapeError('覆盖秒数无效')
  }
  return {
    itemId,
    prompt: prompt || undefined,
    negativePrompt: negativePrompt || undefined,
    seconds,
  }
}

export function parseSoundscapeRequest(body: unknown): SoundscapeRequest {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const mode = raw.mode == null ? 'scenes' : String(raw.mode)
  if (!SOUNDSCAPE_MODES.includes(mode as SoundscapeMode)) throw new SoundscapeError('生成模式无效')

  const categoryInput = raw.categories
  if (!Array.isArray(categoryInput) || categoryInput.length === 0) {
    throw new SoundscapeError('请至少选择一个声音类别')
  }
  const categories: SoundscapeCategory[] = []
  for (const value of categoryInput) {
    const category = String(value) as SoundscapeCategory
    if (!SOUNDSCAPE_CATEGORIES.includes(category)) throw new SoundscapeError('声音类别无效')
    if (!categories.includes(category)) categories.push(category)
  }

  const crowdMode = raw.crowdMode == null ? 'walla' : String(raw.crowdMode)
  if (!SOUNDSCAPE_CROWD_MODES.includes(crowdMode as SoundscapeCrowdMode)) {
    throw new SoundscapeError('群众声方式无效')
  }

  if (raw.sceneIds != null && !Array.isArray(raw.sceneIds)) throw new SoundscapeError('场景范围无效')
  const sceneIds: number[] = []
  for (const value of (raw.sceneIds as unknown[] | undefined) ?? []) {
    const id = Number(value)
    if (!Number.isInteger(id) || id <= 0) throw new SoundscapeError('场景范围无效')
    if (!sceneIds.includes(id)) sceneIds.push(id)
  }

  if (raw.overrides != null && !Array.isArray(raw.overrides)) throw new SoundscapeError('提示词覆盖无效')
  const overrides = ((raw.overrides as unknown[] | undefined) ?? []).map(parseOverride)

  let configId: number | undefined
  if (raw.configId != null) {
    configId = Number(raw.configId)
    if (!Number.isInteger(configId) || configId <= 0) throw new SoundscapeError('配置 ID 无效')
  }

  return {
    mode: mode as SoundscapeMode,
    categories,
    crowdMode: crowdMode as SoundscapeCrowdMode,
    sceneIds,
    overwrite: raw.overwrite === true,
    overrides,
    configId,
  }
}

function isCrowdLine(cue: TimelineCue, line: LineRecord | undefined): boolean {
  if (!line || line.speakerType === 'narration' || cue.kind === 'narration') return false
  const speaker = (cue.speaker || '').trim()
  if (!speaker || speaker === '旁白') return false
  if (CROWD_SPEAKER_PATTERN.test(speaker)) return true
  if (speaker.endsWith('们') && line.characterId == null) return true
  return CROWD_TEXT_PATTERN.test(cue.text || '')
}

function pushItem(items: SoundscapeDraftItem[], item: SoundscapeDraftItem) {
  const seconds = item.source === 'lines' ? 0 : clampSeconds(item.category, item.seconds)
  const loop = item.source === 'generate'
    && item.category !== 'sfx'
    && item.endMs - item.startMs > seconds * 1000
  items.push({ ...item, seconds, loop })
}

export function resolveSceneSlices(
  input: Pick<BuildSoundscapeDraftInput, 'totalDurationMs' | 'sceneIds' | 'scenes' | 'storyboards' | 'clips' | 'cues' | 'lines'>,
): SceneSliceResolution {
  if (!Number.isFinite(input.totalDurationMs) || input.totalDurationMs <= 0) {
    throw new SoundscapeError('请先完成合片，生成声音需要整集时间轴')
  }
  const warnings: string[] = []
  const sceneById = new Map(input.scenes.map((scene) => [scene.id, scene]))
  const sceneLabels = new Map(input.scenes.map((scene, index) => [scene.id, index + 1]))
  const clipById = new Map(input.clips.map((clip) => [clip.storyboardId, clip]))
  const grouped = new Map<number, Array<{ storyboard: StoryboardRecord; clip: TimelineClipPosition }>>()

  for (const storyboard of input.storyboards) {
    if (storyboard.sceneId == null) {
      warnings.push(`分镜 ${storyboard.storyboardNumber ?? storyboard.id} 未归属场景，已跳过`)
      continue
    }
    if (!sceneById.has(storyboard.sceneId)) continue
    const clip = clipById.get(storyboard.id)
    if (!clip || clip.endMs <= clip.startMs) {
      warnings.push(`分镜 ${storyboard.storyboardNumber ?? storyboard.id} 没有可用视频，已跳过`)
      continue
    }
    const list = grouped.get(storyboard.sceneId) ?? []
    list.push({ storyboard, clip })
    grouped.set(storyboard.sceneId, list)
  }

  const selected = new Set(input.sceneIds)
  const warnedSceneIds = new Set<number>()
  for (const sceneId of selected) {
    if (!grouped.has(sceneId)) {
      warnings.push(`所选场景 ${sceneLabels.get(sceneId) ?? sceneId} 不存在或没有可用分镜，已跳过`)
      warnedSceneIds.add(sceneId)
    }
  }

  const slices: SceneSlice[] = [...grouped.entries()]
    .filter(([sceneId]) => selected.size === 0 || selected.has(sceneId))
    .map(([sceneId, entries]) => {
      entries.sort((a, b) => (a.storyboard.storyboardNumber ?? a.storyboard.id)
        - (b.storyboard.storyboardNumber ?? b.storyboard.id))
      return {
        scene: sceneById.get(sceneId)!,
        sceneLabel: sceneLabels.get(sceneId) ?? sceneId,
        storyboards: entries,
        startMs: Math.min(...entries.map((entry) => entry.clip.startMs)),
        endMs: Math.max(...entries.map((entry) => entry.clip.endMs)),
      }
    })
    .filter((slice) => {
      if (slice.endMs > slice.startMs) return true
      warnings.push(`场景 ${slice.sceneLabel} 没有有效时长，已跳过`)
      warnedSceneIds.add(slice.scene.id)
      return false
    })
    .sort((a, b) => a.sceneLabel - b.sceneLabel)

  for (const scene of input.scenes) {
    if (selected.size > 0 && !selected.has(scene.id)) continue
    if (slices.some((slice) => slice.scene.id === scene.id)) continue
    if (warnedSceneIds.has(scene.id)) continue
    warnings.push(`场景 ${sceneLabels.get(scene.id) ?? scene.id} 没有可用分镜，已跳过`)
  }

  if (slices.length === 0) throw new SoundscapeError('当前剧集没有可用的场景或分镜')
  if (slices.length > MAX_SCENES) throw new SoundscapeError(`一次最多生成 ${MAX_SCENES} 个场景`)

  const sceneByStoryboard = new Map<number, number>()
  for (const [sceneId, entries] of grouped) {
    for (const entry of entries) sceneByStoryboard.set(entry.storyboard.id, sceneId)
  }
  const cuesByScene = new Map<number, TimelineCue[]>()
  for (const cue of input.cues) {
    if (cue.shotId == null) continue
    const sceneId = sceneByStoryboard.get(cue.shotId)
    if (!sceneId) continue
    const list = cuesByScene.get(sceneId) ?? []
    list.push(cue)
    cuesByScene.set(sceneId, list)
  }
  const lineById = new Map(input.lines.map((line) => [line.id, line]))
  return { slices, warnings, cuesByScene, lineById }
}

export function buildSoundscapeDraft(input: BuildSoundscapeDraftInput): SoundscapeDraftPlan {
  const { slices, warnings, cuesByScene, lineById } = resolveSceneSlices(input)
  const totalDurationMs = Math.max(0, Math.round(input.totalDurationMs))
  const requested = new Set(input.categories)
  const items: SoundscapeDraftItem[] = []

  if (requested.has('ambience')) {
    if (input.mode === 'episode-bed') {
      const promptSets = slices.map((slice) => input.prompts?.[slice.scene.id]).filter(Boolean)
      const llmPrompts = unique((promptSets as ScenePromptSet[]).map((set) => set.ambiencePrompt || ''))
      const hints = unique(slices.flatMap((slice) => translateSoundscapeHints([
        slice.scene.time, slice.scene.location, slice.scene.prompt, slice.scene.finalPrompt,
        ...slice.storyboards.flatMap((entry) => [entry.storyboard.time, entry.storyboard.location]),
      ])))
      pushItem(items, {
        itemId: 'ambience:episode',
        category: 'ambience',
        source: 'generate',
        sceneId: null,
        storyboardId: null,
        startMs: 0,
        endMs: totalDurationMs,
        seconds: DEFAULT_SECONDS.ambience,
        prompt: llmPrompts.length ? llmPrompts.slice(0, 4).join(', ') : fallbackAmbiencePrompt(hints),
        negativePrompt: DEFAULT_NEGATIVE_PROMPTS.ambience,
        loop: false,
        lineIds: [],
        degraded: llmPrompts.length === 0,
      })
    } else {
      for (const slice of slices) {
        const llm = input.prompts?.[slice.scene.id]?.ambiencePrompt?.trim()
        const hints = unique(translateSoundscapeHints([
          slice.scene.time, slice.scene.location, slice.scene.prompt, slice.scene.finalPrompt,
          ...slice.storyboards.flatMap((entry) => [entry.storyboard.time, entry.storyboard.location]),
        ]))
        pushItem(items, {
          itemId: `ambience:scene:${slice.scene.id}`,
          category: 'ambience',
          source: 'generate',
          sceneId: slice.scene.id,
          storyboardId: null,
          startMs: slice.startMs,
          endMs: slice.endMs,
          seconds: DEFAULT_SECONDS.ambience,
          prompt: llm || fallbackAmbiencePrompt(hints),
          negativePrompt: DEFAULT_NEGATIVE_PROMPTS.ambience,
          loop: false,
          lineIds: [],
          degraded: !llm,
        })
      }
    }
  }

  if (requested.has('sfx')) {
    for (const slice of slices) {
      const llm = input.prompts?.[slice.scene.id]?.sfxPrompt?.trim()
      const effects = slice.storyboards
        .map((entry) => entry.storyboard.soundEffect)
        .filter((value): value is string => Boolean(value && value.trim()))
      if (!llm && effects.length === 0) continue
      const hints = unique(translateSoundscapeHints(effects))
      pushItem(items, {
        itemId: `sfx:scene:${slice.scene.id}`,
        category: 'sfx',
        source: 'generate',
        sceneId: slice.scene.id,
        storyboardId: null,
        startMs: slice.startMs,
        endMs: slice.endMs,
        seconds: DEFAULT_SECONDS.sfx,
        prompt: llm || fallbackSfxPrompt(hints),
        negativePrompt: DEFAULT_NEGATIVE_PROMPTS.sfx,
        loop: false,
        lineIds: [],
        degraded: !llm,
      })
    }
  }

  if (requested.has('crowd')) {
    if (input.crowdMode === 'lines') {
      if (input.mode === 'assets-only') {
        warnings.push('仅生成素材模式不创建群众台词片段，已跳过群众声')
      } else {
        for (const slice of slices) {
          const llmIds = new Set(input.prompts?.[slice.scene.id]?.crowdLineIds ?? [])
          const lineIds = [...new Set((cuesByScene.get(slice.scene.id) ?? [])
            .filter((cue) => llmIds.has(cue.lineId) || isCrowdLine(cue, lineById.get(cue.lineId)))
            .map((cue) => cue.lineId))]
            .sort((a, b) => a - b)
          if (lineIds.length === 0) continue
          pushItem(items, {
            itemId: `crowd:scene:${slice.scene.id}`,
            category: 'crowd',
            source: 'lines',
            sceneId: slice.scene.id,
            storyboardId: null,
            startMs: slice.startMs,
            endMs: slice.endMs,
            seconds: 0,
            prompt: '',
            negativePrompt: '',
            loop: false,
            lineIds,
            degraded: false,
          })
        }
      }
    } else {
      for (const slice of slices) {
        const llm = input.prompts?.[slice.scene.id]?.crowdPrompt?.trim()
        pushItem(items, {
          itemId: `crowd:scene:${slice.scene.id}`,
          category: 'crowd',
          source: 'generate',
          sceneId: slice.scene.id,
          storyboardId: null,
          startMs: slice.startMs,
          endMs: slice.endMs,
          seconds: DEFAULT_SECONDS.crowd,
          prompt: llm || fallbackCrowdPrompt(),
          negativePrompt: DEFAULT_NEGATIVE_PROMPTS.crowd,
          loop: false,
          lineIds: [],
          degraded: !llm,
        })
      }
    }
  }

  if (requested.has('bgm')) {
    const moods = unique(slices
      .map((slice) => input.prompts?.[slice.scene.id]?.bgmMood || '')
      .filter(Boolean))
    const fallbackMoods = unique(translateSoundscapeHints(slices.flatMap((slice) => [
      ...slice.storyboards.map((entry) => entry.storyboard.atmosphere),
      ...slice.storyboards.map((entry) => entry.storyboard.bgmPrompt),
    ])))
    pushItem(items, {
      itemId: 'bgm:episode',
      category: 'bgm',
      source: 'generate',
      sceneId: null,
      storyboardId: null,
      startMs: 0,
      endMs: totalDurationMs,
      seconds: DEFAULT_SECONDS.bgm,
      prompt: fallbackBgmPrompt(moods.length ? moods : fallbackMoods),
      negativePrompt: DEFAULT_NEGATIVE_PROMPTS.bgm,
      loop: false,
      lineIds: [],
      degraded: moods.length === 0,
    })
  }

  if (items.length > MAX_ITEMS) throw new SoundscapeError(`生成项过多（${items.length}），请减少场景或声音类别`)

  return { mode: input.mode, items, warnings }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --test tests/soundscape-compiler.test.ts`
Expected: PASS。若「场景 3 没有可用分镜」警告重复，检查 `warnedSceneIds` 是否同时覆盖了预选循环与末尾兜底循环；若音效提示词缺少 `footsteps`，检查 `TERM_MAP` 顺序与 `translateSoundscapeHints` 去重。

---

## Task 6: 编译器 LLM 编译、覆盖项、确定性种子与哈希

**Files:**
- Modify: `backend/src/services/soundscape-compiler.ts`（追加 LLM、覆盖、种子、哈希、默认数据加载）
- Test: `backend/tests/soundscape-compiler.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 5 的 `resolveSceneSlices / buildSoundscapeDraft / clampSeconds`；`callTextJson`（`backend/src/services/text-call.ts:115`）；`previewTimeline`（`backend/src/services/dubbing.ts:531`）。
- Produces:
  - `compileSoundscapePlan(episodeId, dramaId, options): Promise<SoundscapePlan>`
  - `compileScenePromptsWithText(input): Promise<ScenePromptCompileResult>`
  - `parseScenePromptResponse(data): Record<number, ScenePromptSet>`
  - `applySoundscapeOverrides(plan, overrides)`
  - `decorateSoundscapePlan(plan, options): SoundscapePlan`
  - `deriveSoundscapeSeed(...) / soundscapeSourceHash(...) / hashSoundscapeWorkflow(...)`
  - 类型 `SoundscapeItem / SoundscapePlan / SoundscapeCounts / ScenePromptCompileInput / ScenePromptCompileResult / SoundscapeCompileDeps / CompileSoundscapeOptions`

- [ ] **Step 1: 追加失败测试**

在 `backend/tests/soundscape-compiler.test.ts` 末尾追加：

```ts
import {
  compileSoundscapePlan,
  hashSoundscapeWorkflow,
  parseScenePromptResponse,
  type SoundscapeCompileDeps,
} from '../src/services/soundscape-compiler.ts'
import type { TimelineResult } from '../src/services/timeline.ts'

function compileDeps(patch: Partial<SoundscapeCompileDeps> = {}): SoundscapeCompileDeps {
  const timeline: TimelineResult = {
    clips,
    cues,
    totalDurationMs: 20000,
    maxOverflowMs: 0,
    overlapCount: 0,
    atempoCount: 0,
    trimmedCount: 0,
    skippedLineIds: [],
  }
  return {
    timeline: async () => timeline,
    loadScenes: async () => scenes,
    loadStoryboards: async () => storyboards,
    loadLines: async () => lines,
    compileScenePrompts: async () => ({
      prompts: {
        10: { ambiencePrompt: 'night street ambience', bgmMood: 'tense' },
      },
      degraded: false,
      warnings: [],
    }),
    loadCachedHashes: async () => new Set<string>(),
    ...patch,
  }
}

function compileOptions(deps: Partial<SoundscapeCompileDeps> = {}, overrides: any[] = []) {
  return {
    request: parseSoundscapeRequest({
      categories: ['ambience', 'bgm'],
      overrides,
    }),
    model: 'stable-audio-open-1.0',
    workflowHash: 'workflow-hash-test',
    normalizeLoudness: true,
    fixedSeed: null,
    deps: compileDeps(deps),
  }
}

test('LLM 编译结果进入生成项，未返回的场景降级', async () => {
  const plan = await compileSoundscapePlan(1, 2, compileOptions())
  const scene10 = plan.items.find((item) => item.itemId === 'ambience:scene:10')!
  assert.equal(scene10.prompt, 'night street ambience')
  assert.equal(scene10.degraded, false)
  const scene11 = plan.items.find((item) => item.itemId === 'ambience:scene:11')!
  assert.equal(scene11.degraded, true)
  assert.equal(plan.counts.total, 3)
  assert.equal(plan.counts.generate, 3)
  assert.equal(plan.estimatedSeconds, 90)
  assert.equal(plan.degraded, true)
})

test('同输入两次编译得到相同种子与 sourceHash', async () => {
  const first = await compileSoundscapePlan(1, 2, compileOptions())
  const second = await compileSoundscapePlan(1, 2, compileOptions())
  for (let index = 0; index < first.items.length; index += 1) {
    assert.equal(first.items[index].seed, second.items[index].seed)
    assert.equal(first.items[index].sourceHash, second.items[index].sourceHash)
  }
  assert.match(first.items[0].sourceHash, /^[0-9a-f]{64}$/)
})

test('提示词覆盖改变提示词、夹取秒数并改变 sourceHash', async () => {
  const base = await compileSoundscapePlan(1, 2, compileOptions())
  const baseHash = base.items.find((item) => item.itemId === 'ambience:scene:10')!.sourceHash
  const plan = await compileSoundscapePlan(1, 2, compileOptions({}, [
    { itemId: 'ambience:scene:10', prompt: 'custom rain ambience', seconds: 99 },
    { itemId: 'ambience:episode', prompt: 'unknown item' },
  ]))
  const item = plan.items.find((entry) => entry.itemId === 'ambience:scene:10')!
  assert.equal(item.prompt, 'custom rain ambience')
  assert.equal(item.seconds, 45)
  assert.notEqual(item.sourceHash, baseHash)
  assert.match(plan.warnings.join('\n'), /ambience:episode 未匹配/)
})

test('固定 seed 时所有生成项共用同一值', async () => {
  const plan = await compileSoundscapePlan(1, 2, {
    ...compileOptions(),
    fixedSeed: 4242,
  })
  assert.ok(plan.items.every((item) => item.seed === 4242))
})

test('缓存命中标记 cached', async () => {
  const first = await compileSoundscapePlan(1, 2, compileOptions())
  const hash = first.items.find((item) => item.itemId === 'ambience:scene:10')!.sourceHash
  const plan = await compileSoundscapePlan(1, 2, compileOptions({
    loadCachedHashes: async () => new Set([hash]),
  }))
  assert.equal(plan.items.find((item) => item.itemId === 'ambience:scene:10')!.cached, true)
  assert.equal(plan.counts.cached, 1)
})

test('文本模型不可用时整体降级并警告', async () => {
  const plan = await compileSoundscapePlan(1, 2, compileOptions({
    compileScenePrompts: async () => { throw new Error('no text model') },
  }))
  assert.match(plan.warnings.join('\n'), /通用模板/)
  assert.equal(plan.degraded, true)
  assert.ok(plan.items.filter((item) => item.source === 'generate').every((item) => item.degraded))
})

test('解析场景提示词响应：去空白、过滤非法 lineId', () => {
  assert.deepEqual(parseScenePromptResponse({
    scenes: [
      {
        sceneId: 10,
        ambiencePrompt: '  night street  ',
        sfxPrompt: 'rain',
        crowdPrompt: '',
        bgmMood: 'tense',
        crowdLineIds: [201, '202', 'x', 0],
      },
    ],
  }), {
    10: {
      ambiencePrompt: 'night street',
      sfxPrompt: 'rain',
      bgmMood: 'tense',
      crowdLineIds: [201, 202],
    },
  })
  assert.deepEqual(parseScenePromptResponse({}), {})
})

test('工作流哈希稳定且区分内容', () => {
  const a = hashSoundscapeWorkflow({ 1: { class_type: 'A' } })
  const b = hashSoundscapeWorkflow({ 1: { class_type: 'A' } })
  const c = hashSoundscapeWorkflow({ 1: { class_type: 'B' } })
  assert.match(a, /^[0-9a-f]{64}$/)
  assert.equal(a, b)
  assert.notEqual(a, c)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/soundscape-compiler.test.ts`
Expected: FAIL，`compileSoundscapePlan is not a function`。

- [ ] **Step 3: 追加实现**

文件顶部补充导入：

```ts
import { createHash } from 'crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { callTextJson } from './text-call.js'
import { previewTimeline } from './dubbing.js'
import type { TimelineClipPosition, TimelineCue, TimelineResult } from './timeline.js'
```

文件末尾追加：

```ts
export interface SoundscapeItem extends SoundscapeDraftItem {
  seed: number
  sourceHash: string
  cached: boolean
}

export interface SoundscapeCounts {
  total: number
  generate: number
  lines: number
  cached: number
}

export interface SoundscapeScenePlacement {
  startMs: number
  endMs: number
}

export interface SoundscapePlan {
  mode: SoundscapeMode
  items: SoundscapeItem[]
  warnings: string[]
  counts: SoundscapeCounts
  estimatedSeconds: number
  degraded: boolean
  /** 非 API 字段：场景序号（1-based），供生成片段命名 */
  sceneLabels: Record<number, number>
  /** 非 API 字段：场景内首个分镜的绝对位置，供音效片段放置 */
  sceneFirstStoryboards: Record<number, SoundscapeScenePlacement>
  /** 非 API 字段：台词在时间轴上的位置，供群众台词模式放置片段 */
  lineCues: Record<number, { startMs: number; speaker: string; lineNo: number }>
}

export type DecoratedSoundscapePlan = Omit<SoundscapePlan, 'sceneLabels' | 'sceneFirstStoryboards' | 'lineCues'>

export interface ScenePromptLine {
  lineId: number
  speaker: string
  text: string
  kind: string
}

export interface ScenePromptScene {
  scene: SceneRecord
  sceneLabel: number
  storyboards: StoryboardRecord[]
  lines: ScenePromptLine[]
}

export interface ScenePromptCompileInput {
  scenes: ScenePromptScene[]
}

export interface ScenePromptCompileResult {
  prompts: Record<number, ScenePromptSet>
  degraded: boolean
  warnings: string[]
}

export interface SoundscapeCompileDeps {
  timeline: () => Promise<TimelineResult>
  loadScenes: () => Promise<SceneRecord[]>
  loadStoryboards: () => Promise<StoryboardRecord[]>
  loadLines: () => Promise<LineRecord[]>
  compileScenePrompts: (input: ScenePromptCompileInput) => Promise<ScenePromptCompileResult>
  loadCachedHashes: (hashes: string[]) => Promise<Set<string>>
}

export interface CompileSoundscapeOptions {
  request: SoundscapeRequest
  model: string
  workflowHash: string
  normalizeLoudness: boolean
  fixedSeed?: number | null
  deps?: Partial<SoundscapeCompileDeps>
}

export function hashSoundscapeWorkflow(workflow: unknown): string {
  return createHash('sha256').update(JSON.stringify(workflow ?? null)).digest('hex')
}

export function deriveSoundscapeSeed(
  episodeId: number,
  itemId: string,
  prompt: string,
  seconds: number,
  model: string,
  workflowHash: string,
): number {
  const digest = createHash('sha256')
    .update(`${episodeId}:${itemId}:${prompt}:${seconds}:${model}:${workflowHash}`)
    .digest('hex')
  return Number.parseInt(digest.slice(0, 8), 16) % 0x7fffffff
}

export interface SoundscapeSourceHashInput {
  episodeId: number
  itemId: string
  category: SoundscapeCategory
  sceneId: number | null
  storyboardId: number | null
  prompt: string
  negativePrompt: string
  seconds: number
  seed: number
  model: string
  normalizeLoudness: boolean
  workflowHash: string
}

export function soundscapeSourceHash(input: SoundscapeSourceHashInput): string {
  return createHash('sha256').update(JSON.stringify({
    episodeId: input.episodeId,
    itemId: input.itemId,
    category: input.category,
    sceneId: input.sceneId ?? null,
    storyboardId: input.storyboardId ?? null,
    prompt: input.prompt,
    negativePrompt: input.negativePrompt,
    seconds: input.seconds,
    seed: input.seed,
    model: input.model,
    normalizeLoudness: input.normalizeLoudness,
    workflowHash: input.workflowHash,
  })).digest('hex')
}

export function applySoundscapeOverrides(
  plan: SoundscapeDraftPlan,
  overrides: SoundscapeOverride[],
): { plan: SoundscapeDraftPlan; warnings: string[] } {
  if (overrides.length === 0) return { plan, warnings: [] }
  const warnings: string[] = []
  const items = plan.items.map((item) => ({ ...item }))
  for (const override of overrides) {
    const item = items.find((entry) => entry.itemId === override.itemId)
    if (!item) {
      warnings.push(`覆盖项 ${override.itemId} 未匹配到生成项`)
      continue
    }
    if (item.source === 'lines') {
      warnings.push(`群众台词编排项 ${override.itemId} 不支持提示词覆盖`)
      continue
    }
    if (override.prompt !== undefined) {
      item.prompt = override.prompt
      item.degraded = false
    }
    if (override.negativePrompt !== undefined) item.negativePrompt = override.negativePrompt
    if (override.seconds !== undefined) {
      item.seconds = clampSeconds(item.category, override.seconds)
      item.loop = item.endMs - item.startMs > item.seconds * 1000
    }
  }
  return { plan: { ...plan, items }, warnings }
}

export interface DecorateSoundscapeOptions {
  episodeId: number
  model: string
  workflowHash: string
  normalizeLoudness: boolean
  fixedSeed?: number | null
  cachedHashes?: Set<string>
}

export function decorateSoundscapePlan(
  plan: SoundscapeDraftPlan,
  options: DecorateSoundscapeOptions,
): DecoratedSoundscapePlan {
  const items: SoundscapeItem[] = plan.items.map((item) => {
    if (item.source === 'lines') return { ...item, seed: 0, sourceHash: '', cached: false }
    const seed = options.fixedSeed != null && Number.isFinite(options.fixedSeed)
      ? Math.trunc(options.fixedSeed)
      : deriveSoundscapeSeed(options.episodeId, item.itemId, item.prompt, item.seconds, options.model, options.workflowHash)
    const sourceHash = soundscapeSourceHash({
      episodeId: options.episodeId,
      itemId: item.itemId,
      category: item.category,
      sceneId: item.sceneId,
      storyboardId: item.storyboardId,
      prompt: item.prompt,
      negativePrompt: item.negativePrompt,
      seconds: item.seconds,
      seed,
      model: options.model,
      normalizeLoudness: options.normalizeLoudness,
      workflowHash: options.workflowHash,
    })
    return { ...item, seed, sourceHash, cached: options.cachedHashes?.has(sourceHash) ?? false }
  })
  const counts: SoundscapeCounts = {
    total: items.length,
    generate: items.filter((item) => item.source === 'generate').length,
    lines: items.filter((item) => item.source === 'lines').length,
    cached: items.filter((item) => item.cached).length,
  }
  return {
    mode: plan.mode,
    items,
    warnings: plan.warnings,
    counts,
    estimatedSeconds: counts.generate * ESTIMATED_SECONDS_PER_ITEM,
    degraded: items.some((item) => item.degraded),
  }
}

function formatSceneForPrompt(scene: ScenePromptScene): string {
  const boards = scene.storyboards.map((storyboard, index) => [
    `${index + 1}. 分镜 ${storyboard.storyboardNumber ?? storyboard.id}`,
    `地点：${storyboard.location || '未设定'}`,
    `时间：${storyboard.time || '未设定'}`,
    `氛围：${storyboard.atmosphere || '未设定'}`,
    `音效：${storyboard.soundEffect || '未设定'}`,
    `配乐：${storyboard.bgmPrompt || '未设定'}`,
  ].join('；')).join('\n')
  const lines = scene.lines.length
    ? scene.lines.map((line) => `- ${line.lineId}｜${line.speaker}｜${line.kind}｜${line.text}`).join('\n')
    : '（无台词）'
  return [
    `场景 ID：${scene.scene.id}（场景 ${scene.sceneLabel}）`,
    `地点：${scene.scene.location || '未设定'}`,
    `时间：${scene.scene.time || '未设定'}`,
    `画面设定：${scene.scene.finalPrompt || scene.scene.prompt || '未设定'}`,
    '分镜：',
    boards || '（无分镜）',
    '台词：',
    lines,
  ].join('\n')
}

export function parseScenePromptResponse(data: unknown): Record<number, ScenePromptSet> {
  const result: Record<number, ScenePromptSet> = {}
  const rawScenes = (data && typeof data === 'object' && Array.isArray((data as any).scenes))
    ? (data as any).scenes as unknown[]
    : []
  for (const value of rawScenes) {
    if (!value || typeof value !== 'object') continue
    const raw = value as Record<string, unknown>
    const sceneId = Number(raw.sceneId)
    if (!Number.isInteger(sceneId) || sceneId <= 0) continue
    const set: ScenePromptSet = {}
    if (typeof raw.ambiencePrompt === 'string' && raw.ambiencePrompt.trim()) set.ambiencePrompt = raw.ambiencePrompt.trim()
    if (typeof raw.sfxPrompt === 'string' && raw.sfxPrompt.trim()) set.sfxPrompt = raw.sfxPrompt.trim()
    if (typeof raw.crowdPrompt === 'string' && raw.crowdPrompt.trim()) set.crowdPrompt = raw.crowdPrompt.trim()
    if (typeof raw.bgmMood === 'string' && raw.bgmMood.trim()) set.bgmMood = raw.bgmMood.trim()
    if (Array.isArray(raw.crowdLineIds)) {
      const ids = [...new Set(raw.crowdLineIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
      if (ids.length) set.crowdLineIds = ids
    }
    if (Object.keys(set).length) result[sceneId] = set
  }
  return result
}

const SCENE_PROMPT_BATCH_SIZE = 6

/** 文本模型编译；每批 6 个场景，单批失败只降级该批 */
export async function compileScenePromptsWithText(
  input: ScenePromptCompileInput,
): Promise<ScenePromptCompileResult> {
  const prompts: Record<number, ScenePromptSet> = {}
  const warnings: string[] = []
  let degraded = false

  for (let offset = 0; offset < input.scenes.length; offset += SCENE_PROMPT_BATCH_SIZE) {
    const batch = input.scenes.slice(offset, offset + SCENE_PROMPT_BATCH_SIZE)
    const labels = batch.map((scene) => scene.sceneLabel).join('、')
    try {
      const { data } = await callTextJson<{ scenes?: unknown[] }>({
        system: [
          '你是短剧声音设计师，负责为 Stable Audio Open 编写英文提示词。',
          '只输出 JSON，不要解释。所有提示词必须是英文。',
          '环境声：连续、无对白、无音乐、空间一致，适合循环。',
          '音效：具体动作/物体/事件，短促，不含对白。',
          '群众声：不可辨识的人声混合，不含清晰台词。',
          'bgmMood：2-5 个英文情绪词。',
          'crowdLineIds：从给定台词中选出群众/人群/路人等非具体角色的台词 id。',
          '输出格式：{"scenes":[{"sceneId":12,"ambiencePrompt":"...","sfxPrompt":"...","crowdPrompt":"...","bgmMood":"...","crowdLineIds":[101]}]}',
        ].join('\n'),
        prompt: `请为以下场景编译声音提示词：\n\n${batch.map(formatSceneForPrompt).join('\n\n---\n\n')}`,
        responseFormat: 'json',
        temperature: 0.4,
        maxTokens: 4000,
        timeoutMs: 180_000,
      })
      const parsed = parseScenePromptResponse(data)
      for (const scene of batch) {
        const set = parsed[scene.scene.id]
        if (!set) {
          degraded = true
          warnings.push(`场景 ${scene.sceneLabel} 未返回提示词，使用通用模板`)
          continue
        }
        prompts[scene.scene.id] = set
      }
    } catch {
      degraded = true
      warnings.push(`场景 ${labels} 的提示词编译失败，使用通用模板`)
    }
  }

  return { prompts, degraded, warnings }
}

async function loadScenesDefault(episodeId: number): Promise<SceneRecord[]> {
  const linked = db.select({ scene: schema.scenes })
    .from(schema.episodeScenes)
    .innerJoin(schema.scenes, eq(schema.episodeScenes.sceneId, schema.scenes.id))
    .where(eq(schema.episodeScenes.episodeId, episodeId))
    .all()
  const direct = db.select().from(schema.scenes)
    .where(and(eq(schema.scenes.episodeId, episodeId), isNull(schema.scenes.deletedAt)))
    .all()
  const byId = new Map<number, SceneRecord>()
  for (const row of [...linked.map((entry) => entry.scene), ...direct]) {
    if (row.deletedAt) continue
    byId.set(row.id, {
      id: row.id,
      location: row.location,
      time: row.time,
      prompt: row.prompt,
      finalPrompt: row.finalPrompt,
    })
  }
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

async function loadStoryboardsDefault(episodeId: number): Promise<StoryboardRecord[]> {
  return db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(asc(schema.storyboards.storyboardNumber))
    .all()
    .map((row) => ({
      id: row.id,
      sceneId: row.sceneId,
      storyboardNumber: row.storyboardNumber,
      location: row.location,
      time: row.time,
      atmosphere: row.atmosphere,
      bgmPrompt: row.bgmPrompt,
      soundEffect: row.soundEffect,
    }))
}

async function loadLinesDefault(episodeId: number): Promise<LineRecord[]> {
  return db.select().from(schema.storyboardLines)
    .where(and(eq(schema.storyboardLines.episodeId, episodeId), isNull(schema.storyboardLines.deletedAt)))
    .all()
    .map((row) => ({
      id: row.id,
      characterId: row.characterId,
      speakerType: row.speakerType,
      lineNo: row.lineNo,
    }))
}

async function loadCachedHashesDefault(episodeId: number, hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set()
  const wanted = new Set(hashes)
  const rows = db.select().from(schema.episodeAudioAssets)
    .where(and(
      eq(schema.episodeAudioAssets.episodeId, episodeId),
      eq(schema.episodeAudioAssets.kind, 'soundscape'),
      isNull(schema.episodeAudioAssets.deletedAt),
    ))
    .all()
  return new Set(rows
    .filter((row) => row.status === 'ready' && row.sourceHash && wanted.has(row.sourceHash))
    .map((row) => row.sourceHash!))
}

export async function compileSoundscapePlan(
  episodeId: number,
  dramaId: number,
  options: CompileSoundscapeOptions,
): Promise<SoundscapePlan> {
  const deps: SoundscapeCompileDeps = {
    timeline: options.deps?.timeline ?? (() => previewTimeline(episodeId, dramaId)),
    loadScenes: options.deps?.loadScenes ?? (() => loadScenesDefault(episodeId)),
    loadStoryboards: options.deps?.loadStoryboards ?? (() => loadStoryboardsDefault(episodeId)),
    loadLines: options.deps?.loadLines ?? (() => loadLinesDefault(episodeId)),
    compileScenePrompts: options.deps?.compileScenePrompts ?? compileScenePromptsWithText,
    loadCachedHashes: options.deps?.loadCachedHashes ?? ((hashes) => loadCachedHashesDefault(episodeId, hashes)),
  }

  const [timeline, scenes, storyboards, lines] = await Promise.all([
    deps.timeline(),
    deps.loadScenes(),
    deps.loadStoryboards(),
    deps.loadLines(),
  ])

  const draftInput: BuildSoundscapeDraftInput = {
    episodeId,
    mode: options.request.mode,
    categories: options.request.categories,
    crowdMode: options.request.crowdMode,
    sceneIds: options.request.sceneIds,
    totalDurationMs: timeline.totalDurationMs,
    scenes,
    storyboards,
    clips: timeline.clips,
    cues: timeline.cues,
    lines,
  }
  const resolved = resolveSceneSlices(draftInput)
  const promptInput: ScenePromptCompileInput = {
    scenes: resolved.slices.map((slice) => ({
      scene: slice.scene,
      sceneLabel: slice.sceneLabel,
      storyboards: slice.storyboards.map((entry) => entry.storyboard),
      lines: (resolved.cuesByScene.get(slice.scene.id) ?? []).map((cue) => ({
        lineId: cue.lineId,
        speaker: cue.speaker,
        text: cue.text,
        kind: cue.kind,
      })),
    })),
  }

  let promptResult: ScenePromptCompileResult = { prompts: {}, degraded: false, warnings: [] }
  try {
    promptResult = await deps.compileScenePrompts(promptInput)
  } catch {
    promptResult = { prompts: {}, degraded: true, warnings: ['文本模型不可用，已使用通用模板'] }
  }

  const draft = buildSoundscapeDraft({ ...draftInput, prompts: promptResult.prompts })
  const { plan: overridden, warnings: overrideWarnings } = applySoundscapeOverrides(draft, options.request.overrides)

  const decorateOptions: DecorateSoundscapeOptions = {
    episodeId,
    model: options.model,
    workflowHash: options.workflowHash,
    normalizeLoudness: options.normalizeLoudness,
    fixedSeed: options.fixedSeed,
    cachedHashes: new Set(),
  }
  const provisional = decorateSoundscapePlan(overridden, decorateOptions)
  const cachedHashes = await deps.loadCachedHashes(
    provisional.items.map((item) => item.sourceHash).filter(Boolean),
  )
  const decorated = decorateSoundscapePlan(overridden, { ...decorateOptions, cachedHashes })

  return {
    ...decorated,
    sceneLabels: Object.fromEntries(resolved.slices.map((slice) => [slice.scene.id, slice.sceneLabel])),
    sceneFirstStoryboards: Object.fromEntries(resolved.slices.map((slice) => [
      slice.scene.id,
      { startMs: slice.storyboards[0].clip.startMs, endMs: slice.storyboards[0].clip.endMs },
    ])),
    lineCues: Object.fromEntries(
      [...resolved.cuesByScene.values()].flat().map((cue) => [
        cue.lineId,
        {
          startMs: cue.startMs,
          speaker: cue.speaker,
          lineNo: resolved.lineById.get(cue.lineId)?.lineNo ?? cue.lineId,
        },
      ]),
    ),
    warnings: unique([
      ...promptResult.warnings,
      ...decorated.warnings,
      ...overrideWarnings,
    ]),
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --test tests/soundscape-compiler.test.ts`
Expected: PASS（Task 5 + Task 6 全部用例）。若 `previewTimeline` 返回值缺少 `clips`，确认 Task 3 已完成，否则 `timeline.clips` 为 `undefined` 会在 `resolveSceneSlices` 抛 TypeError。

---

## Task 7: 生成轨与片段放置（幂等重建）

**Files:**
- Create: `backend/src/services/soundscape-tracks.ts`
- Test: `backend/tests/soundscape-tracks.test.ts`

**Interfaces:**
- Consumes: `SoundscapePlan / SoundscapeItem / SoundscapeCategory / SoundscapeMode`（Task 6）；`createAudioTrack / createAudioClip`（`backend/src/services/audio-tracks.ts:205,288`）；`ensureDefaultBuses`（`backend/src/services/mix-plan.ts:155`）；Task 1 的 `origin` 字段。
- Produces:
  - `applySoundscapePlan(input: ApplySoundscapePlanInput): ApplySoundscapePlanResult`
  - 类型 `SoundscapeAssetRef / SoundscapeLineRef / ApplySoundscapePlanInput / ApplySoundscapePlanResult`
  - `SOUNDSCAPE_TRACK_PRESETS`

**规则：** `assets-only` 直接返回空结果；只重建 `succeededCategories` 中的类别；未成功类别保留旧片段；用户轨、分离轨、虚拟轨不触碰。群众台词模式不生成音频，只把激活 Take 放进群众轨。

- [ ] **Step 1: 写失败测试**

```ts
/**
 * 生成轨与片段放置：四类轨、音效位置、循环与淡化、幂等重建、群众台词归轨。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-soundscape-tracks-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { listAudioTracks } = await import('../src/services/audio-tracks.ts')
const { applySoundscapePlan } = await import('../src/services/soundscape-tracks.ts')
import type { SoundscapeItem, SoundscapePlan } from '../src/services/soundscape-compiler.ts'

const audioFile = path.join(root, 'static', 'audio', 'a.mp3')
fs.mkdirSync(path.dirname(audioFile), { recursive: true })
fs.writeFileSync(audioFile, 'fake-audio')

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: 'Soundscape tracks', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id,
  episodeNumber: 1,
  title: '第 1 集',
  createdAt: ts,
  updatedAt: ts,
}).returning().get()

function item(patch: Partial<SoundscapeItem>): SoundscapeItem {
  return {
    itemId: 'ambience:scene:10',
    category: 'ambience',
    source: 'generate',
    sceneId: 10,
    storyboardId: null,
    startMs: 0,
    endMs: 9000,
    seconds: 45,
    prompt: 'prompt',
    negativePrompt: 'negative',
    loop: false,
    lineIds: [],
    degraded: false,
    seed: 1,
    sourceHash: 'hash-1',
    cached: false,
    ...patch,
  }
}

function plan(items: SoundscapeItem[], mode: SoundscapePlan['mode'] = 'scenes'): SoundscapePlan {
  return {
    mode,
    items,
    warnings: [],
    counts: { total: items.length, generate: items.filter((entry) => entry.source === 'generate').length, lines: items.filter((entry) => entry.source === 'lines').length, cached: 0 },
    estimatedSeconds: 0,
    degraded: false,
    sceneLabels: { 10: 1 },
    sceneFirstStoryboards: { 10: { startMs: 0, endMs: 5000 } },
    lineCues: {},
  }
}

function assets() {
  return new Map([
    ['hash-1', { id: 501, url: audioFile }],
    ['hash-2', { id: 502, url: audioFile }],
    ['hash-3', { id: 503, url: audioFile }],
    ['hash-4', { id: 504, url: audioFile }],
  ])
}

test('按场景创建四类生成轨与片段，淡化与音效位置正确', () => {
  const result = applySoundscapePlan({
    episodeId: episode.id,
    mode: 'scenes',
    plan: plan([
      item({}),
      item({ itemId: 'sfx:scene:10', category: 'sfx', sourceHash: 'hash-2', seconds: 5 }),
      item({ itemId: 'crowd:scene:10', category: 'crowd', sourceHash: 'hash-3', seconds: 30 }),
      item({ itemId: 'bgm:episode', category: 'bgm', sceneId: null, sourceHash: 'hash-4', endMs: 20000 }),
    ]),
    succeededCategories: new Set(['ambience', 'sfx', 'crowd', 'bgm']),
    assetsByHash: assets(),
    lineRefs: new Map(),
  })
  assert.equal(result.clipCount, 4)
  const tracks = listAudioTracks(episode.id)
  const byRole = new Map(tracks.map((track) => [track.role, track]))
  assert.deepEqual([...byRole.keys()].sort(), ['ambience', 'bgm', 'crowd', 'sfx'])
  assert.equal(byRole.get('ambience')!.origin, 'soundscape')
  assert.equal(byRole.get('ambience')!.name, '环境声（AI）')
  assert.equal(byRole.get('ambience')!.volume, 0.7)
  assert.equal(byRole.get('sfx')!.volume, 0.8)
  assert.equal(byRole.get('crowd')!.volume, 0.5)
  assert.equal(byRole.get('bgm')!.volume, 1)
  assert.equal(byRole.get('crowd')!.kind, 'voice')
  assert.equal(byRole.get('crowd')!.role, 'crowd')

  const buses = db.select().from(schema.audioBuses).where(eq(schema.audioBuses.episodeId, episode.id)).all()
  const busId = (key: string) => buses.find((bus) => bus.key === key)!.id
  assert.equal(byRole.get('ambience')!.busId, busId('original'))
  assert.equal(byRole.get('sfx')!.busId, busId('sfx'))
  assert.equal(byRole.get('crowd')!.busId, busId('dialogue'))
  assert.equal(byRole.get('bgm')!.busId, busId('bgm'))

  const ambience = byRole.get('ambience')!.clips[0]
  assert.deepEqual([ambience.startMs, ambience.endMs, ambience.fadeInMs, ambience.fadeOutMs], [0, 9000, 0, 300])
  assert.equal(ambience.name, '场景 1 · 环境声')
  assert.equal(ambience.assetId, 501)
  assert.equal(ambience.loop, false)

  const sfx = byRole.get('sfx')!.clips[0]
  assert.deepEqual([sfx.startMs, sfx.endMs, sfx.fadeInMs, sfx.fadeOutMs], [150, 5000, 300, 300])
  assert.equal(sfx.name, '场景 1 · 音效')

  const bgm = byRole.get('bgm')!.clips[0]
  assert.deepEqual([bgm.startMs, bgm.endMs, bgm.fadeInMs, bgm.fadeOutMs], [0, 20000, 0, 0])
  assert.equal(bgm.name, '整集配乐')
})

test('重新生成只重建成功类别，失败类别保留旧片段', () => {
  const first = listAudioTracks(episode.id).find((track) => track.role === 'ambience')!
  const oldClipId = first.clips[0].id
  const result = applySoundscapePlan({
    episodeId: episode.id,
    mode: 'scenes',
    plan: plan([
      item({ sourceHash: 'hash-2' }),
      item({ itemId: 'sfx:scene:10', category: 'sfx', sourceHash: 'hash-2' }),
    ]),
    succeededCategories: new Set(['ambience']),
    assetsByHash: assets(),
    lineRefs: new Map(),
  })
  assert.equal(result.clipCount, 1)
  const tracks = listAudioTracks(episode.id)
  const ambience = tracks.find((track) => track.role === 'ambience')!
  assert.equal(ambience.clips.length, 1)
  assert.notEqual(ambience.clips[0].id, oldClipId)
  assert.equal(ambience.clips[0].assetId, 502)
  const sfx = tracks.find((track) => track.role === 'sfx')!
  assert.equal(sfx.clips[0].assetId, 502)
})

test('群众台词模式写入激活 Take，缺少配音只警告', () => {
  const result = applySoundscapePlan({
    episodeId: episode.id,
    mode: 'scenes',
    plan: plan([
      item({
        itemId: 'crowd:scene:10',
        category: 'crowd',
        source: 'lines',
        seconds: 0,
        prompt: '',
        negativePrompt: '',
        lineIds: [201, 202],
        sourceHash: '',
      }),
    ]),
    succeededCategories: new Set(['crowd']),
    assetsByHash: assets(),
    lineRefs: new Map([
      [201, { lineId: 201, lineNo: 3, speaker: '路人甲', startMs: 1000, durationMs: 1200, audioUrl: audioFile, takeId: 77 }],
    ]),
  })
  assert.equal(result.clipCount, 1)
  assert.match(result.warnings.join('\n'), /第 202 句群众台词尚未配音/)
  const crowd = listAudioTracks(episode.id).find((track) => track.role === 'crowd')!
  assert.equal(crowd.clips.length, 1)
  assert.equal(crowd.clips[0].lineId, 201)
  assert.equal(crowd.clips[0].takeId, 77)
  assert.equal(crowd.clips[0].name, '群众台词 · 路人甲')
  assert.deepEqual([crowd.clips[0].startMs, crowd.clips[0].endMs], [1000, 2200])
})

test('assets-only 不创建轨道与片段', () => {
  const drama2 = db.insert(schema.dramas).values({ title: 'Assets only', createdAt: ts, updatedAt: ts }).returning().get()
  const episode2 = db.insert(schema.episodes).values({
    dramaId: drama2.id, episodeNumber: 1, title: '第 1 集', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const result = applySoundscapePlan({
    episodeId: episode2.id,
    mode: 'assets-only',
    plan: plan([item({})], 'assets-only'),
    succeededCategories: new Set(['ambience']),
    assetsByHash: assets(),
    lineRefs: new Map(),
  })
  assert.deepEqual(result, { trackIds: [], clipCount: 0, warnings: [] })
  assert.equal(listAudioTracks(episode2.id).length, 0)
  assert.equal(db.select().from(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.episodeId, episode2.id)).all().length, 0)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/soundscape-tracks.test.ts`
Expected: FAIL，`Cannot find module '../src/services/soundscape-tracks.ts'`。

- [ ] **Step 3: 写实现**

```ts
/**
 * 声音场景生成轨与片段放置
 *
 * 每类一条 origin='soundscape' 的生成轨；按类别幂等重建片段。
 * assets-only 不触碰轨道；群众台词只引用激活 Take，不生成音频。
 */
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { createAudioClip, createAudioTrack } from './audio-tracks.js'
import { ensureDefaultBuses } from './mix-plan.js'
import type {
  SoundscapeCategory,
  SoundscapeItem,
  SoundscapeMode,
  SoundscapePlan,
} from './soundscape-compiler.js'

type TrackRow = typeof schema.episodeAudioTracks.$inferSelect

export const SOUNDSCAPE_CATEGORY_ORDER: SoundscapeCategory[] = ['ambience', 'sfx', 'crowd', 'bgm']

export const SOUNDSCAPE_TRACK_PRESETS: Record<SoundscapeCategory, {
  kind: string
  role: string
  name: string
  busKey: 'original' | 'sfx' | 'dialogue' | 'bgm'
  color: string
  volume: number
}> = {
  ambience: { kind: 'ambience', role: 'ambience', name: '环境声（AI）', busKey: 'original', color: '#0ea5e9', volume: 0.7 },
  sfx: { kind: 'sfx', role: 'sfx', name: '场景音效（AI）', busKey: 'sfx', color: '#a78bfa', volume: 0.8 },
  crowd: { kind: 'voice', role: 'crowd', name: '群众声（AI）', busKey: 'dialogue', color: '#f59e0b', volume: 0.5 },
  bgm: { kind: 'bgm', role: 'bgm', name: '配乐（AI）', busKey: 'bgm', color: '#22c55e', volume: 1 },
}

export interface SoundscapeAssetRef {
  id: number
  url: string
}

export interface SoundscapeLineRef {
  lineId: number
  lineNo: number
  speaker: string
  startMs: number
  durationMs: number
  audioUrl: string | null
  takeId: number | null
}

export interface ApplySoundscapePlanInput {
  episodeId: number
  mode: SoundscapeMode
  plan: SoundscapePlan
  succeededCategories: Set<SoundscapeCategory>
  assetsByHash: Map<string, SoundscapeAssetRef>
  lineRefs: Map<number, SoundscapeLineRef>
}

export interface ApplySoundscapePlanResult {
  trackIds: number[]
  clipCount: number
  warnings: string[]
}

function sceneName(plan: SoundscapePlan, sceneId: number | null): string {
  if (sceneId == null) return '整集'
  return `场景 ${plan.sceneLabels[sceneId] ?? sceneId}`
}

function fadeFor(item: SoundscapeItem, totalMs: number): { fadeInMs: number; fadeOutMs: number } {
  const duration = item.category === 'bgm' ? 800 : 300
  return {
    fadeInMs: item.startMs <= 0 ? 0 : duration,
    fadeOutMs: item.endMs >= totalMs ? 0 : duration,
  }
}

export function applySoundscapePlan(input: ApplySoundscapePlanInput): ApplySoundscapePlanResult {
  if (input.mode === 'assets-only') return { trackIds: [], clipCount: 0, warnings: [] }

  const warnings: string[] = []
  const totalMs = input.plan.items.reduce((max, item) => Math.max(max, item.endMs), 0)
  const buses = ensureDefaultBuses(input.episodeId)
  const busByKey = new Map(buses.map((bus) => [bus.key, bus.id]))
  const existing = db.select().from(schema.episodeAudioTracks)
    .where(and(
      eq(schema.episodeAudioTracks.episodeId, input.episodeId),
      eq(schema.episodeAudioTracks.origin, 'soundscape'),
    ))
    .all()

  const ensureTrack = (category: SoundscapeCategory): TrackRow => {
    const preset = SOUNDSCAPE_TRACK_PRESETS[category]
    const found = existing.find((track) => track.role === preset.role)
    if (found) return found
    const created = createAudioTrack(input.episodeId, {
      kind: preset.kind,
      role: preset.role,
      name: preset.name,
      volume: preset.volume,
      pan: 0,
      busId: busByKey.get(preset.busKey) ?? null,
      ducking: true,
      color: preset.color,
      height: 72,
      origin: 'soundscape',
    })
    existing.push(created)
    return created
  }

  let clipCount = 0
  const trackIds: number[] = []
  for (const category of SOUNDSCAPE_CATEGORY_ORDER) {
    if (!input.succeededCategories.has(category)) continue
    const preset = SOUNDSCAPE_TRACK_PRESETS[category]
    const track = ensureTrack(category)
    trackIds.push(track.id)
    db.delete(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.trackId, track.id)).run()

    for (const item of input.plan.items.filter((entry) => entry.category === category)) {
      if (item.source === 'lines') {
        for (const lineId of item.lineIds) {
          const ref = input.lineRefs.get(lineId)
          if (!ref || !ref.audioUrl) {
            warnings.push(`第 ${ref?.lineNo ?? lineId} 句群众台词尚未配音，已跳过`)
            continue
          }
          const startMs = Math.max(0, Math.round(ref.startMs))
          const endMs = startMs + Math.max(50, Math.round(ref.durationMs || 0))
          createAudioClip(input.episodeId, track.id, {
            startMs,
            endMs,
            sourceStartMs: 0,
            gainDb: 0,
            pan: 0,
            fadeInMs: 300,
            fadeOutMs: 300,
            loop: false,
            color: preset.color,
            name: `群众台词 · ${ref.speaker || '群众'}`,
            takeId: ref.takeId,
            lineId: ref.lineId,
            audioUrl: ref.audioUrl,
          })
          clipCount += 1
        }
        continue
      }

      const asset = input.assetsByHash.get(item.sourceHash)
      if (!asset) {
        warnings.push(`生成项 ${item.itemId} 缺少素材，已跳过`)
        continue
      }
      const color = preset.color
      if (category === 'sfx') {
        const sceneId = item.sceneId
        const first = sceneId == null ? null : input.plan.sceneFirstStoryboards[sceneId]
        const startMs = (first?.startMs ?? item.startMs) + 150
        const endMs = Math.min(startMs + item.seconds * 1000, first?.endMs ?? item.endMs)
        if (endMs - startMs < 500) {
          warnings.push(`${sceneName(input.plan, sceneId)}的音效片段过短，已跳过`)
          continue
        }
        createAudioClip(input.episodeId, track.id, {
          startMs,
          endMs,
          sourceStartMs: 0,
          gainDb: 0,
          pan: 0,
          fadeInMs: 300,
          fadeOutMs: 300,
          loop: false,
          color,
          name: `${sceneName(input.plan, sceneId)} · 音效`,
          assetId: asset.id,
          audioUrl: asset.url,
        })
        clipCount += 1
        continue
      }

      const fades = fadeFor(item, totalMs)
      const name = category === 'bgm'
        ? '整集配乐'
        : category === 'crowd'
          ? `${sceneName(input.plan, item.sceneId)} · 群众声`
          : item.sceneId == null
            ? '整集环境声'
            : `${sceneName(input.plan, item.sceneId)} · 环境声`
      createAudioClip(input.episodeId, track.id, {
        startMs: Math.max(0, Math.round(item.startMs)),
        endMs: Math.max(item.startMs + 50, Math.round(item.endMs)),
        sourceStartMs: 0,
        gainDb: 0,
        pan: 0,
        fadeInMs: fades.fadeInMs,
        fadeOutMs: fades.fadeOutMs,
        loop: item.loop,
        color,
        name,
        assetId: asset.id,
        audioUrl: asset.url,
      })
      clipCount += 1
    }
  }

  return { trackIds, clipCount, warnings }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --test tests/soundscape-tracks.test.ts`
Expected: PASS。若音效结束时间不是 5000，检查 `sceneFirstStoryboards` 是否随 `compileSoundscapePlan` 返回；测试构造的 plan 已直接提供该字段。

---

## Task 8: 声音生成任务编排

**Files:**
- Create: `backend/src/services/soundscape.ts`
- Test: `backend/tests/soundscape.test.ts`

**Interfaces:**
- Consumes: `runComfyAudio / cancelComfyPrompt`（Task 4）；`compileSoundscapePlan / hashSoundscapeWorkflow / SoundscapeError`（Task 5–6）；`applySoundscapePlan / SoundscapeAssetRef / SoundscapeLineRef`（Task 7）；`getActiveConfig / getConfigById`（`backend/src/services/ai.ts:79,134`）；`probeDurationMs`（`backend/src/services/audio-mix.ts:145`）；`projectSubdirPath / projectStorageRelative`（`backend/src/services/project-storage.ts:75,80`）。
- Produces:
  - `startSoundscape(episodeId, dramaId, request, deps?): Promise<{ jobId: number; status: 'running' }>`
  - `previewSoundscape(episodeId, dramaId, request, deps?): Promise<SoundscapePreview>`
  - `getSoundscapeStatus(episodeId): SoundscapeStatus`
  - `cancelSoundscape(episodeId): boolean`
  - `isSoundscapeRunning(episodeId): boolean`
  - `loadActiveTakes(episodeId, lineIds, cues): Promise<Map<number, SoundscapeLineRef>>`
  - 类型 `SoundscapeDeps / SoundscapeStatus / SoundscapePreview / SoundscapeRunCounts`

**规则：**
- 任务写 `dubbing_jobs`，`kind='soundscape'`；同一剧集用 `starting + active` 两个集合保证启动阶段也互斥。
- 同一 ComfyUI 配置全局串行：模块级 Promise 链包住单次 `generate`，避免 Stable Audio Open 并发打爆显存。
- 缓存命中条件：`!request.overwrite`、同集 `kind='soundscape'`、同 `sourceHash`、`status='ready'`、文件存在。
- 预览结果在内存缓存 10 分钟，键包含请求参数、覆盖项与配置身份（model/workflowHash/normalizeLoudness/fixedSeed）；预览与启动参数一致时复用同一编译结果，覆盖项不同则重新编译，保证 seed/sourceHash 与覆盖后的提示词一致。
- `source='lines'` 不生成音频，只读取激活 Take；没有任何可播放激活 Take 时该类别不算成功，保留旧片段。
- 取消后不写轨；服务重启后查询状态把无内存的 `running` 任务标记失败。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/soundscape.test.ts`：

```ts
/**
 * 声音生成任务编排：生成落盘、缓存、部分失败、取消、并发、重启恢复、群众台词。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { and, eq } from 'drizzle-orm'

const require = createRequire(import.meta.url)
const ffmpegBin: string = process.env.FFMPEG_BIN || require('ffmpeg-static') || 'ffmpeg'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-soundscape-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { getAbsolutePath } = await import('../src/utils/storage.ts')
const { SoundscapeError } = await import('../src/services/soundscape-compiler.ts')
const {
  cancelSoundscape,
  getSoundscapeStatus,
  isSoundscapeRunning,
  previewSoundscape,
  startSoundscape,
} = await import('../src/services/soundscape.ts')
import type { AIConfig } from '../src/services/ai.ts'
import type {
  SoundscapeItem,
  SoundscapePlan,
  SoundscapeRequest,
} from '../src/services/soundscape-compiler.ts'
import type { ApplySoundscapePlanInput } from '../src/services/soundscape-tracks.ts'

const ts = new Date().toISOString()
const fixturePath = path.join(root, 'static', 'fixture.wav')
fs.mkdirSync(path.dirname(fixturePath), { recursive: true })
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-ar', '48000', '-ac', '2', fixturePath,
])
const wavBuffer = fs.readFileSync(fixturePath)

function makeConfig(): AIConfig {
  return {
    id: 900,
    serviceType: 'audio-gen',
    provider: 'comfyui',
    baseUrl: 'http://127.0.0.1:8188',
    apiKey: '',
    model: 'stable-audio-open-1.0',
    settings: {
      workflow: { '6': { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } } },
      timeout_ms: 5000,
      normalize_loudness: false,
      seed: 7,
    },
  }
}

function makeItem(patch: Partial<SoundscapeItem> & { itemId: string }): SoundscapeItem {
  return {
    itemId: patch.itemId,
    category: 'ambience',
    source: 'generate',
    sceneId: 10,
    storyboardId: null,
    startMs: 0,
    endMs: 5000,
    seconds: 5,
    prompt: 'rain',
    negativePrompt: '',
    loop: false,
    lineIds: [],
    degraded: false,
    seed: 1,
    sourceHash: 'hash-1',
    cached: false,
    ...patch,
  }
}

function makePlan(
  items: SoundscapeItem[],
  mode: SoundscapePlan['mode'] = 'scenes',
  lineCues: SoundscapePlan['lineCues'] = {},
): SoundscapePlan {
  return {
    mode,
    items,
    warnings: [],
    counts: {
      total: items.length,
      generate: items.filter((item) => item.source === 'generate').length,
      lines: items.filter((item) => item.source === 'lines').length,
      cached: 0,
    },
    estimatedSeconds: 5,
    degraded: false,
    sceneLabels: { 10: 1 },
    sceneFirstStoryboards: { 10: { startMs: 0, endMs: 5000 } },
    lineCues,
  }
}

function makeRequest(patch: Partial<SoundscapeRequest> = {}): SoundscapeRequest {
  return {
    mode: 'scenes',
    categories: ['ambience', 'sfx', 'crowd', 'bgm'],
    crowdMode: 'walla',
    sceneIds: [],
    overwrite: false,
    overrides: [],
    ...patch,
  }
}

function generated(promptId = 'p1') {
  return { buffer: wavBuffer, extension: 'wav', filename: `${promptId}.wav`, promptId }
}

function newEpisode(title: string) {
  const drama = db.insert(schema.dramas).values({ title, createdAt: ts, updatedAt: ts }).returning().get()
  const episode = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 1, title, createdAt: ts, updatedAt: ts,
  }).returning().get()
  return { drama, episode }
}

function spyApply() {
  const calls: ApplySoundscapePlanInput[] = []
  const applyPlan = (input: ApplySoundscapePlanInput) => {
    calls.push(input)
    return { trackIds: [1], clipCount: input.plan.items.filter((item) => item.source === 'generate').length, warnings: [] }
  }
  return { calls, applyPlan }
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待任务状态超时')
}

function waitStatus(episodeId: number, expected: string) {
  return waitFor(() => {
    const status = getSoundscapeStatus(episodeId)
    return status.status === expected ? status : undefined
  })
}

async function waitIdle(episodeId: number) {
  await waitFor(() => (isSoundscapeRunning(episodeId) ? undefined : true))
}

test('完整任务：生成素材、更新进度并写入生成轨', async () => {
  const { episode, drama } = newEpisode('完整任务')
  let calls = 0
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => { release = resolve })
  const spy = spyApply()
  const plan = makePlan([
    makeItem({ itemId: 'ambience:scene:10', sourceHash: 'hash-a', prompt: 'rain', seed: 7 }),
    makeItem({ itemId: 'bgm:episode', category: 'bgm', sceneId: null, sourceHash: 'hash-b', prompt: 'score' }),
  ])

  await startSoundscape(episode.id, drama.id, makeRequest(), {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => plan,
    generate: async () => {
      calls += 1
      if (calls === 2) await gate
      return generated(`p${calls}`)
    },
    applyPlan: spy.applyPlan,
  })

  const midway = await waitFor(() => {
    const status = getSoundscapeStatus(episode.id)
    return status.status === 'running' && status.progress === 50 ? status : undefined
  })
  assert.match(midway.step || '', /配乐/)
  assert.equal(midway.counts.done, 1)

  release!()
  const done = await waitStatus(episode.id, 'completed')
  assert.equal(done.progress, 100)
  assert.deepEqual(done.counts, { total: 2, done: 2, failed: 0, reused: 0, clips: 2 })
  assert.equal(calls, 2)

  const assets = db.select().from(schema.episodeAudioAssets)
    .where(eq(schema.episodeAudioAssets.episodeId, episode.id)).all()
  assert.equal(assets.length, 2)
  assert.ok(assets.every((asset) => asset.kind === 'soundscape' && asset.status === 'ready'))
  assert.ok(assets.every((asset) => fs.existsSync(getAbsolutePath(asset.url!))))
  assert.match(assets[0].metadataJson || '', /"seed":7/)

  assert.equal(spy.calls.length, 1)
  assert.equal(spy.calls[0].assetsByHash.size, 2)
  assert.deepEqual([...spy.calls[0].succeededCategories].sort(), ['ambience', 'bgm'])
})

test('命中缓存跳过生成，overwrite 强制重新生成', async () => {
  const { episode, drama } = newEpisode('缓存')
  const toneDir = path.join(root, 'static', 'projects', String(drama.id), 'audio')
  fs.mkdirSync(toneDir, { recursive: true })
  fs.copyFileSync(fixturePath, path.join(toneDir, 'tone.wav'))
  const cached = db.insert(schema.episodeAudioAssets).values({
    episodeId: episode.id,
    dramaId: drama.id,
    kind: 'soundscape',
    sourceHash: 'hash-cache',
    url: `static/projects/${drama.id}/audio/tone.wav`,
    durationMs: 1000,
    engine: 'comfyui',
    model: 'stable-audio-open-1.0',
    status: 'ready',
    createdAt: ts,
  }).returning().get()

  const plan = makePlan([makeItem({ itemId: 'ambience:scene:10', sourceHash: 'hash-cache', cached: true })])
  let calls = 0
  const spy = spyApply()
  const deps = {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => plan,
    generate: async () => { calls += 1; return generated('p1') },
    applyPlan: spy.applyPlan,
  }

  await startSoundscape(episode.id, drama.id, makeRequest(), deps)
  const done = await waitStatus(episode.id, 'completed')
  assert.equal(calls, 0)
  assert.equal(done.counts.reused, 1)
  assert.equal(spy.calls[0].assetsByHash.get('hash-cache')?.id, cached.id)
  await waitIdle(episode.id)

  await startSoundscape(episode.id, drama.id, makeRequest({ overwrite: true }), deps)
  const again = await waitStatus(episode.id, 'completed')
  assert.equal(calls, 1)
  assert.equal(again.counts.reused, 0)
  assert.equal(again.counts.done, 1)
})

test('单项失败继续，任务完成并带警告', async () => {
  const { episode, drama } = newEpisode('部分失败')
  const spy = spyApply()
  const plan = makePlan([
    makeItem({ itemId: 'sfx:scene:10', category: 'sfx', sourceHash: 'hash-fail', prompt: 'fail' }),
    makeItem({ itemId: 'ambience:scene:10', sourceHash: 'hash-ok', prompt: 'ok' }),
  ])

  await startSoundscape(episode.id, drama.id, makeRequest(), {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => plan,
    generate: async (input) => {
      if (input.prompt === 'fail') throw new Error('CUDA out of memory')
      return generated()
    },
    applyPlan: spy.applyPlan,
  })

  const done = await waitStatus(episode.id, 'completed')
  assert.equal(done.counts.failed, 1)
  assert.equal(done.counts.done, 1)
  assert.match(done.warnings.join('\n'), /CUDA out of memory/)
  assert.deepEqual([...spy.calls[0].succeededCategories], ['ambience'])
})

test('全部生成项失败时任务失败且不写轨', async () => {
  const { episode, drama } = newEpisode('全部失败')
  const spy = spyApply()
  await startSoundscape(episode.id, drama.id, makeRequest(), {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => makePlan([
      makeItem({ itemId: 'ambience:scene:10', sourceHash: 'hash-1', prompt: 'a' }),
      makeItem({ itemId: 'sfx:scene:10', category: 'sfx', sourceHash: 'hash-2', prompt: 'b' }),
    ]),
    generate: async () => { throw new Error('workflow broken') },
    applyPlan: spy.applyPlan,
  })

  const failed = await waitStatus(episode.id, 'failed')
  assert.match(failed.error || '', /全部生成项/)
  assert.equal(failed.counts.failed, 2)
  assert.equal(spy.calls.length, 0)
})

test('assets-only 只生成素材，不创建轨道', async () => {
  const { episode, drama } = newEpisode('仅素材')
  const spy = spyApply()
  await startSoundscape(episode.id, drama.id, makeRequest({ mode: 'assets-only' }), {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => makePlan([makeItem({ itemId: 'ambience:scene:10', sourceHash: 'hash-only' })], 'assets-only'),
    generate: async () => generated(),
    applyPlan: spy.applyPlan,
  })

  const done = await waitStatus(episode.id, 'completed')
  assert.equal(done.counts.clips, 0)
  assert.equal(spy.calls.length, 0)
  assert.equal(db.select().from(schema.episodeAudioAssets)
    .where(eq(schema.episodeAudioAssets.episodeId, episode.id)).all().length, 1)
})

test('同一剧集运行中再次启动返回 409', async () => {
  const { episode, drama } = newEpisode('并发启动')
  let started = false
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => { release = resolve })
  const deps = {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => makePlan([makeItem({ itemId: 'ambience:scene:10', sourceHash: 'hash-409' })]),
    generate: async () => { started = true; await gate; return generated() },
  }

  await startSoundscape(episode.id, drama.id, makeRequest(), deps)
  await waitFor(() => (started ? true : undefined))
  await assert.rejects(
    startSoundscape(episode.id, drama.id, makeRequest(), deps),
    (error: any) => error instanceof SoundscapeError && error.status === 409,
  )
  release!()
  await waitStatus(episode.id, 'completed')
})

test('取消后任务取消且不写轨', async () => {
  const { episode, drama } = newEpisode('取消')
  let started = false
  const spy = spyApply()
  await startSoundscape(episode.id, drama.id, makeRequest(), {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => makePlan([makeItem({ itemId: 'ambience:scene:10', sourceHash: 'hash-cancel' })]),
    generate: (input) => new Promise((_resolve, reject) => {
      started = true
      input.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }),
    applyPlan: spy.applyPlan,
  })

  await waitFor(() => (started ? true : undefined))
  assert.equal(cancelSoundscape(episode.id), true)
  const cancelled = await waitStatus(episode.id, 'cancelled')
  assert.equal(spy.calls.length, 0)
  assert.equal(cancelled.progress < 100, true)
})

test('服务重启后无内存的运行任务标记失败', () => {
  const { episode, drama } = newEpisode('重启恢复')
  db.insert(schema.dubbingJobs).values({
    episodeId: episode.id,
    dramaId: drama.id,
    kind: 'soundscape',
    status: 'running',
    progress: 40,
    step: '生成 环境声 · 场景 1',
    createdAt: ts,
    updatedAt: ts,
    startedAt: ts,
  }).run()

  const status = getSoundscapeStatus(episode.id)
  assert.equal(status.status, 'failed')
  assert.match(status.error || '', /服务重启/)
})

test('不同剧集共用 ComfyUI 时全局串行', async () => {
  const first = newEpisode('串行 A')
  const second = newEpisode('串行 B')
  let current = 0
  let maxConcurrent = 0
  const deps = {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => makePlan([makeItem({ itemId: 'ambience:scene:10', sourceHash: 'hash-serial' })]),
    generate: async () => {
      current += 1
      maxConcurrent = Math.max(maxConcurrent, current)
      await new Promise((resolve) => setTimeout(resolve, 20))
      current -= 1
      return generated()
    },
  }

  await startSoundscape(first.episode.id, first.drama.id, makeRequest(), deps)
  await startSoundscape(second.episode.id, second.drama.id, makeRequest(), deps)
  await waitStatus(first.episode.id, 'completed')
  await waitStatus(second.episode.id, 'completed')
  assert.equal(maxConcurrent, 1)
})

test('群众台词复用激活 Take，缺失配音交给写轨警告', async () => {
  const { episode, drama } = newEpisode('群众台词')
  const audioDir = path.join(root, 'static', 'projects', String(drama.id), 'audio')
  fs.mkdirSync(audioDir, { recursive: true })
  fs.copyFileSync(fixturePath, path.join(audioDir, 'voice.wav'))
  const takeUrl = `static/projects/${drama.id}/audio/voice.wav`

  const lineOne = db.insert(schema.storyboardLines).values({
    episodeId: episode.id,
    dramaId: drama.id,
    lineNo: 3,
    text: '快看那边',
    speakerName: '路人甲',
    speakerType: 'dialogue',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const lineTwo = db.insert(schema.storyboardLines).values({
    episodeId: episode.id,
    dramaId: drama.id,
    lineNo: 4,
    text: '欢迎回来',
    speakerName: '村民们',
    speakerType: 'dialogue',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const take = db.insert(schema.lineTakes).values({
    lineId: lineOne.id,
    episodeId: episode.id,
    dramaId: drama.id,
    takeNo: 1,
    text: '快看那边',
    audioUrl: takeUrl,
    durationMs: 1200,
    status: 'ready',
    isActive: true,
    createdAt: ts,
  }).returning().get()
  db.update(schema.storyboardLines).set({ activeTakeId: take.id })
    .where(eq(schema.storyboardLines.id, lineOne.id)).run()

  const plan = makePlan([makeItem({
    itemId: 'crowd:scene:10',
    category: 'crowd',
    source: 'lines',
    sourceHash: '',
    seconds: 0,
    prompt: '',
    lineIds: [lineOne.id, lineTwo.id],
  })], 'scenes', {
    [lineOne.id]: { startMs: 1000, speaker: '路人甲', lineNo: 3 },
    [lineTwo.id]: { startMs: 3000, speaker: '村民们', lineNo: 4 },
  })

  const spy = spyApply()
  const applyPlan = (input: ApplySoundscapePlanInput) => {
    spy.calls.push(input)
    return { trackIds: [9], clipCount: 1, warnings: [`第 ${lineTwo.lineNo} 句群众台词尚未配音`] }
  }

  await startSoundscape(episode.id, drama.id, makeRequest({ categories: ['crowd'], crowdMode: 'lines' }), {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => plan,
    applyPlan,
  })

  const done = await waitStatus(episode.id, 'completed')
  assert.equal(done.counts.done, 1)
  assert.match(done.warnings.join('\n'), /第 4 句群众台词尚未配音/)
  assert.deepEqual([...spy.calls[0].succeededCategories], ['crowd'])
  const ref = spy.calls[0].lineRefs.get(lineOne.id)!
  assert.equal(ref.takeId, take.id)
  assert.equal(ref.startMs, 1000)
  assert.equal(ref.durationMs, 1200)
  assert.equal(ref.speaker, '路人甲')
  assert.equal(spy.calls[0].lineRefs.has(lineTwo.id), false)
})

test('未配置返回 503，非 ComfyUI 返回 400，预览不建任务', async () => {
  const { episode, drama } = newEpisode('配置校验')
  await assert.rejects(
    startSoundscape(episode.id, drama.id, makeRequest(), { resolveConfig: async () => null }),
    (error: any) => error instanceof SoundscapeError && error.status === 503,
  )
  await assert.rejects(
    startSoundscape(episode.id, drama.id, makeRequest(), {
      resolveConfig: async () => ({ ...makeConfig(), provider: 'openai' }),
    }),
    (error: any) => error instanceof SoundscapeError && error.status === 400,
  )

  const preview = await previewSoundscape(episode.id, drama.id, makeRequest(), {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => makePlan([makeItem({ itemId: 'ambience:scene:10' })]),
  })
  assert.equal(preview.plan.items.length, 1)
  assert.equal(preview.model, 'stable-audio-open-1.0')
  assert.equal(db.select().from(schema.dubbingJobs)
    .where(and(
      eq(schema.dubbingJobs.episodeId, episode.id),
      eq(schema.dubbingJobs.kind, 'soundscape'),
    )).all().length, 0)
})

test('预览与启动参数一致时复用编译结果', async () => {
  const { episode, drama } = newEpisode('预览缓存')
  let compiles = 0
  const deps = {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => {
      compiles += 1
      return makePlan([makeItem({ itemId: 'ambience:scene:10', sourceHash: 'hash-preview' })])
    },
    generate: async () => generated(),
    applyPlan: spyApply().applyPlan,
  }

  await previewSoundscape(episode.id, drama.id, makeRequest(), deps)
  await startSoundscape(episode.id, drama.id, makeRequest(), deps)
  await waitStatus(episode.id, 'completed')
  assert.equal(compiles, 1)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/soundscape.test.ts`
Expected: FAIL，`Cannot find module '../src/services/soundscape.ts'`。

- [ ] **Step 3: 写实现**

创建 `backend/src/services/soundscape.ts`：

```ts
/**
 * 声音场景生成任务编排（设计 11）
 *
 * dubbing_jobs(kind='soundscape') + 内存 active Map：
 * 单集互斥、全局 ComfyUI 串行、sourceHash 缓存、取消与重启恢复。
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAbsolutePath } from '../utils/storage.js'
import { ffmpeg } from '../utils/ffmpeg.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'
import { probeDurationMs } from './audio-mix.js'
import { projectSubdirPath, projectStorageRelative } from './project-storage.js'
import {
  parseComfyWorkflow,
  readComfySettings,
} from './adapters/comfyui.js'
import {
  assertAudioWorkflowPrompt,
  cancelComfyPrompt,
  runComfyAudio,
  type AudioGenerateInput,
  type AudioGenerateResult,
} from './adapters/comfyui-audio.js'
import {
  SoundscapeError,
  compileSoundscapePlan,
  hashSoundscapeWorkflow,
  type CompileSoundscapeOptions,
  type SoundscapeCategory,
  type SoundscapeItem,
  type SoundscapePlan,
  type SoundscapeRequest,
} from './soundscape-compiler.js'
import {
  applySoundscapePlan,
  type ApplySoundscapePlanInput,
  type ApplySoundscapePlanResult,
  type SoundscapeAssetRef,
  type SoundscapeLineRef,
} from './soundscape-tracks.js'

export interface SoundscapeRunCounts {
  total: number
  done: number
  generate: number
  lines: number
  failed: number
  reused: number
  clips: number
}

export interface SoundscapeStatus {
  jobId: number | null
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  step: string | null
  error: string | null
  counts: { total: number; done: number; failed: number; reused: number; clips: number }
  warnings: string[]
  startedAt: string | null
  finishedAt: string | null
}

export interface SoundscapePreview {
  plan: SoundscapePlan
  model: string
  workflowHash: string
  normalizeLoudness: boolean
}

export interface SoundscapeDeps {
  resolveConfig?: (configId?: number) => Promise<AIConfig | null>
  compilePlan?: (options: CompileSoundscapeOptions) => Promise<SoundscapePlan>
  generate?: (input: AudioGenerateInput) => Promise<AudioGenerateResult>
  applyPlan?: (input: ApplySoundscapePlanInput) => ApplySoundscapePlanResult
  loadActiveTakes?: (
    episodeId: number,
    lineIds: number[],
    cues: SoundscapePlan['lineCues'],
  ) => Promise<Map<number, SoundscapeLineRef>>
}

interface SoundscapeSetup {
  config: AIConfig
  model: string
  workflowHash: string
  normalizeLoudness: boolean
  fixedSeed: number | null
  timeoutMs: number
  modelLicense: string
}

interface ActiveSoundscapeJob {
  jobId: number
  controller: AbortController
  progress: number
  step: string
  promptId: string | null
  config: AIConfig
  counts: SoundscapeRunCounts
  warnings: string[]
}

const CATEGORY_LABELS: Record<SoundscapeCategory, string> = {
  ambience: '环境声',
  sfx: '场景音效',
  crowd: '群众声',
  bgm: '配乐',
}

const active = new Map<number, ActiveSoundscapeJob>()
const starting = new Set<number>()

const PREVIEW_TTL_MS = 10 * 60 * 1000
interface PreviewCacheEntry {
  key: string
  at: number
  plan: SoundscapePlan
}
const previewCache = new Map<number, PreviewCacheEntry>()

function previewKey(request: SoundscapeRequest, setup: SoundscapeSetup): string {
  return JSON.stringify({
    mode: request.mode,
    categories: request.categories,
    crowdMode: request.crowdMode,
    sceneIds: request.sceneIds,
    overwrite: request.overwrite,
    overrides: request.overrides,
    configId: request.configId,
    model: setup.model,
    workflowHash: setup.workflowHash,
    normalizeLoudness: setup.normalizeLoudness,
    fixedSeed: setup.fixedSeed,
  })
}

let comfyChain: Promise<unknown> = Promise.resolve()

function serializeComfy<T>(task: () => Promise<T>): Promise<T> {
  const run = comfyChain.then(task, task)
  comfyChain = run.then(() => undefined, () => undefined)
  return run
}

function requireEpisode(episodeId: number, dramaId?: number) {
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode || (dramaId !== undefined && episode.dramaId !== dramaId)) {
    throw new SoundscapeError('集不存在', 404)
  }
  return episode
}

function latestJob(episodeId: number) {
  return db.select().from(schema.dubbingJobs)
    .where(and(
      eq(schema.dubbingJobs.episodeId, episodeId),
      eq(schema.dubbingJobs.kind, 'soundscape'),
    ))
    .orderBy(desc(schema.dubbingJobs.id))
    .get()
}

function patchJob(jobId: number, patch: Partial<typeof schema.dubbingJobs.$inferInsert>) {
  db.update(schema.dubbingJobs).set({ ...patch, updatedAt: now() })
    .where(eq(schema.dubbingJobs.id, jobId)).run()
}

function parsePayload(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function publicCounts(counts: SoundscapeRunCounts): SoundscapeStatus['counts'] {
  return {
    total: counts.total,
    done: counts.done,
    failed: counts.failed,
    reused: counts.reused,
    clips: counts.clips,
  }
}

function readCounts(raw: unknown): SoundscapeStatus['counts'] {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const number = (key: string) => (typeof value[key] === 'number' ? value[key] as number : 0)
  return {
    total: number('total'),
    done: number('done'),
    failed: number('failed'),
    reused: number('reused'),
    clips: number('clips'),
  }
}

function statusOf(
  job: typeof schema.dubbingJobs.$inferSelect,
  memory?: ActiveSoundscapeJob,
): SoundscapeStatus {
  let status: SoundscapeStatus['status']
  if (job.status === 'completed') status = 'completed'
  else if (job.status === 'failed') status = 'failed'
  else if (job.status === 'cancelled') status = 'cancelled'
  else if (job.status === 'running' || job.status === 'pending') status = 'running'
  else status = 'idle'
  const payload = parsePayload(job.resultJson)
  return {
    jobId: job.id,
    status,
    progress: memory?.progress ?? job.progress ?? 0,
    step: memory?.step ?? job.step ?? null,
    error: job.error,
    counts: memory ? publicCounts(memory.counts) : readCounts(payload.counts),
    warnings: memory
      ? [...memory.warnings]
      : (Array.isArray(payload.warnings) ? payload.warnings.filter((w: unknown): w is string => typeof w === 'string') : []),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

async function resolveSetup(configId: number | undefined, deps: SoundscapeDeps): Promise<SoundscapeSetup> {
  const resolve = deps.resolveConfig
    ?? ((id?: number) => (id ? getConfigById(id) : getActiveConfig('audio-gen')))
  const config = await resolve(configId)
  if (!config) {
    throw new SoundscapeError('未配置音频生成服务（audio-gen），请先在设置中添加 ComfyUI 服务', 503)
  }
  if (config.serviceType && config.serviceType !== 'audio-gen') {
    throw new SoundscapeError('所选服务不是音频生成服务', 400)
  }
  if ((config.provider || '').toLowerCase() !== 'comfyui') {
    throw new SoundscapeError('音频生成目前只支持 ComfyUI 服务', 400)
  }
  let workflow: Record<string, unknown>
  try {
    workflow = parseComfyWorkflow(config)
    assertAudioWorkflowPrompt(workflow)
  } catch (error) {
    throw new SoundscapeError((error as Error).message, 400)
  }
  const settings = readComfySettings(config)
  return {
    config,
    model: config.model,
    workflowHash: hashSoundscapeWorkflow(workflow),
    normalizeLoudness: settings.normalizeLoudness ?? true,
    fixedSeed: settings.seed ?? null,
    timeoutMs: settings.timeoutMs ?? 600000,
    modelLicense: settings.modelLicense ?? 'stability-ai-community',
  }
}

function compilePlan(
  episodeId: number,
  dramaId: number,
  request: SoundscapeRequest,
  setup: SoundscapeSetup,
  deps: SoundscapeDeps,
): Promise<SoundscapePlan> {
  const options: CompileSoundscapeOptions = {
    request,
    model: setup.model,
    workflowHash: setup.workflowHash,
    normalizeLoudness: setup.normalizeLoudness,
    fixedSeed: setup.fixedSeed,
  }
  const compile = deps.compilePlan
    ?? ((value: CompileSoundscapeOptions) => compileSoundscapePlan(episodeId, dramaId, value))
  return compile(options)
}

async function compilePlanCached(
  episodeId: number,
  dramaId: number,
  request: SoundscapeRequest,
  setup: SoundscapeSetup,
  deps: SoundscapeDeps,
): Promise<SoundscapePlan> {
  const key = previewKey(request, setup)
  const cached = previewCache.get(episodeId)
  if (cached && cached.key === key && Date.now() - cached.at < PREVIEW_TTL_MS) {
    return cached.plan
  }
  const plan = await compilePlan(episodeId, dramaId, request, setup, deps)
  previewCache.set(episodeId, { key, at: Date.now(), plan })
  return plan
}

export async function previewSoundscape(
  episodeId: number,
  dramaId: number,
  request: SoundscapeRequest,
  deps: SoundscapeDeps = {},
): Promise<SoundscapePreview> {
  requireEpisode(episodeId, dramaId)
  const setup = await resolveSetup(request.configId, deps)
  const plan = await compilePlanCached(episodeId, dramaId, request, setup, deps)
  return {
    plan,
    model: setup.model,
    workflowHash: setup.workflowHash,
    normalizeLoudness: setup.normalizeLoudness,
  }
}

export async function startSoundscape(
  episodeId: number,
  dramaId: number,
  request: SoundscapeRequest,
  deps: SoundscapeDeps = {},
): Promise<{ jobId: number; status: 'running' }> {
  const episode = requireEpisode(episodeId, dramaId)
  if (active.has(episodeId) || starting.has(episodeId)) {
    throw new SoundscapeError('当前剧集正在生成声音', 409)
  }
  starting.add(episodeId)
  try {
    const latest = latestJob(episodeId)
    if (latest && (latest.status === 'running' || latest.status === 'pending')) {
      patchJob(latest.id, {
        status: 'failed',
        error: '服务重启导致任务中断，请重新生成',
        finishedAt: now(),
      })
    }

    const setup = await resolveSetup(request.configId, deps)
    const plan = await compilePlanCached(episodeId, dramaId, request, setup, deps)
    if (plan.items.length === 0) {
      throw new SoundscapeError('没有可生成的声音项', 400)
    }

    const job = db.insert(schema.dubbingJobs).values({
      episodeId,
      dramaId: episode.dramaId,
      kind: 'soundscape',
      status: 'running',
      progress: 0,
      step: '准备生成',
      payloadJson: JSON.stringify(request),
      startedAt: now(),
      createdAt: now(),
      updatedAt: now(),
    }).returning().get()

    const memory: ActiveSoundscapeJob = {
      jobId: job.id,
      controller: new AbortController(),
      progress: 0,
      step: '准备生成',
      promptId: null,
      config: setup.config,
      counts: { total: plan.items.length, done: 0, generate: 0, lines: 0, failed: 0, reused: 0, clips: 0 },
      warnings: [...plan.warnings],
    }
    active.set(episodeId, memory)

    void executeSoundscape({
      episodeId,
      dramaId: episode.dramaId,
      jobId: job.id,
      request,
      plan,
      setup,
      memory,
      deps,
    })
      .catch((error) => {
        if (!memory.controller.signal.aborted) {
          patchJob(job.id, {
            status: 'failed',
            error: (error as Error).message,
            step: '生成失败',
            finishedAt: now(),
          })
        }
      })
      .finally(() => {
        if (active.get(episodeId) === memory) active.delete(episodeId)
      })

    return { jobId: job.id, status: 'running' }
  } finally {
    starting.delete(episodeId)
  }
}

export function getSoundscapeStatus(episodeId: number): SoundscapeStatus {
  requireEpisode(episodeId)
  const job = latestJob(episodeId)
  if (!job) {
    return {
      jobId: null,
      status: 'idle',
      progress: 0,
      step: null,
      error: null,
      counts: { total: 0, done: 0, failed: 0, reused: 0, clips: 0 },
      warnings: [],
      startedAt: null,
      finishedAt: null,
    }
  }
  const memory = active.get(episodeId)
  if ((job.status === 'running' || job.status === 'pending') && !memory) {
    patchJob(job.id, {
      status: 'failed',
      error: '服务重启导致任务中断，请重新生成',
      finishedAt: now(),
    })
    return statusOf(latestJob(episodeId)!, undefined)
  }
  return statusOf(job, memory)
}

export function cancelSoundscape(episodeId: number): boolean {
  requireEpisode(episodeId)
  const memory = active.get(episodeId)
  if (memory) {
    memory.controller.abort()
    if (memory.promptId) {
      void cancelComfyPrompt(memory.config, memory.promptId).catch(() => {})
    }
    patchJob(memory.jobId, { status: 'cancelled', step: '已取消', finishedAt: now() })
    return true
  }
  const job = latestJob(episodeId)
  if (job && (job.status === 'running' || job.status === 'pending')) {
    patchJob(job.id, { status: 'cancelled', step: '已取消', finishedAt: now() })
    return true
  }
  return false
}

export function isSoundscapeRunning(episodeId: number): boolean {
  return active.has(episodeId) || starting.has(episodeId)
}

function sceneLabelOf(plan: SoundscapePlan, sceneId: number | null): string {
  return sceneId == null ? '整集' : `场景 ${plan.sceneLabels[sceneId] ?? sceneId}`
}

function stepLabel(plan: SoundscapePlan, item: SoundscapeItem): string {
  const scene = sceneLabelOf(plan, item.sceneId)
  if (item.source === 'lines') return `整理 群众台词 · ${scene}`
  return `生成 ${CATEGORY_LABELS[item.category]} · ${scene}`
}

function findReadyAsset(episodeId: number, sourceHash: string): SoundscapeAssetRef | null {
  if (!sourceHash) return null
  const rows = db.select().from(schema.episodeAudioAssets)
    .where(and(
      eq(schema.episodeAudioAssets.episodeId, episodeId),
      eq(schema.episodeAudioAssets.kind, 'soundscape'),
      eq(schema.episodeAudioAssets.sourceHash, sourceHash),
      isNull(schema.episodeAudioAssets.deletedAt),
    ))
    .orderBy(desc(schema.episodeAudioAssets.id))
    .all()
  for (const row of rows) {
    if (row.status !== 'ready' || !row.url) continue
    try {
      if (fs.existsSync(getAbsolutePath(row.url))) return { id: row.id, url: row.url }
    } catch {}
  }
  return null
}

function normalizeAudioFile(source: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(source)
      .audioFilters('loudnorm=I=-18:TP=-2:LRA=11')
      .outputOptions(['-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le'])
      .output(target)
      .on('end', () => resolve())
      .on('error', (error) => reject(error))
      .run()
  })
}

async function saveGeneratedAsset(input: {
  episodeId: number
  dramaId: number
  item: SoundscapeItem
  result: AudioGenerateResult
  setup: SoundscapeSetup
  warnings: string[]
}): Promise<SoundscapeAssetRef> {
  if (!input.result.buffer || input.result.buffer.length === 0) {
    throw new Error('ComfyUI 没有返回音频数据')
  }
  const dir = projectSubdirPath(input.dramaId, 'audio/soundscape')
  fs.mkdirSync(dir, { recursive: true })
  const ext = /^[a-z0-9]{2,5}$/i.test(input.result.extension) ? input.result.extension.toLowerCase() : 'wav'
  const base = (input.item.sourceHash || randomUUID()).slice(0, 16)
  let file = path.join(dir, `${base}.${ext}`)
  fs.writeFileSync(file, input.result.buffer)

  let normalized = false
  if (input.setup.normalizeLoudness) {
    const normalizedFile = path.join(dir, `${base}-norm.wav`)
    try {
      await normalizeAudioFile(file, normalizedFile)
      fs.rmSync(file, { force: true })
      file = normalizedFile
      normalized = true
    } catch (error) {
      fs.rmSync(normalizedFile, { force: true })
      input.warnings.push(`生成项 ${input.item.itemId} 响度归一化失败，已保留原始音频：${(error as Error).message}`)
    }
  }

  const durationMs = await probeDurationMs(file)
  if (durationMs <= 0) {
    fs.rmSync(file, { force: true })
    throw new Error('生成的音频无法解析时长')
  }

  const url = projectStorageRelative(input.dramaId, 'audio/soundscape', path.basename(file))
  const row = db.insert(schema.episodeAudioAssets).values({
    episodeId: input.episodeId,
    dramaId: input.dramaId,
    kind: 'soundscape',
    sourceHash: input.item.sourceHash,
    url,
    durationMs,
    sampleRate: 48000,
    channels: 2,
    engine: 'comfyui',
    model: input.setup.model,
    modelLicense: input.setup.modelLicense,
    status: 'ready',
    metadataJson: JSON.stringify({
      itemId: input.item.itemId,
      category: input.item.category,
      seed: input.item.seed,
      seconds: input.item.seconds,
      loop: input.item.loop,
      normalized,
    }),
    createdAt: now(),
  }).returning().get()
  return { id: row.id, url }
}

export async function loadActiveTakes(
  episodeId: number,
  lineIds: number[],
  cues: SoundscapePlan['lineCues'],
): Promise<Map<number, SoundscapeLineRef>> {
  const result = new Map<number, SoundscapeLineRef>()
  if (lineIds.length === 0) return result
  const takes = db.select().from(schema.lineTakes)
    .where(and(
      eq(schema.lineTakes.episodeId, episodeId),
      eq(schema.lineTakes.isActive, true),
      isNull(schema.lineTakes.deletedAt),
      inArray(schema.lineTakes.lineId, lineIds),
    ))
    .all()
  const lines = db.select().from(schema.storyboardLines)
    .where(and(
      eq(schema.storyboardLines.episodeId, episodeId),
      isNull(schema.storyboardLines.deletedAt),
      inArray(schema.storyboardLines.id, lineIds),
    ))
    .all()
  const lineById = new Map(lines.map((line) => [line.id, line]))

  for (const take of takes) {
    const line = lineById.get(take.lineId)
    const url = take.audioUrl || (line?.activeTakeId === take.id ? line.audioUrl : null)
    if (!url) continue
    let durationMs = take.durationMs || line?.audioDurationMs || 0
    if (durationMs <= 0) {
      try {
        durationMs = await probeDurationMs(path.isAbsolute(url) ? url : getAbsolutePath(url))
      } catch {
        durationMs = 0
      }
    }
    if (durationMs <= 0) continue
    const cue = cues[take.lineId]
    result.set(take.lineId, {
      lineId: take.lineId,
      lineNo: cue?.lineNo ?? line?.lineNo ?? take.lineId,
      speaker: cue?.speaker ?? line?.speakerName ?? '群众',
      startMs: cue?.startMs ?? line?.plannedStartMs ?? 0,
      durationMs,
      audioUrl: url,
      takeId: take.id,
    })
  }
  return result
}

interface ExecuteSoundscapeParams {
  episodeId: number
  dramaId: number
  jobId: number
  request: SoundscapeRequest
  plan: SoundscapePlan
  setup: SoundscapeSetup
  memory: ActiveSoundscapeJob
  deps: SoundscapeDeps
}

async function executeSoundscape(params: ExecuteSoundscapeParams): Promise<void> {
  const { episodeId, dramaId, jobId, request, plan, setup, memory, deps } = params
  const generate = deps.generate ?? runComfyAudio
  const applyPlan = deps.applyPlan ?? applySoundscapePlan
  const warnings = memory.warnings
  const counts = memory.counts
  counts.total = plan.items.length

  const assetsByHash = new Map<string, SoundscapeAssetRef>()
  const assetIds: number[] = []
  const succeededCategories = new Set<SoundscapeCategory>()
  let lineRefs = new Map<number, SoundscapeLineRef>()
  let generatedOk = 0
  let processed = 0
  const total = Math.max(1, plan.items.length)

  const lineIds = [...new Set(plan.items
    .filter((item) => item.source === 'lines')
    .flatMap((item) => item.lineIds))]
  if (lineIds.length > 0) {
    lineRefs = await (deps.loadActiveTakes ?? loadActiveTakes)(episodeId, lineIds, plan.lineCues)
  }

  for (const item of plan.items) {
    if (memory.controller.signal.aborted) return
    memory.step = stepLabel(plan, item)

    if (item.source === 'lines') {
      processed += 1
      counts.done += 1
      counts.lines += 1
      if (item.lineIds.some((lineId) => Boolean(lineRefs.get(lineId)?.audioUrl))) {
        succeededCategories.add(item.category)
      }
      memory.progress = Math.min(99, Math.round((processed / total) * 100))
      continue
    }

    counts.generate += 1
    let asset: SoundscapeAssetRef | null = request.overwrite
      ? null
      : findReadyAsset(episodeId, item.sourceHash)

    if (asset) {
      counts.reused += 1
    } else {
      try {
        const result = await serializeComfy(async () => {
          if (memory.controller.signal.aborted) throw new Error('任务已取消')
          return generate({
            config: setup.config,
            prompt: item.prompt,
            negativePrompt: item.negativePrompt,
            seconds: item.seconds,
            seed: item.seed,
            model: setup.model,
            timeoutMs: setup.timeoutMs,
            signal: memory.controller.signal,
            onPromptId: (promptId) => { memory.promptId = promptId },
          })
        })
        if (memory.controller.signal.aborted) return
        asset = await saveGeneratedAsset({
          episodeId,
          dramaId,
          item,
          result,
          setup,
          warnings,
        })
        assetIds.push(asset.id)
      } catch (error) {
        if (memory.controller.signal.aborted) return
        counts.failed += 1
        warnings.push(`生成项 ${item.itemId} 失败：${(error as Error).message}`)
        processed += 1
        memory.progress = Math.min(99, Math.round((processed / total) * 100))
        continue
      }
    }

    assetsByHash.set(item.sourceHash, asset)
    succeededCategories.add(item.category)
    generatedOk += 1
    counts.done += 1
    processed += 1
    memory.progress = Math.min(99, Math.round((processed / total) * 100))
  }

  if (memory.controller.signal.aborted) return

  let trackIds: number[] = []
  let clipCount = 0
  if (plan.mode !== 'assets-only' && succeededCategories.size > 0) {
    memory.step = '整理生成轨'
    const applied = applyPlan({
      episodeId,
      mode: plan.mode,
      plan,
      succeededCategories,
      assetsByHash,
      lineRefs,
    })
    trackIds = applied.trackIds
    clipCount = applied.clipCount
    warnings.push(...applied.warnings)
    counts.clips = clipCount
  }

  const uniqueWarnings = [...new Set(warnings)]
  warnings.splice(0, warnings.length, ...uniqueWarnings)
  const resultJson = JSON.stringify({
    assetIds,
    trackIds,
    clipCount,
    counts: publicCounts(counts),
    warnings: uniqueWarnings,
  })

  if (counts.generate > 0 && generatedOk === 0) {
    patchJob(jobId, {
      status: 'failed',
      error: '全部生成项都失败了，请检查 ComfyUI 工作流与模型',
      progress: 100,
      step: '生成失败',
      resultJson,
      finishedAt: now(),
    })
    return
  }

  memory.progress = 100
  memory.step = '生成完成'
  patchJob(jobId, {
    status: 'completed',
    progress: 100,
    step: '生成完成',
    resultJson,
    finishedAt: now(),
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --test tests/soundscape.test.ts`
Expected: PASS。若“完整任务”在进度 50 处等待超时，检查 `memory.progress` 是否在每项处理完后更新；若“全局串行”失败，确认 `serializeComfy` 包住的是 `generate` 调用而不是整个任务。

---

## Task 9: 混音计划兼容与回归

**Files:**
- Modify: `backend/src/services/mix-plan.ts:11, 236-297, 467-514`
- Modify: `backend/src/services/audio-separation.ts:175-196, 441-449`
- Test: `backend/tests/mix-plan.test.ts`
- Test: `backend/tests/audio-separation.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `episode_audio_tracks.origin`；现有 `episode_audio_clips.assetId / takeId / lineId / audioUrl`；Task 8 写入的 `episode_audio_assets.kind='soundscape'`。
- Produces: `compileMixPlan` 返回的 `MixTrack.origin` 可用于前端 AI 徽标；生成环境声不再关闭合片原声床；群众台词不重复进入虚拟对白轨；删除生成素材只清理引用片段并保留空轨；`autoCreateStemTracks` 不再处理 `soundscape` 素材。

- [ ] **Step 1: 写失败测试（mix-plan）**

`backend/tests/mix-plan.test.ts` 顶部的两个辅助函数都要增加可选的 `episodeId`（默认沿用原有 `episode.id`），否则新夹具（第 6 集）的轨道/片段会落到第 1 集：

```ts
function insertTrack(input: {
  role: string; kind: string; name: string; solo?: boolean; muted?: boolean; busId?: number | null
  origin?: string | null; episodeId?: number
}) {
  return db.insert(schema.episodeAudioTracks).values({
    episodeId: input.episodeId ?? episode.id, dramaId: 1, kind: input.kind, role: input.role, name: input.name,
    volume: 1, pan: 0, busId: input.busId ?? null, muted: input.muted ?? false, solo: input.solo ?? false,
    ducking: input.role !== 'voice', loop: false, locked: false, hidden: false,
    color: '#0ea5e9', height: 72, sortOrder: 10, origin: input.origin ?? null,
    createdAt: ts, updatedAt: ts,
  }).returning().get()
}

function insertClip(trackId: number, input: {
  startMs: number; endMs: number; url: string | null; name?: string; episodeId?: number
}) {
  return db.insert(schema.episodeAudioClips).values({
    trackId, episodeId: input.episodeId ?? episode.id, startMs: input.startMs, endMs: input.endMs,
    sourceStartMs: 0, gainDb: 0, pan: 0, fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear',
    sourceUrl: input.url, audioUrl: input.url, status: 'ready', name: input.name || null,
    createdAt: ts, updatedAt: ts,
  }).returning().get()
}
```

在文件末尾追加测试。先准备一套独立夹具，避免影响已有测试：

```ts
const [compatEpisode] = db.insert(schema.episodes).values({
  dramaId: 1, episodeNumber: 6, title: '第6集', bgmUrl: toneUrl, createdAt: ts, updatedAt: ts,
}).returning().all()
db.insert(schema.videoMerges).values({
  episodeId: compatEpisode.id, dramaId: 1, title: '第6集合片', provider: 'ffmpeg', model: 'test',
  status: 'completed', kind: 'concat', mergedUrl: shotUrl, duration: 2,
  createdAt: ts, completedAt: ts,
}).run()
const [compatStoryboard] = db.insert(schema.storyboards).values({
  episodeId: compatEpisode.id, storyboardNumber: 1, description: '街头', videoUrl: shotUrl,
  createdAt: ts, updatedAt: ts,
}).returning().all()
const [crowdLine] = db.insert(schema.storyboardLines).values({
  episodeId: compatEpisode.id, dramaId: 1, storyboardId: compatStoryboard.id,
  lineNo: 1, sortOrder: 1, speakerType: 'crowd', speakerName: '路人甲',
  text: '快看那边！', speakText: '快看那边！', plannedStartMs: 0, audioDurationMs: 1000,
  audioUrl: toneUrl, status: 'ready', createdAt: ts, updatedAt: ts,
}).returning().all()
const [crowdTake] = db.insert(schema.lineTakes).values({
  lineId: crowdLine.id, episodeId: compatEpisode.id, dramaId: 1, takeNo: 1,
  text: crowdLine.text, speakText: crowdLine.speakText, audioUrl: toneUrl, durationMs: 1000,
  status: 'ready', isActive: true, createdAt: ts,
}).returning().all()

const { deleteEpisodeAsset } = await import('../src/services/audio-separation.ts')

test('生成的环境声轨与原声总床共存，origin 随计划返回', async () => {
  const before = await compileMixPlan(compatEpisode.id, 1)
  assert.ok(
    before.tracks.some((track) => track.virtual && track.role === 'original'),
    '前置条件：合片原声床存在',
  )

  const generated = insertTrack({
    role: 'ambience', kind: 'ambience', name: '环境声（AI）', origin: 'soundscape',
    episodeId: compatEpisode.id,
  })
  insertClip(generated.id, { startMs: 0, endMs: 2000, url: toneUrl, episodeId: compatEpisode.id })

  const plan = await compileMixPlan(compatEpisode.id, 1)
  assert.ok(
    plan.tracks.some((track) => track.virtual && track.role === 'original'),
    'AI 环境声不得关闭合片原声床',
  )
  assert.equal(plan.tracks.find((track) => track.id === generated.id)!.origin, 'soundscape')
  assert.equal(
    plan.tracks.find((track) => track.virtual && track.role === 'voice')!.origin,
    null,
    '虚拟轨 origin 必须为 null',
  )
})

test('群众声轨引用的台词不再进入虚拟对白轨，删除后自动恢复', async () => {
  const before = await compileMixPlan(compatEpisode.id, 1)
  const beforeVoice = before.tracks.find((track) => track.virtual && track.role === 'voice')!
  assert.equal(beforeVoice.clips.length, 1)
  assert.equal(beforeVoice.clips[0].lineId, crowdLine.id)

  const crowdTrack = insertTrack({
    role: 'crowd', kind: 'voice', name: '群众声（AI）', origin: 'soundscape',
    episodeId: compatEpisode.id,
  })
  db.insert(schema.episodeAudioClips).values({
    trackId: crowdTrack.id, episodeId: compatEpisode.id,
    assetId: null, takeId: crowdTake.id, lineId: crowdLine.id,
    startMs: 0, endMs: 1000, sourceStartMs: 0, gainDb: 0, pan: 0,
    fadeInMs: 300, fadeOutMs: 300, fadeCurve: 'linear',
    sourceUrl: toneUrl, audioUrl: toneUrl, status: 'ready', name: '群众台词 · 路人甲',
    createdAt: ts, updatedAt: ts,
  }).run()

  const after = await compileMixPlan(compatEpisode.id, 1)
  assert.equal(
    after.tracks.find((track) => track.virtual && track.role === 'voice')!.clips.length,
    0,
    '已被群众轨放置的台词不得在虚拟对白轨重复播放',
  )

  db.delete(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.trackId, crowdTrack.id)).run()
  db.delete(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.id, crowdTrack.id)).run()
  const restored = await compileMixPlan(compatEpisode.id, 1)
  assert.equal(
    restored.tracks.find((track) => track.virtual && track.role === 'voice')!.clips.length,
    1,
    '删除群众轨后台词回到虚拟对白轨',
  )
})

test('生成 BGM 轨关闭虚拟 BGM，删除生成素材后虚拟 BGM 恢复', async () => {
  const before = await compileMixPlan(compatEpisode.id, 1)
  assert.ok(before.tracks.some((track) => track.virtual && track.role === 'bgm'))

  const bgmTrack = insertTrack({
    role: 'bgm', kind: 'bgm', name: '配乐（AI）', origin: 'soundscape', episodeId: compatEpisode.id,
  })
  const bgmAsset = db.insert(schema.episodeAudioAssets).values({
    episodeId: compatEpisode.id, dramaId: 1, kind: 'soundscape', status: 'ready',
    sourceHash: 'c'.repeat(64), url: toneUrl, durationMs: 2000,
    engine: 'comfyui', model: 'stable-audio-open', createdAt: ts,
  }).returning().get()
  db.insert(schema.episodeAudioClips).values({
    trackId: bgmTrack.id, episodeId: compatEpisode.id, assetId: bgmAsset.id,
    startMs: 0, endMs: 2000, sourceStartMs: 0, gainDb: 0, pan: 0,
    fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear',
    sourceUrl: toneUrl, audioUrl: toneUrl, status: 'ready', name: '本集配乐（AI）',
    createdAt: ts, updatedAt: ts,
  }).run()
  const after = await compileMixPlan(compatEpisode.id, 1)
  assert.equal(after.tracks.some((track) => track.virtual && track.role === 'bgm'), false)

  assert.equal(deleteEpisodeAsset(compatEpisode.id, bgmAsset.id), true)
  const tracks = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, compatEpisode.id)).all()
  assert.ok(tracks.some((track) => track.id === bgmTrack.id), '生成轨保留为空轨')
  const restored = await compileMixPlan(compatEpisode.id, 1)
  assert.ok(
    restored.tracks.some((track) => track.virtual && track.role === 'bgm'),
    '删除生成素材后虚拟 BGM 必须恢复',
  )
})

test('保存混音计划保留生成轨 origin 与片段引用，新轨无法伪造 origin', async () => {
  const [saveEpisode] = db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber: 7, title: '第7集', createdAt: ts, updatedAt: ts,
  }).returning().all()
  const asset = db.insert(schema.episodeAudioAssets).values({
    episodeId: saveEpisode.id, dramaId: 1, kind: 'soundscape', status: 'ready',
    sourceHash: 'a'.repeat(64), url: toneUrl, durationMs: 1000,
    engine: 'comfyui', model: 'stable-audio-open', createdAt: ts,
  }).returning().get()
  const track = db.insert(schema.episodeAudioTracks).values({
    episodeId: saveEpisode.id, dramaId: 1, kind: 'ambience', role: 'ambience', name: '环境声（AI）',
    origin: 'soundscape', volume: 0.7, pan: 0, muted: false, solo: false, ducking: true,
    loop: false, locked: false, hidden: false, sortOrder: 0, createdAt: ts, updatedAt: ts,
  }).returning().get()
  const clip = db.insert(schema.episodeAudioClips).values({
    trackId: track.id, episodeId: saveEpisode.id, assetId: asset.id,
    startMs: 0, endMs: 1000, sourceStartMs: 0, gainDb: 0, pan: 0,
    fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear',
    sourceUrl: toneUrl, audioUrl: toneUrl, status: 'ready', name: '场景 1 · 环境声',
    createdAt: ts, updatedAt: ts,
  }).returning().get()

  const saved = await saveMixPlan(saveEpisode.id, 1, {
    tracks: [
      { id: track.id, role: 'ambience', name: '改名后的环境声', busId: 'original', origin: 'sfx' } as any,
      { role: 'sfx', name: '用户音效', origin: 'soundscape' } as any,
    ],
    clips: [
      { id: clip.id, trackId: track.id, assetId: asset.id, startMs: 0, endMs: 1000, audioUrl: toneUrl },
    ],
  })

  const stored = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.id, track.id)).get()!
  assert.equal(stored.origin, 'soundscape', '更新轨道不得覆盖 origin')
  assert.equal(stored.name, '改名后的环境声')

  const storedClip = db.select().from(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.id, clip.id)).get()!
  assert.equal(storedClip.assetId, asset.id)
  assert.equal(storedClip.audioUrl, toneUrl)

  assert.equal(saved.tracks.find((item) => item.id === track.id)!.origin, 'soundscape')
  const userTrack = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, saveEpisode.id)).all()
    .find((item) => item.role === 'sfx')!
  assert.equal(userTrack.origin, null, '新建轨不能由客户端伪造 origin')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/mix-plan.test.ts`
Expected: FAIL。前三个新用例失败于 AI 环境声关闭了原声床 / 群众台词重复出现 / `origin` 未参与判断；保存用例失败于 `stored.origin` 为 `null`（`saveMixPlan` 尚未保留来源）。

- [ ] **Step 3: 实现 mix-plan 兼容逻辑**

`backend/src/services/mix-plan.ts` 第 11 行改为：

```ts
import { and, asc, eq } from 'drizzle-orm'
```

在 `buildVirtualDialogueTrack` 之前新增：

```ts
/** 已放入群众声生成轨的台词，避免虚拟对白轨重复播放 */
function soundscapeCrowdLineIds(episodeId: number): Set<number> {
  const trackIds = new Set(
    db.select({ id: schema.episodeAudioTracks.id })
      .from(schema.episodeAudioTracks)
      .where(and(
        eq(schema.episodeAudioTracks.episodeId, episodeId),
        eq(schema.episodeAudioTracks.origin, 'soundscape'),
        eq(schema.episodeAudioTracks.role, 'crowd'),
      ))
      .all()
      .map((row) => row.id),
  )
  if (!trackIds.size) return new Set()
  const clips = db.select().from(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.episodeId, episodeId))
    .all()
  return new Set(
    clips
      .filter((clip) => trackIds.has(clip.trackId) && clip.lineId != null)
      .map((clip) => clip.lineId!),
  )
}
```

`buildVirtualDialogueTrack` 改为（完整替换函数）：

```ts
function buildVirtualDialogueTrack(
  episodeId: number,
  timeline: Awaited<ReturnType<typeof previewTimeline>>,
  excludedLineIds: Set<number> = new Set(),
): MixTrack {
  const takes = db.select().from(schema.lineTakes)
    .where(eq(schema.lineTakes.episodeId, episodeId))
    .orderBy(asc(schema.lineTakes.takeNo))
    .all()
  const activeByLine = new Map<number, typeof takes[number]>()
  for (const take of takes) {
    if (!take.isActive || take.deletedAt) continue
    activeByLine.set(take.lineId, take)
  }

  const clips: MixClip[] = []
  for (const cue of timeline.cues) {
    if (excludedLineIds.has(cue.lineId)) continue
    const take = activeByLine.get(cue.lineId)
    const rawUrl = take?.audioUrl || cue.audioUrl
    const source = clipSource(rawUrl)
    if (!source.url) continue
    clips.push({
      id: null,
      assetId: null,
      takeId: take?.id ?? null,
      lineId: cue.lineId,
      name: null,
      startMs: cue.startMs,
      endMs: cue.endMs,
      sourceStartMs: 0,
      gainDb: 0,
      pan: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      fadeCurve: 'linear',
      loop: false,
      muted: false,
      locked: false,
      audioUrl: source.url,
      usable: source.usable,
      reason: source.reason,
    })
  }

  return {
    id: null,
    role: 'voice',
    name: '对白',
    busId: 'dialogue',
    virtual: true,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    effectiveMuted: false,
    ducking: false,
    locked: false,
    hidden: false,
    loop: false,
    color: '#f59e0b',
    height: 72,
    sortOrder: -1,
    stemAssetId: null,
    clips,
  }
}
```

`compileMixPlan` 中四处调整：

```ts
const excludedCrowdLineIds = soundscapeCrowdLineIds(episodeId)

const hasOriginalUserTrack = tracks.some((track) => (
  track.origin !== 'soundscape'
  && (track.role === 'original' || track.role === 'ambience' || track.busId === 'original')
))

// 生成 BGM 素材删除后轨道会保留为空壳；空壳不得继续压制虚拟 BGM
const hasBgmUserTrack = tracks.some((track) => (
  (track.role === 'bgm' || track.busId === 'bgm')
  && (track.origin !== 'soundscape' || track.clips.length > 0)
))

const virtualTracks: MixTrack[] = [
  buildVirtualDialogueTrack(episodeId, timeline, excludedCrowdLineIds),
]
```

`saveMixPlan` 的轨道 `values` 对象保持不包含 `origin`，不要新增该字段；这样更新时保留数据库原值，新建时落库默认 `null`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --test tests/mix-plan.test.ts`
Expected: PASS。若保存用例的新建轨 `origin` 不是 `null`，说明 `saveMixPlan` 误加了 `origin: track.origin`，删除该分支。

- [ ] **Step 5: 写失败测试（素材删除与自动建轨）**

在 `backend/tests/audio-separation.test.ts` 末尾追加：

```ts
test('自动建轨跳过 soundscape 素材，删除素材清理引用片段但保留空轨', () => {
  const [soundEpisode] = db.insert(schema.episodes).values({
    dramaId: 1, episodeNumber: 9, title: '第9集', createdAt: ts, updatedAt: ts,
  }).returning().all()
  const asset = db.insert(schema.episodeAudioAssets).values({
    episodeId: soundEpisode.id, dramaId: 1, kind: 'soundscape', status: 'ready',
    sourceHash: 'b'.repeat(64), url: 'static/projects/1/audio/soundscape/bed.wav',
    durationMs: 4000, engine: 'comfyui', model: 'stable-audio-open',
    createdAt: ts,
  }).returning().get()

  const created = autoCreateStemTracks(soundEpisode.id, [asset.id])
  assert.deepEqual(created.tracks, [], 'soundscape 素材不得自动建 A4 自定义轨')

  const track = db.insert(schema.episodeAudioTracks).values({
    episodeId: soundEpisode.id, dramaId: 1, kind: 'ambience', role: 'ambience',
    name: '环境声（AI）', origin: 'soundscape', volume: 1, pan: 0,
    muted: false, solo: false, ducking: true, loop: false, locked: false, hidden: false,
    sortOrder: 10, createdAt: ts, updatedAt: ts,
  }).returning().get()
  db.insert(schema.episodeAudioClips).values({
    trackId: track.id, episodeId: soundEpisode.id, assetId: asset.id,
    startMs: 0, endMs: 4000, sourceStartMs: 0, gainDb: 0, pan: 0,
    fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear',
    sourceUrl: asset.url, audioUrl: asset.url, status: 'ready', name: '场景 1 · 环境声',
    createdAt: ts, updatedAt: ts,
  }).run()

  assert.equal(deleteEpisodeAsset(soundEpisode.id, asset.id), true)
  const clips = db.select().from(schema.episodeAudioClips)
    .where(eq(schema.episodeAudioClips.episodeId, soundEpisode.id)).all()
  assert.equal(clips.length, 0, '引用素材的片段必须删除')
  const tracks = db.select().from(schema.episodeAudioTracks)
    .where(eq(schema.episodeAudioTracks.episodeId, soundEpisode.id)).all()
  assert.deepEqual(tracks.map((row) => row.id), [track.id], '生成轨保留为空轨，方便重新生成')
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/audio-separation.test.ts`
Expected: FAIL。`autoCreateStemTracks` 会为 `soundscape` 素材创建 `A4 soundscape` 轨；`deleteEpisodeAsset` 不会删除 `assetId` 引用的普通片段。

- [ ] **Step 7: 实现素材删除与自动建轨排除**

`backend/src/services/audio-separation.ts` 的 `deleteEpisodeAsset` 整体替换为：

```ts
export function deleteEpisodeAsset(episodeId: number, assetId: number): boolean {
  requireEpisode(episodeId)
  const asset = db.select().from(schema.episodeAudioAssets)
    .where(eq(schema.episodeAudioAssets.id, assetId)).get()
  if (!asset || asset.episodeId !== episodeId || asset.deletedAt) {
    throw new SeparationError('音频素材不存在', 404)
  }
  db.transaction((tx) => {
    tx.delete(schema.episodeAudioClips)
      .where(and(
        eq(schema.episodeAudioClips.episodeId, episodeId),
        eq(schema.episodeAudioClips.assetId, assetId),
      ))
      .run()
    const tracks = tx.select().from(schema.episodeAudioTracks)
      .where(eq(schema.episodeAudioTracks.episodeId, episodeId)).all()
      .filter((track) => track.stemAssetId === assetId)
    for (const track of tracks) {
      tx.delete(schema.episodeAudioClips).where(eq(schema.episodeAudioClips.trackId, track.id)).run()
      tx.delete(schema.episodeAudioTracks).where(eq(schema.episodeAudioTracks.id, track.id)).run()
    }
    tx.update(schema.episodeAudioAssets)
      .set({ deletedAt: now(), status: 'deleted' })
      .where(eq(schema.episodeAudioAssets.id, assetId))
      .run()
  })
  return true
}
```

`autoCreateStemTracks` 的素材过滤改为：

```ts
const assets = db.select().from(schema.episodeAudioAssets)
  .where(and(eq(schema.episodeAudioAssets.episodeId, episodeId), isNull(schema.episodeAudioAssets.deletedAt)))
  .all()
  .filter((asset) => assetIds.includes(asset.id) && asset.kind !== 'soundscape')
```

- [ ] **Step 8: 运行测试确认通过**

Run: `cd backend && npx tsx --test tests/audio-separation.test.ts tests/mix-plan.test.ts`
Expected: PASS。若已有“删除素材不删 Take，只移除素材与关联自动轨”用例失败，确认新插入的片段删除没有误删 `stemAssetId` 轨（该轨仍由原有分支删除）。

- [ ] **Step 9: 回归相关后端套件**

Run: `cd backend && npx tsx --test tests/audio-tracks.test.ts tests/mix-render.test.ts tests/mix-routes.test.ts tests/timeline.test.ts`
Expected: PASS。`mix-routes.test.ts` 当前不应出现 409；保存互斥守卫在 Task 10 接入并测试。

---

## Task 10: 声音生成路由与保存互斥

**Files:**
- Modify: `backend/src/routes/mix.ts:18-43, 63-74, 136-153, 末尾`
- Create: `backend/tests/soundscape-routes.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `previewSoundscape / startSoundscape / getSoundscapeStatus / cancelSoundscape / isSoundscapeRunning / SoundscapeDeps`；Task 6 的 `parseSoundscapeRequest / SoundscapeError`。
- Produces: `createSoundscapeRoutes(deps?: SoundscapeDeps): Hono`；默认 app 挂载同一组路由；`PUT /episodes/:id/mix` 在生成中返回 409。

- [ ] **Step 1: 写失败测试**

创建 `backend/tests/soundscape-routes.test.ts`：

```ts
/**
 * 声音生成路由：预览、启动、状态、取消、保存互斥。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huobao-soundscape-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { createSoundscapeRoutes, default: mixApp } = await import('../src/routes/mix.ts')
const { getSoundscapeStatus, isSoundscapeRunning } = await import('../src/services/soundscape.ts')

const ts = new Date().toISOString()
const drama = db.insert(schema.dramas).values({ title: '声音生成路由', createdAt: ts, updatedAt: ts }).returning().get()
const episode = db.insert(schema.episodes).values({
  dramaId: drama.id, episodeNumber: 1, title: '第 1 集', createdAt: ts, updatedAt: ts,
}).returning().get()

const config = {
  id: 1,
  serviceType: 'audio-gen',
  provider: 'comfyui',
  model: 'stable-audio-open-1.0',
  baseUrl: 'http://127.0.0.1:8188',
  settings: {
    workflow: {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'stable-audio-open-1.0.safetensors' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: '__PROMPT__' } },
    },
    seed: 7,
  },
} as any

const plan = {
  mode: 'scenes',
  items: [{
    itemId: 'ambience:scene:1', category: 'ambience', source: 'generate', sceneId: 1,
    storyboardId: null, startMs: 0, endMs: 18000, seconds: 45, loop: false,
    prompt: 'ambient background, night street', negativePrompt: 'dialogue, music',
    degraded: false, cached: false, seed: 7, sourceHash: 'c'.repeat(64),
  }],
  warnings: [],
  counts: { total: 1, generate: 1, lines: 0, cached: 0 },
  estimatedSeconds: 30,
  degraded: false,
  sceneLabels: { 1: 1 },
  sceneFirstStoryboards: { 1: { startMs: 0, endMs: 2000 } },
  lineCues: {},
} as any

const requestBody = {
  mode: 'scenes',
  categories: ['ambience'],
  crowdMode: 'walla',
  sceneIds: [1],
  overwrite: false,
  overrides: [],
}

function makeDeps(overrides: Record<string, any> = {}) {
  return {
    resolveConfig: async () => config,
    compilePlan: async () => plan,
    applyPlan: () => ({ trackIds: [], clipCount: 0, warnings: [] }),
    loadActiveTakes: async () => new Map(),
    ...overrides,
  }
}

function appWith(deps: Record<string, any>) {
  const app = new Hono()
  app.route('/', createSoundscapeRoutes(deps as any))
  return app
}

async function waitUntil(check: () => boolean, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待条件超时')
}

after(async () => { await fs.promises.rm(root, { recursive: true, force: true }) })

test('POST /preview 返回可展示计划并剥离内部字段', async () => {
  let compiles = 0
  const app = appWith(makeDeps({
    compilePlan: async () => {
      compiles += 1
      return plan
    },
  }))
  const response = await app.request(`/episodes/${episode.id}/audio/soundscape/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(response.status, 200, await response.clone().text())
  const data = (await response.json()).data
  assert.equal(data.mode, 'scenes')
  assert.equal(data.items.length, 1)
  assert.equal(data.items[0].itemId, 'ambience:scene:1')
  assert.equal(data.counts.total, 1)
  assert.equal(data.estimatedSeconds, 30)
  assert.equal(data.model, 'stable-audio-open-1.0')
  assert.equal('sceneLabels' in data, false)
  assert.equal('sceneFirstStoryboards' in data, false)
  assert.equal('lineCues' in data, false)
  assert.equal(compiles, 1)
})

test('非法参数返回 400，未配置 audio-gen 返回 503', async () => {
  const bad = await appWith(makeDeps()).request(`/episodes/${episode.id}/audio/soundscape/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...requestBody, categories: [] }),
  })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).message, /至少选择一个声音类别/)

  const unavailable = await appWith(makeDeps({ resolveConfig: async () => null }))
    .request(`/episodes/${episode.id}/audio/soundscape/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })
  assert.equal(unavailable.status, 503)
  assert.match((await unavailable.json()).message, /audio-gen/)
})

test('未知剧集返回 404', async () => {
  const response = await appWith(makeDeps()).request('/episodes/99999/audio/soundscape/status')
  assert.equal(response.status, 404)
})

test('启动、状态、保存互斥与取消', async () => {
  const generate = (input: any) => new Promise((_, reject) => {
    input.signal?.addEventListener('abort', () => reject(new Error('任务已取消')))
  })
  const app = appWith(makeDeps({ generate }))

  const start = await app.request(`/episodes/${episode.id}/audio/soundscape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(start.status, 200, await start.clone().text())
  const started = (await start.json()).data
  assert.ok(started.jobId)
  assert.equal(started.status, 'running')

  const duplicate = await app.request(`/episodes/${episode.id}/audio/soundscape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(duplicate.status, 409)
  assert.match((await duplicate.json()).message, /正在生成声音/)

  const saveBlocked = await mixApp.request(`/episodes/${episode.id}/mix`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracks: [], clips: [] }),
  })
  assert.equal(saveBlocked.status, 409)
  assert.match((await saveBlocked.json()).message, /声音生成中，暂不能保存混音/)

  const status = await app.request(`/episodes/${episode.id}/audio/soundscape/status`)
  assert.equal(status.status, 200)
  const statusData = (await status.json()).data
  assert.equal(statusData.status, 'running')
  assert.equal(statusData.counts.total, 1)
  assert.match(statusData.step, /生成 环境声/)

  const cancel = await app.request(`/episodes/${episode.id}/audio/soundscape/cancel`, { method: 'POST' })
  assert.equal(cancel.status, 200, await cancel.clone().text())
  assert.equal((await cancel.json()).data.status, 'cancelled')
  await waitUntil(() => !isSoundscapeRunning(episode.id))
  assert.equal(getSoundscapeStatus(episode.id).status, 'cancelled')

  const saveAllowed = await mixApp.request(`/episodes/${episode.id}/mix`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracks: [], clips: [] }),
  })
  assert.equal(saveAllowed.status, 200, await saveAllowed.clone().text())

  const cancelAgain = await app.request(`/episodes/${episode.id}/audio/soundscape/cancel`, { method: 'POST' })
  assert.equal(cancelAgain.status, 409)
})

test('无运行任务时状态为 idle，空计划启动返回 400', async () => {
  const [freshEpisode] = db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: 2, title: '第 2 集', createdAt: ts, updatedAt: ts,
  }).returning().all()
  const app = appWith(makeDeps())
  const idle = await app.request(`/episodes/${freshEpisode.id}/audio/soundscape/status`)
  assert.equal(idle.status, 200)
  assert.equal((await idle.json()).data.status, 'idle')

  const emptyPlan = { ...plan, items: [], counts: { total: 0, generate: 0, lines: 0, cached: 0 }, estimatedSeconds: 0 }
  const emptyApp = appWith(makeDeps({ compilePlan: async () => emptyPlan }))
  const response = await emptyApp.request(`/episodes/${freshEpisode.id}/audio/soundscape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).message, /没有可生成的声音项/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && npx tsx --test tests/soundscape-routes.test.ts`
Expected: FAIL，`createSoundscapeRoutes` 未导出或路由 404；保存互斥返回 200 而非 409。

- [ ] **Step 3: 实现路由与错误映射**

`backend/src/routes/mix.ts` 增加导入：

```ts
import {
  cancelSoundscape,
  getSoundscapeStatus,
  isSoundscapeRunning,
  previewSoundscape,
  startSoundscape,
  type SoundscapeDeps,
} from '../services/soundscape.js'
import { SoundscapeError, parseSoundscapeRequest } from '../services/soundscape-compiler.js'
```

`handleError` 增加分支（`SoundscapeError.status` 含 503，需把现有 `statusError` 的 status 联合类型扩为 `400 | 404 | 409 | 503`，否则 `tsc` 报错）：

```ts
if (error instanceof SoundscapeError) {
  return statusError(c, error.status, error.message)
}
```

在文件末尾、`export default app` 之前新增：

```ts
export function createSoundscapeRoutes(deps: SoundscapeDeps = {}) {
  const routes = new Hono()

  routes.post('/episodes/:id/audio/soundscape/preview', async (c) => {
    const episodeId = parseId(c.req.param('id'))
    if (!episodeId) return badRequest(c, '集编号无效')
    const episode = findEpisode(episodeId)
    if (!episode) return notFound(c, '集不存在')
    const body = await c.req.json().catch(() => ({}))
    try {
      const request = parseSoundscapeRequest(body)
      const result = await previewSoundscape(episodeId, episode.dramaId, request, deps)
      return success(c, {
        mode: result.plan.mode,
        items: result.plan.items,
        warnings: result.plan.warnings,
        counts: result.plan.counts,
        estimatedSeconds: result.plan.estimatedSeconds,
        degraded: result.plan.degraded,
        model: result.model,
        workflowHash: result.workflowHash,
        normalizeLoudness: result.normalizeLoudness,
      })
    } catch (error: any) {
      return handleError(c, error, '预览声音生成失败')
    }
  })

  routes.post('/episodes/:id/audio/soundscape', async (c) => {
    const episodeId = parseId(c.req.param('id'))
    if (!episodeId) return badRequest(c, '集编号无效')
    const episode = findEpisode(episodeId)
    if (!episode) return notFound(c, '集不存在')
    const body = await c.req.json().catch(() => ({}))
    try {
      const request = parseSoundscapeRequest(body)
      const started = await startSoundscape(episodeId, episode.dramaId, request, deps)
      return success(c, started)
    } catch (error: any) {
      return handleError(c, error, '启动声音生成失败')
    }
  })

  routes.get('/episodes/:id/audio/soundscape/status', (c) => {
    const episodeId = parseId(c.req.param('id'))
    if (!episodeId) return badRequest(c, '集编号无效')
    try {
      return success(c, getSoundscapeStatus(episodeId))
    } catch (error: any) {
      return handleError(c, error, '读取声音生成状态失败')
    }
  })

  routes.post('/episodes/:id/audio/soundscape/cancel', (c) => {
    const episodeId = parseId(c.req.param('id'))
    if (!episodeId) return badRequest(c, '集编号无效')
    try {
      if (!cancelSoundscape(episodeId)) {
        return statusError(c, 409, '当前没有运行中的声音生成任务')
      }
      return success(c, { status: 'cancelled' })
    } catch (error: any) {
      return handleError(c, error, '取消声音生成失败')
    }
  })

  return routes
}

app.route('/', createSoundscapeRoutes())
```

`PUT /episodes/:id/mix` 在 `findEpisode` 之后、读取 body 之前增加：

```ts
if (isSoundscapeRunning(episodeId)) {
  return statusError(c, 409, '声音生成中，暂不能保存混音')
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && npx tsx --test tests/soundscape-routes.test.ts`
Expected: PASS。若保存互斥用例在取消后仍 409，确认 `cancelSoundscape` 已 patch job 且 `executeSoundscape` 的 `.finally` 已删除 `active`；测试里的 `waitUntil` 会等待内存释放。

- [ ] **Step 5: 回归混音路由**

Run: `cd backend && npx tsx --test tests/mix-routes.test.ts`
Expected: PASS。原有 `PUT /mix` 用例在没有 soundscape 任务时不受影响。

---

## Task 11: 前端 API 与 useMixStage 状态

**Files:**
- Modify: `frontend/app/composables/useApi.ts:615-797`
- Modify: `frontend/app/composables/useMixStage.ts:9-23, 117-155, 495-558, 927-995`
- Create: `frontend/tests/mix-soundscape-structure.test.mjs`

**Interfaces:**
- Consumes: Task 10 的四个 soundscape 端点；Task 1 已把 `origin` 加入 `MixTrack`。
- Produces:
  - `SoundscapeRequest / SoundscapeItem / SoundscapePreview / SoundscapeStatus / SoundscapeStart` 类型；
  - `mixAPI.previewSoundscape / startSoundscape / soundscapeStatus / cancelSoundscape`；
  - `useMixStage` 返回 `soundscapeStatus / soundscapeRunning / soundscapePlan / soundscapeStarting / previewSoundscape / startSoundscape / cancelSoundscape / pollSoundscape`。

- [ ] **Step 1: 写失败测试**

创建 `frontend/tests/mix-soundscape-structure.test.mjs`：

```js
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const api = read('app/composables/useApi.ts')
const stage = read('app/composables/useMixStage.ts')

test('mix API exposes soundscape types and four endpoints', () => {
  assert.match(api, /export type SoundscapeCategory = 'ambience' \| 'sfx' \| 'crowd' \| 'bgm'/)
  assert.match(api, /export type SoundscapeMode = 'scenes' \| 'episode-bed' \| 'assets-only'/)
  assert.match(api, /export interface SoundscapePreview/)
  assert.match(api, /export interface SoundscapeStatus/)
  assert.match(api, /previewSoundscape: \(episodeId: number, data: SoundscapeRequest\)/)
  assert.match(api, /startSoundscape: \(episodeId: number, data: SoundscapeRequest\)/)
  assert.match(api, /soundscapeStatus: \(episodeId: number\)/)
  assert.match(api, /cancelSoundscape: \(episodeId: number\)/)
  assert.match(api, /\/episodes\/\$\{episodeId\}\/audio\/soundscape\/preview`/)
  assert.match(api, /\/episodes\/\$\{episodeId\}\/audio\/soundscape\/status`/)
  assert.match(api, /\/episodes\/\$\{episodeId\}\/audio\/soundscape\/cancel`/)
})

test('useMixStage owns soundscape polling, cancellation and refresh-before-idle', () => {
  assert.match(stage, /type SoundscapePreview/)
  assert.match(stage, /const soundscapeStatus = ref<SoundscapeStatus \| null>\(null\)/)
  assert.match(stage, /const soundscapePlan = ref<SoundscapePreview \| null>\(null\)/)
  assert.match(stage, /const soundscapeRefreshing = ref\(false\)/)
  assert.match(stage, /const soundscapeRunning = computed/)
  assert.match(stage, /let soundscapePollToken = 0/)
  assert.match(stage, /function stopSoundscapePolling\(\)/)
  assert.match(stage, /async function startSoundscape\(request: SoundscapeRequest\)/)
  assert.match(stage, /async function previewSoundscape\(request: SoundscapeRequest\)/)
  assert.match(stage, /async function cancelSoundscape\(\)/)
  assert.match(stage, /await Promise\.all\(\[loadAssets\(\), refreshPlan\(\)\]\)/)
  assert.match(stage, /soundscapeRunning,/)
  assert.match(stage, /startSoundscape,/)
  assert.match(stage, /cancelSoundscape,/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && node --test tests/mix-soundscape-structure.test.mjs`
Expected: FAIL，找不到 soundscape 类型与状态。

- [ ] **Step 3: 增加前端 API 类型与方法**

在 `frontend/app/composables/useApi.ts` 的 `MixPlan` 之后增加：

```ts
export type SoundscapeCategory = 'ambience' | 'sfx' | 'crowd' | 'bgm'
export type SoundscapeMode = 'scenes' | 'episode-bed' | 'assets-only'
export type SoundscapeCrowdMode = 'walla' | 'lines'

export interface SoundscapeOverride {
  itemId: string
  prompt?: string
  negativePrompt?: string
  seconds?: number
}

export interface SoundscapeRequest {
  mode: SoundscapeMode
  categories: SoundscapeCategory[]
  crowdMode: SoundscapeCrowdMode
  sceneIds?: number[]
  overwrite?: boolean
  overrides?: SoundscapeOverride[]
  configId?: number
}

export interface SoundscapeItem {
  itemId: string
  category: SoundscapeCategory
  source: 'generate' | 'lines'
  sceneId: number | null
  storyboardId: number | null
  startMs: number
  endMs: number
  seconds: number
  loop: boolean
  prompt: string
  negativePrompt: string | null
  degraded: boolean
  cached: boolean
}

export interface SoundscapePreview {
  mode: SoundscapeMode
  items: SoundscapeItem[]
  warnings: string[]
  counts: { total: number; generate: number; lines: number; cached: number }
  estimatedSeconds: number
  degraded: boolean
  model: string
  workflowHash: string
  normalizeLoudness: boolean
}

export interface SoundscapeStatus {
  jobId: number | null
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  step: string | null
  error: string | null
  counts: { total: number; done: number; failed: number; reused: number; clips: number }
  warnings: string[]
  startedAt: string | null
  finishedAt: string | null
}

export interface SoundscapeStart {
  jobId: number
  status: 'running'
}
```

在 `mixAPI` 中 `peaks` 之前增加：

```ts
  previewSoundscape: (episodeId: number, data: SoundscapeRequest) =>
    api.post<SoundscapePreview>(`/episodes/${episodeId}/audio/soundscape/preview`, data),
  startSoundscape: (episodeId: number, data: SoundscapeRequest) =>
    api.post<SoundscapeStart>(`/episodes/${episodeId}/audio/soundscape`, data),
  soundscapeStatus: (episodeId: number) =>
    api.get<SoundscapeStatus>(`/episodes/${episodeId}/audio/soundscape/status`),
  cancelSoundscape: (episodeId: number) =>
    api.post<{ status: 'cancelled' }>(`/episodes/${episodeId}/audio/soundscape/cancel`),
```

- [ ] **Step 4: 在 useMixStage 接入状态与轮询**

`frontend/app/composables/useMixStage.ts` 的 useApi 导入增加：

```ts
  type SoundscapePreview,
  type SoundscapeRequest,
  type SoundscapeStatus,
```

在 `separation` 附近增加：

```ts
  const soundscapeStatus = ref<SoundscapeStatus | null>(null)
  const soundscapePlan = ref<SoundscapePreview | null>(null)
  const soundscapeStarting = ref(false)
  const soundscapeRefreshing = ref(false)
```

在轮询变量附近增加：

```ts
  let soundscapeTimer: ReturnType<typeof setTimeout> | null = null
  let soundscapePollToken = 0
```

在 `separationRunning` 之后增加：

```ts
  const soundscapeRunning = computed(() =>
    soundscapeStatus.value?.status === 'running' || soundscapeRefreshing.value
  )
```

`load()` 的 `Promise.all` 增加第五项并写入状态：

```ts
      const [next, assetResult, revisionResult, status, soundscape] = await Promise.all([
        mixAPI.getPlan(episodeId),
        mixAPI.assets(episodeId),
        mixAPI.revisions(episodeId),
        mixAPI.separationStatus(episodeId),
        mixAPI.soundscapeStatus(episodeId),
      ])
      if (token !== loadToken) return
      applyPlan(next, resetHistory)
      assets.value = assetResult.items
      revisions.value = revisionResult.items
      separation.value = status
      soundscapeStatus.value = soundscape
      dirty.value = false
      playheadMs.value = 0
      if (status.status === 'running') startPolling()
      if (soundscape.status === 'running') pollSoundscape()
```

在 `cancelSeparation` 之后增加 soundscape 状态与动作：

```ts
  function stopSoundscapePolling() {
    soundscapePollToken += 1
    if (soundscapeTimer) {
      clearTimeout(soundscapeTimer)
      soundscapeTimer = null
    }
  }

  function pollSoundscape() {
    stopSoundscapePolling()
    const token = soundscapePollToken
    const tick = async () => {
      const episodeId = options.episodeId()
      if (!episodeId || token !== soundscapePollToken) return
      try {
        const status = await mixAPI.soundscapeStatus(episodeId)
        if (token !== soundscapePollToken) return
        soundscapeStatus.value = status
        if (status.status === 'running') {
          soundscapeTimer = setTimeout(tick, POLL_INTERVAL_MS)
          return
        }
        soundscapeTimer = null
        if (status.status === 'completed') {
          // 刷新完成前保持 running，避免用户在旧计划上保存
          soundscapeRefreshing.value = true
          try {
            await Promise.all([loadAssets(), refreshPlan()])
          } finally {
            if (token === soundscapePollToken) soundscapeRefreshing.value = false
          }
        }
      } catch (err: any) {
        if (token !== soundscapePollToken) return
        error.value = err?.message || '读取声音生成状态失败'
        soundscapeTimer = null
      }
    }
    void tick()
  }

  async function previewSoundscape(request: SoundscapeRequest): Promise<SoundscapePreview> {
    const episodeId = options.episodeId()
    if (!episodeId) throw new Error('未选择剧集')
    error.value = ''
    try {
      const result = await mixAPI.previewSoundscape(episodeId, request)
      soundscapePlan.value = result
      return result
    } catch (err: any) {
      error.value = err?.message || '预览声音生成失败'
      throw err
    }
  }

  async function startSoundscape(request: SoundscapeRequest) {
    const episodeId = options.episodeId()
    if (!episodeId) throw new Error('未选择剧集')
    soundscapeStarting.value = true
    error.value = ''
    try {
      const started = await mixAPI.startSoundscape(episodeId, request)
      soundscapeStatus.value = {
        jobId: started.jobId,
        status: 'running',
        progress: 0,
        step: '准备生成',
        error: null,
        counts: { total: 0, done: 0, failed: 0, reused: 0, clips: 0 },
        warnings: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
      }
      pollSoundscape()
      return started
    } catch (err: any) {
      error.value = err?.message || '启动声音生成失败'
      throw err
    } finally {
      soundscapeStarting.value = false
    }
  }

  async function cancelSoundscape() {
    const episodeId = options.episodeId()
    if (!episodeId) return false
    const result = await mixAPI.cancelSoundscape(episodeId)
    stopSoundscapePolling()
    soundscapeRefreshing.value = false
    soundscapeStatus.value = await mixAPI.soundscapeStatus(episodeId)
    return result.status === 'cancelled'
  }
```

`dispose()` 增加：

```ts
    stopSoundscapePolling()
```

返回对象增加：

```ts
    soundscapeStatus,
    soundscapeRunning,
    soundscapePlan,
    soundscapeStarting,
    previewSoundscape,
    startSoundscape,
    cancelSoundscape,
    pollSoundscape,
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd frontend && node --test tests/mix-soundscape-structure.test.mjs`
Expected: PASS。

- [ ] **Step 6: 回归现有前端结构测试**

Run: `cd frontend && node --test tests/*.test.mjs`
Expected: PASS（不执行 Nuxt 构建；构建门禁在 Task 15 单独请求批准）。

---

## Task 12: 生成参数与预览弹窗

**Files:**
- Create: `frontend/app/components/MixSoundscapeDialog.vue`
- Modify: `frontend/tests/mix-soundscape-structure.test.mjs`

**Interfaces:**
- Consumes: Task 11 的 `SoundscapeRequest / SoundscapePreview` 类型；`episodeAPI.scenes(episodeId)`（返回 snake_case 场景：`id / location / time`）。
- Produces: `MixSoundscapeDialog` 组件，props `open / episodeId / preview / previewing / starting / error`，事件 `close / preview(request) / start(request)`；组件自己维护模式、类别、群众方式、场景范围、覆盖开关与提示词覆盖。

- [ ] **Step 1: 追加失败测试**

在 `frontend/tests/mix-soundscape-structure.test.mjs` 末尾追加：

```js
test('soundscape dialog loads scenes and emits preview/start requests', () => {
  const dialog = read('app/components/MixSoundscapeDialog.vue')
  assert.match(dialog, /preview: SoundscapePreview \| null/)
  assert.match(dialog, /episodeAPI\.scenes\(props\.episodeId\)/)
  assert.match(dialog, /v-for="mode in MODES"/)
  assert.match(dialog, /v-for="category in CATEGORIES"/)
  assert.match(dialog, /form\.crowdMode/)
  assert.match(dialog, /form\.sceneIds/)
  assert.match(dialog, /allScenes/)
  assert.match(dialog, /promptDraft/)
  assert.match(dialog, /emit\('preview', buildRequest\(\)\)/)
  assert.match(dialog, /emit\('start', buildRequest\(\)\)/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && node --test tests/mix-soundscape-structure.test.mjs`
Expected: FAIL，`MixSoundscapeDialog.vue` 不存在（ENOENT）。

- [ ] **Step 3: 创建弹窗组件**

创建 `frontend/app/components/MixSoundscapeDialog.vue`：

```vue
<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <div class="dialog ss-dialog" role="dialog" aria-modal="true" :aria-label="t('mix.soundscape.title')">
        <div class="dialog-head">
          <div class="ss-head-text">
            <h2 class="dialog-title">{{ t('mix.soundscape.title') }}</h2>
            <p class="ss-sub">{{ t('mix.soundscape.subtitle') }}</p>
          </div>
          <button class="ss-close" type="button" :aria-label="t('common.close')" @click="emit('close')">
            <X :size="15" />
          </button>
        </div>

        <div class="dialog-body ss-body">
          <section class="ss-section">
            <span class="ss-label">{{ t('mix.soundscape.modeLabel') }}</span>
            <div class="ss-seg">
              <button
                v-for="mode in MODES"
                :key="mode.value"
                type="button"
                :class="{ on: form.mode === mode.value }"
                @click="form.mode = mode.value"
              >
                {{ t(`mix.soundscape.mode.${mode.key}`) }}
              </button>
            </div>
            <p class="ss-hint">{{ t(`mix.soundscape.modeHint.${modeKey(form.mode)}`) }}</p>
          </section>

          <section class="ss-section">
            <span class="ss-label">{{ t('mix.soundscape.categoriesLabel') }}</span>
            <div class="ss-checks">
              <label
                v-for="category in CATEGORIES"
                :key="category"
                class="ss-check"
                :class="{ on: form.categories.includes(category) }"
              >
                <input
                  type="checkbox"
                  :checked="form.categories.includes(category)"
                  @change="toggleCategory(category)"
                />
                <span class="ss-dot" :style="{ background: CATEGORY_COLORS[category] }" />
                {{ t(`mix.soundscape.categories.${category}`) }}
              </label>
            </div>
            <p v-if="!form.categories.length" class="ss-hint is-warn">
              {{ t('mix.soundscape.categoryRequired') }}
            </p>
          </section>

          <section v-if="form.categories.includes('crowd')" class="ss-section">
            <span class="ss-label">{{ t('mix.soundscape.crowdModeLabel') }}</span>
            <div class="ss-seg">
              <button
                type="button"
                :class="{ on: form.crowdMode === 'walla' }"
                @click="form.crowdMode = 'walla'"
              >
                {{ t('mix.soundscape.crowdMode.walla') }}
              </button>
              <button
                type="button"
                :class="{ on: form.crowdMode === 'lines' }"
                @click="form.crowdMode = 'lines'"
              >
                {{ t('mix.soundscape.crowdMode.lines') }}
              </button>
            </div>
            <p class="ss-hint">{{ t(`mix.soundscape.crowdModeHint.${form.crowdMode}`) }}</p>
          </section>

          <section v-if="form.mode === 'scenes'" class="ss-section">
            <div class="ss-row">
              <span class="ss-label">{{ t('mix.soundscape.sceneScope') }}</span>
              <label class="ss-switch">
                <input v-model="allScenes" type="checkbox" />
                <span>{{ t('mix.soundscape.allScenes') }}</span>
              </label>
            </div>
            <div v-if="!allScenes" class="ss-scenes">
              <label
                v-for="(scene, index) in scenes"
                :key="scene.id"
                class="ss-scene"
                :class="{ on: form.sceneIds.includes(scene.id) }"
              >
                <input v-model="form.sceneIds" type="checkbox" :value="scene.id" />
                <b>{{ t('mix.soundscape.sceneLabel', { n: index + 1 }) }}</b>
                <span>{{ scene.location || '-' }} · {{ scene.time || '-' }}</span>
              </label>
              <p v-if="sceneLoading" class="ss-hint">{{ t('common.loading') }}</p>
              <p v-else-if="!scenes.length" class="ss-hint is-warn">{{ t('mix.soundscape.noScenes') }}</p>
            </div>
            <p v-if="!allScenes && !form.sceneIds.length" class="ss-hint is-warn">
              {{ t('mix.soundscape.sceneRequired') }}
            </p>
          </section>

          <section class="ss-section ss-row">
            <div>
              <span class="ss-label">{{ t('mix.soundscape.overwrite') }}</span>
              <p class="ss-hint">{{ t('mix.soundscape.overwriteHint') }}</p>
            </div>
            <label class="ss-switch">
              <input v-model="form.overwrite" type="checkbox" />
            </label>
          </section>

          <section v-if="preview" class="ss-preview">
            <div class="ss-preview-head">
              <b>{{ t('mix.soundscape.previewTitle') }}</b>
              <span>
                {{ t('mix.soundscape.previewCount', { n: preview.counts.total }) }}
                · {{ t('mix.soundscape.estimated', { s: preview.estimatedSeconds }) }}
              </span>
            </div>
            <p v-if="preview.degraded" class="ss-warn">{{ t('mix.soundscape.degraded') }}</p>
            <ul v-if="preview.warnings.length" class="ss-warn-list">
              <li v-for="(warning, index) in preview.warnings" :key="index">{{ warning }}</li>
            </ul>
            <details class="ss-prompts">
              <summary>{{ t('mix.soundscape.prompts', { n: preview.items.length }) }}</summary>
              <div v-for="item in preview.items" :key="item.itemId" class="ss-prompt">
                <div class="ss-prompt-head">
                  <b>{{ t(`mix.soundscape.categories.${item.category}`) }} · {{ itemLabel(item) }}</b>
                  <span>{{ item.seconds }}s</span>
                </div>
                <textarea
                  v-if="item.source === 'generate'"
                  v-model="promptDraft[item.itemId]"
                  rows="2"
                  spellcheck="false"
                />
                <p v-else class="ss-hint">{{ t('mix.soundscape.reuseLine') }}</p>
                <p v-if="item.degraded" class="ss-hint is-warn">{{ t('mix.soundscape.itemDegraded') }}</p>
              </div>
            </details>
          </section>

          <p v-if="error" class="ss-error">{{ error }}</p>
        </div>

        <div class="dialog-foot">
          <button class="btn" type="button" @click="emit('close')">{{ t('common.cancel') }}</button>
          <button class="btn" type="button" :disabled="!canSubmit || previewing || starting" @click="onPreview">
            <Loader2 v-if="previewing" :size="13" class="animate-spin" />
            {{ t('mix.soundscape.preview') }}
          </button>
          <button class="btn btn-primary" type="button" :disabled="!canSubmit || starting" @click="onStart">
            <Loader2 v-if="starting" :size="13" class="animate-spin" />
            {{ t('mix.soundscape.start') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { Loader2, X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import {
  episodeAPI,
  type SoundscapeCategory,
  type SoundscapeCrowdMode,
  type SoundscapeMode,
  type SoundscapeOverride,
  type SoundscapePreview,
  type SoundscapeRequest,
} from '~/composables/useApi'

interface SceneRow {
  id: number
  location?: string | null
  time?: string | null
}

const props = defineProps<{
  open: boolean
  episodeId: number | null
  preview: SoundscapePreview | null
  previewing: boolean
  starting: boolean
  error: string
}>()
const emit = defineEmits<{
  close: []
  preview: [request: SoundscapeRequest]
  start: [request: SoundscapeRequest]
}>()
const { t } = useI18n()

const MODES: Array<{ value: SoundscapeMode; key: string }> = [
  { value: 'scenes', key: 'scenes' },
  { value: 'episode-bed', key: 'episodeBed' },
  { value: 'assets-only', key: 'assetsOnly' },
]
const CATEGORIES: SoundscapeCategory[] = ['ambience', 'sfx', 'crowd', 'bgm']
const CATEGORY_COLORS: Record<SoundscapeCategory, string> = {
  ambience: '#0ea5e9',
  sfx: '#a78bfa',
  crowd: '#f59e0b',
  bgm: '#22c55e',
}

const form = reactive({
  mode: 'scenes' as SoundscapeMode,
  categories: ['ambience', 'sfx', 'crowd'] as SoundscapeCategory[],
  crowdMode: 'walla' as SoundscapeCrowdMode,
  sceneIds: [] as number[],
  overwrite: false,
})
const allScenes = ref(true)
const scenes = ref<SceneRow[]>([])
const sceneLoading = ref(false)
const promptDraft = reactive<Record<string, string>>({})

const canSubmit = computed(() => (
  form.categories.length > 0
  && (form.mode !== 'scenes' || allScenes.value || form.sceneIds.length > 0)
))

const sceneOrdinal = computed(() => {
  const map = new Map<number, number>()
  scenes.value.forEach((scene, index) => map.set(scene.id, index + 1))
  return map
})

function modeKey(mode: SoundscapeMode): string {
  return MODES.find((item) => item.value === mode)?.key ?? 'scenes'
}

function toggleCategory(category: SoundscapeCategory) {
  const index = form.categories.indexOf(category)
  if (index >= 0) form.categories.splice(index, 1)
  else form.categories.push(category)
}

function resetDrafts() {
  for (const key of Object.keys(promptDraft)) delete promptDraft[key]
}

function resetForm() {
  form.mode = 'scenes'
  form.categories = ['ambience', 'sfx', 'crowd']
  form.crowdMode = 'walla'
  form.sceneIds = []
  form.overwrite = false
  allScenes.value = true
  resetDrafts()
  void loadScenes()
}

async function loadScenes() {
  const episodeId = props.episodeId
  if (!episodeId) {
    scenes.value = []
    return
  }
  sceneLoading.value = true
  try {
    const rows = await episodeAPI.scenes(episodeId)
    scenes.value = (Array.isArray(rows) ? rows : [])
      .slice()
      .sort((a: SceneRow, b: SceneRow) => a.id - b.id)
  } catch {
    scenes.value = []
  } finally {
    sceneLoading.value = false
  }
}

function itemLabel(item: SoundscapePreview['items'][number]): string {
  if (item.sceneId == null) return t('mix.soundscape.wholeEpisode')
  const n = sceneOrdinal.value.get(item.sceneId) ?? item.sceneId
  return t('mix.soundscape.sceneLabel', { n })
}

function buildRequest(): SoundscapeRequest {
  const overrides: SoundscapeOverride[] = []
  for (const item of props.preview?.items ?? []) {
    if (item.source !== 'generate') continue
    const prompt = (promptDraft[item.itemId] ?? '').trim()
    if (prompt) overrides.push({ itemId: item.itemId, prompt })
  }
  return {
    mode: form.mode,
    categories: [...form.categories],
    crowdMode: form.crowdMode,
    sceneIds: form.mode === 'scenes' && !allScenes.value ? [...form.sceneIds] : [],
    overwrite: form.overwrite,
    overrides,
  }
}

function onPreview() {
  if (!canSubmit.value) return
  emit('preview', buildRequest())
}

function onStart() {
  if (!canSubmit.value) return
  emit('start', buildRequest())
}

watch(() => props.open, (open) => {
  if (open) resetForm()
})

watch(() => props.episodeId, () => {
  if (props.open) void loadScenes()
})

watch(() => props.preview, (value) => {
  if (!value) {
    resetDrafts()
    return
  }
  const present = new Set(value.items.map((item) => item.itemId))
  for (const key of Object.keys(promptDraft)) {
    if (!present.has(key)) delete promptDraft[key]
  }
  for (const item of value.items) {
    if (!(item.itemId in promptDraft)) promptDraft[item.itemId] = item.prompt
  }
}, { immediate: true })
</script>

<style scoped>
.ss-dialog { width: 640px; max-width: calc(100vw - 48px); }
.ss-head-text { min-width: 0; }
.ss-sub { margin: 2px 0 0; font-size: 11px; color: var(--text-3); }
.ss-close {
  margin-left: auto; display: flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border: none; border-radius: 7px;
  background: transparent; color: var(--text-2); cursor: pointer;
}
.ss-close:hover { background: var(--bg-3); color: var(--text-0); }
.ss-body { display: flex; flex-direction: column; gap: 18px; max-height: 62vh; }
.ss-section { display: flex; flex-direction: column; gap: 8px; }
.ss-row { flex-direction: row; align-items: center; justify-content: space-between; }
.ss-label { font-size: 11.5px; font-weight: 700; color: var(--text-1); }
.ss-hint { margin: 0; font-size: 10.5px; line-height: 1.5; color: var(--text-3); }
.ss-hint.is-warn { color: var(--warning); }
.ss-error { margin: 0; font-size: 11px; color: var(--action-danger); }
.ss-seg {
  display: inline-flex; padding: 2px; gap: 2px; border-radius: 8px;
  background: var(--bg-3); width: fit-content;
}
.ss-seg button {
  padding: 5px 12px; border: none; border-radius: 6px; cursor: pointer;
  background: transparent; color: var(--text-2); font-size: 11px;
}
.ss-seg button.on { background: var(--surface-raised); color: var(--text-0); box-shadow: var(--shadow-1); }
.ss-checks { display: flex; flex-wrap: wrap; gap: 6px; }
.ss-check {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px;
  border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
  font-size: 11px; color: var(--text-2); background: var(--bg-2);
}
.ss-check.on { border-color: var(--accent); color: var(--text-0); background: var(--accent-bg); }
.ss-check input { display: none; }
.ss-dot { width: 7px; height: 7px; border-radius: 50%; }
.ss-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-2); cursor: pointer; }
.ss-switch input { accent-color: var(--accent); }
.ss-scenes {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 6px; max-height: 180px; overflow-y: auto; padding: 2px;
}
.ss-scene {
  display: flex; flex-direction: column; gap: 2px; padding: 7px 9px;
  border: 1px solid var(--border); border-radius: 8px; cursor: pointer;
  background: var(--bg-2); font-size: 10.5px; color: var(--text-2);
}
.ss-scene.on { border-color: var(--accent); background: var(--accent-bg); color: var(--text-0); }
.ss-scene input { display: none; }
.ss-scene b { font-size: 11px; }
.ss-scene span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ss-preview {
  display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg-2);
}
.ss-preview-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 11px; }
.ss-preview-head span { color: var(--text-3); }
.ss-warn { margin: 0; font-size: 10.5px; color: var(--warning); }
.ss-warn-list { margin: 0; padding-left: 16px; font-size: 10.5px; color: var(--warning); }
.ss-prompts summary { cursor: pointer; font-size: 10.5px; color: var(--text-2); }
.ss-prompt { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-bottom: 1px dashed var(--border); }
.ss-prompt:last-child { border-bottom: none; }
.ss-prompt-head { display: flex; align-items: baseline; justify-content: space-between; font-size: 10.5px; }
.ss-prompt-head span { color: var(--text-3); }
.ss-prompt textarea {
  width: 100%; resize: vertical; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-1); color: var(--text-1);
  font-size: 10.5px; line-height: 1.5; font-family: inherit;
}
</style>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd frontend && node --test tests/mix-soundscape-structure.test.mjs`
Expected: PASS。

- [ ] **Step 5: 静态复查**

确认：
- 弹窗只在 `open` 时 Teleport 渲染；
- `episodeAPI.scenes` 返回 snake_case，组件只使用 `id / location / time`；
- `buildRequest()` 始终携带当前完整提示词覆盖，保证预览与启动请求参数一致；
- 组件不直接调用 `mixAPI`，所有请求由父组件 `MixStage` 转发到 `useMixStage`。

---

---

## Task 13: 混音工作台入口与生成锁

**Files:**
- Modify: `frontend/app/components/MixStage.vue:4-27, 89-92, 155, 190-200, 245, 260, 330-335, 344-380, 395-455, 514-523, 680-692, 1164-1210, 1392`
- Modify: `frontend/app/components/MixTrackHead.vue:9-22, 233-240`
- Modify: `frontend/app/components/DubbingStage.vue:347-410, 656-695, 897`
- Modify: `frontend/tests/mix-soundscape-structure.test.mjs`

**Interfaces:**
- Consumes: Task 11 的 `soundscapeRunning / soundscapePlan / soundscapeStarting / previewSoundscape / startSoundscape / cancelSoundscape`；Task 12 的 `MixSoundscapeDialog`；Task 1 的 `MixTrack.origin`。
- Produces:
  - MixStage「生成声音」入口：`props.durationMs > 0` 才可用，否则提示先合片；
  - 生成中显示进度条，可取消；`.mx-body` 只读，保存/预览/撤销/加轨等写操作禁用；
  - `MixSoundscapeDialog` 挂载与 `preview / start / close` 事件处理；
  - MixStage 向父组件发出 `soundscape-busy`，DubbingStage 在生成期间禁止离开第 4 步；
  - `MixTrackHead` 对 `origin === 'soundscape'` 的轨道显示 AI 徽标。

- [ ] **Step 1: 追加失败测试**

在 `frontend/tests/mix-soundscape-structure.test.mjs` 末尾追加：

```js
test('MixStage exposes the soundscape entry, progress, dialog and generation lock', () => {
  const mixStage = read('app/components/MixStage.vue')
  assert.match(mixStage, /<Sparkles :size="12" \/>/)
  assert.match(mixStage, /const canGenerateSound = computed\(\(\) => Boolean\(props\.episodeId && props\.durationMs > 0\)\)/)
  assert.match(mixStage, /:class="\['mx-stage', \{ 'is-generating': soundscapeRunning \}\]"/)
  assert.match(mixStage, /v-if="soundscapeRunning" class="mx-progress"/)
  assert.match(mixStage, /soundscapeStatus\?\.step \|\| t\('mix\.soundscape\.preparing'\)/)
  assert.match(mixStage, /@click="onCancelSoundscape"/)
  assert.match(mixStage, /:can-edit="Boolean\(episodeId\) && !soundscapeRunning"/)
  assert.match(mixStage, /<MixSoundscapeDialog/)
  assert.match(mixStage, /@preview="onSoundscapePreview"/)
  assert.match(mixStage, /@start="onSoundscapeStart"/)
  assert.match(mixStage, /emit\('soundscape-busy', busy\)/)
})

test('AI generated tracks are marked and export waits for generation', () => {
  const trackHead = read('app/components/MixTrackHead.vue')
  const dubbing = read('app/components/DubbingStage.vue')
  assert.match(trackHead, /track\.origin === 'soundscape'/)
  assert.match(trackHead, /mix\.soundscape\.aiBadge/)
  assert.match(dubbing, /@soundscape-busy="mixSoundscapeBusy = \$event"/)
  assert.match(dubbing, /const mixSoundscapeBusy = ref\(false\)/)
  assert.match(dubbing, /if \(mixSoundscapeBusy\.value\)/)
  assert.match(dubbing, /:disabled="mixSoundscapeBusy"/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && node --test tests/mix-soundscape-structure.test.mjs`
Expected: FAIL，MixStage 尚无 `Sparkles`、`canGenerateSound` 与 `MixSoundscapeDialog`。

- [ ] **Step 3: 接入 MixStage 模板**

`frontend/app/components/MixStage.vue`：

3.1 根节点增加生成中状态类：

```html
  <section
    ref="rootRef"
    :class="['mx-stage', { 'is-generating': soundscapeRunning }]"
    tabindex="0"
```

3.2 左上状态区，在分离状态之后增加生成状态：

```html
        <span v-if="separationRunning" class="mx-chip is-accent">{{ t('mix.separating') }}</span>
        <span v-else-if="separation?.engine === 'basic'" class="mx-chip is-warning">{{ t('mix.engineBasic') }}</span>
        <span v-if="soundscapeRunning" class="mx-chip is-accent">{{ t('mix.soundscape.running') }}</span>
```

3.3 分离按钮增加互斥，随后新增生成入口与取消按钮：

```html
        <button class="mx-btn" :class="{ 'is-primary': !hasAssets }" type="button" :disabled="!episodeId || separationRunning || soundscapeRunning || loading" @click="requestSeparate(false)">
          <AudioWaveform :size="12" />
          {{ hasAssets ? t('mix.reseparate') : t('mix.separate') }}
        </button>
        <button v-if="separationRunning" class="mx-btn is-plain" type="button" @click="onCancelSeparation">{{ t('mix.separationCancel') }}</button>
        <button
          class="mx-btn"
          :class="{ 'is-primary': hasAssets && !soundscapeRunning }"
          type="button"
          :disabled="!canGenerateSound || separationRunning || soundscapeRunning || loading"
          :title="canGenerateSound ? t('mix.soundscape.entryHint') : t('mix.soundscape.needMerge')"
          @click="openSoundscape"
        >
          <Sparkles :size="12" />
          {{ t('mix.soundscape.entry') }}
        </button>
        <button v-if="soundscapeRunning" class="mx-btn is-plain" type="button" @click="onCancelSoundscape">{{ t('mix.soundscape.cancel') }}</button>
        <span class="mx-divider" />
```

3.4 分离进度条之后增加生成进度条：

```html
    <div v-if="separationRunning" class="mx-progress">
      <div class="mx-progress-bar"><span :style="{ width: `${separation?.progress || 0}%` }" /></div>
      <span class="mx-progress-text">{{ separation?.step || t('mix.separationPreparing') }} · {{ separation?.progress || 0 }}%</span>
    </div>
    <div v-if="soundscapeRunning" class="mx-progress">
      <div class="mx-progress-bar"><span :style="{ width: `${soundscapeStatus?.progress || 0}%` }" /></div>
      <span class="mx-progress-text">{{ soundscapeStatus?.step || t('mix.soundscape.preparing') }} · {{ soundscapeStatus?.progress || 0 }}%</span>
    </div>
```

3.5 撤销/重做在生成中禁用：

```html
        <button class="mx-icon" type="button" :title="t('mix.undo')" :disabled="!canUndo || soundscapeRunning" @click="undo"><Undo2 :size="13" /></button>
        <button class="mx-icon" type="button" :title="t('mix.redo')" :disabled="!canRedo || soundscapeRunning" @click="redo"><Redo2 :size="13" /></button>
```

3.6 添加轨道菜单打开按钮在生成中禁用：

```html
            <button class="mx-btn" type="button" :title="t('mix.addTrack')" :disabled="loading || soundscapeRunning">
```

3.7 保存版本与刷新在生成中禁用：

```html
        <button class="mx-btn is-plain" type="button" :disabled="!episodeId || saving || soundscapeRunning" @click="onSaveRevision">
          <Save :size="12" />
          {{ t('mix.saveRevision') }}
        </button>
        <button class="mx-icon" type="button" :title="t('mix.refresh')" :disabled="loading || soundscapeRunning" @click="requestReload">
          <RefreshCw :size="13" :class="{ 'animate-spin': loading }" />
        </button>
```

3.8 空状态增加生成入口，并让分离按钮与生成互斥：

```html
            <button class="mx-btn is-primary" type="button" :disabled="separationRunning || soundscapeRunning" @click="requestSeparate(false)">
              <AudioWaveform :size="12" />
              {{ t('mix.separate') }}
            </button>
            <button
              class="mx-btn is-plain"
              type="button"
              :disabled="!canGenerateSound || separationRunning || soundscapeRunning || loading"
              :title="canGenerateSound ? t('mix.soundscape.entryHint') : t('mix.soundscape.needMerge')"
              @click="openSoundscape"
            >
              <Sparkles :size="12" />
              {{ t('mix.soundscape.entry') }}
            </button>
```

3.9 检查器在生成中只读：

```html
        :can-edit="Boolean(episodeId) && !soundscapeRunning"
```

3.10 试听按钮在生成中禁用（生成期间后端保存返回 409，禁止 flushSave）：

```html
        <button class="mx-btn" type="button" :disabled="previewing || !episodeId || !hasAnyAudio || soundscapeRunning" @click="generatePreview()">
```

3.11 在 `ConfirmDialog` 之后挂载参数弹窗：

```html
    <ConfirmDialog
      :open="confirmState.open"
      :title="confirmState.title"
      :message="confirmState.message"
      :confirm-text="confirmState.confirmText"
      :loading="confirmState.loading"
      @cancel="closeConfirm"
      @confirm="runConfirm"
    />

    <MixSoundscapeDialog
      :open="soundscapeOpen"
      :episode-id="episodeId"
      :preview="soundscapePlan"
      :previewing="soundscapePreviewing"
      :starting="soundscapeStarting"
      :error="soundscapeError"
      @close="soundscapeOpen = false"
      @preview="onSoundscapePreview"
      @start="onSoundscapeStart"
    />
```

- [ ] **Step 4: 接入 MixStage 脚本**

4.1 图标与组件导入：

```ts
  Save,
  SlidersHorizontal,
  Sparkles,
```

```ts
import MixSoundscapeDialog from '~/components/MixSoundscapeDialog.vue'
```

4.2 类型导入增加 `SoundscapeRequest`：

```ts
import type {
  EpisodeAudioAsset,
  MixBus,
  MixBusKey,
  MixClip,
  MixRevision,
  MixTrack,
  SoundscapeRequest,
  TimelineCue,
} from '~/composables/useApi'
```

4.3 事件声明增加生成中通知：

```ts
const emit = defineEmits<{
  'locate-line': [lineId: number]
  'regenerate-line': [lineId: number]
  'timeline-retimed': [lineId: number]
  'soundscape-busy': [busy: boolean]
}>()
```

4.4 从 `stage` 解构 soundscape 状态与动作：

```ts
  separation,
  separationRunning,
  soundscapeStatus,
  soundscapeRunning,
  soundscapePlan,
  soundscapeStarting,
```

```ts
  runSeparation,
  cancelSeparation,
  previewSoundscape,
  startSoundscape,
  cancelSoundscape,
```

4.5 局部状态与就绪判断：

```ts
const inspectorOpen = ref(readInspectorPreference())
const soundscapeOpen = ref(false)
const soundscapePreviewing = ref(false)
const soundscapeError = ref('')
```

```ts
const hasAssets = computed(() => assets.value.length > 0)
const canGenerateSound = computed(() => Boolean(props.episodeId && props.durationMs > 0))
```

4.6 生成中通知父级，并在完成/失败时提示：

```ts
watch(soundscapeRunning, (busy) => emit('soundscape-busy', busy), { immediate: true })
watch(() => soundscapeStatus.value?.status, (status, previous) => {
  if (previous !== 'running') return
  if (status === 'completed') toast.success(t('mix.soundscape.done'))
  if (status === 'failed') toast.error(soundscapeStatus.value?.error || t('mix.soundscape.failed'))
})
```

4.7 在 `onCancelSeparation` 之后增加入口与请求处理：

```ts
function openSoundscape() {
  if (!canGenerateSound.value) {
    toast.error(t('mix.soundscape.needMerge'))
    return
  }
  soundscapeError.value = ''
  soundscapeOpen.value = true
}

async function onSoundscapePreview(request: SoundscapeRequest) {
  soundscapePreviewing.value = true
  soundscapeError.value = ''
  try {
    await previewSoundscape(request)
  } catch (err: any) {
    soundscapeError.value = err?.message || t('mix.soundscape.previewFailed')
  } finally {
    soundscapePreviewing.value = false
  }
}

async function onSoundscapeStart(request: SoundscapeRequest) {
  soundscapeError.value = ''
  try {
    await startSoundscape(request)
    soundscapeOpen.value = false
    toast.success(t('mix.soundscape.started'))
  } catch (err: any) {
    soundscapeError.value = err?.message || t('mix.soundscape.startFailed')
  }
}

async function onCancelSoundscape() {
  try {
    await cancelSoundscape()
    toast.success(t('mix.soundscape.cancelDone'))
  } catch (err: any) {
    toast.error(err?.message || t('mix.soundscape.cancelFailed'))
  }
}
```

4.8 生成中锁定检查器与时间线交互：

```css
.mx-stage.is-generating .mx-body { pointer-events: none; opacity: .72; }
```

说明：`pointer-events: none` 覆盖轨道头、Canvas 时间线、检查器与监视器点击，避免生成期间产生本地编辑后触发保存 409；底部播放/暂停仍可用。

- [ ] **Step 5: 轨道头 AI 徽标**

`frontend/app/components/MixTrackHead.vue` 在名称输入框之后增加：

```html
      <span v-if="track.origin === 'soundscape'" class="mx-th-auto is-ai" :title="t('mix.soundscape.aiTrack')">{{ t('mix.soundscape.aiBadge') }}</span>
```

样式追加：

```css
.mx-th-auto.is-ai { padding: 0 4px; border-radius: 999px; background: var(--accent-bg); color: var(--accent-text); font-weight: 600; }
```

- [ ] **Step 6: DubbingStage 阻止生成期间离开第 4 步**

6.1 MixStage 使用处增加事件监听：

```html
            <MixStage
              ref="mixStageRef"
              :episode-id="episodeId"
              :drama-id="dramaId"
              :duration-ms="timelineTotalMs"
              :line-texts="mixLineTexts"
              :line-numbers="mixLineNumbers"
              :video-url="videoUrl"
              :cues="timelineCues"
              @soundscape-busy="mixSoundscapeBusy = $event"
              @locate-line="locateMixLine"
              @regenerate-line="regenerateMixLine"
              @timeline-retimed="loadTimeline"
            >
```

6.2 下一步按钮与提示：

```html
            <div class="dub-next-bar">
              <span class="dub-next-copy">{{ mixSoundscapeBusy ? t('workbench.soundscapeBusy') : t('workbench.previewDoneHint') }}</span>
              <button class="btn btn-sm is-primary" type="button" :disabled="mixSoundscapeBusy" @click="nextStep">
                {{ t('workbench.nextStep', { step: stepDefs[4].label }) }}
                <ArrowRight :size="11" />
              </button>
            </div>
```

6.3 状态与导航守卫：

```ts
const mixStageRef = ref<{ seekTo: (ms: number) => void } | null>(null)
const mixSoundscapeBusy = ref(false)
```

```ts
function goStep(index: number | string) {
  if (typeof index === 'string') {
    const mapped = stageIndex[index]
    if (mapped === undefined) {
      emit('go-stage', index)
      return
    }
    index = mapped
  }
  if (index < 0 || index >= stepDefs.value.length) return
  if (mixSoundscapeBusy.value && index !== currentStep.value) {
    toast.error(t('workbench.soundscapeBusy'))
    return
  }
  emit('update:step', index)
  if (index === 3) void loadTimeline()
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd frontend && node --test tests/mix-soundscape-structure.test.mjs`
Expected: PASS，两个新用例通过。

- [ ] **Step 8: 回归前端结构测试**

Run: `cd frontend && node --test tests/*.test.mjs`
Expected: PASS（不执行 Nuxt 构建；构建门禁在 Task 15 单独请求批准）。

- [ ] **Step 9: 静态复查**

确认：
- 生成入口在 `props.durationMs > 0` 时可用，否则显示「请先完成合片」提示；
- 生成期间保存版本、刷新、撤销/重做、加轨、试听均禁用，`.mx-body` 不可点击；
- 取消按钮调用 `cancelSoundscape()`，轮询令牌在 `useMixStage` 内停止；
- `soundscape-busy` 在组件挂载时立即同步一次，父级第 4 步的「下一步」同步禁用；
- AI 徽标只读取服务端返回的 `origin`，前端不改写。

---

---

## Task 14: 设置页音频生成配置与四语言文案

**Files:**
- Modify: `frontend/app/pages/settings.vue:1261-1300, 1785-1810, 1824-1860, 1900-1930, 1950-1985`
- Modify: `frontend/app/locales/zh.json`
- Modify: `frontend/app/locales/en.json`
- Modify: `frontend/app/locales/ja.json`
- Modify: `frontend/app/locales/ko.json`
- Modify: `frontend/tests/mix-soundscape-structure.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `audio-gen` 服务类型与后端 `validateProviderSettings`；Task 12/13 的文案键。
- Produces:
  - 设置页新增「声音生成」服务组，provider 仅 `comfyui`，预设模型 `stable-audio-open-1.0`；
  - 配置表单支持 `workflow / output_node / output_key / negative_prompt / seed / timeout_ms / normalize_loudness / model_license`；
  - 四语言新增 `mix.soundscape.*`、`common.serviceType.audioGen`、`settings.ai.meta.audioGen`、`settings.cfg.audio* / modelLicense*`、`workbench.soundscapeBusy`。

- [ ] **Step 1: 追加失败测试**

在 `frontend/tests/mix-soundscape-structure.test.mjs` 末尾追加：

```js
test('settings exposes the audio-gen ComfyUI configuration form', () => {
  const settings = read('app/pages/settings.vue')
  assert.match(settings, /\{ type: 'audio-gen', label: t\('common\.serviceType\.audioGen'\) \}/)
  assert.match(settings, /'audio-gen': \{ label: t\('settings\.ai\.meta\.audioGen'\) \}/)
  assert.match(settings, /cfgForm\.service_type === 'audio-gen' && cfgForm\.provider === 'comfyui'/)
  assert.match(settings, /v-model="cfgForm\.provider_settings\.timeout_ms"/)
  assert.match(settings, /v-model="cfgForm\.provider_settings\.normalize_loudness"/)
  assert.match(settings, /v-model="cfgForm\.provider_settings\.model_license"/)
  assert.match(settings, /'audio-gen': \{ label: 'ComfyUI 本地音频工作流'/)
  assert.match(settings, /models: \['stable-audio-open-1\.0'\]/)
  assert.match(settings, /return \['workflow', 'output_node', 'output_key', 'negative_prompt', 'seed', 'timeout_ms', 'normalize_loudness', 'model_license'\]/)
  assert.match(settings, /key === 'timeout_ms'/)
})

test('soundscape copy exists in all four locales', () => {
  const scalar = [
    'title', 'subtitle', 'entry', 'entryHint', 'needMerge', 'running', 'preparing',
    'cancel', 'cancelDone', 'cancelFailed', 'startFailed', 'previewFailed', 'started',
    'done', 'failed', 'aiBadge', 'aiTrack', 'categoriesLabel', 'categoryRequired',
    'crowdModeLabel', 'sceneScope', 'allScenes', 'sceneLabel', 'noScenes', 'sceneRequired',
    'overwrite', 'overwriteHint', 'previewTitle', 'previewCount', 'estimated', 'degraded',
    'prompts', 'reuseLine', 'itemDegraded', 'preview', 'start', 'wholeEpisode',
  ]
  const groups = {
    mode: ['scenes', 'episodeBed', 'assetsOnly'],
    modeHint: ['scenes', 'episodeBed', 'assetsOnly'],
    categories: ['ambience', 'sfx', 'crowd', 'bgm'],
    crowdMode: ['walla', 'lines'],
    crowdModeHint: ['walla', 'lines'],
  }
  const settingsKeys = [
    'audioWorkflowHint', 'audioOutputNodeHint', 'audioTimeout', 'audioTimeoutHint',
    'audioNormalize', 'audioNormalizeHint', 'modelLicense', 'modelLicenseHint',
  ]
  for (const lang of ['zh', 'en', 'ja', 'ko']) {
    const dict = JSON.parse(read(`app/locales/${lang}.json`))
    const block = dict.mix?.soundscape
    assert.ok(block, `${lang} missing mix.soundscape`)
    for (const key of scalar) assert.equal(typeof block[key], 'string', `${lang} missing mix.soundscape.${key}`)
    for (const [group, keys] of Object.entries(groups)) {
      for (const key of keys) {
        assert.equal(typeof block[group]?.[key], 'string', `${lang} missing mix.soundscape.${group}.${key}`)
      }
    }
    assert.equal(typeof dict.common?.serviceType?.audioGen, 'string', `${lang} missing common.serviceType.audioGen`)
    assert.equal(typeof dict.settings?.ai?.meta?.audioGen, 'string', `${lang} missing settings.ai.meta.audioGen`)
    assert.equal(typeof dict.workbench?.soundscapeBusy, 'string', `${lang} missing workbench.soundscapeBusy`)
    for (const key of settingsKeys) assert.equal(typeof dict.settings?.cfg?.[key], 'string', `${lang} missing settings.cfg.${key}`)
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd frontend && node --test tests/mix-soundscape-structure.test.mjs`
Expected: FAIL，设置页无 `audio-gen`，四语言缺少 `mix.soundscape`。

- [ ] **Step 3: 设置页接入 audio-gen**

3.1 服务类型列表增加「声音生成」：

```ts
const serviceTypes = computed(() => [
  { type: 'text', label: t('common.serviceType.text') },
  { type: 'image', label: t('common.serviceType.image') },
  { type: 'video', label: t('common.serviceType.video') },
  { type: 'audio', label: t('common.serviceType.audio') },
  { type: 'audio-gen', label: t('common.serviceType.audioGen') },
])
```

3.2 `serviceMeta` 增加描述，避免分组渲染取不到对象：

```ts
const serviceMeta = computed(() => ({
  text: { label: t('common.serviceType.text'), desc: t('settings.ai.meta.text') },
  image: { label: t('common.serviceType.image'), desc: t('settings.ai.meta.image') },
  video: { label: t('common.serviceType.video'), desc: t('settings.ai.meta.video') },
  audio: { label: t('common.serviceType.audio'), desc: t('settings.ai.meta.audio') },
  'audio-gen': { label: t('common.serviceType.audioGen'), desc: t('settings.ai.meta.audioGen') },
}))
```

3.3 配置表单在现有 ComfyUI 图像/视频分支之前增加音频分支：

```html
          <template v-if="cfgForm.service_type === 'audio-gen' && cfgForm.provider === 'comfyui'">
            <section class="cfg-settings">
              <div class="cfg-settings-head">{{ t('settings.cfg.providerSettings') }}</div>
              <label class="field">
                <span class="field-label">{{ t('settings.cfg.comfyWorkflow') }} <span class="required">*</span></span>
                <textarea
                  v-model="cfgForm.provider_settings.workflow"
                  class="textarea mono cfg-workflow"
                  rows="8"
                  :placeholder="t('settings.cfg.comfyWorkflowPlaceholder')"
                ></textarea>
                <span class="field-hint">{{ t('settings.cfg.audioWorkflowHint') }}</span>
              </label>
              <div class="cfg-setting-grid">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.outputNode') }}</span>
                  <input v-model="cfgForm.provider_settings.output_node" class="input mono" placeholder="9" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.outputKey') }}</span>
                  <input v-model="cfgForm.provider_settings.output_key" class="input mono" placeholder="audio" />
                </label>
              </div>
              <span class="field-hint">{{ t('settings.cfg.audioOutputNodeHint') }}</span>
              <label class="field">
                <span class="field-label">{{ t('settings.cfg.negativePrompt') }}</span>
                <input v-model="cfgForm.provider_settings.negative_prompt" class="input" :placeholder="t('settings.cfg.negativePromptPlaceholder')" />
              </label>
              <div class="cfg-setting-grid">
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.seed') }}</span>
                  <input v-model="cfgForm.provider_settings.seed" class="input" type="number" step="1" :placeholder="t('settings.cfg.seedPlaceholder')" />
                </label>
                <label class="field">
                  <span class="field-label">{{ t('settings.cfg.audioTimeout') }}</span>
                  <input v-model="cfgForm.provider_settings.timeout_ms" class="input" type="number" min="1000" step="1000" placeholder="600000" />
                </label>
              </div>
              <label class="field cfg-check">
                <input v-model="cfgForm.provider_settings.normalize_loudness" type="checkbox" />
                <span>{{ t('settings.cfg.audioNormalize') }}</span>
              </label>
              <span class="field-hint">{{ t('settings.cfg.audioNormalizeHint') }}</span>
              <label class="field">
                <span class="field-label">{{ t('settings.cfg.modelLicense') }}</span>
                <input v-model="cfgForm.provider_settings.model_license" class="input mono" placeholder="stability-ai-community" />
                <span class="field-hint">{{ t('settings.cfg.modelLicenseHint') }}</span>
              </label>
              <span class="field-hint">{{ t('settings.cfg.audioTimeoutHint') }}</span>
            </section>
          </template>
          <template v-else-if="cfgForm.provider === 'comfyui' && (cfgForm.service_type === 'image' || cfgForm.service_type === 'video')">
```

3.4 `CFG_SETTING_KEYS` 在 `provider === 'comfyui'` 通用分支之前增加：

```ts
  if (type === 'audio-gen') {
    return ['workflow', 'output_node', 'output_key', 'negative_prompt', 'seed', 'timeout_ms', 'normalize_loudness', 'model_license']
  }
```

3.5 `emptyProviderSettings` 增加：

```ts
    // ComfyUI 音频生成
    timeout_ms: '',
    normalize_loudness: true,
    model_license: '',
```

3.6 `collectProviderSettings` 的数值键列表增加 `timeout_ms` 并校验：

```ts
    if (['seed', 'fps', 'sampleRate', 'timeoutMs', 'concurrency', 'maxInputChars', 'maxNewTokens', 'timeout_ms'].includes(key)) {
```

```ts
      if (key === 'timeout_ms' && (!Number.isInteger(n) || n <= 0)) throw new Error(t('settings.cfg.numberInvalid'))
```

3.7 `providerPresets` 增加音频组：

```ts
  'audio-gen': {
    comfyui: { label: 'ComfyUI 本地音频工作流', baseUrl: 'http://127.0.0.1:8188', models: ['stable-audio-open-1.0'] },
  },
```

- [ ] **Step 4: 补四语言文案**

4.1 每种语言在 `common.serviceType` 增加 `audioGen`：

```json
{"zh":"声音生成","en":"Sound generation","ja":"サウンド生成","ko":"사운드 생성"}
```

4.2 每种语言在 `settings.ai.meta` 增加 `audioGen`：

```json
{
  "zh": "环境声、音效、群众声与 BGM 的本地 ComfyUI 音频生成",
  "en": "Local ComfyUI audio generation for ambience, SFX, crowd sound and BGM",
  "ja": "環境音・効果音・群衆音・BGM のローカル ComfyUI 音声生成",
  "ko": "환경음, 효과음, 군중 소리, BGM을 위한 로컬 ComfyUI 오디오 생성"
}
```

4.3 每种语言在 `workbench` 增加：

```json
{
  "zh": "声音生成中，完成或取消后才能进入导出",
  "en": "Sound generation is running; finish or cancel it before exporting",
  "ja": "サウンド生成中です。完了またはキャンセル後に書き出しへ進めます",
  "ko": "사운드 생성 중입니다. 완료하거나 취소한 후 내보내기로 이동하세요"
}
```

4.4 每种语言在 `settings.cfg` 增加：

```json
{
  "zh": {
    "audioWorkflowHint": "支持占位符 __PROMPT__ / __NEGATIVE_PROMPT__ / __AUDIO_SECONDS__ / __SEED__ / __MODEL__",
    "audioOutputNodeHint": "留空自动识别第一个含音频的输出节点",
    "audioTimeout": "生成超时（毫秒）",
    "audioTimeoutHint": "单条音频的 ComfyUI 轮询上限，默认 600000",
    "audioNormalize": "响度标准化",
    "audioNormalizeHint": "生成后统一到 -18 LUFS，便于直接参与混音",
    "modelLicense": "模型许可标识",
    "modelLicenseHint": "例如 stability-ai-community，仅用于记录"
  },
  "en": {
    "audioWorkflowHint": "Supports __PROMPT__ / __NEGATIVE_PROMPT__ / __AUDIO_SECONDS__ / __SEED__ / __MODEL__ placeholders",
    "audioOutputNodeHint": "Leave empty to auto-detect the first audio output node",
    "audioTimeout": "Generation timeout (ms)",
    "audioTimeoutHint": "ComfyUI polling limit per clip; defaults to 600000",
    "audioNormalize": "Normalize loudness",
    "audioNormalizeHint": "Normalize to -18 LUFS after generation for direct mixing",
    "modelLicense": "Model license",
    "modelLicenseHint": "For example stability-ai-community; recorded only"
  },
  "ja": {
    "audioWorkflowHint": "__PROMPT__ / __NEGATIVE_PROMPT__ / __AUDIO_SECONDS__ / __SEED__ / __MODEL__ プレースホルダーに対応",
    "audioOutputNodeHint": "空欄の場合は最初の音声出力ノードを自動検出します",
    "audioTimeout": "生成タイムアウト（ミリ秒）",
    "audioTimeoutHint": "音声1件あたりの ComfyUI ポーリング上限。既定値は 600000",
    "audioNormalize": "ラウドネス正規化",
    "audioNormalizeHint": "生成後に -18 LUFS へ正規化し、ミックスへ直接使用できます",
    "modelLicense": "モデルライセンス",
    "modelLicenseHint": "例: stability-ai-community（記録用）"
  },
  "ko": {
    "audioWorkflowHint": "__PROMPT__ / __NEGATIVE_PROMPT__ / __AUDIO_SECONDS__ / __SEED__ / __MODEL__ 플레이스홀더를 지원합니다",
    "audioOutputNodeHint": "비워 두면 첫 번째 오디오 출력 노드를 자동 감지합니다",
    "audioTimeout": "생성 시간 제한(ms)",
    "audioTimeoutHint": "오디오 한 개당 ComfyUI 폴링 제한, 기본값 600000",
    "audioNormalize": "라우드니스 정규화",
    "audioNormalizeHint": "생성 후 -18 LUFS로 정규화해 믹스에 바로 사용합니다",
    "modelLicense": "모델 라이선스",
    "modelLicenseHint": "예: stability-ai-community, 기록용"
  }
}
```

4.5 每种语言在 `mix` 下增加 `soundscape` 对象。

zh：

```json
{
  "title": "生成声音",
  "subtitle": "按场景设定生成环境声、音效、群众声与 BGM，完成后自动进入混音时间线",
  "entry": "生成声音",
  "entryHint": "按剧集设定批量生成环境声、音效、群众声与 BGM",
  "needMerge": "请先完成合片",
  "running": "生成声音中",
  "preparing": "准备生成",
  "cancel": "取消生成",
  "cancelDone": "已取消声音生成",
  "cancelFailed": "取消声音生成失败",
  "startFailed": "启动声音生成失败",
  "previewFailed": "预览声音生成失败",
  "started": "声音生成已启动，完成后自动刷新轨道",
  "done": "声音生成完成，轨道已刷新",
  "failed": "声音生成失败",
  "aiBadge": "AI",
  "aiTrack": "AI 生成轨（内容来自场景设定）",
  "modeLabel": "生成范围",
  "mode": { "scenes": "按场景", "episodeBed": "整集铺底", "assetsOnly": "只生成素材" },
  "modeHint": {
    "scenes": "为每个场景生成独立的环境声、音效与群众声，并按场景时间放置",
    "episodeBed": "生成一条覆盖整集的环境声铺底，适用于氛围统一的剧集",
    "assetsOnly": "只生成音频素材，不自动建轨和放置片段"
  },
  "categoriesLabel": "声音类别",
  "categories": { "ambience": "环境声", "sfx": "音效", "crowd": "群众声", "bgm": "背景音乐" },
  "categoryRequired": "至少选择一类声音",
  "crowdModeLabel": "群众声方式",
  "crowdMode": { "walla": "人群嘈杂声", "lines": "复用已配音台词" },
  "crowdModeHint": {
    "walla": "生成人群环境嘈杂声，不包含可辨识台词",
    "lines": "把已配音的群众台词放入群众轨，不重复生成"
  },
  "sceneScope": "场景范围",
  "allScenes": "全部场景",
  "sceneLabel": "场景 {n}",
  "noScenes": "当前剧集没有关联场景",
  "sceneRequired": "至少选择一个场景",
  "overwrite": "覆盖已有生成",
  "overwriteHint": "关闭时优先复用相同提示词与参数的缓存素材",
  "previewTitle": "生成预览",
  "previewCount": "{n} 条",
  "estimated": "约 {s} 秒生成时间",
  "degraded": "文本模型不可用，已使用确定性提示词降级生成",
  "prompts": "提示词（{n} 条，可修改）",
  "reuseLine": "复用已配音台词，不调用音频生成",
  "itemDegraded": "该条提示词由规则生成",
  "preview": "预览",
  "start": "开始生成",
  "wholeEpisode": "整集"
}
```

en：

```json
{
  "title": "Generate sound",
  "subtitle": "Create ambience, SFX, crowd sound and BGM from scene settings; generated clips are placed on the mix timeline",
  "entry": "Generate sound",
  "entryHint": "Batch-generate ambience, SFX, crowd sound and BGM from episode settings",
  "needMerge": "Finish merging the episode first",
  "running": "Generating sound",
  "preparing": "Preparing",
  "cancel": "Cancel generation",
  "cancelDone": "Sound generation cancelled",
  "cancelFailed": "Failed to cancel sound generation",
  "startFailed": "Failed to start sound generation",
  "previewFailed": "Failed to preview sound generation",
  "started": "Sound generation started; tracks refresh automatically when done",
  "done": "Sound generation completed; tracks refreshed",
  "failed": "Sound generation failed",
  "aiBadge": "AI",
  "aiTrack": "AI-generated track from scene settings",
  "modeLabel": "Scope",
  "mode": { "scenes": "Per scene", "episodeBed": "Episode bed", "assetsOnly": "Assets only" },
  "modeHint": {
    "scenes": "Generate ambience, SFX and crowd sound per scene and place them at scene times",
    "episodeBed": "Generate one ambience bed covering the whole episode",
    "assetsOnly": "Generate audio assets without creating tracks or placing clips"
  },
  "categoriesLabel": "Sound categories",
  "categories": { "ambience": "Ambience", "sfx": "SFX", "crowd": "Crowd", "bgm": "BGM" },
  "categoryRequired": "Select at least one category",
  "crowdModeLabel": "Crowd mode",
  "crowdMode": { "walla": "Crowd walla", "lines": "Reuse dubbed lines" },
  "crowdModeHint": {
    "walla": "Generate unintelligible crowd walla without dialogue",
    "lines": "Place already-dubbed crowd lines on the crowd track instead of regenerating"
  },
  "sceneScope": "Scenes",
  "allScenes": "All scenes",
  "sceneLabel": "Scene {n}",
  "noScenes": "This episode has no linked scenes",
  "sceneRequired": "Select at least one scene",
  "overwrite": "Overwrite generated audio",
  "overwriteHint": "When off, cached assets with the same prompt and parameters are reused",
  "previewTitle": "Preview",
  "previewCount": "{n} items",
  "estimated": "~{s}s generation time",
  "degraded": "Text model unavailable; deterministic prompts are used",
  "prompts": "Prompts ({n}, editable)",
  "reuseLine": "Reuses an existing dubbed line; no audio generation",
  "itemDegraded": "This prompt was generated by rules",
  "preview": "Preview",
  "start": "Start generation",
  "wholeEpisode": "Whole episode"
}
```

ja：

```json
{
  "title": "サウンド生成",
  "subtitle": "シーン設定から環境音・効果音・群衆音・BGMを生成し、ミックスタイムラインに配置します",
  "entry": "サウンド生成",
  "entryHint": "エピソード設定から環境音・効果音・群衆音・BGMを一括生成",
  "needMerge": "先にエピソードを結合してください",
  "running": "サウンド生成中",
  "preparing": "準備中",
  "cancel": "生成をキャンセル",
  "cancelDone": "サウンド生成をキャンセルしました",
  "cancelFailed": "サウンド生成のキャンセルに失敗しました",
  "startFailed": "サウンド生成の開始に失敗しました",
  "previewFailed": "サウンド生成のプレビューに失敗しました",
  "started": "サウンド生成を開始しました。完了後にトラックを自動更新します",
  "done": "サウンド生成が完了し、トラックを更新しました",
  "failed": "サウンド生成に失敗しました",
  "aiBadge": "AI",
  "aiTrack": "シーン設定から生成された AI トラック",
  "modeLabel": "生成範囲",
  "mode": { "scenes": "シーン単位", "episodeBed": "エピソード全体", "assetsOnly": "素材のみ" },
  "modeHint": {
    "scenes": "シーンごとに環境音・効果音・群衆音を生成し、シーン時間に配置します",
    "episodeBed": "エピソード全体を覆う環境音ベッドを1本生成します",
    "assetsOnly": "音声素材のみ生成し、トラック作成やクリップ配置は行いません"
  },
  "categoriesLabel": "サウンド種別",
  "categories": { "ambience": "環境音", "sfx": "効果音", "crowd": "群衆音", "bgm": "BGM" },
  "categoryRequired": "少なくとも1つの種別を選択してください",
  "crowdModeLabel": "群衆音の方式",
  "crowdMode": { "walla": "群衆のざわめき", "lines": "既存の吹替台詞を再利用" },
  "crowdModeHint": {
    "walla": "台詞を含まない群衆のざわめきを生成します",
    "lines": "既に吹き替えた群衆台詞を群衆トラックに配置し、再生成しません"
  },
  "sceneScope": "シーン範囲",
  "allScenes": "すべてのシーン",
  "sceneLabel": "シーン {n}",
  "noScenes": "このエピソードに関連シーンがありません",
  "sceneRequired": "少なくとも1つのシーンを選択してください",
  "overwrite": "生成済み音声を上書き",
  "overwriteHint": "オフの場合、同じプロンプトとパラメータのキャッシュ素材を再利用します",
  "previewTitle": "生成プレビュー",
  "previewCount": "{n} 件",
  "estimated": "生成時間 約 {s} 秒",
  "degraded": "テキストモデルが利用できないため、決定論的プロンプトで生成します",
  "prompts": "プロンプト（{n} 件、編集可能）",
  "reuseLine": "既存の吹替台詞を再利用します。音声生成は行いません",
  "itemDegraded": "このプロンプトはルールで生成されました",
  "preview": "プレビュー",
  "start": "生成開始",
  "wholeEpisode": "エピソード全体"
}
```

ko：

```json
{
  "title": "사운드 생성",
  "subtitle": "장면 설정으로 환경음, 효과음, 군중 소리, BGM을 생성해 믹스 타임라인에 배치합니다",
  "entry": "사운드 생성",
  "entryHint": "에피소드 설정으로 환경음, 효과음, 군중 소리, BGM을 일괄 생성",
  "needMerge": "먼저 에피소드 병합을 완료하세요",
  "running": "사운드 생성 중",
  "preparing": "준비 중",
  "cancel": "생성 취소",
  "cancelDone": "사운드 생성을 취소했습니다",
  "cancelFailed": "사운드 생성 취소에 실패했습니다",
  "startFailed": "사운드 생성 시작에 실패했습니다",
  "previewFailed": "사운드 생성 미리보기에 실패했습니다",
  "started": "사운드 생성을 시작했습니다. 완료되면 트랙이 자동 갱신됩니다",
  "done": "사운드 생성이 완료되어 트랙을 갱신했습니다",
  "failed": "사운드 생성에 실패했습니다",
  "aiBadge": "AI",
  "aiTrack": "장면 설정에서 생성된 AI 트랙",
  "modeLabel": "생성 범위",
  "mode": { "scenes": "장면별", "episodeBed": "에피소드 전체", "assetsOnly": "소재만" },
  "modeHint": {
    "scenes": "장면마다 환경음, 효과음, 군중 소리를 생성해 장면 시간에 배치합니다",
    "episodeBed": "에피소드 전체를 덮는 환경음 베드를 하나 생성합니다",
    "assetsOnly": "오디오 소재만 생성하고 트랙 생성이나 클립 배치는 하지 않습니다"
  },
  "categoriesLabel": "사운드 종류",
  "categories": { "ambience": "환경음", "sfx": "효과음", "crowd": "군중 소리", "bgm": "BGM" },
  "categoryRequired": "사운드 종류를 하나 이상 선택하세요",
  "crowdModeLabel": "군중 소리 방식",
  "crowdMode": { "walla": "군중 웅성거림", "lines": "더빙된 대사 재사용" },
  "crowdModeHint": {
    "walla": "식별 가능한 대사가 없는 군중 웅성거림을 생성합니다",
    "lines": "이미 더빙한 군중 대사를 군중 트랙에 배치하고 다시 생성하지 않습니다"
  },
  "sceneScope": "장면 범위",
  "allScenes": "모든 장면",
  "sceneLabel": "장면 {n}",
  "noScenes": "이 에피소드에 연결된 장면이 없습니다",
  "sceneRequired": "장면을 하나 이상 선택하세요",
  "overwrite": "생성된 오디오 덮어쓰기",
  "overwriteHint": "끄면 같은 프롬프트와 파라미터의 캐시 소재를 재사용합니다",
  "previewTitle": "생성 미리보기",
  "previewCount": "{n}개",
  "estimated": "생성 시간 약 {s}초",
  "degraded": "텍스트 모델을 사용할 수 없어 결정적 프롬프트로 생성합니다",
  "prompts": "프롬프트 ({n}개, 편집 가능)",
  "reuseLine": "기존 더빙 대사를 재사용하며 오디오를 생성하지 않습니다",
  "itemDegraded": "이 프롬프트는 규칙으로 생성되었습니다",
  "preview": "미리보기",
  "start": "생성 시작",
  "wholeEpisode": "에피소드 전체"
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd frontend && node --test tests/mix-soundscape-structure.test.mjs`
Expected: PASS。

- [ ] **Step 6: 回归设置页与文案测试**

Run: `cd frontend && node --test tests/official-provider-settings.test.mjs tests/provider-settings-fields.test.mjs tests/mix-ui-cn.test.mjs tests/audio-tracks-structure.test.mjs`
Expected: PASS。

- [ ] **Step 7: 静态复查**

确认：
- `audio-gen` 只出现在服务类型与设置表单，TTS 的 `audio` 分支未改动；
- 新配置保存时 `normalize_loudness` 保持布尔值，`timeout_ms / seed` 转为数字；
- 四语言键名完全一致，`sceneLabel` 与 `previewCount` 使用 vue-i18n 命名参数；
- 设置页没有硬编码中文新增文案（预设名称除外，沿用现有 providerPresets 习惯）。

---

## Task 15: 全量验证与前端构建门禁

**Files:**
- Verify: `backend/src/**`、`frontend/app/**`
- Test: `backend/tests/*.test.ts`、`frontend/tests/*.test.mjs`

**Interfaces:**
- Consumes: Task 1–14 的全部交付物。
- Produces: 测试、类型检查与构建证据；不产生业务代码。

- [ ] **Step 1: 确认改动范围**

Run:

```bash
git status --short
git diff --stat
```

Expected: 只有本计划列出的源文件、新增测试与四语言文案；没有 `.env`、密钥、构建产物、安装包或无关重构。

- [ ] **Step 2: 后端定向测试**

Run:

```bash
cd backend && npx tsx --test tests/audio-tracks.test.ts tests/ai-config-settings.test.ts tests/timeline.test.ts tests/comfyui-audio.test.ts tests/soundscape-compiler.test.ts tests/soundscape-tracks.test.ts tests/soundscape.test.ts tests/soundscape-routes.test.ts tests/mix-plan.test.ts tests/audio-separation.test.ts tests/mix-routes.test.ts
```

Expected: 全部 PASS，0 failed。任何失败必须先回到对应任务的失败测试定位，不得直接改预期。

- [ ] **Step 3: 前端定向测试**

Run:

```bash
cd frontend && node --test tests/mix-soundscape-structure.test.mjs tests/mix-ui-cn.test.mjs tests/official-provider-settings.test.mjs tests/provider-settings-fields.test.mjs tests/mix-playback-engine.test.mjs tests/mix-playback-structure.test.mjs
```

Expected: 全部 PASS。

- [ ] **Step 4: 后端全量测试**

Run:

```bash
cd backend && npm test
```

Expected: 全部测试通过，0 failed；不得用定向测试代替全量回归。

- [ ] **Step 5: 后端类型检查**

Run:

```bash
cd backend && npm run typecheck
```

Expected: 退出码 0，无 TypeScript 错误。

- [ ] **Step 6: 前端全量结构测试**

Run:

```bash
cd frontend && node --test tests/*.test.mjs
```

Expected: 全部 PASS；若与本次无关的既有测试失败，先确认基线，再记录并报告。

- [ ] **Step 7: Spec 验收对照**

逐条核对，任何一行没有测试证据都必须补测试后重跑：

| 验收项 | 证据 |
|---|---|
| `origin` 只由服务端写入，更新轨不覆盖，保存计划不能伪造 | `audio-tracks.test.ts`、`mix-plan.test.ts`、`soundscape-tracks.test.ts` |
| `audio-gen` 与 TTS `audio` 隔离，ComfyUI 音频工作流校验 `__PROMPT__` | `ai-config-settings.test.ts`、`soundscape-routes.test.ts` |
| 时间轴返回分镜位置，供场景切片使用 | `timeline.test.ts` |
| 音频占位符数值安全、产物提取、下载与取消 | `comfyui-audio.test.ts` |
| 三种模式、四类别、群众两种模式、确定性降级、覆盖、种子与哈希 | `soundscape-compiler.test.ts` |
| 建轨、片段重建、淡入淡出、循环、`assets-only` 不建轨 | `soundscape-tracks.test.ts` |
| 编排、缓存、部分失败、取消、重启恢复、全局串行 | `soundscape.test.ts` |
| 原声床保留、虚拟对白排除群众台词、删除素材清理 | `mix-plan.test.ts`、`audio-separation.test.ts` |
| 预览/启动/状态/取消路由与保存 409 | `soundscape-routes.test.ts`、`mix-routes.test.ts` |
| 前端 API、轮询、防复活、弹窗、入口、生成锁、AI 徽标 | `mix-soundscape-structure.test.mjs` |
| 设置页 `audio-gen` 字段与四语言键一致 | `mix-soundscape-structure.test.mjs`、`official-provider-settings.test.mjs`、`mix-ui-cn.test.mjs` |
| TTS 链路未改 | 下方静态检查 |

Run:

```bash
git diff --name-only -- backend/src/services/tts.ts backend/src/services/line-takes.ts backend/src/services/take-batch.ts backend/src/services/adapters/qwen-tts.ts backend/src/services/adapters/cloud-tts.ts
```

Expected: 无输出。`backend/src/services/ai.ts` 因新增 `audio-gen` 服务类型允许有改动，但不得修改 `audio` 类型的 TTS 行为。

- [ ] **Step 8: 前端构建门禁（需用户明确批准）**

先向用户说明将执行 `cd frontend && npm run build`，只有收到明确同意后才运行。构建不是安装、打包或启动，但会覆盖 `.nuxt` / `.output`，必须单独批准。

Run:

```bash
cd frontend && npm run build
```

Expected: 退出码 0，无 SFC 编译错误、无未解析导入、无 vue-i18n 缺失键导致的构建失败。

- [ ] **Step 9: 记录验证结果**

在会话总结中记录每条命令的退出码、通过/失败数量与构建结果。未运行前端构建时，不得声称前端可用或构建通过。

---

## Task 16: 真实 ComfyUI 端到端验收（需单独批准）

**Files:**
- Verify only：不修改源代码。
- 记录：会话总结（配置摘要、状态、轨道、片段、耗时、产物路径、试听结论）。

**Interfaces:**
- Consumes: Task 15 全部通过；本机 ComfyUI（`8188` 或 `8189`）可用且已安装 Stable Audio Open 工作流；`audio-gen` 配置已保存。
- Produces: 真实生成、试听、导出、缓存、取消、重启与群众台词的验收证据。

**执行前审批：** 本任务会启动/重启本次开发服务并调用 GPU。开始前先向用户说明并取得批准。安装模型、修改 ComfyUI 工作流、重启系统级服务或改动端口不在本任务内；若模型缺失，停止并报告，不要自行下载或修改。

- [ ] **Step 1: 环境预检（只读）**

在设置页选择“声音生成 → ComfyUI”，确认 `baseUrl` 指向本机 `127.0.0.1:8188` 或 `127.0.0.1:8189`，点击“测试连接”得到成功。不得打印 API Key、完整工作流或服务器地址。确认工作流包含 `__PROMPT__`、`__NEGATIVE_PROMPT__`、`__AUDIO_SECONDS__`、`__SEED__`，且输出节点/输出键与配置一致。

- [ ] **Step 2: 选择测试集并记录 TTS 基线**

选一集已合片、至少 2 个场景、总时长 15–60 秒的剧集，记录 `episodeId`。若没有已合片剧集，先按现有合片流程合片（需批准），不要为验收新建长剧集。在配音工作台记录相关台词 Take 数量与更新时间，作为“TTS 未变”的基线。

- [ ] **Step 3: 按场景预览**

混音工作台 →“生成声音”，模式“按场景”，类别全选，群众声“群众嘈杂声”。预期：环境声/音效/群众声每场景各一项，BGM 整集一项；提示词为英文；显示项目数、预计时间与警告；无文本模型时 `degraded=true` 且有提示。编辑一项提示词后重新预览，确认覆盖值生效；预览不得创建轨道或片段。

- [ ] **Step 4: 启动与生成锁**

点击“生成开始”。预期：出现进度条与取消按钮；编辑、添加轨道、保存、导出、上一步/下一步均被阻止；不出现自动保存 409。观察状态从 `running` 到 `completed`，记录耗时。

- [ ] **Step 5: 轨道与片段**

预期出现对应 AI 轨（有生成项时），轨道头显示 AI 徽标；片段按场景绝对时间放置；环境声/BGM 覆盖整集，素材短于范围时 `loop=true`；片段有淡入淡出（整集铺底首尾除外）。刷新页面后轨道与片段仍在，保存混音不得把 `origin` 改回默认值。

- [ ] **Step 6: 实时试听**

从 0、场景交界、结尾分别播放。确认原声对白仍在、生成环境声可听、没有重复叠加的原声底噪；M/S 与音量控制可用。若没有音频输出设备，必须记录“未完成听感验证”，不能用其他测试替代。

- [ ] **Step 7: 保存与导出**

保存混音并刷新，确认片段不变。导出整集，用 `ffprobe` 确认时长与合片一致，并试听导出文件确认包含对白与生成声。记录产物路径，不提交大文件。

- [ ] **Step 8: 缓存与覆盖**

相同参数、关闭“覆盖已生成素材”再跑一次：预期 `reused > 0`，已完成素材不重复提交 ComfyUI（服务端日志中的提交次数不增加）。打开覆盖再跑一次：预期重新生成并替换素材，轨道片段不重复叠加。

- [ ] **Step 9: 整集铺底**

模式“整集铺底”，只选环境声 + BGM。预期：两者各一项，覆盖 0 到整集终点；音效/群众声仍按场景；片段循环正确。

- [ ] **Step 10: 仅生成素材**

模式“仅生成素材”。预期：不新建/删除轨道与片段；素材列表出现 `kind='soundscape'` 素材；随后按场景重跑命中缓存并建轨。

- [ ] **Step 11: 群众台词模式**

模式“按场景”，群众声“复用已配音台词”。预期：群众项 `source='lines'`，不生成群众音频、不调用 TTS；已激活 Take 放入群众轨；虚拟对白轨不再包含这些台词（仅在有群众轨时）。对照 Step 2 基线，确认台词 Take 数量/更新时间未变；确认无 `18190` TTS 请求（观察后端日志即可，不打印敏感信息）。

- [ ] **Step 12: 取消与重启**

生成中取消：预期状态 `cancelled`，保留已完成素材，不建轨（此前已有的轨不动）。重启本次开发后端（需批准）：运行中的任务状态变为 `failed`，错误为“服务重启导致任务中断，请重新生成”；重跑成功。

- [ ] **Step 13: 缺陷处理**

任一预期不符：停止验收，按 systematic-debugging 定位根因；在对应测试文件先写失败测试，再修复并重跑 Task 15 的相关门禁。不得为通过验收直接修改测试预期。

- [ ] **Step 14: 验收记录**

在会话总结中列出：配置摘要（不含密钥与完整工作流）、`episodeId`、模式、项目数、耗时、轨道数、片段数、缓存命中、导出路径与 `ffprobe` 结果、试听结论、取消/重启结果。不新建文档、不提交大文件，除非用户要求。

---
