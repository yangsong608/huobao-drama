# 配音工作台阶段 2（音色设计）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让音色设计阶段清楚展示「试听哪段文本、哪个版本、什么参数」，支持试听历史、自由试音、重新设计新版本，并且切换音色不再删除已有音频。

**Architecture:** 新增 `voice-samples` 服务承载试听/自由试音/历史/设为样例，路由复用现有 `/voices` 挂载点；`voice-profile` 的激活与旁白绑定改为保留旧音频并标记 `audio_stale`；重新设计走独立 `/voices/:id/design` 创建新版本。前端在现有 `VoiceProfileCard` 内展开试听面板，不新增并行页面。

**Tech Stack:** Hono + Drizzle ORM + better-sqlite3；Nuxt 3 / Vue 3 / vue-i18n；Node 22.16.0（后端命令）。

**Spec:** `docs/V3-配音工作台详细设计.md` 第 6 章（音色设计）、7.3.4（能力矩阵）、7.4（参数优先级）

## Global Constraints

- 不提交 git；所有变更保持未提交状态，等待用户明确要求。
- 不构建、不打包、不安装、不重启桌面端；验证仅限测试与 `nuxt build` 类型/模板门禁。
- 「注意 tts 先不改」：不改 TTS 服务、协议与适配器行为；仅允许透传 `params.seed`（参数直通）。
- TTS 内容缓存键不得去掉 seed；相同文本 + 参数 + 种子必须命中缓存。
- 保留端口 5679/3013、MCP 61 项、`TEMPLATE_VERSION=6`、V3-G5 待验收状态。
- 复用现有 UI：只扩展 `VoiceProfileCard` / `DubbingStage` / `useVoiceProfiles` / `useApi`，不新增并行页面或重复入口。
- 激活/改派音色不删除音频；无音频的台词不得出现 `audio_stale=true`。
- 四语言（zh/en/ja/ko）文案必须齐全。
- 后端命令使用 Node 22.16.0：
  `PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH`
- 测试数据目录必须使用独立临时 `SQLITE_PATH` / `HUOBAO_DATA_DIR` / `STORAGE_PATH`。

---

### Task 1: 试听与自由试音服务

**Files:**
- Create: `backend/src/services/voice-samples.ts`
- Test: `backend/tests/voice-samples.test.ts`

**Interfaces:**
- Consumes: `getVoice` / `updateVoice` / `VoiceRow` from `voice-profile.ts`；`collectSampleLines` from `voice-design.ts`；`getAudioConfig` / `synthesize` / `AudioConfig` from `tts.ts`。
- Produces:
  - `AUDITION_MAX_CHARS = 300`
  - `SPEECH_MAX_CHARS = 2000`
  - `resolveAuditionText(voice: VoiceRow, episodeId?: number | null): { text: string; source: 'default' | 'custom' | 'line' }`
  - `generateVoiceSample(input, deps?): Promise<{ sample: VoiceSampleRow; text: string; textSource: AuditionTextSource; seed: number; cached: boolean; truncated: boolean }>`
  - `listVoiceSamples(voiceId: number, limit?: number): VoiceSampleRow[]`
  - `setVoiceSample(voiceId: number, sampleId: number): VoiceRow`
  - `deleteVoiceSample(voiceId: number, sampleId: number): boolean`
  - `assignVoiceToLines(voiceId: number, episodeId: number, lineIds: number[]): { updated: number }`

- [x] **Step 1: 写失败测试**

创建 `backend/tests/voice-samples.test.ts`：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-voice-samples-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { createVoice } = await import('../src/services/voice-profile.ts')
const {
  AUDITION_MAX_CHARS,
  SPEECH_MAX_CHARS,
  assignVoiceToLines,
  deleteVoiceSample,
  generateVoiceSample,
  listVoiceSamples,
  resolveAuditionText,
  setVoiceSample,
} = await import('../src/services/voice-samples.ts')

const ts = '2026-11-05T00:00:00.000Z'
const fakeConfig = {
  provider: 'qwen3-tts',
  baseUrl: 'http://127.0.0.1:18190',
  apiKey: 'test',
  model: 'qwen3-tts-voicedesign',
  settings: {},
} as any
let synthCalls: any[] = []
const fakeSynth = (async (params: any) => {
  synthCalls.push(params)
  return { url: 'static/tts/fake.wav', durationMs: 1234, format: 'wav', hash: 'fake-hash', cached: false }
}) as any

db.insert(schema.dramas).values({ title: '试听测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values({ dramaId: 1, name: '林小雨', role: '女主', createdAt: ts, updatedAt: ts }).run()
const [episode] = db.insert(schema.episodes).values({ dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts }).returning().all()
const [storyboard] = db.insert(schema.storyboards).values({ episodeId: episode.id, dramaId: 1, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().all()
db.insert(schema.storyboardLines).values({
  episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id, lineNo: 1,
  speakerType: 'dialogue', characterId: 1, speakerName: '林小雨',
  text: '雨夜里的每一步都像踩在回忆上。', speakText: '雨夜里的每一步都像踩在回忆上。',
  createdAt: ts, updatedAt: ts,
}).run()

function makeVoice(overrides: Record<string, any> = {}) {
  return createVoice({
    dramaId: 1, characterId: 1, name: '林小雨 · 声线', source: 'design',
    voicePrompt: '清冷少女音', designInstruct: 'calm young female', speed: 1.05,
    emotion: '克制', status: 'ready', ...overrides,
  })
}

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('试听文本优先级：sample_text > 本集首句 > 固定句', () => {
  const saved = makeVoice({ sampleText: '保存的试听文本。' })
  assert.deepEqual(resolveAuditionText(saved, episode.id), { text: '保存的试听文本。', source: 'default' })

  const fromLine = makeVoice({ name: '第二声线' })
  assert.deepEqual(resolveAuditionText(fromLine, episode.id), { text: '雨夜里的每一步都像踩在回忆上。', source: 'line' })

  const narrator = createVoice({ dramaId: 1, scope: 'narrator', name: '旁白', source: 'design', status: 'ready' })
  assert.deepEqual(resolveAuditionText(narrator, episode.id), { text: '我是旁白，很高兴见到你。', source: 'default' })
})

test('生成试听写入 voice_samples，自动分配种子并写回音色', async () => {
  synthCalls = []
  const voice = makeVoice({ seed: null })
  const result = await generateVoiceSample({
    voiceId: voice.id, kind: 'audition', text: '我是林小雨。', episodeId: episode.id,
  }, { config: fakeConfig, synthesize: fakeSynth })

  assert.equal(result.text, '我是林小雨。')
  assert.equal(result.textSource, 'custom')
  assert.ok(result.seed > 0)
  assert.equal(result.sample.status, 'ready')
  assert.equal(result.sample.audioUrl, 'static/tts/fake.wav')
  assert.equal(result.sample.durationMs, 1234)
  assert.equal(result.sample.textSource, 'custom')
  assert.equal(result.sample.provider, 'qwen3-tts')
  assert.equal(result.sample.model, 'qwen3-tts-voicedesign')
  assert.equal(JSON.parse(result.sample.paramsJson || '{}').speed, 1.05)
  assert.equal(synthCalls[0].seed, result.seed)

  const persisted = db.select().from(schema.characterVoices).all().find(row => row.id === voice.id)!
  assert.equal(persisted.seed, result.seed)
  assert.equal(persisted.sampleUrl, null)
})

test('显式种子覆盖并写回，setSample 才更新当前样音', async () => {
  synthCalls = []
  const voice = makeVoice({ seed: 11 })
  const result = await generateVoiceSample({
    voiceId: voice.id, kind: 'audition', text: '换一个种子。', seed: 20261105, setSample: true,
  }, { config: fakeConfig, synthesize: fakeSynth })

  assert.equal(result.seed, 20261105)
  assert.equal(synthCalls[0].seed, 20261105)
  const persisted = db.select().from(schema.characterVoices).all().find(row => row.id === voice.id)!
  assert.equal(persisted.seed, 20261105)
  assert.equal(persisted.sampleUrl, 'static/tts/fake.wav')
  assert.equal(persisted.sampleText, '换一个种子。')
})

test('试听保留最近 20 条，历史可设为样例和删除', async () => {
  const voice = makeVoice()
  for (let i = 0; i < 22; i += 1) {
    await generateVoiceSample({ voiceId: voice.id, kind: 'audition', text: `试听 ${i}` }, { config: fakeConfig, synthesize: fakeSynth })
  }
  const rows = listVoiceSamples(voice.id, 50)
  assert.equal(rows.length, 20)
  assert.equal(rows[0].text, '试听 21')

  const target = rows[5]
  const updated = setVoiceSample(voice.id, target.id)
  assert.equal(updated.sampleUrl, target.audioUrl)
  assert.equal(updated.sampleText, target.text)

  assert.equal(deleteVoiceSample(voice.id, target.id), true)
  assert.equal(deleteVoiceSample(voice.id, target.id), false)
  assert.equal(listVoiceSamples(voice.id, 50).some(row => row.id === target.id), false)
})

test('自由试音不截断、不默认设为样例，超过 2000 字被拒绝', async () => {
  const voice = makeVoice()
  const longText = '长'.repeat(SPEECH_MAX_CHARS)
  const result = await generateVoiceSample({
    voiceId: voice.id, kind: 'speech', text: longText,
  }, { config: fakeConfig, synthesize: fakeSynth })
  assert.equal(result.truncated, false)
  assert.equal(result.sample.kind, 'speech')
  assert.equal([...result.sample.text].length, SPEECH_MAX_CHARS)

  await assert.rejects(
    generateVoiceSample({ voiceId: voice.id, kind: 'speech', text: `${longText}超` }, { config: fakeConfig, synthesize: fakeSynth }),
    /2000/,
  )

  const persisted = db.select().from(schema.characterVoices).all().find(row => row.id === voice.id)!
  assert.equal(persisted.sampleUrl, null)
})

test('试听超 300 字只保留前 300 字并标记 truncated', async () => {
  const voice = makeVoice()
  const result = await generateVoiceSample({
    voiceId: voice.id, kind: 'audition', text: '甲'.repeat(AUDITION_MAX_CHARS + 10),
  }, { config: fakeConfig, synthesize: fakeSynth })
  assert.equal(result.truncated, true)
  assert.equal([...result.text].length, AUDITION_MAX_CHARS)
})

test('改派音色到指定台词：保留旧音频、标记 audio_stale、锁定显式选择', () => {
  const voice = makeVoice({ name: '改派声线' })
  const [line] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id, lineNo: 20,
    speakerType: 'dialogue', characterId: 1, speakerName: '林小雨', text: '改派。', speakText: '改派。',
    status: 'ready', audioUrl: 'static/tts/old.wav', audioDurationMs: 800, audioHash: 'old',
    createdAt: ts, updatedAt: ts,
  }).returning().all()
  const [empty] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id, lineNo: 21,
    speakerType: 'dialogue', characterId: 1, speakerName: '林小雨', text: '没录音。', speakText: '没录音。',
    status: 'pending', createdAt: ts, updatedAt: ts,
  }).returning().all()

  const result = assignVoiceToLines(voice.id, episode.id, [line.id, empty.id])
  assert.equal(result.updated, 2)

  const rows = db.select().from(schema.storyboardLines).all()
  const withAudio = rows.find(row => row.id === line.id)!
  const noAudio = rows.find(row => row.id === empty.id)!
  assert.equal(withAudio.voiceId, voice.id)
  assert.equal(withAudio.voiceLocked, true)
  assert.equal(withAudio.audioUrl, 'static/tts/old.wav')
  assert.equal(withAudio.status, 'ready')
  assert.equal(withAudio.audioStale, true)
  assert.equal(noAudio.voiceId, voice.id)
  assert.equal(noAudio.audioStale, false)
})
```

- [x] **Step 2: 运行测试确认失败**

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/voice-samples.test.ts`

Expected: FAIL，提示无法找到 `../src/services/voice-samples.ts`。

- [x] **Step 3: 实现服务**

创建 `backend/src/services/voice-samples.ts`：

```ts
/**
 * 音色试听 / 自由试音 / 历史（设计 6.2–6.4）。
 *
 * 每次生成都写 voice_samples；当前样音只在显式「设为样例」时更新。
 * 种子优先显式入参，其次音色版本 seed，最后自动分配并写回，保证可复现。
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { getAudioConfig, synthesize, type AudioConfig } from './tts.js'
import { getVoice, updateVoice, type VoiceRow } from './voice-profile.js'
import { collectSampleLines } from './voice-design.js'

export const AUDITION_MAX_CHARS = 300
export const SPEECH_MAX_CHARS = 2000
const KEEP_PER_VOICE = 20

export type VoiceSampleKind = 'audition' | 'speech' | 'clone_test'
export type AuditionTextSource = 'default' | 'custom' | 'line'
export type VoiceSampleRow = typeof schema.voiceSamples.$inferSelect

export interface AuditionText {
  text: string
  source: AuditionTextSource
}

export interface GenerateVoiceSampleInput {
  voiceId: number
  kind?: VoiceSampleKind
  text?: string | null
  textSource?: AuditionTextSource | null
  seed?: number | null
  episodeId?: number | null
  setSample?: boolean
  params?: {
    speed?: number | null
    emotion?: string | null
    language?: string | null
  }
}

export interface VoiceSampleDeps {
  config?: AudioConfig | null
  synthesize?: typeof synthesize
}

export interface GenerateVoiceSampleResult {
  sample: VoiceSampleRow
  text: string
  textSource: AuditionTextSource
  seed: number
  cached: boolean
  truncated: boolean
}

function charCount(text: string): number {
  return [...text].length
}

function normalizeSeed(value: unknown): number | null {
  const seed = Number(value)
  if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) return null
  return seed
}

function validSpeed(value: unknown): number | null {
  const speed = Number(value)
  return Number.isFinite(speed) && speed >= 0.5 && speed <= 1.5 ? speed : null
}

export function resolveAuditionText(voice: VoiceRow, episodeId?: number | null): AuditionText {
  const saved = String(voice.sampleText || '').trim()
  if (saved) return { text: saved, source: 'default' }

  if (episodeId && voice.characterId) {
    const character = db.select().from(schema.characters).where(eq(schema.characters.id, voice.characterId)).get()
    if (character) {
      const line = collectSampleLines(episodeId).get(character.name)
      if (line?.trim()) return { text: line.trim(), source: 'line' }
    }
  }
  return { text: `我是${voice.name}，很高兴见到你。`, source: 'default' }
}

export function ensureVoiceSeed(voice: VoiceRow): number {
  const existing = normalizeSeed(voice.seed)
  if (existing !== null) return existing
  const seed = Math.floor(Math.random() * 2_000_000_000)
  updateVoice(voice.id, { seed })
  return seed
}

export function listVoiceSamples(voiceId: number, limit = KEEP_PER_VOICE): VoiceSampleRow[] {
  return db.select().from(schema.voiceSamples)
    .where(and(eq(schema.voiceSamples.voiceId, voiceId), isNull(schema.voiceSamples.deletedAt)))
    .orderBy(desc(schema.voiceSamples.id))
    .limit(Math.max(1, Math.min(limit, 100)))
    .all()
}

function trimSamples(voiceId: number) {
  const rows = listVoiceSamples(voiceId, 100)
  for (const row of rows.slice(KEEP_PER_VOICE)) {
    db.update(schema.voiceSamples).set({ deletedAt: now() }).where(eq(schema.voiceSamples.id, row.id)).run()
  }
}

export function setVoiceSample(voiceId: number, sampleId: number): VoiceRow {
  const sample = db.select().from(schema.voiceSamples)
    .where(and(
      eq(schema.voiceSamples.id, sampleId),
      eq(schema.voiceSamples.voiceId, voiceId),
      isNull(schema.voiceSamples.deletedAt),
    ))
    .get()
  if (!sample || sample.status !== 'ready' || !sample.audioUrl) throw new Error('试听记录不存在或尚未生成完成')
  const updated = updateVoice(voiceId, { sampleUrl: sample.audioUrl, sampleText: sample.text, status: 'ready' })
  if (!updated) throw new Error('音色不存在')
  return updated
}

export function deleteVoiceSample(voiceId: number, sampleId: number): boolean {
  const sample = db.select().from(schema.voiceSamples)
    .where(and(
      eq(schema.voiceSamples.id, sampleId),
      eq(schema.voiceSamples.voiceId, voiceId),
      isNull(schema.voiceSamples.deletedAt),
    ))
    .get()
  if (!sample) return false
  db.update(schema.voiceSamples).set({ deletedAt: now() }).where(eq(schema.voiceSamples.id, sampleId)).run()
  return true
}

export async function generateVoiceSample(
  input: GenerateVoiceSampleInput,
  deps: VoiceSampleDeps = {},
): Promise<GenerateVoiceSampleResult> {
  const voice = getVoice(input.voiceId)
  if (!voice) throw new Error('音色不存在')

  const kind: VoiceSampleKind = input.kind ?? 'audition'
  const maxChars = kind === 'speech' ? SPEECH_MAX_CHARS : AUDITION_MAX_CHARS
  const resolved = resolveAuditionText(voice, input.episodeId)
  const provided = String(input.text ?? '').trim()
  const rawText = provided || resolved.text
  if (!rawText) throw new Error('试听文本不能为空')

  if (kind === 'speech' && charCount(rawText) > maxChars) {
    throw new Error(`自由试音文本不能超过 ${maxChars} 字`)
  }
  const truncated = charCount(rawText) > maxChars
  const text = truncated ? [...rawText].slice(0, maxChars).join('') : rawText
  const textSource: AuditionTextSource = input.textSource ?? (provided ? 'custom' : resolved.source)
  const explicitSeed = normalizeSeed(input.seed)
  const seed = explicitSeed ?? ensureVoiceSeed(voice)
  if (explicitSeed !== null && explicitSeed !== voice.seed) updateVoice(voice.id, { seed: explicitSeed })

  const params = {
    speed: validSpeed(input.params?.speed) ?? validSpeed(voice.speed) ?? 1,
    emotion: input.params?.emotion ?? voice.emotion ?? null,
    language: input.params?.language ?? voice.language ?? null,
    instruct: voice.designInstruct || voice.voicePrompt || null,
  }

  const config = deps.config !== undefined ? deps.config : await getAudioConfig()
  if (!config) {
    updateVoice(voice.id, { status: 'pending_model' })
    const error = new Error('未配置语音服务，请先在设置中添加并启用 audio 服务')
    ;(error as Error & { code?: string }).code = 'no_audio_config'
    throw error
  }

  const created = db.insert(schema.voiceSamples).values({
    voiceId: voice.id,
    dramaId: voice.dramaId,
    kind,
    text,
    textSource,
    seed,
    provider: config.provider,
    model: config.model || voice.model || null,
    paramsJson: JSON.stringify(params),
    status: 'generating',
    createdAt: now(),
  }).run()
  const sampleId = getInsertId(created)

  try {
    const synth = deps.synthesize ?? synthesize
    const result = await synth({
      text,
      voice: {
        externalVoiceId: voice.externalVoiceId || undefined,
        voicePrompt: voice.voicePrompt || undefined,
        designInstruct: voice.designInstruct || undefined,
        refAudioUrl: voice.refAudioUrl || undefined,
        refText: voice.refText || undefined,
        xVectorOnly: Boolean(voice.xVectorOnly),
      },
      speed: params.speed,
      emotion: params.emotion ?? undefined,
      language: params.language ?? undefined,
      seed,
    })
    const sample = db.update(schema.voiceSamples).set({
      audioUrl: result.url,
      durationMs: result.durationMs,
      hash: result.hash,
      status: 'ready',
      error: null,
    }).where(eq(schema.voiceSamples.id, sampleId)).returning().get()!

    trimSamples(voice.id)
    if (input.setSample) setVoiceSample(voice.id, sample.id)
    else if (kind === 'audition') updateVoice(voice.id, { status: 'ready' })

    return { sample, text, textSource, seed, cached: result.cached, truncated }
  } catch (error: any) {
    const message = String(error?.message || error).slice(0, 500)
    db.update(schema.voiceSamples).set({ status: 'failed', error: message }).where(eq(schema.voiceSamples.id, sampleId)).run()
    if (kind === 'audition') updateVoice(voice.id, { status: 'failed' })
    throw error
  }
}

/** 自由试音/试听后改派到台词：保留旧音频与 Take，只标 audio_stale */
export function assignVoiceToLines(voiceId: number, episodeId: number, lineIds: number[]): { updated: number } {
  const voice = getVoice(voiceId)
  if (!voice) throw new Error('音色不存在')
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) throw new Error('剧集不存在')
  if (episode.dramaId !== voice.dramaId) throw new Error('音色与剧集不属于同一项目')

  const ids = [...new Set(lineIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))]
  if (!ids.length) return { updated: 0 }

  return db.transaction((tx) => {
    let updated = 0
    for (const lineId of ids) {
      const line = tx.select().from(schema.storyboardLines).where(eq(schema.storyboardLines.id, lineId)).get()
      if (!line || line.episodeId !== episodeId || line.deletedAt || line.voiceLocked) continue
      tx.update(schema.storyboardLines).set({
        voiceId: voice.id,
        voiceLocked: true,
        audioStale: Boolean(line.audioUrl),
        error: null,
        updatedAt: now(),
      }).where(eq(schema.storyboardLines.id, lineId)).run()
      updated += 1
    }
    return { updated }
  })
}
```

- [x] **Step 4: 运行测试确认通过**

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/voice-samples.test.ts`

Expected: 8 tests PASS。

---

### Task 2: 路由、能力矩阵与 seed 直通

**Files:**
- Create: `backend/src/services/tts-capabilities.ts`
- Create: `backend/src/routes/tts.ts`
- Modify: `backend/src/routes/voices.ts:16-100,248-258`
- Modify: `backend/src/index.ts:93-94`
- Modify: `backend/src/services/tts.ts:510`
- Test: `backend/tests/voice-samples-routes.test.ts`
- Test: `backend/tests/qwen-tts.test.ts`（追加一条 seed 覆盖用例）

**Interfaces:**
- Consumes: Task 1 的 `generateVoiceSample` / `listVoiceSamples` / `setVoiceSample` / `deleteVoiceSample` / `assignVoiceToLines` / `resolveAuditionText` / `ensureVoiceSeed`。
- Produces:
  - `GET /tts/capabilities` → `{ success: true, data: TtsCapability }`
  - `POST /voices/:id/auditions`
  - `GET /voices/:id/auditions`
  - `DELETE /voices/:id/auditions/:sampleId`
  - `POST /voices/:id/auditions/:sampleId/set-sample`
  - `POST /voices/:id/speech`
  - `POST /voices/:id/apply-lines`
  - 兼容 `POST /voices/:id/sample` → `setSample: true`

- [x] **Step 1: 写失败的路由测试**

创建 `backend/tests/voice-samples-routes.test.ts`：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-voice-samples-routes-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const { db, schema } = await import('../src/db/index.ts')
const { createVoice } = await import('../src/services/voice-profile.ts')
const { default: voicesRoute } = await import('../src/routes/voices.ts')
const { default: ttsRoute } = await import('../src/routes/tts.ts')
const { capabilitiesFor } = await import('../src/services/tts-capabilities.ts')

const app = new Hono()
app.route('/api/v1/voices', voicesRoute)
app.route('/api/v1/tts', ttsRoute)
const ts = '2026-11-05T00:00:00.000Z'

db.insert(schema.dramas).values({ title: '路由测试', style: '3d', status: 'draft', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values({ dramaId: 1, name: '林小雨', role: '女主', createdAt: ts, updatedAt: ts }).run()
const [episode] = db.insert(schema.episodes).values({ dramaId: 1, episodeNumber: 1, title: '第1集', createdAt: ts, updatedAt: ts }).returning().all()
const [storyboard] = db.insert(schema.storyboards).values({ episodeId: episode.id, dramaId: 1, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().all()
const voice = createVoice({
  dramaId: 1, characterId: 1, name: '林小雨 · 声线', source: 'design',
  sampleText: '默认试听文本。', status: 'ready', seed: 33,
})

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('GET auditions 返回默认文本、来源、种子与历史', async () => {
  db.insert(schema.voiceSamples).values({
    voiceId: voice.id, dramaId: 1, kind: 'audition', text: '历史一句。', textSource: 'custom',
    seed: 33, provider: 'qwen3-tts', model: 'qwen3-tts-voicedesign', audioUrl: 'static/tts/a.wav',
    durationMs: 1000, hash: 'a', status: 'ready', createdAt: ts,
  }).run()

  const response = await app.request(`/api/v1/voices/${voice.id}/auditions?episode_id=${episode.id}`)
  assert.equal(response.status, 200)
  const json: any = await response.json()
  assert.equal(json.data.text, '默认试听文本。')
  assert.equal(json.data.text_source, 'default')
  assert.equal(json.data.seed, 33)
  assert.equal(json.data.max_chars, 300)
  assert.equal(json.data.items.length, 1)
})

test('POST set-sample 更新当前样音，DELETE 软删历史', async () => {
  const inserted = db.insert(schema.voiceSamples).values({
    voiceId: voice.id, dramaId: 1, kind: 'audition', text: '设为样例。', textSource: 'custom',
    seed: 33, audioUrl: 'static/tts/b.wav', durationMs: 900, hash: 'b', status: 'ready', createdAt: ts,
  }).returning().get()!

  const setResponse = await app.request(`/api/v1/voices/${voice.id}/auditions/${inserted.id}/set-sample`, { method: 'POST' })
  assert.equal(setResponse.status, 200)
  const setJson: any = await setResponse.json()
  assert.equal(setJson.data.sampleUrl, 'static/tts/b.wav')

  const delResponse = await app.request(`/api/v1/voices/${voice.id}/auditions/${inserted.id}`, { method: 'DELETE' })
  assert.equal(delResponse.status, 200)
  const after = (await (await app.request(`/api/v1/voices/${voice.id}/auditions?episode_id=${episode.id}`)).json()) as any
  assert.equal(after.data.items.some((item: any) => item.id === inserted.id), false)
})

test('POST apply-lines 改派台词且保留音频', async () => {
  const [line] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id, lineNo: 1,
    speakerType: 'dialogue', characterId: 1, speakerName: '林小雨', text: '改派。', speakText: '改派。',
    status: 'ready', audioUrl: 'static/tts/old.wav', audioDurationMs: 800, audioHash: 'old',
    createdAt: ts, updatedAt: ts,
  }).returning().all()

  const response = await app.request(`/api/v1/voices/${voice.id}/apply-lines`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ episode_id: episode.id, line_ids: [line.id] }),
  })
  assert.equal(response.status, 200)
  const json: any = await response.json()
  assert.equal(json.data.updated, 1)
  const updated = db.select().from(schema.storyboardLines).all().find(row => row.id === line.id)!
  assert.equal(updated.voiceId, voice.id)
  assert.equal(updated.audioUrl, 'static/tts/old.wav')
  assert.equal(updated.audioStale, true)
})

test('能力矩阵按通道声明支持项与文本上限', () => {
  const qwen191 = capabilitiesFor({
    provider: 'qwen3-tts', baseUrl: 'http://127.0.0.1:18190', apiKey: '',
    model: 'qwen3-tts-customvoice', settings: {},
  })
  assert.equal(qwen191.speed, false)
  assert.equal(qwen191.seed, true)
  assert.equal(qwen191.refAudio, false)
  assert.equal(qwen191.maxInputChars, 500)
  assert.ok(qwen191.ignored.includes('speed'))

  const cloud = capabilitiesFor({
    provider: 'volcengine', baseUrl: 'https://example.com', apiKey: '',
    model: 'doubao-tts', settings: {},
  })
  assert.equal(cloud.voicePrompt, false)
  assert.equal(cloud.designInstruct, false)
  assert.equal(cloud.refAudio, false)
  assert.equal(cloud.maxSpeechChars, 2000)

  const none = capabilitiesFor(null)
  assert.equal(none.provider, 'none')
  assert.equal(none.maxAuditionChars, 300)
})

test('GET /tts/capabilities 在未配置时返回 none', async () => {
  const response = await app.request('/api/v1/tts/capabilities')
  assert.equal(response.status, 200)
  const json: any = await response.json()
  assert.equal(json.data.provider, 'none')
})
```

- [x] **Step 2: 运行测试确认失败**

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/voice-samples-routes.test.ts`

Expected: FAIL，提示无法找到 `../src/routes/tts.ts` 或 `../src/services/tts-capabilities.ts`。

- [x] **Step 3: 实现能力矩阵**

创建 `backend/src/services/tts-capabilities.ts`：

```ts
/**
 * TTS 通道能力声明（设计 7.3.4）：前端据此隐藏不支持字段，后端生成时按 ignored 裁剪。
 */
import { isQwen191BaseModel, isQwen191Model } from './adapters/qwen-tts.js'
import { getAudioConfig, ttsTextLimit, type AudioConfig } from './tts.js'

export interface TtsCapability {
  provider: string
  model: string | null
  voicePrompt: boolean
  designInstruct: boolean
  emotion: boolean
  speed: boolean
  seed: boolean
  refAudio: boolean
  maxInputChars: number
  maxAuditionChars: number
  maxSpeechChars: number
  ignored: string[]
  note: string | null
}

export function capabilitiesFor(config: AudioConfig | null): TtsCapability {
  if (!config) {
    return {
      provider: 'none', model: null,
      voicePrompt: false, designInstruct: false, emotion: false, speed: false, seed: false, refAudio: false,
      maxInputChars: 0, maxAuditionChars: 300, maxSpeechChars: 2000,
      ignored: [], note: '未配置语音服务',
    }
  }
  const model = config.model || null
  const maxInputChars = ttsTextLimit(config.provider, config.model || '')
  if (config.provider === 'qwen3-tts') {
    const qwen191 = isQwen191Model(config.model || '')
    const base191 = isQwen191BaseModel(config.model || '')
    return {
      provider: config.provider,
      model,
      voicePrompt: !base191,
      designInstruct: !base191,
      emotion: true,
      speed: !qwen191,
      seed: qwen191,
      refAudio: !qwen191,
      maxInputChars,
      maxAuditionChars: 300,
      maxSpeechChars: 2000,
      ignored: qwen191 ? ['speed', 'emotion'] : base191 ? ['designInstruct', 'voicePrompt', 'refAudio'] : [],
      note: qwen191 ? '191 通道忽略 speed 与参考音频，情绪通过 instruct 表达' : null,
    }
  }
  return {
    provider: config.provider,
    model,
    voicePrompt: false,
    designInstruct: false,
    emotion: true,
    speed: true,
    seed: false,
    refAudio: false,
    maxInputChars,
    maxAuditionChars: 300,
    maxSpeechChars: 2000,
    ignored: ['voicePrompt', 'designInstruct', 'seed', 'refAudio'],
    note: '云语音以 external_voice_id 为主',
  }
}

export async function getTtsCapabilities(): Promise<TtsCapability> {
  return capabilitiesFor(await getAudioConfig())
}
```

创建 `backend/src/routes/tts.ts`：

```ts
import { Hono } from 'hono'
import { success } from '../utils/response.js'
import { getTtsCapabilities } from '../services/tts-capabilities.js'

const tts = new Hono()

tts.get('/capabilities', async (c) => success(c, await getTtsCapabilities()))

export default tts
```

修改 `backend/src/index.ts`，在 `/voices` 挂载后新增：

```ts
api.route('/tts', ttsRoute)
```

并在 import 区加入：

```ts
import ttsRoute from './routes/tts.js'
```

- [x] **Step 4: 实现路由**

修改 `backend/src/routes/voices.ts`：

1. 在 import 区加入：

```ts
import {
  assignVoiceToLines,
  deleteVoiceSample,
  generateVoiceSample,
  listVoiceSamples,
  resolveAuditionText,
  setVoiceSample,
  AUDITION_MAX_CHARS,
  SPEECH_MAX_CHARS,
} from '../services/voice-samples.js'
```

2. 用新的兼容实现替换 `synthesizeSample`（保留函数名，旧路由不动）：

```ts
async function synthesizeSample(voiceId: number, options: { text?: string; seed?: number } = {}) {
  const result = await generateVoiceSample({
    voiceId,
    kind: 'audition',
    text: options.text,
    seed: options.seed,
    setSample: true,
  })
  return {
    sample_url: result.sample.audioUrl,
    duration_ms: result.sample.durationMs,
    cached: result.cached,
    sample_id: result.sample.id,
    text: result.text,
    text_source: result.textSource,
    seed: result.seed,
  }
}
```

3. 在 `voices.post('/:id/sample')` 之前加入新路由：

```ts
voices.get('/:id/auditions', (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '音色编号无效')
  const voice = getVoice(id)
  if (!voice) return notFound(c, '音色不存在')
  const episodeId = parseId(c.req.query('episode_id'))
  const resolved = resolveAuditionText(voice, episodeId)
  return success(c, {
    items: listVoiceSamples(id, Number(c.req.query('limit') || 20)),
    text: resolved.text,
    text_source: resolved.source,
    seed: voice.seed ?? null,
    max_chars: AUDITION_MAX_CHARS,
    max_speech_chars: SPEECH_MAX_CHARS,
    channel: {
      provider: voice.provider,
      model: voice.model,
    },
  })
})

voices.post('/:id/auditions', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '音色编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    const result = await generateVoiceSample({
      voiceId: id,
      kind: 'audition',
      text: body.text,
      textSource: body.text_source,
      seed: body.seed === undefined || body.seed === null ? undefined : Number(body.seed),
      episodeId: body.episode_id ? Number(body.episode_id) : undefined,
      setSample: Boolean(body.set_sample),
    })
    return success(c, {
      sample: result.sample,
      text: result.text,
      text_source: result.textSource,
      seed: result.seed,
      truncated: result.truncated,
      cached: result.cached,
    })
  } catch (error: any) {
    if (error?.code === 'no_audio_config') return c.json({ success: false, error: error.message }, 503)
    return badRequest(c, error?.message || '试听生成失败')
  }
})

voices.post('/:id/auditions/:sampleId/set-sample', (c) => {
  const id = parseId(c.req.param('id'))
  const sampleId = parseId(c.req.param('sampleId'))
  if (!id || !sampleId) return badRequest(c, '编号无效')
  try {
    return success(c, setVoiceSample(id, sampleId))
  } catch (error: any) {
    return badRequest(c, error?.message || '设为样例失败')
  }
})

voices.delete('/:id/auditions/:sampleId', (c) => {
  const id = parseId(c.req.param('id'))
  const sampleId = parseId(c.req.param('sampleId'))
  if (!id || !sampleId) return badRequest(c, '编号无效')
  if (!deleteVoiceSample(id, sampleId)) return notFound(c, '试听记录不存在')
  return success(c, { deleted: true })
})

voices.post('/:id/speech', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '音色编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    const result = await generateVoiceSample({
      voiceId: id,
      kind: 'speech',
      text: body.text,
      textSource: 'custom',
      seed: body.seed === undefined || body.seed === null ? undefined : Number(body.seed),
      params: body.params && typeof body.params === 'object' ? body.params : undefined,
    })
    return success(c, {
      sample: result.sample,
      text: result.text,
      seed: result.seed,
      cached: result.cached,
    })
  } catch (error: any) {
    if (error?.code === 'no_audio_config') return c.json({ success: false, error: error.message }, 503)
    return badRequest(c, error?.message || '自由试音失败')
  }
})

voices.post('/:id/apply-lines', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '音色编号无效')
  const body = await c.req.json().catch(() => ({}))
  const episodeId = parseId(String(body.episode_id ?? ''))
  if (!episodeId) return badRequest(c, 'episode_id 必填')
  const lineIds = Array.isArray(body.line_ids) ? body.line_ids.map(Number) : []
  try {
    return success(c, assignVoiceToLines(id, episodeId, lineIds))
  } catch (error: any) {
    return badRequest(c, error?.message || '应用到台词失败')
  }
})
```

- [x] **Step 5: 直通 params.seed**

修改 `backend/src/services/tts.ts:510`：

```ts
const seed = params.seed ?? config.settings.seed
```

- [x] **Step 6: 追加 seed 覆盖测试**

在 `backend/tests/qwen-tts.test.ts` 的「191 模型按 500 字切分...」用例后追加：

```ts
it('params.seed 覆盖配置默认 seed 并进入请求', async () => {
  const cfg: AudioConfig = {
    ...config,
    baseUrl,
    model: 'qwen3-tts-customvoice',
    settings: { concurrency: 1, retryDelaysMs: [0], seed: 7 },
  }
  const before = speechBodies.length
  const result = await synthesize(
    { text: '显式种子测试。', voice: { externalVoiceId: 'Serena' }, seed: 20261105 },
    { config: cfg, cacheDir: tmpDir },
  )
  assert.equal(result.cached, false)
  const requests = speechBodies.slice(before)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.seed, 20261105)
})
```

- [x] **Step 7: 运行路由与 seed 测试**

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/voice-samples-routes.test.ts tests/qwen-tts.test.ts`

Expected: 全部 PASS。

---

### Task 3: 激活/解绑音色保留音频

**Files:**
- Modify: `backend/src/services/voice-profile.ts:153-223,336-390`
- Test: `backend/tests/voice-reuse-line-assignment.test.ts:157-229`
- Test: `backend/tests/voice-profile.test.ts`（追加无音频边界用例）

**Interfaces:**
- Consumes: `sql` from `drizzle-orm`。
- Produces: `activateVoice` / `deactivateVoice` / `setNarratorVoice` 不再清空 `audio_url` / `audio_duration_ms` / `audio_hash` / `status`；非锁定行 `audio_stale = 是否有旧音频`。

- [x] **Step 1: 更新旧测试为设计期望**

修改 `backend/tests/voice-reuse-line-assignment.test.ts`：

把「切换激活音色」用例中：

```ts
  assert.equal(autoAfter.voiceId, null)
  assert.equal(autoAfter.status, 'pending')
  assert.equal(autoAfter.audioUrl, null)
  assert.equal(autoAfter.audioHash, null)
```

改为：

```ts
  assert.equal(autoAfter.voiceId, null)
  assert.equal(autoAfter.status, 'ready')
  assert.equal(autoAfter.audioUrl, 'static/tts/old.wav')
  assert.equal(autoAfter.audioDurationMs, 800)
  assert.equal(autoAfter.audioHash, 'old-hash')
  assert.equal(autoAfter.audioStale, true)
```

把「切换旁白音色」用例中：

```ts
  assert.equal(autoAfter.voiceId, null)
  assert.equal(autoAfter.status, 'pending')
  assert.equal(autoAfter.audioUrl, null)
```

改为：

```ts
  assert.equal(autoAfter.voiceId, null)
  assert.equal(autoAfter.status, 'ready')
  assert.equal(autoAfter.audioUrl, 'static/tts/narrator.wav')
  assert.equal(autoAfter.audioStale, true)
```

追加新用例：

```ts
test('切换音色时无旧音频的台词不产生 audio_stale 标记', () => {
  const [character] = db.insert(schema.characters).values({
    dramaId: 1, name: '阿七', role: '船工', createdAt: ts, updatedAt: ts,
  }).returning().all()
  const oldVoice = makeVoice(character.id, '旧版声线')
  const newVoice = makeVoice(character.id, '新版声线')
  activateVoice(character.id, oldVoice.id)
  const [line] = db.insert(schema.storyboardLines).values({
    episodeId: episode.id, dramaId: 1, storyboardId: storyboard.id, lineNo: 30,
    speakerType: 'dialogue', speakerName: '阿七', characterId: character.id,
    text: '还没录音。', speakText: '还没录音。', voiceId: oldVoice.id,
    status: 'pending', voiceLocked: false, createdAt: ts, updatedAt: ts,
  }).returning().all()

  activateVoice(character.id, newVoice.id)

  const after = db.select().from(schema.storyboardLines).all().find(row => row.id === line.id)!
  assert.equal(after.voiceId, null)
  assert.equal(after.status, 'pending')
  assert.equal(after.audioUrl, null)
  assert.equal(after.audioStale, false)
})
```

- [x] **Step 2: 运行测试确认失败**

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/voice-reuse-line-assignment.test.ts`

Expected: FAIL，autoAfter.status 仍为 `pending`，audioUrl 为 null（旧实现）。

- [x] **Step 3: 修改激活语义**

在 `backend/src/services/voice-profile.ts` 的 import 中加入 `sql`：

```ts
import { and, eq, isNull, or, sql } from 'drizzle-orm'
```

把 `activateVoice`、`deactivateVoice`、`setNarratorVoice(null)`、`setNarratorVoice(new)` 中所有对 `storyboardLines` 的清空更新替换为：

```ts
      tx.update(schema.storyboardLines)
        .set({
          voiceId: null,
          audioStale: sql`case when ${schema.storyboardLines.audioUrl} is not null then 1 else 0 end`,
          error: null,
          updatedAt: now(),
        })
        .where(and(
          eq(schema.storyboardLines.characterId, characterId),
          eq(schema.storyboardLines.dramaId, voice.dramaId),
          or(eq(schema.storyboardLines.voiceLocked, false), isNull(schema.storyboardLines.voiceLocked)),
        ))
        .run()
```

旁白两处条件保持原样：

```ts
        .where(and(
          eq(schema.storyboardLines.dramaId, dramaId),
          isNull(schema.storyboardLines.characterId),
          or(eq(schema.storyboardLines.voiceLocked, false), isNull(schema.storyboardLines.voiceLocked)),
        ))
```

- [x] **Step 4: 运行相关测试**

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/voice-reuse-line-assignment.test.ts tests/voice-profile.test.ts`

Expected: 全部 PASS。

---

### Task 4: 重新设计创建新版本

**Files:**
- Modify: `backend/src/services/voice-design.ts`
- Modify: `backend/src/routes/voices.ts`（`POST /voices/:id/design`）
- Test: `backend/tests/voice-redesign.test.ts`

**Interfaces:**
- Consumes: `generateVoiceProfiles` / `collectSampleLines` / `createVoice` / `getVoice` / `listVoiceRows`。
- Produces:
  - `redesignVoice(voiceId: number, options?): Promise<VoiceRow>`
  - `POST /voices/:id/design` → 201 + 新版本行

- [x] **Step 1: 写失败测试**

创建 `backend/tests/voice-redesign.test.ts`：

```ts
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-voice-redesign-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.VOICE_DESIGN_AGENT = 'off'

const { eq } = await import('drizzle-orm')
const { db, schema } = await import('../src/db/index.ts')
const { createVoice, listVoiceRows } = await import('../src/services/voice-profile.ts')
const { redesignVoice } = await import('../src/services/voice-design.ts')
const { default: voicesRoute } = await import('../src/routes/voices.ts')

const app = new Hono()
app.route('/api/v1/voices', voicesRoute)
const ts = '2026-11-05T00:00:00.000Z'

db.insert(schema.dramas).values({ title: '重设计测试', style: '3d', status: 'draft', background: '民国', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.characters).values({ dramaId: 1, name: '沈砚', role: '书生', description: '清瘦，声音清冷', createdAt: ts, updatedAt: ts }).run()
const old = createVoice({
  dramaId: 1, characterId: 1, name: '沈砚 · 声线', source: 'design',
  voicePrompt: '旧版提示词', designInstruct: 'old calm voice', status: 'ready', isActive: true,
})
db.update(schema.characterVoices).set({ isActive: true }).where(eq(schema.characterVoices.id, old.id)).run()

after(async () => { await fs.rm(root, { recursive: true, force: true }) })

test('重新设计创建新版本，旧版本保留且仍激活', async () => {
  const created = await redesignVoice(old.id, {})
  assert.notEqual(created.id, old.id)
  assert.equal(created.characterId, 1)
  assert.equal(created.source, 'design')
  assert.equal(created.status, 'draft')
  assert.ok(created.voicePrompt)
  assert.ok(created.designInstruct)

  const versions = listVoiceRows(1).filter(row => row.characterId === 1)
  assert.equal(versions.length, 2)
  const oldAfter = versions.find(row => row.id === old.id)!
  assert.equal(oldAfter.isActive, true)
  assert.equal(oldAfter.voicePrompt, '旧版提示词')
  assert.equal(versions.find(row => row.id === created.id)!.isActive, false)
})

test('POST /voices/:id/design 返回新版本', async () => {
  const response = await app.request(`/api/v1/voices/${old.id}/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 201)
  const json: any = await response.json()
  assert.ok(json.data.id > old.id)
  assert.equal(json.data.characterId, 1)
})
```

> 注：如果 `voice-design.ts` 的 LLM 调用在测试环境不可用，模板兜底会返回 `source='template'`，但新建版本仍必须发生；测试只断言字段存在，不断言 `voicePromptSource`。

- [x] **Step 2: 运行测试确认失败**

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/voice-redesign.test.ts`

Expected: FAIL，`redesignVoice` 未定义。

- [x] **Step 3: 实现 `redesignVoice`**

在 `backend/src/services/voice-design.ts` 末尾加入（并确认 `createVoice` 已在 import 中）：

```ts
/** 重新设计：始终创建新版本，旧版本与激活状态不动（设计 6.5） */
export async function redesignVoice(
  voiceId: number,
  options: {
    episodeId?: number
    model?: string
    configId?: number
    language?: string
    defaultSpeed?: number
  } = {},
) {
  const source = getVoice(voiceId)
  if (!source) throw new Error('音色不存在')
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, source.dramaId)).get()
  const character = source.characterId
    ? db.select().from(schema.characters).where(eq(schema.characters.id, source.characterId)).get()
    : null
  const sampleLine = character && options.episodeId
    ? collectSampleLines(options.episodeId).get(character.name)
    : null

  const [profile] = await generateVoiceProfiles({
    characters: [{
      name: character?.name || '旁白',
      role: character?.role || '画外音',
      description: character?.description || `为《${drama?.title || ''}》担任旁白，风格统一、克制、少情绪`,
      appearance: character?.appearance,
      personality: character?.personality,
      sampleLine: source.sampleText || sampleLine,
    }],
    dramaId: source.dramaId,
    episodeId: options.episodeId,
    useAgent: false,
    background: drama?.background,
    genre: drama?.genre,
    language: options.language || source.language || undefined,
    defaultSpeed: options.defaultSpeed ?? (source.speed ?? 1),
    model: options.model,
    configId: options.configId,
  })
  if (!profile) throw new Error('重新设计失败：没有生成音色档案')

  return createVoice({
    dramaId: source.dramaId,
    characterId: source.characterId,
    scope: source.scope as 'character' | 'narrator',
    name: source.name,
    source: 'design',
    voicePrompt: profile.voice_prompt,
    voicePromptSource: profile.source,
    designInstruct: profile.design_instruct,
    sampleText: profile.sample_text,
    gender: profile.gender,
    ageRange: profile.age_range,
    speed: profile.speed,
    emotion: profile.emotion,
    language: options.language || source.language || 'Chinese',
    status: 'draft',
  })
}
```

- [x] **Step 4: 增加设计路由**

在 `backend/src/routes/voices.ts` 的 import 中加入 `redesignVoice`，并在 `voices.post('/:id/sample')` 前加入：

```ts
voices.post('/:id/design', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return badRequest(c, '音色编号无效')
  const body = await c.req.json().catch(() => ({}))
  try {
    const voice = await redesignVoice(id, {
      episodeId: body.episode_id ? Number(body.episode_id) : undefined,
      model: body.model,
      configId: body.config_id ? Number(body.config_id) : undefined,
      language: body.language,
    })
    return created(c, voice)
  } catch (error: any) {
    return badRequest(c, error?.message || '重新设计失败')
  }
})
```

- [x] **Step 5: 运行测试**

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/voice-redesign.test.ts`

Expected: 全部 PASS。

---

### Task 5: 前端 API 与音色状态

**Files:**
- Modify: `frontend/app/composables/useApi.ts:100-175`
- Modify: `frontend/app/composables/useVoiceProfiles.ts`

**Interfaces:**
- Produces:
  - `VoiceSample` 类型
  - `VoiceAuditionMeta` 类型
  - `voiceProfileAPI.auditions(voiceId, episodeId?)`
  - `voiceProfileAPI.generateAudition(voiceId, body)`
  - `voiceProfileAPI.setSample(voiceId, sampleId)`
  - `voiceProfileAPI.removeSample(voiceId, sampleId)`
  - `voiceProfileAPI.speech(voiceId, body)`
  - `voiceProfileAPI.applyLines(voiceId, body)`
  - `voiceProfileAPI.design(voiceId, body)`
  - `voiceProfileAPI.capabilities()`
  - `useVoiceProfiles` 返回 `samples` / `auditionMeta` / `loadAuditions` / `generateAudition` / `setAsSample` / `deleteAudition` / `generateSpeech` / `applyToLines` / `redesign`

- [x] **Step 1: 扩展类型与 API**

在 `frontend/app/composables/useApi.ts` 的 `VoiceProfile` 接口内补充：

```ts
  seed?: number | null
  createdAt?: string
  updatedAt?: string
```

在 `VoiceProfile` 接口后新增：

```ts
export interface VoiceSample {
  id: number
  voiceId: number
  dramaId: number
  kind: 'audition' | 'speech' | 'clone_test'
  text: string
  textSource: 'default' | 'custom' | 'line'
  seed: number | null
  provider: string | null
  model: string | null
  paramsJson: string | null
  audioUrl: string | null
  durationMs: number | null
  hash: string | null
  status: 'generating' | 'ready' | 'failed'
  error?: string | null
  createdAt: string
}

export interface VoiceAuditionMeta {
  items: VoiceSample[]
  text: string
  text_source: 'default' | 'custom' | 'line'
  seed: number | null
  max_chars: number
  max_speech_chars: number
  channel: { provider: string | null; model: string | null }
}

export interface TtsCapabilities {
  provider: string
  model: string | null
  voicePrompt: boolean
  designInstruct: boolean
  emotion: boolean
  speed: boolean
  seed: boolean
  refAudio: boolean
  maxInputChars: number
  maxAuditionChars: number
  maxSpeechChars: number
  ignored: string[]
  note: string | null
}
```

在 `voiceProfileAPI` 中追加：

```ts
  auditions: (voiceId: number, episodeId?: number | null) =>
    api.get<VoiceAuditionMeta>(`/voices/${voiceId}/auditions${episodeId ? `?episode_id=${episodeId}` : ''}`),
  generateAudition: (voiceId: number, body: { text?: string; seed?: number | null; text_source?: string; episode_id?: number | null; set_sample?: boolean }) =>
    api.post<{ sample: VoiceSample; text: string; text_source: string; seed: number; truncated: boolean; cached: boolean }>(`/voices/${voiceId}/auditions`, body),
  setSample: (voiceId: number, sampleId: number) =>
    api.post<VoiceProfile>(`/voices/${voiceId}/auditions/${sampleId}/set-sample`, {}),
  removeSample: (voiceId: number, sampleId: number) =>
    api.del<{ deleted: boolean }>(`/voices/${voiceId}/auditions/${sampleId}`),
  speech: (voiceId: number, body: { text: string; seed?: number | null; params?: Record<string, any> }) =>
    api.post<{ sample: VoiceSample; text: string; seed: number; cached: boolean }>(`/voices/${voiceId}/speech`, body),
  applyLines: (voiceId: number, body: { episode_id: number; line_ids: number[] }) =>
    api.post<{ updated: number }>(`/voices/${voiceId}/apply-lines`, body),
  design: (voiceId: number, body: { episode_id?: number | null; model?: string; config_id?: number } = {}) =>
    api.post<VoiceProfile>(`/voices/${voiceId}/design`, body),
  capabilities: () => api.get<TtsCapabilities>('/tts/capabilities'),
```

- [x] **Step 2: 扩展 composable**

在 `frontend/app/composables/useVoiceProfiles.ts`：

1. import 增加类型：

```ts
import {
  voiceProfileAPI,
  type TtsCapabilities,
  type VoiceAuditionMeta,
  type VoiceProfile,
  type VoiceProfileList,
  type VoiceSample,
} from '~/composables/useApi'
```

2. 模块级状态新增：

```ts
const samplesByVoice = ref<Record<number, VoiceSample[]>>({})
const auditionMetaByVoice = ref<Record<number, VoiceAuditionMeta>>({})
const capabilities = ref<TtsCapabilities | null>(null)
```

3. 在 `useVoiceProfiles` 函数内、`load` 之前新增：

```ts
  async function loadCapabilities(): Promise<TtsCapabilities | null> {
    if (capabilities.value) return capabilities.value
    try {
      capabilities.value = await voiceProfileAPI.capabilities()
      return capabilities.value
    } catch {
      return null
    }
  }

  async function loadAuditions(voice: VoiceProfile, episodeId?: number | null): Promise<VoiceAuditionMeta | null> {
    try {
      const meta = await voiceProfileAPI.auditions(voice.id, episodeId)
      samplesByVoice.value = { ...samplesByVoice.value, [voice.id]: meta.items || [] }
      auditionMetaByVoice.value = { ...auditionMetaByVoice.value, [voice.id]: meta }
      return meta
    } catch (error) {
      toastError(error)
      return null
    }
  }

  async function generateAudition(
    voice: VoiceProfile,
    input: { text?: string; seed?: number | null; textSource?: string; episodeId?: number | null; setSample?: boolean },
  ): Promise<VoiceSample | null> {
    const key = busyKeyFor(voice)
    if (isBusy(key)) return null
    markBusy(key)
    try {
      const result = await voiceProfileAPI.generateAudition(voice.id, {
        text: input.text,
        seed: input.seed ?? undefined,
        text_source: input.textSource,
        episode_id: input.episodeId ?? undefined,
        set_sample: Boolean(input.setSample),
      })
      samplesByVoice.value = {
        ...samplesByVoice.value,
        [voice.id]: [result.sample, ...(samplesByVoice.value[voice.id] || [])].slice(0, 20),
      }
      patchVoice(voice.id, {
        seed: result.seed,
        status: 'ready',
        ...(input.setSample ? { sampleUrl: result.sample.audioUrl, sampleText: result.sample.text } : {}),
      })
      notify()
      return result.sample
    } catch (error) {
      toastError(error)
      return null
    } finally {
      clearBusy(key)
    }
  }

  async function setAsSample(voice: VoiceProfile, sampleId: number): Promise<void> {
    const key = busyKeyFor(voice)
    if (isBusy(key)) return
    markBusy(key)
    try {
      const updated = await voiceProfileAPI.setSample(voice.id, sampleId)
      const sample = (samplesByVoice.value[voice.id] || []).find(item => item.id === sampleId)
      patchVoice(voice.id, {
        sampleUrl: updated.sampleUrl,
        sampleText: updated.sampleText,
        ...(sample ? { seed: sample.seed } : {}),
      })
      notify()
      toast.success(t('voiceProfile.sampleSet'))
    } catch (error) {
      toastError(error)
    } finally {
      clearBusy(key)
    }
  }

  async function deleteAudition(voice: VoiceProfile, sampleId: number): Promise<void> {
    const key = busyKeyFor(voice)
    if (isBusy(key)) return
    markBusy(key)
    try {
      await voiceProfileAPI.removeSample(voice.id, sampleId)
      samplesByVoice.value = {
        ...samplesByVoice.value,
        [voice.id]: (samplesByVoice.value[voice.id] || []).filter(item => item.id !== sampleId),
      }
      toast.success(t('voiceProfile.sampleDeleted'))
    } catch (error) {
      toastError(error)
    } finally {
      clearBusy(key)
    }
  }

  async function generateSpeech(
    voice: VoiceProfile,
    input: { text: string; seed?: number | null; params?: Record<string, any> },
  ): Promise<VoiceSample | null> {
    const key = busyKeyFor(voice)
    if (isBusy(key)) return null
    markBusy(key)
    try {
      const result = await voiceProfileAPI.speech(voice.id, input)
      samplesByVoice.value = {
        ...samplesByVoice.value,
        [voice.id]: [result.sample, ...(samplesByVoice.value[voice.id] || [])].slice(0, 20),
      }
      patchVoice(voice.id, { seed: result.seed, status: 'ready' })
      notify()
      return result.sample
    } catch (error) {
      toastError(error)
      return null
    } finally {
      clearBusy(key)
    }
  }

  async function applyToLines(voice: VoiceProfile, episodeId: number, lineIds: number[]): Promise<boolean> {
    if (!lineIds.length) return false
    const key = busyKeyFor(voice)
    if (isBusy(key)) return false
    markBusy(key)
    try {
      const result = await voiceProfileAPI.applyLines(voice.id, { episode_id: episodeId, line_ids: lineIds })
      notify()
      toast.success(t('voiceProfile.appliedToLines', { n: result.updated }))
      return true
    } catch (error) {
      toastError(error)
      return false
    } finally {
      clearBusy(key)
    }
  }

  async function redesign(voice: VoiceProfile, episodeId?: number | null): Promise<VoiceProfile | null> {
    const key = busyKeyFor(voice)
    if (isBusy(key)) return null
    markBusy(key)
    try {
      const created = await voiceProfileAPI.design(voice.id, { episode_id: episodeId ?? undefined })
      await load(true)
      notify()
      toast.success(t('voiceProfile.redesignDone'))
      return created
    } catch (error) {
      toastError(error)
      return null
    } finally {
      clearBusy(key)
    }
  }
```

4. 在 return 中追加：

```ts
    samplesByVoice,
    auditionMetaByVoice,
    capabilities,
    loadCapabilities,
    loadAuditions,
    generateAudition,
    setAsSample,
    deleteAudition,
    generateSpeech,
    applyToLines,
    redesign,
```

- [x] **Step 3: 门禁检查**

Run:
`cd frontend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run build`

Expected: 构建通过（此时组件尚未引用新方法，允许只通过类型检查）。

---

### Task 6: 试听面板 UI 与四语言文案

**Files:**
- Create: `frontend/app/components/VoiceAuditionPanel.vue`
- Modify: `frontend/app/components/VoiceProfileCard.vue`
- Modify: `frontend/app/locales/zh.json`
- Modify: `frontend/app/locales/en.json`
- Modify: `frontend/app/locales/ja.json`
- Modify: `frontend/app/locales/ko.json`

**Interfaces:**
- Consumes: Task 5 的 `useVoiceProfiles` actions；`dubbingAPI.lines(episodeId)`。
- Produces: 现有 `VoiceProfileCard` 内的「试听 / 历史 / 自由试音 / 应用到台词」面板。

- [x] **Step 1: 创建面板组件**

创建 `frontend/app/components/VoiceAuditionPanel.vue`：

```vue
<template>
  <section class="vap">
    <header class="vap-head">
      <strong>{{ t('voiceProfile.auditionTitle') }}</strong>
      <span v-if="meta?.channel?.provider" class="vap-channel">
        {{ meta.channel.provider }}<template v-if="meta.channel.model"> / {{ meta.channel.model }}</template>
      </span>
      <span class="vap-seed">{{ t('voiceProfile.seed') }}: {{ seed }}</span>
    </header>

    <textarea
      v-model="auditionText"
      class="vap-text"
      rows="3"
      :maxlength="meta?.max_chars || 300"
      :placeholder="t('voiceProfile.auditionPlaceholder')"
      @input="source = 'custom'"
    />
    <div class="vap-meta">
      <span :class="['vap-source', `is-${source}`]">{{ sourceLabel }}</span>
      <span>{{ [...auditionText].length }}/{{ meta?.max_chars || 300 }}</span>
      <button type="button" class="btn btn-sm" @click="randomSeed">{{ t('voiceProfile.randomSeed') }}</button>
      <button type="button" class="btn btn-sm" @click="restoreDefault">{{ t('voiceProfile.restoreDefault') }}</button>
    </div>

    <div class="vap-actions">
      <button type="button" class="btn btn-sm is-primary" :disabled="busy || !auditionText.trim()" @click="generate">
        <Loader2 v-if="busy" :size="11" class="animate-spin" />
        <Play v-else :size="11" />
        {{ t('voiceProfile.auditionGenerate') }}
      </button>
      <button
        type="button"
        class="btn btn-sm"
        :disabled="busy || !latestSample"
        @click="latestSample && store.setAsSample(voice, latestSample.id)"
      >
        <Check :size="11" />
        {{ t('voiceProfile.setAsSample') }}
      </button>
    </div>

    <audio v-if="playUrl" ref="player" class="vap-audio" controls preload="none" :src="mediaUrl(playUrl)" />

    <div class="vap-history">
      <div class="vap-history-title">{{ t('voiceProfile.history') }}</div>
      <p v-if="!samples.length" class="vap-empty">{{ t('voiceProfile.noHistory') }}</p>
      <div v-for="sample in samples" :key="sample.id" class="vap-history-row">
        <button type="button" class="vap-history-text" @click="play(sample)">
          <Play :size="10" />
          <span>{{ sample.text }}</span>
        </button>
        <span class="vap-history-meta">
          {{ sample.durationMs ? `${(sample.durationMs / 1000).toFixed(1)}s` : '-' }} · {{ shortTime(sample.createdAt) }}
        </span>
        <button type="button" class="btn btn-xs" :disabled="busy" @click="store.setAsSample(voice, sample.id)">
          {{ t('voiceProfile.setSample') }}
        </button>
        <button type="button" class="btn btn-xs is-danger" :disabled="busy" @click="store.deleteAudition(voice, sample.id)">
          {{ t('voiceProfile.deleteSample') }}
        </button>
      </div>
    </div>

    <details class="vap-speech">
      <summary>{{ t('voiceProfile.speechTitle') }}</summary>
      <p class="vap-hint">{{ t('voiceProfile.speechHint', { n: meta?.max_speech_chars || 2000 }) }}</p>
      <textarea v-model="speechText" class="vap-text" rows="4" :maxlength="meta?.max_speech_chars || 2000" />
      <div class="vap-actions">
        <button type="button" class="btn btn-sm is-primary" :disabled="busy || !speechText.trim()" @click="speak">
          <Loader2 v-if="busy" :size="11" class="animate-spin" />
          <Mic v-else :size="11" />
          {{ t('voiceProfile.speechGenerate') }}
        </button>
      </div>

      <div v-if="speechSample?.audioUrl" class="vap-speech-result">
        <audio class="vap-audio" controls preload="none" :src="mediaUrl(speechSample.audioUrl)" />
        <button
          v-if="episodeId"
          type="button"
          class="btn btn-sm"
          :disabled="busy"
          @click="linesOpen = !linesOpen"
        >
          {{ t('voiceProfile.applyToLines') }}
        </button>
      </div>

      <div v-if="linesOpen" class="vap-lines">
        <label v-for="line in lines" :key="line.id" class="vap-line">
          <input v-model="selectedLineIds" type="checkbox" :value="line.id">
          <span>{{ line.speakerName || t('workbench.narrator') }}：{{ line.text }}</span>
        </label>
        <div class="vap-actions">
          <button
            type="button"
            class="btn btn-sm is-primary"
            :disabled="busy || !selectedLineIds.length"
            @click="applyLines"
          >
            {{ t('voiceProfile.applySelected', { n: selectedLineIds.length }) }}
          </button>
        </div>
      </div>
    </details>
  </section>
</template>

<script setup lang="ts">
import { Check, Loader2, Mic, Play } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { dubbingAPI, type StoryboardLine, type VoiceProfile, type VoiceSample } from '~/composables/useApi'
import { useVoiceProfiles } from '~/composables/useVoiceProfiles'

const props = defineProps<{
  voice: VoiceProfile
  episodeId?: number | null
}>()

const { t } = useI18n()
const store = useVoiceProfiles({
  dramaId: () => props.voice.dramaId,
  episodeId: () => props.episodeId ?? null,
})

const meta = computed(() => store.auditionMetaByVoice.value[props.voice.id] || null)
const samples = computed(() => store.samplesByVoice.value[props.voice.id] || [])
const auditionText = ref('')
const speechText = ref('')
const seed = ref<number | null>(props.voice.seed ?? null)
const source = ref<'default' | 'custom' | 'line'>('default')
const defaultText = ref('')
const playUrl = ref('')
const speechSample = ref<VoiceSample | null>(null)
const lines = ref<StoryboardLine[]>([])
const selectedLineIds = ref<number[]>([])
const linesOpen = ref(false)
const busy = computed(() => store.isBusy(props.voice.scope === 'narrator' ? 'narrator' : `c${props.voice.characterId ?? ''}`))
const latestSample = computed(() => samples.value.find(sample => sample.status === 'ready' && sample.audioUrl) || null)
const sourceLabel = computed(() => ({
  default: t('voiceProfile.textSourceDefault'),
  custom: t('voiceProfile.textSourceCustom'),
  line: t('voiceProfile.textSourceLine'),
}[source.value]))

function mediaUrl(url: string) {
  return url.startsWith('/') || /^https?:\/\//i.test(url) ? url : `/${url}`
}

function shortTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function play(sample: VoiceSample) {
  if (!sample.audioUrl) return
  playUrl.value = sample.audioUrl
  nextTick(() => { void (document.querySelector('.vap-audio') as HTMLAudioElement | null)?.play().catch(() => {}) })
}

async function reload() {
  const result = await store.loadAuditions(props.voice, props.episodeId)
  if (!result) return
  if (!auditionText.value) {
    auditionText.value = result.text
    defaultText.value = result.text
    source.value = result.text_source
  }
  seed.value = result.seed ?? props.voice.seed ?? null
}

async function generate() {
  const text = auditionText.value.trim()
  if (!text) return
  const sample = await store.generateAudition(props.voice, {
    text,
    seed: seed.value,
    textSource: source.value === 'line' || source.value === 'default' ? undefined : 'custom',
    episodeId: props.episodeId,
  })
  if (!sample?.audioUrl) return
  playUrl.value = sample.audioUrl
  seed.value = sample.seed
  source.value = 'custom'
}

function randomSeed() {
  seed.value = Math.floor(Math.random() * 2_000_000_000)
}

function restoreDefault() {
  auditionText.value = defaultText.value
  source.value = meta.value?.text_source || 'default'
}

async function speak() {
  const sample = await store.generateSpeech(props.voice, { text: speechText.value.trim(), seed: seed.value })
  if (!sample) return
  speechSample.value = sample
}

async function loadLines() {
  if (!props.episodeId || lines.value.length) return
  try {
    const result = await dubbingAPI.lines(props.episodeId)
    lines.value = (result.items || []).filter(line => !line.voiceLocked)
  } catch {
    lines.value = []
  }
}

async function applyLines() {
  if (!props.episodeId) return
  const ok = await store.applyToLines(props.voice, props.episodeId, selectedLineIds.value)
  if (ok) {
    selectedLineIds.value = []
    linesOpen.value = false
  }
}

watch(linesOpen, open => { if (open) void loadLines() })
onMounted(async () => {
  await store.loadCapabilities()
  await reload()
  auditionText.value = auditionText.value || props.voice.sampleText || ''
})
watch(() => props.voice.id, () => {
  auditionText.value = ''
  speechText.value = ''
  speechSample.value = null
  playUrl.value = ''
  void reload()
})
</script>

<style scoped>
.vap { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--border); padding-top: 8px; }
.vap-head, .vap-meta, .vap-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vap-head { justify-content: space-between; font-size: 11.5px; }
.vap-channel, .vap-seed, .vap-history-meta { font-size: 10.5px; color: var(--text-3); }
.vap-text { width: 100%; resize: vertical; font-size: 12px; line-height: 1.6; padding: 7px 9px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-2); color: var(--text-0); }
.vap-source { border-radius: 999px; padding: 1px 7px; font-size: 10px; background: var(--overlay-track, rgba(127,127,127,.12)); color: var(--text-2); }
.vap-source.is-line { color: var(--success, #2e9e5b); background: var(--success-bg, rgba(46,158,91,.12)); }
.vap-source.is-custom { color: #c48a1b; background: rgba(196,138,27,.12); }
.vap-audio { width: 100%; height: 32px; }
.vap-history { display: flex; flex-direction: column; gap: 4px; }
.vap-history-title { font-size: 11px; font-weight: 600; color: var(--text-2); }
.vap-empty, .vap-hint { margin: 0; font-size: 10.5px; color: var(--text-3); }
.vap-history-row { display: flex; align-items: center; gap: 6px; font-size: 10.5px; }
.vap-history-text { display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1; border: none; background: transparent; color: var(--text-1); cursor: pointer; text-align: left; font-size: 10.5px; }
.vap-history-text span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vap-speech summary { cursor: pointer; font-size: 11px; color: var(--text-2); }
.vap-speech { display: flex; flex-direction: column; gap: 6px; border-top: 1px dashed var(--border); padding-top: 8px; }
.vap-speech-result { display: flex; flex-direction: column; gap: 6px; }
.vap-lines { max-height: 180px; overflow: auto; display: flex; flex-direction: column; gap: 3px; }
.vap-line { display: flex; gap: 6px; align-items: flex-start; font-size: 10.5px; color: var(--text-1); }
</style>
```

- [x] **Step 2: 接入现有音色卡片**

修改 `frontend/app/components/VoiceProfileCard.vue`：

1. 图标 import 增加 `AudioLines`：

```ts
import { AudioLines, Check, Copy, Link2, Loader2, Mic, Pencil, Play, Sparkles, Trash2, Upload } from 'lucide-vue-next'
```

2. 在 `vpc-summary-actions` 中「试听」按钮后加入：

```vue
          <button class="btn btn-sm" type="button" :disabled="busy" @click="auditionOpen = !auditionOpen">
            <AudioLines :size="11" />
            {{ t('voiceProfile.auditionPanel') }}
          </button>
```

3. 在现有 `<audio ... data-voice-profile />` 后加入：

```vue
      <VoiceAuditionPanel
        v-if="auditionOpen && selectedVoice"
        :voice="selectedVoice"
        :episode-id="episodeId ?? null"
      />
```

4. 脚本中加入状态：

```ts
const auditionOpen = ref(false)
```

5. `rewriteNow` 改为创建新版本：

```ts
async function rewriteNow() {
  const voice = selectedVoice.value
  if (!voice) return
  await store.redesign(voice, props.episodeId ?? null)
}
```

6. 切换版本时收起面板：

```ts
watch(selectedId, () => { auditionOpen.value = false })
```

- [x] **Step 3: 补四语言文案**

在 `frontend/app/locales/zh.json` 的 `voiceProfile` 对象中加入：

```json
      "auditionPanel": "试听面板",
      "auditionTitle": "试听文本",
      "auditionPlaceholder": "输入要试听的文本",
      "auditionGenerate": "试听",
      "textSourceDefault": "默认文本",
      "textSourceCustom": "自定义",
      "textSourceLine": "角色首句",
      "seed": "种子",
      "randomSeed": "随机种子",
      "restoreDefault": "恢复默认",
      "setAsSample": "设为试听样例",
      "setSample": "设为样例",
      "deleteSample": "删除",
      "sampleSet": "已设为试听样例",
      "sampleDeleted": "已删除试听记录",
      "history": "试听历史",
      "noHistory": "还没有试听记录",
      "speechTitle": "自由试音",
      "speechHint": "自由输入，最多 {n} 字，不绑定项目台词",
      "speechGenerate": "生成语音",
      "applyToLines": "应用到台词",
      "applySelected": "应用所选（{n}）",
      "appliedToLines": "已改派 {n} 句台词，旧音频已保留",
      "redesignDone": "已创建新版本，旧版本保留"
```

`en.json`：

```json
      "auditionPanel": "Audition",
      "auditionTitle": "Audition text",
      "auditionPlaceholder": "Enter the text to audition",
      "auditionGenerate": "Audition",
      "textSourceDefault": "Default",
      "textSourceCustom": "Custom",
      "textSourceLine": "Character's first line",
      "seed": "Seed",
      "randomSeed": "Random seed",
      "restoreDefault": "Restore default",
      "setAsSample": "Set as sample",
      "setSample": "Set sample",
      "deleteSample": "Delete",
      "sampleSet": "Set as audition sample",
      "sampleDeleted": "Audition deleted",
      "history": "Audition history",
      "noHistory": "No auditions yet",
      "speechTitle": "Free speech",
      "speechHint": "Free text, up to {n} characters, not tied to project lines",
      "speechGenerate": "Generate speech",
      "applyToLines": "Apply to lines",
      "applySelected": "Apply selected ({n})",
      "appliedToLines": "Reassigned {n} lines; old audio kept",
      "redesignDone": "New version created; old versions kept"
```

`ja.json`：

```json
      "auditionPanel": "試聴パネル",
      "auditionTitle": "試聴テキスト",
      "auditionPlaceholder": "試聴するテキストを入力",
      "auditionGenerate": "試聴",
      "textSourceDefault": "デフォルト",
      "textSourceCustom": "カスタム",
      "textSourceLine": "キャラクターの最初のセリフ",
      "seed": "シード",
      "randomSeed": "ランダムシード",
      "restoreDefault": "デフォルトに戻す",
      "setAsSample": "試聴サンプルに設定",
      "setSample": "サンプルに設定",
      "deleteSample": "削除",
      "sampleSet": "試聴サンプルに設定しました",
      "sampleDeleted": "試聴履歴を削除しました",
      "history": "試聴履歴",
      "noHistory": "試聴履歴はまだありません",
      "speechTitle": "フリースピーチ",
      "speechHint": "自由入力、最大 {n} 文字、プロジェクトのセリフとは無関係",
      "speechGenerate": "音声を生成",
      "applyToLines": "セリフに適用",
      "applySelected": "選択を適用（{n}）",
      "appliedToLines": "{n} 件のセリフを変更しました。旧音声は保持されています",
      "redesignDone": "新しいバージョンを作成しました。旧バージョンは保持されています"
```

`ko.json`：

```json
      "auditionPanel": "미리듣기 패널",
      "auditionTitle": "미리듣기 텍스트",
      "auditionPlaceholder": "미리들을 텍스트를 입력하세요",
      "auditionGenerate": "미리듣기",
      "textSourceDefault": "기본",
      "textSourceCustom": "사용자 지정",
      "textSourceLine": "캐릭터 첫 대사",
      "seed": "시드",
      "randomSeed": "랜덤 시드",
      "restoreDefault": "기본값 복원",
      "setAsSample": "미리듣기 샘플로 설정",
      "setSample": "샘플로 설정",
      "deleteSample": "삭제",
      "sampleSet": "미리듣기 샘플로 설정했습니다",
      "sampleDeleted": "미리듣기 기록을 삭제했습니다",
      "history": "미리듣기 기록",
      "noHistory": "미리듣기 기록이 없습니다",
      "speechTitle": "자유 발화",
      "speechHint": "자유 입력, 최대 {n}자, 프로젝트 대사와 무관",
      "speechGenerate": "음성 생성",
      "applyToLines": "대사에 적용",
      "applySelected": "선택 적용({n})",
      "appliedToLines": "대사 {n}개를 변경했습니다. 기존 오디오는 유지됩니다",
      "redesignDone": "새 버전을 만들었습니다. 기존 버전은 유지됩니다"
```

- [x] **Step 4: 前端构建门禁**

Run:
`cd frontend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run build`

Expected: 构建通过，无缺失 i18n key 或组件类型错误。

- [x] **Step 5: 阶段 2 职责检查**

在 `frontend/app/components/DubbingStage.vue` 确认阶段 2 仍只有「音色档案 / 逐句改派」两个视图，没有批量合成项目台词按钮；阶段 3 才保留生成按钮。若出现重复合成入口，删除阶段 2 的入口而不是新增页面。

---

### Task 7: 全量验证与执行日志

**Files:**
- Modify: `docs/V3-执行日志.md`
- Modify: `docs/superpowers/plans/2026-11-05-dubbing-workbench-stage02.md`（勾选完成项）

- [x] **Step 1: 运行后端定向测试**

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npx tsx --test tests/voice-samples.test.ts tests/voice-samples-routes.test.ts tests/voice-redesign.test.ts tests/voice-reuse-line-assignment.test.ts tests/voice-profile.test.ts tests/qwen-tts.test.ts`

Expected: 全部 PASS。

- [x] **Step 2: 运行后端全量测试与构建**

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm test`

Expected: 全部 PASS（上一阶段基线 600，应只增不减）。

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run build`

Expected: `tsc` 通过。

- [x] **Step 3: 运行结构、漂移与前端构建**

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run test:structure`

Expected: 61/61 PASS。

Run:
`cd backend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run drift`

Expected: 123 PASS。

Run:
`cd frontend && PATH=/Users/ysmac/.nvm/versions/node/v22.16.0/bin:$PATH npm run build`

Expected: 构建通过。

- [x] **Step 4: 更新执行日志**

在 `docs/V3-执行日志.md` 末尾追加：

```markdown
### 配音工作台阶段 2 落地（2026-11-05）

- 新增 `voice_samples` 试听历史：默认文本优先级、来源/字数/种子/通道展示、最近 20 条保留、设为样例与删除。
- 新增自由试音（≤2000 字）与改派到台词；改派保留旧音频并标 `audio_stale`。
- 重新设计走 `/voices/:id/design` 创建新版本，旧版本与激活状态保留。
- 激活/解绑/旁白切换不再清空音频；无旧音频的台词不标 `audio_stale`。
- TTS 仅增加 `params.seed` 直通；能力矩阵通过 `/tts/capabilities` 暴露。
- 前端复用 `VoiceProfileCard` 展开试听面板，四语言文案补齐。
- 验证：后端定向/全量测试、tsc、结构 61、漂移 123、前端构建。
- 边界：未提交、未打包、未安装；TTS 服务与协议未改；V3-G5 仍待验收。
```

- [x] **Step 5: 勾选计划**

将本文件所有 `- [ ]` 改为 `- [x]`（仅在对应步骤验证通过后）。

---

## 验收对照（设计 6.9）

- 试听面板显示实际文本、来源、字数、音色版本、通道、种子 → Task 1/2/6。
- 修改试听文本后生成，历史新增一条；可回放、设为样例、删除 → Task 1/2/5/6。
- 「重新设计」生成新版本，旧版本仍在，可 A/B → Task 4，版本下拉 + 试听历史支撑 A/B。
- 自由试音生成一段语音，可改派到台词 → Task 1/2/5/6（插入混音留待阶段 4）。
- 阶段 2 不出现批量合成项目台词按钮 → Task 6 Step 5。
