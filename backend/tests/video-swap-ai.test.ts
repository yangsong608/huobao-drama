import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-ai-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = path.join(root, 'data')
process.env.STORAGE_PATH = path.join(root, 'data', 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'

const sharp = (await import('sharp')).default
const { db, schema } = await import('../src/db/index.ts')
const projects = await import('../src/services/video-projects.ts')
const storage = await import('../src/services/video-project-storage.ts')
const ai = await import('../src/services/video-swap-ai.ts')
const sceneRef = await import('../src/services/video-scene-reference.ts')

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function imageBuffer(color: { r: number; g: number; b: number }) {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: color } }).png().toBuffer()
}

const config = {
  id: 1,
  provider: 'comfyui',
  baseUrl: 'http://video-gateway.local:8194',
  apiKey: 'video-key',
  model: '',
  settings: {
    analysis_config_id: 9,
    scene_ref_base_url: 'http://image-gateway.local:8192',
    scene_ref_api_key: 'image-key',
    scene_ref_workflow_prefix: 'qwen-image-edit',
    scene_ref_candidates: 1,
  },
}

async function seedRun(projectId: number, faceCount: number, mode: 'face' | 'character') {
  const project = projects.getVideoProjectRowForPreflight(projectId)!
  const facePaths: string[] = []
  for (let i = 0; i < faceCount; i += 1) {
    const updated = await projects.saveVideoProjectFace(projectId, {
      name: `face-${i}.png`,
      type: 'image/png',
      buffer: await imageBuffer({ r: 180 + i * 10, g: 120 + i * 10, b: 100 + i * 10 }),
    })
    const paths = updated!.reference_face_paths as string[]
    facePaths.push(paths[paths.length - 1])
    project.referenceFacePaths = JSON.stringify(paths)
  }
  const keyframeBuffer = await sharp({
    create: { width: 640, height: 360, channels: 3, background: { r: 40, g: 80, b: 120 } },
  }).jpeg({ quality: 85 }).toBuffer()
  const keyframeRelative = storage.videoProjectStorageRelative(projectId, 'analysis', 'run-test/shot-0-frame-0.jpg')
  const keyframeAbsolute = storage.resolveVideoProjectStorageFile(projectId, 'analysis/run-test/shot-0-frame-0.jpg')
  await fs.mkdir(path.dirname(keyframeAbsolute), { recursive: true })
  await fs.writeFile(keyframeAbsolute, keyframeBuffer)

  const stamp = new Date().toISOString()
  const run = db.insert(schema.videoSwapRuns).values({
    projectId,
    mode,
    status: 'analyzed',
    stage: 'plan_ready',
    progress: 100,
    maxGenerationSeconds: mode === 'character' ? 6 : 8,
    chunkOverlapMs: 1000,
    minChunkSeconds: 5,
    maxChunks: 50,
    analysisJson: JSON.stringify({
      source: { durationMs: 6000, width: 640, height: 360, fps: 24, hasAudio: true },
      shots: [{ shot_index: 0, start_ms: 0, end_ms: 6000, duration_ms: 6000, chunk_count: 1, keyframes: [keyframeRelative] }],
    }),
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  const runId = Number(run.lastInsertRowid)
  const shot = db.insert(schema.videoSwapShots).values({
    runId,
    shotIndex: 0,
    startMs: 0,
    endMs: 6000,
    durationMs: 6000,
    chunkCount: 1,
    createdAt: stamp,
    updatedAt: stamp,
  }).run()
  return { project, runId, shotId: Number(shot.lastInsertRowid), keyframeRelative, facePaths }
}

function waitRun(runId: number, status: string, timeout = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const run = db.select().from(schema.videoSwapRuns).where(eq(schema.videoSwapRuns.id, runId)).get()
      if (run?.status === status) return resolve()
      if (run?.status === 'failed') return reject(new Error(run.errorMessage || 'run failed'))
      if (Date.now() - started > timeout) return reject(new Error(`timeout waiting for ${status}`))
      setTimeout(tick, 50)
    }
    tick()
  })
}

test('character AI analysis writes structured prompts and scene candidates can be confirmed', async () => {
  const project = await projects.createVideoProject({ title: 'P7 多人', mode: 'character' })
  const seeded = await seedRun(project.id, 2, 'character')
  let visionImages = 0
  const fakeVision = async (options: any) => {
    visionImages = options.images.length
    return {
      data: {
        people: [
          { slot: 1, name: '林小雨', description: 'woman in a floral jacket', caption: 'the woman in the floral jacket becomes a young woman in a white coat' },
          { slot: 2, name: '马老三', description: 'man at the wok', caption: 'the man at the wok becomes a younger cook in a dark apron' },
        ],
        shots: [{
          shot_index: 0,
          scene_reference_prompt: 'Use image1 as the scene. Replace the woman and the cook with reference_face_1 and reference_face_2, keep pose and background.',
          final_prompt: '',
          negative_prompt: 'subtitles, watermark',
          caption: 'two people in the market',
        }],
        global_prompt: 'cinematic 3d animation',
        negative_prompt: 'subtitles, watermark',
        generation: { seed: 42, steps: 8 },
        warnings: [],
      },
      provider: 'fake',
      model: 'fake-vision',
    }
  }
  const started = await ai.startVideoAiAnalysis(project.id, {
    config,
    vision: fakeVision,
    sceneRefGenerator: async () => ['placeholder'],
  })
  await waitRun(started.run_id, 'scene_ref_ready')
  assert.ok(visionImages >= 3)
  const run = db.select().from(schema.videoSwapRuns).where(eq(schema.videoSwapRuns.id, started.run_id)).get()!
  const plan = JSON.parse(run.finalPromptJson || '{}')
  assert.equal(plan.people.length, 2)
  assert.equal(plan.shots.length, 1)
  assert.match(plan.people[0].caption, /becomes/)
  assert.equal(run.status, 'scene_ref_ready')
  const shot = db.select().from(schema.videoSwapShots).where(eq(schema.videoSwapShots.id, seeded.shotId)).get()!
  assert.ok(shot.finalPromptJson)

  const candidates = await sceneRef.generateSceneReferenceCandidates(
    seeded.project,
    run,
    shot,
    plan,
    {
      config,
      candidateCount: 1,
      pollIntervalMs: 200,
      timeoutMs: 10_000,
      submitJob: (async () => 'job-1') as any,
      fetchJob: (async () => ({ status: 'succeeded', file_url: 'http://fake/image.png' })) as any,
      fetchImpl: (async () => new Response(await imageBuffer({ r: 20, g: 30, b: 40 }), {
        status: 200, headers: { 'content-type': 'image/png' },
      })) as typeof fetch,
    },
  )
  assert.equal(candidates.length, 1)
  assert.ok(storage.resolveVideoProjectStorageFile(project.id, candidates[0].slice(`static/video-projects/${project.id}/`.length)))
  const confirmed = sceneRef.confirmSceneReference(project.id, seeded.shotId, candidates[0])
  assert.equal(confirmed.scene_reference_path, candidates[0])
  assert.equal(confirmed.run_status, 'prompt_ready')

  const edited = ai.updateAiPromptPlan(project.id, started.run_id, { global_prompt: 'new cinematic style' })
  assert.equal(edited.global_prompt, 'new cinematic style')
})

test('face AI analysis writes a final prompt and skips scene references', async () => {
  const project = await projects.createVideoProject({ title: 'P7 单脸', mode: 'face' })
  const seeded = await seedRun(project.id, 1, 'face')
  const started = await ai.startVideoAiAnalysis(project.id, {
    config,
    vision: async () => ({
      data: {
        people: [{ slot: 1, name: '目标', description: 'woman', caption: 'the woman keeps her identity' }],
        shots: [{ shot_index: 0, scene_reference_prompt: '', final_prompt: 'Faceswap, keep the original pose and background, natural skin, cinematic quality.', negative_prompt: 'subtitles', caption: 'single face' }],
        global_prompt: '',
        negative_prompt: 'subtitles',
        generation: { seed: 7, steps: 8 },
      },
      provider: 'fake',
      model: 'fake-vision',
    }),
  })
  await waitRun(started.run_id, 'prompt_ready')
  const run = db.select().from(schema.videoSwapRuns).where(eq(schema.videoSwapRuns.id, started.run_id)).get()!
  const plan = JSON.parse(run.finalPromptJson || '{}')
  assert.match(plan.shots[0].final_prompt, /Faceswap/)
  assert.equal(run.status, 'prompt_ready')
  assert.equal(db.select().from(schema.videoSwapShots).where(eq(schema.videoSwapShots.id, seeded.shotId)).get()!.sceneReferencePath, null)
})

test('AI analysis can retry after a failed run', async () => {
  const project = await projects.createVideoProject({ title: 'P7 重试', mode: 'face' })
  await seedRun(project.id, 1, 'face')
  const failed = await ai.startVideoAiAnalysis(project.id, {
    config,
    vision: async () => { throw new Error('vision unavailable') },
  })
  await new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const run = db.select().from(schema.videoSwapRuns).where(eq(schema.videoSwapRuns.id, failed.run_id)).get()
      if (run?.status === 'failed') return resolve()
      if (Date.now() - started > 10_000) return reject(new Error('timeout waiting for failed run'))
      setTimeout(tick, 50)
    }
    tick()
  })
  const retried = await ai.startVideoAiAnalysis(project.id, {
    config,
    vision: async () => ({
      data: {
        people: [{ slot: 1, name: '目标', description: 'woman', caption: 'the woman keeps her identity' }],
        shots: [{ shot_index: 0, scene_reference_prompt: '', final_prompt: 'Faceswap, cinematic quality.', negative_prompt: 'subtitles', caption: 'single face' }],
        global_prompt: '',
        negative_prompt: 'subtitles',
        generation: { seed: 7, steps: 8 },
      },
      provider: 'fake',
      model: 'fake-vision',
    }),
  })
  assert.equal(retried.run_id, failed.run_id)
  await waitRun(retried.run_id, 'prompt_ready')
})
