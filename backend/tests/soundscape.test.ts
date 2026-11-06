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
const monoFixturePath = path.join(root, 'static', 'fixture-mono-44100.wav')
execFileSync(ffmpegBin, [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1',
  '-ar', '44100', '-ac', '1', monoFixturePath,
])
const monoWavBuffer = fs.readFileSync(monoFixturePath)

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
  assert.equal(assets[0].engine, 'stable-audio-open')
  assert.equal(assets[0].model, 'stable-audio-open-1.0')
  assert.equal(assets[0].sampleRate, 48000)
  assert.equal(assets[0].channels, 2)
  const metadata = JSON.parse(assets[0].metadataJson || '{}')
  assert.equal(metadata.category, 'ambience')
  assert.equal(metadata.mode, 'scenes')
  assert.equal(metadata.sceneId, 10)
  assert.equal(metadata.storyboardId, null)
  assert.equal(metadata.itemId, 'ambience:scene:10')
  assert.equal(metadata.prompt, 'rain')
  assert.equal(metadata.negativePrompt, '')
  assert.equal(metadata.seconds, 5)
  assert.equal(metadata.seed, 7)
  assert.match(metadata.workflowHash, /^[0-9a-f]{64}$/)
  assert.equal(metadata.normalized, false)
  assert.equal(metadata.degraded, false)

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

test('激活 Take 文件缺失时群众类别不算成功，保留旧片段', async () => {
  const { episode, drama } = newEpisode('缺失配音文件')
  const line = db.insert(schema.storyboardLines).values({
    episodeId: episode.id,
    dramaId: drama.id,
    lineNo: 5,
    text: '快跑',
    speakerName: '路人乙',
    speakerType: 'dialogue',
    createdAt: ts,
    updatedAt: ts,
  }).returning().get()
  const takeUrl = `static/projects/${drama.id}/audio/missing.wav`
  const take = db.insert(schema.lineTakes).values({
    lineId: line.id,
    episodeId: episode.id,
    dramaId: drama.id,
    takeNo: 1,
    text: '快跑',
    audioUrl: takeUrl,
    durationMs: 1200,
    status: 'ready',
    isActive: true,
    createdAt: ts,
  }).returning().get()
  db.update(schema.storyboardLines).set({ activeTakeId: take.id })
    .where(eq(schema.storyboardLines.id, line.id)).run()
  assert.equal(fs.existsSync(getAbsolutePath(takeUrl)), false)

  const plan = makePlan([makeItem({
    itemId: 'crowd:scene:10',
    category: 'crowd',
    source: 'lines',
    sourceHash: '',
    seconds: 0,
    prompt: '',
    lineIds: [line.id],
  })], 'scenes', {
    [line.id]: { startMs: 1000, speaker: '路人乙', lineNo: 5 },
  })

  const spy = spyApply()
  await startSoundscape(episode.id, drama.id, makeRequest({ categories: ['crowd'], crowdMode: 'lines' }), {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => plan,
    applyPlan: spy.applyPlan,
  })

  const done = await waitStatus(episode.id, 'completed')
  assert.equal(done.counts.clips, 0)
  assert.equal(done.counts.done, 1)
  assert.equal(spy.calls.length, 0)
})

test('素材记录真实采样率与声道数', async () => {
  const { episode, drama } = newEpisode('素材元信息')
  await startSoundscape(episode.id, drama.id, makeRequest(), {
    resolveConfig: async () => makeConfig(),
    compilePlan: async () => makePlan([makeItem({ itemId: 'ambience:scene:10', sourceHash: 'hash-mono' })]),
    generate: async () => ({ buffer: monoWavBuffer, extension: 'wav', filename: 'mono.wav', promptId: 'p1' }),
    applyPlan: spyApply().applyPlan,
  })

  await waitStatus(episode.id, 'completed')
  const asset = db.select().from(schema.episodeAudioAssets)
    .where(eq(schema.episodeAudioAssets.episodeId, episode.id)).get()!
  assert.equal(asset.sampleRate, 44100)
  assert.equal(asset.channels, 1)
  assert.ok(asset.durationMs >= 900 && asset.durationMs <= 1100)
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

  // 设计 §16：未配置 audio-gen 时启动返回 503，但预览仍可看计划
  const fallback = await previewSoundscape(episode.id, drama.id, makeRequest(), {
    resolveConfig: async () => null,
    compilePlan: async () => makePlan([makeItem({ itemId: 'ambience:scene:10' })]),
  })
  assert.equal(fallback.plan.items.length, 1)
  assert.equal(fallback.model, '')
  assert.equal(fallback.workflowHash, '')
  assert.equal(fallback.normalizeLoudness, false)

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

test('网关音频配置无需本地工作流，slug 参与缓存哈希', async () => {
  const { episode, drama } = newEpisode('网关音频')
  const config: AIConfig = {
    id: 901,
    serviceType: 'audio-gen',
    provider: 'comfyui',
    baseUrl: 'http://127.0.0.1:8192',
    apiKey: 'gw-token',
    model: 'stable-audio-open-1.0',
    settings: {
      workflow_slug: 'stable-audio',
      normalize_loudness: false,
      seed: 7,
    },
  }
  let compiled: { workflowHash: string } | null = null
  const preview = await previewSoundscape(episode.id, drama.id, makeRequest(), {
    resolveConfig: async () => config,
    compilePlan: async (options) => {
      compiled = options
      return makePlan([makeItem({ itemId: 'ambience:scene:10' })])
    },
  })
  assert.equal(preview.workflowHash, 'gateway:stable-audio')
  assert.equal(compiled?.workflowHash, 'gateway:stable-audio')
  assert.equal(preview.model, 'stable-audio-open-1.0')
  assert.equal(preview.normalizeLoudness, false)
})
